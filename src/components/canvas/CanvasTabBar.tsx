import { useCanvasTabStore, type CanvasTab } from '../../stores/canvasTabStore'
import { useImageStore } from '../../stores/imageStore'
import { useCallback } from 'react'

export default function CanvasTabBar() {
  const tabs = useCanvasTabStore((s) => s.tabs)
  const activeTabId = useCanvasTabStore((s) => s.activeTabId)
  const setActiveTab = useCanvasTabStore((s) => s.setActiveTab)
  const removeTab = useCanvasTabStore((s) => s.removeTab)

  // All open images (multi-image tab support)
  const images = useImageStore((s) => s.images)
  const activeImageId = useImageStore((s) => s.activeImageId)
  const setActiveImage = useImageStore((s) => s.setActiveImage)
  const closeImage = useImageStore((s) => s.closeImage)

  const handleImageClose = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    closeImage(id)
  }, [closeImage])

  const handleAssetTabClose = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    removeTab(id)
  }, [removeTab])

  if (images.length === 0 && tabs.length === 0) return null

  return (
    <div className="flex items-center border-b border-surface-4 bg-surface-1 h-7 shrink-0 overflow-x-auto">
      {/* Image tabs — one per open source image */}
      {images.map((img) => {
        const isActive = img.id === activeImageId && (activeTabId === '__source__' || activeTabId === null)
        return (
          <button
            key={img.id}
            onClick={() => {
              setActiveImage(img.id)
              setActiveTab('__source__')
            }}
            className={`flex items-center gap-1 px-3 h-full text-[10px] transition-colors border-r border-surface-4 shrink-0 group ${
              isActive
                ? 'bg-surface-2 text-white border-b-2 border-b-accent'
                : 'text-muted hover:text-neutral-300 hover:bg-surface-2/50'
            }`}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
              <rect x="2" y="2" width="12" height="12" rx="1" />
              <circle cx="6" cy="6" r="1.5" />
              <path d="M2 11l3-3 2 2 3-4 4 5" />
            </svg>
            <span className="truncate max-w-[120px]">{img.path || 'Untitled'}</span>
            {/* Close button (show only if more than one image) */}
            {images.length > 1 && (
              <span
                onClick={(e) => handleImageClose(e, img.id)}
                className="ml-1 p-0.5 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M1 1l6 6M7 1l-6 6" />
                </svg>
              </span>
            )}
          </button>
        )
      })}

      {/* Separator between image and asset tabs */}
      {images.length > 0 && tabs.length > 0 && (
        <div className="w-px h-4 bg-surface-5 mx-0.5 shrink-0" />
      )}

      {/* Asset tabs */}
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`flex items-center gap-1 px-2 h-full text-[10px] transition-colors border-r border-surface-4 shrink-0 group ${
            activeTabId === tab.id
              ? 'bg-surface-2 text-white border-b-2 border-b-accent'
              : 'text-muted hover:text-neutral-300 hover:bg-surface-2/50'
          }`}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: tab.type === 'asset' ? '#f59e0b' : '#3b82f6' }}
          />
          <span className="truncate max-w-[100px]">{tab.label}</span>
          <span
            onClick={(e) => handleAssetTabClose(e, tab.id)}
            className="ml-1 p-0.5 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 1l6 6M7 1l-6 6" />
            </svg>
          </span>
        </button>
      ))}
    </div>
  )
}
