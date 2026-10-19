import { describe, it, expect, beforeEach } from 'vitest'
import { useCompositionStore } from './compositionStore'

const seed = (name: string) => ({
  name, dataUrl: 'data:image/png;base64,AAAA', x: 10, y: 20, width: 40, height: 30,
})

describe('compositionStore', () => {
  beforeEach(() => useCompositionStore.setState({ elements: [], selectedId: null }))

  it('places an element with defaults + increasing z, selects it', () => {
    const a = useCompositionStore.getState().place(seed('a'))
    const b = useCompositionStore.getState().place(seed('b'))
    expect(a.provenance).toBe('user')
    expect(a.source).toBe('placed')
    expect(a.type).toBe('decoration')
    expect(b.z).toBeGreaterThan(a.z)
    expect(useCompositionStore.getState().selectedId).toBe(b.id)
  })

  it('updates a transform', () => {
    const a = useCompositionStore.getState().place(seed('a'))
    useCompositionStore.getState().update(a.id, { x: 99, rotation: 45 })
    const el = useCompositionStore.getState().elements[0]
    expect(el.x).toBe(99)
    expect(el.rotation).toBe(45)
    expect(el.id).toBe(a.id) // id preserved
  })

  it('bring forward / send backward reorders z', () => {
    const a = useCompositionStore.getState().place(seed('a'))
    const b = useCompositionStore.getState().place(seed('b'))
    useCompositionStore.getState().bringForward(a.id)
    const st = useCompositionStore.getState()
    const za = st.elements.find((e) => e.id === a.id)!.z
    const zb = st.elements.find((e) => e.id === b.id)!.z
    expect(za).toBeGreaterThan(zb)
  })

  it('removes and clears selection', () => {
    const a = useCompositionStore.getState().place(seed('a'))
    useCompositionStore.getState().remove(a.id)
    expect(useCompositionStore.getState().elements).toHaveLength(0)
    expect(useCompositionStore.getState().selectedId).toBeNull()
  })

  it('clears all', () => {
    useCompositionStore.getState().place(seed('a'))
    useCompositionStore.getState().place(seed('b'))
    useCompositionStore.getState().clear()
    expect(useCompositionStore.getState().elements).toHaveLength(0)
  })
})
