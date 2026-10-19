/**
 * createPart.ts — glue between a freeCut result and the Parts tray.
 *
 * Encodes a cut's RGBA image to a data-URL (DOM) and stages it as a tray part.
 * Kept out of freeCut.ts so that stays node-testable; this needs the browser.
 */
import type { CutResult } from './freeCut'
import { rgbaToDataUrl } from './imageData'
import { usePartsTrayStore, type TrayPart } from '../../stores/partsTrayStore'

export interface PartMeta {
  name: string
  kind: 'cut' | 'import'
  imageId?: string
  srcName?: string
}

/** Build (but do not stage) a tray part from a cut result. */
export function partFromCut(cut: CutResult, meta: PartMeta): Omit<TrayPart, 'id' | 'createdAt'> {
  return {
    name: meta.name,
    dataUrl: rgbaToDataUrl(cut.image),
    width: cut.image.width,
    height: cut.image.height,
    source: { kind: meta.kind, imageId: meta.imageId, srcName: meta.srcName, bounds: cut.bounds },
  }
}

/** Encode a cut and add it to the Parts tray; returns the created part. */
export function addCutToTray(cut: CutResult, meta: PartMeta): TrayPart {
  return usePartsTrayStore.getState().addPart(partFromCut(cut, meta))
}
