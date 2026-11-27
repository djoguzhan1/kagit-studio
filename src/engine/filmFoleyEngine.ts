import type { FilmProjectGraph, WeatherKind, WorldSetId } from '../types/film';
import { loadBlob } from './db';
import { evaluateCharacterPose25D } from './film25dEngine';
import { decodeAudioBlobToMonoPCM } from './filmMocapLipSync';
import type { PcmBufferLike } from './audioEngine';

export type ExtendedWorldSetId =
  | WorldSetId
  | 'cosmic-nebula'
  | 'concert-stage'
  | 'canyon-chase'
  | 'space';

export type FilmAudioMixMode = 'full' | 'voice-only' | 'muted';

export interface WorldSoundProfile {
  id: string;
  /** Footstep duration (s), bandpass center (Hz), Q, envelope decay, heel thud start/end (Hz) */
  footstep: {
    durSec: number;
    bpFreqHz: number;
    bpQ: number;
    decay: number;
    thudStartHz: number;
    thudEndHz: number;
    splashMix: number;
  };
  /** Ambient filter cutoff & character */
  ambience: {
    filterType: BiquadFilterType;
    cutoffHz: number;
    q: number;
    gainMul: number;
  };
  /** 4-chord cinematic progression (4 voices per chord in Hz) + warm bell arpeggio notes */
  chords: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ];
  arpeggioHz: [number, number, number, number];
  padCutoffHz: number;
}

export const WORLD_SOUND_PROFILES: Record<string, WorldSoundProfile> = {
  'rainy-alley': {
    id: 'rainy-alley',
    footstep: {
      durSec: 0.088,
      bpFreqHz: 2150,
      bpQ: 1.15,
      decay: 5.4,
      thudStartHz: 122,
      thudEndHz: 48,
      splashMix: 0.45,
    },
    ambience: { filterType: 'bandpass', cutoffHz: 1480, q: 0.68, gainMul: 1.0 },
    // Dm9 -> Bbmaj7 -> Gm9 -> Asus4
    chords: [
      [146.83, 220.0, 261.63, 329.63],
      [116.54, 174.61, 220.0, 293.66],
      [196.0, 233.08, 293.66, 392.0],
      [110.0, 220.0, 293.66, 329.63],
    ],
    arpeggioHz: [587.33, 659.25, 440.0, 523.25],
    padCutoffHz: 720,
  },
  'golden-hill': {
    id: 'golden-hill',
    footstep: {
      durSec: 0.072,
      bpFreqHz: 720,
      bpQ: 1.65,
      decay: 7.4,
      thudStartHz: 96,
      thudEndHz: 44,
      splashMix: 0.08,
    },
    ambience: { filterType: 'lowpass', cutoffHz: 560, q: 1.05, gainMul: 0.85 },
    // Fmaj9 -> Cmaj7 -> Gm9 -> Bbmaj7 (warm pastoral sunset)
    chords: [
      [174.61, 220.0, 261.63, 392.0],
      [130.81, 196.0, 246.94, 329.63],
      [196.0, 233.08, 293.66, 349.23],
      [116.54, 174.61, 220.0, 293.66],
    ],
    arpeggioHz: [523.25, 659.25, 587.33, 440.0],
    padCutoffHz: 840,
  },
  'moonlit-forest': {
    id: 'moonlit-forest',
    footstep: {
      durSec: 0.068,
      bpFreqHz: 1080,
      bpQ: 1.9,
      decay: 8.2,
      thudStartHz: 106,
      thudEndHz: 46,
      splashMix: 0.14,
    },
    ambience: { filterType: 'lowpass', cutoffHz: 410, q: 1.2, gainMul: 0.78 },
    // Dm9 -> Gm9 -> Bbmaj7 -> Asus4 (nocturnal enchanted forest)
    chords: [
      [146.83, 220.0, 261.63, 329.63],
      [196.0, 233.08, 293.66, 392.0],
      [116.54, 174.61, 220.0, 293.66],
      [110.0, 220.0, 293.66, 329.63],
    ],
    arpeggioHz: [440.0, 523.25, 587.33, 659.25],
    padCutoffHz: 660,
  },
  'cosmic-nebula': {
    id: 'cosmic-nebula',
    footstep: {
      durSec: 0.095,
      bpFreqHz: 1580,
      bpQ: 2.45,
      decay: 6.2,
      thudStartHz: 88,
      thudEndHz: 38,
      splashMix: 0.25,
    },
    ambience: { filterType: 'bandpass', cutoffHz: 620, q: 1.6, gainMul: 0.72 },
    // Dmaj9 -> Bm9 -> Gmaj7#11 -> Asus4 (ethereal Lydian cosmos)
    chords: [
      [146.83, 220.0, 277.18, 369.99],
      [123.47, 185.0, 220.0, 329.63],
      [196.0, 246.94, 293.66, 369.99],
      [110.0, 220.0, 293.66, 329.63],
    ],
    arpeggioHz: [587.33, 739.99, 659.25, 493.88],
    padCutoffHz: 920,
  },
  'concert-stage': {
    id: 'concert-stage',
    footstep: {
      durSec: 0.062,
      bpFreqHz: 860,
      bpQ: 2.6,
      decay: 9.2,
      thudStartHz: 144,
      thudEndHz: 58,
      splashMix: 0.05,
    },
    ambience: { filterType: 'lowpass', cutoffHz: 480, q: 0.9, gainMul: 0.68 },
    // Am9 -> Fmaj7 -> Cmaj9 -> G6 (warm theatrical stage lights)
    chords: [
      [110.0, 196.0, 246.94, 261.63],
      [174.61, 220.0, 261.63, 329.63],
      [130.81, 196.0, 246.94, 293.66],
      [196.0, 246.94, 293.66, 329.63],
    ],
    arpeggioHz: [523.25, 659.25, 783.99, 587.33],
    padCutoffHz: 880,
  },
  'canyon-chase': {
    id: 'canyon-chase',
    footstep: {
      durSec: 0.076,
      bpFreqHz: 1420,
      bpQ: 1.35,
      decay: 7.0,
      thudStartHz: 112,
      thudEndHz: 45,
      splashMix: 0.18,
    },
    ambience: { filterType: 'bandpass', cutoffHz: 780, q: 1.1, gainMul: 0.88 },
    // Dm9 -> C6 -> Bbmaj7 -> Asus4 (red canyon western-cinema pulse)
    chords: [
      [146.83, 220.0, 261.63, 329.63],
      [130.81, 196.0, 220.0, 329.63],
      [116.54, 174.61, 220.0, 293.66],
      [110.0, 220.0, 293.66, 329.63],
    ],
    arpeggioHz: [587.33, 523.25, 440.0, 392.0],
    padCutoffHz: 790,
  },
};

export function getWorldSoundProfile(setId?: ExtendedWorldSetId | string): WorldSoundProfile {
  if (setId === 'space') return WORLD_SOUND_PROFILES['cosmic-nebula'];
  if (setId && WORLD_SOUND_PROFILES[setId]) return WORLD_SOUND_PROFILES[setId];
  return WORLD_SOUND_PROFILES['rainy-alley'];
}

/**
 * Generates an 8.0-second seamless equal-power (`cos/sin`) crossfaded ambience buffer!
 * Includes pink/brown filtered texture, slow wind gust breathing, and individual resonant
 * water-droplet pings when `weather === 'rain'` — with ZERO loop boundary click!
 */
export function buildSeamlessAmbienceMonoPCM(
  sampleRate: number,
  weather: WeatherKind
): Float32Array {
  const sr = Math.max(8000, Math.round(sampleRate));
  const loopSec = 8.0;
  const xfadeSec = 1.6;
  const len = Math.floor(sr * loopSec);
  const xfadeLen = Math.floor(sr * xfadeSec);
  const rawLen = len + xfadeLen;
  const raw = new Float32Array(rawLen);

  let seed = 0x51f2a9c3;
  const nextWhite = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967295) * 2 - 1;
  };

  let brown = 0;
  let pink0 = 0;
  let pink1 = 0;
  for (let i = 0; i < rawLen; i++) {
    const t = i / sr;
    const w = nextWhite();
    brown = 0.994 * brown + w * 0.055;
    pink0 = 0.955 * pink0 + w * 0.14;
    pink1 = 0.78 * pink1 + w * 0.24;

    // Gentle continuous wind breathing wave (periodic over 8.0s)
    const gust = 0.8 + 0.2 * Math.sin((2 * Math.PI * t) / loopSec);
    if (weather === 'rain') {
      raw[i] = (pink1 * 0.42 + pink0 * 0.36 + brown * 0.22) * gust;
    } else if (weather === 'wind-leaves') {
      const rustle = 0.75 + 0.25 * Math.sin((4 * Math.PI * t) / loopSec + 0.7);
      raw[i] = (brown * 0.68 + pink0 * 0.32) * gust * rustle;
    } else {
      raw[i] = (brown * 0.8 + pink0 * 0.2) * gust * 0.85;
    }
  }

  // Add discrete resonant water-droplet pings on wet cobblestones when weather === 'rain'
  if (weather === 'rain') {
    const dropCount = 30;
    for (let d = 0; d < dropCount; d++) {
      const pos = Math.floor(((d + 0.37) / dropCount) * rawLen);
      const baseHz = 1050 + ((d * 397) % 1350);
      const dropSamples = Math.floor(0.032 * sr);
      let phase = 0;
      for (let k = 0; k < dropSamples && pos + k < rawLen; k++) {
        const u = k / dropSamples;
        const chirpHz = baseHz * (1 + u * 0.22); // upward bubble-cavity pitch chirp!
        phase += (2 * Math.PI * chirpHz) / sr;
        const env = Math.exp(-u * 6.5) * Math.min(1, k / (0.002 * sr));
        raw[pos + k] += Math.sin(phase) * 0.14 * env;
      }
    }
  }

  // Fold tail [len .. len + xfadeLen) onto head [0 .. xfadeLen) using equal-power sin/cos crossfade!
  const out = new Float32Array(len);
  for (let i = 0; i < xfadeLen; i++) {
    const u = i / xfadeLen;
    const gainHead = Math.sin(u * Math.PI * 0.5);
    const gainTail = Math.cos(u * Math.PI * 0.5);
    out[i] = raw[i] * gainHead + raw[len + i] * gainTail;
  }
  for (let i = xfadeLen; i < len; i++) {
    out[i] = raw[i];
  }
  return out;
}

/**
 * Pure Web Audio API Cinema Soundstage & Procedural Foley Engine.
 * Zero external audio assets — synthesizes synchronized:
 * - 8s equal-power crossfaded weather ambience + individual rain droplets & wind hush
 * - 6-world surface-aware Foot-Contact Foley with ±14% pitch & filter cutoff randomization
 * - Delayed dramatic Thunder rolls on lightning flashes & transition cloth whooshes
 * - World-aware 4-chord cinematic pad (`Dm9 -> Bbmaj7 -> Gm9 -> Asus4`) + soft arpeggio + `-8 dB` dialogue ducking
 */
export class FilmFoleyEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  private ambientWeather: WeatherKind = 'none';
  private activeWorldSet: ExtendedWorldSetId = 'rainy-alley';
  private musicOscs: OscillatorNode[] = [];
  private musicGain: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private musicTimer: number | null = null;
  private voiceSource: AudioBufferSourceNode | null = null;
  private voiceGain: GainNode | null = null;
  private voiceCache = new Map<string, AudioBuffer>();
  private activeVoiceKey: string | null = null;
  private running = false;
  private readonly monitorToSpeakers: boolean;

  constructor(opts?: { monitorToSpeakers?: boolean }) {
    this.monitorToSpeakers = opts?.monitorToSpeakers ?? true;
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.85;
      if (this.monitorToSpeakers) {
        this.masterGain.connect(this.ctx.destination);
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public setMasterMuted(muted: boolean): void {
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(muted ? 0.0001 : 0.85, this.ctx.currentTime, 0.04);
  }

  /** Connects all procedural foley into a MediaStreamDestination for fallback stream recording */
  public attachStreamDestination(): MediaStream | null {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return null;
    const dest = ctx.createMediaStreamDestination();
    this.masterGain.connect(dest);
    return dest.stream;
  }

  public startAmbience(
    weather: WeatherKind,
    intensity: number,
    musicBed: boolean,
    setId: ExtendedWorldSetId = 'rainy-alley'
  ): void {
    this.stop();
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    this.running = true;
    this.ambientWeather = weather;
    this.activeWorldSet = setId;

    if (weather !== 'none' && intensity > 0.05) {
      this.spawnAmbientNoise(ctx, weather, intensity, setId);
    }

    if (musicBed) {
      this.spawnMusicPad(ctx, setId);
    }
  }

  /** Smoothly updates weather intensity, world set, or music toggle WITHOUT popping! */
  public updateAmbience(
    weather: WeatherKind,
    intensity: number,
    musicBed: boolean,
    setId?: ExtendedWorldSetId
  ): void {
    const nextSet = setId ?? this.activeWorldSet;
    if (!this.running) {
      this.startAmbience(weather, intensity, musicBed, nextSet);
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const worldChanged = nextSet !== this.activeWorldSet;
    this.activeWorldSet = nextSet;
    const prof = getWorldSoundProfile(nextSet);

    if (weather === 'none' || intensity <= 0.05) {
      if (this.ambientGain) {
        this.ambientGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.12);
      }
    } else if (weather !== this.ambientWeather || !this.ambientSource) {
      this.stopAmbientOnly();
      this.ambientWeather = weather;
      this.spawnAmbientNoise(ctx, weather, intensity, nextSet);
    } else if (this.ambientGain) {
      const targetGain =
        (weather === 'rain' ? 0.11 : 0.075) * Math.max(0.25, intensity) * prof.ambience.gainMul;
      this.ambientGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.15);
    }

    if (musicBed && !this.musicGain) {
      this.spawnMusicPad(ctx, nextSet);
    } else if (!musicBed && this.musicGain) {
      this.musicGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.12);
    } else if (musicBed && this.musicGain) {
      if (worldChanged && this.musicFilter) {
        this.musicFilter.frequency.setTargetAtTime(prof.padCutoffHz, ctx.currentTime, 0.25);
      }
      this.musicGain.gain.setTargetAtTime(0.038, ctx.currentTime, 0.14);
    }
  }

  private stopAmbientOnly(): void {
    if (this.ambientSource) {
      try {
        this.ambientSource.stop();
      } catch {
        // ignore
      }
      this.ambientSource.disconnect();
      this.ambientSource = null;
    }
    if (this.ambientGain) {
      this.ambientGain.disconnect();
      this.ambientGain = null;
    }
  }

  private spawnAmbientNoise(
    ctx: AudioContext,
    weather: WeatherKind,
    intensity: number,
    setId: ExtendedWorldSetId
  ): void {
    if (!this.masterGain) return;
    const prof = getWorldSoundProfile(setId);
    const pcm = buildSeamlessAmbienceMonoPCM(ctx.sampleRate, weather);
    const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buf.getChannelData(0).set(pcm);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = weather === 'rain' ? 'bandpass' : prof.ambience.filterType;
    filter.frequency.value =
      weather === 'rain'
        ? 1480
        : weather === 'wind-leaves'
          ? Math.max(480, prof.ambience.cutoffHz)
          : prof.ambience.cutoffHz;
    filter.Q.value = weather === 'rain' ? 0.65 : prof.ambience.q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(
      (weather === 'rain' ? 0.11 : 0.075) * Math.max(0.25, intensity) * prof.ambience.gainMul,
      ctx.currentTime + 0.35
    );

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start();
    this.ambientSource = src;
    this.ambientGain = gain;
  }

  private spawnMusicPad(ctx: AudioContext, setId: ExtendedWorldSetId): void {
    if (!this.masterGain) return;
    const prof = getWorldSoundProfile(setId);

    const mGain = ctx.createGain();
    mGain.gain.setValueAtTime(0.001, ctx.currentTime);
    mGain.gain.linearRampToValueAtTime(0.038, ctx.currentTime + 0.55);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = prof.padCutoffHz;

    mGain.connect(lp);
    lp.connect(this.masterGain);

    const chord0 = prof.chords[0];
    this.musicOscs = chord0.map((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(f, ctx.currentTime);
      osc.detune.value = (idx - 1.5) * 4.5;
      osc.connect(mGain);
      osc.start();
      return osc;
    });
    this.musicGain = mGain;
    this.musicFilter = lp;

    // AudioContext.currentTime lookahead scheduler for 4-chord walk + warm arpeggio bells
    let nextBeatTime = ctx.currentTime + 0.15;
    let beatIdx = 0;
    const beatDur = 0.62; // 4 beats = 2.48s per chord -> 9.92s full 4-chord cycle

    const scheduleAhead = () => {
      if (!this.running || !this.ctx || !this.musicGain) return;
      const curProf = getWorldSoundProfile(this.activeWorldSet);
      while (nextBeatTime < this.ctx.currentTime + 0.35) {
        const chordIdx = Math.floor(beatIdx / 4) % 4;
        const subBeat = beatIdx % 4;
        if (subBeat === 0 && this.musicOscs.length === 4) {
          const targetChord = curProf.chords[chordIdx];
          for (let v = 0; v < 4; v++) {
            this.musicOscs[v].frequency.setTargetAtTime(targetChord[v], nextBeatTime, 0.22);
          }
        }
        // Soft delicate bell arpeggio on beats 0 & 2
        if (subBeat === 0 || subBeat === 2) {
          const arpNote = curProf.arpeggioHz[(chordIdx + (subBeat >> 1)) % 4];
          const bell = this.ctx.createOscillator();
          const bg = this.ctx.createGain();
          bell.type = 'sine';
          bell.frequency.setValueAtTime(arpNote, nextBeatTime);
          bg.gain.setValueAtTime(0.0001, nextBeatTime);
          bg.gain.linearRampToValueAtTime(0.22, nextBeatTime + 0.03);
          bg.gain.exponentialRampToValueAtTime(0.0008, nextBeatTime + 0.85);
          bell.connect(bg);
          bg.connect(this.musicGain);
          bell.start(nextBeatTime);
          bell.stop(nextBeatTime + 0.9);
        }
        nextBeatTime += beatDur;
        beatIdx++;
      }
    };

    scheduleAhead();
    if (typeof window !== 'undefined') {
      this.musicTimer = window.setInterval(scheduleAhead, 120);
    }
  }

  /** Auto-ducks cinema music by -8 dB (0.398x) whenever character dialogue plays */
  public setDialogueDucking(speaking: boolean): void {
    if (!this.ctx || !this.musicGain) return;
    // -8 dB = 10^(-8/20) ≈ 0.3981 -> 0.038 * 0.3981 ≈ 0.0151
    const target = speaking ? 0.0151 : 0.038;
    this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
  }

  /** Exact-frame Foot-Contact Foley sound adapted to all 6 worlds with ±14% pitch & cutoff randomization! */
  public triggerFootstep(setId: ExtendedWorldSetId, energy = 0.8): void {
    if (!this.running) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;
    const prof = getWorldSoundProfile(setId).footstep;

    // ±14% organic per-step pitch & filter cutoff randomization
    const pitchJitter = 1 + (Math.random() * 2 - 1) * 0.14;
    const cutoffJitter = 1 + (Math.random() * 2 - 1) * 0.14;

    const dur = prof.durSec;
    const len = Math.max(32, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.exp((-i / len) * prof.decay);
      d[i] = (Math.random() * 2 - 1) * env;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitchJitter;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(prof.bpFreqHz * cutoffJitter, now);
    bp.Q.value = prof.bpQ;

    const clampedEnergy = Math.max(0.3, Math.min(1.2, energy));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.095 * clampedEnergy, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.masterGain);
    src.start(now);

    // Surface-tuned low heel thud
    const thud = ctx.createOscillator();
    const tg = ctx.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(prof.thudStartHz * pitchJitter, now);
    thud.frequency.exponentialRampToValueAtTime(Math.max(28, prof.thudEndHz * pitchJitter), now + 0.048);
    tg.gain.setValueAtTime(0.068 * clampedEnergy, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.052);
    thud.connect(tg);
    tg.connect(this.masterGain);
    thud.start(now);
    thud.stop(now + 0.056);
  }

  /** Rolling dramatic thunder rumble triggered after lightning flash */
  public triggerThunder(): void {
    if (!this.running) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;
    const dur = 1.65;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const crack = Math.exp(-t * 12) * 0.8;
      const rumble = Math.sin(t * Math.PI) * Math.exp(-t * 1.9);
      const n = Math.random() * 2 - 1;
      lp = lp * 0.92 + n * 0.08;
      d[i] = lp * (crack + rumble) * 1.6;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(480, now);
    filter.frequency.exponentialRampToValueAtTime(110, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(now);
  }

  /** Subtle cloth swoosh / camera transition accent */
  public triggerWhoosh(): void {
    if (!this.running) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;
    const dur = 0.16;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.sin((i / len) * Math.PI);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(420, now);
    bp.frequency.exponentialRampToValueAtTime(1350, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.07, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.masterGain);
    src.start(now);
  }

  /** Plays a recorded, synthesized, or uploaded character voice track cleanly through masterGain */
  public async playVoiceBlob(key: string, blob: Blob, offsetSec = 0): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    this.stopVoice();
    this.activeVoiceKey = key;

    let decoded = this.voiceCache.get(key);
    if (!decoded) {
      try {
        const arr = await blob.arrayBuffer();
        decoded = await ctx.decodeAudioData(arr.slice(0));
        this.voiceCache.set(key, decoded);
      } catch {
        return;
      }
    }
    if (this.activeVoiceKey !== key || offsetSec >= decoded.duration - 0.04) return;

    const src = ctx.createBufferSource();
    src.buffer = decoded;
    const vg = ctx.createGain();
    vg.gain.value = 1.0;
    src.connect(vg);
    vg.connect(this.masterGain);
    src.start(ctx.currentTime, Math.max(0, offsetSec));
    this.voiceSource = src;
    this.voiceGain = vg;
  }

  public stopVoice(): void {
    this.activeVoiceKey = null;
    if (this.voiceSource) {
      try {
        this.voiceSource.stop();
      } catch {
        // ignore
      }
      this.voiceSource.disconnect();
      this.voiceSource = null;
    }
    if (this.voiceGain) {
      this.voiceGain.disconnect();
      this.voiceGain = null;
    }
  }

  public stop(): void {
    this.running = false;
    this.stopVoice();
    this.stopAmbientOnly();
    if (this.musicTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    for (const osc of this.musicOscs) {
      try {
        osc.stop();
      } catch {
        // ignore
      }
      osc.disconnect();
    }
    this.musicOscs = [];
    if (this.musicGain) {
      this.musicGain.disconnect();
      this.musicGain = null;
    }
    if (this.musicFilter) {
      this.musicFilter.disconnect();
      this.musicFilter = null;
    }
    this.ambientWeather = 'none';
  }

  public dispose(): void {
    this.stop();
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.masterGain = null;
    }
  }
}

// ============================================================================
// DETERMINISTIC SAMPLE-ACCURATE OFFLINE SOUNDSTAGE MIXER FOR MP4 EXPORT
// ============================================================================

export interface RenderFilmSoundtrackOfflineOptions {
  graph: FilmProjectGraph;
  totalDuration?: number;
  sampleRate?: number;
  audioMixMode?: FilmAudioMixMode;
  includeMusic?: boolean;
  loadVoiceBlob?: (blobKey: string) => Promise<Blob | null>;
}

/**
 * Sample-accurate offline stereo soundstage renderer (`48 kHz` default):
 * Mixes all shots' dialogue voices, exact `evaluateCharacterPose25D` `footContact` surface footsteps
 * (with ±14% pitch/cutoff variation), transition whooshes, lightning thunder rolls, 8s seamless
 * weather ambience, `-8 dB` (`0.398x`) dialogue auto-ducking, and the 4-chord cinematic progression
 * into a single stereo `AudioBuffer` for WebCodecs H.264 MP4 encoding!
 */
export async function renderFilmSoundtrackOffline(
  opts: RenderFilmSoundtrackOfflineOptions
): Promise<AudioBuffer | null> {
  const mixMode: FilmAudioMixMode = opts.audioMixMode ?? 'full';
  if (mixMode === 'muted') return null;

  const { graph } = opts;
  const sr = Math.max(16_000, Math.round(opts.sampleRate ?? 48_000));
  const computedDur = graph.shots.reduce((s, sh) => s + Math.max(0.5, sh.durationSec), 0);
  const totalSec = Math.max(0.5, opts.totalDuration ?? computedDur);
  const totalFrames = Math.max(1, Math.ceil(totalSec * sr));

  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const speakingGate = new Uint8Array(totalFrames); // 1 whenever character voice/dialogue is active

  const voiceLoader = opts.loadVoiceBlob ?? loadBlob;
  const worldProf = getWorldSoundProfile(graph.world.setId);

  // Deterministic PRNG for repeatable offline foley rendering
  let seed = 0x9e3779b9;
  const nextRand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967295) * 2 - 1;
  };

  // Helper: 2-pole resonator step for crisp surface bandpass footsteps & whooshes
  const synthesizeFootstepAt = (startSample: number, panX: number, stepIdx: number) => {
    const fp = worldProf.footstep;
    const jitterA = (((stepIdx * 73 + 19) % 29) / 14 - 1) * 0.14; // deterministic ±14%
    const jitterB = (((stepIdx * 41 + 7) % 23) / 11 - 1) * 0.14;
    const pitchMul = 1 + jitterA;
    const cutoffHz = fp.bpFreqHz * (1 + jitterB);

    const len = Math.floor((fp.durSec / pitchMul) * sr);
    const r = Math.exp((-Math.PI * (cutoffHz / Math.max(0.5, fp.bpQ))) / sr);
    const bCoef = 2 * r * Math.cos((2 * Math.PI * Math.min(sr * 0.45, cutoffHz)) / sr);
    const cCoef = -(r * r);
    const aCoef = (1 - r) * 0.65;

    let y1 = 0,
      y2 = 0;
    let thudPhase = 0;
    const pan = Math.max(-0.65, Math.min(0.65, (panX - 0.5) * 1.1));
    const gainL = Math.cos(((pan + 1) * Math.PI) / 4) * 1.35;
    const gainR = Math.sin(((pan + 1) * Math.PI) / 4) * 1.35;

    for (let k = 0; k < len && startSample + k < totalFrames; k++) {
      const u = k / len;
      const env = Math.exp(-u * fp.decay);
      const x = nextRand() * env;
      const bpOut = aCoef * x + bCoef * y1 + cCoef * y2;
      y2 = y1;
      y1 = bpOut;

      const tSec = k / sr;
      let thud = 0;
      if (tSec < 0.052) {
        const curHz =
          fp.thudStartHz * pitchMul * (fp.thudEndHz / fp.thudStartHz) ** (tSec / 0.052);
        thudPhase += (2 * Math.PI * curHz) / sr;
        thud = Math.sin(thudPhase) * Math.exp(-tSec * 58) * 0.085;
      }

      const sig = bpOut * 0.16 + thud;
      left[startSample + k] += sig * gainL;
      right[startSample + k] += sig * gainR;
    }
  };

  const synthesizeWhooshAt = (startSample: number) => {
    const dur = 0.16;
    const len = Math.floor(dur * sr);
    let y1 = 0,
      y2 = 0;
    for (let k = 0; k < len && startSample + k < totalFrames; k++) {
      const u = k / len;
      const freq = 420 * (1350 / 420) ** u;
      const r = Math.exp((-Math.PI * 520) / sr);
      const bCoef = 2 * r * Math.cos((2 * Math.PI * freq) / sr);
      const cCoef = -(r * r);
      const aCoef = (1 - r) * 0.5;
      const env = Math.sin(u * Math.PI) * 0.09;
      const x = nextRand() * env;
      const y = aCoef * x + bCoef * y1 + cCoef * y2;
      y2 = y1;
      y1 = y;
      left[startSample + k] += y * 0.95;
      right[startSample + k] += y * 1.05;
    }
  };

  const synthesizeThunderAt = (startSample: number) => {
    const dur = 1.65;
    const len = Math.floor(dur * sr);
    let lpL = 0,
      lpR = 0;
    for (let k = 0; k < len && startSample + k < totalFrames; k++) {
      const u = k / len;
      const crack = Math.exp(-u * 12) * 0.85;
      const rumble = Math.sin(u * Math.PI) * Math.exp(-u * 1.9);
      lpL = lpL * 0.93 + nextRand() * 0.07;
      lpR = lpR * 0.925 + nextRand() * 0.075;
      const env = (crack + rumble) * 0.34;
      left[startSample + k] += lpL * env;
      right[startSample + k] += lpR * env;
    }
  };

  // 1. Walk shots: mix decoded dialogue voices, footsteps on exact footContact, whooshes & thunder!
  let shotOffsetSec = 0;
  let footstepCounter = 0;

  for (let sIdx = 0; sIdx < graph.shots.length; sIdx++) {
    const sh = graph.shots[sIdx];
    const shDur = Math.max(0.5, sh.durationSec);
    const shotStartSample = Math.floor(shotOffsetSec * sr);

    if (sIdx > 0) {
      synthesizeWhooshAt(Math.max(0, shotStartSample - Math.floor(0.04 * sr)));
    }

    if (typeof sh.lightningAtSec === 'number' && sh.lightningAtSec >= 0) {
      const thSample = Math.floor((shotOffsetSec + sh.lightningAtSec + 0.08) * sr);
      if (thSample < totalFrames) synthesizeThunderAt(thSample);
    }

    // Decode & mix shot dialogue voice blob if present
    let mixedRealVoice = false;
    if (sh.voiceTrack?.audioBlobKey) {
      try {
        const vb = await voiceLoader(sh.voiceTrack.audioBlobKey);
        if (vb) {
          const decoded = await decodeAudioBlobToMonoPCM(vb);
          const maxOutSamples = Math.min(
            Math.floor(shDur * sr),
            totalFrames - shotStartSample
          );
          const ratio = decoded.sampleRate / sr;
          for (let i = 0; i < maxOutSamples; i++) {
            const sp = i * ratio;
            const i0 = Math.floor(sp);
            if (i0 >= decoded.pcm.length) break;
            const i1 = Math.min(decoded.pcm.length - 1, i0 + 1);
            const frac = sp - i0;
            const v = decoded.pcm[i0] * (1 - frac) + decoded.pcm[i1] * frac;
            left[shotStartSample + i] += v * 0.92;
            right[shotStartSample + i] += v * 0.92;
            if (Math.abs(v) > 0.025) {
              speakingGate[shotStartSample + i] = 1;
            }
          }
          mixedRealVoice = true;
        }
      } catch {
        mixedRealVoice = false;
      }
    }

    // Sample exact pose trajectory at 48 Hz to capture every footContact & text-dialogue ducking window
    const poseHz = 48;
    const poseSteps = Math.max(4, Math.ceil(shDur * poseHz));
    let wasFootContact = false;
    for (let p = 0; p < poseSteps; p++) {
      const localSec = (p / poseHz);
      if (localSec >= shDur) break;
      const pose = evaluateCharacterPose25D(sh, localSec, graph.world.horizonY);
      const globalSample = Math.min(totalFrames - 1, Math.floor((shotOffsetSec + localSec) * sr));

      if (pose.footContact && !wasFootContact) {
        synthesizeFootstepAt(globalSample, pose.groundX, footstepCounter++);
      }
      wasFootContact = pose.footContact;

      if (!mixedRealVoice && sh.dialogue.trim().length > 0 && pose.mouthOpen > 0.08) {
        const span = Math.ceil(sr / poseHz);
        for (let k = 0; k < span && globalSample + k < totalFrames; k++) {
          speakingGate[globalSample + k] = 1;
        }
      }
    }

    shotOffsetSec += shDur;
  }

  // 2. Smooth `-8 dB` (0.3981x) dialogue ducking envelope (80ms attack, 180ms release)
  const duckEnv = new Float32Array(totalFrames);
  let curDuck = 1.0;
  const attackAlpha = 1 - Math.exp(-1 / (0.08 * sr));
  const releaseAlpha = 1 - Math.exp(-1 / (0.18 * sr));
  const duckFloor = 0.3981; // exact -8.0 dB!
  for (let i = 0; i < totalFrames; i++) {
    const target = speakingGate[i] ? duckFloor : 1.0;
    const alpha = target < curDuck ? attackAlpha : releaseAlpha;
    curDuck += (target - curDuck) * alpha;
    duckEnv[i] = curDuck;
  }

  // 3. Mix 8s seamless weather ambience + world-aware 4-chord progression + soft arpeggio (in 'full' mode)
  if (mixMode === 'full') {
    if (graph.world.weather !== 'none' && graph.world.weatherIntensity > 0.05) {
      const ambLoop = buildSeamlessAmbienceMonoPCM(sr, graph.world.weather);
      const baseAmbGain =
        (graph.world.weather === 'rain' ? 0.095 : 0.065) *
        Math.max(0.25, graph.world.weatherIntensity) *
        worldProf.ambience.gainMul;
      const loopLen = ambLoop.length;
      const stereoOffset = Math.floor(loopLen * 0.37);
      for (let i = 0; i < totalFrames; i++) {
        const duckAmb = 0.72 + 0.28 * duckEnv[i];
        left[i] += ambLoop[i % loopLen] * baseAmbGain * duckAmb;
        right[i] += ambLoop[(i + stereoOffset) % loopLen] * baseAmbGain * duckAmb;
      }
    }

    const wantMusic = opts.includeMusic ?? graph.musicBedEnabled;
    if (wantMusic) {
      const chordDurSec = 2.4;
      const xfadeSec = 0.28;
      const phasesA = [0, 0, 0, 0];
      const phasesB = [0, 0, 0, 0];
      let prevChordIdx = 0;

      // Schedule gentle arpeggio bell notes every 1.2s
      const arpInterval = 1.2;
      const arpCount = Math.floor(totalSec / arpInterval);
      for (let a = 0; a < arpCount; a++) {
        const startS = Math.floor((a * arpInterval + 0.12) * sr);
        const chordIdx = Math.floor((a * arpInterval) / chordDurSec) % 4;
        const noteHz = worldProf.arpeggioHz[(chordIdx + (a % 2)) % 4];
        const bellLen = Math.floor(0.85 * sr);
        let ph = 0;
        const panRight = a % 2 === 0 ? 1.12 : 0.88;
        const panLeft = a % 2 === 0 ? 0.88 : 1.12;
        for (let k = 0; k < bellLen && startS + k < totalFrames; k++) {
          const tB = k / sr;
          ph += (2 * Math.PI * noteHz) / sr;
          const env = Math.min(1, tB / 0.025) * Math.exp(-tB * 4.2) * 0.016 * duckEnv[startS + k];
          const sVal = Math.sin(ph) * env;
          left[startS + k] += sVal * panLeft;
          right[startS + k] += sVal * panRight;
        }
      }

      // Continuous 4-chord warm pad with equal-power chord transitions & -8dB dialogue ducking
      for (let i = 0; i < totalFrames; i++) {
        const t = i / sr;
        const posInProg = t / chordDurSec;
        const chordIdx = Math.floor(posInProg) % 4;
        const frac = posInProg - Math.floor(posInProg);
        const timeIntoChord = frac * chordDurSec;

        if (chordIdx !== prevChordIdx) {
          for (let v = 0; v < 4; v++) phasesB[v] = phasesA[v];
          prevChordIdx = chordIdx;
        }

        const curChord = worldProf.chords[chordIdx];
        const prevChord = worldProf.chords[(chordIdx + 3) % 4];

        let padL = 0;
        let padR = 0;
        for (let v = 0; v < 4; v++) {
          const detuneL = 1 + (v - 1.5) * 0.0018;
          const detuneR = 1 - (v - 1.5) * 0.0018;
          phasesA[v] += (2 * Math.PI * curChord[v] * detuneL) / sr;
          phasesB[v] += (2 * Math.PI * prevChord[v] * detuneR) / sr;

          let voiceSig = Math.sin(phasesA[v]);
          if (timeIntoChord < xfadeSec && t >= chordDurSec) {
            const u = timeIntoChord / xfadeSec;
            voiceSig =
              Math.sin(phasesA[v]) * Math.sin(u * Math.PI * 0.5) +
              Math.sin(phasesB[v]) * Math.cos(u * Math.PI * 0.5);
          }
          if (v % 2 === 0) {
            padL += voiceSig * 1.08;
            padR += voiceSig * 0.92;
          } else {
            padL += voiceSig * 0.92;
            padR += voiceSig * 1.08;
          }
        }

        // Smooth fade-in over first 0.4s + dialogue ducking
        const masterPadEnv = Math.min(1, t / 0.4) * 0.0145 * duckEnv[i];
        left[i] += padL * masterPadEnv;
        right[i] += padR * masterPadEnv;
      }
    }
  }

  // Soft ceiling limiter preventing clipping when thunder + dialogue + footsteps coincide
  for (let i = 0; i < totalFrames; i++) {
    left[i] = Math.tanh(left[i]);
    right[i] = Math.tanh(right[i]);
  }

  const OfflineAC =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : typeof window !== 'undefined'
        ? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
            .webkitOfflineAudioContext
        : undefined;

  if (OfflineAC) {
    try {
      const octx = new OfflineAC(2, totalFrames, sr);
      const buf = octx.createBuffer(2, totalFrames, sr);
      buf.getChannelData(0).set(left);
      buf.getChannelData(1).set(right);
      return buf;
    } catch {
      // Fall back to PcmBufferLike in headless environments
    }
  }

  const synthetic: PcmBufferLike = {
    sampleRate: sr,
    length: totalFrames,
    duration: totalFrames / sr,
    numberOfChannels: 2,
    getChannelData: (ch: number) => (ch === 0 ? left : right),
  };
  return synthetic as unknown as AudioBuffer;
}
