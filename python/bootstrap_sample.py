"""
bootstrap_sample.py — Stage-0 connector test for the SynthSkin training corpus.

Turns ONE panel analysis into a labelled YOLO sample. It feeds a panel layout —
either re-run live via ``panel_pipeline.analyze_panel`` or loaded from a saved
``layout.json`` (e.g. a dogfood run) — through
``training_corpus.save_layout_sample`` so the panel lands in
``datasets/synth_panel/`` as ``images/<split>/*.png`` + ``labels/<split>/*.txt``.

It exists to PROVE the Gemini→dataset bootstrap loop end-to-end and to make any
data loss visible: it prints the per-type control distribution, the resulting
per-class YOLO annotation counts, and a *leak guard* listing any control type
that has no target class (so a future taxonomy gap can never shrink the training
set silently — the bug that dropped 46/104 WAVESTRUCT controls).

Usage (from ``python/`` with the venv active):

  # Fast: reuse a saved analysis, just exercise the connector
  .venv/Scripts/python.exe bootstrap_sample.py \
      --layout ../.tmp/dogfood_v4/layout.json \
      --image "../.tmp/ChatGPT Image Jun 30, 2026, 01_59_02 PM.png"

  # Full: re-run live detection, then save the sample
  .venv/Scripts/python.exe bootstrap_sample.py --reanalyze --image <panel.png>

  # Preview only — compute labels, write nothing
  .venv/Scripts/python.exe bootstrap_sample.py --layout <layout.json> --image <panel.png> --dry-run
"""
from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Optional

# ── repo geometry ────────────────────────────────────────────────────────────
PY_ROOT = Path(__file__).resolve().parent          # synthskin-studio/python
PROJECT_ROOT = PY_ROOT.parent                       # synthskin-studio
TMP_DIR = PROJECT_ROOT / ".tmp"

# Ensure local modules (training_corpus, panel_pipeline, runtime) import cleanly
# regardless of the caller's working directory.
sys.path.insert(0, str(PY_ROOT))

_EXT_TO_MIME = {
    ".png": "png",
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".webp": "webp",
    ".bmp": "bmp",
    ".tif": "tiff",
    ".tiff": "tiff",
}
_IMAGE_GLOBS = ("*.png", "*.jpg", "*.jpeg", "*.webp", "*.bmp")


def _fail(msg: str, code: int = 2) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return code


def resolve_image(explicit: Optional[str]) -> Optional[Path]:
    """Return the source panel image.

    Prefers an explicit ``--image``; otherwise scans the documented input dir and
    the ``.tmp`` root, picking the most recently modified candidate.
    """
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None

    candidates: list[Path] = []
    for base in (TMP_DIR / "dogfood_input", TMP_DIR):
        if not base.exists():
            continue
        for pattern in _IMAGE_GLOBS:
            candidates.extend(Path(p) for p in glob.glob(str(base / pattern)))
    if not candidates:
        return None
    # Newest first — the source panel is typically the freshest image dropped in.
    return sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def image_to_data_url(path: Path) -> str:
    raw = path.read_bytes()
    mime = _EXT_TO_MIME.get(path.suffix.lower(), "png")
    return f"data:image/{mime};base64," + base64.b64encode(raw).decode("ascii")


def image_dims(path: Path) -> tuple[int, int]:
    """Return (width, height) for the source image, authoritative for the bytes
    we actually write into the dataset."""
    import cv2  # local import: heavy, only needed here
    import numpy as np

    arr = np.frombuffer(path.read_bytes(), np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Could not decode image: {path}")
    h, w = img.shape[:2]
    return int(w), int(h)


def load_layout(layout_path: Optional[str], image_data_url: str, *, min_conf: float,
                detect_labels: bool) -> dict[str, Any]:
    """Get a panel layout: from a saved JSON, or by re-running the live pipeline."""
    if layout_path:
        data = json.loads(Path(layout_path).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"Layout JSON is not an object: {layout_path}")
        return data

    print("Re-analyzing live (this can take ~60s on CPU)…", flush=True)
    import runtime
    import panel_pipeline as pp

    runtime.configure_threads()
    return pp.analyze_panel(
        image_data_url,
        min_confidence=min_conf,
        detect_labels=detect_labels,
        segment=True,
        extract_features_flag=True,
    )


def find_latest_layout() -> Optional[Path]:
    hits = [Path(p) for p in glob.glob(str(TMP_DIR / "**" / "layout.json"), recursive=True)]
    if not hits:
        return None
    return sorted(hits, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def _control_type_counts(layout: dict[str, Any]) -> Counter:
    controls = layout.get("controls") if isinstance(layout.get("controls"), list) else []
    return Counter(
        str(c.get("type") or "?").lower()
        for c in controls
        if isinstance(c, dict)
    )


def _print_table(title: str, counts: Counter) -> None:
    print(f"\n{title}")
    if not counts:
        print("  (none)")
        return
    width = max(len(k) for k in counts)
    for name, n in counts.most_common():
        print(f"  {name.ljust(width)}  {n}")
    print(f"  {'TOTAL'.ljust(width)}  {sum(counts.values())}")


def main() -> int:
    # Some Windows consoles default to a legacy codepage (e.g. cp1255 on Hebrew
    # locales) that cannot encode status glyphs. Force UTF-8 and never crash on it.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="Bootstrap one panel into the YOLO training corpus.")
    ap.add_argument("--image", default=None, help="source panel image (default: newest in .tmp)")
    ap.add_argument("--layout", default=None,
                    help="use a saved analyze_panel layout.json instead of re-running detection")
    ap.add_argument("--reanalyze", action="store_true",
                    help="force a fresh live analysis even if a saved layout exists")
    ap.add_argument("--split", default="auto", choices=["auto", "train", "val"])
    ap.add_argument("--no-labels", action="store_true", help="exclude OCR text boxes from the sample")
    ap.add_argument("--dry-run", action="store_true", help="compute + report only; write nothing")
    ap.add_argument("--min-conf", type=float, default=0.40, help="min confidence when --reanalyze")
    ap.add_argument("--notes", default=None, help="free-text note stored on the sample")
    args = ap.parse_args()

    # Import the connector under test (after sys.path is set).
    from training_corpus import (
        annotations_from_layout,
        get_training_corpus_status,
        save_layout_sample,
    )

    # ── resolve inputs ───────────────────────────────────────────────────────
    image_path = resolve_image(args.image)
    if image_path is None:
        return _fail(f"No source image. Pass --image, or drop one in {TMP_DIR}")
    print(f"Image:  {image_path}")

    try:
        width, height = image_dims(image_path)
    except Exception as exc:  # noqa: BLE001 - report and abort cleanly
        return _fail(f"image decode failed: {exc}")
    print(f"Dims:   {width}x{height}")

    data_url = image_to_data_url(image_path)

    layout_path = args.layout
    if not layout_path and not args.reanalyze:
        latest = find_latest_layout()
        if latest:
            layout_path = str(latest)
            print(f"Layout: {layout_path}  (newest saved analysis; use --reanalyze to re-run)")
    if not layout_path:
        print("Layout: <live analysis>")

    try:
        layout = load_layout(layout_path, data_url, min_conf=args.min_conf,
                             detect_labels=not args.no_labels)
    except Exception as exc:  # noqa: BLE001
        return _fail(f"could not obtain layout: {exc}")

    # ── dimension sanity: layout coords must match the bytes we write ─────────
    lw, lh = layout.get("imageWidth"), layout.get("imageHeight")
    if isinstance(lw, int) and isinstance(lh, int) and (lw, lh) != (width, height):
        print(f"\n[WARN] layout was computed at {lw}x{lh} but the image is "
              f"{width}x{height}. YOLO boxes would be misaligned — use the matching "
              f"source image. Aborting.")
        return 1

    # ── leak guard + distributions ───────────────────────────────────────────
    dropped: dict[str, int] = {}
    annotations = annotations_from_layout(layout, include_text_labels=not args.no_labels, dropped=dropped)
    ctrl_counts = _control_type_counts(layout)
    ann_counts = Counter(a["class_name"] for a in annotations)

    _print_table("Control types detected (input):", ctrl_counts)
    _print_table("YOLO annotations produced (output classes):", ann_counts)

    print("\nLeak guard - control types with NO target class:")
    if dropped:
        for name, n in sorted(dropped.items(), key=lambda kv: -kv[1]):
            print(f"  [DROP] {name}: {n} control(s) dropped")
    else:
        print("  [OK] none - every detected control type maps to a class")

    before = get_training_corpus_status()

    if args.dry_run:
        print("\n[dry-run] No sample written. "
              f"Would add {len(annotations)} boxes across {len(ann_counts)} classes.")
        return 0

    # ── write the sample ─────────────────────────────────────────────────────
    record = save_layout_sample(
        image_data_url=data_url,
        image_width=width,
        image_height=height,
        layout=layout,
        source_name=image_path.stem,
        source_path=str(image_path),
        split=args.split,
        include_text_labels=not args.no_labels,
        notes=args.notes,
    )
    after = record.get("summary", get_training_corpus_status())

    label_file = Path(record["dataset_label"])
    image_file = Path(record["dataset_image"])
    print("\n-- Sample written --------------------------------------------")
    print(f"  sample_id:   {record['sample_id']}")
    print(f"  split:       {record['split']}")
    print(f"  annotations: {record['annotation_count']}")
    print(f"  classes:     {record['classes']}")
    print(f"  image:       {image_file}  (exists={image_file.exists()})")
    print(f"  label:       {label_file}  (exists={label_file.exists()})")

    if label_file.exists():
        lines = label_file.read_text(encoding="utf-8").splitlines()
        print(f"\n  label preview ({len(lines)} lines, '<class_id> xc yc w h'):")
        for line in lines[:6]:
            print(f"    {line}")
        if len(lines) > 6:
            print(f"    ... (+{len(lines) - 6} more)")

    print("\n-- Corpus totals ---------------------------------------------")
    print(f"  samples: {before.get('sample_count')} → {after.get('sample_count')}")
    print(f"  splits:  {after.get('split_counts')}")
    nonzero = {k: v for k, v in (after.get('class_counts') or {}).items() if v}
    print(f"  class_counts (nonzero): {nonzero}")
    print(f"  ready_for_training: {get_training_corpus_status().get('ready_for_training')}")
    print(f"\nReset hint: delete '{PROJECT_ROOT / 'training-panel-corpus'}' and the "
          f"images/labels under the dataset root to clear samples.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
