"""SynthSkin Studio - Python Sidecar Server

FastAPI backend that provides AI-powered image processing services:
- SAM2 segmentation
- Background removal (rembg)
- Circular/rectangular extraction (OpenCV)
- Image processing (Pillow)
"""
import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time
import traceback

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from typing import Optional, List, Any

# Import + configure the resource manager BEFORE the heavy CV/AI libs load, so
# OpenMP/MKL/torch/OpenCV thread pools fan out across every physical core.
import runtime
runtime.configure_threads()

from extraction import (
    extract_circle, extract_rect, warp_perspective, detect_circles,
    magic_wand, pro_extract, extract_polygon, refine_extraction, combine_masks,
)
from processor import (
    run_pipeline, run_single_extract, correct_perspective as proc_correct_perspective,
    check_yolo_pipeline_available, detect_components_auto,
    inpaint_background as proc_inpaint_background,
    _b64_to_bgra, _b64_to_bgr, _to_png_b64 as proc_to_png_b64,
)
from animation import generate_rotation_frames, generate_indicator_frames, create_filmstrip, create_spritesheet
from meter import generate_needle_frames, generate_led_bar_frames, generate_screen_placeholder
from background_export import build_punch_triple, decode_bgr as _decode_bgr
from layout_manifest import build_layout_manifest
from export_pipeline import (
    render_multi_scale, trace_to_svg, create_pow2_spritesheet,
    build_juce_export_package, pack_multi_asset_spritesheet,
)
from pro_features import batch_detect_components, generate_color_variant, generate_color_variants_batch
from ai.style_transfer import apply_style, get_available_styles
from ai.component_detection import detect_components, check_yolo_available
from ai.lighting_normalize import estimate_lighting, normalize_lighting, harmonize_batch
from ai.upscale import upscale, check_esrgan_available
from ai.symmetry import detect_symmetry, enforce_symmetry
from ai.inpainting import detect_text_regions, inpaint, auto_remove_text, check_lama_available
from ai.prompt_to_component import (
    remove_background, center_and_crop, generate_component,
    get_generation_presets, check_rembg_available, check_sd_available,
)
# Gemma (Ollama) disabled — using Gemini/YOLO/OpenCV panel detection instead.
def check_gemma_available() -> dict:
    return {"available": False, "reason": "Gemma disabled — using Gemini/YOLO/OpenCV panel detection"}
from ui_layout_analyzer import analyze_ui_layout, detect_panel_corners
from panel_pipeline import (
    analyze_panel,
    check_panel_pipeline_available,
    clear_models as clear_panel_models,
    resegment_one as panel_resegment_one,
    set_gemini_key as panel_set_gemini_key,
    reset_florence_sentinel,
)
from panel_dedup import deduplicate_controls
from panel_state import detect_control_states
from synth_dataset import DEFAULT_DATA, format_validation_report, validate_dataset, write_validation_report
from sam_service import (
    check_sam2_available, segment_point, segment_box, auto_segment,
)
from training_corpus import REPORTS_DIR, ensure_training_corpus, get_training_corpus_status, save_layout_sample
from ai.commercial_safe_3d import (
    extract_3d as cs3d_extract,
    capabilities as cs3d_capabilities,
    generate_normal_map as cs3d_generate_normal_map,
    estimate_depth as cs3d_estimate_depth,
    _b64_to_bgra as cs3d_b64_to_bgra,
    _png_to_b64 as cs3d_png_to_b64,
)

app = FastAPI(title="SynthSkin Studio Backend", version="0.1.0")

logger = logging.getLogger("synthskin")

TRAINING_SCRIPT = Path(__file__).resolve().parent / "train_synth_detector.py"
TRAINING_PROJECT_DIR = Path(__file__).resolve().parent / "runs" / "detect"
_TRAINING_LOCK = threading.Lock()
_TRAINING_STATE: dict[str, Any] = {
    "status": "idle",
    "running": False,
    "started_at": None,
    "finished_at": None,
    "exit_code": None,
    "command": [],
    "lines": [],
    "process": None,
    "watcher": None,
}


def _training_snapshot() -> dict[str, Any]:
    with _TRAINING_LOCK:
        return {
            "status": _TRAINING_STATE["status"],
            "running": _TRAINING_STATE["running"],
            "started_at": _TRAINING_STATE["started_at"],
            "finished_at": _TRAINING_STATE["finished_at"],
            "exit_code": _TRAINING_STATE["exit_code"],
            "command": list(_TRAINING_STATE["command"]),
            "lines": list(_TRAINING_STATE["lines"]),
        }


def _training_set_lines(lines: list[str]) -> None:
    _TRAINING_STATE["lines"] = lines[-160:]


def _training_append_line(line: str) -> None:
    with _TRAINING_LOCK:
        lines = list(_TRAINING_STATE.get("lines") or [])
        lines.append(line)
        _training_set_lines(lines)


def _run_training_job(command: list[str]) -> None:
    proc: subprocess.Popen[str] | None = None
    try:
        proc = subprocess.Popen(
            command,
            cwd=str(Path(__file__).resolve().parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        with _TRAINING_LOCK:
            _TRAINING_STATE["process"] = proc
            _TRAINING_STATE["status"] = "running"
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            if line:
                _training_append_line(line)
        exit_code = proc.wait()
        with _TRAINING_LOCK:
            _TRAINING_STATE["running"] = False
            _TRAINING_STATE["process"] = None
            _TRAINING_STATE["watcher"] = None
            _TRAINING_STATE["exit_code"] = exit_code
            _TRAINING_STATE["finished_at"] = time.time()
            _TRAINING_STATE["status"] = "completed" if exit_code == 0 else "failed"
    except Exception as exc:
        logger.exception("training job failed")
        with _TRAINING_LOCK:
            _TRAINING_STATE["running"] = False
            _TRAINING_STATE["process"] = None
            _TRAINING_STATE["watcher"] = None
            _TRAINING_STATE["exit_code"] = -1
            _TRAINING_STATE["finished_at"] = time.time()
            _TRAINING_STATE["status"] = "failed"
            lines = list(_TRAINING_STATE.get("lines") or [])
            lines.append(f"Training launcher failed: {_safe_error(exc)}")
            _training_set_lines(lines)
    finally:
        if proc and proc.stdout:
            try:
                proc.stdout.close()
            except Exception:
                pass


def _start_training_job(command: list[str]) -> dict[str, Any]:
    with _TRAINING_LOCK:
        process = _TRAINING_STATE.get("process")
        watcher = _TRAINING_STATE.get("watcher")
        if (process is not None and process.poll() is None) or (isinstance(watcher, threading.Thread) and watcher.is_alive()):
            raise RuntimeError("Training is already running")

        _TRAINING_STATE["status"] = "starting"
        _TRAINING_STATE["running"] = True
        _TRAINING_STATE["started_at"] = time.time()
        _TRAINING_STATE["finished_at"] = None
        _TRAINING_STATE["exit_code"] = None
        _TRAINING_STATE["command"] = list(command)
        _TRAINING_STATE["process"] = None
        _TRAINING_STATE["lines"] = ["Starting training job...", " ".join(command)]

        watcher = threading.Thread(target=_run_training_job, args=(command,), daemon=True)
        _TRAINING_STATE["watcher"] = watcher
        watcher.start()
    return _training_snapshot()


def _stop_training_job() -> dict[str, Any]:
    with _TRAINING_LOCK:
        proc = _TRAINING_STATE.get("process")
        if proc is None or proc.poll() is not None:
            return _training_snapshot()
        proc.terminate()
        lines = list(_TRAINING_STATE.get("lines") or [])
        lines.append("Termination requested by user.")
        _training_set_lines(lines)
        _TRAINING_STATE["status"] = "stopping"
    return _training_snapshot()

# Only allow connections from localhost (Electron renderer)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:*", "http://127.0.0.1:*"],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Request timeout middleware ───
# Prevents slow operations (e.g. GrabCut on huge images) from hanging forever.
# SSE streaming endpoints are exempt — they are inherently long-lived and manage
# their own lifecycle via done/error events.
REQUEST_TIMEOUT_SECONDS = 120

# Paths that use SSE streaming and should NOT be killed by the timeout middleware.
_SSE_STREAM_PATHS = frozenset({
    "/analyze/layout/stream",
    "/panel/analyze/stream",
})


@app.middleware("http")
async def timeout_middleware(request: Request, call_next):
    # SSE streaming endpoints manage their own lifecycle — don't timeout.
    if request.url.path in _SSE_STREAM_PATHS:
        return await call_next(request)
    try:
        return await asyncio.wait_for(call_next(request), timeout=REQUEST_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"detail": f"Request timed out after {REQUEST_TIMEOUT_SECONDS}s. Try a smaller image or simpler operation."},
        )


def _safe_error(e: Exception) -> str:
    """Return a sanitized error message (no internal paths or stack traces)."""
    logger.error("Request failed", exc_info=True)
    msg = str(e)
    # Strip file system paths from error messages
    if os.sep in msg:
        msg = msg.split(os.sep)[-1]
    return msg

# ─── Request size limit ───
# Base64-encoded 50 MB image ≈ 67 MB text. Reject anything larger to prevent OOM.
MAX_IMAGE_B64_BYTES = 70 * 1024 * 1024  # 70 MB text → ~50 MB decoded image


def _check_image_size(data_url: str, field: str = "image") -> None:
    """Raise HTTPException 413 if the base64 image payload exceeds the limit."""
    if len(data_url) > MAX_IMAGE_B64_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Field '{field}' exceeds the 50 MB image size limit."
        )


# ─── Request Models ───

class CircleExtractRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the source image")
    cx: float
    cy: float
    radius: float


class RectExtractRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the source image")
    x: float
    y: float
    width: float
    height: float
    angle: float = 0


class WarpRequest(BaseModel):
    image: str
    src_points: List[List[float]]
    dst_width: int
    dst_height: int


class DetectCirclesRequest(BaseModel):
    image: str
    min_radius: int = 10
    max_radius: int = 200


class MagicWandRequest(BaseModel):
    image: str
    seed_x: int
    seed_y: int
    tolerance: int = 32
    feather: float = 0
    expand: int = 0
    contiguous: bool = True
    mode: str = "element"  # "element", "invert", "color"
    edge_sensitivity: float = 1.0  # 0.2-3.0, lower = more edges detected
    refine_edges: bool = True  # anti-aliased alpha matting
    fast: bool = False  # skip GrabCut for faster one-click extraction


class ProExtractRequest(BaseModel):
    image: str
    seed_x: int
    seed_y: int
    strategy: str = "auto"  # auto|contour|edge|color|grabcut|invert
    tolerance: int = 32
    edge_sensitivity: float = 1.0
    feather: float = 0
    expand: int = 0
    padding: int = 0
    refine_edges: bool = True
    quality: str = "standard"  # fast|standard|high
    return_candidates: bool = False


class PolygonExtractRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the source image")
    points: List[List[float]] = Field(..., description="List of [x, y] points forming the polygon/lasso path")
    feather: float = 0
    expand: int = 0
    refine_edges: bool = True


class RefineExtractionRequest(BaseModel):
    image: str = Field(..., description="Original source image (full resolution, base64)")
    mask: str = Field(..., description="Extracted BGRA PNG at source resolution (base64)")
    radius: float = 3.0    # edge detection band width, pixels
    smooth: int = 0        # morphological smoothing iterations
    feather: float = 0     # Gaussian softening radius
    contrast: float = 0    # alpha sharpness: -100..+100
    shift_edge: float = 0  # grow/shrink: -100..+100


class MaskCombineRequest(BaseModel):
    image: str = Field(..., description="Original source image (base64)")
    mask_a: str = Field(..., description="First mask (full-res BGRA PNG, base64)")
    mask_b: str = Field(..., description="Second mask to add/subtract/intersect (base64)")
    mode: str = "add"  # "add" | "subtract" | "intersect"


class RotationRequest(BaseModel):
    image: str
    center_x: float
    center_y: float
    start_angle: float = -135.0
    end_angle: float = 135.0
    frame_count: int = 128
    output_size: int = 256
    mode: str = "simple"  # "simple" or "indicator"
    # Indicator mode params
    indicator_angle: float = 0
    indicator_length: float = 40
    indicator_width: int = 3
    indicator_color: List[int] = [255, 255, 255]  # BGR


class FilmstripRequest(BaseModel):
    frames: List[str]
    orientation: str = "vertical"


class SpritesheetRequest(BaseModel):
    frames: List[str]
    cols: int = 0


class NeedleMeterRequest(BaseModel):
    face_image: str
    needle_image: str
    pivot_x: float
    pivot_y: float
    rest_angle: float = -50.0
    full_scale_angle: float = 50.0
    frame_count: int = 64
    output_width: int = 256
    output_height: int = 256
    motion_blur: bool = False
    motion_blur_samples: int = 5


class LedBarRequest(BaseModel):
    off_image: str
    on_image: str
    segment_count: int = 20
    orientation: str = "vertical"  # "vertical" or "horizontal"
    frame_count: int = 20
    output_width: int = 64
    output_height: int = 256
    # gradient_colors: list of [B, G, R] triplets (default: green→yellow→red for VU)
    gradient_colors: List[List[int]] = [
        [0, 200, 0],    # green
        [0, 200, 200],  # yellow
        [0, 0, 220],    # red
    ]
    gap_fraction: float = 0.08


class ScreenPlaceholderRequest(BaseModel):
    image: str
    output_width: int = 256
    output_height: int = 128


# ─── Endpoints ───

@app.get("/health")
async def health():
    """Health check endpoint polled by Electron on startup."""
    return {"status": "ok", "version": "0.1.0"}


@app.post("/shutdown")
async def shutdown():
    """Graceful shutdown called by Electron when the app closes."""
    os.kill(os.getpid(), signal.SIGTERM)
    return {"status": "shutting_down"}


@app.post("/extract/circle")
async def api_extract_circle(req: CircleExtractRequest):
    _check_image_size(req.image)
    try:
        return extract_circle(req.image, req.cx, req.cy, req.radius)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/extract/rect")
async def api_extract_rect(req: RectExtractRequest):
    _check_image_size(req.image)
    try:
        return extract_rect(req.image, req.x, req.y, req.width, req.height, req.angle)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/extract/warp")
async def api_warp_perspective(req: WarpRequest):
    _check_image_size(req.image)
    try:
        return warp_perspective(req.image, req.src_points, (req.dst_width, req.dst_height))
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/detect/circles")
async def api_detect_circles(req: DetectCirclesRequest):
    _check_image_size(req.image)
    try:
        circles = detect_circles(req.image, req.min_radius, req.max_radius)
        return {"circles": circles}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/extract/wand")
async def api_magic_wand(req: MagicWandRequest):
    _check_image_size(req.image)
    try:
        return magic_wand(
            req.image, req.seed_x, req.seed_y,
            req.tolerance, req.feather, req.expand, req.contiguous,
            req.mode, req.edge_sensitivity, req.refine_edges, req.fast,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/extract/pro")
async def api_pro_extract(req: ProExtractRequest):
    _check_image_size(req.image)
    try:
        return pro_extract(
            req.image, req.seed_x, req.seed_y,
            req.strategy, req.tolerance, req.edge_sensitivity,
            req.feather, req.expand, req.padding, req.refine_edges,
            req.quality, req.return_candidates,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/extract/polygon")
async def api_extract_polygon(req: PolygonExtractRequest):
    """Freehand lasso or polygonal lasso extraction."""
    _check_image_size(req.image)
    try:
        return extract_polygon(
            req.image, req.points, req.feather, req.expand, req.refine_edges,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/extract/refine")
async def api_refine_extraction(req: RefineExtractionRequest):
    """Post-extraction edge refinement (Refine Edge / Select and Mask equivalent)."""
    _check_image_size(req.image)
    try:
        return refine_extraction(
            req.image, req.mask, req.radius, req.smooth,
            req.feather, req.contrast, req.shift_edge,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/extract/mask-combine")
async def api_mask_combine(req: MaskCombineRequest):
    """Combine two masks (selection add/subtract/intersect)."""
    _check_image_size(req.image)
    try:
        return combine_masks(req.image, req.mask_a, req.mask_b, req.mode)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


# ─── Animation Endpoints ───

@app.post("/animate/frames")
async def api_generate_frames(req: RotationRequest):
    try:
        if req.mode == "indicator":
            frames = generate_indicator_frames(
                req.image, req.center_x, req.center_y,
                req.start_angle, req.end_angle, req.frame_count, req.output_size,
                req.indicator_angle, req.indicator_length, req.indicator_width,
                tuple(req.indicator_color[:3]),
            )
        else:
            frames = generate_rotation_frames(
                req.image, req.center_x, req.center_y,
                req.start_angle, req.end_angle, req.frame_count, req.output_size,
            )
        return {"frames": frames, "count": len(frames)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/animate/filmstrip")
async def api_filmstrip(req: FilmstripRequest):
    try:
        data_url = create_filmstrip(req.frames, req.orientation)
        return {"dataUrl": data_url}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/animate/spritesheet")
async def api_spritesheet(req: SpritesheetRequest):
    try:
        return create_spritesheet(req.frames, req.cols)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/meter/needle")
async def api_needle_meter(req: NeedleMeterRequest):
    try:
        frames = generate_needle_frames(
            req.face_image, req.needle_image,
            req.pivot_x, req.pivot_y,
            req.rest_angle, req.full_scale_angle,
            req.frame_count, req.output_width, req.output_height,
            req.motion_blur, req.motion_blur_samples,
        )
        return {"frames": frames, "count": len(frames)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/meter/led")
async def api_led_bar(req: LedBarRequest):
    try:
        colors = [tuple(c) for c in req.gradient_colors]
        frames = generate_led_bar_frames(
            req.off_image, req.on_image,
            req.segment_count, req.orientation,
            req.frame_count, req.output_width, req.output_height,
            colors, req.gap_fraction,
        )
        return {"frames": frames, "count": len(frames)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/meter/screen")
async def api_screen_placeholder(req: ScreenPlaceholderRequest):
    try:
        return generate_screen_placeholder(req.image, req.output_width, req.output_height)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


# ─── Export Endpoints ─────────────────────────────────────────

class MultiScaleRequest(BaseModel):
    image: str
    base_width: int = 256
    base_height: int = 256
    scales: List[int] = [1, 2]

class SvgTraceRequest(BaseModel):
    image: str

class Pow2SpritesheetRequest(BaseModel):
    frames: List[str]
    cols: int = 0

class JuceExportRequest(BaseModel):
    asset_name: str
    asset_type: str = "knob"
    frames: List[str]
    frame_width: int = 256
    frame_height: int = 256
    include_retina: bool = True
    include_individual: bool = False
    include_spritesheet: bool = False
    include_svg: bool = False
    pow2_spritesheet: bool = True

class MultiAssetSheetItem(BaseModel):
    name: str
    image_b64: str
    width: int
    height: int

class MultiAssetSheetRequest(BaseModel):
    assets: List[MultiAssetSheetItem]
    pow2: bool = True


@app.post("/export/multi-scale")
async def api_multi_scale(req: MultiScaleRequest):
    try:
        result = render_multi_scale(req.image, req.base_width, req.base_height, req.scales)
        return {"scales": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/export/svg-trace")
async def api_svg_trace(req: SvgTraceRequest):
    try:
        svg = trace_to_svg(req.image)
        return {"svg": svg, "available": svg is not None}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/export/pow2-spritesheet")
async def api_pow2_spritesheet(req: Pow2SpritesheetRequest):
    try:
        return create_pow2_spritesheet(req.frames, req.cols)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/export/juce-package")
async def api_juce_package(req: JuceExportRequest):
    try:
        return build_juce_export_package(
            req.asset_name, req.asset_type, req.frames,
            req.frame_width, req.frame_height,
            req.include_retina, req.include_individual,
            req.include_spritesheet, req.include_svg,
            req.pow2_spritesheet,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/export/multi-asset-sheet")
async def api_multi_asset_sheet(req: MultiAssetSheetRequest):
    try:
        assets_dicts = [a.model_dump() for a in req.assets]
        return pack_multi_asset_spritesheet(assets_dicts, req.pow2)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


class SpriteStripRequest(BaseModel):
    crop_png: str = Field(..., description="Transparent RGBA PNG data-URL of the control crop")
    frames: int = Field(100, ge=4, le=256, description="Number of strip frames")
    current_angle_deg: float = Field(0.0, description="Current pointer angle from 12-o'clock (CW positive)")
    min_angle_deg: float = Field(-135.0, description="Minimum travel angle (standard synth: -135)")
    max_angle_deg: float = Field(135.0, description="Maximum travel angle (standard synth: +135)")
    cx_norm: Optional[float] = Field(None, description="Rotation center X normalised to crop width (0–1); default=centre")
    cy_norm: Optional[float] = Field(None, description="Rotation center Y normalised to crop height (0–1); default=centre")
    output_size: Optional[int] = Field(None, ge=16, le=1024, description="Output frame px; default=auto from crop")


@app.post("/export/sprite-strip")
async def api_sprite_strip(req: SpriteStripRequest):
    """Generate a JUCE-compatible vertical sprite filmstrip for a knob.

    Frame 0 = pointer at min_angle_deg · Frame N-1 = pointer at max_angle_deg.
    Rotation delta is computed relative to current_angle_deg so the strip is
    correct regardless of what angle the knob happened to be at in the photo.
    """
    try:
        loop = asyncio.get_event_loop()

        def _run():
            from animation import _decode_image as _anim_decode
            img = _anim_decode(req.crop_png)
            h, w = img.shape[:2]
            cx = (req.cx_norm * w) if req.cx_norm is not None else w / 2.0
            cy = (req.cy_norm * h) if req.cy_norm is not None else h / 2.0
            out_size = req.output_size or max(w, h)
            # generate_rotation_frames rotates by -angle at each step, so
            # passing the delta (target - current) produces the correct sweep.
            start_angle = req.min_angle_deg - req.current_angle_deg
            end_angle   = req.max_angle_deg - req.current_angle_deg
            frames_b64 = generate_rotation_frames(
                req.crop_png, cx, cy, start_angle, end_angle, req.frames, out_size,
            )
            strip_png = create_filmstrip(frames_b64, orientation="vertical")
            return {
                "strip_png": strip_png,
                "frames": req.frames,
                "frame_width": out_size,
                "frame_height": out_size,
            }

        return await loop.run_in_executor(None, _run)
    except Exception as e:
        logger.exception("sprite-strip failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


class PunchTripleRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the source panel image")
    controls: List[Any] = Field(..., description="Analyzed controls with mask_png + mask_bbox")
    dilate_px: int = Field(2, ge=0, le=16, description="Grow holes before punch (halo guard)")
    feather_px: int = Field(1, ge=0, le=8, description="Soft-rim the punched hole edges")
    fill_method: str = Field("telea", description="Inpaint method for the filled plate: telea|ns|poisson")
    fill_radius: int = Field(5, ge=1, le=32)
    include_crops: bool = Field(True, description="Also return per-asset RGBA crops")
    exclude_types: Optional[List[str]] = Field(
        default=None, description="Control types to keep in the background (e.g. ['label'])"
    )
    dehalo: bool = Field(True, description="Colour-decontaminate each crop's soft rim (no halo)")


class LayoutManifestRequest(BaseModel):
    controls: List[Any] = Field(..., description="Analyzed controls")
    image_width: int
    image_height: int
    rectified: bool = False
    source_hash: Optional[str] = None
    files_by_id: Optional[dict] = None
    scales_by_id: Optional[dict] = None
    include_semantics: bool = True
    include_shapes: bool = True
    include_interaction: bool = True


@app.post("/export/layout-manifest")
async def api_layout_manifest(req: LayoutManifestRequest):
    """Assemble the single versioned export contract, layout.json v1."""
    try:
        return build_layout_manifest(
            [c if isinstance(c, dict) else dict(c) for c in req.controls],
            req.image_width, req.image_height,
            rectified=req.rectified,
            source_hash=req.source_hash,
            files_by_id=req.files_by_id,
            scales_by_id=req.scales_by_id,
            include_semantics=req.include_semantics,
            include_shapes=req.include_shapes,
            include_interaction=req.include_interaction,
        )
    except Exception as e:
        logger.exception("layout-manifest failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/export/punch-triple")
async def api_punch_triple(req: PunchTripleRequest):
    """Produce background_punched (RGBA holes) + background_filled (inpainted) +
    per-asset RGBA crops — the clean separation contract, at source resolution."""
    _check_image_size(req.image)
    try:
        img = _decode_bgr(req.image)
        return build_punch_triple(
            img,
            [c if isinstance(c, dict) else dict(c) for c in req.controls],
            dilate_px=req.dilate_px,
            feather_px=req.feather_px,
            fill_method=req.fill_method,
            fill_radius=req.fill_radius,
            include_crops=req.include_crops,
            exclude_types=set(req.exclude_types) if req.exclude_types else None,
            dehalo=req.dehalo,
        )
    except Exception as e:
        logger.exception("punch-triple export failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


# ─── UI Layout Analysis Endpoint ────────────────────────────────────────────

class LayoutAnalysisRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the plugin screenshot")
    min_confidence: float = Field(0.50, ge=0.0, le=1.0)
    detect_labels: bool = False
    iou_threshold: float = Field(0.35, ge=0.0, le=1.0)


@app.post("/analyze/layout")
async def api_analyze_layout(req: LayoutAnalysisRequest):
    """Analyze a plugin/UI screenshot and return precise positions of all elements."""
    _check_image_size(req.image)
    try:
        return analyze_ui_layout(
            req.image,
            min_confidence=req.min_confidence,
            detect_labels=req.detect_labels,
            iou_threshold=req.iou_threshold,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/analyze/layout/stream")
async def api_analyze_layout_stream(req: LayoutAnalysisRequest):
    """
    SSE-streaming version of /analyze/layout.
    Emits progress updates, cumulative element snapshots, then a final 'done'
    event with the result.
    Each event is a JSON object: {"type":"progress"|"elements"|"done"|"error", ...}
    """
    _check_image_size(req.image)
    progress_q: queue.Queue = queue.Queue()

    def run_analysis():
        t0 = time.perf_counter()
        logger.info("[LAYOUT-STREAM] Analysis thread started")
        def on_progress(stage: str, pct: int, msg: str):
            elapsed = (time.perf_counter() - t0) * 1000
            logger.info(f"[LAYOUT-STREAM] {stage} ({pct}%) +{elapsed:.0f}ms: {msg}")
            progress_q.put({"type": "progress", "stage": stage, "percent": pct, "message": msg})

        def on_elements(stage: str, result: dict):
            progress_q.put({"type": "elements", "stage": stage, "data": result})

        try:
            result = analyze_ui_layout(
                req.image,
                min_confidence=req.min_confidence,
                detect_labels=req.detect_labels,
                iou_threshold=req.iou_threshold,
                progress_cb=on_progress,
                elements_cb=on_elements,
            )
            elapsed = (time.perf_counter() - t0) * 1000
            logger.info(f"[LAYOUT-STREAM] Analysis complete in {elapsed:.0f}ms")
            progress_q.put({"type": "done", "data": result})
        except Exception as exc:
            elapsed = (time.perf_counter() - t0) * 1000
            logger.error(f"[LAYOUT-STREAM] Analysis failed after {elapsed:.0f}ms: {exc}")
            progress_q.put({"type": "error", "message": _safe_error(exc)})

    thread = threading.Thread(target=run_analysis, daemon=True)
    thread.start()

    async def event_stream():
        heartbeat_interval = 2.0
        last_data_time = time.monotonic()
        while True:
            try:
                item = progress_q.get_nowait()
                last_data_time = time.monotonic()
                yield f"data: {json.dumps(item)}\n\n"
                if item.get("type") in ("done", "error"):
                    break
            except queue.Empty:
                if time.monotonic() - last_data_time > heartbeat_interval:
                    yield ": heartbeat\n\n"
                    last_data_time = time.monotonic()
                await asyncio.sleep(0.04)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class DetectCornersRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the plugin screenshot")


@app.post("/analyze/detect-corners")
async def api_detect_corners(req: DetectCornersRequest):
    """
    Auto-detect the 4 corners of the plugin panel for perspective correction.
    Returns corners in [TL, TR, BR, BL] order.
    """
    _check_image_size(req.image)
    try:
        return detect_panel_corners(req.image)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


# ─── Semantic Panel Pipeline (Gemini + YOLO + OpenCV + optional OCR) ─────────

class PanelAnalyzeRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the plugin/hardware image")
    min_confidence: float = Field(0.25, ge=0.0, le=1.0)
    detect_labels: bool = True
    segment: bool = True
    extract_features: bool = True
    fast_mode: bool = Field(False, description="Skip SAM2 and use fast parallel GrabCut+Hough path")
    segment_batch_size: int = Field(5, ge=1, le=20, description="Emit a progress event every N completed segmentations (lower = smoother UI)")
    detection_model: str = Field("auto", description="Which detector to use: auto|gemini|yolo (legacy florence2/cv route to yolo)")
    rectify_mode: str = Field("auto", description="Stage-0 dewarp: auto (warp perspective photos only) | skip | force")


@app.get("/panel/capabilities")
async def api_panel_capabilities():
    return check_panel_pipeline_available()


@app.post("/panel/clear-models")
async def api_panel_clear_models():
    """Release all cached AI models to free VRAM/RAM."""
    try:
        return clear_panel_models()
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error(e))


class PanelSetGeminiKeyRequest(BaseModel):
    key: str = Field("", description="Gemini API key (AIzaSy...). Pass empty string to remove.")


@app.post("/panel/set-gemini-key")
async def api_panel_set_gemini_key(req: PanelSetGeminiKeyRequest):
    """Set the Gemini API key at runtime without restarting the server."""
    try:
        panel_set_gemini_key(req.key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))
    caps = check_panel_pipeline_available()
    return {"ok": True, "gemini_key_set": caps["gemini_key_set"], "capabilities": caps}


@app.get("/panel/gemini-key-status")
async def api_panel_gemini_key_status():
    """Return whether a Gemini API key is currently configured."""
    caps = check_panel_pipeline_available()
    return {"gemini_key_set": caps["gemini_key_set"]}


@app.post("/panel/reset-florence")
async def api_panel_reset_florence():
    """Delete the .florence2_broken sentinel so Florence-2 retries on next analysis."""
    try:
        return reset_florence_sentinel()
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error(e))


class PanelResegmentRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the panel image")
    bbox: List[float] = Field(..., description="[x1, y1, x2, y2] in native pixels")
    fast_mode: bool = True


@app.post("/panel/resegment")
async def api_panel_resegment(req: PanelResegmentRequest):
    """Re-run segmentation on a single user-edited bbox.

    Used by the bbox editor after a drag/resize to refresh mask_png
    without triggering a full re-analysis.
    """
    _check_image_size(req.image)
    if len(req.bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox must be [x1,y1,x2,y2]")
    try:
        return panel_resegment_one(req.image, req.bbox, fast_mode=req.fast_mode)
    except Exception as e:
        logger.exception("panel resegment failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


# ─── Deduplication endpoint ─────────────────────────────────────────────────

class PanelDedupRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the panel image")
    controls: List[Any] = Field(..., description="Analyzed controls list")
    size_thr: float = Field(0.60, ge=0.0, le=1.0, description="Min size-similarity ratio to cluster")
    hist_thr: float = Field(0.60, ge=0.0, le=1.0, description="Min histogram similarity to cluster")
    match_score_thr: float = Field(0.72, ge=0.0, le=1.0, description="NCC threshold for template matching")
    min_cluster_size: int = Field(2, ge=2, description="Min cluster size to deduplicate")
    run_template_match: bool = Field(True, description="Run NCC template matching to find additional instances")


@app.post("/panel/deduplicate")
async def api_panel_deduplicate(req: PanelDedupRequest):
    """Cluster repeated controls and find all instance positions via template matching.

    Returns canonical control IDs, removed IDs, and groups with instances[].
    """
    _check_image_size(req.image)
    try:
        controls = [c if isinstance(c, dict) else dict(c) for c in req.controls]
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: deduplicate_controls(
                controls,
                req.image,
                size_thr=req.size_thr,
                hist_thr=req.hist_thr,
                match_score_thr=req.match_score_thr,
                min_cluster_size=req.min_cluster_size,
                run_template_match=req.run_template_match,
            ),
        )
        return result
    except Exception as e:
        logger.exception("panel deduplicate failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


# ─── State detection endpoint ────────────────────────────────────────────────

class PanelDetectStateRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the panel image")
    controls: List[Any] = Field(..., description="Controls to detect state for (need bbox + type)")


@app.post("/panel/detect-states")
async def api_panel_detect_states(req: PanelDetectStateRequest):
    """Detect the current visual state of each control (knob angle, slider position, meter needle).

    Returns a states map keyed by control id.
    """
    _check_image_size(req.image)
    try:
        controls = [c if isinstance(c, dict) else dict(c) for c in req.controls]
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: detect_control_states(controls, req.image),
        )
        return result
    except Exception as e:
        logger.exception("panel detect-states failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


class TrainingCorpusSaveRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the panel image")
    image_width: int = Field(..., ge=1)
    image_height: int = Field(..., ge=1)
    layout: dict[str, Any] = Field(default_factory=dict)
    source_name: Optional[str] = None
    source_path: Optional[str] = None
    split: str = Field("auto", description="auto|train|val")
    include_text_labels: bool = True
    notes: Optional[str] = None


class TrainingPreflightRequest(BaseModel):
    min_train: int = Field(50, ge=0)
    min_val: int = Field(10, ge=0)
    require_boxes: bool = True


class TrainingRunRequest(BaseModel):
    base: str = Field("yolo11m.pt")
    epochs: int = Field(120, ge=1)
    imgsz: int = Field(1280, ge=320)
    batch: int = Field(8, ge=1)
    device: Optional[str] = None
    min_train: int = Field(50, ge=0)
    min_val: int = Field(10, ge=0)
    workers: int = Field(4, ge=0)
    cache: str = Field("false", description="false|true|ram|disk")
    name: str = Field("synthskin_panel_detector")
    # Optimizer / schedule
    optimizer: str = Field("auto", description="auto|SGD|Adam|AdamW|NAdam|RAdam|RMSProp")
    lr0: float = Field(0.01, gt=0)
    lrf: float = Field(0.01, gt=0)
    momentum: float = Field(0.937, ge=0, le=1)
    weight_decay: float = Field(0.0005, ge=0)
    warmup_epochs: float = Field(3.0, ge=0)
    patience: int = Field(30, ge=0)
    cos_lr: bool = True
    close_mosaic: int = Field(10, ge=0)
    # Loss weights
    box: float = Field(7.5, ge=0)
    cls: float = Field(0.5, ge=0)
    dfl: float = Field(1.5, ge=0)
    # Augmentation
    hsv_h: float = Field(0.015, ge=0, le=1)
    hsv_s: float = Field(0.7, ge=0, le=1)
    hsv_v: float = Field(0.4, ge=0, le=1)
    degrees: float = Field(2.0, ge=0)
    translate: float = Field(0.04, ge=0, le=1)
    scale: float = Field(0.25, ge=0, le=1)
    shear: float = Field(0.0, ge=0)
    perspective: float = Field(0.0, ge=0, le=0.001)
    flipud: float = Field(0.0, ge=0, le=1)
    fliplr: float = Field(0.0, ge=0, le=1)
    mosaic: float = Field(0.35, ge=0, le=1)
    mixup: float = Field(0.05, ge=0, le=1)
    copy_paste: float = Field(0.0, ge=0, le=1)
    erasing: float = Field(0.4, ge=0, le=1)
    # Hardware / model
    amp: bool = True
    rect: bool = False
    single_cls: bool = False
    freeze: Optional[int] = None
    resume: bool = False
    seed: int = 0


@app.get("/training/corpus/status")
async def api_training_corpus_status():
    try:
        return get_training_corpus_status()
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error(e))


@app.post("/training/corpus/save")
async def api_training_corpus_save(req: TrainingCorpusSaveRequest):
    _check_image_size(req.image)
    if req.split not in {"auto", "train", "val"}:
        raise HTTPException(status_code=400, detail="split must be auto, train, or val")
    try:
        return save_layout_sample(
            image_data_url=req.image,
            image_width=req.image_width,
            image_height=req.image_height,
            layout=req.layout,
            source_name=req.source_name,
            source_path=req.source_path,
            split=req.split,
            include_text_labels=req.include_text_labels,
            notes=req.notes,
        )
    except Exception as e:
        logger.exception("training corpus save failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/training/preflight")
async def api_training_preflight(req: TrainingPreflightRequest):
    try:
        ensure_training_corpus()
        stats = validate_dataset(
            DEFAULT_DATA,
            min_train=req.min_train,
            min_val=req.min_val,
            require_boxes=req.require_boxes,
        )
        text_path, json_path = write_validation_report(stats, REPORTS_DIR)
        return {
            "ok": stats.errors == 0,
            "summary": format_validation_report(stats, max_issues=40),
            "report_text_path": str(text_path),
            "report_json_path": str(json_path),
            "stats": stats.to_dict(),
        }
    except Exception as e:
        logger.exception("training preflight failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/training/run")
async def api_training_run(req: TrainingRunRequest):
    if req.cache not in {"false", "true", "ram", "disk"}:
        raise HTTPException(status_code=400, detail="cache must be one of false, true, ram, disk")
    if req.optimizer not in {"auto", "SGD", "Adam", "AdamW", "NAdam", "RAdam", "RMSProp"}:
        raise HTTPException(status_code=400, detail="optimizer must be auto|SGD|Adam|AdamW|NAdam|RAdam|RMSProp")
    try:
        ensure_training_corpus()
        stats = validate_dataset(
            DEFAULT_DATA,
            min_train=req.min_train,
            min_val=req.min_val,
            require_boxes=True,
        )
        write_validation_report(stats, REPORTS_DIR)
        if stats.errors:
            raise HTTPException(status_code=400, detail=format_validation_report(stats, max_issues=40))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("training preflight before start failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))

    command = [
        sys.executable,
        str(TRAINING_SCRIPT),
        "--data", str(DEFAULT_DATA),
        "--base", req.base,
        "--epochs", str(req.epochs),
        "--imgsz", str(req.imgsz),
        "--batch", str(req.batch),
        "--min-train", str(req.min_train),
        "--min-val", str(req.min_val),
        "--workers", str(req.workers),
        "--cache", req.cache,
        "--project", str(TRAINING_PROJECT_DIR),
        "--name", req.name,
        "--report-dir", str(REPORTS_DIR),
        "--optimizer", req.optimizer,
        "--lr0", str(req.lr0),
        "--lrf", str(req.lrf),
        "--momentum", str(req.momentum),
        "--weight-decay", str(req.weight_decay),
        "--warmup-epochs", str(req.warmup_epochs),
        "--patience", str(req.patience),
        "--close-mosaic", str(req.close_mosaic),
        "--box", str(req.box),
        "--cls", str(req.cls),
        "--dfl", str(req.dfl),
        "--hsv-h", str(req.hsv_h),
        "--hsv-s", str(req.hsv_s),
        "--hsv-v", str(req.hsv_v),
        "--degrees", str(req.degrees),
        "--translate", str(req.translate),
        "--scale", str(req.scale),
        "--shear", str(req.shear),
        "--perspective", str(req.perspective),
        "--flipud", str(req.flipud),
        "--fliplr", str(req.fliplr),
        "--mosaic", str(req.mosaic),
        "--mixup", str(req.mixup),
        "--copy-paste", str(req.copy_paste),
        "--erasing", str(req.erasing),
        "--seed", str(req.seed),
    ]
    if not req.cos_lr:
        command.append("--no-cos-lr")
    if not req.amp:
        command.append("--no-amp")
    if req.rect:
        command.append("--rect")
    if req.single_cls:
        command.append("--single-cls")
    if req.resume:
        command.append("--resume")
    if req.freeze is not None and req.freeze > 0:
        command.extend(["--freeze", str(req.freeze)])
    if req.device:
        command.extend(["--device", req.device])
    try:
        return _start_training_job(command)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.exception("training start failed")
        raise HTTPException(status_code=500, detail=_safe_error(e))


@app.get("/training/run/status")
async def api_training_run_status():
    return _training_snapshot()


@app.post("/training/run/stop")
async def api_training_run_stop():
    try:
        return _stop_training_job()
    except Exception as e:
        logger.exception("training stop failed")
        raise HTTPException(status_code=500, detail=_safe_error(e))


# ─── Training: metrics, artifacts, runs list, promotion ───────────────────────

_PRODUCTION_WEIGHTS = Path(__file__).resolve().parent / "models" / "synthskin_yolo.pt"


def _safe_resolve_under(root: Path, candidate: Path) -> Path:
    """Resolve `candidate` ensuring it stays within `root` (path-traversal guard)."""
    root_r = root.resolve()
    target = (root_r / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
    try:
        target.relative_to(root_r)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="path is outside the runs directory") from exc
    return target


def _list_run_dirs() -> list[Path]:
    if not TRAINING_PROJECT_DIR.exists():
        return []
    return sorted(
        (p for p in TRAINING_PROJECT_DIR.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )


def _parse_results_csv(path: Path) -> list[dict[str, float | int]]:
    if not path.exists():
        return []
    import csv
    rows: list[dict[str, float | int]] = []
    try:
        with path.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                converted: dict[str, float | int] = {}
                for key, raw in row.items():
                    if raw is None or raw == "":
                        continue
                    key_clean = key.strip()
                    try:
                        f = float(raw)
                    except ValueError:
                        continue
                    converted[key_clean] = int(f) if key_clean == "epoch" else f
                if converted:
                    rows.append(converted)
    except Exception as exc:
        logger.warning("Failed to parse results.csv %s: %s", path, exc)
    return rows


def _summarise_run(run_dir: Path) -> dict[str, Any]:
    csv_rows = _parse_results_csv(run_dir / "results.csv")
    last = csv_rows[-1] if csv_rows else {}
    weights_dir = run_dir / "weights"
    return {
        "name": run_dir.name,
        "path": str(run_dir),
        "modified": run_dir.stat().st_mtime,
        "epochs_logged": len(csv_rows),
        "best_pt": str(weights_dir / "best.pt") if (weights_dir / "best.pt").exists() else None,
        "last_pt": str(weights_dir / "last.pt") if (weights_dir / "last.pt").exists() else None,
        "args_yaml": str(run_dir / "args.yaml") if (run_dir / "args.yaml").exists() else None,
        "last_metrics": {
            "epoch": last.get("epoch"),
            "mAP50": last.get("metrics/mAP50(B)"),
            "mAP50_95": last.get("metrics/mAP50-95(B)"),
            "precision": last.get("metrics/precision(B)"),
            "recall": last.get("metrics/recall(B)"),
            "train_box_loss": last.get("train/box_loss"),
            "val_box_loss": last.get("val/box_loss"),
            "lr": last.get("lr/pg0"),
        },
    }


@app.get("/training/run/metrics")
async def api_training_run_metrics(name: Optional[str] = None):
    """Parsed results.csv rows for a training run.

    If `name` is omitted, returns metrics for the run currently being trained
    (or, when idle, the most-recently-modified run).
    """
    try:
        target_name = name
        if not target_name:
            with _TRAINING_LOCK:
                command = list(_TRAINING_STATE.get("command") or [])
            for i, token in enumerate(command):
                if token == "--name" and i + 1 < len(command):
                    target_name = command[i + 1]
                    break
            if not target_name:
                runs = _list_run_dirs()
                if not runs:
                    return {"name": None, "rows": [], "summary": None}
                target_name = runs[0].name

        run_dir = _safe_resolve_under(TRAINING_PROJECT_DIR, Path(target_name))
        if not run_dir.exists() or not run_dir.is_dir():
            return {"name": target_name, "rows": [], "summary": None}
        rows = _parse_results_csv(run_dir / "results.csv")
        return {"name": target_name, "rows": rows, "summary": _summarise_run(run_dir)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("training metrics failed")
        raise HTTPException(status_code=500, detail=_safe_error(e))


@app.get("/training/runs/list")
async def api_training_runs_list():
    try:
        runs = [_summarise_run(p) for p in _list_run_dirs()]
        return {
            "runs": runs,
            "project_dir": str(TRAINING_PROJECT_DIR),
            "production_weights": str(_PRODUCTION_WEIGHTS) if _PRODUCTION_WEIGHTS.exists() else None,
        }
    except Exception as e:
        logger.exception("training runs list failed")
        raise HTTPException(status_code=500, detail=_safe_error(e))


@app.get("/training/run/artifacts")
async def api_training_run_artifacts(name: str):
    """List artifact images (PNG/JPG) for a training run."""
    try:
        run_dir = _safe_resolve_under(TRAINING_PROJECT_DIR, Path(name))
        if not run_dir.exists() or not run_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"run not found: {name}")
        items: list[dict[str, Any]] = []
        for path in sorted(run_dir.glob("*")):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
                continue
            try:
                rel = str(path.relative_to(TRAINING_PROJECT_DIR))
            except ValueError:
                continue
            items.append({
                "name": path.name,
                "rel_path": rel,
                "size": path.stat().st_size,
            })
        return {"name": name, "artifacts": items}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("training artifacts failed")
        raise HTTPException(status_code=500, detail=_safe_error(e))


@app.get("/training/run/artifact")
async def api_training_run_artifact(rel_path: str):
    """Stream a PNG/JPG artifact from the runs directory (path-traversal guarded)."""
    from fastapi.responses import FileResponse
    try:
        target = _safe_resolve_under(TRAINING_PROJECT_DIR, Path(rel_path))
        if not target.exists() or not target.is_file():
            raise HTTPException(status_code=404, detail="artifact not found")
        if target.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise HTTPException(status_code=400, detail="only image artifacts can be served")
        return FileResponse(str(target))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("training artifact stream failed")
        raise HTTPException(status_code=500, detail=_safe_error(e))


class TrainingPromoteRequest(BaseModel):
    name: str = Field(..., description="Run name under runs/detect/")


@app.post("/training/promote")
async def api_training_promote(req: TrainingPromoteRequest):
    """Copy a run's best.pt into python/models/synthskin_yolo.pt for production use."""
    import shutil
    try:
        run_dir = _safe_resolve_under(TRAINING_PROJECT_DIR, Path(req.name))
        best = run_dir / "weights" / "best.pt"
        if not best.exists():
            raise HTTPException(status_code=404, detail=f"best.pt not found in run: {req.name}")
        _PRODUCTION_WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best, _PRODUCTION_WEIGHTS)
        # Force the panel pipeline to reload its weights.
        try:
            clear_panel_models()
        except Exception:
            logger.exception("clear_panel_models after promote failed")
        return {
            "ok": True,
            "promoted_from": str(best),
            "production_weights": str(_PRODUCTION_WEIGHTS),
            "size": _PRODUCTION_WEIGHTS.stat().st_size,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("training promote failed")
        raise HTTPException(status_code=500, detail=_safe_error(e))


@app.post("/panel/analyze")
async def api_panel_analyze(req: PanelAnalyzeRequest):
    """Run the full multi-stage semantic panel pipeline."""
    _check_image_size(req.image)
    try:
        return analyze_panel(
            req.image,
            min_confidence=req.min_confidence,
            detect_labels=req.detect_labels,
            segment=req.segment,
            extract_features_flag=req.extract_features,
            fast_mode=req.fast_mode,
            segment_batch_size=req.segment_batch_size,
            detection_model=req.detection_model,
            rectify_mode=req.rectify_mode,
        )
    except Exception as e:
        logger.exception("panel analyze failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


class PanelAnalysisCancelled(Exception):
    pass


@app.post("/panel/analyze/stream")
async def api_panel_analyze_stream(req: PanelAnalyzeRequest, request: Request):
    """SSE-streaming panel analyze with progress updates.

    Sends heartbeat comments every 2s during idle periods to prevent
    the OS / reverse-proxy / Electron from killing the connection while
    AI models are loading or running inference.
    """
    _check_image_size(req.image)
    progress_q: queue.Queue = queue.Queue()
    cancel_event = threading.Event()

    def run():
        t0 = time.perf_counter()
        logger.info("[PANEL-STREAM] Analysis thread started")
        def on_progress(stage: str, pct: int, msg: str):
            if cancel_event.is_set():
                raise PanelAnalysisCancelled("Panel analysis cancelled")
            elapsed = (time.perf_counter() - t0) * 1000
            logger.info(f"[PANEL-STREAM] {stage} ({pct}%) +{elapsed:.0f}ms: {msg}")
            progress_q.put({"type": "progress", "stage": stage, "percent": pct, "message": msg})
        try:
            result = analyze_panel(
                req.image,
                min_confidence=req.min_confidence,
                detect_labels=req.detect_labels,
                segment=req.segment,
                extract_features_flag=req.extract_features,
                fast_mode=req.fast_mode,
                segment_batch_size=req.segment_batch_size,
                detection_model=req.detection_model,
                rectify_mode=req.rectify_mode,
                progress_cb=on_progress,
            )
            elapsed = (time.perf_counter() - t0) * 1000
            logger.info(f"[PANEL-STREAM] Analysis complete in {elapsed:.0f}ms")
            if not cancel_event.is_set():
                progress_q.put({"type": "done", "data": result})
        except PanelAnalysisCancelled:
            logger.info("[PANEL-STREAM] Analysis cancelled by client")
            if not cancel_event.is_set():
                progress_q.put({"type": "error", "message": "Analysis cancelled"})
        except Exception as exc:
            elapsed = (time.perf_counter() - t0) * 1000
            logger.error(f"[PANEL-STREAM] Analysis failed after {elapsed:.0f}ms: {exc}")
            if not cancel_event.is_set():
                progress_q.put({"type": "error", "message": _safe_error(exc)})

    threading.Thread(target=run, daemon=True).start()

    async def event_stream():
        heartbeat_interval = 2.0  # seconds between heartbeat comments
        last_data_time = time.monotonic()
        while True:
            if await request.is_disconnected():
                cancel_event.set()
                break
            try:
                item = progress_q.get_nowait()
                last_data_time = time.monotonic()
                yield f"data: {json.dumps(item)}\n\n"
                if item.get("type") in ("done", "error"):
                    break
            except queue.Empty:
                # Send SSE comment heartbeat to keep the connection alive
                if time.monotonic() - last_data_time > heartbeat_interval:
                    yield ": heartbeat\n\n"
                    last_data_time = time.monotonic()
                await asyncio.sleep(0.02)  # poll faster for smoother progress bar

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─── Commercial-Safe 3D Extraction (YOLOv10 / SAM2 / Depth-Anything-V2) ──────
# See directives/commercial_safe_3d_extraction.md for licensing notes.

class Extract3DBox(BaseModel):
    x: int
    y: int
    width: int
    height: int
    detected_type: Optional[str] = None


class Extract3DRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the source panel")
    boxes: Optional[List[Extract3DBox]] = Field(
        None, description="Optional user-supplied regions; skips detection when present"
    )


class NormalFromDepthRequest(BaseModel):
    depth: str = Field(..., description="Base64 data-URL of a grayscale depth map")
    strength: float = Field(2.0, ge=0.1, le=8.0)


@app.get("/pipeline/extract-3d/capabilities")
async def api_extract3d_capabilities():
    """Report which commercial-safe models are currently loadable."""
    try:
        return cs3d_capabilities()
    except Exception as e:
        raise HTTPException(status_code=500, detail=_safe_error(e))


@app.post("/pipeline/extract-3d")
async def api_extract3d(req: Extract3DRequest):
    """Batch (non-streaming) commercial-safe 3D extraction.

    Returns Diffuse + Normal + Depth + Alpha per component plus an
    inpainted background of the source panel.
    """
    _check_image_size(req.image)
    try:
        boxes = None
        types = None
        if req.boxes:
            boxes = [(b.x, b.y, b.width, b.height) for b in req.boxes]
            types = [b.detected_type or "unknown" for b in req.boxes]
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: cs3d_extract(req.image, requested_boxes=boxes, requested_types=types),
        )
        return {
            "components": [
                {
                    "detected_type": c.detected_type,
                    "confidence": c.confidence,
                    "bounds": {"x": c.bbox[0], "y": c.bbox[1], "width": c.bbox[2], "height": c.bbox[3]},
                    "diffuse_dataUrl": c.diffuse_dataUrl,
                    "normal_dataUrl": c.normal_dataUrl,
                    "depth_dataUrl": c.depth_dataUrl,
                    "alpha_dataUrl": c.alpha_dataUrl,
                    "source": c.source,
                }
                for c in result.components
            ],
            "inpainted_background_dataUrl": result.inpainted_background_dataUrl,
            "elapsed_ms": result.elapsed_ms,
            "notes": result.notes,
        }
    except Exception as e:
        logger.exception("extract-3d failed")
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/pipeline/extract-3d/stream")
async def api_extract3d_stream(req: Extract3DRequest):
    """SSE-streaming 3D extraction — the UI needs progress because depth +
    inpainting together often run 1–3s on CPU."""
    _check_image_size(req.image)
    boxes = [(b.x, b.y, b.width, b.height) for b in req.boxes] if req.boxes else None
    types = [b.detected_type or "unknown" for b in req.boxes] if req.boxes else None
    progress_q: queue.Queue = queue.Queue()

    def run():
        t0 = time.perf_counter()
        def on_progress(stage: str, pct: int, msg: str):
            progress_q.put({"type": "progress", "stage": stage, "percent": pct, "message": msg})
        try:
            result = cs3d_extract(
                req.image,
                progress=on_progress,
                requested_boxes=boxes,
                requested_types=types,
            )
            elapsed = (time.perf_counter() - t0) * 1000
            logger.info(f"[EXTRACT3D-STREAM] complete in {elapsed:.0f}ms")
            progress_q.put({
                "type": "done",
                "data": {
                    "components": [
                        {
                            "detected_type": c.detected_type,
                            "confidence": c.confidence,
                            "bounds": {"x": c.bbox[0], "y": c.bbox[1], "width": c.bbox[2], "height": c.bbox[3]},
                            "diffuse_dataUrl": c.diffuse_dataUrl,
                            "normal_dataUrl": c.normal_dataUrl,
                            "depth_dataUrl": c.depth_dataUrl,
                            "alpha_dataUrl": c.alpha_dataUrl,
                            "source": c.source,
                        }
                        for c in result.components
                    ],
                    "inpainted_background_dataUrl": result.inpainted_background_dataUrl,
                    "elapsed_ms": result.elapsed_ms,
                    "notes": result.notes,
                },
            })
        except Exception as exc:
            logger.exception("extract-3d stream failed")
            progress_q.put({"type": "error", "message": _safe_error(exc)})

    threading.Thread(target=run, daemon=True).start()

    async def event_stream():
        heartbeat_interval = 2.0
        last = time.monotonic()
        while True:
            try:
                item = progress_q.get_nowait()
                last = time.monotonic()
                yield f"data: {json.dumps(item)}\n\n"
                if item.get("type") in ("done", "error"):
                    break
            except queue.Empty:
                if time.monotonic() - last > heartbeat_interval:
                    yield ": heartbeat\n\n"
                    last = time.monotonic()
                await asyncio.sleep(0.04)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/pipeline/normal-from-depth")
async def api_normal_from_depth(req: NormalFromDepthRequest):
    """Standalone Sobel-cross-product normal-map generator. Used when the
    caller already has a depth map (e.g. from a prior extract-3d call)."""
    _check_image_size(req.depth, field="depth")
    try:
        import cv2 as _cv
        bgra = cs3d_b64_to_bgra(req.depth)
        gray = _cv.cvtColor(bgra, _cv.COLOR_BGRA2GRAY)
        normal = cs3d_generate_normal_map(gray, strength=req.strength)
        return {"dataUrl": cs3d_png_to_b64(normal)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


# ─── Pro Features Endpoints (Phase 7) ─────────────────────────

class BatchDetectRequest(BaseModel):
    image: str
    min_area: int = 400
    max_area: int = 0
    circle_bias: float = 0.6


class ColorVariantRequest(BaseModel):
    image: str
    hue_shift: float = 0.0
    saturation_scale: float = 1.0
    brightness_scale: float = 1.0
    colorize: Optional[List[int]] = None
    colorize_strength: float = 0.5


class ColorVariantsBatchRequest(BaseModel):
    image: str
    hue_shifts: List[float]


@app.post("/detect/batch")
async def api_batch_detect(req: BatchDetectRequest):
    _check_image_size(req.image)
    try:
        loop = asyncio.get_running_loop()
        detections = await loop.run_in_executor(
            None,
            lambda: batch_detect_components(
                req.image, req.min_area, req.max_area, req.circle_bias,
            ),
        )
        for i, det in enumerate(detections):
            cx = int(det["center"]["x"])
            cy = int(det["center"]["y"])
            det["id"] = f"det_{i}_{det['type']}_{cx}_{cy}"
        return {"detections": detections, "count": len(detections)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/color/variant")
async def api_color_variant(req: ColorVariantRequest):
    try:
        return generate_color_variant(
            req.image, req.hue_shift, req.saturation_scale,
            req.brightness_scale, req.colorize, req.colorize_strength,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/color/variants-batch")
async def api_color_variants_batch(req: ColorVariantsBatchRequest):
    try:
        variants = generate_color_variants_batch(req.image, req.hue_shifts)
        return {"variants": variants, "count": len(variants)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


# ─── AI Feature Endpoints (Phase 5) ───────────────────────────

class StyleTransferRequest(BaseModel):
    image: str
    style: str
    strength: float = 0.7


class ComponentDetectRequest(BaseModel):
    image: str
    min_area: int = 200
    max_area: int = 0
    confidence_threshold: float = 0.4


class LightingEstimateRequest(BaseModel):
    image: str


class LightingNormalizeRequest(BaseModel):
    image: str
    target_azimuth: float = 315
    target_elevation: float = 60
    strength: float = 0.7


class LightingHarmonizeRequest(BaseModel):
    images: List[str]
    target_azimuth: float = 315
    target_elevation: float = 60
    strength: float = 0.7


class UpscaleRequest(BaseModel):
    image: str
    scale: int = 2
    sharpen: float = 0.4
    prefer_ai: bool = True


class SymmetryDetectRequest(BaseModel):
    image: str


class SymmetryEnforceRequest(BaseModel):
    image: str
    symmetry_type: str = "auto"
    strength: float = 1.0


class InpaintRequest(BaseModel):
    image: str
    mask: str
    method: str = "telea"
    radius: int = 5


class TextDetectRequest(BaseModel):
    image: str


class AutoRemoveTextRequest(BaseModel):
    image: str
    method: str = "telea"
    radius: int = 5


class RemoveBackgroundRequest(BaseModel):
    image: str


class CenterCropRequest(BaseModel):
    image: str
    padding: int = 8


class GenerateComponentRequest(BaseModel):
    prompt: str
    component_type: str = "knob"
    style_preset: str = "modern"
    size: int = 512


@app.get("/ai/capabilities")
async def api_ai_capabilities():
    """Return which AI features are available."""
    sam2_status = check_sam2_available()
    panel_status = check_panel_pipeline_available()
    return {
        "style_transfer": True,
        "component_detection": True,
        "yolo_detection": check_yolo_available(),
        "yolo_pipeline": check_yolo_pipeline_available(),
        "lighting_normalize": True,
        "upscale_lanczos": True,
        "upscale_esrgan": check_esrgan_available(),
        "symmetry": True,
        "inpainting": True,
        "inpainting_lama": check_lama_available(),
        "background_removal": check_rembg_available(),
        "background_removal_basic": True,
        "prompt_to_component": check_sd_available(),
        "prompt_to_component_placeholder": True,
        # Gemma disabled — focused panel detector is used instead
        "gemma": False,
        "gemma_model": None,
        "gemma_status": {"available": False, "reason": "Gemma disabled — using Gemini/YOLO/OpenCV panel detection"},
        "florence2": panel_status.get("florence2", False),
        "florence2_backend": panel_status.get("florence2_backend", "none"),
        "sam2": sam2_status.get("available", False),
        "sam2_status": sam2_status,
    }


@app.get("/ai/styles")
async def api_get_styles():
    return {"styles": get_available_styles()}


@app.post("/ai/style-transfer")
async def api_style_transfer(req: StyleTransferRequest):
    try:
        return apply_style(req.image, req.style, req.strength)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/detect-components")
async def api_detect_components(req: ComponentDetectRequest):
    try:
        detections = detect_components(
            req.image, req.min_area, req.max_area, req.confidence_threshold,
        )
        return {"detections": detections, "count": len(detections)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/estimate-lighting")
async def api_estimate_lighting(req: LightingEstimateRequest):
    try:
        return estimate_lighting(req.image)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/normalize-lighting")
async def api_normalize_lighting(req: LightingNormalizeRequest):
    try:
        return normalize_lighting(
            req.image, req.target_azimuth, req.target_elevation, req.strength,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/harmonize-lighting")
async def api_harmonize_lighting(req: LightingHarmonizeRequest):
    try:
        results = harmonize_batch(
            req.images, req.target_azimuth, req.target_elevation, req.strength,
        )
        return {"results": results, "count": len(results)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/upscale")
async def api_upscale(req: UpscaleRequest):
    try:
        return upscale(req.image, req.scale, req.sharpen, req.prefer_ai)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/detect-symmetry")
async def api_detect_symmetry(req: SymmetryDetectRequest):
    try:
        return detect_symmetry(req.image)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/enforce-symmetry")
async def api_enforce_symmetry(req: SymmetryEnforceRequest):
    try:
        return enforce_symmetry(req.image, req.symmetry_type, req.strength)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/detect-text")
async def api_detect_text(req: TextDetectRequest):
    try:
        return detect_text_regions(req.image)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/inpaint")
async def api_inpaint(req: InpaintRequest):
    try:
        return inpaint(req.image, req.mask, req.method, req.radius)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/auto-remove-text")
async def api_auto_remove_text(req: AutoRemoveTextRequest):
    try:
        return auto_remove_text(req.image, req.method, req.radius)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/remove-background")
async def api_remove_background(req: RemoveBackgroundRequest):
    try:
        return remove_background(req.image)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/center-crop")
async def api_center_crop(req: CenterCropRequest):
    try:
        return center_and_crop(req.image, req.padding)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/ai/generate-component")
async def api_generate_component(req: GenerateComponentRequest):
    try:
        return generate_component(req.prompt, req.component_type, req.style_preset, req.size)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.get("/ai/generation-presets")
async def api_generation_presets():
    return {"presets": get_generation_presets()}


# ─── Gemma AI Endpoints (disabled — all serve 410 Gone) ────────────────────
# Gemma via Ollama has been replaced by the focused panel detector.
# These stubs ensure existing frontend callers get a clear error rather than
# a hard crash or 500.

_GEMMA_GONE = HTTPException(
    status_code=410,
    detail="Gemma endpoints are disabled. Use the panel detector (/panel/analyze).",
)


@app.get("/ai/gemma/status")
async def api_gemma_status():
    return {"available": False, "reason": "Gemma disabled — using Gemini/YOLO/OpenCV panel detection"}


@app.post("/ai/gemma/generate")
async def api_gemma_generate():
    raise _GEMMA_GONE


@app.post("/ai/gemma/analyze-panel")
async def api_gemma_analyze_panel():
    raise _GEMMA_GONE


@app.post("/ai/gemma/suggest-style")
async def api_gemma_suggest_style():
    raise _GEMMA_GONE


@app.post("/ai/gemma/name-component")
async def api_gemma_name_component():
    raise _GEMMA_GONE


@app.post("/ai/gemma/describe-layout")
async def api_gemma_describe_layout():
    raise _GEMMA_GONE


@app.post("/ai/gemma/enhance-detections")
async def api_gemma_enhance_detections():
    raise _GEMMA_GONE


# ─── SAM2 Segmentation Endpoints ─────────────────────────────

# ─── Pipeline Endpoints (Production-Grade CV) ─────────────────

class PipelineExtractRequest(BaseModel):
    image: str = Field(..., description="Base64 data-URL of the source panel photo")
    perspective_corners: Optional[List[List[float]]] = Field(
        None, description="4 corner points [TL, TR, BR, BL] for perspective correction"
    )
    output_width: Optional[int] = None
    output_height: Optional[int] = None
    detection_confidence: float = 0.25
    component_filter: Optional[List[str]] = Field(
        None, description="Only extract these types, e.g. ['knob', 'slider', 'screen']"
    )
    circle_snap_threshold: float = 0.90
    edge_width: float = 2.0
    padding: int = 2
    include_inpainted: bool = False
    inpaint_method: str = "telea"
    inpaint_radius: int = 5


class PipelineSingleRequest(BaseModel):
    image: str
    box: List[float] = Field(..., description="Bounding box [x1, y1, x2, y2]")
    component_type: str = "knob"
    perspective_corners: Optional[List[List[float]]] = None
    circle_snap_threshold: float = 0.90
    edge_width: float = 2.0
    padding: int = 2
    include_inpainted: bool = False
    inpaint_method: str = "telea"
    inpaint_radius: int = 5


class PerspectiveCorrectionRequest(BaseModel):
    image: str
    corners: List[List[float]] = Field(..., description="4 corner points [TL, TR, BR, BL]")
    output_width: Optional[int] = None
    output_height: Optional[int] = None


class PipelineInpaintRequest(BaseModel):
    image: str
    mask: str = Field(..., description="Base64 mask where 255 = area to fill")
    method: str = "telea"
    radius: int = 5


@app.post("/pipeline/extract")
async def api_pipeline_extract(req: PipelineExtractRequest):
    """Run the full multi-stage extraction pipeline.

    Detects all UI components (knobs, sliders, screens), segments them with
    SAM2, refines masks, extracts geometric metadata, and returns clean
    transparent PNGs with anti-aliased edges.
    """
    _check_image_size(req.image)
    try:
        return run_pipeline(
            image_b64=req.image,
            perspective_corners=req.perspective_corners,
            output_width=req.output_width,
            output_height=req.output_height,
            detection_confidence=req.detection_confidence,
            component_filter=req.component_filter,
            circle_snap_threshold=req.circle_snap_threshold,
            edge_width=req.edge_width,
            padding=req.padding,
            include_inpainted=req.include_inpainted,
            inpaint_method=req.inpaint_method,
            inpaint_radius=req.inpaint_radius,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/pipeline/extract-single")
async def api_pipeline_single(req: PipelineSingleRequest):
    """Extract a single component by bounding box through the refinement pipeline.

    Runs SAM2 segmentation, mask refinement, feature extraction, and output
    optimization on a user-specified region.
    """
    _check_image_size(req.image)
    try:
        return run_single_extract(
            image_b64=req.image,
            box=req.box,
            component_type=req.component_type,
            perspective_corners=req.perspective_corners,
            circle_snap_threshold=req.circle_snap_threshold,
            edge_width=req.edge_width,
            padding=req.padding,
            include_inpainted=req.include_inpainted,
            inpaint_method=req.inpaint_method,
            inpaint_radius=req.inpaint_radius,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/pipeline/perspective-correct")
async def api_pipeline_perspective(req: PerspectiveCorrectionRequest):
    """Apply 4-point perspective correction to make a panel top-down.

    Send the 4 corners of the panel in order [TL, TR, BR, BL].
    Returns the corrected image.
    """
    _check_image_size(req.image)
    try:
        img_bgra = _b64_to_bgra(req.image)
        warped, _ = proc_correct_perspective(
            img_bgra, req.corners, req.output_width, req.output_height,
        )
        h, w = warped.shape[:2]
        return {
            "dataUrl": proc_to_png_b64(warped),
            "bounds": {"x": 0, "y": 0, "width": w, "height": h},
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/pipeline/inpaint-background")
async def api_pipeline_inpaint(req: PipelineInpaintRequest):
    """Fill extracted regions using background inpainting.

    Useful for the Design workspace to produce a clean background
    after elements have been removed.
    """
    _check_image_size(req.image)
    _check_image_size(req.mask, "mask")
    try:
        img_bgr = _b64_to_bgr(req.image)
        mask_img = _b64_to_bgr(req.mask)
        import cv2 as _cv2
        mask_gray = _cv2.cvtColor(mask_img, _cv2.COLOR_BGR2GRAY)
        _, mask_bin = _cv2.threshold(mask_gray, 127, 255, _cv2.THRESH_BINARY)

        inpainted = proc_inpaint_background(img_bgr, mask_bin, req.method, req.radius)
        inpainted_bgra = _cv2.cvtColor(inpainted, _cv2.COLOR_BGR2BGRA)
        return {"dataUrl": proc_to_png_b64(inpainted_bgra)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.get("/pipeline/capabilities")
async def api_pipeline_capabilities():
    """Return which pipeline features are available."""
    sam2_status = check_sam2_available()
    return {
        "pipeline_available": True,
        "yolo_detection": check_yolo_pipeline_available(),
        "sam2_segmentation": sam2_status.get("available", False),
        "sam2_status": sam2_status,
        "perspective_correction": True,
        "mask_refinement": True,
        "geometric_fitting": True,
        "knob_physics": True,
        "slider_rail_detection": True,
        "antialiased_output": True,
        "background_inpainting": True,
        "heuristic_fallback": True,
    }


# ─── SAM2 Segmentation Endpoints ─────────────────────────────

class SAMPointRequest(BaseModel):
    image: str
    points: List[List[float]]
    labels: List[int]
    multimask: bool = True


class SAMBoxRequest(BaseModel):
    image: str
    box: List[float]  # [x1, y1, x2, y2]


class SAMAutoRequest(BaseModel):
    image: str
    min_area: int = 200


@app.get("/runtime")
async def api_runtime():
    """Report detected hardware and how resources are being used (device,
    cores, RAM/VRAM, thread fan-out, chosen model tier, ONNX providers)."""
    return runtime.runtime_report()


@app.get("/sam/status")
async def api_sam_status():
    """Check SAM2 availability."""
    return check_sam2_available()


@app.post("/sam/segment-point")
async def api_sam_segment_point(req: SAMPointRequest):
    """Segment using point prompts (click-based selection)."""
    try:
        return segment_point(req.image, req.points, req.labels, req.multimask)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/sam/segment-box")
async def api_sam_segment_box(req: SAMBoxRequest):
    """Segment using a bounding box prompt."""
    try:
        return segment_box(req.image, req.box)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


@app.post("/sam/auto-segment")
async def api_sam_auto_segment(req: SAMAutoRequest):
    """Automatically segment all objects in the image."""
    try:
        return auto_segment(req.image, req.min_area)
    except Exception as e:
        raise HTTPException(status_code=400, detail=_safe_error(e))


def main():
    parser = argparse.ArgumentParser(description="SynthSkin Studio Python Sidecar")
    parser.add_argument("--port", type=int, default=8321, help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()

    print(f"SynthSkin sidecar starting on {args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
