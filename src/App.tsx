import WorkspaceShell from './components/shell/WorkspaceShell'
import { WorkspaceErrorBoundary } from './components/shell/WorkspaceErrorBoundary'
import { WelcomeScreen } from './components/shell/WelcomeScreen'
import FileMenu from './components/shell/FileMenu'
import AssetLibrary from './components/library/AssetLibrary'
import Inspector from './components/inspector/Inspector'
import SemanticLayoutAnalyzer from './components/canvas/SemanticLayoutAnalyzer'
import ExtractToolbar from './components/workspaces/ExtractToolbar'
import ImportCutModal from './components/workspaces/ImportCutModal'
import ComposeModal from './components/workspaces/ComposeModal'
import HandoffExportModal from './components/workspaces/HandoffExportModal'
import ExtractWorkflow from './components/workspaces/ExtractWorkflow'
import PunchAssetTray from './components/workspaces/PunchAssetTray'
import PunchEditorCanvas from './components/workspaces/PunchEditorCanvas'
import SettingsModal from './components/shell/SettingsModal'
import { useProjectManager } from './hooks/useProjectManager'
import { useWorkspaceStore, type WorkspaceId } from './stores/workspaceStore'
import { useAIStore } from './stores/aiStore'
import { useEffect } from 'react'
import { useShortcutRegistry } from './hooks/useShortcutRegistry'
import { pythonClient } from './lib/api/pythonClient'
import { abortAllPythonRequests } from './lib/api/pythonClient'

// Single-workspace app (product reset 2026-07). The vision flow lives on the
// Extract toolbar: Detect Controls → Import & Cut → Compose → Export for Claude.
function getToolbar(_ws: WorkspaceId) {
  return <><FileMenu /><div className="w-px h-6 bg-surface-5 mx-1" /><ExtractToolbar /></>
}

// ─── Persistent side panels ─────────────────────────────────────────────────
// Always rendered; content is shown/hidden with CSS so components never unmount.
function PersistentLeft() {
  const punchEditOpen = useWorkspaceStore((s) => s.punchEditOpen)
  return (
    <>
      {/* Default Extract left panel — hidden when punch editor is open */}
      <div style={{ display: !punchEditOpen ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
        <AssetLibrary />
      </div>
      {/* Punch editor asset tray — shown only when punch editor is open */}
      <div style={{ display: punchEditOpen ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
        <PunchAssetTray />
      </div>
    </>
  )
}

function PersistentRight() {
  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
      <Inspector />
    </div>
  )
}

// Singleton elements — same JSX reference across renders so WorkspaceShell
// always sees the same element type → never triggers a ResizablePanel remount.
const PERSISTENT_LEFT  = <PersistentLeft />
const PERSISTENT_RIGHT = <PersistentRight />

function ExtractCenter() {
  const panelAnalyzerOpen  = useWorkspaceStore((s) => s.panelAnalyzerOpen)
  const closePanelAnalyzer = useWorkspaceStore((s) => s.closePanelAnalyzer)
  const punchEditOpen      = useWorkspaceStore((s) => s.punchEditOpen)

  if (punchEditOpen)      return <PunchEditorCanvas />
  if (panelAnalyzerOpen)  return <SemanticLayoutAnalyzer onClose={closePanelAnalyzer} />
  return <ExtractWorkflow />
}

function App() {
  useProjectManager()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  // Cancel in-flight Python requests when the user switches workspaces
  useEffect(() => {
    abortAllPythonRequests()
  }, [activeWorkspace])

  // Fetch AI capabilities once on startup
  useEffect(() => {
    const ai = useAIStore.getState()
    if (!ai.capabilities && !ai.capabilitiesLoading) {
      ai.setCapabilitiesLoading(true)
      pythonClient.aiCapabilities()
        .then((caps) => useAIStore.getState().setCapabilities(caps))
        .catch(() => useAIStore.getState().setCapabilities(null as any))
        .finally(() => useAIStore.getState().setCapabilitiesLoading(false))
    }
  }, [])

  // Register ALL commands for the command palette
  useShortcutRegistry()

  return (
    <WorkspaceShell
      toolbar={getToolbar(activeWorkspace)}
      leftPanel={PERSISTENT_LEFT}
      rightPanel={PERSISTENT_RIGHT}
    >
      <WorkspaceErrorBoundary workspace={activeWorkspace}>
        <ExtractCenter />
      </WorkspaceErrorBoundary>
      <WelcomeScreen />

      {/* ─── Overlay Modals (accessible from command palette / toolbar) ─── */}
      <SettingsModal />
      <ImportCutModal />
      <ComposeModal />
      <HandoffExportModal />
    </WorkspaceShell>
  )
}

export default App
