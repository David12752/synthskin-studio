/**
 * Semantic Panel Layout Store — holds the hierarchical result from the
 * Florence-2 → SAM2 → RapidOCR pipeline.
 *
 * Extended with multi-select, clipboard, undo/redo, and alignment helpers.
 */
import { create } from 'zustand'
import type { PanelLayoutResult, PanelControl, PanelLabel, PanelDedupGroup, ControlState } from '../lib/api/pythonClient'
import { mergeLayoutControls } from '../lib/panel/mergeLayout'

export type PanelControlType = PanelControl['type']
export type Bbox = [number, number, number, number]

// ─── Undo / Redo ────────────────────────────────────────────────────────
interface Snapshot {
  controls: PanelControl[]
  labels: PanelLabel[]
}

const MAX_UNDO = 40

interface PanelLayoutState {
  layout: PanelLayoutResult | null
  selectedControlIds: Set<string>        // multi-select (replaces selectedControlId)
  selectedLabelId: string | null
  selectedSectionId: string | null
  showMasks: boolean
  showLabels: boolean
  showBoxes: boolean
  editMode: boolean
  highlightedControlId: string | null
  dirtyControlIds: Set<string>

  // Clipboard (stored as bbox-relative controls)
  clipboard: PanelControl[]

  // Undo / Redo stacks (snapshots of controls+labels)
  undoStack: Snapshot[]
  redoStack: Snapshot[]

  setLayout: (layout: PanelLayoutResult | null) => void
  /** Merge a fresh analysis in WITHOUT clobbering user-corrected controls.
   *  Returns how many incoming controls were dropped / user controls preserved. */
  mergeLayout: (incoming: PanelLayoutResult) => { dropped: number; preserved: number }
  /** @deprecated Use selectControls / toggleSelectControl instead */
  selectControl: (id: string | null) => void
  selectControls: (ids: string[]) => void
  toggleSelectControl: (id: string) => void
  selectAllControls: () => void
  selectLabel: (id: string | null) => void
  selectSection: (id: string | null) => void
  setShowMasks: (v: boolean) => void
  setShowLabels: (v: boolean) => void
  setShowBoxes: (v: boolean) => void
  setEditMode: (v: boolean) => void
  setHighlightedControl: (id: string | null) => void
  renameControl: (id: string, displayName: string) => void
  reassignLabel: (labelId: string, controlId: string | null) => void

  // ─── Manual bbox editing ─────────────────────────────────────────────
  updateControlBbox: (id: string, bbox: Bbox) => void
  updateLabelBbox: (id: string, bbox: Bbox) => void
  changeControlType: (id: string, type: PanelControlType) => void
  /** Accept a control as correct: lock it as user-owned so re-analysis can't clobber it. */
  acceptControl: (id: string) => void
  addControl: (type: PanelControlType, bbox: Bbox) => string
  deleteControl: (id: string) => void
  deleteLabel: (id: string) => void
  /** Remove a set of duplicate controls in one undo-able step (output of panelDeduplicate). */
  applyDedup: (removedIds: string[]) => void

  // ─── Phase 4 — export enrichment ─────────────────────────────────────────
  /** Groups from the last panelDeduplicate call; carried through to export. */
  dedupGroups: PanelDedupGroup[]
  /** Per-control detected states from the last panelDetectStates call. */
  detectedStates: Record<string, ControlState>
  setDedupGroups: (groups: PanelDedupGroup[]) => void
  setDetectedStates: (states: Record<string, ControlState>) => void

  // ─── Multi-select bulk operations ────────────────────────────────────
  deleteSelected: () => void
  duplicateSelected: (offsetX?: number, offsetY?: number) => void
  nudgeSelected: (dx: number, dy: number) => void
  copySelected: () => void
  paste: (offsetX?: number, offsetY?: number) => void
  changeSelectedType: (type: PanelControlType) => void

  // ─── Alignment ───────────────────────────────────────────────────────
  alignSelected: (edge: 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV') => void
  distributeSelected: (axis: 'horizontal' | 'vertical') => void

  // ─── Bulk actions ────────────────────────────────────────────────────────
  /** Accept all AI controls at or above the given confidence threshold (default 0.85).
   *  Returns the count of controls newly accepted. */
  acceptAllHighConfidence: (threshold?: number) => number
  /** Rename controls using a pattern string, optionally filtered to one type.
   *  Tokens: {type} = control type, {n} = 1-based index, {n:02} = zero-padded. */
  batchRenameControls: (pattern: string, filterType?: string) => void

  // ─── Undo / Redo ─────────────────────────────────────────────────────
  pushUndo: () => void
  undo: () => void
  redo: () => void

  clear: () => void
}

function clampBbox(bbox: Bbox, maxW: number, maxH: number): Bbox {
  let [x1, y1, x2, y2] = bbox
  if (x2 < x1) [x1, x2] = [x2, x1]
  if (y2 < y1) [y1, y2] = [y2, y1]
  x1 = Math.max(0, Math.min(maxW - 1, x1))
  y1 = Math.max(0, Math.min(maxH - 1, y1))
  x2 = Math.max(x1 + 1, Math.min(maxW, x2))
  y2 = Math.max(y1 + 1, Math.min(maxH, y2))
  return [x1, y1, x2, y2]
}

function bboxGeom(bbox: Bbox) {
  const w = bbox[2] - bbox[0]
  const h = bbox[3] - bbox[1]
  return {
    width: w,
    height: h,
    center: [bbox[0] + w / 2, bbox[1] + h / 2] as [number, number],
  }
}

export const usePanelLayoutStore = create<PanelLayoutState>((set, get) => ({
  layout: null,
  selectedControlIds: new Set<string>(),
  selectedLabelId: null,
  selectedSectionId: null,
  showMasks: true,
  showLabels: true,
  showBoxes: true,
  editMode: false,
  highlightedControlId: null,
  dirtyControlIds: new Set<string>(),
  clipboard: [],
  undoStack: [],
  redoStack: [],
  dedupGroups: [],
  detectedStates: {},

  setLayout: (layout) => set({
    layout,
    selectedControlIds: new Set<string>(),
    selectedLabelId: null,
    selectedSectionId: null,
    dirtyControlIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    dedupGroups: [],
    detectedStates: {},
  }),

  mergeLayout: (incoming) => {
    const state = get()
    if (!state.layout) {
      set({ layout: incoming, dirtyControlIds: new Set<string>() })
      return { dropped: 0, preserved: 0 }
    }
    // Anything the user touched (dirty) or already flagged 'user' is protected.
    const protectedExisting: PanelControl[] = state.layout.controls
      .filter((c) => c.provenance === 'user' || state.dirtyControlIds.has(c.id))
      .map((c) => ({ ...c, provenance: 'user' as const }))
    const { controls, dropped, preserved } = mergeLayoutControls(protectedExisting, incoming.controls)
    // Keep dirty flags for surviving user controls so a further re-run still protects them.
    const survivingUser = new Set(protectedExisting.map((c) => c.id))
    const dirtyControlIds = new Set([...state.dirtyControlIds].filter((id) => survivingUser.has(id)))
    set({
      layout: { ...incoming, controls, controlCount: controls.length },
      dirtyControlIds,
      selectedControlIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
    })
    return { dropped, preserved }
  },

  // Backward-compat: single select
  selectControl: (id) => set({
    selectedControlIds: id ? new Set([id]) : new Set<string>(),
    selectedLabelId: null,
  }),

  selectControls: (ids) => set({
    selectedControlIds: new Set(ids),
    selectedLabelId: null,
  }),

  toggleSelectControl: (id) => set((state) => {
    const next = new Set(state.selectedControlIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { selectedControlIds: next, selectedLabelId: null }
  }),

  selectAllControls: () => set((state) => {
    if (!state.layout) return state
    return {
      selectedControlIds: new Set(state.layout.controls.map((c) => c.id)),
      selectedLabelId: null,
    }
  }),

  selectLabel: (id) => set((state) => {
    if (id === null) return { selectedLabelId: null, selectedControlIds: new Set<string>() }
    const label = state.layout?.labels.find((l) => l.id === id)
    return {
      selectedLabelId: id,
      selectedControlIds: label?.linked_control_id ? new Set([label.linked_control_id]) : new Set<string>(),
    }
  }),
  selectSection: (id) => set({ selectedSectionId: id }),
  setShowMasks: (v) => set({ showMasks: v }),
  setShowLabels: (v) => set({ showLabels: v }),
  setShowBoxes: (v) => set({ showBoxes: v }),
  setEditMode: (v) => set({ editMode: v }),
  setHighlightedControl: (id) => set({ highlightedControlId: id }),

  renameControl: (id, displayName) => set((state) => {
    if (!state.layout) return state
    const controls: PanelControl[] = state.layout.controls.map((c) =>
      c.id === id
        ? { ...c, display_name: displayName, parameter_id: slugify(displayName) }
        : c,
    )
    return { layout: { ...state.layout, controls } }
  }),

  reassignLabel: (labelId, controlId) => set((state) => {
    if (!state.layout) return state
    const labels: PanelLabel[] = state.layout.labels.map((l) =>
      l.id === labelId ? { ...l, linked_control_id: controlId ?? undefined } : l,
    )
    const targetLabel = state.layout.labels.find((l) => l.id === labelId)
    const controls: PanelControl[] = state.layout.controls.map((c) => {
      if (c.label?.id === labelId && c.id !== controlId) {
        return { ...c, label: null }
      }
      if (c.id === controlId && targetLabel) {
        return {
          ...c,
          label: { id: targetLabel.id, text: targetLabel.text, confidence: targetLabel.confidence },
          display_name: targetLabel.text,
          parameter_id: slugify(targetLabel.text),
        }
      }
      return c
    })
    return { layout: { ...state.layout, controls, labels } }
  }),

  updateControlBbox: (id, bbox) => set((state) => {
    if (!state.layout) return state
    const clamped = clampBbox(bbox, state.layout.imageWidth, state.layout.imageHeight)
    const geom = bboxGeom(clamped)
    const controls: PanelControl[] = state.layout.controls.map((c) =>
      c.id === id
        ? {
            ...c,
            bbox: clamped,
            refined_bbox: clamped,
            width: geom.width,
            height: geom.height,
            center: geom.center,
            mask_png: null,
            mask_bbox: null,
            circle: undefined,
            provenance: 'user' as const,
          }
        : c,
    )
    const dirtyControlIds = new Set(state.dirtyControlIds)
    dirtyControlIds.add(id)
    return { layout: { ...state.layout, controls }, dirtyControlIds }
  }),

  updateLabelBbox: (id, bbox) => set((state) => {
    if (!state.layout) return state
    const clamped = clampBbox(bbox, state.layout.imageWidth, state.layout.imageHeight)
    const geom = bboxGeom(clamped)
    const labels: PanelLabel[] = state.layout.labels.map((l) =>
      l.id === id ? { ...l, bbox: clamped, center: geom.center } : l,
    )
    return { layout: { ...state.layout, labels } }
  }),

  changeControlType: (id, type) => set((state) => {
    if (!state.layout) return state
    const controls: PanelControl[] = state.layout.controls.map((c) =>
      c.id === id ? { ...c, type, sub_type: type, provenance: 'user' as const } : c,
    )
    const dirtyControlIds = new Set(state.dirtyControlIds)
    dirtyControlIds.add(id)
    return { layout: { ...state.layout, controls }, dirtyControlIds }
  }),

  acceptControl: (id) => set((state) => {
    if (!state.layout) return state
    const controls: PanelControl[] = state.layout.controls.map((c) =>
      c.id === id ? { ...c, provenance: 'user' as const } : c,
    )
    const dirtyControlIds = new Set(state.dirtyControlIds)
    dirtyControlIds.add(id)
    return { layout: { ...state.layout, controls }, dirtyControlIds }
  }),

  addControl: (type, bbox) => {
    const newId = `manual_${Math.random().toString(36).slice(2, 10)}`
    set((state) => {
      if (!state.layout) return state
      const clamped = clampBbox(bbox, state.layout.imageWidth, state.layout.imageHeight)
      const geom = bboxGeom(clamped)
      const parameter_id = `${type}_${newId}`
      const newControl: PanelControl = {
        id: newId,
        type,
        sub_type: type,
        bbox: clamped,
        refined_bbox: clamped,
        width: geom.width,
        height: geom.height,
        center: geom.center,
        confidence: 1.0,
        source: 'manual',
        phrase: null,
        mask_png: null,
        mask_bbox: null,
        parameter_id,
        display_name: parameter_id.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
        label: null,
        provenance: 'user',
      }
      const controls = [...state.layout.controls, newControl]
      const dirtyControlIds = new Set(state.dirtyControlIds)
      dirtyControlIds.add(newId)
      return {
        layout: { ...state.layout, controls, controlCount: controls.length },
        dirtyControlIds,
        selectedControlIds: new Set([newId]),
      }
    })
    return newId
  },

  deleteControl: (id) => set((state) => {
    if (!state.layout) return state
    const controls = state.layout.controls.filter((c) => c.id !== id)
    const labels: PanelLabel[] = state.layout.labels.map((l) =>
      l.linked_control_id === id ? { ...l, linked_control_id: undefined } : l,
    )
    const dirtyControlIds = new Set(state.dirtyControlIds)
    dirtyControlIds.delete(id)
    const selectedControlIds = new Set(state.selectedControlIds)
    selectedControlIds.delete(id)
    return {
      layout: { ...state.layout, controls, labels, controlCount: controls.length },
      selectedControlIds,
      dirtyControlIds,
    }
  }),

  deleteLabel: (id) => set((state) => {
    if (!state.layout) return state
    const labels = state.layout.labels.filter((l) => l.id !== id)
    const controls: PanelControl[] = state.layout.controls.map((c) =>
      c.label?.id === id ? { ...c, label: null } : c,
    )
    return {
      layout: { ...state.layout, controls, labels, labelCount: labels.length },
      selectedLabelId: state.selectedLabelId === id ? null : state.selectedLabelId,
    }
  }),

  setDedupGroups: (groups) => set({ dedupGroups: groups }),
  setDetectedStates: (states) => set({ detectedStates: states }),

  applyDedup: (removedIds) => {
    const state = get()
    if (!state.layout || removedIds.length === 0) return
    state.pushUndo()
    const removeSet = new Set(removedIds)
    const controls = state.layout.controls.filter((c) => !removeSet.has(c.id))
    const labels: PanelLabel[] = state.layout.labels.map((l) =>
      l.linked_control_id && removeSet.has(l.linked_control_id)
        ? { ...l, linked_control_id: undefined }
        : l,
    )
    const dirtyControlIds = new Set(state.dirtyControlIds)
    removedIds.forEach((id) => dirtyControlIds.delete(id))
    const selectedControlIds = new Set(state.selectedControlIds)
    removedIds.forEach((id) => selectedControlIds.delete(id))
    set({
      layout: { ...state.layout, controls, labels, controlCount: controls.length },
      selectedControlIds,
      dirtyControlIds,
    })
  },

  // ─── Multi-select bulk operations ──────────────────────────────────

  deleteSelected: () => {
    const state = get()
    if (!state.layout || state.selectedControlIds.size === 0) return
    state.pushUndo()
    const ids = state.selectedControlIds
    const controls = state.layout.controls.filter((c) => !ids.has(c.id))
    const labels: PanelLabel[] = state.layout.labels.map((l) =>
      l.linked_control_id && ids.has(l.linked_control_id)
        ? { ...l, linked_control_id: undefined }
        : l,
    )
    const dirtyControlIds = new Set(state.dirtyControlIds)
    ids.forEach((id) => dirtyControlIds.delete(id))
    set({
      layout: { ...state.layout, controls, labels, controlCount: controls.length },
      selectedControlIds: new Set<string>(),
      dirtyControlIds,
    })
  },

  duplicateSelected: (offsetX = 16, offsetY = 16) => {
    const state = get()
    if (!state.layout || state.selectedControlIds.size === 0) return
    state.pushUndo()
    const ids = state.selectedControlIds
    const newIds: string[] = []
    const newControls: PanelControl[] = []
    state.layout.controls.forEach((c) => {
      if (!ids.has(c.id)) return
      const newId = `manual_${Math.random().toString(36).slice(2, 10)}`
      const bb = (c.refined_bbox ?? c.bbox) as Bbox
      const newBbox = clampBbox(
        [bb[0] + offsetX, bb[1] + offsetY, bb[2] + offsetX, bb[3] + offsetY],
        state.layout!.imageWidth,
        state.layout!.imageHeight,
      )
      const geom = bboxGeom(newBbox)
      newControls.push({
        ...c,
        id: newId,
        bbox: newBbox,
        refined_bbox: newBbox,
        width: geom.width,
        height: geom.height,
        center: geom.center,
        confidence: 1.0,
        source: 'manual',
        mask_png: null,
        mask_bbox: null,
        circle: undefined,
        parameter_id: `${c.type}_${newId}`,
        display_name: `${c.display_name} copy`,
      })
      newIds.push(newId)
    })
    const controls = [...state.layout.controls, ...newControls]
    const dirtyControlIds = new Set(state.dirtyControlIds)
    newIds.forEach((id) => dirtyControlIds.add(id))
    set({
      layout: { ...state.layout, controls, controlCount: controls.length },
      selectedControlIds: new Set(newIds),
      dirtyControlIds,
    })
  },

  nudgeSelected: (dx, dy) => {
    const state = get()
    if (!state.layout || state.selectedControlIds.size === 0) return
    const ids = state.selectedControlIds
    const controls: PanelControl[] = state.layout.controls.map((c) => {
      if (!ids.has(c.id)) return c
      const bb = (c.refined_bbox ?? c.bbox) as Bbox
      const newBbox = clampBbox(
        [bb[0] + dx, bb[1] + dy, bb[2] + dx, bb[3] + dy],
        state.layout!.imageWidth,
        state.layout!.imageHeight,
      )
      const geom = bboxGeom(newBbox)
      return { ...c, bbox: newBbox, refined_bbox: newBbox, width: geom.width, height: geom.height, center: geom.center, mask_png: null, mask_bbox: null, circle: undefined }
    })
    const dirtyControlIds = new Set(state.dirtyControlIds)
    ids.forEach((id) => dirtyControlIds.add(id))
    set({ layout: { ...state.layout, controls }, dirtyControlIds })
  },

  copySelected: () => {
    const state = get()
    if (!state.layout || state.selectedControlIds.size === 0) return
    const clipboard = state.layout.controls.filter((c) => state.selectedControlIds.has(c.id))
    set({ clipboard })
  },

  paste: (offsetX = 24, offsetY = 24) => {
    const state = get()
    if (!state.layout || state.clipboard.length === 0) return
    state.pushUndo()
    const newIds: string[] = []
    const newControls: PanelControl[] = state.clipboard.map((c) => {
      const newId = `manual_${Math.random().toString(36).slice(2, 10)}`
      const bb = (c.refined_bbox ?? c.bbox) as Bbox
      const newBbox = clampBbox(
        [bb[0] + offsetX, bb[1] + offsetY, bb[2] + offsetX, bb[3] + offsetY],
        state.layout!.imageWidth,
        state.layout!.imageHeight,
      )
      const geom = bboxGeom(newBbox)
      newIds.push(newId)
      return {
        ...c,
        id: newId,
        bbox: newBbox,
        refined_bbox: newBbox,
        width: geom.width,
        height: geom.height,
        center: geom.center,
        confidence: 1.0,
        source: 'manual' as const,
        mask_png: null,
        mask_bbox: null,
        circle: undefined,
        parameter_id: `${c.type}_${newId}`,
        display_name: `${c.display_name} copy`,
      }
    })
    const controls = [...state.layout.controls, ...newControls]
    const dirtyControlIds = new Set(state.dirtyControlIds)
    newIds.forEach((id) => dirtyControlIds.add(id))
    set({
      layout: { ...state.layout, controls, controlCount: controls.length },
      selectedControlIds: new Set(newIds),
      dirtyControlIds,
    })
  },

  changeSelectedType: (type) => {
    const state = get()
    if (!state.layout || state.selectedControlIds.size === 0) return
    state.pushUndo()
    const ids = state.selectedControlIds
    const controls: PanelControl[] = state.layout.controls.map((c) =>
      ids.has(c.id) ? { ...c, type, sub_type: type } : c,
    )
    const dirtyControlIds = new Set(state.dirtyControlIds)
    ids.forEach((id) => dirtyControlIds.add(id))
    set({ layout: { ...state.layout, controls }, dirtyControlIds })
  },

  // ─── Alignment ─────────────────────────────────────────────────────

  alignSelected: (edge) => {
    const state = get()
    if (!state.layout || state.selectedControlIds.size < 2) return
    state.pushUndo()
    const ids = state.selectedControlIds
    const selected = state.layout.controls.filter((c) => ids.has(c.id))
    const bboxes = selected.map((c) => (c.refined_bbox ?? c.bbox) as Bbox)

    let anchor: number
    switch (edge) {
      case 'left':    anchor = Math.min(...bboxes.map((b) => b[0])); break
      case 'right':   anchor = Math.max(...bboxes.map((b) => b[2])); break
      case 'top':     anchor = Math.min(...bboxes.map((b) => b[1])); break
      case 'bottom':  anchor = Math.max(...bboxes.map((b) => b[3])); break
      case 'centerH': anchor = bboxes.reduce((s, b) => s + (b[0] + b[2]) / 2, 0) / bboxes.length; break
      case 'centerV': anchor = bboxes.reduce((s, b) => s + (b[1] + b[3]) / 2, 0) / bboxes.length; break
    }

    const controls: PanelControl[] = state.layout.controls.map((c) => {
      if (!ids.has(c.id)) return c
      const bb = (c.refined_bbox ?? c.bbox) as Bbox
      const w = bb[2] - bb[0], h = bb[3] - bb[1]
      let newBbox: Bbox
      switch (edge) {
        case 'left':    newBbox = [anchor, bb[1], anchor + w, bb[3]]; break
        case 'right':   newBbox = [anchor - w, bb[1], anchor, bb[3]]; break
        case 'top':     newBbox = [bb[0], anchor, bb[2], anchor + h]; break
        case 'bottom':  newBbox = [bb[0], anchor - h, bb[2], anchor]; break
        case 'centerH': newBbox = [anchor - w / 2, bb[1], anchor + w / 2, bb[3]]; break
        case 'centerV': newBbox = [bb[0], anchor - h / 2, bb[2], anchor + h / 2]; break
      }
      const clamped = clampBbox(newBbox, state.layout!.imageWidth, state.layout!.imageHeight)
      const geom = bboxGeom(clamped)
      return { ...c, bbox: clamped, refined_bbox: clamped, width: geom.width, height: geom.height, center: geom.center, mask_png: null, mask_bbox: null, circle: undefined }
    })
    const dirtyControlIds = new Set(state.dirtyControlIds)
    ids.forEach((id) => dirtyControlIds.add(id))
    set({ layout: { ...state.layout, controls }, dirtyControlIds })
  },

  distributeSelected: (axis) => {
    const state = get()
    if (!state.layout || state.selectedControlIds.size < 3) return
    state.pushUndo()
    const ids = state.selectedControlIds
    const selected = state.layout.controls.filter((c) => ids.has(c.id))
    const bboxes = selected.map((c) => ({ id: c.id, bb: (c.refined_bbox ?? c.bbox) as Bbox }))

    if (axis === 'horizontal') {
      bboxes.sort((a, b) => a.bb[0] - b.bb[0])
      const minX = bboxes[0].bb[0]
      const maxEnd = bboxes[bboxes.length - 1].bb[2]
      const totalW = bboxes.reduce((s, b) => s + (b.bb[2] - b.bb[0]), 0)
      const gap = (maxEnd - minX - totalW) / (bboxes.length - 1)
      let x = minX
      const posMap = new Map<string, number>()
      bboxes.forEach((b) => {
        posMap.set(b.id, x)
        x += (b.bb[2] - b.bb[0]) + gap
      })

      const controls: PanelControl[] = state.layout.controls.map((c) => {
        if (!ids.has(c.id)) return c
        const bb = (c.refined_bbox ?? c.bbox) as Bbox
        const w = bb[2] - bb[0]
        const nx = posMap.get(c.id) ?? bb[0]
        const newBbox = clampBbox([nx, bb[1], nx + w, bb[3]], state.layout!.imageWidth, state.layout!.imageHeight)
        const geom = bboxGeom(newBbox)
        return { ...c, bbox: newBbox, refined_bbox: newBbox, width: geom.width, height: geom.height, center: geom.center, mask_png: null, mask_bbox: null, circle: undefined }
      })
      const dirtyControlIds = new Set(state.dirtyControlIds)
      ids.forEach((id) => dirtyControlIds.add(id))
      set({ layout: { ...state.layout, controls }, dirtyControlIds })
    } else {
      bboxes.sort((a, b) => a.bb[1] - b.bb[1])
      const minY = bboxes[0].bb[1]
      const maxEnd = bboxes[bboxes.length - 1].bb[3]
      const totalH = bboxes.reduce((s, b) => s + (b.bb[3] - b.bb[1]), 0)
      const gap = (maxEnd - minY - totalH) / (bboxes.length - 1)
      let y = minY
      const posMap = new Map<string, number>()
      bboxes.forEach((b) => {
        posMap.set(b.id, y)
        y += (b.bb[3] - b.bb[1]) + gap
      })

      const controls: PanelControl[] = state.layout.controls.map((c) => {
        if (!ids.has(c.id)) return c
        const bb = (c.refined_bbox ?? c.bbox) as Bbox
        const h = bb[3] - bb[1]
        const ny = posMap.get(c.id) ?? bb[1]
        const newBbox = clampBbox([bb[0], ny, bb[2], ny + h], state.layout!.imageWidth, state.layout!.imageHeight)
        const geom = bboxGeom(newBbox)
        return { ...c, bbox: newBbox, refined_bbox: newBbox, width: geom.width, height: geom.height, center: geom.center, mask_png: null, mask_bbox: null, circle: undefined }
      })
      const dirtyControlIds = new Set(state.dirtyControlIds)
      ids.forEach((id) => dirtyControlIds.add(id))
      set({ layout: { ...state.layout, controls }, dirtyControlIds })
    }
  },

  // ─── Bulk actions ──────────────────────────────────────────────────

  acceptAllHighConfidence: (threshold = 0.85) => {
    const state = get()
    if (!state.layout) return 0
    let count = 0
    const controls: PanelControl[] = state.layout.controls.map((c) => {
      if (c.provenance === 'user') return c
      if ((c.confidence ?? 0) >= threshold) { count++; return { ...c, provenance: 'user' as const } }
      return c
    })
    if (count === 0) return 0
    const dirtyControlIds = new Set(state.dirtyControlIds)
    state.layout.controls.forEach((orig, i) => {
      if (controls[i].provenance !== orig.provenance) dirtyControlIds.add(orig.id)
    })
    set({ layout: { ...state.layout, controls }, dirtyControlIds })
    return count
  },

  batchRenameControls: (pattern: string, filterType?: string) => {
    const state = get()
    if (!state.layout) return
    // Count per-type for sequential numbering within each type group.
    const typeCounters: Record<string, number> = {}
    const controls: PanelControl[] = state.layout.controls.map((c) => {
      if (filterType && c.type !== filterType) return c
      const idx = (typeCounters[c.type] = (typeCounters[c.type] ?? 0) + 1)
      const display_name = pattern
        .replace(/\{type\}/g, c.type)
        .replace(/\{n:(\d+)\}/g, (_, pad) => String(idx).padStart(parseInt(pad, 10), '0'))
        .replace(/\{n\}/g, String(idx))
      const parameter_id = slugify(display_name)
      return { ...c, display_name, parameter_id }
    })
    set({ layout: { ...state.layout, controls } })
  },

  // ─── Undo / Redo ───────────────────────────────────────────────────

  pushUndo: () => set((state) => {
    if (!state.layout) return state
    const snap: Snapshot = {
      controls: state.layout.controls.map((c) => ({ ...c })),
      labels: state.layout.labels.map((l) => ({ ...l })),
    }
    const undoStack = [...state.undoStack.slice(-(MAX_UNDO - 1)), snap]
    return { undoStack, redoStack: [] }
  }),

  undo: () => set((state) => {
    if (!state.layout || state.undoStack.length === 0) return state
    const currentSnap: Snapshot = {
      controls: state.layout.controls.map((c) => ({ ...c })),
      labels: state.layout.labels.map((l) => ({ ...l })),
    }
    const undoStack = [...state.undoStack]
    const snap = undoStack.pop()!
    const redoStack = [...state.redoStack, currentSnap]
    return {
      layout: { ...state.layout, controls: snap.controls, labels: snap.labels, controlCount: snap.controls.length, labelCount: snap.labels.length },
      undoStack,
      redoStack,
      selectedControlIds: new Set<string>(),
    }
  }),

  redo: () => set((state) => {
    if (!state.layout || state.redoStack.length === 0) return state
    const currentSnap: Snapshot = {
      controls: state.layout.controls.map((c) => ({ ...c })),
      labels: state.layout.labels.map((l) => ({ ...l })),
    }
    const redoStack = [...state.redoStack]
    const snap = redoStack.pop()!
    const undoStack = [...state.undoStack, currentSnap]
    return {
      layout: { ...state.layout, controls: snap.controls, labels: snap.labels, controlCount: snap.controls.length, labelCount: snap.labels.length },
      undoStack,
      redoStack,
      selectedControlIds: new Set<string>(),
    }
  }),

  clear: () => set({
    layout: null,
    selectedControlIds: new Set<string>(),
    selectedLabelId: null,
    selectedSectionId: null,
    dirtyControlIds: new Set<string>(),
    clipboard: [],
    undoStack: [],
    redoStack: [],
    dedupGroups: [],
    detectedStates: {},
  }),
}))

function slugify(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) return 'param'
  return (/^\d/.test(s) ? 'p_' + s : s).slice(0, 48)
}
