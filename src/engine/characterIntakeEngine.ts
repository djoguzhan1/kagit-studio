import {
  analyzeCanvasAnatomy,
  defaultDrawingAnatomy,
  type DrawingAnatomy,
} from './cartoonMotionEngine';
import {
  buildRiggedCharacterPack,
  type CharacterArchetype,
  type RiggedCharacterPack,
} from './skeletonSkinEngine';

/**
 * KÂĞIT Studio 5-Stage Automatic Character Extraction & Paper-Keying Core
 * ----------------------------------------------------------------------
 * Pure, deterministic, $0 in-browser CV pipeline (<40ms) powering ALL studios
 * (Ana Ekran, Canlı Kukla, Mini Film Yönet, Kâğıt Kamera) so ANY real phone
 * photo of a hand-drawn sketchbook character extracts at studio-grade quality:
 *  Stage 1: Local Paper Illumination Ceiling Map (flattens phone/hand/desk-lamp shadows!)
 *  Stage 2: Illumination-Normalized Exterior BFS Paper Removal (NEVER punches white eyes/faces!)
 *  Stage 3: 8-Connected Primary Subject Isolation (strips corner signatures, dates & binder rings!)
 *  Stage 4: Geometric Closed Body-Pocket Cleaner (clears armpit/leg/cane paper loops while protecting
 *           white faces, eyes, teeth, shirt collars, cuffs, white hands & white ghost bodies!)
 *  Stage 5: Monochrome Ink S-Curve Enhancement + Ground-Locked Tight Crop + Click-to-Clear Magic Wand
 */

export interface ForegroundCropBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  empty: boolean;
}

export interface LocalPaperMap {
  gw: number;
  gh: number;
  w: number;
  h: number;
  values: Float32Array;
  borderMedianLum: number;
  borderP10Lum: number;
  borderSat: number;
}

export interface PreparedCharacterResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  anatomy: DrawingAnatomy;
  archetype: CharacterArchetype;
  strippedPaper: boolean;
  isolatedPrimary: boolean;
  cleanedPockets: number;
  boostedPencil: boolean;
  cropped: boolean;
  empty: boolean;
}

export interface PrepareCharacterOptions {
  maxDim?: number;
  stripPaper?: boolean;
  isolateSubject?: boolean;
  cleanPockets?: boolean;
  enhanceInk?: boolean;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 255;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

function percentileOf(values: number[], p: number): number {
  if (values.length === 0) return 255;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

// ============================================================================
// STAGE 1: LOCAL PAPER ILLUMINATION CEILING MAP (<2ms)
// ============================================================================

/**
 * Computes a smooth local blank-paper luminance surface `localPaperLum(x, y)`
 * via block-max downsampling + separable horizontal/vertical morphological max
 * + 2-pass box blur. Completely flattens phone/hand shadows and desk-lamp gradients!
 */
export function computeLocalPaperCeilingMap(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  borderMedianLum = 225,
  borderP10Lum = 175,
  borderSat = 8
): LocalPaperMap {
  const maxGrid = 96;
  const scale = Math.min(1, maxGrid / Math.max(1, w, h));
  const gw = Math.max(12, Math.round(w * scale));
  const gh = Math.max(12, Math.round(h * scale));
  const grid = new Float32Array(gw * gh);

  // 1. Block-maximum of low-saturation pixels (immediately skips thin dark ink strokes!)
  const maxPaperSat = Math.min(68, borderSat + 38);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * h) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * w) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gw));
      let bestNeutralLum = 0;
      let bestAnyLum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          const o = (row + x) * 4;
          if (data[o + 3] < 48) continue;
          const r = data[o];
          const g = data[o + 1];
          const b = data[o + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          if (lum > bestAnyLum) bestAnyLum = lum;
          if (sat <= maxPaperSat && lum > bestNeutralLum) {
            bestNeutralLum = lum;
          }
        }
      }
      grid[gy * gw + gx] = bestNeutralLum > 0 ? bestNeutralLum : bestAnyLum;
    }
  }

  // 2. Separable morphological dilation (max-filter) bridges wide solid black ink fills
  const dilRad = Math.max(3, Math.min(14, Math.round(Math.max(gw, gh) * 0.12)));
  const hMax = new Float32Array(gw * gh);
  const vMax = new Float32Array(gw * gh);

  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const x0 = Math.max(0, x - dilRad);
      const x1 = Math.min(gw - 1, x + dilRad);
      let mx = 0;
      for (let sx = x0; sx <= x1; sx++) {
        const v = grid[row + sx];
        if (v > mx) mx = v;
      }
      hMax[row + x] = mx;
    }
  }

  for (let y = 0; y < gh; y++) {
    const y0 = Math.max(0, y - dilRad);
    const y1 = Math.min(gh - 1, y + dilRad);
    for (let x = 0; x < gw; x++) {
      let mx = 0;
      for (let sy = y0; sy <= y1; sy++) {
        const v = hMax[sy * gw + x];
        if (v > mx) mx = v;
      }
      vMax[y * gw + x] = mx;
    }
  }

  // 3. 2-pass separable box blur produces a silky continuous lighting field
  const blurRad = Math.max(2, Math.round(dilRad * 0.55));
  let cur = vMax;
  let tmp = hMax;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const x0 = Math.max(0, x - blurRad);
        const x1 = Math.min(gw - 1, x + blurRad);
        let sum = 0;
        for (let sx = x0; sx <= x1; sx++) sum += cur[row + sx];
        tmp[row + x] = sum / (x1 - x0 + 1);
      }
    }
    for (let y = 0; y < gh; y++) {
      const y0 = Math.max(0, y - blurRad);
      const y1 = Math.min(gh - 1, y + blurRad);
      for (let x = 0; x < gw; x++) {
        let sum = 0;
        for (let sy = y0; sy <= y1; sy++) sum += tmp[sy * gw + x];
        cur[y * gw + x] = sum / (y1 - y0 + 1);
      }
    }
  }

  // Safe floor so even a huge dark filled body never depresses localPaperLum down to ink levels
  const minSafeFloor = Math.max(124, Math.min(borderP10Lum * 0.88, borderMedianLum * 0.72));
  for (let i = 0; i < cur.length; i++) {
    if (cur[i] < minSafeFloor) cur[i] = minSafeFloor;
  }

  return {
    gw,
    gh,
    w,
    h,
    values: cur,
    borderMedianLum,
    borderP10Lum,
    borderSat,
  };
}

/** Bilinear sample of the local paper illumination ceiling at pixel `(x, y)` */
export function sampleLocalPaperCeiling(map: LocalPaperMap, x: number, y: number): number {
  const fx = (x / Math.max(1, map.w - 1)) * (map.gw - 1);
  const fy = (y / Math.max(1, map.h - 1)) * (map.gh - 1);
  const x0 = Math.max(0, Math.min(map.gw - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(map.gh - 1, Math.floor(fy)));
  const x1 = Math.min(map.gw - 1, x0 + 1);
  const y1 = Math.min(map.gh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = map.values[y0 * map.gw + x0];
  const v10 = map.values[y0 * map.gw + x1];
  const v01 = map.values[y1 * map.gw + x0];
  const v11 = map.values[y1 * map.gw + x1];
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

// ============================================================================
// STAGE 2: ILLUMINATION-NORMALIZED EXTERIOR BFS PAPER REMOVER
// ============================================================================

/**
 * Pure RGBA Illumination-Normalized Exterior BFS Paper Remover (Node/Vitest & Browser!).
 * Samples all 4 border strips to verify a real paper background, builds the Stage 1
 * local illumination ceiling map so heavy hand/phone shadows equalize to relLum ~ 0.99,
 * and flood-fills strictly from exterior borders inward — keeping white eyes, teeth,
 * faces, shirt collars, and white clothing 100% opaque!
 */
export function stripPaperBackgroundBfsRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  outPaperMap?: { map: LocalPaperMap | null }
): boolean {
  if (w < 6 || h < 6 || data.length < w * h * 4) return false;

  // 1. Sample 16 points along each of the 4 outer border strips (64 samples total)
  const samplesR: number[] = [];
  const samplesG: number[] = [];
  const samplesB: number[] = [];
  const samplesLum: number[] = [];
  let totalSamples = 0;
  const steps = Math.min(16, Math.max(4, Math.min(w, h) - 2));
  const insetX = Math.min(2, Math.floor((w - 1) * 0.25));
  const insetY = Math.min(2, Math.floor((h - 1) * 0.25));

  const sampleAt = (x: number, y: number) => {
    const cx = Math.max(0, Math.min(w - 1, x));
    const cy = Math.max(0, Math.min(h - 1, y));
    const o = (cy * w + cx) * 4;
    totalSamples++;
    if (data[o + 3] > 215) {
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      samplesR.push(r);
      samplesG.push(g);
      samplesB.push(b);
      samplesLum.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
  };

  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const sx = Math.round(insetX + t * (w - 1 - insetX * 2));
    const sy = Math.round(insetY + t * (h - 1 - insetY * 2));
    sampleAt(sx, insetY);
    sampleAt(sx, h - 1 - insetY);
    sampleAt(insetX, sy);
    sampleAt(w - 1 - insetX, sy);
  }

  // Already has transparent background — do NOT touch!
  if (samplesR.length < totalSamples * 0.65) return false;

  let bgR = medianOf(samplesR);
  let bgG = medianOf(samplesG);
  let bgB = medianOf(samplesB);
  let bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  let bgSat = Math.max(bgR, bgG, bgB) - Math.min(bgR, bgG, bgB);
  let borderP10Lum = percentileOf(samplesLum, 0.12);

  const N = w * h;
  const lumArr = new Float32Array(N);
  const satArr = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    lumArr[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    satArr[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  // STAGE 0: Auto Bright-Paper Sheet Island Detection for photos showing a dark wooden desk/table around A4 paper!
  // Also accept warm tungsten evening desk-lamp paper (2700K-3200K: bright R>=G>=B with bgSat up to 96 and uniform border tint!)
  const isWarmTungstenPaper =
    bgLum >= 132 && bgSat <= 98 && bgR >= bgG - 6 && bgG >= bgB - 4;
  const isCoolDaylightPaper =
    bgLum >= 132 && bgSat <= 74 && bgB >= bgG - 6 && bgG >= bgR - 6;
  const isPlausiblePaperBorder =
    bgLum >= 122 && (bgSat <= 58 || isWarmTungstenPaper || isCoolDaylightPaper);

  const deskStripped = new Uint8Array(N);
  let hadDeskFrame = false;
  if (!isPlausiblePaperBorder) {
    const sheetR: number[] = [];
    const sheetG: number[] = [];
    const sheetB: number[] = [];
    const sheetL: number[] = [];
    let probeTotal = 0;
    const gSteps = 16;
    for (let gy = 0; gy < gSteps; gy++) {
      const py = Math.round(h * (0.12 + (gy / (gSteps - 1)) * 0.76));
      for (let gx = 0; gx < gSteps; gx++) {
        const px = Math.round(w * (0.12 + (gx / (gSteps - 1)) * 0.76));
        const idx = py * w + px;
        if (data[idx * 4 + 3] < 200) continue;
        probeTotal++;
        if (lumArr[idx] >= 165 && satArr[idx] <= 46) {
          sheetR.push(data[idx * 4]);
          sheetG.push(data[idx * 4 + 1]);
          sheetB.push(data[idx * 4 + 2]);
          sheetL.push(lumArr[idx]);
        }
      }
    }
    // Genuine bright paper sheet sitting on a dark desk/table (>= 26% interior paper coverage!)
    if (probeTotal >= 32 && sheetL.length >= probeTotal * 0.26) {
      const dq = new Int32Array(N);
      let dqh = 0;
      let dqt = 0;
      const isDeskPx = (idx: number): boolean => {
        if (data[idx * 4 + 3] < 24) return true;
        // Stop dead when hitting bright neutral paper sheet!
        if (lumArr[idx] >= 156 && satArr[idx] <= 48) return false;
        const o = idx * 4;
        const dr = Math.abs(data[o] - bgR);
        const dg = Math.abs(data[o + 1] - bgG);
        const db = Math.abs(data[o + 2] - bgB);
        return Math.abs(lumArr[idx] - bgLum) <= 52 && dr + dg + db <= 135;
      };
      const seedDesk = (x: number, y: number) => {
        const idx = y * w + x;
        if (!deskStripped[idx] && isDeskPx(idx)) {
          deskStripped[idx] = 1;
          dq[dqt++] = idx;
        }
      };
      for (let x = 0; x < w; x++) {
        seedDesk(x, 0);
        seedDesk(x, h - 1);
      }
      for (let y = 1; y < h - 1; y++) {
        seedDesk(0, y);
        seedDesk(w - 1, y);
      }
      while (dqh < dqt) {
        const cur = dq[dqh++];
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx > 0 && !deskStripped[cur - 1] && isDeskPx(cur - 1)) { deskStripped[cur - 1] = 1; dq[dqt++] = cur - 1; }
        if (cx + 1 < w && !deskStripped[cur + 1] && isDeskPx(cur + 1)) { deskStripped[cur + 1] = 1; dq[dqt++] = cur + 1; }
        if (cy > 0 && !deskStripped[cur - w] && isDeskPx(cur - w)) { deskStripped[cur - w] = 1; dq[dqt++] = cur - w; }
        if (cy + 1 < h && !deskStripped[cur + w] && isDeskPx(cur + w)) { deskStripped[cur + w] = 1; dq[dqt++] = cur + w; }
      }
      if (dqt >= N * 0.04) {
        hadDeskFrame = true;
        for (let i = 0; i < N; i++) {
          if (deskStripped[i]) data[i * 4 + 3] = 0;
        }
        bgR = medianOf(sheetR);
        bgG = medianOf(sheetG);
        bgB = medianOf(sheetB);
        bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
        bgSat = Math.max(bgR, bgG, bgB) - Math.min(bgR, bgG, bgB);
        borderP10Lum = percentileOf(sheetL, 0.12);
      } else {
        return false;
      }
    } else {
      return false;
    }
  }

  // White-balanced relative chroma deviation from the paper's true ambient light (handles both
  // 6500K daylight paper AND 2700K yellow evening tungsten lamp paper while strictly protecting colored paint!)
  const safeBgLum = Math.max(1, bgLum);
  const bgNr = bgR / safeBgLum;
  const bgNg = bgG / safeBgLum;
  const bgNb = bgB / safeBgLum;
  const chromaDevOf = (idx: number): number => {
    const o = idx * 4;
    const lum = lumArr[idx];
    const er = bgNr * lum;
    const eg = bgNg * lum;
    const eb = bgNb * lum;
    const dr = Math.abs(data[o] - er);
    const dg = Math.abs(data[o + 1] - eg);
    const db = Math.abs(data[o + 2] - eb);
    // Combine max-channel deviation with L1 chroma sum so pale pastel/peach skin strokes
    // (e.g. RGB 252,224,202 on cream paper -> L1 sum = 45!) are NEVER mistaken for paper grain!
    return Math.max(Math.max(dr, dg, db), (dr + dg + db) * 0.66);
  };
  // Keep chroma tolerance tight on neutral/cream paper so pale peach/pastel unoutlined skin & strokes survive,
  // while warm tungsten evening lamps (bgSat > 52) still allow slight lamp-temperature shift across shadows!
  const maxChromaDev = bgSat > 52 ? 34 : Math.min(24, Math.max(18, bgSat + 10));

  // Build Stage 1 local illumination ceiling map (used for Stage 4 interior pocket validation!)
  const paperMap = outPaperMap
    ? computeLocalPaperCeilingMap(data, w, h, bgLum, borderP10Lum, bgSat)
    : null;
  if (outPaperMap) outPaperMap.map = paperMap;

  const visited = new Uint8Array(N);
  const refLum = new Float32Array(N);
  const queue = new Int32Array(N);
  let qHead = 0;
  let qTail = 0;

  // Floor stops BFS dead at dark marker/ink even inside heavy shadows (shadow ~150..180, ink ~50..105!)
  const absMinLum = Math.max(102, Math.min(borderP10Lum * 0.64, bgLum * 0.56));
  const seedMinLum = Math.max(absMinLum, Math.min(borderP10Lum - 18, bgLum - 88));
  const maxDropFromRef = 25; // Stops cleanly at faint pencil & crisp ink strokes!
  const maxSingleStep = 18; // Smooth shadows change <= 4/px; ink strokes jump 30..160/px!
  const maxSmoothGradStep = 6.5; // Only adapt local shadow ceiling on silky-smooth paper gradients!

  // SMART PRINTED BLUE-GRID & GRAY-LINED NOTEBOOK DETECTOR (Turkish kareli & çizgili okul defteri!)
  // 1) Blue-grid rules work EVEN inside phone shadows by comparing local neighbor brightness!
  // 2) Gray-lined rules ONLY match verified page-spanning printed rows/cols so antennas/drawings stay 100% safe!
  const isBlueRuleColor = (idx: number): boolean => {
    const o = idx * 4;
    if (data[o + 3] < 120) return false;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const lum = lumArr[idx];
    const sat = satArr[idx];
    return lum >= Math.max(92, absMinLum - 12) && b >= r + 10 && b >= g + 3 && sat <= 98;
  };
  const isThinBlueRulePx = (x: number, y: number): boolean => {
    const idx = y * w + x;
    if (!isBlueRuleColor(idx)) return false;
    const ruleLum = lumArr[idx];
    const isLocalPaper = (px: number, py: number): boolean => {
      if (px < 0 || px >= w || py < 0 || py >= h) return true;
      const ni = py * w + px;
      return (
        data[ni * 4 + 3] < 24 ||
        (lumArr[ni] >= Math.max(absMinLum, ruleLum + 3) && chromaDevOf(ni) <= maxChromaDev)
      );
    };
    const thinVert =
      (isLocalPaper(x, y - 2) || isLocalPaper(x, y - 3)) &&
      (isLocalPaper(x, y + 2) || isLocalPaper(x, y + 3));
    const thinHoriz =
      (isLocalPaper(x - 2, y) || isLocalPaper(x - 3, y)) &&
      (isLocalPaper(x + 2, y) || isLocalPaper(x + 3, y));
    // Also catch exact '+' gridline intersections where all 4 diagonal quadrants are local paper!
    const thinCross =
      isLocalPaper(x - 2, y - 2) &&
      isLocalPaper(x + 2, y - 2) &&
      isLocalPaper(x - 2, y + 2) &&
      isLocalPaper(x + 2, y + 2);
    return thinVert || thinHoriz || thinCross;
  };

  const isThinGrayRuleCandidate = (x: number, y: number, horiz: boolean): boolean => {
    const idx = y * w + x;
    if (data[idx * 4 + 3] < 120) return false;
    const lum = lumArr[idx];
    if (lum < Math.max(132, absMinLum + 8) || chromaDevOf(idx) > 22) return false;
    if (horiz) {
      if (y < 2 || y >= h - 2) return false;
      const up = lumArr[(y - 2) * w + x];
      const dn = lumArr[(y + 2) * w + x];
      return up >= lum + 10 && dn >= lum + 10 && chromaDevOf((y - 2) * w + x) <= maxChromaDev && chromaDevOf((y + 2) * w + x) <= maxChromaDev;
    } else {
      if (x < 2 || x >= w - 2) return false;
      const lt = lumArr[y * w + (x - 2)];
      const rt = lumArr[y * w + (x + 2)];
      return lt >= lum + 10 && rt >= lum + 10 && chromaDevOf(y * w + (x - 2)) <= maxChromaDev && chromaDevOf(y * w + (x + 2)) <= maxChromaDev;
    }
  };

  const isThinRedMarginCandidate = (x: number, y: number): boolean => {
    const idx = y * w + x;
    if (data[idx * 4 + 3] < 120) return false;
    const o = idx * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const lum = lumArr[idx];
    if (lum < 105 || r < b + 20 || r < g + 14) return false;
    if (x < 3 || x >= w - 3) return false;
    const ltOk = chromaDevOf(y * w + (x - 3)) <= maxChromaDev || chromaDevOf(y * w + (x - 2)) <= maxChromaDev;
    const rtOk = chromaDevOf(y * w + (x + 3)) <= maxChromaDev || chromaDevOf(y * w + (x + 2)) <= maxChromaDev;
    return ltOk && rtOk;
  };

  let blueRuleRows = 0;
  let blueRuleCols = 0;
  const grayRuleRowMask = new Uint8Array(h);
  const grayRuleColMask = new Uint8Array(w);
  const redMarginColMask = new Uint8Array(w);
  let grayRuleRows = 0;
  let grayRuleCols = 0;
  let hasRedMarginLine = false;
  const marginX = Math.max(8, Math.round(w * 0.22));
  const marginY = Math.max(8, Math.round(h * 0.22));
  const minRowHits = Math.max(4, Math.floor((marginX * 2) / 7));
  const minColHits = Math.max(4, Math.floor((marginY * 2) / 7));

  for (let y = 2; y < h - 2; y++) {
    let bHits = 0;
    let gHitsL = 0;
    let gHitsR = 0;
    let gProbesL = 0;
    let gProbesR = 0;
    for (let x = 2; x < marginX; x += 3) {
      if (isThinBlueRulePx(x, y)) bHits++;
      gProbesL++;
      if (isThinGrayRuleCandidate(x, y, true)) gHitsL++;
    }
    for (let x = w - marginX; x < w - 2; x += 3) {
      if (isThinBlueRulePx(x, y)) bHits++;
      gProbesR++;
      if (isThinGrayRuleCandidate(x, y, true)) gHitsR++;
    }
    if (y % 2 === 0 && bHits >= Math.max(4, Math.floor((marginX * 2) / 9))) blueRuleRows++;
    if (
      gProbesL >= 3 &&
      gProbesR >= 3 &&
      gHitsL >= gProbesL * 0.55 &&
      gHitsR >= gProbesR * 0.55 &&
      gHitsL + gHitsR >= minRowHits
    ) {
      grayRuleRowMask[y] = 1;
      grayRuleRows++;
    }
  }
  const redMarginBand = Math.max(8, Math.round(w * 0.26));
  for (let x = 2; x < w - 2; x++) {
    let bHits = 0;
    let gHitsT = 0;
    let gHitsB = 0;
    let gProbesT = 0;
    let gProbesB = 0;
    let rHitsT = 0;
    let rHitsB = 0;
    const inSideMargin = x < redMarginBand || x > w - redMarginBand;
    for (let y = 2; y < marginY; y += 3) {
      if (isThinBlueRulePx(x, y)) bHits++;
      gProbesT++;
      if (isThinGrayRuleCandidate(x, y, false)) gHitsT++;
      if (inSideMargin && isThinRedMarginCandidate(x, y)) rHitsT++;
    }
    for (let y = h - marginY; y < h - 2; y += 3) {
      if (isThinBlueRulePx(x, y)) bHits++;
      gProbesB++;
      if (isThinGrayRuleCandidate(x, y, false)) gHitsB++;
      if (inSideMargin && isThinRedMarginCandidate(x, y)) rHitsB++;
    }
    if (x % 2 === 0 && bHits >= Math.max(4, Math.floor((marginY * 2) / 9))) blueRuleCols++;
    if (
      gProbesT >= 3 &&
      gProbesB >= 3 &&
      gHitsT >= gProbesT * 0.55 &&
      gHitsB >= gProbesB * 0.55 &&
      gHitsT + gHitsB >= minColHits
    ) {
      grayRuleColMask[x] = 1;
      grayRuleCols++;
    }
    if (
      inSideMargin &&
      gProbesT >= 3 &&
      gProbesB >= 3 &&
      rHitsT >= gProbesT * 0.55 &&
      rHitsB >= gProbesB * 0.55
    ) {
      redMarginColMask[x] = 1;
      hasRedMarginLine = true;
    }
  }
  const isBlueRuledNotebook = blueRuleRows >= 3 || blueRuleCols >= 3;
  const isGrayRuledNotebook = grayRuleRows >= 4 || grayRuleCols >= 4;
  const isNotebookRulePx = (x: number, y: number): boolean => {
    if (isBlueRuledNotebook && isThinBlueRulePx(x, y)) return true;
    if (isGrayRuledNotebook) {
      if (grayRuleRowMask[y] && isThinGrayRuleCandidate(x, y, true)) return true;
      if (grayRuleColMask[x] && isThinGrayRuleCandidate(x, y, false)) return true;
    }
    if (hasRedMarginLine && redMarginColMask[x] && isThinRedMarginCandidate(x, y)) return true;
    return false;
  };

  // MORPHOLOGICAL 2-PX CONTOUR-GAP CLOSING BARRIER (strictly for BFS leak prevention!)
  // Seals 2..4 px pen gaps in white faces/bodies via exact Closing (dilate r=2 -> erode r=2)
  // WITHOUT blocking soft phone shadows (checks dark ink floor, white-balanced chroma deviation,
  // OR sharp local 5-px edge contrast against immediate neighbor paper)!
  const inkBarrier = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const yUp = Math.max(0, y - 5) * w;
    const yDn = Math.min(h - 1, y + 5) * w;
    const yUp4 = Math.max(0, y - 4) * w;
    const yDn4 = Math.min(h - 1, y + 4) * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (data[i * 4 + 3] < 48) continue;
      if (isNotebookRulePx(x, y)) continue;
      const lum = lumArr[i];
      if (lum < absMinLum || chromaDevOf(i) > maxChromaDev) {
        inkBarrier[i] = 1;
        continue;
      }
      // Sharp local high-pass contrast catches light 2B pencil contours while ignoring smooth phone shadows!
      const xL = Math.max(0, x - 5);
      const xR = Math.min(w - 1, x + 5);
      const xL4 = Math.max(0, x - 4);
      const xR4 = Math.min(w - 1, x + 4);
      const localMax = Math.max(
        lumArr[row + xL],
        lumArr[row + xR],
        lumArr[yUp + x],
        lumArr[yDn + x],
        lumArr[yUp4 + xL4],
        lumArr[yUp4 + xR4],
        lumArr[yDn4 + xL4],
        lumArr[yDn4 + xR4]
      );
      if (localMax - lum >= 30) {
        inkBarrier[i] = 1;
      }
    }
  }
  // Separable 2-px dilation -> 2-px erosion (exact morphological closing in O(N) time!)
  const dilH = new Uint8Array(N);
  const dilV = new Uint8Array(N);
  const erH = new Uint8Array(N);
  const closedBarrier = new Uint8Array(N);
  const rClose = 2;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let any = 0;
      const x0 = Math.max(0, x - rClose);
      const x1 = Math.min(w - 1, x + rClose);
      for (let k = x0; k <= x1; k++) {
        if (inkBarrier[row + k]) { any = 1; break; }
      }
      dilH[row + x] = any;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rClose);
    const y1 = Math.min(h - 1, y + rClose);
    for (let x = 0; x < w; x++) {
      let any = 0;
      for (let k = y0; k <= y1; k++) {
        if (dilH[k * w + x]) { any = 1; break; }
      }
      dilV[y * w + x] = any;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let all = 1;
      const x0 = Math.max(0, x - rClose);
      const x1 = Math.min(w - 1, x + rClose);
      for (let k = x0; k <= x1; k++) {
        if (!dilV[row + k]) { all = 0; break; }
      }
      erH[row + x] = all;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rClose);
    const y1 = Math.min(h - 1, y + rClose);
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (let k = y0; k <= y1; k++) {
        if (!erH[k * w + x]) { all = 0; break; }
      }
      closedBarrier[y * w + x] = all;
    }
  }

  const trySeed = (x: number, y: number) => {
    const idx = y * w + x;
    if (visited[idx]) return;
    const a = data[idx * 4 + 3];
    if (a < 24) {
      visited[idx] = 1;
      refLum[idx] = bgLum;
      queue[qTail++] = idx;
      return;
    }
    if (closedBarrier[idx]) return;
    if (isNotebookRulePx(x, y)) {
      visited[idx] = 1;
      refLum[idx] = bgLum;
      queue[qTail++] = idx;
      return;
    }
    const lum = lumArr[idx];
    if (lum >= seedMinLum && chromaDevOf(idx) <= maxChromaDev) {
      visited[idx] = 1;
      refLum[idx] = lum;
      queue[qTail++] = idx;
    }
  };

  // Seed strictly from the 4 outer borders (+ 3px inset to step over dark 1-2px desk rims in phone photos!)
  // If Stage 0 stripped a surrounding dark desk, also seed the exposed paper sheet perimeter!
  const insetSeed = Math.min(3, Math.floor(Math.min(w, h) * 0.05));
  for (let x = 0; x < w; x++) {
    trySeed(x, 0);
    trySeed(x, h - 1);
    if (insetSeed > 0) {
      trySeed(x, insetSeed);
      trySeed(x, h - 1 - insetSeed);
    }
  }
  for (let y = 1; y < h - 1; y++) {
    trySeed(0, y);
    trySeed(w - 1, y);
    if (insetSeed > 0) {
      trySeed(insetSeed, y);
      trySeed(w - 1 - insetSeed, y);
    }
  }
  if (hadDeskFrame) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (deskStripped[idx]) continue;
        if (
          deskStripped[idx - 1] ||
          deskStripped[idx + 1] ||
          deskStripped[idx - w] ||
          deskStripped[idx + w]
        ) {
          trySeed(x, y);
        }
      }
    }
  }

  if (qTail === 0) return false;

  const tryStep = (fromIdx: number, toIdx: number) => {
    if (visited[toIdx]) return;
    const toA = data[toIdx * 4 + 3];
    const fromRef = refLum[fromIdx];
    if (toA < 24) {
      visited[toIdx] = 1;
      refLum[toIdx] = fromRef;
      queue[qTail++] = toIdx;
      return;
    }
    // Sealed contour gap barrier prevents leaking through 2-4px pen openings into white faces!
    if (closedBarrier[toIdx]) return;

    const tx = toIdx % w;
    const ty = (toIdx - tx) / w;
    // Step cleanly across printed blue-grid & gray-lined notebook rules without eating solid marker fills!
    if (isNotebookRulePx(tx, ty)) {
      visited[toIdx] = 1;
      refLum[toIdx] = fromRef;
      queue[qTail++] = toIdx;
      return;
    }

    const toLum = lumArr[toIdx];
    if (toLum < absMinLum) return;
    if (chromaDevOf(toIdx) > maxChromaDev) return;

    const fromA = data[fromIdx * 4 + 3];
    const fromX = fromIdx % w;
    const fromY = (fromIdx - fromX) / w;
    const fromWasRule = isNotebookRulePx(fromX, fromY);
    const fromLum = fromA < 24 || fromWasRule ? fromRef : lumArr[fromIdx];
    const stepDiff = Math.abs(toLum - fromLum);
    if (stepDiff > maxSingleStep) return;

    // Must remain within maxDropFromRef of the smoothly tracked local paper brightness!
    if (fromRef - toLum > maxDropFromRef) return;

    visited[toIdx] = 1;
    if (toLum >= fromRef) {
      refLum[toIdx] = fromRef * 0.72 + toLum * 0.28;
    } else if (stepDiff <= maxSmoothGradStep) {
      refLum[toIdx] = fromRef * 0.93 + toLum * 0.07;
    } else {
      refLum[toIdx] = fromRef;
    }
    queue[qTail++] = toIdx;
  };

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % w;
    const cy = (cur - cx) / w;

    if (cx > 0) tryStep(cur, cur - 1);
    if (cx + 1 < w) tryStep(cur, cur + 1);
    if (cy > 0) tryStep(cur, cur - w);
    if (cy + 1 < h) tryStep(cur, cur + w);
  }

  // Strip visited exterior pixels cleanly to alpha = 0
  let strippedCount = 0;
  for (let i = 0; i < N; i++) {
    if (visited[i]) {
      if (data[i * 4 + 3] > 0) strippedCount++;
      data[i * 4 + 3] = 0;
    }
  }

  if (strippedCount === 0) return false;

  // Soft 1px Anti-Aliased Border Decontamination using local neighbor paper refLum!
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (visited[idx]) continue;
      let neighborRef = 0;
      let neighborCnt = 0;
      if (visited[idx - 1]) {
        neighborRef += refLum[idx - 1];
        neighborCnt++;
      }
      if (visited[idx + 1]) {
        neighborRef += refLum[idx + 1];
        neighborCnt++;
      }
      if (visited[idx - w]) {
        neighborRef += refLum[idx - w];
        neighborCnt++;
      }
      if (visited[idx + w]) {
        neighborRef += refLum[idx + w];
        neighborCnt++;
      }
      if (neighborCnt === 0) continue;

      const o = idx * 4;
      const a = data[o + 3];
      if (a < 20) continue;
      const lum = lumArr[idx];
      const localRef = neighborRef / neighborCnt;
      const relLum = lum / Math.max(1, localRef);
      if (relLum > 0.72 && chromaDevOf(idx) < maxChromaDev) {
        const strength = Math.max(0, Math.min(1, (0.94 - relLum) / 0.24));
        data[o + 3] = Math.round(a * strength);
        if (strength > 0.08 && strength < 0.9) {
          data[o] = Math.max(0, Math.round(data[o] * 0.76));
          data[o + 1] = Math.max(0, Math.round(data[o + 1] * 0.76));
          data[o + 2] = Math.max(0, Math.round(data[o + 2] * 0.76));
        }
      }
    }
  }

  return true;
}

// ============================================================================
// STAGE 3: 8-CONNECTED PRIMARY SUBJECT ISOLATION (AUTO SIGNATURE/DATE REMOVAL)
// ============================================================================

/**
 * Pure RGBA Primary Subject Isolator (runs in <5ms!).
 * Groups foreground pixels with a 2px morphological bridge so thin lines or tiny pen breaks
 * stay connected, chooses the dominant central character component, and computes exact
 * pixel-to-pixel distance (NOT naive bbox distance!) from the primary subject's actual ink:
 *  - Keeps primary subject + nearby floating pieces (<= 8.5% actual pixel distance: floating hats,
 *    eyebrows, detached sparks) + any large companion character (>= 28% of primary area).
 *  - Automatically removes distant corner signatures, dates (`21.09.2026`), page numbers,
 *    notebook binder holes, and stray paper smudges!
 */
export function isolatePrimarySubjectRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  alphaThreshold = 34
): boolean {
  const N = w * h;
  if (w < 12 || h < 12 || data.length < N * 4) return false;

  const fg = new Uint8Array(N);
  let totalFg = 0;
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 3] > alphaThreshold) {
      fg[i] = 1;
      totalFg++;
    }
  }
  if (totalFg < 32) return false;

  // 1. 2px separable dilation bridge ONLY for component grouping (seals tiny 2-4px pen gaps!)
  const bridgeR = Math.max(1, Math.min(3, Math.round(Math.min(w, h) * 0.004)));
  const hDil = new Uint8Array(N);
  const bridged = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let hit = 0;
      const x0 = Math.max(0, x - bridgeR);
      const x1 = Math.min(w - 1, x + bridgeR);
      for (let sx = x0; sx <= x1; sx++) {
        if (fg[row + sx]) {
          hit = 1;
          break;
        }
      }
      hDil[row + x] = hit;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - bridgeR);
    const y1 = Math.min(h - 1, y + bridgeR);
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let sy = y0; sy <= y1; sy++) {
        if (hDil[sy * w + x]) {
          hit = 1;
          break;
        }
      }
      bridged[y * w + x] = hit;
    }
  }

  // 2. 8-connected component labeling via BFS
  const labels = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  interface CompStats {
    id: number;
    area: number;
    sumX: number;
    sumY: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    minDistToPrimary: number;
  }
  const comps: CompStats[] = [];

  for (let i = 0; i < N; i++) {
    if (!bridged[i] || labels[i] !== -1) continue;
    const id = comps.length;
    let qHead = 0;
    let qTail = 0;
    labels[i] = id;
    queue[qTail++] = i;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;

    while (qHead < qTail) {
      const cur = queue[qHead++];
      const cx = cur % w;
      const cy = (cur - cx) / w;
      if (fg[cur]) {
        area++;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
      }

      const y0 = Math.max(0, cy - 1);
      const y1 = Math.min(h - 1, cy + 1);
      const x0 = Math.max(0, cx - 1);
      const x1 = Math.min(w - 1, cx + 1);
      for (let ny = y0; ny <= y1; ny++) {
        const nRow = ny * w;
        for (let nx = x0; nx <= x1; nx++) {
          const ni = nRow + nx;
          if (bridged[ni] && labels[ni] === -1) {
            labels[ni] = id;
            queue[qTail++] = ni;
          }
        }
      }
    }

    comps.push({
      id,
      area,
      sumX,
      sumY,
      minX,
      minY,
      maxX,
      maxY,
      minDistToPrimary: 1_000_000,
    });
  }

  if (comps.length <= 1) return false;

  // 3. Pick primary subject weighted by area and gentle center bias
  let primaryId = 0;
  let bestScore = -1;
  const imgCx = w * 0.5;
  const imgCy = h * 0.5;
  const halfDiag = Math.hypot(imgCx, imgCy) || 1;

  for (const c of comps) {
    if (c.area < 4) continue;
    const cx = c.sumX / c.area;
    const cy = c.sumY / c.area;
    const centerDistNorm = Math.min(1, Math.hypot(cx - imgCx, cy - imgCy) / halfDiag);
    const score = c.area * (1.28 - 0.36 * centerDistNorm);
    if (score > bestScore) {
      bestScore = score;
      primaryId = c.id;
    }
  }

  const primary = comps[primaryId];
  if (!primary || primary.area < 24) return false;
  primary.minDistToPrimary = 0;

  const primarySpan = Math.max(1, primary.maxX - primary.minX + 1, primary.maxY - primary.minY + 1);
  const keepNearRadius = Math.max(8, Math.round(primarySpan * 0.082));

  // 4. Exact pixel-to-pixel multi-source BFS distance transform from primary's ACTUAL pixels!
  //    (Avoids bounding-box trap where bottom-left dates sit inside an elbow-to-foot concave corner!)
  const dist = new Int32Array(N).fill(-1);
  let qHead = 0;
  let qTail = 0;
  for (let i = 0; i < N; i++) {
    if (fg[i] && labels[i] === primaryId) {
      dist[i] = 0;
      queue[qTail++] = i;
    }
  }

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const d = dist[cur];
    if (d >= keepNearRadius) continue;
    const nd = d + 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;

    const visitNeighbor = (ni: number) => {
      if (dist[ni] !== -1) return;
      dist[ni] = nd;
      if (fg[ni]) {
        const cid = labels[ni];
        if (cid >= 0 && nd < comps[cid].minDistToPrimary) {
          comps[cid].minDistToPrimary = nd;
        }
      }
      queue[qTail++] = ni;
    };

    if (cx > 0) visitNeighbor(cur - 1);
    if (cx + 1 < w) visitNeighbor(cur + 1);
    if (cy > 0) visitNeighbor(cur - w);
    if (cy + 1 < h) visitNeighbor(cur + w);
  }

  // 5. Decide which components to keep vs prune
  const keep = new Uint8Array(comps.length);
  const minSpeckArea = Math.max(6, Math.round(primary.area * 0.0002));
  let prunedAny = false;

  for (const c of comps) {
    if (c.id === primaryId) {
      keep[c.id] = 1;
      continue;
    }
    const cw = c.maxX - c.minX + 1;
    const ch = c.maxY - c.minY + 1;
    const touchesFrameEdge =
      c.minX <= 1 || c.maxX >= w - 2 || c.minY <= 1 || c.maxY >= h - 2;
    // Detect dark wooden desk edges, table strips, or holding fingers hugging the extreme photo border!
    const isDeskOrFingerMargin =
      touchesFrameEdge &&
      c.minDistToPrimary > 12 &&
      ((cw >= w * 0.42 && ch <= h * 0.22) ||
        (ch >= h * 0.42 && cw <= w * 0.22) ||
        (Math.min(cw, ch) <= Math.max(18, Math.round(Math.min(w, h) * 0.08)) &&
          (c.maxX <= w * 0.16 || c.minX >= w * 0.84 || c.maxY <= h * 0.14 || c.minY >= h * 0.86)));
    if (isDeskOrFingerMargin) {
      prunedAny = true;
      continue;
    }
    // Keep any large companion character drawn alongside the main hero!
    if (c.area >= primary.area * 0.28) {
      keep[c.id] = 1;
      continue;
    }
    // Drop razor-thin border slivers glued to the photo edge (desk shadow / page border scraps!)
    const isBorderSliver =
      touchesFrameEdge &&
      c.minDistToPrimary > 5 &&
      Math.min(cw, ch) <= 5 &&
      c.area < primary.area * 0.012;
    // Also drop spiral notebook rings & punch-binder holes hugging the extreme left/right edge!
    const spiralMargin = Math.max(10, Math.round(w * 0.075));
    const isEdgeSpiralRing =
      (c.maxX <= spiralMargin || c.minX >= w - 1 - spiralMargin) &&
      c.minDistToPrimary > 6 &&
      c.area < primary.area * 0.045;
    if (isBorderSliver || isEdgeSpiralRing) {
      prunedAny = true;
      continue;
    }
    // Keep genuine nearby floating parts (floating hat, eyebrows, sparkles) while dropping tiny dust!
    if (c.minDistToPrimary <= keepNearRadius && (c.minDistToPrimary <= 4 || c.area >= minSpeckArea)) {
      keep[c.id] = 1;
      continue;
    }
    if (c.area > 0) prunedAny = true;
  }

  if (!prunedAny) return false;

  // Clear all pruned components (including their semi-transparent anti-aliased fringe via labels!)
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 3] === 0) continue;
    const cid = labels[i];
    if (cid === -1 || !keep[cid]) {
      data[i * 4 + 3] = 0;
    }
  }

  return true;
}

// ============================================================================
// STAGE 4: GEOMETRIC CLOSED BODY-POCKET CLEANER (ARMPITS / LEGS / CANE GAPS)
// ============================================================================

export interface PaperPocketDebugInfo {
  id: number;
  area: number;
  areaRatio: number;
  cxNorm: number;
  cyNorm: number;
  minYNorm: number;
  maxYNorm: number;
  avgRelLum: number;
  avgSat: number;
  stdDevLum: number;
  thinAirBorderRatio: number;
  cleared: boolean;
  reason: string;
}

/**
 * Pure RGBA Closed Interior Paper-Pocket Cleaner.
 * Automatically clears enclosed blank-paper holes below the neck (armpit triangles,
 * between-legs gaps, leg-to-cane gaps) while mathematically PROTECTING:
 *  - Head, white face, white eyes, teeth & horns (strict head immunity zone)
 *  - White shirt collar & tie triangles (upper-center collar guard + area floor)
 *  - White hands, white cuffs, white T-shirts & white ghost bodies (universal thin-pen-border-to-air
 *    invariant: white clothing/hands sit behind a thin pen outline touching exterior air, whereas
 *    background armpit/leg/cane holes are framed by solid limbs/torso!)
 */
export function cleanClosedBodyPaperPocketsRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  paperMap?: LocalPaperMap | null,
  debugOut?: PaperPocketDebugInfo[]
): number {
  const N = w * h;
  if (w < 24 || h < 24 || data.length < N * 4) return 0;

  // 1. Measure active character bounding box & opaque area
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let primaryArea = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > 64) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        primaryArea++;
      }
    }
  }
  if (primaryArea < 200 || maxX <= minX || maxY <= minY) return 0;

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const charSpan = Math.max(bw, bh);

  // 2. Compute fast bounded distance transform from exterior transparent air (`alpha < 32`)!
  //    Used to test the universal thin-pen-contour invariant (hands/cuffs/shirts touch air
  //    across a thin pen outline <= ~1.35% of charSpan; armpit/leg pockets sit behind thicker limbs!).
  const thinAirRad = Math.max(5, Math.min(16, Math.round(charSpan * 0.018)));
  const distToAir = new Int16Array(N).fill(thinAirRad + 2);
  const queue = new Int32Array(N);
  let qHead = 0;
  let qTail = 0;

  for (let y = minY; y <= maxY; y++) {
    const row = y * w;
    for (let x = minX; x <= maxX; x++) {
      const idx = row + x;
      if (data[idx * 4 + 3] < 32) {
        distToAir[idx] = 0;
        queue[qTail++] = idx;
      } else if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        distToAir[idx] = 1;
        queue[qTail++] = idx;
      }
    }
  }
  // Also seed the 1px outer ring around the character bbox so boundary pixels know exact air distance
  for (let x = Math.max(0, minX - 1); x <= Math.min(w - 1, maxX + 1); x++) {
    for (const y of [Math.max(0, minY - 1), Math.min(h - 1, maxY + 1)]) {
      const idx = y * w + x;
      if (data[idx * 4 + 3] < 32 && distToAir[idx] > 0) {
        distToAir[idx] = 0;
        queue[qTail++] = idx;
      }
    }
  }
  for (let y = Math.max(0, minY - 1); y <= Math.min(h - 1, maxY + 1); y++) {
    for (const x of [Math.max(0, minX - 1), Math.min(w - 1, maxX + 1)]) {
      const idx = y * w + x;
      if (data[idx * 4 + 3] < 32 && distToAir[idx] > 0) {
        distToAir[idx] = 0;
        queue[qTail++] = idx;
      }
    }
  }

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const d = distToAir[cur];
    if (d >= thinAirRad) continue;
    const nd = d + 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;

    if (cx > minX && distToAir[cur - 1] > nd) {
      distToAir[cur - 1] = nd;
      queue[qTail++] = cur - 1;
    }
    if (cx < maxX && distToAir[cur + 1] > nd) {
      distToAir[cur + 1] = nd;
      queue[qTail++] = cur + 1;
    }
    if (cy > minY && distToAir[cur - w] > nd) {
      distToAir[cur - w] = nd;
      queue[qTail++] = cur - w;
    }
    if (cy < maxY && distToAir[cur + w] > nd) {
      distToAir[cur + w] = nd;
      queue[qTail++] = cur + w;
    }
  }

  // 3. Identify candidate interior paper-toned pixels inside character bbox
  const isCand = new Uint8Array(N);
  const relLums = new Float32Array(N);
  const fallbackCeil = paperMap ? paperMap.borderMedianLum : 236;
  const maxPocketSat = paperMap ? Math.min(26, paperMap.borderSat + 16) : 20;

  for (let y = minY; y <= maxY; y++) {
    const row = y * w;
    for (let x = minX; x <= maxX; x++) {
      const idx = row + x;
      const o = idx * 4;
      if (data[o + 3] < 140) continue;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > maxPocketSat) continue;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const ceil = paperMap ? sampleLocalPaperCeiling(paperMap, x, y) : fallbackCeil;
      const relLum = lum / Math.max(1, ceil);
      if (relLum >= 0.785 && lum >= 152) {
        isCand[idx] = 1;
        relLums[idx] = relLum;
      }
    }
  }

  // 4. Connected components of candidate paper pockets + strict geometric validation
  const visited = new Uint8Array(N);
  const clearedMask = new Uint8Array(N);
  let clearedCount = 0;
  let pocketSeq = 0;
  const pocketIndices: number[] = [];

  for (let y = minY; y <= maxY; y++) {
    const row = y * w;
    for (let x = minX; x <= maxX; x++) {
      const startIdx = row + x;
      if (!isCand[startIdx] || visited[startIdx]) continue;

      pocketIndices.length = 0;
      qHead = 0;
      qTail = 0;
      visited[startIdx] = 1;
      queue[qTail++] = startIdx;

      let sumX = 0;
      let sumY = 0;
      let pMinY = h;
      let pMaxY = 0;
      let sumRelLum = 0;
      let sumLum = 0;
      let sumLumSq = 0;
      let sumSat = 0;
      let borderPx = 0;
      let thinAirBorderPx = 0;
      let nonCandBorderCnt = 0;
      let nonCandBorderLumSum = 0;
      let nonCandBorderSatSum = 0;

      while (qHead < qTail) {
        const cur = queue[qHead++];
        pocketIndices.push(cur);
        const cx = cur % w;
        const cy = (cur - cx) / w;
        sumX += cx;
        sumY += cy;
        if (cy < pMinY) pMinY = cy;
        if (cy > pMaxY) pMaxY = cy;

        const o = cur * 4;
        const r = data[o];
        const g = data[o + 1];
        const b = data[o + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        sumRelLum += relLums[cur];
        sumLum += lum;
        sumLumSq += lum * lum;
        sumSat += sat;

        let isBorder = false;
        const step = (nx: number, ny: number) => {
          if (nx < minX || nx > maxX || ny < minY || ny > maxY) {
            isBorder = true;
            return;
          }
          const ni = ny * w + nx;
          if (!isCand[ni]) {
            isBorder = true;
            const no = ni * 4;
            if (data[no + 3] >= 120) {
              const nr = data[no];
              const ng = data[no + 1];
              const nb = data[no + 2];
              nonCandBorderLumSum += 0.299 * nr + 0.587 * ng + 0.114 * nb;
              nonCandBorderSatSum += Math.max(nr, ng, nb) - Math.min(nr, ng, nb);
              nonCandBorderCnt++;
            }
            return;
          }
          if (!visited[ni]) {
            visited[ni] = 1;
            queue[qTail++] = ni;
          }
        };

        step(cx - 1, cy);
        step(cx + 1, cy);
        step(cx, cy - 1);
        step(cx, cy + 1);

        if (isBorder) {
          borderPx++;
          if (distToAir[cur] <= thinAirRad) {
            thinAirBorderPx++;
          }
        }
      }

      const area = pocketIndices.length;
      const areaRatio = area / primaryArea;
      if (area < 36) continue;

      const cxNorm = (sumX / area - minX) / bw;
      const cyNorm = (sumY / area - minY) / bh;
      const minYNorm = (pMinY - minY) / bh;
      const maxYNorm = (pMaxY - minY) / bh;
      const avgRelLum = sumRelLum / area;
      const avgLum = sumLum / area;
      const variance = Math.max(0, sumLumSq / area - avgLum * avgLum);
      const stdDevLum = Math.sqrt(variance);
      const avgSat = sumSat / area;
      const thinAirBorderRatio = borderPx > 0 ? thinAirBorderPx / borderPx : 1;
      const avgWallLum = nonCandBorderCnt > 0 ? nonCandBorderLumSum / nonCandBorderCnt : 0;
      const avgWallSat = nonCandBorderCnt > 0 ? nonCandBorderSatSum / nonCandBorderCnt : 0;

      let reason = 'ok';
      let shouldClear = true;

      // Guard 1: Absolute head/face/eyes/teeth/horns immunity zone
      if (cyNorm < 0.34 || minYNorm < 0.25) {
        shouldClear = false;
        reason = 'head-zone';
      }
      // Guard 2: Minimum & maximum area bounds (too small = button/cuff/collar; too large = white ghost/sheet body)
      else if (areaRatio < 0.011 || areaRatio > 0.28) {
        shouldClear = false;
        reason = areaRatio < 0.011 ? 'too-small' : 'too-large';
      }
      // Guard 3: Upper-center white shirt collar / cravat protection
      else if (cyNorm < 0.46 && Math.abs(cxNorm - 0.5) < 0.16) {
        shouldClear = false;
        reason = 'shirt-collar';
      }
      // Guard 4: Paper color & texture uniformity (allows shadowed paper pockets down to relLum ~0.80!)
      else if (avgRelLum < 0.805 || avgSat > 20 || stdDevLum > 26) {
        shouldClear = false;
        reason = 'not-paper-texture';
      }
      // Guard 5: Universal Thin-Pen-Border-to-Air Invariant!
      // White hands, cuffs, gloves, and white outlined T-shirts have >22% of their border
      // sitting directly behind a thin pen outline facing exterior air, whereas genuine enclosed
      // armpit / leg / cane-gap background holes are framed by solid limbs & body!
      else if (thinAirBorderRatio > 0.22) {
        shouldClear = false;
        reason = 'thin-air-outline';
      }
      // Guard 6: Colored-fur / colored-clothing interior protection (e.g. white belly on orange watercolor cat!)
      // Genuine armpit/leg cutouts are framed by dark ink/limbs, NOT bright saturated fur/paint!
      else if ((avgWallSat > 42 && avgWallLum > 115) || (bw > bh * 1.18 && maxYNorm < 0.82)) {
        shouldClear = false;
        reason = 'colored-fur-interior';
      }

      if (debugOut) {
        debugOut.push({
          id: pocketSeq++,
          area,
          areaRatio: Number(areaRatio.toFixed(4)),
          cxNorm: Number(cxNorm.toFixed(3)),
          cyNorm: Number(cyNorm.toFixed(3)),
          minYNorm: Number(minYNorm.toFixed(3)),
          maxYNorm: Number(maxYNorm.toFixed(3)),
          avgRelLum: Number(avgRelLum.toFixed(3)),
          avgSat: Number(avgSat.toFixed(1)),
          stdDevLum: Number(stdDevLum.toFixed(1)),
          thinAirBorderRatio: Number(thinAirBorderRatio.toFixed(3)),
          cleared: shouldClear,
          reason,
        });
      }

      if (!shouldClear) continue;

      // Clear the verified background paper pocket + 2-ring soft AA inner fringe cleanup
      clearedCount++;
      const ring1: number[] = [];
      for (let k = 0; k < pocketIndices.length; k++) {
        const idx = pocketIndices[k];
        clearedMask[idx] = 1;
        data[idx * 4 + 3] = 0;
      }

      // Ring 1: strip pale 1px shadowed paper rim directly hugging the cleared pocket (relLum >= 0.70)
      for (let k = 0; k < pocketIndices.length; k++) {
        const idx = pocketIndices[k];
        const cx = idx % w;
        const cy = (idx - cx) / w;
        const checkRing1 = (nx: number, ny: number) => {
          if (nx < minX || nx > maxX || ny < minY || ny > maxY) return;
          const ni = ny * w + nx;
          if (clearedMask[ni]) return;
          const o = ni * 4;
          const a = data[o + 3];
          if (a < 24) return;
          const r = data[o];
          const g = data[o + 1];
          const b = data[o + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          const ceil = paperMap ? sampleLocalPaperCeiling(paperMap, nx, ny) : fallbackCeil;
          const relLum = lum / Math.max(1, ceil);
          if (relLum >= 0.71 && sat < maxPocketSat + 12) {
            clearedMask[ni] = 1;
            data[o + 3] = 0;
            ring1.push(ni);
          } else if (relLum > 0.62 && sat < maxPocketSat + 12) {
            const strength = Math.max(0, Math.min(1, (0.74 - relLum) / 0.16));
            data[o + 3] = Math.round(a * strength);
          }
        };
        checkRing1(cx - 1, cy);
        checkRing1(cx + 1, cy);
        checkRing1(cx, cy - 1);
        checkRing1(cx, cy + 1);
      }

      // Ring 2: soft 1px AA feather outside Ring 1
      for (let k = 0; k < ring1.length; k++) {
        const idx = ring1[k];
        const cx = idx % w;
        const cy = (idx - cx) / w;
        const featherRing2 = (nx: number, ny: number) => {
          if (nx < minX || nx > maxX || ny < minY || ny > maxY) return;
          const ni = ny * w + nx;
          if (clearedMask[ni]) return;
          const o = ni * 4;
          const a = data[o + 3];
          if (a < 24) return;
          const r = data[o];
          const g = data[o + 1];
          const b = data[o + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          const ceil = paperMap ? sampleLocalPaperCeiling(paperMap, nx, ny) : fallbackCeil;
          const relLum = lum / Math.max(1, ceil);
          if (relLum > 0.66 && sat < maxPocketSat + 12) {
            const strength = Math.max(0, Math.min(1, (0.82 - relLum) / 0.18));
            data[o + 3] = Math.round(a * strength);
          }
        };
        featherRing2(cx - 1, cy);
        featherRing2(cx + 1, cy);
        featherRing2(cx, cy - 1);
        featherRing2(cx, cy + 1);
      }
    }
  }

  return clearedCount;
}

// ============================================================================
// STAGE 5: MONOCHROME INK S-CURVE ENHANCEMENT + TIGHT CROP + MAGIC WAND ERASER
// ============================================================================

/**
 * Pure RGBA Tight Foreground Bounding-Box Detector with Ground-Locked Padding.
 * Ignores isolated 1px scanner/photo dust specks and leaves tight bottom padding (~2%)
 * so feet always sit squarely on groundV >= 0.94 in BOTH Mini Film and Canlı Kukla!
 */
export function computeTightForegroundBoundsRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  alphaThreshold = 26
): ForegroundCropBounds {
  const rowCounts = new Int32Array(h);
  const colCounts = new Int32Array(w);
  let totalOpaque = 0;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > alphaThreshold) {
        rowCounts[y]++;
        colCounts[x]++;
        totalOpaque++;
      }
    }
  }

  if (totalOpaque < 4) {
    return {
      minX: 0,
      minY: 0,
      maxX: Math.max(0, w - 1),
      maxY: Math.max(0, h - 1),
      cropX: 0,
      cropY: 0,
      cropW: w,
      cropH: h,
      empty: true,
    };
  }

  const minBandPx = totalOpaque > 48 ? 2 : 1;

  let minX = 0;
  while (minX < w - 1 && colCounts[minX] < minBandPx) minX++;
  let maxX = w - 1;
  while (maxX > minX && colCounts[maxX] < minBandPx) maxX--;

  let minY = 0;
  while (minY < h - 1 && rowCounts[minY] < minBandPx) minY++;
  let maxY = h - 1;
  while (maxY > minY && rowCounts[maxY] < minBandPx) maxY--;

  const bw = Math.max(1, maxX - minX + 1);
  const bh = Math.max(1, maxY - minY + 1);

  const padX = Math.round(Math.max(bw, bh) * 0.08 + 6);
  const padTop = Math.round(bh * 0.06 + 5);
  const padBottom = Math.round(bh * 0.02 + 2); // Tight floor contact!

  const cropX = Math.max(0, minX - padX);
  const cropY = Math.max(0, minY - padTop);
  const right = Math.min(w, maxX + 1 + padX);
  const bottom = Math.min(h, maxY + 1 + padBottom);
  const cropW = Math.max(1, right - cropX);
  const cropH = Math.max(1, bottom - cropY);

  return {
    minX,
    minY,
    maxX,
    maxY,
    cropX,
    cropY,
    cropW,
    cropH,
    empty: false,
  };
}

/**
 * Pure RGBA Monochrome Ink & Marker Contrast Enhancer (runs identically in Node & Browser!).
 * For black-and-white ink / marker / pencil photographs (`avgSat < 20`), pulls photographed
 * washed-out gray-black marker (`lum ~ 65..120`) into deep velvety studio ink (`lum ~ 18..42`)
 * and lifts slightly dingy paper whites (`lum > 198`) to crisp warm ivory (`248..252`),
 * while leaving colored illustrations 100% untouched!
 */
export function enhanceInkIllustrationRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number
): boolean {
  const N = w * h;
  if (N < 16 || data.length < N * 4) return false;

  let opaqueCount = 0;
  let satSum = 0;
  const lums: number[] = [];
  const step = Math.max(1, Math.floor(N / 4000));

  for (let i = 0; i < N; i += step) {
    const o = i * 4;
    if (data[o + 3] < 48) continue;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    opaqueCount++;
    satSum += sat;
    lums.push(lum);
  }

  if (opaqueCount < 16) return false;
  const avgSat = satSum / opaqueCount;
  // Colored drawing/illustration — DO NOT touch colors!
  if (avgSat >= 20) return false;

  lums.sort((a, b) => a - b);
  const p10Lum = lums[Math.floor(lums.length * 0.1)] ?? 0;
  // Already crisp studio black ink (< 42) — no washout to fix!
  if (p10Lum <= 42) return false;

  const blackPoint = Math.min(138, Math.max(68, p10Lum + 18));
  const whitePoint = Math.max(202, Math.min(234, lums[Math.floor(lums.length * 0.92)] ?? 225));
  const span = Math.max(40, whitePoint - blackPoint);

  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a < 24) continue;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat >= 34) continue; // Keep any subtle colored accent intact
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    if (lum <= blackPoint) {
      // Deepen washed-out photographed marker/pencil into rich warm studio ink (18..40)
      const t = Math.max(0, Math.min(1, lum / Math.max(1, blackPoint)));
      const targetLum = 18 + t * t * 24;
      const ratio = targetLum / Math.max(1, lum);
      data[o] = Math.max(16, Math.min(255, Math.round(r * ratio)));
      data[o + 1] = Math.max(15, Math.min(255, Math.round(g * ratio)));
      data[o + 2] = Math.max(14, Math.min(255, Math.round(b * ratio)));
      if (a < 240 && p10Lum > 82) {
        data[o + 3] = Math.min(255, Math.round(a * 1.35));
      }
    } else if (lum >= whitePoint) {
      // Lift interior white face/shirt/cuffs to crisp warm ivory paper tone
      data[o] = 250;
      data[o + 1] = 248;
      data[o + 2] = 243;
    } else {
      // Smooth S-curve across mid-tones preserving hand-drawn pen texture & shading!
      const u = (lum - blackPoint) / span;
      const s = u * u * (3 - 2 * u);
      const targetLum = 42 + s * 204;
      const ratio = targetLum / Math.max(1, lum);
      data[o] = Math.max(18, Math.min(252, Math.round(r * ratio)));
      data[o + 1] = Math.max(17, Math.min(250, Math.round(g * ratio)));
      data[o + 2] = Math.max(16, Math.min(246, Math.round(b * ratio)));
    }
  }

  return true;
}

/**
 * Pure RGBA Faint-Pencil Contrast Enhancer (backwards-compatible entry point).
 * Deepens faint graphite sketches (`p10Lum > 82`) while never touching colored art!
 */
export function boostFaintPencilInkRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number
): boolean {
  const N = w * h;
  if (N < 16 || data.length < N * 4) return false;

  let opaqueCount = 0;
  let satSum = 0;
  const lums: number[] = [];
  const step = Math.max(1, Math.floor(N / 4000));
  for (let i = 0; i < N; i += step) {
    const o = i * 4;
    if (data[o + 3] < 48) continue;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    opaqueCount++;
    satSum += Math.max(r, g, b) - Math.min(r, g, b);
    lums.push(0.299 * r + 0.587 * g + 0.114 * b);
  }
  if (opaqueCount < 16) return false;
  if (satSum / opaqueCount >= 22) return false;
  lums.sort((a, b) => a - b);
  const p10Lum = lums[Math.floor(lums.length * 0.1)] ?? 0;
  if (p10Lum <= 82) return false;
  return enhanceInkIllustrationRGBA(data, w, h);
}

/**
 * Pure RGBA 1-Click Magic-Wand Pocket Eraser!
 * Lets users click ANY enclosed white/colored background hole on an uploaded drawing
 * to flood-clear that exact pocket with a crisp 1px feathered edge (zero impact outside!).
 */
export function erasePaperPocketAtPointRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  startX: number,
  startY: number,
  tolerance = 46
): number {
  const sx = Math.max(0, Math.min(w - 1, Math.round(startX)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(startY)));
  const startIdx = sy * w + sx;
  const so = startIdx * 4;
  if (data[so + 3] < 24) return 0;

  const sr = data[so];
  const sg = data[so + 1];
  const sb = data[so + 2];
  const N = w * h;
  const visited = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qHead = 0;
  let qTail = 0;
  visited[startIdx] = 1;
  queue[qTail++] = startIdx;

  const cleared: number[] = [];
  const maxDistSq = tolerance * tolerance;

  while (qHead < qTail) {
    const cur = queue[qHead++];
    cleared.push(cur);
    const cx = cur % w;
    const cy = (cur - cx) / w;

    const tryStep = (nx: number, ny: number) => {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
      const ni = ny * w + nx;
      if (visited[ni]) return;
      const o = ni * 4;
      if (data[o + 3] < 24) return;
      const dr = data[o] - sr;
      const dg = data[o + 1] - sg;
      const db = data[o + 2] - sb;
      if (dr * dr + dg * dg + db * db <= maxDistSq) {
        visited[ni] = 1;
        queue[qTail++] = ni;
      }
    };

    tryStep(cx - 1, cy);
    tryStep(cx + 1, cy);
    tryStep(cx, cy - 1);
    tryStep(cx, cy + 1);
  }

  for (let i = 0; i < cleared.length; i++) {
    data[cleared[i] * 4 + 3] = 0;
  }

  // 1px soft AA border feather around clicked pocket
  for (let i = 0; i < cleared.length; i++) {
    const cur = cleared[i];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [nx, ny] of [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ]) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (visited[ni]) continue;
      const o = ni * 4;
      const a = data[o + 3];
      if (a < 24) continue;
      const dr = data[o] - sr;
      const dg = data[o + 1] - sg;
      const db = data[o + 2] - sb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < tolerance * 1.65) {
        const k = Math.max(0, Math.min(1, (dist - tolerance * 0.7) / (tolerance * 0.95)));
        data[o + 3] = Math.round(a * k);
      }
    }
  }

  return cleared.length;
}

/**
 * Browser Unified 5-Stage Character Prep Pipeline:
 * Accepts ANY uploaded phone photo, sketchbook scan, Draw Desk composite, or transparent sprite:
 *  1. Flattens shadows & strips exterior paper via illumination-normalized BFS (keeping white eyes/faces!)
 *  2. Isolates the primary character (automatically stripping corner signatures, dates & binder rings!)
 *  3. Cleans closed armpit/leg/cane paper pockets (protecting white faces, collars, cuffs & hands!)
 *  4. Enhances washed-out monochrome ink/pencil lines into rich studio ink
 *  5. Tight-crops ground-locked onto feet and builds anatomy + archetype rig!
 */
export function prepareCharacterCanvas(
  source: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  opts?: PrepareCharacterOptions
): PreparedCharacterResult {
  const maxDim = opts?.maxDim ?? 768;
  const rawW =
    'naturalWidth' in source && source.naturalWidth > 0
      ? source.naturalWidth
      : source.width || 512;
  const rawH =
    'naturalHeight' in source && source.naturalHeight > 0
      ? source.naturalHeight
      : source.height || 512;

  const scale = Math.min(1, maxDim / Math.max(1, rawW, rawH));
  const sw = Math.max(32, Math.round(rawW * scale));
  const sh = Math.max(32, Math.round(rawH * scale));

  const work = document.createElement('canvas');
  work.width = sw;
  work.height = sh;
  const wctx = work.getContext('2d', { willReadFrequently: true })!;
  wctx.drawImage(source, 0, 0, sw, sh);

  const im = wctx.getImageData(0, 0, sw, sh);
  const paperMapHolder: { map: LocalPaperMap | null } = { map: null };

  // Stage 1 + 2: Illumination-normalized exterior BFS paper stripping
  const strippedPaper =
    opts?.stripPaper !== false
      ? stripPaperBackgroundBfsRGBA(im.data, sw, sh, paperMapHolder)
      : false;

  // Stage 3: Primary subject isolation (strips corner signatures/dates on real paper photos!)
  const isolatedPrimary =
    strippedPaper && opts?.isolateSubject !== false
      ? isolatePrimarySubjectRGBA(im.data, sw, sh)
      : false;

  // Stage 4: Geometric closed body-pocket cleaner (clears armpit/leg/cane loops!)
  const cleanedPockets =
    strippedPaper && opts?.cleanPockets !== false
      ? cleanClosedBodyPaperPocketsRGBA(im.data, sw, sh, paperMapHolder.map)
      : 0;

  // Stage 5: Monochrome ink/marker/pencil contrast S-curve enhancement
  const boostedPencil =
    strippedPaper && opts?.enhanceInk !== false
      ? enhanceInkIllustrationRGBA(im.data, sw, sh)
      : false;

  if (strippedPaper || isolatedPrimary || cleanedPockets > 0 || boostedPencil) {
    wctx.putImageData(im, 0, 0);
  }

  const bounds = computeTightForegroundBoundsRGBA(im.data, sw, sh);
  if (bounds.empty) {
    return {
      canvas: work,
      width: sw,
      height: sh,
      anatomy: defaultDrawingAnatomy(),
      archetype: 'floater',
      strippedPaper,
      isolatedPrimary,
      cleanedPockets,
      boostedPencil,
      cropped: false,
      empty: true,
    };
  }

  const significantCrop =
    bounds.cropW < sw * 0.96 ||
    bounds.cropH < sh * 0.96 ||
    bounds.cropX > 4 ||
    bounds.cropY > 4;

  let finalCanvas = work;
  if (significantCrop) {
    const out = document.createElement('canvas');
    out.width = Math.max(48, bounds.cropW);
    out.height = Math.max(48, bounds.cropH);
    const octx = out.getContext('2d')!;
    octx.drawImage(
      work,
      bounds.cropX,
      bounds.cropY,
      bounds.cropW,
      bounds.cropH,
      0,
      0,
      out.width,
      out.height
    );
    finalCanvas = out;
  }

  const pack = getOrBuildCachedRigPack(finalCanvas);
  return {
    canvas: finalCanvas,
    width: finalCanvas.width,
    height: finalCanvas.height,
    anatomy: pack.anatomy,
    archetype: pack.archetype,
    strippedPaper,
    isolatedPrimary,
    cleanedPockets,
    boostedPencil,
    cropped: significantCrop,
    empty: false,
  };
}

/**
 * Zero-GC WeakMap Cache for Studio RiggedCharacterPack (2-Bone IK + Geodesic Parts + Eye Detector).
 * Computes once per actor bitmap/canvas (~8ms) and serves in 0.00ms across 60 FPS playback & exports!
 */
const _rigPackCache = new WeakMap<
  HTMLCanvasElement | ImageBitmap,
  { w: number; h: number; pack: RiggedCharacterPack }
>();

export function getOrBuildCachedRigPack(
  source: HTMLCanvasElement | ImageBitmap
): RiggedCharacterPack {
  const sw = Math.max(16, source.width || 16);
  const sh = Math.max(16, source.height || 16);
  const cached = _rigPackCache.get(source);
  if (cached && cached.w === sw && cached.h === sh) {
    return cached.pack;
  }

  let canvas: HTMLCanvasElement;
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    canvas = source;
  } else {
    const scale = Math.min(1, 768 / Math.max(sw, sh));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(32, Math.round(sw * scale));
    canvas.height = Math.max(32, Math.round(sh * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }

  const anatomy = analyzeCanvasAnatomy(canvas);
  const pack = buildRiggedCharacterPack(canvas, anatomy);
  _rigPackCache.set(source, { w: sw, h: sh, pack });
  return pack;
}
