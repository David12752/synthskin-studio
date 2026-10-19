"""Prepare and validate the SynthSkin YOLO training dataset."""
from __future__ import annotations

import argparse
from pathlib import Path

from synth_dataset import (
    DEFAULT_DATA,
    ensure_dataset_dirs,
    format_validation_report,
    import_raw_images,
    validate_dataset,
    write_validation_report,
)


ROOT = Path(__file__).resolve().parent
DEFAULT_REPORT_DIR = ROOT / "runs" / "detect" / "dataset_preflight"


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare/validate SynthSkin YOLO dataset")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="YOLO dataset YAML")
    parser.add_argument("--init", action="store_true", help="Create dataset folders and README")
    parser.add_argument("--raw-dir", type=Path, default=None, help="Optional folder of raw images to split into train/val")
    parser.add_argument("--move", action="store_true", help="Move raw images instead of copying them")
    parser.add_argument("--val-ratio", type=float, default=0.2, help="Validation split ratio when importing raw images")
    parser.add_argument("--seed", type=int, default=7, help="Deterministic split seed")
    parser.add_argument("--min-train", type=int, default=0, help="Minimum train images for validation gate")
    parser.add_argument("--min-val", type=int, default=0, help="Minimum val images for validation gate")
    parser.add_argument("--allow-empty", action="store_true", help="Do not fail when no labeled boxes exist yet")
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR, help="Where to write preflight reports")
    args = parser.parse_args()

    data_yaml = args.data.resolve()

    if args.init or args.raw_dir:
        root = ensure_dataset_dirs(data_yaml)
        print(f"Dataset folders ready: {root}")

    if args.raw_dir:
        train_count, val_count = import_raw_images(
            raw_dir=args.raw_dir.resolve(),
            data_yaml=data_yaml,
            val_ratio=args.val_ratio,
            seed=args.seed,
            copy=not args.move,
        )
        print(f"Imported raw images: train={train_count}, val={val_count}")
        print("Empty label files were created. Add boxes before real training.")

    stats = validate_dataset(
        data_yaml,
        min_train=args.min_train,
        min_val=args.min_val,
        require_boxes=not args.allow_empty,
    )
    text_path, json_path = write_validation_report(stats, args.report_dir.resolve())
    print(format_validation_report(stats, max_issues=30))
    print(f"\nReports written:\n  {text_path}\n  {json_path}")

    if stats.errors:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
