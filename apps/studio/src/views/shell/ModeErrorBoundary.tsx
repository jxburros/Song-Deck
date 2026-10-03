import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useStudio } from '../../state/store';
import { Button, EmptyState } from '../../ui/kit';

interface Props {
  /** The mode being shown; switching modes clears a previous error. */
  mode: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one failing mode (a render error or a lazy chunk that failed to load) from blanking the
 * whole studio. The project autosaves on every commit, so recovering never loses work.
 */
export class ModeErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Song Deck: the ${this.props.mode} view failed`, error, info.componentStack);
  }

  override componentDidUpdate(prev: Props) {
    if (prev.mode !== this.props.mode && this.state.error) this.setState({ error: null });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <EmptyState
        icon="alert"
        title="This view ran into a problem"
        actions={
          <>
            <Button onClick={() => this.setState({ error: null })}>Try again</Button>
            <Button onClick={() => useStudio.getState().setMode('home')}>Go to projects</Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload the studio
            </Button>
          </>
        }
      >
        <p className="small muted" style={{ maxWidth: 560 }}>
          Your project is saved, so nothing was lost. Other modes keep working.
        </p>
        <pre className="small" style={{ maxWidth: 640, whiteSpace: 'pre-wrap', textAlign: 'left' }}>
          {error.message || String(error)}
        </pre>
      </EmptyState>
    );
  }
}
