/**
 * ExtractWorkflow — the primary Extract workspace center panel.
 *
 * Replaces the floating wizard with an embedded step-by-step experience:
 *   Empty   → drop zone to import the panel image
 *   Ready   → image preview + "Detect Elements" button
 *   Working → inline progress bar during AI analysis
 *   Done    → visual thumbnail grid of ALL detected elements
 *             + Accept-All + per-element triage + Export Bundle
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useImageStore, type LoadedImage } from '../../stores/imageStore'
import { usePanelLayoutStore, type PanelControlType } from '../../stores/panelLayoutStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { pythonClient, type PanelControl } from '../../lib/api/pythonClient'
import {
  mergePlacedIntoManifest, sceneFromManifest,
  buildHandoffReadme, assembleHandoffFiles, filesToZip,
} from '../../lib/export/handoff'
import { generateReactComponent } from '../../lib/export/reactFromLayout'
import { u8ToBase64 } from '../../lib/export/zip'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Crop every control's bbox from the panel image in a single image-load. */
async function cropAllControls(
  panelDataUrl: string,
  controls: PanelControl[],
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const out: Record<string, string> = {}
      for (const c of controls) {
        const [x1, y1, x2, y2] = c.bbox
        const w = Math.max(1, x2 - x1)
        const h = Math.max(1, y2 - y1)
        const maxDim = 200
        const scale = Math.min(maxDim / w, maxDim / h, 1)
        const tw = Math.max(1, Math.round(w * scale))
        const th = Math.max(1, Math.round(h * scale))
        const canvas = document.createElement('canvas')
        canvas.width = tw
        canvas.height = th
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, x1, y1, w, h, 0, 0, tw, th)
        out[c.id] = canvas.toDataURL('image/png')
      }
      resolve(out)
    }
    img.onerror = reject
    img.src = panelDataUrl
  })
}

/** Agent prompt for interactivity implementation. */
function buildAgentPrompt(opts: {
  width: number; height: number; detectedCount: number; filePath: string
}): string {
  return `SynthSkin Studio handoff bundle — audio plugin panel UI

Panel: ${opts.width} × ${opts.height}px  |  Elements: ${opts.detectedCount}
Bundle: ${opts.filePath}

Contents:
  Panel.tsx              — React component, ready to extend
  layout.json            — every element's [x,y,w,h], type, rotation, z-order
  assets/<id>.png        — transparent de-haloed PNG per element
  background/
    background_punched.png  — panel with transparent RGBA holes where controls sit
    background_filled.png   — clean inpainted base plate
  README_FOR_CLAUDE.md   — full interactivity code examples per control type

Coordinate contract:
  rect = [x, y, width, height] in panel pixels, origin top-left
  rotation = degrees clockwise about element centre

Task: implement interactivity per README_FOR_CLAUDE.md —
  knobs rotate on vertical drag, faders slide, buttons toggle, displays animate.`
}

// ─── Type colour map ──────────────────────────────────────────────────────────

const TYPE_PILL: Record<string, string> = {
  knob:    'bg-amber-500/20 text-amber-300 border-amber-500/25',
  slider:  'bg-blue-500/20 text-blue-300 border-blue-500/25',
  fader:   'bg-cyan-500/20 text-cyan-300 border-cyan-500/25',
  button:  'bg-green-500/20 text-green-300 border-green-500/25',
  switch:  'bg-teal-500/20 text-teal-300 border-teal-500/25',
  led:     'bg-red-500/20 text-red-300 border-red-500/25',
  screen:  'bg-purple-500/20 text-purple-300 border-purple-500/25',
  display: 'bg-violet-500/20 text-violet-300 border-violet-500/25',
  meter:   'bg-orange-500/20 text-orange-300 border-orange-500/25',
  label:   'bg-neutral-500/20 text-neutral-400 border-neutral-500/25',
}
const TYPE_PILL_DEFAULT = 'bg-surface-3 text-neutral-400 border-surface-5'

const RETYPE_OPTIONS: PanelControlType[] = [
  'knob', 'slider', 'slider_cap', 'button', 'switch', 'led', 'screen', 'label',
]

// ─── Element card ─────────────────────────────────────────────────────────────

function ElementCard({
  control, thumbnail, accepted, confidence,
  onAccept, onRemove, onRetype,
}: {
  control: PanelControl
  thumbnail: string | null
  accepted: boolean
  confidence: number
  onAccept: () => void
  onRemove: () => void
  onRetype: (t: PanelControlType) => void
}) {
  const [showTypes, setShowTypes] = useState(false)
  const flagged = !accepted && confidence < 65
  const highConf = confidence >= 85

  const borderColor = accepted
    ? 'border-green-500/30'
    : flagged
      ? 'border-red-500/30'
      : 'border-surface-4'

  return (
    <div className={`rounded-xl border ${borderColor} bg-surface-2/60 overflow-hidden flex flex-col transition-all group`}>
      {/* Thumbnail */}
      <div className="relative h-24 flex items-center justify-center bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#151515_0%_50%)_50%_/10px_10px] overflow-hidden">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={control.display_name}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        ) : (
          <div className="text-muted/30 text-[10px]">…</div>
        )}

        {/* Accepted badge */}
        {accepted && (
          <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-green-500/80 flex items-center justify-center">
            <span className="text-[8px] text-white font-bold">✓</span>
          </div>
        )}

        {/* Confidence */}
        <div className={`absolute bottom-1 right-1 text-[8px] font-mono px-1 py-0.5 rounded ${
          highConf ? 'bg-green-500/20 text-green-400' :
          confidence >= 65 ? 'bg-yellow-500/20 text-yellow-400' :
          'bg-red-500/20 text-red-400'
        }`}>
          {confidence}%
        </div>
      </div>

      {/* Info */}
      <div className="px-2 py-1.5 flex-1 min-w-0">
        <p className="text-[10px] font-medium text-neutral-200 truncate leading-tight">{control.display_name}</p>
        <span className={`inline-block text-[8px] px-1 py-0.5 rounded border mt-0.5 ${TYPE_PILL[control.type] ?? TYPE_PILL_DEFAULT}`}>
          {control.type}
        </span>
      </div>

      {/* Actions — visible on hover */}
      <div className="px-2 pb-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!accepted && (
          <button
            onClick={onAccept}
            className="flex-1 text-[8px] py-0.5 rounded bg-green-500/15 text-green-300 hover:bg-green-500/25"
          >
            ✓
          </button>
        )}
        <button
          onClick={() => setShowTypes(v => !v)}
          className="flex-1 text-[8px] py-0.5 rounded bg-surface-3 text-neutral-400 hover:bg-surface-4"
        >
          Type
        </button>
        <button
          onClick={onRemove}
          className="flex-1 text-[8px] py-0.5 rounded bg-red-500/12 text-red-400 hover:bg-red-500/22"
        >
          ✕
        </button>
      </div>

      {/* Retype dropdown */}
      {showTypes && (
        <div className="px-2 pb-2 flex flex-wrap gap-1">
          {RETYPE_OPTIONS.map(t => (
            <button
              key={t}
              onClick={() => { onRetype(t); setShowTypes(false) }}
              className="text-[8px] px-1.5 py-0.5 rounded bg-surface-3 text-neutral-300 hover:bg-surface-4 transition-colors"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ExtractWorkflow() {
  const sourceImage       = useImageStore((s) => s.sourceImage)
  const openImage         = useImageStore((s) => s.openImage)
  const layout            = usePanelLayoutStore((s) => s.layout)
  const setLayout         = usePanelLayoutStore((s) => s.setLayout)
  const acceptControl     = usePanelLayoutStore((s) => s.acceptControl)
  const deleteControl     = usePanelLayoutStore((s) => s.deleteControl)
  const changeControlType = usePanelLayoutStore((s) => s.changeControlType)
  const acceptAllHC       = usePanelLayoutStore((s) => s.acceptAllHighConfidence)
  const openPanelAnalyzer = useWorkspaceStore((s) => s.openPanelAnalyzer)
  const openPunchEdit     = useWorkspaceStore((s) => s.openPunchEdit)

  // ── Detection ──
  const [detecting, setDetecting] = useState(false)
  const [detectPct, setDetectPct] = useState(0)
  const [detectMsg, setDetectMsg] = useState('')
  const [detectError, setDetectError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // ── Thumbnails ──
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [thumbsLoading, setThumbsLoading] = useState(false)

  // ── Export ──
  const [exporting, setExporting]       = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [exportError, setExportError]   = useState<string | null>(null)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [copyFlash, setCopyFlash]       = useState(false)
  const [acceptFlash, setAcceptFlash]   = useState<number | null>(null)

  // ── Drop zone ──
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Image import ──────────────────────────────────────────────────────────

  const loadFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      const img = new window.Image()
      img.onload = () => {
        openImage({
          id: `img-${Date.now()}`,
          path: file.name,
          width: img.naturalWidth,
          height: img.naturalHeight,
          dataUrl,
          htmlImage: img,
        } satisfies LoadedImage)
        setLayout(null)
        setThumbs({})
        setExportedPath(null)
        setDetectError(null)
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }, [openImage, setLayout])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file && file.type.startsWith('image/')) loadFile(file)
  }, [loadFile])

  // ── Detection ──────────────────────────────────────────────────────────────

  const runDetection = useCallback(async () => {
    if (!sourceImage?.dataUrl) return
    setDetecting(true)
    setDetectError(null)
    setDetectPct(0)
    setDetectMsg('Starting analysis…')
    setThumbs({})

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    try {
      const result = await pythonClient.analyzePanelStream(
        sourceImage.dataUrl,
        { minConfidence: 0.40, detectLabels: true },
        (_stage, pct, msg) => { setDetectPct(pct); setDetectMsg(msg) },
        abortRef.current.signal,
      )
      setLayout(result)
    } catch (e) {
      if (e instanceof Error && (e.name === 'AbortError' || e.message.includes('aborted'))) return
      setDetectError(e instanceof Error ? e.message : 'Detection failed — is the Python sidecar running?')
    } finally {
      setDetecting(false)
    }
  }, [sourceImage?.dataUrl, setLayout])

  // Generate thumbnails whenever layout changes
  useEffect(() => {
    if (!layout || !sourceImage?.dataUrl || layout.controls.length === 0) return
    setThumbsLoading(true)
    cropAllControls(sourceImage.dataUrl, layout.controls)
      .then(setThumbs)
      .catch(() => {})
      .finally(() => setThumbsLoading(false))
  }, [layout?.controls.length, sourceImage?.dataUrl]) // eslint-disable-line

  useEffect(() => () => { abortRef.current?.abort() }, [])

  // ── Derived ────────────────────────────────────────────────────────────────

  const typeCounts = useMemo(() => {
    if (!layout) return {} as Record<string, number>
    return layout.controls.reduce((acc, c) => {
      acc[c.type] = (acc[c.type] ?? 0) + 1; return acc
    }, {} as Record<string, number>)
  }, [layout])

  const highConfCount = useMemo(() => {
    if (!layout) return 0
    return layout.controls.filter(c => c.provenance !== 'user' && (c.confidence ?? 0) >= 0.85).length
  }, [layout])

  const acceptedCount = layout ? layout.controls.filter(c => c.provenance === 'user').length : 0
  const flaggedCount  = layout ? layout.controls.filter(c => c.provenance !== 'user' && (c.confidence ?? 0) < 0.85).length : 0

  const handleAcceptAll = useCallback(() => {
    const n = acceptAllHC(0.85)
    if (n > 0) { setAcceptFlash(n); setTimeout(() => setAcceptFlash(null), 2000) }
  }, [acceptAllHC])

  // ── Export ──────────────────────────────────────────────────────────────────

  const runExport = useCallback(async () => {
    const panel    = useImageStore.getState().sourceImage
    const controls = (usePanelLayoutStore.getState().layout?.controls ?? [])
      .filter(c => c.provenance === 'user')
    if (!panel) { setExportError('No panel image loaded.'); return }

    setExporting(true)
    setExportError(null)
    setExportedPath(null)

    try {
      const w = panel.width, h = panel.height
      const assets: { path: string; dataUrl: string }[] = []

      setExportStatus('Building punched background & element crops…')
      let filled = panel.dataUrl
      let punched = panel.dataUrl
      let crops: { id: string; bbox: [number, number, number, number]; png: string }[] = []
      if (controls.length > 0) {
        const triple = await pythonClient.exportPunchTriple(panel.dataUrl, controls, {
          fillMethod: 'poisson', dehalo: true, includeCrops: true,
        })
        filled = triple.background_filled
        punched = triple.background_punched
        crops = (triple.crops ?? []).map(c => ({ id: c.id, bbox: c.bbox, png: c.png }))
      }
      assets.push({ path: 'background/background_filled.png', dataUrl: filled })
      assets.push({ path: 'background/background_punched.png', dataUrl: punched })
      for (const c of crops) assets.push({ path: `assets/${c.id}.png`, dataUrl: c.png })

      setExportStatus('Building layout manifest…')
      const filesById: Record<string, Record<string, string>> = {}
      for (const c of crops) filesById[c.id] = { original: `assets/${c.id}.png` }
      const manifest = await pythonClient.exportLayoutManifest(controls, w, h, {
        filesById, includeSemantics: true, includeShapes: true, includeInteraction: true,
      })

      setExportStatus('Generating Panel.tsx & README…')
      const merged   = mergePlacedIntoManifest(manifest, [])
      const scene    = sceneFromManifest(merged, { backgroundFile: 'background/background_filled.png', componentName: 'Panel' })
      const panelTsx = generateReactComponent(scene)
      const readme   = buildHandoffReadme({
        componentName: 'Panel', width: w, height: h,
        assetCount: merged.assets.length, placedCount: 0,
        hasBackground: true, hasPreview: false,
      })

      setExportStatus('Packing archive…')
      const zip = filesToZip(assembleHandoffFiles({ layout: merged, panelTsx, readme, assets }))
      const b64 = u8ToBase64(zip)

      const { canceled, filePath } = await window.synthskin.showSaveDialog({
        title: 'Export SynthSkin Bundle',
        defaultPath: 'synthskin-handoff.zip',
        buttonLabel: 'Export',
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      })
      if (canceled || !filePath) return

      const res = await window.synthskin.writeFile(filePath, b64, 'base64')
      if (!res.success) throw new Error(res.error ?? 'Write failed')
      setExportedPath(filePath)
    } catch (e) {
      // Suppress silent user-cancels (native dialog dismiss or fetch abort).
      if (e instanceof Error && (
        e.name === 'AbortError' ||
        e.message.toLowerCase().includes('aborted') ||
        e.message.toLowerCase().includes('user aborted')
      )) return
      setExportError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
      setExportStatus(null)
    }
  }, [])

  const copyPrompt = useCallback(() => {
    const panel    = useImageStore.getState().sourceImage
    const controls = usePanelLayoutStore.getState().layout?.controls ?? []
    if (!panel || !exportedPath) return
    const prompt = buildAgentPrompt({
      width: panel.width, height: panel.height,
      detectedCount: controls.length, filePath: exportedPath,
    })
    navigator.clipboard?.writeText(prompt).then(() => {
      setCopyFlash(true); setTimeout(() => setCopyFlash(false), 2000)
    })
  }, [exportedPath])

  // ─── Render ───────────────────────────────────────────────────────────────

  // ── STATE: No image ──
  if (!sourceImage) {
    return (
      <div
        className="h-full flex flex-col items-center justify-center p-8"
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
      >
        <div className={`w-full max-w-lg border-2 border-dashed rounded-2xl p-12 flex flex-col items-center gap-5 transition-colors ${
          dragOver ? 'border-accent bg-accent/8' : 'border-surface-4 hover:border-surface-5'
        }`}>
          <div className="text-6xl opacity-25">🎛️</div>
          <div className="text-center">
            <h2 className="text-[20px] font-bold text-neutral-100">Import Your Panel</h2>
            <p className="text-[12px] text-muted mt-2 max-w-xs leading-relaxed">
              Drop a screenshot of your plugin UI here. AI will detect every knob,
              slider, button, and screen automatically.
            </p>
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-7 py-3 rounded-xl bg-accent text-black font-bold text-[14px] hover:bg-amber-400 transition-colors"
          >
            Browse for image…
          </button>
          <p className="text-[10px] text-muted/40">or drag & drop · PNG, JPG, WEBP</p>
        </div>
        <input
          ref={fileInputRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = '' }}
        />
      </div>
    )
  }

  // ── STATE: Detecting ──
  if (detecting) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-6 p-10">
        <div className="w-full max-w-sm space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-accent/40 border-t-accent rounded-full animate-spin shrink-0" />
            <span className="text-[14px] font-semibold text-neutral-200">Detecting elements…</span>
            <span className="ml-auto text-[12px] font-mono text-accent">{detectPct}%</span>
          </div>
          <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${detectPct}%` }} />
          </div>
          <p className="text-[11px] text-muted">{detectMsg}</p>
          <button
            onClick={() => { abortRef.current?.abort(); setDetecting(false) }}
            className="text-[10px] text-red-400/60 hover:text-red-400 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // ── STATE: Image loaded, no detection yet (or error) ──
  if (!layout) {
    return (
      <div className="h-full flex flex-col" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
        {/* Preview */}
        <div className="flex-1 relative overflow-hidden bg-surface-0">
          <img
            src={sourceImage.dataUrl}
            alt="Panel"
            className="w-full h-full object-contain"
          />
          {/* Change image overlay */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="absolute top-3 right-3 px-3 py-1.5 rounded-lg bg-black/50 border border-white/10 text-[10px] text-white/70 hover:bg-black/70 transition-colors"
          >
            Change image
          </button>
        </div>
        <input
          ref={fileInputRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = '' }}
        />

        {/* Action bar */}
        <div className="shrink-0 border-t border-surface-4 bg-surface-1/95 px-5 py-3.5">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-medium text-neutral-200 truncate">{sourceImage.path}</p>
              <p className="text-[10px] text-muted">{sourceImage.width} × {sourceImage.height}px</p>
            </div>
            {detectError && (
              <p className="text-[10px] text-red-400 flex-1 min-w-0">{detectError}</p>
            )}
            <button
              onClick={runDetection}
              className="px-7 py-2.5 rounded-xl bg-accent text-black font-bold text-[13px] hover:bg-amber-400 transition-colors shrink-0"
            >
              {detectError ? 'Retry Detection' : 'Detect Elements'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── STATE: Detection done — visual asset grid ──
  const controls = layout.controls

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Header ── */}
      <div className="shrink-0 flex items-start gap-3 px-5 py-3 border-b border-surface-4 bg-surface-1/80">
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-1.5">
            <span className="text-[14px] font-bold text-neutral-100">{controls.length} elements detected</span>
            {Object.entries(typeCounts).map(([type, count]) => (
              <span
                key={type}
                className={`text-[9px] px-1.5 py-0.5 rounded-full border font-mono ${TYPE_PILL[type] ?? TYPE_PILL_DEFAULT}`}
              >
                {type} ×{count}
              </span>
            ))}
          </div>
          <p className="text-[10px] text-muted mt-0.5">
            {acceptedCount}/{controls.length} accepted
            {flaggedCount > 0 && <span className="text-yellow-400"> · {flaggedCount} need review (hover to triage)</span>}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          {highConfCount > 0 && (
            <button
              onClick={handleAcceptAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/12 border border-green-500/25 text-[10px] text-green-300 hover:bg-green-500/20 transition-colors"
            >
              {acceptFlash !== null
                ? `✓ ${acceptFlash} accepted`
                : `✓ Accept all ≥85% (${highConfCount})`}
            </button>
          )}
          <button
            onClick={() => runDetection()}
            className="px-3 py-1.5 rounded-lg bg-surface-2 border border-surface-4 text-[10px] text-muted hover:text-neutral-200 transition-colors"
          >
            Re-detect
          </button>
          <button
            onClick={openPanelAnalyzer}
            className="px-3 py-1.5 rounded-lg bg-surface-2 border border-surface-4 text-[10px] text-muted hover:text-neutral-200 transition-colors"
          >
            Canvas view →
          </button>
          <button
            onClick={openPunchEdit}
            className="px-3 py-1.5 rounded-lg bg-green-500/12 border border-green-500/25 text-[10px] text-green-300 hover:bg-green-500/20 transition-colors"
          >
            Edit punch regions →
          </button>
        </div>
      </div>

      {/* ── Asset grid ── */}
      <div className="flex-1 overflow-y-auto p-4">
        {thumbsLoading && controls.length > 0 && (
          <div className="flex items-center gap-2 text-[10px] text-muted mb-3">
            <div className="w-3 h-3 border border-muted/40 border-t-muted/80 rounded-full animate-spin" />
            Loading thumbnails…
          </div>
        )}

        {controls.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
            <p className="text-[14px] text-neutral-400">No elements detected</p>
            <p className="text-[11px] text-muted max-w-xs">
              Try lowering the confidence threshold in the Canvas View, or make sure the Python sidecar is running.
            </p>
            <button onClick={openPanelAnalyzer} className="px-4 py-2 rounded-lg bg-surface-2 border border-surface-4 text-[11px] text-neutral-200 hover:bg-surface-3 transition-colors">
              Open Canvas View
            </button>
          </div>
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3">
          {controls.map((c) => (
            <ElementCard
              key={c.id}
              control={c}
              thumbnail={thumbs[c.id] ?? null}
              accepted={c.provenance === 'user'}
              confidence={Math.round((c.confidence ?? 0) * 100)}
              onAccept={() => acceptControl(c.id)}
              onRemove={() => deleteControl(c.id)}
              onRetype={(t) => { changeControlType(c.id, t); acceptControl(c.id) }}
            />
          ))}
        </div>
      </div>

      {/* ── Export bar ── */}
      <div className="shrink-0 border-t border-surface-4 bg-surface-1/90 px-5 py-3">
        {exportedPath ? (
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-green-300 font-semibold">Bundle exported successfully!</p>
              <p className="text-[9px] text-muted font-mono truncate mt-0.5">{exportedPath}</p>
            </div>
            <button
              onClick={copyPrompt}
              className={`px-4 py-2 rounded-lg text-[11px] font-medium border transition-colors shrink-0 ${
                copyFlash
                  ? 'bg-green-500/20 border-green-500/40 text-green-300'
                  : 'bg-surface-2 border-surface-4 text-neutral-200 hover:bg-surface-3'
              }`}
            >
              {copyFlash ? '✓ Copied!' : '⎘ Copy agent prompt'}
            </button>
            <button
              onClick={() => { setExportedPath(null); setExportError(null) }}
              className="px-4 py-2 rounded-lg bg-accent/15 border border-accent/25 text-[11px] text-accent hover:bg-accent/25 transition-colors shrink-0"
            >
              Export again
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              {exportError && <p className="text-[10px] text-red-400">{exportError}</p>}
              {exporting && exportStatus && (
                <div className="flex items-center gap-2 text-[10px] text-muted">
                  <div className="w-3 h-3 border border-accent/40 border-t-accent rounded-full animate-spin shrink-0" />
                  {exportStatus}
                </div>
              )}
              {!exporting && !exportError && (
                <p className="text-[10px] text-muted leading-snug">
                  Exports: punched background · {controls.length} element PNGs · layout.json · Panel.tsx · interactivity guide
                </p>
              )}
            </div>
            <button
              onClick={runExport}
              disabled={exporting || controls.length === 0}
              className="shrink-0 px-7 py-2.5 rounded-xl bg-accent text-black font-bold text-[13px] hover:bg-amber-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {exporting ? 'Exporting…' : 'Export Bundle'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
