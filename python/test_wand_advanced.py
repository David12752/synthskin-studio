import numpy as np, cv2, base64
from extraction import magic_wand

# Complex image: gradient background + various elements
img = np.zeros((500, 700, 3), dtype=np.uint8)

# Gradient background
for y in range(500):
    for x in range(700):
        img[y, x] = (30 + int(20 * y / 500), 25 + int(15 * x / 700), 35 + int(10 * y / 500))

# Knob with metallic gradient
for r in range(60, 0, -1):
    b = 80 + int(150 * (60 - r) / 60)
    cv2.circle(img, (200, 200), r, (b - 30, b, b + 20), -1)

# Ring knob (hollow center)
cv2.circle(img, (450, 200), 55, (140, 100, 60), -1)
cv2.circle(img, (450, 200), 40, (40, 35, 45), -1)
cv2.circle(img, (450, 200), 5, (200, 160, 100), -1)

# Small LED
cv2.circle(img, (350, 350), 8, (50, 200, 50), -1)

# Rectangular display
cv2.rectangle(img, (100, 380), (280, 440), (20, 60, 80), -1)
cv2.rectangle(img, (100, 380), (280, 440), (40, 100, 140), 2)

_, buf = cv2.imencode(".png", img)
b64 = "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()

# Test: metallic knob with different edge sensitivities
r1 = magic_wand(b64, 200, 200, tolerance=35, mode="element", edge_sensitivity=0.5)
print("Metal knob (sens=0.5):", r1["bounds"])

r2 = magic_wand(b64, 200, 200, tolerance=35, mode="element", edge_sensitivity=1.5)
print("Metal knob (sens=1.5):", r2["bounds"])

# Test: ring knob
r3 = magic_wand(b64, 450, 200, tolerance=35, mode="element")
print("Ring knob (element):", r3["bounds"])

r4 = magic_wand(b64, 450, 200, tolerance=35, mode="invert")
print("Ring knob (invert):", r4["bounds"])

# Test: small LED (should still detect despite small size)
r5 = magic_wand(b64, 350, 350, tolerance=35, mode="element")
print("LED (element):", r5["bounds"])

# Test: rectangular display
r6 = magic_wand(b64, 190, 410, tolerance=35, mode="element")
print("Display (element):", r6["bounds"])

# Test: refine_edges flag
r7 = magic_wand(b64, 200, 200, tolerance=35, mode="element", refine_edges=True)
r8 = magic_wand(b64, 200, 200, tolerance=35, mode="element", refine_edges=False)
print("Metal knob refined:", r7["bounds"])
print("Metal knob raw:", r8["bounds"])

print("\nAdvanced test OK")
