import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Home, RefreshCw, ShieldCheck } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { translate } from '../../i18n/translations';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

/**
 * Top-level Studio Error Boundary — prevents white/black screens of death for real users.
 * Resets open modal flags so faulty modal state never re-triggers an infinite crash loop.
 */
export class StudioErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorMessage: '' };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error?.message || 'Unknown error',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[INKTROPE Studio Recovery]', error, info.componentStack);
  }

  private handleReturnToDesk = () => {
    try {
      useStudioStore.setState({
        activeTourMode: null,
        exportOpen: false,
        filmExportOpen: false,
        puppetExportOpen: false,
        accountModalOpen: false,
        legalOpen: false,
        overviewShowOpen: false,
      });
      useStudioStore.getState().setMode('desk');
    } catch {
      // fall through to reload if store itself threw
    }
    this.setState({ hasError: false, errorMessage: '' });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const locale = (() => {
      try {
        return useStudioStore.getState().locale;
      } catch {
        return 'tr' as const;
      }
    })();

    return (
      <div className="min-h-screen desk-workbench-mat flex items-center justify-center p-6 text-desk-text">
        <div className="w-full max-w-md rounded-3xl bg-desk-surface border-2 border-ink-brass/70 shadow-2xl p-6 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-ink-brass/20 border border-ink-brass mx-auto flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-ink-brass" />
          </div>

          <div className="space-y-1.5">
            <h1 className="text-lg font-extrabold text-desk-text">
              {translate(locale, 'errBoundaryTitle')}
            </h1>
            <p className="text-xs text-desk-muted leading-relaxed">
              {translate(locale, 'errBoundaryDesc')}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={this.handleReturnToDesk}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-ink-vermilion text-white text-xs font-extrabold inline-flex items-center gap-1.5 hover:brightness-110 shadow"
            >
              <Home className="w-4 h-4" />
              {translate(locale, 'errBoundaryHome')}
            </button>

            <button
              type="button"
              onClick={this.handleReload}
              className="min-h-[44px] px-4 py-2 rounded-xl console-well border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text inline-flex items-center gap-1.5"
            >
              <RefreshCw className="w-4 h-4" />
              {translate(locale, 'errBoundaryReload')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
