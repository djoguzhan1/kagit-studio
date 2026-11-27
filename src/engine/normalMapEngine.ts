/**
 * Pure zero-DOM 2.5D Exact Euclidean Distance Transform (Felzenszwalb-Huttenlocher 1D-Parabola EDT)
 * + Cylindrical Limb Dome + Interior Ink Contour Crease Relief + Sobel Normal Map Engine.
 * Safe to run on both the Main Thread and inside `rigWorker.ts` Web Worker.
 */

const EDT_INF = 1e12;
const EDT_ENV_BOUND = 1e20;

/**
 * Exact 1D squared Euclidean Distance Transform via lower envelope of parabolas
 * (Felzenszwalb & Huttenlocher, Theory of Computing 2012 — O(N) exact).
 */
function edt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_ENV_BOUND;
  z[1] = EDT_ENV_BOUND;

  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let vk = v[k];
    let s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
    while (k > 0 && s <= z[k]) {
      k--;
      vk = v[k];
      s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
    }
    if (s <= z[0]) {
      v[0] = q;
      z[0] = -EDT_ENV_BOUND;
      z[1] = EDT_ENV_BOUND;
      k = 0;
    } else {
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = EDT_ENV_BOUND;
    }
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

export function computeDepthAndNormalRGBA(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { depthRgba: Uint8ClampedArray; normalRgba: Uint8ClampedArray } {
  const total = width * height;
  if (width < 3 || height < 3 || rgba.length < total * 4) {
    return {
      depthRgba: new Uint8ClampedArray(Math.max(0, total * 4)),
      normalRgba: new Uint8ClampedArray(Math.max(0, total * 4)),
    };
  }

  const mask = new Uint8Array(total);
  const lumArr = new Float32Array(total);
  const lumHist = new Uint32Array(256);
  let opaqueCount = 0;

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (rgba[o + 3] > 28) {
      mask[i] = 1;
      const lum = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
      lumArr[i] = lum;
      lumHist[Math.max(0, Math.min(255, lum | 0))]++;
      opaqueCount++;
    }
  }

  if (opaqueCount === 0) {
    return {
      depthRgba: new Uint8ClampedArray(total * 4),
      normalRgba: new Uint8ClampedArray(total * 4),
    };
  }

  // Estimate bright paper/fill reference luminance (85th percentile of opaque pixels, clamped to [145, 250])
  let paperLum = 235;
  const targetRank = Math.floor(opaqueCount * 0.85);
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += lumHist[b];
    if (acc >= targetRank) {
      paperLum = Math.max(145, Math.min(250, b));
      break;
    }
  }

  // Exact 2D Euclidean Distance Transform with 1px virtual background border so edge-touching limbs curve cleanly
  const pw = width + 2;
  const ph = height + 2;
  const maxDim = Math.max(pw, ph);
  const grid = new Float64Array(pw * ph);
  const fBuf = new Float64Array(maxDim);
  const dBuf = new Float64Array(maxDim);
  const vBuf = new Int32Array(maxDim);
  const zBuf = new Float64Array(maxDim + 2);

  for (let y = 0; y < height; y++) {
    const srcRow = y * width;
    const dstRow = (y + 1) * pw;
    for (let x = 0; x < width; x++) {
      grid[dstRow + x + 1] = mask[srcRow + x] ? EDT_INF : 0;
    }
  }

  // Pass 1: 1D parabola EDT along columns
  for (let x = 0; x < pw; x++) {
    for (let y = 0; y < ph; y++) {
      fBuf[y] = grid[y * pw + x];
    }
    edt1d(fBuf, ph, dBuf, vBuf, zBuf);
    for (let y = 0; y < ph; y++) {
      grid[y * pw + x] = dBuf[y];
    }
  }

  // Pass 2: 1D parabola EDT along rows
  const dist = new Float32Array(total);
  let maxD = 1;
  for (let y = 0; y < height; y++) {
    const gRow = (y + 1) * pw;
    for (let x = 0; x < pw; x++) {
      fBuf[x] = grid[gRow + x];
    }
    edt1d(fBuf, pw, dBuf, vBuf, zBuf);
    const outRow = y * width;
    for (let x = 0; x < width; x++) {
      const idx = outRow + x;
      if (!mask[idx]) continue;
      const euc = Math.sqrt(Math.max(0, dBuf[x + 1]));
      dist[idx] = euc;
      if (euc > maxD) maxD = euc;
    }
  }

  // Soft interior ink-contour crease field (`lum < 0.35 * paperLum` away from outer silhouette rim)
  const inkCutoff = 0.35 * paperLum;
  const rawCrease = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (!mask[i] || dist[i] < 1.6) continue;
    const lum = lumArr[i];
    if (lum < inkCutoff) {
      const rimFade = Math.min(1, (dist[i] - 1.6) / 2.4);
      rawCrease[i] = ((inkCutoff - lum) / Math.max(1, inkCutoff)) * rimFade;
    }
  }

  // 3x3 tent-smoothed concave ink groove relief + semi-cylindrical limb dome profile:
  // h(d) = sqrt(1 - (1 - min(1, d / R))^2)
  const limbRadius = Math.max(5.5, Math.min(maxD * 0.68, Math.min(width, height) * 0.16));
  const bodyRadius = Math.max(limbRadius, maxD);

  const zField = new Float32Array(total);
  const depthRgba = new Uint8ClampedArray(total * 4);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (!mask[i]) continue;

      const d = dist[i];
      const uLimb = Math.min(1, d / limbRadius);
      const hLimb = Math.sqrt(Math.max(0, 1 - (1 - uLimb) * (1 - uLimb)));
      const uBody = Math.min(1, d / bodyRadius);
      const hBody = Math.sqrt(Math.max(0, 1 - (1 - uBody) * (1 - uBody)));
      let z = hLimb * 0.72 + hBody * 0.28;

      if (x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
        const groove =
          (rawCrease[i - width - 1] +
            2 * rawCrease[i - width] +
            rawCrease[i - width + 1] +
            2 * rawCrease[i - 1] +
            4 * rawCrease[i] +
            2 * rawCrease[i + 1] +
            rawCrease[i + width - 1] +
            2 * rawCrease[i + width] +
            rawCrease[i + width + 1]) *
          (1 / 16);
        z = Math.max(0.02, z - groove * 0.18);
      }

      zField[i] = z;
      const v = Math.max(0, Math.min(255, Math.round(z * 255)));
      const o = i * 4;
      depthRgba[o] = v;
      depthRgba[o + 1] = v;
      depthRgba[o + 2] = v;
      depthRgba[o + 3] = 255;
    }
  }

  // Sobel gradient -> RGB Tangent-Space Surface Normal Map (Nx, Ny, Nz)
  const normalRgba = new Uint8ClampedArray(total * 4);
  const strength = 2.6;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;
      const dzdx =
        zField[idx + 1 - width] +
        2 * zField[idx + 1] +
        zField[idx + 1 + width] -
        (zField[idx - 1 - width] + 2 * zField[idx - 1] + zField[idx - 1 + width]);
      const dzdy =
        zField[idx - 1 + width] +
        2 * zField[idx + width] +
        zField[idx + 1 + width] -
        (zField[idx - 1 - width] + 2 * zField[idx - width] + zField[idx + 1 - width]);

      let nx = -dzdx * strength;
      let ny = -dzdy * strength;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const o = idx * 4;
      normalRgba[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normalRgba[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalRgba[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normalRgba[o + 3] = 255;
    }
  }

  // Clean 1px border fallback so edge foreground pixels also carry valid unit normals
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      const o = idx * 4;
      if (normalRgba[o + 3] === 0) {
        normalRgba[o] = 128;
        normalRgba[o + 1] = y === 0 ? 96 : 160;
        normalRgba[o + 2] = 248;
        normalRgba[o + 3] = 255;
      }
    }
  }
  for (let y = 1; y < height - 1; y++) {
    for (const x of [0, width - 1]) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      const o = idx * 4;
      if (normalRgba[o + 3] === 0) {
        normalRgba[o] = x === 0 ? 96 : 160;
        normalRgba[o + 1] = 128;
        normalRgba[o + 2] = 248;
        normalRgba[o + 3] = 255;
      }
    }
  }

  return { depthRgba, normalRgba };
}
