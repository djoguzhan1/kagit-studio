import { useEffect, useRef, useState } from 'react';
import type { StudioMode } from '../../types/studio';

interface StudioTransitionOverlayProps {
  mode: StudioMode;
}

/**
 * 350ms Non-Blocking Classic Cartoon Studio Room Transition Overlay:
 * - draw:   Warm animation paper page-flip sweep
 * - paper:  Classic 6-blade camera iris opening
 * - puppet: Twin theater stage curtains parting
 * - film:   16mm perforated cinema gate & amber projector flash
 * - desk:   Soft halogen return glow
 */
export function StudioTransitionOverlay({ mode }: StudioTransitionOverlayProps) {
  const prevModeRef = useRef<StudioMode>(mode);
  const [activeTransition, setActiveTransition] = useState<{
    id: number;
    to: StudioMode;
  } | null>(null);

  useEffect(() => {
    if (prevModeRef.current === mode) return;
    prevModeRef.current = mode;

    if (typeof window === 'undefined') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    const id = Date.now();
    setActiveTransition({ id, to: mode });
    const timer = window.setTimeout(() => {
      setActiveTransition((cur) => (cur?.id === id ? null : cur));
    }, 390);
    return () => window.clearTimeout(timer);
  }, [mode]);

  if (!activeTransition) return null;

  const { to, id } = activeTransition;

  return (
    <div
      key={id}
      aria-hidden="true"
      className="fixed inset-0 z-[55] pointer-events-none overflow-hidden"
    >
      {to === 'draw' && (
        <div
          className="studio-trans-page absolute inset-0"
          style={{
            background:
              'linear-gradient(105deg, rgba(247,243,233,0.92) 0%, rgba(236,225,200,0.88) 65%, rgba(217,155,38,0.28) 100%)',
            boxShadow: '-24px 0 48px rgba(0, 0, 0, 0.45)',
          }}
        />
      )}

      {to === 'paper' && (
        <div
          className="studio-trans-iris absolute inset-0"
          style={{
            background:
              'radial-gradient(circle, rgba(247,243,233,0.18) 0%, rgba(16,15,14,0.92) 55%, #0a0908 100%)',
          }}
        />
      )}

      {to === 'puppet' && (
        <div className="absolute inset-0 flex">
          <div
            className="studio-trans-curtain-l w-1/2 h-full border-r-2 border-ink-brass/70"
            style={{
              background:
                'linear-gradient(90deg, #141110 0%, #241917 75%, #34211D 100%)',
            }}
          />
          <div
            className="studio-trans-curtain-r w-1/2 h-full border-l-2 border-ink-brass/70"
            style={{
              background:
                'linear-gradient(270deg, #141110 0%, #241917 75%, #34211D 100%)',
            }}
          />
        </div>
      )}

      {to === 'film' && (
        <div
          className="studio-trans-gate absolute inset-0 flex items-center justify-between px-4"
          style={{
            background:
              'radial-gradient(circle at 50% 50%, rgba(245,198,102,0.34) 0%, rgba(15,14,13,0.88) 72%)',
          }}
        >
          {/* 16mm Left & Right Sprocket Perforations */}
          <div className="h-full flex flex-col justify-evenly opacity-55">
            {Array.from({ length: 8 }).map((_, i) => (
              <span key={i} className="w-3.5 h-5 rounded-sm border border-ink-brass/70 bg-black/70" />
            ))}
          </div>
          <div className="h-full flex flex-col justify-evenly opacity-55">
            {Array.from({ length: 8 }).map((_, i) => (
              <span key={i} className="w-3.5 h-5 rounded-sm border border-ink-brass/70 bg-black/70" />
            ))}
          </div>
        </div>
      )}

      {to === 'desk' && (
        <div
          className="studio-trans-gate absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 80% 10%, rgba(245,198,102,0.22) 0%, rgba(16,15,14,0.45) 70%)',
          }}
        />
      )}
    </div>
  );
}
