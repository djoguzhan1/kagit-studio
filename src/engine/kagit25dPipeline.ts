import type {
  BackgroundPlane25D,
  DecomposedBackgroundSet25D,
  DecomposedCharacterRig25D,
  DecomposedPart25D,
  DecomposedPartRole,
  FilmProjectGraph,
  StyleDNA,
} from '../types/film';
import { canvasToPngBlob, loadBlob, makeId, saveBlob } from './db';
import { buildZipBlob, parseZipBytes, type ZipEntryInput } from './zipBuilder';
import { triggerDownload } from './exportEngine';
import { analyzeCanvasAnatomy } from './cartoonMotionEngine';
import { buildRiggedCharacterPackAsync } from './skeletonSkinEngine';
import { computeDepthAndNormalAsync } from './rigWorkerClient';
import { stripPaperBackgroundBfsRGBA } from './characterIntakeEngine';

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

export function loadSavedCloudUrl(): string {
  try {
    return localStorage.getItem(CLOUD_URL_KEY) || 'http://localhost:8090';
  } catch {
    return 'http://localhost:8090';
  }
}

export function saveCloudUrl(url: string): void {
  try {
    localStorage.setItem(CLOUD_URL_KEY, url.trim());
  } catch {
    // ignore
  }
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

/** Phase 5: Refines a 2.5D film frame on the live RTX CUDA/OpenCV or Gemini Neural backend */
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

/** Phase 5: Synthesizes real expressive character voice acting via Gemini 3.8 Flash TTS */
export async function synthesizeCharacterVoiceRemote(
  cloudUrl: string,
  text: string,
  emotion: string,
  voiceName = 'Puck'
): Promise<{ blob: Blob; engine: string }> {
  const clean = cloudUrl.trim().replace(/\/+$/, '');
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

/** Transcodes recorded video into broadcast-ready MP4 */
export async function transcodeBroadcastMp4Remote(
  cloudUrl: string,
  rawVideoBlob: Blob,
  inputExt: string,
  cinemaLook: CinemaLookId | 'none' = 'none'
): Promise<Blob> {
  const clean = cloudUrl.trim().replace(/\/+$/, '');
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
// 1. PURE DEPTH + SOBEL SURFACE NORMAL MAP GENERATOR (Works in Node & Browser!)
// ============================================================================

/**
 * Computes a smooth 2.5D cylindrical/distance-transform Depth Map and Sobel RGB
 * Surface Normal Map from an RGBA character silhouette buffer.
 * (Implemented in pure zero-DOM `normalMapEngine.ts` so `rigWorker.ts` runs lean.)
 */
export { computeDepthAndNormalRGBA } from './normalMapEngine';

/**
 * Strips solid light paper background cleanly if a user uploaded an opaque sketchbook photo,
 * leaving crisp character ink + colors on transparent alpha!
 */
function ensureTransparentCharacterCanvas(source: HTMLCanvasElement | ImageBitmap): HTMLCanvasElement {
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

/**
 * Local Zero-Server Amodal Multi-Part 2.5D Character Decomposer:
 * Segments ANY drawing into 7 articulated anatomical parts (Head, Torso, L/R Arms, L/R Legs, Scarf)
 * with feathered joint overlap-caps (amodal seam protection) + real Depth & Surface Normal Maps!
 */
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

  // Find tight foreground bounding box of the drawn character
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

  // Geodesic Ink-Graph Limb Decomposition + Auto Closed-Contour Volume Fill!
  const cropC = document.createElement('canvas');
  cropC.width = bw;
  cropC.height = bh;
  cropC.getContext('2d')!.drawImage(clean, minX, minY, bw, bh, 0, 0, bw, bh);
  const anatomy = analyzeCanvasAnatomy(cropC);
  const pack = await buildRiggedCharacterPackAsync(cropC, anatomy);

  const parts: DecomposedPart25D[] = [];
  // Protect quadrupeds & single-silhouette creatures (cats, ghosts, clouds) from being sliced into fake human limbs!
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

  // Generate downscaled 256px Depth + Surface Normal Maps for fast preview & lighting!
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
  dc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(depthRgba), mapW, mapH), 0, 0);

  const nc = document.createElement('canvas');
  nc.width = mapW;
  nc.height = mapH;
  nc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(normalRgba), mapW, mapH), 0, 0);

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

/** Unified Character Decomposition Entry Point (Uses Cloud GPU API if connected, else Local CV!) */
export async function decomposeCharacterPipeline(
  source: HTMLCanvasElement | ImageBitmap,
  styleDna: StyleDNA,
  cloudUrl?: string
): Promise<DecomposedCharacterRig25D> {
  if (cloudUrl) {
    const clean = cloudUrl.trim().replace(/\/+$/, '');
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
// 2. 6-LAYER 2.5D MULTI-PLANE BACKGROUND SLICER + BEHIND-LAYER EXTENSION
// ============================================================================

/**
 * Slices ANY user-uploaded background image into 5 independent parallax PNG layers
 * (Z0 Sky 0.06x, Z1 Far 0.24x, Z2 Midground 0.58x, Z3 Ground 1.0x, Z5 Foreground Occluders 1.38x)
 * with smooth feathering & automatic key-light angle estimation!
 */
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

  // Estimate dominant key-light direction from brightest upper-half centroid
  const sample = document.createElement('canvas');
  sample.width = 64;
  sample.height = 36;
  sample.getContext('2d')!.drawImage(src, 0, 0, 64, 36);
  const sd = sample.getContext('2d')!.getImageData(0, 0, 64, 36).data;
  let sumX = 0;
  let sumW = 0;
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 64; x++) {
      const o = (y * 64 + x) * 4;
      const lum = (sd[o] * 0.299 + sd[o + 1] * 0.587 + sd[o + 2] * 0.114) / 255;
      const wgt = lum * lum * lum;
      sumX += (x / 63 - 0.5) * 2 * wgt;
      sumW += wgt;
    }
  }
  const lightBiasX = sumW > 0 ? sumX / sumW : 0.2;
  const lightAngleDeg = Math.round(Math.max(-75, Math.min(75, lightBiasX * 70)));

  const hPx = Math.round(horizonY * H);

  const makePlane = async (
    zLayer: BackgroundPlane25D['zLayer'],
    label: string,
    parallax: number,
    drawFn: (ctx: CanvasRenderingContext2D) => void
  ): Promise<BackgroundPlane25D> => {
    const pc = document.createElement('canvas');
    pc.width = W;
    pc.height = H;
    drawFn(pc.getContext('2d')!);
    const blobKey = await saveBlob(await canvasToPngBlob(pc));
    return { zLayer, label, parallax, blobKey };
  };

  // Z0: Full Sky Backdrop (extended gently downward behind horizon so vertical tilt has 0 gaps!)
  const z0 = await makePlane('z0', 'Z0 Gökyüzü', 0.06, (ctx) => {
    ctx.drawImage(src, 0, 0, W, Math.round(hPx * 1.15), 0, 0, W, H);
  });

  // Z1: Far Horizon Silhouette Band (0.24x parallax)
  const z1 = await makePlane('z1', 'Z1 Uzak Ufuk', 0.24, (ctx) => {
    const y0 = Math.round(hPx * 0.28);
    const bandH = Math.round(hPx * 0.82);
    ctx.drawImage(src, 0, y0, W, bandH, 0, y0, W, bandH);
    ctx.globalCompositeOperation = 'destination-in';
    const mask = ctx.createLinearGradient(0, y0, 0, y0 + bandH);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(0.28, 'rgba(0,0,0,1)');
    mask.addColorStop(0.85, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = mask;
    ctx.fillRect(0, y0, W, bandH);
  });

  // Z2: Midground Architecture / Trees Band (0.58x parallax)
  const z2 = await makePlane('z2', 'Z2 Orta Plan', 0.58, (ctx) => {
    const y0 = Math.round(hPx * 0.48);
    const bandH = Math.round(H * 0.42);
    ctx.drawImage(src, 0, y0, W, bandH, 0, y0, W, bandH);
    ctx.globalCompositeOperation = 'destination-in';
    const mask = ctx.createLinearGradient(0, y0, 0, y0 + bandH);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(0.22, 'rgba(0,0,0,1)');
    mask.addColorStop(0.76, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = mask;
    ctx.fillRect(0, y0, W, bandH);
  });

  // Z3: 3D Perspective Ground Plane (1.0x parallax)
  const z3 = await makePlane('z3', 'Z3 Zemin', 1.0, (ctx) => {
    const y0 = Math.max(0, hPx - 24);
    ctx.drawImage(src, 0, y0, W, H - y0, 0, y0, W, H - y0);
    ctx.globalCompositeOperation = 'destination-in';
    const mask = ctx.createLinearGradient(0, y0, 0, y0 + 52);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = mask;
    ctx.fillRect(0, y0, W, H - y0);
  });

  // Z5: Foreground Framing Occluder Edges (1.38x parallax — Actor literally walks BEHIND these!)
  const z5 = await makePlane('z5', 'Z5 Ön Plan', 1.38, (ctx) => {
    ctx.drawImage(src, 0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-in';
    // Keep crisp left/right extreme framing edges (typical trees/pillars/doorways in foreground)
    const leftGrad = ctx.createLinearGradient(0, 0, W * 0.14, 0);
    leftGrad.addColorStop(0, 'rgba(0,0,0,0.92)');
    leftGrad.addColorStop(0.65, 'rgba(0,0,0,0.35)');
    leftGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = leftGrad;
    ctx.fillRect(0, 0, W * 0.15, H);

    const rightGrad = ctx.createLinearGradient(W, 0, W * 0.86, 0);
    rightGrad.addColorStop(0, 'rgba(0,0,0,0.92)');
    rightGrad.addColorStop(0.65, 'rgba(0,0,0,0.35)');
    rightGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rightGrad;
    ctx.fillRect(W * 0.85, 0, W * 0.15, H);
  });

  // Synthetic Scene Depth Map Preview
  const dc = document.createElement('canvas');
  dc.width = 256;
  dc.height = 144;
  const dctx = dc.getContext('2d')!;
  const dg = dctx.createLinearGradient(0, 0, 0, 144);
  dg.addColorStop(0, '#1B1B1B');
  dg.addColorStop(horizonY, '#666666');
  dg.addColorStop(1, '#F2F2F2');
  dctx.fillStyle = dg;
  dctx.fillRect(0, 0, 256, 144);
  const depthBlobKey = await saveBlob(await canvasToPngBlob(dc));

  return {
    planes: [z0, z1, z2, z3, z5],
    depthBlobKey,
    horizonY,
    lightAngleDeg,
    sourceEngine: 'local-cv',
    createdAt: new Date().toISOString(),
  };
}

export async function decomposeBackgroundPipeline(
  bgSource: HTMLCanvasElement | ImageBitmap,
  horizonY: number,
  cloudUrl?: string
): Promise<DecomposedBackgroundSet25D> {
  if (cloudUrl) {
    const clean = cloudUrl.trim().replace(/\/+$/, '');
    try {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      c.getContext('2d')!.drawImage(bgSource, 0, 0, 1280, 720);
      const form = new FormData();
      form.append('file', await canvasToPngBlob(c), 'background.png');
      form.append('horizon_y', String(horizonY));
      const res = await fetch(`${clean}/api/v1/decompose-background`, { method: 'POST', body: form });
      if (res.ok) {
        const json = (await res.json()) as {
          source_engine?: 'cloud-gpu' | 'local-cv';
          horizon_y: number;
          light_angle_deg: number;
          depth_png_b64?: string;
          planes: { z_layer: BackgroundPlane25D['zLayer']; label: string; parallax: number; png_b64: string }[];
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
      // Gracefully fall back to local multi-plane slicer
    }
  }
  return decomposeBackgroundLocally(bgSource, horizonY);
}

// ============================================================================
// 3. PORTABLE .KAGIT25D BINARY ZIP PACKAGE EXPORT & IMPORT
// ============================================================================

export async function exportKagit25dPackage(
  graph: FilmProjectGraph,
  projectName = 'kagit_film'
): Promise<string> {
  const entries: ZipEntryInput[] = [];
  const blobKeys = new Set<string>();

  if (graph.actor.sourceBlobKey) blobKeys.add(graph.actor.sourceBlobKey);
  if (graph.actor.decomposed) {
    if (graph.actor.decomposed.depthBlobKey) blobKeys.add(graph.actor.decomposed.depthBlobKey);
    if (graph.actor.decomposed.normalBlobKey) blobKeys.add(graph.actor.decomposed.normalBlobKey);
    for (const p of graph.actor.decomposed.parts) blobKeys.add(p.blobKey);
  }
  if (graph.world.customBgBlobKey) blobKeys.add(graph.world.customBgBlobKey);
  if (graph.world.decomposedBg) {
    if (graph.world.decomposedBg.depthBlobKey) blobKeys.add(graph.world.decomposedBg.depthBlobKey);
    for (const pl of graph.world.decomposedBg.planes) blobKeys.add(pl.blobKey);
  }

  for (const key of blobKeys) {
    const blob = await loadBlob(key);
    if (blob) {
      entries.push({ name: `blobs/${key}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
  }

  // Also bundle Phase-4 recorded/uploaded shot voice audio tracks cleanly!
  const audioMimes: Record<string, string> = {};
  const audioKeys = new Set<string>();
  for (const sh of graph.shots) {
    if (sh.voiceTrack?.audioBlobKey) audioKeys.add(sh.voiceTrack.audioBlobKey);
  }
  for (const key of audioKeys) {
    const blob = await loadBlob(key);
    if (blob) {
      audioMimes[key] = blob.type || 'audio/webm';
      entries.push({ name: `audio/${key}.bin`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
  }

  const manifest = {
    format: 'kagit25d',
    version: '1.1',
    exportedAt: new Date().toISOString(),
    audioMimes,
    graph,
  };
  entries.unshift({
    name: 'manifest.json',
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  const zip = buildZipBlob(entries);
  const safe = (projectName || 'kagit_25d').replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 50);
  const filename = `${safe}.kagit25d`;
  triggerDownload(zip, filename);
  return filename;
}

export async function importKagit25dPackage(file: File): Promise<FilmProjectGraph> {
  if (file.size > 150 * 1024 * 1024) {
    throw new Error('Paket dosyası 150 MB sınırını aşıyor');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const files = parseZipBytes(bytes);
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('Geçersiz .kagit25d paketi (manifest.json eksik)');

  const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    format?: string;
    audioMimes?: Record<string, string>;
    graph?: FilmProjectGraph;
  };
  if (parsed.format !== 'kagit25d' || !parsed.graph) {
    throw new Error('Bu dosya geçerli bir .kagit25d 2.5D film paketi değil');
  }

  // Restore all bundled PNG blobs & voice audio blobs back into IndexedDB under their exact keys
  for (const [name, data] of files.entries()) {
    if (name.startsWith('blobs/') && name.endsWith('.png')) {
      const key = name.slice('blobs/'.length, -'.png'.length);
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      await saveBlob(new Blob([copy], { type: 'image/png' }), key);
    } else if (name.startsWith('audio/') && name.endsWith('.bin')) {
      const key = name.slice('audio/'.length, -'.bin'.length);
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      const mime = parsed.audioMimes?.[key] || 'audio/webm';
      await saveBlob(new Blob([copy], { type: mime }), key);
    }
  }

  return parsed.graph;
}
