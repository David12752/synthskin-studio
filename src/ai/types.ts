// ─── Phase 5: AI Features — Type Definitions ───

export interface AICapabilities {
  style_transfer: boolean
  component_detection: boolean
  yolo_detection: boolean
  yolo_pipeline: boolean
  lighting_normalize: boolean
  upscale_lanczos: boolean
  upscale_esrgan: boolean
  symmetry: boolean
  inpainting: boolean
  inpainting_lama: boolean
  background_removal: boolean
  background_removal_basic: boolean
  prompt_to_component: boolean
  prompt_to_component_placeholder: boolean
  gemma: boolean
  gemma_model: string | null
  gemma_status: GemmaStatus
  sam2: boolean
  sam2_status: SAM2Status
}

// ─── Gemma ───

export interface GemmaStatus {
  available: boolean
  model: string | null
  ollama_running: boolean
  models_found: string[]
  install_hint: string
}

export interface GemmaPanelAnalysis {
  description: string
  components: { type: string; description: string; position: string }[]
  style: string
  color_scheme: string
  layout: string
  suggestions: string[]
}

export interface GemmaStyleSuggestion {
  style: string
  palette: { bg: string; accent: string; text: string; knob: string }
  fonts: string[]
  materials: { panel: string; knobs: string }
  reasoning: string
}

export interface GemmaComponentNaming {
  name: string
  description: string
  suggested_type: string
  parameter_hint: string
}

export interface GemmaLayoutAnalysis {
  grid: { rows: number; cols: number; regular: boolean }
  sections: { name: string; position: string; components: string }[]
  alignment: string
  spacing: string
  symmetry: string
  recommendations: string[]
}

// ─── SAM2 ───

export interface SAM2Status {
  available: boolean
  library_installed: boolean
  checkpoint_found: boolean
  checkpoint_path: string | null
  gpu_available: boolean
  install_hint: string | null
}

export interface SAMSegmentResult {
  masks: SAMMask[]
  count: number
  method: string
}

export interface SAMMask {
  dataUrl: string
  score: number
  bounds: { x: number; y: number; width: number; height: number }
  area: number
  mask_dataUrl?: string
}

export interface SAMAutoSegmentResult {
  segments: SAMSegment[]
  count: number
  method: string
}

export interface SAMSegment {
  dataUrl: string
  bounds: { x: number; y: number; width: number; height: number }
  area: number
  score: number
  stability: number
  type?: string
}

// ─── 5.1 Style Transfer ───

export interface StylePreset {
  id: string
  name: string
  accent: [number, number, number]
  material: string
}

export interface StyleTransferResult {
  dataUrl: string
  style: string
  font_suggestions: string[]
  material: string
  accent_color: number[]
  background_color: number[]
}

// ─── 5.2 Component Detection ───

export interface AIDetection {
  id: string
  type: string
  sub_type: string
  confidence: number
  bounds: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
  preview: string
}

// ─── 5.3 Lighting ───

export interface LightingEstimate {
  azimuth: number
  elevation: number
  confidence: number
}

export interface LightingNormalizeResult {
  dataUrl: string
  original_lighting: LightingEstimate
  target_lighting: { azimuth: number; elevation: number }
}

// ─── 5.4 Upscaling ───

export interface UpscaleResult {
  dataUrl: string
  method: 'lanczos' | 'real-esrgan'
  original_size: { width: number; height: number }
  new_size: { width: number; height: number }
}

// ─── 5.5 Symmetry ───

export interface SymmetryAnalysis {
  horizontal_score: number
  vertical_score: number
  radial_score: number
  best_type: 'horizontal' | 'vertical' | 'radial' | 'none'
  center: { x: number; y: number }
}

export interface SymmetryResult {
  dataUrl: string
  symmetry_type: string
  error_before: number
  error_after: number
}

// ─── 5.6 Inpainting ───

export interface TextRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface TextDetectionResult {
  regions: TextRegion[]
  count: number
  mask_dataUrl: string
}

export interface InpaintResult {
  dataUrl: string
  method: string
  pixels_inpainted: number
}

export interface AutoRemoveTextResult {
  dataUrl: string
  method: string
  regions_found: number
  pixels_inpainted: number
}

// ─── 5.7 Prompt-to-Component ───

export interface GenerationPreset {
  id: string
  name: string
}

export interface GenerateComponentResult {
  dataUrl: string
  prompt: string
  full_prompt: string
  method: string
  available: boolean
  install_hint?: string
}

export interface RemoveBackgroundResult {
  dataUrl: string
  method: string
}

// ─── AI Studio Tab ───

export type AITab =
  | 'style-transfer'
  | 'component-detection'
  | 'lighting'
  | 'upscale'
  | 'symmetry'
  | 'inpainting'
  | 'generate'
  | 'gemma'
