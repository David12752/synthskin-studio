"""
panel_state.py — Detect the current state of each panel control.

Supported detections:
  knob    → pointer angle (deg), value_normalized
  slider  → cap position (px + normalized), orientation
  meter   → needle angle (deg), value_normalized  (screen-type controls)

Each detector operates entirely inside the control's bounding-box crop so
it runs independently and in O(controls) time.
"""
from __future__ import annotations

import base64
import logging
import math
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

Bbox = Tuple[float, float, float, float]


# ─── Image helpers ────────────────────────────────────────────────────────────

def _decode_bgr(data_url: str) -> np.ndarray:
    if data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    return img


def _crop(img: np.ndarray, bbox: Bbox, pad: int = 2) -> Optional[np.ndarray]:
    h, w = img.shape[:2]
    x1, y1, x2, y2 = (int(round(v)) for v in bbox)
    x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
    x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
    if x2 <= x1 or y2 <= y1:
        return None
    return img[y1:y2, x1:x2]


# ─── Knob angle detection ─────────────────────────────────────────────────────

def _detect_knob_angle(crop: np.ndarray) -> Optional[Dict[str, Any]]:
    """Detect the rotary knob pointer angle using polar transform.

    Strategy:
      1. Find the knob circle (Hough or bbox centre + min-radius).
      2. Build a polar representation (angle × radius).
      3. In the outer ring (0.55–0.85 × max_r) find the column whose mean
         brightness diverges most from its neighbours — that is the pointer.
      4. Convert to –135°…+135° range (standard synth convention, 12 o'clock = 0°).

    Returns {angle_deg, value_normalized, method} or None on failure.
    """
    if crop is None or crop.size == 0:
        return None
    h, w = crop.shape[:2]
    if min(h, w) < 12:
        return None

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    cx, cy = w / 2.0, h / 2.0
    max_r  = min(cx, cy) * 0.95

    # ── Try Hough to refine circle centre ────────────────────────────────────
    blur = cv2.GaussianBlur(gray, (5, 5), 1.5)
    r_min = max(4, int(max_r * 0.30))
    r_max = max(r_min + 2, int(max_r))
    circles = cv2.HoughCircles(
        blur, cv2.HOUGH_GRADIENT, dp=1.2,
        minDist=max(8, int(max_r)),
        param1=80, param2=18, minRadius=r_min, maxRadius=r_max,
    )
    if circles is not None:
        best = circles[0][0]
        cx, cy = float(best[0]), float(best[1])
        max_r = float(best[2])

    # ── Polar transform ───────────────────────────────────────────────────────
    polar_w = 360          # 1 column per degree
    polar_h = int(max_r)  # rows = radial distance
    if polar_h < 4:
        return None

    polar = cv2.warpPolar(
        gray, (polar_w, polar_h),
        (cx, cy), max_r,
        cv2.WARP_POLAR_LINEAR | cv2.INTER_LINEAR,
    )
    # Focus on the outer ring where the pointer stripe is most visible
    ring_start = int(polar_h * 0.55)
    ring_end   = int(polar_h * 0.88)
    if ring_end <= ring_start:
        ring_start = max(0, polar_h - 8)
        ring_end   = polar_h

    ring = polar[ring_start:ring_end, :]          # shape: (ring_h, 360)
    col_means = ring.mean(axis=0).astype(np.float32)  # mean brightness per angle

    # Smooth and find deviation from local baseline (5-degree window)
    from scipy.ndimage import uniform_filter1d  # type: ignore[import]
    try:
        smoothed = uniform_filter1d(col_means.astype(float), size=5, mode="wrap")
        baseline = uniform_filter1d(col_means.astype(float), size=45, mode="wrap")
        deviation = np.abs(smoothed - baseline)
    except Exception:
        # Fallback without scipy
        smoothed = col_means
        baseline_k = np.ones(45, dtype=np.float32) / 45
        baseline = np.convolve(np.tile(col_means, 3), baseline_k, mode="same")[360:720]
        deviation = np.abs(smoothed - baseline)

    pointer_col = int(np.argmax(deviation))

    # opencv warpPolar: column 0 = 3 o'clock (right), goes CW.
    # Convert to bearing from 12 o'clock (north), positive = CW.
    angle_cv = pointer_col   # 0–359°  (0=East, 90=South, 270=North)
    angle_north = (angle_cv - 90) % 360   # 0=North, 90=East, 180=South …
    if angle_north > 180:
        angle_north -= 360               # wrap to –180…+180

    # Clamp to synth range –135…+135  (7 o'clock → 5 o'clock)
    angle_clamped = max(-135.0, min(135.0, float(angle_north)))
    value_norm    = (angle_clamped + 135.0) / 270.0

    return {
        "angle_deg": round(angle_clamped, 1),
        "value_normalized": round(value_norm, 3),
        "method": "polar_pointer",
    }


# ─── Slider cap position ──────────────────────────────────────────────────────

def _detect_slider_position(
    crop: np.ndarray,
    orientation: str = "auto",
) -> Optional[Dict[str, Any]]:
    """Detect where the fader cap/thumb is along the slider track.

    Strategy:
      1. Determine orientation (auto = aspect ratio).
      2. Find the brightest horizontal or vertical stripe in the inner region —
         that stripe is the cap highlight.
      3. Map pixel position → travel fraction (0 = bottom/left, 1 = top/right).

    Returns {orientation, cap_center_px, travel_px, value_normalized, method}.
    """
    if crop is None or crop.size == 0:
        return None
    h, w = crop.shape[:2]
    if min(h, w) < 8:
        return None

    # Determine orientation
    if orientation == "auto":
        orientation = "vertical" if h >= w else "horizontal"

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)

    # Trim edges (15% each side) to avoid border contamination
    margin_r = max(1, int(w * 0.15))
    margin_c = max(1, int(h * 0.15))
    inner = gray[margin_c:h - margin_c, margin_r:w - margin_r]
    if inner.size == 0:
        inner = gray

    if orientation == "vertical":
        # Collapse horizontally → brightness profile along Y axis
        profile = inner.mean(axis=1)
        # Find peak (cap highlight) using argmax after mild smoothing
        if len(profile) < 4:
            return None
        k = min(5, len(profile) // 2 * 2 - 1)
        if k >= 3:
            profile_s = cv2.GaussianBlur(profile.reshape(-1, 1).astype(np.float32),
                                          (1, k), 0).flatten()
        else:
            profile_s = profile.astype(np.float32)
        cap_row = int(np.argmax(profile_s))
        travel_px = inner.shape[0]
        # Fader convention: top = max, bottom = min
        value_norm = 1.0 - cap_row / max(1, travel_px - 1)
        return {
            "orientation": "vertical",
            "cap_center_px": cap_row + margin_c,
            "travel_px": h,
            "value_normalized": round(float(value_norm), 3),
            "method": "brightness_peak",
        }
    else:
        profile = inner.mean(axis=0)
        if len(profile) < 4:
            return None
        k = min(5, len(profile) // 2 * 2 - 1)
        if k >= 3:
            profile_s = cv2.GaussianBlur(profile.reshape(1, -1).astype(np.float32),
                                          (k, 1), 0).flatten()
        else:
            profile_s = profile.astype(np.float32)
        cap_col = int(np.argmax(profile_s))
        travel_px = inner.shape[1]
        value_norm = cap_col / max(1, travel_px - 1)
        return {
            "orientation": "horizontal",
            "cap_center_px": cap_col + margin_r,
            "travel_px": w,
            "value_normalized": round(float(value_norm), 3),
            "method": "brightness_peak",
        }


# ─── Meter needle detection ────────────────────────────────────────────────────

def _detect_meter_needle(crop: np.ndarray) -> Optional[Dict[str, Any]]:
    """Detect a VU meter / analog meter needle angle.

    Strategy:
      1. Edge-detect the crop.
      2. Probabilistic Hough (HoughLinesP) for line segments.
      3. Filter for lines that pass near the crop centre (needle pivot) and are
         longer than 15% of the crop diagonal.
      4. The dominant such line → needle angle from vertical (+ = CW).
      5. Map to –90°…+90° value range, normalise 0–1.

    Returns {angle_deg, value_normalized, method} or None.
    """
    if crop is None or crop.size == 0:
        return None
    h, w = crop.shape[:2]
    if min(h, w) < 16:
        return None

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 1.0)
    edges = cv2.Canny(blur, 40, 130)

    diag = math.hypot(h, w)
    min_len = max(12, int(diag * 0.15))
    lines = cv2.HoughLinesP(
        edges, 1, math.pi / 180,
        threshold=max(12, min_len // 2),
        minLineLength=min_len,
        maxLineGap=max(4, min_len // 4),
    )
    if lines is None:
        return None

    cx, cy = w / 2.0, h / 2.0
    best_line = None
    best_score = -1.0

    for ln in lines[:, 0, :]:
        x1, y1, x2, y2 = map(int, ln)
        length = math.hypot(x2 - x1, y2 - y1)
        if length < min_len:
            continue
        # Distance from line to crop centre (should be small for a needle)
        px, py = cx - x1, cy - y1
        ex, ey = (x2 - x1) / length, (y2 - y1) / length
        dist = abs(px * ey - py * ex)
        if dist > diag * 0.25:
            continue
        # Prefer longer lines and those closer to centre
        score = length - dist * 2
        if score > best_score:
            best_score = score
            best_line = (x1, y1, x2, y2)

    if best_line is None:
        return None

    x1, y1, x2, y2 = best_line
    # Angle from 12 o'clock (straight up = 0°), positive = CW
    dx, dy = x2 - x1, y2 - y1
    # atan2 with y axis pointing DOWN (image coords)
    angle_rad = math.atan2(dx, -dy)  # angle from up-vector
    angle_deg = math.degrees(angle_rad)
    # Clamp to meter range –90°…+90°
    angle_clamped = max(-90.0, min(90.0, angle_deg))
    value_norm = (angle_clamped + 90.0) / 180.0

    return {
        "angle_deg": round(angle_clamped, 1),
        "value_normalized": round(value_norm, 3),
        "method": "hough_needle",
    }


# ─── Public API ───────────────────────────────────────────────────────────────

def detect_control_states(
    controls: List[Dict[str, Any]],
    image_b64: str,
) -> Dict[str, Any]:
    """Detect the current state of each control in the list.

    Returns:
      {
        "states": {
          "<control_id>": {
            "type": "knob"|"slider"|"meter",
            "angle_deg": float,        # knob / meter
            "value_normalized": float, # 0–1, all types
            "orientation": str,        # slider only
            "cap_center_px": int,      # slider only
            "travel_px": int,          # slider only
            "method": str,             # detector used
            "error": str|None          # set when detection failed
          }
        },
        "detected": int,
        "skipped": int
      }
    """
    img = _decode_bgr(image_b64)
    states: Dict[str, Any] = {}
    detected = 0
    skipped  = 0

    for ctrl in controls:
        cid   = ctrl.get("id", "")
        ctype = str(ctrl.get("type", "")).lower()
        bbox: Bbox = tuple(ctrl.get("bbox", [0, 0, 0, 0]))  # type: ignore[assignment]

        crop = _crop(img, bbox)
        result: Optional[Dict[str, Any]] = None

        try:
            if ctype == "knob":
                result = _detect_knob_angle(crop)
            elif ctype in ("slider", "slider_cap", "fader"):
                feat = ctrl.get("features") or {}
                ori  = feat.get("orientation", "auto")
                result = _detect_slider_position(crop, orientation=ori)
            elif ctype in ("meter", "screen", "meter_screen"):
                result = _detect_meter_needle(crop)
        except Exception as exc:
            logger.warning("[STATE] %s id=%s failed: %s", ctype, cid, exc)
            states[cid] = {"error": str(exc), "type": ctype}
            skipped += 1
            continue

        if result is not None:
            result["type"] = ctype
            states[cid] = result
            detected += 1
        else:
            states[cid] = {"type": ctype, "error": "no_detection"}
            skipped += 1

    logger.info("[STATE] %d detected, %d skipped of %d controls", detected, skipped, len(controls))
    return {
        "states": states,
        "detected": detected,
        "skipped": skipped,
    }
