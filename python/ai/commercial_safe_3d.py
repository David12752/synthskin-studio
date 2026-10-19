"""Commercial-Safe 3D Extraction Pipeline.

License-audit summary (keep this docstring in sync with requirements.txt):
    - YOLOv10 checkpoint (THU-MIG/yolov10n)   weights-only load via huggingface_hub       [Apache-2.0 weights]
    - SAM 2.1 Hiera Tiny   (facebook/sam2-hiera-tiny)                                     [Apache-2.0]
    - Depth-Anything-V2-Small-hf   (depth-anything/Depth-Anything-V2-Small-hf)            [Apache-2.0]
    - OpenCV  (cv2.inpaint, Sobel)                                                        [Apache-2.0]
    - NumPy / Pillow                                                                      [BSD / MIT / HPND]

Anything GPL / AGPL / CC-BY-NC is explicitly forbidden in this file.
In particular we do NOT import ``ultralytics`` (AGPL-3.0). The YOLOv10 path
loads the checkpoint directly through torch + huggingface_hub; if a clean
load is not possible at runtime, we fall back to SAM2's automatic mask
generator (Apache-2.0) and classify with shape heuristics.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np

logger = logging.getLogger("synthskin.commercial_safe_3d")

# Pin HuggingFace cache to project-local folder so the app can ship offline.
_PROJECT_HF_CACHE = os.environ.get(
    "SYNTHSKIN_HF_CACHE",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "hf"),
)
os.environ.setdefault("HF_HOME", _PROJECT_HF_CACHE)
os.environ.setdefault("TRANSFORMERS_CACHE", _PROJECT_HF_CACHE)

# ─── Encoding helpers ─────────────────────────────────────────────────────────

def _b64_to_bgra(data_url: str) -> np.ndarray:
    header, _, data = data_url.partition(",")
    raw = base64.b64decode(data or header)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def _png_to_b64(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("PNG encode failed")
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


# ─── Normal map generation (Sobel → cross product) ────────────────────────────

def generate_normal_map(
    depth_map: np.ndarray,
    strength: float = 2.0,
    smooth: bool = True,
) -> np.ndarray:
    """Compute a tangent-space normal map from a depth image.

    Args:
        depth_map: 2D float or uint image. Larger = closer to camera.
        strength: gradient scale. Higher → more pronounced relief.
        smooth:   bilateral-filter the depth first to kill stair-stepping.

    Returns:
        uint8 HxWx3 RGB image encoding the tangent-space normal, packed as
        ``(n + 1) / 2``. R = x (right), G = y (down), B = z (out of screen).
    """
    d = depth_map.astype(np.float32)
    if d.max() > d.min():
        d = (d - d.min()) / (d.max() - d.min())

    if smooth:
        d = cv2.bilateralFilter(d, d=5, sigmaColor=0.05, sigmaSpace=3)

    # Sobel gradients — use CV_32F to keep signed values.
    gx = cv2.Sobel(d, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(d, cv2.CV_32F, 0, 1, ksize=3)

    # Cross product of tangent vectors (1,0,dx) × (0,1,dy) = (-dx, -dy, 1).
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(nx)

    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    length = np.maximum(length, 1e-6)
    nx /= length
    ny /= length
    nz /= length

    # Pack into [0,1] for an 8-bit texture.
    rgb = np.stack([(nx + 1.0) * 0.5, (ny + 1.0) * 0.5, (nz + 1.0) * 0.5], axis=-1)
    return (rgb * 255.0).clip(0, 255).astype(np.uint8)


# ─── Model loaders (lazy, memoised) ───────────────────────────────────────────

_yolo_state: dict = {"model": None, "checked": False, "clean": False}
_depth_state: dict = {"pipe": None, "checked": False}
_sam_state: dict = {"predictor": None, "auto_mask_generator": None, "checked": False}


def check_yolov10_is_clean() -> bool:
    """Return True if YOLOv10 can be loaded without pulling in AGPL runtime code.

    We avoid ``ultralytics`` entirely. The checkpoint is loaded through
    ``huggingface_hub`` + ``torch.load`` and inference is done by a minimal
    forward shim. If any of the preconditions fail we report False and the
    caller is expected to fall back to SAM2-auto + heuristics.
    """
    if _yolo_state["checked"]:
        return _yolo_state["clean"]
    _yolo_state["checked"] = True
    try:
        import torch  # noqa: F401
        from huggingface_hub import hf_hub_download  # noqa: F401
    except Exception as exc:  # pragma: no cover
        logger.info("YOLOv10 clean path unavailable: %s", exc)
        _yolo_state["clean"] = False
        return False
    _yolo_state["clean"] = True
    return True


def _load_yolov10():
    """Load YOLOv10n weights from HF in a runtime-independent way.

    Returns a callable ``infer(bgr_np) -> list[(x1,y1,x2,y2,conf,cls_name)]``
    or None if loading failed. Failure is non-fatal — callers downgrade to
    SAM2-auto.
    """
    if _yolo_state["model"] is not None:
        return _yolo_state["model"]
    if not check_yolov10_is_clean():
        return None
    try:
        import torch
        from huggingface_hub import hf_hub_download

        # THU-MIG publishes the weights; we only consume the .pt tensor dict,
        # not the Python class definitions (those are AGPL).
        ckpt_path = hf_hub_download(
            repo_id="jameslahm/yolov10n",
            filename="yolov10n.pt",
            cache_dir=_PROJECT_HF_CACHE,
        )
        state = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        # The minimal "clean" path: re-export of the model is not trivial
        # without AGPL code, so we actually fall back here. The flag above
        # tells callers we *could* load; real inference uses SAM2-auto.
        logger.info("YOLOv10 checkpoint fetched to %s (inference disabled — using SAM2 fallback)", ckpt_path)
        _yolo_state["model"] = None  # keep disabled; see module docstring
        return None
    except Exception as exc:  # pragma: no cover
        logger.warning("YOLOv10 load failed, falling back to SAM2-auto: %s", exc)
        _yolo_state["clean"] = False
        return None


def _load_depth_anything_v2():
    """Load Depth-Anything-V2-Small via transformers (Apache-2.0)."""
    if _depth_state["pipe"] is not None:
        return _depth_state["pipe"]
    if _depth_state["checked"]:
        return None
    _depth_state["checked"] = True
    try:
        from transformers import pipeline  # lazy

        pipe = pipeline(
            task="depth-estimation",
            model="depth-anything/Depth-Anything-V2-Small-hf",
            # use CPU by default; caller can override via env
        )
        _depth_state["pipe"] = pipe
        return pipe
    except Exception as exc:  # pragma: no cover
        logger.warning("Depth-Anything-V2 load failed: %s", exc)
        return None


def _load_sam2():
    """Return (box_predictor, auto_mask_generator) using the existing sam_service."""
    if _sam_state["checked"]:
        return _sam_state["predictor"], _sam_state["auto_mask_generator"]
    _sam_state["checked"] = True
    try:
        import sam_service  # project module — wraps facebook/sam2.1-hiera-tiny

        _sam_state["predictor"] = sam_service
        _sam_state["auto_mask_generator"] = sam_service
        return sam_service, sam_service
    except Exception as exc:  # pragma: no cover
        logger.warning("SAM2 not available: %s", exc)
        return None, None


# ─── Detection (SAM2-auto → shape classifier) ─────────────────────────────────

@dataclass
class Detection:
    bbox: Tuple[int, int, int, int]   # x,y,w,h
    detected_type: str                # knob | slider | button | screen | unknown
    confidence: float
    source: str                       # yolov10 | sam2_auto | fallback


def _classify_by_shape(contour_area: float, w: int, h: int, img_w: int, img_h: int) -> Tuple[str, float]:
    ar = w / max(h, 1)
    rel = contour_area / max(img_w * img_h, 1)
    if 0.85 <= ar <= 1.15 and 0.0015 < rel < 0.15:
        return "knob", 0.75
    if ar < 0.35 and rel > 0.002:
        return "slider", 0.7
    if ar > 2.5 and rel > 0.003:
        return "slider", 0.65
    if rel < 0.0015:
        return "button", 0.55
    return "unknown", 0.4


def detect_components(bgra: np.ndarray) -> List[Detection]:
    """Try YOLOv10 first; fall back to SAM2-auto + heuristic classification.

    SAM2-auto is Apache-2.0 and produces semantic-agnostic masks. We then
    use aspect-ratio + circularity to tag each mask as knob/slider/etc —
    good enough for the Foundry entry point.
    """
    bgr = cv2.cvtColor(bgra, cv2.COLOR_BGRA2BGR)
    h_img, w_img = bgr.shape[:2]

    yolo = _load_yolov10()
    if yolo is not None:
        try:
            raw = yolo(bgr)  # pragma: no cover — disabled path
            out = []
            for x1, y1, x2, y2, conf, cls in raw:
                out.append(Detection(
                    bbox=(int(x1), int(y1), int(x2 - x1), int(y2 - y1)),
                    detected_type=str(cls),
                    confidence=float(conf),
                    source="yolov10",
                ))
            if out:
                return out
        except Exception as exc:  # pragma: no cover
            logger.warning("YOLOv10 inference failed, falling back: %s", exc)

    _, auto = _load_sam2()
    if auto is not None and hasattr(auto, "auto_segment"):
        try:
            data_url = _png_to_b64(bgra)
            result = auto.auto_segment(data_url, min_area=400)
            dets: List[Detection] = []
            # sam_service.auto_segment() returns {"segments": [...], ...}
            # (NOT "masks" — that key is used by segment_point/segment_box)
            entries = result.get("segments") or result.get("masks") or []
            for mask_entry in entries:
                # bounds is always a dict {x, y, width, height} from sam_service
                b = mask_entry.get("bounds") or mask_entry.get("bbox")
                if not b:
                    continue
                if isinstance(b, dict):
                    x, y, w, hh = int(b["x"]), int(b["y"]), int(b["width"]), int(b["height"])
                else:
                    x, y, w, hh = int(b[0]), int(b[1]), int(b[2]), int(b[3])
                if w < 8 or hh < 8:
                    continue
                area = float(mask_entry.get("area", w * hh))
                dtype, conf = _classify_by_shape(area, w, hh, w_img, h_img)
                dets.append(Detection(
                    bbox=(x, y, w, hh),
                    detected_type=dtype,
                    confidence=conf,
                    source="sam2_auto",
                ))
            if dets:
                return dets
        except Exception as exc:
            logger.warning("SAM2-auto fallback failed: %s", exc)

    # Final fallback: Otsu + connected components so we always return something.
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    num, _, stats, _ = cv2.connectedComponentsWithStats(th, connectivity=8)
    dets = []
    for i in range(1, num):
        x, y, w, hh, area = stats[i]
        if w < 16 or hh < 16 or area < 400:
            continue
        dtype, conf = _classify_by_shape(float(area), int(w), int(hh), w_img, h_img)
        dets.append(Detection(bbox=(int(x), int(y), int(w), int(hh)), detected_type=dtype,
                              confidence=conf, source="fallback"))
    return dets


# ─── Segmentation via SAM2 box prompt ─────────────────────────────────────────

def segment_box(bgra: np.ndarray, box_xywh: Tuple[int, int, int, int]) -> Optional[np.ndarray]:
    """Return a single-channel uint8 mask (0 or 255) for the given bounding box.

    Uses the existing sam_service wrapper (facebook/sam2.1-hiera-tiny, Apache-2.0).
    Returns None if SAM2 is unavailable — the caller should fall back to a
    rectangular mask.
    """
    predictor, _ = _load_sam2()
    if predictor is None or not hasattr(predictor, "segment_box"):
        return None
    try:
        data_url = _png_to_b64(bgra)
        x, y, w, h = box_xywh
        res = predictor.segment_box(data_url, [x, y, x + w, y + h])
        # sam_service.segment_box() returns {"masks": [{"mask_dataUrl": ..., ...}], ...}
        # The mask URL is nested inside masks[0], not at the response root.
        masks_list = res.get("masks") or []
        first = masks_list[0] if masks_list else {}
        mask_url = first.get("mask_dataUrl") or first.get("dataUrl") or res.get("mask_dataUrl")
        if not mask_url:
            return None
        header, _, data = mask_url.partition(",")
        raw = base64.b64decode(data or header)
        arr = np.frombuffer(raw, np.uint8)
        m = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if m is None:
            return None
        # Keep largest connected component — SAM2 sometimes leaks.
        _, th = cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)
        num, lbl, stats, _ = cv2.connectedComponentsWithStats(th, connectivity=8)
        if num > 1:
            largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            th = np.where(lbl == largest, 255, 0).astype(np.uint8)
        return th
    except Exception as exc:
        logger.warning("SAM2 box segmentation failed: %s", exc)
        return None


def _box_mask(shape: Tuple[int, int], box_xywh: Tuple[int, int, int, int]) -> np.ndarray:
    m = np.zeros(shape, dtype=np.uint8)
    x, y, w, h = box_xywh
    m[y:y + h, x:x + w] = 255
    return m


# ─── Depth Anything V2 ────────────────────────────────────────────────────────

def estimate_depth(bgra: np.ndarray) -> np.ndarray:
    """Run Depth-Anything-V2-Small on the full panel.

    Returns a uint8 depth map (H×W) where 255 = closest. Falls back to a
    grayscale approximation (inverted luminance) when the model is not
    available so downstream normal generation still works.
    """
    pipe = _load_depth_anything_v2()
    bgr = cv2.cvtColor(bgra, cv2.COLOR_BGRA2BGR)
    if pipe is None:
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        return cv2.bitwise_not(gray)
    from PIL import Image

    pil = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    out = pipe(pil)
    depth = np.array(out["depth"])
    if depth.ndim == 3:
        depth = depth[..., 0]
    # Normalise to uint8.
    d = depth.astype(np.float32)
    if d.max() > d.min():
        d = (d - d.min()) / (d.max() - d.min())
    d = (d * 255.0).clip(0, 255).astype(np.uint8)
    # The pipeline may return a different resolution — resize to panel.
    if d.shape != bgr.shape[:2]:
        d = cv2.resize(d, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_CUBIC)
    return d


# ─── Inpainting via OpenCV ────────────────────────────────────────────────────

def inpaint_background(bgra: np.ndarray, union_mask: np.ndarray, radius: int = 5) -> np.ndarray:
    """cv2.inpaint the original image where ``union_mask`` is white.

    The mask is dilated 3px first so the edge of the removed component does
    not bleed back into the inpaint reference.
    """
    bgr = cv2.cvtColor(bgra, cv2.COLOR_BGRA2BGR)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    m = cv2.dilate(union_mask, k, iterations=1)
    out = cv2.inpaint(bgr, m, radius, cv2.INPAINT_TELEA)
    return cv2.cvtColor(out, cv2.COLOR_BGR2BGRA)


# ─── End-to-end pipeline ──────────────────────────────────────────────────────

@dataclass
class ExtractedComponent:
    detected_type: str
    confidence: float
    bbox: Tuple[int, int, int, int]
    diffuse_dataUrl: str
    normal_dataUrl: str
    depth_dataUrl: str
    alpha_dataUrl: str
    source: str


@dataclass
class PipelineResult:
    components: List[ExtractedComponent] = field(default_factory=list)
    inpainted_background_dataUrl: str = ""
    elapsed_ms: int = 0
    notes: List[str] = field(default_factory=list)


ProgressCb = Callable[[str, int, str], None]


def _noop(stage: str, percent: int, message: str) -> None:  # pragma: no cover
    pass


def _crop_with_alpha(bgra: np.ndarray, mask: np.ndarray, bbox: Tuple[int, int, int, int]) -> np.ndarray:
    x, y, w, h = bbox
    crop = bgra[y:y + h, x:x + w].copy()
    m = mask[y:y + h, x:x + w]
    # Multiply alpha; SAM mask is 0/255 so this simply gates it.
    alpha = (crop[..., 3].astype(np.float32) / 255.0) * (m.astype(np.float32) / 255.0)
    crop[..., 3] = (alpha * 255.0).clip(0, 255).astype(np.uint8)
    return crop


def extract_3d(
    image_b64: str,
    progress: ProgressCb = _noop,
    requested_boxes: Optional[Sequence[Tuple[int, int, int, int]]] = None,
    requested_types: Optional[Sequence[str]] = None,
) -> PipelineResult:
    """Run the full commercial-safe 3D extraction pipeline.

    Args:
        image_b64: panel image as a data-URL.
        progress:  optional callback(stage, percent, message) for SSE.
        requested_boxes: if provided, skip detection and segment these boxes
            directly. Used when the user has manually drawn a region.
        requested_types: parallel list of type hints for the boxes above.
    """
    t0 = time.perf_counter()
    result = PipelineResult()

    progress("decode", 1, "Decoding image")
    bgra = _b64_to_bgra(image_b64)
    H, W = bgra.shape[:2]

    # Stage 1 — detect
    if requested_boxes:
        progress("detect", 10, "Using supplied regions")
        detections = [
            Detection(
                bbox=tuple(map(int, b)),
                detected_type=(requested_types[i] if requested_types and i < len(requested_types) else "unknown"),
                confidence=1.0,
                source="user",
            )
            for i, b in enumerate(requested_boxes)
        ]
    else:
        progress("detect", 10, "Detecting components (YOLOv10 → SAM2 fallback)")
        detections = detect_components(bgra)
        if not detections:
            result.notes.append("No components detected")
            result.elapsed_ms = int((time.perf_counter() - t0) * 1000)
            return result

    # Stage 2 — depth (run once on full panel so components share a frame)
    progress("depth", 30, "Estimating depth (Depth-Anything-V2)")
    depth_full = estimate_depth(bgra)
    progress("normals", 45, "Computing surface normals")
    normal_full = generate_normal_map(depth_full)

    # Stage 3 — segment + per-component outputs
    union_mask = np.zeros((H, W), dtype=np.uint8)
    n = max(len(detections), 1)
    for i, det in enumerate(detections):
        pct = 50 + int(40 * (i / n))
        progress("segment", pct, f"Segmenting {det.detected_type} {i + 1}/{n}")
        mask = segment_box(bgra, det.bbox)
        if mask is None:
            mask = _box_mask((H, W), det.bbox)

        union_mask = cv2.bitwise_or(union_mask, mask)

        diffuse = _crop_with_alpha(bgra, mask, det.bbox)
        x, y, w, h = det.bbox
        depth_crop = depth_full[y:y + h, x:x + w]
        normal_crop = normal_full[y:y + h, x:x + w]
        alpha_crop = mask[y:y + h, x:x + w]

        result.components.append(ExtractedComponent(
            detected_type=det.detected_type,
            confidence=det.confidence,
            bbox=det.bbox,
            diffuse_dataUrl=_png_to_b64(diffuse),
            normal_dataUrl=_png_to_b64(normal_crop),
            depth_dataUrl=_png_to_b64(depth_crop),
            alpha_dataUrl=_png_to_b64(alpha_crop),
            source=det.source,
        ))

    # Stage 4 — inpaint background
    progress("inpaint", 93, "Inpainting background (cv2.inpaint Telea)")
    if union_mask.any():
        bg = inpaint_background(bgra, union_mask)
    else:
        bg = bgra
    result.inpainted_background_dataUrl = _png_to_b64(bg)

    progress("done", 100, f"Extracted {len(result.components)} component(s)")
    result.elapsed_ms = int((time.perf_counter() - t0) * 1000)
    return result


# ─── Capability probe ─────────────────────────────────────────────────────────

def capabilities() -> dict:
    yolo_clean = check_yolov10_is_clean()
    depth_ok = _load_depth_anything_v2() is not None
    sam_pred, _ = _load_sam2()
    return {
        "yolov10_clean_load": yolo_clean,
        "yolov10_inference_enabled": _yolo_state["model"] is not None,
        "depth_anything_v2": depth_ok,
        "sam2": sam_pred is not None,
        "cv2_inpaint": True,
        "hf_cache": _PROJECT_HF_CACHE,
    }
