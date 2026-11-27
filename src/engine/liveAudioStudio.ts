import type { StorybookWorldId } from './cartoonMotionEngine';
import { soundEngine } from './soundEngine';
import { pickBestMediaRecorderFormat } from './videoExportEngine';

export type VoiceEffectId = 'natural' | 'chipmunk' | 'giant' | 'robot';

/**
 * Pure deterministic Dual-Delay 180°-Out-Of-Phase Raised-Cosine (Hann) Pitch-Shifter DSP!
 * Guarantees `gainA[n] + gainB[n] === 1.000000` at every sample and `gain === 0` at every
 * delay wrap boundary -> ZERO 9.5 / 5.2 Hz sawtooth reset clicks!
 */
export function processDualDelayPitchShiftPCM(
  input: Float32Array,
  sampleRate: number,
  effect: 'chipmunk' | 'giant'
): Float32Array {
  const sr = Math.max(8000, sampleRate);
  const n = input.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  const isUp = effect === 'chipmunk';
  const pitchRatio = isUp ? 1.38 : 0.72;
  const grainSec = 0.055; // 55 ms overlap-add grain window
  const grainSamples = Math.max(64, Math.round(sr * grainSec));
  const sweepSec = Math.abs(1 - pitchRatio) * grainSec;
  const baseDelaySec = 0.008;

  const readSample = (pos: number): number => {
    if (pos <= 0) return input[0];
    if (pos >= n - 1) return input[n - 1];
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    return input[i0] * (1 - frac) + input[i0 + 1] * frac;
  };

  for (let i = 0; i < n; i++) {
    const phiA = (i % grainSamples) / grainSamples;
    const phiB = ((i + (grainSamples >> 1)) % grainSamples) / grainSamples;

    const rampA = isUp ? 1 - phiA : phiA;
    const rampB = isUp ? 1 - phiB : phiB;

    const delaySamplesA = (baseDelaySec + rampA * sweepSec) * sr;
    const delaySamplesB = (baseDelaySec + rampB * sweepSec) * sr;

    // Raised-cosine (Hann) crossfade: sin^2(π φ) + sin^2(π (φ + 0.5)) === sin^2 + cos^2 === 1!
    const gainA = 0.5 * (1 - Math.cos(2 * Math.PI * phiA));
    const gainB = 0.5 * (1 - Math.cos(2 * Math.PI * phiB));

    const sigA = readSample(i - delaySamplesA);
    const sigB = readSample(i - delaySamplesB);
    out[i] = sigA * gainA + sigB * gainB;
  }
  return out;
}

/**
 * Builds a pure Web Audio API cartoon voice effect processor ($0, zero latency, zero click!):
 * - natural: clean warm broadcast EQ
 * - chipmunk / giant: Dual `DelayNode` running 180° out of phase with sample-accurate
 *   raised-cosine (Hann) gain crossfade (`gainA + gainB = 1`, `0` reset discontinuity!)
 * - robot: 58 Hz ring-modulation + tight metallic comb slapback
 */
export function connectVoiceEffectChain(
  ctx: AudioContext,
  source: AudioNode,
  dest: AudioNode,
  effect: VoiceEffectId
): () => void {
  const disposables: AudioNode[] = [];
  const stopSources: AudioScheduledSourceNode[] = [];

  if (effect === 'natural') {
    const eq = ctx.createBiquadFilter();
    eq.type = 'peaking';
    eq.frequency.value = 1800;
    eq.gain.value = 3;
    const g = ctx.createGain();
    g.gain.value = 1.05;
    source.connect(eq);
    eq.connect(g);
    g.connect(dest);
    disposables.push(eq, g);
  } else if (effect === 'robot') {
    const modGain = ctx.createGain();
    modGain.gain.value = 0;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = 58;
    const carrierAmp = ctx.createGain();
    carrierAmp.gain.value = 0.85;
    const dcBias = ctx.createConstantSource();
    dcBias.offset.value = 0.25;

    carrier.connect(carrierAmp);
    carrierAmp.connect(modGain.gain);
    dcBias.connect(modGain.gain);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1250;
    bp.Q.value = 1.1;

    const comb = ctx.createDelay(0.05);
    comb.delayTime.value = 0.011;
    const combFb = ctx.createGain();
    combFb.gain.value = 0.48;
    const outG = ctx.createGain();
    outG.gain.value = 1.25;

    source.connect(modGain);
    modGain.connect(bp);
    bp.connect(comb);
    comb.connect(combFb);
    combFb.connect(comb);
    bp.connect(outG);
    comb.connect(outG);
    outG.connect(dest);

    carrier.start();
    dcBias.start();
    stopSources.push(carrier, dcBias);
    disposables.push(modGain, carrierAmp, dcBias, bp, comb, combFb, outG);
  } else {
    // Crack-Free Dual-Delay 180° Out-of-Phase Hann-Windowed Harmonizer (Chipmunk / Giant!)
    const isUp = effect === 'chipmunk';
    const pitchRatio = isUp ? 1.38 : 0.72;
    const grainSec = 0.055;
    // Exact even sample length so phiB = (i + halfLen) % grainLen is 100% 180° opposite phiA!
    const halfLen = Math.max(32, Math.round((ctx.sampleRate * grainSec) / 2));
    const grainLen = halfLen * 2;
    const actualGrainSec = grainLen / ctx.sampleRate;
    const sweepSec = Math.abs(1 - pitchRatio) * actualGrainSec;
    const baseDelaySec = 0.008;

    const delayA = ctx.createDelay(0.15);
    const delayB = ctx.createDelay(0.15);
    delayA.delayTime.value = 0;
    delayB.delayTime.value = 0;

    const winGainA = ctx.createGain();
    const winGainB = ctx.createGain();
    winGainA.gain.value = 0;
    winGainB.gain.value = 0;

    const delayBufA = ctx.createBuffer(1, grainLen, ctx.sampleRate);
    const delayBufB = ctx.createBuffer(1, grainLen, ctx.sampleRate);
    const gainBufA = ctx.createBuffer(1, grainLen, ctx.sampleRate);
    const gainBufB = ctx.createBuffer(1, grainLen, ctx.sampleRate);

    const dArrA = delayBufA.getChannelData(0);
    const dArrB = delayBufB.getChannelData(0);
    const gArrA = gainBufA.getChannelData(0);
    const gArrB = gainBufB.getChannelData(0);

    for (let i = 0; i < grainLen; i++) {
      const phiA = i / grainLen;
      const phiB = ((i + halfLen) % grainLen) / grainLen;

      const rampA = isUp ? 1 - phiA : phiA;
      const rampB = isUp ? 1 - phiB : phiB;

      dArrA[i] = baseDelaySec + rampA * sweepSec;
      dArrB[i] = baseDelaySec + rampB * sweepSec;

      // Exact raised-cosine (Hann) crossfade: gArrA[i] + gArrB[i] === 1.0 everywhere!
      gArrA[i] = 0.5 * (1 - Math.cos(2 * Math.PI * phiA));
      gArrB[i] = 0.5 * (1 - Math.cos(2 * Math.PI * phiB));
    }

    const modDelayA = ctx.createBufferSource();
    const modDelayB = ctx.createBufferSource();
    const modGainA = ctx.createBufferSource();
    const modGainB = ctx.createBufferSource();
    modDelayA.buffer = delayBufA;
    modDelayB.buffer = delayBufB;
    modGainA.buffer = gainBufA;
    modGainB.buffer = gainBufB;
    modDelayA.loop = true;
    modDelayB.loop = true;
    modGainA.loop = true;
    modGainB.loop = true;

    modDelayA.connect(delayA.delayTime);
    modDelayB.connect(delayB.delayTime);
    modGainA.connect(winGainA.gain);
    modGainB.connect(winGainB.gain);

    const sumGain = ctx.createGain();
    sumGain.gain.value = 1.0;

    const tone = ctx.createBiquadFilter();
    tone.type = isUp ? 'highshelf' : 'lowshelf';
    tone.frequency.value = isUp ? 1450 : 310;
    tone.gain.value = isUp ? 7.5 : 8.5;

    const trim = ctx.createBiquadFilter();
    trim.type = isUp ? 'highpass' : 'lowpass';
    trim.frequency.value = isUp ? 260 : 1350;

    const outG = ctx.createGain();
    outG.gain.value = 1.15;

    source.connect(delayA);
    source.connect(delayB);
    delayA.connect(winGainA);
    delayB.connect(winGainB);
    winGainA.connect(sumGain);
    winGainB.connect(sumGain);
    sumGain.connect(tone);
    tone.connect(trim);
    trim.connect(outG);
    outG.connect(dest);

    const tStart = ctx.currentTime + 0.005;
    modDelayA.start(tStart);
    modDelayB.start(tStart);
    modGainA.start(tStart);
    modGainB.start(tStart);

    stopSources.push(modDelayA, modDelayB, modGainA, modGainB);
    disposables.push(
      delayA,
      delayB,
      winGainA,
      winGainB,
      modDelayA,
      modDelayB,
      modGainA,
      modGainB,
      sumGain,
      tone,
      trim,
      outG
    );
  }

  return () => {
    for (const s of stopSources) {
      try {
        s.stop();
      } catch {
        // ignore
      }
    }
    for (const n of disposables) {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    }
  };
}

/**
 * Generates cozy procedural soundtrack / world ambience straight into an AudioNode during video recording!
 * Uses sample-accurate `AudioContext.currentTime` lookahead scheduling instead of jittery 250ms setInterval!
 */
function startProceduralSoundtrack(
  ctx: AudioContext,
  dest: AudioNode,
  mode: 'dance' | 'talk' | 'film' | 'pull',
  world: StorybookWorldId
): () => void {
  const stops: (() => void)[] = [];

  if (mode === 'film' && (world === 'rainy' || world === 'meadow' || world === 'escape')) {
    // Equal-power crossfaded 4s pink/brown noise bed (zero loop boundary click!)
    const loopSec = 4;
    const xfadeLen = Math.floor(ctx.sampleRate * 0.8);
    const len = ctx.sampleRate * loopSec;
    const raw = new Float32Array(len + xfadeLen);
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04;
      raw[i] = last * 2.5;
    }
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < xfadeLen; i++) {
      const u = i / xfadeLen;
      ch[i] = raw[i] * Math.sin(u * Math.PI * 0.5) + raw[len + i] * Math.cos(u * Math.PI * 0.5);
    }
    for (let i = xfadeLen; i < len; i++) {
      ch[i] = raw[i];
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    const filt = ctx.createBiquadFilter();
    filt.type = world === 'escape' ? 'lowpass' : 'bandpass';
    filt.frequency.value = world === 'rainy' ? 1450 : world === 'meadow' ? 580 : 190;
    filt.Q.value = world === 'meadow' ? 1.8 : 0.8;

    const g = ctx.createGain();
    g.gain.value = world === 'rainy' ? 0.14 : world === 'escape' ? 0.22 : 0.09;

    noise.connect(filt);
    filt.connect(g);
    g.connect(dest);
    noise.start();
    stops.push(() => {
      try {
        noise.stop();
        noise.disconnect();
        filt.disconnect();
        g.disconnect();
      } catch {
        // ignore
      }
    });
  } else if (mode === 'film' && world === 'space') {
    [220, 329.63, 440].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0.035;
      osc.connect(g);
      g.connect(dest);
      osc.start();
      stops.push(() => {
        try {
          osc.stop();
          osc.disconnect();
          g.disconnect();
        } catch {
          // ignore
        }
      });
    });
  } else if (mode === 'dance' || (mode === 'film' && world === 'concert')) {
    // Sample-accurate AudioContext.currentTime lookahead scheduler (zero setInterval drift!)
    const notes =
      mode === 'dance'
        ? [261.63, 329.63, 392.0, 523.25, 392.0, 329.63]
        : [130.81, 130.81, 164.81, 196.0];
    const stepDurSec = 0.25; // exact 240 eighth-notes/min (120 BPM)
    const scheduleAheadSec = 0.2;
    let nextNoteTime = ctx.currentTime + 0.02;
    let step = 0;
    let cancelled = false;

    const scheduleNotes = () => {
      if (cancelled) return;
      while (nextNoteTime < ctx.currentTime + scheduleAheadSec) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = mode === 'dance' ? 'triangle' : 'sawtooth';
        const f = notes[step % notes.length];
        osc.frequency.setValueAtTime(f, nextNoteTime);
        if (mode === 'film') {
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(540, nextNoteTime);
          g.gain.setValueAtTime(0.08, nextNoteTime);
          g.gain.exponentialRampToValueAtTime(0.001, nextNoteTime + 0.22);
          osc.connect(lp);
          lp.connect(g);
        } else {
          g.gain.setValueAtTime(0.06, nextNoteTime);
          g.gain.exponentialRampToValueAtTime(0.001, nextNoteTime + 0.18);
          osc.connect(g);
        }
        g.connect(dest);
        osc.start(nextNoteTime);
        osc.stop(nextNoteTime + 0.24);
        nextNoteTime += stepDurSec;
        step++;
      }
    };

    scheduleNotes();
    const lookaheadTimer = window.setInterval(scheduleNotes, 60);
    stops.push(() => {
      cancelled = true;
      window.clearInterval(lookaheadTimer);
    });
  }

  return () => {
    for (const s of stops) s();
  };
}

/**
 * Synthesizes a crisp 48kHz stereo soundtrack AudioBuffer offline (zero real-time wait!)
 * so InstantAliveStage's primary WebCodecs H.264 MP4 export always carries synchronized sound!
 */
export async function renderProceduralSoundtrackOffline(
  durationSec: number,
  mode: 'dance' | 'talk' | 'film' | 'pull',
  world: StorybookWorldId,
  voiceFx: VoiceEffectId = 'natural'
): Promise<AudioBuffer | null> {
  const sr = 48_000;
  const frames = Math.max(1, Math.ceil(durationSec * sr));
  const OfflineAC =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : typeof window !== 'undefined'
        ? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
            .webkitOfflineAudioContext
        : undefined;
  if (!OfflineAC) return null;

  try {
    const octx = new OfflineAC(2, frames, sr);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);

    let pink = 0;
    let seed = 2463534242;
    const nextRand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) / 4294967295) * 2 - 1;
    };
    const ambGain =
      world === 'rainy' ? 0.055 : world === 'escape' ? 0.065 : world === 'meadow' ? 0.032 : 0.015;
    for (let i = 0; i < frames; i++) {
      const w = nextRand();
      pink = (pink + 0.045 * w) / 1.045;
      left[i] += pink * ambGain;
      right[i] += pink * ambGain * 0.94;
    }

    const notes =
      mode === 'talk'
        ? voiceFx === 'chipmunk'
          ? [587.33, 698.46, 783.99, 659.25]
          : voiceFx === 'giant'
            ? [146.83, 164.81, 130.81, 174.61]
            : [293.66, 349.23, 392.0, 329.63]
        : mode === 'film'
          ? [220.0, 261.63, 329.63, 392.0]
          : [261.63, 329.63, 392.0, 523.25, 392.0, 329.63];

    const stepSec = mode === 'talk' ? 0.22 : 0.25;
    const totalNotes = Math.floor(durationSec / stepSec);
    for (let n = 0; n < totalNotes; n++) {
      const startSample = Math.floor(n * stepSec * sr);
      const noteLen = Math.floor(0.2 * sr);
      const freq = notes[n % notes.length];
      for (let k = 0; k < noteLen && startSample + k < frames; k++) {
        const t = k / sr;
        const env = Math.exp(-t * 11) * Math.min(1, k / (0.006 * sr));
        const sig = Math.sin(2 * Math.PI * freq * t) * 0.11 * env;
        left[startSample + k] += sig;
        right[startSample + k] += sig;
      }
    }

    const buf = octx.createBuffer(2, frames, sr);
    buf.getChannelData(0).set(left);
    buf.getChannelData(1).set(right);
    const src = octx.createBufferSource();
    src.buffer = buf;
    src.connect(octx.destination);
    src.start(0);
    return await octx.startRendering();
  } catch {
    return null;
  }
}

export async function recordSoundtrackVideo(
  canvas: HTMLCanvasElement,
  opts: {
    durationMs?: number;
    mode: 'dance' | 'talk' | 'film' | 'pull';
    world: StorybookWorldId;
    micStream?: MediaStream | null;
    voiceFx?: VoiceEffectId;
  }
): Promise<{ blob: Blob; ext: string }> {
  const durationMs = opts.durationMs ?? 3000;
  const videoStream = canvas.captureStream(24);
  const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];

  let cleanupAudio = () => {};
  try {
    const ctx = soundEngine.getAudioContext();
    const masterOut = soundEngine.getMasterOutput();
    if (ctx && masterOut && typeof ctx.createMediaStreamDestination === 'function') {
      const recDest = ctx.createMediaStreamDestination();
      masterOut.connect(recDest);

      const stopAmbience = startProceduralSoundtrack(ctx, recDest, opts.mode, opts.world);
      let stopVoiceFx = () => {};
      let micNode: MediaStreamAudioSourceNode | null = null;

      if (opts.mode === 'talk' && opts.micStream) {
        micNode = ctx.createMediaStreamSource(opts.micStream);
        stopVoiceFx = connectVoiceEffectChain(ctx, micNode, recDest, opts.voiceFx ?? 'natural');
      }

      const audioTracks = recDest.stream.getAudioTracks();
      if (audioTracks.length > 0) {
        tracks.push(...audioTracks);
      }

      cleanupAudio = () => {
        stopAmbience();
        stopVoiceFx();
        if (micNode) {
          try {
            micNode.disconnect();
          } catch {
            // ignore
          }
        }
        try {
          masterOut.disconnect(recDest);
        } catch {
          // ignore
        }
      };
    }
  } catch {
    // Graceful fallback to video-only if audio capture is unavailable
  }

  const hasAudioTracks = tracks.some((tr) => tr.kind === 'audio');
  const combined = new MediaStream(tracks);
  const chosen = pickBestMediaRecorderFormat(hasAudioTracks);
  if (!chosen || typeof canvas.captureStream !== 'function') {
    cleanupAudio();
    videoStream.getTracks().forEach((tr) => tr.stop());
    throw new Error('Video kaydı bu tarayıcıda desteklenmiyor — GIF indirilebilir.');
  }

  try {
    const rec = new MediaRecorder(combined, { mimeType: chosen.mime, videoBitsPerSecond: 4_800_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    const done = new Promise<void>((res) => {
      rec.onstop = () => res();
    });
    rec.start();
    await new Promise((r) => setTimeout(r, durationMs));
    rec.stop();
    await done;
    return { blob: new Blob(chunks, { type: chosen.mime }), ext: chosen.ext };
  } finally {
    cleanupAudio();
    videoStream.getTracks().forEach((tr) => tr.stop());
  }
}

/**
 * Talking-Tom style instant 2.8s Voice Echo ($0, pure Web Audio API!):
 * Records user's mic for ~2.8s, then plays it right back through crack-free dual-delay pitch-shift
 * or clean playbackRate / ring-mod while streaming live RMS amplitude for character lip-sync!
 */
export async function recordAndEchoVoiceFx(opts: {
  micStream: MediaStream | null;
  effect: VoiceEffectId;
  recordMs?: number;
  onPhaseChange: (phase: 'recording' | 'playing' | 'idle') => void;
  onPlaybackLevel: (amp: number) => void;
}): Promise<void> {
  const ctx = soundEngine.getAudioContext();
  const master = soundEngine.getMasterOutput();
  if (!ctx || !master) {
    opts.onPhaseChange('idle');
    return;
  }

  if (!opts.micStream || typeof MediaRecorder === 'undefined') {
    opts.onPhaseChange('playing');
    const baseFreq =
      opts.effect === 'chipmunk' ? 680 : opts.effect === 'giant' ? 145 : opts.effect === 'robot' ? 240 : 340;
    const syllables = [1, 1.18, 0.92, 1.25, 1.05, 0.88];
    const startMs = performance.now();
    for (let i = 0; i < syllables.length; i++) {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = opts.effect === 'robot' ? 'sawtooth' : opts.effect === 'giant' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(baseFreq * syllables[i], now);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * syllables[i] * 1.15, now + 0.14);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.19);
      const tEnd = startMs + (i + 1) * 210;
      while (performance.now() < tEnd) {
        opts.onPlaybackLevel(0.75);
        await new Promise((r) => setTimeout(r, 32));
      }
      opts.onPlaybackLevel(0.1);
      await new Promise((r) => setTimeout(r, 40));
    }
    opts.onPlaybackLevel(0);
    opts.onPhaseChange('idle');
    return;
  }

  try {
    opts.onPhaseChange('recording');
    const audioStream = new MediaStream(opts.micStream.getAudioTracks());
    const rec = new MediaRecorder(audioStream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    const stopped = new Promise<void>((res) => {
      rec.onstop = () => res();
    });
    rec.start();
    await new Promise((r) => setTimeout(r, opts.recordMs ?? 2600));
    if (rec.state !== 'inactive') rec.stop();
    await stopped;

    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    const arr = await blob.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arr);

    opts.onPhaseChange('playing');
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.playbackRate.value =
      opts.effect === 'chipmunk' ? 1.48 : opts.effect === 'giant' ? 0.72 : 1.0;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const data = new Uint8Array(analyser.frequencyBinCount);

    let cleanupChain = () => {};
    if (opts.effect === 'robot') {
      cleanupChain = connectVoiceEffectChain(ctx, src, analyser, 'robot');
    } else {
      src.connect(analyser);
    }
    analyser.connect(master);

    let playing = true;
    const playDone = new Promise<void>((res) => {
      src.onended = () => {
        playing = false;
        res();
      };
    });
    src.start();

    const pump = () => {
      if (!playing) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      opts.onPlaybackLevel(Math.min(1, Math.sqrt(sum / data.length) * 5.8));
      requestAnimationFrame(pump);
    };
    pump();

    await playDone;
    cleanupChain();
    try {
      analyser.disconnect();
    } catch {
      // ignore
    }
  } catch {
    // Graceful cleanup if decode fails on silent virtual mic
  } finally {
    opts.onPlaybackLevel(0);
    opts.onPhaseChange('idle');
  }
}
