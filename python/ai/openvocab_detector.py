"""
Open-vocabulary control detector — local, training-free semantic detection via
YOLO-World (ultralytics). You give it text prompts ("knob", "fader", "LED") and
it finds them zero-shot, on CPU or GPU, with no fine-tuning.

This is the local-first "brain": semantic recall without depending on a cloud
VLM (Gemini stays optional/off). Florence-2 was retired by this project for
wrapping every text label as a knob; YOLO-World is box-only and prompt-scoped,
so it does not have that failure mode.

Standalone test:
    .venv/Scripts/python.exe ai/openvocab_detector.py --image <path> [--conf 0.03]
    → writes ../.tmp/openvocab/overlay.png + prints counts by type.
"""
from __future__ import annotations

import logging
import os
import sys
from typing import List, Optional

import numpy as np

# Allow `import runtime` (lives in python/) whether this file is imported as
# ai.openvocab_detector or run directly as ai/openvocab_detector.py.
_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

import runtime

logger = logging.getLogger(__name__)

# Text prompt → our canonical control type. Multiple phrasings per type lift
# recall; YOLO-World embeds each phrase via CLIP and detects zero-shot.
PROMPT_TO_TYPE = {
    "knob": "knob",
    "dial": "knob",
    "rotary knob": "knob",
    "round control knob": "knob",
    "slider": "slider",
    "fader": "slider",
    "vertical fader": "slider",
    "LED": "led",
    "small indicator light": "led",
    "button": "button",
    "toggle switch": "button",
    "display screen": "screen",
    "monitor display": "screen",
}

_model = None
_loaded_classes: Optional[List[str]] = None


def _weight_name() -> str:
    """Small/fast on CPU, large/accurate on GPU."""
    return "yolov8s-worldv2.pt" if runtime.get_runtime().device == "cpu" else "yolov8x-worldv2.pt"


def _ultra_device():
    """Map our device to what ultralytics .predict(device=...) accepts."""
    dev = runtime.torch_device()
    if dev == "cuda":
        return 0
    if dev == "mps":
        return "mps"
    return "cpu"  # ultralytics has no DirectML path → CPU


def check_available() -> dict:
    try:
        from ultralytics import YOLOWorld  # noqa: F401
        return {"available": True, "weight": _weight_name(), "device": runtime.torch_device()}
    except Exception as e:  # pragma: no cover
        return {"available": False, "reason": str(e)}


def _load():
    global _model, _loaded_classes
    if _model is not None:
        return _model
    from ultralytics import YOLOWorld

    runtime.configure_threads()
    weight = _weight_name()
    models_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
    local = os.path.join(models_dir, weight)
    src = local if os.path.isfile(local) else weight  # else ultralytics downloads it
    logger.info("Loading YOLO-World: %s", src)
    _model = YOLOWorld(src)
    classes = list(dict.fromkeys(PROMPT_TO_TYPE.keys()))
    _model.set_classes(classes)
    _loaded_classes = classes
    return _model


def _iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / max(union, 1e-6)


def _cross_class_nms(dets: List[dict], iou_thr: float) -> List[dict]:
    """YOLO-World runs per-class NMS; 'knob' and 'dial' overlap, so suppress
    across classes too, keeping the highest-confidence box."""
    dets = sorted(dets, key=lambda d: d["confidence"], reverse=True)
    kept: List[dict] = []
    for d in dets:
        if all(_iou(d["bbox"], k["bbox"]) <= iou_thr for k in kept):
            kept.append(d)
    return kept


def detect(img_bgr: np.ndarray, conf: float = 0.03, iou: float = 0.5,
           imgsz: int = 1280) -> List[dict]:
    """Detect synth controls by text prompt. Returns pipeline-shaped dicts:
    {type, bbox:[x1,y1,x2,y2], confidence, source:"yoloworld", phrase}."""
    model = _load()
    res = model.predict(img_bgr, conf=conf, iou=iou, imgsz=imgsz,
                        device=_ultra_device(), verbose=False)
    out: List[dict] = []
    if not res:
        return out
    r = res[0]
    names = r.names
    for b in r.boxes:
        idx = int(b.cls[0])
        phrase = names[idx] if isinstance(names, (list, tuple)) else names.get(idx, str(idx))
        ctype = PROMPT_TO_TYPE.get(phrase)
        if ctype is None:
            continue
        x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
        out.append({
            "type": ctype,
            "bbox": [x1, y1, x2, y2],
            "confidence": float(b.conf[0]),
            "source": "yoloworld",
            "phrase": phrase,
        })
    return _cross_class_nms(out, iou)


# ─── Standalone test harness ─────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import json

    import cv2

    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--conf", type=float, default=0.03)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", ".tmp", "openvocab"))
    args = ap.parse_args()

    runtime.configure_threads()
    print("Runtime:", json.dumps(runtime.runtime_report(), default=str))
    print("Available:", json.dumps(check_available(), default=str))

    img = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {args.image}")

    import time
    t0 = time.perf_counter()
    dets = detect(img, conf=args.conf)
    dt = time.perf_counter() - t0

    by_type: dict = {}
    for d in dets:
        by_type[d["type"]] = by_type.get(d["type"], 0) + 1
    confs = [d["confidence"] for d in dets]
    print(f"\nDetections: {len(dets)} in {dt:.1f}s")
    print("By type:", by_type)
    if confs:
        print(f"Confidence: min {min(confs):.3f} · mean {sum(confs)/len(confs):.3f} · max {max(confs):.3f}")

    colors = {"knob": (51, 170, 255), "slider": (80, 220, 120), "led": (60, 60, 255),
              "button": (255, 150, 60), "screen": (230, 200, 60)}
    ov = img.copy()
    for d in dets:
        x1, y1, x2, y2 = (int(v) for v in d["bbox"])
        c = colors.get(d["type"], (255, 255, 255))
        cv2.rectangle(ov, (x1, y1), (x2, y2), c, 2)
        cv2.putText(ov, f"{d['phrase']} {d['confidence']:.2f}", (x1, max(12, y1 - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, c, 1, cv2.LINE_AA)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    cv2.imwrite(os.path.join(out_dir, "overlay.png"), ov)
    print("Wrote", os.path.join(out_dir, "overlay.png"))
