"""
layout_manifest.py — the single versioned export contract, layout.json v1.

Today the machine-readable truth about an exported panel is scattered across the
JUCE export JSON, the atlas JSON, and the Design XML. A third-party consumer (or
our own JUCE generator / TCP bridge) has to stitch them together. v1 collapses
that into ONE file: per asset, everything a UI builder needs — identity, type,
rect in ORIGINAL image coordinates, pivot, knob/slider angle range + default,
the scales that were produced, output file paths, and a content hash.

Pure stdlib + numpy-free. Build it from the analyzed controls (+ optional export
file map), then write it alongside the exported assets.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

SCHEMA = "synthskin.layout/v1"


def _rect_from_control(c: Dict[str, Any]) -> List[int]:
    """[x, y, w, h] in ORIGINAL image coords, preferring the mask-refined bbox."""
    bb = c.get("refined_bbox") or c.get("mask_bbox") or c.get("bbox") or [0, 0, 0, 0]
    x1, y1, x2, y2 = [int(round(v)) for v in bb]
    return [x1, y1, max(0, x2 - x1), max(0, y2 - y1)]


def _pivot_from_control(c: Dict[str, Any], rect: List[int]) -> List[float]:
    """Rotation pivot: the fitted circle centre for knobs/LEDs, else rect centre."""
    circ = c.get("circle")
    if circ and "cx" in circ and "cy" in circ:
        return [round(float(circ["cx"]), 2), round(float(circ["cy"]), 2)]
    return [round(rect[0] + rect[2] / 2.0, 2), round(rect[1] + rect[3] / 2.0, 2)]


def _angle_from_control(c: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    f = c.get("features") or {}
    if not f.get("has_pointer") and "value_normalized" not in f:
        return None
    out: Dict[str, Any] = {}
    if "min_angle_deg" in f:
        out["min_deg"] = f["min_angle_deg"]
    if "max_angle_deg" in f:
        out["max_deg"] = f["max_angle_deg"]
    if "pointer_angle_deg" in f:
        out["default_deg"] = f["pointer_angle_deg"]
    if "value_normalized" in f:
        out["value_normalized"] = f["value_normalized"]
    return out or None


def build_layout_manifest(
    controls: List[Dict[str, Any]],
    image_width: int,
    image_height: int,
    *,
    source_hash: Optional[str] = None,
    rectified: bool = False,
    files_by_id: Optional[Dict[str, Dict[str, str]]] = None,
    scales_by_id: Optional[Dict[str, List[int]]] = None,
    include_semantics: bool = True,
    include_shapes: bool = True,
    include_interaction: bool = True,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Assemble the layout.json v1 manifest.

    files_by_id / scales_by_id let an export step attach produced file paths and
    scales per asset id; both are optional so the manifest is useful pre-export.

    include_semantics attaches a ``semantics`` block (nesting tree + flex/grid
    hints + alignment guides) inferred from the asset rects, so a downstream LLM
    receives a logical DOM instead of a flat pile of coordinates.

    include_shapes attaches, per asset, the simplest PARAMETRIC shape (circle /
    rect / rounded_rect / ellipse / polygon) + an SVG path fitted from its mask —
    so a consumer gets `border-radius` and true circles, not a traced blob.
    """
    files_by_id = files_by_id or {}
    scales_by_id = scales_by_id or {}

    _shape_fit = None
    if include_shapes:
        try:
            import shape_fit as _shape_fit  # lazy: pulls cv2/numpy only when asked
        except Exception:
            _shape_fit = None

    assets: List[Dict[str, Any]] = []
    for c in controls:
        cid = str(c.get("id"))
        rect = _rect_from_control(c)
        asset: Dict[str, Any] = {
            "id": cid,
            "type": c.get("type"),
            "parameter_id": c.get("parameter_id"),
            "display_name": c.get("display_name"),
            "provenance": c.get("provenance", "ai"),
            "rect": rect,
            "pivot": _pivot_from_control(c, rect),
        }
        angle = _angle_from_control(c)
        if angle:
            asset["angle"] = angle
        if c.get("label"):
            lab = c["label"]
            asset["label"] = lab.get("text") if isinstance(lab, dict) else lab
        if cid in scales_by_id:
            asset["scales"] = scales_by_id[cid]
        if cid in files_by_id:
            asset["files"] = files_by_id[cid]
            asset["hash"] = _hash_files(files_by_id[cid])
        if _shape_fit is not None:
            try:
                shape = _shape_fit.fit_from_control(c)
            except Exception:
                shape = None
            if shape is not None:
                asset["shape"] = shape
        if include_interaction:
            try:
                import interaction_presets
                inter = interaction_presets.preset_for(
                    c.get("type"), width=rect[2], height=rect[3]
                )
            except Exception:
                inter = None
            if inter is not None:
                asset["interaction"] = inter
        assets.append(asset)

    manifest: Dict[str, Any] = {
        "schema": SCHEMA,
        "generator": "SynthSkin Studio",
        "created": datetime.now(timezone.utc).isoformat(),
        "source": {
            "width": int(image_width),
            "height": int(image_height),
            "rectified": bool(rectified),
        },
        "asset_count": len(assets),
        "assets": assets,
    }
    if source_hash:
        manifest["source"]["hash"] = source_hash
    if include_semantics and assets:
        # Infer from the built assets so tree rects match the manifest exactly.
        try:
            import layout_semantics
            manifest["semantics"] = layout_semantics.analyze_layout(
                assets, int(image_width), int(image_height)
            )
        except Exception:
            # Semantics is advisory; never let it break the core manifest.
            pass
    if extra:
        manifest.update(extra)
    return manifest


def _hash_files(files: Dict[str, str]) -> str:
    h = hashlib.sha256()
    for k in sorted(files):
        h.update(k.encode("utf-8"))
        h.update(str(files[k]).encode("utf-8"))
    return "sha256:" + h.hexdigest()[:16]


def manifest_from_analysis(result: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
    """Convenience: build a manifest straight from an ``analyze_panel`` result."""
    rect = result.get("rectification") or {}
    return build_layout_manifest(
        result.get("controls", []),
        result.get("imageWidth", 0),
        result.get("imageHeight", 0),
        rectified=bool(rect.get("applied")),
        **kwargs,
    )


def to_json(manifest: Dict[str, Any]) -> str:
    return json.dumps(manifest, indent=2, ensure_ascii=False)
