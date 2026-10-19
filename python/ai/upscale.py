"""
5.4 Resolution Upscaling — Smart image upscaling.

Uses Lanczos + sharpening as the baseline (always works).
When Real-ESRGAN model is available, uses it for superior results.
"""
import base64

import cv2
import numpy as np


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


def check_esrgan_available() -> bool:
    """Check if Real-ESRGAN is available."""
    try:
        from basicsr.archs.rrdbnet_arch import RRDBNet  # noqa: F401
        from realesrgan import RealESRGANer  # noqa: F401
        return True
    except ImportError:
        return False


def _upscale_lanczos(img: np.ndarray, scale: int, sharpen: float) -> np.ndarray:
    """High-quality Lanczos upscaling with adaptive sharpening."""
    h, w = img.shape[:2]
    new_w, new_h = w * scale, h * scale

    # Separate alpha
    has_alpha = img.shape[2] == 4
    if has_alpha:
        bgr = img[:, :, :3]
        alpha = img[:, :, 3]
    else:
        bgr = img
        alpha = None

    # Upscale with Lanczos
    up_bgr = cv2.resize(bgr, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)

    # Adaptive unsharp masking
    if sharpen > 0:
        blurred = cv2.GaussianBlur(up_bgr, (0, 0), sigmaX=1.5)
        up_bgr = cv2.addWeighted(up_bgr, 1.0 + sharpen, blurred, -sharpen, 0)
        up_bgr = np.clip(up_bgr, 0, 255).astype(np.uint8)

    # Edge-preserving detail enhancement
    detail = cv2.detailEnhance(up_bgr, sigma_s=8, sigma_r=0.12)
    up_bgr = cv2.addWeighted(up_bgr, 0.7, detail, 0.3, 0)

    if has_alpha:
        up_alpha = cv2.resize(alpha, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
        result = np.zeros((new_h, new_w, 4), dtype=np.uint8)
        result[:, :, :3] = up_bgr
        result[:, :, 3] = up_alpha
        return result
    return up_bgr


def _upscale_esrgan(img: np.ndarray, scale: int) -> np.ndarray:
    """Upscale using Real-ESRGAN (requires model files)."""
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan import RealESRGANer
    import os

    model_path = os.path.join(os.path.dirname(__file__), "..", "models", f"RealESRGAN_x{scale}plus.pth")
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Real-ESRGAN model not found at {model_path}")

    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32)
    upsampler = RealESRGANer(
        scale=scale,
        model_path=model_path,
        model=model,
        tile=256,
        tile_pad=10,
        pre_pad=0,
        half=False,
    )

    has_alpha = img.shape[2] == 4
    if has_alpha:
        bgr = img[:, :, :3]
        alpha = img[:, :, 3]
        output, _ = upsampler.enhance(bgr, outscale=scale)
        h, w = output.shape[:2]
        up_alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_LANCZOS4)
        result = np.zeros((h, w, 4), dtype=np.uint8)
        result[:, :, :3] = output
        result[:, :, 3] = up_alpha
        return result
    else:
        output, _ = upsampler.enhance(img, outscale=scale)
        return output


def upscale(
    image_b64: str,
    scale: int = 2,
    sharpen: float = 0.4,
    prefer_ai: bool = True,
) -> dict:
    """
    Upscale an image by the given factor.

    Args:
        scale: 2 or 4
        sharpen: sharpening strength (0-1) for Lanczos mode
        prefer_ai: try Real-ESRGAN first if available

    Returns: {dataUrl, method, original_size, new_size}
    """
    if scale not in (2, 4):
        raise ValueError("Scale must be 2 or 4")

    img = _b64_to_cv(image_b64)
    h, w = img.shape[:2]
    method = "lanczos"

    if prefer_ai and check_esrgan_available():
        try:
            result = _upscale_esrgan(img, scale)
            method = "real-esrgan"
        except Exception:
            result = _upscale_lanczos(img, scale, sharpen)
    else:
        result = _upscale_lanczos(img, scale, sharpen)

    rh, rw = result.shape[:2]

    return {
        "dataUrl": _cv_to_b64(result),
        "method": method,
        "original_size": {"width": w, "height": h},
        "new_size": {"width": rw, "height": rh},
    }
