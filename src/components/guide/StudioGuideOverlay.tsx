import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { useT } from '../../i18n/translations';
import { TOUR_STEPS_BY_MODE } from '../../engine/tourConfig';
import { soundEngine } from '../../engine/soundEngine';
import { GuideMascotSvg } from './GuideMascotSvg';

interface TargetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CARD_W = 328;
const CARD_H = 196;
const PAD = 10;

export default function StudioGuideOverlay() {
  const t = useT();
  const { activeTourMode, mode, stopTour, completeTour, notify } = useStudioStore();

  const [stepIdx, setStepIdx] = useState(0);
  const [celebrating, setCelebrating] = useState(false);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));

  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const scrolledStepRef = useRef<string | null>(null);

  const steps = useMemo(
    () => (activeTourMode ? TOUR_STEPS_BY_MODE[activeTourMode] : []),
    [activeTourMode]
  );
  const currentStep = steps[stepIdx] ?? null;

  // Reset to step 0 whenever tour mode opens or changes
  useEffect(() => {
    setStepIdx(0);
    setCelebrating(false);
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }, [activeTourMode]);

  // If user switches away to another studio manually while a tour is running, close cleanly
  useEffect(() => {
    if (activeTourMode && activeTourMode !== mode) {
      stopTour();
    }
  }, [activeTourMode, mode, stopTour]);

  // Continuously locate & measure the real target DOM node via `data-tour="..."`
  useEffect(() => {
    if (!activeTourMode || !currentStep) {
      setTargetRect(null);
      return;
    }

    const measure = () => {
      const vwNow = window.innerWidth;
      const vhNow = window.innerHeight;
      setViewport({ w: vwNow, h: vhNow });
      const el =
        (document.querySelector(currentStep.selector) as HTMLElement | null) ??
        (currentStep.fallbackSelector
          ? (document.querySelector(currentStep.fallbackSelector) as HTMLElement | null)
          : null);

      if (!el) {
        setTargetRect(null);
        return;
      }

      let r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) {
        setTargetRect(null);
        return;
      }

      // On compact mobile screens, bring off-screen targets smoothly into view once per step
      const stepKey = `${activeTourMode}:${currentStep.id}`;
      if (
        scrolledStepRef.current !== stepKey &&
        (r.top < 12 || r.bottom > vhNow - 12 || r.left < 0 || r.right > vwNow)
      ) {
        scrolledStepRef.current = stepKey;
        try {
          el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          r = el.getBoundingClientRect();
        } catch {
          // ignore older browser behavior option
        }
      }

      const x = Math.max(4, Math.min(vwNow - 12, r.left - PAD));
      const y = Math.max(4, Math.min(vhNow - 12, r.top - PAD));
      setTargetRect({
        x,
        y,
        w: Math.max(24, Math.min(vwNow - x - 4, r.width + PAD * 2)),
        h: Math.max(24, Math.min(vhNow - y - 4, r.height + PAD * 2)),
      });
    };

    measure();
    const pollId = setInterval(measure, 140);
    const observer = new MutationObserver(() => measure());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);

    return () => {
      clearInterval(pollId);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [activeTourMode, currentStep]);

  const finishOrAdvance = useCallback(() => {
    if (!activeTourMode) return;
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);

    if (stepIdx + 1 < steps.length) {
      setCelebrating(true);
      soundEngine.click(1.22);
      advanceTimerRef.current = setTimeout(() => {
        setCelebrating(false);
        setStepIdx((s) => s + 1);
      }, 480);
    } else {
      setCelebrating(true);
      soundEngine.clapperSnap();
      advanceTimerRef.current = setTimeout(() => {
        setCelebrating(false);
        completeTour(activeTourMode);
        notify(t('guideCelebration'));
      }, 650);
    }
  }, [activeTourMode, completeTour, notify, stepIdx, steps.length, t]);

  // "Learn by Doing" — real clicks/taps inside the spotlighted control auto-advance smoothly!
  useEffect(() => {
    if (!activeTourMode || !targetRect || celebrating) return;
    const onCapturePointerDown = (e: PointerEvent) => {
      // Ignore clicks on the guide card itself
      if (cardRef.current && cardRef.current.contains(e.target as Node)) return;
      const insideHole =
        e.clientX >= targetRect.x &&
        e.clientX <= targetRect.x + targetRect.w &&
        e.clientY >= targetRect.y &&
        e.clientY <= targetRect.y + targetRect.h;
      if (insideHole) {
        // Let the real button/canvas action run first, then celebrate & advance!
        setTimeout(() => {
          finishOrAdvance();
        }, 280);
      }
    };
    window.addEventListener('pointerdown', onCapturePointerDown, true);
    return () => window.removeEventListener('pointerdown', onCapturePointerDown, true);
  }, [activeTourMode, targetRect, celebrating, finishOrAdvance]);

  // Escape & Arrow navigation
  useEffect(() => {
    if (!activeTourMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stopTour();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        finishOrAdvance();
      } else if (e.key === 'ArrowLeft' && stepIdx > 0) {
        e.preventDefault();
        setStepIdx((s) => Math.max(0, s - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTourMode, finishOrAdvance, stepIdx, stopTour]);

  useEffect(() => {
    return () => {
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    };
  }, []);

  if (!activeTourMode || !currentStep) return null;

  // Smart card placement that NEVER overlaps the spotlighted target or clips outside ANY desktop or mobile viewport!
  const vw = viewport.w;
  const vh = viewport.h;
  const margin = vw < 480 ? 12 : 16;
  const cardW = Math.min(CARD_W, Math.max(240, vw - margin * 2));

  let cardX = Math.round((vw - cardW) / 2);
  let cardY = Math.round((vh - CARD_H) / 2);

  if (targetRect) {
    const gap = vw < 480 ? 14 : 22;
    const pref = currentStep.preferredSide ?? 'bottom';
    const tryOrder: ('top' | 'bottom' | 'left' | 'right')[] =
      vw < 640 ? ['top', 'bottom', 'left', 'right'] : [pref, 'top', 'bottom', 'left', 'right'];
    for (const side of tryOrder) {
      if (side === 'top' && targetRect.y - gap - CARD_H >= margin) {
        cardX = targetRect.x + targetRect.w / 2 - cardW / 2;
        cardY = targetRect.y - gap - CARD_H;
        break;
      }
      if (side === 'bottom' && targetRect.y + targetRect.h + gap + CARD_H <= vh - margin) {
        cardX = targetRect.x + targetRect.w / 2 - cardW / 2;
        cardY = targetRect.y + targetRect.h + gap;
        break;
      }
      if (side === 'left' && targetRect.x - gap - cardW >= margin) {
        cardX = targetRect.x - gap - cardW;
        cardY = targetRect.y + targetRect.h / 2 - CARD_H / 2;
        break;
      }
      if (side === 'right' && targetRect.x + targetRect.w + gap + cardW <= vw - margin) {
        cardX = targetRect.x + targetRect.w + gap;
        cardY = targetRect.y + targetRect.h / 2 - CARD_H / 2;
        break;
      }
    }
  }

  // Always clamp strictly inside viewport bounds (even if targetRect is null or very large on phones!)
  cardX = Math.max(margin, Math.min(vw - cardW - margin, Math.round(cardX)));
  cardY = Math.max(margin, Math.min(vh - CARD_H - margin, Math.round(cardY)));

  // Compute mascot gaze direction & hand-drawn arrow from card edge -> spotlight center
  let lookX = 0;
  let lookY = 0;
  let arrowPath = '';
  let arrowTip: { x: number; y: number; angle: number } | null = null;

  if (targetRect) {
    const tx = targetRect.x + targetRect.w / 2;
    const ty = targetRect.y + targetRect.h / 2;
    const cx = cardX + cardW / 2;
    const cy = cardY + CARD_H / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    const dist = Math.hypot(dx, dy) || 1;
    lookX = dx / dist;
    lookY = dy / dist;

    // Start arrow on nearest side of the guide card & stop cleanly at the spotlight border
    const startX =
      Math.abs(dx) > Math.abs(dy)
        ? dx > 0
          ? cardX + cardW
          : cardX
        : Math.max(cardX + 24, Math.min(cardX + cardW - 24, tx));
    const startY =
      Math.abs(dx) > Math.abs(dy)
        ? Math.max(cardY + 24, Math.min(cardY + CARD_H - 24, ty))
        : dy > 0
          ? cardY + CARD_H
          : cardY;

    const endX =
      Math.abs(dx) > Math.abs(dy)
        ? dx > 0
          ? targetRect.x - 4
          : targetRect.x + targetRect.w + 4
        : tx;
    const endY =
      Math.abs(dx) > Math.abs(dy)
        ? ty
        : dy > 0
          ? targetRect.y - 4
          : targetRect.y + targetRect.h + 4;

    if (Math.hypot(endX - startX, endY - startY) > 18) {
      const midX = (startX + endX) / 2 - (endY - startY) * 0.14;
      const midY = (startY + endY) / 2 + (endX - startX) * 0.14;
      arrowPath = `M ${startX.toFixed(1)} ${startY.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`;
      arrowTip = {
        x: endX,
        y: endY,
        angle: (Math.atan2(endY - midY, endX - midX) * 180) / Math.PI,
      };
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] pointer-events-none select-none"
      role="dialog"
      aria-label={t('guideMenuTitle')}
    >
      {/* 4-Panel True Clickable-Hole Spotlight Backdrop (Hole stays 100% interactive!) */}
      {targetRect ? (
        <>
          <div
            className="fixed left-0 top-0 right-0 bg-black/55 backdrop-blur-[1px] pointer-events-auto transition-all duration-300"
            style={{ height: Math.max(0, targetRect.y) }}
            onClick={stopTour}
          />
          <div
            className="fixed left-0 right-0 bottom-0 bg-black/55 backdrop-blur-[1px] pointer-events-auto transition-all duration-300"
            style={{ top: Math.min(vh, targetRect.y + targetRect.h) }}
            onClick={stopTour}
          />
          <div
            className="fixed left-0 bg-black/55 backdrop-blur-[1px] pointer-events-auto transition-all duration-300"
            style={{
              top: targetRect.y,
              height: targetRect.h,
              width: Math.max(0, targetRect.x),
            }}
            onClick={stopTour}
          />
          <div
            className="fixed right-0 bg-black/55 backdrop-blur-[1px] pointer-events-auto transition-all duration-300"
            style={{
              top: targetRect.y,
              height: targetRect.h,
              left: Math.min(vw, targetRect.x + targetRect.w),
            }}
            onClick={stopTour}
          />
        </>
      ) : (
        <div
          className="fixed inset-0 bg-black/55 backdrop-blur-[1px] pointer-events-auto"
          onClick={stopTour}
        />
      )}

      {/* Hand-Drawn Ink Ring & Curved Arrow SVG Layer */}
      <svg className="fixed inset-0 w-full h-full pointer-events-none overflow-visible">
        {targetRect && (
          <g key={`${activeTourMode}-${stepIdx}`}>
            <rect
              x={targetRect.x}
              y={targetRect.y}
              width={targetRect.w}
              height={targetRect.h}
              rx={16}
              fill="none"
              stroke={celebrating ? '#16A34A' : '#D99B26'}
              strokeWidth={3.2}
              strokeLinecap="round"
              className="tour-ink-ring"
            />
            <rect
              x={targetRect.x - 3}
              y={targetRect.y - 3}
              width={targetRect.w + 6}
              height={targetRect.h + 6}
              rx={18}
              fill="none"
              stroke={celebrating ? '#16A34A' : '#E54D2E'}
              strokeWidth={1.6}
              strokeDasharray="9 7"
              opacity={0.85}
            />
          </g>
        )}

        {arrowPath && arrowTip && (
          <g key={`arr-${activeTourMode}-${stepIdx}`}>
            <path
              d={arrowPath}
              fill="none"
              stroke="#D99B26"
              strokeWidth={2.8}
              strokeLinecap="round"
              strokeDasharray="6 4"
            />
            <polygon
              points="0,-5 10,0 0,5"
              fill="#D99B26"
              transform={`translate(${arrowTip.x.toFixed(1)}, ${arrowTip.y.toFixed(1)}) rotate(${arrowTip.angle.toFixed(1)})`}
            />
          </g>
        )}
      </svg>

      {/* Living Bereli Gezgin Guide Card */}
      <div
        ref={cardRef}
        style={{ left: cardX, top: cardY, width: cardW }}
        className="fixed pointer-events-auto rounded-3xl bg-desk-surface/95 backdrop-blur-md border-2 border-ink-brass shadow-2xl p-4 transition-all duration-300"
      >
        <div className="flex items-start gap-3">
          <GuideMascotSvg celebrating={celebrating} lookX={lookX} lookY={lookY} className="w-14 h-14 -mt-1" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-brass">
                {t('guideStepOf')} {stepIdx + 1} / {steps.length}
              </span>
              <button
                type="button"
                onClick={stopTour}
                className="p-1 rounded-lg text-desk-muted hover:text-desk-text hover:bg-desk-panel"
                title={t('guideSkip')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <h3 className="text-sm font-extrabold text-desk-text leading-snug">
              {t(currentStep.titleKey)}
            </h3>
            <p className="text-xs text-desk-muted leading-relaxed">
              {t(currentStep.bodyKey)}
            </p>
          </div>
        </div>

        {/* Step Dots + Navigation */}
        <div className="mt-3 pt-2.5 border-t border-desk-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {steps.map((s, i) => (
              <span
                key={s.id}
                className={`h-1.5 rounded-full transition-all ${
                  i === stepIdx
                    ? 'w-5 bg-ink-vermilion'
                    : i < stepIdx
                      ? 'w-2 bg-ink-emerald'
                      : 'w-2 bg-desk-border'
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            {stepIdx > 0 && (
              <button
                type="button"
                onClick={() => {
                  soundEngine.click(0.95);
                  setStepIdx((s) => Math.max(0, s - 1));
                }}
                className="px-2.5 py-1 rounded-xl console-well border border-desk-border text-[11px] font-bold text-desk-muted hover:text-desk-text inline-flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" />
                {t('guidePrev')}
              </button>
            )}
            <button
              type="button"
              onClick={finishOrAdvance}
              className="px-3 py-1 rounded-xl bg-ink-vermilion text-white text-[11px] font-extrabold inline-flex items-center gap-1 hover:brightness-110 shadow"
            >
              {stepIdx + 1 === steps.length ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  {t('guideFinish')}
                </>
              ) : (
                <>
                  {t('guideNext')}
                  <ArrowRight className="w-3 h-3" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
