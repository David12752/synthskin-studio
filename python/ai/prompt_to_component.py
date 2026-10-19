"""
5.7 Prompt-to-Component — Generate components from text descriptions.

Provides a pipeline for text-to-component generation:
1. Generate image from text (via external API or local Stable Diffusion)
2. Remove background
3. Center and crop
4. Apply symmetry enforcement
5. Return as library-ready component

Uses rembg for background removal (included in requirements).
Image generation requires either a local SD model or an API key.
"""
import base64
import io
import math

import cv2
import numpy as np
from PIL import Image

# Style presets for constraining generation output
GENERATION_PRESETS = {
    "vintage": {
        "name": "Vintage Analog",
        "negative_prompt": "digital, modern, flat, minimal, neon",
        "style_prompt": "vintage analog audio equipment, warm tones, brushed metal, retro 1970s design",
    },
    "modern": {
        "name": "Modern Digital",
        "negative_prompt": "vintage, old, rusty, dirty, worn",
        "style_prompt": "modern sleek digital audio equipment, clean lines, minimal design, dark theme",
    },
    "eurorack": {
        "name": "Eurorack Module",
        "negative_prompt": "large, vintage, wooden, colorful",
        "style_prompt": "eurorack modular synthesizer component, black aluminum panel, minimalist",
    },
    "minimal": {
        "name": "Minimal Clean",
        "negative_prompt": "ornate, detailed, realistic, vintage, metal texture",
        "style_prompt": "flat minimal UI component, simple geometric shape, clean design",
    },
}


def _b64_to_cv(data_url: str) -> np.ndarray:
    header, data = data_url.split(",", 1)
    raw = base64.b64decode(data)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def _cv_to_b64(img: np.ndarray) -> str:
    _, buf = cv2.imencode(".png", img)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _pil_to_b64(pil_img: Image.Image) -> str:
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def check_rembg_available() -> bool:
    """Check if rembg is available for background removal."""
    try:
        import rembg  # noqa: F401
        return True
    except ImportError:
        return False


def check_sd_available() -> bool:
    """Check if Stable Diffusion is available locally."""
    try:
        import torch  # noqa: F401
        from diffusers import StableDiffusionPipeline  # noqa: F401
        return True
    except ImportError:
        return False


def remove_background(image_b64: str) -> dict:
    """
    Remove background from an image.

    Uses rembg if available, otherwise uses simple color-based removal.

    Returns: {dataUrl, method}
    """
    if check_rembg_available():
        import rembg
        # Decode
        header, data = image_b64.split(",", 1)
        raw = base64.b64decode(data)
        # Process
        output = rembg.remove(raw)
        pil_img = Image.open(io.BytesIO(output)).convert("RGBA")
        return {
            "dataUrl": _pil_to_b64(pil_img),
            "method": "rembg",
        }
    else:
        # Fallback: simple background removal using edge detection + flood fill
        img = _b64_to_cv(image_b64)
        h, w = img.shape[:2]

        gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)
        # Otsu threshold to find foreground
        _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

        # Morphological operations to clean up
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=1)

        # Apply as alpha
        result = img.copy()
        result[:, :, 3] = thresh

        return {
            "dataUrl": _cv_to_b64(result),
            "method": "threshold",
        }


def center_and_crop(image_b64: str, padding: int = 8) -> dict:
    """
    Center component and crop to tight bounds with padding.

    Returns: {dataUrl, bounds}
    """
    img = _b64_to_cv(image_b64)
    alpha = img[:, :, 3]

    # Find bounding box of non-transparent pixels
    rows = np.any(alpha > 10, axis=1)
    cols = np.any(alpha > 10, axis=0)

    if not rows.any() or not cols.any():
        return {"dataUrl": image_b64, "bounds": {"x": 0, "y": 0, "width": 0, "height": 0}}

    y0, y1 = np.where(rows)[0][[0, -1]]
    x0, x1 = np.where(cols)[0][[0, -1]]

    # Add padding
    h, w = img.shape[:2]
    y0 = max(0, y0 - padding)
    x0 = max(0, x0 - padding)
    y1 = min(h - 1, y1 + padding)
    x1 = min(w - 1, x1 + padding)

    cropped = img[y0:y1 + 1, x0:x1 + 1]

    # Make square (pad shorter dimension)
    ch, cw = cropped.shape[:2]
    size = max(ch, cw)
    square = np.zeros((size, size, 4), dtype=np.uint8)
    yoff = (size - ch) // 2
    xoff = (size - cw) // 2
    square[yoff:yoff + ch, xoff:xoff + cw] = cropped

    return {
        "dataUrl": _cv_to_b64(square),
        "bounds": {"x": int(x0), "y": int(y0), "width": int(x1 - x0 + 1), "height": int(y1 - y0 + 1)},
    }


def generate_component(
    prompt: str,
    component_type: str = "knob",
    style_preset: str = "modern",
    size: int = 512,
) -> dict:
    """
    Generate a component from a text prompt.

    If Stable Diffusion is not available, returns a placeholder with instructions.

    Returns: {dataUrl, prompt, method, available}
    """
    preset = GENERATION_PRESETS.get(style_preset, GENERATION_PRESETS["modern"])

    full_prompt = f"{prompt}, {preset['style_prompt']}, isolated on white background, product photography, studio lighting"

    if check_sd_available():
        import torch
        from diffusers import StableDiffusionPipeline

        pipe = StableDiffusionPipeline.from_pretrained(
            "stabilityai/stable-diffusion-2-1",
            torch_dtype=torch.float16,
        )
        pipe = pipe.to("cuda" if torch.cuda.is_available() else "cpu")

        image = pipe(
            prompt=full_prompt,
            negative_prompt=preset["negative_prompt"],
            width=size,
            height=size,
            num_inference_steps=30,
            guidance_scale=7.5,
        ).images[0]

        b64 = _pil_to_b64(image)

        # Post-process: remove background and center
        bg_removed = remove_background(b64)
        centered = center_and_crop(bg_removed["dataUrl"])

        return {
            "dataUrl": centered["dataUrl"],
            "prompt": prompt,
            "full_prompt": full_prompt,
            "method": "stable-diffusion",
            "available": True,
        }
    else:
        # Generate a placeholder (colored circle with label)
        img = np.zeros((size, size, 4), dtype=np.uint8)

        # Type-specific placeholder
        colors = {
            "knob": (100, 130, 160),
            "button": (160, 100, 100),
            "slider": (100, 160, 100),
            "screen": (80, 100, 140),
            "led": (60, 180, 200),
        }
        color = colors.get(component_type, (120, 120, 120))

        center = size // 2
        r = size // 3

        if component_type == "knob":
            cv2.circle(img, (center, center), r, (*color, 255), -1)
            cv2.circle(img, (center, center), r, (200, 200, 200, 255), 2)
            # Indicator line
            cv2.line(img, (center, center), (center, center - r + 10), (255, 255, 255, 255), 2)
        elif component_type == "slider":
            x0 = center - size // 8
            y0 = size // 6
            cv2.rectangle(img, (x0, y0), (x0 + size // 4, size - y0), (*color, 255), -1)
            cv2.rectangle(img, (x0, y0), (x0 + size // 4, size - y0), (200, 200, 200, 255), 2)
        elif component_type == "button":
            cv2.circle(img, (center, center), r // 2, (*color, 255), -1)
            cv2.circle(img, (center, center), r // 2, (200, 200, 200, 255), 2)
        elif component_type == "screen":
            x0, y0 = size // 4, size // 3
            cv2.rectangle(img, (x0, y0), (size - x0, size - y0), (*color, 255), -1)
            cv2.rectangle(img, (x0, y0), (size - x0, size - y0), (200, 200, 200, 255), 2)
        else:
            cv2.circle(img, (center, center), r, (*color, 255), -1)

        # Add text label
        font = cv2.FONT_HERSHEY_SIMPLEX
        text = f"[{component_type}]"
        text_size = cv2.getTextSize(text, font, 0.5, 1)[0]
        tx = center - text_size[0] // 2
        ty = center + text_size[1] // 2
        cv2.putText(img, text, (tx, ty), font, 0.5, (255, 255, 255, 255), 1)

        return {
            "dataUrl": _cv_to_b64(img),
            "prompt": prompt,
            "full_prompt": full_prompt,
            "method": "placeholder",
            "available": False,
            "install_hint": "Install diffusers + torch for AI generation: pip install diffusers torch transformers",
        }


def get_generation_presets() -> list:
    """Return available generation style presets."""
    return [{"id": k, "name": v["name"]} for k, v in GENERATION_PRESETS.items()]
