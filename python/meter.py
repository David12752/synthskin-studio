"""Meter animation generation for SynthSkin Studio.

Three meter modes:
  - needle: rotating needle over face background, with optional motion blur
  - led_bar:  progressive segment illumination (green→yellow→red gradient)
  - screen:   static asset tagged as a dynamic placeholder (no frames generated)
"""

import base64
import math

import cv2
import numpy as np


def _decode_image(image_b64: str) -> np.ndarray:
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


def _composite_alpha(bg: np.ndarray, fg: np.ndarray) -> np.ndarray:
    """Alpha-composite fg over bg, both BGRA. Returns BGRA."""
    bg_f = bg.astype(np.float32) / 255.0
    fg_f = fg.astype(np.float32) / 255.0

    alpha_fg = fg_f[:, :, 3:4]
    alpha_bg = bg_f[:, :, 3:4]

    rgb_out = fg_f[:, :, :3] * alpha_fg + bg_f[:, :, :3] * alpha_bg * (1.0 - alpha_fg)
    alpha_out = alpha_fg + alpha_bg * (1.0 - alpha_fg)

    out = np.zeros_like(bg_f)
    out[:, :, :3] = np.where(alpha_out > 0, rgb_out / np.maximum(alpha_out, 1e-6), 0)
    out[:, :, 3] = alpha_out[:, :, 0]

    return (np.clip(out, 0, 1) * 255).astype(np.uint8)


# ─── Needle Meter ───

def generate_needle_frames(
    face_b64: str,
    needle_b64: str,
    pivot_x: float,
    pivot_y: float,
    rest_angle: float,
    full_scale_angle: float,
    frame_count: int,
    output_width: int,
    output_height: int,
    motion_blur: bool = False,
    motion_blur_samples: int = 5,
) -> list[str]:
    """Generate meter needle animation frames.

    Face background stays static. Needle rotates from rest_angle to full_scale_angle.
    If motion_blur=True, blends several sub-frames per angle step for a swept effect.

    Args:
        pivot_x/y: needle pivot point in face image pixel coordinates
        rest_angle: angle in degrees when meter reads 0 (e.g. -50 = 50° left of top)
        full_scale_angle: angle at max reading (e.g. +50 = 50° right of top)
        output_width/height: output frame dimensions
    """
    face = _decode_image(face_b64)
    needle = _decode_image(needle_b64)
    fh, fw = face.shape[:2]
    nh, nw = needle.shape[:2]

    # Scale face to output size
    scale_x = output_width / fw
    scale_y = output_height / fh
    face_scaled = cv2.resize(face, (output_width, output_height), interpolation=cv2.INTER_LANCZOS4)
    pivot_xs = pivot_x * scale_x
    pivot_ys = pivot_y * scale_y

    # Pre-scale needle (2x for anti-aliasing, then downscale)
    ss = 2
    needle_ss = cv2.resize(needle, (nw * ss, nh * ss), interpolation=cv2.INTER_LANCZOS4)

    if frame_count <= 1:
        angles = [rest_angle]
    else:
        angles = [
            rest_angle + (full_scale_angle - rest_angle) * i / (frame_count - 1)
            for i in range(frame_count)
        ]

    frames = []
    for i, angle in enumerate(angles):
        if motion_blur and i > 0:
            # Blend motion_blur_samples sub-frames between previous and current angle
            prev_angle = angles[i - 1]
            accum = np.zeros((output_height, output_width, 4), dtype=np.float64)
            for s in range(motion_blur_samples):
                t = s / (motion_blur_samples - 1) if motion_blur_samples > 1 else 1.0
                sub_angle = prev_angle + (angle - prev_angle) * t
                sub_frame = _composite_needle(face_scaled, needle_ss, pivot_xs, pivot_ys, sub_angle, output_width, output_height, ss)
                accum += sub_frame.astype(np.float64)
            frame = (accum / motion_blur_samples).astype(np.uint8)
        else:
            frame = _composite_needle(face_scaled, needle_ss, pivot_xs, pivot_ys, angle, output_width, output_height, ss)

        frames.append(_encode_png_b64(frame))

    return frames


def _composite_needle(
    face: np.ndarray,
    needle_ss: np.ndarray,
    pivot_x: float, pivot_y: float,
    angle: float,
    out_w: int, out_h: int,
    ss: int,
) -> np.ndarray:
    """Rotate needle around pivot and composite over face."""
    nh_ss, nw_ss = needle_ss.shape[:2]

    # Rotate needle at 2x around its own center (convention: needle points up in source)
    center_ss = (nw_ss / 2.0, nh_ss / 2.0)
    M = cv2.getRotationMatrix2D(center_ss, -angle, 1.0)
    rotated_ss = cv2.warpAffine(
        needle_ss, M, (nw_ss, nh_ss),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )

    # Downsample needle back to 1x
    needle_1x = cv2.resize(rotated_ss, (nw_ss // ss, nh_ss // ss), interpolation=cv2.INTER_AREA)
    nh1, nw1 = needle_1x.shape[:2]

    # Place needle: align needle center to pivot point
    canvas = face.copy()
    nx = int(pivot_x - nw1 / 2)
    ny = int(pivot_y - nh1 / 2)

    # Compute overlap region
    cx1 = max(0, nx)
    cy1 = max(0, ny)
    cx2 = min(out_w, nx + nw1)
    cy2 = min(out_h, ny + nh1)

    if cx2 <= cx1 or cy2 <= cy1:
        return canvas

    nx1 = cx1 - nx
    ny1 = cy1 - ny
    nx2 = nx1 + (cx2 - cx1)
    ny2 = ny1 + (cy2 - cy1)

    roi_bg = canvas[cy1:cy2, cx1:cx2].copy()
    roi_fg = needle_1x[ny1:ny2, nx1:nx2].copy()

    canvas[cy1:cy2, cx1:cx2] = _composite_alpha(roi_bg, roi_fg)
    return canvas


# ─── LED Bar Meter ───

def generate_led_bar_frames(
    off_state_b64: str,
    on_state_b64: str,
    segment_count: int,
    orientation: str,
    frame_count: int,
    output_width: int,
    output_height: int,
    gradient_colors: list[tuple[int, int, int]],
    gap_fraction: float = 0.05,
) -> list[str]:
    """Generate LED bar meter frames.

    Each frame shows a different number of lit segments (0 to segment_count).
    Supports gradient colors: pass 2+ colors that map across the segments.
    gap_fraction: proportion of each segment taken by the inter-segment gap.

    Args:
        off_state_b64: image of the full bar in 'off' state (BGRA)
        on_state_b64:  image of the full bar in 'on' state (BGRA)
        gradient_colors: list of BGR(A) tuples for coloring segments,
                         e.g. [(0,200,0), (0,200,200), (0,0,220)] = green→yellow→red
        gap_fraction: fraction 0-1 of segment width/height used as gap
    """
    off_img = _decode_image(off_state_b64)
    on_img = _decode_image(on_state_b64)

    # Scale to output
    off_scaled = cv2.resize(off_img, (output_width, output_height), interpolation=cv2.INTER_LANCZOS4)
    on_scaled = cv2.resize(on_img, (output_width, output_height), interpolation=cv2.INTER_LANCZOS4)

    is_vertical = orientation == "vertical"
    bar_length = output_height if is_vertical else output_width
    bar_cross = output_width if is_vertical else output_height

    seg_size = bar_length / segment_count
    gap_px = int(seg_size * gap_fraction)

    # Pre-compute per-segment gradient color overlay
    seg_tints = _compute_gradient_tints(segment_count, gradient_colors)

    frames = []
    for frame_idx in range(frame_count):
        # How many segments lit (0 to segment_count)
        if frame_count <= 1:
            lit = segment_count
        else:
            lit = int(round(segment_count * frame_idx / (frame_count - 1)))
        lit = max(0, min(segment_count, lit))

        frame = off_scaled.copy()

        for s in range(lit):
            if is_vertical:
                # Segments stack from bottom to top
                y_end = output_height - int(s * seg_size)
                y_start = y_end - int(seg_size - gap_px)
                y_start = max(0, y_start)
                y_end = min(output_height, y_end)
                if y_end <= y_start:
                    continue
                # Composite on_img slice for this segment
                seg_on = on_scaled[y_start:y_end, :].copy()
                tint = seg_tints[s]
                seg_lit = _apply_tint(seg_on, tint)
                frame[y_start:y_end, :] = _composite_alpha(frame[y_start:y_end, :], seg_lit)
            else:
                # Segments run left to right
                x_start = int(s * seg_size)
                x_end = x_start + int(seg_size - gap_px)
                x_end = min(output_width, x_end)
                if x_end <= x_start:
                    continue
                seg_on = on_scaled[:, x_start:x_end].copy()
                tint = seg_tints[s]
                seg_lit = _apply_tint(seg_on, tint)
                frame[:, x_start:x_end] = _composite_alpha(frame[:, x_start:x_end], seg_lit)

        frames.append(_encode_png_b64(frame))

    return frames


def _compute_gradient_tints(
    segment_count: int,
    gradient_colors: list[tuple],
) -> list[tuple[float, float, float]]:
    """Interpolate gradient_colors across segment_count steps.
    Returns list of BGR float tuples (0-255).
    """
    if not gradient_colors:
        return [(255.0, 255.0, 255.0)] * segment_count

    tints = []
    for s in range(segment_count):
        t = s / max(1, segment_count - 1)
        # Map t into the gradient_colors list
        n = len(gradient_colors) - 1
        seg = t * n
        lo = int(seg)
        hi = min(lo + 1, n)
        frac = seg - lo
        c0 = gradient_colors[lo]
        c1 = gradient_colors[hi]
        # Lerp
        b = c0[0] + (c1[0] - c0[0]) * frac
        g = c0[1] + (c1[1] - c0[1]) * frac
        r = c0[2] + (c1[2] - c0[2]) * frac
        tints.append((b, g, r))

    return tints


def _apply_tint(img: np.ndarray, tint: tuple[float, float, float]) -> np.ndarray:
    """Multiply non-transparent pixels by tint color. Returns BGRA."""
    out = img.copy().astype(np.float32)
    alpha = out[:, :, 3:4] / 255.0

    # Normalise existing image color then apply tint
    # Simple multiply blend: img_color * tint / 255
    for c, tc in enumerate(tint[:3]):
        out[:, :, c] = out[:, :, c] * (tc / 255.0)

    out[:, :, :3] = np.clip(out[:, :, :3], 0, 255)
    return out.astype(np.uint8)


# ─── Screen / Dynamic Region ───

def generate_screen_placeholder(
    screen_b64: str,
    output_width: int,
    output_height: int,
) -> dict:
    """Process a screen/display asset to mark it as a dynamic placeholder.

    Returns a single base64 PNG with a subtle 'DYNAMIC' overlay grid pattern
    that indicates to JUCE this is a live content region.
    """
    img = _decode_image(screen_b64)
    img_scaled = cv2.resize(img, (output_width, output_height), interpolation=cv2.INTER_LANCZOS4)

    # Draw dynamic-region overlay: subtle grid pattern
    overlay = img_scaled.copy()
    grid_color = (60, 100, 160, 180)  # blue-ish, semi-transparent
    step = max(16, min(output_width, output_height) // 8)

    for x in range(0, output_width, step):
        cv2.line(overlay, (x, 0), (x, output_height), grid_color[:3], 1)
    for y in range(0, output_height, step):
        cv2.line(overlay, (0, y), (output_width, y), grid_color[:3], 1)

    # "DYNAMIC REGION" label in center
    font = cv2.FONT_HERSHEY_SIMPLEX
    text = "DYNAMIC REGION"
    scale = max(0.3, min(0.6, output_width / 300))
    thickness = 1
    (tw, th), _ = cv2.getTextSize(text, font, scale, thickness)
    tx = (output_width - tw) // 2
    ty = (output_height + th) // 2
    cv2.putText(overlay, text, (tx, ty), font, scale, (80, 140, 220), thickness, cv2.LINE_AA)

    # Blend overlay at 40% alpha
    result = _composite_alpha(img_scaled, overlay)

    return {
        "dataUrl": _encode_png_b64(result),
        "placeholder": True,
        "width": output_width,
        "height": output_height,
    }
