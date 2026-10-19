import numpy as np, cv2, base64
from extraction import magic_wand

# Create a more complex synthetic image: dark background with multiple UI elements
img = np.zeros((400, 600, 3), dtype=np.uint8)
img[:] = (35, 35, 40)  # dark panel bg

# Knob 1 (large, gradient)
for r in range(50, 0, -1):
    brightness = 100 + int(100 * (50 - r) / 50)
    cv2.circle(img, (150, 150), r, (brightness, brightness - 10, brightness - 20), -1)

# Knob 2 (small)
for r in range(30, 0, -1):
    brightness = 80 + int(120 * (30 - r) / 30)
    cv2.circle(img, (300, 150), r, (brightness - 20, brightness, brightness - 10), -1)

# Rectangle button
cv2.rectangle(img, (420, 120), (540, 180), (60, 120, 60), -1)
cv2.rectangle(img, (420, 120), (540, 180), (80, 160, 80), 2)

# Slider track + thumb
cv2.rectangle(img, (100, 280), (500, 290), (60, 60, 65), -1)
cv2.circle(img, (300, 285), 15, (170, 140, 80), -1)

# Encode to base64
_, buf = cv2.imencode('.png', img)
b64 = 'data:image/png;base64,' + base64.b64encode(buf.tobytes()).decode()

# Test: click on knob 1 center
r1 = magic_wand(b64, 150, 150, tolerance=40, mode='element')
print(f"Knob 1 (element): bounds={r1['bounds']}")

# Test: click on knob 2
r2 = magic_wand(b64, 300, 150, tolerance=40, mode='element')
print(f"Knob 2 (element): bounds={r2['bounds']}")

# Test: click on button
r3 = magic_wand(b64, 480, 150, tolerance=40, mode='element')
print(f"Button (element): bounds={r3['bounds']}")

# Test: invert mode on knob 1
r4 = magic_wand(b64, 150, 150, tolerance=40, mode='invert')
print(f"Knob 1 (invert): bounds={r4['bounds']}")

print("Multi-element test OK")
