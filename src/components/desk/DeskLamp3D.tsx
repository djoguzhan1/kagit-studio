import { useState } from 'react';
import type { StudioTheme } from '../../types/studio';
import { soundEngine } from '../../engine/soundEngine';

interface DeskLamp3DProps {
  theme: StudioTheme;
  onToggle: () => void;
  title: string;
  nightLabel: string;
  dayLabel: string;
}

/**
 * Signature 3D Articulated Brass Architect Desk Lamp
 * - Replaces the ordinary Day/Night toggle on the Studio Desk Hub.
 * - Night = Warm tungsten bulb lit illuminating the Ink & Paper Cosmos.
 * - Day = Lamp tilted upright & switched off, revealing the Sunlit Sky Sketchbook.
 */
export function DeskLamp3D({
  theme,
  onToggle,
  title,
  nightLabel,
  dayLabel,
}: DeskLamp3DProps) {
  const [swinging, setSwinging] = useState(false);
  const isNight = theme === 'night';

  const handleClick = () => {
    const nextIsNight = !isNight;
    soundEngine.lampSwitch(nextIsNight);
    setSwinging(true);
    window.setTimeout(() => setSwinging(false), 520);
    onToggle();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title}
      aria-label={title}
      aria-pressed={isNight}
      data-lit={isNight ? 'true' : 'false'}
      data-swinging={swinging ? 'true' : undefined}
      className="desk-lamp-btn group relative inline-flex items-center gap-2 pl-2 pr-2.5 py-1 rounded-xl border border-desk-border bg-desk-well/80 hover:border-ink-brass/70 transition-all cursor-pointer select-none"
    >
      {/* Articulated Brass Arm + Dome Shade SVG */}
      <span className="relative w-9 h-8 flex items-center justify-center shrink-0 overflow-visible">
        {isNight && (
          <span
            className="pointer-events-none absolute -bottom-2 -left-1 w-9 h-7 rounded-full blur-md opacity-80 transition-opacity"
            style={{
              background:
                'radial-gradient(circle, rgba(255,214,120,0.75) 0%, rgba(229,145,58,0.22) 55%, transparent 80%)',
            }}
            aria-hidden="true"
          />
        )}
        <svg viewBox="0 0 42 36" className="w-9 h-8 overflow-visible" aria-hidden="true">
          {/* Machined Clamp Base on Right */}
          <rect x="30" y="27" width="10" height="5" rx="1.8" fill="#6F5320" stroke="#1C1917" strokeWidth="1.2" />
          {/* Lower Brass Arm */}
          <line x1="35" y1="27" x2="29" y2="12" stroke="#D99B26" strokeWidth="2.4" strokeLinecap="round" />
          {/* Elbow Pivot Joint */}
          <circle cx="29" cy="12" r="2.6" fill="#F5D37E" stroke="#1C1917" strokeWidth="1.2" />
          {/* Upper Arm + Pivoting Shade Head */}
          <g className="desk-lamp-head">
            <line x1="29" y1="12" x2="17" y2="11" stroke="#E5B24B" strokeWidth="2.2" strokeLinecap="round" />
            <circle cx="17" cy="11" r="2.1" fill="#F5D37E" stroke="#1C1917" strokeWidth="1.1" />
            {/* Iconic Architect Dome Shade */}
            <path
              d="M17 11 C12 10, 7 15, 5 22 L19 24 C20 17, 19.5 13, 17 11 Z"
              fill={isNight ? '#D99B26' : '#8C8172'}
              stroke="#1C1917"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            {/* Rim Highlight */}
            <line x1="6.5" y1="22.2" x2="18.2" y2="23.8" stroke="#FAF2DE" strokeWidth="1.2" strokeLinecap="round" />
            {/* Glowing Warm Bulb when Night / Cool Off Bulb when Day */}
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

      <span className="hidden sm:flex flex-col items-start leading-tight">
        <span className="font-mono text-[9px] uppercase tracking-widest text-ink-brass font-bold flex items-center gap-1">
          <span
            className="hardware-led"
            data-on={isNight ? 'amber' : undefined}
            data-pulse={isNight ? 'true' : undefined}
          />
          {isNight ? nightLabel : dayLabel}
        </span>
      </span>
    </button>
  );
}
