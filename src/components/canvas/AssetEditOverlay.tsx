import { useRef, useState, useEffect, useCallback } from 'react'
import { useAssetStore } from '../../stores/assetStore'
import { useAssetEditStore } from '../../stores/assetEditStore'
import type { Asset } from '../../types'

/**
 * Full-viewport asset mask editing overlay.
 * Replaces the old 280px embedded ExtractionEditor canvas.
 * Renders when an asset is in edit mode (assetEditStore.editingAssetId !== null).
 */
export default function AssetEditOverlay() {
  // Only subscribe to the single field that gates rendering
  const editingAssetId = useAssetEditStore((s) => s.editingAssetId)
  if (!editingAssetId) return null
  return <AssetEditOverlayInner editingAssetId={editingAssetId} />
}

function AssetEditOverlayInner({ editingAssetId }: { editingAssetId: string }) {
  const editTool = useAssetEditStore((s) => s.editTool)
  const brushSize = useAssetEditStore((s) => s.brushSize)
  const editorZoom = useAssetEditStore((s) => s.editorZoom)
  const showGrid = useAssetEditStore((s) => s.showGrid)
  const setEditorZoom = useAssetEditStore((s) => s.setEditorZoom)

  const assets = useAssetStore((s) => s.assets)
  const updateAssetExtraction = useAssetStore((s) => s.updateAssetExtraction)
  const updateAssetBounds = useAssetStore((s) => s.updateAssetBounds)

  const asset = assets.find((a) => a.id === editingAssetId)
  if (!asset) return null

  return (
    <AssetEditCanvas
      key={asset.id}
      asset={asset}
      editTool={editTool}
      brushSize={brushSize}
      editorZoom={editorZoom}
      showGrid={showGrid}
      setEditorZoom={setEditorZoom}
      updateAssetExtraction={updateAssetExtraction}
      updateAssetBounds={updateAssetBounds}
    />
  )
}

interface CanvasProps {
  asset: Asset
  editTool: string
  brushSize: number
  editorZoom: number
  showGrid: boolean
  setEditorZoom: (z: number) => void
  updateAssetExtraction: (id: string, updates: { maskDataUrl?: string; bounds?: Partial<Asset['bounds']>; metadata?: Partial<Asset['metadata']> }) => void
  updateAssetBounds: (id: string, bounds: Partial<Asset['bounds']>) => void
}

function AssetEditCanvas({
  asset,
  editTool,
  brushSize,
  editorZoom: zoom,
  showGrid,
  setEditorZoom,
  updateAssetExtraction,
  updateAssetBounds,
}: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [centerPoint, setCenterPoint] = useState<{ x: number; y: number }>({
    x: asset.metadata.centerPoint?.x ?? Math.round(asset.bounds.width / 2),
    y: asset.metadata.centerPoint?.y ?? Math.round(asset.bounds.height / 2),
  })

  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const isPainting = useRef(false)
  const lastPaintPos = useRef<{ x: number; y: number } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })

  // Scroll offset for panning the canvas within the viewport
  const [scroll, setScroll] = useState({ x: 0, y: 0 })
  const isScrolling = useRef(false)
  const scrollStart = useRef({ x: 0, y: 0, sx: 0, sy: 0 })

  // Load mask image
  const imgRef = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    const img = new window.Image()
    img.onload = () => {
      imgRef.current = img
      drawCanvas()
    }
    img.src = asset.maskDataUrl
  }, [asset.maskDataUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset center point when asset changes
  useEffect(() => {
    setCenterPoint({
      x: asset.metadata.centerPoint?.x ?? Math.round(asset.bounds.width / 2),
      y: asset.metadata.centerPoint?.y ?? Math.round(asset.bounds.height / 2),
    })
  }, [asset.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fit zoom to fill the viewport
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const cw = container.clientWidth - 40
    const ch = container.clientHeight - 40
    const iw = asset.bounds.width || 100
    const ih = asset.bounds.height || 100
    const z = Math.min(cw / iw, ch / ih, 16)
    setEditorZoom(Math.max(1, Math.floor(z)))
  }, [asset.bounds.width, asset.bounds.height, setEditorZoom])

  // Center the canvas in the viewport
  useEffect(() => {
    const container = containerRef.current
    const img = imgRef.current
    if (!container || !img) return
    const cw = container.clientWidth
    const ch = container.clientHeight
    const canvasW = img.naturalWidth * zoom
    const canvasH = img.naturalHeight * zoom
    setScroll({
      x: Math.max(0, (cw - canvasW) / 2),
      y: Math.max(0, (ch - canvasH) / 2),
    })
  }, [zoom])

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
      ctx.fillStyle = '#f43f5e'
      ctx.beginPath()
      ctx.arc(cx, cy, 4, 0, Math.PI * 2)
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
    const mids = [
      [w * zoom / 2, 0], [w * zoom / 2, h * zoom],
      [0, h * zoom / 2], [w * zoom, h * zoom / 2],
    ]
    for (const [mx, my] of mids) {
      ctx.fillRect(mx - hs / 2, my - hs / 2, hs, hs)
    }

    // Brush cursor preview
    if (editTool === 'brush' || editTool === 'eraser') {
      ctx.strokeStyle = editTool === 'brush' ? '#6ee7b7' : '#f87171'
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
  }, [zoom, centerPoint, editTool, brushSize, asset.type])

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
    const img = imgRef.current
    if (!img) return

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
      octx.globalCompositeOperation = 'destination-in'
      const maskCanvas = document.createElement('canvas')
      maskCanvas.width = img.naturalWidth
      maskCanvas.height = img.naturalHeight
      const mctx = maskCanvas.getContext('2d')!
      mctx.drawImage(img, 0, 0)
      mctx.fillStyle = 'white'
      mctx.beginPath()
      mctx.arc(px, py, halfBrush, 0, Math.PI * 2)
      mctx.fill()
      octx.drawImage(maskCanvas, 0, 0)
      octx.globalCompositeOperation = 'source-over'
    }

    const newDataUrl = offscreen.toDataURL('image/png')
    const newImg = new window.Image()
    newImg.onload = () => {
      imgRef.current = newImg
      drawCanvas()
    }
    newImg.src = newDataUrl
  }, [brushSize, drawCanvas])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Middle-click or right-click for scrolling
    if (e.button === 1 || (e.button === 2 && editTool === 'move')) {
      isScrolling.current = true
      scrollStart.current = { x: e.clientX, y: e.clientY, sx: scroll.x, sy: scroll.y }
      e.preventDefault()
      return
    }

    const coords = getImageCoords(e)

    if (editTool === 'center') {
      const newCenter = { x: Math.round(coords.x), y: Math.round(coords.y) }
      setCenterPoint(newCenter)
      return
    }

    if (editTool === 'brush' || editTool === 'eraser') {
      isPainting.current = true
      lastPaintPos.current = coords
      paintPixel(coords.x, coords.y, editTool === 'eraser')
      return
    }

    if (editTool === 'move') {
      isDragging.current = true
      dragStart.current = { x: e.clientX, y: e.clientY }
      return
    }
  }, [editTool, getImageCoords, paintPixel, scroll])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isScrolling.current) {
      const dx = e.clientX - scrollStart.current.x
      const dy = e.clientY - scrollStart.current.y
      setScroll({
        x: scrollStart.current.sx + dx,
        y: scrollStart.current.sy + dy,
      })
      return
    }

    const coords = getImageCoords(e)

    if ((editTool === 'brush' || editTool === 'eraser') && isPainting.current) {
      const last = lastPaintPos.current
      if (last) {
        const dx = coords.x - last.x
        const dy = coords.y - last.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        const steps = Math.max(1, Math.ceil(dist))
        for (let i = 1; i <= steps; i++) {
          const t = i / steps
          paintPixel(last.x + dx * t, last.y + dy * t, editTool === 'eraser')
        }
      }
      lastPaintPos.current = coords
      return
    }

    if (editTool === 'move' && isDragging.current) {
      const dx = e.clientX - dragStart.current.x
      const dy = e.clientY - dragStart.current.y
      setOffset({ x: Math.round(dx / zoom), y: Math.round(dy / zoom) })
      return
    }

    // Track cursor for brush preview
    if (editTool === 'brush' || editTool === 'eraser') {
      lastPaintPos.current = coords
      drawOverlay()
    }
  }, [editTool, zoom, getImageCoords, paintPixel, drawOverlay])

  const handleMouseUp = useCallback(() => {
    isScrolling.current = false

    if ((editTool === 'brush' || editTool === 'eraser') && isPainting.current) {
      isPainting.current = false
      lastPaintPos.current = null
      const img = imgRef.current
      if (img) {
        const offscreen = document.createElement('canvas')
        offscreen.width = img.naturalWidth
        offscreen.height = img.naturalHeight
        const ctx = offscreen.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        updateAssetExtraction(asset.id, { maskDataUrl: offscreen.toDataURL('image/png') })
      }
    }

    if (editTool === 'move' && isDragging.current) {
      isDragging.current = false
      if (offset.x !== 0 || offset.y !== 0) {
        updateAssetBounds(asset.id, {
          x: asset.bounds.x + offset.x,
          y: asset.bounds.y + offset.y,
        })
        setOffset({ x: 0, y: 0 })
      }
    }
  }, [editTool, offset, asset.id, asset.bounds, updateAssetExtraction, updateAssetBounds])

  // Commit center point changes
  useEffect(() => {
    updateAssetExtraction(asset.id, {
      metadata: { centerPoint: { x: centerPoint.x, y: centerPoint.y } },
    })
  }, [centerPoint]) // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom on scroll
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
    if (e.deltaY < 0) {
      setEditorZoom(Math.min(32, zoom + 1))
    } else {
      setEditorZoom(Math.max(1, zoom - 1))
    }
  }, [zoom, setEditorZoom])

  const getCursor = () => {
    if (isScrolling.current) return 'grabbing'
    if (editTool === 'brush' || editTool === 'eraser' || editTool === 'center') return 'crosshair'
    if (editTool === 'move') return isDragging.current ? 'grabbing' : 'grab'
    return 'default'
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-20 bg-[#1a1a1a] overflow-hidden"
      style={{ cursor: getCursor() }}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Info bar at top */}
      <div className="absolute top-0 left-0 right-0 h-7 flex items-center justify-between px-3 bg-surface-2/90 border-b border-surface-4 z-30 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">Mask Editor</span>
          <span className="text-[10px] text-muted">{asset.name}</span>
          <span className="text-[10px] text-neutral-600">{asset.bounds.width}×{asset.bounds.height}px</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted">Zoom {zoom}×</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${showGrid ? 'bg-accent/20 text-accent' : 'text-neutral-600'}`}>
            Grid
          </span>
        </div>
      </div>

      {/* Canvas viewport */}
      <div
        className="absolute inset-0 top-7 overflow-hidden"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          className="relative inline-block"
          style={{
            transform: `translate(${scroll.x + offset.x * zoom}px, ${scroll.y + offset.y * zoom}px)`,
          }}
        >
          <canvas
            ref={canvasRef}
            className="block"
            style={{ imageRendering: zoom >= 2 ? 'pixelated' : 'auto' }}
          />
          <canvas
            ref={overlayRef}
            className="absolute top-0 left-0 pointer-events-none"
          />
        </div>
      </div>

      {/* Keyboard hints (bottom left) */}
      <div className="absolute bottom-3 left-3 z-30 text-[9px] text-neutral-600 space-y-0.5">
        <p>Arrows: nudge 1px (Shift: 10px) · Scroll: zoom</p>
        <p>M: move · B: brush · E: eraser · P: center · [ / ]: brush size</p>
        <p>Esc: close editor</p>
      </div>
    </div>
  )
}
