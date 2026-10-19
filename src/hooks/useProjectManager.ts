import { useEffect, useRef } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { useHistoryStore } from '../stores/historyStore'
import { useTemplateStore } from '../stores/templateStore'

const AUTO_SAVE_INTERVAL = 2 * 60 * 1000 // 2 minutes

/**
 * Global keyboard shortcuts and auto-save timer.
 * Mount once in App.tsx.
 */
export function useProjectManager() {
  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // Load recent projects + templates on mount
    useProjectStore.getState().loadRecentProjects()
    useProjectStore.getState().updateWindowTitle()
    useTemplateStore.getState().loadTemplates()

    // Keyboard shortcuts
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey

      // Don't intercept inside inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (ctrl && !shift && e.key === 'n') {
        e.preventDefault()
        useProjectStore.getState().newProject()
      } else if (ctrl && !shift && e.key === 'o') {
        e.preventDefault()
        useProjectStore.getState().openProject()
      } else if (ctrl && shift && e.key === 'S') {
        e.preventDefault()
        useProjectStore.getState().saveProjectAs()
      } else if (ctrl && !shift && e.key === 's') {
        e.preventDefault()
        useProjectStore.getState().saveProject()
      } else if (ctrl && !shift && e.key === 'z') {
        e.preventDefault()
        useHistoryStore.getState().undo()
      } else if (ctrl && !shift && e.key === 'y') {
        e.preventDefault()
        useHistoryStore.getState().redo()
      } else if (ctrl && shift && e.key === 'Z') {
        e.preventDefault()
        useHistoryStore.getState().redo()
      }
    }

    window.addEventListener('keydown', handler)

    // Auto-save timer
    autoSaveRef.current = setInterval(() => {
      useProjectStore.getState().autoSave()
    }, AUTO_SAVE_INTERVAL)

    return () => {
      window.removeEventListener('keydown', handler)
      if (autoSaveRef.current) clearInterval(autoSaveRef.current)
    }
  }, [])
}
