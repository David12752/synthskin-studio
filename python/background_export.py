"""
background_export.py — the "punch triple" export contract.

Given the analyzed panel (source image + per-control masks), produce the three
artifacts a plugin developer actually assembles a UI from:

  1. background_punched  — RGBA plate with transparent HOLES where controls sit.
                           Holes are dilate(2px)+feather(1px) so that when the
                           separated assets are re-composited on top there is no
                           1px halo ring of leftover control pixels showing
                           around them.
  2. background_filled   — the same plate but with the holes INPAINTED, for use
                           as a solid backdrop (TELEA now; LaMa optional later).
  3. per-asset RGBA crops — each control cut out with soft alpha, tightly
                           cropped, ready to become a filmstrip/atlas frame.

All operations run at the ORIGINAL image resolution — never a downscaled copy.
Masks arrive cropped (``mask_png`` + ``mask_bbox``) from the pipeline; we
reconstruct a full-frame union before punching. Pure OpenCV/NumPy.
"""
from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

import dehalo as _dehalo


# ── decode helpers ────────────────────────────────────────────────────────────

def _decode_mask_crop(mask_png: str) -> Optional[np.ndarray]:
    """Decode a (possibly data-URL) base64 PNG into a single-channel uint8 mask."""
    if not mask_png:
        return None
    if mask_png.startswith("data:"):
        mask_png = mask_png.split(",", 1)[1]
    try:
        raw = base64.b64decode(mask_png)
    except Exception:
        return None
    arr = np.frombuffer(raw, np.uint8)
    m = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if m is None:
        return None
    if m.ndim == 3:
        # If it has alpha, prefer alpha; else take luminance.
        m = m[:, :, 3] if m.shape[2] == 4 else cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)
    return m


def decode_bgr(image_b64: str) -> np.ndarray:
    """Decode a (possibly data-URL) base64 image to a 3-channel BGR uint8 array."""
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    raw = base64.b64decode(image_b64)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode source image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def _encode_png_b64(img: np.ndarray, data_url: bool = True) -> str:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        return ""
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return ("data:image/png;base64," + b64) if data_url else b64


# ── union mask ────────────────────────────────────────────────────────────────

def union_mask_from_controls(
    controls: List[Dict[str, Any]],
    height: int,
    width: int,
    *,
    types: Optional[set] = None,
) -> np.ndarray:
    """Composite every control's cropped mask into one full-frame union (0/255).

    ``types`` optionally restricts which control types contribute (e.g. skip
    'label' text so it stays part of the background).
    """
    union = np.zeros((height, width), np.uint8)
    for c in controls:
        if types is not None and c.get("type") not in types:
            continue
        crop = _decode_mask_crop(c.get("mask_png"))
        bbox = c.get("mask_bbox")
        if crop is None or not bbox:
            continue
        x1, y1, x2, y2 = [int(round(v)) for v in bbox]
        x1 = max(0, min(width, x1)); x2 = max(0, min(width, x2))
        y1 = max(0, min(height, y1)); y2 = max(0, min(height, y2))
        bw, bh = x2 - x1, y2 - y1
        if bw <= 0 or bh <= 0:
            continue
        if crop.shape[:2] != (bh, bw):
            crop = cv2.resize(crop, (bw, bh), interpolation=cv2.INTER_NEAREST)
        binm = (crop > 127).astype(np.uint8) * 255
        region = union[y1:y2, x1:x2]
        union[y1:y2, x1:x2] = cv2.bitwise_or(region, binm)
    return union


# ── the punch triple ──────────────────────────────────────────────────────────

def _feathered_hole_alpha(
    union: np.ndarray,
    dilate_px: int = 2,
    feather_px: int = 1,
) -> np.ndarray:
    """Alpha for the PUNCHED plate: 0 inside the (dilated) holes, 255 outside,
    with a ``feather_px`` graded rim so re-composited assets leave no halo."""
    if dilate_px > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate_px + 1, 2 * dilate_px + 1))
        holes = cv2.dilate(union, k)
    else:
        holes = union.copy()
    # background alpha = inverse of holes
    alpha = 255 - holes
    if feather_px > 0:
        ksz = 2 * feather_px + 1
        alpha = cv2.GaussianBlur(alpha, (ksz, ksz), 0)
    return alpha


def build_punch_triple(
    image_bgr: np.ndarray,
    controls: List[Dict[str, Any]],
    *,
    dilate_px: int = 2,
    feather_px: int = 1,
    fill_method: str = "telea",
    fill_radius: int = 5,
    include_crops: bool = True,
    exclude_types: Optional[set] = None,
    dehalo: bool = True,
) -> Dict[str, Any]:
    """Produce background_punched (RGBA), background_filled (BGR) and per-asset crops.

    Returns a dict of base64 data-URLs + the union mask, all at source resolution.
    ``fill_method`` = telea | ns | poisson(harmonic). ``dehalo`` colour-
    decontaminates each per-asset crop's soft rim so it leaves no halo when
    re-composited on a new background.
    """
    h, w = image_bgr.shape[:2]
    contributing = None
    if exclude_types:
        contributing = {c.get("type") for c in controls} - set(exclude_types)
    union = union_mask_from_controls(controls, h, w, types=contributing)

    # 1) punched plate: source RGB + feathered hole alpha
    alpha = _feathered_hole_alpha(union, dilate_px, feather_px)
    punched = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2BGRA)
    punched[:, :, 3] = alpha

    # 2) filled plate: inpaint the (dilated) holes (telea | ns | poisson/harmonic)
    if union.any():
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate_px + 1, 2 * dilate_px + 1))
        fill_mask = cv2.dilate(union, k) if dilate_px > 0 else union
        filled = _dehalo.fill_background(image_bgr, fill_mask, method=fill_method, radius=fill_radius)
    else:
        filled = image_bgr.copy()

    out: Dict[str, Any] = {
        "width": w,
        "height": h,
        "dilate_px": dilate_px,
        "feather_px": feather_px,
        "fill_method": fill_method,
        "background_punched": _encode_png_b64(punched),
        "background_filled": _encode_png_b64(filled),
        "union_coverage": round(float((union > 0).mean()), 4),
    }

    # 3) per-asset crops (soft alpha, tightly cropped)
    if include_crops:
        crops: List[Dict[str, Any]] = []
        for c in controls:
            crop_alpha = _decode_mask_crop(c.get("mask_png"))
            bbox = c.get("mask_bbox")
            if crop_alpha is None or not bbox:
                continue
            x1, y1, x2, y2 = [int(round(v)) for v in bbox]
            x1 = max(0, min(w, x1)); x2 = max(0, min(w, x2))
            y1 = max(0, min(h, y1)); y2 = max(0, min(h, y2))
            if x2 <= x1 or y2 <= y1:
                continue
            rgb_crop = image_bgr[y1:y2, x1:x2]
            if crop_alpha.shape[:2] != rgb_crop.shape[:2]:
                crop_alpha = cv2.resize(crop_alpha, (rgb_crop.shape[1], rgb_crop.shape[0]),
                                        interpolation=cv2.INTER_LINEAR)
            rgba = cv2.cvtColor(rgb_crop, cv2.COLOR_BGR2BGRA)
            rgba[:, :, 3] = crop_alpha
            if dehalo:
                rgba = _dehalo.decontaminate_rgba(rgba)
            crops.append({
                "id": c.get("id"),
                "type": c.get("type"),
                "parameter_id": c.get("parameter_id"),
                "bbox": [x1, y1, x2, y2],
                "png": _encode_png_b64(rgba),
            })
        out["crops"] = crops
        out["crop_count"] = len(crops)

    return out
