import type { FieldGuideConfig } from '../types/studio';

/**
 * Renders non-exporting Animator's Underlay Guides directly beneath the active ink
 * (Bounce Arc, 8-Frame Walk Cycle synced to active frame, Head Turn, Wave Principle,
 * 1-Point & 2-Point Interactive Perspective Rays, plus Mirror Symmetry axis).
 */
export function renderUnderlayGuide(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  guides: FieldGuideConfig,
  activeFrameIndex: number,
  symmetryX: boolean
): void {
  // 1. Live Mirror Symmetry Axis (always shown when symmetry drawing is active)
  if (symmetryX) {
    ctx.save();
    ctx.strokeStyle = 'rgba(229, 77, 46, 0.48)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(229, 77, 46, 0.85)';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.fillText('AYNA SİMETRİ', width / 2 + 8, 20);
    ctx.restore();
  }

  const kind = guides.underlay;
  if (!kind || kind === 'none') return;

  const alpha = Math.max(0.15, Math.min(0.65, guides.underlayOpacity || 0.34));
  ctx.save();
  ctx.strokeStyle = `rgba(37, 99, 235, ${alpha})`;
  ctx.fillStyle = `rgba(37, 99, 235, ${alpha * 1.15})`;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (kind === 'bounce') {
    // 12-Frame Classic Parabolic Bounce Arc + Squash/Stretch spacing dots
    const groundY = height * 0.82;
    const apexY = height * 0.22;
    const startX = width * 0.14;
    const endX = width * 0.86;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(width * 0.08, groundY);
    ctx.lineTo(width * 0.92, groundY);
    ctx.stroke();
    ctx.setLineDash([]);

    const stepIdx = activeFrameIndex % 12;
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const x = startX + (endX - startX) * t;
      const arc = 4 * t * (1 - t); // parabola 0..1..0
      const y = groundY - arc * (groundY - apexY) - 28;
      const isCur = i === stepIdx;
      const sx = i === 0 || i === 11 ? 1.25 : i === 2 || i === 9 ? 0.82 : 1;
      const sy = 1 / sx;
      ctx.save();
      ctx.lineWidth = isCur ? 3 : 1.5;
      if (isCur) ctx.strokeStyle = `rgba(229, 77, 46, ${Math.min(0.85, alpha * 2)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 26 * sx, 26 * sy, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${i + 1}`, x, y + 4);
      ctx.restore();
    }
  } else if (kind === 'walk') {
    // Authentic 8-Frame Richard Williams Walk Cycle Pose Guide synced to current frame!
    const phase = activeFrameIndex % 8;
    const labels = [
      '1: TEMAS (Contact)',
      '2: ÇÖKÜŞ (Down)',
      '3: GEÇİŞ (Passing)',
      '4: YÜKSELİŞ (Up)',
      '5: TEMAS (Ters)',
      '6: ÇÖKÜŞ (Ters)',
      '7: GEÇİŞ (Ters)',
      '8: YÜKSELİŞ (Ters)',
    ];
    const cx = width * 0.5;
    const groundY = height * 0.82;
    const hipLift = [0, 18, -8, -24, 0, 18, -8, -24][phase];
    const hipY = groundY - height * 0.34 + hipLift;
    const headY = hipY - height * 0.24;

    // Ground line + head bob band
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(width * 0.15, groundY);
    ctx.lineTo(width * 0.85, groundY);
    ctx.moveTo(width * 0.25, groundY - height * 0.58 - 24);
    ctx.lineTo(width * 0.75, groundY - height * 0.58 - 24);
    ctx.stroke();
    ctx.setLineDash([]);

    // Torso & head
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx + 8, headY, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 5, headY + 34);
    ctx.lineTo(cx, hipY);
    ctx.stroke();

    // Near leg (vermilion guide) & Far leg (blue guide)
    const ang = (phase / 8) * Math.PI * 2;
    const stride = width * 0.11;
    const f1x = cx + Math.sin(ang) * stride;
    const f1y = groundY - Math.max(0, -Math.cos(ang)) * 42;
    const f2x = cx - Math.sin(ang) * stride;
    const f2y = groundY - Math.max(0, Math.cos(ang)) * 42;

    // Far leg (blue)
    ctx.beginPath();
    ctx.moveTo(cx, hipY);
    ctx.lineTo((cx + f2x) / 2 + 12, (hipY + f2y) / 2);
    ctx.lineTo(f2x, f2y);
    ctx.stroke();

    // Near leg (vermilion)
    ctx.strokeStyle = `rgba(229, 77, 46, ${Math.min(0.85, alpha * 1.9)})`;
    ctx.beginPath();
    ctx.moveTo(cx, hipY);
    ctx.lineTo((cx + f1x) / 2 + 14, (hipY + f1y) / 2);
    ctx.lineTo(f1x, f1y);
    ctx.stroke();

    // Counter-swinging near arm
    const shoulderY = headY + 52;
    ctx.beginPath();
    ctx.moveTo(cx + 4, shoulderY);
    ctx.lineTo(cx - Math.sin(ang) * (stride * 0.8), shoulderY + height * 0.16);
    ctx.stroke();

    ctx.font = 'bold 13px "JetBrains Mono", monospace';
    ctx.fillText(`YÜRÜYÜŞ KILAVUZU · ${labels[phase]}`, width * 0.16, height * 0.1);
  } else if (kind === 'head-turn') {
    // Classic 3/4 -> Front -> 3/4 Head Turn Volume & Eye-Line Arc
    const cx = width * 0.5;
    const cy = height * 0.48;
    const r = Math.min(width, height) * 0.24;
    const phase = (activeFrameIndex % 8) / 7; // 0..1
    const turnOffset = (phase - 0.5) * 2 * r * 0.65;
    const dip = Math.sin(phase * Math.PI) * 16;

    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.88, r, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Curved eye-line arc
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.88, cy - 6);
    ctx.quadraticCurveTo(cx, cy + dip, cx + r * 0.88, cy - 6);
    ctx.stroke();
    // Vertical centerline sweeping across sphere
    ctx.strokeStyle = `rgba(229, 77, 46, ${Math.min(0.8, alpha * 1.8)})`;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.quadraticCurveTo(cx + turnOffset * 1.4, cy, cx, cy + r);
    ctx.stroke();
  } else if (kind === 'wave') {
    // Classic Flag / Hair / Fire Traveling S-Wave Guide
    const phase = (activeFrameIndex % 8) * ((Math.PI * 2) / 8);
    const startX = width * 0.18;
    const endX = width * 0.82;
    const midY = height * 0.5;
    ctx.lineWidth = 2.6;
    for (const rowOff of [-60, 0, 60]) {
      ctx.beginPath();
      for (let s = 0; s <= 40; s++) {
        const t = s / 40;
        const x = startX + (endX - startX) * t;
        const amp = 18 + t * 54;
        const y = midY + rowOff + Math.sin(t * Math.PI * 2.5 - phase) * amp;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else if (kind === 'persp1' || kind === 'persp2') {
    const vp1x = (guides.vp1?.x ?? 0.5) * width;
    const vp1y = (guides.vp1?.y ?? 0.42) * height;
    // Horizon Line
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(0, vp1y);
    ctx.lineTo(width, vp1y);
    ctx.stroke();
    ctx.setLineDash([]);

    const drawRays = (vx: number, vy: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      const rays = 16;
      const maxR = Math.hypot(width, height) * 1.2;
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(vx, vy);
        ctx.lineTo(vx + Math.cos(a) * maxR, vy + Math.sin(a) * maxR);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(vx, vy, 7, 0, Math.PI * 2);
      ctx.fill();
    };

    drawRays(vp1x, vp1y, `rgba(37, 99, 235, ${alpha})`);
    if (kind === 'persp2') {
      const vp2x = (guides.vp2?.x ?? 0.86) * width;
      drawRays(vp2x, vp1y, `rgba(229, 77, 46, ${alpha * 0.9})`);
    }
  }

  ctx.restore();
}
