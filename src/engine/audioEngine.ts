import { loadBlob, makeId, saveBlob } from './db';
import type { AudioTrackData } from '../types/studio';
import {
  analyzePCMToLipSyncTrack,
  decodeAudioBlobToMonoPCM,
  isAudioBufferSilent,
} from './filmMocapLipSync';
import { connectVoiceEffectChain, type VoiceEffectId } from './liveAudioStudio';

export { decodeAudioBlobToMonoPCM, isAudioBufferSilent };

export type MouthViseme = 'closed' | 'half' | 'wide' | 'round';

/** Minimal duck-typed PCM buffer interface usable in both Browser OfflineAudioContext & Node/Vitest */
export interface PcmBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Returns the playback rate multiplier matching a Web Audio cartoon voice filter (keeps lip-sync 100% locked!) */
export function getVoiceEffectRate(effect?: VoiceEffectId): number {
  if (effect === 'chipmunk') return 1.44;
  if (effect === 'giant') return 0.74;
  return 1.0;
}

/**
 * Renders an audio track offline with exact `volume`, `voiceEffect` (`chipmunk`/`giant`/`robot`),
 * and optional looping across `durationSec` so WebCodecs MP4 exports across Draw, Puppet, MeshWarp,
 * and Film carry 100% faithful cartoon voice FX & volume gain!
 * Falls back cleanly to deterministic Float32Array DSP in headless/Node environments without `OfflineAudioContext`.
 */
export async function renderAudioTrackOffline(opts: {
  sourceBuffer: AudioBuffer;
  durationSec: number;
  volume?: number;
  voiceEffect?: VoiceEffectId;
  loop?: boolean;
}): Promise<AudioBuffer> {
  const { sourceBuffer, loop = false } = opts;
  const volume = Math.max(0, Math.min(2, opts.volume ?? 1));
  const effect: VoiceEffectId = opts.voiceEffect ?? 'natural';
  const rate = getVoiceEffectRate(effect);
  const targetSr = sourceBuffer.sampleRate || 48_000;
  const chCount = Math.min(2, Math.max(1, sourceBuffer.numberOfChannels));
  const effectiveSrcDur = sourceBuffer.duration / rate;
  const outSec = Math.max(
    0.05,
    loop ? opts.durationSec : Math.min(opts.durationSec, effectiveSrcDur)
  );
  const outFrames = Math.max(1, Math.ceil(outSec * targetSr));

  const OfflineAC =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : typeof window !== 'undefined'
        ? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
            .webkitOfflineAudioContext
        : undefined;

  if (OfflineAC) {
    try {
      const octx = new OfflineAC(chCount, outFrames, targetSr);
      const src = octx.createBufferSource();
      src.buffer = sourceBuffer;
      src.loop = loop;
      src.playbackRate.value = rate;

      const gain = octx.createGain();
      gain.gain.value = volume;

      if (effect === 'robot') {
        const osc = octx.createOscillator();
        const modGain = octx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = 58;
        modGain.gain.value = 0.65;
        osc.connect(modGain.gain);
        src.connect(modGain);
        modGain.connect(gain);
        gain.connect(octx.destination);
        osc.start(0);
      } else if (effect === 'chipmunk' || effect === 'giant') {
        const eq = octx.createBiquadFilter();
        eq.type = effect === 'chipmunk' ? 'highshelf' : 'lowshelf';
        eq.frequency.value = effect === 'chipmunk' ? 1500 : 280;
        eq.gain.value = effect === 'chipmunk' ? 6 : 8;
        src.connect(eq);
        eq.connect(gain);
        gain.connect(octx.destination);
      } else {
        src.connect(gain);
        gain.connect(octx.destination);
      }

      src.start(0);
      return await octx.startRendering();
    } catch {
      // Fall through to deterministic software DSP below
    }
  }

  // Pure deterministic Float32Array DSP fallback (works in Vitest/Node & restricted WebViews!)
  const channels: Float32Array[] = [];
  const srcLen = sourceBuffer.length;
  for (let c = 0; c < chCount; c++) {
    const inCh = sourceBuffer.getChannelData(Math.min(c, sourceBuffer.numberOfChannels - 1));
    const outCh = new Float32Array(outFrames);
    for (let i = 0; i < outFrames; i++) {
      let sp = i * rate;
      if (loop && srcLen > 1) {
        sp = sp % srcLen;
      } else if (sp >= srcLen) {
        break;
      }
      const i0 = Math.floor(sp);
      const i1 = Math.min(srcLen - 1, i0 + 1);
      const frac = sp - i0;
      let val = (inCh[i0] * (1 - frac) + inCh[i1] * frac) * volume;
      if (effect === 'robot') {
        const ring = 0.35 + 0.65 * Math.sin((2 * Math.PI * 58 * i) / targetSr);
        val *= ring;
      }
      outCh[i] = val < -1 ? -1 : val > 1 ? 1 : val;
    }
    channels.push(outCh);
  }

  const synthetic: PcmBufferLike = {
    sampleRate: targetSr,
    length: outFrames,
    duration: outFrames / targetSr,
    numberOfChannels: chCount,
    getChannelData: (ch: number) => channels[Math.max(0, Math.min(channels.length - 1, ch))],
  };
  return synthetic as unknown as AudioBuffer;
}

/**
 * Decodes an uploaded or recorded audio Blob, extracts real waveform peaks
 * and frame-accurate Hann-LPC 6-viseme lip-sync driving.
 */
export async function analyzeAndStoreAudio(
  blob: Blob,
  name: string,
  fps: number
): Promise<AudioTrackData> {
  const { pcm: channel, sampleRate } = await decodeAudioBlobToMonoPCM(blob);
  const durationSec = Math.max(0.05, channel.length / Math.max(8000, sampleRate));

  const peakCount = 160;
  const peakStep = Math.max(1, Math.floor(channel.length / peakCount));
  const peaks: number[] = [];
  for (let i = 0; i < peakCount; i++) {
    let maxVal = 0;
    const start = i * peakStep;
    const end = Math.min(channel.length, start + peakStep);
    for (let j = start; j < end; j += Math.max(1, Math.min(4, end - start))) {
      const v = Math.abs(channel[j]);
      if (v > maxVal) maxVal = v;
    }
    peaks.push(Math.min(1, maxVal));
  }

  const totalFrames = Math.max(1, Math.ceil(durationSec * fps));
  const samplesPerFrame = Math.max(1, Math.floor(sampleRate / fps));
  const rmsRaw: number[] = [];
  let maxRms = 0.001;
  for (let f = 0; f < totalFrames; f++) {
    const start = f * samplesPerFrame;
    const end = Math.min(channel.length, start + samplesPerFrame);
    let sumSq = 0;
    let count = 0;
    for (let j = start; j < end; j += 2) {
      sumSq += channel[j] * channel[j];
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    rmsRaw.push(rms);
    if (rms > maxRms) maxRms = rms;
  }

  const silent = isAudioBufferSilent(channel);
  const rmsPerFrame = silent
    ? rmsRaw.map(() => 0)
    : rmsRaw.map((v) => Math.min(1, v / Math.max(0.08, maxRms)));
  const blobKey = await saveBlob(blob);

  const lipTrack = analyzePCMToLipSyncTrack(channel, sampleRate, {
    audioBlobKey: blobKey,
    label: name,
    source: 'file',
    fps: Math.max(8, fps),
  });
  const visemesPerFrame = Array.from({ length: totalFrames }, (_, f) => {
    const idx = Math.min(lipTrack.frames.length - 1, f);
    return lipTrack.frames[idx]?.viseme ?? 'closed';
  });

  return {
    id: makeId('aud'),
    name,
    blobKey,
    mimeType: blob.type || 'audio/webm',
    durationSec,
    peaks,
    rmsPerFrame,
    visemesPerFrame,
    volume: 0.9,
    muted: false,
  };
}

/** Maps real audio RMS amplitude & previous frame momentum into 4 cartoon mouth shapes */
export function rmsToMouthViseme(rms: number, prevRms = 0): MouthViseme {
  if (rms < 0.12) return 'closed';
  if (rms < 0.36) return 'half';
  if (rms > 0.68 && Math.abs(rms - prevRms) < 0.18) return 'round';
  return 'wide';
}

/** Lightweight synced audio player for X-Sheet playback & offline export */
export class StudioAudioPlayer {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private cleanupFx: (() => void) | null = null;
  private loadedKey: string | null = null;

  public async ensureLoaded(audio: AudioTrackData | null): Promise<void> {
    if (!audio) {
      this.buffer = null;
      this.loadedKey = null;
      return;
    }
    if (this.loadedKey === audio.blobKey && this.buffer) return;
    const blob = await loadBlob(audio.blobKey);
    if (!blob) return;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    }
    const arr = await blob.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arr.slice(0));
    this.loadedKey = audio.blobKey;
  }

  public getDecodedBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  /** Dynamically updates gain/mute during active playback without restarting the clock! */
  public setLiveVolumeAndMute(volume: number, muted: boolean): void {
    if (!this.gainNode || !this.ctx) return;
    this.gainNode.gain.setValueAtTime(muted ? 0 : Math.max(0, volume), this.ctx.currentTime);
  }

  private connectWithEffect(
    src: AudioBufferSourceNode,
    dest: AudioNode,
    volume: number,
    effect: VoiceEffectId = 'natural'
  ): () => void {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    this.gainNode = gain;

    const rate = getVoiceEffectRate(effect);
    src.playbackRate.value = rate;

    if (effect === 'robot') {
      const stopChain = connectVoiceEffectChain(ctx, src, gain, 'robot');
      gain.connect(dest);
      return stopChain;
    }
    if (effect === 'chipmunk' || effect === 'giant') {
      const eq = ctx.createBiquadFilter();
      eq.type = effect === 'chipmunk' ? 'highshelf' : 'lowshelf';
      eq.frequency.value = effect === 'chipmunk' ? 1500 : 280;
      eq.gain.value = effect === 'chipmunk' ? 6 : 8;
      src.connect(eq);
      eq.connect(gain);
      gain.connect(dest);
      return () => {
        try {
          eq.disconnect();
        } catch {
          // ignore
        }
      };
    }
    src.connect(gain);
    gain.connect(dest);
    return () => {};
  }

  public startAt(
    offsetSec: number,
    volume: number,
    muted: boolean,
    voiceEffect: VoiceEffectId = 'natural'
  ): void {
    this.stop();
    if (!this.ctx || !this.buffer || muted) return;
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    const rate = getVoiceEffectRate(voiceEffect);
    const bufOffset = Math.max(0, offsetSec * rate);
    if (bufOffset >= this.buffer.duration) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    this.cleanupFx = this.connectWithEffect(src, this.ctx.destination, volume, voiceEffect);
    src.start(0, bufOffset);
    this.source = src;
  }

  /** Plays a crisp 85ms syllable slice for real pro lip-sync audio scrubbing (respecting voiceEffect!) */
  public playScrubSlice(
    offsetSec: number,
    volume: number,
    muted: boolean,
    durationSec = 0.085,
    voiceEffect: VoiceEffectId = 'natural'
  ): void {
    this.stop();
    if (!this.ctx || !this.buffer || muted) return;
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    const rate = getVoiceEffectRate(voiceEffect);
    const bufOffset = offsetSec * rate;
    if (bufOffset < 0 || bufOffset >= this.buffer.duration) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = rate;
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.01);
    gain.gain.setValueAtTime(volume, now + Math.max(0.02, durationSec - 0.015));
    gain.gain.linearRampToValueAtTime(0.001, now + durationSec);

    src.connect(gain);
    gain.connect(this.ctx.destination);
    src.start(now, bufOffset, Math.min(durationSec * rate, this.buffer.duration - bufOffset));
    this.source = src;
    this.gainNode = gain;
  }

  /** Connects decoded audio silently into a MediaStreamDestination for background video export */
  public attachSilentExportStream(
    volume: number,
    voiceEffect: VoiceEffectId = 'natural'
  ): { stream: MediaStream; start: () => void } | null {
    if (!this.ctx || !this.buffer) return null;
    const dest = this.ctx.createMediaStreamDestination();
    return {
      stream: dest.stream,
      start: () => {
        if (!this.ctx || !this.buffer) return;
        this.stop();
        const src = this.ctx.createBufferSource();
        src.buffer = this.buffer;
        src.loop = true;
        this.cleanupFx = this.connectWithEffect(src, dest, volume, voiceEffect);
        src.start(0);
        this.source = src;
      },
    };
  }

  public stop(): void {
    if (this.cleanupFx) {
      try {
        this.cleanupFx();
      } catch {
        // ignore
      }
      this.cleanupFx = null;
    }
    if (this.source) {
      try {
        this.source.stop();
        this.source.disconnect();
      } catch {
        // already stopped
      }
      this.source = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
  }

  public dispose(): void {
    this.stop();
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

/** Real microphone voiceover recorder */
export class MicVoiceRecorder {
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  public async start(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const supportedMime =
      typeof MediaRecorder !== 'undefined'
        ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) =>
            MediaRecorder.isTypeSupported(m)
          )
        : undefined;
    this.chunks = [];
    this.recorder = supportedMime
      ? new MediaRecorder(this.mediaStream, { mimeType: supportedMime })
      : new MediaRecorder(this.mediaStream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  public stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('Recorder inactive'));
        return;
      }
      this.recorder.onstop = () => {
        const mime = this.recorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mime });
        this.cleanup();
        resolve(blob);
      };
      this.recorder.stop();
    });
  }

  public cleanup(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.recorder = null;
    this.chunks = [];
  }
}
