# SynthSkin Training Corpus

This folder is managed by the app.

- Drop raw panel screenshots into: C:\Users\דוד\Desktop\UiDesigen\synthskin-studio\training-panel-corpus\uploads
- Curated saved samples are written to: C:\Users\דוד\Desktop\UiDesigen\synthskin-studio\training-panel-corpus\samples
- YOLO dataset images/labels are synced to: C:\Users\דוד\Desktop\UiDesigen\synthskin-studio\python\datasets\synth_panel
- Preflight/training reports are written to: C:\Users\דוד\Desktop\UiDesigen\synthskin-studio\training-panel-corpus\reports

Recommended workflow:
1. Open a panel image in the Extract workspace.
2. Run Panel Analysis.
3. Fix boxes/types in Edit Mode.
4. Save the current analysis to the training corpus.
5. Run preflight and then training from the analyzer panel.

Classes:
- knob
- slider_cap
- slider_track
- led_light
- led_screen
- meter_needle
- meter_range
- meter_screen
- text
- button
- switch
