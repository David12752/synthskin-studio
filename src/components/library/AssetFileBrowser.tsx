import { useState, useEffect, useCallback, useRef } from 'react'

interface FileEntry {
  name: string
  isDirectory: boolean
  size: number
  modifiedAt: string
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif'])

function getExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx).toLowerCase() : ''
}

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(name))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface AssetFileBrowserProps {
  onOpenAsset?: (dataUrl: string, fileName: string) => void
}

export default function AssetFileBrowser({ onOpenAsset }: AssetFileBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string>('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [renamingName, setRenamingName] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [dragOverName, setDragOverName] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const newFolderInputRef = useRef<HTMLInputElement>(null)

  // Initialize with home directory
  useEffect(() => {
    window.synthskin.fsGetHome().then((home) => {
      setCurrentPath(home)
    })
  }, [])

  const loadDirectory = useCallback(async (dirPath: string) => {
    if (!dirPath) return
    setLoading(true)
    setError(null)
    setSelectedName(null)
    setRenamingName(null)
    setCreatingFolder(false)
    try {
      const result = await window.synthskin.fsListDir(dirPath)
      if (result.success && result.entries) {
        // Sort: directories first, then alphabetical
        const sorted = result.entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })
        setEntries(sorted)
      } else {
        setError(result.error || 'Failed to read directory')
        setEntries([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDirectory(currentPath)
  }, [currentPath, loadDirectory])

  const navigateUp = () => {
    const sep = currentPath.includes('/') ? '/' : '\\'
    const parts = currentPath.split(sep).filter(Boolean)
    if (parts.length > 1) {
      parts.pop()
      const parent = currentPath.startsWith('/') ? '/' + parts.join('/') : parts.join(sep) + sep
      setCurrentPath(parent)
    }
  }

  const navigateInto = (name: string) => {
    const sep = currentPath.includes('/') ? '/' : '\\'
    const newPath = currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name
    setCurrentPath(newPath)
  }

  const openFile = async (name: string) => {
    if (!isImageFile(name)) return
    const sep = currentPath.includes('/') ? '/' : '\\'
    const filePath = currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name
    try {
      const result = await window.synthskin.fsReadBinary(filePath)
      if (result.success && result.dataUrl) {
        onOpenAsset?.(result.dataUrl, name)
      }
    } catch { /* ignore */ }
  }

  const handleDelete = async () => {
    if (!selectedName) return
    const sep = currentPath.includes('/') ? '/' : '\\'
    const targetPath = currentPath.endsWith(sep) ? currentPath + selectedName : currentPath + sep + selectedName
    const result = await window.synthskin.fsDelete(targetPath)
    if (result.success) {
      loadDirectory(currentPath)
    }
  }

  const startRename = (name: string) => {
    setRenamingName(name)
    setRenameValue(name)
    setTimeout(() => renameInputRef.current?.select(), 10)
  }

  const commitRename = async () => {
    if (!renamingName || !renameValue.trim() || renameValue === renamingName) {
      setRenamingName(null)
      return
    }
    const sep = currentPath.includes('/') ? '/' : '\\'
    const base = currentPath.endsWith(sep) ? currentPath : currentPath + sep
    const result = await window.synthskin.fsRename(base + renamingName, base + renameValue.trim())
    if (result.success) {
      setRenamingName(null)
      loadDirectory(currentPath)
    }
  }

  const startCreateFolder = () => {
    setCreatingFolder(true)
    setNewFolderName('New Folder')
    setTimeout(() => newFolderInputRef.current?.select(), 10)
  }

  const commitCreateFolder = async () => {
    if (!newFolderName.trim()) {
      setCreatingFolder(false)
      return
    }
    const sep = currentPath.includes('/') ? '/' : '\\'
    const base = currentPath.endsWith(sep) ? currentPath : currentPath + sep
    const result = await window.synthskin.fsCreateDir(base + newFolderName.trim())
    if (result.success) {
      setCreatingFolder(false)
      loadDirectory(currentPath)
    }
  }

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (renamingName || creatingFolder) return

    if (e.key === 'Delete' && selectedName) {
      e.preventDefault()
      handleDelete()
    } else if (e.key === 'F2' && selectedName) {
      e.preventDefault()
      startRename(selectedName)
    } else if (e.key === 'Enter' && selectedName) {
      e.preventDefault()
      const entry = entries.find(en => en.name === selectedName)
      if (entry?.isDirectory) navigateInto(selectedName)
      else if (entry && isImageFile(entry.name)) openFile(selectedName)
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      navigateUp()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const idx = entries.findIndex(en => en.name === selectedName)
      if (idx < entries.length - 1) setSelectedName(entries[idx + 1].name)
      else if (entries.length > 0) setSelectedName(entries[0].name)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = entries.findIndex(en => en.name === selectedName)
      if (idx > 0) setSelectedName(entries[idx - 1].name)
      else if (entries.length > 0) setSelectedName(entries[entries.length - 1].name)
    }
  }, [selectedName, renamingName, creatingFolder, entries, currentPath])

  // Handle drag drop
  const handleDragOver = (e: React.DragEvent, name: string) => {
    const entry = entries.find(en => en.name === name)
    if (entry?.isDirectory) {
      e.preventDefault()
      setDragOverName(name)
    }
  }

  const handleDragStart = (e: React.DragEvent, name: string) => {
    const sep = currentPath.includes('/') ? '/' : '\\'
    const base = currentPath.endsWith(sep) ? currentPath : currentPath + sep
    e.dataTransfer.setData('text/plain', base + name)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDrop = async (e: React.DragEvent, targetName: string) => {
    e.preventDefault()
    setDragOverName(null)
    const srcPath = e.dataTransfer.getData('text/plain')
    if (!srcPath) return
    const fileName = srcPath.split(/[/\\]/).pop()
    if (!fileName) return
    const sep = currentPath.includes('/') ? '/' : '\\'
    const base = currentPath.endsWith(sep) ? currentPath : currentPath + sep
    const destPath = base + targetName + sep + fileName
    const result = await window.synthskin.fsRename(srcPath, destPath)
    if (result.success) {
      loadDirectory(currentPath)
    }
  }

  const handleBrowseFolder = async () => {
    const result = await window.synthskin.showFolderDialog({ title: 'Select Asset Folder' })
    if (!result.canceled && result.folderPath) {
      setCurrentPath(result.folderPath)
    }
  }

  // Truncate path for display
  const displayPath = currentPath.length > 35
    ? '...' + currentPath.slice(-32)
    : currentPath

  return (
    <div className="h-full flex flex-col" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* Path bar */}
      <div className="px-2 py-1.5 border-b border-surface-4 flex items-center gap-1">
        <button onClick={navigateUp} title="Up (Backspace)"
          className="p-1 rounded hover:bg-surface-3 text-muted hover:text-white transition-colors shrink-0">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3L3 8l5 5M3 8h10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button onClick={handleBrowseFolder} title="Browse folder"
          className="p-1 rounded hover:bg-surface-3 text-muted hover:text-white transition-colors shrink-0">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6 3H3a1 1 0 00-1 1z" />
          </svg>
        </button>
        <span className="text-[9px] text-muted truncate flex-1" title={currentPath}>
          {displayPath}
        </span>
      </div>

      {/* Toolbar */}
      <div className="px-2 py-1 border-b border-surface-4 flex items-center gap-1">
        <button onClick={startCreateFolder} title="New Folder (Ctrl+Shift+N)"
          className="p-1 rounded hover:bg-surface-3 text-muted hover:text-white transition-colors text-[9px]">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6 3H3a1 1 0 00-1 1z" />
            <path d="M8 8v4M6 10h4" strokeLinecap="round" />
          </svg>
        </button>
        {selectedName && (
          <>
            <button onClick={() => startRename(selectedName)} title="Rename (F2)"
              className="p-1 rounded hover:bg-surface-3 text-muted hover:text-white transition-colors">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M11 2l3 3-8 8H3v-3l8-8z" strokeLinejoin="round" />
              </svg>
            </button>
            <button onClick={handleDelete} title="Delete (Del)"
              className="p-1 rounded hover:bg-red-900/30 text-muted hover:text-red-400 transition-colors">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}
        <button onClick={() => loadDirectory(currentPath)} title="Refresh"
          className="p-1 rounded hover:bg-surface-3 text-muted hover:text-white transition-colors ml-auto">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13 3a7 7 0 10.5 5" strokeLinecap="round" />
            <path d="M13 1v3h-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* New folder inline */}
      {creatingFolder && (
        <div className="px-2 py-1 border-b border-surface-4 flex items-center gap-1">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#f59e0b" strokeWidth="1.5" className="shrink-0">
            <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6 3H3a1 1 0 00-1 1z" />
          </svg>
          <input
            ref={newFolderInputRef}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCreateFolder()
              if (e.key === 'Escape') setCreatingFolder(false)
              e.stopPropagation()
            }}
            onBlur={commitCreateFolder}
            className="flex-1 bg-surface-2 border border-accent/50 rounded px-1.5 py-0.5 text-[10px] text-white outline-none"
            autoFocus
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-2 py-1 text-[9px] text-red-400 bg-red-900/10 border-b border-surface-4">
          {error}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#f59e0b" strokeWidth="2">
              <circle cx="8" cy="8" r="6" strokeDasharray="24" strokeDashoffset="8" />
            </svg>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-[10px] text-neutral-600 text-center py-6">Empty folder</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.name}
              draggable
              onDragStart={(e) => handleDragStart(e, entry.name)}
              onDragOver={(e) => handleDragOver(e, entry.name)}
              onDragLeave={() => setDragOverName(null)}
              onDrop={(e) => handleDrop(e, entry.name)}
              onClick={() => setSelectedName(entry.name)}
              onDoubleClick={() => {
                if (entry.isDirectory) navigateInto(entry.name)
                else if (isImageFile(entry.name)) openFile(entry.name)
              }}
              className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors text-[10px]
                ${selectedName === entry.name ? 'bg-accent/15 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-300'}
                ${dragOverName === entry.name ? 'bg-accent/25 ring-1 ring-accent/50' : ''}
              `}
            >
              {/* Icon */}
              {entry.isDirectory ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#f59e0b" strokeWidth="1.5" className="shrink-0">
                  <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6 3H3a1 1 0 00-1 1z" />
                </svg>
              ) : isImageFile(entry.name) ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#3b82f6" strokeWidth="1.5" className="shrink-0">
                  <rect x="2" y="2" width="12" height="12" rx="1" />
                  <circle cx="6" cy="6" r="1.5" />
                  <path d="M2 11l3-3 2 2 3-4 4 5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#6b7280" strokeWidth="1.5" className="shrink-0">
                  <path d="M4 2h5l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" />
                  <path d="M9 2v3h3" />
                </svg>
              )}

              {/* Name or rename input */}
              {renamingName === entry.name ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenamingName(null)
                    e.stopPropagation()
                  }}
                  onBlur={commitRename}
                  className="flex-1 bg-surface-2 border border-accent/50 rounded px-1 py-0 text-[10px] text-white outline-none"
                  autoFocus
                />
              ) : (
                <span className="flex-1 truncate">{entry.name}</span>
              )}

              {/* Size for files */}
              {!entry.isDirectory && (
                <span className="text-[8px] text-neutral-600 shrink-0">{formatSize(entry.size)}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
