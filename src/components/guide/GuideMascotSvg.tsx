import { useEffect, useState } from 'react';

interface GuideMascotSvgProps {
  celebrating?: boolean;
  lookX?: number; // -1..1
  lookY?: number; // -1..1
  className?: string;
}

/**
 * Living Mini Mascot ("Bereli Gezgin") — breathes, blinks, looks toward the active target,
 * and jumps with golden ink sparkles whenever the user completes a guided step!
 */
export function GuideMascotSvg({
  celebrating = false,
  lookX = 0,
  lookY = 0,
  className = 'w-14 h-14',
}: GuideMascotSvgProps) {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 150);
    }, 3200);
    return () => clearInterval(iv);
  }, []);

  const eyeOffX = Math.max(-2.2, Math.min(2.2, lookX * 2.2));
  const eyeOffY = Math.max(-1.6, Math.min(1.6, lookY * 1.6));

  return (
    <svg
      viewBox="0 0 80 86"
      fill="none"
      aria-hidden="true"
      className={`${className} shrink-0 ${celebrating ? 'tour-mascot-celebrate' : 'tour-mascot-idle'}`}
    >
      {/* Celebration golden ink sparks */}
      {celebrating && (
        <g stroke="#D99B26" strokeWidth="2.4" strokeLinecap="round">
          <line x1="10" y1="16" x2="17" y2="21" />
          <line x1="70" y1="14" x2="63" y2="20" />
          <line x1="40" y1="3" x2="40" y2="9" />
          <circle cx="14" cy="36" r="2.2" fill="#E54D2E" stroke="none" />
          <circle cx="67" cy="34" r="2.2" fill="#E54D2E" stroke="none" />
        </g>
      )}

      {/* Ground shadow */}
      <ellipse cx="40" cy="80" rx="18" ry="4" fill="rgba(0,0,0,0.22)" />

      {/* Artist coat */}
      <path
        d="M27 52 Q22 66 25 76 Q40 80 55 76 Q58 66 53 52 Z"
        fill="#2B2622"
        stroke="#1C1917"
        strokeWidth="2.8"
        strokeLinejoin="round"
      />

      {/* Expressive arms (raised when celebrating!) */}
      {celebrating ? (
        <g stroke="#1C1917" strokeWidth="3.4" strokeLinecap="round">
          <path d="M26 57 Q15 47 13 38" />
          <path d="M54 57 Q65 47 67 38" />
          <circle cx="13" cy="37" r="3.6" fill="#FAF3E4" strokeWidth="2" />
          <circle cx="67" cy="37" r="3.6" fill="#FAF3E4" strokeWidth="2" />
        </g>
      ) : (
        <g stroke="#1C1917" strokeWidth="3.4" strokeLinecap="round">
          <path d="M26 57 Q17 60 15 53" />
          <path d="M54 57 Q63 54 66 47" />
          <circle cx="15" cy="53" r="3.4" fill="#FAF3E4" strokeWidth="2" />
          <circle cx="66" cy="47" r="3.4" fill="#FAF3E4" strokeWidth="2" />
        </g>
      )}

      {/* Flowing vermilion scarf */}
      <path
        d="M46 53 Q57 60 53 70 L47 68 Q49 60 43 54 Z"
        fill="#C93A21"
        stroke="#1C1917"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <rect
        x="24"
        y="48"
        width="32"
        height="9"
        rx="4.5"
        fill="#E54D2E"
        stroke="#1C1917"
        strokeWidth="2.4"
      />

      {/* Warm ivory head */}
      <ellipse
        cx="40"
        cy="34"
        rx="17"
        ry="15.5"
        fill="#FAF3E4"
        stroke="#1C1917"
        strokeWidth="2.8"
      />

      {/* Rosy cheeks */}
      <ellipse cx="29" cy="38" rx="3.2" ry="1.8" fill="rgba(229,77,46,0.28)" />
      <ellipse cx="51" cy="38" rx="3.2" ry="1.8" fill="rgba(229,77,46,0.28)" />

      {/* Eyes (blink & look toward active target!) */}
      {blinking ? (
        <g stroke="#1C1917" strokeWidth="2.4" strokeLinecap="round">
          <path d="M31 33 Q33.5 35.5 36 33" />
          <path d="M44 33 Q46.5 35.5 49 33" />
        </g>
      ) : (
        <g transform={`translate(${eyeOffX.toFixed(1)}, ${eyeOffY.toFixed(1)})`}>
          <ellipse cx="33.5" cy="32.5" rx="2.3" ry="3.2" fill="#1C1917" />
          <ellipse cx="46.5" cy="32.5" rx="2.3" ry="3.2" fill="#1C1917" />
          <circle cx="32.8" cy="31.3" r="0.95" fill="#FAF6EE" />
          <circle cx="45.8" cy="31.3" r="0.95" fill="#FAF6EE" />
        </g>
      )}

      {/* Joyful smile */}
      {celebrating ? (
        <path
          d="M34 39 Q40 46 46 39 Z"
          fill="#C93A21"
          stroke="#1C1917"
          strokeWidth="2.1"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M35.5 39.5 Q40 43.2 44.5 39.5"
          stroke="#1C1917"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      )}

      {/* Unified INKTROPE Atelier Fedora Brim + Striped Paper-Horn Crests */}
      <ellipse
        cx="40"
        cy="20.5"
        rx="22"
        ry="4.2"
        fill="#1E1B18"
        stroke="#1C1917"
        strokeWidth="2.2"
      />
      <path
        d="M27 20 L30 10.5 L37 13 L44 9.8 L52 20 Z"
        fill="#26221E"
        stroke="#1C1917"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="M29 18 Q23 12 26 5.5 Q30 10 33 16.5 Z" fill="#FAF6EC" stroke="#1C1917" strokeWidth="2" strokeLinejoin="round" />
      <path d="M26 11.5 L30.5 12.5" stroke="#1C1917" strokeWidth="1.5" />
      <path d="M51 18 Q57 12 54 5.5 Q50 10 47 16.5 Z" fill="#FAF6EC" stroke="#1C1917" strokeWidth="2" strokeLinejoin="round" />
      <path d="M54 11.5 L49.5 12.5" stroke="#1C1917" strokeWidth="1.5" />
      <path d="M28.5 19.2 Q40 20.8 51.5 19.2" stroke="#D99B26" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
