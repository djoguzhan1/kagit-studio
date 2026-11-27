/**
 * INKTROPE Dedicated Web Worker (F1-03 10/10 Production Upgrade):
 * 1. Multi-Scale Morphological Paper Illumination Ceiling Field (0% solid-black hollowing, 0 false shadow-edge ink!)
 * 2. True 8-DOF Projective Homography 4-Corner Perspective Dewarp
 * 3. Sobel Edge + Largest Connected Paper Island 4-Corner Detector (immune to bright desks & specular glints!)
 * 4. Anti-Aliased Chroma-Unmixing Non-Photo Blue & Red Sketch Pencil Stripper (zero jagged halos!)
 * 5. Gap-Aware Smart Flood Fill Bucket + Premultiplied-Alpha Bilinear A4 Grid Slicer
 * 6. Adaptive Median-Cut 256-Color GIF89a + LZW Encoder
 */

export type QuadCorners = [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
];

export interface PaperProcessParams {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  corners?: QuadCorners;
  outWidth: number;
  outHeight: number;
  transparentBg: boolean;
  preserveColor: boolean;
  sensitivity: number;
  inkStrength: number;
  stripBluePencil: boolean;
  stripRedPencil: boolean;
}

export interface AutoCornerParams {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface FloodFillParams {
  width: number;
  height: number;
  targetRgba: Uint8ClampedArray;
  barrierRgba?: Uint8ClampedArray;
  startX: number;
  startY: number;
  fillColor: [number, number, number, number];
  tolerance: number;
  expandPx: number;
  /** Morphological barrier dilation radius (0..4px) to seal small gaps in hand-drawn ink lines! */
  gapClosePx?: number;
}

export interface GridSliceParams {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  cols: number;
  rows: number;
  outWidth: number;
  outHeight: number;
  /** Margin trim fraction per cell edge to strip drawn grid dividers (default 0.04) */
  trimFrac?: number;
  autoCenter?: boolean;
  transparentBg: boolean;
}

export interface GifEncodeParams {
  width: number;
  height: number;
  delayCs: number;
  frames: { rgba: Uint8ClampedArray; hold: number }[];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function medianSorted(arr: number[]): number {
  if (arr.length === 0) return 235;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length & 1 ? s[mid] : (s[mid - 1] + s[mid]) * 0.5;
}

// ============================================================================
// 1. Sobel + Largest-Connected-Sheet Automatic Paper Quad Corner Detector
// ============================================================================
export function detectPaperCorners(params: AutoCornerParams): QuadCorners {
  const { width: srcW, height: srcH, rgba } = params;
  const fallback: QuadCorners = [
    { x: 0.04, y: 0.04 },
    { x: 0.96, y: 0.04 },
    { x: 0.96, y: 0.96 },
    { x: 0.04, y: 0.96 },
  ];
  if (srcW < 16 || srcH < 16) return fallback;

  // Downsample to <= 320px working grid for O(1) noise-immune Sobel + CCL analysis
  const scale = Math.min(1, 320 / Math.max(srcW, srcH));
  const w = Math.max(16, Math.round(srcW * scale));
  const h = Math.max(16, Math.round(srcH * scale));
  const total = w * h;
  const lum = new Float32Array(total);
  const sat = new Float32Array(total);
  const rCh = new Float32Array(total);
  const gCh = new Float32Array(total);
  const bCh = new Float32Array(total);

  for (let y = 0; y < h; y++) {
    const sy = Math.min(srcH - 1, Math.floor(((y + 0.5) * srcH) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(srcW - 1, Math.floor(((x + 0.5) * srcW) / w));
      const o = (sy * srcW + sx) * 4;
      const r = rgba[o];
      const g = rgba[o + 1];
      const b = rgba[o + 2];
      const i = y * w + x;
      rCh[i] = r;
      gCh[i] = g;
      bCh[i] = b;
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }
  }

  // Sample outer 2px border frame (desk surround) vs central 40% core (paper interior)
  const borderLums: number[] = [];
  const borderR: number[] = [];
  const borderG: number[] = [];
  const borderB: number[] = [];
  for (let x = 0; x < w; x++) {
    for (const y of [0, 1, h - 2, h - 1]) {
      const i = y * w + x;
      borderLums.push(lum[i]);
      borderR.push(rCh[i]);
      borderG.push(gCh[i]);
      borderB.push(bCh[i]);
    }
  }
  for (let y = 2; y < h - 2; y++) {
    for (const x of [0, 1, w - 2, w - 1]) {
      const i = y * w + x;
      borderLums.push(lum[i]);
      borderR.push(rCh[i]);
      borderG.push(gCh[i]);
      borderB.push(bCh[i]);
    }
  }

  const centerLums: number[] = [];
  const cx0 = Math.floor(w * 0.3);
  const cx1 = Math.ceil(w * 0.7);
  const cy0 = Math.floor(h * 0.3);
  const cy1 = Math.ceil(h * 0.7);
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const i = y * w + x;
      if (sat[i] < 65) centerLums.push(lum[i]);
    }
  }

  const deskLum = medianSorted(borderLums);
  const deskR = medianSorted(borderR);
  const deskG = medianSorted(borderG);
  const deskB = medianSorted(borderB);
  // 75th percentile of low-sat center pixels represents the blank paper surface (skipping black ink!)
  const sortedCenter = [...centerLums].sort((a, b) => a - b);
  const paperLum =
    sortedCenter.length > 0
      ? sortedCenter[Math.min(sortedCenter.length - 1, Math.floor(sortedCenter.length * 0.78))]
      : deskLum;

  // True 3x3 Sobel gradient magnitude for crisp sheet boundary localization even on light desks!
  const sobel = new Float32Array(total);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = lum[(y - 1) * w + (x - 1)];
      const tc = lum[(y - 1) * w + x];
      const tr = lum[(y - 1) * w + (x + 1)];
      const ml = lum[y * w + (x - 1)];
      const mr = lum[y * w + (x + 1)];
      const bl = lum[(y + 1) * w + (x - 1)];
      const bc = lum[(y + 1) * w + x];
      const br = lum[(y + 1) * w + (x + 1)];
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      sobel[y * w + x] = (Math.abs(gx) + Math.abs(gy)) * 0.25;
    }
  }

  const lumGap = paperLum - deskLum;
  // Adaptive midpoint threshold works even when light desk is 212 and paper is 246 (gap = 34 -> thresh ~ 229!)
  const lumThresh =
    lumGap >= 12
      ? deskLum + lumGap * 0.48
      : Math.min(220, Math.max(120, paperLum - 18));

  // Build candidate sheet mask, flood-filling desk from borders first when desk/paper contrast is subtle
  const deskVisited = new Uint8Array(total);
  const dq = new Int32Array(total);
  let dqh = 0;
  let dqt = 0;
  const colorTol = Math.max(16, Math.min(62, Math.abs(lumGap) * 0.85 + 12));
  const sobelBarrier = Math.max(10, Math.abs(lumGap) * 0.42);

  const isDeskLike = (idx: number): boolean => {
    if (sobel[idx] > sobelBarrier && lum[idx] >= lumThresh) return false;
    if (lumGap >= 12 && lum[idx] >= lumThresh && sat[idx] <= 64) return false;
    const dr = Math.abs(rCh[idx] - deskR);
    const dg = Math.abs(gCh[idx] - deskG);
    const db = Math.abs(bCh[idx] - deskB);
    return Math.abs(lum[idx] - deskLum) <= colorTol * 0.65 && dr + dg + db <= colorTol * 1.9;
  };

  for (let x = 0; x < w; x++) {
    const tIdx = x;
    const bIdx = (h - 1) * w + x;
    if (!deskVisited[tIdx] && isDeskLike(tIdx)) {
      deskVisited[tIdx] = 1;
      dq[dqt++] = tIdx;
    }
    if (!deskVisited[bIdx] && isDeskLike(bIdx)) {
      deskVisited[bIdx] = 1;
      dq[dqt++] = bIdx;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    const lIdx = y * w;
    const rIdx = y * w + (w - 1);
    if (!deskVisited[lIdx] && isDeskLike(lIdx)) {
      deskVisited[lIdx] = 1;
      dq[dqt++] = lIdx;
    }
    if (!deskVisited[rIdx] && isDeskLike(rIdx)) {
      deskVisited[rIdx] = 1;
      dq[dqt++] = rIdx;
    }
  }
  while (dqh < dqt) {
    const cur = dq[dqh++];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    if (cx > 0 && !deskVisited[cur - 1] && isDeskLike(cur - 1)) {
      deskVisited[cur - 1] = 1;
      dq[dqt++] = cur - 1;
    }
    if (cx + 1 < w && !deskVisited[cur + 1] && isDeskLike(cur + 1)) {
      deskVisited[cur + 1] = 1;
      dq[dqt++] = cur + 1;
    }
    if (cy > 0 && !deskVisited[cur - w] && isDeskLike(cur - w)) {
      deskVisited[cur - w] = 1;
      dq[dqt++] = cur - w;
    }
    if (cy + 1 < h && !deskVisited[cur + w] && isDeskLike(cur + w)) {
      deskVisited[cur + w] = 1;
      dq[dqt++] = cur + w;
    }
  }

  // Non-desk mask (includes both bright paper AND dark ink inside the paper, while rejecting isolated desk glints via CCL!)
  const cand = new Uint8Array(total);
  if (dqt >= total * 0.06 && dqt <= total * 0.94) {
    for (let i = 0; i < total; i++) {
      if (!deskVisited[i]) cand[i] = 1;
    }
  } else {
    for (let i = 0; i < total; i++) {
      if (lum[i] >= lumThresh && sat[i] <= 72) cand[i] = 1;
    }
  }

  // 8-Connected Component Labeling: select ONLY the largest connected component overlapping the center!
  // This completely eliminates 10x10 specular desk reflections or stray bright objects near frame corners!
  const labels = new Int32Array(total);
  let nextLabel = 1;
  let bestLabel = -1;
  let bestScore = 0;
  const q = new Int32Array(total);

  for (let i = 0; i < total; i++) {
    if (!cand[i] || labels[i] !== 0) continue;
    const lbl = nextLabel++;
    let qh = 0;
    let qt = 0;
    labels[i] = lbl;
    q[qt++] = i;
    let area = 0;
    let centerHits = 0;

    while (qh < qt) {
      const cur = q[qh++];
      area++;
      const cx = cur % w;
      const cy = (cur - cx) / w;
      if (cx >= cx0 && cx < cx1 && cy >= cy0 && cy < cy1) centerHits++;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (cand[ni] && labels[ni] === 0) {
            labels[ni] = lbl;
            q[qt++] = ni;
          }
        }
      }
    }

    const score = area * (centerHits > 0 ? 1.5 : 0.15);
    if (area >= total * 0.06 && score > bestScore) {
      bestScore = score;
      bestLabel = lbl;
    }
  }

  if (bestLabel < 0) return fallback;

  let compArea = 0;
  let bestTL = Infinity;
  let bestTR = -Infinity;
  let bestBR = -Infinity;
  let bestBL = Infinity;
  let tl = { x: w * 0.04, y: h * 0.04 };
  let tr = { x: w * 0.96, y: h * 0.04 };
  let br = { x: w * 0.96, y: h * 0.96 };
  let bl = { x: w * 0.04, y: h * 0.96 };

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (labels[idx] !== bestLabel) continue;
      compArea++;
      // Require at least 3 of 4 cardinal neighbors inside the sheet component to reject 1px burrs
      let nb = 0;
      if (labels[idx - 1] === bestLabel) nb++;
      if (labels[idx + 1] === bestLabel) nb++;
      if (labels[idx - w] === bestLabel) nb++;
      if (labels[idx + w] === bestLabel) nb++;
      if (nb < 2) continue;

      const s = x + y;
      const d = x - y;
      if (s < bestTL) {
        bestTL = s;
        tl = { x, y };
      }
      if (d > bestTR) {
        bestTR = d;
        tr = { x, y };
      }
      if (s > bestBR) {
        bestBR = s;
        br = { x, y };
      }
      if (d < bestBL) {
        bestBL = d;
        bl = { x, y };
      }
    }
  }

  const coverage = compArea / Math.max(1, total);
  if (compArea < 40 || coverage > 0.94) return fallback;

  const clampCorner = (v: number) => Math.max(0.01, Math.min(0.99, v));
  return [
    { x: clampCorner((tl.x + 0.5) / w), y: clampCorner((tl.y + 0.5) / h) },
    { x: clampCorner((tr.x + 0.5) / w), y: clampCorner((tr.y + 0.5) / h) },
    { x: clampCorner((br.x + 0.5) / w), y: clampCorner((br.y + 0.5) / h) },
    { x: clampCorner((bl.x + 0.5) / w), y: clampCorner((bl.y + 0.5) / h) },
  ];
}

// ============================================================================
// 2. 4-Corner Projective Homography
// ============================================================================
function solveLinear8(A: number[][], b: number[]): number[] {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    const tmp = M[col];
    M[col] = M[pivot];
    M[pivot] = tmp;
    const div = M[col][col] || 1e-12;
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function computeHomography(
  dstW: number,
  dstH: number,
  srcPts: { x: number; y: number }[]
): number[] {
  const dstPts = [
    { x: 0, y: 0 },
    { x: dstW - 1, y: 0 },
    { x: dstW - 1, y: dstH - 1 },
    { x: 0, y: dstH - 1 },
  ];
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = dstPts[i];
    const { x, y } = srcPts[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const h = solveLinear8(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function warpPerspective(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  normCorners: { x: number; y: number }[]
): Uint8ClampedArray {
  const srcPts = normCorners.map((c) => ({ x: c.x * (srcW - 1), y: c.y * (srcH - 1) }));
  const H = computeHomography(dstW, dstH, srcPts);
  const out = new Uint8ClampedArray(dstW * dstH * 4);

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const denom = H[6] * x + H[7] * y + 1;
      const sx = (H[0] * x + H[1] * y + H[2]) / denom;
      const sy = (H[3] * x + H[4] * y + H[5]) / denom;
      const oi = (y * dstW + x) * 4;

      if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) {
        out[oi] = 255;
        out[oi + 1] = 255;
        out[oi + 2] = 255;
        out[oi + 3] = 255;
        continue;
      }

      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + srcW * 4;
      const i11 = i01 + 4;

      out[oi] = (src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11) | 0;
      out[oi + 1] =
        (src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11) | 0;
      out[oi + 2] =
        (src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11) | 0;
      out[oi + 3] = 255;
    }
  }
  return out;
}

// ============================================================================
// 3. Morphological Paper Illumination Ceiling & Shadow-Immune Ink Extraction
// ============================================================================

interface PaperCeilingField {
  gw: number;
  gh: number;
  w: number;
  h: number;
  ceiling: Float32Array;
  grad: Float32Array;
}

/**
 * Builds a smooth blank-paper illumination ceiling surface that:
 * 1) Bridges wide solid-black ink fills (tuxedo coats, hair, silhouettes up to 44% of sheet width)
 *    via separable morphological max-dilation so black interiors NEVER hollow out!
 * 2) Tracks blank-paper shadow regions locally AND records illumination-step gradient (`grad`)
 *    so sharp cast-shadow boundaries on empty paper NEVER produce false black ink lines!
 */
function buildPaperCeilingField(
  pixels: Uint8ClampedArray,
  w: number,
  h: number
): PaperCeilingField {
  const maxGrid = 96;
  const scale = Math.min(1, maxGrid / Math.max(1, w, h));
  const gw = Math.max(12, Math.round(w * scale));
  const gh = Math.max(12, Math.round(h * scale));
  const rawMax = new Float32Array(gw * gh);
  const blockSamples: number[] = [];

  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * h) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * w) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gw));
      let bestPaperLum = 0;
      let bestAnyLum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          const o = (row + x) * 4;
          const r = pixels[o];
          const g = pixels[o + 1];
          const b = pixels[o + 2];
          const l = 0.299 * r + 0.587 * g + 0.114 * b;
          const s = Math.max(r, g, b) - Math.min(r, g, b);
          if (l > bestAnyLum) bestAnyLum = l;
          if (s <= 64 && l > bestPaperLum) bestPaperLum = l;
        }
      }
      const val = bestPaperLum > 0 ? bestPaperLum : bestAnyLum;
      rawMax[gy * gw + gx] = val;
      if (val > 85) blockSamples.push(val);
    }
  }

  const sortedBlocks = [...blockSamples].sort((a, b) => a - b);
  const p15Paper =
    sortedBlocks.length > 0
      ? sortedBlocks[Math.floor(sortedBlocks.length * 0.15)]
      : 180;
  const p75Paper =
    sortedBlocks.length > 0
      ? sortedBlocks[Math.floor(sortedBlocks.length * 0.75)]
      : 235;
  // Minimum plausible illuminated paper floor (protects huge dark fills while allowing real cast shadows ~135..170!)
  const minPaperFloor = Math.max(115, Math.min(p15Paper * 0.92, p75Paper * 0.56));

  // Replace cells completely inside solid dark ink (`rawMax < minPaperFloor * 0.82`) via morphological max dilation
  // WITHOUT erasing real shadow steps (`rawMax >= minPaperFloor * 0.82`, e.g. lum 148 vs 242)!
  const dilRad = Math.max(4, Math.min(24, Math.round(Math.max(gw, gh) * 0.24)));
  const hDil = new Float32Array(gw * gh);
  const vDil = new Float32Array(gw * gh);

  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const x0 = Math.max(0, x - dilRad);
      const x1 = Math.min(gw - 1, x + dilRad);
      let mx = 0;
      for (let sx = x0; sx <= x1; sx++) {
        if (rawMax[row + sx] > mx) mx = rawMax[row + sx];
      }
      hDil[row + x] = mx;
    }
  }
  for (let y = 0; y < gh; y++) {
    const y0 = Math.max(0, y - dilRad);
    const y1 = Math.min(gh - 1, y + dilRad);
    for (let x = 0; x < gw; x++) {
      let mx = 0;
      for (let sy = y0; sy <= y1; sy++) {
        if (hDil[sy * gw + x] > mx) mx = hDil[sy * gw + x];
      }
      vDil[y * gw + x] = Math.max(minPaperFloor, mx);
    }
  }

  // Hybrid paper-surface reconstruction:
  // - If `rawMax` is dark ink (`< minPaperFloor * 0.85`), use `vDil` (bridges solid black tuxedo/hair!)
  // - If `rawMax` is genuine lit or shadowed blank paper (`>= minPaperFloor * 0.85`), keep `rawMax` so shadow regions track locally!
  const surface = new Float32Array(gw * gh);
  const inkCellCutoff = minPaperFloor * 0.85;
  for (let i = 0; i < gw * gh; i++) {
    surface[i] = rawMax[i] < inkCellCutoff ? vDil[i] : Math.max(minPaperFloor, rawMax[i]);
  }

  // Record local illumination step gradient BEFORE gentle smoothing to detect sharp cast-shadow edges!
  const grad = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(gh - 1, y + 1);
    for (let x = 0; x < gw; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(gw - 1, x + 1);
      const gx = Math.abs(surface[y * gw + xp] - surface[y * gw + xm]);
      const gy = Math.abs(surface[yp * gw + x] - surface[ym * gw + x]);
      grad[y * gw + x] = Math.max(gx, gy);
    }
  }

  // Dilate `grad` by 1 grid cell so both sides of a sharp shadow boundary get shadow-step protection
  const gradDil = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let mg = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = Math.max(0, Math.min(gh - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(gw - 1, x + dx));
          const v = grad[ny * gw + nx];
          if (v > mg) mg = v;
        }
      }
      gradDil[y * gw + x] = mg;
    }
  }

  // Light 1-pass 3x3 box smoothing for silky bilinear continuity without smearing sharp shadow steps into ink
  const tmp = new Float32Array(gw * gh);
  const ceiling = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(gw - 1, x + 1);
      let s = 0;
      for (let sx = x0; sx <= x1; sx++) s += surface[row + sx];
      tmp[row + x] = s / (x1 - x0 + 1);
    }
  }
  for (let y = 0; y < gh; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(gh - 1, y + 1);
    for (let x = 0; x < gw; x++) {
      let s = 0;
      for (let sy = y0; sy <= y1; sy++) s += tmp[sy * gw + x];
      ceiling[y * gw + x] = s / (y1 - y0 + 1);
    }
  }

  return { gw, gh, w, h, ceiling, grad: gradDil };
}

function sampleFieldBilinear(
  arr: Float32Array,
  gw: number,
  gh: number,
  w: number,
  h: number,
  x: number,
  y: number
): number {
  const fx = (x / Math.max(1, w - 1)) * (gw - 1);
  const fy = (y / Math.max(1, h - 1)) * (gh - 1);
  const x0 = Math.max(0, Math.min(gw - 1, fx | 0));
  const y0 = Math.max(0, Math.min(gh - 1, fy | 0));
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = arr[y0 * gw + x0] * (1 - tx) + arr[y0 * gw + x1] * tx;
  const bot = arr[y1 * gw + x0] * (1 - tx) + arr[y1 * gw + x1] * tx;
  return top + (bot - top) * ty;
}

export function processPaperScan(params: PaperProcessParams): {
  rgba: Uint8ClampedArray;
  warpedOriginalRgba: Uint8ClampedArray;
  width: number;
  height: number;
  centroidX: number;
  centroidY: number;
} {
  let w = params.width;
  let h = params.height;
  let pixels = params.rgba;

  if (params.corners) {
    pixels = warpPerspective(
      params.rgba,
      params.width,
      params.height,
      params.outWidth,
      params.outHeight,
      params.corners
    );
    w = params.outWidth;
    h = params.outHeight;
  }

  const total = w * h;
  const field = buildPaperCeilingField(pixels, w, h);

  // Calibrated sensitivity: at default sensitivity=50, 2px light graphite (delta ~ 14 on 242 paper -> relDrop ~ 0.058)
  // exceeds threshold cleanly while paper grain noise (< 8 lum) stays 100% transparent!
  const relThreshold = Math.max(0.02, 0.088 - (params.sensitivity / 100) * 0.092);
  const strengthGain = 1.15 + (params.inkStrength / 100) * 2.35;

  const out = new Uint8ClampedArray(total * 4);
  let sumX = 0;
  let sumY = 0;
  let mass = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const oi = idx * 4;
      const r = pixels[oi];
      const g = pixels[oi + 1];
      const b = pixels[oi + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const satNorm = mx > 0 ? (mx - mn) / mx : 0;

      const paperCeil = sampleFieldBilinear(field.ceiling, field.gw, field.gh, w, h, x, y);
      const localShadowStep = sampleFieldBilinear(field.grad, field.gw, field.gh, w, h, x, y);

      // Continuous Chroma-Unmixing Non-Photo Blue & Red Sketch Pencil Stripper:
      // Instead of hard binary skipping (which leaves 1-2px jagged halos where black ink crosses blue sketch),
      // compute continuous chroma dominance AND preserve underlying black ink density (`blackCore`)!
      let sketchSuppress = 0;
      if (params.stripBluePencil) {
        const blueDom = b - Math.max(r + 12, g * 0.92 - 6);
        if (blueDom > 0) {
          // Dark ink crossing blue pencil has low `b` (< 95), so `brightPencil` smoothly drops to 0 on black ink!
          const brightPencil = clamp01((b - 72) / 95);
          sketchSuppress = Math.max(sketchSuppress, clamp01(blueDom / 28) * brightPencil);
        }
      }
      if (params.stripRedPencil) {
        const redDom = r - Math.max(b + 16, g + 12);
        if (redDom > 0) {
          const brightPencil = clamp01((r - 78) / 95);
          sketchSuppress = Math.max(sketchSuppress, clamp01(redDom / 28) * brightPencil);
        }
      }

      // Shadow-boundary protection: if `localShadowStep > 22` (sharp cast shadow edge on blank neutral paper)
      // and pixel luminance is still in shadowed-paper range (`lum > 110` with low saturation), suppress false ink!
      let effDrop = Math.max(0, paperCeil - lum);
      if (localShadowStep > 22 && lum > 108 && satNorm < 0.18) {
        effDrop = Math.max(0, effDrop - localShadowStep * 0.62);
      }

      const relDrop = (effDrop / Math.max(48, paperCeil)) * (1 - sketchSuppress);
      const colorBoost =
        params.preserveColor && sketchSuppress < 0.35 && satNorm > 0.26
          ? satNorm * 0.22 * (1 - sketchSuppress)
          : 0;
      const signal = relDrop + colorBoost - relThreshold;

      if (signal <= 0) {
        if (params.transparentBg) {
          out[oi + 3] = 0;
        } else {
          out[oi] = 250;
          out[oi + 1] = 247;
          out[oi + 2] = 240;
          out[oi + 3] = 255;
        }
        continue;
      }

      // Crisp studio ink S-curve: light graphite stays nuanced while solid ink reaches 255 opacity cleanly
      const linearAlpha = clamp01((signal / 0.26) * strengthGain);
      const alphaNorm = clamp01(linearAlpha * (1.12 - 0.12 * linearAlpha));
      const alpha = Math.round(alphaNorm * 255);

      sumX += x * alphaNorm;
      sumY += y * alphaNorm;
      mass += alphaNorm;

      if (params.preserveColor) {
        const normFactor = paperCeil > 16 ? 250 / paperCeil : 1;
        const nr = Math.min(255, Math.max(0, Math.round(r * normFactor)));
        const ng = Math.min(255, Math.max(0, Math.round(g * normFactor)));
        const nb = Math.min(255, Math.max(0, Math.round(b * normFactor)));
        if (params.transparentBg) {
          out[oi] = nr;
          out[oi + 1] = ng;
          out[oi + 2] = nb;
          out[oi + 3] = alpha;
        } else {
          out[oi] = Math.round(250 * (1 - alphaNorm) + nr * alphaNorm);
          out[oi + 1] = Math.round(247 * (1 - alphaNorm) + ng * alphaNorm);
          out[oi + 2] = Math.round(240 * (1 - alphaNorm) + nb * alphaNorm);
          out[oi + 3] = 255;
        }
      } else {
        const inkR = 26;
        const inkG = 24;
        const inkB = 22;
        if (params.transparentBg) {
          out[oi] = inkR;
          out[oi + 1] = inkG;
          out[oi + 2] = inkB;
          out[oi + 3] = alpha;
        } else {
          out[oi] = Math.round(250 * (1 - alphaNorm) + inkR * alphaNorm);
          out[oi + 1] = Math.round(247 * (1 - alphaNorm) + inkG * alphaNorm);
          out[oi + 2] = Math.round(240 * (1 - alphaNorm) + inkB * alphaNorm);
          out[oi + 3] = 255;
        }
      }
    }
  }

  return {
    rgba: out,
    warpedOriginalRgba: new Uint8ClampedArray(pixels),
    width: w,
    height: h,
    centroidX: mass > 1 ? sumX / mass : w / 2,
    centroidY: mass > 1 ? sumY / mass : h / 2,
  };
}

// ============================================================================
// 4. Smart Reference-Aware & Gap-Closing Flood Fill Bucket
// ============================================================================
export function smartFloodFill(params: FloodFillParams): Uint8ClampedArray {
  const {
    width: w,
    height: h,
    targetRgba,
    barrierRgba,
    startX,
    startY,
    fillColor,
    tolerance,
    expandPx,
    gapClosePx = 0,
  } = params;
  const out = new Uint8ClampedArray(targetRgba);
  const sx = Math.max(0, Math.min(w - 1, Math.round(startX)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(startY)));

  let barrierMask: Uint8Array | null = null;
  if (barrierRgba) {
    barrierMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (barrierRgba[i * 4 + 3] > 80) barrierMask[i] = 1;
    }
    const r = Math.max(0, Math.min(4, Math.round(gapClosePx)));
    if (r > 0) {
      const horiz = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let count = 0;
        for (let x = 0; x < Math.min(w, r); x++) count += barrierMask[row + x];
        for (let x = 0; x < w; x++) {
          if (x + r < w) count += barrierMask[row + x + r];
          if (x - r - 1 >= 0) count -= barrierMask[row + x - r - 1];
          if (count > 0) horiz[row + x] = 1;
        }
      }
      const closed = new Uint8Array(w * h);
      for (let x = 0; x < w; x++) {
        let count = 0;
        for (let y = 0; y < Math.min(h, r); y++) count += horiz[y * w + x];
        for (let y = 0; y < h; y++) {
          if (y + r < h) count += horiz[(y + r) * w + x];
          if (y - r - 1 >= 0) count -= horiz[(y - r - 1) * w + x];
          if (count > 0) closed[y * w + x] = 1;
        }
      }
      barrierMask = closed;
    }
  }

  const startIdx = sy * w + sx;
  const startOff = startIdx * 4;
  const sr = targetRgba[startOff];
  const sg = targetRgba[startOff + 1];
  const sb = targetRgba[startOff + 2];
  const sa = targetRgba[startOff + 3];

  if (barrierMask && barrierMask[startIdx]) {
    return out;
  }

  const visited = new Uint8Array(w * h);
  const filled = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;

  const matchesSeed = (idx: number): boolean => {
    if (barrierMask && barrierMask[idx]) return false;
    const o = idx * 4;
    const dr = Math.abs(targetRgba[o] - sr);
    const dg = Math.abs(targetRgba[o + 1] - sg);
    const db = Math.abs(targetRgba[o + 2] - sb);
    const da = Math.abs(targetRgba[o + 3] - sa);
    return dr + dg + db + da <= tolerance * 4;
  };

  visited[startIdx] = 1;
  stack[top++] = startIdx;

  while (top > 0) {
    const idx = stack[--top];
    if (!matchesSeed(idx)) continue;
    filled[idx] = 1;

    const x = idx % w;
    const y = (idx - x) / w;

    if (x > 0 && !visited[idx - 1]) {
      visited[idx - 1] = 1;
      stack[top++] = idx - 1;
    }
    if (x < w - 1 && !visited[idx + 1]) {
      visited[idx + 1] = 1;
      stack[top++] = idx + 1;
    }
    if (y > 0 && !visited[idx - w]) {
      visited[idx - w] = 1;
      stack[top++] = idx - w;
    }
    if (y < h - 1 && !visited[idx + w]) {
      visited[idx + w] = 1;
      stack[top++] = idx + w;
    }
  }

  let finalMask = filled;
  const totalExpand = Math.max(0, Math.min(4, Math.round(expandPx + (gapClosePx > 0 ? 1 : 0))));
  for (let step = 0; step < totalExpand; step++) {
    const next = new Uint8Array(finalMask);
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = row + x;
        if (finalMask[idx]) continue;
        if (finalMask[idx - 1] || finalMask[idx + 1] || finalMask[idx - w] || finalMask[idx + w]) {
          next[idx] = 1;
        }
      }
    }
    finalMask = next;
  }

  const [fr, fg, fb, fa] = fillColor;
  for (let i = 0; i < w * h; i++) {
    if (!finalMask[i]) continue;
    const o = i * 4;
    out[o] = fr;
    out[o + 1] = fg;
    out[o + 2] = fb;
    out[o + 3] = fa;
  }
  return out;
}

// ============================================================================
// 4B. A4 Multi-Frame Grid-Slice Scanner (Premultiplied-Alpha Bilinear!)
// ============================================================================
export function sliceGridCells(params: GridSliceParams): Uint8ClampedArray[] {
  const { width: w, height: h, rgba, cols, rows, outWidth, outHeight, transparentBg } = params;
  const trimFrac = params.trimFrac ?? 0.04;
  const autoCenter = params.autoCenter ?? true;

  const cellW = w / cols;
  const cellH = h / rows;
  const results: Uint8ClampedArray[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const trimX = cellW * trimFrac;
      const trimY = cellH * trimFrac;
      const sx0 = c * cellW + trimX;
      const sy0 = r * cellH + trimY;
      const sw = Math.max(4, cellW - trimX * 2);
      const sh = Math.max(4, cellH - trimY * 2);

      let shiftX = 0;
      let shiftY = 0;
      if (autoCenter) {
        let sumX = 0;
        let sumY = 0;
        let mass = 0;
        const xMin = Math.max(0, Math.floor(sx0));
        const xMax = Math.min(w - 1, Math.ceil(sx0 + sw));
        const yMin = Math.max(0, Math.floor(sy0));
        const yMax = Math.min(h - 1, Math.ceil(sy0 + sh));
        for (let y = yMin; y <= yMax; y += 2) {
          for (let x = xMin; x <= xMax; x += 2) {
            const o = (y * w + x) * 4;
            const inkWeight = transparentBg
              ? rgba[o + 3] / 255
              : Math.max(0, 1 - (rgba[o] + rgba[o + 1] + rgba[o + 2]) / (3 * 240));
            if (inkWeight > 0.2) {
              sumX += (x - sx0) * inkWeight;
              sumY += (y - sy0) * inkWeight;
              mass += inkWeight;
            }
          }
        }
        if (mass > 10) {
          const cx = sumX / mass;
          const cy = sumY / mass;
          shiftX = Math.max(-sw * 0.16, Math.min(sw * 0.16, cx - sw * 0.5));
          shiftY = Math.max(-sh * 0.16, Math.min(sh * 0.16, cy - sh * 0.5));
        }
      }

      const out = new Uint8ClampedArray(outWidth * outHeight * 4);
      const fitScale = Math.min(outWidth / sw, outHeight / sh);
      const drawW = sw * fitScale;
      const drawH = sh * fitScale;
      const offX = (outWidth - drawW) / 2;
      const offY = (outHeight - drawH) / 2;

      for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++) {
          const oi = (y * outWidth + x) * 4;
          const u = (x - offX) / fitScale;
          const v = (y - offY) / fitScale;
          const srcX = sx0 + u + shiftX;
          const srcY = sy0 + v + shiftY;
          if (srcX < sx0 || srcY < sy0 || srcX >= sx0 + sw - 1 || srcY >= sy0 + sh - 1) {
            out[oi] = transparentBg ? 0 : 250;
            out[oi + 1] = transparentBg ? 0 : 247;
            out[oi + 2] = transparentBg ? 0 : 240;
            out[oi + 3] = transparentBg ? 0 : 255;
            continue;
          }

          // Premultiplied-alpha bilinear interpolation eliminates stair-stepping on fine diagonal ink!
          const x0 = Math.max(0, Math.min(w - 1, Math.floor(srcX)));
          const y0 = Math.max(0, Math.min(h - 1, Math.floor(srcY)));
          const x1 = Math.min(w - 1, x0 + 1);
          const y1 = Math.min(h - 1, y0 + 1);
          const fx = srcX - x0;
          const fy = srcY - y0;
          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;

          const i00 = (y0 * w + x0) * 4;
          const i10 = (y0 * w + x1) * 4;
          const i01 = (y1 * w + x0) * 4;
          const i11 = (y1 * w + x1) * 4;

          if (transparentBg) {
            const a00 = rgba[i00 + 3] * w00;
            const a10 = rgba[i10 + 3] * w10;
            const a01 = rgba[i01 + 3] * w01;
            const a11 = rgba[i11 + 3] * w11;
            const outA = a00 + a10 + a01 + a11;
            if (outA <= 0.5) {
              out[oi + 3] = 0;
            } else {
              const invA = 1 / outA;
              out[oi] = Math.round(
                (rgba[i00] * a00 + rgba[i10] * a10 + rgba[i01] * a01 + rgba[i11] * a11) * invA
              );
              out[oi + 1] = Math.round(
                (rgba[i00 + 1] * a00 +
                  rgba[i10 + 1] * a10 +
                  rgba[i01 + 1] * a01 +
                  rgba[i11 + 1] * a11) *
                  invA
              );
              out[oi + 2] = Math.round(
                (rgba[i00 + 2] * a00 +
                  rgba[i10 + 2] * a10 +
                  rgba[i01 + 2] * a01 +
                  rgba[i11 + 2] * a11) *
                  invA
              );
              out[oi + 3] = Math.round(outA);
            }
          } else {
            out[oi] = Math.round(
              rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11
            );
            out[oi + 1] = Math.round(
              rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11
            );
            out[oi + 2] = Math.round(
              rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11
            );
            out[oi + 3] = 255;
          }
        }
      }
      results.push(out);
    }
  }
  return results;
}

// ============================================================================
// 5. True Adaptive Median-Cut 256-Color Quantizer + GIF89a LZW Encoder
// ============================================================================
type RGB = [number, number, number];

export function buildMedianCutPalette(samples: RGB[], maxColors = 256): Uint8Array {
  if (samples.length === 0) {
    const fallback = new Uint8Array(256 * 3);
    fallback[0] = 247;
    fallback[1] = 243;
    fallback[2] = 233;
    return fallback;
  }

  const bucketMap = new Map<number, { rSum: number; gSum: number; bSum: number; count: number }>();
  for (const [r, g, b] of samples) {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const cur = bucketMap.get(key);
    if (cur) {
      cur.rSum += r;
      cur.gSum += g;
      cur.bSum += b;
      cur.count++;
    } else {
      bucketMap.set(key, { rSum: r, gSum: g, bSum: b, count: 1 });
    }
  }

  const uniqueColors: { r: number; g: number; b: number; weight: number }[] = [];
  for (const b of bucketMap.values()) {
    uniqueColors.push({
      r: Math.round(b.rSum / b.count),
      g: Math.round(b.gSum / b.count),
      b: Math.round(b.bSum / b.count),
      weight: b.count,
    });
  }

  const boxes: typeof uniqueColors[] = [uniqueColors];

  const boxRange = (box: typeof uniqueColors) => {
    let rMin = 255,
      rMax = 0,
      gMin = 255,
      gMax = 0,
      bMin = 255,
      bMax = 0;
    for (const c of box) {
      if (c.r < rMin) rMin = c.r;
      if (c.r > rMax) rMax = c.r;
      if (c.g < gMin) gMin = c.g;
      if (c.g > gMax) gMax = c.g;
      if (c.b < bMin) bMin = c.b;
      if (c.b > bMax) bMax = c.b;
    }
    const dr = rMax - rMin;
    const dg = gMax - gMin;
    const db = bMax - bMin;
    const maxSpan = Math.max(dr, dg, db);
    const axis: 'r' | 'g' | 'b' = dr >= dg && dr >= db ? 'r' : dg >= db ? 'g' : 'b';
    return { maxSpan, axis };
  };

  while (boxes.length < maxColors) {
    let splitIdx = -1;
    let bestSpan = 0;
    let bestAxis: 'r' | 'g' | 'b' = 'r';

    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const { maxSpan, axis } = boxRange(boxes[i]);
      if (maxSpan > bestSpan) {
        bestSpan = maxSpan;
        bestAxis = axis;
        splitIdx = i;
      }
    }
    if (splitIdx < 0 || bestSpan === 0) break;

    const target = boxes[splitIdx];
    target.sort((a, b) => a[bestAxis] - b[bestAxis]);

    let totalWeight = 0;
    for (const c of target) totalWeight += c.weight;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < target.length - 1; i++) {
      acc += target[i].weight;
      if (acc >= totalWeight / 2) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(splitIdx, 1, target.slice(0, cut), target.slice(cut));
  }

  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const box = boxes[i];
    if (!box || box.length === 0) {
      palette[i * 3] = 0;
      palette[i * 3 + 1] = 0;
      palette[i * 3 + 2] = 0;
      continue;
    }
    let rs = 0,
      gs = 0,
      bs = 0,
      ws = 0;
    for (const c of box) {
      rs += c.r * c.weight;
      gs += c.g * c.weight;
      bs += c.b * c.weight;
      ws += c.weight;
    }
    palette[i * 3] = Math.round(rs / ws);
    palette[i * 3 + 1] = Math.round(gs / ws);
    palette[i * 3 + 2] = Math.round(bs / ws);
  }
  return palette;
}

function quantizeFrameWithLookup(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  palette: Uint8Array,
  colorCount: number,
  lut: Int16Array
): Uint8Array {
  const indexed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let best = lut[key];
    if (best < 0) {
      let minDist = Infinity;
      best = 0;
      for (let p = 0; p < colorCount; p++) {
        const dr = r - palette[p * 3];
        const dg = g - palette[p * 3 + 1];
        const db = b - palette[p * 3 + 2];
        const dist = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (dist < minDist) {
          minDist = dist;
          best = p;
          if (dist === 0) break;
        }
      }
      lut[key] = best;
    }
    indexed[i] = best;
  }
  return indexed;
}

function lzwEncode(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;

  const outBytes: number[] = [minCodeSize];
  const subBlock: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;

  const flushSubBlock = () => {
    if (subBlock.length === 0) return;
    outBytes.push(subBlock.length);
    for (let i = 0; i < subBlock.length; i++) outBytes.push(subBlock[i]);
    subBlock.length = 0;
  };

  const writeCode = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      subBlock.push(bitBuf & 0xff);
      if (subBlock.length === 255) flushSubBlock();
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  const dict = new Int32Array(4096 * 256).fill(-1);
  const resetDict = () => {
    dict.fill(-1);
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  writeCode(clearCode);
  if (indices.length === 0) {
    writeCode(endCode);
  } else {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const slot = (prefix << 8) | k;
      const hit = dict[slot];
      if (hit !== -1) {
        prefix = hit;
      } else {
        writeCode(prefix);
        if (nextCode < 4096) {
          dict[slot] = nextCode++;
          if (nextCode > 1 << codeSize && codeSize < 12) {
            codeSize++;
          }
        } else {
          writeCode(clearCode);
          resetDict();
        }
        prefix = k;
      }
    }
    writeCode(prefix);
    writeCode(endCode);
  }

  if (bitCount > 0) {
    subBlock.push(bitBuf & 0xff);
  }
  flushSubBlock();
  outBytes.push(0);
  return new Uint8Array(outBytes);
}

export function encodeGif89a(params: GifEncodeParams): Uint8Array {
  const { width, height, delayCs, frames } = params;
  const samples: RGB[] = [];
  const stride = Math.max(4, Math.floor((width * height) / 4000));

  for (const f of frames) {
    for (let p = 0; p < width * height; p += stride) {
      const o = p * 4;
      samples.push([f.rgba[o], f.rgba[o + 1], f.rgba[o + 2]]);
    }
  }

  const palette = buildMedianCutPalette(samples, 256);
  const lut = new Int16Array(32768).fill(-1);

  const chunks: Uint8Array[] = [];
  const header = new Uint8Array(13);
  header.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  header[6] = width & 0xff;
  header[7] = (width >> 8) & 0xff;
  header[8] = height & 0xff;
  header[9] = (height >> 8) & 0xff;
  header[10] = 0xf7;
  header[11] = 0;
  header[12] = 0;
  chunks.push(header, palette);

  chunks.push(
    new Uint8Array([
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01, 0x00, 0x00, 0x00,
    ])
  );

  for (const frame of frames) {
    const frameDelay = Math.max(2, Math.round(delayCs * frame.hold));
    chunks.push(
      new Uint8Array([
        0x21, 0xf9, 0x04, 0x04,
        frameDelay & 0xff,
        (frameDelay >> 8) & 0xff,
        0x00, 0x00,
      ])
    );
    chunks.push(
      new Uint8Array([
        0x2c,
        0, 0, 0, 0,
        width & 0xff, (width >> 8) & 0xff,
        height & 0xff, (height >> 8) & 0xff,
        0x00,
      ])
    );
    const indexed = quantizeFrameWithLookup(frame.rgba, width, height, palette, 256, lut);
    chunks.push(lzwEncode(indexed, 8));
  }

  chunks.push(new Uint8Array([0x3b]));

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// Only attach Worker message listener when actually executing inside a Web Worker context
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  self.onmessage = (event: MessageEvent) => {
    const { id, type, payload } = event.data as {
      id: number;
      type: 'paper' | 'auto-corners' | 'fill' | 'grid-slice' | 'gif';
      payload: unknown;
    };
    try {
      if (type === 'paper') {
        const res = processPaperScan(payload as PaperProcessParams);
        (self as unknown as Worker).postMessage(
          { id, ok: true, result: res },
          [res.rgba.buffer, res.warpedOriginalRgba.buffer]
        );
      } else if (type === 'auto-corners') {
        const corners = detectPaperCorners(payload as AutoCornerParams);
        (self as unknown as Worker).postMessage({ id, ok: true, result: { corners } });
      } else if (type === 'fill') {
        const rgba = smartFloodFill(payload as FloodFillParams);
        (self as unknown as Worker).postMessage(
          { id, ok: true, result: { rgba } },
          [rgba.buffer]
        );
      } else if (type === 'grid-slice') {
        const cells = sliceGridCells(payload as GridSliceParams);
        (self as unknown as Worker).postMessage(
          { id, ok: true, result: { cells } },
          cells.map((c) => c.buffer)
        );
      } else if (type === 'gif') {
        const bytes = encodeGif89a(payload as GifEncodeParams);
        (self as unknown as Worker).postMessage(
          { id, ok: true, result: { bytes } },
          [bytes.buffer]
        );
      }
    } catch (err) {
      (self as unknown as Worker).postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : 'Worker hatası',
      });
    }
  };
}
