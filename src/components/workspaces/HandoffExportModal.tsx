import { useCallback, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useImageStore } from '../../stores/imageStore'
import { usePanelLayoutStore } from '../../stores/panelLayoutStore'
import { useCompositionStore } from '../../stores/compositionStore'
import { pythonClient, type PanelKnobFeatures, type PanelSliderFeatures, type KnobState, type SliderState, type MeterState } from '../../lib/api/pythonClient'
import { placedToLayoutElement, type ComposedLayoutElement } from '../../lib/compose/toLayout'
import { bakeAdjustmentsToDataUrl, loadImage } from '../../lib/compose/bakeDom'
import { generateReactComponent } from '../../lib/export/reactFromLayout'
import {
  mergePlacedIntoManifest, sceneFromManifest, buildHandoffReadme,
  assembleHandoffFiles, filesToZip,
} from '../../lib/export/handoff'
import { u8ToBase64 } from '../../lib/export/zip'

/**
 * HandoffExportModal — Phase 5's one-button "Export for Frontend / Claude".
 *
 * UX improvements (per audit):
 * - Dry-run file tree preview: shows exactly what will be generated before export.
 * - "Copy Prompt for Agent": one-click pre-filled Claude briefing after export.
 * - Per-step status messages during the build so the user knows what's happening.
 */
export default function HandoffExportModal() {
  const open = useWorkspaceStore((s) => s.handoffOpen)
  if (!open) return null
  return <ModalBody />
}

function round(n: number) { return Math.round(n) }

function typeFolder(type: string): string {
  if (type === 'knob') return 'knobs'
  if (type === 'slider' || type === 'slider_cap' || type === 'slider_track') return 'sliders'
  if (type === 'button' || type === 'switch') return 'buttons'
  if (type === 'screen' || type === 'display' || type === 'meter' || type === 'meter_screen') return 'displays'
  if (type === 'led' || type === 'led_light' || type === 'led_screen') return 'leds'
  if (type === 'label' || type === 'text') return 'labels'
  return 'misc'
}

/** Flat ground-truth render: filled bg + detected crops + placed parts (baked). */
async function renderFlatPreview(
  filledDataUrl: string,
  crops: { bbox: [number, number, number, number]; png: string }[],
  placed: ComposedLayoutElement[],
  w: number,
  h: number,
): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const bg = await loadImage(filledDataUrl)
  ctx.drawImage(bg, 0, 0, w, h)
  for (const c of crops) {
    const im = await loadImage(c.png)
    ctx.drawImage(im, c.bbox[0], c.bbox[1])
  }
  for (const p of placed) {
    const im = await loadImage(p.dataUrl)
    const [x, y, pw, ph] = p.rect
    ctx.save()
    ctx.translate(x + pw / 2, y + ph / 2)
    ctx.rotate(((p.angle || 0) * Math.PI) / 180)
    ctx.drawImage(im, -pw / 2, -ph / 2, pw, ph)
    ctx.restore()
  }
  return canvas.toDataURL('image/png')
}

/** Generate a pre-filled agent prompt for Claude or similar. */
function buildAgentPrompt(opts: {
  componentName: string
  width: number
  height: number
  detectedCount: number
  placedCount: number
  filePath: string
}): string {
  return `I have a SynthSkin handoff bundle for a synthesizer/plugin panel UI.

The bundle contains:
- Panel dimensions: ${opts.width} × ${opts.height}px natural size
- ${opts.detectedCount} detected UI elements (knobs, sliders, buttons, displays)
- ${opts.placedCount} manually composited parts
- Panel.tsx (React component ready to extend, component name: ${opts.componentName})
- layout.json (coordinates for every element)
- Transparent PNGs per element (de-haloed)
- background_filled.png + background_punched.png

Coordinate contract:
- rect = [x, y, width, height] in panel pixels
- Origin: top-left corner
- Rotation in degrees, about the element's centre

Bundle location: ${opts.filePath}

Please implement: [describe your feature here].
Start from Panel.tsx and layout.json — the asset file names match the element IDs in layout.json.`
}

function ModalBody() {
  const close = useWorkspaceStore((s) => s.closeHandoff)
  const panel = useImageStore((s) => s.sourceImage)
  const layout         = usePanelLayoutStore((s) => s.layout)
  const dedupGroups    = usePanelLayoutStore((s) => s.dedupGroups)
  const detectedStates = usePanelLayoutStore((s) => s.detectedStates)
  const placedElements = useCompositionStore((s) => s.elements)

  const [componentName, setComponentName] = useState('Panel')
  const [includePreview, setIncludePreview] = useState(true)
  const [includeStrips, setIncludeStrips] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [copyFlash, setCopyFlash] = useState(false)

  const controls = layout?.controls ?? []
  const detectedCount = controls.length
  const placedCount = placedElements.length
  const knobCount = controls.filter((c) => c.type === 'knob').length

  // Derived file tree preview — what the bundle will contain.
  const previewFiles = buildPreviewFileList({
    detectedCount,
    placedCount,
    knobCount,
    componentName: componentName || 'Panel',
    includePreview,
    includeStrips,
    hasPanel: Boolean(panel),
  })

  const copyAgentPrompt = useCallback(() => {
    if (!panel || !exportedPath) return
    const prompt = buildAgentPrompt({
      componentName: componentName || 'Panel',
      width: panel.width,
      height: panel.height,
      detectedCount,
      placedCount,
      filePath: exportedPath,
    })
    navigator.clipboard?.writeText(prompt).then(() => {
      setCopyFlash(true)
      setTimeout(() => setCopyFlash(false), 2000)
    })
  }, [panel, exportedPath, componentName, detectedCount, placedCount])

  const build = useCallback(async () => {
    if (!panel) { setError('Load a panel image in Extract first.'); return }
    setBusy(true); setError(null); setSuccess(null); setExportedPath(null)
    try {
      const w = panel.width, h = panel.height
      const assets: { path: string; dataUrl: string }[] = []

      // 1. Background plates + per-control crops (de-haloed, Poisson fill).
      setStatus('Building background & crops…')
      let filled = panel.dataUrl
      let punched = panel.dataUrl
      let crops: { id: string; bbox: [number, number, number, number]; png: string }[] = []
      if (detectedCount > 0) {
        const triple = await pythonClient.exportPunchTriple(panel.dataUrl, controls, {
          fillMethod: 'poisson', dehalo: true, includeCrops: true,
        })
        filled = triple.background_filled
        punched = triple.background_punched
        crops = (triple.crops ?? []).map((c) => ({ id: c.id, bbox: c.bbox, png: c.png }))
      }
      assets.push({ path: 'background/background_filled.png', dataUrl: filled })
      assets.push({ path: 'background/background_punched.png', dataUrl: punched })

      // Route each crop to its type subfolder (Phase 4).
      const controlsById = new Map(controls.map((c) => [c.id, c]))
      for (const c of crops) {
        const folder = typeFolder(controlsById.get(c.id)?.type ?? 'misc')
        assets.push({ path: `assets/${folder}/${c.id}.png`, dataUrl: c.png })
      }

      // 1b. Sprite strips for knobs (Phase 5) — one 100-frame filmstrip per knob.
      const stripMeta: Record<string, { path: string; frames: number; frame_width: number; frame_height: number }> = {}
      if (includeStrips && crops.length > 0) {
        setStatus('Generating knob sprite strips…')
        for (const c of crops) {
          const ctrl = controlsById.get(c.id)
          if (ctrl?.type !== 'knob') continue
          try {
            const features = ctrl.features as PanelKnobFeatures | undefined
            const circle = ctrl.circle
            let cxNorm: number | null = null
            let cyNorm: number | null = null
            if (circle) {
              const [bx1, by1, bx2, by2] = ctrl.bbox
              const bw = Math.max(1, bx2 - bx1)
              const bh = Math.max(1, by2 - by1)
              cxNorm = (circle.cx - bx1) / bw
              cyNorm = (circle.cy - by1) / bh
            }
            const strip = await pythonClient.exportSpriteStrip({
              cropPng: c.png,
              frames: 100,
              currentAngleDeg: features?.pointer_angle_deg ?? 0,
              minAngleDeg: features?.min_angle_deg ?? -135,
              maxAngleDeg: features?.max_angle_deg ?? 135,
              cxNorm,
              cyNorm,
            })
            const stripPath = `assets/knobs/${c.id}_strip.png`
            assets.push({ path: stripPath, dataUrl: strip.strip_png })
            stripMeta[c.id] = {
              path: stripPath,
              frames: strip.frames,
              frame_width: strip.frame_width,
              frame_height: strip.frame_height,
            }
          } catch { /* sprite strip is best-effort; skip on failure */ }
        }
      }

      // 2. Layout manifest for detected controls (with asset file mapping).
      setStatus('Building layout manifest…')
      const filesById: Record<string, Record<string, string>> = {}
      for (const c of crops) {
        const folder = typeFolder(controlsById.get(c.id)?.type ?? 'misc')
        filesById[c.id] = { original: `assets/${folder}/${c.id}.png` }
      }
      const manifest = await pythonClient.exportLayoutManifest(controls, w, h, {
        filesById,
        includeSemantics: true, includeShapes: true, includeInteraction: true,
      })

      // 2b. Patch manifest assets with Phase 4 metadata: instances, travel, detected state.
      const dedupByCanonical = new Map(dedupGroups.map((g) => [g.canonical_id, g]))
      const patchedAssets = manifest.assets.map((a) => {
        const ctrl = controlsById.get(a.id)
        const patched = { ...a }
        // Instances from dedup
        const group = dedupByCanonical.get(a.id)
        if (group && group.instances.length > 0) patched.instances = group.instances
        // Travel axis for sliders / faders
        if (ctrl && (ctrl.type === 'slider' || ctrl.type === 'slider_cap')) {
          const f = ctrl.features as PanelSliderFeatures | undefined
          if (f?.travel_length_px) patched.travel = { orientation: f.orientation, length_px: f.travel_length_px }
        }
        // Detected state from panelDetectStates
        const cs = detectedStates[a.id]
        if (cs && !((cs as { error?: string }).error)) {
          const s = cs as KnobState | SliderState | MeterState
          patched.detected_state = {
            value_normalized: s.value_normalized,
            ...('angle_deg' in s ? { angle_deg: (s as KnobState | MeterState).angle_deg } : {}),
          }
        }
        // Sprite strip for knobs
        const strip = stripMeta[a.id]
        if (strip) patched.sprite_strip = strip
        return patched
      })
      const patchedManifest = { ...manifest, assets: patchedAssets }

      // 3. Bake placed elements' adjustments and add them as assets.
      setStatus('Baking composited parts…')
      const placedBaked: ComposedLayoutElement[] = []
      for (const el of placedElements) {
        const base = placedToLayoutElement(el)
        const baked = await bakeAdjustmentsToDataUrl(el.dataUrl, el.adjustments)
        placedBaked.push({ ...base, dataUrl: baked })
        assets.push({ path: `assets/${el.id}.png`, dataUrl: baked })
      }

      // 4. Merge, generate the React component, README.
      setStatus('Generating Panel.tsx…')
      const merged = mergePlacedIntoManifest(patchedManifest, placedBaked)
      const scene = sceneFromManifest(merged, {
        backgroundFile: 'background/background_filled.png',
        componentName,
      })
      const panelTsx = generateReactComponent(scene)

      // 5. Optional flat preview.
      let hasPreview = false
      if (includePreview) {
        try {
          setStatus('Rendering preview…')
          const preview = await renderFlatPreview(filled, crops, placedBaked, w, h)
          assets.push({ path: 'preview.png', dataUrl: preview })
          hasPreview = true
        } catch { /* preview is best-effort */ }
      }

      const readme = buildHandoffReadme({
        componentName: scene.componentName ?? 'Panel',
        width: w, height: h,
        assetCount: merged.assets.length,
        placedCount,
        hasBackground: true,
        hasPreview,
      })

      // 6. Assemble + zip.
      setStatus('Packing archive…')
      const files = assembleHandoffFiles({ layout: merged, panelTsx, readme, assets })
      const zip = filesToZip(files)
      const b64 = u8ToBase64(zip)

      // 7. Save.
      const { canceled, filePath } = await window.synthskin.showSaveDialog({
        title: 'Export Handoff Bundle',
        defaultPath: 'synthskin-handoff.zip',
        buttonLabel: 'Export',
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      })
      if (canceled || !filePath) { setStatus(null); setBusy(false); return }
      const res = await window.synthskin.writeFile(filePath, b64, 'base64')
      if (!res.success) throw new Error(res.error ?? 'write failed')
      setExportedPath(filePath)
      setSuccess(`Exported ${files.length} files → ${filePath}`)
      setStatus(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }, [panel, controls, detectedCount, placedElements, placedCount, componentName, includePreview, includeStrips, dedupGroups, detectedStates])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={busy ? undefined : close}>
      <div
        className="w-[560px] max-w-[94vw] max-h-[92vh] flex flex-col rounded-xl bg-surface-1 border border-surface-4 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-4 shrink-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-mono text-accent">STEP 3</span>
            <span className="text-[13px] font-medium text-neutral-200">Export for Frontend / Claude</span>
            <span className="text-[10px] text-muted/60">Extract → Arrange → Export</span>
          </div>
          <button onClick={close} disabled={busy} className="text-muted hover:text-neutral-200 text-lg leading-none px-1 disabled:opacity-40">×</button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <p className="text-[11px] text-muted/80 leading-relaxed">
            Bundles a ready-to-embed <span className="text-neutral-300 font-mono">Panel.tsx</span> +
            <span className="text-neutral-300 font-mono"> layout.json</span> + de-haloed asset PNGs +
            filled/punched backgrounds + a README brief, zipped for a frontend or a fresh Claude session.
          </p>

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Panel" value={panel ? `${panel.width}×${panel.height}` : '—'} />
            <Stat label="Detected" value={String(detectedCount)} />
            <Stat label="Composited" value={String(placedCount)} />
          </div>

          {/* Options */}
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-muted/70">Component name</span>
            <input
              value={componentName}
              onChange={(e) => setComponentName(e.target.value)}
              className="mt-1 w-full h-8 px-2 rounded-md bg-surface-2 border border-surface-4 text-[12px] text-neutral-200 focus:border-accent outline-none"
              placeholder="Panel"
            />
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={includePreview} onChange={(e) => setIncludePreview(e.target.checked)} className="accent-accent" />
            <span className="text-[11px] text-muted/80">Include flat <span className="font-mono text-neutral-300">preview.png</span> (ground-truth render)</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={includeStrips} onChange={(e) => setIncludeStrips(e.target.checked)} className="accent-accent" disabled={knobCount === 0} />
            <span className={`text-[11px] ${knobCount === 0 ? 'text-muted/40' : 'text-muted/80'}`}>
              Include knob sprite strips{knobCount > 0 ? ` (${knobCount} knob${knobCount !== 1 ? 's' : ''}, 100 frames)` : ' — no knobs detected'}
            </span>
          </label>

          {/* Dry-run file tree preview */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted/70 mb-1.5">Bundle contents preview</div>
            <div className="bg-surface-0/60 border border-surface-4 rounded-lg p-3 font-mono text-[11px] leading-relaxed overflow-x-auto">
              {previewFiles.map((f, i) => (
                <div key={i} className={`flex items-center gap-2 ${f.indent ? 'pl-' + (f.indent * 4) : ''}`}
                  style={{ paddingLeft: f.indent ? f.indent * 16 : 0 }}>
                  <span className="text-muted/40 select-none">{f.indent ? '├─' : ''}</span>
                  <span className={f.isDir ? 'text-accent/80' : f.isKey ? 'text-neutral-300' : 'text-muted/60'}>{f.name}</span>
                  {f.note && <span className="text-muted/35 text-[10px]">← {f.note}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Status / error / success */}
          {status && <div className="text-[11px] text-accent flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            {status}
          </div>}
          {error && <div className="p-2 rounded bg-red-900/30 border border-red-800/50 text-[10px] text-red-400">{error}</div>}
          {success && (
            <div className="space-y-2">
              <div className="p-2 rounded bg-green-900/30 border border-green-800/50 text-[10px] text-green-400 break-all">{success}</div>
              <button
                onClick={copyAgentPrompt}
                className={`w-full py-2 rounded-md text-[11px] font-medium border transition-colors
                  ${copyFlash
                    ? 'bg-green-500/20 border-green-500/40 text-green-300'
                    : 'bg-accent/10 border-accent/30 text-accent hover:bg-accent/20'
                  }`}
              >
                {copyFlash ? '✓ Copied to clipboard!' : '⎘ Copy prompt for Claude / agent'}
              </button>
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div className="flex gap-2 p-4 border-t border-surface-4 shrink-0">
          <button onClick={close} disabled={busy}
            className="flex-1 py-2 rounded-md text-[12px] text-muted-text bg-surface-2 border border-surface-4 hover:bg-surface-3 disabled:opacity-40">
            Cancel
          </button>
          <button onClick={build} disabled={busy || !panel}
            className="flex-1 py-2 rounded-md text-[12px] font-semibold bg-accent text-surface-0 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? 'Building…' : 'Build & Export .zip'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── File tree preview builder ──────────────────────────────────────────────────

type PreviewFile = { name: string; indent: number; isDir?: boolean; isKey?: boolean; note?: string }

function buildPreviewFileList(opts: {
  detectedCount: number
  placedCount: number
  knobCount: number
  componentName: string
  includePreview: boolean
  includeStrips: boolean
  hasPanel: boolean
}): PreviewFile[] {
  const { detectedCount, placedCount, knobCount, componentName, includePreview, includeStrips } = opts
  const safeComp = componentName || 'Panel'
  const totalAssets = detectedCount + placedCount

  const files: PreviewFile[] = [
    { name: '📦 synthskin-handoff.zip', indent: 0, isDir: true },
    { name: 'background/', indent: 1, isDir: true },
    { name: 'background_filled.png', indent: 2, isKey: true, note: 'Poisson-filled panel' },
    { name: 'background_punched.png', indent: 2, note: 'panel with cut-out holes' },
    { name: 'assets/', indent: 1, isDir: true },
    { name: 'knobs/', indent: 2, isDir: true, note: 'one subfolder per control type' },
    { name: 'sliders/', indent: 2, isDir: true },
    { name: 'buttons/', indent: 2, isDir: true },
    { name: 'displays/', indent: 2, isDir: true },
  ]

  if (totalAssets > 0) {
    files.push({ name: `…${totalAssets} PNG${totalAssets !== 1 ? 's' : ''}`, indent: 3, note: 'de-haloed, transparent' })
  }
  if (includeStrips && knobCount > 0) {
    files.push({ name: `…${knobCount} _strip.png`, indent: 3, note: '100-frame JUCE filmstrip per knob' })
  }

  files.push({ name: `${safeComp}.tsx`, indent: 1, isKey: true, note: 'React component, ready to extend' })
  files.push({ name: 'layout.json', indent: 1, isKey: true, note: `${totalAssets} elements with coordinates` })
  if (includePreview) {
    files.push({ name: 'preview.png', indent: 1, note: 'ground-truth flat render' })
  }
  files.push({ name: 'README_FOR_CLAUDE.md', indent: 1, isKey: true, note: 'coordinate contract + agent guide' })

  return files
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-2 border border-surface-4 py-2">
      <div className="text-[13px] font-mono text-neutral-200">{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-muted/60 mt-0.5">{label}</div>
    </div>
  )
}
