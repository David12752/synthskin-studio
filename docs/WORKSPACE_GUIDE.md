# Workspace Guide

SynthSkin Studio organizes work into 5 sequential workspaces, each focused on a stage of the plugin UI creation pipeline.

## 1. Extract (`Ctrl+1`)

**Purpose**: Import a reference image and extract individual UI components from it.

### Tools

| Tool | Key | Usage |
|------|-----|-------|
| Select | `V` | Click assets on the canvas |
| Circle Extract | `C` | Click center → drag radius. Best for knobs/dials |
| Rect Extract | `R` | Click → drag rectangle. Best for sliders/screens |
| Smart Select | `S` | One-click auto-extract using multi-strategy detection |
| Magic Wand | `W` | Configurable extraction with tolerance, feather, edge sensitivity |
| Hand | `H` | Drag to pan |
| Zoom | `Z` | Click to zoom in, Alt+click to zoom out |

### Features

- **Auto-Detect All**: Batch detection using contour analysis + Hough circle detection
- **Asset Library**: Left panel shows all extracted assets as thumbnails
- **Inspector**: Right panel shows properties of selected asset or tool settings
- **Drag & Drop**: Drop image files directly onto the canvas

### Magic Wand Modes

- **Element**: Edge-aware detection — finds element boundaries
- **Invert**: Select background, inverts to get the foreground element
- **Color**: Classic flood-fill by color similarity

## 2. Foundry (`Ctrl+2`)

**Purpose**: Create and customize UI components from scratch or from extracted assets.

### Tabs

- **Knobs**: Rotary knob designer with center point, rotation range, arc visualization
- **Sliders**: Linear slider/fader designer
- **Indicators**: LED indicators, meters, level displays
- **Displays**: Screens, readouts, waveform displays

### Actions

- New component
- Duplicate component
- Save to library
- Compare variants
- Generate color variants

## 3. Design (`Ctrl+3`)

**Purpose**: Arrange components into a complete plugin panel layout.

### Tools

- **Select** (`V`): Select and click components
- **Move** (`M`): Reposition components
- **Rotate** (`T`): Rotate components
- **Group** (`Ctrl+G`): Group multiple components

### Features

- Alignment tools (align left/center/right/top/middle/bottom)
- Distribution (equal spacing)
- Snap to grid (`'`)
- Section and label creation
- Lighting and background settings
- Preview mode

## 4. Animate (`Ctrl+4`)

**Purpose**: Define animation behaviors for interactive components.

### Animation Types

- **Rotation**: Define rotation range and easing
- **Physics**: Spring-based physics simulation
- **Ballistics**: Meter ballistics (VU, PPM, custom)
- **LED Patterns**: Sequential/random LED animation patterns

### Controls

- Preview playback (`Space`)
- Loop toggle (`L`)
- Generate animation frames (`G`)

## 5. Export (`Ctrl+5`)

**Purpose**: Export the complete plugin UI for use in JUCE or other frameworks.

### Workflow

1. **Project Settings**: Configure output format, resolution
2. **Validate**: Check all components are properly configured
3. **Auto-Bind**: Automatically map components to plugin parameters
4. **Format/Scale**: Choose export format and scale factor
5. **Export** (`Ctrl+B`): Generate output files
6. **Live Preview JUCE** (`Ctrl+Shift+B`): Real-time preview in JUCE framework

## Cross-Workspace Features

### Command Palette (`Ctrl+K`)

Access any command from any workspace. The palette shows:
- Recent commands (top section)
- Workspace-relevant commands
- Global commands (file, view, edit)

### Fullscreen Modes

- **Fullscreen Canvas** (`F`): Hides all panels, shows only the central canvas
- **Distraction-Free** (`Shift+F`): Hides title bar, toolbars, and status bar

### Project Management

- Auto-save with dirty indicator
- Undo/Redo history
- Project name in title bar

### Python Backend

The Python backend powers:
- SAM-based smart selection
- OpenCV contour/circle detection
- Magic Wand extraction with multiple modes
- Batch auto-detection
- Animation frame generation
- Export pipeline

Status shown in the status bar (green dot = connected, amber = connecting, red = offline).
