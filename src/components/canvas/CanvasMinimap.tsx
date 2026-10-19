import { useRef, useCallback, useState } from 'react'
import { useCanvasStore } from '../../stores/canvasStore'
import { useImageStore } from '../../stores/imageStore'
import { useAssetStore } from '../../stores/assetStore'

const MINIMAP_SIZE = 140
const MINIMAP_PADDING = 8

export default function CanvasMinimap({ viewportWidth, viewportHeight }: { viewportWidth: number; viewportHeight: number }) {
  const zoom = useCanvasStore((s) => s.zoom)
  const panX = useCanvasStore((s) => s.panX)
  const panY = useCanvasStore((s) => s.panY)
  const setPan = useCanvasStore((s) => s.setPan)
  const animateTo = useCanvasStore((s) => s.animateTo)
  const sourceImage = useImageStore((s) => s.sourceImage)
  const assets = useAssetStore((s) => s.assets)
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Calculate minimap scale
  const imgW = sourceImage?.width ?? 1
  const imgH = sourceImage?.height ?? 1
  const scale = Math.min(
    (MINIMAP_SIZE - MINIMAP_PADDING * 2) / imgW,
    (MINIMAP_SIZE - MINIMAP_PADDING * 2) / imgH,
  )
  const mapW = imgW * scale
  const mapH = imgH * scale

  // Viewport rect in minimap coordinates
  const vpLeft = (-panX / zoom) * scale
  const vpTop = (-panY / zoom) * scale
  const vpW = (viewportWidth / zoom) * scale
  const vpH = (viewportHeight / zoom) * scale

  const navigateToPoint = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current || !sourceImage) return
    const rect = containerRef.current.getBoundingClientRect()
    // Position clicked in minimap local coords
    const mx = clientX - rect.left - MINIMAP_PADDING
    const my = clientY - rect.top - MINIMAP_PADDING
    // Convert to image coordinates
    const imgX = mx / scale
    const imgY = my / scale
    // Center viewport on that point
    const newPanX = viewportWidth / 2 - imgX * zoom
    const newPanY = viewportHeight / 2 - imgY * zoom
    setPan(newPanX, newPanY)
  }, [sourceImage, scale, zoom, viewportWidth, viewportHeight, setPan])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
    navigateToPoint(e.clientX, e.clientY)
  }, [navigateToPoint])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    navigateToPoint(e.clientX, e.clientY)
  }, [isDragging, navigateToPoint])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Double-click to fit-to-screen
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!sourceImage) return
    const padding = 60
    const scaleX = (viewportWidth - padding * 2) / sourceImage.width
    const scaleY = (viewportHeight - padding * 2) / sourceImage.height
    const newZoom = Math.min(scaleX, scaleY, 1)
    animateTo({
      zoom: newZoom,
      panX: (viewportWidth - sourceImage.width * newZoom) / 2,
      panY: (viewportHeight - sourceImage.height * newZoom) / 2,
    }, 300)
  }, [sourceImage, viewportWidth, viewportHeight, animateTo])

  if (!sourceImage) return null

  return (
    <div
      ref={containerRef}
      className="absolute bottom-10 left-2 z-20 rounded-lg border border-surface-4/60 bg-surface-1/85 backdrop-blur-sm shadow-lg overflow-hidden select-none"
      style={{ width: mapW + MINIMAP_PADDING * 2, height: mapH + MINIMAP_PADDING * 2 }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      title="Minimap — Click to navigate, double-click to fit"
    >
      <div style={{ position: 'relative', left: MINIMAP_PADDING, top: MINIMAP_PADDING, width: mapW, height: mapH }}>
        {/* Image thumbnail */}
        <img
          src={sourceImage.dataUrl}
          alt=""
          draggable={false}
          style={{ width: mapW, height: mapH, display: 'block', borderRadius: 2, opacity: 0.6 }}
        />

        {/* Asset dots */}
        {assets.map((a) => (
          <div
            key={a.id}
            style={{
              position: 'absolute',
              left: a.bounds.x * scale,
              top: a.bounds.y * scale,
              width: Math.max(3, a.bounds.width * scale),
              height: Math.max(3, a.bounds.height * scale),
              border: '1px solid rgba(245,166,35,0.7)',
              borderRadius: 1,
              pointerEvents: 'none',
            }}
          />
        ))}

        {/* Viewport indicator */}
        <div
          style={{
            position: 'absolute',
            left: vpLeft,
            top: vpTop,
            width: vpW,
            height: vpH,
            border: '1.5px solid rgba(96,165,250,0.8)',
            borderRadius: 2,
            backgroundColor: 'rgba(96,165,250,0.08)',
            pointerEvents: 'none',
            transition: isDragging ? 'none' : 'all 0.1s ease-out',
          }}
        />
      </div>
    </div>
  )
}
