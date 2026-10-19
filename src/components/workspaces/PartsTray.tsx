import { usePartsTrayStore } from '../../stores/partsTrayStore'

/**
 * PartsTray — the staging shelf for cut/imported parts (Phase 2).
 *
 * Mirrors ExtractAssetTray, but backed by partsTrayStore. Each thumbnail sits on
 * a checker so transparency reads. From here (Phase 3) parts get dragged onto
 * the compositing canvas.
 */
const CHECKER =
  'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 12px 12px'

export default function PartsTray() {
  const parts = usePartsTrayStore((s) => s.parts)
  const selectedId = usePartsTrayStore((s) => s.selectedPartId)
  const selectPart = usePartsTrayStore((s) => s.selectPart)
  const removePart = usePartsTrayStore((s) => s.removePart)
  const clear = usePartsTrayStore((s) => s.clear)

  return (
    <div className="h-full flex flex-col bg-surface-1">
      <div className="px-3 py-1.5 text-[11px] font-medium text-muted uppercase tracking-[1px] border-b border-surface-4 flex items-center justify-between shrink-0">
        <span>Parts Tray</span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-muted/60 font-mono">{parts.length} parts</span>
          {parts.length > 0 && (
            <button
              onClick={clear}
              className="text-[10px] text-muted/70 hover:text-red-400 uppercase tracking-wide"
              title="Clear all staged parts"
            >
              Clear
            </button>
          )}
        </span>
      </div>

      {parts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-muted/50 text-center px-3">
          Cut a region from any image — it stages here, ready to place
        </div>
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex items-stretch gap-1.5 p-2 h-full min-w-min">
            {parts.map((part) => (
              <button
                key={part.id}
                onClick={() => selectPart(part.id)}
                className={`
                  h-full aspect-square rounded-lg overflow-hidden border transition-all relative group shrink-0
                  ${selectedId === part.id
                    ? 'border-accent bg-accent/10 ring-1 ring-accent/30'
                    : 'border-surface-4 bg-surface-2 hover:border-muted'
                  }
                `}
              >
                <div className="w-full h-full" style={{ background: CHECKER }}>
                  <img
                    src={part.dataUrl}
                    alt={part.name}
                    className="w-full h-full object-contain p-1.5"
                    draggable={false}
                  />
                </div>
                {/* source badge */}
                <div className="absolute top-0.5 left-0.5 text-[7px] font-mono uppercase px-1 py-0.5 bg-surface-0/80 rounded text-muted leading-none">
                  {part.source.kind}
                </div>
                {/* name on hover */}
                <div className="absolute bottom-0 inset-x-0 bg-black/70 text-[8px] text-neutral-400 px-1 py-0.5 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                  {part.name}
                </div>
                {/* delete on hover */}
                <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); removePart(part.id) }}
                    className="w-4 h-4 rounded bg-surface-0/80 text-muted hover:text-red-400 flex items-center justify-center"
                    title="Remove part"
                  >
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
