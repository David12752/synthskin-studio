import { create } from 'zustand'

export type WorkspaceId = 'extract'

export interface PanelSizes {
  leftWidth: number
  rightWidth: number
  bottomHeight: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  bottomCollapsed: boolean
}

const DEFAULT_PANEL_SIZES: PanelSizes = {
  leftWidth: 280,
  rightWidth: 320,
  bottomHeight: 200,
  leftCollapsed: false,
  rightCollapsed: false,
  bottomCollapsed: true,
}

export const PANEL_CONSTRAINTS = {
  left: { min: 200, max: 500 },
  right: { min: 240, max: 600 },
  bottom: { min: 100, max: 500 },
} as const

export const WORKSPACE_LABELS: Record<WorkspaceId, string> = {
  extract: 'DETECT & CUT',
}

export const WORKSPACE_ORDER: WorkspaceId[] = ['extract']

// ── Information architecture ──────────────────────────────────────────────────
// Product reset (2026-07): the app is a single-canvas tool. The whole vision
// flow — Detect → Import & Cut → Compose → Export for Claude — lives on the
// Extract workspace's toolbar (as inline actions / modals), so there is exactly
// one workspace. The off-vision workspaces (Foundry, Animate, Train, Market,
// Design, Export/JUCE) were archived to the `full-featureset` git branch.
export const PRIMARY_WORKSPACES: WorkspaceId[] = ['extract']
export const PRO_WORKSPACES: WorkspaceId[] = []
// Order used for Ctrl+1..n shortcuts: primary first, then pro.
export const NAV_ORDER: WorkspaceId[] = [...PRIMARY_WORKSPACES, ...PRO_WORKSPACES]

interface WorkspaceState {
  activeWorkspace: WorkspaceId
  panelSizes: Record<WorkspaceId, PanelSizes>
  isTransitioning: boolean
  fullscreenMode: boolean      // F key — canvas only
  distractionFree: boolean     // Shift+F — essential controls only
  settingsOpen: boolean        // Settings modal
  panelAnalyzerOpen: boolean   // Inline semantic analyzer in Extract canvas
  partsCutterOpen: boolean     // Import & Cut to Parts Tray modal (Phase 2)
  composeOpen: boolean         // Compositing canvas modal (Phase 3)
  handoffOpen: boolean         // Embeddable-export (handoff bundle) modal (Phase 5)
  punchEditOpen: boolean       // Punch-editor canvas (post-detection correction)

  // Actions
  setWorkspace: (id: WorkspaceId) => void
  setLeftWidth: (w: number) => void
  setRightWidth: (w: number) => void
  setBottomHeight: (h: number) => void
  toggleLeftPanel: () => void
  toggleRightPanel: () => void
  toggleBottomPanel: () => void
  resetPanelSize: (panel: 'left' | 'right' | 'bottom') => void
  toggleFullscreen: () => void
  toggleDistractionFree: () => void
  openSettings: () => void
  closeSettings: () => void
  openPanelAnalyzer: () => void
  closePanelAnalyzer: () => void
  openPartsCutter: () => void
  closePartsCutter: () => void
  openCompose: () => void
  closeCompose: () => void
  openHandoff: () => void
  closeHandoff: () => void
  openPunchEdit: () => void
  closePunchEdit: () => void
}

// Persist to localStorage
const STORAGE_KEY = 'synthskin-workspace-state'
const STORAGE_VERSION = 3  // bump when layout defaults change (3: single-workspace reset)

function loadPersistedState(): { activeWorkspace: WorkspaceId; panelSizes: Record<WorkspaceId, PanelSizes> } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Discard state from older schema versions
    if (parsed.version !== STORAGE_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

function persistState(activeWorkspace: WorkspaceId, panelSizes: Record<WorkspaceId, PanelSizes>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, activeWorkspace, panelSizes }))
  } catch { /* quota exceeded — ignore */ }
}

const _rawPersisted = loadPersistedState()

const defaultPanelSizes: Record<WorkspaceId, PanelSizes> = {
  extract:     { ...DEFAULT_PANEL_SIZES },
}

// If the user's persisted state was saved before a new workspace was added,
// its panelSizes won't have a key for that workspace → accessing it crashes ResizablePanel.
// Always merge with defaults so every WorkspaceId is present.
const persisted = _rawPersisted
  ? {
      activeWorkspace: _rawPersisted.activeWorkspace,
      panelSizes: { ...defaultPanelSizes, ..._rawPersisted.panelSizes } as Record<WorkspaceId, PanelSizes>,
    }
  : null

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activeWorkspace: persisted?.activeWorkspace ?? 'extract',
  panelSizes: persisted?.panelSizes ?? { ...defaultPanelSizes },
  isTransitioning: false,
  fullscreenMode: false,
  distractionFree: false,
  settingsOpen: false,
  panelAnalyzerOpen: false,
  partsCutterOpen: false,
  composeOpen: false,
  handoffOpen: false,
  punchEditOpen: false,

  setWorkspace: (id) => {
    if (id === get().activeWorkspace) return
    set({ isTransitioning: true })
    // Small delay for crossfade
    setTimeout(() => {
      set({ activeWorkspace: id, isTransitioning: false })
      persistState(id, get().panelSizes)
    }, 20)
  },

  setLeftWidth: (w) => {
    const { activeWorkspace, panelSizes } = get()
    const clamped = Math.max(PANEL_CONSTRAINTS.left.min, Math.min(PANEL_CONSTRAINTS.left.max, w))
    const updated = { ...panelSizes, [activeWorkspace]: { ...panelSizes[activeWorkspace], leftWidth: clamped } }
    set({ panelSizes: updated })
    persistState(activeWorkspace, updated)
  },

  setRightWidth: (w) => {
    const { activeWorkspace, panelSizes } = get()
    const clamped = Math.max(PANEL_CONSTRAINTS.right.min, Math.min(PANEL_CONSTRAINTS.right.max, w))
    const updated = { ...panelSizes, [activeWorkspace]: { ...panelSizes[activeWorkspace], rightWidth: clamped } }
    set({ panelSizes: updated })
    persistState(activeWorkspace, updated)
  },

  setBottomHeight: (h) => {
    const { activeWorkspace, panelSizes } = get()
    const clamped = Math.max(PANEL_CONSTRAINTS.bottom.min, Math.min(PANEL_CONSTRAINTS.bottom.max, h))
    const updated = { ...panelSizes, [activeWorkspace]: { ...panelSizes[activeWorkspace], bottomHeight: clamped } }
    set({ panelSizes: updated })
    persistState(activeWorkspace, updated)
  },

  toggleLeftPanel: () => {
    const { activeWorkspace, panelSizes } = get()
    const current = panelSizes[activeWorkspace]
    const updated = { ...panelSizes, [activeWorkspace]: { ...current, leftCollapsed: !current.leftCollapsed } }
    set({ panelSizes: updated })
    persistState(activeWorkspace, updated)
  },

  toggleRightPanel: () => {
    const { activeWorkspace, panelSizes } = get()
    const current = panelSizes[activeWorkspace]
    const updated = { ...panelSizes, [activeWorkspace]: { ...current, rightCollapsed: !current.rightCollapsed } }
    set({ panelSizes: updated })
    persistState(activeWorkspace, updated)
  },

  toggleBottomPanel: () => {
    const { activeWorkspace, panelSizes } = get()
    const current = panelSizes[activeWorkspace]
    const updated = { ...panelSizes, [activeWorkspace]: { ...current, bottomCollapsed: !current.bottomCollapsed } }
    set({ panelSizes: updated })
    persistState(activeWorkspace, updated)
  },

  resetPanelSize: (panel) => {
    const { activeWorkspace, panelSizes } = get()
    const current = panelSizes[activeWorkspace]
    const defaults = defaultPanelSizes[activeWorkspace]
    let updated: PanelSizes
    switch (panel) {
      case 'left': updated = { ...current, leftWidth: defaults.leftWidth }; break
      case 'right': updated = { ...current, rightWidth: defaults.rightWidth }; break
      case 'bottom': updated = { ...current, bottomHeight: defaults.bottomHeight }; break
    }
    const newSizes = { ...panelSizes, [activeWorkspace]: updated }
    set({ panelSizes: newSizes })
    persistState(activeWorkspace, newSizes)
  },

  toggleFullscreen: () => {
    set((s) => ({ fullscreenMode: !s.fullscreenMode, distractionFree: false }))
  },

  toggleDistractionFree: () => {
    set((s) => ({ distractionFree: !s.distractionFree, fullscreenMode: false }))
  },

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openPanelAnalyzer: () => set({ panelAnalyzerOpen: true }),
  closePanelAnalyzer: () => set({ panelAnalyzerOpen: false }),
  openPartsCutter: () => set({ partsCutterOpen: true }),
  closePartsCutter: () => set({ partsCutterOpen: false }),
  openCompose: () => set({ composeOpen: true }),
  closeCompose: () => set({ composeOpen: false }),
  openHandoff: () => set({ handoffOpen: true }),
  closeHandoff: () => set({ handoffOpen: false }),
  openPunchEdit: () => set({ punchEditOpen: true }),
  closePunchEdit: () => set({ punchEditOpen: false }),
}))
