"""SAM2 (Segment Anything Model 2) segmentation service.

Provides high-quality interactive segmentation using Meta's SAM2 model.
Supports:
- Point-prompt segmentation (click to select)
- Box-prompt segmentation (drag rectangle)
- Multi-point positive/negative prompts
- Automatic mask generation (detect all objects)

Falls back to OpenCV-based extraction when SAM2 is not installed.
"""
import base64
import logging
import math
import os
from typing import List, Optional, Tuple

import cv2
import numpy as np

import runtime

logger = logging.getLogger(__name__)

# ─── SAM2 Availability Check ───

_sam2_available = None
_sam2_predictor = None
_sam2_auto_generator = None


def _check_sam2() -> bool:
    """Check if SAM2 is importable."""
    global _sam2_available
    if _sam2_available is not None:
        return _sam2_available
    try:
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        _sam2_available = True
    except ImportError:
        _sam2_available = False
    return _sam2_available


def _get_checkpoint_path() -> Optional[str]:
    """Find the best SAM2 checkpoint present in models/.

    Prefers the tier the runtime manager recommends for this machine, then
    falls back through the remaining tiers (heaviest → lightest) so we always
    load the best checkpoint actually on disk.
    """
    models_dir = os.path.join(os.path.dirname(__file__), "models")
    tier_order = ["large", "base_plus", "small", "tiny"]
    try:
        rec = runtime.recommended_sam2_tier()
    except Exception:
        rec = "tiny"
    search = [rec] + [t for t in tier_order if t != rec]
    for tier in search:
        for prefix in ("sam2.1_hiera_", "sam2_hiera_"):
            path = os.path.join(models_dir, f"{prefix}{tier}.pt")
            if os.path.isfile(path):
                return path
    return None


def _get_config_for_checkpoint(checkpoint: str) -> str:
    """Return the SAM2 config name based on checkpoint filename.

    SAM2.1 configs live under configs/sam2.1/ in the package.
    SAM2 (v1) configs live under configs/sam2/ in the package.
    """
    name = os.path.basename(checkpoint).lower()
    is_21 = "2.1" in name
    prefix = "configs/sam2.1/" if is_21 else "configs/sam2/"
    if "large" in name:
        suffix = "sam2.1_hiera_l.yaml" if is_21 else "sam2_hiera_l.yaml"
    elif "base" in name:
        suffix = "sam2.1_hiera_b+.yaml" if is_21 else "sam2_hiera_b+.yaml"
    elif "small" in name:
        suffix = "sam2.1_hiera_s.yaml" if is_21 else "sam2_hiera_s.yaml"
    else:
        suffix = "sam2.1_hiera_t.yaml" if is_21 else "sam2_hiera_t.yaml"
    return prefix + suffix


# ─── SAM2 Model Loading ───

def _load_sam2_predictor():
    """Lazily load SAM2 predictor on first use."""
    global _sam2_predictor
    if _sam2_predictor is not None:
        return _sam2_predictor

    if not _check_sam2():
        return None

    checkpoint = _get_checkpoint_path()
    if checkpoint is None:
        logger.warning("SAM2 checkpoint not found in models/ directory")
        return None

    try:
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        config = _get_config_for_checkpoint(checkpoint)
        runtime.configure_threads()
        device = runtime.torch_device()
        device_obj = runtime.torch_device_obj()
        logger.info(f"Loading SAM2 model: {checkpoint} on {device}")

        sam2_model = build_sam2(config, checkpoint, device=device_obj)
        # Apply dynamic INT8 quantization on CPU — speeds up Linear layers ~2×
        # with no accuracy loss for segmentation tasks.
        if device == "cpu":
            try:
                torch.quantization.quantize_dynamic(
                    sam2_model,
                    {torch.nn.Linear},
                    dtype=torch.qint8,
                    inplace=True,
                )
                logger.info("SAM2: applied dynamic INT8 quantization (CPU)")
            except Exception as _qe:
                logger.info(f"SAM2: dynamic quantization skipped ({_qe})")
        _sam2_predictor = SAM2ImagePredictor(sam2_model)
        logger.info("SAM2 model loaded successfully")
        return _sam2_predictor
    except Exception as e:
        logger.error(f"Failed to load SAM2: {e}")
        return None


def _load_auto_generator():
    """Lazily load SAM2 automatic mask generator."""
    global _sam2_auto_generator
    if _sam2_auto_generator is not None:
        return _sam2_auto_generator

    if not _check_sam2():
        return None

    checkpoint = _get_checkpoint_path()
    if checkpoint is None:
        return None

    try:
        import torch
        from sam2.build_sam import build_sam2
        from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator

        config = _get_config_for_checkpoint(checkpoint)
        runtime.configure_threads()
        device = runtime.torch_device()
        device_obj = runtime.torch_device_obj()

        sam2_model = build_sam2(config, checkpoint, device=device_obj)
        # Apply dynamic INT8 quantization on CPU (same as predictor path)
        if device == "cpu":
            try:
                torch.quantization.quantize_dynamic(
                    sam2_model,
                    {torch.nn.Linear},
                    dtype=torch.qint8,
                    inplace=True,
                )
                logger.info("SAM2 auto-gen: applied dynamic INT8 quantization (CPU)")
            except Exception as _qe:
                logger.info(f"SAM2 auto-gen: dynamic quantization skipped ({_qe})")
        _sam2_auto_generator = SAM2AutomaticMaskGenerator(
            model=sam2_model,
            points_per_side=32,
            pred_iou_thresh=0.65,          # lowered from 0.70 — real hardware elements have softer edges
            stability_score_thresh=0.80,   # lowered from 0.85 — low-contrast panels need more tolerance
            min_mask_region_area=150,      # lowered from 200 — catch smaller knobs/buttons on dense panels
        )
        return _sam2_auto_generator
    except Exception as e:
        logger.error(f"Failed to load SAM2 auto generator: {e}")
        return None


# ─── Image Helpers ───

def _b64_to_rgb(data_url: str) -> np.ndarray:
    """Decode base64 data URL to RGB numpy array."""
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


def _load_original_bgra(data_url: str) -> np.ndarray:
    """Decode base64 to BGRA numpy array for alpha masking."""
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


def _mask_only_b64(mask: np.ndarray) -> str:
    """Encode a single-channel mask as grayscale PNG base64."""
    _, buf = cv2.imencode(".png", mask)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _crop_masked(img_bgra: np.ndarray, mask_u8: np.ndarray):
    """Crop masked region and return (data_url, bounds, area)."""
    coords = cv2.findNonZero(mask_u8)
    if coords is None:
        return None
    bx, by, bw, bh = cv2.boundingRect(coords)

    crop_orig = img_bgra[by:by+bh, bx:bx+bw].copy()
    crop_mask = mask_u8[by:by+bh, bx:bx+bw]
    crop_orig[:, :, 3] = cv2.bitwise_and(crop_orig[:, :, 3], crop_mask)

    _, buf = cv2.imencode(".png", crop_orig)
    data_url = f"data:image/png;base64,{base64.b64encode(buf.tobytes()).decode('ascii')}"
    bounds = {"x": int(bx), "y": int(by), "width": int(bw), "height": int(bh)}
    area = int(cv2.countNonZero(mask_u8))
    return data_url, bounds, area


# ─── Public API ───

def check_sam2_available() -> dict:
    """Check SAM2 availability and return status info."""
    has_lib = _check_sam2()
    checkpoint = _get_checkpoint_path()
    rt = runtime.get_runtime()
    loaded_tier = None
    if checkpoint:
        base = os.path.basename(checkpoint).lower()
        for tier in ("base_plus", "large", "small", "tiny"):
            if tier in base:
                loaded_tier = tier
                break

    return {
        "available": has_lib and checkpoint is not None,
        "library_installed": has_lib,
        "checkpoint_found": checkpoint is not None,
        "checkpoint_path": checkpoint,
        "checkpoint_tier": loaded_tier,
        "recommended_tier": rt.sam2_tier,
        "device": rt.device,
        "gpu_available": rt.is_gpu,
        "install_hint": (
            "pip install sam2 torch torchvision && "
            "download checkpoint to python/models/sam2.1_hiera_tiny.pt"
        ) if not (has_lib and checkpoint) else None,
    }


def segment_point(
    image_b64: str,
    points: List[List[float]],
    labels: List[int],
    multimask: bool = True,
) -> dict:
    """Segment using point prompts.

    Args:
        image_b64: Base64 image
        points: List of [x, y] coordinates
        labels: List of 1 (foreground) or 0 (background) per point
        multimask: Return multiple masks ranked by quality

    Returns:
        dict with: masks (list of {dataUrl, score, bounds}), count, method
    """
    predictor = _load_sam2_predictor()

    if predictor is not None:
        return _sam2_segment_point(predictor, image_b64, points, labels, multimask)
    else:
        return _fallback_segment_point(image_b64, points, labels)


def segment_box(
    image_b64: str,
    box: List[float],
) -> dict:
    """Segment using a bounding box prompt.

    Args:
        image_b64: Base64 image
        box: [x1, y1, x2, y2] bounding box

    Returns:
        dict with: masks, count, method
    """
    predictor = _load_sam2_predictor()

    if predictor is not None:
        return _sam2_segment_box(predictor, image_b64, box)
    else:
        return _fallback_segment_box(image_b64, box)


def auto_segment(image_b64: str, min_area: int = 200) -> dict:
    """Automatically segment all objects in the image.

    Returns:
        dict with: segments (list of {dataUrl, bounds, area, score}), count, method
    """
    generator = _load_auto_generator()

    if generator is not None:
        return _sam2_auto_segment(generator, image_b64, min_area)
    else:
        return _fallback_auto_segment(image_b64, min_area)


# ─── SAM2 Implementations ───

def _sam2_segment_point(predictor, image_b64, points, labels, multimask):
    """Use SAM2 for point-based segmentation."""
    import torch

    img_rgb = _b64_to_rgb(image_b64)
    img_orig = _load_original_bgra(image_b64)

    predictor.set_image(img_rgb)

    input_points = np.array(points, dtype=np.float32)
    input_labels = np.array(labels, dtype=np.int32)

    masks, scores, _ = predictor.predict(
        point_coords=input_points,
        point_labels=input_labels,
        multimask_output=multimask,
    )

    results = []
    for i in range(len(masks)):
        mask_u8 = (masks[i].astype(np.uint8)) * 255
        cropped = _crop_masked(img_orig, mask_u8)
        if cropped is None:
            continue
        data_url, bounds, area = cropped
        results.append({
            "dataUrl": data_url,
            "score": round(float(scores[i]), 4),
            "bounds": bounds,
            "area": area,
            "mask_dataUrl": _mask_only_b64(mask_u8),
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return {"masks": results, "count": len(results), "method": "sam2"}


def _sam2_segment_box(predictor, image_b64, box):
    """Use SAM2 for box-based segmentation."""
    import torch

    img_rgb = _b64_to_rgb(image_b64)
    img_orig = _load_original_bgra(image_b64)

    predictor.set_image(img_rgb)

    input_box = np.array(box, dtype=np.float32)
    masks, scores, _ = predictor.predict(
        box=input_box,
        multimask_output=False,
    )

    results = []
    for i in range(len(masks)):
        mask_u8 = (masks[i].astype(np.uint8)) * 255
        cropped = _crop_masked(img_orig, mask_u8)
        if cropped is None:
            continue
        data_url, bounds, area = cropped
        results.append({
            "dataUrl": data_url,
            "score": round(float(scores[i]), 4),
            "bounds": bounds,
            "area": area,
            "mask_dataUrl": _mask_only_b64(mask_u8),
        })

    return {"masks": results, "count": len(results), "method": "sam2"}


def _sam2_auto_segment(generator, image_b64, min_area):
    """Use SAM2 automatic mask generator to find all objects."""
    img_rgb = _b64_to_rgb(image_b64)
    img_orig = _load_original_bgra(image_b64)

    masks_data = generator.generate(img_rgb)

    segments = []
    for m in masks_data:
        area = int(m["area"])
        if area < min_area:
            continue

        mask_u8 = (m["segmentation"].astype(np.uint8)) * 255
        bbox = m["bbox"]  # [x, y, w, h] from SAM2
        bx, by, bw, bh = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])

        crop_orig = img_orig[by:by+bh, bx:bx+bw].copy()
        crop_mask = mask_u8[by:by+bh, bx:bx+bw]
        crop_orig[:, :, 3] = cv2.bitwise_and(crop_orig[:, :, 3], crop_mask)

        _, buf = cv2.imencode(".png", crop_orig)
        data_url = f"data:image/png;base64,{base64.b64encode(buf.tobytes()).decode('ascii')}"

        segments.append({
            "dataUrl": data_url,
            "bounds": {"x": bx, "y": by, "width": bw, "height": bh},
            "area": area,
            "score": round(float(m.get("predicted_iou", 0.5)), 4),
            "stability": round(float(m.get("stability_score", 0.5)), 4),
        })

    segments.sort(key=lambda s: s["score"], reverse=True)
    return {"segments": segments, "count": len(segments), "method": "sam2"}


# ─── OpenCV Fallback Implementations ───

def _fallback_segment_point(image_b64, points, labels):
    """Fallback segmentation using OpenCV when SAM2 is not available.

    Uses the first positive point as seed for multi-strategy extraction.
    Negative points (label=0) are used to constrain the mask.
    """
    from extraction import (
        _adaptive_grabcut,
        _element_detect,
        _fill_holes,
        _keep_component_at,
        _refine_mask_edges,
        magic_wand,
    )

    # Find foreground and background points
    seed_x, seed_y = None, None
    negative_pts: list[tuple[int, int]] = []
    for pt, lbl in zip(points, labels):
        if lbl == 1 and seed_x is None:
            seed_x, seed_y = int(pt[0]), int(pt[1])
        elif lbl == 0:
            negative_pts.append((int(pt[0]), int(pt[1])))

    if seed_x is None:
        raise ValueError("At least one foreground point (label=1) is required")

    img_orig = _load_original_bgra(image_b64)
    img_bgr = cv2.cvtColor(img_orig, cv2.COLOR_BGRA2BGR)
    image_area = img_bgr.shape[0] * img_bgr.shape[1]

    def apply_negative_constraints(mask: np.ndarray) -> np.ndarray:
        """Zero out regions around negative points."""
        if not negative_pts:
            return mask
        for nx, ny in negative_pts:
            if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1]:
                if mask[ny, nx] > 0:
                    # Flood fill to remove the connected region at the negative point
                    num_labels, label_map = cv2.connectedComponents(mask)
                    neg_label = label_map[ny, nx]
                    if neg_label > 0:
                        # Only remove if it's a different component from the seed
                        seed_label = label_map[min(seed_y, mask.shape[0]-1), min(seed_x, mask.shape[1]-1)]
                        if neg_label != seed_label:
                            mask[label_map == neg_label] = 0
        return mask

    def score_mask(mask_u8: np.ndarray, strategy_bonus: float) -> float:
        coords = cv2.findNonZero(mask_u8)
        if coords is None:
            return 0.0
        area = int(cv2.countNonZero(mask_u8))
        if area < 40:
            return 0.0
        bx, by, bw, bh = cv2.boundingRect(coords)
        bbox_area = max(1, bw * bh)
        compactness = area / bbox_area
        rel_area = area / max(1, image_area)
        if rel_area > 0.65:
          return 0.0
        if rel_area < 0.0003:
          return 0.0
        cx = bx + bw / 2
        cy = by + bh / 2
        max_dist = max(bw, bh) / 2
        center_score = 1.0 if max_dist <= 0 else max(0.0, 1.0 - math.hypot(seed_x - cx, seed_y - cy) / max_dist)
        size_score = 1.0
        if rel_area > 0.25:
            size_score = 0.45
        elif rel_area > 0.12:
            size_score = 0.75
        elif rel_area < 0.002:
            size_score = 0.65
        # Convexity bonus: clean shapes score higher
        hull = cv2.convexHull(coords)
        hull_area = cv2.contourArea(hull)
        convexity = area / max(hull_area, 1) if hull_area > 0 else 0
        shape_bonus = 0.6 + 0.4 * min(convexity, 1.0)
        return compactness * (0.45 + 0.55 * center_score) * size_score * strategy_bonus * shape_bonus

    def mask_to_result(mask_u8: np.ndarray, score: float) -> dict | None:
        mask_u8 = _keep_component_at(mask_u8, seed_x, seed_y)
        mask_u8 = apply_negative_constraints(mask_u8)
        mask_u8 = _fill_holes(mask_u8)
        mask_u8 = _refine_mask_edges(img_bgr, mask_u8)
        cropped = _crop_masked(img_orig, mask_u8)
        if cropped is None:
            return None
        data_url, bounds, area = cropped
        return {
            "dataUrl": data_url,
            "score": round(float(score), 4),
            "bounds": bounds,
            "area": area,
            "mask_dataUrl": _mask_only_b64(mask_u8),
        }

    candidates: list[tuple[float, np.ndarray]] = []

    # More strategy combinations for better coverage on real device photos
    for tol, sens, bonus, skip_gc in [
        (38, 0.8, 1.15, False),   # balanced
        (26, 1.15, 1.05, True),   # tight/fast
        (48, 0.6, 1.0, True),     # generous tolerance
        (32, 1.5, 1.0, True),     # high edge sensitivity
    ]:
        mask = _element_detect(img_bgr, seed_x, seed_y, tolerance=tol,
                               edge_sensitivity=sens, skip_grabcut=skip_gc)
        if mask is not None:
            mask = apply_negative_constraints(mask)
            s = score_mask(mask, bonus)
            if s > 0:
                candidates.append((s, mask))

    # Dedicated GrabCut pass
    grabcut_mask = _adaptive_grabcut(img_bgr, seed_x, seed_y, tolerance=32)
    if grabcut_mask is not None:
        grabcut_mask = apply_negative_constraints(grabcut_mask)
        score = score_mask(grabcut_mask, 1.2)
        if score > 0:
            candidates.append((score, grabcut_mask))

    if not candidates:
        result = magic_wand(
            image_b64, seed_x, seed_y,
            tolerance=38, feather=1.0, expand=1, contiguous=True,
            mode="element", edge_sensitivity=0.8, refine_edges=True, fast=False,
        )
        return {
            "masks": [{
                "dataUrl": result["dataUrl"],
                "score": 0.55,
                "bounds": result["bounds"],
                "area": result["bounds"]["width"] * result["bounds"]["height"],
            }],
            "count": 1,
            "method": "opencv-fallback",
        }

    candidates.sort(key=lambda item: item[0], reverse=True)
    results = []
    seen_bounds = set()
    for score, mask in candidates:
        result = mask_to_result(mask, score)
        if result is None:
            continue
        bounds = result["bounds"]
        key = (bounds["x"], bounds["y"], bounds["width"], bounds["height"])
        if key in seen_bounds:
            continue
        seen_bounds.add(key)
        results.append(result)
        if len(results) >= 3:
            break

    return {
        "masks": results,
        "count": len(results),
        "method": "opencv-fallback",
    }


def _fallback_segment_box(image_b64, box):
    """Fallback box segmentation using GrabCut."""
    img_orig = _load_original_bgra(image_b64)
    img_bgr = cv2.cvtColor(img_orig, cv2.COLOR_BGRA2BGR)
    h, w = img_bgr.shape[:2]

    x1, y1, x2, y2 = int(box[0]), int(box[1]), int(box[2]), int(box[3])
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    rect = (x1, y1, x2 - x1, y2 - y1)
    mask_gc = np.zeros((h, w), dtype=np.uint8)
    bgd = np.zeros((1, 65), dtype=np.float64)
    fgd = np.zeros((1, 65), dtype=np.float64)

    try:
        cv2.grabCut(img_bgr, mask_gc, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    except cv2.error:
        mask_gc[y1:y2, x1:x2] = cv2.GC_FGD

    mask_u8 = np.where(
        (mask_gc == cv2.GC_FGD) | (mask_gc == cv2.GC_PR_FGD), 255, 0
    ).astype(np.uint8)

    cropped = _crop_masked(img_orig, mask_u8)
    if cropped is None:
        # Fallback: just crop the box
        crop = img_orig[y1:y2, x1:x2].copy()
        _, buf = cv2.imencode(".png", crop)
        data_url = f"data:image/png;base64,{base64.b64encode(buf.tobytes()).decode('ascii')}"
        return {
            "masks": [{"dataUrl": data_url, "score": 0.5,
                        "bounds": {"x": x1, "y": y1, "width": x2-x1, "height": y2-y1},
                        "area": (x2-x1)*(y2-y1)}],
            "count": 1, "method": "opencv-crop-fallback",
        }

    data_url, bounds, area = cropped
    return {
        "masks": [{"dataUrl": data_url, "score": 0.7, "bounds": bounds, "area": area}],
        "count": 1,
        "method": "opencv-grabcut-fallback",
    }


def _fallback_auto_segment(image_b64, min_area):
    """Fallback auto-segmentation using the production-grade batch detector.

    Uses batch_detect_components (multi-pass Hough circles + multi-strategy rect
    detection with CLAHE + bilateral filter + adaptive threshold).  This works on
    real device photos with low contrast between elements and background, unlike the
    original naive contour detector that only worked on white-background images.
    """
    try:
        from pro_features import batch_detect_components

        detections = batch_detect_components(
            image_b64,
            min_area=min_area,
            circle_bias=0.6,
        )

        segments = []
        for det in detections:
            b = det["bounds"]
            segments.append({
                "dataUrl": det.get("preview", ""),
                "bounds": b,
                "area": b["width"] * b["height"],
                "score": det["confidence"],
                "stability": round(det["confidence"] * 0.92, 4),
                "type": det.get("suggestedType", "unknown"),
            })

        return {"segments": segments, "count": len(segments), "method": "opencv-batch-fallback"}

    except Exception as _exc:
        logger.warning("batch_detect fallback failed (%s), using contour scan", _exc)
        from ai.component_detection import detect_components
        detections = detect_components(image_b64, min_area=min_area)
        segments = []
        for det in detections:
            segments.append({
                "dataUrl": det.get("preview", ""),
                "bounds": det["bounds"],
                "area": det["bounds"]["width"] * det["bounds"]["height"],
                "score": det["confidence"],
                "stability": det["confidence"] * 0.9,
                "type": det.get("type", "unknown"),
            })
        return {"segments": segments, "count": len(segments), "method": "opencv-contour-fallback"}
