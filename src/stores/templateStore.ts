import { create } from 'zustand'
import type { AssetTemplate } from '../types'

interface TemplateState {
  templates: AssetTemplate[]
  loadTemplates: () => Promise<void>
  addTemplate: (template: AssetTemplate) => void
  removeTemplate: (id: string) => void
}

const STORAGE_KEY = 'synthskin-templates'

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: [],

  loadTemplates: async () => {
    try {
      const appData = await window.synthskin.getAppDataPath()
      const filePath = `${appData}/synthskin-templates.json`
      const result = await window.synthskin.readFile(filePath)
      if (result.success && result.data) {
        const parsed = JSON.parse(result.data)
        if (Array.isArray(parsed)) {
          set({ templates: parsed })
        }
      }
    } catch {
      // No templates file yet — that's fine
    }
  },

  addTemplate: (template) => {
    set((s) => {
      const updated = [...s.templates, template]
      _persist(updated)
      return { templates: updated }
    })
  },

  removeTemplate: (id) => {
    set((s) => {
      const updated = s.templates.filter((t) => t.id !== id)
      _persist(updated)
      return { templates: updated }
    })
  },
}))

async function _persist(templates: AssetTemplate[]) {
  try {
    const appData = await window.synthskin.getAppDataPath()
    const filePath = `${appData}/synthskin-templates.json`
    await window.synthskin.writeFile(filePath, JSON.stringify(templates, null, 2), 'utf8')
  } catch (e) {
    console.error('[Templates] Failed to persist:', e)
  }
}
