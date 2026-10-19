import { create } from 'zustand'
import { useProjectStore } from './projectStore'

/**
 * partsTrayStore — the staging area for cut/imported parts (Phase 2).
 *
 * A "part" is a self-contained transparent PNG cut from the panel or an imported
 * image. It lives in the tray until the user places it on the compositing canvas
 * (Phase 3). Parts are `provenance:'user'` by construction, so once placed they
 * are never clobbered by a re-analyze.
 */
export interface TrayPart {
  id: string
  name: string
  /** Transparent RGBA PNG data-URL of the cut part. */
  dataUrl: string
  width: number
  height: number
  source: {
    kind: 'cut' | 'import'
    /** id of the image it was cut from (if any). */
    imageId?: string
    srcName?: string
    /** Bounds within the source image where it was cut (for reference). */
    bounds?: { x: number; y: number; width: number; height: number }
  }
  createdAt: string
}

interface PartsTrayState {
  parts: TrayPart[]
  selectedPartId: string | null
  addPart: (part: Omit<TrayPart, 'id' | 'createdAt'> & { id?: string }) => TrayPart
  removePart: (id: string) => void
  renamePart: (id: string, name: string) => void
  selectPart: (id: string | null) => void
  clear: () => void
}

let _seq = 0
const newId = () => `part_${Date.now().toString(36)}_${(_seq++).toString(36)}`

export const usePartsTrayStore = create<PartsTrayState>((set, get) => ({
  parts: [],
  selectedPartId: null,

  addPart: (part) => {
    const full: TrayPart = {
      id: part.id ?? newId(),
      name: part.name,
      dataUrl: part.dataUrl,
      width: part.width,
      height: part.height,
      source: part.source,
      createdAt: new Date().toISOString(),
    }
    set((s) => ({ parts: [...s.parts, full], selectedPartId: full.id }))
    useProjectStore.getState().markDirty()
    return full
  },

  removePart: (id) => {
    set((s) => ({
      parts: s.parts.filter((p) => p.id !== id),
      selectedPartId: s.selectedPartId === id ? null : s.selectedPartId,
    }))
    useProjectStore.getState().markDirty()
  },

  renamePart: (id, name) => {
    set((s) => ({ parts: s.parts.map((p) => (p.id === id ? { ...p, name } : p)) }))
    useProjectStore.getState().markDirty()
  },

  selectPart: (id) => set({ selectedPartId: id }),

  clear: () => set({ parts: [], selectedPartId: null }),
}))
