"""Train the SynthSkin YOLO detector for panel controls.

This script is the production path for reliable detection.  Generic COCO YOLO
models do not know synth/audio UI controls; train this detector and the panel
pipeline will automatically load python/models/synthskin_yolo.pt.

Dataset layout is standard YOLO:
    datasets/synth_panel/images/train/*.png|jpg
    datasets/synth_panel/images/val/*.png|jpg
    datasets/synth_panel/labels/train/*.txt
    datasets/synth_panel/labels/val/*.txt

Classes are defined centrally in synth_dataset.CLASS_NAMES and currently cover
coarse controls plus fine-grained motion parts such as slider caps/tracks,
meter needles/ranges, LED screens, and text.
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from synth_dataset import DEFAULT_DATA, assert_dataset_ready, format_validation_report, write_validation_report


ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT / "models" / "synthskin_yolo.pt"
DEFAULT_REPORT_DIR = ROOT / "runs" / "detect" / "dataset_preflight"


def train_detector(
    data_yaml: Path,
    base_model: str,
    epochs: int,
    image_size: int,
    batch: int,
    device: str | None,
    output_path: Path,
    min_train: int,
    min_val: int,
    workers: int,
    cache: bool | str,
    project: Path,
    run_name: str,
    preflight_checked: bool = False,
    *,
    optimizer: str = "auto",
    lr0: float = 0.01,
    lrf: float = 0.01,
    momentum: float = 0.937,
    weight_decay: float = 0.0005,
    warmup_epochs: float = 3.0,
    patience: int = 30,
    cos_lr: bool = True,
    close_mosaic: int = 10,
    box: float = 7.5,
    cls: float = 0.5,
    dfl: float = 1.5,
    hsv_h: float = 0.015,
    hsv_s: float = 0.7,
    hsv_v: float = 0.4,
    degrees: float = 2.0,
    translate: float = 0.04,
    scale: float = 0.25,
    shear: float = 0.0,
    perspective: float = 0.0,
    flipud: float = 0.0,
    fliplr: float = 0.0,
    mosaic: float = 0.35,
    mixup: float = 0.05,
    copy_paste: float = 0.0,
    erasing: float = 0.4,
    amp: bool = True,
    rect: bool = False,
    single_cls: bool = False,
    freeze: int | None = None,
    resume: bool = False,
    seed: int = 0,
) -> Path:
    if not preflight_checked:
        stats = assert_dataset_ready(data_yaml, min_train=min_train, min_val=min_val)
        print(format_validation_report(stats, max_issues=20))

    from ultralytics import YOLO

    model = YOLO(base_model)
    train_kwargs: dict = dict(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=image_size,
        batch=batch,
        device=device if device else None,
        patience=patience,
        cos_lr=cos_lr,
        close_mosaic=close_mosaic,
        optimizer=optimizer,
        lr0=lr0,
        lrf=lrf,
        momentum=momentum,
        weight_decay=weight_decay,
        warmup_epochs=warmup_epochs,
        box=box,
        cls=cls,
        dfl=dfl,
        hsv_h=hsv_h,
        hsv_s=hsv_s,
        hsv_v=hsv_v,
        degrees=degrees,
        translate=translate,
        scale=scale,
        shear=shear,
        perspective=perspective,
        flipud=flipud,
        fliplr=fliplr,  # mirrored panels can flip labels/markings unnaturally
        mosaic=mosaic,
        mixup=mixup,
        copy_paste=copy_paste,
        erasing=erasing,
        amp=amp,
        rect=rect,
        single_cls=single_cls,
        seed=seed,
        resume=resume,
        project=str(project),
        name=run_name,
        exist_ok=True,
        workers=workers,
        cache=cache,
    )
    if freeze is not None and freeze > 0:
        train_kwargs["freeze"] = freeze
    result = model.train(**train_kwargs)

    save_dir = Path(getattr(result, "save_dir", project / run_name))
    best = save_dir / "weights" / "best.pt"
    if not best.exists():
        raise FileNotFoundError(f"Training finished but best.pt was not found: {best}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, output_path)
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Train SynthSkin YOLO panel-control detector")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="YOLO dataset YAML")
    parser.add_argument("--base", default="yolo11m.pt", help="Base YOLO model: yolo11s.pt or yolo11m.pt recommended")
    parser.add_argument("--epochs", type=int, default=120)
    parser.add_argument("--imgsz", type=int, default=1280, help="Higher helps tiny LEDs, meter needles, and dense panels")
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", default=None, help="Examples: 0, cpu, mps. Leave empty for auto")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--min-train", type=int, default=50, help="Fail preflight below this train-image count")
    parser.add_argument("--min-val", type=int, default=10, help="Fail preflight below this val-image count")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--cache", default="false", choices=["false", "true", "ram", "disk"], help="Ultralytics cache mode")
    parser.add_argument("--project", type=Path, default=ROOT / "runs" / "detect")
    parser.add_argument("--name", default="synthskin_panel_detector")
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR, help="Dataset preflight report output")
    parser.add_argument("--validate-only", action="store_true", help="Run dataset preflight and exit")
    parser.add_argument("--dry-run", action="store_true", help="Run preflight and print planned training command without training")
    # Optimizer / schedule
    parser.add_argument("--optimizer", default="auto", choices=["auto", "SGD", "Adam", "AdamW", "NAdam", "RAdam", "RMSProp"])
    parser.add_argument("--lr0", type=float, default=0.01)
    parser.add_argument("--lrf", type=float, default=0.01, help="final-lr ratio (cosine target)")
    parser.add_argument("--momentum", type=float, default=0.937)
    parser.add_argument("--weight-decay", type=float, default=0.0005)
    parser.add_argument("--warmup-epochs", type=float, default=3.0)
    parser.add_argument("--patience", type=int, default=30)
    parser.add_argument("--cos-lr", dest="cos_lr", action="store_true", default=True)
    parser.add_argument("--no-cos-lr", dest="cos_lr", action="store_false")
    parser.add_argument("--close-mosaic", type=int, default=10)
    # Loss weights
    parser.add_argument("--box", type=float, default=7.5)
    parser.add_argument("--cls", type=float, default=0.5)
    parser.add_argument("--dfl", type=float, default=1.5)
    # Augmentation
    parser.add_argument("--hsv-h", type=float, default=0.015)
    parser.add_argument("--hsv-s", type=float, default=0.7)
    parser.add_argument("--hsv-v", type=float, default=0.4)
    parser.add_argument("--degrees", type=float, default=2.0)
    parser.add_argument("--translate", type=float, default=0.04)
    parser.add_argument("--scale", type=float, default=0.25)
    parser.add_argument("--shear", type=float, default=0.0)
    parser.add_argument("--perspective", type=float, default=0.0)
    parser.add_argument("--flipud", type=float, default=0.0)
    parser.add_argument("--fliplr", type=float, default=0.0)
    parser.add_argument("--mosaic", type=float, default=0.35)
    parser.add_argument("--mixup", type=float, default=0.05)
    parser.add_argument("--copy-paste", type=float, default=0.0)
    parser.add_argument("--erasing", type=float, default=0.4)
    # Hardware / model
    parser.add_argument("--amp", dest="amp", action="store_true", default=True)
    parser.add_argument("--no-amp", dest="amp", action="store_false")
    parser.add_argument("--rect", action="store_true")
    parser.add_argument("--single-cls", action="store_true")
    parser.add_argument("--freeze", type=int, default=None, help="Freeze first N layers for transfer learning")
    parser.add_argument("--resume", action="store_true", help="Resume from last.pt of the named run")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    data_yaml = args.data.resolve()
    stats = assert_dataset_ready(data_yaml, min_train=args.min_train, min_val=args.min_val)
    text_path, json_path = write_validation_report(stats, args.report_dir.resolve())
    print(format_validation_report(stats, max_issues=30))
    print(f"\nDataset preflight reports:\n  {text_path}\n  {json_path}")

    if args.validate_only:
        print("Dataset is ready for training.")
        return

    if args.dry_run:
        print("Dry run only. Planned training:")
        print(
            f"  base={args.base} epochs={args.epochs} imgsz={args.imgsz} batch={args.batch} "
            f"device={args.device or 'auto'} output={args.output.resolve()}"
        )
        return

    cache: bool | str
    cache = False if args.cache == "false" else True if args.cache == "true" else args.cache

    out = train_detector(
        data_yaml=data_yaml,
        base_model=args.base,
        epochs=args.epochs,
        image_size=args.imgsz,
        batch=args.batch,
        device=args.device,
        output_path=args.output.resolve(),
        min_train=args.min_train,
        min_val=args.min_val,
        workers=args.workers,
        cache=cache,
        project=args.project.resolve(),
        run_name=args.name,
        preflight_checked=True,
        optimizer=args.optimizer,
        lr0=args.lr0,
        lrf=args.lrf,
        momentum=args.momentum,
        weight_decay=args.weight_decay,
        warmup_epochs=args.warmup_epochs,
        patience=args.patience,
        cos_lr=args.cos_lr,
        close_mosaic=args.close_mosaic,
        box=args.box,
        cls=args.cls,
        dfl=args.dfl,
        hsv_h=args.hsv_h,
        hsv_s=args.hsv_s,
        hsv_v=args.hsv_v,
        degrees=args.degrees,
        translate=args.translate,
        scale=args.scale,
        shear=args.shear,
        perspective=args.perspective,
        flipud=args.flipud,
        fliplr=args.fliplr,
        mosaic=args.mosaic,
        mixup=args.mixup,
        copy_paste=args.copy_paste,
        erasing=args.erasing,
        amp=args.amp,
        rect=args.rect,
        single_cls=args.single_cls,
        freeze=args.freeze,
        resume=args.resume,
        seed=args.seed,
    )
    print(f"SynthSkin detector ready: {out}")
    print("Restart the Python sidecar, then /panel/capabilities should report custom_yolo=True.")


if __name__ == "__main__":
    main()
