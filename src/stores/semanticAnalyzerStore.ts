/**
 * Shared state for the Semantic Panel Analyzer.
 * Split between the canvas component (SemanticLayoutAnalyzer — renders image + overlays)
 * and the inspector component (AnalyzerInspector — renders controls + tree).
 */
import { create } from 'zustand'
import type { PanelPipelineCapabilities } from '../lib/api/pythonClient'

interface SemanticAnalyzerState {
  // ── Config (Inspector writes, canvas reads) ──────────────────────────────
  minConfidence: number
  detectLabels: boolean
  useStream: boolean
  fastMode: boolean
  detectionModel: string

  // ── Status (canvas writes, Inspector reads) ──────────────────────────────
  loading: boolean
  error: string | null
  capabilities: PanelPipelineCapabilities | null
  florenceResetting: boolean
  pythonRestarting: boolean
  pythonRestartMsg: string | null

  // ── Progress (canvas writes, Inspector reads) ────────────────────────────
  progressStage: string
  progressPct: number
  progressMsg: string
  elapsed: number

  // ── Canvas view state ────────────────────────────────────────────────────
  zoom: number
  pan: { x: number; y: number }
  imgSize: { w: number; h: number }

  // ── Trigger flags (Inspector writes, canvas reads) ───────────────────────
  /** Incrementing this triggers analysis in the canvas component. */
  analyzeRequestId: number
  cancelRequested: boolean

  // ── Setters ──────────────────────────────────────────────────────────────
  setMinConfidence(v: number): void
  setDetectLabels(v: boolean): void
  setUseStream(v: boolean): void
  setFastMode(v: boolean): void
  setDetectionModel(v: string): void

  setLoading(v: boolean): void
  setError(v: string | null): void
  setCaps(v: PanelPipelineCapabilities | null): void
  setFlorenceResetting(v: boolean): void
  setPythonRestarting(v: boolean): void
  setPythonRestartMsg(v: string | null): void

  setProgress(stage: string, pct: number, msg: string): void
  setElapsed(v: number): void

  setZoom(v: number | ((prev: number) => number)): void
  setPan(v: { x: number; y: number }): void
  setImgSize(v: { w: number; h: number }): void
  resetView(): void

  requestAnalyze(): void
  requestCancel(): void
  clearCancel(): void
}

export const useSemanticAnalyzerStore = create<SemanticAnalyzerState>()((set) => ({
  minConfidence: 0.25,
  detectLabels: false,
  useStream: true,
  fastMode: true,
  detectionModel: 'auto',

  loading: false,
  error: null,
  capabilities: null,
  florenceResetting: false,
  pythonRestarting: false,
  pythonRestartMsg: null,

  progressStage: '',
  progressPct: 0,
  progressMsg: '',
  elapsed: 0,

  zoom: 1,
  pan: { x: 0, y: 0 },
  imgSize: { w: 0, h: 0 },

  analyzeRequestId: 0,
  cancelRequested: false,

  setMinConfidence: (v) => set({ minConfidence: v }),
  setDetectLabels:  (v) => set({ detectLabels: v }),
  setUseStream:     (v) => set({ useStream: v }),
  setFastMode:      (v) => set({ fastMode: v }),
  setDetectionModel:(v) => set({ detectionModel: v }),

  setLoading: (v) => set({ loading: v }),
  setError:   (v) => set({ error: v }),
  setCaps:    (v) => set({ capabilities: v }),
  setFlorenceResetting: (v) => set({ florenceResetting: v }),
  setPythonRestarting:  (v) => set({ pythonRestarting: v }),
  setPythonRestartMsg:  (v) => set({ pythonRestartMsg: v }),

  setProgress: (stage, pct, msg) => set({ progressStage: stage, progressPct: pct, progressMsg: msg }),
  setElapsed:  (v) => set({ elapsed: v }),

  setZoom: (v) => set((s) => ({ zoom: typeof v === 'function' ? v(s.zoom) : v })),
  setPan:  (v) => set({ pan: v }),
  setImgSize: (v) => set({ imgSize: v }),
  resetView: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),

  requestAnalyze: () => set((s) => ({ analyzeRequestId: s.analyzeRequestId + 1, cancelRequested: false })),
  requestCancel:  () => set({ cancelRequested: true }),
  clearCancel:    () => set({ cancelRequested: false }),
}))
