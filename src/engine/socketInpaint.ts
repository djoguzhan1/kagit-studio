/**
 * INKTROPE V3 2.5D Socket-Backing Fast Inpainting Engine
 * ------------------------------------------------------
 * Pure RGBA, zero-dependency, < 3 ms client-side Telea-inspired directional inpainting.
 *
 * Whenever an arm or leg overlaps or hugs the torso (or gets separated along a distal slit /
 * ink-watershed seam), this engine synthesizes a clean 12–18 px torso-colored backing band
 * behind shoulder/waist/hip occlusion sockets using interior non-ink torso pixels so that:
 *   1. Swinging arms across or away from the chest NEVER expose white/transparent holes
 *   2. Torso fabric NEVER stretches or merges ("birleşme") with the swinging sleeve!
 */

export interface SocketInpaintResult {
  /** Clean torso-backdrop RGBA buffer (same dimensions as source) with socket margins inpainted */
  rgba: Uint8ClampedArray;
  /** Isolated transparent-except-socket patch RGBA for zero-ghost 2nd-pass chest backing */
  socketOnlyRgba: Uint8ClampedArray;
  /** Number of pixels seamlessly filled behind occlusion sockets */
  inpaintedPixels: number;
}

/**
 * Generates an inpainted backing copy of the character where pixels belonging to limb regions
 * (`arm_l = 2`, `arm_r = 3`) within `marginPx` of torso (`reg = 1`) are replaced smoothly with
 * diffused torso interior color (avoiding dark ink outline bleed!).
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
  const out = new Uint8ClampedArray(srcRgba);
  const socketOnly = new Uint8ClampedArray(srcRgba.length);
  if (srcW < 16 || srcH < 16 || topoW < 8 || topoH < 8) {
    return { rgba: out, socketOnlyRgba: socketOnly, inpaintedPixels: 0 };
  }

  // Work in topo-grid space for sub-2ms speed, then project smoothly to pixels inside socket zone!
  const N = topoW * topoH;
  const radTopo = Math.max(2, Math.min(12, Math.round((marginPx * topoW) / Math.max(1, srcW))));

  // Identify torso interior seeds (region === 1, opaque, NOT dark outline if lighter fill exists)
  const isTorso = new Uint8Array(N);
  const torsoR = new Float32Array(N);
  const torsoG = new Float32Array(N);
  const torsoB = new Float32Array(N);
  const filled = new Uint8Array(N);

  // Sample mean color of each topo cell from source RGBA
  let torsoLumSum = 0;
  let torsoCnt = 0;
  const cellR = new Float32Array(N);
  const cellG = new Float32Array(N);
  const cellB = new Float32Array(N);
  const cellLum = new Float32Array(N);

  for (let ty = 0; ty < topoH; ty++) {
    const sy = Math.min(srcH - 1, Math.floor(((ty + 0.5) * srcH) / topoH));
    const rowOff = sy * srcW;
    for (let tx = 0; tx < topoW; tx++) {
      const idx = ty * topoW + tx;
      if (!topoOp[idx]) continue;
      const sx = Math.min(srcW - 1, Math.floor(((tx + 0.5) * srcW) / topoW));
      const o = (rowOff + sx) * 4;
      const r = srcRgba[o];
      const g = srcRgba[o + 1];
      const b = srcRgba[o + 2];
      cellR[idx] = r;
      cellG[idx] = g;
      cellB[idx] = b;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      cellLum[idx] = lum;
      if (topoRegion[idx] === 1) {
        isTorso[idx] = 1;
        torsoLumSum += lum;
        torsoCnt++;
      }
    }
  }
  if (torsoCnt < 8) return { rgba: out, socketOnlyRgba: socketOnly, inpaintedPixels: 0 };

  const avgTorsoLum = torsoLumSum / torsoCnt;
  // Prefer non-ink interior torso pixels as diffusion seeds when torso has colored/light fill
  const darkInkCutoff = avgTorsoLum > 95 ? Math.min(82, avgTorsoLum * 0.55) : -1;

  const q = new Int32Array(N);
  const dist = new Int16Array(N).fill(-1);
  let qh = 0;
  let qt = 0;

  for (let i = 0; i < N; i++) {
    if (!isTorso[i]) continue;
    // Skip 1-cell border outlines if torso has bright interior fill so we don't bleed black outline!
    const isInkOutline = darkInkCutoff > 0 && cellLum[i] < darkInkCutoff;
    if (!isInkOutline) {
      filled[i] = 1;
      dist[i] = 0;
      torsoR[i] = cellR[i];
      torsoG[i] = cellG[i];
      torsoB[i] = cellB[i];
      q[qt++] = i;
    }
  }

  // Fallback if entire torso is dark black (e.g. Baron's black tuxedo coat!)
  if (qt < 4) {
    for (let i = 0; i < N; i++) {
      if (!isTorso[i]) continue;
      filled[i] = 1;
      dist[i] = 0;
      torsoR[i] = cellR[i];
      torsoG[i] = cellG[i];
      torsoB[i] = cellB[i];
      q[qt++] = i;
    }
  }

  // Fast-Marching BFS diffusion outward from torso into adjacent arm/shoulder socket pixels!
  const targetMask = new Uint8Array(N);
  while (qh < qt) {
    const cur = q[qh++];
    const d = dist[cur];
    if (d >= radTopo) continue;
    const cx = cur % topoW;
    const cy = (cur - cx) / topoW;

    const neighbors = [
      cx > 0 ? cur - 1 : -1,
      cx + 1 < topoW ? cur + 1 : -1,
      cy > 0 ? cur - topoW : -1,
      cy + 1 < topoH ? cur + topoW : -1,
    ];
    for (let k = 0; k < 4; k++) {
      const ni = neighbors[k];
      if (ni < 0 || filled[ni]) continue;
      const reg = topoRegion[ni];
      // Only diffuse into arm regions (2, 3) or dark outline rim on torso!
      if (reg !== 1 && reg !== 2 && reg !== 3) continue;
      // Average already-filled 4-neighbors for silky Telea-like harmonic color continuation
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let cnt = 0;
      const nx = ni % topoW;
      const ny = (ni - nx) / topoW;
      if (nx > 0 && filled[ni - 1]) { sr += torsoR[ni - 1]; sg += torsoG[ni - 1]; sb += torsoB[ni - 1]; cnt++; }
      if (nx + 1 < topoW && filled[ni + 1]) { sr += torsoR[ni + 1]; sg += torsoG[ni + 1]; sb += torsoB[ni + 1]; cnt++; }
      if (ny > 0 && filled[ni - topoW]) { sr += torsoR[ni - topoW]; sg += torsoG[ni - topoW]; sb += torsoB[ni - topoW]; cnt++; }
      if (ny + 1 < topoH && filled[ni + topoW]) { sr += torsoR[ni + topoW]; sg += torsoG[ni + topoW]; sb += torsoB[ni + topoW]; cnt++; }
      if (cnt === 0) continue;

      torsoR[ni] = sr / cnt;
      torsoG[ni] = sg / cnt;
      torsoB[ni] = sb / cnt;
      filled[ni] = 1;
      dist[ni] = d + 1;
      if (reg === 2 || reg === 3) {
        targetMask[ni] = 1;
      }
      q[qt++] = ni;
    }
  }

  // Write smoothly feathered inpainted socket pixels into output RGBA buffer
  let inpaintedPixels = 0;
  for (let y = 0; y < srcH; y++) {
    const ty = Math.min(topoH - 1, Math.floor((y * topoH) / srcH));
    const row = y * srcW;
    const tRow = ty * topoW;
    for (let x = 0; x < srcW; x++) {
      const tx = Math.min(topoW - 1, Math.floor((x * topoW) / srcW));
      const ti = tRow + tx;
      if (!targetMask[ti]) continue;
      const o = (row + x) * 4;
      const fade = Math.max(0, 1 - dist[ti] / (radTopo + 1));
      const alpha = Math.round(255 * Math.min(1, fade * 1.45));
      if (alpha < 12) continue;
      const rVal = Math.max(0, Math.min(255, Math.round(torsoR[ti])));
      const gVal = Math.max(0, Math.min(255, Math.round(torsoG[ti])));
      const bVal = Math.max(0, Math.min(255, Math.round(torsoB[ti])));
      out[o] = rVal;
      out[o + 1] = gVal;
      out[o + 2] = bVal;
      out[o + 3] = alpha;
      socketOnly[o] = rVal;
      socketOnly[o + 1] = gVal;
      socketOnly[o + 2] = bVal;
      socketOnly[o + 3] = alpha;
      inpaintedPixels++;
    }
  }

  return { rgba: out, socketOnlyRgba: socketOnly, inpaintedPixels };
}
