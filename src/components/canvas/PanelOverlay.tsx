/**
 * PanelOverlay — renders the SAM2 masks + bboxes + text-label overlays
 * on top of the source image. Used inside LayoutAnalyzer (semantic mode).
 *
 * Coloring: per-type, with a distinct palette that keeps knobs vs screens
 * vs text visually separated (unlike the old single-yellow circle).
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { usePanelLayoutStore, type Bbox, type PanelControlType } from '../../stores/panelLayoutStore'
import type { PanelControl, PanelLabel, PanelSliderFeatures } from '../../lib/api/pythonClient'
import BboxEditor from './BboxEditor'
import { PANEL_CONTROL_TYPES, panelTypeColor } from './panelTrainingTypes'

const typeColor = (t: string) => panelTypeColor(t)

function ControlMask({
  control, scaleX, scaleY, selected, highlighted,
}: {
  control: PanelControl
  scaleX: number
  scaleY: number
  selected: boolean
  highlighted: boolean
}) {
  const color = typeColor(control.type)
  const bb = control.refined_bbox ?? control.bbox
  const x = bb[0] * scaleX
  const y = bb[1] * scaleY
  const w = (bb[2] - bb[0]) * scaleX
  const h = (bb[3] - bb[1]) * scaleY

  const opacity = selected ? 1.0 : highlighted ? 0.85 : 0.65
  const strokeW = selected ? 2.5 : highlighted ? 2.0 : 1.2

  // Build outline shape: prefer contour polygon, then circle, then bbox rect
  const hasCircle = !!(control.circle && (
    control.type === 'knob' || control.type === 'led' || control.type === 'screen'
  ))
  const polygon = control.contour_polygon
  const usePolygon = polygon && polygon.length >= 3 && !hasCircle

  // Slider cap bbox
  const sliderFeatures = control.type === 'slider'
    ? (control.features as PanelSliderFeatures | undefined)
    : undefined
  const capBbox = sliderFeatures?.cap_bbox

  return (
    <g opacity={opacity}>
      {/* Freeform polygon outline when contour is available and non-circular */}
      {usePolygon ? (
        <polygon
          points={polygon.map(([px, py]) => `${px * scaleX},${py * scaleY}`).join(' ')}
          fill={color}
          fillOpacity={selected ? 0.12 : 0.04}
          stroke={color}
          strokeWidth={strokeW}
          strokeDasharray={selected ? '5 3' : '3 2'}
          className={selected ? 'ss-marching-ants' : undefined}
          strokeLinejoin="round"
        />
      ) : (
        /* Fall-back to bbox rect (hidden when circle covers it) */
        !hasCircle && (
          <rect
            x={x} y={y} width={w} height={h}
            fill={color}
            fillOpacity={selected ? 0.12 : 0.04}
            stroke={color}
            strokeWidth={strokeW}
            strokeDasharray={selected ? '5 3' : '3 2'}
            className={selected ? 'ss-marching-ants' : undefined}
            rx={control.type === 'screen' ? 2 : control.type === 'knob' || control.type === 'led' ? Math.min(w, h) / 2 : 1}
          />
        )
      )}

      {/* Circle overlay for knobs, LEDs, and circular screens */}
      {control.circle && (control.type === 'knob' || control.type === 'led' || control.type === 'screen') && (
        <circle
          cx={control.circle.cx * scaleX}
          cy={control.circle.cy * scaleY}
          r={control.circle.radius * (scaleX + scaleY) / 2}
          fill={color}
          fillOpacity={selected ? 0.12 : 0.04}
          stroke={color}
          strokeWidth={strokeW}
          strokeDasharray={selected ? '5 3' : undefined}
          className={selected ? 'ss-marching-ants' : undefined}
          opacity={0.9}
        />
      )}

      {/* Pointer tick for knobs */}
      {control.circle && control.type === 'knob' && control.features && 'pointer_angle_deg' in control.features && (
        <PointerTick
          cx={control.circle.cx * scaleX}
          cy={control.circle.cy * scaleY}
          r={control.circle.radius * (scaleX + scaleY) / 2}
          angle={(control.features as { pointer_angle_deg: number }).pointer_angle_deg}
          color={color}
        />
      )}

      {/* Fader cap highlight box */}
      {capBbox && (
        <>
          <rect
            x={capBbox[0] * scaleX}
            y={capBbox[1] * scaleY}
            width={(capBbox[2] - capBbox[0]) * scaleX}
            height={(capBbox[3] - capBbox[1]) * scaleY}
            fill={color}
            fillOpacity={selected ? 0.30 : 0.14}
            stroke={color}
            strokeWidth={selected ? 2.0 : 1.4}
            rx={2}
          />
          {/* Cap center line to indicate travel position */}
          {sliderFeatures?.orientation === 'vertical' ? (
            <line
              x1={capBbox[0] * scaleX}
              y1={((capBbox[1] + capBbox[3]) / 2) * scaleY}
              x2={capBbox[2] * scaleX}
              y2={((capBbox[1] + capBbox[3]) / 2) * scaleY}
              stroke={color}
              strokeWidth={1.5}
              opacity={0.7}
              strokeLinecap="round"
            />
          ) : (
            <line
              x1={((capBbox[0] + capBbox[2]) / 2) * scaleX}
              y1={capBbox[1] * scaleY}
              x2={((capBbox[0] + capBbox[2]) / 2) * scaleX}
              y2={capBbox[3] * scaleY}
              stroke={color}
              strokeWidth={1.5}
              opacity={0.7}
              strokeLinecap="round"
            />
          )}
        </>
      )}

      {selected && (
        <text x={x + 2} y={y - 3} fontSize={10} fill={color} fontFamily="monospace" fontWeight="bold">
          {control.display_name}
        </text>
      )}
    </g>
  )
}

function PointerTick({ cx, cy, r, angle, color }: {
  cx: number; cy: number; r: number; angle: number; color: string
}) {
  // angle: 0° = up, CW positive (as in _extract_knob_angle)
  const theta = (angle - 90) * Math.PI / 180
  const x2 = cx + Math.cos(theta) * r * 0.92
  const y2 = cy + Math.sin(theta) * r * 0.92
  return (
    <line x1={cx} y1={cy} x2={x2} y2={y2} stroke={color} strokeWidth={2.2} strokeLinecap="round" />
  )
}

function LabelOverlay({
  label, scaleX, scaleY, selected, highlightLinkedControl,
}: {
  label: PanelLabel
  scaleX: number
  scaleY: number
  selected: boolean
  highlightLinkedControl: (id: string | null) => void
}) {
  const x = label.bbox[0] * scaleX
  const y = label.bbox[1] * scaleY
  const w = (label.bbox[2] - label.bbox[0]) * scaleX
  const h = (label.bbox[3] - label.bbox[1]) * scaleY
  const isSection = label._is_section
  const color = isSection ? '#facc15' : '#ec4899'

  return (
    <g
      style={{ pointerEvents: 'all', cursor: 'pointer' }}
      onMouseEnter={() => label.linked_control_id && highlightLinkedControl(label.linked_control_id)}
      onMouseLeave={() => highlightLinkedControl(null)}
    >
      <rect
        x={x} y={y} width={w} height={h}
        fill={color}
        fillOpacity={selected ? 0.25 : isSection ? 0.12 : 0.06}
        stroke={color}
        strokeWidth={selected ? 1.8 : isSection ? 1.2 : 0.8}
        strokeDasharray={isSection ? undefined : '2 2'}
      />
      {(selected || isSection) && (
        <text
          x={x + w / 2} y={y + h / 2 + 3} fontSize={isSection ? 10 : 8} fill={color}
          textAnchor="middle"
          fontFamily="monospace"
          fontWeight={isSection ? 'bold' : 'normal'}
          style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.8)', strokeWidth: 2 }}
        >
          {label.text}
        </text>
      )}
    </g>
  )
}

export default function PanelOverlay({
  naturalW, naturalH, displayW, displayH, onResegment,
}: {
  naturalW: number
  naturalH: number
  displayW: number
  displayH: number
  onResegment?: (controlId: string, bbox: Bbox) => void
}) {
  const layout = usePanelLayoutStore((s) => s.layout)
  const selectedControlIds = usePanelLayoutStore((s) => s.selectedControlIds)
  const selectedLabelId = usePanelLayoutStore((s) => s.selectedLabelId)
  const highlightedControlId = usePanelLayoutStore((s) => s.highlightedControlId)
  const showMasks = usePanelLayoutStore((s) => s.showMasks)
  const showLabels = usePanelLayoutStore((s) => s.showLabels)
  const showBoxes = usePanelLayoutStore((s) => s.showBoxes)
  const editMode = usePanelLayoutStore((s) => s.editMode)
  const setHighlightedControl = usePanelLayoutStore((s) => s.setHighlightedControl)
  const selectControl = usePanelLayoutStore((s) => s.selectControl)
  const toggleSelectControl = usePanelLayoutStore((s) => s.toggleSelectControl)
  const selectLabel = usePanelLayoutStore((s) => s.selectLabel)
  const addControl = usePanelLayoutStore((s) => s.addControl)

  const scaleX = displayW / Math.max(naturalW, 1)
  const scaleY = displayH / Math.max(naturalH, 1)

  // ── Shift+drag on empty canvas to create a new bbox ─────────────────
  const svgRef = useRef<SVGSVGElement | null>(null)
  const drawRef = useRef<{ x0: number; y0: number } | null>(null)
  const [drawBox, setDrawBox] = useState<[number, number, number, number] | null>(null)
  const [newType, setNewType] = useState<PanelControlType>('knob')

  const svgPointFromEvent = useCallback((e: React.MouseEvent | MouseEvent) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * displayW,
      y: ((e.clientY - rect.top) / rect.height) * displayH,
    }
  }, [displayW, displayH])

  const onBackgroundMouseDown = useCallback((e: React.MouseEvent) => {
    if (!editMode || !e.shiftKey) return
    e.preventDefault()
    const p = svgPointFromEvent(e)
    drawRef.current = { x0: p.x, y0: p.y }
    setDrawBox([p.x, p.y, p.x, p.y])
    const onMove = (ev: MouseEvent) => {
      const d = drawRef.current
      if (!d) return
      const p2 = svgPointFromEvent(ev)
      setDrawBox([
        Math.min(d.x0, p2.x),
        Math.min(d.y0, p2.y),
        Math.max(d.x0, p2.x),
        Math.max(d.y0, p2.y),
      ])
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const box = drawBoxRef.current
      drawRef.current = null
      setDrawBox(null)
      if (!box) return
      const w = box[2] - box[0]
      const h = box[3] - box[1]
      if (w < 4 || h < 4) return
      // convert display → native
      const native: Bbox = [
        box[0] / scaleX, box[1] / scaleY,
        box[2] / scaleX, box[3] / scaleY,
      ]
      addControl(newType, native)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [editMode, svgPointFromEvent, scaleX, scaleY, newType, addControl])

  const drawBoxRef = useRef<typeof drawBox>(null)
  drawBoxRef.current = drawBox

  const maskImages = useMemo(() => {
    if (!layout || !showMasks) return []
    return layout.controls
      .filter((c) => c.mask_png)
      .map((c) => ({ c, href: c.mask_png as string, bbox: c.mask_bbox ?? null }))
  }, [layout, showMasks])

  if (!layout) return null

  return (
    <>
    {editMode && (
      <div
        className="absolute top-2 left-2 z-10 flex items-center gap-1 rounded-md bg-black/85 border border-white/15 px-2 py-1 shadow-lg backdrop-blur-sm text-[10px] text-white/80"
        style={{ pointerEvents: 'all' }}
      >
        <span className="text-white/50">New ctrl type:</span>
        <select
          value={newType}
          onChange={(e) => setNewType(e.target.value as PanelControlType)}
          className="bg-white/10 border border-white/10 rounded px-1 py-0.5 outline-none focus:border-amber-400"
        >
          {PANEL_CONTROL_TYPES.map((t) => (
            <option key={t} value={t} className="bg-neutral-900">{t}</option>
          ))}
        </select>
        <span className="text-white/40 pl-1">Shift+drag to add · Ctrl+click multi-select · arrows nudge · Del removes · Ctrl+D duplicates</span>
      </div>
    )}
    <svg
      ref={svgRef}
      className="absolute inset-0"
      style={{ width: '100%', height: '100%', pointerEvents: editMode ? 'all' : 'none' }}
      viewBox={`0 0 ${displayW} ${displayH}`}
      preserveAspectRatio="none"
      pointerEvents={editMode ? 'all' : 'none'}
      onMouseDown={onBackgroundMouseDown}
    >
      {/* Marching-ants animation for the selected control outline (Photoshop marquee) */}
      <style>{`@keyframes ss-march { to { stroke-dashoffset: -16; } } .ss-marching-ants { animation: ss-march 0.5s linear infinite; }`}</style>

      {/* 1. SAM2 masks — fullres, tinted by type */}
      {maskImages.map(({ c, href, bbox }) => {
        const color = typeColor(c.type)
        const isSel = selectedControlIds.has(c.id)
        const isHi = c.id === highlightedControlId
        const op = isSel ? 0.55 : isHi ? 0.40 : 0.22
        const x = bbox ? bbox[0] * scaleX : 0
        const y = bbox ? bbox[1] * scaleY : 0
        const w = bbox ? (bbox[2] - bbox[0]) * scaleX : displayW
        const h = bbox ? (bbox[3] - bbox[1]) * scaleY : displayH
        return (
          <g key={`m_${c.id}`}>
            <defs>
              <filter id={`tint_${c.id}`}>
                <feColorMatrix type="matrix" values={`
                  0 0 0 0 ${hexR(color)}
                  0 0 0 0 ${hexG(color)}
                  0 0 0 0 ${hexB(color)}
                  1 1 1 0 0
                `} />
              </filter>
            </defs>
            <image
              href={href}
              x={x} y={y}
              width={w} height={h}
              preserveAspectRatio="none"
              opacity={op}
              style={{ mixBlendMode: 'screen', filter: `url(#tint_${c.id})` }}
            />
          </g>
        )
      })}

      {/* 2. Bboxes / fitted shapes */}
      {showBoxes && layout.controls.map((c) => (
        <g
          key={`b_${c.id}`}
          style={{ pointerEvents: 'all', cursor: 'pointer' }}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey) {
              toggleSelectControl(c.id)
            } else {
              selectControl(selectedControlIds.has(c.id) && selectedControlIds.size === 1 ? null : c.id)
            }
          }}
          onMouseEnter={() => setHighlightedControl(c.id)}
          onMouseLeave={() => setHighlightedControl(null)}
        >
          <ControlMask
            control={c}
            scaleX={scaleX} scaleY={scaleY}
            selected={selectedControlIds.has(c.id)}
            highlighted={c.id === highlightedControlId}
          />
        </g>
      ))}

      {/* 3. Labels */}
      {showLabels && layout.labels.map((l) => (
        <g
          key={`l_${l.id}`}
          style={{ pointerEvents: 'all', cursor: 'pointer' }}
          onClick={() => selectLabel(l.id === selectedLabelId ? null : l.id)}
        >
          <LabelOverlay
            label={l}
            scaleX={scaleX} scaleY={scaleY}
            selected={l.id === selectedLabelId}
            highlightLinkedControl={setHighlightedControl}
          />
        </g>
      ))}

      {/* 4. Live drawing rect (Shift+drag to create) */}
      {drawBox && (
        <rect
          x={drawBox[0]} y={drawBox[1]}
          width={drawBox[2] - drawBox[0]}
          height={drawBox[3] - drawBox[1]}
          fill="rgba(245, 158, 11, 0.15)"
          stroke="#f59e0b"
          strokeWidth={1.5}
          strokeDasharray="3 3"
          pointerEvents="none"
        />
      )}
    </svg>
    <BboxEditor
      scaleX={scaleX}
      scaleY={scaleY}
      displayW={displayW}
      displayH={displayH}
      onResegment={onResegment}
    />
    </>
  )
}

// SVG color-matrix tint requires 0..1 components
function hexR(h: string) { return parseInt(h.slice(1, 3), 16) / 255 }
function hexG(h: string) { return parseInt(h.slice(3, 5), 16) / 255 }
function hexB(h: string) { return parseInt(h.slice(5, 7), 16) / 255 }
