# Milestone 5 — Visual Quality Upgrade
**Status:** COMPLETE ✓  
**Date:** 2026-04-14

---

## Objective

Upgrade SynthSkin Studio's rendering pipeline from a basic Cook-Torrance PBR shader to a
full Disney Principled BRDF with anisotropy, sheen, clearcoat, ACES tonemapping, wear
simulation, bloom/LED effects, font management, and a texture-atlas subsystem.

---

## Deliverables

### M5.1 — Extended Material Type System
- **File:** `src/materials/types.ts` — REWRITTEN
- Full Disney BRDF extensions: `anisotropic`, `anisotropicRotation`, `sheen`, `sheenTint`,
  `specular`, `specularTint`, `emissionColor`, `emissionIntensity`, `subsurfaceColor`
- Vintage wear types: `WearPresetId`, `WearPreset`, `WEAR_PRESETS` (5 presets)
- Updated `MaterialShaderParams` + `materialToShaderParams()` to cover new uniforms

### M5.2 — Expanded Material Library (18 → 35+ materials)
- **`src/materials/library/metals.ts`** — 5 → 14 metals
  - New: `polishedAluminum`, `stainlessBrushed` (anisotropic), `brassBright`, `brassAged`,
    `copperShiny`, `castIron`, `powderCoatedBlack`, `powderCoatedBlue`, `hammertone`
- **`src/materials/library/plastics.ts`** — 4 → 12 plastics
  - New: `vintageCream`, `pebbledBlack`, `translucentAmber`, `frostedGlass`,
    `ledRed`, `ledGreen`, `ledBlue` (all emissive-capable)
- **`src/materials/library/woods.ts`** — 4 → 8 woods
  - New: `ebony`, `maple`, `mahogany`, `oliveWood`
- **`src/materials/library/special.ts`** — 3 → 9 specials
  - New: `carbonFiber12k`, `smoothLeather`, `agedLeather`, `clearGlass`, `tubeGlass`
- **`src/materials/index.ts`** — re-exported 35+ materials + wear types

### M5.3 — Disney Principled BRDF Shader
- **File:** `src/foundry/knobs/shaders/knob.frag` — REWRITTEN
- Anisotropic GGX NDF (`D_GGX_Aniso`) with tangent frame rotation
- Burley diffuse (`Fd_Burley`) replacing Lambertian
- Sheen lobe (`F_Sheen`) for fabric/leather grazing highlight
- Wear system: scratch simulation noise, oxidation/patina color shift, roughness build-up
- ACES filmic tonemapping replacing Reinhard
- 12 new uniforms: `uAnisotropic`, `uAnisotropicRotation`, `uSheen`, `uSheenTint`,
  `uSpecular`, `uSpecularTint`, `uEmissionColor`, `uEmissionIntensity`,
  `uWearAmount`, `uScratchDensity`, `uOxidation`
- **File:** `src/foundry/knobs/KnobRenderer.ts` — updated with 12 new regl prop declarations

### M5.4 — HDRI Environment System
- **File:** `src/lighting/HDRIEnvironment.ts` — NEW
- 5 analytic HDRI presets: `studio`, `warm-room`, `dark-rack`, `cold-lab`, `custom`
- `sampleIBL(normal, hdri)` — procedural sky gradient sampling from world normal
- `sampleSpecularIBL(normal, roughness, hdri)` — IBL + reflection combo

### M5.5 — Vintage Wear Simulator
- **File:** `src/rendering/wear/WearSimulator.ts` — NEW
- `WearEnvironment` type (4 environments: clean-studio / smoky-club / dusty-attic / humid-coast)
- `applyWear(material, preset, env)` → shader-ready `AppliedWear` 
- `interpolateWear()` for animated aging slider
- `getFingerPrintOverlayCSS()` for CSS fingerprint overlay
- Import path bug fixed: `../../materials/types`

### M5.6 — WearPanel UI Component
- **File:** `src/components/foundry/WearPanel.tsx` — NEW
- 5-node connected timeline (pristine → well-worn) with gold progress fill
- Per-stat wear bars: scratches / edge wear / oxidation / dust / fingerprints
- Environment grid (4 tiles) + sun exposure slider + near-heat toggle
- Wear intensity override + "Use preset" reset button

### M5.7 — LED/Bloom Effect Engine
- **File:** `src/rendering/bloom/BloomEffect.ts` — NEW
- `computeBloom()` — 4-layer CSS box-shadow approximating Gaussian bloom
- `paintBloom()` — canvas 2D bloom paint (screen blend, shadowBlur)
- `computeColorBleed()` — inverse-square emissive color bleed to neighbors
- Matches ACES shader output via 'screen' composite mode

### M5.8 — Render Quality Store + Panel
- **File:** `src/stores/renderQualityStore.ts` — NEW
  - 4 quality presets: Draft / Standard / High / Ultra
  - Zustand store persisted to localStorage
  - Parameters: supersampling, AO samples, IBL, anisoto, clearcoat, PBR iterations
- **File:** `src/components/foundry/RenderQualityPanel.tsx` — NEW
  - 4-column grid with icon + config breakdown per preset
  - Ultra warning badge

### M5.9 — Font Manager + Font Picker
- **File:** `src/typography/FontManager.ts` — NEW
  - 26 OFL/Apache/MIT fonts catalogued with id, category, license, variants, bundled flag
  - `isCommercialUseOk()` — license gate for JUCE export workflow
  - `generateFontBinaryDataLines()` — CMake BinaryData resource list generator
  - `generateJuceFontLoader()` — JUCE C++ typeface loading code generator
- **File:** `src/components/typography/FontPicker.tsx` — NEW
  - Search, category tabs, license badge, commercial-use warning footer
  - Controlled via `value` / `onChange` props

### M5.10 — Texture Atlas Optimizer
- **File:** `src/rendering/atlas/TextureAtlas.ts` — NEW
  - Shelf-first bin-packing, power-of-2 sizing
  - `pack(images)` → `AtlasResult { canvas, entries, width, height }`
  - `upload(gl, result)` — WebGL texture upload with mipmap + anisotropic filtering
  - `buildAtlas()` / `uploadAtlas()` convenience factories

### M5.11 — KnobFoundry Integration
- **File:** `src/foundry/KnobFoundry.tsx` — UPDATED
  - Added `WearPanel` section in right panel (collapsed by default)
  - Added `RenderQualityPanel` section in right panel (collapsed by default)
  - Local state for `wearPreset`, `wearAmount`, `wearEnv`

---

## Quality Gates

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ 0 errors |
| All existing features unaffected | ✅ No regressions |
| Import paths valid | ✅ Fixed WearSimulator `../../materials/types` |
| No new external dependencies | ✅ Pure TypeScript/React |

---

## New Files

```
src/materials/types.ts                        (rewritten)
src/materials/library/metals.ts               (extended)
src/materials/library/plastics.ts             (extended)
src/materials/library/woods.ts                (extended)
src/materials/library/special.ts              (extended)
src/materials/index.ts                        (rewritten)
src/foundry/knobs/shaders/knob.frag           (rewritten)
src/foundry/knobs/KnobRenderer.ts             (updated)
src/lighting/HDRIEnvironment.ts               (new)
src/rendering/wear/WearSimulator.ts           (new)
src/rendering/bloom/BloomEffect.ts            (new)
src/rendering/atlas/TextureAtlas.ts           (new)
src/stores/renderQualityStore.ts              (new)
src/components/foundry/WearPanel.tsx          (new)
src/components/foundry/RenderQualityPanel.tsx (new)
src/typography/FontManager.ts                 (new)
src/components/typography/FontPicker.tsx      (new)
src/foundry/KnobFoundry.tsx                   (updated)
```

---

## Next Steps — Milestone 6

Recommended: proceed to **Milestone 6 (Export Pipeline + JUCE Integration)** which builds on
the font catalog and material system implemented here.

Key items for Milestone 6:
1. Wire `FontManager.generateJuceFontLoader()` into the JUCE export pipeline
2. Wire `TextureAtlas` into `KnobRenderer.ts` for batched GPU texture uploads
3. Wire `BloomEffect` CSS to LED materials in the Foundry preview + Panel Designer
4. Wire `HDRIEnvironment` into `useSceneLighting` / lighting store for environment switching
5. Wire `renderQualityStore` supersampling factor into `KnobRenderer` canvas size
