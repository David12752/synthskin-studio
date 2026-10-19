"""
5.1 Style Transfer — Rule-based style engine.

Applies a target "style" (Moog, Roland, Eurorack, Neve, SSL, Ableton, etc.)
to a panel design by remapping colors, materials, and font choices.
Works immediately without ML models.
"""
import base64
import io
import math
from typing import List, Optional

import cv2
import numpy as np
from PIL import Image

# ── Style Presets ────────────────────────────────────────────

STYLE_PRESETS = {
    "moog": {
        "name": "Moog Classic",
        "palette": [(30, 30, 32), (68, 64, 60), (140, 130, 115), (220, 200, 170), (255, 255, 255)],
        "accent": (200, 165, 50),
        "background_color": (30, 30, 32),
        "warmth": 0.15,
        "contrast": 1.1,
        "saturation": 0.85,
        "font_suggestions": ["Futura", "Eurostile", "Helvetica Neue"],
        "material": "brushed-metal",
    },
    "roland": {
        "name": "Roland",
        "palette": [(20, 20, 25), (50, 50, 60), (100, 100, 120), (180, 180, 195), (230, 230, 240)],
        "accent": (0, 160, 230),
        "background_color": (20, 20, 25),
        "warmth": -0.05,
        "contrast": 1.15,
        "saturation": 0.9,
        "font_suggestions": ["DIN", "Industry", "Avant Garde"],
        "material": "painted-metal",
    },
    "eurorack": {
        "name": "Eurorack Minimal",
        "palette": [(10, 10, 10), (40, 40, 42), (80, 80, 85), (160, 160, 165), (240, 240, 245)],
        "accent": (255, 80, 80),
        "background_color": (10, 10, 10),
        "warmth": 0.0,
        "contrast": 1.2,
        "saturation": 0.7,
        "font_suggestions": ["Orbitron", "Share Tech Mono", "JetBrains Mono"],
        "material": "anodized-aluminum",
    },
    "neve": {
        "name": "Neve Console",
        "palette": [(50, 55, 65), (80, 90, 105), (130, 140, 155), (185, 195, 210), (230, 235, 245)],
        "accent": (200, 50, 50),
        "background_color": (50, 55, 65),
        "warmth": 0.08,
        "contrast": 1.05,
        "saturation": 0.75,
        "font_suggestions": ["Helvetica Neue", "DIN", "Futura"],
        "material": "painted-metal",
    },
    "ssl": {
        "name": "SSL Channel",
        "palette": [(35, 38, 42), (65, 70, 78), (110, 118, 130), (175, 180, 190), (225, 228, 235)],
        "accent": (90, 180, 90),
        "background_color": (35, 38, 42),
        "warmth": 0.02,
        "contrast": 1.08,
        "saturation": 0.8,
        "font_suggestions": ["Helvetica Neue", "Arial", "Industry"],
        "material": "brushed-metal",
    },
    "ableton": {
        "name": "Modern Ableton",
        "palette": [(25, 25, 25), (45, 45, 48), (90, 90, 95), (165, 165, 170), (245, 245, 248)],
        "accent": (255, 175, 50),
        "background_color": (25, 25, 25),
        "warmth": 0.0,
        "contrast": 1.0,
        "saturation": 0.6,
        "font_suggestions": ["Inter", "Barlow Condensed", "Rajdhani"],
        "material": "painted-metal",
    },
    "vintage-rack": {
        "name": "Vintage Rack",
        "palette": [(40, 35, 28), (75, 65, 50), (130, 115, 90), (190, 175, 150), (235, 225, 210)],
        "accent": (180, 140, 60),
        "background_color": (40, 35, 28),
        "warmth": 0.25,
        "contrast": 0.95,
        "saturation": 0.9,
        "font_suggestions": ["Bank Gothic", "Eurostile", "Futura"],
        "material": "wood-grain",
    },
}


def _b64_to_cv(data_url: str) -> np.ndarray:
    """Decode base64 data-URL to OpenCV BGRA image."""
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
    """Encode OpenCV image to base64 data-URL."""
    _, buf = cv2.imencode(".png", img)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _remap_colors(img: np.ndarray, palette: list, warmth: float, contrast: float, saturation: float) -> np.ndarray:
    """Remap image colors toward the target palette."""
    result = img.copy()
    bgr = result[:, :, :3].astype(np.float32)

    # Apply contrast
    mean = bgr.mean()
    bgr = (bgr - mean) * contrast + mean

    # Apply warmth (shift toward warm/cool)
    if warmth != 0:
        bgr[:, :, 2] = bgr[:, :, 2] + warmth * 40  # Red
        bgr[:, :, 0] = bgr[:, :, 0] - warmth * 20  # Blue

    # Apply saturation
    hsv = cv2.cvtColor(np.clip(bgr, 0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[:, :, 1] = hsv[:, :, 1] * saturation
    bgr = cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)

    # Palette-based color shifting: shift dominant colors toward nearest palette entry
    if palette:
        pal = np.array(palette, dtype=np.float32)  # Nx3 BGR
        gray = cv2.cvtColor(np.clip(bgr, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
        # Map grayscale levels to palette
        n = len(palette)
        for i, p in enumerate(pal):
            lo = int(255 * i / n)
            hi = int(255 * (i + 1) / n)
            mask = (gray >= lo) & (gray < hi)
            if mask.any():
                # Blend original color toward palette color
                bgr[mask] = bgr[mask] * 0.6 + p * 0.4

    result[:, :, :3] = np.clip(bgr, 0, 255).astype(np.uint8)
    return result


def apply_style(image_b64: str, style_name: str, strength: float = 0.7) -> dict:
    """
    Apply a style preset to an image.

    Returns: {dataUrl, style, font_suggestions, material}
    """
    if style_name not in STYLE_PRESETS:
        raise ValueError(f"Unknown style: {style_name}. Available: {list(STYLE_PRESETS.keys())}")

    style = STYLE_PRESETS[style_name]
    img = _b64_to_cv(image_b64)

    # Apply color remapping at given strength
    styled = _remap_colors(
        img,
        style["palette"],
        style["warmth"] * strength,
        1.0 + (style["contrast"] - 1.0) * strength,
        1.0 + (style["saturation"] - 1.0) * strength,
    )

    # Blend with original based on strength
    alpha_mask = img[:, :, 3:4].astype(np.float32) / 255.0
    blended = img.copy()
    blended[:, :, :3] = (
        img[:, :, :3].astype(np.float32) * (1 - strength)
        + styled[:, :, :3].astype(np.float32) * strength
    ).astype(np.uint8)

    return {
        "dataUrl": _cv_to_b64(blended),
        "style": style_name,
        "font_suggestions": style["font_suggestions"],
        "material": style["material"],
        "accent_color": list(style["accent"]),
        "background_color": list(style["background_color"]),
    }


def get_available_styles() -> list:
    """Return all available style presets."""
    return [
        {"id": k, "name": v["name"], "accent": list(v["accent"]), "material": v["material"]}
        for k, v in STYLE_PRESETS.items()
    ]
