/**
 * @deprecated This is the legacy rule-based analyzer (Hough circles + contours).
 * It is no longer used. Use SemanticLayoutAnalyzer instead, which runs the
 * Gemini/YOLO/OpenCV → optional SAM2/RapidOCR pipeline with JUCE parameter export.
 *
 * LayoutAnalyzer — analyzes a plugin screenshot and exports a JSON file
 * containing precise positions and dimensions of every UI element.
 *
 * Usage: loaded from the Extract workspace toolbar (Analyze Layout button).
 *
 * Features:
 *  - Real-time progress panel (SSE streaming)
 *  - Perspective correction: auto-detect or manual 4-point selection
 *  - Detects knobs, sliders, buttons, LEDs, displays, text fields, labels
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { pythonClient, type UILayoutElement, type UILayoutResult, type PerspectiveCornersResult } from '../../lib/api/pythonClient'
import { useImageStore } from '../../stores/imageStore'

// ─── Color coding per element type ──────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  knob:       '#f59e0b',   // amber
  button:     '#3b82f6',   // blue
  slider:     '#10b981',   // emerald
  display:    '#8b5cf6',   // violet
  panel:      '#6b7280',   // gray
  label:      '#ec4899',   // pink
  led:        '#ef4444',   // red
  text_field: '#06b6d4',   // cyan
}
const typeColor = (t: string) => TYPE_COLORS[t] ?? '#94a3b8'

// ─── Progress stage labels ────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  decode:       'Decoding image',
  preprocess:   'Preprocessing',
  circles:      'Detecting knobs & buttons',
  color:        'Detecting LEDs & colored elements',
  frames:       'Detecting displays & panels',
  gradient:     'Detecting rotary elements',
  faders:       'Detecting sliders & faders',
  contours:     'Classifying shapes',
  text_fields:  'Detecting parameter text fields',
  labels:       'Detecting text labels',
  nms:          'Merging detections',
  finalize:     'Normalizing layout',
  ocr:          'Reading text labels',
  done:         'Complete',
}

// ─── Progress panel ──────────────────────────────────────────────────────────

function ProgressPanel({
  stage,
  percent,
  message,
  elapsed,
}: {
  stage: string
  percent: number
  message: string
  elapsed: number
}) {
  const stages = [
    'decode', 'preprocess', 'circles', 'color', 'frames',
    'gradient', 'faders', 'contours', 'text_fields', 'labels',
    'nms', 'finalize', 'ocr', 'done',
  ]
  const stageIdx = stages.indexOf(stage)

  return (
    <div className="space-y-3">
      {/* Big progress bar */}
      <div>
        <div className="flex justify-between mb-1">
          <span className="text-xs text-white/70">{message}</span>
          <span className="text-xs text-white/50 font-mono">{percent}%</span>
        </div>
        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-yellow-500 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Stage pipeline */}
      <div className="grid grid-cols-7 gap-1">
        {stages.slice(0, 7).map((s, i) => {
          const done = i < stageIdx
          const active = i === stageIdx
          return (
            <div key={s} className="flex flex-col items-center gap-0.5">
              <div className={`w-2 h-2 rounded-full transition-colors ${
                done ? 'bg-yellow-500' : active ? 'bg-yellow-400 animate-pulse' : 'bg-white/15'
              }`} />
              <span className={`text-[8px] text-center leading-tight truncate w-full ${
                done ? 'text-yellow-500/70' : active ? 'text-yellow-300' : 'text-white/25'
              }`}>
                {STAGE_LABELS[s]?.split(' ')[0]}
              </span>
            </div>
          )
        })}
      </div>

      {/* Elapsed */}
      <p className="text-[10px] text-white/30 text-right font-mono">
        {elapsed > 0 ? `${elapsed}s elapsed` : 'Starting…'}
      </p>
    </div>
  )
}

// ─── Stat badge ──────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="text-sm font-semibold text-white">{value}</span>
    </div>
  )
}

// ─── Element row in the table ─────────────────────────────────────────────────

function ElementRow({
  el,
  selected,
  onSelect,
}: {
  el: UILayoutElement
  selected: boolean
  onSelect: () => void
}) {
  const color = typeColor(el.type)
  return (
    <tr
      className={`cursor-pointer border-b border-white/5 transition-colors ${selected ? 'bg-accent-bg15' : 'hover:bg-white/5'}`}
      onClick={onSelect}
    >
      <td className="px-2 py-1">
        <span
          className="inline-block w-2 h-2 rounded-full mr-1"
          style={{ background: color }}
        />
        <span className="text-xs font-mono text-white/80">{el.id}</span>
      </td>
      <td className="px-2 py-1">
        <span className="text-xs" style={{ color }}>{el.type}</span>
        {el.sub_type && <span className="text-[10px] text-muted ml-1">/{el.sub_type}</span>}
      </td>
      <td className="px-2 py-1 text-xs text-muted font-mono">
        {el.bounds.x},{el.bounds.y}
      </td>
      <td className="px-2 py-1 text-xs text-muted font-mono">
        {el.bounds.width}×{el.bounds.height}
      </td>
      <td className="px-2 py-1 text-xs text-muted">
        {el.label ?? <span className="text-white/20">—</span>}
      </td>
      <td className="px-2 py-1 text-xs text-muted text-right">
        {Math.round(el.confidence * 100)}%
      </td>
    </tr>
  )
}

// ─── Shape-aware overlay primitives ──────────────────────────────────────────

function ShapeOutline({
  el, scaleX, scaleY, color, strokeW, isSelected,
}: {
  el: UILayoutElement; scaleX: number; scaleY: number
  color: string; strokeW: number; isSelected: boolean
}) {
  const dash = isSelected ? undefined : '4 2'
  const fillOpacity = isSelected ? 0.08 : 0
  const sd = el.shapeData
  const avgScale = (scaleX + scaleY) / 2

  if (el.shape === 'circle' && sd?.radius != null) {
    const cx = sd.cx * scaleX
    const cy = sd.cy * scaleY
    const r = sd.radius * avgScale
    return (
      <>
        <circle cx={cx} cy={cy} r={r}
          fill={color} fillOpacity={fillOpacity}
          stroke={color} strokeWidth={strokeW} strokeDasharray={dash} />
        {isSelected && (
          <>
            <line x1={cx - r * 0.18} y1={cy} x2={cx + r * 0.18} y2={cy}
              stroke={color} strokeWidth={1} opacity={0.6} />
            <line x1={cx} y1={cy - r * 0.18} x2={cx} y2={cy + r * 0.18}
              stroke={color} strokeWidth={1} opacity={0.6} />
          </>
        )}
      </>
    )
  }

  if (el.shape === 'ellipse' && sd?.rx != null && sd?.ry != null) {
    const cx = sd.cx * scaleX
    const cy = sd.cy * scaleY
    const rx = sd.rx * scaleX
    const ry = sd.ry * scaleY
    const angle = sd.angle ?? 0
    return (
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry}
        transform={angle !== 0 ? `rotate(${angle} ${cx} ${cy})` : undefined}
        fill={color} fillOpacity={fillOpacity}
        stroke={color} strokeWidth={strokeW} strokeDasharray={dash} />
    )
  }

  if (el.shape === 'rotated_rect' && sd?.w != null && sd?.h != null) {
    const cx = sd.cx * scaleX
    const cy = sd.cy * scaleY
    const rw = sd.w * scaleX
    const rh = sd.h * scaleY
    const angle = sd.angle ?? 0
    return (
      <rect
        x={cx - rw / 2} y={cy - rh / 2}
        width={rw} height={rh}
        transform={`rotate(${angle} ${cx} ${cy})`}
        fill={color} fillOpacity={fillOpacity}
        stroke={color} strokeWidth={strokeW} strokeDasharray={dash} />
    )
  }

  // Default: axis-aligned bounding rect
  const x = el.bounds.x * scaleX
  const y = el.bounds.y * scaleY
  const w = el.bounds.width * scaleX
  const h = el.bounds.height * scaleY
  return (
    <rect x={x} y={y} width={w} height={h}
      fill={color} fillOpacity={fillOpacity}
      stroke={color} strokeWidth={strokeW} strokeDasharray={dash} />
  )
}

// ─── Overlay canvas ───────────────────────────────────────────────────────────

function OverlayCanvas({
  layout, selectedId, naturalW, naturalH, displayW, displayH,
}: {
  layout: UILayoutResult; selectedId: string | null
  naturalW: number; naturalH: number; displayW: number; displayH: number
}) {
  const scaleX = displayW / naturalW
  const scaleY = displayH / naturalH

  return (
    <svg
      className="pointer-events-none"
      style={{ display: 'block', width: '100%', height: '100%' }}
      viewBox={`0 0 ${displayW} ${displayH}`}
      preserveAspectRatio="none"
    >
      {layout.elements.map((el) => {
        const color = typeColor(el.type)
        const isSelected = el.id === selectedId
        const strokeW = isSelected ? 2.5 : 1.5
        const opacity = isSelected ? 1.0 : 0.7
        const labelX = el.bounds.x * scaleX + 2
        const labelY = el.bounds.y * scaleY - 2

        return (
          <g key={el.id} opacity={opacity}>
            <ShapeOutline
              el={el} scaleX={scaleX} scaleY={scaleY}
              color={color} strokeW={strokeW} isSelected={isSelected}
            />
            <text x={labelX} y={labelY} fontSize={9} fill={color} fontFamily="monospace">
              {el.id}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ─── Perspective corner overlay ────────────────────────────────────────────────

function PerspectiveOverlay({
  corners,
  displayW,
  displayH,
  naturalW,
  naturalH,
  draggingIdx,
  onMouseDown,
}: {
  corners: [number, number][]
  displayW: number
  displayH: number
  naturalW: number
  naturalH: number
  draggingIdx: number | null
  onMouseDown: (idx: number) => void
}) {
  const sx = displayW / naturalW
  const sy = displayH / naturalH

  const pts = corners.map(([x, y]) => [x * sx, y * sy] as [number, number])
  const poly = pts.map((p) => p.join(',')).join(' ')

  return (
    <svg
      className="absolute inset-0"
      width={displayW}
      height={displayH}
      style={{ cursor: 'crosshair' }}
    >
      {/* Quad outline */}
      <polygon
        points={poly}
        fill="rgba(250,204,21,0.07)"
        stroke="#facc15"
        strokeWidth={1.5}
        strokeDasharray="6 3"
      />
      {/* Corner handles */}
      {pts.map(([px, py], i) => (
        <g key={i}>
          <circle
            cx={px} cy={py} r={10}
            fill="transparent"
            style={{ cursor: 'grab' }}
            onMouseDown={(e) => { e.stopPropagation(); onMouseDown(i) }}
          />
          <circle
            cx={px} cy={py} r={5}
            fill={draggingIdx === i ? '#facc15' : '#000'}
            stroke="#facc15"
            strokeWidth={2}
            style={{ pointerEvents: 'none' }}
          />
          <text x={px + 7} y={py - 5} fontSize={9} fill="#facc15" fontFamily="monospace">
            {['TL', 'TR', 'BR', 'BL'][i]}
          </text>
        </g>
      ))}
    </svg>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface LayoutAnalyzerProps {
  onClose: () => void
}

export default function LayoutAnalyzer({ onClose }: LayoutAnalyzerProps) {
  const { sourceImage, setSourceImage } = useImageStore()

  // Analysis state
  const [loading, setLoading]           = useState(false)
  const [layout, setLayout]             = useState<UILayoutResult | null>(null)
  const [error, setError]               = useState<string | null>(null)
  const [selectedId, setSelectedId]     = useState<string | null>(null)
  const [filterType, setFilterType]     = useState<string>('all')
  const [minConfidence, setMinConfidence] = useState(0.55)
  const [detectLabels, setDetectLabels] = useState(true)

  // Live progress (SSE)
  const [progressStage, setProgressStage]   = useState('')
  const [progressPct, setProgressPct]       = useState(0)
  const [progressMsg, setProgressMsg]       = useState('')
  const [elapsedSec, setElapsedSec]         = useState(0)
  const startedAtRef                         = useRef<number | null>(null)
  const abortRef                             = useRef<AbortController | null>(null)
  const timerRef                             = useRef<ReturnType<typeof setInterval> | null>(null)

  // Image display dimensions
  const imgRef = useRef<HTMLImageElement>(null)
  const [imgDisplaySize, setImgDisplaySize] = useState({ w: 0, h: 0 })

  // Perspective correction state
  const [perspMode, setPerspMode]           = useState<'off' | 'select' | 'correcting'>('off')
  const [perspCorners, setPerspCorners]     = useState<[number, number][]>([])
  const [draggingCornerIdx, setDraggingCornerIdx] = useState<number | null>(null)
  const [autoDetecting, setAutoDetecting]   = useState(false)
  const imgContainerRef                      = useRef<HTMLDivElement>(null)

  // ── Timer ──
  useEffect(() => {
    if (loading) {
      startedAtRef.current = Date.now()
      timerRef.current = setInterval(() => {
        if (startedAtRef.current != null) {
          setElapsedSec(Math.round((Date.now() - startedAtRef.current) / 1000))
        }
      }, 500)
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      setElapsedSec(0)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [loading])

  const handleImageLoad = useCallback(() => {
    if (imgRef.current) {
      setImgDisplaySize({ w: imgRef.current.clientWidth, h: imgRef.current.clientHeight })
    }
  }, [])

  // Re-measure when the image element is resized (window resize, panel resize)
  useEffect(() => {
    const el = imgRef.current
    if (!el) return
    // Measure immediately in case image was already loaded (cached dataUrl)
    if (el.complete && el.naturalWidth > 0) {
      setImgDisplaySize({ w: el.clientWidth, h: el.clientHeight })
    }
    const ro = new ResizeObserver(() => {
      setImgDisplaySize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [sourceImage?.dataUrl])

  // ── Analyze ──
  const handleAnalyze = useCallback(async () => {
    if (!sourceImage?.dataUrl) return
    setLoading(true)
    setError(null)
    setLayout(null)
    setSelectedId(null)
    setFilterType('all')
    setProgressStage('decode')
    setProgressPct(0)
    setProgressMsg('Starting…')

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    try {
      const result = await pythonClient.analyzeLayoutStream(
        sourceImage.dataUrl,
        { minConfidence, detectLabels },
        (stage, pct, msg) => {
          setProgressStage(stage)
          setProgressPct(pct)
          setProgressMsg(msg)
        },
        (_stage, partial) => {
          setLayout(partial)
        },
        abortRef.current.signal,
      )
      setLayout(result)
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sourceImage, minConfidence, detectLabels])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
    setLoading(false)
  }, [])

  // ── Export ──
  const handleExport = () => {
    if (!layout) return
    const json = JSON.stringify(layout, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'ui-layout.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Perspective: auto-detect corners ──
  const handleAutoDetectCorners = useCallback(async () => {
    if (!sourceImage?.dataUrl) return
    setAutoDetecting(true)
    try {
      const result: PerspectiveCornersResult = await pythonClient.detectPerspectiveCorners(sourceImage.dataUrl)
      setPerspCorners(result.corners as [number, number][])
      setPerspMode('select')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Corner detection failed')
    } finally {
      setAutoDetecting(false)
    }
  }, [sourceImage])

  // ── Perspective: start manual selection ──
  const handleStartPerspective = useCallback(() => {
    if (!sourceImage) return
    // Default to full image corners
    const w = layout?.imageWidth ?? sourceImage.width ?? 800
    const h = layout?.imageHeight ?? sourceImage.height ?? 600
    setPerspCorners([
      [w * 0.05, h * 0.05],
      [w * 0.95, h * 0.05],
      [w * 0.95, h * 0.95],
      [w * 0.05, h * 0.95],
    ])
    setPerspMode('select')
  }, [sourceImage, layout])

  // ── Perspective: apply correction ──
  const handleApplyPerspective = useCallback(async () => {
    if (!sourceImage?.dataUrl || perspCorners.length !== 4) return
    setPerspMode('correcting')
    setError(null)
    try {
      const result = await pythonClient.pipelinePerspectiveCorrect(
        sourceImage.dataUrl,
        perspCorners,
      )
      // Load the corrected image into an HTMLImageElement then register it
      const img = new window.Image()
      img.onload = () => {
        setSourceImage({
          id: sourceImage.id + '_corrected',
          path: sourceImage.path ?? '',
          dataUrl: result.dataUrl,
          width: result.bounds.width,
          height: result.bounds.height,
          htmlImage: img,
        })
        setLayout(null)
        setPerspCorners([])
        setPerspMode('off')
      }
      img.onerror = () => {
        setError('Failed to load corrected image')
        setPerspMode('select')
      }
      img.src = result.dataUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Perspective correction failed')
      setPerspMode('select')
    }
  }, [sourceImage, perspCorners, setSourceImage])

  // ── Perspective: drag corner ──
  const handleCornerDragStart = useCallback((idx: number) => {
    setDraggingCornerIdx(idx)
  }, [])

  useEffect(() => {
    if (draggingCornerIdx === null) return
    const onMove = (e: MouseEvent) => {
      const container = imgContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const naturalW = layout?.imageWidth ?? sourceImage?.width ?? 1
      const naturalH = layout?.imageHeight ?? sourceImage?.height ?? 1
      const displayW = imgRef.current?.clientWidth ?? rect.width
      const displayH = imgRef.current?.clientHeight ?? rect.height
      const offsetX = imgRef.current ? (rect.width - displayW) / 2 : 0
      const offsetY = imgRef.current ? (rect.height - displayH) / 2 : 0
      const px = Math.max(0, Math.min(displayW, e.clientX - rect.left - offsetX))
      const py = Math.max(0, Math.min(displayH, e.clientY - rect.top - offsetY))
      const nx = (px / displayW) * naturalW
      const ny = (py / displayH) * naturalH
      setPerspCorners((prev) => prev.map((c, i) => i === draggingCornerIdx ? [nx, ny] : c) as [number, number][])
    }
    const onUp = () => setDraggingCornerIdx(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [draggingCornerIdx, layout, sourceImage])

  // ── Filtered elements ──
  const filteredElements = layout
    ? filterType === 'all' ? layout.elements : layout.elements.filter((e) => e.type === filterType)
    : []

  const typeCounts = layout
    ? layout.elements.reduce<Record<string, number>>((acc, el) => {
        acc[el.type] = (acc[el.type] ?? 0) + 1
        return acc
      }, {})
    : {}

  const allTypes = Object.keys(typeCounts).sort()

  // ── Render ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-surface-1 border border-white/10 rounded-xl shadow-2xl w-[92vw] max-w-[1400px] h-[90vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#f59e0b" strokeWidth="1.5">
              <rect x="1" y="1" width="14" height="14" rx="1" />
              <line x1="5" y1="1" x2="5" y2="15" />
              <line x1="11" y1="1" x2="11" y2="15" />
              <line x1="1" y1="5" x2="15" y2="5" />
              <line x1="1" y1="11" x2="15" y2="11" />
            </svg>
            <span className="text-sm font-semibold text-white tracking-wide">Analyze Layout</span>
            {layout && (
              <span className="text-xs text-muted">
                {layout.imageWidth}×{layout.imageHeight}px · {layout.elementCount} elements
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors p-1">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="3" x2="13" y2="13" />
              <line x1="13" y1="3" x2="3" y2="13" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">

          {/* Left: image with overlay */}
          <div className="flex-1 relative overflow-hidden bg-surface-0 flex items-center justify-center">
            {sourceImage?.dataUrl ? (
              <div ref={imgContainerRef} className="relative max-w-full max-h-full flex items-center justify-center w-full h-full">
                <img
                  ref={imgRef}
                  src={sourceImage.dataUrl}
                  alt="Plugin screenshot"
                  className="max-w-full max-h-[calc(90vh-120px)] object-contain"
                  onLoad={handleImageLoad}
                  draggable={false}
                />
                {/* Detection overlay — must be centred exactly like the image (flex-centred inside container) */}
                {layout && imgDisplaySize.w > 0 && perspMode === 'off' && (
                  <div
                    className="absolute"
                    style={{
                      left: '50%',
                      top: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: imgDisplaySize.w,
                      height: imgDisplaySize.h,
                      pointerEvents: 'none',
                    }}
                  >
                    <OverlayCanvas
                      layout={layout}
                      selectedId={selectedId}
                      naturalW={layout.imageWidth}
                      naturalH={layout.imageHeight}
                      displayW={imgDisplaySize.w}
                      displayH={imgDisplaySize.h}
                    />
                  </div>
                )}
                {/* Perspective corner overlay */}
                {perspMode === 'select' && perspCorners.length === 4 && imgDisplaySize.w > 0 && (
                  <div
                    className="absolute"
                    style={{
                      left: '50%',
                      top: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: imgDisplaySize.w,
                      height: imgDisplaySize.h,
                    }}
                  >
                    <PerspectiveOverlay
                      corners={perspCorners}
                      displayW={imgDisplaySize.w}
                      displayH={imgDisplaySize.h}
                      naturalW={layout?.imageWidth ?? sourceImage.width ?? 800}
                      naturalH={layout?.imageHeight ?? sourceImage.height ?? 600}
                      draggingIdx={draggingCornerIdx}
                      onMouseDown={handleCornerDragStart}
                    />
                  </div>
                )}
                {/* Correcting spinner */}
                {perspMode === 'correcting' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <div className="text-center space-y-2">
                      <div className="w-8 h-8 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin mx-auto" />
                      <p className="text-xs text-yellow-400">Correcting perspective…</p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-muted text-sm">No image loaded. Load a plugin screenshot in the Extract workspace first.</div>
            )}
          </div>

          {/* Right: controls + table */}
          <div className="w-[420px] flex flex-col border-l border-white/10 overflow-hidden">

            {/* Controls */}
            <div className="p-3 border-b border-white/10 space-y-3 shrink-0">

              {/* Confidence + label toggle */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted w-28 shrink-0">Min confidence</label>
                <input
                  type="range" min={0.3} max={0.9} step={0.05}
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                  className="flex-1"
                />
                <span className="text-xs text-white w-8 text-right">{Math.round(minConfidence * 100)}%</span>
              </div>

              <label className="flex items-center justify-between gap-3 text-xs text-muted">
                <span>Detect text labels & param fields</span>
                <input
                  type="checkbox" checked={detectLabels}
                  onChange={(e) => setDetectLabels(e.target.checked)}
                  className="h-4 w-4 accent-yellow-500"
                />
              </label>

              {/* Analyze + Export buttons */}
              <div className="flex gap-2">
                <button
                  onClick={loading ? handleCancel : handleAnalyze}
                  disabled={!sourceImage?.dataUrl}
                  className={`flex-1 border text-xs font-semibold py-2 px-3 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    loading
                      ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
                      : 'bg-accent-bg15 hover:bg-accent-bg15/80 border-yellow-500/30 text-yellow-400'
                  }`}
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="8" cy="8" r="6" strokeDasharray="24" strokeDashoffset="8" />
                      </svg>
                      Cancel
                    </span>
                  ) : 'Analyze Layout'}
                </button>

                <button
                  onClick={handleExport}
                  disabled={!layout || loading}
                  title="Export JSON"
                  className="bg-surface-3 hover:bg-surface-4 border border-white/10 text-white px-3 py-2 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M8 2v8M5 7l3 3 3-3M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>

              {/* ── Perspective correction section ── */}
              <div className="border border-white/10 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-white/5">
                  <div className="flex items-center gap-2">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#60a5fa" strokeWidth="1.5">
                      <path d="M2 14L5 2l9 5-5 4-7 3z" />
                    </svg>
                    <span className="text-xs font-medium text-blue-400">Perspective Correction</span>
                  </div>
                  {perspMode !== 'off' && (
                    <button
                      onClick={() => { setPerspMode('off'); setPerspCorners([]) }}
                      className="text-[10px] text-white/40 hover:text-white/80"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                {perspMode === 'off' && (
                  <div className="flex gap-1.5 p-2">
                    <button
                      onClick={handleAutoDetectCorners}
                      disabled={!sourceImage?.dataUrl || autoDetecting}
                      className="flex-1 text-[11px] py-1.5 px-2 rounded bg-blue-500/10 border border-blue-500/25 text-blue-400 hover:bg-blue-500/20 disabled:opacity-40 transition-colors"
                    >
                      {autoDetecting ? (
                        <span className="flex items-center justify-center gap-1">
                          <svg className="animate-spin" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="8" cy="8" r="6" strokeDasharray="24" strokeDashoffset="8" />
                          </svg>
                          Detecting…
                        </span>
                      ) : 'Auto-detect Corners'}
                    </button>
                    <button
                      onClick={handleStartPerspective}
                      disabled={!sourceImage?.dataUrl}
                      className="flex-1 text-[11px] py-1.5 px-2 rounded bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-40 transition-colors"
                    >
                      Manual Select
                    </button>
                  </div>
                )}

                {perspMode === 'select' && (
                  <div className="p-2 space-y-2">
                    <p className="text-[10px] text-white/50 leading-relaxed">
                      Drag the 4 corner handles on the image to mark the panel edges, then apply.
                    </p>
                    <button
                      onClick={handleApplyPerspective}
                      className="w-full text-[11px] py-1.5 px-2 rounded bg-blue-500/20 border border-blue-500/40 text-blue-300 hover:bg-blue-500/30 transition-colors font-semibold"
                    >
                      Apply Correction
                    </button>
                  </div>
                )}
              </div>

              {/* Live progress */}
              {loading && (
                <div className="bg-white/5 rounded-lg p-3">
                  <ProgressPanel
                    stage={progressStage}
                    percent={progressPct}
                    message={progressMsg}
                    elapsed={elapsedSec}
                  />
                  {layout && (
                    <p className="mt-2 text-[11px] text-yellow-300/80 font-mono">
                      {layout.elementCount} elements discovered so far
                    </p>
                  )}
                </div>
              )}

              {error && (
                <div className="text-xs text-red-400 bg-red-400/10 rounded px-2 py-1">{error}</div>
              )}
            </div>

            {/* Stats row */}
            {layout && (
              <div className="px-3 py-2 border-b border-white/10 flex gap-4 shrink-0 flex-wrap">
                {allTypes.map((t) => (
                  <Stat key={t} label={t} value={typeCounts[t] ?? 0} />
                ))}
              </div>
            )}

            {/* Filter tabs */}
            {layout && allTypes.length > 0 && (
              <div className="flex gap-1 px-3 py-2 border-b border-white/10 flex-wrap shrink-0">
                <button
                  onClick={() => setFilterType('all')}
                  className={`text-[11px] px-2 py-0.5 rounded transition-colors ${filterType === 'all' ? 'bg-white/15 text-white' : 'text-muted hover:text-white'}`}
                >
                  All ({layout.elementCount})
                </button>
                {allTypes.map((t) => (
                  <button
                    key={t}
                    onClick={() => setFilterType(t)}
                    className={`text-[11px] px-2 py-0.5 rounded transition-colors ${filterType === t ? 'bg-white/15 text-white' : 'text-muted hover:text-white'}`}
                    style={{ color: filterType === t ? typeColor(t) : undefined }}
                  >
                    {t} ({typeCounts[t]})
                  </button>
                ))}
              </div>
            )}

            {/* Table */}
            <div className="flex-1 overflow-y-auto">
              {layout && filteredElements.length > 0 ? (
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-surface-2 z-10">
                    <tr className="text-[10px] text-muted uppercase tracking-wider">
                      <th className="px-2 py-1 text-left font-medium">ID</th>
                      <th className="px-2 py-1 text-left font-medium">Type</th>
                      <th className="px-2 py-1 text-left font-medium">XY</th>
                      <th className="px-2 py-1 text-left font-medium">Size</th>
                      <th className="px-2 py-1 text-left font-medium">Label</th>
                      <th className="px-2 py-1 text-right font-medium">Conf</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredElements.map((el) => (
                      <ElementRow
                        key={el.id}
                        el={el}
                        selected={selectedId === el.id}
                        onSelect={() => setSelectedId(selectedId === el.id ? null : el.id)}
                      />
                    ))}
                  </tbody>
                </table>
              ) : layout ? (
                <div className="text-muted text-sm text-center py-8">No elements match filter</div>
              ) : !loading ? (
                <div className="text-muted text-xs text-center py-12 px-6 leading-relaxed">
                  Click <strong className="text-white">Analyze Layout</strong> to detect all UI elements
                  — knobs, sliders, buttons, displays, text fields, and parameter readouts — with their
                  exact pixel positions.
                </div>
              ) : null}
            </div>

            {/* Selected element detail */}
            {selectedId && layout && (() => {
              const el = layout.elements.find(e => e.id === selectedId)
              if (!el) return null
              return (
                <div className="shrink-0 border-t border-white/10 p-3 bg-surface-2 text-[11px] font-mono text-white/70 space-y-1">
                  <div className="text-xs font-semibold text-white mb-2">{el.id}</div>
                  <div>x: <span className="text-white">{el.bounds.x}</span>  y: <span className="text-white">{el.bounds.y}</span></div>
                  <div>width: <span className="text-white">{el.bounds.width}</span>  height: <span className="text-white">{el.bounds.height}</span></div>
                  {el.radius != null && <div>radius: <span className="text-white">{el.radius}</span></div>}
                  <div>center: <span className="text-white">{el.center.x}, {el.center.y}</span></div>
                  {el.label && <div>label: <span className="text-yellow-300">"{el.label}"</span></div>}
                  <div>normalized: <span className="text-white/50">{el.normalizedBounds.x.toFixed(4)}, {el.normalizedBounds.y.toFixed(4)}</span></div>
                </div>
              )
            })()}
          </div>
        </div>
      </div>
    </div>
  )
}
