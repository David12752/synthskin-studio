import { create } from 'zustand'
import { useProjectStore } from './projectStore'
import { nextZ, bringForward as zBringForward, sendBackward as zSendBackward } from '../lib/compose/transform'
import { type Adjustments, normalizeAdjustments } from '../lib/compose/adjustments'

/**
 * compositionStore — placed/imported parts arranged on the panel (Phase 3).
 *
 * A placed element is a tray part (or any image) positioned on the panel with a
 * transform + stacking order. Every element is `provenance:'user'` + `source:
 * 'placed'`, so re-analysis never clobbers it (mergeLayoutControls preserves
 * user-owned) and export includes it.
 */
export interface PlacedElement {
  id: string
  name: string
  dataUrl: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  z: number
  type: string
  partId?: string
  /** Non-destructive recolor/tone (Phase 4). Undefined = untouched original. */
  adjustments?: Adjustments
  provenance: 'user'
  source: 'placed'
}

export interface PlaceInput {
  name: string
  dataUrl: string
  x: number
  y: number
  width: number
  height: number
  partId?: string
  type?: string
  id?: string
}

interface CompositionState {
  elements: PlacedElement[]
  selectedId: string | null
  place: (input: PlaceInput) => PlacedElement
  update: (id: string, patch: Partial<Omit<PlacedElement, 'id'>>) => void
  /** Merge a partial adjustment patch into an element's adjustments (Phase 4). */
  adjust: (id: string, patch: Partial<Adjustments>) => void
  /** Clear an element's adjustments back to the untouched original. */
  resetAdjustments: (id: string) => void
  remove: (id: string) => void
  select: (id: string | null) => void
  bringForward: (id: string) => void
  sendBackward: (id: string) => void
  clear: () => void
}

let _seq = 0
const newId = () => `pl_${Date.now().toString(36)}_${(_seq++).toString(36)}`

export const useCompositionStore = create<CompositionState>((set, get) => ({
  elements: [],
  selectedId: null,

  place: (input) => {
    const el: PlacedElement = {
      id: input.id ?? newId(),
      name: input.name,
      dataUrl: input.dataUrl,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      rotation: 0,
      z: nextZ(get().elements),
      type: input.type ?? 'decoration',
      partId: input.partId,
      provenance: 'user',
      source: 'placed',
    }
    set((s) => ({ elements: [...s.elements, el], selectedId: el.id }))
    useProjectStore.getState().markDirty()
    return el
  },

  update: (id, patch) => {
    set((s) => ({ elements: s.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
    useProjectStore.getState().markDirty()
  },

  adjust: (id, patch) => {
    set((s) => ({
      elements: s.elements.map((e) =>
        e.id === id ? { ...e, adjustments: normalizeAdjustments({ ...e.adjustments, ...patch }) } : e,
      ),
    }))
    useProjectStore.getState().markDirty()
  },

  resetAdjustments: (id) => {
    set((s) => ({ elements: s.elements.map((e) => (e.id === id ? { ...e, adjustments: undefined } : e)) }))
    useProjectStore.getState().markDirty()
  },

  remove: (id) => {
    set((s) => ({
      elements: s.elements.filter((e) => e.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }))
    useProjectStore.getState().markDirty()
  },

  select: (id) => set({ selectedId: id }),

  bringForward: (id) => {
    set((s) => ({ elements: zBringForward(s.elements, id) }))
    useProjectStore.getState().markDirty()
  },

  sendBackward: (id) => {
    set((s) => ({ elements: zSendBackward(s.elements, id) }))
    useProjectStore.getState().markDirty()
  },

  clear: () => set({ elements: [], selectedId: null }),
}))
