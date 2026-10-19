/**
 * fitCurve.ts — Schneider's "An Algorithm for Automatically Fitting Digitized
 * Curves" (Graphics Gems, 1990). Converts a dense polyline (e.g. the backend's
 * contour_polygon) into a compact chain of cubic Bézier segments so the pen tool
 * can expose editable anchors + handles instead of hundreds of raw points.
 *
 * Pure geometry, no dependencies. The mask stays authoritative for export; this
 * vector path persists alongside it for non-destructive re-editing.
 */

export type Point = [number, number]
/** Cubic Bézier: [p0, c1, c2, p3]. */
export type Bezier = [Point, Point, Point, Point]

const v = {
  sub: (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]],
  add: (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]],
  mul: (a: Point, s: number): Point => [a[0] * s, a[1] * s],
  dot: (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1],
  len: (a: Point): number => Math.hypot(a[0], a[1]),
  norm: (a: Point): Point => {
    const l = Math.hypot(a[0], a[1])
    return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]
  },
}

/** Fit a chain of cubic Béziers to `points` within `maxError` (px). */
export function fitCurve(points: Point[], maxError = 2): Bezier[] {
  const pts = dedupe(points)
  if (pts.length < 2) return []
  if (pts.length === 2) {
    const t = v.norm(v.sub(pts[1], pts[0]))
    return fitCubic(pts, t, v.mul(t, -1), maxError)
  }
  const leftTangent = v.norm(v.sub(pts[1], pts[0]))
  const rightTangent = v.norm(v.sub(pts[pts.length - 2], pts[pts.length - 1]))
  return fitCubic(pts, leftTangent, rightTangent, maxError)
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p)
  }
  return out
}

function fitCubic(pts: Point[], leftTangent: Point, rightTangent: Point, error: number): Bezier[] {
  // Only two points → heuristic line segment as a Bézier.
  if (pts.length === 2) {
    const dist = v.len(v.sub(pts[1], pts[0])) / 3
    return [[
      pts[0],
      v.add(pts[0], v.mul(leftTangent, dist)),
      v.add(pts[1], v.mul(rightTangent, dist)),
      pts[1],
    ]]
  }

  const u = chordLengthParameterize(pts)
  let bezier = generateBezier(pts, u, leftTangent, rightTangent)
  let [maxErr, splitPoint] = computeMaxError(pts, bezier, u)
  if (maxErr < error) return [bezier]

  // Try Newton-Raphson reparameterization before splitting. Newton can diverge,
  // so keep the best bezier/split seen and stop early if it stops improving.
  let bestBezier = bezier
  let bestErr = maxErr
  let bestSplit = splitPoint
  let uPrime = u
  for (let i = 0; i < 8; i++) {
    uPrime = reparameterize(bezier, pts, uPrime)
    bezier = generateBezier(pts, uPrime, leftTangent, rightTangent)
    ;[maxErr, splitPoint] = computeMaxError(pts, bezier, uPrime)
    if (maxErr < error) return [bezier]
    if (maxErr < bestErr) {
      bestErr = maxErr
      bestBezier = bezier
      bestSplit = splitPoint
    }
  }
  splitPoint = bestSplit
  void bestBezier

  // Split at the point of max error and fit recursively.
  const centerTangent = v.norm(v.sub(pts[splitPoint - 1], pts[splitPoint + 1]))
  const left = fitCubic(pts.slice(0, splitPoint + 1), leftTangent, centerTangent, error)
  const right = fitCubic(pts.slice(splitPoint), v.mul(centerTangent, -1), rightTangent, error)
  return [...left, ...right]
}

function chordLengthParameterize(pts: Point[]): number[] {
  const u = [0]
  for (let i = 1; i < pts.length; i++) u[i] = u[i - 1] + v.len(v.sub(pts[i], pts[i - 1]))
  const total = u[u.length - 1] || 1
  return u.map((x) => x / total)
}

function generateBezier(pts: Point[], u: number[], leftTangent: Point, rightTangent: Point): Bezier {
  const first = pts[0]
  const last = pts[pts.length - 1]
  const A: [Point, Point][] = u.map((ui) => {
    const b1 = 3 * ui * (1 - ui) * (1 - ui)
    const b2 = 3 * ui * ui * (1 - ui)
    return [v.mul(leftTangent, b1), v.mul(rightTangent, b2)]
  })

  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0
  for (let i = 0; i < pts.length; i++) {
    const [a0, a1] = A[i]
    c00 += v.dot(a0, a0)
    c01 += v.dot(a0, a1)
    c11 += v.dot(a1, a1)
    const tmp = v.sub(pts[i], bezierQ([first, first, last, last], u[i]))
    x0 += v.dot(a0, tmp)
    x1 += v.dot(a1, tmp)
  }

  const detC0C1 = c00 * c11 - c01 * c01
  const detC0X = c00 * x1 - c01 * x0
  const detXC1 = x0 * c11 - x1 * c01
  let alphaL = detC0C1 === 0 ? 0 : detXC1 / detC0C1
  let alphaR = detC0C1 === 0 ? 0 : detC0X / detC0C1

  const segLength = v.len(v.sub(last, first))
  const epsilon = 1e-6 * segLength
  if (alphaL < epsilon || alphaR < epsilon) {
    // Fall back to Wu/Barsky heuristic (equal thirds).
    alphaL = alphaR = segLength / 3
  }
  return [
    first,
    v.add(first, v.mul(leftTangent, alphaL)),
    v.add(last, v.mul(rightTangent, alphaR)),
    last,
  ]
}

/** Evaluate a cubic Bézier at t. */
export function bezierQ(b: Bezier, t: number): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const c = 3 * mt * mt * t
  const d = 3 * mt * t * t
  const e = t * t * t
  return [
    a * b[0][0] + c * b[1][0] + d * b[2][0] + e * b[3][0],
    a * b[0][1] + c * b[1][1] + d * b[2][1] + e * b[3][1],
  ]
}

function bezierQPrime(b: Bezier, t: number): Point {
  const mt = 1 - t
  const c0: Point = v.mul(v.sub(b[1], b[0]), 3)
  const c1: Point = v.mul(v.sub(b[2], b[1]), 3)
  const c2: Point = v.mul(v.sub(b[3], b[2]), 3)
  return [
    mt * mt * c0[0] + 2 * mt * t * c1[0] + t * t * c2[0],
    mt * mt * c0[1] + 2 * mt * t * c1[1] + t * t * c2[1],
  ]
}

function bezierQPrimePrime(b: Bezier, t: number): Point {
  const d0: Point = v.mul(v.add(v.sub(b[2], v.mul(b[1], 2)), b[0]), 6)
  const d1: Point = v.mul(v.add(v.sub(b[3], v.mul(b[2], 2)), b[1]), 6)
  return [(1 - t) * d0[0] + t * d1[0], (1 - t) * d0[1] + t * d1[1]]
}

function reparameterize(bezier: Bezier, pts: Point[], u: number[]): number[] {
  return u.map((ui, i) => newtonRaphson(bezier, pts[i], ui))
}

function newtonRaphson(bezier: Bezier, point: Point, u: number): number {
  const d = v.sub(bezierQ(bezier, u), point)
  const qp = bezierQPrime(bezier, u)
  const qpp = bezierQPrimePrime(bezier, u)
  const numerator = v.dot(d, qp)
  const denominator = v.dot(qp, qp) + v.dot(d, qpp)
  if (Math.abs(denominator) < 1e-12) return u
  const next = u - numerator / denominator
  // Clamp to [0,1]; an out-of-range parameter corrupts the next generateBezier.
  return next < 0 ? 0 : next > 1 ? 1 : next
}

function computeMaxError(pts: Point[], bezier: Bezier, u: number[]): [number, number] {
  let maxDist = 0
  let splitPoint = Math.floor(pts.length / 2)
  for (let i = 1; i < pts.length - 1; i++) {
    const q = bezierQ(bezier, u[i])
    const dist = v.len(v.sub(q, pts[i])) // actual distance, consistent with `error`
    if (dist > maxDist) {
      maxDist = dist
      splitPoint = i
    }
  }
  return [maxDist, splitPoint]
}

/** Flatten a Bézier chain back into a polyline (for rasterizing to a mask). */
export function beziersToPolyline(beziers: Bezier[], samplesPerSegment = 16): Point[] {
  const out: Point[] = []
  for (const b of beziers) {
    for (let i = 0; i <= samplesPerSegment; i++) {
      if (i === 0 && out.length > 0) continue // avoid duplicate join points
      out.push(bezierQ(b, i / samplesPerSegment))
    }
  }
  return out
}

/** Serialize a Bézier chain to an SVG path `d` string. */
export function beziersToSvgPath(beziers: Bezier[]): string {
  if (beziers.length === 0) return ''
  const [p0] = beziers[0]
  let d = `M ${p0[0].toFixed(2)} ${p0[1].toFixed(2)}`
  for (const b of beziers) {
    d += ` C ${b[1][0].toFixed(2)} ${b[1][1].toFixed(2)}, ${b[2][0].toFixed(2)} ${b[2][1].toFixed(2)}, ${b[3][0].toFixed(2)} ${b[3][1].toFixed(2)}`
  }
  return d
}
