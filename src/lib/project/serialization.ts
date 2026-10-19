import type { Asset, SourceImage } from '../../types'
import type { PanelLayoutResult } from '../api/pythonClient'

/**
 * .synthskin file format — JSON with embedded image data.
 */
export interface SynthSkinFile {
  version: string
  name: string
  createdAt: string
  updatedAt: string
  sourceImages: SerializedSourceImage[]
  assets: Asset[]
  panelLayout?: PanelLayoutResult | null
}

interface SerializedSourceImage {
  id: string
  path: string
  width: number
  height: number
  dataUrl: string
}

const FILE_VERSION = '1.0.0'

export function serializeProject(
  name: string,
  assets: Asset[],
  sourceImage: { id: string; path: string; width: number; height: number; dataUrl: string } | null,
  existingCreatedAt?: string,
  panelLayout?: PanelLayoutResult | null,
): string {
  const now = new Date().toISOString()
  const file: SynthSkinFile = {
    version: FILE_VERSION,
    name,
    createdAt: existingCreatedAt ?? now,
    updatedAt: now,
    sourceImages: sourceImage
      ? [{
          id: sourceImage.id,
          path: sourceImage.path,
          width: sourceImage.width,
          height: sourceImage.height,
          dataUrl: sourceImage.dataUrl,
        }]
      : [],
    assets,
    panelLayout: panelLayout ?? null,
  }
  return JSON.stringify(file)
}

export function deserializeProject(json: string): SynthSkinFile {
  const parsed = JSON.parse(json)
  if (!parsed.version || !parsed.name || !Array.isArray(parsed.assets)) {
    throw new Error('Invalid .synthskin file format')
  }
  return parsed as SynthSkinFile
}
