/**
 * INKTROPE V3/V4 Full-Resolution Multi-Bone Directional & Texture-Preserving Socket Inpainting Engine
 * ---------------------------------------------------------------------------------------------------
 * Zero-blockiness, pattern-preserving socket backing behind shoulder (`2, 3 -> chest bone 1`),
 * hip/crotch (`4, 5 -> pelvis bone 0`), and collar/neck (`0 -> neck bone 12 / chest bone 1`)
 * articulation seams. Emits BOTH the unified `socketOnlyRgba` buffer AND tight per-bone cropped
 * `subPatches` so S-spine leans keep shoulder, crotch, and neck sockets locked within < 0.01 px!
 */

export type SocketBoneRole = 'pelvis' | 'chest' | 'neck';

export interface SocketSubPatch {
  role: SocketBoneRole;
  /** Canonical anatomical parent bone index (0: pelvis, 1: chest, 12: neck) */
  boneIndex: number;
  /** Tight cropped source rectangle in [0..srcW, 0..srcH] */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cropped w * h * 4 RGBA buffer containing strictly this bone's socket pixels */
  rgba: Uint8ClampedArray;
  pixelCount: number;
}

export interface SocketInpaintResult {
  /** Unified transparent-except-socket patch RGBA (preserved for full backward compatibility) */
  socketOnlyRgba: Uint8ClampedArray;
  /** Tightly cropped multi-bone socket patches bound individually to pelvis(0), chest(1), neck(12) */
  subPatches: SocketSubPatch[];
  /** Number of pixels seamlessly filled behind occlusion sockets */
  inpaintedPixels: number;
  /** Breakdown of filled pixels by joint family for diagnostics & tests */
  armPixels: number;
  legPixels: number;
  neckPixels: number;
}

function smoothstep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Synthesizes native-resolution (`srcW × srcH`) directional torso-colored socket backing patches
 * behind limb & neck articulation seams (`arm_l=2, arm_r=3 -> chest[1]`, `leg_l=4, leg_r=5 -> pelvis[0]`,
 * `head/neck=0 -> neck[12]`) strictly within `marginPx` of torso (`reg === 1`), preserving horizontal
 * fabric stripes on shoulders and vertical fabric continuity on hips/collar while avoiding dark outline bleed!
 */
export function inpaintBehindLimbSocketsRGBA(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  topoRegion: Int8Array,
  topoOp: Uint8Array,
  topoW: number,
  topoH: number,
  marginPx = 14
): SocketInpaintResult {
  const socketOnly = new Uint8ClampedArray(srcRgba.length);
  if (srcW < 16 || srcH < 16 || topoW < 8 || topoH < 8) {
    return {
      socketOnlyRgba: socketOnly,
      subPatches: [],
      inpaintedPixels: 0,
      armPixels: 0,
      legPixels: 0,
      neckPixels: 0,
    };
  }

  const N = srcW * srcH;

  // 1. Estimate average torso luminance from interior torso pixels to reject dark ink outlines when bright fill exists
  let torsoLumSum = 0;
  let torsoCnt = 0;
  for (let ty = 0; ty < topoH; ty++) {
    const sy = Math.min(srcH - 1, Math.floor(((ty + 0.5) * srcH) / topoH));
    for (let tx = 0; tx < topoW; tx++) {
      const idx = ty * topoW + tx;
      if (!topoOp[idx] || topoRegion[idx] !== 1) continue;
      const sx = Math.min(srcW - 1, Math.floor(((tx + 0.5) * srcW) / topoW));
      const o = (sy * srcW + sx) * 4;
      if (srcRgba[o + 3] < 48) continue;
      const lum = 0.299 * srcRgba[o] + 0.587 * srcRgba[o + 1] + 0.114 * srcRgba[o + 2];
      torsoLumSum += lum;
      torsoCnt++;
    }
  }
  if (torsoCnt < 8) {
    return {
      socketOnlyRgba: socketOnly,
      subPatches: [],
      inpaintedPixels: 0,
      armPixels: 0,
      legPixels: 0,
      neckPixels: 0,
    };
  }

  const avgTorsoLum = torsoLumSum / torsoCnt;
  const darkInkCutoff = avgTorsoLum > 92 ? Math.min(82, avgTorsoLum * 0.55) : -1;

  // 2. Map every full-res pixel to its smooth region & identify clean interior torso seeds
  const pxReg = new Int8Array(N).fill(-1);
  const isSeed = new Uint8Array(N);
  const seedR = new Float32Array(N);
  const seedG = new Float32Array(N);
  const seedB = new Float32Array(N);
  let seedCount = 0;

  for (let y = 0; y < srcH; y++) {
    const fy = ((y + 0.5) * topoH) / srcH - 0.5;
    const ty = Math.max(0, Math.min(topoH - 1, Math.round(fy)));
    const row = y * srcW;
    const tRow = ty * topoW;
    for (let x = 0; x < srcW; x++) {
      const i = row + x;
      const o = i * 4;
      if (srcRgba[o + 3] < 24) continue;
      const fx = ((x + 0.5) * topoW) / srcW - 0.5;
      const tx = Math.max(0, Math.min(topoW - 1, Math.round(fx)));
      const ti = tRow + tx;
      if (!topoOp[ti]) continue;
      const reg = topoRegion[ti];
      pxReg[i] = reg;

      if (reg === 1) {
        const r = srcRgba[o];
        const g = srcRgba[o + 1];
        const b = srcRgba[o + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (darkInkCutoff <= 0 || lum >= darkInkCutoff) {
          isSeed[i] = 1;
          seedR[i] = r;
          seedG[i] = g;
          seedB[i] = b;
          seedCount++;
        }
      }
    }
  }

  // Fallback for pure black torso characters (e.g. Baron's black tuxedo coat)
  if (seedCount < 16) {
    for (let i = 0; i < N; i++) {
      if (pxReg[i] !== 1) continue;
      const o = i * 4;
      isSeed[i] = 1;
      seedR[i] = srcRgba[o];
      seedG[i] = srcRgba[o + 1];
      seedB[i] = srcRgba[o + 2];
      seedCount++;
    }
  }

  const armMargin = Math.max(4, Math.round(marginPx));
  const legMargin = Math.max(3, Math.min(10, Math.round(marginPx * 0.68)));
  const neckMargin = Math.max(3, Math.min(8, Math.round(marginPx * 0.55)));
  const maxBand = Math.max(armMargin, legMargin, neckMargin) + 3;

  const distPx = new Float32Array(N).fill(1e6);
  const colR = new Float32Array(N);
  const colG = new Float32Array(N);
  const colB = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    if (isSeed[i]) {
      distPx[i] = 0;
      colR[i] = seedR[i];
      colG[i] = seedG[i];
      colB[i] = seedB[i];
    }
  }

  const canPropagateInto = (reg: number): boolean =>
    reg === 1 || reg === 2 || reg === 3 || reg === 4 || reg === 5 || reg === 0;

  // Pass A: Left-to-right & right-to-left horizontal scanline continuation
  for (let y = 0; y < srcH; y++) {
    const row = y * srcW;
    for (let x = 1; x < srcW; x++) {
      const i = row + x;
      if (!canPropagateInto(pxReg[i])) continue;
      const prev = i - 1;
      const nd = distPx[prev] + 1;
      if (nd <= maxBand && nd < distPx[i]) {
        distPx[i] = nd;
        colR[i] = colR[prev];
        colG[i] = colG[prev];
        colB[i] = colB[prev];
      }
    }
    for (let x = srcW - 2; x >= 0; x--) {
      const i = row + x;
      if (!canPropagateInto(pxReg[i])) continue;
      const next = i + 1;
      const nd = distPx[next] + 1;
      if (nd <= maxBand && nd < distPx[i]) {
        distPx[i] = nd;
        colR[i] = colR[next];
        colG[i] = colG[next];
        colB[i] = colB[next];
      }
    }
  }

  // Pass B: Top-to-bottom & bottom-to-top vertical continuation
  for (let x = 0; x < srcW; x++) {
    for (let y = 1; y < srcH; y++) {
      const i = y * srcW + x;
      if (!canPropagateInto(pxReg[i])) continue;
      const up = i - srcW;
      const nd = distPx[up] + 1;
      if (nd <= maxBand && nd < distPx[i]) {
        distPx[i] = nd;
        colR[i] = colR[up];
        colG[i] = colG[up];
        colB[i] = colB[up];
      }
    }
    for (let y = srcH - 2; y >= 0; y--) {
      const i = y * srcW + x;
      if (!canPropagateInto(pxReg[i])) continue;
      const dn = i + srcW;
      const nd = distPx[dn] + 1;
      if (nd <= maxBand && nd < distPx[i]) {
        distPx[i] = nd;
        colR[i] = colR[dn];
        colG[i] = colG[dn];
        colB[i] = colB[dn];
      }
    }
  }

  let inpaintedPixels = 0;
  let armPixels = 0;
  let legPixels = 0;
  let neckPixels = 0;

  // Compute torso vertical span so arm sockets ONLY fill around the upper shoulder ball-joint (never along lower waist/ribs!)
  let torsoTopY = srcH;
  let torsoBotY = 0;
  for (let y = 0; y < srcH; y++) {
    const row = y * srcW;
    for (let x = 0; x < srcW; x++) {
      if (pxReg[row + x] === 1) {
        if (y < torsoTopY) torsoTopY = y;
        if (y > torsoBotY) torsoBotY = y;
      }
    }
  }
  const torsoSpanY = Math.max(16, torsoBotY - torsoTopY);
  const armShoulderFadeStart = torsoTopY + torsoSpanY * 0.28;
  const armShoulderMaxY = torsoTopY + torsoSpanY * 0.44;
  const legHipMaxY = torsoBotY + torsoSpanY * 0.28;

  // Per-bone bounding boxes: 0=pelvis (legs 4,5), 1=chest (arms 2,3), 2=neck (head 0)
  const minX = [srcW, srcW, srcW];
  const maxX = [-1, -1, -1];
  const minY = [srcH, srcH, srcH];
  const maxY = [-1, -1, -1];
  const pixelRole = new Int8Array(N).fill(-1);

  for (let y = 0; y < srcH; y++) {
    const row = y * srcW;
    for (let x = 0; x < srcW; x++) {
      const i = row + x;
      const reg = pxReg[i];
      if (reg !== 2 && reg !== 3 && reg !== 4 && reg !== 5 && reg !== 0) continue;
      if ((reg === 2 || reg === 3) && y > armShoulderMaxY) continue;
      if ((reg === 4 || reg === 5) && y > legHipMaxY) continue;

      const d = distPx[i];
      const maxD = reg === 2 || reg === 3 ? armMargin : reg === 4 || reg === 5 ? legMargin : neckMargin;
      if (d > maxD) continue;

      let bandAtten = 1.0;
      if ((reg === 2 || reg === 3) && y > armShoulderFadeStart) {
        bandAtten = smoothstep01(1 - (y - armShoulderFadeStart) / Math.max(4, armShoulderMaxY - armShoulderFadeStart));
      }
      const tNorm = 1 - d / (maxD + 0.75);
      const alpha = Math.round(255 * Math.min(1, smoothstep01(tNorm) * 1.28) * bandAtten);
      if (alpha < 10) continue;

      let rSum = colR[i] * 0.68;
      let gSum = colG[i] * 0.68;
      let bSum = colB[i] * 0.68;
      let wSum = 0.68;
      if (y > 0 && distPx[i - srcW] <= maxD + 2) {
        rSum += colR[i - srcW] * 0.16;
        gSum += colG[i - srcW] * 0.16;
        bSum += colB[i - srcW] * 0.16;
        wSum += 0.16;
      }
      if (y + 1 < srcH && distPx[i + srcW] <= maxD + 2) {
        rSum += colR[i + srcW] * 0.16;
        gSum += colG[i + srcW] * 0.16;
        bSum += colB[i + srcW] * 0.16;
        wSum += 0.16;
      }

      const o = i * 4;
      socketOnly[o] = Math.max(0, Math.min(255, Math.round(rSum / wSum)));
      socketOnly[o + 1] = Math.max(0, Math.min(255, Math.round(gSum / wSum)));
      socketOnly[o + 2] = Math.max(0, Math.min(255, Math.round(bSum / wSum)));
      socketOnly[o + 3] = alpha;

      inpaintedPixels++;
      let bucket = 1;
      if (reg === 2 || reg === 3) {
        armPixels++;
        bucket = 1;
      } else if (reg === 4 || reg === 5) {
        legPixels++;
        bucket = 0;
      } else {
        neckPixels++;
        bucket = 2;
      }
      pixelRole[i] = bucket;
      if (x < minX[bucket]) minX[bucket] = x;
      if (x > maxX[bucket]) maxX[bucket] = x;
      if (y < minY[bucket]) minY[bucket] = y;
      if (y > maxY[bucket]) maxY[bucket] = y;
    }
  }

  const subPatches: SocketSubPatch[] = [];
  const roleDefs: Array<{ bucket: number; role: SocketBoneRole; boneIndex: number }> = [
    { bucket: 0, role: 'pelvis', boneIndex: 0 },
    { bucket: 1, role: 'chest', boneIndex: 1 },
    { bucket: 2, role: 'neck', boneIndex: 12 },
  ];

  for (const def of roleDefs) {
    const b = def.bucket;
    if (maxX[b] < minX[b] || maxY[b] < minY[b]) continue;
    const x0 = Math.max(0, minX[b] - 1);
    const y0 = Math.max(0, minY[b] - 1);
    const x1 = Math.min(srcW - 1, maxX[b] + 1);
    const y1 = Math.min(srcH - 1, maxY[b] + 1);
    const pw = x1 - x0 + 1;
    const ph = y1 - y0 + 1;
    const subRgba = new Uint8ClampedArray(pw * ph * 4);
    let cnt = 0;
    for (let sy = y0; sy <= y1; sy++) {
      const srcRow = sy * srcW;
      const dstRow = (sy - y0) * pw;
      for (let sx = x0; sx <= x1; sx++) {
        const si = srcRow + sx;
        if (pixelRole[si] !== b) continue;
        const so = si * 4;
        const doff = (dstRow + (sx - x0)) * 4;
        subRgba[doff] = socketOnly[so];
        subRgba[doff + 1] = socketOnly[so + 1];
        subRgba[doff + 2] = socketOnly[so + 2];
        subRgba[doff + 3] = socketOnly[so + 3];
        cnt++;
      }
    }
    if (cnt > 0) {
      subPatches.push({
        role: def.role,
        boneIndex: def.boneIndex,
        x: x0,
        y: y0,
        w: pw,
        h: ph,
        rgba: subRgba,
        pixelCount: cnt,
      });
    }
  }

  return { socketOnlyRgba: socketOnly, subPatches, inpaintedPixels, armPixels, legPixels, neckPixels };
}
