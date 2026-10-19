import { useState } from 'react'
import { pythonClient } from '../../lib/api/pythonClient'
import { useAssetStore } from '../../stores/assetStore'
import type { Asset } from '../../types'

interface Props {
  asset: Asset
}

interface BackendResult {
  dataUrl: string
  bounds: { x: number; y: number; width: number; height: number }
}

/**
 * Photoshop-style "Refine Edge" + one-click SAM re-cut for a single extracted
 * asset. Operates on the asset's own crop (maskDataUrl), so it needs no access
 * to the full source image. Backend bounds come back crop-local and are offset
 * back into source-image space before saving.
 */
export default function RefineEdgePanel({ asset }: Props) {
  const updateAssetExtraction = useAssetStore((s) => s.updateAssetExtraction)

  const [radius, setRadius] = useState(3)
  const [smooth, setSmooth] = useState(0)
  const [feather, setFeather] = useState(0)
  const [contrast, setContrast] = useState(0)
  const [shiftEdge, setShiftEdge] = useState(0)
  const [busy, setBusy] = useState<null | 'refine' | 'recut'>(null)
  const [error, setError] = useState<string | null>(null)

  const applyResult = (r: BackendResult) => {
    // r.bounds is relative to the crop we sent; shift it back into source space.
    updateAssetExtraction(asset.id, {
      maskDataUrl: r.dataUrl,
      bounds: {
        x: asset.bounds.x + r.bounds.x,
        y: asset.bounds.y + r.bounds.y,
        width: r.bounds.width,
        height: r.bounds.height,
      },
    })
  }

  const onRefine = async () => {
    setBusy('refine')
    setError(null)
    try {
      const r = await pythonClient.refineExtraction(asset.maskDataUrl, asset.maskDataUrl, {
        radius,
        smooth,
        feather,
        contrast,
        shiftEdge,
      })
      applyResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refine failed')
    } finally {
      setBusy(null)
    }
  }

  const onRecut = async () => {
    setBusy('recut')
    setError(null)
    try {
      const w = asset.bounds.width
      const h = asset.bounds.height
      const res = await pythonClient.sam2SegmentPoint(
        asset.maskDataUrl,
        [[w / 2, h / 2]],
        [1],
        true,
      )
      const best = res.masks?.[0]
      if (best?.dataUrl && best.bounds) {
        applyResult(best as BackendResult)
      } else {
        setError('SAM returned no mask')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-cut failed')
    } finally {
      setBusy(null)
    }
  }

  const reset = () => {
    setRadius(3)
    setSmooth(0)
    setFeather(0)
    setContrast(0)
    setShiftEdge(0)
  }

  const row = (
    label: string,
    value: number,
    set: (v: number) => void,
    min: number,
    max: number,
    step = 1,
    suffix = '',
  ) => (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[9px] text-muted w-12">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="flex-1 h-1 accent-accent"
      />
      <span className="text-[9px] text-neutral-400 w-9 text-right">
        {value}
        {suffix}
      </span>
    </div>
  )

  return (
    <div className="space-y-1.5 border-t border-surface-4 pt-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[9px] text-muted uppercase tracking-wide">Refine Edge</span>
        <button
          onClick={reset}
          className="text-[8px] text-neutral-600 hover:text-neutral-400"
        >
          Reset
        </button>
      </div>

      {row('Radius', radius, setRadius, 0.5, 25, 0.5, 'px')}
      {row('Smooth', smooth, setSmooth, 0, 10)}
      {row('Feather', feather, setFeather, 0, 20, 0.5, 'px')}
      {row('Contrast', contrast, setContrast, -100, 100)}
      {row('Shift', shiftEdge, setShiftEdge, -100, 100)}

      <div className="flex gap-1 px-1">
        <button
          onClick={onRefine}
          disabled={busy !== null}
          className="flex-1 text-[9px] px-2 py-1 rounded bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40 transition-colors"
          title="Apply edge refinement (radius / smooth / feather / contrast / grow-shrink)"
        >
          {busy === 'refine' ? 'Refining…' : 'Apply Refine'}
        </button>
        <button
          onClick={onRecut}
          disabled={busy !== null}
          className="flex-1 text-[9px] px-2 py-1 rounded bg-surface-3 text-neutral-300 hover:bg-surface-4 disabled:opacity-40 transition-colors"
          title="Re-segment this element from scratch with SAM2"
        >
          {busy === 'recut' ? 'Re-cutting…' : 'Re-cut (SAM)'}
        </button>
      </div>

      {error && <p className="text-[8px] text-red-400 px-1">{error}</p>}
    </div>
  )
}
