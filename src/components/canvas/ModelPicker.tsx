/**
 * ModelPicker — visual, annotated picker for the Panel Analyzer detection model.
 *
 * Replaces the bare <select> with one card per model so the user can see,
 * at a glance, which model is best for their scenario, what its current
 * status is (ready/cached/unavailable), and what setup it needs.
 */
import { useState } from 'react'
import type { PanelPipelineCapabilities } from '../../lib/api/pythonClient'
import GeminiKeyDialog from './GeminiKeyDialog.tsx'

export type ModelId = 'auto' | 'gemini' | 'yolo'

type Status = 'ready' | 'cached' | 'needs-setup' | 'fallback' | 'unavailable' | 'blocked'

interface ModelMeta {
  id: ModelId
  name: string
  badge: string                // short tag shown to the right of name
  bestFor: string              // 1-line "best at"
  speed: string                // human-readable speed estimate
  size: string                 // model size / RAM hint
  cost: 'free' | 'cloud' | 'local'
  notes?: string               // optional caveat (e.g. "skipped on CPU in auto mode")
}

const MODELS: ModelMeta[] = [
  {
    id: 'auto',
    name: 'Professional Hybrid Detector',
    badge: 'recommended',
    bestFor: 'Best balance — custom YOLO when trained, Gemini fallback, then targeted OpenCV.',
    speed: '0.3–4 s typical',
    size: 'Custom YOLO + SAM2 masks; Gemini optional',
    cost: 'local',
    notes: 'The production path is trained detector boxes → SAM2 extraction masks.',
  },
  {
    id: 'gemini',
    name: 'Gemini 2.5 Flash',
    badge: 'cloud · vision',
    bestFor: 'Highest recall on photographed or dense hardware panels.',
    speed: '2–4 s · hard 15 s wall-clock cap',
    size: '0 MB local · ~1 MB upload per image',
    cost: 'cloud',
    notes: 'Requires a free Google AI Studio API key (one-click below).',
  },
  {
    id: 'yolo',
    name: 'Local YOLO Detector',
    badge: 'fast · local',
    bestFor: 'Best local path after training synthskin_yolo.pt on knobs, sliders/faders, and LEDs.',
    speed: '50–500 ms',
    size: '~6–50 MB depending on YOLO11s/m',
    cost: 'local',
    notes: 'Without custom weights this is only a generic COCO fallback and will miss/false-detect synth controls.',
  },
]

function statusFor(model: ModelMeta, caps: PanelPipelineCapabilities | null): Status {
  if (!caps) return 'cached'
  switch (model.id) {
    case 'auto':
      return caps.custom_yolo || caps.gemini_probe_ok ? 'ready' : 'fallback'
    case 'gemini':
      if (caps.gemini_probe_ok) return 'ready'
      if (caps.gemini_probe_pending) return 'cached'
      if (caps.gemini_key_set) return 'blocked'
      return 'needs-setup'
    case 'yolo':
      return caps.custom_yolo ? 'ready' : caps.yolo ? 'fallback' : 'unavailable'
  }
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string }> = {
    ready:        { label: 'ready',        cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' },
    cached:       { label: 'checking…',    cls: 'bg-white/5 text-white/40 border-white/10' },
    'needs-setup':{ label: 'needs key',    cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
    fallback:     { label: 'fallback',     cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
    unavailable:  { label: 'unavailable',  cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
    blocked:      { label: 'blocked',      cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  }
  const m = map[status]
  return (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${m.cls}`}>{m.label}</span>
  )
}

interface ModelPickerProps {
  selected: string
  onSelect: (id: string) => void
  capabilities: PanelPipelineCapabilities | null
  onCapabilitiesChange: (caps: PanelPipelineCapabilities) => void
  device?: string
}

export default function ModelPicker({ selected, onSelect, capabilities, onCapabilitiesChange }: ModelPickerProps) {
  const [showKeyDialog, setShowKeyDialog] = useState(false)
  const detectorHint = capabilities?.detector_recommendation

  return (
    <div className="space-y-2">
      {capabilities && !capabilities.custom_yolo && (
        <div className="rounded-lg border border-orange-500/20 bg-orange-500/10 px-2.5 py-2 text-[10px] leading-snug text-orange-200">
          <strong className="text-orange-100">Professional detector not trained yet.</strong>{' '}
          Local YOLO is currently <span className="font-mono">{capabilities.yolo_weight_kind ?? 'generic'}</span>
          {capabilities.yolo_weight ? <span className="font-mono"> ({capabilities.yolo_weight})</span> : null}.{' '}
          SAM2 can extract precise masks only after detection boxes are good.
          {detectorHint ? <p className="mt-1 text-orange-200/80">{detectorHint}</p> : null}
        </div>
      )}
      {MODELS.map((model) => {
        const status = statusFor(model, capabilities)
        const isSelected = selected === model.id
        const isDisabled = status === 'unavailable' || status === 'blocked'

        return (
          <button
            key={model.id}
            type="button"
            onClick={() => !isDisabled && onSelect(model.id)}
            disabled={isDisabled}
            className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors ${
              isSelected
                ? 'border-yellow-500/45 bg-yellow-500/8'
                : isDisabled
                  ? 'border-white/5 bg-surface-1/40 opacity-50 cursor-not-allowed'
                  : 'border-white/8 bg-surface-1/70 hover:border-white/20 hover:bg-surface-1'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-[11px] font-semibold ${isSelected ? 'text-yellow-300' : 'text-white/85'}`}>
                  {model.name}
                </span>
                <span className="text-[9px] text-white/35 font-mono truncate">{model.badge}</span>
              </div>
              <StatusPill status={status} />
            </div>
            <p className="mt-1 text-[10px] text-white/55 leading-snug">{model.bestFor}</p>
            <div className="mt-1.5 flex items-center gap-3 text-[9px] text-white/40 font-mono">
              <span title="Estimated speed">⏱ {model.speed}</span>
              <span title="Footprint">💾 {model.size}</span>
            </div>
            {model.notes && (
              <p className="mt-1 text-[9px] text-white/35 leading-snug italic">{model.notes}</p>
            )}
            {model.id === 'gemini' && status === 'needs-setup' && (
              <div className="mt-2">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); setShowKeyDialog(true) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setShowKeyDialog(true) }
                  }}
                  className="inline-block text-[10px] px-2 py-1 rounded border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 cursor-pointer"
                >
                  Set Gemini API key…
                </span>
              </div>
            )}
            {model.id === 'gemini' && status === 'ready' && (
              <div className="mt-2">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); setShowKeyDialog(true) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setShowKeyDialog(true) }
                  }}
                  className="inline-block text-[10px] text-white/45 hover:text-white/80 underline cursor-pointer"
                >
                  Replace API key
                </span>
              </div>
            )}
            {model.id === 'gemini' && capabilities?.gemini_probe_error && status === 'blocked' && (
              <p className="mt-2 text-[9px] leading-snug text-red-300/85">{capabilities.gemini_probe_error}</p>
            )}
          </button>
        )
      })}

      {showKeyDialog && (
        <GeminiKeyDialog
          currentlySet={!!capabilities?.gemini_key_set}
          onClose={() => setShowKeyDialog(false)}
          onSaved={(caps: PanelPipelineCapabilities) => { onCapabilitiesChange(caps); setShowKeyDialog(false) }}
        />
      )}
    </div>
  )
}
