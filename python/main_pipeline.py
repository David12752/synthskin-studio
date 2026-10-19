"""
main_pipeline.py — canonical entry point for the panel semantic analysis pipeline.

Delegates to panel_pipeline.py which contains the full implementation.
Import from this module for all external callers; internals live in panel_pipeline.

Stages:
  1. Focused Detection    (Gemini Vision / YOLO / targeted OpenCV)
  2. Segmentation         (fast GrabCut/Hough path; optional SAM2 on GPU)
  3. Optional RapidOCR    (text extraction + semantic label linking)
  4. Feature Extraction   (knob angle, slider travel, LED geometry)
  5. Semantic Linking     (label→control graph, section grouping, JUCE param IDs)
"""
from panel_pipeline import (  # noqa: F401
    analyze_panel,
    check_panel_pipeline_available,
    FLORENCE_PROMPTS,
    CANONICAL_TYPES,
    KNOB_SIZE_BINS,
    detect_components,
    segment_all,
    ocr_labels,
    extract_features,
)

__all__ = [
    "analyze_panel",
    "check_panel_pipeline_available",
    "FLORENCE_PROMPTS",
    "CANONICAL_TYPES",
    "KNOB_SIZE_BINS",
    "detect_components",
    "segment_all",
    "ocr_labels",
    "extract_features",
]
