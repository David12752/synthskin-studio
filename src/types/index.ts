export interface Asset {
  id: string
  name: string
  type: 'knob' | 'slider' | 'meter' | 'button' | 'led' | 'screen' | 'decoration'
  sourceImageId: string
  extractionMethod: 'circle' | 'rect' | 'sam' | 'wand' | 'lasso' | 'polyLasso' | 'pro'
  extractionParams: Record<string, unknown>
  maskDataUrl: string
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
  metadata: {
    centerPoint?: { x: number; y: number }
    createdAt: string
    tags: string[]
    candidates?: { dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }[]
    lassoPoints?: { x: number; y: number }[]
    samPoints?: { x: number; y: number; label: 0 | 1 }[]
  }
  pluginMeta?: PluginMetadata
  /** Material id from the Material Library (null = use original appearance) */
  materialId?: string | null
  /** Per-asset lighting override (null = use global scene lighting) */
  lightingOverride?: {
    lightAzimuth: number
    lightElevation: number
    lightIntensity: number
  } | null
  /** Normalized value 0-1 (knob rotation dial position, slider position, meter level) */
  value?: number
  /** Current rotation angle in degrees (computed from value + physics config) */
  rotation?: number

  // ─── 3D / PBR textures (commercial-safe 3D extraction) ───
  /** Tangent-space normal map (RGB encodes normal, packed to [0,1]) */
  normalMapUrl?: string
  /** Grayscale depth map from Depth-Anything-V2 */
  depthMapUrl?: string
  /** Detector-assigned type before user edits (knob/slider/button/screen/unknown) */
  detectedType?: string
  /** Original detector bbox, preserved even after manual adjustments */
  initialGeometry?: { x: number; y: number; width: number; height: number }
}

// ─── Plugin Metadata ───

export interface PluginMetadata {
  parameterId: string           // e.g. "osc1_frequency"
  displayName: string           // e.g. "Oscillator 1 Freq"
  unit: string                  // e.g. "Hz", "dB", "%", ""
  minValue: number              // e.g. 20
  maxValue: number              // e.g. 20000
  defaultValue: number          // e.g. 440
  skew: number                  // 1.0 = linear, >1 = log-like
  suffix: string                // e.g. " Hz"
  automatable: boolean
}

export const DEFAULT_PLUGIN_META: PluginMetadata = {
  parameterId: '',
  displayName: '',
  unit: '',
  minValue: 0,
  maxValue: 1,
  defaultValue: 0.5,
  skew: 1.0,
  suffix: '',
  automatable: true,
}

// ─── Templates ───

export interface AssetTemplate {
  id: string
  name: string
  assetType: Asset['type']
  extractionMethod: Asset['extractionMethod']
  extractionParams: Record<string, unknown>
  pluginMeta?: PluginMetadata
  animationPreset?: {
    rotationMode: RotationMode
    startAngle: number
    endAngle: number
    frameCount: number
  }
  createdAt: string
}

export type RotationMode = 'simple' | 'indicator'

export interface AnimationConfig {
  assetId: string
  rotationMode: RotationMode
  centerX: number
  centerY: number
  startAngle: number   // degrees, e.g. -135
  endAngle: number     // degrees, e.g. +135
  frameCount: number   // default 128
  outputSize: number   // square output px
  // Indicator overlay mode
  indicatorAngle?: number  // indicator line angle relative to center (0 = top)
  indicatorLength?: number // px from center
  indicatorWidth?: number  // stroke width
  indicatorColor?: string  // hex color
}

export interface AnimationResult {
  frames: string[]       // array of data:image/png;base64 per frame
  filmstripDataUrl: string
  config: AnimationConfig
}

export type MeterMode = 'needle' | 'led_bar' | 'screen'

export interface MeterConfig {
  meterMode: MeterMode
  // Needle mode
  faceAssetId?: string
  needleAssetId?: string
  pivotX: number
  pivotY: number
  restAngle: number        // degrees, default -50
  fullScaleAngle: number   // degrees, default +50
  motionBlur: boolean
  motionBlurSamples: number
  // LED bar mode
  ledOffAssetId?: string
  ledOnAssetId?: string
  segmentCount: number
  orientation: 'vertical' | 'horizontal'
  gradientColors: [number, number, number][]  // [[R,G,B], ...]
  gapFraction: number
  // Common
  frameCount: number
  outputWidth: number
  outputHeight: number
}

export interface MeterResult {
  frames: string[]
  filmstripDataUrl: string
  config: MeterConfig
}

export interface SourceImage {
  id: string
  path: string
  width: number
  height: number
}

export interface ProjectFile {
  version: string
  name: string
  assets: Asset[]
  sourceImages: SourceImage[]
}

// ─── Export Pipeline ───

export type ExportFormat = 'juce' | 'spritesheet' | 'individual' | 'svg'

export interface ExportConfig {
  assetId: string
  assetName: string
  assetType: string
  formats: ExportFormat[]
  // JUCE export
  includeRetina: boolean
  includeIndividualFrames: boolean
  includeSpritesheet: boolean
  includeSvg: boolean
  pow2Spritesheet: boolean
  // Multi-scale individual PNGs
  scales: number[]        // e.g. [1, 2, 3, 4]
  // Source data
  frames: string[]        // base64 frames to export
  frameWidth: number
  frameHeight: number
  // Lighting bake
  bakeShadows: boolean
}

export interface ExportFileEntry {
  type: 'binary' | 'text'
  data: string             // base64 for binary, plain string for text
}

export interface JuceExportPackage {
  files: Record<string, ExportFileEntry>
  metadata: {
    name: string
    safeName: string
    type: string
    frameCount: number
    frameWidth: number
    frameHeight: number
    generator: string
    version: string
  }
}
