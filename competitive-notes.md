# Competitive Notes

## Target Competitors
- **PluginGuiMagic** — JUCE-native CSS-like theming, live editing via ValueTree
- **HISE UI editor** — Scripted UI with visual layout, heavy use of JSON panels
- **VST GUI Pro (Figma)** — Figma-to-JUCE workflow, no live preview
- **Real Grooves Audio kits** — Pre-built component graphics packs

## Current SynthSkin Advantages (pre-Milestone 1)
- PBR WebGL rendering of knobs/sliders (no competitor does this)
- Integrated extraction from existing plugin screenshots
- Full lighting system with dome, shadows, AO
- Animation studio with physics and meter ballistics
- All-in-one workspace UX

## Current SynthSkin Disadvantages
- No live JUCE preview (no bridge to running plugin)
- No CSS/stylesheet theming system
- No brand consistency system across projects
- No full project generation (only component export)
- No marketplace/sharing ecosystem

## Key Observations
- PluginGuiMagic's #1 selling point is live editing while DAW is running — Milestone 1 directly addresses this
- HISE is scripting-heavy, which scares off designers — SynthSkin's visual approach is a genuine advantage
- Figma workflows require manual export/rebuild cycle — live bridge eliminates this entirely
