# SynthSkin — Extraction & Slicing Masterplan

> מסמך תכנון חי. מטרה: להפוך את הזרימה **תמונה → ניתוח → גזירה → אססטס לקוד** למקצועית ביותר שיש, כולל שלב עריכה/תיקון ידני ברמת Photoshop/Affinity.
> נכתב על בסיס הרצת dogfood אמיתית (2026-06-30) על פאנל WAVESTRUCT.

---

## 0. עיקרון מנחה

הבעיה מתפצלת לשתי תת-בעיות שונות, ולכל אחת SOTA נפרד. אסור לערבב:

| תת-בעיה | "מה השאלה" | SOTA |
|---------|------------|------|
| **Detection / Classification** | מה כל אלמנט ואיפה? | **VLM** (Gemini 2.5 / Florence-2) + YOLO מאומן |
| **Segmentation / Slicing** | חיתוך נקי עם alpha | **SAM 2** + **Alpha Matting** (BiRefNet/ViTMatte) |

הזרימה המקצועית: **VLM מבין → SAM2 חותך → Matting מלטש קצוות → משתמש מתקן ידנית → ייצוא multi-res.**

---

## 1. מצב נוכחי — מה ההרצה הוכיחה

הרצה: `python/dogfood_pipeline.py` על WAVESTRUCT (1536×1024), CPU, **מצב CV-only** (כל ה-VLM כבוי).

**תוצאות:** 137 רכיבים, 97 לייבלים. `button=64, knob=32, led=32, screen=2, slider=7`. זמן: 68ש' (זיהוי 57ש').

**מה עובד:**
- ✅ **גזירה: 135/137 מסכות alpha נקיות** — SAM2/GrabCut עושים את העבודה. זו ההוכחה ש-SAM2 הוא הבחירה הנכונה.
- ✅ recall גבוה על נובים באזורים נקיים (אוסילטורים, אפקטים, ADSR).
- ✅ OCR (RapidOCR) קורא לייבלים בביטחון >0.99.

**מה שבור (precision):**
- ❌ אזור ה-WAVETABLE VIEW הוצף בעשרות false-positives — CV רואה טקסטורה צבעונית כקצוות. מסך ענק אחד התפרק ל~50 שגיאות.
- ❌ סיווג שגוי: לוגו→knob, dropdown→slider, טקסט (LP/3D/ALWAYS)→knob.
- ❌ רק 2 "screens" — שניהם שגויים. כל המסכים האמיתיים פוספסו כ-screen.
- ❌ קישור לייבל↔רכיב נאיבי: "WAVESTRUCT" הוצמד לנוב.
- ❌ YOLO גנרי (`yolo11n.pt`): **0 הצעות** — חסר תועלת מוחלט לסינתי.

**מסקנה:** הסגמנטציה פתורה. **הזיהוי הוא צוואר הבקבוק — וזה בדיוק מה שה-VLM פותר.** המוח כבוי, ולכן ה-CV מנחש לבד.

---

## 2. ארכיטקטורת היעד

```
                    ┌─────────────────────────────────────────────┐
  תמונה (full-res)  │  STAGE 1 — DETECT (semantic)                │
  ─────────────────▶│  Gemini 2.5  +  synth-YOLO  +  CV refine    │
                    │  → bbox + type + label לכל רכיב             │
                    └───────────────────┬─────────────────────────┘
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  STAGE 2 — SEGMENT (SAM 2 large, box-prompt) │
                    │  → מסכה בינארית מדויקת לכל bbox              │
                    └───────────────────┬─────────────────────────┘
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  STAGE 3 — MATTING (BiRefNet/ViTMatte)       │
                    │  full-res על ה-crop → alpha רך תת-פיקסלי     │
                    └───────────────────┬─────────────────────────┘
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  STAGE 4 — MANUAL REFINE (Pro Editor)        │
                    │  SAM-clicks · Refine Edge · Boolean · Pen    │
                    │  · Lasso · pixel-zoom · brush — המשתמש מתקן  │
                    └───────────────────┬─────────────────────────┘
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  STAGE 5 — EXPORT  PNG @1x/2x/3x + JSON      │
                    │  (זווית, טווח, צבע, label) → JUCE binding    │
                    └─────────────────────────────────────────────┘
```

---

## 3. בחירת המודלים (החלטה סופית + נימוק)

| תפקיד | מודל נבחר | למה | חלופה | סטטוס בקוד |
|-------|-----------|-----|-------|------------|
| הבנה סמנטית | **Gemini 2.5 Flash** | מבין הקשר ("מסך אחד", "4 נובי אפקט"), מוחק false-positives, קורא ערכים | Florence-2 (מקומי), Qwen2.5-VL | מחובר, צריך מפתח |
| זיהוי מהיר | **YOLO11 fine-tuned** | מהיר, deterministic, classes סינתי | — | `train_synth_detector.py` קיים, לא אומן |
| דיוק תת-פיקסל | **OpenCV** (Hough/contour) | מיקום מדויק של מרכז/רדיוס נוב | — | ✅ `ui_layout_analyzer.py` |
| סגמנטציה | **SAM 2 (large)** | SOTA promptable, box-prompt מכל detection | — | ✅ `sam_service.py`, כרגע `tiny` |
| Alpha matting | **BiRefNet** | SOTA לקצוות high-res נקיים, trimap-free | ViTMatte, MatteAnything | ❌ צריך להוסיף |
| OCR | **RapidOCR** | מהיר, ONNX, רישיון Apache | PaddleOCR | ✅ עובד |

---

## 4. Phase 1 — המוח הסמנטי (מקומי-תחילה) 🧠

> **עודכן 2026-06-30 לפי מדידה.** נמדדו כל הדטקטורים המקומיים המוכנים-מראש — **כולם נכשלים על UI של סינתי:**
> - YOLO-World (open-vocab): 7 זיהויים, ביטחון <0.18, 168ש' — domain gap (אומן על תמונות טבע).
> - Florence-2: הוצא משימוש בפרויקט (עטף כל לייבל כנוב).
> - YOLO גנרי (`yolo11n.pt`): 0 הצעות.
> - YOLO ייעודי: לא ניתן לאמן — ה-dataset ריק (`training-panel-corpus/summary.json`: 0 דגימות).
>
> **מסקנה:** אין מודל מדף מקומי. הזיהוי הטוב היחיד הוא ענן (Gemini) או מודל מאומן. **החלטת המשתמש: 1→2→3** —
> קודם לחזק CV מקומית, אז Gemini אופציונלי, ובמקביל לבנות dataset לאימון עתידי.

**משימות (לפי הסדר):**
1. **חיזוק CV מקומי** (ראשי) — לתקן את הכשלים שנמדדו:
   - `_suppress_inside_displays` (חדש) — דיכוי נחיל ה-false-positives בתוך מסכים. ✅ מיושם.
   - תיקון סיווג: לוגו→knob, dropdown→slider; זיהוי מסך גדול אחד במקום 50 שברים.
2. **Gemini אופציונלי** — `/panel/set-gemini-key` קיים; כבוי כברירת מחדל, כפתור "שדרוג איכות" מדליק.
3. **Dataset bootstrap** — לולאת `save_layout_sample` → corpus → אימון `synthskin_yolo.pt` עתידי.

**קריטריון קבלה:** על WAVESTRUCT (CV מקומי בלבד) — ≤60 רכיבים (היה 137), אפס נחיל בתוך ה-wavetable view, המסך הגדול = detection יחיד.

**מאמץ:** 2-3 ימים (CV hardening + bootstrap). **חוסם:** אין — הכל מקומי.

---

## 5. Phase 2 — גזירה ברזולוציה מקסימלית 🔬

**מטרה:** קצוות מושלמים — ההבדל בין "חיתוך טוב" ל"Photoshop-perfect".

**משימות:**
1. `python/ai/matting.py` חדש — wrapper ל-BiRefNet (`transformers`/ONNX), עם `check_matting_available()` + fallback ל-`_refine_mask_edges` הקיים.
2. שלב matting ב-`panel_pipeline.py` אחרי הסגמנטציה: לכל crop, להריץ matting **ברזולוציה מקורית** (crops קטנים → זול).
3. endpoint `/ai/matte` + מתודה ב-`pythonClient.ts`.
4. תיקון downscale: כיום `DETECTION_MAX_DIM=1600`. לוודא שהמסכה הסופית וה-crop נחתכים מ**התמונה המקורית**, לא מהמוקטנת.

**קריטריון קבלה:** נוב עם טבעת זוהרת נחתך ללא halo; קצה anti-aliased ב-zoom 800%; alpha רציף (לא בינארי) בגבול.

**מאמץ:** 1-1.5 ימים. **חוסם:** אין (הורדת מודל אוטומטית).

---

## 6. Phase 3 — עורך תיקון ידני מקצועי ✏️

**מטרה:** המשתמש מתקן כל חיתוך אוטומטי, חותך טוב יותר, ומשנה. כל הכלים המקצועיים, ברזולוציה גבוהה.

**רוב העבודה = חיווט backend קיים ל-UI.** בסיס: [ExtractionEditor.tsx](../src/components/canvas/ExtractionEditor.tsx).

| כלי | Backend | פעולה |
|-----|---------|-------|
| Brush / Eraser (alpha) | ✅ קיים | ✅ קיים |
| **SAM clicks** +/− (re-segment חי) | ✅ `segmentPoint` | לחבר: קליק→`/sam/segment-point`→עדכון מסכה |
| **Refine Edge** panel | ✅ `refineExtraction` | לחבר sliders: radius/smooth/feather/contrast/shift |
| **Boolean** add/sub/intersect | ✅ `combineMasks` | לחבר Shift/Alt-draw |
| **Lasso / Polygon** | ✅ `extractPolygon` | כלי lasso חדש ב-UI |
| **Pen / Bézier** | ❌ | לבנות: path tool + warp |
| **Magnetic Lasso** | ❌ | לבנות: edge-snapping |
| **Pixel-zoom + marching ants + checkerboard** | ❌ | לבנות ב-canvas |

**משימות:**
1. להרחיב `EditorTool` ל-`move|brush|eraser|sam-add|sam-sub|lasso|pen|refine`.
2. פאנל "Refine Edge" (כמו פוטושופ) מחובר ל-`refineExtraction`.
3. SAM interactive: קליקים חיוביים/שליליים → re-segment של הרכיב הנבחר.
4. Boolean ops עם Shift (add) / Alt (subtract).
5. Pixel-grid + marching-ants + checkerboard alpha preview.
6. עבודה ב-resolution מקורי (לא thumbnail) עם zoom עד 1600%.
7. History (undo/redo) לכל פעולת מסכה.

**קריטריון קבלה:** אפשר לקחת חיתוך שגוי (למשל המסך שהתפצל), לתקן אותו ל-asset מושלם בלי לצאת לכלי חיצוני; כל כלי עובד ב-zoom pixel-level.

**מאמץ:** 3-4 ימים (עיקר העבודה UI).

---

## 7. Phase 4 — נתונים → קוד 🔌

**מטרה:** כל asset יוצא עם ה-metadata שצריך ל-JUCE.

**משימות:**
1. לוודא `extract_features` ממלא לכל נוב: זווית מינ'/מקס', כיוון, מרכז/רדיוס מדויק.
2. סליידר: travel (start/end), אוריינטציה.
3. צבע LED/accent לכל רכיב.
4. ייצוא: `assets/<param_id>@1x|2x|3x.png` + `layout.json` → קישור ל-`src/generator/` (כבר קיים).

**קריטריון קבלה:** ייצוא של WAVESTRUCT → פרויקט JUCE שבו כל נוב ממופה ל-parameter עם הזווית הנכונה.

**מאמץ:** 1-2 ימים.

---

## 8. סדר עבודה ותלויות

```
Phase 1 (מוח)  ──┐ חוסם: מפתח Gemini
                 ├──▶ Phase 2 (matting) ──┐
Phase 3 (עורך) ──┘ עצמאי, אפשר במקביל     ├──▶ Phase 4 (קוד→JUCE)
                                          ┘
```

- **Phase 1** ראשון — הכי משפיע, אבל חוסם על מפתח.
- **Phase 3** אפשר להתחיל מיד במקביל (לא תלוי בכלום).
- **Phase 2** אחרי 1.
- **Phase 4** אחרון.

---

## 9. החלטות פתוחות (צריך תשובת משתמש)

1. **מפתח Gemini** — יש? (חוסם Phase 1). אם לא — נלך על Florence-2 מקומי (להוריד), איטי יותר אבל ללא ענן/עלות.
2. **CPU או GPU?** כרגע CPU (SAM2 large יהיה איטי). יש GPU זמין?
3. **ענן מול מקומי** — Gemini (ענן, מהיר, עלות לבקשה) מול Florence-2/Gemma (מקומי, חינם, איטי). העדפה?

---

_מסמך זה מתעדכן בכל שלב. Ground truth: `.tmp/dogfood/` (report.md, overlay.png, layout.json, assets/)._
