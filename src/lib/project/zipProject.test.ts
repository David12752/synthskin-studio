import { describe, it, expect } from 'vitest'
import { buildProjectZipEntries, packProjectZip, readStoreZip, unpackProjectZip, isZipBytes, deserializeAnyProject } from './zipProject'
import { createZipBlob } from '../zip'
import type { SynthSkinFile } from './serialization'
import type { Asset } from '../../types'

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPG_TINY = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q=='

function asset(id: string, maskDataUrl: string): Asset {
  return {
    id,
    name: `asset ${id}`,
    type: 'knob',
    sourceImageId: 'img1',
    extractionMethod: 'sam',
    extractionParams: {},
    maskDataUrl,
    bounds: { x: 1, y: 2, width: 10, height: 20 },
    metadata: { createdAt: '2026-01-01', tags: ['a'] },
  }
}

function sampleProject(): SynthSkinFile {
  return {
    version: '1.0.0',
    name: 'Test Panel',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    sourceImages: [{ id: 'img1', path: 'panel.jpg', width: 640, height: 480, dataUrl: JPG_TINY }],
    assets: [asset('k1', PNG_1x1), asset('k2', PNG_1x1)],
    panelLayout: null,
  }
}

describe('zip project pack/unpack', () => {
  it('externalizes pixels: manifest has no data URLs, images+masks are separate entries', () => {
    const entries = buildProjectZipEntries(sampleProject())
    const manifest = JSON.parse(entries[0].data as string)
    expect(entries[0].path).toBe('project.json')
    // manifest should reference files, not inline data urls
    const manifestStr = entries[0].data as string
    expect(manifestStr).not.toContain('data:image')
    expect(manifest.images[0].file).toBe('images/img1.jpg')
    expect(manifest.assets[0].maskFile).toBe('masks/k1.png')
    const paths = entries.map((e) => e.path).sort()
    expect(paths).toContain('images/img1.jpg')
    expect(paths).toContain('masks/k1.png')
    expect(paths).toContain('masks/k2.png')
  })

  it('round-trips through a real zip blob (write + read)', async () => {
    const original = sampleProject()
    const blob = packProjectZip(original)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(isZipBytes(bytes)).toBe(true)

    const restored = unpackProjectZip(bytes)
    expect(restored.name).toBe(original.name)
    expect(restored.createdAt).toBe(original.createdAt)
    expect(restored.sourceImages).toHaveLength(1)
    expect(restored.sourceImages[0].dataUrl).toBe(JPG_TINY)
    expect(restored.assets).toHaveLength(2)
    expect(restored.assets[0].maskDataUrl).toBe(PNG_1x1)
    expect(restored.assets[0].bounds).toEqual(original.assets[0].bounds)
    expect(restored.assets[1].id).toBe('k2')
  })

  it('readStoreZip reconstructs exact bytes for each entry', async () => {
    const blob = createZipBlob([
      { path: 'a.txt', data: 'hello' },
      { path: 'b/bin', data: new Uint8Array([1, 2, 3, 255, 0]) },
    ])
    const files = readStoreZip(new Uint8Array(await blob.arrayBuffer()))
    expect(new TextDecoder().decode(files.get('a.txt')!)).toBe('hello')
    expect(Array.from(files.get('b/bin')!)).toEqual([1, 2, 3, 255, 0])
  })

  it('deserializeAnyProject handles both v1 JSON string and v2 zip bytes', async () => {
    // v1 JSON
    const v1 = JSON.stringify(sampleProject())
    expect(deserializeAnyProject(v1).name).toBe('Test Panel')
    // v2 zip
    const bytes = new Uint8Array(await packProjectZip(sampleProject()).arrayBuffer())
    expect(deserializeAnyProject(bytes).name).toBe('Test Panel')
  })

  it('isZipBytes distinguishes zip from json bytes', () => {
    expect(isZipBytes(new TextEncoder().encode('{"version":"1.0.0"}'))).toBe(false)
    expect(isZipBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true)
  })
})
