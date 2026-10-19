import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import net from 'net'

export type PythonStatusEvent =
  | { status: 'starting' }
  | { status: 'running'; port: number }
  | { status: 'crashed'; code: number | null; restartAttempt: number }
  | { status: 'restarting'; attempt: number }
  | { status: 'failed'; reason: string }
  | { status: 'stopped' }

export class PythonBridge {
  private process: ChildProcess | null = null
  private port = 0
  private restartAttempts = 0
  private maxRestartAttempts = 3
  private intentionallyStopped = false
  onStatusChange: ((event: PythonStatusEvent) => void) | null = null

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          const port = addr.port
          server.close(() => resolve(port))
        } else {
          reject(new Error('Could not find free port'))
        }
      })
      server.on('error', reject)
    })
  }

  private resolvePython(): string {
    const pythonDir = path.join(__dirname, '..', 'python')
    const isWin = process.platform === 'win32'
    const venvPython = isWin
      ? path.join(pythonDir, '.venv', 'Scripts', 'python.exe')
      : path.join(pythonDir, '.venv', 'bin', 'python')

    if (existsSync(venvPython)) {
      return venvPython
    }

    console.warn('[PythonBridge] venv not found, falling back to system Python')
    return isWin ? 'python' : 'python3'
  }

  async start(): Promise<number> {
    this.port = await this.findFreePort()
    this.intentionallyStopped = false

    const pythonDir = path.join(__dirname, '..', 'python')
    const pythonExe = this.resolvePython()
    const serverScript = path.join(pythonDir, 'server.py')

    if (!existsSync(serverScript)) {
      throw new Error(`Python server script not found: ${serverScript}`)
    }

    console.log(`[PythonBridge] Starting: ${pythonExe} ${serverScript} --port ${this.port}`)

    this.process = spawn(pythonExe, [serverScript, '--port', String(this.port)], {
      cwd: pythonDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`[Python] ${data.toString().trim()}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[Python] ${data.toString().trim()}`)
    })

    this.process.on('exit', (code) => {
      console.log(`[PythonBridge] Process exited with code ${code}`)
      const wasRunning = this.process !== null
      this.process = null

      if (!this.intentionallyStopped && wasRunning) {
        const attempt = ++this.restartAttempts
        if (attempt <= this.maxRestartAttempts) {
          console.log(`[PythonBridge] Auto-restarting (attempt ${attempt}/${this.maxRestartAttempts})…`)
          this.onStatusChange?.({ status: 'crashed', code, restartAttempt: attempt })
          setTimeout(() => {
            if (!this.intentionallyStopped) {
              this.onStatusChange?.({ status: 'restarting', attempt })
              this.start().then((p) => {
                this.onStatusChange?.({ status: 'running', port: p })
              }).catch((err: unknown) => {
                const reason = err instanceof Error ? err.message : String(err)
                this.onStatusChange?.({ status: 'failed', reason })
              })
            }
          }, 1000 * attempt) // backoff: 1s, 2s, 3s
        } else {
          console.error('[PythonBridge] Max restart attempts reached. Giving up.')
          this.onStatusChange?.({ status: 'failed', reason: `Crashed ${attempt} times. Restart manually.` })
        }
      }
    })

    await this.waitForReady()
    return this.port
  }

  async restart(): Promise<number> {
    await this.stop()
    this.restartAttempts = 0
    return this.start()
  }

  private async waitForReady(maxRetries = 60, delayMs = 1000): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      const healthy = await this.healthCheck()
      if (healthy) return
      await new Promise((r) => setTimeout(r, delayMs))
    }
    // Sidecar is still starting (common on cold start with ML imports on Windows).
    // Don't throw — instead launch a background poller so the renderer unblocks
    // automatically once Python is actually ready.
    console.warn(
      `[PythonBridge] Sidecar not ready after ${maxRetries * delayMs / 1000}s — ` +
      'continuing with background health poll.',
    )
    this.pollUntilReady()
  }

  /** Background poller used when the initial wait times out. */
  private pollUntilReady(intervalMs = 2000): void {
    const id = setInterval(async () => {
      if (this.intentionallyStopped || !this.process) {
        clearInterval(id)
        return
      }
      const healthy = await this.healthCheck()
      if (healthy) {
        clearInterval(id)
        console.log(`[PythonBridge] Sidecar now healthy on port ${this.port} (background poll)`)
        this.onStatusChange?.({ status: 'running', port: this.port })
      }
    }, intervalMs)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}/health`)
      return resp.ok
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    this.intentionallyStopped = true
    if (!this.process) return

    try {
      await fetch(`http://127.0.0.1:${this.port}/shutdown`, { method: 'POST' })
    } catch {
      // Server might already be down
    }

    if (this.process && !this.process.killed) {
      this.process.kill()
    }
    this.process = null
    console.log('[PythonBridge] Stopped')
  }

  getPort(): number {
    return this.port
  }

  isAlive(): boolean {
    return this.process !== null && !this.process.killed
  }
}
