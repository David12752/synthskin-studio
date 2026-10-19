"""
Dogfood harness — run the full SOTA panel pipeline on ONE real image and dump
everything needed to SEE what actually works (Stage 0 / Ground Truth).

This bypasses Electron + FastAPI and calls `panel_pipeline.analyze_panel`
directly, so we measure the CORE engine in isolation.

Outputs (into --out):
  report.md          human summary: live capabilities, counts by type,
                     confidence stats, per-stage timing, which model produced
                     the detections, and a table of every control.
  layout.json        full pipeline result (controls, labels, sections, timing).
  overlay.png        original image with colored boxes + labels drawn on top.
  assets/<id>.png    every detected component, sliced out with a transparent
                     alpha (the actual "asset for code" deliverable).

Usage (from python/ with the venv active):
  .venv/Scripts/python.exe dogfood_pipeline.py --image "C:/path/to/synth.png"
  .venv/Scripts/python.exe dogfood_pipeline.py            # auto-scans .tmp/dogfood_input/
"""
from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import sys
import warnings
from datetime import datetime, timezone

warnings.filterwarnings("ignore")

import cv2
import numpy as np

# BGR colors per control type for the overlay
TYPE_COLORS = {
    "knob": (51, 170, 255),     # amber
    "slider": (80, 220, 120),   # green
    "fader": (80, 220, 120),
    "button": (255, 150, 60),   # blue
    "switch": (255, 150, 60),
    "led": (60, 60, 255),       # red
    "display": (230, 200, 60),  # cyan
    "screen": (230, 200, 60),
    "meter": (200, 120, 255),   # pink
    "jack": (180, 180, 180),
    "label": (120, 120, 120),
    "panel": (90, 90, 90),
}
DEFAULT_COLOR = (255, 255, 255)


def b64_of(path: str) -> str:
    with open(path, "rb") as f:
        raw = f.read()
    ext = (os.path.splitext(path)[1].lstrip(".").lower() or "png")
    if ext == "jpg":
        ext = "jpeg"
    return f"data:image/{ext};base64," + base64.b64encode(raw).decode("ascii")


def decode_b64_img(b64: str, flags=cv2.IMREAD_UNCHANGED):
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    arr = np.frombuffer(base64.b64decode(b64), np.uint8)
    return cv2.imdecode(arr, flags)


def slice_asset(img_bgr: np.ndarray, d: dict):
    """Return a BGRA cutout for one detection.

    Prefers the segmentation mask (mask_png + mask_bbox) for a clean alpha;
    falls back to an opaque bbox crop when no mask exists.
    """
    ih, iw = img_bgr.shape[:2]
    mb, mp = d.get("mask_bbox"), d.get("mask_png")
    if mb and mp:
        x1, y1, x2, y2 = (int(v) for v in mb)
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(iw, x2), min(ih, y2)
        if x2 > x1 and y2 > y1:
            crop = img_bgr[y1:y2, x1:x2]
            m = decode_b64_img(mp, cv2.IMREAD_GRAYSCALE)
            if m is not None:
                if m.shape[:2] != crop.shape[:2]:
                    m = cv2.resize(m, (crop.shape[1], crop.shape[0]),
                                   interpolation=cv2.INTER_NEAREST)
                bgra = cv2.cvtColor(crop, cv2.COLOR_BGR2BGRA)
                bgra[:, :, 3] = m
                return bgra, True
    # fallback: opaque bbox crop
    bb = d.get("refined_bbox") or d.get("bbox")
    if not bb:
        return None, False
    x1, y1, x2, y2 = (int(v) for v in bb)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(iw, x2), min(ih, y2)
    if x2 <= x1 or y2 <= y1:
        return None, False
    return cv2.cvtColor(img_bgr[y1:y2, x1:x2], cv2.COLOR_BGR2BGRA), False


def draw_overlay(img_bgr: np.ndarray, controls: list, labels: list) -> np.ndarray:
    out = img_bgr.copy()
    for lab in labels:
        bb = lab.get("bbox")
        if not bb:
            continue
        x1, y1, x2, y2 = (int(v) for v in bb)
        cv2.rectangle(out, (x1, y1), (x2, y2), (120, 120, 120), 1)
    for d in controls:
        bb = d.get("refined_bbox") or d.get("bbox")
        if not bb:
            continue
        x1, y1, x2, y2 = (int(v) for v in bb)
        color = TYPE_COLORS.get(d.get("type", ""), DEFAULT_COLOR)
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        tag = f"{d.get('type','?')} {d.get('confidence', 0):.2f}"
        name = d.get("display_name") or d.get("label")
        if name:
            tag += f" [{name}]"
        cv2.putText(out, tag, (x1, max(12, y1 - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, color, 1, cv2.LINE_AA)
    return out


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default=None, help="path to a synth UI image")
    ap.add_argument("--out", default=os.path.join(here, "..", ".tmp", "dogfood"),
                    help="output directory")
    ap.add_argument("--min-conf", type=float, default=0.40)
    ap.add_argument("--no-labels", action="store_true", help="skip OCR labels")
    args = ap.parse_args()

    img_path = args.image
    if not img_path:
        in_dir = os.path.join(here, "..", ".tmp", "dogfood_input")
        os.makedirs(in_dir, exist_ok=True)
        hits = []
        for ext in ("png", "jpg", "jpeg", "webp", "bmp"):
            hits += glob.glob(os.path.join(in_dir, f"*.{ext}"))
        if not hits:
            print(f"No --image given and no images found in:\n  {os.path.abspath(in_dir)}")
            print("Drop a synth UI image there, or pass --image <path>.")
            return 2
        img_path = sorted(hits)[0]

    if not os.path.isfile(img_path):
        print(f"Image not found: {img_path}")
        return 2

    out_dir = os.path.abspath(args.out)
    assets_dir = os.path.join(out_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)

    print(f"== Dogfood: {os.path.basename(img_path)} ==", flush=True)
    import runtime
    runtime.configure_threads()
    print("Runtime:", json.dumps(runtime.runtime_report(), default=str), flush=True)

    import panel_pipeline as pp

    caps = pp.check_panel_pipeline_available()
    print("Capabilities:", json.dumps(caps, default=str), flush=True)

    img_b64 = b64_of(img_path)
    img_bgr = decode_b64_img(img_b64, cv2.IMREAD_COLOR)
    ih, iw = img_bgr.shape[:2]
    print(f"Image: {iw}x{ih}", flush=True)

    def progress(stage, pct, msg):
        # Console here is cp1255 (Hebrew); strip non-ASCII so a ⚠/✓ in a message
        # can't crash the run with UnicodeEncodeError.
        safe = str(msg).encode("ascii", "replace").decode("ascii")
        print(f"  [{int(pct):3d}%] {str(stage):10s} {safe}", flush=True)

    t0 = datetime.now(timezone.utc)
    result = pp.analyze_panel(
        img_b64,
        min_confidence=args.min_conf,
        detect_labels=not args.no_labels,
        segment=True,
        extract_features_flag=True,
        progress_cb=progress,
    )
    wall_s = (datetime.now(timezone.utc) - t0).total_seconds()

    controls = result.get("controls", [])
    labels = result.get("labels", [])

    # ── Save full JSON (drop heavy base64 mask blobs to keep it readable) ──
    slim = json.loads(json.dumps(result, default=str))
    for d in slim.get("controls", []):
        d.pop("mask_png", None)
    with open(os.path.join(out_dir, "layout.json"), "w", encoding="utf-8") as f:
        json.dump(slim, f, indent=2, ensure_ascii=False)

    # ── Save sliced assets ──
    masked_count = 0
    by_type: dict[str, int] = {}
    for d in controls:
        t = d.get("type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1
        bgra, had_mask = slice_asset(img_bgr, d)
        if bgra is None:
            continue
        masked_count += int(had_mask)
        name = d.get("parameter_id") or d.get("id") or t
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(name))[:48]
        cv2.imwrite(os.path.join(assets_dir, f"{safe}.png"), bgra)

    # ── Save overlay ──
    cv2.imwrite(os.path.join(out_dir, "overlay.png"),
                draw_overlay(img_bgr, controls, labels))

    # ── Report ──
    confs = [float(d.get("confidence", 0)) for d in controls]
    timing = result.get("timing", {})
    lines = []
    lines.append(f"# Dogfood report — {os.path.basename(img_path)}\n")
    lines.append(f"_Run: {t0.isoformat()} · image {iw}×{ih} · wall {wall_s:.1f}s_\n")
    lines.append("## Live capabilities (what was actually active)\n")
    for k in ("detection_model_used", "detection_sources"):
        lines.append(f"- **{k}**: `{result.get(k)}`")
    for k, v in caps.items():
        lines.append(f"- {k}: `{v}`")
    lines.append("")
    lines.append("## Results\n")
    lines.append(f"- controls: **{len(controls)}**  ·  labels: **{len(labels)}**  "
                 f"·  sections: **{result.get('sectionCount', 0)}**")
    lines.append(f"- assets sliced with a real mask: **{masked_count}/{len(controls)}** "
                 f"(rest are opaque bbox crops)")
    if confs:
        lines.append(f"- confidence: min {min(confs):.2f} · "
                     f"mean {sum(confs)/len(confs):.2f} · max {max(confs):.2f}")
    lines.append(f"- by type: " + ", ".join(f"{k}={v}" for k, v in sorted(by_type.items())))
    lines.append("")
    lines.append("## Per-stage timing (ms)\n")
    for k, v in timing.items():
        lines.append(f"- {k}: {v}")
    lines.append("")
    lines.append("## Every control\n")
    lines.append("| id | type | conf | label | parameter_id | masked |")
    lines.append("|----|------|------|-------|--------------|--------|")
    for d in controls:
        masked = "✓" if (d.get("mask_png") and d.get("mask_bbox")) else "—"
        lines.append(
            f"| {d.get('id','')} | {d.get('type','')} | {d.get('confidence',0):.2f} "
            f"| {d.get('label') or ''} | {d.get('parameter_id') or ''} | {masked} |"
        )
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print("\n" + "\n".join(lines[:24]), flush=True)
    print(f"\nWrote: {out_dir}", flush=True)
    print(f"  report.md · layout.json · overlay.png · assets/ ({len(controls)} png)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
