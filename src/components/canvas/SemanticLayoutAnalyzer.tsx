/**
 * SemanticLayoutAnalyzer — canvas portion only.
 * Renders the plugin screenshot with live overlay (masks / boxes / labels)
 * and zoom/pan controls.  All detection controls and results tree live in
 * AnalyzerInspector, mounted in the right Inspector panel.
 */
import { useCallback, useEffect, useRef } from 'react'
import { pythonClient } from '../../lib/api/pythonClient'
import { useImageStore } from '../../stores/imageStore'
import { usePanelLayoutStore } from '../../stores/panelLayoutStore'
import { useSemanticAnalyzerStore } from '../../stores/semanticAnalyzerStore'
import PanelOverlay from './PanelOverlay'
import PanelEditToolbar from './PanelEditToolbar'

export interface SemanticLayoutAnalyzerProps {
  onClose: () => void
  inline?: boolean
}

export default function SemanticLayoutAnalyzer({ onClose: onCloseProp }: SemanticLayoutAnalyzerProps) {
  const onClose = useCallback(() => {
    pythonClient.panelClearModels().catch(() => {})
    onCloseProp()
  }, [onCloseProp])

  const { sourceImage } = useImageStore()
  const openImage         = useImageStore((s) => s.openImage)
  const layout            = usePanelLayoutStore((s) => s.layout)
  const setLayout         = usePanelLayoutStore((s) => s.setLayout)
  const mergeLayout       = usePanelLayoutStore((s) => s.mergeLayout)
  const editMode          = usePanelLayoutStore((s) => s.editMode)
  const updateControlBbox = usePanelLayoutStore((s) => s.updateControlBbox)

  const st = useSemanticAnalyzerStore
  const loading          = st((s) => s.loading)
  const analyzeRequestId = st((s) => s.analyzeRequestId)
  const cancelRequested  = st((s) => s.cancelRequested)
  const zoom    = st((s) => s.zoom)
  const pan     = st((s) => s.pan)
  const imgSize = st((s) => s.imgSize)

  const setLoading  = st((s) => s.setLoading)
  const setError    = st((s) => s.setError)
  const setCaps     = st((s) => s.setCaps)
  const setProgress = st((s) => s.setProgress)
  const setElapsed  = st((s) => s.setElapsed)
  const setImgSize  = st((s) => s.setImgSize)
  const clearCancel = st((s) => s.clearCancel)
  const setZoom     = st((s) => s.setZoom)
  const setPan      = st((s) => s.setPan)
  const resetView   = st((s) => s.resetView)

  const abortRef = useRef<AbortController | null>(null)
  const startRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const imgRef   = useRef<HTMLImageElement>(null)

  // ── Capabilities on mount ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const fetchCaps = () => pythonClient.panelCapabilities()
      .then((c) => { if (!cancelled) setCaps(c) })
      .catch(() => { if (!cancelled) setCaps(null) })

    fetchCaps()

    // Re-fetch after 5 s to pick up the background Gemini probe result.
    // The probe takes ≤ 6 s per candidate so by 5 s the first model should
    // have answered, and gemini_probe_ok will be accurate.
    const retryTimer = setTimeout(fetchCaps, 5000)
    return () => { cancelled = true; clearTimeout(retryTimer) }
  }, [setCaps])

  // Adopt a server-rectified panel as the working document (perspective photos).
  // Coordinates then live in rectified space, so we replace rather than merge.
  const adoptRectifiedImage = useCallback((dataUrl: string, baseName: string) => {
    return new Promise<void>((resolve) => {
      const img = new window.Image()
      img.onload = () => {
        openImage({
          id: crypto.randomUUID(),
          path: `${baseName} (rectified)`,
          width: img.naturalWidth,
          height: img.naturalHeight,
          dataUrl,
          htmlImage: img,
        })
        resolve()
      }
      img.onerror = () => resolve()
      img.src = dataUrl
    })
  }, [openImage])

  // Apply an analysis result, honouring rectification + non-clobbering merge.
  const applyResult = useCallback(async (result: Awaited<ReturnType<typeof pythonClient.analyzePanel>>) => {
    const rect = result.rectification
    if (rect?.applied && rect.image_b64) {
      await adoptRectifiedImage(rect.image_b64, sourceImage?.path ?? 'panel')
      setLayout(result)   // rectified-space coords → replace, don't merge
      return
    }
    const panel = usePanelLayoutStore.getState()
    const hasUserEdits = !!panel.layout && (
      panel.dirtyControlIds.size > 0 ||
      panel.layout.controls.some((c) => c.provenance === 'user')
    )
    if (hasUserEdits) {
      const { dropped, preserved } = mergeLayout(result)
      if (preserved > 0) {
        setProgress('done', 100, `Merged: kept ${preserved} of your edits, dropped ${dropped} overlapping detections`)
      }
    } else {
      setLayout(result)
    }
  }, [adoptRectifiedImage, mergeLayout, setLayout, setProgress, sourceImage?.path])

  // ── Analysis logic ───────────────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (!sourceImage?.dataUrl) return
    setLoading(true)
    setError(null)
    // Keep an existing edited layout in place so a re-run can merge into it;
    // only clear when there is nothing worth preserving.
    const panelNow = usePanelLayoutStore.getState()
    const preserveForMerge = !!panelNow.layout && (
      panelNow.dirtyControlIds.size > 0 ||
      panelNow.layout.controls.some((c) => c.provenance === 'user')
    )
    if (!preserveForMerge) setLayout(null)
    setProgress('decode', 0, 'Starting…')

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    startRef.current = Date.now()
    timerRef.current = setInterval(() => {
      if (startRef.current) setElapsed(Math.round((Date.now() - startRef.current) / 1000))
    }, 500)

    try {
      const snap = useSemanticAnalyzerStore.getState()
      if (snap.useStream) {
        const result = await pythonClient.analyzePanelStream(
          sourceImage.dataUrl,
          {
            minConfidence: snap.minConfidence,
            detectLabels: snap.detectLabels,
            segment: true,
            extractFeatures: true,
            fastMode: snap.fastMode,
            detectionModel: snap.detectionModel,
          },
          (stage, pct, msg) => setProgress(stage, pct, msg),
          abortRef.current.signal,
        )
        await applyResult(result)
      } else {
        const result = await pythonClient.analyzePanel(sourceImage.dataUrl, {
          minConfidence: snap.minConfidence,
          detectLabels: snap.detectLabels,
          segment: true,
          extractFeatures: true,
          fastMode: snap.fastMode,
          detectionModel: snap.detectionModel,
        })
        await applyResult(result)
      }
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      startRef.current = null
      setLoading(false)
      setElapsed(0)
    }
  }, [sourceImage, setLoading, setError, setLayout, setProgress, setElapsed, applyResult])

  // Watch analyze trigger from Inspector
  useEffect(() => {
    if (analyzeRequestId === 0) return
    handleAnalyze()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzeRequestId])

  // Watch cancel trigger from Inspector
  useEffect(() => {
    if (!cancelRequested) return
    abortRef.current?.abort()
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setLoading(false)
    setElapsed(0)
    clearCancel()
  }, [cancelRequested, setLoading, setElapsed, clearCancel])

  // Cleanup on unmount
  useEffect(() => () => {
    abortRef.current?.abort()
    if (timerRef.current) clearInterval(timerRef.current)
  }, [])

  // ── Image size measurement ───────────────────────────────────────────────
  const handleImageLoad = useCallback(() => {
    if (imgRef.current) setImgSize({ w: imgRef.current.clientWidth, h: imgRef.current.clientHeight })
  }, [setImgSize])

  useEffect(() => {
    const el = imgRef.current
    if (!el) return
    if (el.complete && el.naturalWidth > 0) setImgSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(() => {
      if (el) setImgSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [sourceImage?.dataUrl, setImgSize])

  // ── Re-segment ───────────────────────────────────────────────────────────
  const handleResegment = useCallback(async (controlId: string, bbox: [number, number, number, number]) => {
    if (!sourceImage?.dataUrl) return
    try {
      const r = await pythonClient.panelResegment(sourceImage.dataUrl, bbox)
      if (r.mask_png) {
        const layoutNow = usePanelLayoutStore.getState().layout
        if (!layoutNow) return
        const controls = layoutNow.controls.map((c) =>
          c.id === controlId ? { ...c, mask_png: r.mask_png, mask_bbox: r.mask_bbox ?? null, circle: r.circle ?? c.circle, bbox, refined_bbox: r.refined_bbox ?? bbox } : c,
        )
        usePanelLayoutStore.setState({ layout: { ...layoutNow, controls } })
      }
    } catch (e) { console.error('Re-segment failed', e) }
    void updateControlBbox
  }, [sourceImage?.dataUrl, updateControlBbox])

  // ── Zoom / Pan ───────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const isPanning    = useRef(false)
  const panStart     = useRef({ x: 0, y: 0, px: 0, py: 0 })
  const spaceHeld    = useRef(false)

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    setZoom((z) => Math.max(0.25, Math.min(20, z * (e.deltaY > 0 ? 0.9 : 1.1))))
  }, [setZoom])

  const handleMiddleDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
      e.preventDefault()
      isPanning.current = true
      panStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
      const onMove = (ev: MouseEvent) => {
        if (!isPanning.current) return
        setPan({ x: panStart.current.px + (ev.clientX - panStart.current.x), y: panStart.current.py + (ev.clientY - panStart.current.y) })
      }
      const onUp = () => { isPanning.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
  }, [pan, setPan])

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) spaceHeld.current = true }
    const up   = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeld.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  const natW = layout?.imageWidth ?? sourceImage?.width ?? 0
  const natH = layout?.imageHeight ?? sourceImage?.height ?? 0

  return (
    <div className="absolute inset-0 bg-surface-0 flex flex-col overflow-hidden">
      {/* Close button — top-right */}
      <div className="absolute top-2 right-2 z-30">
        <button
          onClick={onClose}
          className="p-1.5 rounded bg-black/40 border border-white/10 text-white/60 hover:text-white hover:bg-black/60 transition-colors backdrop-blur-sm"
          title="Close panel analyzer"
          aria-label="Close"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="3" x2="13" y2="13" /><line x1="13" y1="3" x2="3" y2="13" />
          </svg>
        </button>
      </div>

      {/* Full-screen canvas area */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden flex items-center justify-center"
        onWheel={handleWheel}
        onMouseDown={handleMiddleDown}
        style={{ cursor: isPanning.current ? 'grabbing' : spaceHeld.current ? 'grab' : undefined }}
      >
        {/* Zoom controls — bottom-left */}
        <div className="absolute bottom-2 left-2 z-20 flex items-center gap-1 rounded-md bg-black/70 border border-white/10 px-2 py-1 backdrop-blur-sm select-none">
          <button onClick={() => setZoom((z) => Math.max(0.25, z / 1.3))} className="text-white/70 hover:text-white text-xs px-1">−</button>
          <button onClick={resetView} className="text-[10px] text-white/50 hover:text-white font-mono px-1 min-w-[3rem] text-center">{Math.round(zoom * 100)}%</button>
          <button onClick={() => setZoom((z) => Math.min(20, z * 1.3))} className="text-white/70 hover:text-white text-xs px-1">+</button>
          <button onClick={resetView} className="text-[10px] text-white/40 hover:text-white px-1" title="Fit to view">⊡</button>
        </div>

        {editMode && layout && <PanelEditToolbar />}

        {sourceImage?.dataUrl ? (
          <div
            className="relative flex items-center justify-center"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              transition: isPanning.current ? 'none' : 'transform 0.1s ease-out',
            }}
          >
            <img
              ref={imgRef}
              src={sourceImage.dataUrl}
              alt="Panel screenshot"
              className="max-w-full max-h-full object-contain"
              style={{ imageRendering: zoom > 3 ? 'pixelated' : 'auto' }}
              onLoad={handleImageLoad}
              draggable={false}
            />
            {layout && imgSize.w > 0 && (
              <div className="absolute" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: imgSize.w, height: imgSize.h }}>
                <PanelOverlay
                  naturalW={natW} naturalH={natH}
                  displayW={imgSize.w} displayH={imgSize.h}
                  onResegment={handleResegment}
                />
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500 text-center px-8">
            No image loaded — load a plugin screenshot in the Extract workspace first.
          </p>
        )}

        {/* Loading badge */}
        {loading && (
          <div className="absolute top-2 left-2 z-20 flex items-center gap-2 rounded-md bg-black/75 border border-white/10 px-3 py-1.5 backdrop-blur-sm">
            <svg className="animate-spin w-3 h-3 text-yellow-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
            </svg>
            <span className="text-[11px] text-yellow-400 font-medium">Analyzing…</span>
          </div>
        )}
      </div>
    </div>
  )
}
