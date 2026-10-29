import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

type Props = {
  children: ReactNode;
  /** Optional compact fallback for nested trees. `null` means "render nothing". */
  fallback?: ReactNode;
  /**
   * Forget a caught error when this value changes. A surface that cannot show
   * a retry button — the floating card's `null` fallback is the case — is
   * otherwise wedged until something remounts the boundary.
   */
  resetKey?: unknown;
};

type State = { error: Error | null };

/**
 * Root/feature error boundary. Without this, any render throw unmounts the
 * whole React tree → blank main pane (often perceived as a "white screen"
 * right after a request triggers a re-render with bad event/task data).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[kin] render error", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      // `undefined` means "not supplied"; `null` means "supplied, and it is
      // nothing". A floating surface that must vanish on a bad payload passes
      // `null` and needs it to render nothing, not the full-page panel.
      if (this.props.fallback !== undefined) return this.props.fallback;
      const message = this.state.error.message || t("task.loadFailed");
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6 bg-kin-bg">
          <div
            className="max-w-md w-full rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-3 space-y-3"
            role="alert"
          >
            <div className="text-strong leading-5 font-semibold text-kin-red-ink">
              {t("task.loadFailed")}
            </div>
            <p className="text-strong text-kin-secondary break-words">{message}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={this.reset}
                className="rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-3 py-1.5 text-strong font-medium text-kin-text hover:bg-[var(--kin-fill-strong)]"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => window.location.assign("/")}
                className="rounded-lg border border-[var(--kin-hairline-strong)] px-3 py-1.5 text-strong font-medium text-kin-muted hover:text-kin-text"
              >
                Home
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
