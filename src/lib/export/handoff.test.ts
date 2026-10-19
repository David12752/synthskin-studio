import { describe, it, expect } from 'vitest'
import {
  dataUrlToBase64,
  mergePlacedIntoManifest,
  sceneFromManifest,
  buildHandoffReadme,
  assembleHandoffFiles,
  filesToZip,
} from './handoff'
import type { LayoutManifest } from '../api/pythonClient'
import type { ComposedLayoutElement } from '../compose/toLayout'

const manifest: LayoutManifest = {
  schema: 'synthskin.layout/v1',
  generator: 'test',
  created: '2026-07-05',
  source: { width: 1200, height: 800, rectified: false },
  asset_count: 1,
  assets: [
    {
      id: 'knob_1', type: 'knob', display_name: 'Cutoff', provenance: 'ai',
      rect: [100, 120, 64, 64], pivot: [132, 152], files: { original: 'assets/knob_1.png' },
    },
  ],
}

const placed: ComposedLayoutElement[] = [
  {
    id: 'pl_a', type: 'decoration', rect: [400, 300, 80, 40], angle: 10, z: 1,
    provenance: 'user', source: 'placed', dataUrl: 'data:image/png;base64,AAAA',
  },
  {
    id: 'pl_b', type: 'decoration', rect: [10, 10, 20, 20], angle: 0, z: 0,
    provenance: 'user', source: 'placed', dataUrl: 'data:image/png;base64,BBBB',
    adjustments: { hue: 30, saturation: 1, brightness: 1, contrast: 1, tint: null, tintStrength: 0 },
  },
]

describe('dataUrlToBase64', () => {
  it('strips the prefix', () => {
    expect(dataUrlToBase64('data:image/png;base64,ABCD')).toBe('ABCD')
    expect(dataUrlToBase64('ABCD')).toBe('ABCD') // already bare
  })
})

describe('mergePlacedIntoManifest', () => {
  const merged = mergePlacedIntoManifest(manifest, placed)
  it('appends placed assets after detected, in z-order', () => {
    expect(merged.assets.map((a) => a.id)).toEqual(['knob_1', 'pl_b', 'pl_a'])
  })
  it('tags provenance/source', () => {
    expect(merged.assets[0].source).toBe('detected')
    expect(merged.assets[1].source).toBe('placed')
    expect(merged.assets[1].provenance).toBe('user')
  })
  it('carries rotation and adjustments', () => {
    const a = merged.assets.find((x) => x.id === 'pl_a')!
    expect(a.rotation).toBe(10)
    const b = merged.assets.find((x) => x.id === 'pl_b')!
    expect(b.adjustments).toBeTruthy()
  })
  it('updates counts', () => {
    expect(merged.asset_count).toBe(3)
    expect(merged.placed_count).toBe(2)
  })
  it('does not mutate the source manifest', () => {
    expect(manifest.assets).toHaveLength(1)
  })
})

describe('sceneFromManifest', () => {
  it('maps assets to gen elements with rects + rotation', () => {
    const merged = mergePlacedIntoManifest(manifest, placed)
    const scene = sceneFromManifest(merged, { backgroundFile: 'background/background_filled.png' })
    expect(scene.width).toBe(1200)
    expect(scene.height).toBe(800)
    expect(scene.elements).toHaveLength(3)
    const knob = scene.elements.find((e) => e.id === 'knob_1')!
    expect(knob.rect).toEqual([100, 120, 64, 64])
    expect(knob.label).toBe('Cutoff')
    const a = scene.elements.find((e) => e.id === 'pl_a')!
    expect(a.angle).toBe(10)
    expect(a.assetFile).toBe('assets/pl_a.png')
  })
})

describe('buildHandoffReadme', () => {
  it('includes dimensions, usage and the coordinate contract', () => {
    const md = buildHandoffReadme({
      componentName: 'Panel', width: 1200, height: 800,
      assetCount: 3, placedCount: 2, hasBackground: true, hasPreview: true,
    })
    expect(md).toContain('1200 × 800')
    expect(md).toContain('layout.json')
    expect(md).toContain('preview.png')
    expect(md).toContain('3 elements')
    expect(md).toContain('2 user-composited')
  })
  it('omits preview row when absent', () => {
    const md = buildHandoffReadme({
      componentName: 'Panel', width: 10, height: 10,
      assetCount: 1, placedCount: 0, hasBackground: true, hasPreview: false,
    })
    expect(md).not.toContain('preview.png')
    expect(md).toContain('1 element')
  })
})

describe('assembleHandoffFiles + filesToZip', () => {
  const files = assembleHandoffFiles({
    layout: { hello: 'world' },
    panelTsx: 'export default function Panel(){return null}',
    readme: '# hi',
    assets: [
      { path: 'assets/pl_a.png', dataUrl: 'data:image/png;base64,AAAA' },
      { path: 'background/background_filled.png', dataUrl: 'data:image/png;base64,BBBB' },
    ],
  })

  it('always includes the three text files', () => {
    const paths = files.map((f) => f.path)
    expect(paths).toContain('layout.json')
    expect(paths).toContain('Panel.tsx')
    expect(paths).toContain('README_FOR_CLAUDE.md')
  })

  it('encodes binary assets as base64 (prefix stripped)', () => {
    const asset = files.find((f) => f.path === 'assets/pl_a.png')!
    expect(asset.encoding).toBe('base64')
    expect(asset.data).toBe('AAAA')
  })

  it('serialises layout.json as pretty JSON', () => {
    const layout = files.find((f) => f.path === 'layout.json')!
    expect(layout.data).toContain('"hello": "world"')
  })

  it('zips to a valid archive', () => {
    const zip = filesToZip(files)
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(zip.length).toBeGreaterThan(50)
  })
})
