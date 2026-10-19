/**
 * DeHaloPreviewCard — live before/after de-halo preview for a single detected control.
 *
 * UX improvement per audit: "the wow moment of the tool". The user selects a control in
 * the ReviewQueue, adjusts the strength slider, clicks Preview, and sees exactly what the
 * exported asset will look like — before committing to the full export.
 *
 * Implementation:
 * - "Before": the control's bbox crop from the panel image (client-side canvas, no Python).
 * - "After":  exportPunchTriple([control]) with chosen settings → returned crop.
 * - Toggle between Before/After, or side-by-side on wider screens.
 */
import { useState, useEffect, useCallback } from 'react'
import { pythonClient, type PanelControl } from '../../lib/api/pythonClient'

interface Props {
  control: PanelControl
  panelDataUrl: string
}

/** Extract a bbox crop from the panel purely client-side (no Python needed). */
async function cropFromPanel(
  panelDataUrl: string,
  bbox: [number, number, number, number],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const [x1, y1, x2, y2] = bbox
      const w = Math.max(1, x2 - x1)
      const h = Math.max(1, y2 - y1)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, x1, y1, w, h, 0, 0, w, h)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = panelDataUrl
  })
}

export default function DeHaloPreviewCard({ control, panelDataUrl }: Props) {
  const [beforeUrl, setBeforeUrl] = useState<string | null>(null)
  const [afterUrl, setAfterUrl] = useState<string | null>(null)
  const [showAfter, setShowAfter] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dilate, setDilate] = useState(2)
  const [feather, setFeather] = useState(1)
  const [fillMethod, setFillMethod] = useState<'poisson' | 'telea'>('poisson')

  // Crop the bbox from the panel immediately when control changes.
  useEffect(() => {
    setAfterUrl(null)
    setShowAfter(false)
    setError(null)
    cropFromPanel(panelDataUrl, control.bbox)
      .then(setBeforeUrl)
      .catch(() => setBeforeUrl(null))
  }, [control.id, control.bbox, panelDataUrl])

  const runPreview = useCallback(async () => {
    if (!panelDataUrl) return
    setBusy(true)
    setError(null)
    try {
      const triple = await pythonClient.exportPunchTriple(
        panelDataUrl,
        [control],
        { dilatePx: dilate, featherPx: feather, fillMethod, dehalo: true, includeCrops: true },
      )
      const crop = triple.crops?.[0]
      if (crop?.png) {
        setAfterUrl(crop.png)
        setShowAfter(true)
      } else {
        setError('No crop returned — control may be outside image bounds.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setBusy(false)
    }
  }, [control, panelDataUrl, dilate, feather, fillMethod])

  const displayUrl = (showAfter && afterUrl) ? afterUrl : beforeUrl

  return (
    <div className="space-y-2">
      {/* Preview thumbnail */}
      {displayUrl && (
        <div className="relative rounded-lg overflow-hidden bg-[repeating-conic-gradient(#2a2a2a_0%_25%,#222_0%_50%)_50%_/12px_12px] h-28 flex items-center justify-center">
          <img
            src={displayUrl}
            alt={showAfter ? 'After de-halo' : 'Before'}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
          {/* Badge */}
          <span className={`absolute bottom-1.5 left-1.5 text-[9px] font-mono px-1.5 py-0.5 rounded ${
            showAfter ? 'bg-accent/30 text-accent' : 'bg-white/15 text-white/60'
          }`}>
            {showAfter ? 'AFTER' : 'BEFORE'}
          </span>
          {/* Toggle button if both available */}
          {afterUrl && (
            <button
              onClick={() => setShowAfter((v) => !v)}
              className="absolute bottom-1.5 right-1.5 text-[9px] px-2 py-0.5 rounded bg-black/40 text-white/70 hover:bg-black/60 transition-colors"
            >
              {showAfter ? '← Before' : 'After →'}
            </button>
          )}
        </div>
      )}

      {/* Settings */}
      <div className="space-y-1">
        <SliderRow label="Dilate" min={0} max={8} step={1} value={dilate} set={setDilate} suffix="px" />
        <SliderRow label="Feather" min={0} max={6} step={0.5} value={feather} set={setFeather} suffix="px" />
        <div className="flex items-center gap-2 px-1">
          <span className="text-[9px] text-muted w-12">Fill</span>
          <div className="flex gap-1">
            {(['poisson', 'telea'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setFillMethod(m)}
                className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                  fillMethod === m
                    ? 'bg-accent/20 text-accent border border-accent/30'
                    : 'bg-white/5 text-white/50 hover:bg-white/10'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="text-[9px] text-red-400 px-1">{error}</p>}

      <button
        onClick={runPreview}
        disabled={busy || !beforeUrl}
        className="w-full py-1.5 rounded-lg bg-accent/15 border border-accent/25 text-[10px] text-accent font-medium hover:bg-accent/25 disabled:opacity-40 transition-colors"
      >
        {busy ? 'Previewing…' : afterUrl ? 'Re-run preview' : 'Preview de-halo'}
      </button>
    </div>
  )
}

function SliderRow({
  label, min, max, step, value, set, suffix = '',
}: {
  label: string; min: number; max: number; step: number; value: number
  set: (v: number) => void; suffix?: string
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[9px] text-muted w-12">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="flex-1 h-1 accent-accent"
      />
      <span className="text-[9px] text-neutral-400 w-9 text-right">{value}{suffix}</span>
    </div>
  )
}
