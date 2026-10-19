import { describe, it, expect } from 'vitest'
import { gradientMagnitude, livewirePath, type Point } from './livewire'

// Build a grayscale image: a bright square on a dark background. Its border is a
// strong-gradient ring the livewire should snap to.
function squareImage(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Float32Array {
  const g = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      g[y * w + x] = x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0
    }
  }
  return g
}

describe('gradientMagnitude', () => {
  it('is high on the square border, ~0 in flat interior/exterior', () => {
    const w = 40, h = 40
    const img = squareImage(w, h, 10, 10, 30, 30)
    const grad = gradientMagnitude(img, w, h)
    const border = grad[20 * w + 10] // left edge at x=10, y=20
    const interior = grad[20 * w + 20]
    const exterior = grad[2 * w + 2]
    expect(border).toBeGreaterThan(0.5)
    expect(interior).toBeLessThan(0.1)
    expect(exterior).toBeLessThan(0.1)
  })
})

describe('livewirePath', () => {
  const w = 40, h = 40
  const img = squareImage(w, h, 10, 10, 30, 30)
  const grad = gradientMagnitude(img, w, h)

  it('returns a connected path between the endpoints', () => {
    const path = livewirePath(grad, w, h, [10, 10], [10, 29])
    expect(path.length).toBeGreaterThan(0)
    expect(path[0]).toEqual([10, 10])
    expect(path[path.length - 1]).toEqual([10, 29])
    // 8-connected: consecutive points are adjacent
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i][0] - path[i - 1][0])
      const dy = Math.abs(path[i][1] - path[i - 1][1])
      expect(dx <= 1 && dy <= 1 && dx + dy > 0).toBe(true)
    }
  })

  it('hugs the strong edge rather than cutting across flat regions', () => {
    // Two points on the left border; the min-cost path should ride the border
    // (mean gradient high), not drift into the flat interior/exterior.
    const path = livewirePath(grad, w, h, [10, 12], [10, 28], { edgeWeight: 8 })
    const meanGrad = path.reduce((s, [x, y]) => s + grad[y * w + x], 0) / path.length
    expect(meanGrad).toBeGreaterThan(0.4)
    // it should stay near the x=10 column (within a couple px), not wander
    const maxDx = Math.max(...path.map(([x]) => Math.abs(x - 10)))
    expect(maxDx).toBeLessThanOrEqual(3)
  })

  it('degenerate start==end returns a single point', () => {
    const path = livewirePath(grad, w, h, [5, 5], [5, 5])
    expect(path).toEqual([[5, 5]] as Point[])
  })
})
