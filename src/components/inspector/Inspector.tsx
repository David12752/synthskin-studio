import { useState, useCallback, useEffect, useRef } from 'react'
import { useAssetStore } from '../../stores/assetStore'
import { useCanvasStore } from '../../stores/canvasStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import AnalyzerInspector from '../canvas/AnalyzerInspector'
import { useExtractionStore } from '../../stores/extractionStore'
import { useImageStore } from '../../stores/imageStore'
import { useAIStore } from '../../stores/aiStore'
import { pythonClient } from '../../lib/api/pythonClient'
import ColorVariants from '../pro/ColorVariants'
import PluginMetadataEditor from '../pro/PluginMetadataEditor'
import { useAssetEditStore } from '../../stores/assetEditStore'
import { useContextMenu, type ContextMenuItem } from '../shell/ContextMenu'
import type { Asset, MeterMode } from '../../types'
import type { SymmetryAnalysis } from '../../ai/types'
import { performRefineExtraction } from '../../hooks/useExtractionTools'

export default function Inspector() {
  const selectedAssetId = useAssetStore((s) => s.selectedAssetId)
  const assets = useAssetStore((s) => s.assets)
  const activeTool = useCanvasStore((s) => s.activeTool)
  const panelAnalyzerOpen = useWorkspaceStore((s) => s.panelAnalyzerOpen)
  const [panel, setPanel] = useState<'props' | 'ai'>('props')

  const selectedAsset = selectedAssetId
    ? assets.find((a) => a.id === selectedAssetId) ?? null
    : null

  // When panel analyzer is active, show its dedicated inspector
  if (panelAnalyzerOpen) {
    return (
      <aside className="h-full bg-surface-1 flex flex-col">
        <AnalyzerInspector />
      </aside>
    )
  }

  return (
    <aside className="h-full bg-surface-1 flex flex-col">
      {/* ─── Tab bar ─── */}
      <div className="flex border-b border-surface-4 shrink-0">
        {([['props', 'Properties'], ['ai', '✦ AI Tools']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPanel(id)}
            className={`flex-1 px-2 py-2 text-[10px] font-medium uppercase tracking-wide transition-colors ${
              panel === id
                ? 'text-accent border-b-2 border-accent bg-accent/5'
                : 'text-muted hover:text-neutral-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {panel === 'props' ? (
          selectedAsset ? (
            <AssetProperties asset={selectedAsset} />
          ) : activeTool === 'wand' ? (
            <WandSettings />
          ) : activeTool === 'circle' ? (
            <ToolHint
              title="Circle Extract"
              hint="Click on the center of a knob/dial, then drag outward to set the radius. Release to extract."
            />
          ) : activeTool === 'rect' ? (
            <ToolHint
              title="Rect Extract"
              hint="Click and drag to select a rectangular region. Release to extract."
            />
          ) : activeTool === 'sam' ? (
            <SamToolHint />
          ) : activeTool === 'proExtract' ? (
            <ProExtractSettings />
          ) : (
            <div className="flex-1 flex items-center justify-center px-4 py-8">
              <span className="text-[11px] text-neutral-600 text-center leading-relaxed">
                Select a tool or asset<br />to see properties
              </span>
            </div>
          )
        ) : (
          <ExtractAIPanel selectedAsset={selectedAsset} />
        )}
      </div>
    </aside>
  )
}

function SamToolHint() {
  const [status, setStatus] = useState<null | import('../../ai/types').SAM2Status>(null)

  useEffect(() => {
    let alive = true
    pythonClient.sam2Status()
      .then((next) => {
        if (alive) setStatus(next)
      })
      .catch(() => {
        if (alive) setStatus(null)
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="p-4 space-y-3 text-[11px] text-neutral-400 leading-relaxed">
      <div>
        <div className="text-neutral-200 font-semibold mb-1">Smart Select</div>
        <p>
          One-click extraction. With SAM2 installed it segments the clicked object using the real model.
          Without SAM2 it falls back to OpenCV-based extraction.
        </p>
      </div>

      {status && status.available ? (
        <div className="rounded border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-emerald-300">
          SAM2 model is available. Smart Select is using the actual segmentation model.
        </div>
      ) : (
        <div className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-amber-300">
          SAM2 model is not installed. Smart Select is currently using an OpenCV fallback, so extraction quality will be lower.
        </div>
      )}

      <p className="text-[10px] text-neutral-500">
        Best results: click near the center of the control, avoid labels/text, and use Rect Extract when the fallback cannot isolate the part cleanly.
      </p>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// Extract AI Panel — Inpainting · Symmetry · Detection
// ═══════════════════════════════════════════════════════════
function ExtractAIPanel({ selectedAsset }: { selectedAsset: Asset | null }) {
  const sourceImage = useImageStore((s) => s.sourceImage)
  const setSourceImage = useImageStore((s) => s.setSourceImage)
  const { capabilities, processing, setProcessing, setProgress } = useAIStore()
  const addAsset = useAssetStore((s) => s.addAsset)
  const [section, setSection] = useState<'inpaint' | 'symmetry' | 'detect'>('inpaint')

  // ── Inpainting state ──
  const [inpaintMethod, setInpaintMethod] = useState<'telea' | 'navier-stokes'>('telea')
  const [inpaintRadius, setInpaintRadius] = useState(8)
  const [inpaintResult, setInpaintResult] = useState<string | null>(null)
  const [inpaintInfo, setInpaintInfo] = useState<{ regions: number; pixels: number } | null>(null)

  // ── Symmetry state ──
  const [symmetryAnalysis, setSymmetryAnalysis] = useState<SymmetryAnalysis | null>(null)
  const [symmetryType, setSymmetryType] = useState<'auto' | 'horizontal' | 'vertical' | 'radial'>('auto')
  const [symmetryStrength, setSymmetryStrength] = useState(0.8)
  const [symmetryResult, setSymmetryResult] = useState<string | null>(null)

  // ── Detection state ──
  const [detections, setDetections] = useState<any[]>([])
  const [detConfidence, setDetConfidence] = useState(0.4)

  const imageForOp = section === 'symmetry' ? (selectedAsset?.maskDataUrl ?? null) : (sourceImage?.dataUrl ?? null)

  // ─── Inpainting actions ───
  const removeText = useCallback(async () => {
    if (!sourceImage?.dataUrl) return
    setProcessing(true); setProgress('Removing text...')
    try {
      const r = await pythonClient.aiAutoRemoveText(sourceImage.dataUrl, inpaintMethod, inpaintRadius)
      setInpaintResult(r.dataUrl)
      setInpaintInfo({ regions: r.regions_found, pixels: r.pixels_inpainted })
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return
      setProgress(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    finally { setProcessing(false); setProgress('') }
  }, [sourceImage, inpaintMethod, inpaintRadius])

  const removeBg = useCallback(async () => {
    if (!sourceImage?.dataUrl) return
    setProcessing(true); setProgress('Removing background...')
    try {
      const r = await pythonClient.aiRemoveBackground(sourceImage.dataUrl)
      setInpaintResult(r.dataUrl)
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return
      setProgress(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    finally { setProcessing(false); setProgress('') }
  }, [sourceImage])

  const applyInpaintToCanvas = useCallback(() => {
    if (!inpaintResult || !sourceImage) return
    const img = new window.Image()
    img.onload = () => {
      setSourceImage({ ...sourceImage, dataUrl: inpaintResult, width: img.naturalWidth, height: img.naturalHeight, htmlImage: img })
      setInpaintResult(null)
    }
    img.src = inpaintResult
  }, [inpaintResult, sourceImage, setSourceImage])

  // ─── Symmetry actions ───
  const analyzeSymmetry = useCallback(async () => {
    const src = selectedAsset?.maskDataUrl ?? sourceImage?.dataUrl
    if (!src) return
    setProcessing(true); setProgress('Analyzing symmetry...')
    try { setSymmetryAnalysis(await pythonClient.aiDetectSymmetry(src)) }
    catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return
      setProgress(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    finally { setProcessing(false); setProgress('') }
  }, [selectedAsset, sourceImage])

  const enforceSymmetry = useCallback(async () => {
    const src = selectedAsset?.maskDataUrl ?? sourceImage?.dataUrl
    if (!src) return
    setProcessing(true); setProgress('Enforcing symmetry...')
    try {
      const r = await pythonClient.aiEnforceSymmetry(src, symmetryType, symmetryStrength)
      setSymmetryResult(r.dataUrl)
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return
      setProgress(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    finally { setProcessing(false); setProgress('') }
  }, [selectedAsset, sourceImage, symmetryType, symmetryStrength])

  // ─── Detection action ───
  const runDetect = useCallback(async () => {
    if (!sourceImage?.dataUrl) return
    setProcessing(true); setProgress('Detecting components...')
    try {
      const r = await pythonClient.aiDetectComponents(sourceImage.dataUrl, { confidenceThreshold: detConfidence })
      setDetections(r.detections)
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return
      setProgress(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
    finally { setProcessing(false); setProgress('') }
  }, [sourceImage, detConfidence])

  const addDetectionToLibrary = useCallback((det: any) => {
    addAsset({
      id: det.id,
      name: det.ai_name || `${det.type}-${det.sub_type}`,
      type: (['knob','slider','button','led','screen','meter'].includes(det.type) ? det.type : 'decoration') as Asset['type'],
      sourceImageId: 'ai-detected',
      extractionMethod: 'rect',
      extractionParams: { confidence: det.confidence },
      maskDataUrl: det.preview,
      bounds: det.bounds,
      metadata: { centerPoint: det.center, createdAt: new Date().toISOString(), tags: [det.type, 'ai-detected'] },
    })
  }, [addAsset])

  const SECTIONS = [
    { id: 'inpaint' as const, label: '🧹 Clean' },
    { id: 'symmetry' as const, label: '⚖️ Symmetry' },
    { id: 'detect' as const, label: '🔍 Detect' },
  ]

  return (
    <div className="p-3 space-y-3">
      {/* Section tabs */}
      <div className="flex gap-1">
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`flex-1 py-1 text-[10px] rounded transition-colors ${section === s.id ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-neutral-500 hover:text-neutral-300'}`}>
            {s.label}
          </button>
        ))}
      </div>

      {!sourceImage && (
        <p className="text-[10px] text-neutral-600 italic text-center py-2">Load an image on the canvas first</p>
      )}

      {/* ── Inpaint ── */}
      {section === 'inpaint' && (
        <div className="space-y-3">
          <p className="text-[10px] text-neutral-500 leading-relaxed">Clean up the source image before extracting — remove text labels or full background.</p>
          <div className="flex gap-1">
            {(['telea', 'navier-stokes'] as const).map(m => (
              <button key={m} onClick={() => setInpaintMethod(m)}
                className={`flex-1 py-1 text-[10px] rounded ${inpaintMethod === m ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-neutral-500'}`}>
                {m === 'telea' ? 'Fast' : 'Smooth'}
              </button>
            ))}
          </div>
          <label className="block text-[10px] text-neutral-500">
            Radius: {inpaintRadius}px
            <input type="range" min={2} max={20} value={inpaintRadius} onChange={e => setInpaintRadius(+e.target.value)}
              className="w-full mt-1 accent-amber-500" />
          </label>
          <button onClick={removeText} disabled={processing || !sourceImage}
            className="w-full py-1.5 text-[11px] font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40">
            Remove Text Labels
          </button>
          <button onClick={removeBg} disabled={processing || !sourceImage}
            className="w-full py-1.5 text-[11px] rounded bg-surface-2 text-neutral-300 hover:bg-surface-3 disabled:opacity-40 border border-surface-4">
            Remove Background
          </button>
          {inpaintInfo && <p className="text-[10px] text-neutral-500">Removed {inpaintInfo.regions} regions · {inpaintInfo.pixels.toLocaleString()} px</p>}
          {inpaintResult && (
            <div className="space-y-2">
              <img src={inpaintResult} alt="cleaned" className="w-full rounded border border-surface-4 bg-surface-0" />
              <button onClick={applyInpaintToCanvas}
                className="w-full py-1 text-[11px] bg-emerald-900/30 border border-emerald-700/40 text-emerald-300 rounded hover:bg-emerald-900/50">
                ✓ Apply to Canvas
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Symmetry ── */}
      {section === 'symmetry' && (
        <div className="space-y-3">
          <p className="text-[10px] text-neutral-500 leading-relaxed">
            {selectedAsset ? `Analyzing: ${selectedAsset.name}` : 'Select an asset or runs on full image'}
          </p>
          <button onClick={analyzeSymmetry} disabled={processing || (!selectedAsset && !sourceImage)}
            className="w-full py-1.5 text-[11px] rounded bg-surface-2 text-neutral-300 hover:bg-surface-3 disabled:opacity-40 border border-surface-4">
            Analyze Symmetry
          </button>
          {symmetryAnalysis && (
            <div className="bg-surface-2 rounded p-2 text-[10px] text-neutral-400 space-y-0.5">
              <div>Best: <span className="text-accent font-medium">{symmetryAnalysis.best_type}</span></div>
              <div>Horizontal: {(symmetryAnalysis.horizontal_score * 100).toFixed(0)}%</div>
              <div>Vertical: {(symmetryAnalysis.vertical_score * 100).toFixed(0)}%</div>
              <div>Radial: {(symmetryAnalysis.radial_score * 100).toFixed(0)}%</div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-1">
            {(['auto', 'horizontal', 'vertical', 'radial'] as const).map(t => (
              <button key={t} onClick={() => setSymmetryType(t)}
                className={`py-1 text-[10px] rounded capitalize ${symmetryType === t ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-neutral-500'}`}>
                {t}
              </button>
            ))}
          </div>
          <label className="block text-[10px] text-neutral-500">
            Strength: {(symmetryStrength * 100).toFixed(0)}%
            <input type="range" min={0} max={1} step={0.05} value={symmetryStrength} onChange={e => setSymmetryStrength(+e.target.value)}
              className="w-full mt-1 accent-amber-500" />
          </label>
          <button onClick={enforceSymmetry} disabled={processing || (!selectedAsset && !sourceImage)}
            className="w-full py-1.5 text-[11px] font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40">
            Make Symmetrical
          </button>
          {symmetryResult && (
            <div className="space-y-1">
              <img src={symmetryResult} alt="symmetrical" className="w-full rounded border border-surface-4 bg-surface-0" />
            </div>
          )}
        </div>
      )}

      {/* ── Detect ── */}
      {section === 'detect' && (
        <div className="space-y-3">
          <p className="text-[10px] text-neutral-500 leading-relaxed">Auto-detect all UI components on the loaded image and add them to the library.</p>
          <label className="block text-[10px] text-neutral-500">
            Min confidence: {(detConfidence * 100).toFixed(0)}%
            <input type="range" min={0.1} max={0.9} step={0.05} value={detConfidence} onChange={e => setDetConfidence(+e.target.value)}
              className="w-full mt-1 accent-amber-500" />
          </label>
          <button onClick={runDetect} disabled={processing || !sourceImage}
            className="w-full py-1.5 text-[11px] font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40">
            Detect All Components
          </button>
          {detections.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-neutral-500">{detections.length} found:</p>
              {detections.map((d, i) => (
                <div key={i} className="flex items-center gap-2 bg-surface-2 rounded p-1.5">
                  {d.preview && <img src={d.preview} alt={d.type} className="w-8 h-8 rounded object-contain bg-surface-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-neutral-300 capitalize">{d.type}</div>
                    <div className="text-[9px] text-neutral-600">{(d.confidence*100).toFixed(0)}%</div>
                  </div>
                  <button onClick={() => addDetectionToLibrary(d)}
                    className="text-[9px] px-1.5 py-0.5 bg-accent/20 text-accent rounded hover:bg-accent/30 shrink-0">
                    + Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}


function AssetProperties({ asset }: { asset: Asset }) {
  const removeAsset = useAssetStore((s) => s.removeAsset)
  const updateAssetName = useAssetStore((s) => s.updateAssetName)
  const updateAssetType = useAssetStore((s) => s.updateAssetType)
  const [subTab, setSubTab] = useState<'details' | 'actions' | 'style' | 'plugin' | 'refine'>('details')
  const isExtracting = useExtractionStore((s) => s.isExtracting)
  const refineEdgeParams = useExtractionStore((s) => s.refineEdgeParams)
  const setRefineEdgeParams = useExtractionStore((s) => s.setRefineEdgeParams)
  const [refineRadius, setRefineRadius] = useState(refineEdgeParams.radius)
  const [refineSmooth, setRefineSmooth] = useState(refineEdgeParams.smooth)
  const [refineFeather, setRefineFeather] = useState(refineEdgeParams.feather)
  const [refineContrast, setRefineContrast] = useState(refineEdgeParams.contrast)
  const [refineShiftEdge, setRefineShiftEdge] = useState(refineEdgeParams.shiftEdge)

  const ASSET_TYPES: Asset['type'][] = ['knob', 'slider', 'meter', 'button', 'led', 'screen', 'decoration']

  const { onContextMenu, menuElement } = useContextMenu(() => {
    const items: ContextMenuItem[] = []
    items.push(
      { type: 'separator' },
      { type: 'item', label: 'Copy Bounds', onClick: () => {
        const text = `${asset.bounds.x}, ${asset.bounds.y}, ${asset.bounds.width}, ${asset.bounds.height}`
        navigator.clipboard.writeText(text)
      }},
      { type: 'separator' },
      { type: 'item', label: 'Delete Asset', destructive: true, shortcut: 'Del', onClick: () => removeAsset(asset.id) },
    )
    return items
  })

  const SUB_TABS = [
    { id: 'details' as const, label: 'Details' },
    { id: 'actions' as const, label: 'Actions' },
    { id: 'refine' as const, label: '✂️ Refine' },
    { id: 'style' as const, label: 'Style' },
    { id: 'plugin' as const, label: 'Plugin' },
  ]

  return (
    <div className="flex flex-col h-full" onContextMenu={onContextMenu}>
      {menuElement}

      {/* Preview thumbnail — always visible on top */}
      <div className="shrink-0 p-3 pb-0">
        <div className="bg-surface-2 rounded border border-surface-4 p-2 flex items-center justify-center">
          <img
            src={asset.maskDataUrl}
            alt={asset.name}
            className="max-w-full max-h-24 object-contain"
            draggable={false}
          />
        </div>
      </div>

      {/* Sub-tab bar */}
      <div className="flex shrink-0 mx-3 mt-2 rounded-md bg-surface-2 border border-surface-4 overflow-hidden">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className={`flex-1 py-1.5 text-[9px] font-semibold uppercase tracking-wider transition-colors ${
              subTab === tab.id
                ? 'bg-accent/15 text-accent'
                : 'text-neutral-500 hover:text-neutral-300 hover:bg-surface-3/50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content — no scrolling needed, compact layout */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {/* ── Details tab ── */}
        {subTab === 'details' && (
          <div className="space-y-2.5">
            {/* Name */}
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Name</label>
              <input
                type="text"
                value={asset.name}
                onChange={(e) => updateAssetName(asset.id, e.target.value)}
                className="w-full mt-0.5 px-2 py-1 rounded bg-surface-2 border border-surface-4 text-xs text-neutral-300 font-mono focus:border-accent/50 focus:outline-none"
              />
            </div>

            {/* Type */}
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Type</label>
              <select
                value={asset.type}
                onChange={(e) => updateAssetType(asset.id, e.target.value as Asset['type'])}
                className="w-full mt-0.5 px-2 py-1 rounded bg-surface-2 border border-surface-4 text-xs text-neutral-300 capitalize focus:border-accent/50 focus:outline-none"
              >
                {ASSET_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {/* Method */}
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Method</label>
              <div className="text-xs text-neutral-300 mt-0.5 capitalize">{asset.extractionMethod}</div>
            </div>

            {/* Bounds — compact 2-col layout */}
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Bounds</label>
              <div className="grid grid-cols-4 gap-1 mt-0.5">
                {[
                  ['X', asset.bounds.x],
                  ['Y', asset.bounds.y],
                  ['W', asset.bounds.width],
                  ['H', asset.bounds.height],
                ].map(([label, val]) => (
                  <div key={label as string} className="bg-surface-2 rounded px-1.5 py-0.5 text-center">
                    <div className="text-[8px] text-neutral-600 uppercase">{label}</div>
                    <div className="text-[10px] text-neutral-400 font-mono">{val}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Center Point */}
            {asset.metadata.centerPoint && (
              <div>
                <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Center</label>
                <div className="text-xs text-neutral-400 font-mono mt-0.5">
                  {asset.metadata.centerPoint.x}, {asset.metadata.centerPoint.y}
                </div>
              </div>
            )}

            {/* Radius */}
            {'radius' in asset.extractionParams && (
              <div>
                <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Radius</label>
                <div className="text-xs text-neutral-400 font-mono mt-0.5">
                  {Math.round(asset.extractionParams.radius as number)}px
                </div>
              </div>
            )}

            {/* Created */}
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Created</label>
              <div className="text-[10px] text-neutral-500 mt-0.5">
                {new Date(asset.metadata.createdAt).toLocaleTimeString()}
              </div>
            </div>
          </div>
        )}

        {/* ── Actions tab ── */}
        {subTab === 'actions' && (
          <div className="space-y-2">
            {/* Mask editor */}
            <div className="border-t border-surface-4 pt-2 mt-1">
              <MaskEditButton assetId={asset.id} />
            </div>

            {/* Delete */}
            <div className="border-t border-surface-4 pt-2 mt-1">
              <button
                onClick={() => removeAsset(asset.id)}
                className="w-full px-3 py-2 rounded text-[11px] bg-red-900/30 border border-red-800/50 text-red-400 hover:bg-red-900/50 transition-colors flex items-center gap-2"
              >
                <span>🗑️</span> Delete Asset
              </button>
            </div>
          </div>
        )}

        {/* ── Style tab ── */}
        {subTab === 'style' && (
          <div className="space-y-2">
            <ColorVariants asset={asset} />
          </div>
        )}

        {/* ── Plugin tab ── */}
        {subTab === 'plugin' && (
          <div>
            <PluginMetadataEditor asset={asset} />
          </div>
        )}

        {/* ── Refine Edge tab ── */}
        {subTab === 'refine' && (
          <div className="space-y-3">
            <p className="text-[10px] text-neutral-500 leading-snug">
              Post-extraction edge refinement. Adjust the mask alpha boundary without re-extracting.
            </p>

            {/* Radius */}
            <div>
              <div className="flex justify-between mb-0.5">
                <label className="text-[10px] text-neutral-400 uppercase tracking-wider">Edge Radius</label>
                <span className="text-[10px] font-mono text-neutral-300">{refineRadius}px</span>
              </div>
              <input type="range" min={0} max={30} step={1} value={refineRadius}
                onChange={(e) => setRefineRadius(Number(e.target.value))}
                className="w-full accent-accent h-1.5" />
              <p className="text-[9px] text-neutral-600 mt-0.5">Matting band around the mask edge</p>
            </div>

            {/* Smooth */}
            <div>
              <div className="flex justify-between mb-0.5">
                <label className="text-[10px] text-neutral-400 uppercase tracking-wider">Smooth</label>
                <span className="text-[10px] font-mono text-neutral-300">{refineSmooth}</span>
              </div>
              <input type="range" min={0} max={10} step={1} value={refineSmooth}
                onChange={(e) => setRefineSmooth(Number(e.target.value))}
                className="w-full accent-accent h-1.5" />
              <p className="text-[9px] text-neutral-600 mt-0.5">Morphological closing iterations</p>
            </div>

            {/* Feather */}
            <div>
              <div className="flex justify-between mb-0.5">
                <label className="text-[10px] text-neutral-400 uppercase tracking-wider">Feather</label>
                <span className="text-[10px] font-mono text-neutral-300">{refineFeather}px</span>
              </div>
              <input type="range" min={0} max={20} step={0.5} value={refineFeather}
                onChange={(e) => setRefineFeather(Number(e.target.value))}
                className="w-full accent-accent h-1.5" />
              <p className="text-[9px] text-neutral-600 mt-0.5">Gaussian blur on alpha edge</p>
            </div>

            {/* Contrast */}
            <div>
              <div className="flex justify-between mb-0.5">
                <label className="text-[10px] text-neutral-400 uppercase tracking-wider">Contrast</label>
                <span className="text-[10px] font-mono text-neutral-300">{refineContrast}%</span>
              </div>
              <input type="range" min={0} max={100} step={1} value={refineContrast}
                onChange={(e) => setRefineContrast(Number(e.target.value))}
                className="w-full accent-accent h-1.5" />
              <p className="text-[9px] text-neutral-600 mt-0.5">Alpha edge sharpening</p>
            </div>

            {/* Shift Edge */}
            <div>
              <div className="flex justify-between mb-0.5">
                <label className="text-[10px] text-neutral-400 uppercase tracking-wider">Shift Edge</label>
                <span className="text-[10px] font-mono text-neutral-300">{refineShiftEdge > 0 ? '+' : ''}{refineShiftEdge}px</span>
              </div>
              <input type="range" min={-20} max={20} step={1} value={refineShiftEdge}
                onChange={(e) => setRefineShiftEdge(Number(e.target.value))}
                className="w-full accent-accent h-1.5" />
              <p className="text-[9px] text-neutral-600 mt-0.5">Expand (+) or contract (−) the selection</p>
            </div>

            {/* Apply button */}
            <button
              disabled={isExtracting}
              onClick={() => {
                const params = { radius: refineRadius, smooth: refineSmooth, feather: refineFeather, contrast: refineContrast, shiftEdge: refineShiftEdge }
                setRefineEdgeParams(params)
                void performRefineExtraction(asset.id, params)
              }}
              className="w-full px-3 py-2 rounded text-[11px] font-medium bg-violet-900/40 border border-violet-600/40 text-violet-300 hover:bg-violet-900/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {isExtracting ? (
                <><span className="animate-spin">⏳</span> Refining…</>
              ) : (
                <><span>✂️</span> Apply Refine Edge</>
              )}
            </button>

            {/* Reset */}
            <button
              onClick={() => { setRefineRadius(3); setRefineSmooth(2); setRefineFeather(0); setRefineContrast(0); setRefineShiftEdge(0) }}
              className="w-full px-3 py-1.5 rounded text-[10px] text-neutral-500 hover:text-neutral-300 border border-surface-4 hover:border-surface-5 transition-colors"
            >
              Reset to defaults
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function MaskEditButton({ assetId }: { assetId: string }) {
  const editingAssetId = useAssetEditStore((s) => s.editingAssetId)
  const startEditing = useAssetEditStore((s) => s.startEditing)
  const stopEditing = useAssetEditStore((s) => s.stopEditing)
  const isEditing = editingAssetId === assetId

  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] font-medium text-accent uppercase tracking-wide">Mask Editor</span>
      {isEditing ? (
        <button
          onClick={stopEditing}
          className="text-[9px] px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors border border-emerald-500/30"
        >
          ✓ Close Editor
        </button>
      ) : (
        <button
          onClick={() => startEditing(assetId)}
          className="text-[9px] px-2.5 py-1 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors border border-accent/30"
        >
          Edit Mask on Canvas
        </button>
      )}
    </div>
  )
}

function ProExtractSettings() {
  const proParams = useExtractionStore((s) => s.proParams)
  const setProParams = useExtractionStore((s) => s.setProParams)

  const strategies = [
    { id: 'auto' as const, label: 'Auto (Best)' },
    { id: 'contour' as const, label: 'Contour Hierarchy' },
    { id: 'edge' as const, label: 'Edge Flood' },
    { id: 'color' as const, label: 'Color Distance' },
    { id: 'grabcut' as const, label: 'GrabCut' },
    { id: 'invert' as const, label: 'Invert Background' },
  ]

  return (
    <div className="p-3 space-y-3">
      <div className="text-[11px] text-neutral-400 font-semibold flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="12" height="12" rx="2" strokeDasharray="3 1.5" />
          <circle cx="8" cy="8" r="2.5" />
        </svg>
        Pro Extract
      </div>
      <p className="text-[10px] text-neutral-600 leading-relaxed">
        Click on an element to extract it with full control over strategy, quality, and output options.
      </p>

      {/* Strategy */}
      <div>
        <label className="text-[10px] text-neutral-500 mb-1 block">Strategy</label>
        <select
          value={proParams.strategy}
          onChange={(e) => setProParams({ strategy: e.target.value as typeof proParams.strategy })}
          className="w-full bg-surface-2 border border-surface-4 rounded px-2 py-1.5 text-[11px] text-neutral-300"
        >
          {strategies.map(s => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Quality */}
      <div>
        <label className="text-[10px] text-neutral-500 mb-1 block">Quality</label>
        <div className="flex gap-1">
          {(['fast', 'standard', 'high'] as const).map(q => (
            <button
              key={q}
              onClick={() => setProParams({ quality: q })}
              className={`flex-1 py-1.5 rounded text-[10px] font-medium transition-colors ${
                proParams.quality === q
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-surface-2 text-neutral-500 border border-surface-4 hover:text-neutral-400'
              }`}
            >
              {q.charAt(0).toUpperCase() + q.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Tolerance */}
      <div>
        <label className="text-[10px] text-neutral-500 flex items-center justify-between">
          Tolerance
          <span className="font-mono text-neutral-400">{proParams.tolerance}</span>
        </label>
        <input type="range" min={4} max={128} value={proParams.tolerance}
          onChange={(e) => setProParams({ tolerance: Number(e.target.value) })}
          className="w-full mt-1 accent-amber-500" />
      </div>

      {/* Edge Sensitivity */}
      <div>
        <label className="text-[10px] text-neutral-500 flex items-center justify-between">
          Edge Sensitivity
          <span className="font-mono text-neutral-400">{proParams.edgeSensitivity.toFixed(1)}</span>
        </label>
        <input type="range" min={0.2} max={3.0} step={0.1} value={proParams.edgeSensitivity}
          onChange={(e) => setProParams({ edgeSensitivity: Number(e.target.value) })}
          className="w-full mt-1 accent-amber-500" />
      </div>

      {/* Feather */}
      <div>
        <label className="text-[10px] text-neutral-500 flex items-center justify-between">
          Feather
          <span className="font-mono text-neutral-400">{proParams.feather}px</span>
        </label>
        <input type="range" min={0} max={20} step={0.5} value={proParams.feather}
          onChange={(e) => setProParams({ feather: Number(e.target.value) })}
          className="w-full mt-1 accent-amber-500" />
      </div>

      {/* Expand / Contract */}
      <div>
        <label className="text-[10px] text-neutral-500 flex items-center justify-between">
          Expand / Contract
          <span className="font-mono text-neutral-400">{proParams.expand}px</span>
        </label>
        <input type="range" min={-10} max={10} value={proParams.expand}
          onChange={(e) => setProParams({ expand: Number(e.target.value) })}
          className="w-full mt-1 accent-amber-500" />
      </div>

      {/* Padding */}
      <div>
        <label className="text-[10px] text-neutral-500 flex items-center justify-between">
          Padding
          <span className="font-mono text-neutral-400">{proParams.padding}px</span>
        </label>
        <input type="range" min={0} max={30} value={proParams.padding}
          onChange={(e) => setProParams({ padding: Number(e.target.value) })}
          className="w-full mt-1 accent-amber-500" />
      </div>

      {/* Refine Edges */}
      <label className="flex items-center gap-2 text-[11px] text-neutral-400 cursor-pointer">
        <input type="checkbox" checked={proParams.refineEdges}
          onChange={(e) => setProParams({ refineEdges: e.target.checked })}
          className="accent-amber-500" />
        Refine Edges (anti-aliased alpha)
      </label>

      {/* Show Alternatives */}
      <label className="flex items-center gap-2 text-[11px] text-neutral-400 cursor-pointer">
        <input type="checkbox" checked={proParams.returnCandidates}
          onChange={(e) => setProParams({ returnCandidates: e.target.checked })}
          className="accent-amber-500" />
        Show alternative extractions
      </label>
    </div>
  )
}

function WandSettings() {
  const wandParams = useExtractionStore((s) => s.wandParams)
  const setWandParams = useExtractionStore((s) => s.setWandParams)

  return (
    <div className="p-3 space-y-3">
      <div className="text-[11px] text-neutral-400 font-semibold flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 14l6-6" /><path d="M9.5 6.5l-2-2" /><path d="M10 2l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
        </svg>
        Magic Wand
      </div>

      {/* Mode selector */}
      <div>
        <div className="flex gap-1">
          {([
            { id: 'element' as const, icon: (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="10" height="10" rx="2" strokeDasharray="2 2" />
                <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
              </svg>
            ), tip: 'Element — Edge-aware element detection' },
            { id: 'invert' as const, icon: (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="12" height="12" rx="1" />
                <path d="M2 2h12v12H2z" fill="currentColor" opacity="0.2" />
                <circle cx="8" cy="8" r="3" fill="none" />
              </svg>
            ), tip: 'Invert — Select background, invert to get element' },
            { id: 'color' as const, icon: (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="7" r="4" />
                <circle cx="10" cy="7" r="4" />
                <circle cx="8" cy="10.5" r="4" />
              </svg>
            ), tip: 'Color — Classic flood fill by color similarity' },
          ]).map((m) => (
            <button
              key={m.id}
              onClick={() => setWandParams({ mode: m.id })}
              className={`flex-1 flex items-center justify-center py-1.5 rounded transition-colors
                ${wandParams.mode === m.id
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-surface-2 text-neutral-500 border border-surface-4 hover:text-neutral-400'
                }`}
              title={m.tip}
            >
              {m.icon}
            </button>
          ))}
        </div>
      </div>

      {/* Tolerance */}
      <div>
        <label className="text-[10px] text-neutral-500 flex items-center justify-between" title="Tolerance — how similar colors must be to be selected">
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="6" />
              <circle cx="8" cy="8" r="2.5" />
            </svg>
          </span>
          <span className="font-mono text-neutral-400">{wandParams.tolerance}</span>
        </label>
        <input
          type="range"
          min={0}
          max={128}
          value={wandParams.tolerance}
          onChange={(e) => setWandParams({ tolerance: Number(e.target.value) })}
          className="w-full mt-1 accent-amber-500"
        />
      </div>

      {/* Feather */}
      <div>
        <label className="text-[10px] text-neutral-500 flex items-center justify-between" title="Feather — soft edge blur radius">
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2L7 9" /><path d="M7 9C5.5 10.5 3 11 1 14c3-2 4.5-4.5 6-6" />
            </svg>
          </span>
          <span className="font-mono text-neutral-400">{wandParams.feather}px</span>
        </label>
        <input
          type="range"
          min={0}
          max={20}
          step={0.5}
          value={wandParams.feather}
          onChange={(e) => setWandParams({ feather: Number(e.target.value) })}
          className="w-full mt-1 accent-amber-500"
        />
      </div>

      {/* Expand / Contract */}
      <div>
        <label className="text-[10px] text-neutral-500 flex items-center justify-between" title="Expand / Contract — grow or shrink the selection edge">
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1v4M8 11v4M1 8h4M11 8h4" />
              <rect x="5" y="5" width="6" height="6" rx="0.5" strokeDasharray="2 1" />
            </svg>
          </span>
          <span className="font-mono text-neutral-400">{wandParams.expand}px</span>
        </label>
        <input
          type="range"
          min={-10}
          max={10}
          value={wandParams.expand}
          onChange={(e) => setWandParams({ expand: Number(e.target.value) })}
          className="w-full mt-1 accent-amber-500"
        />
      </div>

      {/* Contiguous (only for Color mode) */}
      {wandParams.mode === 'color' && (
        <label className="flex items-center gap-2 text-[11px] text-neutral-400 cursor-pointer" title="Contiguous — only select connected pixels">
          <input
            type="checkbox"
            checked={wandParams.contiguous}
            onChange={(e) => setWandParams({ contiguous: e.target.checked })}
            className="accent-amber-500"
          />
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="8" r="3" /><circle cx="11" cy="8" r="3" /><path d="M8 8h0" />
          </svg>
        </label>
      )}

      {/* Edge Sensitivity (only for Element/Invert modes) */}
      {wandParams.mode !== 'color' && (
        <div>
          <label className="text-[10px] text-neutral-500 flex items-center justify-between" title="Edge Sensitivity — lower = more edges detected, tighter selection">
            <span className="flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12l3-4 3 2 3-6 5 8" />
              </svg>
            </span>
            <span className="font-mono text-neutral-400">{wandParams.edgeSensitivity.toFixed(1)}</span>
          </label>
          <input
            type="range"
            min={0.2}
            max={3.0}
            step={0.1}
            value={wandParams.edgeSensitivity}
            onChange={(e) => setWandParams({ edgeSensitivity: Number(e.target.value) })}
            className="w-full mt-1 accent-amber-500"
          />
        </div>
      )}

      {/* Refine Edges */}
      <label className="flex items-center gap-2 text-[11px] text-neutral-400 cursor-pointer" title="Refine Edges — anti-aliased smooth edges">
        <input
          type="checkbox"
          checked={wandParams.refineEdges}
          onChange={(e) => setWandParams({ refineEdges: e.target.checked })}
          className="accent-amber-500"
        />
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 13C4 9 6 5 14 3" /><path d="M2 13c2-1 4-1 6 0" opacity="0.4" />
        </svg>
      </label>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// Gemma Chat Panel — compact sidebar chat with Gemma AI
// ═══════════════════════════════════════════════════════════
type GemmaMode = 'chat' | 'analyze' | 'style' | 'layout' | 'name'

function GemmaChatPanel() {
  const sourceImage = useImageStore((s) => s.sourceImage)
  const { capabilities, capabilitiesLoading, processing, setProcessing, setProgress } = useAIStore()
  const [mode, setMode] = useState<GemmaMode>('chat')
  const [chatPrompt, setChatPrompt] = useState('')
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'assistant' | 'error'; text: string }[]>([])
  const [result, setResult] = useState<any>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const image = sourceImage?.dataUrl ?? null

  const gemmaAvailable = capabilities?.gemma ?? false
  const gemmaModel = capabilities?.gemma_model ?? null

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory])

  const sendChat = useCallback(async () => {
    if (!chatPrompt.trim()) return
    const userMsg = chatPrompt.trim()
    setChatPrompt('')
    setChatHistory(prev => [...prev, { role: 'user', text: userMsg }])
    setProcessing(true)
    try {
      const res = await pythonClient.gemmaGenerate(userMsg, image ?? undefined)
      setChatHistory(prev => [...prev, { role: 'assistant', text: res.response }])
    } catch (e: any) {
      setChatHistory(prev => [...prev, { role: 'error', text: e.message }])
    } finally {
      setProcessing(false)
    }
  }, [chatPrompt, image])

  const runAnalyze = useCallback(async () => {
    if (!image) return
    setProcessing(true); setProgress('Analyzing panel...')
    try { setResult((await pythonClient.gemmaAnalyzePanel(image)).analysis) }
    catch (e: any) { setResult({ error: e.message }) }
    finally { setProcessing(false); setProgress('') }
  }, [image])

  const runStyle = useCallback(async () => {
    if (!image) return
    setProcessing(true); setProgress('Suggesting style...')
    try { setResult((await pythonClient.gemmaSuggestStyle(image)).suggestion) }
    catch (e: any) { setResult({ error: e.message }) }
    finally { setProcessing(false); setProgress('') }
  }, [image])

  const runLayout = useCallback(async () => {
    if (!image) return
    setProcessing(true); setProgress('Analyzing layout...')
    try { setResult((await pythonClient.gemmaDescribeLayout(image)).layout) }
    catch (e: any) { setResult({ error: e.message }) }
    finally { setProcessing(false); setProgress('') }
  }, [image])

  const runName = useCallback(async () => {
    if (!image) return
    setProcessing(true); setProgress('Identifying component...')
    try { setResult((await pythonClient.gemmaNameComponent(image, 'knob')).naming) }
    catch (e: any) { setResult({ error: e.message }) }
    finally { setProcessing(false); setProgress('') }
  }, [image])

  if (capabilitiesLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center space-y-2">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-[10px] text-neutral-500">Checking AI...</p>
        </div>
      </div>
    )
  }

  if (!gemmaAvailable) {
    return (
      <div className="p-4 space-y-3 text-center">
        <div className="text-3xl">🧠</div>
        <p className="text-[11px] text-neutral-400 font-semibold">Gemma AI Not Available</p>
        <p className="text-[10px] text-neutral-600">
          Requires <span className="text-accent">Ollama</span> running locally.
        </p>
        <div className="bg-surface-2 border border-surface-3 rounded p-2 text-left space-y-1">
          <ol className="text-[10px] text-neutral-400 space-y-1 list-decimal list-inside">
            <li>Install from <span className="text-accent">ollama.com</span></li>
            <li><code className="bg-surface-3 px-1 rounded text-accent font-mono">ollama pull gemma3:4b</code></li>
            <li>Restart SynthSkin Studio</li>
          </ol>
        </div>
      </div>
    )
  }

  const MODES: { id: GemmaMode; label: string }[] = [
    { id: 'chat', label: '💬 Chat' },
    { id: 'analyze', label: '🔍 Analyze' },
    { id: 'style', label: '🎨 Style' },
    { id: 'layout', label: '📐 Layout' },
    { id: 'name', label: '🏷️ Name' },
  ]

  const modeActions: Record<Exclude<GemmaMode, 'chat'>, () => void> = {
    analyze: runAnalyze, style: runStyle, layout: runLayout, name: runName,
  }

  return (
    <div className="flex flex-col h-full">
      {/* Model badge */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface-4">
        <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
        <span className="text-[10px] text-neutral-500">
          <span className="text-accent font-semibold">{gemmaModel}</span> · ready
        </span>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-0.5 px-2 py-1.5 border-b border-surface-4 flex-wrap">
        {MODES.map(m => (
          <button key={m.id} onClick={() => { setMode(m.id); setResult(null) }}
            className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
              mode === m.id ? 'bg-accent/20 text-accent' : 'text-neutral-500 hover:text-neutral-300'
            }`}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'chat' ? (
        <>
          {/* Chat history */}
          <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
            {chatHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 opacity-50">
                <div className="text-2xl">🧠</div>
                <p className="text-[10px] text-neutral-500 text-center px-2">
                  Ask Gemma about your design.{image ? ' Image context will be sent.' : ''}
                </p>
              </div>
            ) : (
              chatHistory.map((msg, i) => (
                <div key={i} className={`text-[10px] p-2 rounded-lg leading-relaxed ${
                  msg.role === 'user' ? 'bg-accent/10 text-neutral-200 ml-4'
                  : msg.role === 'error' ? 'bg-red-900/30 text-red-300 mr-4'
                  : 'bg-surface-2 text-neutral-300 mr-4'
                }`}>
                  <div className={`text-[9px] font-semibold mb-0.5 ${
                    msg.role === 'user' ? 'text-accent' : msg.role === 'error' ? 'text-red-400' : 'text-neutral-500'
                  }`}>
                    {msg.role === 'user' ? 'You' : msg.role === 'error' ? 'Error' : 'Gemma'}
                  </div>
                  <span className="whitespace-pre-wrap">{msg.text}</span>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <div className="flex gap-1 p-2 border-t border-surface-4 shrink-0">
            <textarea
              value={chatPrompt}
              onChange={e => setChatPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
              placeholder="Ask about your design..."
              rows={2}
              className="flex-1 bg-surface-2 border border-surface-3 rounded px-2 py-1 text-[10px] text-neutral-200 focus:outline-none focus:border-accent resize-none"
            />
            <button onClick={sendChat} disabled={processing || !chatPrompt.trim()}
              className="px-2 text-[10px] bg-accent text-black rounded font-semibold disabled:opacity-40 self-stretch hover:bg-amber-400 transition-colors">
              {processing ? '...' : '▶'}
            </button>
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {!image && <p className="text-[10px] text-amber-400/70 bg-amber-400/5 border border-amber-400/10 rounded p-2">Load an image first (Extract canvas)</p>}
          <button onClick={modeActions[mode as Exclude<GemmaMode, 'chat'>]} disabled={processing || !image}
            className="w-full py-1.5 text-[11px] font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40">
            {processing ? 'Processing...' : `Run ${mode.charAt(0).toUpperCase() + mode.slice(1)}`}
          </button>
          {result && (
            <div className="bg-surface-2 rounded p-2 overflow-y-auto max-h-[60vh]">
              {result.error ? (
                <p className="text-[10px] text-red-400">{result.error}</p>
              ) : (
                <pre className="text-[9px] text-neutral-400 font-mono whitespace-pre-wrap leading-relaxed">
                  {JSON.stringify(result, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ToolHint({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="p-3 space-y-2">
      <div className="text-[11px] text-neutral-400 font-semibold">{title}</div>
      <p className="text-[10px] text-neutral-600 leading-relaxed">{hint}</p>
    </div>
  )
}

function nearestPow2(n: number): number {
  let p = 64
  while (p < n && p < 512) p *= 2
  return p
}

