import { create } from 'zustand'
import type { Asset, PluginMetadata } from '../types'
import { useHistoryStore } from './historyStore'
import { useProjectStore } from './projectStore'

interface AssetState {
  assets: Asset[]
  selectedAssetId: string | null
  addAsset: (asset: Asset) => void
  removeAsset: (id: string) => void
  selectAsset: (id: string | null) => void
  updateAssetName: (id: string, name: string) => void
  updateAssetType: (id: string, type: Asset['type']) => void
  updatePluginMeta: (id: string, meta: PluginMetadata) => void
  updateAssetTags: (id: string, tags: string[]) => void
  updateAssetMaterial: (id: string, materialId: string | null) => void
  updateAssetLightingOverride: (id: string, override: { lightAzimuth: number; lightElevation: number; lightIntensity: number } | null) => void
  updateAssetValue: (id: string, value: number, rotation?: number) => void
  updateAssetBounds: (id: string, bounds: Partial<Asset['bounds']>) => void
  updateAssetMask: (id: string, maskDataUrl: string) => void
  updateAssetExtraction: (id: string, updates: { maskDataUrl?: string; bounds?: Partial<Asset['bounds']>; metadata?: Partial<Asset['metadata']> }) => void
  updateAsset3DTextures: (id: string, textures: {
    normalMapUrl?: string
    depthMapUrl?: string
    detectedType?: string
    initialGeometry?: { x: number; y: number; width: number; height: number }
  }) => void
}

export const useAssetStore = create<AssetState>((set) => ({
  assets: [],
  selectedAssetId: null,
  addAsset: (asset) => {
    useHistoryStore.getState().pushSnapshot()
    set((s) => ({ assets: [...s.assets, asset] }))
    useProjectStore.getState().markDirty()
  },
  removeAsset: (id) => {
    useHistoryStore.getState().pushSnapshot()
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }))
    useProjectStore.getState().markDirty()
  },
  selectAsset: (id) => set({ selectedAssetId: id }),
  updateAssetName: (id, name) => {
    useHistoryStore.getState().pushSnapshot()
    set((s) => ({
      assets: s.assets.map((a) => a.id === id ? { ...a, name } : a),
    }))
    useProjectStore.getState().markDirty()
  },
  updateAssetType: (id, type) => {
    useHistoryStore.getState().pushSnapshot()
    set((s) => ({
      assets: s.assets.map((a) => a.id === id ? { ...a, type } : a),
    }))
    useProjectStore.getState().markDirty()
  },
  updatePluginMeta: (id, meta) => {
    useHistoryStore.getState().pushSnapshot()
    set((s) => ({
      assets: s.assets.map((a) => a.id === id ? { ...a, pluginMeta: meta } : a),
    }))
    useProjectStore.getState().markDirty()
  },
  updateAssetTags: (id, tags) => {
    set((s) => ({
      assets: s.assets.map((a) =>
        a.id === id ? { ...a, metadata: { ...a.metadata, tags } } : a
      ),
    }))
    useProjectStore.getState().markDirty()
  },
  updateAssetMaterial: (id, materialId) => {
    set((s) => ({
      assets: s.assets.map((a) => a.id === id ? { ...a, materialId } : a),
    }))
    useProjectStore.getState().markDirty()
  },
  updateAssetLightingOverride: (id, override) => {
    set((s) => ({
      assets: s.assets.map((a) => a.id === id ? { ...a, lightingOverride: override } : a),
    }))
    useProjectStore.getState().markDirty()
  },
  updateAssetValue: (id, value, rotation) => {
    set((s) => ({
      assets: s.assets.map((a) => a.id === id ? { ...a, value, ...(rotation !== undefined ? { rotation } : {}) } : a),
    }))
  },
  updateAssetBounds: (id, bounds) => {
    set((s) => ({
      assets: s.assets.map((a) => a.id === id ? { ...a, bounds: { ...a.bounds, ...bounds } } : a),
    }))
  },
  updateAssetMask: (id, maskDataUrl) => {
    useHistoryStore.getState().pushSnapshot()
    set((s) => ({
      assets: s.assets.map((a) => a.id === id ? { ...a, maskDataUrl } : a),
    }))
    useProjectStore.getState().markDirty()
  },
  updateAssetExtraction: (id, updates) => {
    useHistoryStore.getState().pushSnapshot()
    set((s) => ({
      assets: s.assets.map((a) => {
        if (a.id !== id) return a
        const patched = { ...a }
        if (updates.maskDataUrl) patched.maskDataUrl = updates.maskDataUrl
        if (updates.bounds) patched.bounds = { ...a.bounds, ...updates.bounds }
        if (updates.metadata) patched.metadata = { ...a.metadata, ...updates.metadata }
        return patched
      }),
    }))
    useProjectStore.getState().markDirty()
  },
  updateAsset3DTextures: (id, textures) => {
    useHistoryStore.getState().pushSnapshot()
    set((s) => ({
      assets: s.assets.map((a) => {
        if (a.id !== id) return a
        return {
          ...a,
          ...(textures.normalMapUrl !== undefined ? { normalMapUrl: textures.normalMapUrl } : {}),
          ...(textures.depthMapUrl !== undefined ? { depthMapUrl: textures.depthMapUrl } : {}),
          ...(textures.detectedType !== undefined ? { detectedType: textures.detectedType } : {}),
          ...(textures.initialGeometry !== undefined ? { initialGeometry: textures.initialGeometry } : {}),
        }
      }),
    }))
    useProjectStore.getState().markDirty()
  },
}))
