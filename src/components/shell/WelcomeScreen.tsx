/**
 * components/shell/WelcomeScreen.tsx
 * ────────────────────────────────────────────────
 * Splash overlay shown when no project is active (Untitled + no source image).
 * Dismissed automatically when the user loads an image or opens a project.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useImageStore } from '../../stores/imageStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'

interface RecentEntry {
  name: string
  path: string
  updatedAt: string
}

export function WelcomeScreen() {
  const projectName = useProjectStore((s) => s.projectName)
  const sourceImage = useImageStore((s) => s.sourceImage)
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  const [dismissed, setDismissed] = useState(false)

  const isDefault = projectName === 'Untitled Project' && !sourceImage

  useEffect(() => {
    if (!isDefault) return
    window.synthskin
      .getRecentProjects()
      .then((list) => setRecents(list.slice(0, 5)))
      .catch(() => {})
  }, [isDefault])

  const handleNew = useCallback(() => {
    useProjectStore.getState().newProject()
    setDismissed(true)
  }, [])

  const handleOpen = useCallback(() => {
    useProjectStore.getState().openProject()
    setDismissed(true)
  }, [])

  const handleOpenRecent = useCallback((path: string) => {
    // projectStore.openProject reads a file path; we simulate by triggering open dialog
    // The actual recent-open logic lives in projectStore — we just forward the path
    // Since openProject() opens a dialog, we call the lower-level loadFrom path if available,
    // otherwise fall back to openProject().
    const store = useProjectStore.getState() as any
    if (typeof store.openProjectFromPath === 'function') {
      store.openProjectFromPath(path)
    } else {
      store.openProject()
    }
    setDismissed(true)
  }, [])

  if (!isDefault || dismissed) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-0/90 backdrop-blur-sm">
      <div className="bg-surface-1 border border-surface-3 rounded-2xl shadow-2xl w-[520px] max-w-[95vw] p-8 flex flex-col gap-6">
        {/* Logo + title */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center text-2xl">🎛️</div>
          <div>
            <h1 className="text-lg font-bold text-surface-5 leading-tight">SynthSkin Studio</h1>
            <p className="text-xs text-muted">Professional audio plugin UI editor</p>
          </div>
        </div>

        {/* Primary CTA — guided wizard */}
        <button
          onClick={() => { setDismissed(true); setWorkspace('extract') }}
          className="flex items-center gap-4 p-5 rounded-xl bg-accent/15 border border-accent/30 hover:bg-accent/25 transition-colors group text-left w-full"
        >
          <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center text-2xl shrink-0 group-hover:scale-105 transition-transform">
            🚀
          </div>
          <div>
            <p className="text-sm font-bold text-neutral-100">Quick Start Wizard</p>
            <p className="text-[11px] text-muted mt-0.5">
              Import image → AI detects knobs & sliders → export punched background + PNGs + code mapping
            </p>
          </div>
          <span className="ml-auto text-accent text-lg shrink-0">→</span>
        </button>

        {/* Secondary actions */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleNew}
            className="flex flex-col items-start gap-1.5 p-4 rounded-xl bg-surface-2 border border-surface-3 hover:bg-surface-3 transition-colors group"
          >
            <span className="text-xl group-hover:scale-110 transition-transform">📄</span>
            <span className="text-sm font-semibold text-surface-5">New Project</span>
            <span className="text-[10px] text-muted leading-snug">Start fresh with a blank workspace</span>
          </button>
          <button
            onClick={handleOpen}
            className="flex flex-col items-start gap-1.5 p-4 rounded-xl bg-surface-2 border border-surface-3 hover:bg-surface-3 transition-colors group"
          >
            <span className="text-xl group-hover:scale-110 transition-transform">📂</span>
            <span className="text-sm font-semibold text-surface-5">Open Project</span>
            <span className="text-[10px] text-muted leading-snug">Load an existing .synthskin file</span>
          </button>
        </div>

        {/* Recent projects */}
        {recents.length > 0 && (
          <div>
            <p className="text-[10px] text-muted uppercase tracking-widest mb-2">Recent</p>
            <ul className="space-y-1">
              {recents.map((r) => (
                <li key={r.path}>
                  <button
                    onClick={() => handleOpenRecent(r.path)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-surface-2 transition-colors text-left group"
                  >
                    <span className="text-xs text-surface-4 group-hover:text-surface-5 truncate">{r.name}</span>
                    <span className="text-[10px] text-muted shrink-0">
                      {new Date(r.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Feature hints */}
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-surface-2">
          {[
            { icon: '✂️', label: 'Extract', hint: 'Cut assets from screenshots' },
            { icon: '🎨', label: 'Foundry', hint: 'Render knobs & sliders' },
            { icon: '📐', label: 'Design', hint: 'Build full panel layouts' },
          ].map(({ icon, label, hint }) => (
            <div key={label} className="flex flex-col items-center gap-1 text-center">
              <span className="text-lg">{icon}</span>
              <span className="text-[11px] font-medium text-surface-4">{label}</span>
              <span className="text-[9px] text-muted leading-snug">{hint}</span>
            </div>
          ))}
        </div>

        {/* Dismiss */}
        <button
          onClick={() => setDismissed(true)}
          className="text-[10px] text-muted hover:text-surface-4 transition-colors mx-auto"
        >
          Skip — go to workspace
        </button>
      </div>
    </div>
  )
}
