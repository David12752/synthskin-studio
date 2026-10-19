/**
 * SettingsModal — global settings overlay accessible from the title bar gear button.
 * Tabs: AI Keys · Connection · About
 */
import { useEffect, useState, useCallback } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { pythonClient, type PanelPipelineCapabilities } from '../../lib/api/pythonClient'

// ─── Tab IDs ────────────────────────────────────────────────────────────────

type Tab = 'ai' | 'connection' | 'about'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'ai',         label: 'AI / API Keys',  icon: '🔑' },
  { id: 'connection', label: 'Connection',      icon: '⚡' },
  { id: 'about',      label: 'About',           icon: 'ℹ️' },
]

// ─── Helpers ────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">{title}</h3>
      <div className="rounded-lg border border-surface-4 bg-surface-1 divide-y divide-surface-4">
        {children}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5 flex items-center gap-3">
      <span className="text-[11px] text-neutral-400 w-28 shrink-0">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
  )
}

// ─── AI Keys Tab ────────────────────────────────────────────────────────────

function AIKeysTab() {
  const [caps, setCaps] = useState<PanelPipelineCapabilities | null>(null)
  const [loading, setLoading] = useState(true)

  // Gemini
  const [geminiInput, setGeminiInput] = useState('')
  const [geminiSaving, setGeminiSaving] = useState(false)
  const [geminiMsg, setGeminiMsg] = useState<string | null>(null)

  useEffect(() => {
    pythonClient.panelCapabilities()
      .then(setCaps)
      .catch(() => setCaps(null))
      .finally(() => setLoading(false))
  }, [])

  const saveGemini = useCallback(async () => {
    if (!geminiInput.trim()) return
    setGeminiSaving(true); setGeminiMsg(null)
    try {
      const res = await pythonClient.panelSetGeminiKey(geminiInput.trim())
      if (res.ok) { setCaps(res.capabilities); setGeminiMsg('Saved — Gemini Flash active!'); setGeminiInput('') }
    } catch { setGeminiMsg('Failed to save. Is the Python server running?') }
    finally { setGeminiSaving(false) }
  }, [geminiInput])

  const clearGemini = useCallback(async () => {
    setGeminiSaving(true); setGeminiMsg(null)
    try {
      const res = await pythonClient.panelSetGeminiKey('')
      if (res.ok) { setCaps(res.capabilities); setGeminiMsg('Gemini key removed.') }
    } catch { setGeminiMsg('Failed.') }
    finally { setGeminiSaving(false) }
  }, [])

  if (loading) {
    return <div className="p-6 text-center text-[11px] text-neutral-500">Connecting to Python server…</div>
  }

  if (!caps) {
    return (
      <div className="p-6 text-center space-y-2">
        <p className="text-[11px] text-red-400">Python server not reachable.</p>
        <p className="text-[10px] text-neutral-500">Start the server with <code className="font-mono bg-surface-3 px-1 rounded">npm run server</code></p>
      </div>
    )
  }

  // Active panel detection route.
  let backendLabel = 'CV fallback only'
  let backendColor = 'text-neutral-500'
  if (caps.gemini_key_set) { backendLabel = 'Gemini Flash'; backendColor = 'text-blue-400' }
  else if (caps.custom_yolo) { backendLabel = 'Custom YOLO + CV local'; backendColor = 'text-emerald-400' }
  else if (caps.yolo) { backendLabel = 'Generic YOLO + CV fallback'; backendColor = 'text-amber-400' }

  return (
    <div className="space-y-5">
      {/* Active Backend */}
      <Section title="Panel Detection Backend">
        <Row label="Status">
          <div className="flex items-center gap-2">
            <StatusDot ok={caps.gemini_key_set || caps.yolo} />
            <span className={`text-[11px] font-medium ${backendColor}`}>{backendLabel}</span>
            {caps.gemma4_backend && (
              <span className="text-[9px] text-neutral-500 font-mono">{caps.gemma4_backend}</span>
            )}
          </div>
        </Row>
        <Row label="Priority">
          <span className="text-[10px] text-neutral-500">
            Gemini → YOLO → targeted OpenCV
          </span>
        </Row>
      </Section>

      {/* Gemini API Key */}
      <Section title="Gemini API Key">
        <Row label="Status">
          <div className="flex items-center gap-2">
            <StatusDot ok={!!caps.gemini_key_set} />
            <span className="text-[11px] text-neutral-300">
              {caps.gemini_key_set ? 'Key saved' : 'Not set'}
            </span>
            {caps.gemini_key_set && (
              <button
                onClick={clearGemini}
                disabled={geminiSaving}
                className="ml-auto text-[10px] text-red-400 hover:text-red-300 disabled:opacity-40"
              >
                Remove
              </button>
            )}
          </div>
        </Row>
        <Row label={caps.gemini_key_set ? 'Update key' : 'Add key'}>
          <div className="flex gap-2">
            <input
              type="password"
              value={geminiInput}
              onChange={(e) => setGeminiInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveGemini()}
              placeholder="AIza…"
              className="flex-1 bg-surface-2 border border-surface-4 rounded px-2 py-1 text-[11px] text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-blue-500/50"
            />
            <button
              onClick={saveGemini}
              disabled={geminiSaving || !geminiInput.trim()}
              className="px-3 py-1 text-[11px] rounded bg-blue-600/20 text-blue-300 border border-blue-500/30 hover:bg-blue-600/30 disabled:opacity-40 transition-colors"
            >
              {geminiSaving ? '…' : 'Save'}
            </button>
          </div>
        </Row>
        {geminiMsg && (
          <div className="px-3 py-1.5">
            <p className={`text-[10px] ${geminiMsg.includes('Saved') ? 'text-emerald-400' : geminiMsg.includes('removed') ? 'text-neutral-400' : 'text-red-400'}`}>
              {geminiMsg}
            </p>
          </div>
        )}
        <Row label="Get key">
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-400 hover:text-blue-300 underline underline-offset-2"
          >
            aistudio.google.com/apikey ↗
          </a>
        </Row>
      </Section>

      {/* Pipeline capabilities */}
      <Section title="Pipeline Modules">
        {([
          ['Gemini key', caps.gemini_key_set],
          ['Custom YOLO detector', !!caps.custom_yolo],
          ['YOLO fallback installed', caps.yolo],
          ['SAM 2 masks', caps.sam2],
          ['RapidOCR', caps.rapidocr],
        ] as [string, boolean][]).map(([name, ok]) => (
          <Row key={name} label={name}>
            <div className="flex items-center gap-2">
              <StatusDot ok={ok} />
              <span className={`text-[11px] ${ok ? 'text-neutral-300' : 'text-neutral-600'}`}>
                {ok ? 'Ready' : 'Not available'}
              </span>
            </div>
          </Row>
        ))}
        <Row label="Device">
          <span className="text-[11px] font-mono text-neutral-400">{caps.device}</span>
        </Row>
        {caps.detector_recommendation && (
          <Row label="Detector hint">
            <span className="text-[10px] text-amber-300 leading-snug">{caps.detector_recommendation}</span>
          </Row>
        )}
      </Section>
    </div>
  )
}

// ─── Connection Tab ──────────────────────────────────────────────────────────

function ConnectionTab() {
  const [serverUrl, setServerUrl] = useState('http://localhost:8765')
  const [serverStatus, setServerStatus] = useState<'checking' | 'ok' | 'error' | 'idle'>('idle')

  const checkServer = useCallback(async () => {
    setServerStatus('checking')
    try {
      await pythonClient.aiCapabilities()
      setServerStatus('ok')
    } catch {
      setServerStatus('error')
    }
  }, [])

  useEffect(() => { checkServer() }, [checkServer])

  return (
    <div className="space-y-5">
      <Section title="Python AI Server">
        <Row label="Status">
          <div className="flex items-center gap-2">
            <StatusDot ok={serverStatus === 'ok'} />
            <span className="text-[11px] text-neutral-300">
              {serverStatus === 'checking' ? 'Checking…'
                : serverStatus === 'ok' ? 'Connected'
                : serverStatus === 'error' ? 'Not reachable'
                : 'Unknown'}
            </span>
            <button
              onClick={checkServer}
              className="ml-auto text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              Retry
            </button>
          </div>
        </Row>
        <Row label="URL">
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            className="w-full bg-surface-2 border border-surface-4 rounded px-2 py-1 text-[11px] font-mono text-neutral-300 focus:outline-none focus:border-surface-5"
          />
        </Row>
        {serverStatus === 'error' && (
          <div className="px-3 py-2">
            <p className="text-[10px] text-neutral-500">
              Start the server: <code className="font-mono bg-surface-3 px-1 rounded">cd python &amp;&amp; python server.py</code>
            </p>
          </div>
        )}
      </Section>
    </div>
  )
}

// ─── About Tab ───────────────────────────────────────────────────────────────

function AboutTab() {
  return (
    <div className="space-y-5">
      <Section title="SynthSkin Studio">
        <Row label="Version"><span className="text-[11px] font-mono text-neutral-300">0.1.0-alpha</span></Row>
        <Row label="Build"><span className="text-[11px] font-mono text-neutral-500">Electron + Vite + React</span></Row>
        <Row label="AI Stack">
          <span className="text-[10px] text-neutral-500">Gemini Vision · YOLO · OpenCV · SAM 2 · RapidOCR</span>
        </Row>
      </Section>
      <Section title="Keyboard Shortcuts">
        {([
          ['F', 'Fullscreen canvas'],
          ['Shift+F', 'Distraction-free mode'],
          ['Cmd/Ctrl+P', 'Command palette'],
          ['1–6', 'Switch workspace'],
        ] as [string, string][]).map(([keys, desc]) => (
          <Row key={keys} label={desc}>
            <kbd className="text-[10px] font-mono bg-surface-3 border border-surface-5 px-1.5 py-0.5 rounded text-neutral-300">
              {keys}
            </kbd>
          </Row>
        ))}
      </Section>
    </div>
  )
}

// ─── Main Modal ──────────────────────────────────────────────────────────────

export default function SettingsModal() {
  const settingsOpen = useWorkspaceStore((s) => s.settingsOpen)
  const closeSettings = useWorkspaceStore((s) => s.closeSettings)
  const [tab, setTab] = useState<Tab>('ai')

  // Close on Escape
  useEffect(() => {
    if (!settingsOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [settingsOpen, closeSettings])

  if (!settingsOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeSettings() }}
    >
      <div className="w-[560px] max-h-[80vh] flex flex-col bg-surface-1 border border-surface-4 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-4 shrink-0">
          <h2 className="text-sm font-semibold text-neutral-200">Settings</h2>
          <button
            onClick={closeSettings}
            className="w-6 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-surface-3 transition-colors"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-surface-4 shrink-0 bg-surface-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-[11px] font-medium transition-colors ${
                tab === t.id
                  ? 'text-accent border-b-2 border-accent bg-accent/5'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'ai'         && <AIKeysTab />}
          {tab === 'connection' && <ConnectionTab />}
          {tab === 'about'      && <AboutTab />}
        </div>
      </div>
    </div>
  )
}
