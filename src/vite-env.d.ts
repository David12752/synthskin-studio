/// <reference types="vite/client" />

type PythonStatusEvent = {
  status: 'starting' | 'running' | 'crashed' | 'restarting' | 'failed' | 'stopped'
  port?: number
  code?: number | null
  restartAttempt?: number
  attempt?: number
  reason?: string
}

interface Window {
  synthskin: {
    getPythonPort: () => Promise<number>
    getPythonHealth: () => Promise<boolean>
    getPythonAlive: () => Promise<boolean>
    restartPython: () => Promise<number>
    onPythonStatus: (callback: (event: PythonStatusEvent) => void) => () => void
    showSaveDialog: (options: {
      title?: string; defaultPath?: string; buttonLabel?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ canceled: boolean; filePath?: string }>
    showOpenDialog: (options: {
      title?: string; defaultPath?: string; buttonLabel?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ canceled: boolean; filePath?: string }>
    showFolderDialog: (options: {
      title?: string; defaultPath?: string; buttonLabel?: string;
    }) => Promise<{ canceled: boolean; folderPath?: string }>
    writeFile: (filePath: string, data: string, encoding: 'utf8' | 'base64') =>
      Promise<{ success: boolean; error?: string }>
    readFile: (filePath: string, encoding?: 'utf8' | 'base64') =>
      Promise<{ success: boolean; data?: string; error?: string }>
    getAppDataPath: () => Promise<string>
    getRecentProjects: () => Promise<{ name: string; path: string; updatedAt: string }[]>
    addRecentProject: (entry: { name: string; path: string; updatedAt: string }) =>
      Promise<{ name: string; path: string; updatedAt: string }[]>
    setTitle: (title: string) => Promise<void>

    // JUCE Bridge
    bridgeScan: (portMin: number, portMax: number) =>
      Promise<{ host: string; port: number; pluginName: string; bridgeVersion: string; jucePluginVersion: string }[]>
    bridgeConnect: (host: string, port: number) => Promise<void>
    bridgeDisconnect: () => Promise<void>
    bridgeSend: (json: string) => Promise<void>
    onBridgeMessage: (callback: (msg: unknown) => void) => () => void
    onBridgeError: (callback: (data: { message: string }) => void) => () => void
    onBridgeClosed: (callback: () => void) => () => void

    // Build Runner
    runBuild: (projectDir: string, buildType: string) =>
      Promise<{ success: boolean; log: string; error?: string }>
    onBuildOutput: (callback: (chunk: string) => void) => () => void

    // Pluginval
    runPluginval: (pluginPath: string, strictnessLevel: number) =>
      Promise<{ success: boolean; log: string; error?: string }>
    onPluginvalOutput: (callback: (chunk: string) => void) => () => void

    // File System Browser
    fsGetHome: () => Promise<string>
    fsListDir: (dirPath: string) => Promise<{
      success: boolean
      entries?: { name: string; isDirectory: boolean; size: number; modifiedAt: string }[]
      error?: string
    }>
    fsCreateDir: (dirPath: string) => Promise<{ success: boolean; error?: string }>
    fsRename: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
    fsDelete: (targetPath: string) => Promise<{ success: boolean; error?: string }>
    fsReadBinary: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
    fsCopy: (srcPath: string, destPath: string) => Promise<{ success: boolean; error?: string }>

    // SynthSkin Packs
    packInstall: (filePath: string) => Promise<{ success: boolean; installPath?: string; manifest?: unknown; error?: string }>
    packUninstall: (packId: string) => Promise<{ success: boolean; error?: string }>
    packList: () => Promise<unknown[]>
    packGetDir: () => Promise<string>
    packReadFile: (packId: string, relativePath: string) => Promise<string | null>
    packOpenFilePicker: () => Promise<string | null>
  }
}
