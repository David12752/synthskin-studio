import { useCanvasStore } from '../../stores/canvasStore'
import { useImageStore } from '../../stores/imageStore'
import { useProjectStore } from '../../stores/projectStore'
import { useHistoryStore } from '../../stores/historyStore'
import { useExtractionStore } from '../../stores/extractionStore'
import { useEffect, useState } from 'react'

type ConnectionStatus = 'connecting' | 'connected' | 'restarting' | 'error'

export default function StatusBar() {
  const cursorX = useCanvasStore((s) => s.cursorX)
  const cursorY = useCanvasStore((s) => s.cursorY)
  const zoom = useCanvasStore((s) => s.zoom)
  const image = useImageStore((s) => s.sourceImage)
  const isDirty = useProjectStore((s) => s.isDirty)
  const lastAutoSave = useProjectStore((s) => s.lastAutoSave)
  const pastLen = useHistoryStore((s) => s.past.length)
  const futureLen = useHistoryStore((s) => s.future.length)
  const extract3dProgress = useExtractionStore((s) => s.extract3dProgress)
  const [pythonStatus, setPythonStatus] = useState<ConnectionStatus>('connecting')
  const [pythonPort, setPythonPort] = useState(0)
  const [statusDetail, setStatusDetail] = useState('')

  // Initial health check
  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const port = await window.synthskin.getPythonPort()
        if (cancelled) return
        if (port) setPythonPort(port)
        const ok = await window.synthskin.getPythonHealth()
        if (!cancelled) setPythonStatus(ok ? 'connected' : 'error')
      } catch {
        if (!cancelled) setPythonStatus('error')
      }
    }
    check()
    return () => { cancelled = true }
  }, [])

  // Live status events from main process
  useEffect(() => {
    if (!window.synthskin.onPythonStatus) return
    const unsub = window.synthskin.onPythonStatus((event) => {
      switch (event.status) {
        case 'running':
          setPythonStatus('connected')
          if (event.port) setPythonPort(event.port)
          setStatusDetail('')
          break
        case 'crashed':
          setPythonStatus('restarting')
          setStatusDetail(`crash · restart ${event.restartAttempt ?? '?'}/3`)
          break
        case 'restarting':
          setPythonStatus('restarting')
          setStatusDetail(`restarting… (${event.attempt ?? '?'}/3)`)
          break
        case 'failed':
          setPythonStatus('error')
          setStatusDetail(event.reason ?? 'failed')
          break
        case 'stopped':
          setPythonStatus('error')
          setStatusDetail('')
          break
      }
    })
    return unsub
  }, [])

  const statusColor =
    pythonStatus === 'connected'
      ? 'bg-emerald-500'
      : pythonStatus === 'restarting'
        ? 'bg-amber-500 animate-pulse'
        : pythonStatus === 'connecting'
          ? 'bg-amber-500 animate-pulse'
          : 'bg-red-500'

  const statusLabel =
    pythonStatus === 'connected'
      ? `Python :${pythonPort}`
      : pythonStatus === 'restarting'
        ? statusDetail || 'Restarting…'
        : pythonStatus === 'connecting'
          ? 'Connecting…'
          : statusDetail ? `Python: ${statusDetail}` : 'Python offline'

  return (
    <footer className="h-6 flex items-center px-3 bg-surface-0 border-t border-surface-4 text-[10px] font-mono shrink-0 gap-4">
      {/* Python status */}
      <div className="flex items-center gap-1.5" title={statusLabel}>
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${statusColor}`} />
        <span className="text-neutral-500 max-w-[160px] truncate">{statusLabel}</span>
      </div>

      {/* Dirty indicator */}
      {isDirty && (
        <span className="text-amber-500/80">unsaved</span>
      )}

      {/* Auto-save status */}
      {lastAutoSave && (
        <span className="text-neutral-600" title={`Last auto-save: ${lastAutoSave}`}>
          auto-saved
        </span>
      )}

      {/* Undo/Redo counts */}
      {(pastLen > 0 || futureLen > 0) && (
        <span className="text-neutral-600">
          undo:{pastLen} redo:{futureLen}
        </span>
      )}

      {/* Commercial-safe 3D extraction progress pill */}
      {extract3dProgress && (
        <div
          className={`flex items-center gap-1.5 px-2 py-[1px] rounded-full border text-[10px] ${
            extract3dProgress.stage === 'error'
              ? 'border-red-500/40 bg-red-500/10 text-red-400'
              : extract3dProgress.stage === 'done'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : 'border-accent/40 bg-accent/10 text-accent'
          }`}
          title={`3D extraction · ${extract3dProgress.stage}`}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              extract3dProgress.stage === 'done'
                ? 'bg-emerald-400'
                : extract3dProgress.stage === 'error'
                  ? 'bg-red-400'
                  : 'bg-accent animate-pulse'
            }`}
          />
          <span className="truncate max-w-[240px]">{extract3dProgress.message}</span>
          {extract3dProgress.stage !== 'error' && (
            <span className="text-muted/70 font-mono">{Math.round(extract3dProgress.percent)}%</span>
          )}
        </div>
      )}

      {/* Pixel coordinates */}
      <span className="text-neutral-500">
        {Math.round(cursorX)}, {Math.round(cursorY)}
      </span>

      <div className="flex-1" />

      {/* Image dimensions */}
      {image && (
        <span className="text-neutral-600">
          {image.width} × {image.height}
        </span>
      )}

      {/* Zoom level */}
      <span className="text-neutral-500">
        {Math.round(zoom * 100)}%
      </span>
    </footer>
  )
}
