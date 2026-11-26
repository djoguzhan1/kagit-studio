import { useEffect, useRef, useState } from 'react';
import { BookOpen, Pause, Play } from 'lucide-react';
import type { CelFrame } from '../../types/studio';
import { BlobImage } from './KeycapButton';
import { soundEngine } from '../../engine/soundEngine';

interface PocketFlipbook3DPreviewProps {
  frames: CelFrame[];
  paperColor?: string;
  fps?: number;
  title?: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

/**
 * Interactive 3D Physical Pocket Flipbook Thumb-Flipper:
 * Drag horizontally/vertically, scroll with mouse wheel, or hit play to flip
 * real 3D bound pages with subtle left-margin staples & tactile paper rustle audio.
 */
export function PocketFlipbook3DPreview({
  frames,
  paperColor = '#F7F3E9',
  fps = 12,
  title,
  subtitle,
  actionLabel,
  onAction,
  compact = false,
}: PocketFlipbook3DPreviewProps) {
  const count = Math.max(1, frames.length);
  const [idx, setIdx] = useState(0);
  const [prevIdx, setPrevIdx] = useState<number | null>(null);
  const [flipSeq, setFlipSeq] = useState(0);
  const [autoPlay, setAutoPlay] = useState(false);
  const dragRef = useRef<{ startX: number; startIdx: number } | null>(null);

  const safeIdx = idx % count;
  const activeFrame = frames[safeIdx] ?? frames[0];
  const turningFrame = prevIdx !== null ? frames[prevIdx % count] : null;

  const stepTo = (nextRaw: number, playAudio = true) => {
    const next = ((nextRaw % count) + count) % count;
    if (next === safeIdx) return;
    setPrevIdx(safeIdx);
    setIdx(next);
    setFlipSeq((s) => s + 1);
    if (playAudio) soundEngine.paperFlip();
  };

  useEffect(() => {
    if (!autoPlay || count <= 1) return;
    const ms = Math.max(75, Math.round(1000 / Math.min(15, fps)));
    const iv = setInterval(() => {
      setIdx((cur) => {
        const next = (cur + 1) % count;
        setPrevIdx(cur);
        setFlipSeq((s) => s + 1);
        return next;
      });
    }, ms);
    return () => clearInterval(iv);
  }, [autoPlay, count, fps]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setAutoPlay(false);
    dragRef.current = { startX: e.clientX, startIdx: safeIdx };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || count <= 1) return;
    const dx = e.clientX - dragRef.current.startX;
    const steps = Math.round(dx / 18);
    const target = ((dragRef.current.startIdx + steps) % count + count) % count;
    if (target !== safeIdx) stepTo(target, true);
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (count <= 1) return;
    e.preventDefault();
    setAutoPlay(false);
    stepTo(safeIdx + (e.deltaY > 0 ? 1 : -1), true);
  };

  return (
    <div
      className={`rounded-2xl console-well border border-desk-border ${
        compact ? 'p-3' : 'p-4'
      } flex ${compact ? 'items-center gap-3.5' : 'flex-col gap-3'}`}
    >
      {/* 3D Bound Pocket Flipbook Object */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onClick={() => {
          if (!dragRef.current && count > 1) stepTo(safeIdx + 1, true);
        }}
        role="slider"
        tabIndex={0}
        aria-label={title ?? '3D Cep Flipbook Önizleme'}
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={safeIdx + 1}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') stepTo(safeIdx + 1, true);
          else if (e.key === 'ArrowLeft') stepTo(safeIdx - 1, true);
        }}
        className={`pocket-flip-stage cursor-grab active:cursor-grabbing select-none shrink-0 ${
          compact ? 'w-[126px] h-[78px]' : 'w-full max-w-[280px] aspect-[16/10] mx-auto'
        }`}
        title="Sayfaları çevirmek için sürükle, tıkla veya tekerleği çevir"
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
            className="relative w-full h-full rounded-md border border-black/30 overflow-hidden shadow-lg"
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
              <div className="w-full h-full flex items-center justify-center font-mono text-[9px] text-neutral-500 pl-3">
                #{safeIdx + 1}
              </div>
            )}

            {/* Turning Top Leaf Animation Overlay */}
            {turningFrame && flipSeq > 0 && (
              <div
                key={flipSeq}
                className="pocket-leaf-turning absolute inset-0 rounded-md border border-black/20 overflow-hidden pointer-events-none z-10 shadow-md"
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
            )}

            {/* Corner Frame Number Stamp */}
            <span className="absolute bottom-1 right-1.5 px-1 py-0.5 rounded bg-neutral-950/80 text-[#F7F3E9] font-mono text-[8px] z-20 pointer-events-none">
              #{String(safeIdx + 1).padStart(2, '0')}/{String(count).padStart(2, '0')}
            </span>
          </div>
        </div>
      </div>

      {/* Info & Controls */}
      <div className="min-w-0 flex-1 flex flex-col justify-between gap-1.5">
        <div>
          {title && (
            <div className="flex items-center gap-1.5 text-xs font-extrabold text-desk-text">
              <BookOpen className="w-3.5 h-3.5 text-ink-brass shrink-0" />
              <span className="truncate">{title}</span>
            </div>
          )}
          {subtitle && (
            <p className="text-[11px] text-desk-muted leading-snug mt-0.5">{subtitle}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => {
              soundEngine.click(1.05);
              setAutoPlay((p) => !p);
            }}
            className="px-2 py-1 rounded-lg bg-desk-surface border border-desk-border text-[10px] font-mono font-bold text-desk-text hover:border-ink-brass inline-flex items-center gap-1 transition-colors"
            title="Otomatik Çevir"
          >
            {autoPlay ? <Pause className="w-3 h-3 text-ink-vermilion" /> : <Play className="w-3 h-3 text-ink-brass" />}
            <span>{safeIdx + 1}/{count}</span>
          </button>

          {actionLabel && onAction && (
            <button
              type="button"
              onClick={() => {
                soundEngine.click(1.1);
                onAction();
              }}
              className="ml-auto px-2.5 py-1 rounded-lg bg-ink-brass/15 border border-ink-brass/50 text-[10px] font-bold text-ink-brass hover:bg-ink-brass/25 transition-colors whitespace-nowrap"
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
