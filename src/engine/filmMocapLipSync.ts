import type {
  MotionCaptureSample,
  MotionCaptureTrack,
  VisemeId,
  VoiceLipSyncFrame,
  VoiceLipSyncTrack,
} from '../types/film';

// ============================================================================
// 0. SILENCE DETECTION & WAV ENCODE/DECODE HELPERS (100% DETERMINISTIC)
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
 * Protects existing voice tracks from being overwritten by muted/virtual/silent microphones!
 * Returns true if peak < 0.015 or RMS < 0.003.
 */
export function isAudioBufferSilent(pcm: Float32Array): boolean {
  if (!pcm || pcm.length === 0) return true;
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]);
    if (v > peak) peak = v;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / pcm.length);
  return peak < 0.015 || rms < 0.003;
}

/** Encodes mono Float32 PCM (-1..+1) into a standard 16-bit RIFF/WAVE Blob */
export function encodeMonoPcmToWavBlob(pcm: Float32Array, sampleRate: number): Blob {
  const sr = Math.max(8000, Math.round(sampleRate));
  const totalSamples = pcm.length;
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
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < totalSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([wavBuf], { type: 'audio/wav' });
}

/** Lightweight RIFF/WAVE PCM decoder for headless/Node & fast offline mixing */
export function decodeWavArrayBufferToMonoPcm(
  buf: ArrayBuffer
): { pcm: Float32Array; sampleRate: number } | null {
  if (buf.byteLength < 44) return null;
  const view = new DataView(buf);
  const riff =
    String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave =
    String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 24000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const sz = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 24 <= buf.byteLength) {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = Math.max(1, view.getUint16(offset + 10, true));
      sampleRate = Math.max(8000, view.getUint32(offset + 12, true));
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(sz, buf.byteLength - dataOffset);
      break;
    }
    offset += 8 + sz + (sz % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) return null;
  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const frameStride = bytesPerSample * numChannels;
  const frameCount = Math.floor(dataSize / frameStride);
  const pcm = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      const p = dataOffset + i * frameStride + c * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        sum += view.getFloat32(p, true);
      } else if (bitsPerSample === 16) {
        sum += view.getInt16(p, true) / 32768;
      } else if (bitsPerSample === 8) {
        sum += (view.getUint8(p) - 128) / 128;
      }
    }
    pcm[i] = sum / numChannels;
  }
  return { pcm, sampleRate };
}

/** Browser + WAV fallback audio Blob decoder returning mono Float32 PCM */
export async function decodeAudioBlobToMonoPCM(
  blob: Blob
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const arr = await blob.arrayBuffer();
  const wavFast = decodeWavArrayBufferToMonoPcm(arr);
  if (wavFast) return wavFast;

  const AC =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!AC) throw new Error('Web Audio API desteklenmiyor');
  const ctx = new AC();
  try {
    const audioBuf = await ctx.decodeAudioData(arr.slice(0));
    const ch0 = audioBuf.getChannelData(0);
    let mono = ch0;
    if (audioBuf.numberOfChannels > 1) {
      const ch1 = audioBuf.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        mono[i] = (ch0[i] + ch1[i]) * 0.5;
      }
    } else {
      mono = new Float32Array(ch0);
    }
    return { pcm: mono, sampleRate: audioBuf.sampleRate };
  } finally {
    void ctx.close().catch(() => {});
  }
}

// ============================================================================
// 1. 25ms HANN + PRE-EMPHASIZED 10-ORDER LEVINSON-DURBIN LPC + 18-BARK LIP-SYNC
// ============================================================================

/** Zwicker 18-band Bark center frequencies (Hz) covering human speech 100..5200 Hz */
const BARK_18_CENTERS_HZ = [
  150, 250, 350, 450, 570, 700, 840, 1000, 1170, 1370, 1600, 1850, 2150, 2500, 2900, 3400, 4000,
  4800,
] as const;

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

  if (zcr > 0.23 || (highR > 0.42 && highE > lowE * 0.85)) {
    return 'FV';
  }
  if (lowR > 0.56 && highR < 0.16) {
    return rms > 0.24 ? 'OH' : 'OO';
  }
  if (highR > 0.22 && midR + highR > lowR * 1.15) {
    return 'EE';
  }
  if (midR >= 0.3 || rms > 0.16) {
    return 'AA';
  }
  return 'OH';
}

/** 10th-order Levinson-Durbin recursion returning predictor coefficients a[1..order] & residual error */
function solveLevinsonDurbin10(
  preSignal: Float32Array,
  order = 10
): { a: Float64Array; err: number } {
  const n = preSignal.length;
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let acc = 0;
    const lim = n - k;
    for (let i = 0; i < lim; i++) {
      acc += preSignal[i] * preSignal[i + k];
    }
    r[k] = acc;
  }

  const a = new Float64Array(order + 1);
  a[0] = 1;
  if (r[0] <= 1e-10) {
    return { a, err: 1e-10 };
  }
  // Tiny diagonal loading keeps pure-sine synthetic test tones strictly positive-definite
  r[0] = r[0] * 1.0002 + 1e-9;

  let err = r[0];
  const prev = new Float64Array(order + 1);

  for (let m = 1; m <= order; m++) {
    let num = r[m];
    for (let j = 1; j < m; j++) {
      num += a[j] * r[m - j];
    }
    let km = -num / Math.max(1e-12, err);
    if (km > 0.994) km = 0.994;
    if (km < -0.994) km = -0.994;

    for (let j = 1; j < m; j++) prev[j] = a[j];
    a[m] = km;
    for (let j = 1; j < m; j++) {
      a[j] = prev[j] + km * prev[m - j];
    }
    err *= 1 - km * km;
    if (err <= 1e-12) {
      err = 1e-12;
      break;
    }
  }
  return { a, err };
}

/** Evaluates 10-pole LPC power spectral envelope & extracts F1, F2, F3 formant peaks */
function estimateFormantsFromLpc(
  a: Float64Array,
  err: number,
  sampleRate: number
): { f1: number; f2: number; f3: number; lpcBark: Float32Array } {
  const maxHz = Math.min(4300, sampleRate * 0.46);
  const stepHz = 50;
  const bins = Math.max(8, Math.floor((maxHz - 180) / stepHz) + 1);
  const spec = new Float32Array(bins);
  const gain = Math.sqrt(Math.max(1e-12, err));

  for (let b = 0; b < bins; b++) {
    const hz = 180 + b * stepHz;
    const w = (2 * Math.PI * hz) / sampleRate;
    let re = 1;
    let im = 0;
    for (let k = 1; k < a.length; k++) {
      const ang = w * k;
      re += a[k] * Math.cos(ang);
      im -= a[k] * Math.sin(ang);
    }
    const denom = Math.sqrt(re * re + im * im + 1e-9);
    spec[b] = gain / denom;
  }

  // Pick top local maxima across vocal tract formant range
  const peaks: { hz: number; mag: number }[] = [];
  for (let b = 1; b < bins - 1; b++) {
    if (spec[b] >= spec[b - 1] && spec[b] >= spec[b + 1]) {
      // Parabolic interpolation for sub-bin formant precision
      const y0 = spec[b - 1];
      const y1 = spec[b];
      const y2 = spec[b + 1];
      const denom = y0 - 2 * y1 + y2;
      const delta = Math.abs(denom) > 1e-8 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
      peaks.push({ hz: 180 + (b + delta) * stepHz, mag: y1 });
    }
  }

  let f1 = 500;
  let f2 = 1480;
  let f3 = 2600;
  if (peaks.length >= 1) {
    f1 = peaks[0].hz;
    if (peaks.length >= 2) {
      f2 = peaks[1].hz;
      if (peaks.length >= 3) f3 = peaks[2].hz;
    } else {
      // Single prominent spectral peak (e.g. narrowband vowel or synthetic tone)
      f2 = Math.min(3400, Math.max(720, f1 * 1.9));
    }
  }

  const lpcBark = new Float32Array(18);
  for (let i = 0; i < 18; i++) {
    const hz = Math.min(sampleRate * 0.46, BARK_18_CENTERS_HZ[i]);
    const w = (2 * Math.PI * hz) / sampleRate;
    let re = 1;
    let im = 0;
    for (let k = 1; k < a.length; k++) {
      const ang = w * k;
      re += a[k] * Math.cos(ang);
      im -= a[k] * Math.sin(ang);
    }
    lpcBark[i] = gain / Math.sqrt(re * re + im * im + 1e-9);
  }

  return { f1, f2, f3, lpcBark };
}

/** Hann-windowed single-bin magnitude (sidelobes -31 dB vs -13 dB rectangular!) */
function hannBinMagnitude(
  winSig: Float32Array,
  sampleRate: number,
  targetHz: number
): number {
  const len = winSig.length;
  if (len <= 4 || targetHz >= sampleRate * 0.48) return 0;
  const omega = (2 * Math.PI * targetHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    s0 = winSig[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  // Factor 2.0 compensates Hann coherent gain 0.5
  return (2.0 * Math.sqrt(Math.max(0, power))) / len;
}

function medianNumber(vals: number[], fallback: number): number {
  if (vals.length === 0) return fallback;
  const sorted = [...vals].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/**
 * Pure DSP Audio Analyzer:
 *  - 25 ms Hann window (`10 ms` hop internal analysis) + `1 - 0.97 z^-1` pre-emphasis
 *  - 10th-order Levinson-Durbin LPC + 18-band Bark spectral envelope tracker
 *  - Speaker-adaptive median `(F1, F2)` vowel space centering (prevents `'AA'` saturation!)
 *  - Bilabial `M/B/P` lip-closure detector (`30–120 ms` high-freq dip `ΔE_high < -0.14`
 *    or low-frequency nasal murmur `E_{120..360} / E_{600..4000} > 4.0` -> mandatory `'closed'`)!
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

  let globalPeak = 0;
  let globalSumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > globalPeak) globalPeak = a;
    globalSumSq += a * a;
  }
  const silent =
    pcm.length === 0 ||
    globalPeak < 0.008 ||
    Math.sqrt(globalSumSq / Math.max(1, pcm.length)) < 0.0015;

  if (silent) {
    return {
      audioBlobKey: meta.audioBlobKey,
      durationSec: Number(durationSec.toFixed(2)),
      sampleRateHz: fps,
      frames: Array.from({ length: frameCount }, (_, f) => ({
        t: Number((f / fps).toFixed(3)),
        energy: 0,
        viseme: 'closed' as VisemeId,
      })),
      waveform: Array.from({ length: 48 }, () => 0),
      source: meta.source,
      label: meta.label,
    };
  }

  const normGain = Math.min(8, 0.85 / Math.max(0.001, globalPeak));
  const hopSec = 0.01; // 10 ms hop for crisp 30-120 ms bilabial consonant resolution
  const winLen = Math.max(64, Math.round(safeRate * 0.025)); // 25 ms Hann window
  const hopCount = Math.max(4, Math.ceil(durationSec / hopSec));

  const hann = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, winLen - 1)));
  }

  const rawWin = new Float32Array(winLen);
  const preWin = new Float32Array(winLen);

  interface HopFeature {
    t: number;
    rms: number;
    zcr: number;
    f1: number;
    f2: number;
    f3: number;
    lowE: number;
    midE: number;
    highE: number;
    e120_360: number;
    e600_4000: number;
    eHighNorm: number;
    forcedClosed: boolean;
    viseme: VisemeId;
  }

  const hops: HopFeature[] = [];
  const highRawList: number[] = [];

  for (let h = 0; h < hopCount; h++) {
    const tCenter = (h + 0.5) * hopSec;
    const centerIdx = Math.floor(tCenter * safeRate);
    const start = centerIdx - (winLen >> 1);

    let sumSq = 0;
    let zc = 0;
    let prevSample = 0;
    for (let i = 0; i < winLen; i++) {
      const idx = start + i;
      const cur = idx >= 0 && idx < pcm.length ? pcm[idx] * normGain : 0;
      const prev = idx - 1 >= 0 && idx - 1 < pcm.length ? pcm[idx - 1] * normGain : cur;
      rawWin[i] = cur * hann[i];
      preWin[i] = (cur - 0.97 * prev) * hann[i];
      sumSq += cur * cur;
      if (i > 0 && ((cur >= 0 && prevSample < 0) || (cur < 0 && prevSample >= 0))) zc++;
      prevSample = cur;
    }

    const rms = Math.min(1, Math.sqrt(sumSq / winLen) * 1.65);
    const zcr = zc / winLen;

    const { a, err } = solveLevinsonDurbin10(preWin, 10);
    const { f1, f2, f3, lpcBark } = estimateFormantsFromLpc(a, err, safeRate);

    // Compute 18-band Bark spectral energies (Hann DFT fused with LPC envelope shape)
    const barkE = new Float32Array(18);
    for (let b = 0; b < 18; b++) {
      const dftMag = hannBinMagnitude(rawWin, safeRate, BARK_18_CENTERS_HZ[b]);
      barkE[b] = dftMag * 0.78 + lpcBark[b] * 0.22;
    }

    // Exact band powers from un-tilted Hann DFT for bilabial nasal/closure detection
    const e150 = hannBinMagnitude(rawWin, safeRate, 150);
    const e240 = hannBinMagnitude(rawWin, safeRate, 240);
    const e330 = hannBinMagnitude(rawWin, safeRate, 330);
    const e120_360 = (e150 * e150 + e240 * e240 + e330 * e330) / 3;

    let e600_4000 = 0;
    let count600_4000 = 0;
    for (let b = 5; b <= 16; b++) {
      if (BARK_18_CENTERS_HZ[b] >= safeRate * 0.47) break;
      const m = hannBinMagnitude(rawWin, safeRate, BARK_18_CENTERS_HZ[b]);
      e600_4000 += m * m;
      count600_4000++;
    }
    e600_4000 /= Math.max(1, count600_4000);

    // Aggregate low (Bark 0..4: 150..570Hz), mid (Bark 5..10: 700..1600Hz), high (Bark 11..17: 1850..4800Hz)
    const lowE = (barkE[0] + barkE[1] + barkE[2] + barkE[3] + barkE[4]) / 5;
    const midE = (barkE[5] + barkE[6] + barkE[7] + barkE[8] + barkE[9] + barkE[10]) / 6;
    const highE = (barkE[11] + barkE[12] + barkE[13] + barkE[14] + barkE[15] + barkE[16] + barkE[17]) / 7;
    const highComposite = midE * 0.45 + highE * 0.55;
    if (rms > 0.04) highRawList.push(highComposite);

    hops.push({
      t: tCenter,
      rms,
      zcr,
      f1,
      f2,
      f3,
      lowE,
      midE,
      highE,
      e120_360,
      e600_4000,
      eHighNorm: highComposite,
      forcedClosed: false,
      viseme: 'closed',
    });
  }

  // Normalize high-frequency contour to [0..1] against speech 85th-percentile peak
  const sortedHigh = [...highRawList].sort((x, y) => x - y);
  const highRef =
    sortedHigh.length > 0
      ? Math.max(1e-4, sortedHigh[Math.min(sortedHigh.length - 1, Math.floor(sortedHigh.length * 0.85))])
      : 1;
  for (let h = 0; h < hops.length; h++) {
    hops[h].eHighNorm = Math.min(1.2, hops[h].eHighNorm / highRef);
  }

  // Bilabial M/B/P Lip-Closure Detector:
  // Detects 30–120 ms (3..12 hops @ 10 ms) sudden high-freq energy dips (ΔE_high < -0.14)
  // OR low-freq bilabial nasal/voicebar murmur (E_{120..360} / E_{600..4000} > 4.0) inside speech!
  const bilabialCand = new Uint8Array(hops.length);
  for (let h = 0; h < hops.length; h++) {
    const cur = hops[h];
    let prevPeakHigh = 0;
    let nextPeakHigh = 0;
    let nearRmsPeak = 0;
    for (let d = 1; d <= 9; d++) {
      if (h - d >= 0) {
        if (hops[h - d].eHighNorm > prevPeakHigh) prevPeakHigh = hops[h - d].eHighNorm;
        if (hops[h - d].rms > nearRmsPeak) nearRmsPeak = hops[h - d].rms;
      }
      if (h + d < hops.length) {
        if (hops[h + d].eHighNorm > nextPeakHigh) nextPeakHigh = hops[h + d].eHighNorm;
        if (hops[h + d].rms > nearRmsPeak) nearRmsPeak = hops[h + d].rms;
      }
    }
    if (nearRmsPeak < 0.055) continue;

    const refHigh = prevPeakHigh > 0.08 && nextPeakHigh > 0.08
      ? Math.min(prevPeakHigh, nextPeakHigh)
      : Math.max(prevPeakHigh, nextPeakHigh);
    const deltaEHigh = cur.eHighNorm - refHigh;
    const nasalRatio = cur.e120_360 / (cur.e600_4000 + 1e-8);

    const isHighDip =
      prevPeakHigh > 0.14 && nextPeakHigh > 0.14 && deltaEHigh < -0.14 && cur.zcr < 0.2;
    const isNasalMurmur = cur.rms > 0.016 && nasalRatio > 4.0 && cur.zcr < 0.16;

    if (isHighDip || isNasalMurmur) {
      bilabialCand[h] = 1;
    }
  }

  let runStart = -1;
  for (let h = 0; h <= hops.length; h++) {
    const on = h < hops.length ? bilabialCand[h] === 1 : false;
    if (on && runStart < 0) {
      runStart = h;
    } else if (!on && runStart >= 0) {
      const runLen = h - runStart; // each hop = 10 ms -> 3..12 hops = 30..120 ms!
      const runMs = runLen * 10;
      if (runMs >= 30 && runMs <= 125) {
        const openBefore =
          runStart >= 1 && hops[runStart - 1].rms > 0.045 && bilabialCand[runStart - 1] === 0;
        const openAfter =
          h < hops.length && hops[h].rms > 0.045 && bilabialCand[h] === 0;
        if (openBefore || openAfter) {
          for (let k = runStart; k < h; k++) {
            hops[k].forcedClosed = true;
          }
        }
      }
      runStart = -1;
    }
  }

  // Speaker-adaptive median (F1, F2) across open voiced frames
  const voicedF1: number[] = [];
  const voicedF2: number[] = [];
  for (const hp of hops) {
    const sumE = hp.lowE + hp.midE + hp.highE + 1e-6;
    const highR = hp.highE / sumE;
    if (hp.rms >= 0.055 && !hp.forcedClosed && hp.zcr < 0.21 && highR < 0.42) {
      voicedF1.push(hp.f1);
      voicedF2.push(hp.f2);
    }
  }
  const adaptWeight = Math.max(0, Math.min(0.65, (voicedF1.length - 16) / 32));
  const medF1 = 520 * (1 - adaptWeight) + medianNumber(voicedF1, 520) * adaptWeight;
  const medF2 = 1480 * (1 - adaptWeight) + medianNumber(voicedF2, 1480) * adaptWeight;

  // Classify each hop using speaker-adapted LPC formants + 18-Bark spectral balance
  for (const hp of hops) {
    if (hp.forcedClosed || hp.rms < 0.028) {
      hp.viseme = 'closed';
      continue;
    }
    const sumE = hp.lowE + hp.midE + hp.highE + 1e-6;
    const lowR = hp.lowE / sumE;
    const midR = hp.midE / sumE;
    const highR = hp.highE / sumE;

    // 1. Labiodental & sibilant fricatives (F, V, S, Z, Ş, Ç)
    if (hp.zcr > 0.22 || (highR > 0.4 && hp.highE > hp.lowE * 0.85) || hp.f1 > 2150) {
      hp.viseme = 'FV';
      continue;
    }

    const df1 = hp.f1 - medF1;
    const df2 = hp.f2 - medF2;

    // 2. High rounded back/front vowels (U / Ü -> OO) & mid rounded vowels (O / Ö -> OH)
    if ((lowR > 0.54 && highR < 0.17) || (df1 < -55 && df2 < -140)) {
      hp.viseme = df1 < -135 || hp.rms <= 0.23 ? 'OO' : 'OH';
      continue;
    }

    // 3. Front spread vowels (E / İ / I -> EE)
    if (
      (df2 > 220 && df1 < 120) ||
      (highR > 0.21 && midR + highR > lowR * 1.15 && df1 < 110)
    ) {
      hp.viseme = 'EE';
      continue;
    }

    // 4. Open low vowel (A -> AA) vs rounded mid vowel (OH)
    if (df1 >= -35 || midR >= 0.31) {
      hp.viseme = 'AA';
    } else {
      hp.viseme = 'OH';
    }
  }

  // Downsample 10ms hop sequence cleanly to target frame rate (preserving mandatory M/B/P closures!)
  const frames: VoiceLipSyncFrame[] = [];
  let prevViseme: VisemeId = 'closed';
  let prevForced = false;

  for (let f = 0; f < frameCount; f++) {
    const t0 = f / fps;
    const t1 = (f + 1) / fps;
    const hStart = Math.max(0, Math.min(hops.length - 1, Math.floor(t0 / hopSec)));
    const hEnd = Math.max(hStart, Math.min(hops.length - 1, Math.ceil(t1 / hopSec) - 1));

    let anyForcedClosed = false;
    let maxRms = 0;
    const counts: Record<VisemeId, number> = {
      closed: 0,
      AA: 0,
      EE: 0,
      OH: 0,
      OO: 0,
      FV: 0,
    };

    for (let h = hStart; h <= hEnd; h++) {
      if (hops[h].forcedClosed) anyForcedClosed = true;
      if (hops[h].rms > maxRms) maxRms = hops[h].rms;
      counts[hops[h].viseme]++;
    }

    let viseme: VisemeId = 'closed';
    if (anyForcedClosed) {
      viseme = 'closed';
    } else {
      let bestCount = -1;
      for (const cand of ['FV', 'EE', 'OO', 'OH', 'AA', 'closed'] as VisemeId[]) {
        if (counts[cand] > bestCount) {
          bestCount = counts[cand];
          viseme = cand;
        }
      }
      // Gentle 1-frame hold ONLY for tiny unforced silence dips, NEVER across bilabial closures
      if (viseme === 'closed' && maxRms > 0.022 && prevViseme !== 'closed' && !prevForced) {
        viseme = prevViseme;
      }
    }

    prevViseme = viseme;
    prevForced = anyForcedClosed;

    frames.push({
      t: Number(t0.toFixed(3)),
      energy: Number((viseme === 'closed' ? 0 : Math.min(1, maxRms * 1.25)).toFixed(3)),
      viseme,
    });
  }

  // Compact 48-bar normalized amplitude waveform preview
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
  const { pcm, sampleRate } = await decodeAudioBlobToMonoPCM(blob);
  return analyzePCMToLipSyncTrack(pcm, sampleRate, {
    audioBlobKey,
    label,
    source,
    fps: 24,
  });
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

  const eNasal = avgBand(120, 360);
  const eMidHigh = avgBand(600, 4000);
  if (rms > 0.03 && eNasal / (eMidHigh + 1e-4) > 3.2 && zcr < 0.14) {
    return { energy: 0, viseme: 'closed' };
  }

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
  if ('mbp'.includes(ch)) return { mouthOpen: 0, viseme: 'closed' };
  if ('aâ'.includes(ch)) return { mouthOpen: 0.92, viseme: 'AA' };
  if ('eiıî'.includes(ch)) return { mouthOpen: 0.68, viseme: 'EE' };
  if ('oö'.includes(ch)) return { mouthOpen: 0.82, viseme: 'OH' };
  if ('uü'.includes(ch)) return { mouthOpen: 0.62, viseme: 'OO' };
  if ('fvszşçcjh'.includes(ch)) return { mouthOpen: 0.42, viseme: 'FV' };
  return { mouthOpen: 0.48, viseme: 'AA' };
}

// ============================================================================
// 2. ADAPTIVE CIE-LAB + PYRAMIDAL SPARSE LUCAS-KANADE (KLT) POSE CV ENGINE
// ============================================================================

/** Converts sRGB (0..255) into perceptual CIE-LAB (L: 0..100, a: -128..127, b: -128..127) */
function rgbToCieLab(r8: number, g8: number, b8: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);

  // D65 reference white normalized XYZ
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

interface PyramidLevel {
  w: number;
  h: number;
  gray: Float32Array;
  gradX: Float32Array;
  gradY: Float32Array;
  edgeMag: Float32Array;
}

interface KltFeaturePoint {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  zone: 'head' | 'torso' | 'leftArm' | 'rightArm';
}

function buildGrayscalePyramid(rgba: Uint8ClampedArray, srcW: number, srcH: number): PyramidLevel[] {
  // Canonical 160x120 base pyramid (uses native dims if smaller like 96x72 unit tests)
  const w0 = srcW > 160 ? 160 : srcW;
  const h0 = srcH > 120 ? 120 : srcH;
  const g0 = new Float32Array(w0 * h0);

  if (w0 === srcW && h0 === srcH) {
    for (let i = 0; i < w0 * h0; i++) {
      const o = i * 4;
      g0[i] = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255;
    }
  } else {
    for (let y = 0; y < h0; y++) {
      const sy = Math.min(srcH - 1, Math.floor((y * srcH) / h0));
      for (let x = 0; x < w0; x++) {
        const sx = Math.min(srcW - 1, Math.floor((x * srcW) / w0));
        const o = (sy * srcW + sx) * 4;
        g0[y * w0 + x] = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255;
      }
    }
  }

  const makeLevel = (gray: Float32Array, w: number, h: number): PyramidLevel => {
    const gradX = new Float32Array(w * h);
    const gradY = new Float32Array(w * h);
    const edgeMag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        // 3x3 Sobel operator
        const gx =
          -gray[(y - 1) * w + (x - 1)] +
          gray[(y - 1) * w + (x + 1)] -
          2 * gray[y * w + (x - 1)] +
          2 * gray[y * w + (x + 1)] -
          gray[(y + 1) * w + (x - 1)] +
          gray[(y + 1) * w + (x + 1)];
        const gy =
          -gray[(y - 1) * w + (x - 1)] -
          2 * gray[(y - 1) * w + x] -
          gray[(y - 1) * w + (x + 1)] +
          gray[(y + 1) * w + (x - 1)] +
          2 * gray[(y + 1) * w + x] +
          gray[(y + 1) * w + (x + 1)];
        gradX[idx] = gx * 0.25;
        gradY[idx] = gy * 0.25;
        edgeMag[idx] = Math.min(1, Math.hypot(gx, gy) * 0.5);
      }
    }
    return { w, h, gray, gradX, gradY, edgeMag };
  };

  const downsample = (prev: PyramidLevel): PyramidLevel | null => {
    const nw = Math.floor(prev.w / 2);
    const nh = Math.floor(prev.h / 2);
    if (nw < 16 || nh < 12) return null;
    const ng = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const y2 = y * 2;
      for (let x = 0; x < nw; x++) {
        const x2 = x * 2;
        ng[y * nw + x] =
          0.25 *
          (prev.gray[y2 * prev.w + x2] +
            prev.gray[y2 * prev.w + x2 + 1] +
            prev.gray[(y2 + 1) * prev.w + x2] +
            prev.gray[(y2 + 1) * prev.w + x2 + 1]);
      }
    }
    return makeLevel(ng, nw, nh);
  };

  const levels: PyramidLevel[] = [makeLevel(g0, w0, h0)];
  const l1 = downsample(levels[0]);
  if (l1) {
    levels.push(l1);
    const l2 = downsample(l1);
    if (l2) levels.push(l2);
  }
  return levels;
}

function sampleBilinear(buf: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const cx = Math.max(0, Math.min(w - 1.001, fx));
  const cy = Math.max(0, Math.min(h - 1.001, fy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const tx = cx - x0;
  const ty = cy - y0;
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const top = buf[y0 * w + x0] * (1 - tx) + buf[y0 * w + x1] * tx;
  const bot = buf[y1 * w + x0] * (1 - tx) + buf[y1 * w + x1] * tx;
  return top * (1 - ty) + bot * ty;
}

export interface MeasuredPoseFeatures {
  headCx: number;
  headCy: number;
  headTopY: number;
  headTiltRaw: number;
  torsoCx: number;
  leftWingY: number;
  leftWingEnergy: number;
  rightWingY: number;
  rightWingEnergy: number;
  /** Extended 2.5D CV outputs */
  headYawRad: number;
  headPitchRad: number;
  headRollRad: number;
  torsoLeanRad: number;
  leftArmLift: number;
  rightArmLift: number;
  mouthAspectRatio: number;
  eyeBlink: number;
}

/**
 * User-Adaptive CIE-LAB + Sobel Edge + Pyramidal Sparse Lucas-Kanade (KLT) Pose Tracker!
 * Works across ALL skin tones (dark, olive, fair), room lighting temperatures, glasses/beards,
 * and clothing sleeves without any hardcoded YCbCr skin thresholds!
 */
export class AdaptiveKltPoseTracker {
  public calibrated = false;
  public bgLab: [number, number, number] = [92, 0, 2];
  public bgSpread = 16;
  public faceLab: [number, number, number] = [62, 12, 16];
  public faceSpread = 24;
  public torsoLab: [number, number, number] = [32, 2, 2];
  public torsoSpread = 28;
  public baseHeadCx = 0.5;
  public baseHeadCy = 0.28;
  public baseHeadRadius = 0.13;
  public baseMouthEnergy = 0.08;
  public baseEyeEdge = 0.12;
  private headEdgeTemplate: Float32Array | null = null;
  private tplW = 16;
  private tplH = 16;
  private prevPyramid: PyramidLevel[] | null = null;
  private prevGray0: Float32Array | null = null;
  private points: KltFeaturePoint[] = [];

  public reset(): void {
    this.calibrated = false;
    this.prevPyramid = null;
    this.prevGray0 = null;
    this.points = [];
    this.headEdgeTemplate = null;
  }

  /** Learns user-specific CIE-LAB face/torso/background models + Sobel head edge template */
  public calibrate(rgba: Uint8ClampedArray, w: number, h: number): MeasuredPoseFeatures {
    this.reset();
    const pyr = buildGrayscalePyramid(rgba, w, h);
    const lv0 = pyr[0];

    // 1. Learn room background LAB from outer top/left/right margins
    let bgL = 0,
      bgA = 0,
      bgB = 0,
      bgN = 0;
    const borderSamples: [number, number, number][] = [];
    const stepX = Math.max(1, Math.floor(w / 32));
    const stepY = Math.max(1, Math.floor(h / 24));

    for (let y = 0; y < h; y += stepY) {
      const ny = y / Math.max(1, h - 1);
      for (let x = 0; x < w; x += stepX) {
        const nx = x / Math.max(1, w - 1);
        const isMargin = ny < 0.08 || ((nx < 0.12 || nx > 0.88) && ny < 0.55);
        if (!isMargin) continue;
        const o = (y * w + x) * 4;
        const lab = rgbToCieLab(rgba[o], rgba[o + 1], rgba[o + 2]);
        bgL += lab[0];
        bgA += lab[1];
        bgB += lab[2];
        bgN++;
        borderSamples.push(lab);
      }
    }
    if (bgN > 0) {
      this.bgLab = [bgL / bgN, bgA / bgN, bgB / bgN];
      let varSum = 0;
      for (const s of borderSamples) {
        varSum += Math.hypot(s[0] - this.bgLab[0], s[1] - this.bgLab[1], s[2] - this.bgLab[2]);
      }
      this.bgSpread = Math.max(10, Math.min(36, (varSum / bgN) * 1.6 + 8));
    }

    // 2. Learn subject face/head CIE-LAB in upper-center & torso CIE-LAB in lower-center
    let fL = 0,
      fA = 0,
      fB = 0,
      fW = 0;
    let tL = 0,
      tA = 0,
      tB = 0,
      tW = 0;

    for (let y = 0; y < h; y += stepY) {
      const ny = y / Math.max(1, h - 1);
      const py = Math.min(lv0.h - 1, Math.floor(ny * lv0.h));
      for (let x = 0; x < w; x += stepX) {
        const nx = x / Math.max(1, w - 1);
        const px = Math.min(lv0.w - 1, Math.floor(nx * lv0.w));
        const o = (y * w + x) * 4;
        const lab = rgbToCieLab(rgba[o], rgba[o + 1], rgba[o + 2]);
        const bgDist = Math.hypot(
          (lab[0] - this.bgLab[0]) * 0.9,
          lab[1] - this.bgLab[1],
          lab[2] - this.bgLab[2]
        );
        const edge = lv0.edgeMag[py * lv0.w + px];
        const fgWeight = Math.max(0, (bgDist - this.bgSpread * 0.55) / 24) + edge * 0.85;
        if (fgWeight <= 0.05) continue;

        if (nx >= 0.32 && nx <= 0.68 && ny >= 0.1 && ny <= 0.46) {
          const centerBias = 1 - Math.hypot((nx - 0.5) * 2.2, (ny - 0.27) * 2.4) * 0.45;
          const wgt = fgWeight * Math.max(0.25, centerBias);
          fL += lab[0] * wgt;
          fA += lab[1] * wgt;
          fB += lab[2] * wgt;
          fW += wgt;
        } else if (nx >= 0.28 && nx <= 0.72 && ny >= 0.48 && ny <= 0.9) {
          tL += lab[0] * fgWeight;
          tA += lab[1] * fgWeight;
          tB += lab[2] * fgWeight;
          tW += fgWeight;
        }
      }
    }

    if (fW > 0.2) {
      this.faceLab = [fL / fW, fA / fW, fB / fW];
    }
    if (tW > 0.2) {
      this.torsoLab = [tL / tW, tA / tW, tB / tW];
    } else if (fW > 0.2) {
      this.torsoLab = [...this.faceLab];
    }

    this.calibrated = true;
    const initial = this.processFrameInternal(rgba, w, h, pyr, true);
    this.baseHeadCx = initial.headCx;
    this.baseHeadCy = initial.headCy;
    this.captureHeadTemplate(lv0, initial.headCx, initial.headCy);
    this.seedKltPoints(lv0, initial.headCx, initial.headCy, initial.torsoCx);
    this.prevPyramid = pyr;
    this.prevGray0 = new Float32Array(lv0.gray);
    return initial;
  }

  private captureHeadTemplate(lv0: PyramidLevel, cx: number, cy: number): void {
    const tw = this.tplW;
    const th = this.tplH;
    const tpl = new Float32Array(tw * th);
    const radX = 0.14 * lv0.w;
    const radY = 0.16 * lv0.h;
    const pxCenter = cx * lv0.w;
    const pyCenter = cy * lv0.h;

    for (let j = 0; j < th; j++) {
      const sy = pyCenter + ((j / (th - 1)) * 2 - 1) * radY;
      for (let i = 0; i < tw; i++) {
        const sx = pxCenter + ((i / (tw - 1)) * 2 - 1) * radX;
        tpl[j * tw + i] = sampleBilinear(lv0.edgeMag, lv0.w, lv0.h, sx, sy);
      }
    }
    this.headEdgeTemplate = tpl;
  }

  /** Re-anchors head center via Sobel edge template correlation around predicted position */
  private reanchorHeadTemplate(
    lv0: PyramidLevel,
    predCx: number,
    predCy: number
  ): { cx: number; cy: number; score: number } {
    if (!this.headEdgeTemplate) return { cx: predCx, cy: predCy, score: 0 };
    const tw = this.tplW;
    const th = this.tplH;
    const radX = 0.14 * lv0.w;
    const radY = 0.16 * lv0.h;

    let bestCx = predCx;
    let bestCy = predCy;
    let bestScore = -1e9;

    for (let dy = -3; dy <= 3; dy++) {
      const candCy = Math.max(0.1, Math.min(0.55, predCy + dy * 0.025));
      for (let dx = -4; dx <= 4; dx++) {
        const candCx = Math.max(0.16, Math.min(0.84, predCx + dx * 0.028));
        let sad = 0;
        const pxC = candCx * lv0.w;
        const pyC = candCy * lv0.h;
        for (let j = 0; j < th; j += 2) {
          const sy = pyC + ((j / (th - 1)) * 2 - 1) * radY;
          for (let i = 0; i < tw; i += 2) {
            const sx = pxC + ((i / (tw - 1)) * 2 - 1) * radX;
            const curE = sampleBilinear(lv0.edgeMag, lv0.w, lv0.h, sx, sy);
            sad += Math.abs(curE - this.headEdgeTemplate[j * tw + i]);
          }
        }
        const score = 1 - sad / ((tw * th) / 4);
        if (score > bestScore) {
          bestScore = score;
          bestCx = candCx;
          bestCy = candCy;
        }
      }
    }
    return { cx: bestCx, cy: bestCy, score: bestScore };
  }

  /** Selects Shi-Tomasi high-eigenvalue corner features across anatomical zones */
  private seedKltPoints(lv0: PyramidLevel, headCx: number, headCy: number, torsoCx: number): void {
    const pts: KltFeaturePoint[] = [];
    const pickZone = (
      zone: KltFeaturePoint['zone'],
      nx0: number,
      nx1: number,
      ny0: number,
      ny1: number,
      maxPts: number
    ) => {
      const cands: { x: number; y: number; corner: number }[] = [];
      const x0 = Math.max(2, Math.floor(nx0 * lv0.w));
      const x1 = Math.min(lv0.w - 3, Math.ceil(nx1 * lv0.w));
      const y0 = Math.max(2, Math.floor(ny0 * lv0.h));
      const y1 = Math.min(lv0.h - 3, Math.ceil(ny1 * lv0.h));

      for (let y = y0; y <= y1; y += 3) {
        for (let x = x0; x <= x1; x += 3) {
          let gxx = 0,
            gyy = 0,
            gxy = 0;
          for (let wy = -1; wy <= 1; wy++) {
            for (let wx = -1; wx <= 1; wx++) {
              const id = (y + wy) * lv0.w + (x + wx);
              const ix = lv0.gradX[id];
              const iy = lv0.gradY[id];
              gxx += ix * ix;
              gyy += iy * iy;
              gxy += ix * iy;
            }
          }
          const trace = gxx + gyy;
          const det = gxx * gyy - gxy * gxy;
          const disc = Math.sqrt(Math.max(0, trace * trace * 0.25 - det));
          const minEig = trace * 0.5 - disc;
          if (minEig > 0.0008) {
            cands.push({ x: x / (lv0.w - 1), y: y / (lv0.h - 1), corner: minEig });
          }
        }
      }
      cands.sort((a, b) => b.corner - a.corner);
      for (let i = 0; i < Math.min(maxPts, cands.length); i++) {
        pts.push({ x: cands[i].x, y: cands[i].y, zone });
      }
    };

    pickZone(
      'head',
      Math.max(0.15, headCx - 0.16),
      Math.min(0.85, headCx + 0.16),
      Math.max(0.05, headCy - 0.16),
      Math.min(0.54, headCy + 0.16),
      10
    );
    pickZone(
      'torso',
      Math.max(0.2, torsoCx - 0.18),
      Math.min(0.8, torsoCx + 0.18),
      0.48,
      0.9,
      8
    );
    pickZone('leftArm', 0.04, 0.34, 0.1, 0.86, 6);
    pickZone('rightArm', 0.66, 0.96, 0.1, 0.86, 6);
    this.points = pts;
  }

  /** Tracks sparse KLT points across the coarse-to-fine Lucas-Kanade pyramid */
  private trackKltPyramid(
    prevPyr: PyramidLevel[],
    curPyr: PyramidLevel[]
  ): {
    headDx: number;
    headDy: number;
    headCount: number;
    torsoDx: number;
    torsoCount: number;
  } {
    const survived: KltFeaturePoint[] = [];
    let headDx = 0,
      headDy = 0,
      headCount = 0;
    let torsoDx = 0,
      torsoCount = 0;

    const L = Math.min(prevPyr.length, curPyr.length);
    for (const pt of this.points) {
      let flowX = 0;
      let flowY = 0;
      let valid = true;

      for (let lvl = L - 1; lvl >= 0; lvl--) {
        flowX *= 2;
        flowY *= 2;
        const pLv = prevPyr[lvl];
        const cLv = curPyr[lvl];
        const px = pt.x * (pLv.w - 1);
        const py = pt.y * (pLv.h - 1);

        // Precompute 5x5 spatial structure tensor G on prev frame
        let gxx = 0,
          gyy = 0,
          gxy = 0;
        const patchI: number[] = [];
        const patchIx: number[] = [];
        const patchIy: number[] = [];

        for (let wy = -2; wy <= 2; wy++) {
          for (let wx = -2; wx <= 2; wx++) {
            const ix = sampleBilinear(pLv.gradX, pLv.w, pLv.h, px + wx, py + wy);
            const iy = sampleBilinear(pLv.gradY, pLv.w, pLv.h, px + wx, py + wy);
            const iv = sampleBilinear(pLv.gray, pLv.w, pLv.h, px + wx, py + wy);
            patchIx.push(ix);
            patchIy.push(iy);
            patchI.push(iv);
            gxx += ix * ix;
            gyy += iy * iy;
            gxy += ix * iy;
          }
        }

        const det = gxx * gyy - gxy * gxy;
        if (det < 1e-7) {
          valid = false;
          break;
        }
        const invDet = 1 / det;

        // 4 Newton-Raphson Lucas-Kanade optical flow refinements
        for (let iter = 0; iter < 4; iter++) {
          let bx = 0;
          let by = 0;
          let k = 0;
          for (let wy = -2; wy <= 2; wy++) {
            for (let wx = -2; wx <= 2; wx++, k++) {
              const curVal = sampleBilinear(cLv.gray, cLv.w, cLv.h, px + flowX + wx, py + flowY + wy);
              const dt = curVal - patchI[k];
              bx -= patchIx[k] * dt;
              by -= patchIy[k] * dt;
            }
          }
          const dux = (gyy * bx - gxy * by) * invDet;
          const duy = (-gxy * bx + gxx * by) * invDet;
          flowX += dux;
          flowY += duy;
          if (Math.abs(dux) < 0.02 && Math.abs(duy) < 0.02) break;
        }
      }

      if (!valid) continue;
      const lv0 = curPyr[0];
      const nx = pt.x + flowX / Math.max(1, lv0.w - 1);
      const ny = pt.y + flowY / Math.max(1, lv0.h - 1);
      if (nx < 0.02 || nx > 0.98 || ny < 0.02 || ny > 0.98) continue;

      const dnx = nx - pt.x;
      const dny = ny - pt.y;
      if (Math.hypot(dnx, dny) > 0.35) continue;

      survived.push({ x: nx, y: ny, zone: pt.zone });
      if (pt.zone === 'head') {
        headDx += dnx;
        headDy += dny;
        headCount++;
      } else if (pt.zone === 'torso') {
        torsoDx += dnx;
        torsoCount++;
      }
    }

    this.points = survived;
    return {
      headDx: headCount > 0 ? headDx / headCount : 0,
      headDy: headCount > 0 ? headDy / headCount : 0,
      headCount,
      torsoDx: torsoCount > 0 ? torsoDx / torsoCount : 0,
      torsoCount,
    };
  }

  private processFrameInternal(
    rgba: Uint8ClampedArray,
    w: number,
    h: number,
    pyr: PyramidLevel[],
    isCalibrationPass: boolean
  ): MeasuredPoseFeatures {
    const lv0 = pyr[0];
    const hasMotion = !isCalibrationPass && this.prevGray0 && this.prevGray0.length === lv0.gray.length;

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

    // Sample on pyramid grid (<= 160x120) for guaranteed <1.2ms real-time speed
    const gw = lv0.w;
    const gh = lv0.h;

    for (let gy = 0; gy < gh; gy++) {
      const ny = gy / Math.max(1, gh - 1);
      const sy = Math.min(h - 1, Math.floor(ny * h));
      for (let gx = 0; gx < gw; gx++) {
        const nx = gx / Math.max(1, gw - 1);
        const sx = Math.min(w - 1, Math.floor(nx * w));
        const o = (sy * w + sx) * 4;
        const lab = rgbToCieLab(rgba[o], rgba[o + 1], rgba[o + 2]);
        const pIdx = gy * gw + gx;

        // 1. Background separation in perceptual CIE-LAB space (works on dark & fair skin alike!)
        const bgDist = Math.hypot(
          (lab[0] - this.bgLab[0]) * 0.95,
          lab[1] - this.bgLab[1],
          lab[2] - this.bgLab[2]
        );
        const bgProb = bgDist > this.bgSpread * 0.65 ? Math.min(1, (bgDist - this.bgSpread * 0.55) / 22) : 0;

        // 2. Normalized chromaticity + luminance similarity to user's learned face & torso LAB
        const faceDist = Math.hypot(
          (lab[0] - this.faceLab[0]) * 0.55, // luminance-tolerant under lighting shifts!
          lab[1] - this.faceLab[1],
          lab[2] - this.faceLab[2]
        );
        const faceSim = Math.max(0, 1 - faceDist / 38);

        const torsoDist = Math.hypot(
          (lab[0] - this.torsoLab[0]) * 0.55,
          lab[1] - this.torsoLab[1],
          lab[2] - this.torsoLab[2]
        );
        const torsoSim = Math.max(0, 1 - torsoDist / 42);

        // 3. Sobel structural edge + inter-frame optical motion cue
        const edge = lv0.edgeMag[pIdx];
        const motion =
          hasMotion && this.prevGray0
            ? Math.abs(lv0.gray[pIdx] - this.prevGray0[pIdx])
            : 0;

        let weight =
          bgProb * 0.72 +
          Math.max(faceSim * 0.85, torsoSim * 0.55) * (bgProb > 0.08 ? 1 : 0.35) +
          edge * 0.45 +
          (motion > 0.05 ? Math.min(1, motion * 3.8) : 0);

        if (weight < 0.2) continue;
        weight = Math.min(1.6, weight);

        // Head / Upper-Center Zone
        if (nx >= 0.2 && nx <= 0.8 && ny >= 0.03 && ny <= 0.52) {
          const headBoost = 0.65 + faceSim * 0.65;
          const hw = weight * headBoost;
          headW += hw;
          headSx += nx * hw;
          headSy += ny * hw;
          headSxx += nx * nx * hw;
          headSyy += ny * ny * hw;
          headSxy += nx * ny * hw;
          if (hw > 0.5 && ny < headTopY) headTopY = ny;
        }

        // Torso Zone
        if (nx >= 0.22 && nx <= 0.78 && ny >= 0.48 && ny <= 0.94) {
          torsoW += weight;
          torsoSx += nx * weight;
        }

        // Left Wing Arm/Wrist Zone
        if (nx < 0.34 && ny >= 0.06 && ny <= 0.88) {
          leftW += weight;
          leftSy += ny * weight;
        }

        // Right Wing Arm/Wrist Zone
        if (nx > 0.66 && ny >= 0.06 && ny <= 0.88) {
          rightW += weight;
          rightSy += ny * weight;
        }
      }
    }

    let headCx = headW > 1 ? headSx / headW : this.baseHeadCx;
    let headCy = headW > 1 ? headSy / headW : this.baseHeadCy;
    let torsoCx = torsoW > 1 ? torsoSx / torsoW : 0.5;

    // Fuse Pyramidal Sparse KLT Optical Flow + Sobel Template Re-Anchoring
    if (!isCalibrationPass && this.prevPyramid) {
      const klt = this.trackKltPyramid(this.prevPyramid, pyr);
      if (klt.headCount >= 3) {
        const kltPredCx = Math.max(0.14, Math.min(0.86, this.baseHeadCx + klt.headDx));
        const kltPredCy = Math.max(0.08, Math.min(0.56, this.baseHeadCy + klt.headDy));
        const reanchored = this.reanchorHeadTemplate(lv0, (headCx + kltPredCx) * 0.5, (headCy + kltPredCy) * 0.5);
        // Drift-free fusion: LAB+Sobel moment + KLT optical flow + template re-anchor
        headCx = headCx * 0.58 + kltPredCx * 0.24 + reanchored.cx * 0.18;
        headCy = headCy * 0.58 + kltPredCy * 0.24 + reanchored.cy * 0.18;
      }
      if (klt.torsoCount >= 2) {
        torsoCx = torsoCx * 0.72 + Math.max(0.2, Math.min(0.8, torsoCx + klt.torsoDx)) * 0.28;
      }
      if (klt.headCount < 4) {
        this.seedKltPoints(lv0, headCx, headCy, torsoCx);
      }
      this.baseHeadCx = headCx;
      this.baseHeadCy = headCy;
    }

    let headTiltRaw = 0;
    if (headW > 4) {
      const mx = headSx / headW;
      const my = headSy / headW;
      const vx = headSxx / headW - mx * mx;
      const vy = headSyy / headW - my * my;
      const vxy = headSxy / headW - mx * my;
      headTiltRaw = Math.max(-0.42, Math.min(0.42, Math.atan2(2 * vxy, vy - vx) * 0.5));
    }

    const wingNorm = Math.max(1, gw * gh * 0.052);
    const leftWingEnergy = Math.min(1, leftW / wingNorm);
    const rightWingEnergy = Math.min(1, rightW / wingNorm);
    const leftWingY = leftW > 0.5 ? leftSy / leftW : 0.68;
    const rightWingY = rightW > 0.5 ? rightSy / rightW : 0.68;

    // Measure Mouth Aspect Ratio (MAR) & Eye Blink inside tracked head ellipse
    let mouthEnergy = 0;
    let mouthN = 0;
    let eyeEdge = 0;
    let eyeN = 0;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const sx = Math.max(1, Math.min(gw - 2, Math.round(headCx * gw + dx)));
        const syMouth = Math.max(1, Math.min(gh - 2, Math.round((headCy + 0.055) * gh + dy * 0.45)));
        const pM = syMouth * gw + sx;
        // Oral opening exhibits dark interior cavity + high vertical Sobel gradient
        mouthEnergy += Math.abs(lv0.gradY[pM]) * 0.7 + Math.max(0, 0.55 - lv0.gray[pM]) * 0.5;
        mouthN++;

        const syEye = Math.max(1, Math.min(gh - 2, Math.round((headCy - 0.03) * gh + dy * 0.35)));
        const pE = syEye * gw + sx;
        eyeEdge += lv0.edgeMag[pE];
        eyeN++;
      }
    }
    const rawMouth = mouthN > 0 ? mouthEnergy / mouthN : 0;
    const rawEye = eyeN > 0 ? eyeEdge / eyeN : 0.1;
    if (isCalibrationPass) {
      this.baseMouthEnergy = Math.max(0.04, rawMouth);
      this.baseEyeEdge = Math.max(0.05, rawEye);
    }

    const mouthAspectRatio = Math.max(
      0,
      Math.min(1, (rawMouth - this.baseMouthEnergy * 1.08) * 4.5)
    );
    const eyeBlink =
      rawEye < this.baseEyeEdge * 0.72
        ? Math.min(1, (this.baseEyeEdge * 0.78 - rawEye) / Math.max(0.02, this.baseEyeEdge * 0.35))
        : 0;

    const headYawRad = Math.max(-0.61, Math.min(0.61, (headCx - 0.5) * 3.8));
    const headPitchRad = Math.max(-0.38, Math.min(0.38, (0.28 - headCy) * 2.2));
    const headRollRad = headTiltRaw;
    const torsoLeanRad = Math.max(-0.3, Math.min(0.3, (torsoCx - 0.5) * 2.1));
    const leftArmLift =
      leftWingEnergy > 0.12
        ? Math.max(-0.65, Math.min(1.1, (0.64 - leftWingY) * 2.6 * Math.min(1, leftWingEnergy * 1.4)))
        : 0;
    const rightArmLift =
      rightWingEnergy > 0.12
        ? Math.max(-0.65, Math.min(1.1, (0.64 - rightWingY) * 2.6 * Math.min(1, rightWingEnergy * 1.4)))
        : 0;

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
      headYawRad,
      headPitchRad,
      headRollRad,
      torsoLeanRad,
      leftArmLift,
      rightArmLift,
      mouthAspectRatio,
      eyeBlink,
    };
  }

  public update(rgba: Uint8ClampedArray, w: number, h: number): MeasuredPoseFeatures {
    if (!this.calibrated) {
      return this.calibrate(rgba, w, h);
    }
    const pyr = buildGrayscalePyramid(rgba, w, h);
    const res = this.processFrameInternal(rgba, w, h, pyr, false);
    this.prevPyramid = pyr;
    this.prevGray0 = new Float32Array(pyr[0].gray);
    return res;
  }
}

export interface PoseCalibrationBaseline {
  headCx: number;
  headCy: number;
  headTopY: number;
  torsoCx: number;
  leftWingY: number;
  rightWingY: number;
  bgRgb?: Uint8Array | null;
  tracker?: AdaptiveKltPoseTracker;
  width: number;
  height: number;
}

/**
 * Measures upper-body 2.5D pose geometry using Adaptive CIE-LAB + Sobel + Pyramidal KLT.
 * Supports both `measureFramePoseFeatures(rgba, w, h, tracker)` AND legacy `(rgba, w, h, bgRgb, prevRgba)`.
 */
export function measureFramePoseFeatures(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  prevStateOrBg?: AdaptiveKltPoseTracker | Uint8Array | null,
  prevRgba?: Uint8ClampedArray | null
): MeasuredPoseFeatures {
  if (prevStateOrBg instanceof AdaptiveKltPoseTracker) {
    return prevStateOrBg.update(rgba, w, h);
  }

  const tracker = new AdaptiveKltPoseTracker();
  if (prevRgba && prevRgba.length === w * h * 4) {
    tracker.calibrate(prevRgba, w, h);
    return tracker.update(rgba, w, h);
  }
  return tracker.calibrate(rgba, w, h);
}

/** Captures a calibrated CIE-LAB + KLT baseline from neutral camera posture or video frame 0 */
export function calibratePoseBaseline(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  captureBackground = false
): PoseCalibrationBaseline {
  const tracker = new AdaptiveKltPoseTracker();
  const f = tracker.calibrate(rgba, w, h);
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
    tracker,
    width: w,
    height: h,
  };
}

/**
 * Extracts a clamped, ARAP-safe 2.5D MotionCaptureSample from any webcam or video RGBA frame!
 * Uses the user-adaptive LAB + Pyramidal KLT tracker stored on `baseline`.
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
  const f = baseline?.tracker
    ? baseline.tracker.update(rgba, w, h)
    : measureFramePoseFeatures(rgba, w, h, baseline?.bgRgb ?? null, prevRgba ?? null);

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
  const dyLift = base.headCy - f.headCy;

  const headYawRad = Math.max(-0.61, Math.min(0.61, dxHead * 3.8));
  const headTiltRad = Math.max(-0.36, Math.min(0.36, f.headTiltRaw * mirrorSign + dxHead * 0.55));
  const bodyLeanRad = Math.max(-0.3, Math.min(0.3, dxTorso * 2.1));

  const rawLeft = f.leftArmLift;
  const rawRight = f.rightArmLift;
  const leftArmSwing = mirrored ? rawRight : rawLeft;
  const rightArmSwing = mirrored ? rawLeft : rawRight;

  const verticalLiftNorm = Math.max(0, Math.min(0.32, (dyLift - 0.025) * 2.4));
  const squashY = Math.max(
    0.84,
    Math.min(1.16, 1 + (dyLift > 0.025 ? dyLift * 0.75 : dyLift * 0.95))
  );

  const sample: MotionCaptureSample = {
    t: Number(tSec.toFixed(3)),
    headYawRad: Number(headYawRad.toFixed(4)),
    headTiltRad: Number(headTiltRad.toFixed(4)),
    bodyLeanRad: Number(bodyLeanRad.toFixed(4)),
    leftArmSwing: Number(leftArmSwing.toFixed(3)),
    rightArmSwing: Number(rightArmSwing.toFixed(3)),
    verticalLiftNorm: Number(verticalLiftNorm.toFixed(3)),
    squashY: Number(squashY.toFixed(3)),
  };

  if (f.mouthAspectRatio > 0.14) {
    sample.mouthOpen = Number(Math.min(0.95, f.mouthAspectRatio).toFixed(3));
    sample.viseme = f.mouthAspectRatio > 0.52 ? 'AA' : 'OH';
  }
  return sample;
}

/**
 * Pure helper evaluating Live Puppet Pad gestures (mutually exclusive arm gestures,
 * automatic free-left-arm wave when right hand holds a cane/prop, and real dialogue/voice visemes!).
 */
export function evaluateLivePuppetPadSample(opts: {
  padX: number;
  padY: number;
  sec: number;
  recTimeSec?: number;
  gestures: {
    handsUp: boolean;
    wave: boolean;
    surprise: boolean;
    speak: boolean;
  };
  preferLeftHandWave?: boolean;
  activeShotDialogue?: string;
  activeVoiceTrack?: VoiceLipSyncTrack | null;
}): MotionCaptureSample {
  const { padX, padY, sec, gestures: g, preferLeftHandWave = false } = opts;

  const headYawRad = Math.max(-0.61, Math.min(0.61, padX * 0.61));
  const headTiltRad = Math.max(-0.34, Math.min(0.34, padX * 0.16 + (g.surprise ? -0.14 : 0)));
  const bodyLeanRad = Math.max(-0.26, Math.min(0.26, padX * 0.22));
  const verticalLiftNorm =
    padY < -0.12 ? Math.min(0.32, (-padY - 0.12) * 0.38) : g.surprise ? 0.08 : 0;
  const squashY =
    padY > 0.12
      ? Math.max(0.84, 1 - (padY - 0.12) * 0.2)
      : verticalLiftNorm > 0.04
        ? Math.min(1.16, 1 + verticalLiftNorm * 0.48)
        : 1;

  let leftArmSwing = padX * -0.25;
  let rightArmSwing = padX * 0.25;
  if (g.wave) {
    if (preferLeftHandWave) {
      // Top-Hat Baron holds a rigid cane in right hand -> wave freely with LEFT arm!
      leftArmSwing = 1.02 + Math.sin(sec * 11) * 0.22;
      rightArmSwing = -0.08;
    } else {
      rightArmSwing = 1.02 + Math.sin(sec * 11) * 0.22;
      leftArmSwing = -0.08;
    }
  } else if (g.handsUp) {
    leftArmSwing = 0.98 + Math.sin(sec * 8) * 0.08;
    rightArmSwing = 0.98 + Math.cos(sec * 8) * 0.08;
  } else if (g.surprise) {
    leftArmSwing = 0.82;
    rightArmSwing = 0.82;
  }

  let viseme: VisemeId = 'closed';
  let mouthOpen = 0;

  if (g.speak) {
    const vt = opts.activeVoiceTrack;
    if (vt && vt.frames.length > 0 && vt.durationSec > 0.05) {
      const localT = ((sec % vt.durationSec) + vt.durationSec) % vt.durationSec;
      const sampled = sampleVoiceLipSync(vt, localT);
      viseme = sampled.viseme;
      mouthOpen = sampled.mouthOpen;
    } else {
      const line = opts.activeShotDialogue?.trim() || 'Merhaba dünya, harika bir sahne!';
      const estDur = Math.max(1.2, Math.min(6.0, line.length * 0.085));
      const tNorm = 0.09 + (((sec % estDur) + estDur) % estDur / estDur) * 0.84;
      const mapped = textDialogueToViseme(line, tNorm);
      viseme = mapped.viseme;
      mouthOpen = mapped.mouthOpen;
    }
  } else if (g.surprise) {
    viseme = 'OH';
    mouthOpen = 0.62;
  }

  return {
    t: Number((opts.recTimeSec ?? 0).toFixed(3)),
    headYawRad: Number(headYawRad.toFixed(4)),
    headTiltRad: Number(headTiltRad.toFixed(4)),
    bodyLeanRad: Number(bodyLeanRad.toFixed(4)),
    leftArmSwing: Number(leftArmSwing.toFixed(3)),
    rightArmSwing: Number(rightArmSwing.toFixed(3)),
    verticalLiftNorm: Number(verticalLiftNorm.toFixed(3)),
    squashY: Number(squashY.toFixed(3)),
    mouthOpen: Number(mouthOpen.toFixed(3)),
    viseme,
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
    mouthOpen:
      a.mouthOpen !== undefined && b.mouthOpen !== undefined ? lerp(a.mouthOpen, b.mouthOpen) : a.mouthOpen,
    viseme: u < 0.5 ? a.viseme : b.viseme,
  };
}

export interface ExtractedVideoMocapBundle {
  track: MotionCaptureTrack;
  extractedVoice: {
    wavBlob: Blob;
    lipSyncTrack: VoiceLipSyncTrack;
    pcm: Float32Array;
    sampleRate: number;
  } | null;
}

/**
 * Extracts up to 15.0s @ 24 FPS 2.5D KLT MotionCaptureTrack + optional decoded audio Lip-Sync
 * & 16-bit PCM WAV Blob directly from a reference acting video (.mp4 / .webm / .mov) offline!
 */
export async function extractMocapFromVideoFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<ExtractedVideoMocapBundle> {
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

    // Upgraded: up to 15.0 seconds @ 24 FPS!
    const dur = Math.max(0.8, Math.min(15.0, video.duration || 3.0));
    const fps = 24;
    const totalFrames = Math.max(8, Math.round(dur * fps));
    const W = 160;
    const H = 120;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const labelBase = file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Referans Video';

    // Decode reference video's audio track if present & non-silent!
    let extractedVoice: ExtractedVideoMocapBundle['extractedVoice'] = null;
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        const actx = new AC();
        try {
          const rawBuf = await file.arrayBuffer();
          const audioBuf = await actx.decodeAudioData(rawBuf.slice(0));
          const maxSamples = Math.min(audioBuf.length, Math.ceil(dur * audioBuf.sampleRate));
          const mono = new Float32Array(maxSamples);
          const ch0 = audioBuf.getChannelData(0);
          if (audioBuf.numberOfChannels > 1) {
            const ch1 = audioBuf.getChannelData(1);
            for (let i = 0; i < maxSamples; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
          } else {
            mono.set(ch0.subarray(0, maxSamples));
          }
          if (!isAudioBufferSilent(mono)) {
            const wavBlob = encodeMonoPcmToWavBlob(mono, audioBuf.sampleRate);
            const lipSyncTrack = analyzePCMToLipSyncTrack(mono, audioBuf.sampleRate, {
              audioBlobKey: '',
              label: `${labelBase} Ses`,
              source: 'file',
              fps: 24,
            });
            extractedVoice = {
              wavBlob,
              lipSyncTrack,
              pcm: mono,
              sampleRate: audioBuf.sampleRate,
            };
          }
        } finally {
          void actx.close().catch(() => {});
        }
      }
    } catch {
      // Video has no audio stream or codec without audio — keep motion capture cleanly
      extractedVoice = null;
    }

    let baseline: PoseCalibrationBaseline | null = null;
    let prevSmooth: MotionCaptureSample | null = null;
    const samples: MotionCaptureSample[] = [];

    for (let i = 0; i < totalFrames; i++) {
      const targetT = Math.min(dur - 0.015, i / fps);
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
      const raw = extractPoseSampleFromFrameRGBA(rgba, W, H, targetT, baseline, null, false);
      if (extractedVoice) {
        const lip = sampleVoiceLipSync(extractedVoice.lipSyncTrack, targetT);
        raw.viseme = lip.viseme;
        raw.mouthOpen = lip.mouthOpen;
      }
      const smoothed = smoothMocapSample(prevSmooth, raw, 0.42);
      samples.push(smoothed);
      prevSmooth = smoothed;
      onProgress?.(Math.round(((i + 1) / totalFrames) * 100));
    }

    const track: MotionCaptureTrack = {
      source: 'video',
      durationSec: Number(dur.toFixed(2)),
      fps,
      samples,
      createdAt: new Date().toISOString(),
      label: labelBase,
    };
    return { track, extractedVoice };
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
}

/** Backward-compatible wrapper returning MotionCaptureTrack directly */
export async function extractMocapTrackFromVideoFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<MotionCaptureTrack> {
  const { track } = await extractMocapFromVideoFile(file, onProgress);
  return track;
}

// ============================================================================
// 3. TR/EN G2P + ROSENBERG/LF GLOTTAL + 5-FORMANT KLATT VOCAL TRACT $0 TTS
// ============================================================================

interface KlattSegment {
  durSec: number;
  viseme: VisemeId;
  voiced: boolean;
  /** Target F1..F5 in Hz */
  formants: [number, number, number, number, number];
  /** Target B1..B5 in Hz */
  bandwidths: [number, number, number, number, number];
  voiceAmp: number;
  nasalAmp: number;
  fricAmp: number;
  fricHz: number;
  fricBw: number;
  aspirationAmp: number;
  trill26Hz?: boolean;
  accent: number;
}

const VOWEL_TARGETS: Record<
  string,
  { f: [number, number, number, number, number]; bw: [number, number, number, number, number]; v: VisemeId }
> = {
  a: { f: [750, 1220, 2550, 3400, 4100], bw: [90, 110, 170, 250, 300], v: 'AA' },
  e: { f: [530, 1880, 2550, 3450, 4150], bw: [75, 105, 165, 250, 300], v: 'EE' },
  ı: { f: [390, 1420, 2450, 3400, 4100], bw: [70, 105, 165, 250, 300], v: 'EE' },
  i: { f: [290, 2280, 3050, 3550, 4200], bw: [65, 95, 160, 250, 300], v: 'EE' },
  o: { f: [460, 860, 2480, 3400, 4100], bw: [80, 95, 165, 250, 300], v: 'OH' },
  ö: { f: [450, 1520, 2320, 3400, 4100], bw: [75, 100, 165, 250, 300], v: 'OH' },
  u: { f: [320, 740, 2380, 3350, 4050], bw: [65, 85, 160, 250, 300], v: 'OO' },
  ü: { f: [310, 1740, 2260, 3380, 4100], bw: [65, 95, 160, 250, 300], v: 'OO' },
};

/** Normalizes Turkish lowercase accurately (including İ -> i, I -> ı in Turkish context) */
function normalizeTextLower(text: string): { lower: string; hasTurkishChars: boolean } {
  const hasTr = /[ğüşıöçĞÜŞİÖÇâîûÂÎÛ]/.test(text);
  let out = '';
  for (const ch of text) {
    if (ch === 'İ') out += 'i';
    else if (ch === 'I') out += hasTr ? 'ı' : 'i';
    else if (ch === 'Ğ') out += 'ğ';
    else if (ch === 'Ü') out += 'ü';
    else if (ch === 'Ş') out += 'ş';
    else if (ch === 'Ö') out += 'ö';
    else if (ch === 'Ç') out += 'ç';
    else if (ch === 'Â') out += 'a';
    else if (ch === 'Î') out += 'i';
    else if (ch === 'Û') out += 'u';
    else out += ch.toLowerCase();
  }
  return { lower: out, hasTurkishChars: hasTr };
}

/** Rule-based Turkish (all 29 letters) + English common digraph G2P tokenizer */
function g2pToKlattSegments(rawText: string): KlattSegment[] {
  const { lower, hasTurkishChars } = normalizeTextLower(rawText.trim() || 'Merhaba!');

  // Apply English digraph rewrites when text does not contain Turkish-exclusive orthography
  let norm = lower
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/û/g, 'u');
  if (!hasTurkishChars) {
    norm = norm
      .replace(/sh/g, 'ş')
      .replace(/ch/g, 'ç')
      .replace(/ph/g, 'f')
      .replace(/th/g, 'f')
      .replace(/oo/g, 'u')
      .replace(/ee/g, 'i')
      .replace(/ea/g, 'i')
      .replace(/ou/g, 'o');
  }

  const chars = Array.from(norm);
  const segs: KlattSegment[] = [];
  let lastFormants: [number, number, number, number, number] = [500, 1480, 2500, 3400, 4100];
  let lastBandwidths: [number, number, number, number, number] = [80, 105, 165, 250, 300];

  const peekNextVowelFormants = (fromIdx: number): [number, number, number, number, number] => {
    for (let k = fromIdx + 1; k < Math.min(chars.length, fromIdx + 4); k++) {
      const vt = VOWEL_TARGETS[chars[k]];
      if (vt) return vt.f;
    }
    return lastFormants;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    // 1. Whitespace & punctuation prosodic pauses
    if (/\s/.test(ch)) {
      if (segs.length > 0 && !segs[segs.length - 1].voiced && segs[segs.length - 1].voiceAmp === 0 && segs[segs.length - 1].fricAmp === 0) {
        continue;
      }
      segs.push({
        durSec: 0.055,
        viseme: 'closed',
        voiced: false,
        formants: lastFormants,
        bandwidths: lastBandwidths,
        voiceAmp: 0,
        nasalAmp: 0,
        fricAmp: 0,
        fricHz: 1500,
        fricBw: 800,
        aspirationAmp: 0,
        accent: 0,
      });
      continue;
    }

    if (/[.,!?;:…—-]/.test(ch)) {
      segs.push({
        durSec: ch === ',' || ch === ';' || ch === ':' ? 0.095 : 0.135,
        viseme: 'closed',
        voiced: false,
        formants: lastFormants,
        bandwidths: lastBandwidths,
        voiceAmp: 0,
        nasalAmp: 0,
        fricAmp: 0,
        fricHz: 1500,
        fricBw: 800,
        aspirationAmp: 0,
        accent: 0,
      });
      continue;
    }

    // 2. Turkish 'ğ' (yumuşak g): smoothly lengthens preceding vowel!
    if (ch === 'ğ') {
      if (segs.length > 0 && segs[segs.length - 1].voiced) {
        segs[segs.length - 1].durSec += 0.075;
      } else {
        segs.push({
          durSec: 0.07,
          viseme: 'AA',
          voiced: true,
          formants: lastFormants,
          bandwidths: lastBandwidths,
          voiceAmp: 0.72,
          nasalAmp: 0,
          fricAmp: 0,
          fricHz: 1500,
          fricBw: 800,
          aspirationAmp: 0.02,
          accent: 0.85,
        });
      }
      continue;
    }

    // 3. 8 Turkish/English Vowels (a, e, ı, i, o, ö, u, ü)
    const vt = VOWEL_TARGETS[ch];
    if (vt) {
      lastFormants = vt.f;
      lastBandwidths = vt.bw;
      segs.push({
        durSec: 0.105,
        viseme: vt.v,
        voiced: true,
        formants: vt.f,
        bandwidths: vt.bw,
        voiceAmp: 0.95,
        nasalAmp: 0,
        fricAmp: 0,
        fricHz: 1500,
        fricBw: 800,
        aspirationAmp: 0.025,
        accent: 1.0,
      });
      continue;
    }

    const nextVf = peekNextVowelFormants(i);

    // 4. Bilabial Nasal 'm' -> mandatory 'closed' lip posture + 260 Hz nasal murmur!
    if (ch === 'm') {
      segs.push({
        durSec: 0.068,
        viseme: 'closed',
        voiced: true,
        formants: [260, 1020, 2250, 3300, 4000],
        bandwidths: [65, 260, 320, 350, 400],
        voiceAmp: 0.12,
        nasalAmp: 0.58,
        fricAmp: 0,
        fricHz: 800,
        fricBw: 500,
        aspirationAmp: 0,
        accent: 0.65,
      });
      continue;
    }

    // 5. Alveolar Nasal 'n'
    if (ch === 'n') {
      segs.push({
        durSec: 0.058,
        viseme: 'EE',
        voiced: true,
        formants: [280, 1540, 2480, 3350, 4050],
        bandwidths: [70, 210, 260, 320, 380],
        voiceAmp: 0.25,
        nasalAmp: 0.48,
        fricAmp: 0,
        fricHz: 1200,
        fricBw: 600,
        aspirationAmp: 0,
        accent: 0.68,
      });
      continue;
    }

    // 6. Bilabial Stops 'b' & 'p' -> mandatory 'closed' closure + labial burst!
    if (ch === 'b' || ch === 'p') {
      const voiced = ch === 'b';
      segs.push({
        durSec: 0.054,
        viseme: 'closed',
        voiced,
        formants: [220, 920, 2250, 3300, 4000],
        bandwidths: [75, 280, 340, 380, 420],
        voiceAmp: 0.03,
        nasalAmp: voiced ? 0.42 : 0,
        fricAmp: 0,
        fricHz: 750,
        fricBw: 550,
        aspirationAmp: 0,
        accent: 0.35,
      });
      segs.push({
        durSec: 0.02,
        viseme: 'closed',
        voiced,
        formants: [420, nextVf[1] * 0.85, nextVf[2], nextVf[3], nextVf[4]],
        bandwidths: [110, 160, 220, 280, 320],
        voiceAmp: voiced ? 0.38 : 0,
        nasalAmp: 0,
        fricAmp: voiced ? 0.18 : 0.34,
        fricHz: 780,
        fricBw: 650,
        aspirationAmp: voiced ? 0.02 : 0.14,
        accent: 0.7,
      });
      continue;
    }

    // 7. Alveolar & Velar Stops ('t', 'd', 'k', 'g', 'q')
    if ('tdkgq'.includes(ch)) {
      const voiced = ch === 'd' || ch === 'g';
      const velar = ch === 'k' || ch === 'g' || ch === 'q';
      segs.push({
        durSec: 0.036,
        viseme: 'EE',
        voiced,
        formants: [260, velar ? 1750 : 1650, 2550, 3400, 4100],
        bandwidths: [90, 240, 300, 340, 400],
        voiceAmp: voiced ? 0.08 : 0,
        nasalAmp: voiced ? 0.24 : 0,
        fricAmp: 0,
        fricHz: velar ? 1900 : 3300,
        fricBw: 900,
        aspirationAmp: 0,
        accent: 0.3,
      });
      segs.push({
        durSec: 0.024,
        viseme: 'EE',
        voiced,
        formants: [380, nextVf[1], nextVf[2], nextVf[3], nextVf[4]],
        bandwidths: [100, 140, 200, 260, 320],
        voiceAmp: voiced ? 0.42 : 0,
        nasalAmp: 0,
        fricAmp: voiced ? 0.22 : 0.38,
        fricHz: velar ? 1950 : 3400,
        fricBw: velar ? 850 : 1200,
        aspirationAmp: voiced ? 0.02 : 0.14,
        accent: 0.75,
      });
      continue;
    }

    // 8. Labiodental Fricatives ('f', 'v') -> 'FV'
    if (ch === 'f' || ch === 'v') {
      const voiced = ch === 'v';
      segs.push({
        durSec: 0.062,
        viseme: 'FV',
        voiced,
        formants: [340, 1380, 2480, 3400, 4100],
        bandwidths: [95, 160, 220, 280, 340],
        voiceAmp: voiced ? 0.38 : 0,
        nasalAmp: 0,
        fricAmp: voiced ? 0.28 : 0.42,
        fricHz: 2850,
        fricBw: 1650,
        aspirationAmp: 0.04,
        accent: 0.65,
      });
      continue;
    }

    // 9. Sibilants, Affricates & Aspirate ('s', 'z', 'ş', 'j', 'ç', 'c', 'h', 'x')
    if ('szşjçchx'.includes(ch)) {
      if (ch === 'h') {
        segs.push({
          durSec: 0.052,
          viseme: 'AA',
          voiced: false,
          formants: nextVf,
          bandwidths: [140, 160, 220, 280, 340],
          voiceAmp: 0,
          nasalAmp: 0,
          fricAmp: 0.14,
          fricHz: 1650,
          fricBw: 1200,
          aspirationAmp: 0.38,
          accent: 0.55,
        });
        continue;
      }
      const voiced = ch === 'z' || ch === 'j' || ch === 'c';
      const postalveolar = ch === 'ş' || ch === 'j' || ch === 'ç' || ch === 'c';
      if (ch === 'ç' || ch === 'c') {
        segs.push({
          durSec: 0.028,
          viseme: 'FV',
          voiced,
          formants: [280, 1750, 2550, 3400, 4100],
          bandwidths: [90, 220, 280, 340, 400],
          voiceAmp: voiced ? 0.12 : 0,
          nasalAmp: voiced ? 0.2 : 0,
          fricAmp: 0,
          fricHz: 2700,
          fricBw: 1000,
          aspirationAmp: 0,
          accent: 0.35,
        });
      }
      segs.push({
        durSec: ch === 'ç' || ch === 'c' ? 0.048 : 0.068,
        viseme: 'FV',
        voiced,
        formants: [340, postalveolar ? 1820 : 1680, 2650, 3500, 4200],
        bandwidths: [95, 160, 220, 280, 340],
        voiceAmp: voiced ? 0.34 : 0,
        nasalAmp: 0,
        fricAmp: voiced ? 0.36 : 0.48,
        fricHz: postalveolar ? 2680 : 4350,
        fricBw: postalveolar ? 1100 : 1450,
        aspirationAmp: 0.03,
        accent: 0.72,
      });
      continue;
    }

    // 10. Liquids & Glides ('l', 'r', 'y', 'w')
    if (ch === 'l' || ch === 'r' || ch === 'y' || ch === 'w') {
      const fTarget: [number, number, number, number, number] =
        ch === 'y'
          ? [290, 2220, 2980, 3500, 4200]
          : ch === 'w'
            ? [310, 740, 2320, 3350, 4050]
            : ch === 'r'
              ? [420, 1380, 1780, 3350, 4050]
              : [360, 1360, 2650, 3400, 4100];
      segs.push({
        durSec: ch === 'r' ? 0.056 : 0.062,
        viseme: ch === 'w' ? 'OO' : 'EE',
        voiced: true,
        formants: fTarget,
        bandwidths: [75, 115, 180, 260, 320],
        voiceAmp: 0.78,
        nasalAmp: 0,
        fricAmp: 0,
        fricHz: 1500,
        fricBw: 800,
        aspirationAmp: 0.02,
        trill26Hz: ch === 'r',
        accent: 0.82,
      });
      continue;
    }
  }

  if (segs.length === 0) {
    segs.push({
      durSec: 0.42,
      viseme: 'AA',
      voiced: true,
      formants: VOWEL_TARGETS.a.f,
      bandwidths: VOWEL_TARGETS.a.bw,
      voiceAmp: 0.92,
      nasalAmp: 0,
      fricAmp: 0,
      fricHz: 1500,
      fricBw: 800,
      aspirationAmp: 0.02,
      accent: 1,
    });
  }
  return segs;
}

/** 2-pole digital Klatt resonator state & coefficient helper */
interface KlattResonator {
  a: number;
  b: number;
  c: number;
  y1: number;
  y2: number;
}

function makeResonator(): KlattResonator {
  return { a: 1, b: 0, c: 0, y1: 0, y2: 0 };
}

function updateResonatorCoeffs(res: KlattResonator, freqHz: number, bwHz: number, sr: number): void {
  const f = Math.max(80, Math.min(sr * 0.46, freqHz));
  const bw = Math.max(40, Math.min(sr * 0.35, bwHz));
  const r = Math.exp((-Math.PI * bw) / sr);
  res.c = -(r * r);
  res.b = 2 * r * Math.cos((2 * Math.PI * f) / sr);
  res.a = 1 - res.b - res.c;
}

function stepResonator(res: KlattResonator, x: number): number {
  const y = res.a * x + res.b * res.y1 + res.c * res.y2;
  res.y2 = res.y1;
  res.y1 = y;
  return y;
}

/**
 * $0 Pure Offline Deterministic Turkish/English G2P + Rosenberg/LF Glottal Pulse +
 * 5-Formant Cascade/Parallel Klatt Vocal Tract Synthesizer (`24,000 Hz` 16-bit PCM WAV)!
 */
export function synthesizeCartoonDialogueWav(
  text: string,
  emotion: string,
  voiceId: string
): {
  blob: Blob;
  pcm: Float32Array;
  sampleRate: number;
  durationSec: number;
  lipSyncTrack: VoiceLipSyncTrack;
} {
  const sampleRate = 24000;
  const clean = text.trim() || 'Merhaba!';

  const profile =
    voiceId === 'Kore'
      ? { f0: 248, fScale: 1.13, breath: 0.045 }
      : voiceId === 'Charon'
        ? { f0: 128, fScale: 0.91, breath: 0.025 }
        : voiceId === 'Aoede'
          ? { f0: 186, fScale: 1.02, breath: 0.035 }
          : { f0: 214, fScale: 1.07, breath: 0.03 }; // Puck / Young Hero

  const emo =
    emotion === 'happy'
      ? { f0Mul: 1.12, tempo: 0.95, contourAmp: 1.25 }
      : emotion === 'surprised'
        ? { f0Mul: 1.18, tempo: 0.92, contourAmp: 1.35 }
        : emotion === 'tired'
          ? { f0Mul: 0.86, tempo: 1.14, contourAmp: 0.72 }
          : emotion === 'angry' || emotion === 'determined'
            ? { f0Mul: 0.95, tempo: 0.94, contourAmp: 1.2 }
            : { f0Mul: 1.0, tempo: 1.0, contourAmp: 1.0 };

  const segs = g2pToKlattSegments(clean);
  const leadSec = 0.045;
  const tailSec = 0.075;
  const rawContentSec = segs.reduce((acc, s) => acc + s.durSec * emo.tempo, 0);
  const maxDur = 8.0;
  const minDur = 0.72;
  const targetTotalSec = Math.max(
    minDur,
    Math.min(maxDur, rawContentSec + leadSec + tailSec)
  );
  const segScale =
    rawContentSec > 1e-4 ? (targetTotalSec - leadSec - tailSec) / rawContentSec : 1;

  const totalSamples = Math.max(1, Math.floor(targetTotalSec * sampleRate));
  const pcm = new Float32Array(totalSamples);

  const isQuestion = clean.endsWith('?');
  const isExclaim = clean.endsWith('!');

  // 5 Cascade Vocal Tract Resonators + Parallel Nasal & Fricative Resonators
  const cascade = [
    makeResonator(),
    makeResonator(),
    makeResonator(),
    makeResonator(),
    makeResonator(),
  ];
  const nasalRes = makeResonator();
  const fricRes = makeResonator();
  updateResonatorCoeffs(nasalRes, 255 * profile.fScale, 75, sampleRate);

  // Critically-damped 2nd-order coarticulation state for F1..F5 and B1..B5
  const curF = new Float64Array(segs[0].formants.map((v) => v * profile.fScale));
  const velF = new Float64Array(5);
  const curBw = new Float64Array(segs[0].bandwidths);
  const omegaCoart = 78; // rad/s (~13 ms smooth vocal tract articulatory time constant)

  let glottalPhase = 0;
  let prevGlottalFlow = 0;
  let curVoiceAmp = 0;
  let curNasalAmp = 0;
  let curFricAmp = 0;
  let curAspAmp = 0;

  // Deterministic LCG/xorshift PRNG for 100% reproducible fricative & aspiration turbulence
  let prng = 0x6d2b79f5;
  const nextWhite = () => {
    prng ^= prng << 13;
    prng ^= prng >>> 17;
    prng ^= prng << 5;
    return ((prng >>> 0) / 4294967295) * 2 - 1;
  };

  // Record exact phoneme timeline for direct lipSyncTrack generation
  const timeline: { startSec: number; endSec: number; viseme: VisemeId; energy: number }[] = [
    { startSec: 0, endSec: leadSec, viseme: 'closed', energy: 0 },
  ];

  let cursor = Math.floor(leadSec * sampleRate);
  const controlStep = 32; // update resonator & coarticulation ODE every 1.33 ms

  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const segDur = seg.durSec * emo.tempo * segScale;
    const segSamples = Math.max(1, Math.floor(segDur * sampleRate));
    const startSample = cursor;
    const progress = si / Math.max(1, segs.length - 1);

    const sentenceContour = isQuestion
      ? progress < 0.68
        ? 1.03 - progress * 0.14
        : 0.93 + ((progress - 0.68) / 0.32) ** 1.35 * 0.32 * emo.contourAmp
      : isExclaim
        ? 1.06 + Math.sin(progress * Math.PI) * 0.2 * emo.contourAmp - progress * 0.08
        : 1.05 - progress * 0.16 + Math.sin(progress * Math.PI * 2) * 0.05 * emo.contourAmp;

    updateResonatorCoeffs(fricRes, seg.fricHz, seg.fricBw, sampleRate);

    for (let i = 0; i < segSamples && cursor < totalSamples; i++, cursor++) {
      if (i % controlStep === 0) {
        const dt = controlStep / sampleRate;
        for (let k = 0; k < 5; k++) {
          const targetFk = seg.formants[k] * profile.fScale;
          const acc = omegaCoart * omegaCoart * (targetFk - curF[k]) - 2 * omegaCoart * velF[k];
          velF[k] += acc * dt;
          curF[k] += velF[k] * dt;
          curBw[k] += (seg.bandwidths[k] - curBw[k]) * Math.min(1, dt * 55);
          updateResonatorCoeffs(cascade[k], curF[k], curBw[k], sampleRate);
        }
      }

      const uSeg = i / segSamples;
      const segEnv =
        seg.voiceAmp > 0 || seg.nasalAmp > 0
          ? Math.min(1, uSeg / 0.14) * Math.min(1, (1 - uSeg) / 0.14 + 0.35)
          : Math.sin(Math.PI * Math.min(1, uSeg));

      // Smooth amplitude envelopes (zero click between segments)
      const alphaAmp = 0.008;
      curVoiceAmp += (seg.voiceAmp * segEnv - curVoiceAmp) * alphaAmp;
      curNasalAmp += (seg.nasalAmp * segEnv - curNasalAmp) * alphaAmp;
      curFricAmp += (seg.fricAmp * Math.sin(Math.PI * uSeg) - curFricAmp) * 0.015;
      curAspAmp += (seg.aspirationAmp * segEnv - curAspAmp) * 0.012;

      const tSec = cursor / sampleRate;
      const vibrato = 1 + Math.sin(2 * Math.PI * 5.4 * tSec) * 0.012;
      const microAccent = seg.voiced ? 1 + seg.accent * 0.04 * Math.sin(Math.PI * uSeg) : 1;
      const f0 = profile.f0 * emo.f0Mul * sentenceContour * vibrato * microAccent;

      glottalPhase += f0 / sampleRate;
      if (glottalPhase >= 1) glottalPhase -= Math.floor(glottalPhase);

      // Rosenberg / LF Glottal Flow Pulse + Return-Phase Derivative (rich -12 dB/oct harmonics!)
      const oq = 0.62;
      const tp = 0.43;
      let gFlow = 0;
      if (glottalPhase < tp) {
        const p = glottalPhase / tp;
        gFlow = 0.5 * (1 - Math.cos(Math.PI * p));
      } else if (glottalPhase < oq) {
        const p = (glottalPhase - tp) / (oq - tp);
        gFlow = Math.cos(0.5 * Math.PI * p);
      }
      // Lip-radiated glottal derivative pulse
      const glottalDeriv = (gFlow - prevGlottalFlow) * 14.5;
      prevGlottalFlow = gFlow;

      const white = nextWhite();
      // Modulate aspiration noise by glottal open phase for natural human breathiness
      const glottalSource =
        glottalDeriv * (curVoiceAmp + curNasalAmp * 0.55) +
        white * (curAspAmp + curVoiceAmp * profile.breath * (glottalPhase < oq ? 1 : 0.25));

      // 5-Formant Cascade Vocal Tract (F5 -> F4 -> F3 -> F2 -> F1)
      let vocalOut = glottalSource * curVoiceAmp;
      for (let k = 4; k >= 0; k--) {
        vocalOut = stepResonator(cascade[k], vocalOut);
      }
      if (seg.trill26Hz) {
        vocalOut *= 0.72 + 0.28 * Math.sin(2 * Math.PI * 26 * tSec);
      }

      // Parallel Nasal Branch (dominant 255 Hz murmur during 'm', 'n', and voiced 'b/d/g' voice-bars)
      const nasalOut = stepResonator(nasalRes, glottalDeriv * curNasalAmp) * 1.35;

      // Parallel Fricative / Plosive Burst Branch
      const fricOut = stepResonator(fricRes, white * curFricAmp) * 1.1;

      const mixed = vocalOut * 0.55 + nasalOut * 0.52 + fricOut * 0.58;
      pcm[cursor] = Math.tanh(mixed);
    }

    const endSample = cursor;
    const visEnergy =
      seg.viseme === 'closed'
        ? 0
        : Math.min(1, Math.max(0.24, seg.voiceAmp * 0.9 + seg.fricAmp * 0.75));
    timeline.push({
      startSec: startSample / sampleRate,
      endSec: endSample / sampleRate,
      viseme: seg.viseme,
      energy: visEnergy,
    });
  }

  // Normalize peak cleanly to 0.86 so synthesized speech has consistent broadcast loudness
  let peak = 0.001;
  for (let i = 0; i < totalSamples; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  const gain = 0.86 / peak;
  for (let i = 0; i < totalSamples; i++) {
    pcm[i] = Math.max(-0.96, Math.min(0.96, pcm[i] * gain));
  }

  // Build exact 24 FPS phoneme-locked VoiceLipSyncTrack directly from synthesizer timeline!
  const lipFps = 24;
  const durationSec = Number((totalSamples / sampleRate).toFixed(2));
  const frameCount = Math.max(4, Math.ceil((totalSamples / sampleRate) * lipFps));
  const frames: VoiceLipSyncFrame[] = [];

  for (let f = 0; f < frameCount; f++) {
    const t0 = f / lipFps;
    const t1 = (f + 1) / lipFps;
    const tMid = (t0 + t1) * 0.5;

    // Preserve brief bilabial 'closed' segments (m, b, p) whenever they overlap this frame!
    let closedSegOverlap = false;
    let activeSeg: (typeof timeline)[number] | null = null;
    for (let k = 1; k < timeline.length; k++) {
      const seg = timeline[k];
      if (seg.viseme === 'closed' && seg.endSec - seg.startSec <= 0.125) {
        const overlap = Math.min(t1, seg.endSec) - Math.max(t0, seg.startSec);
        if (overlap >= 0.014) {
          closedSegOverlap = true;
          break;
        }
      }
      if (tMid >= seg.startSec && tMid < seg.endSec) {
        activeSeg = seg;
      }
    }

    const chosenViseme: VisemeId = closedSegOverlap
      ? 'closed'
      : activeSeg
        ? activeSeg.viseme
        : 'closed';
    const chosenEnergy = chosenViseme === 'closed' ? 0 : activeSeg?.energy ?? 0;

    frames.push({
      t: Number(t0.toFixed(3)),
      energy: Number(chosenEnergy.toFixed(3)),
      viseme: chosenViseme,
    });
  }

  const bars = 48;
  const waveform: number[] = [];
  const barStep = Math.max(1, Math.floor(totalSamples / bars));
  for (let b = 0; b < bars; b++) {
    const s = b * barStep;
    const e = Math.min(totalSamples, s + barStep);
    let pk = 0;
    for (let i = s; i < e; i += Math.max(1, Math.floor(barStep / 64))) {
      const a = Math.abs(pcm[i]);
      if (a > pk) pk = a;
    }
    waveform.push(Number(Math.min(1, pk).toFixed(2)));
  }

  const lipSyncTrack: VoiceLipSyncTrack = {
    audioBlobKey: '',
    durationSec,
    sampleRateHz: lipFps,
    frames,
    waveform,
    source: 'file',
    label: clean.slice(0, 24),
  };

  return {
    blob: encodeMonoPcmToWavBlob(pcm, sampleRate),
    pcm,
    sampleRate,
    durationSec,
    lipSyncTrack,
  };
}
