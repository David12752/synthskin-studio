"""Evaluate a trained SynthSkin YOLO detector and export visual previews."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from synth_dataset import DEFAULT_DATA, assert_dataset_ready, iter_images, resolve_dataset_root


ROOT = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = ROOT / "models" / "synthskin_yolo.pt"
DEFAULT_EVAL_DIR = ROOT / "runs" / "detect"


def _safe_metric(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def metrics_to_summary(metrics: Any) -> dict[str, Any]:
    box = getattr(metrics, "box", None)
    results_dict = getattr(metrics, "results_dict", None)
    summary: dict[str, Any] = {
        "map50": _safe_metric(getattr(box, "map50", None)),
        "map50_95": _safe_metric(getattr(box, "map", None)),
        "precision_mean": _safe_metric(getattr(box, "mp", None)),
        "recall_mean": _safe_metric(getattr(box, "mr", None)),
    }
    if isinstance(results_dict, dict):
        summary["raw"] = {str(k): _safe_metric(v) for k, v in results_dict.items()}
    return summary


def evaluate(
    weights: Path,
    data_yaml: Path,
    split: str,
    image_size: int,
    conf: float,
    device: str | None,
    max_preview: int,
) -> Path:
    if not weights.exists():
        raise FileNotFoundError(
            f"Weights not found: {weights}\n"
            "Train first, or pass --weights path/to/best.pt."
        )

    assert_dataset_ready(data_yaml, min_train=1, min_val=1)

    from ultralytics import YOLO

    model = YOLO(str(weights))
    eval_name = "synthskin_eval"
    preview_name = "synthskin_eval_previews"

    metrics = model.val(
        data=str(data_yaml),
        split=split,
        imgsz=image_size,
        conf=conf,
        device=device if device else None,
        project=str(DEFAULT_EVAL_DIR),
        name=eval_name,
        exist_ok=True,
        plots=True,
    )

    ds_root = resolve_dataset_root(data_yaml)
    source_dir = ds_root / "images" / split
    preview_images = iter_images(source_dir)[:max_preview]
    if preview_images:
        model.predict(
            source=[str(p) for p in preview_images],
            imgsz=image_size,
            conf=conf,
            device=device if device else None,
            save=True,
            save_txt=True,
            save_conf=True,
            project=str(DEFAULT_EVAL_DIR),
            name=preview_name,
            exist_ok=True,
            max_det=1000,
        )

    eval_dir = DEFAULT_EVAL_DIR / eval_name
    summary = metrics_to_summary(metrics)
    summary.update(
        {
            "weights": str(weights),
            "data": str(data_yaml),
            "split": split,
            "imgsz": image_size,
            "conf": conf,
            "preview_count": len(preview_images),
            "preview_dir": str(DEFAULT_EVAL_DIR / preview_name),
        }
    )
    out = eval_dir / "synthskin_eval_summary.json"
    eval_dir.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate SynthSkin YOLO detector and export preview overlays")
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS, help="Trained YOLO weights")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="YOLO dataset YAML")
    parser.add_argument("--split", default="val", choices=["train", "val", "test"], help="Dataset split to evaluate")
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--device", default=None, help="Examples: 0, cpu. Leave empty for auto")
    parser.add_argument("--max-preview", type=int, default=40, help="Number of images to export with prediction overlays")
    args = parser.parse_args()

    summary_path = evaluate(
        weights=args.weights.resolve(),
        data_yaml=args.data.resolve(),
        split=args.split,
        image_size=args.imgsz,
        conf=args.conf,
        device=args.device,
        max_preview=args.max_preview,
    )
    print(f"Evaluation summary: {summary_path}")
    print("Open the preview folder under python/runs/detect/synthskin_eval_previews to inspect detections visually.")


if __name__ == "__main__":
    main()
