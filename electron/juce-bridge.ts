/**
 * JUCE Bridge — Electron main-process TCP client
 *
 * Connects to the SynthSkin Bridge module running inside a JUCE plugin.
 * Uses length-prefixed JSON framing (4-byte BE length + JSON body).
 */

import net from 'net'
import { BrowserWindow, ipcMain } from 'electron'

// ─── Length-prefixed framing helpers ──────────────────────

function encodeFrame(json: string): Buffer {
  const body = Buffer.from(json, 'utf-8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** State machine that accumulates TCP chunks and yields complete JSON frames */
class FrameDecoder {
  private buffer = Buffer.alloc(0)

  feed(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const frames: string[] = []

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length > 10 * 1024 * 1024) {
        // Reject frames > 10 MB as malformed
        this.buffer = Buffer.alloc(0)
        break
      }
      if (this.buffer.length < 4 + length) break
      const json = this.buffer.subarray(4, 4 + length).toString('utf-8')
      frames.push(json)
      this.buffer = this.buffer.subarray(4 + length)
    }

    return frames
  }

  reset() {
    this.buffer = Buffer.alloc(0)
  }
}

// ─── Bridge Manager ──────────────────────────────────────

interface DetectedPlugin {
  host: string
  port: number
  pluginName: string
  bridgeVersion: string
  jucePluginVersion: string
}

export class JuceBridgeManager {
  private socket: net.Socket | null = null
  private decoder = new FrameDecoder()
  private mainWindow: BrowserWindow | null = null

  constructor() {
    this.registerIpcHandlers()
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  // ─── IPC handlers (renderer ↔ main) ──────────────────

  private registerIpcHandlers() {
    ipcMain.handle('bridge-scan', async (_event, portMin: number, portMax: number) => {
      return this.scanPorts(portMin, portMax)
    })

    ipcMain.handle('bridge-connect', async (_event, host: string, port: number) => {
      return this.connect(host, port)
    })

    ipcMain.handle('bridge-disconnect', () => {
      this.disconnect()
    })

    ipcMain.handle('bridge-send', (_event, json: string) => {
      this.send(json)
    })
  }

  // ─── Port scanning ────────────────────────────────────

  private scanPorts(portMin: number, portMax: number): Promise<DetectedPlugin[]> {
    const timeout = 500 // ms per port probe
    const detected: DetectedPlugin[] = []
    const probes: Promise<void>[] = []

    for (let port = portMin; port <= portMax; port++) {
      probes.push(this.probePort('127.0.0.1', port, timeout).then((plugin) => {
        if (plugin) detected.push(plugin)
      }))
    }

    return Promise.all(probes).then(() => detected)
  }

  private probePort(host: string, port: number, timeoutMs: number): Promise<DetectedPlugin | null> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      const decoder = new FrameDecoder()
      let resolved = false

      const cleanup = () => {
        if (!resolved) {
          resolved = true
          socket.destroy()
          resolve(null)
        }
      }

      const timer = setTimeout(cleanup, timeoutMs)

      socket.connect(port, host, () => {
        // Connected — wait for the plugin to send a 'connected' message
      })

      socket.on('data', (chunk) => {
        const frames = decoder.feed(chunk)
        for (const json of frames) {
          try {
            const msg = JSON.parse(json)
            if (msg.type === 'connected' && !resolved) {
              resolved = true
              clearTimeout(timer)
              socket.destroy()
              resolve({
                host,
                port,
                pluginName: msg.pluginName || 'Unknown Plugin',
                bridgeVersion: msg.bridgeVersion || '0.0.0',
                jucePluginVersion: msg.jucePluginVersion || '0.0.0',
              })
            }
          } catch {
            // Malformed JSON — not a SynthSkin bridge
          }
        }
      })

      socket.on('error', cleanup)
      socket.on('timeout', cleanup)
    })
  }

  // ─── Connection ───────────────────────────────────────

  private connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.disconnect()
      }

      this.decoder.reset()
      const socket = new net.Socket()
      socket.setNoDelay(true)

      const connectTimeout = setTimeout(() => {
        socket.destroy()
        reject(new Error(`Connection timed out to ${host}:${port}`))
      }, 3000)

      socket.connect(port, host, () => {
        clearTimeout(connectTimeout)
        this.socket = socket
        resolve()
      })

      socket.on('data', (chunk) => {
        const frames = this.decoder.feed(chunk)
        for (const json of frames) {
          this.handlePluginMessage(json)
        }
      })

      socket.on('error', (err) => {
        clearTimeout(connectTimeout)
        this.forwardToRenderer('bridge-error', { message: err.message })
        this.socket = null
        this.decoder.reset()
      })

      socket.on('close', () => {
        this.forwardToRenderer('bridge-closed', {})
        this.socket = null
        this.decoder.reset()
      })
    })
  }

  private disconnect() {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
      this.decoder.reset()
    }
  }

  private send(json: string) {
    if (!this.socket || this.socket.destroyed) return
    this.socket.write(encodeFrame(json))
  }

  // ─── Message routing ──────────────────────────────────

  private handlePluginMessage(json: string) {
    try {
      const msg = JSON.parse(json)
      // Forward every plugin message to the renderer
      this.forwardToRenderer('bridge-message', msg)
    } catch {
      // Ignore malformed messages
    }
  }

  private forwardToRenderer(channel: string, data: unknown) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  /** Clean up on app quit */
  destroy() {
    this.disconnect()
  }
}
