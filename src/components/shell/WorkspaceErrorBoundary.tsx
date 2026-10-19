import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  workspace: string
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * WorkspaceErrorBoundary — catches render/lifecycle errors inside a workspace
 * and renders a recovery UI instead of crashing the whole app.
 */
export class WorkspaceErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[WorkspaceErrorBoundary] Error in "${this.props.workspace}" workspace:`, error, info)
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-surface-0 gap-4 p-8">
        <div className="text-4xl opacity-30">⚠</div>
        <div className="text-center space-y-1">
          <p className="text-sm font-semibold text-neutral-300">
            Something crashed in the <span className="text-accent capitalize">{this.props.workspace}</span> workspace
          </p>
          <p className="text-[11px] text-neutral-600 max-w-xs leading-relaxed">
            {this.state.error?.message ?? 'An unexpected error occurred.'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={this.handleReset}
            className="px-4 py-1.5 text-xs bg-accent text-black font-semibold rounded hover:bg-amber-400 transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-1.5 text-xs bg-surface-2 text-neutral-300 rounded border border-surface-4 hover:bg-surface-3 transition-colors"
          >
            Reload App
          </button>
        </div>
        {import.meta.env.DEV && this.state.error?.stack && (
          <pre className="text-[9px] text-neutral-700 bg-surface-1 border border-surface-4 rounded p-3 max-w-2xl overflow-auto max-h-40 whitespace-pre-wrap">
            {this.state.error.stack}
          </pre>
        )}
      </div>
    )
  }
}
