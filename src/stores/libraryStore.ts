// ─── Library Store ──────────────────────────────────────────────────
// Zustand store for the Component Library UI state.

import { create } from 'zustand'
import type { LibraryComponent, ComponentType, LibraryFilter } from '../lib/library/types'
import {
  loadLibrary,
  addComponent,
  updateComponent,
  deleteComponent,
  toggleFavorite,
  filterComponents,
  exportLibrary,
  importLibrary,
} from '../lib/library/database'

interface LibraryState {
  // Data
  components: LibraryComponent[]
  filtered: LibraryComponent[]
  loaded: boolean

  // Filter state
  filter: LibraryFilter

  // UI state
  isOpen: boolean

  // Actions
  openLibrary: () => void
  closeLibrary: () => void
  load: () => Promise<void>
  setFilter: (filter: Partial<LibraryFilter>) => void
  clearFilter: () => void

  // CRUD
  saveComponent: (component: LibraryComponent) => Promise<void>
  renameComponent: (id: string, name: string) => Promise<void>
  tagComponent: (id: string, tags: string[]) => Promise<void>
  removeComponent: (id: string) => Promise<void>
  toggleFavorite: (id: string) => Promise<void>

  // Export / Import
  exportAll: () => Promise<void>
  exportFiltered: () => Promise<void>
  importFromFile: () => Promise<void>
}

function applyFilter(components: LibraryComponent[], filter: LibraryFilter): LibraryComponent[] {
  return filterComponents(components, filter)
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  components: [],
  filtered: [],
  loaded: false,
  filter: {},
  isOpen: false,

  openLibrary: () => set({ isOpen: true }),
  closeLibrary: () => set({ isOpen: false }),

  load: async () => {
    const components = await loadLibrary()
    const { filter } = get()
    set({ components, filtered: applyFilter(components, filter), loaded: true })
  },

  setFilter: (partial) => {
    const filter = { ...get().filter, ...partial }
    const { components } = get()
    set({ filter, filtered: applyFilter(components, filter) })
  },

  clearFilter: () => {
    const { components } = get()
    set({ filter: {}, filtered: components })
  },

  saveComponent: async (component) => {
    const components = await addComponent(component)
    const { filter } = get()
    set({ components, filtered: applyFilter(components, filter) })
  },

  renameComponent: async (id, name) => {
    const components = await updateComponent(id, { name })
    const { filter } = get()
    set({ components, filtered: applyFilter(components, filter) })
  },

  tagComponent: async (id, tags) => {
    const components = await updateComponent(id, { tags })
    const { filter } = get()
    set({ components, filtered: applyFilter(components, filter) })
  },

  removeComponent: async (id) => {
    const components = await deleteComponent(id)
    const { filter } = get()
    set({ components, filtered: applyFilter(components, filter) })
  },

  toggleFavorite: async (id) => {
    const components = await toggleFavorite(id)
    const { filter } = get()
    set({ components, filtered: applyFilter(components, filter) })
  },

  exportAll: async () => {
    await exportLibrary(get().components)
  },

  exportFiltered: async () => {
    await exportLibrary(get().filtered)
  },

  importFromFile: async () => {
    const merged = await importLibrary()
    if (merged) {
      const { filter } = get()
      set({ components: merged, filtered: applyFilter(merged, filter) })
    }
  },
}))
