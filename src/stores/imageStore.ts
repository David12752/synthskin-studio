import { create } from 'zustand'
import { useProjectStore } from './projectStore'

export interface LoadedImage {
  id: string
  path: string
  width: number
  height: number
  dataUrl: string
  htmlImage: HTMLImageElement
}

export interface ImageViewport {
  zoom: number
  panX: number
  panY: number
}

interface ImageState {
  /** All open images (tabs) */
  images: LoadedImage[]
  /** Currently active image id */
  activeImageId: string | null
  /** Derived: the active image object */
  sourceImage: LoadedImage | null
  isLoading: boolean
  /** Per-image viewport state (zoom/pan) keyed by image id */
  viewports: Record<string, ImageViewport>
  /** Open a new image (adds tab + activates it). If already open, just activates. */
  openImage: (img: LoadedImage) => void
  /** Activate an existing tab */
  setActiveImage: (id: string) => void
  /** Close a tab */
  closeImage: (id: string) => void
  /** Legacy setter — opens image as active tab */
  setSourceImage: (img: LoadedImage | null) => void
  setLoading: (v: boolean) => void
  /** Save viewport state for an image */
  saveViewport: (imageId: string, viewport: ImageViewport) => void
  /** Get saved viewport, or null */
  getViewport: (imageId: string) => ImageViewport | null
}

export const useImageStore = create<ImageState>((set, get) => ({
  images: [],
  activeImageId: null,
  sourceImage: null,
  isLoading: false,
  viewports: {},

  openImage: (img) => {
    const state = get()
    const existing = state.images.find((i) => i.id === img.id)
    if (existing) {
      set({ activeImageId: img.id, sourceImage: existing })
      return
    }
    const images = [...state.images, img]
    set({ images, activeImageId: img.id, sourceImage: img, isLoading: false })
    useProjectStore.getState().markDirty()
  },

  setActiveImage: (id) => {
    const img = get().images.find((i) => i.id === id)
    if (img) set({ activeImageId: id, sourceImage: img })
  },

  closeImage: (id) => {
    const state = get()
    const images = state.images.filter((i) => i.id !== id)
    const viewports = { ...state.viewports }
    delete viewports[id]
    let activeImageId = state.activeImageId
    let sourceImage: LoadedImage | null = state.sourceImage
    if (activeImageId === id) {
      const idx = state.images.findIndex((i) => i.id === id)
      const next = images[Math.min(idx, images.length - 1)]
      activeImageId = next?.id ?? null
      sourceImage = next ?? null
    }
    set({ images, activeImageId, sourceImage, viewports })
  },

  setSourceImage: (img) => {
    if (img) {
      get().openImage(img)
    } else {
      set({ sourceImage: null, activeImageId: null, isLoading: false })
    }
  },

  setLoading: (v) => set({ isLoading: v }),

  saveViewport: (imageId, viewport) => {
    set((s) => ({ viewports: { ...s.viewports, [imageId]: viewport } }))
  },

  getViewport: (imageId) => {
    return get().viewports[imageId] ?? null
  },
}))
