# SynthSkin Panel Detector Training

The panel analyzer needs two different model roles:

1. **Detector** — finds boxes for `knob`, `slider`, and `led`.
2. **Segmenter** — cuts the detected boxes into masks.

`SAM2` is the segmenter. It is not a reliable object detector by itself. The production solution is:

> custom YOLO11 detector → SAM2 box-prompt segmentation → RapidOCR labels/features

## Why generic YOLO is not enough

The bundled `yolo11n.pt` is COCO-pretrained. COCO does not contain synth knobs, faders, LEDs, patch points, or panel UI controls as classes. It can only provide weak objectness proposals, so the app now marks it as `fallback` unless a trained `synthskin_yolo.pt` exists.

## Target model

Recommended:

- Start: `yolo11s.pt` for CPU-friendly training/inference.
- Better quality: `yolo11m.pt` for dense panels and tiny LEDs.
- Output path expected by the app: `python/models/synthskin_yolo.pt`.

## Classes

Current production scope is intentionally focused:

```text
0 knob
1 slider
2 led
```

Screens/buttons/switches can be added later, but keeping the first detector focused reduces false positives.

## Dataset layout

Create this structure:

```text
python/datasets/synth_panel/
  images/train/
  images/val/
  labels/train/
  labels/val/
```

Each image needs a matching YOLO label file:

```text
<class_id> <x_center> <y_center> <width> <height>
```

All coordinates are normalized from `0` to `1`.

You can create the folders and a dataset README automatically:

```powershell
.\.venv\Scripts\python.exe prepare_synth_dataset.py --init --allow-empty
```

If you have a folder of raw panel screenshots/photos, import them into a deterministic train/val split:

```powershell
.\.venv\Scripts\python.exe prepare_synth_dataset.py --raw-dir C:\path\to\raw_panels --val-ratio 0.2 --allow-empty
```

This creates empty `.txt` label files. The empty files are only placeholders for annotation; real training still requires boxes.

## Dataset preflight

Before training, run the deterministic preflight. It checks:

- missing `images/*` / `labels/*` folders
- image files without matching `.txt` labels
- orphan label files
- malformed YOLO rows
- class ids outside `0..2`
- normalized coordinates outside `0..1`
- per-class counts for `knob`, `slider`, `led`

```powershell
.\.venv\Scripts\python.exe prepare_synth_dataset.py --min-train 50 --min-val 10
```

Reports are written to:

```text
python/runs/detect/dataset_preflight/dataset_report.md
python/runs/detect/dataset_preflight/dataset_report.json
```

The training script runs the same preflight automatically, so bad data fails before a long GPU/CPU job starts.

## Minimum useful dataset

For real quality:

- Bare minimum: 500 train images, 100 validation images.
- Recommended: 2,000–5,000 labeled panels/crops.
- Include plugin screenshots, rack gear photos, dark panels, bright panels, colored LEDs, vertical faders, horizontal faders, tiny knobs, large knobs, partially occluded controls.

## Train

From `synthskin-studio/python`:

First verify without training:

```powershell
.\.venv\Scripts\python.exe train_synth_detector.py --validate-only
```

Dry-run the planned settings:

```powershell
.\.venv\Scripts\python.exe train_synth_detector.py --dry-run --base yolo11m.pt --epochs 120 --imgsz 1280 --batch 8
```

Then train:

```powershell
.\.venv\Scripts\python.exe train_synth_detector.py --base yolo11m.pt --epochs 120 --imgsz 1280 --batch 8
```

For CPU-only test training, use a smaller run:

```powershell
.\.venv\Scripts\python.exe train_synth_detector.py --base yolo11s.pt --epochs 30 --imgsz 960 --batch 2 --device cpu
```

The script copies the best checkpoint to:

```text
python/models/synthskin_yolo.pt
```

Restart the Python sidecar after training. The UI should then show the local detector as `ready`, not `fallback`.

Useful training flags:

- `--base yolo11s.pt` — faster/lighter.
- `--base yolo11m.pt` — better dense-panel quality.
- `--imgsz 1280` or higher — helps tiny LEDs.
- `--cache ram` or `--cache disk` — faster repeated training if memory/disk allow it.
- `--workers 4` — dataloader workers.
- `--output models/synthskin_yolo.pt` — path the app auto-loads.

## Evaluation target

Do not accept the model until validation is roughly:

- `mAP50` ≥ 0.85 for knobs/sliders.
- LED recall acceptable on tiny LEDs; if not, increase `imgsz` and add more tiny LED samples.
- Visual false-positive pass on at least 30 real panels.

Run validation and export preview overlays:

```powershell
.\.venv\Scripts\python.exe evaluate_synth_detector.py --weights models\synthskin_yolo.pt --imgsz 1280 --conf 0.25 --max-preview 40
```

Outputs:

```text
python/runs/detect/synthskin_eval/synthskin_eval_summary.json
python/runs/detect/synthskin_eval_previews/
```

Accept the detector only after inspecting the preview overlays. The model should find dense rows of knobs/faders without drawing boxes around text, screws, shadows, or decorative panel art.

## Annotation quality checklist

- Label all visible target objects in each image; missing boxes teach false negatives.
- Use tight boxes around the physical object only.
- For faders/sliders, box the whole slider control or the moving cap consistently. The current pipeline expects the detector to find the control object; feature extraction later estimates cap position.
- Keep validation images from different devices/photos than training when possible.
- Add hard negatives with empty labels: panels, logos, screens, screws, meters, cables, and text-only crops.
- If LEDs are missed, add more tiny LED examples and train with larger `--imgsz`.

## Runtime pipeline after training

1. `YOLO11m/s` produces boxes for `knob`, `slider`, `led`.
2. `SAM2` receives each box and extracts a precise alpha mask.
3. Feature extraction estimates knob pointer angle and slider position.
4. RapidOCR is optional for labels and section linking.
