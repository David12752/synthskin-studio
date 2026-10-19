import { useState } from 'react'
import { useAssetStore } from '../../stores/assetStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useImageStore } from '../../stores/imageStore'
import { useContextMenu, type ContextMenuItem } from '../shell/ContextMenu'
import AssetFileBrowser from './AssetFileBrowser'
import { useCanvasTabStore } from '../../stores/canvasTabStore'
import type { MeterMode, Asset } from '../../types'

export default function AssetLibrary() {
  const assets = useAssetStore((s) => s.assets)
  const selectedId = useAssetStore((s) => s.selectedAssetId)
  const selectAsset = useAssetStore((s) => s.selectAsset)
  const setSourceImage = useImageStore((s) => s.setSourceImage)
  const addTab = useCanvasTabStore((s) => s.addTab)
  const [activeTab, setActiveTab] = useState<'assets' | 'files'>('assets')

  const handleDoubleClick = (asset: typeof assets[0]) => {
    // Open asset in a new canvas tab
    addTab({
      id: `asset-${asset.id}`,
      label: asset.name,
      type: 'asset',
      sourceId: asset.id,
      dataUrl: asset.maskDataUrl,
      width: asset.bounds.width,
      height: asset.bounds.height,
    })

  }

  const handleOpenFileAsAsset = (dataUrl: string, fileName: string) => {
    // Open image file as source image on canvas
    const img = new window.Image()
    img.onload = () => {
      setSourceImage({
        id: crypto.randomUUID(),
        path: fileName,
        dataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
        htmlImage: img,
      })
    }
    img.src = dataUrl
  }

  return (
    <aside className="h-full bg-surface-1 flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-surface-4 shrink-0">
        {([['assets', 'Assets'], ['files', 'Files']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)}
            className={`flex-1 px-2 py-2 text-[10px] font-medium uppercase tracking-wide transition-colors ${
              activeTab === id ? 'text-accent border-b-2 border-accent bg-accent/5' : 'text-muted hover:text-neutral-300'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'files' ? (
        <AssetFileBrowser onOpenAsset={handleOpenFileAsAsset} />
      ) : (
        <>
          {assets.length === 0 ? (
            <div className="flex-1 flex items-center justify-center px-4">
              <span className="text-[11px] text-neutral-600 text-center leading-relaxed">
                Extract components from<br />the canvas to see them here
              </span>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-1.5 grid grid-cols-2 gap-1.5 auto-rows-min content-start">
              {assets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  isSelected={selectedId === asset.id}
                  onSelect={() => selectAsset(asset.id)}
                  onDoubleClick={() => handleDoubleClick(asset)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </aside>
  )
}

function AssetCard({ asset, isSelected, onSelect, onDoubleClick }: {
  asset: Asset; isSelected: boolean; onSelect: () => void; onDoubleClick: () => void
}) {
  const removeAsset = useAssetStore((s) => s.removeAsset)
  const addTab = useCanvasTabStore((s) => s.addTab)

  const contextItems: ContextMenuItem[] = [
    { type: 'item', label: 'Select', onClick: onSelect },
    { type: 'item', label: 'Open in Tab', onClick: () => addTab({
      id: `asset-${asset.id}`, label: asset.name, type: 'asset',
      sourceId: asset.id, dataUrl: asset.maskDataUrl,
      width: asset.bounds.width, height: asset.bounds.height,
    }) },
    { type: 'separator' },
    { type: 'item', label: 'Delete', destructive: true, shortcut: 'delete', onClick: () => removeAsset(asset.id) },
  ]

  const { onContextMenu, menuElement } = useContextMenu(contextItems)

  return (
    <>
      <button
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        className={`aspect-square rounded overflow-hidden border transition-colors relative group
          ${isSelected
            ? 'border-accent bg-accent/10'
            : 'border-surface-4 bg-surface-2 hover:border-neutral-600'
          }`}
      >
        <img src={asset.maskDataUrl} alt={asset.name} className="w-full h-full object-contain p-1" draggable={false} />
        <div className="absolute bottom-0 inset-x-0 bg-black/60 text-[8px] text-neutral-400 px-1 py-0.5 truncate opacity-0 group-hover:opacity-100 transition-opacity">
          {asset.name}
        </div>
      </button>
      {menuElement}
    </>
  )
}
