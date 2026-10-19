"""
UI Layout Analyzer — Analyzes a plugin/app screenshot (or real hardware photo)
and extracts precise positions and dimensions of all UI elements.

Output JSON is designed for use in code to map real DSP parameters onto the
plugin image (e.g. for JUCE GUI overlays, MIDI learn maps, documentation, etc.)

Detection strategy (multi-stage pipeline):
 1. Multi-scale preprocessing with adaptive enhancement
 2. Template-matched circle detection for knobs/dials (HoughCircles + edge/gradient validation)
 3. Color-segmented region detection (finds colored indicators, LEDs, buttons)
 4. Gradient-orientation analysis for rotary elements
 5. Morphological vertical fader detection
 6. Adaptive contour classification with shape descriptors
 7. Frame/bezel detection for displays and grouped panels
 8. MSER text-region grouping for labels
 9. Hierarchical cross-group NMS merge pass with priority scoring
"""

import base64
import copy
import math
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import cv2
import numpy as np


DETECTION_MAX_DIM = 1600
MAX_CONTOURS = 240
TYPE_LIMITS = {
    "panel": 6,
    "display": 10,
    "meter": 16,     # NEW: analog VU / level meters
    "slider": 40,   # raised: track + thumb pairs count as 2 each
    "knob": 56,
    "jack": 8,
    "button": 40,   # raised: synths often have many small buttons
    "led": 16,
    "label": 40,
    "text_field": 48,
}


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _decode_image(image_b64: str) -> np.ndarray:
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    raw = base64.b64decode(image_b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    return img


def _to_bgr(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def _iou(a: dict, b: dict) -> float:
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = ax1 + a["width"], ay1 + a["height"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = bx1 + b["width"], by1 + b["height"]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / max(union, 1)


def _containment(inner: dict, outer: dict) -> float:
    """Fraction of inner's area inside outer."""
    ix1 = max(inner["x"], outer["x"])
    iy1 = max(inner["y"], outer["y"])
    ix2 = min(inner["x"] + inner["width"], outer["x"] + outer["width"])
    iy2 = min(inner["y"] + inner["height"], outer["y"] + outer["height"])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    return inter / max(inner["width"] * inner["height"], 1)


def _nms(elements: List[dict], iou_threshold: float = 0.4) -> List[dict]:
    elements = sorted(elements, key=lambda e: e["confidence"], reverse=True)
    kept = []
    for el in elements:
        if any(_iou(el["bounds"], k["bounds"]) > iou_threshold for k in kept):
            continue
        kept.append(el)
    return kept


def _finalize_layout_elements(
    elements: List[dict],
    detection_scale: float,
    img_w: int,
    img_h: int,
    min_confidence: float,
    iou_threshold: float,
) -> List[dict]:
    snapshot = copy.deepcopy(elements)
    snapshot = _rescale_elements(snapshot, detection_scale, img_w, img_h)
    snapshot = [e for e in snapshot if e["confidence"] >= min_confidence]
    snapshot = _nms(snapshot, iou_threshold)
    snapshot = _limit_types(snapshot)
    snapshot = _grid_normalization_pass(snapshot, img_w, img_h)

    for el in snapshot:
        if "shape" not in el:
            el["shape"] = "circle" if el.get("radius") is not None else "rect"
        if "shapeData" not in el:
            b = el["bounds"]
            cx = el["center"]["x"]
            cy = el["center"]["y"]
            if el["shape"] == "circle" and el.get("radius"):
                el["shapeData"] = {"cx": cx, "cy": cy, "radius": el["radius"]}
            else:
                el["shapeData"] = {"cx": cx, "cy": cy, "w": b["width"], "h": b["height"], "angle": 0.0}

        b = el["bounds"]
        el["normalizedBounds"] = {
            "x": round(b["x"] / max(img_w, 1), 6),
            "y": round(b["y"] / max(img_h, 1), 6),
            "width": round(b["width"] / max(img_w, 1), 6),
            "height": round(b["height"] / max(img_h, 1), 6),
        }
        c = el["center"]
        el["normalizedCenter"] = {
            "x": round(c["x"] / max(img_w, 1), 6),
            "y": round(c["y"] / max(img_h, 1), 6),
        }
        el.setdefault("label", None)
        el.pop("detected_by", None)

    order = {"panel": 0, "display": 1, "meter": 2, "slider": 3, "knob": 4,
             "jack": 5, "button": 6, "led": 7, "text_field": 8, "label": 9}
    snapshot.sort(key=lambda e: (order.get(e["type"], 9),
                                 e["bounds"]["y"], e["bounds"]["x"]))
    counters: dict = {}
    for el in snapshot:
        el_type = el["type"]
        counters[el_type] = counters.get(el_type, 0) + 1
        el["id"] = f"{el_type}_{counters[el_type]:03d}"

    return snapshot


def _build_layout_result(
    elements: List[dict],
    detection_scale: float,
    img_w: int,
    img_h: int,
    min_confidence: float,
    iou_threshold: float,
) -> dict:
    finalized = _finalize_layout_elements(
        elements,
        detection_scale,
        img_w,
        img_h,
        min_confidence,
        iou_threshold,
    )
    return {
        "imageWidth": img_w,
        "imageHeight": img_h,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "elementCount": len(finalized),
        "elements": finalized,
    }


def _fit_best_shape(cnt: np.ndarray) -> dict:
    """
    Fit the best geometric primitive to a contour.
    Returns {"shape": "circle"|"ellipse"|"rotated_rect"|"rect", "shapeData": {...}}

    Priority: circle → ellipse → rotated_rect → bounding rect
    The result is used both for accurate bounding and for shape-aware rendering.
    """
    area = cv2.contourArea(cnt)
    if area < 4:
        x, y, w, h = cv2.boundingRect(cnt)
        return {"shape": "rect", "shapeData": {"cx": x + w // 2, "cy": y + h // 2, "w": w, "h": h, "angle": 0.0}}

    # ── Try ellipse fitting (requires ≥5 points) ──────────────────────────────
    if len(cnt) >= 5:
        try:
            (ex, ey), (ew, eh), eangle = cv2.fitEllipse(cnt)
            ellipse_area = math.pi * (ew / 2) * (eh / 2)
            fit_ratio = min(area, ellipse_area) / max(area, ellipse_area, 1)
            minor, major = min(ew, eh), max(ew, eh)
            circularity_fit = minor / max(major, 1)

            if circularity_fit > 0.82 and fit_ratio > 0.65:
                # Essentially circular
                r = max(1, int(round((ew + eh) / 4)))
                return {
                    "shape": "circle",
                    "shapeData": {"cx": int(round(ex)), "cy": int(round(ey)), "radius": r},
                }
            if fit_ratio > 0.60:
                return {
                    "shape": "ellipse",
                    "shapeData": {
                        "cx": int(round(ex)), "cy": int(round(ey)),
                        "rx": max(1, int(round(ew / 2))),
                        "ry": max(1, int(round(eh / 2))),
                        "angle": float(eangle),
                    },
                }
        except cv2.error:
            pass

    # ── Rotated bounding rect ─────────────────────────────────────────────────
    rect = cv2.minAreaRect(cnt)
    (rx, ry), (rw, rh), rangle = rect
    rect_area = rw * rh
    fit_ratio = min(area, rect_area) / max(area, rect_area, 1)

    # Normalise angle so width >= height (keeps convention consistent)
    if rw < rh:
        rw, rh = rh, rw
        rangle = (rangle + 90) % 180

    is_axis_aligned = abs(rangle % 90) < 5
    if is_axis_aligned:
        x, y, w, h = cv2.boundingRect(cnt)
        return {"shape": "rect", "shapeData": {"cx": int(rx), "cy": int(ry), "w": w, "h": h, "angle": 0.0}}

    return {
        "shape": "rotated_rect",
        "shapeData": {
            "cx": int(round(rx)), "cy": int(round(ry)),
            "w": int(round(rw)), "h": int(round(rh)),
            "angle": float(rangle),
        },
    }


def _make_el(type_: str, sub_type: str, x: int, y: int, w: int, h: int,
             confidence: float, detected_by: str, radius: int = None,
             shape: str = None, shape_data: dict = None) -> dict:
    el = {
        "id": f"{type_}_{uuid.uuid4().hex[:6]}",
        "type": type_,
        "sub_type": sub_type,
        "bounds": {"x": x, "y": y, "width": w, "height": h},
        "center": {"x": x + w // 2, "y": y + h // 2},
        "radius": radius,
        "confidence": round(confidence, 2),
        "detected_by": detected_by,
        "shape": shape or ("circle" if radius is not None else "rect"),
        "shapeData": shape_data or (
            {"cx": x + w // 2, "cy": y + h // 2, "radius": radius}
            if radius is not None
            else {"cx": x + w // 2, "cy": y + h // 2, "w": w, "h": h, "angle": 0.0}
        ),
    }
    return el


def _limit_types(elements: List[dict]) -> List[dict]:
    grouped: dict[str, List[dict]] = {}
    for el in elements:
        grouped.setdefault(el["type"], []).append(el)

    limited = []
    for type_, items in grouped.items():
        items.sort(key=lambda el: el["confidence"], reverse=True)
        limited.extend(items[:TYPE_LIMITS.get(type_, 24)])
    return limited


def _rescale_elements(elements: List[dict], scale: float,
                      orig_w: int, orig_h: int) -> List[dict]:
    if scale >= 1.0:
        return elements

    def _clamp_x(value: int) -> int:
        return max(0, min(orig_w, value))

    def _clamp_y(value: int) -> int:
        return max(0, min(orig_h, value))

    for el in elements:
        bounds = el["bounds"]
        x1 = _clamp_x(int(round(bounds["x"] / scale)))
        y1 = _clamp_y(int(round(bounds["y"] / scale)))
        x2 = _clamp_x(int(round((bounds["x"] + bounds["width"]) / scale)))
        y2 = _clamp_y(int(round((bounds["y"] + bounds["height"]) / scale)))
        x2 = max(x1 + 1, x2)
        y2 = max(y1 + 1, y2)
        bounds.update({"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1})

        center = el["center"]
        center["x"] = _clamp_x(int(round(center["x"] / scale)))
        center["y"] = _clamp_y(int(round(center["y"] / scale)))

        if el.get("radius") is not None:
            el["radius"] = max(1, int(round(el["radius"] / scale)))

        # Rescale shapeData (cx/cy/radius/rx/ry/w/h) back to original image coords.
        # Detections store shape geometry in detection-scale pixels; without this,
        # circles/ellipses render shrunk and shifted toward the top-left.
        sd = el.get("shapeData")
        if sd:
            inv = 1.0 / scale
            if "cx" in sd:
                sd["cx"] = _clamp_x(int(round(sd["cx"] * inv)))
            if "cy" in sd:
                sd["cy"] = _clamp_y(int(round(sd["cy"] * inv)))
            if "radius" in sd and sd["radius"] is not None:
                sd["radius"] = max(1, int(round(sd["radius"] * inv)))
            if "rx" in sd and sd["rx"] is not None:
                sd["rx"] = max(1, int(round(sd["rx"] * inv)))
            if "ry" in sd and sd["ry"] is not None:
                sd["ry"] = max(1, int(round(sd["ry"] * inv)))
            if "w" in sd and sd["w"] is not None:
                sd["w"] = max(1, int(round(sd["w"] * inv)))
            if "h" in sd and sd["h"] is not None:
                sd["h"] = max(1, int(round(sd["h"] * inv)))
            # angle is rotation in degrees → scale-invariant, leave as-is

    return elements


# ─── Advanced Circle Validation ───────────────────────────────────────────────

def _circle_edge_support(edges: np.ndarray, cx: int, cy: int, radius: int) -> float:
    """Sample along the expected circle perimeter and count edge hits."""
    img_h, img_w = edges.shape[:2]
    samples = max(24, radius * 4)
    search = max(1, int(radius * 0.08))
    hits = 0
    total = 0

    for idx in range(samples):
        angle = 2 * math.pi * idx / samples
        px = int(round(cx + radius * math.cos(angle)))
        py = int(round(cy + radius * math.sin(angle)))
        if px < 0 or py < 0 or px >= img_w or py >= img_h:
            continue
        total += 1
        found = False
        for dy in range(-search, search + 1):
            for dx in range(-search, search + 1):
                nx = px + dx
                ny = py + dy
                if 0 <= nx < img_w and 0 <= ny < img_h and edges[ny, nx] > 0:
                    found = True
                    break
            if found:
                break
        if found:
            hits += 1

    return hits / max(total, 1)


def _circle_tone_profile(gray: np.ndarray, cx: int, cy: int, radius: int) -> Tuple[float, float]:
    """Measure inner brightness and ring-vs-center contrast."""
    img_h, img_w = gray.shape[:2]
    yy, xx = np.ogrid[:img_h, :img_w]
    dist2 = (xx - cx) ** 2 + (yy - cy) ** 2
    inner_r = max(2, int(radius * 0.45))
    ring_r0 = max(inner_r + 1, int(radius * 0.72))
    ring_r1 = max(ring_r0 + 1, int(radius * 1.08))

    inner_mask = dist2 <= inner_r ** 2
    ring_mask = (dist2 >= ring_r0 ** 2) & (dist2 <= ring_r1 ** 2)
    if not np.any(inner_mask) or not np.any(ring_mask):
        return 0.0, 0.0

    inner_mean = float(np.mean(gray[inner_mask]))
    ring_mean = float(np.mean(gray[ring_mask]))
    return inner_mean, ring_mean - inner_mean


def _circle_gradient_symmetry(gray: np.ndarray, cx: int, cy: int, radius: int) -> float:
    """
    Measure radial gradient symmetry — real knobs have roughly symmetric
    brightness gradients when sampled radially. Returns 0-1 score.
    """
    img_h, img_w = gray.shape[:2]
    n_angles = 36
    profile = []
    for i in range(n_angles):
        angle = 2 * math.pi * i / n_angles
        samples = []
        for frac in [0.3, 0.5, 0.7, 0.9]:
            px = int(round(cx + radius * frac * math.cos(angle)))
            py = int(round(cy + radius * frac * math.sin(angle)))
            if 0 <= px < img_w and 0 <= py < img_h:
                samples.append(float(gray[py, px]))
        profile.append(np.mean(samples) if samples else 0.0)
    
    if not profile:
        return 0.0
    
    profile_arr = np.array(profile, dtype=np.float64)
    mean_val = np.mean(profile_arr)
    if mean_val < 5:
        return 0.0
    
    # Compare opposite angles — symmetric knobs should have similar values
    n = len(profile_arr)
    half = n // 2
    diffs = []
    for i in range(half):
        diff = abs(profile_arr[i] - profile_arr[i + half]) / max(mean_val, 1.0)
        diffs.append(diff)
    
    avg_diff = np.mean(diffs) if diffs else 1.0
    return max(0.0, 1.0 - avg_diff)


def _circle_color_variance(bgr: np.ndarray, cx: int, cy: int, radius: int) -> float:
    """
    Measure color variance inside the circle — real knobs have
    limited color range compared to random texture patches.
    Returns normalized variance (lower = more uniform = more knob-like).
    """
    img_h, img_w = bgr.shape[:2]
    yy, xx = np.ogrid[:img_h, :img_w]
    mask = ((xx - cx) ** 2 + (yy - cy) ** 2) <= (radius * 0.85) ** 2
    if not np.any(mask):
        return 999.0
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hue_vals = hsv[:, :, 0][mask].astype(np.float64)
    sat_vals = hsv[:, :, 1][mask].astype(np.float64)
    # Circular variance for hue
    hue_rad = hue_vals * (2 * math.pi / 180)
    sin_mean = np.mean(np.sin(hue_rad))
    cos_mean = np.mean(np.cos(hue_rad))
    hue_var = 1.0 - math.sqrt(sin_mean**2 + cos_mean**2)
    sat_var = np.std(sat_vals) / 128.0
    return hue_var + sat_var


def _circle_roundness_score(edges: np.ndarray, cx: int, cy: int, radius: int) -> float:
    """
    Check if the detected region actually looks circular by fitting
    an ellipse to nearby edge pixels and comparing with expected circle.
    """
    img_h, img_w = edges.shape[:2]
    pad = max(3, int(radius * 0.3))
    y0 = max(0, cy - radius - pad)
    y1 = min(img_h, cy + radius + pad)
    x0 = max(0, cx - radius - pad)
    x1 = min(img_w, cx + radius + pad)
    
    roi = edges[y0:y1, x0:x1]
    pts = np.column_stack(np.where(roi > 0))
    if len(pts) < 8:
        return 0.3
    
    # Compute distances from expected center
    local_cx = cx - x0
    local_cy = cy - y0
    distances = np.sqrt((pts[:, 1] - local_cx) ** 2 + (pts[:, 0] - local_cy) ** 2)
    
    # Filter to points near the expected radius
    near_mask = (distances > radius * 0.6) & (distances < radius * 1.4)
    near_pts = pts[near_mask]
    near_dists = distances[near_mask]
    
    if len(near_pts) < 6:
        return 0.3
    
    # How consistent are the distances? (std / mean)
    cv = float(np.std(near_dists)) / max(float(np.mean(near_dists)), 1.0)
    return max(0.0, 1.0 - cv * 2)


# ─── Preprocessing ────────────────────────────────────────────────────────────

def _preprocess(gray: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Return (enhanced, edges_tight, edges_loose).
    - enhanced : CLAHE-equalized — essential for metallic/textured hardware.
    - edges_tight : low noise, may miss some boundaries.
    - edges_loose : more boundaries, more noise.
    """
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    # Adapt clip limit for high-contrast images to avoid over-enhancement
    img_std = float(np.std(gray))
    if img_std > 70:
        clahe2 = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8))
        enhanced = clahe2.apply(gray)
    blurred = cv2.GaussianBlur(enhanced, (5, 5), 0)
    edges_tight = cv2.Canny(blurred, 40, 120)
    edges_loose = cv2.Canny(blurred, 15, 60)
    return enhanced, edges_tight, edges_loose


def _preprocess_multi(gray: np.ndarray, bgr: np.ndarray) -> dict:
    """
    Multi-strategy preprocessing for improved detection robustness.
    Returns a dict of different image representations:
    - enhanced: CLAHE-equalized
    - edges_tight / edges_loose: Canny at different thresholds
    - gradient_mag: Sobel gradient magnitude
    - gradient_dir: Sobel gradient direction
    - hsv: HSV color space
    - lab: LAB color space
    - binary_otsu: Otsu thresholded
    - binary_adaptive: Adaptive-thresholded
    """
    enhanced, edges_tight, edges_loose = _preprocess(gray)
    
    # Gradient magnitude & direction via Sobel
    sobelx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    sobely = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    gradient_mag = np.sqrt(sobelx**2 + sobely**2).astype(np.float32)
    gradient_dir = np.arctan2(sobely, sobelx).astype(np.float32)
    
    # Color spaces
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    
    # Binary masks
    _, binary_otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    binary_adaptive = cv2.adaptiveThreshold(
        enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 6
    )
    
    return {
        "enhanced": enhanced,
        "edges_tight": edges_tight,
        "edges_loose": edges_loose,
        "gradient_mag": gradient_mag,
        "gradient_dir": gradient_dir,
        "hsv": hsv,
        "lab": lab,
        "binary_otsu": binary_otsu,
        "binary_adaptive": binary_adaptive,
    }


# ─── Strategy 1: HoughCircles with multi-validation ──────────────────────────

def _detect_circles(enhanced: np.ndarray, edges_tight: np.ndarray,
                    bgr: np.ndarray, gray: np.ndarray,
                    gradient_mag: np.ndarray,
                    img_h: int, img_w: int) -> List[dict]:
    """
    Enhanced circle detection using HoughCircles at multiple scales,
    validated by edge support, gradient symmetry, color uniformity,
    and roundness scoring.
    """
    elements = []
    blurred = cv2.GaussianBlur(enhanced, (7, 7), 1.5)

    # Multi-pass Hough at different parameter sets for robustness
    hough_configs = [
        # (min_r, max_r, type, sub_type, conf_base, dp, p2, p1)
        (5,  12,  "button", "push",    0.55, 1.1, 24, 50),
        (7,  14,  "button", "push",    0.60, 1.15, 28, 55),
        (8,  30,  "knob",   "rotary",  0.72, 1.0, 20, 38),   # sensitive pass: small/dark knobs
        (10, 38,  "knob",   "rotary",  0.78, 1.2, 30, 50),
        (10, 38,  "knob",   "rotary",  0.82, 1.2, 32, 55),
        (15, 55,  "knob",   "rotary",  0.80, 1.15, 28, 48),
        (20, 65,  "knob",   "rotary",  0.74, 1.1, 24, 44),   # medium dark-background knobs
        (28, 90,  "knob",   "large",   0.80, 1.25, 34, 55),
        (28, 90,  "knob",   "large",   0.84, 1.25, 36, 55),
        (60, 180, "knob",   "large",   0.78, 1.3,  40, 60),
        # Large circular displays: oscilloscopes, round VU meters, round screens.
        # Radius 50–150 covers displays up to 300 px diameter on a 800-px panel.
        # maxRadius is ALSO capped dynamically below based on actual image size.
        (50, 150, "display", "circular", 0.75, 1.3, 38, 55),
    ]

    seen_circles: List[Tuple[int, int, int]] = []

    for (min_r, max_r, type_, sub_type, conf_base, dp, p2, p1) in hough_configs:
        # Skip configs where the minimum radius is already too large for this image
        if min_r * 2 > min(img_h, img_w):
            continue
        # Cap max_r so it never exceeds half the shorter image dimension.
        # Without this, large-radius configs on small images force OpenCV to
        # search for circles bigger than the image — very slow and useless.
        eff_max_r = min(max_r, (min(img_h, img_w) // 2) - 1)
        if eff_max_r <= min_r:
            continue

        circles = cv2.HoughCircles(
            blurred, cv2.HOUGH_GRADIENT,
            dp=dp, minDist=int(min_r * 2.0),
            param1=p1, param2=p2,
            minRadius=min_r, maxRadius=eff_max_r,
        )
        if circles is None:
            continue
        for (cx, cy, r) in np.round(circles[0]).astype(int):
            if cx < 0 or cy < 0 or cx >= img_w or cy >= img_h:
                continue
            
            # Deduplicate: skip if too close to an existing detection
            dup = False
            for (ex, ey, er) in seen_circles:
                dist = math.sqrt((cx - ex)**2 + (cy - ey)**2)
                if dist < max(r, er) * 0.4:
                    dup = True
                    break
            if dup:
                continue

            # ── Multi-factor validation ──
            edge_support = _circle_edge_support(edges_tight, cx, cy, r)
            inner_mean, ring_delta = _circle_tone_profile(enhanced, cx, cy, r)
            grad_sym = _circle_gradient_symmetry(gray, cx, cy, r)
            color_var = _circle_color_variance(bgr, cx, cy, r)
            roundness = _circle_roundness_score(edges_tight, cx, cy, r)

            # Gradient ring intensity (should be high around knob edges)
            ring_r0 = max(1, int(r * 0.8))
            ring_r1 = min(int(r * 1.2), max(img_h, img_w))
            yy, xx = np.ogrid[max(0, cy-ring_r1):min(img_h, cy+ring_r1),
                              max(0, cx-ring_r1):min(img_w, cx+ring_r1)]
            local_cy = cy - max(0, cy-ring_r1)
            local_cx = cx - max(0, cx-ring_r1)
            dist2 = (xx - local_cx) ** 2 + (yy - local_cy) ** 2
            ring_mask = (dist2 >= ring_r0 ** 2) & (dist2 <= ring_r1 ** 2)
            grad_roi = gradient_mag[max(0, cy-ring_r1):min(img_h, cy+ring_r1),
                                    max(0, cx-ring_r1):min(img_w, cx+ring_r1)]
            if ring_mask.shape == grad_roi.shape and np.any(ring_mask):
                ring_grad = float(np.mean(grad_roi[ring_mask]))
            else:
                ring_grad = 0.0

            # ── Scoring ──
            if type_ == "knob":
                # Require some edge support OR gradient (relaxed for dark metallic knobs)
                if edge_support < 0.18 and ring_grad < 10:
                    continue
                # Reject completely flat regions only (very permissive for dark-on-dark)
                if abs(ring_delta) < 2 and ring_grad < 6:
                    continue
                # Reject over-bright (likely glare/reflection)
                if inner_mean > 248:
                    continue
                
                # Composite confidence from multiple signals
                conf = conf_base
                conf += edge_support * 0.10           # 0-0.10
                conf += grad_sym * 0.06               # 0-0.06
                conf += roundness * 0.06              # 0-0.06
                conf += min(ring_grad / 60.0, 1.0) * 0.04  # 0-0.04
                conf -= min(color_var, 1.5) * 0.03    # penalty for high color variance
                conf += max(0, ring_delta - 5) * 0.002  # tone contrast bonus
                conf = min(0.98, max(0.5, conf))
            else:
                # Buttons: stricter shape requirements
                if edge_support < 0.45 or ring_delta < 8:
                    continue
                if inner_mean > 245:
                    continue
                conf = min(0.92, conf_base + edge_support * 0.12 + roundness * 0.08)

            pad = max(3, int(r * 0.10))
            x0 = max(0, cx - r - pad)
            y0 = max(0, cy - r - pad)
            x1 = min(img_w, cx + r + pad)
            y1 = min(img_h, cy + r + pad)
            el = _make_el(type_, sub_type,
                          int(x0), int(y0), int(x1 - x0), int(y1 - y0),
                          conf, "hough", radius=int(r),
                          shape="circle",
                          shape_data={"cx": int(cx), "cy": int(cy), "radius": int(r)})
            el["center"] = {"x": int(cx), "y": int(cy)}
            elements.append(el)
            seen_circles.append((int(cx), int(cy), int(r)))

    return elements


# ─── Strategy 2: Color-based region detection ─────────────────────────────────

def _detect_colored_elements(hsv: np.ndarray, bgr: np.ndarray,
                             img_h: int, img_w: int) -> List[dict]:
    """
    Detect LEDs, colored buttons, and indicator lights by finding
    saturated colored regions that stand out from the background.
    """
    elements = []
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    
    # Find highly saturated, bright regions (LEDs, indicator lights)
    led_mask = (sat > 100) & (val > 120)
    # Morphological cleanup
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    led_mask = cv2.morphologyEx(led_mask.astype(np.uint8) * 255, cv2.MORPH_CLOSE, kernel, iterations=2)
    led_mask = cv2.morphologyEx(led_mask, cv2.MORPH_OPEN, kernel, iterations=1)
    
    contours, _ = cv2.findContours(led_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 30 or area > img_w * img_h * 0.01:
            continue
        x, y, w, h = cv2.boundingRect(cnt)
        aspect = w / max(h, 1)
        
        perimeter = cv2.arcLength(cnt, True)
        circularity = 4 * math.pi * area / max(perimeter ** 2, 1)
        
        # Get dominant color in region
        roi_hsv = hsv[y:y+h, x:x+w]
        mask_roi = led_mask[y:y+h, x:x+w]
        if mask_roi.size == 0 or not np.any(mask_roi):
            continue
        
        mean_hue = float(np.mean(roi_hsv[:, :, 0][mask_roi > 0]))
        mean_sat = float(np.mean(roi_hsv[:, :, 1][mask_roi > 0]))
        mean_val = float(np.mean(roi_hsv[:, :, 2][mask_roi > 0]))
        
        if circularity > 0.6 and 0.5 < aspect < 2.0 and area < 800:
            # Small bright circular region → LED
            conf = min(0.90, 0.65 + circularity * 0.15 + (mean_sat / 255) * 0.1)
            fitted = _fit_best_shape(cnt)
            cx_el = int(x + w // 2)
            cy_el = int(y + h // 2)
            r_el = max(1, int(math.sqrt(area / math.pi)))
            elements.append(_make_el(
                "led", "indicator", int(x), int(y), int(w), int(h),
                conf, "color",
                radius=r_el if fitted["shape"] == "circle" else None,
                shape=fitted["shape"],
                shape_data=fitted["shapeData"],
            ))
        elif 0.4 < aspect < 2.5 and area < 2500 and mean_sat > 140:
            # Small saturated rectangular region → colored button
            conf = min(0.85, 0.58 + (mean_sat / 255) * 0.15 + circularity * 0.08)
            fitted = _fit_best_shape(cnt)
            elements.append(_make_el(
                "button", "colored", int(x), int(y), int(w), int(h),
                conf, "color",
                radius=fitted["shapeData"].get("radius") if fitted["shape"] == "circle" else None,
                shape=fitted["shape"],
                shape_data=fitted["shapeData"],
            ))
    
    return elements


# ─── Strategy 3: Frame/Bezel Detection ────────────────────────────────────────

def _detect_frames(gray: np.ndarray, edges_tight: np.ndarray,
                   img_h: int, img_w: int) -> List[dict]:
    """
    Detect rectangular frames, bezels, and display borders.
    These are typically well-defined rectangular contours with
    uniform edge structure on all 4 sides.
    """
    elements = []
    
    # Apply strong morphological close to connect edges into rectangles
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    closed = cv2.morphologyEx(edges_tight, cv2.MORPH_CLOSE, kernel, iterations=3)
    
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:60]
    
    for cnt in contours:
        area = cv2.contourArea(cnt)
        rel_area = area / (img_w * img_h)
        if rel_area < 0.005 or rel_area > 0.3:
            continue
        
        x, y, w, h = cv2.boundingRect(cnt)
        aspect = w / max(h, 1)
        
        # Approximate polygon
        epsilon = 0.02 * cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, epsilon, True)
        
        # Check rectangularity: 4 corners, right angles
        if len(approx) < 4 or len(approx) > 8:
            continue
        
        extent = area / max(w * h, 1)
        hull = cv2.convexHull(cnt)
        solidity = area / max(cv2.contourArea(hull), 1)
        
        # Strong rectangular shape — allow nearly-square (oscilloscope) down to 0.65
        if extent > 0.7 and solidity > 0.82 and 0.65 < aspect < 8.0:
            # Check if edges are present on all 4 sides
            border = 3
            top_edge = np.sum(edges_tight[max(0,y):y+border, x:x+w] > 0)
            bottom_edge = np.sum(edges_tight[y+h-border:min(img_h,y+h), x:x+w] > 0)
            left_edge = np.sum(edges_tight[y:y+h, max(0,x):x+border] > 0)
            right_edge = np.sum(edges_tight[y:y+h, x+w-border:min(img_w,x+w)] > 0)
            
            total_border = w * 2 + h * 2
            edge_count = top_edge + bottom_edge + left_edge + right_edge
            edge_ratio = edge_count / max(total_border, 1)
            
            if edge_ratio > 0.18:
                conf = min(0.90, 0.60 + extent * 0.15 + edge_ratio * 0.15)
                # Nearly-square large frames are likely oscilloscope/circular displays
                if aspect < 1.3 and rel_area > 0.02:
                    sub = "oscilloscope"
                elif aspect > 3.5:
                    sub = "waveform"
                else:
                    sub = "lcd"
                elements.append(_make_el(
                    "display", sub, int(x), int(y), int(w), int(h),
                    conf, "frame",
                    shape="rect",
                    shape_data={"cx": x + w // 2, "cy": y + h // 2, "w": w, "h": h, "angle": 0.0},
                ))
    
    return elements


# ─── Strategy 4: Fader track & thumb detection ───────────────────────────────

def _find_fader_thumb(
    enhanced: np.ndarray,
    fx: int, fy: int, fw: int, fh: int,
    orientation: str,
    img_w: int, img_h: int,
) -> Optional[dict]:
    """
    Locate the thumb (moveable handle) within a detected fader track region.

    Projects the fader ROI along its primary axis to build a per-strip mean
    brightness profile, then finds the brightest contiguous band — that band
    is the thumb (lighter / higher-contrast than the surrounding track groove).

    Returns a slider element with sub_type 'thumb_v' or 'thumb_h', or None.
    """
    if fw < 4 or fh < 4:
        return None
    roi = enhanced[fy : fy + fh, fx : fx + fw]
    if roi.size == 0:
        return None

    def _best_band(profile: np.ndarray, pct: int = 72):
        total = len(profile)
        margin = max(2, total // 10)
        if total - 2 * margin < 4:
            return None, None
        search = profile[margin : total - margin]
        thresh = float(np.percentile(search, pct))
        in_band = False
        best_start = best_end = 0
        best_score = -1.0
        seg_start = 0
        for i, v in enumerate(search):
            if v >= thresh:
                if not in_band:
                    seg_start = i
                    in_band = True
            else:
                if in_band:
                    seg_end = i - 1
                    score = (seg_end - seg_start + 1) * float(
                        np.mean(search[seg_start : seg_end + 1])
                    )
                    if score > best_score:
                        best_score, best_start, best_end = score, seg_start, seg_end
                    in_band = False
        if in_band:
            seg_end = len(search) - 1
            score = (seg_end - seg_start + 1) * float(
                np.mean(search[seg_start : seg_end + 1])
            )
            if score > best_score:
                best_score, best_start, best_end = score, seg_start, seg_end
        if best_score < 0:
            return None, None
        return best_start + margin, best_end + margin

    if orientation == "vertical":
        profile = np.mean(roi, axis=1).astype(np.float32)
        row_s, row_e = _best_band(profile)
        if row_s is None:
            return None
        t_h = max(6, row_e - row_s + 1)
        mid = (row_s + row_e) // 2
        t_y0 = max(0, fy + mid - t_h // 2)
        t_y1 = min(img_h, t_y0 + t_h)
        t_h = t_y1 - t_y0
        if t_h < 4:
            return None
        cx = fx + fw // 2
        cy = t_y0 + t_h // 2
        return _make_el(
            "slider", "thumb_v",
            fx, t_y0, fw, t_h,
            0.74, "fader_thumb",
            shape="rect",
            shape_data={"cx": cx, "cy": cy, "w": fw, "h": t_h, "angle": 0.0},
        )

    else:  # horizontal
        profile = np.mean(roi, axis=0).astype(np.float32)
        col_s, col_e = _best_band(profile)
        if col_s is None:
            return None
        t_w = max(6, col_e - col_s + 1)
        mid = (col_s + col_e) // 2
        t_x0 = max(0, fx + mid - t_w // 2)
        t_x1 = min(img_w, t_x0 + t_w)
        t_w = t_x1 - t_x0
        if t_w < 4:
            return None
        cx = t_x0 + t_w // 2
        cy = fy + fh // 2
        return _make_el(
            "slider", "thumb_h",
            t_x0, fy, t_w, fh,
            0.74, "fader_thumb",
            shape="rect",
            shape_data={"cx": cx, "cy": cy, "w": t_w, "h": fh, "angle": 0.0},
        )


def _detect_faders(gray: np.ndarray, enhanced: np.ndarray,
                   img_h: int, img_w: int) -> List[dict]:
    """
    Detect linear sliders/faders — vertical and horizontal tracks.
    For each detected track, also locate the thumb (moving handle) by scanning
    the brightness profile perpendicular to the track axis.
    Output sub_types: 'vertical', 'horizontal', 'thumb_v', 'thumb_h'.
    """
    elements = []

    # ─── Vertical tracks ────────────────────────────────────────────────────
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 25))
    v_open = cv2.morphologyEx(cv2.bitwise_not(enhanced), cv2.MORPH_OPEN,
                              v_kernel, iterations=1)
    _, v_bin = cv2.threshold(v_open, 60, 255, cv2.THRESH_BINARY)

    h_widen = cv2.getStructuringElement(cv2.MORPH_RECT, (8, 1))
    v_bin = cv2.dilate(v_bin, h_widen, iterations=1)

    v_contours, _ = cv2.findContours(v_bin, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    for cnt in v_contours:
        x, y, w, h = cv2.boundingRect(cnt)
        aspect = w / max(h, 1)

        if h < img_h * 0.08 or aspect > 0.45 or w * h < 400:
            continue

        rel_h = h / img_h
        conf = min(0.72 + rel_h * 0.3 + (0.4 - aspect) * 0.3, 0.92)

        # Use minAreaRect to capture the true orientation of the fader track
        rect = cv2.minAreaRect(cnt)
        (rx, ry), (rw, rh), rangle = rect
        # Ensure width < height for vertical fader convention
        if rw > rh:
            rw, rh = rh, rw
            rangle = (rangle + 90) % 180
        is_angled = abs(rangle % 90) > 8

        pad_x = max(5, int(w * 0.8))
        pad_y = max(4, int(h * 0.04))
        fx = max(0, x - pad_x)
        fy = max(0, y - pad_y)
        fw = min(img_w, x + w + pad_x) - fx
        fh = min(img_h, y + h + pad_y) - fy

        if is_angled:
            shape = "rotated_rect"
            shape_data = {
                "cx": int(round(rx)), "cy": int(round(ry)),
                "w": int(round(rw + pad_x * 2)), "h": int(round(rh + pad_y * 2)),
                "angle": float(rangle),
            }
        else:
            shape = "rect"
            shape_data = {"cx": fx + fw // 2, "cy": fy + fh // 2, "w": fw, "h": fh, "angle": 0.0}

        elements.append(_make_el("slider", "vertical", fx, fy, fw, fh, conf, "fader",
                                 shape=shape, shape_data=shape_data))

        thumb = _find_fader_thumb(enhanced, fx, fy, fw, fh, "vertical", img_w, img_h)
        if thumb is not None:
            elements.append(thumb)

    # ─── Horizontal tracks ──────────────────────────────────────────────────
    h_kernel_long = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 1))
    h_open = cv2.morphologyEx(cv2.bitwise_not(enhanced), cv2.MORPH_OPEN,
                              h_kernel_long, iterations=1)
    _, h_bin = cv2.threshold(h_open, 60, 255, cv2.THRESH_BINARY)

    v_widen = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 8))
    h_bin = cv2.dilate(h_bin, v_widen, iterations=1)

    h_contours, _ = cv2.findContours(h_bin, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    for cnt in h_contours:
        x, y, w, h_px = cv2.boundingRect(cnt)
        aspect = w / max(h_px, 1)

        # Horizontal track: wide and thin (aspect > 2.5), at least 4% of image width
        if w < img_w * 0.04 or aspect < 2.5 or w * h_px < 300:
            continue
        if h_px > img_h * 0.12:
            continue

        rel_w = w / img_w
        conf = min(0.68 + rel_w * 0.25 + min(aspect / 12.0, 0.12), 0.90)

        pad_x = max(4, int(w * 0.04))
        pad_y = max(5, int(h_px * 0.6))
        fx = max(0, x - pad_x)
        fy = max(0, y - pad_y)
        fw = min(img_w, x + w + pad_x) - fx
        fh = min(img_h, y + h_px + pad_y) - fy

        elements.append(_make_el("slider", "horizontal", fx, fy, fw, fh, conf, "fader",
                                 shape="rect",
                                 shape_data={"cx": fx + fw // 2, "cy": fy + fh // 2,
                                             "w": fw, "h": fh, "angle": 0.0}))

        thumb = _find_fader_thumb(enhanced, fx, fy, fw, fh, "horizontal", img_w, img_h)
        if thumb is not None:
            elements.append(thumb)

    return elements


# ─── Strategy 5a: Analog meter detection ─────────────────────────────────────

def _detect_meters(bgr: np.ndarray, hsv: np.ndarray, gray: np.ndarray,
                   edges_tight: np.ndarray, img_h: int, img_w: int) -> List[dict]:
    """
    Detect analog VU / level meters (needle-over-arced-scale style).

    Discriminating features:
    - Warm golden / amber bezel (hue 8-42 in OpenCV convention = 16-84° real)
    - Roughly square body (large standalone meter) OR wide rectangle (mini meter)
    - Inner edge complexity from scale markings and needle
    - Mid-range area (not tiny like an LED, not huge like the main panel)
    """
    elements = []

    h_chan = hsv[:, :, 0]
    s_chan = hsv[:, :, 1]
    v_chan = hsv[:, :, 2]

    # Golden/amber/tan warm mask — covers brass, gold, tan bezels
    warm_mask = (
        ((h_chan >= 8)  & (h_chan <= 30) & (s_chan > 45) & (v_chan > 60)) |   # orange-gold
        ((h_chan >= 10) & (h_chan <= 42) & (s_chan > 30) & (v_chan > 90))      # light amber/tan
    ).astype(np.uint8) * 255

    k9 = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    k5 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    warm_closed  = cv2.morphologyEx(warm_mask, cv2.MORPH_CLOSE, k9, iterations=3)
    warm_regions = cv2.morphologyEx(warm_closed, cv2.MORPH_OPEN,  k5, iterations=1)

    contours, _ = cv2.findContours(warm_regions, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    for cnt in contours:
        area = cv2.contourArea(cnt)
        rel_area = area / max(img_w * img_h, 1)

        # Meters: 0.3 % – 15 % of the image
        if rel_area < 0.003 or rel_area > 0.15:
            continue

        x, y, w, h = cv2.boundingRect(cnt)
        aspect = w / max(h, 1)

        # Too thin / too tall to be a meter housing
        if aspect < 0.35 or aspect > 5.5:
            continue

        hull = cv2.convexHull(cnt)
        solidity = area / max(cv2.contourArea(hull), 1)
        if solidity < 0.52:
            continue

        # ── Inside edge complexity (scale markings + needle) ──────────────
        roi_edges = edges_tight[y:y+h, x:x+w]
        if roi_edges.size == 0:
            continue
        interior_edge_density = float(np.mean(roi_edges > 0))
        # Meters have internal markings; flat colored patches do not
        if interior_edge_density < 0.012:
            continue

        # ── Bezel contrast: the bezel region should be significantly lighter
        #    than the meter face (which is typically dark) ──────────────────
        roi_gray = gray[y:y+h, x:x+w]
        roi_warm = warm_regions[y:y+h, x:x+w]
        bezel_px  = roi_gray[roi_warm > 0]
        face_px   = roi_gray[roi_warm == 0]
        if len(bezel_px) < 8 or len(face_px) < 8:
            continue
        bezel_mean = float(np.mean(bezel_px))
        face_mean  = float(np.mean(face_px))
        # Bezel generally brighter than face; if the opposite is extreme, skip
        if face_mean > bezel_mean + 60:
            continue

        # ── Classify sub-type ─────────────────────────────────────────────
        if aspect <= 1.8:
            sub  = "vu_large"   # standalone square VU meter (LEVEL / PAN / STEREO)
            conf = min(0.88, 0.62 + solidity * 0.14 + min(interior_edge_density * 6, 0.12))
        else:
            sub  = "vu_mini"    # wide compact bar-style meter
            # Require minimum height so we don't catch thin stripes
            if h < img_h * 0.018 or aspect < 2.2:
                continue
            conf = min(0.84, 0.58 + solidity * 0.12 + min(interior_edge_density * 6, 0.12))

        cx = int(x + w // 2)
        cy = int(y + h // 2)
        elements.append(_make_el(
            "meter", sub,
            int(x), int(y), int(w), int(h),
            conf, "warm_color",
            shape="rect",
            shape_data={"cx": cx, "cy": cy, "w": int(w), "h": int(h), "angle": 0.0},
        ))

    return elements


# ─── Strategy 5: Contour classification ──────────────────────────────────────

def _detect_contours(enhanced: np.ndarray, edges_loose: np.ndarray,
                     binary_adaptive: np.ndarray,
                     img_h: int, img_w: int, detect_labels: bool) -> List[dict]:
    elements = []

    k5 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges_loose, cv2.MORPH_CLOSE, k5, iterations=2)

    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    adapt_clean = cv2.morphologyEx(binary_adaptive, cv2.MORPH_CLOSE, k3, iterations=1)

    combined = cv2.bitwise_or(closed, adapt_clean)
    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:MAX_CONTOURS]

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < max(60, int(img_w * img_h * 0.000015)):
            continue
        rel_area = area / (img_w * img_h)
        if rel_area > 0.35:
            continue

        x, y, w, h = cv2.boundingRect(cnt)
        aspect = w / max(h, 1)
        perimeter = cv2.arcLength(cnt, True)
        circularity = 4 * math.pi * area / max(perimeter ** 2, 1)
        extent = area / max(w * h, 1)
        hull = cv2.convexHull(cnt)
        solidity = area / max(cv2.contourArea(hull), 1)

        # Skip contours that are already well-explained by circle detectors
        if circularity > 0.62 and solidity > 0.80:
            continue

        # ── Fit the actual geometric shape for this contour ──────────────────
        fitted = _fit_best_shape(cnt)
        fit_shape = fitted["shape"]
        fit_data = fitted["shapeData"]

        # For ellipse/circle fits: update aspect + size descriptors from the fit
        if fit_shape == "circle":
            fit_r = fit_data.get("radius", 1)
            fit_aspect = 1.0
            fit_minor = fit_major = fit_r * 2
        elif fit_shape == "ellipse":
            fit_minor = min(fit_data["rx"], fit_data["ry"]) * 2
            fit_major = max(fit_data["rx"], fit_data["ry"]) * 2
            fit_aspect = fit_major / max(fit_minor, 1)
        elif fit_shape == "rotated_rect":
            fit_minor = min(fit_data["w"], fit_data["h"])
            fit_major = max(fit_data["w"], fit_data["h"])
            fit_aspect = fit_major / max(fit_minor, 1)
        else:
            fit_minor, fit_major, fit_aspect = h, w, aspect

        type_ = sub = ""
        conf = 0.0
        radius_out = None

        # ── Classification using FITTED geometry (not raw bounding rect) ─────
        if fit_shape == "circle":
            # Circular contour not caught by Hough (small or low-contrast) → button/knob/led/display
            r_fit = fit_data["radius"]
            fit_rel = math.pi * r_fit * r_fit / (img_w * img_h)
            if fit_rel < 0.0008:
                type_, sub = "led", "indicator"
                conf = 0.68
            elif fit_rel < 0.005:
                type_, sub = "button", "push"
                conf = 0.72
            elif fit_rel < 0.05:
                type_, sub = "knob", "rotary"
                conf = 0.74
            else:
                # Large circle — likely oscilloscope or circular display panel
                type_, sub = "display", "circular"
                conf = 0.74
            radius_out = r_fit
        elif fit_shape == "ellipse" and fit_aspect < 1.35:
            # Nearly circular ellipse → knob / button
            r_fit = int((fit_data["rx"] + fit_data["ry"]) / 2)
            fit_rel = math.pi * fit_data["rx"] * fit_data["ry"] / (img_w * img_h)
            if fit_rel < 0.005:
                type_, sub = "button", "push"
            else:
                type_, sub = "knob", "rotary"
            conf = 0.70
            radius_out = r_fit
        elif rel_area > 0.03 and 1.3 < fit_aspect < 10.0 and solidity > 0.78:
            type_, sub = "display", "waveform" if fit_aspect > 3.5 else "lcd"
            conf = min(0.60 + solidity * 0.25 + extent * 0.1, 0.92)
        elif fit_aspect > 4.0 and 0.001 < rel_area < 0.06 and extent > 0.30:
            type_, sub = "slider", "horizontal"
            conf = min(0.60 + extent * 0.20, 0.88)
        elif fit_aspect > 3.5 and fit_shape == "rotated_rect" and 0.001 < rel_area < 0.06:
            # Angled slider — fits rotated rect well
            type_, sub = "slider", "diagonal"
            conf = min(0.62 + extent * 0.18, 0.85)
        elif (fit_shape in ("rect", "rotated_rect") and fit_aspect < 0.35
              and rel_area > 0.0008 and extent > 0.25):
            type_, sub = "slider", "vertical"
            conf = min(0.60 + extent * 0.20, 0.85)
        elif 0.55 < fit_aspect < 2.0 and 0.0005 < rel_area < 0.012 and solidity > 0.84 and extent > 0.42:
            type_, sub = "button", "toggle"
            conf = round(0.62 + solidity * 0.15, 2)
        elif 0.3 < fit_aspect < 5.0 and 0.0001 < rel_area < 0.018 and solidity > 0.72 and extent > 0.52:
            # Small bordered rectangular push-buttons (labeled, numbered, action buttons)
            # Validate: all 4 sides must have edge presence
            _brd = max(1, int(min(w, h) * 0.15))
            _er = edges_loose[y:y+h, x:x+w]
            if _er.size > 0:
                _top = float(np.mean(_er[:_brd, :] > 0))
                _bot = float(np.mean(_er[-_brd:, :] > 0))
                _lft = float(np.mean(_er[:, :_brd] > 0))
                _rgt = float(np.mean(_er[:, -_brd:] > 0))
                _min_edge = min(_top, _bot, _lft, _rgt)
                if _min_edge > 0.03:
                    type_, sub = "button", "push"
                    conf = round(0.56 + solidity * 0.12 + extent * 0.10, 2)
        elif detect_labels and 3.6 < aspect < 14.0 and 0.00008 < rel_area < 0.0022 and 0.45 < extent < 0.88:
            type_, sub = "label", "text"
            conf = 0.58
        elif rel_area > 0.018 and 0.4 < fit_aspect < 4.5 and solidity > 0.88 and extent > 0.55:
            type_, sub = "panel", "group"
            conf = round(0.56 + solidity * 0.18, 2)

        if conf < 0.48 or not type_:
            continue

        M = cv2.moments(cnt)
        cx = int(M["m10"] / max(M["m00"], 1))
        cy = int(M["m01"] / max(M["m00"], 1))

        # Override center with fitted shape center (more accurate for non-axis-aligned shapes)
        if fit_shape in ("circle", "ellipse", "rotated_rect"):
            cx = fit_data.get("cx", cx)
            cy = fit_data.get("cy", cy)

        elements.append({
            "id": f"{type_}_{uuid.uuid4().hex[:6]}",
            "type": type_,
            "sub_type": sub,
            "bounds": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
            "center": {"x": cx, "y": cy},
            "radius": radius_out,
            "confidence": round(conf, 2),
            "detected_by": "contour",
            "shape": fit_shape,
            "shapeData": fit_data,
        })

    return elements


# ─── Strategy 6: Gradient-based rotary element detection ──────────────────────

def _detect_rotary_by_gradient(gradient_mag: np.ndarray, gradient_dir: np.ndarray,
                               gray: np.ndarray, img_h: int, img_w: int) -> List[dict]:
    """
    Detect rotary elements by looking for radial gradient patterns.
    Knobs and dials create distinctive radial gradient flows
    pointing toward (or away from) their center.
    """
    elements = []
    
    # Downsample gradient for speed
    scale = 0.5 if min(img_h, img_w) > 600 else 1.0
    if scale < 1.0:
        mag_small = cv2.resize(gradient_mag, None, fx=scale, fy=scale)
        dir_small = cv2.resize(gradient_dir, None, fx=scale, fy=scale)
    else:
        mag_small = gradient_mag
        dir_small = gradient_dir
    
    sh, sw = mag_small.shape[:2]
    
    # Strong gradient points
    mag_thresh = float(np.percentile(mag_small, 85))
    strong = mag_small > mag_thresh
    
    # Sample candidate centers by looking for convergence of gradient directions
    step = max(8, min(sh, sw) // 40)
    candidates = []
    
    for cy in range(step, sh - step, step):
        for cx in range(step, sw - step, step):
            # Check radial alignment in a ring around this point
            ring_r0 = step
            ring_r1 = step * 3
            
            angles_toward = 0
            total_checked = 0
            
            for angle_idx in range(12):
                theta = 2 * math.pi * angle_idx / 12
                for frac in [0.5, 0.8, 1.0]:
                    r = ring_r0 + (ring_r1 - ring_r0) * frac
                    px = int(cx + r * math.cos(theta))
                    py = int(cy + r * math.sin(theta))
                    if 0 <= px < sw and 0 <= py < sh and strong[py, px]:
                        total_checked += 1
                        # Expected direction: pointing toward center
                        expected_dir = math.atan2(cy - py, cx - px)
                        actual_dir = float(dir_small[py, px])
                        diff = abs(expected_dir - actual_dir)
                        if diff > math.pi:
                            diff = 2 * math.pi - diff
                        if diff < math.pi / 3:  # within 60 degrees
                            angles_toward += 1
            
            if total_checked >= 6:
                radial_score = angles_toward / total_checked
                if radial_score > 0.35:
                    candidates.append((cx, cy, radial_score, ring_r1))
    
    # Filter and convert to elements
    candidates.sort(key=lambda c: c[2], reverse=True)
    used = []
    for (cx, cy, score, est_r) in candidates[:20]:
        real_cx = int(cx / scale)
        real_cy = int(cy / scale)
        real_r = int(est_r / scale)
        
        # Check if too close to existing
        if any(math.sqrt((real_cx - ux)**2 + (real_cy - uy)**2) < real_r
               for (ux, uy) in used):
            continue
        
        used.append((real_cx, real_cy))
        
        pad = max(3, int(real_r * 0.1))
        x0 = max(0, real_cx - real_r - pad)
        y0 = max(0, real_cy - real_r - pad)
        x1 = min(img_w, real_cx + real_r + pad)
        y1 = min(img_h, real_cy + real_r + pad)
        
        conf = min(0.88, 0.55 + score * 0.35)
        el = _make_el("knob", "rotary_dial",
                       x0, y0, x1 - x0, y1 - y0,
                       conf, "gradient", radius=real_r)
        el["center"] = {"x": real_cx, "y": real_cy}
        elements.append(el)
    
    return elements


# ─── Grid / Layout Normalization Pass ────────────────────────────────────────

def _grid_normalization_pass(elements: List[dict], img_w: int, img_h: int) -> List[dict]:
    """
    Post-detection pass that exploits the regularity of synth/plugin UIs.

    Synth panels have grids of knobs, rows of sliders, etc.  When identical
    physical controls are detected, slight differences in bounding-box size
    come from noise/lighting, not from actual shape differences.

    Algorithm:
    1. Group same-type elements by size similarity (cluster around median).
    2. For each cluster of ≥3, find row/column grid patterns (regular spacing).
    3. Within a grid group: normalise all bounding boxes to the median size
       and snap center coordinates to the inferred grid positions.
    4. Mark grid members with sub_type suffix ("/grid") so the frontend can
       style them distinctly.
    """
    from collections import defaultdict

    GRID_TYPES = {"knob", "button", "slider", "led"}
    SIZE_TOLERANCE = 0.35   # elements within ±35% of median size → same cluster
    SPACING_TOLERANCE = 0.25  # grid spacing variance threshold

    def _median_size(els: List[dict]) -> float:
        sizes = [(e["bounds"]["width"] + e["bounds"]["height"]) / 2 for e in els]
        return float(np.median(sizes)) if sizes else 0.0

    def _find_grid_spacing(coords: List[float]) -> Optional[float]:
        """Return dominant grid spacing if the positions form a regular sequence."""
        if len(coords) < 3:
            return None
        coords_s = sorted(coords)
        gaps = [coords_s[i + 1] - coords_s[i] for i in range(len(coords_s) - 1)]
        gaps = [g for g in gaps if g > 2]
        if not gaps:
            return None
        med_gap = float(np.median(gaps))
        if med_gap < 2:
            return None
        cv = float(np.std(gaps)) / max(med_gap, 1)
        return med_gap if cv < SPACING_TOLERANCE else None

    # Group by type
    by_type: dict = defaultdict(list)
    for el in elements:
        if el["type"] in GRID_TYPES:
            by_type[el["type"]].append(el)

    for type_, group in by_type.items():
        if len(group) < 3:
            continue

        # Size-cluster: find the dominant size band
        med = _median_size(group)
        cluster = [e for e in group
                   if abs((_median_size([e]) - med) / max(med, 1)) < SIZE_TOLERANCE]
        if len(cluster) < 3:
            continue

        # Try row-detection (same Y ± tolerance) and column-detection (same X ± tolerance)
        for axis, coord_key, opp_key in [("row", "x", "y"), ("col", "y", "x")]:
            cx_vals = [e["center"][coord_key] for e in cluster]
            cy_vals = [e["center"][opp_key] for e in cluster]

            spacing = _find_grid_spacing(cx_vals)
            if spacing is None:
                continue

            # Group by the orthogonal axis (same row/column)
            opp_med = float(np.median(cy_vals))
            opp_tol = max(med * 0.6, 8)
            row_members = [e for e in cluster
                           if abs(e["center"][opp_key] - opp_med) < opp_tol]
            if len(row_members) < 3:
                continue

            # ── Normalise sizes within this grid row/col ──────────────────
            target_w = int(round(np.median([e["bounds"]["width"]  for e in row_members])))
            target_h = int(round(np.median([e["bounds"]["height"] for e in row_members])))
            target_r = int(round(np.median([e.get("radius") or 0 for e in row_members
                                             if e.get("radius") is not None]))) or None

            for el in row_members:
                cx = el["center"]["x"]
                cy = el["center"]["y"]
                half_w = target_w // 2
                half_h = target_h // 2
                el["bounds"] = {
                    "x": max(0, cx - half_w),
                    "y": max(0, cy - half_h),
                    "width": target_w,
                    "height": target_h,
                }
                if target_r is not None and el.get("radius") is not None:
                    el["radius"] = target_r
                    el["shapeData"] = {
                        "cx": cx, "cy": cy, "radius": target_r,
                    }
                    el["shape"] = "circle"
                # Mark as grid member
                if "/grid" not in el.get("sub_type", ""):
                    el["sub_type"] = el.get("sub_type", "") + "/grid"

    return elements


# ─── Strategy 7: MSER text labels ────────────────────────────────────────────

def _detect_text_regions(gray: np.ndarray) -> List[dict]:
    img_h, img_w = gray.shape[:2]
    elements = []

    mser = cv2.MSER_create(5, 40, int(img_w * img_h * 0.00035), 0.2)
    regions, _ = mser.detectRegions(gray)
    if not regions:
        return elements

    hulls = [cv2.convexHull(r.reshape(-1, 1, 2)) for r in regions]
    rects = [cv2.boundingRect(h) for h in hulls]

    mask = np.zeros((img_h, img_w), dtype=np.uint8)
    for (x, y, w, h) in rects:
        if h < 6 or w < 8 or h > img_h * 0.03:
            continue
        mask[y: y + h, x: x + w] = 255

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (10, 3))
    dilated = cv2.dilate(mask, kernel, iterations=1)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:120]

    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        rel_area = (w * h) / (img_w * img_h)
        aspect = w / max(h, 1)
        if w < 18 or h < 7 or rel_area > 0.0035 or not (1.8 < aspect < 14.0):
            continue
        elements.append({
            "id": f"label_{uuid.uuid4().hex[:6]}",
            "type": "label",
            "sub_type": "text",
            "bounds": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
            "center": {"x": int(x + w // 2), "y": int(y + h // 2)},
            "radius": None,
            "confidence": 0.60,
            "detected_by": "mser",
        })

    return elements[:40]


# ─── OCR (optional) ──────────────────────────────────────────────────────────

def _try_read_labels(gray: np.ndarray, elements: List[dict]) -> None:
    """Read text labels near detected elements using pytesseract if available."""
    try:
        import pytesseract  # type: ignore
    except ImportError:
        return

    img_h, img_w = gray.shape[:2]
    for el in elements:
        b = el["bounds"]
        label_y1 = min(img_h, b["y"] + b["height"])
        label_y2 = min(img_h, label_y1 + max(20, int(b["height"] * 0.9)))
        label_x1 = max(0, b["x"] - 12)
        label_x2 = min(img_w, b["x"] + b["width"] + 12)
        if label_y2 <= label_y1 or label_x2 <= label_x1:
            continue
        strip = gray[label_y1:label_y2, label_x1:label_x2]
        if strip.size == 0:
            continue
        scale = max(1, 24 // max(strip.shape[0], 1))
        strip_up = cv2.resize(strip, None, fx=scale, fy=scale,
                              interpolation=cv2.INTER_CUBIC)
        try:
            text = pytesseract.image_to_string(
                strip_up,
                config="--psm 7 -c tessedit_char_whitelist="
                       "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .-_/",
            ).strip()
            if text:
                el["label"] = text
        except Exception:
            continue


# ─── Strategy 8: Parameter text-field detection ──────────────────────────────

def _detect_param_fields(
    gray: np.ndarray,
    enhanced: np.ndarray,
    binary_adaptive: np.ndarray,
    img_h: int,
    img_w: int,
) -> List[dict]:
    """
    Detect small parameter display boxes — the numeric/text readouts that show
    current values (e.g. "127", "-6dB", "A4T", "SEMI", "OCTAVE").

    These are typically:
    - Small, wide rectangles (aspect 1.5–8, height 10–40px at full res)
    - High local text density (lots of horizontal transitions in adaptive threshold)
    - Often have a bounding box / inset border
    - Positioned near knobs/sliders as value readouts
    """
    elements: List[dict] = []

    # Build a "text density" map: dilate adaptive threshold horizontally
    k_h = cv2.getStructuringElement(cv2.MORPH_RECT, (12, 2))
    k_v = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3))
    text_dilated = cv2.dilate(binary_adaptive, k_h, iterations=1)
    text_dilated = cv2.erode(text_dilated, k_v, iterations=1)

    contours, _ = cv2.findContours(text_dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:300]

    for cnt in contours:
        area = cv2.contourArea(cnt)
        rel_area = area / (img_w * img_h)

        # Reject too small or too large
        if rel_area < 0.00008 or rel_area > 0.015:
            continue

        x, y, w, h = cv2.boundingRect(cnt)
        aspect = w / max(h, 1)

        # Typical text field shape: wider than tall, but not extreme
        if aspect < 1.3 or aspect > 12.0:
            continue
        # Height in pixels relative to image (small readouts)
        h_frac = h / img_h
        if h_frac > 0.08:
            continue
        if h < 6 or w < 14:
            continue

        # Measure local text density inside the bounding box
        roi_adapt = binary_adaptive[y:y+h, x:x+w]
        if roi_adapt.size == 0:
            continue
        text_density = float(np.mean(roi_adapt > 0))

        # Must have meaningful text content (10–70% white pixels in adaptive thresh)
        if text_density < 0.08 or text_density > 0.72:
            continue

        # Measure edge activity in gray ROI — text creates strong horizontal edges
        roi_gray = gray[y:y+h, x:x+w]
        sobel_h = cv2.Sobel(roi_gray, cv2.CV_64F, 1, 0, ksize=3)
        h_edge_density = float(np.mean(np.abs(sobel_h) > 20))
        if h_edge_density < 0.06:
            continue

        # Check for a bounding box border (bright pixels on the perimeter)
        border = max(1, int(min(w, h) * 0.12))
        perimeter_pixels = np.concatenate([
            roi_adapt[:border, :].ravel(),
            roi_adapt[-border:, :].ravel(),
            roi_adapt[:, :border].ravel(),
            roi_adapt[:, -border:].ravel(),
        ])
        # A bordered text field has ~consistent edges on all sides
        # but doesn't require it — many synth readouts are borderless
        has_border = float(np.mean(perimeter_pixels > 0)) > 0.15

        # Confidence: higher for bordered fields, larger fields, better text density
        conf = 0.52
        conf += min(text_density, 0.5) * 0.20
        conf += h_edge_density * 0.15
        if has_border:
            conf += 0.10
        # Aspect ratio bonus: sweet spot around 2–6
        if 2.0 < aspect < 6.0:
            conf += 0.05
        conf = min(0.88, conf)

        if conf < 0.50:
            continue

        cx = int(x + w // 2)
        cy = int(y + h // 2)
        elements.append({
            "id": f"text_field_{uuid.uuid4().hex[:6]}",
            "type": "text_field",
            "sub_type": "value_display",
            "bounds": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
            "center": {"x": cx, "y": cy},
            "radius": None,
            "confidence": round(conf, 2),
            "detected_by": "param_field",
            "shape": "rect",
            "shapeData": {"cx": cx, "cy": cy, "w": int(w), "h": int(h), "angle": 0.0},
        })

    return elements


# ─── Perspective corner auto-detection ───────────────────────────────────────

def detect_panel_corners(image_b64: str) -> dict:
    """
    Auto-detect the 4 corners of the plugin panel for perspective correction.

    Returns the best quadrilateral found (or None if not found), plus
    a debug-annotated image.
    """
    img_raw = _decode_image(image_b64)
    img = _to_bgr(img_raw)
    img_h, img_w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Multi-scale Canny
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    edges = cv2.Canny(blurred, 20, 80)

    # Dilate to close small gaps in the panel border
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=3)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:15]

    best_quad = None
    best_area = 0

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < img_w * img_h * 0.04:
            continue

        # Try different epsilon values for approx
        for eps_factor in [0.02, 0.035, 0.05, 0.07]:
            epsilon = eps_factor * cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, epsilon, True)
            if len(approx) == 4 and area > best_area:
                pts = approx.reshape(4, 2).astype(float)
                # Order: TL, TR, BR, BL
                s = pts.sum(axis=1)
                diff = np.diff(pts, axis=1)
                ordered = np.array([
                    pts[np.argmin(s)],   # TL
                    pts[np.argmin(diff)],  # TR
                    pts[np.argmax(s)],   # BR
                    pts[np.argmax(diff)],  # BL
                ])
                best_quad = ordered.tolist()
                best_area = area
                break

    # Fallback: use the full image corners
    if best_quad is None:
        best_quad = [
            [0.0, 0.0],
            [float(img_w - 1), 0.0],
            [float(img_w - 1), float(img_h - 1)],
            [0.0, float(img_h - 1)],
        ]

    return {
        "corners": best_quad,
        "imageWidth": img_w,
        "imageHeight": img_h,
        "detected": best_area > 0,
    }


# ─── Main public function ─────────────────────────────────────────────────────

def analyze_ui_layout(
    image_b64: str,
    min_confidence: float = 0.50,
    detect_labels: bool = True,
    iou_threshold: float = 0.35,
    progress_cb=None,
    elements_cb=None,
) -> dict:
    """
    Analyze a plugin/hardware screenshot and return a structured layout JSON.

    Uses a multi-stage detection pipeline with cross-validation for robust
    element identification even on complex photographic images.

    Parameters
    ----------
    progress_cb : callable(stage: str, percent: int, message: str) | None
        Optional callback called at each pipeline stage. Useful for streaming
        progress over SSE.
    elements_cb : callable(stage: str, result: dict) | None
        Optional callback with cumulative partial layout snapshots as elements
        are discovered.

    Returns
    -------
    {
      "imageWidth": int, "imageHeight": int,
      "timestamp": ISO-8601, "elementCount": int,
      "elements": [{
        "id", "type", "sub_type", "label",
        "bounds": {x,y,width,height},
        "center": {x,y}, "radius",
        "confidence",
        "normalizedBounds": {x,y,width,height},
        "normalizedCenter": {x,y}
      }]
    }
    """
    def _progress(stage: str, pct: int, msg: str):
        if progress_cb is not None:
            try:
                progress_cb(stage, pct, msg)
            except Exception:
                pass

    def _emit_elements(stage: str, elements: List[dict]):
        if elements_cb is not None:
            try:
                elements_cb(
                    stage,
                    _build_layout_result(
                        elements,
                        detection_scale,
                        img_w,
                        img_h,
                        min_confidence,
                        iou_threshold,
                    ),
                )
            except Exception:
                pass

    _progress("decode", 2, "Decoding image…")
    img_raw = _decode_image(image_b64)
    img = _to_bgr(img_raw)
    img_h, img_w = img.shape[:2]

    _progress("preprocess", 6, "Preprocessing…")
    detection_scale = min(1.0, DETECTION_MAX_DIM / max(img_w, img_h))
    if detection_scale < 1.0:
        detect_w = max(1, int(round(img_w * detection_scale)))
        detect_h = max(1, int(round(img_h * detection_scale)))
        work_img = cv2.resize(img, (detect_w, detect_h), interpolation=cv2.INTER_AREA)
    else:
        work_img = img
    work_h, work_w = work_img.shape[:2]
    gray = cv2.cvtColor(work_img, cv2.COLOR_BGR2GRAY)

    # Multi-strategy preprocessing
    pp = _preprocess_multi(gray, work_img)
    enhanced = pp["enhanced"]
    edges_tight = pp["edges_tight"]
    edges_loose = pp["edges_loose"]

    # ── Run all detectors ──
    _progress("circles", 15, "Detecting knobs & buttons…")
    circles_raw = _detect_circles(
        enhanced, edges_tight, work_img, gray,
        pp["gradient_mag"], work_h, work_w
    )
    _emit_elements("circles", circles_raw)

    _progress("color", 25, "Detecting colored elements…")
    color_raw = _detect_colored_elements(pp["hsv"], work_img, work_h, work_w)
    _emit_elements("color", circles_raw + color_raw)

    _progress("frames", 32, "Detecting displays & panels…")
    frames_raw = _detect_frames(gray, edges_tight, work_h, work_w)
    _emit_elements("frames", circles_raw + color_raw + frames_raw)

    _progress("gradient", 40, "Detecting rotary elements…")
    gradient_raw = _detect_rotary_by_gradient(
        pp["gradient_mag"], pp["gradient_dir"], gray, work_h, work_w
    )
    _emit_elements("gradient", circles_raw + color_raw + frames_raw + gradient_raw)

    _progress("faders", 48, "Detecting sliders & faders…")
    faders_raw = _detect_faders(gray, enhanced, work_h, work_w)
    _emit_elements("faders", circles_raw + color_raw + frames_raw + gradient_raw + faders_raw)

    _progress("meters", 54, "Detecting analog meters…")
    meters_raw = _detect_meters(work_img, pp["hsv"], gray, edges_tight, work_h, work_w)
    _emit_elements("meters", circles_raw + color_raw + frames_raw + gradient_raw + faders_raw + meters_raw)

    _progress("contours", 60, "Classifying shapes…")
    contours_raw = _detect_contours(
        enhanced, edges_loose, pp["binary_adaptive"],
        work_h, work_w, detect_labels
    )
    _emit_elements("contours", circles_raw + color_raw + frames_raw + gradient_raw + faders_raw + meters_raw + contours_raw)

    _progress("text_fields", 68, "Detecting parameter text fields…")
    param_fields_raw = _detect_param_fields(
        gray, enhanced, pp["binary_adaptive"], work_h, work_w
    )
    _emit_elements("text_fields", circles_raw + color_raw + frames_raw + gradient_raw + faders_raw + meters_raw + contours_raw + param_fields_raw)

    _progress("labels", 74, "Detecting text labels…")
    labels_raw = _detect_text_regions(gray) if detect_labels else []
    _emit_elements("labels", circles_raw + color_raw + frames_raw + gradient_raw + faders_raw + meters_raw + contours_raw + param_fields_raw + labels_raw)

    # ── NMS per group ──
    _progress("nms", 78, "Merging detections…")
    circles_ok      = _nms(circles_raw,      iou_threshold)
    color_ok        = _nms(color_raw,        iou_threshold)
    frames_ok       = _nms(frames_raw,       iou_threshold)
    gradient_ok     = _nms(gradient_raw,     iou_threshold)
    faders_ok       = _nms(faders_raw,       iou_threshold)
    meters_ok       = _nms(meters_raw,       iou_threshold)
    contours_ok     = _nms(contours_raw,     iou_threshold)
    param_fields_ok = _nms(param_fields_raw, iou_threshold)
    labels_ok       = _nms(labels_raw,       iou_threshold)

    # ── Cross-validate: gradient knobs that overlap with Hough knobs get a boost ──
    for gel in gradient_ok:
        for hel in circles_ok:
            if _iou(gel["bounds"], hel["bounds"]) > 0.3:
                # Both detectors agree — boost the Hough detection
                hel["confidence"] = min(0.98, hel["confidence"] + 0.05)
                gel["confidence"] = 0.0  # Suppress duplicate
                break
    gradient_ok = [e for e in gradient_ok if e["confidence"] > 0]

    # ── Cross-group suppression: higher-priority detections eat lower ones ──
    def _not_eaten(el: dict, winners: List[dict], thr: float) -> bool:
        return not any(_iou(el["bounds"], w["bounds"]) > thr for w in winners)

    primary_circles = circles_ok + gradient_ok
    faders_ok       = [e for e in faders_ok       if _not_eaten(e, primary_circles, 0.45)]
    color_ok        = [e for e in color_ok        if _not_eaten(e, primary_circles, 0.50)]
    contours_ok     = [e for e in contours_ok     if _not_eaten(e, primary_circles, 0.45)]
    contours_ok     = [e for e in contours_ok     if _not_eaten(e, faders_ok,  0.40)]
    contours_ok     = [e for e in contours_ok     if _not_eaten(e, frames_ok,  0.50)]
    # Meters should not be eaten by knob/circle detectors (different scale)
    meters_ok       = [e for e in meters_ok       if _not_eaten(e, frames_ok,   0.55)]
    # param fields should not eat controls — suppress only if heavily overlapping
    all_controls    = primary_circles + faders_ok + frames_ok + meters_ok
    param_fields_ok = [e for e in param_fields_ok if _not_eaten(e, all_controls, 0.55)]
    labels_ok       = [e for e in labels_ok
                       if _not_eaten(e, primary_circles + faders_ok, 0.60)]
    # Suppress text labels that overlap with detected param fields
    labels_ok       = [e for e in labels_ok if _not_eaten(e, param_fields_ok, 0.50)]
    _emit_elements(
        "nms",
        circles_ok + gradient_ok + color_ok + frames_ok + meters_ok + faders_ok + contours_ok + param_fields_ok + labels_ok,
    )

    _progress("finalize", 85, "Normalizing layout…")
    all_elements = (circles_ok + gradient_ok + color_ok + frames_ok +
                    meters_ok + faders_ok + contours_ok + param_fields_ok + labels_ok)
    all_elements = _finalize_layout_elements(
        all_elements,
        detection_scale,
        img_w,
        img_h,
        min_confidence,
        iou_threshold,
    )
    _emit_elements("finalize", all_elements)

    # ── OCR labels ──
    _progress("ocr", 90, "Reading text labels…")
    gray_full = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _try_read_labels(gray_full, all_elements)
    _emit_elements("ocr", all_elements)

    _progress("done", 100, f"Found {len(all_elements)} elements")
    return {
        "imageWidth":   img_w,
        "imageHeight":  img_h,
        "timestamp":    datetime.now(timezone.utc).isoformat(),
        "elementCount": len(all_elements),
        "elements":     all_elements,
    }
