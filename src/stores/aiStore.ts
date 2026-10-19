import { create } from 'zustand'
import type {
  AICapabilities, AITab, StylePreset, GenerationPreset,
} from '../ai/types'

interface AIState {
  // Modal
  open: boolean
  tab: AITab

  // Capabilities (fetched from backend on first open)
  capabilities: AICapabilities | null
  capabilitiesLoading: boolean

  // Style presets
  styles: StylePreset[]
  selectedStyle: string
  styleStrength: number

  // Detection
  detectionConfidence: number

  // Lighting
  targetAzimuth: number
  targetElevation: number
  lightingStrength: number

  // Upscale
  upscaleScale: 2 | 4
  upscaleSharpen: number

  // Symmetry
  symmetryType: 'auto' | 'horizontal' | 'vertical' | 'radial'
  symmetryStrength: number

  // Inpainting
  inpaintMethod: 'telea' | 'navier-stokes'
  inpaintRadius: number

  // Generation
  generationPresets: GenerationPreset[]
  generatePrompt: string
  generateType: string
  generatePreset: string

  // Processing state
  processing: boolean
  progress: string
  lastResult: string | null // dataUrl of last operation result

  // Actions
  openStudio: () => void
  closeStudio: () => void
  setTab: (tab: AITab) => void
  setCapabilities: (caps: AICapabilities) => void
  setCapabilitiesLoading: (v: boolean) => void
  setStyles: (styles: StylePreset[]) => void
  setSelectedStyle: (id: string) => void
  setStyleStrength: (v: number) => void
  setDetectionConfidence: (v: number) => void
  setTargetAzimuth: (v: number) => void
  setTargetElevation: (v: number) => void
  setLightingStrength: (v: number) => void
  setUpscaleScale: (v: 2 | 4) => void
  setUpscaleSharpen: (v: number) => void
  setSymmetryType: (v: 'auto' | 'horizontal' | 'vertical' | 'radial') => void
  setSymmetryStrength: (v: number) => void
  setInpaintMethod: (v: 'telea' | 'navier-stokes') => void
  setInpaintRadius: (v: number) => void
  setGenerationPresets: (presets: GenerationPreset[]) => void
  setGeneratePrompt: (v: string) => void
  setGenerateType: (v: string) => void
  setGeneratePreset: (v: string) => void
  setProcessing: (v: boolean) => void
  setProgress: (v: string) => void
  setLastResult: (v: string | null) => void
}

export const useAIStore = create<AIState>((set) => ({
  open: false,
  tab: 'style-transfer',
  capabilities: null,
  capabilitiesLoading: false,
  styles: [],
  selectedStyle: 'moog',
  styleStrength: 0.7,
  detectionConfidence: 0.4,
  targetAzimuth: 315,
  targetElevation: 60,
  lightingStrength: 0.7,
  upscaleScale: 2,
  upscaleSharpen: 0.4,
  symmetryType: 'auto',
  symmetryStrength: 1.0,
  inpaintMethod: 'telea',
  inpaintRadius: 5,
  generationPresets: [],
  generatePrompt: '',
  generateType: 'knob',
  generatePreset: 'modern',
  processing: false,
  progress: '',
  lastResult: null,

  openStudio: () => set({ open: true }),
  closeStudio: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setCapabilitiesLoading: (capabilitiesLoading) => set({ capabilitiesLoading }),
  setStyles: (styles) => set({ styles }),
  setSelectedStyle: (selectedStyle) => set({ selectedStyle }),
  setStyleStrength: (styleStrength) => set({ styleStrength }),
  setDetectionConfidence: (detectionConfidence) => set({ detectionConfidence }),
  setTargetAzimuth: (targetAzimuth) => set({ targetAzimuth }),
  setTargetElevation: (targetElevation) => set({ targetElevation }),
  setLightingStrength: (lightingStrength) => set({ lightingStrength }),
  setUpscaleScale: (upscaleScale) => set({ upscaleScale }),
  setUpscaleSharpen: (upscaleSharpen) => set({ upscaleSharpen }),
  setSymmetryType: (symmetryType) => set({ symmetryType }),
  setSymmetryStrength: (symmetryStrength) => set({ symmetryStrength }),
  setInpaintMethod: (inpaintMethod) => set({ inpaintMethod }),
  setInpaintRadius: (inpaintRadius) => set({ inpaintRadius }),
  setGenerationPresets: (generationPresets) => set({ generationPresets }),
  setGeneratePrompt: (generatePrompt) => set({ generatePrompt }),
  setGenerateType: (generateType) => set({ generateType }),
  setGeneratePreset: (generatePreset) => set({ generatePreset }),
  setProcessing: (processing) => set({ processing }),
  setProgress: (progress) => set({ progress }),
  setLastResult: (lastResult) => set({ lastResult }),
}))
