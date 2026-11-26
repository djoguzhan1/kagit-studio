import type { CartoonMoodId, StorybookWorldId } from './cartoonMotionEngine';

export interface WorldFrameMetrics {
  groundY: number;
  horizonY: number;
  lampPos: { x: number; y: number } | null;
  lightningFlash: number;
  cameraShakeX: number;
  cameraShakeY: number;
  isDark: boolean;
  hasPuddle: boolean;
  windX: number;
}

/**
 * Draws the hand-painted storybook backdrop for any of the 5 live worlds ($0, 60fps pure Canvas 2D!).
 */
export function drawStorybookWorldBackdrop(
  ctx: CanvasRenderingContext2D,
  world: StorybookWorldId,
  W: number,
  H: number,
  tSec: number,
  lx: number,
  ly: number,
  mood: CartoonMoodId
): WorldFrameMetrics {
  const speedBase =
    mood === 'sprint' ? 104 : mood === 'sneak' ? 24 : mood === 'cool' ? 38 : mood === 'natural' ? 54 : 58;
  const scroll = tSec * speedBase;

  if (world === 'rainy') {
    const lCycle = (tSec + 2.4) % 7.6;
    const lightningFlash =
      lCycle < 0.14
        ? Math.sin((lCycle / 0.14) * Math.PI) * 0.72
        : lCycle > 0.2 && lCycle < 0.32
          ? Math.sin(((lCycle - 0.2) / 0.12) * Math.PI) * 0.45
          : 0;

    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.64);
    sky.addColorStop(0, lightningFlash > 0.2 ? '#293B5C' : '#0B1222');
    sky.addColorStop(0.55, lightningFlash > 0.2 ? '#3B4F72' : '#18243A');
    sky.addColorStop(1, '#313748');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.fillStyle = lightningFlash > 0.2 ? 'rgba(182, 206, 240, 0.22)' : 'rgba(26, 38, 62, 0.45)';
    for (let cl = 0; cl < 4; cl++) {
      const cx = (((cl * 310 - scroll * 0.1 - lx * 10) % (W + 320)) + W + 320) % (W + 320) - 160;
      const cy = H * (0.14 + (cl % 2) * 0.08) - ly * 6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 130, 34, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const moonX = W * 0.8 - lx * 12;
    const moonY = H * 0.18 - ly * 7;
    const mGlow = ctx.createRadialGradient(moonX, moonY, 8, moonX, moonY, 96);
    mGlow.addColorStop(0, 'rgba(255, 246, 218, 0.94)');
    mGlow.addColorStop(0.32, 'rgba(255, 228, 174, 0.28)');
    mGlow.addColorStop(1, 'rgba(255, 228, 174, 0)');
    ctx.fillStyle = mGlow;
    ctx.beginPath();
    ctx.arc(moonX, moonY, 96, 0, Math.PI * 2);
    ctx.fill();

    const horizonY = H * 0.58;
    const houses = [
      { x: 0.0, w: 0.21, h: 0.34, cafe: false },
      { x: 0.2, w: 0.22, h: 0.39, cafe: true },
      { x: 0.41, w: 0.19, h: 0.32, cafe: false },
      { x: 0.59, w: 0.23, h: 0.41, cafe: false },
      { x: 0.81, w: 0.22, h: 0.36, cafe: true },
    ];
    const wrapW = W * 1.24;
    const cafeXs: number[] = [];
    for (let i = 0; i < houses.length; i++) {
      const hs = houses[i];
      const hx = (((hs.x * wrapW - scroll * 0.4 - lx * 24) % wrapW) + wrapW) % wrapW - W * 0.14;
      const hw = hs.w * W;
      const hh = hs.h * H;
      const topY = horizonY - hh + 12;

      ctx.fillStyle = i % 2 === 0 ? '#141B2B' : '#1A2233';
      ctx.fillRect(hx, topY + 26, hw, hh);

      ctx.fillStyle = '#0F1523';
      ctx.beginPath();
      ctx.moveTo(hx - 10, topY + 28);
      ctx.lineTo(hx + hw * 0.5, topY - 12);
      ctx.lineTo(hx + hw + 10, topY + 28);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(hx + hw * 0.72, topY - 8, 12, 24);

      for (let wi = 0; wi < 2; wi++) {
        const wx = hx + hw * (0.2 + wi * 0.44);
        const wy = topY + 42;
        const glow = ctx.createRadialGradient(wx + 12, wy + 16, 2, wx + 12, wy + 16, 34);
        glow.addColorStop(0, 'rgba(255, 206, 114, 0.42)');
        glow.addColorStop(1, 'rgba(255, 206, 114, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(wx - 18, wy - 14, 60, 60);

        ctx.fillStyle = 'rgba(252, 208, 118, 0.88)';
        ctx.fillRect(wx, wy, 22, 30);
        ctx.strokeStyle = '#181E2C';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(wx + 11, wy);
        ctx.lineTo(wx + 11, wy + 30);
        ctx.moveTo(wx, wy + 15);
        ctx.lineTo(wx + 22, wy + 15);
        ctx.stroke();
      }

      if (hs.cafe) {
        cafeXs.push(hx + hw * 0.5);
        const shopY = horizonY - 62;
        const winX = hx + 14;
        const winW = hw - 28;
        const winY = shopY + 14;
        const winH = 48;

        const shopGlow = ctx.createRadialGradient(hx + hw * 0.5, shopY + 34, 14, hx + hw * 0.5, shopY + 48, 108);
        shopGlow.addColorStop(0, 'rgba(255, 198, 102, 0.58)');
        shopGlow.addColorStop(1, 'rgba(255, 198, 102, 0)');
        ctx.fillStyle = shopGlow;
        ctx.fillRect(hx - 24, shopY - 12, hw + 48, 130);

        const winGrad = ctx.createLinearGradient(winX, winY, winX, winY + winH);
        winGrad.addColorStop(0, '#FFE3A3');
        winGrad.addColorStop(0.65, '#F5B85B');
        winGrad.addColorStop(1, '#B86E34');
        ctx.fillStyle = winGrad;
        ctx.fillRect(winX, winY, winW, winH);

        ctx.fillStyle = '#4A2B18';
        for (let p = 0; p < 2; p++) {
          const px = winX + winW * (0.28 + p * 0.42);
          ctx.fillRect(px - 0.75, winY, 1.5, 11);
          ctx.beginPath();
          ctx.arc(px, winY + 13, 4.5, Math.PI, 0);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(42, 24, 16, 0.42)';
        ctx.fillRect(winX, winY + winH - 13, winW, 13);

        ctx.strokeStyle = '#1B202C';
        ctx.lineWidth = 2.4;
        ctx.strokeRect(winX, winY, winW, winH);
        ctx.beginPath();
        ctx.moveTo(winX + winW * 0.34, winY);
        ctx.lineTo(winX + winW * 0.34, winY + winH);
        ctx.moveTo(winX + winW * 0.68, winY);
        ctx.lineTo(winX + winW * 0.68, winY + winH);
        ctx.moveTo(winX, winY + 14);
        ctx.lineTo(winX + winW, winY + 14);
        ctx.stroke();

        const stripes = 6;
        const sw = (hw - 16) / stripes;
        for (let st = 0; st < stripes; st++) {
          const sx = hx + 8 + st * sw;
          ctx.fillStyle = st % 2 === 0 ? '#C9442B' : '#EFE3CE';
          ctx.fillRect(sx, shopY, sw + 0.6, 14);
          ctx.beginPath();
          ctx.arc(sx + sw * 0.5, shopY + 14, sw * 0.5, 0, Math.PI);
          ctx.fill();
        }
        ctx.fillStyle = '#FFF5CC';
        for (let b = 0; b <= stripes; b++) {
          ctx.beginPath();
          ctx.arc(hx + 8 + b * sw, shopY + 17, 1.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const floor = ctx.createLinearGradient(0, horizonY, 0, H);
    floor.addColorStop(0, '#1D273B');
    floor.addColorStop(0.38, '#131A29');
    floor.addColorStop(1, '#090D16');
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizonY, W, H - horizonY);

    for (const cx of cafeXs) {
      const cg = ctx.createRadialGradient(cx, horizonY + 34, 8, cx, horizonY + 62, 82);
      cg.addColorStop(0, 'rgba(255, 202, 112, 0.24)');
      cg.addColorStop(0.6, 'rgba(255, 186, 92, 0.08)');
      cg.addColorStop(1, 'rgba(255, 186, 92, 0)');
      ctx.fillStyle = cg;
      ctx.fillRect(cx - 84, horizonY, 168, 140);
    }

    ctx.fillStyle = 'rgba(255, 218, 146, 0.08)';
    for (let row = 0; row < 6; row++) {
      const ry = horizonY + 18 + row * 28;
      const rx = (((row * 210 - scroll * (0.7 + row * 0.14)) % (W + 240)) + W + 240) % (W + 240) - 120;
      ctx.beginPath();
      ctx.ellipse(rx, ry, 74 + row * 12, 3.5 + row * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const mist = ctx.createLinearGradient(0, horizonY - 24, 0, horizonY + 44);
    mist.addColorStop(0, 'rgba(148, 174, 214, 0)');
    mist.addColorStop(0.5, 'rgba(148, 174, 214, 0.11)');
    mist.addColorStop(1, 'rgba(148, 174, 214, 0)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, horizonY - 24, W, 68);

    const lampX = W * 0.72 - lx * 34;
    const lampTop = H * 0.19;
    const bulbX = lampX - 30;
    const bulbY = lampTop + 20;

    ctx.strokeStyle = '#151A24';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(lampX, horizonY + 26);
    ctx.lineTo(lampX, lampTop + 6);
    ctx.quadraticCurveTo(lampX, lampTop - 10, bulbX, lampTop + 8);
    ctx.stroke();

    ctx.fillStyle = '#FFF3C4';
    ctx.beginPath();
    ctx.arc(bulbX, bulbY, 7.5, 0, Math.PI * 2);
    ctx.fill();

    const cone = ctx.createRadialGradient(bulbX, bulbY + 8, 8, bulbX, bulbY + 130, 290);
    cone.addColorStop(0, 'rgba(255, 224, 148, 0.82)');
    cone.addColorStop(0.28, 'rgba(246, 184, 82, 0.25)');
    cone.addColorStop(1, 'rgba(246, 184, 82, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.arc(bulbX, bulbY + 115, 290, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 240, 186, 0.85)';
    for (let m = 0; m < 4; m++) {
      const mx = bulbX + Math.sin(tSec * (2.6 + m * 0.7) + m * 2.1) * (18 + m * 7);
      const my = bulbY + 6 + Math.cos(tSec * (3.1 + m * 0.5) + m) * (12 + m * 5);
      ctx.beginPath();
      ctx.arc(mx, my, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    return {
      groundY: H * 0.765,
      horizonY,
      lampPos: { x: bulbX, y: bulbY },
      lightningFlash,
      cameraShakeX: 0,
      cameraShakeY: 0,
      isDark: true,
      hasPuddle: true,
      windX: mood === 'sprint' ? -1.65 : -1.0,
    };
  }

  if (world === 'meadow') {
    // Studio Ghibli sunlit golden-hour meadow + vintage steam train crossing stone viaduct!
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.65);
    sky.addColorStop(0, '#599FD6');
    sky.addColorStop(0.52, '#9AD0EC');
    sky.addColorStop(1, '#FCE7B8');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Warm sun glow
    const sunX = W * 0.76 - lx * 14;
    const sunY = H * 0.22 - ly * 8;
    const sun = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 120);
    sun.addColorStop(0, 'rgba(255, 252, 232, 0.96)');
    sun.addColorStop(0.35, 'rgba(255, 232, 160, 0.42)');
    sun.addColorStop(1, 'rgba(255, 232, 160, 0)');
    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 120, 0, Math.PI * 2);
    ctx.fill();

    // Fluffy hand-painted Ghibli cumulus clouds
    ctx.fillStyle = 'rgba(255, 252, 245, 0.88)';
    for (let c = 0; c < 4; c++) {
      const cx = (((c * 290 - scroll * 0.14 - lx * 16) % (W + 320)) + W + 320) % (W + 320) - 160;
      const cy = H * (0.17 + (c % 2) * 0.09);
      ctx.beginPath();
      ctx.arc(cx, cy, 34, 0, Math.PI * 2);
      ctx.arc(cx + 28, cy - 12, 42, 0, Math.PI * 2);
      ctx.arc(cx + 62, cy - 2, 32, 0, Math.PI * 2);
      ctx.arc(cx - 26, cy + 4, 24, 0, Math.PI * 2);
      ctx.fill();
    }

    const horizonY = H * 0.57;

    // Distant blue-sage hills
    ctx.fillStyle = '#6A9B7E';
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) {
      const y = horizonY - 26 + Math.sin((x + scroll * 0.18 + lx * 18) * 0.008) * 26;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // Vintage stone viaduct + charming yellow steam train gliding across!
    const bridgeY = horizonY + 2;
    ctx.fillStyle = '#8F8474';
    ctx.fillRect(0, bridgeY, W, 16);
    for (let arch = -1; arch < 11; arch++) {
      const ax = (((arch * 110 - scroll * 0.32 - lx * 20) % (W + 140)) + W + 140) % (W + 140) - 70;
      ctx.fillStyle = '#756A5C';
      ctx.fillRect(ax, bridgeY + 14, 20, 40);
    }
    const trainX = (((tSec * 72) % (W + 340)) - 220);
    // Train smoke puffs
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    for (let p = 0; p < 5; p++) {
      const px = trainX + 108 - p * 22 - Math.sin(tSec * 4 + p) * 4;
      const py = bridgeY - 24 - p * 7;
      ctx.beginPath();
      ctx.arc(px, py, 6 + p * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // 3 cozy train cars
    for (let car = 0; car < 3; car++) {
      const cx = trainX + car * 46;
      ctx.fillStyle = car === 2 ? '#C94A32' : '#E7AE3E';
      ctx.fillRect(cx, bridgeY - 18, 40, 17);
      ctx.fillStyle = '#FFF5D6';
      ctx.fillRect(cx + 5, bridgeY - 14, 10, 7);
      ctx.fillRect(cx + 21, bridgeY - 14, 10, 7);
    }

    // Lush rolling mid-ground meadow hill
    const hillGrad = ctx.createLinearGradient(0, horizonY, 0, H);
    hillGrad.addColorStop(0, '#78B454');
    hillGrad.addColorStop(0.5, '#52933E');
    hillGrad.addColorStop(1, '#316528');
    ctx.fillStyle = hillGrad;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) {
      const y = horizonY + 18 + Math.sin((x + scroll * 0.48 + lx * 26) * 0.009) * 14;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // Winding warm sunlit dirt footpath under character
    ctx.fillStyle = 'rgba(232, 206, 152, 0.55)';
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 0.785, W * 0.58, 34, 0, 0, Math.PI * 2);
    ctx.fill();

    // Swaying meadow wildflowers
    for (let f = 0; f < 16; f++) {
      const fx = (((f * 78 - scroll * 0.78) % (W + 80)) + W + 80) % (W + 80) - 40;
      const fy = horizonY + 34 + (f % 4) * 26;
      const sway = Math.sin(tSec * 3.2 + f) * 5;
      ctx.strokeStyle = '#3B752E';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fx, fy + 14);
      ctx.quadraticCurveTo(fx + sway * 0.5, fy + 6, fx + sway, fy);
      ctx.stroke();
      ctx.fillStyle = f % 3 === 0 ? '#FFF6C4' : f % 3 === 1 ? '#F78CA2' : '#FFFFFF';
      ctx.beginPath();
      ctx.arc(fx + sway, fy, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    return {
      groundY: H * 0.78,
      horizonY,
      lampPos: null,
      lightningFlash: 0,
      cameraShakeX: 0,
      cameraShakeY: 0,
      isDark: false,
      hasPuddle: false,
      windX: -1.15,
    };
  }

  if (world === 'space') {
    const sky = ctx.createRadialGradient(W * 0.45, H * 0.42, 40, W * 0.5, H * 0.5, W * 0.75);
    sky.addColorStop(0, '#1D1847');
    sky.addColorStop(0.55, '#0E0D2A');
    sky.addColorStop(1, '#060614');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Dreamy pastel nebula ribbons
    const neb = ctx.createRadialGradient(W * 0.28 - lx * 18, H * 0.32, 10, W * 0.28 - lx * 18, H * 0.32, 220);
    neb.addColorStop(0, 'rgba(218, 96, 178, 0.26)');
    neb.addColorStop(0.5, 'rgba(92, 142, 255, 0.14)');
    neb.addColorStop(1, 'rgba(92, 142, 255, 0)');
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, W, H);

    // Multi-depth twinkling stars
    for (let s = 0; s < 72; s++) {
      const sx = (((s * 97 - scroll * (0.12 + (s % 3) * 0.08) - lx * 12) % W) + W) % W;
      const sy = ((s * 61) % Math.floor(H * 0.92)) + 16;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(tSec * (1.8 + (s % 4) * 0.5) + s));
      ctx.fillStyle = s % 5 === 0 ? `rgba(255, 226, 152, ${tw.toFixed(2)})` : `rgba(232, 240, 255, ${tw.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, s % 7 === 0 ? 2.2 : 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ringed pastel planet
    const px = W * 0.78 - lx * 22;
    const py = H * 0.28 - ly * 12;
    const pGrad = ctx.createRadialGradient(px - 14, py - 14, 6, px, py, 44);
    pGrad.addColorStop(0, '#FFE4A8');
    pGrad.addColorStop(0.6, '#E28A68');
    pGrad.addColorStop(1, '#753B5E');
    ctx.fillStyle = pGrad;
    ctx.beginPath();
    ctx.arc(px, py, 38, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 232, 184, 0.65)';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.ellipse(px, py, 68, 16, -0.28, 0, Math.PI * 2);
    ctx.stroke();

    // Distant curved lunar surface horizon
    ctx.fillStyle = '#1B2040';
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 1.18, W * 0.78, H * 0.38, 0, Math.PI, Math.PI * 2);
    ctx.fill();

    return {
      groundY: H * 0.80,
      horizonY: H * 0.72,
      lampPos: { x: px, y: py },
      lightningFlash: 0,
      cameraShakeX: 0,
      cameraShakeY: 0,
      isDark: true,
      hasPuddle: false,
      windX: -0.35,
    };
  }

  if (world === 'concert') {
    const beatPulse = Math.pow(Math.abs(Math.sin(tSec * Math.PI * 2)), 3);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#140824');
    bg.addColorStop(0.62, '#240E38');
    bg.addColorStop(1, '#0F0816');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Sweeping multicolored volumetric spotlights!
    const beams = [
      { ox: W * 0.16, color: 'rgba(255, 86, 172, 0.24)', ang: 0.38 + Math.sin(tSec * 1.9) * 0.24 },
      { ox: W * 0.5, color: 'rgba(255, 214, 102, 0.26)', ang: Math.sin(tSec * 1.4) * 0.18 },
      { ox: W * 0.84, color: 'rgba(72, 224, 255, 0.24)', ang: -0.38 - Math.cos(tSec * 1.7) * 0.24 },
    ];
    for (const bm of beams) {
      ctx.save();
      ctx.translate(bm.ox, 18);
      ctx.rotate(bm.ang);
      const bGrad = ctx.createLinearGradient(0, 0, 0, H * 0.85);
      bGrad.addColorStop(0, bm.color);
      bGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = bGrad;
      ctx.beginPath();
      ctx.moveTo(-16, 0);
      ctx.lineTo(16, 0);
      ctx.lineTo(118, H * 0.88);
      ctx.lineTo(-118, H * 0.88);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Polished wooden/mirror stage floor + glowing spotlight pool
    const horizonY = H * 0.64;
    const stageGrad = ctx.createLinearGradient(0, horizonY, 0, H);
    stageGrad.addColorStop(0, '#2E1A42');
    stageGrad.addColorStop(1, '#120A1E');
    ctx.fillStyle = stageGrad;
    ctx.fillRect(0, horizonY, W, H - horizonY);

    // Equalizer backdrop bars pulsing to the beat!
    for (let eq = 0; eq < 18; eq++) {
      const ex = W * 0.1 + eq * (W * 0.045);
      const eh = 18 + Math.abs(Math.sin(tSec * 5.2 + eq * 0.9)) * (48 + beatPulse * 28);
      ctx.fillStyle = eq % 2 === 0 ? 'rgba(255, 198, 92, 0.22)' : 'rgba(255, 92, 168, 0.22)';
      ctx.fillRect(ex, horizonY - eh, W * 0.03, eh);
    }

    // Warm golden stage spot circle under character
    const spot = ctx.createRadialGradient(W * 0.5, H * 0.77, 16, W * 0.5, H * 0.77, 175 + beatPulse * 18);
    spot.addColorStop(0, 'rgba(255, 224, 146, 0.34)');
    spot.addColorStop(1, 'rgba(255, 224, 146, 0)');
    ctx.fillStyle = spot;
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 0.77, 175 + beatPulse * 18, 42, 0, 0, Math.PI * 2);
    ctx.fill();

    return {
      groundY: H * 0.77,
      horizonY,
      lampPos: { x: W * 0.5, y: 24 },
      lightningFlash: 0,
      cameraShakeX: 0,
      cameraShakeY: beatPulse * 1.4,
      isDark: true,
      hasPuddle: true,
      windX: -0.65,
    };
  }

  // 'escape': dramatic canyon twilight with giant rolling cartoon boulder chasing from the left!
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.65);
  sky.addColorStop(0, '#2B1732');
  sky.addColorStop(0.55, '#843440');
  sky.addColorStop(1, '#E58A4B');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const horizonY = H * 0.64;
  // Jagged sunset canyon mesas speeding past
  ctx.fillStyle = '#4B1F30';
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  for (let m = 0; m < 7; m++) {
    const mx = (((m * 200 - scroll * 0.85) % (W + 240)) + W + 240) % (W + 240) - 120;
    ctx.lineTo(mx, horizonY);
    ctx.lineTo(mx + 34, horizonY - 96 - (m % 2) * 32);
    ctx.lineTo(mx + 126, horizonY - 90 - (m % 2) * 32);
    ctx.lineTo(mx + 158, horizonY);
  }
  ctx.lineTo(W, horizonY);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();

  // Dusty ochre canyon floor
  const fl = ctx.createLinearGradient(0, horizonY, 0, H);
  fl.addColorStop(0, '#9E5338');
  fl.addColorStop(1, '#4C251C');
  ctx.fillStyle = fl;
  ctx.fillRect(0, horizonY, W, H - horizonY);

  // Speed streaks rushing horizontally on ground
  ctx.strokeStyle = 'rgba(255, 224, 178, 0.25)';
  ctx.lineWidth = 2;
  for (let st = 0; st < 8; st++) {
    const sx = (((st * 170 - scroll * 2.4) % (W + 140)) + W + 140) % (W + 140) - 70;
    const sy = horizonY + 20 + (st % 4) * 28;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 58, sy);
    ctx.stroke();
  }

  // GIANT ROLLING CARTOON BOULDER chasing right behind our hero!
  const bBounce = Math.abs(Math.sin(tSec * 5.2));
  const boulderR = Math.min(H * 0.24, 118);
  const boulderX = W * 0.16 + Math.sin(tSec * 1.8) * 18;
  const boulderY = H * 0.78 - boulderR - bBounce * 18;
  const shake = bBounce < 0.18 ? (0.18 - bBounce) * 18 : 0;

  // Boulder shadow
  ctx.fillStyle = 'rgba(24, 10, 8, 0.45)';
  ctx.beginPath();
  ctx.ellipse(boulderX, H * 0.78 + 4, boulderR * 0.82, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  // Rolling boulder body with spinning hand-drawn cracks!
  ctx.save();
  ctx.translate(boulderX, boulderY);
  ctx.rotate(tSec * 4.2);
  const bGrad = ctx.createRadialGradient(-boulderR * 0.28, -boulderR * 0.28, 10, 0, 0, boulderR);
  bGrad.addColorStop(0, '#B89B84');
  bGrad.addColorStop(0.65, '#725A4B');
  bGrad.addColorStop(1, '#3B2C26');
  ctx.fillStyle = bGrad;
  ctx.strokeStyle = '#1E1512';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const rad = boulderR * (0.94 + Math.sin(k * 2.7) * 0.06);
    if (k === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
    else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Hand-drawn rock facets
  ctx.strokeStyle = 'rgba(26, 18, 15, 0.55)';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-boulderR * 0.45, -boulderR * 0.2);
  ctx.lineTo(boulderR * 0.12, -boulderR * 0.08);
  ctx.lineTo(boulderR * 0.35, boulderR * 0.35);
  ctx.moveTo(-boulderR * 0.1, boulderR * 0.42);
  ctx.lineTo(boulderR * 0.28, boulderR * 0.14);
  ctx.stroke();
  ctx.restore();

  return {
    groundY: H * 0.78,
    horizonY,
    lampPos: { x: W * 0.78, y: H * 0.24 },
    lightningFlash: 0,
    cameraShakeX: Math.sin(tSec * 48) * shake * 0.7,
    cameraShakeY: Math.cos(tSec * 52) * shake,
    isDark: true,
    hasPuddle: false,
    windX: -2.1,
  };
}

/**
 * Draws foreground atmospheric particles, rain streaks, dandelion fluff, concert crowd & confetti, or dust!
 */
export function drawStorybookWorldForeground(
  ctx: CanvasRenderingContext2D,
  world: StorybookWorldId,
  W: number,
  H: number,
  tSec: number,
  lightningFlash: number
) {
  if (world === 'rainy') {
    ctx.save();
    ctx.strokeStyle = lightningFlash > 0.2 ? 'rgba(235, 245, 255, 0.52)' : 'rgba(214, 232, 255, 0.36)';
    ctx.lineWidth = 1.4;
    for (let r = 0; r < 58; r++) {
      const rx = ((r * 73 + tSec * 210) % (W + 120)) - 60;
      const ry = ((r * 131 + tSec * 720) % (H + 60)) - 30;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - 9, ry + 23);
      ctx.stroke();
    }
    if (lightningFlash > 0.05) {
      ctx.fillStyle = `rgba(220, 235, 255, ${(lightningFlash * 0.16).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  } else if (world === 'meadow') {
    // Drifting golden dandelion fluff & warm sunbeam dust motes!
    ctx.save();
    for (let d = 0; d < 18; d++) {
      const dx = (((W - ((d * 83 + tSec * (54 + (d % 3) * 14)) % (W + 60))) + W + 60) % (W + 60)) - 30;
      const dy = H * 0.22 + ((d * 47) % (H * 0.58)) + Math.sin(tSec * 2.2 + d) * 16;
      ctx.fillStyle = 'rgba(255, 252, 234, 0.78)';
      ctx.beginPath();
      ctx.arc(dx, dy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (world === 'space') {
    // Floating golden stardust sparkles
    ctx.save();
    for (let s = 0; s < 14; s++) {
      const sx = (((s * 109 + tSec * 28) % W) + W) % W;
      const sy = (((s * 67 + Math.sin(tSec * 1.4 + s) * 26) % (H * 0.85)) + H * 0.08);
      const a = 0.35 + 0.55 * Math.abs(Math.sin(tSec * 3.1 + s));
      ctx.fillStyle = `rgba(255, 238, 178, ${a.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (world === 'concert') {
    // Falling multicolored celebration confetti + bouncing cheering foreground crowd silhouettes!
    ctx.save();
    const colors = ['#FF5E9C', '#FFD166', '#4CE0FF', '#A0FF8E', '#FFFFFF'];
    for (let c = 0; c < 34; c++) {
      const cx = (((c * 61 + Math.sin(tSec * 2.3 + c) * 28) % W) + W) % W;
      const cy = ((c * 43 + tSec * (88 + (c % 4) * 18)) % (H + 20)) - 10;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tSec * 4 + c);
      ctx.fillStyle = colors[c % colors.length];
      ctx.fillRect(-4, -2, 8, 4);
      ctx.restore();
    }
    // Bouncing foreground crowd silhouettes at bottom corners (leaves center clear for mood pills!)
    ctx.fillStyle = 'rgba(10, 5, 18, 0.88)';
    for (let p = 0; p < 12; p++) {
      const side = p < 6 ? p * 44 + 14 : W - (p - 6) * 44 - 14;
      const bob = Math.abs(Math.sin(tSec * Math.PI * 2 + p * 0.7)) * 12;
      ctx.beginPath();
      ctx.arc(side, H - 30 - bob, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(side, H - 10 - bob * 0.5, 20, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (world === 'escape') {
    // Dramatic anime/cartoon edge speed lines + flying pebbles!
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 235, 200, 0.22)';
    ctx.lineWidth = 2;
    for (let l = 0; l < 10; l++) {
      const ly = 36 + (l / 9) * (H - 72);
      const len = 40 + ((l * 31 + Math.floor(tSec * 24) * 19) % 70);
      ctx.beginPath();
      ctx.moveTo(W, ly);
      ctx.lineTo(W - len, ly);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 35mm cinema letterbox framing
  ctx.fillStyle = 'rgba(8, 8, 10, 0.85)';
  ctx.fillRect(0, 0, W, 24);
  ctx.fillRect(0, H - 24, W, 24);
}
