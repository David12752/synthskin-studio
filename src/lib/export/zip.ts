/**
 * zip.ts — a tiny, dependency-free ZIP writer (STORE / no compression).
 *
 * The handoff bundle (Phase 5) ships as a single `synthskin-handoff.zip`. Rather
 * than add a zip dependency, we emit a spec-correct stored archive by hand: local
 * file headers + a central directory + EOCD. STORE keeps the code small and the
 * output byte-deterministic (no zlib), which is fine — PNGs are already
 * compressed. Pure & node-testable.
 *
 * Ref: PKZIP APPNOTE (local header 0x04034b50, central 0x02014b50, EOCD 0x06054b50).
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive, e.g. 'assets/knob_1.png'. */
  name: string
  data: Uint8Array
}

// ── CRC-32 (IEEE 802.3) ─────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ── LE byte helpers ─────────────────────────────────────────────────────────────

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff]
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

export function strToU8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function u8ToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'undefined') {
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(bin)
  }
  // Node fallback (tests run without a DOM sometimes)
  return (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } })
    .Buffer!.from(bytes).toString('base64')
}

export function base64ToU8(b64: string): Uint8Array {
  if (typeof atob !== 'undefined') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer!
  return new Uint8Array(B.from(b64, 'base64'))
}

/** Build a STORE-method ZIP archive from the given entries. */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const chunks: number[][] = []
  const central: number[][] = []
  let offset = 0

  const GP_UTF8 = 0x0800 // filename is UTF-8

  for (const entry of entries) {
    const nameBytes = strToU8(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    // Local file header
    const local = [
      ...u32(0x04034b50),
      ...u16(20),          // version needed
      ...u16(GP_UTF8),     // general purpose flag
      ...u16(0),           // method = store
      ...u16(0),           // mod time
      ...u16(0),           // mod date
      ...u32(crc),
      ...u32(size),        // compressed size
      ...u32(size),        // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0),           // extra length
      ...nameBytes,
    ]
    chunks.push(local)
    chunks.push(Array.from(entry.data))

    // Central directory header (deferred)
    central.push([
      ...u32(0x02014b50),
      ...u16(20),          // version made by
      ...u16(20),          // version needed
      ...u16(GP_UTF8),
      ...u16(0),           // method
      ...u16(0),           // mod time
      ...u16(0),           // mod date
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0),           // extra length
      ...u16(0),           // comment length
      ...u16(0),           // disk number start
      ...u16(0),           // internal attrs
      ...u32(0),           // external attrs
      ...u32(offset),      // relative offset of local header
      ...nameBytes,
    ])

    offset += local.length + size
  }

  const centralStart = offset
  let centralSize = 0
  for (const c of central) centralSize += c.length

  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),                 // disk number
    ...u16(0),                 // disk with central dir
    ...u16(entries.length),    // entries on this disk
    ...u16(entries.length),    // total entries
    ...u32(centralSize),
    ...u32(centralStart),
    ...u16(0),                 // comment length
  ]

  // Flatten everything
  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  const write = (arr: number[] | Uint8Array) => { out.set(arr, p); p += arr.length }
  for (const c of chunks) write(c)
  for (const c of central) write(c)
  write(eocd)
  return out
}
