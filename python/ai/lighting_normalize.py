"""
5.3 Lighting Harmonization — Normalize component lighting.

Estimates lighting direction from image gradients and applies
consistent relighting using normal-map estimation.
Works without ML models using gradient analysis.
"""
import base64
import math

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


def estimate_lighting(image_b64: str) -> dict:
    """
    Estimate the dominant lighting direction from an image.

    Uses gradient analysis on the luminance channel to determine
    where highlights cluster vs shadows.

    Returns: {azimuth, elevation, confidence}
    - azimuth:   0-360 degrees (0=right, 90=top, 180=left, 270=bottom)
    - elevation:  0-90 degrees (0=horizon, 90=overhead)
    - confidence: 0-1 how confident the estimate is
    """
    img = _b64_to_cv(image_b64)
    alpha = img[:, :, 3]
    mask = alpha > 128

    gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)

    if not mask.any():
        return {"azimuth": 45, "elevation": 60, "confidence": 0.0}

    # Compute gradients
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=5)

    # Only consider opaque pixels
    gx_masked = gx[mask]
    gy_masked = gy[mask]

    # Average gradient direction (highlights tend to face the light)
    avg_gx = float(np.mean(gx_masked))
    avg_gy = float(np.mean(gy_masked))

    # Azimuth from gradient direction
    azimuth = math.degrees(math.atan2(-avg_gy, avg_gx)) % 360

    # Elevation estimate from brightness distribution
    # Overhead light = more uniform; side light = more contrast
    gray_masked = gray[mask]
    if gray_masked.std() > 0:
        cv_val = gray_masked.std() / max(gray_masked.mean(), 1)
        # Higher CV → more directional (lower elevation)
        elevation = max(15, min(85, 85 - cv_val * 120))
    else:
        elevation = 60

    # Confidence based on gradient magnitude consistency
    mag = np.sqrt(gx_masked ** 2 + gy_masked ** 2)
    if mag.mean() > 0:
        consistency = 1 - min(mag.std() / max(mag.mean(), 1), 1)
        confidence = max(0.1, min(0.95, consistency * 0.7 + 0.2))
    else:
        confidence = 0.1

    return {
        "azimuth": round(azimuth, 1),
        "elevation": round(elevation, 1),
        "confidence": round(confidence, 2),
    }


def normalize_lighting(
    image_b64: str,
    target_azimuth: float = 315,
    target_elevation: float = 60,
    strength: float = 0.7,
) -> dict:
    """
    Re-light an image to match a target lighting direction.

    Uses gradient-based normal estimation and Lambertian shading
    to simulate the target light on the existing surface.

    Returns: {dataUrl, original_lighting, target_lighting}
    """
    img = _b64_to_cv(image_b64)
    h, w = img.shape[:2]
    alpha = img[:, :, 3].astype(np.float32) / 255.0

    # Estimate current lighting
    current = estimate_lighting(image_b64)

    gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)

    # Estimate normals from gradients (Shape-from-Shading lite)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)

    # Normal map: nx = -gx, ny = -gy, nz = 1 (normalized)
    nx = -gx
    ny = -gy
    nz = np.ones_like(nx) * 150  # bias toward flat surface

    norm = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    norm[norm == 0] = 1
    nx /= norm
    ny /= norm
    nz /= norm

    # Current light direction
    cur_az = math.radians(current["azimuth"])
    cur_el = math.radians(current["elevation"])
    cur_lx = math.cos(cur_el) * math.cos(cur_az)
    cur_ly = -math.cos(cur_el) * math.sin(cur_az)
    cur_lz = math.sin(cur_el)

    # Target light direction
    tgt_az = math.radians(target_azimuth)
    tgt_el = math.radians(target_elevation)
    tgt_lx = math.cos(tgt_el) * math.cos(tgt_az)
    tgt_ly = -math.cos(tgt_el) * math.sin(tgt_az)
    tgt_lz = math.sin(tgt_el)

    # Lambertian shading for current and target
    cur_shade = np.clip(nx * cur_lx + ny * cur_ly + nz * cur_lz, 0, 1)
    tgt_shade = np.clip(nx * tgt_lx + ny * tgt_ly + nz * tgt_lz, 0, 1)

    # Ratio: remove current shading, apply target
    cur_shade[cur_shade < 0.05] = 0.05  # avoid division by zero
    ratio = tgt_shade / cur_shade

    # Clamp and smooth
    ratio = np.clip(ratio, 0.3, 3.0)
    ratio = cv2.GaussianBlur(ratio, (7, 7), 0)

    # Apply to image channels
    result = img.copy()
    for c in range(3):
        ch = img[:, :, c].astype(np.float32)
        adjusted = ch * (1.0 - strength + strength * ratio)
        result[:, :, c] = np.clip(adjusted, 0, 255).astype(np.uint8)

    return {
        "dataUrl": _cv_to_b64(result),
        "original_lighting": current,
        "target_lighting": {
            "azimuth": round(target_azimuth, 1),
            "elevation": round(target_elevation, 1),
        },
    }


def harmonize_batch(
    images_b64: list,
    target_azimuth: float = 315,
    target_elevation: float = 60,
    strength: float = 0.7,
) -> list:
    """
    Normalize lighting for a batch of images to match the same target.

    Returns: list of {dataUrl, original_lighting, target_lighting}
    """
    return [
        normalize_lighting(img, target_azimuth, target_elevation, strength)
        for img in images_b64
    ]
