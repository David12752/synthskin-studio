import { type ReactNode } from 'react'
import StepRail from './StepRail'
import ResizablePanel from './ResizablePanel'
import CommandPalette from './CommandPalette'
import StatusBar from '../ui/StatusBar'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useShortcutDispatcher } from '../../hooks/useKeyboardShortcuts'
import { useProjectStore } from '../../stores/projectStore'

function SettingsButton() {
  const openSettings = useWorkspaceStore((s) => s.openSettings)
  return (
    <button
      onClick={openSettings}
      title="Settings"
      className="w-6 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-surface-3 transition-colors shrink-0"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  )
}

interface WorkspaceShellProps {
  /** Toolbar content — changes per workspace */
  toolbar?: ReactNode
  /** Left panel content */
  leftPanel?: ReactNode
  /** Right panel content */
  rightPanel?: ReactNode
  /** Bottom panel content */
  bottomPanel?: ReactNode
  /** Center canvas/editor content (fills remaining space) */
  children: ReactNode
}

export default function WorkspaceShell({
  toolbar,
  leftPanel,
  rightPanel,
  bottomPanel,
  children,
}: WorkspaceShellProps) {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const isTransitioning = useWorkspaceStore((s) => s.isTransitioning)
  const fullscreenMode = useWorkspaceStore((s) => s.fullscreenMode)
  const distractionFree = useWorkspaceStore((s) => s.distractionFree)
  const projectName = useProjectStore((s) => s.projectName)
  const isDirty = useProjectStore((s) => s.isDirty)

  // Activate the global shortcut dispatcher
  useShortcutDispatcher()

  // Fullscreen mode: only canvas
  if (fullscreenMode) {
    return (
      <div className="h-screen w-screen flex flex-col bg-surface-0 text-neutral-300 select-none overflow-hidden font-display">
        <div className="flex-1 min-h-0 min-w-0">
          {children}
        </div>
        <CommandPalette />
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-0 text-neutral-300 select-none overflow-hidden font-display">
      {/* ─── Title Bar (32px) ─── */}
      {!distractionFree && (
        <header className="h-8 flex items-center px-3 bg-surface-2 border-b border-surface-4 shrink-0 drag-region gap-2">
          {/* App branding */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-semibold tracking-wide text-accent">
              SynthSkin Studio
            </span>
          </div>

          {/* Center: linear step rail (Extract → Arrange → Export) */}
          <div className="flex-1 flex justify-center">
            <StepRail />
          </div>

          {/* Right: Project name + status + settings */}
          <div className="flex items-center gap-3 text-[10px] text-muted font-mono shrink-0">
            <span className="text-neutral-500 truncate max-w-[200px]">
              {projectName}{isDirty ? ' •' : ''}
            </span>
            <SettingsButton />
          </div>
        </header>
      )}

      {/* ─── Workspace Toolbar (44px) ─── */}
      {!distractionFree && toolbar && (
        <div className="h-11 flex items-center px-2 gap-1 bg-surface-2 border-b border-surface-4 shrink-0
          bg-gradient-to-b from-[#211f1d] to-surface-2">
          {toolbar}
        </div>
      )}

      {/* ─── Main Content Area ─── */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Top: Left Panel + Center + Right Panel */}
        <div className="flex-1 flex min-h-0">
          {/* Left Panel */}
          {leftPanel && (
            <ResizablePanel side="left" mountWhenCollapsed>
              {leftPanel}
            </ResizablePanel>
          )}

          {/* Center Canvas */}
          <div
            className={`
              flex-1 min-w-0 min-h-0 relative bg-canvas canvas-noise
              transition-opacity duration-150 ease-out
              ${isTransitioning ? 'opacity-0' : 'opacity-100'}
            `}
          >
            {children}
          </div>

          {/* Right Panel */}
          {rightPanel && (
            <ResizablePanel side="right" mountWhenCollapsed>
              {rightPanel}
            </ResizablePanel>
          )}
        </div>

        {/* Bottom Panel */}
        {bottomPanel && (
          <ResizablePanel side="bottom">
            {bottomPanel}
          </ResizablePanel>
        )}
      </div>

      {/* ─── Status Bar (24px) ─── */}
      {!distractionFree && <StatusBar />}

      {/* ─── Command Palette (floating) ─── */}
      <CommandPalette />
    </div>
  )
}
