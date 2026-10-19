/**
 * zipProject.ts — .synthskin v2, a ZIP container instead of one giant JSON.
 *
 * v1 serialized the whole project (source images + every asset mask) as base64
 * data-URLs inside one JSON string. That balloons ~33%, forces a full re-parse
 * of megabytes of pixels on every open, and can't grow to per-asset masks +
 * vectors + multi-image projects. v2 externalizes the pixels into ZIP entries
 * (images/, masks/) with a small project.json manifest referencing them — like
 * .ora. Backward compatible: `deserializeAnyProject` loads both.
 *
 * Uses the existing STORE-zip writer; adds a matching STORE-zip reader (no
 * inflate needed since every entry is stored uncompressed).
 */
import { createZipBlob, dataUrlToBytes, type ZipEntryInput } from '../zip'
import type { SynthSkinFile } from './serialization'
import { deserializeProject } from './serialization'
import type { Asset } from '../../types'

export const ZIP_PROJECT_VERSION = '2.0.0'
const MANIFEST_PATH = 'project.json'

interface AssetRef extends Omit<Asset, 'maskDataUrl'> {
  maskFile?: string
  maskMime?: string
  maskDataUrl?: string // kept optional for tolerance; normally externalized
}

interface ImageRef {
  id: string
  path: string
  width: number
  height: number
  file: string
  mime: string
}

interface ZipManifest {
  version: string
  name: string
  createdAt: string
  updatedAt: string
  images: ImageRef[]
  assets: AssetRef[]
  panelLayout?: SynthSkinFile['panelLayout']
}

// ── data-URL <-> bytes helpers ────────────────────────────────────────────────

function mimeOf(dataUrl: string): string {
  const m = /^data:([^;,]+)[;,]/.exec(dataUrl)
  return m ? m[1] : 'image/png'
}

function extForMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('bmp')) return 'bmp'
  return 'png'
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// ── PACK ──────────────────────────────────────────────────────────────────────

/** Build the ZIP entries for a project (manifest + externalized pixels). */
export function buildProjectZipEntries(file: SynthSkinFile): ZipEntryInput[] {
  const entries: ZipEntryInput[] = []

  const images: ImageRef[] = file.sourceImages.map((img) => {
    const mime = mimeOf(img.dataUrl)
    const path = `images/${img.id}.${extForMime(mime)}`
    entries.push({ path, data: dataUrlToBytes(img.dataUrl) })
    return { id: img.id, path: img.path, width: img.width, height: img.height, file: path, mime }
  })

  const assets: AssetRef[] = file.assets.map((asset) => {
    const { maskDataUrl, ...rest } = asset
    if (maskDataUrl) {
      const mime = mimeOf(maskDataUrl)
      const path = `masks/${asset.id}.${extForMime(mime)}`
      entries.push({ path, data: dataUrlToBytes(maskDataUrl) })
      return { ...rest, maskFile: path, maskMime: mime }
    }
    return { ...rest }
  })

  const manifest: ZipManifest = {
    version: ZIP_PROJECT_VERSION,
    name: file.name,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    images,
    assets,
    panelLayout: file.panelLayout ?? null,
  }
  entries.unshift({ path: MANIFEST_PATH, data: JSON.stringify(manifest) })
  return entries
}

/** Pack a project into a .synthskin (zip) Blob. */
export function packProjectZip(file: SynthSkinFile, fileName = 'project.synthskin'): Blob {
  return createZipBlob(buildProjectZipEntries(file), fileName)
}

/** Pack a project to a base64 string (for the Electron write-file base64 path). */
export async function packProjectBase64(file: SynthSkinFile): Promise<string> {
  const bytes = new Uint8Array(await packProjectZip(file).arrayBuffer())
  return bytesToBase64(bytes)
}

/** Decode a plain base64 string to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ── STORE-zip reader ──────────────────────────────────────────────────────────

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50

export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** Read a STORE (uncompressed) ZIP into a path → bytes map. */
export function readStoreZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dec = new TextDecoder()

  // Locate End Of Central Directory (scan backwards; no zip comment expected).
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no EOCD)')

  const count = view.getUint16(eocd + 10, true)
  let ptr = view.getUint32(eocd + 16, true) // central directory offset
  const out = new Map<string, Uint8Array>()

  for (let n = 0; n < count; n++) {
    if (view.getUint32(ptr, true) !== SIG_CENTRAL) break
    const method = view.getUint16(ptr + 10, true)
    const size = view.getUint32(ptr + 24, true)
    const nameLen = view.getUint16(ptr + 28, true)
    const extraLen = view.getUint16(ptr + 30, true)
    const commentLen = view.getUint16(ptr + 32, true)
    const localOffset = view.getUint32(ptr + 42, true)
    const name = dec.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen))

    if (method !== 0) throw new Error(`ZIP entry '${name}' is compressed; only STORE is supported`)

    // Local header: name len at +26, extra len at +28.
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    out.set(name, bytes.subarray(dataStart, dataStart + size))

    ptr += 46 + nameLen + extraLen + commentLen
  }
  return out
}

// ── UNPACK ──────────────────────────────────────────────────────────────────

/** Reconstruct a SynthSkinFile from a v2 zip's bytes. */
export function unpackProjectZip(bytes: Uint8Array): SynthSkinFile {
  const files = readStoreZip(bytes)
  const manifestBytes = files.get(MANIFEST_PATH)
  if (!manifestBytes) throw new Error('Invalid .synthskin: missing project.json')
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ZipManifest

  const toDataUrl = (path: string, mime: string): string => {
    const data = files.get(path)
    if (!data) throw new Error(`Invalid .synthskin: missing entry '${path}'`)
    return `data:${mime};base64,${bytesToBase64(data)}`
  }

  const sourceImages = manifest.images.map((img) => ({
    id: img.id,
    path: img.path,
    width: img.width,
    height: img.height,
    dataUrl: toDataUrl(img.file, img.mime),
  }))

  const assets: Asset[] = manifest.assets.map((a) => {
    const { maskFile, maskMime, maskDataUrl, ...rest } = a
    const mask = maskFile ? toDataUrl(maskFile, maskMime ?? 'image/png') : (maskDataUrl ?? '')
    return { ...(rest as Omit<Asset, 'maskDataUrl'>), maskDataUrl: mask }
  })

  return {
    version: manifest.version,
    name: manifest.name,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    sourceImages,
    assets,
    panelLayout: manifest.panelLayout ?? null,
  }
}

/** Load a project from either a v2 zip (bytes) or a v1 JSON string. */
export function deserializeAnyProject(data: Uint8Array | string): SynthSkinFile {
  if (typeof data === 'string') return deserializeProject(data)
  if (isZipBytes(data)) return unpackProjectZip(data)
  // Not a zip → assume UTF-8 JSON bytes (v1 written as bytes).
  return deserializeProject(new TextDecoder().decode(data))
}
