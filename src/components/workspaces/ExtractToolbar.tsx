import { useCanvasStore } from '../../stores/canvasStore'
import { useImageStore } from '../../stores/imageStore'
import { useBatchStore } from '../../stores/batchStore'
import { useHistoryStore } from '../../stores/historyStore'
import { useAssetStore } from '../../stores/assetStore'
import { useAssetEditStore, type AssetEditTool } from '../../stores/assetEditStore'
import { useExtractionStore } from '../../stores/extractionStore'
import { useEffect, useCallback } from 'react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import * as Tooltip from '@radix-ui/react-tooltip'
import { pythonClient, type Extract3DComponent } from '../../lib/api/pythonClient'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { Asset } from '../../types'

type Tool = 'select' | 'circle' | 'rect' | 'sam' | 'wand' | 'hand' | 'zoom' | 'crop' | 'lasso' | 'polyLasso' | 'measure' | 'proExtract'

const tools: { id: Tool; label: string; shortcut: string; icon: JSX.Element }[] = [
  {
    id: 'select',
    label: 'Select',
    shortcut: 'V',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 2l4.5 12 2-5 5-2L3 2z" />
      </svg>
    ),
  },
  {
    id: 'circle',
    label: 'Circle Extract',
    shortcut: 'C',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6" />
        <line x1="8" y1="5" x2="8" y2="11" />
        <line x1="5" y1="8" x2="11" y2="8" />
      </svg>
    ),
  },
  {
    id: 'rect',
    label: 'Rect Extract',
    shortcut: 'R',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="10" height="10" rx="0.5" />
      </svg>
    ),
  },
  {
    id: 'wand',
    label: 'Smart Extract (one-click — adjustable)',
    shortcut: 'W',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 14l6-6" />
        <path d="M9.5 6.5l-2-2" />
        <path d="M10 2l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
      </svg>
    ),
  },
  {
    id: 'crop',
    label: 'Crop (Enter to apply)',
    shortcut: 'K',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 1v9h9" />
        <path d="M1 4h9v9" />
        <line x1="4" y1="4" x2="13" y2="4" />
        <line x1="4" y1="4" x2="4" y2="13" />
      </svg>
    ),
  },
  {
    id: 'lasso',
    label: 'Lasso Extract (freehand — drag)',
    shortcut: 'L',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3C5 3 2 5.5 2 8s2 4 4 4c1.5 0 2.5-.5 3-1.5" />
        <path d="M11 6c1.5.8 2.5 2.2 2.5 3.5" />
        <path d="M9 13l3-3 1 3-3-1z" />
      </svg>
    ),
  },
  {
    id: 'measure',
    label: 'Measure Distance',
    shortcut: 'U',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="2" y1="14" x2="14" y2="2" />
        <line x1="2" y1="14" x2="2" y2="11" />
        <line x1="2" y1="14" x2="5" y2="14" />
        <line x1="14" y1="2" x2="11" y2="2" />
        <line x1="14" y1="2" x2="14" y2="5" />
      </svg>
    ),
  },
]

function importImage() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp,image/bmp,image/tiff'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const { setSourceImage, setLoading } = useImageStore.getState()
    setLoading(true)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new window.Image()
      img.onload = () => {
        setSourceImage({ id: crypto.randomUUID(), path: file.name, width: img.naturalWidth, height: img.naturalHeight, dataUrl, htmlImage: img })
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

// Map detector label → Asset['type'] enum. Unknowns fall back to 'decoration'
// so the user can retype them in the inspector without losing the asset.
function mapDetectedType(detected: string): Asset['type'] {
  switch (detected) {
    case 'knob': return 'knob'
    case 'slider': return 'slider'
    case 'button': return 'button'
    case 'led': return 'led'
    case 'screen':
    case 'display': return 'screen'
    case 'meter': return 'meter'
    default: return 'decoration'
  }
}

async function runAutoDetect3D() {
  const sourceImage = useImageStore.getState().sourceImage
  if (!sourceImage?.dataUrl) {
    console.warn('[AutoDetect3D] no source image loaded')
    return
  }
  const { setExtract3dProgress, setDetectedCandidates, clearExtract3d } = useExtractionStore.getState()
  clearExtract3d()
  setExtract3dProgress({ stage: 'start', percent: 0, message: 'Starting 3D extraction…' })
  try {
    const result = await pythonClient.extract3dStream(
      sourceImage.dataUrl,
      null, // let the server auto-detect via SAM2-auto / YOLOv10-clean
      (stage, percent, message) => {
        setExtract3dProgress({ stage, percent, message })
      },
    )

    // Push inpainted panel background so the Design workspace shows the panel
    // with extracted components removed.
    if (result.inpainted_background_dataUrl) {
      useCanvasStore.getState().setCanvasBackground(result.inpainted_background_dataUrl)
    }

    // Create Asset entries for each detected component.
    const addAsset = useAssetStore.getState().addAsset
    const createdAt = new Date().toISOString()
    const candidates = result.components.map((c: Extract3DComponent, i: number) => {
      const id = crypto.randomUUID()
      const type = mapDetectedType(c.detected_type)
      const asset: Asset = {
        id,
        name: `${c.detected_type}_${i + 1}`,
        type,
        sourceImageId: sourceImage.id,
        extractionMethod: 'sam',
        extractionParams: { source: c.source, detectedType: c.detected_type },
        maskDataUrl: c.diffuse_dataUrl,
        bounds: c.bounds,
        metadata: {
          createdAt,
          tags: ['auto-3d', c.detected_type],
        },
        normalMapUrl: c.normal_dataUrl,
        depthMapUrl: c.depth_dataUrl,
        detectedType: c.detected_type,
        initialGeometry: c.bounds,
      }
      addAsset(asset)
      return {
        srcUrl: c.diffuse_dataUrl,
        detectedType: c.detected_type,
        initialGeometry: c.bounds,
        normalMapUrl: c.normal_dataUrl,
        depthMapUrl: c.depth_dataUrl,
        alphaMapUrl: c.alpha_dataUrl,
        confidence: c.confidence,
      }
    })

    setDetectedCandidates(candidates)
    setExtract3dProgress({
      stage: 'done',
      percent: 100,
      message: `Extracted ${candidates.length} components · ${result.elapsed_ms}ms`,
    })
    // Clear the progress pill after a short delay so the user sees the summary
    setTimeout(() => {
      const s = useExtractionStore.getState().extract3dProgress
      if (s?.stage === 'done') useExtractionStore.getState().setExtract3dProgress(null)
    }, 4000)
  } catch (err) {
    console.error('[AutoDetect3D] failed:', err)
    setExtract3dProgress({
      stage: 'error',
      percent: 0,
      message: err instanceof Error ? err.message : '3D extraction failed',
    })
  }
}

export default function ExtractToolbar() {
  const activeTool = useCanvasStore((s) => s.activeTool)
  const setActiveTool = useCanvasStore((s) => s.setActiveTool)
  const openPanelAnalyzer = useWorkspaceStore((s) => s.openPanelAnalyzer)
  const openPartsCutter = useWorkspaceStore((s) => s.openPartsCutter)
  const openCompose = useWorkspaceStore((s) => s.openCompose)
  const openHandoff = useWorkspaceStore((s) => s.openHandoff)
  const hasImage = useImageStore((s) => Boolean(s.sourceImage))
  const samMultiPoint = useExtractionStore((s) => s.samMultiPoint)
  const polyLassoDraw = useExtractionStore((s) => s.polyLassoDraw)

  // Keyboard shortcuts: Enter commits SAM multi-point or poly lasso, Escape cancels
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      useExtractionStore.getState().clearSAMPoints()
      useExtractionStore.getState().cancelPolyLasso()
      return
    }
    if (e.key === 'Enter') {
      // Commit SAM multi-point
      const store = useExtractionStore.getState()
      if (store.samMultiPoint && store.samMultiPoint.points.length > 0) {
        // Import performRefineExtraction lazily to avoid circular dep
        import('../../hooks/useExtractionTools').then(({ performRefineExtraction: _ }) => {
          // We need commitSAMMultiPoint from the hook — access via event
          document.dispatchEvent(new CustomEvent('synthskin:sam-commit'))
        })
      }
      // Commit poly lasso
      if (store.polyLassoDraw && store.polyLassoDraw.points.length >= 3) {
        document.dispatchEvent(new CustomEvent('synthskin:polylasso-commit'))
      }
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <Tooltip.Provider delayDuration={300}>
      {/* SAM multi-point commit banner */}
      {samMultiPoint && samMultiPoint.points.length > 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-900/40 border border-emerald-500/30 text-[11px] text-emerald-400">
          <span className="font-mono">
            {samMultiPoint.points.filter(p => p.label === 1).length}+ &nbsp;
            {samMultiPoint.points.filter(p => p.label === 0).length}−
          </span>
          <span className="text-emerald-500/70">pts</span>
          <button
            onClick={() => document.dispatchEvent(new CustomEvent('synthskin:sam-commit'))}
            className="ml-1 px-1.5 py-0.5 rounded bg-emerald-600/50 hover:bg-emerald-500/60 text-white transition-colors"
          >
            Extract ↵
          </button>
          <button
            onClick={() => useExtractionStore.getState().clearSAMPoints()}
            className="px-1 py-0.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Poly lasso commit banner */}
      {polyLassoDraw && polyLassoDraw.points.length >= 1 && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-violet-900/40 border border-violet-500/30 text-[11px] text-violet-300">
          <span className="font-mono">{polyLassoDraw.points.length} pts</span>
          {polyLassoDraw.points.length >= 3 && (
            <button
              onClick={() => document.dispatchEvent(new CustomEvent('synthskin:polylasso-commit'))}
              className="ml-1 px-1.5 py-0.5 rounded bg-violet-600/50 hover:bg-violet-500/60 text-white transition-colors"
            >
              Close & Extract ↵
            </button>
          )}
          <button
            onClick={() => useExtractionStore.getState().cancelPolyLasso()}
            className="px-1 py-0.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Import Image */}
      <ToolbarButton
        label="Import Image"
        onClick={importImage}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        }
      />

      {/* Import & Cut parts from ANY image → Parts Tray (Phase 2 compositing) */}
      <ToolbarButton
        label="Import & Cut Parts"
        onClick={openPartsCutter}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" />
            <path d="M8 8l12 10M8 16L20 6" />
          </svg>
        }
      />

      {/* Compose — place cut/imported parts onto the panel (Phase 3) */}
      <ToolbarButton
        label="Compose Parts on Panel"
        onClick={openCompose}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <rect x="7" y="7" width="7" height="7" rx="1" />
            <path d="M14 14l3 3" />
          </svg>
        }
      />

      {/* Export for Frontend / Claude — embeddable handoff bundle (Phase 5) */}
      <ToolbarButton
        label="Export for Frontend / Claude"
        onClick={openHandoff}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        }
      />

      <div className="w-px h-6 bg-surface-5 mx-1" />

      {/* Undo / Redo */}
      <ToolbarButton label="Undo" shortcut="Ctrl+Z" onClick={() => useHistoryStore.getState().undo()} icon={
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 10h10a5 5 0 0 1 0 10H9" /><path d="m3 10 4-4M3 10l4 4" />
        </svg>
      } />
      <ToolbarButton label="Redo" shortcut="Ctrl+Shift+Z" onClick={() => useHistoryStore.getState().redo()} icon={
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 10H11a5 5 0 0 0 0 10h4" /><path d="m21 10-4-4M21 10l-4 4" />
        </svg>
      } />

      <div className="w-px h-6 bg-surface-5 mx-1" />

      {/* Extraction tools */}
      <ToggleGroup.Root
        type="single"
        value={activeTool}
        onValueChange={(v) => { if (v) setActiveTool(v as Tool) }}
        className="flex items-center gap-0.5"
      >
        {tools.map((tool) => (
          <Tooltip.Root key={tool.id}>
            <Tooltip.Trigger asChild>
              <ToggleGroup.Item
                value={tool.id}
                className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors
                  ${activeTool === tool.id
                    ? 'bg-accent-bg15 text-accent border border-accent/30'
                    : 'text-muted-text hover:text-neutral-300 hover:bg-surface-3'
                  }`}
              >
                {tool.icon}
              </ToggleGroup.Item>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="bottom"
                sideOffset={6}
                className="bg-surface-3 text-neutral-300 px-2.5 py-1.5 rounded-lg text-[11px] shadow-lg border border-surface-4"
              >
                {tool.label}
                <span className="ml-2 text-muted font-mono">{tool.shortcut}</span>
                <Tooltip.Arrow className="fill-surface-3" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        ))}
      </ToggleGroup.Root>

      <div className="w-px h-6 bg-surface-5 mx-1" />

      {/* ── PRIMARY ACTION ── the one button that drives the whole workflow:
          analyze the panel (Gemini + SAM2 + OCR) → detected controls + JUCE params. */}
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            onClick={openPanelAnalyzer}
            disabled={!hasImage}
            className="flex items-center gap-1.5 px-3 h-8 rounded-md bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed text-[12px] font-medium tracking-wide transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6L8 1z" />
            </svg>
            Detect Controls
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="bottom" sideOffset={6} className="bg-surface-3 text-neutral-300 px-2.5 py-1.5 rounded-lg text-[11px] shadow-lg border border-surface-4 max-w-[220px]">
            {hasImage
              ? 'Analyze the panel with Gemini + SAM 2 + OCR → detected controls, labels and JUCE parameters'
              : 'Load a panel image first (drag one onto the canvas)'}
            <Tooltip.Arrow className="fill-surface-3" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      {/* The Batch (CV) and 3D auto-detect methods were removed from the top bar:
          having three competing "detect" buttons was the main source of confusion
          and two of them produce worse results than the Gemini pipeline above.
          Batch detect remains reachable from the Command Palette if needed. */}

      {/* ─── Mask Editing Tools (when asset selected) ─── */}
      <MaskEditSection />

      {/* Spacer */}
      <div className="flex-1" />
    </Tooltip.Provider>
  )
}

function ToolbarButton({ label, shortcut, icon, onClick }: {
  label: string
  shortcut?: string
  icon: JSX.Element
  onClick?: () => void
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          onClick={onClick}
          className="w-8 h-8 flex items-center justify-center rounded-md text-muted-text hover:text-neutral-300 hover:bg-surface-3 transition-colors"
        >
          {icon}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={6}
          className="bg-surface-3 text-neutral-300 px-2.5 py-1.5 rounded-lg text-[11px] shadow-lg border border-surface-4"
        >
          {label}
          {shortcut && <span className="ml-2 text-muted font-mono">{shortcut}</span>}
          <Tooltip.Arrow className="fill-surface-3" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

const maskEditTools: { id: AssetEditTool; label: string; shortcut: string; icon: JSX.Element }[] = [
  {
    id: 'move',
    label: 'Move Asset',
    shortcut: 'M',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2v12M2 8h12M8 2l-2 2M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2" />
      </svg>
    ),
  },
  {
    id: 'brush',
    label: 'Mask Brush',
    shortcut: 'B',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l2 2-8 8H4v-2l8-8z" />
        <path d="M10 4l2 2" />
      </svg>
    ),
  },
  {
    id: 'eraser',
    label: 'Mask Eraser',
    shortcut: 'E',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 14h7M3.5 11.5L11 4l2.5 2.5L6 14H3.5v-2.5z" />
      </svg>
    ),
  },
  {
    id: 'center',
    label: 'Set Center Point',
    shortcut: 'P',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" />
        <circle cx="8" cy="8" r="1.5" fill="currentColor" />
        <line x1="8" y1="2" x2="8" y2="5" />
        <line x1="8" y1="11" x2="8" y2="14" />
        <line x1="2" y1="8" x2="5" y2="8" />
        <line x1="11" y1="8" x2="14" y2="8" />
      </svg>
    ),
  },
]

function MaskEditSection() {
  const selectedAssetId = useAssetStore((s) => s.selectedAssetId)
  const editingAssetId = useAssetEditStore((s) => s.editingAssetId)
  const editTool = useAssetEditStore((s) => s.editTool)
  const brushSize = useAssetEditStore((s) => s.brushSize)
  const startEditing = useAssetEditStore((s) => s.startEditing)
  const stopEditing = useAssetEditStore((s) => s.stopEditing)
  const setEditTool = useAssetEditStore((s) => s.setEditTool)
  const setBrushSize = useAssetEditStore((s) => s.setBrushSize)
  const toggleGrid = useAssetEditStore((s) => s.toggleGrid)
  const showGrid = useAssetEditStore((s) => s.showGrid)

  if (!selectedAssetId) return null

  const isEditing = editingAssetId === selectedAssetId

  return (
    <>
      <div className="w-px h-6 bg-surface-5 mx-1" />

      {!isEditing ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              onClick={() => startEditing(selectedAssetId)}
              className="h-8 px-2.5 flex items-center gap-1.5 rounded-md text-[10px] font-medium bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l2 2-8 8H4v-2l8-8z" />
              </svg>
              Edit Mask
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content side="bottom" sideOffset={6} className="bg-surface-3 text-neutral-300 px-2.5 py-1.5 rounded-lg text-[11px] shadow-lg border border-surface-4">
              Open pixel-level mask editor on canvas
              <Tooltip.Arrow className="fill-surface-3" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      ) : (
        <>
          {/* Mask editing tools */}
          <ToggleGroup.Root
            type="single"
            value={editTool}
            onValueChange={(v) => { if (v) setEditTool(v as AssetEditTool) }}
            className="flex items-center gap-0.5"
          >
            {maskEditTools.map((t) => (
              <Tooltip.Root key={t.id}>
                <Tooltip.Trigger asChild>
                  <ToggleGroup.Item
                    value={t.id}
                    className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                      editTool === t.id
                        ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                        : 'text-muted-text hover:text-neutral-300 hover:bg-surface-3'
                    }`}
                  >
                    {t.icon}
                  </ToggleGroup.Item>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content side="bottom" sideOffset={6} className="bg-surface-3 text-neutral-300 px-2.5 py-1.5 rounded-lg text-[11px] shadow-lg border border-surface-4">
                    {t.label}
                    <span className="ml-2 text-muted font-mono">{t.shortcut}</span>
                    <Tooltip.Arrow className="fill-surface-3" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            ))}
          </ToggleGroup.Root>

          {/* Brush size slider */}
          {(editTool === 'brush' || editTool === 'eraser') && (
            <div className="flex items-center gap-1.5 ml-1">
              <span className="text-[9px] text-muted">Size</span>
              <input
                type="range"
                min={1}
                max={32}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="w-16 h-1 accent-rose-400"
              />
              <span className="text-[9px] text-neutral-500 w-5 text-right">{brushSize}</span>
            </div>
          )}

          {/* Grid toggle */}
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                onClick={toggleGrid}
                className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ml-0.5 ${
                  showGrid ? 'bg-accent/15 text-accent' : 'text-muted-text hover:text-neutral-300 hover:bg-surface-3'
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <rect x="1" y="1" width="14" height="14" rx="0.5" />
                  <line x1="5.5" y1="1" x2="5.5" y2="15" />
                  <line x1="10.5" y1="1" x2="10.5" y2="15" />
                  <line x1="1" y1="5.5" x2="15" y2="5.5" />
                  <line x1="1" y1="10.5" x2="15" y2="10.5" />
                </svg>
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content side="bottom" sideOffset={6} className="bg-surface-3 text-neutral-300 px-2.5 py-1.5 rounded-lg text-[11px] shadow-lg border border-surface-4">
                Toggle Grid
                <Tooltip.Arrow className="fill-surface-3" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>

          {/* Done button */}
          <button
            onClick={stopEditing}
            className="h-7 px-2.5 ml-1 flex items-center gap-1 rounded-md text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
          >
            ✓ Done
          </button>
        </>
      )}
    </>
  )
}
