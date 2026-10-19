"""
color.py — import-time colour management.

The footgun: OpenCV ignores embedded ICC profiles and reads raw channel values,
but browsers (where the user previews the panel) DO honour them. A Display-P3
screenshot or an AdobeRGB scan therefore looks one way in the app and a
different way once its assets are cut server-side with cv2.

Fix: at the single point images enter the backend, if the file carries a
non-sRGB ICC profile, transform it to sRGB (Pillow/ImageCms) and drop the
profile. Images with no profile — the overwhelming majority of PNG mockups —
skip Pillow entirely and keep the existing fast cv2 decode, so behaviour and
performance are unchanged for them.
"""
from __future__ import annotations

import io
import logging
from typing import Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_SRGB_MARKERS = ("srgb", "sr gb", "iec 61966")


def has_icc_profile(raw: bytes) -> bool:
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as im:
            return bool(im.info.get("icc_profile"))
    except Exception:
        return False


def maybe_srgb_normalize(raw: bytes, fallback_bgr: np.ndarray) -> Tuple[np.ndarray, bool]:
    """Return (bgr, converted).

    If ``raw`` carries a non-sRGB ICC profile, colour-convert it to sRGB and
    return that BGR image. Otherwise return ``fallback_bgr`` (the caller's
    existing cv2 decode) untouched. Never raises — colour management must not
    break analysis.
    """
    try:
        from PIL import Image, ImageCms
    except Exception:
        return fallback_bgr, False

    try:
        with Image.open(io.BytesIO(raw)) as im:
            icc = im.info.get("icc_profile")
            if not icc:
                return fallback_bgr, False

            # Skip the transform when the profile already IS sRGB.
            try:
                src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
                desc = (ImageCms.getProfileDescription(src_profile) or "").lower()
            except Exception:
                return fallback_bgr, False
            if any(m in desc for m in _SRGB_MARKERS):
                return fallback_bgr, False

            rgb = im.convert("RGB")
            dst_profile = ImageCms.createProfile("sRGB")
            converted = ImageCms.profileToProfile(rgb, src_profile, dst_profile, outputMode="RGB")
            arr = np.array(converted)
            bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
            logger.info("sRGB-normalized input from ICC profile '%s'", desc or "unknown")
            return bgr, True
    except Exception as exc:
        logger.warning("sRGB normalize skipped (%s)", exc)
        return fallback_bgr, False
