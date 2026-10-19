import React, { useEffect, useCallback, useRef, useState } from 'react'
import { useAIStore } from '../stores/aiStore'
import { useImageStore } from '../stores/imageStore'
import { useAssetStore } from '../stores/assetStore'
import { pythonClient } from '../lib/api/pythonClient'
import type {
  AITab, AIDetection, SymmetryAnalysis, LightingEstimate,
} from './types'

/* ═══════════════════════════════════════════════════════════
   AI Studio — Phase 5 Full-Screen Modal
   7 tabs: Style Transfer | Component Detection | Lighting |
           Upscale | Symmetry | Inpainting | Generate
   ═══════════════════════════════════════════════════════════ */

const TABS: { id: AITab; label: string; icon: string }[] = [
  { id: 'style-transfer', label: 'Style Transfer', icon: '🎨' },
  { id: 'component-detection', label: 'Detection', icon: '🔍' },
  { id: 'lighting', label: 'Lighting', icon: '💡' },
  { id: 'upscale', label: 'Upscale', icon: '🔬' },
  { id: 'symmetry', label: 'Symmetry', icon: '⚖️' },
  { id: 'inpainting', label: 'Inpaint', icon: '🧹' },
  { id: 'generate', label: 'Generate', icon: '✨' },
  { id: 'gemma', label: 'Gemma AI', icon: '🧠' },
]

// ─── Helper: Get current image dataUrl ───
function useCurrentImage(): string | null {
  const sourceImage = useImageStore((s) => s.sourceImage)
  return sourceImage?.dataUrl ?? null
}

// ─── Helper: Load a File into the shared imageStore ───
function loadImageIntoStore(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!file.type.match(/^image\/(png|jpe?g|webp|gif|bmp|tiff?)$/i)) {
      reject(new Error('Unsupported format. Use PNG, JPEG, or WebP.'))
      return
    }
    const { setSourceImage, setLoading } = useImageStore.getState()
    setLoading(true)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new window.Image()
      img.onload = () => {
        setSourceImage({
          id: crypto.randomUUID(),
          path: file.name,
          width: img.naturalWidth,
          height: img.naturalHeight,
          dataUrl,
          htmlImage: img,
        })
        resolve()
      }
      img.onerror = () => reject(new Error('Failed to decode image'))
      img.src = dataUrl
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export default function AIStudio() {
  const {
    open, tab, capabilities, capabilitiesLoading, processing, progress, lastResult,
    closeStudio, setTab, setCapabilities, setCapabilitiesLoading, setProcessing, setProgress, setLastResult,
  } = useAIStore()

  // Fetch capabilities on first open
  useEffect(() => {
    if (open && !capabilities && !capabilitiesLoading) {
      setCapabilitiesLoading(true)
      pythonClient.aiCapabilities()
        .then(setCapabilities)
        .catch(() => setCapabilities(null as any))
        .finally(() => setCapabilitiesLoading(false))
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) closeStudio()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-0 text-gray-200">
      {/* ─── Top Bar ─── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface-3 bg-surface-1">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold text-accent">AI Studio</h2>
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
                  tab === t.id
                    ? 'bg-accent/20 text-accent'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-surface-3'
                }`}
              >
                <span className="mr-1">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {processing && (
            <span className="text-xs text-accent animate-pulse">{progress || 'Processing...'}</span>
          )}
          <button
            onClick={closeStudio}
            className="px-3 py-1 text-xs bg-surface-3 rounded hover:bg-surface-4"
          >
            Close
          </button>
        </div>
      </div>

      {/* ─── Content ─── */}
      <div className="flex flex-1 overflow-hidden">
        {tab === 'style-transfer' && <StyleTransferTab />}
        {tab === 'component-detection' && <ComponentDetectionTab />}
        {tab === 'lighting' && <LightingTab />}
        {tab === 'upscale' && <UpscaleTab />}
        {tab === 'symmetry' && <SymmetryTab />}
        {tab === 'inpainting' && <InpaintingTab />}
        {tab === 'generate' && <GenerateTab />}
        {tab === 'gemma' && <GemmaTab />}
      </div>

      {/* ─── Status Bar ─── */}
      <div className="flex items-center justify-between px-4 py-1 border-t border-surface-3 bg-surface-1 text-[10px] text-gray-500">
        <div className="flex items-center gap-3">
          <span>
            {capabilities
              ? `Backend connected — ${Object.values(capabilities).filter(Boolean).length} features available`
              : capabilitiesLoading ? 'Connecting to backend...' : 'Backend not available'}
          </span>
          {!capabilitiesLoading && !capabilities && (
            <button
              onClick={() => {
                setCapabilitiesLoading(true)
                pythonClient.aiCapabilities()
                  .then(setCapabilities)
                  .catch(() => setCapabilities(null as any))
                  .finally(() => setCapabilitiesLoading(false))
              }}
              className="px-2 py-0.5 bg-surface-3 rounded hover:bg-surface-4 text-gray-400 hover:text-gray-200"
            >
              Retry
            </button>
          )}
        </div>
        <span>AI Studio · Gemma 4 + SAM2</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// Tab Components
// ═══════════════════════════════════════════════════════════

function StyleTransferTab() {
  const image = useCurrentImage()
  const { styles, selectedStyle, styleStrength, setStyles, setSelectedStyle, setStyleStrength } = useAIStore()
  const { setProcessing, setProgress, setLastResult, lastResult } = useAIStore()
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [info, setInfo] = useState<{ fonts: string[]; material: string } | null>(null)

  useEffect(() => {
    if (styles.length === 0) {
      pythonClient.aiGetStyles().then((r) => setStyles(r.styles)).catch(() => {})
    }
  }, [])

  const apply = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress('Applying style...')
    try {
      const result = await pythonClient.aiStyleTransfer(image, selectedStyle, styleStrength)
      setResultUrl(result.dataUrl)
      setLastResult(result.dataUrl)
      setInfo({ fonts: result.font_suggestions, material: result.material })
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image, selectedStyle, styleStrength])

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Controls */}
      <div className="w-72 p-4 border-r border-surface-3 overflow-y-auto space-y-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">Style Presets</h3>
        <div className="grid grid-cols-2 gap-2">
          {styles.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedStyle(s.id)}
              className={`p-2 rounded text-xs text-left transition-colors ${
                selectedStyle === s.id ? 'bg-accent/20 border border-accent' : 'bg-surface-2 hover:bg-surface-3 border border-transparent'
              }`}
            >
              <div
                className="w-full h-3 rounded mb-1"
                style={{ backgroundColor: `rgb(${s.accent[0]},${s.accent[1]},${s.accent[2]})` }}
              />
              {s.name}
            </button>
          ))}
        </div>

        <label className="block text-xs text-gray-400">
          Strength: {(styleStrength * 100).toFixed(0)}%
          <input
            type="range" min={0} max={1} step={0.05}
            value={styleStrength}
            onChange={(e) => setStyleStrength(parseFloat(e.target.value))}
            className="w-full mt-1 accent-amber-500"
          />
        </label>

        <button
          onClick={apply}
          disabled={!image}
          className="w-full py-2 text-xs font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40"
        >
          Apply Style
        </button>

        {info && (
          <div className="text-xs text-gray-400 space-y-1">
            <p>Material: <span className="text-gray-200">{info.material}</span></p>
            <p>Fonts: <span className="text-gray-200">{info.fonts.join(', ')}</span></p>
          </div>
        )}
      </div>

      {/* Preview */}
      <div className="flex-1 flex items-center justify-center bg-surface-0 p-4 gap-4">
        <PreviewBox label="Original" src={image} />
        <PreviewBox label="Styled" src={resultUrl} />
      </div>
    </div>
  )
}


function ComponentDetectionTab() {
  const image = useCurrentImage()
  const { capabilities, detectionConfidence, setDetectionConfidence, setProcessing, setProgress } = useAIStore()
  const addAsset = useAssetStore((s) => s.addAsset)
  const [detections, setDetections] = useState<AIDetection[]>([])
  const [useGemma, setUseGemma] = useState(false)
  const [useSAM, setUseSAM] = useState(false)

  const gemmaAvailable = capabilities?.gemma ?? false
  const samAvailable = capabilities?.sam2 ?? false

  const detect = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress('Detecting components...')
    try {
      let result: { detections: AIDetection[]; count: number }

      if (useSAM) {
        // Use SAM2 auto-segment for better object detection
        setProgress('Running SAM2 auto-segmentation...')
        const samResult = await pythonClient.sam2AutoSegment(image, 200)
        result = {
          detections: samResult.segments.map((seg, i) => ({
            id: `sam_${i}`,
            type: (seg as any).type || 'unknown',
            sub_type: 'sam2',
            confidence: seg.score,
            bounds: seg.bounds,
            center: {
              x: seg.bounds.x + seg.bounds.width / 2,
              y: seg.bounds.y + seg.bounds.height / 2,
            },
            preview: seg.dataUrl,
          })),
          count: samResult.count,
        }
      } else {
        // Standard OpenCV detection
        result = await pythonClient.aiDetectComponents(image, {
          confidenceThreshold: detectionConfidence,
        })
      }

      // Optionally enhance with Gemma
      if (useGemma && gemmaAvailable && result.detections.length > 0) {
        setProgress('Enhancing with Gemma AI...')
        const enhanced = await pythonClient.gemmaEnhanceDetections(image, result.detections)
        result.detections = enhanced.detections as AIDetection[]
      }

      setDetections(result.detections)
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image, detectionConfidence, useGemma, useSAM, gemmaAvailable])

  const addToLibrary = useCallback((det: AIDetection) => {
    addAsset({
      id: det.id,
      name: (det as any).ai_name || `${det.type}-${det.sub_type}`,
      type: (det.type === 'knob' || det.type === 'slider' || det.type === 'button' || det.type === 'led' || det.type === 'screen' || det.type === 'meter' ? det.type : 'decoration') as any,
      sourceImageId: 'ai-detected',
      extractionMethod: 'rect',
      extractionParams: { confidence: det.confidence },
      maskDataUrl: det.preview,
      bounds: det.bounds,
      metadata: {
        centerPoint: det.center,
        createdAt: new Date().toISOString(),
        tags: [det.type, det.sub_type, 'ai-detected'],
      },
    })
  }, [addAsset])

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="w-64 p-4 border-r border-surface-3 space-y-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">Detection Settings</h3>
        <label className="block text-xs text-gray-400">
          Min Confidence: {(detectionConfidence * 100).toFixed(0)}%
          <input
            type="range" min={0.1} max={0.9} step={0.05}
            value={detectionConfidence}
            onChange={(e) => setDetectionConfidence(parseFloat(e.target.value))}
            className="w-full mt-1 accent-amber-500"
          />
        </label>

        {/* SAM2 toggle */}
        <label className={`flex items-center gap-2 text-xs ${samAvailable ? 'text-gray-300' : 'text-gray-600'}`}>
          <input
            type="checkbox"
            checked={useSAM}
            disabled={!samAvailable}
            onChange={e => setUseSAM(e.target.checked)}
            className="accent-amber-500"
          />
          Use SAM2 Segmentation
          {!samAvailable && <span className="text-[10px] text-gray-600">(not installed)</span>}
        </label>

        {/* Gemma enhance toggle */}
        <label className={`flex items-center gap-2 text-xs ${gemmaAvailable ? 'text-gray-300' : 'text-gray-600'}`}>
          <input
            type="checkbox"
            checked={useGemma}
            disabled={!gemmaAvailable}
            onChange={e => setUseGemma(e.target.checked)}
            className="accent-amber-500"
          />
          Enhance with Gemma AI
          {!gemmaAvailable && <span className="text-[10px] text-gray-600">(not available)</span>}
        </label>

        <button
          onClick={detect}
          disabled={!image}
          className="w-full py-2 text-xs font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40"
        >
          Detect Components
        </button>
        <p className="text-xs text-gray-500">{detections.length} components found</p>
      </div>

      <div className="flex-1 p-4 overflow-y-auto">
        {!image ? (
          <div className="flex items-center justify-center h-full">
            <ImageDropZone label="Drop panel image to detect components" />
          </div>
        ) : detections.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Click "Detect Components" to analyze
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            {detections.map((det) => (
              <div key={det.id} className="bg-surface-2 rounded-lg p-2 space-y-2">
                <img src={det.preview} alt={det.type} className="w-full aspect-square object-contain bg-surface-0 rounded" />
                <div className="text-xs">
                  <span className="text-gray-200 font-medium">{(det as any).ai_name || det.type}</span>
                  <span className="text-gray-500 ml-1">({det.sub_type})</span>
                  <div className="text-gray-500">{(det.confidence * 100).toFixed(0)}% confidence</div>
                </div>
                <button
                  onClick={() => addToLibrary(det)}
                  className="w-full py-1 text-[10px] bg-accent/20 text-accent rounded hover:bg-accent/30"
                >
                  Add to Library
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}


function LightingTab() {
  const image = useCurrentImage()
  const {
    targetAzimuth, targetElevation, lightingStrength,
    setTargetAzimuth, setTargetElevation, setLightingStrength,
    setProcessing, setProgress, setLastResult,
  } = useAIStore()
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<LightingEstimate | null>(null)

  const analyze = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress('Analyzing lighting...')
    try {
      const est = await pythonClient.aiEstimateLighting(image)
      setEstimate(est)
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image])

  const normalize = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress('Normalizing lighting...')
    try {
      const result = await pythonClient.aiNormalizeLighting(image, targetAzimuth, targetElevation, lightingStrength)
      setResultUrl(result.dataUrl)
      setLastResult(result.dataUrl)
      setEstimate(result.original_lighting)
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image, targetAzimuth, targetElevation, lightingStrength])

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="w-72 p-4 border-r border-surface-3 space-y-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">Lighting Analysis</h3>
        <button
          onClick={analyze}
          disabled={!image}
          className="w-full py-1.5 text-xs bg-surface-3 rounded hover:bg-surface-4 disabled:opacity-40"
        >
          Analyze Current Lighting
        </button>
        {estimate && (
          <div className="text-xs text-gray-400 space-y-1 p-2 bg-surface-2 rounded">
            <p>Azimuth: <span className="text-gray-200">{estimate.azimuth.toFixed(1)}°</span></p>
            <p>Elevation: <span className="text-gray-200">{estimate.elevation.toFixed(1)}°</span></p>
            <p>Confidence: <span className="text-gray-200">{(estimate.confidence * 100).toFixed(0)}%</span></p>
          </div>
        )}

        <h3 className="text-xs font-semibold text-gray-400 uppercase pt-2">Target Lighting</h3>
        <label className="block text-xs text-gray-400">
          Azimuth: {targetAzimuth.toFixed(0)}°
          <input
            type="range" min={0} max={360} step={5}
            value={targetAzimuth}
            onChange={(e) => setTargetAzimuth(parseFloat(e.target.value))}
            className="w-full mt-1 accent-amber-500"
          />
        </label>
        <label className="block text-xs text-gray-400">
          Elevation: {targetElevation.toFixed(0)}°
          <input
            type="range" min={10} max={85} step={5}
            value={targetElevation}
            onChange={(e) => setTargetElevation(parseFloat(e.target.value))}
            className="w-full mt-1 accent-amber-500"
          />
        </label>
        <label className="block text-xs text-gray-400">
          Strength: {(lightingStrength * 100).toFixed(0)}%
          <input
            type="range" min={0} max={1} step={0.05}
            value={lightingStrength}
            onChange={(e) => setLightingStrength(parseFloat(e.target.value))}
            className="w-full mt-1 accent-amber-500"
          />
        </label>
        <button
          onClick={normalize}
          disabled={!image}
          className="w-full py-2 text-xs font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40"
        >
          Normalize Lighting
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center bg-surface-0 p-4 gap-4">
        <PreviewBox label="Original" src={image} />
        <PreviewBox label="Normalized" src={resultUrl} />
      </div>
    </div>
  )
}


function UpscaleTab() {
  const image = useCurrentImage()
  const { upscaleScale, upscaleSharpen, setUpscaleScale, setUpscaleSharpen, setProcessing, setProgress, setLastResult } = useAIStore()
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [info, setInfo] = useState<{ method: string; from: string; to: string } | null>(null)

  const run = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress(`Upscaling ${upscaleScale}x...`)
    try {
      const result = await pythonClient.aiUpscale(image, upscaleScale, upscaleSharpen)
      setResultUrl(result.dataUrl)
      setLastResult(result.dataUrl)
      setInfo({
        method: result.method,
        from: `${result.original_size.width}×${result.original_size.height}`,
        to: `${result.new_size.width}×${result.new_size.height}`,
      })
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image, upscaleScale, upscaleSharpen])

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="w-64 p-4 border-r border-surface-3 space-y-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">Upscale Settings</h3>
        <div className="flex gap-2">
          {([2, 4] as const).map((s) => (
            <button
              key={s}
              onClick={() => setUpscaleScale(s)}
              className={`flex-1 py-2 text-sm rounded ${
                upscaleScale === s ? 'bg-accent text-black font-semibold' : 'bg-surface-3 text-gray-300'
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        <label className="block text-xs text-gray-400">
          Sharpen: {(upscaleSharpen * 100).toFixed(0)}%
          <input
            type="range" min={0} max={1} step={0.05}
            value={upscaleSharpen}
            onChange={(e) => setUpscaleSharpen(parseFloat(e.target.value))}
            className="w-full mt-1 accent-amber-500"
          />
        </label>
        <button
          onClick={run}
          disabled={!image}
          className="w-full py-2 text-xs font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40"
        >
          Upscale Image
        </button>
        {info && (
          <div className="text-xs text-gray-400 space-y-1">
            <p>Method: <span className="text-gray-200">{info.method}</span></p>
            <p>{info.from} → <span className="text-accent">{info.to}</span></p>
          </div>
        )}
      </div>
      <div className="flex-1 flex items-center justify-center bg-surface-0 p-4 gap-4">
        <PreviewBox label="Original" src={image} />
        <PreviewBox label="Upscaled" src={resultUrl} />
      </div>
    </div>
  )
}


function SymmetryTab() {
  const image = useCurrentImage()
  const {
    symmetryType, symmetryStrength, setSymmetryType, setSymmetryStrength,
    setProcessing, setProgress, setLastResult,
  } = useAIStore()
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<SymmetryAnalysis | null>(null)
  const [errInfo, setErrInfo] = useState<{ before: number; after: number } | null>(null)

  const analyze = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress('Analyzing symmetry...')
    try {
      const a = await pythonClient.aiDetectSymmetry(image)
      setAnalysis(a)
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image])

  const enforce = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress('Enforcing symmetry...')
    try {
      const result = await pythonClient.aiEnforceSymmetry(image, symmetryType, symmetryStrength)
      setResultUrl(result.dataUrl)
      setLastResult(result.dataUrl)
      setErrInfo({ before: result.error_before, after: result.error_after })
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image, symmetryType, symmetryStrength])

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="w-72 p-4 border-r border-surface-3 space-y-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">Symmetry Analysis</h3>
        <button
          onClick={analyze}
          disabled={!image}
          className="w-full py-1.5 text-xs bg-surface-3 rounded hover:bg-surface-4 disabled:opacity-40"
        >
          Analyze Symmetry
        </button>
        {analysis && (
          <div className="text-xs text-gray-400 space-y-1 p-2 bg-surface-2 rounded">
            <p>Best: <span className="text-accent">{analysis.best_type}</span></p>
            <p>Horizontal: {(analysis.horizontal_score * 100).toFixed(0)}%</p>
            <p>Vertical: {(analysis.vertical_score * 100).toFixed(0)}%</p>
            <p>Radial: {(analysis.radial_score * 100).toFixed(0)}%</p>
          </div>
        )}

        <h3 className="text-xs font-semibold text-gray-400 uppercase pt-2">Enforce Symmetry</h3>
        <div className="grid grid-cols-2 gap-1.5">
          {(['auto', 'horizontal', 'vertical', 'radial'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setSymmetryType(t)}
              className={`py-1.5 text-xs rounded capitalize ${
                symmetryType === t ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-gray-400'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <label className="block text-xs text-gray-400">
          Strength: {(symmetryStrength * 100).toFixed(0)}%
          <input
            type="range" min={0} max={1} step={0.05}
            value={symmetryStrength}
            onChange={(e) => setSymmetryStrength(parseFloat(e.target.value))}
            className="w-full mt-1 accent-amber-500"
          />
        </label>
        <button
          onClick={enforce}
          disabled={!image}
          className="w-full py-2 text-xs font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40"
        >
          Make Symmetrical
        </button>
        {errInfo && (
          <div className="text-xs text-gray-400">
            Error: {(errInfo.before * 100).toFixed(1)}% → <span className="text-accent">{(errInfo.after * 100).toFixed(1)}%</span>
          </div>
        )}
      </div>
      <div className="flex-1 flex items-center justify-center bg-surface-0 p-4 gap-4">
        <PreviewBox label="Original" src={image} />
        <PreviewBox label="Symmetrical" src={resultUrl} />
      </div>
    </div>
  )
}


function InpaintingTab() {
  const image = useCurrentImage()
  const {
    inpaintMethod, inpaintRadius, setInpaintMethod, setInpaintRadius,
    setProcessing, setProgress, setLastResult,
  } = useAIStore()
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [textInfo, setTextInfo] = useState<{ regions: number; pixels: number } | null>(null)

  const autoRemove = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress('Detecting and removing text...')
    try {
      const result = await pythonClient.aiAutoRemoveText(image, inpaintMethod, inpaintRadius)
      setResultUrl(result.dataUrl)
      setLastResult(result.dataUrl)
      setTextInfo({ regions: result.regions_found, pixels: result.pixels_inpainted })
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image, inpaintMethod, inpaintRadius])

  const removeBg = useCallback(async () => {
    if (!image) return
    setProcessing(true)
    setProgress('Removing background...')
    try {
      const result = await pythonClient.aiRemoveBackground(image)
      setResultUrl(result.dataUrl)
      setLastResult(result.dataUrl)
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [image])

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="w-64 p-4 border-r border-surface-3 space-y-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">Text Removal</h3>
        <div className="flex gap-2">
          {(['telea', 'navier-stokes'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setInpaintMethod(m)}
              className={`flex-1 py-1.5 text-xs rounded ${
                inpaintMethod === m ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-gray-400'
              }`}
            >
              {m === 'telea' ? 'Fast' : 'Smooth'}
            </button>
          ))}
        </div>
        <label className="block text-xs text-gray-400">
          Radius: {inpaintRadius}px
          <input
            type="range" min={2} max={20} step={1}
            value={inpaintRadius}
            onChange={(e) => setInpaintRadius(parseInt(e.target.value))}
            className="w-full mt-1 accent-amber-500"
          />
        </label>
        <button
          onClick={autoRemove}
          disabled={!image}
          className="w-full py-2 text-xs font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40"
        >
          Auto Remove Text
        </button>
        {textInfo && (
          <div className="text-xs text-gray-400">
            Removed {textInfo.regions} regions ({textInfo.pixels.toLocaleString()} pixels)
          </div>
        )}

        <div className="border-t border-surface-3 pt-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase">Background Removal</h3>
          <button
            onClick={removeBg}
            disabled={!image}
            className="w-full py-2 mt-2 text-xs font-semibold rounded bg-surface-3 text-gray-200 hover:bg-surface-4 disabled:opacity-40"
          >
            Remove Background
          </button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center bg-surface-0 p-4 gap-4">
        <PreviewBox label="Original" src={image} />
        <PreviewBox label="Cleaned" src={resultUrl} />
      </div>
    </div>
  )
}


function GenerateTab() {
  const {
    generationPresets, generatePrompt, generateType, generatePreset,
    setGenerationPresets, setGeneratePrompt, setGenerateType, setGeneratePreset,
    setProcessing, setProgress, setLastResult,
  } = useAIStore()
  const addAsset = useAssetStore((s) => s.addAsset)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [genInfo, setGenInfo] = useState<{ method: string; available: boolean; hint?: string } | null>(null)

  useEffect(() => {
    if (generationPresets.length === 0) {
      pythonClient.aiGetGenerationPresets().then((r) => setGenerationPresets(r.presets)).catch(() => {})
    }
  }, [])

  const generate = useCallback(async () => {
    if (!generatePrompt.trim()) return
    setProcessing(true)
    setProgress('Generating component...')
    try {
      const result = await pythonClient.aiGenerateComponent(generatePrompt, generateType, generatePreset)
      setResultUrl(result.dataUrl)
      setLastResult(result.dataUrl)
      setGenInfo({ method: result.method, available: result.available, hint: result.install_hint })
    } catch (e: any) {
      setProgress(`Error: ${e.message}`)
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [generatePrompt, generateType, generatePreset])

  const addToLib = useCallback(() => {
    if (!resultUrl) return
    addAsset({
      id: `gen_${Date.now()}`,
      name: generatePrompt.slice(0, 30),
      type: (generateType === 'knob' || generateType === 'slider' || generateType === 'button' || generateType === 'led' || generateType === 'screen' || generateType === 'meter' ? generateType : 'decoration') as any,
      sourceImageId: 'ai-generated',
      extractionMethod: 'rect',
      extractionParams: { prompt: generatePrompt, preset: generatePreset },
      maskDataUrl: resultUrl,
      bounds: { x: 0, y: 0, width: 512, height: 512 },
      metadata: {
        createdAt: new Date().toISOString(),
        tags: [generateType, 'generated', generatePreset],
      },
    })
  }, [resultUrl, generatePrompt, generateType, generatePreset, addAsset])

  const TYPES = ['knob', 'button', 'slider', 'screen', 'led', 'meter', 'logo']

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="w-80 p-4 border-r border-surface-3 space-y-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">Prompt-to-Component</h3>
        <textarea
          value={generatePrompt}
          onChange={(e) => setGeneratePrompt(e.target.value)}
          placeholder="e.g. large vintage aluminum knob with red indicator, 1970s Moog style"
          className="w-full h-20 p-2 text-xs bg-surface-2 border border-surface-3 rounded resize-none focus:border-accent outline-none"
        />

        <div>
          <label className="text-xs text-gray-400">Component Type</label>
          <div className="flex flex-wrap gap-1 mt-1">
            {TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setGenerateType(t)}
                className={`px-2 py-1 text-xs rounded capitalize ${
                  generateType === t ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-gray-400'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-400">Style</label>
          <div className="flex flex-wrap gap-1 mt-1">
            {generationPresets.map((p) => (
              <button
                key={p.id}
                onClick={() => setGeneratePreset(p.id)}
                className={`px-2 py-1 text-xs rounded ${
                  generatePreset === p.id ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-gray-400'
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={generate}
          disabled={!generatePrompt.trim()}
          className="w-full py-2 text-xs font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40"
        >
          Generate
        </button>

        {genInfo && (
          <div className="text-xs text-gray-400 space-y-1">
            <p>Method: <span className="text-gray-200">{genInfo.method}</span></p>
            {!genInfo.available && genInfo.hint && (
              <p className="text-amber-400/70 text-[10px]">{genInfo.hint}</p>
            )}
          </div>
        )}

        {resultUrl && (
          <button
            onClick={addToLib}
            className="w-full py-2 text-xs bg-surface-3 rounded hover:bg-surface-4 text-gray-200"
          >
            Add to Library
          </button>
        )}
      </div>

      <div className="flex-1 flex items-center justify-center bg-surface-0 p-4">
        {resultUrl ? (
          <div className="text-center">
            <img src={resultUrl} alt="Generated" className="max-h-[70vh] max-w-[70vw] object-contain rounded bg-surface-1" />
            <p className="text-xs text-gray-500 mt-2">{generatePrompt}</p>
          </div>
        ) : (
          <div className="text-gray-500 text-sm">Enter a prompt and click Generate</div>
        )}
      </div>
    </div>
  )
}


// ─── Shared Components ───

function PreviewBox({ label, src }: { label: string; src: string | null }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-xs text-gray-500">{label}</span>
      {src ? (
        <img src={src} alt={label} className="max-h-[65vh] max-w-[40vw] object-contain rounded bg-surface-1 border border-surface-3" />
      ) : (
        <ImageDropZone />
      )}
    </div>
  )
}

// ─── ImageDropZone: drag-and-drop image loader ───
function ImageDropZone({ label }: { label?: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleFile = useCallback(async (file: File) => {
    setErr(null)
    try { await loadImageIntoStore(file) } catch (e: any) { setErr(e.message) }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }, [handleFile])

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
      className={`flex flex-col items-center justify-center gap-3 w-64 h-52 border-2 border-dashed rounded-xl cursor-pointer transition-all select-none ${
        dragging ? 'border-accent bg-accent/10 scale-105' : 'border-surface-4 hover:border-accent/50 bg-surface-1 hover:bg-surface-2'
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }}
      />
      <svg className="w-10 h-10 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      <div className="text-center px-4">
        <p className="text-xs text-gray-400 font-medium">{label ?? 'Drop image here'}</p>
        <p className="text-[10px] text-gray-600 mt-0.5">or click to browse</p>
        <p className="text-[10px] text-gray-600">PNG · JPEG · WebP</p>
      </div>
      {err && <p className="text-[10px] text-red-400 px-3 text-center">{err}</p>}
    </div>
  )
}


// ═══════════════════════════════════════════════════════════
//  GEMMA AI TAB — Local LLM-powered image analysis
// ═══════════════════════════════════════════════════════════

type GemmaMode = 'analyze' | 'style' | 'layout' | 'name' | 'chat'

function GemmaTab() {
  const currentImage = useCurrentImage()
  const { capabilities, capabilitiesLoading, processing, setProcessing, setProgress } = useAIStore()
  const [mode, setMode] = useState<GemmaMode>('analyze')
  const [result, setResult] = useState<any>(null)
  const [chatPrompt, setChatPrompt] = useState('')
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'assistant' | 'error'; text: string }[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)

  const gemmaAvailable = capabilities?.gemma ?? false
  const gemmaModel = capabilities?.gemma_model ?? null
  const gemmaHint = capabilities?.gemma_status?.install_hint ?? ''

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory])

  const runAnalyze = useCallback(async () => {
    if (!currentImage) return
    setProcessing(true); setProgress('Analyzing panel with Gemma...')
    try { const res = await pythonClient.gemmaAnalyzePanel(currentImage); setResult(res.analysis) }
    catch (e: any) { setResult({ error: e.message }) }
    finally { setProcessing(false); setProgress('') }
  }, [currentImage])

  const runStyle = useCallback(async () => {
    if (!currentImage) return
    setProcessing(true); setProgress('Suggesting style with Gemma...')
    try { const res = await pythonClient.gemmaSuggestStyle(currentImage); setResult(res.suggestion) }
    catch (e: any) { setResult({ error: e.message }) }
    finally { setProcessing(false); setProgress('') }
  }, [currentImage])

  const runLayout = useCallback(async () => {
    if (!currentImage) return
    setProcessing(true); setProgress('Analyzing layout with Gemma...')
    try { const res = await pythonClient.gemmaDescribeLayout(currentImage); setResult(res.layout) }
    catch (e: any) { setResult({ error: e.message }) }
    finally { setProcessing(false); setProgress('') }
  }, [currentImage])

  const runName = useCallback(async () => {
    if (!currentImage) return
    setProcessing(true); setProgress('Identifying component...')
    try { const res = await pythonClient.gemmaNameComponent(currentImage, 'knob'); setResult(res.naming) }
    catch (e: any) { setResult({ error: e.message }) }
    finally { setProcessing(false); setProgress('') }
  }, [currentImage])

  const sendChat = useCallback(async () => {
    if (!chatPrompt.trim()) return
    const userMsg = chatPrompt.trim()
    setChatPrompt('')
    setChatHistory(prev => [...prev, { role: 'user', text: userMsg }])
    setProcessing(true)
    try {
      const res = await pythonClient.gemmaGenerate(userMsg, currentImage ?? undefined)
      setChatHistory(prev => [...prev, { role: 'assistant', text: res.response }])
    } catch (e: any) {
      setChatHistory(prev => [...prev, { role: 'error', text: e.message }])
    } finally {
      setProcessing(false)
    }
  }, [chatPrompt, currentImage])

  const modeActions: Record<Exclude<GemmaMode, 'chat'>, () => void> = {
    analyze: runAnalyze, style: runStyle, layout: runLayout, name: runName,
  }

  const modeLabels: Record<GemmaMode, string> = {
    analyze: '🔍 Analyze Panel',
    style: '🎨 Suggest Style',
    layout: '📐 Layout Analysis',
    name: '🏷️ Name Component',
    chat: '💬 Free Chat',
  }

  // ── Loading state ──
  if (capabilitiesLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-400">Checking AI capabilities...</p>
        </div>
      </div>
    )
  }

  // ── Unavailable state ──
  if (!gemmaAvailable) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-sm text-center space-y-5">
          <div className="text-5xl">🧠</div>
          <h3 className="text-base font-semibold text-gray-200">Gemma AI Not Available</h3>
          <p className="text-sm text-gray-400">
            Gemma requires <span className="text-accent font-medium">Ollama</span> running locally with a Gemma model installed.
          </p>
          <div className="bg-surface-2 border border-surface-3 rounded-lg p-4 text-left space-y-2">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Setup</p>
            <ol className="text-xs text-gray-300 space-y-1.5 list-decimal list-inside">
              <li>Install Ollama from <span className="text-accent">https://ollama.com</span></li>
              <li>Run: <code className="bg-surface-3 px-1.5 py-0.5 rounded text-accent font-mono">ollama pull gemma3:4b</code></li>
              <li>Restart SynthSkin Studio</li>
            </ol>
          </div>
          {gemmaHint && <p className="text-[10px] text-gray-600">{gemmaHint}</p>}
        </div>
      </div>
    )
  }

  // ── Main layout ──
  return (
    <div className="flex flex-1 overflow-hidden">

      {/* ─── Left sidebar: mode selector + controls ─── */}
      <div className="w-60 border-r border-surface-3 p-4 space-y-4 overflow-y-auto flex-shrink-0">
        {/* Model badge */}
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
          <span className="text-[10px] text-gray-400">
            <span className="text-accent font-semibold">{gemmaModel}</span> · ready
          </span>
        </div>

        {/* Mode buttons */}
        <div className="flex flex-col gap-1">
          {(Object.keys(modeLabels) as GemmaMode[]).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setResult(null) }}
              className={`px-3 py-2 text-xs rounded text-left transition-colors ${
                mode === m
                  ? 'bg-accent/20 text-accent border border-accent/30'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-3'
              }`}
            >
              {modeLabels[m]}
            </button>
          ))}
        </div>

        {/* Run button (non-chat modes) */}
        {mode !== 'chat' && (
          <>
            <button
              onClick={modeActions[mode as Exclude<GemmaMode, 'chat'>]}
              disabled={processing || !currentImage}
              className="w-full py-2 text-xs font-semibold rounded bg-accent text-black hover:bg-amber-400 disabled:opacity-40 transition-colors"
            >
              {processing ? 'Processing...' : `Run ${mode.charAt(0).toUpperCase() + mode.slice(1)}`}
            </button>

            {!currentImage && (
              <p className="text-[10px] text-amber-400/70 bg-amber-400/5 border border-amber-400/10 rounded p-2">
                Drop an image on the right to get started →
              </p>
            )}

            {/* Result */}
            {result && (
              <div className="bg-surface-2 rounded-lg p-3 overflow-y-auto max-h-[50vh]">
                {result.error ? (
                  <p className="text-xs text-red-400">{result.error}</p>
                ) : (
                  <pre className="text-[10px] text-gray-300 font-mono whitespace-pre-wrap leading-relaxed">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </>
        )}

        {/* Image thumbnail (chat mode) */}
        {mode === 'chat' && currentImage && (
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500">Image context:</p>
            <img src={currentImage} alt="context" className="w-full max-h-24 object-contain rounded bg-surface-2" />
          </div>
        )}
        {mode === 'chat' && !currentImage && (
          <p className="text-[10px] text-gray-600 italic">No image loaded — text-only chat</p>
        )}
      </div>

      {/* ─── Right area: chat UI or image preview ─── */}
      {mode === 'chat' ? (
        <div className="flex-1 flex flex-col bg-surface-0 min-h-0">
          {/* Chat history */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4 min-h-0">
            {chatHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4 opacity-50">
                <div className="text-6xl">🧠</div>
                <p className="text-sm text-gray-400 text-center max-w-xs">
                  Ask Gemma anything about your panel design.
                  {currentImage
                    ? ' The loaded image will be sent as context.'
                    : ' Load an image on the left for visual analysis.'}
                </p>
              </div>
            ) : (
              chatHistory.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`text-[10px] font-semibold shrink-0 mt-1 w-12 text-center ${
                    msg.role === 'user' ? 'text-accent'
                    : msg.role === 'error' ? 'text-red-400'
                    : 'text-gray-500'
                  }`}>
                    {msg.role === 'user' ? 'You' : msg.role === 'error' ? 'Error' : 'Gemma'}
                  </div>
                  <div className={`flex-1 text-sm p-3 rounded-xl leading-relaxed ${
                    msg.role === 'user' ? 'bg-accent/15 text-gray-200 rounded-tr-sm'
                    : msg.role === 'error' ? 'bg-red-900/30 text-red-300'
                    : 'bg-surface-2 text-gray-300 rounded-tl-sm'
                  }`}>
                    <span className="whitespace-pre-wrap">{msg.text}</span>
                  </div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input bar */}
          <div className="flex gap-2 p-4 border-t border-surface-3 bg-surface-1 flex-shrink-0">
            <textarea
              value={chatPrompt}
              onChange={e => setChatPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
              placeholder="Ask about your design... (Enter to send · Shift+Enter for new line)"
              rows={2}
              className="flex-1 bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent resize-none"
            />
            <button
              onClick={sendChat}
              disabled={processing || !chatPrompt.trim()}
              className="px-5 text-sm bg-accent text-black rounded-lg font-semibold disabled:opacity-40 self-stretch hover:bg-amber-400 transition-colors"
            >
              {processing ? '...' : 'Send'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 bg-surface-0">
          {currentImage
            ? <PreviewBox label="Current Image" src={currentImage} />
            : <ImageDropZone label="Drop your panel image here" />
          }
        </div>
      )}
    </div>
  )
}
