import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  FlipHorizontal2,
  Grid,
  Images,
  Mic,
  RefreshCw,
  Scan,
  Sliders,
  Sparkles,
  Timer,
  Trash2,
  Upload,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { KeycapButton } from '../ui/KeycapButton';
import { IrisCameraIcon, OnionLayersIcon } from '../ui/AnimatedStudioIcons';
import { runAutoDetectCorners, runGridSlice, runPaperProcess } from '../../engine/paperWorkerClient';
import type { QuadCorners } from '../../engine/paperWorker';
import { generateSampleA4PaperFile } from '../../engine/starterPresets';
import { canvasToPngBlob, canvasToWebpOrJpegBlob } from '../../engine/db';
import { soundEngine } from '../../engine/soundEngine';
import { useT, useTFmt, type TranslationKey } from '../../i18n/translations';
import { safeSetPointerCapture } from '../../utils/pointerCapture';

const GRID_PRESETS: ReadonlyArray<{ id: '1x1' | '2x2' | '3x2' | '4x2' | '3x3'; cols: number; rows: number; labelKey: TranslationKey }> = [
  { id: '1x1', cols: 1, rows: 1, labelKey: 'paperGrid1x1' },
  { id: '2x2', cols: 2, rows: 2, labelKey: 'paperGrid2x2' },
  { id: '3x2', cols: 3, rows: 2, labelKey: 'paperGrid3x2' },
  { id: '4x2', cols: 4, rows: 2, labelKey: 'paperGrid4x2' },
  { id: '3x3', cols: 3, rows: 3, labelKey: 'paperGrid3x3' },
];

const DEFAULT_CORNERS: QuadCorners = [
  { x: 0.04, y: 0.04 },
  { x: 0.96, y: 0.04 },
  { x: 0.96, y: 0.96 },
  { x: 0.04, y: 0.96 },
];

interface QueuedPhoto {
  id: string;
  file: File;
  name: string;
  previewUrl: string;
}

export default function PaperCameraStudio() {
  const {
    projects,
    activeProjectId,
    pendingSamplePaper,
    clearPendingSamplePaper,
    addImportedPaperFrames,
    setMode,
    notify,
  } = useStudioStore();
  const t = useT();
  const tf = useTFmt();
  const project = projects.find((p) => p.id === activeProjectId);

  const [tab, setTab] = useState<'camera' | 'scan'>('camera');
  const [gridPresetId, setGridPresetId] = useState<(typeof GRID_PRESETS)[number]['id']>('1x1');
  const activeGrid = GRID_PRESETS.find((g) => g.id === gridPresetId) ?? GRID_PRESETS[0];

  // Shared Paper Ink Extraction Parameters
  const [transparentBg, setTransparentBg] = useState(true);
  const [preserveColor, setPreserveColor] = useState(false);
  const [sensitivity, setSensitivity] = useState(64);
  const [inkStrength, setInkStrength] = useState(60);
  const [stripBluePencil, setStripBluePencil] = useState(true);
  const [stripRedPencil, setStripRedPencil] = useState(false);
  const [autoRegister, setAutoRegister] = useState(true);
  const [paperProfile, setPaperProfile] = useState<'pencil' | 'ink' | 'color'>('pencil');
  const [showFineTune, setShowFineTune] = useState(false);

  const applyPaperProfile = (profile: 'pencil' | 'ink' | 'color') => {
    soundEngine.click(1.06);
    setPaperProfile(profile);
    if (profile === 'pencil') {
      setTransparentBg(true);
      setPreserveColor(false);
      setSensitivity(68);
      setInkStrength(58);
      setStripBluePencil(true);
      setStripRedPencil(false);
    } else if (profile === 'ink') {
      setTransparentBg(true);
      setPreserveColor(false);
      setSensitivity(56);
      setInkStrength(82);
      setStripBluePencil(true);
      setStripRedPencil(false);
    } else {
      setTransparentBg(true);
      setPreserveColor(true);
      setSensitivity(64);
      setInkStrength(50);
      setStripBluePencil(false);
      setStripRedPencil(false);
    }
  };

  // Camera + Hands-Free Clap/Audio Trigger State
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [mirrorCamera, setMirrorCamera] = useState(false);
  const [cameraOnion, setCameraOnion] = useState(true);
  const [cameraOnionOpacity, setCameraOnionOpacity] = useState(0.4);
  const [lastCapturePreview, setLastCapturePreview] = useState<string | null>(null);
  const [captureCount, setCaptureCount] = useState(0);
  const [timerSec, setTimerSec] = useState<0 | 3 | 5>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);

  const [clapTrigger, setClapTrigger] = useState(false);
  const [micVuLevel, setMicVuLevel] = useState(0);
  const lastClapTimeRef = useRef(0);

  // Scanner + Auto-Corner + Before/After Split Curtain State
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cornerCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [corners, setCorners] = useState<QuadCorners>(DEFAULT_CORNERS);
  const [draggingCorner, setDraggingCorner] = useState<number | null>(null);
  const [splitPct, setSplitPct] = useState(50); // Before/After curtain 0..100
  const [detectingCorners, setDetectingCorners] = useState(false);
  const [processingBatch, setProcessingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const loadedSourceImgRef = useRef<HTMLImageElement | null>(null);
  const latestScanResultRef = useRef<{
    cleaned: HTMLCanvasElement;
    original: HTMLCanvasElement;
  } | null>(null);
  const mountedRef = useRef(true);
  const scanReqSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scanReqSeqRef.current++;
    };
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  const startCamera = useCallback(async () => {
    stopCamera();
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(t('paperErrNoCam'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
    } catch {
      setCameraError(t('paperErrCamDenied'));
    }
  }, [facingMode, stopCamera, t]);

  useEffect(() => {
    if (tab === 'camera') {
      void startCamera();
    } else {
      stopCamera();
      setClapTrigger(false);
    }
    return () => stopCamera();
  }, [tab, startCamera, stopCamera]);

  useEffect(() => {
    return () => {
      if (lastCapturePreview) URL.revokeObjectURL(lastCapturePreview);
    };
  }, [lastCapturePreview]);

  const captureLiveFrame = useCallback(async () => {
    if (!videoRef.current || !project || capturing) return;
    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    setCapturing(true);
    soundEngine.shutter();
    try {
      const src = document.createElement('canvas');
      src.width = project.width;
      src.height = project.height;
      const sctx = src.getContext('2d')!;
      if (mirrorCamera) {
        sctx.translate(src.width, 0);
        sctx.scale(-1, 1);
      }
      const scale = Math.max(src.width / video.videoWidth, src.height / video.videoHeight);
      const dw = video.videoWidth * scale;
      const dh = video.videoHeight * scale;
      sctx.drawImage(video, (src.width - dw) / 2, (src.height - dh) / 2, dw, dh);

      const rgba = sctx.getImageData(0, 0, src.width, src.height).data;
      const processed = await runPaperProcess({
        width: src.width,
        height: src.height,
        rgba,
        outWidth: project.width,
        outHeight: project.height,
        transparentBg,
        preserveColor,
        sensitivity,
        inkStrength,
        stripBluePencil,
        stripRedPencil,
      });

      const outCanvas = document.createElement('canvas');
      outCanvas.width = processed.width;
      outCanvas.height = processed.height;
      outCanvas
        .getContext('2d')!
        .putImageData(
          new ImageData(new Uint8ClampedArray(processed.rgba), processed.width, processed.height),
          0,
          0
        );

      const blob = await canvasToPngBlob(outCanvas);
      const tw = 512;
      const th = Math.max(180, Math.round((project.height / project.width) * tw));
      const tc = document.createElement('canvas');
      tc.width = tw;
      tc.height = th;
      const tctx = tc.getContext('2d')!;
      tctx.fillStyle = project.paperColor;
      tctx.fillRect(0, 0, tw, th);
      tctx.drawImage(outCanvas, 0, 0, tw, th);
      const thumbBlob = await canvasToWebpOrJpegBlob(tc, 0.86);

      const origCanvas = document.createElement('canvas');
      origCanvas.width = processed.width;
      origCanvas.height = processed.height;
      origCanvas
        .getContext('2d')!
        .putImageData(
          new ImageData(new Uint8ClampedArray(processed.warpedOriginalRgba), processed.width, processed.height),
          0,
          0
        );
      const paperOriginalBlob = await canvasToWebpOrJpegBlob(origCanvas, 0.82);

      await addImportedPaperFrames([{ blob, thumbBlob, transparentBg, paperOriginalBlob }]);

      const previewUrl = URL.createObjectURL(blob);
      setLastCapturePreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return previewUrl;
      });
      setCaptureCount((c) => c + 1);
      notify(tf('paperFrameCapturedToast', { num: captureCount + 1 }));
    } catch (err) {
      notify(err instanceof Error ? err.message : t('paperErrCapture'), 'error');
    } finally {
      setCapturing(false);
    }
  }, [
    project,
    capturing,
    mirrorCamera,
    transparentBg,
    preserveColor,
    sensitivity,
    inkStrength,
    stripBluePencil,
    stripRedPencil,
    addImportedPaperFrames,
    captureCount,
    notify,
  ]);

  const triggerCapture = useCallback(() => {
    if (timerSec === 0) {
      void captureLiveFrame();
      return;
    }
    setCountdown(timerSec);
    let remaining = timerSec;
    const iv = setInterval(() => {
      remaining--;
      soundEngine.click(1.2);
      if (remaining <= 0) {
        clearInterval(iv);
        setCountdown(null);
        void captureLiveFrame();
      } else {
        setCountdown(remaining);
      }
    }, 1000);
  }, [timerSec, captureLiveFrame]);

  // Hands-free Spacebar shutter shortcut when camera is live
  useEffect(() => {
    if (tab !== 'camera' || !cameraActive) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        triggerCapture();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, cameraActive, triggerCapture]);

  // Real Hands-Free Acoustic Clap / Snap Trigger via Web Audio AnalyserNode
  useEffect(() => {
    if (!clapTrigger || !cameraActive || tab !== 'camera') {
      setMicVuLevel(0);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let raf = 0;

    const run = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtx = new AC();
        const src = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);

        const poll = () => {
          if (cancelled) return;
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i]);
            if (v > peak) peak = v;
          }
          setMicVuLevel(Math.min(1, peak * 2.5));
          const now = performance.now();
          if (peak > 0.34 && now - lastClapTimeRef.current > 1500) {
            lastClapTimeRef.current = now;
            triggerCapture();
          }
          raf = requestAnimationFrame(poll);
        };
        raf = requestAnimationFrame(poll);
      } catch {
        setClapTrigger(false);
        notify(t('paperErrClapMic'), 'error');
      }
    };

    void run();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void audioCtx?.close().catch(() => {});
    };
  }, [clapTrigger, cameraActive, tab, triggerCapture, notify]);

  // Draw Before / After Split Curtain on Preview Canvas
  const drawSplitComparison = useCallback(() => {
    const prevCanvas = previewCanvasRef.current;
    const pair = latestScanResultRef.current;
    if (!prevCanvas || !pair || !project) return;
    const { cleaned, original } = pair;
    const w = cleaned.width;
    const h = cleaned.height;
    prevCanvas.width = w;
    prevCanvas.height = h;
    const ctx = prevCanvas.getContext('2d')!;
    const splitX = Math.round((splitPct / 100) * w);

    // Left: Warped original paper photo
    ctx.drawImage(original, 0, 0);

    // Right: Cleaned backlit paper + extracted ink cel
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, w - splitX, h);
    ctx.clip();
    ctx.fillStyle = project.paperColor;
    ctx.fillRect(splitX, 0, w - splitX, h);
    ctx.drawImage(cleaned, 0, 0);
    ctx.restore();

    // Machined Vermilion/Brass split curtain line + knob
    ctx.strokeStyle = '#E54D2E';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, h);
    ctx.stroke();

    ctx.fillStyle = '#E54D2E';
    ctx.beginPath();
    ctx.arc(splitX, h / 2, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#F7F3E9';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Optional A4 Multi-Frame Grid-Slice cut lines overlay
    if (activeGrid.cols > 1 || activeGrid.rows > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.78)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      for (let c = 1; c < activeGrid.cols; c++) {
        const gx = Math.round((c / activeGrid.cols) * w);
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, h);
        ctx.stroke();
      }
      for (let r = 1; r < activeGrid.rows; r++) {
        const gy = Math.round((r / activeGrid.rows) * h);
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(w, gy);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Labels
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(22,21,19,0.78)';
    ctx.fillRect(8, 8, 72, 20);
    ctx.fillRect(w - 94, 8, 86, 20);
    ctx.fillStyle = '#F7F3E9';
    ctx.fillText(t('paperBeforeCanvas'), 15, 22);
    ctx.fillText(t('paperAfterCanvas'), w - 88, 22);
  }, [splitPct, project, activeGrid, t]);

  useEffect(() => {
    drawSplitComparison();
  }, [drawSplitComparison]);

  const redrawCornerOverlay = useCallback(() => {
    const canvas = cornerCanvasRef.current;
    const img = loadedSourceImgRef.current;
    if (!canvas || !img) return;
    const maxW = 540;
    const scale = Math.min(1, maxW / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);

    ctx.strokeStyle = '#E54D2E';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    corners.forEach((pt, idx) => {
      const px = pt.x * w;
      const py = pt.y * h;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();

    corners.forEach((pt, idx) => {
      const px = pt.x * w;
      const py = pt.y * h;
      ctx.fillStyle = draggingCorner === idx ? '#D99B26' : '#E54D2E';
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#F7F3E9';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    });
  }, [corners, draggingCorner]);

  const refreshScanPreview = useCallback(async () => {
    const img = loadedSourceImgRef.current;
    if (!img || !project) return;
    const reqId = ++scanReqSeqRef.current;

    const pw = 640;
    const ph = Math.round((project.height / project.width) * pw);
    const srcC = document.createElement('canvas');
    const srcScale = Math.min(1, 960 / Math.max(img.naturalWidth, img.naturalHeight));
    srcC.width = Math.round(img.naturalWidth * srcScale);
    srcC.height = Math.round(img.naturalHeight * srcScale);
    srcC.getContext('2d')!.drawImage(img, 0, 0, srcC.width, srcC.height);

    const rgba = srcC.getContext('2d')!.getImageData(0, 0, srcC.width, srcC.height).data;
    let res: Awaited<ReturnType<typeof runPaperProcess>>;
    try {
      res = await runPaperProcess({
        width: srcC.width,
        height: srcC.height,
        rgba,
        corners,
        outWidth: pw,
        outHeight: ph,
        transparentBg,
        preserveColor,
        sensitivity,
        inkStrength,
        stripBluePencil,
        stripRedPencil,
      });
    } catch {
      return;
    }
    if (!mountedRef.current || reqId !== scanReqSeqRef.current) return;

    const cleaned = document.createElement('canvas');
    cleaned.width = pw;
    cleaned.height = ph;
    cleaned
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(res.rgba), pw, ph), 0, 0);

    const original = document.createElement('canvas');
    original.width = pw;
    original.height = ph;
    original
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(res.warpedOriginalRgba), pw, ph), 0, 0);

    latestScanResultRef.current = { cleaned, original };
    drawSplitComparison();
  }, [
    project,
    corners,
    transparentBg,
    preserveColor,
    sensitivity,
    inkStrength,
    stripBluePencil,
    stripRedPencil,
    drawSplitComparison,
  ]);

  const handleAutoDetectPaper = async () => {
    const img = loadedSourceImgRef.current;
    if (!img || detectingCorners) return;
    setDetectingCorners(true);
    try {
      const scale = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d')!.drawImage(img, 0, 0, w, h);
      const rgba = c.getContext('2d')!.getImageData(0, 0, w, h).data;
      const detected = await runAutoDetectCorners({ width: w, height: h, rgba });
      if (!mountedRef.current) return;
      setCorners(detected);
      notify(t('paperAutoAlignedToast'));
    } catch {
      // Ignore worker cancellation on tab switch
    } finally {
      if (mountedRef.current) setDetectingCorners(false);
    }
  };

  const currentPhoto = queue[selectedIdx];
  const queueRef = useRef<QueuedPhoto[]>(queue);
  queueRef.current = queue;

  useEffect(() => {
    return () => {
      for (const item of queueRef.current) {
        URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    if (!currentPhoto) {
      loadedSourceImgRef.current = null;
      latestScanResultRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      loadedSourceImgRef.current = img;
      redrawCornerOverlay();
      void refreshScanPreview();
    };
    img.src = currentPhoto.previewUrl;
  }, [currentPhoto, redrawCornerOverlay, refreshScanPreview]);

  useEffect(() => {
    redrawCornerOverlay();
    const timer = setTimeout(() => {
      void refreshScanPreview();
    }, 90);
    return () => clearTimeout(timer);
  }, [redrawCornerOverlay, refreshScanPreview]);

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).slice(0, 50);
    if (files.length === 0) return;
    const next: QueuedPhoto[] = files.map((file, i) => ({
      id: `${Date.now()}_${i}`,
      file,
      name: file.name,
      previewUrl: URL.createObjectURL(file),
    }));
    setQueue((prev) => [...prev, ...next]);
    setTab('scan');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCornerPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    let closest = -1;
    let bestDist = 0.09;
    corners.forEach((pt, idx) => {
      const d = Math.hypot(pt.x - nx, pt.y - ny);
      if (d < bestDist) {
        bestDist = d;
        closest = idx;
      }
    });
    if (closest >= 0) {
      safeSetPointerCapture(e.currentTarget, e.pointerId);
      setDraggingCorner(closest);
    }
  };

  const handleCornerPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingCorner === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.01, Math.min(0.99, (e.clientY - rect.top) / rect.height));
    setCorners((prev) => {
      const copy = [...prev] as QuadCorners;
      copy[draggingCorner] = { x: nx, y: ny };
      return copy;
    });
  };

  const handleLoadSampleA4 = useCallback(async () => {
    try {
      const sampleFile = await generateSampleA4PaperFile();
      const item: QueuedPhoto = {
        id: `sample_${Date.now()}`,
        file: sampleFile,
        name: sampleFile.name,
        previewUrl: URL.createObjectURL(sampleFile),
      };
      setQueue((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.previewUrl));
        return [item];
      });
      setSelectedIdx(0);
      setTab('scan');
      setGridPresetId('2x2');
      // Pre-lock onto our A4 sheet margins inside the desk photo
      setCorners([
        { x: 0.078, y: 0.07 },
        { x: 0.922, y: 0.07 },
        { x: 0.922, y: 0.922 },
        { x: 0.078, y: 0.922 },
      ]);
      notify(t('paperSampleLoadedToast'));
    } catch {
      notify(t('paperErrSampleA4'), 'error');
    }
  }, [notify, t]);

  useEffect(() => {
    if (pendingSamplePaper) {
      clearPendingSamplePaper();
      void handleLoadSampleA4();
    }
  }, [pendingSamplePaper, clearPendingSamplePaper, handleLoadSampleA4]);

  const handleBatchImportToTimeline = async () => {
    if (!project || queue.length === 0 || processingBatch) return;
    setProcessingBatch(true);
    try {
      const importedItems: {
        blob: Blob;
        thumbBlob: Blob;
        transparentBg: boolean;
        paperOriginalBlob?: Blob | null;
      }[] = [];
      let refCentroid: { x: number; y: number } | null = null;

      for (let i = 0; i < queue.length; i++) {
        setBatchProgress(tf('paperBatchProgress', { cur: i + 1, total: queue.length, name: queue[i].name }));
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = queue[i].previewUrl;
        });

        const scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
        const sw = Math.round(img.naturalWidth * scale);
        const sh = Math.round(img.naturalHeight * scale);
        const srcC = document.createElement('canvas');
        srcC.width = sw;
        srcC.height = sh;
        srcC.getContext('2d')!.drawImage(img, 0, 0, sw, sh);
        const rgba = srcC.getContext('2d')!.getImageData(0, 0, sw, sh).data;

        const isGridMode = activeGrid.cols > 1 || activeGrid.rows > 1;
        const warpW = isGridMode ? Math.min(1600, project.width * 2) : project.width;
        const warpH = isGridMode ? Math.min(1200, project.height * 2) : project.height;

        const res = await runPaperProcess({
          width: sw,
          height: sh,
          rgba,
          corners,
          outWidth: warpW,
          outHeight: warpH,
          transparentBg,
          preserveColor,
          sensitivity,
          inkStrength,
          stripBluePencil,
          stripRedPencil,
        });

        if (isGridMode) {
          setBatchProgress(
            `A4 Izgara kesiliyor (${activeGrid.cols}×${activeGrid.rows} = ${
              activeGrid.cols * activeGrid.rows
            } kare)…`
          );
          const [cleanedCells, origCells] = await Promise.all([
            runGridSlice({
              width: res.width,
              height: res.height,
              rgba: res.rgba,
              cols: activeGrid.cols,
              rows: activeGrid.rows,
              outWidth: project.width,
              outHeight: project.height,
              autoCenter: autoRegister,
              transparentBg,
            }),
            runGridSlice({
              width: res.width,
              height: res.height,
              rgba: res.warpedOriginalRgba,
              cols: activeGrid.cols,
              rows: activeGrid.rows,
              outWidth: project.width,
              outHeight: project.height,
              autoCenter: false,
              transparentBg: false,
            }),
          ]);

          for (let ci = 0; ci < cleanedCells.length; ci++) {
            const cellC = document.createElement('canvas');
            cellC.width = project.width;
            cellC.height = project.height;
            cellC
              .getContext('2d')!
              .putImageData(
                new ImageData(new Uint8ClampedArray(cleanedCells[ci]), project.width, project.height),
                0,
                0
              );
            const blob = await canvasToPngBlob(cellC);

            const origC = document.createElement('canvas');
            origC.width = project.width;
            origC.height = project.height;
            origC
              .getContext('2d')!
              .putImageData(
                new ImageData(new Uint8ClampedArray(origCells[ci]), project.width, project.height),
                0,
                0
              );
            const paperOriginalBlob = await canvasToWebpOrJpegBlob(origC, 0.8);

            const tw = 512;
            const th = Math.max(180, Math.round((project.height / project.width) * tw));
            const tc = document.createElement('canvas');
            tc.width = tw;
            tc.height = th;
            const tctx = tc.getContext('2d')!;
            tctx.fillStyle = project.paperColor;
            tctx.fillRect(0, 0, tw, th);
            tctx.drawImage(cellC, 0, 0, tw, th);
            const thumbBlob = await canvasToWebpOrJpegBlob(tc, 0.86);

            importedItems.push({ blob, thumbBlob, transparentBg, paperOriginalBlob });
          }
          continue;
        }

        let shiftX = 0;
        let shiftY = 0;
        if (autoRegister) {
          if (!refCentroid) {
            refCentroid = { x: res.centroidX, y: res.centroidY };
          } else {
            shiftX = Math.max(-45, Math.min(45, Math.round((refCentroid.x - res.centroidX) * 0.45)));
            shiftY = Math.max(-45, Math.min(45, Math.round((refCentroid.y - res.centroidY) * 0.45)));
          }
        }

        const outC = document.createElement('canvas');
        outC.width = project.width;
        outC.height = project.height;
        const octx = outC.getContext('2d')!;
        const tmp = document.createElement('canvas');
        tmp.width = res.width;
        tmp.height = res.height;
        tmp.getContext('2d')!.putImageData(
          new ImageData(new Uint8ClampedArray(res.rgba), res.width, res.height),
          0,
          0
        );
        octx.drawImage(tmp, shiftX, shiftY);
        const blob = await canvasToPngBlob(outC);

        const origC = document.createElement('canvas');
        origC.width = res.width;
        origC.height = res.height;
        origC
          .getContext('2d')!
          .putImageData(
            new ImageData(new Uint8ClampedArray(res.warpedOriginalRgba), res.width, res.height),
            0,
            0
          );
        const paperOriginalBlob = await canvasToWebpOrJpegBlob(origC, 0.8);

        const tw = 512;
        const th = Math.max(180, Math.round((project.height / project.width) * tw));
        const tc = document.createElement('canvas');
        tc.width = tw;
        tc.height = th;
        const tctx = tc.getContext('2d')!;
        tctx.fillStyle = project.paperColor;
        tctx.fillRect(0, 0, tw, th);
        tctx.drawImage(outC, 0, 0, tw, th);
        const thumbBlob = await canvasToWebpOrJpegBlob(tc, 0.86);

        importedItems.push({ blob, thumbBlob, transparentBg, paperOriginalBlob });
      }

      await addImportedPaperFrames(importedItems);
      queue.forEach((q) => URL.revokeObjectURL(q.previewUrl));
      setQueue([]);
      notify(tf('paperImportedCelToast', { count: importedItems.length }));
      setMode('draw');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('paperErrImport'), 'error');
    } finally {
      setProcessingBatch(false);
      setBatchProgress('');
    }
  };

  if (!project) return null;

  return (
    <div className="flex-1 overflow-y-auto desk-surface-mat p-3 sm:p-5">
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 p-1 rounded-xl console-well border border-desk-border">
            <KeycapButton
              size="sm"
              variant={tab === 'camera' ? 'vermilion' : 'graphite'}
              pressed={tab === 'camera'}
              led={tab === 'camera' ? 'vermilion' : 'off'}
              ledPulse={tab === 'camera'}
              onClick={() => setTab('camera')}
            >
              <IrisCameraIcon className="w-3.5 h-3.5" />
              {t('paperTabCamera')}
            </KeycapButton>
            <KeycapButton
              size="sm"
              variant={tab === 'scan' ? 'ivory' : 'graphite'}
              pressed={tab === 'scan'}
              led={tab === 'scan' ? 'amber' : 'off'}
              onClick={() => setTab('scan')}
            >
              <Images className="w-3.5 h-3.5" />
              {t('paperTabScan')}
            </KeycapButton>
          </div>

          <KeycapButton
            size="sm"
            variant="ivory"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-3.5 h-3.5" />
            {t('paperPickPhotos')}
          </KeycapButton>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFilesSelected}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Main Stage */}
          <div
            data-tour="paper-stage"
            className="lg:col-span-8 rounded-3xl bg-desk-surface border border-desk-border p-4 shadow-xl space-y-4"
          >
            {tab === 'camera' ? (
              <>
                <div className="relative aspect-video rounded-2xl overflow-hidden bg-black border border-desk-border flex items-center justify-center">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    className={`w-full h-full object-cover ${mirrorCamera ? '-scale-x-100' : ''} ${
                      cameraActive ? '' : 'hidden'
                    }`}
                  />

                  {cameraActive && cameraOnion && lastCapturePreview && (
                    <img
                      src={lastCapturePreview}
                      alt={t('paperOnionAlt')}
                      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                      style={{
                        opacity: cameraOnionOpacity,
                        filter: 'sepia(1) hue-rotate(-50deg) saturate(6)',
                      }}
                    />
                  )}

                  {cameraActive && (
                    <div className="absolute inset-4 border border-dashed border-white/30 rounded-lg pointer-events-none">
                      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex gap-5 opacity-60">
                        <span className="w-2.5 h-2.5 rounded-full border border-white" />
                        <span className="w-7 h-2.5 rounded-full border border-white" />
                        <span className="w-2.5 h-2.5 rounded-full border border-white" />
                      </div>
                    </div>
                  )}

                  {countdown !== null && (
                    <div className="absolute inset-0 bg-black/45 flex items-center justify-center">
                      <span className="font-mono text-7xl font-extrabold text-[#F7F3E9]">
                        {countdown}
                      </span>
                    </div>
                  )}

                  {!cameraActive && (
                    <div className="p-8 text-center max-w-md space-y-4">
                      <IrisCameraIcon className="w-10 h-10 text-ink-vermilion mx-auto opacity-85" />
                      <p className="text-sm text-desk-muted leading-relaxed">
                        {cameraError ?? t('paperCameraStarting')}
                      </p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <KeycapButton size="sm" variant="ivory" onClick={() => void startCamera()}>
                          <RefreshCw className="w-3.5 h-3.5" />
                          {t('paperRetryCamera')}
                        </KeycapButton>
                        <KeycapButton
                          size="sm"
                          variant="vermilion"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Upload className="w-3.5 h-3.5" />
                          {t('paperUploadPhoto')}
                        </KeycapButton>
                        <KeycapButton
                          data-tour="paper-sample"
                          size="sm"
                          variant="brass"
                          onClick={() => void handleLoadSampleA4()}
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          {t('paperTrySampleA4')}
                        </KeycapButton>
                      </div>
                    </div>
                  )}
                </div>

                {/* Tactile Camera Shutter + Clap Trigger Console */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeycapButton
                      size="sm"
                      led={cameraOnion ? 'vermilion' : 'off'}
                      pressed={cameraOnion}
                      sound="toggle"
                      onClick={() => setCameraOnion((v) => !v)}
                    >
                      <OnionLayersIcon className="w-4 h-4" />
                      {t('paperOnionLabel')}
                    </KeycapButton>
                    {cameraOnion && (
                      <input
                        type="range"
                        min={0.1}
                        max={0.8}
                        step={0.05}
                        value={cameraOnionOpacity}
                        onChange={(e) => setCameraOnionOpacity(Number(e.target.value))}
                        className="studio-fader w-16"
                      />
                    )}
                    <KeycapButton
                      size="sm"
                      led={clapTrigger ? 'emerald' : 'off'}
                      ledPulse={clapTrigger}
                      pressed={clapTrigger}
                      sound="toggle"
                      onClick={() => setClapTrigger((v) => !v)}
                      title={t('paperClapTitle')}
                    >
                      <Mic className="w-3.5 h-3.5" />
                      <span>{t('paperClapLabel')}</span>
                    </KeycapButton>
                    {clapTrigger && (
                      <div className="w-12 h-2 rounded-full console-well overflow-hidden border border-desk-border">
                        <div
                          className="h-full bg-ink-emerald transition-all duration-75"
                          style={{ width: `${Math.round(micVuLevel * 100)}%` }}
                        />
                      </div>
                    )}
                    <KeycapButton
                      size="sm"
                      onClick={() =>
                        setFacingMode((f) => (f === 'environment' ? 'user' : 'environment'))
                      }
                      title={t('paperFlipCamTitle')}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </KeycapButton>
                    <KeycapButton
                      size="sm"
                      led={mirrorCamera ? 'amber' : 'off'}
                      pressed={mirrorCamera}
                      onClick={() => setMirrorCamera((v) => !v)}
                      title={t('paperMirrorTitle')}
                    >
                      <FlipHorizontal2 className="w-3.5 h-3.5" />
                    </KeycapButton>
                    <KeycapButton
                      size="sm"
                      led={timerSec > 0 ? 'amber' : 'off'}
                      onClick={() => setTimerSec((tm) => (tm === 0 ? 3 : tm === 3 ? 5 : 0))}
                    >
                      <Timer className="w-3.5 h-3.5" />
                      <span className="font-mono">
                        {timerSec === 0 ? t('paperTimerInstant') : `${timerSec}s`}
                      </span>
                    </KeycapButton>
                  </div>

                  <KeycapButton
                    data-tour="paper-commit"
                    size="lg"
                    variant="vermilion"
                    socket
                    sound="none"
                    disabled={!cameraActive || capturing || countdown !== null}
                    onClick={triggerCapture}
                    shortcut="Space"
                  >
                    <IrisCameraIcon className="w-4 h-4" />
                    {capturing ? t('paperCaptureBusy') : t('paperCaptureBtn')}
                  </KeycapButton>
                </div>
              </>
            ) : (
              <>
                {queue.length === 0 ? (
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-video rounded-2xl console-well border-2 border-dashed border-desk-border hover:border-ink-vermilion cursor-pointer flex flex-col items-center justify-center gap-3 p-8 text-center transition-colors"
                  >
                    <Upload className="w-10 h-10 text-ink-vermilion" />
                    <div>
                      <h3 className="font-bold text-base text-desk-text">{t('paperDropTitle')}</h3>
                      <p className="text-xs text-desk-muted mt-1 max-w-md">{t('paperDropDesc')}</p>
                    </div>
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="pt-1 flex flex-wrap justify-center gap-2"
                    >
                      <KeycapButton
                        data-tour="paper-sample"
                        size="sm"
                        variant="brass"
                        onClick={() => void handleLoadSampleA4()}
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        {t('paperTrySampleA4Long')}
                      </KeycapButton>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <div className="flex items-center justify-between mb-1.5 gap-2">
                          <span className="font-mono text-[11px] uppercase tracking-wider text-desk-muted">
                            {t('paperStep1Corners')}
                          </span>
                          <div className="flex items-center gap-2">
                            <KeycapButton
                              size="sm"
                              variant="brass"
                              disabled={detectingCorners}
                              onClick={() => void handleAutoDetectPaper()}
                              className="px-2 py-0.5 text-[11px]"
                            >
                              <Scan className="w-3 h-3" />
                              {t('paperAutoFind')}
                            </KeycapButton>
                            <button
                              type="button"
                              onClick={() => setCorners(DEFAULT_CORNERS)}
                              className="font-mono text-[11px] text-ink-vermilion hover:underline"
                            >
                              {t('paperReset')}
                            </button>
                          </div>
                        </div>
                        <div className="rounded-xl overflow-hidden console-well border border-desk-border flex items-center justify-center bg-black/30">
                          <canvas
                            ref={cornerCanvasRef}
                            onPointerDown={handleCornerPointerDown}
                            onPointerMove={handleCornerPointerMove}
                            onPointerUp={() => setDraggingCorner(null)}
                            className="max-w-full max-h-[300px] touch-none cursor-move"
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-mono text-[11px] uppercase tracking-wider text-desk-muted">
                            {t('paperStep2Wipe')}
                          </span>
                          <span className="font-mono text-[11px] text-ink-brass">
                            {splitPct}%
                          </span>
                        </div>
                        <div className="rounded-xl overflow-hidden console-well border border-desk-border flex items-center justify-center">
                          <canvas
                            ref={previewCanvasRef}
                            onPointerMove={(e) => {
                              if (e.buttons === 1) {
                                const r = e.currentTarget.getBoundingClientRect();
                                setSplitPct(
                                  Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100)))
                                );
                              }
                            }}
                            onPointerDown={(e) => {
                              const r = e.currentTarget.getBoundingClientRect();
                              setSplitPct(
                                Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100)))
                              );
                            }}
                            className="max-w-full max-h-[224px] object-contain cursor-ew-resize touch-none"
                          />
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={splitPct}
                          onChange={(e) => setSplitPct(Number(e.target.value))}
                          className="studio-fader w-full mt-2"
                          aria-label={t('paperStep2Wipe')}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-2 overflow-x-auto pb-1">
                      {queue.map((item, idx) => (
                        <div
                          key={item.id}
                          onClick={() => setSelectedIdx(idx)}
                          className={`relative shrink-0 w-20 h-14 rounded-lg overflow-hidden border cursor-pointer ${
                            idx === selectedIdx
                              ? 'border-ink-vermilion ring-2 ring-ink-vermilion/40'
                              : 'border-desk-border opacity-75 hover:opacity-100'
                          }`}
                        >
                          <img
                            src={item.previewUrl}
                            alt={item.name}
                            className="w-full h-full object-cover"
                          />
                          <span className="absolute top-0.5 left-0.5 px-1 rounded bg-black/70 font-mono text-[11px] text-white">
                            {idx + 1}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              URL.revokeObjectURL(item.previewUrl);
                              setQueue((prev) => prev.filter((q) => q.id !== item.id));
                              setSelectedIdx(0);
                            }}
                            className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/70 text-white hover:text-ink-vermilion"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* A4 Multi-Frame Grid-Slice Selector */}
                    <div className="rounded-2xl console-well border border-desk-border p-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-blue flex items-center gap-1.5">
                        <Grid className="w-3.5 h-3.5" />
                        {t('paperGridTitle')}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {GRID_PRESETS.map((gp) => (
                          <button
                            key={gp.id}
                            type="button"
                            onClick={() => setGridPresetId(gp.id)}
                            className={`px-2 py-1 rounded-lg font-mono text-[11px] border transition-colors ${
                              gridPresetId === gp.id
                                ? 'bg-ink-blue/20 border-ink-blue text-desk-text font-bold'
                                : 'border-desk-border text-desk-muted hover:text-desk-text'
                            }`}
                          >
                            {t(gp.labelKey)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-1">
                      <span className="font-mono text-xs text-desk-muted">
                        {batchProgress ||
                          `${queue.length * activeGrid.cols * activeGrid.rows} ${t('paperReadyCount')}`}
                      </span>
                      <KeycapButton
                        data-tour="paper-commit"
                        size="lg"
                        variant="vermilion"
                        socket
                        disabled={processingBatch}
                        onClick={() => void handleBatchImportToTimeline()}
                      >
                        <Check className="w-4 h-4" />
                        {processingBatch
                          ? t('paperProcessing')
                          : `${queue.length * activeGrid.cols * activeGrid.rows} · ${t('paperCommitFrames')}`}
                      </KeycapButton>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right Clean Profile & Fine-Tune Rack (Sticky on desktop so controls stay beside A4 scan!) */}
          <aside className="lg:col-span-4 lg:sticky lg:top-0 rounded-3xl bg-desk-surface border border-desk-border p-4 shadow-xl space-y-3.5">
            <div className="flex items-center gap-2 border-b border-desk-border pb-3">
              <Sliders className="w-4 h-4 text-ink-brass" />
              <div>
                <h3 className="text-sm font-bold text-desk-text">{t('paperProfileTitle')}</h3>
                <p className="font-mono text-[11px] text-desk-muted">{t('paperProfileSub')}</p>
              </div>
            </div>

            {/* 1. Three 1-Click Preset Profiles */}
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'pencil', label: t('paperProfPencil') },
                  { id: 'ink', label: t('paperProfInk') },
                  { id: 'color', label: t('paperProfColor') },
                ] as const
              ).map((pf) => (
                <button
                  key={pf.id}
                  type="button"
                  onClick={() => applyPaperProfile(pf.id)}
                  className={`py-2 px-1.5 rounded-xl border text-[11px] font-bold transition-colors ${
                    paperProfile === pf.id
                      ? 'bg-desk-panel border-ink-brass text-desk-text shadow-sm'
                      : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
                  }`}
                >
                  {pf.label}
                </button>
              ))}
            </div>

            {/* 2. Essential 1-Click Pegbar Alignment Toggle */}
            <KeycapButton
              size="sm"
              led={autoRegister ? 'emerald' : 'off'}
              pressed={autoRegister}
              sound="toggle"
              onClick={() => setAutoRegister((v) => !v)}
              className="w-full justify-between"
            >
              <span>{t('paperAutoAlign')}</span>
              <span className="font-mono text-[11px]">{autoRegister ? t('paperOn') : t('paperOff')}</span>
            </KeycapButton>

            {/* 3. Collapsible Fine-Tune Accordion (Collapsed by Default for Calm UX!) */}
            <div className="rounded-2xl console-well border border-desk-border overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  soundEngine.click(1.02);
                  setShowFineTune((v) => !v);
                }}
                aria-expanded={showFineTune}
                className="w-full px-3.5 py-2.5 flex items-center justify-between font-mono text-[11px] uppercase tracking-wider text-desk-muted hover:text-desk-text transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-ink-brass" />
                  {t('paperFineTune')} ({sensitivity}% ·{' '}
                  {stripBluePencil ? t('paperBlueStripShort') : t('paperNaturalShort')})
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform ${showFineTune ? 'rotate-180' : ''}`}
                />
              </button>

              {showFineTune && (
                <div className="px-3.5 pb-3.5 pt-2 border-t border-desk-border space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <KeycapButton
                      size="sm"
                      led={transparentBg ? 'emerald' : 'off'}
                      pressed={transparentBg}
                      sound="toggle"
                      onClick={() => setTransparentBg((v) => !v)}
                    >
                      {t('paperTransparentCel')}
                    </KeycapButton>
                    <KeycapButton
                      size="sm"
                      led={preserveColor ? 'amber' : 'off'}
                      pressed={preserveColor}
                      sound="toggle"
                      onClick={() => setPreserveColor((v) => !v)}
                    >
                      {t('paperKeepColor')}
                    </KeycapButton>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <KeycapButton
                      size="sm"
                      variant={stripBluePencil ? 'blue' : 'graphite'}
                      led={stripBluePencil ? 'blue' : 'off'}
                      pressed={stripBluePencil}
                      sound="toggle"
                      onClick={() => setStripBluePencil((v) => !v)}
                    >
                      {t('paperStripBlue')}
                    </KeycapButton>
                    <KeycapButton
                      size="sm"
                      led={stripRedPencil ? 'vermilion' : 'off'}
                      pressed={stripRedPencil}
                      sound="toggle"
                      onClick={() => setStripRedPencil((v) => !v)}
                    >
                      {t('paperStripRed')}
                    </KeycapButton>
                  </div>

                  <div>
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-1">
                      <span>{t('paperSensitivity')}</span>
                      <span className="text-desk-text">{sensitivity}%</span>
                    </div>
                    <input
                      type="range"
                      min={15}
                      max={95}
                      value={sensitivity}
                      onChange={(e) => setSensitivity(Number(e.target.value))}
                      className="studio-fader w-full"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-1">
                      <span>{t('paperInkDarkness')}</span>
                      <span className="text-desk-text">{inkStrength}%</span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={inkStrength}
                      onChange={(e) => setInkStrength(Number(e.target.value))}
                      className="studio-fader w-full"
                    />
                  </div>
                </div>
              )}
            </div>

            {captureCount > 0 && (
              <KeycapButton
                size="md"
                variant="brass"
                onClick={() => setMode('draw')}
                className="w-full"
              >
                {t('paperReturnDraw')} ({captureCount} {t('paperAddedSuffix')})
              </KeycapButton>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
