"""
test_shape_fit.py — deterministic floors for parametric shape fitting.

Synthesize masks with a KNOWN primitive (circle / rect / rounded-rect / ellipse
/ triangle), then assert the fitter recovers the right KIND and params within
tolerance. Also checks the ``origin`` offset and that every result carries a
non-empty SVG path. Pure OpenCV/NumPy, no brain.

Run:  .venv/Scripts/python.exe test_shape_fit.py
"""
from __future__ import annotations

import sys

import cv2
import numpy as np

import shape_fit as sf

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


def _blank(w=160, h=160):
    return np.zeros((h, w), np.uint8)


def test_circle() -> None:
    print("\n[A] circle")
    m = _blank()
    cv2.circle(m, (80, 80), 40, 255, -1)
    s = sf.fit_shape(m)
    check("A1 kind circle", s["kind"] == "circle", s["kind"])
    check("A2 cx~80", abs(s["params"]["cx"] - 80) <= 2, str(s["params"]["cx"]))
    check("A3 r~40", abs(s["params"]["r"] - 40) <= 2, str(s["params"]["r"]))
    check("A4 iou high", s["iou"] >= 0.95, str(s["iou"]))
    check("A5 svg path", s["svg_path"].startswith("M") and "a" in s["svg_path"])


def test_rect() -> None:
    print("\n[B] axis-aligned rectangle")
    m = _blank()
    cv2.rectangle(m, (30, 50), (129, 109), 255, -1)  # 100 x 60
    s = sf.fit_shape(m)
    check("B1 kind rect", s["kind"] == "rect", s["kind"])
    check("B2 w~100", abs(s["params"]["w"] - 100) <= 2, str(s["params"]["w"]))
    check("B3 h~60", abs(s["params"]["h"] - 60) <= 2, str(s["params"]["h"]))
    check("B4 iou high", s["iou"] >= 0.97, str(s["iou"]))


def test_rounded_rect() -> None:
    print("\n[C] rounded rectangle (r=16)")
    m = sf._draw_rounded_rect((160, 160), 20, 40, 120, 70, 16)
    s = sf.fit_shape(m)
    check("C1 kind rounded_rect", s["kind"] == "rounded_rect", s["kind"])
    check("C2 r~16", abs(s["params"]["r"] - 16) <= 4, str(s["params"].get("r")))
    check("C3 w~120", abs(s["params"]["w"] - 120) <= 2, str(s["params"]["w"]))
    check("C4 iou high", s["iou"] >= 0.95, str(s["iou"]))
    check("C5 svg has arcs", "a " in s["svg_path"] or "A " in s["svg_path"])


def test_ellipse() -> None:
    print("\n[D] ellipse (rx=55, ry=28)")
    m = _blank(200, 160)
    cv2.ellipse(m, (100, 80), (55, 28), 0, 0, 360, 255, -1)
    s = sf.fit_shape(m)
    check("D1 kind ellipse", s["kind"] == "ellipse", s["kind"])
    check("D2 rx~55", abs(s["params"]["rx"] - 55) <= 4, str(s["params"].get("rx")))
    check("D3 ry~28", abs(s["params"]["ry"] - 28) <= 4, str(s["params"].get("ry")))
    check("D4 iou high", s["iou"] >= 0.93, str(s["iou"]))


def test_triangle_polygon() -> None:
    print("\n[E] triangle -> polygon fallback")
    m = _blank()
    tri = np.array([[80, 20], [140, 130], [20, 130]], np.int32)
    cv2.fillPoly(m, [tri], 255)
    s = sf.fit_shape(m)
    check("E1 kind polygon", s["kind"] == "polygon", s["kind"])
    check("E2 ~3 vertices", 3 <= s["point_count"] <= 4, str(s["point_count"]))
    check("E3 svg has L", " L " in s["svg_path"])


def test_origin_offset() -> None:
    print("\n[F] origin offset -> absolute coords")
    m = _blank()
    cv2.circle(m, (80, 80), 30, 255, -1)
    s = sf.fit_shape(m, origin=(1000, 500))
    check("F1 cx offset applied", abs(s["params"]["cx"] - 1080) <= 2, str(s["params"]["cx"]))
    check("F2 cy offset applied", abs(s["params"]["cy"] - 580) <= 2, str(s["params"]["cy"]))


def test_from_control() -> None:
    print("\n[G] fit_from_control via encoded mask")
    m = _blank(80, 80)
    cv2.circle(m, (40, 40), 30, 255, -1)
    ok, buf = cv2.imencode(".png", m)
    import base64
    b64 = "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()
    ctl = {"id": "k1", "type": "knob", "mask_png": b64, "mask_bbox": [200, 100, 280, 180]}
    s = sf.fit_from_control(ctl)
    check("G1 fit succeeded", s is not None)
    check("G2 kind circle", s and s["kind"] == "circle", s["kind"] if s else "none")
    check("G3 abs cx~240", s and abs(s["params"]["cx"] - 240) <= 2, str(s["params"]["cx"]) if s else "none")
    ids = sf.shapes_by_id([ctl])
    check("G4 shapes_by_id keyed", "k1" in ids)


def test_degenerate() -> None:
    print("\n[H] degenerate")
    check("H1 empty mask -> None", sf.fit_shape(_blank()) is None)
    check("H2 None -> None", sf.fit_shape(None) is None)


def main() -> int:
    print("=" * 60)
    print("SHAPE FIT GOLDEN FLOORS")
    print("=" * 60)
    for t in (test_circle, test_rect, test_rounded_rect, test_ellipse,
              test_triangle_polygon, test_origin_offset, test_from_control, test_degenerate):
        t()
    print("\n" + "=" * 60)
    total = _passes + len(_failures)
    print(f"{_passes}/{total} passed, {len(_failures)} failed")
    if _failures:
        print("FAILURES: " + ", ".join(_failures))
        print("SOME FLOORS BROKE")
        return 1
    print("ALL SHAPE FLOORS HELD")
    return 0


if __name__ == "__main__":
    sys.exit(main())
