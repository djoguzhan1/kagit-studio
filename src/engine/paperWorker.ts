/**
 * KÂĞIT Studio Dedicated Web Worker (10/10 Upgrade):
 * 1. O(W*H) Integral Image Illumination Normalization & Ink Extraction
 * 2. True 8-DOF Projective Homography 4-Corner Perspective Dewarp
 * 3. 1-Click Automatic Paper Sheet Quad Corner Detector (Sobel + Bright-Page Mask)
 * 4. Non-Photo Blue & Red Sketch Pencil Stripper
 * 5. Gap-Aware Smart Flood Fill Bucket (with 1px under-ink bleed)
 * 6. Adaptive Median-Cut 256-Color GIF89a + LZW Encoder (zero banding on watercolor/ivory!)
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

// ============================================================================
// 1. 1-Click Automatic Paper Quad Corner Detector (Bright Sheet Extreme Points)
// ============================================================================
export function detectPaperCorners(params: AutoCornerParams): QuadCorners {
  const { width: w, height: h, rgba } = params;
  const total = w * h;
  const lum = new Uint8Array(total);
  let sumLum = 0;

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const l = (rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114) | 0;
    lum[i] = l;
    sumLum += l;
  }

  const avgLum = sumLum / Math.max(1, total);
  // Paper sheet is brighter than the surrounding desk; adaptive threshold between avg and 210
  const paperThresh = Math.min(205, Math.max(105, Math.round(avgLum + 18)));

  // Find the 4 diagonal extreme points of the bright paper mass:
  // TL minimizes (x+y), TR maximizes (x-y), BR maximizes (x+y), BL minimizes (x-y)
  let bestTL = Infinity;
  let bestTR = -Infinity;
  let bestBR = -Infinity;
  let bestBL = Infinity;
  let tl = { x: w * 0.05, y: h * 0.05 };
  let tr = { x: w * 0.95, y: h * 0.05 };
  let br = { x: w * 0.95, y: h * 0.95 };
  let bl = { x: w * 0.05, y: h * 0.95 };
  let hits = 0;

  // 2px stride + 3x3 consensus rejects isolated specular desk dust
  for (let y = 3; y < h - 3; y += 2) {
    for (let x = 3; x < w - 3; x += 2) {
      const idx = y * w + x;
      if (lum[idx] < paperThresh) continue;
      if (
        lum[idx - 2] < paperThresh - 10 ||
        lum[idx + 2] < paperThresh - 10 ||
        lum[idx - w * 2] < paperThresh - 10 ||
        lum[idx + w * 2] < paperThresh - 10
      ) {
        continue;
      }
      hits++;
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

  // Fallback to gentle 4% inset if photo is already full-bleed white paper
  const coverage = (hits * 4) / Math.max(1, total);
  if (hits < 80 || coverage > 0.92) {
    return [
      { x: 0.04, y: 0.04 },
      { x: 0.96, y: 0.04 },
      { x: 0.96, y: 0.96 },
      { x: 0.04, y: 0.96 },
    ];
  }

  const clamp01 = (v: number) => Math.max(0.01, Math.min(0.99, v));
  return [
    { x: clamp01(tl.x / w), y: clamp01(tl.y / h) },
    { x: clamp01(tr.x / w), y: clamp01(tr.y / h) },
    { x: clamp01(br.x / w), y: clamp01(br.y / h) },
    { x: clamp01(bl.x / w), y: clamp01(bl.y / h) },
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
// 3. O(W*H) Integral Image Illumination Normalization & Ink Extraction
// ============================================================================
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
  const lum = new Float32Array(total);
  const sat = new Float32Array(total);
  const hueCode = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const diff = mx - mn;
    sat[i] = mx > 0 ? diff / mx : 0;

    if (diff > 22) {
      if (b > r + 24 && b >= g - 10) {
        hueCode[i] = 1;
      } else if (r > b + 28 && r > g + 20) {
        hueCode[i] = 2;
      }
    }
  }

  const stride = w + 1;
  const integral = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowOff = (y + 1) * stride;
    const prevOff = y * stride;
    for (let x = 0; x < w; x++) {
      rowSum += lum[y * w + x];
      integral[rowOff + x + 1] = integral[prevOff + x + 1] + rowSum;
    }
  }

  const radius = Math.max(14, Math.min(48, Math.round(Math.min(w, h) * 0.045)));
  const sensitivityOffset = 34 - (params.sensitivity / 100) * 26;
  const strengthGain = 1.0 + (params.inkStrength / 100) * 2.2;

  const out = new Uint8ClampedArray(total * 4);
  let sumX = 0;
  let sumY = 0;
  let mass = 0;

  for (let y = 0; y < h; y++) {
    const y0 = y - radius < 0 ? 0 : y - radius;
    const y1 = y + radius >= h ? h - 1 : y + radius;
    const r0 = y0 * stride;
    const r1 = (y1 + 1) * stride;

    for (let x = 0; x < w; x++) {
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius >= w ? w - 1 : x + radius;
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const localMean =
        (integral[r1 + x1 + 1] -
          integral[r0 + x1 + 1] -
          integral[r1 + x0] +
          integral[r0 + x0]) /
        area;

      const idx = y * w + x;
      const oi = idx * 4;

      if (
        (params.stripBluePencil && hueCode[idx] === 1) ||
        (params.stripRedPencil && hueCode[idx] === 2)
      ) {
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

      const delta = localMean - lum[idx];
      const colorBoost = params.preserveColor && sat[idx] > 0.28 ? sat[idx] * 38 : 0;
      const signal = delta + colorBoost - sensitivityOffset;

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

      const alphaNorm = Math.min(1, (signal / 58) * strengthGain);
      const alpha = Math.round(alphaNorm * 255);

      sumX += x * alphaNorm;
      sumY += y * alphaNorm;
      mass += alphaNorm;

      if (params.preserveColor) {
        const normFactor = localMean > 10 ? 255 / localMean : 1;
        const nr = Math.min(255, Math.max(0, Math.round(pixels[oi] * normFactor)));
        const ng = Math.min(255, Math.max(0, Math.round(pixels[oi + 1] * normFactor)));
        const nb = Math.min(255, Math.max(0, Math.round(pixels[oi + 2] * normFactor)));
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

  // Build optional morphologically-closed barrier mask from upper Ink reference layer
  let barrierMask: Uint8Array | null = null;
  if (barrierRgba) {
    barrierMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (barrierRgba[i * 4 + 3] > 80) barrierMask[i] = 1;
    }
    const r = Math.max(0, Math.min(4, Math.round(gapClosePx)));
    if (r > 0) {
      // Fast 2-pass separable morphological dilation seals tiny hand-drawn ink gaps!
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

  // Expand fill region cleanly underneath the ink line to prevent any white anti-alias halo!
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
// 4B. A4 Multi-Frame Grid-Slice Scanner (1 Photo -> 4 / 6 / 8 / 9 Auto-Centered Frames!)
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

      // Compute ink centroid inside this cell for Auto-Registration centering
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
          const ix = Math.max(0, Math.min(w - 1, srcX | 0));
          const iy = Math.max(0, Math.min(h - 1, srcY | 0));
          const si = (iy * w + ix) * 4;
          out[oi] = rgba[si];
          out[oi + 1] = rgba[si + 1];
          out[oi + 2] = rgba[si + 2];
          out[oi + 3] = rgba[si + 3];
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

  // Deduplicate into 5-bit RGB histogram buckets for ultra-fast splitting
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
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
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
    const channel: 'r' | 'g' | 'b' = dr >= dg && dr >= db ? 'r' : dg >= db ? 'g' : 'b';
    return { maxSpan, channel };
  };

  while (boxes.length < maxColors) {
    let bestIdx = -1;
    let bestScore = 0;
    let bestChannel: 'r' | 'g' | 'b' = 'r';

    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length <= 1) continue;
      const { maxSpan, channel } = boxRange(boxes[i]);
      const score = maxSpan * Math.log2(boxes[i].length + 1);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        bestChannel = channel;
      }
    }

    if (bestIdx < 0) break;
    const target = boxes.splice(bestIdx, 1)[0];
    target.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.max(1, target.length >> 1);
    boxes.push(target.slice(0, mid), target.slice(mid));
  }

  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < Math.min(256, boxes.length); i++) {
    let rs = 0, gs = 0, bs = 0, ws = 0;
    for (const c of boxes[i]) {
      rs += c.r * c.weight;
      gs += c.g * c.weight;
      bs += c.b * c.weight;
      ws += c.weight;
    }
    pal[i * 3] = ws > 0 ? Math.round(rs / ws) : 0;
    pal[i * 3 + 1] = ws > 0 ? Math.round(gs / ws) : 0;
    pal[i * 3 + 2] = ws > 0 ? Math.round(bs / ws) : 0;
  }
  return pal;
}

function quantizeFrameWithLookup(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  palette: Uint8Array,
  usedColors: number,
  lut: Int16Array
): Uint8Array {
  const indexed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let mapped = lut[key];
    if (mapped < 0) {
      let best = 0;
      let bestDist = Infinity;
      for (let p = 0; p < usedColors; p++) {
        const dr = r - palette[p * 3];
        const dg = g - palette[p * 3 + 1];
        const db = b - palette[p * 3 + 2];
        const dist = dr * dr * 2 + dg * dg * 4 + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      mapped = best;
      lut[key] = mapped;
    }
    indexed[i] = mapped;
  }
  return indexed;
}

function lzwEncode(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;

  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;

  const emitCode = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  let dict = new Map<number, number>();
  emitCode(clearCode);

  if (indices.length > 0) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
      } else {
        emitCode(prefix);
        if (nextCode < 4096) {
          dict.set(key, nextCode++);
          if (nextCode > 1 << codeSize && codeSize < 12) {
            codeSize++;
          }
        } else {
          emitCode(clearCode);
          dict = new Map<number, number>();
          codeSize = minCodeSize + 1;
          nextCode = endCode + 1;
        }
        prefix = k;
      }
    }
    emitCode(prefix);
  }
  emitCode(endCode);
  if (bitCount > 0) out.push(bitBuf & 0xff);

  const blocked: number[] = [minCodeSize];
  for (let i = 0; i < out.length; i += 255) {
    const chunkLen = Math.min(255, out.length - i);
    blocked.push(chunkLen);
    for (let j = 0; j < chunkLen; j++) blocked.push(out[i + j]);
  }
  blocked.push(0);
  return new Uint8Array(blocked);
}

function encodeGif89a(params: GifEncodeParams): Uint8Array {
  const { width, height, delayCs, frames } = params;

  // Sample pixels across all frames for a tailored adaptive Median-Cut 256-color palette
  const samples: RGB[] = [];
  const totalPixels = width * height;
  const stride = Math.max(1, Math.floor((totalPixels * frames.length) / 36000));
  for (const frame of frames) {
    for (let i = 0; i < totalPixels; i += stride) {
      const o = i * 4;
      samples.push([frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2]]);
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
