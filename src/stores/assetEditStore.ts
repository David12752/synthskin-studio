import { create } from 'zustand'

export type AssetEditTool = 'move' | 'brush' | 'eraser' | 'center'

interface AssetEditState {
  /** ID of the asset currently being edited in the main canvas, null if not editing */
  editingAssetId: string | null
  /** Current mask editing tool */
  editTool: AssetEditTool
  /** Brush/eraser size in pixels (1–32) */
  brushSize: number
  /** Editor zoom level (1–32) */
  editorZoom: number
  /** Show pixel grid overlay */
  showGrid: boolean

  startEditing: (assetId: string) => void
  stopEditing: () => void
  setEditTool: (tool: AssetEditTool) => void
  setBrushSize: (size: number) => void
  setEditorZoom: (zoom: number) => void
  toggleGrid: () => void
}

export const useAssetEditStore = create<AssetEditState>((set) => ({
  editingAssetId: null,
  editTool: 'brush',
  brushSize: 4,
  editorZoom: 1,
  showGrid: true,

  startEditing: (assetId) => set({ editingAssetId: assetId, editTool: 'brush' }),
  stopEditing: () => set({ editingAssetId: null }),
  setEditTool: (tool) => set({ editTool: tool }),
  setBrushSize: (size) => set({ brushSize: Math.max(1, Math.min(32, size)) }),
  setEditorZoom: (zoom) => set({ editorZoom: Math.max(1, Math.min(32, zoom)) }),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
}))
