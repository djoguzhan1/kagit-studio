import { describe, expect, it } from 'vitest';
import {
  applyPinEditToFrames,
  cleanWhitePaperRGBA,
  createAnatomyMeshPins,
  createPinTemplate,
  generateMeshPresetFrames,
} from '../meshWarpEngine';
import { defaultDrawingAnatomy } from '../cartoonMotionEngine';
import {
  generateMotionPresetKeyframes,
  wouldCreateBoneCycle,
} from '../puppetEngine';
import { TRANSLATIONS, type TranslationKey } from '../../i18n/translations';
import type { PuppetPart, PuppetRig } from '../../types/studio';

describe('Canlı Kukla Studio — Legendary Overhaul Regression Suite', () => {
  it('1. prevents self-loops, direct A<->B cycles, and deep A->B->C->A circular bone parenting', () => {
    const parts: PuppetPart[] = [
      { id: 'torso', name: 'Gövde', parentId: null, blobKey: 'b1', x: 0, y: 0, w: 100, h: 120, pivotX: 50, pivotY: 60, zIndex: 1 },
      { id: 'head', name: 'Baş', parentId: 'torso', blobKey: 'b2', x: 10, y: -80, w: 80, h: 80, pivotX: 40, pivotY: 75, zIndex: 2 },
      { id: 'hat', name: 'Bere', parentId: 'head', blobKey: 'b3', x: 10, y: -110, w: 70, h: 35, pivotX: 35, pivotY: 30, zIndex: 3 },
      { id: 'arm', name: 'Sağ Kol', parentId: null, blobKey: 'b4', x: 90, y: 10, w: 40, h: 80, pivotX: 5, pivotY: 10, zIndex: 4 },
    ];

    // Self-parenting MUST be blocked
    expect(wouldCreateBoneCycle(parts, 'torso', 'torso')).toBe(true);
    // Direct A <-> B cycle (torso -> head when head -> torso) MUST be blocked
    expect(wouldCreateBoneCycle(parts, 'torso', 'head')).toBe(true);
    // Deep A -> B -> C -> A cycle (torso -> hat when hat -> head -> torso) MUST be blocked
    expect(wouldCreateBoneCycle(parts, 'torso', 'hat')).toBe(true);
    // Valid re-parenting (arm -> torso or arm -> head or head -> null) MUST be allowed
    expect(wouldCreateBoneCycle(parts, 'arm', 'torso')).toBe(false);
    expect(wouldCreateBoneCycle(parts, 'arm', 'head')).toBe(false);
    expect(wouldCreateBoneCycle(parts, 'head', null)).toBe(false);
  });

  it('2. strips bright white paper backgrounds cleanly while keeping ink & colored strokes opaque', () => {
    const w = 16;
    const h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const isInk = x >= 6 && x <= 10 && y >= 5 && y <= 11;
        const isRedScarf = x >= 6 && x <= 10 && y === 8;
        if (isRedScarf) {
          rgba[o] = 229; rgba[o + 1] = 77; rgba[o + 2] = 46; rgba[o + 3] = 255;
        } else if (isInk) {
          rgba[o] = 28; rgba[o + 1] = 25; rgba[o + 2] = 23; rgba[o + 3] = 255;
        } else {
          // Bright white sketchbook paper
          rgba[o] = 248; rgba[o + 1] = 245; rgba[o + 2] = 236; rgba[o + 3] = 255;
        }
      }
    }

    const stripped = cleanWhitePaperRGBA(rgba, w, h);
    expect(stripped).toBe(true);
    // Corner paper pixel becomes transparent
    expect(rgba[(1 * w + 1) * 4 + 3]).toBe(0);
    // Ink & red scarf remain 100% opaque
    expect(rgba[(6 * w + 8) * 4 + 3]).toBe(255);
    expect(rgba[(8 * w + 8) * 4 + 3]).toBe(255);
  });

  it('3. applies manual pin drag either to a single frame or propagated smoothly across the full loop', () => {
    const pins = createPinTemplate('humanoid');
    const headId = pins.find((p) => p.role === 'head')!.id;
    const baseFrames = generateMeshPresetFrames(pins, 12, 'breathe');

    const single = applyPinEditToFrames(baseFrames, 12, 3, headId, 0.25, -0.15, 'single');
    expect(single[3][headId].dx).toBeCloseTo(0.25, 3);
    expect(single[0][headId].dx).toBeCloseTo(baseFrames[0][headId].dx, 4);

    const all = applyPinEditToFrames(baseFrames, 12, 3, headId, 0.25, -0.15, 'all');
    const expectedDeltaX = 0.25 - baseFrames[3][headId].dx;
    expect(all[3][headId].dx).toBeCloseTo(0.25, 3);
    expect(all[0][headId].dx).toBeCloseTo(baseFrames[0][headId].dx + expectedDeltaX, 3);
    expect(all[11][headId].dx).toBeCloseTo(baseFrames[11][headId].dx + expectedDeltaX, 3);
  });

  it('4. keeps cutout bounce preset head seated cleanly without extreme neck separation', () => {
    const rig: PuppetRig = {
      id: 'r_test',
      name: 'Test',
      sourceBlobKey: 's1',
      sourceW: 400,
      sourceH: 500,
      totalFrames: 24,
      parts: [
        { id: 'root', name: 'Gövde', parentId: null, blobKey: 'b1', x: 100, y: 200, w: 120, h: 160, pivotX: 60, pivotY: 120, zIndex: 1 },
        { id: 'head', name: 'Baş', parentId: 'root', blobKey: 'b2', x: 110, y: 90, w: 100, h: 110, pivotX: 50, pivotY: 100, zIndex: 2 },
      ],
      keyframes: [],
    };
    const kfs = generateMotionPresetKeyframes(rig, 'bounce');
    expect(kfs.length).toBe(5);
    // Squash keyframe seats head snugly downward slightly (+dy) instead of leaving neck gap
    expect(kfs[1].transforms['head'].dy).toBeGreaterThan(0);
  });

  it('5. enforces 100% TR/EN parity and zero forbidden engineering jargon across all puppet* keys', () => {
    const keys = Object.keys(TRANSLATIONS.tr).filter((k) =>
      k.startsWith('puppet')
    ) as TranslationKey[];
    expect(keys.length).toBeGreaterThan(85);

    const forbidden = [/\brms\b/i, /line\s*boil/i, /\bpişir/i, /2\.5d/i, /\(rec\)/i, /2d\s*kafes/i, /basamak\s*\(2s\)/i];
    for (const key of keys) {
      const trVal = TRANSLATIONS.tr[key];
      const enVal = TRANSLATIONS.en[key];
      expect(trVal.trim().length).toBeGreaterThan(0);
      expect(enVal.trim().length).toBeGreaterThan(0);
      for (const re of forbidden) {
        expect(trVal).not.toMatch(re);
        expect(enVal).not.toMatch(re);
      }
    }
  });

  it('6. builds 6 anatomical pins and generates non-zero walk & wave motion frames around them', () => {
    const anatomy = defaultDrawingAnatomy();
    const pins = createAnatomyMeshPins(anatomy, 'humanoid');
    expect(pins.length).toBe(6);

    const walkFrames = generateMeshPresetFrames(pins, 24, 'walk');
    const waveFrames = generateMeshPresetFrames(pins, 24, 'wave');
    const footL = pins.find((p) => p.role === 'foot-l')!;
    const handR = pins.find((p) => p.role === 'hand-r')!;

    expect(walkFrames.some((f) => (f[footL.id]?.dy ?? 0) < -0.02)).toBe(true);
    expect(waveFrames.some((f) => (f[handR.id]?.dy ?? 0) < -0.1)).toBe(true);
  });

  it('7. generates 8-beat Richard Williams cutout walk (with volume-preserving squash) and dance groove presets', () => {
    const rig: PuppetRig = {
      id: 'r_walk_dance',
      name: 'Hero',
      sourceBlobKey: 's1',
      sourceW: 400,
      sourceH: 500,
      totalFrames: 24,
      parts: [
        { id: 'root', name: 'Gövde', parentId: null, blobKey: 'b1', x: 100, y: 200, w: 120, h: 160, pivotX: 60, pivotY: 120, zIndex: 3 },
        { id: 'head', name: 'Baş', parentId: 'root', blobKey: 'b2', x: 110, y: 90, w: 100, h: 110, pivotX: 50, pivotY: 100, zIndex: 5 },
        { id: 'legL', name: 'Sol Bacak', parentId: 'root', blobKey: 'b3', x: 110, y: 340, w: 40, h: 130, pivotX: 20, pivotY: 10, zIndex: 1 },
        { id: 'legR', name: 'Sağ Bacak', parentId: 'root', blobKey: 'b4', x: 170, y: 340, w: 40, h: 130, pivotX: 20, pivotY: 10, zIndex: 2 },
        { id: 'armL', name: 'Sol Kol', parentId: 'root', blobKey: 'b5', x: 60, y: 210, w: 40, h: 110, pivotX: 35, pivotY: 15, zIndex: 4 },
        { id: 'armR', name: 'Sağ Kol', parentId: 'root', blobKey: 'b6', x: 220, y: 210, w: 40, h: 110, pivotX: 5, pivotY: 15, zIndex: 6 },
      ],
      keyframes: [],
    };
    const walkKfs = generateMotionPresetKeyframes(rig, 'walk');
    expect(walkKfs.length).toBe(9); // 8 beats + loop close!
    // Down beat includes real volume-preserving squash (scaleY < 1, scaleX > 1, dy > 0)
    expect(walkKfs[1].transforms['root'].scaleY).toBeLessThan(1);
    expect(walkKfs[1].transforms['root'].scaleX).toBeGreaterThan(1);
    expect(walkKfs[1].transforms['root'].dy).toBeGreaterThan(0);

    const danceKfs = generateMotionPresetKeyframes(rig, 'dance');
    expect(danceKfs.length).toBe(5);
    expect(danceKfs[1].transforms['root'].dx).toBeLessThan(0);
    expect(danceKfs[3].transforms['root'].dx).toBeGreaterThan(0);
  });
});
