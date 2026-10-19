import { useCallback, useEffect, useRef, useState } from 'react'
import { Stage, Layer, Image as KonvaImage, Transformer } from 'react-konva'
import type Konva from 'konva'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useImageStore } from '../../stores/imageStore'
import { usePartsTrayStore, type TrayPart } from '../../stores/partsTrayStore'
import { useCompositionStore, type PlacedElement } from '../../stores/compositionStore'
import { type Adjustments, normalizeAdjustments, isDefaultAdjustments } from '../../lib/compose/adjustments'
import { adjustmentsKey, bakeAdjustmentsToDataUrl, loadImage } from '../../lib/compose/bakeDom'

/**
 * ComposeModal — Phase 3's compositing surface (self-contained, low blast-radius).
 *
 * Shows the current panel as a background and lets the user drop Parts-tray
 * pieces onto it, then move / scale / rotate (Konva Transformer) and z-order
 * them. Every placed element is provenance:'user' so re-analysis never removes
 * it, and it flows into the export (Phase 5) via compositionStore + toLayout.
 */
const MAX_W = 720
const MAX_H = 460

export default function ComposeModal() {
  const open = useWorkspaceStore((s) => s.composeOpen)
  if (!open) return null
  return <ModalBody />
}

function ModalBody() {
  const close = useWorkspaceStore((s) => s.closeCompose)
  const panel = useImageStore((s) => s.sourceImage)
  const parts = usePartsTrayStore((s) => s.parts)

  const elements = useCompositionStore((s) => s.elements)
  const selectedId = useCompositionStore((s) => s.selectedId)
  const place = useCompositionStore((s) => s.place)
  const update = useCompositionStore((s) => s.update)
  const adjust = useCompositionStore((s) => s.adjust)
  const resetAdjustments = useCompositionStore((s) => s.resetAdjustments)
  const remove = useCompositionStore((s) => s.remove)
  const select = useCompositionStore((s) => s.select)
  const bringForward = useCompositionStore((s) => s.bringForward)
  const sendBackward = useCompositionStore((s) => s.sendBackward)
  const clear = useCompositionStore((s) => s.clear)

  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const [imgMap, setImgMap] = useState<Record<string, { key: string; img: HTMLImageElement }>>({})

  const scale = panel ? Math.min(MAX_W / panel.width, MAX_H / panel.height, 1) : 1
  const selected = elements.find((e) => e.id === selectedId) ?? null

  // Load a decoded HTMLImageElement for every element, re-baking whenever its
  // adjustments change (same pixel path as the export bake -> WYSIWYG).
  useEffect(() => {
    let cancelled = false
    for (const el of elements) {
      const key = adjustmentsKey(el.adjustments)
      if (imgMap[el.id]?.key === key) continue
      bakeAdjustmentsToDataUrl(el.dataUrl, el.adjustments)
        .then(loadImage)
        .then((img) => { if (!cancelled) setImgMap((m) => ({ ...m, [el.id]: { key, img } })) })
        .catch(() => { /* leave previous image in place on decode failure */ })
    }
    return () => { cancelled = true }
  }, [elements, imgMap])

  // Keep the Transformer attached to the selected node.
  useEffect(() => {
    const tr = trRef.current
    const stage = stageRef.current
    if (!tr || !stage) return
    const node = selectedId ? stage.findOne(`#comp_${selectedId}`) : null
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selectedId, elements, imgMap])

  // Delete key removes the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        remove(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, remove])

  const placePart = useCallback((part: TrayPart) => {
    if (!panel) return
    const w = Math.min(part.width, panel.width * 0.5)
    const s = w / part.width
    const h = part.height * s
    place({
      name: part.name, dataUrl: part.dataUrl, partId: part.id,
      x: (panel.width - w) / 2, y: (panel.height - h) / 2, width: w, height: h,
    })
  }, [panel, place])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={close}>
      <div
        className="w-[820px] max-w-[96vw] max-h-[94vh] flex flex-col rounded-xl bg-surface-1 border border-surface-4 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-4 shrink-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-mono text-accent">STEP 2</span>
            <span className="text-[13px] font-medium text-neutral-200">Arrange — place parts on the panel</span>
            <span className="text-[10px] text-muted/60">optional · Extract → Arrange → Export</span>
          </div>
          <button onClick={close} className="text-muted hover:text-neutral-200 text-lg leading-none px-1">×</button>
        </div>

        {/* toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-4 shrink-0 flex-wrap text-[11px]">
          <button onClick={() => selectedId && bringForward(selectedId)} disabled={!selectedId}
            className="h-7 px-2.5 rounded-md text-muted-text hover:text-neutral-200 hover:bg-surface-3 disabled:opacity-40 transition-colors">
            Bring forward
          </button>
          <button onClick={() => selectedId && sendBackward(selectedId)} disabled={!selectedId}
            className="h-7 px-2.5 rounded-md text-muted-text hover:text-neutral-200 hover:bg-surface-3 disabled:opacity-40 transition-colors">
            Send backward
          </button>
          <button onClick={() => selectedId && remove(selectedId)} disabled={!selectedId}
            className="h-7 px-2.5 rounded-md text-red-400/80 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-colors">
            Delete
          </button>
          <div className="flex-1" />
          <span className="text-muted/60 font-mono">{elements.length} placed</span>
          {elements.length > 0 && (
            <button onClick={clear} className="h-7 px-2.5 rounded-md text-muted/70 hover:text-red-400 uppercase tracking-wide">
              Clear
            </button>
          )}
        </div>

        {/* stage */}
        <div className="flex-1 min-h-[300px] flex items-center justify-center bg-surface-0/60 overflow-auto p-3">
          {panel ? (
            <Stage
              ref={stageRef}
              width={Math.round(panel.width * scale)}
              height={Math.round(panel.height * scale)}
              className="rounded shadow-lg"
              onMouseDown={(e) => { if (e.target === e.target.getStage() || e.target.name() === 'bg') select(null) }}
            >
              <Layer scaleX={scale} scaleY={scale}>
                <KonvaImage image={panel.htmlImage} name="bg" x={0} y={0} width={panel.width} height={panel.height} listening />
                {[...elements].sort((a, b) => a.z - b.z).map((el) => {
                  const image = imgMap[el.id]?.img
                  if (!image) return null
                  return (
                    <KonvaImage
                      key={el.id}
                      id={`comp_${el.id}`}
                      image={image}
                      x={el.x} y={el.y} width={el.width} height={el.height} rotation={el.rotation}
                      draggable
                      onClick={() => select(el.id)}
                      onTap={() => select(el.id)}
                      onDragEnd={(e) => update(el.id, { x: e.target.x(), y: e.target.y() })}
                      onTransformEnd={(e) => {
                        const node = e.target as Konva.Node
                        const sx = node.scaleX(), sy = node.scaleY()
                        node.scaleX(1); node.scaleY(1)
                        update(el.id, {
                          x: node.x(), y: node.y(),
                          width: Math.max(5, node.width() * sx),
                          height: Math.max(5, node.height() * sy),
                          rotation: node.rotation(),
                        })
                      }}
                    />
                  )
                })}
                <Transformer ref={trRef} rotateEnabled flipEnabled={false}
                  boundBoxFunc={(_old, next) => (next.width < 5 || next.height < 5 ? _old : next)} />
              </Layer>
            </Stage>
          ) : (
            <div className="text-[12px] text-muted/60 text-center">
              Load a panel image in Extract first — it becomes the compositing background.
            </div>
          )}
        </div>

        {/* recolor panel — shown only when an element is selected (Phase 4) */}
        {selected && (
          <RecolorPanel
            key={selected.id}
            element={selected}
            onAdjust={(patch) => adjust(selected.id, patch)}
            onReset={() => resetAdjustments(selected.id)}
          />
        )}

        {/* parts tray strip (click a part to place it on the panel) */}
        <div className="h-28 border-t border-surface-4 shrink-0 flex flex-col">
          <div className="px-3 py-1 text-[10px] uppercase tracking-[1px] text-muted/70 shrink-0">
            Parts — click to place
          </div>
          {parts.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-muted/50">
              No parts yet — cut some via “Import &amp; Cut Parts”.
            </div>
          ) : (
            <div className="flex-1 overflow-x-auto overflow-y-hidden">
              <div className="flex items-stretch gap-1.5 p-2 h-full min-w-min">
                {parts.map((part) => (
                  <button
                    key={part.id}
                    onClick={() => placePart(part)}
                    disabled={!panel}
                    title={`Place “${part.name}”`}
                    className="h-full aspect-square rounded-lg overflow-hidden border border-surface-4 bg-surface-2 hover:border-accent disabled:opacity-40 shrink-0"
                    style={{ background: 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 12px 12px' }}
                  >
                    <img src={part.dataUrl} alt={part.name} className="w-full h-full object-contain p-1.5" draggable={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Recolor (Phase 4) ──────────────────────────────────────────────────────────

function RecolorPanel({ element, onAdjust, onReset }: {
  element: PlacedElement
  onAdjust: (patch: Partial<Adjustments>) => void
  onReset: () => void
}) {
  const a = normalizeAdjustments(element.adjustments)
  const dirty = !isDefaultAdjustments(a)
  return (
    <div className="border-t border-surface-4 shrink-0 px-3 py-2 bg-surface-1/60">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-[1px] text-muted/70">Recolor</span>
        <span className="text-[11px] text-neutral-300 truncate max-w-[220px]">{element.name}</span>
        <div className="flex-1" />
        {dirty && (
          <button onClick={onReset}
            className="h-6 px-2 rounded text-[10px] text-muted/70 hover:text-red-400 uppercase tracking-wide">
            Reset
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <Slider label="Hue" min={-180} max={180} step={1} value={a.hue}
          fmt={(v) => `${v}°`} onChange={(v) => onAdjust({ hue: v })} />
        <Slider label="Saturation" min={0} max={2} step={0.01} value={a.saturation}
          fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onAdjust({ saturation: v })} />
        <Slider label="Brightness" min={0} max={2} step={0.01} value={a.brightness}
          fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onAdjust({ brightness: v })} />
        <Slider label="Contrast" min={0} max={2} step={0.01} value={a.contrast}
          fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onAdjust({ contrast: v })} />
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-[10px] text-muted/70 w-16">Tint</span>
        <input
          type="color"
          value={a.tint ?? '#ffffff'}
          onChange={(e) => onAdjust({ tint: e.target.value, tintStrength: a.tintStrength > 0 ? a.tintStrength : 0.4 })}
          className="h-6 w-8 rounded border border-surface-4 bg-transparent p-0"
        />
        <input
          type="range" min={0} max={1} step={0.01} value={a.tintStrength}
          onChange={(e) => onAdjust({ tintStrength: Number(e.target.value) })}
          className="flex-1 accent-accent"
        />
        <span className="text-[10px] text-muted/60 font-mono w-9 text-right">{Math.round(a.tintStrength * 100)}%</span>
      </div>
    </div>
  )
}

function Slider({ label, min, max, step, value, fmt, onChange }: {
  label: string; min: number; max: number; step: number; value: number
  fmt: (v: number) => string; onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] text-muted/70 w-16 shrink-0">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-accent"
      />
      <span className="text-[10px] text-muted/60 font-mono w-10 text-right shrink-0">{fmt(value)}</span>
    </label>
  )
}
