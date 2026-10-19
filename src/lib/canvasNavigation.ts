const LINE_DELTA_PX = 10
const PAN_SENSITIVITY = 0.75
const MAX_PAN_STEP_PX = 48
const MAX_ZOOM_STEP_PX = 48
const ZOOM_SENSITIVITY = 0.0035

interface Point {
  x: number
  y: number
}

type WheelLikeEvent = Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'deltaMode' | 'deltaX' | 'deltaY'>

interface WheelNavigationInput {
  event: WheelLikeEvent
  pointer: { x: number; y: number }
  zoom: number
  panX: number
  panY: number
  minZoom: number
  maxZoom: number
  viewportWidth: number
  viewportHeight: number
}

interface WheelNavigationResult {
  mode: 'pan' | 'zoom'
  zoom: number
  panX: number
  panY: number
}

interface TouchNavigationInput {
  previousTouches: [Point, Point]
  touches: [Point, Point]
  zoom: number
  panX: number
  panY: number
  minZoom: number
  maxZoom: number
}

function normalizeWheelDelta(delta: number, deltaMode: number, viewportSize: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * LINE_DELTA_PX
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * viewportSize
  return delta
}

function clampMagnitude(value: number, maxAbs: number): number {
  return Math.sign(value) * Math.min(Math.abs(value), maxAbs)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function distance(a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }
}

export function getWheelNavigation(input: WheelNavigationInput): WheelNavigationResult {
  const { event, pointer, zoom, panX, panY, minZoom, maxZoom, viewportWidth, viewportHeight } = input

  const rawDeltaX = normalizeWheelDelta(event.deltaX, event.deltaMode, viewportWidth)
  const rawDeltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, viewportHeight)

  let deltaX = clampMagnitude(rawDeltaX * PAN_SENSITIVITY, MAX_PAN_STEP_PX)
  let deltaY = clampMagnitude(rawDeltaY * PAN_SENSITIVITY, MAX_PAN_STEP_PX)

  // Match common desktop apps: Shift + wheel scrolls horizontally.
  if (event.shiftKey && Math.abs(deltaX) < Math.abs(deltaY)) {
    deltaX = deltaY
    deltaY = 0
  }

  // Laptop pinch gestures commonly arrive as Ctrl/Cmd + wheel.
  if (event.ctrlKey || event.metaKey) {
    // Keep zoom responsive, but avoid huge single-event jumps from mouse wheels
    // and high-resolution trackpads.
    const zoomDelta = clampMagnitude(rawDeltaY, MAX_ZOOM_STEP_PX)
    const zoomFactor = Math.exp(-zoomDelta * ZOOM_SENSITIVITY)
    const nextZoom = clamp(zoom * zoomFactor, minZoom, maxZoom)

    if (nextZoom === zoom) {
      return { mode: 'zoom', zoom, panX, panY }
    }

    const worldX = (pointer.x - panX) / zoom
    const worldY = (pointer.y - panY) / zoom

    return {
      mode: 'zoom',
      zoom: nextZoom,
      panX: pointer.x - worldX * nextZoom,
      panY: pointer.y - worldY * nextZoom,
    }
  }

  return {
    mode: 'pan',
    zoom,
    panX: panX - deltaX,
    panY: panY - deltaY,
  }
}

export function getTouchNavigation(input: TouchNavigationInput): WheelNavigationResult {
  const { previousTouches, touches, zoom, panX, panY, minZoom, maxZoom } = input

  const previousCenter = midpoint(previousTouches[0], previousTouches[1])
  const currentCenter = midpoint(touches[0], touches[1])
  const previousDistance = Math.max(distance(previousTouches[0], previousTouches[1]), 1)
  const currentDistance = Math.max(distance(touches[0], touches[1]), 1)

  const worldX = (previousCenter.x - panX) / zoom
  const worldY = (previousCenter.y - panY) / zoom
  const nextZoom = clamp(zoom * (currentDistance / previousDistance), minZoom, maxZoom)

  return {
    mode: nextZoom === zoom ? 'pan' : 'zoom',
    zoom: nextZoom,
    panX: currentCenter.x - worldX * nextZoom,
    panY: currentCenter.y - worldY * nextZoom,
  }
}

/**
 * Clamp pan values so the image always stays partially visible.
 * Keeps at least `margin` pixels of the image visible in the viewport.
 */
export function clampPan(
  panX: number,
  panY: number,
  zoom: number,
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 100,
): { panX: number; panY: number } {
  const imgW = imageWidth * zoom
  const imgH = imageHeight * zoom

  // Allow panning such that at least `margin` px of image is visible
  const minPanX = -(imgW - margin)
  const maxPanX = viewportWidth - margin
  const minPanY = -(imgH - margin)
  const maxPanY = viewportHeight - margin

  return {
    panX: clamp(panX, minPanX, maxPanX),
    panY: clamp(panY, minPanY, maxPanY),
  }
}