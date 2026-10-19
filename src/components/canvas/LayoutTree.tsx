/**
 * LayoutTree — hierarchical tree view for the semantic panel layout.
 * Displays: Section → Controls (knob/switch/…) with their labels/features.
 * Clicking a row selects that control in the store (drives canvas highlight).
 */
import { useMemo, useState, useRef, useEffect } from 'react'
import { usePanelLayoutStore } from '../../stores/panelLayoutStore'
import type { PanelControl, PanelLabel, PanelSection } from '../../lib/api/pythonClient'
import { panelTypeColor } from './panelTrainingTypes'

const typeColor = (t: string) => panelTypeColor(t)

function TypeGlyph({ type }: { type: string }) {
  const color = typeColor(type)
  switch (type) {
    case 'knob':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke={color} strokeWidth="1.3" /><line x1="6" y1="3" x2="6" y2="6" stroke={color} strokeWidth="1.3" /></svg>
    case 'slider':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="6" y1="1" x2="6" y2="11" stroke={color} strokeWidth="1.3" /><rect x="3" y="5" width="6" height="2" fill={color} /></svg>
    case 'switch':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="4" width="8" height="4" rx="2" stroke={color} strokeWidth="1.2" /><circle cx="8" cy="6" r="1.5" fill={color} /></svg>
    case 'button':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="3" width="8" height="6" rx="1" stroke={color} strokeWidth="1.3" fill={color} fillOpacity="0.2" /></svg>
    case 'led':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="3" fill={color} fillOpacity="0.6" stroke={color} strokeWidth="1" /></svg>
    case 'screen':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="3" width="9" height="6" rx="0.8" stroke={color} strokeWidth="1.3" /><path d="M3 7 L5 5 L7 6.5 L9 4.5" stroke={color} strokeWidth="1" fill="none" /></svg>
    case 'slider_cap':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="3" y="2" width="6" height="8" rx="1.4" fill={color} fillOpacity="0.25" stroke={color} strokeWidth="1.2" /></svg>
    case 'slider_track':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="6" y1="1.5" x2="6" y2="10.5" stroke={color} strokeWidth="1.4" /><line x1="4" y1="1.5" x2="8" y2="1.5" stroke={color} strokeWidth="1" /><line x1="4" y1="10.5" x2="8" y2="10.5" stroke={color} strokeWidth="1" /></svg>
    case 'led_light':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="3.2" fill={color} fillOpacity="0.45" stroke={color} strokeWidth="1" /></svg>
    case 'led_screen':
    case 'meter_screen':
    case 'meter':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="2.5" width="9" height="7" rx="1" stroke={color} strokeWidth="1.2" /><path d="M3 7.5 A3 3 0 0 1 9 7.5" stroke={color} strokeWidth="1" fill="none" /></svg>
    case 'meter_needle':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="6" y1="9" x2="9" y2="4" stroke={color} strokeWidth="1.4" strokeLinecap="round" /><circle cx="6" cy="9" r="1" fill={color} /></svg>
    case 'meter_range':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 9 A4 4 0 0 1 10 9" stroke={color} strokeWidth="1.4" fill="none" /></svg>
    case 'text':
    case 'label':
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3H10" stroke={color} strokeWidth="1.2" /><path d="M6 3V9" stroke={color} strokeWidth="1.2" /><path d="M4 9H8" stroke={color} strokeWidth="1.2" /></svg>
    default:
      return <span className="w-3 h-3 rounded-full" style={{ background: color }} />
  }
}

function ControlRow({ control, labels }: { control: PanelControl; labels: PanelLabel[] }) {
  const selected = usePanelLayoutStore((s) => s.selectedControlIds.has(control.id))
  const selectControl = usePanelLayoutStore((s) => s.selectControl)
  const toggleSelectControl = usePanelLayoutStore((s) => s.toggleSelectControl)
  const setHighlightedControl = usePanelLayoutStore((s) => s.setHighlightedControl)
  const highlightedControlId = usePanelLayoutStore((s) => s.highlightedControlId)
  const renameControl = usePanelLayoutStore((s) => s.renameControl)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(control.display_name)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selected])

  // Show only meaningful sub-labels: skip scale marks and value readouts
  // (readouts are still useful if they're the ONLY linked labels).
  const allLinked = labels.filter((l) => l.linked_control_id === control.id)
  const wordLinked = allLinked.filter((l) => !l._linked_as_readout && !l._is_scale_mark)
  const linkedLabels = wordLinked.length > 0 ? wordLinked : allLinked.filter((l) => !l._is_scale_mark)
  const color = typeColor(control.type)
  const highlighted = highlightedControlId === control.id

  const featureSummary = (() => {
    const f = control.features as Record<string, unknown> | undefined
    if (!f) return null
    if (control.type === 'knob' && typeof f.value_normalized === 'number') {
      return `${Math.round((f.value_normalized as number) * 100)}% · ${(f.pointer_angle_deg as number).toFixed(0)}°`
    }
    if (control.type === 'slider' && typeof f.value_normalized === 'number') {
      return `${Math.round((f.value_normalized as number) * 100)}% ${f.orientation}`
    }
    if (control.type === 'screen' && typeof f.screen_kind === 'string') {
      return String(f.screen_kind)
    }
    return null
  })()

  return (
    <div
      ref={rowRef}
      className={`group pl-6 pr-2 py-1 border-l transition-colors cursor-pointer ${
        selected ? 'bg-accent-bg15 border-l-yellow-400' :
        highlighted ? 'bg-white/10 border-l-yellow-500/40' :
        'border-l-transparent hover:bg-white/5'
      }`}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          toggleSelectControl(control.id)
        } else {
          selectControl(selected ? null : control.id)
        }
      }}
      onMouseEnter={() => setHighlightedControl(control.id)}
      onMouseLeave={() => setHighlightedControl(null)}
    >
      <div className="flex items-center gap-2">
        <TypeGlyph type={control.type} />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { renameControl(control.id, draft); setEditing(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { renameControl(control.id, draft); setEditing(false) }
              if (e.key === 'Escape') { setDraft(control.display_name); setEditing(false) }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-xs bg-surface-3 border border-white/15 rounded px-1 py-0.5 text-white"
          />
        ) : (
          <span
            className="flex-1 text-xs text-white truncate"
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
            title="Double-click to rename"
          >
            {control.display_name}
          </span>
        )}
        <span className="text-[9px] font-mono text-white/35">{control.parameter_id}</span>
        {featureSummary && (
          <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-white/5" style={{ color }}>
            {featureSummary}
          </span>
        )}
        <span className="text-[9px] text-white/30 w-8 text-right">
          {Math.round(control.confidence * 100)}%
        </span>
      </div>
      {linkedLabels.length > 0 && (
        <div className="ml-5 mt-0.5 flex flex-wrap gap-1">
          {linkedLabels.map((lab) => (
            <span key={lab.id} className="text-[9px] px-1 py-0.5 rounded bg-pink-500/10 text-pink-300">
              {lab.text}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function SectionNode({ section }: { section: PanelSection }) {
  const layout = usePanelLayoutStore((s) => s.layout)
  const selectSection = usePanelLayoutStore((s) => s.selectSection)
  const selectedSectionId = usePanelLayoutStore((s) => s.selectedSectionId)
  const [open, setOpen] = useState(true)

  const controls = useMemo(() => {
    if (!layout) return []
    const map = new Map(layout.controls.map((c) => [c.id, c]))
    return section.control_ids.map((id) => map.get(id)).filter(Boolean) as PanelControl[]
  }, [layout, section.control_ids])

  const labels = useMemo(() => {
    if (!layout) return []
    const map = new Map(layout.labels.map((l) => [l.id, l]))
    return section.label_ids.map((id) => map.get(id)).filter(Boolean) as PanelLabel[]
  }, [layout, section.label_ids])

  const selected = selectedSectionId === section.id
  const byType = controls.reduce<Record<string, number>>((acc, c) => {
    acc[c.type] = (acc[c.type] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="border-b border-white/5">
      <button
        onClick={() => { setOpen(!open); selectSection(selected ? null : section.id) }}
        className={`w-full flex items-center gap-2 px-2 py-1.5 text-left transition-colors ${
          selected ? 'bg-yellow-500/10' : 'hover:bg-white/5'
        }`}
      >
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`transition-transform ${open ? 'rotate-90' : ''} text-white/50`}
        >
          <path d="M3 2 L7 5 L3 8" />
        </svg>
        <span className="text-xs font-semibold text-white uppercase tracking-wide">{section.name}</span>
        <span className="text-[10px] text-white/35 ml-auto font-mono">{controls.length}</span>
        {Object.entries(byType).map(([t, n]) => (
          <span key={t} className="text-[9px] px-1 rounded" style={{ color: typeColor(t), background: `${typeColor(t)}1a` }}>
            {n}{t[0]}
          </span>
        ))}
      </button>
      {open && (
        <div>
          {controls.length === 0 ? (
            <p className="pl-6 py-1 text-[10px] text-white/30 italic">No controls</p>
          ) : (
            controls.map((c) => <ControlRow key={c.id} control={c} labels={labels} />)
          )}
        </div>
      )}
    </div>
  )
}

export default function LayoutTree() {
  const layout = usePanelLayoutStore((s) => s.layout)

  if (!layout || layout.sections.length === 0) {
    return (
      <div className="text-muted text-xs text-center py-12 px-6 leading-relaxed">
        Run <strong className="text-white">Analyze Panel</strong> to build a hierarchical tree
        of controls grouped by section.
      </div>
    )
  }

  const typeCounts = layout.controls.reduce<Record<string, number>>((acc, c) => {
    acc[c.type] = (acc[c.type] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-white/10 flex items-center gap-3 flex-wrap shrink-0">
        <span className="text-[10px] text-muted uppercase tracking-wider">Layout</span>
        <span className="text-[10px] text-white/60 font-mono">
          {layout.sectionCount} sections · {layout.controlCount} controls · {layout.labelCount} labels
        </span>
        <div className="ml-auto flex gap-1.5">
          {Object.entries(typeCounts).sort().map(([t, n]) => (
            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded font-mono"
              style={{ color: typeColor(t), background: `${typeColor(t)}14` }}>
              {t} {n}
            </span>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {layout.sections.map((s) => <SectionNode key={s.id} section={s} />)}
      </div>
    </div>
  )
}
