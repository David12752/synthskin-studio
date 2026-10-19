"""
shape_fit.py — describe a control's silhouette as the simplest PARAMETRIC shape.

A SAM/GrabCut mask is pixel-accurate but "dumb": to a downstream UI builder it is
a 200-point traced blob. Yet almost every synth/plugin control is really a
circle (knob, LED), an axis-aligned rectangle (button, screen), a rounded
rectangle (pill button, slider track — i.e. a `border-radius`), or an ellipse.
Recovering that primitive turns the blob into semantics: an exact centre+radius,
or a rectangle + corner radius, plus a clean SVG path.

This is the deterministic reframe of "Active Contours / snakes": literal snakes
are initialization-sensitive and, for UI, usually WORSE than fitting the
primitive the shape actually is. So instead of relaxing an elastic curve we test
a small family of primitives and keep the simplest one that reproduces the mask
above an IoU floor; anything that fits nothing well falls back to a
Douglas-Peucker-simplified polygon.

Pure OpenCV/NumPy. Emits geometry in ORIGINAL-image coordinates via ``origin``.
"""
from __future__ import annotations

import base64
import math
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

# IoU a primitive must reach to be accepted over the polygon fallback.
FIT_FLOOR = 0.90
# A simpler primitive wins if it is within this IoU of the best candidate.
SIMPLICITY_MARGIN = 0.02
# Semantic simplicity ranking (lower = preferred on a near-tie).
_RANK = {"circle": 0, "rect": 1, "rounded_rect": 2, "ellipse": 3, "polygon": 4}


# ── mask decode (kept local so this module stands alone) ──────────────────────

def _decode_mask_crop(mask_png: str) -> Optional[np.ndarray]:
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
        m = m[:, :, 3] if m.shape[2] == 4 else cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)
    return m


# ── candidate renderers + IoU ─────────────────────────────────────────────────

def _iou(a: np.ndarray, b: np.ndarray) -> float:
    ab = a > 127
    bb = b > 127
    inter = int(np.logical_and(ab, bb).sum())
    uni = int(np.logical_or(ab, bb).sum())
    return inter / uni if uni else 0.0


def _draw_rounded_rect(shape_hw: Tuple[int, int], x: int, y: int, w: int, h: int, r: int) -> np.ndarray:
    m = np.zeros(shape_hw, np.uint8)
    r = int(max(0, min(r, min(w, h) // 2)))
    x, y, w, h = int(x), int(y), int(w), int(h)
    if r <= 0:
        cv2.rectangle(m, (x, y), (x + w - 1, y + h - 1), 255, -1)
        return m
    cv2.rectangle(m, (x + r, y), (x + w - 1 - r, y + h - 1), 255, -1)
    cv2.rectangle(m, (x, y + r), (x + w - 1, y + h - 1 - r), 255, -1)
    for cx, cy in ((x + r, y + r), (x + w - 1 - r, y + r),
                   (x + r, y + h - 1 - r), (x + w - 1 - r, y + h - 1 - r)):
        cv2.circle(m, (cx, cy), r, 255, -1)
    return m


# ── SVG path builders (absolute coords) ───────────────────────────────────────

def _f(v: float) -> str:
    return f"{v:.1f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def _svg_circle(cx: float, cy: float, r: float) -> str:
    return (f"M {_f(cx - r)},{_f(cy)} a {_f(r)},{_f(r)} 0 1,0 {_f(2 * r)},0 "
            f"a {_f(r)},{_f(r)} 0 1,0 {_f(-2 * r)},0 Z")


def _svg_rect(x: float, y: float, w: float, h: float) -> str:
    return f"M {_f(x)},{_f(y)} h {_f(w)} v {_f(h)} h {_f(-w)} Z"


def _svg_rounded_rect(x: float, y: float, w: float, h: float, r: float) -> str:
    r = min(r, min(w, h) / 2.0)
    return (f"M {_f(x + r)},{_f(y)} h {_f(w - 2 * r)} a {_f(r)},{_f(r)} 0 0 1 {_f(r)},{_f(r)} "
            f"v {_f(h - 2 * r)} a {_f(r)},{_f(r)} 0 0 1 {_f(-r)},{_f(r)} h {_f(-(w - 2 * r))} "
            f"a {_f(r)},{_f(r)} 0 0 1 {_f(-r)},{_f(-r)} v {_f(-(h - 2 * r))} "
            f"a {_f(r)},{_f(r)} 0 0 1 {_f(r)},{_f(-r)} Z")


def _svg_ellipse(cx: float, cy: float, rx: float, ry: float, angle_deg: float) -> str:
    th = math.radians(angle_deg)
    dx, dy = rx * math.cos(th), rx * math.sin(th)
    p1 = (cx - dx, cy - dy)
    p2 = (cx + dx, cy + dy)
    return (f"M {_f(p1[0])},{_f(p1[1])} "
            f"A {_f(rx)},{_f(ry)} {_f(angle_deg)} 1 0 {_f(p2[0])},{_f(p2[1])} "
            f"A {_f(rx)},{_f(ry)} {_f(angle_deg)} 1 0 {_f(p1[0])},{_f(p1[1])} Z")


def _svg_polygon(points: List[Tuple[float, float]]) -> str:
    if not points:
        return ""
    head = f"M {_f(points[0][0])},{_f(points[0][1])}"
    rest = " ".join(f"L {_f(px)},{_f(py)}" for px, py in points[1:])
    return f"{head} {rest} Z".strip()


# ── main fit ──────────────────────────────────────────────────────────────────

def fit_shape(
    mask: np.ndarray,
    *,
    origin: Tuple[float, float] = (0.0, 0.0),
    floor: float = FIT_FLOOR,
) -> Optional[Dict[str, Any]]:
    """Fit the simplest primitive to a single-channel mask.

    Returns a dict {kind, params (abs coords), svg_path, iou, point_count?} or a
    polygon fallback; None only if the mask is empty. ``origin`` = (x, y) of the
    mask's top-left in the original image, so all emitted geometry is absolute.
    """
    if mask is None or mask.size == 0:
        return None
    binm = (mask > 127).astype(np.uint8) * 255
    if not binm.any():
        return None

    ox, oy = float(origin[0]), float(origin[1])
    cnts, _ = cv2.findContours(binm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    cnt = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(cnt) < 4:
        return None

    h, w = binm.shape[:2]
    ref = np.zeros((h, w), np.uint8)
    cv2.drawContours(ref, [cnt], -1, 255, -1)
    area = float((ref > 0).sum())

    x, y, bw, bh = cv2.boundingRect(cnt)
    candidates: List[Dict[str, Any]] = []

    # CIRCLE — centroid + equal-area radius.
    M = cv2.moments(cnt)
    if M["m00"] > 0:
        ccx, ccy = M["m10"] / M["m00"], M["m01"] / M["m00"]
        r_eq = math.sqrt(area / math.pi)
        cm = np.zeros((h, w), np.uint8)
        cv2.circle(cm, (int(round(ccx)), int(round(ccy))), int(round(r_eq)), 255, -1)
        candidates.append({
            "kind": "circle", "iou": _iou(cm, ref),
            "params": {"cx": round(ccx + ox, 1), "cy": round(ccy + oy, 1), "r": round(r_eq, 1)},
            "svg": lambda p: _svg_circle(p["cx"], p["cy"], p["r"]),
        })

    # ELLIPSE — least-squares fit (needs >= 5 points).
    if len(cnt) >= 5:
        (ecx, ecy), (MA, ma), ang = cv2.fitEllipse(cnt)
        # Render from OpenCV's raw axes (this is correct regardless of labels).
        em = np.zeros((h, w), np.uint8)
        cv2.ellipse(em, (int(round(ecx)), int(round(ecy))),
                    (int(round(MA / 2)), int(round(ma / 2))), ang, 0, 360, 255, -1)
        # Normalize labels: OpenCV puts MA along `ang`, ma along `ang+90`. Report
        # rx = MAJOR semi-axis with `angle_deg` = the major axis' true orientation,
        # so a horizontal ellipse reads rx>ry, angle~0 (not swapped with angle~90).
        a, b = MA / 2.0, ma / 2.0
        if a >= b:
            rx, ry, major_ang = a, b, ang
        else:
            rx, ry, major_ang = b, a, ang + 90.0
        major_ang = major_ang % 180.0
        candidates.append({
            "kind": "ellipse", "iou": _iou(em, ref),
            "params": {"cx": round(ecx + ox, 1), "cy": round(ecy + oy, 1),
                       "rx": round(rx, 1), "ry": round(ry, 1), "angle_deg": round(major_ang, 1)},
            "svg": lambda p: _svg_ellipse(p["cx"], p["cy"], p["rx"], p["ry"], p["angle_deg"]),
        })

    # RECT — the axis-aligned bounding rect.
    rm = _draw_rounded_rect((h, w), x, y, bw, bh, 0)
    candidates.append({
        "kind": "rect", "iou": _iou(rm, ref),
        "params": {"x": round(x + ox, 1), "y": round(y + oy, 1), "w": float(bw), "h": float(bh)},
        "svg": lambda p: _svg_rect(p["x"], p["y"], p["w"], p["h"]),
    })

    # ROUNDED_RECT — corner radius from the area deficit vs a full rect.
    #   area(rounded) = w*h - (4 - pi) r^2  ->  r = sqrt((w*h - area)/(4 - pi))
    deficit = bw * bh - area
    if deficit > 0:
        r_est = math.sqrt(deficit / (4.0 - math.pi))
        r_est = max(0.0, min(r_est, min(bw, bh) / 2.0))
        if r_est >= 2.0:
            rrm = _draw_rounded_rect((h, w), x, y, bw, bh, int(round(r_est)))
            candidates.append({
                "kind": "rounded_rect", "iou": _iou(rrm, ref),
                "params": {"x": round(x + ox, 1), "y": round(y + oy, 1),
                           "w": float(bw), "h": float(bh), "r": round(r_est, 1)},
                "svg": lambda p: _svg_rounded_rect(p["x"], p["y"], p["w"], p["h"], p["r"]),
            })

    # Pick: best IoU, but let a semantically simpler primitive win a near-tie.
    if candidates:
        best = max(candidates, key=lambda c: c["iou"])
        if best["iou"] >= floor:
            contenders = [c for c in candidates if c["iou"] >= best["iou"] - SIMPLICITY_MARGIN]
            chosen = min(contenders, key=lambda c: _RANK[c["kind"]])
            return {
                "kind": chosen["kind"],
                "params": chosen["params"],
                "svg_path": chosen["svg"](chosen["params"]),
                "iou": round(chosen["iou"], 3),
            }

    # POLYGON fallback — Douglas-Peucker simplify, escalating eps if too dense.
    peri = cv2.arcLength(cnt, True)
    pts: Optional[np.ndarray] = None
    for eps_frac in (0.012, 0.02, 0.03, 0.05):
        approx = cv2.approxPolyDP(cnt, eps_frac * peri, True)
        if len(approx) <= 48:
            pts = approx
            break
    if pts is None:
        pts = approx  # type: ignore[name-defined]
    poly = [(round(float(p[0][0]) + ox, 1), round(float(p[0][1]) + oy, 1)) for p in pts]
    return {
        "kind": "polygon",
        "params": {"points": [[px, py] for px, py in poly]},
        "svg_path": _svg_polygon(poly),
        "iou": round(_iou(ref, ref), 3),  # 1.0 by construction (exact contour)
        "point_count": len(poly),
    }


# ── convenience: fit straight from an analyzed control ────────────────────────

def fit_from_control(control: Dict[str, Any], *, floor: float = FIT_FLOOR) -> Optional[Dict[str, Any]]:
    """Fit a shape from a control's cropped mask (``mask_png`` + ``mask_bbox``)."""
    mask = _decode_mask_crop(control.get("mask_png", ""))
    bbox = control.get("mask_bbox")
    if mask is None or not bbox or len(bbox) != 4:
        return None
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    bw, bh = x2 - x1, y2 - y1
    if bw <= 0 or bh <= 0:
        return None
    if mask.shape[:2] != (bh, bw):
        mask = cv2.resize(mask, (bw, bh), interpolation=cv2.INTER_NEAREST)
    return fit_shape(mask, origin=(x1, y1), floor=floor)


def shapes_by_id(controls: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Fit every control that carries a mask -> {id: shape}. Never raises."""
    out: Dict[str, Dict[str, Any]] = {}
    for c in controls:
        try:
            s = fit_from_control(c)
        except Exception:
            s = None
        if s is not None:
            out[str(c.get("id"))] = s
    return out
