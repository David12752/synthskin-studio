/**
 * adjustments.ts — non-destructive per-element recolor / tone (Phase 4).
 *
 * A placed element carries an optional `Adjustments` object. The SAME pure pixel
 * function drives both the live compositing preview and the export bake, so what
 * the user sees is exactly what ships (the DoD's "bake determinism"). This module
 * is framework-free and node-testable; DOM encode/decode lives in ../cut/imageData.
 *
 * Pipeline per pixel (RGB in 0..1, alpha untouched):
 *   1. brightness  — multiply RGB by `brightness`
 *   2. contrast    — v = (v - 0.5) * contrast + 0.5
 *   3. hue + sat   — via HSL: rotate hue, scale saturation
 *   4. tint        — blend toward `tint` colour by `tintStrength`
 */
import type { RGBAImage } from '../cut/freeCut'

export interface Adjustments {
  /** Hue rotation in degrees, −180..180. 0 = unchanged. */
  hue: number
  /** Saturation multiplier, 0..2. 1 = unchanged, 0 = greyscale. */
  saturation: number
  /** Brightness multiplier, 0..2. 1 = unchanged. */
  brightness: number
  /** Contrast multiplier, 0..2. 1 = unchanged. */
  contrast: number
  /** Tint colour `#rrggbb`, or null for none. */
  tint: string | null
  /** How strongly to blend toward `tint`, 0..1. 0 = no tint. */
  tintStrength: number
}

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  hue: 0,
  saturation: 1,
  brightness: 1,
  contrast: 1,
  tint: null,
  tintStrength: 0,
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Fill missing fields with defaults and clamp everything into range. */
export function normalizeAdjustments(a?: Partial<Adjustments> | null): Adjustments {
  const src = a ?? {}
  return {
    hue: clamp(src.hue ?? 0, -180, 180),
    saturation: clamp(src.saturation ?? 1, 0, 2),
    brightness: clamp(src.brightness ?? 1, 0, 2),
    contrast: clamp(src.contrast ?? 1, 0, 2),
    tint: src.tint ?? null,
    tintStrength: clamp(src.tintStrength ?? 0, 0, 1),
  }
}

/** True when the adjustments are a visual no-op (so we can skip baking/caching). */
export function isDefaultAdjustments(a?: Partial<Adjustments> | null): boolean {
  if (!a) return true
  const n = normalizeAdjustments(a)
  return (
    n.hue === 0 &&
    n.saturation === 1 &&
    n.brightness === 1 &&
    n.contrast === 1 &&
    (n.tint === null || n.tintStrength === 0)
  )
}

/** Parse `#rgb` / `#rrggbb` into 0..255 triplet, or null. */
export function hexToRgb(hex: string | null): [number, number, number] | null {
  if (!hex) return null
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

// ── HSL <-> RGB (all channels 0..1) ────────────────────────────────────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l] // achromatic
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)]
}

/**
 * Apply adjustments to an RGBA byte buffer in place. Accepts a `Uint8ClampedArray`
 * (DOM ImageData.data) or a plain number[] (tests). Alpha bytes are preserved.
 */
export function applyAdjustmentsToPixels(data: Uint8ClampedArray | number[], adj?: Partial<Adjustments> | null): void {
  const a = normalizeAdjustments(adj)
  if (isDefaultAdjustments(a)) return
  const tintRgb = a.tintStrength > 0 ? hexToRgb(a.tint) : null
  const hueShift = a.hue / 360
  const tr = tintRgb ? tintRgb[0] / 255 : 0
  const tg = tintRgb ? tintRgb[1] / 255 : 0
  const tb = tintRgb ? tintRgb[2] / 255 : 0

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue // fully transparent — nothing to recolour
    let r = data[i] / 255
    let g = data[i + 1] / 255
    let b = data[i + 2] / 255

    // 1. brightness
    if (a.brightness !== 1) { r *= a.brightness; g *= a.brightness; b *= a.brightness }
    // 2. contrast
    if (a.contrast !== 1) {
      r = (r - 0.5) * a.contrast + 0.5
      g = (g - 0.5) * a.contrast + 0.5
      b = (b - 0.5) * a.contrast + 0.5
    }
    // clamp before HSL so out-of-range values don't distort hue
    r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1)
    // 3. hue + saturation
    if (a.hue !== 0 || a.saturation !== 1) {
      let [h, s, l] = rgbToHsl(r, g, b)
      h = (h + hueShift) % 1
      if (h < 0) h += 1
      s = clamp(s * a.saturation, 0, 1)
      ;[r, g, b] = hslToRgb(h, s, l)
    }
    // 4. tint
    if (tintRgb) {
      const k = a.tintStrength
      r = r * (1 - k) + tr * k
      g = g * (1 - k) + tg * k
      b = b * (1 - k) + tb * k
    }

    data[i] = Math.round(clamp(r, 0, 1) * 255)
    data[i + 1] = Math.round(clamp(g, 0, 1) * 255)
    data[i + 2] = Math.round(clamp(b, 0, 1) * 255)
  }
}

/** Non-mutating bake: returns a new RGBAImage with adjustments applied. */
export function bakeAdjustments(img: RGBAImage, adj?: Partial<Adjustments> | null): RGBAImage {
  const data = new Uint8ClampedArray(img.data)
  applyAdjustmentsToPixels(data, adj)
  return { data, width: img.width, height: img.height }
}

/**
 * Best-effort CSS `filter` string approximating the adjustments — handy for cheap
 * thumbnail previews. NOTE: CSS hue-rotate/saturate are not a byte-exact match for
 * the pixel pipeline above; the canvas bake is the source of truth. Tint is not
 * representable as a single CSS filter and is omitted here.
 */
export function cssFilter(adj?: Partial<Adjustments> | null): string {
  const a = normalizeAdjustments(adj)
  const parts: string[] = []
  if (a.brightness !== 1) parts.push(`brightness(${a.brightness})`)
  if (a.contrast !== 1) parts.push(`contrast(${a.contrast})`)
  if (a.saturation !== 1) parts.push(`saturate(${a.saturation})`)
  if (a.hue !== 0) parts.push(`hue-rotate(${a.hue}deg)`)
  return parts.join(' ') || 'none'
}
