/**
 * freeCut.ts — cut an arbitrary region out of ANY image into a transparent part.
 *
 * Phase 2 of the work plan: the app must let a user lasso / rect / mask-select a
 * region from the loaded panel OR a freshly imported image and turn it into a
 * placeable, transparent "part" (for the compositing canvas in Phase 3). The
 * existing cut code lives inside canvas components and is welded to the detected-
 * control flow; this module is the pure, framework-free core so it is unit-
 * testable in node (no real <canvas> needed) and reusable anywhere.
 *
 * Everything operates on a plain RGBAImage ({data,width,height}) which is
 * structurally compatible with the DOM `ImageData`, so browser code can pass a
 * real ImageData straight in. Encoding to/from data-URLs (which needs the DOM)
 * lives in ./imageData.ts.
 */

export interface Pt {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Structurally compatible with the DOM `ImageData`. */
export interface RGBAImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

// ── geometry ──────────────────────────────────────────────────────────────────

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Rasterize a polygon to a single-channel coverage mask (0..255). Edges are
 * anti-aliased by `supersample`^2 sampling; only the polygon's bounding box is
 * scanned, so cost scales with the selection, not the whole image.
 */
export function rasterizePolygon(
  poly: Pt[],
  width: number,
  height: number,
  opts?: { supersample?: number },
): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(width * height)
  if (poly.length < 3) return mask
  const ss = Math.max(1, Math.min(4, opts?.supersample ?? 2))

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of poly) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(width - 1, Math.ceil(maxX))
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(height - 1, Math.ceil(maxY))
  const inv = 1 / (ss * ss)

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hits = 0
      for (let sy = 0; sy < ss; sy++) {
        const py = y + (sy + 0.5) / ss
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss
          if (pointInPolygon(px, py, poly)) hits++
        }
      }
      if (hits) mask[y * width + x] = Math.round(hits * inv * 255)
    }
  }
  return mask
}

/** Tight bounding box of a coverage mask above `threshold`, or null if empty. */
export function boundsOfMask(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 0,
): Rect | null {
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > threshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// ── pixel ops ─────────────────────────────────────────────────────────────────

/** New RGBA image = source colour with alpha multiplied by the coverage mask. */
export function applyMask(src: RGBAImage, mask: Uint8ClampedArray): RGBAImage {
  const { width, height, data } = src
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    out[o] = data[o]
    out[o + 1] = data[o + 1]
    out[o + 2] = data[o + 2]
    out[o + 3] = Math.round((mask[i] * data[o + 3]) / 255)
  }
  return { data: out, width, height }
}

/** Copy a rectangular sub-region into a new image (clamped to bounds). */
export function cropImage(src: RGBAImage, rect: Rect): RGBAImage {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const w = Math.min(src.width - x0, Math.round(rect.width))
  const h = Math.min(src.height - y0, Math.round(rect.height))
  const out = new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4)
  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * src.width + x0) * 4
    out.set(src.data.subarray(srcStart, srcStart + w * 4), y * w * 4)
  }
  return { data: out, width: Math.max(0, w), height: Math.max(0, h) }
}

// ── high-level cuts ───────────────────────────────────────────────────────────

export interface CutResult {
  image: RGBAImage
  /** Bounds of the cut within the SOURCE image (so placement knows its origin). */
  bounds: Rect
}

/** Cut a polygon (lasso) region out of a source image. Null if it's empty. */
export function cutPolygon(
  src: RGBAImage,
  poly: Pt[],
  opts?: { supersample?: number },
): CutResult | null {
  const mask = rasterizePolygon(poly, src.width, src.height, opts)
  const bounds = boundsOfMask(mask, src.width, src.height, 0)
  if (!bounds) return null
  const masked = applyMask(src, mask)
  return { image: cropImage(masked, bounds), bounds }
}

/** Cut a rectangle out of a source image (keeps existing alpha). */
export function cutRect(src: RGBAImage, rect: Rect): CutResult | null {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const w = Math.min(src.width - x0, Math.round(rect.width))
  const h = Math.min(src.height - y0, Math.round(rect.height))
  if (w <= 0 || h <= 0) return null
  const bounds = { x: x0, y: y0, width: w, height: h }
  return { image: cropImage(src, bounds), bounds }
}

/**
 * Cut using a coverage mask (from magic-wand / SAM). `mask` is full-image sized
 * (width*height) with 0..255 coverage.
 */
export function cutMask(src: RGBAImage, mask: Uint8ClampedArray): CutResult | null {
  const bounds = boundsOfMask(mask, src.width, src.height, 0)
  if (!bounds) return null
  const masked = applyMask(src, mask)
  return { image: cropImage(masked, bounds), bounds }
}
