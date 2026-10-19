import { describe, it, expect } from 'vitest'
import { nextZ, bringForward, sendBackward, boundsOf, snapPosition } from './transform'

describe('nextZ', () => {
  it('is 0 for empty', () => expect(nextZ([])).toBe(0))
  it('is max+1', () => expect(nextZ([{ z: 0 }, { z: 3 }, { z: 1 }])).toBe(4))
})

describe('z-order', () => {
  const els = [{ id: 'a', z: 0 }, { id: 'b', z: 1 }, { id: 'c', z: 2 }]
  it('bringForward swaps with the one above', () => {
    const out = bringForward(els, 'a')
    expect(out.find((e) => e.id === 'a')!.z).toBe(1)
    expect(out.find((e) => e.id === 'b')!.z).toBe(0)
  })
  it('bringForward on top is a no-op', () => {
    expect(bringForward(els, 'c')).toBe(els)
  })
  it('sendBackward swaps with the one below', () => {
    const out = sendBackward(els, 'c')
    expect(out.find((e) => e.id === 'c')!.z).toBe(1)
    expect(out.find((e) => e.id === 'b')!.z).toBe(2)
  })
  it('sendBackward at bottom is a no-op', () => {
    expect(sendBackward(els, 'a')).toBe(els)
  })
})

describe('boundsOf', () => {
  it('no rotation -> same box', () => {
    expect(boundsOf({ x: 10, y: 20, width: 30, height: 40 }))
      .toEqual({ x: 10, y: 20, width: 30, height: 40 })
  })
  it('90deg swaps w/h about centre', () => {
    const b = boundsOf({ x: 0, y: 0, width: 10, height: 20, rotation: 90 })
    expect(Math.round(b.width)).toBe(20)
    expect(Math.round(b.height)).toBe(10)
    // centre preserved at (5,10)
    expect(Math.round(b.x + b.width / 2)).toBe(5)
    expect(Math.round(b.y + b.height / 2)).toBe(10)
  })
})

describe('snapPosition', () => {
  const other = [{ x: 100, y: 100, width: 40, height: 40 }]
  it('snaps left edge to another left edge within tol', () => {
    const r = snapPosition({ x: 103, y: 300, width: 20, height: 20 }, other, null, 6)
    expect(r.snappedX).toBe(true)
    expect(r.x).toBe(100)
  })
  it('does not snap beyond tol', () => {
    // x=200 -> left 200 / centre 210 / right 220, all far from guides 100/120/140.
    const r = snapPosition({ x: 200, y: 300, width: 20, height: 20 }, other, null, 6)
    expect(r.snappedX).toBe(false)
    expect(r.x).toBe(200)
  })
  it('snaps centre to panel centre', () => {
    const panel = { x: 0, y: 0, width: 200, height: 200 }
    // moving 20-wide box whose centre would be at 101 -> snaps centre to 100
    const r = snapPosition({ x: 91, y: 0, width: 20, height: 20 }, [], panel, 6)
    expect(r.snappedX).toBe(true)
    expect(r.x + 10).toBe(100)
  })
})
