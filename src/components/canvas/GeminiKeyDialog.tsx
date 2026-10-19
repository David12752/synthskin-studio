/**
 * GeminiKeyDialog — small modal to set/replace the Gemini API key.
 * Calls /panel/set-gemini-key, then returns refreshed capabilities.
 */
import { useState } from 'react'
import { pythonClient, type PanelPipelineCapabilities } from '../../lib/api/pythonClient'

interface Props {
  currentlySet: boolean
  onClose: () => void
  onSaved: (caps: PanelPipelineCapabilities) => void
}

export default function GeminiKeyDialog({ currentlySet, onClose, onSaved }: Props) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await pythonClient.panelSetGeminiKey(key.trim())
      onSaved(res.capabilities)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await pythonClient.panelSetGeminiKey('')
      onSaved(res.capabilities)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[360px] rounded-2xl border border-white/12 bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3">
          <h3 className="text-[12px] font-semibold text-white">Gemini API key</h3>
          <p className="mt-1 text-[10px] text-white/50 leading-snug">
            Free key from{' '}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-yellow-400 hover:text-yellow-300"
            >
              Google AI Studio
            </a>
            . Stored only in this Python session — never written to disk. The key is validated with Google before it is accepted.
          </p>
        </div>

        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={currentlySet ? '••••••••• (replace)' : 'AIzaSy…'}
          autoFocus
          className="w-full rounded-lg border border-white/12 bg-surface-2 px-3 py-2 text-[11px] font-mono text-white placeholder-white/25 focus:border-yellow-500/50 focus:outline-none"
        />

        {error && (
          <p className="mt-2 text-[10px] text-red-400">{error}</p>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          {currentlySet ? (
            <button
              type="button"
              disabled={busy}
              onClick={handleClear}
              className="text-[10px] px-2 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-40"
            >
              Remove key
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-[10px] px-3 py-1.5 rounded-lg border border-white/12 bg-surface-2 text-white/70 hover:text-white disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || !key.trim()}
              className="text-[10px] px-3 py-1.5 rounded-lg border border-yellow-500/35 bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25 disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save key'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
