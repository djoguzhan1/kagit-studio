import { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../i18n/translations';
import { safeSetPointerCapture } from '../../utils/pointerCapture';

/** Pure perceived-luminance contrast helper so swatch text is ALWAYS WCAG-legible on dark or light inks */
export function getContrastTextColor(hex: string): '#FAF6EE' | '#181614' {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0');
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.54 ? '#181614' : '#FAF6EE';
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (hn < 60) [r, g, b] = [c, x, 0];
  else if (hn < 120) [r, g, b] = [x, c, 0];
  else if (hn < 180) [r, g, b] = [0, c, x];
  else if (hn < 240) [r, g, b] = [0, x, c];
  else if (hn < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return (
    '#' +
    [r + m, g + m, b + m]
      .map((v) =>
        Math.round(Math.max(0, Math.min(1, v)) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
      .toUpperCase()
  );
}

/**
 * Custom Artist Studio HSL Color Wheel + Auto Warm-Light / Cool-Shadow Companion Chips + Recent 8 Swatches.
 * Replaces the jarring OS `<input type="color">` dialog completely!
 */
export default function ColorWheelPopover({
  color,
  recentColors,
  onChange,
  onAddPalette,
  onClose,
}: {
  color: string;
  recentColors: string[];
  onChange: (hex: string) => void;
  onAddPalette: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const wheelRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  const hsl = useMemo(() => hexToHsl(color), [color]);

  // Companion cel-shading helper: cooler darker shadow + warmer brighter highlight!
  const shadowHex = useMemo(() => hslToHex(hsl.h + 14, Math.min(95, hsl.s + 8), Math.max(8, hsl.l - 18)), [hsl]);
  const highlightHex = useMemo(() => hslToHex(hsl.h - 10, Math.max(12, hsl.s - 6), Math.min(96, hsl.l + 18)), [hsl]);

  useEffect(() => {
    const c = wheelRef.current;
    if (!c) return;
    const size = 152;
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    const cx = size / 2;
    const cy = size / 2;
    const outerR = size / 2 - 4;
    const innerR = outerR - 18;

    ctx.clearRect(0, 0, size, size);
    // Draw crisp smooth HSL Hue Ring
    for (let deg = 0; deg < 360; deg += 2) {
      const a0 = ((deg - 1) * Math.PI) / 180;
      const a1 = ((deg + 2) * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, a0, a1);
      ctx.arc(cx, cy, innerR, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = `hsl(${deg}, 88%, 54%)`;
      ctx.fill();
    }

    // Inner preview disc in active color
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Active hue marker dot on ring
    const rad = (hsl.h * Math.PI) / 180;
    const mr = (outerR + innerR) / 2;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(rad) * mr, cy + Math.sin(rad) * mr, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#161513';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [color, hsl.h]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pickHueFromPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = wheelRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    onChange(hslToHex(deg, Math.max(15, hsl.s), Math.max(12, Math.min(88, hsl.l))));
  };

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-40" />
      <div className="fixed left-3 lg:left-[224px] top-16 lg:top-auto lg:bottom-28 z-50 w-[264px] rounded-2xl bg-desk-surface border border-desk-border p-3.5 shadow-2xl space-y-3 select-none">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-widest text-desk-muted">
            {t('colorWheelTitle')}
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-desk-text">{color.toUpperCase()}</span>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-desk-panel text-desk-muted hover:text-desk-text"
              aria-label={t('radialClose')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Interactive HSL Hue Wheel */}
        <div className="flex justify-center">
          <canvas
            ref={wheelRef}
            onPointerDown={(e) => {
              safeSetPointerCapture(e.currentTarget, e.pointerId);
              draggingRef.current = true;
              pickHueFromPointer(e);
            }}
            onPointerMove={(e) => {
              if (draggingRef.current) pickHueFromPointer(e);
            }}
            onPointerUp={() => {
              draggingRef.current = false;
            }}
            className="w-[152px] h-[152px] cursor-crosshair touch-none"
          />
        </div>

        {/* Saturation & Lightness Sliders */}
        <div className="space-y-2">
          <div>
            <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
              <span>{t('colorWheelHint').split('·')[0].trim()} / S</span>
              <span>{hsl.s}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={hsl.s}
              onChange={(e) => onChange(hslToHex(hsl.h, Number(e.target.value), hsl.l))}
              className="studio-fader w-full"
            />
          </div>
          <div>
            <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
              <span>{t('colorHighlight').toUpperCase()} / L</span>
              <span>{hsl.l}%</span>
            </div>
            <input
              type="range"
              min={4}
              max={98}
              value={hsl.l}
              onChange={(e) => onChange(hslToHex(hsl.h, hsl.s, Number(e.target.value)))}
              className="studio-fader w-full"
            />
          </div>
        </div>

        {/* Cel-Shading Companion Tone Helper (Shadow / Base / Highlight) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between font-mono text-[11px] text-desk-muted">
            <span className="uppercase">{t('colorHarmonyLabel')}</span>
            <button
              type="button"
              onClick={onAddPalette}
              className="text-ink-vermilion hover:underline"
            >
              + {t('colorSavePalette')}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => onChange(shadowHex)}
              style={{
                backgroundColor: shadowHex,
                color: getContrastTextColor(shadowHex),
              }}
              className="h-7 rounded-lg border border-desk-border text-[11px] font-mono font-bold shadow-inner"
              title={`${t('colorShadow')}: ${shadowHex}`}
            >
              {t('colorShadow')}
            </button>
            <div
              style={{
                backgroundColor: color,
                color: getContrastTextColor(color),
              }}
              className="h-7 rounded-lg border-2 border-ink-brass flex items-center justify-center text-[11px] font-mono font-bold"
            >
              {t('colorBase')}
            </div>
            <button
              type="button"
              onClick={() => onChange(highlightHex)}
              style={{
                backgroundColor: highlightHex,
                color: getContrastTextColor(highlightHex),
              }}
              className="h-7 rounded-lg border border-desk-border text-[11px] font-mono font-bold shadow-inner"
              title={`${t('colorHighlight')}: ${highlightHex}`}
            >
              {t('colorHighlight')}
            </button>
          </div>
        </div>

        {/* Recent 8 Colors */}
        {recentColors.length > 0 && (
          <div className="space-y-1">
            <div className="font-mono text-[11px] uppercase text-desk-muted">{t('colorRecentLabel')}</div>
            <div className="grid grid-cols-8 gap-1">
              {recentColors.slice(0, 8).map((hex) => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => onChange(hex)}
                  style={{ backgroundColor: hex }}
                  className="h-5 rounded border border-desk-border hover:scale-110 transition-transform"
                  title={hex}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
