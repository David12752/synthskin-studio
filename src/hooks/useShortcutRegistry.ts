/**
 * hooks/useShortcutRegistry.ts
 * ─────────────────────────────
 * Registers all global keyboard shortcuts & command-palette commands.
 * Call once from App — returns nothing (side-effect only via registerShortcuts).
 *
 * Product reset (2026-07): the app is a single Extract workspace, so only the
 * core commands remain — file ops, view toggles, undo/redo, extract tools and
 * asset operations. Foundry/Design/Animate/Quality/Marketplace commands were
 * removed with those workspaces (archived on the full-featureset branch).
 */

import { useEffect } from 'react'
import { registerShortcuts } from './useKeyboardShortcuts'
import { useProjectStore } from '../stores/projectStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useHistoryStore } from '../stores/historyStore'
import { useCanvasStore } from '../stores/canvasStore'
import { useAssetStore } from '../stores/assetStore'

export function useShortcutRegistry() {
  useEffect(() => {
    return registerShortcuts([
      // ─── File Commands ───
      { key: 'ctrl+n', label: 'New Project', action: () => useProjectStore.getState().newProject(), category: 'File' },
      { key: 'ctrl+o', label: 'Open Project', action: () => useProjectStore.getState().openProject(), category: 'File' },
      { key: 'ctrl+s', label: 'Save Project', action: () => useProjectStore.getState().saveProject(), category: 'File' },
      { key: 'ctrl+shift+s', label: 'Save Project As', action: () => useProjectStore.getState().saveProjectAs(), category: 'File' },

      // ─── View Commands ───
      { key: 'f', label: 'Toggle Fullscreen Canvas', action: () => useWorkspaceStore.getState().toggleFullscreen(), category: 'View' },
      { key: 'shift+f', label: 'Toggle Distraction-Free Mode', action: () => useWorkspaceStore.getState().toggleDistractionFree(), category: 'View' },
      { key: '', label: 'Toggle Left Panel', action: () => useWorkspaceStore.getState().toggleLeftPanel(), category: 'View' },
      { key: '', label: 'Toggle Right Panel', action: () => useWorkspaceStore.getState().toggleRightPanel(), category: 'View' },
      { key: '', label: 'Toggle Bottom Panel', action: () => useWorkspaceStore.getState().toggleBottomPanel(), category: 'View' },

      // ─── Edit / History ───
      { key: 'ctrl+z', label: 'Undo', action: () => useHistoryStore.getState().undo(), category: 'Edit' },
      { key: 'ctrl+shift+z', label: 'Redo', action: () => useHistoryStore.getState().redo(), category: 'Edit' },

      // ─── Extract Tools ───
      { key: 'v', label: 'Select Tool', action: () => useCanvasStore.getState().setActiveTool('select'), category: 'Extract', workspace: 'extract' },
      { key: 'c', label: 'Circle Extract Tool', action: () => useCanvasStore.getState().setActiveTool('circle'), category: 'Extract', workspace: 'extract' },
      { key: 'r', label: 'Rect Extract Tool', action: () => useCanvasStore.getState().setActiveTool('rect'), category: 'Extract', workspace: 'extract' },
      { key: 's', label: 'Smart Select Tool', action: () => useCanvasStore.getState().setActiveTool('sam'), category: 'Extract', workspace: 'extract' },
      { key: 'w', label: 'Magic Wand Tool', action: () => useCanvasStore.getState().setActiveTool('wand'), category: 'Extract', workspace: 'extract' },
      { key: 'h', label: 'Hand / Pan Tool', action: () => useCanvasStore.getState().setActiveTool('hand'), category: 'Extract', workspace: 'extract' },
      { key: 'z', label: 'Zoom Tool', action: () => useCanvasStore.getState().setActiveTool('zoom'), category: 'Extract', workspace: 'extract' },
      { key: 'ctrl+0', label: 'Zoom to Fit', action: () => useCanvasStore.getState().setZoom(1), category: 'Extract', workspace: 'extract' },
      { key: 'ctrl+1', label: 'Zoom to 100%', action: () => useCanvasStore.getState().setZoom(1), category: 'Extract', workspace: 'extract' },

      // ─── Asset Operations ───
      {
        key: 'delete', label: 'Delete Selected Asset', category: 'Asset',
        action: () => {
          const id = useAssetStore.getState().selectedAssetId
          if (id) useAssetStore.getState().removeAsset(id)
        },
      },
      {
        key: '', label: 'Select All Assets', category: 'Asset',
        action: () => {
          const assets = useAssetStore.getState().assets
          if (assets.length > 0) useAssetStore.getState().selectAsset(assets[0].id)
        },
      },
      {
        key: '', label: 'Deselect All', category: 'Asset',
        action: () => useAssetStore.getState().selectAsset(null as unknown as string),
      },
    ])
  }, [])
}
