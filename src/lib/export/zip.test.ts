import { describe, it, expect } from 'vitest'
import { crc32, createZip, strToU8, u8ToBase64, base64ToU8, type ZipEntry } from './zip'

describe('crc32', () => {
  it('matches known vectors', () => {
    expect(crc32(strToU8(''))).toBe(0)
    expect(crc32(strToU8('123456789')) >>> 0).toBe(0xcbf43926)
    expect(crc32(strToU8('The quick brown fox jumps over the lazy dog')) >>> 0).toBe(0x414fa339)
  })
})

describe('base64 round-trip', () => {
  it('encodes and decodes bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67])
    expect(Array.from(base64ToU8(u8ToBase64(bytes)))).toEqual(Array.from(bytes))
  })
  it('handles a longer buffer', () => {
    const bytes = new Uint8Array(5000).map((_, i) => i % 256)
    expect(Array.from(base64ToU8(u8ToBase64(bytes)))).toEqual(Array.from(bytes))
  })
})

describe('createZip', () => {
  const entries: ZipEntry[] = [
    { name: 'hello.txt', data: strToU8('hello world') },
    { name: 'assets/a.bin', data: new Uint8Array([1, 2, 3, 4, 5]) },
  ]
  const zip = createZip(entries)

  it('starts with a local file header signature', () => {
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it('ends with an EOCD record', () => {
    // EOCD is the last 22 bytes (no comment)
    const eocd = zip.slice(zip.length - 22)
    expect(Array.from(eocd.slice(0, 4))).toEqual([0x50, 0x4b, 0x05, 0x06])
    // total entries field (offset 10..12) == 2
    expect(eocd[10] | (eocd[11] << 8)).toBe(2)
  })

  it('embeds the stored file bytes verbatim (no compression)', () => {
    // "hello world" appears as raw bytes right after the first header+name
    const text = new TextDecoder().decode(zip)
    expect(text).toContain('hello world')
    expect(text).toContain('hello.txt')
    expect(text).toContain('assets/a.bin')
  })

  it('is deterministic', () => {
    expect(Array.from(createZip(entries))).toEqual(Array.from(zip))
  })

  it('produces a central directory entry per file', () => {
    // central dir signature 0x02014b50 appears twice
    let count = 0
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) count++
    }
    expect(count).toBe(2)
  })
})
