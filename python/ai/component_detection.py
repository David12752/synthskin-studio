"""
5.2 Component Detection — AI-powered component recognition.

Enhanced detection using contour analysis, shape classification,
and heuristics for audio equipment components.
Upgradable to YOLO when model is available.
"""
import base64
import math
import uuid
from typing import List

import cv2
import numpy as np


def _b64_to_cv(data_url: str) -> np.ndarray:
    header, data = data_url.split(",", 1)
    raw = base64.b64decode(data)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def _cv_to_b64(img: np.ndarray) -> str:
    _, buf = cv2.imencode(".png", img)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _classify_contour(contour: np.ndarray, img_w: int, img_h: int) -> dict:
    """
    Classify a contour into a component type based on shape properties.

    Returns: {type, confidence, sub_type}
    """
    area = cv2.contourArea(contour)
    perimeter = cv2.arcLength(contour, True)
    if perimeter == 0:
        return {"type": "unknown", "confidence": 0, "sub_type": ""}

    # Shape metrics
    circularity = 4 * math.pi * area / (perimeter * perimeter)
    x, y, w, h = cv2.boundingRect(contour)
    aspect_ratio = w / max(h, 1)
    extent = area / max(w * h, 1)
    hull = cv2.convexHull(contour)
    hull_area = cv2.contourArea(hull)
    solidity = area / max(hull_area, 1)

    # Relative size
    rel_area = area / max(img_w * img_h, 1)

    # --- Classification rules ---

    # Knobs: circular, medium-sized, high solidity
    if circularity > 0.7 and 0.001 < rel_area < 0.15 and solidity > 0.85:
        conf = min(circularity * 0.7 + solidity * 0.3, 1.0)
        return {"type": "knob", "confidence": round(conf, 2), "sub_type": "rotary"}

    # Buttons: circular but small
    if circularity > 0.65 and rel_area < 0.005 and solidity > 0.8:
        conf = min(circularity * 0.6 + 0.3, 0.95)
        return {"type": "button", "confidence": round(conf, 2), "sub_type": "push"}

    # LEDs: very small, circular
    if circularity > 0.6 and rel_area < 0.001:
        return {"type": "led", "confidence": 0.7, "sub_type": "round"}

    # Sliders/Faders: tall and narrow
    if aspect_ratio < 0.3 and rel_area > 0.002 and extent > 0.3:
        conf = min((1 - aspect_ratio) * 0.6 + extent * 0.3, 0.95)
        return {"type": "slider", "confidence": round(conf, 2), "sub_type": "vertical"}

    # Horizontal sliders
    if aspect_ratio > 3.0 and rel_area > 0.002 and extent > 0.3:
        conf = min(aspect_ratio / 10 * 0.5 + extent * 0.3, 0.9)
        return {"type": "slider", "confidence": round(conf, 2), "sub_type": "horizontal"}

    # Screens/displays: rectangular, medium, lower circularity
    if 0.8 < aspect_ratio < 3.0 and circularity < 0.6 and rel_area > 0.005 and solidity > 0.8:
        conf = min(solidity * 0.5 + extent * 0.3, 0.85)
        return {"type": "screen", "confidence": round(conf, 2), "sub_type": "lcd"}

    # Meters: taller rectangles or half-circles
    if 0.5 < aspect_ratio < 1.5 and circularity > 0.4 and circularity < 0.7 and rel_area > 0.003:
        return {"type": "meter", "confidence": 0.6, "sub_type": "vu"}

    # Labels: very wide rectangles, small
    if aspect_ratio > 2.5 and rel_area < 0.005 and solidity > 0.7:
        return {"type": "label", "confidence": 0.55, "sub_type": "text"}

    # Jacks: small circles with specific size
    if circularity > 0.5 and 0.0005 < rel_area < 0.003:
        return {"type": "jack", "confidence": 0.5, "sub_type": "quarter"}

    return {"type": "unknown", "confidence": 0.3, "sub_type": ""}


def detect_components(
    image_b64: str,
    min_area: int = 200,
    max_area: int = 0,
    confidence_threshold: float = 0.4,
) -> List[dict]:
    """
    Detect and classify UI components in an image.

    Returns list of {id, type, sub_type, confidence, bounds, center, preview}
    """
    img = _b64_to_cv(image_b64)
    h, w = img.shape[:2]
    if max_area <= 0:
        max_area = int(w * h * 0.4)

    # Convert to grayscale
    gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)

    # Edge detection
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 120)

    # Morphological closing to connect nearby edges
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Find contours
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    detections = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area or area > max_area:
            continue

        classification = _classify_contour(contour, w, h)
        if classification["confidence"] < confidence_threshold:
            continue

        x, y, bw, bh = cv2.boundingRect(contour)
        # Pad bounding box slightly
        pad = int(max(bw, bh) * 0.05)
        x0 = max(0, x - pad)
        y0 = max(0, y - pad)
        x1 = min(w, x + bw + pad)
        y1 = min(h, y + bh + pad)

        # Extract crop
        crop = img[y0:y1, x0:x1].copy()

        # Build a contour mask in local (crop) coordinates and apply to alpha
        local_contour = contour - np.array([[[x0, y0]]])
        ch, cw = crop.shape[:2]
        contour_mask = np.zeros((ch, cw), dtype=np.uint8)
        cv2.drawContours(contour_mask, [local_contour], -1, 255, cv2.FILLED)
        # Slight feather for anti-aliased edges
        contour_mask = cv2.GaussianBlur(contour_mask, (3, 3), 0.8)
        if crop.shape[2] == 4:
            crop[:, :, 3] = cv2.bitwise_and(crop[:, :, 3], contour_mask)
        else:
            crop = cv2.cvtColor(crop, cv2.COLOR_BGR2BGRA)
            crop[:, :, 3] = contour_mask
        preview = _cv_to_b64(crop)

        # Moments for center
        M = cv2.moments(contour)
        cx = int(M["m10"] / max(M["m00"], 1))
        cy = int(M["m01"] / max(M["m00"], 1))

        detections.append({
            "id": f"det_{uuid.uuid4().hex[:8]}",
            "type": classification["type"],
            "sub_type": classification["sub_type"],
            "confidence": classification["confidence"],
            "bounds": {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0},
            "center": {"x": cx, "y": cy},
            "preview": preview,
        })

    # Sort by confidence (highest first)
    detections.sort(key=lambda d: d["confidence"], reverse=True)

    # Non-maximum suppression (remove overlapping detections)
    filtered = []
    for det in detections:
        overlap = False
        for kept in filtered:
            # Check IoU
            bx = max(det["bounds"]["x"], kept["bounds"]["x"])
            by = max(det["bounds"]["y"], kept["bounds"]["y"])
            bx2 = min(
                det["bounds"]["x"] + det["bounds"]["width"],
                kept["bounds"]["x"] + kept["bounds"]["width"],
            )
            by2 = min(
                det["bounds"]["y"] + det["bounds"]["height"],
                kept["bounds"]["y"] + kept["bounds"]["height"],
            )
            if bx2 > bx and by2 > by:
                inter = (bx2 - bx) * (by2 - by)
                area_a = det["bounds"]["width"] * det["bounds"]["height"]
                area_b = kept["bounds"]["width"] * kept["bounds"]["height"]
                iou = inter / max(area_a + area_b - inter, 1)
                if iou > 0.4:
                    overlap = True
                    break
        if not overlap:
            filtered.append(det)

    return filtered


def check_yolo_available() -> bool:
    """Check if YOLO model is available for enhanced detection."""
    try:
        import ultralytics  # noqa: F401
        return True
    except ImportError:
        return False
