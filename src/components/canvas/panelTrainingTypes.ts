import type { PanelControlType } from '../../lib/api/pythonClient'

export const PANEL_CONTROL_TYPES: PanelControlType[] = [
  'knob',
  'slider',
  'switch',
  'button',
  'led',
  'screen',
  'label',
  'slider_cap',
  'slider_track',
  'led_light',
  'led_screen',
  'meter',
  'meter_screen',
  'meter_needle',
  'meter_range',
  'text',
]

export const PANEL_TYPE_COLORS: Record<string, string> = {
  knob: '#f59e0b',
  slider: '#10b981',
  switch: '#a78bfa',
  button: '#3b82f6',
  led: '#ef4444',
  screen: '#8b5cf6',
  label: '#ec4899',
  slider_cap: '#14b8a6',
  slider_track: '#22c55e',
  led_light: '#f43f5e',
  led_screen: '#06b6d4',
  meter: '#6366f1',
  meter_screen: '#6366f1',
  meter_needle: '#fb7185',
  meter_range: '#38bdf8',
  text: '#f97316',
}

export const panelTypeColor = (type: string): string => PANEL_TYPE_COLORS[type] ?? '#94a3b8'
