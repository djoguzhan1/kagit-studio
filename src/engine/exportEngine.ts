import type {
  AspectPreset,
  CelFrame,
  PaperStyleId,
  StudioLocale,
  StudioProject,
  StudioScene,
} from '../types/studio';
import type { FilmActor } from '../types/film';
import {
  canvasToPngBlob,
  canvasToWebpOrJpegBlob,
  collectAllReferencedBlobKeys,
  getBlobBitmap,
  loadBlob,
  makeId,
  saveBlob,
} from './db';
import {
  buildZipBlob,
  deflateRawSync,
  inflateRawSync,
  parseZipBytes,
  type ZipEntryInput,
} from './zipBuilder';
import { runGifEncode } from './paperWorkerClient';
import { renderFrameComposite } from './frameComposite';
import {
  detectVideoExportSupport,
  encodeFramesToMp4WebCodecs,
  pickBestMediaRecorderFormat,
  resolveExportDimensions,
  type ExportAspectPreset,
} from './videoExportEngine';
import { renderAudioTrackOffline } from './audioEngine';
import { translate } from '../i18n/translations';
import { useStudioStore } from '../store/useStudioStore';
import type { StagePropId } from './shareCodec';

export { renderFrameComposite };

export type ProgressCallback = (label: string, percent: number) => void;

/** Strict allowlist of safe media MIME types accepted during archive imports (prevents Stored XSS via SVG/HTML blobs) */
export const SAFE_IMPORT_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'audio/webm',
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
]);

export function sanitizeImportMime(
  rawMime: string | undefined,
  fallback: 'image/png' | 'audio/webm' = 'image/png'
): string {
  if (!rawMime) return fallback;
  const base = rawMime.split(';')[0].trim().toLowerCase();
  return SAFE_IMPORT_MIMES.has(base) ? base : fallback;
}

function getActiveLocale(explicit?: StudioLocale): StudioLocale {
  if (explicit) return explicit;
  try {
    return useStudioStore.getState().locale;
  } catch {
    return 'tr';
  }
}

/**
 * Draws an artisanal traditional vermilion red artist's seal stamp ("INKTROPE")
 * in the bottom-right corner of the closing frames of exported videos/Reels.
 */
export function drawKagitSealStamp(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  alpha = 0.9
): void {
  if (alpha <= 0.01) return;
  const scale = Math.max(0.65, Math.min(1.4, Math.min(width, height) / 720));
  const pad = Math.round(22 * scale);
  const boxW = Math.round(112 * scale);
  const boxH = Math.round(36 * scale);
  const x = width - boxW - pad;
  const y = height - boxH - pad;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.translate(x + boxW / 2, y + boxH / 2);
  ctx.rotate(-0.045);

  ctx.fillStyle = 'rgba(247, 243, 233, 0.9)';
  ctx.beginPath();
  ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, 6 * scale);
  ctx.fill();

  ctx.strokeStyle = '#C9381C';
  ctx.lineWidth = 2.6 * scale;
  ctx.beginPath();
  ctx.roundRect(
    -boxW / 2 + 2 * scale,
    -boxH / 2 + 2 * scale,
    boxW - 4 * scale,
    boxH - 4 * scale,
    4 * scale
  );
  ctx.stroke();

  ctx.fillStyle = '#C9381C';
  ctx.font = `800 ${Math.round(13.5 * scale)}px "Plus Jakarta Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('INKTROPE', 0, -2 * scale);

  ctx.font = `700 ${Math.round(7.5 * scale)}px "JetBrains Mono", monospace`;
  ctx.fillText('STUDIO', 0, 10 * scale);
  ctx.restore();
}

function sanitizeName(name: string): string {
  return (name || 'inktrope_proje')
    .replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_')
    .slice(0, 60);
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Collects flattened (scene, frame, frameIdxInScene) pairs for single-scene or full-movie export */
function collectRenderItems(
  project: StudioProject,
  allScenes = false
): { scene: StudioScene; frame: CelFrame; indexInScene: number }[] {
  const scenes: StudioScene[] =
    allScenes && project.scenes && project.scenes.length > 0
      ? project.scenes
      : [
          {
            id: project.activeSceneId ?? 'active',
            name: 'Aktif Sahne',
            frames: project.frames,
            backgroundBlobKey: project.backgroundBlobKey ?? null,
            backgroundParallax: project.backgroundParallax ?? 0.35,
            cameraKeyframes: project.cameraKeyframes ?? [],
            atmosphere: project.atmosphere ?? 'none',
          },
        ];

  const items: { scene: StudioScene; frame: CelFrame; indexInScene: number }[] = [];
  for (let s = 0; s < scenes.length; s++) {
    const scene = scenes[s];
    for (let i = 0; i < scene.frames.length; i++) {
      items.push({ scene, frame: scene.frames[i], indexInScene: i });
    }
  }
  return items;
}

/**
 * 1. Real Video Export (WebCodecs H.264 fastStart MP4 primary path, MediaRecorder fallback)
 * - O(1) Streaming Frame Composition (< 35 MB RAM even on 200+ frame HD movies!)
 * - OfflineAudioContext sample-accurate `volume` + `voiceEffect` (`chipmunk`/`giant`/`robot`)
 * - Optional 1-click 9:16 Reels (`1080x1920`) & 1:1 Square (`1080x1080`) framing
 */
export async function exportVideoWithAudio(
  project: StudioProject,
  options: {
    hideRoughBlue: boolean;
    scale: 1 | 0.75 | 0.5;
    aspectPreset?: ExportAspectPreset;
    allScenes?: boolean;
    includeSeal?: boolean;
    onProgress?: ProgressCallback;
  }
): Promise<{ filename: string; mimeType: string; blob: Blob }> {
  const aspectPreset = options.aspectPreset ?? 'native';
  const { width: w, height: h } = resolveExportDimensions(
    project.width,
    project.height,
    options.scale,
    aspectPreset
  );

  const items = collectRenderItems(project, options.allScenes ?? false);
  const exposureToItemIdx: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const hold = Math.max(1, items[i].frame.hold);
    for (let k = 0; k < hold; k++) {
      exposureToItemIdx.push(i);
    }
  }
  if (exposureToItemIdx.length === 0) {
    throw new Error('Dışa aktarılacak kare yok');
  }

  const totalExposures = exposureToItemIdx.length;
  const minPlayableFrames = Math.max(6, Math.ceil(project.fps * 0.5));
  const effectiveEncodedFrames = Math.max(totalExposures, minPlayableFrames);
  const sealFrames = options.includeSeal
    ? Math.min(effectiveEncodedFrames, Math.max(3, Math.round(project.fps * 0.45)))
    : 0;
  const sealStartIdx = Math.max(0, effectiveEncodedFrames - sealFrames);

  // O(1) single-item LRU canvas cache so `hold > 1` reuses the composite with zero re-rendering
  // and 200-frame projects stay under 35 MB instead of allocating 737 MB of canvases!
  let cachedItemIdx = -1;
  let cachedItemCanvas: HTMLCanvasElement | null = null;
  const getCompositeForExposure = async (exposureIdx: number): Promise<HTMLCanvasElement> => {
    const clampedIdx = Math.max(0, Math.min(exposureToItemIdx.length - 1, exposureIdx));
    const itemIdx = exposureToItemIdx[clampedIdx];
    if (itemIdx === cachedItemIdx && cachedItemCanvas) {
      return cachedItemCanvas;
    }
    const it = items[itemIdx];
    cachedItemCanvas = await renderFrameComposite(project, it.frame, {
      width: w,
      height: h,
      hideRoughBlue: options.hideRoughBlue,
      scene: it.scene,
      frameIndexInScene: it.indexInScene,
    });
    cachedItemIdx = itemIdx;
    return cachedItemCanvas;
  };

  options.onProgress?.('Ses ve kareler hazırlanıyor…', 10);

  // Decode & pre-render project audio with exact `volume` and `voiceEffect` via OfflineAudioContext!
  let audioCtx: AudioContext | null = null;
  let processedAudio: AudioBuffer | null = null;
  if (project.audio && !project.audio.muted && project.audio.volume > 0.001) {
    const audioBlob = await loadBlob(project.audio.blobKey);
    if (audioBlob) {
      const AC =
        typeof window !== 'undefined'
          ? window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined;
      if (AC) {
        audioCtx = new AC();
        const rawDecoded = await audioCtx
          .decodeAudioData((await audioBlob.arrayBuffer()).slice(0))
          .catch(() => null);
        if (rawDecoded) {
          const clipDurationSec = effectiveEncodedFrames / project.fps;
          processedAudio = await renderAudioTrackOffline({
            sourceBuffer: rawDecoded,
            durationSec: clipDurationSec,
            volume: project.audio.volume,
            voiceEffect: project.audio.voiceEffect ?? 'natural',
            loop: false,
          }).catch(() => rawDecoded);
        }
      }
    }
  }

  const support = detectVideoExportSupport();
  const aspectTag =
    aspectPreset === '9:16' ? '_9x16' : aspectPreset === '1:1' ? '_1x1' : '';
  const suffix = `${options.allScenes ? 'tam_film' : `${project.fps}fps`}${aspectTag}`;

  // PATH 1 (PRIMARY UNIVERSAL REAL MP4): Always prefer offline WebCodecs H.264 + mp4-muxer (`fastStart`, `moof = false`)!
  if (support.webCodecsMp4) {
    const mp4Blob = await encodeFramesToMp4WebCodecs({
      width: w,
      height: h,
      fps: project.fps,
      totalFrames: totalExposures,
      audioBuffer: processedAudio,
      audioVolume: 1,
      drawFrame: async (fctx, i, fw, fh) => {
        const frameCanvas = await getCompositeForExposure(i);
        fctx.drawImage(frameCanvas, 0, 0, fw, fh);
        if (options.includeSeal && i >= sealStartIdx) {
          const progress = (i - sealStartIdx + 1) / Math.max(1, sealFrames);
          drawKagitSealStamp(fctx, fw, fh, Math.min(0.92, progress * 1.4));
        }
      },
      onProgress: (done, total) => {
        options.onProgress?.(
          `MP4 hazırlanıyor (${done}/${total})`,
          16 + Math.round((done / Math.max(1, total)) * 80)
        );
      },
    });

    if (mp4Blob && mp4Blob.size >= 512) {
      if (audioCtx) await audioCtx.close().catch(() => {});
      const filename = `${sanitizeName(project.name)}_${suffix}.mp4`;
      triggerDownload(mp4Blob, filename);
      options.onProgress?.('MP4 Video hazır!', 100);
      return { filename, mimeType: 'video/mp4', blob: mp4Blob };
    }
  }

  // PATH 2: Hardened Audio-Aware MediaRecorder Fallback
  const hasAudio = Boolean(processedAudio && project.audio && !project.audio.muted);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const chosen = pickBestMediaRecorderFormat(hasAudio);
  if (!chosen || typeof canvas.captureStream !== 'function') {
    if (audioCtx) await audioCtx.close().catch(() => {});
    throw new Error(
      'Bu uygulama içi tarayıcı video kaydını desteklemiyor — Paylaşımlık GIF indirebilir veya Chrome/Safari ile açabilirsin.'
    );
  }

  const videoStream = canvas.captureStream(project.fps);
  const combinedStream = new MediaStream(videoStream.getVideoTracks());

  let audioSource: AudioBufferSourceNode | null = null;
  if (audioCtx && processedAudio && hasAudio) {
    const dest = audioCtx.createMediaStreamDestination();
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = processedAudio;
    audioSource.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => combinedStream.addTrack(t));
  }

  const recorder = new MediaRecorder(combinedStream, {
    mimeType: chosen.mime,
    videoBitsPerSecond: 6_000_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.start();
  if (audioSource) audioSource.start(0);

  const frameDurationMs = 1000 / project.fps;
  const startMs = performance.now();

  for (let i = 0; i < effectiveEncodedFrames; i++) {
    const frameCanvas = await getCompositeForExposure(i);
    ctx.drawImage(frameCanvas, 0, 0, w, h);
    if (options.includeSeal && i >= sealStartIdx) {
      const progress = (i - sealStartIdx + 1) / Math.max(1, sealFrames);
      drawKagitSealStamp(ctx, w, h, Math.min(0.92, progress * 1.4));
    }
    options.onProgress?.(
      `Video kaydediliyor (${i + 1}/${effectiveEncodedFrames})`,
      16 + Math.round(((i + 1) / effectiveEncodedFrames) * 80)
    );
    const targetTime = startMs + (i + 1) * frameDurationMs;
    const wait = Math.max(0, targetTime - performance.now());
    await new Promise((r) => setTimeout(r, wait));
  }

  recorder.stop();
  if (audioSource) {
    try {
      audioSource.stop();
    } catch {
      // already finished
    }
  }

  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  if (audioCtx) {
    await audioCtx.close().catch(() => {});
  }

  const blob = new Blob(chunks, { type: chosen.mime });
  if (blob.size < 256) {
    throw new Error('Video kaydı boş veri üretti — lütfen GIF veya farklı tarayıcı deneyin.');
  }
  const filename = `${sanitizeName(project.name)}_${suffix}.${chosen.ext}`;
  triggerDownload(blob, filename);
  options.onProgress?.('Video hazır!', 100);
  return { filename, mimeType: chosen.mime, blob };
}

/**
 * 1B. Shareable "Before / After" Reels Clip (Paper Photo OR Blue Rough -> Final Colored Cel Wipe!)
 * Respects `frame.hold` timing and uses WebCodecs H.264 MP4 primary path!
 */
export async function exportBeforeAfterReel(
  project: StudioProject,
  onProgress?: ProgressCallback,
  includeSeal = true,
  aspectPreset: ExportAspectPreset = 'native'
): Promise<{ filename: string; blob: Blob; mimeType: string }> {
  const baseScale: 1 | 0.75 | 0.5 = project.width > 1280 ? 0.75 : 1;
  const { width: w, height: h } = resolveExportDimensions(
    Math.min(960, project.width),
    Math.round((project.height / project.width) * Math.min(960, project.width)),
    baseScale,
    aspectPreset
  );

  const frames = project.frames;
  if (frames.length === 0) throw new Error('Kare yok');

  const pairs: { before: HTMLCanvasElement; after: HTMLCanvasElement; hold: number }[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const before = document.createElement('canvas');
    before.width = w;
    before.height = h;
    const bctx = before.getContext('2d')!;
    bctx.fillStyle = '#EAE0CC';
    bctx.fillRect(0, 0, w, h);
    if (f.paperOriginalBlobKey) {
      const origBmp = await getBlobBitmap(f.paperOriginalBlobKey);
      if (origBmp) {
        const s = Math.min(w / Math.max(1, origBmp.width), h / Math.max(1, origBmp.height));
        const dw = Math.round(origBmp.width * s);
        const dh = Math.round(origBmp.height * s);
        bctx.drawImage(origBmp, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh);
      }
    } else {
      const roughOnlyProject: StudioProject = {
        ...project,
        backgroundBlobKey: null,
      };
      const roughFrame: CelFrame = {
        ...f,
        layers: f.layers.filter((l) => l.role !== 'color'),
      };
      const rc = await renderFrameComposite(roughOnlyProject, roughFrame, {
        width: w,
        height: h,
        hideRoughBlue: false,
        frameIndexInScene: i,
      });
      bctx.drawImage(rc, 0, 0, w, h);
    }

    const after = await renderFrameComposite(project, f, {
      width: w,
      height: h,
      hideRoughBlue: true,
      frameIndexInScene: i,
    });
    pairs.push({ before, after, hold: Math.max(1, f.hold) });
    onProgress?.(
      `Karşılaştırma hazırlanıyor (${i + 1}/${frames.length})`,
      Math.round(((i + 1) / frames.length) * 38)
    );
  }

  // Expand according to `frame.hold` exposures and loop at least 2x / >= 24 frames so wipe plays smoothly
  const singlePassIndices: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    for (let k = 0; k < pairs[i].hold; k++) singlePassIndices.push(i);
  }
  const totalSteps = Math.max(24, singlePassIndices.length * 2);
  const sealSteps = Math.max(4, Math.round(project.fps * 0.45));

  const renderWipeStep = (ctx: CanvasRenderingContext2D, s: number, cw: number, ch: number) => {
    const pairIdx = singlePassIndices[s % singlePassIndices.length];
    const pair = pairs[pairIdx];
    const t = s / Math.max(1, totalSteps - 1);
    const splitX = Math.round(t * cw);

    ctx.drawImage(pair.after, 0, 0, cw, ch);
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, cw - splitX, ch);
    ctx.clip();
    ctx.drawImage(pair.before, 0, 0, cw, ch);
    ctx.restore();

    ctx.strokeStyle = '#E54D2E';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, ch);
    ctx.stroke();

    if (includeSeal && s >= totalSteps - sealSteps) {
      const p = (s - (totalSteps - sealSteps) + 1) / sealSteps;
      drawKagitSealStamp(ctx, cw, ch, Math.min(0.92, p * 1.4));
    }
  };

  const support = detectVideoExportSupport();
  if (support.webCodecsMp4) {
    const mp4Blob = await encodeFramesToMp4WebCodecs({
      width: w,
      height: h,
      fps: project.fps,
      totalFrames: totalSteps,
      drawFrame: (fctx, s, fw, fh) => {
        renderWipeStep(fctx, Math.min(s, totalSteps - 1), fw, fh);
      },
      onProgress: (done, total) => {
        onProgress?.(
          `Dönüşüm klibi işleniyor (${done}/${total})`,
          40 + Math.round((done / Math.max(1, total)) * 56)
        );
      },
    });
    if (mp4Blob && mp4Blob.size >= 512) {
      const filename = `${sanitizeName(project.name)}_donusum_klip.mp4`;
      triggerDownload(mp4Blob, filename);
      onProgress?.('Dönüşüm klibi indirildi!', 100);
      return { filename, blob: mp4Blob, mimeType: 'video/mp4' };
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const chosen = pickBestMediaRecorderFormat(false);
  if (!chosen || typeof canvas.captureStream !== 'function') {
    throw new Error('Bu tarayıcı video klibi kaydını desteklemiyor — GIF indirilebilir.');
  }
  const mime = chosen.mime;
  const stream = canvas.captureStream(project.fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });

  recorder.start(100);
  const frameMs = Math.max(40, Math.round(1000 / project.fps));

  for (let s = 0; s < totalSteps; s++) {
    renderWipeStep(ctx, s, w, h);
    onProgress?.(
      `Dönüşüm klibi işleniyor (${s + 1}/${totalSteps})`,
      42 + Math.round(((s + 1) / totalSteps) * 54)
    );
    await new Promise((r) => setTimeout(r, frameMs));
  }

  recorder.stop();
  const outBlob = await done;
  const filename = `${sanitizeName(project.name)}_donusum_klip.${chosen.ext}`;
  triggerDownload(outBlob, filename);
  onProgress?.('Dönüşüm klibi indirildi!', 100);
  return { filename, blob: outBlob, mimeType: mime };
}

/**
 * 2. Real Adaptive Median-Cut 256-Color Animated GIF via Web Worker
 */
export async function exportAnimatedGif(
  project: StudioProject,
  options: {
    hideRoughBlue: boolean;
    maxWidth?: number;
    aspectPreset?: ExportAspectPreset;
    allScenes?: boolean;
    onProgress?: ProgressCallback;
  }
): Promise<{ filename: string; blob: Blob; mimeType: string }> {
  const maxW = options.maxWidth ?? 640;
  const rawTarget = resolveExportDimensions(
    project.width,
    project.height,
    1,
    options.aspectPreset ?? 'native'
  );
  const scale = Math.min(1, maxW / Math.max(rawTarget.width, rawTarget.height * 0.6));
  const w = Math.max(64, Math.round(rawTarget.width * scale));
  const h = Math.max(64, Math.round(rawTarget.height * scale));
  const items = collectRenderItems(project, options.allScenes ?? false);

  const gifFrames: { rgba: Uint8ClampedArray; hold: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const c = await renderFrameComposite(project, it.frame, {
      width: w,
      height: h,
      hideRoughBlue: options.hideRoughBlue,
      scene: it.scene,
      frameIndexInScene: it.indexInScene,
    });
    const rgba = c.getContext('2d')!.getImageData(0, 0, w, h).data;
    gifFrames.push({ rgba, hold: Math.max(1, it.frame.hold) });
    options.onProgress?.(
      `GIF kareleri okunuyor (${i + 1}/${items.length})`,
      Math.round(((i + 1) / items.length) * 55)
    );
  }

  options.onProgress?.('Paylaşımlık GIF hazırlanıyor…', 70);
  const delayCs = Math.max(2, Math.round(100 / project.fps));
  const gifBlob = await runGifEncode({ width: w, height: h, delayCs, frames: gifFrames });
  const filename = `${sanitizeName(project.name)}.gif`;
  triggerDownload(gifBlob, filename);
  options.onProgress?.('GIF indirildi!', 100);
  return { filename, blob: gifBlob, mimeType: 'image/gif' };
}

/**
 * 3. Single-File ZIP PNG Sequence
 */
export async function exportPngSequenceZip(
  project: StudioProject,
  options: {
    hideRoughBlue: boolean;
    transparentBg: boolean;
    allScenes?: boolean;
    onProgress?: ProgressCallback;
  }
): Promise<{ filename: string; blob: Blob; mimeType: string }> {
  const entries: ZipEntryInput[] = [];
  const base = sanitizeName(project.name);
  const items = collectRenderItems(project, options.allScenes ?? false);

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const c = await renderFrameComposite(project, it.frame, {
      hideRoughBlue: options.hideRoughBlue,
      transparentBg: options.transparentBg,
      scene: it.scene,
      frameIndexInScene: it.indexInScene,
    });
    const png = await canvasToPngBlob(c);
    entries.push({
      name: `${base}_${String(i + 1).padStart(4, '0')}.png`,
      data: new Uint8Array(await png.arrayBuffer()),
    });
    options.onProgress?.(
      `PNG paketleniyor (${i + 1}/${items.length})`,
      Math.round(((i + 1) / items.length) * 90)
    );
  }

  const zipBlob = buildZipBlob(entries);
  const filename = `${base}_png_dizisi.zip`;
  triggerDownload(zipBlob, filename);
  options.onProgress?.('ZIP indirildi!', 100);
  return { filename, blob: zipBlob, mimeType: 'application/zip' };
}

/**
 * 4. Game-Engine Sprite Sheet (PNG Atlas + JSON metadata inside one ZIP)
 */
export async function exportSpriteSheetZip(
  project: StudioProject,
  options: {
    hideRoughBlue: boolean;
    transparentBg: boolean;
    cellWidth?: number;
    allScenes?: boolean;
    onProgress?: ProgressCallback;
  }
): Promise<{ filename: string; blob: Blob; mimeType: string }> {
  const items = collectRenderItems(project, options.allScenes ?? false);
  const count = items.length;
  if (count === 0) throw new Error('Kare bulunamadı');

  const cellW = options.cellWidth ?? Math.min(512, project.width);
  const cellH = Math.round((project.height / project.width) * cellW);
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  const sheet = document.createElement('canvas');
  sheet.width = cols * cellW;
  sheet.height = rows * cellH;
  const sctx = sheet.getContext('2d')!;

  const metaFrames: { frame: number; x: number; y: number; w: number; h: number; hold: number }[] = [];

  for (let i = 0; i < count; i++) {
    const it = items[i];
    const c = await renderFrameComposite(project, it.frame, {
      width: cellW,
      height: cellH,
      hideRoughBlue: options.hideRoughBlue,
      transparentBg: options.transparentBg,
      scene: it.scene,
      frameIndexInScene: it.indexInScene,
    });
    const col = i % cols;
    const row = Math.floor(i / cols);
    sctx.drawImage(c, col * cellW, row * cellH);
    metaFrames.push({
      frame: i,
      x: col * cellW,
      y: row * cellH,
      w: cellW,
      h: cellH,
      hold: it.frame.hold,
    });
    options.onProgress?.(
      `Sprite işleniyor (${i + 1}/${count})`,
      Math.round(((i + 1) / count) * 85)
    );
  }

  const pngBlob = await canvasToPngBlob(sheet);
  const base = sanitizeName(project.name);
  const metaJson = JSON.stringify(
    {
      studio: 'INKTROPE Animation Studio',
      name: project.name,
      fps: project.fps,
      columns: cols,
      rows,
      cellSize: { width: cellW, height: cellH },
      sheetSize: { width: sheet.width, height: sheet.height },
      frames: metaFrames,
    },
    null,
    2
  );

  const zipBlob = buildZipBlob([
    { name: `${base}_spritesheet.png`, data: new Uint8Array(await pngBlob.arrayBuffer()) },
    { name: `${base}_spritesheet.json`, data: new TextEncoder().encode(metaJson) },
  ]);

  const filename = `${base}_spritesheet.zip`;
  triggerDownload(zipBlob, filename);
  options.onProgress?.('Sprite Sheet hazır!', 100);
  return { filename, blob: zipBlob, mimeType: 'application/zip' };
}

/**
 * 5. Printable A4 Pocket Flipbook PDF (with Turkish glyphs, `frame.hold` fidelity & flush right thumb-edge!)
 */
export async function exportPrintableFlipbookPdf(
  project: StudioProject,
  options: {
    hideRoughBlue: boolean;
    allScenes?: boolean;
    locale?: StudioLocale;
    onProgress?: ProgressCallback;
  }
): Promise<{ filename: string; blob: Blob; mimeType: string }> {
  const items = collectRenderItems(project, options.allScenes ?? false);
  const canvases: HTMLCanvasElement[] = [];
  const holds: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const targetW = Math.min(800, project.width);
    const targetH = Math.round((project.height / project.width) * targetW);
    const c = await renderFrameComposite(project, it.frame, {
      width: targetW,
      height: targetH,
      hideRoughBlue: options.hideRoughBlue,
      scene: it.scene,
      frameIndexInScene: it.indexInScene,
    });
    canvases.push(c);
    holds.push(Math.max(1, it.frame.hold));
    options.onProgress?.(
      `Flipbook sayfaları hazırlanıyor (${i + 1}/${items.length})`,
      Math.round(((i + 1) / items.length) * 75)
    );
  }

  options.onProgress?.('A4 PDF oluşturuluyor…', 88);
  const { generateFlipbookPdfBlob } = await import('./flipbookPdf');
  const pdfBlob = await generateFlipbookPdfBlob(canvases, project.name, project.fps, {
    holds,
    locale: getActiveLocale(options.locale),
  });
  const filename = `${sanitizeName(project.name)}_A4_flipbook.pdf`;
  triggerDownload(pdfBlob, filename);
  options.onProgress?.('Yazdırılabilir Flipbook PDF hazır!', 100);
  return { filename, blob: pdfBlob, mimeType: 'application/pdf' };
}

/**
 * 6. Portable Single-File Binary Project Backup (.inktrope.zip / .kagit.zip)
 * Exhaustively packages multi-scene frames, backgrounds, mesh rigs, FK rigs, 1..6 multi-actor Film casts, audio & references!
 */
export async function exportPortableBackupZip(
  project: StudioProject,
  onProgress?: ProgressCallback
): Promise<{ filename: string; blob: Blob; mimeType: string }> {
  const blobKeys = collectAllReferencedBlobKeys([project]);

  const entries: ZipEntryInput[] = [];
  const mimeMap: Record<string, string> = {};
  const keysArr = [...blobKeys];

  for (let i = 0; i < keysArr.length; i++) {
    const key = keysArr[i];
    const blob = await loadBlob(key);
    if (!blob) continue;
    mimeMap[key] = sanitizeImportMime(blob.type || 'image/png', 'image/png');
    entries.push({
      name: `blobs/${key}`,
      data: new Uint8Array(await blob.arrayBuffer()),
    });
    onProgress?.(
      `Medya yedekleniyor (${i + 1}/${keysArr.length})`,
      Math.round(((i + 1) / Math.max(1, keysArr.length)) * 85)
    );
  }

  const manifest = JSON.stringify({ format: 'kagit-backup-v2', project, mimeMap }, null, 2);
  entries.unshift({ name: 'manifest.json', data: new TextEncoder().encode(manifest) });

  const zipBlob = buildZipBlob(entries);
  const filename = `${sanitizeName(project.name)}.inktrope.zip`;
  triggerDownload(zipBlob, filename);
  onProgress?.('Yedek indirildi!', 100);
  return { filename, blob: zipBlob, mimeType: 'application/zip' };
}

export async function importPortableBackupZip(
  file: File,
  locale?: StudioLocale
): Promise<StudioProject> {
  const loc = getActiveLocale(locale);
  if (file.size > 150 * 1024 * 1024) {
    throw new Error(translate(loc, 'backupTooLargeErr'));
  }

  let map: Map<string, Uint8Array>;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    map = parseZipBytes(bytes);
  } catch {
    throw new Error(translate(loc, 'backupCorruptDataErr'));
  }

  const manifestBytes = map.get('manifest.json');
  if (!manifestBytes) {
    throw new Error(translate(loc, 'backupInvalidErr'));
  }

  let parsed: {
    project?: StudioProject;
    mimeMap?: Record<string, string>;
  };
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error(translate(loc, 'backupCorruptDataErr'));
  }

  if (!parsed.project || !Array.isArray(parsed.project.frames)) {
    throw new Error(translate(loc, 'backupCorruptDataErr'));
  }

  const keyMap = new Map<string, string>();
  const remap = async (
    oldKey: string | null | undefined,
    kind: 'image' | 'audio' = 'image'
  ): Promise<string | null> => {
    if (!oldKey) return null;
    if (keyMap.has(oldKey)) return keyMap.get(oldKey)!;
    const raw = map.get(`blobs/${oldKey}`);
    if (!raw) return null;
    const safeMime = sanitizeImportMime(
      parsed.mimeMap?.[oldKey],
      kind === 'audio' ? 'audio/webm' : 'image/png'
    );
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const newKey = await saveBlob(new Blob([copy], { type: safeMime }));
    keyMap.set(oldKey, newKey);
    return newKey;
  };

  const remapFrames = async (frames: CelFrame[]): Promise<CelFrame[]> =>
    Promise.all(
      frames.map(async (f) => ({
        ...f,
        id: makeId('frm'),
        thumbKey: await remap(f.thumbKey, 'image'),
        paperOriginalBlobKey: await remap(f.paperOriginalBlobKey, 'image'),
        layers: await Promise.all(
          f.layers.map(async (l) => ({
            ...l,
            id: makeId('lyr'),
            blobKey: await remap(l.blobKey, 'image'),
          }))
        ),
      }))
    );

  const remapFilmActor = async (actor: FilmActor): Promise<FilmActor> => ({
    ...actor,
    sourceBlobKey: await remap(actor.sourceBlobKey, 'image'),
    decomposed: actor.decomposed
      ? {
          ...actor.decomposed,
          depthBlobKey: await remap(actor.decomposed.depthBlobKey, 'image'),
          normalBlobKey: await remap(actor.decomposed.normalBlobKey, 'image'),
          parts: await Promise.all(
            actor.decomposed.parts.map(async (pt) => ({
              ...pt,
              blobKey: (await remap(pt.blobKey, 'image')) ?? '',
            }))
          ),
        }
      : actor.decomposed ?? null,
  });

  const proj = parsed.project;
  const newScenes = proj.scenes
    ? await Promise.all(
        proj.scenes.map(async (sc) => ({
          ...sc,
          id: makeId('scn'),
          backgroundBlobKey: await remap(sc.backgroundBlobKey, 'image'),
          frames: await remapFrames(sc.frames),
        }))
      )
    : undefined;

  const newFrames = newScenes?.[0]?.frames ?? (await remapFrames(proj.frames));

  const newRigs = await Promise.all(
    (proj.rigs ?? []).map(async (r) => ({
      ...r,
      id: makeId('rig'),
      sourceBlobKey: (await remap(r.sourceBlobKey, 'image')) ?? '',
      parts: await Promise.all(
        r.parts.map(async (p) => ({
          ...p,
          blobKey: (await remap(p.blobKey, 'image')) ?? '',
        }))
      ),
    }))
  );

  const newMeshRigs = await Promise.all(
    (proj.meshRigs ?? []).map(async (mr) => ({
      ...mr,
      id: makeId('mrg'),
      sourceBlobKey: (await remap(mr.sourceBlobKey, 'image')) ?? '',
    }))
  );

  const newAudio = proj.audio
    ? {
        ...proj.audio,
        id: makeId('aud'),
        blobKey: (await remap(proj.audio.blobKey, 'audio')) ?? '',
      }
    : null;

  const newRefs = await Promise.all(
    (proj.references ?? []).map(async (ref) => ({
      ...ref,
      id: makeId('ref'),
      blobKey: (await remap(ref.blobKey, 'image')) ?? '',
    }))
  );

  let newFilmGraph = proj.filmGraph;
  if (proj.filmGraph) {
    const remappedPrimary = await remapFilmActor(proj.filmGraph.actor);
    let remappedActors: FilmActor[] | undefined;
    if (proj.filmGraph.actors && proj.filmGraph.actors.length > 0) {
      remappedActors = await Promise.all(
        proj.filmGraph.actors.map(async (a, idx) =>
          idx === 0 && a.id === proj.filmGraph!.actor.id ? remappedPrimary : remapFilmActor(a)
        )
      );
    }
    newFilmGraph = {
      ...proj.filmGraph,
      actor: remappedPrimary,
      ...(remappedActors ? { actors: remappedActors } : {}),
      world: {
        ...proj.filmGraph.world,
        customBgBlobKey: await remap(proj.filmGraph.world.customBgBlobKey, 'image'),
        decomposedBg: proj.filmGraph.world.decomposedBg
          ? {
              ...proj.filmGraph.world.decomposedBg,
              depthBlobKey: await remap(proj.filmGraph.world.decomposedBg.depthBlobKey, 'image'),
              planes: await Promise.all(
                proj.filmGraph.world.decomposedBg.planes.map(async (pl) => ({
                  ...pl,
                  blobKey: (await remap(pl.blobKey, 'image')) ?? '',
                }))
              ),
            }
          : proj.filmGraph.world.decomposedBg ?? null,
      },
      shots: await Promise.all(
        proj.filmGraph.shots.map(async (sh) => ({
          ...sh,
          id: makeId('sht'),
          voiceTrack: sh.voiceTrack
            ? {
                ...sh.voiceTrack,
                audioBlobKey: (await remap(sh.voiceTrack.audioBlobKey, 'audio')) ?? '',
              }
            : sh.voiceTrack ?? null,
        }))
      ),
    };
  }

  const now = new Date().toISOString();
  return {
    ...proj,
    id: makeId('prj'),
    name: `${proj.name}`,
    frames: newFrames,
    scenes: newScenes,
    activeSceneId: newScenes?.[0]?.id,
    backgroundBlobKey:
      newScenes?.[0]?.backgroundBlobKey ?? (await remap(proj.backgroundBlobKey, 'image')),
    rigs: newRigs,
    meshRigs: newMeshRigs,
    audio: newAudio,
    references: newRefs,
    filmGraph: newFilmGraph,
    updatedAt: now,
  };
}

// ============================================================================
// 7. SHORT PROJECT & RASTER CHARACTER SHARE SNAPSHOTS (`/api/share` + Offline `#inktrope-snap=`)
// ============================================================================

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(b64u: string): Uint8Array {
  const padded =
    b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function blobToBase64Url(blob: Blob): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await blob.arrayBuffer()));
}

interface SerializedProjectSnapshot {
  v: 1;
  kind: 'project';
  name: string;
  aspect: AspectPreset;
  width: number;
  height: number;
  fps: 8 | 12 | 15 | 24;
  paperColor: string;
  paperStyle?: PaperStyleId;
  frames: {
    hold: number;
    note?: string;
    mime: string;
    dataB64u: string;
  }[];
}

export interface SerializedStageImageSnapshot {
  v: 1;
  kind: 'stage-image';
  mime: string;
  dataB64u: string;
  mode: 'dance' | 'talk' | 'film' | 'pull';
  mood: 'natural' | 'joy' | 'cool' | 'sneak' | 'sprint';
  world: 'rainy' | 'meadow' | 'space' | 'concert' | 'escape';
  prop?: StagePropId;
  voiceLine?: string;
}

type SerializedShareSnapshot = SerializedProjectSnapshot | SerializedStageImageSnapshot;

async function publishSharePayload(
  kind: 'project' | 'stage-image',
  payloadB64u: string
): Promise<string> {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://inktrope.com';
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';

  if (typeof fetch === 'function' && payloadB64u.length <= 490_000) {
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          payloadB64: payloadB64u,
          mimeType: 'application/x-inktrope-snapshot',
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { id?: string };
        if (json.id && /^[A-Za-z0-9_-]{6,32}$/.test(json.id)) {
          return `${origin}${pathname}?s=${encodeURIComponent(json.id)}`;
        }
      }
    } catch {
      // Offline / static server fallback below
    }
  }
  return `${origin}${pathname}#inktrope-snap=${payloadB64u}`;
}

/** Creates a 1-click shareable URL for any multi-frame `StudioProject` */
export async function createProjectShareLink(project: StudioProject): Promise<string> {
  const maxFrames = Math.min(24, project.frames.length);
  const maxDim = maxFrames > 12 ? 320 : maxFrames > 6 ? 400 : 520;
  const webpQ = maxFrames > 10 ? 0.68 : 0.78;
  const scale = Math.min(1, maxDim / Math.max(project.width, project.height));
  const cw = Math.max(64, Math.round(project.width * scale));
  const ch = Math.max(64, Math.round(project.height * scale));

  const framesOut: SerializedProjectSnapshot['frames'] = [];
  for (let i = 0; i < maxFrames; i++) {
    const f = project.frames[i];
    const c = await renderFrameComposite(project, f, {
      width: cw,
      height: ch,
      hideRoughBlue: false,
      transparentBg: true,
      frameIndexInScene: i,
    });
    const blob = await canvasToWebpOrJpegBlob(c, webpQ).catch(() => canvasToPngBlob(c));
    framesOut.push({
      hold: Math.max(1, f.hold),
      note: f.note,
      mime: sanitizeImportMime(blob.type || 'image/webp', 'image/png'),
      dataB64u: await blobToBase64Url(blob),
    });
  }

  const snap: SerializedProjectSnapshot = {
    v: 1,
    kind: 'project',
    name: project.name,
    aspect: project.aspect,
    width: project.width,
    height: project.height,
    fps: project.fps,
    paperColor: project.paperColor,
    paperStyle: project.paperStyle,
    frames: framesOut,
  };

  const rawJson = new TextEncoder().encode(JSON.stringify(snap));
  const compressed = deflateRawSync(rawJson);
  const payloadB64u = bytesToBase64Url(compressed);
  return publishSharePayload('project', payloadB64u);
}

/** Creates a 1-click shareable URL for an uploaded PNG/paper character on `InstantAliveStage` */
export async function createStageImageShareLink(opts: {
  canvas: HTMLCanvasElement;
  mode: SerializedStageImageSnapshot['mode'];
  mood: SerializedStageImageSnapshot['mood'];
  world: SerializedStageImageSnapshot['world'];
  prop?: StagePropId;
  voiceLine?: string;
}): Promise<string> {
  const maxDim = 480;
  const scale = Math.min(1, maxDim / Math.max(1, opts.canvas.width, opts.canvas.height));
  const w = Math.max(32, Math.round(opts.canvas.width * scale));
  const h = Math.max(32, Math.round(opts.canvas.height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d')!.drawImage(opts.canvas, 0, 0, w, h);

  const blob = await new Promise<Blob>((resolve, reject) => {
    tmp.toBlob(
      (b) => {
        if (b) return resolve(b);
        tmp.toBlob(
          (png) => (png ? resolve(png) : reject(new Error('PNG failed'))),
          'image/png'
        );
      },
      'image/webp',
      0.84
    );
  });

  const snap: SerializedStageImageSnapshot = {
    v: 1,
    kind: 'stage-image',
    mime: sanitizeImportMime(blob.type || 'image/png', 'image/png'),
    dataB64u: await blobToBase64Url(blob),
    mode: opts.mode,
    mood: opts.mood,
    world: opts.world,
    prop: opts.prop,
    voiceLine: opts.voiceLine?.slice(0, 120),
  };

  const rawJson = new TextEncoder().encode(JSON.stringify(snap));
  const compressed = deflateRawSync(rawJson);
  const payloadB64u = bytesToBase64Url(compressed);
  return publishSharePayload('stage-image', payloadB64u);
}

export type ResolvedSharedSnapshot =
  | { kind: 'project'; project: StudioProject }
  | {
      kind: 'stage-image';
      dataUrl: string;
      snapshot: SerializedStageImageSnapshot;
    };

/** Decodes either `?s=<shortId>` (via `/api/share/:id`) or `#inktrope-snap=<b64u>` on app boot */
export async function resolveSharedSnapshotFromLocation(
  href?: string
): Promise<ResolvedSharedSnapshot | null> {
  try {
    const urlStr = href ?? (typeof window !== 'undefined' ? window.location.href : '');
    if (!urlStr) return null;
    const u = new URL(urlStr, 'https://inktrope.com');
    const shortId = u.searchParams.get('s');
    let payloadB64u: string | null = null;

    if (shortId && /^[A-Za-z0-9_-]{6,32}$/.test(shortId) && typeof fetch === 'function') {
      const res = await fetch(`/api/share/${encodeURIComponent(shortId)}`);
      if (res.ok) {
        const json = (await res.json()) as { payloadB64?: string };
        if (typeof json.payloadB64 === 'string') {
          payloadB64u = json.payloadB64;
        }
      }
    } else if (u.hash.startsWith('#inktrope-snap=')) {
      payloadB64u = u.hash.slice('#inktrope-snap='.length).trim();
    }

    if (!payloadB64u) return null;
    const inflated = inflateRawSync(base64UrlToBytes(payloadB64u), 8 * 1024 * 1024);
    const parsed = JSON.parse(new TextDecoder().decode(inflated)) as SerializedShareSnapshot;
    if (!parsed || parsed.v !== 1) return null;

    if (parsed.kind === 'stage-image') {
      const safeMime = sanitizeImportMime(parsed.mime, 'image/png');
      const rawBytes = base64UrlToBytes(parsed.dataB64u);
      let bin = '';
      for (let i = 0; i < rawBytes.length; i++) bin += String.fromCharCode(rawBytes[i]);
      const dataUrl = `data:${safeMime};base64,${btoa(bin)}`;
      return { kind: 'stage-image', dataUrl, snapshot: parsed };
    }

    if (parsed.kind === 'project' && Array.isArray(parsed.frames) && parsed.frames.length > 0) {
      const width = Math.max(128, Math.min(2560, Math.round(parsed.width || 1280)));
      const height = Math.max(128, Math.min(2560, Math.round(parsed.height || 720)));
      const paperColor = /^#[0-9A-Fa-f]{6}$/.test(parsed.paperColor)
        ? parsed.paperColor
        : '#FAF6EE';
      const frames: CelFrame[] = [];

      for (const sf of parsed.frames.slice(0, 48)) {
        const raw = base64UrlToBytes(sf.dataB64u);
        const copy = new Uint8Array(raw.byteLength);
        copy.set(raw);
        const safeMime = sanitizeImportMime(sf.mime, 'image/png');
        const layerBlob = new Blob([copy], { type: safeMime });
        const layerKey = await saveBlob(layerBlob);

        let thumbKey: string | null = layerKey;
        const bmp = await getBlobBitmap(layerKey);
        if (bmp && typeof document !== 'undefined') {
          const tc = document.createElement('canvas');
          tc.width = 512;
          tc.height = Math.max(180, Math.round((height / width) * 512));
          const tctx = tc.getContext('2d')!;
          tctx.fillStyle = paperColor;
          tctx.fillRect(0, 0, tc.width, tc.height);
          tctx.drawImage(bmp, 0, 0, tc.width, tc.height);
          const tb = await canvasToWebpOrJpegBlob(tc, 0.85).catch(() => null);
          if (tb) thumbKey = await saveBlob(tb);
        }

        frames.push({
          id: makeId('frm'),
          hold: Math.max(1, Math.min(24, Math.round(sf.hold || 1))),
          note: typeof sf.note === 'string' ? sf.note.slice(0, 80) : undefined,
          thumbKey,
          layers: [
            {
              id: makeId('lyr'),
              name: 'Boya',
              role: 'color',
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'source-over',
              blobKey: null,
            },
            {
              id: makeId('lyr'),
              name: 'Mürekkep',
              role: 'ink',
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'source-over',
              blobKey: layerKey,
            },
          ],
        });
      }

      const sceneId = makeId('scn');
      const now = new Date().toISOString();
      const fps: 8 | 12 | 15 | 24 =
        parsed.fps === 8 || parsed.fps === 12 || parsed.fps === 15 || parsed.fps === 24
          ? parsed.fps
          : 12;
      const aspect: AspectPreset =
        parsed.aspect === '16:9' ||
        parsed.aspect === '9:16' ||
        parsed.aspect === '1:1' ||
        parsed.aspect === '4:3'
          ? parsed.aspect
          : '16:9';

      const project: StudioProject = {
        id: makeId('prj'),
        name: String(parsed.name || 'Paylaşılan Çizgi Film').slice(0, 80),
        aspect,
        width,
        height,
        fps,
        paperColor,
        paperStyle: parsed.paperStyle ?? 'bristol',
        paperGrain: 0.25,
        frames,
        scenes: [
          {
            id: sceneId,
            name: 'Sahne 1',
            frames,
            backgroundBlobKey: null,
            backgroundParallax: 0.35,
            cameraKeyframes: [],
            atmosphere: 'none',
          },
        ],
        activeSceneId: sceneId,
        rigs: [],
        meshRigs: [],
        audio: null,
        references: [],
        palette: ['#1C1917', '#E54D2E', '#2563EB', '#D99B26', '#16A34A', '#FAF6EE'],
        createdAt: now,
        updatedAt: now,
      };
      return { kind: 'project', project };
    }
    return null;
  } catch {
    return null;
  }
}
