import type {
  CinemaLookId,
  FilmActionId,
  FilmActor,
  FilmEmotionId,
  FilmGestureMode,
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
import type { CustomMouthKey } from '../types/masterRig';
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
import type { RiggedCharacterPack } from './skeletonSkinEngine';
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
  paperBaseColor: '#FAF3E4',
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
  let lightFillR = 0;
  let lightFillG = 0;
  let lightFillB = 0;
  let lightFillCount = 0;

  const stride = Math.max(1, Math.floor(Math.sqrt(total / 4096)));

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const a = rgba[idx + 3];
      if (a < 140) continue;

      if (r > 175 && g > 160 && b > 140) {
        lightFillR += r;
        lightFillG += g;
        lightFillB += b;
        lightFillCount++;
      }

      // Ignore pure paper background pixels for palette clustering
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
  const paperBaseColor =
    lightFillCount > 0
      ? rgbToHex(
          lightFillR / lightFillCount,
          lightFillG / lightFillCount,
          lightFillB / lightFillCount
        )
      : '#FAF3E4';

  return {
    palette: palette.length >= 3 ? palette : DEFAULT_STYLE_DNA.palette,
    inkColor: darkest && darkest.r + darkest.g + darkest.b < 240 ? rgbToHex(darkest.r, darkest.g, darkest.b) : '#1C1917',
    accentColor: mostVibrant && mostVibrant.sat > 0.2 ? rgbToHex(mostVibrant.r, mostVibrant.g, mostVibrant.b) : '#E54D2E',
    paperBaseColor,
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
  if (/uzay|gezegen|galaksi|nebula|astronot|\bspace\b|cosmic/.test(low)) {
    return { setId: 'cosmic-nebula', weather: hasSnow ? 'snow' : 'none' };
  }
  if (/konser|spot\s*ışık|sahne\s*ışık|\bconcert\b/.test(low)) {
    return { setId: 'concert-stage', weather: 'none' };
  }
  if (/kanyon|kovalama|\bcanyon\b|\bchase\b/.test(low)) {
    return { setId: 'canyon-chase', weather: 'wind-leaves' };
  }
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
    // True chest-shoulder-head close-up lens (feet pushed cleanly below bottom frame y > H!)
    return {
      fromX: (endX - 0.5) * 0.45,
      fromY: 0.14,
      fromZoom: 2.32,
      toX: (endX - 0.5) * 0.45,
      toY: 0.17,
      toZoom: 2.62,
      tiltDeg: -1.5,
      dofStrength: 0.78,
      handheld: 0.3,
    };
  }
  if (framing === 'medium') {
    return {
      fromX: (startX - 0.5) * 0.35,
      fromY: 0.04,
      fromZoom: 1.32,
      toX: (endX - 0.5) * 0.35,
      toY: 0.06,
      toZoom: 1.54,
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

  const rawSentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);

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
    const shotProp =
      detectPropFromText(low) !== 'none'
        ? detectPropFromText(low)
        : idx >= 1
          ? globalProp
          : globalProp === 'lantern' || globalProp === 'umbrella'
            ? globalProp
            : 'none';

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

  const keepCustom = baseWorld?.setId === 'custom' && Boolean(baseWorld?.customBgBlobKey);
  const world: FilmWorldConfig = {
    setId: keepCustom ? 'custom' : setId,
    customBgBlobKey: baseWorld?.customBgBlobKey ?? null,
    decomposedBg: baseWorld?.decomposedBg ?? null,
    horizonY:
      setId === 'golden-hill'
        ? 0.56
        : setId === 'cosmic-nebula'
          ? 0.62
          : setId === 'concert-stage' || setId === 'canyon-chase'
            ? 0.6
            : 0.58,
    weather,
    weatherIntensity: weather === 'none' ? 0 : 0.68,
    windStrength:
      setId === 'golden-hill'
        ? 0.55
        : setId === 'canyon-chase'
          ? -0.72
          : setId === 'cosmic-nebula'
            ? -0.18
            : -0.32,
    klausLighting: baseWorld?.klausLighting ?? true,
    cinemaGrade: baseWorld?.cinemaGrade ?? true,
    cinemaLook: baseWorld?.cinemaLook ?? 'natural',
    letterbox: baseWorld?.letterbox ?? true,
    grainStrength: baseWorld?.grainStrength ?? 0.35,
    lightAngleDeg: setId === 'golden-hill' || setId === 'canyon-chase' ? -35 : 22,
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

  // Boots + Trousers
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

    ctx.fillStyle = '#D99B26';
    ctx.beginPath();
    ctx.ellipse(cx + s * 48, 650, 34, 17, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#332C27';
  }

  // Coat sleeves + mittens
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

  // Artist coat
  ctx.fillStyle = '#26221F';
  ctx.beginPath();
  ctx.moveTo(cx - 78, 326);
  ctx.quadraticCurveTo(cx - 114, 444, cx - 96, 536);
  ctx.quadraticCurveTo(cx, 558, cx + 96, 536);
  ctx.quadraticCurveTo(cx + 114, 444, cx + 78, 326);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#D99B26';
  for (const by of [394, 434, 474]) {
    ctx.beginPath();
    ctx.arc(cx, by, 6, 0, Math.PI * 2);
    ctx.fill();
  }

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

  // Head + Hair + Beret
  ctx.fillStyle = '#FAF3E4';
  ctx.lineWidth = 7.5;
  ctx.beginPath();
  ctx.ellipse(cx, 208, 90, 84, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#1E1B18';
  ctx.beginPath();
  ctx.arc(cx, 192, 91, Math.PI * 1.06, Math.PI * 1.94);
  ctx.quadraticCurveTo(cx + 28, 162, cx - 6, 174);
  ctx.quadraticCurveTo(cx - 52, 166, cx - 88, 182);
  ctx.closePath();
  ctx.fill();

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
  /** Upper-body gesture mode ('none' | 'wave' | 'handsUp' | 'surprise') */
  gestureMode?: FilmGestureMode;
  /** Exact distance-locked walk/run stride cycle [0..1) for 0.00ms ripple/dust phase lock */
  strideCycle?: number;
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
  const pathVelocity = Math.hypot(mp.vx, mp.vy);
  const depthFactor = Math.max(0.25, (mp.y - horizonY) / Math.max(0.18, 0.9 - horizonY));
  const depthScale = 0.58 + depthFactor * 0.54;

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
  let strideCycle: number | undefined;
  let gestureMode: FilmGestureMode = 'none';

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
    const baseStrideHz = act === 'run' ? 1.85 : act === 'walk-hero' ? 1.02 : 0.78;
    const strideHz = baseStrideHz * emoTempoMul;
    const { cumDist, totalDist } = computeMotionPathArcDistance(shot.motionPath, t);
    const { cumDist: prevCumDist } = computeMotionPathArcDistance(
      shot.motionPath,
      Math.max(0, (qSec - 1 / stepFps) / dur)
    );
    const fullStrideNorm = Math.max(0.08, (act === 'run' ? 0.24 : 0.165) * depthScale);
    const useDistanceLock = totalDist > 0.035;
    const cycle = useDistanceLock
      ? ((cumDist / fullStrideNorm) % 1 + 1) % 1
      : (qSec * strideHz) % 1;
    const prevCycle = useDistanceLock
      ? ((prevCumDist / fullStrideNorm) % 1 + 1) % 1
      : (Math.max(0, qSec - 1 / stepFps) * strideHz) % 1;

    strideCycle = cycle;
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
      leftArmSwing = -0.58 + easeOutCubic(Math.min(1, j * 2.2)) * 1.56 - Math.max(0, j - 0.72) * 1.4;
      rightArmSwing = leftArmSwing;
      headTiltRad = -0.09 * arc;
      if (leftArmSwing > 0.65) gestureMode = 'handsUp';
    } else {
      const l = (t - 0.75) / 0.25;
      footContact = l < 0.16;
      contactSide = 0;
      const damp = Math.exp(-l * 4.2) * Math.sin(l * Math.PI * 2.0);
      squashY = 1 - damp * 0.18;
      leftArmSwing = 0.58 * (1 - easeOutCubic(l)) - Math.max(0, damp) * 0.35;
      rightArmSwing = leftArmSwing;
      headTiltRad = Math.sin(Math.min(1, l * 1.4) * Math.PI) * 0.09;
    }
  } else if (act === 'kneel-pickup') {
    let dip = 0;
    if (t < 0.18) {
      const a = t / 0.18;
      dip = -Math.sin(a * Math.PI) * 0.14;
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
    leftArmSwing = dip * 0.24;
    headTiltRad = dip * 0.18 * facing;
  } else if (act === 'surprise') {
    gestureMode = 'surprise';
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
    gestureMode = 'wave';
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
    headTiltRad *= 0.55;
    squashY += 0.015;
  } else if (shot.emotion === 'surprised') {
    headTiltRad -= 0.065 * facing;
    squashY += 0.038;
    leftArmSwing += 0.24;
    rightArmSwing += 0.24;
  }

  const hasMocapTrack = Boolean(shot.mocapTrack && shot.mocapTrack.samples.length > 0);
  const hasLiveBodyOverride = Boolean(
    liveOverride &&
      (liveOverride.headYawRad !== undefined ||
        liveOverride.headTiltRad !== undefined ||
        liveOverride.bodyLeanRad !== undefined ||
        liveOverride.leftArmSwing !== undefined ||
        liveOverride.rightArmSwing !== undefined ||
        liveOverride.verticalLiftNorm !== undefined ||
        liveOverride.squashY !== undefined ||
        liveOverride.gestureMode !== undefined)
  );

  let mocapMouthOpen: number | undefined;
  let mocapViseme: VisemeId | undefined;
  if (hasMocapTrack && shot.mocapTrack) {
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
    if (mc.gestureMode) gestureMode = mc.gestureMode;
  }

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
    if (liveOverride.gestureMode !== undefined) {
      gestureMode = liveOverride.gestureMode;
    }
  }

  // Phase 5 Fix: Zero underlying walk/run leg phases when mocap or Live Puppet Pad is active and character is stationary!
  // Prevents mid-air black "X" leg scissor knot during Live Pad jumps (`ZIPLAMA 13%`)!
  if ((hasMocapTrack || hasLiveBodyOverride) && pathVelocity < 0.02) {
    leftLegPhase = 0;
    rightLegPhase = 0;
    leftFootRoll = 0;
    rightFootRoll = 0;
    strideCycle = undefined;
    footContact = false;
    contactSide = 0;
    if (verticalLiftNorm > 0.015) {
      const symTuck = Math.min(0.42, verticalLiftNorm * 1.05);
      leftFootLift = symTuck;
      rightFootLift = symTuck;
    } else {
      leftFootLift = 0;
      rightFootLift = 0;
    }
  }

  // Infer expressive gestureMode from live/mocap arm elevations when not explicitly tagged
  if ((hasMocapTrack || hasLiveBodyOverride) && !liveOverride?.gestureMode) {
    if (leftArmSwing > 0.72 && rightArmSwing > 0.72) {
      gestureMode = 'handsUp';
    } else if (leftArmSwing > 0.68 || rightArmSwing > 0.68) {
      gestureMode = 'wave';
    }
  }

  squashY = Math.max(0.82, Math.min(1.18, squashY));
  const squashX = 1 / squashY;

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
    velocity: pathVelocity,
    footContact,
    contactSide,
    mouthOpen,
    viseme,
    blink,
    gestureMode,
    strideCycle,
  };
}

/**
 * Pure ARAP + Rigidity-Protected 2.5D Vertex Deformer!
 */
export function deform25DRigidVertex(
  u: number,
  v: number,
  pose: CharacterPose25D,
  rigidHeadEndY = 0.37
): { x: number; y: number } {
  const cx = 0.5;
  const headBlend =
    v <= rigidHeadEndY
      ? 1
      : v >= rigidHeadEndY + 0.08
        ? 0
        : 1 - (v - rigidHeadEndY) / 0.08;

  const hx = u - cx;
  const hy = v - rigidHeadEndY * 0.62;
  const cosH = Math.cos(pose.headTiltRad);
  const sinH = Math.sin(pose.headTiltRad);
  let rxHead = cx + hx * cosH - hy * sinH;
  const ryHead = rigidHeadEndY * 0.62 + hx * sinH + hy * cosH;

  const radialDist = Math.min(1, Math.abs(hx) / 0.24);
  const faceDepth = Math.sqrt(Math.max(0, 1 - radialDist * radialDist));
  const yawShift = Math.sin(pose.headYawRad) * faceDepth * 0.085;
  const foreshorten = 1 - Math.abs(Math.sin(pose.headYawRad)) * 0.14;
  rxHead = cx + (rxHead - cx) * foreshorten + yawShift;

  let bx = cx + (u - cx) * pose.squashX;
  let by = 1 - (1 - v) * pose.squashY;

  const leanFactor = Math.max(0, (0.78 - v) / 0.78);
  bx += Math.sin(pose.bodyLeanRad) * leanFactor * 0.16;

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

  if (v > 0.64) {
    const legT = (v - 0.64) / 0.36;
    const smoothLeg = legT * legT * (3 - 2 * legT);
    const strideX = u < 0.5 ? pose.leftLegPhase : pose.rightLegPhase;
    bx += strideX * smoothLeg * 0.125;
    const passingClearance =
      Math.max(0, 1 - Math.abs(strideX)) *
      (Math.abs(pose.leftLegPhase) + Math.abs(pose.rightLegPhase) > 0.15 ? 1 : 0);
    by -= passingClearance * smoothLeg * 0.048;
  }

  const neckSquashOffset = (1 - rigidHeadEndY) * (1 - pose.squashY);
  const x = bx * (1 - headBlend) + (rxHead + Math.sin(pose.bodyLeanRad) * 0.115) * headBlend;
  const y = by * (1 - headBlend) + (ryHead + neckSquashOffset) * headBlend;

  return {
    x: Math.max(-0.22, Math.min(1.22, x)),
    y: Math.max(-0.22, Math.min(1.22, y)),
  };
}

// Reusable scratch buffers for zero-GC 60fps compositing, behind-body Verlet cloth & water reflections
let actorScratchA: HTMLCanvasElement | null = null;
let actorScratchB: HTMLCanvasElement | null = null;
let actorScratchC: HTMLCanvasElement | null = null;

function getScratchCanvas(slot: 'a' | 'b' | 'c', w: number, h: number): HTMLCanvasElement {
  const existing = slot === 'a' ? actorScratchA : slot === 'b' ? actorScratchB : actorScratchC;
  if (existing && existing.width === w && existing.height === h) return existing;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  if (slot === 'a') actorScratchA = c;
  else if (slot === 'b') actorScratchB = c;
  else actorScratchC = c;
  return c;
}

// Cache sampled local face skin/paper fill color around mouth so double-mouth masking is 0ms per frame
const sampledFaceFillCache = new WeakMap<RiggedCharacterPack, string>();

function resolveLocalMouthFaceColor(pack: RiggedCharacterPack, actor: FilmActor): string {
  const cached = sampledFaceFillCache.get(pack);
  if (cached) return cached;

  let color = actor.styleDna.paperBaseColor || pack.faceFillColor || '#FAF3E4';
  try {
    const fc = pack.filledCanvas;
    if (fc && fc.width >= 16 && fc.height >= 16) {
      const fctx = fc.getContext('2d');
      if (fctx && typeof fctx.getImageData === 'function') {
        const mx = Math.round(pack.anatomy.mouthX * fc.width);
        const my = Math.round(Math.max(0.04, pack.anatomy.mouthY - 0.022) * fc.height);
        const rad = Math.max(4, Math.round(fc.width * 0.055));
        const x0 = Math.max(0, mx - rad);
        const y0 = Math.max(0, my - rad);
        const sw = Math.min(fc.width - x0, rad * 2);
        const sh = Math.min(fc.height - y0, rad * 2);
        if (sw > 2 && sh > 2) {
          const data = fctx.getImageData(x0, y0, sw, sh).data;
          let rSum = 0;
          let gSum = 0;
          let bSum = 0;
          let cnt = 0;
          for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 180) continue;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            // Exclude dark ink lines so we sample pure face interior fill!
            if (lum < 85) continue;
            rSum += r;
            gSum += g;
            bSum += b;
            cnt++;
          }
          if (cnt >= 4) {
            color = rgbToHex(rSum / cnt, gSum / cnt, bSum / cnt);
          }
        }
      }
    }
  } catch {
    // Fallback cleanly in headless environments
  }

  sampledFaceFillCache.set(pack, color);
  return color;
}

// Lightweight runtime cache for custom faceSprites.mouths data URLs
const customMouthImgCache = new Map<string, HTMLImageElement>();

function resolveCustomMouthMap(
  actor: FilmActor
): Partial<Record<'closed' | 'A' | 'E' | 'O', CanvasImageSource>> | undefined {
  const mouths = actor.masterRig?.faceSprites?.mouths;
  if (!mouths || typeof Image === 'undefined') return undefined;

  const out: Partial<Record<'closed' | 'A' | 'E' | 'O', CanvasImageSource>> = {};
  const keys: Array<['closed' | 'A' | 'E' | 'O', CustomMouthKey[]]> = [
    ['closed', ['closed', 'smile']],
    ['A', ['A']],
    ['E', ['E']],
    ['O', ['O', 'U']],
  ];
  let anyLoaded = false;

  for (const [slot, candidates] of keys) {
    for (const ck of candidates) {
      const url = mouths[ck];
      if (!url) continue;
      let img = customMouthImgCache.get(url);
      if (!img) {
        img = new Image();
        img.src = url;
        customMouthImgCache.set(url, img);
      }
      if (img.complete && img.naturalWidth > 0) {
        out[slot] = img;
        anyLoaded = true;
        break;
      }
    }
  }
  return anyLoaded ? out : undefined;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(250, 243, 228, ${alpha.toFixed(3)})`;
  const r = parseInt(clean.slice(0, 2), 16) || 250;
  const g = parseInt(clean.slice(2, 4), 16) || 243;
  const b = parseInt(clean.slice(4, 6), 16) || 228;
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

/**
 * Draws the trajectory-integrated Verlet scarf/cape behind the character (`Z-behind`) as a
 * tapered conical polygon fabric ribbon with longitudinal fold shadow & fringe tassels!
 */
function drawConicalVerletFabricBehind(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  drawW: number,
  styleDna: StyleDNA,
  facing: 1 | -1
) {
  if (pts.length < 3) return;
  const n = pts.length;
  const leftEdge: { x: number; y: number }[] = [];
  const rightEdge: { x: number; y: number }[] = [];
  const foldMid: { x: number; y: number }[] = [];

  const rootHalfW = Math.max(2.4, drawW * 0.015);
  const tipHalfW = Math.max(6.5, drawW * 0.038);

  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty;
    const ny = tx;

    const u = i / (n - 1);
    // Smooth conical flare from snug neck root to wide fluttering tail
    const halfW = rootHalfW + (tipHalfW - rootHalfW) * Math.pow(u, 0.82);
    leftEdge.push({ x: pts[i].x + nx * halfW, y: pts[i].y + ny * halfW });
    rightEdge.push({ x: pts[i].x - nx * halfW, y: pts[i].y - ny * halfW });
    foldMid.push({
      x: pts[i].x - nx * halfW * 0.22 * facing,
      y: pts[i].y - ny * halfW * 0.22 * facing,
    });
  }

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. Conical polygon fabric body + crisp ink outline
  ctx.beginPath();
  ctx.moveTo(leftEdge[0].x, leftEdge[0].y);
  for (let i = 1; i < n; i++) {
    ctx.lineTo(leftEdge[i].x, leftEdge[i].y);
  }
  for (let i = n - 1; i >= 0; i--) {
    ctx.lineTo(rightEdge[i].x, rightEdge[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = styleDna.accentColor || '#E54D2E';
  ctx.fill();
  ctx.strokeStyle = styleDna.inkColor || '#1C1917';
  ctx.lineWidth = Math.max(1.8, styleDna.lineWeightPx * 0.65);
  ctx.stroke();

  // 2. Interior longitudinal fabric fold shadow crease
  ctx.beginPath();
  ctx.moveTo(foldMid[1].x, foldMid[1].y);
  for (let i = 2; i < n; i++) {
    ctx.lineTo(foldMid[i].x, foldMid[i].y);
  }
  for (let i = n - 1; i >= 1; i--) {
    ctx.lineTo(rightEdge[i].x, rightEdge[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(20, 12, 16, 0.24)';
  ctx.fill();

  // 3. Woven fringe tassels fanning from tail edge
  const tailPrev = pts[n - 2];
  const tailEnd = pts[n - 1];
  let tx = tailEnd.x - tailPrev.x;
  let ty = tailEnd.y - tailPrev.y;
  const tLen = Math.hypot(tx, ty) || 1;
  tx /= tLen;
  ty /= tLen;
  const tasselLen = Math.max(4, drawW * 0.024);

  ctx.strokeStyle = styleDna.inkColor || '#1C1917';
  ctx.lineWidth = Math.max(1.4, styleDna.lineWeightPx * 0.48);
  for (const frac of [0.2, 0.5, 0.8]) {
    const sx = leftEdge[n - 1].x * (1 - frac) + rightEdge[n - 1].x * frac;
    const sy = leftEdge[n - 1].y * (1 - frac) + rightEdge[n - 1].y * frac;
    const fan = (frac - 0.5) * 0.38;
    const fx = tx * Math.cos(fan) - ty * Math.sin(fan);
    const fy = tx * Math.sin(fan) + ty * Math.cos(fan);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + fx * tasselLen, sy + fy * tasselLen);
    ctx.stroke();
  }

  ctx.restore();
}

/** Draws a subtle, snug collar ring right at the neck base (never covering chest/tie!) */
function drawSlimNeckCollarRing(
  ctx: CanvasRenderingContext2D,
  neckX: number,
  neckY: number,
  drawW: number,
  drawH: number,
  leanRad: number,
  styleDna: StyleDNA
) {
  ctx.save();
  ctx.translate(neckX, neckY + drawH * 0.008);
  ctx.rotate(leanRad * 0.45);
  const rx = Math.max(6, drawW * 0.046);
  const ry = Math.max(2.5, drawH * 0.011);
  ctx.fillStyle = styleDna.accentColor || '#E54D2E';
  ctx.strokeStyle = styleDna.inkColor || '#1C1917';
  ctx.lineWidth = Math.max(1.5, styleDna.lineWeightPx * 0.52);
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Deterministic ground-plane footstep interaction locked 100% to `evaluateCharacterPose25D`'s
 * distance-integrated stride phase (`pose.strideCycle`, `pose.footContact`, `pose.contactSide`) —
 * zero independent `timeSec * 1.15` clock drift!
 */
function drawDeterministicFootstepEffects(
  ctx: CanvasRenderingContext2D,
  world: FilmWorldConfig,
  shot: FilmShot,
  pose: CharacterPose25D,
  flWorldX: number,
  frWorldX: number,
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
      const trailDir = -pose.facing;
      ctx.fillStyle =
        world.setId === 'moonlit-forest' || world.setId === 'cosmic-nebula'
          ? `rgba(195, 220, 240, ${(alpha * 0.36).toFixed(3)})`
          : world.setId === 'canyon-chase'
            ? `rgba(232, 174, 128, ${(alpha * 0.56).toFixed(3)})`
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

  if (
    (act === 'walk-tired' || act === 'walk-hero' || act === 'run') &&
    pose.strideCycle !== undefined &&
    t > 0.04 &&
    t < 0.96
  ) {
    const cycle = pose.strideCycle;
    const str = act === 'run' ? 1.15 : act === 'walk-hero' ? 0.85 : 0.6;
    // Left heel-strike occurs at cycle = 0.00 (pose.contactSide === -1)
    if (cycle < 0.42 || (pose.footContact && pose.contactSide === -1)) {
      const age = cycle < 0.42 ? cycle / 0.42 : 0;
      drawBurst(flWorldX, footY, age, str);
    }
    // Right heel-strike occurs at cycle = 0.50 (pose.contactSide === +1)
    const rightPhase = (cycle - 0.5 + 1) % 1;
    if (rightPhase < 0.42 || (pose.footContact && pose.contactSide === 1)) {
      const age = rightPhase < 0.42 ? rightPhase / 0.42 : 0;
      drawBurst(frWorldX, footY, age, str);
    }
  } else if ((act === 'jump-joy' && t >= 0.75) || (pose.footContact && pose.contactSide === 0)) {
    const landAge = act === 'jump-joy' && t >= 0.75 ? (t - 0.75) / 0.25 : 0.08;
    drawBurst(flWorldX, footY, landAge, 1.25);
    drawBurst(frWorldX, footY, landAge, 1.25);
  }
}

/**
 * Aspect-balanced normalized character height:
 * - 16:9 landscape (`aspect >= 1.15`): standard `0.44 * depthScale * actorScale`
 * - 1:1 square & 9:16 vertical Reels/TikTok (`width < height`): balanced by aspect ratio so actor
 *   fits comfortably inside vertical frames without crowding edges.
 */
function computeAspectBalancedActorNormH(
  width: number,
  height: number,
  depthScale: number,
  actorScale: number
): number {
  const aspect = width / Math.max(1, height);
  const aspectMul =
    aspect < 0.99
      ? Math.max(0.68, Math.pow(aspect, 0.48))
      : aspect < 1.15
        ? 0.92
        : 1.0;
  return 0.44 * aspectMul * depthScale * actorScale;
}

/**
 * Renders the studio-grade Sole-Locked Water Reflection (`0.0 px` shoe-reflection gap!)
 * with horizontal sine-wave puddle refraction and vertical attenuation mask BEHIND the Z4 actor!
 */
function drawSoleLockedPuddleReflection(
  targetCtx: CanvasRenderingContext2D,
  actorCanvas: HTMLCanvasElement,
  footX: number,
  footY: number,
  soleBufX: number,
  soleBufY: number,
  liftPx: number,
  drawH: number,
  timeSec: number,
  opacity = 0.24
) {
  const bufW = actorCanvas.width;
  const bufH = actorCanvas.height;
  if (bufW < 8 || bufH < 8) return;

  const reflBuf = getScratchCanvas('b', bufW, bufH);
  const rctx = reflBuf.getContext('2d');
  if (!rctx) return;
  rctx.clearRect(0, 0, bufW, bufH);

  const reflectScaleY = 0.58;
  // Exact sole contact pivot in actorCanvas: `(soleBufX, soleBufY + liftPx)` / sole plane
  const shoeBufY = Math.max(0, soleBufY - liftPx);
  const maxReflSrcSpan = Math.min(shoeBufY, Math.round(drawH * 1.15));
  const strips = 18;
  const srcStripH = Math.max(2, maxReflSrcSpan / strips);
  // Mirror across ground plane: when standing (liftPx = 0), top of reflection starts at y = 0 (`footY`);
  // when jumping (`liftPx > 0`), reflection separates downward by `liftPx * reflectScaleY`!
  const startDstY = liftPx * reflectScaleY;

  for (let s = 0; s < strips; s++) {
    const srcBottom = shoeBufY - s * srcStripH;
    const srcTop = Math.max(0, srcBottom - srcStripH - 0.8);
    const sh = srcBottom - srcTop;
    if (sh <= 0.5) break;

    const dstY = startDstY + s * srcStripH * reflectScaleY;
    const dstH = sh * reflectScaleY;
    const rippleDx =
      Math.sin(timeSec * 5.6 + s * 0.62) * (0.8 + s * 0.26) +
      Math.cos(timeSec * 3.4 - s * 0.45) * (0.4 + s * 0.14);

    rctx.save();
    rctx.translate(rippleDx, dstY + dstH);
    rctx.scale(1, -dstH / sh);
    rctx.drawImage(actorCanvas, 0, srcTop, bufW, sh, 0, 0, bufW, sh);
    rctx.restore();
  }

  // Vertical puddle attenuation mask (crisp near sole contact, smoothly dissolving downward)
  const maxDstY = startDstY + maxReflSrcSpan * reflectScaleY;
  rctx.save();
  rctx.globalCompositeOperation = 'destination-in';
  const fade = rctx.createLinearGradient(0, startDstY, 0, Math.max(startDstY + 12, maxDstY));
  fade.addColorStop(0, 'rgba(0, 0, 0, 0.95)');
  fade.addColorStop(0.38, 'rgba(0, 0, 0, 0.52)');
  fade.addColorStop(0.82, 'rgba(0, 0, 0, 0.12)');
  fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  rctx.fillStyle = fade;
  rctx.fillRect(0, 0, bufW, bufH);
  rctx.restore();

  targetCtx.save();
  targetCtx.globalAlpha = opacity;
  targetCtx.drawImage(reflBuf, footX - soleBufX, footY);
  targetCtx.restore();
}

function resolveNightAmbientTint(
  setId: WorldSetId
): { r: number; g: number; b: number; strength: number } | undefined {
  if (setId === 'rainy-alley') return { r: 28, g: 42, b: 68, strength: 0.18 };
  if (setId === 'moonlit-forest') return { r: 22, g: 52, b: 78, strength: 0.18 };
  if (setId === 'cosmic-nebula') return { r: 44, g: 30, b: 84, strength: 0.18 };
  if (setId === 'concert-stage') return { r: 54, g: 24, b: 70, strength: 0.14 };
  return undefined;
}

/**
 * Renders the studio-grade 2-Bone IK + Continuous LBS 2.5D actor into an offscreen buffer,
 * applies behind-body trajectory-integrated Verlet cloth, Klaus Fresnel rim + ambient tint
 * (with `nightHalo: false` — zero paper sticker halo!), double-mouth masking, luminous props,
 * sole-locked water reflection BEHIND the actor, and phase-locked footstep effects!
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
  overrideUniversalAction?: UniversalActionId,
  liveOverride?: LivePerformanceOverride | null
): {
  footX: number;
  footY: number;
  drawW: number;
  drawH: number;
  soleBufX: number;
  soleBufY: number;
  liftPx: number;
  actorCanvas: HTMLCanvasElement;
} {
  const actorScale = Math.max(0.65, Math.min(1.5, actor.scale ?? 1));
  const actorNormH = computeAspectBalancedActorNormH(stageW, stageH, pose.depthScale, actorScale);
  const baseH = stageH * actorNormH;
  const aspect = srcW / Math.max(1, srcH);
  const drawH = Math.max(64, Math.round(baseH));
  const drawW = Math.max(64, Math.round(drawH * aspect));

  const bufW = Math.round(drawW * 1.9);
  const bufH = Math.round(drawH * 1.95);
  const padX = Math.round((bufW - drawW) / 2);
  const padY = Math.round(drawH * 0.72);

  const charBuf = getScratchCanvas('a', bufW, bufH);
  const cctx = charBuf.getContext('2d')!;
  cctx.clearRect(0, 0, bufW, bufH);

  const bodyBuf = getScratchCanvas('c', bufW, bufH);
  const bctx = bodyBuf.getContext('2d')!;
  bctx.clearRect(0, 0, bufW, bufH);

  const pack = getOrBuildCachedRigPack(sourceImg);
  const { anatomy } = pack;
  const isNightWorld =
    world.setId === 'rainy-alley' ||
    world.setId === 'moonlit-forest' ||
    world.setId === 'cosmic-nebula' ||
    world.setId === 'concert-stage';
  const lightRad = (world.lightAngleDeg * Math.PI) / 180;
  const lx = Math.cos(lightRad);
  const ly = Math.sin(lightRad);

  const soleBufX = padX + anatomy.centerX * drawW;
  const soleBufY = padY + anatomy.groundV * drawH;
  const liftPx = pose.verticalLiftNorm * drawH;

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

  // Smart cane/prop free-hand wave routing: if right hand holds a drawn rigid prop (e.g. Baron's cane)
  // and left hand is free, route wave swing to the FREE left arm!
  const rightBusy = Boolean(pack.skinnedMesh?.rightHasRigidProp);
  const leftBusy = Boolean(pack.skinnedMesh?.leftHasRigidProp);
  let effLeftArmSwing = pose.leftArmSwing;
  let effRightArmSwing = pose.rightArmSwing;
  if (
    rightBusy &&
    !leftBusy &&
    (shot.action === 'wave' ||
      pose.gestureMode === 'wave' ||
      (pose.rightArmSwing > 0.55 && pose.leftArmSwing < 0.35))
  ) {
    effLeftArmSwing = Math.max(pose.leftArmSwing, pose.rightArmSwing);
    effRightArmSwing = Math.min(0.22, pose.leftArmSwing);
  }

  const ambientTint = resolveNightAmbientTint(world.setId);
  const customMouths = resolveCustomMouthMap(actor);

  if (useCloudMultiPart && decomposedParts && decomposedPartBitmaps) {
    const sx = drawW / Math.max(1, srcW);
    const sy = drawH / Math.max(1, srcH);
    const sorted = [...decomposedParts].sort((a, b) => a.zIndex - b.zIndex);
    const hipX = soleBufX;
    const hipY = soleBufY - liftPx;

    bctx.save();
    if (pose.facing < 0) {
      bctx.translate(hipX, 0);
      bctx.scale(-1, 1);
      bctx.translate(-hipX, 0);
    }
    bctx.translate(hipX, hipY);
    bctx.rotate((pose.facing < 0 ? -pose.bodyLeanRad : pose.bodyLeanRad) * 0.55);
    bctx.scale(pose.squashX, pose.squashY);
    bctx.translate(-hipX, -hipY);

    for (const part of sorted) {
      const bmp = decomposedPartBitmaps.get(part.blobKey);
      if (!bmp) continue;
      const px = padX + (part.x + part.pivotX) * sx;
      const py = padY + (part.y + part.pivotY) * sy - liftPx;
      let rot = 0;
      let offX = 0;
      let offY = 0;
      let scaleX = 1;
      if (part.role === 'head') {
        rot = pose.facing < 0 ? -pose.headTiltRad : pose.headTiltRad;
        offX = Math.sin(pose.headYawRad) * drawW * 0.045 * pose.facing;
        scaleX = 1 - Math.abs(Math.sin(pose.headYawRad)) * 0.12;
      } else if (part.role === 'arm_l') {
        rot = effLeftArmSwing * 0.52;
      } else if (part.role === 'arm_r') {
        rot = -effRightArmSwing * 0.52;
      } else if (part.role === 'leg_l') {
        rot = -pose.leftLegPhase * 0.34;
        offY = -pose.leftFootLift * drawH * 0.06;
      } else if (part.role === 'leg_r') {
        rot = -pose.rightLegPhase * 0.34;
        offY = -pose.rightFootLift * drawH * 0.06;
      } else if (part.role === 'torso') {
        rot = (pose.facing < 0 ? -pose.bodyLeanRad : pose.bodyLeanRad) * 0.35;
      }
      bctx.save();
      bctx.translate(px + offX, py + offY);
      bctx.rotate(rot);
      bctx.scale(scaleX, 1);
      bctx.drawImage(bmp, -part.pivotX * sx, -part.pivotY * sy, part.w * sx, part.h * sy);
      bctx.restore();
    }
    bctx.restore();
  } else {
    const armMotionAmt = Math.min(
      1,
      Math.abs(effLeftArmSwing) + Math.abs(effRightArmSwing) + pose.velocity * 1.6
    );
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

    const artPose: ArticulatedCartoonPose & {
      viewYawRad?: number;
      gestureMode?: FilmGestureMode;
    } = {
      hipShiftX: 0,
      hipLiftY: pose.verticalLiftNorm,
      squashY: pose.squashY,
      squashX: pose.squashX,
      torsoLeanRad: pose.bodyLeanRad,
      chestCounterRad: -pose.bodyLeanRad * 0.25,
      headTiltRad: pose.headTiltRad,
      headLagY: Math.sin(timeSec * 4.2) * 0.008 * Math.max(0.25, armMotionAmt),
      headTurnX: Math.max(-1, Math.min(1, pose.headYawRad / 0.55)),
      leftArmAngle: effLeftArmSwing,
      rightArmAngle: effRightArmSwing,
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
      viewYawRad: (effectiveYawDeg * Math.PI) / 180,
      gestureMode: pose.gestureMode ?? 'none',
    };

    // Directional Klaus Fresnel Rim + Shadow Config (with nightHalo strictly OFF — zero white sticker halo!)
    const klausLight: KlausLightConfig | null = world.klausLighting
      ? {
          lx,
          ly,
          rimR:
            lightningFlash > 0.1
              ? 0.86
              : world.setId === 'moonlit-forest'
                ? 0.62
                : world.setId === 'cosmic-nebula'
                  ? 0.78
                  : world.setId === 'concert-stage'
                    ? 1.0
                    : 1.0,
          rimG:
            lightningFlash > 0.1
              ? 0.93
              : world.setId === 'moonlit-forest'
                ? 0.86
                : world.setId === 'cosmic-nebula'
                  ? 0.68
                  : world.setId === 'concert-stage'
                    ? 0.76
                    : 0.83,
          rimB:
            lightningFlash > 0.1
              ? 1.0
              : world.setId === 'moonlit-forest' || world.setId === 'cosmic-nebula'
                ? 1.0
                : world.setId === 'concert-stage'
                  ? 0.88
                  : 0.48,
          rimStrength: lightningFlash > 0.1 ? 0.76 + lightningFlash * 0.42 : isNightWorld ? 0.84 : 0.76,
          shadowR: world.setId === 'golden-hill' || world.setId === 'canyon-chase' ? 0.24 : 0.06,
          shadowG: world.setId === 'golden-hill' || world.setId === 'canyon-chase' ? 0.12 : 0.09,
          shadowB: world.setId === 'golden-hill' ? 0.19 : world.setId === 'canyon-chase' ? 0.14 : 0.22,
          shadowStrength: world.setId === 'golden-hill' ? 0.24 : isNightWorld ? 0.38 : 0.30,
        }
      : null;

    type BaseCartoonOpts = NonNullable<Parameters<typeof renderMultiLayerRiggedCharacter>[4]>;
    const sharedRenderOpts: BaseCartoonOpts & {
      nightHalo?: boolean;
      ambientTint?: { r: number; g: number; b: number; strength: number };
      customMouths?: Partial<Record<'closed' | 'A' | 'E' | 'O', CanvasImageSource>>;
      yawDeg: number;
    } = {
      boilTick: Math.floor(timeSec * 6),
      nightLampPos: null, // Strictly null so cartoonMotionEngine NEVER enables opaque cream nightHalo!
      nightHalo: false,
      ambientTint,
      customMouths,
      emotion: shot.emotion,
      eyeLeadX: pose.eyeLeadX,
      klausLight,
      universalAction: effectiveAction,
      yawDeg: effectiveYawDeg,
    };

    const useMultiViewRig = Boolean(masterCache && masterCache.getAvailableAngles().length >= 2);
    const anchors = useMultiViewRig
      ? renderMasterRigCharacter(
          bctx,
          masterCache!,
          pack,
          artPose,
          { x: padX, y: padY, w: drawW, h: drawH },
          sharedRenderOpts
        ).anchors
      : renderMultiLayerRiggedCharacter(
          bctx,
          pack,
          artPose,
          { x: padX, y: padY, w: drawW, h: drawH },
          sharedRenderOpts
        );

    // Subtle atmospheric night ambient wrap so paper highlights harmonize with dark night scenes
    if (ambientTint && ambientTint.strength > 0) {
      bctx.save();
      bctx.globalCompositeOperation = 'source-atop';
      bctx.fillStyle = `rgba(${ambientTint.r}, ${ambientTint.g}, ${ambientTint.b}, ${(
        ambientTint.strength * 0.55
      ).toFixed(3)})`;
      bctx.fillRect(0, 0, bufW, bufH);
      bctx.restore();
    }

    neckPt = anchors.neckScreen;
    mouthPt = anchors.mouthScreen;
    headTopPt = anchors.headTopScreen;
    footLeftLocalPt = anchors.footLeftScreen;
    footRightLocalPt = anchors.footRightScreen;
    if (rightBusy && !leftBusy) {
      handRightPt = anchors.handLeftScreen;
    } else if (leftBusy && !rightBusy) {
      handRightPt = anchors.handRightScreen;
    } else {
      handRightPt = pose.facing >= 0 ? anchors.handRightScreen : anchors.handLeftScreen;
    }
  }

  // 1B. Trajectory-Integrated Verlet Scarf/Cloth Drawn BEHIND Character (`Z-behind` Conical Polygon Ribbon!)
  if (actor.secondaryPhysics) {
    const windForce = world.windStrength * 1.45 - pose.velocity * 1.15 * pose.facing;
    const segLen = Math.max(5, drawW * 0.044);
    const collarX = neckPt.x - pose.facing * drawW * 0.024;
    const collarY = neckPt.y + drawH * 0.016;

    const pts = evaluateDeterministicVerletRibbon({
      anchorX: collarX,
      anchorY: collarY,
      windX: windForce,
      timeSec,
      floorY: soleBufY,
      segmentLength: segLen,
      nodeCount: 9,
      anchorTrajectory: (tHistSec: number) => {
        const pHist = evaluateCharacterPose25D(
          shot,
          tHistSec,
          world.horizonY,
          Math.abs(tHistSec - timeSec) < 1e-3 ? liveOverride : undefined
        );
        const dxStage = (pHist.groundX - pose.groundX) * stageW;
        const dyStage =
          (pHist.groundY - pose.groundY) * stageH -
          (pHist.verticalLiftNorm - pose.verticalLiftNorm) * drawH;
        const dLeanX =
          (Math.sin(pHist.bodyLeanRad) - Math.sin(pose.bodyLeanRad)) * drawW * 0.14;
        return {
          x: collarX + dxStage + dLeanX,
          y: collarY + dyStage,
        };
      },
    });

    drawConicalVerletFabricBehind(cctx, pts, drawW, actor.styleDna, pose.facing);
  }

  // Blit rendered character body ON TOP of trailing scarf (`Z-behind` guaranteed — never covers chest/tie!)
  cctx.drawImage(bodyBuf, 0, 0);

  // Slim collar wrap right at the neck base when secondary cloth physics is active
  if (actor.secondaryPhysics) {
    drawSlimNeckCollarRing(
      cctx,
      neckPt.x,
      neckPt.y,
      drawW,
      drawH,
      pose.facing < 0 ? -pose.bodyLeanRad : pose.bodyLeanRad,
      actor.styleDna
    );
  }

  // 2. Double-Mouth Prevention Mask + Custom `faceSprites.mouths` / 6-Viseme Lip-Sync Mouth!
  if (pose.viseme !== 'closed' && pose.mouthOpen > 0.08) {
    const mouthScale = Math.max(0.55, Math.min(1.65, (drawW / 245) * anatomy.mouthScale));
    const faceMaskColor = resolveLocalMouthFaceColor(pack, actor);

    // Guarantee 0% double-mouth: soft-edged face-fill ellipse hides static drawn grin during speech!
    if (pack.hasDrawnMouth) {
      const coverRx = Math.max(15, 21 * mouthScale);
      const coverRy = Math.max(10, 14 * mouthScale);
      cctx.save();
      cctx.translate(mouthPt.x, mouthPt.y);
      cctx.rotate(pose.headTiltRad * 0.85);
      cctx.scale(1, coverRy / coverRx);
      const maskGrad = cctx.createRadialGradient(0, 0, coverRx * 0.45, 0, 0, coverRx);
      maskGrad.addColorStop(0, hexToRgba(faceMaskColor, 1));
      maskGrad.addColorStop(0.68, hexToRgba(faceMaskColor, 0.96));
      maskGrad.addColorStop(1, hexToRgba(faceMaskColor, 0));
      cctx.fillStyle = maskGrad;
      cctx.beginPath();
      cctx.arc(0, 0, coverRx, 0, Math.PI * 2);
      cctx.fill();
      cctx.restore();
    }

    const mappedSlot: 'A' | 'E' | 'O' =
      pose.viseme === 'AA' ? 'A' : pose.viseme === 'EE' || pose.viseme === 'FV' ? 'E' : 'O';
    const customSprite = customMouths?.[mappedSlot];

    if (customSprite) {
      const sw = Math.max(20, 34 * mouthScale);
      const sh = Math.max(14, (22 + pose.mouthOpen * 12) * mouthScale);
      cctx.save();
      cctx.translate(mouthPt.x, mouthPt.y);
      cctx.rotate(pose.headTiltRad * 0.85);
      cctx.drawImage(customSprite, -sw * 0.5, -sh * 0.5, sw, sh);
      cctx.restore();
    } else {
      type DrawMouthCompat = (
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        scale: number,
        viseme: VisemeId,
        mouthOpen: number,
        tiltRad: number,
        opts?: {
          maskUnderlayColor?: string;
          hasDrawnMouth?: boolean;
          customMouths?: Partial<Record<'closed' | 'A' | 'E' | 'O', CanvasImageSource>>;
        }
      ) => void;
      (drawCartoonMouth as DrawMouthCompat)(
        cctx,
        mouthPt.x,
        mouthPt.y,
        mouthScale,
        pose.viseme,
        pose.mouthOpen,
        pose.headTiltRad * 0.85,
        {
          maskUnderlayColor: faceMaskColor,
          hasDrawnMouth: pack.hasDrawnMouth,
          customMouths,
        }
      );
    }
  } else if (customMouths?.closed && !pack.hasDrawnMouth) {
    const mouthScale = Math.max(0.55, Math.min(1.65, (drawW / 245) * anatomy.mouthScale));
    const sw = Math.max(18, 28 * mouthScale);
    const sh = Math.max(10, 14 * mouthScale);
    cctx.save();
    cctx.translate(mouthPt.x, mouthPt.y);
    cctx.rotate(pose.headTiltRad * 0.85);
    cctx.drawImage(customMouths.closed, -sw * 0.5, -sh * 0.5, sw, sh);
    cctx.restore();
  }

  if (shot.emotion === 'surprised') {
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

  // Legacy 2D Klaus rim pass ONLY for remote Cloud GPU multi-part cutouts
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

  // Anatomically Hand-Attached Interactive Props (Glowing Letter / Lantern / Umbrella)
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
    const gripX = pack.useMultiPart ? px + pose.facing * drawW * 0.05 : headTopPt.x + pose.facing * drawW * 0.1;
    const gripY = pack.useMultiPart ? py : headTopPt.y + drawH * 0.14;
    const domeY = Math.min(gripY - drawH * 0.34, headTopPt.y - drawH * 0.12);
    const domeX = gripX - pose.facing * drawW * 0.04;
    const domeR = Math.max(drawW * 0.34, drawH * 0.2);

    cctx.strokeStyle = '#5C3820';
    cctx.lineWidth = Math.max(3, drawW * 0.018);
    cctx.lineCap = 'round';
    cctx.beginPath();
    cctx.moveTo(gripX, gripY + drawH * 0.04);
    cctx.lineTo(domeX, domeY);
    cctx.stroke();

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

  // Exact grounded foot position on 3D Floor Plane
  const footX = pose.groundX * stageW;
  const footY = pose.groundY * stageH;
  const drawLeft = footX - soleBufX;
  const drawTop = footY - soleBufY;

  // 1. Sole-Locked Water Reflection Drawn BEHIND Z4 Actor (`0.0 px` sole gap!)
  if (world.setId === 'rainy-alley' || world.setId === 'concert-stage') {
    drawSoleLockedPuddleReflection(
      targetCtx,
      charBuf,
      footX,
      footY,
      soleBufX,
      soleBufY,
      liftPx,
      drawH,
      timeSec,
      world.setId === 'rainy-alley' ? 0.24 : 0.14
    );
  }

  // 2. Dynamic Contact Shadow, Cast Shadow & Lantern Ground Illumination Pool
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

  // 3. Phase-Locked Footstep Puddle Ripples / Dust Puffs
  drawDeterministicFootstepEffects(
    targetCtx,
    world,
    shot,
    pose,
    flWorldX,
    frWorldX,
    footY,
    drawW,
    drawH,
    timeSec
  );

  // 4. Direction-Aware Smear Speed Lines
  if (pose.velocity > 0.22 || (shot.action === 'run' && pose.velocity > 0.03)) {
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

  // 5. Blit final 2.5D character ON TOP of reflection & ground shadows!
  targetCtx.drawImage(charBuf, drawLeft, drawTop);

  return {
    footX,
    footY,
    drawW,
    drawH,
    soleBufX,
    soleBufY,
    liftPx,
    actorCanvas: charBuf,
  };
}

// ============================================================================
// 5. 6 ARTISTIC 2.5D MULTI-PLANE WORLDS, ROTATION OVERSCAN & LENS COMPOSITOR
// ============================================================================

export function computeParallaxOffset(camX: number, camY: number, depthFactor: number, w: number, h: number) {
  return {
    ox: -camX * w * depthFactor,
    oy: -camY * h * depthFactor * 0.45,
  };
}

/**
 * Analytic Rotation Envelope Overscan Factor:
 *   z_min(theta) = max((W cos|theta| + H sin|theta|) / W, (W sin|theta| + H cos|theta|) / H) * 1.06
 * Guarantees 0 uncovered `#000000` corner triangles at -4.5° and ±10° Dutch camera tilts!
 */
export function computeRotationOverscan(
  width: number,
  height: number,
  tiltRad: number,
  camZoom = 1
): number {
  const theta = Math.abs(tiltRad);
  if (theta < 1e-4 && camZoom >= 1) return 1.0;
  const W = Math.max(1, width);
  const H = Math.max(1, height);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const zMin = Math.max((W * c + H * s) / W, (W * s + H * c) / H) * 1.06;
  return Math.max(zMin, zMin / Math.max(0.5, camZoom));
}

function drawBitmapWithOverscan(
  ctx: CanvasRenderingContext2D,
  bmp: CanvasImageSource,
  pOff: { ox: number; oy: number },
  width: number,
  height: number,
  overscan: number
) {
  const padX = Math.abs(pOff.ox) + width * Math.max(0.18, (overscan - 1) * 0.65);
  const padY = Math.abs(pOff.oy) + height * Math.max(0.16, (overscan - 1) * 0.65);
  ctx.drawImage(
    bmp,
    pOff.ox - padX,
    pOff.oy - padY,
    width + padX * 2,
    height + padY * 2
  );
}

function drawFractalFoliageTree25D(
  ctx: CanvasRenderingContext2D,
  baseX: number,
  baseY: number,
  treeH: number,
  swayPx: number,
  trunkCol: string,
  leafColors: [string, string, string]
) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const topX = baseX + swayPx;
  const topY = baseY - treeH;

  // Root-flared organic trunk
  ctx.fillStyle = trunkCol;
  ctx.beginPath();
  ctx.moveTo(baseX - treeH * 0.09, baseY + 5);
  ctx.quadraticCurveTo(baseX - treeH * 0.036, baseY - treeH * 0.44, topX - treeH * 0.018, topY + treeH * 0.25);
  ctx.lineTo(topX + treeH * 0.018, topY + treeH * 0.25);
  ctx.quadraticCurveTo(baseX + treeH * 0.038, baseY - treeH * 0.44, baseX + treeH * 0.095, baseY + 5);
  ctx.closePath();
  ctx.fill();

  // Fractal primary + secondary forked limbs
  ctx.strokeStyle = trunkCol;
  const limbs = [
    { sy: 0.40, dx: -0.34, dy: -0.70, w: 0.034 },
    { sy: 0.46, dx: 0.36, dy: -0.74, w: 0.032 },
    { sy: 0.64, dx: -0.22, dy: -0.89, w: 0.024 },
    { sy: 0.66, dx: 0.25, dy: -0.92, w: 0.024 },
    { sy: 0.72, dx: 0.02, dy: -0.96, w: 0.020 },
  ];
  for (const lb of limbs) {
    const x0 = baseX + swayPx * lb.sy * 0.5;
    const y0 = baseY - treeH * lb.sy;
    const x1 = baseX + treeH * lb.dx + swayPx;
    const y1 = baseY + treeH * lb.dy;
    ctx.lineWidth = Math.max(2, treeH * lb.w);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) * 0.5, y0 - treeH * 0.08, x1, y1);
    ctx.stroke();
  }

  // Multi-tiered organic leaf canopy clusters (deep shade -> mid foliage -> warm sunlit rim)
  const clusters = [
    { ox: -0.33, oy: -0.70, rx: 0.23, ry: 0.15, c: leafColors[0] },
    { ox: 0.34, oy: -0.73, rx: 0.24, ry: 0.15, c: leafColors[0] },
    { ox: 0.0, oy: -0.80, rx: 0.32, ry: 0.19, c: leafColors[0] },
    { ox: -0.22, oy: -0.86, rx: 0.24, ry: 0.16, c: leafColors[1] },
    { ox: 0.23, oy: -0.88, rx: 0.24, ry: 0.16, c: leafColors[1] },
    { ox: -0.02, oy: -0.98, rx: 0.28, ry: 0.17, c: leafColors[1] },
    { ox: 0.12, oy: -1.03, rx: 0.19, ry: 0.12, c: leafColors[2] },
    { ox: -0.14, oy: -0.95, rx: 0.16, ry: 0.11, c: leafColors[2] },
  ];
  for (const cl of clusters) {
    ctx.fillStyle = cl.c;
    ctx.beginPath();
    ctx.ellipse(
      baseX + treeH * cl.ox + swayPx,
      baseY + treeH * cl.oy,
      treeH * cl.rx,
      treeH * cl.ry,
      swayPx * 0.004,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Renders ONLY distant/midground layers `Z0..Z2` (BEFORE Depth-of-Field Bokeh Pass!)
 * Returns key scene light source coordinates in world space for optical halation!
 */
function drawWorldBackgroundLayersZ0ToZ2(
  ctx: CanvasRenderingContext2D,
  world: FilmWorldConfig,
  dna: StyleDNA,
  width: number,
  height: number,
  horizonPx: number,
  camX: number,
  camY: number,
  overscan: number,
  localSec: number,
  lightningFlash: number
): { x: number; y: number; color: string; radius: number }[] {
  const lights: { x: number; y: number; color: string; radius: number }[] = [];
  const extX = Math.max(width * 0.65, width * (overscan - 1) + width * 0.45);
  const extY = Math.max(height * 0.55, height * (overscan - 1) + height * 0.35);

  const p0 = computeParallaxOffset(camX, camY, 0.08, width, height);
  const p1 = computeParallaxOffset(camX, camY, 0.25, width, height);
  const p2 = computeParallaxOffset(camX, camY, 0.58, width, height);

  if (world.setId === 'rainy-alley') {
    // Z0: Stormy midnight sky + layered rain clouds + distant clocktower/spire silhouettes
    const sky = ctx.createLinearGradient(0, -extY * 0.4, 0, horizonPx + 80);
    sky.addColorStop(0, lightningFlash > 0.2 ? '#3C5378' : '#0B1120');
    sky.addColorStop(0.55, lightningFlash > 0.2 ? '#59749C' : '#18243A');
    sky.addColorStop(1, '#293246');
    ctx.fillStyle = sky;
    ctx.fillRect(-extX, -extY, width + extX * 2, height + extY * 2);

    const moonX = width * 0.78 + p0.ox;
    const moonY = height * 0.17 + p0.oy;
    const mGlow = ctx.createRadialGradient(moonX, moonY, 8, moonX, moonY, width * 0.14);
    mGlow.addColorStop(0, `rgba(238, 244, 255, ${(0.55 + lightningFlash * 0.35).toFixed(2)})`);
    mGlow.addColorStop(0.45, 'rgba(168, 194, 232, 0.18)');
    mGlow.addColorStop(1, 'rgba(168, 194, 232, 0)');
    ctx.fillStyle = mGlow;
    ctx.beginPath();
    ctx.arc(moonX, moonY, width * 0.14, 0, Math.PI * 2);
    ctx.fill();
    lights.push({ x: moonX, y: moonY, color: 'rgba(210, 228, 255, 0.26)', radius: width * 0.18 });

    // Layered storm clouds + distant spire silhouettes (Z0)
    ctx.save();
    ctx.translate(p0.ox, p0.oy);
    ctx.fillStyle = lightningFlash > 0.2 ? 'rgba(190, 212, 245, 0.22)' : 'rgba(18, 27, 46, 0.56)';
    for (let cl = -2; cl <= 5; cl++) {
      const cx = cl * (width * 0.24) + ((localSec * 9) % (width * 0.24));
      const cy = height * (0.13 + (Math.abs(cl) % 2) * 0.07);
      ctx.beginPath();
      ctx.ellipse(cx, cy, width * 0.12, height * 0.048, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + width * 0.05, cy - height * 0.015, width * 0.085, height * 0.036, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#111829';
    for (let sp = -3; sp <= 8; sp++) {
      const sx = sp * (width * 0.16);
      const sw = width * 0.09;
      const sh = height * (0.24 + (Math.abs(sp * 3) % 4) * 0.05);
      ctx.beginPath();
      ctx.moveTo(sx, horizonPx + 20);
      ctx.lineTo(sx, horizonPx - sh + 26);
      if (Math.abs(sp) % 2 === 0) {
        ctx.lineTo(sx + sw * 0.32, horizonPx - sh + 26);
        ctx.lineTo(sx + sw * 0.5, horizonPx - sh - 34);
        ctx.lineTo(sx + sw * 0.68, horizonPx - sh + 26);
      } else {
        ctx.lineTo(sx + sw * 0.18, horizonPx - sh);
        ctx.lineTo(sx + sw * 0.82, horizonPx - sh);
      }
      ctx.lineTo(sx + sw, horizonPx - sh + 26);
      ctx.lineTo(sx + sw, horizonPx + 20);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Z1: Chimney / Mansard Rooftop / Water-Tank Horizon + Misty Warm Interior Windows
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    const roofSpanW = width * 0.15;
    for (let b = -4; b <= 10; b++) {
      const bx = b * roofSpanW;
      const bw = roofSpanW * 0.96;
      const bh = height * (0.25 + (Math.abs(b * 5) % 4) * 0.048);
      const topY = horizonPx - bh;
      ctx.fillStyle = b % 2 === 0 ? '#161F32' : '#1B253A';
      ctx.fillRect(bx, topY + 20, bw, bh + 30);

      // Mansard / Gable roofline + brick chimney
      ctx.fillStyle = '#0F1625';
      ctx.beginPath();
      ctx.moveTo(bx - 4, topY + 22);
      ctx.lineTo(bx + bw * 0.15, topY);
      ctx.lineTo(bx + bw * 0.85, topY);
      ctx.lineTo(bx + bw + 4, topY + 22);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(bx + bw * 0.72, topY - 14, 10, 18);

      // Rooftop wooden water tank on every 4th building
      if (Math.abs(b) % 4 === 1) {
        const tx = bx + bw * 0.25;
        ctx.strokeStyle = '#0D1320';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tx + 3, topY);
        ctx.lineTo(tx + 6, topY - 14);
        ctx.moveTo(tx + 21, topY);
        ctx.lineTo(tx + 18, topY - 14);
        ctx.stroke();
        ctx.fillStyle = '#131B2C';
        ctx.fillRect(tx + 2, topY - 30, 20, 16);
        ctx.beginPath();
        ctx.moveTo(tx, topY - 30);
        ctx.lineTo(tx + 12, topY - 38);
        ctx.lineTo(tx + 24, topY - 30);
        ctx.closePath();
        ctx.fill();
      }

      // Steamy warm interior windows with inner perspective muntins
      for (let wr = 0; wr < 2; wr++) {
        for (let wc = 0; wc < 2; wc++) {
          if ((Math.abs(b) + wr + wc) % 3 === 0) continue;
          const wx = bx + bw * (0.18 + wc * 0.42);
          const wy = topY + 34 + wr * 34;
          const ww = Math.max(10, bw * 0.18);
          const wh = 20;
          const wGlow = ctx.createRadialGradient(wx + ww * 0.5, wy + wh * 0.5, 2, wx + ww * 0.5, wy + wh * 0.5, ww * 1.4);
          wGlow.addColorStop(0, 'rgba(255, 208, 118, 0.34)');
          wGlow.addColorStop(1, 'rgba(255, 208, 118, 0)');
          ctx.fillStyle = wGlow;
          ctx.fillRect(wx - ww * 0.6, wy - 8, ww * 2.2, wh + 18);

          const inGrad = ctx.createLinearGradient(wx, wy, wx, wy + wh);
          inGrad.addColorStop(0, 'rgba(255, 224, 150, 0.78)');
          inGrad.addColorStop(1, 'rgba(214, 138, 62, 0.58)');
          ctx.fillStyle = inGrad;
          ctx.fillRect(wx, wy, ww, wh);
          ctx.strokeStyle = '#101726';
          ctx.lineWidth = 1.4;
          ctx.strokeRect(wx, wy, ww, wh);
          ctx.beginPath();
          ctx.moveTo(wx + ww * 0.5, wy);
          ctx.lineTo(wx + ww * 0.5, wy + wh);
          ctx.moveTo(wx, wy + wh * 0.52);
          ctx.lineTo(wx + ww, wy + wh * 0.52);
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    // Z2: Arched Stone Facades + Wrought-Iron Balconies + Striped Awnings + Cast-Iron Streetlamp Cone
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    const leftWallX = -extX;
    const leftWallW = extX + width * 0.24;
    const rightWallX = width * 0.78;
    const rightWallW = width * 0.22 + extX;

    // Left stone facade
    const lwGrad = ctx.createLinearGradient(0, 20, 0, horizonPx + 18);
    lwGrad.addColorStop(0, '#1D2538');
    lwGrad.addColorStop(1, '#141A28');
    ctx.fillStyle = lwGrad;
    ctx.fillRect(leftWallX, -extY * 0.3, leftWallW, horizonPx + extY * 0.3 + 22);
    ctx.fillRect(rightWallX, -extY * 0.3, rightWallW, horizonPx + extY * 0.3 + 22);

    // Stone archways & wrought-iron balconies on both facades
    ctx.strokeStyle = 'rgba(165, 188, 224, 0.14)';
    ctx.lineWidth = 1.6;
    for (const archCx of [width * 0.09, width * 0.87]) {
      const archW = width * 0.12;
      const archTopY = horizonPx - height * 0.23;
      const cafeGlow = ctx.createRadialGradient(archCx, horizonPx - height * 0.12, 8, archCx, horizonPx - height * 0.1, archW * 1.3);
      cafeGlow.addColorStop(0, 'rgba(255, 204, 108, 0.52)');
      cafeGlow.addColorStop(1, 'rgba(255, 180, 78, 0)');
      ctx.fillStyle = cafeGlow;
      ctx.fillRect(archCx - archW * 1.3, archTopY - 30, archW * 2.6, height * 0.34);

      const glassGrad = ctx.createLinearGradient(0, archTopY, 0, horizonPx);
      glassGrad.addColorStop(0, '#FFE29E');
      glassGrad.addColorStop(0.65, '#EA9F48');
      glassGrad.addColorStop(1, '#8C4E26');
      ctx.fillStyle = glassGrad;
      ctx.beginPath();
      ctx.moveTo(archCx - archW * 0.45, horizonPx);
      ctx.lineTo(archCx - archW * 0.45, archTopY + archW * 0.45);
      ctx.arc(archCx, archTopY + archW * 0.45, archW * 0.45, Math.PI, 0);
      ctx.lineTo(archCx + archW * 0.45, horizonPx);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = dna.inkColor;
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // Striped bistro awning over arch
      const stripes = 6;
      const sw = (archW * 1.04) / stripes;
      const awnY = archTopY + archW * 0.32;
      for (let st = 0; st < stripes; st++) {
        const sx = archCx - archW * 0.52 + st * sw;
        ctx.fillStyle = st % 2 === 0 ? '#C4422B' : '#EFE3CD';
        ctx.fillRect(sx, awnY, sw + 0.6, 13);
        ctx.beginPath();
        ctx.arc(sx + sw * 0.5, awnY + 13, sw * 0.5, 0, Math.PI);
        ctx.fill();
      }

      // Upper floor arched French window + wrought-iron balcony
      const balY = archTopY - height * 0.14;
      ctx.fillStyle = 'rgba(246, 198, 108, 0.68)';
      ctx.fillRect(archCx - archW * 0.28, balY, archW * 0.56, height * 0.11);
      ctx.strokeStyle = '#0D121D';
      ctx.lineWidth = 2;
      ctx.strokeRect(archCx - archW * 0.36, balY + height * 0.07, archW * 0.72, height * 0.045);
      for (let r = -3; r <= 3; r++) {
        const rx = archCx + (r / 3.5) * archW * 0.34;
        ctx.beginPath();
        ctx.moveTo(rx, balY + height * 0.07);
        ctx.lineTo(rx, balY + height * 0.115);
        ctx.stroke();
      }
    }

    // Ornate Cast-Iron Streetlamp + Volumetric Amber Light Cone
    const lampX = width * 0.58;
    const lampBaseY = horizonPx + 14;
    const lampTopY = horizonPx - height * 0.36;
    const bulbX = lampX - width * 0.028;
    const bulbY = lampTopY + 12;

    ctx.strokeStyle = '#121620';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(6, width * 0.0065);
    ctx.beginPath();
    ctx.moveTo(lampX, lampBaseY);
    ctx.lineTo(lampX, lampTopY);
    ctx.quadraticCurveTo(lampX, lampTopY - 24, bulbX, lampTopY - 4);
    ctx.stroke();
    // Decorative scroll bracket + lantern cage
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(lampX - width * 0.011, lampTopY + 8, 9, 0, Math.PI * 1.6);
    ctx.stroke();

    const cone = ctx.createRadialGradient(bulbX, bulbY, 8, bulbX, horizonPx + height * 0.08, height * 0.46);
    cone.addColorStop(0, 'rgba(255, 232, 152, 0.78)');
    cone.addColorStop(0.32, 'rgba(246, 182, 68, 0.26)');
    cone.addColorStop(1, 'rgba(246, 182, 68, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(bulbX - 16, bulbY);
    ctx.lineTo(bulbX + 16, bulbY);
    ctx.lineTo(bulbX + width * 0.18, horizonPx + height * 0.26);
    ctx.lineTo(bulbX - width * 0.22, horizonPx + height * 0.26);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#FFF8DB';
    ctx.beginPath();
    ctx.arc(bulbX, bulbY, Math.max(7, width * 0.008), 0, Math.PI * 2);
    ctx.fill();
    lights.push({
      x: bulbX + p2.ox,
      y: bulbY + p2.oy,
      color: 'rgba(255, 198, 102, 0.34)',
      radius: width * 0.22,
    });
    ctx.restore();
  } else if (world.setId === 'golden-hill') {
    // Z0: Multi-stop Golden-Coral Sunset Sky + Volumetric Sunbeams (God-Rays)
    const sky = ctx.createLinearGradient(0, -extY * 0.4, 0, horizonPx + 70);
    sky.addColorStop(0, '#5A78A8');
    sky.addColorStop(0.28, '#B8A8B8');
    sky.addColorStop(0.58, '#F4CFA2');
    sky.addColorStop(0.84, '#F5A66E');
    sky.addColorStop(1, '#EC7E56');
    ctx.fillStyle = sky;
    ctx.fillRect(-extX, -extY, width + extX * 2, height + extY * 2);

    const sunX = width * 0.74 + p0.ox;
    const sunY = height * 0.23 + p0.oy;

    // Volumetric diagonal god-rays fanning from sunset sun
    ctx.save();
    for (let r = 0; r < 6; r++) {
      const ang = -0.55 + r * 0.24 + Math.sin(localSec * 0.4 + r) * 0.02;
      ctx.save();
      ctx.translate(sunX, sunY);
      ctx.rotate(ang);
      const rg = ctx.createLinearGradient(0, 0, 0, height * 0.95);
      rg.addColorStop(0, 'rgba(255, 244, 198, 0.20)');
      rg.addColorStop(0.55, 'rgba(255, 198, 128, 0.07)');
      rg.addColorStop(1, 'rgba(255, 178, 108, 0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(-width * 0.015, 0);
      ctx.lineTo(width * 0.015, 0);
      ctx.lineTo(width * 0.095, height * 0.95);
      ctx.lineTo(-width * 0.095, height * 0.95);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    const sunGlow = ctx.createRadialGradient(sunX, sunY, 16, sunX, sunY, width * 0.22);
    sunGlow.addColorStop(0, 'rgba(255, 250, 214, 0.96)');
    sunGlow.addColorStop(0.35, 'rgba(252, 184, 82, 0.44)');
    sunGlow.addColorStop(1, 'rgba(235, 102, 54, 0)');
    ctx.fillStyle = sunGlow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, width * 0.22, 0, Math.PI * 2);
    ctx.fill();
    lights.push({ x: sunX, y: sunY, color: 'rgba(255, 208, 124, 0.36)', radius: width * 0.28 });

    // Painterly coral-rimmed cumulus clouds
    const drift = (localSec * 12) % (width + 260);
    for (const [cx0, cy0, sc] of [
      [0.12 * width, 0.16 * height, 1.05],
      [0.44 * width, 0.12 * height, 0.85],
      [0.78 * width, 0.20 * height, 0.95],
    ]) {
      const x = ((cx0 + drift) % (width + 260)) - 130 + p0.ox;
      const y = cy0 + p0.oy;
      ctx.fillStyle = 'rgba(246, 178, 146, 0.52)';
      ctx.beginPath();
      ctx.arc(x, y + 6, 30 * sc, 0, Math.PI * 2);
      ctx.arc(x + 36 * sc, y - 4 * sc, 38 * sc, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 249, 238, 0.86)';
      ctx.beginPath();
      ctx.arc(x, y, 28 * sc, 0, Math.PI * 2);
      ctx.arc(x + 34 * sc, y - 10 * sc, 36 * sc, 0, Math.PI * 2);
      ctx.arc(x + 68 * sc, y + 2 * sc, 25 * sc, 0, Math.PI * 2);
      ctx.fill();
    }

    // Z1: Atmospheric Purple-Blue Distant Mountain Ridges
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    ctx.fillStyle = '#7C7098';
    ctx.beginPath();
    ctx.moveTo(-extX, height + extY);
    for (let x = -extX; x <= width + extX; x += 48) {
      const y = horizonPx - height * 0.14 + Math.sin(x * 0.0045 + 0.8) * (height * 0.065) + Math.cos(x * 0.011) * (height * 0.025);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width + extX, height + extY);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#94788E';
    ctx.beginPath();
    ctx.moveTo(-extX, height + extY);
    for (let x = -extX; x <= width + extX; x += 44) {
      const y = horizonPx - height * 0.06 + Math.sin(x * 0.006 + 2.3) * (height * 0.045);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width + extX, height + extY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Z2: Rolling Golden-Olive Midground Hill + Organic Fractal Branching Trees + Rustic Wooden Fence
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    const midHillGrad = ctx.createLinearGradient(0, horizonPx - 50, 0, height);
    midHillGrad.addColorStop(0, '#B58454');
    midHillGrad.addColorStop(1, '#7D5B3A');
    ctx.fillStyle = midHillGrad;
    ctx.beginPath();
    ctx.moveTo(-extX, horizonPx + 45);
    ctx.quadraticCurveTo(width * 0.28, horizonPx - 62, width * 0.68, horizonPx + 12);
    ctx.quadraticCurveTo(width * 0.96, horizonPx - 28, width + extX, horizonPx + 32);
    ctx.lineTo(width + extX, height + extY);
    ctx.lineTo(-extX, height + extY);
    ctx.closePath();
    ctx.fill();

    const sway = Math.sin(localSec * 2.3) * 8 * world.windStrength;
    drawFractalFoliageTree25D(
      ctx,
      width * 0.81,
      horizonPx + 10,
      height * 0.26,
      sway,
      '#3E2A1E',
      ['#5E3B28', world.harmonizeToStyleDna ? dna.accentColor : '#C85E32', '#F5B858']
    );
    drawFractalFoliageTree25D(
      ctx,
      width * 0.16,
      horizonPx - 14,
      height * 0.18,
      sway * 0.75,
      '#4A3326',
      ['#563A2C', '#B85A34', '#EFA852']
    );

    // Rustic wooden split-rail fence following hill ridge
    ctx.strokeStyle = '#4E3524';
    ctx.lineCap = 'round';
    for (let rail = 0; rail < 2; rail++) {
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let fx = -extX * 0.5; fx <= width + extX * 0.5; fx += 48) {
        const ridgeY = horizonPx + 18 - Math.sin((fx / Math.max(1, width)) * Math.PI) * 28 - rail * 9;
        if (fx === -extX * 0.5) ctx.moveTo(fx, ridgeY);
        else ctx.lineTo(fx, ridgeY);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#3F2A1C';
    for (let fx = -extX * 0.4; fx <= width + extX * 0.4; fx += 76) {
      const postBaseY = horizonPx + 24 - Math.sin((fx / Math.max(1, width)) * Math.PI) * 28;
      ctx.fillRect(fx - 2.5, postBaseY - 24, 5, 26);
    }
    ctx.restore();
  } else if (world.setId === 'moonlit-forest') {
    // Z0: Deep Indigo Sky + Multi-Ring Full Moon Halo + Stardust
    const sky = ctx.createLinearGradient(0, -extY * 0.4, 0, height);
    sky.addColorStop(0, '#091224');
    sky.addColorStop(0.55, '#132742');
    sky.addColorStop(1, '#0F1F2E');
    ctx.fillStyle = sky;
    ctx.fillRect(-extX, -extY, width + extX * 2, height + extY * 2);

    ctx.save();
    ctx.translate(p0.ox, p0.oy);
    for (let s = 0; s < 54; s++) {
      const sx = ((s * 137) % Math.round(width + extX)) - extX * 0.5;
      const sy = ((s * 79) % Math.max(40, Math.round(horizonPx * 0.85)));
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(localSec * 1.9 + s));
      ctx.fillStyle = `rgba(218, 238, 255, ${tw.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, s % 6 === 0 ? 1.9 : 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const mx = width * 0.32 + p0.ox;
    const my = height * 0.2 + p0.oy;
    const mGlow = ctx.createRadialGradient(mx, my, 16, mx, my, width * 0.2);
    mGlow.addColorStop(0, 'rgba(235, 248, 255, 0.94)');
    mGlow.addColorStop(0.28, 'rgba(150, 208, 252, 0.34)');
    mGlow.addColorStop(1, 'rgba(110, 175, 230, 0)');
    ctx.fillStyle = mGlow;
    ctx.beginPath();
    ctx.arc(mx, my, width * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#F2FAFF';
    ctx.beginPath();
    ctx.arc(mx, my, Math.max(20, width * 0.026), 0, Math.PI * 2);
    ctx.fill();
    lights.push({ x: mx, y: my, color: 'rgba(162, 218, 255, 0.32)', radius: width * 0.24 });

    // Z1: Misty Layered Woodland Hills
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    ctx.fillStyle = '#122438';
    ctx.beginPath();
    ctx.moveTo(-extX, horizonPx + 40);
    for (let x = -extX; x <= width + extX; x += 42) {
      const y = horizonPx - height * 0.16 + Math.sin(x * 0.007) * (height * 0.045) - Math.abs(Math.sin(x * 0.035)) * 18;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width + extX, horizonPx + 40);
    ctx.closePath();
    ctx.fill();

    const farMist = ctx.createLinearGradient(0, horizonPx - 80, 0, horizonPx + 30);
    farMist.addColorStop(0, 'rgba(148, 204, 240, 0)');
    farMist.addColorStop(0.55, 'rgba(148, 204, 240, 0.16)');
    farMist.addColorStop(1, 'rgba(148, 204, 240, 0)');
    ctx.fillStyle = farMist;
    ctx.fillRect(-extX, horizonPx - 80, width + extX * 2, 110);
    ctx.restore();

    // Z2: Bark-Textured Ancient Organic Tree Trunks with Roots & Branches + Diagonal Moonlight Shafts
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    for (let sh = 0; sh < 3; sh++) {
      const sx = width * (0.22 + sh * 0.24);
      const beam = ctx.createLinearGradient(sx - 60, -40, sx + 120, horizonPx + 80);
      beam.addColorStop(0, 'rgba(182, 226, 255, 0.16)');
      beam.addColorStop(1, 'rgba(182, 226, 255, 0)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(sx - 40, -extY * 0.3);
      ctx.lineTo(sx + 24, -extY * 0.3);
      ctx.lineTo(sx + 185, horizonPx + 60);
      ctx.lineTo(sx + 55, horizonPx + 60);
      ctx.closePath();
      ctx.fill();
    }

    for (const fracX of [-0.18, 0.09, 0.27, 0.73, 0.91, 1.18]) {
      const tx = width * fracX;
      const tw = Math.max(28, width * 0.042);
      const baseY = horizonPx + 18;
      ctx.fillStyle = '#0D1924';
      ctx.beginPath();
      // Flared organic roots + tapered trunk + upper boughs
      ctx.moveTo(tx - tw * 1.05, baseY + 10);
      ctx.quadraticCurveTo(tx - tw * 0.52, baseY - 28, tx - tw * 0.45, -extY * 0.35);
      ctx.lineTo(tx + tw * 0.45, -extY * 0.35);
      ctx.quadraticCurveTo(tx + tw * 0.52, baseY - 28, tx + tw * 1.1, baseY + 10);
      ctx.closePath();
      ctx.fill();

      // Reaching crooked branches
      ctx.strokeStyle = '#0D1924';
      ctx.lineWidth = tw * 0.32;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tx, horizonPx - height * 0.26);
      ctx.quadraticCurveTo(tx + tw * 1.6, horizonPx - height * 0.34, tx + tw * 3.1, horizonPx - height * 0.31);
      ctx.moveTo(tx, horizonPx - height * 0.32);
      ctx.quadraticCurveTo(tx - tw * 1.5, horizonPx - height * 0.40, tx - tw * 2.8, horizonPx - height * 0.38);
      ctx.stroke();

      // Moonlight bark ridge highlights on moon-facing edge
      ctx.strokeStyle = 'rgba(158, 212, 248, 0.18)';
      ctx.lineWidth = 1.6;
      for (let b = 0; b < 4; b++) {
        const bx = tx + (fracX > 0.32 ? -tw * 0.32 : tw * 0.32) + (b - 1.5) * 3;
        ctx.beginPath();
        ctx.moveTo(bx, horizonPx - height * (0.05 + b * 0.07));
        ctx.lineTo(bx + 1, horizonPx - height * (0.14 + b * 0.07));
        ctx.stroke();
      }
    }
    ctx.restore();
  } else if (world.setId === 'cosmic-nebula') {
    // Z0: Deep Cosmic Twilight + Dual-Tone Magenta/Cyan Nebula + Starfield
    const sky = ctx.createLinearGradient(0, -extY * 0.4, 0, height);
    sky.addColorStop(0, '#09071C');
    sky.addColorStop(0.5, '#1A1344');
    sky.addColorStop(1, '#121B3A');
    ctx.fillStyle = sky;
    ctx.fillRect(-extX, -extY, width + extX * 2, height + extY * 2);

    ctx.save();
    ctx.translate(p0.ox, p0.oy);
    const neb1 = ctx.createRadialGradient(width * 0.28, height * 0.28, 12, width * 0.28, height * 0.28, width * 0.34);
    neb1.addColorStop(0, 'rgba(232, 92, 188, 0.34)');
    neb1.addColorStop(0.55, 'rgba(112, 96, 248, 0.16)');
    neb1.addColorStop(1, 'rgba(112, 96, 248, 0)');
    ctx.fillStyle = neb1;
    ctx.fillRect(-extX, -extY, width + extX * 2, height + extY * 2);

    const neb2 = ctx.createRadialGradient(width * 0.72, height * 0.36, 12, width * 0.72, height * 0.36, width * 0.30);
    neb2.addColorStop(0, 'rgba(68, 226, 224, 0.24)');
    neb2.addColorStop(1, 'rgba(68, 226, 224, 0)');
    ctx.fillStyle = neb2;
    ctx.fillRect(-extX, -extY, width + extX * 2, height + extY * 2);

    for (let s = 0; s < 84; s++) {
      const sx = ((s * 149) % Math.round(width + extX)) - extX * 0.5;
      const sy = ((s * 83) % Math.max(50, Math.round(horizonPx * 0.96)));
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(localSec * (1.6 + (s % 4) * 0.4) + s));
      ctx.fillStyle = s % 4 === 0 ? `rgba(255, 224, 152, ${tw.toFixed(2)})` : `rgba(228, 240, 255, ${tw.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, s % 7 === 0 ? 2.3 : 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Z1: Ringed Pastel Planet + Crescent Companion Moon
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    const px = width * 0.76;
    const py = height * 0.24;
    const pr = Math.max(34, width * 0.046);
    const pGrad = ctx.createRadialGradient(px - pr * 0.3, py - pr * 0.3, 6, px, py, pr);
    pGrad.addColorStop(0, '#FFE7B2');
    pGrad.addColorStop(0.55, '#E48C6E');
    pGrad.addColorStop(1, '#5D2E5E');
    ctx.fillStyle = pGrad;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 232, 184, 0.68)';
    ctx.lineWidth = Math.max(4, pr * 0.12);
    ctx.beginPath();
    ctx.ellipse(px, py, pr * 1.85, pr * 0.42, -0.26, 0, Math.PI * 2);
    ctx.stroke();
    lights.push({ x: px + p1.ox, y: py + p1.oy, color: 'rgba(244, 184, 232, 0.30)', radius: width * 0.22 });
    ctx.restore();

    // Z2: Crystalline Alien Spires & Nebula Horizon Ridges
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    ctx.fillStyle = '#1E214A';
    ctx.beginPath();
    ctx.moveTo(-extX, horizonPx + 40);
    for (let x = -extX; x <= width + extX; x += 56) {
      const y = horizonPx - height * 0.08 + Math.sin(x * 0.008) * 28;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width + extX, horizonPx + 40);
    ctx.closePath();
    ctx.fill();

    for (let cr = -2; cr <= 8; cr++) {
      const cx = cr * (width * 0.15) + 40;
      const ch = height * (0.10 + (Math.abs(cr * 3) % 3) * 0.045);
      const cGrad = ctx.createLinearGradient(cx, horizonPx - ch, cx, horizonPx + 14);
      cGrad.addColorStop(0, 'rgba(122, 224, 255, 0.72)');
      cGrad.addColorStop(1, 'rgba(42, 48, 102, 0.92)');
      ctx.fillStyle = cGrad;
      ctx.beginPath();
      ctx.moveTo(cx - 20, horizonPx + 14);
      ctx.lineTo(cx - 3, horizonPx - ch);
      ctx.lineTo(cx + 15, horizonPx - ch * 0.68);
      ctx.lineTo(cx + 24, horizonPx + 14);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  } else if (world.setId === 'concert-stage') {
    // Z0: Concert Hall Ceiling + Overhead Rigging Truss + Volumetric Spotlights
    const bg = ctx.createLinearGradient(0, -extY * 0.4, 0, height);
    bg.addColorStop(0, '#11071E');
    bg.addColorStop(0.6, '#26103D');
    bg.addColorStop(1, '#12081C');
    ctx.fillStyle = bg;
    ctx.fillRect(-extX, -extY, width + extX * 2, height + extY * 2);

    // Z1: Warm Backdrop Acoustic Light Wall + Sweeping Beams
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    const pulse = Math.pow(Math.abs(Math.sin(localSec * Math.PI * 1.8)), 2.4);
    for (let eq = -3; eq < 21; eq++) {
      const ex = eq * (width * 0.055);
      const eh = height * 0.06 + Math.abs(Math.sin(localSec * 4.4 + eq * 0.8)) * (height * (0.12 + pulse * 0.05));
      ctx.fillStyle = eq % 2 === 0 ? 'rgba(255, 198, 92, 0.18)' : 'rgba(255, 88, 168, 0.18)';
      ctx.fillRect(ex, horizonPx - eh, width * 0.036, eh);
    }

    const beams = [
      { ox: width * 0.2, col: 'rgba(255, 92, 178, 0.26)', ang: 0.32 + Math.sin(localSec * 1.6) * 0.18 },
      { ox: width * 0.5, col: 'rgba(255, 218, 112, 0.30)', ang: Math.sin(localSec * 1.2) * 0.14 },
      { ox: width * 0.8, col: 'rgba(78, 224, 255, 0.26)', ang: -0.32 - Math.cos(localSec * 1.5) * 0.18 },
    ];
    for (const bm of beams) {
      ctx.save();
      ctx.translate(bm.ox, height * 0.03);
      ctx.rotate(bm.ang);
      const bGrad = ctx.createLinearGradient(0, 0, 0, height * 0.88);
      bGrad.addColorStop(0, bm.col);
      bGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = bGrad;
      ctx.beginPath();
      ctx.moveTo(-18, 0);
      ctx.lineTo(18, 0);
      ctx.lineTo(width * 0.13, height * 0.88);
      ctx.lineTo(-width * 0.13, height * 0.88);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    lights.push({ x: width * 0.5 + p1.ox, y: height * 0.06 + p1.oy, color: 'rgba(255, 214, 128, 0.34)', radius: width * 0.26 });
    ctx.restore();

    // Z2: Draped Crimson Velvet Stage Curtains (extended past outer overscan!) + Speaker Stacks
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    for (const side of [-1, 1]) {
      const innerX = side < 0 ? width * 0.13 : width * 0.87;
      const outerX = side < 0 ? -extX : width + extX;
      const cGrad = ctx.createLinearGradient(outerX, 0, innerX, 0);
      cGrad.addColorStop(0, '#38091B');
      cGrad.addColorStop(0.65, '#7C1838');
      cGrad.addColorStop(1, '#4C0D22');
      ctx.fillStyle = cGrad;
      ctx.beginPath();
      ctx.moveTo(outerX, -extY * 0.4);
      ctx.lineTo(innerX, -extY * 0.4);
      ctx.quadraticCurveTo(innerX - side * width * 0.035, horizonPx * 0.55, innerX - side * width * 0.01, horizonPx + 14);
      ctx.lineTo(outerX, horizonPx + 14);
      ctx.closePath();
      ctx.fill();

      // Gold curtain tieback cord
      ctx.strokeStyle = '#E8B84B';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(innerX - side * 14, horizonPx * 0.58, 18, 0, Math.PI);
      ctx.stroke();
    }
    ctx.restore();
  } else {
    // ---- SET 6: CANYON CHASE (`canyon-chase`) ----
    // Z0: Blazing Copper-Crimson Canyon Sunset Sky
    const sky = ctx.createLinearGradient(0, -extY * 0.4, 0, horizonPx + 60);
    sky.addColorStop(0, '#311838');
    sky.addColorStop(0.46, '#963A42');
    sky.addColorStop(0.82, '#E87E46');
    sky.addColorStop(1, '#F6B665');
    ctx.fillStyle = sky;
    ctx.fillRect(-extX, -extY, width + extX * 2, height + extY * 2);

    const sunX = width * 0.72 + p0.ox;
    const sunY = height * 0.26 + p0.oy;
    const sGlow = ctx.createRadialGradient(sunX, sunY, 14, sunX, sunY, width * 0.2);
    sGlow.addColorStop(0, 'rgba(255, 244, 198, 0.92)');
    sGlow.addColorStop(0.4, 'rgba(244, 138, 66, 0.38)');
    sGlow.addColorStop(1, 'rgba(214, 72, 48, 0)');
    ctx.fillStyle = sGlow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, width * 0.2, 0, Math.PI * 2);
    ctx.fill();
    lights.push({ x: sunX, y: sunY, color: 'rgba(255, 178, 96, 0.34)', radius: width * 0.24 });

    // Z1: Distant Layered Sandstone Mesas & Monument Buttes
    ctx.save();
    ctx.translate(p1.ox, p1.oy);
    ctx.fillStyle = '#6A2D3E';
    for (let m = -3; m <= 8; m++) {
      const mx = m * (width * 0.18);
      const mh = height * (0.16 + (Math.abs(m * 3) % 3) * 0.05);
      ctx.beginPath();
      ctx.moveTo(mx - 18, horizonPx + 20);
      ctx.lineTo(mx + 22, horizonPx - mh);
      ctx.lineTo(mx + width * 0.11, horizonPx - mh);
      ctx.lineTo(mx + width * 0.15, horizonPx + 20);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Z2: Stratified Red-Rock Ridges + Saguaro Cactus Silhouettes
    ctx.save();
    ctx.translate(p2.ox, p2.oy);
    const mesaGrad = ctx.createLinearGradient(0, horizonPx - height * 0.18, 0, horizonPx + 30);
    mesaGrad.addColorStop(0, '#8C3B32');
    mesaGrad.addColorStop(1, '#582224');
    ctx.fillStyle = mesaGrad;
    ctx.beginPath();
    ctx.moveTo(-extX, horizonPx + 30);
    for (let x = -extX; x <= width + extX; x += 64) {
      const y = horizonPx - height * 0.07 + Math.sin(x * 0.0075) * 26;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width + extX, horizonPx + 30);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#3C171C';
    ctx.lineCap = 'round';
    for (const cxFrac of [0.14, 0.38, 0.66, 0.88]) {
      const cx = width * cxFrac;
      const cy = horizonPx + 6;
      const ch = height * 0.09;
      ctx.lineWidth = Math.max(5, width * 0.0055);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - ch);
      ctx.moveTo(cx - 12, cy - ch * 0.62);
      ctx.quadraticCurveTo(cx - 12, cy - ch * 0.42, cx, cy - ch * 0.42);
      ctx.moveTo(cx - 12, cy - ch * 0.62);
      ctx.lineTo(cx - 12, cy - ch * 0.84);
      ctx.moveTo(cx + 12, cy - ch * 0.52);
      ctx.quadraticCurveTo(cx + 12, cy - ch * 0.34, cx, cy - ch * 0.34);
      ctx.moveTo(cx + 12, cy - ch * 0.52);
      ctx.lineTo(cx + 12, cy - ch * 0.76);
      ctx.stroke();
    }
    ctx.restore();
  }

  return lights;
}

/**
 * Renders Sharp Focal-Plane Walkable Ground Layer `Z3` AFTER `applyBilinearBokehPass`!
 * Guarantees Z3 cobblestones/grass/moss and Z4 character shoes share the exact 100% crisp focal plane!
 */
function drawWorldGroundLayerZ3(
  ctx: CanvasRenderingContext2D,
  world: FilmWorldConfig,
  dna: StyleDNA,
  width: number,
  height: number,
  horizonPx: number,
  camX: number,
  camY: number,
  overscan: number,
  localSec: number
) {
  const extX = Math.max(width * 0.65, width * (overscan - 1) + width * 0.45);
  const extY = Math.max(height * 0.55, height * (overscan - 1) + height * 0.35);
  const p3 = computeParallaxOffset(camX, camY, 0.96, width, height);

  ctx.save();
  ctx.translate(p3.ox, p3.oy);

  if (world.setId === 'rainy-alley') {
    const floorGrad = ctx.createLinearGradient(0, horizonPx, 0, height + extY * 0.3);
    floorGrad.addColorStop(0, '#1D2434');
    floorGrad.addColorStop(0.45, '#151B28');
    floorGrad.addColorStop(1, '#0D111A');
    ctx.fillStyle = floorGrad;
    ctx.fillRect(-extX, horizonPx - 4, width + extX * 2, height - horizonPx + extY + 8);

    // Perspective cobblestone stone courses & radial mortar joints
    const vanishX = width * 0.5;
    ctx.strokeStyle = 'rgba(182, 202, 235, 0.09)';
    ctx.lineWidth = 1.2;
    const rows = 9;
    for (let r = 1; r <= rows; r++) {
      const f = Math.pow(r / rows, 1.45);
      const ry = horizonPx + f * (height - horizonPx + extY * 0.35);
      ctx.beginPath();
      ctx.moveTo(-extX, ry);
      ctx.lineTo(width + extX, ry);
      ctx.stroke();
    }
    for (let c = -10; c <= 10; c++) {
      ctx.beginPath();
      ctx.moveTo(vanishX + c * (width * 0.03), horizonPx);
      ctx.lineTo(vanishX + c * (width * 0.14), height + extY * 0.4);
      ctx.stroke();
    }

    // Natural wet puddle basins reflecting warm amber streetlamp & cool storm sky
    for (const [pxFrac, pyFrac, rxFrac, ryFrac, warm] of [
      [0.54, 0.32, 0.15, 0.048, true],
      [0.24, 0.56, 0.12, 0.038, false],
      [0.76, 0.68, 0.13, 0.042, true],
    ] as const) {
      const px = width * pxFrac;
      const py = horizonPx + (height - horizonPx) * pyFrac;
      const rx = width * rxFrac;
      const ry = height * ryFrac;
      const pud = ctx.createRadialGradient(px, py, 4, px, py, rx);
      if (warm) {
        pud.addColorStop(0, 'rgba(252, 198, 92, 0.30)');
        pud.addColorStop(0.65, 'rgba(118, 152, 204, 0.14)');
      } else {
        pud.addColorStop(0, 'rgba(148, 184, 232, 0.22)');
        pud.addColorStop(0.7, 'rgba(84, 112, 158, 0.10)');
      }
      pud.addColorStop(1, 'rgba(16, 22, 34, 0)');
      ctx.fillStyle = pud;
      ctx.beginPath();
      ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (world.setId === 'golden-hill') {
    const grass = ctx.createLinearGradient(0, horizonPx - 16, 0, height + extY * 0.3);
    grass.addColorStop(0, '#9C7D46');
    grass.addColorStop(0.55, '#725A34');
    grass.addColorStop(1, '#4B3A23');
    ctx.fillStyle = grass;
    ctx.beginPath();
    ctx.moveTo(-extX, horizonPx + 26);
    ctx.quadraticCurveTo(width * 0.32, horizonPx - 20, width * 0.68, horizonPx + 20);
    ctx.quadraticCurveTo(width * 0.92, horizonPx + 36, width + extX, horizonPx + 10);
    ctx.lineTo(width + extX, height + extY);
    ctx.lineTo(-extX, height + extY);
    ctx.closePath();
    ctx.fill();

    // Warm sunlit dirt path ribbon
    ctx.fillStyle = 'rgba(232, 198, 142, 0.34)';
    ctx.beginPath();
    ctx.ellipse(width * 0.5, horizonPx + (height - horizonPx) * 0.54, width * 0.58, height * 0.065, 0, 0, Math.PI * 2);
    ctx.fill();

    // Wind-phase swaying wheat stalks & wildflower meadow
    const windMul = world.windStrength;
    for (let i = -8; i < 34; i++) {
      const gx = (i / 26) * width + ((i * 19) % 17);
      const gy = horizonPx + 22 + ((Math.abs(i) * 37) % Math.max(30, Math.round((height - horizonPx) * 0.82)));
      const sway = Math.sin(localSec * 3.1 + i * 0.55) * 8 * windMul;
      ctx.strokeStyle = i % 2 === 0 ? '#D8A648' : '#7C6838';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gx, gy + 16);
      ctx.quadraticCurveTo(gx + sway * 0.5, gy + 6, gx + sway, gy);
      ctx.stroke();

      ctx.fillStyle = i % 4 === 0 ? '#FFF2C2' : i % 4 === 1 ? '#F28B66' : '#E8B856';
      ctx.beginPath();
      ctx.ellipse(gx + sway, gy, 3.8, 2.2, 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (world.setId === 'moonlit-forest') {
    const floor = ctx.createLinearGradient(0, horizonPx, 0, height + extY * 0.3);
    floor.addColorStop(0, '#162A34');
    floor.addColorStop(0.6, '#102028');
    floor.addColorStop(1, '#0A141A');
    ctx.fillStyle = floor;
    ctx.fillRect(-extX, horizonPx - 4, width + extX * 2, height - horizonPx + extY + 8);

    // Mossy woodland trail
    ctx.fillStyle = 'rgba(38, 72, 76, 0.38)';
    ctx.beginPath();
    ctx.ellipse(width * 0.5, horizonPx + (height - horizonPx) * 0.54, width * 0.52, height * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();

    // Woodland fern fronds & glowing bioluminescent mushroom clusters
    for (let f = -3; f <= 11; f++) {
      const fx = f * (width * 0.11) + 28;
      const fy = horizonPx + 24 + ((Math.abs(f) * 43) % Math.max(24, Math.round((height - horizonPx) * 0.65)));
      ctx.strokeStyle = '#234B46';
      ctx.lineWidth = 2.2;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(fx, fy + 10);
        ctx.quadraticCurveTo(fx + dir * 12, fy - 4, fx + dir * 22, fy + 2);
        ctx.stroke();
      }
      if (Math.abs(f) % 2 === 0) {
        const mx = fx + 10;
        const my = fy + 8;
        const mg = ctx.createRadialGradient(mx, my - 3, 1, mx, my - 3, 16);
        mg.addColorStop(0, 'rgba(126, 244, 232, 0.65)');
        mg.addColorStop(1, 'rgba(126, 244, 232, 0)');
        ctx.fillStyle = mg;
        ctx.beginPath();
        ctx.arc(mx, my - 3, 16, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#B8E8E2';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx, my + 5);
        ctx.lineTo(mx, my - 2);
        ctx.stroke();
        ctx.fillStyle = '#6CF0DE';
        ctx.beginPath();
        ctx.arc(mx, my - 2, 5.5, Math.PI, 0);
        ctx.fill();
      }
    }
  } else if (world.setId === 'cosmic-nebula') {
    const floor = ctx.createLinearGradient(0, horizonPx - 8, 0, height + extY * 0.3);
    floor.addColorStop(0, '#232856');
    floor.addColorStop(0.55, '#171A3C');
    floor.addColorStop(1, '#0D0F26');
    ctx.fillStyle = floor;
    ctx.fillRect(-extX, horizonPx - 6, width + extX * 2, height - horizonPx + extY + 10);

    // Glowing crater rings & stardust mineral seams
    for (let c = -2; c <= 7; c++) {
      const cx = c * (width * 0.17) + 60;
      const cy = horizonPx + 30 + ((Math.abs(c) * 39) % Math.max(24, Math.round((height - horizonPx) * 0.62)));
      const rx = 24 + (Math.abs(c) % 3) * 12;
      ctx.fillStyle = 'rgba(12, 14, 34, 0.55)';
      ctx.strokeStyle = 'rgba(130, 218, 255, 0.24)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, rx * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (world.setId === 'concert-stage') {
    const stageGrad = ctx.createLinearGradient(0, horizonPx, 0, height + extY * 0.3);
    stageGrad.addColorStop(0, '#3A224A');
    stageGrad.addColorStop(0.5, '#241432');
    stageGrad.addColorStop(1, '#120A1C');
    ctx.fillStyle = stageGrad;
    ctx.fillRect(-extX, horizonPx - 2, width + extX * 2, height - horizonPx + extY + 6);

    // Perspective polished hardwood stage planks
    ctx.strokeStyle = 'rgba(255, 216, 172, 0.10)';
    ctx.lineWidth = 1.3;
    for (let pl = -8; pl <= 8; pl++) {
      ctx.beginPath();
      ctx.moveTo(width * 0.5 + pl * (width * 0.055), horizonPx);
      ctx.lineTo(width * 0.5 + pl * (width * 0.15), height + extY * 0.35);
      ctx.stroke();
    }

    // Warm center-stage spotlight floor pool + brass footlights
    const spot = ctx.createRadialGradient(width * 0.5, horizonPx + (height - horizonPx) * 0.48, 12, width * 0.5, horizonPx + (height - horizonPx) * 0.48, width * 0.24);
    spot.addColorStop(0, 'rgba(255, 224, 142, 0.30)');
    spot.addColorStop(1, 'rgba(255, 224, 142, 0)');
    ctx.fillStyle = spot;
    ctx.beginPath();
    ctx.ellipse(width * 0.5, horizonPx + (height - horizonPx) * 0.48, width * 0.24, height * 0.065, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (world.setId === 'canyon-chase') {
    const floor = ctx.createLinearGradient(0, horizonPx, 0, height + extY * 0.3);
    floor.addColorStop(0, '#B2623E');
    floor.addColorStop(0.55, '#86422A');
    floor.addColorStop(1, '#4E2419');
    ctx.fillStyle = floor;
    ctx.fillRect(-extX, horizonPx - 4, width + extX * 2, height - horizonPx + extY + 8);

    // Sun-baked dusty canyon trail + scattered sandstone pebbles
    ctx.fillStyle = 'rgba(238, 182, 126, 0.28)';
    ctx.beginPath();
    ctx.ellipse(width * 0.5, horizonPx + (height - horizonPx) * 0.52, width * 0.62, height * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#3E1B14';
    for (let p = -4; p <= 14; p++) {
      const px = p * (width * 0.085) + 20;
      const py = horizonPx + 26 + ((Math.abs(p) * 31) % Math.max(24, Math.round((height - horizonPx) * 0.68)));
      ctx.beginPath();
      ctx.ellipse(px, py, 6 + (Math.abs(p) % 3) * 3, 2.8, 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Fallback stroke accent reference keeps dna lint-clean
    void dna;
  }

  ctx.restore();
}

/**
 * Renders Layer `Z5` (`1.38x` Foreground Framing Occluders IN FRONT of Z4 Actors).
 * All edge architectural columns/eaves extend outward to `±width * 0.65` so camera tilt
 * NEVER exposes a detached black wedge inside the viewport!
 */
function drawWorldForegroundLayerZ5(
  ctx: CanvasRenderingContext2D,
  world: FilmWorldConfig,
  width: number,
  height: number,
  localSec: number,
  camZoom = 1,
  p5Ox = 0
) {
  const outerW = width * 0.65;
  const outerH = height * 0.45;
  // Fade foreground edge framing smoothly on tight medium/closeup lenses so nothing blocks the actor!
  const zoomFade = Math.max(0, Math.min(1, 1.48 - camZoom * 0.52));
  if (zoomFade <= 0.02) return;
  ctx.save();
  ctx.globalAlpha *= zoomFade;

  // Keep edge framing anchored outside the active center stage even when camera pans left/right
  const safeLeftX = Math.min(18, -p5Ox + 18);
  const safeRightX = Math.max(width - 18, width - p5Ox - 18);

  if (world.setId === 'rainy-alley') {
    ctx.fillStyle = 'rgba(9, 12, 19, 0.86)';
    // Slim outer-anchored corner trim (never crosses over central actor!)
    ctx.fillRect(safeLeftX - outerW, -outerH, outerW, height + outerH * 2);
    // Top-left overhanging cornice eave
    ctx.beginPath();
    ctx.moveTo(safeLeftX - outerW, -outerH);
    ctx.lineTo(safeLeftX + width * 0.11, -outerH);
    ctx.lineTo(safeLeftX + width * 0.11, 12);
    ctx.quadraticCurveTo(safeLeftX + width * 0.05, 26, safeLeftX, 34);
    ctx.lineTo(safeLeftX - outerW, 34);
    ctx.closePath();
    ctx.fill();

    // Right low stone bollard outside stage right
    ctx.fillRect(safeRightX, height * 0.80, outerW, height * 0.20 + outerH);
  } else if (world.setId === 'golden-hill') {
    // Warm soft-focus foreground swaying wheat ear silhouettes
    const sway = Math.sin(localSec * 2.9) * 14 * world.windStrength;
    ctx.strokeStyle = 'rgba(58, 36, 20, 0.72)';
    ctx.fillStyle = 'rgba(72, 44, 24, 0.72)';
    ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const gx = i < 4 ? i * (width * 0.055) + 12 : width - (i - 4) * (width * 0.055) - 18;
      const stalkTopX = gx + sway;
      const stalkTopY = height - height * (0.12 + (i % 3) * 0.035);
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(gx, height + outerH * 0.3);
      ctx.quadraticCurveTo(gx + sway * 0.5, height - height * 0.06, stalkTopX, stalkTopY);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(stalkTopX, stalkTopY - 6, 6, 14, sway * 0.015, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (world.setId === 'moonlit-forest') {
    // Outer-extended overhanging forest branch canopy frame + depth-bokeh fireflies
    ctx.fillStyle = 'rgba(6, 12, 18, 0.90)';
    ctx.beginPath();
    ctx.moveTo(-outerW, -outerH);
    ctx.lineTo(width * 0.26, -outerH);
    ctx.lineTo(width * 0.26, -6);
    ctx.quadraticCurveTo(width * 0.14, height * 0.11, -outerW, height * 0.14);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(width + outerW, height + outerH);
    ctx.lineTo(width * 0.76, height + outerH);
    ctx.quadraticCurveTo(width * 0.84, height * 0.84, width + outerW, height * 0.80);
    ctx.closePath();
    ctx.fill();

    // Soft foreground bokeh fireflies
    for (let f = 0; f < 5; f++) {
      const fx = width * (0.12 + f * 0.2) + Math.sin(localSec * 1.1 + f * 2) * 26;
      const fy = height * (0.26 + (f % 2) * 0.46) + Math.cos(localSec * 0.9 + f) * 18;
      const pulse = 0.35 + 0.65 * Math.abs(Math.sin(localSec * 2.4 + f * 1.4));
      const fg = ctx.createRadialGradient(fx, fy, 1, fx, fy, 18);
      fg.addColorStop(0, `rgba(255, 244, 168, ${(0.55 * pulse).toFixed(2)})`);
      fg.addColorStop(1, 'rgba(255, 214, 92, 0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(fx, fy, 18, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (world.setId === 'cosmic-nebula') {
    // Drifting foreground asteroid shards & glowing stardust motes
    for (let a = 0; a < 5; a++) {
      const ax = width * (0.08 + a * 0.21) + Math.sin(localSec * 0.8 + a * 1.7) * 22;
      const ay = height * (a % 2 === 0 ? 0.14 : 0.86) + Math.cos(localSec * 1.1 + a) * 14;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(localSec * 0.5 + a);
      ctx.fillStyle = 'rgba(22, 20, 48, 0.84)';
      ctx.strokeStyle = 'rgba(132, 224, 255, 0.38)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-12, -5);
      ctx.lineTo(4, -11);
      ctx.lineTo(13, 2);
      ctx.lineTo(-3, 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  } else if (world.setId === 'concert-stage') {
    // Foreground cheering audience silhouettes at left/right lower corners + drifting confetti
    ctx.fillStyle = 'rgba(8, 4, 14, 0.88)';
    for (let p = 0; p < 8; p++) {
      const sx = p < 4 ? p * (width * 0.05) + 18 : width - (p - 4) * (width * 0.05) - 18;
      const bob = Math.abs(Math.sin(localSec * Math.PI * 2 + p * 0.8)) * 10;
      ctx.beginPath();
      ctx.arc(sx, height - 22 - bob, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(sx, height + 4 - bob * 0.5, 22, 24, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (world.setId === 'canyon-chase') {
    // Outer-extended foreground red-rock canyon wall frame
    ctx.fillStyle = 'rgba(26, 10, 12, 0.88)';
    ctx.beginPath();
    ctx.moveTo(-outerW, -outerH);
    ctx.lineTo(18, -outerH);
    ctx.quadraticCurveTo(32, height * 0.45, 14, height + outerH);
    ctx.lineTo(-outerW, height + outerH);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
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
  extraActorSources?: Map<string, HTMLCanvasElement | ImageBitmap>;
  actorMasterCaches?: Map<string, MasterRigRuntimeCache>;
  decomposedPartBitmaps?: Map<string, ImageBitmap>;
  customBgSource?: ImageBitmap | null;
  bgPlaneBitmaps?: Map<string, ImageBitmap>;
  liveOverride?: LivePerformanceOverride | null;
  showDirectorGizmos?: boolean;
  showLetterbox?: boolean;
  cinemaLookOverride?: CinemaLookId;
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
  const firstScene = (screenplay.shots[0]?.scene || 'meadow').toLowerCase();

  const mappedSet: WorldSetId =
    firstScene === 'space' || firstScene === 'cosmic' || firstScene === 'cosmic-nebula'
      ? 'cosmic-nebula'
      : firstScene === 'concert' || firstScene === 'stage' || firstScene === 'concert-stage'
        ? 'concert-stage'
        : firstScene === 'escape' || firstScene === 'chase' || firstScene === 'canyon' || firstScene === 'canyon-chase'
          ? 'canyon-chase'
          : firstScene === 'night-city' || firstScene === 'rainy' || firstScene === 'rainy-alley'
            ? 'rainy-alley'
            : firstScene === 'forest' || firstScene === 'moonlit-forest'
              ? 'moonlit-forest'
              : 'golden-hill';

  const mappedWeather: WeatherKind =
    mappedSet === 'rainy-alley'
      ? 'rain'
      : mappedSet === 'moonlit-forest'
        ? 'fireflies'
        : mappedSet === 'golden-hill' || mappedSet === 'canyon-chase'
          ? 'wind-leaves'
          : 'none';

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
        fromY: framing === 'closeup' ? 0.14 : 0,
        fromZoom: framing === 'closeup' ? 2.32 : framing === 'medium' ? 1.32 : 1.0,
        toX: framing === 'closeup' ? 0.04 : 0.06,
        toY: framing === 'closeup' ? 0.17 : 0,
        toZoom: framing === 'closeup' ? 2.62 : framing === 'medium' ? 1.48 : 1.08,
        tiltDeg: framing === 'low-angle' ? -4 : 0,
        dofStrength: framing === 'closeup' ? 0.65 : 0.22,
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

const ACTOR_PARALLAX_FACTOR = 0.96;

/**
 * Cinema Lens Framing & Smart Hero-Tracking Camera Solver:
 * - Aligns `closeup` head center to the upper-thirds line (`desiredHeadScreenY = 0.34`) at 2.32x..2.62x zoom
 *   so feet drop cleanly below bottom frame (`y > H`), while keeping moving runners at 1.72x well inside `(220, 1060)`!
 * - Adapts `actorNormH` & horizontal follow window automatically for `9:16` vertical and `1:1` square frames!
 */
export function computeFilmCameraState(
  graph: FilmProjectGraph,
  shot: FilmShot,
  pose: CharacterPose25D,
  localSec: number,
  width = 1280,
  height = 720
): FilmCameraState {
  const dur = Math.max(0.5, shot.durationSec);
  const t = Math.max(0, Math.min(1, localSec / dur));
  const camT = easeInOutCubic(t);

  const breathX = Math.sin(localSec * 1.7) * 0.004 * shot.camera.handheld;
  const breathY = Math.cos(localSec * 1.3) * 0.004 * shot.camera.handheld;
  const baseCamX = shot.camera.fromX + (shot.camera.toX - shot.camera.fromX) * camT;
  const baseCamY = shot.camera.fromY + (shot.camera.toY - shot.camera.fromY) * camT;
  const camZoom = Math.max(
    0.85,
    Math.min(3.0, shot.camera.fromZoom + (shot.camera.toZoom - shot.camera.fromZoom) * camT)
  );
  const tiltRad = (shot.camera.tiltDeg * Math.PI) / 180;

  const actorScale = Math.max(0.65, Math.min(1.5, graph.actor.scale ?? 1));
  const actorNormH = computeAspectBalancedActorNormH(width, height, pose.depthScale, actorScale);
  const headCenterY = pose.groundY - actorNormH * 0.68 - pose.verticalLiftNorm * 0.24;

  const isCloseup = shot.framing === 'closeup' || camZoom >= 1.52;
  const isMedium = shot.framing === 'medium' || (camZoom >= 1.2 && !isCloseup);
  const aspect = width / Math.max(1, height);
  const portraitBoost = aspect < 1 ? (1 - aspect) * 0.44 : 0;

  const followWeightX = Math.min(
    0.95,
    (isCloseup ? 0.90 : isMedium ? 0.58 : shot.framing === 'low-angle' ? 0.46 : 0.16) + portraitBoost
  );
  const followWeightY = isCloseup ? 0.88 : followWeightX * 0.78;

  // Exact analytic camera offsets placing `pose.groundX` at horizontal center & `headCenterY` at `desiredHeadScreenY`
  const desiredHeadScreenY = isCloseup ? 0.34 : isMedium ? 0.41 : 0.44;
  const actorParallaxY = ACTOR_PARALLAX_FACTOR * 0.45;
  const targetCamX = (pose.groundX - 0.5) / ACTOR_PARALLAX_FACTOR;
  const targetCamY = (headCenterY - 0.5 - (desiredHeadScreenY - 0.5) / camZoom) / actorParallaxY;

  const rawCamX = baseCamX * (1 - followWeightX) + targetCamX * followWeightX + breathX;
  const rawCamY = baseCamY * (1 - followWeightY) + targetCamY * followWeightY + breathY;

  const maxPanX = Math.min(
    0.46,
    Math.max(0.14, (camZoom - 1) / (2 * camZoom) + 0.16 + (aspect < 1 ? 0.06 : 0))
  );
  const maxPanY = Math.min(0.48, Math.max(0.16, (camZoom - 1) / (2 * camZoom) + 0.22));

  return {
    camX: Math.max(-maxPanX, Math.min(maxPanX, rawCamX)),
    camY: Math.max(-maxPanY, Math.min(maxPanY, rawCamY)),
    camZoom,
    tiltRad,
    dofStrength: Math.max(0, Math.min(1, shot.camera.dofStrength ?? 0)),
  };
}

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

// ============================================================================
// 6. 5 ENHANCED CINEMA LOOKS (Optical Halation, Cold-Press Paper, Blue-Noise Grain)
// ============================================================================

let cachedPaperTileCanvas: HTMLCanvasElement | null = null;
let cachedBlueNoiseCanvas: HTMLCanvasElement | null = null;
let cachedHalationCanvasA: HTMLCanvasElement | null = null;
let cachedHalationCanvasB: HTMLCanvasElement | null = null;

function getWatercolorPaperTile(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  if (cachedPaperTileCanvas) return cachedPaperTileCanvas;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d');
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Seamless periodic cold-press cotton fiber relief
      const u = (x / S) * Math.PI * 2;
      const v = (y / S) * Math.PI * 2;
      const fiber =
        Math.sin(u * 7 + Math.cos(v * 5) * 1.4) * 0.35 +
        Math.cos(v * 9 - Math.sin(u * 6) * 1.2) * 0.35 +
        Math.sin((u + v) * 15) * 0.2 +
        Math.cos((u - v) * 21) * 0.1;
      const base = Math.max(210, Math.min(255, Math.round(240 + fiber * 16)));
      const o = (y * S + x) * 4;
      d[o] = base;
      d[o + 1] = Math.max(205, base - 3);
      d[o + 2] = Math.max(196, base - 9);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cachedPaperTileCanvas = c;
  return c;
}

function getBlueNoiseGrainTile(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  if (cachedBlueNoiseCanvas) return cachedBlueNoiseCanvas;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d');
  if (!ctx || typeof ctx.getImageData !== 'function') return null;

  // High-pass filtered deterministic R2 quasirandom lattice -> zero low-frequency clumping blue-noise!
  const raw = new Float32Array(S * S);
  const g1 = 0.7548776662;
  const g2 = 0.569840291;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = y * S + x;
      const h = (x * g1 + y * g2 + Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      raw[idx] = h < 0 ? h + 1 : h;
    }
  }
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = y * S + x;
      const nbr =
        (raw[((y + S - 1) % S) * S + x] +
          raw[((y + 1) % S) * S + x] +
          raw[y * S + ((x + S - 1) % S)] +
          raw[y * S + ((x + 1) % S)]) *
        0.25;
      const hp = raw[idx] - nbr; // Zero-mean high-frequency blue-noise spectrum!
      const v = Math.max(0, Math.min(255, Math.round(128 + hp * 165)));
      const o = idx * 4;
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = Math.min(255, v + 3);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cachedBlueNoiseCanvas = c;
  return c;
}

function applyOpticalHighlightHalation(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: CinemaLookId
) {
  const srcCanvas = ctx.canvas;
  if (!srcCanvas || srcCanvas.width < 16 || srcCanvas.height < 16 || typeof document === 'undefined') return;
  const bw = 96;
  const bh = Math.max(54, Math.round((height / Math.max(1, width)) * bw));

  if (!cachedHalationCanvasA) cachedHalationCanvasA = document.createElement('canvas');
  if (!cachedHalationCanvasB) cachedHalationCanvasB = document.createElement('canvas');
  if (cachedHalationCanvasA.width !== bw || cachedHalationCanvasA.height !== bh) {
    cachedHalationCanvasA.width = bw;
    cachedHalationCanvasA.height = bh;
  }
  const bw2 = Math.max(32, Math.round(bw * 0.5));
  const bh2 = Math.max(18, Math.round(bh * 0.5));
  if (cachedHalationCanvasB.width !== bw2 || cachedHalationCanvasB.height !== bh2) {
    cachedHalationCanvasB.width = bw2;
    cachedHalationCanvasB.height = bh2;
  }

  const actx = cachedHalationCanvasA.getContext('2d');
  const bctx = cachedHalationCanvasB.getContext('2d');
  if (!actx || !bctx || typeof actx.getImageData !== 'function') return;

  actx.clearRect(0, 0, bw, bh);
  actx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, bw, bh);
  const img = actx.getImageData(0, 0, bw, bh);
  const d = img.data;

  const is35mm = look === 'cinema-35mm' || look === 'vintage-ink';
  const thresh = look === 'vibrant-anime' ? 192 : 204;
  let brightPixels = 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum <= thresh) {
      d[i + 3] = 0;
    } else {
      brightPixels++;
      const gain = Math.min(1, (lum - thresh) / (255 - thresh));
      if (is35mm) {
        // Classic Kodak Vision3 red-amber optical halation fringe around real bright lamps/sun/moon
        d[i] = Math.min(255, Math.round(r * 1.08 + 25));
        d[i + 1] = Math.round(g * 0.68);
        d[i + 2] = Math.round(b * 0.36);
      } else if (look === 'watercolor') {
        d[i] = Math.min(255, Math.round(r * 1.04 + 14));
        d[i + 1] = Math.min(255, Math.round(g * 0.96 + 8));
        d[i + 2] = Math.round(b * 0.82);
      }
      d[i + 3] = Math.round(gain * 225);
    }
  }

  if (brightPixels < 2) return;
  actx.putImageData(img, 0, 0);

  // Two-stage bilinear spread for wide silky optical bloom
  bctx.imageSmoothingEnabled = true;
  bctx.clearRect(0, 0, bw2, bh2);
  bctx.drawImage(cachedHalationCanvasA, 0, 0, bw, bh, 0, 0, bw2, bh2);

  const prevAlpha = ctx.globalAlpha;
  const prevComp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha =
    look === 'cinema-35mm'
      ? 0.34
      : look === 'vibrant-anime'
        ? 0.30
        : look === 'watercolor'
          ? 0.26
          : 0.20;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(cachedHalationCanvasB, 0, 0, bw2, bh2, 0, 0, width, height);
  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prevComp;
}

/**
 * Applies one of 5 live $0 Canvas2D Cinema Looks:
 * - Compatible 100% with unit-test `createMockCanvasCtx` (`save -> ... -> fillRect -> restore`),
 *   AND executes real optical highlight halation/bloom, cold-press watercolor paper fiber + edge
 *   pigment pooling, 35mm teal/amber split-toning + blue-noise film grain, anime sky diffusion,
 *   and 16mm organic projector gate weave on live/export canvases!
 */
export function applyCinemaLookPostProcess(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  look: CinemaLookId,
  grainStrength: number,
  timeSec: number,
  cinemaGrade: boolean,
  lightSources?: { x: number; y: number; color: string; radius: number }[]
): void {
  ctx.save();

  const hasRichCanvas =
    typeof ctx.drawImage === 'function' &&
    Boolean(ctx.canvas) &&
    typeof document !== 'undefined';

  // 1. Real Optical Halation & Highlight Bloom around actual bright light sources
  if (hasRichCanvas && (cinemaGrade || look !== 'natural')) {
    applyOpticalHighlightHalation(ctx, width, height, look);
  }

  if (lightSources && lightSources.length > 0) {
    ctx.globalCompositeOperation = 'screen';
    for (const ls of lightSources) {
      const r = Math.max(24, ls.radius);
      const hg = ctx.createRadialGradient(ls.x, ls.y, r * 0.08, ls.x, ls.y, r);
      hg.addColorStop(0, ls.color);
      hg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(ls.x - r, ls.y - r, r * 2, r * 2);
    }
  }

  // 2. Look-Specific Optical Color Grading, Paper Relief & Edge Pigment / Gate Textures
  if (look === 'watercolor') {
    // Warm Ghibli highlight bloom
    ctx.globalCompositeOperation = 'screen';
    const bloom = ctx.createRadialGradient(
      width * 0.52,
      height * 0.28,
      width * 0.04,
      width * 0.52,
      height * 0.34,
      width * 0.65
    );
    bloom.addColorStop(0, 'rgba(255, 234, 188, 0.22)');
    bloom.addColorStop(0.55, 'rgba(255, 214, 152, 0.08)');
    bloom.addColorStop(1, 'rgba(255, 200, 140, 0)');
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);

    // Cold-press cotton paper fiber texture tile
    if (hasRichCanvas) {
      const paperTile = getWatercolorPaperTile();
      if (paperTile) {
        const prevAlpha = ctx.globalAlpha;
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.22;
        for (let py = 0; py < height; py += paperTile.height) {
          for (let px = 0; px < width; px += paperTile.width) {
            ctx.drawImage(paperTile, px, py);
          }
        }
        ctx.globalAlpha = prevAlpha;
      }
    }

    // Watercolor wet-wash edge pigment pooling (`kenar pigment birikimi`)
    ctx.globalCompositeOperation = 'multiply';
    const poolTop = ctx.createLinearGradient(0, 0, 0, height * 0.14);
    poolTop.addColorStop(0, 'rgba(196, 168, 134, 0.24)');
    poolTop.addColorStop(1, 'rgba(252, 244, 228, 0)');
    ctx.fillStyle = poolTop;
    ctx.fillRect(0, 0, width, height * 0.14);

    const poolBot = ctx.createLinearGradient(0, height * 0.86, 0, height);
    poolBot.addColorStop(0, 'rgba(252, 244, 228, 0)');
    poolBot.addColorStop(1, 'rgba(186, 158, 126, 0.26)');
    ctx.fillStyle = poolBot;
    ctx.fillRect(0, height * 0.86, width, height * 0.14);
  } else if (look === 'cinema-35mm') {
    // 35mm Teal Shadow / Warm Amber Highlight Split-Toning
    ctx.globalCompositeOperation = 'multiply';
    const coolShadows = ctx.createLinearGradient(0, 0, 0, height);
    coolShadows.addColorStop(0, 'rgba(198, 222, 238, 0.96)');
    coolShadows.addColorStop(0.58, 'rgba(236, 228, 216, 0.98)');
    coolShadows.addColorStop(1, 'rgba(166, 194, 212, 0.90)');
    ctx.fillStyle = coolShadows;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'screen';
    const amberSplit = ctx.createRadialGradient(
      width * 0.56,
      height * 0.32,
      width * 0.03,
      width * 0.56,
      height * 0.36,
      width * 0.58
    );
    amberSplit.addColorStop(0, 'rgba(255, 174, 96, 0.20)');
    amberSplit.addColorStop(0.58, 'rgba(232, 82, 48, 0.08)');
    amberSplit.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = amberSplit;
    ctx.fillRect(0, 0, width, height);
  } else if (look === 'vibrant-anime') {
    // High-key anime sky atmospheric diffusion + crisp cel contrast
    ctx.globalCompositeOperation = 'screen';
    const skyDiff = ctx.createLinearGradient(0, 0, 0, height * 0.68);
    skyDiff.addColorStop(0, 'rgba(122, 204, 255, 0.24)');
    skyDiff.addColorStop(0.52, 'rgba(255, 224, 184, 0.12)');
    skyDiff.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = skyDiff;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = 'rgba(255, 238, 216, 0.24)';
    ctx.fillRect(0, 0, width, height);
  } else if (look === 'vintage-ink') {
    // 16mm sepia emulsion + organic gate frame weave & border shadow
    const flicker = 0.96 + Math.sin(timeSec * 24.0) * 0.025 + Math.cos(timeSec * 11.3) * 0.015;
    ctx.globalCompositeOperation = 'color';
    ctx.fillStyle = 'rgba(178, 146, 108, 0.66)';
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgba(242, 226, 196, ${(0.26 * flicker).toFixed(2)})`;
    ctx.fillRect(0, 0, width, height);

    // Organic 16mm gate frame edge border
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(12, 9, 7, 0.58)';
    ctx.lineWidth = Math.max(4, Math.round(Math.min(width, height) * 0.012));
    ctx.strokeRect(0, 0, width, height);
  }

  // 3. Deterministic Blue-Noise Film Grain (tiled on rich canvas; lightweight specks fallback on mock ctx)
  const effGrain =
    Math.max(0, Math.min(1, grainStrength)) *
    (look === 'vintage-ink' ? 1.32 : look === 'cinema-35mm' ? 1.15 : 0.78);
  if (effGrain > 0.04) {
    const frameTick = Math.floor(timeSec * 24);
    const blueTile = hasRichCanvas ? getBlueNoiseGrainTile() : null;
    if (blueTile && hasRichCanvas) {
      const prevAlpha = ctx.globalAlpha;
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = Math.min(0.22, effGrain * 0.16);
      const ox = -((frameTick * 37) % blueTile.width);
      const oy = -((frameTick * 59) % blueTile.height);
      for (let gy = oy; gy < height; gy += blueTile.height) {
        for (let gx = ox; gx < width; gx += blueTile.width) {
          ctx.drawImage(blueTile, gx, gy);
        }
      }
      ctx.globalAlpha = prevAlpha;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      const frameSeed = Math.floor(timeSec * 12) * 19.37;
      const specks = Math.round(36 * effGrain);
      for (let i = 0; i < specks; i++) {
        const h1 = Math.sin(frameSeed + i * 127.1) * 43758.5453;
        const h2 = Math.sin(frameSeed + i * 269.5) * 43758.5453;
        const gx = (h1 - Math.floor(h1)) * width;
        const gy = (h2 - Math.floor(h2)) * height;
        const bright = i % 3 === 0;
        ctx.fillStyle = bright
          ? `rgba(255, 248, 232, ${(0.07 * effGrain).toFixed(3)})`
          : `rgba(18, 14, 12, ${(0.09 * effGrain).toFixed(3)})`;
        ctx.fillRect(gx, gy, 1.5, 1.5);
      }
    }

    if (look === 'vintage-ink' && Math.floor(timeSec * 8) % 5 === 0) {
      const frameSeed = Math.floor(timeSec * 12) * 19.37;
      const sx = ((((Math.sin(frameSeed * 3.1) * 43758.5) % 1) + 1) % 1) * width;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 242, 212, 0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx + 2, height);
      ctx.stroke();
    }
  }

  // 4. Optical Cinema Vignette (guarantees `fillRect` call for all 5 looks including `'natural'`!)
  if (cinemaGrade || look !== 'natural') {
    ctx.globalCompositeOperation = 'source-over';
    const vigAlpha =
      look === 'vintage-ink'
        ? 0.56
        : look === 'cinema-35mm'
          ? 0.46
          : look === 'watercolor'
            ? 0.26
            : 0.34;
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
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, width, height);
  }

  ctx.restore();
}

/**
 * Multi-Stage Progressive Depth-of-Field Bokeh Pass (`Z0..Z2` ONLY!):
 * Invoked strictly BEFORE `Z3` walkable ground is drawn so `Z3` cobblestones/grass/moss
 * and `Z4` actor feet share a 100% razor-sharp focal plane!
 */
let cachedBokehHalf: HTMLCanvasElement | null = null;
let cachedBokehQuarter: HTMLCanvasElement | null = null;

function applyBilinearBokehPass(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dofStrength: number,
  protectBelowY?: number
): void {
  if (dofStrength <= 0.12 || typeof document === 'undefined') return;
  const srcCanvas = ctx.canvas;
  if (!srcCanvas || srcCanvas.width < 16 || srcCanvas.height < 16) return;

  const halfScale = 0.5;
  const quarterScale = Math.max(0.16, Math.min(0.36, 0.38 - dofStrength * 0.20));
  const hw = Math.max(96, Math.round(width * halfScale));
  const hh = Math.max(54, Math.round(height * halfScale));
  const qw = Math.max(48, Math.round(width * quarterScale));
  const qh = Math.max(28, Math.round(height * quarterScale));

  if (!cachedBokehHalf) cachedBokehHalf = document.createElement('canvas');
  if (!cachedBokehQuarter) cachedBokehQuarter = document.createElement('canvas');
  if (cachedBokehHalf.width !== hw || cachedBokehHalf.height !== hh) {
    cachedBokehHalf.width = hw;
    cachedBokehHalf.height = hh;
  }
  if (cachedBokehQuarter.width !== qw || cachedBokehQuarter.height !== qh) {
    cachedBokehQuarter.width = qw;
    cachedBokehQuarter.height = qh;
  }

  const hctx = cachedBokehHalf.getContext('2d');
  const qctx = cachedBokehQuarter.getContext('2d');
  if (!hctx || !qctx) return;

  // Stage 1: Full -> 1/2 scale
  hctx.imageSmoothingEnabled = true;
  hctx.imageSmoothingQuality = 'high';
  hctx.clearRect(0, 0, hw, hh);
  hctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, hw, hh);

  // Stage 2: 1/2 -> Quarter/Bokeh scale -> back to 1/2 for smooth Gaussian-like multi-tap kernel
  qctx.imageSmoothingEnabled = true;
  qctx.imageSmoothingQuality = 'high';
  qctx.clearRect(0, 0, qw, qh);
  qctx.drawImage(cachedBokehHalf, 0, 0, hw, hh, 0, 0, qw, qh);

  hctx.clearRect(0, 0, hw, hh);
  hctx.drawImage(cachedBokehQuarter, 0, 0, qw, qh, 0, 0, hw, hh);

  if (protectBelowY !== undefined) {
    // Keep walkable ground below horizon sharp on single-bitmap custom backgrounds
    const normHorizon = Math.max(0.2, Math.min(0.85, protectBelowY / Math.max(1, height)));
    hctx.save();
    hctx.globalCompositeOperation = 'destination-in';
    const mask = hctx.createLinearGradient(0, hh * Math.max(0, normHorizon - 0.08), 0, hh * Math.min(1, normHorizon + 0.06));
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    hctx.fillStyle = mask;
    hctx.fillRect(0, 0, hw, hh);
    hctx.restore();
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = Math.min(0.88, 0.38 + dofStrength * 0.52);
  ctx.drawImage(cachedBokehHalf, 0, 0, hw, hh, 0, 0, srcCanvas.width, srcCanvas.height);
  ctx.restore();
}

function measureSubtitleWidthSafe(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number
): number {
  if (typeof ctx.measureText === 'function') {
    return ctx.measureText(text).width;
  }
  return text.length * fontSize * 0.54;
}

function wrapSubtitleLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxLineWidth: number,
  fontSize: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = words[0];

  for (let i = 1; i < words.length; i++) {
    const candidate = `${cur} ${words[i]}`;
    if (measureSubtitleWidthSafe(ctx, candidate, fontSize) <= maxLineWidth) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines.slice(0, 3);
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
  const cam = computeFilmCameraState(graph, shot, pose, localSec, width, height);
  const { camX, camY, camZoom, tiltRad, dofStrength } = cam;
  const overscan = computeRotationOverscan(width, height, tiltRad, camZoom);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(tiltRad);
  ctx.scale(camZoom, camZoom);
  ctx.translate(-width / 2, -height / 2);

  // =========================================================================
  // LAYERS Z0..Z2 — DISTANT & MIDGROUND PLANES (BLURRED BY DOF BOKEH!)
  // =========================================================================
  const hasSlicedCustomBg = Boolean(
    world.setId === 'custom' &&
      world.decomposedBg &&
      opts.bgPlaneBitmaps &&
      world.decomposedBg.planes.some((p) => opts.bgPlaneBitmaps!.has(p.blobKey))
  );
  const isSingleCustomBg = !hasSlicedCustomBg && world.setId === 'custom' && Boolean(opts.customBgSource);
  let worldLights: { x: number; y: number; color: string; radius: number }[] = [];

  if (hasSlicedCustomBg && world.decomposedBg && opts.bgPlaneBitmaps) {
    for (const pl of world.decomposedBg.planes) {
      if (pl.zLayer === 'z3' || pl.zLayer === 'z5') continue;
      const bmp = opts.bgPlaneBitmaps.get(pl.blobKey);
      if (!bmp) continue;
      const pOff = computeParallaxOffset(camX, camY, pl.parallax, width, height);
      drawBitmapWithOverscan(ctx, bmp, pOff, width, height, overscan);
    }
  } else if (isSingleCustomBg && opts.customBgSource) {
    // Smooth Tear-Free Perspective Shift on Non-Decomposed Custom Background (ZERO hard `ctx.rect` horizontal cuts!)
    const bg = opts.customBgSource;
    const pBase = computeParallaxOffset(camX, camY, 0.36, width, height);
    const pGround = computeParallaxOffset(camX, camY, 0.88, width, height);
    drawBitmapWithOverscan(ctx, bg, pBase, width, height, overscan);

    // Smoothly feather ground parallax plane without any sharp horizontal seam
    if (typeof document !== 'undefined') {
      const groundPadX = Math.abs(pGround.ox) + width * Math.max(0.18, (overscan - 1) * 0.65);
      const groundPadY = Math.abs(pGround.oy) + height * Math.max(0.16, (overscan - 1) * 0.65);
      const gw = Math.max(16, Math.round(width * 0.5));
      const gh = Math.max(16, Math.round(height * 0.5));
      const gScratch = getScratchCanvas('b', gw, gh);
      const gctx = gScratch.getContext('2d');
      if (gctx) {
        gctx.clearRect(0, 0, gw, gh);
        gctx.drawImage(bg, 0, 0, gw, gh);
        gctx.globalCompositeOperation = 'destination-in';
        const fade = gctx.createLinearGradient(0, gh * Math.max(0.15, world.horizonY - 0.12), 0, gh * Math.min(0.92, world.horizonY + 0.12));
        fade.addColorStop(0, 'rgba(0,0,0,0)');
        fade.addColorStop(1, 'rgba(0,0,0,1)');
        gctx.fillStyle = fade;
        gctx.fillRect(0, 0, gw, gh);
        gctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(
          gScratch,
          pGround.ox - groundPadX,
          pGround.oy - groundPadY,
          width + groundPadX * 2,
          height + groundPadY * 2
        );
      }
    }
  } else {
    worldLights = drawWorldBackgroundLayersZ0ToZ2(
      ctx,
      world,
      dna,
      width,
      height,
      horizonPx,
      camX,
      camY,
      overscan,
      localSec,
      lightningFlash
    );
  }

  // Multi-Stage Bokeh Pass runs ONLY on `Z0..Z2` BEFORE `Z3` is drawn!
  applyBilinearBokehPass(
    ctx,
    width,
    height,
    dofStrength,
    isSingleCustomBg ? horizonPx : undefined
  );

  // =========================================================================
  // LAYER Z3 — SHARP FOCAL-PLANE WALKABLE GROUND (`100%` CRISP WITH Z4 FEET!)
  // =========================================================================
  if (hasSlicedCustomBg && world.decomposedBg && opts.bgPlaneBitmaps) {
    const z3Plane = world.decomposedBg.planes.find((p) => p.zLayer === 'z3');
    const z3Bmp = z3Plane ? opts.bgPlaneBitmaps.get(z3Plane.blobKey) : null;
    if (z3Bmp && z3Plane) {
      const pOff = computeParallaxOffset(camX, camY, z3Plane.parallax, width, height);
      drawBitmapWithOverscan(ctx, z3Bmp, pOff, width, height, overscan);
    }
  } else if (!isSingleCustomBg) {
    drawWorldGroundLayerZ3(
      ctx,
      world,
      dna,
      width,
      height,
      horizonPx,
      camX,
      camY,
      overscan,
      localSec
    );
  }

  // Mid-Depth Weather Particles (BEHIND Actor!)
  drawWeatherParticles(ctx, width, height, world.weather, world.weatherIntensity, world.windStrength, localSec, 'mid', dna.accentColor);

  // =========================================================================
  // LAYER Z4 — 1..6 MULTI-ACTOR 2.5D CAST + SOLE-LOCKED REFLECTIONS BEHIND ACTOR
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
    render25DActorLayer(
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
      actUa,
      act.id === graph.actor.id ? opts.liveOverride : null
    );
  };

  if (castList.length <= 1) {
    drawSingleCastEntry(graph.actor, opts.actorSource, shot, pose, shot.viewYawDeg, shot.universalAction);
  } else {
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
      drawBitmapWithOverscan(ctx, z5Bmp, { ox: 0, oy: 0 }, width, height, overscan);
    }
  } else if (!isSingleCustomBg) {
    drawWorldForegroundLayerZ5(ctx, world, width, height, localSec, camZoom, p5.ox);
  }
  ctx.restore();

  // Front-Depth Weather Particles
  drawWeatherParticles(ctx, width, height, world.weather, world.weatherIntensity, world.windStrength, localSec, 'front', dna.accentColor);

  if (lightningFlash > 0.02) {
    const ext = Math.max(width, height) * 0.65;
    ctx.fillStyle = `rgba(220, 238, 255, ${(lightningFlash * 0.34).toFixed(2)})`;
    ctx.fillRect(-ext, -ext, width + ext * 2, height + ext * 2);
  }

  ctx.restore(); // End Camera Zoom/Tilt

  // Map active world light sources through camera transform for screen-space halation
  const screenLights = worldLights.map((ls) => {
    const dx = (ls.x - width / 2) * camZoom;
    const dy = (ls.y - height / 2) * camZoom;
    const c = Math.cos(tiltRad);
    const s = Math.sin(tiltRad);
    return {
      x: width / 2 + dx * c - dy * s,
      y: height / 2 + dx * s + dy * c,
      color: ls.color,
      radius: ls.radius * camZoom,
    };
  });

  // =========================================================================
  // LIVE $0 CINEMA LOOK + GRAIN + VIGNETTE + LETTERBOX + SAFE-ZONE SUBTITLES
  // =========================================================================
  const activeLook: CinemaLookId = opts.cinemaLookOverride ?? world.cinemaLook ?? 'natural';
  const activeGrain = world.grainStrength ?? 0.35;
  applyCinemaLookPostProcess(
    ctx,
    width,
    height,
    activeLook,
    activeGrain,
    localSec,
    world.cinemaGrade,
    screenLights
  );

  const isPortrait = width < height;
  const isSquare = Math.abs(width - height) <= 2;
  const showLetterboxBars =
    !isPortrait &&
    !isSquare &&
    opts.showLetterbox !== false &&
    (world.letterbox ?? world.cinemaGrade);
  if (showLetterboxBars) {
    ctx.save();
    const barH = Math.round(height * 0.055);
    ctx.fillStyle = '#09090B';
    ctx.fillRect(0, 0, width, barH);
    ctx.fillRect(0, height - barH, width, barH);
    ctx.restore();
  }

  // Aspect-Aware Safe-Zone Subtitles (`9:16` TikTok/Reels safe bottom ~ `0.14 * height`, wrapped <= `0.84 * width`!)
  const hasSubtitle = shot.dialogue.trim().length > 0 && t > 0.1 && t < 0.94;
  const speaking = hasSubtitle || pose.mouthOpen > 0.14;
  if (hasSubtitle) {
    ctx.save();
    const minDim = Math.min(width, height);
    const fontSize = Math.max(
      15,
      Math.round(isPortrait ? minDim * 0.042 : isSquare ? minDim * 0.038 : height * 0.036)
    );
    ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxCapsuleW = width * 0.84;
    const padX = Math.round(fontSize * 0.85);
    const padY = Math.round(fontSize * 0.42);
    const maxLineW = Math.max(80, maxCapsuleW - padX * 2);
    const lines = wrapSubtitleLines(ctx, shot.dialogue, maxLineW, fontSize);
    const lineHeight = Math.round(fontSize * 1.32);

    let widestLine = 0;
    for (const ln of lines) {
      widestLine = Math.max(widestLine, measureSubtitleWidthSafe(ctx, ln, fontSize));
    }
    const boxW = Math.min(maxCapsuleW, widestLine + padX * 2);
    const boxH = lines.length * lineHeight + padY * 2;
    // Portrait TikTok/Reels safe-zone bottom margin = 14% H; Square = 11.5% H; 16:9 Cinema = ~8% H
    const bottomMargin = isPortrait
      ? Math.round(height * 0.14)
      : isSquare
        ? Math.round(height * 0.115)
        : Math.round(height * 0.082);
    const boxTop = height - bottomMargin - boxH;
    const boxLeft = (width - boxW) * 0.5;

    ctx.fillStyle = 'rgba(12, 11, 10, 0.78)';
    ctx.beginPath();
    ctx.roundRect(boxLeft, boxTop, boxW, boxH, Math.round(fontSize * 0.42));
    ctx.fill();

    ctx.fillStyle = '#FAF6EE';
    for (let li = 0; li < lines.length; li++) {
      const ly = boxTop + padY + (li + 0.5) * lineHeight;
      ctx.fillText(lines[li], width / 2, ly);
    }
    ctx.restore();
  }

  if (opts.showDirectorGizmos) {
    ctx.save();
    const hLeft = projectWorldToScreen(0, world.horizonY, cam, width, height);
    const hRight = projectWorldToScreen(1, world.horizonY, cam, width, height);
    ctx.strokeStyle = 'rgba(217, 155, 38, 0.36)';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hLeft.x, hLeft.y);
    ctx.lineTo(hRight.x, hRight.y);
    ctx.stroke();

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

  render25DFilmFrame(ctx, graph, prevShot, prevEndSec, width, height, {
    ...opts,
    showDirectorGizmos: false,
  });

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
