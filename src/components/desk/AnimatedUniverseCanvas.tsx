import { useEffect, useRef } from 'react';
import type { StudioTheme } from '../../types/studio';
import { useStudioStore } from '../../store/useStudioStore';
import { getLiveDeviceProfile, subscribeDeviceTierChanges } from '../../engine/deviceTierEngine';

export type UniverseHoverTarget = 'draw' | 'paper' | 'puppet' | 'film' | null;

interface AnimatedUniverseCanvasProps {
  theme: StudioTheme;
  hoveredTarget: UniverseHoverTarget;
  active?: boolean;
}

interface SketchStar {
  nx: number;
  ny: number;
  size: number;
  kind: 'cross' | 'dot' | 'spark';
  phase: number;
  depth: number;
  warm: boolean;
}

interface OrigamiFlyer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  scale: number;
  kind: 'bird' | 'plane';
  wingPhase: number;
  trail: { x: number; y: number }[];
}

interface SketchCloud {
  nx: number;
  ny: number;
  scale: number;
  speed: number;
  seed: number;
}

/** Deterministic pseudo-random helper so cosmos composition is balanced & artisanal */
function seeded(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Builds balanced peripheral stars (denser around edges, calmer behind the lightbox center) */
function createSketchStars(): SketchStar[] {
  const stars: SketchStar[] = [];
  for (let i = 0; i < 42; i++) {
    let nx = seeded(i * 3 + 1);
    let ny = seeded(i * 3 + 2);
    // Push dense center stars outward so the workspace stays calm & readable
    if (nx > 0.16 && nx < 0.84 && ny > 0.22 && ny < 0.82 && i % 3 !== 0) {
      if (ny < 0.5) ny = ny * 0.32;
      else ny = 0.82 + (ny - 0.5) * 0.34;
    }
    const r = seeded(i * 7 + 5);
    stars.push({
      nx,
      ny,
      size: 2.2 + seeded(i * 5 + 3) * 4.4,
      kind: r > 0.68 ? 'cross' : r > 0.34 ? 'dot' : 'spark',
      phase: Math.floor(seeded(i * 11) * 12),
      depth: 0.4 + seeded(i * 13) * 1.1,
      warm: seeded(i * 17) > 0.52,
    });
  }
  return stars;
}

function createInitialClouds(): SketchCloud[] {
  return [
    { nx: 0.11, ny: 0.16, scale: 1.05, speed: 0.00055, seed: 1 },
    { nx: 0.46, ny: 0.12, scale: 0.88, speed: 0.00042, seed: 2 },
    { nx: 0.81, ny: 0.18, scale: 1.12, speed: 0.0005, seed: 3 },
    { nx: 0.26, ny: 0.84, scale: 0.78, speed: 0.00038, seed: 4 },
    { nx: 0.76, ny: 0.86, scale: 0.92, speed: 0.00046, seed: 5 },
  ];
}

function spawnOrigami(w: number, h: number, index: number, fromLightbox = false): OrigamiFlyer {
  const isPlane = index % 2 === 1;
  const startX = fromLightbox ? w * (0.28 + seeded(index * 19) * 0.25) : -30 - seeded(index * 7) * w * 0.4;
  const startY = fromLightbox ? h * (0.32 + seeded(index * 23) * 0.22) : h * (0.14 + seeded(index * 29) * 0.68);
  const speed = isPlane ? 2.8 + seeded(index * 31) * 1.6 : 1.7 + seeded(index * 37) * 1.2;
  return {
    x: startX,
    y: startY,
    vx: speed,
    vy: -(0.35 + seeded(index * 41) * 0.55),
    scale: 0.78 + seeded(index * 43) * 0.42,
    kind: isPlane ? 'plane' : 'bird',
    wingPhase: index * 1.7,
    trail: [],
  };
}

/**
 * 12 FPS ("on twos") Hand-Drawn Ink & Paper Universe Canvas
 * - Night: Ink & Paper Cosmos (Non-Photo Blue compass orbits, paper crescent moon, ringed planet,
 *   Line-Boil ink stars, flapping origami birds & paper planes, cursor parallax constellations).
 * - Day: Sunlit Sky Sketchbook (warm window sunbeams, hand-inked drifting clouds, soaring origami).
 * - Zero CPU when inactive (`active={false}` or `document.hidden`).
 */
export function AnimatedUniverseCanvas({
  theme,
  hoveredTarget,
  active = true,
}: AnimatedUniverseCanvasProps) {
  const performancePref = useStudioStore((s) => s.performancePref);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeRef = useRef<StudioTheme>(theme);
  const hoverRef = useRef<UniverseHoverTarget>(hoveredTarget);
  const prevHoverRef = useRef<UniverseHoverTarget>(null);
  const pointerRef = useRef({ tx: 0.5, ty: 0.35, x: 0.5, y: 0.35, hasMoved: false });

  themeRef.current = theme;
  hoverRef.current = hoveredTarget;

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const initialProfile = getLiveDeviceProfile(performancePref);
    const reducedMotion = initialProfile.reducedMotion || !initialProfile.universeAnimated;
    const stars = createSketchStars();
    const clouds = createInitialClouds();
    let flyers: OrigamiFlyer[] = [];
    let w = window.innerWidth;
    let h = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, initialProfile.tier === 0 ? 1 : 1.75);
    let dayBlend = themeRef.current === 'day' ? 1 : 0;
    let frameTick = 0;
    let lastDrawTime = 0;
    let rafId: number | null = null;
    let flyerSeed = 10;
    let stopLoopForEco = reducedMotion;

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (flyers.length === 0) {
        flyers = Array.from({ length: 5 }, (_, i) => {
          const f = spawnOrigami(w, h, i + 1, false);
          f.x = seeded(i * 53 + 2) * w;
          return f;
        });
      }
    };

    resize();

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      pointerRef.current.tx = e.clientX / Math.max(1, w);
      pointerRef.current.ty = e.clientY / Math.max(1, h);
      pointerRef.current.hasMoved = true;
    };

    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    /** Draws a single 12 FPS hand-drawn frame with 3-step Line Boil wobble */
    const renderFrame = (stepMotion: boolean) => {
      const targetDay = themeRef.current === 'day' ? 1 : 0;
      dayBlend += (targetDay - dayBlend) * (stepMotion ? 0.24 : 1);
      if (Math.abs(targetDay - dayBlend) < 0.01) dayBlend = targetDay;
      const nightAlpha = 1 - dayBlend;
      const dayAlpha = dayBlend;

      const ptr = pointerRef.current;
      ptr.x += (ptr.tx - ptr.x) * 0.22;
      ptr.y += (ptr.ty - ptr.y) * 0.22;
      const pxShift = (ptr.x - 0.5) * -22;
      const pyShift = (ptr.y - 0.5) * -14;

      const boilIdx = frameTick % 3; // 3-frame classic 12 FPS Line Boil jitter!
      const boil = (salt: number) => (seeded(salt * 13 + boilIdx * 37) - 0.5) * 1.45;

      const hovered = hoverRef.current;
      if (hovered === 'draw' && prevHoverRef.current !== 'draw' && flyers.length < 7) {
        flyerSeed += 1;
        flyers.push(spawnOrigami(w, h, flyerSeed, true));
      }
      prevHoverRef.current = hovered;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 1. Subtle Top-Right Warm Tungsten Desk Lamp Cone (Night) / Diagonal Window Sunbeams (Day)
      if (nightAlpha > 0.02) {
        const lampX = w * 0.88 + pxShift * 0.2;
        const lampY = 54;
        const coneGrad = ctx.createRadialGradient(lampX, lampY, 16, lampX - w * 0.22, h * 0.42, Math.max(w, h) * 0.78);
        coneGrad.addColorStop(0, `rgba(255, 224, 152, ${(0.18 * nightAlpha).toFixed(3)})`);
        coneGrad.addColorStop(0.32, `rgba(232, 166, 72, ${(0.075 * nightAlpha).toFixed(3)})`);
        coneGrad.addColorStop(0.75, `rgba(59, 130, 246, ${(0.022 * nightAlpha).toFixed(3)})`);
        coneGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = coneGrad;
        ctx.fillRect(0, 0, w, h);

        // Soft cursor tungsten accent following animator's pen
        if (ptr.hasMoved) {
          const cg = ctx.createRadialGradient(ptr.x * w, ptr.y * h, 10, ptr.x * w, ptr.y * h, 280);
          cg.addColorStop(0, `rgba(247, 224, 174, ${(0.055 * nightAlpha).toFixed(3)})`);
          cg.addColorStop(1, 'rgba(247, 224, 174, 0)');
          ctx.fillStyle = cg;
          ctx.fillRect(0, 0, w, h);
        }
      }

      if (dayAlpha > 0.02) {
        // Warm diagonal sunlit studio window beams
        ctx.save();
        ctx.fillStyle = `rgba(255, 250, 232, ${(0.34 * dayAlpha).toFixed(3)})`;
        for (let b = 0; b < 3; b++) {
          const bx = w * (0.14 + b * 0.28) + pxShift * 0.3;
          ctx.beginPath();
          ctx.moveTo(bx, 0);
          ctx.lineTo(bx + w * 0.14, 0);
          ctx.lineTo(bx - w * 0.06, h);
          ctx.lineTo(bx - w * 0.2, h);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }

      // 2. Non-Photo Blue Animator's Compass Orbits & Technical Drafting Crosshairs
      ctx.save();
      const orbitCx = w * 0.42 + pxShift * 0.35;
      const orbitCy = h * 0.54 + pyShift * 0.35;
      const baseR = Math.min(w, h) * 0.44;
      const blueStroke =
        dayAlpha > 0.5
          ? `rgba(37, 99, 235, ${(0.09 + (hovered === 'draw' ? 0.07 : 0)).toFixed(3)})`
          : `rgba(96, 165, 250, ${(0.12 + (hovered === 'draw' ? 0.09 : 0)).toFixed(3)})`;
      ctx.strokeStyle = blueStroke;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.ellipse(orbitCx, orbitCy, baseR * 1.18, baseR * 0.72, -0.14, 0, Math.PI * 2);
      ctx.stroke();

      ctx.setLineDash([3, 10]);
      ctx.beginPath();
      ctx.ellipse(orbitCx, orbitCy, baseR * 1.48, baseR * 0.94, 0.08, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Orbit spark traveling along the compass arc when hovering 3D Clapperboard ('draw')
      if (hovered === 'draw') {
        const ang = (frameTick * 0.14) % (Math.PI * 2);
        const sx = orbitCx + Math.cos(ang) * baseR * 1.18;
        const sy = orbitCy + Math.sin(ang) * baseR * 0.72;
        ctx.fillStyle = '#F5B436';
        ctx.beginPath();
        ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(245, 180, 54, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 8 + (boilIdx % 2) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Subtle drafting registration crosshairs (+)
      const marks = [
        [w * 0.06, h * 0.18],
        [w * 0.94, h * 0.24],
        [w * 0.05, h * 0.84],
        [w * 0.94, h * 0.82],
      ];
      ctx.strokeStyle = dayAlpha > 0.5 ? 'rgba(28, 25, 23, 0.14)' : 'rgba(217, 155, 38, 0.22)';
      ctx.lineWidth = 1;
      for (const [mx, my] of marks) {
        ctx.beginPath();
        ctx.moveTo(mx - 6, my);
        ctx.lineTo(mx + 6, my);
        ctx.moveTo(mx, my - 6);
        ctx.lineTo(mx, my + 6);
        ctx.stroke();
      }
      ctx.restore();

      // 3. NIGHT COSMOS ELEMENTS: Paper-Cut Crescent Moon, Ringed Planet, 12 FPS Line-Boil Stars & Constellations
      if (nightAlpha > 0.03) {
        ctx.save();
        ctx.globalAlpha = nightAlpha;

        // 3a. Hand-Drawn Paper Crescent Moon (Top-Right open sky above right doors — zero lightbox collision!)
        const moonX = Math.min(w - 52, w * 0.92) + pxShift * 0.45;
        const moonY = Math.max(92, h * 0.14) + pyShift * 0.45;
        ctx.save();
        ctx.translate(moonX, moonY);
        ctx.rotate(-0.22 + boil(1) * 0.015);
        ctx.fillStyle = '#F3EAD4';
        ctx.strokeStyle = '#D99B26';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, 22, 0.35, Math.PI * 1.68, false);
        ctx.quadraticCurveTo(-5 + boil(2), 0 + boil(3), Math.cos(0.35) * 22, Math.sin(0.35) * 22);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Delicate ink hatching lines on crescent belly
        ctx.strokeStyle = 'rgba(28, 25, 23, 0.26)';
        ctx.lineWidth = 0.9;
        for (let k = -10; k <= 10; k += 5) {
          ctx.beginPath();
          ctx.moveTo(-16, k);
          ctx.lineTo(-9, k + 2);
          ctx.stroke();
        }
        ctx.restore();

        // 3b. Little Prince / Méliès Ringed Sketch Planet (Top-Right Open Sky Gap)
        const plX = w * 0.74 + pxShift * 0.65;
        const plY = Math.max(94, h * 0.13) + pyShift * 0.65;
        ctx.save();
        ctx.translate(plX, plY);
        ctx.rotate(-0.26);
        // Back ring
        ctx.strokeStyle = 'rgba(217, 155, 38, 0.52)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(0, 0, 26 + boil(4) * 0.4, 7.2, 0, Math.PI, Math.PI * 2);
        ctx.stroke();
        // Paper body
        ctx.fillStyle = '#2B2825';
        ctx.strokeStyle = '#EAE0CC';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, 11.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Front ring
        ctx.strokeStyle = 'rgba(245, 180, 54, 0.75)';
        ctx.beginPath();
        ctx.ellipse(0, 0, 26 + boil(5) * 0.4, 7.2, 0, 0, Math.PI);
        ctx.stroke();
        ctx.restore();

        // 3c. 12 FPS Line-Boil Ink Stars + Cursor Constellation Web
        const cursorX = ptr.x * w;
        const cursorY = ptr.y * h;
        const nearStars: { x: number; y: number }[] = [];

        for (let i = 0; i < stars.length; i++) {
          const s = stars[i];
          const sx = s.nx * w + pxShift * s.depth + boil(i + 20) * 0.45;
          const sy = s.ny * h + pyShift * s.depth + boil(i + 70) * 0.45;
          const twinkle = 0.45 + 0.55 * Math.abs(Math.sin((frameTick + s.phase) * 0.22));

          const dist = Math.hypot(sx - cursorX, sy - cursorY);
          if (ptr.hasMoved && dist < 175) {
            nearStars.push({ x: sx, y: sy });
          }

          ctx.save();
          ctx.translate(sx, sy);
          ctx.strokeStyle = s.warm
            ? `rgba(245, 198, 102, ${(0.72 * twinkle).toFixed(2)})`
            : `rgba(235, 229, 216, ${(0.64 * twinkle).toFixed(2)})`;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.lineWidth = 1.25;
          ctx.lineCap = 'round';

          if (s.kind === 'cross') {
            const r = s.size * (0.85 + twinkle * 0.35);
            ctx.beginPath();
            ctx.moveTo(-r, boil(i + 1));
            ctx.lineTo(r, boil(i + 2));
            ctx.moveTo(boil(i + 3), -r);
            ctx.lineTo(boil(i + 4), r);
            ctx.stroke();
          } else if (s.kind === 'spark') {
            const r = s.size * 0.9;
            ctx.beginPath();
            ctx.moveTo(0, -r);
            ctx.quadraticCurveTo(0, 0, r, 0);
            ctx.quadraticCurveTo(0, 0, 0, r);
            ctx.quadraticCurveTo(0, 0, -r, 0);
            ctx.quadraticCurveTo(0, 0, 0, -r);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.arc(0, 0, Math.max(1.2, s.size * 0.34), 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }

        // Non-Photo Blue Sketch Constellation lines around cursor
        if (nearStars.length >= 2) {
          ctx.strokeStyle = 'rgba(96, 165, 250, 0.24)';
          ctx.lineWidth = 0.9;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          for (let i = 0; i < Math.min(nearStars.length - 1, 5); i++) {
            ctx.moveTo(nearStars[i].x, nearStars[i].y);
            ctx.lineTo(nearStars[i + 1].x, nearStars[i + 1].y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }

      // 4. DAY SKY SKETCHBOOK ELEMENTS: Drifting Hand-Inked Clouds
      if (dayAlpha > 0.03) {
        ctx.save();
        ctx.globalAlpha = dayAlpha;
        for (const cl of clouds) {
          if (stepMotion) {
            cl.nx += cl.speed;
            if (cl.nx > 1.15) cl.nx = -0.15;
          }
          const cx = cl.nx * w + pxShift * 0.45;
          const cy = cl.ny * h + pyShift * 0.35;
          const sc = cl.scale;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(sc, sc);
          ctx.fillStyle = 'rgba(255, 253, 246, 0.72)';
          ctx.strokeStyle = 'rgba(42, 36, 30, 0.24)';
          ctx.lineWidth = 1.4;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(-44, 12 + boil(cl.seed));
          ctx.bezierCurveTo(-50, -6, -30, -18, -14, -10 + boil(cl.seed + 1));
          ctx.bezierCurveTo(-6, -28, 22, -26, 26, -8 + boil(cl.seed + 2));
          ctx.bezierCurveTo(44, -12, 54, 4, 42, 12);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      }

      // 5. HOVER-REACTIVE 3D OBJECT MICRO-SCENES (Paper Viewfinder / Puppet Threads / 16mm Projector Beam)
      if (hovered === 'paper') {
        ctx.save();
        ctx.strokeStyle = dayAlpha > 0.5 ? 'rgba(229, 77, 46, 0.36)' : 'rgba(247, 243, 233, 0.28)';
        ctx.lineWidth = 1.6;
        const pad = 28;
        const arm = 24;
        const corners = [
          [pad, 68, 1, 1],
          [w - pad, 68, -1, 1],
          [pad, h - 62, 1, -1],
          [w - pad, h - 62, -1, -1],
        ];
        for (const [cx, cy, dx, dy] of corners) {
          ctx.beginPath();
          ctx.moveTo(cx, cy + dy * arm);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx + dx * arm, cy);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (hovered === 'puppet') {
        ctx.save();
        ctx.strokeStyle = dayAlpha > 0.5 ? 'rgba(180, 118, 18, 0.28)' : 'rgba(217, 155, 38, 0.34)';
        ctx.lineWidth = 1.1;
        ctx.setLineDash([4, 5]);
        const sway = Math.sin(frameTick * 0.28) * 14;
        for (let t = 0; t < 3; t++) {
          const sx = w * (0.22 + t * 0.28);
          ctx.beginPath();
          ctx.moveTo(sx, 56);
          ctx.quadraticCurveTo(sx + sway, h * 0.26, sx + sway * 1.4, h * 0.42);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
      }

      if (hovered === 'film') {
        // Warm diagonal 16mm cinema projector light cone + luminous floating dust motes
        ctx.save();
        const beamGrad = ctx.createLinearGradient(w * 0.92, h * 0.72, w * 0.14, h * 0.18);
        beamGrad.addColorStop(0, dayAlpha > 0.5 ? 'rgba(217, 155, 38, 0.20)' : 'rgba(245, 198, 102, 0.22)');
        beamGrad.addColorStop(0.55, dayAlpha > 0.5 ? 'rgba(217, 155, 38, 0.06)' : 'rgba(245, 198, 102, 0.06)');
        beamGrad.addColorStop(1, 'rgba(245, 198, 102, 0)');
        ctx.fillStyle = beamGrad;
        ctx.beginPath();
        ctx.moveTo(w * 0.92, h * 0.72);
        ctx.lineTo(w * 0.08, h * 0.12);
        ctx.lineTo(w * 0.08, h * 0.68);
        ctx.closePath();
        ctx.fill();

        // Dust motes inside projector beam
        ctx.fillStyle = dayAlpha > 0.5 ? 'rgba(180, 120, 24, 0.45)' : 'rgba(255, 242, 200, 0.65)';
        for (let m = 0; m < 12; m++) {
          const prog = ((frameTick * 0.018 + seeded(m * 11)) % 1);
          const mx = w * (0.86 - prog * 0.7);
          const my = h * (0.68 - prog * 0.34) + Math.sin(frameTick * 0.25 + m) * 26;
          ctx.beginPath();
          ctx.arc(mx, my, 1.3 + (m % 2) * 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // 6. 12 FPS HAND-DRAWN ORIGAMI BIRDS & PAPER PLANES (Soaring across both Night & Day!)
      for (let i = 0; i < flyers.length; i++) {
        const f = flyers[i];
        if (stepMotion) {
          const boost = hovered === 'draw' ? 1.45 : 1;
          f.x += f.vx * boost;
          f.y += f.vy * boost + Math.sin(frameTick * 0.24 + f.wingPhase) * 0.55;
          f.trail.push({ x: f.x, y: f.y });
          if (f.trail.length > 14) f.trail.shift();

          if (f.x > w + 60 || f.y < -60) {
            flyerSeed += 1;
            flyers[i] = spawnOrigami(w, h, flyerSeed, i % 2 === 0);
            continue;
          }
        }

        // Dashed Non-Photo Blue sketch trajectory trail
        if (f.trail.length > 2) {
          ctx.save();
          ctx.strokeStyle = dayAlpha > 0.5 ? 'rgba(37, 99, 235, 0.22)' : 'rgba(96, 165, 250, 0.25)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 5]);
          ctx.beginPath();
          ctx.moveTo(f.trail[0].x, f.trail[0].y);
          for (let t = 1; t < f.trail.length; t++) {
            ctx.lineTo(f.trail[t].x, f.trail[t].y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }

        const angle = Math.atan2(f.vy, f.vx);
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(angle);
        ctx.scale(f.scale, f.scale);

        const paperFill = dayAlpha > 0.5 ? '#FFFDF8' : '#F4ECDC';
        const inkStroke = dayAlpha > 0.5 ? '#1C1917' : '#D99B26';
        ctx.fillStyle = paperFill;
        ctx.strokeStyle = inkStroke;
        ctx.lineWidth = 1.4;
        ctx.lineJoin = 'round';

        if (f.kind === 'plane') {
          // Hand-drawn paper airplane
          ctx.beginPath();
          ctx.moveTo(14, 0);
          ctx.lineTo(-10, -8 + boil(i + 3) * 0.5);
          ctx.lineTo(-5, 0);
          ctx.lineTo(-10, 7 + boil(i + 4) * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(14, 0);
          ctx.lineTo(-5, 0);
          ctx.stroke();
        } else {
          // 12 FPS Flapping Origami Bird
          const flap = Math.sin(frameTick * 0.65 + f.wingPhase) * 9;
          ctx.beginPath();
          ctx.moveTo(11, -1);
          ctx.lineTo(2, 3);
          ctx.lineTo(-10, 2);
          ctx.lineTo(-3, -2);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          // Upper flapping wing
          ctx.beginPath();
          ctx.moveTo(3, 0);
          ctx.lineTo(-4, -12 + flap);
          ctx.lineTo(-7, 1);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.restore();
    };

    // Always draw initial crisp frame immediately (even in Tier 0 / Eco / Reduced Motion!)
    renderFrame(false);

    if (stopLoopForEco) {
      return () => {
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointermove', onPointerMove);
      };
    }

    const unsubTier = subscribeDeviceTierChanges(() => {
      if (!getLiveDeviceProfile(performancePref).universeAnimated) {
        stopLoopForEco = true;
      }
    });

    const FRAME_INTERVAL_MS = 1000 / 12; // Classic 12 FPS "on twos" animation rhythm!
    const loop = (now: number) => {
      if (stopLoopForEco) {
        rafId = null;
        return;
      }
      rafId = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (now - lastDrawTime < FRAME_INTERVAL_MS) return;
      lastDrawTime = now;
      frameTick += 1;
      renderFrame(true);
    };

    rafId = requestAnimationFrame(loop);

    return () => {
      unsubTier();
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
    };
  }, [active, performancePref, theme]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="fixed inset-0 z-0 pointer-events-none select-none"
      />
      <div
        className="desk-ruler-top relative z-10 h-2 w-full opacity-55 pointer-events-none select-none shrink-0"
        aria-hidden="true"
      />
    </>
  );
}
