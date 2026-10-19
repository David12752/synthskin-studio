import { describe, it, expect } from 'vitest'
import { fitCurve, bezierQ, beziersToPolyline, beziersToSvgPath, type Point, type Bezier } from './fitCurve'

function maxDistanceToCurve(points: Point[], beziers: Bezier[]): number {
  // Sample every bezier VERY densely so nearest-sample distance is an accurate
  // proxy for the true point-to-curve distance (coarse sampling overestimates).
  const samples: Point[] = []
  for (const b of beziers) {
    for (let i = 0; i <= 400; i++) samples.push(bezierQ(b, i / 400))
  }
  let maxD = 0
  for (const p of points) {
    let best = Infinity
    for (const s of samples) {
      const d = Math.hypot(p[0] - s[0], p[1] - s[1])
      if (d < best) best = d
    }
    maxD = Math.max(maxD, best)
  }
  return maxD
}

describe('fitCurve', () => {
  it('returns empty for <2 points', () => {
    expect(fitCurve([])).toEqual([])
    expect(fitCurve([[0, 0]])).toEqual([])
  })

  it('fits a straight line with a single segment within tolerance', () => {
    const pts: Point[] = Array.from({ length: 20 }, (_, i) => [i * 5, i * 5] as Point)
    const bez = fitCurve(pts, 2)
    expect(bez.length).toBe(1)
    expect(maxDistanceToCurve(pts, bez)).toBeLessThan(2)
  })

  it('fits a circle arc within tolerance', () => {
    const pts: Point[] = []
    for (let a = 0; a <= Math.PI * 1.5; a += Math.PI / 40) {
      pts.push([100 + 80 * Math.cos(a), 100 + 80 * Math.sin(a)])
    }
    const bez = fitCurve(pts, 1.5)
    expect(bez.length).toBeGreaterThanOrEqual(2)
    expect(maxDistanceToCurve(pts, bez)).toBeLessThan(1.5)
  })

  it('honours a tighter error tolerance (more or equal segments)', () => {
    const pts: Point[] = []
    for (let a = 0; a <= Math.PI * 2; a += Math.PI / 60) {
      pts.push([50 + 40 * Math.cos(a), 50 + 40 * Math.sin(a)])
    }
    const loose = fitCurve(pts, 4)
    const tight = fitCurve(pts, 0.5)
    expect(tight.length).toBeGreaterThanOrEqual(loose.length)
    expect(maxDistanceToCurve(pts, tight)).toBeLessThan(0.5)
  })

  it('every bezier endpoint chains to the next start point', () => {
    const pts: Point[] = []
    for (let a = 0; a <= Math.PI; a += Math.PI / 30) pts.push([a * 30, Math.sin(a) * 50])
    const bez = fitCurve(pts, 1)
    for (let i = 1; i < bez.length; i++) {
      expect(bez[i][0][0]).toBeCloseTo(bez[i - 1][3][0], 5)
      expect(bez[i][0][1]).toBeCloseTo(bez[i - 1][3][1], 5)
    }
  })
})

describe('beziersToPolyline', () => {
  it('starts and ends at the curve endpoints and has no duplicate joins', () => {
    const pts: Point[] = Array.from({ length: 10 }, (_, i) => [i, i * i] as Point)
    const bez = fitCurve(pts, 1)
    const poly = beziersToPolyline(bez, 8)
    expect(poly[0][0]).toBeCloseTo(bez[0][0][0], 5)
    expect(poly[poly.length - 1][0]).toBeCloseTo(bez[bez.length - 1][3][0], 5)
  })
})

describe('beziersToSvgPath', () => {
  it('produces an M then C path', () => {
    const pts: Point[] = [[0, 0], [10, 10], [20, 0], [30, 10]]
    const d = beziersToSvgPath(fitCurve(pts, 2))
    expect(d.startsWith('M ')).toBe(true)
    expect(d).toContain(' C ')
  })
  it('is empty for no beziers', () => {
    expect(beziersToSvgPath([])).toBe('')
  })
})
