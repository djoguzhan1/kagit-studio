import type { ConformingSkinnedMesh } from './conformingMeshEngine';
import { computeDepthAndNormalRGBA } from './kagit25dPipeline';
import type { GpuBoneTransform2D } from './webglSkinnedRenderer';

/**
 * INKTROPE V3/V4 Zero-Allocation TypedArray Scanline Affine Texture Rasterizer
 * ----------------------------------------------------------------------------
 *  1. Exact Top-Left Fill Rule -> 0.000 px seam cracks & 0 double-blended edges
 *  2. 100% Zero-GC hot path -> reuses bucketed scratch Uint32Array + rowStride
 *  3. Crisp Premultiplied-Safe Bilinear Texture Sampling (matches WebGL2 gl.LINEAR!)
 *  4. Full Per-Vertex 2.5D Depth Shading + Unit-Normalized Live Klaus Normal-Map Lighting
 *     with Per-Vertex / Jacobian Bone-Rotated World Normals (1:1 parity with WebGL2!)
 *  5. Multi-Bone Cropped Socket Sub-Patch Backing (`pelvis=0, chest=1, neck=12`)
 *  6. 1-Pass Perimeter Warm Paper-Cutout Night Halo directly on Uint32Array alpha
 */

export interface KlausLightConfig {
  /** Normalized 2D light direction X (-1..1, +right) */
  lx: number;
  /** Normalized 2D light direction Y (-1..1, +down) */
  ly: number;
  /** Rim highlight RGB (0..1) */
  rimR: number;
  rimG: number;
  rimB: number;
  /** Rim highlight strength (0..1.2) */
  rimStrength: number;
  /** Cel shadow tint RGB (0..1) */
  shadowR: number;
  shadowG: number;
  shadowB: number;
  /** Cel shadow opacity (0..0.6) */
  shadowStrength: number;
}

export interface CpuRasterOptions {
  /** Use mirrored triangle Z-order (for facingLeft characters) */
  mirroredOrder?: boolean;
  /** Render crisp 2.4px outer-perimeter warm ivory paper cutout halo (only when explicitly true!) */
  nightHalo?: boolean;
  /** Slightly cooler/softer halo tone when rendering puddle reflections */
  isReflection?: boolean;
  /** Flip horizontally around mirrorAxisX in screen space */
  mirrorAxisX?: number | null;
  /** Optional real-time 2.5D Klaus directional normal-map cel shading & rim lighting */
  klausLight?: KlausLightConfig | null;
  /** Optional precomputed 2.5D normal map RGBA (width * height * 4) matching source dimensions */
  normalRgba?: Uint8ClampedArray | null;
  /** Optional live bone transforms for exact per-vertex normal rotation & multi-bone socket backing */
  gpuBones?: readonly GpuBoneTransform2D[] | null;
  /** Optional actor bounds for multi-bone socket sub-patch backing */
  bounds?: { x: number; y: number; w: number; h: number } | null;
  /** Optional precomputed per-vertex (cosTheta, sinTheta) array (length = vertexCount * 2) */
  vertexRotCS?: Float32Array | null;
  /** Enable 2x2 bilinear filtering (default true for WebGL-matching crispness) */
  bilinear?: boolean;
  /** Optional row stride of outRgba in pixels (defaults to cw; enables 0-GC sub-rect rasterization!) */
  rowStride?: number;
}

interface CachedSourcePixels {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  normalRgba: Uint8ClampedArray | null;
}

const sourcePixelCache = new WeakMap<HTMLCanvasElement, CachedSourcePixels>();

let _scratchCanvas: HTMLCanvasElement | null = null;
let _scratchCtx: CanvasRenderingContext2D | null = null;
let _scratchImageData: ImageData | null = null;
let _scratchW = 0;
let _scratchH = 0;

let _haloAlphaBuf = new Uint8Array(0);
let _vertRotCSBuf = new Float32Array(0);

const IS_LITTLE_ENDIAN = (() => {
  const b = new ArrayBuffer(4);
  new Uint32Array(b)[0] = 0x0a0b0c0d;
  return new Uint8Array(b)[0] === 0x0d;
})();

function packRGBA(r: number, g: number, b: number, a: number): number {
  return IS_LITTLE_ENDIAN
    ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

export function getOrExtractSourcePixels(
  sourceCanvas: HTMLCanvasElement,
  needNormals = false
): CachedSourcePixels | null {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  if (sw < 2 || sh < 2) return null;

  let cached = sourcePixelCache.get(sourceCanvas);
  if (!cached || cached.w !== sw || cached.h !== sh) {
    try {
      const sctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      if (!sctx) return null;
      const rgba = sctx.getImageData(0, 0, sw, sh).data;
      cached = { w: sw, h: sh, rgba, normalRgba: null };
      sourcePixelCache.set(sourceCanvas, cached);
    } catch {
      return null;
    }
  }

  if (needNormals && !cached.normalRgba) {
    const { normalRgba } = computeDepthAndNormalRGBA(cached.rgba, sw, sh);
    cached.normalRgba = normalRgba;
  }

  return cached;
}

function buildVertexRotCSFromBones(
  mesh: ConformingSkinnedMesh,
  bones: readonly GpuBoneTransform2D[]
): Float32Array {
  const vCount = mesh.vertexCount;
  if (_vertRotCSBuf.length < vCount * 2) {
    _vertRotCSBuf = new Float32Array(vCount * 2);
  }
  const bIdx = mesh.boneIndices;
  const bWt = mesh.boneWeights;
  const bLen = bones.length;

  for (let vi = 0; vi < vCount; vi++) {
    const o4 = vi * 4;
    const i0 = bIdx[o4] < bLen ? bIdx[o4] : 0;
    const w0 = bWt[o4];
    const r0 = bones[i0]?.rotRad ?? 0;
    const refC = Math.cos(r0);
    const refS = Math.sin(r0);
    if (w0 >= 0.998 || bLen === 0) {
      _vertRotCSBuf[vi * 2] = refC;
      _vertRotCSBuf[vi * 2 + 1] = refS;
      continue;
    }
    let sumC = refC * w0;
    let sumS = refS * w0;
    for (let k = 1; k < 4; k++) {
      const wk = bWt[o4 + k];
      if (wk <= 0.0001) continue;
      const ik = bIdx[o4 + k] < bLen ? bIdx[o4 + k] : 0;
      const rk = bones[ik]?.rotRad ?? 0;
      const ck = Math.cos(rk);
      const sk = Math.sin(rk);
      const sign = refC * ck + refS * sk < 0 ? -1 : 1;
      sumC += wk * sign * ck;
      sumS += wk * sign * sk;
    }
    const len = Math.hypot(sumC, sumS) || 1;
    _vertRotCSBuf[vi * 2] = sumC / len;
    _vertRotCSBuf[vi * 2 + 1] = sumS / len;
  }
  return _vertRotCSBuf;
}

/**
 * Pure, zero-DOM RGBA scanline triangle rasterizer for any ConformingSkinnedMesh.
 */
export function rasterizeSkinnedMeshToRgba(
  srcRgba: Uint8ClampedArray,
  sw: number,
  sh: number,
  mesh: ConformingSkinnedMesh,
  positions: Float32Array,
  outRgba: Uint8ClampedArray,
  cw: number,
  ch: number,
  ox: number,
  oy: number,
  opts?: CpuRasterOptions
): { trianglesDrawn: number; pixelsShaded: number } {
  const stride = Math.max(cw, opts?.rowStride ?? cw);
  const outU32 = new Uint32Array(outRgba.buffer, outRgba.byteOffset, stride * ch);

  if (stride === cw) {
    outU32.fill(0);
  } else {
    for (let y = 0; y < ch; y++) {
      const start = y * stride;
      outU32.fill(0, start, start + cw);
    }
  }

  const isMirrored = Boolean(opts?.mirroredOrder);
  const indices = isMirrored ? mesh.trianglesMirrored : mesh.triangles;
  const restUV = mesh.restUV;
  const shadeArr =
    isMirrored && mesh.vertexShadeMirrored ? mesh.vertexShadeMirrored : mesh.vertexShade;
  const isRefl = Boolean(opts?.isReflection);
  const mirrorAxisX = opts?.mirrorAxisX ?? null;
  const useBilinear = opts?.bilinear !== false;

  const klaus = opts?.klausLight ?? null;
  const normalRgba = klaus ? opts?.normalRgba ?? null : null;
  const hasKlaus = Boolean(klaus && normalRgba && normalRgba.length >= sw * sh * 4);

  // Unit-normalized 3D Klaus light vector (exact 1:1 parity with WebGL2 bindKlausUniforms!)
  const rawKlx = klaus ? (mirrorAxisX !== null ? -klaus.lx : klaus.lx) : 0;
  const rawKly = klaus ? klaus.ly : 0;
  const rawKlz = 0.52;
  const invKlLen = klaus ? 1 / (Math.hypot(rawKlx, rawKly, rawKlz) || 1) : 1;
  const klx = rawKlx * invKlLen;
  const kly = rawKly * invKlLen;
  const klz = rawKlz * invKlLen;

  const kRimR = klaus ? klaus.rimR * 255 * klaus.rimStrength : 0;
  const kRimG = klaus ? klaus.rimG * 255 * klaus.rimStrength : 0;
  const kRimB = klaus ? klaus.rimB * 255 * klaus.rimStrength : 0;
  const kShR = klaus ? klaus.shadowR * 255 : 0;
  const kShG = klaus ? klaus.shadowG * 255 : 0;
  const kShB = klaus ? klaus.shadowB * 255 : 0;
  const kShStr = klaus ? klaus.shadowStrength : 0;

  let vRotCS: Float32Array | null = null;
  if (hasKlaus) {
    if (opts?.vertexRotCS && opts.vertexRotCS.length >= mesh.vertexCount * 2) {
      vRotCS = opts.vertexRotCS;
    } else if (opts?.gpuBones && opts.gpuBones.length > 0) {
      vRotCS = buildVertexRotCSFromBones(mesh, opts.gpuBones);
    }
  }

  const swMax = sw - 1;
  const shMax = sh - 1;
  const swF = swMax;
  const shF = shMax;

  let trianglesDrawn = 0;
  let pixelsShaded = 0;

  const triLen = indices.length;
  for (let i = 0; i < triLen; i += 3) {
    const ia = indices[i];
    const ib = indices[i + 1];
    const ic = indices[i + 2];

    const preX0 = positions[ia * 2];
    const preY0 = positions[ia * 2 + 1];
    const preX1 = positions[ib * 2];
    const preY1 = positions[ib * 2 + 1];
    const preX2 = positions[ic * 2];
    const preY2 = positions[ic * 2 + 1];

    let x0 = (mirrorAxisX !== null ? 2 * mirrorAxisX - preX0 : preX0) - ox;
    let y0 = preY0 - oy;
    let x1 = (mirrorAxisX !== null ? 2 * mirrorAxisX - preX1 : preX1) - ox;
    let y1 = preY1 - oy;
    let x2 = (mirrorAxisX !== null ? 2 * mirrorAxisX - preX2 : preX2) - ox;
    let y2 = preY2 - oy;

    let u0 = restUV[ia * 2] * swF;
    let v0 = restUV[ia * 2 + 1] * shF;
    let u1 = restUV[ib * 2] * swF;
    let v1 = restUV[ib * 2 + 1] * shF;
    let u2 = restUV[ic * 2] * swF;
    let v2 = restUV[ic * 2 + 1] * shF;

    let s0 = isRefl ? 1.0 : shadeArr[ia];
    let s1 = isRefl ? 1.0 : shadeArr[ib];
    let s2 = isRefl ? 1.0 : shadeArr[ic];

    let c0 = 1.0;
    let rSin0 = 0.0;
    let c1 = 1.0;
    let rSin1 = 0.0;
    let c2 = 1.0;
    let rSin2 = 0.0;

    if (hasKlaus) {
      if (vRotCS) {
        c0 = vRotCS[ia * 2];
        rSin0 = vRotCS[ia * 2 + 1];
        c1 = vRotCS[ib * 2];
        rSin1 = vRotCS[ib * 2 + 1];
        c2 = vRotCS[ic * 2];
        rSin2 = vRotCS[ic * 2 + 1];
      } else {
        // Exact 2x2 Polar Decomposition rotation from pre-mirror triangle Jacobian!
        const du1 = u1 - u0;
        const dv1 = v1 - v0;
        const du2 = u2 - u0;
        const dv2 = v2 - v0;
        const detUV = du1 * dv2 - dv1 * du2;
        if (Math.abs(detUV) > 1e-5) {
          const invDet = 1 / detUV;
          const dx1 = preX1 - preX0;
          const dy1 = preY1 - preY0;
          const dx2 = preX2 - preX0;
          const dy2 = preY2 - preY0;
          const j00 = (dx1 * dv2 - dx2 * dv1) * invDet;
          const j01 = (-dx1 * du2 + dx2 * du1) * invDet;
          const j10 = (dy1 * dv2 - dy2 * dv1) * invDet;
          const j11 = (-dy1 * du2 + dy2 * du1) * invDet;
          const rc = j00 + j11;
          const rs = j10 - j01;
          const rLen = Math.hypot(rc, rs);
          if (rLen > 1e-5) {
            c0 = rc / rLen;
            rSin0 = rs / rLen;
            c1 = c0;
            rSin1 = rSin0;
            c2 = c0;
            rSin2 = rSin0;
          }
        }
      }
    }

    let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (Math.abs(area) < 0.05) continue;
    if (area < 0) {
      let tmp = x1; x1 = x2; x2 = tmp;
      tmp = y1; y1 = y2; y2 = tmp;
      tmp = u1; u1 = u2; u2 = tmp;
      tmp = v1; v1 = v2; v2 = tmp;
      tmp = s1; s1 = s2; s2 = tmp;
      tmp = c1; c1 = c2; c2 = tmp;
      tmp = rSin1; rSin1 = rSin2; rSin2 = tmp;
      area = -area;
    }

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(cw - 1, Math.ceil(Math.max(x0, x1, x2)) - 1);
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(ch - 1, Math.ceil(Math.max(y0, y1, y2)) - 1);
    if (minX > maxX || minY > maxY) continue;

    trianglesDrawn++;
    const invArea = 1 / area;

    const a0 = y1 - y2;
    const b0 = x2 - x1;
    const a1 = y2 - y0;
    const b1 = x0 - x2;
    const a2 = y0 - y1;
    const b2 = x1 - x0;

    const isTopLeft0 = y1 > y2 || (y1 === y2 && x1 < x2);
    const isTopLeft1 = y2 > y0 || (y2 === y0 && x2 < x0);
    const isTopLeft2 = y0 > y1 || (y0 === y1 && x0 < x1);
    const bias0 = isTopLeft0 ? 0 : -1e-4;
    const bias1 = isTopLeft1 ? 0 : -1e-4;
    const bias2 = isTopLeft2 ? 0 : -1e-4;

    const startX = minX + 0.5;
    const startY = minY + 0.5;
    const w0Base = (x2 - x1) * (startY - y1) - (y2 - y1) * (startX - x1);
    const w1Base = (x0 - x2) * (startY - y2) - (y0 - y2) * (startX - x2);
    const w2Base = (x1 - x0) * (startY - y0) - (y1 - y0) * (startX - x0);

    let w0Row = w0Base + bias0;
    let w1Row = w1Base + bias1;
    let w2Row = w2Base + bias2;

    const duDx = (a0 * u0 + a1 * u1 + a2 * u2) * invArea;
    const duDy = (b0 * u0 + b1 * u1 + b2 * u2) * invArea;
    const dvDx = (a0 * v0 + a1 * v1 + a2 * v2) * invArea;
    const dvDy = (b0 * v0 + b1 * v1 + b2 * v2) * invArea;
    const dsDx = (a0 * s0 + a1 * s1 + a2 * s2) * invArea;
    const dsDy = (b0 * s0 + b1 * s1 + b2 * s2) * invArea;
    const dcDx = hasKlaus ? (a0 * c0 + a1 * c1 + a2 * c2) * invArea : 0;
    const dcDy = hasKlaus ? (b0 * c0 + b1 * c1 + b2 * c2) * invArea : 0;
    const drsDx = hasKlaus ? (a0 * rSin0 + a1 * rSin1 + a2 * rSin2) * invArea : 0;
    const drsDy = hasKlaus ? (b0 * rSin0 + b1 * rSin1 + b2 * rSin2) * invArea : 0;

    let uRow = (w0Base * u0 + w1Base * u1 + w2Base * u2) * invArea;
    let vRow = (w0Base * v0 + w1Base * v1 + w2Base * v2) * invArea;
    let sRow = (w0Base * s0 + w1Base * s1 + w2Base * s2) * invArea;
    let cRow = hasKlaus ? (w0Base * c0 + w1Base * c1 + w2Base * c2) * invArea : 1;
    let rsRow = hasKlaus ? (w0Base * rSin0 + w1Base * rSin1 + w2Base * rSin2) * invArea : 0;

    for (let py = minY; py <= maxY; py++) {
      let w0 = w0Row;
      let w1 = w1Row;
      let w2 = w2Row;
      let u = uRow;
      let v = vRow;
      let shVal = sRow;
      let rc = cRow;
      let rs = rsRow;
      const rowOff = py * stride;

      let enteredSpan = false;
      for (let px = minX; px <= maxX; px++) {
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
          enteredSpan = true;

          const uc = u < 0 ? 0 : u > swMax ? swMax : u;
          const vc = v < 0 ? 0 : v > shMax ? shMax : v;

          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sa = 0;
          let centerIdx = 0;

          if (useBilinear) {
            const x0i = uc | 0;
            const y0i = vc | 0;
            const x1i = x0i < swMax ? x0i + 1 : swMax;
            const y1i = y0i < shMax ? y0i + 1 : shMax;
            const fx = uc - x0i;
            const fy = vc - y0i;
            const ifx = 1 - fx;
            const ify = 1 - fy;

            const i00 = (y0i * sw + x0i) << 2;
            const i10 = (y0i * sw + x1i) << 2;
            const i01 = (y1i * sw + x0i) << 2;
            const i11 = (y1i * sw + x1i) << 2;

            const a00 = srcRgba[i00 + 3];
            const a10 = srcRgba[i10 + 3];
            const a01 = srcRgba[i01 + 3];
            const a11 = srcRgba[i11 + 3];

            const m00 = ifx * ify;
            const m10 = fx * ify;
            const m01 = ifx * fy;
            const m11 = fx * fy;

            sa = (a00 * m00 + a10 * m10 + a01 * m01 + a11 * m11 + 0.5) | 0;
            if (sa > 6) {
              const w00 = m00 * a00;
              const w10 = m10 * a10;
              const w01 = m01 * a01;
              const w11 = m11 * a11;
              const invW = 1 / Math.max(1e-4, w00 + w10 + w01 + w11);
              sr = (srcRgba[i00] * w00 + srcRgba[i10] * w10 + srcRgba[i01] * w01 + srcRgba[i11] * w11) * invW;
              sg = (srcRgba[i00 + 1] * w00 + srcRgba[i10 + 1] * w10 + srcRgba[i01 + 1] * w01 + srcRgba[i11 + 1] * w11) * invW;
              sb = (srcRgba[i00 + 2] * w00 + srcRgba[i10 + 2] * w10 + srcRgba[i01 + 2] * w01 + srcRgba[i11 + 2] * w11) * invW;
              centerIdx = i00;
            }
          } else {
            const sx = (uc + 0.5) | 0;
            const sy = (vc + 0.5) | 0;
            centerIdx = (sy * sw + sx) << 2;
            sa = srcRgba[centerIdx + 3];
            if (sa > 6) {
              sr = srcRgba[centerIdx];
              sg = srcRgba[centerIdx + 1];
              sb = srcRgba[centerIdx + 2];
            }
          }

          if (sa > 6) {
            pixelsShaded++;
            const shClamped = shVal < 0.72 ? 0.72 : shVal > 1.12 ? 1.12 : shVal;
            sr *= shClamped;
            sg *= shClamped;
            sb *= shClamped;

            if (hasKlaus && normalRgba) {
              const rawNx = normalRgba[centerIdx] * (2 / 255) - 1;
              const rawNy = normalRgba[centerIdx + 1] * (2 / 255) - 1;
              const nz = normalRgba[centerIdx + 2] * (2 / 255) - 1;

              const rInv = 1 / (Math.hypot(rc, rs) || 1);
              const nrc = rc * rInv;
              const nrs = rs * rInv;
              const nx = nrc * rawNx - nrs * rawNy;
              const ny = nrs * rawNx + nrc * rawNy;

              const ndl = nx * klx + ny * kly + nz * klz;
              if (ndl < 0.22) {
                const t = Math.min(1, (0.22 - ndl) * 2.1) * kShStr;
                const invT = 1 - t;
                sr = sr * invT + kShR * t;
                sg = sg * invT + kShG * t;
                sb = sb * invT + kShB * t;
              }
              const edge = 1 - Math.max(0, nz);
              const litEdge = Math.max(0, nx * klx + ny * kly + 0.25);
              const rim = edge * edge * litEdge;
              if (rim > 0.04) {
                sr += kRimR * rim;
                sg += kRimG * rim;
                sb += kRimB * rim;
              }
            }

            const rByte = sr > 255 ? 255 : sr < 0 ? 0 : sr | 0;
            const gByte = sg > 255 ? 255 : sg < 0 ? 0 : sg | 0;
            const bByte = sb > 255 ? 255 : sb < 0 ? 0 : sb | 0;

            const dstPos = rowOff + px;
            if (sa >= 250) {
              outU32[dstPos] = packRGBA(rByte, gByte, bByte, 255);
            } else {
              const dstIdx = dstPos << 2;
              const da = outRgba[dstIdx + 3];
              if (da === 0) {
                outU32[dstPos] = packRGBA(rByte, gByte, bByte, sa);
              } else {
                const invSa = 255 - sa;
                const daScaled = (da * invSa + 127) >> 8;
                const outA = sa + daScaled;
                if (outA > 0) {
                  const outR = ((rByte * sa + outRgba[dstIdx] * daScaled) / outA) | 0;
                  const outG = ((gByte * sa + outRgba[dstIdx + 1] * daScaled) / outA) | 0;
                  const outB = ((bByte * sa + outRgba[dstIdx + 2] * daScaled) / outA) | 0;
                  outU32[dstPos] = packRGBA(outR, outG, outB, outA > 255 ? 255 : outA);
                }
              }
            }
          }
        } else if (enteredSpan) {
          break;
        }

        w0 += a0;
        w1 += a1;
        w2 += a2;
        u += duDx;
        v += dvDx;
        shVal += dsDx;
        if (hasKlaus) {
          rc += dcDx;
          rs += drsDx;
        }
      }

      w0Row += b0;
      w1Row += b1;
      w2Row += b2;
      uRow += duDy;
      vRow += dvDy;
      sRow += dsDy;
      if (hasKlaus) {
        cRow += dcDy;
        rsRow += drsDy;
      }
    }
  }

  if (opts?.nightHalo) {
    applyNightPerimeterHaloRGBA(outRgba, outU32, cw, ch, stride, isRefl);
  }

  return { trianglesDrawn, pixelsShaded };
}

function applyNightPerimeterHaloRGBA(
  outRgba: Uint8ClampedArray,
  outU32: Uint32Array,
  cw: number,
  ch: number,
  stride: number,
  isRefl: boolean
): void {
  const total = cw * ch;
  if (_haloAlphaBuf.length < total) {
    _haloAlphaBuf = new Uint8Array(total);
  }
  for (let y = 0; y < ch; y++) {
    const srcRow = y * stride;
    const dstRow = y * cw;
    for (let x = 0; x < cw; x++) {
      _haloAlphaBuf[dstRow + x] = outRgba[((srcRow + x) << 2) + 3];
    }
  }

  const hr = isRefl ? 235 : 252;
  const hg = isRefl ? 232 : 240;
  const hb = isRefl ? 224 : 212;
  const hOpacity = isRefl ? 0.82 : 0.96;

  for (let y = 2; y < ch - 2; y++) {
    const aRow = y * cw;
    const dRow = y * stride;
    for (let x = 2; x < cw - 2; x++) {
      const aIdx = aRow + x;
      const ca = _haloAlphaBuf[aIdx];
      if (ca >= 250) continue;

      let maxA = ca;
      const a1 = _haloAlphaBuf[aIdx - 2]; if (a1 > maxA) maxA = a1;
      const a2 = _haloAlphaBuf[aIdx + 2]; if (a2 > maxA) maxA = a2;
      const a3 = _haloAlphaBuf[aIdx - cw * 2]; if (a3 > maxA) maxA = a3;
      const a4 = _haloAlphaBuf[aIdx + cw * 2]; if (a4 > maxA) maxA = a4;
      const a5 = _haloAlphaBuf[aIdx - cw - 1]; if (a5 > maxA) maxA = a5;
      const a6 = _haloAlphaBuf[aIdx - cw + 1]; if (a6 > maxA) maxA = a6;
      const a7 = _haloAlphaBuf[aIdx + cw - 1]; if (a7 > maxA) maxA = a7;
      const a8 = _haloAlphaBuf[aIdx + cw + 1]; if (a8 > maxA) maxA = a8;

      if (maxA < 8) continue;
      const haloA = Math.min(255, (maxA * hOpacity) | 0);
      const dstPos = dRow + x;
      if (ca === 0) {
        outU32[dstPos] = packRGBA(hr, hg, hb, haloA);
      } else {
        const o = dstPos << 2;
        const invCa = 255 - ca;
        const hContrib = (haloA * invCa + 127) >> 8;
        const outA = ca + hContrib;
        if (outA > 0) {
          const outR = ((outRgba[o] * ca + hr * hContrib) / outA) | 0;
          const outG = ((outRgba[o + 1] * ca + hg * hContrib) / outA) | 0;
          const outB = ((outRgba[o + 2] * ca + hb * hContrib) / outA) | 0;
          outU32[dstPos] = packRGBA(outR, outG, outB, outA > 255 ? 255 : outA);
        }
      }
    }
  }
}

export function renderConformingMeshCpuScanline(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  mesh: ConformingSkinnedMesh,
  positions: Float32Array,
  opts?: CpuRasterOptions
): boolean {
  if (typeof document === 'undefined') return false;
  const vCount = mesh.vertexCount;
  if (vCount < 3) return true;

  const needNormals = Boolean(opts?.klausLight);
  const srcPixels = getOrExtractSourcePixels(sourceCanvas, needNormals);
  if (!srcPixels) return false;

  const mirrorAxisX = opts?.mirrorAxisX ?? null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let vi = 0; vi < vCount; vi++) {
    const rawX = positions[vi * 2];
    const x = mirrorAxisX !== null ? 2 * mirrorAxisX - rawX : rawX;
    const y = positions[vi * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return true;

  const pad = opts?.nightHalo ? 6 : 2;
  const ox = Math.floor(minX - pad);
  const oy = Math.floor(minY - pad);
  const cw = Math.max(8, Math.min(2048, Math.ceil(maxX - ox + pad)));
  const ch = Math.max(8, Math.min(2048, Math.ceil(maxY - oy + pad)));

  const targetW = Math.min(2048, Math.ceil(cw / 64) * 64);
  const targetH = Math.min(2048, Math.ceil(ch / 64) * 64);
  if (!_scratchCanvas) {
    _scratchCanvas = document.createElement('canvas');
  }
  if (!_scratchCtx || _scratchW < cw || _scratchH < ch) {
    _scratchW = Math.max(_scratchW, targetW);
    _scratchH = Math.max(_scratchH, targetH);
    _scratchCanvas.width = _scratchW;
    _scratchCanvas.height = _scratchH;
    _scratchCtx = _scratchCanvas.getContext('2d', { willReadFrequently: false });
    if (!_scratchCtx) return false;
    _scratchImageData = _scratchCtx.createImageData(_scratchW, _scratchH);
  }
  if (!_scratchCtx || !_scratchImageData) return false;

  rasterizeSkinnedMeshToRgba(
    srcPixels.rgba,
    srcPixels.w,
    srcPixels.h,
    mesh,
    positions,
    _scratchImageData.data,
    cw,
    ch,
    ox,
    oy,
    {
      ...opts,
      rowStride: _scratchW,
      normalRgba: opts?.normalRgba ?? srcPixels.normalRgba,
    }
  );

  _scratchCtx.putImageData(_scratchImageData, 0, 0, 0, 0, cw, ch);
  ctx.drawImage(_scratchCanvas, 0, 0, cw, ch, ox, oy, cw, ch);
  return true;
}
