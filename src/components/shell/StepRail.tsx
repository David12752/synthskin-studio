// ─── Step Rail ───────────────────────────────────────────────────────────────
// The linear vision flow as three explicit steps: ① Extract → ② Arrange →
// ③ Export. The app is a single canvas; "Arrange" and "Export" are overlay
// work-modes (modals) over that canvas, so a step both routes focus and (for
// 2 & 3) opens the corresponding surface. This replaces the old workspace
// switcher now that there is only one workspace.

import { useWorkspaceStore } from '../../stores/workspaceStore'
import { usePanelLayoutStore } from '../../stores/panelLayoutStore'
import { useCompositionStore } from '../../stores/compositionStore'

type StepId = 'extract' | 'arrange' | 'export'

const STEPS: { id: StepId; label: string; desc: string }[] = [
  { id: 'extract', label: 'EXTRACT', desc: 'Step 1 — detect the controls with AI and cut them out of the image.' },
  { id: 'arrange', label: 'ARRANGE', desc: 'Step 2 (optional) — import parts from other images and place them on the panel. Skip it to go straight from Extract to Export.' },
  { id: 'export',  label: 'EXPORT',  desc: 'Step 3 — package the cut assets + clean background + layout.json into one bundle for Claude / your frontend.' },
]

export default function StepRail() {
  const composeOpen = useWorkspaceStore((s) => s.composeOpen)
  const handoffOpen = useWorkspaceStore((s) => s.handoffOpen)
  const openCompose = useWorkspaceStore((s) => s.openCompose)
  const closeCompose = useWorkspaceStore((s) => s.closeCompose)
  const openHandoff = useWorkspaceStore((s) => s.openHandoff)
  const closeHandoff = useWorkspaceStore((s) => s.closeHandoff)

  const detectedCount = usePanelLayoutStore((s) => s.layout?.controlCount ?? 0)
  const composedCount = useCompositionStore((s) => s.elements.length)

  const activeStep: StepId = handoffOpen ? 'export' : composeOpen ? 'arrange' : 'extract'

  const goToStep = (id: StepId) => {
    switch (id) {
      case 'extract':
        closeCompose()
        closeHandoff()
        break
      case 'arrange':
        closeHandoff()
        openCompose()
        break
      case 'export':
        closeCompose()
        openHandoff()
        break
    }
  }

  const badges: Partial<Record<StepId, number>> = {
    extract: detectedCount,
    arrange: composedCount,
  }

  return (
    <div className="flex items-center h-full">
      <div className="flex items-center gap-0.5 bg-surface-0/50 rounded-lg px-1 py-0.5">
        {STEPS.map((step, index) => (
          <div key={step.id} className="flex items-center">
            <StepTab
              step={index + 1}
              label={step.label}
              desc={step.desc}
              isActive={activeStep === step.id}
              badge={badges[step.id]}
              onClick={() => goToStep(step.id)}
            />
            {index < STEPS.length - 1 && (
              <span className="text-muted/40 text-xs px-0.5 select-none">→</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function StepTab({
  step,
  label,
  desc,
  isActive,
  badge,
  onClick,
}: {
  step: number
  label: string
  desc: string
  isActive: boolean
  badge?: number
  onClick: () => void
}) {
  const hasBadge = typeof badge === 'number' && badge > 0
  return (
    <button
      onClick={onClick}
      title={desc}
      className={`
        relative px-3 py-1.5 text-[13px] font-medium tracking-[0.5px] uppercase
        transition-all duration-150 ease-out rounded-md select-none
        flex items-center gap-1.5
        ${isActive ? 'text-accent-text' : 'text-muted hover:text-muted-hover'}
      `}
    >
      <span className={`text-[10px] font-mono leading-none ${isActive ? 'text-accent' : 'text-muted/50'}`}>
        {step}
      </span>
      {label}
      {hasBadge && (
        <span
          className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full leading-none font-semibold
            ${isActive ? 'bg-accent/20 text-accent' : 'bg-white/10 text-white/50'}`}
          title={`${badge} items`}
        >
          {badge}
        </span>
      )}
      {isActive && <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-accent rounded-full" />}
    </button>
  )
}
