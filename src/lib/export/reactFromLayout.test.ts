import { describe, it, expect } from 'vitest'
import { generateReactComponent, type GenScene } from './reactFromLayout'

const scene: GenScene = {
  width: 1200,
  height: 800,
  backgroundFile: 'background/background_filled.png',
  elements: [
    { id: 'knob_1', type: 'knob', rect: [100, 120, 64, 64], assetFile: 'assets/knob_1.png', label: 'Cutoff' },
    { id: 'slider_2', type: 'slider', rect: [300, 200, 40, 180], angle: 15, assetFile: 'assets/slider_2.png' },
  ],
}

describe('generateReactComponent', () => {
  const out = generateReactComponent(scene)

  it('emits a default-exported React component', () => {
    expect(out).toContain("import React from 'react'")
    expect(out).toContain('export function Panel(')
    expect(out).toContain('export default Panel')
  })

  it('bakes natural dimensions', () => {
    expect(out).toContain('const NATURAL_WIDTH = 1200')
    expect(out).toContain('const NATURAL_HEIGHT = 800')
  })

  it('renders the background plate', () => {
    expect(out).toContain('${assetBase}background/background_filled.png')
  })

  it('places each element at its exact rect', () => {
    expect(out).toContain('${assetBase}assets/knob_1.png')
    expect(out).toContain('left: 100')
    expect(out).toContain('top: 120')
    expect(out).toContain('width: 64')
    expect(out).toContain('data-type="knob"')
    expect(out).toContain('alt="Cutoff"')
  })

  it('emits rotation only when angled', () => {
    expect(out).toContain("transform: 'rotate(15deg)'")
    // knob_1 has no angle -> its block should not carry a rotate
    const knobBlock = out.slice(out.indexOf('knob_1.png'), out.indexOf('slider_2.png'))
    expect(knobBlock).not.toContain('rotate(')
  })

  it('falls back to type for alt when no label', () => {
    expect(out).toContain('alt="slider"')
  })

  it('is deterministic', () => {
    expect(generateReactComponent(scene)).toBe(out)
  })

  it('works with no background and no elements', () => {
    const empty = generateReactComponent({ width: 10, height: 10, elements: [] })
    expect(empty).toContain('const NATURAL_WIDTH = 10')
    // no element <img> src should be emitted (the only 'assets/' is the prop doc)
    expect(empty).not.toContain('${assetBase}assets/')
    expect(empty).not.toContain('<img')
  })

  it('sanitises component name and escapes alt text', () => {
    const s = generateReactComponent({
      width: 4, height: 4, elements: [
        { id: 'x"1', type: 't', rect: [0, 0, 1, 1], assetFile: 'assets/a.png', label: 'A & "B"' },
      ], componentName: '9 Weird-Name!',
    })
    // invalid identifier -> falls back to Panel
    expect(s).toContain('export function Panel(')
    expect(s).toContain('&amp;')
    expect(s).toContain('&quot;')
  })
})
