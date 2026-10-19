"""Production-grade CV pipeline for extracting UI elements from hardware photos.

Multi-stage pipeline:
  Stage 1: Intelligence-Guided Segmentation (YOLO → SAM2 box prompts)
  Stage 2: Perspective Correction (4-point homography)
  Stage 3: Mask Refinement (bilateral filter, morphology, geometric fitting)
  Stage 4: Feature Extraction (knob angles, slider rails)
  Stage 5: Output Optimization (anti-aliased PNG, background inpainting)
"""
import base64
import logging
import math
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════════
# Image I/O helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _b64_to_bgra(data_url: str) -> np.ndarray:
    if data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def _b64_to_bgr(data_url: str) -> np.ndarray:
    if data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def _b64_to_rgb(data_url: str) -> np.ndarray:
    if data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    elif img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2RGB)
    else:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    return img


def _to_png_b64(img: np.ndarray) -> str:
    _, buf = cv2.imencode(".png", img)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 1: Intelligence-Guided Segmentation (YOLO + SAM2 box prompts)
# ═══════════════════════════════════════════════════════════════════════════════

# YOLO availability cache
_yolo_model = None
_yolo_checked = False

# Component class mapping for the YOLO model
# When using a custom-trained model, these map to your training classes.
# With pretrained YOLOv11, we map from COCO classes to UI component types.
COCO_TO_COMPONENT = {
    "clock": "knob",
    "sports ball": "knob",
    "frisbee": "knob",
    "donut": "knob",
    "cell phone": "screen",
    "tv": "screen",
    "laptop": "screen",
    "mouse": "slider",
    "remote": "slider",
    "keyboard": "screen",
}

# Custom model class names (when custom-trained model is available)
CUSTOM_COMPONENT_CLASSES = ["knob", "slider", "screen", "button", "led", "fader", "switch"]


def _load_yolo():
    """Lazy-load YOLO model. Prefers custom-trained model, falls back to pretrained."""
    global _yolo_model, _yolo_checked
    if _yolo_checked:
        return _yolo_model
    _yolo_checked = True

    try:
        import os
        from ultralytics import YOLO

        models_dir = os.path.join(os.path.dirname(__file__), "models")

        # Prefer custom-trained model for audio UI components
        custom_candidates = [
            os.path.join(models_dir, "synthskin_yolo.pt"),
            os.path.join(models_dir, "ui_components_yolo.pt"),
        ]
        for path in custom_candidates:
            if os.path.isfile(path):
                _yolo_model = YOLO(path)
                logger.info(f"Loaded custom YOLO model: {path}")
                return _yolo_model

        # Fall back to pretrained YOLOv11n (auto-downloads ~6MB)
        _yolo_model = YOLO("yolo11n.pt")
        logger.info("Loaded pretrained YOLOv11n model")
        return _yolo_model

    except ImportError:
        logger.warning("ultralytics not installed — YOLO detection unavailable")
        return None
    except Exception as e:
        logger.error(f"Failed to load YOLO: {e}")
        return None


def check_yolo_pipeline_available() -> bool:
    return _load_yolo() is not None


def detect_components_yolo(
    image_bgr: np.ndarray,
    confidence: float = 0.25,
    iou_threshold: float = 0.45,
    classes: Optional[List[str]] = None,
) -> List[Dict]:
    """Run YOLO detection on image. Returns list of detections with bounding boxes.

    Each detection: {
        class_name, component_type, confidence,
        box: [x1, y1, x2, y2],
        center: {x, y},
        width, height
    }
    """
    model = _load_yolo()
    if model is None:
        return []

    results = model.predict(
        image_bgr,
        conf=confidence,
        iou=iou_threshold,
        verbose=False,
    )

    detections = []
    if not results or len(results) == 0:
        return detections

    result = results[0]
    names = result.names  # class id → name mapping

    for box_data in result.boxes:
        cls_id = int(box_data.cls[0])
        cls_name = names.get(cls_id, "unknown")
        conf = float(box_data.conf[0])
        x1, y1, x2, y2 = box_data.xyxy[0].tolist()

        # Map to component type
        component_type = cls_name
        if cls_name in COCO_TO_COMPONENT:
            component_type = COCO_TO_COMPONENT[cls_name]
        elif cls_name not in CUSTOM_COMPONENT_CLASSES:
            continue  # Skip irrelevant COCO classes

        if classes and component_type not in classes:
            continue

        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        w = x2 - x1
        h = y2 - y1

        detections.append({
            "class_name": cls_name,
            "component_type": component_type,
            "confidence": round(conf, 4),
            "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            "center": {"x": round(cx, 1), "y": round(cy, 1)},
            "width": round(w, 1),
            "height": round(h, 1),
        })

    return detections


def detect_components_heuristic(
    image_bgr: np.ndarray,
    min_radius: int = 10,
    max_radius: int = 250,
) -> List[Dict]:
    """Fallback heuristic detection using Hough circles + contour analysis.

    Returns detections in the same format as detect_components_yolo.
    """
    h, w = image_bgr.shape[:2]
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    bilateral = cv2.bilateralFilter(gray, 9, 75, 75)
    blurred = cv2.GaussianBlur(bilateral, (9, 9), 2)

    detections = []

    # 1. Hough circles for knobs
    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=min_radius * 2,
        param1=100,
        param2=35,
        minRadius=min_radius,
        maxRadius=max_radius,
    )
    if circles is not None:
        for c in circles[0]:
            cx, cy, r = float(c[0]), float(c[1]), float(c[2])
            x1, y1 = cx - r, cy - r
            x2, y2 = cx + r, cy + r
            detections.append({
                "class_name": "hough_circle",
                "component_type": "knob",
                "confidence": 0.70,
                "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                "center": {"x": round(cx, 1), "y": round(cy, 1)},
                "width": round(r * 2, 1),
                "height": round(r * 2, 1),
            })

    # 2. Contour analysis for sliders/screens
    edges = cv2.Canny(blurred, 40, 120)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, k, iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    image_area = h * w
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 200 or area > image_area * 0.5:
            continue

        x, y, cw, ch = cv2.boundingRect(cnt)
        aspect = cw / max(ch, 1)
        perimeter = cv2.arcLength(cnt, True)
        if perimeter == 0:
            continue
        circularity = 4 * math.pi * area / (perimeter * perimeter)

        # Classify
        if aspect < 0.35 and ch > 40:
            comp_type = "slider"
            conf = 0.55
        elif aspect > 2.8 and cw > 40:
            comp_type = "slider"
            conf = 0.50
        elif 0.6 < aspect < 2.5 and circularity < 0.55 and area > 1000:
            comp_type = "screen"
            conf = 0.45
        else:
            continue

        cx = x + cw / 2
        cy = y + ch / 2
        detections.append({
            "class_name": "contour",
            "component_type": comp_type,
            "confidence": conf,
            "box": [round(float(x), 1), round(float(y), 1),
                    round(float(x + cw), 1), round(float(y + ch), 1)],
            "center": {"x": round(cx, 1), "y": round(cy, 1)},
            "width": round(float(cw), 1),
            "height": round(float(ch), 1),
        })

    return detections


def detect_components_auto(
    image_bgr: np.ndarray,
    confidence: float = 0.25,
    min_radius: int = 10,
    max_radius: int = 250,
) -> Tuple[List[Dict], str]:
    """Auto-detect components using best available method.

    Returns (detections, method) where method is 'yolo' or 'heuristic'.
    """
    yolo_dets = detect_components_yolo(image_bgr, confidence=confidence)
    if yolo_dets:
        return yolo_dets, "yolo"

    heuristic_dets = detect_components_heuristic(
        image_bgr, min_radius=min_radius, max_radius=max_radius,
    )
    return heuristic_dets, "heuristic"


def segment_with_sam2(
    image_rgb: np.ndarray,
    image_bgra: np.ndarray,
    box: List[float],
) -> Optional[Dict]:
    """Segment a single component using SAM2 box prompt.

    Returns {mask_u8, dataUrl, bounds, area, score} or None.
    """
    from sam_service import _load_sam2_predictor, _crop_masked, _mask_only_b64

    predictor = _load_sam2_predictor()
    if predictor is None:
        return _fallback_box_segment(image_bgra, box)

    try:
        import torch  # noqa: F401

        predictor.set_image(image_rgb)

        input_box = np.array(box, dtype=np.float32)
        masks, scores, _ = predictor.predict(
            box=input_box,
            multimask_output=True,
        )

        best_idx = int(np.argmax(scores))
        mask_u8 = (masks[best_idx].astype(np.uint8)) * 255
        score = float(scores[best_idx])

        cropped = _crop_masked(image_bgra, mask_u8)
        if cropped is None:
            return None

        data_url, bounds, area = cropped
        return {
            "mask_u8": mask_u8,
            "dataUrl": data_url,
            "bounds": bounds,
            "area": area,
            "score": round(score, 4),
            "mask_dataUrl": _mask_only_b64(mask_u8),
        }
    except Exception as e:
        logger.error(f"SAM2 segmentation failed: {e}")
        return _fallback_box_segment(image_bgra, box)


def segment_boxes_batch(
    image_rgb: np.ndarray,
    image_bgra: np.ndarray,
    boxes: List[List[float]],
    progress_cb: Optional[callable] = None,
) -> List[Optional[np.ndarray]]:
    """Segment multiple boxes with a SINGLE SAM2 set_image() call.

    This is the key optimisation over calling segment_with_sam2() N times:
    the expensive ViT image-encoding runs only once; subsequent calls only
    run the lightweight prompt-encoder + mask-decoder.

    Returns a list of uint8 0/255 mask arrays (or None for failures),
    in the same order as `boxes`.
    """
    if not boxes:
        return []

    from sam_service import _load_sam2_predictor

    predictor = _load_sam2_predictor()
    h, w = image_rgb.shape[:2]

    if predictor is None:
        # Fallback: per-box GrabCut — no SAM2 available
        results: List[Optional[np.ndarray]] = []
        for i, box in enumerate(boxes):
            r = _fallback_box_segment(image_bgra, box)
            results.append(r["mask_u8"] if r and "mask_u8" in r else None)
            if progress_cb:
                progress_cb(i, len(boxes))
        return results

    try:
        import torch  # noqa: F401

        # ── ONE image encoding for all N boxes ──────────────────────────────
        predictor.set_image(image_rgb)

        results = []
        for i, box in enumerate(boxes):
            try:
                input_box = np.array(box, dtype=np.float32)
                masks, scores, _ = predictor.predict(
                    box=input_box,
                    multimask_output=True,
                )
                best_idx = int(np.argmax(scores))
                mask_u8 = (masks[best_idx].astype(np.uint8)) * 255
                if mask_u8.shape[:2] != (h, w):
                    mask_u8 = cv2.resize(mask_u8, (w, h), interpolation=cv2.INTER_NEAREST)
                results.append(mask_u8)
            except Exception as exc:
                logger.warning(f"SAM2 predict box {i} failed: {exc}")
                # Per-box GrabCut fallback for this one box
                r = _fallback_box_segment(image_bgra, box)
                results.append(r["mask_u8"] if r and "mask_u8" in r else None)

            if progress_cb:
                progress_cb(i, len(boxes))

        return results

    except Exception as exc:
        logger.error(f"SAM2 batch set_image failed: {exc}")
        # Full GrabCut fallback for all boxes
        results = []
        for i, box in enumerate(boxes):
            r = _fallback_box_segment(image_bgra, box)
            results.append(r["mask_u8"] if r and "mask_u8" in r else None)
            if progress_cb:
                progress_cb(i, len(boxes))
        return results


def _fallback_box_segment(
    image_bgra: np.ndarray,
    box: List[float],
) -> Optional[Dict]:
    """GrabCut-based fallback when SAM2 is unavailable."""
    h, w = image_bgra.shape[:2]
    img_bgr = cv2.cvtColor(image_bgra, cv2.COLOR_BGRA2BGR)

    x1 = max(0, int(box[0]))
    y1 = max(0, int(box[1]))
    x2 = min(w, int(box[2]))
    y2 = min(h, int(box[3]))

    if x2 <= x1 or y2 <= y1:
        return None

    rect = (x1, y1, x2 - x1, y2 - y1)
    gc_mask = np.zeros((h, w), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)

    try:
        cv2.grabCut(img_bgr, gc_mask, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    except cv2.error:
        return None

    mask_u8 = np.where((gc_mask == cv2.GC_FGD) | (gc_mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)

    # Crop to box region
    crop_bgra = image_bgra[y1:y2, x1:x2].copy()
    crop_mask = mask_u8[y1:y2, x1:x2]
    crop_bgra[:, :, 3] = cv2.bitwise_and(crop_bgra[:, :, 3], crop_mask)

    area = int(cv2.countNonZero(crop_mask))
    if area == 0:
        return None

    return {
        "mask_u8": mask_u8,
        "dataUrl": _to_png_b64(crop_bgra),
        "bounds": {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1},
        "area": area,
        "score": 0.6,
        "mask_dataUrl": _to_png_b64(crop_mask),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 2: Perspective Correction (Homography)
# ═══════════════════════════════════════════════════════════════════════════════

def correct_perspective(
    image_bgra: np.ndarray,
    corners: List[List[float]],
    output_width: Optional[int] = None,
    output_height: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Apply 4-point perspective warp to make the panel top-down.

    Args:
        image_bgra: Source image (BGRA)
        corners: [[x,y], ...] four corner points in order: TL, TR, BR, BL
        output_width: Desired output width (auto-calculated if None)
        output_height: Desired output height (auto-calculated if None)

    Returns:
        (warped_bgra, homography_matrix)
    """
    if len(corners) != 4:
        raise ValueError("Exactly 4 corner points required for perspective correction")

    src = np.float32(corners)

    # Validate the quadrilateral: reject degenerate / self-intersecting quads
    # by checking that the signed area from the cross-product of diagonals is
    # positive (convex, counter-clockwise vertices).
    def _is_convex_quad(pts: np.ndarray) -> bool:
        n = len(pts)
        for i in range(n):
            o = pts[i]
            a = pts[(i + 1) % n] - o
            b = pts[(i + 2) % n] - o
            cross = float(a[0] * b[1] - a[1] * b[0])
            if cross < 0:          # clockwise turn → not convex
                return False
        return True

    # Try both vertex orderings (CW / CCW) — user may supply either
    if not _is_convex_quad(src) and not _is_convex_quad(src[::-1]):
        raise ValueError(
            "The 4 corner points do not form a convex quadrilateral. "
            "They may be collinear, overlapping, or self-intersecting."
        )

    # Auto-calculate output dimensions from corner distances
    if output_width is None:
        w_top = np.linalg.norm(src[1] - src[0])
        w_bot = np.linalg.norm(src[2] - src[3])
        output_width = int(max(w_top, w_bot))
    if output_height is None:
        h_left = np.linalg.norm(src[3] - src[0])
        h_right = np.linalg.norm(src[2] - src[1])
        output_height = int(max(h_left, h_right))

    output_width = max(1, output_width)
    output_height = max(1, output_height)

    dst = np.float32([
        [0, 0],
        [output_width - 1, 0],
        [output_width - 1, output_height - 1],
        [0, output_height - 1],
    ])

    try:
        M = cv2.getPerspectiveTransform(src, dst)
    except cv2.error as exc:
        raise ValueError(
            f"Failed to compute perspective transform — corners may be degenerate: {exc}"
        ) from exc

    warped = cv2.warpPerspective(
        image_bgra, M, (output_width, output_height),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )

    return warped, M


def transform_point(M: np.ndarray, point: List[float]) -> List[float]:
    """Transform a point using a homography matrix."""
    p = np.array([point[0], point[1], 1.0], dtype=np.float64)
    tp = M @ p
    tx = tp[0] / tp[2]
    ty = tp[1] / tp[2]
    return [round(float(tx), 2), round(float(ty), 2)]


def transform_box(M: np.ndarray, box: List[float]) -> List[float]:
    """Transform a bounding box [x1,y1,x2,y2] using a homography."""
    corners = [
        [box[0], box[1]],
        [box[2], box[1]],
        [box[2], box[3]],
        [box[0], box[3]],
    ]
    transformed = [transform_point(M, c) for c in corners]
    xs = [p[0] for p in transformed]
    ys = [p[1] for p in transformed]
    return [min(xs), min(ys), max(xs), max(ys)]


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 3: Mask Refinement
# ═══════════════════════════════════════════════════════════════════════════════

def refine_mask(
    mask_u8: np.ndarray,
    image_bgr: np.ndarray,
    component_type: str = "unknown",
    circle_snap_threshold: float = 0.90,
) -> np.ndarray:
    """Refine a binary mask with morphology, bilateral smoothing, and geometric fitting.

    Args:
        mask_u8: Input binary mask (0 or 255)
        image_bgr: Original BGR image (for edge-aware refinement)
        component_type: 'knob', 'slider', 'screen', etc. — controls geometric fitting
        circle_snap_threshold: If knob mask is >= this ratio circular, snap to perfect circle

    Returns:
        Refined mask (0-255, may be soft/anti-aliased)
    """
    if mask_u8 is None or cv2.countNonZero(mask_u8) == 0:
        return mask_u8

    # Step A: Morphological cleanup — remove specks and fill holes
    k_small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    k_medium = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

    # Opening removes small noise specks
    refined = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, k_small, iterations=2)
    # Closing fills small holes
    refined = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, k_medium, iterations=2)
    # Fill internal holes
    refined = _fill_mask_holes(refined)

    # Step B: Bilateral filter smoothing — smooth edges without blurring sharpness
    # Apply bilateral on a slightly padded version to avoid edge artifacts
    padded = cv2.copyMakeBorder(refined, 4, 4, 4, 4, cv2.BORDER_REPLICATE)
    smoothed = cv2.bilateralFilter(padded, d=9, sigmaColor=80, sigmaSpace=80)
    refined = smoothed[4:-4, 4:-4]
    # Re-threshold to keep it binary-ish but with soft edges
    _, refined = cv2.threshold(refined, 127, 255, cv2.THRESH_BINARY)

    # Step C: Geometric fitting for specific component types
    if component_type == "knob":
        refined = _snap_to_circle(refined, circle_snap_threshold)

    return refined


def _fill_mask_holes(mask_u8: np.ndarray) -> np.ndarray:
    """Fill internal holes in a binary mask using flood fill from border."""
    h, w = mask_u8.shape
    flood = mask_u8.copy()
    fill_mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(flood, fill_mask, (0, 0), 255)
    holes = cv2.bitwise_not(flood)
    return cv2.bitwise_or(mask_u8, holes)


def _snap_to_circle(
    mask_u8: np.ndarray,
    threshold: float = 0.90,
) -> np.ndarray:
    """If the mask is nearly circular (>= threshold), snap to a perfect circle.

    Uses minimum enclosing circle and compares area ratio.
    """
    coords = cv2.findNonZero(mask_u8)
    if coords is None:
        return mask_u8

    mask_area = cv2.countNonZero(mask_u8)
    (cx, cy), radius = cv2.minEnclosingCircle(coords)
    circle_area = math.pi * radius * radius

    if circle_area == 0:
        return mask_u8

    circularity_ratio = mask_area / circle_area

    if circularity_ratio >= threshold:
        # Snap to perfect circle with anti-aliased edge
        perfect = np.zeros_like(mask_u8)
        cv2.circle(
            perfect,
            (int(round(cx)), int(round(cy))),
            int(round(radius)),
            255, -1, cv2.LINE_AA,
        )
        return perfect

    return mask_u8


def generate_antialiased_alpha(mask_u8: np.ndarray, edge_width: float = 2.0) -> np.ndarray:
    """Generate a soft anti-aliased alpha channel from a binary mask.

    Uses distance transform to create smooth edges.
    """
    # Distance from mask edge (inward)
    dist_in = cv2.distanceTransform(mask_u8, cv2.DIST_L2, 5)
    # Distance from mask edge (outward)
    dist_out = cv2.distanceTransform(255 - mask_u8, cv2.DIST_L2, 5)

    # Create smooth transition at edge
    alpha = np.clip(dist_in / max(edge_width, 0.01), 0.0, 1.0)
    alpha = (alpha * 255).astype(np.uint8)

    # Ensure interior is fully opaque
    alpha[dist_in > edge_width] = 255

    return alpha


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 4: Feature Extraction
# ═══════════════════════════════════════════════════════════════════════════════

def extract_knob_physics(
    image_bgr: np.ndarray,
    mask_u8: np.ndarray,
    center: Optional[Tuple[float, float]] = None,
) -> Dict:
    """Extract knob physics: center, pointer angle, angular range.

    Multi-method polar analysis with sub-pixel refinement.

    Returns: {
        center: {x, y},
        radius: float,
        pointer_angle: float (degrees, 0=up, clockwise),
        start_angle: float,
        end_angle: float,
        has_pointer: bool,
        pointer_confidence: float,
        pointer_width_deg: float,
        value_normalized: float,
    }
    """
    coords = cv2.findNonZero(mask_u8)
    if coords is None:
        return {"center": {"x": 0, "y": 0}, "radius": 0, "has_pointer": False}

    # Find center via minimum enclosing circle
    (cx, cy), radius = cv2.minEnclosingCircle(coords)
    if center is not None:
        cx, cy = center

    result = {
        "center": {"x": round(float(cx), 2), "y": round(float(cy), 2)},
        "radius": round(float(radius), 2),
        "has_pointer": False,
        "pointer_angle": None,
        "pointer_confidence": 0.0,
        "pointer_width_deg": 0.0,
        "start_angle": -135.0,
        "end_angle": 135.0,
        "value_normalized": 0.5,
    }

    if radius < 5:
        return result

    r_int = int(round(radius))
    cx_int, cy_int = int(round(cx)), int(round(cy))

    # Ensure ROI is within image bounds
    h, w = image_bgr.shape[:2]
    pad = max(3, int(radius * 0.15))
    x0 = max(0, cx_int - r_int - pad)
    y0 = max(0, cy_int - r_int - pad)
    x1 = min(w, cx_int + r_int + pad + 1)
    y1 = min(h, cy_int + r_int + pad + 1)
    if x1 - x0 < 6 or y1 - y0 < 6:
        return result

    roi = image_bgr[y0:y1, x0:x1]
    local_cx = cx - x0
    local_cy = cy - y0

    # Build polar image with higher angular resolution
    polar_cols = min(720, max(360, r_int * 4))
    polar_rows = max(8, int(radius * 1.1))
    polar = cv2.warpPolar(
        roi, (polar_cols, polar_rows),
        (local_cx, local_cy),
        radius * 1.05,
        cv2.WARP_POLAR_LINEAR + cv2.INTER_LINEAR,
    )

    polar_gray = cv2.cvtColor(polar, cv2.COLOR_BGR2GRAY).astype(np.float32)

    # Pointer ring: 25-90% of radius
    r_lo = max(1, int(polar_rows * 0.25))
    r_hi = max(r_lo + 2, int(polar_rows * 0.90))
    ring = polar_gray[:, r_lo:r_hi]
    if ring.size == 0:
        return result

    # ── Multi-channel pointer detection ────────────────────────────────────
    # Channel 1: Edge magnitude per angle
    sobel_x = cv2.Sobel(ring, cv2.CV_32F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(ring, cv2.CV_32F, 0, 1, ksize=3)
    edge_strength = np.mean(np.sqrt(sobel_x**2 + sobel_y**2), axis=1)

    # Channel 2: Intensity deviation from circumferential mean
    ring_mean = np.mean(ring, axis=1, keepdims=True)
    intensity_dev = np.mean(np.abs(ring - ring_mean), axis=1)

    # Channel 3: Radial gradient
    radial_grad = np.abs(np.diff(ring, axis=1))
    radial_strength = np.mean(radial_grad, axis=1) if radial_grad.size > 0 else np.zeros(polar_cols)

    # Normalize and combine
    def _norm(a):
        mn, mx = a.min(), a.max()
        return (a - mn) / (mx - mn) if mx - mn > 1e-6 else np.zeros_like(a)

    combined = 0.40 * _norm(edge_strength) + 0.35 * _norm(intensity_dev) + 0.25 * _norm(radial_strength)
    if combined.max() < 1e-6:
        return result

    # Sub-pixel peak via parabolic interpolation
    peak_col = int(np.argmax(combined))
    n = len(combined)
    y_m1 = combined[(peak_col - 1) % n]
    y_0 = combined[peak_col]
    y_p1 = combined[(peak_col + 1) % n]
    denom = 2.0 * (2.0 * y_0 - y_m1 - y_p1)
    delta = (y_m1 - y_p1) / denom if abs(denom) > 1e-8 else 0.0
    refined_col = peak_col + max(-0.5, min(0.5, delta))

    deg_per_col = 360.0 / polar_cols
    raw_angle = refined_col * deg_per_col
    pointer_angle = ((raw_angle - 270.0) % 360.0)
    if pointer_angle > 180.0:
        pointer_angle -= 360.0

    # Pointer confidence (SNR)
    median_val = float(np.median(combined))
    peak_val = float(combined[peak_col])
    snr = (peak_val - median_val) / median_val if median_val > 1e-6 else peak_val * 10
    pointer_confidence = float(min(1.0, max(0.0, snr / 3.0)))

    result["has_pointer"] = pointer_confidence > 0.15
    result["pointer_angle"] = round(float(pointer_angle), 1)
    result["pointer_confidence"] = round(pointer_confidence, 3)

    # Pointer width estimation
    if result["has_pointer"]:
        threshold = median_val + 0.4 * (peak_val - median_val)
        above = combined > threshold
        left = right = peak_col
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
        result["pointer_width_deg"] = round(float(width_cols * deg_per_col), 1)

    # ── Dead-zone analysis for angular range ───────────────────────────────
    mark_band = polar_gray[:, max(1, int(polar_rows * 0.75)):int(polar_rows * 0.95)]
    if mark_band.size > 0:
        mark_edges = cv2.Canny(mark_band.astype(np.uint8), 30, 90)
        edge_density = np.mean(mark_edges > 0, axis=1).astype(np.float32)
        kernel_sz = max(3, polar_cols // 12) | 1
        smoothed = cv2.GaussianBlur(edge_density.reshape(1, -1), (kernel_sz, 1), 0).flatten()

        mean_density = float(np.mean(smoothed))
        dead_mask = smoothed < mean_density * 0.30 if mean_density > 0.005 else smoothed < 0.002

        # Find longest dead zone near the bottom
        bottom_col = (polar_cols * 3) // 4
        best_run = 0
        run_start = -1
        run_len = 0
        for i in range(polar_cols):
            col = (bottom_col - polar_cols // 2 + i) % polar_cols
            if dead_mask[col]:
                if run_start < 0:
                    run_start = col
                run_len += 1
            else:
                if run_len > best_run:
                    best_run = run_len
                run_start = -1
                run_len = 0
        if run_len > best_run:
            best_run = run_len

        min_dead_cols = max(10, polar_cols // 18)
        if best_run >= min_dead_cols:
            dead_span_deg = best_run * deg_per_col
            half_dead = max(10.0, min(80.0, dead_span_deg / 2.0))
            result["start_angle"] = round(-(180.0 - half_dead), 1)
            result["end_angle"] = round(180.0 - half_dead, 1)

    # Value normalization
    total_range = result["end_angle"] - result["start_angle"]
    if total_range > 0 and result["has_pointer"]:
        result["value_normalized"] = round(
            float(max(0.0, min(1.0, (pointer_angle - result["start_angle"]) / total_range))),
            3,
        )

    return result


def extract_slider_physics(
    image_bgr: np.ndarray,
    mask_u8: np.ndarray,
    box: List[float],
) -> Dict:
    """Extract slider rail detection, cap position, and travel range.

    Multi-method approach: Hough lines for rail, multi-channel cap detection,
    track classification, and position normalization.

    Returns: {
        orientation: 'vertical' | 'horizontal',
        rail_start: {x, y},
        rail_end: {x, y},
        travel_px: float,
        rail_angle: float (degrees),
        value_normalized: float (0–1),
        cap_position_px: int,
        rail_detected: bool,
    }
    """
    x1, y1, x2, y2 = int(box[0]), int(box[1]), int(box[2]), int(box[3])
    h, w = image_bgr.shape[:2]

    # Clamp to image bounds
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    if x2 <= x1 or y2 <= y1:
        return {"orientation": "vertical", "travel_px": 0, "value_normalized": 0.5}

    roi = image_bgr[y1:y2, x1:x2]
    roi_mask = mask_u8[y1:y2, x1:x2]

    bw = x2 - x1
    bh = y2 - y1
    orientation = "vertical" if bh > bw * 1.2 else "horizontal"

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 1)
    edges = cv2.Canny(blur, 40, 120)
    edges = cv2.bitwise_and(edges, roi_mask)

    result = {
        "orientation": orientation,
        "rail_start": {"x": 0, "y": 0},
        "rail_end": {"x": 0, "y": 0},
        "travel_px": 0,
        "rail_angle": 90.0 if orientation == "vertical" else 0.0,
        "value_normalized": 0.5,
        "cap_position_px": 0,
        "rail_detected": False,
    }

    # ── Rail detection via Hough lines ─────────────────────────────────────
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180,
        threshold=max(15, min(bw, bh) // 5),
        minLineLength=max(10, int(max(bw, bh) * 0.25)),
        maxLineGap=8,
    )

    best_line = None
    best_length = 0

    if lines is not None:
        for line in lines:
            lx1, ly1, lx2, ly2 = line[0]
            length = math.sqrt((lx2 - lx1) ** 2 + (ly2 - ly1) ** 2)
            angle = math.degrees(math.atan2(ly2 - ly1, lx2 - lx1))

            aligned = False
            if orientation == "vertical" and abs(abs(angle) - 90) < 25:
                aligned = True
            elif orientation == "horizontal" and (abs(angle) < 25 or abs(abs(angle) - 180) < 25):
                aligned = True

            if aligned and length > best_length:
                best_line = (lx1, ly1, lx2, ly2)
                best_length = length

    if best_line is not None:
        lx1, ly1, lx2, ly2 = best_line
        result["rail_start"] = {"x": round(float(x1 + lx1), 1), "y": round(float(y1 + ly1), 1)}
        result["rail_end"] = {"x": round(float(x1 + lx2), 1), "y": round(float(y1 + ly2), 1)}
        result["travel_px"] = round(float(best_length), 1)
        result["rail_angle"] = round(math.degrees(math.atan2(ly2 - ly1, lx2 - lx1)), 1)
        result["rail_detected"] = True
    else:
        if orientation == "vertical":
            mid = x1 + bw / 2
            result["rail_start"] = {"x": round(float(mid), 1), "y": round(float(y1), 1)}
            result["rail_end"] = {"x": round(float(mid), 1), "y": round(float(y2), 1)}
        else:
            mid = y1 + bh / 2
            result["rail_start"] = {"x": round(float(x1), 1), "y": round(float(mid), 1)}
            result["rail_end"] = {"x": round(float(x2), 1), "y": round(float(mid), 1)}
        result["travel_px"] = round(float(bh if orientation == "vertical" else bw), 1)

    # ── Multi-channel cap detection ────────────────────────────────────────
    travel_len = bh if orientation == "vertical" else bw
    if travel_len > 4:
        # Intensity gradient
        intensity_profile = np.mean(gray.astype(np.float32), axis=1 if orientation == "vertical" else 0)
        # Edge density
        edge_profile = np.mean(edges.astype(np.float32), axis=1 if orientation == "vertical" else 0)
        # Variance across perpendicular axis
        var_profile = np.var(gray.astype(np.float32), axis=1 if orientation == "vertical" else 0)

        def _score(p):
            if p.size < 3:
                return p.astype(np.float32)
            g = np.abs(np.gradient(p.astype(np.float32)))
            k = max(3, len(p) // 15) | 1
            return cv2.GaussianBlur(g.reshape(1, -1).astype(np.float32), (k, 1), 0).flatten()

        def _norm(a):
            mn, mx = a.min(), a.max()
            return (a - mn) / (mx - mn) if mx - mn > 1e-6 else np.zeros_like(a)

        combined = (0.40 * _norm(_score(intensity_profile)) +
                    0.35 * _norm(_score(edge_profile)) +
                    0.25 * _norm(_score(var_profile)))

        cap_pos = int(np.argmax(combined)) if combined.size > 0 else travel_len // 2
        result["cap_position_px"] = cap_pos

        if travel_len > 1:
            if orientation == "vertical":
                result["value_normalized"] = round(float(max(0.0, min(1.0, 1.0 - cap_pos / (travel_len - 1)))), 3)
            else:
                result["value_normalized"] = round(float(max(0.0, min(1.0, cap_pos / (travel_len - 1)))), 3)

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 5: Output Optimization
# ═══════════════════════════════════════════════════════════════════════════════

def optimize_output(
    image_bgra: np.ndarray,
    mask_u8: np.ndarray,
    edge_width: float = 2.0,
    padding: int = 2,
) -> Tuple[np.ndarray, Dict]:
    """Produce a clean transparent PNG with anti-aliased edges.

    Args:
        image_bgra: Full source image (BGRA)
        mask_u8: Refined binary mask
        edge_width: Anti-aliased edge width in pixels
        padding: Extra transparent pixels around crop

    Returns:
        (cropped_bgra, bounds_dict)
    """
    # Generate anti-aliased alpha from mask
    alpha = generate_antialiased_alpha(mask_u8, edge_width)

    # Apply alpha to image
    result = image_bgra.copy()
    result[:, :, 3] = cv2.bitwise_and(result[:, :, 3], alpha)

    # Find bounding box of non-zero alpha
    coords = cv2.findNonZero(alpha)
    if coords is None:
        raise ValueError("Mask produced no visible pixels")

    bx, by, bw, bh = cv2.boundingRect(coords)

    # Add padding
    h, w = result.shape[:2]
    bx = max(0, bx - padding)
    by = max(0, by - padding)
    bw = min(w - bx, bw + padding * 2)
    bh = min(h - by, bh + padding * 2)

    crop = result[by:by + bh, bx:bx + bw].copy()
    bounds = {"x": int(bx), "y": int(by), "width": int(bw), "height": int(bh)}

    return crop, bounds


def inpaint_background(
    image_bgr: np.ndarray,
    mask_u8: np.ndarray,
    method: str = "telea",
    radius: int = 5,
) -> np.ndarray:
    """Fill the hole left by an extracted element using inpainting.

    Args:
        image_bgr: Source BGR image
        mask_u8: Mask where 255 = area to inpaint (the extracted element's location)
        method: 'telea' (default) or 'ns' (Navier-Stokes)
        radius: Inpainting radius

    Returns:
        Inpainted BGR image
    """
    # Dilate mask slightly to ensure clean coverage of edges
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    inpaint_mask = cv2.dilate(mask_u8, k, iterations=1)

    flag = cv2.INPAINT_TELEA if method == "telea" else cv2.INPAINT_NS
    inpainted = cv2.inpaint(image_bgr, inpaint_mask, radius, flag)
    return inpainted


# ═══════════════════════════════════════════════════════════════════════════════
# FULL PIPELINE — Runs all stages end-to-end
# ═══════════════════════════════════════════════════════════════════════════════

def run_pipeline(
    image_b64: str,
    perspective_corners: Optional[List[List[float]]] = None,
    output_width: Optional[int] = None,
    output_height: Optional[int] = None,
    detection_confidence: float = 0.25,
    component_filter: Optional[List[str]] = None,
    circle_snap_threshold: float = 0.90,
    edge_width: float = 2.0,
    padding: int = 2,
    include_inpainted: bool = False,
    inpaint_method: str = "telea",
    inpaint_radius: int = 5,
) -> Dict:
    """Run the full multi-stage extraction pipeline.

    Args:
        image_b64: Base64 source image
        perspective_corners: Optional 4 corner points for perspective correction [TL, TR, BR, BL]
        output_width: Output width after perspective correction (auto if None)
        output_height: Output height after perspective correction (auto if None)
        detection_confidence: YOLO/detection confidence threshold
        component_filter: Only extract these types (e.g. ['knob', 'slider'])
        circle_snap_threshold: Circularity ratio for snapping knobs to perfect circles
        edge_width: Anti-aliased edge width
        padding: Transparent padding around crops
        include_inpainted: If True, return the background with extracted areas inpainted
        inpaint_method: 'telea' or 'ns'
        inpaint_radius: Inpainting kernel radius

    Returns: {
        components: [{
            type, confidence, detection_method,
            bounds, center,
            dataUrl, mask_dataUrl,
            physics: {knob or slider specific data},
        }, ...],
        count: int,
        detection_method: str,
        perspective_corrected: bool,
        inpainted_background: str (if include_inpainted),
        metadata: { image_width, image_height, pipeline_stages },
    }
    """
    import time
    t0 = time.perf_counter()

    # Load image
    image_bgra = _b64_to_bgra(image_b64)
    image_bgr = cv2.cvtColor(image_bgra, cv2.COLOR_BGRA2BGR)
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    stages_run = []
    homography_M = None

    # ── Stage 2: Perspective Correction (runs before detection) ──
    if perspective_corners is not None:
        image_bgra, homography_M = correct_perspective(
            image_bgra, perspective_corners, output_width, output_height,
        )
        image_bgr = cv2.cvtColor(image_bgra, cv2.COLOR_BGRA2BGR)
        image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        stages_run.append("perspective_correction")

    h, w = image_bgr.shape[:2]

    # ── Stage 1: Detection (YOLO or heuristic) ──
    detections, det_method = detect_components_auto(
        image_bgr,
        confidence=detection_confidence,
    )
    stages_run.append(f"detection_{det_method}")

    # Filter by requested component types
    if component_filter:
        detections = [d for d in detections if d["component_type"] in component_filter]

    # NMS dedup — remove overlapping detections
    detections = _nms_detections(detections, iou_threshold=0.45)

    # ── Stage 1b: SAM2 segmentation from detected boxes ──
    components = []
    combined_mask = np.zeros((h, w), dtype=np.uint8)

    for det in detections:
        box = det["box"]
        comp_type = det["component_type"]

        # Segment using SAM2 (or GrabCut fallback)
        seg_result = segment_with_sam2(image_rgb, image_bgra, box)
        if seg_result is None:
            continue

        mask_u8 = seg_result["mask_u8"]
        stages_run_comp = ["segmentation"]

        # ── Stage 3: Mask Refinement ──
        mask_u8 = refine_mask(
            mask_u8, image_bgr,
            component_type=comp_type,
            circle_snap_threshold=circle_snap_threshold,
        )
        stages_run_comp.append("mask_refinement")

        # ── Stage 4: Feature Extraction ──
        physics = {}
        if comp_type == "knob":
            physics = extract_knob_physics(
                image_bgr, mask_u8,
                center=(det["center"]["x"], det["center"]["y"]),
            )
            stages_run_comp.append("knob_physics")
        elif comp_type in ("slider", "fader"):
            physics = extract_slider_physics(image_bgr, mask_u8, box)
            stages_run_comp.append("slider_physics")

        # ── Stage 5: Output Optimization ──
        alpha = generate_antialiased_alpha(mask_u8, edge_width)
        out_bgra = image_bgra.copy()
        out_bgra[:, :, 3] = cv2.bitwise_and(out_bgra[:, :, 3], alpha)

        coords = cv2.findNonZero(alpha)
        if coords is None:
            continue

        bx, by, bw, bh = cv2.boundingRect(coords)
        bx = max(0, bx - padding)
        by = max(0, by - padding)
        bw = min(w - bx, bw + padding * 2)
        bh = min(h - by, bh + padding * 2)

        crop = out_bgra[by:by + bh, bx:bx + bw].copy()
        stages_run_comp.append("output_optimization")

        # Accumulate mask for inpainting
        combined_mask = cv2.bitwise_or(combined_mask, mask_u8)

        # Build mask data URL
        crop_mask = mask_u8[by:by + bh, bx:bx + bw]

        component = {
            "type": comp_type,
            "confidence": det["confidence"],
            "detection_method": det["class_name"],
            "bounds": {"x": int(bx), "y": int(by), "width": int(bw), "height": int(bh)},
            "center": det["center"],
            "dataUrl": _to_png_b64(crop),
            "mask_dataUrl": _to_png_b64(crop_mask),
            "physics": physics,
            "stages": stages_run_comp,
        }
        components.append(component)

    stages_run.append("segmentation_refinement")

    # ── Stage 5: Background Inpainting (optional) ──
    inpainted_b64 = None
    if include_inpainted and cv2.countNonZero(combined_mask) > 0:
        inpainted = inpaint_background(
            image_bgr, combined_mask, inpaint_method, inpaint_radius,
        )
        inpainted_bgra = cv2.cvtColor(inpainted, cv2.COLOR_BGR2BGRA)
        inpainted_b64 = _to_png_b64(inpainted_bgra)
        stages_run.append("background_inpainting")

    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)

    response = {
        "components": components,
        "count": len(components),
        "detection_method": det_method,
        "perspective_corrected": perspective_corners is not None,
        "metadata": {
            "image_width": w,
            "image_height": h,
            "pipeline_stages": stages_run,
            "elapsed_ms": elapsed_ms,
        },
    }

    if inpainted_b64 is not None:
        response["inpainted_background"] = inpainted_b64

    return response


def run_single_extract(
    image_b64: str,
    box: List[float],
    component_type: str = "knob",
    perspective_corners: Optional[List[List[float]]] = None,
    circle_snap_threshold: float = 0.90,
    edge_width: float = 2.0,
    padding: int = 2,
    include_inpainted: bool = False,
    inpaint_method: str = "telea",
    inpaint_radius: int = 5,
) -> Dict:
    """Extract a single component by bounding box through the refinement pipeline.

    Use this when the user has already drawn or identified a specific region.
    Runs stages 1b, 3, 4, 5 (skips auto-detection and perspective).
    """
    image_bgra = _b64_to_bgra(image_b64)
    image_bgr = cv2.cvtColor(image_bgra, cv2.COLOR_BGRA2BGR)
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    h, w = image_bgr.shape[:2]

    # Perspective correction if provided
    if perspective_corners is not None:
        image_bgra, _ = correct_perspective(image_bgra, perspective_corners)
        image_bgr = cv2.cvtColor(image_bgra, cv2.COLOR_BGRA2BGR)
        image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        h, w = image_bgr.shape[:2]

    # Segment
    seg_result = segment_with_sam2(image_rgb, image_bgra, box)
    if seg_result is None:
        raise ValueError("Segmentation failed — no mask produced for the given box")

    mask_u8 = seg_result["mask_u8"]

    # Refine
    mask_u8 = refine_mask(
        mask_u8, image_bgr,
        component_type=component_type,
        circle_snap_threshold=circle_snap_threshold,
    )

    # Feature extraction
    physics = {}
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    if component_type == "knob":
        physics = extract_knob_physics(image_bgr, mask_u8, center=(cx, cy))
    elif component_type in ("slider", "fader"):
        physics = extract_slider_physics(image_bgr, mask_u8, box)

    # Output
    alpha = generate_antialiased_alpha(mask_u8, edge_width)
    out_bgra = image_bgra.copy()
    out_bgra[:, :, 3] = cv2.bitwise_and(out_bgra[:, :, 3], alpha)

    coords = cv2.findNonZero(alpha)
    if coords is None:
        raise ValueError("Mask produced no visible pixels")

    bx, by, bw, bh = cv2.boundingRect(coords)
    bx = max(0, bx - padding)
    by = max(0, by - padding)
    bw = min(w - bx, bw + padding * 2)
    bh = min(h - by, bh + padding * 2)

    crop = out_bgra[by:by + bh, bx:bx + bw].copy()
    crop_mask = mask_u8[by:by + bh, bx:bx + bw]

    result = {
        "type": component_type,
        "bounds": {"x": int(bx), "y": int(by), "width": int(bw), "height": int(bh)},
        "center": {"x": round(cx, 1), "y": round(cy, 1)},
        "dataUrl": _to_png_b64(crop),
        "mask_dataUrl": _to_png_b64(crop_mask),
        "physics": physics,
    }

    if include_inpainted:
        inpainted = inpaint_background(image_bgr, mask_u8, inpaint_method, inpaint_radius)
        inpainted_bgra = cv2.cvtColor(inpainted, cv2.COLOR_BGR2BGRA)
        result["inpainted_background"] = _to_png_b64(inpainted_bgra)

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Utility: NMS for detections
# ═══════════════════════════════════════════════════════════════════════════════

def _iou_boxes(a: List[float], b: List[float]) -> float:
    """Calculate IoU between two [x1,y1,x2,y2] boxes."""
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    union = area_a + area_b - inter
    return inter / max(union, 1e-6)


def _nms_detections(detections: List[Dict], iou_threshold: float = 0.45) -> List[Dict]:
    """Non-Maximum Suppression on detection list."""
    if len(detections) <= 1:
        return detections

    # Sort by confidence descending
    sorted_dets = sorted(detections, key=lambda d: d["confidence"], reverse=True)
    keep = []

    while sorted_dets:
        best = sorted_dets.pop(0)
        keep.append(best)
        sorted_dets = [
            d for d in sorted_dets
            if _iou_boxes(best["box"], d["box"]) < iou_threshold
        ]

    return keep
