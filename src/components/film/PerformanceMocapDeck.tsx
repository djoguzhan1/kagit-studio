import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
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
  analyzePCMToLipSyncTrack,
  calibratePoseBaseline,
  classifyLiveAnalyserViseme,
  decodeAudioBlobToMonoPCM,
  evaluateLivePuppetPadSample,
  extractMocapFromVideoFile,
  extractPoseSampleFromFrameRGBA,
  isAudioBufferSilent,
  smoothMocapSample,
  VISEME_LABELS,
  type PoseCalibrationBaseline,
} from '../../engine/filmMocapLipSync';
import { saveBlob } from '../../engine/db';
import { soundEngine } from '../../engine/soundEngine';
import { useT, useTFmt } from '../../i18n/translations';
import { safeSetPointerCapture } from '../../utils/pointerCapture';

type DeckTab = 'webcam' | 'video' | 'live-pad';
type CameraStatus = 'idle' | 'requesting' | 'active' | 'error';

function compactVisemeLabel(v: VisemeId, quietLabel: string): string {
  if (v === 'closed') return quietLabel;
  return VISEME_LABELS[v].split('/')[0]?.trim() || v;
}

/** Wraps getUserMedia with a strict 6,000 ms timeout and cleans up late streams */
function requestUserMediaWithTimeout(
  constraints: MediaStreamConstraints,
  timeoutMs = 6000
): Promise<MediaStream> {
  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('Camera request timed out');
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        window.clearTimeout(timer);
        if (settled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        settled = true;
        resolve(stream);
      })
      .catch((err) => {
        window.clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      });
  });
}

/** Computes normalized luminance variance (0..1) to detect black/virtual/covered camera feeds */
function computeFrameLuminanceVariance(rgba: Uint8ClampedArray): number {
  const n = Math.floor(rgba.length / 4);
  if (n <= 1) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

interface PerformanceMocapDeckProps {
  activeShot: FilmShot;
  shotIndex: number;
  preferLeftHandWave?: boolean;
  activeShotDialogue?: string;
  activeVoiceTrack?: VoiceLipSyncTrack | null;
  onLivePoseChange: (override: LivePerformanceOverride | null) => void;
  onCommitMocap: (track: MotionCaptureTrack, voiceTrack?: VoiceLipSyncTrack | null) => void;
  onClearMocap: () => void;
  onClose: () => void;
  notify: (msg: string, type?: 'info' | 'error' | 'ok') => void;
}

export default function PerformanceMocapDeck({
  activeShot,
  shotIndex,
  preferLeftHandWave = false,
  activeShotDialogue,
  activeVoiceTrack,
  onLivePoseChange,
  onCommitMocap,
  onClearMocap,
  onClose,
  notify,
}: PerformanceMocapDeckProps) {
  const t = useT();
  const tf = useTFmt();
  const [tab, setTab] = useState<DeckTab>('live-pad');
  const [camStatus, setCamStatus] = useState<CameraStatus>('idle');
  const [camError, setCamError] = useState<string | null>(null);
  const [camEmptyStream, setCamEmptyStream] = useState(false);
  const [withMic, setWithMic] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [videoProgress, setVideoProgress] = useState<number | null>(null);

  const camActive = camStatus === 'active';

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

  const preferLeftRef = useRef(preferLeftHandWave);
  preferLeftRef.current = preferLeftHandWave;
  const dialogueRef = useRef(activeShotDialogue ?? activeShot.dialogue);
  dialogueRef.current = activeShotDialogue ?? activeShot.dialogue;
  const voiceTrackRef = useRef(activeVoiceTrack ?? activeShot.voiceTrack);
  voiceTrackRef.current = activeVoiceTrack ?? activeShot.voiceTrack;

  // Media & CV refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoFileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const emptyCheckTimerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<Blob[]>([]);

  const baselineRef = useRef<PoseCalibrationBaseline | null>(null);
  const smoothRef = useRef<MotionCaptureSample | null>(null);
  const recSamplesRef = useRef<MotionCaptureSample[]>([]);
  const recStartWallRef = useRef(0);
  const recordingRef = useRef(false);

  const stopCameraResources = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);
    if (emptyCheckTimerRef.current !== null) {
      window.clearTimeout(emptyCheckTimerRef.current);
      emptyCheckTimerRef.current = null;
    }
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
    smoothRef.current = null;
    setCamEmptyStream(false);
    setCamStatus((prev) => (prev === 'error' ? 'error' : 'idle'));
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
      if (camStatus === 'active' || camStatus === 'requesting') {
        stopCameraResources();
        setCamStatus('idle');
      }
      if (tab === 'video') onLivePoseChange(null);
    }
  }, [tab, camStatus, stopCameraResources, onLivePoseChange]);

  const switchToLivePad = () => {
    stopCameraResources();
    setCamError(null);
    setCamEmptyStream(false);
    setCamStatus('idle');
    setTab('live-pad');
    soundEngine.click(1.06);
  };

  // Start live webcam + optional microphone analyser with 6s timeout & auto audio-less fallback!
  const handleStartCamera = async () => {
    if (camStatus === 'requesting') return;
    setCamError(null);
    setCamEmptyStream(false);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg = t('capErrNoCam');
      setCamError(msg);
      setCamStatus('error');
      notify(msg, 'info');
      return;
    }

    setCamStatus('requesting');
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 320 },
      height: { ideal: 240 },
      facingMode: 'user',
    };

    let stream: MediaStream | null = null;
    let fellBackNoMic = false;

    try {
      stream = await requestUserMediaWithTimeout(
        { video: videoConstraints, audio: withMic },
        6000
      );
    } catch (firstErr) {
      const errName = firstErr instanceof Error ? firstErr.name : '';
      // If mic caused failure, automatically retry camera-only!
      if (withMic && errName !== 'TimeoutError') {
        try {
          stream = await requestUserMediaWithTimeout(
            { video: videoConstraints, audio: false },
            6000
          );
          fellBackNoMic = true;
          setWithMic(false);
        } catch (retryErr) {
          const finalName = retryErr instanceof Error ? retryErr.name : errName;
          const msg =
            finalName === 'NotFoundError' ||
            finalName === 'DevicesNotFoundError' ||
            finalName === 'OverconstrainedError'
              ? t('capErrNoCam')
              : t('capErrCamDenied');
          setCamError(msg);
          setCamStatus('error');
          notify(msg, 'info');
          return;
        }
      } else {
        const msg =
          errName === 'NotFoundError' ||
          errName === 'DevicesNotFoundError' ||
          errName === 'OverconstrainedError'
            ? t('capErrNoCam')
            : t('capErrCamDenied');
        setCamError(msg);
        setCamStatus('error');
        notify(msg, 'info');
        return;
      }
    }

    if (!stream) {
      setCamError(t('capErrCamDenied'));
      setCamStatus('error');
      return;
    }

    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {});
    }

    if (!fellBackNoMic && withMic && stream.getAudioTracks().length > 0) {
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
    smoothRef.current = null;
    setCamStatus('active');
    soundEngine.toggle(true);
    notify(fellBackNoMic ? t('mocapCamMicFallback') : t('capCamActiveToast'), 'info');

    // 1.0s post-start blank/virtual-black stream diagnostic guard!
    if (emptyCheckTimerRef.current !== null) {
      window.clearTimeout(emptyCheckTimerRef.current);
    }
    emptyCheckTimerRef.current = window.setTimeout(() => {
      const vid = videoRef.current;
      if (!vid || !streamRef.current) return;
      if (vid.videoWidth === 0 || vid.videoHeight === 0) {
        setCamEmptyStream(true);
        notify(t('mocapCamEmptyStream'), 'info');
        return;
      }
      try {
        const probe = document.createElement('canvas');
        probe.width = 64;
        probe.height = 48;
        const pctx = probe.getContext('2d', { willReadFrequently: true });
        if (pctx) {
          pctx.drawImage(vid, 0, 0, 64, 48);
          const variance = computeFrameLuminanceVariance(pctx.getImageData(0, 0, 64, 48).data);
          if (variance < 1e-4) {
            setCamEmptyStream(true);
            notify(t('mocapCamEmptyStream'), 'info');
          }
        }
      } catch {
        // ignore cross-origin/tainted canvas edge case
      }
    }, 1000);
  };

  // Recalibrate neutral head/shoulder LAB + KLT posture on live webcam
  const handleCalibrate = () => {
    baselineRef.current = null;
    soundEngine.click(1.18);
    notify(t('capCalibratedToast'));
  };

  // Webcam real-time 160x120 Adaptive LAB + Pyramidal KLT tracking loop
  useEffect(() => {
    if (tab !== 'webcam' || !camActive) return;

    const W = 160;
    const H = 120;
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
        if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
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
            null,
            true
          );

          // Live microphone formant viseme overrides visual mouth MAR when mic is active
          if (analyserRef.current && audioCtxRef.current) {
            analyserRef.current.getByteFrequencyData(freqBuf);
            analyserRef.current.getByteTimeDomainData(timeBuf);
            const lip = classifyLiveAnalyserViseme(freqBuf, timeBuf, audioCtxRef.current.sampleRate);
            raw.mouthOpen = lip.viseme === 'closed' ? 0 : lip.energy;
            raw.viseme = lip.viseme;
          }

          const smooth = smoothMocapSample(smoothRef.current, raw, 0.36);
          smoothRef.current = smooth;

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
            if (tSec >= 15.0) {
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
    const mountWall = performance.now();

    const loop = (now: number) => {
      if (now - lastTick >= 38) {
        lastTick = now;
        const p = padPosRef.current;
        const g = padGesturesRef.current;
        const recSec = recordingRef.current ? (now - recStartWallRef.current) / 1000 : 0;
        const sec = recordingRef.current ? recSec : (now - mountWall) / 1000;

        const sample = evaluateLivePuppetPadSample({
          padX: p.x,
          padY: p.y,
          sec,
          recTimeSec: recSec,
          gestures: g,
          preferLeftHandWave: preferLeftRef.current,
          activeShotDialogue: dialogueRef.current,
          activeVoiceTrack: voiceTrackRef.current,
        });

        onLivePoseChange(sample);
        setTelemetry({
          yawDeg: Math.round((sample.headYawRad * 180) / Math.PI),
          leftArm: sample.leftArmSwing,
          rightArm: sample.rightArmSwing,
          lift: sample.verticalLiftNorm,
          viseme: sample.viseme ?? 'closed',
        });

        if (recordingRef.current) {
          recSamplesRef.current.push(sample);
          setRecElapsed(sample.t);
          if (sample.t >= 15.0) {
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
      notify(t('capOpenCamFirst'), 'info');
      return;
    }
    recSamplesRef.current = [];
    recStartWallRef.current = performance.now();
    setRecElapsed(0);

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
    notify(t('capRecStartedToast'));
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
    let micWasSilent = false;

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
          const decoded = await decodeAudioBlobToMonoPCM(audioBlob);
          if (isAudioBufferSilent(decoded.pcm)) {
            // Silent mic guard: NEVER overwrite existing voiceTrack!
            micWasSilent = true;
            voiceTrack = null;
          } else {
            const blobKey = await saveBlob(audioBlob);
            voiceTrack = analyzePCMToLipSyncTrack(decoded.pcm, decoded.sampleRate, {
              audioBlobKey: blobKey,
              label: `${t('filmShotWord')} #${shotIndex + 1}`,
              source: 'mic',
              fps: 24,
            });
          }
        } catch {
          voiceTrack = null;
        }
      }
    }

    if (samples.length < 3) {
      notify(t('capRecTooShort'), 'info');
      return;
    }

    const track: MotionCaptureTrack = {
      source,
      durationSec: Number(Math.min(15.0, dur).toFixed(2)),
      fps: 24,
      samples,
      createdAt: new Date().toISOString(),
      label: source === 'webcam' ? t('capLabelWebcam') : t('capLabelPad'),
    };

    onLivePoseChange(null);
    onCommitMocap(track, voiceTrack);
    soundEngine.clapperSnap();
    if (micWasSilent) {
      notify(t('micSilentWarning'), 'info');
    } else {
      notify(
        voiceTrack
          ? tf('capSavedWebcamToast', { frames: samples.length, shot: shotIndex + 1 })
          : tf('capSavedPadToast', { frames: samples.length, sec: track.durationSec, shot: shotIndex + 1 })
      );
    }
  };

  // Reference Video Pose + Voice Transfer Upload (Up to 15s @ 24 FPS!)
  const handleUploadVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoProgress(5);
    try {
      const { track, extractedVoice } = await extractMocapFromVideoFile(file, (pct) =>
        setVideoProgress(pct)
      );
      let syncedVoiceTrack: VoiceLipSyncTrack | null = null;
      if (extractedVoice) {
        const blobKey = await saveBlob(extractedVoice.wavBlob);
        syncedVoiceTrack = {
          ...extractedVoice.lipSyncTrack,
          audioBlobKey: blobKey,
        };
      }
      onCommitMocap(track, syncedVoiceTrack);
      soundEngine.clapperSnap();
      notify(
        tf('capRefImportedToast', {
          label: track.label,
          frames: track.samples.length,
          shot: shotIndex + 1,
        })
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : t('capErrRefVideo'), 'error');
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

  const togglePadGesture = (key: 'handsUp' | 'wave' | 'surprise' | 'speak') => {
    soundEngine.click(1.08);
    setPadGestures((prev) => {
      if (key === 'speak') {
        return { ...prev, speak: !prev.speak };
      }
      // Mutually exclusive arm gestures so 'handsUp', 'wave', and 'surprise' never shadow one another!
      const nextActive = !prev[key];
      return {
        ...prev,
        handsUp: key === 'handsUp' ? nextActive : false,
        wave: key === 'wave' ? nextActive : false,
        surprise: key === 'surprise' ? nextActive : false,
      };
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
            data-pulse={recording || camActive || camStatus === 'requesting'}
          />
          <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass">
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
                className={`px-2 py-1 rounded-lg font-mono text-[11px] font-bold inline-flex items-center gap-1 border transition-colors ${
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
              setCamStatus('idle');
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
              safeSetPointerCapture(e.currentTarget, e.pointerId);
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
            title={t('capPadDragHint')}
          >
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-full h-px bg-desk-border/50" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="h-full w-px bg-desk-border/50" />
            </div>
            <span className="absolute top-1 left-1.5 font-mono text-[11px] text-desk-muted pointer-events-none">
              {t('mocapJumpUp')}
            </span>
            <span className="absolute bottom-1 left-1.5 font-mono text-[11px] text-desk-muted pointer-events-none">
              {t('mocapCrouchDown')}
            </span>
            <span className="absolute bottom-1 right-1.5 font-mono text-[11px] text-ink-brass pointer-events-none">
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
                  aria-pressed={padGestures[g.key]}
                  onClick={() => togglePadGesture(g.key)}
                  className={`py-1.5 px-1.5 rounded-lg font-mono text-[11px] font-bold border transition-colors ${
                    padGestures[g.key]
                      ? 'bg-ink-brass/25 border-ink-brass text-desk-text'
                      : 'bg-desk-surface border-desk-border text-desk-muted hover:text-desk-text'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px] text-desk-muted">
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
                className="w-full py-2 px-3 rounded-xl bg-ink-vermilion text-white font-mono text-[11px] font-bold inline-flex items-center justify-center gap-1.5 hover:brightness-110 shadow transition-all"
              >
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                {t('mocapRecordBtn')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finishRecording('live-pad')}
                className="w-full py-2 px-3 rounded-xl bg-red-600 text-white font-mono text-[11px] font-bold inline-flex items-center justify-center gap-1.5 shadow animate-pulse"
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
                className="flex-1 py-1 px-2 rounded-lg bg-desk-surface border border-desk-border text-[11px] font-mono text-desk-muted hover:text-desk-text inline-flex items-center justify-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                {t('mocapReset')}
              </button>
              {activeShot.mocapTrack && (
                <button
                  type="button"
                  onClick={onClearMocap}
                  className="py-1 px-2 rounded-lg bg-desk-surface border border-desk-border hover:border-ink-vermilion text-[11px] font-mono text-ink-vermilion inline-flex items-center gap-1"
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
                <div className="font-mono text-[11px] text-desk-muted">
                  {camStatus === 'requesting'
                    ? t('mocapCamRequesting')
                    : camStatus === 'error'
                      ? t('capCamOff')
                      : t('capLivePreview')}
                </div>
              </div>
            )}
            {camActive && (
              <div className="absolute inset-0 pointer-events-none border-2 border-ink-emerald/40 rounded-xl">
                <div className="absolute top-1 left-1.5 px-1 py-0.5 rounded bg-black/70 font-mono text-[11px] text-ink-emerald">
                  {t('capLiveTracking')}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            {camStatus === 'error' && camError ? (
              <div className="p-2 rounded-lg bg-ink-vermilion/10 border border-ink-vermilion/40 text-[11px] text-desk-text leading-snug flex flex-wrap items-center justify-between gap-2">
                <span className="flex-1 min-w-[180px]">{camError}</span>
                <button
                  type="button"
                  onClick={switchToLivePad}
                  className="px-2.5 py-1 rounded-lg bg-ink-brass text-neutral-950 font-mono text-[11px] font-bold inline-flex items-center gap-1 shrink-0"
                >
                  <Gamepad2 className="w-3 h-3" />
                  {t('mocapUseLivePadBtn')}
                </button>
              </div>
            ) : camEmptyStream ? (
              <div className="p-2 rounded-lg bg-ink-brass/15 border border-ink-brass/50 text-[11px] text-desk-text leading-snug flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 flex-1 min-w-[180px]">
                  <AlertTriangle className="w-3.5 h-3.5 text-ink-brass shrink-0" />
                  {t('mocapCamEmptyStream')}
                </span>
                <button
                  type="button"
                  onClick={switchToLivePad}
                  className="px-2.5 py-1 rounded-lg bg-ink-brass text-neutral-950 font-mono text-[11px] font-bold inline-flex items-center gap-1 shrink-0"
                >
                  <Gamepad2 className="w-3 h-3" />
                  {t('mocapUseLivePadBtn')}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 font-mono text-[11px]">
                <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border">
                  <div className="text-desk-muted text-[11px]">{t('mocapHeadLabel')}</div>
                  <div className="text-desk-text font-bold">{telemetry.yawDeg}°</div>
                </div>
                <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border">
                  <div className="text-desk-muted text-[11px]">{t('capLeftArm')}</div>
                  <div className="text-desk-text font-bold">{Math.round(telemetry.leftArm * 100)}%</div>
                </div>
                <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border">
                  <div className="text-desk-muted text-[11px]">{t('capRightArm')}</div>
                  <div className="text-desk-text font-bold">{Math.round(telemetry.rightArm * 100)}%</div>
                </div>
                <div className="px-2 py-1 rounded-lg bg-desk-surface/70 border border-desk-border">
                  <div className="text-desk-muted text-[11px]">{t('mocapMouthLabel')}</div>
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
                disabled={camActive || camStatus === 'requesting'}
                className={`px-2 py-1 rounded-lg border font-mono text-[11px] inline-flex items-center gap-1 ${
                  withMic
                    ? 'bg-desk-panel border-ink-emerald text-ink-emerald font-bold'
                    : 'bg-desk-surface border-desk-border text-desk-muted'
                } disabled:opacity-50`}
              >
                <Mic className="w-3 h-3" />
                {t('capSyncMic')}
              </button>
              {camActive && (
                <button
                  type="button"
                  onClick={handleCalibrate}
                  className="px-2 py-1 rounded-lg bg-desk-surface border border-desk-border hover:border-ink-brass font-mono text-[11px] text-desk-text inline-flex items-center gap-1"
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
                disabled={camStatus === 'requesting'}
                onClick={() => void handleStartCamera()}
                className="w-full py-2 px-3 rounded-xl bg-ink-emerald text-neutral-950 font-mono text-[11px] font-bold inline-flex items-center justify-center gap-1.5 hover:brightness-110 transition-all disabled:opacity-60"
              >
                <Camera className="w-3.5 h-3.5" />
                {camStatus === 'requesting' ? t('mocapCamRequesting') : t('mocapStartCam')}
              </button>
            ) : !recording ? (
              <button
                type="button"
                onClick={startRecording}
                className="w-full py-2 px-3 rounded-xl bg-ink-vermilion text-white font-mono text-[11px] font-bold inline-flex items-center justify-center gap-1.5 hover:brightness-110 shadow"
              >
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                {t('mocapRecordBtn')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finishRecording('webcam')}
                className="w-full py-2 px-3 rounded-xl bg-red-600 text-white font-mono text-[11px] font-bold inline-flex items-center justify-center gap-1.5 animate-pulse"
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
                  setCamStatus('idle');
                  onLivePoseChange(null);
                }}
                className="w-full py-1 px-2 rounded-lg bg-desk-surface border border-desk-border text-[11px] font-mono text-desk-muted hover:text-desk-text"
              >
                {t('mocapStopCam')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: REFERENCE VIDEO POSE + VOICE TRANSFER (.MP4 / .WEBM / .MOV, UP TO 15s @ 24 FPS) */}
      {tab === 'video' && (
        <div className="flex flex-wrap items-center justify-between gap-3 py-1">
          <div className="space-y-1 flex-1 min-w-[240px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold text-desk-text">{t('mocapTabVideo')}</span>
              <span className="px-2 py-0.5 rounded-full bg-ink-brass/15 border border-ink-brass/40 font-mono text-[11px] font-bold text-ink-brass">
                {t('mocapVideoSpecsBadge')}
              </span>
            </div>
            <p className="text-[11px] text-desk-muted leading-snug">{t('mocapVideoHint')}</p>
            {videoProgress !== null && (
              <div className="pt-1.5 space-y-1">
                <div className="h-1.5 w-full rounded-full bg-desk-surface overflow-hidden">
                  <div
                    className="h-full bg-ink-brass transition-all duration-150"
                    style={{ width: `${videoProgress}%` }}
                  />
                </div>
                <div className="font-mono text-[11px] text-ink-brass">
                  {tf('capAnalyzingProgress', { pct: videoProgress })}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={videoProgress !== null}
              onClick={() => videoFileRef.current?.click()}
              className="py-2 px-3.5 rounded-xl bg-ink-brass/20 border border-ink-brass text-ink-brass hover:bg-ink-brass/30 font-mono text-[11px] font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              {videoProgress !== null ? t('capImportingBtn') : t('mocapPickVideo')}
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
        <div className="flex items-center justify-between pt-1.5 border-t border-desk-border font-mono text-[11px]">
          <span className="text-ink-emerald flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {t('mocapRecordedBadge')}: <strong>{activeShot.mocapTrack.label}</strong> (
            {activeShot.mocapTrack.samples.length} · {activeShot.mocapTrack.durationSec}s)
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
