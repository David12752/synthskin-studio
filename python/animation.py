"""Knob rotation and animation frame generation for SynthSkin Studio.

Generates high-quality rotation sequences with Lanczos resampling,
sub-pixel rotation, and 2x supersampling for anti-aliased output.
"""

import io
import base64
import math

import cv2
import numpy as np
from PIL import Image


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
    """Encode BGRA numpy to data:image/png;base64,... string."""
    _, buf = cv2.imencode(".png", img)
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def generate_rotation_frames(
    image_b64: str,
    center_x: float,
    center_y: float,
    start_angle: float,
    end_angle: float,
    frame_count: int,
    output_size: int,
) -> list[str]:
    """Generate rotation frames using 2x supersampling + Lanczos.

    Returns list of base64 PNG data-URLs, one per frame.
    Sub-pixel rotation with anti-aliased edges.
    """
    src = _decode_image(image_b64)
    ih, iw = src.shape[:2]

    # Work at 2x resolution for anti-aliasing
    supersample = 2
    work_size = output_size * supersample

    # Compute the angle step
    if frame_count <= 1:
        angles = [start_angle]
    else:
        angles = [
            start_angle + (end_angle - start_angle) * i / (frame_count - 1)
            for i in range(frame_count)
        ]

    frames = []
    for angle in angles:
        # Build rotation matrix centered at the knob center
        M = cv2.getRotationMatrix2D((float(center_x), float(center_y)), -angle, 1.0)

        # Rotate at original resolution with proper border handling
        rotated = cv2.warpAffine(
            src, M, (iw, ih),
            flags=cv2.INTER_LANCZOS4,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0, 0),
        )

        # Crop a square region centered at the center point
        half = max(iw, ih) // 2 + 1
        x1 = max(0, int(center_x) - half)
        y1 = max(0, int(center_y) - half)
        x2 = min(iw, int(center_x) + half)
        y2 = min(ih, int(center_y) + half)
        cropped = rotated[y1:y2, x1:x2]

        # Resize to work_size (2x), then to output_size (final)
        if cropped.shape[0] > 0 and cropped.shape[1] > 0:
            resized = cv2.resize(cropped, (work_size, work_size), interpolation=cv2.INTER_LANCZOS4)
            final = cv2.resize(resized, (output_size, output_size), interpolation=cv2.INTER_AREA)
        else:
            final = np.zeros((output_size, output_size, 4), dtype=np.uint8)

        frames.append(_encode_png_b64(final))

    return frames


def generate_indicator_frames(
    image_b64: str,
    center_x: float,
    center_y: float,
    start_angle: float,
    end_angle: float,
    frame_count: int,
    output_size: int,
    indicator_angle: float,
    indicator_length: float,
    indicator_width: int,
    indicator_color: tuple[int, int, int],
) -> list[str]:
    """Generate frames with static knob body + rotating indicator overlay.

    The knob body stays fixed; only the indicator line rotates.
    """
    src = _decode_image(image_b64)
    ih, iw = src.shape[:2]

    # Prepare the base knob (no rotation, just centered+cropped)
    supersample = 2
    work_size = output_size * supersample

    half = max(iw, ih) // 2 + 1
    x1 = max(0, int(center_x) - half)
    y1 = max(0, int(center_y) - half)
    x2 = min(iw, int(center_x) + half)
    y2 = min(ih, int(center_y) + half)
    base_crop = src[y1:y2, x1:x2].copy()

    if base_crop.shape[0] == 0 or base_crop.shape[1] == 0:
        return [_encode_png_b64(np.zeros((output_size, output_size, 4), dtype=np.uint8))] * frame_count

    base_resized = cv2.resize(base_crop, (work_size, work_size), interpolation=cv2.INTER_LANCZOS4)

    # Center of the indicator in the work image
    local_cx = work_size / 2
    local_cy = work_size / 2

    if frame_count <= 1:
        angles = [start_angle]
    else:
        angles = [
            start_angle + (end_angle - start_angle) * i / (frame_count - 1)
            for i in range(frame_count)
        ]

    scaled_length = indicator_length * supersample
    scaled_width = max(1, indicator_width * supersample)
    color_bgra = (indicator_color[0], indicator_color[1], indicator_color[2], 255)

    frames = []
    for angle in angles:
        frame = base_resized.copy()

        # Compute indicator endpoint
        # angle=0 means pointing up (12 o'clock), positive = clockwise
        total_angle = indicator_angle + angle
        rad = math.radians(total_angle - 90)  # -90 to make 0° = up
        end_x = int(local_cx + scaled_length * math.cos(rad))
        end_y = int(local_cy + scaled_length * math.sin(rad))

        # Draw the indicator line with anti-aliasing
        cv2.line(frame, (int(local_cx), int(local_cy)), (end_x, end_y),
                 color_bgra, scaled_width, cv2.LINE_AA)

        # Small center dot
        cv2.circle(frame, (int(local_cx), int(local_cy)),
                   max(1, scaled_width), color_bgra, -1, cv2.LINE_AA)

        # Downsample to output
        final = cv2.resize(frame, (output_size, output_size), interpolation=cv2.INTER_AREA)
        frames.append(_encode_png_b64(final))

    return frames


def create_filmstrip(frames_b64: list[str], orientation: str = "vertical") -> str:
    """Combine frame images into a single filmstrip image.

    orientation: "vertical" (JUCE standard) or "horizontal"
    Returns data:image/png;base64 string.
    """
    if not frames_b64:
        raise ValueError("No frames to combine")

    # Decode all frames
    images = []
    for f in frames_b64:
        images.append(_decode_image(f))

    h, w = images[0].shape[:2]
    n = len(images)

    if orientation == "vertical":
        strip = np.zeros((h * n, w, 4), dtype=np.uint8)
        for i, img in enumerate(images):
            resized = cv2.resize(img, (w, h), interpolation=cv2.INTER_LANCZOS4) if img.shape[:2] != (h, w) else img
            strip[i * h:(i + 1) * h, :] = resized
    else:
        strip = np.zeros((h, w * n, 4), dtype=np.uint8)
        for i, img in enumerate(images):
            resized = cv2.resize(img, (w, h), interpolation=cv2.INTER_LANCZOS4) if img.shape[:2] != (h, w) else img
            strip[:, i * w:(i + 1) * w] = resized

    return _encode_png_b64(strip)


def create_spritesheet(frames_b64: list[str], cols: int = 0) -> dict:
    """Bin-pack frames into a grid sprite sheet.

    Returns { dataUrl, cols, rows, frameWidth, frameHeight }.
    If cols=0, auto-calculate for roughly square sheet.
    """
    if not frames_b64:
        raise ValueError("No frames")

    images = [_decode_image(f) for f in frames_b64]
    fh, fw = images[0].shape[:2]
    n = len(images)

    if cols <= 0:
        cols = max(1, int(math.ceil(math.sqrt(n))))
    rows = math.ceil(n / cols)

    sheet = np.zeros((fh * rows, fw * cols, 4), dtype=np.uint8)
    for i, img in enumerate(images):
        r, c = divmod(i, cols)
        resized = cv2.resize(img, (fw, fh), interpolation=cv2.INTER_LANCZOS4) if img.shape[:2] != (fh, fw) else img
        sheet[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw] = resized

    return {
        "dataUrl": _encode_png_b64(sheet),
        "cols": cols,
        "rows": rows,
        "frameWidth": fw,
        "frameHeight": fh,
    }
