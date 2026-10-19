/**
 * importImage.ts — bring an arbitrary image into the app as a cut source.
 *
 * Phase 2's "paste parts from OTHER images" starts here: load any image file
 * into a LoadedImage and (optionally) open it as a new tab so the user can cut
 * parts from it just like the panel. Uses the same FileReader→Image path the
 * canvas uses; needs the DOM, so it is exercised in the app, not vitest.
 */
import { type LoadedImage, useImageStore } from '../../stores/imageStore'

let _seq = 0
const newImageId = () => `img_${Date.now().toString(36)}_${(_seq++).toString(36)}`

/** Decode a File into a LoadedImage (no store side-effects). */
export async function fileToLoadedImage(file: File): Promise<LoadedImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`))
    reader.readAsDataURL(file)
  })
  const htmlImage = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to decode ${file.name}`))
    img.src = dataUrl
  })
  return {
    id: newImageId(),
    path: file.name,
    width: htmlImage.naturalWidth,
    height: htmlImage.naturalHeight,
    dataUrl,
    htmlImage,
  }
}

/** Load a File and open it as a new active source tab. */
export async function importImageAsSource(file: File): Promise<LoadedImage> {
  const img = await fileToLoadedImage(file)
  useImageStore.getState().openImage(img)
  return img
}
