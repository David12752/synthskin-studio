import { create } from 'zustand'
import { useAssetStore } from './assetStore'
import { useImageStore } from './imageStore'
import type { Asset } from '../types'

/**
 * Snapshot of the undoable project state.
 * We snapshot assets and source image id/path (not the full HTMLImageElement).
 */
interface Snapshot {
  assets: Asset[]
  sourceImageId: string | null
}

interface HistoryState {
  past: Snapshot[]
  future: Snapshot[]
  /** Push current state as a snapshot before a mutation */
  pushSnapshot: () => void
  undo: () => void
  redo: () => void
  clear: () => void
  canUndo: () => boolean
  canRedo: () => boolean
}

const MAX_HISTORY = 50

function captureSnapshot(): Snapshot {
  const assets = useAssetStore.getState().assets
  const img = useImageStore.getState().sourceImage
  return {
    assets: assets.map((a) => ({ ...a })),
    sourceImageId: img?.id ?? null,
  }
}

function restoreSnapshot(snapshot: Snapshot) {
  const assetStore = useAssetStore.getState()
  // Replace assets array entirely
  useAssetStore.setState({ assets: snapshot.assets.map((a) => ({ ...a })) })

  // We don't restore/unload images on undo since that would require
  // re-decoding; source image changes are not common undo targets.
  // If needed, this can be extended.
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],

  pushSnapshot: () => {
    const snapshot = captureSnapshot()
    set((s) => ({
      past: [...s.past.slice(-(MAX_HISTORY - 1)), snapshot],
      future: [], // new action clears redo stack
    }))
  },

  undo: () => {
    const { past } = get()
    if (past.length === 0) return

    const current = captureSnapshot()
    const previous = past[past.length - 1]

    restoreSnapshot(previous)

    set((s) => ({
      past: s.past.slice(0, -1),
      future: [current, ...s.future],
    }))
  },

  redo: () => {
    const { future } = get()
    if (future.length === 0) return

    const current = captureSnapshot()
    const next = future[0]

    restoreSnapshot(next)

    set((s) => ({
      past: [...s.past, current],
      future: s.future.slice(1),
    }))
  },

  clear: () => set({ past: [], future: [] }),

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}))
