import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { getAllCommands, formatShortcut, type ShortcutDef } from '../../hooks/useKeyboardShortcuts'
import { useWorkspaceStore } from '../../stores/workspaceStore'

const STORAGE_KEY = 'synthskin-recent-commands'
const MAX_RECENT = 8

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveRecent(labels: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(labels.slice(0, MAX_RECENT)))
  } catch { /* ignore */ }
}

// Simple fuzzy match with scoring
function fuzzyMatch(query: string, text: string): { match: boolean; score: number } {
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  // Exact substring match = high score
  if (t.includes(q)) return { match: true, score: 100 - t.indexOf(q) }

  // Fuzzy: each query char must appear in order
  let qi = 0
  let score = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '-') ? 10 : 1
      qi++
    }
  }
  return { match: qi === q.length, score }
}

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [recentLabels, setRecentLabels] = useState<string[]>(loadRecent)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  // Open with Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setIsOpen(prev => !prev)
        setQuery('')
        setSelectedIndex(0)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // Focus input when opening
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen])

  const allCommands = useMemo(() => getAllCommands(), [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredCommands = useMemo(() => {
    // Filter to current workspace + global
    const relevant = allCommands.filter(
      cmd => !cmd.workspace || cmd.workspace === activeWorkspace
    )

    if (!query.trim()) {
      // Show recent first, then all
      const recent: ShortcutDef[] = []
      const rest: ShortcutDef[] = []
      for (const cmd of relevant) {
        if (recentLabels.includes(cmd.label)) {
          recent.push(cmd)
        } else {
          rest.push(cmd)
        }
      }
      // Sort recent by their order in recentLabels
      recent.sort((a, b) => recentLabels.indexOf(a.label) - recentLabels.indexOf(b.label))
      return { recent, results: rest }
    }

    const scored = relevant
      .map(cmd => {
        const { match, score } = fuzzyMatch(query, cmd.label)
        const catMatch = cmd.category ? fuzzyMatch(query, cmd.category) : { match: false, score: 0 }
        return { cmd, match: match || catMatch.match, score: Math.max(score, catMatch.score) }
      })
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score)
      .map(r => r.cmd)

    return { recent: [], results: scored }
  }, [query, allCommands, activeWorkspace, recentLabels])

  const allResults = useMemo(
    () => [...filteredCommands.recent, ...filteredCommands.results],
    [filteredCommands]
  )

  // Clamp selected index
  useEffect(() => {
    setSelectedIndex(i => Math.min(i, Math.max(0, allResults.length - 1)))
  }, [allResults.length])

  const executeCommand = useCallback((cmd: ShortcutDef) => {
    cmd.action()
    setIsOpen(false)
    setQuery('')
    // Track recent
    const updated = [cmd.label, ...recentLabels.filter(l => l !== cmd.label)].slice(0, MAX_RECENT)
    setRecentLabels(updated)
    saveRecent(updated)
  }, [recentLabels])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, allResults.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (allResults[selectedIndex]) {
          executeCommand(allResults[selectedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        break
    }
  }, [allResults, selectedIndex, executeCommand])

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[9999] cmd-palette-backdrop flex items-start justify-center pt-[15vh]"
      onClick={() => setIsOpen(false)}
    >
      <div
        className="w-[600px] max-h-[500px] bg-surface-2 rounded-3xl overflow-hidden flex flex-col
          shadow-[0_8px_48px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,170,51,0.12),0_0_80px_rgba(255,170,51,0.04)]
          animate-[cmdPaletteIn_200ms_ease-out]"
        onClick={e => e.stopPropagation()}
        style={{
          animation: 'cmdPaletteIn 200ms ease-out',
        }}
      >
        {/* Search input */}
        <div className="px-5 py-3 border-b border-surface-4">
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIndex(0) }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="w-full bg-transparent text-[16px] text-neutral-200 placeholder-muted
              outline-none font-display"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {filteredCommands.recent.length > 0 && (
            <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-[1px] text-muted">
              Recent
            </div>
          )}
          {filteredCommands.recent.map((cmd, i) => (
            <CommandRow
              key={`recent-${cmd.label}`}
              cmd={cmd}
              isSelected={selectedIndex === i}
              onSelect={() => executeCommand(cmd)}
              onHover={() => setSelectedIndex(i)}
            />
          ))}

          {filteredCommands.results.length > 0 && (
            <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-[1px] text-muted">
              {query ? 'Results' : 'All Commands'}
            </div>
          )}
          {filteredCommands.results.map((cmd, i) => {
            const idx = filteredCommands.recent.length + i
            return (
              <CommandRow
                key={cmd.label}
                cmd={cmd}
                isSelected={selectedIndex === idx}
                onSelect={() => executeCommand(cmd)}
                onHover={() => setSelectedIndex(idx)}
              />
            )
          })}

          {allResults.length === 0 && (
            <div className="px-5 py-8 text-center text-muted text-[13px]">
              No matching commands
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes cmdPaletteIn {
          from { opacity: 0; transform: scale(0.95) translateY(-8px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  )
}

function CommandRow({ cmd, isSelected, onSelect, onHover }: {
  cmd: ShortcutDef
  isSelected: boolean
  onSelect: () => void
  onHover: () => void
}) {
  return (
    <button
      onClick={onSelect}
      onMouseEnter={onHover}
      className={`
        w-full flex items-center justify-between px-5 h-9 text-[13px]
        transition-colors duration-0
        ${isSelected
          ? 'bg-surface-3 border-l-2 border-accent text-neutral-100'
          : 'text-neutral-400 hover:bg-surface-3 border-l-2 border-transparent'
        }
      `}
    >
      <div className="flex items-center gap-2 min-w-0">
        {cmd.category && (
          <span className="text-muted text-[10px] uppercase tracking-wider shrink-0">
            {cmd.category}
          </span>
        )}
        <span className="truncate">{cmd.label}</span>
      </div>
      {cmd.key && (
        <span className="text-muted font-mono text-[11px] shrink-0 ml-4">
          {formatShortcut(cmd.key)}
        </span>
      )}
    </button>
  )
}
