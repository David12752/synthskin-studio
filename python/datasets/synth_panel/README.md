# SynthSkin YOLO Dataset

Root: `C:\Users\דוד\Desktop\UiDesigen\synthskin-studio\python\datasets\synth_panel`

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
