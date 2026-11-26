import type { WeatherKind, WorldSetId } from '../types/film';

/**
 * Pure Web Audio API Cinema Soundstage & Procedural Foley Engine.
 * Zero external audio assets — synthesizes synchronized:
 * - Weather ambience (rain hiss, hilltop breeze, moonlit forest hush)
 * - Surface-aware Foot-Contact Foley (wet asphalt, grass, forest floor)
 * - Delayed dramatic Thunder rolls on lightning flashes
 * - Subtle warm cinematic chord pad with auto-ducking during dialogue
 */
export class FilmFoleyEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  private ambientWeather: WeatherKind = 'none';
  private musicOscs: OscillatorNode[] = [];
  private musicGain: GainNode | null = null;
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

  /** Connects all procedural foley into a MediaStreamDestination for video export recording! */
  public attachStreamDestination(): MediaStream | null {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return null;
    const dest = ctx.createMediaStreamDestination();
    this.masterGain.connect(dest);
    return dest.stream;
  }

  public startAmbience(weather: WeatherKind, intensity: number, musicBed: boolean): void {
    this.stop();
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    this.running = true;
    this.ambientWeather = weather;

    // 1. Looping procedural noise buffer for rain / wind / night ambience
    if (weather !== 'none' && intensity > 0.05) {
      this.spawnAmbientNoise(ctx, weather, intensity);
    }

    // 2. Warm gentle cinema pad (D-minor / Ghibli-esque suspended 9th drone, ultra-subtle)
    if (musicBed) {
      this.spawnMusicPad(ctx);
    }
  }

  /** Smoothly updates weather intensity or music toggle WITHOUT popping/restarting running playback! */
  public updateAmbience(weather: WeatherKind, intensity: number, musicBed: boolean): void {
    if (!this.running) {
      this.startAmbience(weather, intensity, musicBed);
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    if (weather === 'none' || intensity <= 0.05) {
      if (this.ambientGain) {
        this.ambientGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.12);
      }
    } else if (weather !== this.ambientWeather || !this.ambientSource) {
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
      this.ambientWeather = weather;
      this.spawnAmbientNoise(ctx, weather, intensity);
    } else if (this.ambientGain) {
      const targetGain = (weather === 'rain' ? 0.11 : 0.075) * Math.max(0.25, intensity);
      this.ambientGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.15);
    }

    if (musicBed && !this.musicGain) {
      this.spawnMusicPad(ctx);
    } else if (!musicBed && this.musicGain) {
      this.musicGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.12);
    } else if (musicBed && this.musicGain) {
      this.musicGain.gain.setTargetAtTime(0.036, ctx.currentTime, 0.14);
    }
  }

  private spawnAmbientNoise(ctx: AudioContext, weather: WeatherKind, intensity: number): void {
    if (!this.masterGain) return;
    const seconds = 3;
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.996 * b0 + white * 0.06;
      b1 = 0.96 * b1 + white * 0.14;
      data[i] = weather === 'rain' ? white * 0.3 + b1 * 0.55 : b0 * 0.9 + b1 * 0.2;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = weather === 'rain' ? 'bandpass' : 'lowpass';
    filter.frequency.value = weather === 'rain' ? 1450 : weather === 'wind-leaves' ? 520 : 340;
    filter.Q.value = weather === 'rain' ? 0.65 : 1.1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(
      (weather === 'rain' ? 0.11 : 0.075) * Math.max(0.25, intensity),
      ctx.currentTime + 0.35
    );

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start();
    this.ambientSource = src;
    this.ambientGain = gain;
  }

  private spawnMusicPad(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const mGain = ctx.createGain();
    mGain.gain.setValueAtTime(0.001, ctx.currentTime);
    mGain.gain.linearRampToValueAtTime(0.036, ctx.currentTime + 0.55);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 680;

    mGain.connect(lp);
    lp.connect(this.masterGain);

    const freqs = [146.83, 220.0, 261.63, 329.63]; // Dm9 warm chord
    this.musicOscs = freqs.map((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.value = f;
      osc.detune.value = (idx - 1.5) * 4;
      osc.connect(mGain);
      osc.start();
      return osc;
    });
    this.musicGain = mGain;
  }

  /** Auto-ducks cinema music gently (-8dB) whenever character dialogue plays */
  public setDialogueDucking(speaking: boolean): void {
    if (!this.ctx || !this.musicGain) return;
    const target = speaking ? 0.015 : 0.036;
    this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.14);
  }

  /** Exact-frame Foot-Contact Foley sound adapted to world surface */
  public triggerFootstep(setId: WorldSetId, energy = 0.8): void {
    if (!this.running) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;

    const dur = setId === 'rainy-alley' ? 0.085 : 0.065;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.exp((-i / len) * (setId === 'rainy-alley' ? 5.5 : 8.5));
      d[i] = (Math.random() * 2 - 1) * env;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = setId === 'rainy-alley' ? 2100 : setId === 'golden-hill' ? 680 : 950;
    bp.Q.value = setId === 'rainy-alley' ? 1.2 : 1.8;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.095 * Math.max(0.3, Math.min(1.2, energy)), now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.masterGain);
    src.start(now);

    // Subtle low heel thud
    const thud = ctx.createOscillator();
    const tg = ctx.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(118, now);
    thud.frequency.exponentialRampToValueAtTime(48, now + 0.045);
    tg.gain.setValueAtTime(0.065 * energy, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    thud.connect(tg);
    tg.connect(this.masterGain);
    thud.start(now);
    thud.stop(now + 0.055);
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

  /** Subtle cloth swoosh / jump accent */
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

  /** Plays a Phase-4 recorded or uploaded character voice track cleanly through masterGain (both preview & export!) */
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
    // Abort if stopped or another shot's voice took over while decoding
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
