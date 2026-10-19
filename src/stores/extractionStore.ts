import { create } from 'zustand'

/** State for an in-progress circle draw */
export interface CircleDraw {
  cx: number
  cy: number
  radius: number
}

/** State for an in-progress rect draw */
export interface RectDraw {
  x: number
  y: number
  width: number
  height: number
  /** Original anchor point where the drag started (preserved while dragging) */
  startX: number
  startY: number
}

/** State for magic wand parameters */
export interface WandParams {
  tolerance: number
  feather: number
  expand: number
  contiguous: boolean
  mode: 'element' | 'invert' | 'color'
  edgeSensitivity: number
  refineEdges: boolean
}

/** State for pro extraction parameters */
export interface ProExtractParams {
  strategy: 'auto' | 'contour' | 'edge' | 'color' | 'grabcut' | 'invert'
  tolerance: number
  edgeSensitivity: number
  feather: number
  expand: number
  padding: number
  refineEdges: boolean
  quality: 'fast' | 'standard' | 'high'
  returnCandidates: boolean
}

/** State for an in-progress freehand lasso draw */
export interface LassoDraw {
  /** Ordered list of image-space points collected during the drag */
  points: { x: number; y: number }[]
  feather: number
  expand: number
}

/** State for an in-progress polygonal lasso (click → click → double-click to close) */
export interface PolyLassoDraw {
  points: { x: number; y: number }[]
  /** True once the shape is closed (double-click detected) */
  closed: boolean
  feather: number
  expand: number
}

/** SAM multi-point session: accumulate positive + negative clicks before commit */
export interface SAMMultiPoint {
  points: { x: number; y: number; label: 0 | 1 }[]
  /** null = not yet confirmed; filled after commit */
  pendingResult: string | null
}

/** Refine Edge parameters (post-extraction) */
export interface RefineEdgeParams {
  radius: number
  smooth: number
  feather: number
  contrast: number
  shiftEdge: number
}

/** Candidate produced by the commercial-safe detect step — YOLOv10 / SAM2-auto. */
export interface DetectedCandidate {
  srcUrl: string
  detectedType: 'knob' | 'slider' | 'button' | 'screen' | 'unknown' | string
  initialGeometry: { x: number; y: number; width: number; height: number }
  normalMapUrl?: string
  depthMapUrl?: string
  alphaMapUrl?: string
  confidence: number
}

/** Live progress emitted by /pipeline/extract-3d/stream. */
export interface Extraction3DProgress {
  stage: string
  percent: number
  message: string
}

interface ExtractionState {
  // Drawing state
  isDrawing: boolean
  circleDraw: CircleDraw | null
  rectDraw: RectDraw | null

  // Lasso / polygon lasso state
  lassoDraw: LassoDraw | null
  polyLassoDraw: PolyLassoDraw | null

  // SAM multi-point state
  samMultiPoint: SAMMultiPoint | null

  // Wand params
  wandParams: WandParams

  // Pro extraction params
  proParams: ProExtractParams

  // Refine edge params
  refineEdgeParams: RefineEdgeParams
  /** Asset id that is currently being refined (shows the Refine Edge panel) */
  refiningAssetId: string | null

  // Processing state
  isExtracting: boolean
  extractionError: string | null

  // Preview overlay (for showing extraction result before confirming)
  previewDataUrl: string | null

  // ─── Commercial-safe 3D extraction ───
  /** Candidates produced by the last YOLOv10 + SAM2 pass. Consumed by the
   *  Extract workspace tray so the user can accept / reject each one. */
  detectedCandidates: DetectedCandidate[]
  /** Currently selected candidate (the one that will be sent to Foundry). */
  selectedCandidateId: string | null
  /** Last-known SSE progress frame; null = idle. */
  extract3dProgress: Extraction3DProgress | null

  // Actions
  startCircleDraw: (cx: number, cy: number) => void
  updateCircleDraw: (radius: number) => void
  finishDraw: () => void
  cancelDraw: () => void

  startRectDraw: (x: number, y: number) => void
  updateRectDraw: (x2: number, y2: number) => void

  // Lasso actions
  startLassoDraw: () => void
  addLassoPoint: (x: number, y: number) => void
  finishLassoDraw: () => void

  // Polygonal lasso actions
  startPolyLasso: () => void
  addPolyPoint: (x: number, y: number, isSingleClick?: boolean) => void
  closePolyLasso: () => void
  cancelPolyLasso: () => void

  // SAM multi-point actions
  startSAMMultiPoint: () => void
  addSAMPoint: (x: number, y: number, label: 0 | 1) => void
  clearSAMPoints: () => void

  setWandParams: (p: Partial<WandParams>) => void
  setProParams: (p: Partial<ProExtractParams>) => void
  setRefineEdgeParams: (p: Partial<RefineEdgeParams>) => void
  setRefiningAssetId: (id: string | null) => void

  setExtracting: (v: boolean) => void
  setExtractionError: (e: string | null) => void
  setPreview: (dataUrl: string | null) => void

  setDetectedCandidates: (c: DetectedCandidate[]) => void
  selectCandidate: (id: string | null) => void
  setExtract3dProgress: (p: Extraction3DProgress | null) => void
  clearExtract3d: () => void
}

export const useExtractionStore = create<ExtractionState>((set) => ({
  isDrawing: false,
  circleDraw: null,
  rectDraw: null,
  lassoDraw: null,
  polyLassoDraw: null,
  samMultiPoint: null,

  wandParams: {
    tolerance: 32,
    feather: 0,
    expand: 0,
    contiguous: true,
    mode: 'element',
    edgeSensitivity: 1.0,
    refineEdges: true,
  },

  proParams: {
    strategy: 'auto',
    tolerance: 32,
    edgeSensitivity: 1.0,
    feather: 0,
    expand: 0,
    padding: 0,
    refineEdges: true,
    quality: 'standard',
    returnCandidates: true,
  },

  refineEdgeParams: {
    radius: 3,
    smooth: 0,
    feather: 0,
    contrast: 0,
    shiftEdge: 0,
  },
  refiningAssetId: null,

  isExtracting: false,
  extractionError: null,
  previewDataUrl: null,

  detectedCandidates: [],
  selectedCandidateId: null,
  extract3dProgress: null,

  startCircleDraw: (cx, cy) =>
    set({ isDrawing: true, circleDraw: { cx, cy, radius: 0 }, rectDraw: null, lassoDraw: null, polyLassoDraw: null }),

  updateCircleDraw: (radius) =>
    set((s) => s.circleDraw ? { circleDraw: { ...s.circleDraw, radius } } : {}),

  finishDraw: () => set({ isDrawing: false }),

  cancelDraw: () =>
    set({ isDrawing: false, circleDraw: null, rectDraw: null, lassoDraw: null, previewDataUrl: null }),

  startRectDraw: (x, y) =>
    set({ isDrawing: true, rectDraw: { x, y, width: 0, height: 0, startX: x, startY: y }, circleDraw: null, lassoDraw: null }),

  updateRectDraw: (x2, y2) =>
    set((s) => {
      if (!s.rectDraw) return {}
      const startX = s.rectDraw.startX
      const startY = s.rectDraw.startY
      return {
        rectDraw: {
          startX,
          startY,
          x: Math.min(startX, x2),
          y: Math.min(startY, y2),
          width: Math.abs(x2 - startX),
          height: Math.abs(y2 - startY),
        },
      }
    }),

  // Lasso (freehand)
  startLassoDraw: () =>
    set({ isDrawing: true, lassoDraw: { points: [], feather: 0, expand: 0 }, circleDraw: null, rectDraw: null }),

  addLassoPoint: (x, y) =>
    set((s) => {
      if (!s.lassoDraw) return {}
      const last = s.lassoDraw.points[s.lassoDraw.points.length - 1]
      // Skip points that are too close (< 2px apart) to reduce noise
      if (last && Math.abs(x - last.x) < 2 && Math.abs(y - last.y) < 2) return {}
      return { lassoDraw: { ...s.lassoDraw, points: [...s.lassoDraw.points, { x, y }] } }
    }),

  finishLassoDraw: () => set({ isDrawing: false }),

  // Polygonal Lasso (click-click-click-doubleclick)
  startPolyLasso: () =>
    set({ polyLassoDraw: { points: [], closed: false, feather: 0, expand: 0 } }),

  addPolyPoint: (x, y) =>
    set((s) => {
      if (!s.polyLassoDraw || s.polyLassoDraw.closed) return {}
      return { polyLassoDraw: { ...s.polyLassoDraw, points: [...s.polyLassoDraw.points, { x, y }] } }
    }),

  closePolyLasso: () =>
    set((s) => {
      if (!s.polyLassoDraw) return {}
      return { polyLassoDraw: { ...s.polyLassoDraw, closed: true } }
    }),

  cancelPolyLasso: () => set({ polyLassoDraw: null }),

  // SAM multi-point
  startSAMMultiPoint: () =>
    set({ samMultiPoint: { points: [], pendingResult: null } }),

  addSAMPoint: (x, y, label) =>
    set((s) => {
      if (!s.samMultiPoint) return {}
      return { samMultiPoint: { ...s.samMultiPoint, points: [...s.samMultiPoint.points, { x, y, label }] } }
    }),

  clearSAMPoints: () => set({ samMultiPoint: null }),

  setWandParams: (p) =>
    set((s) => ({ wandParams: { ...s.wandParams, ...p } })),

  setProParams: (p) =>
    set((s) => ({ proParams: { ...s.proParams, ...p } })),

  setRefineEdgeParams: (p) =>
    set((s) => ({ refineEdgeParams: { ...s.refineEdgeParams, ...p } })),

  setRefiningAssetId: (id) => set({ refiningAssetId: id }),

  setExtracting: (v) => set({ isExtracting: v }),
  setExtractionError: (e) => set({ extractionError: e }),
  setPreview: (dataUrl) => set({ previewDataUrl: dataUrl }),

  setDetectedCandidates: (c) => set({ detectedCandidates: c, selectedCandidateId: null }),
  selectCandidate: (id) => set({ selectedCandidateId: id }),
  setExtract3dProgress: (p) => set({ extract3dProgress: p }),
  clearExtract3d: () => set({
    detectedCandidates: [],
    selectedCandidateId: null,
    extract3dProgress: null,
  }),
}))
