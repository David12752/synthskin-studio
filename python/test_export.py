"""Quick integration test for export_pipeline.py"""
import numpy as np, cv2, base64, json

def make_img(w=64, h=64, c=(0,128,255,255)):
    img = np.zeros((h,w,4), dtype=np.uint8)
    cv2.circle(img, (w//2,h//2), min(w,h)//2-2, c, -1)
    _, buf = cv2.imencode('.png', img)
    return 'data:image/png;base64,' + base64.b64encode(buf.tobytes()).decode()

img = make_img()

# Test 1: Multi-scale render
from export_pipeline import render_multi_scale
scales = render_multi_scale(img, 64, 64, [1, 2])
print("Multi-scale:", list(scales.keys()))
assert "1x" in scales and "2x" in scales

# Test 2: SVG trace
from export_pipeline import trace_to_svg
svg = trace_to_svg(img)
print("SVG trace available:", svg is not None)

# Test 3: Pow2 spritesheet
from export_pipeline import create_pow2_spritesheet
frames = [make_img() for _ in range(9)]
sheet = create_pow2_spritesheet(frames)
print(f"Pow2 sheet: {sheet['sheetWidth']}x{sheet['sheetHeight']}, {sheet['cols']}x{sheet['rows']}")
assert sheet["sheetWidth"] & (sheet["sheetWidth"]-1) == 0  # power of 2
assert sheet["sheetHeight"] & (sheet["sheetHeight"]-1) == 0

# Test 4: Full JUCE export package
from export_pipeline import build_juce_export_package
pkg = build_juce_export_package(
    'test_knob', 'knob', frames[:4], 64, 64,
    include_retina=True, include_individual=True,
    include_spritesheet=True, include_svg=False,
)
print(f"JUCE package files ({len(pkg['files'])}):")
for path, entry in sorted(pkg['files'].items()):
    size = len(entry['data'])
    print(f"  {path} [{entry['type']}] {size} chars")

assert any("filmstrip" in p for p in pkg['files'])
assert any(".cpp" in p for p in pkg['files'])
assert any(p.endswith(".json") and "spritesheet" not in p for p in pkg['files'])

# Test 5: Atlas JSON
from export_pipeline import generate_atlas_json
atlas = generate_atlas_json('test', 3, 3, 64, 64, 9, 256, 256, 'test.png')
print(f"Atlas frames: {len(atlas['frames'])} entries")
assert len(atlas['frames']) == 9

# Test 6: Multi-asset sheet
from export_pipeline import pack_multi_asset_spritesheet
assets = [{"name": f"asset_{i}", "image_b64": make_img(32, 32)} for i in range(6)]
mas = pack_multi_asset_spritesheet(assets, pow2=True)
print(f"Multi-asset sheet: {mas['width']}x{mas['height']}, {len(mas['atlas']['frames'])} entries")

print("\nALL EXPORT TESTS PASSED")
