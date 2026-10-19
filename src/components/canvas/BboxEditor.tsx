/**
 * BboxEditor — interactive editing layer for PanelOverlay.
 *
 * Supports multi-select: renders 8 resize handles around the primary
 * (first-selected) bbox, handles body-drag to move all selected,
 * and exposes a tiny toolbar for type change / delete / resegment.
 * Works in IMAGE-native coordinates; the parent passes scaleX/scaleY so we
 * can render in display space while writing back in native space.
 *
 * Keyboard while editMode is active:
 *   ← → ↑ ↓               : nudge 1px (all selected)
 *   Shift + arrow           : nudge 10px
 *   Delete / Backspace      : delete selected controls
 *   Ctrl+D / ⌘+D            : duplicate selected (offset +16,+16)
 *   Ctrl+C / ⌘+C            : copy selected to clipboard
 *   Ctrl+V / ⌘+V            : paste from clipboard
 *   Ctrl+A / ⌘+A            : select all controls
 *   Ctrl+Z / ⌘+Z            : undo
 *   Ctrl+Shift+Z / Ctrl+Y   : redo
 *   Esc                      : deselect all
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePanelLayoutStore, type Bbox, type PanelControlType } from '../../stores/panelLayoutStore'
import type { PanelControl } from '../../lib/api/pythonClient'
import { PANEL_CONTROL_TYPES } from './panelTrainingTypes'

type Handle =
  | 'nw' | 'n' | 'ne'
  | 'w'       | 'e'
  | 'sw' | 's' | 'se'
  | 'body'

const HANDLE_POSITIONS: { h: Handle; x: 0 | 0.5 | 1; y: 0 | 0.5 | 1; cursor: string }[] = [
  { h: 'nw', x: 0,   y: 0,   cursor: 'nwse-resize' },
  { h: 'n',  x: 0.5, y: 0,   cursor: 'ns-resize' },
  { h: 'ne', x: 1,   y: 0,   cursor: 'nesw-resize' },
  { h: 'w',  x: 0,   y: 0.5, cursor: 'ew-resize' },
  { h: 'e',  x: 1,   y: 0.5, cursor: 'ew-resize' },
  { h: 'sw', x: 0,   y: 1,   cursor: 'nesw-resize' },
  { h: 's',  x: 0.5, y: 1,   cursor: 'ns-resize' },
  { h: 'se', x: 1,   y: 1,   cursor: 'nwse-resize' },
]

const CONTROL_TYPES: PanelControlType[] = PANEL_CONTROL_TYPES

interface BboxEditorProps {
  scaleX: number
  scaleY: number
  displayW: number
  displayH: number
  /** Called when the user requests SAM2 re-segmentation of the edited bbox */
  onResegment?: (controlId: string, bbox: Bbox) => void
}

export default function BboxEditor({ scaleX, scaleY, displayW, displayH, onResegment }: BboxEditorProps) {
  const layout              = usePanelLayoutStore((s) => s.layout)
  const editMode            = usePanelLayoutStore((s) => s.editMode)
  const selectedControlIds  = usePanelLayoutStore((s) => s.selectedControlIds)
  const updateControlBbox   = usePanelLayoutStore((s) => s.updateControlBbox)
  const deleteSelected      = usePanelLayoutStore((s) => s.deleteSelected)
  const duplicateSelected   = usePanelLayoutStore((s) => s.duplicateSelected)
  const nudgeSelected       = usePanelLayoutStore((s) => s.nudgeSelected)
  const copySelected        = usePanelLayoutStore((s) => s.copySelected)
  const paste               = usePanelLayoutStore((s) => s.paste)
  const selectAllControls   = usePanelLayoutStore((s) => s.selectAllControls)
  const selectControl       = usePanelLayoutStore((s) => s.selectControl)
  const changeControlType   = usePanelLayoutStore((s) => s.changeControlType)
  const changeSelectedType  = usePanelLayoutStore((s) => s.changeSelectedType)
  const pushUndo            = usePanelLayoutStore((s) => s.pushUndo)
  const undo                = usePanelLayoutStore((s) => s.undo)
  const redo                = usePanelLayoutStore((s) => s.redo)

  const selectedControls = layout?.controls.filter((c) => selectedControlIds.has(c.id)) ?? []
  // Primary control = first selected (for resize handles & toolbar)
  const primary = selectedControls.length > 0 ? selectedControls[0] : null

  // Local drag state kept in a ref so mousemove doesn't re-render the whole tree.
  const dragRef = useRef<{
    handle: Handle
    startX: number
    startY: number
    orig: Bbox
  } | null>(null)

  const [liveBbox, setLiveBbox] = useState<Bbox | null>(null)

  const commit = useCallback((next: Bbox) => {
    if (!primary) return
    updateControlBbox(primary.id, next)
  }, [primary, updateControlBbox])

  const onHandleMouseDown = useCallback((h: Handle, e: React.MouseEvent) => {
    if (!primary || !layout) return
    e.stopPropagation()
    e.preventDefault()
    const bb = (primary.refined_bbox ?? primary.bbox) as Bbox

    // Push undo before drag starts
    pushUndo()

    if (h === 'body' && selectedControls.length > 1) {
      // Multi-drag: move all selected controls
      const origMap = new Map<string, Bbox>()
      selectedControls.forEach((c) => {
        origMap.set(c.id, [...(c.refined_bbox ?? c.bbox)] as Bbox)
      })
      const startX = e.clientX, startY = e.clientY
      const onMove = (ev: MouseEvent) => {
        const dxNative = (ev.clientX - startX) / scaleX
        const dyNative = (ev.clientY - startY) / scaleY
        selectedControls.forEach((c) => {
          const orig = origMap.get(c.id)!
          updateControlBbox(c.id, [
            Math.round(orig[0] + dxNative), Math.round(orig[1] + dyNative),
            Math.round(orig[2] + dxNative), Math.round(orig[3] + dyNative),
          ])
        })
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }

    dragRef.current = {
      handle: h,
      startX: e.clientX,
      startY: e.clientY,
      orig: [...bb] as Bbox,
    }
    setLiveBbox(bb)
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const dxNative = (ev.clientX - d.startX) / scaleX
      const dyNative = (ev.clientY - d.startY) / scaleY
      const [x1, y1, x2, y2] = d.orig
      let nx1 = x1, ny1 = y1, nx2 = x2, ny2 = y2
      switch (d.handle) {
        case 'body':
          nx1 = x1 + dxNative; ny1 = y1 + dyNative
          nx2 = x2 + dxNative; ny2 = y2 + dyNative
          break
        case 'n':  ny1 = y1 + dyNative; break
        case 's':  ny2 = y2 + dyNative; break
        case 'w':  nx1 = x1 + dxNative; break
        case 'e':  nx2 = x2 + dxNative; break
        case 'nw': nx1 = x1 + dxNative; ny1 = y1 + dyNative; break
        case 'ne': nx2 = x2 + dxNative; ny1 = y1 + dyNative; break
        case 'sw': nx1 = x1 + dxNative; ny2 = y2 + dyNative; break
        case 'se': nx2 = x2 + dxNative; ny2 = y2 + dyNative; break
      }
      const next: Bbox = [Math.round(nx1), Math.round(ny1), Math.round(nx2), Math.round(ny2)]
      setLiveBbox(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const final = dragRef.current && liveBboxRef.current
        ? liveBboxRef.current
        : null
      dragRef.current = null
      if (final) commit(final)
      setLiveBbox(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [primary, selectedControls, layout, scaleX, scaleY, commit, pushUndo, updateControlBbox])

  // Stash liveBbox in a ref so the mouseup closure can read the latest value.
  const liveBboxRef = useRef<Bbox | null>(null)
  useEffect(() => { liveBboxRef.current = liveBbox }, [liveBbox])

  // ── Global keyboard shortcuts (active whenever editMode is on) ──────
  useEffect(() => {
    if (!editMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      const ctrl = e.ctrlKey || e.metaKey
      const hasSelection = selectedControlIds.size > 0

      // Ctrl+A — select all
      if (ctrl && e.key === 'a') {
        e.preventDefault(); selectAllControls(); return
      }
      // Ctrl+Z — undo
      if (ctrl && !e.shiftKey && e.key === 'z') {
        e.preventDefault(); undo(); return
      }
      // Ctrl+Shift+Z or Ctrl+Y — redo
      if ((ctrl && e.shiftKey && e.key === 'Z') || (ctrl && e.key === 'y')) {
        e.preventDefault(); redo(); return
      }

      if (!hasSelection) return

      // Ctrl+D — duplicate
      if (ctrl && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault(); pushUndo(); duplicateSelected(); return
      }
      // Ctrl+C — copy
      if (ctrl && (e.key === 'c' || e.key === 'C') && !e.shiftKey) {
        e.preventDefault(); copySelected(); return
      }
      // Ctrl+V — paste
      if (ctrl && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault(); paste(); return
      }

      const step = e.shiftKey ? 10 : 1
      // Arrow nudge (all selected)
      if (e.key === 'ArrowLeft')  { e.preventDefault(); nudgeSelected(-step, 0); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(step, 0); return }
      if (e.key === 'ArrowUp')    { e.preventDefault(); nudgeSelected(0, -step); return }
      if (e.key === 'ArrowDown')  { e.preventDefault(); nudgeSelected(0, step); return }

      // Delete / Backspace — delete selected
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); deleteSelected(); return
      }
      // D without ctrl — duplicate (legacy shortcut)
      if (!ctrl && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault(); pushUndo(); duplicateSelected(); return
      }
      // Escape — deselect
      if (e.key === 'Escape') {
        e.preventDefault(); selectControl(null); return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editMode, selectedControlIds, selectAllControls, undo, redo, pushUndo, duplicateSelected, copySelected, paste, nudgeSelected, deleteSelected, selectControl])

  if (!editMode || !layout || !primary) return null

  const bb = (liveBbox ?? primary.refined_bbox ?? primary.bbox) as Bbox
  const x = bb[0] * scaleX
  const y = bb[1] * scaleY
  const w = (bb[2] - bb[0]) * scaleX
  const h = (bb[3] - bb[1]) * scaleY
  const HS = 8 // handle size (display px)

  return (
    <>
      {/* SVG layer for rect + handles (primary control only gets resize handles) */}
      <svg
        className="absolute inset-0"
        style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
        viewBox={`0 0 ${displayW} ${displayH}`}
        preserveAspectRatio="none"
      >
        {/* Multi-selection outlines (secondary selected) */}
        {selectedControls.filter((c) => c.id !== primary.id).map((c) => {
          const cbb = (c.refined_bbox ?? c.bbox) as Bbox
          return (
            <rect
              key={`ms_${c.id}`}
              x={cbb[0] * scaleX} y={cbb[1] * scaleY}
              width={(cbb[2] - cbb[0]) * scaleX}
              height={(cbb[3] - cbb[1]) * scaleY}
              fill="rgba(96, 165, 250, 0.06)"
              stroke="#60a5fa"
              strokeWidth={1.3}
              strokeDasharray="3 2"
              style={{ pointerEvents: 'all', cursor: 'move' }}
              onMouseDown={(e) => onHandleMouseDown('body', e)}
            />
          )
        })}

        {/* Primary bounding rect */}
        <rect
          x={x} y={y} width={w} height={h}
          fill="rgba(245, 158, 11, 0.08)"
          stroke="#f59e0b"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          style={{ pointerEvents: 'all', cursor: 'move' }}
          onMouseDown={(e) => onHandleMouseDown('body', e)}
        />
        {/* handles */}
        {HANDLE_POSITIONS.map(({ h: hid, x: fx, y: fy, cursor }) => {
          const hx = x + w * fx
          const hy = y + h * fy
          return (
            <rect
              key={hid}
              x={hx - HS / 2}
              y={hy - HS / 2}
              width={HS}
              height={HS}
              fill="#fff"
              stroke="#f59e0b"
              strokeWidth={1.5}
              style={{ pointerEvents: 'all', cursor }}
              onMouseDown={(e) => onHandleMouseDown(hid, e)}
            />
          )
        })}
      </svg>

      {/* Floating toolbar above the bbox */}
      <BboxToolbar
        control={primary}
        selectedCount={selectedControls.length}
        x={x}
        y={y}
        width={w}
        displayW={displayW}
        onChangeType={(t) => selectedControls.length > 1 ? changeSelectedType(t) : changeControlType(primary.id, t)}
        onDelete={deleteSelected}
        onResegment={onResegment && selectedControls.length === 1 ? () => onResegment(primary.id, bb) : undefined}
        onDuplicate={() => { pushUndo(); duplicateSelected() }}
      />
    </>
  )
}

function BboxToolbar({
  control, selectedCount, x, y, width, displayW, onChangeType, onDelete, onResegment, onDuplicate,
}: {
  control: PanelControl
  selectedCount: number
  x: number
  y: number
  width: number
  displayW: number
  onChangeType: (t: PanelControlType) => void
  onDelete: () => void
  onResegment?: () => void
  onDuplicate: () => void
}) {
  const desiredLeft = x
  const width_est = 320
  const left = Math.max(4, Math.min(displayW - width_est - 4, desiredLeft))
  const top = Math.max(4, y - 34)
  void width
  return (
    <div
      className="absolute flex items-center gap-1 rounded-md bg-black/85 border border-white/15 px-1.5 py-1 shadow-lg backdrop-blur-sm"
      style={{ left, top, pointerEvents: 'all', zIndex: 10 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {selectedCount > 1 && (
        <span className="text-[9px] font-mono text-blue-300 px-1">{selectedCount}×</span>
      )}
      <select
        value={control.type}
        onChange={(e) => onChangeType(e.target.value as PanelControlType)}
        className="bg-white/10 border border-white/10 rounded text-[10px] text-white px-1 py-0.5 outline-none focus:border-amber-400"
      >
        {CONTROL_TYPES.map((t) => (
          <option key={t} value={t} className="bg-neutral-900">{t}</option>
        ))}
      </select>
      <button
        onClick={onDuplicate}
        title="Duplicate (Ctrl+D)"
        className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 border border-blue-400/40 text-blue-200 hover:bg-blue-500/30"
      >
        ⎘
      </button>
      {onResegment && (
        <button
          onClick={onResegment}
          title="Re-run SAM2 segmentation on the edited bbox"
          className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-400/40 text-purple-200 hover:bg-purple-500/30"
        >
          Re-segment
        </button>
      )}
      <button
        onClick={onDelete}
        title="Delete (Del)"
        className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 border border-red-400/40 text-red-200 hover:bg-red-500/30"
      >
        ✕
      </button>
      <span className="text-[9px] font-mono text-white/40 pl-1">
        {Math.round(control.bbox[2] - control.bbox[0])}×{Math.round(control.bbox[3] - control.bbox[1])}
      </span>
    </div>
  )
}
