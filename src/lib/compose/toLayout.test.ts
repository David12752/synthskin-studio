import { describe, it, expect } from 'vitest'
import { placedToLayoutElement, placedToLayoutElements } from './toLayout'
import type { PlacedElement } from '../../stores/compositionStore'

const el = (id: string, z: number, x = 10.4, y = 20.6): PlacedElement => ({
  id, name: id, dataUrl: `data:,${id}`, x, y, width: 30.2, height: 40.8,
  rotation: 15, z, type: 'knob', provenance: 'user', source: 'placed',
})

describe('placedToLayoutElement', () => {
  it('rounds rect, carries angle/z/provenance/source/dataUrl', () => {
    const out = placedToLayoutElement(el('a', 2))
    expect(out.rect).toEqual([10, 21, 30, 41])
    expect(out.angle).toBe(15)
    expect(out.provenance).toBe('user')
    expect(out.source).toBe('placed')
    expect(out.dataUrl).toBe('data:,a')
    expect(out.type).toBe('knob')
  })
})

describe('placedToLayoutElements', () => {
  it('sorts by z ascending (draw order)', () => {
    const out = placedToLayoutElements([el('top', 5), el('bottom', 1), el('mid', 3)])
    expect(out.map((o) => o.id)).toEqual(['bottom', 'mid', 'top'])
  })
})
