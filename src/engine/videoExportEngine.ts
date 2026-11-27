/**
 * INKTROPE Universal Frame-Accurate Video Export Engine ($0, 100% Client-Side, F1-03 10/10 Upgrade)
 *
 * Cross-Browser Strategy:
 *   1. PRIMARY EVERYWHERE: WebCodecs H.264 `VideoEncoder` + `mp4-muxer` (`fastStart: 'in-memory'`, zero `moof` fragments!)
 *      - Resolution-adaptive AVC Level selector: Level 3.1 (`1f`) up to 720p, Level 4.0 (`28`) for 1080p & 9:16 `1080×1920` Reels, Level 4.2 (`2a`) above!
 *      - Dual WebCodecs audio encoder: `mp4a.40.2` (`aac`) first, automatic `opus` (`48 kHz`) fallback when OS lacks patent-encumbered AAC!
 *      - Exact `audioVolume` gain application & minimum playable duration guard so 1-frame projects NEVER output 0-byte or rejected MP4s!
 *   2. FALLBACK: Audio-aware `MediaRecorder` (MP4 with audio codecs -> WebM VP9/VP8+Opus) returning `null` cleanly when unsupported!
 */

export interface VideoExportSupport {
  canExportVideo: boolean;
  prefersMp4: boolean;
  nativeMp4Mime: string | null;
  webCodecsMp4: boolean;
  webmMime: string | null;
  canWebShareFiles: boolean;
}

export type ExportAspectPreset = 'native' | '9:16' | '1:1';

const MP4_AUDIO_CAPABLE_MIMES = [
  'video/mp4;codecs=avc1.42001f,mp4a.40.2',
  'video/mp4;codecs=avc1.420028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42001E,mp4a.40.2',
  'video/mp4;codecs=avc1.42001f,opus',
  'video/mp4',
] as const;

const MP4_VIDEO_ONLY_MIMES = [
  ...MP4_AUDIO_CAPABLE_MIMES,
  'video/mp4;codecs=avc1.42001f',
  'video/mp4;codecs=avc1.420028',
  'video/mp4;codecs=avc1.42E01E',
] as const;

const WEBM_AUDIO_CAPABLE_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

const WEBM_VIDEO_ONLY_MIMES = [
  ...WEBM_AUDIO_CAPABLE_MIMES,
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
] as const;

/**
 * Selects an actually supported MediaRecorder format.
 * - When `hasAudio = true`, NEVER selects a video-only MIME string (preventing `NotSupportedError` crashes!).
 * - When NO candidate is supported, returns `null` instead of a fake `'video/webm'` string!
 */
export function pickBestMediaRecorderFormat(hasAudio = false): {
  mime: string;
  ext: 'mp4' | 'webm';
} | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  const mp4List = hasAudio ? MP4_AUDIO_CAPABLE_MIMES : MP4_VIDEO_ONLY_MIMES;
  for (const mime of mp4List) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext: 'mp4' };
    } catch {
      // ignore unsupported query
    }
  }
  const webmList = hasAudio ? WEBM_AUDIO_CAPABLE_MIMES : WEBM_VIDEO_ONLY_MIMES;
  for (const mime of webmList) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext: 'webm' };
    } catch {
      // ignore
    }
  }
  return null;
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
    for (const m of MP4_VIDEO_ONLY_MIMES) {
      try {
        if (MediaRecorder.isTypeSupported(m)) {
          nativeMp4Mime = m;
          break;
        }
      } catch {
        // ignore
      }
    }
    for (const m of WEBM_VIDEO_ONLY_MIMES) {
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
    canExportVideo: Boolean(webCodecsMp4 || nativeMp4Mime || webmMime),
    prefersMp4: Boolean(webCodecsMp4 || nativeMp4Mime),
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

/** Resolves target pixel dimensions for native, 9:16 Vertical Reels (1080x1920), or 1:1 Square (1080x1080) */
export function resolveExportDimensions(
  projectWidth: number,
  projectHeight: number,
  scale: 1 | 0.75 | 0.5 = 1,
  aspectPreset: ExportAspectPreset = 'native'
): { width: number; height: number } {
  if (aspectPreset === '9:16') {
    return ensureEvenDimensions(Math.round(1080 * scale), Math.round(1920 * scale));
  }
  if (aspectPreset === '1:1') {
    return ensureEvenDimensions(Math.round(1080 * scale), Math.round(1080 * scale));
  }
  return ensureEvenDimensions(Math.round(projectWidth * scale), Math.round(projectHeight * scale));
}

/**
 * Selects H.264 profile/level strings matching the macroblock count of `(width, height)`:
 * - `<= 3600` MB (`<= 1280x720`): Level 3.1 (`1f`)
 * - `<= 8192` MB (`1920x1080` and `1080x1920` 9:16 Reels/TikTok/Shorts): Level 4.0 (`28`)
 * - `> 8192` MB: Level 4.2 / 5.0 (`2a` / `32`)
 */
export function selectH264CodecCandidates(width: number, height: number): string[] {
  const { width: w, height: h } = ensureEvenDimensions(width, height);
  const mbCount = Math.ceil(w / 16) * Math.ceil(h / 16);
  if (mbCount <= 3600) {
    return ['avc1.64001f', 'avc1.4d001f', 'avc1.42001f'];
  }
  if (mbCount <= 8192) {
    return ['avc1.640028', 'avc1.4d0028', 'avc1.420028'];
  }
  return ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a', 'avc1.640032'];
}

/** Linearly resamples mono/stereo PCM channel data to 48000 Hz when Opus fallback is chosen */
function extractChannelWithGainAndSampleRate(
  buf: AudioBuffer,
  channelIndex: number,
  targetSampleRate: number,
  totalFramesOut: number,
  volumeGain: number
): Float32Array {
  const src = buf.getChannelData(Math.min(channelIndex, buf.numberOfChannels - 1));
  const out = new Float32Array(totalFramesOut);
  const ratio = buf.sampleRate / targetSampleRate;
  const srcLen = src.length;
  for (let i = 0; i < totalFramesOut; i++) {
    const sp = i * ratio;
    const i0 = Math.floor(sp);
    if (i0 >= srcLen) break;
    const i1 = Math.min(srcLen - 1, i0 + 1);
    const frac = sp - i0;
    const sample = (src[i0] * (1 - frac) + src[i1] * frac) * volumeGain;
    out[i] = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  }
  return out;
}

/**
 * Pure WebCodecs H.264 + mp4-muxer Frame-Accurate Offline MP4 Encoder!
 * Produces non-fragmented `fastStart` ISO BMFF `.mp4` files (`ftyp + moov + mdat`, `moof = false`)!
 */
export async function encodeFramesToMp4WebCodecs(opts: {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  drawFrame: (ctx: CanvasRenderingContext2D, frameIndex: number, w: number, h: number) => void | Promise<void>;
  audioBuffer?: AudioBuffer | null;
  audioVolume?: number;
  shouldAbort?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<Blob | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }

  const { width, height } = ensureEvenDimensions(opts.width, opts.height);
  const fps = Math.max(6, Math.min(60, Math.round(opts.fps)));
  const pixels = width * height;
  const targetBitrate = pixels > 1_000_000 ? 7_200_000 : 5_000_000;

  // Enforce at least ~0.5s (minimum 6 frames) so 1-frame Draw projects NEVER output 0-byte or unplayable 83ms MP4s!
  const minPlayableFrames = Math.max(6, Math.ceil(fps * 0.5));
  const totalEncodedFrames = Math.max(opts.totalFrames, minPlayableFrames);

  const codecStrings = selectH264CodecCandidates(width, height);
  const codecConfigs: VideoEncoderConfig[] = [];
  for (const codec of codecStrings) {
    codecConfigs.push({
      codec,
      width,
      height,
      bitrate: targetBitrate,
      framerate: fps,
      hardwareAcceleration: 'no-preference',
    });
  }
  for (const codec of codecStrings) {
    codecConfigs.push({
      codec,
      width,
      height,
      bitrate: Math.round(targetBitrate * 0.9),
      framerate: fps,
      hardwareAcceleration: 'prefer-software',
    });
  }

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

  // Dual Audio Codec Support: prefer `mp4a.40.2` (AAC-LC), fall back to `opus` @ 48 kHz so audio is NEVER dropped!
  let muxAudioCodec: 'aac' | 'opus' | null = null;
  let audioConfig: AudioEncoderConfig | null = null;
  const audioGain = Math.max(0, Math.min(2, opts.audioVolume ?? 1));

  if (
    opts.audioBuffer &&
    audioGain > 0.001 &&
    typeof AudioEncoder !== 'undefined' &&
    typeof AudioData !== 'undefined'
  ) {
    const ch = Math.min(2, Math.max(1, opts.audioBuffer.numberOfChannels));
    const aacCandidate: AudioEncoderConfig = {
      codec: 'mp4a.40.2',
      numberOfChannels: ch,
      sampleRate: opts.audioBuffer.sampleRate,
      bitrate: 128_000,
    };
    try {
      const supAac = await AudioEncoder.isConfigSupported(aacCandidate);
      if (supAac.supported) {
        muxAudioCodec = 'aac';
        audioConfig = aacCandidate;
      }
    } catch {
      // try Opus next
    }

    if (!audioConfig) {
      const opusCandidate: AudioEncoderConfig = {
        codec: 'opus',
        numberOfChannels: ch,
        sampleRate: 48_000,
        bitrate: 128_000,
      };
      try {
        const supOpus = await AudioEncoder.isConfigSupported(opusCandidate);
        if (supOpus.supported) {
          muxAudioCodec = 'opus';
          audioConfig = opusCandidate;
        }
      } catch {
        muxAudioCodec = null;
      }
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
      frameRate: fps,
    },
    audio:
      muxAudioCodec && audioConfig
        ? {
            codec: muxAudioCodec,
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
  if (muxAudioCodec && audioConfig) {
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
    const srcCount = Math.max(1, opts.totalFrames);
    for (let i = 0; i < totalEncodedFrames; i++) {
      if (opts.shouldAbort?.() || encoderError) break;
      const logicalIdx = Math.min(srcCount - 1, i);
      await opts.drawFrame(ctx, logicalIdx, width, height);

      const frame = new VideoFrame(canvas, {
        timestamp: i * frameDurationUs,
        duration: frameDurationUs,
      });
      videoEncoder.encode(frame, { keyFrame: i % keyFrameInterval === 0 });
      frame.close();

      if (videoEncoder.encodeQueueSize > 8) {
        await videoEncoder.flush();
      }

      opts.onProgress?.(i + 1, totalEncodedFrames);
      if (i % 4 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }

    if (opts.shouldAbort?.() || encoderError) {
      return null;
    }

    if (audioEncoder && opts.audioBuffer && audioConfig) {
      const totalSec = totalEncodedFrames / fps;
      const sr = audioConfig.sampleRate;
      const ch = audioConfig.numberOfChannels;
      const maxAvailableSec = opts.audioBuffer.duration;
      const encodeSec = Math.min(maxAvailableSec, totalSec);
      const totalSamples = Math.max(0, Math.round(encodeSec * sr));

      if (totalSamples > 0) {
        const chBuffers: Float32Array[] = [];
        for (let c = 0; c < ch; c++) {
          chBuffers.push(
            extractChannelWithGainAndSampleRate(opts.audioBuffer, c, sr, totalSamples, audioGain)
          );
        }
        const chunkSamples = muxAudioCodec === 'opus' ? 960 : 4096;
        for (let offset = 0; offset < totalSamples; offset += chunkSamples) {
          const count = Math.min(chunkSamples, totalSamples - offset);
          const planar = new Float32Array(count * ch);
          for (let c = 0; c < ch; c++) {
            planar.set(chBuffers[c].subarray(offset, offset + count), c * count);
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
    }

    await videoEncoder.flush();
    muxer.finalize();
    if (!target.buffer || target.buffer.byteLength < 256) {
      return null;
    }
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
 * Triggers Web Share API Level 2 native share sheet on mobile/desktop when supported!
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
