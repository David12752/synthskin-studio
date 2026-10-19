/**
 * transform.ts — pure geometry for the compositing canvas (Phase 3).
 *
 * Placing parts on a panel needs z-ordering, rotated-bounds, and snap-to-align —
 * all deterministic and framework-free so they are unit-testable without Konva.
 */
import type { Rect } from '../cut/freeCut'

export interface HasZ {
  id: string
  z: number
}

/** The z index to give a newly placed element (on top of everything). */
export function nextZ(els: { z: number }[]): number {
  return els.length ? Math.max(...els.map((e) => e.z)) + 1 : 0
}

/** Swap an element's z with the neighbour above it (raise one step). */
export function bringForward<T extends HasZ>(els: T[], id: string): T[] {
  const sorted = [...els].sort((a, b) => a.z - b.z)
  const i = sorted.findIndex((e) => e.id === id)
  if (i < 0 || i === sorted.length - 1) return els
  const a = sorted[i], b = sorted[i + 1]
  return els.map((e) => (e.id === a.id ? { ...e, z: b.z } : e.id === b.id ? { ...e, z: a.z } : e))
}

/** Swap an element's z with the neighbour below it (lower one step). */
export function sendBackward<T extends HasZ>(els: T[], id: string): T[] {
  const sorted = [...els].sort((a, b) => a.z - b.z)
  const i = sorted.findIndex((e) => e.id === id)
  if (i <= 0) return els
  const a = sorted[i], b = sorted[i - 1]
  return els.map((e) => (e.id === a.id ? { ...e, z: b.z } : e.id === b.id ? { ...e, z: a.z } : e))
}

export interface TransformBox {
  x: number
  y: number
  width: number
  height: number
  rotation?: number // degrees, about the box centre
}

/** Axis-aligned bounding box of a (possibly rotated-about-centre) box. */
export function boundsOf(el: TransformBox): Rect {
  const r = ((el.rotation ?? 0) * Math.PI) / 180
  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  const cos = Math.abs(Math.cos(r))
  const sin = Math.abs(Math.sin(r))
  const w = el.width * cos + el.height * sin
  const h = el.width * sin + el.height * cos
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h }
}

export interface SnapResult {
  x: number
  y: number
  snappedX: boolean
  snappedY: boolean
}

/**
 * Snap a moving box so one of its left/centre/right (and top/middle/bottom)
 * edges aligns with a guide from the other elements or the panel, within `tol`.
 */
export function snapPosition(
  moving: { x: number; y: number; width: number; height: number },
  others: Rect[],
  panel: Rect | null,
  tol = 6,
): SnapResult {
  const xs: number[] = []
  const ys: number[] = []
  const add = (r: Rect) => {
    xs.push(r.x, r.x + r.width / 2, r.x + r.width)
    ys.push(r.y, r.y + r.height / 2, r.y + r.height)
  }
  others.forEach(add)
  if (panel) add(panel)

  const offX = [0, moving.width / 2, moving.width]
  const offY = [0, moving.height / 2, moving.height]
  let x = moving.x, y = moving.y
  let snappedX = false, snappedY = false

  let bestDX = tol + 1
  for (let i = 0; i < offX.length; i++) {
    const edge = moving.x + offX[i]
    for (const g of xs) {
      const d = Math.abs(edge - g)
      if (d < bestDX) { bestDX = d; x = g - offX[i]; snappedX = true }
    }
  }
  let bestDY = tol + 1
  for (let i = 0; i < offY.length; i++) {
    const edge = moving.y + offY[i]
    for (const g of ys) {
      const d = Math.abs(edge - g)
      if (d < bestDY) { bestDY = d; y = g - offY[i]; snappedY = true }
    }
  }
  return { x, y, snappedX, snappedY }
}
