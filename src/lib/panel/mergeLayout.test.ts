import { describe, it, expect } from 'vitest'
import { iou, mergeLayoutControls, markUserOwned, bboxOf } from './mergeLayout'
import type { PanelControl } from '../api/pythonClient'

function ctl(id: string, bbox: [number, number, number, number], provenance?: 'ai' | 'user'): PanelControl {
  return {
    id,
    type: 'knob',
    sub_type: '',
    bbox,
    width: bbox[2] - bbox[0],
    height: bbox[3] - bbox[1],
    center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
    confidence: 0.9,
    source: 'gemini',
    phrase: null,
    mask_png: null,
    parameter_id: `p_${id}`,
    display_name: id,
    provenance,
  }
}

describe('iou', () => {
  it('is 1 for identical boxes', () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1)
  })
  it('is 0 for disjoint boxes', () => {
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0)
  })
  it('is ~0.14 for half-overlap', () => {
    // two 10x10 boxes overlapping in a 5x10 strip: inter=50, union=150
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(50 / 150, 5)
  })
})

describe('bboxOf', () => {
  it('prefers refined_bbox when present', () => {
    const c = { ...ctl('a', [0, 0, 10, 10]), refined_bbox: [1, 1, 9, 9] as [number, number, number, number] }
    expect(bboxOf(c)).toEqual([1, 1, 9, 9])
  })
})

describe('mergeLayoutControls', () => {
  it('preserves a user control and drops the colliding fresh AI control', () => {
    const existing = [ctl('user1', [0, 0, 100, 100], 'user'), ctl('ai_old', [200, 200, 260, 260], 'ai')]
    const incoming = [ctl('fresh_over_user', [5, 5, 105, 105], 'ai'), ctl('fresh_elsewhere', [400, 400, 460, 460], 'ai')]
    const res = mergeLayoutControls(existing, incoming)
    expect(res.preserved).toBe(1)
    expect(res.dropped).toBe(1) // fresh_over_user collides with user1
    const ids = res.controls.map((c) => c.id)
    expect(ids).toContain('user1')
    expect(ids).toContain('fresh_elsewhere')
    expect(ids).not.toContain('fresh_over_user')
    // old AI control is replaced by fresh analysis (not carried over)
    expect(ids).not.toContain('ai_old')
  })

  it('keeps a user control even when no incoming overlaps it', () => {
    const existing = [ctl('user1', [0, 0, 50, 50], 'user')]
    const incoming = [ctl('fresh', [500, 500, 560, 560], 'ai')]
    const res = mergeLayoutControls(existing, incoming)
    expect(res.controls.map((c) => c.id).sort()).toEqual(['fresh', 'user1'])
  })

  it('accepts all incoming when there are no user controls', () => {
    const existing = [ctl('ai1', [0, 0, 10, 10], 'ai')]
    const incoming = [ctl('n1', [0, 0, 10, 10], 'ai'), ctl('n2', [50, 50, 60, 60], 'ai')]
    const res = mergeLayoutControls(existing, incoming)
    expect(res.dropped).toBe(0)
    expect(res.controls.map((c) => c.id).sort()).toEqual(['n1', 'n2'])
  })

  it('respects a custom iou threshold', () => {
    const existing = [ctl('user1', [0, 0, 10, 10], 'user')]
    const incoming = [ctl('partial', [5, 0, 15, 10], 'ai')] // iou ~0.33
    expect(mergeLayoutControls(existing, incoming, { iouThreshold: 0.5 }).dropped).toBe(0)
    expect(mergeLayoutControls(existing, incoming, { iouThreshold: 0.3 }).dropped).toBe(1)
  })
})

describe('markUserOwned', () => {
  it('stamps provenance user without mutating the original', () => {
    const c = ctl('a', [0, 0, 10, 10], 'ai')
    const marked = markUserOwned(c)
    expect(marked.provenance).toBe('user')
    expect(c.provenance).toBe('ai')
  })
})
