"""Batch detection and color variant utilities for SynthSkin Studio (Phase 7)."""

import io
import base64
import math
from typing import List, Tuple, Optional

import cv2
import numpy as np
from PIL import Image, ImageEnhance


# 1200 px is sufficient for knob counting; was 2400 (4× more pixels = 4× slower)
DETECTION_MAX_DIM = 1200
MAX_CONTOURS_PER_PASS = 300
MAX_TOTAL_CONTOURS = 600
# Cap: prevents O(N) Canny call explosion on images with many circular shapes
MAX_CANDIDATES_TO_SCORE = 120
PREVIEW_SIZE = 128  # Higher quality previews


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


def _to_png_b64(img: np.ndarray) -> str:
    """Encode a BGRA/BGR image to a base64 data-URL PNG string."""
    _, buf = cv2.imencode(".png", img)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _limit_contours(contours: List[np.ndarray], limit: int) -> List[np.ndarray]:
    if len(contours) <= limit:
        return list(contours)
    return sorted(contours, key=cv2.contourArea, reverse=True)[:limit]


# ─── Batch Detection ───────────────────────────────────────────

def batch_detect_components(
    image_b64: str,
    min_area: int = 200,
    max_area: int = 0,
    circle_bias: float = 0.6,
) -> List[dict]:
    """Detect UI components using multi-strategy detection.

    Strategies:
    1. Multi-pass Hough circles + contour-circularity scan for knobs
    2. Circle boundary expansion to find full knob outlines (not partial)
    3. Concentric edge scoring for robust knob validation
    4. Multi-scale edge + gradient + adaptive threshold for rectangles
    5. NMS with containment awareness

    Returns list of detection dicts with:
        id, type (circle|rect), bounds {x,y,w,h}, confidence, center,
        radius (if circle), preview (base64 thumbnail), suggestedType
    """
    orig_img = _load_image(image_b64)
    orig_h, orig_w = orig_img.shape[:2]

    if len(orig_img.shape) == 2:
        orig_img = cv2.cvtColor(orig_img, cv2.COLOR_GRAY2BGRA)
    elif orig_img.shape[2] == 3:
        orig_img = cv2.cvtColor(orig_img, cv2.COLOR_BGR2BGRA)

    detection_scale = min(1.0, DETECTION_MAX_DIM / max(orig_w, orig_h))
    if detection_scale < 1.0:
        detect_w = max(1, int(round(orig_w * detection_scale)))
        detect_h = max(1, int(round(orig_h * detection_scale)))
        img = cv2.resize(orig_img, (detect_w, detect_h), interpolation=cv2.INTER_AREA)
    else:
        img = orig_img.copy()
        detect_h, detect_w = orig_h, orig_w

    h, w = detect_h, detect_w
    inv_scale = 1.0 / detection_scale if detection_scale > 0 else 1.0

    def to_orig(x, y):
        if detection_scale >= 1.0:
            return int(x), int(y)
        return (max(0, min(orig_w - 1, int(round(x * inv_scale)))),
                max(0, min(orig_h - 1, int(round(y * inv_scale)))))

    def box_to_orig(x1, y1, x2, y2):
        if detection_scale >= 1.0:
            return int(x1), int(y1), int(x2), int(y2)
        ox1, oy1 = to_orig(x1, y1)
        ox2, oy2 = to_orig(x2, y2)
        return ox1, oy1, max(ox1 + 1, ox2), max(oy1 + 1, oy2)

    def orig_bounds(x1, y1, x2, y2):
        ox1, oy1, ox2, oy2 = box_to_orig(x1, y1, x2, y2)
        return {"x": ox1, "y": oy1, "width": ox2 - ox1, "height": oy2 - oy1}

    if max_area <= 0:
        max_area = int(w * h * 0.25)

    gray = cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    detections = []
    used_regions: List[Tuple[int, int, int, int]] = []

    # ─── Phase 1: Circle / Knob detection ───
    min_r = max(8, int(min(w, h) * 0.012))
    max_r = min(int(min(w, h) * 0.30), 600)

    circle_candidates = _find_circle_candidates(enhanced, gray, min_r, max_r, w, h)
    # Real hardware panels often have tiny colored LEDs that are too small or
    # too soft-edged for Hough. Add HSV-colored circular blobs as candidates.
    circle_candidates.extend(_find_colored_led_candidates(img, min_r, max_r, w, h))

    # Cap before scoring to prevent O(N) Canny blow-up on complex images
    if len(circle_candidates) > MAX_CANDIDATES_TO_SCORE:
        circle_candidates = circle_candidates[:MAX_CANDIDATES_TO_SCORE]

    # Pre-compute edge maps ONCE — all candidates share the same enhanced image
    _edges_expand = cv2.Canny(enhanced, 40, 120)
    _edges1 = cv2.Canny(enhanced, 30, 100)
    _edges2 = cv2.Canny(enhanced, 50, 150)
    _edges_score = cv2.bitwise_or(_edges1, _edges2)

    # Score, validate, expand, and filter
    scored_circles: List[Tuple[int, int, int, float, int, int, int, int]] = []
    for cx, cy, r, source in circle_candidates:
        area = math.pi * r * r
        if area < max(min_area * 0.4, 80) or area > max_area:
            continue
        x1 = max(0, cx - r)
        y1 = max(0, cy - r)
        x2 = min(w, cx + r)
        y2 = min(h, cy + r)
        bw_, bh_ = x2 - x1, y2 - y1
        if bw_ <= 4 or bh_ <= 4:
            continue
        aspect = bw_ / max(bh_, 1)
        if aspect > 1.45 or aspect < 0.69:
            continue

        # Try to expand circle to find true full boundary
        expanded_r = _try_expand_circle(enhanced, cx, cy, r, min_r, max_r,
                                        precomputed_edges=_edges_expand)
        if expanded_r > r:
            r = expanded_r
            x1 = max(0, cx - r)
            y1 = max(0, cy - r)
            x2 = min(w, cx + r)
            y2 = min(h, cy + r)

        conf = _score_circle(enhanced, gray, cx, cy, r, precomputed_edges=_edges_score)
        # Contour-sourced detections already passed circularity → bonus
        if source == "contour":
            conf = min(conf + 0.08, 1.0)
        if conf < 0.22:
            continue
        scored_circles.append((cx, cy, r, conf, x1, y1, x2, y2))

    scored_circles.sort(key=lambda c: c[3], reverse=True)
    kept_circles: List[Tuple[int, int, int, float, int, int, int, int]] = []
    for item in scored_circles:
        cx, cy, r, conf, x1, y1, x2, y2 = item
        if not _overlaps_any(x1, y1, x2, y2,
                             [(k[4], k[5], k[6], k[7]) for k in kept_circles],
                             threshold=0.30):
            kept_circles.append(item)

    for cx, cy, r, conf, x1, y1, x2, y2 in kept_circles:
        ocx, ocy = to_orig(cx, cy)
        oradius = max(1, int(round(r * inv_scale)))
        preview = _extract_circle_preview(orig_img, ocx, ocy, oradius)
        adjusted_conf = min(conf * (circle_bias / 0.6), 1.0)
        suggested_type = _classify_circle_component(gray, img, cx, cy, r, w, h)
        det = {
            "type": "circle",
            "bounds": orig_bounds(x1, y1, x2, y2),
            "center": {"x": ocx, "y": ocy},
            "radius": oradius,
            "confidence": round(adjusted_conf, 2),
            "preview": preview,
            "suggestedType": suggested_type,
        }
        detections.append(det)
        used_regions.append((x1, y1, x2, y2))

    # ─── Phase 2: Rectangular component detection ───
    rect_min = max(min_area, int(w * h * 0.0002))
    rect_candidates = _find_rect_candidates(enhanced, gray, rect_min, max_area, w, h)
    rect_candidates.extend(_find_slider_candidates(enhanced, gray, rect_min, max_area, w, h))
    rect_candidates.sort(key=lambda c: c[4], reverse=True)  # sort by confidence

    for rx1, ry1, rx2, ry2, rconf, suggested in rect_candidates:
        if _overlaps_any(rx1, ry1, rx2, ry2, used_regions, threshold=0.35):
            continue

        ox1, oy1, ox2, oy2 = box_to_orig(rx1, ry1, rx2, ry2)
        crop = orig_img[oy1:oy2, ox1:ox2].copy()
        preview = _make_thumb(crop, PREVIEW_SIZE)
        cxr, cyr = to_orig(rx1 + (rx2 - rx1) // 2, ry1 + (ry2 - ry1) // 2)

        det = {
            "type": "rect",
            "bounds": orig_bounds(rx1, ry1, rx2, ry2),
            "center": {"x": cxr, "y": cyr},
            "confidence": round(rconf, 2),
            "preview": preview,
            "suggestedType": suggested,
        }
        detections.append(det)
        used_regions.append((rx1, ry1, rx2, ry2))

    # ─── Phase 3: Merge nearby same-type + final cleanup ───
    detections = _merge_nearby_detections(detections)
    detections = [d for d in detections if d["confidence"] >= 0.35]
    detections.sort(key=lambda d: d["confidence"], reverse=True)
    detections = detections[:48]

    for i, d in enumerate(detections):
        d["id"] = f"det_{i}"

    return detections


# ─── Circle Detection Helpers ──────────────────────────────────

def _find_circle_candidates(
    enhanced: np.ndarray, gray: np.ndarray,
    min_r: int, max_r: int, w: int, h: int,
) -> List[Tuple[int, int, int, str]]:
    """Find circle candidates via Hough circles AND contour circularity scan.
    Returns list of (cx, cy, radius, source) where source is 'hough' or 'contour'."""
    candidates: List[Tuple[int, int, int, str]] = []

    # ── Strategy 1: Multi-pass Hough circles ──
    for blur_k, dp, p1, p2, min_dist_mult in [
        (7, 1.2, 80, 35, 1.5),
        (9, 1.2, 100, 45, 2.0),
        (5, 1.0, 60, 28, 1.2),
        (11, 1.5, 120, 55, 2.5),
    ]:
        blurred = cv2.GaussianBlur(enhanced, (blur_k, blur_k), 2)
        circles = cv2.HoughCircles(
            blurred, cv2.HOUGH_GRADIENT,
            dp=dp,
            minDist=max(min_r * min_dist_mult, 20),
            param1=p1, param2=p2,
            minRadius=min_r, maxRadius=max_r,
        )
        if circles is not None:
            for c in np.round(circles[0]).astype(int):
                candidates.append((int(c[0]), int(c[1]), int(c[2]), "hough"))

    # ── Strategy 2: Contour circularity scan ──
    # This catches knobs that Hough misses (textured surfaces, soft edges)
    for canny_lo, canny_hi in [(30, 90), (50, 150), (80, 200)]:
        edges = cv2.Canny(enhanced, canny_lo, canny_hi)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=1)
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contours = _limit_contours(contours, MAX_CONTOURS_PER_PASS)

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < math.pi * min_r * min_r * 0.5:
                continue
            peri = cv2.arcLength(cnt, True)
            if peri < 1:
                continue
            circularity = (4 * math.pi * area) / (peri * peri)
            if circularity < 0.70:
                continue
            # This contour is circular — compute enclosing circle
            (cx, cy), radius = cv2.minEnclosingCircle(cnt)
            cx, cy, radius = int(cx), int(cy), int(radius)
            if radius < min_r or radius > max_r:
                continue
            # Verify the contour actually fills the enclosing circle well
            enc_area = math.pi * radius * radius
            fill_ratio = area / max(enc_area, 1)
            if fill_ratio < 0.45:
                continue
            candidates.append((cx, cy, radius, "contour"))

    # ── Strategy 3: Adaptive threshold for low-contrast knobs ──
    blurred = cv2.GaussianBlur(enhanced, (7, 7), 0)
    adaptive = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 31, 6
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    adaptive = cv2.morphologyEx(adaptive, cv2.MORPH_OPEN, kernel, iterations=1)
    adaptive = cv2.morphologyEx(adaptive, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(adaptive, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = _limit_contours(contours, MAX_CONTOURS_PER_PASS)

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < math.pi * min_r * min_r * 0.5:
            continue
        peri = cv2.arcLength(cnt, True)
        if peri < 1:
            continue
        circularity = (4 * math.pi * area) / (peri * peri)
        if circularity < 0.72:
            continue
        (cx, cy), radius = cv2.minEnclosingCircle(cnt)
        cx, cy, radius = int(cx), int(cy), int(radius)
        if radius < min_r or radius > max_r:
            continue
        enc_area = math.pi * radius * radius
        fill_ratio = area / max(enc_area, 1)
        if fill_ratio < 0.45:
            continue
        candidates.append((cx, cy, radius, "contour"))

    # Deduplicate: merge candidates within 0.3*r of each other
    deduped: List[Tuple[int, int, int, str]] = []
    for cx, cy, r, src in candidates:
        merged = False
        for i, (ex, ey, er, es) in enumerate(deduped):
            dist = math.sqrt((cx - ex) ** 2 + (cy - ey) ** 2)
            if dist < max(r, er) * 0.35:
                # Keep the one with larger radius (more likely to be the full knob)
                if r > er:
                    deduped[i] = (cx, cy, r, src)
                merged = True
                break
        if not merged:
            deduped.append((cx, cy, r, src))

    return deduped


def _find_colored_led_candidates(
    bgra: np.ndarray, min_r: int, max_r: int, w: int, h: int,
) -> List[Tuple[int, int, int, str]]:
    """Find small saturated round blobs (LEDs) missed by edge detectors."""
    bgr = cv2.cvtColor(bgra, cv2.COLOR_BGRA2BGR) if bgra.shape[2] == 4 else bgra
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]

    # Saturated + bright: red/green/yellow/blue LEDs. Keep threshold moderate
    # because real-panel photos can be under-exposed or desaturated.
    mask = ((sat > 55) & (val > 70)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
                            iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
                            iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: List[Tuple[int, int, int, str]] = []
    img_area = w * h
    for cnt in _limit_contours(contours, 120):
        area = cv2.contourArea(cnt)
        if area < 12 or area > img_area * 0.01:
            continue
        peri = cv2.arcLength(cnt, True)
        if peri <= 0:
            continue
        circularity = 4 * math.pi * area / (peri * peri)
        if circularity < 0.45:
            continue
        (cx, cy), radius = cv2.minEnclosingCircle(cnt)
        cx, cy, radius = int(cx), int(cy), int(round(radius))
        if radius < max(3, min_r // 2) or radius > min(max_r, int(0.04 * min(w, h))):
            continue
        candidates.append((cx, cy, radius, "color"))
    return candidates


def _classify_circle_component(
    gray: np.ndarray, bgra: np.ndarray, cx: int, cy: int, r: int, w: int, h: int,
) -> str:
    """Classify a circular detection as knob/button/LED using size, colour and texture."""
    img_area = max(1, w * h)
    rel_area = (math.pi * r * r) / img_area
    x1, y1 = max(0, cx - r), max(0, cy - r)
    x2, y2 = min(w, cx + r), min(h, cy + r)
    roi_gray = gray[y1:y2, x1:x2]
    roi = bgra[y1:y2, x1:x2]
    if roi_gray.size == 0:
        return "knob"

    yy, xx = np.ogrid[y1:y2, x1:x2]
    dist2 = (xx - cx) ** 2 + (yy - cy) ** 2
    disk = dist2 <= (0.82 * r) ** 2
    if not disk.any():
        return "knob"

    bgr = cv2.cvtColor(roi, cv2.COLOR_BGRA2BGR) if roi.shape[2] == 4 else roi
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat_mean = float(np.mean(hsv[:, :, 1][disk]))
    val_mean = float(np.mean(hsv[:, :, 2][disk]))
    val_std = float(np.std(hsv[:, :, 2][disk]))
    gray_std = float(np.std(roi_gray[disk]))

    # Tiny, saturated, bright circles are LEDs/status lamps, not knobs.
    if rel_area < 0.0016 and sat_mean > 45 and val_mean > 75:
        return "led"
    if r <= max(8, int(0.012 * min(w, h))) and sat_mean > 35 and val_mean > 90:
        return "led"

    # Concentric edge/brightness variation is the strongest cheap knob cue.
    edges = cv2.Canny(cv2.GaussianBlur(roi_gray, (5, 5), 1), 25, 100)
    ring_scores = []
    for frac in (0.35, 0.55, 0.75, 0.95):
        inner = max(1, int(r * (frac - 0.06)))
        outer = max(inner + 1, int(r * (frac + 0.06)))
        mask = (dist2 >= inner * inner) & (dist2 <= outer * outer)
        if mask.shape != edges.shape or not mask.any():
            continue
        ring_scores.append(float(np.count_nonzero(edges[mask])) / max(1, int(mask.sum())))
    concentric = sum(1 for s in ring_scores if s > 0.08)

    # Small flat circles without texture are usually push buttons/caps.
    if rel_area < 0.0035 and concentric < 2 and gray_std < 38 and val_std < 45:
        return "button"
    if r < int(0.025 * min(w, h)) and concentric < 2 and sat_mean < 60:
        return "button"

    return "knob"


def _try_expand_circle(
    enhanced: np.ndarray, cx: int, cy: int, r: int,
    min_r: int, max_r: int,
    precomputed_edges: Optional[np.ndarray] = None,
) -> int:
    """Try to expand a detected circle outward to find the true full boundary.

    Knobs often have an inner circle detected by Hough while the true knob
    boundary is larger. This searches outward for the strongest concentric edge.
    Returns the expanded radius, or the original if no better boundary found.
    """
    h, w = enhanced.shape
    if r < 10:
        return r

    # Search from current radius up to 2x current (but capped by max_r)
    search_max = min(max_r, int(r * 2.2))
    if search_max <= r + 3:
        return r

    # Use pre-computed edges when supplied (avoids one Canny call per candidate)
    edges = precomputed_edges if precomputed_edges is not None else cv2.Canny(enhanced, 40, 120)

    best_r = r
    best_score = _ring_edge_density(edges, cx, cy, r, w, h)

    # Sample at increasing radii
    step = max(2, r // 8)
    for test_r in range(r + step, search_max, step):
        score = _ring_edge_density(edges, cx, cy, test_r, w, h)
        if score > best_score * 1.15:  # Must be significantly better
            best_score = score
            best_r = test_r

    # Refine around the best radius found
    if best_r != r:
        fine_start = max(r, best_r - step)
        fine_end = min(search_max, best_r + step)
        for test_r in range(fine_start, fine_end + 1, max(1, step // 3)):
            score = _ring_edge_density(edges, cx, cy, test_r, w, h)
            if score > best_score:
                best_score = score
                best_r = test_r

    return best_r


def _ring_edge_density(
    edges: np.ndarray, cx: int, cy: int, r: int, w: int, h: int,
) -> float:
    """Measure edge density along a circle perimeter (vectorised)."""
    n_samples = max(36, r * 2)
    search_w = max(2, int(r * 0.04))
    angles = np.linspace(0, 2 * math.pi, n_samples, endpoint=False)
    px = np.round(cx + r * np.cos(angles)).astype(np.int32)
    py = np.round(cy + r * np.sin(angles)).astype(np.int32)
    valid = (px >= 0) & (px < w) & (py >= 0) & (py < h)
    if not valid.any():
        return 0.0
    total = int(valid.sum())
    hits = 0
    for i in np.where(valid)[0]:
        x, y = int(px[i]), int(py[i])
        y1 = max(0, y - search_w)
        y2 = min(h, y + search_w + 1)
        x1 = max(0, x - search_w)
        x2 = min(w, x + search_w + 1)
        if edges[y1:y2, x1:x2].any():
            hits += 1
    return hits / max(total, 1)


def _score_circle(
    enhanced: np.ndarray, gray: np.ndarray,
    cx: int, cy: int, r: int,
    precomputed_edges: Optional[np.ndarray] = None,
) -> float:
    """Score a circle candidate using multiple validation metrics.

    Metrics:
    1. Edge density along perimeter (primary)
    2. Octant distribution uniformity (penalizes squares)
    3. Concentric edge pattern (real knobs have edges at multiple radii)
    4. Interior uniformity (not random noise)
    """
    h, w = enhanced.shape

    # Use pre-computed edges when supplied (avoids two Canny calls per candidate)
    if precomputed_edges is not None:
        edges = precomputed_edges
    else:
        edges1 = cv2.Canny(enhanced, 30, 100)
        edges2 = cv2.Canny(enhanced, 50, 150)
        edges = cv2.bitwise_or(edges1, edges2)

    n_samples = max(36, r * 3)
    search_w = max(2, int(r * 0.05))
    hits = 0
    total = 0
    octant_hits = [0] * 8
    octant_total = [0] * 8

    for k in range(n_samples):
        angle = 2 * math.pi * k / n_samples
        octant = int((angle * 8) / (2 * math.pi)) % 8
        px = int(cx + r * math.cos(angle))
        py = int(cy + r * math.sin(angle))
        if not (0 <= px < w and 0 <= py < h):
            continue
        total += 1
        octant_total[octant] += 1
        found = False
        for dx in range(-search_w, search_w + 1):
            for dy in range(-search_w, search_w + 1):
                nx, ny = px + dx, py + dy
                if 0 <= nx < w and 0 <= ny < h and edges[ny, nx] > 0:
                    found = True
                    break
            if found:
                break
        if found:
            hits += 1
            octant_hits[octant] += 1

    if total == 0:
        return 0.0

    edge_ratio = hits / total

    # ── Octant analysis: penalize square-like distributions ──
    if n_samples >= 24:
        diag_hits = sum(octant_hits[i] for i in [1, 3, 5, 7])
        diag_total = sum(octant_total[i] for i in [1, 3, 5, 7])
        cardinal_hits = sum(octant_hits[i] for i in [0, 2, 4, 6])
        cardinal_total = sum(octant_total[i] for i in [0, 2, 4, 6])
        if diag_total > 0 and cardinal_total > 0:
            diag_r = diag_hits / diag_total
            cardinal_r = cardinal_hits / cardinal_total
            if cardinal_r > 0.4 and diag_r < cardinal_r * 0.35:
                edge_ratio *= 0.5  # heavy penalty

    # ── Concentric confidence: check for edges at inner radii ──
    # Real knobs often have features at multiple concentric radii
    concentric_bonus = 0.0
    for frac in [0.5, 0.7, 0.85]:
        inner_r = max(3, int(r * frac))
        inner_density = _ring_edge_density(edges, cx, cy, inner_r, w, h)
        if inner_density > 0.15:
            concentric_bonus += 0.03

    # ── Interior check ──
    inner_r = max(1, r // 3)
    iy1 = max(0, cy - inner_r)
    iy2 = min(h, cy + inner_r)
    ix1 = max(0, cx - inner_r)
    ix2 = min(w, cx + inner_r)
    inner = gray[iy1:iy2, ix1:ix2]
    if inner.size > 0:
        inner_std = float(np.std(inner))
        if inner_std > 80:
            edge_ratio *= 0.7

    return min(edge_ratio + concentric_bonus, 1.0)


# ─── Rectangle Detection Helpers ──────────────────────────────

def _find_rect_candidates(
    enhanced: np.ndarray, gray: np.ndarray,
    min_area: int, max_area: int, w: int, h: int,
) -> List[Tuple[int, int, int, int, float, str]]:
    """Find rectangular components via multi-strategy contour analysis.

    Real-device robustness improvements:
    - Bilateral pre-filter on all Canny passes → suppresses metallic/plastic texture noise
      while preserving real structural edges (display bezels, slider rails, button outlines).
    - Median floor for Canny thresholds → prevents near-zero thresholds on dark images.
    - Stronger CLAHE pass (Strategy E) → lifts contrast on dark-on-dark panels.

    Returns list of (x1, y1, x2, y2, confidence, suggested_type) in detection coords.
    """
    # ── Pre-filter: bilateral on enhanced and raw for texture suppression ──────
    bilateral_enh = cv2.bilateralFilter(enhanced, d=9, sigmaColor=60, sigmaSpace=60)
    bilateral_raw = cv2.bilateralFilter(gray,     d=9, sigmaColor=60, sigmaSpace=60)

    # Adaptive Canny thresholds — floor at 30 to avoid near-zero on dark images
    median_val = max(30.0, float(np.median(enhanced)))
    lo = int(max(20, 0.5 * median_val))
    hi = int(min(250, 1.5 * median_val))
    close_k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))

    all_contours: List[np.ndarray] = []

    # Strategy A: Canny on bilateral-filtered CLAHE-enhanced (primary path)
    edges = cv2.Canny(bilateral_enh, lo, hi)
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, close_k, iterations=1)
    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    all_contours.extend(_limit_contours(cnts, MAX_CONTOURS_PER_PASS))

    # Strategy B: Canny on bilateral-filtered raw gray (different contrast response)
    edges2 = cv2.Canny(bilateral_raw, max(20, lo - 15), min(250, hi + 15))
    closed2 = cv2.morphologyEx(edges2, cv2.MORPH_CLOSE, close_k, iterations=1)
    cnts2, _ = cv2.findContours(closed2, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    all_contours.extend(_limit_contours(cnts2, MAX_CONTOURS_PER_PASS))

    # Strategy C: Gradient magnitude for screens/displays (robust to absolute brightness)
    sobelx = cv2.Sobel(bilateral_enh, cv2.CV_64F, 1, 0, ksize=3)
    sobely = cv2.Sobel(bilateral_enh, cv2.CV_64F, 0, 1, ksize=3)
    grad_mag = np.sqrt(sobelx ** 2 + sobely ** 2)
    grad_max = grad_mag.max()
    if grad_max > 0:
        grad_norm = np.clip(grad_mag / grad_max * 255, 0, 255).astype(np.uint8)
        _, grad_thresh = cv2.threshold(grad_norm, 35, 255, cv2.THRESH_BINARY)
        grad_dilated = cv2.dilate(grad_thresh, close_k, iterations=2)
        big_k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        grad_closed = cv2.morphologyEx(grad_dilated, cv2.MORPH_CLOSE, big_k, iterations=2)
        cnts3, _ = cv2.findContours(grad_closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnts3 = [c for c in cnts3 if cv2.contourArea(c) >= max(min_area * 3, 1500)]
        all_contours.extend(_limit_contours(cnts3, MAX_CONTOURS_PER_PASS))

    # Strategy D: Adaptive threshold for low-contrast UIs (works on bilateral)
    blurred = cv2.GaussianBlur(bilateral_enh, (7, 7), 0)
    adaptive = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 31, 6
    )
    open_k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    adaptive = cv2.morphologyEx(adaptive, cv2.MORPH_OPEN, open_k, iterations=1)
    adaptive = cv2.morphologyEx(adaptive, cv2.MORPH_CLOSE, close_k, iterations=2)
    cnts4, _ = cv2.findContours(adaptive, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnts4 = [c for c in cnts4 if cv2.contourArea(c) >= max(min_area, 500)]
    all_contours.extend(_limit_contours(cnts4, MAX_CONTOURS_PER_PASS))

    # Strategy E: Stronger CLAHE pass for dark real-device panels
    # (clipLimit=4 finds edges invisible to the standard CLAHE at clipLimit=2)
    clahe_strong = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(4, 4))
    strong_enh = clahe_strong.apply(gray)
    strong_bilateral = cv2.bilateralFilter(strong_enh, d=9, sigmaColor=50, sigmaSpace=50)
    med_s = max(30.0, float(np.median(strong_bilateral)))
    edges5 = cv2.Canny(strong_bilateral,
                       int(max(15, 0.4 * med_s)),
                       int(min(255, 1.2 * med_s)))
    closed5 = cv2.morphologyEx(edges5, cv2.MORPH_CLOSE, close_k, iterations=2)
    cnts5, _ = cv2.findContours(closed5, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnts5 = [c for c in cnts5 if cv2.contourArea(c) >= max(min_area, 400)]
    all_contours.extend(_limit_contours(cnts5, MAX_CONTOURS_PER_PASS))

    all_contours = _limit_contours(all_contours, MAX_TOTAL_CONTOURS)

    results: List[Tuple[int, int, int, int, float, str]] = []
    seen_boxes: List[Tuple[int, int, int, int]] = []

    for cnt in all_contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue

        x1, y1, bw_, bh_ = cv2.boundingRect(cnt)
        x2, y2 = x1 + bw_, y1 + bh_
        if bw_ < 12 or bh_ < 12:
            continue

        aspect = bw_ / max(bh_, 1)
        peri = cv2.arcLength(cnt, True)
        if peri == 0:
            continue
        circularity = (4 * math.pi * area) / (peri * peri)

        # Skip very circular shapes (handled by circle detection)
        if circularity > 0.85:
            continue

        rect_fill = area / max(bw_ * bh_, 1)
        if rect_fill < 0.2:
            continue

        hull = cv2.convexHull(cnt)
        hull_area = cv2.contourArea(hull)
        solidity = area / max(hull_area, 1)
        if solidity < 0.4:
            continue

        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        n_verts = len(approx)
        if n_verts > 20:
            continue

        # Dedup rectangles
        if _overlaps_any(x1, y1, x2, y2, seen_boxes, threshold=0.50):
            continue

        rel_area = area / (w * h)
        suggested = _classify_rect_component(aspect, bw_, bh_, circularity,
                                             rect_fill, solidity, rel_area)
        conf = _compute_rect_confidence(rect_fill, solidity, aspect,
                                        circularity, n_verts)

        results.append((x1, y1, x2, y2, conf, suggested))
        seen_boxes.append((x1, y1, x2, y2))

    return results


def _find_slider_candidates(
    enhanced: np.ndarray, gray: np.ndarray,
    min_area: int, max_area: int, w: int, h: int,
) -> List[Tuple[int, int, int, int, float, str]]:
    """Dedicated rail/fader detector for thin slider tracks missed by contours."""
    edges = cv2.Canny(cv2.GaussianBlur(enhanced, (3, 3), 0), 25, 110)
    candidates: List[Tuple[int, int, int, int, float, str]] = []

    def add_from_mask(mask: np.ndarray, orientation: str) -> None:
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in _limit_contours(cnts, 180):
            x, y, bw_, bh_ = cv2.boundingRect(cnt)
            area = bw_ * bh_
            if area < max(80, min_area * 0.25) or area > max_area:
                continue
            aspect = bw_ / max(bh_, 1)
            length = max(bw_, bh_)
            thickness = min(bw_, bh_)
            if length < max(28, int(0.025 * max(w, h))):
                continue
            if thickness > max(28, length * 0.45):
                continue
            if orientation == "h" and aspect < 2.2:
                continue
            if orientation == "v" and aspect > 0.45:
                continue

            # Expand the rail to include a likely fader cap next to/around it.
            pad_long = max(3, int(length * 0.04))
            pad_short = max(8, int(thickness * 1.8))
            if orientation == "h":
                x1 = max(0, x - pad_long); y1 = max(0, y - pad_short)
                x2 = min(w, x + bw_ + pad_long); y2 = min(h, y + bh_ + pad_short)
            else:
                x1 = max(0, x - pad_short); y1 = max(0, y - pad_long)
                x2 = min(w, x + bw_ + pad_short); y2 = min(h, y + bh_ + pad_long)

            roi = gray[y1:y2, x1:x2]
            edge_density = float(np.count_nonzero(edges[y1:y2, x1:x2])) / max(1, roi.size)
            conf = min(0.82, 0.48 + edge_density * 2.2 + min(length / max(w, h), 0.18))
            candidates.append((x1, y1, x2, y2, conf, "slider"))

    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(21, w // 60), 2))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, max(21, h // 60)))
    h_lines = cv2.morphologyEx(edges, cv2.MORPH_OPEN, h_kernel, iterations=1)
    v_lines = cv2.morphologyEx(edges, cv2.MORPH_OPEN, v_kernel, iterations=1)
    h_lines = cv2.dilate(h_lines, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)), iterations=1)
    v_lines = cv2.dilate(v_lines, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 5)), iterations=1)
    add_from_mask(h_lines, "h")
    add_from_mask(v_lines, "v")

    # Deduplicate before returning.
    candidates.sort(key=lambda c: c[4], reverse=True)
    out: List[Tuple[int, int, int, int, float, str]] = []
    seen: List[Tuple[int, int, int, int]] = []
    for c in candidates:
        if not _overlaps_any(c[0], c[1], c[2], c[3], seen, threshold=0.45):
            out.append(c)
            seen.append((c[0], c[1], c[2], c[3]))
    return out


# ─── Shared Helpers ────────────────────────────────────────────

def _merge_nearby_detections(detections: List[dict]) -> List[dict]:
    """Merge rect detections of the same type that are spatially close.
    Circles are NOT merged — they have strict bounding from detection."""
    merged = []
    used = set()
    for i, d1 in enumerate(detections):
        if i in used:
            continue
        if d1["type"] != "rect":
            merged.append(d1)
            continue
        b1 = d1["bounds"]
        best = d1
        for j, d2 in enumerate(detections):
            if j <= i or j in used:
                continue
            if d2["type"] != "rect" or d1.get("suggestedType") != d2.get("suggestedType"):
                continue
            b2 = d2["bounds"]
            cx1 = b1["x"] + b1["width"] // 2
            cx2 = b2["x"] + b2["width"] // 2
            cy1 = b1["y"] + b1["height"] // 2
            cy2 = b2["y"] + b2["height"] // 2
            # Horizontally aligned + vertically adjacent
            if abs(cx1 - cx2) < 20 and abs(cy1 - cy2) < max(b1["height"], b2["height"]) * 1.5:
                nx = min(b1["x"], b2["x"])
                ny = min(b1["y"], b2["y"])
                nx2 = max(b1["x"] + b1["width"], b2["x"] + b2["width"])
                ny2 = max(b1["y"] + b1["height"], b2["y"] + b2["height"])
                best = {**d1, "bounds": {"x": nx, "y": ny, "width": nx2 - nx, "height": ny2 - ny},
                        "center": {"x": (nx + nx2) // 2, "y": (ny + ny2) // 2},
                        "confidence": max(d1["confidence"], d2["confidence"])}
                used.add(j)
            # Vertically aligned + horizontally adjacent
            elif abs(cy1 - cy2) < 20 and abs(cx1 - cx2) < max(b1["width"], b2["width"]) * 1.5:
                nx = min(b1["x"], b2["x"])
                ny = min(b1["y"], b2["y"])
                nx2 = max(b1["x"] + b1["width"], b2["x"] + b2["width"])
                ny2 = max(b1["y"] + b1["height"], b2["y"] + b2["height"])
                best = {**d1, "bounds": {"x": nx, "y": ny, "width": nx2 - nx, "height": ny2 - ny},
                        "center": {"x": (nx + nx2) // 2, "y": (ny + ny2) // 2},
                        "confidence": max(d1["confidence"], d2["confidence"])}
                used.add(j)
        merged.append(best)
    return merged


def _classify_rect_component(aspect: float, bw: int, bh: int,
                              circularity: float, rect_fill: float,
                              solidity: float, rel_area: float) -> str:
    if aspect > 3.5 or aspect < 0.28:
        return "slider"
    if rel_area < 0.0008 and solidity > 0.7:
        return "led"
    if rel_area < 0.005 and 0.5 < aspect < 2.0 and solidity > 0.7:
        return "button"
    if rel_area > 0.008 and rect_fill > 0.5 and 0.8 < aspect < 3.0:
        return "screen"
    if 0.003 < rel_area < 0.05 and 0.5 < aspect < 2.0 and circularity > 0.3:
        return "meter"
    if aspect > 2.5 or aspect < 0.4:
        return "slider"
    return "button"


def _compute_rect_confidence(rect_fill: float, solidity: float,
                              aspect: float, circularity: float,
                              n_vertices: int) -> float:
    score = 0.1  # base
    score += min(rect_fill, 1.0) * 0.3
    score += min(solidity, 1.0) * 0.25
    if 0.3 < aspect < 3.0:
        score += 0.15
    elif 0.15 < aspect < 6.0:
        score += 0.08
    if n_vertices <= 6:
        score += 0.15
    elif n_vertices <= 10:
        score += 0.08
    if circularity < 0.5:
        score += 0.1
    return min(score, 1.0)


def _overlaps_any(x1: int, y1: int, x2: int, y2: int,
                  regions: List[Tuple[int, int, int, int]],
                  threshold: float = 0.4) -> bool:
    """Check if bbox overlaps with any existing region (IoU or containment)."""
    for rx1, ry1, rx2, ry2 in regions:
        ix1 = max(x1, rx1)
        iy1 = max(y1, ry1)
        ix2 = min(x2, rx2)
        iy2 = min(y2, ry2)
        if ix1 >= ix2 or iy1 >= iy2:
            continue
        intersection = (ix2 - ix1) * (iy2 - iy1)
        area1 = (x2 - x1) * (y2 - y1)
        area2 = (rx2 - rx1) * (ry2 - ry1)
        union = area1 + area2 - intersection
        if union > 0 and intersection / union > threshold:
            return True
        min_area = min(area1, area2)
        if min_area > 0 and intersection / min_area > 0.75:
            return True
    return False


def _extract_circle_preview(img: np.ndarray, cx: int, cy: int, r: int) -> str:
    """Extract a circular preview thumbnail with alpha mask."""
    h, w = img.shape[:2]
    x1 = max(0, cx - r)
    y1 = max(0, cy - r)
    x2 = min(w, cx + r)
    y2 = min(h, cy + r)
    crop = img[y1:y2, x1:x2].copy()
    if crop.size == 0:
        return _to_png_b64(np.zeros((4, 4, 4), dtype=np.uint8))

    bh, bw = crop.shape[:2]
    mask = np.zeros((bh, bw), dtype=np.uint8)
    local_cx = cx - x1
    local_cy = cy - y1
    cv2.circle(mask, (local_cx, local_cy), r, 255, -1, cv2.LINE_AA)
    if crop.shape[2] == 4:
        crop[:, :, 3] = cv2.bitwise_and(crop[:, :, 3], mask)
    else:
        alpha = mask
        crop = cv2.cvtColor(crop, cv2.COLOR_BGR2BGRA)
        crop[:, :, 3] = alpha

    return _make_thumb(crop, PREVIEW_SIZE)


def _make_thumb(img: np.ndarray, size: int = PREVIEW_SIZE) -> str:
    """Resize image to fit within size x size and encode as base64 PNG."""
    h, w = img.shape[:2]
    if h == 0 or w == 0:
        return _to_png_b64(np.zeros((4, 4, 4), dtype=np.uint8))
    scale = min(size / w, size / h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    thumb = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    return _to_png_b64(thumb)


# ─── Color Variants ────────────────────────────────────────────

def generate_color_variant(
    image_b64: str,
    hue_shift: float = 0.0,
    saturation_scale: float = 1.0,
    brightness_scale: float = 1.0,
    colorize: Optional[List[int]] = None,
    colorize_strength: float = 0.5,
) -> dict:
    """Generate a color variant of an extracted asset.

    Args:
        image_b64: base64 PNG (with alpha)
        hue_shift: degrees to shift hue (-180 to +180)
        saturation_scale: multiply saturation (0=gray, 2=oversaturated)
        brightness_scale: multiply value/brightness (0.5=darker, 1.5=brighter)
        colorize: optional [H, S, V] to colorize with (0-179, 0-255, ignored)
        colorize_strength: blend factor for colorize (0=original, 1=full colorize)

    Returns:
        dict with dataUrl (modified PNG)
    """
    img = _load_image(image_b64)

    # Handle alpha channel
    has_alpha = img.shape[2] == 4
    if has_alpha:
        bgr = img[:, :, :3]
        alpha = img[:, :, 3]
    else:
        bgr = img
        alpha = None

    # Convert to HSV
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    h_ch, s_ch, v_ch = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

    if colorize is not None and len(colorize) >= 2:
        # Colorize mode: replace hue and partially replace saturation
        target_h = float(colorize[0])
        target_s = float(colorize[1]) if len(colorize) >= 2 else 128.0

        new_h = np.full_like(h_ch, target_h)
        new_s = s_ch * (1.0 - colorize_strength) + target_s * colorize_strength

        hsv[:, :, 0] = new_h % 180
        hsv[:, :, 1] = np.clip(new_s, 0, 255)
    else:
        # Hue shift
        if abs(hue_shift) > 0.01:
            h_ch = (h_ch + hue_shift / 2.0) % 180  # OpenCV hue is 0-179
            hsv[:, :, 0] = h_ch

        # Saturation scale
        if abs(saturation_scale - 1.0) > 0.01:
            hsv[:, :, 1] = np.clip(s_ch * saturation_scale, 0, 255)

    # Brightness scale (always applied)
    if abs(brightness_scale - 1.0) > 0.01:
        hsv[:, :, 2] = np.clip(v_ch * brightness_scale, 0, 255)

    # Convert back
    result_bgr = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    if has_alpha:
        result = cv2.merge([result_bgr[:, :, 0], result_bgr[:, :, 1], result_bgr[:, :, 2], alpha])
    else:
        result = result_bgr

    return {"dataUrl": _to_png_b64(result)}


def generate_color_variants_batch(
    image_b64: str,
    hue_shifts: List[float],
) -> List[dict]:
    """Generate multiple hue-shifted variants at once.

    Returns list of dicts, each with dataUrl.
    """
    results = []
    for shift in hue_shifts:
        result = generate_color_variant(image_b64, hue_shift=shift)
        results.append(result)
    return results
