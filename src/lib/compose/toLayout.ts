/**
 * toLayout.ts — turn placed elements into layout elements for export.
 *
 * The compositing canvas holds `PlacedElement`s (transform + image). Export (the
 * Phase 5 handoff bundle) needs them as neutral layout records: a rect in panel
 * coords, an angle, a z, and the image to write as assets/<id>.png. Kept decoupled
 * from the detection `PanelControl` shape on purpose — placed parts are authored,
 * not detected.
 */
import type { PlacedElement } from '../../stores/compositionStore'
import { type Adjustments, isDefaultAdjustments } from './adjustments'

export interface ComposedLayoutElement {
  id: string
  type: string
  /** [x, y, w, h] in panel/original-image coordinates. */
  rect: [number, number, number, number]
  angle: number
  z: number
  provenance: 'user'
  source: 'placed'
  /** Non-destructive adjustments to bake at export. Omitted when a no-op. */
  adjustments?: Adjustments
  /** Transparent RGBA PNG for this element (becomes assets/<id>.png on export). */
  dataUrl: string
}

export function placedToLayoutElement(el: PlacedElement): ComposedLayoutElement {
  const out: ComposedLayoutElement = {
    id: el.id,
    type: el.type,
    rect: [Math.round(el.x), Math.round(el.y), Math.round(el.width), Math.round(el.height)],
    angle: el.rotation,
    z: el.z,
    provenance: 'user',
    source: 'placed',
    dataUrl: el.dataUrl,
  }
  if (el.adjustments && !isDefaultAdjustments(el.adjustments)) out.adjustments = el.adjustments
  return out
}

/** All placed elements as layout records, in draw order (bottom → top). */
export function placedToLayoutElements(els: PlacedElement[]): ComposedLayoutElement[] {
  return [...els].sort((a, b) => a.z - b.z).map(placedToLayoutElement)
}
