/**
 * PunchEditorCanvas — Konva-based interactive punch-region editor.
 *
 * Shows the panel image with coloured overlays for every detected control:
 *   green  = accepted (will be punched)
 *   yellow = high-confidence AI (needs explicit accept)
 *   red    = low-confidence / likely false-positive
 *
 * Tools:
 *   Select — click rect to select → drag to move, handles to resize
 *   Draw   — drag on canvas to add a new region (type selectable in toolbar)
 *
 * Keyboard: Del / Backspace to delete, Ctrl+Z / Ctrl+Y for undo / redo.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Stage, Layer, Image as KonvaImage, Rect as KonvaRect, Transformer } from 'react-konva'
import type Konva from 'konva'
import { usePanelLayoutStore, type PanelControlType } from '../../stores/panelLayoutStore'
import { useImageStore } from '../../stores/imageStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { PanelControl } from '../../lib/api/pythonClient'

// ─── Colour helpers ───────────────────────────────────────────────────────────

function fillColor(c: PanelControl, punch: boolean): string {
  if (punch) return 'rgba(0,0,0,0.82)'
  if (c.provenance === 'user') return 'rgba(34,197,94,0.22)'
  if ((c.confidence ?? 0) >= 0.85) return 'rgba(234,179,8,0.22)'
  return 'rgba(239,68,68,0.18)'
}

function strokeColor(c: PanelControl, selected: boolean): string {
  if (selected) return '#f59e0b'
  if (c.provenance === 'user') return 'rgba(34,197,94,0.8)'
  if ((c.confidence ?? 0) >= 0.85) return 'rgba(234,179,8,0.75)'
  return 'rgba(239,68,68,0.65)'
}

// ─── Add-type options ─────────────────────────────────────────────────────────

const ADD_TYPES: PanelControlType[] = [
  'knob', 'slider', 'slider_cap', 'button', 'switch', 'led', 'screen', 'meter', 'label',
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function PunchEditorCanvas() {
  // Store access
  const layout        = usePanelLayoutStore((s) => s.layout)
  const selectedIds   = usePanelLayoutStore((s) => s.selectedControlIds)
  const selectControl = usePanelLayoutStore((s) => s.selectControl)
  const updateBbox    = usePanelLayoutStore((s) => s.updateControlBbox)
  const deleteControl = usePanelLayoutStore((s) => s.deleteControl)
  const addControl    = usePanelLayoutStore((s) => s.addControl)
  const pushUndo      = usePanelLayoutStore((s) => s.pushUndo)
  const undo          = usePanelLayoutStore((s) => s.undo)
  const redo          = usePanelLayoutStore((s) => s.redo)
  const closePunchEdit = useWorkspaceStore((s) => s.closePunchEdit)
  const sourceImage   = useImageStore((s) => s.sourceImage)

  // Konva refs
  const stageRef   = useRef<Konva.Stage>(null)
  const layerRef   = useRef<Konva.Layer>(null)
  const trRef      = useRef<Konva.Transformer>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Image
  const [konvaImg, setKonvaImg] = useState<HTMLImageElement | null>(null)
  const [stageW, setStageW]     = useState(800)
  const [stageH, setStageH]     = useState(600)

  // Tool state
  const [tool, setTool]         = useState<'select' | 'draw'>('select')
  const [punchMode, setPunch]   = useState(false)
  const [addType, setAddType]   = useState<PanelControlType>('knob')
  const [typeMenu, setTypeMenu] = useState(false)

  // Drawing
  const [drawing, setDrawing]     = useState(false)
  const drawOrigin = useRef({ x: 0, y: 0 })
  const [pendingRect, setPending] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null
  const controls   = layout?.controls ?? []

  // ─── Load HTMLImageElement ──────────────────────────────────────────────────

  useEffect(() => {
    if (!sourceImage?.dataUrl) return
    const img = new window.Image()
    img.onload = () => setKonvaImg(img)
    img.src = sourceImage.dataUrl
  }, [sourceImage?.dataUrl])

  // ─── Observe container dimensions ──────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => { setStageW(el.clientWidth); setStageH(el.clientHeight) }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [])

  // ─── Scale + offset (contain-fit the panel image) ──────────────────────────

  const { sc, ox, oy } = useMemo(() => {
    const iw = sourceImage?.width  ?? 1
    const ih = sourceImage?.height ?? 1
    const sc = Math.min(stageW / iw, stageH / ih, 1)
    return { sc, ox: (stageW - iw * sc) / 2, oy: (stageH - ih * sc) / 2 }
  }, [stageW, stageH, sourceImage?.width, sourceImage?.height])

  /** bbox [x1,y1,x2,y2] in image px → canvas px */
  const toCanvas = useCallback((bbox: [number, number, number, number]) => ({
    x: bbox[0] * sc + ox,
    y: bbox[1] * sc + oy,
    w: (bbox[2] - bbox[0]) * sc,
    h: (bbox[3] - bbox[1]) * sc,
  }), [sc, ox, oy])

  /** canvas pos → image px */
  const toImg = useCallback((cx: number, cy: number) => ({
    x: (cx - ox) / sc,
    y: (cy - oy) / sc,
  }), [sc, ox, oy])

  // ─── Attach Transformer to selected node ────────────────────────────────────

  useEffect(() => {
    const tr = trRef.current
    const la = layerRef.current
    if (!tr || !la) return
    if (!selectedId) {
      tr.nodes([])
      tr.getLayer()?.batchDraw()
      return
    }
    const node = la.findOne('#' + selectedId)
    if (node) { tr.nodes([node]); tr.getLayer()?.batchDraw() }
  }, [selectedId, controls.length]) // re-attach after add/delete too

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) { pushUndo(); deleteControl(selectedId) }
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo() }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, deleteControl, pushUndo, undo, redo])

  // ─── Stage pointer helpers ──────────────────────────────────────────────────

  const stagePointer = () => stageRef.current?.getPointerPosition() ?? null

  // ─── Stage events ───────────────────────────────────────────────────────────

  const onStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    // Only act on clicks that land on the stage or the bg-image (not on control rects)
    const targetName = e.target.getClassName?.() === 'Stage' ? '__stage__' : e.target.name()
    if (targetName !== '__stage__' && targetName !== 'bg-image') return

    selectControl(null)

    if (tool === 'draw') {
      const pos = stagePointer()
      if (!pos) return
      drawOrigin.current = { x: pos.x, y: pos.y }
      setDrawing(true)
      setPending({ x: pos.x, y: pos.y, w: 0, h: 0 })
    }
  }, [tool, selectControl])

  const onStageMouseMove = useCallback(() => {
    if (!drawing) return
    const pos = stagePointer()
    if (!pos) return
    const { x: ox, y: oy } = drawOrigin.current
    setPending({
      x: Math.min(ox, pos.x),
      y: Math.min(oy, pos.y),
      w: Math.abs(pos.x - ox),
      h: Math.abs(pos.y - oy),
    })
  }, [drawing])

  const onStageMouseUp = useCallback(() => {
    if (!drawing) return
    setDrawing(false)
    if (!pendingRect || pendingRect.w < 8 || pendingRect.h < 8) { setPending(null); return }
    const p1 = toImg(pendingRect.x, pendingRect.y)
    const p2 = toImg(pendingRect.x + pendingRect.w, pendingRect.y + pendingRect.h)
    pushUndo()
    addControl(addType, [p1.x, p1.y, p2.x, p2.y])
    setPending(null)
  }, [drawing, pendingRect, toImg, pushUndo, addControl, addType])

  // ─── Rect events ────────────────────────────────────────────────────────────

  const onRectClick = useCallback((id: string) => {
    if (tool === 'select') selectControl(id)
  }, [tool, selectControl])

  const onDragStart = useCallback(() => pushUndo(), [pushUndo])

  const onDragEnd = useCallback((c: PanelControl, e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target
    const nx1 = (node.x() - ox) / sc
    const ny1 = (node.y() - oy) / sc
    const w   = c.bbox[2] - c.bbox[0]
    const h   = c.bbox[3] - c.bbox[1]
    updateBbox(c.id, [nx1, ny1, nx1 + w, ny1 + h])
    // Snap node back to integer-rounded position (prevents drift)
    node.position({ x: nx1 * sc + ox, y: ny1 * sc + oy })
  }, [sc, ox, oy, updateBbox])

  // ─── Transformer events ─────────────────────────────────────────────────────

  const onTransformStart = useCallback(() => pushUndo(), [pushUndo])

  const onTransformEnd = useCallback(() => {
    const nodes = trRef.current?.nodes() ?? []
    for (const node of nodes) {
      const c = controls.find(ctrl => ctrl.id === node.id())
      if (!c) continue
      const scX = node.scaleX()
      const scY = node.scaleY()
      node.scaleX(1)
      node.scaleY(1)
      const newW = Math.max(8, node.width()  * scX)
      const newH = Math.max(8, node.height() * scY)
      node.width(newW)
      node.height(newH)
      const nx1 = (node.x() - ox) / sc
      const ny1 = (node.y() - oy) / sc
      const nx2 = nx1 + newW / sc
      const ny2 = ny1 + newH / sc
      updateBbox(c.id, [nx1, ny1, nx2, ny2])
    }
  }, [controls, sc, ox, oy, updateBbox])

  // ─── Derived ────────────────────────────────────────────────────────────────

  const selectedCtrl  = controls.find(c => c.id === selectedId)
  const acceptedCount = controls.filter(c => c.provenance === 'user').length

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-surface-0 overflow-hidden">

      {/* ── Toolbar ── */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-surface-4 bg-surface-1/90 backdrop-blur-sm">

        {/* Tool toggle */}
        <div className="flex rounded-lg overflow-hidden border border-surface-4 text-[10px]">
          {(['select', 'draw'] as const).map(t => (
            <button key={t} onClick={() => setTool(t)}
              className={`px-3 py-1.5 font-medium transition-colors ${
                tool === t ? 'bg-accent/15 text-accent' : 'text-muted hover:text-neutral-200'
              }`}
            >
              {t === 'select' ? '↖ Select' : '⬜ Draw'}
            </button>
          ))}
        </div>

        {/* Draw type picker */}
        {tool === 'draw' && (
          <div className="relative">
            <button onClick={() => setTypeMenu(v => !v)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-2 border border-surface-4 text-[10px] text-neutral-300 hover:bg-surface-3 transition-colors"
            >
              {addType} <span className="opacity-50">▾</span>
            </button>
            {typeMenu && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-surface-2 border border-surface-4 rounded-lg shadow-2xl overflow-hidden min-w-[100px]">
                {ADD_TYPES.map(t => (
                  <button key={t} onClick={() => { setAddType(t); setTypeMenu(false) }}
                    className={`block w-full text-left px-3 py-1.5 text-[10px] hover:bg-surface-3 transition-colors ${
                      addType === t ? 'text-accent' : 'text-neutral-300'
                    }`}
                  >{t}</button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="h-4 w-px bg-surface-4 mx-0.5" />

        <button onClick={undo} title="Undo (Ctrl+Z)"
          className="px-2 py-1 text-[10px] text-muted hover:text-neutral-200 transition-colors">↩ Undo</button>
        <button onClick={redo} title="Redo (Ctrl+Y)"
          className="px-2 py-1 text-[10px] text-muted hover:text-neutral-200 transition-colors">↪ Redo</button>

        <div className="h-4 w-px bg-surface-4 mx-0.5" />

        <button onClick={() => setPunch(v => !v)}
          className={`px-2.5 py-1 text-[10px] rounded-lg transition-colors ${
            punchMode ? 'bg-black/50 text-white border border-white/15' : 'text-muted hover:text-neutral-200'
          }`}
        >
          {punchMode ? '■ Punch preview' : '□ Preview punch'}
        </button>

        <div className="flex-1" />

        {/* Selected control info */}
        {selectedCtrl && (
          <span className="text-[9px] text-muted font-mono truncate max-w-[200px] shrink-0">
            {selectedCtrl.display_name} · {selectedCtrl.type}
          </span>
        )}

        <button
          onClick={() => { if (selectedId) { pushUndo(); deleteControl(selectedId) } }}
          disabled={!selectedId}
          className="px-2 py-1 text-[10px] text-red-400 hover:text-red-300 disabled:opacity-20 transition-colors"
          title="Delete selected (Del)"
        >⌫ Delete</button>

        <button onClick={closePunchEdit}
          className="px-4 py-1.5 rounded-lg bg-accent text-black font-bold text-[11px] hover:bg-amber-400 transition-colors shrink-0"
        >
          Done →
        </button>
      </div>

      {/* ── Legend ── */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-1 bg-surface-1/40 border-b border-surface-4/40 text-[9px] text-muted">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 inline-block rounded-sm border" style={{ background: 'rgba(34,197,94,0.3)', borderColor: 'rgba(34,197,94,0.8)' }} />
          Accepted ({acceptedCount})
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 inline-block rounded-sm border" style={{ background: 'rgba(234,179,8,0.3)', borderColor: 'rgba(234,179,8,0.8)' }} />
          Review
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 inline-block rounded-sm border" style={{ background: 'rgba(239,68,68,0.25)', borderColor: 'rgba(239,68,68,0.7)' }} />
          Low confidence
        </span>
        <span className="ml-auto">Del to delete · drag to move · handles to resize</span>
      </div>

      {/* ── Konva canvas ── */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        style={{ cursor: tool === 'draw' ? 'crosshair' : 'default' }}
      >
        <Stage
          ref={stageRef}
          width={stageW}
          height={stageH}
          onMouseDown={onStageMouseDown}
          onMouseMove={onStageMouseMove}
          onMouseUp={onStageMouseUp}
        >
          <Layer ref={layerRef}>

            {/* Panel image */}
            {konvaImg && (
              <KonvaImage
                image={konvaImg}
                x={ox}
                y={oy}
                width={(sourceImage?.width ?? 1) * sc}
                height={(sourceImage?.height ?? 1) * sc}
                name="bg-image"
              />
            )}

            {/* Control overlays */}
            {controls.map(c => {
              const { x, y, w, h } = toCanvas(c.bbox)
              const isSel = c.id === selectedId
              return (
                <KonvaRect
                  key={c.id}
                  id={c.id}
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  fill={fillColor(c, punchMode)}
                  stroke={strokeColor(c, isSel)}
                  strokeWidth={isSel ? 2 : 1}
                  draggable={tool === 'select'}
                  onClick={() => onRectClick(c.id)}
                  onTap={() => onRectClick(c.id)}
                  onDragStart={onDragStart}
                  onDragEnd={(e) => onDragEnd(c, e)}
                />
              )
            })}

            {/* Transformer (move / resize handles) */}
            <Transformer
              ref={trRef}
              rotateEnabled={false}
              keepRatio={false}
              borderStroke="#f59e0b"
              anchorStroke="#f59e0b"
              anchorFill="#f59e0b"
              anchorSize={8}
              borderDash={[4, 2]}
              onTransformStart={onTransformStart}
              onTransformEnd={onTransformEnd}
            />

            {/* Live draw preview */}
            {pendingRect && (
              <KonvaRect
                x={pendingRect.x}
                y={pendingRect.y}
                width={pendingRect.w}
                height={pendingRect.h}
                fill="rgba(251,191,36,0.12)"
                stroke="rgba(251,191,36,0.75)"
                strokeWidth={1.5}
                dash={[5, 3]}
                listening={false}
              />
            )}

          </Layer>
        </Stage>
      </div>
    </div>
  )
}
