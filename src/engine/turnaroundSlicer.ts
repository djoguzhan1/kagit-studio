import type { CharacterViewAngle, RigViewSlot, ViewAnchors, ViewSourceKind } from '../types/masterRig';
import { defaultViewAnchors } from '../types/masterRig';
import { stripPaperBackgroundBfsRGBA } from './characterIntakeEngine';

/**
 * INKTROPE V4 — 5-Line Anchor Calibration, A4 Multi-Pose Turnaround Slicer & Style-Lock Filter.
 *
 * Pure RGBA algorithms run identically in Node/Vitest and Browser Canvas:
 * 1. extractViewAnchorsRGBA: Measures 5 canonical calibration lines (headTop, eyeLine, shoulder, hip, sole)
 *    plus centerU so Front / Side / Back / 3-4 views match to 0.0 px height!
 * 2. alignViewToReferenceRGBA: Scales & translates any secondary view cleanly onto the reference 5-line frame
 *    without blurring or distorting the artist's hand-drawn ink strokes.
 * 3. splitMultiPoseSheetRGBA: Takes ONE A4 paper photo with 2–4 character poses (side-by-side OR 2×2 grid),
 *    strips the paper cleanly, clusters each pose, aligns every angle to 0.0 px with the Front view,
 *    and returns ready-to-rig slots.
 * 4. applyStyleLockFilterRGBA: Locks any optional AI-generated side guide strictly into the artist's
 *    original drawing color palette, ink darkness, and subtle paper tooth (zero plastic AI gloss!).
 */

export interface SlicedPoseRGBA {
  angle: CharacterViewAngle;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  anchors: ViewAnchors;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface MultiPoseSliceResult {
  poses: SlicedPoseRGBA[];
  detectedCount: number;
  layout: 'horizontal' | 'grid2x2' | 'single';
}

/**
 * Extracts the 5 horizontal calibration lines (headTopV, eyeLineV, shoulderV, hipV, soleV)
 * and horizontal center of mass (centerU) from a transparent-background character RGBA buffer.
 */
export function extractViewAnchorsRGBA(
  rgba: Uint8ClampedArray,
  w: number,
  h: number
): ViewAnchors {
  if (w < 8 || h < 8) return defaultViewAnchors();

  let minY = h;
  let maxY = -1;
  let sumX = 0;
  let opaqueCount = 0;
  const rowWidth = new Float32Array(h);
  const rowMinX = new Int32Array(h).fill(w);
  const rowMaxX = new Int32Array(h).fill(-1);

  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    let rMin = w;
    let rMax = -1;
    for (let x = 0; x < w; x++) {
      if (rgba[(rowOff + x) * 4 + 3] > 36) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < rMin) rMin = x;
        if (x > rMax) rMax = x;
        sumX += x;
        opaqueCount++;
      }
    }
    if (rMax >= rMin) {
      rowMinX[y] = rMin;
      rowMaxX[y] = rMax;
      rowWidth[y] = rMax - rMin + 1;
    }
  }

  if (opaqueCount < 16 || maxY <= minY + 4) return defaultViewAnchors();

  const bodyH = Math.max(1, maxY - minY);
  const headTopV = minY / h;
  const soleV = maxY / h;
  const centerU = Math.max(0.12, Math.min(0.88, sumX / (opaqueCount * w)));

  // Neck pinch / shoulder expansion detection in 16%..44% of body height
  let neckRow = Math.round(minY + bodyH * 0.25);
  let minNeckW = Infinity;
  const neckStart = Math.max(minY + 1, Math.round(minY + bodyH * 0.16));
  const neckEnd = Math.min(maxY - 1, Math.round(minY + bodyH * 0.36));
  for (let y = neckStart; y <= neckEnd; y++) {
    if (rowWidth[y] > 0 && rowWidth[y] < minNeckW) {
      minNeckW = rowWidth[y];
      neckRow = y;
    }
  }

  // Shoulder sits just below the neck pinch where width widens out
  let shoulderRow = Math.min(maxY, Math.round(neckRow + bodyH * 0.08));
  let maxShoulderW = 0;
  const shEnd = Math.min(maxY - 1, Math.round(minY + bodyH * 0.44));
  for (let y = neckRow; y <= shEnd; y++) {
    if (rowWidth[y] > maxShoulderW) {
      maxShoulderW = rowWidth[y];
      shoulderRow = y;
    }
  }
  const shoulderV = Math.max(headTopV + 0.14 * (bodyH / h), Math.min(headTopV + 0.44 * (bodyH / h), shoulderRow / h));

  // Eye line sits roughly midway between crown and neck pinch
  const eyeLineV = Math.max(headTopV + 0.05 * (bodyH / h), (minY + (neckRow - minY) * 0.52) / h);

  // Hip/waist line around 55%..66% of body height
  const hipV = (minY + bodyH * 0.59) / h;

  return {
    headTopV,
    eyeLineV,
    shoulderV,
    hipV,
    soleV,
    centerU,
    heightFrac: Math.max(0.1, (maxY - minY) / h),
  };
}

/**
 * Aligns a secondary view (Side / Back / 3-4) onto the exact 5-line vertical & horizontal frame
 * of the Front view so headTopV and soleV match to 0.0 px during 360° 2.5D rotation!
 */
export function alignViewToReferenceRGBA(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  refAnchors: ViewAnchors,
  outW = srcW,
  outH = srcH
): { rgba: Uint8ClampedArray; width: number; height: number; anchors: ViewAnchors } {
  const srcAnchors = extractViewAnchorsRGBA(srcRgba, srcW, srcH);
  const out = new Uint8ClampedArray(outW * outH * 4);

  const srcTopPx = srcAnchors.headTopV * srcH;
  const srcBotPx = srcAnchors.soleV * srcH;
  const srcSpanPx = Math.max(8, srcBotPx - srcTopPx);
  const srcCenterPx = srcAnchors.centerU * srcW;

  const refTopPx = refAnchors.headTopV * outH;
  const refBotPx = refAnchors.soleV * outH;
  const refSpanPx = Math.max(8, refBotPx - refTopPx);
  const refCenterPx = refAnchors.centerU * outW;

  // Uniform isotropic scale so proportions NEVER squash or distort!
  const scale = refSpanPx / srcSpanPx;
  const invScale = 1 / Math.max(0.05, scale);

  // Bilinear sample with crisp alpha handling
  for (let dy = 0; dy < outH; dy++) {
    const sy = srcTopPx + (dy - refTopPx) * invScale;
    if (sy < 0 || sy >= srcH - 1) continue;
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;
    const wy0 = 1 - fy;
    const rowOut = dy * outW;
    const r0 = y0 * srcW;
    const r1 = y1 * srcW;

    for (let dx = 0; dx < outW; dx++) {
      const sx = srcCenterPx + (dx - refCenterPx) * invScale;
      if (sx < 0 || sx >= srcW - 1) continue;
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;
      const wx0 = 1 - fx;

      const i00 = (r0 + x0) * 4;
      const i10 = (r0 + x1) * 4;
      const i01 = (r1 + x0) * 4;
      const i11 = (r1 + x1) * 4;

      const w00 = wx0 * wy0;
      const w10 = fx * wy0;
      const w01 = wx0 * fy;
      const w11 = fx * fy;

      const a00 = srcRgba[i00 + 3];
      const a10 = srcRgba[i10 + 3];
      const a01 = srcRgba[i01 + 3];
      const a11 = srcRgba[i11 + 3];
      const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
      if (a < 8) continue;

      // Premultiplied bilinear interpolation prevents dark/white fringe halos around ink!
      const pa00 = w00 * a00;
      const pa10 = w10 * a10;
      const pa01 = w01 * a01;
      const pa11 = w11 * a11;
      const paSum = Math.max(1e-4, pa00 + pa10 + pa01 + pa11);

      const o = (rowOut + dx) * 4;
      out[o] = Math.round((srcRgba[i00] * pa00 + srcRgba[i10] * pa10 + srcRgba[i01] * pa01 + srcRgba[i11] * pa11) / paSum);
      out[o + 1] = Math.round((srcRgba[i00 + 1] * pa00 + srcRgba[i10 + 1] * pa10 + srcRgba[i01 + 1] * pa01 + srcRgba[i11 + 1] * pa11) / paSum);
      out[o + 2] = Math.round((srcRgba[i00 + 2] * pa00 + srcRgba[i10 + 2] * pa10 + srcRgba[i01 + 2] * pa01 + srcRgba[i11 + 2] * pa11) / paSum);
      out[o + 3] = Math.round(Math.max(0, Math.min(255, a)));
    }
  }

  return {
    rgba: out,
    width: outW,
    height: outH,
    anchors: extractViewAnchorsRGBA(out, outW, outH),
  };
}

/**
 * Splits ONE A4 paper sheet containing 2–4 character poses (side-by-side or 2×2 grid)
 * into clean, transparent, 0.0px height-aligned individual angle slots.
 */
export interface TurnaroundPoseClassification {
  angle: CharacterViewAngle;
  symmetry: number;
  aspectRatio: number;
  protrusionAsym: number;
  faceDetail: number;
  scores: Record<CharacterViewAngle, number>;
}

/**
 * Classifies a cropped character pose into `front` | `threeQuarter` | `side` | `back`
 * by measuring left-right silhouette mirror symmetry, aspect width, unilateral snout/toe
 * protrusion, and interior upper-head facial ink detail.
 */
export function classifyTurnaroundPoseAngleRGBA(
  rgba: Uint8ClampedArray,
  w: number,
  h: number
): TurnaroundPoseClassification {
  const defaultScores: Record<CharacterViewAngle, number> = {
    front: 0.5,
    threeQuarter: 0.4,
    side: 0.3,
    back: 0.3,
  };
  if (w < 8 || h < 8) {
    return {
      angle: 'front',
      symmetry: 1,
      aspectRatio: 0.5,
      protrusionAsym: 0,
      faceDetail: 0,
      scores: defaultScores,
    };
  }

  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  let sumX = 0;
  let opaqueCnt = 0;
  const rowMin = new Int32Array(h).fill(w);
  const rowMax = new Int32Array(h).fill(-1);

  for (let y = 0; y < h; y++) {
    const ro = y * w;
    for (let x = 0; x < w; x++) {
      if (rgba[(ro + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < rowMin[y]) rowMin[y] = x;
        if (x > rowMax[y]) rowMax[y] = x;
        sumX += x;
        opaqueCnt++;
      }
    }
  }

  if (opaqueCnt < 16 || maxY <= minY + 4 || maxX <= minX + 2) {
    return {
      angle: 'front',
      symmetry: 1,
      aspectRatio: 0.5,
      protrusionAsym: 0,
      faceDetail: 0,
      scores: defaultScores,
    };
  }

  const bw = Math.max(1, maxX - minX + 1);
  const bh = Math.max(1, maxY - minY + 1);
  const aspectRatio = bw / bh;
  const cx = sumX / opaqueCnt;

  // 1) Row-by-row mirror IoU around center of mass `cx`
  let symInter = 0;
  let symUnion = 0;
  for (let y = minY; y <= maxY; y++) {
    const ro = y * w;
    for (let x = minX; x <= maxX; x++) {
      const a1 = rgba[(ro + x) * 4 + 3] > 40;
      const mx = Math.round(2 * cx - x);
      const a2 = mx >= 0 && mx < w ? rgba[(ro + mx) * 4 + 3] > 40 : false;
      if (a1 || a2) {
        symUnion++;
        if (a1 && a2) symInter++;
      }
    }
  }
  const symmetry = symUnion > 0 ? symInter / symUnion : 1;

  // 2) Unilateral nose/snout & foot/toe overhang relative to mid-torso spine
  let torsoMidSum = 0;
  let torsoMidCnt = 0;
  const tY0 = Math.round(minY + bh * 0.35);
  const tY1 = Math.round(minY + bh * 0.62);
  for (let y = tY0; y <= tY1; y++) {
    if (rowMax[y] >= rowMin[y]) {
      torsoMidSum += (rowMin[y] + rowMax[y]) * 0.5;
      torsoMidCnt++;
    }
  }
  const spineX = torsoMidCnt > 0 ? torsoMidSum / torsoMidCnt : cx;

  let asymAccum = 0;
  let asymRows = 0;
  const checkBands: Array<[number, number]> = [
    [Math.round(minY + bh * 0.08), Math.round(minY + bh * 0.28)],
    [Math.round(minY + bh * 0.82), maxY],
  ];
  for (const [by0, by1] of checkBands) {
    for (let y = Math.max(minY, by0); y <= Math.min(maxY, by1); y++) {
      if (rowMax[y] < rowMin[y]) continue;
      const extL = Math.max(0, spineX - rowMin[y]);
      const extR = Math.max(0, rowMax[y] - spineX);
      const span = Math.max(1, extL + extR);
      asymAccum += Math.abs(extR - extL) / span;
      asymRows++;
    }
  }
  const protrusionAsym = asymRows > 0 ? asymAccum / asymRows : 0;

  // 3) Interior upper-head facial ink/eye contrast (high in Front / 3-4, near-zero on solid/plain Back)
  const fx0 = Math.max(0, Math.round(cx - bw * 0.18));
  const fx1 = Math.min(w - 1, Math.round(cx + bw * 0.18));
  const fy0 = Math.max(0, Math.round(minY + bh * 0.06));
  const fy1 = Math.min(h - 1, Math.round(minY + bh * 0.23));
  let faceCount = 0;
  let lumSum = 0;
  let lumSqSum = 0;
  let edgeTransitions = 0;
  for (let y = fy0; y <= fy1; y++) {
    const ro = y * w;
    let prevDark: boolean | null = null;
    for (let x = fx0; x <= fx1; x++) {
      const o = (ro + x) * 4;
      if (rgba[o + 3] <= 80) continue;
      const lum = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255;
      lumSum += lum;
      lumSqSum += lum * lum;
      faceCount++;
      const isDark = lum < 0.42;
      if (prevDark !== null && isDark !== prevDark) edgeTransitions++;
      prevDark = isDark;
    }
  }
  const lumVar =
    faceCount > 4 ? Math.max(0, lumSqSum / faceCount - (lumSum / faceCount) * (lumSum / faceCount)) : 0;
  const edgeDensity = faceCount > 4 ? edgeTransitions / faceCount : 0;
  const faceDetail = Math.min(1, Math.sqrt(lumVar) * 1.8 + edgeDensity * 1.4);

  const narrowProfileBoost =
    aspectRatio < 0.38 && protrusionAsym > 0.12
      ? Math.min(0.32, (0.38 - aspectRatio) * 1.1 + protrusionAsym * 0.65)
      : 0;
  const scores: Record<CharacterViewAngle, number> = {
    front:
      symmetry * 0.46 +
      Math.min(1, faceDetail * 1.8) * 0.38 +
      (1 - Math.min(1, protrusionAsym * 1.6)) * 0.16 -
      narrowProfileBoost * 0.75,
    back:
      symmetry * 0.50 +
      (1 - Math.min(1, faceDetail * 1.9)) * 0.36 +
      (1 - Math.min(1, protrusionAsym * 1.5)) * 0.14 -
      narrowProfileBoost * 0.85,
    side:
      (1 - symmetry) * 0.38 +
      Math.min(1, protrusionAsym * 2.2) * 0.38 +
      Math.max(0, 1 - aspectRatio / 0.62) * 0.24 +
      narrowProfileBoost,
    threeQuarter:
      Math.max(0, 1 - Math.abs(symmetry - 0.70) * 2.4) * 0.42 +
      Math.min(1, faceDetail * 1.6) * 0.30 +
      Math.max(0, 1 - Math.abs(protrusionAsym - 0.26) * 2.4) * 0.28,
  };

  let bestAngle: CharacterViewAngle = 'front';
  let bestScore = -Infinity;
  for (const ang of ['front', 'threeQuarter', 'side', 'back'] as CharacterViewAngle[]) {
    if (scores[ang] > bestScore) {
      bestScore = scores[ang];
      bestAngle = ang;
    }
  }

  return {
    angle: bestAngle,
    symmetry,
    aspectRatio,
    protrusionAsym,
    faceDetail,
    scores,
  };
}

function permuteAngles(arr: CharacterViewAngle[]): CharacterViewAngle[][] {
  if (arr.length <= 1) return [arr];
  const out: CharacterViewAngle[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const sub of permuteAngles(rest)) {
      out.push([arr[i], ...sub]);
    }
  }
  return out;
}

export function splitMultiPoseSheetRGBA(
  sheetRgba: Uint8ClampedArray,
  w: number,
  h: number,
  options?: { alreadyTransparent?: boolean; targetSize?: number }
): MultiPoseSliceResult {
  const targetSize = options?.targetSize ?? 384;
  // 1) Strip paper background cleanly unless caller already passed transparent RGBA
  const clean = new Uint8ClampedArray(sheetRgba);
  if (!options?.alreadyTransparent) {
    stripPaperBackgroundBfsRGBA(clean, w, h);
  }

  // 2) Downsample into coarse occupancy grid (~160px max side) to cluster drawings robustly
  const scale = Math.min(1, 160 / Math.max(w, h));
  const gw = Math.max(16, Math.round(w * scale));
  const gh = Math.max(16, Math.round(h * scale));
  const occ = new Uint8Array(gw * gh);

  for (let y = 0; y < gh; y++) {
    const sy0 = Math.floor((y / gh) * h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / gh) * h));
    for (let x = 0; x < gw; x++) {
      const sx0 = Math.floor((x / gw) * w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / gw) * w));
      let hit = false;
      for (let sy = sy0; sy < sy1 && !hit; sy++) {
        const ro = sy * w;
        for (let sx = sx0; sx < sx1; sx++) {
          if (clean[(ro + sx) * 4 + 3] > 40) {
            hit = true;
            break;
          }
        }
      }
      if (hit) occ[y * gw + x] = 1;
    }
  }

  // Dilate by 2 coarse cells (~1.2% of page) so close hats/antennas stay attached to their own pose
  // without merging separate drawings across the gap between poses!
  const dil = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!occ[y * gw + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= gw) continue;
          dil[ny * gw + nx] = 1;
        }
      }
    }
  }

  // Connected components on dilated grid
  const compId = new Int32Array(gw * gh).fill(-1);
  interface CompBox {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    count: number;
  }
  const boxes: CompBox[] = [];
  const queue = new Int32Array(gw * gh);

  for (let i = 0; i < gw * gh; i++) {
    if (!dil[i] || compId[i] !== -1) continue;
    const id = boxes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    compId[i] = id;
    let minX = gw;
    let maxX = 0;
    let minY = gh;
    let maxY = 0;
    let count = 0;

    while (head < tail) {
      const idx = queue[head++];
      const cx = idx % gw;
      const cy = (idx - cx) / gw;
      if (occ[idx]) count++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      if (cx > 0 && dil[idx - 1] && compId[idx - 1] === -1) {
        compId[idx - 1] = id;
        queue[tail++] = idx - 1;
      }
      if (cx + 1 < gw && dil[idx + 1] && compId[idx + 1] === -1) {
        compId[idx + 1] = id;
        queue[tail++] = idx + 1;
      }
      if (cy > 0 && dil[idx - gw] && compId[idx - gw] === -1) {
        compId[idx - gw] = id;
        queue[tail++] = idx - gw;
      }
      if (cy + 1 < gh && dil[idx + gw] && compId[idx + gw] === -1) {
        compId[idx + gw] = id;
        queue[tail++] = idx + gw;
      }
    }
    if (count > 0) boxes.push({ minX, maxX, minY, maxY, count });
  }

  if (boxes.length === 0) {
    return { poses: [], detectedCount: 0, layout: 'single' };
  }

  // Keep substantial character clusters (>= 12% of largest cluster) & cap at 4 views
  boxes.sort((a, b) => b.count - a.count);
  const peakCount = boxes[0].count;
  const kept = boxes
    .filter((b) => b.count >= Math.max(12, peakCount * 0.14))
    .slice(0, 4);

  // Detect 2x2 grid vs horizontal strip layout
  const cyVals = kept.map((b) => (b.minY + b.maxY) * 0.5);
  const minCy = Math.min(...cyVals);
  const maxCy = Math.max(...cyVals);
  const isGrid2x2 = kept.length >= 3 && maxCy - minCy > gh * 0.30;

  if (isGrid2x2) {
    const midY = (minCy + maxCy) * 0.5;
    kept.sort((a, b) => {
      const rowA = (a.minY + a.maxY) * 0.5 < midY ? 0 : 1;
      const rowB = (b.minY + b.maxY) * 0.5 < midY ? 0 : 1;
      if (rowA !== rowB) return rowA - rowB;
      return a.minX - b.minX;
    });
  } else {
    kept.sort((a, b) => a.minX - b.minX);
  }

  const angleMapping: CharacterViewAngle[] =
    kept.length === 1
      ? ['front']
      : kept.length === 2
        ? ['front', 'side']
        : kept.length === 3
          ? ['front', 'side', 'back']
          : ['front', 'threeQuarter', 'side', 'back'];

  const rawSlots: Array<{
    angle: CharacterViewAngle;
    rgba: Uint8ClampedArray;
    w: number;
    h: number;
    bbox: { x: number; y: number; w: number; h: number };
  }> = [];

  for (let i = 0; i < kept.length; i++) {
    const b = kept[i];
    const padX = Math.max(4, Math.round((w / gw) * 1.5));
    const padY = Math.max(4, Math.round((h / gh) * 1.5));
    const x0 = Math.max(0, Math.floor((b.minX / gw) * w) - padX);
    const y0 = Math.max(0, Math.floor((b.minY / gh) * h) - padY);
    const x1 = Math.min(w - 1, Math.ceil(((b.maxX + 1) / gw) * w) + padX);
    const y1 = Math.min(h - 1, Math.ceil(((b.maxY + 1) / gh) * h) + padY);
    const cw = Math.max(8, x1 - x0 + 1);
    const ch = Math.max(8, y1 - y0 + 1);

    const crop = new Uint8ClampedArray(cw * ch * 4);
    for (let cy = 0; cy < ch; cy++) {
      const srcOff = ((y0 + cy) * w + x0) * 4;
      const dstOff = cy * cw * 4;
      crop.set(clean.subarray(srcOff, srcOff + cw * 4), dstOff);
    }

    rawSlots.push({
      angle: angleMapping[i],
      rgba: crop,
      w: cw,
      h: ch,
      bbox: { x: x0, y: y0, w: cw, h: ch },
    });
  }

  // Auto-classify each sliced pose's view angle via silhouette symmetry, nose/foot protrusion & face ink detail
  // whenever the sheet poses exhibit genuine visual view variation (preserving sheet reading order on identical silhouettes).
  if (rawSlots.length >= 2) {
    const cls = rawSlots.map((s) => classifyTurnaroundPoseAngleRGBA(s.rgba, s.w, s.h));
    const syms = cls.map((c) => c.symmetry);
    const faces = cls.map((c) => c.faceDetail);
    const ars = cls.map((c) => c.aspectRatio);
    const prots = cls.map((c) => c.protrusionAsym);
    const hasVisualDifferentiation =
      Math.max(...syms) - Math.min(...syms) > 0.12 ||
      Math.max(...faces) - Math.min(...faces) > 0.08 ||
      Math.max(...ars) - Math.min(...ars) > 0.10 ||
      Math.max(...prots) - Math.min(...prots) > 0.10;

    if (hasVisualDifferentiation) {
      const perms = permuteAngles(angleMapping);
      let bestPerm = angleMapping;
      let bestTotal = -Infinity;
      for (const perm of perms) {
        let total = 0;
        for (let i = 0; i < perm.length; i++) {
          total += cls[i].scores[perm[i]] + (perm[i] === angleMapping[i] ? 0.06 : 0);
        }
        if (total > bestTotal) {
          bestTotal = total;
          bestPerm = perm;
        }
      }
      for (let i = 0; i < rawSlots.length; i++) {
        rawSlots[i].angle = bestPerm[i];
      }
    }
  }

  // Normalize the Front slot first into clean square targetSize canvas with 8% margin,
  // then align EVERY other slot strictly to Front's 5-line anchors (0.0 px match)!
  const canonicalRefAnchors: ViewAnchors = {
    headTopV: 0.08,
    eyeLineV: 0.19,
    shoulderV: 0.34,
    hipV: 0.60,
    soleV: 0.92,
    centerU: 0.5,
    heightFrac: 0.84,
  };

  const frontIdx = Math.max(
    0,
    rawSlots.findIndex((s) => s.angle === 'front')
  );
  const frontAligned = alignViewToReferenceRGBA(
    rawSlots[frontIdx].rgba,
    rawSlots[frontIdx].w,
    rawSlots[frontIdx].h,
    canonicalRefAnchors,
    targetSize,
    targetSize
  );

  const poses: SlicedPoseRGBA[] = [];
  for (let i = 0; i < rawSlots.length; i++) {
    if (i === frontIdx) {
      poses.push({
        angle: rawSlots[i].angle,
        rgba: frontAligned.rgba,
        width: frontAligned.width,
        height: frontAligned.height,
        anchors: frontAligned.anchors,
        bbox: rawSlots[i].bbox,
      });
    } else {
      const aligned = alignViewToReferenceRGBA(
        rawSlots[i].rgba,
        rawSlots[i].w,
        rawSlots[i].h,
        frontAligned.anchors,
        targetSize,
        targetSize
      );
      poses.push({
        angle: rawSlots[i].angle,
        rgba: aligned.rgba,
        width: aligned.width,
        height: aligned.height,
        anchors: aligned.anchors,
        bbox: rawSlots[i].bbox,
      });
    }
  }

  return {
    poses,
    detectedCount: poses.length,
    layout: kept.length <= 1 ? 'single' : isGrid2x2 ? 'grid2x2' : 'horizontal',
  };
}

/**
 * Style-Lock Filter: Quantizes and harmonizes an optional AI-generated side guide
 * strictly to the artist's original drawing palette, ink darkness, and subtle paper grain
 * so it NEVER looks like glossy synthetic AI art beside the real hand-drawn front view!
 */
export function applyStyleLockFilterRGBA(
  aiRgba: Uint8ClampedArray,
  aiW: number,
  aiH: number,
  refRgba: Uint8ClampedArray,
  refW: number,
  refH: number,
  strength = 0.78
): Uint8ClampedArray {
  // 1) Extract compact representative palette (up to 28 quantized color buckets) from artist's Front drawing
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let darkestLuma = 255;
  let darkestR = 24;
  let darkestG = 24;
  let darkestB = 26;
  const refStep = Math.max(1, Math.floor((refW * refH) / 6000));

  for (let i = 0; i < refW * refH; i += refStep) {
    const o = i * 4;
    if (refRgba[o + 3] < 80) continue;
    const r = refRgba[o];
    const g = refRgba[o + 1];
    const b = refRgba[o + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luma < darkestLuma) {
      darkestLuma = luma;
      darkestR = r;
      darkestG = g;
      darkestB = b;
    }
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key);
    if (cur) {
      cur.r += r;
      cur.g += g;
      cur.b += b;
      cur.n++;
    } else {
      buckets.set(key, { r, g, b, n: 1 });
    }
  }

  const palette = Array.from(buckets.values())
    .sort((a, b) => b.n - a.n)
    .slice(0, 28)
    .map((c) => ({
      r: c.r / c.n,
      g: c.g / c.n,
      b: c.b / c.n,
    }));

  if (palette.length === 0) {
    return new Uint8ClampedArray(aiRgba);
  }

  // Ensure the artist's real ink color is always in the palette
  palette.push({ r: darkestR, g: darkestG, b: darkestB });

  const out = new Uint8ClampedArray(aiRgba.length);
  const blend = Math.max(0, Math.min(1, strength));
  const keep = 1 - blend;

  for (let y = 0; y < aiH; y++) {
    const row = y * aiW;
    for (let x = 0; x < aiW; x++) {
      const o = (row + x) * 4;
      const a = aiRgba[o + 3];
      if (a < 16) continue;
      const r = aiRgba[o];
      const g = aiRgba[o + 1];
      const b = aiRgba[o + 2];

      let bestIdx = 0;
      let bestDist = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const dr = r - palette[p].r;
        const dg = g - palette[p].g;
        const db = b - palette[p].b;
        const d = dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = p;
        }
      }

      const target = palette[bestIdx];
      // Deterministic organic paper-tooth grain (±3.5 levels) removes AI smooth plastic sheen
      const hash = (((x * 374761393 + y * 668265263) ^ 0x5bf03635) >>> 0) % 256;
      const grain = ((hash / 255) - 0.5) * 7.0;

      out[o] = Math.max(0, Math.min(255, Math.round(r * keep + target.r * blend + grain)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(g * keep + target.g * blend + grain)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(b * keep + target.b * blend + grain)));
      out[o + 3] = a;
    }
  }

  return out;
}

// ============================================================================
// BROWSER CANVAS CONVENIENCE HELPERS
// ============================================================================

export function rgbaToCanvas(rgba: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(w, h);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

export function extractViewAnchorsFromCanvas(canvas: HTMLCanvasElement): ViewAnchors {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width < 8 || canvas.height < 8) return defaultViewAnchors();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return extractViewAnchorsRGBA(data, canvas.width, canvas.height);
}

export function alignViewCanvasToReference(
  srcCanvas: HTMLCanvasElement,
  refAnchors: ViewAnchors,
  angle: CharacterViewAngle,
  source: ViewSourceKind,
  outSize = 512
): RigViewSlot {
  const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return {
      angle,
      dataUrl: srcCanvas.toDataURL('image/png'),
      source,
      anchors: refAnchors,
      width: srcCanvas.width,
      height: srcCanvas.height,
      createdAt: Date.now(),
    };
  }
  const srcData = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height).data;
  const aligned = alignViewToReferenceRGBA(
    srcData,
    srcCanvas.width,
    srcCanvas.height,
    refAnchors,
    outSize,
    outSize
  );
  const outCanvas = rgbaToCanvas(aligned.rgba, aligned.width, aligned.height);
  return {
    angle,
    dataUrl: outCanvas.toDataURL('image/png'),
    source,
    anchors: aligned.anchors,
    width: aligned.width,
    height: aligned.height,
    createdAt: Date.now(),
  };
}

export function applyStyleLockToCanvas(
  aiCanvas: HTMLCanvasElement,
  refCanvas: HTMLCanvasElement,
  strength = 0.78
): HTMLCanvasElement {
  const aiCtx = aiCanvas.getContext('2d', { willReadFrequently: true });
  const refCtx = refCanvas.getContext('2d', { willReadFrequently: true });
  if (!aiCtx || !refCtx) return aiCanvas;
  const aiData = aiCtx.getImageData(0, 0, aiCanvas.width, aiCanvas.height).data;
  const refData = refCtx.getImageData(0, 0, refCanvas.width, refCanvas.height).data;
  const locked = applyStyleLockFilterRGBA(
    aiData,
    aiCanvas.width,
    aiCanvas.height,
    refData,
    refCanvas.width,
    refCanvas.height,
    strength
  );
  return rgbaToCanvas(locked, aiCanvas.width, aiCanvas.height);
}

export function splitMultiPoseSheetCanvas(
  sheetCanvas: HTMLCanvasElement,
  targetSize = 512
): { slots: RigViewSlot[]; layout: MultiPoseSliceResult['layout'] } {
  const ctx = sheetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { slots: [], layout: 'single' };
  const data = ctx.getImageData(0, 0, sheetCanvas.width, sheetCanvas.height).data;
  const res = splitMultiPoseSheetRGBA(data, sheetCanvas.width, sheetCanvas.height, { targetSize });
  const now = Date.now();
  const slots: RigViewSlot[] = res.poses.map((p) => {
    const c = rgbaToCanvas(p.rgba, p.width, p.height);
    return {
      angle: p.angle,
      dataUrl: c.toDataURL('image/png'),
      source: 'multi_pose_sheet',
      anchors: p.anchors,
      width: p.width,
      height: p.height,
      createdAt: now,
    };
  });
  return { slots, layout: res.layout };
}

const CANONICAL_ANGLE_ORDER: CharacterViewAngle[] = ['front', 'side', 'back', 'threeQuarter'];

function normalizeTrFileHint(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .replace(/ç/g, 'c');
}

function detectAngleHintFromName(name?: string): CharacterViewAngle | null {
  if (!name) return null;
  const stem = normalizeTrFileHint(name);
  if (/(^|[^a-z0-9])(3-4|3_4|34|three|quarter|capraz|45deg|45)([^a-z0-9]|$)/.test(stem)) {
    return 'threeQuarter';
  }
  if (/(^|[^a-z0-9])(back|arka|rear|180deg|180)([^a-z0-9]|$)/.test(stem)) {
    return 'back';
  }
  if (/(^|[^a-z0-9])(side|yan|profil|profile|sol|sag|left|right|90deg|90)([^a-z0-9]|$)/.test(stem)) {
    return 'side';
  }
  if (/(^|[^a-z0-9])(front|on|face|0deg)([^a-z0-9]|$)/.test(stem)) {
    return 'front';
  }
  return null;
}

/**
 * Maps 1..4 user-selected image files to canonical 2.5D character angles
 * (front / side / back / threeQuarter) using Turkish/English filename hints first,
 * then filling remaining open slots cleanly in natural selection order.
 */
export function assignItemsToViewAngles<T extends { name?: string }>(
  items: T[],
  options?: { requireFront?: boolean; preferEmptyAngles?: CharacterViewAngle[] }
): Array<{ angle: CharacterViewAngle; item: T }> {
  const capped = items.slice(0, 4);
  if (capped.length === 0) return [];
  const requireFront = options?.requireFront ?? true;
  const fallbackOrder =
    options?.preferEmptyAngles && options.preferEmptyAngles.length > 0
      ? [...options.preferEmptyAngles, ...CANONICAL_ANGLE_ORDER.filter((a) => !options.preferEmptyAngles!.includes(a))]
      : CANONICAL_ANGLE_ORDER;

  const assigned = new Map<CharacterViewAngle, T>();
  const leftovers: T[] = [];

  for (const item of capped) {
    const hint = detectAngleHintFromName(item.name);
    if (hint && !assigned.has(hint)) {
      assigned.set(hint, item);
    } else {
      leftovers.push(item);
    }
  }

  for (const item of leftovers) {
    const nextAngle = fallbackOrder.find((a) => !assigned.has(a));
    if (nextAngle) assigned.set(nextAngle, item);
  }

  // Ensure front is always populated when creating a brand-new multi-view rig
  if (requireFront && !assigned.has('front') && assigned.size > 0) {
    const firstKey = Array.from(assigned.keys())[0];
    const firstItem = assigned.get(firstKey)!;
    assigned.delete(firstKey);
    assigned.set('front', firstItem);
  }

  const out: Array<{ angle: CharacterViewAngle; item: T }> = [];
  for (const angle of CANONICAL_ANGLE_ORDER) {
    const item = assigned.get(angle);
    if (item) out.push({ angle, item });
  }
  return out;
}
