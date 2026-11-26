import { useEffect, useRef } from 'react';
import type { StudioTheme } from '../../types/studio';
import { getLiveDeviceProfile, subscribeDeviceTierChanges } from '../../engine/deviceTierEngine';
import { useStudioStore } from '../../store/useStudioStore';

export type UniverseHoverTarget = 'draw' | 'paper' | 'puppet' | 'film' | null;

interface AnimatedUniverseCanvasProps {
  theme: StudioTheme;
  hoveredTarget: UniverseHoverTarget;
  active?: boolean;
}

interface OrigamiFlyer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  scale: number;
  phase: number;
  freq: number;
  amp: number;
  hue: 'ivory' | 'vermilion' | 'brass';
}

function seeded(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function createDraftingNodes() {
  return Array.from({ length: 24 }, (_, i) => ({
    nx: seeded(i * 3 + 1) * 0.94 + 0.03,
    ny: seeded(i * 3 + 2) * 0.88 + 0.06,
    size: 1.2 + seeded(i * 3 + 3) * 1.8,
    kind: i % 5 === 0 ? ('cross' as const) : ('dot' as const),
    salt: i + 1,
  }));
}

function spawnOrigami(w: number, h: number, seed: number, burst = false): OrigamiFlyer {
  const r1 = seeded(seed * 7 + 1);
  const r2 = seeded(seed * 7 + 2);
  const r3 = seeded(seed * 7 + 3);
  const hues: OrigamiFlyer['hue'][] = ['ivory', 'ivory', 'brass', 'vermilion'];
  return {
    x: burst ? w * 0.68 : -60 - r1 * 180,
    y: h * (0.16 + r2 * 0.66),
    vx: (burst ? 4.4 : 2.1) + r3 * 1.6,
    vy: (r1 - 0.5) * 0.55,
    scale: 0.68 + r2 * 0.44,
    phase: r3 * Math.PI * 2,
    freq: 0.035 + r1 * 0.025,
    amp: 0.9 + r2 * 1.2,
    hue: burst ? 'vermilion' : hues[Math.floor(r3 * hues.length)],
  };
}

/**
 * Architectural Backlit Studio Universe Canvas
 * - Smooth 650ms Night <-> Day `dayBlend` interpolation (never tears down canvas on theme toggle!).
 * - Zero idle 60Hz RAF wakeups: runs on a quiet 12 FPS timer and halts completely (`0 RAF/s`) when modals/drawers open or tab hides.
 * - Anchors warm tungsten lamp cone directly to the real `[data-desk-lamp]` button position.
 */
export function AnimatedUniverseCanvas({
  theme,
  hoveredTarget,
  active = true,
}: AnimatedUniverseCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeRef = useRef<StudioTheme>(theme);
  const hoverRef = useRef<UniverseHoverTarget>(hoveredTarget);
  const prevHoverRef = useRef<UniverseHoverTarget>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, hasMoved: false });
  const wakeRef = useRef<(() => void) | null>(null);
  const performancePref = useStudioStore((s) => s.performancePref);

  useEffect(() => {
    themeRef.current = theme;
    wakeRef.current?.();
  }, [theme]);

  useEffect(() => {
    hoverRef.current = hoveredTarget;
    wakeRef.current?.();
  }, [hoveredTarget]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const initialProfile = getLiveDeviceProfile(performancePref);
    const reducedMotion = initialProfile.reducedMotion || !initialProfile.universeAnimated;
    const nodes = createDraftingNodes();
    let flyers: OrigamiFlyer[] = [];
    let w = window.innerWidth;
    let h = window.innerHeight;
    let maxDpr = initialProfile.tier === 0 ? 1 : 1.75;
    let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    let dayBlend = themeRef.current === 'day' ? 1 : 0;
    let frameTick = 0;
    let timerId: number | null = null;
    let rafId: number | null = null;
    let flyerSeed = 10;
    let stopLoopForEco = reducedMotion;
    let lastStepMs = performance.now();
    let lampAnchor = { x: w * 0.88, y: 36 };

    const measureLampAnchor = () => {
      const el = document.querySelector('[data-desk-lamp="true"]');
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          lampAnchor = { x: r.left + 20, y: r.top + 26 };
          return;
        }
      }
      lampAnchor = { x: w * 0.88, y: 36 };
    };

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      maxDpr = getLiveDeviceProfile(performancePref).tier === 0 ? 1 : 1.75;
      dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      measureLampAnchor();
      if (flyers.length === 0) {
        flyers = Array.from({ length: 4 }, (_, i) => {
          const f = spawnOrigami(w, h, i + 1, false);
          f.x = seeded(i * 53 + 2) * w;
          return f;
        });
      }
    };

    resize();

    const renderFrame = (dtSec: number, stepMotion: boolean) => {
      const targetDay = themeRef.current === 'day' ? 1 : 0;
      if (reducedMotion || !stepMotion) {
        dayBlend = targetDay;
      } else {
        const blendAlpha = 1 - Math.pow(1 - 0.14, dtSec * 60);
        dayBlend += (targetDay - dayBlend) * blendAlpha;
        if (Math.abs(targetDay - dayBlend) < 0.008) dayBlend = targetDay;
      }
      const nightAlpha = 1 - dayBlend;
      const dayAlpha = dayBlend;

      const ptr = pointerRef.current;
      const ptrAlpha = stepMotion ? 1 - Math.pow(1 - 0.22, dtSec * 60) : 1;
      ptr.x += (ptr.tx - ptr.x) * ptrAlpha;
      ptr.y += (ptr.ty - ptr.y) * ptrAlpha;
      const pxShift = (ptr.x - 0.5) * -18;
      const pyShift = (ptr.y - 0.5) * -12;

      const boilIdx = frameTick % 3;
      const boil = (salt: number) => (seeded(salt * 13 + boilIdx * 37) - 0.5) * 1.1;

      const hovered = hoverRef.current;
      if (hovered === 'draw' && prevHoverRef.current !== 'draw' && flyers.length < 6) {
        flyerSeed += 1;
        flyers.push(spawnOrigami(w, h, flyerSeed, true));
      }
      prevHoverRef.current = hovered;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 1. Anchored Warm Tungsten Lamp Cone (Night) <-> Soft Architectural Skylight Wash (Day)
      if (nightAlpha > 0.01) {
        const lx = lampAnchor.x + pxShift * 0.12;
        const ly = lampAnchor.y;
        const coneGrad = ctx.createRadialGradient(lx, ly, 12, lx - w * 0.24, h * 0.44, Math.max(w, h) * 0.8);
        coneGrad.addColorStop(0, `rgba(255, 222, 148, ${(0.17 * nightAlpha).toFixed(3)})`);
        coneGrad.addColorStop(0.34, `rgba(226, 162, 68, ${(0.07 * nightAlpha).toFixed(3)})`);
        coneGrad.addColorStop(0.75, `rgba(59, 130, 246, ${(0.018 * nightAlpha).toFixed(3)})`);
        coneGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = coneGrad;
        ctx.fillRect(0, 0, w, h);

        if (ptr.hasMoved) {
          const cg = ctx.createRadialGradient(ptr.x * w, ptr.y * h, 8, ptr.x * w, ptr.y * h, 240);
          cg.addColorStop(0, `rgba(247, 224, 174, ${(0.048 * nightAlpha).toFixed(3)})`);
          cg.addColorStop(1, 'rgba(247, 224, 174, 0)');
          ctx.fillStyle = cg;
          ctx.fillRect(0, 0, w, h);
        }
      }

      if (dayAlpha > 0.01) {
        const skyWash = ctx.createRadialGradient(
          w * 0.78 + pxShift * 0.2,
          h * 0.08,
          24,
          w * 0.52,
          h * 0.48,
          Math.max(w, h) * 0.85
        );
        skyWash.addColorStop(0, `rgba(255, 252, 242, ${(0.52 * dayAlpha).toFixed(3)})`);
        skyWash.addColorStop(0.45, `rgba(246, 238, 220, ${(0.22 * dayAlpha).toFixed(3)})`);
        skyWash.addColorStop(1, 'rgba(229, 223, 210, 0)');
        ctx.fillStyle = skyWash;
        ctx.fillRect(0, 0, w, h);
      }

      // 2. Refined Animator's Non-Photo Blue Drafting Compass Arcs & Golden-Ratio Marks
      ctx.save();
      const orbitCx = w * 0.36 + pxShift * 0.28;
      const orbitCy = h * 0.52 + pyShift * 0.28;
      const baseR = Math.min(w, h) * 0.44;
      ctx.strokeStyle =
        dayBlend > 0.5
          ? `rgba(37, 99, 235, ${(0.065 + 0.03 * dayAlpha).toFixed(3)})`
          : `rgba(96, 165, 250, ${(0.075 * nightAlpha + 0.03).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 9]);
      ctx.beginPath();
      ctx.arc(orbitCx, orbitCy, baseR, -0.55, 0.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(orbitCx, orbitCy, baseR * 1.28, -0.35, 0.62);
      ctx.stroke();
      ctx.setLineDash([]);

      // Subtle registration ticks
      for (const nd of nodes) {
        const nx = nd.nx * w + pxShift * 0.22 + boil(nd.salt) * 0.35;
        const ny = nd.ny * h + pyShift * 0.22;
        if (nd.kind === 'cross') {
          ctx.strokeStyle =
            dayBlend > 0.5
              ? `rgba(110, 70, 6, ${(0.14 * dayAlpha).toFixed(3)})`
              : `rgba(217, 155, 38, ${(0.18 * nightAlpha).toFixed(3)})`;
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(nx - 3.5, ny);
          ctx.lineTo(nx + 3.5, ny);
          ctx.moveTo(nx, ny - 3.5);
          ctx.lineTo(nx, ny + 3.5);
          ctx.stroke();
        } else {
          ctx.fillStyle =
            dayBlend > 0.5
              ? `rgba(80, 72, 62, ${(0.16 * dayAlpha).toFixed(3)})`
              : `rgba(243, 238, 229, ${(0.22 * nightAlpha).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(nx, ny, nd.size * 0.65, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      // 3. Delicate Hand-Folded Origami Paper Planes Gliding on 12 FPS Rhythm
      const stepScale = Math.min(2.2, Math.max(0.4, dtSec * 12));
      for (let i = 0; i < flyers.length; i++) {
        const f = flyers[i];
        if (stepMotion) {
          f.phase += f.freq * stepScale * 5;
          f.x += f.vx * stepScale * 2.2;
          f.y += (f.vy + Math.sin(f.phase) * f.amp * 0.35) * stepScale * 2.2;
          if (f.x > w + 90) {
            flyers[i] = spawnOrigami(w, h, flyerSeed + i + frameTick, false);
          }
        }
        const fx = f.x + pxShift * 0.4;
        const fy = f.y + pyShift * 0.3;
        const bank = Math.atan2(f.vy + Math.sin(f.phase) * 0.4, f.vx) * 0.65;

        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(bank);
        ctx.scale(f.scale, f.scale);
        ctx.globalAlpha = 0.52;
        ctx.fillStyle =
          f.hue === 'vermilion'
            ? '#E54D2E'
            : f.hue === 'brass'
              ? '#D99B26'
              : dayBlend > 0.5
                ? '#FAF6EC'
                : '#EDE5D4';
        ctx.strokeStyle = dayBlend > 0.5 ? 'rgba(30, 27, 24, 0.48)' : 'rgba(18, 16, 14, 0.62)';
        ctx.lineWidth = 1.2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(15, 0);
        ctx.lineTo(-11, -7);
        ctx.lineTo(-6, 0);
        ctx.lineTo(-11, 7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
    };

    measureLampAnchor();
    renderFrame(1 / 12, false);

    if (!active || stopLoopForEco) {
      wakeRef.current = () => {
        measureLampAnchor();
        renderFrame(1 / 12, false);
      };
      const onResizeStatic = () => {
        resize();
        renderFrame(1 / 12, false);
      };
      window.addEventListener('resize', onResizeStatic);
      return () => {
        wakeRef.current = null;
        window.removeEventListener('resize', onResizeStatic);
      };
    }

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      pointerRef.current.tx = e.clientX / Math.max(1, w);
      pointerRef.current.ty = e.clientY / Math.max(1, h);
      pointerRef.current.hasMoved = true;
    };

    const unsubTier = subscribeDeviceTierChanges(() => {
      if (!getLiveDeviceProfile(performancePref).universeAnimated) {
        stopLoopForEco = true;
        if (timerId !== null) window.clearTimeout(timerId);
        if (rafId !== null) cancelAnimationFrame(rafId);
      }
    });

    const scheduleNext = () => {
      if (stopLoopForEco || document.hidden || !active) return;
      const targetDay = themeRef.current === 'day' ? 1 : 0;
      const isTransitioning = Math.abs(targetDay - dayBlend) > 0.008;
      if (isTransitioning) {
        rafId = requestAnimationFrame((now) => {
          rafId = null;
          const dt = Math.min(0.08, Math.max(0.008, (now - lastStepMs) / 1000));
          lastStepMs = now;
          frameTick += 1;
          measureLampAnchor();
          renderFrame(dt, true);
          scheduleNext();
        });
      } else {
        timerId = window.setTimeout(() => {
          timerId = null;
          if (stopLoopForEco || document.hidden || !active) return;
          const now = performance.now();
          const dt = Math.min(0.15, Math.max(0.04, (now - lastStepMs) / 1000));
          lastStepMs = now;
          frameTick += 1;
          renderFrame(dt, true);
          scheduleNext();
        }, 84);
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (timerId !== null) {
          window.clearTimeout(timerId);
          timerId = null;
        }
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      } else {
        lastStepMs = performance.now();
        scheduleNext();
      }
    };

    wakeRef.current = () => {
      measureLampAnchor();
      if (stopLoopForEco) {
        renderFrame(1 / 12, false);
        return;
      }
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      if (rafId === null && !document.hidden) {
        lastStepMs = performance.now();
        scheduleNext();
      }
    };

    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    scheduleNext();

    return () => {
      wakeRef.current = null;
      unsubTier();
      if (timerId !== null) window.clearTimeout(timerId);
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, performancePref]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="fixed inset-0 z-0 pointer-events-none select-none"
      />
      {/* Overlay drafting hairline so <header> stays at exact y = 0px! */}
      <div
        className="desk-ruler-top fixed top-0 inset-x-0 z-50 h-1 w-full opacity-35 pointer-events-none select-none"
        aria-hidden="true"
      />
    </>
  );
}
