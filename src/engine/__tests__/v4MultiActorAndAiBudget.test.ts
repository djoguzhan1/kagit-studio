import { describe, expect, it } from 'vitest';
import {
  alignViewToReferenceRGBA,
  applyStyleLockFilterRGBA,
  assignItemsToViewAngles,
  extractViewAnchorsRGBA,
  splitMultiPoseSheetRGBA,
} from '../turnaroundSlicer';
import { resolve25DViewBlend } from '../viewRigBlender';
import {
  applyDirectedScreenplayToFilmGraph,
  compileDirectorPromptToFilmGraph,
  DIRECTOR_PRESETS,
  getGraphActors,
  sortActorsByGroundDepth,
} from '../film25dEngine';
import { TRANSLATIONS, type TranslationKey } from '../../i18n/translations';
import workerDefault, {
  AI_DAILY_FREE_NEURONS,
  AI_MODEL_DIRECTOR,
  AI_MODEL_SIDE_GUIDE,
  AI_MONTHLY_HARD_CAP_USD,
  checkAiBudgetAndQuota,
  computeBillableUsdForCall,
} from '../../../worker/index.js';
import type { FilmActor } from '../../types/film';

function fillSolidWhitePaper(w: number, h: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 250;
    rgba[i * 4 + 1] = 247;
    rgba[i * 4 + 2] = 240;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function drawPersonPose(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  topY: number,
  botY: number,
  color: [number, number, number]
) {
  const bh = Math.max(20, botY - topY);
  const bw = bh * 0.36;
  const paintRect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(w - 1, Math.ceil(x1)); x++) {
        const o = (y * w + x) * 4;
        rgba[o] = color[0];
        rgba[o + 1] = color[1];
        rgba[o + 2] = color[2];
        rgba[o + 3] = 255;
      }
    }
  };
  // Head + torso + two legs
  paintRect(cx - bw * 0.34, topY, cx + bw * 0.34, topY + bh * 0.24);
  paintRect(cx - bw * 0.48, topY + bh * 0.24, cx + bw * 0.48, topY + bh * 0.62);
  paintRect(cx - bw * 0.42, topY + bh * 0.62, cx - bw * 0.08, botY);
  paintRect(cx + bw * 0.08, topY + bh * 0.62, cx + bw * 0.42, botY);
}

describe('Phase 2-5 V4: 360° 2.5D Turnaround, Multi-Actor Cast, $19 Budget Breaker & Zero-Jargon UI', () => {
  it('1. splits A4 multi-pose sheets (3-pose horizontal & 4-pose 2x2) and calibrates heights to 0.0px match', () => {
    // 3-pose horizontal sheet with deliberately uneven drawing heights!
    const w = 360;
    const h = 180;
    const sheet = fillSolidWhitePaper(w, h);
    drawPersonPose(sheet, w, h, 65, 22, 158, [35, 32, 30]); // Tall front
    drawPersonPose(sheet, w, h, 180, 46, 148, [45, 42, 40]); // Shorter side
    drawPersonPose(sheet, w, h, 295, 16, 166, [30, 28, 28]); // Taller back

    const res3 = splitMultiPoseSheetRGBA(sheet, w, h, { targetSize: 160 });
    expect(res3.detectedCount).toBe(3);
    expect(res3.layout).toBe('horizontal');
    expect(res3.poses.map((p) => p.angle)).toEqual(['front', 'side', 'back']);

    // Verify ALL 3 angles now match headTopV and soleV within 1.5% (sub-pixel calibration!)
    const refTop = res3.poses[0].anchors.headTopV;
    const refSole = res3.poses[0].anchors.soleV;
    for (const pose of res3.poses) {
      expect(Math.abs(pose.anchors.headTopV - refTop)).toBeLessThan(0.02);
      expect(Math.abs(pose.anchors.soleV - refSole)).toBeLessThan(0.02);
      // Verify paper margins were stripped to transparent alpha === 0
      expect(pose.rgba[3]).toBe(0);
    }

    // 4-pose 2x2 grid sheet
    const gw = 260;
    const gh = 260;
    const grid = fillSolidWhitePaper(gw, gh);
    drawPersonPose(grid, gw, gh, 65, 20, 110, [30, 30, 30]);
    drawPersonPose(grid, gw, gh, 195, 26, 108, [30, 30, 30]);
    drawPersonPose(grid, gw, gh, 65, 142, 238, [30, 30, 30]);
    drawPersonPose(grid, gw, gh, 195, 150, 232, [30, 30, 30]);

    const res4 = splitMultiPoseSheetRGBA(grid, gw, gh, { targetSize: 128 });
    expect(res4.detectedCount).toBe(4);
    expect(res4.layout).toBe('grid2x2');
    expect(res4.poses.map((p) => p.angle)).toEqual(['front', 'threeQuarter', 'side', 'back']);

    // Direct 5-line anchor aligner accuracy check
    const rawA = new Uint8ClampedArray(120 * 120 * 4);
    drawPersonPose(rawA, 120, 120, 60, 12, 110, [25, 25, 25]);
    const refA = extractViewAnchorsRGBA(rawA, 120, 120);
    const rawB = new Uint8ClampedArray(120 * 120 * 4);
    drawPersonPose(rawB, 120, 120, 52, 34, 96, [25, 25, 25]);
    const alignedB = alignViewToReferenceRGBA(rawB, 120, 120, refA, 120, 120);
    expect(Math.abs(alignedB.anchors.headTopV - refA.headTopV)).toBeLessThan(0.025);
    expect(Math.abs(alignedB.anchors.soleV - refA.soleV)).toBeLessThan(0.025);
  });

  it('2. locks optional AI guide pixels into the artist original drawing color palette (zero plastic sheen)', () => {
    const w = 64;
    const h = 64;
    // Artist original: warm sepia brown & dark charcoal ink
    const artist = new Uint8ClampedArray(w * h * 4);
    drawPersonPose(artist, w, h, 32, 8, 56, [120, 78, 44]);

    // Glossy synthetic neon magenta AI output
    const aiRaw = new Uint8ClampedArray(w * h * 4);
    drawPersonPose(aiRaw, w, h, 32, 8, 56, [255, 20, 220]);

    const locked = applyStyleLockFilterRGBA(aiRaw, w, h, artist, w, h, 0.85);
    // Inspect a center opaque pixel — blue channel must drop dramatically from 220 toward artist's warm 44!
    const midOff = (32 * w + 32) * 4;
    expect(locked[midOff + 3]).toBe(255);
    expect(locked[midOff + 2]).toBeLessThan(95);
    expect(locked[midOff]).toBeGreaterThan(locked[midOff + 2]);
  });

  it('3. blends 360° 2.5D angles smoothly with auto-mirrored left side, safe foreshortening & continuous light-shift', () => {
    const all4 = ['front', 'threeQuarter', 'side', 'back'] as const;

    const front0 = resolve25DViewBlend(0, [...all4]);
    expect(front0.primary.angle).toBe('front');
    expect(front0.primary.opacity).toBe(1);
    expect(front0.isBackFacing).toBe(false);

    const q45 = resolve25DViewBlend(45, [...all4]);
    expect(q45.primary.angle).toBe('threeQuarter');
    expect(q45.primary.mirrorX).toBe(false);

    const sideR = resolve25DViewBlend(90, [...all4]);
    expect(sideR.primary.angle).toBe('side');
    expect(sideR.primary.mirrorX).toBe(false);
    expect(sideR.lightShiftX).toBeCloseTo(1, 3);

    const sideL = resolve25DViewBlend(-90, [...all4]);
    expect(sideL.primary.angle).toBe('side');
    expect(sideL.primary.mirrorX).toBe(true);
    expect(sideL.lightShiftX).toBeCloseTo(-1, 3);

    const back180 = resolve25DViewBlend(180, [...all4]);
    expect(back180.primary.angle).toBe('back');
    expect(back180.isBackFacing).toBe(true);

    // Every degree around the full 360° circle must maintain opacity sum = 1 and squashX >= 0.78!
    for (let deg = -180; deg <= 180; deg += 7) {
      const b = resolve25DViewBlend(deg, [...all4]);
      const opSum = b.primary.opacity + (b.secondary?.opacity ?? 0);
      expect(opSum).toBeCloseTo(1.0, 4);
      expect(b.primary.squashX).toBeGreaterThanOrEqual(0.78);
      if (b.secondary) {
        expect(b.secondary.squashX).toBeGreaterThanOrEqual(0.78);
      }
    }
  });

  it('4. supports 1-6 multi-actor cast Z-sorting, legacy single-actor migration & AI screenplay compilation', () => {
    const legacy = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
    expect(getGraphActors(legacy)).toHaveLength(1);

    // Build 7 actors and verify strict max-6 cap + lead always index 0
    const extraActors: FilmActor[] = Array.from({ length: 6 }, (_, i) => ({
      ...legacy.actor,
      id: `cast-${i + 2}`,
      name: `Yaratık ${i + 2}`,
      creatureClass: i === 0 ? 'quadruped' : i === 1 ? 'avian_winged' : 'biped_tailed',
    }));
    const bigGraph = { ...legacy, actors: [legacy.actor, ...extraActors] };
    const cast = getGraphActors(bigGraph);
    expect(cast).toHaveLength(6);
    expect(cast[0].id).toBe(legacy.actor.id);

    // Painter's depth sorting: smaller groundY (farther back) renders FIRST
    const sorted = sortActorsByGroundDepth([
      { id: 'front', groundY: 0.89 },
      { id: 'back', groundY: 0.71 },
      { id: 'mid', groundY: 0.80 },
    ]);
    expect(sorted.map((s) => s.id)).toEqual(['back', 'mid', 'front']);

    // Convert live Llama 3.3 70B screenplay JSON cleanly to multi-actor shots
    const directed = applyDirectedScreenplayToFilmGraph(
      {
        title: 'Orman Macerası',
        shots: [
          {
            title: 'Karşılaşma',
            durationSec: 3.5,
            scene: 'forest',
            camera: 'wide',
            transition: 'dissolve',
            primaryActorId: cast[0].id,
            narration: 'Kedi ile kuş ormanda buluşur.',
            actorTracks: {
              [cast[0].id]: {
                actorId: cast[0].id,
                action: 'walk-natural',
                emotion: 'happy',
                startX: 0.2,
                endX: 0.45,
                groundY: 0.82,
                viewYawDeg: 45,
                lookAtActorId: cast[1].id,
                dialogue: 'Merhaba dostum!',
              },
              [cast[1].id]: {
                actorId: cast[1].id,
                action: 'pounce-leap',
                emotion: 'surprised',
                startX: 0.72,
                endX: 0.62,
                groundY: 0.79,
                viewYawDeg: -90,
                lookAtActorId: cast[0].id,
                dialogue: 'Miyav!',
              },
            },
          },
        ],
      },
      bigGraph
    );
    expect(directed.shots).toHaveLength(1);
    expect(directed.world.setId).toBe('moonlit-forest');
    expect(directed.shots[0].actorTracks?.[cast[1].id]?.universalAction).toBe('pounce-leap');
    expect(directed.shots[0].actorTracks?.[cast[0].id]?.lookAtActorId).toBe(cast[1].id);
    expect(directed.shots[0].dialogue).toBe('Merhaba dostum!');
  });

  it('5. enforces $19.00 HARD monthly Cloudflare AI cap, 10,000 daily free Neurons, CSRF & bans klein-4b', async () => {
    // Verify model safety constants (klein-4b is strictly banned on characters!)
    expect(AI_MODEL_DIRECTOR).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(AI_MODEL_SIDE_GUIDE).toBe('@cf/black-forest-labs/flux-2-klein-9b');
    expect(AI_MODEL_SIDE_GUIDE).not.toContain('4b');
    expect(AI_MONTHLY_HARD_CAP_USD).toBeLessThan(20.0);

    // 10,000 free daily Neurons cushion costs $0.00!
    expect(computeBillableUsdForCall(0, 1410)).toBe(0);
    expect(computeBillableUsdForCall(8000, 1999)).toBe(0);
    // Crossing 10,000 bills ONLY the excess above 10,000 at $0.011 / 1k!
    expect(computeBillableUsdForCall(AI_DAILY_FREE_NEURONS, 1000)).toBeCloseTo(0.011, 5);

    // Mock D1 returning $18.99 spent this month & 12,000 Neurons already used today
    const makeMockEnv = (monthUsd: number, todayNeurons: number, actorCnt: number) => ({
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => {
              if (sql.includes('SUM(cost_usd)')) return { total_usd: monthUsd };
              if (sql.includes('SUM(neurons)')) return { total_neurons: todayNeurons };
              return { cnt: actorCnt };
            },
          }),
        }),
      },
    });

    // Side guide ($0.0155) at $18.99 MUST trip HARD $19.00 circuit breaker!
    const blocked = await checkAiBudgetAndQuota(
      makeMockEnv(18.99, 12_000, 0),
      'ip:test',
      false,
      'side_guide',
      1410
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('budget_capped');

    // Guest daily fair limit (3 side guides/day) MUST block 4th call!
    const dailyBlocked = await checkAiBudgetAndQuota(
      makeMockEnv(1.2, 2000, 3),
      'ip:test',
      false,
      'side_guide',
      1410
    );
    expect(dailyBlocked.allowed).toBe(false);
    expect(dailyBlocked.reason).toBe('daily_limit');

    // Same-Origin CSRF guard MUST reject cross-origin POST to /api/ai/direct-film with HTTP 403!
    const crossReq = new Request('https://inktrope.com/api/ai/direct-film', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'kedi koşsun' }),
    });
    const csrfRes = await workerDefault.fetch(crossReq, {}, {});
    expect(csrfRes.status).toBe(403);
  });

  it('6. enforces 100% TR/EN parity and zero forbidden engineering jargon across ALL V4 UI keys', () => {
    const v4Keys = Object.keys(TRANSLATIONS.tr).filter((k) => k.startsWith('v4')) as TranslationKey[];
    expect(v4Keys.length).toBeGreaterThan(35);
    const forbidden = [/\byaw\b/i, /\bwebgl\b/i, /\bmesh\b/i, /\bneuron\b/i, /\bjson\b/i, /\bpipeline\b/i];
    for (const k of v4Keys) {
      const tr = TRANSLATIONS.tr[k];
      const en = TRANSLATIONS.en[k];
      expect(tr.trim().length).toBeGreaterThan(0);
      expect(en.trim().length).toBeGreaterThan(0);
      for (const re of forbidden) {
        expect(tr).not.toMatch(re);
        expect(en).not.toMatch(re);
      }
    }
  });

  it('7. smartly maps batch 2-4 uploaded photo filenames (TR/EN & unnamed) to 2.5D angles', () => {
    const trNamed = assignItemsToViewAngles([
      { name: 'kedi_arka.jpg' },
      { name: 'kedi_ön.png' },
      { name: 'kedi_yan_profil.jpg' },
      { name: 'kedi_3-4.webp' },
    ]);
    expect(trNamed.map((x) => `${x.angle}:${x.item.name}`)).toEqual([
      'front:kedi_ön.png',
      'side:kedi_yan_profil.jpg',
      'back:kedi_arka.jpg',
      'threeQuarter:kedi_3-4.webp',
    ]);

    const unnamed = assignItemsToViewAngles([
      { name: 'IMG_1021.jpg' },
      { name: 'IMG_1022.jpg' },
      { name: 'IMG_1023.jpg' },
    ]);
    expect(unnamed.map((x) => x.angle)).toEqual(['front', 'side', 'back']);

    // Adding only side + back onto an existing character keeps Front untouched when requireFront=false!
    const secondaryOnly = assignItemsToViewAngles(
      [{ name: 'karakter_yan.png' }, { name: 'karakter_arka.png' }],
      { requireFront: false, preferEmptyAngles: ['side', 'back', 'threeQuarter'] }
    );
    expect(secondaryOnly.map((x) => x.angle)).toEqual(['side', 'back']);
  });
});
