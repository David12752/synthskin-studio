/**
 * AnalyzerInspector — all controls for the Semantic Panel Analyzer,
 * rendered inside the right Inspector panel when panelAnalyzerOpen.
 *
 * State is shared with the canvas component (SemanticLayoutAnalyzer)
 * via semanticAnalyzerStore and panelLayoutStore.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { pythonClient, type PanelPipelineCapabilities } from '../../lib/api/pythonClient'
import { useImageStore } from '../../stores/imageStore'
import { usePanelLayoutStore } from '../../stores/panelLayoutStore'
import ReviewQueue from './ReviewQueue'
import DeHaloPreviewCard from './DeHaloPreviewCard'
import { useSemanticAnalyzerStore } from '../../stores/semanticAnalyzerStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import ModelPicker from './ModelPicker'

const STAGE_LABELS: Record<string, string> = {
  decode: 'Decoding image…',
  detect: 'Loading AI models & detecting components…',
  segment: 'Segmenting controls (masks)…',
  ocr: 'Reading text labels (OCR)…',
  features: 'Extracting knob angles, slider positions…',
  linking: 'Linking labels to controls…',
  done: 'Analysis complete',
}

function friendlyMessage(stage: string, msg: string): string {
  if (msg.includes('optimized synth-control detection')) return 'Detecting knobs, sliders and LEDs…'
  if (msg.includes('Gemini:')) return msg.replace('Gemini:', 'Found')
  if (msg.includes('Heuristic fallback')) return 'Using fast OpenCV detection (no GPU)…'
  if (msg.includes('unavailable — falling back')) return `⚠ ${msg}`
  if (msg.includes('GrabCut')) return 'Cutting out controls (fast CPU mode)…'
  if (msg.includes('SAM2') || msg.includes('SAM 2')) return 'AI segmentation (precise masks)…'
  if (msg.includes('Reading text')) return 'Reading panel text with OCR…'
  if (msg.includes('Extracting')) return 'Measuring knob angles & slider positions…'
  if (msg.includes('Linking')) return 'Matching labels to their controls…'
  return STAGE_LABELS[stage] ?? msg
}

function CapabilityBadge({ caps }: { caps: PanelPipelineCapabilities | null }) {
  if (!caps) return null
  const pill = (label: string, ok: boolean, warn?: boolean) => (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
      ok ? 'bg-emerald-500/15 text-emerald-300'
         : warn ? 'bg-yellow-500/15 text-yellow-300'
         : 'bg-red-500/15 text-red-300'
    }`}>
      {label}
    </span>
  )

  // Gemini: green = probe OK, amber = probe pending, red = unavailable/invalid
  const geminiStatus = caps.gemini_probe_ok
    ? pill(`Gemini ${caps.gemini_active_model ? `(${caps.gemini_active_model.replace('gemini-', '')})` : ''}`, true)
    : caps.gemini_probe_pending
      ? pill('Gemini key (probing…)', false, true)
      : caps.gemini_key_set
        ? pill(caps.gemini_probe_error || 'Gemini unavailable', false)
      : pill('Gemini', false)

  return (
    <div className="flex flex-wrap gap-1.5">
      {geminiStatus}
      {pill('SAM 2', caps.sam2)}
      {pill('Detector', !!caps.custom_yolo)}
      {!caps.custom_yolo && caps.yolo && (
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300">
          YOLO fallback
        </span>
      )}
      {pill('OCR', caps.rapidocr)}
      <span className="text-[9px] font-mono text-white/40">{caps.device}</span>
    </div>
  )
}

function Section({ title, children, tone = 'default' }: { title: string; children: ReactNode; tone?: 'default' | 'warning' | 'info' }) {
  const toneClass = tone === 'warning'
    ? 'bg-yellow-900/10 border-yellow-500/15'
    : tone === 'info'
      ? 'bg-surface-2/80 border-white/10'
      : 'bg-surface-2/55 border-white/8'

  return (
    <section className={`rounded-xl border ${toneClass} p-3 backdrop-blur-sm`}>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/35">{title}</div>
      {children}
    </section>
  )
}

export default function AnalyzerInspector() {
  const { sourceImage } = useImageStore()
  const layout = usePanelLayoutStore((s) => s.layout)
  const selectedControlIds = usePanelLayoutStore((s) => s.selectedControlIds)
  const showMasks = usePanelLayoutStore((s) => s.showMasks)
  const showLabels = usePanelLayoutStore((s) => s.showLabels)
  const showBoxes = usePanelLayoutStore((s) => s.showBoxes)
  const editMode = usePanelLayoutStore((s) => s.editMode)
  const setShowMasks = usePanelLayoutStore((s) => s.setShowMasks)
  const setShowLabels = usePanelLayoutStore((s) => s.setShowLabels)
  const setShowBoxes = usePanelLayoutStore((s) => s.setShowBoxes)
  const setEditMode = usePanelLayoutStore((s) => s.setEditMode)

  const st = useSemanticAnalyzerStore
  const minConfidence = st((s) => s.minConfidence)
  const detectLabels = st((s) => s.detectLabels)
  const fastMode = st((s) => s.fastMode)
  const detectionModel = st((s) => s.detectionModel)
  const loading = st((s) => s.loading)
  const error = st((s) => s.error)
  const capabilities = st((s) => s.capabilities)
  const progressStage = st((s) => s.progressStage)
  const progressPct = st((s) => s.progressPct)
  const progressMsg = st((s) => s.progressMsg)
  const elapsed = st((s) => s.elapsed)

  const setMinConfidence = st((s) => s.setMinConfidence)
  const setDetectLabels = st((s) => s.setDetectLabels)
  const setFastMode = st((s) => s.setFastMode)
  const setDetectionModel = st((s) => s.setDetectionModel)
  const setCaps = st((s) => s.setCaps)
  const requestAnalyze = st((s) => s.requestAnalyze)
  const requestCancel = st((s) => s.requestCancel)
  const professionalDetectorReady = !!capabilities?.professional_detector_ready
  const geminiReady = !!capabilities?.gemini_probe_ok
  const detectorFallbackOnly = !!capabilities && !professionalDetectorReady && !geminiReady

  // Auto-switch to Gemini when the API probe succeeds and model is still default
  useEffect(() => {
    if (capabilities?.gemini_probe_ok && detectionModel === 'auto') {
      setDetectionModel('gemini')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities?.gemini_probe_ok])

  useEffect(() => {
    if (detectionModel === 'gemini' && capabilities?.gemini_key_set && !capabilities.gemini_probe_ok && !capabilities.gemini_probe_pending) {
      setDetectionModel('auto')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectionModel, capabilities?.gemini_key_set, capabilities?.gemini_probe_ok, capabilities?.gemini_probe_pending])

  const handleExportJson = () => {
    if (!layout) return
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'panel-layout.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-surface-1">
      <div className="shrink-0 border-b border-white/8 bg-gradient-to-b from-surface-2 to-surface-1 px-3 py-3">
        <div className="mb-2 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#f59e0b" strokeWidth="1.5">
            <rect x="1" y="1" width="14" height="14" rx="1" />
            <circle cx="4.5" cy="4.5" r="1.5" />
            <circle cx="11.5" cy="4.5" r="1.5" />
            <rect x="3" y="9" width="10" height="2" />
          </svg>
          <span className="text-[11px] font-semibold text-white tracking-wide">Panel Analysis</span>
          {layout && (
            <span className="ml-auto text-[10px] text-muted">
              {layout.controlCount}c · {layout.sectionCount}s
            </span>
          )}
        </div>
        <CapabilityBadge caps={capabilities} />
      </div>

      <>
      <div className="shrink-0 sticky top-0 z-10 border-b border-white/8 bg-surface-1/95 px-3 py-3 backdrop-blur">
        <div className="space-y-2.5">
          {detectorFallbackOnly && (
            <div className="rounded-xl border border-orange-500/25 bg-orange-500/10 px-3 py-2 text-[10px] text-orange-200 leading-relaxed">
              Weak detection mode — no trained model or Gemini key found.
              For best results: set a Gemini API key in Settings, or train a model in the TRAIN workspace.
            </div>
          )}

          <button
            onClick={loading ? requestCancel : requestAnalyze}
            disabled={!sourceImage?.dataUrl}
            className={`w-full border text-[11px] font-semibold py-2.5 px-3 rounded-xl transition-colors disabled:opacity-40 ${
              loading
                ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
                : 'bg-accent-bg15 hover:bg-accent-bg15/80 border-yellow-500/30 text-yellow-400'
            }`}
          >
            {loading ? 'Cancel detection' : 'Run Detection'}
          </button>

          {loading && (
            <div className="rounded-xl border border-white/10 bg-surface-2/80 p-2.5 space-y-1.5">
              <div className="flex justify-between gap-3">
                <span className="text-[10px] text-white/70">{friendlyMessage(progressStage, progressMsg)}</span>
                <span className="text-[10px] text-white/50 font-mono">{progressPct}%</span>
              </div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-yellow-500 rounded-full transition-all duration-300" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="flex justify-between">
                <span className="text-[9px] text-white/25 font-mono">{progressStage}</span>
                <span className="text-[9px] text-white/35 font-mono">{elapsed > 0 ? `${elapsed}s` : '…'}</span>
              </div>
            </div>
          )}

          {error && <div className="text-[10px] text-red-400 bg-red-400/10 rounded-xl px-3 py-2">{error}</div>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        <Section title="Detection">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="block text-[10px] text-white/45">Model — optimized for knobs, sliders/faders and LEDs</label>
              <ModelPicker
                selected={detectionModel}
                onSelect={setDetectionModel}
                capabilities={capabilities}
                onCapabilitiesChange={setCaps}
                device={capabilities?.device}
              />
              {capabilities?.gemini_probe_error && !capabilities.gemini_probe_ok && !capabilities.gemini_probe_pending && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-[10px] leading-snug text-red-200">
                  {capabilities.gemini_probe_error} Gemini לא זמין כרגע, ולכן הבחירה חוזרת אוטומטית ל-auto.
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px] text-white/45">
                <span>Min confidence</span>
                <span className="font-mono text-white/75">{Math.round(minConfidence * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.10}
                max={0.90}
                step={0.05}
                value={minConfidence}
                onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center justify-between rounded-lg border border-white/8 bg-surface-1/70 px-2.5 py-2 text-[10px] text-white/70 cursor-pointer">
                <span>OCR labels (slower)</span>
                <input type="checkbox" checked={detectLabels} onChange={(e) => setDetectLabels(e.target.checked)} className="h-3.5 w-3.5 accent-yellow-500" />
              </label>
              <label
                className="flex items-center justify-between rounded-lg border border-white/8 bg-surface-1/70 px-2.5 py-2 text-[10px] text-white/70 cursor-pointer"
                title={capabilities?.device === 'cpu' ? 'Recommended on CPU — SAM2 is slow' : 'SAM2 precise masks available on GPU'}
              >
                <span>Fast mode (GrabCut)</span>
                <input type="checkbox" checked={fastMode} onChange={(e) => setFastMode(e.target.checked)} className="h-3.5 w-3.5 accent-yellow-500" />
              </label>
            </div>
          </div>
        </Section>

        {layout && layout.controls.length > 0 && (
          <Section title="Review">
            <ReviewQueue />
          </Section>
        )}

        {(() => {
          const [selectedId] = selectedControlIds
          const selectedControl = selectedId
            ? layout?.controls.find((c) => c.id === selectedId) ?? null
            : null
          return selectedControl && sourceImage?.dataUrl ? (
            <Section title="De-halo Preview">
              <DeHaloPreviewCard
                key={selectedControl.id}
                control={selectedControl}
                panelDataUrl={sourceImage.dataUrl}
              />
            </Section>
          ) : null
        })()}

        <Section title="Overlay">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center justify-between rounded-lg border border-white/8 bg-surface-1/70 px-2.5 py-2 text-[10px] text-white/70 cursor-pointer">
              <span>Masks</span>
              <input type="checkbox" checked={showMasks} onChange={(e) => setShowMasks(e.target.checked)} className="h-3.5 w-3.5 accent-yellow-500" />
            </label>
            <label className="flex items-center justify-between rounded-lg border border-white/8 bg-surface-1/70 px-2.5 py-2 text-[10px] text-white/70 cursor-pointer">
              <span>Boxes</span>
              <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} className="h-3.5 w-3.5 accent-yellow-500" />
            </label>
            <label className="flex items-center justify-between rounded-lg border border-white/8 bg-surface-1/70 px-2.5 py-2 text-[10px] text-white/70 cursor-pointer">
              <span>Labels</span>
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} className="h-3.5 w-3.5 accent-yellow-500" />
            </label>
            <label className={`flex items-center justify-between rounded-lg border px-2.5 py-2 text-[10px] cursor-pointer ${editMode ? 'border-amber-500/35 bg-amber-500/10 text-amber-300' : 'border-white/8 bg-surface-1/70 text-white/70'}`}>
              <span>Edit boxes</span>
              <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} className="h-3.5 w-3.5 accent-amber-500" />
            </label>
          </div>
        </Section>

        <Section title="Export">
          <div className="space-y-2.5">
            <button
              onClick={handleExportJson}
              disabled={!layout || loading}
              title="Export layout.json"
              className="w-full bg-surface-3 hover:bg-surface-4 border border-white/10 text-white/80 px-2 py-2 rounded-lg transition-colors disabled:opacity-30 text-[10px]"
            >
              Export layout.json
            </button>
          </div>
        </Section>

        {!loading && !error && layout && layout.controlCount === 0 && (
          <Section title="Result" tone="info">
            <div className="space-y-1">
              <p className="text-[10px] text-white/70 font-semibold">No controls detected</p>
              <ul className="text-[10px] text-white/50 space-y-0.5 list-disc pl-3">
                <li>Lower min confidence (try 10–15%)</li>
                <li>Make sure the image shows UI controls</li>
              </ul>
            </div>
          </Section>
        )}

        {layout?.detection_model_used && (
          <div className="px-1 text-[9px] text-white/30 font-mono">
            model: {layout.detection_model_used}
          </div>
        )}
      </div>
      </>
    </div>
  )
}
