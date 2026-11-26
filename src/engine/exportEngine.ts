import type { CelFrame, StudioProject, StudioScene } from '../types/studio';
import {
  canvasToPngBlob,
  collectAllReferencedBlobKeys,
  getBlobBitmap,
  loadBlob,
  makeId,
  saveBlob,
} from './db';
import { buildZipBlob, parseZipBytes, type ZipEntryInput } from './zipBuilder';
import { runGifEncode } from './paperWorkerClient';
import { renderFrameComposite } from './frameComposite';
import {
  detectVideoExportSupport,
  encodeFramesToMp4WebCodecs,
  pickBestMediaRecorderFormat,
} from './videoExportEngine';

export { renderFrameComposite };

export type ProgressCallback = (label: string, percent: number) => void;

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

  // Warm parchment backing so stamp reads cleanly on both bright & dark scenes
  ctx.fillStyle = 'rgba(247, 243, 233, 0.9)';
  ctx.beginPath();
  ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, 6 * scale);
  ctx.fill();

  // Outer carved vermilion ink stamp border
  ctx.strokeStyle = '#C9381C';
  ctx.lineWidth = 2.6 * scale;
  ctx.beginPath();
  ctx.roundRect(-boxW / 2 + 2 * scale, -boxH / 2 + 2 * scale, boxW - 4 * scale, boxH - 4 * scale, 4 * scale);
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
  for (const scene of scenes) {
    for (let i = 0; i < scene.frames.length; i++) {
      items.push({ scene, frame: scene.frames[i], indexInScene: i });
    }
  }
  return items;
}

/**
 * 1. Real Video Export (MP4 H.264 where supported, WebM VP9 fallback)
 * Supports Full Multi-Scene Movie Export + Real Mixed Audio!
 */
export async function exportVideoWithAudio(
  project: StudioProject,
  options: {
    hideRoughBlue: boolean;
    scale: 1 | 0.75 | 0.5;
    allScenes?: boolean;
    includeSeal?: boolean;
    onProgress?: ProgressCallback;
  }
): Promise<{ filename: string; mimeType: string }> {
  const w = Math.round(project.width * options.scale);
  const h = Math.round(project.height * options.scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const items = collectRenderItems(project, options.allScenes ?? false);
  options.onProgress?.('Kareler hazırlanıyor…', 8);

  const rendered: { canvas: HTMLCanvasElement; hold: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const c = await renderFrameComposite(project, it.frame, {
      width: w,
      height: h,
      hideRoughBlue: options.hideRoughBlue,
      scene: it.scene,
      frameIndexInScene: it.indexInScene,
    });
    rendered.push({ canvas: c, hold: Math.max(1, it.frame.hold) });
    options.onProgress?.(
      `Kare hazırlanıyor (${i + 1}/${items.length})`,
      8 + Math.round(((i + 1) / items.length) * 32)
    );
  }

  const expanded: HTMLCanvasElement[] = [];
  for (const r of rendered) {
    for (let k = 0; k < r.hold; k++) expanded.push(r.canvas);
  }
  if (expanded.length === 0) throw new Error('Dışa aktarılacak kare yok');

  const sealFrames = options.includeSeal ? Math.max(3, Math.round(project.fps * 0.45)) : 0;
  const sealStartIdx = Math.max(0, expanded.length - sealFrames);

  // Decode project audio once so BOTH WebCodecs MP4 and MediaRecorder paths get crisp synced sound!
  let audioCtx: AudioContext | null = null;
  let decodedAudio: AudioBuffer | null = null;
  if (project.audio && !project.audio.muted) {
    const audioBlob = await loadBlob(project.audio.blobKey);
    if (audioBlob) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AC();
      decodedAudio = await audioCtx
        .decodeAudioData((await audioBlob.arrayBuffer()).slice(0))
        .catch(() => null);
    }
  }

  const support = detectVideoExportSupport();

  // PATH 1 (UNIVERSAL REAL MP4): Prefer WebCodecs H.264 + mp4-muxer when MediaRecorder lacks native MP4!
  // Produces 100% WhatsApp, Instagram Reels, TikTok & iPhone Photos compatible .mp4 even on GPU-free laptops!
  if (!support.nativeMp4Mime && support.webCodecsMp4) {
    const mp4Blob = await encodeFramesToMp4WebCodecs({
      width: w,
      height: h,
      fps: project.fps,
      totalFrames: expanded.length,
      audioBuffer: decodedAudio,
      drawFrame: (fctx, i, fw, fh) => {
        fctx.drawImage(expanded[i], 0, 0, fw, fh);
        if (options.includeSeal && i >= sealStartIdx) {
          const progress = (i - sealStartIdx + 1) / Math.max(1, sealFrames);
          drawKagitSealStamp(fctx, fw, fh, Math.min(0.92, progress * 1.4));
        }
      },
      onProgress: (done, total) => {
        options.onProgress?.(
          `MP4 hazırlanıyor (${done}/${total})`,
          42 + Math.round((done / total) * 54)
        );
      },
    });

    if (mp4Blob) {
      if (audioCtx) await audioCtx.close().catch(() => {});
      const suffix = options.allScenes ? 'tam_film' : `${project.fps}fps`;
      const filename = `${sanitizeName(project.name)}_${suffix}.mp4`;
      triggerDownload(mp4Blob, filename);
      options.onProgress?.('MP4 Video hazır!', 100);
      return { filename, mimeType: 'video/mp4' };
    }
  }

  // PATH 2: Native MediaRecorder (Safari MP4 / Chrome MP4 / Firefox WebM)
  const chosen = pickBestMediaRecorderFormat();
  if (!chosen || typeof canvas.captureStream !== 'function') {
    if (audioCtx) await audioCtx.close().catch(() => {});
    throw new Error(
      'Bu uygulama içi tarayıcı video kaydını desteklemiyor — Paylaşımlık GIF indirebilir veya Chrome/Safari ile açabilirsin.'
    );
  }

  const videoStream = canvas.captureStream(project.fps);
  const combinedStream = new MediaStream(videoStream.getVideoTracks());

  let audioSource: AudioBufferSourceNode | null = null;
  if (audioCtx && decodedAudio && project.audio && !project.audio.muted) {
    const dest = audioCtx.createMediaStreamDestination();
    const gain = audioCtx.createGain();
    gain.gain.value = project.audio.volume;
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = decodedAudio;
    audioSource.connect(gain);
    gain.connect(dest);
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

  for (let i = 0; i < expanded.length; i++) {
    ctx.drawImage(expanded[i], 0, 0, w, h);
    if (options.includeSeal && i >= sealStartIdx) {
      const progress = (i - sealStartIdx + 1) / Math.max(1, sealFrames);
      const alpha = Math.min(0.92, progress * 1.4);
      drawKagitSealStamp(ctx, w, h, alpha);
    }
    options.onProgress?.(
      `Video kaydediliyor (${i + 1}/${expanded.length})`,
      42 + Math.round(((i + 1) / expanded.length) * 54)
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
  const suffix = options.allScenes ? 'tam_film' : `${project.fps}fps`;
  const filename = `${sanitizeName(project.name)}_${suffix}.${chosen.ext}`;
  triggerDownload(blob, filename);
  options.onProgress?.('Video hazır!', 100);
  return { filename, mimeType: chosen.mime };
}

/**
 * 1B. Shareable "Before / After" Reels Clip (Paper Photo OR Blue Rough -> Final Colored Cel Wipe!)
 */
export async function exportBeforeAfterReel(
  project: StudioProject,
  onProgress?: ProgressCallback,
  includeSeal = true
): Promise<string> {
  const w = Math.min(960, project.width);
  const h = Math.round((project.height / project.width) * w);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const frames = project.frames;
  if (frames.length === 0) throw new Error('Kare yok');

  const pairs: { before: HTMLCanvasElement; after: HTMLCanvasElement }[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    // Before: warped paper original if present, else Blue Rough + Ink only
    const before = document.createElement('canvas');
    before.width = w;
    before.height = h;
    const bctx = before.getContext('2d')!;
    bctx.fillStyle = '#EAE0CC';
    bctx.fillRect(0, 0, w, h);
    if (f.paperOriginalBlobKey) {
      const origBmp = await getBlobBitmap(f.paperOriginalBlobKey);
      if (origBmp) bctx.drawImage(origBmp, 0, 0, w, h);
    } else {
      for (const l of f.layers) {
        if (!l.visible || !l.blobKey || l.role === 'color') continue;
        const bmp = await getBlobBitmap(l.blobKey);
        if (bmp) bctx.drawImage(bmp, 0, 0, w, h);
      }
    }

    const after = await renderFrameComposite(project, f, {
      width: w,
      height: h,
      hideRoughBlue: true,
      frameIndexInScene: i,
    });
    pairs.push({ before, after });
    onProgress?.(`Karşılaştırma hazırlanıyor (${i + 1}/${frames.length})`, Math.round(((i + 1) / frames.length) * 40));
  }

  const chosen = pickBestMediaRecorderFormat();
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
  const totalSteps = Math.max(24, pairs.length * 2);
  const frameMs = Math.max(40, Math.round(1000 / project.fps));

  for (let s = 0; s < totalSteps; s++) {
    const pair = pairs[s % pairs.length];
    // Sweep curtain cleanly left-to-right across the clip!
    const t = s / Math.max(1, totalSteps - 1);
    const splitX = Math.round(t * w);

    ctx.drawImage(pair.after, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, w - splitX, h);
    ctx.clip();
    ctx.drawImage(pair.before, 0, 0);
    ctx.restore();

    ctx.strokeStyle = '#E54D2E';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, h);
    ctx.stroke();

    const sealSteps = Math.max(4, Math.round(project.fps * 0.45));
    if (includeSeal && s >= totalSteps - sealSteps) {
      const p = (s - (totalSteps - sealSteps) + 1) / sealSteps;
      drawKagitSealStamp(ctx, w, h, Math.min(0.92, p * 1.4));
    }

    onProgress?.(
      `Dönüşüm klibi işleniyor (${s + 1}/${totalSteps})`,
      42 + Math.round(((s + 1) / totalSteps) * 54)
    );
    await new Promise((r) => setTimeout(r, frameMs));
  }

  recorder.stop();
  const outBlob = await done;
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const filename = `${sanitizeName(project.name)}_donusum_klip.${ext}`;
  triggerDownload(outBlob, filename);
  onProgress?.('Dönüşüm klibi indirildi!', 100);
  return filename;
}

/**
 * 2. Real Adaptive Median-Cut 256-Color Animated GIF via Web Worker
 */
export async function exportAnimatedGif(
  project: StudioProject,
  options: {
    hideRoughBlue: boolean;
    maxWidth?: number;
    allScenes?: boolean;
    onProgress?: ProgressCallback;
  }
): Promise<string> {
  const maxW = options.maxWidth ?? 640;
  const scale = Math.min(1, maxW / project.width);
  const w = Math.max(64, Math.round(project.width * scale));
  const h = Math.max(64, Math.round(project.height * scale));
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
  return filename;
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
): Promise<string> {
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
  return filename;
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
): Promise<string> {
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
  return filename;
}

/**
 * 5. Printable A4 Pocket Flipbook PDF
 */
export async function exportPrintableFlipbookPdf(
  project: StudioProject,
  options: {
    hideRoughBlue: boolean;
    allScenes?: boolean;
    onProgress?: ProgressCallback;
  }
): Promise<string> {
  const items = collectRenderItems(project, options.allScenes ?? false);
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const c = await renderFrameComposite(project, it.frame, {
      width: Math.min(800, project.width),
      height: Math.round((project.height / project.width) * Math.min(800, project.width)),
      hideRoughBlue: options.hideRoughBlue,
      scene: it.scene,
      frameIndexInScene: it.indexInScene,
    });
    canvases.push(c);
    options.onProgress?.(
      `Flipbook sayfaları hazırlanıyor (${i + 1}/${items.length})`,
      Math.round(((i + 1) / items.length) * 75)
    );
  }

  options.onProgress?.('A4 PDF oluşturuluyor…', 88);
  const { generateFlipbookPdfBlob } = await import('./flipbookPdf');
  const pdfBlob = await generateFlipbookPdfBlob(canvases, project.name, project.fps);
  const filename = `${sanitizeName(project.name)}_A4_flipbook.pdf`;
  triggerDownload(pdfBlob, filename);
  options.onProgress?.('Yazdırılabilir Flipbook PDF hazır!', 100);
  return filename;
}

/**
 * 6. Portable Single-File Binary Project Backup (.kagit.zip)
 * Exhaustively packages multi-scene frames, backgrounds, mesh rigs, FK rigs, audio & references!
 */
export async function exportPortableBackupZip(
  project: StudioProject,
  onProgress?: ProgressCallback
): Promise<string> {
  const blobKeys = collectAllReferencedBlobKeys([project]);

  const entries: ZipEntryInput[] = [];
  const mimeMap: Record<string, string> = {};
  const keysArr = [...blobKeys];

  for (let i = 0; i < keysArr.length; i++) {
    const key = keysArr[i];
    const blob = await loadBlob(key);
    if (!blob) continue;
    mimeMap[key] = blob.type || 'application/octet-stream';
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
  return filename;
}

export async function importPortableBackupZip(file: File): Promise<StudioProject> {
  if (file.size > 150 * 1024 * 1024) {
    throw new Error('Yedek dosyası 150 MB sınırını aşıyor');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const map = parseZipBytes(bytes);
  const manifestBytes = map.get('manifest.json');
  if (!manifestBytes) throw new Error('Geçersiz .inktrope.zip yedeği');

  const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    project: StudioProject;
    mimeMap?: Record<string, string>;
  };
  if (!parsed.project || !Array.isArray(parsed.project.frames)) {
    throw new Error('Proje verisi okunamadı');
  }

  const keyMap = new Map<string, string>();
  const remap = async (oldKey: string | null | undefined): Promise<string | null> => {
    if (!oldKey) return null;
    if (keyMap.has(oldKey)) return keyMap.get(oldKey)!;
    const raw = map.get(`blobs/${oldKey}`);
    if (!raw) return null;
    const mime = parsed.mimeMap?.[oldKey] || 'image/png';
    const newKey = await saveBlob(new Blob([raw.buffer as ArrayBuffer], { type: mime }));
    keyMap.set(oldKey, newKey);
    return newKey;
  };

  const remapFrames = async (frames: CelFrame[]): Promise<CelFrame[]> =>
    Promise.all(
      frames.map(async (f) => ({
        ...f,
        id: makeId('frm'),
        thumbKey: await remap(f.thumbKey),
        paperOriginalBlobKey: await remap(f.paperOriginalBlobKey),
        layers: await Promise.all(
          f.layers.map(async (l) => ({
            ...l,
            id: makeId('lyr'),
            blobKey: await remap(l.blobKey),
          }))
        ),
      }))
    );

  const proj = parsed.project;
  const newScenes = proj.scenes
    ? await Promise.all(
        proj.scenes.map(async (sc) => ({
          ...sc,
          id: makeId('scn'),
          backgroundBlobKey: await remap(sc.backgroundBlobKey),
          frames: await remapFrames(sc.frames),
        }))
      )
    : undefined;

  const newFrames = newScenes?.[0]?.frames ?? (await remapFrames(proj.frames));

  const newRigs = await Promise.all(
    (proj.rigs ?? []).map(async (r) => ({
      ...r,
      id: makeId('rig'),
      sourceBlobKey: (await remap(r.sourceBlobKey)) ?? '',
      parts: await Promise.all(
        r.parts.map(async (p) => ({
          ...p,
          blobKey: (await remap(p.blobKey)) ?? '',
        }))
      ),
    }))
  );

  const newMeshRigs = await Promise.all(
    (proj.meshRigs ?? []).map(async (mr) => ({
      ...mr,
      id: makeId('mrg'),
      sourceBlobKey: (await remap(mr.sourceBlobKey)) ?? '',
    }))
  );

  const newAudio = proj.audio
    ? {
        ...proj.audio,
        id: makeId('aud'),
        blobKey: (await remap(proj.audio.blobKey)) ?? '',
      }
    : null;

  const newRefs = await Promise.all(
    (proj.references ?? []).map(async (ref) => ({
      ...ref,
      id: makeId('ref'),
      blobKey: (await remap(ref.blobKey)) ?? '',
    }))
  );

  const newFilmGraph = proj.filmGraph
    ? {
        ...proj.filmGraph,
        actor: {
          ...proj.filmGraph.actor,
          sourceBlobKey: await remap(proj.filmGraph.actor.sourceBlobKey),
          decomposed: proj.filmGraph.actor.decomposed
            ? {
                ...proj.filmGraph.actor.decomposed,
                depthBlobKey: await remap(proj.filmGraph.actor.decomposed.depthBlobKey),
                normalBlobKey: await remap(proj.filmGraph.actor.decomposed.normalBlobKey),
                parts: await Promise.all(
                  proj.filmGraph.actor.decomposed.parts.map(async (pt) => ({
                    ...pt,
                    blobKey: (await remap(pt.blobKey)) ?? '',
                  }))
                ),
              }
            : proj.filmGraph.actor.decomposed ?? null,
        },
        world: {
          ...proj.filmGraph.world,
          customBgBlobKey: await remap(proj.filmGraph.world.customBgBlobKey),
          decomposedBg: proj.filmGraph.world.decomposedBg
            ? {
                ...proj.filmGraph.world.decomposedBg,
                depthBlobKey: await remap(proj.filmGraph.world.decomposedBg.depthBlobKey),
                planes: await Promise.all(
                  proj.filmGraph.world.decomposedBg.planes.map(async (pl) => ({
                    ...pl,
                    blobKey: (await remap(pl.blobKey)) ?? '',
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
                  audioBlobKey: (await remap(sh.voiceTrack.audioBlobKey)) ?? '',
                }
              : sh.voiceTrack ?? null,
          }))
        ),
      }
    : undefined;

  const now = new Date().toISOString();
  return {
    ...proj,
    id: makeId('prj'),
    name: `${proj.name}`,
    frames: newFrames,
    scenes: newScenes,
    activeSceneId: newScenes?.[0]?.id,
    backgroundBlobKey: newScenes?.[0]?.backgroundBlobKey ?? (await remap(proj.backgroundBlobKey)),
    rigs: newRigs,
    meshRigs: newMeshRigs,
    audio: newAudio,
    references: newRefs,
    filmGraph: newFilmGraph,
    updatedAt: now,
  };
}
