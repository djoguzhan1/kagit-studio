/**
 * Pure zero-DOM 2.5D Distance-Transform Depth + Sobel Normal Map Engine
 * Safe to run on both the Main Thread and inside `rigWorker.ts` Web Worker.
 */

export function computeDepthAndNormalRGBA(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { depthRgba: Uint8ClampedArray; normalRgba: Uint8ClampedArray } {
  const total = width * height;
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    mask[i] = rgba[i * 4 + 3] > 28 ? 1 : 0;
  }

  // Fast 2-pass Manhattan/Chamfer distance transform to silhouette boundary
  const dist = new Float32Array(total);
  const INF = 1e6;
  for (let i = 0; i < total; i++) dist[i] = mask[i] ? INF : 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      const d = Math.min(
        dist[idx],
        dist[idx - 1] + 1,
        dist[idx - width] + 1,
        dist[idx - width - 1] + 1.414
      );
      dist[idx] = d;
    }
  }
  for (let y = height - 2; y >= 1; y--) {
    for (let x = width - 2; x >= 1; x--) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      const d = Math.min(
        dist[idx],
        dist[idx + 1] + 1,
        dist[idx + width] + 1,
        dist[idx + width + 1] + 1.414
      );
      dist[idx] = d;
    }
  }

  let maxD = 1;
  for (let i = 0; i < total; i++) {
    if (dist[i] < INF && dist[i] > maxD) maxD = dist[i];
  }

  // Convert normalized distance to hemispherical 2.5D depth profile: z = sqrt(1 - (1 - d)^2)
  const zField = new Float32Array(total);
  const depthRgba = new Uint8ClampedArray(total * 4);
  for (let i = 0; i < total; i++) {
    if (!mask[i]) continue;
    const norm = Math.min(1, dist[i] / maxD);
    const z = Math.sqrt(Math.max(0, 1 - (1 - norm) * (1 - norm)));
    zField[i] = z;
    const v = Math.round(z * 255);
    const o = i * 4;
    depthRgba[o] = v;
    depthRgba[o + 1] = v;
    depthRgba[o + 2] = v;
    depthRgba[o + 3] = 255;
  }

  // Sobel gradient -> RGB Tangent-Space Surface Normal Map (Nx, Ny, Nz)
  const normalRgba = new Uint8ClampedArray(total * 4);
  const strength = 2.6;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
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

  return { depthRgba, normalRgba };
}
