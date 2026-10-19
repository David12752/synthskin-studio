// ─── Component Library Types ────────────────────────────────────────
// Unified type definitions for persisted foundry components.

export type ComponentType = 'knob' | 'slider' | 'indicator' | 'display'

export interface LibraryComponent {
  id: string
  type: ComponentType
  name: string
  /** Full parameter object (KnobParameters | SliderParameters | etc.) */
  params: Record<string, unknown>
  /** Base64-encoded PNG thumbnail */
  thumbnail: string
  /** User-assigned tags for filtering */
  tags: string[]
  /** Whether user marked as favorite */
  favorite: boolean
  /** ISO date string */
  createdAt: string
  /** ISO date string */
  updatedAt: string
}

export interface LibraryFilter {
  type?: ComponentType
  search?: string
  tags?: string[]
  favoritesOnly?: boolean
}

export interface LibraryFile {
  version: string
  components: LibraryComponent[]
  exportedAt: string
}

export const LIBRARY_VERSION = '1.0.0'
