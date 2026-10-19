# SynthSkin Studio — Deep Architecture & Remediation Report

**Date:** 2026-07-03 · **Scope:** full-stack audit of the image → detect → refine → export pipeline against the target spec ("professional HITL UI-extraction tool for plugin developers").

---

## 0. Premise correction

This is not a greenfield design question. The audit found that the app you described **already exists and is ~85–90% built to the target spec**, with several parts that are genuinely state-of-the-art:

| Requested capability | Current state |
|---|---|
| Upload + AI auto-detection | ✅ Built — 5-stage pipeline in `python/panel_pipeline.py` (4,047 lines): Detect → Segment → OCR → Features → Link |
| HITL bbox/mask correction | 🟡 ~70% — bbox editor, SAM re-cut (K), lasso boolean (L), Refine Edge, brush/eraser exist; pen/Bézier, marching ants, mask-level undo missing |
| Photoshop-level cutting | 🟡 SAM2 slicing proven (135/137 clean masks on the WAVESTRUCT dogfood run); alpha matting and edge polish missing |
| Punch-through background export | ✅ Built server-side — union-mask extraction + `cv2.INPAINT_TELEA` in `python/processor.py` |
| Asset export for plugin UIs | ✅ Built — filmstrips, pow-2 atlases + TexturePacker JSON, @1x–4x scales, SVG trace, C++ snippets in `python/export_pipeline.py` |

The single biggest problem is not architectural. **The semantic brain is switched off** (`gemini_key_set:false`, no trained YOLO), so detection runs CV-heuristics-only and precision collapses (dogfood: 137 detections, logo→knob, wavetable screen exploded into false boxes). Everything in this report is ordered around that fact.

The stack already complies with your constraints: Electron 28 + React 18 + TS 5 + Zustand 4 + Konva 10 frontend, FastAPI Python sidecar (SAM2, OpenCV, RapidOCR, optional Gemini). No C++/JUCE in the app itself (`synthskin-bridge/` is a consumer-side artifact your users compile, which is fine).

---

## 1. Assumptions challenged

**"YOLOv11 + SAM 2" is half right.** Your own probes falsified the YOLO half *for now*: generic `yolo11n.pt` produced **0 proposals** on a synth panel; YOLO-World open-vocab gave 7 detections under 0.18 confidence in 168s; Florence-2 was retired for wrapping every label as a knob. The SAM2 half is validated (135/137 clean masks). The correct architecture is **teacher–student**: a VLM (Gemini 2.5 Flash, already wired in `panel_pipeline.py`) is the detection brain today; its outputs auto-label the corpus (`training_corpus.py`, plumbing verified); once ~50–150 panels accrue, train `synthskin_yolo.pt` on a cloud GPU and it becomes the fast local path with the VLM as fallback/verifier. You already converged on this — the report formalizes it. YOLOv11 is a distillation target, not a starting point.

**"Fabric.js or PixiJS?" is the wrong question.** You have ~16 canvas components deeply integrated with Konva. A migration would cost weeks and fix nothing, because the real performance risks are elsewhere: base64 payloads, `HTMLImage` mask caches, and full-array snapshot undo. Keep Konva as the scene graph; fix the raster subsystem (§3).

**"Vector-level editing" is closer than you think.** The backend already emits `contour_polygon` for every mask — the vector representation exists and the UI simply never uses it. The pen tool is a UI problem, not a pipeline problem.

**"Punch-through in the browser" is the wrong place.** You already punch server-side at full resolution with inpainting. The browser should only *preview* the punch (§5). Doing boolean raster ops in JS as the source of truth would reintroduce resolution limits and color-management bugs you've already avoided.

**Don't churn the shell.** Electron is load-bearing here (sidecar lifecycle, TCP bridge to live plugins, CMake runner via IPC). Tauri would be a rewrite of `electron/main.ts` + `juce-bridge.ts` for marginal RAM savings. Not worth it.

---

## 2. Computer vision & extraction pipeline

### What exists (and is good)

- **Detection fusion** (`detect_components`, panel_pipeline.py:1297): Gemini + YOLO + OpenCV heuristics, then ~12 post-filters (out-of-panel, geometric, edge-contrast, display-suppression, cross-source boost, per-type NMS, containment, global NMS, OCR re-rank). This filter stack is professional-grade.
- **Tiered segmentation** (`segment_all`, :2807): Hough-circle snap for knobs/LEDs (~5ms), SAM2 batched box-prompts (one ViT encode per image) for screens/sliders, parallel GrabCut for the rest. This routing is exactly right — don't send everything to SAM2.
- **A clean JSON contract**: per control — `bbox` (original coords), `refined_bbox`, `mask_png` (cropped to `mask_bbox`, not full-frame — good), `contour_polygon`, `circle {cx,cy,radius}`, `features` (pointer angle, value_normalized), linked OCR `label`, slugified `parameter_id`. Plus `capabilities`, `timing`, `detection_sources` provenance. SSE streaming exists for progress.

### Gaps and the exact fixes

**2.1 Turn the brain on, then constrain it.** (blocked on your API key)
When Gemini is live, treat it correctly: **VLMs propose, CV refines.** VLM boxes are semantically right but geometrically sloppy (±5–15px). Keep the existing pattern of snapping knob circles via Hough, and generalize it: every VLM box gets re-fit by a local CV pass (edge-aware box tightening, or a SAM2 box-prompt whose mask bbox becomes the refined box). Also request **structured output** (`response_schema` / JSON mode) so parsing never breaks, and for dense panels (>40 controls) tile the image 2×2 with ~10% overlap, detect per tile, merge with the existing NMS — VLM box precision degrades with object density.

**2.2 Coordinate-space discipline (correctness risk, already flagged in your masterplan Phase 2 #4).**
Today: detection ≤1600px, segmentation ≤1024px, OCR ≤1024px, all rescaled back. Every stage must carry an explicit `scale` and the **final mask/crop must be cut from the original image**, never from a downscaled intermediate — otherwise you ship soft 1–2px halos that no Refine Edge can fix. Make this a contract: *all coordinates that cross the API boundary are in original-image space; all rasters that cross the boundary state their space.* Add a regression test that cuts a knob at full res and asserts edge sharpness (Laplacian variance in a boundary band).

**2.3 Wire `rectify.py` into `analyze_panel` (Track B, pending).**
The homography pre-stage exists and is validated synthetically (4.79px mean corner error) but is not called by the pipeline. Wire it as stage 0 with the existing safety-first no-op behavior, and **return `homography` + `applied` in the payload**. Decision to make explicit: after rectification, the rectified image becomes the working document (assets are cut from it); the original photo is retained only for reference. Don't try to map masks back through H⁻¹ — that reintroduces resampling blur.

**2.4 HITL invariant: AI re-runs must never clobber user edits.**
This is the most important missing contract. Add per-control `provenance: 'ai' | 'user'` (and per-mask). Re-analysis merges by IoU matching against existing controls and only replaces entities the user hasn't touched; conflicts surface as a diff, not an overwrite. Without this, the review workflow (§4) punishes users for correcting things.

**2.5 CPU-friendly edge quality now, matting later.**
BiRefNet is rightly deferred (CPU-only laptop). But you can get 80% of the visual win for ~0 cost: run a **guided filter** (`cv2.ximgproc.guidedFilter`, guided by the original crop) on a ±4px band around each mask boundary to convert binary edges into soft, image-aware alpha. Seconds for a whole panel. Keep BiRefNet/ViTMatte as an *on-demand, per-crop* "HQ edges" button (crops are small — even CPU is tolerable one at a time), not a pipeline stage.

**2.6 Transport: stop shipping base64 through JSON.**
Full images and dozens of masks currently round-trip as data URLs inside JSON (33% size bloat + main-thread `JSON.parse` stalls + string retention in stores). Same machine, so: write artifacts to `.tmp/jobs/{job_id}/` and serve them via FastAPI `StaticFiles`; the JSON response carries **URLs + dimensions + hashes**, and the frontend loads them with `fetch → blob → createImageBitmap` (decode off main thread). Keep base64 only for tiny payloads (single re-cut masks). This is a half-day change (`server.py` + `pythonClient.ts`) with the single largest perceived-performance payoff in the app.

---

## 3. Frontend canvas & manipulation engine

### Verdict: keep Konva, restructure the layers

Konva remains the right choice at your image sizes (1.5–4K panels). WebGL (PixiJS) becomes worth discussing only past ~8K sources or ~500 live overlays. The needed work is in how raster data flows, not the renderer:

**Layer model** (inside the existing Stage):
1. **Source bitmap** — one cached Konva.Image.
2. **Mask composite** — *one* offscreen canvas holding all visible mask tints, redrawn only when a mask changes; rendered as a single Konva.Image. Today each asset is its own node with an `HTMLImage` cache — N decoded images and N draw calls where 1 suffices for the non-selected set.
3. **Vector overlay** — bboxes, contours, handles as Konva shapes (cheap, already how BboxEditor works).
4. **Tool preview** — the existing `ExtractionOverlay`.

**Raster upgrades:**
- Replace `HTMLImage` + data-URL caches with `ImageBitmap` (`createImageBitmap(blob)`) throughout `CanvasEditor.tsx`/`InteractiveAssetLayer.tsx`. Pairs with the URL transport in §2.6.
- **Brush/eraser** (in `ExtractionEditor.tsx`): batch pointer events per rAF, stamp into an `OffscreenCanvas`, composite once per frame; read `PointerEvent.pressure` for size/flow. Move to a worker via `transferControlToOffscreen` only if profiling demands it.
- **Marching ants + checkerboard** (masterplan Phase 3 #5): you don't need shaders — animate `dashOffset` on a Konva.Line built from the backend's `contour_polygon`; checkerboard is a pattern-filled rect behind the crop. Days, not weeks.

**The vector story (pen/Bézier), built on what exists:**
`contour_polygon` → fit Béziers with the Schneider algorithm (`fit-curve` npm, ~200 LOC) → editable path (anchors, handles, add/remove points) → rasterize to mask on commit. Persist **both** representations per asset: raster alpha is authoritative for export; the vector path persists for non-destructive re-editing. This closes "pixel-perfect *and* vector level" with the pipeline you already have.

**Magnetic lasso** (masterplan Phase 3, unbuilt): classic livewire / Intelligent Scissors — Sobel cost map on the working-res image, Dijkstra shortest path in a small band around the cursor polyline. Fully client-side, no model needed.

---

## 4. State management & HITL UX

### Current state, honestly assessed

28 Zustand stores. Undo is **three disconnected systems**: `historyStore.ts` (full-array snapshots of assets, cap 50), `panelLayoutStore.ts` (its own 40-snapshot stack for bbox edits), and the mask editor (**no undo at all** — masterplan Phase 3 #7). Cross-store coupling via direct `getState()` calls (ADR-012). Projects serialize as `.synthskin` JSON with embedded data URLs (ADR-010).

### 4.1 Split Document from Session

Define the **Document** (source images, rectification result, controls + provenance, masks raster+vector, bindings, export config) as the only state that participates in undo, dirty-tracking, and save. Everything else (active tool, zoom, selection, panel visibility) is **Session** and stays in the existing UI stores. Route all Document mutations through one actions module that stamps history + dirty — this dissolves the ad-hoc `getState()` web without a store rewrite.

### 4.2 One history, two scopes, command-based

- **Document history**: command pattern (do/undo pairs) instead of whole-array snapshots. Object-level ops (move, retype, delete, bbox) are tiny inverse records.
- **Mask-edit history**: Photoshop's model — entering the mask editor opens a *nested* history; brush strokes record **tile diffs** (256px tiles, before/after per dirty tile — memory-bounded, fast to apply); closing the editor commits the entire session as *one* Document command ("Edited mask of FILTER CUTOFF"). This gives painters stroke-level undo without polluting the object-level stack.
- Retire the parallel `panelLayoutStore` stack into the same Document history.

### 4.3 The Auto→Manual transition: make review a first-class stage

Today the user lands on a canvas with 137 overlapping boxes. The professional pattern (CVAT/Roboflow labeling flows) is a **triage queue**:

1. **Buckets on arrival**: auto-accepted (high confidence + passed all filters), needs-review (sorted ascending by confidence), auto-rejected-but-recoverable.
2. **Keyboard-first review loop**: `N` next (auto-zooms to control), `A` accept, `X` reject, `1–6` retype, `Enter` → escalation. Progress: "23/137 reviewed".
3. **Escalation ladder per control** — each step is one keystroke deeper, and most of it already exists: nudge bbox (exists) → SAM box re-prompt → SAM click re-cut (`K`, exists) → Refine Edge sliders (exists) → lasso boolean (`L`, exists) → brush/eraser (exists) → pen tool (build, §3).
4. Accepted controls **lock** (`provenance:'user'`, §2.4).

This converts "the AI found 137 things, good luck" into a 3–5 minute guided pass, and doubles as your **training-data flywheel**: every accepted/corrected panel is a corpus sample one click away (`save_layout_sample` already exists — put the "Save to corpus" button at the end of the review flow).

### 4.4 Project format

`.synthskin`-as-JSON-with-data-URLs will not survive per-asset masks + vectors + multi-image projects. Move to a **zip container** (like `.ora`/`.sketch`): `manifest.json` + `/images/*.png` + `/masks/*.png` + `/vectors.json`. Electron already has fs access; keep a loader for the legacy format. This also makes auto-save incremental (rewrite manifest + dirty blobs only).

---

## 5. Export engine & punch-through

### What exists

`build_juce_export_package` (export_pipeline.py:309) is already a professional exporter: vertical filmstrips (JUCE standard), @2x retina, individual frames, pow-2 spritesheet + TexturePacker-format atlas JSON, optional potrace SVG, generated C++ snippet, metadata JSON — saved via Electron `write-file` IPC. Background fill exists as `inpaint_background` (processor.py:1100, TELEA/NS on the dilated union mask). Rotation/needle filmstrip generation with 2x supersampling exists in `animation.py`/`meter.py`.

### Recommendations

**5.1 Formalize the punch contract (server-side, full-res, from the original image):**
- `background_punched.png` — original with `alpha=0` holes at `dilate(union_mask, 2px) + 1px feather` (the dilation+feather prevents the classic 1px halo ring when the extracted asset is re-composited over the plate);
- `background_filled.png` — the inpainted plate (current behavior);
- per-asset RGBA crops (current behavior).
Ship all three in every export. Compositing correctness note: when re-assembling previews, use premultiplied alpha or you'll see dark fringes on soft edges.

**5.2 Browser preview only.** The canvas-side punch is 10 lines on an offscreen canvas — draw source, then for each mask `ctx.globalCompositeOperation='destination-out'; ctx.drawImage(maskBitmap, …)`. Use it for the live "what will export look like" toggle; never as the export path.

**5.3 Inpainting quality option.** TELEA smears on large/structured holes (brushed metal, wood grain). Offer "HQ fill" at export time via **LaMa** (ONNX, Apache-2.0) — seconds on CPU for a one-shot export is acceptable; keep TELEA for interactive preview. Slot it behind the existing `method` parameter.

**5.4 One versioned manifest.** Metadata is currently spread across the export JSON, atlas JSON, and Design XML (`designXml.ts`). Define `layout.json` **v1** as the single machine-readable contract: per asset — `id`, `type`, `parameter_id`, rect in original coords, pivot/anchor, angle range + default (from `features`), produced scales, file paths, content hashes. The JUCE generator, the bridge, and any third-party consumer read this one file.

**5.5 Color management footgun.** OpenCV ignores ICC profiles; browsers apply them. An uploaded image with a non-sRGB profile will export assets that don't match the in-app preview. Normalize to sRGB and strip the profile at import (Pillow `ImageCms`), once, at the top of the pipeline.

---

## 6. Critical bottlenecks, ranked, and the roadmap

### Bottlenecks (impact × effort)

1. **The brain is off.** No Gemini key → CV-only detection → broken classification → empty training corpus → review UX drowning in false positives. *Your action, 5 minutes.* Everything below compounds on it.
2. **Never click-verified end-to-end.** Multiple shipped increments (Refine Edge, Re-cut K, Lasso L, UX redesign) are tsc/test-green but unverified in the running app. Run `npm run dev` against `docs/DOGFOOD_CHECKLIST.md` before building anything new.
3. **Base64/JSON transport** (§2.6) — biggest perceived-performance lever, half-day fix.
4. **No mask-edit undo** (§4.2) — data-loss risk in the app's core loop.
5. **Full-res discipline + rectify not wired** (§2.2–2.3) — correctness of the flagship promise ("pixel-perfect").
6. **Review UX** (§4.3) — the difference between a demo and a tool.
7. **No golden regression set.** The 12-filter detection stack is tuned by feel; one threshold tweak can silently regress panels. Freeze 3–5 panels (WAVESTRUCT + at least one real hardware photo) with accepted layouts as goldens; pytest asserts per-type IoU/precision/recall floors. `dogfood_pipeline.py` is 90% of this harness already.
8. **Project format ceiling** (§4.4).

### Roadmap

**Phase 0 — Ignition (≤1 day):** Set Gemini key (persists via `_persist_gemini_key`); verify with `check_gemini.py`; click-verify the app per dogfood checklist; re-run `dogfood_pipeline.py` with the brain on and record the new precision baseline vs. the CV-only 137-control run.

**Phase 1 — Contracts (2–3 days):** URL-based artifact transport (§2.6) + `ImageBitmap` on the frontend; coordinate-space contract + full-res crop guarantee (§2.2); wire `rectify.py` as stage 0 (§2.3); golden regression suite (§ bottleneck 7).

**Phase 2 — HITL core (4–6 days):** provenance + non-clobbering merge (§2.4); triage/review queue with keyboard loop (§4.3); unified command history with tile-diff mask undo (§4.2); guided-filter edge refinement (§2.5).

**Phase 3 — Pro editing (4–5 days):** pen/Bézier on `contour_polygon` with dual raster+vector persistence; marching ants + checkerboard; magnetic lasso (livewire). All client-side, independent of Phases 0–2.

**Phase 4 — Export & format (2–3 days):** punched + filled + crops triple with dilate/feather (§5.1); LaMa HQ-fill option (§5.3); `layout.json` v1 manifest (§5.4); sRGB normalization (§5.5); zip project format (§4.4).

**Phase 5 — Flywheel & distribution (ongoing):** every reviewed panel → corpus via the review flow; at ~50–150 samples train `synthskin_yolo.pt` on a cloud GPU (laptop stays thin client, as agreed); export ONNX for local inference; then packaging — PyInstaller-bundle the sidecar, model download-on-first-run, `torch-directml` probe for Windows GPUs.

**Sequencing logic:** 0 unblocks everything; 1 is the plumbing every later phase sits on; 2 delivers the product's actual promise (trustworthy AI + fast correction); 3 is parallelizable polish; 4 hardens the deliverable; 5 compounds forever.

---

*Ground truth for this report: `python/panel_pipeline.py`, `python/sam_service.py`, `python/export_pipeline.py`, `python/processor.py`, `python/rectify.py`, `src/components/canvas/*`, `src/stores/*`, `src/lib/api/pythonClient.ts`, `electron/main.ts`, `synthskin-bridge/synthskin_bridge.h`, `docs/EXTRACTION_MASTERPLAN.md`, and the `.tmp/dogfood*` run artifacts.*
