import { lazy, Suspense, useEffect } from 'react';
import { useStudioStore } from './store/useStudioStore';
import StudioDeskHub from './components/desk/StudioDeskHub';
import TopConsoleBar from './components/studio/TopConsoleBar';
import { StudioTransitionOverlay } from './components/ui/StudioTransitionOverlay';
import { useT } from './i18n/translations';
import type { StudioMode } from './types/studio';

const studioLoaders = {
  draw: () => import('./components/studio/DrawWorkspace'),
  paper: () => import('./components/paper/PaperCameraStudio'),
  puppet: () => import('./components/puppet/PuppetStudio'),
  film: () => import('./components/film/FilmDirectorStudio'),
} as const;

export function preloadStudioModule(target: StudioMode): void {
  if (target !== 'desk') {
    void studioLoaders[target]();
  }
}

// Code-split every heavy studio workspace & optional modal so initial boot stays fast on mobile!
const DrawWorkspace = lazy(studioLoaders.draw);
const PaperCameraStudio = lazy(studioLoaders.paper);
const PuppetStudio = lazy(studioLoaders.puppet);
const FilmDirectorStudio = lazy(studioLoaders.film);
const ExportModal = lazy(() => import('./components/export/ExportModal'));
const StudioGuideOverlay = lazy(() => import('./components/guide/StudioGuideOverlay'));
const StudioOverviewShow = lazy(() => import('./components/guide/StudioOverviewShow'));
const LegalPolicyModal = lazy(() => import('./components/legal/LegalPolicyModal'));
const AccountModal = lazy(() => import('./components/account/AccountModal'));

function StudioModuleLoader({ label }: { label: string }) {
  return (
    <div className="flex-1 desk-surface-mat flex flex-col items-center justify-center gap-2.5">
      <span className="w-3 h-3 rounded-full bg-ink-vermilion animate-pulse" />
      <span className="font-mono text-xs text-desk-muted">{label}</span>
    </div>
  );
}

export default function App() {
  const {
    ready,
    mode,
    exportOpen,
    activeTourMode,
    overviewShowOpen,
    legalOpen,
    accountModalOpen,
    toast,
    bootstrap,
    clearToast,
  } = useStudioStore();
  const t = useT();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!ready && mode !== 'desk') {
    return (
      <div className="min-h-screen desk-workbench-mat flex flex-col items-center justify-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#F7F3E9] border border-desk-border shadow-lg flex items-center justify-center">
          <span className="w-3 h-3 rounded-full bg-ink-vermilion animate-pulse" />
        </div>
        <p className="font-mono text-xs text-desk-muted">{t('loadingDesk')}</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-desk-bg text-desk-text">
      {mode === 'desk' ? (
        <div className="flex-1 overflow-y-auto lg:overflow-hidden">
          <StudioDeskHub />
        </div>
      ) : (
        <>
          <TopConsoleBar />

          {mode === 'draw' && (
            <Suspense fallback={<StudioModuleLoader label={t('loadingDraw')} />}>
              <DrawWorkspace />
            </Suspense>
          )}

          {mode === 'paper' && (
            <Suspense fallback={<StudioModuleLoader label={t('loadingPaper')} />}>
              <PaperCameraStudio />
            </Suspense>
          )}

          {mode === 'puppet' && (
            <Suspense fallback={<StudioModuleLoader label={t('loadingPuppet')} />}>
              <PuppetStudio />
            </Suspense>
          )}

          {mode === 'film' && (
            <Suspense fallback={<StudioModuleLoader label={t('loadingFilm')} />}>
              <FilmDirectorStudio />
            </Suspense>
          )}
        </>
      )}

      {exportOpen && (
        <Suspense fallback={null}>
          <ExportModal />
        </Suspense>
      )}

      <StudioTransitionOverlay mode={mode} />

      {/* Lazy-Loaded Site-Wide Living Guide, 10s Overview Show & Legal/Performance Center */}
      {activeTourMode && (
        <Suspense fallback={null}>
          <StudioGuideOverlay />
        </Suspense>
      )}

      {overviewShowOpen && (
        <Suspense fallback={null}>
          <StudioOverviewShow />
        </Suspense>
      )}

      {legalOpen && (
        <Suspense fallback={null}>
          <LegalPolicyModal />
        </Suspense>
      )}

      {accountModalOpen && (
        <Suspense fallback={null}>
          <AccountModal />
        </Suspense>
      )}

      {/* Tactile Studio Toast — top-center below header so bottom-right CTAs & tools are NEVER covered */}
      {toast && (
        <div
          onClick={clearToast}
          role="status"
          className="toast-pop-in fixed top-16 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100vw-2rem)] sm:max-w-md px-4 py-2 rounded-2xl bg-desk-panel/95 backdrop-blur-md border border-desk-border shadow-2xl flex items-center gap-2.5 cursor-pointer"
        >
          <span
            className="hardware-led"
            data-on={
              toast.tone === 'error'
                ? 'vermilion'
                : toast.tone === 'info'
                  ? 'amber'
                  : 'emerald'
            }
          />
          <span className="text-xs font-semibold text-desk-text">{toast.message}</span>
        </div>
      )}
    </div>
  );
}
