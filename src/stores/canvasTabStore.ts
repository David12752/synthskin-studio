import { create } from 'zustand'

export interface CanvasTab {
  id: string
  label: string
  type: 'source' | 'asset'
  /** For 'source' tabs, the image dataUrl; for 'asset' tabs, the asset id */
  sourceId: string
  dataUrl: string
  width: number
  height: number
  zoom: number
  panX: number
  panY: number
}

interface CanvasTabState {
  tabs: CanvasTab[]
  activeTabId: string | null

  addTab: (tab: Omit<CanvasTab, 'zoom' | 'panX' | 'panY'>) => void
  removeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTabViewport: (id: string, zoom: number, panX: number, panY: number) => void
  renameTab: (id: string, label: string) => void
  hasTab: (id: string) => boolean
}

export const useCanvasTabStore = create<CanvasTabState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (tab) => {
    const existing = get().tabs.find(t => t.id === tab.id)
    if (existing) {
      // Just switch to existing tab
      set({ activeTabId: tab.id })
      return
    }
    const newTab: CanvasTab = {
      ...tab,
      zoom: 1,
      panX: 0,
      panY: 0,
    }
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: newTab.id,
    }))
  },

  removeTab: (id) => {
    set((s) => {
      const newTabs = s.tabs.filter(t => t.id !== id)
      let newActive = s.activeTabId
      if (s.activeTabId === id) {
        const idx = s.tabs.findIndex(t => t.id === id)
        newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null
      }
      return { tabs: newTabs, activeTabId: newActive }
    })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTabViewport: (id, zoom, panX, panY) => {
    set((s) => ({
      tabs: s.tabs.map(t => t.id === id ? { ...t, zoom, panX, panY } : t),
    }))
  },

  renameTab: (id, label) => {
    set((s) => ({
      tabs: s.tabs.map(t => t.id === id ? { ...t, label } : t),
    }))
  },

  hasTab: (id) => get().tabs.some(t => t.id === id),
}))
