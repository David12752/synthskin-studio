"""
dehalo.py — Model #1: clean cut edges (color decontamination) + gradient fill.

Two deterministic, base-OpenCV operations that make a separated asset look
professionally cut and the punched background look seamless:

1. COLOR DECONTAMINATION (de-halo).
   A soft/anti-aliased cut edge is a blend of foreground and OLD background:
       observed = alpha*F + (1-alpha)*B
   If you keep `observed` as the color and just carry the alpha, the rim still
   holds the old background's tint — so when the asset is re-composited on a NEW
   background you see a 1px halo ring of the original colour. The fix is to
   recover the true foreground colour on the rim:
       F = (observed - (1-alpha)*B) / alpha           (for 0 < alpha < 1)
   where B (the local background under the rim) is estimated by inpainting the
   object away. Only the boundary band is touched; interiors stay untouched.

2. HARMONIC / POISSON FILL.
   `background_filled` needs the control's hole filled. Telea (fast-marching)
   streaks on smooth gradients. A harmonic fill solves Laplace's equation over
   the hole (grad-domain: pixels relax to the average of their neighbours, with
   the surrounding ring as fixed Dirichlet boundary), which reproduces smooth
   panel gradients/vignettes exactly. Seeded by Telea, then relaxed.

Pure OpenCV/NumPy. Both ops are guarded to be no-ops on degenerate input.
"""
from __future__ import annotations

from typing import Optional

import cv2
import numpy as np


# ── 1. color decontamination ──────────────────────────────────────────────────

def decontaminate_rgba(
    rgba: np.ndarray,
    *,
    band_px: int = 6,
    lo: float = 0.04,
    hi: float = 0.96,
) -> np.ndarray:
    """Remove old-background colour bleed from a cut asset's soft rim.

    ``rgba`` is HxWx4 uint8 (BGR + alpha). Returns a new RGBA with the rim's RGB
    replaced by the estimated true foreground colour; alpha is unchanged. No-op
    (returns input) when there is no reliable background or foreground to use.
    """
    if rgba is None or rgba.ndim != 3 or rgba.shape[2] != 4:
        return rgba
    bgr = rgba[:, :, :3].astype(np.float32)
    a = rgba[:, :, 3].astype(np.float32) / 255.0

    solid_fg = a >= hi
    bg = a <= lo
    if not bg.any() or not solid_fg.any():
        return rgba  # nothing to anchor the estimate on

    # Estimate the background colour *under* the object by inpainting away
    # everything that is not clearly background.
    fill_mask = (~bg).astype(np.uint8) * 255
    src = np.ascontiguousarray(rgba[:, :, :3])
    B = cv2.inpaint(src, fill_mask, 3, cv2.INPAINT_TELEA).astype(np.float32)

    # Rim = partial-alpha pixels inside a band around the solid-foreground edge.
    solid = solid_fg.astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band_px + 1, 2 * band_px + 1))
    band = cv2.morphologyEx(solid, cv2.MORPH_GRADIENT, k)
    rim = (a > lo) & (a < hi) & (band > 0)
    if not rim.any():
        return rgba

    a_safe = np.clip(a, max(lo, 1e-3), 1.0)[:, :, None]
    F = (bgr - (1.0 - a_safe) * B) / a_safe
    F = np.clip(F, 0.0, 255.0)

    out = bgr.copy()
    out[rim] = F[rim]
    res = rgba.copy()
    res[:, :, :3] = np.clip(out, 0, 255).astype(np.uint8)
    return res


# ── 2. harmonic / Poisson fill ────────────────────────────────────────────────

def harmonic_fill(
    bgr: np.ndarray,
    hole_mask: np.ndarray,
    *,
    iters: int = 250,
    seed: str = "telea",
) -> np.ndarray:
    """Fill ``hole_mask`` (255 = unknown) by solving Laplace's equation.

    Seeded with a Telea/NS inpaint, then Jacobi-relaxed so hole pixels converge
    to the harmonic interpolation of the surrounding ring — smooth, streak-free
    fill for gradient/vignette panels. Boundary (known) pixels stay fixed.
    """
    if hole_mask is None or not np.any(hole_mask):
        return bgr.copy()
    holem = hole_mask > 0
    flag = cv2.INPAINT_NS if seed == "ns" else cv2.INPAINT_TELEA
    img = cv2.inpaint(bgr, (holem.astype(np.uint8) * 255), 3, flag).astype(np.float32)

    for _ in range(max(0, iters)):
        up = np.roll(img, -1, axis=0)
        down = np.roll(img, 1, axis=0)
        left = np.roll(img, -1, axis=1)
        right = np.roll(img, 1, axis=1)
        avg = (up + down + left + right) * 0.25
        img[holem] = avg[holem]

    out = bgr.astype(np.float32).copy()
    out[holem] = img[holem]
    return np.clip(out, 0, 255).astype(np.uint8)


def fill_background(
    bgr: np.ndarray,
    hole_mask: np.ndarray,
    *,
    method: str = "telea",
    radius: int = 5,
) -> np.ndarray:
    """Dispatch a background fill by method name: telea | ns | poisson(harmonic)."""
    if hole_mask is None or not np.any(hole_mask):
        return bgr.copy()
    if method == "poisson" or method == "harmonic":
        return harmonic_fill(bgr, hole_mask, seed="telea")
    flag = cv2.INPAINT_NS if method == "ns" else cv2.INPAINT_TELEA
    return cv2.inpaint(bgr, hole_mask, radius, flag)
