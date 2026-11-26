import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Pause, Play, Sparkles, X } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { useT } from '../../i18n/translations';
import type { StudioMode } from '../../types/studio';
import { soundEngine } from '../../engine/soundEngine';
import { KeycapButton } from '../ui/KeycapButton';

const SCENE_DURATION = 2.6;
const TOTAL_SCENES = 4;
const TOTAL_SEC = SCENE_DURATION * TOTAL_SCENES;

/** Shared helper: draws our unified INKTROPE Atelier Fedora + Striped Paper Horns crest */
function drawAtelierHatAndHorns(ctx: CanvasRenderingContext2D, hx: number, hy: number, sc = 1) {
  ctx.save();
  ctx.translate(hx, hy);
  ctx.scale(sc, sc);
  ctx.fillStyle = '#1E1B18';
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, 31, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#26221E';
  ctx.beginPath();
  ctx.moveTo(-18, -1);
  ctx.lineTo(-14, -17);
  ctx.lineTo(-3, -12);
  ctx.lineTo(8, -18);
  ctx.lineTo(18, -1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Striped paper-ink horns
  ctx.fillStyle = '#FAF6EC';
  ctx.beginPath();
  ctx.moveTo(-14, -4);
  ctx.quadraticCurveTo(-24, -14, -19, -25);
  ctx.quadraticCurveTo(-12, -16, -8, -6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(14, -4);
  ctx.quadraticCurveTo(24, -14, 19, -25);
  ctx.quadraticCurveTo(12, -16, 8, -6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = '#D99B26';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(-16, -1.5);
  ctx.quadraticCurveTo(0, 1, 16, -1.5);
  ctx.stroke();
  ctx.restore();
}

/** Scene 1: Backlit Glass Desk -> Dip-nib sketches our Atelier Hero -> Springs alive! */
function drawScene1Desk(ctx: CanvasRenderingContext2D, w: number, h: number, u: number) {
  ctx.fillStyle = '#F7F3E9';
  ctx.fillRect(0, 0, w, h);

  // ACME pegbar header
  ctx.fillStyle = '#DDD4C3';
  ctx.beginPath();
  ctx.roundRect(w / 2 - 46, 8, 92, 14, 7);
  ctx.fill();
  ctx.fillStyle = '#2A2622';
  ctx.beginPath();
  ctx.arc(w / 2 - 24, 15, 3, 0, Math.PI * 2);
  ctx.roundRect(w / 2 - 9, 12.5, 18, 5, 2.5);
  ctx.arc(w / 2 + 24, 15, 3, 0, Math.PI * 2);
  ctx.fill();

  const drawPhase = Math.min(1, u / 0.55);
  const alivePhase = Math.max(0, (u - 0.55) / 0.45);
  const bounceY = alivePhase > 0 ? -Math.abs(Math.sin(alivePhase * Math.PI * 3)) * 18 : 0;
  const cx = w * 0.5;
  const floorY = h * 0.82;
  const hipY = floorY - 46 + bounceY;

  ctx.fillStyle = 'rgba(28,25,23,0.13)';
  ctx.beginPath();
  ctx.ellipse(cx, floorY + 4, 44 - Math.abs(bounceY) * 0.35, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 3.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Coat & grounded boots (editorial silhouette instead of stickman!)
  if (drawPhase > 0.28) {
    const coatAlpha = Math.min(1, (drawPhase - 0.28) / 0.32);
    ctx.save();
    ctx.globalAlpha = coatAlpha;
    ctx.fillStyle = alivePhase > 0.05 ? '#24201D' : 'rgba(36,32,29,0.12)';
    ctx.beginPath();
    ctx.moveTo(cx - 26, hipY - 52);
    ctx.lineTo(cx + 26, hipY - 52);
    ctx.lineTo(cx + 22, hipY + 8);
    ctx.lineTo(cx - 22, hipY + 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Articulated legs + solid boots
    ctx.lineWidth = 6.5;
    ctx.beginPath();
    ctx.moveTo(cx - 10, hipY + 8);
    ctx.lineTo(cx - 13, floorY - 4);
    ctx.moveTo(cx + 10, hipY + 8);
    ctx.lineTo(cx + 13, floorY - 4);
    ctx.stroke();

    ctx.fillStyle = '#1C1917';
    ctx.beginPath();
    ctx.ellipse(cx - 16, floorY - 2, 11, 5, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 16, floorY - 2, 11, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Waving arms + vermilion scarf
    const wave = alivePhase > 0 ? Math.sin(alivePhase * Math.PI * 4) * 15 : 0;
    ctx.lineWidth = 5.2;
    ctx.beginPath();
    ctx.moveTo(cx - 24, hipY - 44);
    ctx.quadraticCurveTo(cx - 42, hipY - 30, cx - 44, hipY - 18 - wave);
    ctx.moveTo(cx + 24, hipY - 44);
    ctx.quadraticCurveTo(cx + 42, hipY - 34, cx + 46, hipY - 28 + wave);
    ctx.stroke();

    ctx.strokeStyle = '#E54D2E';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(cx - 18, hipY - 52);
    ctx.quadraticCurveTo(cx + 8, hipY - 46, cx + 30 + Math.sin(u * 14) * 5, hipY - 36);
    ctx.stroke();
    ctx.restore();
  }

  // Head + Hat + Horns
  if (drawPhase > 0.05) {
    const headY = hipY - 76;
    ctx.fillStyle = alivePhase > 0.05 ? '#FAF6EC' : '#F7F3E9';
    ctx.strokeStyle = '#1C1917';
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.arc(cx, headY, 23, 0, Math.PI * 2 * Math.min(1, drawPhase / 0.35));
    ctx.fill();
    ctx.stroke();

    if (drawPhase > 0.45) {
      drawAtelierHatAndHorns(ctx, cx, headY - 20, 0.86);
    }

    if (alivePhase > 0) {
      ctx.fillStyle = '#1C1917';
      ctx.beginPath();
      ctx.ellipse(cx - 7.5, headY - 2, 2.6, 3.8, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 7.5, headY - 2, 2.6, 3.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(cx, headY + 5, 7.5, 0.18, Math.PI - 0.18);
      ctx.stroke();
    }
  }

  if (alivePhase <= 0) {
    // Calligraphic G-Pen fountain nib sketching along path
    const px = cx + Math.cos(drawPhase * Math.PI * 3.2) * 32;
    const py = hipY - 82 + drawPhase * 76;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-0.62);
    ctx.fillStyle = '#1C1917';
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(0, -5);
    ctx.lineTo(6, 0);
    ctx.lineTo(0, 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#D99B26';
    ctx.fillRect(4, -4.5, 36, 9);
    ctx.restore();
  }
  ctx.restore();
}

/** Scene 2: Frame-by-Frame Onion Skin Bouncing Ball with Smooth Continuous Squash & Stretch */
function drawScene2Draw(ctx: CanvasRenderingContext2D, w: number, h: number, u: number) {
  ctx.fillStyle = '#F7F3E9';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(130, 115, 92, 0.13)';
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

  const floorY = h * 0.78;
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(w * 0.1, floorY);
  ctx.lineTo(w * 0.9, floorY);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(217,155,38,0.5)';
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
    const by = floorY - 22 - arc * (h * 0.48);
    // Smooth continuous squash/stretch curve (zero binary threshold snap!)
    const contact = Math.pow(Math.max(0, 1 - arc / 0.32), 2.2);
    const sx = 0.92 + contact * 0.34;
    const sy = 1.08 - contact * 0.3;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(bx, by);
    ctx.scale(sx, sy);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#1C1917';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.arc(0, 0, 23, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  drawBallAt(u - 0.16, 'rgba(229, 77, 46, 0.35)', 0.45);
  drawBallAt(u - 0.08, 'rgba(229, 77, 46, 0.5)', 0.6);
  drawBallAt(u + 0.08, 'rgba(37, 99, 235, 0.4)', 0.45);
  drawBallAt(u, '#E54D2E', 1);
}

/** Scene 3: Articulated Full-Body Puppet (Grounded Legs, Crown Pin Above Hat, Tailed Speech Bubble!) */
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

  const spot = ctx.createRadialGradient(w * 0.48, h * 0.5, 16, w * 0.48, h * 0.5, w * 0.4);
  spot.addColorStop(0, 'rgba(217, 155, 38, 0.24)');
  spot.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, w, h);

  const sway = Math.sin(u * Math.PI * 4) * 24;
  const cx = w * 0.46;
  const floorY = h * 0.86;
  const hipY = h * 0.58;
  const headX = cx + sway * 0.75;
  const headY = h * 0.31 - Math.abs(sway) * 0.12;
  const headCrownPinY = headY - 34; // Cleanly above forehead/hat brim — NEVER on the nose!
  const handRX = cx + 66 + sway * 0.65;
  const handRY = h * 0.41 - Math.sin(u * Math.PI * 4) * 24;
  const handLX = cx - 62 + sway * 0.35;
  const handLY = h * 0.48;
  const footLX = cx - 18;
  const footRX = cx + 20;

  ctx.save();
  // Ground shadow
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.ellipse(cx, floorY + 4, 48, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Articulated legs + grounded sumi-ink boots
  ctx.strokeStyle = '#141210';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 12, hipY + 20);
  ctx.quadraticCurveTo(cx - 18 + sway * 0.15, (hipY + floorY) * 0.5, footLX, floorY - 4);
  ctx.moveTo(cx + 12, hipY + 20);
  ctx.quadraticCurveTo(cx + 18 + sway * 0.15, (hipY + floorY) * 0.5, footRX, floorY - 4);
  ctx.stroke();

  ctx.fillStyle = '#141210';
  ctx.beginPath();
  ctx.ellipse(footLX - 3, floorY - 2, 13, 5.5, 0, 0, Math.PI * 2);
  ctx.ellipse(footRX + 3, floorY - 2, 13, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tailored torso coat
  ctx.strokeStyle = '#1C1917';
  ctx.fillStyle = '#2B2622';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(cx - 23, hipY + 24);
  ctx.quadraticCurveTo(cx + sway * 0.28, hipY - 14, headX - 18, headY + 26);
  ctx.lineTo(headX + 18, headY + 26);
  ctx.quadraticCurveTo(cx + 25 + sway * 0.28, hipY - 14, cx + 23, hipY + 24);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Arms + warm ivory hands
  ctx.strokeStyle = '#2B2622';
  ctx.lineWidth = 8.5;
  ctx.beginPath();
  ctx.moveTo(headX - 16, headY + 34);
  ctx.quadraticCurveTo(cx - 42, hipY - 22, handLX, handLY);
  ctx.moveTo(headX + 16, headY + 34);
  ctx.quadraticCurveTo(cx + 42, hipY - 26, handRX, handRY);
  ctx.stroke();

  ctx.fillStyle = '#FAF6EC';
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(handLX, handLY, 5.5, 0, Math.PI * 2);
  ctx.arc(handRX, handRY, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Vermilion scarf
  ctx.fillStyle = '#E54D2E';
  ctx.beginPath();
  ctx.roundRect(headX - 22, headY + 21, 44, 10, 5);
  ctx.fill();
  ctx.stroke();

  // Head + Unified Atelier Hat & Horns
  ctx.fillStyle = '#FAF6EC';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.arc(headX, headY, 25, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  drawAtelierHatAndHorns(ctx, headX, headY - 21, 0.9);

  // Expressive eyes & lip-sync mouth
  const mouthOpen = Math.abs(Math.sin(u * Math.PI * 10));
  ctx.fillStyle = '#1C1917';
  ctx.beginPath();
  ctx.arc(headX - 8.5, headY - 3, 3, 0, Math.PI * 2);
  ctx.arc(headX + 8.5, headY - 3, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#C43418';
  ctx.beginPath();
  ctx.ellipse(headX, headY + 9.5, 8, 2.5 + mouthOpen * 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Rig bone links + Clean Anatomical Control Pins (Crown, Pelvis, Hands, Feet)
  ctx.strokeStyle = 'rgba(217,155,38,0.58)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.8;
  for (const [px, py] of [
    [headX, headCrownPinY],
    [handLX, handLY],
    [handRX, handRY],
    [footLX, floorY - 4],
    [footRX, floorY - 4],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx, hipY);
    ctx.lineTo(px, py);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const [px, py, col] of [
    [cx, hipY, '#D99B26'],
    [headX, headCrownPinY, '#2563EB'],
    [handLX, handLY, '#2563EB'],
    [handRX, handRY, '#E54D2E'],
    [footLX, floorY - 4, '#16A34A'],
    [footRX, floorY - 4, '#16A34A'],
  ] as const) {
    ctx.fillStyle = col;
    ctx.strokeStyle = '#FFFDF8';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(px, py, 6.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Tailed Speech Bubble pointing cleanly toward the character's mouth!
  const bx = headX + 42;
  const by = headY - 26;
  const bw = 112;
  const bh = 34;
  ctx.fillStyle = '#FAF6EE';
  ctx.strokeStyle = '#D99B26';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(bx + 12, by);
  ctx.lineTo(bx + bw - 12, by);
  ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + 12);
  ctx.lineTo(bx + bw, by + bh - 12);
  ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - 12, by + bh);
  ctx.lineTo(bx + 16, by + bh);
  ctx.lineTo(headX + 24, headY + 10);
  ctx.lineTo(bx + 4, by + bh - 10);
  ctx.quadraticCurveTo(bx, by + bh - 12, bx, by + bh - 16);
  ctx.lineTo(bx, by + 12);
  ctx.quadraticCurveTo(bx, by, bx + 12, by);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#1C1917';
  ctx.font = 'bold 14px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(locale === 'en' ? 'Hello!' : 'Merhaba!', bx + bw * 0.5, by + 22);
  ctx.restore();
}

/** Scene 4: 2.5D Mini Film — Layered European Rooftops, Warm Arched Windows & Walking Hero */
function drawScene4Film(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  locale: 'tr' | 'en'
) {
  const flash = u > 0.56 && u < 0.68 ? 1 - Math.abs(u - 0.62) / 0.06 : 0;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, flash > 0.2 ? '#3C547A' : '#0E1525');
  sky.addColorStop(0.65, '#1B273E');
  sky.addColorStop(1, '#10141C');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const horizonY = h * 0.68;
  const pan = -u * 52;
  for (let i = 0; i < 7; i++) {
    const bx = i * 108 + pan;
    const bw = 92;
    const topY = h * 0.24 + (i % 3) * 22;
    ctx.fillStyle = i % 2 === 0 ? '#162033' : '#1C2840';
    ctx.fillRect(bx, topY + 18, bw, horizonY - topY - 18);

    ctx.fillStyle = '#0D1320';
    ctx.beginPath();
    ctx.moveTo(bx - 5, topY + 20);
    ctx.lineTo(bx + bw * 0.5, topY);
    ctx.lineTo(bx + bw + 5, topY + 20);
    ctx.closePath();
    ctx.fill();

    // Warm arched story windows
    for (let wi = 0; wi < 2; wi++) {
      const wx = bx + 18 + wi * 38;
      const wy = topY + 34;
      ctx.fillStyle = (i + wi) % 3 === 0 ? 'rgba(42,58,86,0.7)' : 'rgba(248, 202, 112, 0.82)';
      ctx.beginPath();
      ctx.roundRect(wx, wy, 16, 24, [8, 8, 2, 2]);
      ctx.fill();
    }
  }

  ctx.fillStyle = '#141923';
  ctx.fillRect(0, horizonY, w, h - horizonY);

  const lampX = w * 0.68 + pan * 0.6;
  const glow = ctx.createRadialGradient(lampX, h * 0.32, 6, lampX, h * 0.44, 155);
  glow.addColorStop(0, 'rgba(255, 214, 122, 0.85)');
  glow.addColorStop(0.4, 'rgba(255, 192, 92, 0.22)');
  glow.addColorStop(1, 'rgba(255, 192, 92, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(lampX, h * 0.44, 155, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#0B0E15';
  ctx.lineWidth = 5.5;
  ctx.beginPath();
  ctx.moveTo(lampX, horizonY + 16);
  ctx.lineTo(lampX, h * 0.32);
  ctx.stroke();

  // Articulated walking hero with stride legs & flowing vermilion scarf
  const hx = w * (0.24 + u * 0.38);
  const stride = Math.sin(u * Math.PI * 8);
  const hy = horizonY + 6 - Math.abs(stride) * 4;

  ctx.strokeStyle = '#141210';
  ctx.lineWidth = 5.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hx - 4, hy - 22);
  ctx.lineTo(hx - 4 + stride * 11, hy);
  ctx.moveTo(hx + 4, hy - 22);
  ctx.lineTo(hx + 4 - stride * 11, hy);
  ctx.stroke();

  ctx.fillStyle = '#1C1917';
  ctx.beginPath();
  ctx.moveTo(hx - 13, hy - 50);
  ctx.lineTo(hx + 13, hy - 50);
  ctx.lineTo(hx + 11, hy - 20);
  ctx.lineTo(hx - 11, hy - 20);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.arc(hx, hy - 62, 12, 0, Math.PI * 2);
  ctx.fill();
  drawAtelierHatAndHorns(ctx, hx, hy - 73, 0.48);

  ctx.strokeStyle = '#E54D2E';
  ctx.lineWidth = 4.8;
  ctx.beginPath();
  ctx.moveTo(hx - 4, hy - 49);
  ctx.quadraticCurveTo(hx - 22, hy - 44 + Math.sin(u * 20) * 5, hx - 34, hy - 37);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(200, 224, 255, 0.36)';
  ctx.lineWidth = 1.3;
  for (let i = 0; i < 32; i++) {
    const rx = ((i * 47 + u * 160) % (w + 40)) - 20;
    const ry = (i * 71 + u * 420) % h;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx - 5, ry + 15);
    ctx.stroke();
  }

  ctx.fillStyle = '#09090B';
  ctx.fillRect(0, 0, w, 24);
  ctx.fillRect(0, h - 24, w, 24);

  ctx.fillStyle = '#FAF6EE';
  ctx.font = 'bold 13px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(locale === 'en' ? '“Found it!”' : '“Sonunda buldum!”', w / 2, h - 34);
}

export default function StudioOverviewShow() {
  const t = useT();
  const { overviewShowOpen, setOverviewShowOpen, startTour, mode, locale } = useStudioStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [playing, setPlaying] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const elapsedRef = useRef(0);

  const scenes = useMemo<{ mode: StudioMode; title: string; desc: string }[]>(
    () => [
      { mode: 'desk', title: t('overviewScene1Title'), desc: t('overviewScene1Desc') },
      { mode: 'draw', title: t('overviewScene2Title'), desc: t('overviewScene2Desc') },
      { mode: 'puppet', title: t('overviewScene3Title'), desc: t('overviewScene3Desc') },
      { mode: 'film', title: t('overviewScene4Title'), desc: t('overviewScene4Desc') },
    ],
    [t]
  );

  const renderAt = useCallback(
    (sec: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const idx = Math.min(TOTAL_SCENES - 1, Math.floor(sec / SCENE_DURATION));
      const u = (sec - idx * SCENE_DURATION) / SCENE_DURATION;
      if (idx === 0) drawScene1Desk(ctx, canvas.width, canvas.height, u);
      else if (idx === 1) drawScene2Draw(ctx, canvas.width, canvas.height, u);
      else if (idx === 2) drawScene3Puppet(ctx, canvas.width, canvas.height, u, locale);
      else drawScene4Film(ctx, canvas.width, canvas.height, u, locale);
    },
    [locale]
  );

  useEffect(() => {
    if (!overviewShowOpen) return;
    const reduced = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    setPlaying(!reduced);
    elapsedRef.current = 0;
    setElapsedSec(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverviewShowOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overviewShowOpen, setOverviewShowOpen]);

  // Zero-Leak Playback Loop: Halts to EXACTLY 0 RAF/s when paused or prefers-reduced-motion!
  useEffect(() => {
    if (!overviewShowOpen) return;
    const reduced = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    renderAt(elapsedRef.current);
    if (!playing || reduced) return;

    let raf = 0;
    let last = performance.now();
    let lastSync = last;

    const tick = (now: number) => {
      if (document.hidden) {
        last = now;
        raf = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      elapsedRef.current = (elapsedRef.current + dt) % TOTAL_SEC;
      renderAt(elapsedRef.current);

      if (now - lastSync >= 95) {
        lastSync = now;
        setElapsedSec(elapsedRef.current);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [overviewShowOpen, playing, renderAt]);

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

        {/* 4-Scene Canvas2D Showcase */}
        <div className="p-4 space-y-3">
          <div className="relative aspect-video rounded-2xl overflow-hidden border-2 border-desk-border bg-neutral-950 shadow-xl">
            <canvas ref={canvasRef} width={640} height={360} className="w-full h-full block" />
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="absolute bottom-3 left-3 px-2.5 py-1 rounded-xl bg-black/75 text-white font-mono text-[11px] font-bold inline-flex items-center gap-1.5 hover:bg-black/90"
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
                    elapsedRef.current = idx * SCENE_DURATION + 0.05;
                    setElapsedSec(elapsedRef.current);
                    renderAt(elapsedRef.current);
                  }}
                  className={`p-2 rounded-xl border text-left transition-all space-y-1.5 ${
                    isCur
                      ? 'bg-desk-panel border-ink-brass shadow-sm'
                      : 'console-well border-desk-border opacity-80 hover:opacity-100'
                  }`}
                >
                  <div className="text-[11px] font-extrabold text-desk-text truncate">
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

          {/* Active Scene Summary + Matched Twin 3D Keycap Actions (Zero Baseline Mismatch!) */}
          <div className="rounded-2xl console-well border border-desk-border p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-extrabold text-desk-text">{activeScene.title}</div>
              <p className="text-[11px] text-desk-muted leading-snug">{activeScene.desc}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <KeycapButton
                size="sm"
                variant="graphite"
                onClick={() => {
                  soundEngine.clapperSnap();
                  void startTour(mode);
                }}
              >
                {t('overviewLearnThis')}
              </KeycapButton>
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
