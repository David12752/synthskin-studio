import { useState, useRef, useEffect } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useHistoryStore } from '../../stores/historyStore'

export default function FileMenu() {
  const projectName = useProjectStore((s) => s.projectName)
  const recentProjects = useProjectStore((s) => s.recentProjects)
  const newProject = useProjectStore((s) => s.newProject)
  const saveProject = useProjectStore((s) => s.saveProject)
  const saveProjectAs = useProjectStore((s) => s.saveProjectAs)
  const openProject = useProjectStore((s) => s.openProject)
  const openProjectFromPath = useProjectStore((s) => s.openProjectFromPath)
  const pastLen = useHistoryStore((s) => s.past.length)
  const futureLen = useHistoryStore((s) => s.future.length)
  const undo = useHistoryStore((s) => s.undo)
  const redo = useHistoryStore((s) => s.redo)

  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-muted hover:text-neutral-200 hover:bg-surface-3 px-2 py-1 rounded transition-colors"
      >
        File
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-0.5 w-56 bg-surface-2 border border-surface-4 rounded-xl context-menu-shadow z-50 py-1.5">
          <MenuItem label="New Project" shortcut="Ctrl+N" onClick={() => { newProject(); setOpen(false) }} />
          <MenuItem label="Open…" shortcut="Ctrl+O" onClick={() => { openProject(); setOpen(false) }} />
          <div className="h-px bg-surface-4 my-1 mx-2" />
          <MenuItem label="Save" shortcut="Ctrl+S" onClick={() => { saveProject(); setOpen(false) }} />
          <MenuItem label="Save As…" shortcut="Ctrl+Shift+S" onClick={() => { saveProjectAs(); setOpen(false) }} />
          <div className="h-px bg-surface-4 my-1 mx-2" />
          <MenuItem label="Undo" shortcut="Ctrl+Z" onClick={() => { undo(); setOpen(false) }} disabled={pastLen === 0} />
          <MenuItem label="Redo" shortcut="Ctrl+Y" onClick={() => { redo(); setOpen(false) }} disabled={futureLen === 0} />
          {recentProjects.length > 0 && (
            <>
              <div className="h-px bg-surface-4 my-1 mx-2" />
              <div className="px-3 py-1 text-[9px] text-muted uppercase tracking-wider">Recent</div>
              {recentProjects.slice(0, 5).map((rp) => (
                <button
                  key={rp.path}
                  onClick={() => { openProjectFromPath(rp.path); setOpen(false) }}
                  className="w-full text-left px-3 py-1 text-[11px] text-neutral-400 hover:bg-surface-3 hover:text-neutral-200 truncate rounded-md mx-1"
                  style={{ width: 'calc(100% - 8px)' }}
                  title={rp.path}
                >
                  {rp.name}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({ label, shortcut, onClick, disabled }: {
  label: string; shortcut?: string; onClick: () => void; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center justify-between px-3 py-1 text-[11px] rounded-md mx-1 transition-colors
        ${disabled
          ? 'text-neutral-700 cursor-default'
          : 'text-neutral-300 hover:bg-accent/10 hover:text-neutral-100'
        }`}
      style={{ width: 'calc(100% - 8px)' }}
    >
      <span>{label}</span>
      {shortcut && <span className="text-muted font-mono text-[10px]">{shortcut}</span>}
    </button>
  )
}
