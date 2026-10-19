/**
 * PunchAssetTray — left panel shown during the Punch Editor step.
 *
 * Displays every detected control as a thumbnail card.
 * Accepted (green) = will be punched.  Not accepted (grey) = will be kept.
 * User can accept / reject / retype directly from here; changes sync with
 * the Konva canvas via the shared panelLayoutStore.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePanelLayoutStore, type PanelControlType } from '../../stores/panelLayoutStore'
import { useImageStore } from '../../stores/imageStore'
import { pythonClient, type ControlState, type KnobState, type SliderState, type MeterState, type PanelControl } from '../../lib/api/pythonClient'

// ─── Thumbnail generation (single image-load pass) ────────────────────────────

async function buildThumbs(
  dataUrl: string,
  controls: PanelControl[],
  maxDim = 72,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const out: Record<string, string> = {}
      for (const c of controls) {
        const [x1, y1, x2, y2] = c.bbox
        const w = Math.max(1, x2 - x1)
        const h = Math.max(1, y2 - y1)
        const scale = Math.min(maxDim / w, maxDim / h, 1)
        const canvas = document.createElement('canvas')
        canvas.width  = Math.max(1, Math.round(w * scale))
        canvas.height = Math.max(1, Math.round(h * scale))
        canvas.getContext('2d')!.drawImage(img, x1, y1, w, h, 0, 0, canvas.width, canvas.height)
        out[c.id] = canvas.toDataURL('image/png')
      }
      resolve(out)
    }
    img.onerror = reject
    img.src = dataUrl
  })
}

// ─── Type colour coding ───────────────────────────────────────────────────────

const TYPE_DOT: Record<string, string> = {
  knob:    'bg-amber-400',
  slider:  'bg-blue-400',
  slider_cap: 'bg-blue-300',
  slider_track: 'bg-blue-200',
  fader:   'bg-cyan-400',
  button:  'bg-green-400',
  switch:  'bg-teal-400',
  led:     'bg-red-400',
  screen:  'bg-purple-400',
  display: 'bg-violet-400',
  meter:   'bg-orange-400',
  label:   'bg-neutral-500',
}

const RETYPE_OPTS: PanelControlType[] = [
  'knob', 'slider', 'slider_cap', 'button', 'switch', 'led', 'screen', 'meter',
]

// ─── State badge helper ───────────────────────────────────────────────────────

function getStateBadge(cs: ControlState): string | null {
  const err = (cs as { error?: string }).error
  if (err) return null
  const s = cs as KnobState | SliderState | MeterState
  const pct = Math.round(s.value_normalized * 100)
  if (s.type === 'knob') return `${s.angle_deg >= 0 ? '+' : ''}${s.angle_deg}° · ${pct}%`
  if (s.type === 'meter' || s.type === 'screen' || s.type === 'meter_screen')
    return `${s.angle_deg >= 0 ? '+' : ''}${s.angle_deg}° · ${pct}%`
  return `${(s as SliderState).orientation === 'vertical' ? '↕' : '↔'} ${pct}%`
}

// ─── Single card ──────────────────────────────────────────────────────────────

function AssetCard({
  control, thumb, selected, controlState,
  onSelect, onAccept, onRemove, onRetype,
}: {
  control: PanelControl
  thumb: string | null
  selected: boolean
  controlState?: ControlState | null
  onSelect: () => void
  onAccept: () => void
  onRemove: () => void
  onRetype: (t: PanelControlType) => void
}) {
  const [showTypes, setShowTypes] = useState(false)
  const accepted   = control.provenance === 'user'
  const confidence = Math.round((control.confidence ?? 0) * 100)

  return (
    <div
      onClick={onSelect}
      className={`
        relative rounded-lg border cursor-pointer transition-all select-none
        ${selected
          ? 'border-accent/60 bg-accent/8 ring-1 ring-accent/30'
          : accepted
            ? 'border-green-500/30 bg-green-500/5 hover:bg-green-500/10'
            : 'border-surface-4 bg-surface-2/60 hover:bg-surface-2'}
      `}
    >
      {/* Thumbnail */}
      <div className="relative h-14 flex items-center justify-center rounded-t-lg overflow-hidden bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#151515_0%_50%)_50%_/8px_8px]">
        {thumb
          ? <img src={thumb} alt={control.display_name} className="max-h-full max-w-full object-contain" draggable={false} />
          : <div className="text-[9px] text-muted/30">…</div>
        }
        {/* Accept badge */}
        {accepted && (
          <div className="absolute top-1 left-1 w-3 h-3 rounded-full bg-green-500 flex items-center justify-center">
            <span className="text-[7px] text-white font-bold leading-none">✓</span>
          </div>
        )}
        {/* Confidence */}
        <span className={`absolute bottom-0.5 right-0.5 text-[7px] font-mono px-1 rounded ${
          confidence >= 85 ? 'bg-green-500/20 text-green-400' :
          confidence >= 65 ? 'bg-yellow-500/20 text-yellow-400' :
          'bg-red-500/20 text-red-400'
        }`}>
          {confidence}%
        </span>
      </div>

      {/* Info */}
      <div className="px-1.5 py-1">
        <div className="flex items-center gap-1 min-w-0">
          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${TYPE_DOT[control.type] ?? 'bg-neutral-500'}`} />
          <p className="text-[9px] text-neutral-300 truncate flex-1 leading-tight">{control.display_name}</p>
        </div>
        <p className="text-[8px] text-muted/60 font-mono mt-0.5">{control.type}</p>
        {controlState != null && getStateBadge(controlState) && (
          <p className="text-[8px] text-cyan-400/80 font-mono">{getStateBadge(controlState)}</p>
        )}
      </div>

      {/* Action row */}
      <div className="flex gap-0.5 px-1 pb-1" onClick={e => e.stopPropagation()}>
        {!accepted && (
          <button
            onClick={onAccept}
            className="flex-1 text-[8px] py-0.5 rounded bg-green-500/15 text-green-300 hover:bg-green-500/25 transition-colors"
          >✓</button>
        )}
        <button
          onClick={() => setShowTypes(v => !v)}
          className="flex-1 text-[8px] py-0.5 rounded bg-surface-3 text-neutral-400 hover:bg-surface-4 transition-colors"
        >type</button>
        <button
          onClick={onRemove}
          className="flex-1 text-[8px] py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
        >✕</button>
      </div>

      {showTypes && (
        <div className="px-1 pb-1 flex flex-wrap gap-0.5" onClick={e => e.stopPropagation()}>
          {RETYPE_OPTS.map(t => (
            <button
              key={t}
              onClick={() => { onRetype(t); setShowTypes(false) }}
              className="text-[7px] px-1 py-0.5 rounded bg-surface-3 text-neutral-400 hover:bg-surface-4 transition-colors"
            >{t}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

export default function PunchAssetTray() {
  const layout            = usePanelLayoutStore((s) => s.layout)
  const selectedIds       = usePanelLayoutStore((s) => s.selectedControlIds)
  const selectControl     = usePanelLayoutStore((s) => s.selectControl)
  const acceptControl     = usePanelLayoutStore((s) => s.acceptControl)
  const deleteControl     = usePanelLayoutStore((s) => s.deleteControl)
  const changeControlType = usePanelLayoutStore((s) => s.changeControlType)
  const acceptAllHC       = usePanelLayoutStore((s) => s.acceptAllHighConfidence)
  const applyDedup        = usePanelLayoutStore((s) => s.applyDedup)
  const setDedupGroups    = usePanelLayoutStore((s) => s.setDedupGroups)
  const setDetectedStates = usePanelLayoutStore((s) => s.setDetectedStates)
  const sourceImage       = useImageStore((s) => s.sourceImage)

  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<'all' | 'accepted' | 'review'>('all')
  const [acceptFlash, setAcceptFlash] = useState<number | null>(null)
  const prevCountRef = useRef(0)

  const [dedupStatus, setDedupStatus]     = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [dedupSaved, setDedupSaved]       = useState(0)
  const [statesStatus, setStatesStatus]   = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [controlStates, setControlStates] = useState<Record<string, ControlState>>({})

  // Generate thumbnails when layout changes
  useEffect(() => {
    if (!layout || !sourceImage?.dataUrl) return
    const count = layout.controls.length
    if (count === prevCountRef.current && Object.keys(thumbs).length > 0) return
    prevCountRef.current = count
    buildThumbs(sourceImage.dataUrl, layout.controls)
      .then(setThumbs)
      .catch(() => {})
  }, [layout?.controls.length, sourceImage?.dataUrl]) // eslint-disable-line

  const controls = useMemo(() => {
    if (!layout) return []
    if (filter === 'accepted') return layout.controls.filter(c => c.provenance === 'user')
    if (filter === 'review')   return layout.controls.filter(c => c.provenance !== 'user')
    return layout.controls
  }, [layout, filter])

  const acceptedCount = layout ? layout.controls.filter(c => c.provenance === 'user').length : 0
  const totalCount    = layout?.controls.length ?? 0
  const highConfCount = layout
    ? layout.controls.filter(c => c.provenance !== 'user' && (c.confidence ?? 0) >= 0.85).length
    : 0

  const handleAcceptAll = () => {
    const n = acceptAllHC(0.85)
    if (n > 0) { setAcceptFlash(n); setTimeout(() => setAcceptFlash(null), 2000) }
  }

  const handleDedup = async () => {
    if (!layout || !sourceImage?.dataUrl) return
    setDedupStatus('running')
    try {
      const result = await pythonClient.panelDeduplicate(sourceImage.dataUrl, layout.controls)
      if (result.removed_ids.length > 0) applyDedup(result.removed_ids)
      setDedupGroups(result.groups)
      setDedupSaved(result.total_saved)
      setDedupStatus('done')
      setTimeout(() => setDedupStatus('idle'), 3500)
    } catch {
      setDedupStatus('error')
      setTimeout(() => setDedupStatus('idle'), 3000)
    }
  }

  const handleDetectStates = async () => {
    if (!layout || !sourceImage?.dataUrl) return
    setStatesStatus('running')
    try {
      const result = await pythonClient.panelDetectStates(sourceImage.dataUrl, layout.controls)
      setControlStates(result.states)
      setDetectedStates(result.states)
      setStatesStatus('done')
      setTimeout(() => setStatesStatus('idle'), 3500)
    } catch {
      setStatesStatus('error')
      setTimeout(() => setStatesStatus('idle'), 3000)
    }
  }

  if (!layout) return null

  return (
    <div className="h-full flex flex-col bg-surface-1 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-3 py-2.5 border-b border-surface-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-neutral-200">Assets</span>
          <span className="text-[10px] font-mono text-green-400">{acceptedCount}/{totalCount} punch</span>
        </div>

        {highConfCount > 0 && (
          <button
            onClick={handleAcceptAll}
            className="w-full flex items-center justify-center gap-1 py-1.5 rounded-lg bg-green-500/12 border border-green-500/25 text-[9px] text-green-300 hover:bg-green-500/20 transition-colors"
          >
            {acceptFlash !== null
              ? `✓ ${acceptFlash} accepted`
              : `✓ Accept all ≥85% (${highConfCount})`}
          </button>
        )}

        {/* Filter tabs */}
        <div className="flex gap-0.5 bg-surface-0/50 rounded-lg p-0.5">
          {(['all', 'accepted', 'review'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 text-[8px] py-0.5 rounded transition-colors capitalize ${
                filter === f ? 'bg-surface-3 text-neutral-200' : 'text-muted hover:text-neutral-300'
              }`}
            >{f === 'all' ? `All (${totalCount})` : f === 'accepted' ? `✓ (${acceptedCount})` : `Review (${totalCount - acceptedCount})`}</button>
          ))}
        </div>

        {/* AI tools */}
        <div className="flex gap-1">
          <button
            onClick={handleDedup}
            disabled={dedupStatus === 'running' || !sourceImage}
            className={`flex-1 py-1 rounded text-[8px] transition-colors disabled:opacity-40 ${
              dedupStatus === 'running' ? 'bg-surface-3 text-muted cursor-wait' :
              dedupStatus === 'done'    ? 'bg-green-500/15 text-green-300' :
              dedupStatus === 'error'   ? 'bg-red-500/10 text-red-400' :
              'bg-surface-3 text-neutral-400 hover:bg-surface-4'
            }`}
          >
            {dedupStatus === 'running' ? '…' :
             dedupStatus === 'done'    ? `✓ ${dedupSaved} saved` :
             dedupStatus === 'error'   ? '✕ failed' :
             '⊟ Dedup'}
          </button>
          <button
            onClick={handleDetectStates}
            disabled={statesStatus === 'running' || !sourceImage}
            className={`flex-1 py-1 rounded text-[8px] transition-colors disabled:opacity-40 ${
              statesStatus === 'running' ? 'bg-surface-3 text-muted cursor-wait' :
              statesStatus === 'done'    ? 'bg-cyan-500/15 text-cyan-300' :
              statesStatus === 'error'   ? 'bg-red-500/10 text-red-400' :
              'bg-surface-3 text-neutral-400 hover:bg-surface-4'
            }`}
          >
            {statesStatus === 'running' ? '…' :
             statesStatus === 'done'    ? '✓ States' :
             statesStatus === 'error'   ? '✕ failed' :
             '◉ States'}
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-2 gap-1.5">
          {controls.map(c => (
            <AssetCard
              key={c.id}
              control={c}
              thumb={thumbs[c.id] ?? null}
              selected={selectedIds.has(c.id)}
              controlState={controlStates[c.id] ?? null}
              onSelect={() => selectControl(c.id)}
              onAccept={() => acceptControl(c.id)}
              onRemove={() => deleteControl(c.id)}
              onRetype={t => { changeControlType(c.id, t); acceptControl(c.id) }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
