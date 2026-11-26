import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Pause, Play, Sparkles, X } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { useT } from '../../i18n/translations';
import type { StudioMode } from '../../types/studio';
import { soundEngine } from '../../engine/soundEngine';
import { KeycapButton } from '../ui/KeycapButton';

const SCENE_DURATION = 2.6;
const TOTAL_SCENES = 4;
const TOTAL_SEC = SCENE_DURATION * TOTAL_SCENES;

/** Draws Scene 1: Backlit Glass Desk -> Ink pen sketches hero -> Hero blinks & bounces alive! */
function drawScene1Desk(ctx: CanvasRenderingContext2D, w: number, h: number, u: number) {
  ctx.fillStyle = '#F7F3E9';
  ctx.fillRect(0, 0, w, h);

  // Subtle top lightbox pegbar holes
  ctx.fillStyle = '#D9D0BD';
  ctx.beginPath();
  ctx.roundRect(w / 2 - 42, 8, 84, 14, 7);
  ctx.fill();
  ctx.fillStyle = '#575046';
  ctx.beginPath();
  ctx.arc(w / 2 - 22, 15, 3, 0, Math.PI * 2);
  ctx.arc(w / 2 + 22, 15, 3, 0, Math.PI * 2);
  ctx.fill();

  const drawPhase = Math.min(1, u / 0.55);
  const alivePhase = Math.max(0, (u - 0.55) / 0.45);
  const bounceY = alivePhase > 0 ? -Math.abs(Math.sin(alivePhase * Math.PI * 3)) * 22 : 0;
  const cx = w * 0.5;
  const cy = h * 0.55 + bounceY;

  // Ground shadow
  ctx.fillStyle = 'rgba(28,25,23,0.12)';
  ctx.beginPath();
  ctx.ellipse(cx, h * 0.78, 42 - Math.abs(bounceY) * 0.4, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Progressive stroke drawing
  if (drawPhase > 0.05) {
    // Head circle
    const headAng = Math.min(1, drawPhase / 0.35) * Math.PI * 2;
    ctx.fillStyle = alivePhase > 0.1 ? '#FAF3E4' : 'transparent';
    ctx.beginPath();
    ctx.arc(cx, cy - 46, 26, -Math.PI / 2, -Math.PI / 2 + headAng);
    if (alivePhase > 0.1) ctx.fill();
    ctx.stroke();
  }
  if (drawPhase > 0.35) {
    // Body + Scarf
    const bodyT = Math.min(1, (drawPhase - 0.35) / 0.3);
    ctx.beginPath();
    ctx.moveTo(cx, cy - 20);
    ctx.lineTo(cx, cy - 20 + 54 * bodyT);
    ctx.stroke();
    if (bodyT > 0.5) {
      ctx.strokeStyle = '#E54D2E';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(cx - 14, cy - 16);
      ctx.quadraticCurveTo(cx + 8, cy - 10, cx + 22 + Math.sin(u * 14) * 5, cy - 2);
      ctx.stroke();
      ctx.strokeStyle = '#1C1917';
      ctx.lineWidth = 4.5;
    }
  }
  if (drawPhase > 0.65) {
    // Arms & Legs waving joyfully
    const armLift = alivePhase > 0 ? Math.sin(alivePhase * Math.PI * 4) * 16 : 0;
    ctx.beginPath();
    ctx.moveTo(cx - 28, cy - 2 - armLift);
    ctx.lineTo(cx, cy - 8);
    ctx.lineTo(cx + 28, cy - 2 + armLift);
    ctx.moveTo(cx - 18, cy + 62);
    ctx.lineTo(cx, cy + 34);
    ctx.lineTo(cx + 18, cy + 62);
    ctx.stroke();
  }

  // Eyes & smile pop in alive!
  if (alivePhase > 0) {
    ctx.fillStyle = '#1C1917';
    ctx.beginPath();
    ctx.arc(cx - 8, cy - 50, 3.2, 0, Math.PI * 2);
    ctx.arc(cx + 8, cy - 50, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy - 43, 8, 0.2, Math.PI - 0.2);
    ctx.stroke();

    // Spark burst around newly alive character!
    ctx.strokeStyle = '#D99B26';
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + alivePhase * 0.5;
      const r1 = 56 + alivePhase * 12;
      const r2 = 68 + alivePhase * 16;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r1, cy - 20 + Math.sin(ang) * r1);
      ctx.lineTo(cx + Math.cos(ang) * r2, cy - 20 + Math.sin(ang) * r2);
      ctx.stroke();
    }
  } else {
    // Animated ink pencil nib drawing live
    const px = cx + Math.cos(drawPhase * Math.PI * 4) * 26;
    const py = cy - 46 + drawPhase * 70;
    ctx.translate(px, py);
    ctx.rotate(-0.65);
    ctx.fillStyle = '#D99B26';
    ctx.fillRect(0, -5, 42, 10);
    ctx.fillStyle = '#1C1917';
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(0, -5);
    ctx.lineTo(0, 5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Draws Scene 2: Frame-by-Frame Onion Skin Bouncing Ball Arc */
function drawScene2Draw(ctx: CanvasRenderingContext2D, w: number, h: number, u: number) {
  ctx.fillStyle = '#F7F3E9';
  ctx.fillRect(0, 0, w, h);

  // Subtle drafting grid
  ctx.strokeStyle = 'rgba(130, 115, 92, 0.14)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Floor line
  const floorY = h * 0.78;
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(w * 0.1, floorY);
  ctx.lineTo(w * 0.9, floorY);
  ctx.stroke();

  // Dashed guide arc
  ctx.strokeStyle = 'rgba(217,155,38,0.45)';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(w * 0.16, floorY - 24);
  ctx.quadraticCurveTo(w * 0.5, h * 0.08, w * 0.84, floorY - 24);
  ctx.stroke();
  ctx.setLineDash([]);

  const drawBallAt = (tVal: number, color: string, alpha: number) => {
    const c = Math.max(0, Math.min(1, tVal));
    const bx = w * (0.16 + c * 0.68);
    const arc = 4 * c * (1 - c);
    const by = floorY - 24 - arc * (h * 0.48);
    const nearFloor = arc < 0.14;
    const sx = nearFloor ? 1.24 : 0.92;
    const sy = nearFloor ? 0.78 : 1.09;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(bx, by);
    ctx.scale(sx, sy);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#1C1917';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  // Previous (Red) & Next (Blue) Onion Skin ghost traces!
  drawBallAt(u - 0.16, 'rgba(229, 77, 46, 0.35)', 0.45);
  drawBallAt(u - 0.08, 'rgba(229, 77, 46, 0.5)', 0.6);
  drawBallAt(u + 0.08, 'rgba(37, 99, 235, 0.4)', 0.45);
  // Active crisp ink ball
  drawBallAt(u, '#E54D2E', 1);
}

/** Draws Scene 3: Live Flex Puppet Pins Bending & Talking! */
function drawScene3Puppet(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  locale: 'tr' | 'en'
) {
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#182234');
  bg.addColorStop(1, '#0F172A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Warm stage spotlight
  const spot = ctx.createRadialGradient(w * 0.5, h * 0.5, 16, w * 0.5, h * 0.5, w * 0.36);
  spot.addColorStop(0, 'rgba(217, 155, 38, 0.25)');
  spot.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, w, h);

  const sway = Math.sin(u * Math.PI * 4) * 28;
  const cx = w * 0.48;
  const hipY = h * 0.62;
  const headX = cx + sway * 0.8;
  const headY = h * 0.33 - Math.abs(sway) * 0.15;
  const handRX = cx + 68 + sway * 0.7;
  const handRY = h * 0.44 - Math.sin(u * Math.PI * 4) * 26;
  const handLX = cx - 64 + sway * 0.4;
  const handLY = h * 0.5;

  // Body & limbs curving like rubber
  ctx.save();
  ctx.strokeStyle = '#1C1917';
  ctx.fillStyle = '#2B2622';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - 24, hipY + 34);
  ctx.quadraticCurveTo(cx + sway * 0.3, hipY - 12, headX - 18, headY + 28);
  ctx.lineTo(headX + 18, headY + 28);
  ctx.quadraticCurveTo(cx + 26 + sway * 0.3, hipY - 12, cx + 24, hipY + 34);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Arms
  ctx.strokeStyle = '#FAF3E4';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(headX - 14, headY + 36);
  ctx.quadraticCurveTo(cx - 42, hipY - 22, handLX, handLY);
  ctx.moveTo(headX + 14, headY + 36);
  ctx.quadraticCurveTo(cx + 42, hipY - 26, handRX, handRY);
  ctx.stroke();

  // Scarf
  ctx.fillStyle = '#E54D2E';
  ctx.beginPath();
  ctx.roundRect(headX - 24, headY + 22, 48, 12, 6);
  ctx.fill();

  // Head + Beret
  ctx.fillStyle = '#FAF3E4';
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(headX, headY, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#D99B26';
  ctx.beginPath();
  ctx.ellipse(headX - 2, headY - 24, 32, 10, -0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Talking mouth animating open/closed
  const mouthOpen = Math.abs(Math.sin(u * Math.PI * 10));
  ctx.fillStyle = '#1C1917';
  ctx.beginPath();
  ctx.arc(headX - 9, headY - 4, 3.2, 0, Math.PI * 2);
  ctx.arc(headX + 9, headY - 4, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#B83324';
  ctx.beginPath();
  ctx.ellipse(headX, headY + 10, 9, 3 + mouthOpen * 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Dashed gold pin skeleton + glowing control pins
  ctx.strokeStyle = 'rgba(217,155,38,0.6)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 2;
  for (const [px, py] of [
    [headX, headY],
    [handLX, handLY],
    [handRX, handRY],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx, hipY);
    ctx.lineTo(px, py);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const [px, py, col] of [
    [cx, hipY, '#D99B26'],
    [headX, headY, '#2563EB'],
    [handLX, handLY, '#2563EB'],
    [handRX, handRY, '#E54D2E'],
  ] as const) {
    ctx.fillStyle = col;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Playful speech bubble
  ctx.fillStyle = '#FAF6EE';
  ctx.strokeStyle = '#D99B26';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(headX + 38, headY - 40, 108, 34, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#1C1917';
  ctx.font = 'bold 14px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(locale === 'en' ? 'Hello!' : 'Merhaba!', headX + 92, headY - 18);
  ctx.restore();
}

/** Draws Scene 4: Mini Film — Rainy Evening Street, Lantern Glow, Lightning & KÂĞIT Seal! */
function drawScene4Film(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  locale: 'tr' | 'en'
) {
  const flash = u > 0.56 && u < 0.68 ? 1 - Math.abs(u - 0.62) / 0.06 : 0;

  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, flash > 0.2 ? '#4C668E' : '#12192A');
  sky.addColorStop(0.65, '#1F2C44');
  sky.addColorStop(1, '#12151C');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Parallax buildings moving smoothly
  const pan = -u * 48;
  ctx.fillStyle = '#182133';
  for (let i = 0; i < 7; i++) {
    ctx.fillRect(i * 105 + pan, h * 0.25 + (i % 3) * 26, 86, h * 0.5);
  }

  // Wet street floor
  ctx.fillStyle = '#171C26';
  ctx.fillRect(0, h * 0.68, w, h * 0.32);

  // Warm vintage streetlamp + volumetric cone
  const lampX = w * 0.66 + pan * 0.6;
  const glow = ctx.createRadialGradient(lampX, h * 0.34, 6, lampX, h * 0.44, 150);
  glow.addColorStop(0, 'rgba(255, 212, 118, 0.85)');
  glow.addColorStop(0.4, 'rgba(255, 192, 92, 0.22)');
  glow.addColorStop(1, 'rgba(255, 192, 92, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(lampX, h * 0.44, 150, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#0D1017';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(lampX, h * 0.72);
  ctx.lineTo(lampX, h * 0.34);
  ctx.stroke();

  // Walking silhouette hero with glowing lantern
  const hx = w * (0.24 + u * 0.38);
  const hy = h * 0.68 - Math.abs(Math.sin(u * Math.PI * 6)) * 5;
  ctx.fillStyle = '#1C1917';
  ctx.beginPath();
  ctx.arc(hx, hy - 54, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(hx - 11, hy - 40, 22, 34);
  // Beret + glowing scarf
  ctx.fillStyle = '#D99B26';
  ctx.beginPath();
  ctx.ellipse(hx, hy - 68, 17, 5, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#E54D2E';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hx - 6, hy - 38);
  ctx.quadraticCurveTo(hx - 24, hy - 34 + Math.sin(u * 20) * 6, hx - 36, hy - 26);
  ctx.stroke();

  // Rain streaks
  ctx.strokeStyle = 'rgba(200, 224, 255, 0.38)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 36; i++) {
    const rx = ((i * 47 + u * 160) % (w + 40)) - 20;
    const ry = ((i * 71 + u * 420) % h);
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx - 5, ry + 16);
    ctx.stroke();
  }

  // Cinema Letterbox Bars
  ctx.fillStyle = '#09090B';
  ctx.fillRect(0, 0, w, 24);
  ctx.fillRect(0, h - 24, w, 24);

  // Subtle subtitle at bottom
  ctx.fillStyle = '#FAF6EE';
  ctx.font = 'bold 13px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(locale === 'en' ? '“Found it!”' : '“Sonunda buldum!”', w / 2, h - 36);
}

export default function StudioOverviewShow() {
  const t = useT();
  const { overviewShowOpen, setOverviewShowOpen, startTour, mode, locale } = useStudioStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [playing, setPlaying] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const elapsedRef = useRef(0);

  const scenes = useMemo<
    { mode: StudioMode; title: string; desc: string }[]
  >(
    () => [
      { mode: 'desk', title: t('overviewScene1Title'), desc: t('overviewScene1Desc') },
      { mode: 'draw', title: t('overviewScene2Title'), desc: t('overviewScene2Desc') },
      { mode: 'puppet', title: t('overviewScene3Title'), desc: t('overviewScene3Desc') },
      { mode: 'film', title: t('overviewScene4Title'), desc: t('overviewScene4Desc') },
    ],
    [t]
  );

  useEffect(() => {
    if (!overviewShowOpen) return;
    setPlaying(true);
    elapsedRef.current = 0;
    setElapsedSec(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverviewShowOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overviewShowOpen, setOverviewShowOpen]);

  useEffect(() => {
    if (!overviewShowOpen) return;
    let raf = 0;
    let last = performance.now();
    let lastSync = last;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (playing) {
        elapsedRef.current = (elapsedRef.current + dt) % TOTAL_SEC;
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const sec = elapsedRef.current;
          const idx = Math.min(TOTAL_SCENES - 1, Math.floor(sec / SCENE_DURATION));
          const u = (sec - idx * SCENE_DURATION) / SCENE_DURATION;
          if (idx === 0) drawScene1Desk(ctx, canvas.width, canvas.height, u);
          else if (idx === 1) drawScene2Draw(ctx, canvas.width, canvas.height, u);
          else if (idx === 2) drawScene3Puppet(ctx, canvas.width, canvas.height, u, locale);
          else drawScene4Film(ctx, canvas.width, canvas.height, u, locale);
        }
      }

      if (now - lastSync > 80) {
        lastSync = now;
        setElapsedSec(elapsedRef.current);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [overviewShowOpen, playing, locale]);

  if (!overviewShowOpen) return null;

  const activeIdx = Math.min(TOTAL_SCENES - 1, Math.floor(elapsedSec / SCENE_DURATION));
  const activeScene = scenes[activeIdx];

  return (
    <div
      onClick={() => setOverviewShowOpen(false)}
      className="fixed inset-0 z-[75] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 select-none"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('overviewTitle')}
        onClick={(e) => e.stopPropagation()}
        className="toast-pop-in w-full max-w-2xl rounded-3xl bg-desk-surface border border-desk-border shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-desk-border flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-extrabold text-desk-text flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-ink-brass" />
              {t('overviewTitle')}
            </h2>
            <p className="text-[11px] text-desk-muted">{t('overviewSubtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => setOverviewShowOpen(false)}
            className="p-2 rounded-xl console-well border border-desk-border text-desk-muted hover:text-desk-text"
            aria-label={t('guideSkip')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Live 60 FPS 4-Scene Canvas2D Mini Movie */}
        <div className="p-4 space-y-3">
          <div className="relative aspect-video rounded-2xl overflow-hidden border-2 border-desk-border bg-neutral-950 shadow-xl">
            <canvas ref={canvasRef} width={640} height={360} className="w-full h-full block" />
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="absolute bottom-3 left-3 px-2.5 py-1 rounded-xl bg-black/70 text-white font-mono text-[10.5px] font-bold inline-flex items-center gap-1.5 hover:bg-black/85"
            >
              {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 fill-current" />}
              {playing ? t('overviewPause') : t('overviewPlay')}
            </button>
          </div>

          {/* 4 Clickable Scene Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {scenes.map((sc, idx) => {
              const isCur = idx === activeIdx;
              const pct = isCur
                ? Math.min(100, Math.round(((elapsedSec - idx * SCENE_DURATION) / SCENE_DURATION) * 100))
                : idx < activeIdx
                  ? 100
                  : 0;
              return (
                <button
                  key={sc.mode}
                  type="button"
                  onClick={() => {
                    soundEngine.click(1.06);
                    elapsedRef.current = idx * SCENE_DURATION + 0.02;
                    setElapsedSec(elapsedRef.current);
                  }}
                  className={`p-2 rounded-xl border text-left transition-all space-y-1.5 ${
                    isCur
                      ? 'bg-desk-panel border-ink-brass shadow-sm'
                      : 'console-well border-desk-border opacity-75 hover:opacity-100'
                  }`}
                >
                  <div className="text-[10.5px] font-extrabold text-desk-text truncate">
                    {sc.title}
                  </div>
                  <div className="h-1 rounded-full bg-black/30 overflow-hidden">
                    <div
                      className="h-full bg-ink-vermilion transition-all duration-75"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Active Scene Summary + Instant Jump / Learn Actions */}
          <div className="rounded-2xl console-well border border-desk-border p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-extrabold text-desk-text">{activeScene.title}</div>
              <p className="text-[11px] text-desk-muted leading-snug">{activeScene.desc}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  soundEngine.clapperSnap();
                  void startTour(mode);
                }}
                className="px-3 py-1.5 rounded-xl bg-desk-panel border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text"
              >
                {t('overviewLearnThis')}
              </button>
              <KeycapButton
                size="sm"
                variant="vermilion"
                onClick={() => {
                  soundEngine.clapperSnap();
                  void startTour(activeScene.mode);
                }}
              >
                {t('overviewOpenNow')}
                <ArrowRight className="w-3.5 h-3.5" />
              </KeycapButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
