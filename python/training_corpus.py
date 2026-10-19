"""App-managed training corpus helpers for SynthSkin panel detection."""
from __future__ import annotations

import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from synth_dataset import CLASS_NAMES, DEFAULT_DATA, ensure_dataset_dirs, resolve_dataset_root, validate_dataset

PY_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PY_ROOT.parent
CORPUS_ROOT = PROJECT_ROOT / "training-panel-corpus"
UPLOADS_DIR = CORPUS_ROOT / "uploads"
SAMPLES_DIR = CORPUS_ROOT / "samples"
REPORTS_DIR = CORPUS_ROOT / "reports"
MANIFEST_PATH = CORPUS_ROOT / "manifest.jsonl"
SUMMARY_PATH = CORPUS_ROOT / "summary.json"
README_PATH = CORPUS_ROOT / "README.md"

VAL_SPLIT_RATIO = 0.2

_DIRECT_TYPE_MAP = {
    "knob": "knob",
    "slider_cap": "slider_cap",
    "slider_track": "slider_track",
    "led": "led_light",
    "led_light": "led_light",
    "led_screen": "led_screen",
    "meter": "meter_screen",
    "meter_screen": "meter_screen",
    "meter_needle": "meter_needle",
    "meter_range": "meter_range",
    "text": "text",
    "label": "text",
    # Pushbuttons/toggles were previously unmapped, so every detected button was
    # silently dropped from the YOLO labels (WAVESTRUCT: 46/104 controls lost).
    "button": "button",
    "switch": "switch",
    "toggle": "switch",
}

# Coarse pipeline types that decompose into more than one fine-grained class.
# A "fader" is a linear slider; a "display" is a screen — handle them identically.
_SLIDER_TYPES = {"slider", "fader"}
_SCREEN_TYPES = {"screen", "display"}
_IMAGE_EXT_MAP = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slugify(text: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9_-]+", "-", text.strip())
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text or "panel"


def _read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default
    return loaded if isinstance(loaded, dict) else default


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _write_readme(dataset_root: Path) -> None:
    if README_PATH.exists():
        return
    README_PATH.write_text(
        "\n".join([
            "# SynthSkin Training Corpus",
            "",
            "This folder is managed by the app.",
            "",
            f"- Drop raw panel screenshots into: {UPLOADS_DIR}",
            f"- Curated saved samples are written to: {SAMPLES_DIR}",
            f"- YOLO dataset images/labels are synced to: {dataset_root}",
            f"- Preflight/training reports are written to: {REPORTS_DIR}",
            "",
            "Recommended workflow:",
            "1. Open a panel image in the Extract workspace.",
            "2. Run Panel Analysis.",
            "3. Fix boxes/types in Edit Mode.",
            "4. Save the current analysis to the training corpus.",
            "5. Run preflight and then training from the analyzer panel.",
            "",
            "Classes:",
            *[f"- {name}" for name in CLASS_NAMES],
            "",
        ]),
        encoding="utf-8",
    )


def ensure_training_corpus() -> dict[str, str]:
    dataset_root = ensure_dataset_dirs(DEFAULT_DATA)
    for path in (CORPUS_ROOT, UPLOADS_DIR, SAMPLES_DIR, REPORTS_DIR):
        path.mkdir(parents=True, exist_ok=True)
    _write_readme(dataset_root)
    return {
        "corpus_root": str(CORPUS_ROOT),
        "uploads_dir": str(UPLOADS_DIR),
        "samples_dir": str(SAMPLES_DIR),
        "reports_dir": str(REPORTS_DIR),
        "dataset_root": str(dataset_root),
    }


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    if "," not in data_url:
        raise ValueError("Invalid image data URL")
    header, payload = data_url.split(",", 1)
    mime = "image/png"
    if header.startswith("data:"):
        mime = header[5:].split(";", 1)[0] or mime
    ext = _IMAGE_EXT_MAP.get(mime.lower(), ".png")
    return base64.b64decode(payload), ext


def _normalize_bbox(bbox: Any) -> list[float] | None:
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox]
    except Exception:
        return None
    if x2 <= x1 or y2 <= y1:
        return None
    return [x1, y1, x2, y2]


def _append_annotation(out: list[dict[str, Any]], class_name: str, bbox: Any, source: str, ref_id: str | None = None) -> None:
    norm = _normalize_bbox(bbox)
    if norm is None or class_name not in CLASS_NAMES:
        return
    out.append({
        "class_name": class_name,
        "bbox": norm,
        "source": source,
        "ref_id": ref_id,
    })


def _infer_screen_class(control: dict[str, Any]) -> str:
    features = control.get("features") if isinstance(control.get("features"), dict) else {}
    sub_type = str(control.get("sub_type") or "").lower()
    phrase = str(control.get("phrase") or "").lower()
    kind = str(features.get("screen_kind") or "").lower()
    blob = " ".join((sub_type, phrase, kind))
    if any(token in blob for token in ("vu", "meter", "needle", "gauge")):
        return "meter_screen"
    if any(token in blob for token in ("led", "segment", "display", "readout", "digital")):
        return "led_screen"
    return "led_screen"


def annotations_from_layout(
    layout: dict[str, Any],
    include_text_labels: bool = True,
    *,
    dropped: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    """Convert a panel layout into YOLO-ready annotations.

    Pass ``dropped`` (a dict) to collect a count of control types that have no
    target class and were skipped — a guard so a future taxonomy gap surfaces
    instead of silently shrinking the training set.
    """
    annotations: list[dict[str, Any]] = []
    controls = layout.get("controls") if isinstance(layout.get("controls"), list) else []
    labels = layout.get("labels") if isinstance(layout.get("labels"), list) else []

    for control in controls:
        if not isinstance(control, dict):
            continue
        control_id = str(control.get("id") or "") or None
        control_type = str(control.get("type") or "").lower()
        bbox = control.get("refined_bbox") or control.get("bbox")
        features = control.get("features") if isinstance(control.get("features"), dict) else {}

        if control_type in _SLIDER_TYPES:
            _append_annotation(annotations, "slider_track", bbox, f"control:{control_type}_track", control_id)
            _append_annotation(annotations, "slider_cap", features.get("cap_bbox"), f"control:{control_type}_cap", control_id)
            continue
        if control_type in _SCREEN_TYPES:
            _append_annotation(annotations, _infer_screen_class(control), bbox, f"control:{control_type}", control_id)
            continue
        direct = _DIRECT_TYPE_MAP.get(control_type)
        if direct:
            _append_annotation(annotations, direct, bbox, f"control:{control_type}", control_id)
        elif control_type and dropped is not None:
            # No target class for this type — record it instead of dropping silently.
            dropped[control_type] = dropped.get(control_type, 0) + 1

    if include_text_labels:
        for label in labels:
            if not isinstance(label, dict):
                continue
            label_id = str(label.get("id") or "") or None
            _append_annotation(annotations, "text", label.get("bbox"), "ocr:label", label_id)

    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, tuple[int, int, int, int]]] = set()
    for item in annotations:
        x1, y1, x2, y2 = item["bbox"]
        key = (item["class_name"], (round(x1), round(y1), round(x2), round(y2)))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _bbox_to_yolo(bbox: list[float], width: int, height: int) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = bbox
    xc = ((x1 + x2) / 2.0) / max(width, 1)
    yc = ((y1 + y2) / 2.0) / max(height, 1)
    bw = (x2 - x1) / max(width, 1)
    bh = (y2 - y1) / max(height, 1)
    return xc, yc, bw, bh


def _clip_bbox_to_image(bbox: list[float], width: int, height: int) -> list[float] | None:
    x1, y1, x2, y2 = bbox
    x1 = max(0.0, min(float(width), x1))
    y1 = max(0.0, min(float(height), y1))
    x2 = max(0.0, min(float(width), x2))
    y2 = max(0.0, min(float(height), y2))
    if x2 <= x1 or y2 <= y1:
        return None
    return [x1, y1, x2, y2]


def _choose_split(split: str, sample_key: str) -> str:
    if split in {"train", "val"}:
        return split
    ratio_bucket = int(hashlib.sha1(sample_key.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "val" if ratio_bucket < VAL_SPLIT_RATIO else "train"


def _load_summary() -> dict[str, Any]:
    return _read_json(
        SUMMARY_PATH,
        {
            "updated_at": None,
            "sample_count": 0,
            "split_counts": {"train": 0, "val": 0},
            "class_counts": {name: 0 for name in CLASS_NAMES},
            "last_sample_id": None,
        },
    )


def _update_summary(sample_id: str, split: str, annotations: list[dict[str, Any]]) -> dict[str, Any]:
    summary = _load_summary()
    summary["updated_at"] = _utc_now()
    summary["sample_count"] = int(summary.get("sample_count") or 0) + 1
    split_counts = summary.get("split_counts") or {}
    split_counts[split] = int(split_counts.get(split) or 0) + 1
    summary["split_counts"] = split_counts
    class_counts = summary.get("class_counts") or {name: 0 for name in CLASS_NAMES}
    counts = Counter(item["class_name"] for item in annotations)
    for class_name, count in counts.items():
        class_counts[class_name] = int(class_counts.get(class_name) or 0) + count
    summary["class_counts"] = class_counts
    summary["last_sample_id"] = sample_id
    _write_json(SUMMARY_PATH, summary)
    return summary


def save_layout_sample(
    *,
    image_data_url: str,
    image_width: int,
    image_height: int,
    layout: dict[str, Any],
    source_name: str | None = None,
    source_path: str | None = None,
    split: str = "auto",
    include_text_labels: bool = True,
    notes: str | None = None,
) -> dict[str, Any]:
    paths = ensure_training_corpus()
    dataset_root = Path(paths["dataset_root"])

    image_bytes, ext = _decode_data_url(image_data_url)
    display_name = source_name or (Path(source_path).stem if source_path else "panel")
    display_name = display_name or "panel"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    digest = hashlib.sha1(image_bytes).hexdigest()[:8]
    sample_id = f"{stamp}-{_slugify(display_name)}-{digest}"
    chosen_split = _choose_split(split, sample_id)

    annotations = []
    for item in annotations_from_layout(layout, include_text_labels=include_text_labels):
        clipped = _clip_bbox_to_image(item["bbox"], image_width, image_height)
        if clipped is None:
            continue
        annotations.append({**item, "bbox": clipped})
    dataset_image = dataset_root / "images" / chosen_split / f"{sample_id}{ext}"
    dataset_label = dataset_root / "labels" / chosen_split / f"{sample_id}.txt"
    sample_dir = SAMPLES_DIR / sample_id
    sample_dir.mkdir(parents=True, exist_ok=True)

    dataset_image.write_bytes(image_bytes)
    (sample_dir / f"source{ext}").write_bytes(image_bytes)

    lines: list[str] = []
    for item in annotations:
        xc, yc, bw, bh = _bbox_to_yolo(item["bbox"], image_width, image_height)
        class_id = CLASS_NAMES.index(item["class_name"])
        lines.append(f"{class_id} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}")
    dataset_label.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    (sample_dir / "labels.txt").write_text(dataset_label.read_text(encoding="utf-8"), encoding="utf-8")

    class_counts = Counter(item["class_name"] for item in annotations)
    record = {
        "sample_id": sample_id,
        "created_at": _utc_now(),
        "split": chosen_split,
        "source_name": source_name,
        "source_path": source_path,
        "notes": notes,
        "image_width": image_width,
        "image_height": image_height,
        "dataset_image": str(dataset_image),
        "dataset_label": str(dataset_label),
        "analysis_path": str(sample_dir / "analysis.json"),
        "classes": dict(class_counts),
        "annotation_count": len(annotations),
    }
    analysis_payload = {
        **record,
        "annotations": annotations,
        "layout": layout,
    }
    _write_json(sample_dir / "analysis.json", analysis_payload)
    with MANIFEST_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    summary = _update_summary(sample_id, chosen_split, annotations)

    return {
        **record,
        "corpus_root": str(CORPUS_ROOT),
        "uploads_dir": str(UPLOADS_DIR),
        "summary": summary,
    }


def get_training_corpus_status() -> dict[str, Any]:
    paths = ensure_training_corpus()
    dataset_root = Path(paths["dataset_root"])
    summary = _load_summary()
    stats = validate_dataset(DEFAULT_DATA, min_train=0, min_val=0, require_boxes=False)
    return {
        "corpus_root": str(CORPUS_ROOT),
        "uploads_dir": str(UPLOADS_DIR),
        "samples_dir": str(SAMPLES_DIR),
        "reports_dir": str(REPORTS_DIR),
        "dataset_root": str(dataset_root),
        "dataset_yaml": str(DEFAULT_DATA),
        "class_names": list(CLASS_NAMES),
        "sample_count": int(summary.get("sample_count") or 0),
        "split_counts": summary.get("split_counts") or {"train": 0, "val": 0},
        "class_counts": summary.get("class_counts") or {name: 0 for name in CLASS_NAMES},
        "last_sample_id": summary.get("last_sample_id"),
        "updated_at": summary.get("updated_at"),
        "dataset": stats.to_dict(),
        "ready_for_training": stats.total_boxes > 0 and stats.errors == 0,
    }


__all__ = [
    "CLASS_NAMES",
    "CORPUS_ROOT",
    "MANIFEST_PATH",
    "REPORTS_DIR",
    "SAMPLES_DIR",
    "SUMMARY_PATH",
    "UPLOADS_DIR",
    "annotations_from_layout",
    "ensure_training_corpus",
    "get_training_corpus_status",
    "save_layout_sample",
]
