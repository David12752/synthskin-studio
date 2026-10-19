/**
 * Minimal ZIP writer for .synthpack export.
 * Writes uncompressed (STORE) ZIP archives so Electron can install packs without extra dependencies.
 */

export interface ZipEntryInput {
  path: string
  data: string | Uint8Array
}

const encoder = new TextEncoder()

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('../') || normalized === '..') {
    throw new Error(`Unsafe ZIP path: ${path}`)
  }
  return normalized
}

function dateToDosParts(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2)
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate()
  return { time: dosTime, date: dosDate }
}

function concat(parts: Uint8Array[], totalSize: number): Uint8Array {
  const out = new Uint8Array(totalSize)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true)
}

export function createZipBlob(entries: ZipEntryInput[], fileName = 'pack.synthpack'): Blob {
  const now = new Date()
  const dos = dateToDosParts(now)
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = normalizePath(entry.path)
    const nameBytes = encoder.encode(name)
    const data = toBytes(entry.data)
    const crc = crc32(data)

    if (data.length > 0xffffffff || nameBytes.length > 0xffff) {
      throw new Error(`ZIP entry too large: ${name}`)
    }

    const localHeader = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(localHeader.buffer)
    writeU32(localView, 0, 0x04034b50)
    writeU16(localView, 4, 20) // version needed
    writeU16(localView, 6, 0)  // flags
    writeU16(localView, 8, 0)  // STORE, no compression
    writeU16(localView, 10, dos.time)
    writeU16(localView, 12, dos.date)
    writeU32(localView, 14, crc)
    writeU32(localView, 18, data.length)
    writeU32(localView, 22, data.length)
    writeU16(localView, 26, nameBytes.length)
    writeU16(localView, 28, 0)
    localHeader.set(nameBytes, 30)

    localParts.push(localHeader, data)

    const centralHeader = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(centralHeader.buffer)
    writeU32(centralView, 0, 0x02014b50)
    writeU16(centralView, 4, 20) // version made by
    writeU16(centralView, 6, 20) // version needed
    writeU16(centralView, 8, 0)
    writeU16(centralView, 10, 0)
    writeU16(centralView, 12, dos.time)
    writeU16(centralView, 14, dos.date)
    writeU32(centralView, 16, crc)
    writeU32(centralView, 20, data.length)
    writeU32(centralView, 24, data.length)
    writeU16(centralView, 28, nameBytes.length)
    writeU16(centralView, 30, 0)
    writeU16(centralView, 32, 0)
    writeU16(centralView, 34, 0)
    writeU16(centralView, 36, 0)
    writeU32(centralView, 38, 0)
    writeU32(centralView, 42, offset)
    centralHeader.set(nameBytes, 46)
    centralParts.push(centralHeader)

    offset += localHeader.length + data.length
  }

  const centralOffset = offset
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  writeU32(eocdView, 0, 0x06054b50)
  writeU16(eocdView, 4, 0)
  writeU16(eocdView, 6, 0)
  writeU16(eocdView, 8, entries.length)
  writeU16(eocdView, 10, entries.length)
  writeU32(eocdView, 12, centralSize)
  writeU32(eocdView, 16, centralOffset)
  writeU16(eocdView, 20, 0)

  const totalSize = offset + centralSize + eocd.length
  const zip = concat([...localParts, ...centralParts, eocd], totalSize)
  const arrayBuffer = new ArrayBuffer(zip.byteLength)
  new Uint8Array(arrayBuffer).set(zip)
  return new File([arrayBuffer], fileName, { type: 'application/zip' })
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return encoder.encode(dataUrl)
  const meta = dataUrl.slice(0, comma).toLowerCase()
  const body = dataUrl.slice(comma + 1)
  if (!meta.includes(';base64')) return encoder.encode(decodeURIComponent(body))
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
