"""Fast detection-only probe — runs detect_components (no segment/OCR) and
reports counts + how many land inside the wavetable-view region. For iterating
on the CV precision filters without paying the full pipeline cost."""
import sys
import time
import warnings
from collections import Counter

warnings.filterwarnings("ignore")

import cv2

import runtime
runtime.configure_threads()
import panel_pipeline as pp

path = sys.argv[1]
# Optional region "x1,y1,x2,y2" to count detections whose center falls inside.
region = [int(v) for v in sys.argv[2].split(",")] if len(sys.argv) > 2 else None

img = cv2.imread(path, cv2.IMREAD_COLOR)
if img is None:
    raise SystemExit(f"cannot read {path}")

t = time.perf_counter()
dets = pp.detect_components(img, min_confidence=0.40)
dt = time.perf_counter() - t

print(f"total {len(dets)} in {dt:.1f}s")
print("by type  ", dict(Counter(d["type"] for d in dets)))
print("by source", dict(Counter(d.get("source") for d in dets)))

if region:
    rx1, ry1, rx2, ry2 = region
    n = 0
    for d in dets:
        b = d["bbox"]
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if rx1 < cx < rx2 and ry1 < cy < ry2:
            n += 1
    print(f"inside region {region}: {n}")
