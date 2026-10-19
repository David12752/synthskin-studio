"""
5.5 Symmetry Enforcement — Detect and fix symmetry in components.

Detects radial symmetry (knobs) and bilateral symmetry (panels),
computes error, and corrects deviations.
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


def detect_symmetry(image_b64: str) -> dict:
    """
    Analyze symmetry properties of an image.

    Returns: {
        horizontal_score: 0-1 (1 = perfectly symmetric across vertical axis),
        vertical_score: 0-1,
        radial_score: 0-1,
        best_type: "horizontal" | "vertical" | "radial" | "none",
        center: {x, y}
    }
    """
    img = _b64_to_cv(image_b64)
    h, w = img.shape[:2]
    alpha = img[:, :, 3]
    mask = alpha > 128

    # Find center of mass
    if mask.any():
        ys, xs = np.where(mask)
        cx = int(np.mean(xs))
        cy = int(np.mean(ys))
    else:
        cx, cy = w // 2, h // 2

    gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)
    # Apply alpha mask
    gray = gray * (alpha.astype(np.float32) / 255.0)

    # Horizontal symmetry (flip left-right)
    flipped_h = cv2.flip(gray, 1)
    h_corr = _norm_correlation(gray, flipped_h, mask & cv2.flip(mask, 1))

    # Vertical symmetry (flip top-bottom)
    flipped_v = cv2.flip(gray, 0)
    v_corr = _norm_correlation(gray, flipped_v, mask & cv2.flip(mask, 0))

    # Radial symmetry (average correlation across multiple rotations)
    radial_scores = []
    for angle in [90, 180, 270]:
        M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
        rotated = cv2.warpAffine(gray, M, (w, h))
        rot_mask = cv2.warpAffine(mask.astype(np.uint8) * 255, M, (w, h)) > 128
        combined_mask = mask & rot_mask
        if combined_mask.any():
            radial_scores.append(_norm_correlation(gray, rotated, combined_mask))
    r_corr = float(np.mean(radial_scores)) if radial_scores else 0

    scores = {"horizontal": h_corr, "vertical": v_corr, "radial": r_corr}
    best = max(scores, key=scores.get)
    if scores[best] < 0.3:
        best = "none"

    return {
        "horizontal_score": round(h_corr, 3),
        "vertical_score": round(v_corr, 3),
        "radial_score": round(r_corr, 3),
        "best_type": best,
        "center": {"x": cx, "y": cy},
    }


def _norm_correlation(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    """Normalized correlation between two images within a mask."""
    if not mask.any():
        return 0.0
    av = a[mask].astype(np.float64)
    bv = b[mask].astype(np.float64)
    am = av - av.mean()
    bm = bv - bv.mean()
    denom = max(np.sqrt(np.sum(am ** 2) * np.sum(bm ** 2)), 1e-8)
    return max(0, float(np.sum(am * bm) / denom))


def enforce_symmetry(
    image_b64: str,
    symmetry_type: str = "auto",
    strength: float = 1.0,
) -> dict:
    """
    Make an image symmetrical.

    Args:
        symmetry_type: "horizontal", "vertical", "radial", "auto"
        strength: 0-1 blending (1 = fully symmetric)

    Returns: {dataUrl, symmetry_type, error_before, error_after}
    """
    img = _b64_to_cv(image_b64)
    h, w = img.shape[:2]

    # Auto-detect best symmetry type
    if symmetry_type == "auto":
        analysis = detect_symmetry(image_b64)
        symmetry_type = analysis["best_type"]
        if symmetry_type == "none":
            symmetry_type = "horizontal"  # default

    alpha = img[:, :, 3]
    mask = alpha > 128

    # Find center of mass
    if mask.any():
        ys, xs = np.where(mask)
        cx = int(np.mean(xs))
        cy = int(np.mean(ys))
    else:
        cx, cy = w // 2, h // 2

    # Measure error before
    err_before = _symmetry_error(img, symmetry_type, cx, cy)

    if symmetry_type == "horizontal":
        # Average left and right halves
        flipped = cv2.flip(img, 1)
        result = _blend(img, flipped, strength)

    elif symmetry_type == "vertical":
        # Average top and bottom halves
        flipped = cv2.flip(img, 0)
        result = _blend(img, flipped, strength)

    elif symmetry_type == "radial":
        # Average across rotations
        accumulated = img.astype(np.float32)
        count = 1
        for angle in [90, 180, 270]:
            M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
            rotated = cv2.warpAffine(img, M, (w, h), borderMode=cv2.BORDER_CONSTANT)
            accumulated += rotated.astype(np.float32)
            count += 1
        averaged = (accumulated / count).astype(np.uint8)
        result = _blend(img, averaged, strength)

    else:
        result = img

    err_after = _symmetry_error(result, symmetry_type, cx, cy)

    return {
        "dataUrl": _cv_to_b64(result),
        "symmetry_type": symmetry_type,
        "error_before": round(err_before, 3),
        "error_after": round(err_after, 3),
    }


def _blend(original: np.ndarray, target: np.ndarray, strength: float) -> np.ndarray:
    """Blend original toward target at given strength."""
    return cv2.addWeighted(original, 1.0 - strength, target, strength, 0)


def _symmetry_error(img: np.ndarray, sym_type: str, cx: int, cy: int) -> float:
    """Compute average pixel difference showing asymmetry."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)
    alpha = img[:, :, 3].astype(np.float32) / 255.0

    if sym_type == "horizontal":
        mirrored = cv2.flip(gray, 1)
        mirror_a = cv2.flip(alpha, 1)
    elif sym_type == "vertical":
        mirrored = cv2.flip(gray, 0)
        mirror_a = cv2.flip(alpha, 0)
    elif sym_type == "radial":
        M = cv2.getRotationMatrix2D((cx, cy), 180, 1.0)
        mirrored = cv2.warpAffine(gray, M, (w, h))
        mirror_a = cv2.warpAffine(alpha, M, (w, h))
    else:
        return 0

    combined_a = alpha * mirror_a
    if combined_a.sum() < 1:
        return 0

    diff = np.abs(gray - mirrored) * combined_a
    return float(diff.sum() / max(combined_a.sum(), 1) / 255.0)
