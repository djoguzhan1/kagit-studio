import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Crosshair,
  Film,
  Gamepad2,
  Mic,
  RefreshCw,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  FilmShot,
  LivePerformanceOverride,
  MotionCaptureSample,
  MotionCaptureTrack,
  VisemeId,
  VoiceLipSyncTrack,
} from '../../types/film';
import {
  analyzeAudioBlobToLipSyncTrack,
  calibratePoseBaseline,
  classifyLiveAnalyserViseme,
  extractMocapTrackFromVideoFile,
  extractPoseSampleFromFrameRGBA,
  smoothMocapSample,
  VISEME_LABELS,
  type PoseCalibrationBaseline,
} from '../../engine/filmMocapLipSync';
import { saveBlob } from '../../engine/db';
import { soundEngine } from '../../engine/soundEngine';
import { useStudioStore } from '../../store/useStudioStore';
import { useT } from '../../i18n/translations';

type DeckTab = 'webcam' | 'video' | 'live-pad';

function compactVisemeLabel(v: VisemeId, quietLabel: string): string {
  if (v === 'closed') return quietLabel;
  return VISEME_LABELS[v].split('/')[0]?.trim() || v;
}

interface PerformanceMocapDeckProps {
  activeShot: FilmShot;
  shotIndex: number;
  onLivePoseChange: (override: LivePerformanceOverride | null) => void;
  onCommitMocap: (track: MotionCaptureTrack, voiceTrack?: VoiceLipSyncTrack | null) => void;
  onClearMocap: () => void;
  onClose: () => void;
  notify: (msg: string, type?: 'info' | 'error' | 'ok') => void;
}

export default function PerformanceMocapDeck({
  activeShot,
  shotIndex,
  onLivePoseChange,
  onCommitMocap,
  onClearMocap,
  onClose,
  notify,
}: PerformanceMocapDeckProps) {
  const t = useT();
  const locale = useStudioStore((s) => s.locale);
  const [tab, setTab] = useState<DeckTab>('live-pad');
  const [camActive, setCamActive] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [withMic, setWithMic] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [videoProgress, setVideoProgress] = useState<number | null>(null);

  // Live telemetry readout
  const [telemetry, setTelemetry] = useState<{
    yawDeg: number;
    leftArm: number;
    rightArm: number;
    lift: number;
    viseme: VisemeId;
  }>({ yawDeg: 0, leftArm: 0, rightArm: 0, lift: 0, viseme: 'closed' });

  // Live Puppet Pad state (normalized -1..+1)
  const [padPos, setPadPos] = useState({ x: 0, y: 0 });
  const [padGestures, setPadGestures] = useState({
    handsUp: false,
    wave: false,
    surprise: false,
    speak: false,
  });
  const padDraggingRef = useRef(false);
  const padPosRef = useRef(padPos);
  const padGesturesRef = useRef(padGestures);
  padPosRef.current = padPos;
  padGesturesRef.current = padGestures;

  // Media & CV refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoFileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<Blob[]>([]);

  const baselineRef = useRef<PoseCalibrationBaseline | null>(null);
  const prevRgbaRef = useRef<Uint8ClampedArray | null>(null);
  const smoothRef = useRef<MotionCaptureSample | null>(null);
  const recSamplesRef = useRef<MotionCaptureSample[]>([]);
  const recStartWallRef = useRef(0);
  const recordingRef = useRef(false);

  const stopCameraResources = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);
    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
      try {
        mediaRecRef.current.stop();
      } catch {
        // ignore
      }
    }
    mediaRecRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
      analyserRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    baselineRef.current = null;
    prevRgbaRef.current = null;
    smoothRef.current = null;
    setCamActive(false);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopCameraResources();
      onLivePoseChange(null);
    };
  }, [stopCameraResources, onLivePoseChange]);

  // Stop webcam cleanly when switching away from webcam tab
  useEffect(() => {
    if (tab !== 'webcam') {
      if (camActive) stopCameraResources();
      if (tab === 'video') onLivePoseChange(null);
    }
  }, [tab, camActive, stopCameraResources, onLivePoseChange]);

  // Start live webcam + optional microphone analyser
  const handleStartCamera = async () => {
    setCamError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg = 'Bu tarayıcıda kamera erişimi desteklenmiyor — Canlı Kukla Pedi veya Video Aktar kullanabilirsin.';
      setCamError(msg);
      notify(msg, 'info');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
        audio: withMic,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      if (withMic && stream.getAudioTracks().length > 0) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AC) {
          const ctx = new AC();
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.55;
          src.connect(analyser);
          audioCtxRef.current = ctx;
          analyserRef.current = analyser;
        }
      }

      baselineRef.current = null;
      prevRgbaRef.current = null;
      smoothRef.current = null;
      setCamActive(true);
      soundEngine.toggle(true);
      notify('Canlı kamera takibi aktif — hareket ettikçe karakterin seni aynalar!');
    } catch {
      const msg =
        'Kamera izni verilmedi veya cihazda kamera bulunamadı. Video Aktar veya Canlı Kukla Pedi ile devam edebilirsin.';
      setCamError(msg);
      notify(msg, 'info');
    }
  };

  // Recalibrate neutral head/shoulder posture on live webcam
  const handleCalibrate = () => {
    baselineRef.current = null;
    soundEngine.click(1.18);
    notify('Nötr duruş kalibre edildi!');
  };

  // Webcam real-time 24–30 FPS CV tracking loop
  useEffect(() => {
    if (tab !== 'webcam' || !camActive) return;

    const W = 96;
    const H = 72;
    const scratch = document.createElement('canvas');
    scratch.width = W;
    scratch.height = H;
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
    const freqBuf = new Uint8Array(256);
    const timeBuf = new Uint8Array(512);

    let raf = 0;
    let lastTick = 0;

    const loop = (now: number) => {
      if (now - lastTick >= 36) {
        lastTick = now;
        const vid = videoRef.current;
        if (vid && vid.readyState >= 2) {
          sctx.drawImage(vid, 0, 0, W, H);
          const rgba = sctx.getImageData(0, 0, W, H).data;
          if (!baselineRef.current) {
            baselineRef.current = calibratePoseBaseline(rgba, W, H, false);
          }

          const tSec = recordingRef.current ? (now - recStartWallRef.current) / 1000 : 0;
          const raw = extractPoseSampleFromFrameRGBA(
            rgba,
            W,
            H,
            tSec,
            baselineRef.current,
            prevRgbaRef.current,
            true
          );

          // Optional live mic formant viseme synced with webcam!
          if (analyserRef.current && audioCtxRef.current) {
            analyserRef.current.getByteFrequencyData(freqBuf);
            analyserRef.current.getByteTimeDomainData(timeBuf);
            const lip = classifyLiveAnalyserViseme(freqBuf, timeBuf, audioCtxRef.current.sampleRate);
            raw.mouthOpen = lip.viseme === 'closed' ? 0 : lip.energy;
            raw.viseme = lip.viseme;
          }

          const smooth = smoothMocapSample(smoothRef.current, raw, 0.34);
          smoothRef.current = smooth;
          prevRgbaRef.current = new Uint8ClampedArray(rgba);

          onLivePoseChange({
            headYawRad: smooth.headYawRad,
            headTiltRad: smooth.headTiltRad,
            bodyLeanRad: smooth.bodyLeanRad,
            leftArmSwing: smooth.leftArmSwing,
            rightArmSwing: smooth.rightArmSwing,
            verticalLiftNorm: smooth.verticalLiftNorm,
            squashY: smooth.squashY,
            mouthOpen: smooth.mouthOpen,
            viseme: smooth.viseme,
          });

          setTelemetry({
            yawDeg: Math.round((smooth.headYawRad * 180) / Math.PI),
            leftArm: smooth.leftArmSwing,
            rightArm: smooth.rightArmSwing,
            lift: smooth.verticalLiftNorm,
            viseme: smooth.viseme ?? 'closed',
          });

          if (recordingRef.current) {
            recSamplesRef.current.push(smooth);
            setRecElapsed(tSec);
            if (tSec >= 6.4) {
              void finishRecording('webcam');
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tab, camActive, onLivePoseChange]);

  // Live Puppet Pad 30 FPS performance loop (Zero-camera 2.5D puppetry + live recording!)
  useEffect(() => {
    if (tab !== 'live-pad') return;
    let raf = 0;
    let lastTick = 0;

    const loop = (now: number) => {
      if (now - lastTick >= 38) {
        lastTick = now;
        const p = padPosRef.current;
        const g = padGesturesRef.current;
        const sec = now / 1000;

        const headYawRad = Math.max(-0.61, Math.min(0.61, p.x * 0.61));
        const headTiltRad = Math.max(-0.34, Math.min(0.34, p.x * 0.16 + (g.surprise ? -0.14 : 0)));
        const bodyLeanRad = Math.max(-0.26, Math.min(0.26, p.x * 0.22));
        const verticalLiftNorm = p.y < -0.12 ? Math.min(0.32, (-p.y - 0.12) * 0.38) : g.surprise ? 0.08 : 0;
        const squashY =
          p.y > 0.12
            ? Math.max(0.84, 1 - (p.y - 0.12) * 0.2)
            : verticalLiftNorm > 0.04
              ? Math.min(1.16, 1 + verticalLiftNorm * 0.48)
              : 1;

        let leftArmSwing = p.x * -0.25;
        let rightArmSwing = p.x * 0.25;
        if (g.handsUp) {
          leftArmSwing = 0.98 + Math.sin(sec * 8) * 0.08;
          rightArmSwing = 0.98 + Math.cos(sec * 8) * 0.08;
        } else if (g.wave) {
          rightArmSwing = 0.96 + Math.sin(sec * 13) * 0.24;
          leftArmSwing = -0.12;
        } else if (g.surprise) {
          leftArmSwing = 0.82;
          rightArmSwing = 0.82;
        }

        const speakCycle: VisemeId[] = ['AA', 'EE', 'OH', 'FV', 'OO', 'AA'];
        const viseme: VisemeId = g.speak
          ? speakCycle[Math.floor(sec * 8) % speakCycle.length]
          : g.surprise
            ? 'OH'
            : 'closed';
        const mouthOpen = viseme === 'closed' ? 0 : g.speak ? 0.78 : 0.62;

        const sample: MotionCaptureSample = {
          t: recordingRef.current ? Number(((now - recStartWallRef.current) / 1000).toFixed(3)) : 0,
          headYawRad: Number(headYawRad.toFixed(4)),
          headTiltRad: Number(headTiltRad.toFixed(4)),
          bodyLeanRad: Number(bodyLeanRad.toFixed(4)),
          leftArmSwing: Number(leftArmSwing.toFixed(3)),
          rightArmSwing: Number(rightArmSwing.toFixed(3)),
          verticalLiftNorm: Number(verticalLiftNorm.toFixed(3)),
          squashY: Number(squashY.toFixed(3)),
          mouthOpen,
          viseme,
        };

        onLivePoseChange(sample);
        setTelemetry({
          yawDeg: Math.round((headYawRad * 180) / Math.PI),
          leftArm: leftArmSwing,
          rightArm: rightArmSwing,
          lift: verticalLiftNorm,
          viseme,
        });

        if (recordingRef.current) {
          recSamplesRef.current.push(sample);
          setRecElapsed(sample.t);
          if (sample.t >= 6.4) {
            void finishRecording('live-pad');
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tab, onLivePoseChange]);

  const startRecording = () => {
    if (tab === 'webcam' && !camActive) {
      notify('Önce "Kamerayı Aç" düğmesine bas', 'info');
      return;
    }
    recSamplesRef.current = [];
    recStartWallRef.current = performance.now();
    setRecElapsed(0);

    // If webcam + mic is active, simultaneously record real audio for Lip-Sync + Export!
    if (tab === 'webcam' && withMic && streamRef.current && streamRef.current.getAudioTracks().length > 0) {
      try {
        const audioOnly = new MediaStream(streamRef.current.getAudioTracks());
        const mr = new MediaRecorder(audioOnly);
        micChunksRef.current = [];
        mr.ondataavailable = (ev) => {
          if (ev.data.size > 0) micChunksRef.current.push(ev.data);
        };
        mr.start();
        mediaRecRef.current = mr;
      } catch {
        mediaRecRef.current = null;
      }
    }

    recordingRef.current = true;
    setRecording(true);
    soundEngine.clapperSnap();
    notify('Canlı 2.5D performans kaydı başladı — hareket et ve bitir!');
  };

  const finishRecording = async (source: 'webcam' | 'live-pad') => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    setRecElapsed(0);
    const samples = [...recSamplesRef.current];
    recSamplesRef.current = [];
    const dur = Math.max(1.2, samples.length > 0 ? samples[samples.length - 1].t : 1.5);

    let voiceTrack: VoiceLipSyncTrack | null = null;
    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
      const mr = mediaRecRef.current;
      const stopped = new Promise<void>((res) => {
        mr.onstop = () => res();
      });
      mr.stop();
      await stopped;
      mediaRecRef.current = null;
      if (micChunksRef.current.length > 0) {
        try {
          const audioBlob = new Blob(micChunksRef.current, { type: mr.mimeType || 'audio/webm' });
          const blobKey = await saveBlob(audioBlob);
          voiceTrack = await analyzeAudioBlobToLipSyncTrack(
            audioBlob,
            blobKey,
            `Plan #${shotIndex + 1} Kamera Sesi`,
            'mic'
          );
        } catch {
          // Audio analysis optional if browser didn't record usable audio
        }
      }
    }

    if (samples.length < 3) {
      notify('Kayıt çok kısaydı — en az yarım saniye hareket kaydet', 'info');
      return;
    }

    const track: MotionCaptureTrack = {
      source,
      durationSec: Number(Math.min(6.5, dur).toFixed(2)),
      fps: 24,
      samples,
      createdAt: new Date().toISOString(),
      label: source === 'webcam' ? 'Kamera Performansı' : 'Canlı Kukla Kaydı',
    };

    onLivePoseChange(null);
    onCommitMocap(track, voiceTrack);
    soundEngine.clapperSnap();
    notify(
      voiceTrack
        ? `Kamera pozu (${samples.length} kare) + gerçek ses dudak senkronu Plan #${shotIndex + 1}'e işlendi!`
        : `2.5D canlı performans (${samples.length} kare, ${track.durationSec}s) Plan #${shotIndex + 1}'e kaydedildi!`
    );
  };

  // Reference Video Pose Transfer Upload
  const handleUploadVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoProgress(5);
    try {
      const track = await extractMocapTrackFromVideoFile(file, (pct) => setVideoProgress(pct));
      onCommitMocap(track, null);
      soundEngine.clapperSnap();
      notify(`"${track.label}" videosundan ${track.samples.length} kare 2.5D poz Plan #${shotIndex + 1}'e aktarıldı!`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Referans video işlenemedi', 'error');
    } finally {
      setVideoProgress(null);
      if (videoFileRef.current) videoFileRef.current.value = '';
    }
  };

  const updatePadFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    const ny = ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1;
    setPadPos({
      x: Math.max(-1, Math.min(1, nx)),
      y: Math.max(-1, Math.min(1, ny)),
    });
  };

  return (
    <div className="w-full max-w-[780px] mt-2 rounded-2xl console-well border border-ink-brass/50 bg-desk-surface/95 p-2.5 shadow-xl space-y-2 shrink-0">
      {/* Header + 3 Source Mode Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className="hardware-led"
            data-on={recording ? 'vermilion' : camActive || tab === 'live-pad' ? 'emerald' : 'amber'}
            data-pulse={recording || camActive}
          />
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-brass">
            {t('mocapHeader')} ({t('filmShotWord')} #{shotIndex + 1})
          </span>
        </div>

        <div className="flex items-center gap-1">
          {(
            [
              { id: 'live-pad', label: t('mocapTabPad'), icon: Gamepad2 },
              { id: 'webcam', label: t('mocapTabCam'), icon: Camera },
              { id: 'video', label: t('mocapTabVideo'), icon: Film },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={recording}
                onClick={() => {
                  soundEngine.click(1.06);
                  setTab(item.id);
                }}
                className={`px-2 py-1 rounded-lg font-mono text-[9.5px] font-bold inline-flex items-center gap-1 border transition-colors ${
                  active
                    ? 'bg-desk-panel border-ink-vermilion text-desk-text'
                    : 'bg-desk-surface/70 border-desk-border text-desk-muted hover:text-desk-text'
                }`}
              >
                <Icon className="w-3 h-3" />
                {item.label}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => {
              stopCameraResources();
              onLivePoseChange(null);
              onClose();
            }}
            className="p-1 rounded-lg text-desk-muted hover:text-desk-text hover:bg-desk-panel ml-1"
            title={t('filmClose')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* TAB 1: ZERO-CAMERA LIVE PUPPETRY PAD */}
      {tab === 'live-pad' && (
        <div className="grid grid-cols-1 md:grid-cols-[176px_1fr_196px] gap-2.5 items-center">
          {/* Interactive XY Stage Joystick */}
          <div
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              padDraggingRef.current = true;
              updatePadFromPointer(e);
            }}
            onPointerMove={(e) => {
              if (!padDraggingRef.current) return;
              updatePadFromPointer(e);
            }}
            onPointerUp={() => {
              padDraggingRef.current = false;
            }}
            onDoubleClick={() => setPadPos({ x: 0, y: 0 })}
            className="relative h-[96px] rounded-xl bg-neutral-950 border border-desk-border overflow-hidden cursor-crosshair select-none touch-none"
            title={
              locale === 'en'
                ? 'Drag: Left/Right = Head Turn & Lean, Up = Jump, Down = Crouch (Double-click to reset)'
                : 'Sürükle: Yatay = Kafa Dönüşü & Eğim, Yukarı = Zıpla, Aşağı = Çömel (Çift tık = Sıfırla)'
            }
          >
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-full h-px bg-desk-border/50" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="h-full w-px bg-desk-border/50" />
            </div>
            <span className="absolute top-1 left-1.5 font-mono text-[8px] text-desk-muted pointer-events-none">
              {t('mocapJumpUp')}
            </span>
            <span className="absolute bottom-1 left-1.5 font-mono text-[8px] text-desk-muted pointer-events-none">
              {t('mocapCrouchDown')}
            </span>
            <span className="absolute bottom-1 right-1.5 font-mono text-[8px] text-ink-brass pointer-events-none">
              {t('mocapTurnLabel')} {telemetry.yawDeg}°
            </span>
            <div
              className="absolute w-5 h-5 -ml-2.5 -mt-2.5 rounded-full bg-ink-vermilion border-2 border-[#FAF6EE] shadow-lg pointer-events-none transition-transform duration-75"
              style={{
                left: `${(padPos.x * 0.44 + 0.5) * 100}%`,
                top: `${(padPos.y * 0.42 + 0.5) * 100}%`,
              }}
            />
          </div>

          {/* Live Expressive Gesture Triggers + Telemetry */}
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
              {(
                [
                  { key: 'handsUp', label: `🙌 ${t('mocapBothArms')}` },
                  { key: 'wave', label: `👋 ${t('mocapWave')}` },
                  { key: 'surprise', label: `😮 ${t('mocapSurprise')}` },
                  { key: 'speak', label: `🗣️ ${t('mocapTalk')}` },
                ] as const
              ).map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    soundEngine.click(1.08);
                    setPadGestures((prev) => ({ ...prev, [g.key]: !prev[g.key] }));
                  }}
                  className={`py-1.5 px-1.5 rounded-lg font-mono text-[9.5px] font-bold border transition-colors ${
                    padGestures[g.key]
                      ? 'bg-ink-brass/25 border-ink-brass text-desk-text'
                      : 'bg-desk-surface border-desk-border text-desk-muted hover:text-desk-text'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-1.5 font-mono text-[9px] text-desk-muted">
              <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border flex items-center justify-between gap-1">
                <span>{t('mocapHeadLabel')}</span>
                <span className="text-desk-text font-bold shrink-0">{telemetry.yawDeg}°</span>
              </div>
              <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border flex items-center justify-between gap-1">
                <span>{t('mocapJumpLabel')}</span>
                <span className="text-desk-text font-bold shrink-0">{Math.round(telemetry.lift * 100)}%</span>
              </div>
              <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border flex items-center justify-between gap-1">
                <span>{t('mocapMouthLabel')}</span>
                <span className="text-ink-brass font-bold shrink-0 whitespace-nowrap">
                  {compactVisemeLabel(telemetry.viseme, t('mocapQuiet'))}
                </span>
              </div>
            </div>
          </div>

          {/* Record / Commit / Clear Controls */}
          <div className="flex flex-col gap-1.5">
            {!recording ? (
              <button
                type="button"
                onClick={startRecording}
                className="w-full py-2 px-3 rounded-xl bg-ink-vermilion text-white font-mono text-[10.5px] font-bold inline-flex items-center justify-center gap-1.5 hover:brightness-110 shadow transition-all"
              >
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                {t('mocapRecordBtn')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finishRecording('live-pad')}
                className="w-full py-2 px-3 rounded-xl bg-red-600 text-white font-mono text-[10.5px] font-bold inline-flex items-center justify-center gap-1.5 shadow animate-pulse"
              >
                <Square className="w-3 h-3 fill-current" />
                {t('mocapStopRecordBtn')} ({recElapsed.toFixed(1)}s)
              </button>
            )}

            <div className="flex items-center justify-between gap-1">
              <button
                type="button"
                onClick={() => {
                  setPadPos({ x: 0, y: 0 });
                  setPadGestures({ handsUp: false, wave: false, surprise: false, speak: false });
                }}
                className="flex-1 py-1 px-2 rounded-lg bg-desk-surface border border-desk-border text-[9.5px] font-mono text-desk-muted hover:text-desk-text inline-flex items-center justify-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                {t('mocapReset')}
              </button>
              {activeShot.mocapTrack && (
                <button
                  type="button"
                  onClick={onClearMocap}
                  className="py-1 px-2 rounded-lg bg-desk-surface border border-desk-border hover:border-ink-vermilion text-[9.5px] font-mono text-ink-vermilion inline-flex items-center gap-1"
                  title={t('mocapClearTrack')}
                >
                  <Trash2 className="w-3 h-3" />
                  {t('mocapClearTrack')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: LIVE WEBCAM POSE TRANSFER + OPTIONAL MIC LIP-SYNC */}
      {tab === 'webcam' && (
        <div className="grid grid-cols-1 md:grid-cols-[164px_1fr_196px] gap-2.5 items-center">
          <div className="relative h-[96px] rounded-xl bg-neutral-950 border border-desk-border overflow-hidden flex items-center justify-center">
            <video
              ref={videoRef}
              muted
              playsInline
              className={`w-full h-full object-cover scale-x-[-1] ${camActive ? 'block' : 'hidden'}`}
            />
            {!camActive && (
              <div className="text-center px-2 space-y-1">
                <Camera className="w-5 h-5 text-desk-muted mx-auto" />
                <div className="font-mono text-[8.5px] text-desk-muted">
                  {camError
                    ? locale === 'en'
                      ? 'Camera off'
                      : 'Kamera kapalı'
                    : locale === 'en'
                      ? 'Live preview'
                      : 'Canlı önizleme'}
                </div>
              </div>
            )}
            {camActive && (
              <div className="absolute inset-0 pointer-events-none border-2 border-ink-emerald/40 rounded-xl">
                <div className="absolute top-1 left-1.5 px-1 py-0.5 rounded bg-black/70 font-mono text-[8px] text-ink-emerald">
                  {locale === 'en' ? 'LIVE TRACKING' : 'CANLI TAKİP'}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            {camError ? (
              <div className="p-2 rounded-lg bg-ink-vermilion/10 border border-ink-vermilion/40 text-[10px] text-desk-text leading-snug">
                {camError}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 font-mono text-[9px]">
                <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border">
                  <div className="text-desk-muted text-[8px]">{t('mocapHeadLabel')}</div>
                  <div className="text-desk-text font-bold">{telemetry.yawDeg}°</div>
                </div>
                <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border">
                  <div className="text-desk-muted text-[8px]">{locale === 'en' ? 'L ARM' : 'SOL KOL'}</div>
                  <div className="text-desk-text font-bold">{Math.round(telemetry.leftArm * 100)}%</div>
                </div>
                <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border">
                  <div className="text-desk-muted text-[8px]">{locale === 'en' ? 'R ARM' : 'SAĞ KOL'}</div>
                  <div className="text-desk-text font-bold">{Math.round(telemetry.rightArm * 100)}%</div>
                </div>
                <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border">
                  <div className="text-desk-muted text-[8px]">{t('mocapMouthLabel')}</div>
                  <div className="text-ink-brass font-bold whitespace-nowrap">
                    {compactVisemeLabel(telemetry.viseme, t('mocapQuiet'))}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setWithMic((v) => !v)}
                disabled={camActive}
                className={`px-2 py-1 rounded-lg border font-mono text-[9.5px] inline-flex items-center gap-1 ${
                  withMic
                    ? 'bg-desk-panel border-ink-emerald text-ink-emerald font-bold'
                    : 'bg-desk-surface border-desk-border text-desk-muted'
                } disabled:opacity-50`}
              >
                <Mic className="w-3 h-3" />
                {locale === 'en' ? 'Sync Microphone' : 'Eşzamanlı Mikrofon'}
              </button>
              {camActive && (
                <button
                  type="button"
                  onClick={handleCalibrate}
                  className="px-2 py-1 rounded-lg bg-desk-surface border border-desk-border hover:border-ink-brass font-mono text-[9.5px] text-desk-text inline-flex items-center gap-1"
                >
                  <Crosshair className="w-3 h-3 text-ink-brass" />
                  {t('mocapCalibrate')}
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            {!camActive ? (
              <button
                type="button"
                onClick={() => void handleStartCamera()}
                className="w-full py-2 px-3 rounded-xl bg-ink-emerald text-neutral-950 font-mono text-[10.5px] font-bold inline-flex items-center justify-center gap-1.5 hover:brightness-110 transition-all"
              >
                <Camera className="w-3.5 h-3.5" />
                {t('mocapStartCam')}
              </button>
            ) : !recording ? (
              <button
                type="button"
                onClick={startRecording}
                className="w-full py-2 px-3 rounded-xl bg-ink-vermilion text-white font-mono text-[10.5px] font-bold inline-flex items-center justify-center gap-1.5 hover:brightness-110 shadow"
              >
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                {t('mocapRecordBtn')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finishRecording('webcam')}
                className="w-full py-2 px-3 rounded-xl bg-red-600 text-white font-mono text-[10.5px] font-bold inline-flex items-center justify-center gap-1.5 animate-pulse"
              >
                <Square className="w-3 h-3 fill-current" />
                {t('mocapStopRecordBtn')} ({recElapsed.toFixed(1)}s)
              </button>
            )}
            {camActive && !recording && (
              <button
                type="button"
                onClick={() => {
                  stopCameraResources();
                  onLivePoseChange(null);
                }}
                className="w-full py-1 px-2 rounded-lg bg-desk-surface border border-desk-border text-[9.5px] font-mono text-desk-muted hover:text-desk-text"
              >
                {t('mocapStopCam')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: REFERENCE VIDEO POSE TRANSFER (.MP4 / .WEBM / .MOV) */}
      {tab === 'video' && (
        <div className="flex flex-wrap items-center justify-between gap-3 py-1">
          <div className="space-y-0.5 flex-1 min-w-[240px]">
            <div className="text-[11px] font-bold text-desk-text">
              {t('mocapTabVideo')}
            </div>
            <p className="text-[10px] text-desk-muted leading-snug">
              {t('mocapVideoHint')}
            </p>
            {videoProgress !== null && (
              <div className="pt-1.5 space-y-1">
                <div className="h-1.5 w-full rounded-full bg-desk-surface overflow-hidden">
                  <div
                    className="h-full bg-ink-brass transition-all duration-150"
                    style={{ width: `${videoProgress}%` }}
                  />
                </div>
                <div className="font-mono text-[9px] text-ink-brass">
                  {locale === 'en' ? `Analyzing motion… ${videoProgress}%` : `Hareket okunuyor… %${videoProgress}`}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={videoProgress !== null}
              onClick={() => videoFileRef.current?.click()}
              className="py-2 px-3.5 rounded-xl bg-ink-brass/20 border border-ink-brass text-ink-brass hover:bg-ink-brass/30 font-mono text-[10.5px] font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              {videoProgress !== null
                ? locale === 'en'
                  ? 'Reading…'
                  : 'Aktarılıyor…'
                : t('mocapPickVideo')}
            </button>
            <input
              ref={videoFileRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={handleUploadVideo}
            />
          </div>
        </div>
      )}

      {activeShot.mocapTrack && (
        <div className="flex items-center justify-between pt-1.5 border-t border-desk-border font-mono text-[9.5px]">
          <span className="text-ink-emerald flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {t('mocapRecordedBadge')}: <strong>{activeShot.mocapTrack.label}</strong> ({activeShot.mocapTrack.samples.length} · {activeShot.mocapTrack.durationSec}s)
          </span>
          <button
            type="button"
            onClick={onClearMocap}
            className="text-desk-muted hover:text-ink-vermilion underline"
          >
            {t('mocapClearTrack')}
          </button>
        </div>
      )}
    </div>
  );
}
