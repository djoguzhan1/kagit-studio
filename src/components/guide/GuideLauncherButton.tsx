import { useEffect, useRef, useState } from 'react';
import { Check, HelpCircle, Play, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { useT } from '../../i18n/translations';
import { ALL_TOUR_MODES, TOUR_MODE_LABEL_KEY } from '../../engine/tourConfig';
import { soundEngine } from '../../engine/soundEngine';
import { GuideMascotSvg } from './GuideMascotSvg';

interface GuideLauncherButtonProps {
  compact?: boolean;
}

/**
 * Persistent, 1-Click Accessible `? Rehber` Button for both Desk Homepage & TopConsoleBar.
 * Launches the 10s Animated Overview Show OR any desk's 3-step live "Learn by Doing" guide.
 */
export function GuideLauncherButton({ compact = false }: GuideLauncherButtonProps) {
  const t = useT();
  const {
    mode,
    completedTours,
    guideSeen,
    startTour,
    setOverviewShowOpen,
    resetTourProgress,
    markGuideSeen,
    clearToast,
    openLegal,
  } = useStudioStore();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentCompleted = completedTours.includes(mode);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          soundEngine.click(1.06);
          markGuideSeen();
          clearToast();
          setOpen((v) => !v);
        }}
        title={t('guideBtnTitle')}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`inline-flex items-center gap-1.5 rounded-xl border font-bold transition-all ${
          compact ? 'px-2 py-1.5 text-[11px]' : 'px-2.5 py-1.5 text-xs'
        } ${
          open
            ? 'bg-ink-brass/25 border-ink-brass text-desk-text shadow-md'
            : !guideSeen
              ? 'bg-ink-brass/15 border-ink-brass/70 text-ink-brass hover:bg-ink-brass/25'
              : 'console-well border-desk-border text-desk-muted hover:text-desk-text hover:border-ink-brass/60'
        }`}
      >
        <span
          className="hardware-led"
          data-on={!guideSeen ? 'amber' : currentCompleted ? 'emerald' : undefined}
          data-pulse={!guideSeen ? 'true' : undefined}
        />
        <HelpCircle className="w-3.5 h-3.5 shrink-0" />
        <span className="hidden sm:inline">{t('guideBtnLabel')}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="toast-pop-in fixed right-3 top-14 sm:absolute sm:right-0 sm:top-full sm:mt-2 w-[min(18rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-4.5rem)] overflow-y-auto rounded-2xl bg-desk-surface/95 backdrop-blur-md border border-desk-border shadow-2xl p-3 z-[70] space-y-2.5 select-none"
        >
          {/* Mascot Header */}
          <div className="flex items-center gap-2.5 pb-2 border-b border-desk-border">
            <GuideMascotSvg className="w-11 h-11" />
            <div className="min-w-0">
              <div className="text-xs font-extrabold text-desk-text">{t('guideMenuTitle')}</div>
              <p className="text-[10.5px] text-desk-muted leading-snug">{t('guideMenuSub')}</p>
            </div>
          </div>

          {/* 2 Primary Instant Actions */}
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => {
                soundEngine.clapperSnap();
                setOpen(false);
                void startTour(mode);
              }}
              className="w-full py-2 px-3 rounded-xl bg-ink-vermilion text-white text-xs font-extrabold inline-flex items-center justify-center gap-1.5 hover:brightness-110 shadow transition-all"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {t('guideStartCurrent')}
            </button>

            <button
              type="button"
              onClick={() => {
                soundEngine.projectorClick();
                setOpen(false);
                setOverviewShowOpen(true);
              }}
              className="w-full py-2 px-3 rounded-xl bg-ink-brass/20 border border-ink-brass text-desk-text hover:bg-ink-brass/30 text-xs font-bold inline-flex items-center justify-center gap-1.5 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 text-ink-brass" />
              {t('guideWatchOverview')}
            </button>
          </div>

          {/* 5 Studio Tabs Progress & 1-Click Jump */}
          <div className="pt-2 border-t border-desk-border space-y-1">
            <div className="flex items-center justify-between px-1">
              <span className="font-mono text-[9.5px] font-bold uppercase tracking-wider text-desk-muted">
                {t('guideSectionsTitle')}
              </span>
              {completedTours.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.click(0.94);
                    resetTourProgress();
                  }}
                  className="font-mono text-[9.5px] text-desk-muted hover:text-ink-vermilion inline-flex items-center gap-0.5"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  {t('guideResetProgress')}
                </button>
              )}
            </div>

            {ALL_TOUR_MODES.map((m) => {
              const done = completedTours.includes(m);
              const isCurrent = m === mode;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    soundEngine.click(1.08);
                    setOpen(false);
                    void startTour(m);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded-xl border text-left text-[11px] font-bold flex items-center justify-between transition-colors ${
                    isCurrent
                      ? 'bg-desk-panel border-ink-brass/60 text-desk-text'
                      : 'border-transparent hover:bg-desk-panel/70 text-desk-muted hover:text-desk-text'
                  }`}
                >
                  <span className="truncate">{t(TOUR_MODE_LABEL_KEY[m])}</span>
                  {done ? (
                    <span className="w-4 h-4 rounded-full bg-ink-emerald/20 text-ink-emerald flex items-center justify-center shrink-0">
                      <Check className="w-3 h-3" />
                    </span>
                  ) : (
                    <span className="font-mono text-[9.5px] text-ink-brass shrink-0">3 ▶</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* 1-Click Access to Privacy, KVKK & Device Performance Settings */}
          <div className="pt-2 border-t border-desk-border">
            <button
              type="button"
              onClick={() => {
                soundEngine.click(1.02);
                setOpen(false);
                openLegal('privacy');
              }}
              className="w-full px-2.5 py-1.5 rounded-xl hover:bg-desk-panel/80 text-[10.5px] font-semibold text-desk-muted hover:text-desk-text flex items-center justify-between gap-2 transition-colors"
            >
              <span className="inline-flex items-center gap-1.5 truncate">
                <ShieldCheck className="w-3.5 h-3.5 text-ink-emerald shrink-0" />
                <span className="truncate">{t('legalFooterBtn')}</span>
              </span>
              <span className="font-mono text-[9px] text-desk-muted">→</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
