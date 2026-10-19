# SynthSkin Studio — Work Plan v2: from extractor to interactive-UI compositor

**Date:** 2026-07-05  ·  **Owner:** David  ·  **Status:** proposed, awaiting go-ahead per phase
**Companion:** [`ARCHITECTURE_REVIEW_2026-07.md`](./ARCHITECTURE_REVIEW_2026-07.md)
**Revision:** v2 — compositing (cut-from-any-image + paste-parts-from-other-images) elevated to **core**, and the export target changed to an **embeddable frontend package**, per owner direction 2026-07-05.

---

## 0. תקציר מנהלים (Hebrew executive summary)

**החזון המחודד:** לא רק *לחלץ* בקרים מתמונה, אלא **לעצב ממשק אינטראקטיבי שלם** — לגזור חלקים מכל תמונה, לייבא ולהדביק חלקים מתמונות אחרות, לסדר/לשנות/לעצב אותם על קנבס, ולייצא חבילה **מוכנה להטמעה בפרונטאנד** (קומפוננטת React + נכסים + `layout.json`) שקלוד יכול לחדד.

**השינוי מ‑v1:** ה‑**compositing** (גזירה חופשית + הדבקה מתמונות אחרות) עלה מ"שלב מאוחר אופציונלי" ל**יכולת ליבה מחייבת**. הייצוא כבר לא "רק spec לקלוד" אלא **קוד embeddable**.

**רצף מומלץ:** שלב 0 אימות → שלב 1 חיתוכים נקיים (de-halo, משרת את כל הגזירות) → שלב 2 **מנוע גזירה חופשית + ייבוא תמונות מרובות** → שלב 3 **קנבס הרכבה (compositing)** → שלב 4 עיצוב מחדש (recolor) → שלב 5 **ייצוא embeddable** (React + נכסים + layout.json + README לקלוד).

**אבני דרך:** M1 נקי ומאומת · **M2 "לגזור ולהרכיב"** (2+3) = יכולת העיצוב האינטראקטיבי · **M3 "מוכן להטמעה"** (5+4) = החבילה הניתנת להטמעה בפרונטאנד.

---

## 1. North Star & scope

### 1.1 North Star (revised)
A user can, in **one app**: bring **one or many** images → let AI detect controls **and/or** freely **cut any region** by hand → **import parts from other images and paste them onto a panel** → arrange, transform, and restyle them into an **interactive UI** → and press one button to get a package that is **ready to embed in a project's frontend** — a generated React component plus every asset in its exact position, the layout structure, and interaction behavior — which Claude can then refine or extend.

The app is therefore no longer only a *synth-control extractor*; it becomes a **lightweight image compositor + UI designer** with an AI detection head and an embeddable-code exporter.

### 1.2 In scope
- **Clean separation:** pixel-accurate cuts with de-halo + high-quality background fill (Model #1).
- **Free-form cut from ANY image:** lasso / magic-wand / SAM / rectangle cut of an arbitrary region — not limited to AI-detected controls, and usable on imported reference images.
- **Multi-image sourcing:** import additional images, cut parts from them, and bring those parts into the working panel.
- **Compositing canvas:** place / move / scale / rotate / z-order cut & imported parts onto the panel; each becomes a first-class element with `provenance:'user'`.
- **Non-destructive restyle:** recolor / tint / brightness / contrast per element, baked at export.
- **Embeddable export:** a single package = generated **React component** + transparent asset PNGs + `background_filled/punched` + enriched `layout.json` + a `README_FOR_CLAUDE.md`. Drop-in for a frontend, and a precise brief for Claude.

### 1.3 Out of scope / non-goals
- **No C++/JUCE** for the app's own frontend/backend architecture (standing constraint). JUCE *export* for plugin devs stays as-is; it is not the embed target here.
- **No diffusion/Langevin inpainting** (Model #4) — CPU-impractical, no weights; `background_filled` stays classical (Telea/Poisson).
- Not a full Photoshop — compositing = place/transform/z-order/restyle of raster parts, **not** layer masks-on-masks, blend-mode stacks, or vector illustration.
- No literal Active-Contour snakes / live Cassowary solver — the shipped deterministic reframes (shape-fit, semantic inference) cover the need.

### 1.4 Guardrails
- Gemini key = the user's own **paid** credential; never provisioned by the assistant.
- `credentials.json` / `token.json` / `.env` are gitignored secrets.
- **Commit only when the user asks.**
- Every deterministic feature ships with a **golden/vitest floor**; every UI feature is **click-verified in `npm run dev`** before "done".

---

## 2. Current-state baseline (2026-07-05 audit)

| # | Capability | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Upload image | ✅ | `imageStore.ts`, `CanvasEditor.tsx` (drag-drop, multi-tab) |
| 2 | Detect elements | ✅ | `SemanticLayoutAnalyzer.tsx`, `/panel/analyze`, `panel_pipeline.py` (Gemini ON) |
| 3 | Edit / cut **detected** controls | ✅ | `ExtractionEditor.tsx` (SAM/lasso/brush + mask undo) |
| 3b | **Free-form cut of any region** | ⚠️ Partial | cut tools exist but are bound to the analysis/detected-control flow |
| 3c | **Import other images & cut parts** | ⚠️ Partial | file import exists (`AssetFileBrowser`), but no import→cut→place flow |
| 4 | **Paste parts onto the panel (compositing)** | ❌ Missing | Design workspace is a Konva *layout* tool, not a compositor onto a raster bg |
| 3d | Restyle / recolor | ⚠️ Partial | hue variants only (`ColorVariants.tsx`) |
| 5 | Export manifest + crops | ⚠️ Partial | `layout_manifest.py` (+semantics/shapes/interaction) + `background_export.py` punch-triple — **3 endpoints, manual assembly** |
| 6 | **Single embeddable / Claude-ready package** | ❌ Missing | no one-file package; no generated React; no LLM brief |
| — | Clean cut edges (de-halo) | ⚠️ Partial | edge-refine softens alpha; residual color halo; fill Telea-only |
| — | Click-verified in running app | ❌ Debt | recent work never walked in the Electron app |

**Already delivered (Models #3/#2/#5):** `layout_semantics.py`, `shape_fit.py`, `interaction_presets.py` — all on `layout.json`, golden-covered (39 golden + 29 shape + 20 semantics + 23 interaction; tsc + 58 vitest green).

---

## 3. Gap analysis → workstreams

- **G1 — Halo + fill quality** (pixel). → Model #1. Serves *every* cut, incl. composited ones.
- **G2 — Free-form cut + multi-image import** (feature). The "לגזור חלקים מהתמונה / מתמונות אחרות" primitive. *Core.*
- **G3 — Compositing canvas** (feature). The "להדביק אלמנטים" surface. *Core, largest.*
- **G4 — Restyle** (feature). Beyond hue.
- **G5 — Embeddable export** (assembly + codegen). The "מוכן להטמעה בפרונטאנד" deliverable. *Core.*
- **G6 — Verification debt** (quality).

Owner directive: **G2 + G3 + G5 are core, not optional.** They define whether the app can *design* a UI vs. only extract one.

---

## 4. Phased plan

> Effort key: **S** ≈ ½ session · **M** ≈ 1–2 · **L** ≈ 3–5 · **XL** ≈ multi-session.
> Nothing is "done" until its DoD passes (golden/vitest/tsc, plus `npm run dev` for UI phases).

### Phase 0 — Verification debt (G6)
**Goal:** prove the already-shipped work runs in the app before building on it.
**Tasks:** `npm run dev`; walk `DOGFOOD_CHECKLIST.md` on a real image — analyze → review queue → mask edit + Ctrl+Z/Y → re-analyze preserves edits (merge) → save/open `.synthskin` v2 → `/export/layout-manifest` shows `semantics`/`shape`/`interaction`. Log + hot-fix defects.
**DoD:** filled checklist; zero P0/P1 on existing features.
**Verify:** manual (user) + `test_golden.py` + `vitest`. **Effort:** S–M · **Risk:** Low · **Needs user:** yes.

### Phase 1 — Clean cuts: de-halo + gradient fill (G1 / Model #1)
**Goal:** every cut asset has a clean, color-decontaminated edge; `background_filled` looks seamless.
**Approach (deterministic, base-OpenCV):** `python/dehalo.py` — estimate true foreground color in the boundary band (fg = (obs − (1−α)·bg)/α) so rim pixels stop carrying old-background tint; apply in `background_export` crops and `_apply_mask_to_detection`. Add `fill_method:"poisson"` (`cv2.seamlessClone`) beside Telea/NS.
**DoD:** measurable rim ΔE drop in golden **and** user confirms halo visually gone.
**Verify:** `test_dehalo.py` + golden floors **+ `npm run dev` visual (user)** — agreed pairing. **Effort:** M · **Risk:** Med (guard behind flags; opt-in until confirmed) · **Depends:** P0 · **Needs user:** yes.

### Phase 2 — Free-form cut + multi-image import (G2)  ← new core
**Goal:** cut an arbitrary region from **any** image (the loaded panel or a newly imported one) and turn it into a placeable, transparent part.
**Approach:** generalize the existing cut tools (lasso / wand / SAM / rect in `ExtractionEditor`) so they operate on **any active raster**, decoupled from the detected-control flow; add an **import-as-source** action (reuse `AssetFileBrowser`/file import) that opens a foreign image in a cut surface; a cut yields a transparent part into a **Parts tray** (staging area), de-haloed via Phase 1.
**Tasks:** decouple cut engine from detection; import-as-source flow; "Parts tray" store + UI; each part = `{id, crop dataURL, srcImageId, provenance:'user'}`.
**DoD:** user imports a 2nd image, lassoes a region, and it appears as a clean transparent part in the tray, ready to place.
**Verify:** vitest (cut/part-model logic) + `npm run dev`. **Effort:** M–L · **Risk:** Med · **Depends:** P1 (clean edges) · **Needs user:** yes.

### Phase 3 — Compositing canvas (G3)  ← new core, largest
**Goal:** place tray parts **and** extracted controls onto the panel; move/scale/rotate; z-order; snap; each becomes a first-class layout element that survives re-analysis and flows into export.
**Approach:** a Konva **compositing layer** over the source raster (reuse Panel Designer transform machinery, bound to the real background, not a synthetic panel). Placed items are `source:'placed'`, `provenance:'user'` → excluded from the IoU-merge drop so re-analyze never deletes them; snap to `layout_semantics` alignment guides.
**Decomposition (ships incrementally):** **3a** place + move · **3b** scale/rotate + z-order · **3c** place from tray / packs / external PNG · **3d** merge-safety + export inclusion (crop→`assets/`, transform→`layout.json` rect/angle/scale; punched bg accounts for placed items). Undo/redo via the history store.
**DoD:** place 2 imported parts + 1 extracted knob, arrange them; `layout.json` + crops reflect all three at correct positions; re-analyze deletes none.
**Verify:** vitest (placement/transform/merge) + golden (export inclusion) + `npm run dev`. **Effort:** L–XL · **Risk:** Med-High · **Depends:** P2 · **Needs user:** yes.

### Phase 4 — Non-destructive restyle / recolor (G4)
**Goal:** adjust hue/sat/brightness/contrast/tint per element without destroying the original; bake at export.
**Approach:** an `adjustments` object on the element; live Konva preview; bake into the crop at export (`python/restyle.py` or canvas filter). Fold `ColorVariants` into this as write-back adjustments.
**DoD:** recolor an element, export, bundled crop reflects it; source untouched (reversible).
**Verify:** vitest (adjustment math) + golden (bake determinism) + `npm run dev`. **Effort:** M · **Risk:** Low-Med · **Depends:** P3 · **Needs user:** light.

### Phase 5 — Embeddable export package (G5 / vision steps 5–6)
**Goal:** one button → a package **ready to embed in a frontend**, and a precise brief for Claude.
**Deliverable:** `synthskin-handoff.zip`:
```
handoff/
  Panel.tsx                  # GENERATED React component (embeddable): semantics tree -> flex/grid JSX,
                             #   <img>/<Asset> per element at its rect, interaction presets as Framer-Motion props
  layout.json                # enriched: assets + semantics + shapes + interaction (incl. placed/restyled)
  assets/<id>.png            # per-element transparent crop (de-haloed)
  background/background_filled.png, background_punched.png
  preview.png                # flat render (human ground-truth)
  README_FOR_CLAUDE.md       # brief: contract for refining/extending Panel.tsx from layout.json
```
**Approach:** backend `python/handoff_bundle.py` + `/export/handoff-bundle` (returns zip base64) assembling the above; a **pure-TS generator** `src/lib/export/reactFromLayout.ts` (walks the semantics tree → JSX). Frontend **"Export for Frontend / Claude"** action in `ExportStudio.tsx`; `HandoffBundle`/`exportHandoffBundle` types.
**Note:** a thin bundle (assets + `layout.json`, no `Panel.tsx`) can ship early to lock the contract, then gain `Panel.tsx` + placed/restyled elements as P3/P4 land.
**DoD:** zip round-trips; `layout.json` validates; every asset resolvable; `Panel.tsx` compiles and renders assets at correct positions; a fresh Claude session, given only the bundle, refines it coherently.
**Verify:** `test_handoff_bundle.py` (assembly/completeness) + vitest (generator output compiles) + one real Claude round-trip + `npm run dev`. **Effort:** M–L · **Risk:** Med (codegen scope — keep the generator a *starter*, not a framework) · **Depends:** P3 (to include composed UI); thin slice can precede · **Needs user:** light.

---

## 5. Sequencing & milestones

```
P0 verify ─▶ P1 clean cuts ─▶ P2 free-form cut ─▶ P3 compositing ─▶ P4 restyle ─▶ P5 embeddable export
                               (+ multi-image)      (place/transform)               (React + assets + json)
                                     └──────────── thin export slice can start here to lock the contract ──┘
```

- **M1 — Clean & verified** = P0 + P1. Cuts look professional; existing app proven.
- **M2 — Cut & compose** = P2 + P3. **The interactive-design capability the owner flagged as essential** — import parts from other images, free-cut, and arrange them on a panel.
- **M3 — Ready to embed** = P5 (+ P4). One-button embeddable package (React + assets + `layout.json`) for a frontend, and a brief for Claude. **This is the vision's full loop.**

**Recommendation:** commit to **M1 → M2 → M3** as one continuous initiative. M2 is the heart (the "design a UI" ask); M3 makes it shippable into a project. Clean cuts (P1) come first because they raise the quality of *every* part M2/M3 will place and export.

---

## 6. Testing & verification strategy

- **Python:** standalone `assert`+`print` goldens (no pytest). New: `test_dehalo.py`, `test_handoff_bundle.py`; fold summary floors into `test_golden.py` (39 → grows). Run: `.venv/Scripts/python.exe test_golden.py`.
- **Frontend:** `vitest` for pure logic (cut/part model, placement/transform/merge, adjustments, React generator) + `tsc --noEmit`. Run: `npx vitest run && npx tsc --noEmit`.
- **Running app:** `npm run dev` walk per phase vs. `DOGFOOD_CHECKLIST.md`; **mandatory** for UI phases (1–5) and the pixel judgment in P1.
- **Gate:** merge only when golden + vitest + tsc green **and** (UI) the click-through passes.

---

## 7. Risk register

| Risk | Phase | Likelihood | Impact | Mitigation |
|------|-------|-----------|--------|-----------|
| De-halo over-corrects thin/AA edges | 1 | Med | Med | Opt-in flags; golden ΔE bounds; visual pass before default-on |
| Cut engine decoupling breaks the detection flow | 2 | Med | Med | Keep detected-control path intact; add a parallel free-cut path; vitest both |
| Compositing collides with re-analyze merge (clobbers placed items) | 3 | Med | High | `provenance:'user'` + `source:'placed'` excluded from IoU-drop; unit tests |
| Compositing scope creep → "build Photoshop" | 3 | High | Med | Strict 3a–3d; ship 3a first; non-goals in §1.3 enforced |
| React generator scope creep | 5 | Med | Med | Generator emits a *starter* component only; Claude/owner refine |
| Coordinate contract underspecified → misplacement | 5 | Med | Med | Explicit rect contract in README + `preview.png` ground-truth; real Claude test |
| Green tests but broken in app (standing pattern) | all | Med | High | P0 gate + mandatory `npm run dev` per UI phase |
| Non-ASCII/Hebrew path + cv2 imwrite | 1,2,3,5 | Low | Med | Reuse `imencode`+`write_bytes` pattern |

---

## 8. Success metrics

- **Design loop:** user imports a 2nd image, cuts a part, places it on a panel with a detected knob, restyles it, and exports — all in-app, no manual file wrangling. *(M2→M3)*
- **Cut quality:** rim ΔE reduced ≥ 50% vs. baseline; halo invisible at 400% zoom. *(M1)*
- **Embeddability:** generated `Panel.tsx` compiles and renders assets within a few px of `layout.json` rects. *(M3)*
- **Handoff fidelity:** a fresh Claude session, given only the bundle, refines/extends the UI coherently. *(M3)*
- **Durability:** placed + restyled elements survive re-analyze with zero data loss. *(M2)*
- **Green bar** held at every milestone.

---

## 9. Traceability — vision & five models → phases

| Owner ask | Phase(s) | Closes |
|-----------|----------|--------|
| Upload / detect / cut detected | done | ✅ (verified in P0) |
| **"לגזור חלקים מהתמונה" free-form cut** | **P2** | G2 |
| **"להדביק חלקים מתמונות אחרות" import + composite** | **P2 + P3** | G2 + G3 |
| **"לעצב ממשק אינטראקטיבי שלם"** | P3 + P4 (+#5 interaction, shipped) | G3 + G4 |
| **"לשלוח מוכן להטמעה בפרונטאנד"** | **P5** | G5 / G6-export |
| "עצב אותם" restyle/recolor | P4 | G4 |
| Clean cuts | P1 | G1 |
| Model #3 semantics · #2 shape-fit · #5 interaction | shipped | ✅ in `layout.json` |
| Model #1 Poisson → de-halo + fill | P1 | this plan |
| Model #4 diffusion | — | deferred (non-goal) |

---

### Immediate next action
The plan now treats **cut-from-any-image + paste-from-other-images (P2+P3)** and the **embeddable export (P5)** as committed core, per your direction. Proposed start: **Phase 1 (clean cuts)** — it's the quality foundation every placed part depends on, and it's the paired `npm run dev` task we already agreed on — then straight into **P2 (free-form cut + import)**. Say the word and I begin Phase 1; or if you'd rather see the compositing skeleton first, I can lead with a P2 thin slice instead.
