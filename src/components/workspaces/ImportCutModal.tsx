import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useImageStore } from '../../stores/imageStore'
import { htmlImageToRGBA } from '../../lib/cut/imageData'
import { fileToLoadedImage } from '../../lib/cut/importImage'
import { addCutToTray } from '../../lib/cut/createPart'
import { cutPolygon, cutRect, type Pt, type RGBAImage } from '../../lib/cut/freeCut'
import PartsTray from './PartsTray'

/**
 * ImportCutModal — Phase 2's self-contained "Import & Cut to Tray" surface.
 *
 * Deliberately isolated from the main canvas/ExtractionEditor so it can't
 * destabilize the shell: it renders its own <canvas>, does its own pointer math
 * (display space -> image space via a single uniform scale, so there is no
 * letterbox ambiguity), and stages results in the shared Parts tray.
 *
 * Two cut gestures: RECT (drag a box) and LASSO (freehand). Source is either a
 * freshly imported image or the current panel.
 */
const MAX_W = 680
const MAX_H = 460

type ModalTool = 'rect' | 'lasso'

export default function ImportCutModal() {
  const open = useWorkspaceStore((s) => s.partsCutterOpen)
  if (!open) return null
  return <ModalBody />
}

function ModalBody() {
  const close = useWorkspaceStore((s) => s.closePartsCutter)
  const sourceImage = useImageStore((s) => s.sourceImage)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null)
  const [rgba, setRgba] = useState<RGBAImage | null>(null)
  const [scale, setScale] = useState(1)
  const [srcName, setSrcName] = useState('image')
  const [imageId, setImageId] = useState<string | undefined>(undefined)
  const [srcKind, setSrcKind] = useState<'cut' | 'import'>('import')
  const [tool, setTool] = useState<ModalTool>('rect')

  // Selection state (display-space coordinates).
  const [rectStart, setRectStart] = useState<Pt | null>(null)
  const [rectEnd, setRectEnd] = useState<Pt | null>(null)
  const [lasso, setLasso] = useState<Pt[]>([])
  const drawingRef = useRef(false)
  const [cutCount, setCutCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const loadFromElement = useCallback((el: HTMLImageElement, name: string, kind: 'cut' | 'import', id?: string) => {
    const iw = el.naturalWidth || el.width
    const ih = el.naturalHeight || el.height
    const s = Math.min(MAX_W / iw, MAX_H / ih, 1)
    setImgEl(el)
    setRgba(htmlImageToRGBA(el))
    setScale(s)
    setSrcName(name)
    setSrcKind(kind)
    setImageId(id)
    setRectStart(null); setRectEnd(null); setLasso([])
    setError(null)
  }, [])

  const onImportFile = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/bmp'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const loaded = await fileToLoadedImage(file)
        loadFromElement(loaded.htmlImage, file.name, 'import', loaded.id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load image')
      }
    }
    input.click()
  }, [loadFromElement])

  const onUsePanel = useCallback(() => {
    if (sourceImage?.htmlImage) {
      loadFromElement(sourceImage.htmlImage, sourceImage.path || 'panel', 'cut', sourceImage.id)
    }
  }, [sourceImage, loadFromElement])

  // Redraw the image + current selection whenever anything changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imgEl || !rgba) return
    const w = Math.round(rgba.width * scale)
    const h = Math.round(rgba.height * scale)
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(imgEl, 0, 0, w, h)

    ctx.strokeStyle = '#6ea8fe'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 3])
    if (tool === 'rect' && rectStart && rectEnd) {
      ctx.strokeRect(
        Math.min(rectStart.x, rectEnd.x), Math.min(rectStart.y, rectEnd.y),
        Math.abs(rectEnd.x - rectStart.x), Math.abs(rectEnd.y - rectStart.y),
      )
    } else if (tool === 'lasso' && lasso.length > 1) {
      ctx.beginPath()
      ctx.moveTo(lasso[0].x, lasso[0].y)
      for (const p of lasso.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }, [imgEl, rgba, scale, tool, rectStart, rectEnd, lasso])

  const ptOf = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onDown = (e: React.PointerEvent) => {
    if (!rgba) return
    drawingRef.current = true
    const p = ptOf(e)
    if (tool === 'rect') { setRectStart(p); setRectEnd(p) }
    else setLasso([p])
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drawingRef.current || !rgba) return
    const p = ptOf(e)
    if (tool === 'rect') setRectEnd(p)
    else setLasso((prev) => {
      const last = prev[prev.length - 1]
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 2.5) return prev
      return [...prev, p]
    })
  }
  const onUp = () => { drawingRef.current = false }

  const hasSelection =
    (tool === 'rect' && !!rectStart && !!rectEnd &&
      Math.abs(rectEnd.x - rectStart.x) > 3 && Math.abs(rectEnd.y - rectStart.y) > 3) ||
    (tool === 'lasso' && lasso.length >= 3)

  const onCut = () => {
    if (!rgba || !hasSelection) return
    const meta = { name: `${srcName.replace(/\.[^.]+$/, '')} ${cutCount + 1}`, kind: srcKind, imageId, srcName }
    let res = null
    if (tool === 'rect' && rectStart && rectEnd) {
      res = cutRect(rgba, {
        x: Math.min(rectStart.x, rectEnd.x) / scale,
        y: Math.min(rectStart.y, rectEnd.y) / scale,
        width: Math.abs(rectEnd.x - rectStart.x) / scale,
        height: Math.abs(rectEnd.y - rectStart.y) / scale,
      })
    } else {
      const poly = lasso.map((p) => ({ x: p.x / scale, y: p.y / scale }))
      res = cutPolygon(rgba, poly)
    }
    if (!res) { setError('Selection was empty'); return }
    addCutToTray(res, meta)
    setCutCount((n) => n + 1)
    setRectStart(null); setRectEnd(null); setLasso([])
  }

  const clearSelection = () => { setRectStart(null); setRectEnd(null); setLasso([]) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={close}>
      <div
        className="w-[760px] max-w-[95vw] max-h-[92vh] flex flex-col rounded-xl bg-surface-1 border border-surface-4 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-4 shrink-0">
          <div className="text-[13px] font-medium text-neutral-200">Import &amp; Cut to Parts Tray</div>
          <button onClick={close} className="text-muted hover:text-neutral-200 text-lg leading-none px-1">×</button>
        </div>

        {/* controls */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-4 shrink-0 flex-wrap">
          <button onClick={onImportFile} className="h-7 px-2.5 rounded-md text-[11px] bg-accent/20 text-accent hover:bg-accent/30 transition-colors">
            Load image…
          </button>
          <button
            onClick={onUsePanel}
            disabled={!sourceImage?.htmlImage}
            className="h-7 px-2.5 rounded-md text-[11px] text-muted-text hover:text-neutral-200 hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Use current panel
          </button>
          <div className="w-px h-5 bg-surface-5 mx-0.5" />
          <div className="flex items-center gap-0.5">
            {(['rect', 'lasso'] as ModalTool[]).map((t) => (
              <button
                key={t}
                onClick={() => { setTool(t); clearSelection() }}
                className={`h-7 px-2.5 rounded-md text-[11px] capitalize transition-colors ${
                  tool === t ? 'bg-accent-bg15 text-accent border border-accent/30' : 'text-muted-text hover:text-neutral-300 hover:bg-surface-3'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button
            onClick={onCut}
            disabled={!hasSelection}
            className="h-7 px-3 rounded-md text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Cut to Tray ↵
          </button>
        </div>

        {/* stage */}
        <div className="flex-1 min-h-[300px] flex items-center justify-center bg-surface-0/60 overflow-auto p-3">
          {rgba ? (
            <canvas
              ref={canvasRef}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerLeave={onUp}
              className="cursor-crosshair rounded shadow-lg touch-none"
              style={{ imageRendering: 'auto' }}
            />
          ) : (
            <div className="text-[12px] text-muted/60 text-center">
              Load an image or use the current panel, then drag a {tool === 'rect' ? 'box' : 'freehand loop'} to cut a part.
            </div>
          )}
        </div>

        {error && <div className="px-4 py-1 text-[11px] text-red-400 shrink-0">{error}</div>}

        {/* in-modal tray */}
        <div className="h-28 border-t border-surface-4 shrink-0">
          <PartsTray />
        </div>
      </div>
    </div>
  )
}
