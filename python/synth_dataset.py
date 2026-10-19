"""Dataset utilities for the SynthSkin panel-control YOLO detector.

The app-managed training flow stores a richer corpus than the live detector uses
at runtime. In addition to coarse controls like knobs and sliders, the corpus
can keep fine-grained motion parts such as slider caps, slider tracks, meter
needles, and meter travel ranges so future detector variants can be trained from
the same annotated archive.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import math
import random
import shutil
from pathlib import Path
from typing import Iterable, Sequence

try:
    import yaml
except Exception:  # pragma: no cover - reported by require_yaml()
    yaml = None  # type: ignore[assignment]


ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = ROOT / "datasets" / "synth_panel.yaml"
CLASS_NAMES = (
    "knob",
    "slider_cap",
    "slider_track",
    "led_light",
    "led_screen",
    "meter_needle",
    "meter_range",
    "meter_screen",
    "text",
    # Appended after "text" so indices 0..8 stay stable for any existing labels.
    "button",
    "switch",
)
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


@dataclass(frozen=True)
class DatasetIssue:
    severity: str  # "error" | "warning"
    path: str
    message: str


@dataclass
class SplitStats:
    name: str
    images: int = 0
    label_files: int = 0
    annotated_images: int = 0
    empty_label_files: int = 0
    missing_label_files: int = 0
    orphan_label_files: int = 0
    boxes: int = 0
    class_counts: dict[str, int] = field(default_factory=lambda: {name: 0 for name in CLASS_NAMES})
    issues: list[DatasetIssue] = field(default_factory=list)

    @property
    def errors(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "error")

    @property
    def warnings(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "warning")


@dataclass
class DatasetStats:
    root: str
    splits: dict[str, SplitStats]

    @property
    def errors(self) -> int:
        return sum(split.errors for split in self.splits.values())

    @property
    def warnings(self) -> int:
        return sum(split.warnings for split in self.splits.values())

    @property
    def total_boxes(self) -> int:
        return sum(split.boxes for split in self.splits.values())

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def require_yaml() -> None:
    if yaml is None:
        raise RuntimeError("PyYAML is required. Install requirements.txt or install pyyaml.")


def load_dataset_config(data_yaml: Path = DEFAULT_DATA) -> dict[str, object]:
    require_yaml()
    if not data_yaml.exists():
        raise FileNotFoundError(f"Dataset YAML not found: {data_yaml}")
    with data_yaml.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Dataset YAML must contain a mapping: {data_yaml}")
    return data


def resolve_dataset_root(data_yaml: Path = DEFAULT_DATA) -> Path:
    """Resolve the dataset root used by the YOLO YAML.

    The checked-in template intentionally uses ``path: ./datasets/synth_panel``
    for Ultralytics runs launched from ``python/``.  For tool robustness, try
    both cwd-style and YAML-relative candidates and return the existing one.
    """
    data_yaml = data_yaml.resolve()
    cfg = load_dataset_config(data_yaml)
    raw_path = str(cfg.get("path") or "datasets/synth_panel")
    candidate = Path(raw_path)
    candidates = []
    if candidate.is_absolute():
        candidates.append(candidate)
    else:
        candidates.extend([
            (ROOT / candidate).resolve(),
            (data_yaml.parent / candidate).resolve(),
            (Path.cwd() / candidate).resolve(),
        ])

    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


def ensure_dataset_dirs(data_yaml: Path = DEFAULT_DATA) -> Path:
    root = resolve_dataset_root(data_yaml)
    for split in ("train", "val"):
        (root / "images" / split).mkdir(parents=True, exist_ok=True)
        (root / "labels" / split).mkdir(parents=True, exist_ok=True)
    (root / "README.md").write_text(dataset_readme(root), encoding="utf-8")
    return root


def iter_images(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return sorted(p for p in path.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)


def iter_labels(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return sorted(p for p in path.iterdir() if p.is_file() and p.suffix.lower() == ".txt")


def _relative(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _parse_label_line(line: str, label_path: Path, line_no: int) -> tuple[int, tuple[float, float, float, float], DatasetIssue | None]:
    parts = line.split()
    if len(parts) != 5:
        return -1, (0, 0, 0, 0), DatasetIssue("error", _relative(label_path), f"Line {line_no}: expected 5 YOLO columns, got {len(parts)}")

    try:
        class_id = int(parts[0])
        coords = tuple(float(v) for v in parts[1:5])
    except ValueError:
        return -1, (0, 0, 0, 0), DatasetIssue("error", _relative(label_path), f"Line {line_no}: non-numeric YOLO value")

    if class_id < 0 or class_id >= len(CLASS_NAMES):
        return class_id, coords, DatasetIssue("error", _relative(label_path), f"Line {line_no}: class id {class_id} is not in 0..{len(CLASS_NAMES) - 1}")

    if not all(math.isfinite(v) for v in coords):
        return class_id, coords, DatasetIssue("error", _relative(label_path), f"Line {line_no}: non-finite coordinate")

    x, y, w, h = coords
    if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1):
        return class_id, coords, DatasetIssue("error", _relative(label_path), f"Line {line_no}: normalized coordinates must be x/y 0..1 and w/h >0..1")

    if x - w / 2 < -0.001 or x + w / 2 > 1.001 or y - h / 2 < -0.001 or y + h / 2 > 1.001:
        return class_id, coords, DatasetIssue("warning", _relative(label_path), f"Line {line_no}: box extends outside image bounds")

    if w * h < 0.00001:
        return class_id, coords, DatasetIssue("warning", _relative(label_path), f"Line {line_no}: very tiny box; verify LED/knob label")

    return class_id, coords, None


def validate_split(root: Path, split: str) -> SplitStats:
    image_dir = root / "images" / split
    label_dir = root / "labels" / split
    stats = SplitStats(split)

    if not image_dir.exists():
        stats.issues.append(DatasetIssue("error", _relative(image_dir), "Missing image folder"))
        return stats
    if not label_dir.exists():
        stats.issues.append(DatasetIssue("error", _relative(label_dir), "Missing label folder"))
        return stats

    images = iter_images(image_dir)
    labels = iter_labels(label_dir)
    stats.images = len(images)
    stats.label_files = len(labels)

    image_stems = {p.stem for p in images}
    label_stems = {p.stem for p in labels}

    for image_path in images:
        label_path = label_dir / f"{image_path.stem}.txt"
        if not label_path.exists():
            stats.missing_label_files += 1
            stats.issues.append(DatasetIssue("error", _relative(image_path), "Missing matching YOLO label file"))

    for label_path in labels:
        if label_path.stem not in image_stems:
            stats.orphan_label_files += 1
            stats.issues.append(DatasetIssue("warning", _relative(label_path), "Label file has no matching image"))
            continue

        lines = [line.strip() for line in label_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not lines:
            stats.empty_label_files += 1
            continue

        stats.annotated_images += 1
        for line_no, line in enumerate(lines, start=1):
            class_id, _coords, issue = _parse_label_line(line, label_path, line_no)
            if issue:
                stats.issues.append(issue)
                if issue.severity == "error":
                    continue
            if 0 <= class_id < len(CLASS_NAMES):
                stats.class_counts[CLASS_NAMES[class_id]] += 1
                stats.boxes += 1

    return stats


def validate_dataset(data_yaml: Path = DEFAULT_DATA, min_train: int = 50, min_val: int = 10, require_boxes: bool = True) -> DatasetStats:
    root = resolve_dataset_root(data_yaml)
    stats = DatasetStats(root=str(root), splits={split: validate_split(root, split) for split in ("train", "val")})

    train = stats.splits["train"]
    val = stats.splits["val"]
    if train.images < min_train:
        train.issues.append(DatasetIssue("error", _relative(root / "images" / "train"), f"Too few train images: {train.images}. Minimum for this run: {min_train}"))
    if val.images < min_val:
        val.issues.append(DatasetIssue("error", _relative(root / "images" / "val"), f"Too few val images: {val.images}. Minimum for this run: {min_val}"))
    if require_boxes and stats.total_boxes == 0:
        train.issues.append(DatasetIssue("error", _relative(root), "No labeled boxes found. Add YOLO labels before training."))

    return stats


def assert_dataset_ready(data_yaml: Path = DEFAULT_DATA, min_train: int = 50, min_val: int = 10) -> DatasetStats:
    stats = validate_dataset(data_yaml, min_train=min_train, min_val=min_val)
    if stats.errors:
        report = format_validation_report(stats, max_issues=25)
        raise ValueError("Dataset preflight failed:\n" + report)
    return stats


def format_validation_report(stats: DatasetStats, max_issues: int = 50) -> str:
    lines = [
        f"Dataset root: {stats.root}",
        f"Errors: {stats.errors} · Warnings: {stats.warnings} · Boxes: {stats.total_boxes}",
        "",
    ]
    for split in stats.splits.values():
        counts = ", ".join(f"{name}={count}" for name, count in split.class_counts.items())
        lines.extend([
            f"[{split.name}] images={split.images} labels={split.label_files} annotated={split.annotated_images} boxes={split.boxes}",
            f"      empty={split.empty_label_files} missing={split.missing_label_files} orphan={split.orphan_label_files} classes: {counts}",
        ])
        for issue in split.issues[:max_issues]:
            lines.append(f"      {issue.severity.upper()}: {issue.path}: {issue.message}")
        if len(split.issues) > max_issues:
            lines.append(f"      ... {len(split.issues) - max_issues} more issues")
        lines.append("")
    return "\n".join(lines).rstrip()


def write_validation_report(stats: DatasetStats, output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    text_path = output_dir / "dataset_report.md"
    json_path = output_dir / "dataset_report.json"
    text_path.write_text(format_validation_report(stats, max_issues=500) + "\n", encoding="utf-8")
    json_path.write_text(json.dumps(stats.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
    return text_path, json_path


def import_raw_images(raw_dir: Path, data_yaml: Path = DEFAULT_DATA, val_ratio: float = 0.2, seed: int = 7, copy: bool = True) -> tuple[int, int]:
    """Import unlabeled images into train/val folders and create empty labels.

    This is for bootstrapping annotation. Empty label files are valid placeholders
    but training will still fail until boxes are added.
    """
    root = ensure_dataset_dirs(data_yaml)
    images = iter_images(raw_dir)
    if not images:
        raise FileNotFoundError(f"No images found in raw dir: {raw_dir}")

    rng = random.Random(seed)
    shuffled = images[:]
    rng.shuffle(shuffled)
    val_count = max(1, int(round(len(shuffled) * val_ratio))) if len(shuffled) > 1 else 0
    val_set = set(shuffled[:val_count])
    counts = {"train": 0, "val": 0}

    for image_path in shuffled:
        split = "val" if image_path in val_set else "train"
        target_image = root / "images" / split / image_path.name
        target_label = root / "labels" / split / f"{image_path.stem}.txt"
        if copy:
            shutil.copy2(image_path, target_image)
        else:
            shutil.move(str(image_path), target_image)
        target_label.touch(exist_ok=True)
        counts[split] += 1

    return counts["train"], counts["val"]


def dataset_readme(root: Path) -> str:
    return f"""# SynthSkin YOLO Dataset

Root: `{root}`

Classes:

| id | class |
| --- | --- |
| 0 | knob |
| 1 | slider_cap |
| 2 | slider_track |
| 3 | led_light |
| 4 | led_screen |
| 5 | meter_needle |
| 6 | meter_range |
| 7 | meter_screen |
| 8 | text |

Folder layout:

```text
images/train/
images/val/
labels/train/
labels/val/
```

Each image needs a matching `.txt` label file with YOLO boxes:

```text
class_id x_center y_center width height
```

Coordinates are normalized from 0 to 1.

Quality rules:

- `knob`: the full rotary control body.
- `slider_cap`: the movable thumb/head only.
- `slider_track`: the full travel slot or rail only.
- `led_light`: status lamps or LED dots.
- `led_screen`: 7-segment, matrix, or digital LED displays.
- `meter_needle`: the moving pointer only.
- `meter_range`: the sweep area / gauge travel region.
- `meter_screen`: the full analog or digital meter housing.
- `text`: panel legends, value labels, and inline text worth learning.
- Use tight boxes around the target itself, not the surrounding bezel unless the bezel is the target.
- Keep train/val split by device/photo session when possible to avoid leakage.
- Add hard negatives only as empty `.txt` files for images with no relevant targets.
"""


__all__ = [
    "CLASS_NAMES",
    "DEFAULT_DATA",
    "DatasetStats",
    "SplitStats",
    "assert_dataset_ready",
    "ensure_dataset_dirs",
    "format_validation_report",
    "import_raw_images",
    "iter_images",
    "resolve_dataset_root",
    "validate_dataset",
    "write_validation_report",
]
