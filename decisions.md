# Architectural Decisions

## ADR-019: Length-prefixed JSON over raw TCP for JUCE bridge
**Date:** 2026-04-10
**Decision:** JUCE bridge uses 4-byte big-endian length prefix + JSON body over raw TCP sockets. No HTTP, no WebSocket.
**Rationale:** Minimal overhead, simple to implement on both sides (Node.js net + JUCE StreamingSocket). The framing is trivial (4-byte header), JSON is human-readable for debugging, and the protocol is fast enough for <16ms update batches. HTTP would add unnecessary overhead, WebSocket adds complexity with no benefit for a localhost-only connection. 10MB frame size limit prevents malformed data from consuming memory.

## ADR-020: Bridge as header-only C++ module
**Date:** 2026-04-10
**Decision:** The synthskin-bridge JUCE module is a single header file (synthskin_bridge.h) with `#if SYNTHSKIN_BRIDGE_ENABLED` guards.
**Rationale:** Header-only means zero build configuration for users — just include the header. The `#if` guard ensures the entire bridge compiles to nothing in release builds. A stub class with the same API is provided when disabled, so user code doesn't need `#if` blocks. Localhost-only binding (127.0.0.1) ensures the bridge is never network-accessible.

## ADR-021: Electron main-process TCP client (not renderer)
**Date:** 2026-04-10
**Decision:** TCP socket operations live in the Electron main process (electron/juce-bridge.ts), exposed to the renderer via IPC handles.
**Rationale:** Node.js `net` module is only available in the main process with contextIsolation enabled. Moving TCP to main also keeps the renderer process clean and ensures socket cleanup on app quit. Messages are forwarded via webContents.send() for the renderer to process.

## ADR-016: regl over raw WebGL2 for Foundry rendering
**Date:** 2026-04-09
**Decision:** Use `regl` library for WebGL rendering in the Procedural Component Foundry.
**Rationale:** regl provides a clean functional API over WebGL without heavy abstraction overhead. It handles state management, buffer creation, and uniform binding elegantly. The alternative (raw WebGL2) would require significantly more boilerplate code for the same result. regl also has no external dependencies (12KB gzipped).

## ADR-017: Unified PBR shader over per-material shaders
**Date:** 2026-04-09
**Decision:** Use a single fragment shader with material-type uniforms instead of separate `.frag` files per material.
**Rationale:** The WorkPlane spec suggested separate shader files per material, but in practice the materials share 95% of the PBR pipeline (Cook-Torrance BRDF, lighting, normal generation). Material differences are limited to color computation and roughness variation. A unified shader avoids shader program switching, simplifies the renderer, and makes it trivial to add new materials as additional `if` branches. GPU branching on uniform values is well-optimized and has negligible performance impact for this use case.

## ADR-018: Foundry as full-screen overlay (z-50)
**Date:** 2026-04-09
**Decision:** The Component Foundry opens as a fixed full-screen overlay at z-index 50, above the main canvas but below modals.
**Rationale:** The Foundry is a separate workflow mode, not a panel within the extraction workspace. A full-screen overlay gives it dedicated space for the three-column layout (presets | preview | parameters) without interfering with the canvas state. The Back button returns to the main workspace. This matches how professional tools handle separate modes (e.g., Figma's prototype mode).

## ADR-001: vite-plugin-electron over electron-vite
**Date:** 2026-04-09
**Decision:** Use `vite-plugin-electron` + `vite-plugin-electron-renderer` instead of `electron-vite`.
**Rationale:** Lighter integration, works as a standard Vite plugin. `electron-vite` is more opinionated and restructures the project layout. We want standard Vite + minimal electron glue.

## ADR-002: Python sidecar over WASM
**Date:** 2026-04-09
**Decision:** Run SAM2, OpenCV, and image processing in a Python FastAPI sidecar spawned as a child process.
**Rationale:** SAM2 is Python-native. OpenCV Python bindings are mature. Porting to JS/WASM would sacrifice performance and model compatibility. Localhost HTTP IPC is simple and debuggable.

## ADR-003: Dynamic port allocation
**Date:** 2026-04-09
**Decision:** Python sidecar binds to a random free port; Electron discovers it via IPC.
**Rationale:** Avoids port conflicts if user runs multiple instances or other dev servers. The port is determined at startup and passed to renderer via preload bridge.

## ADR-004: Defer SAM2 + rembg installation
**Date:** 2026-04-09
**Decision:** requirements.txt includes FastAPI, OpenCV, Pillow, numpy. SAM2 and rembg are deferred to Phase 2.
**Rationale:** SAM2 requires PyTorch (~2GB) and model weights (~2.4GB). Installing them in Phase 0 would waste time. They're not needed until extraction tools are built.

## ADR-005: System fonts first, Google Fonts as progressive enhancement
**Date:** 2026-04-09
**Decision:** CSS loads Inter Tight and JetBrains Mono from Google Fonts with system font fallbacks.
**Rationale:** Desktop app will eventually bundle fonts locally. For Phase 0 dev, Google Fonts is fast. Fallbacks ensure the app is usable offline.

## ADR-006: react-konva v18 (not v19)
**Date:** 2026-04-09
**Decision:** Pin `react-konva@18` since our React is 18.x. Latest react-konva (v19+) requires React 19.
**Rationale:** Avoids peer dependency conflict. Upgrade to v19 when we upgrade React.

## ADR-007: CJS output for Electron (no "type": "module")
**Date:** 2026-04-09
**Decision:** Removed `"type": "module"` from package.json. Electron main/preload output as CJS.
**Rationale:** `__dirname` is not available in ESM. vite-plugin-electron outputs .js files that Node interprets based on package.json type field. CJS is simpler and avoids ESM path resolution issues in Electron's main process.

## ADR-008: Dual-mode image smoothing
**Date:** 2026-04-09
**Decision:** Use Konva `imageSmoothingEnabled=false` + CSS `image-rendering: pixelated` when zoom > 100%.
**Rationale:** Both layers needed for true nearest-neighbor rendering. Konva's prop controls canvas 2D context, CSS controls browser compositing. Combined approach ensures pixel-perfect display when zooming in for precision work.

## ADR-009: Custom undo/redo over zundo
**Date:** 2026-04-09
**Decision:** Implement a custom snapshot-based undo/redo store (`historyStore.ts`) instead of using the `zundo` library.
**Rationale:** The project requires undo across multiple Zustand stores (assets + images). A custom snapshot approach captures the "project state" holistically, is simpler to debug, and avoids adding a dependency. Snapshots capture assets array; image state changes are rare and not worth snapshotting.

## ADR-010: .synthskin file format — JSON with embedded data URLs
**Date:** 2026-04-09
**Decision:** Save projects as `.synthskin` files containing JSON with source images embedded as data URLs.
**Rationale:** Embedding images makes project files self-contained and portable. No external file references to break. Trade-off: larger file size, but typical projects have 1-2 source images (10-50MB max). For production, could add option to reference external files.

## ADR-011: Auto-save to userData, not project directory
**Date:** 2026-04-09
**Decision:** Auto-save recovery files go to Electron's `app.getPath('userData')` directory, not alongside the project file.
**Rationale:** The user may not have saved a project yet (Untitled). Writing to a guaranteed writable directory avoids permission issues. Recovery file is overwritten each cycle (2 min). Only one recovery file exists at a time.

## ADR-012: Cross-store dirty tracking via direct getState() calls
**Date:** 2026-04-09
**Decision:** `assetStore` and `imageStore` call `useProjectStore.getState().markDirty()` directly after mutations.
**Rationale:** Zustand stores can call each other's `getState()` inside actions without issues, even with circular imports, because the references are resolved lazily at call time. This is simpler than event emitters or middleware wrappers.

## ADR-013: Batch detection via OpenCV (not SAM2 everything mode)
**Date:** 2026-04-09
**Decision:** Batch component detection uses HoughCircles + contour analysis, not SAM2 everything mode.
**Rationale:** SAM2 everything mode requires large model weights and GPU. OpenCV circle detection + contour analysis provides sufficient accuracy for detecting knobs, sliders, and buttons in plugin GUI screenshots, runs instantly on CPU, and requires no additional dependencies.

## ADR-014: Color variants via HSV manipulation
**Date:** 2026-04-09
**Decision:** Color variants shift hue/saturation/brightness in HSV color space using OpenCV.
**Rationale:** HSV manipulation preserves luminance structure while changing color, ideal for creating skin color variants. More predictable than LUT-based approaches and requires no external assets.

## ADR-015: Templates stored in userData JSON file
**Date:** 2026-04-09
**Decision:** Asset templates are persisted as a flat JSON array in `{userData}/synthskin-templates.json`.
**Rationale:** Templates are small metadata-only records (no images). A single JSON file is simpler than SQLite and doesn't require additional dependencies. Templates persist across projects.
