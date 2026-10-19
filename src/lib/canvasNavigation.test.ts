import { describe, expect, it } from 'vitest'
import { getWheelNavigation } from './canvasNavigation'

describe('canvasNavigation wheel behavior', () => {
  it('uses smaller zoom steps for ctrl+wheel line deltas', () => {
    const result = getWheelNavigation({
      event: {
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaX: 0,
        deltaY: 3,
      },
      pointer: { x: 300, y: 200 },
      zoom: 1,
      panX: 0,
      panY: 0,
      minZoom: 0.1,
      maxZoom: 8,
      viewportWidth: 1200,
      viewportHeight: 800,
    })

    expect(result.mode).toBe('zoom')
    expect(result.zoom).toBeGreaterThan(0.89)
    expect(result.zoom).toBeLessThan(0.91)
  })

  it('caps wheel panning so a single event does not jump too far', () => {
    const result = getWheelNavigation({
      event: {
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 0,
        deltaY: 120,
      },
      pointer: { x: 300, y: 200 },
      zoom: 1,
      panX: 10,
      panY: 15,
      minZoom: 0.1,
      maxZoom: 8,
      viewportWidth: 1200,
      viewportHeight: 800,
    })

    expect(result.mode).toBe('pan')
    expect(result.panY).toBe(-33)
  })

  it('treats shift+wheel as horizontal panning with the same damping', () => {
    const result = getWheelNavigation({
      event: {
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaX: 0,
        deltaY: 3,
      },
      pointer: { x: 300, y: 200 },
      zoom: 1,
      panX: 0,
      panY: 0,
      minZoom: 0.1,
      maxZoom: 8,
      viewportWidth: 1200,
      viewportHeight: 800,
    })

    expect(result.panX).toBe(-22.5)
    expect(result.panY).toBe(0)
  })
})