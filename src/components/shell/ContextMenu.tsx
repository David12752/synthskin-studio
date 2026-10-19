import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { formatShortcut } from '../../hooks/useKeyboardShortcuts'

export interface ContextMenuItem {
  type: 'item' | 'separator' | 'submenu'
  label?: string
  shortcut?: string
  icon?: ReactNode
  disabled?: boolean
  destructive?: boolean
  onClick?: () => void
  children?: ContextMenuItem[]
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  position: { x: number; y: number }
  onClose: () => void
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState(position)
  const [submenuOpen, setSubmenuOpen] = useState<string | null>(null)
  const [submenuPos, setSubmenuPos] = useState({ x: 0, y: 0 })

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    let { x, y } = position
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8
    if (x < 8) x = 8
    if (y < 8) y = 8
    setAdjustedPos({ x, y })
  }, [position])

  // Close on click outside or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const handleSubmenuEnter = useCallback((label: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setSubmenuOpen(label)
    setSubmenuPos({ x: rect.right - 2, y: rect.top })
  }, [])

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[10000] bg-surface-2 rounded-xl p-2 min-w-[220px] context-menu-shadow border border-surface-4/50"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
    >
      {items.map((item, i) => {
        if (item.type === 'separator') {
          return <div key={i} className="h-px bg-surface-4 my-1 mx-2" />
        }

        if (item.type === 'submenu') {
          return (
            <div
              key={item.label}
              className="relative"
              onMouseEnter={(e) => handleSubmenuEnter(item.label!, e.currentTarget)}
              onMouseLeave={() => setSubmenuOpen(null)}
            >
              <div className="flex items-center justify-between px-3 h-7 rounded-md text-[12px] text-neutral-300 hover:bg-accent/10 hover:text-neutral-100 cursor-default">
                <span>{item.label}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 2l4 3-4 3" />
                </svg>
              </div>
              {submenuOpen === item.label && item.children && (
                <div
                  className="fixed bg-surface-2 rounded-xl p-2 min-w-[180px] context-menu-shadow border border-surface-4/50"
                  style={{ left: submenuPos.x, top: submenuPos.y }}
                >
                  {item.children.map((child, ci) => (
                    <ContextMenuItemRow key={ci} item={child} onClose={onClose} />
                  ))}
                </div>
              )}
            </div>
          )
        }

        return <ContextMenuItemRow key={i} item={item} onClose={onClose} />
      })}
    </div>,
    document.body
  )
}

function ContextMenuItemRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  if (item.type === 'separator') {
    return <div className="h-px bg-surface-4 my-1 mx-2" />
  }

  return (
    <button
      onClick={() => {
        if (item.disabled) return
        item.onClick?.()
        onClose()
      }}
      disabled={item.disabled}
      className={`
        w-full flex items-center justify-between px-3 h-7 rounded-md text-[12px]
        transition-colors duration-0
        ${item.disabled
          ? 'text-neutral-700 cursor-default'
          : item.destructive
            ? 'text-red-400/70 hover:bg-red-500/10 hover:text-red-400'
            : 'text-neutral-300 hover:bg-accent/10 hover:text-neutral-100'
        }
      `}
    >
      <div className="flex items-center gap-2">
        {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
        <span>{item.label}</span>
      </div>
      {item.shortcut && (
        <span className="text-muted font-mono text-[10px] ml-4">
          {formatShortcut(item.shortcut)}
        </span>
      )}
    </button>
  )
}

/** Hook: attach context menu to an element */
export function useContextMenu(items: ContextMenuItem[] | (() => ContextMenuItem[])) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const close = useCallback(() => setMenu(null), [])

  const resolvedItems = typeof items === 'function' ? items() : items

  const menuElement = menu ? (
    <ContextMenu items={resolvedItems} position={menu} onClose={close} />
  ) : null

  return { onContextMenu, menuElement }
}
