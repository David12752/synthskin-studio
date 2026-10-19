import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('synthskin', {
  getPythonPort: (): Promise<number> => ipcRenderer.invoke('get-python-port'),
  getPythonHealth: (): Promise<boolean> => ipcRenderer.invoke('get-python-health'),
  getPythonAlive: (): Promise<boolean> => ipcRenderer.invoke('get-python-alive'),
  restartPython: (): Promise<number> => ipcRenderer.invoke('restart-python'),

  onPythonStatus: (callback: (event: {
    status: 'starting' | 'running' | 'crashed' | 'restarting' | 'failed' | 'stopped'
    port?: number
    code?: number | null
    restartAttempt?: number
    attempt?: number
    reason?: string
  }) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('python-status', handler)
    return () => ipcRenderer.removeListener('python-status', handler)
  },

  showSaveDialog: (options: {
    title?: string; defaultPath?: string; buttonLabel?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('show-save-dialog', options),

  showOpenDialog: (options: {
    title?: string; defaultPath?: string; buttonLabel?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('show-open-dialog', options),

  showFolderDialog: (options: {
    title?: string; defaultPath?: string; buttonLabel?: string;
  }): Promise<{ canceled: boolean; folderPath?: string }> =>
    ipcRenderer.invoke('show-folder-dialog', options),

  writeFile: (filePath: string, data: string, encoding: 'utf8' | 'base64'):
    Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('write-file', filePath, data, encoding),

  readFile: (filePath: string, encoding: 'utf8' | 'base64' = 'utf8'):
    Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke('read-file', filePath, encoding),

  getAppDataPath: (): Promise<string> =>
    ipcRenderer.invoke('get-app-data-path'),

  getRecentProjects: (): Promise<{ name: string; path: string; updatedAt: string }[]> =>
    ipcRenderer.invoke('get-recent-projects'),

  addRecentProject: (entry: { name: string; path: string; updatedAt: string }):
    Promise<{ name: string; path: string; updatedAt: string }[]> =>
    ipcRenderer.invoke('add-recent-project', entry),

  setTitle: (title: string): Promise<void> =>
    ipcRenderer.invoke('set-title', title),

  // ─── JUCE Bridge ───────────────────────────────────────
  bridgeScan: (portMin: number, portMax: number):
    Promise<{ host: string; port: number; pluginName: string; bridgeVersion: string; jucePluginVersion: string }[]> =>
    ipcRenderer.invoke('bridge-scan', portMin, portMax),

  bridgeConnect: (host: string, port: number): Promise<void> =>
    ipcRenderer.invoke('bridge-connect', host, port),

  bridgeDisconnect: (): Promise<void> =>
    ipcRenderer.invoke('bridge-disconnect'),

  bridgeSend: (json: string): Promise<void> =>
    ipcRenderer.invoke('bridge-send', json),

  onBridgeMessage: (callback: (msg: unknown) => void): (() => void) => {
    const handler = (_event: unknown, msg: unknown) => callback(msg)
    ipcRenderer.on('bridge-message', handler)
    return () => ipcRenderer.removeListener('bridge-message', handler)
  },

  onBridgeError: (callback: (data: { message: string }) => void): (() => void) => {
    const handler = (_event: unknown, data: { message: string }) => callback(data)
    ipcRenderer.on('bridge-error', handler)
    return () => ipcRenderer.removeListener('bridge-error', handler)
  },

  onBridgeClosed: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('bridge-closed', handler)
    return () => ipcRenderer.removeListener('bridge-closed', handler)
  },

  // ─── Build Runner ──────────────────────────────────────
  runBuild: (projectDir: string, buildType: string):
    Promise<{ success: boolean; log: string; error?: string }> =>
    ipcRenderer.invoke('run-build', projectDir, buildType),

  onBuildOutput: (callback: (chunk: string) => void): (() => void) => {
    const handler = (_event: unknown, chunk: string) => callback(chunk)
    ipcRenderer.on('build-output', handler)
    return () => ipcRenderer.removeListener('build-output', handler)
  },

  // ─── Pluginval ─────────────────────────────────────────
  runPluginval: (pluginPath: string, strictnessLevel: number):
    Promise<{ success: boolean; log: string; error?: string }> =>
    ipcRenderer.invoke('run-pluginval', pluginPath, strictnessLevel),

  onPluginvalOutput: (callback: (chunk: string) => void): (() => void) => {
    const handler = (_event: unknown, chunk: string) => callback(chunk)
    ipcRenderer.on('pluginval-output', handler)
    return () => ipcRenderer.removeListener('pluginval-output', handler)
  },

  // ─── File Browser ──────────────────────────────────────
  fsListDir: (dirPath: string): Promise<{
    success: boolean
    entries?: { name: string; isDirectory: boolean; size: number; modifiedAt: string }[]
    error?: string
  }> => ipcRenderer.invoke('fs-list-dir', dirPath),

  fsCreateDir: (dirPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs-create-dir', dirPath),

  fsRename: (oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs-rename', oldPath, newPath),

  fsDelete: (targetPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs-delete', targetPath),

  fsReadBinary: (filePath: string): Promise<{ success: boolean; dataUrl?: string; error?: string }> =>
    ipcRenderer.invoke('fs-read-binary', filePath),

  fsCopy: (srcPath: string, destPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs-copy', srcPath, destPath),

  fsGetHome: (): Promise<string> =>
    ipcRenderer.invoke('fs-get-home'),

  // ─── SynthSkin Packs ──────────────────────────────────
  packInstall: (filePath: string): Promise<{ success: boolean; installPath?: string; manifest?: unknown; error?: string }> =>
    ipcRenderer.invoke('pack-install', filePath),

  packUninstall: (packId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pack-uninstall', packId),

  packList: (): Promise<unknown[]> =>
    ipcRenderer.invoke('pack-list'),

  packGetDir: (): Promise<string> =>
    ipcRenderer.invoke('pack-get-dir'),

  packReadFile: (packId: string, relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke('pack-read-file', packId, relativePath),

  packOpenFilePicker: (): Promise<string | null> =>
    ipcRenderer.invoke('pack-open-file-picker'),
})
