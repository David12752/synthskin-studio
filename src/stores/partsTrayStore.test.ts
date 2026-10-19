import { describe, it, expect, beforeEach } from 'vitest'
import { usePartsTrayStore } from './partsTrayStore'

const seed = (name: string) => ({
  name,
  dataUrl: 'data:image/png;base64,AAAA',
  width: 10,
  height: 10,
  source: { kind: 'cut' as const, imageId: 'img1', bounds: { x: 0, y: 0, width: 10, height: 10 } },
})

describe('partsTrayStore', () => {
  beforeEach(() => usePartsTrayStore.setState({ parts: [], selectedPartId: null }))

  it('adds a part, assigns an id, and selects it', () => {
    const p = usePartsTrayStore.getState().addPart(seed('knob crop'))
    expect(p.id).toBeTruthy()
    expect(p.createdAt).toBeTruthy()
    const st = usePartsTrayStore.getState()
    expect(st.parts).toHaveLength(1)
    expect(st.selectedPartId).toBe(p.id)
  })

  it('assigns unique ids across parts', () => {
    const a = usePartsTrayStore.getState().addPart(seed('a'))
    const b = usePartsTrayStore.getState().addPart(seed('b'))
    expect(a.id).not.toBe(b.id)
    expect(usePartsTrayStore.getState().parts).toHaveLength(2)
  })

  it('removes a part and clears selection when it was selected', () => {
    const p = usePartsTrayStore.getState().addPart(seed('x'))
    usePartsTrayStore.getState().removePart(p.id)
    const st = usePartsTrayStore.getState()
    expect(st.parts).toHaveLength(0)
    expect(st.selectedPartId).toBeNull()
  })

  it('renames a part', () => {
    const p = usePartsTrayStore.getState().addPart(seed('old'))
    usePartsTrayStore.getState().renamePart(p.id, 'new')
    expect(usePartsTrayStore.getState().parts[0].name).toBe('new')
  })

  it('honours a caller-supplied id', () => {
    const p = usePartsTrayStore.getState().addPart({ ...seed('fixed'), id: 'fixed-id' })
    expect(p.id).toBe('fixed-id')
  })

  it('clears the whole tray', () => {
    usePartsTrayStore.getState().addPart(seed('a'))
    usePartsTrayStore.getState().addPart(seed('b'))
    usePartsTrayStore.getState().clear()
    const st = usePartsTrayStore.getState()
    expect(st.parts).toHaveLength(0)
    expect(st.selectedPartId).toBeNull()
  })
})
