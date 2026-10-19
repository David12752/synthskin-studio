"""
Central runtime / resource manager for SynthSkin Studio.

One place that answers: *what hardware do we have, and how do we use ALL of it?*

- Picks the best inference device: CUDA → MPS (Apple) → DirectML (Windows GPU) → CPU.
- Tunes every thread pool (torch, OpenCV, ONNX Runtime, OpenMP/MKL) to the real
  physical core count, so CPU work fans out across the whole machine.
- Chooses model tiers (e.g. which SAM2 checkpoint) from available VRAM/RAM, so a
  beefy laptop loads the large model and a thin one stays responsive.

Designed to import cleanly even when torch / psutil / onnxruntime are absent —
every heavy dependency is probed lazily and degrades to a safe default.

Public API:
    get_runtime()            -> Runtime         (cached snapshot)
    configure_threads()      -> None            (idempotent; fan out CPU pools)
    torch_device()           -> str             ("cuda" | "mps" | "dml" | "cpu")
    onnx_session_options()   -> ort.SessionOptions | None
    onnx_providers()         -> list[str]
    recommended_sam2_tier()  -> str             ("large" | "base_plus" | "small" | "tiny")
    runtime_report()         -> dict            (JSON-safe, for the UI / endpoint)
"""
from __future__ import annotations

import logging
import os
from dataclasses import asdict, dataclass, field
from typing import List, Optional

logger = logging.getLogger(__name__)

# Env vars that must be set BEFORE numpy/torch/mkl spin up their pools. Importing
# this module early (it is imported by server.py at top) lets these take effect.
_THREAD_ENV_VARS = ("OMP_NUM_THREADS", "MKL_NUM_THREADS",
                    "NUMEXPR_NUM_THREADS", "OPENBLAS_NUM_THREADS")


# ─────────────────────────────────────────────────────────────────────────────
# Hardware probing
# ─────────────────────────────────────────────────────────────────────────────

def _physical_cores() -> int:
    """Best-effort physical core count (falls back to logical, then 1)."""
    try:
        import psutil
        n = psutil.cpu_count(logical=False)
        if n:
            return int(n)
    except Exception:
        pass
    return int(os.cpu_count() or 1)


def _logical_cores() -> int:
    return int(os.cpu_count() or 1)


def _total_ram_gb() -> float:
    try:
        import psutil
        return round(psutil.virtual_memory().total / (1024 ** 3), 1)
    except Exception:
        pass
    # POSIX fallback
    try:
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / (1024 ** 3), 1)
    except Exception:
        return 0.0


def _available_ram_gb() -> float:
    try:
        import psutil
        return round(psutil.virtual_memory().available / (1024 ** 3), 1)
    except Exception:
        return 0.0


def _probe_torch_device() -> tuple[str, str, float]:
    """Return (device, backend_name, vram_gb). Never raises."""
    try:
        import torch
    except Exception:
        return "cpu", "none", 0.0

    # NVIDIA / CUDA
    try:
        if torch.cuda.is_available():
            vram = 0.0
            try:
                props = torch.cuda.get_device_properties(0)
                vram = round(props.total_memory / (1024 ** 3), 1)
            except Exception:
                pass
            return "cuda", "cuda", vram
    except Exception:
        pass

    # Apple Silicon / Metal
    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps", "mps", 0.0  # MPS shares system RAM; report 0 (unknown)
    except Exception:
        pass

    # Windows GPUs (AMD/Intel/NVIDIA) via torch-directml
    try:
        import torch_directml  # type: ignore
        if torch_directml.is_available() and torch_directml.device_count() > 0:
            return "dml", "directml", 0.0
    except Exception:
        pass

    return "cpu", "cpu", 0.0


def _directml_installable() -> bool:
    """A discrete/integrated GPU may be present but torch-directml not installed."""
    if os.name != "nt":
        return False
    try:
        import torch_directml  # noqa: F401
        return False  # already installed
    except Exception:
        return True


# ─────────────────────────────────────────────────────────────────────────────
# Runtime snapshot
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Runtime:
    device: str                 # "cuda" | "mps" | "dml" | "cpu"
    backend: str                # human-readable backend name
    vram_gb: float
    physical_cores: int
    logical_cores: int
    total_ram_gb: float
    available_ram_gb: float
    threads: int                # threads we fan CPU pools out to
    sam2_tier: str
    notes: List[str] = field(default_factory=list)

    @property
    def is_gpu(self) -> bool:
        return self.device in ("cuda", "mps", "dml")


_RUNTIME: Optional[Runtime] = None
_THREADS_CONFIGURED = False


def _pick_sam2_tier(device: str, vram_gb: float, ram_gb: float) -> str:
    """Choose the heaviest SAM2 checkpoint the machine can comfortably run."""
    if device == "cuda":
        if vram_gb >= 7:
            return "large"
        if vram_gb >= 4:
            return "base_plus"
        return "small"
    if device in ("mps", "dml"):
        # Unified / shared memory — gate on system RAM instead of VRAM.
        return "base_plus" if ram_gb >= 16 else "small"
    # CPU: large is minutes per image; keep it responsive but use RAM headroom.
    if ram_gb >= 32:
        return "base_plus"
    if ram_gb >= 12:
        return "small"
    return "tiny"


def get_runtime(refresh: bool = False) -> Runtime:
    """Return a cached snapshot of the machine's capabilities."""
    global _RUNTIME
    if _RUNTIME is not None and not refresh:
        return _RUNTIME

    device, backend, vram = _probe_torch_device()
    phys = _physical_cores()
    logi = _logical_cores()
    total_ram = _total_ram_gb()
    avail_ram = _available_ram_gb()

    # Fan CPU pools across all physical cores. On a GPU box the heavy lifting is
    # on-device, but pre/post-processing (OpenCV, OCR, encoding) is still CPU-bound,
    # so we still want every core.
    threads = max(1, phys)

    notes: List[str] = []
    if device == "cpu":
        notes.append("No GPU detected — running on CPU. Heavy models (SAM2 large) will be slow.")
        if _directml_installable():
            notes.append("A Windows GPU may be available: `pip install torch-directml` to enable DirectML acceleration.")
    tier = _pick_sam2_tier(device, vram, total_ram)

    _RUNTIME = Runtime(
        device=device, backend=backend, vram_gb=vram,
        physical_cores=phys, logical_cores=logi,
        total_ram_gb=total_ram, available_ram_gb=avail_ram,
        threads=threads, sam2_tier=tier, notes=notes,
    )
    logger.info("[runtime] device=%s backend=%s vram=%.1fGB cores=%d/%d ram=%.1fGB "
                "threads=%d sam2=%s", device, backend, vram, phys, logi,
                total_ram, threads, tier)
    return _RUNTIME


# ─────────────────────────────────────────────────────────────────────────────
# Applying the configuration
# ─────────────────────────────────────────────────────────────────────────────

def configure_threads(force: bool = False) -> None:
    """Fan every CPU thread pool out to the physical core count. Idempotent.

    Call once at process startup (server.py) and from standalone scripts.
    """
    global _THREADS_CONFIGURED
    if _THREADS_CONFIGURED and not force:
        return
    rt = get_runtime()
    n = str(rt.threads)

    # Env vars for OpenMP / MKL / BLAS. Setting them is only fully effective when
    # done before those libs initialise, hence importing runtime early.
    for var in _THREAD_ENV_VARS:
        os.environ.setdefault(var, n)

    try:
        import torch
        torch.set_num_threads(rt.threads)
        try:
            # interop pool: keep modest to avoid oversubscription
            torch.set_num_interop_threads(max(1, min(4, rt.threads)))
        except Exception:
            pass  # can only be set once per process
    except Exception:
        pass

    try:
        import cv2
        cv2.setNumThreads(rt.threads)
    except Exception:
        pass

    _THREADS_CONFIGURED = True
    logger.info("[runtime] CPU pools configured to %d threads", rt.threads)


def torch_device() -> str:
    """Device string for torch tensors/models. 'dml' needs the directml device obj."""
    return get_runtime().device


def torch_device_obj():
    """Return an actual torch.device (handles DirectML's custom device)."""
    rt = get_runtime()
    try:
        import torch
        if rt.device == "dml":
            import torch_directml  # type: ignore
            return torch_directml.device()
        return torch.device(rt.device)
    except Exception:
        import torch
        return torch.device("cpu")


def onnx_providers() -> List[str]:
    """Preferred ONNX Runtime execution providers, best-first."""
    try:
        import onnxruntime as ort
        avail = set(ort.get_available_providers())
    except Exception:
        return ["CPUExecutionProvider"]
    order = ["CUDAExecutionProvider", "DmlExecutionProvider",
             "CoreMLExecutionProvider", "CPUExecutionProvider"]
    picked = [p for p in order if p in avail]
    return picked or ["CPUExecutionProvider"]


def onnx_session_options():
    """A SessionOptions tuned to use all cores. None if ORT is unavailable."""
    try:
        import onnxruntime as ort
    except Exception:
        return None
    rt = get_runtime()
    so = ort.SessionOptions()
    so.intra_op_num_threads = rt.threads
    so.inter_op_num_threads = max(1, min(4, rt.threads))
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return so


def recommended_sam2_tier() -> str:
    return get_runtime().sam2_tier


def runtime_report() -> dict:
    """JSON-safe snapshot for the UI / a /runtime endpoint."""
    rt = asdict(get_runtime())
    rt["is_gpu"] = get_runtime().is_gpu
    rt["onnx_providers"] = onnx_providers()
    rt["threads_configured"] = _THREADS_CONFIGURED
    return rt


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    configure_threads()
    import json
    print(json.dumps(runtime_report(), indent=2))
