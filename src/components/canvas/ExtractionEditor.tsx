import { useRef, useState, useEffect, useCallback, useReducer } from 'react'
import { useAssetStore } from '../../stores/assetStore'
import type { Asset } from '../../types'
import RefineEdgePanel from './RefineEdgePanel'

type EditorTool = 'move' | 'resize' | 'brush' | 'eraser' | 'center' | 'sam' | 'lasso'

interface ExtractionEditorProps {
  asset: Asset
}

export default function ExtractionEditor({ asset }: ExtractionEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const updateAssetExtraction = useAssetStore((s) => s.updateAssetExtraction)
  const updateAssetBounds = useAssetStore((s) => s.updateAssetBounds)

  const [tool, setTool] = useState<EditorTool>('move')
  const [brushSize, setBrushSize] = useState(4)
  const [samBusy, setSamBusy] = useState(false)
  const [lassoMode, setLassoMode] = useState<'add' | 'subtract'>('subtract')
  const isLassoing = useRef(false)
  const lassoPoints = useRef<{ x: number; y: number }[]>([])
  const [zoom, setZoom] = useState(1)
  const [showGrid, setShowGrid] = useState(true)
  const [centerPoint, setCenterPoint] = useState<{ x: number; y: number }>({
    x: asset.metadata.centerPoint?.x ?? Math.round(asset.bounds.width / 2),
    y: asset.metadata.centerPoint?.y ?? Math.round(asset.bounds.height / 2),
  })

  // Track offsets for move tool
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [resizeDelta, setResizeDelta] = useState({ dw: 0, dh: 0, side: '' })
  const isPainting = useRef(false)
  const lastPaintPos = useRef<{ x: number; y: number } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })

  // Load main image
  const imgRef = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    const img = new window.Image()
    img.onload = () => {
      imgRef.current = img
      drawCanvas()
    }
    img.src = asset.maskDataUrl
  }, [asset.maskDataUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mask edit history (undo/redo) ────────────────────────────────────────
  // Every destructive mask edit (brush, eraser, lasso, SAM re-cut, Refine Edge)
  // pushes the PREVIOUS mask onto a bounded stack so Ctrl+Z restores it. This
  // is the mask editor's own nested history — separate from the asset store's
  // object-level snapshots — so a stray brush stroke is never a data-loss event.
  const MASK_HISTORY_LIMIT = 40
  const maskUndoRef = useRef<string[]>([])
  const maskRedoRef = useRef<string[]>([])
  const currentMaskRef = useRef<string>(asset.maskDataUrl)
  const [, bumpHistory] = useReducer((x: number) => x + 1, 0)

  // Keep the "current mask" mirror in sync with whatever is displayed.
  useEffect(() => { currentMaskRef.current = asset.maskDataUrl }, [asset.maskDataUrl])

  // Reset history when switching to a different asset.
  useEffect(() => {
    maskUndoRef.current = []
    maskRedoRef.current = []
    currentMaskRef.current = asset.maskDataUrl
    bumpHistory()
  }, [asset.id]) // eslint-disable-line react-hooks/exhaustive-deps

  type ExtractionUpdates = Parameters<typeof updateAssetExtraction>[1]

  /** Commit a new mask, recording the replaced one for undo. */
  const commitMask = useCallback((newUrl: string, extra?: Omit<ExtractionUpdates, 'maskDataUrl'>) => {
    maskUndoRef.current.push(currentMaskRef.current)
    if (maskUndoRef.current.length > MASK_HISTORY_LIMIT) maskUndoRef.current.shift()
    maskRedoRef.current = []
    currentMaskRef.current = newUrl
    updateAssetExtraction(asset.id, { maskDataUrl: newUrl, ...(extra ?? {}) })
    bumpHistory()
  }, [asset.id, updateAssetExtraction])

  const undoMask = useCallback(() => {
    if (maskUndoRef.current.length === 0) return
    const prev = maskUndoRef.current.pop() as string
    maskRedoRef.current.push(currentMaskRef.current)
    currentMaskRef.current = prev
    updateAssetExtraction(asset.id, { maskDataUrl: prev })
    bumpHistory()
  }, [asset.id, updateAssetExtraction])

  const redoMask = useCallback(() => {
    if (maskRedoRef.current.length === 0) return
    const next = maskRedoRef.current.pop() as string
    maskUndoRef.current.push(currentMaskRef.current)
    currentMaskRef.current = next
    updateAssetExtraction(asset.id, { maskDataUrl: next })
    bumpHistory()
  }, [asset.id, updateAssetExtraction])

  // Reset center point when asset changes
  useEffect(() => {
    setCenterPoint({
      x: asset.metadata.centerPoint?.x ?? Math.round(asset.bounds.width / 2),
      y: asset.metadata.centerPoint?.y ?? Math.round(asset.bounds.height / 2),
    })
  }, [asset.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fit zoom
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const cw = container.clientWidth - 16
    const ch = container.clientHeight - 16
    const iw = asset.bounds.width || 100
    const ih = asset.bounds.height || 100
    const z = Math.min(cw / iw, ch / ih, 8)
    setZoom(Math.max(1, Math.floor(z)))
  }, [asset.bounds.width, asset.bounds.height])

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return
    const w = img.naturalWidth
    const h = img.naturalHeight
    canvas.width = w * zoom
    canvas.height = h * zoom
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    // Checkerboard bg
    const tileSize = Math.max(4, zoom)
    for (let y = 0; y < canvas.height; y += tileSize) {
      for (let x = 0; x < canvas.width; x += tileSize) {
        const dark = ((Math.floor(x / tileSize) + Math.floor(y / tileSize)) % 2) === 0
        ctx.fillStyle = dark ? '#2a2a2a' : '#333333'
        ctx.fillRect(x, y, tileSize, tileSize)
      }
    }

    // Draw image
    ctx.drawImage(img, 0, 0, w * zoom, h * zoom)

    // Grid
    if (showGrid && zoom >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 0.5
      for (let x = 0; x <= w; x++) {
        ctx.beginPath()
        ctx.moveTo(x * zoom, 0)
        ctx.lineTo(x * zoom, h * zoom)
        ctx.stroke()
      }
      for (let y = 0; y <= h; y++) {
        ctx.beginPath()
        ctx.moveTo(0, y * zoom)
        ctx.lineTo(w * zoom, y * zoom)
        ctx.stroke()
      }
    }

    drawOverlay()
  }, [zoom, showGrid]) // eslint-disable-line react-hooks/exhaustive-deps

  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current
    const img = imgRef.current
    if (!overlay || !img) return
    const w = img.naturalWidth
    const h = img.naturalHeight
    overlay.width = w * zoom
    overlay.height = h * zoom
    const ctx = overlay.getContext('2d')!
    ctx.clearRect(0, 0, overlay.width, overlay.height)

    // Bounds outline
    ctx.strokeStyle = '#ffaa33'
    ctx.lineWidth = 1
    ctx.strokeRect(0, 0, w * zoom, h * zoom)

    // Center point crosshair
    if (asset.type === 'knob' || asset.type === 'button') {
      const cx = centerPoint.x * zoom
      const cy = centerPoint.y * zoom
      ctx.strokeStyle = '#f43f5e'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, h * zoom)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, cy)
      ctx.lineTo(w * zoom, cy)
      ctx.stroke()
      ctx.setLineDash([])
      // Center dot
      ctx.fillStyle = '#f43f5e'
      ctx.beginPath()
      ctx.arc(cx, cy, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Resize handles
    const hs = 6
    ctx.fillStyle = '#ffaa33'
    const corners = [
      [0, 0], [w * zoom, 0],
      [0, h * zoom], [w * zoom, h * zoom],
    ]
    for (const [hx, hy] of corners) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs)
    }
    // Edge midpoints
    const mids = [
      [w * zoom / 2, 0], [w * zoom / 2, h * zoom],
      [0, h * zoom / 2], [w * zoom, h * zoom / 2],
    ]
    for (const [mx, my] of mids) {
      ctx.fillRect(mx - hs / 2, my - hs / 2, hs, hs)
    }

    // Brush cursor preview
    if (tool === 'brush' || tool === 'eraser') {
      ctx.strokeStyle = tool === 'brush' ? '#6ee7b7' : '#f87171'
      ctx.lineWidth = 1
      ctx.setLineDash([2, 2])
      if (lastPaintPos.current) {
        const bx = lastPaintPos.current.x * zoom
        const by = lastPaintPos.current.y * zoom
        ctx.beginPath()
        ctx.arc(bx, by, brushSize * zoom / 2, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }
  }, [zoom, centerPoint, tool, brushSize, asset.type])

  useEffect(() => {
    drawCanvas()
  }, [drawCanvas])

  // Mouse-to-image coords
  const getImageCoords = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) / zoom
    const y = (e.clientY - rect.top) / zoom
    return { x, y }
  }, [zoom])

  // Paint pixel on mask
  const paintPixel = useCallback((imgX: number, imgY: number, erase: boolean) => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return

    // Create offscreen canvas for mask editing
    const offscreen = document.createElement('canvas')
    offscreen.width = img.naturalWidth
    offscreen.height = img.naturalHeight
    const octx = offscreen.getContext('2d')!
    octx.drawImage(img, 0, 0)

    const halfBrush = Math.floor(brushSize / 2)
    const px = Math.round(imgX)
    const py = Math.round(imgY)

    if (erase) {
      octx.clearRect(px - halfBrush, py - halfBrush, brushSize, brushSize)
    } else {
      // Sample center color for brush
      const imgData = octx.getImageData(
        Math.max(0, Math.min(img.naturalWidth - 1, px)),
        Math.max(0, Math.min(img.naturalHeight - 1, py)),
        1, 1
      )
      const [r, g, b] = imgData.data
      octx.fillStyle = `rgb(${r},${g},${b})`
      octx.globalCompositeOperation = 'source-over'
      octx.beginPath()
      octx.arc(px, py, halfBrush, 0, Math.PI * 2)
      octx.fill()
      // Restore alpha from mask
      octx.globalCompositeOperation = 'destination-in'
      const maskCanvas = document.createElement('canvas')
      maskCanvas.width = img.naturalWidth
      maskCanvas.height = img.naturalHeight
      const mctx = maskCanvas.getContext('2d')!
      mctx.drawImage(img, 0, 0)
      // Expand the mask at brush location
      mctx.fillStyle = 'white'
      mctx.beginPath()
      mctx.arc(px, py, halfBrush, 0, Math.PI * 2)
      mctx.fill()
      octx.drawImage(maskCanvas, 0, 0)
      octx.globalCompositeOperation = 'source-over'
    }

    // Update imgRef and redraw
    const newDataUrl = offscreen.toDataURL('image/png')
    const newImg = new window.Image()
    newImg.onload = () => {
      imgRef.current = newImg
      drawCanvas()
    }
    newImg.src = newDataUrl
  }, [brushSize, drawCanvas])

  // Interactive SAM re-cut: click on the element to re-segment it cleanly with
  // SAM2. Runs against the asset's current crop; the result (crop-local bounds)
  // is offset back into source space before saving.
  const runSamAt = useCallback(async (x: number, y: number) => {
    setSamBusy(true)
    try {
      const { pythonClient } = await import('../../lib/api/pythonClient')
      const res = await pythonClient.sam2SegmentPoint(asset.maskDataUrl, [[x, y]], [1], true)
      const best = res.masks?.[0]
      if (best?.dataUrl && best.bounds) {
        commitMask(best.dataUrl, {
          bounds: {
            x: asset.bounds.x + best.bounds.x,
            y: asset.bounds.y + best.bounds.y,
            width: best.bounds.width,
            height: best.bounds.height,
          },
        })
      }
    } catch {
      /* keep the prior mask on failure */
    } finally {
      setSamBusy(false)
    }
  }, [asset.id, asset.maskDataUrl, asset.bounds.x, asset.bounds.y, commitMask])

  // Lasso boolean: fill a freehand polygon into the mask alpha. The crop keeps
  // its RGB even where alpha is 0, so 'add' reveals stored pixels and 'subtract'
  // hides them — no backend round-trip needed.
  const applyLassoPolygon = useCallback((pts: { x: number; y: number }[], mode: 'add' | 'subtract') => {
    const img = imgRef.current
    if (!img || pts.length < 3) return
    const w = img.naturalWidth
    const h = img.naturalHeight

    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const octx = off.getContext('2d')!
    octx.drawImage(img, 0, 0)

    // Render the polygon to a membership mask.
    const pm = document.createElement('canvas')
    pm.width = w
    pm.height = h
    const pctx = pm.getContext('2d')!
    pctx.fillStyle = '#fff'
    pctx.beginPath()
    pctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) pctx.lineTo(pts[i].x, pts[i].y)
    pctx.closePath()
    pctx.fill()
    const pdata = pctx.getImageData(0, 0, w, h).data

    const idata = octx.getImageData(0, 0, w, h)
    const targetAlpha = mode === 'add' ? 255 : 0
    for (let i = 0; i < w * h; i++) {
      if (pdata[i * 4 + 3] > 0) idata.data[i * 4 + 3] = targetAlpha
    }
    octx.putImageData(idata, 0, 0)

    const url = off.toDataURL('image/png')
    const ni = new window.Image()
    ni.onload = () => {
      imgRef.current = ni
      drawCanvas()
    }
    ni.src = url
    commitMask(url)
  }, [commitMask, drawCanvas])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const coords = getImageCoords(e)

    if (tool === 'lasso') {
      isLassoing.current = true
      lassoPoints.current = [coords]
      return
    }

    if (tool === 'sam') {
      if (samBusy) return
      const x = Math.max(0, Math.min(asset.bounds.width, coords.x))
      const y = Math.max(0, Math.min(asset.bounds.height, coords.y))
      void runSamAt(x, y)
      return
    }

    if (tool === 'center') {
      const newCenter = { x: Math.round(coords.x), y: Math.round(coords.y) }
      setCenterPoint(newCenter)
      return
    }

    if (tool === 'brush' || tool === 'eraser') {
      isPainting.current = true
      lastPaintPos.current = coords
      paintPixel(coords.x, coords.y, tool === 'eraser')
      return
    }

    if (tool === 'move') {
      isDragging.current = true
      dragStart.current = { x: e.clientX, y: e.clientY }
      return
    }
  }, [tool, samBusy, asset.bounds.width, asset.bounds.height, getImageCoords, paintPixel, runSamAt])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const coords = getImageCoords(e)

    if (tool === 'lasso' && isLassoing.current) {
      lassoPoints.current.push(coords)
      const overlay = overlayRef.current
      if (overlay) {
        const octx = overlay.getContext('2d')!
        octx.clearRect(0, 0, overlay.width, overlay.height)
        octx.strokeStyle = lassoMode === 'add' ? '#6ee7b7' : '#f87171'
        octx.lineWidth = 1.5
        octx.beginPath()
        const p = lassoPoints.current
        octx.moveTo(p[0].x * zoom, p[0].y * zoom)
        for (let i = 1; i < p.length; i++) octx.lineTo(p[i].x * zoom, p[i].y * zoom)
        octx.stroke()
      }
      return
    }

    if ((tool === 'brush' || tool === 'eraser') && isPainting.current) {
      // Interpolate between last and current position
      const last = lastPaintPos.current
      if (last) {
        const dx = coords.x - last.x
        const dy = coords.y - last.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        const steps = Math.max(1, Math.ceil(dist))
        for (let i = 1; i <= steps; i++) {
          const t = i / steps
          paintPixel(last.x + dx * t, last.y + dy * t, tool === 'eraser')
        }
      }
      lastPaintPos.current = coords
      return
    }

    if (tool === 'move' && isDragging.current) {
      const dx = e.clientX - dragStart.current.x
      const dy = e.clientY - dragStart.current.y
      setOffset({ x: Math.round(dx / zoom), y: Math.round(dy / zoom) })
      return
    }

    // Track cursor for brush preview
    if (tool === 'brush' || tool === 'eraser') {
      lastPaintPos.current = coords
      drawOverlay()
    }
  }, [tool, zoom, lassoMode, getImageCoords, paintPixel, drawOverlay])

  const handleMouseUp = useCallback(() => {
    if (tool === 'lasso' && isLassoing.current) {
      isLassoing.current = false
      const pts = lassoPoints.current
      lassoPoints.current = []
      const overlay = overlayRef.current
      if (overlay) overlay.getContext('2d')!.clearRect(0, 0, overlay.width, overlay.height)
      if (pts.length >= 3) applyLassoPolygon(pts, lassoMode)
      return
    }

    if ((tool === 'brush' || tool === 'eraser') && isPainting.current) {
      isPainting.current = false
      lastPaintPos.current = null
      // Commit mask change
      const img = imgRef.current
      if (img) {
        const offscreen = document.createElement('canvas')
        offscreen.width = img.naturalWidth
        offscreen.height = img.naturalHeight
        const ctx = offscreen.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        commitMask(offscreen.toDataURL('image/png'))
      }
    }

    if (tool === 'move' && isDragging.current) {
      isDragging.current = false
      if (offset.x !== 0 || offset.y !== 0) {
        updateAssetBounds(asset.id, {
          x: asset.bounds.x + offset.x,
          y: asset.bounds.y + offset.y,
        })
        setOffset({ x: 0, y: 0 })
      }
    }
  }, [tool, offset, asset.id, asset.bounds, lassoMode, applyLassoPolygon, commitMask, updateAssetBounds])

  // Keyboard shortcuts for nudge
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Mask undo/redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y).
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redoMask()
        else undoMask()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redoMask()
        return
      }
      // Only handle when this component is active
      const step = e.shiftKey ? 10 : 1
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          updateAssetBounds(asset.id, { y: asset.bounds.y - step })
          break
        case 'ArrowDown':
          e.preventDefault()
          updateAssetBounds(asset.id, { y: asset.bounds.y + step })
          break
        case 'ArrowLeft':
          e.preventDefault()
          updateAssetBounds(asset.id, { x: asset.bounds.x - step })
          break
        case 'ArrowRight':
          e.preventDefault()
          updateAssetBounds(asset.id, { x: asset.bounds.x + step })
          break
        case 'b':
          setTool('brush')
          break
        case 'e':
          setTool('eraser')
          break
        case 'k':
          setTool('sam')
          break
        case 'l':
          setTool('lasso')
          break
        case 'm':
          setTool('move')
          break
        case 'p':
          setTool('center')
          break
        case '[':
          setBrushSize((s) => Math.max(1, s - 1))
          break
        case ']':
          setBrushSize((s) => Math.min(32, s + 1))
          break
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [asset.id, asset.bounds, updateAssetBounds, undoMask, redoMask])

  // Commit center point changes
  const commitCenterPoint = useCallback(() => {
    updateAssetExtraction(asset.id, {
      metadata: { centerPoint: { x: centerPoint.x, y: centerPoint.y } },
    })
  }, [asset.id, centerPoint, updateAssetExtraction])

  useEffect(() => {
    commitCenterPoint()
  }, [centerPoint]) // eslint-disable-line react-hooks/exhaustive-deps

  // Manual bounds input
  const handleBoundsChange = (field: 'x' | 'y' | 'width' | 'height', value: string) => {
    const num = parseInt(value, 10)
    if (!isNaN(num) && num >= 0) {
      updateAssetBounds(asset.id, { [field]: num })
    }
  }

  // Zoom scroll
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    if (e.deltaY < 0) {
      setZoom((z) => Math.min(32, z + 1))
    } else {
      setZoom((z) => Math.max(1, z - 1))
    }
  }, [])

  // Re-extract from source
  const handleReExtract = useCallback(async () => {
    try {
      const { pythonClient } = await import('../../lib/api/pythonClient')
      const sourceImage = (await import('../../stores/imageStore')).useImageStore.getState().sourceImage
      if (!sourceImage) return

      const b = asset.bounds
      if (asset.extractionMethod === 'circle') {
        const cx = (asset.extractionParams as { cx?: number }).cx ?? b.x + b.width / 2
        const cy = (asset.extractionParams as { cy?: number }).cy ?? b.y + b.height / 2
        const radius = (asset.extractionParams as { radius?: number }).radius ?? b.width / 2
        const result = await pythonClient.extractCircle(sourceImage.dataUrl, cx, cy, radius)
        commitMask(result.dataUrl, { bounds: result.bounds })
      } else {
        const result = await pythonClient.extractRect(sourceImage.dataUrl, b.x, b.y, b.width, b.height)
        commitMask(result.dataUrl, { bounds: result.bounds })
      }
    } catch (err) {
      console.error('Re-extraction failed:', err)
    }
  }, [asset, commitMask])

  const getCursor = () => {
    if (tool === 'brush') return 'crosshair'
    if (tool === 'eraser') return 'crosshair'
    if (tool === 'sam') return samBusy ? 'wait' : 'crosshair'
    if (tool === 'lasso') return 'crosshair'
    if (tool === 'center') return 'crosshair'
    if (tool === 'move') return isDragging.current ? 'grabbing' : 'grab'
    return 'default'
  }

  const tools: { id: EditorTool; label: string; icon: string; shortcut: string }[] = [
    { id: 'move', label: 'Move', icon: '⇄', shortcut: 'M' },
    { id: 'brush', label: 'Brush', icon: '🖌', shortcut: 'B' },
    { id: 'eraser', label: 'Eraser', icon: '◻', shortcut: 'E' },
    { id: 'sam', label: 'Re-cut', icon: '✦', shortcut: 'K' },
    { id: 'lasso', label: 'Lasso', icon: '⬚', shortcut: 'L' },
    { id: 'center', label: 'Center', icon: '⊕', shortcut: 'P' },
  ]

  return (
    <div className="flex flex-col gap-2 p-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-accent uppercase tracking-wide">Extraction Editor</span>
        <button
          onClick={handleReExtract}
          className="text-[9px] px-2 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
          title="Re-extract from source image with current bounds"
        >
          Re-extract
        </button>
      </div>

      {/* Tool bar */}
      <div className="flex gap-0.5 bg-surface-2 rounded p-0.5">
        {tools.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            className={`flex-1 px-1 py-1 text-[10px] rounded transition-colors ${
              tool === t.id
                ? 'bg-accent/20 text-accent'
                : 'text-muted hover:text-neutral-300 hover:bg-surface-3'
            }`}
            title={`${t.label} (${t.shortcut})`}
          >
            <span className="block text-sm">{t.icon}</span>
            <span className="block text-[8px]">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Mask undo / redo */}
      <div className="flex gap-0.5">
        <button
          onClick={undoMask}
          disabled={maskUndoRef.current.length === 0}
          className="flex-1 px-1 py-0.5 text-[9px] rounded text-muted enabled:hover:text-white enabled:hover:bg-surface-3 disabled:opacity-30 transition-colors"
          title="Undo mask edit (Ctrl+Z)"
        >
          ↶ Undo{maskUndoRef.current.length ? ` (${maskUndoRef.current.length})` : ''}
        </button>
        <button
          onClick={redoMask}
          disabled={maskRedoRef.current.length === 0}
          className="flex-1 px-1 py-0.5 text-[9px] rounded text-muted enabled:hover:text-white enabled:hover:bg-surface-3 disabled:opacity-30 transition-colors"
          title="Redo mask edit (Ctrl+Shift+Z)"
        >
          ↷ Redo{maskRedoRef.current.length ? ` (${maskRedoRef.current.length})` : ''}
        </button>
      </div>

      {/* Brush size slider */}
      {(tool === 'brush' || tool === 'eraser') && (
        <div className="flex items-center gap-2 px-1">
          <span className="text-[9px] text-muted w-8">Size</span>
          <input
            type="range"
            min={1}
            max={32}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="flex-1 h-1 accent-accent"
          />
          <span className="text-[9px] text-neutral-400 w-6 text-right">{brushSize}px</span>
        </div>
      )}

      {/* SAM re-cut hint */}
      {tool === 'sam' && (
        <div className="px-1">
          <span className="text-[9px] text-accent">
            {samBusy ? 'Segmenting…' : 'Click the element to re-cut it with SAM2'}
          </span>
        </div>
      )}

      {/* Lasso mode toggle */}
      {tool === 'lasso' && (
        <div className="flex items-center gap-1 px-1">
          <span className="text-[9px] text-muted mr-1">Draw to:</span>
          {(['add', 'subtract'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setLassoMode(m)}
              className={`text-[9px] px-2 py-0.5 rounded capitalize transition-colors ${
                lassoMode === m ? 'bg-accent/20 text-accent' : 'text-muted hover:text-neutral-300 hover:bg-surface-3'
              }`}
            >
              {m}
            </button>
          ))}
          <span className="text-[8px] text-neutral-600 ml-auto">drag around a region</span>
        </div>
      )}

      {/* Canvas viewport */}
      <div
        ref={containerRef}
        className="relative bg-surface-3 rounded border border-surface-4 overflow-auto"
        style={{ maxHeight: 280, cursor: getCursor() }}
        onWheel={handleWheel}
      >
        <div className="relative inline-block" style={{ transform: `translate(${offset.x * zoom}px, ${offset.y * zoom}px)` }}>
          <canvas
            ref={canvasRef}
            className="block"
            style={{ imageRendering: zoom >= 2 ? 'pixelated' : 'auto' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
          <canvas
            ref={overlayRef}
            className="absolute top-0 left-0 pointer-events-none"
          />
        </div>
      </div>

      {/* Zoom control */}
      <div className="flex items-center gap-2 px-1">
        <span className="text-[9px] text-muted">Zoom</span>
        <button onClick={() => setZoom((z) => Math.max(1, z - 1))} className="text-[10px] text-muted hover:text-white w-4 text-center">−</button>
        <span className="text-[10px] text-neutral-400 w-8 text-center">{zoom}x</span>
        <button onClick={() => setZoom((z) => Math.min(32, z + 1))} className="text-[10px] text-muted hover:text-white w-4 text-center">+</button>
        <button
          onClick={() => setShowGrid((v) => !v)}
          className={`ml-auto text-[9px] px-1.5 py-0.5 rounded ${showGrid ? 'bg-accent/20 text-accent' : 'text-muted hover:text-neutral-300'}`}
        >
          Grid
        </button>
      </div>

      {/* Bounds editor */}
      <div className="space-y-1">
        <span className="text-[9px] text-muted uppercase tracking-wide block px-1">Position & Size</span>
        <div className="grid grid-cols-4 gap-1">
          {(['x', 'y', 'width', 'height'] as const).map((field) => (
            <div key={field} className="flex flex-col">
              <span className="text-[8px] text-neutral-600 uppercase px-1">{field[0].toUpperCase()}</span>
              <input
                type="number"
                value={asset.bounds[field]}
                onChange={(e) => handleBoundsChange(field, e.target.value)}
                className="bg-surface-3 border border-surface-4 rounded px-1 py-0.5 text-[10px] text-neutral-300 w-full text-center focus:border-accent outline-none"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Pro edge refinement + SAM re-cut */}
      <RefineEdgePanel asset={asset} />

      {/* Center point (for knobs/buttons) */}
      {(asset.type === 'knob' || asset.type === 'button') && (
        <div className="space-y-1">
          <span className="text-[9px] text-muted uppercase tracking-wide block px-1">Center Point</span>
          <div className="grid grid-cols-2 gap-1">
            <div className="flex items-center gap-1 px-1">
              <span className="text-[8px] text-neutral-600">X</span>
              <input
                type="number"
                value={centerPoint.x}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v)) setCenterPoint((p) => ({ ...p, x: v }))
                }}
                className="bg-surface-3 border border-surface-4 rounded px-1 py-0.5 text-[10px] text-neutral-300 w-full text-center focus:border-accent outline-none"
              />
            </div>
            <div className="flex items-center gap-1 px-1">
              <span className="text-[8px] text-neutral-600">Y</span>
              <input
                type="number"
                value={centerPoint.y}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v)) setCenterPoint((p) => ({ ...p, y: v }))
                }}
                className="bg-surface-3 border border-surface-4 rounded px-1 py-0.5 text-[10px] text-neutral-300 w-full text-center focus:border-accent outline-none"
              />
            </div>
          </div>
          <p className="text-[8px] text-neutral-600 px-1">Click canvas with Center tool (P) to set</p>
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      <div className="text-[8px] text-neutral-600 px-1 space-y-0.5">
        <p>Arrow keys: nudge 1px (Shift: 10px)</p>
        <p>[ / ] : brush size · Scroll: zoom</p>
        <p>M: move · B: brush · E: eraser · K: re-cut · L: lasso · P: center</p>
      </div>
    </div>
  )
}
