"""Image extraction utilities for SynthSkin Studio."""

import io
import base64
import math
from typing import Optional

import cv2
import numpy as np
from PIL import Image


def _load_image(image_b64: str) -> np.ndarray:
    """Decode a base64 data-URL or raw base64 string into a BGR numpy array."""
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    raw = base64.b64decode(image_b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    return img


def _to_png_b64(img_bgra: np.ndarray) -> str:
    """Encode a BGRA image to a base64 data-URL PNG string."""
    _, buf = cv2.imencode(".png", img_bgra)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def extract_circle(image_b64: str, cx: float, cy: float, radius: float) -> dict:
    """Extract a circular region with anti-aliased alpha mask.

    Returns dict with keys: dataUrl (PNG base64), bounds {x,y,width,height}, centerPoint {x,y}.
    """
    img = _load_image(image_b64)
    h, w = img.shape[:2]

    # Convert to BGRA if needed
    if img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    cx_i, cy_i, r_i = int(round(cx)), int(round(cy)), int(round(radius))

    # Compute bounding box (clamped to image)
    x1 = max(0, cx_i - r_i)
    y1 = max(0, cy_i - r_i)
    x2 = min(w, cx_i + r_i)
    y2 = min(h, cy_i + r_i)
    bw, bh = x2 - x1, y2 - y1
    if bw <= 0 or bh <= 0:
        raise ValueError("Circle region is outside image bounds")

    # Crop region
    crop = img[y1:y2, x1:x2].copy()

    # Create anti-aliased circular alpha mask
    mask = np.zeros((bh, bw), dtype=np.uint8)
    local_cx = cx - x1
    local_cy = cy - y1
    cv2.circle(mask, (int(round(local_cx)), int(round(local_cy))), r_i, 255, -1, cv2.LINE_AA)

    # Apply mask to alpha channel
    crop[:, :, 3] = cv2.bitwise_and(crop[:, :, 3], mask)

    return {
        "dataUrl": _to_png_b64(crop),
        "bounds": {"x": x1, "y": y1, "width": bw, "height": bh},
        "centerPoint": {"x": round(cx, 1), "y": round(cy, 1)},
    }


def extract_rect(
    image_b64: str,
    x: float, y: float, w: float, h: float,
    angle: float = 0,
) -> dict:
    """Extract a rectangular region with optional rotation.

    Returns dict with keys: dataUrl (PNG base64), bounds {x,y,width,height}.
    """
    img = _load_image(image_b64)
    ih, iw = img.shape[:2]

    if img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    if abs(angle) < 0.5:
        # Simple axis-aligned crop
        x1 = max(0, int(round(x)))
        y1 = max(0, int(round(y)))
        x2 = min(iw, int(round(x + w)))
        y2 = min(ih, int(round(y + h)))
        if x2 <= x1 or y2 <= y1:
            raise ValueError("Rectangle region is outside image bounds")
        crop = img[y1:y2, x1:x2].copy()
        return {
            "dataUrl": _to_png_b64(crop),
            "bounds": {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1},
        }
    else:
        # Rotated rectangle extraction
        center = (x + w / 2, y + h / 2)
        M = cv2.getRotationMatrix2D(center, -angle, 1.0)
        rotated = cv2.warpAffine(img, M, (iw, ih), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        x1 = max(0, int(round(x)))
        y1 = max(0, int(round(y)))
        x2 = min(iw, int(round(x + w)))
        y2 = min(ih, int(round(y + h)))
        if x2 <= x1 or y2 <= y1:
            raise ValueError("Rectangle region is outside image bounds after rotation")
        crop = rotated[y1:y2, x1:x2].copy()
        return {
            "dataUrl": _to_png_b64(crop),
            "bounds": {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1},
        }


def warp_perspective(image_b64: str, src_points: list, dst_size: tuple) -> dict:
    """Perspective-correct a quadrilateral to a rectangle.

    src_points: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] - four corner points
    dst_size: (width, height) of output
    """
    img = _load_image(image_b64)
    if img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    src = np.float32(src_points)
    dw, dh = max(1, int(dst_size[0])), max(1, int(dst_size[1]))
    dst = np.float32([[0, 0], [dw, 0], [dw, dh], [0, dh]])

    # Validate convexity to prevent cv2.getPerspectiveTransform from crashing
    # on collinear / self-intersecting points.
    def _is_convex(pts: np.ndarray) -> bool:
        n = len(pts)
        for i in range(n):
            o = pts[i]
            a = pts[(i + 1) % n] - o
            b = pts[(i + 2) % n] - o
            if float(a[0] * b[1] - a[1] * b[0]) < 0:
                return False
        return True

    if not _is_convex(src) and not _is_convex(src[::-1]):
        raise ValueError(
            "Source points do not form a valid convex quadrilateral."
        )

    try:
        M = cv2.getPerspectiveTransform(src, dst)
    except cv2.error as exc:
        raise ValueError(
            f"Degenerate perspective corners: {exc}"
        ) from exc

    warped = cv2.warpPerspective(img, M, (dw, dh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)

    return {
        "dataUrl": _to_png_b64(warped),
        "bounds": {"x": 0, "y": 0, "width": dw, "height": dh},
    }


def detect_circles(image_b64: str, min_radius: int = 10, max_radius: int = 200) -> list:
    """Auto-detect circles in image using Hough Circle Transform.

    Returns list of {cx, cy, radius} dicts.
    """
    img = _load_image(image_b64)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img[:, :, 0]
    gray = cv2.GaussianBlur(gray, (9, 9), 2)

    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=min_radius * 2,
        param1=100,
        param2=40,
        minRadius=min_radius,
        maxRadius=max_radius,
    )

    if circles is None:
        return []

    result = []
    for c in circles[0]:
        result.append({
            "cx": round(float(c[0]), 1),
            "cy": round(float(c[1]), 1),
            "radius": round(float(c[2]), 1),
        })
    return result


def magic_wand(
    image_b64: str,
    seed_x: int, seed_y: int,
    tolerance: int = 32,
    feather: float = 0,
    expand: int = 0,
    contiguous: bool = True,
    mode: str = "element",
    edge_sensitivity: float = 1.0,
    refine_edges: bool = True,
    fast: bool = False,
) -> dict:
    """Smart magic wand selection with multiple strategies.

    Modes:
      - "element": Multi-strategy element extraction combining contour hierarchy,
        edge-aware flood fill, GrabCut, and color distance analysis.
      - "color": Traditional flood-fill by color similarity.
      - "invert": Flood-fill the BACKGROUND color, invert to get element.

    edge_sensitivity: 0.2–3.0, controls Canny threshold (lower = more edges detected)
    refine_edges: enable anti-aliased alpha matting along mask edges
    fast: skip GrabCut (slower strategy) for quick one-click extraction

    Returns dict with keys: dataUrl (PNG base64), bounds {x,y,width,height}.
    """
    img = _load_image(image_b64)
    ih, iw = img.shape[:2]

    if len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    img_bgr = img[:, :, :3].copy()

    seed_x = max(0, min(iw - 1, int(seed_x)))
    seed_y = max(0, min(ih - 1, int(seed_y)))

    if mode == "element":
        mask = _element_detect(img_bgr, seed_x, seed_y, tolerance, edge_sensitivity, skip_grabcut=fast)
    elif mode == "invert":
        mask = _invert_flood(img_bgr, seed_x, seed_y, tolerance, edge_sensitivity)
    else:
        mask = _color_flood(img_bgr, seed_x, seed_y, tolerance, contiguous)

    # Expand / contract
    if expand > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (expand * 2 + 1, expand * 2 + 1))
        mask = cv2.dilate(mask, kernel)
    elif expand < 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (abs(expand) * 2 + 1, abs(expand) * 2 + 1))
        mask = cv2.erode(mask, kernel)

    # Refine edges: generate anti-aliased alpha along the mask boundary
    if refine_edges and feather <= 0:
        mask = _refine_mask_edges(img_bgr, mask)

    # Feather
    if feather > 0:
        ksize = int(feather * 2) | 1
        mask = cv2.GaussianBlur(mask, (ksize, ksize), feather)

    # Apply mask to alpha
    result = img.copy()
    result[:, :, 3] = cv2.bitwise_and(result[:, :, 3], mask)

    # Find bounding box of non-zero alpha
    coords = cv2.findNonZero(mask)
    if coords is None:
        raise ValueError("No pixels selected — try clicking directly on an element or adjusting tolerance")
    bx, by, bw, bh = cv2.boundingRect(coords)

    # Add 1px padding for clean edges
    bx = max(0, bx - 1)
    by = max(0, by - 1)
    bw = min(iw - bx, bw + 2)
    bh = min(ih - by, bh + 2)

    crop = result[by:by + bh, bx:bx + bw].copy()

    return {
        "dataUrl": _to_png_b64(crop),
        "bounds": {"x": bx, "y": by, "width": bw, "height": bh},
    }


# ─── Pro Extraction ────────────────────────────────────────────

def pro_extract(
    image_b64: str,
    seed_x: int, seed_y: int,
    strategy: str = "auto",
    tolerance: int = 32,
    edge_sensitivity: float = 1.0,
    feather: float = 0,
    expand: int = 0,
    padding: int = 0,
    refine_edges: bool = True,
    quality: str = "standard",
    return_candidates: bool = False,
) -> dict:
    """Professional element extraction with full parameter control.

    Args:
        strategy: 'auto' | 'contour' | 'edge' | 'color' | 'grabcut' | 'invert'
        quality: 'fast' | 'standard' | 'high' (affects iterations and refinement)
        padding: pixels of transparent margin around the extracted element
        return_candidates: if True, return top 3 candidate extractions

    Returns dict with:
        dataUrl, bounds, candidates (if return_candidates)
    """
    img = _load_image(image_b64)
    ih, iw = img.shape[:2]

    if len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    img_bgr = img[:, :, :3].copy()
    seed_x = max(0, min(iw - 1, int(seed_x)))
    seed_y = max(0, min(ih - 1, int(seed_y)))

    skip_gc = quality == "fast"
    gc_iters = {"fast": 3, "standard": 5, "high": 8}.get(quality, 5)
    refine_band = {"fast": 2.0, "standard": 3.0, "high": 5.0}.get(quality, 3.0)

    # Collect candidate masks based on strategy
    candidates = []
    image_area = ih * iw

    if strategy == "auto":
        mask = _element_detect(img_bgr, seed_x, seed_y, tolerance,
                               edge_sensitivity, skip_grabcut=skip_gc)
        if mask is not None:
            candidates.append(("auto", mask))
        # Also run individual strategies if returning candidates
        if return_candidates:
            for strat_name, strat_fn in [
                ("contour", lambda: _contour_hierarchy_detect(img_bgr, seed_x, seed_y, edge_sensitivity)),
                ("edge", lambda: _edge_flood_detect(img_bgr, seed_x, seed_y, tolerance, edge_sensitivity)),
                ("color", lambda: _color_distance_segment(img_bgr, seed_x, seed_y, tolerance)),
            ]:
                try:
                    m = strat_fn()
                    if m is not None and cv2.countNonZero(m) > 50:
                        candidates.append((strat_name, m))
                except Exception:
                    pass
    elif strategy == "contour":
        mask = _contour_hierarchy_detect(img_bgr, seed_x, seed_y, edge_sensitivity)
        if mask is not None:
            candidates.append(("contour", mask))
    elif strategy == "edge":
        mask = _edge_flood_detect(img_bgr, seed_x, seed_y, tolerance, edge_sensitivity)
        if mask is not None:
            candidates.append(("edge", mask))
    elif strategy == "color":
        mask = _color_distance_segment(img_bgr, seed_x, seed_y, tolerance)
        if mask is not None:
            candidates.append(("color", mask))
    elif strategy == "grabcut":
        mask = _adaptive_grabcut(img_bgr, seed_x, seed_y, tolerance)
        if mask is not None:
            candidates.append(("grabcut", mask))
    elif strategy == "invert":
        mask = _invert_flood(img_bgr, seed_x, seed_y, tolerance, edge_sensitivity)
        if mask is not None:
            candidates.append(("invert", mask))

    if not candidates:
        # Fallback: generous color flood
        mask = _color_flood(img_bgr, seed_x, seed_y, max(tolerance, 48), True)
        candidates.append(("fallback", mask))

    def process_mask(mask: np.ndarray) -> np.ndarray:
        # Morphological cleanup
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k, iterations=1)
        mask = _fill_holes(mask)
        mask = _keep_component_at(mask, seed_x, seed_y)

        if expand > 0:
            ek = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (expand * 2 + 1, expand * 2 + 1))
            mask = cv2.dilate(mask, ek)
        elif expand < 0:
            ek = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (abs(expand) * 2 + 1, abs(expand) * 2 + 1))
            mask = cv2.erode(mask, ek)

        if refine_edges and feather <= 0:
            mask = _refine_mask_edges(img_bgr, mask, band_width=refine_band)
        if feather > 0:
            ksize = int(feather * 2) | 1
            mask = cv2.GaussianBlur(mask, (ksize, ksize), feather)
        return mask

    def extract_with_mask(mask: np.ndarray, name: str) -> dict:
        mask = process_mask(mask)
        result = img.copy()
        result[:, :, 3] = cv2.bitwise_and(result[:, :, 3], mask)

        coords = cv2.findNonZero(mask)
        if coords is None:
            raise ValueError("No pixels selected")
        bx, by, bw, bh = cv2.boundingRect(coords)

        # Apply padding
        pad = max(0, padding)
        bx_p = max(0, bx - pad)
        by_p = max(0, by - pad)
        bw_p = min(iw - bx_p, bw + pad * 2 + (bx - bx_p))
        bh_p = min(ih - by_p, bh + pad * 2 + (by - by_p))

        crop = result[by_p:by_p + bh_p, bx_p:bx_p + bw_p].copy()
        return {
            "dataUrl": _to_png_b64(crop),
            "bounds": {"x": bx_p, "y": by_p, "width": bw_p, "height": bh_p},
            "strategy": name,
        }

    # Process primary result
    primary = extract_with_mask(candidates[0][1], candidates[0][0])

    if return_candidates and len(candidates) > 1:
        alts = []
        seen = set()
        for name, mask in candidates[1:]:
            try:
                alt = extract_with_mask(mask, name)
                # Skip near-duplicates
                b = alt["bounds"]
                key = (b["x"] // 10, b["y"] // 10, b["width"] // 10, b["height"] // 10)
                if key not in seen:
                    seen.add(key)
                    alts.append(alt)
            except Exception:
                pass
        primary["candidates"] = alts[:3]

    return primary


# ─── Multi-Strategy Element Detection ───

def _local_contrast_score(img_bgr: np.ndarray, seed_x: int, seed_y: int, radius: int = 30) -> float:
    """Return the standard deviation of gray values in a patch around the seed.
    Values < 18: very low contrast (dark element on dark background).
    Values 18-40: medium contrast.
    Values > 40: high contrast.
    """
    ih, iw = img_bgr.shape[:2]
    y0, y1 = max(0, seed_y - radius), min(ih, seed_y + radius)
    x0, x1 = max(0, seed_x - radius), min(iw, seed_x + radius)
    patch = img_bgr[y0:y1, x0:x1]
    if patch.size == 0:
        return 50.0
    gray_patch = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return float(np.std(gray_patch))


def _apply_local_clahe(img_bgr: np.ndarray, clip_limit: float) -> np.ndarray:
    """Apply CLAHE in LAB L-channel to lift local contrast without hue shift."""
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l_ch, a_ch, b_ch = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8))
    l_eq = clahe.apply(l_ch)
    lab_eq = cv2.merge([l_eq, a_ch, b_ch])
    return cv2.cvtColor(lab_eq, cv2.COLOR_LAB2BGR)


def _element_detect(img_bgr: np.ndarray, seed_x: int, seed_y: int, tolerance: int,
                    edge_sensitivity: float = 1.0, skip_grabcut: bool = False) -> np.ndarray:
    """Multi-strategy element extraction. Tries several approaches and picks the best.

    Strategy pipeline:
      0. Adaptive CLAHE — applied when local contrast around the seed is low,
         lifts dark-on-dark or flat-textured surfaces before all other strategies
      1. Contour hierarchy — find tightest enclosing contour around click point
      2. Edge-bounded flood fill — Canny edges form walls, flood fill within
      3. Color distance segmentation — cluster by color distance from seed
      4. GrabCut with adaptive bbox — OpenCV foreground extraction (skipped if fast)
    Best result is the one with reasonable area that tightly encloses the seed.
    """
    ih, iw = img_bgr.shape[:2]
    image_area = ih * iw

    # ── Strategy 0: Contrast adaptation ─────────────────────────────────────
    local_std = _local_contrast_score(img_bgr, seed_x, seed_y)
    if local_std < 18:
        # Very low contrast — apply strong CLAHE before all strategies
        img_bgr = _apply_local_clahe(img_bgr, clip_limit=4.5)
        # Also lower edge_sensitivity so Canny captures soft boundaries
        edge_sensitivity = min(edge_sensitivity, 0.7)
    elif local_std < 35:
        # Medium contrast — moderate CLAHE
        img_bgr = _apply_local_clahe(img_bgr, clip_limit=2.5)
        edge_sensitivity = min(edge_sensitivity, 0.9)

    candidates = []

    # -- Strategy 1: Multi-scale contour hierarchy --
    mask_contour = _contour_hierarchy_detect(img_bgr, seed_x, seed_y, edge_sensitivity)
    if mask_contour is not None:
        area = cv2.countNonZero(mask_contour)
        if 50 < area < image_area * 0.7:
            candidates.append(("contour", mask_contour, area))

    # -- Strategy 2: Edge-bounded flood fill (multi-scale Canny) --
    mask_edge = _edge_flood_detect(img_bgr, seed_x, seed_y, tolerance, edge_sensitivity)
    if mask_edge is not None:
        area = cv2.countNonZero(mask_edge)
        if 50 < area < image_area * 0.7:
            candidates.append(("edge_flood", mask_edge, area))

    # -- Strategy 3: Color distance segmentation --
    mask_cdist = _color_distance_segment(img_bgr, seed_x, seed_y, tolerance)
    if mask_cdist is not None:
        area = cv2.countNonZero(mask_cdist)
        if 50 < area < image_area * 0.5:
            candidates.append(("color_dist", mask_cdist, area))

    # -- Strategy 4: GrabCut with adaptive bbox (slow, skip for fast mode) --
    if not skip_grabcut:
        mask_gc = _adaptive_grabcut(img_bgr, seed_x, seed_y, tolerance)
        if mask_gc is not None:
            area = cv2.countNonZero(mask_gc)
            if 50 < area < image_area * 0.7:
                candidates.append(("grabcut", mask_gc, area))

    if not candidates:
        # Last resort: generous flood fill
        return _color_flood(img_bgr, seed_x, seed_y, max(tolerance, 48), True)

    # Score each candidate: prefer smallest area that still contains the seed region
    best_mask = _pick_best_candidate(candidates, seed_x, seed_y, image_area)

    # Morphological cleanup
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    best_mask = cv2.morphologyEx(best_mask, cv2.MORPH_CLOSE, k, iterations=2)
    best_mask = cv2.morphologyEx(best_mask, cv2.MORPH_OPEN, k, iterations=1)

    # Fill internal holes
    best_mask = _fill_holes(best_mask)

    return best_mask


def _pick_best_candidate(candidates, seed_x, seed_y, image_area):
    """Score and rank candidates, return best mask."""
    scored = []
    for name, mask, area in candidates:
        # Check seed is inside mask
        seed_in = mask[seed_y, seed_x] > 0

        # Compactness: area / bounding-box area (higher = more compact shape)
        coords = cv2.findNonZero(mask)
        if coords is None:
            continue
        bx, by, bw, bh = cv2.boundingRect(coords)
        bbox_area = bw * bh
        compactness = area / bbox_area if bbox_area > 0 else 0

        # Relative size: prefer smaller but not tiny
        rel_size = area / image_area
        size_score = 1.0
        if rel_size < 0.0005:
            size_score = 0.2  # too small — likely noise
        elif rel_size < 0.002:
            size_score = 0.6
        elif rel_size > 0.5:
            size_score = 0.1  # almost certainly background
        elif rel_size > 0.3:
            size_score = 0.3
        elif rel_size > 0.15:
            size_score = 0.6

        # Seed proximity: is the seed near the center of the mask?
        cx = bx + bw / 2
        cy = by + bh / 2
        max_dist = max(bw, bh) / 2
        dist = math.sqrt((seed_x - cx) ** 2 + (seed_y - cy) ** 2)
        center_score = max(0, 1.0 - dist / max_dist) if max_dist > 0 else 0

        # Strategy bonus: contour and grabcut tend to be more precise
        strategy_bonus = 1.0
        if name == "contour":
            strategy_bonus = 1.15
        elif name == "grabcut":
            strategy_bonus = 1.2
        elif name == "edge_flood":
            strategy_bonus = 1.05

        # Shape regularity bonus: convex hull ratio rewards clean shapes
        hull = cv2.convexHull(coords)
        hull_area = cv2.contourArea(hull)
        convexity = area / max(hull_area, 1) if hull_area > 0 else 0
        shape_bonus = 0.5 + 0.5 * min(convexity, 1.0)

        score = (
            (1.0 if seed_in else 0.05) *  # strong penalty if seed not inside
            compactness *
            size_score *
            (0.4 + 0.6 * center_score) *
            strategy_bonus *
            shape_bonus
        )

        scored.append((score, name, mask))

    scored.sort(key=lambda x: x[0], reverse=True)
    best_mask = scored[0][2]

    # If the best mask is very large and a more compact alternative exists, prefer it
    best_area = cv2.countNonZero(best_mask)
    best_rel = best_area / max(1, image_area)
    if best_rel > 0.15 and len(scored) > 1:
        for s, name, mask in scored[1:]:
            alt_area = cv2.countNonZero(mask)
            alt_rel = alt_area / max(1, image_area)
            if alt_rel < best_rel * 0.5 and alt_rel > 0.001 and s > scored[0][0] * 0.5:
                best_mask = mask
                break

    return best_mask


def _contour_hierarchy_detect(img_bgr: np.ndarray, seed_x: int, seed_y: int,
                               edge_sensitivity: float) -> np.ndarray | None:
    """Find the tightest contour enclosing the click point using multi-scale Canny.

    Uses Gaussian + bilateral pre-filtering for robustness on textured surfaces.
    Compactness filter is adaptive: real hardware often has soft / blurry edges
    that produce low-compactness contours — these should not be discarded unless
    they look like pure noise (compactness < 0.03).
    """
    ih, iw = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # CLAHE before bilateral to lift contrast on dark hardware panels
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    gray_eq = clahe.apply(gray)

    # Bilateral filter preserves edges while smoothing texture
    bilateral = cv2.bilateralFilter(gray_eq, d=9, sigmaColor=75, sigmaSpace=75)
    bilateral_orig = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)

    best_contour = None
    best_area = float('inf')

    # Multiple pre-filtered sources + scales → higher recall on real-device images
    prefiltered = [
        (gray_eq,        [0.8, 1.5, 2.5, 4.0]),   # CLAHE-enhanced
        (bilateral,      [1.0, 2.0, 3.5]),          # bilateral on CLAHE
        (bilateral_orig, [1.0, 2.5]),               # bilateral on raw (extra pass)
    ]
    for src, sigmas in prefiltered:
        for sigma in sigmas:
            ksize = int(sigma * 4) | 1
            blurred = cv2.GaussianBlur(src, (ksize, ksize), sigma)

            # Use local median (not global) to handle very dark/bright images
            median_val = float(np.median(blurred))
            if median_val < 10:
                median_val = 30.0   # floor: avoid near-zero thresholds on dark images
            factor = 1.0 / max(0.2, edge_sensitivity)
            lo = int(max(5, (0.35 * median_val) * factor))
            hi = int(min(255, (1.1 * median_val) * factor))

            edges = cv2.Canny(blurred, lo, hi)
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, k, iterations=2)

            contours, hierarchy = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            if not contours or hierarchy is None:
                continue

            for cnt in contours:
                if cv2.pointPolygonTest(cnt, (float(seed_x), float(seed_y)), False) >= 0:
                    area = cv2.contourArea(cnt)
                    if 30 < area < best_area and area < ih * iw * 0.7:
                        peri = cv2.arcLength(cnt, True)
                        if peri > 0:
                            compactness = (4 * math.pi * area) / (peri * peri)
                            # Threshold 0.03 (was 0.08): real hardware contours are
                            # less compact than clean white-background images because
                            # texture/reflections fragment edges into irregular shapes.
                            if compactness < 0.03:
                                continue  # pure noise / stray fragment
                        best_contour = cnt
                        best_area = area

    if best_contour is None:
        return None

    mask = np.zeros((ih, iw), dtype=np.uint8)
    cv2.drawContours(mask, [best_contour], -1, 255, -1)
    return mask


def _edge_flood_detect(img_bgr: np.ndarray, seed_x: int, seed_y: int,
                        tolerance: int, edge_sensitivity: float) -> np.ndarray | None:
    """Edge-bounded flood fill using multi-scale fused edge map.

    Adapts the edge-fusion threshold to local contrast around the seed point:
    - High-contrast images (bright element on dark bg): require 2+ scales to agree
      → avoids texture noise from metal/plastic surfaces
    - Low-contrast images (dark element on dark bg): accept edges from any 1 scale
      → ensures element boundaries are detected at all
    """
    ih, iw = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # ── Measure local contrast around the seed to choose fusion aggressiveness ──
    pad = 25
    ly0, ly1 = max(0, seed_y - pad), min(ih, seed_y + pad)
    lx0, lx1 = max(0, seed_x - pad), min(iw, seed_x + pad)
    local_patch = gray[ly0:ly1, lx0:lx1]
    local_std = float(np.std(local_patch)) if local_patch.size > 0 else 50.0
    # Low contrast: std < 18 (nearly uniform patch around the click)
    # Medium contrast: 18–40
    # High contrast: > 40
    if local_std < 18:
        min_scale_votes = 1   # accept any single-scale edge
        clahe_clip = 4.0      # strong local enhancement
    elif local_std < 40:
        min_scale_votes = 2   # two scales must agree
        clahe_clip = 2.5
    else:
        min_scale_votes = 2   # normal — two scales
        clahe_clip = 1.5

    # Apply CLAHE to lift local contrast before edge detection
    clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8))
    enhanced_gray = clahe.apply(gray)

    # Bilateral filter preserves edges while smoothing textures
    smooth = cv2.bilateralFilter(enhanced_gray, d=9, sigmaColor=75, sigmaSpace=75)

    # Multi-scale Canny fusion
    edge_accum = np.zeros((ih, iw), dtype=np.float32)
    for sigma in [1.0, 2.0, 3.5]:
        ksize = int(sigma * 4) | 1
        blurred = cv2.GaussianBlur(smooth, (ksize, ksize), sigma)
        median_val = float(np.median(blurred))
        factor = 1.0 / max(0.2, edge_sensitivity)
        lo = int(max(5, (0.35 * median_val) * factor))
        hi = int(min(255, (1.1 * median_val) * factor))
        edges = cv2.Canny(blurred, lo, hi)
        edge_accum += edges.astype(np.float32)

    # Adaptive threshold: low-contrast images only need min_scale_votes scales to agree
    edge_fused = ((edge_accum >= min_scale_votes * 255) * 255).astype(np.uint8)

    # Morphological closing to seal gaps
    close_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    edge_fused = cv2.morphologyEx(edge_fused, cv2.MORPH_CLOSE, close_k, iterations=2)

    # Dilate to thicken walls
    dilate_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
    edge_wall = cv2.dilate(edge_fused, dilate_k, iterations=1)

    # Flood fill in the fillable (non-edge) space
    fillable = cv2.bitwise_not(edge_wall)
    mask_ff = np.zeros((ih + 2, iw + 2), dtype=np.uint8)
    cv2.floodFill(
        fillable.copy(), mask_ff,
        (seed_x, seed_y),
        newVal=128,
        loDiff=(tolerance,),
        upDiff=(tolerance,),
        flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8),
    )
    mask = mask_ff[1:-1, 1:-1]

    non_zero = cv2.countNonZero(mask)
    if non_zero < 50:
        return None

    return mask


def _color_distance_segment(img_bgr: np.ndarray, seed_x: int, seed_y: int,
                             tolerance: int) -> np.ndarray | None:
    """Segment by color distance from seed pixel in Lab color space.
    Lab is perceptually uniform, so distance correlates with visual difference.
    """
    ih, iw = img_bgr.shape[:2]
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab).astype(np.float32)

    seed_color = lab[seed_y, seed_x]

    # Euclidean distance in Lab space
    diff = lab - seed_color
    dist = np.sqrt(np.sum(diff ** 2, axis=2))

    # Scale tolerance to Lab range (Lab L=0-100, a,b=-127..128)
    lab_tolerance = tolerance * 1.5

    # Soft threshold with sigmoid falloff
    mask_float = 1.0 / (1.0 + np.exp((dist - lab_tolerance) * 0.3))
    mask = (mask_float * 255).astype(np.uint8)

    # Threshold to binary
    _, mask_bin = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

    # Keep only the connected component at seed
    mask_bin = _keep_component_at(mask_bin, seed_x, seed_y)

    non_zero = cv2.countNonZero(mask_bin)
    if non_zero < 50:
        return None

    return mask_bin


def _adaptive_grabcut(img_bgr: np.ndarray, seed_x: int, seed_y: int,
                       tolerance: int) -> np.ndarray | None:
    """GrabCut with adaptive bounding box sized by local contrast analysis."""
    ih, iw = img_bgr.shape[:2]

    # Analyze local contrast to estimate element size
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    grad_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient_mag = np.sqrt(grad_x ** 2 + grad_y ** 2)

    # Find distance to nearest strong gradient from seed (that's roughly the element edge)
    grad_thresh = np.percentile(gradient_mag, 80)
    strong_edges = (gradient_mag > grad_thresh).astype(np.uint8)

    # Scan outward from seed in 8 directions to find edge distances
    directions = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)]
    edge_dists = []
    for dx, dy in directions:
        px, py = seed_x, seed_y
        dist = 0
        max_scan = max(iw, ih) // 2
        while 0 <= px < iw and 0 <= py < ih and dist < max_scan:
            if strong_edges[py, px]:
                break
            px += dx
            py += dy
            dist += 1
        edge_dists.append(dist)

    # Use median distance as element half-size, with padding
    median_dist = int(np.median(edge_dists))
    box_half = max(30, min(median_dist + 20, min(iw, ih) // 2))

    x1 = max(0, seed_x - box_half)
    y1 = max(0, seed_y - box_half)
    x2 = min(iw, seed_x + box_half)
    y2 = min(ih, seed_y + box_half)

    if x2 - x1 < 20 or y2 - y1 < 20:
        return None

    rect = (x1, y1, x2 - x1, y2 - y1)
    mask_gc = np.zeros((ih, iw), dtype=np.uint8)
    bgd = np.zeros((1, 65), dtype=np.float64)
    fgd = np.zeros((1, 65), dtype=np.float64)

    try:
        cv2.grabCut(img_bgr, mask_gc, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    except cv2.error:
        return None

    output = np.where((mask_gc == cv2.GC_FGD) | (mask_gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    output = _keep_component_at(output, seed_x, seed_y)

    non_zero = cv2.countNonZero(output)
    if non_zero < 50:
        return None

    return output


# ─── Edge Refinement (Anti-aliased Alpha Matting) ───

def _refine_mask_edges(img_bgr: np.ndarray, mask: np.ndarray, band_width: float = 3.0) -> np.ndarray:
    """Produce smooth anti-aliased edges using guided-filter-like local alpha matting.
    Takes the binary mask and the source image, produces soft alpha along borders.
    """
    # Find border pixels (narrow band around mask edge)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    dilated = cv2.dilate(mask, k, iterations=1)
    eroded = cv2.erode(mask, k, iterations=1)
    border = cv2.subtract(dilated, eroded)

    # In the border region, compute alpha from local gradient alignment
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    grad_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient_mag = np.sqrt(grad_x ** 2 + grad_y ** 2)

    # Normalize gradient in border region
    border_f = border.astype(np.float32) / 255.0
    max_grad = gradient_mag.max()
    if max_grad > 0:
        grad_normalized = gradient_mag / max_grad
    else:
        grad_normalized = np.zeros_like(gradient_mag)

    # Distance transform from mask interior
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5).astype(np.float32)
    dist_inv = cv2.distanceTransform(cv2.bitwise_not(mask), cv2.DIST_L2, 5).astype(np.float32)

    # Alpha ramp: smooth transition in the border band
    alpha_ramp = np.clip(dist / band_width, 0, 1)

    # In border zone, modulate by gradient (strong edges = sharper cutoff)
    refined = mask.astype(np.float32) / 255.0
    border_mask = border_f > 0
    refined[border_mask] = alpha_ramp[border_mask] * (0.7 + 0.3 * grad_normalized[border_mask])

    # Slight blur for smooth anti-aliasing
    refined = cv2.GaussianBlur(refined, (3, 3), 0.8)

    return (np.clip(refined, 0, 1) * 255).astype(np.uint8)


# ─── Utility Functions ───

def _fill_holes(mask: np.ndarray) -> np.ndarray:
    """Fill internal holes in a binary mask."""
    ih, iw = mask.shape[:2]
    # Flood fill from the border to find external background
    flood = mask.copy()
    # Create a slightly larger mask for floodFill
    ff_mask = np.zeros((ih + 2, iw + 2), dtype=np.uint8)
    cv2.floodFill(flood, ff_mask, (0, 0), 255)
    # Invert: holes become white
    holes = cv2.bitwise_not(flood)
    # Combine original mask with holes
    return cv2.bitwise_or(mask, holes)


def _keep_component_at(mask: np.ndarray, x: int, y: int) -> np.ndarray:
    """Keep only the connected component in mask that contains point (x, y)."""
    num_labels, labels = cv2.connectedComponents(mask)
    if num_labels <= 1:
        return mask

    target_label = labels[y, x]
    if target_label == 0:
        coords = cv2.findNonZero(mask)
        if coords is None:
            return mask
        dists = np.sqrt((coords[:, 0, 0] - x) ** 2 + (coords[:, 0, 1] - y) ** 2)
        nearest_idx = np.argmin(dists)
        nx, ny = coords[nearest_idx, 0]
        target_label = labels[ny, nx]

    return np.where(labels == target_label, 255, 0).astype(np.uint8)


def _invert_flood(img_bgr: np.ndarray, seed_x: int, seed_y: int, tolerance: int,
                  edge_sensitivity: float = 1.0) -> np.ndarray:
    """Select background via flood fill from corners, invert to get elements.
    Uses multi-seed approach + edge-guided refinement.
    """
    ih, iw = img_bgr.shape[:2]

    # Sample background color from image corners
    corner_size = max(5, min(iw, ih) // 20)
    corners = [
        img_bgr[0:corner_size, 0:corner_size],
        img_bgr[0:corner_size, iw - corner_size:iw],
        img_bgr[ih - corner_size:ih, 0:corner_size],
        img_bgr[ih - corner_size:ih, iw - corner_size:iw],
    ]

    # Multi-seed flood fill from all four corners
    corner_centers = [
        (corner_size // 2, corner_size // 2),
        (iw - corner_size // 2, corner_size // 2),
        (corner_size // 2, ih - corner_size // 2),
        (iw - corner_size // 2, ih - corner_size // 2),
    ]

    bg_mask = np.zeros((ih, iw), dtype=np.uint8)
    for cx, cy in corner_centers:
        mask_ff = np.zeros((ih + 2, iw + 2), dtype=np.uint8)
        cv2.floodFill(
            img_bgr.copy(), mask_ff,
            (cx, cy),
            newVal=(0, 0, 0),
            loDiff=(tolerance, tolerance, tolerance),
            upDiff=(tolerance, tolerance, tolerance),
            flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8),
        )
        bg_mask = cv2.bitwise_or(bg_mask, mask_ff[1:-1, 1:-1])

    # Also try color-distance based background detection for gradient backgrounds
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab).astype(np.float32)
    bg_pixels = np.concatenate([c.reshape(-1, 3) for c in corners], axis=0)
    bg_lab = cv2.cvtColor(bg_pixels.reshape(1, -1, 3).astype(np.uint8), cv2.COLOR_BGR2Lab).astype(np.float32).reshape(-1, 3)
    bg_center = np.median(bg_lab, axis=0)
    bg_dist = np.sqrt(np.sum((lab - bg_center) ** 2, axis=2))
    bg_color_mask = (bg_dist < tolerance * 1.8).astype(np.uint8) * 255
    bg_mask = cv2.bitwise_or(bg_mask, bg_color_mask)

    # Invert
    fg_mask = cv2.bitwise_not(bg_mask)

    # Cleanup
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, kernel, iterations=1)

    # Remove small specs (noise)
    fg_mask = _remove_small_components(fg_mask, min_area=100)

    # Keep only the component at the click point
    fg_mask = _keep_component_at(fg_mask, seed_x, seed_y)

    return fg_mask


def _remove_small_components(mask: np.ndarray, min_area: int = 100) -> np.ndarray:
    """Remove connected components smaller than min_area."""
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    result = np.zeros_like(mask)
    for i in range(1, num_labels):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            result[labels == i] = 255
    return result


def _color_flood(img_bgr: np.ndarray, seed_x: int, seed_y: int, tolerance: int, contiguous: bool) -> np.ndarray:
    """Classic flood-fill color selection."""
    ih, iw = img_bgr.shape[:2]

    if contiguous:
        mask_ff = np.zeros((ih + 2, iw + 2), dtype=np.uint8)
        cv2.floodFill(
            img_bgr.copy(), mask_ff,
            (seed_x, seed_y),
            newVal=(0, 0, 0),
            loDiff=(tolerance, tolerance, tolerance),
            upDiff=(tolerance, tolerance, tolerance),
            flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8),
        )
        return mask_ff[1:-1, 1:-1]
    else:
        seed_color = img_bgr[seed_y, seed_x].astype(np.int16)
        diff = np.abs(img_bgr.astype(np.int16) - seed_color)
        within = np.all(diff <= tolerance, axis=2)
        return (within * 255).astype(np.uint8)


# ─── Polygon / Lasso Extraction ──────────────────────────────────────────────

def extract_polygon(
    image_b64: str,
    points: list,
    feather: float = 0,
    expand: int = 0,
    refine_edges: bool = True,
) -> dict:
    """Extract a region bounded by a freehand or polygonal lasso path.

    points: list of [x, y] pairs in image coordinates.
    feather: blur radius for soft edges (0 = hard edge).
    expand: positive = grow mask, negative = shrink mask.
    refine_edges: apply edge-guided anti-aliasing along the polygon boundary.

    Returns dict with keys: dataUrl (PNG base64), bounds {x,y,width,height}.
    """
    img = _load_image(image_b64)
    ih, iw = img.shape[:2]

    if img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    if len(points) < 3:
        raise ValueError("Polygon requires at least 3 points")

    pts = np.array([[int(round(p[0])), int(round(p[1]))] for p in points], dtype=np.int32)

    # Create filled polygon mask
    mask = np.zeros((ih, iw), dtype=np.uint8)
    cv2.fillPoly(mask, [pts], 255)

    # Expand / contract selection
    if expand > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (expand * 2 + 1, expand * 2 + 1))
        mask = cv2.dilate(mask, kernel)
    elif expand < 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (abs(expand) * 2 + 1, abs(expand) * 2 + 1))
        mask = cv2.erode(mask, kernel)

    # Edge refinement (anti-aliased alpha matting along polygon border)
    img_bgr = img[:, :, :3].copy()
    if refine_edges and feather <= 0:
        mask = _refine_mask_edges(img_bgr, mask, band_width=2.5)

    # Feather
    if feather > 0:
        ksize = int(feather * 2) | 1
        mask = cv2.GaussianBlur(mask, (ksize, ksize), feather)

    # Apply mask to alpha
    result = img.copy()
    result[:, :, 3] = cv2.bitwise_and(result[:, :, 3], mask)

    # Bounding box with 1px padding
    coords = cv2.findNonZero(mask)
    if coords is None:
        raise ValueError("No pixels in polygon selection — check your points")
    bx, by, bw, bh = cv2.boundingRect(coords)
    bx = max(0, bx - 1)
    by = max(0, by - 1)
    bw = min(iw - bx, bw + 2)
    bh = min(ih - by, bh + 2)

    crop = result[by:by + bh, bx:bx + bw].copy()
    return {
        "dataUrl": _to_png_b64(crop),
        "bounds": {"x": bx, "y": by, "width": bw, "height": bh},
    }


# ─── Refine Edge (Photoshop-Style Post-Extraction Refinement) ─────────────────

def refine_extraction(
    image_b64: str,
    mask_b64: str,
    radius: float = 3.0,
    smooth: int = 0,
    feather: float = 0,
    contrast: float = 0,
    shift_edge: float = 0,
) -> dict:
    """Refine an existing extraction mask — equivalent to Photoshop's 'Refine Edge'.

    Args:
        image_b64: original source image (base64 PNG/JPEG) used for edge detection.
        mask_b64:  current extraction result (BGRA PNG, alpha channel = mask).
        radius:    local refinement band width in pixels (1–20). Higher = wider
                   detection zone around edges for hair/fur/fine detail.
        smooth:    morphological smoothing iterations (0–10).
        feather:   Gaussian blur half-radius for soft edges (0 = hard).
        contrast:  sharpens/softens the alpha ramp: +100 = hard choke,
                   -100 = full feather out. Range −100 to +100.
        shift_edge: grow (+) / shrink (-) mask by percentage of image diagonal,
                    range −100 to +100.

    Returns dict with: dataUrl (refined PNG, base64), bounds {x,y,width,height}.
    """
    # Load source image
    src = _load_image(image_b64)
    if src.shape[2] == 3:
        src = cv2.cvtColor(src, cv2.COLOR_BGR2BGRA)
    ih, iw = src.shape[:2]

    # Load existing mask from extracted PNG alpha channel
    if mask_b64.startswith("data:"):
        mask_b64_raw = mask_b64.split(",", 1)[1]
    else:
        mask_b64_raw = mask_b64
    mask_raw = np.frombuffer(base64.b64decode(mask_b64_raw), dtype=np.uint8)
    mask_img = cv2.imdecode(mask_raw, cv2.IMREAD_UNCHANGED)
    if mask_img is None:
        raise ValueError("Failed to decode mask image")

    # Extract alpha channel as binary mask (threshold at 128)
    if mask_img.ndim == 4:
        alpha = mask_img[:, :, 3]
    elif mask_img.ndim == 3:
        # Grayscale from color (take luminance)
        alpha = cv2.cvtColor(mask_img, cv2.COLOR_BGR2GRAY)
    else:
        alpha = mask_img

    # Scale mask to source image size if dimensions differ (extracted crop → full image)
    b_h, b_w = mask_img.shape[:2]
    # We need the bounds to position the crop mask back into the full image
    # Since the caller should pass the full mask at source resolution, we
    # accept a full-size mask or a crop mask with explicit bounds.
    # For simplicity we work in full image space — the caller must pass full-res mask.
    if b_h != ih or b_w != iw:
        alpha = cv2.resize(alpha, (iw, ih), interpolation=cv2.INTER_LINEAR)

    _, binary_mask = cv2.threshold(alpha, 64, 255, cv2.THRESH_BINARY)
    img_bgr = src[:, :, :3].copy()

    # ── shift_edge: grow / shrink ────────────────────────────────────
    if shift_edge != 0:
        diag = math.sqrt(iw ** 2 + ih ** 2)
        px = int(round(abs(shift_edge) / 100.0 * diag * 0.1))  # up to 10% diagonal
        px = max(1, min(px, 80))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (px * 2 + 1, px * 2 + 1))
        if shift_edge > 0:
            binary_mask = cv2.dilate(binary_mask, kernel)
        else:
            binary_mask = cv2.erode(binary_mask, kernel)

    # ── smooth: morphological ────────────────────────────────────────
    if smooth > 0:
        iters = max(1, min(smooth, 10))
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        binary_mask = cv2.morphologyEx(binary_mask, cv2.MORPH_CLOSE, k, iterations=iters)
        binary_mask = cv2.morphologyEx(binary_mask, cv2.MORPH_OPEN, k, iterations=iters)

    # ── radius: smart edge refinement in band around border ──────────
    radius = max(0.5, min(radius, 25.0))
    refined = _refine_mask_edges(img_bgr, binary_mask, band_width=radius)

    # ── contrast: sharpen or soften the alpha ramp ───────────────────
    if contrast != 0:
        alpha_f = refined.astype(np.float32) / 255.0
        # Sigmoid-like contrast curve
        c = contrast / 100.0  # -1 to +1
        if c > 0:
            # Sharpen: push values toward 0 or 1
            alpha_f = np.where(alpha_f > 0.5,
                               0.5 + (alpha_f - 0.5) * (1 + c * 2),
                               0.5 - (0.5 - alpha_f) * (1 + c * 2))
        else:
            # Soften: compress toward 0.5
            alpha_f = 0.5 + (alpha_f - 0.5) * (1 + c)
        refined = (np.clip(alpha_f, 0, 1) * 255).astype(np.uint8)

    # ── feather: Gaussian blur ────────────────────────────────────────
    if feather > 0:
        ksize = int(feather * 2) | 1
        refined = cv2.GaussianBlur(refined, (ksize, ksize), feather)

    # Apply refined alpha to source image
    result = src.copy()
    result[:, :, 3] = refined

    # Compute bounding box
    coords = cv2.findNonZero(refined)
    if coords is None:
        raise ValueError("Refined mask is empty")
    bx, by, bw, bh = cv2.boundingRect(coords)
    bx = max(0, bx - 1)
    by = max(0, by - 1)
    bw = min(iw - bx, bw + 2)
    bh = min(ih - by, bh + 2)
    crop = result[by:by + bh, bx:bx + bw].copy()

    return {
        "dataUrl": _to_png_b64(crop),
        "bounds": {"x": bx, "y": by, "width": bw, "height": bh},
    }


# ─── Mask Combination (Selection Modifiers) ──────────────────────────────────

def combine_masks(
    image_b64: str,
    mask_a_b64: str,
    mask_b_b64: str,
    mode: str = "add",
) -> dict:
    """Combine two extraction masks (selection modifiers).

    mode:
        "add"       — union (Shift-draw to add to selection)
        "subtract"  — difference (Alt-draw to remove from selection)
        "intersect" — overlap only (both selections must overlap)

    Both mask_a_b64 and mask_b_b64 should be full-resolution BGRA PNGs at the
    same dimensions as image_b64.

    Returns dict with: dataUrl (combined PNG, base64), bounds.
    """
    # Load source image (to get dimensions + for applying alpha)
    img = _load_image(image_b64)
    ih, iw = img.shape[:2]
    if img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    def _load_mask(b64: str) -> np.ndarray:
        if b64.startswith("data:"):
            b64 = b64.split(",", 1)[1]
        raw = np.frombuffer(base64.b64decode(b64), dtype=np.uint8)
        m = cv2.imdecode(raw, cv2.IMREAD_UNCHANGED)
        if m is None:
            raise ValueError("Failed to decode mask")
        if m.ndim == 4:
            alpha = m[:, :, 3]
        elif m.ndim == 3:
            alpha = cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)
        else:
            alpha = m
        if alpha.shape[0] != ih or alpha.shape[1] != iw:
            alpha = cv2.resize(alpha, (iw, ih), interpolation=cv2.INTER_LINEAR)
        _, binary = cv2.threshold(alpha, 64, 255, cv2.THRESH_BINARY)
        return binary

    mask_a = _load_mask(mask_a_b64)
    mask_b = _load_mask(mask_b_b64)

    if mode == "add":
        combined = cv2.bitwise_or(mask_a, mask_b)
    elif mode == "subtract":
        combined = cv2.bitwise_and(mask_a, cv2.bitwise_not(mask_b))
    elif mode == "intersect":
        combined = cv2.bitwise_and(mask_a, mask_b)
    else:
        raise ValueError(f"Unknown combine mode: {mode!r}. Use 'add', 'subtract', or 'intersect'.")

    # Light cleanup
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, k, iterations=1)

    # Apply to source image
    result = img.copy()
    result[:, :, 3] = cv2.bitwise_and(result[:, :, 3], combined)

    coords = cv2.findNonZero(combined)
    if coords is None:
        raise ValueError("Combined mask is empty")
    bx, by, bw, bh = cv2.boundingRect(coords)
    bx = max(0, bx - 1)
    by = max(0, by - 1)
    bw = min(iw - bx, bw + 2)
    bh = min(ih - by, bh + 2)
    crop = result[by:by + bh, bx:bx + bw].copy()

    return {
        "dataUrl": _to_png_b64(crop),
        "bounds": {"x": bx, "y": by, "width": bw, "height": bh},
        "mode": mode,
    }
