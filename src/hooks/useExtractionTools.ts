import { useCallback, useRef } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useImageStore } from '../stores/imageStore'
import { useExtractionStore } from '../stores/extractionStore'
import { useAssetStore } from '../stores/assetStore'
import { pythonClient } from '../lib/api/pythonClient'
import type { Asset } from '../types'

/**
 * Hook that handles mouse events for all extraction tools.
 * Returns event handlers to wire into the Konva Stage.
 */
export function useExtractionTools(
  zoom: number,
  panX: number,
  panY: number,
) {
  const drawStartRef = useRef<{ imgX: number; imgY: number } | null>(null)
  /** Track time of last click for double-click detection on poly lasso */
  const lastClickTimeRef = useRef<number>(0)
  const lastClickPosRef = useRef<{ x: number; y: number } | null>(null)

  /** Convert stage coords to image coords */
  const stageToImage = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - panX) / zoom,
      y: (sy - panY) / zoom,
    }),
    [zoom, panX, panY],
  )

  /** Image coords to stage coords */
  const imageToStage = useCallback(
    (ix: number, iy: number) => ({
      x: ix * zoom + panX,
      y: iy * zoom + panY,
    }),
    [zoom, panX, panY],
  )

  const handleExtractionMouseDown = useCallback(
    (stageX: number, stageY: number, shiftKey = false) => {
      const activeTool = useCanvasStore.getState().activeTool
      const sourceImage = useImageStore.getState().sourceImage
      if (!sourceImage) return

      const img = stageToImage(stageX, stageY)

      // Clamp to image bounds
      const ix = Math.max(0, Math.min(sourceImage.width, img.x))
      const iy = Math.max(0, Math.min(sourceImage.height, img.y))

      if (activeTool === 'circle') {
        drawStartRef.current = { imgX: ix, imgY: iy }
        useExtractionStore.getState().startCircleDraw(ix, iy)
      } else if (activeTool === 'rect') {
        drawStartRef.current = { imgX: ix, imgY: iy }
        useExtractionStore.getState().startRectDraw(ix, iy)
      } else if (activeTool === 'lasso') {
        // Freehand lasso: starts on mousedown, collects points on move
        useExtractionStore.getState().startLassoDraw()
        useExtractionStore.getState().addLassoPoint(ix, iy)
      } else if (activeTool === 'polyLasso') {
        // Polygonal lasso: each click adds a vertex; double-click closes
        const store = useExtractionStore.getState()
        const now = Date.now()
        const isDoubleClick =
          now - lastClickTimeRef.current < 400 &&
          lastClickPosRef.current &&
          Math.abs(lastClickPosRef.current.x - ix) < 10 &&
          Math.abs(lastClickPosRef.current.y - iy) < 10

        lastClickTimeRef.current = now
        lastClickPosRef.current = { x: ix, y: iy }

        if (!store.polyLassoDraw) {
          // First click: start the polygon
          store.startPolyLasso()
          store.addPolyPoint(ix, iy)
        } else if (isDoubleClick) {
          // Double click: close and extract
          store.closePolyLasso()
          const current = useExtractionStore.getState().polyLassoDraw
          if (current && current.points.length >= 3) {
            performPolygonExtraction(current.points, 'polyLasso')
          }
        } else {
          // Single click: add vertex
          store.addPolyPoint(ix, iy)
        }
      } else if (activeTool === 'wand') {
        performWandExtraction(ix, iy)
      } else if (activeTool === 'sam') {
        // SAM multi-point: positive click by default, Shift = negative
        const store = useExtractionStore.getState()
        if (!store.samMultiPoint) {
          store.startSAMMultiPoint()
        }
        store.addSAMPoint(ix, iy, shiftKey ? 0 : 1)
      } else if (activeTool === 'proExtract') {
        performProExtraction(ix, iy)
      }
    },
    [stageToImage],
  )

  const handleExtractionMouseMove = useCallback(
    (stageX: number, stageY: number) => {
      const activeTool = useCanvasStore.getState().activeTool
      const { isDrawing } = useExtractionStore.getState()
      if (!isDrawing) return

      const sourceImage = useImageStore.getState().sourceImage
      if (!sourceImage) return

      const img = stageToImage(stageX, stageY)
      const ix = Math.max(0, Math.min(sourceImage.width, img.x))
      const iy = Math.max(0, Math.min(sourceImage.height, img.y))

      if (activeTool === 'circle' && drawStartRef.current) {
        const dx = ix - drawStartRef.current.imgX
        const dy = iy - drawStartRef.current.imgY
        const radius = Math.sqrt(dx * dx + dy * dy)
        useExtractionStore.getState().updateCircleDraw(radius)
      } else if (activeTool === 'rect' && drawStartRef.current) {
        useExtractionStore.getState().updateRectDraw(ix, iy)
      } else if (activeTool === 'lasso') {
        // Collect points during drag
        useExtractionStore.getState().addLassoPoint(ix, iy)
      }
    },
    [stageToImage],
  )

  const handleExtractionMouseUp = useCallback(async () => {
    const activeTool = useCanvasStore.getState().activeTool
    const store = useExtractionStore.getState()

    if (activeTool === 'lasso' && store.isDrawing) {
      store.finishLassoDraw()
      const lasso = useExtractionStore.getState().lassoDraw
      if (lasso && lasso.points.length >= 3) {
        await performPolygonExtraction(lasso.points, 'lasso')
      }
      useExtractionStore.getState().cancelDraw()
      return
    }

    if (!store.isDrawing) return
    store.finishDraw()
    drawStartRef.current = null

    if (activeTool === 'circle' && store.circleDraw && store.circleDraw.radius > 2) {
      await performCircleExtraction(store.circleDraw.cx, store.circleDraw.cy, store.circleDraw.radius)
    } else if (activeTool === 'rect' && store.rectDraw && store.rectDraw.width > 2 && store.rectDraw.height > 2) {
      await performRectExtraction(store.rectDraw.x, store.rectDraw.y, store.rectDraw.width, store.rectDraw.height)
    }
  }, [])

  /**
   * Commit SAM multi-point extraction (called when user presses Enter).
   * Must be wired up from the parent via a keyboard handler.
   */
  const commitSAMMultiPoint = useCallback(async () => {
    const store = useExtractionStore.getState()
    if (!store.samMultiPoint || store.samMultiPoint.points.length === 0) return
    const points = store.samMultiPoint.points
    store.clearSAMPoints()
    await performSAMMultiPointExtraction(points)
  }, [])

  /**
   * Commit polygonal lasso when user presses Enter with ≥3 points.
   */
  const commitPolyLasso = useCallback(async () => {
    const store = useExtractionStore.getState()
    if (!store.polyLassoDraw || store.polyLassoDraw.points.length < 3) return
    const pts = store.polyLassoDraw.points
    store.cancelPolyLasso()
    await performPolygonExtraction(pts, 'polyLasso')
  }, [])

  return {
    handleExtractionMouseDown,
    handleExtractionMouseMove,
    handleExtractionMouseUp,
    commitSAMMultiPoint,
    commitPolyLasso,
    stageToImage,
    imageToStage,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function _addAsset(asset: Asset) {
  useAssetStore.getState().addAsset(asset)
  useAssetStore.getState().selectAsset(asset.id)
}

// ─── Extraction Performers ───

async function performCircleExtraction(cx: number, cy: number, radius: number) {
  const sourceImage = useImageStore.getState().sourceImage
  if (!sourceImage) return

  const { setExtracting, setExtractionError, cancelDraw } = useExtractionStore.getState()
  setExtracting(true)
  setExtractionError(null)

  try {
    const result = await pythonClient.extractCircle(sourceImage.dataUrl, cx, cy, radius)
    _addAsset({
      id: crypto.randomUUID(),
      name: `knob_${Date.now().toString(36)}`,
      type: 'knob',
      sourceImageId: sourceImage.id,
      extractionMethod: 'circle',
      extractionParams: { cx, cy, radius },
      maskDataUrl: result.dataUrl,
      bounds: result.bounds,
      metadata: {
        centerPoint: result.centerPoint,
        createdAt: new Date().toISOString(),
        tags: [],
      },
      value: 0.5,
      rotation: 0,
    })
  } catch (err: unknown) {
    setExtractionError(err instanceof Error ? err.message : 'Extraction failed')
    console.error('Circle extraction failed:', err)
  } finally {
    setExtracting(false)
    cancelDraw()
  }
}

async function performRectExtraction(x: number, y: number, w: number, h: number) {
  const sourceImage = useImageStore.getState().sourceImage
  if (!sourceImage) return

  const { setExtracting, setExtractionError, cancelDraw } = useExtractionStore.getState()
  setExtracting(true)
  setExtractionError(null)

  try {
    const result = await pythonClient.extractRect(sourceImage.dataUrl, x, y, w, h)
    _addAsset({
      id: crypto.randomUUID(),
      name: `component_${Date.now().toString(36)}`,
      type: h > w * 1.5 || w > h * 1.5 ? 'slider' : 'decoration',
      sourceImageId: sourceImage.id,
      extractionMethod: 'rect',
      extractionParams: { x, y, w, h },
      maskDataUrl: result.dataUrl,
      bounds: result.bounds,
      metadata: { createdAt: new Date().toISOString(), tags: [] },
      value: 0.5,
    })
  } catch (err: unknown) {
    setExtractionError(err instanceof Error ? err.message : 'Extraction failed')
    console.error('Rect extraction failed:', err)
  } finally {
    setExtracting(false)
    cancelDraw()
  }
}

async function performPolygonExtraction(
  points: { x: number; y: number }[],
  method: 'lasso' | 'polyLasso',
) {
  const sourceImage = useImageStore.getState().sourceImage
  if (!sourceImage || points.length < 3) return

  const { setExtracting, setExtractionError } = useExtractionStore.getState()
  setExtracting(true)
  setExtractionError(null)

  try {
    const result = await pythonClient.extractPolygon(
      sourceImage.dataUrl,
      points,
      0,    // feather
      0,    // expand
      true, // refineEdges
    )
    _addAsset({
      id: crypto.randomUUID(),
      name: `${method}_${Date.now().toString(36)}`,
      type: 'decoration',
      sourceImageId: sourceImage.id,
      extractionMethod: method,
      extractionParams: { pointCount: points.length },
      maskDataUrl: result.dataUrl,
      bounds: result.bounds,
      metadata: {
        createdAt: new Date().toISOString(),
        tags: [method],
        lassoPoints: points,
      },
      value: 0.5,
    })
  } catch (err: unknown) {
    setExtractionError(err instanceof Error ? err.message : 'Polygon extraction failed')
    console.error('Polygon extraction failed:', err)
  } finally {
    setExtracting(false)
  }
}

async function performSAMMultiPointExtraction(
  points: { x: number; y: number; label: 0 | 1 }[],
) {
  const sourceImage = useImageStore.getState().sourceImage
  if (!sourceImage) return

  const { setExtracting, setExtractionError } = useExtractionStore.getState()
  setExtracting(true)
  setExtractionError(null)

  try {
    const samPoints = points.map((p) => [Math.round(p.x), Math.round(p.y)])
    const samLabels = points.map((p) => p.label)

    const samResult = await pythonClient.sam2SegmentPoint(
      sourceImage.dataUrl,
      samPoints,
      samLabels,
      true, // multimask
    )

    if (!samResult.masks || samResult.masks.length === 0) {
      throw new Error('No mask returned from SAM2 segmentation')
    }

    const best = samResult.masks[0]
    _addAsset({
      id: crypto.randomUUID(),
      name: `smart_${Date.now().toString(36)}`,
      type: 'decoration',
      sourceImageId: sourceImage.id,
      extractionMethod: 'sam',
      extractionParams: {
        points: samPoints,
        labels: samLabels,
        method: samResult.method,
        score: best.score,
      },
      maskDataUrl: best.dataUrl,
      bounds: best.bounds,
      metadata: {
        createdAt: new Date().toISOString(),
        tags: [samResult.method, 'multi-point'],
        samPoints: points,
      },
      value: 0.5,
      rotation: 0,
    })
  } catch (samErr: unknown) {
    // Fallback: use the first positive point with magic wand
    console.warn('SAM multi-point failed, falling back to magic wand:', samErr)
    const firstPositive = points.find((p) => p.label === 1)
    if (firstPositive) {
      await performWandExtraction(firstPositive.x, firstPositive.y)
    } else {
      setExtractionError(samErr instanceof Error ? samErr.message : 'Smart extraction failed')
    }
  } finally {
    setExtracting(false)
  }
}

async function performSamExtraction(ix: number, iy: number) {
  const sourceImage = useImageStore.getState().sourceImage
  if (!sourceImage) return

  const { setExtracting, setExtractionError } = useExtractionStore.getState()

  // In SAM multi-point mode: the first click just adds a point; Enter commits.
  // This function handles the legacy single-click-and-extract path.
  setExtracting(true)
  setExtractionError(null)

  try {
    const samResult = await pythonClient.sam2SegmentPoint(
      sourceImage.dataUrl,
      [[Math.round(ix), Math.round(iy)]],
      [1],
      true,
    )

    if (!samResult.masks || samResult.masks.length === 0) {
      throw new Error('No mask returned from segmentation')
    }

    const best = samResult.masks[0]
    _addAsset({
      id: crypto.randomUUID(),
      name: `smart_${Date.now().toString(36)}`,
      type: 'decoration',
      sourceImageId: sourceImage.id,
      extractionMethod: 'sam',
      extractionParams: { seedX: Math.round(ix), seedY: Math.round(iy), method: samResult.method, score: best.score },
      maskDataUrl: best.dataUrl,
      bounds: best.bounds,
      metadata: { createdAt: new Date().toISOString(), tags: [samResult.method] },
      value: 0.5,
      rotation: 0,
    })
  } catch (samErr: unknown) {
    console.warn('SAM extraction failed, falling back to magic wand:', samErr)
    await performWandExtraction(ix, iy)
  } finally {
    setExtracting(false)
  }
}

async function performWandExtraction(ix: number, iy: number) {
  const sourceImage = useImageStore.getState().sourceImage
  if (!sourceImage) return

  const { wandParams, setExtracting, setExtractionError } = useExtractionStore.getState()
  setExtracting(true)
  setExtractionError(null)

  try {
    const result = await pythonClient.magicWand(
      sourceImage.dataUrl,
      Math.round(ix), Math.round(iy),
      wandParams.tolerance,
      wandParams.feather,
      wandParams.expand,
      wandParams.contiguous,
      wandParams.mode,
      wandParams.edgeSensitivity,
      wandParams.refineEdges,
    )
    _addAsset({
      id: crypto.randomUUID(),
      name: `selection_${Date.now().toString(36)}`,
      type: 'decoration',
      sourceImageId: sourceImage.id,
      extractionMethod: 'wand',
      extractionParams: { seedX: Math.round(ix), seedY: Math.round(iy), ...wandParams },
      maskDataUrl: result.dataUrl,
      bounds: result.bounds,
      metadata: { createdAt: new Date().toISOString(), tags: [] },
      value: 0.5,
    })
  } catch (err: unknown) {
    setExtractionError(err instanceof Error ? err.message : 'Extraction failed')
    console.error('Magic wand extraction failed:', err)
  } finally {
    setExtracting(false)
  }
}

async function performProExtraction(ix: number, iy: number) {
  const sourceImage = useImageStore.getState().sourceImage
  if (!sourceImage) return

  const { proParams, setExtracting, setExtractionError } = useExtractionStore.getState()
  setExtracting(true)
  setExtractionError(null)

  try {
    const result = await pythonClient.proExtract(
      sourceImage.dataUrl,
      Math.round(ix), Math.round(iy),
      {
        strategy: proParams.strategy,
        tolerance: proParams.tolerance,
        edgeSensitivity: proParams.edgeSensitivity,
        feather: proParams.feather,
        expand: proParams.expand,
        padding: proParams.padding,
        refineEdges: proParams.refineEdges,
        quality: proParams.quality,
        returnCandidates: proParams.returnCandidates,
      },
    )
    _addAsset({
      id: crypto.randomUUID(),
      name: `pro_${Date.now().toString(36)}`,
      type: 'decoration',
      sourceImageId: sourceImage.id,
      extractionMethod: 'pro',
      extractionParams: {
        seedX: Math.round(ix),
        seedY: Math.round(iy),
        strategy: (result as { strategy?: string }).strategy ?? proParams.strategy,
        tolerance: proParams.tolerance,
        edgeSensitivity: proParams.edgeSensitivity,
        quality: proParams.quality,
        padding: proParams.padding,
      },
      maskDataUrl: result.dataUrl,
      bounds: result.bounds,
      metadata: {
        createdAt: new Date().toISOString(),
        tags: ['pro-extract'],
        candidates: (result as { candidates?: { dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }[] }).candidates?.map((c) => ({
          dataUrl: c.dataUrl,
          bounds: c.bounds,
        })),
      },
      value: 0.5,
    })
  } catch (err: unknown) {
    setExtractionError(err instanceof Error ? err.message : 'Pro extraction failed')
    console.error('Pro extraction failed:', err)
  } finally {
    setExtracting(false)
  }
}

/** Exported helper — lets the Inspector trigger Refine Edge on any asset */
export async function performRefineExtraction(
  assetId: string,
  params?: {
    radius?: number
    smooth?: number
    feather?: number
    contrast?: number
    shiftEdge?: number
  },
): Promise<void> {
  const sourceImage = useImageStore.getState().sourceImage
  const asset = useAssetStore.getState().assets.find((a) => a.id === assetId)
  if (!sourceImage || !asset) return

  const { setExtracting, setExtractionError, refineEdgeParams } = useExtractionStore.getState()
  const mergedParams = { ...refineEdgeParams, ...params }
  setExtracting(true)
  setExtractionError(null)

  try {
    const result = await pythonClient.refineExtraction(sourceImage.dataUrl, asset.maskDataUrl, {
      radius: mergedParams.radius,
      smooth: mergedParams.smooth,
      feather: mergedParams.feather,
      contrast: mergedParams.contrast,
      shiftEdge: mergedParams.shiftEdge,
    })
    useAssetStore.getState().updateAssetExtraction(assetId, {
      maskDataUrl: result.dataUrl,
      bounds: result.bounds,
    })
  } catch (err: unknown) {
    setExtractionError(err instanceof Error ? err.message : 'Refine edge failed')
    console.error('Refine extraction failed:', err)
  } finally {
    setExtracting(false)
  }
}
