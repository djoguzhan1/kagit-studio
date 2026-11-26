import type { StorybookWorldId } from './cartoonMotionEngine';
import { soundEngine } from './soundEngine';
import { pickBestMediaRecorderFormat } from './videoExportEngine';

export type VoiceEffectId = 'natural' | 'chipmunk' | 'giant' | 'robot';

/**
 * Builds a pure Web Audio API cartoon voice effect processor ($0, zero latency!).
 * - natural: clean warm broadcast EQ
 * - chipmunk: sawtooth-modulated delay pitch-up (+6 semitones) + bright treble boost
 * - giant: deep delay pitch-down (-5 semitones) + warm sub-bass body
 * - robot: 58 Hz ring-modulation + tight metallic comb slapback
 */
export function connectVoiceEffectChain(
  ctx: AudioContext,
  source: AudioNode,
  dest: AudioNode,
  effect: VoiceEffectId
): () => void {
  const disposables: AudioNode[] = [];
  const stopOscs: OscillatorNode[] = [];

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
    stopOscs.push(carrier);
    disposables.push(modGain, carrierAmp, dcBias, bp, comb, combFb, outG);
  } else {
    // Real-time modulated delay pitch shifter + formant EQ (Chipmunk up / Giant down!)
    const isUp = effect === 'chipmunk';
    const delay = ctx.createDelay(0.12);
    delay.delayTime.value = 0.035;

    const lfo = ctx.createOscillator();
    lfo.type = 'sawtooth';
    lfo.frequency.value = isUp ? 9.5 : 5.2;
    const lfoDepth = ctx.createGain();
    // Negative slope shortens delay time (pitch UP); positive slope lengthens delay time (pitch DOWN)
    lfoDepth.gain.value = isUp ? -0.019 : 0.024;
    lfo.connect(lfoDepth);
    lfoDepth.connect(delay.delayTime);

    const tone = ctx.createBiquadFilter();
    tone.type = isUp ? 'highshelf' : 'lowshelf';
    tone.frequency.value = isUp ? 1400 : 320;
    tone.gain.value = isUp ? 9 : 10;

    const trim = ctx.createBiquadFilter();
    trim.type = isUp ? 'highpass' : 'lowpass';
    trim.frequency.value = isUp ? 280 : 1200;

    const outG = ctx.createGain();
    outG.gain.value = 1.15;

    source.connect(delay);
    delay.connect(tone);
    tone.connect(trim);
    trim.connect(outG);
    outG.connect(dest);

    lfo.start();
    stopOscs.push(lfo);
    disposables.push(delay, lfoDepth, tone, trim, outG);
  }

  return () => {
    for (const o of stopOscs) {
      try {
        o.stop();
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
 */
function startProceduralSoundtrack(
  ctx: AudioContext,
  dest: AudioNode,
  mode: 'dance' | 'talk' | 'film' | 'pull',
  world: StorybookWorldId
): () => void {
  const stops: (() => void)[] = [];

  if (mode === 'film' && (world === 'rainy' || world === 'meadow' || world === 'escape')) {
    // Filtered pink-ish noise bed for rain hush / breezy meadow / rolling boulder rumble
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04;
      ch[i] = last * 2.5;
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
    // Warm floating dreamy synth fifth chord
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
    // Cheerful playful 120 BPM cartoon marimba / concert bass pulse!
    const notes = mode === 'dance' ? [261.63, 329.63, 392.0, 523.25, 392.0, 329.63] : [130.81, 130.81, 164.81, 196.0];
    let step = 0;
    const timer = window.setInterval(() => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = mode === 'dance' ? 'triangle' : 'sawtooth';
      const f = notes[step % notes.length];
      osc.frequency.setValueAtTime(f, now);
      if (mode === 'film') {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 540;
        g.gain.setValueAtTime(0.08, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.connect(lp);
        lp.connect(g);
      } else {
        g.gain.setValueAtTime(0.06, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(g);
      }
      g.connect(dest);
      osc.start(now);
      osc.stop(now + 0.24);
      step++;
    }, 250);
    stops.push(() => window.clearInterval(timer));
  }

  return () => {
    for (const s of stops) s();
  };
}

/**
 * Records the live canvas WITH REAL AUDIO (foley + world soundtrack + live cartoon-FX mic!) into MP4/WebM!
 */
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

  const combined = new MediaStream(tracks);
  const chosen = pickBestMediaRecorderFormat();
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
 * Records user's mic for ~2.8s, then plays it right back through true pitch-shift
 * (Minik 1.48x / Dev 0.72x / Robot ring-mod / Natural) while streaming live RMS amplitude
 * so the drawn character lip-syncs in perfect sync with the funny voice playback!
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

  // Fallback playful cartoon chatter if mic isn't available so clicking the button ALWAYS delights!
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
