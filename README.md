# SynthSkin Studio

Professional UI asset extraction tool for audio plugin development (JUCE/VST/AU).

Turn AI-generated synth mockups into production-ready, animated UI components — knobs, sliders, meters, buttons, LEDs — with pixel-perfect precision.

## Quick Start

```bash
# Windows PowerShell
.\init.ps1

# macOS / Linux
chmod +x init.sh && ./init.sh

# Launch
npm run dev
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Electron 28 + React 18 + TypeScript 5 + Vite |
| UI | Radix UI + Tailwind CSS |
| Canvas | Konva.js |
| State | Zustand |
| AI Backend | Python sidecar (FastAPI + SAM2 + OpenCV) |

## Project Structure

```
synthskin-studio/
├── electron/          # Electron main process + Python bridge
├── python/            # FastAPI sidecar (AI/CV processing)
├── src/
│   ├── components/    # React UI components
│   ├── stores/        # Zustand state stores
│   ├── lib/           # Extraction, export, API client
│   └── types/         # TypeScript type definitions
├── .tmp/              # Intermediate processing files
└── progress.md        # Development progress tracker
```

## Development Phases

- [x] **Phase 0** — Project bootstrap
- [ ] **Phase 1** — Canvas & image import
- [ ] **Phase 2** — Extraction tools
- [ ] **Phase 3** — Knob animation generator
- [ ] **Phase 4** — Meter animation generator
- [ ] **Phase 5** — Export pipeline
- [ ] **Phase 6** — Project management
- [ ] **Phase 7** — Polish & pro features
