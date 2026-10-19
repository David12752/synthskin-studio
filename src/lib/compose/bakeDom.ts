/**
 * bakeDom.ts — DOM bridge for Phase 4 adjustments.
 *
 * Turns a data-URL + adjustments into a new baked data-URL (and a ready
 * HTMLImageElement) using the pure `bakeAdjustments` pixel function, so the
 * compositing preview and the export bake are pixel-identical. Kept apart from
 * the pure `adjustments.ts` (which stays node-testable) because everything here
 * needs `document`/`Image`.
 */
import { dataUrlToRGBA, rgbaToDataUrl } from '../cut/imageData'
import { type Adjustments, bakeAdjustments, isDefaultAdjustments } from './adjustments'

/** A stable signature for an element's render inputs, for cache invalidation. */
export function adjustmentsKey(adj?: Adjustments | null): string {
  if (isDefaultAdjustments(adj)) return 'base'
  const a = adj!
  return `h${a.hue}s${a.saturation}b${a.brightness}c${a.contrast}t${a.tint ?? '-'}${a.tintStrength}`
}

/** Bake adjustments into a data-URL. Returns the source URL unchanged if no-op. */
export async function bakeAdjustmentsToDataUrl(dataUrl: string, adj?: Adjustments | null): Promise<string> {
  if (isDefaultAdjustments(adj)) return dataUrl
  const rgba = await dataUrlToRGBA(dataUrl)
  return rgbaToDataUrl(bakeAdjustments(rgba, adj))
}

/** Load a data-URL into a decoded HTMLImageElement. */
export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('Failed to decode image'))
    im.src = dataUrl
  })
}
