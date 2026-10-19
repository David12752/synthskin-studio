# UX Guide

## Design Language

SynthSkin Studio uses a warm, dark theme inspired by professional audio plugin interfaces. The palette centers around deep burnt-umber tones with amber (#ffaa33) as the primary accent color.

### Color System

| Token | Hex | Usage |
|-------|-----|-------|
| `surface-0` | `#14110f` | Status bar, deepest background |
| `surface-1` | `#1a1816` | Side panels |
| `surface-2` | `#1f1d1b` | Toolbars, command palette, context menus |
| `surface-3` | `#252220` | Hover states, elevated elements |
| `surface-4` | `#2a2724` | Borders, dividers |
| `surface-5` | `#3a3633` | Separators, subtle borders |
| `canvas` | `#161412` | Canvas background |
| `accent` | `#ffaa33` | Active states, focus rings |
| `accent-dim` | `#cc8829` | Dimmed accent |
| `accent-bright` | `#ffbb55` | Bright accent variant |
| `accent-text` | `#ffe8b3` | Active workspace text |
| `muted` | `#6a6560` | Inactive text |
| `muted-hover` | `#8a8580` | Inactive hover |
| `muted-text` | `#c4c0b8` | Icon default color |

### Typography

- **Display font**: Inter Tight — used for all UI text
- **Monospace font**: JetBrains Mono — used for numeric values and shortcuts
- **Size scale**: 10px (labels), 11px (body), 12px (context menus), 13px (tabs)

### Layout Dimensions

| Element | Height | Notes |
|---------|--------|-------|
| Title bar | 32px | Draggable region, app branding + workspace switcher |
| Toolbar | 44px | Gradient background (from-[#211f1d] to-surface-2) |
| Status bar | 24px | Fixed bottom, surface-0 background |
| Side panels | Resizable | Default ~240px, min 160px, drag handle |
| Command palette | — | 600px wide, 24px border-radius, centered at 15vh |
| Context menu | — | 220px min-width, 12px border-radius |

## Interaction Patterns

### Command Palette (`Ctrl+K`)

The command palette is the primary discovery mechanism. It supports:

- **Fuzzy search** — Type partial names to filter (e.g., "zom" matches "Zoom to Fit")
- **Recent commands** — Last 8 used commands appear at the top when opening
- **Category grouping** — Commands organized by File, Workspace, View, Edit, Extract, Foundry, Tool, Asset
- **Workspace scoping** — Extract tools only show when in the Extract workspace

### Context Menus (Right-Click)

Every interactive area has a context menu:

- **Canvas**: Import, zoom, grid, tools, auto-detect
- **Asset cards**: Select, edit, export, delete
- **Inspector**: Export, studio, copy bounds, delete
- **Workspace tabs**: Switch workspaces, fullscreen modes

Context menus support:
- Keyboard navigation (arrow keys)
- Shortcut display
- Submenu support
- Destructive item styling (red text)
- Viewport clamping (stays on screen)

### Keyboard Shortcuts

Shortcuts are workspace-scoped:
- **Global shortcuts** work everywhere (Ctrl+S, Ctrl+Z, F, etc.)
- **Workspace shortcuts** only work in their workspace (V, C, R, S, W for extract tools)
- Hold **Space** for temporary pan in the canvas

### Panel Resizing

Side panels are resizable via drag handles:
- Drag the 4px divider between panels
- Divider highlights amber (#ffaa33) on hover
- Panels remember their size

### Workspace Transitions

Switching workspaces uses a 150ms fade transition:
- Content fades out (100ms)
- New content fades in (150ms)
- Tab interaction disabled during transition

## Canvas Behaviors

- **Zoom**: Mouse wheel to zoom in/out, centers on cursor position
- **Pan**: Middle-click drag, Space+drag, or Hand tool
- **Pixel-perfect**: At zoom >100%, canvas switches to nearest-neighbor rendering
- **Drop files**: Drag PNG/JPG/WebP files directly onto the canvas
- **Grid overlay**: Toggle pixel grid and rulers
- **Crosshair**: Shows on extraction tools (circle, rect, sam, wand)

## Inspector

The right panel shows context-sensitive properties:
- **Asset selected**: Full property panel with name, type, bounds, materials, export, delete
- **Wand tool active**: Magic Wand parameters (mode, tolerance, feather, expand, edge sensitivity)
- **Other tools active**: Tool hints with usage instructions
- **Nothing selected**: Prompt to select a tool or asset
