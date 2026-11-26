import { soundEngine } from '../../engine/soundEngine';
import type { StudioTheme } from '../../types/studio';

interface DeskLamp3DProps {
  theme: StudioTheme;
  onToggle: () => void;
  title: string;
  nightLabel: string;
  dayLabel: string;
}

/**
 * Signature Articulated Brass Architect Desk Lamp
 * - Zero layout shift between Night & Day labels (CSS grid overlay stack).
 * - Compact >=44x44px icon button below xl (1280px) so 360px and 768px Desk headers never overflow!
 */
export function DeskLamp3D({
  theme,
  onToggle,
  title,
  nightLabel,
  dayLabel,
}: DeskLamp3DProps) {
  const isNight = theme === 'night';

  const handleClick = () => {
    soundEngine.lampSwitch(!isNight);
    onToggle();
  };

  return (
    <button
      type="button"
      data-desk-lamp="true"
      onClick={handleClick}
      title={title}
      aria-label={title}
      aria-pressed={isNight}
      data-lit={isNight ? 'true' : 'false'}
      className="desk-lamp-btn group relative min-w-[44px] min-h-[44px] inline-flex items-center justify-center gap-2 px-1.5 xl:pl-2 xl:pr-3 py-1 rounded-xl border border-desk-border bg-desk-well/85 hover:border-ink-brass/75 transition-colors cursor-pointer select-none shrink-0"
    >
      {/* Articulated Brass Arm + Sculpted Dome Shade SVG */}
      <span className="relative w-8 h-8 flex items-center justify-center shrink-0 overflow-visible">
        {isNight && (
          <span
            className="pointer-events-none absolute -bottom-1.5 -left-1 w-9 h-7 rounded-full opacity-85 transition-opacity"
            style={{
              background:
                'radial-gradient(circle, rgba(255,214,120,0.62) 0%, rgba(229,145,58,0.18) 58%, transparent 82%)',
            }}
            aria-hidden="true"
          />
        )}
        <svg viewBox="0 0 42 36" className="w-8 h-8 overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id="lampBrassShade" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={isNight ? '#F5D37E' : '#AFA391'} />
              <stop offset="55%" stopColor={isNight ? '#D99B26' : '#857968'} />
              <stop offset="100%" stopColor={isNight ? '#8C5E0B' : '#5E5549'} />
            </linearGradient>
          </defs>
          <rect x="30" y="27" width="10" height="5" rx="1.8" fill="#6F5320" stroke="#1C1917" strokeWidth="1.2" />
          <line x1="35" y1="27" x2="29" y2="12" stroke="#C88B1E" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="29" cy="12" r="2.6" fill="#F5D37E" stroke="#1C1917" strokeWidth="1.2" />
          <g className="desk-lamp-head">
            <line x1="29" y1="12" x2="17" y2="11" stroke="#E5B24B" strokeWidth="2.2" strokeLinecap="round" />
            <circle cx="17" cy="11" r="2.1" fill="#F5D37E" stroke="#1C1917" strokeWidth="1.1" />
            <path
              d="M17 11 C12 10, 7 15, 5 22 L19 24 C20 17, 19.5 13, 17 11 Z"
              fill="url(#lampBrassShade)"
              stroke="#1C1917"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <line x1="6.5" y1="22.2" x2="18.2" y2="23.8" stroke="#FAF2DE" strokeWidth="1.2" strokeLinecap="round" />
            <ellipse
              cx="12.2"
              cy="24.2"
              rx="3.4"
              ry="2.2"
              fill={isNight ? '#FFF4C2' : '#CFC7BA'}
              stroke={isNight ? '#F5B436' : '#736B60'}
              strokeWidth="0.9"
            />
          </g>
        </svg>
      </span>

      {/* Zero-Shift Dual-Label Stack on Desktop >= 1280px */}
      <span className="hidden xl:inline-grid items-center leading-tight">
        <span
          aria-hidden={!isNight}
          className={`col-start-1 row-start-1 font-mono text-[11px] uppercase tracking-wider text-ink-brass font-bold inline-flex items-center gap-1.5 whitespace-nowrap ${
            isNight ? 'visible' : 'invisible pointer-events-none'
          }`}
        >
          <span className="hardware-led" data-on="amber" />
          {nightLabel}
        </span>
        <span
          aria-hidden={isNight}
          className={`col-start-1 row-start-1 font-mono text-[11px] uppercase tracking-wider text-ink-brass font-bold inline-flex items-center gap-1.5 whitespace-nowrap ${
            !isNight ? 'visible' : 'invisible pointer-events-none'
          }`}
        >
          <span className="hardware-led" />
          {dayLabel}
        </span>
      </span>
    </button>
  );
}
