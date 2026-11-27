import type {
  BackgroundPlane25D,
  DecomposedBackgroundSet25D,
  DecomposedCharacterRig25D,
  DecomposedPart25D,
  DecomposedPartRole,
  FilmActor,
  FilmProjectGraph,
  StyleDNA,
} from '../types/film';
import type { StudioLocale } from '../types/studio';
import { canvasToPngBlob, loadBlob, makeId, saveBlob } from './db';
import { buildZipBlob, parseZipBytes, type ZipEntryInput } from './zipBuilder';
import { sanitizeImportMime, triggerDownload } from './exportEngine';
import { analyzeCanvasAnatomy } from './cartoonMotionEngine';
import { buildRiggedCharacterPackAsync } from './skeletonSkinEngine';
import { computeDepthAndNormalAsync } from './rigWorkerClient';
import { stripPaperBackgroundBfsRGBA } from './characterIntakeEngine';
import { translate } from '../i18n/translations';
import { useStudioStore } from '../store/useStudioStore';

export type CinemaLookId =
  | 'ghibli-watercolor'
  | 'klaus-3d-cel'
  | 'anime-makoto'
  | 'noir-35mm';

export type CinemaRefinerEngine = 'gpu-opencv' | 'gemini-neural';

export interface CloudPipelineStatus {
  online: boolean;
  url: string;
  device: string;
  mode: 'gpu-neural' | 'local-cv' | 'offline';
  models: string[];
  cuda?: boolean;
  opencv?: boolean;
  ffmpeg?: boolean;
  gemini?: boolean;
  voices?: Record<string, string>;
}

const CLOUD_URL_KEY = 'kagit:cloud-gpu-url:v1';

/**
 * Returns user-configured remote GPU pipeline URL ONLY if explicitly saved in localStorage.
 * Never falls back to offline `http://localhost:8090` — empty string runs 100% zero-latency local CV!
 */
export function loadSavedCloudUrl(): string {
  try {
    return (localStorage.getItem(CLOUD_URL_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function saveCloudUrl(url: string): void {
  try {
    const clean = url.trim();
    if (!clean) {
      localStorage.removeItem(CLOUD_URL_KEY);
    } else {
      localStorage.setItem(CLOUD_URL_KEY, clean);
    }
  } catch {
    // ignore storage restrictions
  }
}

function resolveConfiguredCloudUrl(explicitUrl?: string): string {
  const raw = explicitUrl !== undefined ? explicitUrl : loadSavedCloudUrl();
  return raw.trim().replace(/\/+$/, '');
}

export async function pingCloudPipeline(baseUrl: string): Promise<CloudPipelineStatus> {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (!clean) {
    return { online: false, url: '', device: 'browser', mode: 'offline', models: [] };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${clean}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      device?: string;
      mode?: 'gpu-neural' | 'local-cv';
      models?: string[];
      cuda?: boolean;
      opencv?: boolean;
      ffmpeg?: boolean;
      gemini?: boolean;
      voices?: Record<string, string>;
    };
    return {
      online: true,
      url: clean,
      device: data.device || 'cpu',
      mode: data.mode || 'local-cv',
      models: Array.isArray(data.models) ? data.models : [],
      cuda: Boolean(data.cuda),
      opencv: Boolean(data.opencv),
      ffmpeg: Boolean(data.ffmpeg),
      gemini: Boolean(data.gemini),
      voices: data.voices,
    };
  } catch {
    return { online: false, url: clean, device: 'browser', mode: 'offline', models: [] };
  }
}

/** Phase 5: Refines a 2.5D film frame on an explicitly configured remote CUDA/OpenCV or Neural backend */
export async function refineCinemaFrameRemote(
  sourceCanvas: HTMLCanvasElement,
  opts: {
    cloudUrl: string;
    look: CinemaLookId;
    engine: CinemaRefinerEngine;
    lightAngleDeg: number;
    styleDna: StyleDNA;
  }
): Promise<{ blob: Blob; objectUrl: string; engine: string; look: string; elapsedMs: number }> {
  const clean = opts.cloudUrl.trim().replace(/\/+$/, '');
  if (!clean) {
    throw new Error('Sinema dokusu sunucu adresi tanımlı değil');
  }
  const pngBlob = await canvasToPngBlob(sourceCanvas);
  const form = new FormData();
  form.append('file', pngBlob, 'frame.png');
  form.append('look', opts.look);
  form.append('engine', opts.engine);
  form.append('light_angle_deg', String(opts.lightAngleDeg));
  form.append('style_dna_json', JSON.stringify(opts.styleDna));

  const res = await fetch(`${clean}/api/v1/refine-frame`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error('Sinema dokusu uygulanamadı');
  }
  const json = (await res.json()) as {
    refined_png_b64: string;
    engine: string;
    look: string;
    elapsed_ms: number;
  };
  const blob = base64PngToBlob(json.refined_png_b64);
  return {
    blob,
    objectUrl: URL.createObjectURL(blob),
    engine: json.engine,
    look: json.look,
    elapsedMs: json.elapsed_ms,
  };
}

/** Synthesizes character voice on an explicitly configured remote server */
export async function synthesizeCharacterVoiceRemote(
  cloudUrl: string,
  text: string,
  emotion: string,
  voiceName = 'Puck'
): Promise<{ blob: Blob; engine: string }> {
  const clean = cloudUrl.trim().replace(/\/+$/, '');
  if (!clean) {
    throw new Error('Ses sunucusu tanımlı değil');
  }
  const res = await fetch(`${clean}/api/v1/synthesize-voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, emotion, voice_name: voiceName }),
  });
  if (!res.ok) {
    throw new Error('Seslendirme oluşturulamadı');
  }
  const engine = res.headers.get('X-Voice-Engine') || 'studio-voice';
  const blob = await res.blob();
  return { blob, engine };
}

/** Transcodes recorded video into broadcast-ready MP4 via remote server when configured */
export async function transcodeBroadcastMp4Remote(
  cloudUrl: string,
  rawVideoBlob: Blob,
  inputExt: string,
  cinemaLook: CinemaLookId | 'none' = 'none'
): Promise<Blob> {
  const clean = cloudUrl.trim().replace(/\/+$/, '');
  if (!clean) {
    throw new Error('Dönüştürme sunucusu tanımlı değil');
  }
  const form = new FormData();
  form.append('file', rawVideoBlob, `movie.${inputExt}`);
  form.append('cinema_look', cinemaLook);

  const res = await fetch(`${clean}/api/v1/transcode-mp4`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error('MP4 dışa aktarma tamamlanamadı');
  }
  return await res.blob();
}

function base64PngToBlob(b64: string): Blob {
  const clean = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

// ============================================================================
// 1. PURE DEPTH + SURFACE NORMAL MAP GENERATOR (Works in Node & Browser!)
// ============================================================================

export { computeDepthAndNormalRGBA } from './normalMapEngine';

function ensureTransparentCharacterCanvas(
  source: HTMLCanvasElement | ImageBitmap
): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  if (stripPaperBackgroundBfsRGBA(img.data, w, h)) {
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

export async function decomposeCharacterLocally(
  source: HTMLCanvasElement | ImageBitmap,
  styleDna: StyleDNA
): Promise<DecomposedCharacterRig25D> {
  const clean = ensureTransparentCharacterCanvas(source);
  const W = clean.width;
  const H = clean.height;
  const ctx = clean.getContext('2d')!;
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;

  let minX = W;
  let minY = H;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 28) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) {
    minX = 0;
    minY = 0;
    maxX = W - 1;
    maxY = H - 1;
  }

  const bw = Math.max(16, maxX - minX);
  const bh = Math.max(16, maxY - minY);

  const cropC = document.createElement('canvas');
  cropC.width = bw;
  cropC.height = bh;
  cropC.getContext('2d')!.drawImage(clean, minX, minY, bw, bh, 0, 0, bw, bh);
  const anatomy = analyzeCanvasAnatomy(cropC);
  const pack = await buildRiggedCharacterPackAsync(cropC, anatomy);

  const parts: DecomposedPart25D[] = [];
  if (!pack.useMultiPart) {
    const blobKey = await saveBlob(await canvasToPngBlob(pack.filledCanvas));
    parts.push({
      id: makeId('p25'),
      role: 'torso',
      label: 'Gövde',
      blobKey,
      x: minX,
      y: minY,
      w: bw,
      h: bh,
      pivotX: Math.round(anatomy.centerX * bw),
      pivotY: Math.round(anatomy.hipV * bh),
      zIndex: 4,
      rigidity: 0.72,
    });
  } else {
    const roleMeta: {
      role: DecomposedPartRole;
      label: string;
      zIndex: number;
      rigidity: number;
    }[] = [
      { role: 'leg_l', label: 'Sol Bacak', zIndex: 1, rigidity: 0.72 },
      { role: 'leg_r', label: 'Sağ Bacak', zIndex: 2, rigidity: 0.72 },
      { role: 'arm_l', label: 'Sol Kol', zIndex: 3, rigidity: 0.62 },
      { role: 'torso', label: 'Gövde', zIndex: 4, rigidity: 0.65 },
      { role: 'arm_r', label: 'Sağ Kol', zIndex: 5, rigidity: 0.62 },
      { role: 'head', label: 'Baş', zIndex: 6, rigidity: 1.0 },
    ];

    for (const rm of roleMeta) {
      const seg = pack.parts[rm.role as keyof typeof pack.parts];
      if (!seg || seg.pixelCount < 4) continue;
      const sx0 = Math.max(0, Math.floor(seg.u0 * bw) - 2);
      const sy0 = Math.max(0, Math.floor(seg.v0 * bh) - 2);
      const sx1 = Math.min(bw, Math.ceil(seg.u1 * bw) + 2);
      const sy1 = Math.min(bh, Math.ceil(seg.v1 * bh) + 2);
      const pw = Math.max(8, sx1 - sx0);
      const ph = Math.max(8, sy1 - sy0);

      const pc = document.createElement('canvas');
      pc.width = pw;
      pc.height = ph;
      const pctx = pc.getContext('2d')!;
      if (rm.role === 'torso') {
        pctx.save();
        pctx.fillStyle = styleDna.palette[0] || '#26221F';
        pctx.globalAlpha = 0.25;
        pctx.beginPath();
        pctx.ellipse(pw * 0.5, ph * 0.34, pw * 0.32, ph * 0.24, 0, 0, Math.PI * 2);
        pctx.fill();
        pctx.restore();
      }
      pctx.drawImage(seg.canvas, sx0, sy0, pw, ph, 0, 0, pw, ph);

      const blobKey = await saveBlob(await canvasToPngBlob(pc));
      parts.push({
        id: makeId('p25'),
        role: rm.role,
        label: rm.label,
        blobKey,
        x: minX + sx0,
        y: minY + sy0,
        w: pw,
        h: ph,
        pivotX: Math.max(0, Math.min(pw, Math.round(seg.root.x * bw - sx0))),
        pivotY: Math.max(0, Math.min(ph, Math.round(seg.root.y * bh - sy0))),
        zIndex: rm.zIndex,
        rigidity: rm.rigidity,
      });
    }
  }

  const mapW = 256;
  const mapH = Math.max(64, Math.round((H / Math.max(1, W)) * mapW));
  const mc = document.createElement('canvas');
  mc.width = mapW;
  mc.height = mapH;
  mc.getContext('2d')!.drawImage(clean, 0, 0, mapW, mapH);
  const mRgba = mc.getContext('2d')!.getImageData(0, 0, mapW, mapH).data;
  const { depthRgba, normalRgba } = await computeDepthAndNormalAsync(mRgba, mapW, mapH);

  const dc = document.createElement('canvas');
  dc.width = mapW;
  dc.height = mapH;
  dc.getContext('2d')!.putImageData(
    new ImageData(new Uint8ClampedArray(depthRgba), mapW, mapH),
    0,
    0
  );

  const nc = document.createElement('canvas');
  nc.width = mapW;
  nc.height = mapH;
  nc.getContext('2d')!.putImageData(
    new ImageData(new Uint8ClampedArray(normalRgba), mapW, mapH),
    0,
    0
  );

  const [depthBlobKey, normalBlobKey] = await Promise.all([
    saveBlob(await canvasToPngBlob(dc)),
    saveBlob(await canvasToPngBlob(nc)),
  ]);

  return {
    parts,
    depthBlobKey,
    normalBlobKey,
    sourceEngine: 'local-cv',
    createdAt: new Date().toISOString(),
  };
}

export async function decomposeCharacterPipeline(
  source: HTMLCanvasElement | ImageBitmap,
  styleDna: StyleDNA,
  cloudUrl?: string
): Promise<DecomposedCharacterRig25D> {
  const clean = resolveConfiguredCloudUrl(cloudUrl);
  if (clean) {
    try {
      const srcCanvas = ensureTransparentCharacterCanvas(source);
      const pngBlob = await canvasToPngBlob(srcCanvas);
      const form = new FormData();
      form.append('file', pngBlob, 'character.png');
      const res = await fetch(`${clean}/api/v1/decompose-character`, { method: 'POST', body: form });
      if (res.ok) {
        const json = (await res.json()) as {
          source_engine?: 'cloud-gpu' | 'local-cv';
          depth_png_b64?: string;
          normal_png_b64?: string;
          parts: {
            role: DecomposedPartRole;
            label: string;
            png_b64: string;
            x: number;
            y: number;
            w: number;
            h: number;
            pivot_x: number;
            pivot_y: number;
            z_index: number;
            rigidity: number;
          }[];
        };
        const parts: DecomposedPart25D[] = [];
        for (const p of json.parts) {
          const blobKey = await saveBlob(base64PngToBlob(p.png_b64));
          parts.push({
            id: makeId('p25'),
            role: p.role,
            label: p.label,
            blobKey,
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            pivotX: p.pivot_x,
            pivotY: p.pivot_y,
            zIndex: p.z_index,
            rigidity: p.rigidity,
          });
        }
        const depthBlobKey = json.depth_png_b64
          ? await saveBlob(base64PngToBlob(json.depth_png_b64))
          : null;
        const normalBlobKey = json.normal_png_b64
          ? await saveBlob(base64PngToBlob(json.normal_png_b64))
          : null;
        return {
          parts,
          depthBlobKey,
          normalBlobKey,
          sourceEngine: json.source_engine === 'local-cv' ? 'local-cv' : 'cloud-gpu',
          createdAt: new Date().toISOString(),
        };
      }
    } catch {
      // Gracefully fall back to local CV engine below
    }
  }
  return decomposeCharacterLocally(source, styleDna);
}

// ============================================================================
// 2. SMART PIXEL-AWARE 2.5D DEPTH & MULTI-PLANE DECOMPOSER (ZERO BLIND Z5 CUTS!)
// ============================================================================

export interface SmartBackgroundAnalysisResult {
  width: number;
  height: number;
  horizonY: number;
  lightAngleDeg: number;
  /** Continuous pixel-aware normalized depth [0 = far sky .. 1 = close foreground] */
  depthField: Float32Array;
  /** Sky/wall backdrop probability [0..1] */
  skyProb: Float32Array;
  /** Foreground occluder alpha [0..1] (strictly 0 on flat sky/walls; >0 ONLY on bottom-anchored vertical structures crossing horizon!) */
  z5Alpha: Float32Array;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / Math.max(1e-5, e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * Pure pixel-level 2.5D scene analyzer:
 *  (a) Detects real horizon `y_h` via horizontal Sobel gradient energy + vertical color step,
 *  (b) Models upper sky/wall RGB distribution (mean + variance + gradient flatness),
 *  (c) Extracts true connected foreground vertical occluders (`y > 0.88H` bottom-anchored AND crossing `y_h` vertically),
 *      guaranteeing `z5Alpha === 0` across sky/flat-wall regions (never blindly slicing left/right 15%!),
 *  (d) Synthesizes a bilateral edge-preserving depth map driven by edges, color affinity, and perspective ground geometry.
 */
export function analyzeSmartBackgroundDepthRGBA(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  hintHorizonY = 0.56
): SmartBackgroundAnalysisResult {
  const W = Math.max(16, width);
  const H = Math.max(16, height);
  const N = W * H;

  const lum = new Float32Array(N);
  let lightSumX = 0;
  let lightSumW = 0;
  const upperLightRows = Math.max(4, Math.floor(H * 0.45));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;
      const l = (rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114) / 255;
      lum[i] = l;
      if (y < upperLightRows) {
        const wgt = l * l * l;
        lightSumX += (x / Math.max(1, W - 1) - 0.5) * 2 * wgt;
        lightSumW += wgt;
      }
    }
  }

  const lightBiasX = lightSumW > 1e-4 ? lightSumX / lightSumW : 0.2;
  const lightAngleDeg = Math.round(Math.max(-75, Math.min(75, lightBiasX * 70)));

  // 1. Sobel X / Y gradients
  const gxArr = new Float32Array(N);
  const gyArr = new Float32Array(N);
  const gradMag = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const tl = lum[i - W - 1];
      const tc = lum[i - W];
      const tr = lum[i - W + 1];
      const ml = lum[i - 1];
      const mr = lum[i + 1];
      const bl = lum[i + W - 1];
      const bc = lum[i + W];
      const br = lum[i + W + 1];
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      gxArr[i] = Math.abs(gx) * 0.25;
      gyArr[i] = Math.abs(gy) * 0.25;
      gradMag[i] = Math.min(1, Math.hypot(gxArr[i], gyArr[i]));
    }
  }

  // (a) Real Horizon Detection via Horizontal Sobel Energy + Vertical Color Jump
  const yMinSearch = Math.max(2, Math.floor(H * 0.24));
  const yMaxSearch = Math.min(H - 3, Math.floor(H * 0.78));
  const rowScores = new Float32Array(H);
  let maxHorizEnergy = 0;

  for (let y = yMinSearch; y <= yMaxSearch; y++) {
    let rowEnergy = 0;
    const yAbove = Math.max(0, y - 3);
    const yBelow = Math.min(H - 1, y + 3);
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      const horizDom = gyArr[i] / (gxArr[i] + 0.035);
      const oA = (yAbove * W + x) * 4;
      const oB = (yBelow * W + x) * 4;
      const colorStep =
        (Math.abs(rgba[oA] - rgba[oB]) +
          Math.abs(rgba[oA + 1] - rgba[oB + 1]) +
          Math.abs(rgba[oA + 2] - rgba[oB + 2])) /
        (3 * 255);
      rowEnergy += gyArr[i] * Math.min(2.2, 0.5 + horizDom * 0.5) + colorStep * 0.45;
    }
    rowScores[y] = rowEnergy / Math.max(1, W - 4);
    if (rowScores[y] > maxHorizEnergy) maxHorizEnergy = rowScores[y];
  }

  let detectedHorizonY = Math.max(0.3, Math.min(0.74, hintHorizonY));
  if (maxHorizEnergy > 0.028) {
    let bestScore = -1;
    let bestRow = Math.round(detectedHorizonY * H);
    for (let y = yMinSearch; y <= yMaxSearch; y++) {
      // 5-tap smoothing + gentle prior centered around hintHorizonY
      const sm =
        (rowScores[Math.max(yMinSearch, y - 2)] +
          2 * rowScores[Math.max(yMinSearch, y - 1)] +
          3 * rowScores[y] +
          2 * rowScores[Math.min(yMaxSearch, y + 1)] +
          rowScores[Math.min(yMaxSearch, y + 2)]) /
        9;
      const normY = y / H;
      const prior = 1 - Math.min(0.32, Math.abs(normY - hintHorizonY) * 0.65);
      const total = sm * prior;
      if (total > bestScore) {
        bestScore = total;
        bestRow = y;
      }
    }
    detectedHorizonY = Math.max(0.28, Math.min(0.75, bestRow / H));
  }
  const yhRow = Math.round(detectedHorizonY * H);

  // (b) Upper Sky / Backdrop Wall Color Distribution (top band of scene)
  const skySampleRows = Math.max(4, Math.floor(yhRow * 0.34));
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumR2 = 0;
  let sumG2 = 0;
  let sumB2 = 0;
  let skyCnt = 0;
  for (let y = 0; y < skySampleRows; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // Prefer calm low-gradient pixels when estimating sky/backdrop color
      if (gradMag[i] > 0.25 && skyCnt > 16) continue;
      const o = i * 4;
      const r = rgba[o] / 255;
      const g = rgba[o + 1] / 255;
      const b = rgba[o + 2] / 255;
      sumR += r;
      sumG += g;
      sumB += b;
      sumR2 += r * r;
      sumG2 += g * g;
      sumB2 += b * b;
      skyCnt++;
    }
  }
  if (skyCnt === 0) {
    sumR = rgba[0] / 255;
    sumG = rgba[1] / 255;
    sumB = rgba[2] / 255;
    skyCnt = 1;
  }
  const meanR = sumR / skyCnt;
  const meanG = sumG / skyCnt;
  const meanB = sumB / skyCnt;
  const stdR = Math.max(0.065, Math.sqrt(Math.max(0, sumR2 / skyCnt - meanR * meanR)) * 1.6);
  const stdG = Math.max(0.065, Math.sqrt(Math.max(0, sumG2 / skyCnt - meanG * meanG)) * 1.6);
  const stdB = Math.max(0.065, Math.sqrt(Math.max(0, sumB2 / skyCnt - meanB * meanB)) * 1.6);

  const skyProb = new Float32Array(N);
  const fgCandidate = new Uint8Array(N);

  // Estimate row-wise median/mean luminance so vertical foreground silhouettes/pillars stand out from their row!
  const rowMeanLum = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) s += lum[y * W + x];
    rowMeanLum[y] = s / W;
  }

  for (let y = 0; y < H; y++) {
    const vNorm = y / Math.max(1, H - 1);
    const skyPrior = 1 - smoothstep(detectedHorizonY - 0.08, detectedHorizonY + 0.14, vNorm);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;
      const r = rgba[o] / 255;
      const g = rgba[o + 1] / 255;
      const b = rgba[o + 2] / 255;
      const d2 =
        ((r - meanR) * (r - meanR)) / (stdR * stdR) +
        ((g - meanG) * (g - meanG)) / (stdG * stdG) +
        ((b - meanB) * (b - meanB)) / (stdB * stdB);
      const colorAff = Math.exp(-0.22 * d2);
      const flatAff = Math.exp(-2.8 * gradMag[i]);
      const pSky = clamp01(colorAff * flatAff * (0.25 + 0.75 * skyPrior));
      skyProb[i] = pSky;

      // Candidate foreground occluder pixel: distinctly non-sky AND high contrast against row background or strong edge/dark silhouette
      const rgbDistFromSky = Math.hypot(r - meanR, g - meanG, b - meanB);
      const rowContrast = Math.abs(lum[i] - rowMeanLum[y]);
      if (
        pSky < 0.28 &&
        rgbDistFromSky > 0.14 &&
        (rowContrast > 0.13 || (lum[i] < 0.22 && meanR + meanG + meanB > 1.05))
      ) {
        fgCandidate[i] = 1;
      }
    }
  }

  // (c) Connected-Component Extraction for True Foreground Occluders (Z5)
  // Strict criteria:
  //   1. Bottom-anchored (`maxY >= floor(0.88 * H)`)
  //   2. Crosses horizon vertically (`minY <= floor(yhRow - 0.08 * H)`)
  //   3. Columnar foreground silhouette (`bboxW <= 0.28 * W`, `area <= 0.24 * N`, vertical Sobel boundary support)
  const visited = new Uint8Array(N);
  const z5Raw = new Float32Array(N);
  const queue = new Int32Array(N);
  const compPixels: number[] = [];
  const bottomAnchorRow = Math.floor(H * 0.88);
  const horizonCrossRow = Math.max(2, Math.floor(yhRow - H * 0.08));

  for (let start = 0; start < N; start++) {
    if (!fgCandidate[start] || visited[start]) continue;
    visited[start] = 1;
    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = start;
    compPixels.length = 0;

    let minX = W;
    let maxX = 0;
    let minY = H;
    let maxY = 0;
    let boundaryGxSum = 0;
    let boundaryCount = 0;

    while (qHead < qTail) {
      const cur = queue[qHead++];
      compPixels.push(cur);
      const cy = Math.floor(cur / W);
      const cx = cur - cy * W;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      let isBorder = false;
      const neighbors = [
        cx > 0 ? cur - 1 : -1,
        cx + 1 < W ? cur + 1 : -1,
        cy > 0 ? cur - W : -1,
        cy + 1 < H ? cur + W : -1,
      ];
      for (const nb of neighbors) {
        if (nb < 0) continue;
        if (!fgCandidate[nb]) {
          isBorder = true;
        } else if (!visited[nb]) {
          visited[nb] = 1;
          queue[qTail++] = nb;
        }
      }
      if (isBorder) {
        boundaryGxSum += gxArr[cur];
        boundaryCount++;
      }
    }

    const spanW = maxX - minX + 1;
    const spanH = maxY - minY + 1;
    const meanBoundaryGx = boundaryCount > 0 ? boundaryGxSum / boundaryCount : 0;
    const aspectTall = spanH / Math.max(1, spanW);

    const isTrueForegroundPillar =
      compPixels.length >= Math.max(12, Math.floor(N * 0.004)) &&
      compPixels.length <= Math.floor(N * 0.24) &&
      maxY >= bottomAnchorRow &&
      minY <= horizonCrossRow &&
      spanW <= Math.floor(W * 0.28) &&
      aspectTall >= 1.35 &&
      meanBoundaryGx >= 0.045;

    if (isTrueForegroundPillar) {
      for (const idx of compPixels) {
        // Double-guard: sky-colored pixels never leak into Z5
        if (skyProb[idx] < 0.25) {
          z5Raw[idx] = 1;
        }
      }
    }
  }

  // Soft 1px alpha feather on valid Z5 foreground components while keeping sky strictly 0
  const z5Alpha = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (skyProb[i] > 0.35) {
        z5Alpha[i] = 0;
        continue;
      }
      let sum = z5Raw[i] * 4;
      let wSum = 4;
      if (x > 0) {
        sum += z5Raw[i - 1];
        wSum++;
      }
      if (x + 1 < W) {
        sum += z5Raw[i + 1];
        wSum++;
      }
      if (y > 0) {
        sum += z5Raw[i - W];
        wSum++;
      }
      if (y + 1 < H) {
        sum += z5Raw[i + W];
        wSum++;
      }
      const v = sum / wSum;
      z5Alpha[i] = v < 0.08 ? 0 : clamp01(v);
    }
  }

  // (d) Pixel Edge / Color / Position-Driven Continuous Depth Map
  const rawDepth = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const pSky = skyProb[i];
      const edgeTex = Math.min(1, gradMag[i] * 2.4);
      let dVal: number;

      if (y >= yhRow) {
        const gFrac = (y - yhRow) / Math.max(1, H - 1 - yhRow);
        const groundBase = 0.44 + 0.48 * Math.pow(gFrac, 0.85);
        dVal = groundBase * (1 - pSky * 0.55) + 0.08 * pSky + edgeTex * 0.06;
      } else {
        const uFrac = y / Math.max(1, yhRow);
        const skyDepth = 0.04 + 0.09 * uFrac;
        // Non-sky midground structures rising above horizon (hills, buildings, foliage)
        const darkMass = clamp01((0.65 - lum[i]) * 0.55);
        const structDepth = 0.24 + 0.22 * uFrac + 0.14 * edgeTex + 0.08 * darkMass;
        dVal = skyDepth * pSky + structDepth * (1 - pSky);
      }

      if (z5Alpha[i] > 0.01) {
        dVal = Math.max(dVal, 0.92 * z5Alpha[i] + 0.06);
      }
      rawDepth[i] = clamp01(dVal);
    }
  }

  // Edge-preserving 3x3 bilateral pass so silhouettes stay crisp and flat gradients stay silky
  const depthField = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cIdx = y * W + x;
      const cLum = lum[cIdx];
      let acc = 0;
      let wAcc = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = Math.max(0, Math.min(H - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(W - 1, x + dx));
          const nIdx = ny * W + nx;
          const spatialW = dx === 0 && dy === 0 ? 2.0 : dx === 0 || dy === 0 ? 1.0 : 0.6;
          const rangeW = Math.exp(-Math.abs(lum[nIdx] - cLum) * 14);
          const w = spatialW * rangeW;
          acc += rawDepth[nIdx] * w;
          wAcc += w;
        }
      }
      depthField[cIdx] = wAcc > 0 ? acc / wAcc : rawDepth[cIdx];
    }
  }

  return {
    width: W,
    height: H,
    horizonY: Number(detectedHorizonY.toFixed(3)),
    lightAngleDeg,
    depthField,
    skyProb,
    z5Alpha,
  };
}

function sampleFieldBilinear(
  field: Float32Array,
  fw: number,
  fh: number,
  u: number,
  v: number
): number {
  const fx = clamp01(u) * (fw - 1);
  const fy = clamp01(v) * (fh - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(fw - 1, x0 + 1);
  const y1 = Math.min(fh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = field[y0 * fw + x0];
  const v10 = field[y0 * fw + x1];
  const v01 = field[y1 * fw + x0];
  const v11 = field[y1 * fw + x1];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

export async function decomposeBackgroundLocally(
  bgSource: HTMLCanvasElement | ImageBitmap,
  horizonY = 0.56
): Promise<DecomposedBackgroundSet25D> {
  const W = 1280;
  const H = 720;
  const src = document.createElement('canvas');
  src.width = W;
  src.height = H;
  const sctx = src.getContext('2d')!;
  sctx.drawImage(bgSource, 0, 0, W, H);

  // Run pixel-level Sobel horizon + sky color model + connected foreground Z5 + bilateral depth on 320x180
  const AW = 320;
  const AH = 180;
  const anaCanvas = document.createElement('canvas');
  anaCanvas.width = AW;
  anaCanvas.height = AH;
  const actx = anaCanvas.getContext('2d')!;
  actx.drawImage(src, 0, 0, AW, AH);
  const anaRgba = actx.getImageData(0, 0, AW, AH).data;

  const analysis = analyzeSmartBackgroundDepthRGBA(anaRgba, AW, AH, horizonY);
  const resolvedHorizonY = analysis.horizonY;
  const hPx = Math.round(resolvedHorizonY * H);

  // Build reusable 320x180 alpha mask helper upsampled smoothly to 1280x720 via Canvas bilinear smoothing
  const maskSmall = document.createElement('canvas');
  maskSmall.width = AW;
  maskSmall.height = AH;
  const maskSmallCtx = maskSmall.getContext('2d')!;

  const applyMaskPlane = async (
    zLayer: BackgroundPlane25D['zLayer'],
    label: string,
    parallax: number,
    alphaAtPixel: (i: number, x: number, y: number) => number,
    drawBase?: (ctx: CanvasRenderingContext2D) => void
  ): Promise<BackgroundPlane25D> => {
    const pc = document.createElement('canvas');
    pc.width = W;
    pc.height = H;
    const pctx = pc.getContext('2d')!;

    if (drawBase) {
      drawBase(pctx);
    } else {
      pctx.drawImage(src, 0, 0, W, H);
      const maskData = new Uint8ClampedArray(AW * AH * 4);
      for (let y = 0; y < AH; y++) {
        for (let x = 0; x < AW; x++) {
          const i = y * AW + x;
          const a = Math.round(clamp01(alphaAtPixel(i, x, y)) * 255);
          const o = i * 4;
          maskData[o + 3] = a;
        }
      }
      maskSmallCtx.putImageData(new ImageData(maskData, AW, AH), 0, 0);
      pctx.save();
      pctx.globalCompositeOperation = 'destination-in';
      pctx.imageSmoothingEnabled = true;
      pctx.drawImage(maskSmall, 0, 0, AW, AH, 0, 0, W, H);
      pctx.restore();
    }

    const blobKey = await saveBlob(await canvasToPngBlob(pc));
    return { zLayer, label, parallax, blobKey };
  };

  // Z0: Seamless Sky & Far Backdrop Base (extends smoothly to full frame so camera tilt/zoom never exposes gaps!)
  const z0 = await applyMaskPlane('z0', 'Z0 Gökyüzü', 0.06, () => 1, (ctx) => {
    ctx.drawImage(src, 0, 0, W, H);
    // Softly stretch upper horizon band downward as clean behind-layer fill
    const copyH = Math.max(32, Math.min(H, Math.round(hPx * 1.08)));
    ctx.globalAlpha = 0.65;
    ctx.drawImage(src, 0, 0, W, copyH, 0, 0, W, H);
    ctx.globalAlpha = 1;
  });

  // Z1: Distant Horizon Structures (0.24x parallax, depth ~ 0.14..0.42)
  const z1 = await applyMaskPlane('z1', 'Z1 Uzak Ufuk', 0.24, (i, _x, y) => {
    if (analysis.z5Alpha[i] > 0.25) return 0;
    const d = analysis.depthField[i];
    const vNorm = y / Math.max(1, AH - 1);
    const band =
      smoothstep(0.12, 0.22, d) *
      (1 - smoothstep(0.40, 0.54, d)) *
      (1 - smoothstep(resolvedHorizonY + 0.06, resolvedHorizonY + 0.18, vNorm));
    return band * (1 - analysis.skyProb[i] * 0.75);
  });

  // Z2: Midground Architecture / Trees / Hills (0.58x parallax, depth ~ 0.34..0.66)
  const z2 = await applyMaskPlane('z2', 'Z2 Orta Plan', 0.58, (i) => {
    if (analysis.z5Alpha[i] > 0.35) return 0;
    const d = analysis.depthField[i];
    return smoothstep(0.30, 0.42, d) * (1 - smoothstep(0.60, 0.74, d)) * (1 - analysis.skyProb[i] * 0.9);
  });

  // Z3: Sharp Focal-Plane Walkable Ground (1.0x parallax, below detected horizon)
  const z3 = await applyMaskPlane('z3', 'Z3 Zemin', 1.0, (i, _x, y) => {
    const vNorm = y / Math.max(1, AH - 1);
    const groundRamp = smoothstep(resolvedHorizonY - 0.035, resolvedHorizonY + 0.055, vNorm);
    const dRamp = smoothstep(0.38, 0.50, analysis.depthField[i]);
    return Math.max(groundRamp * (1 - analysis.skyProb[i] * 0.85), dRamp * groundRamp);
  });

  // Z5: Connected True Foreground Occluders ONLY (0 alpha on sky/flat walls!)
  const z5 = await applyMaskPlane('z5', 'Z5 Ön Plan', 1.38, (i) => analysis.z5Alpha[i]);

  // Render true pixel-derived continuous depth map (256x144)
  const DW = 256;
  const DH = 144;
  const dc = document.createElement('canvas');
  dc.width = DW;
  dc.height = DH;
  const dctx = dc.getContext('2d')!;
  const depthRgba = new Uint8ClampedArray(DW * DH * 4);
  for (let y = 0; y < DH; y++) {
    const v = y / (DH - 1);
    for (let x = 0; x < DW; x++) {
      const u = x / (DW - 1);
      const dVal = sampleFieldBilinear(analysis.depthField, AW, AH, u, v);
      const gray = Math.max(8, Math.min(252, Math.round(dVal * 255)));
      const o = (y * DW + x) * 4;
      depthRgba[o] = gray;
      depthRgba[o + 1] = gray;
      depthRgba[o + 2] = gray;
      depthRgba[o + 3] = 255;
    }
  }
  dctx.putImageData(new ImageData(depthRgba, DW, DH), 0, 0);
  const depthBlobKey = await saveBlob(await canvasToPngBlob(dc));

  return {
    planes: [z0, z1, z2, z3, z5],
    depthBlobKey,
    horizonY: resolvedHorizonY,
    lightAngleDeg: analysis.lightAngleDeg,
    sourceEngine: 'local-cv',
    createdAt: new Date().toISOString(),
  };
}

export async function decomposeBackgroundPipeline(
  bgSource: HTMLCanvasElement | ImageBitmap,
  horizonY: number,
  cloudUrl?: string
): Promise<DecomposedBackgroundSet25D> {
  const clean = resolveConfiguredCloudUrl(cloudUrl);
  if (clean) {
    try {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      c.getContext('2d')!.drawImage(bgSource, 0, 0, 1280, 720);
      const form = new FormData();
      form.append('file', await canvasToPngBlob(c), 'background.png');
      form.append('horizon_y', String(horizonY));
      const res = await fetch(`${clean}/api/v1/decompose-background`, {
        method: 'POST',
        body: form,
      });
      if (res.ok) {
        const json = (await res.json()) as {
          source_engine?: 'cloud-gpu' | 'local-cv';
          horizon_y: number;
          light_angle_deg: number;
          depth_png_b64?: string;
          planes: {
            z_layer: BackgroundPlane25D['zLayer'];
            label: string;
            parallax: number;
            png_b64: string;
          }[];
        };
        const planes: BackgroundPlane25D[] = [];
        for (const pl of json.planes) {
          planes.push({
            zLayer: pl.z_layer,
            label: pl.label,
            parallax: pl.parallax,
            blobKey: await saveBlob(base64PngToBlob(pl.png_b64)),
          });
        }
        const depthBlobKey = json.depth_png_b64
          ? await saveBlob(base64PngToBlob(json.depth_png_b64))
          : null;
        return {
          planes,
          depthBlobKey,
          horizonY: json.horizon_y ?? horizonY,
          lightAngleDeg: json.light_angle_deg ?? 20,
          sourceEngine: json.source_engine ?? 'cloud-gpu',
          createdAt: new Date().toISOString(),
        };
      }
    } catch {
      // Gracefully fall back to local smart multi-plane slicer
    }
  }
  return decomposeBackgroundLocally(bgSource, horizonY);
}

// ============================================================================
// 3. PORTABLE .KAGIT25D BINARY ZIP PACKAGE EXPORT & IMPORT (Multi-Actor Safe!)
// ============================================================================

function getActiveLocale(explicit?: StudioLocale): StudioLocale {
  if (explicit) return explicit;
  try {
    return useStudioStore.getState().locale;
  } catch {
    return 'tr';
  }
}

export async function exportKagit25dPackage(
  graph: FilmProjectGraph,
  projectName = 'kagit_film'
): Promise<string> {
  const entries: ZipEntryInput[] = [];
  const blobKeys = new Set<string>();
  const imageMimes: Record<string, string> = {};

  const collectActorBlobs = (actor: FilmActor | null | undefined) => {
    if (!actor) return;
    if (actor.sourceBlobKey) blobKeys.add(actor.sourceBlobKey);
    if (actor.decomposed) {
      if (actor.decomposed.depthBlobKey) blobKeys.add(actor.decomposed.depthBlobKey);
      if (actor.decomposed.normalBlobKey) blobKeys.add(actor.decomposed.normalBlobKey);
      for (const p of actor.decomposed.parts) {
        if (p.blobKey) blobKeys.add(p.blobKey);
      }
    }
  };

  collectActorBlobs(graph.actor);
  if (graph.actors) {
    for (const castActor of graph.actors) {
      collectActorBlobs(castActor);
    }
  }

  if (graph.world.customBgBlobKey) blobKeys.add(graph.world.customBgBlobKey);
  if (graph.world.decomposedBg) {
    if (graph.world.decomposedBg.depthBlobKey) blobKeys.add(graph.world.decomposedBg.depthBlobKey);
    for (const pl of graph.world.decomposedBg.planes) {
      if (pl.blobKey) blobKeys.add(pl.blobKey);
    }
  }

  for (const key of blobKeys) {
    const blob = await loadBlob(key);
    if (blob) {
      imageMimes[key] = sanitizeImportMime(blob.type || 'image/png', 'image/png');
      entries.push({ name: `blobs/${key}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
  }

  const audioMimes: Record<string, string> = {};
  const audioKeys = new Set<string>();
  for (const sh of graph.shots) {
    if (sh.voiceTrack?.audioBlobKey) audioKeys.add(sh.voiceTrack.audioBlobKey);
  }
  for (const key of audioKeys) {
    const blob = await loadBlob(key);
    if (blob) {
      audioMimes[key] = sanitizeImportMime(blob.type || 'audio/webm', 'audio/webm');
      entries.push({ name: `audio/${key}.bin`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
  }

  const manifest = {
    format: 'kagit25d',
    version: '1.2',
    exportedAt: new Date().toISOString(),
    imageMimes,
    audioMimes,
    graph,
  };
  entries.unshift({
    name: 'manifest.json',
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  const zip = buildZipBlob(entries);
  const safe = (projectName || 'kagit_25d')
    .replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_')
    .slice(0, 50);
  const filename = `${safe}.kagit25d`;
  triggerDownload(zip, filename);
  return filename;
}

export async function importKagit25dPackage(
  file: File,
  locale?: StudioLocale
): Promise<FilmProjectGraph> {
  const loc = getActiveLocale(locale);
  if (file.size > 150 * 1024 * 1024) {
    throw new Error(translate(loc, 'backupTooLargeErr'));
  }

  let files: Map<string, Uint8Array>;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    files = parseZipBytes(bytes);
  } catch {
    throw new Error(translate(loc, 'backupCorruptDataErr'));
  }

  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) {
    throw new Error(translate(loc, 'backupInvalidErr'));
  }

  let parsed: {
    format?: string;
    imageMimes?: Record<string, string>;
    audioMimes?: Record<string, string>;
    graph?: FilmProjectGraph;
  };
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error(translate(loc, 'backupCorruptDataErr'));
  }

  if (parsed.format !== 'kagit25d' || !parsed.graph) {
    throw new Error(translate(loc, 'backupInvalidErr'));
  }

  // Generate fresh local IndexedDB blob keys (NEVER overwrite existing keys from untrusted ZIP names!)
  const keyMap = new Map<string, string>();

  const remapImage = async (oldKey: string | null | undefined): Promise<string | null> => {
    if (!oldKey) return null;
    if (keyMap.has(oldKey)) return keyMap.get(oldKey)!;
    const data = files.get(`blobs/${oldKey}.png`) ?? files.get(`blobs/${oldKey}`);
    if (!data) return null;
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const safeMime = sanitizeImportMime(parsed.imageMimes?.[oldKey], 'image/png');
    const newKey = await saveBlob(new Blob([copy], { type: safeMime }));
    keyMap.set(oldKey, newKey);
    return newKey;
  };

  const remapAudio = async (oldKey: string | null | undefined): Promise<string | null> => {
    if (!oldKey) return null;
    if (keyMap.has(oldKey)) return keyMap.get(oldKey)!;
    const data = files.get(`audio/${oldKey}.bin`) ?? files.get(`audio/${oldKey}`);
    if (!data) return null;
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const safeMime = sanitizeImportMime(parsed.audioMimes?.[oldKey], 'audio/webm');
    const newKey = await saveBlob(new Blob([copy], { type: safeMime }));
    keyMap.set(oldKey, newKey);
    return newKey;
  };

  const remapActor = async (actor: FilmActor): Promise<FilmActor> => ({
    ...actor,
    sourceBlobKey: await remapImage(actor.sourceBlobKey),
    decomposed: actor.decomposed
      ? {
          ...actor.decomposed,
          depthBlobKey: await remapImage(actor.decomposed.depthBlobKey),
          normalBlobKey: await remapImage(actor.decomposed.normalBlobKey),
          parts: await Promise.all(
            actor.decomposed.parts.map(async (pt) => ({
              ...pt,
              blobKey: (await remapImage(pt.blobKey)) ?? '',
            }))
          ),
        }
      : actor.decomposed ?? null,
  });

  const graph = parsed.graph;
  const remappedPrimary = await remapActor(graph.actor);
  const remappedActors =
    graph.actors && graph.actors.length > 0
      ? await Promise.all(
          graph.actors.map(async (a, idx) =>
            idx === 0 && a.id === graph.actor.id ? remappedPrimary : remapActor(a)
          )
        )
      : undefined;

  return {
    ...graph,
    actor: remappedPrimary,
    ...(remappedActors ? { actors: remappedActors } : {}),
    world: {
      ...graph.world,
      customBgBlobKey: await remapImage(graph.world.customBgBlobKey),
      decomposedBg: graph.world.decomposedBg
        ? {
            ...graph.world.decomposedBg,
            depthBlobKey: await remapImage(graph.world.decomposedBg.depthBlobKey),
            planes: await Promise.all(
              graph.world.decomposedBg.planes.map(async (pl) => ({
                ...pl,
                blobKey: (await remapImage(pl.blobKey)) ?? '',
              }))
            ),
          }
        : graph.world.decomposedBg ?? null,
    },
    shots: await Promise.all(
      graph.shots.map(async (sh) => ({
        ...sh,
        voiceTrack: sh.voiceTrack
          ? {
              ...sh.voiceTrack,
              audioBlobKey: (await remapAudio(sh.voiceTrack.audioBlobKey)) ?? '',
            }
          : sh.voiceTrack ?? null,
      }))
    ),
  };
}
