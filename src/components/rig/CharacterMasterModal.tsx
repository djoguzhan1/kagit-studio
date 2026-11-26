import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Eraser,
  FileSpreadsheet,
  KeyRound,
  Move,
  Pencil,
  RotateCcw,
  Scissors,
  ShieldCheck,
  Smile,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import type {
  CharacterMasterRig,
  CharacterViewAngle,
  CustomMouthKey,
  RigViewSlot,
  ViewAnchors,
} from '../../types/masterRig';
import { countRigViews, defaultViewAnchors } from '../../types/masterRig';
import type { CustomSlitLine, UniversalCreatureClass } from '../../engine/conformingMeshEngine';
import { UNIVERSAL_CREATURE_CATALOG } from '../../engine/universalCreatureRig';
import {
  alignViewCanvasToReference,
  applyStyleLockToCanvas,
  assignItemsToViewAngles,
  extractViewAnchorsFromCanvas,
  splitMultiPoseSheetCanvas,
} from '../../engine/turnaroundSlicer';
import { MasterRigRuntimeCache, renderMasterRigCharacter } from '../../engine/viewRigBlender';
import {
  analyzeDrawingAnatomyFromPixels,
  evaluateCartoonDancePose,
} from '../../engine/cartoonMotionEngine';
import { buildRiggedCharacterPack, type RiggedCharacterPack } from '../../engine/skeletonSkinEngine';
import { prepareCharacterCanvas } from '../../engine/characterIntakeEngine';
import {
  getSavedByokGeminiKey,
  requestAiSideProfileGuide,
  setSavedByokGeminiKey,
} from '../../engine/aiStudioClient';
import { soundEngine } from '../../engine/soundEngine';
import { useT, type TranslationKey } from '../../i18n/translations';

interface CharacterMasterModalProps {
  open: boolean;
  initialRig: CharacterMasterRig;
  onClose: () => void;
  onSave: (rig: CharacterMasterRig) => void;
}

const CREATURE_OPTIONS: Array<{ id: UniversalCreatureClass; icon: string; key: TranslationKey }> = [
  { id: 'humanoid', icon: '🧍', key: 'v4CreatureHumanoid' },
  { id: 'quadruped', icon: '🐾', key: 'v4CreatureQuadruped' },
  { id: 'avian_winged', icon: '🦅', key: 'v4CreatureAvian' },
  { id: 'aquatic_fish', icon: '🐟', key: 'v4CreatureAquatic' },
  { id: 'serpentine_tentacle', icon: '🐍', key: 'v4CreatureSerpentine' },
  { id: 'biped_tailed', icon: '🦖', key: 'v4CreatureBipedTailed' },
  { id: 'amorphous_vehicle', icon: '✨', key: 'v4CreatureAmorphous' },
];

const ANGLE_CARDS: Array<{ angle: CharacterViewAngle; labelKey: TranslationKey; yawSnap: number }> = [
  { angle: 'front', labelKey: 'v4SlotFront', yawSnap: 0 },
  { angle: 'side', labelKey: 'v4SlotSide', yawSnap: 90 },
  { angle: 'back', labelKey: 'v4SlotBack', yawSnap: 180 },
  { angle: 'threeQuarter', labelKey: 'v4SlotThreeQuarter', yawSnap: 45 },
];

const DEFAULT_JOINT_PINS: Array<{ id: string; labelTr: string; x: number; y: number }> = [
  { id: 'head', labelTr: 'Baş', x: 0.5, y: 0.22 },
  { id: 'shoulderL', labelTr: 'Omuz Sol', x: 0.36, y: 0.36 },
  { id: 'shoulderR', labelTr: 'Omuz Sağ', x: 0.64, y: 0.36 },
  { id: 'handL', labelTr: 'El Sol', x: 0.22, y: 0.56 },
  { id: 'handR', labelTr: 'El Sağ', x: 0.78, y: 0.56 },
  { id: 'footL', labelTr: 'Ayak Sol', x: 0.39, y: 0.90 },
  { id: 'footR', labelTr: 'Ayak Sağ', x: 0.61, y: 0.90 },
];

const MOUTH_KEYS: Array<{ id: CustomMouthKey; label: string }> = [
  { id: 'closed', label: 'Kapalı' },
  { id: 'A', label: 'A' },
  { id: 'E', label: 'E' },
  { id: 'O', label: 'O' },
];

function loadCanvasFromUrl(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 512;
      c.height = img.naturalHeight || 512;
      const ctx = c.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('image_load_failed'));
    img.src = url;
  });
}

function loadFileToCanvas(file: File): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      loadCanvasFromUrl(dataUrl).then(resolve).catch(reject);
    };
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

export default function CharacterMasterModal({
  open,
  initialRig,
  onClose,
  onSave,
}: CharacterMasterModalProps) {
  const t = useT();
  const [draft, setDraft] = useState<CharacterMasterRig>(initialRig);
  const [activeTab, setActiveTab] = useState<'angles' | 'joints' | 'face'>('angles');
  const [previewAngleDeg, setPreviewAngleDeg] = useState<number>(0);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'amber' | 'info' } | null>(null);

  // Light-Table Tracing Canvas state (for drawing Side / Back / 3-4 directly over blue 5-line guides!)
  const [tracingAngle, setTracingAngle] = useState<Exclude<CharacterViewAngle, 'front'> | null>(null);
  const [traceUnderlayUrl, setTraceUnderlayUrl] = useState<string | null>(null);
  const [traceTool, setTraceTool] = useState<'pen' | 'eraser'>('pen');
  const [traceNibBold, setTraceNibBold] = useState(false);
  const traceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const traceDrawingRef = useRef(false);
  const traceHistoryRef = useRef<ImageData[]>([]);
  const traceLastPtRef = useRef<{ x: number; y: number } | null>(null);

  // Optional AI Side-Guide Drawer state (strictly opt-in, NEVER alters Front!)
  const [aiDrawerAngle, setAiDrawerAngle] = useState<Exclude<CharacterViewAngle, 'front'> | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [pendingAiApproval, setPendingAiApproval] = useState<{
    angle: Exclude<CharacterViewAngle, 'front'>;
    rawUrl: string;
    styledUrl: string;
    styledSlot: RigViewSlot;
    cached?: boolean;
  } | null>(null);
  const [showByokInput, setShowByokInput] = useState(false);
  const [byokKey, setByokKey] = useState(() => getSavedByokGeminiKey());

  // Tab 2: 5-second Joint Pin & Scissors Calibrator state
  const [jointTool, setJointTool] = useState<'pin' | 'scissors'>('pin');
  const [draggingPinId, setDraggingPinId] = useState<string | null>(null);
  const [pendingSlitStart, setPendingSlitStart] = useState<{ x: number; y: number } | null>(null);
  const [pendingSlitCur, setPendingSlitCur] = useState<{ x: number; y: number } | null>(null);
  const jointSurfaceRef = useRef<HTMLDivElement | null>(null);

  // Live 360° Preview Refs
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frontPackRef = useRef<RiggedCharacterPack | null>(null);
  const rigCacheRef = useRef<MasterRigRuntimeCache | null>(null);

  // Hidden file inputs
  const singleSlotInputRef = useRef<HTMLInputElement | null>(null);
  const singleSlotTargetRef = useRef<CharacterViewAngle>('side');
  const batchPhotosInputRef = useRef<HTMLInputElement | null>(null);
  const multiSheetInputRef = useRef<HTMLInputElement | null>(null);
  const mouthInputRef = useRef<HTMLInputElement | null>(null);
  const mouthTargetRef = useRef<CustomMouthKey>('A');

  useEffect(() => {
    if (open) {
      setDraft(initialRig);
      setActiveTab('angles');
      setTracingAngle(null);
      setTraceUnderlayUrl(null);
      setAiDrawerAngle(null);
      setPendingAiApproval(null);
      setNotice(null);
      setPreviewAngleDeg(0);
    }
  }, [open, initialRig]);

  // Keep live 360° preview rig cache synced whenever draft views or creatureClass changes
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const frontUrl = draft.views.front?.dataUrl;
    if (!frontUrl) return;

    if (!rigCacheRef.current) {
      rigCacheRef.current = new MasterRigRuntimeCache(draft);
    } else {
      rigCacheRef.current.syncRig(draft);
    }

    void loadCanvasFromUrl(frontUrl).then((canvas) => {
      if (cancelled) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const anatomy = analyzeDrawingAnatomyFromPixels(rgba, canvas.width, canvas.height);
      const pack = buildRiggedCharacterPack(canvas, anatomy, {
        creatureClass: draft.creatureClass,
        meshOptions: {
          customSlitLines: draft.customSlitLines,
          jointOverrides: draft.jointOverrides,
        },
      });
      frontPackRef.current = pack;
      rigCacheRef.current?.prewarmAngle('front', pack, frontUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [open, draft]);

  // Dispose preview cache on close
  useEffect(() => {
    if (!open && rigCacheRef.current) {
      rigCacheRef.current.dispose();
      rigCacheRef.current = null;
      frontPackRef.current = null;
    }
  }, [open]);

  // Live 360° animated preview loop (~30 FPS light preview)
  useEffect(() => {
    if (!open) return;
    let rafId = 0;
    const startMs = performance.now();

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      const canvas = previewCanvasRef.current;
      const pack = frontPackRef.current;
      if (!canvas || !pack) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const tSec = (now - startMs) * 0.001;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Subtle ivory drafting table ring under feet
      ctx.save();
      ctx.fillStyle = 'rgba(28, 25, 23, 0.10)';
      ctx.beginPath();
      ctx.ellipse(canvas.width * 0.5, canvas.height * 0.88, canvas.width * 0.28, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const pose = evaluateCartoonDancePose(tSec, null, 24, 'natural');
      const pad = 12;
      const bounds = {
        x: pad,
        y: pad,
        w: canvas.width - pad * 2,
        h: canvas.height - pad * 2 - 4,
      };
      const defaultAction = UNIVERSAL_CREATURE_CATALOG[draft.creatureClass].defaultAction;

      renderMasterRigCharacter(ctx, rigCacheRef.current, pack, pose, bounds, {
        boilTick: Math.floor(tSec * 6),
        yawDeg: previewAngleDeg,
        universalAction: defaultAction,
      });
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [open, previewAngleDeg, draft.creatureClass]);

  const refAnchors: ViewAnchors = draft.views.front?.anchors ?? defaultViewAnchors();
  const viewCount = countRigViews(draft);

  const handleUploadSlotFile = useCallback(
    async (file: File, angle: CharacterViewAngle) => {
      try {
        const rawCanvas = await loadFileToCanvas(file);
        const prepared = prepareCharacterCanvas(rawCanvas);
        const cleanCanvas = prepared.canvas;
        if (angle === 'front') {
          const anchors = extractViewAnchorsFromCanvas(cleanCanvas);
          const slot: RigViewSlot = {
            angle: 'front',
            dataUrl: cleanCanvas.toDataURL('image/png'),
            source: 'original_drawing',
            anchors,
            width: cleanCanvas.width,
            height: cleanCanvas.height,
            createdAt: Date.now(),
          };
          setDraft((prev) => ({
            ...prev,
            views: { ...prev.views, front: slot },
            updatedAt: Date.now(),
          }));
        } else {
          const aligned = alignViewCanvasToReference(cleanCanvas, refAnchors, angle, 'original_drawing', 512);
          setDraft((prev) => ({
            ...prev,
            views: { ...prev.views, [angle]: aligned },
            updatedAt: Date.now(),
          }));
          setPreviewAngleDeg(angle === 'side' ? 90 : angle === 'back' ? 180 : 45);
        }
        soundEngine.click(1.18);
        setNotice(null);
      } catch {
        setNotice({ text: 'Görsel okunamadı, lütfen başka bir çizim dene.', tone: 'amber' });
      }
    },
    [refAnchors]
  );

  const handleUploadBatchPhotos = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith('image/')).slice(0, 4);
      if (images.length === 0) return;
      try {
        const hasExistingFront = Boolean(draft.views.front?.dataUrl);
        const emptyAngles = (['front', 'side', 'back', 'threeQuarter'] as CharacterViewAngle[]).filter(
          (a) => !draft.views[a]
        );
        const mapped = assignItemsToViewAngles(images, {
          requireFront: !hasExistingFront,
          preferEmptyAngles: emptyAngles.length >= images.length ? emptyAngles : undefined,
        });

        let activeRef = refAnchors;
        const nextUpdates: Partial<Record<CharacterViewAngle, RigViewSlot>> = {};
        let addedCount = 0;

        for (const entry of mapped) {
          const rawCanvas = await loadFileToCanvas(entry.item);
          const prepared = prepareCharacterCanvas(rawCanvas);
          if (prepared.empty) continue;
          const cleanCanvas = prepared.canvas;
          if (entry.angle === 'front') {
            const anchors = extractViewAnchorsFromCanvas(cleanCanvas);
            activeRef = anchors;
            nextUpdates.front = {
              angle: 'front',
              dataUrl: cleanCanvas.toDataURL('image/png'),
              source: 'original_drawing',
              anchors,
              width: cleanCanvas.width,
              height: cleanCanvas.height,
              createdAt: Date.now(),
            };
          } else {
            nextUpdates[entry.angle] = alignViewCanvasToReference(
              cleanCanvas,
              activeRef,
              entry.angle,
              'original_drawing',
              512
            );
          }
          addedCount++;
        }

        if (addedCount === 0) {
          setNotice({ text: 'Görsel okunamadı, lütfen başka bir çizim dene.', tone: 'amber' });
          return;
        }

        setDraft((prev) => ({
          ...prev,
          views: { ...prev.views, ...nextUpdates },
          updatedAt: Date.now(),
        }));
        setPreviewAngleDeg(nextUpdates.side ? 90 : nextUpdates.back ? 180 : 45);
        soundEngine.click(1.22);
        setNotice({ text: `✓ ${addedCount} ${t('v4MultiPhotosSuccess')}`, tone: 'ok' });
      } catch {
        setNotice({ text: 'Görseller okunamadı, lütfen tekrar dene.', tone: 'amber' });
      }
    },
    [draft.views, refAnchors, t]
  );

  const handleUploadMultiPoseA4 = useCallback(
    async (file: File) => {
      try {
        const rawCanvas = await loadFileToCanvas(file);
        const { slots } = splitMultiPoseSheetCanvas(rawCanvas, 512);
        if (slots.length < 2) {
          setNotice({ text: t('v4MultiPoseSingleWarn'), tone: 'amber' });
          return;
        }
        setDraft((prev) => {
          const nextViews = { ...prev.views };
          for (const s of slots) {
            // Keep existing front intact if user already had one and only wanted secondary? Actually multi-sheet replaces consistently so all heights match 0.0px!
            nextViews[s.angle] = s;
          }
          return {
            ...prev,
            views: nextViews,
            updatedAt: Date.now(),
          };
        });
        setPreviewAngleDeg(45);
        soundEngine.click(1.24);
        setNotice({ text: `✓ ${slots.length} ${t('v4MultiPoseSuccess')}`, tone: 'ok' });
      } catch {
        setNotice({ text: t('v4MultiPoseSingleWarn'), tone: 'amber' });
      }
    },
    [t]
  );

  // Light-Table Tracing Canvas handlers (draw Side/Back/3-4 cleanly over blue 5-line anchor grid!)
  const openTracePad = useCallback(
    (angle: Exclude<CharacterViewAngle, 'front'>, underlayUrl: string | null = null) => {
      setTracingAngle(angle);
      setTraceUnderlayUrl(underlayUrl ?? draft.views.front?.dataUrl ?? null);
      setTraceTool('pen');
      traceHistoryRef.current = [];
      setTimeout(() => {
        const c = traceCanvasRef.current;
        if (!c) return;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, c.width, c.height);
        // If user already drew/uploaded this slot and clicked edit without AI underlay, load it onto pad
        const existingUrl = !underlayUrl ? draft.views[angle]?.dataUrl : null;
        if (existingUrl) {
          void loadCanvasFromUrl(existingUrl).then((imgCanvas) => {
            ctx.drawImage(imgCanvas, 0, 0, c.width, c.height);
          });
        }
      }, 30);
    },
    [draft.views]
  );

  const getTraceCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = traceCanvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * c.width,
      y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * c.height,
    };
  };

  const onTraceDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = traceCanvasRef.current;
    const ctx = c?.getContext('2d', { willReadFrequently: true });
    if (!c || !ctx) return;
    c.setPointerCapture(e.pointerId);
    traceHistoryRef.current.push(ctx.getImageData(0, 0, c.width, c.height));
    if (traceHistoryRef.current.length > 20) traceHistoryRef.current.shift();
    traceDrawingRef.current = true;
    const pt = getTraceCoords(e);
    traceLastPtRef.current = pt;
    ctx.save();
    ctx.globalCompositeOperation = traceTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = '#1C1917';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, traceTool === 'eraser' ? 14 : traceNibBold ? 5.5 : 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const onTraceMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!traceDrawingRef.current) return;
    const c = traceCanvasRef.current;
    const ctx = c?.getContext('2d');
    const prev = traceLastPtRef.current;
    if (!c || !ctx || !prev) return;
    const pt = getTraceCoords(e);
    ctx.save();
    ctx.globalCompositeOperation = traceTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#1C1917';
    ctx.lineWidth = traceTool === 'eraser' ? 28 : traceNibBold ? 11 : 6.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    ctx.restore();
    traceLastPtRef.current = pt;
  };

  const onTraceUp = () => {
    traceDrawingRef.current = false;
    traceLastPtRef.current = null;
  };

  const handleSaveTracedAngle = () => {
    const c = traceCanvasRef.current;
    if (!c || !tracingAngle) return;
    const aligned = alignViewCanvasToReference(c, refAnchors, tracingAngle, 'traced_drawing', 512);
    setDraft((prev) => ({
      ...prev,
      views: { ...prev.views, [tracingAngle]: aligned },
      updatedAt: Date.now(),
    }));
    setPreviewAngleDeg(tracingAngle === 'side' ? 90 : tracingAngle === 'back' ? 180 : 45);
    setTracingAngle(null);
    setTraceUnderlayUrl(null);
    soundEngine.click(1.2);
  };

  // Optional AI Side-Profile Guide handler (strictly opt-in!)
  const handleRunAiDraft = async (mode: 'trace' | 'style_lock') => {
    const frontUrl = draft.views.front?.dataUrl;
    if (!frontUrl || !aiDrawerAngle) return;
    setAiBusy(true);
    setNotice(null);
    try {
      const res = await requestAiSideProfileGuide({
        frontDataUrl: frontUrl,
        creatureClass: draft.creatureClass,
        targetAngle: aiDrawerAngle,
        byokGeminiKey: byokKey.trim() || undefined,
      });
      if (!res.ok || !res.imageDataUrl) {
        setNotice({
          text: res.code === 'daily_limit' || res.code === 'budget_capped' ? t('v4AiLimitNotice') : (res.error || t('v4AiLimitNotice')),
          tone: 'amber',
        });
        return;
      }

      if (mode === 'trace') {
        // 0% AI pixels in final character! Open AI draft as blue light-table tracing guide!
        const target = aiDrawerAngle;
        setAiDrawerAngle(null);
        openTracePad(target, res.imageDataUrl);
        return;
      }

      // Style-Lock Direct Mode: strip white paper + lock to artist's palette/ink/grain + align height + side-by-side approval!
      const [aiCanvas, frontCanvas] = await Promise.all([
        loadCanvasFromUrl(res.imageDataUrl),
        loadCanvasFromUrl(frontUrl),
      ]);
      const cleanAi = prepareCharacterCanvas(aiCanvas).canvas;
      const styledAi = applyStyleLockToCanvas(cleanAi, frontCanvas, 0.78);
      const alignedSlot = alignViewCanvasToReference(styledAi, refAnchors, aiDrawerAngle, 'ai_style_locked', 512);

      setPendingAiApproval({
        angle: aiDrawerAngle,
        rawUrl: res.imageDataUrl,
        styledUrl: alignedSlot.dataUrl,
        styledSlot: alignedSlot,
        cached: res.cached,
      });
    } finally {
      setAiBusy(false);
    }
  };

  // Tab 2: 5-second Joint Pins & Scissors Slit interaction
  const getJointUV = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = jointSurfaceRef.current?.getBoundingClientRect();
    if (!box) return { x: 0.5, y: 0.5 };
    return {
      x: Math.max(0.03, Math.min(0.97, (e.clientX - box.left) / Math.max(1, box.width))),
      y: Math.max(0.03, Math.min(0.97, (e.clientY - box.top) / Math.max(1, box.height))),
    };
  };

  const handleJointPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (jointTool === 'scissors') {
      const uv = getJointUV(e);
      setPendingSlitStart(uv);
      setPendingSlitCur(uv);
    }
  };

  const handleJointPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const uv = getJointUV(e);
    if (draggingPinId) {
      setDraft((prev) => ({
        ...prev,
        jointOverrides: {
          ...(prev.jointOverrides ?? {}),
          [draggingPinId]: uv,
        },
        updatedAt: Date.now(),
      }));
    } else if (pendingSlitStart) {
      setPendingSlitCur(uv);
    }
  };

  const handleJointPointerUp = () => {
    if (draggingPinId) {
      setDraggingPinId(null);
    }
    if (pendingSlitStart && pendingSlitCur) {
      const dist = Math.hypot(pendingSlitCur.x - pendingSlitStart.x, pendingSlitCur.y - pendingSlitStart.y);
      if (dist > 0.04) {
        const nextLine: CustomSlitLine = {
          x0: pendingSlitStart.x,
          y0: pendingSlitStart.y,
          x1: pendingSlitCur.x,
          y1: pendingSlitCur.y,
        };
        setDraft((prev) => ({
          ...prev,
          customSlitLines: [...(prev.customSlitLines ?? []).slice(-5), nextLine],
          updatedAt: Date.now(),
        }));
        soundEngine.click(1.16);
      }
      setPendingSlitStart(null);
      setPendingSlitCur(null);
    }
  };

  const handleUploadCustomMouth = async (file: File, mouthKey: CustomMouthKey) => {
    try {
      const rawCanvas = await loadFileToCanvas(file);
      const clean = prepareCharacterCanvas(rawCanvas).canvas;
      const url = clean.toDataURL('image/png');
      setDraft((prev) => ({
        ...prev,
        faceSprites: {
          autoInkStyle: false,
          ...(prev.faceSprites ?? {}),
          mouths: {
            ...(prev.faceSprites?.mouths ?? {}),
            [mouthKey]: url,
          },
        },
        updatedAt: Date.now(),
      }));
      soundEngine.click(1.14);
    } catch {
      // ignore
    }
  };

  if (!open) return null;

  const modalNode = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-2 sm:p-4 bg-black/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('v4ModalTitle')}
    >
      <div className="relative w-full max-w-3xl max-h-[92dvh] flex flex-col rounded-2xl bg-desk-panel/95 border border-ink-brass/40 shadow-2xl overflow-hidden text-desk-ink">
        {/* Hidden file inputs */}
        <input
          ref={singleSlotInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void handleUploadSlotFile(f, singleSlotTargetRef.current);
          }}
        />
        <input
          ref={batchPhotosInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) void handleUploadBatchPhotos(files);
          }}
        />
        <input
          ref={multiSheetInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void handleUploadMultiPoseA4(f);
          }}
        />
        <input
          ref={mouthInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void handleUploadCustomMouth(f, mouthTargetRef.current);
          }}
        />

        {/* HEADER + LIVE 360° PREVIEW */}
        <div className="px-4 py-3 border-b border-desk-border/80 bg-desk-surface/60">
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="w-4 h-4 text-ink-brass shrink-0" />
              <h2 className="text-sm sm:text-base font-bold tracking-tight truncate">
                {t('v4ModalTitle')}
              </h2>
              <span
                className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold shrink-0 ${
                  viewCount >= 3
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                    : 'bg-ink-brass/15 text-ink-brass border border-ink-brass/35'
                }`}
              >
                {viewCount >= 3 ? `${t('v4Ready360')} (${viewCount}/4)` : `${viewCount}/4`}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-desk-muted hover:text-desk-ink hover:bg-white/5 transition-colors"
              aria-label={t('exportCloseAria')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-3">
            {/* Compact Backlit Live 360° Preview */}
            <div className="relative w-28 h-28 sm:w-32 sm:h-32 shrink-0 rounded-xl bg-[#F8F4EC] border border-ink-brass/40 shadow-inner overflow-hidden flex items-center justify-center">
              <canvas ref={previewCanvasRef} width={160} height={160} className="w-full h-full block" />
              <span className="absolute bottom-1 right-1.5 px-1.5 py-0.5 rounded bg-neutral-950/75 text-[9.5px] font-mono text-ink-brass">
                {previewAngleDeg > 0 ? `+${previewAngleDeg}°` : `${previewAngleDeg}°`}
              </span>
            </div>

            <div className="flex-1 w-full min-w-0 space-y-2">
              {/* 360° Smooth Turn Slider + Quick Angle Snaps */}
              <div>
                <div className="flex items-center justify-between text-[11px] font-semibold mb-1">
                  <span className="text-desk-muted">{t('v4TurnPreviewLabel')}</span>
                  <div className="flex items-center gap-1">
                    {[
                      { label: '0°', val: 0 },
                      { label: '45°', val: 45 },
                      { label: '90°', val: 90 },
                      { label: '180°', val: 180 },
                      { label: '-90°', val: -90 },
                    ].map((s) => (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => setPreviewAngleDeg(s.val)}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors ${
                          Math.abs(previewAngleDeg - s.val) <= 8
                            ? 'bg-ink-brass text-neutral-950'
                            : 'bg-white/5 text-desk-muted hover:text-desk-ink'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={3}
                  value={previewAngleDeg}
                  onChange={(e) => setPreviewAngleDeg(Number(e.target.value))}
                  className="w-full accent-ink-brass h-1.5 rounded-lg cursor-pointer"
                />
              </div>

              {/* 7-Class Universal Creature Type Selector */}
              <div>
                <div className="text-[10.5px] font-semibold text-desk-muted mb-1">
                  {t('v4CreatureTypeLabel')}
                </div>
                <div className="flex flex-wrap gap-1">
                  {CREATURE_OPTIONS.map((c) => {
                    const active = draft.creatureClass === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          soundEngine.click(1.1);
                          setDraft((prev) => ({
                            ...prev,
                            creatureClass: c.id,
                            updatedAt: Date.now(),
                          }));
                        }}
                        className={`px-2 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1 transition-all ${
                          active
                            ? 'bg-ink-brass text-neutral-950 shadow'
                            : 'bg-white/5 border border-desk-border text-desk-muted hover:text-desk-ink hover:border-ink-brass/40'
                        }`}
                      >
                        <span>{c.icon}</span>
                        <span>{t(c.key)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 3 CLEAN TABS */}
        <div className="px-3 sm:px-4 pt-2 border-b border-desk-border flex items-center gap-0.5 sm:gap-1 bg-desk-panel overflow-x-auto">
          {(
            [
              { id: 'angles', label: t('v4TabAngles') },
              { id: 'joints', label: t('v4TabJoints') },
              { id: 'face', label: t('v4TabFace') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                soundEngine.click(1.06);
                setActiveTab(tab.id);
              }}
              className={`px-2.5 sm:px-3 py-2 text-[11px] sm:text-xs font-bold border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === tab.id
                  ? 'border-ink-brass text-ink-brass'
                  : 'border-transparent text-desk-muted hover:text-desk-ink'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* BODY CONTENT */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {notice && (
            <div
              className={`px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 border ${
                notice.tone === 'ok'
                  ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
                  : notice.tone === 'amber'
                    ? 'bg-amber-500/15 border-amber-400/40 text-amber-200'
                    : 'bg-white/5 border-desk-border text-desk-ink'
              }`}
            >
              <span>{notice.text}</span>
              <button type="button" onClick={() => setNotice(null)} className="opacity-70 hover:opacity-100">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* ================= TAB 1: 2.5D ANGLES ================= */}
          {activeTab === 'angles' && !tracingAngle && (
            <div
              className="space-y-3"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'));
                if (files.length > 0) void handleUploadBatchPhotos(files);
              }}
            >
              {/* 4 Backlit Polaroid Angle Slots */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {ANGLE_CARDS.map(({ angle, labelKey, yawSnap }) => {
                  const slot = draft.views[angle];
                  const isFront = angle === 'front';
                  return (
                    <div
                      key={angle}
                      className={`rounded-xl border p-2 flex flex-col gap-2 transition-all ${
                        slot
                          ? 'bg-desk-surface/75 border-ink-brass/45'
                          : 'bg-desk-surface/35 border-desk-border/80'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-bold">{t(labelKey)}</span>
                        {slot ? (
                          <span
                            className={`px-1.5 py-0.5 rounded-full text-[9.5px] font-bold ${
                              isFront
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-ink-brass/20 text-ink-brass'
                            }`}
                          >
                            {isFront
                              ? `✓ ${t('v4BadgeOriginal')}`
                              : slot.source === 'traced_drawing'
                                ? `✓ ${t('v4BadgeTraced')}`
                                : '✓'}
                          </span>
                        ) : (
                          <span className="text-[9.5px] text-desk-muted">{t('v4BadgeOptional')}</span>
                        )}
                      </div>

                      {/* Polaroid Ivory Paper Frame */}
                      <button
                        type="button"
                        onClick={() => {
                          if (slot) {
                            setPreviewAngleDeg(yawSnap);
                          } else if (!isFront) {
                            singleSlotTargetRef.current = angle;
                            singleSlotInputRef.current?.click();
                          }
                        }}
                        className="relative aspect-square w-full rounded-lg bg-[#F8F4EC] border border-black/10 overflow-hidden flex items-center justify-center group"
                      >
                        {slot ? (
                          <img
                            src={slot.dataUrl}
                            alt={t(labelKey)}
                            className="w-full h-full object-contain p-1.5"
                          />
                        ) : (
                          <div className="flex flex-col items-center gap-1 text-neutral-500 group-hover:text-neutral-800">
                            <Upload className="w-5 h-5" />
                            <span className="text-[10px] font-bold">+</span>
                          </div>
                        )}
                      </button>

                      {/* Clean Action Buttons per Slot */}
                      {isFront ? (
                        <button
                          type="button"
                          onClick={() => {
                            singleSlotTargetRef.current = 'front';
                            singleSlotInputRef.current?.click();
                          }}
                          className="w-full py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-desk-border text-[10.5px] font-bold inline-flex items-center justify-center gap-1"
                        >
                          <Upload className="w-3 h-3 text-ink-brass" />
                          {t('v4BtnUpload')}
                        </button>
                      ) : (
                        <div className="space-y-1">
                          <div className="grid grid-cols-2 gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                singleSlotTargetRef.current = angle;
                                singleSlotInputRef.current?.click();
                              }}
                              className="py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-desk-border text-[10px] font-bold inline-flex items-center justify-center gap-1"
                            >
                              <Upload className="w-3 h-3 text-ink-brass" />
                              {t('v4BtnUpload')}
                            </button>
                            <button
                              type="button"
                              onClick={() => openTracePad(angle)}
                              className="py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-desk-border text-[10px] font-bold inline-flex items-center justify-center gap-1"
                            >
                              <Pencil className="w-3 h-3 text-ink-brass" />
                              {t('v4BtnDrawOnDesk')}
                            </button>
                          </div>

                          <div className="flex items-center gap-1">
                            {(angle === 'side' || angle === 'back') && (
                              <button
                                type="button"
                                onClick={() => {
                                  soundEngine.click(1.1);
                                  setAiDrawerAngle((cur) => (cur === angle ? null : angle));
                                  setPendingAiApproval(null);
                                }}
                                className={`flex-1 py-1 rounded-lg text-[10px] font-bold inline-flex items-center justify-center gap-1 border transition-colors ${
                                  aiDrawerAngle === angle
                                    ? 'bg-amber-500/25 border-amber-400/60 text-amber-200'
                                    : 'bg-ink-brass/10 hover:bg-ink-brass/20 border-ink-brass/30 text-ink-brass'
                                }`}
                              >
                                <Sparkles className="w-3 h-3" />
                                {t('v4BtnAiDraft')}
                              </button>
                            )}
                            {slot && (
                              <button
                                type="button"
                                onClick={() => {
                                  setDraft((prev) => {
                                    const next = { ...prev.views };
                                    delete next[angle];
                                    return { ...prev, views: next, updatedAt: Date.now() };
                                  });
                                }}
                                className="p-1 rounded-lg bg-white/5 hover:bg-red-500/20 text-desk-muted hover:text-red-300 border border-desk-border"
                                title={t('v4BtnRemove')}
                                aria-label={t('v4BtnRemove')}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Clean 2-Option Multi-Angle Upload Row: Batch Photos OR Single A4 Sheet */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => batchPhotosInputRef.current?.click()}
                  className="py-2.5 px-3 rounded-xl bg-ink-brass/15 hover:bg-ink-brass/25 border border-ink-brass/45 text-ink-brass text-xs font-bold inline-flex items-center justify-center gap-2 transition-colors"
                >
                  <Upload className="w-4 h-4 shrink-0" />
                  <span>{t('v4BtnMultiPhotos')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => multiSheetInputRef.current?.click()}
                  className="py-2.5 px-3 rounded-xl bg-white/5 hover:bg-white/10 border border-desk-border hover:border-ink-brass/45 text-desk-ink text-xs font-bold inline-flex items-center justify-center gap-2 transition-colors"
                >
                  <FileSpreadsheet className="w-4 h-4 text-ink-brass shrink-0" />
                  <span>{t('v4BtnMultiPoseShort')}</span>
                </button>
              </div>

              {/* Strictly OPTIONAL AI Side-Profile Guide Drawer */}
              {aiDrawerAngle && (
                <div className="rounded-xl border border-amber-400/40 bg-amber-950/25 p-3 space-y-2.5">
                  <div className="flex items-start gap-2 text-xs text-amber-200">
                    <ShieldCheck className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                    <span className="font-semibold">{t('v4AiShieldNotice')}</span>
                  </div>

                  {!pendingAiApproval ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={aiBusy}
                          onClick={() => void handleRunAiDraft('trace')}
                          className="py-2 px-3 rounded-xl bg-emerald-600/85 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 shadow transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5 shrink-0" />
                          <span>{aiBusy ? t('v4AiGenerating') : t('v4AiTraceModeBtn')}</span>
                        </button>
                        <button
                          type="button"
                          disabled={aiBusy}
                          onClick={() => void handleRunAiDraft('style_lock')}
                          className="py-2 px-3 rounded-xl bg-white/10 hover:bg-white/15 disabled:opacity-50 border border-white/20 text-desk-ink text-xs font-bold inline-flex items-center justify-center gap-1.5 transition-colors"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-ink-brass shrink-0" />
                          <span>{aiBusy ? t('v4AiGenerating') : t('v4AiStyleLockBtn')}</span>
                        </button>
                      </div>

                      {/* Optional Personal Gemini Key Accordion (Zero Server Cost!) */}
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => setShowByokInput((v) => !v)}
                          className="text-[10.5px] text-desk-muted hover:text-ink-brass inline-flex items-center gap-1"
                        >
                          <KeyRound className="w-3 h-3" />
                          <span>{showByokInput ? 'Kişisel anahtarı gizle' : 'İsteğe bağlı: Kişisel Gemini anahtarı kullan'}</span>
                        </button>
                        {showByokInput && (
                          <input
                            type="password"
                            value={byokKey}
                            onChange={(e) => {
                              setByokKey(e.target.value);
                              setSavedByokGeminiKey(e.target.value);
                            }}
                            placeholder="AIza... (Yalnızca bu tarayıcı oturumunda kalır)"
                            className="mt-1.5 w-full px-2.5 py-1.5 rounded-lg bg-black/30 border border-desk-border text-xs text-desk-ink"
                          />
                        )}
                      </div>
                    </div>
                  ) : (
                    /* Side-by-Side Comparison & Artist Approval Gate */
                    <div className="space-y-2.5">
                      <div className="text-xs font-bold text-ink-brass">{t('v4AiApproveTitle')}</div>
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="rounded-lg bg-[#F8F4EC] p-2 text-center">
                          <div className="text-[10px] font-bold text-neutral-700 mb-1">{t('v4BadgeOriginal')}</div>
                          <img
                            src={draft.views.front?.dataUrl}
                            alt="Front"
                            className="w-full h-36 object-contain"
                          />
                        </div>
                        <div className="rounded-lg bg-[#F8F4EC] p-2 text-center">
                          <div className="text-[10px] font-bold text-neutral-700 mb-1">
                            {pendingAiApproval.angle === 'back' ? t('v4SlotBack') : t('v4SlotSide')}
                          </div>
                          <img
                            src={pendingAiApproval.styledUrl}
                            alt="Draft"
                            className="w-full h-36 object-contain"
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setPendingAiApproval(null)}
                          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-bold"
                        >
                          {t('v4AiRejectBtn')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const { angle, styledSlot } = pendingAiApproval;
                            setDraft((prev) => ({
                              ...prev,
                              views: { ...prev.views, [angle]: styledSlot },
                              updatedAt: Date.now(),
                            }));
                            setPreviewAngleDeg(angle === 'back' ? 180 : 90);
                            setPendingAiApproval(null);
                            setAiDrawerAngle(null);
                            soundEngine.click(1.22);
                          }}
                          className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold inline-flex items-center gap-1"
                        >
                          <Check className="w-3.5 h-3.5" />
                          {t('v4AiApproveBtn')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ================= LIGHT-TABLE TRACING CANVAS (Draw Side/Back over 5-Line Blue Guides!) ================= */}
          {activeTab === 'angles' && tracingAngle && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-ink-brass">{t('v4TraceTitle')}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setTraceTool('pen')}
                    className={`px-2 py-1 rounded-lg text-[11px] font-bold inline-flex items-center gap-1 ${
                      traceTool === 'pen' ? 'bg-ink-brass text-neutral-950' : 'bg-white/5 text-desk-muted'
                    }`}
                  >
                    <Pencil className="w-3 h-3" /> Kalem
                  </button>
                  <button
                    type="button"
                    onClick={() => setTraceTool('eraser')}
                    className={`px-2 py-1 rounded-lg text-[11px] font-bold inline-flex items-center gap-1 ${
                      traceTool === 'eraser' ? 'bg-ink-brass text-neutral-950' : 'bg-white/5 text-desk-muted'
                    }`}
                  >
                    <Eraser className="w-3 h-3" /> Silgi
                  </button>
                  <button
                    type="button"
                    onClick={() => setTraceNibBold((v) => !v)}
                    className="px-2 py-1 rounded-lg bg-white/5 text-[11px] font-bold text-desk-muted hover:text-desk-ink"
                  >
                    {traceNibBold ? t('thickNib') : t('thinNib')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const prevImg = traceHistoryRef.current.pop();
                      const ctx = traceCanvasRef.current?.getContext('2d');
                      if (prevImg && ctx) ctx.putImageData(prevImg, 0, 0);
                    }}
                    className="p-1.5 rounded-lg bg-white/5 text-desk-muted hover:text-desk-ink"
                    title={t('undoShort')}
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const c = traceCanvasRef.current;
                      const ctx = c?.getContext('2d');
                      if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
                    }}
                    className="px-2 py-1 rounded-lg bg-white/5 text-[11px] font-bold text-desk-muted hover:text-red-300"
                  >
                    {t('v4TraceClear')}
                  </button>
                </div>
              </div>

              {/* Backlit Glass Paper + Onion Skin + 5 Blue Anchor Calibration Lines */}
              <div className="relative mx-auto w-full max-w-[340px] aspect-square rounded-xl bg-[#FAF6ED] border-2 border-ink-brass/50 overflow-hidden shadow-inner">
                {traceUnderlayUrl && (
                  <img
                    src={traceUnderlayUrl}
                    alt="Reference Guide"
                    className="absolute inset-0 w-full h-full object-contain pointer-events-none opacity-25"
                    style={{ filter: 'sepia(1) hue-rotate(175deg) saturate(2.2)' }}
                  />
                )}
                {/* 5 Horizontal Blue Calibration Lines */}
                {[
                  { v: refAnchors.headTopV, lbl: 'Baş' },
                  { v: refAnchors.eyeLineV, lbl: 'Göz' },
                  { v: refAnchors.shoulderV, lbl: 'Omuz' },
                  { v: refAnchors.hipV, lbl: 'Kalça' },
                  { v: refAnchors.soleV, lbl: 'Taban' },
                ].map((line) => (
                  <div
                    key={line.lbl}
                    className="absolute left-0 right-0 border-t border-dashed border-sky-500/60 pointer-events-none flex justify-end pr-1.5"
                    style={{ top: `${Math.round(line.v * 100)}%` }}
                  >
                    <span className="text-[9px] font-bold text-sky-600/80 -mt-3 bg-[#FAF6ED]/80 px-1 rounded">
                      {line.lbl}
                    </span>
                  </div>
                ))}
                <canvas
                  ref={traceCanvasRef}
                  width={512}
                  height={512}
                  onPointerDown={onTraceDown}
                  onPointerMove={onTraceMove}
                  onPointerUp={onTraceUp}
                  onPointerCancel={onTraceUp}
                  className="relative z-10 w-full h-full block touch-none cursor-crosshair"
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setTracingAngle(null);
                    setTraceUnderlayUrl(null);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-bold"
                >
                  {t('v4TraceCancel')}
                </button>
                <button
                  type="button"
                  onClick={handleSaveTracedAngle}
                  className="px-4 py-1.5 rounded-lg bg-ink-brass text-neutral-950 text-xs font-bold inline-flex items-center gap-1 shadow"
                >
                  <Check className="w-3.5 h-3.5" />
                  {t('v4TraceApply')}
                </button>
              </div>
            </div>
          )}

          {/* ================= TAB 2: 5-SECOND JOINT PINS & SCISSORS ================= */}
          {activeTab === 'joints' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setJointTool('pin')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 transition-colors ${
                      jointTool === 'pin'
                        ? 'bg-ink-brass text-neutral-950 shadow'
                        : 'bg-white/5 text-desk-muted hover:text-desk-ink'
                    }`}
                  >
                    <Move className="w-3.5 h-3.5" />
                    {t('v4JointToolPin')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setJointTool('scissors')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 transition-colors ${
                      jointTool === 'scissors'
                        ? 'bg-rose-500 text-white shadow'
                        : 'bg-white/5 text-desk-muted hover:text-desk-ink'
                    }`}
                  >
                    <Scissors className="w-3.5 h-3.5" />
                    {t('v4JointToolScissors')}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.click(1.0);
                    setDraft((prev) => ({
                      ...prev,
                      jointOverrides: undefined,
                      customSlitLines: undefined,
                      updatedAt: Date.now(),
                    }));
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-bold inline-flex items-center gap-1 text-desk-muted hover:text-desk-ink"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t('v4JointReset')}
                </button>
              </div>

              <p className="text-[11.5px] text-desk-muted">
                {jointTool === 'pin' ? t('v4JointHintPin') : t('v4JointHintScissors')}
              </p>

              <div
                ref={jointSurfaceRef}
                onPointerDown={handleJointPointerDown}
                onPointerMove={handleJointPointerMove}
                onPointerUp={handleJointPointerUp}
                onPointerCancel={handleJointPointerUp}
                className={`relative mx-auto w-full max-w-[320px] aspect-square rounded-xl bg-[#FAF6ED] border border-ink-brass/45 overflow-hidden select-none touch-none ${
                  jointTool === 'scissors' ? 'cursor-crosshair' : 'cursor-default'
                }`}
              >
                {draft.views.front?.dataUrl && (
                  <img
                    src={draft.views.front.dataUrl}
                    alt="Calibration"
                    className="w-full h-full object-contain pointer-events-none"
                  />
                )}

                {/* Existing & Live Scissors Slit Lines */}
                <svg
                  viewBox="0 0 100 100"
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  preserveAspectRatio="none"
                >
                  {(draft.customSlitLines ?? []).map((ln, i) => (
                    <line
                      key={i}
                      x1={ln.x0 * 100}
                      y1={ln.y0 * 100}
                      x2={ln.x1 * 100}
                      y2={ln.y1 * 100}
                      stroke="#E11D48"
                      strokeWidth="1.4"
                      strokeDasharray="2.5 2"
                    />
                  ))}
                  {pendingSlitStart && pendingSlitCur && (
                    <line
                      x1={pendingSlitStart.x * 100}
                      y1={pendingSlitStart.y * 100}
                      x2={pendingSlitCur.x * 100}
                      y2={pendingSlitCur.y * 100}
                      stroke="#FB7185"
                      strokeWidth="1.6"
                      strokeDasharray="2 1.5"
                    />
                  )}
                </svg>

                {/* Draggable Joint Pins */}
                {jointTool === 'pin' &&
                  DEFAULT_JOINT_PINS.map((pin) => {
                    const pos = draft.jointOverrides?.[pin.id] ?? { x: pin.x, y: pin.y };
                    return (
                      <button
                        key={pin.id}
                        type="button"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setDraggingPinId(pin.id);
                        }}
                        style={{
                          left: `${pos.x * 100}%`,
                          top: `${pos.y * 100}%`,
                        }}
                        className="absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-ink-brass border-2 border-neutral-950 shadow-md hover:scale-125 transition-transform cursor-grab active:cursor-grabbing"
                        title={pin.labelTr}
                      />
                    );
                  })}
              </div>
            </div>
          )}

          {/* ================= TAB 3: FACE & MOUTH ================= */}
          {activeTab === 'face' && (
            <div className="space-y-3">
              <label className="flex items-start gap-3 p-3 rounded-xl bg-desk-surface/65 border border-ink-brass/35 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.faceSprites?.autoInkStyle ?? true}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      faceSprites: {
                        ...(prev.faceSprites ?? { autoInkStyle: true }),
                        autoInkStyle: e.target.checked,
                      },
                      updatedAt: Date.now(),
                    }))
                  }
                  className="mt-1 accent-ink-brass"
                />
                <div>
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    <Smile className="w-4 h-4 text-ink-brass" />
                    {t('v4FaceAutoLabel')}
                  </div>
                  <p className="text-[11px] text-desk-muted mt-0.5">{t('v4FaceAutoDesc')}</p>
                </div>
              </label>

              <div className="space-y-2">
                <p className="text-[11.5px] text-desk-muted">{t('v4FaceCustomDesc')}</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {MOUTH_KEYS.map((m) => {
                    const customUrl = draft.faceSprites?.mouths?.[m.id];
                    return (
                      <div
                        key={m.id}
                        className="rounded-xl border border-desk-border bg-desk-surface/40 p-2 flex flex-col items-center gap-1.5"
                      >
                        <span className="text-[11px] font-bold">{m.label}</span>
                        <div className="w-16 h-12 rounded-lg bg-[#FAF6ED] border border-black/10 flex items-center justify-center overflow-hidden">
                          {customUrl ? (
                            <img src={customUrl} alt={m.label} className="w-full h-full object-contain p-1" />
                          ) : (
                            <span className="text-[10px] text-neutral-400">Auto</span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            mouthTargetRef.current = m.id;
                            mouthInputRef.current?.click();
                          }}
                          className="w-full py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[10px] font-bold"
                        >
                          {t('v4BtnUpload')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div className="px-4 py-3 border-t border-desk-border bg-desk-surface/60 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-bold transition-colors"
          >
            {t('v4Cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              soundEngine.click(1.2);
              onSave({ ...draft, updatedAt: Date.now() });
            }}
            className="px-4 py-2 rounded-xl bg-ink-brass hover:brightness-110 text-neutral-950 text-xs font-extrabold inline-flex items-center gap-1.5 shadow transition-all active:scale-95"
          >
            <Check className="w-4 h-4" />
            {t('v4SaveApply')}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalNode, document.body) : modalNode;
}
