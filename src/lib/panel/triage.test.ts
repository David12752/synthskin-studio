import { describe, it, expect } from 'vitest'
import { triageBucket, triageControls, reviewProgress } from './triage'
import type { PanelControl } from '../api/pythonClient'

function ctl(id: string, confidence: number, extra: Partial<PanelControl> = {}): PanelControl {
  return {
    id, type: 'knob', sub_type: '', bbox: [0, 0, 10, 10], width: 10, height: 10,
    center: [5, 5], confidence, source: 'gemini', phrase: null, mask_png: null,
    parameter_id: `p_${id}`, display_name: id, ...extra,
  }
}

describe('triageBucket', () => {
  it('auto-accepts high confidence', () => {
    expect(triageBucket(ctl('a', 0.95))).toBe('accepted')
  })
  it('reviews mid confidence', () => {
    expect(triageBucket(ctl('b', 0.6))).toBe('review')
  })
  it('rejects very low confidence', () => {
    expect(triageBucket(ctl('c', 0.1))).toBe('rejected')
  })
  it('always accepts user-owned controls regardless of confidence', () => {
    expect(triageBucket(ctl('d', 0.05, { provenance: 'user' }))).toBe('accepted')
    expect(triageBucket(ctl('e', 0.05, { source: 'manual' }))).toBe('accepted')
  })
  it('honours custom thresholds', () => {
    expect(triageBucket(ctl('f', 0.7), { acceptAbove: 0.6 })).toBe('accepted')
    expect(triageBucket(ctl('g', 0.5), { rejectBelow: 0.6 })).toBe('rejected')
  })
})

describe('triageControls', () => {
  it('buckets and sorts review lowest-confidence first', () => {
    const res = triageControls([
      ctl('hi', 0.95),
      ctl('mid_high', 0.7),
      ctl('mid_low', 0.45),
      ctl('low', 0.1),
      ctl('user', 0.02, { provenance: 'user' }),
    ])
    expect(res.accepted.map((c) => c.id).sort()).toEqual(['hi', 'user'])
    expect(res.review.map((c) => c.id)).toEqual(['mid_low', 'mid_high']) // ascending
    expect(res.rejected.map((c) => c.id)).toEqual(['low'])
  })
})

describe('reviewProgress', () => {
  it('is 0 at start, 1 when done', () => {
    expect(reviewProgress(10, 10)).toBe(0)
    expect(reviewProgress(10, 0)).toBe(1)
    expect(reviewProgress(10, 5)).toBe(0.5)
  })
  it('handles empty queue', () => {
    expect(reviewProgress(0, 0)).toBe(1)
  })
})
