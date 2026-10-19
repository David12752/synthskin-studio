"""
rectify.py — panel rectification / dewarp pre-stage for the SynthSkin pipeline.

Inputs are now MIXED: clean flat mockups AND perspective photos of real hardware.
A photographed panel inherits perspective + lens skew, so every sliced asset would
be distorted. This module sits in FRONT of ``analyze_panel``:

    auto-detect  ──► flat?  ─yes─►  pass through unchanged (no-op)
                       └──no──►  find panel quad ─► homography ─► fronto-parallel

Design priority is SAFETY on hard inputs (low-contrast vintage panels): it only
warps when it is *confident* it found the panel quad, otherwise it returns the
original untouched. ``force`` overrides the auto decision either way.

Pure OpenCV/NumPy — no model weights, no GPU, no network. Standalone now; later
called from ``panel_pipeline.analyze_panel`` before detection.

CLI:
  .venv/Scripts/python.exe rectify.py --image <panel.png>
  .venv/Scripts/python.exe rectify.py --image <flat.png> --synthetic   # self-test
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

PY_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PY_ROOT.parent
TMP_DIR = PROJECT_ROOT / ".tmp"


# ═══════════════════════════════════════════════════════════════════════════════
# RESULT
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class RectifyResult:
    """Outcome of a rectification attempt.

    ``image`` is always usable downstream: the warped panel when ``applied`` is
    True, otherwise the untouched input. ``homography`` maps source→rectified
    pixels (for projecting detections back to the original if ever needed).
    """
    applied: bool
    image: np.ndarray
    reason: str
    homography: Optional[np.ndarray] = None
    src_quad: Optional[np.ndarray] = None          # 4x2 float32, ordered tl,tr,br,bl
    out_size: Optional[tuple[int, int]] = None      # (w, h)
    skew_deg: float = 0.0                            # max |corner-angle - 90|
    tilt_deg: float = 0.0                            # max top/bottom edge angle vs horizontal
    quad_area_frac: float = 0.0                      # quad area / image area

    def to_dict(self) -> dict[str, object]:
        return {
            "applied": self.applied,
            "reason": self.reason,
            "src_quad": None if self.src_quad is None else self.src_quad.tolist(),
            "out_size": self.out_size,
            "skew_deg": round(self.skew_deg, 2),
            "tilt_deg": round(self.tilt_deg, 2),
            "quad_area_frac": round(self.quad_area_frac, 4),
        }


# ═══════════════════════════════════════════════════════════════════════════════
# GEOMETRY HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def order_corners(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    pts = pts.reshape(4, 2).astype(np.float32)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]          # tl: smallest x+y
    rect[2] = pts[np.argmax(s)]          # br: largest x+y
    diff = pts[:, 1] - pts[:, 0]         # y - x
    rect[1] = pts[np.argmin(diff)]       # tr: smallest y-x
    rect[3] = pts[np.argmax(diff)]       # bl: largest y-x
    return rect


def _corner_angles(quad: np.ndarray) -> list[float]:
    """Interior angle (deg) at each ordered corner."""
    angles: list[float] = []
    for i in range(4):
        p_prev = quad[(i - 1) % 4]
        p_cur = quad[i]
        p_next = quad[(i + 1) % 4]
        v1 = p_prev - p_cur
        v2 = p_next - p_cur
        n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
        if n1 < 1e-6 or n2 < 1e-6:
            angles.append(0.0)
            continue
        cos_a = float(np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0))
        angles.append(float(np.degrees(np.arccos(cos_a))))
    return angles


def _edge_tilt_deg(p0: np.ndarray, p1: np.ndarray) -> float:
    """Angle (deg) of edge p0→p1 relative to horizontal, in [0, 90]."""
    dx, dy = (p1 - p0)
    ang = abs(float(np.degrees(np.arctan2(dy, dx))))
    return min(ang, 180.0 - ang)


def find_panel_quad(img_bgr: np.ndarray, min_area_frac: float = 0.20) -> tuple[Optional[np.ndarray], float]:
    """Find the largest convex 4-gon (the panel boundary) against the background.

    Returns (quad_4x2 | None, area_fraction). None when no contour large enough
    resolves to a quadrilateral — the safe signal to treat the image as flat.
    """
    h, w = img_bgr.shape[:2]
    img_area = float(h * w)

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    # Close small gaps so the panel border forms one continuous contour.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    edges = cv2.dilate(edges, kernel, iterations=2)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best: Optional[np.ndarray] = None
    best_area = 0.0
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area_frac * img_area or area <= best_area:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            best = approx.reshape(4, 2).astype(np.float32)
            best_area = area

    if best is None:
        return None, 0.0
    return best, best_area / img_area


# ═══════════════════════════════════════════════════════════════════════════════
# CORE
# ═══════════════════════════════════════════════════════════════════════════════

def rectify_panel(
    img_bgr: np.ndarray,
    *,
    force: Optional[bool] = None,
    min_area_frac: float = 0.20,
    max_skew_deg: float = 7.0,
    max_tilt_deg: float = 3.0,
) -> RectifyResult:
    """Rectify a panel to fronto-parallel if it looks like a perspective photo.

    Args:
        force: None=auto-decide; True=always warp the detected quad;
               False=never warp (pass through).
        min_area_frac: a quad must cover at least this fraction of the frame to
            be accepted as the panel (rejects sub-elements like screens).
        max_skew_deg: max corner-angle deviation from 90° still considered flat.
        max_tilt_deg: max top/bottom edge tilt from horizontal still considered flat.
    """
    quad, area_frac = find_panel_quad(img_bgr, min_area_frac)

    if quad is None:
        if force is True:
            return RectifyResult(False, img_bgr, "force=warp requested but no panel quad found; passing through")
        return RectifyResult(False, img_bgr, f"no panel quad >= {min_area_frac:.0%} of frame; treating as flat")

    rect = order_corners(quad)
    skew = max(abs(a - 90.0) for a in _corner_angles(rect))
    tilt = max(_edge_tilt_deg(rect[0], rect[1]), _edge_tilt_deg(rect[3], rect[2]))
    looks_flat = skew <= max_skew_deg and tilt <= max_tilt_deg

    if force is None:
        do_warp = not looks_flat
    else:
        do_warp = force

    base = RectifyResult(
        applied=False, image=img_bgr, reason="", src_quad=rect,
        skew_deg=skew, tilt_deg=tilt, quad_area_frac=area_frac,
    )

    if not do_warp:
        base.reason = f"flat panel (skew={skew:.1f}°, tilt={tilt:.1f}°) — no warp"
        return base

    # ── homography to a fronto-parallel rectangle ────────────────────────────
    tl, tr, br, bl = rect
    width = int(round(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl))))
    height = int(round(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl))))
    if width < 2 or height < 2:
        base.reason = "degenerate quad (near-zero size) — no warp"
        return base

    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
    hmat = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(img_bgr, hmat, (width, height), flags=cv2.INTER_CUBIC)

    base.applied = True
    base.image = warped
    base.homography = hmat
    base.out_size = (width, height)
    base.reason = (f"perspective panel (skew={skew:.1f}°, tilt={tilt:.1f}°, "
                   f"area={area_frac:.0%}) — warped to {width}x{height}")
    return base


# ═══════════════════════════════════════════════════════════════════════════════
# SYNTHETIC TEST — warp a flat panel by a KNOWN homography, then try to recover it
# ═══════════════════════════════════════════════════════════════════════════════

def synth_perspective(img_bgr: np.ndarray, tilt: float = 0.22, pad: float = 0.22,
                      bg: tuple[int, int, int] = (205, 205, 205)) -> tuple[np.ndarray, np.ndarray]:
    """Place a flat panel onto a contrasting canvas under a known perspective.

    Returns (canvas, known_quad) where known_quad are the panel corners on the
    canvas, ordered tl,tr,br,bl — the ground truth a rectifier should recover.
    """
    h, w = img_bgr.shape[:2]
    pad_x, pad_y = int(w * pad), int(h * pad)
    cw, ch = w + 2 * pad_x, h + 2 * pad_y

    # Squeeze the top edge inward and drop it slightly → classic upward tilt.
    sx = w * tilt * 0.5
    sy = h * tilt * 0.3
    tl = [pad_x + sx, pad_y + sy]
    tr = [pad_x + w - sx, pad_y + sy]
    br = [pad_x + w, pad_y + h]
    bl = [pad_x, pad_y + h]
    dst = np.array([tl, tr, br, bl], dtype=np.float32)

    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    hmat = cv2.getPerspectiveTransform(src, dst)
    canvas = np.full((ch, cw, 3), bg, dtype=np.uint8)
    cv2.warpPerspective(img_bgr, hmat, (cw, ch), dst=canvas,
                        borderMode=cv2.BORDER_TRANSPARENT, flags=cv2.INTER_CUBIC)
    return canvas, dst


def quad_corner_error(a: np.ndarray, b: np.ndarray) -> float:
    """Mean per-corner L2 distance (px) between two ordered quads."""
    return float(np.mean(np.linalg.norm(a.astype(np.float32) - b.astype(np.float32), axis=1)))


# ═══════════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════════

def imwrite_unicode(path: Path, img: np.ndarray) -> bool:
    """``cv2.imwrite`` that survives non-ASCII paths.

    On Windows, ``cv2.imwrite`` silently returns False (writes nothing) when the
    path contains non-ASCII characters — and this project lives under a Hebrew
    user dir. Encode in-memory, then write bytes via pathlib instead.
    """
    ok, buf = cv2.imencode(path.suffix or ".png", img)
    if not ok:
        print(f"WARN: could not encode {path.name}", file=sys.stderr)
        return False
    path.write_bytes(buf.tobytes())
    return True


def _resolve_image(explicit: Optional[str]) -> Optional[Path]:
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None
    candidates: list[Path] = []
    for base in (TMP_DIR / "dogfood_input", TMP_DIR):
        if base.exists():
            for pattern in ("*.png", "*.jpg", "*.jpeg", "*.webp", "*.bmp"):
                candidates.extend(Path(p) for p in glob.glob(str(base / pattern)))
    if not candidates:
        return None
    return sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def _draw_quad(img: np.ndarray, quad: np.ndarray, color=(0, 0, 255)) -> np.ndarray:
    out = img.copy()
    pts = quad.reshape(-1, 1, 2).astype(np.int32)
    cv2.polylines(out, [pts], True, color, 3, cv2.LINE_AA)
    for i, (x, y) in enumerate(quad.astype(int)):
        cv2.circle(out, (int(x), int(y)), 7, color, -1)
        cv2.putText(out, "tl tr br bl".split()[i], (int(x) + 8, int(y)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA)
    return out


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="Rectify a synth panel to fronto-parallel.")
    ap.add_argument("--image", default=None, help="panel image (default: newest in .tmp)")
    ap.add_argument("--synthetic", action="store_true",
                    help="warp the input by a known homography first, then recover it (self-test)")
    ap.add_argument("--tilt", type=float, default=0.22, help="synthetic perspective strength")
    ap.add_argument("--force", choices=["auto", "warp", "skip"], default="auto")
    ap.add_argument("--min-area-frac", type=float, default=0.20)
    ap.add_argument("--max-skew-deg", type=float, default=7.0)
    ap.add_argument("--max-tilt-deg", type=float, default=3.0)
    ap.add_argument("--out", default=str(TMP_DIR / "rectify"))
    args = ap.parse_args()

    image_path = _resolve_image(args.image)
    if image_path is None:
        print(f"ERROR: no image. Pass --image or drop one in {TMP_DIR}", file=sys.stderr)
        return 2

    img = cv2.imdecode(np.frombuffer(image_path.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        print(f"ERROR: could not decode {image_path}", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    force = {"auto": None, "warp": True, "skip": False}[args.force]

    print(f"Image: {image_path}  ({img.shape[1]}x{img.shape[0]})")

    known_quad: Optional[np.ndarray] = None
    if args.synthetic:
        img, known_quad = synth_perspective(img, tilt=args.tilt)
        imwrite_unicode(out_dir / "synthetic_input.png", img)
        print(f"Synthetic warp applied → {img.shape[1]}x{img.shape[0]} "
              f"(saved synthetic_input.png)")

    result = rectify_panel(
        img, force=force,
        min_area_frac=args.min_area_frac,
        max_skew_deg=args.max_skew_deg,
        max_tilt_deg=args.max_tilt_deg,
    )

    print(f"\nDecision: applied={result.applied}")
    print(f"  reason: {result.reason}")
    print(f"  skew={result.skew_deg:.1f}°  tilt={result.tilt_deg:.1f}°  "
          f"quad_area={result.quad_area_frac:.0%}")

    imwrite_unicode(out_dir / "rectified.png", result.image)
    if result.src_quad is not None:
        imwrite_unicode(out_dir / "overlay.png", _draw_quad(img, result.src_quad))

    payload = result.to_dict()
    if known_quad is not None and result.src_quad is not None:
        err = quad_corner_error(order_corners(known_quad), result.src_quad)
        payload["synthetic_corner_error_px"] = round(err, 2)
        diag = float(np.hypot(*img.shape[:2]))
        payload["synthetic_corner_error_pct_diag"] = round(100 * err / diag, 3)
        print(f"\nSelf-test: mean corner recovery error = {err:.2f}px "
              f"({100 * err / diag:.3f}% of canvas diagonal)")
        verdict = "PASS" if (result.applied and err <= 6.0) else "CHECK"
        print(f"  -> {verdict} (want: applied=True and error <= 6px)")

    (out_dir / "result.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nWrote: {out_dir}\\  (rectified.png, overlay.png, result.json)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
