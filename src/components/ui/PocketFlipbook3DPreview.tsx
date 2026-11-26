import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Pause, Play, X } from 'lucide-react';
import type { CelFrame } from '../../types/studio';
import { BlobImage } from './KeycapButton';
import { soundEngine } from '../../engine/soundEngine';
import { useStudioStore } from '../../store/useStudioStore';

export interface PocketFlipbook3DPreviewProps {
  frames: CelFrame[];
  paperColor?: string;
  fps?: number;
  title?: string;
  projectName?: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  compact?: boolean;
}

/**
 * Interactive 3D Physical Pocket Flipbook Thumb-Flipper:
 * - True double-sided 3D turning leaf (`backface-visibility: hidden` front + warm paper back face, zero mirrored ghosting!).
 * - Cleans up `prevIdx` on animation end, pause, and `prefers-reduced-motion` (never freezes on previous frame!).
 */
export function PocketFlipbook3DPreview({
  frames,
  paperColor = '#F7F3E9',
  fps = 12,
  title,
  projectName,
  subtitle,
  actionLabel,
  onAction,
  onClose,
  compact = false,
}: PocketFlipbook3DPreviewProps) {
  const locale = useStudioStore((s) => s.locale);
  const isEn = locale === 'en';
  const count = Math.max(1, frames.length);
  const [idx, setIdx] = useState(0);
  const [prevIdx, setPrevIdx] = useState<number | null>(null);
  const [flipSeq, setFlipSeq] = useState(0);
  const [autoPlay, setAutoPlay] = useState(false);
  const dragRef = useRef<{ startX: number; startIdx: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const safeIdx = idx % count;
  const activeFrame = frames[safeIdx] ?? frames[0];
  const turningFrame = prevIdx !== null ? frames[prevIdx % count] : null;
  const displayTitle = title ?? projectName ?? (isEn ? '3D Pocket Flipbook' : '3B Cep Flipbook');

  const stepTo = useCallback(
    (nextRaw: number, playAudio = true) => {
      const next = ((nextRaw % count) + count) % count;
      if (next === safeIdx) return;
      const reduced =
        typeof window !== 'undefined' &&
        Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
      setPrevIdx(reduced ? null : safeIdx);
      setIdx(next);
      setFlipSeq((s) => s + 1);
      if (playAudio) soundEngine.paperFlip();
    },
    [count, safeIdx]
  );

  useEffect(() => {
    if (!autoPlay || count <= 1) {
      setPrevIdx(null);
      return;
    }
    const reduced =
      typeof window !== 'undefined' &&
      Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    const ms = Math.max(75, Math.round(1000 / Math.min(15, fps)));
    const iv = window.setInterval(() => {
      setIdx((cur) => {
        const next = (cur + 1) % count;
        setPrevIdx(reduced ? null : cur);
        setFlipSeq((s) => s + 1);
        return next;
      });
    }, ms);
    return () => window.clearInterval(iv);
  }, [autoPlay, count, fps]);

  // Clear turning leaf cleanly after 240ms even if CSS animationend is skipped
  useEffect(() => {
    if (prevIdx === null) return;
    const t = window.setTimeout(() => setPrevIdx(null), 240);
    return () => window.clearTimeout(t);
  }, [flipSeq, prevIdx]);

  // Non-passive wheel listener so preventDefault never logs browser intervention warnings
  useEffect(() => {
    const el = stageRef.current;
    if (!el || count <= 1) return;
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      setAutoPlay(false);
      stepTo(safeIdx + (e.deltaY > 0 ? 1 : -1), true);
    };
    el.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => el.removeEventListener('wheel', onNativeWheel);
  }, [count, safeIdx, stepTo]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore synthetic pointer
    }
    setAutoPlay(false);
    setPrevIdx(null);
    dragRef.current = { startX: e.clientX, startIdx: safeIdx };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || count <= 1) return;
    const dx = e.clientX - dragRef.current.startX;
    const steps = Math.round(dx / 18);
    const target = (((dragRef.current.startIdx + steps) % count) + count) % count;
    if (target !== safeIdx) stepTo(target, true);
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div
      className={`rounded-2xl console-well border border-desk-border ${
        compact ? 'p-3' : 'p-4'
      } flex ${compact ? 'items-center gap-3.5' : 'flex-col gap-3'}`}
    >
      {/* 3D Bound Pocket Flipbook Object */}
      <div
        ref={stageRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={() => {
          if (!dragRef.current && count > 1) stepTo(safeIdx + 1, true);
        }}
        role="slider"
        tabIndex={0}
        aria-label={displayTitle}
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={safeIdx + 1}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') stepTo(safeIdx + 1, true);
          else if (e.key === 'ArrowLeft') stepTo(safeIdx - 1, true);
        }}
        className={`pocket-flip-stage cursor-grab active:cursor-grabbing select-none shrink-0 ${
          compact ? 'w-[126px] h-[78px]' : 'w-full max-w-[300px] aspect-[16/10] mx-auto'
        }`}
        title={
          isEn
            ? 'Drag, click, or scroll wheel to thumb-flip pages'
            : 'Sayfaları çevirmek için sürükle, tıkla veya tekerleği çevir'
        }
      >
        <div className="pocket-flip-book w-full h-full">
          {/* Physical stacked paper edge depth layers */}
          <div
            className="absolute inset-0 rounded-md border border-black/25 translate-x-[5px] translate-y-[5px]"
            style={{ backgroundColor: '#CFC5B2' }}
            aria-hidden="true"
          />
          <div
            className="absolute inset-0 rounded-md border border-black/20 translate-x-[2.5px] translate-y-[2.5px]"
            style={{ backgroundColor: '#E4DAC6' }}
            aria-hidden="true"
          />

          {/* Base Visible Page */}
          <div
            className="relative w-full h-full rounded-md border border-black/30 overflow-hidden shadow-lg [transform-style:preserve-3d]"
            style={{ backgroundColor: paperColor }}
          >
            {/* Left Pocket Binding Zone + Metallic Staples */}
            <div
              className="absolute left-0 top-0 bottom-0 w-4 bg-black/10 border-r border-dashed border-black/20 flex flex-col items-center justify-evenly z-20 pointer-events-none"
              aria-hidden="true"
            >
              <span className="w-1 h-2.5 rounded-full bg-neutral-700/80" />
              <span className="w-1 h-2.5 rounded-full bg-neutral-700/80" />
            </div>

            {activeFrame?.thumbKey ? (
              <BlobImage
                blobKey={activeFrame.thumbKey}
                alt={`Flipbook #${safeIdx + 1}`}
                className="w-full h-full object-contain pl-3 pointer-events-none"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center font-mono text-[11px] text-neutral-500 pl-3">
                #{safeIdx + 1}
              </div>
            )}

            {/* Double-Sided 3D Turning Top Leaf (Front Artwork + Clean Back Paper Sheet!) */}
            {turningFrame && flipSeq > 0 && (
              <div
                key={flipSeq}
                onAnimationEnd={() => setPrevIdx(null)}
                className="pocket-leaf-turning absolute inset-0 pointer-events-none z-10 [transform-style:preserve-3d]"
              >
                {/* Front Face (0deg -> -90deg) */}
                <div
                  className="absolute inset-0 rounded-md border border-black/20 overflow-hidden shadow-md [backface-visibility:hidden]"
                  style={{ backgroundColor: paperColor }}
                >
                  {turningFrame.thumbKey && (
                    <BlobImage
                      blobKey={turningFrame.thumbKey}
                      alt=""
                      className="w-full h-full object-contain pl-3"
                    />
                  )}
                </div>
                {/* Back Paper Face (-90deg -> -135deg — prevents mirrored image bleed!) */}
                <div
                  className="absolute inset-0 rounded-md border border-black/15 shadow-sm [backface-visibility:hidden] [transform:rotateY(180deg)]"
                  style={{ backgroundColor: '#EAE0CC' }}
                />
              </div>
            )}

            {/* Corner Frame Number Stamp */}
            <span className="absolute bottom-1 right-1.5 px-1.5 py-0.5 rounded bg-neutral-950/80 text-[#F7F3E9] font-mono text-[11px] z-20 pointer-events-none">
              #{String(safeIdx + 1).padStart(2, '0')}/{String(count).padStart(2, '0')}
            </span>
          </div>
        </div>
      </div>

      {/* Info & Controls */}
      <div className="min-w-0 flex-1 flex flex-col justify-between gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-extrabold text-desk-text">
              <BookOpen className="w-3.5 h-3.5 text-ink-brass shrink-0" />
              <span className="truncate">{displayTitle}</span>
            </div>
            {subtitle && (
              <p className="text-[11px] text-desk-muted leading-snug mt-0.5">{subtitle}</p>
            )}
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={isEn ? 'Close 3D Flipbook' : '3B Flipbook Kapat'}
              className="p-1 rounded-lg bg-desk-surface border border-desk-border text-desk-muted hover:text-desk-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => {
              soundEngine.click(1.05);
              setAutoPlay((p) => !p);
            }}
            className="px-2.5 py-1 rounded-lg bg-desk-surface border border-desk-border text-[11px] font-mono font-bold text-desk-text hover:border-ink-brass inline-flex items-center gap-1.5 transition-colors"
            title={isEn ? 'Auto-flip pages' : 'Otomatik Çevir'}
          >
            {autoPlay ? <Pause className="w-3 h-3 text-ink-vermilion" /> : <Play className="w-3 h-3 text-ink-brass" />}
            <span>{autoPlay ? (isEn ? 'Pause' : 'Durdur') : (isEn ? 'Auto Flip' : 'Otomatik Çevir')} · {safeIdx + 1}/{count}</span>
          </button>

          {actionLabel && onAction && (
            <button
              type="button"
              onClick={() => {
                soundEngine.click(1.1);
                onAction();
              }}
              className="ml-auto px-2.5 py-1 rounded-lg bg-ink-brass/15 border border-ink-brass/50 text-[11px] font-bold text-ink-brass hover:bg-ink-brass/25 transition-colors whitespace-nowrap"
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
