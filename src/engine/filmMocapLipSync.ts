import type {
  MotionCaptureSample,
  MotionCaptureTrack,
  VisemeId,
  VoiceLipSyncFrame,
  VoiceLipSyncTrack,
} from '../types/film';

// ============================================================================
// 1. REAL VOICE FORMANT & PRESTON BLAIR 6-VISEME LIP-SYNC ENGINE
// ============================================================================

export const VISEME_LABELS: Record<VisemeId, string> = {
  closed: 'M / Sessiz',
  AA: 'A (Açık)',
  EE: 'E / İ (Geniş)',
  OH: 'O / Ö (Yuvarlak)',
  OO: 'U / Ü (Büzük)',
  FV: 'F / V / S (Diş)',
};

/**
 * Classifies one acoustic audio frame into a classic 2D cinema Preston Blair viseme
 * using normalized RMS loudness, 3 formant frequency bands (F1 Low, F2 Mid, F3 High),
 * and Zero-Crossing Rate (ZCR for sibilants & fricatives).
 */
export function classifyVisemeFromBands(
  rms: number,
  lowE: number,
  midE: number,
  highE: number,
  zcr: number
): VisemeId {
  if (rms < 0.028) return 'closed';
  const sum = lowE + midE + highE + 1e-6;
  const lowR = lowE / sum;
  const midR = midE / sum;
  const highR = highE / sum;

  // Fricatives & sibilants (F, V, S, Z, Ş, Ç): high-frequency & high zero-crossing rate
  if (zcr > 0.23 || (highR > 0.42 && highE > lowE * 0.85)) {
    return 'FV';
  }
  // Closed rounded back vowels (U / Ü / O / Ö): strong F1 low resonance, muted high F3
  if (lowR > 0.56 && highR < 0.16) {
    return rms > 0.24 ? 'OH' : 'OO';
  }
  // Front spread vowels (E / İ / I): elevated mid-high F2/F3 balance
  if (highR > 0.22 && midR + highR > lowR * 1.15) {
    return 'EE';
  }
  // Broad open vowels (A / Â) and resonant speech peaks
  if (midR >= 0.3 || rms > 0.16) {
    return 'AA';
  }
  return 'OH';
}

/** Fast single-frequency Goertzel power detector (O(N), zero FFT allocation) */
function goertzelMagnitude(
  pcm: Float32Array,
  start: number,
  len: number,
  sampleRate: number,
  targetHz: number
): number {
  if (len <= 4 || targetHz >= sampleRate * 0.48) return 0;
  const omega = (2 * Math.PI * targetHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(pcm.length, start + len);
  for (let i = start; i < end; i++) {
    s0 = pcm[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / len;
}

/**
 * Pure DSP Audio Analyzer: converts mono PCM float samples into a frame-accurate
 * 24 Hz Preston Blair 6-Viseme VoiceLipSyncTrack + 48-bar timeline waveform!
 * Deterministic & runs identically in both Browser and Node/Vitest.
 */
export function analyzePCMToLipSyncTrack(
  pcm: Float32Array,
  sampleRate: number,
  meta: {
    audioBlobKey: string;
    label: string;
    source: 'mic' | 'file';
    fps?: number;
  }
): VoiceLipSyncTrack {
  const fps = meta.fps ?? 24;
  const safeRate = Math.max(8000, sampleRate);
  const durationSec = Math.max(0.2, pcm.length / safeRate);
  const frameCount = Math.max(4, Math.ceil(durationSec * fps));
  const winLen = Math.max(128, Math.floor(safeRate / fps));

  // Measure global peak to auto-normalize quiet microphones cleanly
  let globalPeak = 0.001;
  for (let i = 0; i < pcm.length; i += 4) {
    const a = Math.abs(pcm[i]);
    if (a > globalPeak) globalPeak = a;
  }
  const normGain = Math.min(8, 0.85 / globalPeak);

  const frames: VoiceLipSyncFrame[] = [];
  let prevViseme: VisemeId = 'closed';

  for (let f = 0; f < frameCount; f++) {
    const start = Math.floor((f / fps) * safeRate);
    const end = Math.min(pcm.length, start + winLen);
    const len = Math.max(1, end - start);

    let sumSq = 0;
    let zc = 0;
    let prevSample = pcm[start] ?? 0;
    for (let i = start; i < end; i++) {
      const v = pcm[i] * normGain;
      sumSq += v * v;
      if ((v >= 0 && prevSample < 0) || (v < 0 && prevSample >= 0)) zc++;
      prevSample = v;
    }
    const rms = Math.min(1, Math.sqrt(sumSq / len) * 1.65);
    const zcr = zc / len;

    // Vocal formant resonance energies: F1 (Low), F2 (Mid), F3/Sibilance (High)
    const lowE =
      (goertzelMagnitude(pcm, start, len, safeRate, 260) +
        goertzelMagnitude(pcm, start, len, safeRate, 440)) *
      0.5 *
      normGain;
    const midE =
      (goertzelMagnitude(pcm, start, len, safeRate, 840) +
        goertzelMagnitude(pcm, start, len, safeRate, 1360)) *
      0.5 *
      normGain;
    const highE =
      (goertzelMagnitude(pcm, start, len, safeRate, 2450) +
        goertzelMagnitude(pcm, start, len, safeRate, 3850)) *
      0.5 *
      normGain;

    let viseme = classifyVisemeFromBands(rms, lowE, midE, highE, zcr);
    // Gentle 1-frame hold prevents rapid artificial flickering during tiny dips
    if (viseme === 'closed' && rms > 0.018 && prevViseme !== 'closed') {
      viseme = prevViseme;
    }
    prevViseme = viseme;

    frames.push({
      t: Number((f / fps).toFixed(3)),
      energy: Number(Math.min(1, rms * 1.25).toFixed(3)),
      viseme,
    });
  }

  // Build compact 48-bar waveform preview
  const bars = 48;
  const waveform: number[] = [];
  const step = Math.max(1, Math.floor(pcm.length / bars));
  for (let b = 0; b < bars; b++) {
    const s = b * step;
    const e = Math.min(pcm.length, s + step);
    let peak = 0;
    for (let i = s; i < e; i += Math.max(1, Math.floor(step / 64))) {
      const a = Math.abs(pcm[i]) * normGain;
      if (a > peak) peak = a;
    }
    waveform.push(Number(Math.min(1, peak).toFixed(2)));
  }

  return {
    audioBlobKey: meta.audioBlobKey,
    durationSec: Number(durationSec.toFixed(2)),
    sampleRateHz: fps,
    frames,
    waveform,
    source: meta.source,
    label: meta.label,
  };
}

/** Browser helper: decodes ANY uploaded or mic-recorded audio Blob into a VoiceLipSyncTrack */
export async function analyzeAudioBlobToLipSyncTrack(
  blob: Blob,
  audioBlobKey: string,
  label: string,
  source: 'mic' | 'file'
): Promise<VoiceLipSyncTrack> {
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new Error('Web Audio API desteklenmiyor');
  const ctx = new AC();
  try {
    const arr = await blob.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arr.slice(0));
    const ch0 = audioBuf.getChannelData(0);
    // Mix stereo down to mono if needed
    let mono = ch0;
    if (audioBuf.numberOfChannels > 1) {
      const ch1 = audioBuf.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        mono[i] = (ch0[i] + ch1[i]) * 0.5;
      }
    }
    return analyzePCMToLipSyncTrack(mono, audioBuf.sampleRate, {
      audioBlobKey,
      label,
      source,
      fps: 24,
    });
  } finally {
    void ctx.close().catch(() => {});
  }
}

/** Real-time AnalyserNode viseme classifier for live microphone monitoring (60 FPS) */
export function classifyLiveAnalyserViseme(
  freqBins: Uint8Array,
  timeDomain: Uint8Array,
  sampleRate: number
): { energy: number; viseme: VisemeId } {
  let sumSq = 0;
  let zc = 0;
  let prev = (timeDomain[0] - 128) / 128;
  for (let i = 0; i < timeDomain.length; i++) {
    const v = (timeDomain[i] - 128) / 128;
    sumSq += v * v;
    if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) zc++;
    prev = v;
  }
  const rms = Math.min(1, Math.sqrt(sumSq / Math.max(1, timeDomain.length)) * 3.1);
  const zcr = zc / Math.max(1, timeDomain.length);

  const nyquist = sampleRate * 0.5;
  const binHz = nyquist / Math.max(1, freqBins.length);
  const avgBand = (minHz: number, maxHz: number) => {
    const a = Math.max(0, Math.floor(minHz / binHz));
    const b = Math.min(freqBins.length - 1, Math.ceil(maxHz / binHz));
    let sum = 0;
    for (let i = a; i <= b; i++) sum += freqBins[i] / 255;
    return sum / Math.max(1, b - a + 1);
  };

  const lowE = avgBand(120, 560);
  const midE = avgBand(560, 1850);
  const highE = avgBand(1850, 5200);
  const viseme = classifyVisemeFromBands(rms, lowE, midE, highE, zcr);
  return { energy: Math.min(1, rms * 1.2), viseme };
}

/** Samples a saved VoiceLipSyncTrack at an exact shot timestamp */
export function sampleVoiceLipSync(
  track: VoiceLipSyncTrack,
  localSec: number
): { mouthOpen: number; viseme: VisemeId } {
  if (!track.frames.length || localSec < 0 || localSec > track.durationSec + 0.08) {
    return { mouthOpen: 0, viseme: 'closed' };
  }
  const idx = Math.max(
    0,
    Math.min(track.frames.length - 1, Math.floor(localSec * track.sampleRateHz))
  );
  const fr = track.frames[idx];
  return {
    mouthOpen: fr.viseme === 'closed' ? 0 : Math.max(0.18, Math.min(1, fr.energy)),
    viseme: fr.viseme,
  };
}

/** Upgraded Turkish & English text-to-Preston-Blair-Viseme mapper (used when no voice audio is recorded) */
export function textDialogueToViseme(
  dialogue: string,
  tNorm: number
): { mouthOpen: number; viseme: VisemeId } {
  const chars = dialogue.trim();
  if (!chars || tNorm <= 0.08 || tNorm >= 0.94) {
    return { mouthOpen: 0, viseme: 'closed' };
  }
  const idx = Math.floor(((tNorm - 0.08) / 0.86) * chars.length * 1.35) % chars.length;
  const ch = chars[idx].toLowerCase();

  if (' .,!?;:-…'.includes(ch)) return { mouthOpen: 0, viseme: 'closed' };
  if ('mbp'.includes(ch)) return { mouthOpen: 0.06, viseme: 'closed' };
  if ('aâ'.includes(ch)) return { mouthOpen: 0.92, viseme: 'AA' };
  if ('eiıî'.includes(ch)) return { mouthOpen: 0.68, viseme: 'EE' };
  if ('oö'.includes(ch)) return { mouthOpen: 0.82, viseme: 'OH' };
  if ('uü'.includes(ch)) return { mouthOpen: 0.62, viseme: 'OO' };
  if ('fvszşçjh'.includes(ch)) return { mouthOpen: 0.42, viseme: 'FV' };
  return { mouthOpen: 0.48, viseme: 'AA' };
}

// ============================================================================
// 2. WEBCAM & REFERENCE VIDEO 2.5D POSE TRANSFER CV ENGINE (100% OFFLINE!)
// ============================================================================

export interface PoseCalibrationBaseline {
  headCx: number; // normalized 0..1
  headCy: number; // normalized 0..1
  headTopY: number; // normalized 0..1
  torsoCx: number; // normalized 0..1
  leftWingY: number; // normalized 0..1
  rightWingY: number; // normalized 0..1
  /** Optional captured neutral background RGB buffer (w * h * 3) */
  bgRgb?: Uint8Array | null;
  width: number;
  height: number;
}

/** Universal YCbCr skin-tone likelihood (0..1) — lighting tolerant & fast */
function skinLikelihood(r: number, g: number, b: number): number {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const inSkin = cb >= 76 && cb <= 129 && cr >= 131 && cr <= 176 && r > 55 && r > g * 0.95;
  if (!inSkin) return 0;
  const dCb = Math.abs(cb - 102) / 28;
  const dCr = Math.abs(cr - 152) / 24;
  return Math.max(0, 1 - (dCb + dCr) * 0.45);
}

/** Measures raw upper-body feature geometry from a small RGBA analysis frame (e.g. 96x72) */
export function measureFramePoseFeatures(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  bgRgb?: Uint8Array | null,
  prevRgba?: Uint8ClampedArray | null
): {
  headCx: number;
  headCy: number;
  headTopY: number;
  headTiltRaw: number;
  torsoCx: number;
  leftWingY: number;
  leftWingEnergy: number;
  rightWingY: number;
  rightWingEnergy: number;
} {
  let headW = 0,
    headSx = 0,
    headSy = 0,
    headSxx = 0,
    headSyy = 0,
    headSxy = 0;
  let headTopY = 0.42;

  let torsoW = 0,
    torsoSx = 0;

  let leftW = 0,
    leftSy = 0;
  let rightW = 0,
    rightSy = 0;

  const hasBg = bgRgb && bgRgb.length === w * h * 3;
  const hasPrev = prevRgba && prevRgba.length === w * h * 4;

  for (let y = 0; y < h; y++) {
    const ny = y / Math.max(1, h - 1);
    for (let x = 0; x < w; x++) {
      const nx = x / Math.max(1, w - 1);
      const idx4 = (y * w + x) * 4;
      const r = rgba[idx4];
      const g = rgba[idx4 + 1];
      const b = rgba[idx4 + 2];

      let weight = 0;
      if (hasBg && bgRgb) {
        const idx3 = (y * w + x) * 3;
        const diff =
          (Math.abs(r - bgRgb[idx3]) + Math.abs(g - bgRgb[idx3 + 1]) + Math.abs(b - bgRgb[idx3 + 2])) /
          765;
        if (diff > 0.1) weight += Math.min(1, (diff - 0.08) * 3.4);
      }

      const skin = skinLikelihood(r, g, b);
      weight += skin * 0.95;

      if (hasPrev && prevRgba) {
        const md =
          (Math.abs(r - prevRgba[idx4]) +
            Math.abs(g - prevRgba[idx4 + 1]) +
            Math.abs(b - prevRgba[idx4 + 2])) /
          765;
        if (md > 0.08) weight += Math.min(1, md * 3.5);
      }

      // Fallback silhouette weight when neither bg nor motion is present (still frames / synthetic images)
      if (!hasBg && weight < 0.15) {
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        // Foreground subjects are usually non-white or saturated relative to bright studio backdrop
        const fg = Math.max(0, 1 - lum) * 0.65 + sat * 0.65;
        if (fg > 0.25) weight += fg * 0.55;
      }

      if (weight < 0.16) continue;

      // 1. Head / Upper-Center Zone (nx in 0.24..0.76, ny in 0.04..0.52)
      if (nx >= 0.24 && nx <= 0.76 && ny >= 0.04 && ny <= 0.52) {
        headW += weight;
        headSx += nx * weight;
        headSy += ny * weight;
        headSxx += nx * nx * weight;
        headSyy += ny * ny * weight;
        headSxy += nx * ny * weight;
        if (weight > 0.45 && ny < headTopY) headTopY = ny;
      }

      // 2. Torso Zone (nx in 0.22..0.78, ny in 0.48..0.94)
      if (nx >= 0.22 && nx <= 0.78 && ny >= 0.48 && ny <= 0.94) {
        torsoW += weight;
        torsoSx += nx * weight;
      }

      // 3. Left Wing Arm Zone (nx < 0.34, ny in 0.1..0.88)
      if (nx < 0.34 && ny >= 0.1 && ny <= 0.88) {
        leftW += weight;
        leftSy += ny * weight;
      }

      // 4. Right Wing Arm Zone (nx > 0.66, ny in 0.1..0.88)
      if (nx > 0.66 && ny >= 0.1 && ny <= 0.88) {
        rightW += weight;
        rightSy += ny * weight;
      }
    }
  }

  const headCx = headW > 1 ? headSx / headW : 0.5;
  const headCy = headW > 1 ? headSy / headW : 0.28;
  let headTiltRaw = 0;
  if (headW > 4) {
    const vx = headSxx / headW - headCx * headCx;
    const vy = headSyy / headW - headCy * headCy;
    const vxy = headSxy / headW - headCx * headCy;
    // Principal vertical axis deviation (0 when upright!)
    headTiltRaw = Math.max(-0.42, Math.min(0.42, Math.atan2(2 * vxy, vy - vx) * 0.5));
  }

  const torsoCx = torsoW > 1 ? torsoSx / torsoW : 0.5;
  const wingNorm = Math.max(1, w * h * 0.055);
  const leftWingEnergy = Math.min(1, leftW / wingNorm);
  const rightWingEnergy = Math.min(1, rightW / wingNorm);
  const leftWingY = leftW > 0.5 ? leftSy / leftW : 0.68;
  const rightWingY = rightW > 0.5 ? rightSy / rightW : 0.68;

  return {
    headCx,
    headCy,
    headTopY,
    headTiltRaw,
    torsoCx,
    leftWingY,
    leftWingEnergy,
    rightWingY,
    rightWingEnergy,
  };
}

/** Captures a clean neutral calibration baseline from the current camera or frame 0 */
export function calibratePoseBaseline(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  captureBackground = false
): PoseCalibrationBaseline {
  const f = measureFramePoseFeatures(rgba, w, h, null, null);
  let bgRgb: Uint8Array | null = null;
  if (captureBackground) {
    bgRgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      bgRgb[j] = rgba[i];
      bgRgb[j + 1] = rgba[i + 1];
      bgRgb[j + 2] = rgba[i + 2];
    }
  }
  return {
    headCx: f.headCx,
    headCy: f.headCy,
    headTopY: f.headTopY,
    torsoCx: f.torsoCx,
    leftWingY: f.leftWingY,
    rightWingY: f.rightWingY,
    bgRgb,
    width: w,
    height: h,
  };
}

/**
 * Extracts a clamped, ARAP-safe 2.5D MotionCaptureSample from any webcam or video RGBA frame!
 * Mirrors horizontally by default for natural webcam mirror feel (`mirrored = true`).
 */
export function extractPoseSampleFromFrameRGBA(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  tSec: number,
  baseline: PoseCalibrationBaseline | null,
  prevRgba?: Uint8ClampedArray | null,
  mirrored = true
): MotionCaptureSample {
  const f = measureFramePoseFeatures(rgba, w, h, baseline?.bgRgb ?? null, prevRgba ?? null);
  const base = baseline ?? {
    headCx: 0.5,
    headCy: 0.28,
    headTopY: 0.14,
    torsoCx: 0.5,
    leftWingY: 0.68,
    rightWingY: 0.68,
    width: w,
    height: h,
  };

  const mirrorSign = mirrored ? -1 : 1;
  const dxHead = (f.headCx - base.headCx) * mirrorSign;
  const dxTorso = (f.torsoCx - base.torsoCx) * mirrorSign;
  const dyLift = base.headCy - f.headCy; // positive when rising/jumping!

  const headYawRad = Math.max(-0.61, Math.min(0.61, dxHead * 3.8));
  const headTiltRad = Math.max(-0.36, Math.min(0.36, (f.headTiltRaw * mirrorSign) + dxHead * 0.55));
  const bodyLeanRad = Math.max(-0.3, Math.min(0.3, dxTorso * 2.1));

  // Left & Right arm elevation mapped cleanly onto character's articulated arms
  const rawLeft =
    f.leftWingEnergy > 0.12
      ? Math.max(-0.65, Math.min(1.1, (0.64 - f.leftWingY) * 2.6 * Math.min(1, f.leftWingEnergy * 1.4)))
      : 0;
  const rawRight =
    f.rightWingEnergy > 0.12
      ? Math.max(-0.65, Math.min(1.1, (0.64 - f.rightWingY) * 2.6 * Math.min(1, f.rightWingEnergy * 1.4)))
      : 0;

  const leftArmSwing = mirrored ? rawRight : rawLeft;
  const rightArmSwing = mirrored ? rawLeft : rawRight;

  const verticalLiftNorm = Math.max(0, Math.min(0.32, (dyLift - 0.025) * 2.4));
  const squashY = Math.max(
    0.84,
    Math.min(1.16, 1 + (dyLift > 0.025 ? dyLift * 0.75 : dyLift * 0.95))
  );

  return {
    t: Number(tSec.toFixed(3)),
    headYawRad: Number(headYawRad.toFixed(4)),
    headTiltRad: Number(headTiltRad.toFixed(4)),
    bodyLeanRad: Number(bodyLeanRad.toFixed(4)),
    leftArmSwing: Number(leftArmSwing.toFixed(3)),
    rightArmSwing: Number(rightArmSwing.toFixed(3)),
    verticalLiftNorm: Number(verticalLiftNorm.toFixed(3)),
    squashY: Number(squashY.toFixed(3)),
  };
}

/** Smooth exponential low-pass filter removing webcam/video jitter */
export function smoothMocapSample(
  prev: MotionCaptureSample | null,
  next: MotionCaptureSample,
  alpha = 0.34
): MotionCaptureSample {
  if (!prev) return next;
  const lerp = (a: number, b: number) => a + (b - a) * alpha;
  return {
    t: next.t,
    headYawRad: Number(lerp(prev.headYawRad, next.headYawRad).toFixed(4)),
    headTiltRad: Number(lerp(prev.headTiltRad, next.headTiltRad).toFixed(4)),
    bodyLeanRad: Number(lerp(prev.bodyLeanRad, next.bodyLeanRad).toFixed(4)),
    leftArmSwing: Number(lerp(prev.leftArmSwing, next.leftArmSwing).toFixed(3)),
    rightArmSwing: Number(lerp(prev.rightArmSwing, next.rightArmSwing).toFixed(3)),
    verticalLiftNorm: Number(lerp(prev.verticalLiftNorm, next.verticalLiftNorm).toFixed(3)),
    squashY: Number(lerp(prev.squashY, next.squashY).toFixed(3)),
    mouthOpen:
      next.mouthOpen !== undefined
        ? Number(lerp(prev.mouthOpen ?? 0, next.mouthOpen).toFixed(3))
        : prev.mouthOpen,
    viseme: next.viseme ?? prev.viseme,
  };
}

/** Smoothly interpolates a saved MotionCaptureTrack at any shot timestamp */
export function sampleMotionCaptureTrack(
  track: MotionCaptureTrack,
  localSec: number
): MotionCaptureSample {
  const arr = track.samples;
  if (arr.length === 0) {
    return {
      t: localSec,
      headYawRad: 0,
      headTiltRad: 0,
      bodyLeanRad: 0,
      leftArmSwing: 0,
      rightArmSwing: 0,
      verticalLiftNorm: 0,
      squashY: 1,
    };
  }
  if (arr.length === 1 || localSec <= arr[0].t) return arr[0];
  const last = arr[arr.length - 1];
  if (localSec >= last.t) return last;

  // Binary search bracket
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= localSec) lo = mid;
    else hi = mid;
  }
  const a = arr[lo];
  const b = arr[hi];
  const span = Math.max(1e-4, b.t - a.t);
  const u = Math.max(0, Math.min(1, (localSec - a.t) / span));
  const lerp = (x: number, y: number) => x + (y - x) * u;

  return {
    t: localSec,
    headYawRad: lerp(a.headYawRad, b.headYawRad),
    headTiltRad: lerp(a.headTiltRad, b.headTiltRad),
    bodyLeanRad: lerp(a.bodyLeanRad, b.bodyLeanRad),
    leftArmSwing: lerp(a.leftArmSwing, b.leftArmSwing),
    rightArmSwing: lerp(a.rightArmSwing, b.rightArmSwing),
    verticalLiftNorm: lerp(a.verticalLiftNorm, b.verticalLiftNorm),
    squashY: lerp(a.squashY, b.squashY),
    mouthOpen: a.mouthOpen !== undefined && b.mouthOpen !== undefined ? lerp(a.mouthOpen, b.mouthOpen) : a.mouthOpen,
    viseme: u < 0.5 ? a.viseme : b.viseme,
  };
}

/**
 * Extracts a full 2.5D MotionCaptureTrack directly from a user-uploaded reference acting video
 * (.mp4 / .webm / .mov) completely offline inside the browser!
 */
export async function extractMocapTrackFromVideoFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<MotionCaptureTrack> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Referans video okunamadı'));
    });

    const dur = Math.max(0.8, Math.min(6.5, video.duration || 3.0));
    const fps = 12;
    const totalFrames = Math.max(6, Math.round(dur * fps));
    const W = 96;
    const H = 72;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    let baseline: PoseCalibrationBaseline | null = null;
    let prevRgba: Uint8ClampedArray | null = null;
    let prevSmooth: MotionCaptureSample | null = null;
    const samples: MotionCaptureSample[] = [];

    for (let i = 0; i < totalFrames; i++) {
      const targetT = Math.min(dur - 0.02, i / fps);
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = targetT;
      });

      ctx.drawImage(video, 0, 0, W, H);
      const rgba = ctx.getImageData(0, 0, W, H).data;
      if (!baseline) {
        baseline = calibratePoseBaseline(rgba, W, H, false);
      }
      const raw = extractPoseSampleFromFrameRGBA(rgba, W, H, targetT, baseline, prevRgba, false);
      const smoothed = smoothMocapSample(prevSmooth, raw, 0.38);
      samples.push(smoothed);
      prevSmooth = smoothed;
      prevRgba = new Uint8ClampedArray(rgba);
      onProgress?.(Math.round(((i + 1) / totalFrames) * 100));
    }

    return {
      source: 'video',
      durationSec: Number(dur.toFixed(2)),
      fps,
      samples,
      createdAt: new Date().toISOString(),
      label: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Referans Video',
    };
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
}

/**
 * $0 Pure In-Browser Expressive Cartoon Formant Voice Synthesizer!
 * Converts any Turkish/English dialogue line into a charming playable 16-bit PCM WAV Blob
 * AND returns the exact Float32 PCM buffer for instant 6-viseme lip-sync analysis (0 ms network!).
 */
export function synthesizeCartoonDialogueWav(
  text: string,
  emotion: string,
  voiceId: string
): { blob: Blob; pcm: Float32Array; sampleRate: number; durationSec: number } {
  const sampleRate = 16000;
  const clean = text.trim() || 'Merhaba!';

  const basePitch =
    voiceId === 'Kore'
      ? 305
      : voiceId === 'Charon'
        ? 138
        : voiceId === 'Aoede'
          ? 198
          : 248; // Puck / Young Hero

  const emotionPitchMul =
    emotion === 'happy' || emotion === 'surprised'
      ? 1.14
      : emotion === 'tired'
        ? 0.86
        : emotion === 'angry' || emotion === 'determined'
          ? 0.94
          : 1.0;

  // Tokenize characters into expressive syllable beats (vowels get resonant formants, spaces get breath pauses)
  const chars = Array.from(clean.toLowerCase());
  const events: { dur: number; vowel: 'a' | 'e' | 'o' | 'u' | 'f' | 'rest'; accent: number }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      events.push({ dur: 0.085, vowel: 'rest', accent: 0 });
    } else if (/[.,!?…]/.test(ch)) {
      events.push({ dur: ch === '!' || ch === '?' ? 0.16 : 0.14, vowel: 'rest', accent: 0 });
    } else if (/[aâ]/.test(ch)) {
      events.push({ dur: 0.115, vowel: 'a', accent: 1 });
    } else if (/[eéiıİ]/.test(ch)) {
      events.push({ dur: 0.105, vowel: 'e', accent: 0.92 });
    } else if (/[oö]/.test(ch)) {
      events.push({ dur: 0.115, vowel: 'o', accent: 0.95 });
    } else if (/[uü]/.test(ch)) {
      events.push({ dur: 0.11, vowel: 'u', accent: 0.9 });
    } else if (/[fvszşçh]/.test(ch)) {
      events.push({ dur: 0.055, vowel: 'f', accent: 0.55 });
    } else if (/[a-zğüşıöç]/i.test(ch)) {
      events.push({ dur: 0.045, vowel: 'e', accent: 0.4 });
    }
  }
  if (events.length === 0) {
    events.push({ dur: 0.4, vowel: 'a', accent: 0.9 });
  }

  const rawDur = events.reduce((s, e) => s + e.dur, 0) + 0.18;
  const maxDur = 5.4;
  const timeScale = rawDur > maxDur ? maxDur / rawDur : 1;
  const totalSec = Math.max(0.7, Math.min(maxDur, rawDur * timeScale));
  const totalSamples = Math.floor(totalSec * sampleRate);
  const pcm = new Float32Array(totalSamples);

  const formants: Record<'a' | 'e' | 'o' | 'u', [number, number]> = {
    a: [780, 1280],
    e: [460, 2150],
    o: [440, 880],
    u: [330, 740],
  };

  let cursor = Math.floor(0.06 * sampleRate);
  let phase0 = 0;
  let phase1 = 0;
  let phase2 = 0;

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    const segSamples = Math.max(1, Math.floor(ev.dur * timeScale * sampleRate));
    const progress = ei / Math.max(1, events.length - 1);
    const isQuestion = clean.endsWith('?');
    const isExclaim = clean.endsWith('!');

    // Expressive sentence melody arc
    const sentenceContour = isQuestion
      ? 0.95 + progress * 0.28
      : isExclaim
        ? 1.06 + Math.sin(progress * Math.PI) * 0.18
        : 1.04 - progress * 0.14 + Math.sin(progress * Math.PI * 2) * 0.06;

    for (let i = 0; i < segSamples && cursor < totalSamples; i++, cursor++) {
      if (ev.vowel === 'rest') continue;
      const u = i / segSamples;
      const env = Math.sin(Math.PI * Math.min(1, u)) ** 0.7;

      if (ev.vowel === 'f') {
        // Gentle fricative consonant puff
        const noise = Math.sin(cursor * 12.9898) * 43758.5453;
        const white = (noise - Math.floor(noise)) * 2 - 1;
        pcm[cursor] = white * 0.16 * env * ev.accent;
        continue;
      }

      const [f1, f2] = formants[ev.vowel];
      const vibrato = 1 + Math.sin((cursor / sampleRate) * 2 * Math.PI * 5.6) * 0.014;
      const f0 = basePitch * emotionPitchMul * sentenceContour * vibrato;
      phase0 += (2 * Math.PI * f0) / sampleRate;
      phase1 += (2 * Math.PI * f1) / sampleRate;
      phase2 += (2 * Math.PI * f2) / sampleRate;

      // Warm glottal fundamental + 2 shaped vowel formant resonances
      const sig =
        Math.sin(phase0) * 0.42 +
        Math.sin(phase0 * 2) * 0.16 +
        Math.sin(phase1) * 0.28 +
        Math.sin(phase2) * 0.14;

      pcm[cursor] = Math.max(-0.92, Math.min(0.92, sig * 0.58 * env * ev.accent));
    }
  }

  // Encode 16-bit mono PCM WAV binary header + samples
  const dataBytes = totalSamples * 2;
  const wavBuf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wavBuf);
  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < totalSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return {
    blob: new Blob([wavBuf], { type: 'audio/wav' }),
    pcm,
    sampleRate,
    durationSec: Number(totalSec.toFixed(2)),
  };
}
