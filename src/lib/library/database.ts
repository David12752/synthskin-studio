// ─── Component Library Database ─────────────────────────────────────
// JSON-based persistence layer for the component library.
// Stores data at {appData}/synthskin-studio/component-library.json
// Uses Electron IPC (window.synthskin) for file read/write.

import type { LibraryComponent, LibraryFilter, LibraryFile } from './types'
import { LIBRARY_VERSION } from './types'

const LIBRARY_FILENAME = 'component-library.json'

// ── Path helper ────────────────────────────────────────────────────

async function getLibraryPath(): Promise<string> {
  const appData = await window.synthskin.getAppDataPath()
  return `${appData}/synthskin-studio/${LIBRARY_FILENAME}`
}

// ── Read / Write ───────────────────────────────────────────────────

export async function loadLibrary(): Promise<LibraryComponent[]> {
  try {
    const filePath = await getLibraryPath()
    const result = await window.synthskin.readFile(filePath)
    if (!result.success || !result.data) return []
    const parsed = JSON.parse(result.data) as LibraryFile
    return parsed.components || []
  } catch {
    return []
  }
}

async function saveLibrary(components: LibraryComponent[]): Promise<void> {
  const filePath = await getLibraryPath()
  const file: LibraryFile = {
    version: LIBRARY_VERSION,
    components,
    exportedAt: new Date().toISOString(),
  }
  await window.synthskin.writeFile(filePath, JSON.stringify(file, null, 2), 'utf8')
}

// ── CRUD Operations ────────────────────────────────────────────────

export async function addComponent(component: LibraryComponent): Promise<LibraryComponent[]> {
  const components = await loadLibrary()
  components.unshift(component)
  await saveLibrary(components)
  return components
}

export async function updateComponent(
  id: string,
  updates: Partial<Pick<LibraryComponent, 'name' | 'tags' | 'favorite' | 'params' | 'thumbnail'>>
): Promise<LibraryComponent[]> {
  const components = await loadLibrary()
  const idx = components.findIndex((c) => c.id === id)
  if (idx === -1) return components
  components[idx] = {
    ...components[idx],
    ...updates,
    updatedAt: new Date().toISOString(),
  }
  await saveLibrary(components)
  return components
}

export async function deleteComponent(id: string): Promise<LibraryComponent[]> {
  const components = await loadLibrary()
  const filtered = components.filter((c) => c.id !== id)
  await saveLibrary(filtered)
  return filtered
}

export async function toggleFavorite(id: string): Promise<LibraryComponent[]> {
  const components = await loadLibrary()
  const idx = components.findIndex((c) => c.id === id)
  if (idx === -1) return components
  components[idx].favorite = !components[idx].favorite
  components[idx].updatedAt = new Date().toISOString()
  await saveLibrary(components)
  return components
}

// ── Filtering (in-memory) ──────────────────────────────────────────

export function filterComponents(
  components: LibraryComponent[],
  filter: LibraryFilter
): LibraryComponent[] {
  let result = components

  if (filter.type) {
    result = result.filter((c) => c.type === filter.type)
  }

  if (filter.favoritesOnly) {
    result = result.filter((c) => c.favorite)
  }

  if (filter.tags && filter.tags.length > 0) {
    const filterTags = filter.tags.map((t) => t.toLowerCase())
    result = result.filter((c) =>
      filterTags.some((ft) => c.tags.some((ct) => ct.toLowerCase().includes(ft)))
    )
  }

  if (filter.search) {
    const q = filter.search.toLowerCase()
    result = result.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.type.includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
    )
  }

  return result
}

// ── Export / Import ────────────────────────────────────────────────

export async function exportLibrary(
  components: LibraryComponent[]
): Promise<void> {
  const { canceled, filePath } = await window.synthskin.showSaveDialog({
    title: 'Export Component Library',
    defaultPath: 'my-library.synthskin-lib',
    buttonLabel: 'Export',
    filters: [{ name: 'SynthSkin Library', extensions: ['synthskin-lib'] }],
  })
  if (canceled || !filePath) return

  const file: LibraryFile = {
    version: LIBRARY_VERSION,
    components,
    exportedAt: new Date().toISOString(),
  }
  await window.synthskin.writeFile(filePath, JSON.stringify(file, null, 2), 'utf8')
}

export async function importLibrary(): Promise<LibraryComponent[] | null> {
  const { canceled, filePath } = await window.synthskin.showOpenDialog({
    title: 'Import Component Library',
    buttonLabel: 'Import',
    filters: [{ name: 'SynthSkin Library', extensions: ['synthskin-lib'] }],
  })
  if (canceled || !filePath) return null

  const result = await window.synthskin.readFile(filePath)
  if (!result.success || !result.data) return null

  try {
    const imported = JSON.parse(result.data) as LibraryFile
    if (!imported.components || !Array.isArray(imported.components)) return null

    // Merge: add imported components that don't already exist (by id)
    const existing = await loadLibrary()
    const existingIds = new Set(existing.map((c) => c.id))
    const newComponents = imported.components.filter((c) => !existingIds.has(c.id))
    const merged = [...newComponents, ...existing]
    await saveLibrary(merged)
    return merged
  } catch {
    return null
  }
}
