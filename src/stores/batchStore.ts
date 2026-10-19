import { create } from 'zustand'
import type { BatchDetection } from '../lib/api/pythonClient'

interface BatchDetectionState {
  isOpen: boolean
  isDetecting: boolean
  detections: BatchDetection[]
  selectedIds: Set<string>
  error: string | null

  openBatchDetect: () => void
  closeBatchDetect: () => void
  setDetecting: (v: boolean) => void
  setDetections: (d: BatchDetection[]) => void
  setError: (e: string | null) => void
  toggleSelection: (id: string) => void
  selectAll: () => void
  deselectAll: () => void
}

export const useBatchStore = create<BatchDetectionState>((set, get) => ({
  isOpen: false,
  isDetecting: false,
  detections: [],
  selectedIds: new Set<string>(),
  error: null,

  openBatchDetect: () => set({ isOpen: true, detections: [], selectedIds: new Set(), error: null }),
  closeBatchDetect: () => set({ isOpen: false, isDetecting: false }),
  setDetecting: (v) => set({ isDetecting: v }),
  setDetections: (d) => {
    const allIds = new Set(d.map((det) => det.id))
    set({ detections: d, selectedIds: allIds })
  },
  setError: (e) => set({ error: e }),

  toggleSelection: (id) => {
    const next = new Set(get().selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set({ selectedIds: next })
  },

  selectAll: () => {
    const allIds = new Set(get().detections.map((d) => d.id))
    set({ selectedIds: allIds })
  },

  deselectAll: () => set({ selectedIds: new Set() }),
}))
