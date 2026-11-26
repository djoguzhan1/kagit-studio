import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { soundEngine } from '../../engine/soundEngine';

/** Shared zero-lag pointer 3D tilt hook for signature mechanical workshop objects */
function useMechTilt(maxDeg = 10) {
  const ref = useRef<HTMLButtonElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'touch') return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    const py = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
    const nx = (px - 0.5) * 2;
    const ny = (py - 0.5) * 2;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      el.dataset.tilting = 'true';
      el.style.setProperty('--rx', `${(-ny * maxDeg).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${(nx * maxDeg).toFixed(2)}deg`);
      el.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
      el.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
    });
  };

  const onPointerLeave = () => {
    const el = ref.current;
    if (!el) return;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    delete el.dataset.tilting;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
  };

  return { ref, onPointerMove, onPointerLeave };
}

/**
 * 1. SIGNATURE 3D CINEMA CLAPPERBOARD BUTTON
 * Hinged striped wooden clapper arm lifts on hover in 3D space and SNAPS shut with "TAK!" audio on click.
 */
export function Clapperboard3DButton({
  title,
  subtitle,
  sceneStamp = 'SAHNE 01',
  active = false,
  activeBadge = 'AYAR',
  settingsTitle = 'Sahne ayarları',
  onClick,
  onSettingsClick,
  onHover,
}: {
  title: string;
  subtitle: string;
  sceneStamp?: string;
  active?: boolean;
  activeBadge?: string;
  settingsTitle?: string;
  onClick: () => void;
  onSettingsClick?: () => void;
  onHover?: () => void;
}) {
  const { ref, onPointerMove, onPointerLeave } = useMechTilt(9);
  const [snapping, setSnapping] = useState(false);

  const handleClick = () => {
    soundEngine.clapperSnap();
    setSnapping(true);
    window.setTimeout(() => setSnapping(false), 380);
    onClick();
  };

  return (
    <div className="relative">
      <button
        ref={ref}
        type="button"
        data-snapping={snapping ? 'true' : undefined}
        onClick={handleClick}
        onMouseEnter={onHover}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        className="mech-obj pt-3"
      >
        <div className="mech-body">
          {/* Hinged Top Clapper Arm */}
          <div className="clapper-arm relative mx-1 mb-[-3px] z-20 flex items-center pl-2.5">
            <span
              className="w-2.5 h-2.5 rounded-full bg-[#D99B26] border border-[#1a1815] shadow-inner"
              aria-hidden="true"
            />
          </div>

          {/* Machined Slate Body */}
          <div className="clapper-slate relative rounded-2xl overflow-hidden">
            <div className="clapper-bar-base" />
            <div className="mech-glare" />
            {snapping && <div className="clapper-flash" />}

            <div className="relative z-10 px-4 py-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0 pr-12">
                <div className="flex items-center gap-2 font-mono text-[11px] tracking-wider uppercase text-ink-brass font-bold">
                  <span className="hardware-led" data-on="vermilion" />
                  <span className="truncate">{sceneStamp}</span>
                  {active && <span className="text-desk-text/80">· {activeBadge}</span>}
                </div>
                <div className="text-[16px] font-extrabold tracking-tight mt-0.5 text-desk-text">
                  {title}
                </div>
                <div className="text-xs text-desk-muted mt-0.5 leading-snug">{subtitle}</div>
              </div>

              <div className="w-10 h-10 rounded-xl bg-ink-vermilion text-white flex items-center justify-center shadow-md border border-white/25 shrink-0 font-mono text-lg font-extrabold">
                +
              </div>
            </div>
          </div>
        </div>
      </button>

      {onSettingsClick && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            soundEngine.click(1.05);
            onSettingsClick();
          }}
          title={settingsTitle}
          aria-label={settingsTitle}
          aria-expanded={active}
          className={`absolute bottom-3.5 right-[62px] h-10 w-9 z-30 rounded-xl border inline-flex items-center justify-center transition-colors ${
            active
              ? 'bg-ink-brassBright text-[#1c1405] border-[#fae098] shadow'
              : 'bg-desk-well/90 text-ink-brass border-desk-border hover:border-ink-brass hover:text-desk-text'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

/**
 * 2. SIGNATURE 3D MACHINED CAMERA SHUTTER LENS BUTTON
 * Knurled aluminum barrel rotates on hover, 6-blade iris opens/snaps shut on click with shutter audio.
 */
export function ShutterLens3DButton({
  title,
  subtitle,
  badge = 'KAĞIT MASASI',
  compact = false,
  onClick,
  onHover,
}: {
  title: string;
  subtitle: string;
  badge?: string;
  compact?: boolean;
  onClick: () => void;
  onHover?: () => void;
}) {
  const { ref, onPointerMove, onPointerLeave } = useMechTilt(10);
  const [snapping, setSnapping] = useState(false);

  const handleClick = () => {
    soundEngine.shutter();
    setSnapping(true);
    window.setTimeout(() => setSnapping(false), 320);
    onClick();
  };

  return (
    <button
      ref={ref}
      type="button"
      data-snapping={snapping ? 'true' : undefined}
      onClick={handleClick}
      onMouseEnter={onHover}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className="mech-obj h-full"
    >
      <div className={`mech-body shutter-chassis ${compact ? 'p-3.5 h-full' : 'p-4'} overflow-hidden`}>
        <div className="mech-glare" />
        <div
          className={`relative z-10 flex ${
            compact ? 'flex-col justify-between gap-2.5 h-full' : 'items-center justify-between gap-3'
          }`}
        >
          <div className={compact ? 'flex items-start justify-between gap-2' : 'min-w-0'}>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-brass font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-ink-vermilion shrink-0" />
                <span className="truncate">{badge}</span>
              </div>
              <div className={`${compact ? 'text-[14px]' : 'text-sm'} font-extrabold tracking-tight mt-1 text-desk-text leading-snug`}>
                {title}
              </div>
              {!compact && <div className="text-xs text-desk-muted mt-0.5 leading-snug">{subtitle}</div>}
            </div>

            {compact && (
              <div
                className="lens-barrel shrink-0"
                style={{ width: 44, height: 44 }}
                aria-hidden="true"
              >
                <svg viewBox="0 0 44 44" className="w-8 h-8">
                  <circle cx="22" cy="22" r="18" fill="#121110" stroke="#9e9585" strokeWidth="1.5" />
                  <g className="lens-iris-blades" stroke="#D99B26" strokeWidth="1.6" strokeLinecap="round">
                    <circle cx="22" cy="22" r="11" fill="#1e1b18" />
                    <path d="M22 11l5.5 9.5M31.5 16.5h-11M31.5 27.5L26 18M22 33l-5.5-9.5M12.5 27.5h11M12.5 16.5L18 26" />
                    <circle cx="22" cy="22" r="4.2" fill="#09090b" stroke="#f7f3e9" strokeWidth="1.2" />
                  </g>
                  <circle cx="17" cy="16" r="2.2" fill="#ffffff" opacity="0.55" />
                </svg>
              </div>
            )}
          </div>

          {compact ? (
            <div className="text-[11px] opacity-75 leading-snug">{subtitle}</div>
          ) : (
            <div className="lens-barrel shrink-0" aria-hidden="true">
              <svg viewBox="0 0 44 44" className="w-10 h-10">
                <circle cx="22" cy="22" r="18" fill="#121110" stroke="#9e9585" strokeWidth="1.5" />
                <g className="lens-iris-blades" stroke="#D99B26" strokeWidth="1.6" strokeLinecap="round">
                  <circle cx="22" cy="22" r="11" fill="#1e1b18" />
                  <path d="M22 11l5.5 9.5M31.5 16.5h-11M31.5 27.5L26 18M22 33l-5.5-9.5M12.5 27.5h11M12.5 16.5L18 26" />
                  <circle cx="22" cy="22" r="4.2" fill="#09090b" stroke="#f7f3e9" strokeWidth="1.2" />
                </g>
                <circle cx="17" cy="16" r="2.2" fill="#ffffff" opacity="0.55" />
              </svg>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * 3. SIGNATURE 3D MARIONETTE CROSS & PENDULUM PUPPET BUTTON
 * Wooden/brass control crossbar tilts on hover while suspended jointed character figure sways smoothly.
 */
export function Marionette3DButton({
  title,
  subtitle,
  badge = '10 SN CANLANDIR',
  compact = false,
  onClick,
  onHover,
}: {
  title: string;
  subtitle: string;
  badge?: string;
  compact?: boolean;
  onClick: () => void;
  onHover?: () => void;
}) {
  const { ref, onPointerMove, onPointerLeave } = useMechTilt(10);

  const marionetteSvg = (
    <svg viewBox="0 0 56 56" className={`${compact ? 'w-9 h-9' : 'w-14 h-14'} shrink-0 text-desk-text`} aria-hidden="true">
      <g className="marionette-crossbar">
        <line x1="10" y1="10" x2="46" y2="10" stroke="#D99B26" strokeWidth="3.5" strokeLinecap="round" />
        <circle cx="28" cy="10" r="3" fill="#FAF6EE" stroke="#1c1405" strokeWidth="1.6" />
      </g>
      <g className="marionette-dangler">
        <line x1="16" y1="11" x2="18" y2="33" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 2" opacity="0.62" />
        <line x1="40" y1="11" x2="38" y2="33" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 2" opacity="0.62" />
        <line x1="28" y1="12" x2="28" y2="23" stroke="currentColor" strokeWidth="1.2" opacity="0.68" />
        <circle cx="28" cy="24" r="5.5" fill="#FAF6EE" stroke="#1c1405" strokeWidth="2.1" />
        <path d="M28 30v10M18 33l10 1 10-1M28 40l-6 10M28 40l6 10" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="18" cy="33" r="2.3" fill="#E54D2E" />
        <circle cx="38" cy="33" r="2.3" fill="#E54D2E" />
        <circle cx="28" cy="40" r="2" fill="#FAF6EE" stroke="#1c1405" strokeWidth="1.4" />
      </g>
    </svg>
  );

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        soundEngine.click(1.15);
        onClick();
      }}
      onMouseEnter={onHover}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className="mech-obj h-full"
    >
      <div className={`mech-body marionette-chassis ${compact ? 'p-3.5 h-full' : 'p-4'} overflow-hidden`}>
        <div className="mech-glare" />
        <div
          className={`relative z-10 flex ${
            compact ? 'flex-col justify-between gap-2.5 h-full' : 'items-center justify-between gap-3'
          }`}
        >
          <div className={compact ? 'flex items-start justify-between gap-2' : 'min-w-0'}>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-brass font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-ink-emerald shrink-0" />
                <span className="truncate">{badge}</span>
              </div>
              <div className={`${compact ? 'text-[14px]' : 'text-sm'} font-extrabold tracking-tight mt-1 text-desk-text leading-snug`}>
                {title}
              </div>
              {!compact && <div className="text-xs text-desk-muted mt-0.5 leading-snug">{subtitle}</div>}
            </div>
            {compact && marionetteSvg}
          </div>

          {compact ? (
            <div className="text-xs text-desk-muted leading-snug">{subtitle}</div>
          ) : (
            marionetteSvg
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * 3B. SIGNATURE 3D 16MM TWIN-REEL CINEMA PROJECTOR BUTTON (2.5D Film Director Studio)
 * Twin perforated aluminum film reels spin faster on hover while warm golden beam flares out.
 */
export function Projector3DButton({
  title,
  subtitle,
  badge = '2.5D FİLM YÖNETMENİ',
  onClick,
  onHover,
}: {
  title: string;
  subtitle: string;
  badge?: string;
  onClick: () => void;
  onHover?: () => void;
}) {
  const { ref, onPointerMove, onPointerLeave } = useMechTilt(9);
  const [snapping, setSnapping] = useState(false);

  const handleClick = () => {
    soundEngine.projectorClick();
    setSnapping(true);
    window.setTimeout(() => setSnapping(false), 360);
    onClick();
  };

  return (
    <button
      ref={ref}
      type="button"
      data-snapping={snapping ? 'true' : undefined}
      onClick={handleClick}
      onMouseEnter={onHover}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className="mech-obj w-full"
    >
      <div className="mech-body projector-chassis px-4 py-3.5 overflow-hidden">
        <div className="mech-glare" />
        <div className="projector-beam" aria-hidden="true" />

        <div className="relative z-10 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-brass font-bold">
              <span className="hardware-led" data-on="blue" />
              <span className="truncate">{badge}</span>
            </div>
            <div className="text-[15px] font-extrabold tracking-tight mt-0.5 text-desk-text leading-snug">
              {title}
            </div>
            <div className="text-xs text-desk-muted mt-0.5 leading-snug">{subtitle}</div>
          </div>

          {/* Twin Spinning 16mm Perforated Film Reels + Brass Projector Lens */}
          <div className="shrink-0 flex items-center gap-1.5" aria-hidden="true">
            <svg viewBox="0 0 68 46" className="w-[66px] h-[44px] overflow-visible">
              {/* Left 16mm Reel */}
              <g className="projector-reel" style={{ transformOrigin: '20px 16px' }}>
                <circle cx="20" cy="16" r="13" fill="#23201D" stroke="#D99B26" strokeWidth="1.8" />
                <circle cx="20" cy="16" r="4" fill="#D99B26" />
                <circle cx="20" cy="8.5" r="2.4" fill="#0F0E0D" />
                <circle cx="20" cy="23.5" r="2.4" fill="#0F0E0D" />
                <circle cx="12.5" cy="16" r="2.4" fill="#0F0E0D" />
                <circle cx="27.5" cy="16" r="2.4" fill="#0F0E0D" />
              </g>
              {/* Right 16mm Reel */}
              <g className="projector-reel projector-reel-rev" style={{ transformOrigin: '45px 16px' }}>
                <circle cx="45" cy="16" r="11" fill="#23201D" stroke="#B6ACA0" strokeWidth="1.6" />
                <circle cx="45" cy="16" r="3.4" fill="#E5B24B" />
                <circle cx="45" cy="9.8" r="2" fill="#0F0E0D" />
                <circle cx="45" cy="22.2" r="2" fill="#0F0E0D" />
                <circle cx="38.8" cy="16" r="2" fill="#0F0E0D" />
                <circle cx="51.2" cy="16" r="2" fill="#0F0E0D" />
              </g>
              {/* Film Strip Connecting Reels */}
              <path d="M12 27 L52 27" stroke="#D99B26" strokeWidth="1.4" strokeDasharray="3 2" opacity="0.7" />
              {/* Machined Projector Body + Brass Barrel Lens */}
              <rect x="13" y="27" width="38" height="16" rx="4" fill="#181614" stroke="#574F45" strokeWidth="1.4" />
              <circle cx="22" cy="35" r="2.4" fill="#E54D2E" />
              <rect x="51" y="30.5" width="9" height="9" rx="2" fill="#D99B26" stroke="#1C1917" strokeWidth="1.2" />
              <polygon points="60,31 68,26 68,44 60,39" fill="rgba(245, 198, 102, 0.35)" />
            </svg>
          </div>
        </div>
      </div>
    </button>
  );
}

/**
 * 4. 3D METAL TOGGLE LEVER SWITCH (Onion Skin, Guides, Symmetry, Day/Night)
 */
export function ToggleLeverSwitch({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title ?? label}
      onClick={() => {
        soundEngine.toggle(!checked);
        onChange(!checked);
      }}
      className="inline-flex items-center gap-2 group cursor-pointer"
    >
      {label && (
        <span className="font-mono text-[11px] uppercase tracking-wider text-desk-muted group-hover:text-desk-text transition-colors">
          {label}
        </span>
      )}
      <span className="lever-switch" data-on={checked ? 'true' : 'false'}>
        <span className="lever-switch-knob" />
      </span>
    </button>
  );
}

/**
 * 5. KNURLED BRASS ROTARY DIAL (Flip Wheel & Lightbox Dimmer)
 * Supports vertical/horizontal drag AND mouse wheel with physical brass rotation + detent ticks.
 */
export function BrassRotaryDial({
  value,
  min,
  max,
  step = 1,
  size = 42,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  size?: number;
  label: string;
  onChange: (next: number) => void;
}) {
  const dragRef = useRef<{ startX: number; startY: number; startVal: number } | null>(null);
  const span = Math.max(0.0001, max - min);
  const norm = Math.max(0, Math.min(1, (value - min) / span));
  const angle = -135 + norm * 270;

  const commitValue = (raw: number) => {
    const snapped = Math.round(raw / step) * step;
    const clamped = Math.max(min, Math.min(max, Number(snapped.toFixed(3))));
    if (clamped !== value) {
      soundEngine.dialTick();
      onChange(clamped);
    }
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title={`${label} (Sürükle veya tekerlekle çevir)`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startY: e.clientY, startVal: value };
      }}
      onPointerMove={(e) => {
        if (!dragRef.current) return;
        const deltaPx = e.clientX - dragRef.current.startX - (e.clientY - dragRef.current.startY);
        const nextVal = dragRef.current.startVal + (deltaPx / 120) * span;
        commitValue(nextVal);
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onWheel={(e) => {
        e.preventDefault();
        const dir = e.deltaY > 0 ? -1 : 1;
        commitValue(value + dir * step);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          commitValue(value + step);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          commitValue(value - step);
        }
      }}
      className="brass-dial"
      style={{ width: size, height: size }}
    >
      <div
        className="brass-dial-cap"
        style={{ transform: `rotate(${angle.toFixed(1)}deg)` }}
      >
        <span className="brass-dial-notch" />
      </div>
    </div>
  );
}

/**
 * 6. CARVED STUDIO PEN-TRAY TOOL SLOT (Eliminates cluttered identical button grid in ToolDeck)
 */
export function StudioToolSlot({
  active,
  accent = 'amber',
  onClick,
  title,
  className = '',
  children,
}: {
  active: boolean;
  accent?: 'amber' | 'blue' | 'vermilion';
  onClick: () => void;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-active={active ? 'true' : 'false'}
      data-accent={accent}
      onClick={() => {
        soundEngine.click(active ? 0.92 : 1.08);
        onClick();
      }}
      title={title}
      className={`tool-slot ${className}`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0 transition-colors"
        style={{
          backgroundColor: !active
            ? 'rgba(150, 140, 126, 0.28)'
            : accent === 'blue'
              ? '#3b82f6'
              : accent === 'vermilion'
                ? '#e54d2e'
                : '#f5b436',
          boxShadow: active ? '0 0 6px currentColor' : 'none',
        }}
        aria-hidden="true"
      />
      {children}
    </button>
  );
}
