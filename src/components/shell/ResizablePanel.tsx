import { useCallback, useRef, useEffect, type ReactNode } from 'react'
import { useWorkspaceStore, PANEL_CONSTRAINTS } from '../../stores/workspaceStore'

interface ResizablePanelProps {
  side: 'left' | 'right' | 'bottom'
  children: ReactNode
  /** Keep children mounted in DOM even when collapsed (prevents remount on workspace switch). */
  mountWhenCollapsed?: boolean
}

export default function ResizablePanel({ side, children, mountWhenCollapsed = false }: ResizablePanelProps) {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const panelSizes = useWorkspaceStore((s) => s.panelSizes[s.activeWorkspace])
  const setLeftWidth = useWorkspaceStore((s) => s.setLeftWidth)
  const setRightWidth = useWorkspaceStore((s) => s.setRightWidth)
  const setBottomHeight = useWorkspaceStore((s) => s.setBottomHeight)
  const resetPanelSize = useWorkspaceStore((s) => s.resetPanelSize)

  const isCollapsed = side === 'left' ? panelSizes.leftCollapsed
    : side === 'right' ? panelSizes.rightCollapsed
    : panelSizes.bottomCollapsed

  const size = side === 'left' ? panelSizes.leftWidth
    : side === 'right' ? panelSizes.rightWidth
    : panelSizes.bottomHeight

  const dividerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    startPos.current = side === 'bottom' ? e.clientY : e.clientX
    startSize.current = size
    dividerRef.current?.classList.add('dragging')
    document.body.style.cursor = side === 'bottom' ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
  }, [side, size])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = side === 'bottom'
        ? startPos.current - e.clientY  // bottom grows upward
        : side === 'left'
          ? e.clientX - startPos.current
          : startPos.current - e.clientX  // right grows leftward
      const newSize = startSize.current + delta
      if (side === 'left') setLeftWidth(newSize)
      else if (side === 'right') setRightWidth(newSize)
      else setBottomHeight(newSize)
    }

    const handleMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      dividerRef.current?.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [side, setLeftWidth, setRightWidth, setBottomHeight])

  const handleDoubleClick = useCallback(() => {
    resetPanelSize(side)
  }, [resetPanelSize, side])

  if (isCollapsed) {
    // Keep children in the DOM but invisible so they don't lose state
    if (mountWhenCollapsed) {
      return <div style={{ width: 0, height: 0, overflow: 'hidden', flexShrink: 0 }}>{children}</div>
    }
    return null
  }

  const isHorizontal = side === 'left' || side === 'right'
  const dividerClass = isHorizontal ? 'panel-divider panel-divider-h' : 'panel-divider panel-divider-v'

  // Build the panel + divider, divider position depends on side
  const panel = (
    <div
      className="bg-surface-1 overflow-hidden flex-shrink-0"
      style={isHorizontal ? { width: size } : { height: size }}
    >
      {children}
    </div>
  )

  const divider = (
    <div
      ref={dividerRef}
      className={dividerClass}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    />
  )

  if (side === 'left') {
    return <>{panel}{divider}</>
  }
  if (side === 'right') {
    return <>{divider}{panel}</>
  }
  // bottom
  return (
    <div className="flex flex-col flex-shrink-0" style={{ height: size + 4 }}>
      {divider}
      <div className="bg-surface-1 flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  )
}
