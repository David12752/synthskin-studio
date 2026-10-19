/**
 * livewire.ts — Intelligent Scissors / magnetic lasso (Mortensen & Barrett 1995).
 *
 * Given the image gradient, find the minimum-cost path between two clicked
 * points that HUGS strong edges. Cost is low where the gradient is high, so
 * Dijkstra's shortest path naturally snaps the boundary onto the object outline —
 * the user sketches roughly and the curve latches to the real edge.
 *
 * Pure grid math (Dijkstra + binary heap), no image decoding here: the caller
 * passes a gradient-magnitude buffer computed from the working-resolution crop.
 */

export type Point = [number, number]

/** Sobel gradient magnitude of a single-channel image, normalized to [0,1]. */
export function gradientMagnitude(gray: Float32Array | number[], w: number, h: number): Float32Array {
  const g = new Float32Array(w * h)
  let max = 1e-6
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const tl = gray[i - w - 1], tc = gray[i - w], tr = gray[i - w + 1]
      const ml = gray[i - 1], mr = gray[i + 1]
      const bl = gray[i + w - 1], bc = gray[i + w], br = gray[i + w + 1]
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl)
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr)
      const mag = Math.hypot(gx, gy)
      g[i] = mag
      if (mag > max) max = mag
    }
  }
  for (let i = 0; i < g.length; i++) g[i] /= max
  return g
}

interface HeapItem { cost: number; idx: number }

/** Minimal binary min-heap keyed on cost. */
class MinHeap {
  private a: HeapItem[] = []
  get size() { return this.a.length }
  push(item: HeapItem) {
    const a = this.a
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].cost <= a[i].cost) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): HeapItem | undefined {
    const a = this.a
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop() as HeapItem
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2
        let s = i
        if (l < a.length && a[l].cost < a[s].cost) s = l
        if (r < a.length && a[r].cost < a[s].cost) s = r
        if (s === i) break
        ;[a[s], a[i]] = [a[i], a[s]]
        i = s
      }
    }
    return top
  }
}

export interface LivewireOptions {
  /** Weight of the edge (gradient) term vs the length term. Higher = hug edges
   *  more aggressively even if the path gets longer. */
  edgeWeight?: number
}

/**
 * Minimum-cost path from `start` to `end` over the gradient grid, 8-connected.
 * Returns the pixel path inclusive of both endpoints (empty if unreachable).
 */
export function livewirePath(
  grad: Float32Array,
  w: number,
  h: number,
  start: Point,
  end: Point,
  opts: LivewireOptions = {},
): Point[] {
  const edgeWeight = opts.edgeWeight ?? 4
  const sx = clamp(Math.round(start[0]), 0, w - 1)
  const sy = clamp(Math.round(start[1]), 0, h - 1)
  const ex = clamp(Math.round(end[0]), 0, w - 1)
  const ey = clamp(Math.round(end[1]), 0, h - 1)
  const startIdx = sy * w + sx
  const endIdx = ey * w + ex

  const dist = new Float32Array(w * h).fill(Infinity)
  const prev = new Int32Array(w * h).fill(-1)
  const done = new Uint8Array(w * h)
  dist[startIdx] = 0
  const heap = new MinHeap()
  heap.push({ cost: 0, idx: startIdx })

  const neighbors = [-1, 0, 1]
  while (heap.size > 0) {
    const cur = heap.pop() as HeapItem
    const idx = cur.idx
    if (done[idx]) continue
    done[idx] = 1
    if (idx === endIdx) break
    const cx = idx % w
    const cy = (idx / w) | 0
    for (const dy of neighbors) {
      for (const dx of neighbors) {
        if (dx === 0 && dy === 0) continue
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const nIdx = ny * w + nx
        if (done[nIdx]) continue
        // Cost: (1 - gradient) makes strong edges cheap; times step length.
        const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
        const edgeCost = (1 - grad[nIdx]) * edgeWeight + 0.1
        const nd = dist[idx] + edgeCost * step
        if (nd < dist[nIdx]) {
          dist[nIdx] = nd
          prev[nIdx] = idx
          heap.push({ cost: nd, idx: nIdx })
        }
      }
    }
  }

  if (prev[endIdx] === -1 && endIdx !== startIdx) return []
  const path: Point[] = []
  let p = endIdx
  let guard = w * h + 1
  while (p !== -1 && guard-- > 0) {
    path.push([p % w, (p / w) | 0])
    if (p === startIdx) break
    p = prev[p]
  }
  path.reverse()
  return path
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}
