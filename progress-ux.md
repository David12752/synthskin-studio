# UX Overhaul — Progress Tracker

## Reference
- Model: DaVinci Resolve / Photoshop / Ableton  
- 5 Workspaces: EXTRACT → FOUNDRY → DESIGN → ANIMATE → EXPORT  
- Command Palette (Cmd+K), context menus, keyboard shortcuts, resizable panels  

## Feature Mapping: Old → New

| Old Location | New Workspace | Notes |
|---|---|---|
| Toolbar extraction tools (V/C/R/S/W/H/Z) | EXTRACT toolbar | Same tools, new toolbar layout |
| AssetLibrary (left panel) | EXTRACT left panel (source images) + DESIGN library tab | Split by workspace role |
| CanvasEditor (center) | EXTRACT canvas + DESIGN panel canvas | Two variants of center canvas |
| Inspector (right panel) | EXTRACT inspector + DESIGN inspector | Context-sensitive per workspace |
| Batch Detect | EXTRACT → Auto-Detect All button | Becomes toolbar action in EXTRACT |
| KnobFoundry/SliderFoundry/IndicatorFoundry/DisplayFoundry | FOUNDRY workspace | Each foundry type = FOUNDRY mode selector |
| ComponentLibrary | FOUNDRY left panel (presets browser) | Integrated as preset sidebar |
| PanelCanvas (panel designer) | DESIGN workspace center | Becomes main canvas in DESIGN |
| LightingPanel | DESIGN right panel section | Integrated into inspector |
| AnimationStudio/MeterStudio/PhysicsStudio | ANIMATE workspace | Each becomes animation editor mode |
| ExportStudio | EXPORT workspace | Becomes full workspace |
| AIStudio | Cross-workspace (command palette accessible) | AI tools invocable from any workspace |
| QualityStudio | Cross-workspace (command palette accessible) | Quality checks from any workspace |

---

## Phase A: Foundation
- [x] A1: Create `workspaceStore.ts` — workspace state, panel sizes, persistence
- [x] A2: Update theme tokens — new surface colors, status bar, toolbar styling
- [x] A3: Create `WorkspaceShell.tsx` — universal grid layout (header, panels, center, status)
- [x] A4: Create `WorkspaceSwitcher.tsx` — top-center workspace tabs with Cmd+1-5
- [x] A5: Create `ResizablePanel.tsx` — left/right/bottom panels with drag dividers
- [x] A6: Create `useKeyboardShortcuts.ts` — registry system, per-workspace shortcuts
- [x] A7: Create `CommandPalette.tsx` — Cmd+K shell with fuzzy search
- [x] A8: Create `ContextMenu.tsx` — reusable right-click context menu component
- [x] A9: Integrate into App.tsx — swap layout to WorkspaceShell, render existing content in Extract workspace
- [x] A10: Verify all existing features still work in new layout

## Phase B: Workspace Routing
- [x] B1: Route workspace content — each workspace renders its specific panels/toolbar
- [x] B2: Workspace-specific toolbars — EXTRACT, FOUNDRY, DESIGN, ANIMATE, EXPORT, MARKET
- [x] B3: Crossfade transitions between workspaces
- [x] B4: Per-workspace panel state persistence
- [x] B5: Persist last-used workspace per project

## Phase C: Workspace Implementation
- [x] C1: DESIGN workspace (PanelCanvas inline + design inspector)
- [x] C2: EXTRACT workspace (CanvasEditor + extraction tools + library + inspector)
- [x] C3: FOUNDRY workspace (all foundry types in FoundryWorkspace)
- [x] C4: ANIMATE workspace (PhysicsStudio inline)
- [x] C5: EXPORT workspace (ExportStudio inline + project generator/build/bake panels)

## Phase D: Command Palette Population
- [ ] D1: Register all workspace commands
- [ ] D2: Fuzzy search with scoring
- [ ] D3: Recent commands tracking (localStorage)
- [ ] D4: Component search integration

## Phase E: Context Menus & Polish
- [ ] E1: Canvas component context menu
- [ ] E2: Library item context menu
- [ ] E3: Layer panel context menu
- [ ] E4: Inspector parameter context menu
- [ ] E5: All keyboard shortcuts from spec
- [ ] E6: Tooltip shortcut hints on all toolbar buttons
- [ ] E7: Final visual polish pass
