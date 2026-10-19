"""
Panel Semantic Pipeline — Multi-stage SOTA pipeline for understanding audio gear
UI panels at the semantic level.

Stages:
    1. Focused Component Detection    → Gemini Vision + YOLO + targeted OpenCV
                                                                             for knobs, sliders/faders, and LEDs
  2. Per-pixel Segmentation         → SAM 2 (box prompts)
                                       fallback: GrabCut / distance-transform masks
  3. OCR Label Extraction           → RapidOCR (ONNX PaddleOCR, Apache-2.0 models)
                                       fallback: OpenCV MSER + hashed pseudo labels
  4. Feature-Specific Extraction    → knob angles (polar transform),
                                       slider travel (Hough lines within mask),
                                       screen type classification.
  5. Semantic Linking               → spatial-proximity label→control graph,
                                       section grouping, JUCE parameter-id slugification.

Output JSON schema: see PanelLayout TypedDict at bottom.

Entry point:
    analyze_panel(image_b64, **opts) -> dict
    check_panel_pipeline_available() -> dict
"""
from __future__ import annotations

import base64
import importlib.util
import logging
import math
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np

import runtime
import rectify

logger = logging.getLogger(__name__)

ProgressCB = Callable[[str, int, str], None]


# ═══════════════════════════════════════════════════════════════════════════════
# HIGH-RESOLUTION PIPELINE TIMER
# ═══════════════════════════════════════════════════════════════════════════════

class PipelineTimer:
    """Collects high-resolution timestamps for each pipeline stage."""

    def __init__(self) -> None:
        self._t0 = time.perf_counter()
        self._marks: List[tuple] = []

    def mark(self, label: str) -> None:
        elapsed_ms = (time.perf_counter() - self._t0) * 1000
        self._marks.append((label, elapsed_ms))
        logger.info(f"[TIMER] {label}: {elapsed_ms:.1f} ms (wall)")

    def summary(self) -> Dict[str, float]:
        out: Dict[str, float] = {}
        for i, (label, abs_ms) in enumerate(self._marks):
            prev_ms = self._marks[i - 1][1] if i > 0 else 0.0
            out[label] = round(abs_ms - prev_ms, 1)
        out["total_ms"] = round(self._marks[-1][1], 1) if self._marks else 0.0
        return out

    def log_summary(self) -> Dict[str, float]:
        s = self.summary()
        parts = [f"{k}={v:.0f}ms" for k, v in s.items()]
        logger.info(f"[TIMER] Pipeline summary: {' | '.join(parts)}")
        return s


# ═══════════════════════════════════════════════════════════════════════════════
# IMAGE I/O
# ═══════════════════════════════════════════════════════════════════════════════

def _decode_image(image_b64: str) -> np.ndarray:
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    raw = base64.b64decode(image_b64)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    # Colour management: if the file carries a non-sRGB ICC profile, transform
    # to sRGB so the server-side cut matches the browser preview. No-op (keeps
    # this cv2 decode) for the common profile-less PNG mockup.
    try:
        import color
        img, _converted = color.maybe_srgb_normalize(raw, img)
    except Exception:
        pass
    return img


def _mask_to_png_b64(mask_u8: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", mask_u8)
    if not ok:
        return ""
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


# ── Edge-aware alpha refinement ──────────────────────────────────────────────
# Binary SAM2 / GrabCut masks give hard, aliased 1-px edges. A guided filter
# (He et al. 2010) guided by the source image turns them into soft, image-aware
# alpha — ~80% of a matting model's visual win for near-zero cost, and no
# opencv-contrib dependency (implemented with base box filters). We restrict the
# change to a ±band boundary strip so the solid interior stays fully opaque and
# the far exterior stays fully transparent — geometry (bbox/contour/circle) is
# always computed from the crisp binary mask, never from this softened alpha.

def _guided_filter_gray(guide: np.ndarray, src: np.ndarray, radius: int, eps: float) -> np.ndarray:
    """Single-channel guided filter. guide/src are float32 in [0,1], same shape."""
    ksize = (2 * radius + 1, 2 * radius + 1)
    mean_I = cv2.boxFilter(guide, cv2.CV_32F, ksize)
    mean_p = cv2.boxFilter(src, cv2.CV_32F, ksize)
    mean_Ip = cv2.boxFilter(guide * src, cv2.CV_32F, ksize)
    cov_Ip = mean_Ip - mean_I * mean_p
    mean_II = cv2.boxFilter(guide * guide, cv2.CV_32F, ksize)
    var_I = mean_II - mean_I * mean_I
    a = cov_Ip / (var_I + eps)
    b = mean_p - a * mean_I
    mean_a = cv2.boxFilter(a, cv2.CV_32F, ksize)
    mean_b = cv2.boxFilter(b, cv2.CV_32F, ksize)
    return mean_a * guide + mean_b


def refine_mask_edges(
    mask_u8: np.ndarray,
    guide_bgr: np.ndarray,
    radius: int = 4,
    eps: float = 1e-4,
    band_px: int = 4,
) -> np.ndarray:
    """Soften a binary mask into image-aware alpha within a ±band_px boundary band.

    ``mask_u8`` and ``guide_bgr`` must be the SAME crop region (same H×W).
    Deep interior stays 255, far exterior stays 0; only the boundary band is
    graded. Returns a uint8 alpha of the same shape.
    """
    if mask_u8 is None or mask_u8.size == 0 or guide_bgr is None:
        return mask_u8
    if mask_u8.shape[:2] != guide_bgr.shape[:2]:
        return mask_u8
    h, w = mask_u8.shape[:2]
    if min(h, w) < 8:  # too small to benefit; avoid box-filter edge artifacts
        return mask_u8
    guide = cv2.cvtColor(guide_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    p = mask_u8.astype(np.float32) / 255.0
    q = np.clip(_guided_filter_gray(guide, p, radius, eps), 0.0, 1.0)
    refined = (q * 255.0).astype(np.uint8)

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band_px + 1, 2 * band_px + 1))
    core = cv2.erode(mask_u8, k)   # deep interior
    halo = cv2.dilate(mask_u8, k)  # interior + band
    out = refined
    out[core > 127] = 255          # keep solid body fully opaque
    out[halo <= 127] = 0           # keep far background fully transparent
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 1: COMPONENT DETECTION (Gemini + YOLO + OpenCV)
# ═══════════════════════════════════════════════════════════════════════════════

# Canonical type set used by the frontend:
CANONICAL_TYPES = {"knob", "slider", "switch", "button", "led", "screen", "label"}

# The production analyzer is focused on the element classes needed for synth
# and external-gear panels. Gemini performs best when it can emit the full
# control vocabulary directly instead of forcing buttons/meters into fallback
# paths that were tuned mainly for knobs and sliders.
TARGET_CONTROL_TYPES = {"knob", "slider", "switch", "button", "led", "screen"}
DETECTION_TYPE_REMAP = {
    "fader": "slider",
    "linear_fader": "slider",
    "drawbar": "slider",
    "indicator": "led",
    "indicator_light": "led",
    "light": "led",
    "lamp": "led",
    "push_button": "button",
    "pushbutton": "button",
    "momentary_button": "button",
    "pad": "button",
    "toggle": "switch",
    "toggle_switch": "switch",
    "rocker": "switch",
    "display": "screen",
    "meter": "screen",
    "vu_meter": "screen",
    "gauge": "screen",
    "readout": "screen",
    "digital_display": "screen",
    "oscilloscope": "screen",
}


def _normalise_target_type(kind: Any) -> Optional[str]:
    kind_str = str(kind or "").lower().strip()
    kind_str = DETECTION_TYPE_REMAP.get(kind_str, kind_str)
    return kind_str if kind_str in TARGET_CONTROL_TYPES else None

# Knob size bins (by bbox diagonal / image diagonal):
KNOB_SIZE_BINS = [
    (0.00, 0.035, "tiny"),
    (0.035, 0.065, "small"),
    (0.065, 0.11, "medium"),
    (0.11,  1.00, "large"),
]

# Maximum dimension for segmentation inference.
# Images wider/taller than this are downscaled before SAM2/GrabCut, then masks
# are upsampled back to original resolution. This is the single biggest speed
# lever for high-res inputs (e.g. 2530×1664 → 1024×673 = 6× fewer pixels).
SEGMENT_MAX_DIM = 1024


def _detect_runtime_device() -> str:
    """Return the best available inference device (delegates to the runtime manager)."""
    try:
        return runtime.torch_device()
    except Exception:
        return "cpu"

# ─── YOLO ────────────────────────────────────────────────────────────────────
_yolo_model = None
_yolo_checked = False

_CUSTOM_YOLO_WEIGHT_NAMES = {"synthskin_yolo.pt", "ui_components_yolo.pt"}


def _yolo_weight_candidates() -> List[Tuple[str, str]]:
    """Return candidate YOLO weights as (path, kind).

    kind="custom" means a detector trained specifically for synth/audio UI
    controls. kind="generic" means an off-the-shelf COCO model, useful only as
    a weak objectness fallback. This distinction is critical: SAM2 can refine a
    good box, but it cannot fix a detector that never learned knobs/sliders/LEDs.
    """
    here = os.path.dirname(__file__)
    raw_candidates = [
        (os.path.join(here, "models", "synthskin_yolo.pt"), "custom"),
        (os.path.join(here, "models", "ui_components_yolo.pt"), "custom"),
        (os.path.join(here, "..", "models", "synthskin_yolo.pt"), "custom"),
        (os.path.join(here, "..", "models", "ui_components_yolo.pt"), "custom"),
        (os.path.join(here, "yolo11n.pt"), "generic"),
        (os.path.join(here, "yolov8n.pt"), "generic"),
        (os.path.join(here, "..", "yolov8n.pt"), "generic"),
        (os.path.join(here, "..", "yolo11n.pt"), "generic"),
        (os.path.join(here, "..", "..", "yolov8n.pt"), "generic"),
        (os.path.join(here, "..", "..", "yolo11n.pt"), "generic"),
    ]
    return [(os.path.abspath(path), kind) for path, kind in raw_candidates]


def _yolo_weight_info() -> Dict[str, Optional[str]]:
    """Return the selected YOLO weight path and whether it is custom-trained."""
    for path, kind in _yolo_weight_candidates():
        if os.path.isfile(path):
            return {"path": path, "kind": kind, "name": os.path.basename(path)}
    return {"path": None, "kind": None, "name": None}


def _find_yolo_weights() -> Optional[str]:
    """Return the best local YOLO weights path, if one exists.

    Dev workspaces may keep yolov8n.pt at the repository root while the
    sidecar runs from synthskin-studio/python.  The old code only checked
    synthskin-studio/yolov8n.pt, which made the UI report YOLO as unavailable
    even when the weight file was present one directory higher.
    """
    return _yolo_weight_info()["path"]

# ─── RapidOCR ────────────────────────────────────────────────────────────────
_ocr_engine = None
_ocr_checked = False

# ─── SAM2 (imported lazily from processor.py which already wires it up) ──────
_sam_checked = False
_sam_ok = False

# ─── Gemini API (cloud detection) ────────────────────────────────────────────
_GEMINI_API_KEY: str = ""
# Model candidates in priority order.  We probe the API at first call and
# cache whichever model answers first.
# NOTE: thinkingConfig is NOT sent in the probe — it is only supported by 2.5
# models and causes errors on 2.0 models, which would make good models appear
# broken during probing.
_GEMINI_MODEL_CANDIDATES: List[str] = [
    "gemini-3-flash-preview",        # latest frontier multimodal flash tier
    "gemini-3.1-flash-lite-preview", # newer fast preview tier when available
    "gemini-2.5-flash",              # stable low-latency fallback
    "gemini-2.5-flash-lite",         # cheapest stable fallback
    "gemini-2.5-pro",                # slower but strongest stable fallback
]
_GEMINI_MODEL:        str  = "gemini-2.5-flash"  # default; overridden by probe
_GEMINI_MODEL_PROBED: bool = False  # True once (success or all-failed)
_GEMINI_PROBE_OK:     bool = False  # True only when at least one model succeeded
_GEMINI_PROBE_ERROR:  Optional[str] = None
_GEMINI_URL:          str  = "https://generativelanguage.googleapis.com/v1beta/models"


def _load_gemini_key_from_env() -> str:
    """Load Gemini API key from GEMINI_API_KEY env var or local .env file."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.isfile(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line.startswith("GEMINI_API_KEY="):
                        return line.split("=", 1)[1].strip().strip('"').strip("'")
        except Exception:
            pass
    return ""


def _persist_gemini_key(key: str) -> None:
    """Write GEMINI_API_KEY into python/.env so a key entered in the UI survives
    server restarts (otherwise it lives only in memory for the session)."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    new_line = f"GEMINI_API_KEY={key}\n"
    try:
        lines: list[str] = []
        found = False
        if os.path.isfile(env_path):
            with open(env_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.strip().startswith("GEMINI_API_KEY="):
                        lines.append(new_line)
                        found = True
                    else:
                        lines.append(line)
        if not found:
            if lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            lines.append(new_line)
        with open(env_path, "w", encoding="utf-8") as fh:
            fh.writelines(lines)
        logger.info("[GEMINI] Key persisted to %s", env_path)
    except Exception as e:
        logger.warning("[GEMINI] Could not persist key to .env: %s", e)


def _gemini_probe_pending() -> bool:
    return bool(_GEMINI_API_KEY) and not _GEMINI_MODEL_PROBED


def _check_gemini() -> bool:
    if not _GEMINI_API_KEY:
        return False
    if _GEMINI_PROBE_OK:
        return True
    return not _GEMINI_MODEL_PROBED


def _probe_gemini_model() -> str:
    """Find the first working Gemini model from _GEMINI_MODEL_CANDIDATES.

    Sends a minimal text-only ping (no image) to each candidate, returns the
    first that responds with HTTP 200.  Result is cached in _GEMINI_MODEL so
    subsequent calls skip the probe.
    """
    global _GEMINI_MODEL, _GEMINI_MODEL_PROBED, _GEMINI_PROBE_OK, _GEMINI_PROBE_ERROR
    if _GEMINI_MODEL_PROBED:
        return _GEMINI_MODEL
    import json as _json
    import urllib.request as _ur
    import urllib.error as _ue
    for candidate in _GEMINI_MODEL_CANDIDATES:
        url = f"{_GEMINI_URL}/{candidate}:generateContent?key={_GEMINI_API_KEY}"
        # Minimal probe — NO thinkingConfig so 2.0 models (which don't support
        # thinkingConfig) are not falsely rejected during the probe phase.
        ping = _json.dumps({
            "contents": [{"parts": [{"text": "hi"}]}],
            "generationConfig": {"maxOutputTokens": 1},
        }).encode()
        req = _ur.Request(url, data=ping, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with _ur.urlopen(req, timeout=6) as r:
                if r.status == 200:
                    _GEMINI_MODEL = candidate
                    _GEMINI_MODEL_PROBED = True
                    _GEMINI_PROBE_OK = True
                    _GEMINI_PROBE_ERROR = None
                    logger.info(f"[GEMINI] Active model: {candidate}")
                    return candidate
        except _ue.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")
            lowered = body.lower()
            if "api_key_invalid" in lowered or "api key not valid" in lowered:
                _GEMINI_MODEL_PROBED = True
                _GEMINI_PROBE_OK = False
                _GEMINI_PROBE_ERROR = "Gemini API key is invalid."
                logger.warning("[GEMINI] Probe failed: invalid API key")
                return _GEMINI_MODEL
            if "permission_denied" in lowered or "api has not been used" in lowered:
                _GEMINI_MODEL_PROBED = True
                _GEMINI_PROBE_OK = False
                _GEMINI_PROBE_ERROR = "Generative Language API is not enabled for this Gemini key."
                logger.warning("[GEMINI] Probe failed: API not enabled for key")
                return _GEMINI_MODEL
            _GEMINI_PROBE_ERROR = f"Gemini probe failed with HTTP {e.code}."
            logger.info(f"[GEMINI] Model {candidate} → HTTP {e.code}, trying next")
        except Exception as e:
            _GEMINI_PROBE_ERROR = f"Gemini probe failed: {type(e).__name__}"
            logger.info(f"[GEMINI] Model {candidate} → {e}, trying next")
    # All candidates failed
    logger.warning(f"[GEMINI] All model candidates failed; defaulting to {_GEMINI_MODEL}")
    _GEMINI_MODEL_PROBED = True
    _GEMINI_PROBE_OK = False
    if _GEMINI_PROBE_ERROR is None:
        _GEMINI_PROBE_ERROR = "No supported Gemini model responded successfully."
    return _GEMINI_MODEL


def _probe_gemini_model_strict() -> str:
    """Validate the current Gemini API key by requiring one candidate to return HTTP 200.

    Raises a user-facing ValueError/RuntimeError when the key is invalid or the
    API cannot be reached successfully.
    """
    if not _GEMINI_API_KEY:
        raise ValueError("Gemini API key is empty.")

    import json as _json
    import urllib.request as _ur
    import urllib.error as _ue

    errors: List[str] = []
    for candidate in _GEMINI_MODEL_CANDIDATES:
        url = f"{_GEMINI_URL}/{candidate}:generateContent?key={_GEMINI_API_KEY}"
        ping = _json.dumps({
            "contents": [{"parts": [{"text": "hi"}]}],
            "generationConfig": {"maxOutputTokens": 1},
        }).encode()
        req = _ur.Request(url, data=ping, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with _ur.urlopen(req, timeout=5) as r:
                if r.status == 200:
                    return candidate
                errors.append(f"{candidate}: HTTP {r.status}")
        except _ue.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")
            lowered = body.lower()
            if "api_key_invalid" in lowered or "api key not valid" in lowered:
                raise ValueError("Gemini API key is invalid. Please paste a valid Google AI Studio key.")
            if "permission_denied" in lowered or "api has not been used" in lowered:
                raise ValueError("Gemini API key was rejected. Check that the Generative Language API is enabled for the key's project.")
            errors.append(f"{candidate}: HTTP {e.code}")
        except Exception as e:
            errors.append(f"{candidate}: {type(e).__name__}")

    raise RuntimeError(
        "Gemini API validation failed. No supported Gemini model responded successfully"
        + (f" ({'; '.join(errors[:3])})" if errors else ".")
    )


def set_gemini_key(key: str) -> None:
    """Set the Gemini API key at runtime (called from /panel/set-gemini-key).

    Non-empty keys are validated against the live Gemini API before replacing
    the current key, so the frontend gets an immediate actionable error instead
    of a false "key set" state.
    """
    global _GEMINI_API_KEY, _GEMINI_MODEL_PROBED, _GEMINI_MODEL, _GEMINI_PROBE_OK, _GEMINI_PROBE_ERROR

    clean = key.strip()
    if not clean:
        _GEMINI_API_KEY = ""
        _GEMINI_MODEL_PROBED = False
        _GEMINI_PROBE_OK = False
        _GEMINI_PROBE_ERROR = None
        return

    prev_key = _GEMINI_API_KEY
    prev_probed = _GEMINI_MODEL_PROBED
    prev_model = _GEMINI_MODEL
    prev_probe_ok = _GEMINI_PROBE_OK
    prev_error = _GEMINI_PROBE_ERROR

    _GEMINI_API_KEY = clean
    _GEMINI_MODEL_PROBED = False
    _GEMINI_PROBE_OK = False
    _GEMINI_PROBE_ERROR = None

    try:
        _GEMINI_MODEL = _probe_gemini_model_strict()
        _GEMINI_MODEL_PROBED = True
        _GEMINI_PROBE_OK = True
        _GEMINI_PROBE_ERROR = None
        _persist_gemini_key(clean)  # survive restarts
    except Exception:
        _GEMINI_API_KEY = prev_key
        _GEMINI_MODEL_PROBED = prev_probed
        _GEMINI_MODEL = prev_model
        _GEMINI_PROBE_OK = prev_probe_ok
        _GEMINI_PROBE_ERROR = prev_error
        raise


# Load key on module import (picks up .env automatically)
_GEMINI_API_KEY = _load_gemini_key_from_env()


def _launch_background_gemini_probe() -> None:
    """Probe the Gemini API in a background daemon thread on server startup.

    This ensures that by the time the user presses "Run Detection", the
    _GEMINI_PROBE_OK flag reflects whether the API actually works, not just
    whether the key string is non-empty.  The result is surfaced in
    check_panel_pipeline_available() as `gemini_probe_ok`.
    """
    if not _GEMINI_API_KEY:
        return
    def _do_probe() -> None:
        try:
            _probe_gemini_model()
            logger.info(f"[GEMINI] Startup probe done: ok={_GEMINI_PROBE_OK}, model={_GEMINI_MODEL}")
        except Exception as exc:
            logger.warning(f"[GEMINI] Startup probe failed: {exc}")
    t = threading.Thread(target=_do_probe, daemon=True, name="gemini-probe")
    t.start()


_launch_background_gemini_probe()


def _load_yolo():
    global _yolo_model, _yolo_checked
    if _yolo_checked:
        return _yolo_model
    _yolo_checked = True
    try:
        from ultralytics import YOLO
        weight_info = _yolo_weight_info()
        # Prefer a SynthSkin-trained detector. If absent, fall back to generic
        # COCO YOLO only as a weak proposal source; the UI exposes this clearly.
        _yolo_model = YOLO(weight_info["path"] or "yolo11n.pt")
        logger.info("YOLO loaded (%s): %s", weight_info["kind"] or "download/default", weight_info["name"] or "yolo11n.pt")
    except Exception as exc:
        logger.warning(f"YOLO unavailable: {exc}")
        _yolo_model = None
    return _yolo_model


def _load_ocr():
    global _ocr_engine, _ocr_checked
    if _ocr_checked:
        return _ocr_engine
    _ocr_checked = True
    try:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
        logger.info("RapidOCR loaded")
    except Exception as exc:
        logger.warning(f"RapidOCR unavailable: {exc}")
        _ocr_engine = None
    return _ocr_engine


def _sam_available() -> bool:
    """Check whether processor.segment_with_sam2 is usable."""
    global _sam_checked, _sam_ok
    if _sam_checked:
        return _sam_ok
    _sam_checked = True
    try:
        import sam_service
        _sam_ok = bool(sam_service._check_sam2() and sam_service._get_checkpoint_path())
    except Exception:
        _sam_ok = False
    return _sam_ok


def check_panel_pipeline_available() -> Dict[str, Any]:
    """Report capabilities to the frontend — FAST, no model loading.

    Checks YOLO, SAM2, RapidOCR, and Gemini key status without triggering
    any model loads. Florence-2 is retired; always returns False for it.
    """
    # ── YOLO status ─────────────────────────────────────────────────────────
    # Check if already loaded, installed, or local weights exist without loading.
    weight_info = _yolo_weight_info()
    custom_yolo_ok = weight_info["kind"] == "custom"
    yolo_weight_path = weight_info["path"]

    if _yolo_model is not None:
        yolo_ok = True
    elif _yolo_checked:
        yolo_ok = _yolo_model is not None
    else:
        yolo_ok = yolo_weight_path is not None or importlib.util.find_spec("ultralytics") is not None

    rapidocr_ok = _ocr_engine is not None or importlib.util.find_spec("rapidocr_onnxruntime") is not None

    return {
        "florence2": False,
        "florence2_backend": "none",
        "florence2_blocked_by": None,
        "yolo": yolo_ok,
        "custom_yolo": custom_yolo_ok,
        "yolo_weight": weight_info["name"],
        "yolo_weight_kind": weight_info["kind"] or ("package-default" if yolo_ok else "none"),
        "professional_detector_ready": custom_yolo_ok,
        "detector_recommendation": None if custom_yolo_ok else "Train or place synthskin_yolo.pt in python/models for reliable knob/slider/LED detection. Generic COCO YOLO is only a weak fallback.",
        "sam2": _sam_available(),
        "rapidocr": rapidocr_ok,
        "device": _detect_runtime_device(),
        "gemini_key_set": bool(_GEMINI_API_KEY),
        "gemini_probe_ok": _GEMINI_PROBE_OK,
        "gemini_probe_pending": _gemini_probe_pending(),
        "gemini_probe_error": _GEMINI_PROBE_ERROR,
        "gemini_active_model": _GEMINI_MODEL if _GEMINI_PROBE_OK else None,
        "gemma4": False,
        "gemma4_backend": None,
    }


def reset_florence_sentinel() -> Dict[str, Any]:
    """Delete the .florence2_broken sentinel file (kept for API compatibility)."""
    models_dir = os.path.join(os.path.dirname(__file__), "models")
    sentinel_file = os.path.join(models_dir, ".florence2_broken")
    removed = False
    if os.path.isfile(sentinel_file):
        try:
            os.remove(sentinel_file)
            removed = True
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    return {"ok": True, "sentinel_removed": removed}


def clear_models() -> Dict[str, Any]:
    """Release all cached AI models to free VRAM/RAM.

    Called when the Analyze Layout window is closed or on explicit user request.
    After this, the next analysis will re-load models on demand.
    """
    global _yolo_model, _yolo_checked
    global _ocr_engine, _ocr_checked
    global _sam_checked, _sam_ok

    freed = []

    if _yolo_model is not None:
        del _yolo_model
        _yolo_model = None
        _yolo_checked = False
        freed.append("yolo")

    if _ocr_engine is not None:
        del _ocr_engine
        _ocr_engine = None
        _ocr_checked = False
        freed.append("rapidocr")

    _sam_checked = False
    _sam_ok = False

    # Force garbage collection + CUDA cache clear
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            freed.append("cuda_cache")
    except ImportError:
        pass

    logger.info(f"[MEMORY] Cleared models: {freed}")
    return {"freed": freed, "count": len(freed)}


_COCO_UI_MAP = {
    # Keep this intentionally conservative. Broad COCO classes such as bowl,
    # vase, apple, or orange create many false knobs on textured/photographed
    # panels. Unknown classes are handled by _classify_box_shape instead.
    "clock": "knob", "sports ball": "knob", "frisbee": "knob", "donut": "knob",
    "cell phone": "screen", "tv": "screen", "laptop": "screen",
    "keyboard": "screen", "book": "screen", "microwave": "screen",
    "remote": "slider",
    "traffic light": "led", "stop sign": "button",
}


def _yolo_proposals(img_bgr: np.ndarray, conf: float = 0.08) -> List[Tuple[str, Tuple[float, float, float, float], float]]:
    """Generate proposals from YOLO with COCO→UI class mapping + shape analysis.

    Returns list of (type, (x1, y1, x2, y2), confidence) tuples.
    Uses COCO class hints when available, otherwise classifies by shape.
    """
    model = _load_yolo()
    if model is None:
        return []
    try:
        weight_info = _yolo_weight_info()
        custom_detector = weight_info["kind"] == "custom"
        results = model.predict(img_bgr, conf=conf, verbose=False)
        out: List[Tuple[str, Tuple[float, float, float, float], float]] = []
        h_img, w_img = img_bgr.shape[:2]
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

        for r in results:
            if r.boxes is None:
                continue
            boxes = r.boxes.xyxy.cpu().numpy()
            confs = r.boxes.conf.cpu().numpy()
            cls_ids = r.boxes.cls.cpu().numpy().astype(int)
            names = r.names if hasattr(r, 'names') else {}

            for i, b in enumerate(boxes):
                x1, y1, x2, y2 = map(float, b)
                yolo_conf = float(confs[i])
                cls_name = names.get(int(cls_ids[i]), "")
                bw, bh = x2 - x1, y2 - y1

                # Skip very large detections (>25% of image) and tiny ones
                if bw * bh > 0.25 * w_img * h_img or bw < 4 or bh < 4:
                    continue

                # Custom SynthSkin weights should emit direct UI labels. Generic
                # COCO weights are not trusted as UI classes; they only provide
                # weak boxes that are reclassified by shape.
                if custom_detector:
                    ui_type = _normalise_target_type(cls_name)
                    if ui_type is None:
                        continue
                    out_conf = min(0.96, max(0.40, yolo_conf))
                else:
                    ui_type = _COCO_UI_MAP.get(cls_name)
                    if ui_type is None:
                        ui_type = _classify_box_shape(gray, int(x1), int(y1),
                                                      int(x2), int(y2))
                    # Generic COCO YOLO has not learned synth controls. Keep it
                    # below Gemini/custom-YOLO/CV confidence so false positives
                    # do not dominate NMS/fusion.
                    out_conf = min(0.58, 0.30 + yolo_conf * 0.25)
                out.append((ui_type, (x1, y1, x2, y2), out_conf))

        logger.info("[YOLO] %s proposals from %s detector", len(out), weight_info["kind"] or "generic")
        return out
    except Exception as exc:
        logger.warning(f"YOLO proposals failed: {exc}")
        return []


def _classify_box_shape(gray: np.ndarray, x1: int, y1: int,
                        x2: int, y2: int) -> str:
    """Enhanced bounding box classification using multi-feature analysis.

    Combines aspect ratio, circularity, concentric edge patterns, and internal
    texture analysis to distinguish between knobs, buttons, sliders, screens,
    and other UI elements with higher accuracy.
    """
    h_img, w_img = gray.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w_img, x2), min(h_img, y2)
    bw, bh = x2 - x1, y2 - y1
    if bw < 4 or bh < 4:
        return "button"

    aspect = bw / max(bh, 1)
    area = bw * bh

    # Very elongated → slider/fader
    if aspect > 2.8 or aspect < 0.36:
        return "slider"

    # Large rectangle → screen/display
    if area > 0.02 * w_img * h_img and 0.5 < aspect < 2.0:
        return "screen"

    roi = gray[y1:y2, x1:x2]
    blurred = cv2.GaussianBlur(roi, (5, 5), 1.5)

    # ── Multi-threshold circularity analysis ──────────────────────────────
    # Try two Canny thresholds: standard + low for dark/metallic panels
    circularity = 0.0
    for canny_lo, canny_hi in ((40, 120), (20, 80)):
        edges = cv2.Canny(blurred, canny_lo, canny_hi)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if contours:
            largest = max(contours, key=cv2.contourArea)
            cnt_area = cv2.contourArea(largest)
            perimeter = cv2.arcLength(largest, True)
            if perimeter > 0:
                c = 4 * math.pi * cnt_area / (perimeter ** 2)
                circularity = max(circularity, c)

    # ── Concentric pattern detection (distinguishes knobs from round buttons)
    # Knobs typically have concentric rings (skirt, cap, pointer) while
    # round buttons are more uniform inside.
    concentric_score = 0.0
    if min(bw, bh) > 16:
        cx_roi, cy_roi = bw // 2, bh // 2
        max_r = min(bw, bh) // 2
        if max_r > 8:
            # Sample intensity at 5 concentric rings for finer resolution
            ring_means = []
            for frac in (0.20, 0.40, 0.55, 0.70, 0.90):
                r_inner = max(1, int(max_r * (frac - 0.06)))
                r_outer = int(max_r * (frac + 0.06))
                yy, xx = np.ogrid[:bh, :bw]
                dist2 = (xx - cx_roi) ** 2 + (yy - cy_roi) ** 2
                ring_mask = (dist2 >= r_inner ** 2) & (dist2 <= r_outer ** 2)
                vals = roi[ring_mask]
                if vals.size > 4:
                    ring_means.append(float(np.mean(vals)))
            if len(ring_means) >= 3:
                # Adaptive normalization: use ROI dynamic range instead of fixed 40
                roi_range = max(1.0, float(np.ptp(roi)))
                ring_range = max(ring_means) - min(ring_means)
                concentric_score = min(1.0, ring_range / (roi_range * 0.15))

    # ── Radial gradient texture (knobs have strong radial features) ────────
    radial_texture_score = 0.0
    if min(bw, bh) > 20:
        cx_roi, cy_roi = bw // 2, bh // 2
        max_r = min(bw, bh) // 2
        # Polar transform of the ROI center
        _psize = min(180, max_r * 4)
        _polar = cv2.warpPolar(
            roi, (_psize, max(4, max_r)),
            (float(cx_roi), float(cy_roi)),
            float(max_r), cv2.WARP_POLAR_LINEAR,
        )
        if _polar.size > 0:
            # Radial gradient uniformity: knobs have consistent angular patterns
            _rgrad = np.abs(np.diff(_polar.astype(np.float32), axis=1))
            if _rgrad.size > 0:
                _per_angle = np.mean(_rgrad, axis=1)
                _std_ratio = float(np.std(_per_angle)) / max(1.0, float(np.mean(_per_angle)))
                # Low variation = uniform radial gradient = typical knob
                radial_texture_score = max(0.0, min(1.0, 1.0 - _std_ratio))

    # ── HoughCircles confirmation with adaptive param1 ─────────────────────
    hough_found = False
    r_min = max(3, int(min(bw, bh) * 0.25))
    r_max = max(r_min + 2, int(max(bw, bh) * 0.55))
    if r_max > r_min >= 5:
        # Adaptive param1: lower for dark panels, higher for bright
        roi_mean = float(np.mean(roi))
        param1_val = max(40, min(100, int(roi_mean * 0.55)))
        for p2 in (20, 14, 10):
            circles = cv2.HoughCircles(
                blurred, cv2.HOUGH_GRADIENT, dp=1.2,
                minDist=max(10, r_min),
                param1=param1_val, param2=p2,
                minRadius=r_min, maxRadius=r_max,
            )
            if circles is not None:
                hough_found = True
                break

    # ── Decision logic ─────────────────────────────────────────────────────
    # Strong circular evidence → knob
    if circularity > 0.45 and 0.55 < aspect < 1.8:
        # But check if it's a round button (small, flat, no concentric pattern)
        if area < 0.003 * w_img * h_img and concentric_score < 0.12 and not hough_found and radial_texture_score < 0.3:
            return "button"  # small round button
        return "knob"

    # Hough circle found + roughly square → knob (even with messy edges)
    if hough_found and 0.6 < aspect < 1.6:
        return "knob"

    # Moderate circularity + concentric pattern → knob (lowered for beveled knobs)
    if circularity > 0.30 and concentric_score > 0.20 and 0.6 < aspect < 1.6:
        return "knob"

    # Radial texture + squarish → likely knob even with poor edge detection
    if radial_texture_score > 0.5 and concentric_score > 0.15 and 0.6 < aspect < 1.6:
        return "knob"

    # Moderately elongated (1.8–2.8) with some height → could be a slider
    if (1.8 < aspect < 2.8 or 0.36 < aspect < 0.56) and area > 0.002 * w_img * h_img:
        return "slider"

    # Small and squarish → button
    if area < 0.005 * w_img * h_img and 0.5 < aspect < 2.0:
        return "button"

    # Medium-sized, near-square → knob (common default)
    if 0.65 < aspect < 1.5 and area > 0.003 * w_img * h_img:
        return "knob"

    return "button"


def _simple_slider_proposals(img_bgr: np.ndarray) -> List[Tuple[str, Tuple[float, float, float, float], float]]:
    """Fast Hough-line pass for vertical/horizontal slider rails.

    The full layout analyzer is conservative and can miss clean faders whose
    rails are bright instead of dark.  This targeted pass is cheap (<10 ms on
    typical screenshots) and only emits elongated slider boxes.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blur, 35, 120)
    min_len = max(45, int(0.10 * min(h, w)))
    lines = cv2.HoughLinesP(
        edges, 1, math.pi / 180,
        threshold=max(24, int(min_len * 0.35)),
        minLineLength=min_len,
        maxLineGap=max(8, int(0.015 * max(h, w))),
    )
    if lines is None:
        return []

    proposals: List[Tuple[str, Tuple[float, float, float, float], float]] = []
    margin_x = 0.025 * w
    margin_y = 0.025 * h
    for ln in lines[:, 0, :]:
        x1, y1, x2, y2 = map(int, ln)
        dx = x2 - x1
        dy = y2 - y1
        length = math.hypot(dx, dy)
        if length < min_len:
            continue

        abs_dx, abs_dy = abs(dx), abs(dy)
        vertical = abs_dy >= abs_dx * 3.0
        horizontal = abs_dx >= abs_dy * 3.0
        if not (vertical or horizontal):
            continue

        if vertical:
            # Drop likely panel borders / separators.
            if length > 0.62 * h or min(x1, x2) < margin_x or max(x1, x2) > w - margin_x:
                continue
            pad_x = max(18, int(length * 0.08))
            pad_y = max(8, int(length * 0.04))
        else:
            if length > 0.62 * w or min(y1, y2) < margin_y or max(y1, y2) > h - margin_y:
                continue
            pad_x = max(8, int(length * 0.04))
            pad_y = max(18, int(length * 0.08))

        bx1 = max(0.0, float(min(x1, x2) - pad_x))
        by1 = max(0.0, float(min(y1, y2) - pad_y))
        bx2 = min(float(w), float(max(x1, x2) + pad_x))
        by2 = min(float(h), float(max(y1, y2) + pad_y))
        if (bx2 - bx1) * (by2 - by1) < 400:
            continue
        proposals.append(("slider", (bx1, by1, bx2, by2), 0.73))

    # Cheap de-duplication by IoU.
    proposals.sort(key=lambda p: p[2], reverse=True)
    kept: List[Tuple[str, Tuple[float, float, float, float], float]] = []
    for p in proposals:
        bb = list(p[1])
        if any(_iou(bb, list(k[1])) > 0.35 for k in kept):
            continue
        kept.append(p)
    return kept[:40]


def _heuristic_proposals(img_bgr: np.ndarray) -> List[Tuple[str, Tuple[float, float, float, float], float]]:
    """Multi-strategy CV fallback using ui_layout_analyzer's 9-stage pipeline.

    Returns list of (type, (x1, y1, x2, y2), confidence) tuples.
    Falls back to basic Hough+contour if the analyzer is unavailable.
    """
    # Try using the full ui_layout_analyzer multi-strategy detector
    try:
        from ui_layout_analyzer import (
            _to_bgr, _preprocess_multi, _detect_circles, _detect_colored_elements,
            _detect_faders, _detect_contours, _nms, DETECTION_MAX_DIM,
        )
        bgr = _to_bgr(img_bgr)
        h_orig, w_orig = bgr.shape[:2]
        scale = min(1.0, DETECTION_MAX_DIM / max(w_orig, h_orig))
        if scale < 1.0:
            work = cv2.resize(bgr, (int(w_orig * scale), int(h_orig * scale)), interpolation=cv2.INTER_AREA)
        else:
            work = bgr
        wh, ww = work.shape[:2]
        gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
        pp = _preprocess_multi(gray, work)

        all_els: list = []
        all_els += _detect_circles(pp["enhanced"], pp["edges_tight"], work, gray, pp["gradient_mag"], wh, ww)
        all_els += _detect_colored_elements(pp["hsv"], work, wh, ww)
        all_els += _detect_faders(gray, pp["enhanced"], wh, ww)
        all_els += _detect_contours(pp["enhanced"], pp["edges_loose"], pp["binary_adaptive"], wh, ww, False)
        all_els = _nms(all_els, 0.35)

        out: List[Tuple[str, Tuple[float, float, float, float], float]] = []
        inv = 1.0 / scale if scale < 1.0 else 1.0
        for el in all_els:
            target_type = _normalise_target_type(el.get("type"))
            if target_type is None:
                continue
            b = el["bounds"]
            x1 = b["x"] * inv
            y1 = b["y"] * inv
            x2 = (b["x"] + b["width"]) * inv
            y2 = (b["y"] + b["height"]) * inv
            conf = el.get("confidence", 0.60)
            out.append((target_type, (x1, y1, x2, y2), conf))
        logger.info(f"[FALLBACK] targeted ui_layout_analyzer found {len(out)} proposals")
        slider_extra = _simple_slider_proposals(img_bgr)
        if slider_extra:
            out.extend(slider_extra)
            logger.info(f"[FALLBACK] simple slider pass added {len(slider_extra)} proposals")
        return out
    except Exception as exc:
        logger.warning(f"[FALLBACK] ui_layout_analyzer unavailable ({exc}); using basic Hough+contour")

    # Basic Hough + contour fallback
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    out_basic: List[Tuple[str, Tuple[float, float, float, float], float]] = []

    # Hough circles for knobs (small–medium radius)
    blur = cv2.medianBlur(gray, 5)
    min_r = max(6, int(0.015 * min(h, w)))
    max_r = int(0.12 * min(h, w))
    circles = cv2.HoughCircles(
        blur, cv2.HOUGH_GRADIENT, dp=1.2,
        minDist=max(10, int(0.04 * min(h, w))),
        param1=100, param2=38, minRadius=min_r, maxRadius=max_r,
    )
    if circles is not None:
        for (cx, cy, r) in circles[0]:
            out_basic.append(("knob", (float(cx - r), float(cy - r), float(cx + r), float(cy + r)), 0.65))

    # Hough circles for large circular screens (oscilloscopes, round VU meters)
    # Radius range: 12%–40% of min(h,w) — too large to be a knob
    large_min_r = int(0.12 * min(h, w))
    large_max_r = int(0.40 * min(h, w))
    if large_max_r > large_min_r:
        large_circles = cv2.HoughCircles(
            blur, cv2.HOUGH_GRADIENT, dp=1.3,
            minDist=max(large_min_r, int(0.15 * min(h, w))),
            param1=60, param2=32, minRadius=large_min_r, maxRadius=large_max_r,
        )
        if large_circles is not None:
            for (cx, cy, r) in large_circles[0]:
                out_basic.append(("screen", (float(cx - r), float(cy - r), float(cx + r), float(cy + r)), 0.70))

    # Contours (buttons, screens, sliders)
    edges = cv2.Canny(gray, 60, 180)
    edges = cv2.dilate(edges, np.ones((2, 2), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = h * w
    for c in contours:
        area = cv2.contourArea(c)
        if area < 300 or area > 0.2 * img_area:
            continue
        x, y, cw, ch = cv2.boundingRect(c)
        if cw < 10 or ch < 10:
            continue
        ar = cw / float(ch) if ch else 0
        rect_fill = area / max(cw * ch, 1)
        if rect_fill < 0.30:
            continue
        if ar > 2.5 or ar < 0.4:
            kind = "slider"
        elif cw > 70 and ch > 35 and rect_fill > 0.50:
            kind = "screen"
        elif cw > 90 and ch > 55:
            kind = "screen"
        elif max(cw, ch) < 22:
            kind = "led"
        else:
            kind = "button"
        out_basic.append((kind, (float(x), float(y), float(x + cw), float(y + ch)), 0.60))
    out_basic.extend(_simple_slider_proposals(img_bgr))
    return out_basic


def _gemini_detect_components(
    img_bgr: np.ndarray,
    progress: Optional[ProgressCB] = None,
) -> List[Dict[str, Any]]:
    """Detect synth panel controls via Gemini Vision API (cloud, requires GEMINI_API_KEY).

    Returns detections in standard format: [{type, bbox, confidence, source}]
    with bounding boxes in original image pixel coordinates.
    Gemini box format: [y_min, x_min, y_max, x_max] normalized 0–1000.
    """
    if not _check_gemini():
        return []
    try:
        import json as _json
        import base64 as _b64
        import urllib.request

        h_img, w_img = img_bgr.shape[:2]
        # 1536px gives better detail for small buttons and dense panels.
        # Token count stays acceptable (~1 MB JPEG for most plugin screenshots).
        scale = min(1.0, 1536.0 / max(h_img, w_img, 1))
        if scale < 1.0:
            send_img = cv2.resize(
                img_bgr, (int(w_img * scale), int(h_img * scale)),
                interpolation=cv2.INTER_AREA,
            )
        else:
            send_img = img_bgr

        ok, buf = cv2.imencode(".jpeg", send_img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            return []
        img_b64 = _b64.b64encode(buf.tobytes()).decode()

        prompt = (
            "Synthesizer/audio hardware panel. Detect controls and displays only. "
            "Allowed types: knob, slider, button, switch, led, screen. "
            "knob=rotary dial with pivot/pointer; slider=linear fader/track; "
            "button=pressable pad/push button; switch=toggle/rocker selector; "
            "led=tiny status light only; screen=display, oscilloscope, digital readout, VU meter, analog meter, or gauge. "
            "Meters and gauges are always screen, never knob. LEDs are never buttons. "
            "Return JSON array only: [{\"box\":[y_min,x_min,y_max,x_max],\"type\":\"knob\"}]. "
            "Coords 0-1000 with y_min first. Skip text labels, numeric scales, logos, decorative panel art, screws, and jack holes."
        )

        active_model = _probe_gemini_model()
        gen_cfg: Dict[str, Any] = {
            "temperature": 0,
            # Dense panels (100+ controls) emit a long JSON array; 2048 truncated
            # it mid-array → parse failed → ALL Gemini detections dropped (weak CV
            # fallback). Gemini-3 also spends "thinking" tokens from this same
            # budget, so 8192 still truncated at ~51 objects. 32768 leaves room for
            # both thinking and a full panel; the salvage parser is the backstop.
            "maxOutputTokens": 32768,
        }
        # Disable "thinking" for the detection call — it adds many seconds of
        # latency (Gemini 3 thinks by default) and isn't needed to read boxes off
        # an image; leaving it on made the request time out → 0 detections → weak
        # CV fallback. thinkingConfig is supported by 2.5+ and 3.x but NOT 2.0
        # (which errors on it), so gate out 2.0 only.
        if "2.0" not in active_model:
            gen_cfg["thinkingConfig"] = {"thinkingBudget": 0}

        payload = _json.dumps({
            "contents": [{"parts": [
                {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}},
                {"text": prompt},
            ]}],
            "generationConfig": gen_cfg,
        }).encode()
        url = f"{_GEMINI_URL}/{active_model}:generateContent?key={_GEMINI_API_KEY}"
        req = urllib.request.Request(
            url, data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        t0 = time.perf_counter()
        # Hard wall-clock timeout (15 s).  urllib socket timeout alone does not
        # fire when the server trickle-sends data during the thinking phase.
        # With thinkingBudget:0, Gemini 2.5 Flash should respond in 1–4 s.
        import threading as _thr
        _resp_holder: list = []
        _err_holder:  list = []
        _done_evt = _thr.Event()
        def _do_request():
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    _resp_holder.append(_json.loads(r.read()))
            except Exception as _ex:
                _err_holder.append(_ex)
            finally:
                _done_evt.set()

        # Heartbeat thread: sends progress ticks every 2 s while waiting.
        def _heartbeat():
            elapsed = 0
            while not _done_evt.wait(timeout=2.0):
                elapsed += 2
                if progress:
                    progress("detect", 5, f"Gemini detecting… ({elapsed}s)")
                if elapsed >= 32:
                    break  # hard cap is 33 s, stop early

        _t = _thr.Thread(target=_do_request, daemon=True)
        _hb = _thr.Thread(target=_heartbeat, daemon=True)
        _t.start()
        _hb.start()
        _t.join(timeout=33)          # hard cap (a little over the 30 s socket timeout)
        _done_evt.set()              # stop heartbeat thread
        if _err_holder:
            raise _err_holder[0]
        if not _resp_holder:
            raise TimeoutError("Gemini API did not respond within 33 s — falling back to YOLO+CV")
        result = _resp_holder[0]
        infer_ms = (time.perf_counter() - t0) * 1000

        parts = (result.get("candidates", [{}])[0]
                 .get("content", {}).get("parts", [{}]))
        raw = parts[0].get("text", "").strip() if parts else ""
        logger.info(f"[GEMINI] Detection in {infer_ms:.0f} ms, response: {raw[:120]}")

        if not raw:
            logger.warning("[GEMINI] Empty detection response")
            return []

        # Parse JSON array — strip optional markdown fences
        import re as _re
        # Remove ```json ... ``` fences
        raw_clean = _re.sub(r"```[a-z]*\n?", "", raw).strip()

        # Find the outermost array, then parse. A truncated response (token cap)
        # has no clean closing ']', so we must not rely on a greedy [...] match
        # alone — fall back to salvaging every complete {...} object.
        boxes_data: Any = None
        m = _re.search(r'\[.*\]', raw_clean, _re.DOTALL)
        if m:
            try:
                boxes_data = _json.loads(m.group(0))
            except Exception:
                boxes_data = None
        if not isinstance(boxes_data, list):
            # Salvage path: extract each complete {...} object individually. This
            # recovers all valid detections even when the array was cut off.
            salvaged: List[Any] = []
            for obj_match in _re.finditer(r'\{[^{}]*\}', raw_clean):
                try:
                    salvaged.append(_json.loads(obj_match.group(0)))
                except Exception:
                    continue
            if salvaged:
                logger.warning(f"[GEMINI] Recovered {len(salvaged)} objects from truncated/malformed JSON")
                boxes_data = salvaged
            else:
                logger.warning(f"[GEMINI] No parsable detections in: {raw_clean[:200]}")
                return []

        inv_scale = 1.0 / scale if scale < 1.0 else 1.0
        s_h, s_w = send_img.shape[:2]
        dets: List[Dict[str, Any]] = []
        for item in boxes_data:
            if not isinstance(item, dict):
                continue
            # Gemini models sometimes use "box_2d" or "bounding_box" instead of "box"
            box = item.get("box") or item.get("box_2d") or item.get("bounding_box") or []
            if len(box) != 4:
                continue
            y_min, x_min, y_max, x_max = (max(0, min(1000, int(v))) for v in box)
            # Convert 0–1000 normalized → original-image pixel coords
            x1 = x_min / 1000.0 * s_w * inv_scale
            y1 = y_min / 1000.0 * s_h * inv_scale
            x2 = x_max / 1000.0 * s_w * inv_scale
            y2 = y_max / 1000.0 * s_h * inv_scale
            if x2 - x1 < 4 or y2 - y1 < 4:
                continue
            # Gemini models sometimes use "label" instead of "type"
            ctype = _normalise_target_type(item.get("type") or item.get("label"))
            if ctype is None:
                continue
            dets.append({
                "type": ctype,
                "bbox": [x1, y1, x2, y2],
                "confidence": 0.85,
                "source": "gemini",
                "phrase": ctype,
            })

        logger.info(f"[GEMINI] Detected {len(dets)} components")
        return dets

    except Exception as exc:
        logger.warning(f"[GEMINI] Component detection failed: {exc}")
        return []


def _source_family_name(source: Any) -> str:
    source_name = str(source or "unknown")
    for prefix in ("gemini", "yolo", "heuristic"):
        if source_name.startswith(prefix):
            return prefix
    return source_name


def _flatten_detection_sources(det: Dict[str, Any]) -> List[str]:
    flattened: List[str] = []
    raw_sources = det.get("sources")
    if isinstance(raw_sources, list):
        flattened.extend(str(src) for src in raw_sources if src)
    raw_source = det.get("source")
    if raw_source:
        flattened.append(str(raw_source))
    if not flattened:
        return ["unknown"]
    return sorted(set(flattened))


_SOURCE_TYPE_PRIORS: Dict[str, Dict[str, float]] = {
    "gemini": {
        "button": 0.05,
        "switch": 0.06,
        "jack": 0.06,
        "screen": 0.04,
        "slider": 0.03,
    },
    "yolo": {
        "knob": 0.05,
        "screen": 0.04,
        "button": 0.02,
        "slider": 0.03,
    },
    "heuristic": {
        "meter": 0.07,
        "screen": 0.06,
        "fader": 0.06,
        "slider": 0.05,
        "button": 0.04,
        "switch": 0.03,
    },
}


def _apply_source_type_priors(dets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Nudge confidence toward the detector families that are strongest per type."""
    if not dets:
        return dets

    weighted: List[Dict[str, Any]] = []
    for det in dets:
        family = _source_family_name(det.get("source"))
        boost = _SOURCE_TYPE_PRIORS.get(family, {}).get(str(det.get("type") or ""), 0.0)
        if boost <= 0:
            weighted.append(det)
            continue
        updated = dict(det)
        updated["confidence"] = min(0.97, float(updated.get("confidence", 0.0)) + boost)
        weighted.append(updated)
    return weighted


def detect_components(
    img_bgr: np.ndarray,
    min_confidence: float = 0.40,
    progress: Optional[ProgressCB] = None,
    multi_scale: bool = True,
    detection_model: str = "auto",
) -> List[Dict[str, Any]]:
    """Stage 1. Fast synth-control detection with model-specific strengths.

    detection_model controls which source(s) are used:
      "auto"   — Gemini when configured + YOLO + targeted OpenCV fusion
      "gemini" — Gemini API first; falls back to YOLO + targeted OpenCV
      "yolo"   — YOLO + targeted OpenCV only (fastest local path)
    Legacy values ("florence2"/"cv") are mapped to the optimized local path.
    """
    detections: List[Dict[str, Any]] = []
    h, w = img_bgr.shape[:2]
    ai_succeeded = False
    semantic_ai_used = False

    # Normalise model name
    _model = detection_model.lower().strip() if detection_model else "auto"
    if _model in {"florence2", "cv"}:
        logger.info("[DETECT] Legacy model '%s' requested; using optimized YOLO+CV path", _model)
        _model = "yolo"
    elif _model not in {"auto", "gemini", "yolo"}:
        logger.info("[DETECT] Unknown model '%s' requested; using auto", _model)
        _model = "auto"
    if progress:
        progress("detect", 3, f"Starting optimized synth-control detection ({_model})…")

    # ── 1. Gemini API (broad semantic recall) ─────────────────────────────────
    if _model in ("auto", "gemini") and _check_gemini():
        if progress:
            progress("detect", 5, "Gemini API: detecting components…")
        t_gemini = time.perf_counter()
        gemini_dets = _gemini_detect_components(img_bgr, progress)
        gemini_ms = (time.perf_counter() - t_gemini) * 1000
        if gemini_dets:
            detections.extend(gemini_dets)
            ai_succeeded = True
            semantic_ai_used = True
            logger.info(f"[TIMER] Gemini detection: {gemini_ms:.0f} ms ({len(gemini_dets)} detections)")
            if progress:
                progress("detect", 28, f"Gemini: {len(gemini_dets)} detections ({gemini_ms:.0f} ms)")
        else:
            logger.warning(f"[GEMINI] Returned 0 valid detections in {gemini_ms:.0f} ms (model={_GEMINI_MODEL})")
            if progress:
                progress("detect", 10, f"⚠ Gemini returned 0 controls — supplementing with YOLO+CV")

    # ── 2. YOLO (local geometric detector) ───────────────────────────────────
    # Generic (COCO) YOLO is near-useless on synth UIs — it fires low-confidence
    # boxes on wood-grain, screws and reflections that read as a red LED/button
    # swarm once unioned with Gemini. So in auto mode, only run YOLO when either
    # Gemini did NOT succeed (we need a fallback) OR the weights are a CUSTOM
    # synth-trained detector. Explicit "yolo" mode still always runs it.
    _yolo_is_custom = _yolo_weight_info()["kind"] == "custom"
    _should_run_yolo = (
        _model == "yolo" or
        (_model == "auto" and (not ai_succeeded or _yolo_is_custom)) or
        (_model == "gemini" and not ai_succeeded)
    )
    if _should_run_yolo and _model != "cv":
        # When a specific AI was selected but couldn't run, surface that to user.
        if _model not in ("auto", "yolo", "cv"):
            _fallback_label = {"gemini": "Gemini"}.get(_model, _model)
            _fallback_reason = f" ({_GEMINI_PROBE_ERROR})" if _model == "gemini" and _GEMINI_PROBE_ERROR else ""
            _fallback_msg = f"{_fallback_label} unavailable{_fallback_reason} — falling back to YOLO+CV"
            logger.warning("[DETECT] %s", _fallback_msg)
            if progress:
                progress("detect", 8, _fallback_msg)

        if progress:
            progress("detect", 8, "Running YOLO object detection…")
        t_yolo = time.perf_counter()
        yolo_results = _yolo_proposals(img_bgr)
        yolo_ms = (time.perf_counter() - t_yolo) * 1000
        for kind, bb, conf in yolo_results:
            detections.append({
                "type": kind,
                "bbox": list(bb),
                "confidence": conf,
                "source": "yolo",
                "phrase": None,
            })
        logger.info(f"[TIMER] YOLO proposals: {yolo_ms:.0f} ms ({len(yolo_results)} detections)")
        if progress:
            progress("detect", 16, f"YOLO: {len(yolo_results)} proposals ({yolo_ms:.0f} ms)")

    # ── 4. CV heuristics — supplement or primary ─────────────────────────────────
    # In auto mode CV contributes targeted complements because it catches dense
    # button rows, faders, and meter geometry that AI models miss. When the user
    # explicitly selects Gemini, respect that choice: keep the run Gemini-only
    # unless Gemini failed, in which case we fall back to YOLO+CV.
    # When Gemini ran, it is authoritative: its boxes are clean and correctly
    # classified. The CV Hough/contour/LED/fader heuristics otherwise hallucinate
    # a red LED swarm (bright screws/reflections), duplicate knob circles, and —
    # worst — large false "slider" bands across empty panel rows. Measured on the
    # WAVESTRUCT panel: with Gemini authoritative, knobs/buttons/LEDs/screens are
    # all clean; the only remaining noise came from CV, incl. 5 of 6 sliders being
    # big false boxes. So CV now runs ONLY as a fallback when the AI brain did not
    # produce a result (Gemini off / failed, or an explicit cv/yolo run).
    _CV_SUPPLEMENT_TYPES = {"slider", "led", "knob", "button", "screen"}
    _should_run_cv = not ai_succeeded
    if _should_run_cv:
        if progress:
            _cv_label = "CV supplement (sliders/LEDs)…" if ai_succeeded else "Running targeted CV detection…"
            progress("detect", 17, _cv_label)
        t_heur = time.perf_counter()
        cv_count = 0
        for item in _heuristic_proposals(img_bgr):
            kind, bb = item[0], item[1]
            conf = item[2] if len(item) > 2 else 0.60
            target_kind = _normalise_target_type(kind)
            if target_kind is None:
                continue
            kind = target_kind
            if ai_succeeded:
                # Skip types AI already handles well — those heuristic hits are
                # almost always false-positive large circles or duplicate knobs.
                if kind not in _CV_SUPPLEMENT_TYPES:
                    continue
                # Scale confidence so AI detections win NMS ties.
                # Knobs/buttons are FP-heavier than sliders/screens when AI ran;
                # they only survive when AI genuinely missed that region.
                conf *= {
                    "knob": 0.78,
                    "button": 0.76,
                    "screen": 0.84,
                }.get(kind, 0.90)
            detections.append({
                "type": kind,
                "bbox": list(bb),
                "confidence": conf,
                "source": "heuristic",
                "phrase": None,
            })
            cv_count += 1
        heur_ms = (time.perf_counter() - t_heur) * 1000
        _cv_mode = "supplement" if ai_succeeded else "primary"
        logger.info(f"[TIMER] CV {_cv_mode}: {heur_ms:.0f} ms ({cv_count} detections)")
        if progress:
            progress("detect", 28, f"CV: {cv_count} elements ({heur_ms:.0f} ms) | Total raw: {len(detections)}")

    if progress:
        progress("detect", 30, f"Raw detections: {len(detections)}")

    # ── Reclassify VU meters and filter tiny indicators ──
    detections = _postprocess_detections(detections, img_bgr)

    # Bias confidence slightly toward the model families that are strongest for
    # each control class before cross-source fusion and NMS choose survivors.
    detections = _apply_source_type_priors(detections)

    # ── Out-of-panel filter: drop detections whose centers fall outside the
    # dominant panel rectangle (kills "noise ring" detections on backdrop). ──
    detections = _out_of_panel_filter(detections, img_bgr)

    # ── Per-type geometric gate: aspect ratio + size sanity per class. ──
    detections = _geometric_filter(detections, img_bgr)

    # ── Edge-contrast gate: knobs/LEDs must stand out from their background.
    # Kills detections that fire on wood-grain or metal texture. ──
    detections = _edge_contrast_filter(detections, img_bgr)

    # ── Display-containment suppression ──
    # Kill texture false-positives that CV heuristics hallucinate INSIDE a large
    # display (wavetable view / oscilloscope / spectrogram). Real controls almost
    # never sit inside the main display, so small low-confidence heuristic hits
    # whose center is well within a display region are dropped. Robust to the
    # screen being missed: large display regions are also synthesized directly.
    detections = _suppress_inside_displays(detections, img_bgr)

    # ── Cross-source confidence boost ──
    # If YOLO and CV both found an element in the same region, boost confidence
    detections = _cross_source_boost(detections, iou_thr=0.30)

    # De-duplicate across prompts (same class, high IoU + center-distance).
    # 0.40 iou: less aggressive than 0.30 — avoids merging distinct adjacent knobs on dense channel strips.
    detections = _nms_per_type(detections, iou_thr=0.40)

    # ── Same-type containment suppression ──
    # If a larger bbox fully contains a smaller one of the SAME type, keep the
    # one with better shape fit (concentric circles, double-detected LEDs, etc.).
    detections = _containment_filter(detections, containment_thr=0.78)

    # Global overlap filter (keep highest-confidence per region).
    # 0.30 iou_thr suppresses "big circle containing small circle" cases where
    # Florence-2 emits both a label's bbox and an enclosing knob bbox.
    detections = _global_nms(detections, iou_thr=0.30)

    # ── Normalize non-canonical types to canonical equivalents ────────────────
    # "meter" and "display" come from CV heuristics / _postprocess_detections
    # and are not in PanelControlType. Map them to "screen" so they appear in
    # the frontend type bar and are handled correctly downstream.
    _TYPE_REMAP = {"display": "screen", "meter": "screen", "fader": "slider"}
    for d in detections:
        if d["type"] in _TYPE_REMAP:
            d["type"] = _TYPE_REMAP[d["type"]]

    detections = [d for d in detections if _normalise_target_type(d.get("type")) is not None]
    for d in detections:
        d["type"] = _normalise_target_type(d.get("type")) or d["type"]

    # Enforce per-type limits to avoid flooding with false positives
    # Tightened from {knob: 48, button: 24, text_field: 48}. Panels rarely have
    # more than ~24 knobs; values above that are almost always duplicates or
    # labels misclassified as controls. The OCR-overlap pass below will still
    # prune any that survive.
    _TYPE_LIMITS = {"knob": 32, "slider": 32, "button": 64, "led": 32,
                    "display": 12, "screen": 16, "panel": 6, "jack": 8,
                    "meter": 16, "label": 40, "text_field": 24, "switch": 24}
    by_type: Dict[str, List[Dict[str, Any]]] = {}
    for d in detections:
        by_type.setdefault(d["type"], []).append(d)
    detections = []
    for tp, items in by_type.items():
        items.sort(key=lambda d: d["confidence"], reverse=True)
        detections.extend(items[:_TYPE_LIMITS.get(tp, 24)])

    # Attach knob size bin and a stable id
    img_diag = math.hypot(w, h)
    for d in detections:
        x1, y1, x2, y2 = d["bbox"]
        d["id"] = uuid.uuid4().hex[:8]
        d["width"] = x2 - x1
        d["height"] = y2 - y1
        d["center"] = [(x1 + x2) * 0.5, (y1 + y2) * 0.5]
        if d["type"] == "knob":
            diag = math.hypot(d["width"], d["height"]) / max(img_diag, 1.0)
            for lo, hi, name in KNOB_SIZE_BINS:
                if lo <= diag < hi:
                    d["sub_type"] = f"knob_{name}"
                    break
            else:
                d["sub_type"] = "knob_medium"
        else:
            d["sub_type"] = d["type"]

    # Keep highest confidences
    detections = [d for d in detections if d["confidence"] >= min_confidence]
    return detections


def _iou(a: List[float], b: List[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    ua = (ax2 - ax1) * (ay2 - ay1)
    ub = (bx2 - bx1) * (by2 - by1)
    return inter / max(ua + ub - inter, 1e-6)


def _suppress_inside_displays(dets: List[Dict[str, Any]],
                              img_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """Drop CV texture false-positives that fire on a graphical display.

    A wavetable view / oscilloscope / spectrogram is colourful line-art on dark,
    so contour/Hough heuristics hallucinate dozens of knobs/LEDs/buttons on it.
    Isolating the display region with classic CV fails (the whole busy panel
    merges into one blob), so we discriminate LOCALLY instead: a false positive
    sits on vivid multi-coloured graphics, while a real control sits on a calm
    (dark metal / grey) background.

    Measured on the WAVESTRUCT panel, the mean saturation of the ring just
    OUTSIDE a detection separates the two populations cleanly: artifacts inside
    the display all had surround-sat ≥ 95, while real controls outside sat ≤ ~76
    (p75). We drop a detection only when ALL hold:
      • source is the CV heuristic (AI detections are trusted),
      • type is knob/led/button/slider and it is small (<1.2% of the image),
      • the surrounding ring is highly saturated (mean sat > 90).

    Confidence is deliberately NOT a gate — CV heuristics assign inflated
    confidence (0.9–0.98) to the very artifacts we are killing.
    """
    h, w = img_bgr.shape[:2]
    img_area = float(h * w)
    sat = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)[:, :, 1].astype(np.float32)

    def _surround_sat(bb: List[float]) -> float:
        x1, y1, x2, y2 = (int(v) for v in bb)
        pw, ph = x2 - x1, y2 - y1
        if pw <= 0 or ph <= 0:
            return 0.0
        # Local band around the box, capped so a wide slider's surround stays
        # local (and doesn't dilute into the calm panel beyond the display).
        mx, my = min(pw // 2 + 4, 50), min(ph // 2 + 4, 50)
        ox1, oy1 = max(0, x1 - mx), max(0, y1 - my)
        ox2, oy2 = min(w, x2 + mx), min(h, y2 + my)
        ring = sat[oy1:oy2, ox1:ox2].copy()
        # Blank the detection's own box so we sample only the surround.
        iy1, ix1 = max(0, y1 - oy1), max(0, x1 - ox1)
        ring[iy1:iy1 + ph, ix1:ix1 + pw] = -1.0
        vals = ring[ring >= 0.0]
        return float(np.mean(vals)) if vals.size >= 20 else 0.0

    def _vivid_frac(bb: List[float]) -> float:
        """Fraction of strongly-saturated pixels INSIDE the box. A false slider
        drawn over a display's mesh lines is full of vivid pixels; a real grey
        slider track is not."""
        x1, y1, x2, y2 = (int(v) for v in bb)
        roi = sat[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
        if roi.size < 20:
            return 0.0
        return float(np.mean(roi > 80.0))

    kept: List[Dict[str, Any]] = []
    dropped = 0
    for d in dets:
        bb = d["bbox"]
        area = (bb[2] - bb[0]) * (bb[3] - bb[1])
        tp = d.get("type")
        if d.get("source") != "heuristic":
            kept.append(d)
            continue
        drop = False
        if tp in ("knob", "led", "button") and area < 0.012 * img_area:
            # Small control sitting on vivid display graphics → texture artifact.
            drop = _surround_sat(bb) > 90.0
        elif tp == "slider":
            # The slider detector fires on a display's horizontal mesh lines;
            # such boxes are large but full of vivid pixels (or vivid-surrounded).
            drop = _surround_sat(bb) > 90.0 or _vivid_frac(bb) > 0.15
        if drop:
            dropped += 1
            continue
        kept.append(d)
    if dropped:
        logger.info("[DETECT] display-texture suppression: dropped %d false-positives", dropped)
    return kept


def _postprocess_detections(dets: List[Dict[str, Any]],
                            img_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """Post-process raw detections to fix misclassifications.

    1. Reclassify large knobs with internal line/scale patterns as 'display'
       (VU meters, gauges have arc scales and needles inside).
    2. Filter tiny circular detections that are value indicators, not knobs.
    3. Detect horizontal scale bars as sliders that fader detection misses.
    """
    h_img, w_img = img_bgr.shape[:2]
    img_area = h_img * w_img
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    out = []
    for d in dets:
        bb = d["bbox"]
        bw = bb[2] - bb[0]
        bh = bb[3] - bb[1]
        box_area = bw * bh

        # Cheap local sanity pass: AI models often call every small round thing
        # a knob. Reclassify tiny saturated dots as LEDs and flat small circles
        # as buttons before stricter knob filtering runs.
        if d.get("type") in {"knob", "button", "led"}:
            refined_type = _refine_round_control_type(d["type"], bb, img_bgr, gray)
            if refined_type != d["type"]:
                d["type"] = refined_type
                if refined_type in {"led", "button"}:
                    d["confidence"] = min(0.88, d["confidence"])

        if d["type"] == "knob":
            # ── Aspect ratio gate ──
            # Real knobs are almost-square. Anything >1.5:1 is a label or a
            # slider mis-fired by Florence-2; reclassify / drop.
            aspect = bw / max(bh, 1)
            if aspect < 0.6 or aspect > 1.67:
                # Elongated → probably a text label or a rectangular button.
                continue

            # ── Filter tiny value indicators ──
            # Very small circular detections (<0.25% of image) are likely
            # parameter value displays (e.g. "0%", "50%"), not actual knobs.
            # Raised from 0.15% → 0.25% because the earlier threshold let
            # small labeled badges survive as "knobs".
            if box_area < img_area * 0.0015 and max(bw, bh) < 24:
                d["type"] = "led"
                d["confidence"] = max(0.30, d["confidence"] - 0.20)
                out.append(d)
                continue

            # ── Circularity gate ──
            # A real knob has a dominant circular contour inside its bbox.
            # If we can't fit a circle covering ≥55% of the bbox, the proposal
            # is probably a text block or rectangular panel part.
            x1c = max(0, int(bb[0])); y1c = max(0, int(bb[1]))
            x2c = min(w_img, int(bb[2])); y2c = min(h_img, int(bb[3]))
            roi = gray[y1c:y2c, x1c:x2c]
            if roi.size > 400:
                blur = cv2.GaussianBlur(roi, (5, 5), 1)
                r_min = int(min(bw, bh) * 0.30)
                r_max = int(max(bw, bh) * 0.60)
                if r_max > r_min >= 6:
                    circles = cv2.HoughCircles(
                        blur, cv2.HOUGH_GRADIENT, dp=1.2,
                        minDist=max(10, r_min),
                        param1=80, param2=18,
                        minRadius=r_min, maxRadius=r_max,
                    )
                    if circles is None:
                        # No circular structure → not a knob. Florence-2
                        # occasionally labels rectangular text blocks as
                        # knobs on dense panels; this is the last line of
                        # defense. Penalize rather than hard-drop so a
                        # genuine uniform-color knob (matte/flat finish,
                        # small at scale) isn't lost.
                        # Reduced from -0.15 / floor 0.22 to -0.10 / floor 0.18
                        # so matte/flat-finish knobs (Hough-unfriendly) survive.
                        d["confidence"] = d["confidence"] - 0.10
                        if d["confidence"] < 0.18:
                            continue

            # ── Reclassify only truly huge VU meters / gauges ──
            # Screen/meter extraction is no longer part of the focused detector.
            # Keep this safeguard only for very large circular gauges; otherwise
            # marked synth knobs with pointer lines get incorrectly dropped later
            # when output is filtered to knob/slider/LED.
            if box_area > img_area * 0.06:
                x1 = max(0, int(bb[0]))
                y1 = max(0, int(bb[1]))
                x2 = min(w_img, int(bb[2]))
                y2 = min(h_img, int(bb[3]))
                roi = gray[y1:y2, x1:x2]
                if roi.size > 100:
                    # Count internal edges — VU meters have many (scale lines)
                    blurred = cv2.GaussianBlur(roi, (3, 3), 1)
                    edges = cv2.Canny(blurred, 30, 100)
                    edge_density = float(np.count_nonzero(edges)) / max(roi.size, 1)

                    # Count line segments — meters have radiating lines
                    lines = cv2.HoughLinesP(edges, 1, math.pi / 180,
                                            threshold=12, minLineLength=int(min(bw, bh) * 0.12),
                                            maxLineGap=5)
                    n_lines = 0 if lines is None else len(lines)

                    # A very large circular region is almost certainly a display
                    # regardless of its internal line count (oscilloscopes have
                    # curved waveform edges, not straight HoughLinesP lines).
                    aspect = bw / max(bh, 1)
                    very_large_circular = (box_area > img_area * 0.015
                                           and 0.55 < aspect < 1.82
                                           and edge_density > 0.04)
                    # High edge density + several lines = meter/display
                    # Use canonical "screen" type so it appears in the frontend count
                    if very_large_circular or (edge_density > 0.10 and n_lines > 5):
                        d["type"] = "screen"
                        d["confidence"] = min(0.88, d["confidence"])
                        out.append(d)
                        continue

        out.append(d)

    # ── Detect horizontal scale bars as sliders ──
    # Look for wide, short regions with repeating vertical tick marks
    # These are the "0 25 50 75 100%" horizontal parameter displays
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    # Find bright horizontal bars on dark background
    bright_mask = (val > 140) & (sat < 80)  # bright, low-saturation = scale marks
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 1))
    h_open = cv2.morphologyEx(bright_mask.astype(np.uint8) * 255,
                              cv2.MORPH_CLOSE, h_kernel, iterations=1)
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 5))
    h_open = cv2.morphologyEx(h_open, cv2.MORPH_OPEN, v_kernel, iterations=1)
    contours, _ = cv2.findContours(h_open, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        if cw < 60 or ch < 8 or ch > 40:
            continue
        aspect = cw / max(ch, 1)
        if aspect < 3.0:
            continue
        box_area = cw * ch
        if box_area < 500 or box_area > img_area * 0.02:
            continue
        # Check for tick marks (short vertical lines in the region)
        roi_edges = cv2.Canny(gray[y:y+ch, x:x+cw], 40, 120)
        tick_lines = cv2.HoughLinesP(roi_edges, 1, math.pi / 180,
                                     threshold=8, minLineLength=int(ch * 0.4),
                                     maxLineGap=3)
        n_ticks = 0 if tick_lines is None else len(tick_lines)
        if n_ticks >= 3:
            # Check not already detected
            new_bb = [float(x), float(y), float(x + cw), float(y + ch)]
            already = False
            for d in out:
                if _iou(new_bb, d["bbox"]) > 0.3:
                    already = True
                    break
            if not already:
                out.append({
                    "type": "slider",
                    "bbox": new_bb,
                    "confidence": 0.70,
                    "source": "heuristic",
                    "phrase": None,
                })

    return out


def _refine_round_control_type(
    current_type: str,
    bbox: List[float],
    img_bgr: np.ndarray,
    gray: np.ndarray,
) -> str:
    """Reclassify small round AI detections using color, size and ring texture."""
    h_img, w_img = gray.shape[:2]
    x1 = max(0, int(bbox[0])); y1 = max(0, int(bbox[1]))
    x2 = min(w_img, int(bbox[2])); y2 = min(h_img, int(bbox[3]))
    bw = x2 - x1; bh = y2 - y1
    if bw < 6 or bh < 6:
        return current_type
    aspect = bw / max(bh, 1)
    if not (0.55 <= aspect <= 1.85):
        return current_type

    area_frac = (bw * bh) / max(1, w_img * h_img)
    roi_bgr = img_bgr[y1:y2, x1:x2]
    roi_gray = gray[y1:y2, x1:x2]
    if roi_bgr.size == 0 or roi_gray.size == 0:
        return current_type

    yy, xx = np.ogrid[:bh, :bw]
    cx, cy = bw / 2.0, bh / 2.0
    r = min(bw, bh) / 2.0
    disk = (xx - cx) ** 2 + (yy - cy) ** 2 <= (0.82 * r) ** 2
    if not disk.any():
        return current_type

    hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)
    sat_mean = float(np.mean(hsv[:, :, 1][disk]))
    val_mean = float(np.mean(hsv[:, :, 2][disk]))
    gray_std = float(np.std(roi_gray[disk]))

    if area_frac < 0.0018 and sat_mean > 45 and val_mean > 70:
        return "led"

    if current_type == "knob" and area_frac < 0.003:
        edges = cv2.Canny(cv2.GaussianBlur(roi_gray, (5, 5), 1), 25, 100)
        ring_hits = 0
        for frac in (0.45, 0.70, 0.92):
            inner = max(1, int(r * (frac - 0.06)))
            outer = max(inner + 1, int(r * (frac + 0.06)))
            ring = ((xx - cx) ** 2 + (yy - cy) ** 2 >= inner * inner) & \
                   ((xx - cx) ** 2 + (yy - cy) ** 2 <= outer * outer)
            if ring.any():
                density = float(np.count_nonzero(edges[ring])) / max(1, int(ring.sum()))
                if density > 0.08:
                    ring_hits += 1
        if ring_hits < 2 and gray_std < 42:
            return "button"

    return current_type


def _cross_source_boost(dets: List[Dict[str, Any]], iou_thr: float = 0.30) -> List[Dict[str, Any]]:
    """Boost confidence for detections confirmed by multiple sources.

    When YOLO and CV heuristics both find an element in the same region,
    it's likely a real UI element. Boost the higher-confidence one and
    mark the lower one for removal.
    """
    if len(dets) < 2:
        return dets

    sources = set(d.get("source", "") for d in dets)
    if len(sources) < 2:
        return dets  # Only one source, nothing to cross-validate

    boosted = set()
    remove = set()
    for i in range(len(dets)):
        for j in range(i + 1, len(dets)):
            if _source_family_name(dets[i].get("source")) == _source_family_name(dets[j].get("source")):
                continue
            iou_val = _iou(dets[i]["bbox"], dets[j]["bbox"])
            if iou_val < iou_thr:
                continue
            # Same region from different sources → boost the better one
            if dets[i]["confidence"] >= dets[j]["confidence"]:
                winner, loser = i, j
            else:
                winner, loser = j, i
            if winner not in boosted:
                dets[winner]["confidence"] = min(0.96, dets[winner]["confidence"] + 0.12)
                fused_sources = set(_flatten_detection_sources(dets[winner]))
                fused_sources.update(_flatten_detection_sources(dets[loser]))
                dets[winner]["sources"] = sorted(fused_sources)
                dets[winner]["source"] = "fused"
                boosted.add(winner)
            remove.add(loser)

    return [d for idx, d in enumerate(dets) if idx not in remove]


def _nms_per_type(dets: List[Dict[str, Any]], iou_thr: float = 0.5) -> List[Dict[str, Any]]:
    by_type: Dict[str, List[Dict[str, Any]]] = {}
    for d in dets:
        by_type.setdefault(d["type"], []).append(d)
    out: List[Dict[str, Any]] = []
    for type_dets in by_type.values():
        type_dets.sort(key=lambda d: d["confidence"], reverse=True)
        kept: List[Dict[str, Any]] = []
        for d in type_dets:
            bb = d["bbox"]
            cx = (bb[0] + bb[2]) * 0.5
            cy = (bb[1] + bb[3]) * 0.5
            bw = bb[2] - bb[0]
            bh = bb[3] - bb[1]
            dup = False
            for k in kept:
                # Standard IoU check
                if _iou(bb, k["bbox"]) >= iou_thr:
                    dup = True
                    break
                # Center-distance check: if centers are close relative to
                # the larger element's size, it's a concentric duplicate
                # (catches nested circles that have low IoU)
                kb = k["bbox"]
                kcx = (kb[0] + kb[2]) * 0.5
                kcy = (kb[1] + kb[3]) * 0.5
                kw = kb[2] - kb[0]
                kh = kb[3] - kb[1]
                dist = math.hypot(cx - kcx, cy - kcy)
                larger_r = max(bw, bh, kw, kh) * 0.5
                # 0.42 radii: suppresses only near-concentric duplicates.
                # Raised from 0.55 → 0.42 to avoid merging adjacent same-size knobs
                # on dense channel-strip rows where centres can be close.
                if larger_r > 0 and dist < larger_r * 0.42:
                    dup = True
                    break
            if not dup:
                kept.append(d)
        out.extend(kept)
    return out


def _global_nms(dets: List[Dict[str, Any]], iou_thr: float = 0.8) -> List[Dict[str, Any]]:
    # Prefer more specific types over generic "label" / "button" when overlapping heavily.
    priority = {"knob": 5, "slider": 5, "switch": 4, "screen": 4, "display": 4, "led": 3, "button": 2, "label": 1}
    dets.sort(key=lambda d: (priority.get(d["type"], 0), d["confidence"]), reverse=True)
    kept: List[Dict[str, Any]] = []
    for d in dets:
        bb = d["bbox"]
        cx = (bb[0] + bb[2]) * 0.5
        cy = (bb[1] + bb[3]) * 0.5
        bw = bb[2] - bb[0]
        bh = bb[3] - bb[1]
        dup = False
        for k in kept:
            if _iou(bb, k["bbox"]) >= iou_thr:
                dup = True
                break
            # Center-distance suppression across types too
            kb = k["bbox"]
            kcx = (kb[0] + kb[2]) * 0.5
            kcy = (kb[1] + kb[3]) * 0.5
            kw = kb[2] - kb[0]
            kh = kb[3] - kb[1]
            dist = math.hypot(cx - kcx, cy - kcy)
            larger_r = max(bw, bh, kw, kh) * 0.5
            # 0.30 radii: only suppress if centers are very close (same control).
            # At 0.50 adjacent knobs in a row were incorrectly merged.
            if larger_r > 0 and dist < larger_r * 0.30:
                dup = True
                break
        if not dup:
            kept.append(d)
    return kept


# Per-type aspect-ratio bounds (w/h). Anything outside is dropped.
# Intentionally generous — let the later NMS steps handle duplicates.
# Sliders: can be horizontal (wide) OR vertical (tall) — handled separately.
_ASPECT_BOUNDS: Dict[str, Tuple[float, float]] = {
    "knob":    (0.55, 1.82),   # real knobs ≈ square; allow some Florence drift
    "led":     (0.40, 2.50),   # LEDs vary more
    "button":  (0.20, 6.00),   # buttons come in all shapes
    "switch":  (0.20, 6.00),
    "screen":  (0.30, 8.00),
    "display": (0.30, 8.00),
}
# Sliders: handled separately (either orientation accepted if aspect > 1.8)
_SLIDER_MIN_ASPECT = 1.8   # w/h for horizontal OR h/w for vertical

# Minimum fraction of image diagonal for a detection to survive.
_MIN_SIZE_FRAC = 0.006   # relaxed: tiny LEDs on large panels
_MAX_SIZE_FRAC = 0.65


def _out_of_panel_filter(dets: List[Dict[str, Any]],
                         img_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """Drop detections whose centers fall outside the dominant panel rectangle.

    Works on both dark-on-bright and bright-on-dark panels by trying both
    polarities. Only applies when a clear panel boundary exists (the panel
    doesn't fill the entire frame). Skipped when the panel rect covers >80%
    of the image (e.g. full-screen screenshots where every pixel is panel).
    """
    h_img, w_img = img_bgr.shape[:2]
    img_area = h_img * w_img
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    # Mean brightness: helps choose the right polarity
    mean_lum = float(np.mean(gray))

    best_bbox: Optional[Tuple[int, int, int, int]] = None
    best_coverage = 0.0

    for thresh_val, polarity in [(30, cv2.THRESH_BINARY), (225, cv2.THRESH_BINARY_INV)]:
        _, thr = cv2.threshold(gray, thresh_val, 255, polarity)
        thr = cv2.morphologyEx(thr, cv2.MORPH_CLOSE,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (30, 30)))
        contours, _ = cv2.findContours(thr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        biggest = max(contours, key=cv2.contourArea)
        px, py, pw, ph = cv2.boundingRect(biggest)
        coverage = pw * ph / img_area
        if coverage > best_coverage:
            best_coverage = coverage
            best_bbox = (px, py, pw, ph)

    if best_bbox is None:
        return dets

    px, py, pw, ph = best_bbox
    # Skip if panel fills most of the frame — no meaningful background to clip.
    # Also skip if the detected "panel" is implausibly small.
    if best_coverage > 0.80 or best_coverage < 0.25:
        return dets

    # Prefer bright panels when image is bright overall (white bg plugin)
    # and dark panels otherwise.
    if mean_lum > 128:
        # Bright image → use dark foreground (the panel is the dark blob)
        _, thr2 = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)
        thr2 = cv2.morphologyEx(thr2, cv2.MORPH_CLOSE,
                                cv2.getStructuringElement(cv2.MORPH_RECT, (30, 30)))
        cnts2, _ = cv2.findContours(thr2, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cnts2:
            biggest2 = max(cnts2, key=cv2.contourArea)
            px, py, pw, ph = cv2.boundingRect(biggest2)
            cov2 = pw * ph / img_area
            if 0.25 <= cov2 <= 0.80:
                best_coverage = cov2

    if best_coverage > 0.80 or best_coverage < 0.25:
        return dets

    # 8% margin (up from 3%) so controls painted just outside the detected
    # panel rect (e.g. VU meters in a side column, buttons on the bezel edge)
    # are not dropped.
    margin = 0.08 * max(w_img, h_img)
    x_lo, y_lo = px - margin, py - margin
    x_hi, y_hi = px + pw + margin, py + ph + margin

    out = []
    dropped = 0
    for d in dets:
        bb = d["bbox"]
        cx = (bb[0] + bb[2]) * 0.5
        cy = (bb[1] + bb[3]) * 0.5
        if x_lo <= cx <= x_hi and y_lo <= cy <= y_hi:
            out.append(d)
        else:
            dropped += 1
    if dropped:
        logger.info(f"[FILTER] out-of-panel: dropped {dropped} detections "
                    f"(panel coverage={best_coverage:.0%})")
    return out


def _geometric_filter(dets: List[Dict[str, Any]],
                      img_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """Per-type aspect-ratio + size sanity gate.

    Much stricter than the global filter in _postprocess_detections:
    each type has its own aspect envelope. Dropped detections are logged.
    """
    h_img, w_img = img_bgr.shape[:2]
    img_diag = math.hypot(w_img, h_img)
    out = []
    drops = {"aspect": 0, "too_small": 0, "too_big": 0}
    for d in dets:
        bb = d["bbox"]
        bw = max(1.0, bb[2] - bb[0])
        bh = max(1.0, bb[3] - bb[1])
        diag = math.hypot(bw, bh) / max(img_diag, 1.0)
        if diag < _MIN_SIZE_FRAC:
            drops["too_small"] += 1
            continue
        if diag > _MAX_SIZE_FRAC:
            drops["too_big"] += 1
            continue
        aspect = bw / bh
        if d["type"] == "slider":
            # Accept horizontal (wide) OR vertical (tall) sliders
            is_horiz = aspect >= _SLIDER_MIN_ASPECT
            is_vert  = (1.0 / aspect) >= _SLIDER_MIN_ASPECT if aspect > 0 else False
            if not (is_horiz or is_vert):
                drops["aspect"] += 1
                continue
        else:
            lo, hi = _ASPECT_BOUNDS.get(d["type"], (0.0, 12.0))
            if not (lo <= aspect <= hi):
                drops["aspect"] += 1
                continue
        out.append(d)
    total_dropped = sum(drops.values())
    if total_dropped:
        logger.info(f"[FILTER] geometric: dropped {total_dropped} "
                    f"(aspect={drops['aspect']}, small={drops['too_small']}, "
                    f"big={drops['too_big']})")
    return out


def _containment_filter(dets: List[Dict[str, Any]],
                        containment_thr: float = 0.78) -> List[Dict[str, Any]]:
    """Suppress same-type detections where one fully contains the other.

    For each type, if bbox A contains ≥containment_thr of bbox B's area, keep
    only the higher-confidence one (prefer A unless B has ≥0.15 more conf).
    This catches: Florence emitting both the knob outline AND its metal cap,
    or LEDs double-detected as both a tiny circle and a surrounding socket.
    """
    by_type: Dict[str, List[Dict[str, Any]]] = {}
    for d in dets:
        by_type.setdefault(d["type"], []).append(d)
    out: List[Dict[str, Any]] = []
    dropped_total = 0
    for type_dets in by_type.values():
        # Sort largest first so outer boxes are "anchors".
        type_dets.sort(key=lambda d: (d["bbox"][2] - d["bbox"][0]) * (d["bbox"][3] - d["bbox"][1]),
                       reverse=True)
        kept: List[Dict[str, Any]] = []
        dropped_idx = set()
        for i, big in enumerate(type_dets):
            if i in dropped_idx:
                continue
            bbi = big["bbox"]
            big_area = max(1.0, (bbi[2] - bbi[0]) * (bbi[3] - bbi[1]))
            for j in range(i + 1, len(type_dets)):
                if j in dropped_idx:
                    continue
                small = type_dets[j]
                bbj = small["bbox"]
                # intersection over the SMALLER box (containment ratio)
                ix1, iy1 = max(bbi[0], bbj[0]), max(bbi[1], bbj[1])
                ix2, iy2 = min(bbi[2], bbj[2]), min(bbi[3], bbj[3])
                if ix2 <= ix1 or iy2 <= iy1:
                    continue
                inter = (ix2 - ix1) * (iy2 - iy1)
                small_area = max(1.0, (bbj[2] - bbj[0]) * (bbj[3] - bbj[1]))
                contain = inter / small_area
                if contain < containment_thr:
                    continue
                # big contains small. Pick the winner.
                if small["confidence"] >= big["confidence"] + 0.15:
                    # inner is much stronger → drop the outer
                    dropped_idx.add(i)
                    break
                else:
                    # outer wins
                    dropped_idx.add(j)
            if i not in dropped_idx:
                kept.append(big)
        dropped_total += len(type_dets) - len(kept)
        out.extend(kept)
    if dropped_total:
        logger.info(f"[FILTER] containment: dropped {dropped_total} nested boxes")
    return out


def _edge_contrast_filter(
    dets: List[Dict[str, Any]],
    img_bgr: np.ndarray,
    min_ring_contrast: float = 0.02,
) -> List[Dict[str, Any]]:
    """Drop circle-like detections that lack ANY edge ring vs their surroundings.

    Compares the edge density at the bbox perimeter ring (60-100% radius) to
    the density in a small surrounding annulus (110-145% radius, i.e. the
    immediate background). A real knob boundary has MORE edges than its bg;
    a texture blob has roughly the same density everywhere.

    The threshold is intentionally low (0.02) so that matte/smooth knobs are
    never dropped — we only cut truly edge-free blobs like plain colour patches.
    High-confidence Florence detections survive even if they fail the test.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    # Lower Canny thresholds to catch low-contrast edges (dark knob on white bg)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 1), 20, 80)
    h_img, w_img = gray.shape
    out = []
    dropped = 0
    for d in dets:
        if d.get("type") not in {"knob", "led"}:
            out.append(d)
            continue
        bb = d["bbox"]
        x1 = max(0, int(bb[0])); y1 = max(0, int(bb[1]))
        x2 = min(w_img, int(bb[2])); y2 = min(h_img, int(bb[3]))
        bw = x2 - x1; bh = y2 - y1
        if bw < 6 or bh < 6:
            out.append(d)
            continue
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        r = min(bw, bh) // 2
        if r < 3:
            out.append(d)
            continue

        # Expand ROI to include surrounding bg ring (×1.45 radius)
        pad = int(r * 0.5)
        rx1 = max(0, cx - r - pad); ry1 = max(0, cy - r - pad)
        rx2 = min(w_img, cx + r + pad); ry2 = min(h_img, cy + r + pad)
        roi_e = edges[ry1:ry2, rx1:rx2]
        if roi_e.size < 16:
            out.append(d)
            continue

        # Masks relative to ROI origin
        yy, xx = np.ogrid[ry1:ry2, rx1:rx2]
        dist2 = (xx - cx) ** 2 + (yy - cy) ** 2
        # Ring = 60–100 % of knob radius
        ring_mask = (dist2 >= (0.60 * r) ** 2) & (dist2 <= (r * 1.02) ** 2)
        # Background annulus = 110–145 % of radius
        bg_mask = (dist2 >= (1.10 * r) ** 2) & (dist2 <= (1.45 * r) ** 2)

        if roi_e.shape != ring_mask.shape:
            out.append(d)
            continue

        ring_vals = roi_e[ring_mask]
        bg_vals = roi_e[bg_mask]
        if ring_vals.size < 6 or bg_vals.size < 6:
            out.append(d)
            continue

        ring_density = float(np.count_nonzero(ring_vals)) / ring_vals.size
        bg_density   = float(np.count_nonzero(bg_vals))   / bg_vals.size
        # also check overall absolute ring density (uniform-colour regions have 0)
        abs_ok = ring_density > 0.01
        rel_ok = ring_density > bg_density + min_ring_contrast

        if not (abs_ok or rel_ok):
            # Only hard-drop low-confidence non-Florence detections.
            # Florence/Gemini detections (≥0.75) survive with a confidence dip.
            # Lowered from 0.70 → 0.60 so CV heuristic knobs at ~0.65 get a
            # penalty dip instead of being hard-dropped.
            if d["confidence"] >= 0.60:
                d["confidence"] = max(0.35, d["confidence"] - 0.10)
                out.append(d)
            else:
                dropped += 1
                continue
        else:
            out.append(d)
    if dropped:
        logger.info(f"[FILTER] edge-contrast: dropped {dropped} featureless knob/led proposals")
    return out


def _ocr_proximity_rerank(
    dets: List[Dict[str, Any]],
    labels: List[Dict[str, Any]],
    apply_to: set,
    radius_factor: float = 1.8,
    penalty: float = 0.18,
    drop_below: float = 0.28,
) -> List[Dict[str, Any]]:
    """Reduce confidence for controls with no nearby OCR label.

    Real knobs/sliders/buttons almost always have a label within ~1.5-2× their
    own radius. A detection with no nearby label is suspicious — penalise it,
    and drop it if confidence falls below drop_below.

    Screens, LEDs, labels themselves are never penalised (labels can stand
    alone; LEDs are often unlabeled; screens frequently have inline text).
    """
    if not labels:
        return dets
    # Precompute label centers
    lab_centers = [
        ((lb["bbox"][0] + lb["bbox"][2]) * 0.5,
         (lb["bbox"][1] + lb["bbox"][3]) * 0.5)
        for lb in labels
    ]
    out = []
    penalised = 0
    dropped = 0
    for d in dets:
        if d.get("type") not in apply_to:
            out.append(d)
            continue
        bb = d["bbox"]
        cx = (bb[0] + bb[2]) * 0.5
        cy = (bb[1] + bb[3]) * 0.5
        radius = max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5
        search = radius * radius_factor
        nearest = min(
            (math.hypot(cx - lcx, cy - lcy) for lcx, lcy in lab_centers),
            default=float("inf"),
        )
        if nearest > search:
            new_conf = d["confidence"] - penalty
            if new_conf < drop_below:
                dropped += 1
                continue
            d["confidence"] = new_conf
            d["_no_nearby_label"] = True
            penalised += 1
        out.append(d)
    if penalised or dropped:
        logger.info(f"[RERANK] OCR proximity: penalised={penalised} dropped={dropped}")
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 2: SEGMENTATION — tiered, parallel, downscaled
# ═══════════════════════════════════════════════════════════════════════════════

def _downscale_for_segment(img: np.ndarray) -> Tuple[np.ndarray, float]:
    """Downscale image to SEGMENT_MAX_DIM on the longest side.

    Returns (img_small, scale) where scale = new_dim / orig_dim.
    All bboxes must be multiplied by `scale` before passing to segmentation,
    and all returned masks must be upsampled by (orig_w, orig_h) afterwards.
    """
    h, w = img.shape[:2]
    max_dim = max(h, w)
    if max_dim <= SEGMENT_MAX_DIM:
        return img, 1.0
    scale = SEGMENT_MAX_DIM / max_dim
    nw, nh = int(w * scale), int(h * scale)
    return cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA), scale


def _snap_knob_circle(img_bgr: np.ndarray, bbox: List[float]) -> Optional[np.ndarray]:
    """Multi-pass geometric circle-snap for knobs and LEDs.  ~8 ms vs ~500 ms for SAM2.

    Improvements over single-pass HoughCircles:
    1. Three pre-processing variants (median blur, bilateral, CLAHE) to handle
       both high-contrast and low-contrast knob edges.
    2. Contour-based circle fitting as fallback when Hough fails — works on
       knurled/textured knobs that defeat Hough accumulator.
    3. Edge-aware mask refinement: instead of a hard circle, blends with actual
       edge contours for irregular knob shapes (skirts, bevels).
    4. Anti-aliased drawing via cv2.LINE_AA for smoother mask edges.

    Returns a uint8 0/255 mask at the SAME resolution as img_bgr.
    """
    h, w = img_bgr.shape[:2]
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    x1 = max(0, min(w - 1, x1))
    y1 = max(0, min(h - 1, y1))
    x2 = max(x1 + 2, min(w, x2))
    y2 = max(y1 + 2, min(h, y2))
    bw, bh = x2 - x1, y2 - y1
    roi = img_bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return None

    expected_r = (bw + bh) / 4.0
    # Wide radius range: AI bbox can be 15–25% larger than actual knob
    min_r = max(3, int(expected_r * 0.30))
    max_r = max(min_r + 2, int(expected_r * 1.35))

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    # ── Method 1: Multi-preprocessing HoughCircles ─────────────────────────
    best_circle = None
    best_score = 0.0

    # Prepare multiple preprocessed versions for robustness
    k = max(3, min(7, (bw // 8) | 1))
    # Adaptive Canny param1: lower for dark ROIs (dark panels, metallic knobs)
    roi_mean_val = float(np.mean(gray))
    adaptive_p1 = max(30, min(80, int(roi_mean_val * 0.45)))
    preps = [
        cv2.medianBlur(gray, k),  # good for speckle noise
        cv2.GaussianBlur(gray, (5, 5), 1.2),  # smooth edges
    ]
    # CLAHE for low-contrast knobs on dark panels
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
    preps.append(cv2.medianBlur(clahe.apply(gray), k))
    # Bilateral filter preserves edges better on textured knobs
    if min(bw, bh) > 20:
        preps.append(cv2.bilateralFilter(gray, 7, 50, 50))

    for prep in preps:
        for p2 in (20, 15, 10, 7):
            circles = cv2.HoughCircles(
                prep, cv2.HOUGH_GRADIENT, dp=1.0,
                minDist=max(bw, bh),
                param1=adaptive_p1, param2=p2,
                minRadius=min_r, maxRadius=max_r,
            )
            if circles is not None:
                for c in circles[0]:
                    cx_roi, cy_roi, r = c
                    # Score: prefer circles centered in bbox; radius near expected
                    center_dist = math.hypot(cx_roi - bw / 2, cy_roi - bh / 2)
                    center_score = max(0, 1.0 - center_dist / (expected_r + 1))
                    radius_score = max(0, 1.0 - abs(r - expected_r) / (expected_r + 1))
                    # Weight center heavier — off-center circles are usually wrong
                    score = center_score * 0.6 + radius_score * 0.4
                    if score > best_score:
                        best_score = score
                        best_circle = (cx_roi, cy_roi, r)
                if best_circle is not None:
                    break
        if best_circle is not None and best_score > 0.5:
            break

    # ── Method 2: Contour-based circle fitting (fallback for knurled knobs) ─
    if best_circle is None or best_score < 0.3:
        # Try two Canny thresholds: normal + gentle for dark/glossy knobs
        for c_lo, c_hi in ((30, 100), (15, 60)):
            blur_c = cv2.GaussianBlur(gray, (5, 5), 1.5)
            edges = cv2.Canny(blur_c, c_lo, c_hi)
            # Close small gaps in edge contours
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
            contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

            if contours:
                for cnt in contours:
                    if len(cnt) < 8:
                        continue
                    cnt_area = cv2.contourArea(cnt)
                    if cnt_area < (min_r ** 2) * 0.5:
                        continue
                    (cx_c, cy_c), r_c = cv2.minEnclosingCircle(cnt)
                    if r_c < min_r or r_c > max_r * 1.2:
                        continue
                    perimeter = cv2.arcLength(cnt, True)
                    if perimeter > 0:
                        circularity = 4 * math.pi * cnt_area / (perimeter ** 2)
                    else:
                        circularity = 0
                    circle_area = math.pi * r_c * r_c
                    coverage = cnt_area / max(circle_area, 1)
                    # Center bonus — prefer contours centered in bbox
                    cdist = math.hypot(cx_c - bw / 2, cy_c - bh / 2)
                    center_bonus = max(0, 1.0 - cdist / (expected_r + 1))
                    score = circularity * 0.45 + coverage * 0.30 + center_bonus * 0.25
                    if score > (best_score if best_circle else 0.28):
                        best_score = score
                        best_circle = (cx_c, cy_c, r_c)
            if best_circle is not None and best_score > 0.5:
                break

    # ── Draw mask ──────────────────────────────────────────────────────────
    mask = np.zeros((h, w), np.uint8)
    if best_circle is not None:
        cx_roi, cy_roi, r = best_circle
        # Snap radius slightly inward to avoid mask bleeding
        draw_r = max(1, int(r * 0.96 + 0.5))
        cv2.circle(
            mask,
            (int(x1 + cx_roi + 0.5), int(y1 + cy_roi + 0.5)),
            draw_r,
            255, -1, cv2.LINE_AA,
        )
    else:
        # Fallback: inscribed ellipse with anti-aliasing
        inset = max(1, int(min(bw, bh) * 0.04))
        cv2.ellipse(
            mask,
            ((x1 + x2) // 2, (y1 + y2) // 2),
            (max(1, bw // 2 - inset), max(1, bh // 2 - inset)),
            0, 0, 360, 255, -1, cv2.LINE_AA,
        )
    return mask


def _apply_mask_to_detection(
    d: Dict[str, Any],
    mask: Optional[np.ndarray],
    img_bgr: np.ndarray,
    refine_edges: bool = True,
) -> None:
    """Write mask_png, refined_bbox, circle, and contour_polygon into a detection
    dict in-place.

    contour_polygon is a list of [x, y] image-coordinate pairs that describe
    the exact boundary of the detected element (simplified to ≤120 points).
    It is stored for every non-trivial mask so the frontend can render
    accurate freeform outlines.

    When ``refine_edges`` is True the exported ``mask_png`` alpha is edge-refined
    (guided filter) for a soft, image-aware cut; all geometry below is still
    derived from the crisp binary ``mask``.
    """
    # Coordinate-space contract: the mask MUST be at the original image
    # resolution so the crop is cut from full-res pixels. Guard defensively —
    # a size mismatch means an upstream stage forgot to upscale.
    if mask is not None and mask.shape[:2] != img_bgr.shape[:2]:
        logger.warning(
            "mask resolution %s != image %s; resizing (upstream should cut at full res)",
            mask.shape[:2], img_bgr.shape[:2],
        )
        mask = cv2.resize(mask, (img_bgr.shape[1], img_bgr.shape[0]), interpolation=cv2.INTER_LINEAR)
        _, mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

    if mask is not None and mask.sum() > 0:
        ys, xs = np.where(mask > 127)
        if ys.size > 0 and xs.size > 0:
            mx1, my1, mx2, my2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
            d["refined_bbox"] = [mx1, my1, mx2 + 1, my2 + 1]

            # Store a cropped mask instead of a full-image mask. This avoids
            # encoding/transferring dozens of 2K–4K transparent PNGs per run.
            # Frontend consumers use mask_bbox to place the crop correctly.
            mask_crop = mask[my1:my2 + 1, mx1:mx2 + 1]
            if refine_edges:
                guide_crop = img_bgr[my1:my2 + 1, mx1:mx2 + 1]
                mask_crop = refine_mask_edges(mask_crop, guide_crop)
                d["edges_refined"] = True
            d["mask_png"] = _mask_to_png_b64(mask_crop)
            d["mask_bbox"] = [mx1, my1, mx2 + 1, my2 + 1]
        else:
            d["mask_png"] = None
            d["mask_bbox"] = None

        # ── Extract accurate contour polygon for freeform rendering ────────
        # Run findContours on the BBOX CROP, not the full-resolution mask.
        # On a 2532×1664 image, full-res findContours takes ~6 ms per element;
        # the ~150×150 crop takes ~0.2 ms — a 30× speedup across 69 elements.
        _bb_c = d.get("refined_bbox") or d["bbox"]
        cx1_c = max(0, int(_bb_c[0]))
        cy1_c = max(0, int(_bb_c[1]))
        cx2_c = min(mask.shape[1], int(_bb_c[2]) + 1)
        cy2_c = min(mask.shape[0], int(_bb_c[3]) + 1)
        _crop_mask = mask[cy1_c:cy2_c, cx1_c:cx2_c]
        contours, _ = cv2.findContours(_crop_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if contours:
            largest = max(contours, key=cv2.contourArea)
            cnt_area = cv2.contourArea(largest)
            perimeter = cv2.arcLength(largest, True)

            # Simplify contour to at most 120 points using Douglas-Peucker
            # epsilon = 0.5% of perimeter gives good quality for most shapes
            epsilon = max(1.0, perimeter * 0.005)
            approx = cv2.approxPolyDP(largest, epsilon, True)
            # Further reduce if still too many points
            if len(approx) > 120:
                epsilon2 = max(1.0, perimeter * 0.015)
                approx = cv2.approxPolyDP(largest, epsilon2, True)
            if len(approx) >= 3:
                # Offset contour points back to full-image coordinates
                d["contour_polygon"] = [
                    [int(p[0][0]) + cx1_c, int(p[0][1]) + cy1_c]
                    for p in approx
                ]

            if d["type"] in ("knob", "led"):
                (cx, cy), r = cv2.minEnclosingCircle(largest)
                d["circle"] = {"cx": float(cx + cx1_c), "cy": float(cy + cy1_c), "radius": float(r)}
            elif d["type"] in ("screen", "display"):
                # First try mask circularity
                mask_circular = False
                if perimeter > 0:
                    circularity = 4 * math.pi * cnt_area / (perimeter ** 2)
                    # Use a lower threshold for screens: GrabCut masks on circular
                    # bezels can be noisy while still being clearly round (0.55+).
                    circ_threshold = 0.55 if d["type"] in ("screen", "display") else 0.65
                    if circularity > circ_threshold:
                        (cx, cy), r = cv2.minEnclosingCircle(largest)
                        d["circle"] = {"cx": float(cx + cx1_c), "cy": float(cy + cy1_c), "radius": float(r)}
                        mask_circular = True

                # Fallback: try HoughCircles on the image ROI for circular screens
                # whose GrabCut mask may not be perfectly circular
                if not mask_circular:
                    bb = d.get("refined_bbox") or d["bbox"]
                    bw_bb = bb[2] - bb[0]
                    bh_bb = bb[3] - bb[1]
                    aspect_bb = bw_bb / max(bh_bb, 1)
                    # Only try HoughCircles for near-square bboxes —
                    # rectangular meters must NOT get a forced circle
                    if 0.68 < aspect_bb < 1.50:
                        x1b, y1b = max(0, int(bb[0])), max(0, int(bb[1]))
                        x2b, y2b = min(img_bgr.shape[1], int(bb[2])), min(img_bgr.shape[0], int(bb[3]))
                        roi_gray = cv2.cvtColor(img_bgr[y1b:y2b, x1b:x2b], cv2.COLOR_BGR2GRAY)
                        if roi_gray.size > 400:
                            roi_blur = cv2.GaussianBlur(roi_gray, (5, 5), 1.5)
                            expected_r = min(bw_bb, bh_bb) / 2.0
                            # r_min at 75% of expected: the circular bezel of a real
                            # round screen fills most of the bbox (~85-95%), while
                            # the arc needle inside a VU meter is only ~50-65%.
                            # This rejects VU meter arcs while catching oscilloscopes.
                            r_min = max(8, int(expected_r * 0.75))
                            r_max = max(r_min + 4, int(expected_r * 1.10))
                            roi_mean = float(np.mean(roi_gray))
                            p1 = max(30, min(90, int(roi_mean * 0.6)))
                            for p2 in (25, 18, 14):
                                hc = cv2.HoughCircles(
                                    roi_blur, cv2.HOUGH_GRADIENT, dp=1.2,
                                    minDist=max(10, r_min),
                                    param1=p1, param2=p2,
                                    minRadius=r_min, maxRadius=r_max,
                                )
                                if hc is not None:
                                    hcx, hcy, hr = hc[0][0]
                                    # Accept only if center is within 25% of
                                    # min(w,h) from bbox center — true round screens
                                    # are centered in their bbox.
                                    cx_expected = bw_bb / 2.0
                                    cy_expected = bh_bb / 2.0
                                    center_dist = math.hypot(hcx - cx_expected, hcy - cy_expected)
                                    if center_dist < min(bw_bb, bh_bb) * 0.25:
                                        d["circle"] = {
                                            "cx": float(x1b + hcx),
                                            "cy": float(y1b + hcy),
                                            "radius": float(hr),
                                        }
                                    break
    else:
        d["mask_png"] = None
        d["mask_bbox"] = None


def _grabcut_roi(img_bgr: np.ndarray, bbox: List[float]) -> Optional[np.ndarray]:
    """Fast GrabCut on a tight ROI crop — no SAM2, no full-image allocation.

    Works on a padded crop around the bbox (typically 50–200 px²), runs 2
    GrabCut iterations, then pastes the result back into a full-res mask.
    ~15-40 ms per element vs ~2-3 s for full-image GrabCut.
    """
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    h, w = img_bgr.shape[:2]
    x1 = max(0, min(w - 1, x1))
    y1 = max(0, min(h - 1, y1))
    x2 = max(x1 + 1, min(w, x2))
    y2 = max(y1 + 1, min(h, y2))
    bw, bh = x2 - x1, y2 - y1

    # Pad the crop by 25% of bbox size (GrabCut needs background context)
    pad = max(8, int(max(bw, bh) * 0.25))
    cx1 = max(0, x1 - pad)
    cy1 = max(0, y1 - pad)
    cx2 = min(w, x2 + pad)
    cy2 = min(h, y2 + pad)
    crop = img_bgr[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return None

    # Rect in crop-local coordinates
    local_x1 = x1 - cx1
    local_y1 = y1 - cy1
    local_w = bw
    local_h = bh
    if local_w < 2 or local_h < 2:
        return None

    try:
        crop_h, crop_w = crop.shape[:2]
        mask_crop = np.zeros((crop_h, crop_w), np.uint8)
        rect = (local_x1, local_y1, local_w, local_h)
        bgd = np.zeros((1, 65), np.float64)
        fgd = np.zeros((1, 65), np.float64)
        cv2.grabCut(crop, mask_crop, rect, bgd, fgd, 2, cv2.GC_INIT_WITH_RECT)
        binary_crop = np.where(
            (mask_crop == cv2.GC_FGD) | (mask_crop == cv2.GC_PR_FGD), 255, 0
        ).astype(np.uint8)

        # Paste back into full-res mask
        mask = np.zeros((h, w), np.uint8)
        mask[cy1:cy2, cx1:cx2] = binary_crop
        return mask
    except Exception:
        # Fall back to filled bbox
        mask = np.zeros((h, w), np.uint8)
        mask[y1:y2, x1:x2] = 255
        return mask


def _simple_shape_mask(img_bgr: np.ndarray, bbox: List[float], el_type: str) -> Optional[np.ndarray]:
    """Ultra-fast mask for small/simple elements (~1 ms).

    For buttons and switches: Otsu threshold on the ROI + largest contour.
    For other small elements: filled rounded-rect.
    """
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    h, w = img_bgr.shape[:2]
    x1 = max(0, min(w - 1, x1))
    y1 = max(0, min(h - 1, y1))
    x2 = max(x1 + 1, min(w, x2))
    y2 = max(y1 + 1, min(h, y2))
    bw, bh = x2 - x1, y2 - y1

    mask = np.zeros((h, w), np.uint8)

    if bw < 4 or bh < 4:
        mask[y1:y2, x1:x2] = 255
        return mask

    roi = img_bgr[y1:y2, x1:x2]
    gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    # Otsu threshold → largest contour
    _, binary = cv2.threshold(gray_roi, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Try both normal and inverted, pick the one with more area near center
    inv_binary = cv2.bitwise_not(binary)

    center_region = binary[bh // 4 : 3 * bh // 4, bw // 4 : 3 * bw // 4]
    inv_center = inv_binary[bh // 4 : 3 * bh // 4, bw // 4 : 3 * bw // 4]
    if center_region.size > 0 and inv_center.sum() > center_region.sum():
        binary = inv_binary

    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        largest = max(contours, key=cv2.contourArea)
        if cv2.contourArea(largest) > bw * bh * 0.15:
            roi_mask = np.zeros((bh, bw), np.uint8)
            cv2.drawContours(roi_mask, [largest], -1, 255, -1)
            mask[y1:y2, x1:x2] = roi_mask
            return mask

    # Fallback: filled rect
    mask[y1:y2, x1:x2] = 255
    return mask


def _segment_box(img_bgr: np.ndarray, bbox: List[float]) -> Optional[np.ndarray]:
    """Return a uint8 0/255 mask at the SAME resolution as img_bgr, or None.

    Tries SAM2 first; falls back to GrabCut.  Callers are responsible for
    any pre-downscaling / post-upscaling of the image and bbox.
    """
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    h, w = img_bgr.shape[:2]
    x1 = max(0, min(w - 1, x1))
    y1 = max(0, min(h - 1, y1))
    x2 = max(x1 + 1, min(w, x2))
    y2 = max(y1 + 1, min(h, y2))

    # Try SAM 2 via processor.segment_with_sam2
    if _sam_available():
        try:
            import processor
            rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
            bgra = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2BGRA)
            sam_out = processor.segment_with_sam2(rgb, bgra, [x1, y1, x2, y2])
            if sam_out is not None and "mask_u8" in sam_out:
                mask_u8 = sam_out["mask_u8"]
                if mask_u8.shape[:2] != (h, w):
                    # Bilinear + re-threshold, NOT nearest: nearest-upscaling a
                    # downscaled mask bakes in a blocky staircase edge (the halo).
                    mask_u8 = cv2.resize(mask_u8, (w, h), interpolation=cv2.INTER_LINEAR)
                    _, mask_u8 = cv2.threshold(mask_u8, 127, 255, cv2.THRESH_BINARY)
                return mask_u8
        except Exception as exc:
            logger.warning(f"SAM2 seg failed, falling back: {exc}")

    # Fallback: GrabCut on ROI crop
    return _grabcut_roi(img_bgr, bbox)


def _segment_all_grabcut(
    img_bgr: np.ndarray,
    detections: List[Dict[str, Any]],
    progress: Optional[ProgressCB] = None,
    batch_size: int = 5,
) -> None:
    """Parallel segmentation — no AI model, fast enough for 90+ elements.

    Strategy (three speed tiers, NO SAM2):
    - Knobs and LEDs:  Hough-circle geometric snap (~5 ms each)
    - Small buttons/switches/labels: Otsu threshold + contour (~1 ms each)
    - Larger/complex elements: GrabCut on ROI crop (~15-40 ms each)
    - Progress fires every `batch_size` completions for smooth UI updates.
    """
    total = len(detections)
    if total == 0:
        return

    h_orig, w_orig = img_bgr.shape[:2]

    # ── Tier A: geometric snap for round elements ──────────────────────────
    round_ids = {d["id"] for d in detections if d["type"] in ("knob", "led")}
    # Tier B: small/simple elements get threshold mask
    simple_types = {"button", "switch", "label", "text_field"}
    SIMPLE_AREA_LIMIT = 12000  # px² — below this, Otsu is good enough
    simple_ids = set()
    for d in detections:
        if d["id"] in round_ids:
            continue
        if d["type"] in simple_types:
            bw = d["bbox"][2] - d["bbox"][0]
            bh = d["bbox"][3] - d["bbox"][1]
            if bw * bh < SIMPLE_AREA_LIMIT:
                simple_ids.add(d["id"])

    completed = 0
    _lock = threading.Lock()

    def _tick() -> None:
        nonlocal completed
        completed += 1
        if progress and (completed % batch_size == 0 or completed >= total):
            pct = 30 + int(25 * completed / total)
            progress("segment", pct, f"Segmenting {completed}/{total}")

    # Tier A: geometric circle snap (~5 ms each)
    for d in detections:
        if d["id"] in round_ids:
            mask = _snap_knob_circle(img_bgr, d["bbox"])
            _apply_mask_to_detection(d, mask, img_bgr)
            _tick()

    # Tier B: simple threshold masks (~1 ms each)
    for d in detections:
        if d["id"] in simple_ids:
            mask = _simple_shape_mask(img_bgr, d["bbox"], d["type"])
            _apply_mask_to_detection(d, mask, img_bgr)
            _tick()

    # ── Tier C: parallel ROI GrabCut for complex elements ──────────────────
    complex_dets = [d for d in detections
                    if d["id"] not in round_ids and d["id"] not in simple_ids]
    if not complex_dets:
        if progress:
            progress("segment", 55, f"Segmented {total}/{total}")
        return

    n_workers = max(2, min(8, runtime.get_runtime().threads))
    id_to_det: Dict[str, Dict[str, Any]] = {d["id"]: d for d in complex_dets}

    def _grabcut_one(d: Dict[str, Any]) -> Tuple[str, Optional[np.ndarray]]:
        try:
            m = _grabcut_roi(img_bgr, d["bbox"])
        except Exception:
            m = None
        return d["id"], m

    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futures = {pool.submit(_grabcut_one, d): d for d in complex_dets}
        for fut in as_completed(futures):
            det_id, mask = fut.result()
            _apply_mask_to_detection(id_to_det[det_id], mask, img_bgr)
            with _lock:
                _tick()


def segment_all(
    img_bgr: np.ndarray,
    detections: List[Dict[str, Any]],
    progress: Optional[ProgressCB] = None,
    batch_size: int = 5,
) -> None:
    """Tiered segmentation: route each detection to the fastest strategy.

    Tier 1 — Knob / LED  → Hough-circle geometric snap  (~5 ms each, no AI)
    Tier 2 — Screen / Slider → SAM2 batch on ≤1024px image  (1 ViT encode
                               for all N boxes — the cheapest per-element cost)
    Tier 3 — Button / Switch / other → parallel GrabCut on ≤1024px image
                               (4–8 threads, fully independent per element)

    All heavy work operates on a downscaled copy; masks are upsampled back to
    original resolution.  Progress fires every `batch_size` completed elements.
    """
    total = len(detections)
    if total == 0:
        return

    if progress:
        progress("segment", 30, f"Segmenting {total} controls (parallel optimized)")

    h_orig, w_orig = img_bgr.shape[:2]
    img_small, scale = _downscale_for_segment(img_bgr)
    log_scale = f"{w_orig}×{h_orig}→{img_small.shape[1]}×{img_small.shape[0]}" if scale < 1.0 else "native"
    logger.info(f"[OPTIM] Segment downscale: {log_scale} (scale={scale:.3f})")

    _lock = threading.Lock()
    _done = [0]

    def _emit_progress() -> None:
        done = _done[0]
        if progress and (done % batch_size == 0 or done >= total):
            pct = 30 + int(25 * done / total)
            progress("segment", pct, f"Segmenting {done}/{total}")

    # ── Tier 1: Geometric snap (knob, led) — ~5 ms each ───────────────────
    tier1 = [d for d in detections if d["type"] in ("knob", "led")]
    for d in tier1:
        mask = _snap_knob_circle(img_bgr, d["bbox"])
        _apply_mask_to_detection(d, mask, img_bgr)
        with _lock:
            _done[0] += 1
            _emit_progress()

    # ── Tier 2: SAM2 batch for complex shapes (screen, slider) ───────────
    tier2 = [d for d in detections if d["type"] in ("screen", "slider")]
    tier3 = [d for d in detections if d["type"] not in ("knob", "led", "screen", "slider")]

    if tier2:
        try:
            import processor as _proc
            rgb_s = cv2.cvtColor(img_small, cv2.COLOR_BGR2RGB)
            bgra_s = cv2.cvtColor(img_small, cv2.COLOR_BGR2BGRA)
            boxes_s = [[v * scale for v in d["bbox"]] for d in tier2]

            def _sam_cb(i: int, n: int) -> None:
                with _lock:
                    # SAM2 fires per-box; interpolate _done proportionally
                    pass  # progress handled after the batch completes

            masks_s = _proc.segment_boxes_batch(rgb_s, bgra_s, boxes_s, progress_cb=_sam_cb)
            for d, m_s in zip(tier2, masks_s):
                if m_s is not None and m_s.sum() > 0:
                    # Bilinear + re-threshold (not nearest) to avoid a blocky
                    # staircase edge when upscaling the ≤1024px SAM mask back to
                    # full res; the guided-filter pass then snaps it to the
                    # original-image structure. The crop is always cut full-res.
                    m = cv2.resize(m_s, (w_orig, h_orig), interpolation=cv2.INTER_LINEAR)
                    _, m = cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)
                else:
                    m = None
                _apply_mask_to_detection(d, m, img_bgr)
                with _lock:
                    _done[0] += 1
                    _emit_progress()
        except Exception as exc:
            logger.warning(f"SAM2 batch failed ({exc}); routing tier2 to GrabCut")
            tier3 = tier2 + tier3  # fallthrough to parallel GrabCut

    # ── Tier 3: Parallel GrabCut (button, switch, and SAM2 fallbacks) ─────
    if tier3:
        n_workers = max(2, min(8, runtime.get_runtime().threads))
        id_to_det: Dict[str, Dict[str, Any]] = {d["id"]: d for d in tier3}

        # Use simple masks for small buttons/labels, ROI GrabCut for the rest
        simple_types = {"button", "switch", "label", "text_field"}
        SIMPLE_AREA_LIMIT = 12000

        def _fast_mask_one(d: Dict[str, Any]) -> Tuple[str, Optional[np.ndarray]]:
            bw = d["bbox"][2] - d["bbox"][0]
            bh = d["bbox"][3] - d["bbox"][1]
            try:
                if d["type"] in simple_types and bw * bh < SIMPLE_AREA_LIMIT:
                    m = _simple_shape_mask(img_bgr, d["bbox"], d["type"])
                else:
                    m = _grabcut_roi(img_bgr, d["bbox"])
            except Exception:
                m = None
            return d["id"], m

        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            futures = {pool.submit(_fast_mask_one, d): d for d in tier3}
            for fut in as_completed(futures):
                det_id, mask = fut.result()
                _apply_mask_to_detection(id_to_det[det_id], mask, img_bgr)
                with _lock:
                    _done[0] += 1
                    _emit_progress()


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 3: OCR (RapidOCR)
# ═══════════════════════════════════════════════════════════════════════════════

def ocr_labels(img_bgr: np.ndarray, progress: Optional[ProgressCB] = None) -> List[Dict[str, Any]]:
    """Return list of {id, text, bbox, center, confidence}."""
    if progress:
        progress("ocr", 60, "Reading text labels")
    engine = _load_ocr()
    if engine is None:
        return []
    try:
        h_orig, w_orig = img_bgr.shape[:2]
        # Downscale for OCR — RapidOCR on a 2532×1664 image takes 15-20 s on CPU.
        # Scaling to ≤1024px while keeping aspect ratio gives ~6× speedup with
        # negligible quality loss (synth labels are typically ≥14px even at 1024px).
        OCR_MAX_DIM = 1024
        ocr_scale = min(1.0, OCR_MAX_DIM / max(h_orig, w_orig, 1))
        if ocr_scale < 1.0:
            ocr_img = cv2.resize(
                img_bgr,
                (int(w_orig * ocr_scale), int(h_orig * ocr_scale)),
                interpolation=cv2.INTER_AREA,
            )
        else:
            ocr_img = img_bgr
            ocr_scale = 1.0
        rgb = cv2.cvtColor(ocr_img, cv2.COLOR_BGR2RGB)
        result, _elapsed = engine(rgb)
        if not result:
            return []
        inv_scale = 1.0 / ocr_scale
        labels: List[Dict[str, Any]] = []
        for poly, text, conf in result:
            if not text or not text.strip():
                continue
            # Scale coordinates back to original resolution
            xs = [p[0] * inv_scale for p in poly]
            ys = [p[1] * inv_scale for p in poly]
            x1, y1, x2, y2 = float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))
            labels.append({
                "id": "txt_" + uuid.uuid4().hex[:6],
                "text": text.strip(),
                "bbox": [x1, y1, x2, y2],
                "center": [(x1 + x2) * 0.5, (y1 + y2) * 0.5],
                "confidence": float(conf),
            })
        return labels
    except Exception as exc:
        logger.warning(f"OCR failed: {exc}")
        return []


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 4: FEATURE-SPECIFIC EXTRACTION
# ═══════════════════════════════════════════════════════════════════════════════

def _extract_knob_angle(img_bgr: np.ndarray, det: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Multi-method polar-transform pointer detection inside the knob mask.

    Improvements over the single-pass approach:
    1. Three independent pointer detection channels (edge, intensity, gradient)
       are combined via weighted vote — much more robust to faint/thin pointers.
    2. Sub-pixel angle refinement via parabolic interpolation on the peak.
    3. Real dead-zone analysis in the bottom sector to estimate actual angular
       range instead of hardcoded ±135°.
    4. Pointer width estimation for rendering fidelity.
    5. Confidence score reflecting detection quality.
    """
    circle = det.get("circle")
    if not circle:
        return None
    cx, cy, r = circle["cx"], circle["cy"], circle["radius"]
    h, w = img_bgr.shape[:2]
    if r < 3:
        return None

    # ── Crop ROI around knob ───────────────────────────────────────────────
    r_int = int(r)
    pad = max(3, int(r * 0.15))  # small safety margin
    x0 = max(0, int(cx) - r_int - pad)
    y0 = max(0, int(cy) - r_int - pad)
    x1 = min(w, int(cx) + r_int + pad + 1)
    y1 = min(h, int(cy) + r_int + pad + 1)
    roi = img_bgr[y0:y1, x0:x1]
    if roi.size == 0:
        return None

    local_cx, local_cy = cx - x0, cy - y0

    # ── Build polar image (720 columns = 0.5° per pixel) ──────────────────
    polar_cols = min(720, max(360, r_int * 4))  # higher res for larger knobs
    polar_rows = max(8, int(r * 1.1))  # radial resolution
    polar = cv2.warpPolar(
        roi, (polar_cols, polar_rows),
        (local_cx, local_cy),
        r * 1.05,  # sample slightly beyond radius for pointer tips
        cv2.WARP_POLAR_LINEAR + cv2.INTER_LINEAR,
    )
    gray = cv2.cvtColor(polar, cv2.COLOR_BGR2GRAY).astype(np.float32)

    # Radial band for pointer search: 15%–92% of radius (wider for stubby pointers)
    r_lo = max(1, int(polar_rows * 0.15))
    r_hi = max(r_lo + 2, int(polar_rows * 0.92))
    ring = gray[r_lo:r_hi, :]
    if ring.size == 0:
        return None

    # ── Channel 1: Sobel edge strength (original method, refined) ──────────
    sobel_x = cv2.Sobel(ring, cv2.CV_32F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(ring, cv2.CV_32F, 0, 1, ksize=3)
    edge_mag = np.sqrt(sobel_x ** 2 + sobel_y ** 2)
    edge_strength = np.mean(edge_mag, axis=0)  # per-angle

    # ── Channel 2: Intensity deviation from ring mean ─────────────────────
    # The pointer is typically brighter or darker than the surrounding ring
    ring_mean = np.mean(ring, axis=0, keepdims=True)
    intensity_dev = np.mean(np.abs(ring - ring_mean), axis=0)

    # ── Channel 3: Radial gradient (pointer = strong radial feature) ──────
    radial_grad = np.abs(np.diff(ring.astype(np.float32), axis=0))
    if radial_grad.size > 0:
        radial_strength = np.mean(radial_grad, axis=0)
    else:
        radial_strength = np.zeros(polar_cols, dtype=np.float32)

    # ── Normalize and combine channels ─────────────────────────────────────
    def _norm(arr: np.ndarray) -> np.ndarray:
        mn, mx = arr.min(), arr.max()
        if mx - mn < 1e-6:
            return np.zeros_like(arr)
        return (arr - mn) / (mx - mn)

    combined = (
        0.40 * _norm(edge_strength) +
        0.35 * _norm(intensity_dev) +
        0.25 * _norm(radial_strength)
    )

    if combined.max() < 1e-6:
        return None

    # ── Sub-pixel peak via parabolic interpolation ─────────────────────────
    peak_col = int(np.argmax(combined))
    n = len(combined)
    # Parabolic fit on 3 neighbours (circular wrap)
    y_m1 = combined[(peak_col - 1) % n]
    y_0 = combined[peak_col]
    y_p1 = combined[(peak_col + 1) % n]
    denom = 2.0 * (2.0 * y_0 - y_m1 - y_p1)
    if abs(denom) > 1e-8:
        delta = (y_m1 - y_p1) / denom
    else:
        delta = 0.0
    refined_col = peak_col + max(-0.5, min(0.5, delta))

    # Convert polar column to compass angle (0° = 12 o'clock, CW positive)
    deg_per_col = 360.0 / polar_cols
    raw_angle = refined_col * deg_per_col
    pointer_angle = ((raw_angle - 270.0) % 360.0)  # shift: col 0 = 3 o'clock → 0=up
    if pointer_angle > 180.0:
        pointer_angle -= 360.0

    # ── Pointer detection confidence ───────────────────────────────────────
    # How much does the peak stand out from the median?
    median_val = float(np.median(combined))
    peak_val = float(combined[peak_col])
    if median_val > 1e-6:
        snr = (peak_val - median_val) / median_val
    else:
        snr = peak_val * 10.0
    pointer_confidence = float(min(1.0, max(0.0, snr / 3.0)))
    has_pointer = pointer_confidence > 0.15

    # ── Pointer width estimation (in degrees) ──────────────────────────────
    if has_pointer:
        threshold = median_val + 0.4 * (peak_val - median_val)
        above = combined > threshold
        # Find contiguous run around peak
        left = peak_col
        right = peak_col
        for i in range(1, n // 4):
            if above[(peak_col - i) % n]:
                left = (peak_col - i) % n
            else:
                break
        for i in range(1, n // 4):
            if above[(peak_col + i) % n]:
                right = (peak_col + i) % n
            else:
                break
        width_cols = ((right - left) % n) + 1
        pointer_width_deg = float(width_cols * deg_per_col)
    else:
        pointer_width_deg = 0.0

    # ── Dead-zone analysis for angular range ───────────────────────────────
    # The "dead zone" is the bottom sector with uniform appearance (no
    # detents, no markings). Analyse edge density around the circumference
    # at 80-95% radius (the marking ring).
    mark_band = gray[max(1, int(polar_rows * 0.75)):int(polar_rows * 0.95), :]
    if mark_band.size > 0:
        # Edge density per angle
        mark_edges = cv2.Canny(mark_band.astype(np.uint8), 30, 90)
        edge_density = np.mean(mark_edges > 0, axis=0).astype(np.float32)

        # Smooth to find broad dead zone (narrower kernel than before to avoid bleed)
        kernel_sz = max(3, polar_cols // 24) | 1
        smoothed = cv2.GaussianBlur(
            edge_density.reshape(1, -1), (kernel_sz, 1), 0
        ).flatten()

        # Dead zone = contiguous arc with density < 30% of mean
        mean_density = float(np.mean(smoothed))
        if mean_density > 0.005:
            dead_mask = smoothed < mean_density * 0.30
        else:
            dead_mask = smoothed < 0.002

        # Find the longest contiguous dead run near the bottom (col ~polar_cols*3/4 = 270° = bottom)
        bottom_col = (polar_cols * 3) // 4  # 270° in polar = bottom of knob
        # Circular scan from bottom
        best_run = 0
        best_start = -1
        run_start = -1
        run_len = 0
        search_range = polar_cols  # full circle
        for i in range(search_range):
            col = (bottom_col - search_range // 2 + i) % polar_cols
            if dead_mask[col]:
                if run_start < 0:
                    run_start = col
                run_len += 1
            else:
                if run_len > best_run:
                    best_run = run_len
                    best_start = run_start
                run_start = -1
                run_len = 0
        if run_len > best_run:
            best_run = run_len
            best_start = run_start

        min_dead_cols = max(10, polar_cols // 18)  # at least ~20° dead zone
        if best_run >= min_dead_cols:
            dead_span_deg = best_run * deg_per_col
            half_dead = dead_span_deg / 2.0
            # Clamp to sane range: 20°–160° dead zone
            half_dead = max(10.0, min(80.0, half_dead))
            start_angle = -(180.0 - half_dead)
            end_angle = 180.0 - half_dead
        else:
            # No clear dead zone → full 360° rotation (encoder-style)
            # or default ±135° for standard pots
            start_angle = -135.0
            end_angle = 135.0
    else:
        start_angle = -135.0
        end_angle = 135.0

    # Normalize value based on detected angular range
    total_range = end_angle - start_angle
    if total_range > 0 and has_pointer:
        value_norm = (pointer_angle - start_angle) / total_range
        value_norm = float(max(0.0, min(1.0, value_norm)))
    else:
        value_norm = 0.5

    return {
        "pointer_angle_deg": round(float(pointer_angle), 1),
        "min_angle_deg": round(start_angle, 1),
        "max_angle_deg": round(end_angle, 1),
        "value_normalized": round(value_norm, 3),
        "has_pointer": has_pointer,
        "pointer_confidence": round(pointer_confidence, 3),
        "pointer_width_deg": round(pointer_width_deg, 1),
    }


def _extract_slider_travel(img_bgr: np.ndarray, det: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Multi-method fader/slider analysis: track detection, cap localization, travel.

    Improvements over the single brightness-profile approach:
    1. Edge-based rail detection via HoughLinesP for precise track orientation.
    2. Multi-channel cap detection: tries edge gradient, intensity contrast, and
       saturation contrast to find the fader thumb regardless of its brightness.
    3. Track type classification (recessed, raised, illuminated).
    4. Scale mark detection along the track.
    5. Sub-type inference (linear fader, crossfader, etc.) from aspect + context.
    """
    x1, y1, x2, y2 = det.get("refined_bbox", det["bbox"])
    x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
    h_img, w_img = img_bgr.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w_img, x2), min(h_img, y2)
    roi = img_bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return None
    bh, bw = roi.shape[:2]
    if bw < 6 or bh < 6:
        return None

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    # ── Orientation from aspect ratio + edge confirmation ──────────────────
    aspect = bw / max(bh, 1)
    vertical = bh > bw * 1.2  # slight hysteresis

    # ── Rail detection via Hough lines ─────────────────────────────────────
    blur = cv2.GaussianBlur(gray, (3, 3), 1)
    # Adaptive Canny based on ROI brightness
    roi_median = int(np.median(gray))
    canny_lo = max(20, int(roi_median * 0.33))
    canny_hi = max(canny_lo + 30, int(roi_median * 0.9))
    edges = cv2.Canny(blur, canny_lo, canny_hi)
    min_line_len = int(max(bw, bh) * 0.25)
    # Adaptive threshold: scale with the shorter dimension of the ROI
    hough_thresh = max(10, int(math.sqrt(min(bw, bh)) * 2.5))
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180,
        threshold=hough_thresh,
        minLineLength=max(8, min_line_len),
        maxLineGap=max(5, min(bw, bh) // 8),
    )

    rail_angle = 90.0 if vertical else 0.0
    rail_found = False
    rail_line = None

    if lines is not None and len(lines) > 0:
        best_len = 0
        for line in lines:
            lx1, ly1, lx2, ly2 = line[0]
            length = math.hypot(lx2 - lx1, ly2 - ly1)
            angle = math.degrees(math.atan2(ly2 - ly1, lx2 - lx1))
            aligned = False
            if vertical and abs(abs(angle) - 90) < 25:
                aligned = True
            elif not vertical and (abs(angle) < 25 or abs(abs(angle) - 180) < 25):
                aligned = True
            if aligned and length > best_len:
                best_len = length
                rail_line = (lx1, ly1, lx2, ly2)
                rail_angle = angle
                rail_found = True

    # ── Multi-channel cap/thumb detection ──────────────────────────────────
    # The fader cap is the movable thumb — it differs from the track in
    # intensity, saturation, or edge density along the travel axis.

    if vertical:
        # Profile along Y axis (each row is one position)
        profile_axis = 0  # mean across columns for each row
        travel_len = bh
    else:
        profile_axis = 1  # mean across rows for each column
        travel_len = bw

    # Channel 1: Intensity gradient (original method, improved)
    intensity_profile = np.mean(gray.astype(np.float32), axis=1 if vertical else 0)

    # Channel 2: Edge density profile — cap has more edges (ridges, texture)
    edge_profile = np.mean(edges.astype(np.float32), axis=1 if vertical else 0)

    # Channel 3: Saturation — caps are often a different color than the track
    # Use adaptive weighting: suppress this channel on low-saturation (grayscale) panels
    sat_channel = hsv[:, :, 1].astype(np.float32)
    sat_profile = np.mean(sat_channel, axis=1 if vertical else 0)
    global_mean_sat = float(np.mean(sat_channel))
    sat_weight = min(0.25, global_mean_sat / 120.0)  # 0–0.25 depending on panel saturation

    # Channel 4: Variance across the travel axis — cap is wider/different
    if vertical:
        var_profile = np.var(gray.astype(np.float32), axis=1)
    else:
        var_profile = np.var(gray.astype(np.float32), axis=0)

    # Channel 5: Morphological cap detection — find the region that differs
    # most from its local neighborhood (the cap stands out from the track)
    blur_morph = cv2.GaussianBlur(gray, (5, 5), 1.5)
    # Local average along travel axis
    morph_k = max(3, travel_len // 6) | 1
    if vertical:
        local_bg = cv2.blur(blur_morph, (bw, morph_k))
    else:
        local_bg = cv2.blur(blur_morph, (morph_k, bh))
    diff_from_bg = np.abs(blur_morph.astype(np.float32) - local_bg.astype(np.float32))
    bg_diff_profile = np.mean(diff_from_bg, axis=1 if vertical else 0)

    # Combine with gradient-of-profiles (where the cap boundaries are)
    def _profile_score(prof: np.ndarray) -> np.ndarray:
        if prof.size < 3:
            return prof
        grad = np.abs(np.gradient(prof))
        # Smooth to avoid noise spikes
        k = max(3, len(prof) // 15) | 1
        smoothed = cv2.GaussianBlur(grad.reshape(1, -1).astype(np.float32),
                                    (k, 1), 0).flatten()
        return smoothed

    def _norm(arr: np.ndarray) -> np.ndarray:
        mn, mx = arr.min(), arr.max()
        if mx - mn < 1e-6:
            return np.zeros_like(arr)
        return (arr - mn) / (mx - mn)

    # Redistribute weights: intensity + edge get more when saturation is weak
    remaining_w = 0.95 - sat_weight
    int_w = remaining_w * 0.33
    edge_w = remaining_w * 0.33
    bg_w = remaining_w * 0.22
    var_w = remaining_w * 0.12

    combined_score = (
        int_w * _norm(_profile_score(intensity_profile)) +
        edge_w * _norm(_profile_score(edge_profile)) +
        sat_weight * _norm(_profile_score(sat_profile)) +
        var_w * _norm(_profile_score(var_profile)) +
        bg_w * _norm(bg_diff_profile)
    )

    # Also build a direct (non-gradient) profile to find the cap region itself
    direct_score = (
        0.35 * _norm(bg_diff_profile) +
        0.30 * _norm(edge_profile) +
        0.20 * _norm(np.abs(intensity_profile - np.median(intensity_profile))) +
        0.15 * _norm(var_profile)
    )

    if combined_score.size == 0:
        cap_pos = travel_len // 2
    else:
        # Use the direct score to find the cap region, refined by gradient score
        # Smooth the direct score to find robust peak
        dk = max(3, len(direct_score) // 12) | 1
        direct_smooth = cv2.GaussianBlur(
            direct_score.reshape(1, -1).astype(np.float32), (dk, 1), 0
        ).flatten()
        # Find top-3 peaks in direct score and pick the one closest to a
        # gradient transition (combined_score peak)
        _ds = direct_smooth.copy()
        candidates = []
        for _ in range(3):
            pk = int(np.argmax(_ds))
            candidates.append((pk, float(_ds[pk])))
            # Suppress neighbourhood
            sup_lo = max(0, pk - len(_ds) // 8)
            sup_hi = min(len(_ds), pk + len(_ds) // 8 + 1)
            _ds[sup_lo:sup_hi] = 0
        # Score each candidate by combined transition strength nearby
        best_cap = candidates[0][0]
        best_cap_score = -1.0
        for pk, pk_val in candidates:
            if pk_val < 0.1:
                continue
            # Look for gradient peaks within ±cap_expected_size of this candidate
            window = max(5, travel_len // 8)
            lo = max(0, pk - window)
            hi = min(len(combined_score), pk + window + 1)
            local_grad = float(np.max(combined_score[lo:hi])) if lo < hi else 0.0
            score = pk_val * 0.6 + local_grad * 0.4
            if score > best_cap_score:
                best_cap_score = score
                best_cap = pk
        cap_pos = best_cap

    # ── Fader position normalization ───────────────────────────────────────
    if travel_len > 1:
        if vertical:
            # Vertical: top = max, bottom = min (convention)
            value_norm = 1.0 - (cap_pos / (travel_len - 1))
        else:
            value_norm = cap_pos / (travel_len - 1)
    else:
        value_norm = 0.5
    value_norm = float(max(0.0, min(1.0, value_norm)))

    # ── Cap size estimation ────────────────────────────────────────────────
    # Use direct_score (the cap region, not gradient) for size estimation
    if direct_smooth.size > 4:
        # Threshold at 40% of cap peak value for the cap extent
        cap_peak_val = float(direct_smooth[cap_pos]) if cap_pos < len(direct_smooth) else 0.0
        threshold = max(
            float(np.mean(direct_smooth) + 0.3 * np.std(direct_smooth)),
            cap_peak_val * 0.40,
        )
        above = direct_smooth > threshold
        # Find contiguous run around cap_pos
        cap_start = cap_pos
        cap_end = cap_pos
        for i in range(1, len(direct_smooth) // 3):
            if cap_pos - i >= 0 and above[cap_pos - i]:
                cap_start = cap_pos - i
            else:
                break
        for i in range(1, len(direct_smooth) // 3):
            if cap_pos + i < len(direct_smooth) and above[cap_pos + i]:
                cap_end = cap_pos + i
            else:
                break
        cap_size_px = cap_end - cap_start + 1
        # Sanity: cap shouldn't be more than 40% of travel
        cap_size_px = min(cap_size_px, travel_len * 2 // 5)
    else:
        cap_size_px = max(bw, bh) // 8

    # ── Track type classification ──────────────────────────────────────────
    # Check if track has colored/illuminated segments
    mean_sat = float(np.mean(hsv[:, :, 1]))
    mean_val = float(np.mean(hsv[:, :, 2]))
    if mean_sat > 80 and mean_val > 80:
        track_style = "led_illuminated"
    elif mean_val < 50:
        track_style = "recessed"
    else:
        track_style = "standard"

    # ── Sub-type inference ─────────────────────────────────────────────────
    if vertical and aspect < 0.5:
        sub_type = "linear_fader"
    elif not vertical and aspect > 2.5:
        sub_type = "crossfader"
    elif vertical:
        sub_type = "vertical_slider"
    else:
        sub_type = "horizontal_slider"

    # ── Scale marks detection ──────────────────────────────────────────────
    # Look for evenly-spaced horizontal (for vertical sliders) or vertical
    # (for horizontal sliders) edge clusters perpendicular to travel axis
    scale_marks = 0
    if travel_len > 30:
        if vertical:
            perp_edges = cv2.Sobel(blur, cv2.CV_32F, 1, 0, ksize=3)
        else:
            perp_edges = cv2.Sobel(blur, cv2.CV_32F, 0, 1, ksize=3)
        perp_profile = np.mean(np.abs(perp_edges), axis=1 if vertical else 0)
        if perp_profile.size > 5:
            # Count local maxima above threshold
            pp_smooth = cv2.GaussianBlur(
                perp_profile.reshape(1, -1).astype(np.float32),
                (max(3, len(perp_profile) // 20) | 1, 1), 0
            ).flatten()
            pp_thresh = float(np.mean(pp_smooth) + 1.5 * np.std(pp_smooth))
            peaks = []
            for i in range(1, len(pp_smooth) - 1):
                if pp_smooth[i] > pp_thresh and pp_smooth[i] > pp_smooth[i-1] and pp_smooth[i] > pp_smooth[i+1]:
                    peaks.append(i)
            scale_marks = len(peaks)

    # Build rail coordinates in image space
    if rail_line is not None:
        lx1, ly1, lx2, ly2 = rail_line
        rail_start = {"x": round(float(x1 + lx1), 1), "y": round(float(y1 + ly1), 1)}
        rail_end = {"x": round(float(x1 + lx2), 1), "y": round(float(y1 + ly2), 1)}
        travel_px = math.hypot(lx2 - lx1, ly2 - ly1)
    else:
        if vertical:
            mid_x = x1 + bw / 2
            rail_start = {"x": round(float(mid_x), 1), "y": round(float(y1), 1)}
            rail_end = {"x": round(float(mid_x), 1), "y": round(float(y2), 1)}
        else:
            mid_y = y1 + bh / 2
            rail_start = {"x": round(float(x1), 1), "y": round(float(mid_y), 1)}
            rail_end = {"x": round(float(x2), 1), "y": round(float(mid_y), 1)}
        travel_px = float(bh if vertical else bw)

    # ── Fader cap bounding box in image coordinates ────────────────────────
    # Compute the bbox of the movable thumb/cap so the frontend can render
    # it separately and generate frame sequences for animation.
    half_cap = max(1, cap_size_px // 2)
    if vertical:
        # cap_pos is a row index within the ROI; convert to full-image Y
        cap_cy_img = y1 + int(cap_pos)
        cap_cx_img = x1 + bw // 2
        cap_bbox = [
            int(x1),
            max(y1, cap_cy_img - half_cap),
            int(x2),
            min(y2, cap_cy_img + half_cap + 1),
        ]
    else:
        cap_cx_img = x1 + int(cap_pos)
        cap_cy_img = y1 + bh // 2
        cap_bbox = [
            max(x1, cap_cx_img - half_cap),
            int(y1),
            min(x2, cap_cx_img + half_cap + 1),
            int(y2),
        ]

    return {
        "orientation": "vertical" if vertical else "horizontal",
        "sub_type": sub_type,
        "travel_length_px": int(round(travel_px)),
        "fader_position_px": int(cap_pos),
        "value_normalized": round(value_norm, 3),
        "cap_size_px": int(cap_size_px),
        "cap_bbox": cap_bbox,
        "rail_start": rail_start,
        "rail_end": rail_end,
        "rail_angle_deg": round(float(rail_angle), 1),
        "rail_detected": rail_found,
        "track_style": track_style,
        "scale_marks_count": scale_marks,
    }


def _classify_screen(img_bgr: np.ndarray, det: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Crude screen classifier: scope vs meter vs digital."""
    x1, y1, x2, y2 = det.get("refined_bbox", det["bbox"])
    x1, y1, x2, y2 = map(int, (x1, y1, x2, y2))
    roi = img_bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return None
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    mean_hue = float(np.mean(hsv[..., 0]))
    mean_val = float(np.mean(hsv[..., 2]))
    edge_density = float(np.mean(cv2.Canny(cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY), 50, 150)) / 255.0)

    if mean_val < 70 and edge_density > 0.05:
        kind = "oscilloscope"
    elif edge_density > 0.08:
        kind = "vu_meter"
    else:
        kind = "digital_readout"

    result: Dict[str, Any] = {
        "screen_kind": kind,
        "edge_density": edge_density,
        "mean_brightness": mean_val,
        "mean_hue": mean_hue,
    }

    # For digital readouts, attempt OCR to extract the displayed value.
    if kind == "digital_readout":
        ocr = _load_ocr()
        if ocr is not None:
            try:
                h_roi, w_roi = roi.shape[:2]
                # Upscale small ROIs so OCR has enough resolution.
                scale_up = max(1, min(4, 80 // max(min(h_roi, w_roi), 1)))
                roi_up = cv2.resize(
                    roi, (w_roi * scale_up, h_roi * scale_up),
                    interpolation=cv2.INTER_CUBIC,
                ) if scale_up > 1 else roi
                ocr_result, _ = ocr(roi_up)
                if ocr_result:
                    texts = [item[1] for item in ocr_result if item and item[1]]
                    result["extracted_text"] = " ".join(texts).strip()
            except Exception as exc:
                logger.debug(f"Screen OCR failed: {exc}")

    return result


def extract_features(
    img_bgr: np.ndarray,
    detections: List[Dict[str, Any]],
    progress: Optional[ProgressCB] = None,
) -> None:
    """Extract per-type features for all detections with detailed logging."""
    if progress:
        progress("features", 70, "Extracting per-type features")
    knob_count = 0
    slider_count = 0
    screen_count = 0
    for d in detections:
        try:
            if d["type"] == "knob":
                f = _extract_knob_angle(img_bgr, d)
                if f:
                    d["features"] = f
                    knob_count += 1
                    if f.get("has_pointer"):
                        logger.debug(
                            f"  Knob {d.get('id')}: angle={f['pointer_angle_deg']:.1f}° "
                            f"range=[{f['min_angle_deg']:.0f}°,{f['max_angle_deg']:.0f}°] "
                            f"value={f['value_normalized']:.2f} "
                            f"conf={f.get('pointer_confidence', 0):.2f}"
                        )
            elif d["type"] == "slider":
                f = _extract_slider_travel(img_bgr, d)
                if f:
                    d["features"] = f
                    slider_count += 1
                    logger.debug(
                        f"  Slider {d.get('id')}: {f.get('sub_type', '?')} "
                        f"orient={f['orientation']} "
                        f"value={f['value_normalized']:.2f} "
                        f"travel={f.get('travel_length_px', 0)}px "
                        f"track={f.get('track_style', '?')}"
                    )
            elif d["type"] == "screen":
                f = _classify_screen(img_bgr, d)
                if f:
                    d["features"] = f
                    screen_count += 1
        except Exception as exc:
            logger.warning(f"Feature extraction failed for {d.get('id')}: {exc}")
    logger.info(
        f"[FEATURES] Extracted: {knob_count} knobs, "
        f"{slider_count} sliders, {screen_count} screens"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 5: SEMANTIC LINKING — label→control + section grouping
# ═══════════════════════════════════════════════════════════════════════════════

_ID_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify_param_id(text: str) -> str:
    s = _ID_SLUG_RE.sub("_", text.lower()).strip("_")
    if not s:
        return "param"
    if s[0].isdigit():
        s = "p_" + s
    return s[:48]


# Prompt phrases that strongly suggest section headers (all-caps, multi-word)
_SECTION_HINTS = {
    "osc", "oscillator", "filter", "amp", "envelope", "env", "lfo", "fx",
    "modulation", "mod", "master", "output", "voice", "effects", "reverb",
    "delay", "chorus", "compressor", "eq", "mixer", "sequencer", "arp",
    "sampler", "layer", "matrix", "pitch",
}


def _is_section_header(text: str) -> bool:
    t = text.strip()
    if not t:
        return False
    # Strong heuristic: all-caps, ≥3 chars, no digits mid-token, known synth keyword
    tokens = re.findall(r"[A-Za-z0-9]+", t)
    if not tokens:
        return False
    token_lower = [tok.lower() for tok in tokens]
    if any(tok in _SECTION_HINTS for tok in token_lower):
        if t.upper() == t and len(t) >= 3:
            return True
    # Also: ends with a digit ("OSCILLATOR 1", "LFO 2")
    if t.upper() == t and any(tok in _SECTION_HINTS for tok in token_lower) and len(t) >= 5:
        return True
    return False


def _link_labels_to_controls(
    controls: List[Dict[str, Any]],
    labels: List[Dict[str, Any]],
    img_w: int,
    img_h: int,
) -> None:
    """For every label, find the closest control within a spatial radius and link it.

    Prefers labels DIRECTLY ABOVE or BELOW the control over left/right.
    """
    if not controls or not labels:
        return
    img_diag = math.hypot(img_w, img_h)
    max_dist = 0.09 * img_diag  # ~9% of diagonal — very local

    # Index controls by id
    ctrl_map = {c["id"]: c for c in controls}

    for lab in labels:
        if lab.get("_is_section"):
            continue
        lx, ly = lab["center"]
        lw = lab["bbox"][2] - lab["bbox"][0]
        lh = lab["bbox"][3] - lab["bbox"][1]

        best_id: Optional[str] = None
        best_score = 1e9
        for c in controls:
            cx, cy = c["center"]
            cw = c["width"]
            ch = c["height"]
            dx = lx - cx
            dy = ly - cy
            dist = math.hypot(dx, dy)
            if dist > max_dist:
                continue
            # Prefer labels close-to-vertical-axis of the control:
            horiz_align = abs(dx) / max(cw * 0.8, 1.0)
            score = dist * (1.0 + 0.6 * horiz_align)
            # Small bonus when label is above/below and has plausible width vs control
            if abs(dx) < max(cw, lw) * 0.9:
                score *= 0.85
            if score < best_score:
                best_score = score
                best_id = c["id"]

        if best_id is not None:
            ctrl = ctrl_map[best_id]
            # A control can have one primary label; keep the highest-conf one.
            prev = ctrl.get("label")
            if prev is None or lab["confidence"] > prev.get("confidence", 0):
                ctrl["label"] = {
                    "id": lab["id"],
                    "text": lab["text"],
                    "confidence": lab["confidence"],
                }
                ctrl["parameter_id"] = _slugify_param_id(lab["text"])
                ctrl["display_name"] = lab["text"]
            lab["linked_control_id"] = best_id


def _group_into_sections(
    controls: List[Dict[str, Any]],
    labels: List[Dict[str, Any]],
    img_w: int,
    img_h: int,
) -> List[Dict[str, Any]]:
    """Assign controls to sections based on section-header labels.

    Each section = {id, name, bbox, control_ids, label_ids}.
    Controls are assigned to the nearest section header within a reasonable
    horizontal/vertical span; ungrouped controls fall into the 'global' section.
    """
    headers = [lab for lab in labels if lab.get("_is_section")]
    sections: List[Dict[str, Any]] = []
    assigned: Dict[str, str] = {}  # control_id -> section_id

    if headers:
        for h in headers:
            sections.append({
                "id": "sec_" + uuid.uuid4().hex[:6],
                "name": h["text"].title(),
                "raw_name": h["text"],
                "header_label_id": h["id"],
                "bbox": list(h["bbox"]),
                "control_ids": [],
                "label_ids": [h["id"]],
            })

        # Assign each control to its closest section header (weighted toward
        # "header is above the control" which is the convention for synths).
        for c in controls:
            cx, cy = c["center"]
            best_sec_idx = 0
            best_score = 1e18
            for i, sec in enumerate(sections):
                hb = sec["bbox"]
                hcx = (hb[0] + hb[2]) * 0.5
                hcy = (hb[1] + hb[3]) * 0.5
                dx = cx - hcx
                dy = cy - hcy
                # Heavy penalty if header is below the control
                below_penalty = 3.0 if hcy > cy + (c["height"] * 0.5) else 1.0
                score = math.hypot(dx, dy) * below_penalty
                if score < best_score:
                    best_score = score
                    best_sec_idx = i
            sections[best_sec_idx]["control_ids"].append(c["id"])
            assigned[c["id"]] = sections[best_sec_idx]["id"]

    # Anything not grouped → global section
    unassigned = [c["id"] for c in controls if c["id"] not in assigned]
    if unassigned or not sections:
        sections.append({
            "id": "sec_global",
            "name": "Global",
            "raw_name": "GLOBAL",
            "header_label_id": None,
            "bbox": [0.0, 0.0, float(img_w), float(img_h)],
            "control_ids": unassigned,
            "label_ids": [],
        })

    # Collect orphan labels (not headers, not linked) into the global section so they're visible.
    linked = {lab_id for sec in sections for lab_id in sec["label_ids"]}
    for lab in labels:
        if lab["id"] in linked:
            continue
        if lab.get("_is_section"):
            continue
        linked_ctrl = lab.get("linked_control_id")
        if linked_ctrl and linked_ctrl in assigned:
            sec_id = assigned[linked_ctrl]
            for s in sections:
                if s["id"] == sec_id:
                    s["label_ids"].append(lab["id"])
                    break
        else:
            sections[-1]["label_ids"].append(lab["id"])

    return sections


# ═══════════════════════════════════════════════════════════════════════════════
# MANUAL RE-SEGMENT (for UI bbox edits)
# ═══════════════════════════════════════════════════════════════════════════════

def resegment_one(
    image_b64: str,
    bbox: List[float],
    fast_mode: bool = True,
) -> Dict[str, Any]:
    """Re-run segmentation on a single user-edited bbox.

    Called by the UI after the user drags or resizes a control's bbox.
    Returns {mask_png, refined_bbox, circle} so the frontend can update
    the overlay without triggering a full pipeline re-run.

    Falls back gracefully: tries the Hough-circle snap first (fast, ideal
    for knobs/LEDs); if no circle is found it uses GrabCut.
    """
    img = _decode_image(image_b64)
    bbox_list = [float(v) for v in bbox]

    # Try geometric snap first — catches knobs & LEDs instantly.
    mask = _snap_knob_circle(img, bbox_list)
    if mask is None or mask.sum() == 0:
        # Fallback: GrabCut. SAM2 skipped here unless explicitly requested,
        # because this endpoint is latency-sensitive (user is waiting).
        try:
            mask = _grabcut_roi(img, bbox_list)
        except Exception as exc:
            logger.warning(f"resegment_one grabcut failed: {exc}")
            mask = None

    if mask is None or mask.sum() == 0:
        return {"mask_png": None, "refined_bbox": bbox_list, "circle": None}

    out: Dict[str, Any] = {"mask_png": None, "mask_bbox": None}
    ys, xs = np.where(mask > 127)
    if ys.size > 0 and xs.size > 0:
        mx1, my1 = int(xs.min()), int(ys.min())
        mx2, my2 = int(xs.max()), int(ys.max())
        out["refined_bbox"] = [mx1, my1, mx2 + 1, my2 + 1]
        out["mask_bbox"] = [mx1, my1, mx2 + 1, my2 + 1]
        out["mask_png"] = _mask_to_png_b64(mask[my1:my2 + 1, mx1:mx2 + 1])
    else:
        out["refined_bbox"] = bbox_list

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if contours:
        largest = max(contours, key=cv2.contourArea)
        (cx, cy), r = cv2.minEnclosingCircle(largest)
        out["circle"] = {"cx": float(cx), "cy": float(cy), "radius": float(r)}
    else:
        out["circle"] = None

    # fast_mode kept in the signature for future SAM2 routing on GPU
    _ = fast_mode
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_panel(
    image_b64: str,
    min_confidence: float = 0.40,
    detect_labels: bool = False,
    segment: bool = True,
    extract_features_flag: bool = True,
    fast_mode: bool = False,
    segment_batch_size: int = 5,
    detection_model: str = "auto",
    rectify_mode: str = "auto",
    progress_cb: Optional[ProgressCB] = None,
) -> Dict[str, Any]:
    """Full multi-stage semantic panel analysis.

    Parameters
    ----------
    fast_mode : bool
        When True (or on CPU), always uses the fast parallel path:
        geometric snap for knobs/LEDs + parallel GrabCut for other types.
        When False on a CUDA device, SAM2 batch is used for screens/sliders.
    segment_batch_size : int
        How many elements to complete before emitting a progress event.
        Lower = smoother progress bar; higher = fewer SSE events.
    rectify_mode : str
        Stage-0 dewarp control. "auto" = warp only when a confident perspective
        panel quad is found (no-op on flat mockups); "skip" = never warp;
        "force" = warp the detected quad if any. When a warp is applied, ALL
        downstream coordinates/masks live in RECTIFIED image space, and the
        rectified image is returned in ``rectification.image_b64`` so the
        frontend can adopt it as the working document (we deliberately do NOT
        map masks back through H⁻¹ — that would reintroduce resampling blur).
    """
    timer = PipelineTimer()

    if progress_cb:
        progress_cb("decode", 1, "Decoding image")
    img = _decode_image(image_b64)
    timer.mark("decode")

    # ── Stage 0: Rectification / dewarp (perspective photos of real hardware) ──
    # Safety-first: a no-op on flat mockups. When it fires, the rectified image
    # becomes the working document for every subsequent stage.
    rectification: Dict[str, Any] = {"applied": False, "reason": "disabled"}
    if rectify_mode != "skip":
        if progress_cb:
            progress_cb("rectify", 3, "Checking panel perspective")
        _force = {"auto": None, "force": True}.get(rectify_mode, None)
        try:
            _rect = rectify.rectify_panel(img, force=_force)
            rectification = _rect.to_dict()
            if _rect.applied:
                img = _rect.image
                # Hand the rectified pixels back so the UI can swap its canvas.
                ok, _buf = cv2.imencode(".png", img)
                if ok:
                    rectification["image_b64"] = (
                        "data:image/png;base64," + base64.b64encode(_buf.tobytes()).decode("ascii")
                    )
                if progress_cb:
                    progress_cb("rectify", 5, f"Rectified panel → {img.shape[1]}x{img.shape[0]}")
        except Exception as exc:  # never let dewarp break analysis
            logger.warning("rectify stage failed, continuing un-rectified: %s", exc)
            rectification = {"applied": False, "reason": f"error: {exc}"}
    timer.mark("rectify")

    h, w = img.shape[:2]

    # On CPU, always use the fast parallel path (SAM2 on CPU takes minutes).
    on_cpu = _detect_runtime_device() == "cpu"
    use_fast_path = fast_mode or on_cpu

    # Stage 1: Detection
    detections = detect_components(
        img,
        min_confidence=min_confidence,
        progress=progress_cb,
        detection_model=detection_model,
    )
    timer.mark("detect")

    # Stage 2: Segmentation
    if segment:
        if use_fast_path:
            if progress_cb:
                progress_cb("segment", 30, f"Segmenting {len(detections)} controls (parallel fast path)")
            _segment_all_grabcut(img, detections, progress=progress_cb, batch_size=segment_batch_size)
        else:
            segment_all(img, detections, progress=progress_cb, batch_size=segment_batch_size)
    timer.mark("segment")

    # Stage 3: OCR
    labels: List[Dict[str, Any]] = []
    if detect_labels:
        labels = ocr_labels(img, progress=progress_cb)
        # Flag section headers
        for lab in labels:
            if _is_section_header(lab["text"]):
                lab["_is_section"] = True

        # ── OCR-overlap suppression ──
        # Drop any non-label detection that is mostly covered by an OCR text
        # box. This kills the "48 knobs on labels" failure where Florence-2
        # wraps each parameter name as a knob/button. Only applied when OCR
        # finds a non-trivial number of labels so a clean panel without text
        # isn't affected.
        if len(labels) >= 3:
            suppress = set()
            for i, d in enumerate(detections):
                if d.get("type") == "label":
                    continue
                bb = d["bbox"]
                box_area = max(1.0, (bb[2] - bb[0]) * (bb[3] - bb[1]))
                for lab in labels:
                    lbb = lab["bbox"]  # [x1,y1,x2,y2]
                    # Intersection area
                    ix1 = max(bb[0], lbb[0]); iy1 = max(bb[1], lbb[1])
                    ix2 = min(bb[2], lbb[2]); iy2 = min(bb[3], lbb[3])
                    if ix2 <= ix1 or iy2 <= iy1:
                        continue
                    inter = (ix2 - ix1) * (iy2 - iy1)
                    # If the OCR label covers ≥75% of the detection box, the
                    # "control" is just the text itself.
                    # Raised from 0.60 → 0.75 to avoid suppressing real controls
                    # whose bboxes slightly overlap nearby text labels.
                    if inter / box_area >= 0.75:
                        suppress.add(i)
                        break
            if suppress:
                detections = [d for i, d in enumerate(detections) if i not in suppress]
                if progress_cb:
                    progress_cb("ocr", 60, f"Suppressed {len(suppress)} text-overlap false positives")

        # ── OCR-proximity confidence reranking ──
        # A real control almost always has a label within ~3× its radius.
        # Only very isolated controls (>4× radius) get a small confidence dip.
        # Never drop them here — the confidence gate at the end handles that.
        if len(labels) >= 5:
            detections = _ocr_proximity_rerank(
                detections, labels,
                apply_to={"knob", "slider", "switch", "button"},
                radius_factor=4.0,   # wide search: some labels are far above
                penalty=0.08,        # gentle dip only
                drop_below=0.18,     # only drop truly implausible detections
            )
    timer.mark("ocr")

    # Stage 4: Feature extraction
    if extract_features_flag:
        extract_features(img, detections, progress=progress_cb)
    timer.mark("features")

    # Stage 5: Semantic linking
    if progress_cb:
        progress_cb("linking", 85, "Linking labels → controls")
    _link_labels_to_controls(detections, labels, w, h)
    sections = _group_into_sections(detections, labels, w, h)
    timer.mark("linking")

    # Ensure every control has a parameter_id + AI provenance stamp.
    # provenance lets the frontend merge re-analysis results WITHOUT clobbering
    # controls the user has already corrected (see non-clobbering IoU merge).
    for d in detections:
        if not d.get("parameter_id"):
            d["parameter_id"] = f"{d['type']}_{d['id']}"
            d["display_name"] = d["parameter_id"].replace("_", " ").title()
        d.setdefault("provenance", "ai")

    timing = timer.log_summary()

    # Derive which model(s) actually produced the surviving detections.
    # Each detection has a "source" field set by the pipeline branch that created it.
    _src_set = {
        src
        for d in detections
        for src in _flatten_detection_sources(d)
    }
    _source_families = {_source_family_name(src) for src in _src_set}
    if len(_source_families - {"unknown"}) >= 2:
        _ordered_sources: List[str] = []
        if "gemini" in _source_families:
            _ordered_sources.append("gemini")
        if "yolo" in _source_families:
            _ordered_sources.append("yolo")
        if "heuristic" in _source_families:
            _ordered_sources.append("cv")
        _detection_model_used = "hybrid: " + " + ".join(_ordered_sources)
    elif "gemini" in _source_families:
        _detection_model_used = "gemini"
    elif "yolo" in _source_families and "heuristic" in _source_families:
        _detection_model_used = "yolo+cv"
    elif "yolo" in _source_families:
        _detection_model_used = "yolo"
    elif "heuristic" in _source_families:
        _detection_model_used = "cv"
    else:
        _detection_model_used = "unknown"

    if progress_cb:
        progress_cb("done", 100, f"Analyzed {len(detections)} controls, {len(labels)} labels in {timing.get('total_ms', 0):.0f} ms")

    return {
        "imageWidth": w,
        "imageHeight": h,
        "rectification": rectification,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "capabilities": check_panel_pipeline_available(),
        "controlCount": len(detections),
        "labelCount": len(labels),
        "sectionCount": len(sections),
        "controls": detections,
        "labels": labels,
        "sections": sections,
        "timing": timing,
        "detection_model_requested": detection_model,
        "detection_model_used": _detection_model_used,
        "detection_sources": sorted(_src_set),
    }
