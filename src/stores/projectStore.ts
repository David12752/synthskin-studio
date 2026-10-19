import { create } from 'zustand'
import { useAssetStore } from './assetStore'
import { useImageStore } from './imageStore'
import { useHistoryStore } from './historyStore'
import { usePanelLayoutStore } from './panelLayoutStore'
import type { SynthSkinFile } from '../lib/project/serialization'
import { packProjectBase64, base64ToBytes, deserializeAnyProject, ZIP_PROJECT_VERSION } from '../lib/project/zipProject'

interface RecentProject {
  name: string
  path: string
  updatedAt: string
}

interface ProjectState {
  projectName: string
  projectPath: string | null
  isDirty: boolean
  createdAt: string | null
  recentProjects: RecentProject[]
  autoSaveEnabled: boolean
  lastAutoSave: string | null

  // Actions
  setProjectName: (name: string) => void
  setProjectPath: (path: string | null) => void
  setDirty: (dirty: boolean) => void
  markDirty: () => void

  // Project operations
  newProject: () => void
  saveProject: () => Promise<boolean>
  saveProjectAs: () => Promise<boolean>
  openProject: () => Promise<boolean>
  openProjectFromPath: (filePath: string) => Promise<boolean>
  loadRecentProjects: () => Promise<void>
  autoSave: () => Promise<void>

  // Title management
  updateWindowTitle: () => void
}

const SYNTHSKIN_FILTERS = [{ name: 'SynthSkin Project', extensions: ['synthskin'] }]

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectName: 'Untitled Project',
  projectPath: null,
  isDirty: false,
  createdAt: null,
  recentProjects: [],
  autoSaveEnabled: true,
  lastAutoSave: null,

  setProjectName: (name) => {
    set({ projectName: name })
    get().updateWindowTitle()
  },

  setProjectPath: (path) => set({ projectPath: path }),

  setDirty: (dirty) => {
    set({ isDirty: dirty })
    get().updateWindowTitle()
  },

  markDirty: () => {
    if (!get().isDirty) {
      set({ isDirty: true })
      get().updateWindowTitle()
    }
  },

  newProject: () => {
    // Reset all state
    useAssetStore.getState().selectAsset(null)
    useAssetStore.setState({ assets: [] })
    useImageStore.setState({ sourceImage: null, isLoading: false })
    useHistoryStore.getState().clear()
    usePanelLayoutStore.getState().clear()

    set({
      projectName: 'Untitled Project',
      projectPath: null,
      isDirty: false,
      createdAt: null,
    })
    get().updateWindowTitle()
  },

  saveProject: async () => {
    const { projectPath, projectName, createdAt } = get()
    if (!projectPath) {
      return get().saveProjectAs()
    }

    const assets = useAssetStore.getState().assets
    const img = useImageStore.getState().sourceImage
    const sourceImage = img ? {
      id: img.id,
      path: img.path,
      width: img.width,
      height: img.height,
      dataUrl: img.dataUrl,
    } : null

    const nowIso = new Date().toISOString()
    const file: SynthSkinFile = {
      version: ZIP_PROJECT_VERSION,
      name: projectName,
      createdAt: createdAt ?? nowIso,
      updatedAt: nowIso,
      sourceImages: sourceImage ? [sourceImage] : [],
      assets,
      panelLayout: usePanelLayoutStore.getState().layout,
    }
    // v2: zip container written via the base64 write path (much smaller + no
    // full-JSON re-parse of megabytes of pixels on open).
    const base64 = await packProjectBase64(file)
    const result = await window.synthskin.writeFile(projectPath, base64, 'base64')

    if (result.success) {
      const now = new Date().toISOString()
      set({ isDirty: false, createdAt: createdAt ?? now })
      get().updateWindowTitle()

      // Update recent projects
      await window.synthskin.addRecentProject({
        name: projectName,
        path: projectPath,
        updatedAt: now,
      })
      get().loadRecentProjects()
      return true
    }
    return false
  },

  saveProjectAs: async () => {
    const { projectName } = get()
    const { canceled, filePath } = await window.synthskin.showSaveDialog({
      title: 'Save Project As',
      defaultPath: `${projectName}.synthskin`,
      buttonLabel: 'Save',
      filters: SYNTHSKIN_FILTERS,
    })

    if (canceled || !filePath) return false

    // Extract name from path
    const fileName = filePath.split(/[/\\]/).pop() ?? projectName
    const name = fileName.replace(/\.synthskin$/, '')
    set({ projectPath: filePath, projectName: name })

    return get().saveProject()
  },

  openProject: async () => {
    const { canceled, filePath } = await window.synthskin.showOpenDialog({
      title: 'Open Project',
      buttonLabel: 'Open',
      filters: SYNTHSKIN_FILTERS,
    })

    if (canceled || !filePath) return false
    return get().openProjectFromPath(filePath)
  },

  openProjectFromPath: async (filePath: string) => {
    // Read as base64 so binary (v2 zip) survives; deserializeAnyProject handles
    // both a v2 zip and a legacy v1 JSON file transparently.
    const result = await window.synthskin.readFile(filePath, 'base64')
    if (!result.success || !result.data) return false

    try {
      const project = deserializeAnyProject(base64ToBytes(result.data))

      // Restore assets
      useAssetStore.setState({ assets: project.assets, selectedAssetId: null })

      // Restore source image (re-decode from dataUrl)
      if (project.sourceImages.length > 0) {
        const src = project.sourceImages[0]
        const htmlImage = new Image()
        htmlImage.src = src.dataUrl
        await new Promise<void>((resolve, reject) => {
          htmlImage.onload = () => resolve()
          htmlImage.onerror = () => reject(new Error('Failed to decode image'))
        })

        useImageStore.setState({
          sourceImage: {
            id: src.id,
            path: src.path,
            width: src.width,
            height: src.height,
            dataUrl: src.dataUrl,
            htmlImage,
          },
          isLoading: false,
        })
      } else {
        useImageStore.setState({ sourceImage: null, isLoading: false })
      }

      // Clear undo history for the loaded project
      useHistoryStore.getState().clear()

      // Restore panel layout if saved
      usePanelLayoutStore.getState().setLayout(project.panelLayout ?? null)

      set({
        projectName: project.name,
        projectPath: filePath,
        isDirty: false,
        createdAt: project.createdAt,
      })
      get().updateWindowTitle()

      // Update recent projects
      await window.synthskin.addRecentProject({
        name: project.name,
        path: filePath,
        updatedAt: project.updatedAt,
      })
      get().loadRecentProjects()

      return true
    } catch (e) {
      console.error('[Project] Failed to load:', e)
      return false
    }
  },

  loadRecentProjects: async () => {
    try {
      const list = await window.synthskin.getRecentProjects()
      set({ recentProjects: list })
    } catch {
      set({ recentProjects: [] })
    }
  },

  autoSave: async () => {
    const { isDirty, autoSaveEnabled } = get()
    if (!isDirty || !autoSaveEnabled) return

    try {
      const appDataPath = await window.synthskin.getAppDataPath()
      const recoveryPath = `${appDataPath}/synthskin-recovery.synthskin`

      const assets = useAssetStore.getState().assets
      const img = useImageStore.getState().sourceImage
      const sourceImage = img ? {
        id: img.id,
        path: img.path,
        width: img.width,
        height: img.height,
        dataUrl: img.dataUrl,
      } : null

      const { projectName, createdAt } = get()
      const nowIso = new Date().toISOString()
      const file: SynthSkinFile = {
        version: ZIP_PROJECT_VERSION,
        name: projectName,
        createdAt: createdAt ?? nowIso,
        updatedAt: nowIso,
        sourceImages: sourceImage ? [sourceImage] : [],
        assets,
        panelLayout: usePanelLayoutStore.getState().layout,
      }
      const base64 = await packProjectBase64(file)
      await window.synthskin.writeFile(recoveryPath, base64, 'base64')

      set({ lastAutoSave: nowIso })
    } catch (e) {
      console.error('[AutoSave] Failed:', e)
    }
  },

  updateWindowTitle: () => {
    const { projectName, isDirty } = get()
    const dirtyMark = isDirty ? ' •' : ''
    window.synthskin?.setTitle?.(`${projectName}${dirtyMark} — SynthSkin Studio`)
  },
}))
