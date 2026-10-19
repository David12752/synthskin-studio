"""Test animation generation."""
import numpy as np
import cv2
import base64
from animation import generate_rotation_frames, generate_indicator_frames, create_filmstrip, create_spritesheet

# Create a test knob image with pointer
img = np.zeros((200, 200, 4), dtype=np.uint8)
for r in range(80, 0, -1):
    b = int(80 + 175 * (80 - r) / 80)
    cv2.circle(img, (100, 100), r, (b - 30, b, b + 20, 255), -1)
# Pointer line
cv2.line(img, (100, 100), (100, 30), (255, 255, 255, 255), 3, cv2.LINE_AA)

_, buf = cv2.imencode(".png", img)
b64 = "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()

# Test simple rotation
frames = generate_rotation_frames(b64, 100, 100, -135, 135, 8, 128)
print("Simple rotation:", len(frames), "frames")
assert len(frames) == 8
assert all(f.startswith("data:image/png;base64,") for f in frames)

# Test indicator mode
frames2 = generate_indicator_frames(b64, 100, 100, -135, 135, 8, 128, 0, 40, 3, (255, 255, 255))
print("Indicator:", len(frames2), "frames")
assert len(frames2) == 8

# Test filmstrip
strip = create_filmstrip(frames, "vertical")
print("Filmstrip OK, length:", len(strip))

# Test spritesheet
sheet = create_spritesheet(frames)
print("Spritesheet: cols=%d, rows=%d, fw=%d, fh=%d" % (sheet["cols"], sheet["rows"], sheet["frameWidth"], sheet["frameHeight"]))

# Test 128 frames (JUCE standard)
frames128 = generate_rotation_frames(b64, 100, 100, -135, 135, 128, 256)
print("128-frame set:", len(frames128), "frames at 256x256")

strip128 = create_filmstrip(frames128, "vertical")
# Decode to check dimensions
strip_data = strip128.split(",", 1)[1]
strip_arr = np.frombuffer(base64.b64decode(strip_data), dtype=np.uint8)
strip_img = cv2.imdecode(strip_arr, cv2.IMREAD_UNCHANGED)
print("128-frame filmstrip dimensions:", strip_img.shape)  # Should be (256*128, 256, 4)

# Server import check
from server import app
print("Server imports OK")

print("\nAll animation tests passed!")
