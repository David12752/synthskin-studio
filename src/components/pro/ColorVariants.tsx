import { useState } from 'react'
import { useAssetStore } from '../../stores/assetStore'
import { pythonClient } from '../../lib/api/pythonClient'
import type { Asset } from '../../types'

export default function ColorVariants({ asset }: { asset: Asset }) {
  const addAsset = useAssetStore((s) => s.addAsset)

  const [hueShift, setHueShift] = useState(0)
  const [saturation, setSaturation] = useState(1)
  const [brightness, setBrightness] = useState(1)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [batchPreviews, setBatchPreviews] = useState<string[]>([])

  const handlePreview = async () => {
    setLoading(true)
    try {
      const result = await pythonClient.colorVariant(asset.maskDataUrl, {
        hueShift,
        saturationScale: saturation,
        brightnessScale: brightness,
      })
      setPreview(result.dataUrl)
    } catch (e) {
      console.error('[ColorVariant] Preview failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveVariant = () => {
    if (!preview) return
    const newAsset: Asset = {
      ...asset,
      id: `asset_variant_${Date.now()}`,
      name: `${asset.name}_hue${hueShift}`,
      maskDataUrl: preview,
      metadata: {
        ...asset.metadata,
        createdAt: new Date().toISOString(),
        tags: [...asset.metadata.tags, 'variant'],
      },
    }
    addAsset(newAsset)
    setPreview(null)
  }

  const handleBatchVariants = async () => {
    setLoading(true)
    try {
      const shifts = [-120, -90, -60, -30, 30, 60, 90, 120, 150, 180]
      const result = await pythonClient.colorVariantsBatch(asset.maskDataUrl, shifts)
      setBatchPreviews(result.variants.map((v) => v.dataUrl))
    } catch (e) {
      console.error('[ColorVariant] Batch failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveBatchItem = (dataUrl: string, index: number) => {
    const shifts = [-120, -90, -60, -30, 30, 60, 90, 120, 150, 180]
    const newAsset: Asset = {
      ...asset,
      id: `asset_variant_${Date.now()}_${index}`,
      name: `${asset.name}_hue${shifts[index]}`,
      maskDataUrl: dataUrl,
      metadata: {
        ...asset.metadata,
        createdAt: new Date().toISOString(),
        tags: [...asset.metadata.tags, 'variant'],
      },
    }
    addAsset(newAsset)
  }

  return (
    <div className="space-y-2 border-t border-surface-4 pt-3">
      <div className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">
        Color Variants
      </div>

      {/* Hue */}
      <div>
        <label className="text-[10px] text-neutral-500 flex justify-between">
          <span>Hue Shift</span>
          <span className="font-mono text-neutral-400">{hueShift}°</span>
        </label>
        <input
          type="range"
          min={-180}
          max={180}
          value={hueShift}
          onChange={(e) => setHueShift(Number(e.target.value))}
          className="w-full mt-0.5 accent-amber-500"
        />
      </div>

      {/* Saturation */}
      <div>
        <label className="text-[10px] text-neutral-500 flex justify-between">
          <span>Saturation</span>
          <span className="font-mono text-neutral-400">{saturation.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={saturation}
          onChange={(e) => setSaturation(Number(e.target.value))}
          className="w-full mt-0.5 accent-amber-500"
        />
      </div>

      {/* Brightness */}
      <div>
        <label className="text-[10px] text-neutral-500 flex justify-between">
          <span>Brightness</span>
          <span className="font-mono text-neutral-400">{brightness.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0.2}
          max={2}
          step={0.05}
          value={brightness}
          onChange={(e) => setBrightness(Number(e.target.value))}
          className="w-full mt-0.5 accent-amber-500"
        />
      </div>

      {/* Preview button */}
      <button
        onClick={handlePreview}
        disabled={loading}
        className="w-full px-3 py-1.5 rounded text-[11px] bg-purple-900/30 border border-purple-700/40 text-purple-300 hover:bg-purple-900/50 disabled:opacity-40 transition-colors"
      >
        {loading ? 'Processing…' : 'Preview Variant'}
      </button>

      {/* Preview result */}
      {preview && (
        <div className="space-y-1.5">
          <div className="flex gap-2 items-center">
            <div className="flex-1 bg-surface-0 rounded p-1 flex items-center justify-center">
              <img src={asset.maskDataUrl} className="max-h-16 object-contain" alt="original" draggable={false} />
            </div>
            <span className="text-neutral-600 text-sm">→</span>
            <div className="flex-1 bg-surface-0 rounded p-1 flex items-center justify-center">
              <img src={preview} className="max-h-16 object-contain" alt="variant" draggable={false} />
            </div>
          </div>
          <button
            onClick={handleSaveVariant}
            className="w-full px-3 py-1 rounded text-[10px] bg-accent/20 border border-accent/40 text-accent hover:bg-accent/30 transition-colors"
          >
            Save as New Asset
          </button>
        </div>
      )}

      {/* Batch variants */}
      <button
        onClick={handleBatchVariants}
        disabled={loading}
        className="w-full px-3 py-1.5 rounded text-[11px] bg-surface-3 border border-surface-4 text-neutral-400 hover:text-neutral-200 disabled:opacity-40 transition-colors"
      >
        Generate 10 Hue Variants
      </button>

      {batchPreviews.length > 0 && (
        <div className="grid grid-cols-5 gap-1">
          {batchPreviews.map((dataUrl, i) => (
            <button
              key={i}
              onClick={() => handleSaveBatchItem(dataUrl, i)}
              className="bg-surface-0 rounded p-0.5 hover:ring-1 hover:ring-accent transition-shadow"
              title="Click to save as asset"
            >
              <img src={dataUrl} className="w-full aspect-square object-contain" alt={`variant ${i}`} draggable={false} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
