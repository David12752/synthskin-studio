import { useState } from 'react'
import { useAssetStore } from '../../stores/assetStore'
import { useTemplateStore } from '../../stores/templateStore'
import type { Asset, AssetTemplate, PluginMetadata } from '../../types'

export default function PluginMetadataEditor({ asset }: { asset: Asset }) {
  const updatePluginMeta = useAssetStore((s) => s.updatePluginMeta)
  const addTemplate = useTemplateStore((s) => s.addTemplate)
  const templates = useTemplateStore((s) => s.templates)

  const [expanded, setExpanded] = useState(false)

  const meta: PluginMetadata = asset.pluginMeta ?? {
    parameterId: '',
    displayName: '',
    unit: '',
    minValue: 0,
    maxValue: 1,
    defaultValue: 0.5,
    skew: 1.0,
    suffix: '',
    automatable: true,
  }

  const update = (patch: Partial<PluginMetadata>) => {
    updatePluginMeta(asset.id, { ...meta, ...patch })
  }

  const handleSaveTemplate = () => {
    const template: AssetTemplate = {
      id: `tpl_${Date.now()}`,
      name: asset.name,
      assetType: asset.type,
      extractionMethod: asset.extractionMethod,
      extractionParams: asset.extractionParams,
      pluginMeta: meta,
      createdAt: new Date().toISOString(),
    }
    addTemplate(template)
  }

  const handleApplyTemplate = (tpl: AssetTemplate) => {
    if (tpl.pluginMeta) {
      updatePluginMeta(asset.id, tpl.pluginMeta)
    }
  }

  return (
    <div className="border-t border-surface-4 pt-3 space-y-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">
          Plugin Metadata
        </span>
        <span className="text-[10px] text-neutral-600">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="space-y-2 text-[11px]">
          {/* Parameter ID */}
          <Field
            label="Parameter ID"
            value={meta.parameterId}
            onChange={(v) => update({ parameterId: v })}
            placeholder="osc1_frequency"
          />

          {/* Display Name */}
          <Field
            label="Display Name"
            value={meta.displayName}
            onChange={(v) => update({ displayName: v })}
            placeholder="Oscillator 1 Freq"
          />

          {/* Unit */}
          <Field
            label="Unit"
            value={meta.unit}
            onChange={(v) => update({ unit: v })}
            placeholder="Hz"
          />

          {/* Min / Max */}
          <div className="flex gap-2">
            <NumberField label="Min" value={meta.minValue} onChange={(v) => update({ minValue: v })} />
            <NumberField label="Max" value={meta.maxValue} onChange={(v) => update({ maxValue: v })} />
          </div>

          {/* Default */}
          <NumberField label="Default" value={meta.defaultValue} onChange={(v) => update({ defaultValue: v })} />

          {/* Skew */}
          <div>
            <label className="text-[10px] text-neutral-500 flex justify-between">
              <span>Skew</span>
              <span className="font-mono text-neutral-400">{meta.skew.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.05}
              value={meta.skew}
              onChange={(e) => update({ skew: Number(e.target.value) })}
              className="w-full mt-0.5 accent-amber-500"
            />
          </div>

          {/* Suffix */}
          <Field
            label="Suffix"
            value={meta.suffix}
            onChange={(v) => update({ suffix: v })}
            placeholder=" Hz"
          />

          {/* Automatable */}
          <label className="flex items-center gap-2 text-neutral-400 cursor-pointer">
            <input
              type="checkbox"
              checked={meta.automatable}
              onChange={(e) => update({ automatable: e.target.checked })}
              className="accent-amber-500"
            />
            Automatable
          </label>

          {/* Template actions */}
          <div className="pt-2 border-t border-surface-4 space-y-1.5">
            <button
              onClick={handleSaveTemplate}
              className="w-full px-3 py-1 rounded text-[10px] bg-surface-3 border border-surface-4 text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              Save as Template
            </button>

            {templates.length > 0 && (
              <div>
                <div className="text-[9px] text-neutral-600 mb-1">Apply Template:</div>
                <div className="space-y-0.5 max-h-24 overflow-y-auto">
                  {templates.map((tpl) => (
                    <button
                      key={tpl.id}
                      onClick={() => handleApplyTemplate(tpl)}
                      className="w-full text-left px-2 py-1 rounded text-[10px] text-neutral-500 hover:text-neutral-300 hover:bg-surface-2 transition-colors truncate"
                    >
                      {tpl.name} ({tpl.assetType})
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div>
      <label className="text-[10px] text-neutral-500 block mb-0.5">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1 rounded bg-surface-2 border border-surface-4 text-[11px] text-neutral-300 placeholder:text-neutral-700 focus:border-accent/50 focus:outline-none"
      />
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex-1">
      <label className="text-[10px] text-neutral-500 block mb-0.5">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-2 py-1 rounded bg-surface-2 border border-surface-4 text-[11px] text-neutral-300 font-mono focus:border-accent/50 focus:outline-none"
      />
    </div>
  )
}
