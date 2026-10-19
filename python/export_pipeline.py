"""Export pipeline for SynthSkin Studio.

Handles multi-scale asset export, JUCE-compatible packaging, SVG tracing,
sprite sheet generation, and structured folder output.
"""

import base64
import io
import math
import os
import re
import subprocess
import tempfile

import cv2
import numpy as np
from PIL import Image


# ─── Helpers ─────────────────────────────────────────────────

def _decode_image(image_b64: str) -> np.ndarray:
    """Decode base64 data-URL to BGRA numpy array."""
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    raw = base64.b64decode(image_b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    if len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def _encode_png_b64(img: np.ndarray) -> str:
    _, buf = cv2.imencode(".png", img)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _decode_to_bytes(image_b64: str) -> bytes:
    """Decode base64 data-URL to raw PNG bytes."""
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    return base64.b64decode(image_b64)


def _safe_name(name: str) -> str:
    """Convert a name to a safe filesystem/C++ identifier."""
    return re.sub(r'[^a-zA-Z0-9_]', '_', name).strip('_') or 'asset'


def _nearest_pow2(n: int) -> int:
    """Round up to nearest power of 2."""
    p = 1
    while p < n:
        p *= 2
    return p


# ─── Multi-scale Render ─────────────────────────────────────

def render_multi_scale(
    image_b64: str,
    base_width: int,
    base_height: int,
    scales: list[int],
) -> dict[str, str]:
    """Render an asset at multiple scales (1x, 2x, 3x, 4x).

    Returns {scale_label: base64_png, ...} e.g. {"1x": "data:...", "2x": "data:..."}
    Uses Lanczos resampling for high quality.
    """
    src = _decode_image(image_b64)
    result = {}
    for s in scales:
        w = base_width * s
        h = base_height * s
        if s == 1 and src.shape[1] == w and src.shape[0] == h:
            result[f"{s}x"] = _encode_png_b64(src)
        else:
            # Supersample at 2x then downsample for smoother result on upscales
            if s > 1:
                tw, th = w * 2, h * 2
                temp = cv2.resize(src, (tw, th), interpolation=cv2.INTER_LANCZOS4)
                final = cv2.resize(temp, (w, h), interpolation=cv2.INTER_AREA)
            else:
                final = cv2.resize(src, (w, h), interpolation=cv2.INTER_LANCZOS4)
            result[f"{s}x"] = _encode_png_b64(final)
    return result


# ─── SVG Tracing ────────────────────────────────────────────

def trace_to_svg(image_b64: str) -> str | None:
    """Attempt to convert a bitmap to SVG using potrace.

    Returns SVG string if potrace available, None otherwise.
    Works best for simple shapes / icons with clear edges.
    """
    try:
        src = _decode_image(image_b64)
        # Create a high-contrast mask from the alpha channel
        if src.shape[2] == 4:
            gray = src[:, :, 3]  # Use alpha as the shape
        else:
            gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)

        # Threshold to binary
        _, bw = cv2.threshold(gray, 128, 255, cv2.THRESH_BINARY)

        # Write BMP for potrace (it needs PBM/BMP input)
        pil_img = Image.fromarray(bw, mode="L")
        with tempfile.NamedTemporaryFile(suffix=".bmp", delete=False) as tmp_bmp:
            pil_img.save(tmp_bmp, format="BMP")
            bmp_path = tmp_bmp.name

        svg_path = bmp_path.replace(".bmp", ".svg")
        try:
            result = subprocess.run(
                ["potrace", bmp_path, "-s", "-o", svg_path],
                capture_output=True, timeout=10,
            )
            if result.returncode == 0 and os.path.exists(svg_path):
                with open(svg_path, "r") as f:
                    svg_content = f.read()
                return svg_content
        except FileNotFoundError:
            # potrace not installed
            return None
        except subprocess.TimeoutExpired:
            return None
        finally:
            for p in [bmp_path, svg_path]:
                if os.path.exists(p):
                    os.unlink(p)
    except Exception:
        return None


# ─── Power-of-2 Sprite Sheet ────────────────────────────────

def create_pow2_spritesheet(
    frames_b64: list[str],
    cols: int = 0,
) -> dict:
    """Create a sprite sheet with power-of-2 total dimensions.

    Pads the sheet to the next power-of-2 in both dimensions.
    Returns {dataUrl, cols, rows, frameWidth, frameHeight, sheetWidth, sheetHeight}.
    """
    if not frames_b64:
        raise ValueError("No frames")

    images = [_decode_image(f) for f in frames_b64]
    fh, fw = images[0].shape[:2]
    n = len(images)

    if cols <= 0:
        cols = max(1, int(math.ceil(math.sqrt(n))))
    rows = math.ceil(n / cols)

    raw_w = fw * cols
    raw_h = fh * rows
    sheet_w = _nearest_pow2(raw_w)
    sheet_h = _nearest_pow2(raw_h)

    sheet = np.zeros((sheet_h, sheet_w, 4), dtype=np.uint8)
    for i, img in enumerate(images):
        r, c = divmod(i, cols)
        resized = cv2.resize(img, (fw, fh), interpolation=cv2.INTER_LANCZOS4) \
            if img.shape[:2] != (fh, fw) else img
        sheet[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw] = resized

    return {
        "dataUrl": _encode_png_b64(sheet),
        "cols": cols,
        "rows": rows,
        "frameWidth": fw,
        "frameHeight": fh,
        "sheetWidth": sheet_w,
        "sheetHeight": sheet_h,
    }


# ─── JSON Atlas (TexturePacker-compatible) ──────────────────

def generate_atlas_json(
    asset_name: str,
    cols: int,
    rows: int,
    frame_width: int,
    frame_height: int,
    frame_count: int,
    sheet_width: int,
    sheet_height: int,
    image_filename: str,
) -> dict:
    """Generate a TexturePacker-compatible JSON atlas for a spritesheet."""
    frames = {}
    for i in range(frame_count):
        r, c = divmod(i, cols)
        frame_name = f"{asset_name}_frame_{i:04d}"
        frames[frame_name] = {
            "frame": {"x": c * frame_width, "y": r * frame_height,
                      "w": frame_width, "h": frame_height},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0,
                                 "w": frame_width, "h": frame_height},
            "sourceSize": {"w": frame_width, "h": frame_height},
        }

    return {
        "frames": frames,
        "meta": {
            "app": "SynthSkin Studio",
            "version": "1.0",
            "image": image_filename,
            "format": "RGBA8888",
            "size": {"w": sheet_width, "h": sheet_height},
            "scale": "1",
        },
    }


# ─── JUCE Snippet Generators ────────────────────────────────

def generate_juce_knob_snippet(
    asset_name: str,
    frame_size: int,
    frame_count: int,
) -> str:
    safe = _safe_name(asset_name)
    cls = safe[0].upper() + safe[1:] + "Knob"
    return f"""// Auto-generated by SynthSkin Studio
class {cls} : public juce::Slider {{
public:
    {cls}() {{
        filmstrip = juce::ImageCache::getFromMemory(
            BinaryData::{safe}_filmstrip_png,
            BinaryData::{safe}_filmstrip_pngSize);
        setSliderStyle(juce::Slider::RotaryHorizontalVerticalDrag);
        setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    }}

    void paint(juce::Graphics& g) override {{
        const int frameH = {frame_size};
        const int numFrames = {frame_count};
        auto range = getRange();
        auto norm = (getValue() - range.getStart()) / range.getLength();
        int frameIdx = juce::jlimit(0, numFrames - 1,
            (int)(norm * (numFrames - 1)));
        g.drawImage(filmstrip,
            0, 0, getWidth(), getHeight(),
            0, frameIdx * frameH, {frame_size}, frameH);
    }}

private:
    juce::Image filmstrip;
}};"""


def generate_juce_meter_snippet(
    asset_name: str,
    frame_width: int,
    frame_height: int,
    frame_count: int,
    meter_type: str,
) -> str:
    safe = _safe_name(asset_name)
    cls = safe[0].upper() + safe[1:] + "Meter"
    return f"""// Auto-generated by SynthSkin Studio — {meter_type} meter
class {cls} : public juce::Component {{
public:
    {cls}() {{
        filmstrip = juce::ImageCache::getFromMemory(
            BinaryData::{safe}_filmstrip_png,
            BinaryData::{safe}_filmstrip_pngSize);
    }}

    void setLevel(float normalised) {{
        level = juce::jlimit(0.0f, 1.0f, normalised);
        repaint();
    }}

    void paint(juce::Graphics& g) override {{
        const int frameW = {frame_width};
        const int frameH = {frame_height};
        const int numFrames = {frame_count};
        int frameIdx = juce::jlimit(0, numFrames - 1,
            (int)(level * (numFrames - 1)));
        g.drawImage(filmstrip,
            0, 0, getWidth(), getHeight(),
            0, frameIdx * frameH, frameW, frameH);
    }}

private:
    juce::Image filmstrip;
    float level = 0.0f;
}};"""


# ─── Full JUCE Export Package ────────────────────────────────

def build_juce_export_package(
    asset_name: str,
    asset_type: str,
    frames_b64: list[str],
    frame_width: int,
    frame_height: int,
    include_retina: bool = True,
    include_individual: bool = False,
    include_spritesheet: bool = False,
    include_svg: bool = False,
    pow2_spritesheet: bool = True,
) -> dict:
    """Build a complete JUCE export package as a dict of {relative_path: base64_content}.

    Returns { files: {path: base64_or_text}, metadata: {...} }
    All binary files are base64 without data-URL prefix.
    Text files (json, cpp) are plain strings.
    """
    safe = _safe_name(asset_name)
    files = {}
    n = len(frames_b64)

    # 1. Vertical filmstrip (JUCE standard)
    from animation import create_filmstrip
    filmstrip_b64 = create_filmstrip(frames_b64, "vertical")
    # Strip data-URL prefix for file saving
    filmstrip_raw = filmstrip_b64.split(",", 1)[1] if "," in filmstrip_b64 else filmstrip_b64
    files[f"{safe}/{safe}_filmstrip.png"] = {"type": "binary", "data": filmstrip_raw}

    # 2. @2x Retina filmstrip
    if include_retina and n > 0:
        # Re-decode frames and scale to 2x
        retina_frames = []
        for fb in frames_b64:
            img = _decode_image(fb)
            rw, rh = frame_width * 2, frame_height * 2
            up = cv2.resize(img, (rw * 2, rh * 2), interpolation=cv2.INTER_LANCZOS4)
            final = cv2.resize(up, (rw, rh), interpolation=cv2.INTER_AREA)
            retina_frames.append(_encode_png_b64(final))
        retina_strip = create_filmstrip(retina_frames, "vertical")
        retina_raw = retina_strip.split(",", 1)[1] if "," in retina_strip else retina_strip
        files[f"{safe}/{safe}_2x_filmstrip.png"] = {"type": "binary", "data": retina_raw}

    # 3. Individual frames
    if include_individual:
        for i, fb in enumerate(frames_b64):
            raw = fb.split(",", 1)[1] if "," in fb else fb
            files[f"{safe}/{safe}_frames/frame_{i:04d}.png"] = {"type": "binary", "data": raw}

    # 4. Sprite sheet
    if include_spritesheet:
        if pow2_spritesheet:
            sheet_info = create_pow2_spritesheet(frames_b64)
        else:
            from animation import create_spritesheet
            sheet_info = create_spritesheet(frames_b64)
            sheet_info["sheetWidth"] = sheet_info["frameWidth"] * sheet_info["cols"]
            sheet_info["sheetHeight"] = sheet_info["frameHeight"] * sheet_info["rows"]

        sheet_raw = sheet_info["dataUrl"].split(",", 1)[1]
        files[f"{safe}/{safe}_spritesheet.png"] = {"type": "binary", "data": sheet_raw}

        # JSON atlas
        atlas = generate_atlas_json(
            safe, sheet_info["cols"], sheet_info["rows"],
            sheet_info["frameWidth"], sheet_info["frameHeight"],
            n, sheet_info["sheetWidth"], sheet_info["sheetHeight"],
            f"{safe}_spritesheet.png",
        )
        import json
        files[f"{safe}/{safe}_spritesheet.json"] = {
            "type": "text",
            "data": json.dumps(atlas, indent=2),
        }

    # 5. SVG trace (if requested and potrace is available)
    if include_svg and n > 0:
        svg = trace_to_svg(frames_b64[0])
        if svg:
            files[f"{safe}/{safe}.svg"] = {"type": "text", "data": svg}

    # 6. JUCE C++ snippet
    if asset_type in ("knob", "button", "decoration"):
        snippet = generate_juce_knob_snippet(safe, frame_width, n)
    else:
        snippet = generate_juce_meter_snippet(
            safe, frame_width, frame_height, n, asset_type,
        )
    files[f"{safe}/{safe}_juce_snippet.cpp"] = {"type": "text", "data": snippet}

    # 7. Metadata JSON
    import json
    metadata = {
        "name": asset_name,
        "safeName": safe,
        "type": asset_type,
        "frameCount": n,
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "generator": "SynthSkin Studio",
        "version": "1.0",
    }
    files[f"{safe}/{safe}.json"] = {"type": "text", "data": json.dumps(metadata, indent=2)}

    return {"files": files, "metadata": metadata}


# ─── Multi-asset Sprite Sheet ────────────────────────────────

def pack_multi_asset_spritesheet(
    assets: list[dict],
    pow2: bool = True,
) -> dict:
    """Pack multiple single-frame assets into one sprite sheet.

    assets: [{name, image_b64, width, height}, ...]
    Returns {dataUrl, atlas: {...}, width, height}
    Uses simple row-based bin packing.
    """
    items = []
    for a in assets:
        img = _decode_image(a["image_b64"])
        w, h = a.get("width", img.shape[1]), a.get("height", img.shape[0])
        img_resized = cv2.resize(img, (w, h), interpolation=cv2.INTER_LANCZOS4) \
            if img.shape[:2] != (h, w) else img
        items.append({"name": a["name"], "img": img_resized, "w": w, "h": h})

    # Sort by height descending for better packing
    items.sort(key=lambda x: -x["h"])

    # Simple shelf-based packing
    max_width = max(it["w"] for it in items) * int(math.ceil(math.sqrt(len(items))))
    shelves = []  # [(y, height, current_x)]
    positions = {}

    for it in items:
        placed = False
        for shelf in shelves:
            if shelf[2] + it["w"] <= max_width:
                positions[it["name"]] = (shelf[2], shelf[0])
                shelf[2] += it["w"]
                placed = True
                break
        if not placed:
            y = sum(s[1] for s in shelves)
            shelves.append([y, it["h"], it["w"]])
            positions[it["name"]] = (0, y)

    total_w = max(pos[0] + next(it["w"] for it in items if it["name"] == name)
                  for name, pos in positions.items())
    total_h = sum(s[1] for s in shelves)

    if pow2:
        total_w = _nearest_pow2(total_w)
        total_h = _nearest_pow2(total_h)

    sheet = np.zeros((total_h, total_w, 4), dtype=np.uint8)
    atlas_frames = {}

    for it in items:
        x, y = positions[it["name"]]
        sheet[y:y + it["h"], x:x + it["w"]] = it["img"]
        atlas_frames[it["name"]] = {
            "frame": {"x": x, "y": y, "w": it["w"], "h": it["h"]},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": it["w"], "h": it["h"]},
            "sourceSize": {"w": it["w"], "h": it["h"]},
        }

    atlas = {
        "frames": atlas_frames,
        "meta": {
            "app": "SynthSkin Studio",
            "version": "1.0",
            "image": "spritesheet.png",
            "format": "RGBA8888",
            "size": {"w": total_w, "h": total_h},
            "scale": "1",
        },
    }

    return {
        "dataUrl": _encode_png_b64(sheet),
        "atlas": atlas,
        "width": total_w,
        "height": total_h,
    }
