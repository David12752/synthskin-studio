import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import { PythonBridge, type PythonStatusEvent } from './python-bridge'
import { JuceBridgeManager } from './juce-bridge'

let mainWindow: BrowserWindow | null = null
let pythonBridge: PythonBridge | null = null
let juceBridge: JuceBridgeManager | null = null
let pythonWatcher: fs.FSWatcher | null = null
let pythonRestartDebounce: NodeJS.Timeout | null = null
let _pythonDevWatcherRestarting = false

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function disposePythonWatcher() {
  if (pythonRestartDebounce) {
    clearTimeout(pythonRestartDebounce)
    pythonRestartDebounce = null
  }
  if (pythonWatcher) {
    pythonWatcher.close()
    pythonWatcher = null
  }
}

function setupPythonDevWatcher(pythonDir: string) {
  if (!VITE_DEV_SERVER_URL || pythonWatcher) return

  const ignoredSegments = ['.venv', '__pycache__', 'models']

  pythonWatcher = fs.watch(pythonDir, { recursive: true }, (_eventType, filename) => {
    if (!filename || !pythonBridge) return

    const relativePath = filename.toString()
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
    if (ignoredSegments.some((segment) => normalized.includes(`/${segment.toLowerCase()}/`) || normalized.startsWith(`${segment.toLowerCase()}/`))) {
      return
    }
    if (!(/\.py$/i.test(relativePath) || /requirements\.txt$/i.test(relativePath) || /\.env$/i.test(relativePath))) {
      return
    }

    if (pythonRestartDebounce) {
      clearTimeout(pythonRestartDebounce)
    }

    // 3-second debounce: wait for all rapid saves to settle before restarting.
    pythonRestartDebounce = setTimeout(async () => {
      pythonRestartDebounce = null
      if (!pythonBridge || _pythonDevWatcherRestarting) return
      _pythonDevWatcherRestarting = true

      console.log(`[Main] Python source changed (${relativePath}); restarting sidecar`)
      mainWindow?.webContents.send('python-status', { status: 'restarting', attempt: 0 })

      try {
        const port = await pythonBridge.restart()
        mainWindow?.webContents.send('python-status', { status: 'running', port })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error('[Main] Failed to restart Python sidecar after source change:', err)
        mainWindow?.webContents.send('python-status', { status: 'failed', reason })
      } finally {
        _pythonDevWatcherRestarting = false
      }
    }, 3000)
  })

  pythonWatcher.on('error', (err) => {
    console.error('[Main] Python file watcher failed:', err)
  })
}

type PackManifest = {
  formatVersion: string
  id: string
  name: string
  version: string
  components: unknown[]
  [key: string]: unknown
}

type InstalledPack = {
  manifest: PackManifest
  installPath: string
  installedAt: string
  status: 'installed'
}

function getPacksDirectory(): string {
  return path.join(app.getPath('home'), 'SynthSkin', 'packs')
}

function validatePackManifest(raw: unknown): PackManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.formatVersion !== '1.0') return null
  if (typeof m.id !== 'string' || !m.id.trim()) return null
  if (typeof m.name !== 'string' || !m.name.trim()) return null
  if (typeof m.version !== 'string' || !m.version.trim()) return null
  if (!Array.isArray(m.components)) return null
  return raw as PackManifest
}

function sanitizePackId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 120) || `pack-${Date.now()}`
}

function safePackPath(root: string, relativePath: string): string {
  const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean || clean.includes('../') || clean === '..') {
    throw new Error(`Unsafe pack path: ${relativePath}`)
  }
  const resolved = path.resolve(root, ...clean.split('/').filter(Boolean))
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Pack path escapes install directory: ${relativePath}`)
  }
  return resolved
}

function readStoredZipEntries(zipPath: string): Map<string, Buffer> {
  const buf = fs.readFileSync(zipPath)
  const entries = new Map<string, Buffer>()
  let offset = 0

  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset)
    if (sig === 0x02014b50 || sig === 0x06054b50) break
    if (sig !== 0x04034b50) throw new Error('Invalid .synthpack ZIP header')

    const flags = buf.readUInt16LE(offset + 6)
    const compression = buf.readUInt16LE(offset + 8)
    const compressedSize = buf.readUInt32LE(offset + 18)
    const fileNameLength = buf.readUInt16LE(offset + 26)
    const extraLength = buf.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + fileNameLength + extraLength
    const dataEnd = dataStart + compressedSize

    if ((flags & 0x08) !== 0) throw new Error('Unsupported ZIP data descriptor')
    if (compression !== 0) throw new Error('Unsupported compressed .synthpack entry; export with SynthSkin Studio')
    if (dataEnd > buf.length) throw new Error('Corrupt .synthpack entry size')

    const name = buf.toString('utf8', nameStart, nameStart + fileNameLength).replace(/\\/g, '/')
    if (!name.endsWith('/')) {
      entries.set(name, Buffer.from(buf.subarray(dataStart, dataEnd)))
    }
    offset = dataEnd
  }

  return entries
}

function readPackManifestFromDir(packDir: string): PackManifest | null {
  const manifestPath = path.join(packDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  try {
    return validatePackManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
  } catch {
    return null
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'SynthSkin Studio',
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const pythonDir = path.join(__dirname, '..', 'python')

  // Start Python sidecar
  pythonBridge = new PythonBridge()

  // Forward Python status events to the renderer
  pythonBridge.onStatusChange = (event: PythonStatusEvent) => {
    mainWindow?.webContents.send('python-status', event)
    // Refresh the cached port when restarted
    if (event.status === 'running') {
      pythonPort = event.port
    }
  }

  let pythonPort = 0
  try {
    pythonPort = await pythonBridge.start()
    console.log(`[Main] Python sidecar running on port ${pythonPort}`)
    mainWindow?.webContents.send('python-status', {
      status: 'running',
      port: pythonPort,
    })
  } catch (err) {
    console.error('[Main] Failed to start Python sidecar:', err)
    mainWindow?.webContents.send('python-status', {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  // Start JUCE bridge manager
  juceBridge = new JuceBridgeManager()
  juceBridge.setMainWindow(mainWindow!)

  // Expose Python port and health to renderer
  ipcMain.handle('get-python-port', () => pythonBridge?.getPort() ?? pythonPort)
  ipcMain.handle('get-python-health', async () => {
    if (!pythonBridge) return false
    return pythonBridge.healthCheck()
  })
  ipcMain.handle('get-python-alive', () => pythonBridge?.isAlive() ?? false)
  ipcMain.handle('restart-python', async () => {
    if (!pythonBridge) {
      throw new Error('Python sidecar not initialized')
    }

    mainWindow?.webContents.send('python-status', { status: 'restarting', attempt: 0 })
    try {
      const port = await pythonBridge.restart()
      pythonPort = port
      mainWindow?.webContents.send('python-status', { status: 'running', port })
      return port
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      mainWindow?.webContents.send('python-status', { status: 'failed', reason })
      throw err
    }
  })

  // File save dialog
  ipcMain.handle('show-save-dialog', async (_event, options: {
    title?: string
    defaultPath?: string
    buttonLabel?: string
    filters?: { name: string; extensions: string[] }[]
  }) => {
    if (!mainWindow) return { canceled: true, filePath: undefined }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title ?? 'Save',
      defaultPath: options.defaultPath,
      buttonLabel: options.buttonLabel ?? 'Save',
      filters: options.filters ?? [{ name: 'All Files', extensions: ['*'] }],
    })
    return { canceled: result.canceled, filePath: result.filePath }
  })

  // Folder select dialog
  ipcMain.handle('show-folder-dialog', async (_event, options: {
    title?: string
    defaultPath?: string
    buttonLabel?: string
  }) => {
    if (!mainWindow) return { canceled: true, folderPath: undefined }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title ?? 'Select Folder',
      defaultPath: options.defaultPath,
      buttonLabel: options.buttonLabel ?? 'Select',
      properties: ['openDirectory', 'createDirectory'],
    })
    return {
      canceled: result.canceled,
      folderPath: result.filePaths?.[0],
    }
  })

  // Write file (text or binary from base64)
  ipcMain.handle('write-file', async (_event, filePath: string, data: string, encoding: 'utf8' | 'base64') => {
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      if (encoding === 'base64') {
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
      } else {
        fs.writeFileSync(filePath, data, 'utf8')
      }
      return { success: true }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: msg }
    }
  })

  // Read file (utf8 text by default; base64 for binary containers like .synthskin v2 zips)
  ipcMain.handle('read-file', async (_event, filePath: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<{ success: boolean; data?: string; error?: string }> => {
    try {
      const data = encoding === 'base64'
        ? fs.readFileSync(filePath).toString('base64')
        : fs.readFileSync(filePath, 'utf8')
      return { success: true, data }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: msg }
    }
  })

  // File open dialog
  ipcMain.handle('show-open-dialog', async (_event, options: {
    title?: string
    defaultPath?: string
    buttonLabel?: string
    filters?: { name: string; extensions: string[] }[]
  }) => {
    if (!mainWindow) return { canceled: true, filePath: undefined }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title ?? 'Open',
      defaultPath: options.defaultPath,
      buttonLabel: options.buttonLabel ?? 'Open',
      filters: options.filters ?? [{ name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    })
    return {
      canceled: result.canceled,
      filePath: result.filePaths?.[0],
    }
  })

  // Get app data path for auto-save + recent projects
  ipcMain.handle('get-app-data-path', () => {
    return app.getPath('userData')
  })

  // Recent projects list (stored in userData/recent-projects.json)
  const recentProjectsPath = path.join(app.getPath('userData'), 'recent-projects.json')

  ipcMain.handle('get-recent-projects', (): { name: string; path: string; updatedAt: string }[] => {
    try {
      if (fs.existsSync(recentProjectsPath)) {
        return JSON.parse(fs.readFileSync(recentProjectsPath, 'utf8'))
      }
    } catch { /* ignore corrupt file */ }
    return []
  })

  ipcMain.handle('add-recent-project', (_event, entry: { name: string; path: string; updatedAt: string }) => {
    let list: { name: string; path: string; updatedAt: string }[] = []
    try {
      if (fs.existsSync(recentProjectsPath)) {
        list = JSON.parse(fs.readFileSync(recentProjectsPath, 'utf8'))
      }
    } catch { /* ignore */ }
    // Remove duplicate by path
    list = list.filter((p) => p.path !== entry.path)
    // Prepend
    list.unshift(entry)
    // Keep max 10
    list = list.slice(0, 10)
    fs.writeFileSync(recentProjectsPath, JSON.stringify(list, null, 2), 'utf8')
    return list
  })

  // Set window title
  ipcMain.handle('set-title', (_event, title: string) => {
    mainWindow?.setTitle(title)
  })

  // ─── File Browser IPC handlers ────────────────────────
  ipcMain.handle('fs-list-dir', async (_event, dirPath: string): Promise<{
    success: boolean
    entries?: { name: string; isDirectory: boolean; size: number; modifiedAt: string }[]
    error?: string
  }> => {
    try {
      const resolvedPath = path.resolve(dirPath)
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
      const result = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => {
          let size = 0
          let modifiedAt = ''
          try {
            const stat = fs.statSync(path.join(resolvedPath, e.name))
            size = stat.size
            modifiedAt = stat.mtime.toISOString()
          } catch { /* skip stat errors */ }
          return {
            name: e.name,
            isDirectory: e.isDirectory(),
            size,
            modifiedAt,
          }
        })
      return { success: true, entries: result }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('fs-create-dir', async (_event, dirPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      fs.mkdirSync(path.resolve(dirPath), { recursive: true })
      return { success: true }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('fs-rename', async (_event, oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      fs.renameSync(path.resolve(oldPath), path.resolve(newPath))
      return { success: true }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('fs-delete', async (_event, targetPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const resolved = path.resolve(targetPath)
      const stat = fs.statSync(resolved)
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true })
      } else {
        fs.unlinkSync(resolved)
      }
      return { success: true }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('fs-read-binary', async (_event, filePath: string): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
    try {
      const resolved = path.resolve(filePath)
      const ext = path.extname(resolved).toLowerCase()
      const mimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff',
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      const data = fs.readFileSync(resolved)
      const b64 = data.toString('base64')
      return { success: true, dataUrl: `data:${mime};base64,${b64}` }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('fs-copy', async (_event, srcPath: string, destPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      fs.copyFileSync(path.resolve(srcPath), path.resolve(destPath))
      return { success: true }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('fs-get-home', () => {
    return app.getPath('home')
  })

  // ─── SynthSkin Pack (.synthpack) IPC handlers ────────────────────
  ipcMain.handle('pack-open-file-picker', async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Install SynthSkin Pack',
      buttonLabel: 'Install Pack',
      filters: [{ name: 'SynthSkin Pack', extensions: ['synthpack', 'zip'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('pack-get-dir', (): string => {
    const dir = getPacksDirectory()
    fs.mkdirSync(dir, { recursive: true })
    return dir
  })

  ipcMain.handle('pack-list', (): InstalledPack[] => {
    const packsDir = getPacksDirectory()
    fs.mkdirSync(packsDir, { recursive: true })
    return fs.readdirSync(packsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const installPath = path.join(packsDir, entry.name)
        const manifest = readPackManifestFromDir(installPath)
        if (!manifest) return null
        const stat = fs.statSync(path.join(installPath, 'manifest.json'))
        return {
          manifest,
          installPath,
          installedAt: stat.mtime.toISOString(),
          status: 'installed' as const,
        }
      })
      .filter((pack): pack is InstalledPack => pack !== null)
  })

  ipcMain.handle('pack-install', async (_event, filePath: string): Promise<{ success: boolean; installPath?: string; manifest?: PackManifest; error?: string }> => {
    try {
      const resolvedFile = path.resolve(filePath)
      if (!fs.existsSync(resolvedFile)) throw new Error(`Pack file not found: ${resolvedFile}`)

      const entries = readStoredZipEntries(resolvedFile)
      const manifestBytes = entries.get('manifest.json')
      if (!manifestBytes) throw new Error('Pack is missing manifest.json')

      const manifest = validatePackManifest(JSON.parse(manifestBytes.toString('utf8')))
      if (!manifest) throw new Error('Invalid pack manifest')

      const packsDir = getPacksDirectory()
      fs.mkdirSync(packsDir, { recursive: true })
      const installPath = path.join(packsDir, sanitizePackId(manifest.id))
      fs.rmSync(installPath, { recursive: true, force: true })
      fs.mkdirSync(installPath, { recursive: true })

      for (const [entryPath, data] of entries) {
        const target = safePackPath(installPath, entryPath)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, data)
      }

      return { success: true, installPath, manifest }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('pack-uninstall', async (_event, packId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const installPath = path.join(getPacksDirectory(), sanitizePackId(packId))
      fs.rmSync(installPath, { recursive: true, force: true })
      return { success: true }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('pack-read-file', async (_event, packId: string, relativePath: string): Promise<string | null> => {
    try {
      const installPath = path.join(getPacksDirectory(), sanitizePackId(packId))
      const filePath = safePackPath(installPath, relativePath)
      if (!fs.existsSync(filePath)) return null
      const ext = path.extname(filePath).toLowerCase()
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
        const mime = ext === '.svg' ? 'image/svg+xml'
          : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
          : 'image/png'
        return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
      }
      return fs.readFileSync(filePath, 'utf8')
    } catch {
      return null
    }
  })

  // ─── Build runner (CMake) ─────────────────────────────
  ipcMain.handle('run-build', async (
    _event,
    projectDir: string,
    buildType: string,
  ): Promise<{ success: boolean; log: string; error?: string }> => {
    const { spawn } = await import('child_process')

    const runCmd = (cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> => {
      return new Promise((resolve) => {
        let output = ''
        const proc = spawn(cmd, args, { cwd, shell: true })
        proc.stdout?.on('data', (d: Buffer) => {
          const chunk = d.toString()
          output += chunk
          mainWindow?.webContents.send('build-output', chunk)
        })
        proc.stderr?.on('data', (d: Buffer) => {
          const chunk = d.toString()
          output += chunk
          mainWindow?.webContents.send('build-output', chunk)
        })
        proc.on('close', (code) => resolve({ code: code ?? 1, output }))
        proc.on('error', (err) => resolve({ code: 1, output: output + '\n' + err.message }))
      })
    }

    let fullLog = ''

    // 1. Configure
    mainWindow?.webContents.send('build-output', '=== CMake Configure ===\n')
    const configure = await runCmd('cmake', ['-B', 'build', `-DCMAKE_BUILD_TYPE=${buildType}`], projectDir)
    fullLog += configure.output
    if (configure.code !== 0) {
      return { success: false, log: fullLog, error: 'CMake configure failed' }
    }

    // 2. Build
    mainWindow?.webContents.send('build-output', '\n=== CMake Build ===\n')
    const build = await runCmd('cmake', ['--build', 'build', '--config', buildType], projectDir)
    fullLog += build.output

    return {
      success: build.code === 0,
      log: fullLog,
      error: build.code !== 0 ? 'Build failed' : undefined,
    }
  })

  // ─── Pluginval runner ──────────────────────────────────
  ipcMain.handle('run-pluginval', async (
    _event,
    pluginPath: string,
    strictnessLevel: number,
  ): Promise<{ success: boolean; log: string; error?: string }> => {
    const { spawn } = await import('child_process')

    return new Promise((resolve) => {
      let output = ''
      const args = [
        '--validate-in-process',
        '--strictness-level', String(strictnessLevel),
        pluginPath,
      ]

      const proc = spawn('pluginval', args, { shell: true })
      proc.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString()
        output += chunk
        mainWindow?.webContents.send('pluginval-output', chunk)
      })
      proc.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString()
        output += chunk
        mainWindow?.webContents.send('pluginval-output', chunk)
      })
      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          log: output,
          error: code !== 0 ? `pluginval exited with code ${code}` : undefined,
        })
      })
      proc.on('error', (err) => {
        resolve({
          success: false,
          log: output + '\n' + err.message,
          error: `Failed to run pluginval: ${err.message}. Make sure pluginval is installed and in your PATH.`,
        })
      })
    })
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    disposePythonWatcher()
    mainWindow = null
  })

  setupPythonDevWatcher(pythonDir)
}

app.whenReady().then(createWindow)

app.on('window-all-closed', async () => {
  disposePythonWatcher()
  if (juceBridge) {
    juceBridge.destroy()
  }
  if (pythonBridge) {
    await pythonBridge.stop()
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
