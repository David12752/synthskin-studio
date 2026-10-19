/**
 * PanelEditToolbar — floating bottom toolbar for alignment, distribute,
 * undo/redo, and bulk operations in the panel analysis edit mode.
 */
import { usePanelLayoutStore } from '../../stores/panelLayoutStore'

export default function PanelEditToolbar() {
  const selectedCount   = usePanelLayoutStore((s) => s.selectedControlIds.size)
  const alignSelected   = usePanelLayoutStore((s) => s.alignSelected)
  const distributeSelected = usePanelLayoutStore((s) => s.distributeSelected)
  const undo            = usePanelLayoutStore((s) => s.undo)
  const redo            = usePanelLayoutStore((s) => s.redo)
  const undoAvail       = usePanelLayoutStore((s) => s.undoStack.length > 0)
  const redoAvail       = usePanelLayoutStore((s) => s.redoStack.length > 0)
  const deleteSelected  = usePanelLayoutStore((s) => s.deleteSelected)
  const duplicateSelected = usePanelLayoutStore((s) => s.duplicateSelected)
  const pushUndo        = usePanelLayoutStore((s) => s.pushUndo)
  const copySelected    = usePanelLayoutStore((s) => s.copySelected)
  const paste           = usePanelLayoutStore((s) => s.paste)
  const hasClipboard    = usePanelLayoutStore((s) => s.clipboard.length > 0)

  const multi = selectedCount >= 2
  const triPlus = selectedCount >= 3

  const btn = (label: string, title: string, onClick: () => void, enabled: boolean) => (
    <button
      onClick={onClick}
      disabled={!enabled}
      title={title}
      className="text-[10px] px-1.5 py-1 rounded bg-white/5 border border-white/10 text-white/70 
        hover:bg-white/10 hover:text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
    >
      {label}
    </button>
  )

  return (
    <div
      className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 rounded-lg bg-black/80 border border-white/15 px-2 py-1.5 shadow-xl backdrop-blur-sm"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Undo / Redo */}
      <div className="flex items-center gap-0.5 pr-2 border-r border-white/10">
        {btn('↩', 'Undo (Ctrl+Z)', undo, undoAvail)}
        {btn('↪', 'Redo (Ctrl+Shift+Z)', redo, redoAvail)}
      </div>

      {/* Clipboard */}
      <div className="flex items-center gap-0.5 px-2 border-r border-white/10">
        {btn('⎘', 'Duplicate (Ctrl+D)', () => { pushUndo(); duplicateSelected() }, selectedCount > 0)}
        {btn('📋', 'Copy (Ctrl+C)', copySelected, selectedCount > 0)}
        {btn('📌', 'Paste (Ctrl+V)', () => paste(), hasClipboard)}
        {btn('✕', 'Delete (Del)', deleteSelected, selectedCount > 0)}
      </div>

      {/* Alignment */}
      <div className="flex items-center gap-0.5 px-2 border-r border-white/10">
        <span className="text-[9px] text-white/30 pr-1">Align</span>
        {btn('⫍', 'Align left', () => alignSelected('left'), multi)}
        {btn('⫎', 'Align right', () => alignSelected('right'), multi)}
        {btn('⊤', 'Align top', () => alignSelected('top'), multi)}
        {btn('⊥', 'Align bottom', () => alignSelected('bottom'), multi)}
        {btn('⫠', 'Center horizontal', () => alignSelected('centerH'), multi)}
        {btn('⫡', 'Center vertical', () => alignSelected('centerV'), multi)}
      </div>

      {/* Distribute */}
      <div className="flex items-center gap-0.5 pl-2">
        <span className="text-[9px] text-white/30 pr-1">Dist</span>
        {btn('⇔', 'Distribute horizontally', () => distributeSelected('horizontal'), triPlus)}
        {btn('⇕', 'Distribute vertically', () => distributeSelected('vertical'), triPlus)}
      </div>

      {/* Selection count */}
      {selectedCount > 0 && (
        <span className="text-[9px] text-white/30 font-mono pl-2">{selectedCount} sel</span>
      )}
    </div>
  )
}
