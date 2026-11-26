import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { soundEngine } from '../../engine/soundEngine';
import { getBlobObjectUrl } from '../../engine/db';

export type KeycapVariant = 'graphite' | 'vermilion' | 'brass' | 'ivory' | 'emerald' | 'blue';
export type KeycapSize = 'sm' | 'md' | 'lg';
export type KeycapLedTone = 'off' | 'amber' | 'vermilion' | 'emerald' | 'blue';

export interface KeycapButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: KeycapVariant;
  size?: KeycapSize;
  led?: KeycapLedTone;
  ledPulse?: boolean;
  pressed?: boolean;
  tilt?: boolean;
  socket?: boolean;
  sheenPulse?: boolean;
  sheenDelay?: number;
  sound?: 'click' | 'toggle' | 'flip' | 'shutter' | 'none';
  shortcut?: string;
  children: ReactNode;
}

function splitKeycapClasses(cls: string): { outer: string; inner: string } {
  if (!cls) return { outer: '', inner: '' };
  const outerTokens: string[] = [];
  const innerTokens: string[] = [];
  for (const tok of cls.trim().split(/\s+/)) {
    if (!tok) continue;
    if (
      /^(w-|min-w-|max-w-|flex$|flex-1$|shrink|grow|col-span-|self-|ml-|mr-|mx-|mt-|mb-|my-|hidden$|(sm|md|lg|xl|2xl):(hidden|inline-flex|flex|w-))/.test(
        tok
      )
    ) {
      outerTokens.push(tok);
    } else {
      innerTokens.push(tok);
    }
  }
  return { outer: outerTokens.join(' '), inner: innerTokens.join(' ') };
}

export function KeycapButton({
  variant = 'graphite',
  size = 'md',
  led,
  ledPulse = false,
  pressed = false,
  tilt = true,
  socket = false,
  sheenPulse = false,
  sheenDelay = 0,
  sound = 'click',
  shortcut,
  className = '',
  style,
  onClick,
  onPointerMove,
  onPointerLeave,
  children,
  ...rest
}: KeycapButtonProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const rafRef = useRef<number | null>(null);
  const [ripple, setRipple] = useState<{ id: number; x: number; y: number } | null>(null);

  const variantClass = variant === 'graphite' ? '' : `k3d-${variant}`;
  const sizeOuterClass = size === 'sm' ? 'k3d-sm min-w-[44px]' : size === 'lg' ? 'k3d-lg min-w-[44px]' : 'min-w-[44px]';
  // Raise + cap min-height guarantees >= 44x44 CSS px WCAG 2.2 SC 2.5.5 touch target across all sizes!
  const sizeCapClass =
    size === 'sm'
      ? 'min-h-[39px] px-2.5 py-1.5 text-xs'
      : size === 'lg'
        ? 'min-h-[44px] px-5 py-3 text-sm'
        : 'min-h-[39px] px-3.5 py-2 text-xs';

  const { outer, inner } = splitKeycapClasses(className);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    onPointerMove?.(e);
    if (!tilt || e.pointerType === 'touch' || rest.disabled) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const el = btnRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const px = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const py = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
    const nx = (px - 0.5) * 2;
    const ny = (py - 0.5) * 2;
    const maxTiltX = size === 'lg' ? 13 : size === 'md' ? 9.5 : 7;
    const maxTiltY = size === 'lg' ? 11 : size === 'md' ? 8.5 : 6.5;

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      el.dataset.tilting = 'true';
      el.style.setProperty('--rx', `${(-ny * maxTiltX).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${(nx * maxTiltY).toFixed(2)}deg`);
      el.style.setProperty('--tx', `${(nx * 5).toFixed(1)}px`);
      el.style.setProperty('--ty', `${(ny * 4).toFixed(1)}px`);
      el.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
      el.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
    });
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLButtonElement>) => {
    onPointerLeave?.(e);
    const el = btnRef.current;
    if (!el) return;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    delete el.dataset.tilting;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--tx', '0px');
    el.style.setProperty('--ty', '0px');
  };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = btnRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const x = e.clientX ? e.clientX - rect.left : rect.width / 2;
      const y = e.clientY ? e.clientY - rect.top : rect.height / 2;
      const id = Date.now();
      setRipple({ id, x, y });
      window.setTimeout(() => {
        setRipple((cur) => (cur?.id === id ? null : cur));
      }, 450);
    }

    if (sound === 'click') soundEngine.click();
    else if (sound === 'toggle') soundEngine.toggle(!pressed);
    else if (sound === 'flip') soundEngine.paperFlip();
    else if (sound === 'shutter') soundEngine.shutter();
    onClick?.(e);
  };

  const mergedStyle: CSSProperties = sheenDelay
    ? ({ ...style, '--sheen-delay': `${sheenDelay}s` } as CSSProperties)
    : (style ?? {});

  const buttonEl = (
    <button
      ref={btnRef}
      type="button"
      data-pressed={pressed ? 'true' : undefined}
      data-sheen={sheenPulse ? 'true' : undefined}
      onClick={handleClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={mergedStyle}
      className={`k3d ${variantClass} ${sizeOuterClass} ${socket ? 'w-full' : outer}`}
      {...rest}
    >
      <span className="k3d-shadow" aria-hidden="true" />
      <span className="k3d-wall" aria-hidden="true" />
      <span className={`k3d-cap ${sizeCapClass} ${inner}`}>
        <span className="k3d-dish" aria-hidden="true" />
        <span className="k3d-fx" aria-hidden="true">
          <span className="k3d-glare" />
          <span className="k3d-sheen" />
          {ripple && (
            <span
              key={ripple.id}
              className="k3d-ripple"
              style={{ left: `${ripple.x}px`, top: `${ripple.y}px` }}
            />
          )}
        </span>
        <span className="k3d-content">
          {led !== undefined && (
            <span
              className="hardware-led"
              data-on={led === 'off' ? undefined : led}
              data-pulse={led !== 'off' && ledPulse ? 'true' : undefined}
              aria-hidden="true"
            />
          )}
          {children}
          {shortcut && (
            <span className="ml-0.5 font-mono text-[11px] opacity-65 hidden sm:inline">
              {shortcut}
            </span>
          )}
        </span>
      </span>
    </button>
  );

  if (!socket) return buttonEl;
  return <span className={`keycap-socket ${outer}`}>{buttonEl}</span>;
}

/** Memory-safe LRU-backed image preview for IndexedDB blobs */
export function BlobImage({
  blobKey,
  alt = '',
  className = '',
}: {
  blobKey: string | null | undefined;
  alt?: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!blobKey) {
      setUrl(null);
      return;
    }
    void getBlobObjectUrl(blobKey).then((resolved) => {
      if (active) setUrl(resolved);
    });
    return () => {
      active = false;
    };
  }, [blobKey]);

  if (!url) return null;
  return <img src={url} alt={alt} className={className} draggable={false} />;
}
