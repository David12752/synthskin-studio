/**
 * lib/UpdateChecker.ts
 * ─────────────────────
 * Lightweight, privacy-respecting update checker for SynthSkin Studio.
 *
 * - Off by default. Activates only if user opts in.
 * - Reads version from a static JSON endpoint (no tracking).
 * - Checks at most once per 24h (clamped via localStorage).
 * - Does NOT send any user data — only receives version number.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface VersionInfo {
  version: string
  releaseDate: string
  changelogUrl: string
  downloadUrl: string
  severity: 'patch' | 'minor' | 'major'
  notes: string
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  current: string
  latest?: VersionInfo
  checkedAt: string
  error?: string
}

export interface UpdateCheckerOptions {
  /** Endpoint that returns VersionInfo JSON. Default: GitHub releases latest API. */
  endpoint?: string
  /** How often to check in ms. Default: 24 hours. */
  intervalMs?: number
  /** localStorage key for caching. */
  storageKey?: string
}

const VERSION_FILE = 'package.json'

// ── Current version ───────────────────────────────────────────────────

function getCurrentVersion(): string {
  // In the renderer, we can access package.json via a Vite import
  // Fall back to a bundled constant if not accessible
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../../../package.json') as { version: string }).version
  } catch {
    return '0.0.0'
  }
}

// ── SemVer comparison ─────────────────────────────────────────────────

function parseSemVer(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map((s) => parseInt(s, 10) || 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function isNewer(latest: string, current: string): boolean {
  const [lMaj, lMin, lPat] = parseSemVer(latest)
  const [cMaj, cMin, cPat] = parseSemVer(current)
  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  return lPat > cPat
}

function getSeverity(latest: string, current: string): 'patch' | 'minor' | 'major' {
  const [lMaj, , lPat] = parseSemVer(latest)
  const [cMaj, cMin] = parseSemVer(current)
  const [, lMin] = parseSemVer(latest)
  if (lMaj > cMaj) return 'major'
  if (lMin > cMin) return 'minor'
  return 'patch'
}

// ── UpdateChecker class ───────────────────────────────────────────────

const DEFAULT_ENDPOINT = 'https://api.github.com/repos/synthskin-studio/releases/releases/latest'
const DEFAULT_INTERVAL = 24 * 60 * 60 * 1000  // 24h
const DEFAULT_STORAGE_KEY = 'synthskin-update-cache'

export class UpdateChecker {
  private readonly endpoint: string
  private readonly intervalMs: number
  private readonly storageKey: string

  constructor(options: UpdateCheckerOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Check for updates. Returns cached result if within interval.
   * Never throws — errors are returned as result.error.
   */
  async check(force = false): Promise<UpdateCheckResult> {
    if (!force) {
      const cached = this.loadCache()
      if (cached) return cached
    }

    const current = getCurrentVersion()
    const now = new Date().toISOString()

    try {
      const resp = await fetch(this.endpoint, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

      const data = await resp.json() as {
        tag_name?: string
        published_at?: string
        html_url?: string
        body?: string
        assets?: Array<{ browser_download_url: string }>
      }

      const latestVersion = (data.tag_name ?? '0.0.0').replace(/^v/, '')
      const hasUpdate = isNewer(latestVersion, current)

      const result: UpdateCheckResult = {
        hasUpdate,
        current,
        checkedAt: now,
        ...(hasUpdate && {
          latest: {
            version: latestVersion,
            releaseDate: data.published_at ?? now,
            changelogUrl: data.html_url ?? '',
            downloadUrl: data.assets?.[0]?.browser_download_url ?? data.html_url ?? '',
            severity: getSeverity(latestVersion, current),
            notes: (data.body ?? '').slice(0, 500),
          },
        }),
      }

      this.saveCache(result)
      return result
    } catch (err: any) {
      const result: UpdateCheckResult = {
        hasUpdate: false,
        current,
        checkedAt: now,
        error: err.message ?? 'Unknown error',
      }
      // Don't cache errors — allow retry
      return result
    }
  }

  /** Clear cached result (forces re-check next call) */
  clearCache() {
    try { localStorage.removeItem(this.storageKey) } catch { /* ignore */ }
  }

  /** Returns cached result if it exists and is not stale, else null */
  loadCache(): UpdateCheckResult | null {
    try {
      const raw = localStorage.getItem(this.storageKey)
      if (!raw) return null
      const cached = JSON.parse(raw) as UpdateCheckResult & { _expiresAt: number }
      if (Date.now() > cached._expiresAt) return null
      return cached
    } catch {
      return null
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private saveCache(result: UpdateCheckResult) {
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ ...result, _expiresAt: Date.now() + this.intervalMs })
      )
    } catch { /* quota exceeded — ignore */ }
  }
}

// ── Opt-in preference helpers ─────────────────────────────────────────

const OPT_IN_KEY = 'synthskin-update-optin'

export function isUpdateCheckEnabled(): boolean {
  try { return localStorage.getItem(OPT_IN_KEY) === 'true' } catch { return false }
}

export function setUpdateCheckEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.setItem(OPT_IN_KEY, 'true')
    else         localStorage.removeItem(OPT_IN_KEY)
  } catch { /* ignore */ }
}

// ── Singleton ─────────────────────────────────────────────────────────

export const updateChecker = new UpdateChecker()
