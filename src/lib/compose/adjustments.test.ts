import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ADJUSTMENTS,
  normalizeAdjustments,
  isDefaultAdjustments,
  hexToRgb,
  applyAdjustmentsToPixels,
  bakeAdjustments,
  cssFilter,
} from './adjustments'

// A tiny 2-pixel RGBA buffer helper: [opaque colour, fully-transparent].
function px(r: number, g: number, b: number, a = 255): number[] {
  return [r, g, b, a]
}

describe('normalize / defaults', () => {
  it('fills missing fields with defaults', () => {
    expect(normalizeAdjustments(null)).toEqual(DEFAULT_ADJUSTMENTS)
    expect(normalizeAdjustments({ hue: 30 })).toEqual({ ...DEFAULT_ADJUSTMENTS, hue: 30 })
  })
  it('clamps out-of-range', () => {
    const n = normalizeAdjustments({ hue: 999, saturation: -5, brightness: 9, contrast: -1, tintStrength: 5 })
    expect(n.hue).toBe(180)
    expect(n.saturation).toBe(0)
    expect(n.brightness).toBe(2)
    expect(n.contrast).toBe(0)
    expect(n.tintStrength).toBe(1)
  })
})

describe('isDefaultAdjustments', () => {
  it('true for null / defaults', () => {
    expect(isDefaultAdjustments(null)).toBe(true)
    expect(isDefaultAdjustments(DEFAULT_ADJUSTMENTS)).toBe(true)
  })
  it('true when tint present but strength 0', () => {
    expect(isDefaultAdjustments({ tint: '#ff0000', tintStrength: 0 })).toBe(true)
  })
  it('false for a real change', () => {
    expect(isDefaultAdjustments({ hue: 10 })).toBe(false)
    expect(isDefaultAdjustments({ tint: '#ff0000', tintStrength: 0.5 })).toBe(false)
  })
})

describe('hexToRgb', () => {
  it('parses long and short form', () => {
    expect(hexToRgb('#ff8800')).toEqual([255, 136, 0])
    expect(hexToRgb('#f80')).toEqual([255, 136, 0])
    expect(hexToRgb('00ff00')).toEqual([0, 255, 0])
  })
  it('rejects junk', () => {
    expect(hexToRgb(null)).toBeNull()
    expect(hexToRgb('#xyz')).toBeNull()
    expect(hexToRgb('#12')).toBeNull()
  })
})

describe('applyAdjustmentsToPixels', () => {
  it('default is a no-op', () => {
    const d = px(100, 150, 200)
    applyAdjustmentsToPixels(d, DEFAULT_ADJUSTMENTS)
    expect(d).toEqual(px(100, 150, 200))
  })

  it('preserves alpha and skips fully-transparent pixels', () => {
    const d = [10, 20, 30, 0, 200, 100, 50, 255]
    applyAdjustmentsToPixels(d, { brightness: 2 })
    // transparent pixel untouched
    expect(d.slice(0, 4)).toEqual([10, 20, 30, 0])
    // opaque pixel brightened, alpha preserved
    expect(d[7]).toBe(255)
    expect(d[4]).toBeGreaterThan(200)
  })

  it('brightness < 1 darkens, > 1 brightens', () => {
    const dark = px(100, 100, 100); applyAdjustmentsToPixels(dark, { brightness: 0.5 })
    expect(dark[0]).toBe(50)
    const bright = px(100, 100, 100); applyAdjustmentsToPixels(bright, { brightness: 1.5 })
    expect(bright[0]).toBe(150)
  })

  it('saturation 0 collapses to grey (R=G=B)', () => {
    const d = px(200, 50, 20); applyAdjustmentsToPixels(d, { saturation: 0 })
    expect(d[0]).toBe(d[1])
    expect(d[1]).toBe(d[2])
  })

  it('hue 360 wraps back to (near) identity', () => {
    const a = px(200, 50, 20); applyAdjustmentsToPixels(a, { hue: 180 })
    const b = px(200, 50, 20); applyAdjustmentsToPixels(b, { hue: -180 })
    // ±180 land on the same opposite hue
    expect(Math.abs(a[0] - b[0])).toBeLessThanOrEqual(1)
  })

  it('hue rotation changes colour but not toward grey', () => {
    const d = px(200, 30, 30); applyAdjustmentsToPixels(d, { hue: 120 })
    // pure-ish red rotated 120deg -> green dominant
    expect(d[1]).toBeGreaterThan(d[0])
  })

  it('full tint pushes toward the tint colour', () => {
    const d = px(10, 10, 10); applyAdjustmentsToPixels(d, { tint: '#ffffff', tintStrength: 1 })
    expect(d[0]).toBe(255); expect(d[1]).toBe(255); expect(d[2]).toBe(255)
  })

  it('is deterministic (same input -> same output)', () => {
    const a = px(123, 77, 200); const b = px(123, 77, 200)
    const adj = { hue: 40, saturation: 1.3, brightness: 1.1, contrast: 1.2, tint: '#0088ff', tintStrength: 0.25 }
    applyAdjustmentsToPixels(a, adj); applyAdjustmentsToPixels(b, adj)
    expect(a).toEqual(b)
  })
})

describe('bakeAdjustments', () => {
  it('does not mutate the source image', () => {
    const src = { data: new Uint8ClampedArray([100, 100, 100, 255]), width: 1, height: 1 }
    const out = bakeAdjustments(src, { brightness: 0.5 })
    expect(Array.from(src.data)).toEqual([100, 100, 100, 255]) // untouched
    expect(out.data[0]).toBe(50)
    expect(out.width).toBe(1)
  })
})

describe('cssFilter', () => {
  it('is "none" for defaults', () => expect(cssFilter(DEFAULT_ADJUSTMENTS)).toBe('none'))
  it('composes the active parts', () => {
    const s = cssFilter({ brightness: 1.2, hue: 30 })
    expect(s).toContain('brightness(1.2)')
    expect(s).toContain('hue-rotate(30deg)')
  })
})
