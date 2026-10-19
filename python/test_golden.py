"""
test_golden.py — deterministic regression floors for the extraction pipeline.

The 12-filter detection stack + segmentation are tuned by feel; one threshold
tweak can silently regress the "pixel-perfect" promise. This suite freezes the
DETERMINISTIC guarantees so a regression fails loudly:

  A. rectify recovers a known perspective warp to <= 6 px           (geometry)
  B. edge refinement keeps interiors opaque / exteriors clear        (alpha)
  C. a full-res cut edge is SHARP, not a blocky upscale halo         (no-halo)
  D. GrabCut segmentation of a clean shape hits an IoU floor         (masking)
  E. the punch triple: hole punched, background filled               (export)
  F. the full-res coordinate guard upscales a downscaled mask        (contract)

Detection PRECISION floors need the (non-deterministic, paid) Gemini brain and a
frozen set of accepted layouts — those live in ``python/golden/*.json`` and are
run opt-in by ``--with-detection`` so this core suite stays fast and free.

Run:  .venv/Scripts/python.exe test_golden.py
      .venv/Scripts/python.exe test_golden.py --with-detection
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

import panel_pipeline as pp
import background_export as bx
import layout_manifest as lm
import rectify

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"

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


def iou(a: np.ndarray, b: np.ndarray) -> float:
    a = a > 127
    b = b > 127
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter) / float(union) if union else 0.0


# ── A. rectify ────────────────────────────────────────────────────────────────
def test_rectify() -> None:
    print("A. rectify recovers a known perspective warp")
    panel = np.full((300, 400, 3), 90, np.uint8)
    cv2.rectangle(panel, (40, 40), (360, 260), (180, 180, 180), 6)
    warped, known = rectify.synth_perspective(panel, tilt=0.22)
    res = rectify.rectify_panel(warped, force=None)
    check("rectify applied on perspective input", res.applied, res.reason)
    if res.src_quad is not None:
        err = rectify.quad_corner_error(rectify.order_corners(known), res.src_quad)
        check("corner recovery <= 6px", err <= 6.0, f"{err:.2f}px")
    # flat panel must be a no-op
    flat = rectify.rectify_panel(panel, force=None)
    check("flat panel is a no-op", not flat.applied, flat.reason)


# ── B. edge refinement alpha ──────────────────────────────────────────────────
def test_edge_refine() -> None:
    print("B. guided-filter edge refinement")
    crop = np.full((80, 80, 3), 200, np.uint8)
    cv2.circle(crop, (40, 40), 25, (40, 40, 40), -1)
    mask = np.zeros((80, 80), np.uint8)
    cv2.circle(mask, (40, 40), 25, 255, -1)
    out = pp.refine_mask_edges(mask, crop)
    check("interior stays opaque", int(out[40, 40]) == 255)
    check("far exterior stays clear", int(out[2, 2]) == 0)
    soft = int(np.sum((out > 0) & (out < 255)))
    check("boundary is graded (anti-aliased)", soft > 50, f"{soft} soft px")
    check("shape-mismatch guard returns input", pp.refine_mask_edges(mask, crop[:, :40]) is mask)


# ── C. no-halo: full-res cut edge sharpness ───────────────────────────────────
def test_edge_sharpness() -> None:
    print("C. full-res cut is sharp, not a blocky upscale halo")
    # emulate a downscaled binary mask upscaled two ways
    hires = np.zeros((400, 400), np.uint8)
    cv2.circle(hires, (200, 200), 120, 255, -1)
    small = cv2.resize(hires, (100, 100), interpolation=cv2.INTER_AREA)
    _, small = cv2.threshold(small, 127, 255, cv2.THRESH_BINARY)
    nearest = cv2.resize(small, (400, 400), interpolation=cv2.INTER_NEAREST)
    linear = cv2.resize(small, (400, 400), interpolation=cv2.INTER_LINEAR)
    _, linear = cv2.threshold(linear, 127, 255, cv2.THRESH_BINARY)
    # perimeter roughness: a blocky nearest edge has a LONGER contour than a
    # smooth linear+threshold edge for the same shape.
    def perim(m):
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        return cv2.arcLength(max(cs, key=cv2.contourArea), True) if cs else 0.0
    p_near, p_lin = perim(nearest), perim(linear)
    check("linear+threshold edge smoother than nearest", p_lin < p_near,
          f"linear={p_lin:.0f} < nearest={p_near:.0f}")
    check("linear IoU vs hires >= 0.98", iou(linear, hires) >= 0.98, f"{iou(linear, hires):.3f}")


# ── D. segmentation IoU floor ─────────────────────────────────────────────────
def test_segmentation_iou() -> None:
    print("D. GrabCut segmentation of a clean shape hits an IoU floor")
    img = np.full((240, 240, 3), 210, np.uint8)
    cv2.circle(img, (120, 120), 70, (35, 35, 35), -1)  # dark knob on light panel
    gt = np.zeros((240, 240), np.uint8)
    cv2.circle(gt, (120, 120), 70, 255, -1)
    mask = pp._grabcut_roi(img, [50, 50, 190, 190])
    check("grabcut returned a mask", mask is not None)
    if mask is not None:
        score = iou(mask, gt)
        check("segmentation IoU >= 0.90", score >= 0.90, f"IoU={score:.3f}")


# ── E. punch triple ───────────────────────────────────────────────────────────
def test_punch_triple() -> None:
    print("E. punch triple: hole punched + background filled")
    import base64
    img = np.full((200, 300, 3), 200, np.uint8)
    cv2.circle(img, (150, 100), 40, (40, 40, 40), -1)
    mask = np.zeros((200, 300), np.uint8)
    cv2.circle(mask, (150, 100), 40, 255, -1)
    crop = mask[60:141, 110:191]
    ok, buf = cv2.imencode(".png", crop)
    ctl = {"id": "k1", "type": "knob", "parameter_id": "cutoff",
           "mask_png": "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode(),
           "mask_bbox": [110, 60, 191, 141]}
    res = bx.build_punch_triple(img, [ctl])
    p = cv2.imdecode(np.frombuffer(base64.b64decode(res["background_punched"].split(",", 1)[1]), np.uint8),
                     cv2.IMREAD_UNCHANGED)
    f = cv2.imdecode(np.frombuffer(base64.b64decode(res["background_filled"].split(",", 1)[1]), np.uint8),
                     cv2.IMREAD_COLOR)
    check("punched is RGBA", p.ndim == 3 and p.shape[2] == 4)
    check("hole centre punched transparent", int(p[100, 150, 3]) == 0)
    check("corner stays opaque", int(p[5, 5, 3]) == 255)
    check("hole filled (inpainted bright)", int(f[100, 150].mean()) > 150,
          f"brightness={int(f[100, 150].mean())}")
    check("one crop produced", res.get("crop_count") == 1)


def test_punch_dehalo_poisson() -> None:
    print("E2. punch triple: de-halo crop + poisson(harmonic) fill")
    import base64
    # Red knob on a green panel, soft-edged -> the classic halo case.
    img = np.full((200, 200, 3), 0, np.uint8)
    img[:, :, 1] = 180  # green bg (BGR)
    cx, cy, r = 100, 100, 45
    ys, xs = np.mgrid[0:200, 0:200]
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    a = np.clip((r - dist) / 6.0 + 0.5, 0, 1)
    red = np.zeros((200, 200, 3), np.float32); red[:, :, 2] = 255
    img = (a[..., None] * red + (1 - a[..., None]) * img.astype(np.float32)).astype(np.uint8)
    mask = (a * 255).astype(np.uint8)
    x1, y1, x2, y2 = 50, 50, 151, 151
    crop = mask[y1:y2, x1:x2]
    ok, buf = cv2.imencode(".png", crop)
    ctl = {"id": "k", "type": "knob",
           "mask_png": "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode(),
           "mask_bbox": [x1, y1, x2, y2]}

    on = bx.build_punch_triple(img, [ctl], fill_method="poisson", dehalo=True)
    off = bx.build_punch_triple(img, [ctl], fill_method="poisson", dehalo=False)

    def rim_green(res):
        rgba = cv2.imdecode(np.frombuffer(base64.b64decode(res["crops"][0]["png"].split(",", 1)[1]),
                                          np.uint8), cv2.IMREAD_UNCHANGED)
        al = rgba[:, :, 3].astype(np.float32) / 255
        rim = (al > 0.1) & (al < 0.9)
        if not rim.any():
            return 0.0
        # green channel excess over red on the rim = leftover background tint
        g = rgba[:, :, 1].astype(np.float32)[rim]
        rr = rgba[:, :, 2].astype(np.float32)[rim]
        return float((g - rr).mean())

    check("E2a poisson fill ran", off.get("background_filled", "").startswith("data:"))
    check("E2b de-halo cuts rim green tint", rim_green(on) < rim_green(off) - 5,
          f"on={rim_green(on):.1f} off={rim_green(off):.1f}")


# ── F. coordinate-space guard ─────────────────────────────────────────────────
def test_coord_guard() -> None:
    print("F. full-res coordinate guard upscales a mismatched mask")
    img = np.full((240, 240, 3), 210, np.uint8)
    cv2.circle(img, (120, 120), 70, (35, 35, 35), -1)
    small_mask = np.zeros((120, 120), np.uint8)  # half-res mask (upstream bug)
    cv2.circle(small_mask, (60, 60), 35, 255, -1)
    d: dict = {"id": "x", "type": "knob", "bbox": [50, 50, 190, 190]}
    pp._apply_mask_to_detection(d, small_mask, img)
    mb = d.get("mask_bbox")
    check("mask applied despite size mismatch", d.get("mask_png") is not None)
    check("refined bbox in full-res coords", bool(mb) and mb[2] > 120 and mb[3] > 120,
          f"mask_bbox={mb}")


# ── optional: real captured-panel detection floors ────────────────────────────
def test_detection_goldens() -> None:
    import json
    print("G. captured-panel detection precision floors (opt-in)")
    if not GOLDEN_DIR.exists():
        print("  [skip] no golden/ dir — drop <name>.png + <name>.json to enable")
        return
    goldens = sorted(GOLDEN_DIR.glob("*.json"))
    if not goldens:
        print("  [skip] golden/ is empty")
        return
    caps = pp.check_panel_pipeline_available()
    if not caps.get("gemini_key_set"):
        print("  [skip] Gemini key not set — detection floors need the brain on")
        return
    import base64
    for gj in goldens:
        spec = json.loads(gj.read_text(encoding="utf-8"))
        img_path = GOLDEN_DIR / spec["image"]
        if not img_path.exists():
            check(f"{gj.name}: image present", False, str(img_path))
            continue
        raw = img_path.read_bytes()
        b64 = "data:image/png;base64," + base64.b64encode(raw).decode()
        result = pp.analyze_panel(b64, detect_labels=True, segment=False)
        got = len(result["controls"])
        lo, hi = spec.get("control_count_range", [1, 10_000])
        check(f"{gj.name}: control count in [{lo},{hi}]", lo <= got <= hi, f"got {got}")


def test_layout_manifest() -> None:
    print("H. layout.json v1 manifest contract")
    controls = [{
        "id": "1", "type": "knob", "parameter_id": "cutoff", "display_name": "Cutoff",
        "refined_bbox": [100, 50, 180, 130], "circle": {"cx": 140, "cy": 90, "radius": 40},
        "features": {"has_pointer": True, "min_angle_deg": -135, "max_angle_deg": 135,
                     "pointer_angle_deg": 10, "value_normalized": 0.54},
    }]
    man = lm.build_layout_manifest(controls, 640, 480, scales_by_id={"1": [1, 2, 3, 4]})
    check("schema is v1", man["schema"] == "synthskin.layout/v1")
    a0 = man["assets"][0]
    check("rect is [x,y,w,h] full-res", a0["rect"] == [100, 50, 80, 80], str(a0["rect"]))
    check("pivot is circle centre", a0["pivot"] == [140.0, 90.0], str(a0["pivot"]))
    check("angle default carried", a0["angle"]["default_deg"] == 10)
    check("scales carried", a0.get("scales") == [1, 2, 3, 4])
    check("provenance defaults to ai", a0["provenance"] == "ai")


def test_layout_semantics_in_manifest() -> None:
    print("I. semantics block: manifest carries the logical layout tree")
    # A clean 3x2 grid of knobs (60px, 40px gaps -> pitch 100).
    controls = []
    for r in range(2):
        for c in range(3):
            x, y = 20 + c * 100, 20 + r * 100
            controls.append({"id": f"k{r}{c}", "type": "knob",
                             "refined_bbox": [x, y, x + 60, y + 60]})
    man = lm.build_layout_manifest(controls, 400, 260, include_semantics=True)
    sem = man.get("semantics")
    check("semantics attached", isinstance(sem, dict))
    if isinstance(sem, dict):
        hint = sem["tree"].get("layout", {})
        check("semantics tree is a grid", hint.get("display") == "grid", str(hint.get("display")))
        check("semantics grid 2x3", (hint.get("rows"), hint.get("cols")) == (2, 3),
              f"{hint.get('rows')}x{hint.get('cols')}")
        check("semantics tree rects match assets",
              sem["tree"]["children"][0]["rect"] == man["assets"][0]["rect"])
    # Opt-out path must produce no semantics block.
    man2 = lm.build_layout_manifest(controls, 400, 260, include_semantics=False)
    check("semantics opt-out honoured", "semantics" not in man2)


def test_shape_on_asset() -> None:
    print("J. parametric shape fitted onto a manifest asset (knob -> circle)")
    import base64
    m = np.zeros((80, 80), np.uint8)
    cv2.circle(m, (40, 40), 30, 255, -1)
    ok, buf = cv2.imencode(".png", m)
    b64 = "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()
    controls = [{"id": "k", "type": "knob", "mask_png": b64,
                 "mask_bbox": [100, 100, 180, 180], "refined_bbox": [100, 100, 180, 180]}]
    man = lm.build_layout_manifest(controls, 400, 400, include_shapes=True)
    a0 = man["assets"][0]
    check("shape attached", "shape" in a0, str(a0.get("shape", {}).get("kind")))
    check("shape is circle", a0.get("shape", {}).get("kind") == "circle")
    check("shape has svg_path", bool(a0.get("shape", {}).get("svg_path")))
    check("abs centre carried (cx~140)", abs(a0["shape"]["params"]["cx"] - 140) <= 2,
          str(a0["shape"]["params"]["cx"]))
    man_off = lm.build_layout_manifest(controls, 400, 400, include_shapes=False)
    check("shapes opt-out honoured", "shape" not in man_off["assets"][0])


def test_interaction_on_asset() -> None:
    print("K. interaction preset fitted onto a manifest asset")
    controls = [
        {"id": "k", "type": "knob", "refined_bbox": [10, 10, 50, 50]},
        {"id": "s", "type": "slider", "refined_bbox": [0, 0, 200, 20]},
        {"id": "lbl", "type": "label", "refined_bbox": [0, 0, 60, 12]},
    ]
    man = lm.build_layout_manifest(controls, 400, 400, include_interaction=True)
    by = {a["id"]: a for a in man["assets"]}
    check("knob has interaction", "interaction" in by["k"])
    check("knob rotate spring", by["k"]["interaction"]["affordance"] == "rotate")
    check("slider axis inferred x", by["s"]["interaction"]["axis"] == "x",
          str(by["s"]["interaction"].get("axis")))
    check("label has NO interaction", "interaction" not in by["lbl"])
    man_off = lm.build_layout_manifest(controls, 400, 400, include_interaction=False)
    check("interaction opt-out honoured",
          all("interaction" not in a for a in man_off["assets"]))


def main() -> int:
    print("=" * 68)
    print("GOLDEN REGRESSION FLOORS")
    print("=" * 68)
    test_rectify()
    test_edge_refine()
    test_edge_sharpness()
    test_segmentation_iou()
    test_punch_triple()
    test_punch_dehalo_poisson()
    test_coord_guard()
    test_layout_manifest()
    test_layout_semantics_in_manifest()
    test_shape_on_asset()
    test_interaction_on_asset()
    if "--with-detection" in sys.argv:
        test_detection_goldens()
    print("=" * 68)
    print(f"{_passes} passed, {len(_failures)} failed")
    if _failures:
        print("FAILURES: " + ", ".join(_failures))
        return 1
    print("ALL GOLDEN FLOORS HELD")
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    sys.exit(main())
