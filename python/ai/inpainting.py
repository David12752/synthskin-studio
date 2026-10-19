"""
5.6 Text Removal & Inpainting — Remove unwanted elements from images.

Uses OpenCV Telea/Navier-Stokes inpainting as baseline.
LaMa model available as optional upgrade for superior results.
"""
import base64

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


def _mask_from_b64(mask_b64: str) -> np.ndarray:
    """Decode a mask image (white = inpaint region)."""
    header, data = mask_b64.split(",", 1)
    raw = base64.b64decode(data)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("Failed to decode mask")
    return img


def detect_text_regions(image_b64: str) -> dict:
    """
    Detect text-like regions in an image using morphological analysis.

    Returns: {regions: [{x, y, width, height}], mask_dataUrl}
    """
    img = _b64_to_cv(image_b64)
    h, w = img.shape[:2]

    # Convert to grayscale
    gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)

    # Edge detection to find text strokes
    edges = cv2.Canny(gray, 80, 200)

    # Morphological processing to connect text characters
    # Horizontal kernel to connect characters in a line
    kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
    connected = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel_h, iterations=2)

    # Vertical dilation to connect multi-line text
    kernel_v = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 5))
    connected = cv2.morphologyEx(connected, cv2.MORPH_CLOSE, kernel_v, iterations=1)

    # Find contours of text regions
    contours, _ = cv2.findContours(connected, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    regions = []
    mask = np.zeros((h, w), dtype=np.uint8)

    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        area = bw * bh
        aspect = bw / max(bh, 1)

        # Text heuristics: wider than tall, not too large, reasonable aspect ratio
        if aspect > 1.5 and area < w * h * 0.15 and bh < h * 0.15 and area > 100:
            # Pad slightly
            pad = 3
            x0 = max(0, x - pad)
            y0 = max(0, y - pad)
            x1 = min(w, x + bw + pad)
            y1 = min(h, y + bh + pad)
            regions.append({"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0})
            mask[y0:y1, x0:x1] = 255

    return {
        "regions": regions,
        "count": len(regions),
        "mask_dataUrl": _cv_to_b64(cv2.cvtColor(mask, cv2.COLOR_GRAY2BGRA)),
    }


def inpaint(
    image_b64: str,
    mask_b64: str,
    method: str = "telea",
    radius: int = 5,
) -> dict:
    """
    Inpaint (fill) masked regions of an image.

    Args:
        mask_b64: White regions get inpainted
        method: "telea" (fast) or "navier-stokes" (smoother)
        radius: inpainting radius in pixels

    Returns: {dataUrl, method, pixels_inpainted}
    """
    img = _b64_to_cv(image_b64)
    mask = _mask_from_b64(mask_b64)

    # Ensure mask matches image size
    if mask.shape[:2] != img.shape[:2]:
        mask = cv2.resize(mask, (img.shape[1], img.shape[0]))

    # Threshold mask
    _, mask_bin = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)
    pixels = int(np.sum(mask_bin > 0))

    # Preserve alpha channel
    alpha = img[:, :, 3].copy()
    bgr = img[:, :, :3]

    # Choose inpainting algorithm
    if method == "navier-stokes":
        flag = cv2.INPAINT_NS
    else:
        flag = cv2.INPAINT_TELEA

    result_bgr = cv2.inpaint(bgr, mask_bin, radius, flag)

    # Reconstruct with alpha
    result = np.zeros_like(img)
    result[:, :, :3] = result_bgr
    result[:, :, 3] = alpha

    return {
        "dataUrl": _cv_to_b64(result),
        "method": method,
        "pixels_inpainted": pixels,
    }


def auto_remove_text(
    image_b64: str,
    method: str = "telea",
    radius: int = 5,
) -> dict:
    """
    Detect and remove text from an image in one step.

    Returns: {dataUrl, method, regions_found, pixels_inpainted}
    """
    # First detect text regions
    detection = detect_text_regions(image_b64)

    if detection["count"] == 0:
        return {
            "dataUrl": image_b64,
            "method": method,
            "regions_found": 0,
            "pixels_inpainted": 0,
        }

    # Create mask from detected regions
    img = _b64_to_cv(image_b64)
    h, w = img.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    for r in detection["regions"]:
        mask[r["y"]:r["y"] + r["height"], r["x"]:r["x"] + r["width"]] = 255

    mask_b64 = _cv_to_b64(cv2.cvtColor(mask, cv2.COLOR_GRAY2BGRA))
    result = inpaint(image_b64, mask_b64, method, radius)

    return {
        "dataUrl": result["dataUrl"],
        "method": method,
        "regions_found": detection["count"],
        "pixels_inpainted": result["pixels_inpainted"],
    }


def check_lama_available() -> bool:
    """Check if LaMa inpainting model is available."""
    try:
        import torch  # noqa: F401
        import os
        model_path = os.path.join(os.path.dirname(__file__), "..", "models", "big-lama.pt")
        return os.path.exists(model_path)
    except ImportError:
        return False
