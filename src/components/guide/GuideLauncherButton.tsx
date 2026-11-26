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
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey, true);
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
        aria-label={t('guideBtnLabel')}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`min-w-[44px] min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border font-bold transition-all ${
          compact ? 'px-2.5 text-[11px]' : 'px-2.5 text-xs'
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
        />
        <HelpCircle className="w-4 h-4 shrink-0" />
        <span className={compact ? 'hidden xl:inline' : 'hidden lg:inline'}>
          {t('guideBtnLabel')}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="toast-pop-in fixed left-3 right-3 sm:left-auto sm:right-0 top-[60px] sm:absolute sm:top-full sm:mt-2 sm:w-72 max-h-[calc(100dvh-72px)] overflow-y-auto overscroll-contain rounded-2xl bg-desk-surface/98 backdrop-blur-md border border-desk-border shadow-2xl p-3 z-[85] space-y-2.5 select-none"
        >
          {/* Mascot Header */}
          <div className="flex items-center gap-2.5 pb-2 border-b border-desk-border">
            <GuideMascotSvg className="w-11 h-11 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-extrabold text-desk-text">{t('guideMenuTitle')}</div>
              <p className="text-[11px] text-desk-muted leading-snug">{t('guideMenuSub')}</p>
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
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-ink-vermilion text-white text-xs font-extrabold inline-flex items-center justify-center gap-1.5 hover:brightness-110 shadow transition-all"
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
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-ink-brass/20 border border-ink-brass text-desk-text hover:bg-ink-brass/30 text-xs font-bold inline-flex items-center justify-center gap-1.5 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 text-ink-brass" />
              {t('guideWatchOverview')}
            </button>
          </div>

          {/* 5 Studio Tabs Progress & 1-Click Jump */}
          <div className="pt-2 border-t border-desk-border space-y-1">
            <div className="flex items-center justify-between px-1">
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted">
                {t('guideSectionsTitle')}
              </span>
              {completedTours.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.click(0.94);
                    resetTourProgress();
                  }}
                  className="font-mono text-[11px] text-desk-muted hover:text-ink-vermilion inline-flex items-center gap-0.5 min-h-[28px] px-1"
                >
                  <RotateCcw className="w-3 h-3" />
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
                    soundEngine.click(1.04);
                    setOpen(false);
                    void startTour(m);
                  }}
                  className={`w-full min-h-[40px] px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 transition-colors ${
                    isCurrent
                      ? 'bg-desk-panel text-desk-text border border-desk-border'
                      : 'text-desk-muted hover:text-desk-text hover:bg-desk-panel/60'
                  }`}
                >
                  <span className="inline-flex items-center gap-2 truncate">
                    <span
                      className="hardware-led"
                      data-on={done ? 'emerald' : isCurrent ? 'amber' : undefined}
                    />
                    <span className="truncate">{t(TOUR_MODE_LABEL_KEY[m])}</span>
                  </span>
                  {done ? (
                    <span className="inline-flex items-center gap-0.5 font-mono text-[11px] text-ink-emerald font-bold shrink-0">
                      <Check className="w-3.5 h-3.5" />
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-ink-brass shrink-0">3 ▶</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Privacy, Terms & Performance Footer */}
          <div className="pt-2 border-t border-desk-border">
            <button
              type="button"
              onClick={() => {
                soundEngine.click(0.98);
                setOpen(false);
                openLegal('privacy');
              }}
              className="w-full min-h-[40px] px-2.5 py-1.5 rounded-xl hover:bg-desk-panel/80 text-[11px] font-semibold text-desk-muted hover:text-desk-text flex items-center justify-between gap-2 transition-colors"
            >
              <span className="inline-flex items-center gap-1.5 truncate">
                <ShieldCheck className="w-3.5 h-3.5 text-ink-emerald shrink-0" />
                <span className="truncate">{t('legalFooterBtn')}</span>
              </span>
              <span className="font-mono text-[11px] text-desk-muted">→</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
