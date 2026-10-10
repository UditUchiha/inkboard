import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { isChunkLoadError } from "../lib/chunkReload";

// React hands over whatever was thrown; it is an Error in practice, which is all the fallback and isChunkLoadError read.
type ErrorBoundaryProps = {
  children?: ReactNode;
  fallback: (details: { error: Error; reset: () => void }) => ReactNode;
};

type ErrorBoundaryState = { error: Error | null };

/**
 * Catches an error thrown while drawing anything below it, so one bad element
 * or a bug shows a message instead of a blank page. `fallback({ error, reset })`
 * draws the message; `reset` tries to draw the children again (or reloads the page,
 * when what failed was downloading the app's code).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  // A page whose code couldn't be downloaded (usually: a deploy replaced it) can only come back with a fresh load;
  // React keeps the failed download, so drawing the children again would just fail again.
  reset = () => {
    if (isChunkLoadError(this.state.error)) window.location.reload();
    else this.setState({ error: null });
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return this.props.fallback({ error, reset: this.reset });
  }
}

/** The message for a whole page that failed (it uses no router or theme, which may be what failed). */
type CrashedProps = { reset: () => void };

export function PageCrashed({ reset }: CrashedProps) {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-4 text-ink">
      <div className="grid max-w-md gap-4 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-graphite">
          The page hit an error it couldn't recover from. Your boards are safe. Reloading usually fixes it.
        </p>
        <div className="flex justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-10 rounded-lg bg-ink px-4 text-sm font-medium text-surface"
          >
            Reload the page
          </button>
          <button type="button" onClick={reset} className="h-10 rounded-lg border border-rule px-4 text-sm font-medium">
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/** The message in place of a board that couldn't be drawn; the rest of the editor keeps working. */
export function BoardCrashed({ reset }: CrashedProps) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-surface px-4 text-ink">
      <div className="grid max-w-md gap-3 text-center">
        <h2 className="text-lg font-semibold">This board couldn't be drawn</h2>
        <p className="text-graphite">
          Something on it, or in the app, caused an error. Your changes are still saved. Try again, or reload the page.
        </p>
        <div className="flex justify-center gap-3">
          <button type="button" onClick={reset} className="h-10 rounded-lg border border-rule px-4 text-sm font-medium">
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-10 rounded-lg bg-ink px-4 text-sm font-medium text-surface"
          >
            Reload the page
          </button>
        </div>
      </div>
    </div>
  );
}
