import { useEffect, useCallback, useRef } from 'react'
import { useWorkspaceStore, type WorkspaceId } from '../stores/workspaceStore'

export interface ShortcutDef {
  /** Key combo string: e.g. 'ctrl+k', 'shift+f', 'v', 'escape' */
  key: string
  /** Execute when pressed */
  action: () => void
  /** Human-readable label for command palette */
  label: string
  /** Optional: only active in this workspace (null = global) */
  workspace?: WorkspaceId | null
  /** Category for grouping in command palette */
  category?: string
}

// Normalize key combo to canonical form
function normalizeCombo(key: string): string {
  return key.toLowerCase().split('+').sort().join('+')
}

// Convert KeyboardEvent to combo string
function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  const key = e.key.toLowerCase()
  // Avoid adding 'control', 'shift', 'alt', 'meta' as the key itself
  if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
    parts.push(key)
  }
  return parts.sort().join('+')
}

// Format combo for display
export function formatShortcut(key: string): string {
  const isMac = navigator.platform.includes('Mac')
  return key.split('+').map(part => {
    switch (part.toLowerCase()) {
      case 'ctrl': return isMac ? '⌘' : 'Ctrl'
      case 'shift': return isMac ? '⇧' : 'Shift'
      case 'alt': return isMac ? '⌥' : 'Alt'
      case 'escape': return 'Esc'
      case 'enter': return '↵'
      case 'backspace': case 'delete': return '⌫'
      case 'arrowup': return '↑'
      case 'arrowdown': return '↓'
      case 'arrowleft': return '←'
      case 'arrowright': return '→'
      case ' ': return 'Space'
      default: return part.toUpperCase()
    }
  }).join(isMac ? '' : '+')
}

// Global shortcut registry
const registeredShortcuts: Map<string, ShortcutDef> = new Map()

export function registerShortcut(def: ShortcutDef) {
  const normalized = normalizeCombo(def.key)
  registeredShortcuts.set(`${def.workspace ?? 'global'}::${normalized}`, def)
  return () => {
    registeredShortcuts.delete(`${def.workspace ?? 'global'}::${normalized}`)
  }
}

export function registerShortcuts(defs: ShortcutDef[]): () => void {
  const cleanups = defs.map(registerShortcut)
  return () => cleanups.forEach(fn => fn())
}

export function getAllCommands(): ShortcutDef[] {
  return Array.from(registeredShortcuts.values())
}

export function getCommandsForWorkspace(workspace: WorkspaceId): ShortcutDef[] {
  return Array.from(registeredShortcuts.values()).filter(
    s => !s.workspace || s.workspace === workspace
  )
}

/** Hook: register workspace-scoped shortcuts that clean up on unmount */
export function useShortcuts(shortcuts: ShortcutDef[], deps: unknown[] = []) {
  useEffect(() => {
    return registerShortcuts(shortcuts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** Hook: the global keyboard listener that dispatches to registered shortcuts */
export function useShortcutDispatcher() {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const activeWorkspaceRef = useRef(activeWorkspace)
  activeWorkspaceRef.current = activeWorkspace

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't capture when typing in inputs
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // Exception: allow Escape and Cmd+K even in inputs
      if (e.key !== 'Escape' && !(e.key === 'k' && (e.ctrlKey || e.metaKey))) return
    }

    const combo = eventToCombo(e)
    if (!combo) return

    const ws = activeWorkspaceRef.current

    // Try workspace-specific first, then global
    const wsKey = `${ws}::${combo}`
    const globalKey = `global::${combo}`

    const shortcut = registeredShortcuts.get(wsKey) || registeredShortcuts.get(globalKey)
    if (shortcut) {
      e.preventDefault()
      e.stopPropagation()
      shortcut.action()
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])
}
