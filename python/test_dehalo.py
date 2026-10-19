"""
test_dehalo.py — deterministic floors for Model #1 (clean cuts).

A. DE-HALO: a red disc soft-composited over a GREEN background. The rim pixels
   are contaminated toward green. Assert decontamination recovers the true
   foreground (red) on the rim far better than the naive observed colour.
B. HARMONIC FILL: punch a hole in a known LINEAR gradient and assert the
   harmonic fill reconstructs it more accurately than Telea (a linear ramp is
   harmonic, so the Laplace solution is ~exact).
C. Guards: no-op on all-foreground / empty inputs; alpha preserved.

Pure OpenCV/NumPy.

Run:  .venv/Scripts/python.exe test_dehalo.py
"""
from __future__ import annotations

import sys

import cv2
import numpy as np

import dehalo

_failures: list[str] = []
_passes = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _passes
    if cond:
        _passes += 1
        print(f"  [PASS] {name}" + (f"  ({detail})" if detail else ""))
    else:
        _failures.append(name)
        print(f"  [FAIL] {name}" + (f"  ({detail})" if detail else ""))


def _soft_disc_alpha(h, w, cx, cy, r, soft=6.0):
    ys, xs = np.mgrid[0:h, 0:w]
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    a = np.clip((r - dist) / soft + 0.5, 0.0, 1.0)
    return a.astype(np.float32)


def test_dehalo() -> None:
    print("\n[A] de-halo: red disc over green bg")
    h = w = 120
    F_true = np.array([0, 0, 255], np.float32)   # BGR red
    B_old = np.array([0, 180, 0], np.float32)     # BGR green
    a = _soft_disc_alpha(h, w, 60, 60, 40, soft=6.0)
    obs = a[..., None] * F_true + (1 - a[..., None]) * B_old
    rgba = np.dstack([obs.astype(np.uint8), (a * 255).astype(np.uint8)])

    dec = dehalo.decontaminate_rgba(rgba, band_px=6)

    # rim = partial alpha near the edge
    rim = (a > 0.04) & (a < 0.96)
    solid = ((a >= 0.96).astype(np.uint8)) * 255
    band = cv2.morphologyEx(solid, cv2.MORPH_GRADIENT,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
    rim = rim & (band > 0)
    check("A0 rim non-empty", int(rim.sum()) > 0, str(int(rim.sum())))

    naive = obs[rim]
    fixed = dec[:, :, :3].astype(np.float32)[rim]
    err_naive = float(np.abs(naive - F_true).mean())
    err_fixed = float(np.abs(fixed - F_true).mean())
    check("A1 decontam beats naive by >=50%", err_fixed <= 0.5 * err_naive,
          f"naive={err_naive:.1f} fixed={err_fixed:.1f}")
    check("A2 alpha preserved", np.array_equal(dec[:, :, 3], rgba[:, :, 3]))
    check("A3 interior untouched (still red)",
          np.abs(dec[60, 60, :3].astype(np.float32) - F_true).max() <= 2,
          str(dec[60, 60, :3]))


def test_harmonic_fill() -> None:
    print("\n[B] harmonic fill vs Telea on a linear gradient")
    h = w = 120
    ramp = np.linspace(0, 255, w, dtype=np.float32)
    grad = np.repeat(np.tile(ramp, (h, 1))[:, :, None], 3, axis=2).astype(np.uint8)
    hole = np.zeros((h, w), np.uint8)
    hole[40:80, 40:80] = 255  # interior square hole

    telea = cv2.inpaint(grad, hole, 3, cv2.INPAINT_TELEA).astype(np.float32)
    harm = dehalo.harmonic_fill(grad, hole, iters=400).astype(np.float32)
    truth = grad.astype(np.float32)
    hm = hole > 0
    err_telea = float(np.abs(telea[hm] - truth[hm]).mean())
    err_harm = float(np.abs(harm[hm] - truth[hm]).mean())
    check("B1 harmonic <= telea error", err_harm <= err_telea,
          f"telea={err_telea:.2f} harm={err_harm:.2f}")
    check("B2 harmonic near-exact on linear ramp", err_harm <= 3.0, f"{err_harm:.2f}")


def test_dispatch_and_guards() -> None:
    print("\n[C] dispatch + guards")
    h = w = 40
    grad = np.zeros((h, w, 3), np.uint8)
    hole = np.zeros((h, w), np.uint8)
    check("C1 empty hole -> unchanged",
          np.array_equal(dehalo.fill_background(grad, hole, method="poisson"), grad))
    hole[10:20, 10:20] = 255
    out = dehalo.fill_background(grad, hole, method="poisson")
    check("C2 poisson dispatch returns image", out.shape == grad.shape)

    # all-foreground rgba -> decontaminate is a no-op
    rgba = np.dstack([np.full((h, w, 3), 200, np.uint8), np.full((h, w), 255, np.uint8)])
    check("C3 all-fg -> no-op", np.array_equal(dehalo.decontaminate_rgba(rgba), rgba))
    # 3-channel input (no alpha) -> returned as-is
    check("C4 non-rgba -> passthrough",
          np.array_equal(dehalo.decontaminate_rgba(grad), grad))


def main() -> int:
    print("=" * 60)
    print("DE-HALO / FILL GOLDEN FLOORS")
    print("=" * 60)
    for t in (test_dehalo, test_harmonic_fill, test_dispatch_and_guards):
        t()
    print("\n" + "=" * 60)
    total = _passes + len(_failures)
    print(f"{_passes}/{total} passed, {len(_failures)} failed")
    if _failures:
        print("FAILURES: " + ", ".join(_failures))
        print("SOME FLOORS BROKE")
        return 1
    print("ALL DE-HALO FLOORS HELD")
    return 0


if __name__ == "__main__":
    sys.exit(main())
