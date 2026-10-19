"""Quick functional test for batch detection."""
import numpy as np
import cv2
import base64
from pro_features import batch_detect_components

# Create a more realistic synth panel image
img = np.zeros((800, 1200, 3), dtype=np.uint8)
img[:] = (35, 32, 30)  # dark warm background

# Add subtle noise texture
noise = np.random.normal(0, 3, img.shape).astype(np.int16)
img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)

# Draw panel border
cv2.rectangle(img, (20, 20), (1180, 780), (60, 55, 50), 2)

# Row 1: Knobs (3 large, well-spaced)
for i, x in enumerate([200, 500, 800]):
    # Shadow
    cv2.circle(img, (x, 180), 58, (20, 18, 16), -1)
    # Body
    cv2.circle(img, (x, 180), 55, (90, 85, 80), -1)
    # Edge highlight
    cv2.circle(img, (x, 180), 55, (130, 125, 120), 2)
    # Indicator line
    angle = -45 + i * 30
    rad = np.radians(angle)
    lx = int(x + 40 * np.cos(rad))
    ly = int(180 + 40 * np.sin(rad))
    cv2.line(img, (x, 180), (lx, ly), (200, 190, 180), 2)
    # Label
    cv2.putText(img, f"KNOB {i+1}", (x-30, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (100, 95, 90), 1)

# Row 2: Smaller knobs
for x in [150, 300, 450, 600, 750, 900, 1050]:
    cv2.circle(img, (x, 380), 28, (80, 75, 70), -1)
    cv2.circle(img, (x, 380), 28, (120, 115, 110), 2)

# Sliders
for x in [150, 300]:
    # Track
    cv2.rectangle(img, (x-5, 450), (x+5, 650), (50, 48, 45), -1)
    cv2.rectangle(img, (x-5, 450), (x+5, 650), (80, 75, 70), 1)
    # Cap
    cv2.rectangle(img, (x-15, 530), (x+15, 570), (100, 95, 90), -1)
    cv2.rectangle(img, (x-15, 530), (x+15, 570), (140, 135, 130), 1)

# Screen/Display
cv2.rectangle(img, (500, 450), (800, 600), (15, 20, 25), -1)
cv2.rectangle(img, (500, 450), (800, 600), (100, 100, 110), 2)
cv2.putText(img, "DISPLAY", (580, 530), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (60, 80, 60), 1)

# LEDs
for i, x in enumerate([900, 930, 960, 990]):
    color = (0, 180, 0) if i < 3 else (0, 0, 200)
    cv2.circle(img, (x, 480), 6, color, -1)

# Buttons
for x in [900, 960, 1020]:
    cv2.rectangle(img, (x-18, 540), (x+18, 576), (70, 65, 60), -1)
    cv2.rectangle(img, (x-18, 540), (x+18, 576), (120, 115, 110), 2)

# Encode as base64
_, buf = cv2.imencode(".png", img)
b64 = "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()

detections = batch_detect_components(b64, min_area=100)
print(f"Detected {len(detections)} components:")
for d in detections:
    t = d["type"]
    st = d["suggestedType"]
    c = d["confidence"]
    b = d["bounds"]
    print(f"  {d['id']}: {t} ({st}) conf={c:.2f} at ({b['x']},{b['y']}) {b['width']}x{b['height']}")

print(f"\nCircles: {sum(1 for d in detections if d['type']=='circle')}")
print(f"Rects: {sum(1 for d in detections if d['type']=='rect')}")
suggested = {}
for d in detections:
    s = d["suggestedType"]
    suggested[s] = suggested.get(s, 0) + 1
print(f"By type: {suggested}")
print(f"\nExpected: ~3 large knobs, ~7 small knobs, 2 sliders, 1 screen, 3 buttons")

# Debug: check what contours exist in the screen area (500-800, 450-600)
import cv2 as _cv2
gray_dbg = _cv2.cvtColor(img, _cv2.COLOR_BGR2GRAY)
clahe = _cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
gray_enh = clahe.apply(gray_dbg)
median = np.median(gray_enh)
print(f"\nDebug: gray median={median}")
edges_dbg = _cv2.Canny(gray_enh, int(max(20, 0.5*median)), int(min(250, 1.5*median)))
screen_roi = edges_dbg[440:610, 490:810]
print(f"Screen ROI edge pixels: {np.sum(screen_roi > 0)}")

# Check gradient approach
sobelx = _cv2.Sobel(gray_enh, _cv2.CV_64F, 1, 0, ksize=3)
sobely = _cv2.Sobel(gray_enh, _cv2.CV_64F, 0, 1, ksize=3)
grad_mag = np.sqrt(sobelx**2 + sobely**2)
grad_norm = np.clip(grad_mag / max(grad_mag.max(), 1) * 255, 0, 255).astype(np.uint8)
_, grad_t = _cv2.threshold(grad_norm, 40, 255, _cv2.THRESH_BINARY)
close_k = _cv2.getStructuringElement(_cv2.MORPH_RECT, (3, 3))
grad_d = _cv2.dilate(grad_t, close_k, iterations=2)
grad_c = _cv2.morphologyEx(grad_d, _cv2.MORPH_CLOSE, _cv2.getStructuringElement(_cv2.MORPH_RECT,(5,5)), iterations=2)
grad_cnts, _ = _cv2.findContours(grad_c, _cv2.RETR_EXTERNAL, _cv2.CHAIN_APPROX_SIMPLE)
print(f"\nGradient contours (area>1500): {len([c for c in grad_cnts if _cv2.contourArea(c) >= 1500])}")
for c in sorted(grad_cnts, key=_cv2.contourArea, reverse=True)[:10]:
    x, y, cw, ch = _cv2.boundingRect(c)
    area = _cv2.contourArea(c)
    peri = _cv2.arcLength(c, True)
    circ = (4*3.14159*area)/(peri**2) if peri > 0 else 0
    print(f"  ({x},{y}) {cw}x{ch} area={area:.0f} circ={circ:.3f}")

print(f"\nGradient at screen border: top-edge={grad_norm[450, 500:505].tolist()}, left-edge={grad_norm[450:455, 500].tolist()}")

cnts_dbg, _ = _cv2.findContours(edges_dbg, _cv2.RETR_EXTERNAL, _cv2.CHAIN_APPROX_SIMPLE)
for c in cnts_dbg:
    x, y, cw, ch = _cv2.boundingRect(c)
    if 480 < x < 820 and 430 < y < 620 and cw > 30 and ch > 30:
        area = _cv2.contourArea(c)
        peri = _cv2.arcLength(c, True)
        circ = (4*3.14159*area)/(peri**2) if peri > 0 else 0
        print(f"  Screen-area contour: ({x},{y}) {cw}x{ch} area={area:.0f} circ={circ:.3f}")
