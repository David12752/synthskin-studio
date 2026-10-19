import { describe, it, expect } from 'vitest'
import {
  pointInPolygon, rasterizePolygon, boundsOfMask, applyMask, cropImage,
  cutPolygon, cutRect, cutMask, type RGBAImage, type Pt,
} from './freeCut'

/** A solid opaque image filled with one RGB colour. */
function solid(w: number, h: number, r: number, g: number, b: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255
  }
  return { data, width: w, height: h }
}

const alphaAt = (img: RGBAImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3]
const rgbAt = (img: RGBAImage, x: number, y: number) => {
  const o = (y * img.width + x) * 4
  return [img.data[o], img.data[o + 1], img.data[o + 2]]
}

describe('pointInPolygon', () => {
  const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  it('inside is true', () => expect(pointInPolygon(5, 5, sq)).toBe(true))
  it('outside is false', () => expect(pointInPolygon(15, 5, sq)).toBe(false))
})

describe('rasterizePolygon', () => {
  it('fills interior 255 and exterior 0', () => {
    const poly: Pt[] = [{ x: 2, y: 2 }, { x: 18, y: 2 }, { x: 18, y: 18 }, { x: 2, y: 18 }]
    const m = rasterizePolygon(poly, 20, 20)
    expect(m[10 * 20 + 10]).toBe(255)     // deep interior
    expect(m[0 * 20 + 0]).toBe(0)         // far exterior
  })
  it('anti-aliases a diagonal edge (partial coverage exists)', () => {
    const tri: Pt[] = [{ x: 10, y: 2 }, { x: 18, y: 18 }, { x: 2, y: 18 }]
    const m = rasterizePolygon(tri, 20, 20, { supersample: 2 })
    const partials = Array.from(m).filter((v) => v > 0 && v < 255)
    expect(partials.length).toBeGreaterThan(0)
  })
  it('degenerate polygon -> empty mask', () => {
    expect(Array.from(rasterizePolygon([{ x: 1, y: 1 }], 5, 5)).every((v) => v === 0)).toBe(true)
  })
})

describe('boundsOfMask', () => {
  it('finds the tight bbox', () => {
    const m = new Uint8ClampedArray(10 * 10)
    m[3 * 10 + 4] = 255
    m[6 * 10 + 7] = 255
    expect(boundsOfMask(m, 10, 10)).toEqual({ x: 4, y: 3, width: 4, height: 4 })
  })
  it('empty mask -> null', () => {
    expect(boundsOfMask(new Uint8ClampedArray(4), 2, 2)).toBeNull()
  })
})

describe('applyMask', () => {
  it('multiplies alpha and keeps colour', () => {
    const src = solid(2, 1, 10, 20, 30)
    const mask = new Uint8ClampedArray([255, 0])
    const out = applyMask(src, mask)
    expect(alphaAt(out, 0, 0)).toBe(255)
    expect(alphaAt(out, 1, 0)).toBe(0)
    expect(rgbAt(out, 0, 0)).toEqual([10, 20, 30])
  })
})

describe('cropImage', () => {
  it('extracts a sub-rect', () => {
    const src = solid(4, 4, 5, 5, 5)
    const c = cropImage(src, { x: 1, y: 1, width: 2, height: 2 })
    expect(c.width).toBe(2)
    expect(c.height).toBe(2)
    expect(alphaAt(c, 0, 0)).toBe(255)
  })
})

describe('cutPolygon', () => {
  it('cuts a triangle: bounds tight, inside kept, outside transparent', () => {
    const src = solid(20, 20, 255, 0, 0)
    const tri: Pt[] = [{ x: 10, y: 2 }, { x: 18, y: 18 }, { x: 2, y: 18 }]
    const res = cutPolygon(src, tri)!
    expect(res).not.toBeNull()
    // bbox of the triangle is ~[2,2]..[18,18]
    expect(res.bounds.x).toBeLessThanOrEqual(2)
    expect(res.bounds.y).toBeLessThanOrEqual(2)
    expect(res.bounds.width).toBeGreaterThanOrEqual(15)
    // a point near the centroid is kept & red
    const cx = Math.round(10 - res.bounds.x)
    const cy = Math.round(13 - res.bounds.y)
    expect(alphaAt(res.image, cx, cy)).toBe(255)
    expect(rgbAt(res.image, cx, cy)).toEqual([255, 0, 0])
    // the top-left corner of the crop is OUTSIDE the triangle -> transparent
    expect(alphaAt(res.image, 0, 0)).toBe(0)
  })
  it('empty selection -> null', () => {
    const src = solid(10, 10, 1, 1, 1)
    expect(cutPolygon(src, [{ x: -5, y: -5 }, { x: -1, y: -5 }, { x: -3, y: -1 }])).toBeNull()
  })
})

describe('cutRect', () => {
  it('crops and clamps to source', () => {
    const src = solid(10, 10, 9, 9, 9)
    const res = cutRect(src, { x: 5, y: 5, width: 20, height: 20 })!
    expect(res.bounds).toEqual({ x: 5, y: 5, width: 5, height: 5 })
    expect(res.image.width).toBe(5)
  })
  it('zero-size -> null', () => {
    expect(cutRect(solid(4, 4, 0, 0, 0), { x: 0, y: 0, width: 0, height: 0 })).toBeNull()
  })
})

describe('cutMask', () => {
  it('cuts using a coverage mask', () => {
    const src = solid(6, 6, 100, 100, 100)
    const mask = new Uint8ClampedArray(36)
    for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) mask[y * 6 + x] = 255
    const res = cutMask(src, mask)!
    expect(res.bounds).toEqual({ x: 2, y: 2, width: 2, height: 2 })
    expect(alphaAt(res.image, 0, 0)).toBe(255)
  })
})
