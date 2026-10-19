/**
 * imageData.ts — the thin DOM bridge between freeCut's pure RGBAImage and the
 * browser's <canvas>/data-URLs. Kept apart from freeCut.ts so that module stays
 * node-testable; everything here needs `document`, so it is exercised in the app
 * (npm run dev), not in vitest.
 */
import type { RGBAImage, Rect } from './freeCut'

/** Read an HTMLImageElement's pixels into an RGBAImage. */
export function htmlImageToRGBA(img: HTMLImageElement): RGBAImage {
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const id = ctx.getImageData(0, 0, w, h)
  return { data: id.data, width: id.width, height: id.height }
}

/** Decode a data-URL (or any image URL) into an RGBAImage. */
export function dataUrlToRGBA(url: string): Promise<RGBAImage> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(htmlImageToRGBA(img))
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = url
  })
}

/** Encode an RGBAImage to a PNG data-URL. */
export function rgbaToDataUrl(img: RGBAImage, type = 'image/png'): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  return canvas.toDataURL(type)
}

/** Sub-rect of an RGBAImage as a data-URL (used for previews/thumbnails). */
export function rectToDataUrl(img: RGBAImage, rect: Rect, type = 'image/png'): string {
  const canvas = document.createElement('canvas')
  canvas.width = rect.width
  canvas.height = rect.height
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
    -rect.x, -rect.y,
  )
  return canvas.toDataURL(type)
}
