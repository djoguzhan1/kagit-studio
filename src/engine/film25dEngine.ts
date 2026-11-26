import type {
  CinemaLookId,
  FilmActionId,
  FilmActor,
  FilmEmotionId,
  FilmProjectGraph,
  FilmPropId,
  FilmShot,
  FilmStyleTag,
  FilmWorldConfig,
  LivePerformanceOverride,
  ShotActorTrack,
  ShotFraming,
  StyleDNA,
  VisemeId,
  WeatherKind,
  WorldSetId,
} from '../types/film';
import { UNIVERSAL_CREATURE_CATALOG, type UniversalActionId } from './universalCreatureRig';
import { MasterRigRuntimeCache, renderMasterRigCharacter } from './viewRigBlender';
import type { DirectedShotPlan } from './aiStudioClient';
import { makeId } from './db';
import {
  sampleMotionCaptureTrack,
  sampleVoiceLipSync,
  textDialogueToViseme,
} from './filmMocapLipSync';
import { evaluateDeterministicVerletRibbon } from './verletPhysics';
import {
  drawCartoonMouth,
  easeOutCubic,
  evalNaturalFootRoll,
  evalWilliamsHipBounce,
  evalWilliamsLeg,
  organicBreathCurve,
  renderMultiLayerRiggedCharacter,
  type ArticulatedCartoonPose,
} from './cartoonMotionEngine';
import type { KlausLightConfig } from './cpuRasterizer';
import { getOrBuildCachedRigPack } from './characterIntakeEngine';
import {
  getCachedSampleHeroCanvas,
  preloadSampleHeroCanvas,
  SAMPLE_HERO_NAME_TR,
} from './sampleHeroAsset';

// ============================================================================
// 1. AUTOMATIC STYLE-DNA EXTRACTOR (Adapts world, lighting & shading to ANY art!)
// ============================================================================

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

export const DEFAULT_STYLE_DNA: StyleDNA = {
  palette: ['#2B2622', '#E54D2E', '#D99B26', '#FAF3E4', '#4A5568'],
  inkColor: '#1C1917',
  accentColor: '#E54D2E',
  warmTemp: 0.35,
  contrast: 0.78,
  lineWeightPx: 3.4,
  styleTag: 'ink-watercolor',
};

/** Pure pixel analyzer: extracts StyleDNA from any RGBA drawing buffer (testable in Node & Browser!) */
export function extractStyleDNAFromPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): StyleDNA {
  const total = width * height;
  if (total === 0) return DEFAULT_STYLE_DNA;

  const buckets = new Map<string, { count: number; r: number; g: number; b: number; sat: number }>();
  let opaqueCount = 0;
  let darkInkCount = 0;
  let edgeCount = 0;
  let sumWarmth = 0;
  let sumLum = 0;
  let sumLumSq = 0;
  let highSatCount = 0;

  const stride = Math.max(1, Math.floor(Math.sqrt(total / 4096)));

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const a = rgba[idx + 3];
      if (a < 140) continue;
      // Ignore pure paper background pixels
      if (r > 240 && g > 236 && b > 224) continue;

      opaqueCount++;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sumLum += lum;
      sumLumSq += lum * lum;
      sumWarmth += (r - b) / 255;

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
      if (sat > 0.45) highSatCount++;
      if (lum < 68) darkInkCount++;

      // Simple local gradient edge check for line-weight estimation
      if (x + stride < width) {
        const nIdx = (y * width + x + stride) * 4;
        const nLum = 0.299 * rgba[nIdx] + 0.587 * rgba[nIdx + 1] + 0.114 * rgba[nIdx + 2];
        if (Math.abs(lum - nLum) > 55) edgeCount++;
      }

      const qr = Math.round(r / 32) * 32;
      const qg = Math.round(g / 32) * 32;
      const qb = Math.round(b / 32) * 32;
      const key = `${qr},${qg},${qb}`;
      const prev = buckets.get(key);
      if (prev) {
        prev.count++;
      } else {
        buckets.set(key, { count: 1, r: qr, g: qg, b: qb, sat });
      }
    }
  }

  if (opaqueCount < 8) return DEFAULT_STYLE_DNA;

  const meanLum = sumLum / opaqueCount;
  const variance = Math.max(0, sumLumSq / opaqueCount - meanLum * meanLum);
  const contrast = Math.min(1, Math.sqrt(variance) / 88);
  const warmTemp = Math.max(-1, Math.min(1, (sumWarmth / opaqueCount) * 2.2));
  const inkRatio = darkInkCount / opaqueCount;
  const satRatio = highSatCount / opaqueCount;
  const edgeRatio = edgeCount / opaqueCount;

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const palette = sorted.slice(0, 5).map((b) => rgbToHex(b.r, b.g, b.b));
  const darkest = [...sorted].sort((a, b) => a.r + a.g + a.b - (b.r + b.g + b.b))[0];
  const mostVibrant = [...sorted].sort((a, b) => b.sat * Math.sqrt(b.count) - a.sat * Math.sqrt(a.count))[0];

  let styleTag: FilmStyleTag = 'ink-watercolor';
  if (satRatio < 0.08 && inkRatio > 0.25) styleTag = 'sketch';
  else if (satRatio > 0.34 && contrast > 0.55) styleTag = 'anime-cel';
  else if (warmTemp > 0.18 && contrast < 0.65) styleTag = 'storybook';

  const lineWeightPx = Math.max(1.8, Math.min(5.8, 2.2 + edgeRatio * 9 + inkRatio * 2.2));

  return {
    palette: palette.length >= 3 ? palette : DEFAULT_STYLE_DNA.palette,
    inkColor: darkest && darkest.r + darkest.g + darkest.b < 240 ? rgbToHex(darkest.r, darkest.g, darkest.b) : '#1C1917',
    accentColor: mostVibrant && mostVibrant.sat > 0.2 ? rgbToHex(mostVibrant.r, mostVibrant.g, mostVibrant.b) : '#E54D2E',
    warmTemp: Number(warmTemp.toFixed(2)),
    contrast: Number(contrast.toFixed(2)),
    lineWeightPx: Number(lineWeightPx.toFixed(1)),
    styleTag,
  };
}

export function extractStyleDNAFromCanvas(source: HTMLCanvasElement | ImageBitmap): StyleDNA {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, 0, 0, 96, 96);
  const data = ctx.getImageData(0, 0, 96, 96).data;
  return extractStyleDNAFromPixels(data, 96, 96);
}

// ============================================================================
// 2. NATURAL-LANGUAGE FILM DIRECTOR COMPILER (Turkish & English -> FilmGraph IR)
// ============================================================================

export interface DirectorPreset {
  id: string;
  labelTr: string;
  labelEn: string;
  prompt: string;
}

export const DIRECTOR_PRESETS: DirectorPreset[] = [
  {
    id: 'rainy-letter',
    labelTr: 'Yağmurlu Sokak & Parlayan Mektup (3 Plan)',
    labelEn: 'Rainy Alley & Glowing Letter (3 Shots)',
    prompt:
      "Yağmurlu akşam sokağı. Karakter soldan yorgun adımlarla girer, sokak lambasının altında durur. Yerdeki parlayan mektubu görünce şaşırır, eğilip alır. Kamera yüzüne yaklaşır, şimşek çakar, gülümseyip 'Sonunda buldum!' der.",
  },
  {
    id: 'golden-hill',
    labelTr: 'Gün Batımı Tepesi & Rüzgâr (3 Plan)',
    labelEn: 'Golden Sunset Hill & Wind (3 Shots)',
    prompt:
      "Gün batımı rüzgarlı tepe. Karakter tepeden koşarak gelir, rüzgarda durup ufka bakar. Sevinçle zıplar ve kameraya el sallar. Yakın çekimde mutlu gülümseyerek 'İşte başlıyoruz!' der.",
  },
  {
    id: 'moonlit-forest',
    labelTr: 'Ay Işıklı Orman & Fener (3 Plan)',
    labelEn: 'Moonlit Forest & Lantern (3 Shots)',
    prompt:
      "Ay ışıklı büyülü orman. Karakter elinde fenerle yavaşça yürür. Karanlıkta bir ses duyup şaşırır. Kamera yüzüne yaklaşır, kararlı bakışla 'Korkmuyorum, devam!' der.",
  },
  {
    id: 'snowy-lantern',
    labelTr: 'Karlı Gece Sokağı & Sıcak Fener (3 Plan)',
    labelEn: 'Snowy Night Street & Warm Lantern (3 Shots)',
    prompt:
      "Karlı akşam sokağı. Karakter elinde fenerle yavaşça yürür. Gökyüzüne bakıp sevinçle zıplar. Yakın çekimde gülümseyerek 'Kar yağıyor!' der.",
  },
];

const SNOW_RE = /(^|[\s.,!?])kar(lı|la| yağ| tanesi|[\s.,!?]|$)|snow/;

function detectWorldFromText(low: string): { setId: WorldSetId; weather: WeatherKind } {
  const hasRain = /yağmur|rain|fırtına|storm/.test(low);
  const hasSnow = SNOW_RE.test(low);
  if (/orman|forest|ağaç|ay ışık|ay ışığ|moon|ateşböce|firefl|gece orman/.test(low)) {
    return { setId: 'moonlit-forest', weather: hasRain ? 'rain' : hasSnow ? 'snow' : 'fireflies' };
  }
  if (/gün batım|sunset|tepe|hill|rüzgar|rüzgâr|wind|çayır|yaprak|güneş|golden/.test(low)) {
    return { setId: 'golden-hill', weather: hasSnow ? 'snow' : hasRain ? 'rain' : 'wind-leaves' };
  }
  if (hasSnow && !hasRain) {
    return { setId: 'rainy-alley', weather: 'snow' };
  }
  return {
    setId: 'rainy-alley',
    weather: 'rain',
  };
}

function detectActionFromClause(low: string, fallback: FilmActionId): FilmActionId {
  if (/koş|run|sprint/.test(low)) return 'run';
  if (/zıpla|jump|sıçra|sevinçle/.test(low)) return 'jump-joy';
  if (/eğil|diz çök|yerden|pick\s*up|kneel/.test(low)) return 'kneel-pickup';
  if (/el salla|wave|selam/.test(low)) return 'wave';
  if (/şaşır|irkil|surpris|gözleri büyü|şok/.test(low)) return 'surprise';
  if (/(^|\s)der([\s.,!?]|$)|söyler|konuş|speak|say|bağır|fısılda|['"“”]/.test(low)) return 'talk-hero';
  if (/yorgun|yavaş|tired|slow/.test(low)) return 'walk-tired';
  if (/yürü|girer|gelir|ilerle|walk|enter/.test(low)) return 'walk-hero';
  return fallback;
}

function detectEmotionFromClause(low: string, fallback: FilmEmotionId): FilmEmotionId {
  if (/şaşır|şok|surpris|gözleri büyü/.test(low)) return 'surprised';
  if (/gülümse|mutlu|sevinç|happy|smile|joy/.test(low)) return 'happy';
  if (/kız|öfke|angry|sinir/.test(low)) return 'angry';
  if (/kararlı|cesur|korkmuy|determin|brave/.test(low)) return 'determined';
  if (/yorgun|üzgün|tired|sad/.test(low)) return 'tired';
  return fallback;
}

function detectPropFromText(low: string): FilmPropId {
  if (/mektu[pb]|zarf|letter|envelope/.test(low)) return 'glowing-letter';
  if (/fener|lantern|ışık tut/.test(low)) return 'lantern';
  if (/şemsiye|umbrella/.test(low)) return 'umbrella';
  return 'none';
}

function extractDialogue(text: string): string {
  const m = text.match(/['"“”«]([^'"“”»]{2,90})['"“”»]/);
  return m ? m[1].trim() : '';
}

function makeCameraForFraming(framing: ShotFraming, startX: number, endX: number): FilmShot['camera'] {
  if (framing === 'closeup') {
    return {
      fromX: (endX - 0.5) * 0.45,
      fromY: -0.14,
      fromZoom: 1.72,
      toX: (endX - 0.5) * 0.45,
      toY: -0.17,
      toZoom: 1.98,
      tiltDeg: -1.5,
      dofStrength: 0.78,
      handheld: 0.3,
    };
  }
  if (framing === 'medium') {
    return {
      fromX: (startX - 0.5) * 0.35,
      fromY: -0.05,
      fromZoom: 1.24,
      toX: (endX - 0.5) * 0.35,
      toY: -0.08,
      toZoom: 1.46,
      tiltDeg: 0,
      dofStrength: 0.45,
      handheld: 0.25,
    };
  }
  if (framing === 'low-angle') {
    return {
      fromX: (startX - 0.5) * 0.25,
      fromY: 0.04,
      fromZoom: 1.15,
      toX: (endX - 0.5) * 0.25,
      toY: -0.02,
      toZoom: 1.38,
      tiltDeg: -4.5,
      dofStrength: 0.5,
      handheld: 0.35,
    };
  }
  return {
    fromX: -0.08,
    fromY: 0,
    fromZoom: 1.0,
    toX: 0.06,
    toY: -0.02,
    toZoom: 1.12,
    tiltDeg: 0,
    dofStrength: 0.22,
    handheld: 0.2,
  };
}

/**
 * Compiles a natural-language Turkish or English movie description into a deterministic,
 * editable multi-shot FilmProjectGraph (Wide -> Medium -> Close-Up cinema grammar!).
 */
export function compileDirectorPromptToFilmGraph(
  prompt: string,
  baseActor?: FilmActor,
  baseWorld?: Partial<FilmWorldConfig>
): FilmProjectGraph {
  const clean = prompt.trim() || DIRECTOR_PRESETS[0].prompt;
  const lowAll = clean.toLowerCase();
  const { setId, weather } = detectWorldFromText(lowAll);
  const globalProp = detectPropFromText(lowAll);

  // Split into meaningful beats/clauses by sentences
  const rawSentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);

  // Merge leading pure setting sentence ("Yağmurlu akşam sokağı.") into Shot 1
  const beats: string[] = [];
  for (const s of rawSentences) {
    const low = s.toLowerCase();
    const isPureSetting =
      beats.length === 0 &&
      s.length < 44 &&
      !/(girer|yürür|koşar|zıplar|şaşır|eğil|alır|der|gülümse|bakar|walk|run|jump|smile|say)/.test(low);
    if (isPureSetting) continue;
    beats.push(s);
  }

  // Ensure at least 3 cinematic shots (Establishing -> Beat 2 -> Hero Close-Up) when prompt is rich
  const shotTexts =
    beats.length >= 2
      ? beats.slice(0, 4)
      : [
          clean,
          `${clean} (Orta Plan)`,
          `${clean} (Yakın Plan)`,
        ];

  const shots: FilmShot[] = shotTexts.map((text, idx) => {
    const low = text.toLowerCase();
    const isFirst = idx === 0;
    const isLast = idx === shotTexts.length - 1;
    const dialogue = extractDialogue(text) || (isLast ? extractDialogue(clean) : '');
    const hasLightning = /şimşek|gök gürl|lightning|thunder/.test(low);
    const shotProp = detectPropFromText(low) !== 'none' ? detectPropFromText(low) : idx >= 1 ? globalProp : globalProp === 'lantern' || globalProp === 'umbrella' ? globalProp : 'none';

    let framing: ShotFraming = isFirst ? 'wide' : isLast ? 'closeup' : 'medium';
    if (/yakın|close\s*up|yüzüne/.test(low)) framing = 'closeup';
    else if (/geniş|wide|uzak/.test(low)) framing = 'wide';
    else if (/alttan|alt açı|low\s*angle|kahraman/.test(low)) framing = 'low-angle';

    const action = detectActionFromClause(
      low,
      isFirst ? 'walk-tired' : isLast && dialogue ? 'talk-hero' : 'surprise'
    );
    const emotion = detectEmotionFromClause(
      low,
      action === 'walk-tired'
        ? 'tired'
        : action === 'surprise' || action === 'kneel-pickup'
          ? 'surprised'
          : action === 'jump-joy' || dialogue
            ? 'happy'
            : 'neutral'
    );

    const startX = isFirst ? 0.16 : idx === 1 ? 0.48 : 0.52;
    const endX = isFirst ? 0.48 : idx === 1 ? 0.52 : 0.52;
    const startY = isFirst ? 0.79 : 0.8;
    const endY = isFirst ? 0.8 : 0.81;

    const motionPath =
      action === 'walk-tired' || action === 'walk-hero' || action === 'run'
        ? [
            { x: startX, y: startY },
            { x: (startX + endX) / 2, y: (startY + endY) / 2 - 0.01 },
            { x: endX, y: endY },
          ]
        : [{ x: endX, y: endY }];

    const headAngleX =
      framing === 'closeup'
        ? dialogue
          ? 16
          : -14
        : action === 'surprise'
          ? 24
          : isFirst
            ? 14
            : -10;

    const timingMode =
      action === 'run' || action === 'jump-joy'
        ? 'hybrid-12-24'
        : framing === 'closeup'
          ? 'hybrid-12-24'
          : 'on2s-12fps';

    const titlePrefix = `Plan ${idx + 1}`;
    const framingTag =
      framing === 'wide'
        ? 'Geniş'
        : framing === 'closeup'
          ? 'Yakın'
          : framing === 'low-angle'
            ? 'Alt Açı'
            : 'Orta';

    return {
      id: makeId('sht'),
      title: `${titlePrefix} · ${framingTag}`,
      durationSec: dialogue ? 3.2 : isFirst ? 2.8 : 2.5,
      framing,
      timingMode,
      action,
      emotion,
      prop: shotProp,
      headAngleX,
      motionPath,
      lookAt:
        action === 'kneel-pickup'
          ? { x: endX + 0.12, y: 0.86 }
          : framing === 'closeup'
            ? { x: 0.5, y: 0.44 }
            : { x: Math.min(0.86, endX + 0.22), y: 0.54 },
      dialogue,
      lightningAtSec: hasLightning ? 0.75 : null,
      camera: makeCameraForFraming(framing, startX, endX),
      transition: idx === 0 ? 'cut' : isLast ? 'dissolve' : 'cut',
    };
  });

  const actor: FilmActor = baseActor ?? {
    id: makeId('act'),
    name: SAMPLE_HERO_NAME_TR,
    sourceBlobKey: null,
    sourceW: 542,
    sourceH: 640,
    styleDna: DEFAULT_STYLE_DNA,
    rigidHeadEndY: 0.31,
    secondaryPhysics: false,
    scale: 1,
  };

  // Respect custom background ONLY when caller explicitly keeps setId === 'custom';
  // otherwise switch cleanly to the compiled preset world while keeping customBgBlobKey recoverable!
  const keepCustom = baseWorld?.setId === 'custom' && Boolean(baseWorld?.customBgBlobKey);
  const world: FilmWorldConfig = {
    setId: keepCustom ? 'custom' : setId,
    customBgBlobKey: baseWorld?.customBgBlobKey ?? null,
    decomposedBg: baseWorld?.decomposedBg ?? null,
    horizonY: setId === 'golden-hill' ? 0.56 : 0.58,
    weather,
    weatherIntensity: weather === 'none' ? 0 : 0.68,
    windStrength: setId === 'golden-hill' ? 0.55 : -0.32,
    klausLighting: baseWorld?.klausLighting ?? true,
    cinemaGrade: baseWorld?.cinemaGrade ?? true,
    cinemaLook: baseWorld?.cinemaLook ?? 'natural',
    letterbox: baseWorld?.letterbox ?? true,
    grainStrength: baseWorld?.grainStrength ?? 0.35,
    lightAngleDeg: setId === 'golden-hill' ? -35 : 22,
    harmonizeToStyleDna: baseWorld?.harmonizeToStyleDna ?? true,
  };

  return {
    version: '2.5d-v1',
    prompt: clean,
    actor,
    world,
    shots,
    foleyEnabled: true,
    musicBedEnabled: true,
  };
}

/** 1-Sentence Surgical Shot Revision: patches ONLY the active shot without touching other shots! */
export function patchShotFromRevisionPrompt(shot: FilmShot, instruction: string): FilmShot {
  const low = instruction.toLowerCase();
  const next: FilmShot = {
    ...shot,
    camera: { ...shot.camera },
    motionPath: shot.motionPath.map((p) => ({ ...p })),
  };

  if (/yavaş|slow|dramatik|uzat/.test(low)) {
    next.durationSec = Math.min(6.5, Number((shot.durationSec + 1.1).toFixed(1)));
  }
  if (/hızlı|fast|kısalt|tempolu/.test(low)) {
    next.durationSec = Math.max(1.4, Number((shot.durationSec - 0.8).toFixed(1)));
    next.timingMode = 'smooth-24fps';
  }
  const updateTitleFraming = (fr: ShotFraming) => {
    const label = fr === 'wide' ? 'Geniş' : fr === 'closeup' ? 'Yakın' : fr === 'low-angle' ? 'Alt Açı' : 'Orta';
    const prefix = next.title.split('·')[0]?.trim() || 'Plan';
    next.title = `${prefix} · ${label}`;
  };

  if (/yakın|close\s*up|yüz/.test(low)) {
    next.framing = 'closeup';
    updateTitleFraming('closeup');
    const end = next.motionPath[next.motionPath.length - 1] ?? { x: 0.5, y: 0.8 };
    next.camera = makeCameraForFraming('closeup', end.x, end.x);
  } else if (/geniş|wide/.test(low)) {
    next.framing = 'wide';
    updateTitleFraming('wide');
    next.camera = makeCameraForFraming('wide', 0.2, 0.5);
  } else if (/alttan|alt açı|low\s*angle/.test(low)) {
    next.framing = 'low-angle';
    updateTitleFraming('low-angle');
    next.camera = makeCameraForFraming('low-angle', 0.45, 0.5);
  }

  if (/şimşek|lightning|gök/.test(low)) next.lightningAtSec = 0.65;
  if (/şimşek.*kapat|no lightning/.test(low)) next.lightningAtSec = null;

  const newAct = detectActionFromClause(low, next.action);
  next.action = newAct;
  next.emotion = detectEmotionFromClause(low, next.emotion);

  const prop = detectPropFromText(low);
  if (prop !== 'none') next.prop = prop;
  const dlg = extractDialogue(instruction);
  if (dlg) next.dialogue = dlg;

  if (/sola bak|look left/.test(low)) next.headAngleX = -26;
  if (/sağa bak|look right/.test(low)) next.headAngleX = 26;

  return next;
}

// ============================================================================
// 3. BUILT-IN HIGH-CRAFT STUDIO HERO ACTOR CANVAS (Instant 0ms boot)
// ============================================================================

let cachedHeroActorCanvas: HTMLCanvasElement | null = null;

export function getDefaultHeroActorCanvas(): HTMLCanvasElement {
  const realMascot = getCachedSampleHeroCanvas();
  if (realMascot) return realMascot;
  void preloadSampleHeroCanvas();
  if (cachedHeroActorCanvas) return cachedHeroActorCanvas;
  const W = 640;
  const H = 760;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const cx = W / 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Boots + Trousers (solid grounded proportions)
  ctx.fillStyle = '#332C27';
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 7;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + s * 46, 510);
    ctx.lineTo(cx + s * 56, 636);
    ctx.lineTo(cx + s * 28, 638);
    ctx.lineTo(cx + s * 20, 514);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Ochre studio boots with highlight
    ctx.fillStyle = '#D99B26';
    ctx.beginPath();
    ctx.ellipse(cx + s * 48, 650, 34, 17, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#332C27';
  }

  // Expressive coat sleeves + mittens
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 22;
  ctx.beginPath();
  ctx.moveTo(cx - 80, 350);
  ctx.quadraticCurveTo(cx - 140, 380, cx - 170, 340);
  ctx.moveTo(cx + 80, 350);
  ctx.quadraticCurveTo(cx + 140, 380, cx + 170, 340);
  ctx.stroke();

  ctx.strokeStyle = '#2B2622';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(cx - 80, 350);
  ctx.quadraticCurveTo(cx - 140, 380, cx - 170, 340);
  ctx.moveTo(cx + 80, 350);
  ctx.quadraticCurveTo(cx + 140, 380, cx + 170, 340);
  ctx.stroke();

  ctx.fillStyle = '#F3E7D3';
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 6.5;
  for (const hx of [cx - 172, cx + 172]) {
    ctx.beginPath();
    ctx.arc(hx, 338, 21, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Stylized artist coat with sculpted lapel highlight
  ctx.fillStyle = '#26221F';
  ctx.beginPath();
  ctx.moveTo(cx - 78, 326);
  ctx.quadraticCurveTo(cx - 114, 444, cx - 96, 536);
  ctx.quadraticCurveTo(cx, 558, cx + 96, 536);
  ctx.quadraticCurveTo(cx + 114, 444, cx + 78, 326);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Warm coat buttons
  ctx.fillStyle = '#D99B26';
  for (const by of [394, 434, 474]) {
    ctx.beginPath();
    ctx.arc(cx, by, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Flowing multi-fold vermilion scarf
  ctx.fillStyle = '#B8331B';
  ctx.beginPath();
  ctx.moveTo(cx + 36, 330);
  ctx.quadraticCurveTo(cx + 98, 396, cx + 72, 466);
  ctx.lineTo(cx + 38, 456);
  ctx.quadraticCurveTo(cx + 56, 392, cx + 18, 334);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#E54D2E';
  ctx.beginPath();
  ctx.roundRect(cx - 86, 296, 172, 42, 19);
  ctx.fill();
  ctx.stroke();

  // Head + Hair + Tilted Ochre Artist Beret
  ctx.fillStyle = '#FAF3E4';
  ctx.lineWidth = 7.5;
  ctx.beginPath();
  ctx.ellipse(cx, 208, 90, 84, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Hair fringe framing temples
  ctx.fillStyle = '#1E1B18';
  ctx.beginPath();
  ctx.arc(cx, 192, 91, Math.PI * 1.06, Math.PI * 1.94);
  ctx.quadraticCurveTo(cx + 28, 162, cx - 6, 174);
  ctx.quadraticCurveTo(cx - 52, 166, cx - 88, 182);
  ctx.closePath();
  ctx.fill();

  // Ochre Beret with warm highlight crescent
  ctx.fillStyle = '#D99B26';
  ctx.beginPath();
  ctx.ellipse(cx - 8, 126, 102, 34, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 248, 220, 0.32)';
  ctx.beginPath();
  ctx.ellipse(cx - 22, 118, 56, 11, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 12, 94);
  ctx.quadraticCurveTo(cx - 6, 68, cx + 14, 72);
  ctx.stroke();

  // Soft cheeks
  ctx.fillStyle = 'rgba(229, 77, 46, 0.22)';
  ctx.beginPath();
  ctx.ellipse(cx - 52, 228, 17, 9, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + 52, 228, 17, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  // Expressive Eyes (sclera + dark iris + bright studio catchlight)
  for (const ex of [cx - 34, cx + 34]) {
    ctx.fillStyle = '#1C1917';
    ctx.beginPath();
    ctx.ellipse(ex, 204, 11, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFDF8';
    ctx.beginPath();
    ctx.arc(ex - 3.5, 197, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle nose & gentle base mouth
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.arc(cx, 226, 15, 0.18, Math.PI - 0.18);
  ctx.stroke();

  cachedHeroActorCanvas = c;
  return c;
}

// ============================================================================
// 4. FORM-PRESERVING 2.5D ARAP + RIGIDITY + 2.5D HEAD-TURN DEFORMER
// ============================================================================

export interface CharacterPose25D {
  /** Normalized position on 3D Ground Plane */
  groundX: number;
  groundY: number;
  /** Depth perspective scale derived from groundY relative to horizon */
  depthScale: number;
  /** Rigid head rotation in radians (zero skull distortion!) */
  headTiltRad: number;
  /** True 2.5D head yaw in radians (-0.61..+0.61 => -35°..+35°) */
  headYawRad: number;
  /** Eye-lead horizontal offset normalized (-1..1), leads head turn by ~3 frames! */
  eyeLeadX: number;
  /** Whole-body lean / squash & stretch (volume-preserving: sx = 1/sy) */
  bodyLeanRad: number;
  squashX: number;
  squashY: number;
  verticalLiftNorm: number; // jump height in normalized actor heights
  /** Articulated limb phases */
  leftArmSwing: number;
  rightArmSwing: number;
  leftLegPhase: number;
  rightLegPhase: number;
  /** Richard Williams Passing-Pose foot lift (0 = planted on ground, 0..1 = raised arc!) */
  leftFootLift: number;
  rightFootLift: number;
  /** Horizontal travel facing direction (+1 right, -1 left — eliminates backwards moonwalk!) */
  facing: 1 | -1;
  /** Speed magnitude for Smear Lines + Verlet cloth wind wake */
  velocity: number;
  /** True on exact heel-strike frame for synchronized Foot-Contact Foley & ground splashes! */
  footContact: boolean;
  /** Which foot struck the ground (-1 left, 0 both, +1 right) */
  contactSide: -1 | 0 | 1;
  /** Viseme openness 0..1 when speaking dialogue or voice audio */
  mouthOpen: number;
  /** Preston Blair 6-viseme mouth shape (closed / AA / EE / OH / OO / FV) */
  viseme: VisemeId;
  /** Natural periodic eye blink 0..1 */
  blink: number;
  /** V3 Reverse-Foot ankle roll (-1 push-off .. 0 flat .. +1 heel-strike) */
  leftFootRoll?: number;
  rightFootRoll?: number;
  /** V3 Relaxed wrist follow-through in radians */
  leftWristLag?: number;
  rightWristLag?: number;
}

function easeInOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

function sampleMotionPath(
  path: { x: number; y: number }[],
  t: number
): { x: number; y: number; vx: number; vy: number } {
  if (path.length === 0) return { x: 0.5, y: 0.8, vx: 0, vy: 0 };
  if (path.length === 1) return { x: path[0].x, y: path[0].y, vx: 0, vy: 0 };
  const eased = easeInOutCubic(t);
  const segCount = path.length - 1;
  const scaled = eased * segCount;
  const seg = Math.min(segCount - 1, Math.floor(scaled));
  const localT = scaled - seg;
  const a = path[seg];
  const b = path[seg + 1];
  return {
    x: a.x + (b.x - a.x) * localT,
    y: a.y + (b.y - a.y) * localT,
    vx: (b.x - a.x) * segCount,
    vy: (b.y - a.y) * segCount,
  };
}

/** Integrates cumulative path travel distance from t=0..targetT so walking stride locks 0.00px to ground! */
export function computeMotionPathArcDistance(
  pts: { x: number; y: number }[],
  targetT: number,
  steps = 28
): { cumDist: number; totalDist: number } {
  if (pts.length < 2) return { cumDist: 0, totalDist: 0 };
  const clamped = Math.max(0, Math.min(1, targetT));
  let cumDist = 0;
  let totalDist = 0;
  let prev = sampleMotionPath(pts, 0);
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const cur = sampleMotionPath(pts, u);
    const seg = Math.hypot(cur.x - prev.x, (cur.y - prev.y) * 0.56);
    totalDist += seg;
    if (u <= clamped) {
      cumDist += seg;
    } else if ((i - 1) / steps < clamped) {
      const frac = (clamped - (i - 1) / steps) * steps;
      cumDist += seg * frac;
    }
    prev = cur;
  }
  return { cumDist, totalDist };
}

/**
 * Evaluates a cinematic Disney-12-Principles 2.5D character pose at local shot time.
 * Applies On-2s (12 FPS) or Hybrid (12/24 FPS) timing cadence for authentic hand-drawn feel!
 */
export function evaluateCharacterPose25D(
  shot: FilmShot,
  localSec: number,
  horizonY: number,
  liveOverride?: LivePerformanceOverride | null
): CharacterPose25D {
  const dur = Math.max(0.5, shot.durationSec);
  // Quantize animation clock according to classic film timing mode!
  const stepFps =
    shot.timingMode === 'on2s-12fps'
      ? 12
      : shot.timingMode === 'hybrid-12-24'
        ? shot.action === 'run' || shot.action === 'jump-joy'
          ? 24
          : 12
        : 24;
  const qSec = Math.floor(localSec * stepFps) / stepFps;
  const t = Math.max(0, Math.min(1, qSec / dur));

  const mp = sampleMotionPath(shot.motionPath, t);
  const depthFactor = Math.max(0.25, (mp.y - horizonY) / Math.max(0.18, 0.9 - horizonY));
  const depthScale = 0.58 + depthFactor * 0.54;

  // Base Look-At -> Head Yaw + 3-frame Eye Lead!
  let targetYawDeg = shot.headAngleX;
  if (shot.lookAt) {
    const dx = shot.lookAt.x - mp.x;
    targetYawDeg = Math.max(-35, Math.min(35, dx * 65 + shot.headAngleX * 0.35));
  }
  const headLeadT = Math.min(1, (qSec + 0.16) / dur);
  const headEase = easeInOutCubic(Math.min(1, t * 1.45));
  const eyeEase = easeInOutCubic(Math.min(1, headLeadT * 1.65));
  let headYawRad = ((targetYawDeg * headEase) * Math.PI) / 180;
  let eyeLeadX = Math.max(-1, Math.min(1, (targetYawDeg / 35) * eyeEase));

  let headTiltRad = Math.sin(qSec * 2.1) * 0.035;
  let bodyLeanRad = mp.vx * 0.18;
  let squashY = 1 + Math.sin(qSec * 2.6) * 0.018;
  let verticalLiftNorm = 0;
  let leftArmSwing = 0;
  let rightArmSwing = 0;
  let leftLegPhase = 0;
  let rightLegPhase = 0;
  let leftFootLift = 0;
  let rightFootLift = 0;
  let footContact = false;
  let contactSide: -1 | 0 | 1 = 0;

  // Resolve natural travel facing direction (eliminates backwards moonwalking when dragging right->left!)
  let facing: 1 | -1 = 1;
  if (Math.abs(mp.vx) > 0.015) {
    facing = mp.vx >= 0 ? 1 : -1;
  } else if (shot.motionPath.length >= 2) {
    const netDx = shot.motionPath[shot.motionPath.length - 1].x - shot.motionPath[0].x;
    if (Math.abs(netDx) > 0.02) {
      facing = netDx >= 0 ? 1 : -1;
    } else if (shot.lookAt && Math.abs(shot.lookAt.x - mp.x) > 0.08) {
      facing = shot.lookAt.x >= mp.x ? 1 : -1;
    }
  } else if (shot.lookAt && Math.abs(shot.lookAt.x - mp.x) > 0.08) {
    facing = shot.lookAt.x >= mp.x ? 1 : -1;
  }

  // Emotion-driven body weight, tempo & posture modifiers (ALL 6 emotions shape real acting!)
  const emoTempoMul =
    shot.emotion === 'tired'
      ? 0.78
      : shot.emotion === 'happy'
        ? 1.12
        : shot.emotion === 'angry'
          ? 1.16
          : shot.emotion === 'determined'
            ? 1.06
            : 1.0;

  const act = shot.action;
  let leftFootRoll = 0;
  let rightFootRoll = 0;
  let leftWristLag = 0;
  let rightWristLag = 0;
  if (act === 'walk-tired' || act === 'walk-hero' || act === 'run') {
    // V3 Velocity-Locked 0.00px Foot-Slip Reverse-Foot Walk/Run!
    // Integrates exact traveled world distance along shot.motionPath so shoes NEVER skate across the floor!
    const baseStrideHz = act === 'run' ? 1.85 : act === 'walk-hero' ? 1.02 : 0.78;
    const strideHz = baseStrideHz * emoTempoMul;
    const { cumDist, totalDist } = computeMotionPathArcDistance(shot.motionPath, t);
    const { cumDist: prevCumDist } = computeMotionPathArcDistance(
      shot.motionPath,
      Math.max(0, (qSec - 1 / stepFps) / dur)
    );
    // One full 2-step L+R stride in normalized stage width (~0.175 * depthScale for walk, ~0.24 for run)
    const fullStrideNorm = Math.max(0.08, (act === 'run' ? 0.24 : 0.165) * depthScale);
    const useDistanceLock = totalDist > 0.035;
    const cycle = useDistanceLock
      ? ((cumDist / fullStrideNorm) % 1 + 1) % 1
      : (qSec * strideHz) % 1;
    const prevCycle = useDistanceLock
      ? ((prevCumDist / fullStrideNorm) % 1 + 1) % 1
      : (Math.max(0, qSec - 1 / stepFps) * strideHz) % 1;

    const leftPlant = prevCycle > 0.85 && cycle < 0.2;
    const rightPlant = prevCycle < 0.5 && cycle >= 0.5;
    footContact = (leftPlant || rightPlant) && t > 0.04 && t < 0.94;
    if (leftPlant) contactSide = -1;
    else if (rightPlant) contactSide = 1;

    const amp = act === 'run' ? 1.05 : act === 'walk-hero' ? 0.92 : 0.62;
    const activeMove = t < 0.9 ? 1 : easeOutCubic(Math.max(0, (1 - t) / 0.1));
    const leftLeg = evalWilliamsLeg(cycle);
    const rightLeg = evalWilliamsLeg((cycle + 0.5) % 1);
    const { hipY, downSquash } = evalWilliamsHipBounce(cycle);
    const { hipY: delayedHipY } = evalWilliamsHipBounce((cycle - 0.16 + 1) % 1);

    const armPhase = Math.cos(((cycle - 0.12 + 1) % 1) * Math.PI * 2);
    const wristPhase = Math.sin(((cycle - 0.12 + 1) % 1) * Math.PI * 2);

    leftLegPhase = leftLeg.stride * amp * activeMove;
    rightLegPhase = rightLeg.stride * amp * activeMove;
    leftFootLift = leftLeg.lift * (act === 'run' ? 1.12 : 0.92) * activeMove;
    rightFootLift = rightLeg.lift * (act === 'run' ? 1.12 : 0.92) * activeMove;
    leftFootRoll = evalNaturalFootRoll(cycle) * activeMove;
    rightFootRoll = evalNaturalFootRoll((cycle + 0.5) % 1) * activeMove;
    const armEmoMul = shot.emotion === 'angry' ? 1.18 : shot.emotion === 'tired' ? 0.62 : 0.86;
    leftArmSwing = -armPhase * amp * 0.68 * armEmoMul * activeMove;
    rightArmSwing = armPhase * amp * 0.68 * armEmoMul * activeMove;
    leftWristLag = -wristPhase * 0.18 * activeMove;
    rightWristLag = wristPhase * 0.18 * activeMove;
    const bounceEmoMul = shot.emotion === 'happy' ? 1.25 : shot.emotion === 'tired' ? 0.6 : 0.88;
    verticalLiftNorm =
      Math.max(0, (hipY + 0.35) * (act === 'run' ? 0.064 : 0.025)) * bounceEmoMul * activeMove;
    bodyLeanRad =
      (act === 'walk-tired' ? 0.095 : act === 'run' ? 0.19 : 0.052) * facing +
      hipY * 0.014;
    headTiltRad =
      (act === 'walk-tired' ? 0.085 : 0.015) * facing +
      delayedHipY * (act === 'run' ? 0.05 : 0.028);
    squashY =
      1 -
      downSquash * (act === 'run' ? 0.072 : 0.036) * activeMove +
      Math.max(0, hipY) * 0.02 * activeMove;
  } else if (act === 'jump-joy') {
    // Classic Disney Anticipation (0..0.22) -> Launch & Apex (0.22..0.75) -> Smooth Damped Landing Follow-Through!
    if (t < 0.22) {
      const a = easeOutCubic(t / 0.22);
      squashY = 1 - a * 0.18;
      leftArmSwing = -0.58 * a;
      rightArmSwing = -0.58 * a;
      headTiltRad = 0.06 * a;
    } else if (t < 0.75) {
      const j = (t - 0.22) / 0.53;
      const arc = 4 * j * (1 - j);
      verticalLiftNorm = arc * 0.34;
      leftFootLift = arc * 0.85;
      rightFootLift = arc * 0.72;
      leftLegPhase = arc * 0.28;
      rightLegPhase = -arc * 0.22;
      const speedStretch = Math.abs(j - 0.5) * 2;
      squashY = 1.02 + speedStretch * 0.14;
      // Smooth continuous arm arc from -0.58 up to +1.02 and easing into landing
      leftArmSwing = -0.58 + easeOutCubic(Math.min(1, j * 2.2)) * 1.56 - Math.max(0, j - 0.72) * 1.4;
      rightArmSwing = leftArmSwing;
      headTiltRad = -0.09 * arc;
    } else {
      const l = (t - 0.75) / 0.25;
      footContact = l < 0.16;
      contactSide = 0;
      const damp = Math.exp(-l * 4.2) * Math.sin(l * Math.PI * 2.0);
      squashY = 1 - damp * 0.18;
      // Continuous follow-through arm settle (zero abrupt snap!)
      leftArmSwing = 0.58 * (1 - easeOutCubic(l)) - Math.max(0, damp) * 0.35;
      rightArmSwing = leftArmSwing;
      headTiltRad = Math.sin(Math.min(1, l * 1.4) * Math.PI) * 0.09;
    }
  } else if (act === 'kneel-pickup') {
    // 3-Beat Narrative Kneel: Anticipation (0..18%) -> Crouch & Grab Hold (18..68%) -> Weighty Stand-Up (68..100%)
    let dip = 0;
    if (t < 0.18) {
      const a = t / 0.18;
      dip = -Math.sin(a * Math.PI) * 0.14; // Subtle upward anticipation before bending down!
    } else if (t < 0.68) {
      const c = (t - 0.18) / 0.5;
      dip = c < 0.45 ? easeOutCubic(c / 0.45) : 1.0 + Math.sin((c - 0.45) * Math.PI * 2) * 0.04;
    } else {
      const s = (t - 0.68) / 0.32;
      dip = 1 - easeInOutCubic(s);
    }
    squashY = 1 - dip * 0.18;
    bodyLeanRad = dip * 0.22 * facing;
    rightArmSwing = -dip * 0.92;
    leftArmSwing = dip * 0.24; // Counter-balance left arm!
    headTiltRad = dip * 0.18 * facing;
  } else if (act === 'surprise') {
    // 2-Frame Anticipation Squash -> Explosive Startled Pop -> Damped Elastic Settle!
    if (t < 0.12) {
      const a = easeOutCubic(t / 0.12);
      squashY = 1 - a * 0.12;
      leftArmSwing = -0.25 * a;
      rightArmSwing = -0.25 * a;
    } else {
      const u = (t - 0.12) / 0.88;
      const pop = u < 0.18 ? easeOutCubic(u / 0.18) : Math.exp(-(u - 0.18) * 3.8) * Math.cos((u - 0.18) * 5.2);
      verticalLiftNorm = Math.max(0, pop) * 0.11;
      leftFootLift = Math.max(0, pop) * 0.35;
      rightFootLift = Math.max(0, pop) * 0.35;
      squashY = 1 + pop * 0.14;
      leftArmSwing = pop * 0.9;
      rightArmSwing = pop * 0.9;
      headTiltRad = -pop * 0.12;
    }
  } else if (act === 'wave') {
    // Organic asymmetric elbow-leads-wrist wave with friendly head counter-tilt
    const w = Math.sin(qSec * 9.5 + Math.sin(qSec * 3.2) * 0.4);
    rightArmSwing = 0.9 + w * 0.3;
    leftArmSwing = -0.14 + Math.sin(qSec * 2.2) * 0.06;
    headTiltRad = Math.sin(qSec * 4.75 - 0.4) * 0.075;
    squashY = 1 + (organicBreathCurve(qSec * 0.34) - 0.5) * 0.04;
  } else if (act === 'talk-hero') {
    const breath = organicBreathCurve(qSec * 0.32 * emoTempoMul) - 0.5;
    const cadence = Math.sin(qSec * 6.8 + Math.sin(qSec * 2.3) * 0.7);
    headTiltRad = cadence * 0.065;
    rightArmSwing = 0.32 + Math.max(0, cadence) * 0.36;
    leftArmSwing = 0.12 + Math.max(0, -cadence) * 0.2;
    squashY = 1 + breath * 0.045 + Math.max(0, cadence) * 0.02;
  } else {
    // 'idle-breathe': Authentic asymmetric organic breath (never robotic sine!)
    const breath = organicBreathCurve(qSec * 0.28 * emoTempoMul) - 0.5;
    const breathLag = organicBreathCurve((qSec * 0.28 * emoTempoMul - 0.15 + 1) % 1) - 0.5;
    squashY = 1 + breath * 0.042;
    headTiltRad = Math.sin(qSec * 1.4) * 0.032 + breathLag * 0.02;
    leftArmSwing = breathLag * 0.08;
    rightArmSwing = breathLag * 0.08;
  }

  // Apply expressive whole-body posture & silhouette attitude for ALL 6 Emotions!
  if (shot.emotion === 'tired') {
    bodyLeanRad += 0.075 * facing;
    headTiltRad += 0.085 * facing;
    squashY -= 0.035;
    leftArmSwing -= 0.12;
    rightArmSwing -= 0.12;
  } else if (shot.emotion === 'happy') {
    headTiltRad -= 0.045 * facing;
    squashY += 0.025;
    verticalLiftNorm += Math.abs(Math.sin(qSec * 5.2)) * 0.018;
    leftArmSwing += 0.12;
    rightArmSwing += 0.12;
  } else if (shot.emotion === 'angry') {
    bodyLeanRad += 0.095 * facing;
    headTiltRad += 0.05 * facing;
    squashY -= 0.022;
    leftArmSwing -= 0.18;
    rightArmSwing += 0.18;
  } else if (shot.emotion === 'determined') {
    bodyLeanRad += 0.035 * facing;
    headTiltRad *= 0.55; // Steady locked heroic head!
    squashY += 0.015;
  } else if (shot.emotion === 'surprised') {
    headTiltRad -= 0.065 * facing;
    squashY += 0.038;
    leftArmSwing += 0.24;
    rightArmSwing += 0.24;
  }

  // Phase 4A: Apply recorded Webcam / Video / Live-Pad Motion Capture Track (respecting film cadence!)
  let mocapMouthOpen: number | undefined;
  let mocapViseme: VisemeId | undefined;
  if (shot.mocapTrack && shot.mocapTrack.samples.length > 0) {
    const mc = sampleMotionCaptureTrack(shot.mocapTrack, qSec);
    headYawRad = Math.max(-0.61, Math.min(0.61, mc.headYawRad));
    eyeLeadX = Math.max(-1, Math.min(1, headYawRad / 0.61));
    headTiltRad = Math.max(-0.36, Math.min(0.36, mc.headTiltRad));
    bodyLeanRad = Math.max(-0.3, Math.min(0.3, mc.bodyLeanRad));
    leftArmSwing = Math.max(-0.75, Math.min(1.15, mc.leftArmSwing));
    rightArmSwing = Math.max(-0.75, Math.min(1.15, mc.rightArmSwing));
    verticalLiftNorm = Math.max(0, Math.min(0.34, mc.verticalLiftNorm));
    squashY = mc.squashY;
    mocapMouthOpen = mc.mouthOpen;
    mocapViseme = mc.viseme;
  }

  // Phase 4B: Live Webcam / Live Puppet Pad / Live Mic real-time puppeteering override!
  if (liveOverride) {
    if (liveOverride.headYawRad !== undefined) {
      headYawRad = Math.max(-0.61, Math.min(0.61, liveOverride.headYawRad));
      eyeLeadX = Math.max(-1, Math.min(1, headYawRad / 0.61));
    }
    if (liveOverride.headTiltRad !== undefined) {
      headTiltRad = Math.max(-0.36, Math.min(0.36, liveOverride.headTiltRad));
    }
    if (liveOverride.bodyLeanRad !== undefined) {
      bodyLeanRad = Math.max(-0.3, Math.min(0.3, liveOverride.bodyLeanRad));
    }
    if (liveOverride.leftArmSwing !== undefined) {
      leftArmSwing = Math.max(-0.75, Math.min(1.15, liveOverride.leftArmSwing));
    }
    if (liveOverride.rightArmSwing !== undefined) {
      rightArmSwing = Math.max(-0.75, Math.min(1.15, liveOverride.rightArmSwing));
    }
    if (liveOverride.verticalLiftNorm !== undefined) {
      verticalLiftNorm = Math.max(0, Math.min(0.34, liveOverride.verticalLiftNorm));
    }
    if (liveOverride.squashY !== undefined) {
      squashY = liveOverride.squashY;
    }
  }

  // Clamp volume-preserving Squash & Stretch strictly inside ARAP form-preserving bounds!
  squashY = Math.max(0.82, Math.min(1.18, squashY));
  const squashX = 1 / squashY;

  // Phase 4C: Priority Lip-Sync Resolution:
  // 1) Live mic override -> 2) Recorded/Uploaded real VoiceLipSyncTrack -> 3) Mocap track -> 4) Upgraded Text Viseme!
  let mouthOpen = 0;
  let viseme: VisemeId = 'closed';
  if (liveOverride && (liveOverride.viseme !== undefined || liveOverride.mouthOpen !== undefined)) {
    viseme = liveOverride.viseme ?? (liveOverride.mouthOpen && liveOverride.mouthOpen > 0.14 ? 'AA' : 'closed');
    mouthOpen = liveOverride.mouthOpen ?? (viseme === 'closed' ? 0 : 0.72);
  } else if (shot.voiceTrack && shot.voiceTrack.frames.length > 0) {
    const v = sampleVoiceLipSync(shot.voiceTrack, localSec);
    mouthOpen = v.mouthOpen;
    viseme = v.viseme;
  } else if (mocapViseme !== undefined || mocapMouthOpen !== undefined) {
    viseme = mocapViseme ?? 'closed';
    mouthOpen = mocapMouthOpen ?? 0;
  } else if (shot.dialogue.trim().length > 0) {
    const v = textDialogueToViseme(shot.dialogue, t);
    mouthOpen = v.mouthOpen;
    viseme = v.viseme;
  }

  // Natural blinking every ~3.4 seconds
  const blinkPhase = (qSec + 1.2) % 3.4;
  const blink = blinkPhase < 0.14 ? Math.sin((blinkPhase / 0.14) * Math.PI) : 0;

  return {
    groundX: mp.x,
    groundY: mp.y,
    depthScale,
    headTiltRad,
    headYawRad,
    eyeLeadX,
    bodyLeanRad,
    squashX,
    squashY,
    verticalLiftNorm,
    leftArmSwing,
    rightArmSwing,
    leftLegPhase,
    rightLegPhase,
    leftFootLift,
    rightFootLift,
    leftFootRoll,
    rightFootRoll,
    leftWristLag,
    rightWristLag,
    facing,
    velocity: Math.hypot(mp.vx, mp.vy),
    footContact,
    contactSide,
    mouthOpen,
    viseme,
    blink,
  };
}

/**
 * Pure ARAP + Rigidity-Protected 2.5D Vertex Deformer!
 * Guarantees ZERO skull/face jelly distortion:
 * - Vertices inside rigid head zone (v <= rigidHeadEndY) undergo rigid 2D rotation
 *   + true 2.5D projective depth parallax (nose/center shifts more than outer cheeks!).
 * - Lower torso & limbs articulate smoothly with clamped strain (zero tearing!).
 */
export function deform25DRigidVertex(
  u: number,
  v: number,
  pose: CharacterPose25D,
  rigidHeadEndY = 0.37
): { x: number; y: number } {
  const cx = 0.5;
  // Smooth transition band between rigid head (1.0) and articulated body (0.0)
  const headBlend =
    v <= rigidHeadEndY
      ? 1
      : v >= rigidHeadEndY + 0.08
        ? 0
        : 1 - (v - rigidHeadEndY) / 0.08;

  // 1. Rigid Head Transform + True 2.5D Projective Depth Turn
  const hx = u - cx;
  const hy = v - rigidHeadEndY * 0.62;
  const cosH = Math.cos(pose.headTiltRad);
  const sinH = Math.sin(pose.headTiltRad);
  let rxHead = cx + hx * cosH - hy * sinH;
  const ryHead = rigidHeadEndY * 0.62 + hx * sinH + hy * cosH;

  // 2.5D cylindrical face depth profile: center (nose/eyes) protrudes further than ears!
  const radialDist = Math.min(1, Math.abs(hx) / 0.24);
  const faceDepth = Math.sqrt(Math.max(0, 1 - radialDist * radialDist));
  const yawShift = Math.sin(pose.headYawRad) * faceDepth * 0.085;
  const foreshorten = 1 - Math.abs(Math.sin(pose.headYawRad)) * 0.14;
  rxHead = cx + (rxHead - cx) * foreshorten + yawShift;

  // 2. Articulated Body & Limbs with Volume-Preserving Squash & ARAP Clamp
  let bx = cx + (u - cx) * pose.squashX;
  let by = 1 - (1 - v) * pose.squashY;

  // Torso lean around hip pivot (0.5, 0.72)
  const leanFactor = Math.max(0, (0.78 - v) / 0.78);
  bx += Math.sin(pose.bodyLeanRad) * leanFactor * 0.16;

  // Left/Right arm wings: True Circular Shoulder-Pivot Arcs (Disney Principle #7: Arcs!)
  if (v > 0.34 && v < 0.67) {
    const armMask = Math.sin(((v - 0.34) / 0.33) * Math.PI);
    if (u < 0.36) {
      const reach = (0.36 - u) / 0.36;
      const angle = pose.leftArmSwing * reach * armMask * 0.62;
      const rx = bx - 0.36;
      const ry = by - 0.42;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      bx = 0.36 + rx * ca - ry * sa;
      by = 0.42 + rx * sa + ry * ca;
    } else if (u > 0.64) {
      const reach = (u - 0.64) / 0.36;
      const angle = -pose.rightArmSwing * reach * armMask * 0.62;
      const rx = bx - 0.64;
      const ry = by - 0.42;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      bx = 0.64 + rx * ca - ry * sa;
      by = 0.42 + rx * sa + ry * ca;
    }
  }

  // Left/Right articulated legs (v > 0.64): Ground-locked Stance + Passing-Pose Swing Arc!
  if (v > 0.64) {
    const legT = (v - 0.64) / 0.36;
    const smoothLeg = legT * legT * (3 - 2 * legT);
    const strideX = u < 0.5 ? pose.leftLegPhase : pose.rightLegPhase;
    bx += strideX * smoothLeg * 0.125;
    // Foot peaks gently at Passing Pose (mid-swing) and touches down cleanly at max Contact stride!
    const passingClearance = Math.max(0, 1 - Math.abs(strideX)) * (Math.abs(pose.leftLegPhase) + Math.abs(pose.rightLegPhase) > 0.15 ? 1 : 0);
    by -= passingClearance * smoothLeg * 0.048;
  }

  // Seamless neck weld matching exact torso top squash displacement (zero neck seam!)
  const neckSquashOffset = (1 - rigidHeadEndY) * (1 - pose.squashY);
  const x = bx * (1 - headBlend) + (rxHead + Math.sin(pose.bodyLeanRad) * 0.115) * headBlend;
  const y = by * (1 - headBlend) + (ryHead + neckSquashOffset) * headBlend;

  // ARAP strain guard: keep displacement tightly bounded so silhouette NEVER tears
  return {
    x: Math.max(-0.22, Math.min(1.22, x)),
    y: Math.max(-0.22, Math.min(1.22, y)),
  };
}

// Reusable scratch buffers for zero-GC 60fps Klaus Cel Lighting
let actorScratchA: HTMLCanvasElement | null = null;
let actorScratchB: HTMLCanvasElement | null = null;

function getScratchCanvas(slot: 'a' | 'b', w: number, h: number): HTMLCanvasElement {
  const existing = slot === 'a' ? actorScratchA : actorScratchB;
  if (existing && existing.width === w && existing.height === h) return existing;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  if (slot === 'a') actorScratchA = c;
  else actorScratchB = c;
  return c;
}

/**
 * Deterministic ground-plane footstep interaction (puddle ripples + splash drops in rain,
 * soft cartoon dust puffs on dry hills — 100% identical in live playback & MP4/GIF exports!).
 */
function drawDeterministicFootstepEffects(
  ctx: CanvasRenderingContext2D,
  world: FilmWorldConfig,
  shot: FilmShot,
  pose: CharacterPose25D,
  footX: number,
  footY: number,
  drawW: number,
  drawH: number,
  timeSec: number
) {
  const isWet = world.setId === 'rainy-alley' || world.weather === 'rain';
  const dur = Math.max(0.5, shot.durationSec);
  const t = Math.max(0, Math.min(1, timeSec / dur));
  const act = shot.action;

  const drawBurst = (bx: number, by: number, age01: number, strength = 1) => {
    if (age01 < 0 || age01 > 1) return;
    const alpha = Math.pow(1 - age01, 1.35) * strength;
    if (alpha < 0.03) return;
    ctx.save();
    if (isWet) {
      // Expanding wet cobblestone puddle ripple rings + tiny arc droplets!
      const rx = (drawW * 0.08 + age01 * drawW * 0.24) * strength;
      const ry = rx * 0.28;
      ctx.strokeStyle = `rgba(186, 224, 255, ${(alpha * 0.62).toFixed(3)})`;
      ctx.lineWidth = Math.max(1.2, 2.2 * (1 - age01));
      ctx.beginPath();
      ctx.ellipse(bx, by + 2, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();

      if (age01 < 0.72) {
        const dAge = age01 / 0.72;
        ctx.fillStyle = `rgba(210, 236, 255, ${((1 - dAge) * 0.72 * strength).toFixed(3)})`;
        for (let k = -1; k <= 1; k += 2) {
          for (let j = 0; j < 2; j++) {
            const spread = (0.55 + j * 0.45) * drawW * 0.14;
            const dx = k * spread * dAge;
            const dy = -Math.sin(dAge * Math.PI) * drawH * (0.055 + j * 0.03) * strength;
            ctx.beginPath();
            ctx.arc(bx + dx, by + dy, Math.max(1.4, drawW * 0.011 * (1 - dAge * 0.4)), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    } else {
      // Soft rising hand-drawn cartoon dust puffs trailing behind the planted heel!
      const trailDir = -pose.facing;
      ctx.fillStyle =
        world.setId === 'moonlit-forest'
          ? `rgba(195, 220, 240, ${(alpha * 0.36).toFixed(3)})`
          : `rgba(246, 232, 204, ${(alpha * 0.52).toFixed(3)})`;
      for (let p = 0; p < 3; p++) {
        const px = bx + trailDir * (drawW * (0.04 + p * 0.065) + age01 * drawW * 0.16);
        const py = by - age01 * drawH * (0.045 + p * 0.025) - p * 2;
        const r = Math.max(3, drawW * (0.032 + p * 0.012) * (0.65 + age01 * 0.75) * strength);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  if (act === 'walk-tired' || act === 'walk-hero' || act === 'run') {
    const emoTempoMul =
      shot.emotion === 'tired'
        ? 0.78
        : shot.emotion === 'happy'
          ? 1.12
          : shot.emotion === 'angry'
            ? 1.16
            : shot.emotion === 'determined'
              ? 1.06
              : 1.0;
    const strideHz = (act === 'run' ? 1.85 : act === 'walk-hero' ? 1.15 : 0.78) * emoTempoMul;
    const cycle = (timeSec * strideHz) % 1;
    const str = act === 'run' ? 1.15 : act === 'walk-hero' ? 0.85 : 0.6;
    if (t > 0.05 && t < 0.96) {
      // Left heel strike at cycle = 0.00; right heel strike at cycle = 0.50
      if (cycle < 0.42) {
        drawBurst(footX - drawW * 0.06 * pose.facing, footY, cycle / 0.42, str);
      }
      const rightPhase = (cycle + 0.5) % 1;
      if (rightPhase < 0.42) {
        drawBurst(footX + drawW * 0.06 * pose.facing, footY, rightPhase / 0.42, str);
      }
    }
  } else if (act === 'jump-joy' && t >= 0.75) {
    // Double-foot impact splash/dust right when landing from apex!
    const landAge = (t - 0.75) / 0.25;
    drawBurst(footX - drawW * 0.08, footY, landAge, 1.25);
    drawBurst(footX + drawW * 0.08, footY, landAge, 1.25);
  }
}

/**
 * Renders the studio-grade 2-Bone IK + Continuous LBS 2.5D actor into an offscreen buffer,
 * applies real facial acting (blinks + 3-frame eye-lead + 6 emotions + 6-viseme lip-sync),
 * Klaus directional cel rim-lighting & shadow crescent, anatomical Verlet cloth ribbon,
 * luminous props (with live ground light pool!), and deterministic footstep effects!
 */
function render25DActorLayer(
  targetCtx: CanvasRenderingContext2D,
  sourceImg: HTMLCanvasElement | ImageBitmap,
  srcW: number,
  srcH: number,
  actor: FilmActor,
  world: FilmWorldConfig,
  shot: FilmShot,
  pose: CharacterPose25D,
  stageW: number,
  stageH: number,
  timeSec: number,
  lightningFlash: number,
  decomposedPartBitmaps?: Map<string, ImageBitmap>,
  masterCache?: MasterRigRuntimeCache | null,
  overrideYawDeg?: number,
  overrideUniversalAction?: UniversalActionId
): { footX: number; footY: number; drawW: number; drawH: number; actorCanvas: HTMLCanvasElement } {
  const actorScale = Math.max(0.65, Math.min(1.5, actor.scale ?? 1));
  const baseH = stageH * 0.44 * pose.depthScale * actorScale;
  const aspect = srcW / Math.max(1, srcH);
  const drawH = Math.max(64, Math.round(baseH));
  const drawW = Math.max(64, Math.round(drawH * aspect));

  // Generous headroom for jump apex (0.34*drawH), umbrella dome, Verlet scarf & wide strides!
  const bufW = Math.round(drawW * 1.9);
  const bufH = Math.round(drawH * 1.95);
  const padX = Math.round((bufW - drawW) / 2);
  const padY = Math.round(drawH * 0.72);

  const charBuf = getScratchCanvas('a', bufW, bufH);
  const cctx = charBuf.getContext('2d')!;
  cctx.clearRect(0, 0, bufW, bufH);

  const pack = getOrBuildCachedRigPack(sourceImg);
  const { anatomy } = pack;
  const isNightWorld = world.setId === 'rainy-alley' || world.setId === 'moonlit-forest';
  const lightRad = (world.lightAngleDeg * Math.PI) / 180;
  const lx = Math.cos(lightRad);
  const ly = Math.sin(lightRad);

  // Use Cloud GPU multi-part cutouts if explicitly generated by a remote Cloud GPU pipeline;
  // otherwise ALWAYS use the flagship local 2-Bone IK + Continuous 3-Stage LBS renderer!
  const decomposedParts = actor.decomposed?.parts;
  const useCloudMultiPart =
    actor.decomposed?.sourceEngine === 'cloud-gpu' &&
    decomposedParts &&
    decomposedParts.length > 0 &&
    decomposedPartBitmaps &&
    decomposedParts.some((p) => decomposedPartBitmaps.has(p.blobKey));

  let neckPt = { x: padX + anatomy.neckX * drawW, y: padY + anatomy.headEndV * drawH };
  let mouthPt = { x: padX + anatomy.mouthX * drawW, y: padY + anatomy.mouthY * drawH };
  let headTopPt = {
    x: padX + anatomy.headCenterX * drawW,
    y: padY + Math.max(0.03, anatomy.headCenterY - 0.13) * drawH,
  };
  let handRightPt = { x: padX + anatomy.handRightX * drawW, y: padY + anatomy.handRightY * drawH };
  let footLeftLocalPt = { x: padX + anatomy.footLeftX * drawW, y: padY + anatomy.groundV * drawH };
  let footRightLocalPt = { x: padX + anatomy.footRightX * drawW, y: padY + anatomy.groundV * drawH };

  if (useCloudMultiPart && decomposedParts && decomposedPartBitmaps) {
    const sx = drawW / Math.max(1, srcW);
    const sy = drawH / Math.max(1, srcH);
    const sorted = [...decomposedParts].sort((a, b) => a.zIndex - b.zIndex);
    const hipX = padX + anatomy.centerX * drawW;
    const hipY = padY + anatomy.groundV * drawH - pose.verticalLiftNorm * drawH;

    cctx.save();
    if (pose.facing < 0) {
      cctx.translate(hipX, 0);
      cctx.scale(-1, 1);
      cctx.translate(-hipX, 0);
    }
    cctx.translate(hipX, hipY);
    cctx.rotate((pose.facing < 0 ? -pose.bodyLeanRad : pose.bodyLeanRad) * 0.55);
    cctx.scale(pose.squashX, pose.squashY);
    cctx.translate(-hipX, -hipY);

    for (const part of sorted) {
      const bmp = decomposedPartBitmaps.get(part.blobKey);
      if (!bmp) continue;
      const px = padX + (part.x + part.pivotX) * sx;
      const py = padY + (part.y + part.pivotY) * sy - pose.verticalLiftNorm * drawH;
      let rot = 0;
      let offX = 0;
      let offY = 0;
      let scaleX = 1;
      if (part.role === 'head') {
        rot = pose.facing < 0 ? -pose.headTiltRad : pose.headTiltRad;
        offX = Math.sin(pose.headYawRad) * drawW * 0.045 * pose.facing;
        scaleX = 1 - Math.abs(Math.sin(pose.headYawRad)) * 0.12;
      } else if (part.role === 'arm_l') {
        rot = pose.leftArmSwing * 0.52;
      } else if (part.role === 'arm_r') {
        rot = -pose.rightArmSwing * 0.52;
      } else if (part.role === 'leg_l') {
        rot = -pose.leftLegPhase * 0.34;
        offY = -pose.leftFootLift * drawH * 0.06;
      } else if (part.role === 'leg_r') {
        rot = -pose.rightLegPhase * 0.34;
        offY = -pose.rightFootLift * drawH * 0.06;
      } else if (part.role === 'torso') {
        rot = (pose.facing < 0 ? -pose.bodyLeanRad : pose.bodyLeanRad) * 0.35;
      }
      cctx.save();
      cctx.translate(px + offX, py + offY);
      cctx.rotate(rot);
      cctx.scale(scaleX, 1);
      cctx.drawImage(bmp, -part.pivotX * sx, -part.pivotY * sy, part.w * sx, part.h * sy);
      cctx.restore();
    }
    cctx.restore();
  } else {
    // 1. FLAGSHIP 2-BONE IK + CONTINUOUS 3-STAGE LBS + FACING MIRROR + BLINK + EYE-LEAD + 6 EMOTIONS!
    const armMotionAmt = Math.min(
      1,
      Math.abs(pose.leftArmSwing) + Math.abs(pose.rightArmSwing) + pose.velocity * 1.6
    );
    const artPose: ArticulatedCartoonPose = {
      hipShiftX: 0,
      hipLiftY: pose.verticalLiftNorm,
      squashY: pose.squashY,
      squashX: pose.squashX,
      torsoLeanRad: pose.bodyLeanRad,
      chestCounterRad: -pose.bodyLeanRad * 0.25,
      headTiltRad: pose.headTiltRad,
      headLagY: Math.sin(timeSec * 4.2) * 0.008 * Math.max(0.25, armMotionAmt),
      headTurnX: Math.max(-1, Math.min(1, pose.headYawRad / 0.55)),
      leftArmAngle: pose.leftArmSwing,
      rightArmAngle: pose.rightArmSwing,
      leftArmLag: Math.cos(timeSec * 5.2) * 0.14 * armMotionAmt,
      rightArmLag: -Math.cos(timeSec * 5.2) * 0.14 * armMotionAmt,
      leftLegStride: pose.leftLegPhase,
      rightLegStride: pose.rightLegPhase,
      leftFootLift: pose.leftFootLift,
      rightFootLift: pose.rightFootLift,
      leftFootRoll: pose.leftFootRoll,
      rightFootRoll: pose.rightFootRoll,
      leftWristLag: pose.leftWristLag,
      rightWristLag: pose.rightWristLag,
      footContact: pose.footContact,
      contactSide: pose.contactSide,
      mouthOpen: pose.mouthOpen,
      viseme: pose.viseme,
      blink: pose.blink,
      facing: pose.facing,
    };

    const nightLamp = isNightWorld
      ? { x: padX + drawW * (0.5 + lx * 1.4), y: padY + drawH * (0.3 + ly * 0.6) }
      : null;

    // V3 Real-Time 2.5D Sobel Normal-Map Klaus Volumetric Cel & Fresnel Rim Shader (1-pass GPU & CPU!)
    const klausLight: KlausLightConfig | null = world.klausLighting
      ? {
          lx,
          ly,
          rimR: lightningFlash > 0.1 ? 0.86 : world.setId === 'moonlit-forest' ? 0.61 : 1.0,
          rimG: lightningFlash > 0.1 ? 0.93 : world.setId === 'moonlit-forest' ? 0.85 : 0.83,
          rimB: lightningFlash > 0.1 ? 1.0 : world.setId === 'moonlit-forest' ? 1.0 : 0.48,
          rimStrength: lightningFlash > 0.1 ? 0.72 + lightningFlash * 0.45 : 0.78,
          shadowR: world.setId === 'golden-hill' ? 0.24 : 0.06,
          shadowG: world.setId === 'golden-hill' ? 0.13 : 0.09,
          shadowB: world.setId === 'golden-hill' ? 0.19 : 0.2,
          shadowStrength: world.setId === 'golden-hill' ? 0.24 : 0.34,
        }
      : null;

    const effectiveAction =
      overrideUniversalAction ??
      shot.universalAction ??
      (actor.creatureClass && actor.creatureClass !== 'humanoid'
        ? UNIVERSAL_CREATURE_CATALOG[actor.creatureClass].defaultAction
        : undefined);
    const effectiveYawDeg =
      overrideYawDeg ??
      shot.viewYawDeg ??
      (pose.facing < 0 ? -Math.min(85, Math.abs(shot.headAngleX) + 35) : Math.min(85, Math.abs(shot.headAngleX)));

    const useMultiViewRig = Boolean(masterCache && masterCache.getAvailableAngles().length >= 2);
    const anchors = useMultiViewRig
      ? renderMasterRigCharacter(
          cctx,
          masterCache!,
          pack,
          artPose,
          { x: padX, y: padY, w: drawW, h: drawH },
          {
            boilTick: Math.floor(timeSec * 6),
            nightLampPos: nightLamp,
            emotion: shot.emotion,
            eyeLeadX: pose.eyeLeadX,
            klausLight,
            universalAction: effectiveAction,
            yawDeg: effectiveYawDeg,
          }
        ).anchors
      : renderMultiLayerRiggedCharacter(
          cctx,
          pack,
          artPose,
          { x: padX, y: padY, w: drawW, h: drawH },
          {
            boilTick: Math.floor(timeSec * 6),
            nightLampPos: nightLamp,
            emotion: shot.emotion,
            eyeLeadX: pose.eyeLeadX,
            klausLight,
            universalAction: effectiveAction,
            yawDeg: effectiveYawDeg,
          }
        );

    neckPt = anchors.neckScreen;
    mouthPt = anchors.mouthScreen;
    headTopPt = anchors.headTopScreen;
    footLeftLocalPt = anchors.footLeftScreen;
    footRightLocalPt = anchors.footRightScreen;
    // Smart FREE-HAND prop attachment: if one hand already holds a drawn rigid prop (e.g. cane/sword),
    // always hand the film prop (lantern / umbrella / letter) to the FREE hand!
    const rightBusy = Boolean(pack.skinnedMesh?.rightHasRigidProp);
    const leftBusy = Boolean(pack.skinnedMesh?.leftHasRigidProp);
    if (rightBusy && !leftBusy) {
      handRightPt = anchors.handLeftScreen;
    } else if (leftBusy && !rightBusy) {
      handRightPt = anchors.handRightScreen;
    } else {
      handRightPt = pose.facing >= 0 ? anchors.handRightScreen : anchors.handLeftScreen;
    }
  }

  // 2. Anatomically-Locked 6-Viseme Preston Blair Lip-Sync Mouth & Surprise Sparks!
  if (pose.viseme !== 'closed' && pose.mouthOpen > 0.08) {
    const mouthScale = Math.max(0.55, Math.min(1.65, (drawW / 245) * anatomy.mouthScale));
    drawCartoonMouth(
      cctx,
      mouthPt.x,
      mouthPt.y,
      mouthScale,
      pose.viseme,
      pose.mouthOpen,
      pose.headTiltRad * 0.85
    );
  }

  if (shot.emotion === 'surprised') {
    // Classic comic surprise sparks right above the actor's real detected head crown!
    cctx.save();
    cctx.strokeStyle = actor.styleDna.accentColor || '#E54D2E';
    cctx.lineWidth = Math.max(2.2, drawW * 0.014);
    cctx.lineCap = 'round';
    for (const ang of [-2.15, -1.57, -0.99]) {
      const r1 = drawH * 0.05;
      const r2 = drawH * 0.11;
      cctx.beginPath();
      cctx.moveTo(headTopPt.x + Math.cos(ang) * r1, headTopPt.y + Math.sin(ang) * r1 - 4);
      cctx.lineTo(headTopPt.x + Math.cos(ang) * r2, headTopPt.y + Math.sin(ang) * r2 - 4);
      cctx.stroke();
    }
    cctx.restore();
  }

  // 3. True Multi-Node Verlet Physical Wind Scarf/Cloth Solver anchored to REAL neck!
  if (actor.secondaryPhysics) {
    const windForce = world.windStrength * 1.45 - pose.velocity * 1.15 * pose.facing;
    const segLen = Math.max(5, drawW * 0.042);
    const pts = evaluateDeterministicVerletRibbon({
      anchorX: neckPt.x - pose.facing * drawW * 0.03,
      anchorY: neckPt.y + drawH * 0.02,
      windX: windForce,
      timeSec,
      floorY: padY + anatomy.groundV * drawH,
      segmentLength: segLen,
      nodeCount: 8,
    });
    const baseThick = Math.max(5.5, drawW * 0.036);
    cctx.save();
    cctx.lineCap = 'round';
    cctx.lineJoin = 'round';

    cctx.strokeStyle = actor.styleDna.inkColor;
    cctx.lineWidth = baseThick + Math.max(2.5, actor.styleDna.lineWeightPx);
    cctx.globalAlpha = 0.88;
    cctx.beginPath();
    cctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) * 0.5;
      const my = (pts[i].y + pts[i + 1].y) * 0.5;
      cctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    cctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    cctx.stroke();

    cctx.strokeStyle = actor.styleDna.accentColor;
    cctx.lineWidth = baseThick;
    cctx.globalAlpha = 0.94;
    cctx.stroke();
    cctx.restore();
  }

  // 4. Legacy 2D Klaus rim pass ONLY for remote Cloud GPU multi-part cutouts (local V3 runs 1-pass normal-map Klaus!)
  if (world.klausLighting && useCloudMultiPart) {
    const lightBuf = getScratchCanvas('b', bufW, bufH);
    const lctx = lightBuf.getContext('2d')!;
    lctx.clearRect(0, 0, bufW, bufH);

    const rimDist = Math.max(4, drawW * 0.028);

    const rimColor =
      lightningFlash > 0.1
        ? `rgba(218, 238, 255, ${(0.55 + lightningFlash * 0.45).toFixed(2)})`
        : world.setId === 'golden-hill'
          ? 'rgba(255, 214, 128, 0.62)'
          : world.setId === 'moonlit-forest'
            ? 'rgba(155, 216, 255, 0.52)'
            : 'rgba(255, 206, 118, 0.56)';

    const shadowColor =
      world.setId === 'golden-hill'
        ? 'rgba(62, 34, 48, 0.24)'
        : world.setId === 'moonlit-forest'
          ? 'rgba(12, 24, 52, 0.34)'
          : 'rgba(16, 22, 42, 0.32)';

    lctx.drawImage(charBuf, 0, 0);
    lctx.globalCompositeOperation = 'destination-out';
    lctx.drawImage(charBuf, -lx * rimDist, -ly * rimDist);
    lctx.globalCompositeOperation = 'source-in';
    lctx.fillStyle = rimColor;
    lctx.fillRect(0, 0, bufW, bufH);
    lctx.globalCompositeOperation = 'source-over';

    cctx.save();
    cctx.globalCompositeOperation = 'source-atop';
    const shGrad = cctx.createLinearGradient(
      padX + drawW * (0.5 + lx * 0.6),
      padY + drawH * (0.5 + ly * 0.6),
      padX + drawW * (0.5 - lx * 0.6),
      padY + drawH * (0.5 - ly * 0.6)
    );
    shGrad.addColorStop(0, 'rgba(0,0,0,0)');
    shGrad.addColorStop(0.58, 'rgba(0,0,0,0)');
    shGrad.addColorStop(1, shadowColor);
    cctx.fillStyle = shGrad;
    cctx.fillRect(0, 0, bufW, bufH);

    cctx.globalCompositeOperation = 'lighter';
    cctx.drawImage(lightBuf, 0, 0);
    cctx.restore();
  }

  // 5. Anatomically Hand-Attached Interactive Props (Glowing Letter / Lantern / Umbrella)
  const px = handRightPt.x;
  const py = handRightPt.y;
  if (shot.prop === 'glowing-letter') {
    cctx.save();
    const glow = cctx.createRadialGradient(px, py, 2, px, py, drawW * 0.32);
    glow.addColorStop(0, 'rgba(255, 232, 148, 0.78)');
    glow.addColorStop(1, 'rgba(255, 198, 72, 0)');
    cctx.fillStyle = glow;
    cctx.beginPath();
    cctx.arc(px, py, drawW * 0.32, 0, Math.PI * 2);
    cctx.fill();

    cctx.translate(px, py);
    cctx.rotate((-0.18 + Math.sin(timeSec * 3) * 0.06) * pose.facing);
    cctx.fillStyle = '#FFFDF5';
    cctx.strokeStyle = actor.styleDna.inkColor;
    cctx.lineWidth = 2.4;
    cctx.beginPath();
    cctx.roundRect(-drawW * 0.085, -drawH * 0.04, drawW * 0.17, drawH * 0.08, 3);
    cctx.fill();
    cctx.stroke();
    cctx.fillStyle = '#E54D2E';
    cctx.beginPath();
    cctx.arc(0, 0, Math.max(3, drawW * 0.017), 0, Math.PI * 2);
    cctx.fill();
    cctx.restore();
  } else if (shot.prop === 'lantern') {
    cctx.save();
    const flicker = 0.94 + Math.sin(timeSec * 14.3) * 0.06;
    const glow = cctx.createRadialGradient(px, py + drawH * 0.06, 4, px, py + drawH * 0.06, drawW * 0.52 * flicker);
    glow.addColorStop(0, 'rgba(255, 228, 138, 0.85)');
    glow.addColorStop(0.5, 'rgba(245, 162, 46, 0.28)');
    glow.addColorStop(1, 'rgba(245, 162, 46, 0)');
    cctx.fillStyle = glow;
    cctx.beginPath();
    cctx.arc(px, py + drawH * 0.06, drawW * 0.52 * flicker, 0, Math.PI * 2);
    cctx.fill();

    // Brass handle + warm glass lantern frame
    cctx.strokeStyle = '#1C1917';
    cctx.lineWidth = 2.4;
    cctx.beginPath();
    cctx.arc(px, py + drawH * 0.02, drawW * 0.028, Math.PI, 0);
    cctx.stroke();
    cctx.fillStyle = '#F7C95B';
    cctx.beginPath();
    cctx.roundRect(px - drawW * 0.046, py + drawH * 0.022, drawW * 0.092, drawH * 0.092, 5);
    cctx.fill();
    cctx.stroke();
    cctx.fillStyle = '#FFF9DC';
    cctx.beginPath();
    cctx.ellipse(px, py + drawH * 0.068, drawW * 0.02, drawH * 0.026, 0, 0, Math.PI * 2);
    cctx.fill();
    cctx.restore();
  } else if (shot.prop === 'umbrella') {
    cctx.save();
    // Clearance strictly above the actor's real head crown so dome NEVER clips face!
    const gripX = pack.useMultiPart ? px + pose.facing * drawW * 0.05 : headTopPt.x + pose.facing * drawW * 0.1;
    const gripY = pack.useMultiPart ? py : headTopPt.y + drawH * 0.14;
    const domeY = Math.min(gripY - drawH * 0.34, headTopPt.y - drawH * 0.12);
    const domeX = gripX - pose.facing * drawW * 0.04;
    const domeR = Math.max(drawW * 0.34, drawH * 0.2);

    // Wooden handle + J-hook
    cctx.strokeStyle = '#5C3820';
    cctx.lineWidth = Math.max(3, drawW * 0.018);
    cctx.lineCap = 'round';
    cctx.beginPath();
    cctx.moveTo(gripX, gripY + drawH * 0.04);
    cctx.lineTo(domeX, domeY);
    cctx.stroke();

    // Scalloped storybook dome + ivory center stripe
    cctx.fillStyle = actor.styleDna.accentColor || '#D9432C';
    cctx.strokeStyle = '#1C1917';
    cctx.lineWidth = 2.6;
    cctx.beginPath();
    cctx.arc(domeX, domeY + drawH * 0.04, domeR, Math.PI, 0);
    cctx.quadraticCurveTo(domeX + domeR * 0.5, domeY + drawH * 0.04 - 9, domeX, domeY + drawH * 0.04);
    cctx.quadraticCurveTo(domeX - domeR * 0.5, domeY + drawH * 0.04 - 9, domeX - domeR, domeY + drawH * 0.04);
    cctx.closePath();
    cctx.fill();
    cctx.stroke();

    cctx.fillStyle = '#FAF2DE';
    cctx.beginPath();
    cctx.moveTo(domeX, domeY + drawH * 0.04 - domeR);
    cctx.quadraticCurveTo(domeX + domeR * 0.35, domeY + drawH * 0.04 - domeR * 0.45, domeX + domeR * 0.32, domeY + drawH * 0.04 - 4);
    cctx.quadraticCurveTo(domeX, domeY + drawH * 0.04 - 10, domeX - domeR * 0.32, domeY + drawH * 0.04 - 4);
    cctx.quadraticCurveTo(domeX - domeR * 0.35, domeY + drawH * 0.04 - domeR * 0.45, domeX, domeY + drawH * 0.04 - domeR);
    cctx.closePath();
    cctx.fill();
    cctx.stroke();

    // Live rain splash droplets bouncing off the umbrella canopy!
    if (world.weather === 'rain' || world.setId === 'rainy-alley') {
      cctx.strokeStyle = 'rgba(220, 240, 255, 0.78)';
      cctx.lineWidth = 1.4;
      for (let d = 0; d < 4; d++) {
        const dp = (timeSec * 3.1 + d * 0.27) % 1;
        const sx = domeX + (d - 1.5) * domeR * 0.36 + (d % 2 === 0 ? 1 : -1) * dp * 10;
        const sy = domeY + drawH * 0.04 - domeR + 8 + Math.abs(d - 1.5) * 6 - Math.sin(dp * Math.PI) * 12;
        cctx.globalAlpha = 1 - dp;
        cctx.beginPath();
        cctx.arc(sx, sy, 1.6, 0, Math.PI * 2);
        cctx.stroke();
      }
    }
    cctx.restore();
  }

  // Exact grounded foot position on 3D Floor Plane (0.00px ground lock!)
  const footX = pose.groundX * stageW;
  const footY = pose.groundY * stageH;
  const drawLeft = footX - (padX + anatomy.centerX * drawW);
  const drawTop = footY - (padY + anatomy.groundV * drawH);

  // 6. Dynamic Contact Shadow, Cast Shadow & Lantern Live Ground Illumination Pool!
  targetCtx.save();
  const shadowShrink = Math.max(0.45, 1 - pose.verticalLiftNorm * 1.4);
  const shadowAlpha = Math.max(0.12, 0.36 - pose.verticalLiftNorm * 0.45);
  const castSkew = -lx * drawW * 0.22;

  if (shot.prop === 'lantern') {
    const lanternWorldX = drawLeft + px;
    const poolR = drawW * 0.85;
    const flick = 0.92 + Math.sin(timeSec * 13.7) * 0.08;
    const pool = targetCtx.createRadialGradient(
      lanternWorldX,
      footY + 4,
      4,
      lanternWorldX,
      footY + 4,
      poolR * flick
    );
    pool.addColorStop(0, 'rgba(255, 214, 118, 0.44)');
    pool.addColorStop(0.45, 'rgba(245, 166, 54, 0.18)');
    pool.addColorStop(1, 'rgba(245, 166, 54, 0)');
    targetCtx.fillStyle = pool;
    targetCtx.beginPath();
    targetCtx.ellipse(lanternWorldX, footY + 4, poolR * flick, drawH * 0.14 * flick, 0, 0, Math.PI * 2);
    targetCtx.fill();
  }

  targetCtx.fillStyle = `rgba(12, 10, 14, ${(shadowAlpha * 0.48).toFixed(2)})`;
  targetCtx.beginPath();
  targetCtx.ellipse(
    footX + castSkew,
    footY + 3,
    drawW * 0.36 * shadowShrink,
    drawH * 0.048 * shadowShrink,
    0,
    0,
    Math.PI * 2
  );
  targetCtx.fill();

  // V3 Real Per-Foot Dynamic Contact Shadows (tighten crisply on ground contact, soften on passing lift!)
  const flWorldX = drawLeft + footLeftLocalPt.x;
  const frWorldX = drawLeft + footRightLocalPt.x;
  const flScale = Math.max(0.45, 1 - pose.leftFootLift * 0.55) * shadowShrink;
  const frScale = Math.max(0.45, 1 - pose.rightFootLift * 0.55) * shadowShrink;
  targetCtx.fillStyle = `rgba(8, 7, 10, ${(shadowAlpha * flScale).toFixed(2)})`;
  targetCtx.beginPath();
  targetCtx.ellipse(flWorldX, footY, drawW * 0.14 * flScale, drawH * 0.025 * flScale, 0, 0, Math.PI * 2);
  targetCtx.fill();
  targetCtx.fillStyle = `rgba(8, 7, 10, ${(shadowAlpha * frScale).toFixed(2)})`;
  targetCtx.beginPath();
  targetCtx.ellipse(frWorldX, footY, drawW * 0.14 * frScale, drawH * 0.025 * frScale, 0, 0, Math.PI * 2);
  targetCtx.fill();
  targetCtx.restore();

  // 6B. Deterministic Footstep Puddle Ripples / Cartoon Dust Puffs!
  drawDeterministicFootstepEffects(targetCtx, world, shot, pose, footX, footY, drawW, drawH, timeSec);

  // 7. Direction-Aware Hand-Drawn Smear Speed Lines (ALWAYS trails behind travel direction!)
  if (pose.velocity > 0.22 || shot.action === 'run') {
    const trail = -pose.facing;
    targetCtx.save();
    targetCtx.strokeStyle = isNightWorld ? 'rgba(255, 242, 206, 0.42)' : 'rgba(28, 25, 23, 0.22)';
    targetCtx.lineWidth = 2.4;
    targetCtx.lineCap = 'round';
    for (let s = 0; s < 3; s++) {
      const sy = footY - drawH * (0.28 + s * 0.22);
      targetCtx.beginPath();
      targetCtx.moveTo(footX + trail * drawW * 0.4, sy);
      targetCtx.lineTo(footX + trail * drawW * (0.68 + s * 0.1), sy + 2);
      targetCtx.stroke();
    }
    targetCtx.restore();
  }

  // Blit final 2-Bone IK lit 2.5D character onto stage!
  targetCtx.drawImage(charBuf, drawLeft, drawTop);

  return { footX, footY, drawW, drawH, actorCanvas: charBuf };
}

// ============================================================================
// 5. 6-LAYER DISNEY MULTI-PLANE 2.5D WORLD & CAMERA COMPOSITOR
// ============================================================================

export function computeParallaxOffset(camX: number, camY: number, depthFactor: number, w: number, h: number) {
  return {
    ox: -camX * w * depthFactor,
    oy: -camY * h * depthFactor * 0.45,
  };
}

function drawWeatherParticles(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  weather: WeatherKind,
  intensity: number,
  wind: number,
  timeSec: number,
  layer: 'mid' | 'front',
  accentColor: string
) {
  if (weather === 'none' || intensity <= 0.02) return;
  const count = Math.round((layer === 'front' ? 28 : 44) * intensity);
  ctx.save();
  if (weather === 'rain') {
    ctx.strokeStyle = layer === 'front' ? 'rgba(218, 232, 252, 0.46)' : 'rgba(186, 206, 235, 0.26)';
    ctx.lineWidth = layer === 'front' ? 1.8 : 1.1;
    const speed = layer === 'front' ? 760 : 520;
    const len = layer === 'front' ? 26 : 16;
    const slant = wind * 14;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const seed = i * 97.3 + (layer === 'front' ? 13 : 0);
      const x = ((seed * 41.7 + timeSec * slant * 22) % (w + 120) + (w + 120)) % (w + 120) - 60;
      const y = ((seed * 23.9 + timeSec * speed) % (h + 80)) - 40;
      ctx.moveTo(x, y);
      ctx.lineTo(x + slant, y + len);
    }
    ctx.stroke();

    // Physical ground-plane raindrop puddle splash ripples (front layer)
    if (layer === 'front') {
      const rippleCount = Math.max(6, Math.round(14 * intensity));
      ctx.lineWidth = 1.15;
      for (let i = 0; i < rippleCount; i++) {
        const phase = (timeSec * 1.65 + i * 0.37) % 1;
        const rx = ((i * 197.3 + Math.floor(timeSec * 1.65 + i * 0.37) * 73.1) % (w * 0.92)) + w * 0.04;
        const ry = h * (0.68 + ((i * 53.7) % 24) / 100);
        const radX = 4 + phase * 18;
        const radY = 1.4 + phase * 4.5;
        ctx.strokeStyle = `rgba(214, 232, 255, ${((1 - phase) * 0.38).toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse(rx, ry, radX, radY, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  } else if (weather === 'wind-leaves') {
    for (let i = 0; i < Math.max(6, Math.round(count * 0.45)); i++) {
      const seed = i * 73.1 + (layer === 'front' ? 5 : 0);
      const speedX = (wind >= 0 ? 1 : -1) * (layer === 'front' ? 175 : 105);
      const x = ((seed * 53 + timeSec * speedX) % (w + 100) + (w + 100)) % (w + 100) - 50;
      const y = ((seed * 31 + Math.sin(timeSec * 2.2 + i) * 42 + timeSec * 28) % h);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(timeSec * 2.4 + i);
      ctx.fillStyle = i % 2 === 0 ? accentColor : '#D99B26';
      ctx.globalAlpha = layer === 'front' ? 0.85 : 0.55;
      ctx.beginPath();
      ctx.ellipse(0, 0, layer === 'front' ? 8 : 5, layer === 'front' ? 3.2 : 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  } else if (weather === 'fireflies') {
    for (let i = 0; i < Math.max(8, Math.round(count * 0.55)); i++) {
      const seed = i * 61.7 + (layer === 'front' ? 19 : 0);
      const x = ((seed * 39 + Math.sin(timeSec * 0.9 + i) * 36) % w + w) % w;
      const y = h * 0.25 + ((seed * 27 + Math.cos(timeSec * 1.1 + i) * 28) % (h * 0.65));
      const pulse = 0.35 + 0.65 * Math.abs(Math.sin(timeSec * 2.6 + i * 1.3));
      const rad = (layer === 'front' ? 7 : 4.5) * pulse;
      const g = ctx.createRadialGradient(x, y, 0.5, x, y, rad * 2.4);
      g.addColorStop(0, `rgba(255, 244, 178, ${(0.95 * pulse).toFixed(2)})`);
      g.addColorStop(1, 'rgba(245, 198, 66, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (weather === 'snow') {
    ctx.fillStyle = layer === 'front' ? 'rgba(255, 253, 248, 0.82)' : 'rgba(232, 240, 252, 0.45)';
    for (let i = 0; i < count; i++) {
      const seed = i * 83.7 + (layer === 'front' ? 11 : 0);
      const x = ((seed * 47 + Math.sin(timeSec * 1.4 + i) * 22 + timeSec * wind * 40) % w + w) % w;
      const y = (seed * 29 + timeSec * (layer === 'front' ? 95 : 58)) % h;
      ctx.beginPath();
      ctx.arc(x, y, layer === 'front' ? 3.2 : 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export interface Render25DFrameOptions {
  actorSource: HTMLCanvasElement | ImageBitmap;
  /** Optional V4 multi-actor (2..6 cast) source images keyed by actor.id */
  extraActorSources?: Map<string, HTMLCanvasElement | ImageBitmap>;
  /** Optional V4 360° 2.5D multi-angle caches keyed by actor.id */
  actorMasterCaches?: Map<string, MasterRigRuntimeCache>;
  decomposedPartBitmaps?: Map<string, ImageBitmap>;
  customBgSource?: ImageBitmap | null;
  bgPlaneBitmaps?: Map<string, ImageBitmap>;
  liveOverride?: LivePerformanceOverride | null;
  showDirectorGizmos?: boolean;
  showLetterbox?: boolean;
  /** Override active cinemaLook (e.g. 'natural' for Before/After comparison) */
  cinemaLookOverride?: CinemaLookId;
  /** Localized canvas label for the gaze target crosshair */
  gazeLabel?: string;
}

/** Returns backward-compatible normalized cast list (1..6 actors, lead actor always index 0). */
export function getGraphActors(graph: FilmProjectGraph): FilmActor[] {
  if (graph.actors && graph.actors.length > 0) {
    const rest = graph.actors.filter((a) => a.id !== graph.actor.id).slice(0, 5);
    return [graph.actor, ...rest];
  }
  return [graph.actor];
}

/** Pure back-to-front painter's depth sorter by normalized groundY (distant actors render first!). */
export function sortActorsByGroundDepth<T extends { groundY: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.groundY - b.groundY);
}

/** Maps any V4 26-action UniversalActionId cleanly to the closest FilmActionId locomotion curve. */
export function mapUniversalActionToLegacyFilmAction(ua: string): FilmActionId {
  switch (ua) {
    case 'sprint':
    case 'gallop':
    case 'roll-drive':
      return 'run';
    case 'pounce-leap':
    case 'startle-jump':
    case 'laugh-joy':
      return 'jump-joy';
    case 'wave-greet':
    case 'hand-over-prop':
      return 'wave';
    case 'sit-rest':
    case 'pickup-prop':
    case 'sleep-breathe':
    case 'fall-comedic':
      return 'kneel-pickup';
    case 'roar-angry':
      return 'surprise';
    case 'talk-expressive':
    case 'listen-nod':
      return 'talk-hero';
    case 'sneak-tiptoe':
    case 'cry-sad':
      return 'walk-tired';
    case 'idle-breathe':
    case 'turn-around-360':
      return 'idle-breathe';
    default:
      return 'walk-hero';
  }
}

/** Converts a live Cloudflare Llama 3.3 70B / BYOK directed screenplay into a multi-actor FilmProjectGraph! */
export function applyDirectedScreenplayToFilmGraph(
  screenplay: { title: string; shots: DirectedShotPlan[] },
  baseGraph: FilmProjectGraph
): FilmProjectGraph {
  const cast = getGraphActors(baseGraph);
  const lead = cast[0];
  const firstScene = screenplay.shots[0]?.scene || 'meadow';
  const mappedSet: WorldSetId =
    firstScene === 'night-city' || firstScene === 'space'
      ? 'rainy-alley'
      : firstScene === 'forest'
        ? 'moonlit-forest'
        : 'golden-hill';
  const mappedWeather: WeatherKind =
    mappedSet === 'rainy-alley' ? 'rain' : mappedSet === 'moonlit-forest' ? 'fireflies' : 'wind-leaves';

  const shots: FilmShot[] = screenplay.shots.slice(0, 8).map((s, idx) => {
    const leadTrack = s.actorTracks[lead.id] ?? Object.values(s.actorTracks)[0];
    const leadUa = (leadTrack?.action || 'walk-natural') as UniversalActionId;
    const leadAction = mapUniversalActionToLegacyFilmAction(leadUa);
    const emoMap = (e: string | undefined): FilmEmotionId => {
      if (e === 'happy' || e === 'excited') return 'happy';
      if (e === 'surprised') return 'surprised';
      if (e === 'angry') return 'angry';
      if (e === 'sad' || e === 'tired') return 'tired';
      return 'neutral';
    };
    const framing: ShotFraming =
      s.camera === 'closeup' || s.camera === 'medium' || s.camera === 'low-angle' ? s.camera : 'wide';

    const actorTracks: Record<string, ShotActorTrack> = {};
    for (let ai = 0; ai < cast.length; ai++) {
      const act = cast[ai];
      const tr = s.actorTracks[act.id];
      const sx = tr ? tr.startX : Math.min(0.84, 0.24 + ai * 0.16);
      const ex = tr ? tr.endX : Math.min(0.88, sx + (ai % 2 === 0 ? 0.12 : -0.08));
      const gy = tr ? tr.groundY : Math.min(0.88, 0.78 + (ai % 3) * 0.03);
      const ua = (tr?.action || UNIVERSAL_CREATURE_CATALOG[act.creatureClass ?? 'humanoid'].defaultAction) as UniversalActionId;
      actorTracks[act.id] = {
        actorId: act.id,
        action: mapUniversalActionToLegacyFilmAction(ua),
        universalAction: ua,
        emotion: emoMap(tr?.emotion),
        motionPath: [
          { x: sx, y: gy },
          { x: ex, y: gy },
        ],
        viewYawDeg: tr?.viewYawDeg ?? 0,
        lookAtActorId: tr?.lookAtActorId ?? null,
        dialogue: tr?.dialogue || '',
      };
    }

    const leadEntry = actorTracks[lead.id];
    const spoken =
      leadEntry?.dialogue ||
      Object.values(actorTracks).find((tr) => tr.dialogue)?.dialogue ||
      s.narration ||
      '';

    return {
      id: makeId('shot'),
      title: s.title || `Plan ${idx + 1}`,
      durationSec: Math.max(1.8, Math.min(7.5, s.durationSec || 3.2)),
      framing,
      timingMode: 'hybrid-12-24',
      action: leadAction,
      universalAction: leadUa,
      emotion: leadEntry?.emotion ?? 'neutral',
      prop: 'none',
      headAngleX: Math.max(-35, Math.min(35, Math.round((leadEntry?.viewYawDeg ?? 0) * 0.35))),
      viewYawDeg: leadEntry?.viewYawDeg ?? 0,
      motionPath: leadEntry?.motionPath ?? [
        { x: 0.28, y: 0.8 },
        { x: 0.62, y: 0.8 },
      ],
      lookAt: null,
      dialogue: spoken,
      actorTracks,
      lightningAtSec: null,
      camera: {
        fromX: framing === 'closeup' ? 0.02 : -0.06,
        fromY: 0,
        fromZoom: framing === 'closeup' ? 1.55 : framing === 'medium' ? 1.24 : 1.0,
        toX: framing === 'closeup' ? 0.04 : 0.06,
        toY: 0,
        toZoom: framing === 'closeup' ? 1.68 : framing === 'medium' ? 1.32 : 1.08,
        tiltDeg: framing === 'low-angle' ? -4 : 0,
        dofStrength: framing === 'closeup' ? 0.45 : 0.18,
        handheld: 0.22,
      },
      transition: s.transition === 'dissolve' ? 'dissolve' : 'cut',
    };
  });

  return {
    ...baseGraph,
    actor: lead,
    actors: cast,
    world: {
      ...baseGraph.world,
      setId: baseGraph.world.customBgBlobKey ? baseGraph.world.setId : mappedSet,
      weather: baseGraph.world.customBgBlobKey ? baseGraph.world.weather : mappedWeather,
    },
    shots: shots.length > 0 ? shots : baseGraph.shots,
  };
}

export interface Render25DFrameTelemetry {
  pose: CharacterPose25D;
  lightningFlash: number;
  speaking: boolean;
}

export interface FilmCameraState {
  camX: number;
  camY: number;
  camZoom: number;
  tiltRad: number;
  dofStrength: number;
}

/**
 * Evaluates smart hero-tracking cinema camera state for any shot & timestamp.
 * In closeup/medium/low-angle framing, tracks the character's actual X & headY
 * smoothly while clamping pan bounds so multi-plane edges never expose blank void!
 */
export function computeFilmCameraState(
  graph: FilmProjectGraph,
  shot: FilmShot,
  pose: CharacterPose25D,
  localSec: number
): FilmCameraState {
  const dur = Math.max(0.5, shot.durationSec);
  const t = Math.max(0, Math.min(1, localSec / dur));
  const camT = easeInOutCubic(t);

  const breathX = Math.sin(localSec * 1.7) * 0.004 * shot.camera.handheld;
  const breathY = Math.cos(localSec * 1.3) * 0.004 * shot.camera.handheld;
  const baseCamX = shot.camera.fromX + (shot.camera.toX - shot.camera.fromX) * camT;
  const baseCamY = shot.camera.fromY + (shot.camera.toY - shot.camera.fromY) * camT;
  const camZoom = Math.max(0.85, Math.min(2.6, shot.camera.fromZoom + (shot.camera.toZoom - shot.camera.fromZoom) * camT));
  const tiltRad = (shot.camera.tiltDeg * Math.PI) / 180;

  // Smart character framing so closeup/medium shots NEVER crop a moving hero off-screen!
  const actorScale = Math.max(0.65, Math.min(1.5, graph.actor.scale ?? 1));
  const actorNormH = 0.44 * pose.depthScale * actorScale;
  const headCenterY = pose.groundY - actorNormH * 0.68 - pose.verticalLiftNorm * 0.24;

  const isCloseup = shot.framing === 'closeup' || camZoom >= 1.52;
  const isMedium = shot.framing === 'medium' || (camZoom >= 1.2 && !isCloseup);
  const followWeight = isCloseup ? 0.88 : isMedium ? 0.56 : shot.framing === 'low-angle' ? 0.44 : 0.14;

  // Desired actor-plane camera shift to place character near horizontal center & rule-of-thirds head height
  const targetCamX = pose.groundX - 0.5;
  const desiredHeadScreenY = isCloseup ? 0.45 : isMedium ? 0.42 : 0.44;
  const targetCamY = (headCenterY - desiredHeadScreenY) / 0.45;

  const rawCamX = baseCamX * (1 - followWeight) + targetCamX * followWeight + breathX;
  const rawCamY = baseCamY * (1 - followWeight * 0.78) + targetCamY * (followWeight * 0.78) + breathY;

  // Safe parallax clamp prevents background bleed at high zoom/pan
  const maxPanX = Math.min(0.42, Math.max(0.14, (camZoom - 1) / (2 * camZoom) + 0.14));
  const maxPanY = Math.min(0.45, Math.max(0.16, (camZoom - 1) / (2 * camZoom) + 0.2));

  return {
    camX: Math.max(-maxPanX, Math.min(maxPanX, rawCamX)),
    camY: Math.max(-maxPanY, Math.min(maxPanY, rawCamY)),
    camZoom,
    tiltRad,
    dofStrength: Math.max(0, Math.min(1, shot.camera.dofStrength ?? 0)),
  };
}

const ACTOR_PARALLAX_FACTOR = 0.96;

/** Projects a normalized actor-ground-plane world point (0..1, 0..1) into exact screen pixels. */
export function projectWorldToScreen(
  wx: number,
  wy: number,
  cam: FilmCameraState,
  width: number,
  height: number
): { x: number; y: number } {
  const pActor = computeParallaxOffset(cam.camX, cam.camY, ACTOR_PARALLAX_FACTOR, width, height);
  const px = wx * width + pActor.ox;
  const py = wy * height + pActor.oy;
  const dx = (px - width / 2) * cam.camZoom;
  const dy = (py - height / 2) * cam.camZoom;
  const cosT = Math.cos(cam.tiltRad);
  const sinT = Math.sin(cam.tiltRad);
  return {
    x: width / 2 + dx * cosT - dy * sinT,
    y: height / 2 + dx * sinT + dy * cosT,
  };
}

/** Exact inverse projection: maps screen pixels (e.g. pointer drag) back to normalized world coords (0..1). */
export function unprojectScreenToWorld(
  sx: number,
  sy: number,
  cam: FilmCameraState,
  width: number,
  height: number
): { x: number; y: number } {
  const pActor = computeParallaxOffset(cam.camX, cam.camY, ACTOR_PARALLAX_FACTOR, width, height);
  const rx = sx - width / 2;
  const ry = sy - height / 2;
  const cosT = Math.cos(-cam.tiltRad);
  const sinT = Math.sin(-cam.tiltRad);
  const invZ = 1 / Math.max(0.05, cam.camZoom);
  const ux = (rx * cosT - ry * sinT) * invZ + width / 2;
  const uy = (rx * sinT + ry * cosT) * invZ + height / 2;
  return {
    x: (ux - pActor.ox) / Math.max(1, width),
    y: (uy - pActor.oy) / Math.max(1, height),
  };
}

/**
 * Applies one of 5 live $0 Canvas2D Cinema Looks + analog paper/film grain directly in-browser.
 * Works identically in live stage preview, Before/After split curtain, and Video/GIF exports!
 */
export function applyCinemaLookPostProcess(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: CinemaLookId,
  grainStrength: number,
  timeSec: number,
  cinemaGrade: boolean
): void {
  ctx.save();

  if (look === 'watercolor') {
    // Warm Studio Ghibli golden highlight bloom & soft paper veil
    ctx.globalCompositeOperation = 'screen';
    const bloom = ctx.createRadialGradient(
      width * 0.52,
      height * 0.28,
      width * 0.04,
      width * 0.52,
      height * 0.34,
      width * 0.65
    );
    bloom.addColorStop(0, 'rgba(255, 232, 185, 0.24)');
    bloom.addColorStop(0.55, 'rgba(255, 214, 152, 0.08)');
    bloom.addColorStop(1, 'rgba(255, 200, 140, 0)');
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(252, 244, 228, 0.16)';
    ctx.fillRect(0, 0, width, height);
  } else if (look === 'cinema-35mm') {
    // Classic teal-shadow / warm-amber 35mm cinema grade + halation glow
    ctx.globalCompositeOperation = 'multiply';
    const coolGrad = ctx.createLinearGradient(0, 0, 0, height);
    coolGrad.addColorStop(0, 'rgba(204, 224, 238, 0.96)');
    coolGrad.addColorStop(0.65, 'rgba(232, 226, 216, 0.98)');
    coolGrad.addColorStop(1, 'rgba(176, 198, 214, 0.90)');
    ctx.fillStyle = coolGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'screen';
    const halation = ctx.createRadialGradient(
      width * 0.56,
      height * 0.3,
      width * 0.03,
      width * 0.56,
      height * 0.34,
      width * 0.55
    );
    halation.addColorStop(0, 'rgba(255, 168, 92, 0.20)');
    halation.addColorStop(0.6, 'rgba(229, 77, 46, 0.07)');
    halation.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = halation;
    ctx.fillRect(0, 0, width, height);
  } else if (look === 'vibrant-anime') {
    // Crisp high-key anime sky bloom & vivid cel contrast
    ctx.globalCompositeOperation = 'screen';
    const skyGlow = ctx.createLinearGradient(0, 0, 0, height * 0.65);
    skyGlow.addColorStop(0, 'rgba(130, 202, 255, 0.20)');
    skyGlow.addColorStop(0.55, 'rgba(255, 228, 178, 0.10)');
    skyGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = skyGlow;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = 'rgba(255, 240, 214, 0.22)';
    ctx.fillRect(0, 0, width, height);
  } else if (look === 'vintage-ink') {
    // Nostalgic warm sepia 16mm projector wash + gentle organic gate flicker
    const flicker = 0.95 + Math.sin(timeSec * 29.7) * 0.03 + Math.cos(timeSec * 13.3) * 0.02;
    ctx.globalCompositeOperation = 'color';
    ctx.fillStyle = 'rgba(178, 146, 108, 0.68)';
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgba(244, 228, 198, ${(0.28 * flicker).toFixed(2)})`;
    ctx.fillRect(0, 0, width, height);
  }

  // Deterministic lightweight film grain / paper specks (zero allocation!)
  const effGrain = Math.max(0, Math.min(1, grainStrength)) * (look === 'vintage-ink' ? 1.35 : look === 'cinema-35mm' ? 1.1 : 0.75);
  if (effGrain > 0.05) {
    ctx.globalCompositeOperation = 'source-over';
    const frameSeed = Math.floor(timeSec * 12) * 19.37;
    const specks = Math.round(45 * effGrain);
    for (let i = 0; i < specks; i++) {
      const h1 = Math.sin(frameSeed + i * 127.1) * 43758.5453;
      const h2 = Math.sin(frameSeed + i * 269.5) * 43758.5453;
      const gx = (h1 - Math.floor(h1)) * width;
      const gy = (h2 - Math.floor(h2)) * height;
      const bright = i % 3 === 0;
      ctx.fillStyle = bright
        ? `rgba(255, 248, 232, ${(0.08 * effGrain).toFixed(3)})`
        : `rgba(18, 14, 12, ${(0.10 * effGrain).toFixed(3)})`;
      ctx.fillRect(gx, gy, bright ? 1.6 : 1.4, bright ? 1.6 : 1.4);
    }
    // Occasional vintage hair/scratch line in vintage-ink look
    if (look === 'vintage-ink' && Math.floor(timeSec * 8) % 5 === 0) {
      const sx = (((Math.sin(frameSeed * 3.1) * 43758.5) % 1) + 1) % 1 * width;
      ctx.strokeStyle = 'rgba(255, 242, 212, 0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx + 2, height);
      ctx.stroke();
    }
  }

  // Cinema Vignette (subtle in natural, richer in 35mm & vintage)
  if (cinemaGrade || look !== 'natural') {
    ctx.globalCompositeOperation = 'source-over';
    const vigAlpha =
      look === 'vintage-ink'
        ? 0.56
        : look === 'cinema-35mm'
          ? 0.48
          : look === 'watercolor'
            ? 0.28
            : 0.36;
    const vig = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.34,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.72
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, `rgba(8, 7, 10, ${vigAlpha.toFixed(2)})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.restore();
}

/** Reusable cached offscreen canvas for 20x faster CPU/GPU-identical 1/4-scale bilinear bokeh (zero ctx.filter!) */
let cachedBokehCanvas: HTMLCanvasElement | null = null;

function applyBilinearBokehPass(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dofStrength: number
): void {
  if (dofStrength <= 0.12 || typeof document === 'undefined') return;
  const srcCanvas = ctx.canvas;
  if (!srcCanvas || srcCanvas.width < 16 || srcCanvas.height < 16) return;

  // Higher dofStrength -> slightly smaller downscale buffer for richer photographic lens blur!
  const downScale = Math.max(0.18, Math.min(0.42, 0.44 - dofStrength * 0.24));
  const bw = Math.max(64, Math.round(width * downScale));
  const bh = Math.max(36, Math.round(height * downScale));

  if (!cachedBokehCanvas) {
    cachedBokehCanvas = document.createElement('canvas');
  }
  if (cachedBokehCanvas.width !== bw || cachedBokehCanvas.height !== bh) {
    cachedBokehCanvas.width = bw;
    cachedBokehCanvas.height = bh;
  }

  const bctx = cachedBokehCanvas.getContext('2d');
  if (!bctx) return;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.clearRect(0, 0, bw, bh);
  bctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, bw, bh);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = Math.min(0.86, 0.35 + dofStrength * 0.55);
  ctx.drawImage(cachedBokehCanvas, 0, 0, bw, bh, 0, 0, srcCanvas.width, srcCanvas.height);
  ctx.restore();
}

/**
 * Renders one complete 6-Layer Disney Multi-Plane 2.5D Film Frame!
 */
export function render25DFilmFrame(
  ctx: CanvasRenderingContext2D,
  graph: FilmProjectGraph,
  shot: FilmShot,
  localSec: number,
  width: number,
  height: number,
  opts: Render25DFrameOptions
): Render25DFrameTelemetry {
  const dur = Math.max(0.5, shot.durationSec);
  const t = Math.max(0, Math.min(1, localSec / dur));

  // Lightning flash envelope
  let lightningFlash = 0;
  if (shot.lightningAtSec !== null && Math.abs(localSec - shot.lightningAtSec) < 0.28) {
    const dt = localSec - shot.lightningAtSec;
    if (dt >= 0) {
      lightningFlash = Math.exp(-dt * 14) + (dt > 0.09 && dt < 0.16 ? 0.55 : 0);
    }
  }
  lightningFlash = Math.min(1, lightningFlash);

  const world = graph.world;
  const dna = graph.actor.styleDna;
  const horizonPx = world.horizonY * height;
  const pose = evaluateCharacterPose25D(shot, localSec, world.horizonY, opts.liveOverride);
  const cam = computeFilmCameraState(graph, shot, pose, localSec);
  const { camX, camY, camZoom, tiltRad, dofStrength } = cam;

  ctx.save();
  // Apply Cinema Camera Zoom & Tilt around frame center
  ctx.translate(width / 2, height / 2);
  ctx.rotate(tiltRad);
  ctx.scale(camZoom, camZoom);
  ctx.translate(-width / 2, -height / 2);

  // =========================================================================
  // LAYERS Z0..Z3 — 2.5D MULTI-PLANE BACKGROUND SET
  // =========================================================================
  const hasSlicedCustomBg =
    world.setId === 'custom' &&
    world.decomposedBg &&
    opts.bgPlaneBitmaps &&
    world.decomposedBg.planes.some((p) => opts.bgPlaneBitmaps!.has(p.blobKey));

  if (hasSlicedCustomBg && world.decomposedBg && opts.bgPlaneBitmaps) {
    // TRUE 6-LAYER DISNEY MULTI-PLANE PARALLAX FROM USER'S DECOMPOSED BACKGROUND!
    for (const pl of world.decomposedBg.planes) {
      if (pl.zLayer === 'z5') continue; // Rendered IN FRONT of actor below!
      const bmp = opts.bgPlaneBitmaps.get(pl.blobKey);
      if (!bmp) continue;
      const pOff = computeParallaxOffset(camX, camY, pl.parallax, width, height);
      ctx.drawImage(bmp, pOff.ox - width * 0.14, pOff.oy - height * 0.05, width * 1.28, height * 1.1);
    }
  } else if (world.setId === 'custom' && opts.customBgSource) {
    // Auto-Sliced 3-Band Parallax over User's Uploaded Background Image!
    const bg = opts.customBgSource;
    const pSky = computeParallaxOffset(camX, camY, 0.12, width, height);
    const pMid = computeParallaxOffset(camX, camY, 0.45, width, height);
    const pFloor = computeParallaxOffset(camX, camY, 0.9, width, height);

    ctx.save();
    ctx.drawImage(bg, pSky.ox - width * 0.1, pSky.oy - height * 0.05, width * 1.2, height * 1.1);
    // Midground band subtle parallax slice
    ctx.beginPath();
    ctx.rect(0, horizonPx * 0.45, width, horizonPx * 0.65);
    ctx.clip();
    ctx.drawImage(bg, pMid.ox - width * 0.12, pMid.oy - height * 0.05, width * 1.24, height * 1.1);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizonPx, width, height - horizonPx);
    ctx.clip();
    ctx.drawImage(bg, pFloor.ox - width * 0.16, pFloor.oy - height * 0.05, width * 1.32, height * 1.1);
    ctx.restore();
  } else if (world.setId === 'rainy-alley') {
    // ---- SET 1: RAINY EVENING ALLEY (Style-DNA harmonized!) ----
    const p0 = computeParallaxOffset(camX, camY, 0.08, width, height);
    const p1 = computeParallaxOffset(camX, camY, 0.25, width, height);
    const p2 = computeParallaxOffset(camX, camY, 0.58, width, height);
    const p3 = computeParallaxOffset(camX, camY, 0.98, width, height);

    // Z0: Deep Indigo/Slate Rain Sky + Cloud Glow
    const sky = ctx.createLinearGradient(0, 0, 0, horizonPx + 40);
    sky.addColorStop(0, lightningFlash > 0.2 ? '#42587A' : '#121826');
    sky.addColorStop(0.55, lightningFlash > 0.2 ? '#617BA1' : '#1E293D');
    sky.addColorStop(1, '#2E3440');
    ctx.fillStyle = sky;
    ctx.fillRect(-width * 0.2, -height * 0.2, width * 1.4, height * 1.4);

    // Subtle moon behind storm clouds
    ctx.fillStyle = `rgba(220, 232, 248, ${(0.24 + lightningFlash * 0.4).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(width * 0.78 + p0.ox, height * 0.18 + p0.oy, 48, 0, Math.PI * 2);
    ctx.fill();

    // Z1: Distant City Skyline Silhouettes (0.25x parallax)
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    ctx.fillStyle = '#171E2E';
    const farBuildings = [
      [-80, 140, 260],
      [70, 110, 320],
      [190, 150, 240],
      [360, 120, 290],
      [510, 160, 220],
      [700, 130, 310],
      [850, 170, 260],
      [1040, 140, 300],
      [1190, 160, 240],
    ];
    for (const [bx, bw, bh] of farBuildings) {
      ctx.fillRect(bx, horizonPx - bh * 0.75, bw, bh);
      // Warm distant apartment windows
      ctx.fillStyle = 'rgba(245, 198, 92, 0.28)';
      for (let wy = 24; wy < bh * 0.55; wy += 28) {
        for (let wx = 18; wx < bw - 22; wx += 26) {
          if (((bx + wx + wy) % 7) > 2) ctx.fillRect(bx + wx, horizonPx - bh * 0.75 + wy, 10, 14);
        }
      }
      ctx.fillStyle = '#171E2E';
    }
    ctx.restore();

    // Z2: Midground Brick Alley Walls + Glowing Vintage Streetlamp (0.58x parallax)
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    ctx.fillStyle = '#202430';
    ctx.strokeStyle = dna.inkColor;
    ctx.lineWidth = dna.lineWeightPx * 0.8;
    // Left & Right framing alley facades
    ctx.fillRect(-140, 40, 340, horizonPx - 20);
    ctx.strokeRect(-140, 40, 340, horizonPx - 20);
    ctx.fillRect(width - 210, 60, 360, horizonPx - 40);
    ctx.strokeRect(width - 210, 60, 360, horizonPx - 40);

    // Warm Cafe Window on left wall
    ctx.fillStyle = 'rgba(245, 184, 72, 0.34)';
    ctx.fillRect(28, horizonPx - 165, 124, 96);
    ctx.strokeRect(28, horizonPx - 165, 124, 96);

    // Vintage Streetlamp in center-right midground with Volumetric Amber Cone!
    const lampX = width * 0.56;
    const lampTopY = horizonPx - 265;
    ctx.strokeStyle = '#15171F';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(lampX, horizonPx + 8);
    ctx.lineTo(lampX, lampTopY);
    ctx.quadraticCurveTo(lampX, lampTopY - 26, lampX - 34, lampTopY - 14);
    ctx.stroke();

    const cone = ctx.createRadialGradient(
      lampX - 34,
      lampTopY - 6,
      10,
      lampX - 34,
      horizonPx + 45,
      290
    );
    cone.addColorStop(0, 'rgba(255, 226, 136, 0.72)');
    cone.addColorStop(0.32, 'rgba(245, 178, 62, 0.24)');
    cone.addColorStop(1, 'rgba(245, 178, 62, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(lampX - 48, lampTopY - 10);
    ctx.lineTo(lampX - 20, lampTopY - 10);
    ctx.lineTo(lampX + 140, horizonPx + 180);
    ctx.lineTo(lampX - 210, horizonPx + 180);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#FFF7D6';
    ctx.beginPath();
    ctx.arc(lampX - 34, lampTopY - 8, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Z3: Wet Perspective Cobblestone / Asphalt Ground Plane + Puddle Glow (1.0x)
    ctx.save();
    ctx.translate(p3.ox, p3.oy);
    const floorGrad = ctx.createLinearGradient(0, horizonPx, 0, height);
    floorGrad.addColorStop(0, '#1D2230');
    floorGrad.addColorStop(0.45, '#171B26');
    floorGrad.addColorStop(1, '#10131C');
    ctx.fillStyle = floorGrad;
    ctx.fillRect(-width * 0.25, horizonPx, width * 1.5, height - horizonPx + height * 0.2);

    // Subtle perspective road convergence lines
    ctx.strokeStyle = 'rgba(218, 228, 245, 0.08)';
    ctx.lineWidth = 2;
    for (const spread of [-0.9, -0.35, 0.35, 0.9]) {
      ctx.beginPath();
      ctx.moveTo(width * 0.5, horizonPx);
      ctx.lineTo(width * (0.5 + spread), height);
      ctx.stroke();
    }

    // Golden streetlamp puddle reflection on wet asphalt
    const pud = ctx.createRadialGradient(width * 0.53, horizonPx + 95, 8, width * 0.53, horizonPx + 95, 155);
    pud.addColorStop(0, 'rgba(245, 190, 78, 0.26)');
    pud.addColorStop(1, 'rgba(245, 190, 78, 0)');
    ctx.fillStyle = pud;
    ctx.beginPath();
    ctx.ellipse(width * 0.53, horizonPx + 95, 165, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (world.setId === 'golden-hill') {
    // ---- SET 2: GHIBLI GOLDEN SUNSET HILL (Style-DNA harmonized!) ----
    const p0 = computeParallaxOffset(camX, camY, 0.08, width, height);
    const p1 = computeParallaxOffset(camX, camY, 0.24, width, height);
    const p2 = computeParallaxOffset(camX, camY, 0.56, width, height);
    const p3 = computeParallaxOffset(camX, camY, 0.96, width, height);

    // Z0: Warm Sunset Watercolor Sky + Sun Halo + Drifting Clouds
    const sky = ctx.createLinearGradient(0, 0, 0, horizonPx + 50);
    sky.addColorStop(0, '#E9D9BE');
    sky.addColorStop(0.5, '#F5E7CE');
    sky.addColorStop(1, '#F2C99A');
    ctx.fillStyle = sky;
    ctx.fillRect(-width * 0.2, -height * 0.2, width * 1.4, height * 1.4);

    const sunX = width * 0.76 + p0.ox;
    const sunY = height * 0.24 + p0.oy;
    const sunGlow = ctx.createRadialGradient(sunX, sunY, 20, sunX, sunY, 240);
    sunGlow.addColorStop(0, 'rgba(255, 240, 185, 0.9)');
    sunGlow.addColorStop(0.4, 'rgba(235, 166, 62, 0.36)');
    sunGlow.addColorStop(1, 'rgba(229, 98, 46, 0)');
    ctx.fillStyle = sunGlow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 240, 0, Math.PI * 2);
    ctx.fill();

    // Drifting painterly clouds
    ctx.fillStyle = 'rgba(255, 252, 245, 0.78)';
    const drift = (localSec * 12) % (width + 260);
    for (const [cx0, cy0, sc] of [
      [140, 120, 1.1],
      [540, 95, 0.85],
      [920, 155, 0.95],
    ]) {
      const x = ((cx0 + drift) % (width + 220)) - 110 + p0.ox;
      ctx.beginPath();
      ctx.arc(x, cy0 + p0.oy, 30 * sc, 0, Math.PI * 2);
      ctx.arc(x + 34 * sc, cy0 - 10 * sc + p0.oy, 38 * sc, 0, Math.PI * 2);
      ctx.arc(x + 70 * sc, cy0 + 2 * sc + p0.oy, 26 * sc, 0, Math.PI * 2);
      ctx.fill();
    }

    // Z1: Distant Misty Amber Mountain Range (0.24x)
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    ctx.fillStyle = '#C9A882';
    ctx.beginPath();
    ctx.moveTo(-180, horizonPx + 80);
    ctx.quadraticCurveTo(width * 0.2, horizonPx - 140, width * 0.48, horizonPx - 30);
    ctx.quadraticCurveTo(width * 0.78, horizonPx - 165, width + 180, horizonPx - 10);
    ctx.lineTo(width + 180, height);
    ctx.lineTo(-180, height);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Z2: Midground Warm Rolling Hill + Wind-Bent Lone Tree (0.56x)
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    ctx.fillStyle = '#A6835A';
    ctx.beginPath();
    ctx.moveTo(-200, horizonPx + 50);
    ctx.quadraticCurveTo(width * 0.35, horizonPx - 65, width * 0.72, horizonPx + 18);
    ctx.quadraticCurveTo(width * 0.95, horizonPx - 25, width + 200, horizonPx + 35);
    ctx.lineTo(width + 200, height);
    ctx.lineTo(-200, height);
    ctx.closePath();
    ctx.fill();

    // Swaying Ghibli hill tree on right ridge
    const sway = Math.sin(localSec * 2.4) * 7 * world.windStrength;
    ctx.strokeStyle = dna.inkColor;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(width * 0.82, horizonPx + 6);
    ctx.quadraticCurveTo(width * 0.81, horizonPx - 58, width * 0.82 + sway, horizonPx - 104);
    ctx.stroke();
    ctx.fillStyle = world.harmonizeToStyleDna ? dna.accentColor : '#C95A2E';
    ctx.globalAlpha = 0.86;
    ctx.beginPath();
    ctx.ellipse(width * 0.82 + sway, horizonPx - 118, 52, 34, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();

    // Z3: Foreground Grassy Walking Crest (1.0x)
    ctx.save();
    ctx.translate(p3.ox, p3.oy);
    const grass = ctx.createLinearGradient(0, horizonPx, 0, height);
    grass.addColorStop(0, '#8A7349');
    grass.addColorStop(1, '#59482E');
    ctx.fillStyle = grass;
    ctx.beginPath();
    ctx.moveTo(-220, horizonPx + 30);
    ctx.quadraticCurveTo(width * 0.32, horizonPx - 22, width * 0.68, horizonPx + 24);
    ctx.quadraticCurveTo(width * 0.92, horizonPx + 42, width + 220, horizonPx + 12);
    ctx.lineTo(width + 220, height + 120);
    ctx.lineTo(-220, height + 120);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = dna.inkColor;
    ctx.lineWidth = dna.lineWeightPx * 0.9;
    ctx.stroke();
    ctx.restore();
  } else {
    // ---- SET 3: MOONLIT MAGICAL FOREST ----
    const p0 = computeParallaxOffset(camX, camY, 0.08, width, height);
    const p1 = computeParallaxOffset(camX, camY, 0.25, width, height);
    const p2 = computeParallaxOffset(camX, camY, 0.56, width, height);
    const p3 = computeParallaxOffset(camX, camY, 0.96, width, height);

    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#0D1729');
    sky.addColorStop(0.55, '#182C46');
    sky.addColorStop(1, '#12212E');
    ctx.fillStyle = sky;
    ctx.fillRect(-width * 0.2, -height * 0.2, width * 1.4, height * 1.4);

    // Glowing Full Moon + Volumetric Light Shafts
    const mx = width * 0.3 + p0.ox;
    const my = height * 0.2 + p0.oy;
    const mGlow = ctx.createRadialGradient(mx, my, 18, mx, my, 210);
    mGlow.addColorStop(0, 'rgba(225, 242, 255, 0.88)');
    mGlow.addColorStop(0.4, 'rgba(130, 185, 235, 0.22)');
    mGlow.addColorStop(1, 'rgba(130, 185, 235, 0)');
    ctx.fillStyle = mGlow;
    ctx.beginPath();
    ctx.arc(mx, my, 210, 0, Math.PI * 2);
    ctx.fill();

    // Z1: Distant Misty Pines (0.25x)
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    ctx.fillStyle = '#142436';
    for (let i = -2; i < 14; i++) {
      const tx = i * 115;
      const th = 190 + ((i * 53) % 90);
      ctx.beginPath();
      ctx.moveTo(tx, horizonPx + 20);
      ctx.lineTo(tx + 44, horizonPx - th);
      ctx.lineTo(tx + 88, horizonPx + 20);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Z2: Midground Ancient Tree Trunks + Mist Ribbon (0.56x)
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    ctx.fillStyle = '#0F1B26';
    for (const tx of [90, 290, 860, 1090]) {
      ctx.fillRect(tx, -20, 46, horizonPx + 60);
    }
    const mist = ctx.createLinearGradient(0, horizonPx - 65, 0, horizonPx + 45);
    mist.addColorStop(0, 'rgba(164, 210, 240, 0)');
    mist.addColorStop(0.5, 'rgba(164, 210, 240, 0.16)');
    mist.addColorStop(1, 'rgba(164, 210, 240, 0)');
    ctx.fillStyle = mist;
    ctx.fillRect(-200, horizonPx - 65, width + 400, 110);
    ctx.restore();

    // Z3: Mossy Forest Path Floor (1.0x)
    ctx.save();
    ctx.translate(p3.ox, p3.oy);
    const floor = ctx.createLinearGradient(0, horizonPx, 0, height);
    floor.addColorStop(0, '#162730');
    floor.addColorStop(1, '#0C161C');
    ctx.fillStyle = floor;
    ctx.fillRect(-220, horizonPx, width + 440, height - horizonPx + 120);
    ctx.restore();
  }

  // Fast 1/4-scale bilinear Depth-of-Field Bokeh on background ONLY — Actor & weather stay razor sharp!
  // Zero ctx.filter -> 20x faster on GPU-free CPU & 100% identical across Safari/Firefox/Chrome!
  applyBilinearBokehPass(ctx, width, height, dofStrength);

  // Mid-Depth Weather Particles (BEHIND Actor!)
  drawWeatherParticles(ctx, width, height, world.weather, world.weatherIntensity, world.windStrength, localSec, 'mid', dna.accentColor);

  // =========================================================================
  // LAYER Z4 — FORM-PRESERVED 1..6 MULTI-ACTOR 2.5D CAST + Z-SORT + REFLECTIONS
  // =========================================================================
  const pActor = computeParallaxOffset(camX, camY, ACTOR_PARALLAX_FACTOR, width, height);
  ctx.save();
  ctx.translate(pActor.ox, pActor.oy);

  const castList = getGraphActors(graph);
  const drawSingleCastEntry = (
    act: FilmActor,
    actSource: HTMLCanvasElement | ImageBitmap,
    actShot: FilmShot,
    actPose: CharacterPose25D,
    actYawDeg?: number,
    actUa?: UniversalActionId
  ) => {
    const rendered = render25DActorLayer(
      ctx,
      actSource,
      act.sourceW,
      act.sourceH,
      act,
      world,
      actShot,
      actPose,
      width,
      height,
      localSec,
      lightningFlash,
      act.id === graph.actor.id ? opts.decomposedPartBitmaps : undefined,
      opts.actorMasterCaches?.get(act.id) ?? null,
      actYawDeg,
      actUa
    );
    if (world.setId === 'rainy-alley') {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.translate(rendered.footX, rendered.footY + 6);
      ctx.scale(1, -0.58);
      ctx.drawImage(
        rendered.actorCanvas,
        -rendered.actorCanvas.width / 2,
        -rendered.actorCanvas.height * 0.78
      );
      ctx.restore();
    }
  };

  if (castList.length <= 1) {
    drawSingleCastEntry(graph.actor, opts.actorSource, shot, pose, shot.viewYawDeg, shot.universalAction);
  } else {
    // Evaluate all 2..6 cast poses first so actor-to-actor gaze (lookAtActorId) resolves accurately!
    const prelim = castList.map((act, idx) => {
      const isLead = act.id === graph.actor.id;
      const tr = shot.actorTracks?.[act.id];
      const fallbackX = Math.min(0.86, 0.24 + idx * 0.17);
      const fallbackY = Math.min(0.88, 0.77 + (idx % 3) * 0.035);
      const actShot: FilmShot = isLead
        ? shot
        : {
            ...shot,
            action: tr?.action ?? 'idle-breathe',
            universalAction: tr?.universalAction,
            emotion: tr?.emotion ?? 'neutral',
            prop: tr?.prop ?? 'none',
            dialogue: tr?.dialogue ?? '',
            voiceTrack: null,
            mocapTrack: null,
            motionPath:
              tr?.motionPath && tr.motionPath.length > 0
                ? tr.motionPath
                : [
                    { x: fallbackX, y: fallbackY },
                    { x: fallbackX, y: fallbackY },
                  ],
            viewYawDeg: tr?.viewYawDeg ?? (idx % 2 === 1 ? -45 : 45),
          };
      const actPose = isLead ? pose : evaluateCharacterPose25D(actShot, localSec, world.horizonY);
      return {
        act,
        actShot,
        actPose,
        tr,
        groundY: actPose.groundY,
      };
    });

    // Apply dynamic actor-to-actor lookAtActorId gaze & facing!
    const byId = new Map(prelim.map((e) => [e.act.id, e]));
    for (const entry of prelim) {
      const targetId = entry.tr?.lookAtActorId;
      if (targetId && byId.has(targetId)) {
        const tgt = byId.get(targetId)!;
        const dx = tgt.actPose.groundX - entry.actPose.groundX;
        entry.actPose = {
          ...entry.actPose,
          facing: dx < -0.02 ? -1 : dx > 0.02 ? 1 : entry.actPose.facing,
          eyeLeadX: Math.max(-1, Math.min(1, dx * 3.5)),
        };
      }
    }

    // Back-to-front painter's depth sort by groundY so foreground actors cleanly occlude background actors!
    const sortedCast = sortActorsByGroundDepth(prelim);
    for (const entry of sortedCast) {
      const src =
        entry.act.id === graph.actor.id
          ? opts.actorSource
          : opts.extraActorSources?.get(entry.act.id) ?? opts.actorSource;
      drawSingleCastEntry(
        entry.act,
        src,
        entry.actShot,
        entry.actPose,
        entry.tr?.viewYawDeg ?? entry.actShot.viewYawDeg,
        entry.tr?.universalAction ?? entry.actShot.universalAction
      );
    }
  }
  ctx.restore();

  // =========================================================================
  // LAYER Z5 — FOREGROUND OCCLUDERS (1.38x PARALLAX — Actor walks BEHIND!)
  // =========================================================================
  const p5 = computeParallaxOffset(camX, camY, 1.38, width, height);
  ctx.save();
  ctx.translate(p5.ox, p5.oy);
  if (hasSlicedCustomBg && world.decomposedBg && opts.bgPlaneBitmaps) {
    const z5Plane = world.decomposedBg.planes.find((p) => p.zLayer === 'z5');
    const z5Bmp = z5Plane ? opts.bgPlaneBitmaps.get(z5Plane.blobKey) : null;
    if (z5Bmp) {
      ctx.drawImage(z5Bmp, -width * 0.16, -height * 0.05, width * 1.32, height * 1.1);
    }
  } else if (world.setId === 'rainy-alley') {
    // Dark framing foreground iron street corner pillar on far-left edge
    ctx.fillStyle = 'rgba(10, 12, 18, 0.88)';
    ctx.fillRect(-36, -40, 62, height + 80);
    ctx.fillRect(width - 28, height - 130, 68, 170);
  } else if (world.setId === 'golden-hill') {
    // Swaying silhouetted foreground hill grass blades
    const sway = Math.sin(localSec * 3.1) * 14 * world.windStrength;
    ctx.strokeStyle = 'rgba(34, 24, 16, 0.78)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const gx = 30 + i * 240;
      ctx.beginPath();
      ctx.moveTo(gx, height + 20);
      ctx.quadraticCurveTo(gx + sway * 0.5, height - 48, gx + sway, height - 86 - (i % 2) * 26);
      ctx.stroke();
    }
  } else if (world.setId === 'moonlit-forest') {
    // Framing silhouetted pine branches top-left & bottom-right
    ctx.fillStyle = 'rgba(7, 13, 19, 0.88)';
    ctx.beginPath();
    ctx.moveTo(-40, -20);
    ctx.quadraticCurveTo(160, 75, 290, -20);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(width + 40, height + 20);
    ctx.quadraticCurveTo(width - 170, height - 120, width - 260, height + 20);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Front-Depth Weather Particles (IN FRONT OF Actor!)
  drawWeatherParticles(ctx, width, height, world.weather, world.weatherIntensity, world.windStrength, localSec, 'front', dna.accentColor);

  // Lightning Atmospheric Flash Overlay
  if (lightningFlash > 0.02) {
    ctx.fillStyle = `rgba(220, 238, 255, ${(lightningFlash * 0.34).toFixed(2)})`;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.restore(); // End Camera Zoom/Tilt

  // =========================================================================
  // LIVE $0 CINEMA LOOK + GRAIN + VIGNETTE + LETTERBOX + SUBTITLES + GIZMOS
  // =========================================================================
  const activeLook: CinemaLookId = opts.cinemaLookOverride ?? world.cinemaLook ?? 'natural';
  const activeGrain = world.grainStrength ?? 0.35;
  applyCinemaLookPostProcess(ctx, width, height, activeLook, activeGrain, localSec, world.cinemaGrade);

  const showLetterboxBars =
    opts.showLetterbox !== false && (world.letterbox ?? world.cinemaGrade);
  if (showLetterboxBars) {
    ctx.save();
    const barH = Math.round(height * 0.055);
    ctx.fillStyle = '#09090B';
    ctx.fillRect(0, 0, width, barH);
    ctx.fillRect(0, height - barH, width, barH);
    ctx.restore();
  }

  // Cinema Subtitles when dialogue is active; speaking telemetry also includes real recorded voice!
  const hasSubtitle = shot.dialogue.trim().length > 0 && t > 0.1 && t < 0.94;
  const speaking = hasSubtitle || pose.mouthOpen > 0.14;
  if (hasSubtitle) {
    ctx.save();
    const fontSize = Math.max(16, Math.round(height * 0.036));
    ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(shot.dialogue).width;
    const subY = height - Math.round(height * 0.105);
    ctx.fillStyle = 'rgba(12, 11, 10, 0.76)';
    ctx.beginPath();
    ctx.roundRect(width / 2 - textW / 2 - 20, subY - fontSize * 0.75, textW + 40, fontSize * 1.5, 10);
    ctx.fill();
    ctx.fillStyle = '#FAF6EE';
    ctx.fillText(shot.dialogue, width / 2, subY);
    ctx.restore();
  }

  // Interactive On-Canvas Director Gizmos (Projected through exact camera matrix — pixel-aligned at every zoom/tilt!)
  if (opts.showDirectorGizmos) {
    ctx.save();
    // Horizon guide projected through camera
    const hLeft = projectWorldToScreen(0, world.horizonY, cam, width, height);
    const hRight = projectWorldToScreen(1, world.horizonY, cam, width, height);
    ctx.strokeStyle = 'rgba(217, 155, 38, 0.36)';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hLeft.x, hLeft.y);
    ctx.lineTo(hRight.x, hRight.y);
    ctx.stroke();

    // Motion Path spline projected onto screen coordinates
    if (shot.motionPath.length > 0) {
      const screenPts = shot.motionPath.map((pt) => projectWorldToScreen(pt.x, pt.y, cam, width, height));
      ctx.strokeStyle = '#E54D2E';
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      screenPts.forEach((sp, idx) => {
        if (idx === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      screenPts.forEach((sp, idx) => {
        ctx.fillStyle = idx === 0 ? '#16A34A' : '#E54D2E';
        ctx.strokeStyle = '#FAF6EE';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }

    // Look-At Magnet Target Crosshair projected onto screen
    if (shot.lookAt) {
      const lp = projectWorldToScreen(shot.lookAt.x, shot.lookAt.y, cam, width, height);
      ctx.strokeStyle = '#F5B436';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(lp.x, lp.y, 13, 0, Math.PI * 2);
      ctx.moveTo(lp.x - 18, lp.y);
      ctx.lineTo(lp.x + 18, lp.y);
      ctx.moveTo(lp.x, lp.y - 18);
      ctx.lineTo(lp.x, lp.y + 18);
      ctx.stroke();
      ctx.fillStyle = 'rgba(16, 15, 13, 0.85)';
      ctx.beginPath();
      ctx.roundRect(lp.x + 14, lp.y - 22, 46, 16, 5);
      ctx.fill();
      ctx.fillStyle = '#F5B436';
      ctx.font = '700 10px "JetBrains Mono", monospace';
      ctx.fillText(opts.gazeLabel ?? 'BAKIŞ', lp.x + 19, lp.y - 11);
    }
    ctx.restore();
  }

  return { pose, lightningFlash, speaking };
}

/**
 * Renders the full timeline at `globalSec` INCLUDING smooth 0.45s cross-dissolve transitions
 * whenever a shot has `transition: 'dissolve'` (both live playback and video/GIF export!).
 */
let dissolveScratchCanvas: HTMLCanvasElement | null = null;

export function render25DFilmFrameAtGlobalTime(
  ctx: CanvasRenderingContext2D,
  graph: FilmProjectGraph,
  globalSec: number,
  width: number,
  height: number,
  opts: Render25DFrameOptions
): Render25DFrameTelemetry & { shotIndex: number; localSec: number; totalDuration: number } {
  const tl = resolveFilmTimeline(graph.shots, globalSec);
  const dissolveDur = 0.45;
  const shouldDissolve =
    tl.shotIndex > 0 &&
    tl.shot.transition === 'dissolve' &&
    tl.localSec < dissolveDur;

  if (!shouldDissolve) {
    const tel = render25DFilmFrame(ctx, graph, tl.shot, tl.localSec, width, height, opts);
    return { ...tel, ...tl };
  }

  const prevShot = graph.shots[tl.shotIndex - 1];
  const prevEndSec = Math.max(0, prevShot.durationSec - 0.04);
  const alpha = Math.max(0, Math.min(1, tl.localSec / dissolveDur));

  // Render outgoing shot directly on main ctx
  render25DFilmFrame(ctx, graph, prevShot, prevEndSec, width, height, {
    ...opts,
    showDirectorGizmos: false,
  });

  // Render incoming shot on reusable scratch canvas and cross-fade cleanly
  if (typeof document !== 'undefined') {
    if (!dissolveScratchCanvas) {
      dissolveScratchCanvas = document.createElement('canvas');
    }
    if (dissolveScratchCanvas.width !== width) dissolveScratchCanvas.width = width;
    if (dissolveScratchCanvas.height !== height) dissolveScratchCanvas.height = height;
    const sctx = dissolveScratchCanvas.getContext('2d');
    if (sctx) {
      sctx.clearRect(0, 0, width, height);
      const tel = render25DFilmFrame(sctx, graph, tl.shot, tl.localSec, width, height, opts);
      ctx.save();
      ctx.globalAlpha = easeInOutCubic(alpha);
      ctx.drawImage(dissolveScratchCanvas, 0, 0);
      ctx.restore();
      return { ...tel, ...tl };
    }
  }

  const tel = render25DFilmFrame(ctx, graph, tl.shot, tl.localSec, width, height, opts);
  return { ...tel, ...tl };
}

/** Computes total movie duration and resolves which shot + local time corresponds to global time */
export function resolveFilmTimeline(
  shots: FilmShot[],
  globalSec: number
): { shotIndex: number; shot: FilmShot; localSec: number; totalDuration: number } {
  const totalDuration = shots.reduce((s, sh) => s + Math.max(0.5, sh.durationSec), 0);
  if (shots.length === 0) {
    throw new Error('No shots in FilmGraph');
  }
  const clamped = Math.max(0, Math.min(totalDuration - 0.001, globalSec));
  let acc = 0;
  for (let i = 0; i < shots.length; i++) {
    const d = Math.max(0.5, shots[i].durationSec);
    if (clamped < acc + d || i === shots.length - 1) {
      return { shotIndex: i, shot: shots[i], localSec: clamped - acc, totalDuration };
    }
    acc += d;
  }
  return { shotIndex: 0, shot: shots[0], localSec: 0, totalDuration };
}
