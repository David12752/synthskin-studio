import { create } from 'zustand'

interface CanvasState {
  zoom: number
  panX: number
  panY: number
  cursorX: number
  cursorY: number
  activeTool: 'select' | 'circle' | 'rect' | 'sam' | 'wand' | 'hand' | 'zoom' | 'crop' | 'lasso' | 'polyLasso' | 'measure' | 'proExtract'
  /** True while an animated transition is in progress */
  isAnimating: boolean
  /** Background image for the Design workspace — set by the inpaint step after
   *  an element is confirmed in the Extract workspace so the panel appears
   *  empty where the extracted component used to be. */
  canvasBackground: string | null
  setZoom: (zoom: number) => void
  setPan: (x: number, y: number) => void
  setCursor: (x: number, y: number) => void
  setActiveTool: (tool: CanvasState['activeTool']) => void
  setCanvasBackground: (dataUrl: string | null) => void
  /** Smoothly animate to target zoom/pan over `durationMs` (default 300) */
  animateTo: (target: { zoom: number; panX: number; panY: number }, durationMs?: number) => void
  /** Cancel any running animation */
  cancelAnimation: () => void
}

let _animFrameId: number | null = null

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  zoom: 1,
  panX: 0,
  panY: 0,
  cursorX: 0,
  cursorY: 0,
  activeTool: 'select',
  isAnimating: false,
  canvasBackground: null,
  setZoom: (zoom) => set({ zoom }),
  setPan: (x, y) => set({ panX: x, panY: y }),
  setCursor: (x, y) => set({ cursorX: x, cursorY: y }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setCanvasBackground: (dataUrl) => set({ canvasBackground: dataUrl }),
  cancelAnimation: () => {
    if (_animFrameId !== null) {
      cancelAnimationFrame(_animFrameId)
      _animFrameId = null
    }
    set({ isAnimating: false })
  },
  animateTo: (target, durationMs = 300) => {
    // Cancel any existing animation
    if (_animFrameId !== null) {
      cancelAnimationFrame(_animFrameId)
      _animFrameId = null
    }

    const start = {
      zoom: get().zoom,
      panX: get().panX,
      panY: get().panY,
    }
    const startTime = performance.now()
    set({ isAnimating: true })

    const step = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / durationMs, 1)
      const t = easeOutCubic(progress)

      const z = start.zoom + (target.zoom - start.zoom) * t
      const px = start.panX + (target.panX - start.panX) * t
      const py = start.panY + (target.panY - start.panY) * t

      set({ zoom: z, panX: px, panY: py })

      if (progress < 1) {
        _animFrameId = requestAnimationFrame(step)
      } else {
        _animFrameId = null
        set({ isAnimating: false })
      }
    }

    _animFrameId = requestAnimationFrame(step)
  },
}))
