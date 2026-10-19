/**
 * triage.ts — turn a wall of detections into a guided review queue.
 *
 * After analysis the user lands on N overlapping boxes with no idea which to
 * trust. The professional pattern (CVAT/Roboflow) is a triage queue: auto-accept
 * the confident ones, surface the doubtful ones LOW-confidence-first for a quick
 * keyboard pass, and flag the near-misses. User-corrected controls are always
 * accepted (locked) — the human already vetted them.
 */
import type { PanelControl } from '../api/pythonClient'

export type TriageBucket = 'accepted' | 'review' | 'rejected'

export interface TriageOptions {
  /** At/above this confidence an AI control is auto-accepted. */
  acceptAbove?: number
  /** Below this confidence an AI control is flagged as a likely false positive. */
  rejectBelow?: number
}

export interface TriageResult {
  accepted: PanelControl[]
  /** Doubtful controls, LOW-confidence first (review these). */
  review: PanelControl[]
  /** Very low confidence — probably false positives, but recoverable. */
  rejected: PanelControl[]
}

export function triageBucket(control: PanelControl, opts: TriageOptions = {}): TriageBucket {
  const acceptAbove = opts.acceptAbove ?? 0.85
  const rejectBelow = opts.rejectBelow ?? 0.35
  if (control.provenance === 'user' || control.source === 'manual') return 'accepted'
  const c = control.confidence ?? 0
  if (c >= acceptAbove) return 'accepted'
  if (c < rejectBelow) return 'rejected'
  return 'review'
}

export function triageControls(controls: PanelControl[], opts: TriageOptions = {}): TriageResult {
  const accepted: PanelControl[] = []
  const review: PanelControl[] = []
  const rejected: PanelControl[] = []
  for (const c of controls) {
    const b = triageBucket(c, opts)
    if (b === 'accepted') accepted.push(c)
    else if (b === 'review') review.push(c)
    else rejected.push(c)
  }
  // Review lowest-confidence first — the most likely to need a human.
  review.sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0))
  rejected.sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0))
  return { accepted, review, rejected }
}

/** Fraction of the queue the user has already dispositioned (0..1). */
export function reviewProgress(total: number, remaining: number): number {
  if (total <= 0) return 1
  return Math.min(1, Math.max(0, (total - remaining) / total))
}
