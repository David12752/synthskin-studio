import type { PanelControl } from '../api/pythonClient'

/**
 * Non-clobbering re-analysis merge.
 *
 * When the user re-runs detection (e.g. after tweaking the model or confidence),
 * any control they already corrected must survive untouched. Every control the
 * backend produces is stamped `provenance: 'ai'`; the editor stamps `'user'` the
 * moment a human edits it. This merge keeps every `user` control, and only
 * accepts an incoming `ai` control where it does NOT collide (by IoU) with a
 * protected user control — so a fresh detection can add/replace AI guesses but
 * never overwrite human work.
 */

export type Bbox = [number, number, number, number]

export function bboxOf(c: PanelControl): Bbox {
  return (c.refined_bbox ?? c.bbox) as Bbox
}

export function iou(a: Bbox, b: Bbox): number {
  const ix1 = Math.max(a[0], b[0])
  const iy1 = Math.max(a[1], b[1])
  const ix2 = Math.min(a[2], b[2])
  const iy2 = Math.min(a[3], b[3])
  const iw = Math.max(0, ix2 - ix1)
  const ih = Math.max(0, iy2 - iy1)
  const inter = iw * ih
  if (inter <= 0) return 0
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1])
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

export interface MergeOptions {
  /** Overlap at/above which an incoming AI control is considered to be the same
   *  object as a protected user control (and thus dropped). */
  iouThreshold?: number
}

export interface MergeResult {
  controls: PanelControl[]
  /** How many incoming AI controls were dropped because a user control owned that spot. */
  dropped: number
  /** How many user controls were preserved. */
  preserved: number
}

/**
 * Merge a fresh analysis (`incoming`, all provenance 'ai') into the current
 * `existing` controls, preserving user-owned ones.
 */
export function mergeLayoutControls(
  existing: PanelControl[],
  incoming: PanelControl[],
  opts: MergeOptions = {},
): MergeResult {
  const iouThreshold = opts.iouThreshold ?? 0.5
  const userControls = existing.filter((c) => c.provenance === 'user')
  const userBoxes = userControls.map(bboxOf)

  let dropped = 0
  const accepted: PanelControl[] = []
  for (const inc of incoming) {
    const box = bboxOf(inc)
    const collides = userBoxes.some((ub) => iou(ub, box) >= iouThreshold)
    if (collides) {
      dropped += 1
      continue
    }
    accepted.push({ ...inc, provenance: inc.provenance ?? 'ai' })
  }

  // User controls first so they win any later de-dup by id.
  return {
    controls: [...userControls, ...accepted],
    dropped,
    preserved: userControls.length,
  }
}

/** Stamp a control as user-owned (call from every manual edit). */
export function markUserOwned<T extends PanelControl>(c: T): T {
  return { ...c, provenance: 'user' }
}
