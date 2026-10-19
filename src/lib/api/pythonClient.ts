let cachedPort: number | null = null

class PythonSidecarHttpError extends Error {
  readonly status: number
  readonly statusText: string
  readonly body: string

  constructor(status: number, statusText: string, body: string) {
    super(`Python sidecar error: ${status} ${statusText} - ${body}`)
    this.name = 'PythonSidecarHttpError'
    this.status = status
    this.statusText = statusText
    this.body = body
  }
}

function invalidateCachedPort(): void {
  cachedPort = null
}

if (typeof window !== 'undefined' && window.synthskin?.onPythonStatus) {
  window.synthskin.onPythonStatus((event) => {
    switch (event.status) {
      case 'running':
      case 'crashed':
      case 'restarting':
      case 'failed':
      case 'stopped':
        invalidateCachedPort()
        break
    }
  })
}

async function getPort(): Promise<number> {
  if (cachedPort) return cachedPort
  cachedPort = await window.synthskin.getPythonPort()
  return cachedPort
}

// Global abort controller — replaced on every abortAll() call
let _controller = new AbortController()

/** Cancel all in-flight Python requests (call on workspace switch or unmount) */
export function abortAllPythonRequests(): void {
  _controller.abort()
  _controller = new AbortController()
  // Invalidate port cache so a restarted sidecar gets the new port
  invalidateCachedPort()
}

async function restartPythonSidecar(): Promise<number | null> {
  if (typeof window === 'undefined' || !window.synthskin?.restartPython) {
    return null
  }

  try {
    const port = await window.synthskin.restartPython()
    cachedPort = port
    return port
  } catch {
    invalidateCachedPort()
    return null
  }
}

function isMissingRouteError(error: unknown): error is PythonSidecarHttpError {
  return error instanceof PythonSidecarHttpError && error.status === 404 && /not found/i.test(error.body)
}

async function executeRequest<T = unknown>(port: number, path: string, options?: RequestInit): Promise<T> {
  // Per-request timeout: abort after 120s without affecting other requests
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), 120_000)
  // Propagate global abort to per-request controller
  const globalSignal = _controller.signal
  const onGlobalAbort = () => timeoutController.abort()
  globalSignal.addEventListener('abort', onGlobalAbort, { once: true })
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      signal: timeoutController.signal,
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new PythonSidecarHttpError(resp.status, resp.statusText, body)
    }
    return resp.json()
  } finally {
    clearTimeout(timeoutId)
    globalSignal.removeEventListener('abort', onGlobalAbort)
  }
}

async function request<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const firstPort = await getPort()
  try {
    return await executeRequest<T>(firstPort, path, options)
  } catch (error) {
    let retriedAfterRestart = false
    if (isMissingRouteError(error)) {
      retriedAfterRestart = (await restartPythonSidecar()) !== null
    }

    invalidateCachedPort()
    const nextPort = await getPort().catch(() => null)
    if (!nextPort) {
      throw error
    }

    if (!retriedAfterRestart && nextPort === firstPort) {
      throw error
    }

    // Retry on the new port — throw the second error if it also fails
    return executeRequest<T>(nextPort, path, options)
  }
}

async function openStreamResponse(
  port: number,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

function post<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export interface ExtractionResult {
  dataUrl: string
  bounds: { x: number; y: number; width: number; height: number }
  centerPoint?: { x: number; y: number }
}

export interface DetectedCircle {
  cx: number
  cy: number
  radius: number
}

export const pythonClient = {
  async health(): Promise<boolean> {
    try {
      await request('/health')
      return true
    } catch {
      return false
    }
  },

  async extractCircle(image: string, cx: number, cy: number, radius: number): Promise<ExtractionResult> {
    return post('/extract/circle', { image, cx, cy, radius })
  },

  async extractRect(
    image: string,
    x: number, y: number, width: number, height: number,
    angle = 0,
  ): Promise<ExtractionResult> {
    return post('/extract/rect', { image, x, y, width, height, angle })
  },

  async warpPerspective(
    image: string,
    srcPoints: number[][],
    dstWidth: number,
    dstHeight: number,
  ): Promise<ExtractionResult> {
    return post('/extract/warp', {
      image, src_points: srcPoints, dst_width: dstWidth, dst_height: dstHeight,
    })
  },

  async detectCircles(
    image: string,
    minRadius = 10,
    maxRadius = 200,
  ): Promise<DetectedCircle[]> {
    const res = await post<{ circles: DetectedCircle[] }>('/detect/circles', {
      image, min_radius: minRadius, max_radius: maxRadius,
    })
    return res.circles
  },

  async magicWand(
    image: string,
    seedX: number, seedY: number,
    tolerance = 32,
    feather = 0,
    expand = 0,
    contiguous = true,
    mode: 'element' | 'invert' | 'color' = 'element',
    edgeSensitivity = 1.0,
    refineEdges = true,
    fast = false,
  ): Promise<ExtractionResult> {
    return post('/extract/wand', {
      image, seed_x: seedX, seed_y: seedY,
      tolerance, feather, expand, contiguous, mode,
      edge_sensitivity: edgeSensitivity, refine_edges: refineEdges, fast,
    })
  },

  async proExtract(
    image: string,
    seedX: number, seedY: number,
    params: {
      strategy?: string
      tolerance?: number
      edgeSensitivity?: number
      feather?: number
      expand?: number
      padding?: number
      refineEdges?: boolean
      quality?: string
      returnCandidates?: boolean
    } = {},
  ): Promise<ExtractionResult & { strategy?: string; candidates?: ExtractionResult[] }> {
    return post('/extract/pro', {
      image, seed_x: seedX, seed_y: seedY,
      strategy: params.strategy ?? 'auto',
      tolerance: params.tolerance ?? 32,
      edge_sensitivity: params.edgeSensitivity ?? 1.0,
      feather: params.feather ?? 0,
      expand: params.expand ?? 0,
      padding: params.padding ?? 0,
      refine_edges: params.refineEdges ?? true,
      quality: params.quality ?? 'standard',
      return_candidates: params.returnCandidates ?? false,
    })
  },

  async extractPolygon(
    image: string,
    points: { x: number; y: number }[],
    feather = 0,
    expand = 0,
    refineEdges = true,
  ): Promise<ExtractionResult> {
    return post('/extract/polygon', {
      image,
      points: points.map((p) => [p.x, p.y]),
      feather,
      expand,
      refine_edges: refineEdges,
    })
  },

  async refineExtraction(
    image: string,
    maskDataUrl: string,
    params: {
      radius?: number
      smooth?: number
      feather?: number
      contrast?: number
      shiftEdge?: number
    } = {},
  ): Promise<ExtractionResult> {
    return post('/extract/refine', {
      image,
      mask: maskDataUrl,
      radius: params.radius ?? 3,
      smooth: params.smooth ?? 0,
      feather: params.feather ?? 0,
      contrast: params.contrast ?? 0,
      shift_edge: params.shiftEdge ?? 0,
    })
  },

  async combineMasks(
    image: string,
    maskA: string,
    maskB: string,
    mode: 'add' | 'subtract' | 'intersect' = 'add',
  ): Promise<ExtractionResult & { mode: string }> {
    return post('/extract/mask-combine', {
      image,
      mask_a: maskA,
      mask_b: maskB,
      mode,
    })
  },

  // ─── Animation API ───

  async generateFrames(params: {
    image: string
    centerX: number
    centerY: number
    startAngle: number
    endAngle: number
    frameCount: number
    outputSize: number
    mode: 'simple' | 'indicator'
    indicatorAngle?: number
    indicatorLength?: number
    indicatorWidth?: number
    indicatorColor?: [number, number, number]
  }): Promise<{ frames: string[]; count: number }> {
    return post('/animate/frames', {
      image: params.image,
      center_x: params.centerX,
      center_y: params.centerY,
      start_angle: params.startAngle,
      end_angle: params.endAngle,
      frame_count: params.frameCount,
      output_size: params.outputSize,
      mode: params.mode,
      indicator_angle: params.indicatorAngle ?? 0,
      indicator_length: params.indicatorLength ?? 40,
      indicator_width: params.indicatorWidth ?? 3,
      indicator_color: params.indicatorColor ?? [255, 255, 255],
    })
  },

  async createFilmstrip(frames: string[], orientation: 'vertical' | 'horizontal' = 'vertical'): Promise<{ dataUrl: string }> {
    return post('/animate/filmstrip', { frames, orientation })
  },

  async createSpritesheet(frames: string[], cols = 0): Promise<{
    dataUrl: string
    cols: number
    rows: number
    frameWidth: number
    frameHeight: number
  }> {
    return post('/animate/spritesheet', { frames, cols })
  },

  // ─── Meter API ───

  async generateNeedleFrames(params: {
    faceImage: string
    needleImage: string
    pivotX: number
    pivotY: number
    restAngle: number
    fullScaleAngle: number
    frameCount: number
    outputWidth: number
    outputHeight: number
    motionBlur: boolean
    motionBlurSamples: number
  }): Promise<{ frames: string[]; count: number }> {
    return post('/meter/needle', {
      face_image: params.faceImage,
      needle_image: params.needleImage,
      pivot_x: params.pivotX,
      pivot_y: params.pivotY,
      rest_angle: params.restAngle,
      full_scale_angle: params.fullScaleAngle,
      frame_count: params.frameCount,
      output_width: params.outputWidth,
      output_height: params.outputHeight,
      motion_blur: params.motionBlur,
      motion_blur_samples: params.motionBlurSamples,
    })
  },

  async generateLedBarFrames(params: {
    offImage: string
    onImage: string
    segmentCount: number
    orientation: 'vertical' | 'horizontal'
    frameCount: number
    outputWidth: number
    outputHeight: number
    gradientColors: [number, number, number][]
    gapFraction: number
  }): Promise<{ frames: string[]; count: number }> {
    return post('/meter/led', {
      off_image: params.offImage,
      on_image: params.onImage,
      segment_count: params.segmentCount,
      orientation: params.orientation,
      frame_count: params.frameCount,
      output_width: params.outputWidth,
      output_height: params.outputHeight,
      gradient_colors: params.gradientColors,
      gap_fraction: params.gapFraction,
    })
  },

  async createScreenPlaceholder(image: string, outputWidth: number, outputHeight: number): Promise<{
    dataUrl: string
    placeholder: boolean
    width: number
    height: number
  }> {
    return post('/meter/screen', { image, output_width: outputWidth, output_height: outputHeight })
  },

  // ─── Export API ───

  async renderMultiScale(image: string, baseWidth: number, baseHeight: number, scales: number[]): Promise<{
    scales: Record<string, string>
  }> {
    return post('/export/multi-scale', {
      image, base_width: baseWidth, base_height: baseHeight, scales,
    })
  },

  async svgTrace(image: string): Promise<{ svg: string | null; available: boolean }> {
    return post('/export/svg-trace', { image })
  },

  async pow2Spritesheet(frames: string[], cols = 0): Promise<{
    dataUrl: string; cols: number; rows: number
    frameWidth: number; frameHeight: number
    sheetWidth: number; sheetHeight: number
  }> {
    return post('/export/pow2-spritesheet', { frames, cols })
  },

  async buildJucePackage(params: {
    assetName: string
    assetType: string
    frames: string[]
    frameWidth: number
    frameHeight: number
    includeRetina: boolean
    includeIndividual: boolean
    includeSpritesheet: boolean
    includeSvg: boolean
    pow2Spritesheet: boolean
  }): Promise<{
    files: Record<string, { type: 'binary' | 'text'; data: string }>
    metadata: Record<string, unknown>
  }> {
    return post('/export/juce-package', {
      asset_name: params.assetName,
      asset_type: params.assetType,
      frames: params.frames,
      frame_width: params.frameWidth,
      frame_height: params.frameHeight,
      include_retina: params.includeRetina,
      include_individual: params.includeIndividual,
      include_spritesheet: params.includeSpritesheet,
      include_svg: params.includeSvg,
      pow2_spritesheet: params.pow2Spritesheet,
    })
  },

  async multiAssetSheet(assets: { name: string; image_b64: string; width: number; height: number }[], pow2 = true): Promise<{
    dataUrl: string
    atlas: Record<string, unknown>
    width: number
    height: number
  }> {
    return post('/export/multi-asset-sheet', { assets, pow2 })
  },

  // ─── Pro Features API (Phase 7) ───

  async batchDetect(image: string, options?: {
    minArea?: number
    maxArea?: number
    circleBias?: number
  }): Promise<{
    detections: BatchDetection[]
    count: number
  }> {
    return post('/detect/batch', {
      image,
      min_area: options?.minArea ?? 400,
      max_area: options?.maxArea ?? 0,
      circle_bias: options?.circleBias ?? 0.6,
    })
  },

  async colorVariant(image: string, params: {
    hueShift?: number
    saturationScale?: number
    brightnessScale?: number
    colorize?: [number, number, number]
    colorizeStrength?: number
  }): Promise<{ dataUrl: string }> {
    return post('/color/variant', {
      image,
      hue_shift: params.hueShift ?? 0,
      saturation_scale: params.saturationScale ?? 1,
      brightness_scale: params.brightnessScale ?? 1,
      colorize: params.colorize ?? null,
      colorize_strength: params.colorizeStrength ?? 0.5,
    })
  },

  async colorVariantsBatch(image: string, hueShifts: number[]): Promise<{
    variants: { dataUrl: string }[]
    count: number
  }> {
    return post('/color/variants-batch', { image, hue_shifts: hueShifts })
  },

  // ─── AI Features API (Phase 5) ───

  async aiCapabilities(): Promise<import('../../ai/types').AICapabilities> {
    return request('/ai/capabilities')
  },

  async aiGetStyles(): Promise<{ styles: import('../../ai/types').StylePreset[] }> {
    return request('/ai/styles')
  },

  async aiStyleTransfer(image: string, style: string, strength = 0.7): Promise<import('../../ai/types').StyleTransferResult> {
    return post('/ai/style-transfer', { image, style, strength })
  },

  async aiDetectComponents(image: string, options?: {
    minArea?: number; maxArea?: number; confidenceThreshold?: number
  }): Promise<{ detections: import('../../ai/types').AIDetection[]; count: number }> {
    return post('/ai/detect-components', {
      image,
      min_area: options?.minArea ?? 200,
      max_area: options?.maxArea ?? 0,
      confidence_threshold: options?.confidenceThreshold ?? 0.4,
    })
  },

  async aiEstimateLighting(image: string): Promise<import('../../ai/types').LightingEstimate> {
    return post('/ai/estimate-lighting', { image })
  },

  async aiNormalizeLighting(image: string, targetAzimuth = 315, targetElevation = 60, strength = 0.7): Promise<import('../../ai/types').LightingNormalizeResult> {
    return post('/ai/normalize-lighting', {
      image, target_azimuth: targetAzimuth, target_elevation: targetElevation, strength,
    })
  },

  async aiHarmonizeLighting(images: string[], targetAzimuth = 315, targetElevation = 60, strength = 0.7): Promise<{
    results: import('../../ai/types').LightingNormalizeResult[]; count: number
  }> {
    return post('/ai/harmonize-lighting', {
      images, target_azimuth: targetAzimuth, target_elevation: targetElevation, strength,
    })
  },

  async aiUpscale(image: string, scale: 2 | 4 = 2, sharpen = 0.4, preferAi = true): Promise<import('../../ai/types').UpscaleResult> {
    return post('/ai/upscale', { image, scale, sharpen, prefer_ai: preferAi })
  },

  async aiDetectSymmetry(image: string): Promise<import('../../ai/types').SymmetryAnalysis> {
    return post('/ai/detect-symmetry', { image })
  },

  async aiEnforceSymmetry(image: string, symmetryType = 'auto', strength = 1.0): Promise<import('../../ai/types').SymmetryResult> {
    return post('/ai/enforce-symmetry', { image, symmetry_type: symmetryType, strength })
  },

  async aiDetectText(image: string): Promise<import('../../ai/types').TextDetectionResult> {
    return post('/ai/detect-text', { image })
  },

  async aiInpaint(image: string, mask: string, method = 'telea', radius = 5): Promise<import('../../ai/types').InpaintResult> {
    return post('/ai/inpaint', { image, mask, method, radius })
  },

  async aiAutoRemoveText(image: string, method = 'telea', radius = 5): Promise<import('../../ai/types').AutoRemoveTextResult> {
    return post('/ai/auto-remove-text', { image, method, radius })
  },

  async aiRemoveBackground(image: string): Promise<import('../../ai/types').RemoveBackgroundResult> {
    return post('/ai/remove-background', { image })
  },

  async aiCenterCrop(image: string, padding = 8): Promise<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }> {
    return post('/ai/center-crop', { image, padding })
  },

  async aiGenerateComponent(prompt: string, componentType = 'knob', stylePreset = 'modern', size = 512): Promise<import('../../ai/types').GenerateComponentResult> {
    return post('/ai/generate-component', {
      prompt, component_type: componentType, style_preset: stylePreset, size,
    })
  },

  async aiGetGenerationPresets(): Promise<{ presets: import('../../ai/types').GenerationPreset[] }> {
    return request('/ai/generation-presets')
  },

  // ─── Gemma AI API ───

  async gemmaStatus(): Promise<import('../../ai/types').GemmaStatus> {
    return request('/ai/gemma/status')
  },

  async gemmaGenerate(prompt: string, image?: string, temperature = 0.7, maxTokens = 1024): Promise<{ response: string; model: string }> {
    return post('/ai/gemma/generate', { prompt, image, temperature, max_tokens: maxTokens })
  },

  async gemmaAnalyzePanel(image: string): Promise<{ analysis: import('../../ai/types').GemmaPanelAnalysis; model: string }> {
    return post('/ai/gemma/analyze-panel', { image })
  },

  async gemmaSuggestStyle(image: string, detections: any[] = []): Promise<{ suggestion: import('../../ai/types').GemmaStyleSuggestion; model: string }> {
    return post('/ai/gemma/suggest-style', { image, detections })
  },

  async gemmaNameComponent(image: string, componentType = 'knob'): Promise<{ naming: import('../../ai/types').GemmaComponentNaming; model: string }> {
    return post('/ai/gemma/name-component', { image, component_type: componentType })
  },

  async gemmaDescribeLayout(image: string): Promise<{ layout: import('../../ai/types').GemmaLayoutAnalysis; model: string }> {
    return post('/ai/gemma/describe-layout', { image })
  },

  async gemmaEnhanceDetections(image: string, detections: any[]): Promise<{ detections: any[]; count: number; model: string }> {
    return post('/ai/gemma/enhance-detections', { image, detections })
  },

  // ─── SAM2 Segmentation API ───

  async sam2Status(): Promise<import('../../ai/types').SAM2Status> {
    return request('/sam/status')
  },

  async sam2SegmentPoint(image: string, points: number[][], labels: number[], multimask = true): Promise<import('../../ai/types').SAMSegmentResult> {
    return post('/sam/segment-point', { image, points, labels, multimask })
  },

  async sam2SegmentBox(image: string, box: number[]): Promise<import('../../ai/types').SAMSegmentResult> {
    return post('/sam/segment-box', { image, box })
  },

  async sam2AutoSegment(image: string, minArea = 200): Promise<import('../../ai/types').SAMAutoSegmentResult> {
    return post('/sam/auto-segment', { image, min_area: minArea })
  },

  // ─── UI Layout Analysis ───

  async analyzeLayout(image: string, options?: {
    minConfidence?: number
    detectLabels?: boolean
    iouThreshold?: number
  }): Promise<UILayoutResult> {
    return post('/analyze/layout', {
      image,
      min_confidence: options?.minConfidence ?? 0.65,
      detect_labels: options?.detectLabels ?? false,
      iou_threshold: options?.iouThreshold ?? 0.35,
    })
  },

  async analyzeLayoutStream(
    image: string,
    options: { minConfidence?: number; detectLabels?: boolean; iouThreshold?: number },
    onProgress: (stage: string, percent: number, message: string) => void,
    onElements?: (stage: string, result: UILayoutResult) => void,
    signal?: AbortSignal,
  ): Promise<UILayoutResult> {
    const payload = {
      image,
      min_confidence: options.minConfidence ?? 0.65,
      detect_labels: options.detectLabels ?? false,
      iou_threshold: options.iouThreshold ?? 0.35,
    }

    const firstPort = await getPort()
    let resp = await openStreamResponse(firstPort, '/analyze/layout/stream', payload, signal)

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      const error = new PythonSidecarHttpError(resp.status, resp.statusText, body)

      if (isMissingRouteError(error)) {
        const restartedPort = await restartPythonSidecar()
        if (restartedPort != null) {
          resp = await openStreamResponse(restartedPort, '/analyze/layout/stream', payload, signal)
        }
      }
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new PythonSidecarHttpError(resp.status, resp.statusText, body)
    }
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE events are separated by double newlines
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const payload = JSON.parse(dataLine.slice(6))
        if (payload.type === 'progress') {
          onProgress(payload.stage, payload.percent, payload.message)
        } else if (payload.type === 'elements') {
          onElements?.(payload.stage, payload.data as UILayoutResult)
        } else if (payload.type === 'done') {
          return payload.data as UILayoutResult
        } else if (payload.type === 'error') {
          throw new Error(payload.message ?? 'Analysis failed')
        }
      }
    }
    throw new Error('SSE stream ended without result')
  },

  async detectPerspectiveCorners(image: string): Promise<PerspectiveCornersResult> {
    return post('/analyze/detect-corners', { image })
  },

  // ─── Pipeline API (Production-Grade CV) ───

  async pipelineCapabilities(): Promise<PipelineCapabilities> {
    return request('/pipeline/capabilities')
  },

  async pipelineExtract(image: string, options?: {
    perspectiveCorners?: number[][]
    outputWidth?: number
    outputHeight?: number
    detectionConfidence?: number
    componentFilter?: string[]
    circleSnapThreshold?: number
    edgeWidth?: number
    padding?: number
    includeInpainted?: boolean
    inpaintMethod?: string
    inpaintRadius?: number
  }): Promise<PipelineResult> {
    return post('/pipeline/extract', {
      image,
      perspective_corners: options?.perspectiveCorners ?? null,
      output_width: options?.outputWidth ?? null,
      output_height: options?.outputHeight ?? null,
      detection_confidence: options?.detectionConfidence ?? 0.25,
      component_filter: options?.componentFilter ?? null,
      circle_snap_threshold: options?.circleSnapThreshold ?? 0.90,
      edge_width: options?.edgeWidth ?? 2.0,
      padding: options?.padding ?? 2,
      include_inpainted: options?.includeInpainted ?? false,
      inpaint_method: options?.inpaintMethod ?? 'telea',
      inpaint_radius: options?.inpaintRadius ?? 5,
    })
  },

  async pipelineExtractSingle(image: string, box: number[], componentType = 'knob', options?: {
    perspectiveCorners?: number[][]
    circleSnapThreshold?: number
    edgeWidth?: number
    padding?: number
    includeInpainted?: boolean
    inpaintMethod?: string
    inpaintRadius?: number
  }): Promise<PipelineComponent> {
    return post('/pipeline/extract-single', {
      image,
      box,
      component_type: componentType,
      perspective_corners: options?.perspectiveCorners ?? null,
      circle_snap_threshold: options?.circleSnapThreshold ?? 0.90,
      edge_width: options?.edgeWidth ?? 2.0,
      padding: options?.padding ?? 2,
      include_inpainted: options?.includeInpainted ?? false,
      inpaint_method: options?.inpaintMethod ?? 'telea',
      inpaint_radius: options?.inpaintRadius ?? 5,
    })
  },

  // ─── Commercial-safe 3D extraction (YOLOv10 → SAM2 → Depth-Anything-V2) ───

  async extract3dCapabilities(): Promise<Extract3DCapabilities> {
    return request('/pipeline/extract-3d/capabilities')
  },

  async extract3d(image: string, boxes?: Extract3DBoxInput[]): Promise<Extract3DResult> {
    return post('/pipeline/extract-3d', { image, boxes: boxes ?? null })
  },

  /**
   * Streaming variant used by the Extract workspace so the status bar can
   * show "Generating 3D Geometry..." during the Depth + Inpaint phases.
   * The Promise resolves with the final multi-texture payload once the
   * SSE `done` event arrives.
   */
  async extract3dStream(
    image: string,
    boxes: Extract3DBoxInput[] | null | undefined,
    onProgress: (stage: string, percent: number, message: string) => void,
    signal?: AbortSignal,
  ): Promise<Extract3DResult> {
    const payload = { image, boxes: boxes ?? null }
    const firstPort = await getPort()
    let resp = await openStreamResponse(firstPort, '/pipeline/extract-3d/stream', payload, signal)
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      const err = new PythonSidecarHttpError(resp.status, resp.statusText, body)
      if (isMissingRouteError(err)) {
        const restartedPort = await restartPythonSidecar()
        if (restartedPort != null) {
          resp = await openStreamResponse(restartedPort, '/pipeline/extract-3d/stream', payload, signal)
        }
      }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new PythonSidecarHttpError(resp.status, resp.statusText, body)
    }
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const payload = JSON.parse(dataLine.slice(6))
        if (payload.type === 'progress') {
          onProgress(payload.stage, payload.percent, payload.message)
        } else if (payload.type === 'done') {
          return payload.data as Extract3DResult
        } else if (payload.type === 'error') {
          throw new Error(payload.message ?? '3D extraction failed')
        }
      }
    }
    throw new Error('SSE stream ended without result')
  },

  async normalFromDepth(depth: string, strength = 2.0): Promise<{ dataUrl: string }> {
    return post('/pipeline/normal-from-depth', { depth, strength })
  },

  async pipelinePerspectiveCorrect(image: string, corners: number[][], outputWidth?: number, outputHeight?: number): Promise<ExtractionResult> {
    return post('/pipeline/perspective-correct', {
      image,
      corners,
      output_width: outputWidth ?? null,
      output_height: outputHeight ?? null,
    })
  },

  async pipelineInpaintBackground(image: string, mask: string, method = 'telea', radius = 5): Promise<{ dataUrl: string }> {
    return post('/pipeline/inpaint-background', { image, mask, method, radius })
  },

  // ─── Semantic Panel Pipeline (Gemini + YOLO + OpenCV + optional OCR) ───

  async panelCapabilities(): Promise<PanelPipelineCapabilities> {
    return request('/panel/capabilities')
  },

  /** Release cached AI models to free VRAM/RAM. Call when closing the analysis window. */
  async panelClearModels(): Promise<{ freed: string[]; count: number }> {
    return post('/panel/clear-models', {})
  },

  /** Save a Gemini API key and activate it immediately. */
  async panelSetGeminiKey(key: string): Promise<{ ok: boolean; gemini_key_set: boolean; capabilities: PanelPipelineCapabilities }> {
    return post('/panel/set-gemini-key', { key })
  },

  /** Legacy maintenance endpoint for old Florence-2 cache/sentinel state. */
  async panelResetFlorence(): Promise<{ ok: boolean; sentinel_removed: boolean }> {
    return post('/panel/reset-florence', {})
  },

  /** Check if a Gemini API key is currently configured. */
  async panelGeminiKeyStatus(): Promise<{ gemini_key_set: boolean }> {
    return request('/panel/gemini-key-status')
  },

  /** Re-run segmentation on a single edited bbox. Returns a PNG-data-url mask. */
  async panelResegment(
    image: string,
    bbox: [number, number, number, number],
    fastMode: boolean = true,
  ): Promise<{ mask_png: string | null; mask_bbox?: [number, number, number, number] | null; refined_bbox?: [number, number, number, number]; circle?: { cx: number; cy: number; radius: number } | null }> {
    return post('/panel/resegment', { image, bbox, fast_mode: fastMode })
  },

  /** Build the single versioned export contract (layout.json v1) from controls. */
  async exportLayoutManifest(
    controls: PanelControl[],
    imageWidth: number,
    imageHeight: number,
    opts?: { rectified?: boolean; sourceHash?: string; filesById?: Record<string, Record<string, string>>; scalesById?: Record<string, number[]>; includeSemantics?: boolean; includeShapes?: boolean; includeInteraction?: boolean },
  ): Promise<LayoutManifest> {
    return post('/export/layout-manifest', {
      controls,
      image_width: imageWidth,
      image_height: imageHeight,
      rectified: opts?.rectified ?? false,
      source_hash: opts?.sourceHash,
      files_by_id: opts?.filesById,
      scales_by_id: opts?.scalesById,
      include_semantics: opts?.includeSemantics ?? true,
      include_shapes: opts?.includeShapes ?? true,
      include_interaction: opts?.includeInteraction ?? true,
    })
  },

  /** Produce background_punched (RGBA holes) + background_filled + per-asset crops. */
  async exportPunchTriple(
    image: string,
    controls: PanelControl[],
    opts?: { dilatePx?: number; featherPx?: number; fillMethod?: 'telea' | 'ns' | 'poisson'; includeCrops?: boolean; excludeTypes?: string[]; dehalo?: boolean },
  ): Promise<PunchTripleResult> {
    return post('/export/punch-triple', {
      image,
      controls,
      dilate_px: opts?.dilatePx ?? 2,
      feather_px: opts?.featherPx ?? 1,
      fill_method: opts?.fillMethod ?? 'telea',
      include_crops: opts?.includeCrops ?? true,
      exclude_types: opts?.excludeTypes,
      dehalo: opts?.dehalo ?? true,
    })
  },

  async analyzePanel(image: string, options?: {
    minConfidence?: number
    detectLabels?: boolean
    segment?: boolean
    extractFeatures?: boolean
    fastMode?: boolean
    detectionModel?: string
  }): Promise<PanelLayoutResult> {
    return post('/panel/analyze', {
      image,
      min_confidence: options?.minConfidence ?? 0.40,
      detect_labels: options?.detectLabels ?? false,
      segment: options?.segment ?? true,
      extract_features: options?.extractFeatures ?? true,
      fast_mode: options?.fastMode ?? false,
      detection_model: options?.detectionModel ?? 'auto',
    })
  },

  async analyzePanelStream(
    image: string,
    options: { minConfidence?: number; detectLabels?: boolean; segment?: boolean; extractFeatures?: boolean; fastMode?: boolean; detectionModel?: string },
    onProgress: (stage: string, percent: number, message: string) => void,
    signal?: AbortSignal,
  ): Promise<PanelLayoutResult> {
    const t0 = performance.now()
    console.log('[PythonClient] analyzePanelStream: request started')
    const payload = {
      image,
      min_confidence: options.minConfidence ?? 0.40,
      detect_labels: options.detectLabels ?? false,
      segment: options.segment ?? true,
      extract_features: options.extractFeatures ?? true,
      fast_mode: options.fastMode ?? false,
      detection_model: options.detectionModel ?? 'auto',
    }
    const firstPort = await getPort()
    console.log(`[PythonClient] analyzePanelStream: sending to port ${firstPort} (+${(performance.now()-t0).toFixed(0)}ms)`)
    let resp = await openStreamResponse(firstPort, '/panel/analyze/stream', payload, signal)
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      const error = new PythonSidecarHttpError(resp.status, resp.statusText, body)
      if (isMissingRouteError(error)) {
        const restartedPort = await restartPythonSidecar()
        if (restartedPort != null) {
          resp = await openStreamResponse(restartedPort, '/panel/analyze/stream', payload, signal)
        }
      }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new PythonSidecarHttpError(resp.status, resp.statusText, body)
    }
    console.log(`[PythonClient] analyzePanelStream: SSE stream open (+${(performance.now()-t0).toFixed(0)}ms)`)
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const payload = JSON.parse(dataLine.slice(6))
        if (payload.type === 'progress') {
          console.log(`[PythonClient] progress: ${payload.stage} ${payload.percent}% (+${(performance.now()-t0).toFixed(0)}ms)`)
          onProgress(payload.stage, payload.percent, payload.message)
        } else if (payload.type === 'done') {
          console.log(`[PythonClient] analyzePanelStream: DONE in ${(performance.now()-t0).toFixed(0)}ms`)
          return payload.data as PanelLayoutResult
        } else if (payload.type === 'error') {
          console.error(`[PythonClient] analyzePanelStream: ERROR after ${(performance.now()-t0).toFixed(0)}ms: ${payload.message}`)
          throw new Error(payload.message ?? 'Panel analysis failed')
        }
      }
    }
    throw new Error('SSE stream ended without result')
  },

  /** Cluster repeated controls by visual similarity and find all instance positions via NCC template matching. */
  async panelDeduplicate(
    image: string,
    controls: PanelControl[],
    opts?: {
      sizeThr?: number
      histThr?: number
      matchScoreThr?: number
      minClusterSize?: number
      runTemplateMatch?: boolean
    },
  ): Promise<PanelDedupResult> {
    return post('/panel/deduplicate', {
      image,
      controls,
      size_thr:          opts?.sizeThr         ?? 0.60,
      hist_thr:          opts?.histThr          ?? 0.60,
      match_score_thr:   opts?.matchScoreThr    ?? 0.72,
      min_cluster_size:  opts?.minClusterSize   ?? 2,
      run_template_match: opts?.runTemplateMatch ?? true,
    })
  },

  /** Detect the current visual state of each control (knob angle, slider position, meter needle). */
  async panelDetectStates(
    image: string,
    controls: PanelControl[],
  ): Promise<PanelDetectStatesResult> {
    return post('/panel/detect-states', { image, controls })
  },

  async exportSpriteStrip(opts: {
    cropPng: string
    frames?: number
    currentAngleDeg?: number
    minAngleDeg?: number
    maxAngleDeg?: number
    cxNorm?: number | null
    cyNorm?: number | null
    outputSize?: number | null
  }): Promise<SpriteStripResult> {
    return post('/export/sprite-strip', {
      crop_png: opts.cropPng,
      frames: opts.frames ?? 100,
      current_angle_deg: opts.currentAngleDeg ?? 0,
      min_angle_deg: opts.minAngleDeg ?? -135,
      max_angle_deg: opts.maxAngleDeg ?? 135,
      cx_norm: opts.cxNorm ?? null,
      cy_norm: opts.cyNorm ?? null,
      output_size: opts.outputSize ?? null,
    })
  },

  async trainingCorpusStatus(): Promise<TrainingCorpusStatus> {
    return request('/training/corpus/status')
  },

  async trainingCorpusSave(payload: {
    image: string
    imageWidth: number
    imageHeight: number
    layout: PanelLayoutResult
    sourceName?: string | null
    sourcePath?: string | null
    split?: 'auto' | 'train' | 'val'
    includeTextLabels?: boolean
    notes?: string | null
  }): Promise<TrainingCorpusSaveResult> {
    return post('/training/corpus/save', {
      image: payload.image,
      image_width: payload.imageWidth,
      image_height: payload.imageHeight,
      layout: payload.layout,
      source_name: payload.sourceName ?? null,
      source_path: payload.sourcePath ?? null,
      split: payload.split ?? 'auto',
      include_text_labels: payload.includeTextLabels ?? true,
      notes: payload.notes ?? null,
    })
  },

  async trainingPreflight(options?: {
    minTrain?: number
    minVal?: number
    requireBoxes?: boolean
  }): Promise<TrainingPreflightResult> {
    return post('/training/preflight', {
      min_train: options?.minTrain ?? 50,
      min_val: options?.minVal ?? 10,
      require_boxes: options?.requireBoxes ?? true,
    })
  },

  async trainingRun(options?: TrainingRunOptions): Promise<TrainingRunStatus> {
    return post('/training/run', {
      base: options?.base ?? 'yolo11m.pt',
      epochs: options?.epochs ?? 120,
      imgsz: options?.imgsz ?? 1280,
      batch: options?.batch ?? 8,
      device: options?.device ?? null,
      min_train: options?.minTrain ?? 50,
      min_val: options?.minVal ?? 10,
      workers: options?.workers ?? 4,
      cache: options?.cache ?? 'false',
      name: options?.name ?? 'synthskin_panel_detector',
      // Optimizer / schedule
      optimizer: options?.optimizer ?? 'auto',
      lr0: options?.lr0 ?? 0.01,
      lrf: options?.lrf ?? 0.01,
      momentum: options?.momentum ?? 0.937,
      weight_decay: options?.weightDecay ?? 0.0005,
      warmup_epochs: options?.warmupEpochs ?? 3.0,
      patience: options?.patience ?? 30,
      cos_lr: options?.cosLr ?? true,
      close_mosaic: options?.closeMosaic ?? 10,
      // Loss weights
      box: options?.box ?? 7.5,
      cls: options?.cls ?? 0.5,
      dfl: options?.dfl ?? 1.5,
      // Augmentation
      hsv_h: options?.hsvH ?? 0.015,
      hsv_s: options?.hsvS ?? 0.7,
      hsv_v: options?.hsvV ?? 0.4,
      degrees: options?.degrees ?? 2.0,
      translate: options?.translate ?? 0.04,
      scale: options?.scale ?? 0.25,
      shear: options?.shear ?? 0.0,
      perspective: options?.perspective ?? 0.0,
      flipud: options?.flipud ?? 0.0,
      fliplr: options?.fliplr ?? 0.0,
      mosaic: options?.mosaic ?? 0.35,
      mixup: options?.mixup ?? 0.05,
      copy_paste: options?.copyPaste ?? 0.0,
      erasing: options?.erasing ?? 0.4,
      // Hardware / model
      amp: options?.amp ?? true,
      rect: options?.rect ?? false,
      single_cls: options?.singleCls ?? false,
      freeze: options?.freeze ?? null,
      resume: options?.resume ?? false,
      seed: options?.seed ?? 0,
    })
  },

  async trainingRunStatus(): Promise<TrainingRunStatus> {
    return request('/training/run/status')
  },

  async trainingRunStop(): Promise<TrainingRunStatus> {
    return post('/training/run/stop', {})
  },

  async trainingRunMetrics(name?: string): Promise<TrainingMetricsResult> {
    const qs = name ? `?name=${encodeURIComponent(name)}` : ''
    return request(`/training/run/metrics${qs}`)
  },

  async trainingRunsList(): Promise<TrainingRunsListResult> {
    return request('/training/runs/list')
  },

  async trainingRunArtifacts(name: string): Promise<TrainingArtifactsResult> {
    return request(`/training/run/artifacts?name=${encodeURIComponent(name)}`)
  },

  trainingRunArtifactUrl(relPath: string): Promise<string> {
    return getPort().then((port) => `http://127.0.0.1:${port}/training/run/artifact?rel_path=${encodeURIComponent(relPath)}`)
  },

  async trainingPromote(name: string): Promise<TrainingPromoteResult> {
    return post('/training/promote', { name })
  },
}

export interface BatchDetection {
  id: string
  type: 'circle' | 'rect'
  bounds: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
  radius?: number
  confidence: number
  preview: string
  suggestedType: string
}

/**
 * Geometric shape of a detected UI element.
 * - circle: perfectly round (knob, button, LED) — use shapeData.cx/cy/radius
 * - ellipse: oval — use shapeData.cx/cy/rx/ry/angle
 * - rotated_rect: axis-non-aligned rectangle (angled slider) — use shapeData.cx/cy/w/h/angle
 * - rect: standard axis-aligned bounding rectangle — use bounds
 */
export type UIElementShape = 'circle' | 'ellipse' | 'rotated_rect' | 'rect'

export interface UIElementShapeData {
  cx: number
  cy: number
  // circle / ellipse
  radius?: number   // circle only
  rx?: number       // ellipse semi-axis x
  ry?: number       // ellipse semi-axis y
  // rect / rotated_rect / ellipse
  w?: number
  h?: number
  angle?: number    // degrees; 0 = upright
}

export interface UILayoutElement {
  id: string
  type: 'knob' | 'button' | 'slider' | 'display' | 'label' | 'panel' | 'led' | 'text_field' | string
  sub_type: string
  label: string | null
  bounds: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
  radius: number | null
  confidence: number
  normalizedBounds: { x: number; y: number; width: number; height: number }
  normalizedCenter: { x: number; y: number }
  /** Fitted geometric primitive — more accurate than the bounding box */
  shape: UIElementShape
  /** Geometry parameters for the fitted shape */
  shapeData: UIElementShapeData
}

export interface LayoutAnalysisProgress {
  type: 'progress'
  stage: string
  percent: number
  message: string
}

export interface LayoutAnalysisElementsSnapshot {
  type: 'elements'
  stage: string
  data: UILayoutResult
}

export interface PerspectiveCornersResult {
  corners: [number, number][]  // [TL, TR, BR, BL]
  imageWidth: number
  imageHeight: number
  detected: boolean
}

export interface UILayoutResult {
  imageWidth: number
  imageHeight: number
  timestamp: string
  elementCount: number
  elements: UILayoutElement[]
}

// ─── Pipeline Types (Production-Grade CV) ───

export interface PipelineCapabilities {
  pipeline_available: boolean
  yolo_detection: boolean
  sam2_segmentation: boolean
  sam2_status: import('../../ai/types').SAM2Status
  perspective_correction: boolean
  mask_refinement: boolean
  geometric_fitting: boolean
  knob_physics: boolean
  slider_rail_detection: boolean
  antialiased_output: boolean
  background_inpainting: boolean
  heuristic_fallback: boolean
}

export interface KnobPhysics {
  center: { x: number; y: number }
  radius: number
  has_pointer: boolean
  pointer_angle: number | null
  start_angle: number
  end_angle: number
}

export interface SliderPhysics {
  orientation: 'vertical' | 'horizontal'
  rail_start: { x: number; y: number }
  rail_end: { x: number; y: number }
  travel_px: number
  rail_angle: number
}

export interface PipelineComponent {
  type: string
  confidence?: number
  detection_method?: string
  bounds: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
  dataUrl: string
  mask_dataUrl: string
  physics: KnobPhysics | SliderPhysics | Record<string, never>
  stages?: string[]
  inpainted_background?: string
}

export interface PipelineResult {
  components: PipelineComponent[]
  count: number
  detection_method: string
  perspective_corrected: boolean
  inpainted_background?: string
  metadata: {
    image_width: number
    image_height: number
    pipeline_stages: string[]
    elapsed_ms: number
  }
}

// ─── Semantic Panel Pipeline Types ───────────────────────────────────────────

export type PanelControlType =
  | 'knob' | 'slider' | 'switch' | 'button' | 'led' | 'screen' | 'label'
  | 'slider_cap' | 'slider_track' | 'led_light' | 'led_screen'
  | 'meter' | 'meter_screen' | 'meter_needle' | 'meter_range' | 'text'

export interface PanelKnobFeatures {
  pointer_angle_deg: number
  min_angle_deg: number
  max_angle_deg: number
  value_normalized: number
}

export interface PanelSliderFeatures {
  orientation: 'vertical' | 'horizontal'
  travel_length_px: number
  fader_position_px: number
  value_normalized: number
  /** Bounding box of the fader cap/thumb in image pixels [x1,y1,x2,y2] */
  cap_bbox?: [number, number, number, number]
}

export interface PanelScreenFeatures {
  screen_kind: 'oscilloscope' | 'vu_meter' | 'digital_readout' | string
  edge_density: number
  mean_brightness: number
  mean_hue: number
}

export interface PanelControl {
  id: string
  type: PanelControlType
  sub_type: string
  bbox: [number, number, number, number]
  refined_bbox?: [number, number, number, number]
  width: number
  height: number
  center: [number, number]
  confidence: number
  source: 'florence2' | 'yolo' | 'heuristic' | string
  phrase: string | null
  mask_png: string | null
  /** Bounding box for mask_png when the backend sends a cropped mask. If absent,
   *  mask_png is treated as a full-image mask for backwards compatibility. */
  mask_bbox?: [number, number, number, number] | null
  circle?: { cx: number; cy: number; radius: number }
  /** Simplified contour polygon as [[x,y],...] in image pixels. Present when
   *  mask segmentation is available, enables accurate freeform outline rendering. */
  contour_polygon?: [number, number][]
  features?: PanelKnobFeatures | PanelSliderFeatures | PanelScreenFeatures
  label?: { id: string; text: string; confidence: number } | null
  parameter_id: string
  display_name: string
  /** Who last owned this control. 'ai' = produced/updated by analysis; 'user' =
   *  the human corrected it. Re-analysis must NOT clobber 'user' controls. */
  provenance?: 'ai' | 'user'
  /** True when mask_png alpha was edge-refined (guided filter) by the backend. */
  edges_refined?: boolean
}

export interface PanelLabel {
  id: string
  text: string
  bbox: [number, number, number, number]
  center: [number, number]
  confidence: number
  linked_control_id?: string
  _is_section?: boolean
  _is_scale_mark?: boolean
  _linked_as_readout?: boolean
}

export interface PanelSection {
  id: string
  name: string
  raw_name: string
  header_label_id: string | null
  bbox: [number, number, number, number]
  control_ids: string[]
  label_ids: string[]
}

export interface PanelPipelineCapabilities {
  florence2: boolean
  florence2_blocked_by?: string   // transformers version that broke Florence-2, if sentinel exists
  yolo: boolean
  /** True only when python/models/synthskin_yolo.pt or ui_components_yolo.pt exists. */
  custom_yolo?: boolean
  /** Selected YOLO weight filename, e.g. synthskin_yolo.pt or yolo11n.pt. */
  yolo_weight?: string | null
  /** custom | generic | package-default | none */
  yolo_weight_kind?: string
  /** True when the local detector is trained specifically for SynthSkin panel controls. */
  professional_detector_ready?: boolean
  /** Human-readable setup hint when only generic YOLO/OpenCV fallback is available. */
  detector_recommendation?: string | null
  sam2: boolean
  rapidocr: boolean
  gemma4: boolean
  gemma4_backend?: string   // e.g. "ollama/gemma4:latest" | "gemini/gemini-2.0-flash" | "hf/..."
  gemini_key_set: boolean
  /** True when a live Gemini API probe succeeded (not just key set). */
  gemini_probe_ok?: boolean
  /** True while a key exists but the initial background probe has not finished yet. */
  gemini_probe_pending?: boolean
  /** Human-readable Gemini probe failure reason when the key exists but Gemini is unusable. */
  gemini_probe_error?: string | null
  /** The Gemini model that answered the probe, e.g. "gemini-2.0-flash-lite" */
  gemini_active_model?: string | null
  device: string
}

export interface PanelLayoutResult {
  imageWidth: number
  imageHeight: number
  timestamp: string
  capabilities: PanelPipelineCapabilities
  controlCount: number
  labelCount: number
  sectionCount: number
  controls: PanelControl[]
  labels: PanelLabel[]
  sections: PanelSection[]
  /** Which model the caller requested (e.g. "auto", "gemini", "yolo") */
  detection_model_requested?: string
  /** Which model actually produced the surviving detections ("gemini", "yolo+cv", "cv") */
  detection_model_used?: string
  /** Raw source tags from each surviving detection (e.g. ["yolo", "heuristic"]) */
  detection_sources?: string[]
  /** Stage-0 dewarp outcome. When applied, controls/masks are in RECTIFIED
   *  space and image_b64 holds the rectified pixels to adopt as the document. */
  rectification?: {
    applied: boolean
    reason: string
    image_b64?: string
    out_size?: [number, number] | null
    skew_deg?: number
    tilt_deg?: number
  }
}

// ─── Deduplication Types ─────────────────────────────────────────────────────

export interface PanelDedupInstance {
  id: string
  bbox: [number, number, number, number]
  /** 'detector' = found by the original detector; 'template_match' = found by NCC */
  source: 'detector' | 'template_match'
}

export interface PanelDedupGroup {
  canonical_id: string
  canonical_bbox: [number, number, number, number]
  instances: PanelDedupInstance[]
  member_ids: string[]
  type: string
  template_match_count: number
}

export interface PanelDedupResult {
  groups: PanelDedupGroup[]
  /** IDs of controls that should be kept (one per visual template). */
  canonical_ids: string[]
  /** IDs of controls that are identical to a canonical — safe to remove. */
  removed_ids: string[]
  /** How many fewer asset exports are needed after deduplication. */
  total_saved: number
}

// ─── State Detection Types ────────────────────────────────────────────────────

export interface KnobState {
  type: 'knob'
  angle_deg: number
  value_normalized: number
  method: string
  error?: null
}

export interface SliderState {
  type: 'slider' | 'slider_cap' | 'fader'
  orientation: 'vertical' | 'horizontal'
  cap_center_px: number
  travel_px: number
  value_normalized: number
  method: string
  error?: null
}

export interface MeterState {
  type: 'meter' | 'screen' | 'meter_screen'
  angle_deg: number
  value_normalized: number
  method: string
  error?: null
}

export interface ControlStateError {
  type: string
  error: string
}

export type ControlState = KnobState | SliderState | MeterState | ControlStateError

export interface PanelDetectStatesResult {
  states: Record<string, ControlState>
  detected: number
  skipped: number
}

export interface SpriteStripResult {
  /** Vertical filmstrip PNG (frame 0 = min angle, frame N-1 = max angle). */
  strip_png: string
  frames: number
  frame_width: number
  frame_height: number
}

/** A control's silhouette described as the simplest parametric primitive. */
export interface FittedShape {
  kind: 'circle' | 'ellipse' | 'rect' | 'rounded_rect' | 'polygon'
  // params are kind-specific (abs image coords): circle {cx,cy,r};
  // ellipse {cx,cy,rx,ry,angle_deg}; rect {x,y,w,h}; rounded_rect {..,r};
  // polygon {points:[x,y][]}.
  params: Record<string, number | number[][]>
  svg_path: string
  iou: number
  point_count?: number
}

/** Default interaction physics (damped oscillator) by control type — advisory. */
export interface InteractionPreset {
  model: 'spring'
  source: 'type-default'
  affordance: 'rotate' | 'drag' | 'press' | 'toggle' | 'indicate' | 'value' | 'display'
  axis?: 'x' | 'y' | 'rotate' | null
  spring?: { stiffness: number; damping: number; mass: number }
  hover?: { scale: number } | null
  tap?: { scale: number } | null
  states?: Record<string, { opacity: number }>
  css?: string | null
}

/** layout.json v1 — the single machine-readable export contract. */
export interface LayoutManifestAsset {
  id: string
  type: string
  parameter_id?: string
  display_name?: string
  provenance?: 'ai' | 'user'
  rect: [number, number, number, number]   // [x, y, w, h] in original-image coords
  pivot: [number, number]
  angle?: { min_deg?: number; max_deg?: number; default_deg?: number; value_normalized?: number }
  label?: string
  scales?: number[]
  files?: Record<string, string>
  hash?: string
  shape?: FittedShape
  interaction?: InteractionPreset
  /** Identical positions of this control found by deduplication (one asset, N panel positions). */
  instances?: Array<{ id: string; bbox: [number, number, number, number]; source: 'detector' | 'template_match' }>
  /** For sliders/faders: travel axis and pixel length from feature extraction. */
  travel?: { orientation: 'vertical' | 'horizontal'; length_px: number }
  /** Detected position/angle at time of panel analysis (from panelDetectStates). */
  detected_state?: { value_normalized: number; angle_deg?: number }
  /** JUCE-compatible vertical sprite filmstrip for knobs (100 frames, min→max). */
  sprite_strip?: { path: string; frames: number; frame_width: number; frame_height: number }
}
/** A CSS-flavoured layout rule inferred for one container node. */
export interface LayoutHint {
  display: 'flex' | 'grid' | 'block'
  direction?: 'row' | 'column'
  gap?: number | null
  align_items?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  justify_content?: 'flex-start' | 'center' | 'space-between'
  rows?: number
  cols?: number
  row_gap?: number | null
  col_gap?: number | null
  arrangement?: 'free'
}

/** A node in the inferred containment/nesting tree (the logical DOM). */
export interface LayoutNode {
  id: string
  type: string | null
  rect: [number, number, number, number]
  layout?: LayoutHint
  children?: LayoutNode[]
}

export interface AlignmentGuide {
  axis: 'x' | 'y'
  kind: 'left' | 'right' | 'center_x' | 'top' | 'bottom' | 'middle_y'
  position: number
  members: string[]
}

/** synthskin.semantics/v1 — inferred logical layout attached to the manifest. */
export interface LayoutSemantics {
  schema: string
  tolerance_px: number
  node_count: number
  tree: LayoutNode
  parent_of: Record<string, string | null>
  depth: Record<string, { parent: string | null; depth: number }>
  alignment_guides: AlignmentGuide[]
}

export interface LayoutManifest {
  schema: string
  generator: string
  created: string
  source: { width: number; height: number; rectified: boolean; hash?: string }
  asset_count: number
  assets: LayoutManifestAsset[]
  semantics?: LayoutSemantics
}

/** Result of /export/punch-triple. */
export interface PunchTripleResult {
  width: number
  height: number
  dilate_px: number
  feather_px: number
  fill_method: string
  background_punched: string   // RGBA data-URL (holes where controls are)
  background_filled: string    // inpainted plate data-URL
  union_coverage: number
  crops?: { id: string; type: string; parameter_id?: string; bbox: [number, number, number, number]; png: string }[]
  crop_count?: number
}

export interface TrainingCorpusStatus {
  corpus_root: string
  uploads_dir: string
  samples_dir: string
  reports_dir: string
  dataset_root: string
  dataset_yaml: string
  class_names: string[]
  sample_count: number
  split_counts: Record<string, number>
  class_counts: Record<string, number>
  last_sample_id?: string | null
  updated_at?: string | null
  ready_for_training: boolean
  dataset: {
    root: string
    splits: Record<string, {
      name: string
      images: number
      label_files: number
      annotated_images: number
      empty_label_files: number
      missing_label_files: number
      orphan_label_files: number
      boxes: number
      class_counts: Record<string, number>
      issues: Array<{ severity: string; path: string; message: string }>
    }>
  }
}

export interface TrainingCorpusSaveResult {
  sample_id: string
  split: 'train' | 'val'
  source_name?: string | null
  source_path?: string | null
  notes?: string | null
  image_width: number
  image_height: number
  dataset_image: string
  dataset_label: string
  analysis_path: string
  classes: Record<string, number>
  annotation_count: number
  corpus_root: string
  uploads_dir: string
  summary: {
    updated_at?: string | null
    sample_count: number
    split_counts: Record<string, number>
    class_counts: Record<string, number>
    last_sample_id?: string | null
  }
}

export interface TrainingPreflightResult {
  ok: boolean
  summary: string
  report_text_path: string
  report_json_path: string
  stats: Record<string, unknown>
}

export interface TrainingRunStatus {
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'completed' | 'failed'
  running: boolean
  started_at?: number | null
  finished_at?: number | null
  exit_code?: number | null
  command: string[]
  lines: string[]
}

export interface TrainingRunOptions {
  base?: string
  epochs?: number
  imgsz?: number
  batch?: number
  device?: string
  minTrain?: number
  minVal?: number
  workers?: number
  cache?: 'false' | 'true' | 'ram' | 'disk'
  name?: string
  optimizer?: 'auto' | 'SGD' | 'Adam' | 'AdamW' | 'NAdam' | 'RAdam' | 'RMSProp'
  lr0?: number
  lrf?: number
  momentum?: number
  weightDecay?: number
  warmupEpochs?: number
  patience?: number
  cosLr?: boolean
  closeMosaic?: number
  box?: number
  cls?: number
  dfl?: number
  hsvH?: number
  hsvS?: number
  hsvV?: number
  degrees?: number
  translate?: number
  scale?: number
  shear?: number
  perspective?: number
  flipud?: number
  fliplr?: number
  mosaic?: number
  mixup?: number
  copyPaste?: number
  erasing?: number
  amp?: boolean
  rect?: boolean
  singleCls?: boolean
  freeze?: number | null
  resume?: boolean
  seed?: number
}

export interface TrainingMetricsRow {
  epoch?: number
  'train/box_loss'?: number
  'train/cls_loss'?: number
  'train/dfl_loss'?: number
  'val/box_loss'?: number
  'val/cls_loss'?: number
  'val/dfl_loss'?: number
  'metrics/precision(B)'?: number
  'metrics/recall(B)'?: number
  'metrics/mAP50(B)'?: number
  'metrics/mAP50-95(B)'?: number
  'lr/pg0'?: number
  'lr/pg1'?: number
  'lr/pg2'?: number
  time?: number
  [key: string]: number | undefined
}

export interface TrainingRunSummary {
  name: string
  path: string
  modified: number
  epochs_logged: number
  best_pt?: string | null
  last_pt?: string | null
  args_yaml?: string | null
  last_metrics: {
    epoch?: number | null
    mAP50?: number | null
    mAP50_95?: number | null
    precision?: number | null
    recall?: number | null
    train_box_loss?: number | null
    val_box_loss?: number | null
    lr?: number | null
  }
}

export interface TrainingMetricsResult {
  name: string | null
  rows: TrainingMetricsRow[]
  summary: TrainingRunSummary | null
}

export interface TrainingRunsListResult {
  runs: TrainingRunSummary[]
  project_dir: string
  production_weights: string | null
}

export interface TrainingArtifactItem {
  name: string
  rel_path: string
  size: number
}

export interface TrainingArtifactsResult {
  name: string
  artifacts: TrainingArtifactItem[]
}

export interface TrainingPromoteResult {
  ok: boolean
  promoted_from: string
  production_weights: string
  size: number
}

// ─── Commercial-safe 3D extraction types ─────────────────────────────────────

export interface Extract3DCapabilities {
  yolov10_clean_load: boolean
  yolov10_inference_enabled: boolean
  depth_anything_v2: boolean
  sam2: boolean
  cv2_inpaint: boolean
  hf_cache: string
}

export interface Extract3DBoxInput {
  x: number
  y: number
  width: number
  height: number
  detected_type?: string
}

export interface Extract3DComponent {
  detected_type: string
  confidence: number
  bounds: { x: number; y: number; width: number; height: number }
  diffuse_dataUrl: string
  normal_dataUrl: string
  depth_dataUrl: string
  alpha_dataUrl: string
  source: string
}

export interface Extract3DResult {
  components: Extract3DComponent[]
  inpainted_background_dataUrl: string
  elapsed_ms: number
  notes: string[]
}


