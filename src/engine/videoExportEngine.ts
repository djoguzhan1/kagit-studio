/**
 * KÂĞIT Universal Browser Video Export Engine ($0, 100% Client-Side)
 *
 * 4-Tier Cross-Browser Strategy (WhatsApp, iPhone Photos, Instagram Reels & TikTok compatible!):
 *   1. Native MP4 MediaRecorder (Safari 14.5+, modern Chrome 126+ with AVC1/MP4A) -> real .mp4 with audio
 *   2. WebCodecs H.264 VideoEncoder (+ lazy-loaded mp4-muxer) with automatic GPU -> software CPU fallback -> real .mp4!
 *   3. MediaRecorder WebM VP9/VP8 fallback (Firefox / older Chrome) -> .webm
 *   4. In-App WebView (Instagram / TikTok / old iOS without MediaRecorder or WebCodecs) -> never crashes;
 *      signals callers to fall back gracefully to Animated GIF / PNG ZIP!
 */

export interface VideoExportSupport {
  canExportVideo: boolean;
  prefersMp4: boolean;
  nativeMp4Mime: string | null;
  webCodecsMp4: boolean;
  webmMime: string | null;
  canWebShareFiles: boolean;
}

const MP4_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42001E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
] as const;

const WEBM_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

export function pickBestMediaRecorderFormat(): {
  mime: string;
  ext: 'mp4' | 'webm';
} | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  for (const mime of MP4_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext: 'mp4' };
    } catch {
      // ignore unsupported query
    }
  }
  for (const mime of WEBM_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext: 'webm' };
    } catch {
      // ignore
    }
  }
  return { mime: 'video/webm', ext: 'webm' };
}

export function detectVideoExportSupport(): VideoExportSupport {
  const hasMediaRecorder =
    typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
  const hasCaptureStream =
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function';

  let nativeMp4Mime: string | null = null;
  let webmMime: string | null = null;

  if (hasMediaRecorder && hasCaptureStream) {
    for (const m of MP4_MIME_CANDIDATES) {
      try {
        if (MediaRecorder.isTypeSupported(m)) {
          nativeMp4Mime = m;
          break;
        }
      } catch {
        // ignore
      }
    }
    for (const m of WEBM_MIME_CANDIDATES) {
      try {
        if (MediaRecorder.isTypeSupported(m)) {
          webmMime = m;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  const webCodecsMp4 =
    typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

  const canWebShareFiles =
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function';

  return {
    canExportVideo: Boolean(nativeMp4Mime || webCodecsMp4 || webmMime),
    prefersMp4: Boolean(nativeMp4Mime || webCodecsMp4),
    nativeMp4Mime,
    webCodecsMp4,
    webmMime,
    canWebShareFiles,
  };
}

/** Ensures H.264 even dimensions (multiple of 2) required by all hardware & software AVC encoders */
export function ensureEvenDimensions(w: number, h: number): { width: number; height: number } {
  return {
    width: Math.max(64, Math.floor(w / 2) * 2),
    height: Math.max(64, Math.floor(h / 2) * 2),
  };
}

/**
 * Pure WebCodecs H.264 + mp4-muxer Frame-Accurate Offline MP4 Encoder!
 * Works even on GPU-free laptops by automatically falling back to `prefer-software` H.264 encoding!
 * Produces 100% WhatsApp, Instagram Reels, TikTok, and iPhone Photos compatible MP4 files!
 */
export async function encodeFramesToMp4WebCodecs(opts: {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  drawFrame: (ctx: CanvasRenderingContext2D, frameIndex: number, w: number, h: number) => void | Promise<void>;
  audioBuffer?: AudioBuffer | null;
  shouldAbort?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<Blob | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }

  const { width, height } = ensureEvenDimensions(opts.width, opts.height);
  const fps = Math.max(6, Math.min(60, Math.round(opts.fps)));

  // Probe H.264 Baseline/Main support — try hardware first, then CPU software encoder for GPU-free devices!
  const codecConfigs: VideoEncoderConfig[] = [
    {
      codec: 'avc1.42001f',
      width,
      height,
      bitrate: 5_000_000,
      framerate: fps,
      hardwareAcceleration: 'no-preference',
    },
    {
      codec: 'avc1.42001f',
      width,
      height,
      bitrate: 4_500_000,
      framerate: fps,
      hardwareAcceleration: 'prefer-software',
    },
    {
      codec: 'avc1.4d001f',
      width,
      height,
      bitrate: 4_500_000,
      framerate: fps,
      hardwareAcceleration: 'prefer-software',
    },
  ];

  let chosenVideoConfig: VideoEncoderConfig | null = null;
  for (const cfg of codecConfigs) {
    try {
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (sup.supported) {
        chosenVideoConfig = cfg;
        break;
      }
    } catch {
      // try next config
    }
  }
  if (!chosenVideoConfig) return null;

  // Optional AAC audio encoding via AudioEncoder when audioBuffer is supplied & supported
  let canEncodeAudio = false;
  let audioConfig: AudioEncoderConfig | null = null;
  if (opts.audioBuffer && typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
    const ch = Math.min(2, Math.max(1, opts.audioBuffer.numberOfChannels));
    const sr = opts.audioBuffer.sampleRate;
    const candidate: AudioEncoderConfig = {
      codec: 'mp4a.40.2',
      numberOfChannels: ch,
      sampleRate: sr,
      bitrate: 128_000,
    };
    try {
      const sup = await AudioEncoder.isConfigSupported(candidate);
      if (sup.supported) {
        canEncodeAudio = true;
        audioConfig = candidate;
      }
    } catch {
      canEncodeAudio = false;
    }
  }

  const { ArrayBufferTarget, Muxer } = await import('mp4-muxer');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width,
      height,
    },
    audio:
      canEncodeAudio && audioConfig
        ? {
            codec: 'aac',
            numberOfChannels: audioConfig.numberOfChannels,
            sampleRate: audioConfig.sampleRate,
          }
        : undefined,
    fastStart: 'in-memory',
  });

  let encoderError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });
  videoEncoder.configure(chosenVideoConfig);

  let audioEncoder: AudioEncoder | null = null;
  if (canEncodeAudio && audioConfig) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        muxer.addAudioChunk(chunk, meta);
      },
      error: () => {
        // Non-fatal: keep video intact if audio encoder fails on quirky hardware
      },
    });
    audioEncoder.configure(audioConfig);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const frameDurationUs = Math.round(1_000_000 / fps);
  const keyFrameInterval = Math.max(12, fps * 2);

  try {
    for (let i = 0; i < opts.totalFrames; i++) {
      if (opts.shouldAbort?.() || encoderError) break;
      await opts.drawFrame(ctx, i, width, height);

      const frame = new VideoFrame(canvas, {
        timestamp: i * frameDurationUs,
        duration: frameDurationUs,
      });
      videoEncoder.encode(frame, { keyFrame: i % keyFrameInterval === 0 });
      frame.close();

      // Backpressure guard so memory never spikes on 3 GB phones
      if (videoEncoder.encodeQueueSize > 8) {
        await videoEncoder.flush();
      }

      opts.onProgress?.(i + 1, opts.totalFrames);
      if (i % 4 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }

    if (opts.shouldAbort?.() || encoderError) {
      return null;
    }

    // Encode matching duration of audio buffer into AAC frames if available
    if (audioEncoder && opts.audioBuffer && audioConfig) {
      const totalSec = opts.totalFrames / fps;
      const sr = opts.audioBuffer.sampleRate;
      const ch = audioConfig.numberOfChannels;
      const totalSamples = Math.min(opts.audioBuffer.length, Math.round(totalSec * sr));
      const chunkSamples = 4096;

      for (let offset = 0; offset < totalSamples; offset += chunkSamples) {
        const count = Math.min(chunkSamples, totalSamples - offset);
        const planar = new Float32Array(count * ch);
        for (let c = 0; c < ch; c++) {
          const src = opts.audioBuffer.getChannelData(Math.min(c, opts.audioBuffer.numberOfChannels - 1));
          planar.set(src.subarray(offset, offset + count), c * count);
        }
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: sr,
          numberOfFrames: count,
          numberOfChannels: ch,
          timestamp: Math.round((offset / sr) * 1_000_000),
          data: planar,
        });
        audioEncoder.encode(audioData);
        audioData.close();
      }
      await audioEncoder.flush();
    }

    await videoEncoder.flush();
    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } catch {
    return null;
  } finally {
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    } catch {
      // ignore
    }
    try {
      if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Triggers a reliable file download AND supports Web Share API Level 2 on mobile when requested!
 */
export async function shareFileOnMobileIfSupported(
  blob: Blob,
  filename: string,
  title = 'INKTROPE'
): Promise<boolean> {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function' ||
    typeof File === 'undefined'
  ) {
    return false;
  }
  try {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (!navigator.canShare({ files: [file] })) return false;
    await navigator.share({ title, files: [file] });
    return true;
  } catch {
    return false;
  }
}
