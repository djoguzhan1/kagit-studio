import { describe, expect, it } from 'vitest';
import { collectAllReferencedBlobKeys } from '../db';
import { buildZipBlob, parseZipBytes } from '../zipBuilder';
import { applyEasing, generateMotionPresetKeyframes } from '../puppetEngine';
import { rmsToMouthViseme } from '../audioEngine';
import {
  buildMedianCutPalette,
  detectPaperCorners,
  sliceGridCells,
  smartFloodFill,
} from '../paperWorker';
import {
  computeDeformedMeshGrid,
  createPinTemplate,
  deformPoint,
  generateMeshPresetFrames,
  smoothRecordedMeshFrames,
} from '../meshWarpEngine';
import { applyRgbaRect, extractRgbaRect } from '../canvasEngine';
import { evaluateCameraAtFrame } from '../cameraEngine';
import { drawKagitSealStamp } from '../exportEngine';
import {
  compileDirectorPromptToFilmGraph,
  deform25DRigidVertex,
  evaluateCharacterPose25D,
  extractStyleDNAFromPixels,
  patchShotFromRevisionPrompt,
  resolveFilmTimeline,
} from '../film25dEngine';
import { computeDepthAndNormalRGBA } from '../kagit25dPipeline';
import {
  analyzePCMToLipSyncTrack,
  calibratePoseBaseline,
  extractPoseSampleFromFrameRGBA,
  sampleMotionCaptureTrack,
  sampleVoiceLipSync,
  textDialogueToViseme,
} from '../filmMocapLipSync';
import { evaluateDeterministicVerletRibbon } from '../verletPhysics';
import {
  analyzeDrawingAnatomyFromPixels,
  createAnatomyPins,
  defaultDrawingAnatomy,
  deformArticulatedVertex,
  evaluateCartoonDancePose,
  evaluateCartoonRainWalkPose,
  evaluateCartoonWorldPose,
  evaluateContinuousLimbPoint,
  evalWilliamsLeg,
  stepSpringPins,
  type CartoonMoodId,
  type SpringPinState,
  type StorybookWorldId,
} from '../cartoonMotionEngine';
import { decodeSharedStage, encodeSharedStage } from '../shareCodec';
import {
  computeGeodesicPartLabels,
  fillClosedContoursRGBA,
  solveTwoBoneIK,
} from '../skeletonSkinEngine';
import { TRANSLATIONS, translate, type TranslationKey } from '../../i18n/translations';
import type { PuppetRig, StudioProject } from '../../types/studio';

describe('KÂĞIT Studio V2 10/10 Core Engines', () => {
  it('1. protects ALL referenced blobs (scenes, backgrounds, paper originals, mesh rigs, FK rigs, audio, refs)', () => {
    const project: StudioProject = {
      id: 'p1',
      name: 'Çok Sahnelli Film',
      aspect: '16:9',
      width: 1280,
      height: 720,
      fps: 12,
      paperColor: '#F7F3E9',
      paperGrain: 0.3,
      backgroundBlobKey: 'bg_scene_1',
      frames: [
        {
          id: 'f1',
          hold: 1,
          thumbKey: 'thumb_1',
          paperOriginalBlobKey: 'orig_paper_1',
          layers: [
            {
              id: 'l1',
              name: 'Ink',
              role: 'ink',
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'multiply',
              blobKey: 'ink_1',
            },
          ],
        },
      ],
      scenes: [
        {
          id: 'sc1',
          name: 'Sahne 1',
          backgroundBlobKey: 'bg_scene_1',
          frames: [
            {
              id: 'f1',
              hold: 1,
              thumbKey: 'thumb_1',
              paperOriginalBlobKey: 'orig_paper_1',
              layers: [
                {
                  id: 'l1',
                  name: 'Ink',
                  role: 'ink',
                  visible: true,
                  locked: false,
                  opacity: 1,
                  blendMode: 'multiply',
                  blobKey: 'ink_1',
                },
              ],
            },
          ],
        },
        {
          id: 'sc2',
          name: 'Sahne 2',
          backgroundBlobKey: 'bg_scene_2',
          frames: [
            {
              id: 'f2',
              hold: 2,
              thumbKey: 'thumb_2',
              layers: [
                {
                  id: 'l2',
                  name: 'Ink 2',
                  role: 'ink',
                  visible: true,
                  locked: false,
                  opacity: 1,
                  blendMode: 'multiply',
                  blobKey: 'ink_2',
                },
              ],
            },
          ],
        },
      ],
      rigs: [
        {
          id: 'r1',
          name: 'FK Rig',
          sourceBlobKey: 'rig_src_1',
          sourceW: 400,
          sourceH: 400,
          totalFrames: 12,
          parts: [
            {
              id: 'pt1',
              name: 'Head',
              parentId: null,
              blobKey: 'rig_part_head',
              x: 0,
              y: 0,
              w: 100,
              h: 100,
              pivotX: 50,
              pivotY: 50,
              zIndex: 1,
            },
          ],
          keyframes: [],
        },
      ],
      meshRigs: [
        {
          id: 'm1',
          name: 'Mesh Hero',
          sourceBlobKey: 'mesh_src_1',
          sourceW: 600,
          sourceH: 600,
          pins: [],
          frames: [],
          totalFrames: 24,
          lineBoil: 0.3,
        },
      ],
      audio: {
        id: 'a1',
        name: 'voice.webm',
        blobKey: 'audio_blob_1',
        mimeType: 'audio/webm',
        durationSec: 2.5,
        peaks: [0.1, 0.5],
        rmsPerFrame: [0.1, 0.5],
        volume: 1,
        muted: false,
      },
      references: [
        {
          id: 'ref1',
          name: 'Model Sheet',
          blobKey: 'ref_sheet_1',
          swatches: ['#1C1917'],
        },
      ],
      palette: ['#1C1917'],
      createdAt: '',
      updatedAt: '',
    };

    const keys = collectAllReferencedBlobKeys([project]);
    for (const expected of [
      'bg_scene_1',
      'bg_scene_2',
      'thumb_1',
      'thumb_2',
      'orig_paper_1',
      'ink_1',
      'ink_2',
      'rig_src_1',
      'rig_part_head',
      'mesh_src_1',
      'audio_blob_1',
      'ref_sheet_1',
    ]) {
      expect(keys.has(expected)).toBe(true);
    }
  });

  it('2. builds and parses binary ZIP archives losslessly', async () => {
    const manifest = new TextEncoder().encode(JSON.stringify({ studio: 'KÂĞIT', ok: true }));
    const raw = new Uint8Array([1, 2, 3, 255, 128, 64, 0, 42]);
    const zipBlob = buildZipBlob([
      { name: 'manifest.json', data: manifest },
      { name: 'blobs/test.bin', data: raw },
    ]);
    const bytes = new Uint8Array(await zipBlob.arrayBuffer());
    const parsed = parseZipBytes(bytes);

    expect(parsed.has('manifest.json')).toBe(true);
    expect(parsed.has('blobs/test.bin')).toBe(true);
    expect(Array.from(parsed.get('blobs/test.bin')!)).toEqual(Array.from(raw));
  });

  it('3. evaluates puppet easing curves and generates motion presets', () => {
    expect(applyEasing(0, 'easeInOut')).toBe(0);
    expect(applyEasing(1, 'easeInOut')).toBe(1);
    expect(applyEasing(0.5, 'step')).toBe(0);
    expect(applyEasing(1, 'bounce')).toBeCloseTo(1, 3);

    const mockRig: PuppetRig = {
      id: 'r1',
      name: 'Test',
      sourceBlobKey: 's1',
      sourceW: 300,
      sourceH: 300,
      totalFrames: 24,
      parts: [
        { id: 'p_root', name: 'Gövde', parentId: null, blobKey: 'b1', x: 0, y: 0, w: 100, h: 100, pivotX: 50, pivotY: 50, zIndex: 1 },
        { id: 'p_arm', name: 'Sağ Kol', parentId: 'p_root', blobKey: 'b2', x: 80, y: 10, w: 40, h: 80, pivotX: 0, pivotY: 10, zIndex: 2 },
      ],
      keyframes: [],
    };
    const kfs = generateMotionPresetKeyframes(mockRig, 'wave');
    expect(kfs.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(kfs[1].transforms['p_arm'].rotation)).toBeGreaterThan(20);
  });

  it('4. maps audio RMS levels to distinct lip-sync mouth visemes', () => {
    expect(rmsToMouthViseme(0.05)).toBe('closed');
    expect(rmsToMouthViseme(0.24)).toBe('half');
    expect(rmsToMouthViseme(0.55, 0.1)).toBe('wide');
    expect(rmsToMouthViseme(0.75, 0.72)).toBe('round');
  });

  it('5. automatically detects bright paper sheet corners against a dark desk', () => {
    const w = 100;
    const h = 80;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const onPaper = x >= 20 && x <= 79 && y >= 15 && y <= 64;
        rgba[o] = onPaper ? 245 : 22;
        rgba[o + 1] = onPaper ? 240 : 20;
        rgba[o + 2] = onPaper ? 230 : 18;
        rgba[o + 3] = 255;
      }
    }
    const corners = detectPaperCorners({ width: w, height: h, rgba });
    expect(corners[0].x).toBeGreaterThan(0.15);
    expect(corners[0].x).toBeLessThan(0.25);
    expect(corners[2].x).toBeGreaterThan(0.74);
    expect(corners[2].y).toBeGreaterThan(0.72);
  });

  it('6. builds an adaptive Median-Cut palette preserving distinct pastel & ink tones', () => {
    const samples: [number, number, number][] = [];
    for (let i = 0; i < 60; i++) samples.push([247, 243, 233]);
    for (let i = 0; i < 60; i++) samples.push([229, 77, 46]);
    for (let i = 0; i < 60; i++) samples.push([37, 99, 235]);
    for (let i = 0; i < 60; i++) samples.push([28, 25, 23]);

    const palette = buildMedianCutPalette(samples, 16);
    expect(palette.length).toBe(256 * 3);

    const hasRed = Array.from({ length: 16 }).some((_, idx) => {
      const r = palette[idx * 3];
      const g = palette[idx * 3 + 1];
      return r > 200 && g < 110;
    });
    const hasBlue = Array.from({ length: 16 }).some((_, idx) => {
      const r = palette[idx * 3];
      const b = palette[idx * 3 + 2];
      return b > 200 && r < 90;
    });
    expect(hasRed).toBe(true);
    expect(hasBlue).toBe(true);
  });

  it('7. deforms 2D Mesh Warp points smoothly around pins and smooths recorded frames', () => {
    const pins = createPinTemplate('humanoid');
    const headPin = pins.find((p) => p.role === 'head')!;
    const rootPin = pins.find((p) => p.role === 'root')!;

    const offsets = {
      [headPin.id]: { dx: 0.1, dy: -0.08 },
      [rootPin.id]: { dx: 0, dy: 0 },
    };

    // Vertex right on head pin follows head displacement strongly
    const movedHead = deformPoint(headPin.x, headPin.y, pins, offsets);
    expect(movedHead.x - headPin.x).toBeGreaterThan(0.07);
    expect(movedHead.y - headPin.y).toBeLessThan(-0.05);

    // Full mesh grid returns (cols+1)*(rows+1) valid finite vertices
    const grid = computeDeformedMeshGrid(pins, offsets, 8, 10, 0.4, 3);
    expect(grid.length).toBe(9 * 11);
    expect(grid.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y))).toBe(true);

    const bounce = generateMeshPresetFrames(pins, 24, 'bounce');
    expect(bounce.length).toBe(24);
    const smoothed = smoothRecordedMeshFrames(bounce, pins);
    expect(smoothed.length).toBe(24);
  });

  it('8. extracts and restores Dirty-Rect Undo pixel regions with 100% fidelity', () => {
    const w = 16;
    const h = 16;
    const canvas = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      canvas[i * 4] = i % 256;
      canvas[i * 4 + 1] = 100;
      canvas[i * 4 + 2] = 200;
      canvas[i * 4 + 3] = 255;
    }

    const rect = { x: 4, y: 4, w: 6, h: 5 };
    const beforePatch = extractRgbaRect(canvas, w, rect);

    // Paint inside dirty rect
    for (let y = 5; y < 8; y++) {
      for (let x = 5; x < 9; x++) {
        const o = (y * w + x) * 4;
        canvas[o] = 229;
        canvas[o + 1] = 77;
        canvas[o + 2] = 46;
      }
    }
    expect(canvas[(6 * w + 6) * 4]).toBe(229);

    // Undo by patching ONLY the dirty rect back!
    applyRgbaRect(canvas, w, rect, beforePatch);
    expect(canvas[(6 * w + 6) * 4]).toBe((6 * w + 6) % 256);
    expect(canvas[(6 * w + 6) * 4 + 1]).toBe(100);
  });

  it('9. closes tiny hand-drawn ink gaps during Reference-Aware Smart Flood Fill', () => {
    const w = 32;
    const h = 32;
    const target = new Uint8ClampedArray(w * h * 4); // empty color layer
    const barrier = new Uint8ClampedArray(w * h * 4); // upper ink layer

    // Draw a 16x16 box in the ink layer WITH a 2px intentional hand-drawn gap on the right wall!
    for (let x = 8; x <= 24; x++) {
      barrier[(8 * w + x) * 4 + 3] = 255;
      barrier[(24 * w + x) * 4 + 3] = 255;
    }
    for (let y = 8; y <= 24; y++) {
      barrier[(y * w + 8) * 4 + 3] = 255;
      if (y !== 15 && y !== 16) {
        barrier[(y * w + 24) * 4 + 3] = 255;
      }
    }

    // With gapClosePx=2, clicking inside the box (16, 16) MUST stay contained and NOT leak to (2, 2)!
    const filled = smartFloodFill({
      width: w,
      height: h,
      targetRgba: target,
      barrierRgba: barrier,
      startX: 16,
      startY: 16,
      fillColor: [229, 77, 46, 255],
      tolerance: 25,
      expandPx: 1,
      gapClosePx: 2,
    });

    expect(filled[(16 * w + 16) * 4]).toBe(229);
    expect(filled[(16 * w + 16) * 4 + 3]).toBe(255);
    // Outside pixel (2, 2) must remain completely transparent (zero leak!)
    expect(filled[(2 * w + 2) * 4 + 3]).toBe(0);
  });

  it('10. slices a 2x2 A4 grid sheet into 4 distinct output frames with auto-centering', () => {
    const w = 80;
    const h = 60;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Put a distinct colored ink dot in each of the 4 quadrants
    const markDot = (cx: number, cy: number, r: number, g: number, b: number) => {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const o = ((cy + dy) * w + (cx + dx)) * 4;
          rgba[o] = r;
          rgba[o + 1] = g;
          rgba[o + 2] = b;
          rgba[o + 3] = 255;
        }
      }
    };
    markDot(20, 15, 220, 40, 40);
    markDot(60, 15, 40, 180, 40);
    markDot(20, 45, 40, 40, 220);
    markDot(60, 45, 220, 180, 40);

    const cells = sliceGridCells({
      width: w,
      height: h,
      rgba,
      cols: 2,
      rows: 2,
      outWidth: 40,
      outHeight: 30,
      autoCenter: true,
      transparentBg: true,
    });

    expect(cells.length).toBe(4);
    expect(cells[0].length).toBe(40 * 30 * 4);
    // Center of cell 0 should contain the red dot!
    const centerOff = (15 * 40 + 20) * 4;
    expect(cells[0][centerOff]).toBeGreaterThan(150);
    expect(cells[1][centerOff + 1]).toBeGreaterThan(140);
    expect(cells[2][centerOff + 2]).toBeGreaterThan(150);
  });

  it('11. interpolates 2D cinematic camera keyframes and applies 4-frame decaying impact shake', () => {
    const kfs = [
      { frame: 0, zoom: 1.0, panX: 0, panY: 0, tiltDeg: 0 },
      { frame: 10, zoom: 1.8, panX: 0.2, panY: -0.1, tiltDeg: 4 },
    ];
    const frames = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`,
      hold: 1,
      layers: [],
      cameraShake: i === 4 ? 2 : 0,
    }));

    const mid = evaluateCameraAtFrame(kfs, frames, 5, 1280, 720);
    expect(mid.zoom).toBeCloseTo(1.4, 2);
    expect(mid.panX).toBeCloseTo(0.1, 2);

    const hit = evaluateCameraAtFrame(kfs, frames, 4, 1280, 720);
    const decay = evaluateCameraAtFrame(kfs, frames, 6, 1280, 720);
    const settled = evaluateCameraAtFrame(kfs, frames, 9, 1280, 720);

    expect(Math.abs(hit.shakeX)).toBeGreaterThan(Math.abs(decay.shakeX));
    expect(Math.abs(decay.shakeX)).toBeGreaterThan(0);
    expect(settled.shakeX).toBe(0);
  });

  it('12. generates valid normalized pin templates for humanoid, creature, and simple rigs', () => {
    const hum = createPinTemplate('humanoid');
    const cre = createPinTemplate('creature');
    const sim = createPinTemplate('simple');
    expect(hum.length).toBe(6);
    expect(cre.length).toBe(5);
    expect(sim.length).toBe(4);
    for (const p of [...hum, ...cre, ...sim]) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1);
    }
  });

  it('13. keeps TR and EN translation dictionaries in complete non-empty parity', () => {
    const trKeys = Object.keys(TRANSLATIONS.tr) as TranslationKey[];
    const enKeys = Object.keys(TRANSLATIONS.en) as TranslationKey[];
    expect(enKeys.sort()).toEqual(trKeys.sort());
    for (const key of trKeys) {
      expect(translate('tr', key).trim().length).toBeGreaterThan(0);
      expect(translate('en', key).trim().length).toBeGreaterThan(0);
    }
  });

  it('14. renders the closing INKTROPE vermilion seal stamp cleanly via Canvas2D calls', () => {
    const calls: string[] = [];
    const mockCtx = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      translate: () => calls.push('translate'),
      rotate: () => calls.push('rotate'),
      beginPath: () => calls.push('beginPath'),
      roundRect: () => calls.push('roundRect'),
      fill: () => calls.push('fill'),
      stroke: () => calls.push('stroke'),
      fillText: (txt: string) => calls.push(`text:${txt}`),
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
    } as unknown as CanvasRenderingContext2D;

    drawKagitSealStamp(mockCtx, 1280, 720, 0.9);
    expect(calls).toContain('text:INKTROPE');
    expect(calls).toContain('text:STUDIO');
    expect(calls[0]).toBe('save');
    expect(calls[calls.length - 1]).toBe('restore');
  });

  it('15. extracts accurate StyleDNA (ink color, accent, warmth & style tag) from arbitrary RGBA pixels', () => {
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x < 4 || x > 27) {
          // Dark sumi ink borders
          rgba[i] = 24;
          rgba[i + 1] = 20;
          rgba[i + 2] = 18;
          rgba[i + 3] = 255;
        } else if (y < 16) {
          // Vibrant vermilion scarf region
          rgba[i] = 229;
          rgba[i + 1] = 77;
          rgba[i + 2] = 46;
          rgba[i + 3] = 255;
        } else {
          // Warm golden tunic
          rgba[i] = 217;
          rgba[i + 1] = 155;
          rgba[i + 2] = 38;
          rgba[i + 3] = 255;
        }
      }
    }
    const dna = extractStyleDNAFromPixels(rgba, w, h);
    expect(dna.palette.length).toBeGreaterThanOrEqual(3);
    expect(dna.warmTemp).toBeGreaterThan(0.2);
    expect(dna.lineWeightPx).toBeGreaterThanOrEqual(1.8);
    expect(dna.lineWeightPx).toBeLessThanOrEqual(5.8);
  });

  it('16. compiles Turkish natural-language director prompts into multi-shot FilmGraph IR & supports surgical revisions', () => {
    const graph = compileDirectorPromptToFilmGraph(
      "Yağmurlu akşam sokağı. Karakter soldan yorgun adımlarla girer. Yerdeki parlayan mektubu görünce şaşırır, eğilip alır. Kamera yüzüne yaklaşır, şimşek çakar, gülümseyip 'Sonunda buldum!' der."
    );
    expect(graph.world.setId).toBe('rainy-alley');
    expect(graph.world.weather).toBe('rain');
    expect(graph.shots.length).toBe(3);
    expect(graph.shots[0].framing).toBe('wide');
    expect(graph.shots[0].action).toBe('walk-tired');
    expect(graph.shots[1].prop).toBe('glowing-letter');
    expect(graph.shots[2].framing).toBe('closeup');
    expect(graph.shots[2].lightningAtSec).not.toBeNull();
    expect(graph.shots[2].dialogue).toBe('Sonunda buldum!');

    const revised = patchShotFromRevisionPrompt(graph.shots[0], "Daha yavaş, yakın çekim, şimşek çaksın ve 'Dikkat!' desin");
    expect(revised.durationSec).toBeGreaterThan(graph.shots[0].durationSec);
    expect(revised.framing).toBe('closeup');
    expect(revised.lightningAtSec).not.toBeNull();
    expect(revised.dialogue).toBe('Dikkat!');

    const tl = resolveFilmTimeline(graph.shots, graph.shots[0].durationSec + 0.5);
    expect(tl.shotIndex).toBe(1);
  });

  it('17. preserves skull rigidity & ARAP bounds during 2.5D head turns and volume-preserving jumps', () => {
    const graph = compileDirectorPromptToFilmGraph(
      'Gün batımı tepe. Karakter sevinçle zıplar ve kameraya bakar.'
    );
    const shot = { ...graph.shots[0], action: 'jump-joy' as const, headAngleX: 30, lookAt: null };
    const pose = evaluateCharacterPose25D(shot, shot.durationSec * 0.5, 0.56);

    // Volume-preserving squash & stretch: squashX * squashY === 1
    expect(pose.squashX * pose.squashY).toBeCloseTo(1, 3);
    expect(pose.verticalLiftNorm).toBeGreaterThan(0.1);

    // 2.5D projective head turn: nose (u=0.5) shifts further than ear edge (u=0.28) while staying bounded!
    const centerBefore = deform25DRigidVertex(0.5, 0.22, { ...pose, headYawRad: 0, headTiltRad: 0, bodyLeanRad: 0 }, 0.37);
    const centerTurned = deform25DRigidVertex(0.5, 0.22, { ...pose, headYawRad: 0.5, headTiltRad: 0, bodyLeanRad: 0 }, 0.37);
    const edgeTurned = deform25DRigidVertex(0.28, 0.22, { ...pose, headYawRad: 0.5, headTiltRad: 0, bodyLeanRad: 0 }, 0.37);
    expect(centerTurned.x - centerBefore.x).toBeGreaterThan(0.025);
    expect(edgeTurned.x).toBeGreaterThan(-0.22);
    expect(edgeTurned.x).toBeLessThan(1.22);
  });

  it('18. computes 2.5D cylindrical Depth Map & Sobel Tangent-Space Surface Normal Map from alpha silhouettes', () => {
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 6; y < 26; y++) {
      for (let x = 6; x < 26; x++) {
        const dx = x - 16;
        const dy = y - 16;
        if (dx * dx + dy * dy <= 81) {
          const o = (y * w + x) * 4;
          rgba[o] = 40;
          rgba[o + 1] = 36;
          rgba[o + 2] = 32;
          rgba[o + 3] = 255;
        }
      }
    }
    const { depthRgba, normalRgba } = computeDepthAndNormalRGBA(rgba, w, h);
    const centerOff = (16 * w + 16) * 4;
    const rimOff = (16 * w + 9) * 4;
    const bgOff = (1 * w + 1) * 4;

    // Center of sphere has deeper/brighter Z than rim, background stays transparent
    expect(depthRgba[centerOff]).toBeGreaterThan(depthRgba[rimOff]);
    expect(depthRgba[centerOff]).toBeGreaterThan(200);
    expect(depthRgba[bgOff + 3]).toBe(0);

    // Center normal points forward (B channel ~255, R/G ~128)
    expect(normalRgba[centerOff + 2]).toBeGreaterThan(220);
    // Left rim normal points left (R < 120)
    expect(normalRgba[rimOff]).toBeLessThan(120);
  });

  it('19. classifies real PCM voice formants into 6 Preston Blair visemes & drives shot lip-sync', () => {
    const sr = 16000;
    const segLen = Math.floor(sr * 0.25); // 0.25s per segment -> 1.0s total
    const pcm = new Float32Array(segLen * 4);

    // Segment 0 (0.00..0.25s): Silence -> 'closed'
    // Segment 1 (0.25..0.50s): Low F1 320 Hz -> 'OH' or 'OO'
    for (let i = 0; i < segLen; i++) {
      pcm[segLen + i] = Math.sin((2 * Math.PI * 320 * i) / sr) * 0.65;
    }
    // Segment 2 (0.50..0.75s): Mid F2 1150 Hz -> 'AA'
    for (let i = 0; i < segLen; i++) {
      pcm[segLen * 2 + i] = Math.sin((2 * Math.PI * 1150 * i) / sr) * 0.7;
    }
    // Segment 3 (0.75..1.00s): High fricative 3600 Hz -> 'FV'
    for (let i = 0; i < segLen; i++) {
      pcm[segLen * 3 + i] = Math.sin((2 * Math.PI * 3600 * i) / sr) * 0.55;
    }

    const track = analyzePCMToLipSyncTrack(pcm, sr, {
      audioBlobKey: 'voice_blob_1',
      label: 'Test Sesi',
      source: 'mic',
    });

    expect(track.waveform.length).toBe(48);
    expect(track.frames.length).toBeGreaterThanOrEqual(20);
    expect(sampleVoiceLipSync(track, 0.08).viseme).toBe('closed');
    expect(['OH', 'OO']).toContain(sampleVoiceLipSync(track, 0.36).viseme);
    expect(sampleVoiceLipSync(track, 0.62).viseme).toBe('AA');
    expect(sampleVoiceLipSync(track, 0.88).viseme).toBe('FV');

    // Text-to-viseme Turkish check
    expect(textDialogueToViseme('OOOO', 0.5).viseme).toBe('OH');
    expect(textDialogueToViseme('SSSS', 0.5).viseme).toBe('FV');

    // Verify evaluateCharacterPose25D prioritizes real VoiceLipSyncTrack
    const graph = compileDirectorPromptToFilmGraph('Yağmurlu akşam sokağı. Karakter yürür.');
    const voicedShot = { ...graph.shots[0], voiceTrack: track };
    const poseAtFric = evaluateCharacterPose25D(voicedShot, 0.88, 0.58);
    expect(poseAtFric.viseme).toBe('FV');
    expect(poseAtFric.mouthOpen).toBeGreaterThan(0.2);
  });

  it('20. extracts calibrated 2.5D head yaw, arm lift & jump from RGBA camera frames and interpolates MocapTrack', () => {
    const w = 96;
    const h = 72;
    const makeFrame = (headX: number, headY: number, raiseRightWing: boolean) => {
      const buf = new Uint8ClampedArray(w * h * 4);
      // Bright neutral studio backdrop
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = 248;
        buf[i * 4 + 1] = 248;
        buf[i * 4 + 2] = 248;
        buf[i * 4 + 3] = 255;
      }
      const paintCircle = (cx: number, cy: number, rad: number, r: number, g: number, b: number) => {
        for (let y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++) {
          for (let x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++) {
            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad) {
              const o = (y * w + x) * 4;
              buf[o] = r;
              buf[o + 1] = g;
              buf[o + 2] = b;
            }
          }
        }
      };
      // Warm skin-tone head circle + dark torso
      paintCircle(headX, headY, 9, 222, 168, 134);
      paintCircle(48, 52, 14, 42, 38, 36);
      if (raiseRightWing) {
        // Raised hand/arm in upper-right wing (x > 66%, y near top)
        paintCircle(80, 18, 9, 222, 168, 134);
      }
      return buf;
    };

    const neutral = makeFrame(48, 22, false);
    const baseline = calibratePoseBaseline(neutral, w, h, false);

    // Move head to the right + jump up + raise arm on right wing (non-mirrored video mode)
    const active = makeFrame(60, 14, true);
    const sample = extractPoseSampleFromFrameRGBA(active, w, h, 0.5, baseline, neutral, false);

    expect(sample.headYawRad).toBeGreaterThan(0.15);
    expect(sample.headYawRad).toBeLessThanOrEqual(0.61);
    expect(sample.verticalLiftNorm).toBeGreaterThan(0.08);
    expect(sample.rightArmSwing).toBeGreaterThan(0.3);

    const track = {
      source: 'webcam' as const,
      durationSec: 1.0,
      fps: 24,
      samples: [
        { ...sample, t: 0, headYawRad: 0, rightArmSwing: 0, verticalLiftNorm: 0 },
        { ...sample, t: 1.0 },
      ],
      createdAt: new Date().toISOString(),
      label: 'Test Mocap',
    };

    const mid = sampleMotionCaptureTrack(track, 0.5);
    expect(mid.headYawRad).toBeCloseTo(sample.headYawRad * 0.5, 3);

    // Live override takes priority cleanly over shot mocap without violating ARAP clamp
    const graph = compileDirectorPromptToFilmGraph('Gün batımı tepe. Karakter yürür.');
    const mocapShot = { ...graph.shots[0], mocapTrack: track };
    const poseWithLive = evaluateCharacterPose25D(mocapShot, 0.5, 0.56, {
      headYawRad: 1.5, // intentionally extreme -> must clamp safely to 0.61 rad!
      viseme: 'EE',
      mouthOpen: 0.8,
    });
    expect(poseWithLive.headYawRad).toBeCloseTo(0.61, 3);
    expect(poseWithLive.viseme).toBe('EE');
  });

  it('21. protects Phase-4 shot voiceTrack audio blobs inside collectAllReferencedBlobKeys GC guard', () => {
    const fg = compileDirectorPromptToFilmGraph('Yağmurlu akşam sokağı. Karakter konuşur.');
    fg.shots[0].voiceTrack = {
      audioBlobKey: 'shot_voice_blob_99',
      durationSec: 2.1,
      sampleRateHz: 24,
      frames: [],
      waveform: [],
      source: 'mic',
      label: 'Replik 1',
    };
    const project: StudioProject = {
      id: 'p_voice',
      name: 'Sesli Film',
      aspect: '16:9',
      width: 1280,
      height: 720,
      fps: 12,
      paperColor: '#F7F3E9',
      paperGrain: 0.3,
      frames: [],
      rigs: [],
      references: [],
      audio: null,
      palette: [],
      filmGraph: fg,
      createdAt: '',
      updatedAt: '',
    };
    const refs = collectAllReferencedBlobKeys([project]);
    expect(refs.has('shot_voice_blob_99')).toBe(true);
  });

  it('22. solves multi-node Verlet cloth physics with wind response, length constraints & ground collision', () => {
    const floorY = 140;
    const segLen = 10;
    const rightWind = evaluateDeterministicVerletRibbon({
      anchorX: 100,
      anchorY: 110,
      windX: 2.2,
      timeSec: 1.5,
      floorY,
      segmentLength: segLen,
      nodeCount: 8,
    });
    const leftWind = evaluateDeterministicVerletRibbon({
      anchorX: 100,
      anchorY: 110,
      windX: -2.2,
      timeSec: 1.5,
      floorY,
      segmentLength: segLen,
      nodeCount: 8,
    });

    expect(rightWind.length).toBe(8);
    // Root stays strictly pinned to neck anchor
    expect(rightWind[0].x).toBe(100);
    expect(rightWind[0].y).toBe(110);
    // Positive wind pushes tail further right than negative wind
    expect(rightWind[7].x).toBeGreaterThan(leftWind[7].x + 25);
    // Ground floor collision strictly holds for every physical node!
    for (const pt of rightWind) {
      expect(pt.y).toBeLessThanOrEqual(floorY + 0.01);
    }
    // Distance constraints prevent rubber-band stretching
    const seg0Dist = Math.hypot(rightWind[1].x - rightWind[0].x, rightWind[1].y - rightWind[0].y);
    expect(seg0Dist).toBeGreaterThan(segLen * 0.8);
    expect(seg0Dist).toBeLessThan(segLen * 1.25);
  });

  it('23. maintains V3 TR/EN i18n parity for Desk Lamp, 16mm Projector, Drawer & 2.5D Lightbox with zero legacy keys', () => {
    const trKeys = Object.keys(TRANSLATIONS.tr).sort();
    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    expect(trKeys).toEqual(enKeys);

    const requiredV3: TranslationKey[] = [
      'lampNightLabel',
      'lampDayLabel',
      'modeFilmPill',
      'filmStageHint',
      'filmOpenCta',
      'projectorTag',
      'projectorTitle',
      'projectorSub',
      'drawerHandle',
      'drawerContinue',
    ];
    for (const k of requiredV3) {
      expect(translate('tr', k).length).toBeGreaterThan(1);
      expect(translate('en', k).length).toBeGreaterThan(1);
    }

    // Legacy removed keys must never linger in the dictionary
    const dict = TRANSLATIONS.tr as Record<string, string>;
    expect(dict['filmBannerTitle']).toBeUndefined();
    expect(dict['pocketTitle']).toBeUndefined();
  });

  it('24. guarantees zero AI jargon or internal system leaks across all TR/EN user-facing translations', () => {
    const forbidden = /\b(gemini|cuda|rtx|opencv|ffmpeg|verlet|arap|rbf|amodal|style-dna|filmgraph|median-cut|web worker|2d mesh|viseme|mocap|localhost:8090|faz\s*[345])\b/i;
    for (const locale of ['tr', 'en'] as const) {
      for (const [key, value] of Object.entries(TRANSLATIONS[locale])) {
        expect(forbidden.test(value), `Forbidden jargon in ${locale}.${key}: "${value}"`).toBe(false);
      }
    }
    // Verify new Instant Alive magic homepage keys exist in both TR and EN
    const magicKeys: TranslationKey[] = [
      'magicTabLive',
      'magicTabShowcase',
      'magicAnimateBtn',
      'magicToyDance',
      'magicToyTalk',
      'magicToyFilm',
      'magicToyPull',
      'magicDownloadGif',
      'shelfTabAll',
    ];
    for (const k of magicKeys) {
      expect(translate('tr', k).length).toBeGreaterThan(1);
      expect(translate('en', k).length).toBeGreaterThan(1);
    }
  });

  it('25. detects true head, arms, bipedal feet & ground line from ANY drawn silhouette', () => {
    const W = 120;
    const H = 160;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const fillRect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          rgba[(y * W + x) * 4 + 3] = 255;
        }
      }
    };
    // Head (top circle block), narrow neck, wide arms, torso, and two distinct legs at bottom
    fillRect(46, 12, 74, 42);
    fillRect(56, 42, 64, 52);
    fillRect(14, 56, 106, 72);
    fillRect(44, 52, 76, 106);
    fillRect(38, 106, 48, 150);
    fillRect(72, 106, 82, 150);

    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, W, H);
    expect(anatomy.bipedal).toBe(true);
    expect(anatomy.headCenterY).toBeGreaterThan(0.1);
    expect(anatomy.headCenterY).toBeLessThan(0.32);
    expect(anatomy.footLeftX).toBeLessThan(anatomy.centerX - 0.08);
    expect(anatomy.footRightX).toBeGreaterThan(anatomy.centerX + 0.08);
    expect(anatomy.handLeftX).toBeLessThan(0.22);
    expect(anatomy.handRightX).toBeGreaterThan(0.78);
    expect(anatomy.groundV).toBeGreaterThan(0.88);
  });

  it('26. enforces Richard Williams walk invariants: planted stance feet, passing-pose swing arc & volume conservation', () => {
    // Stance phase (0..0.5): foot stays strictly grounded (lift === 0) while pushing back
    const contact = evalWilliamsLeg(0.0);
    const midStance = evalWilliamsLeg(0.25);
    const pushOff = evalWilliamsLeg(0.49);
    expect(contact.lift).toBe(0);
    expect(midStance.lift).toBe(0);
    expect(pushOff.lift).toBe(0);
    expect(contact.stride).toBeGreaterThan(0.95);
    expect(pushOff.stride).toBeLessThan(-0.9);

    // Swing phase (0.5..1.0): foot lifts highest at Passing Pose (~0.75) and lands softly toward Contact
    const passing = evalWilliamsLeg(0.75);
    const preContact = evalWilliamsLeg(0.98);
    expect(passing.lift).toBeGreaterThan(0.85);
    expect(preContact.lift).toBeLessThan(0.2);

    // Full articulated rain walk strictly preserves Squash & Stretch volume (sx * sy === 1)
    const anatomy = defaultDrawingAnatomy();
    let sawFootContact = false;
    for (let f = 0; f < 36; f++) {
      const pose = evaluateCartoonRainWalkPose(f / 12, anatomy, 12);
      expect(Math.abs(pose.squashX * pose.squashY - 1)).toBeLessThan(0.001);
      if (pose.footContact) sawFootContact = true;
    }
    expect(sawFootContact).toBe(true);
  });

  it('27. enforces Disney anticipation-arc-squash leap, rigid skull protection & damped spring-mass overshoot', () => {
    const leap = { active: true, startSec: 0, fromX: 300, toX: 600, currentX: 300, facing: 1 as const };
    const antPose = evaluateCartoonDancePose(0.1, leap, 24); // Anticipation crouch
    const apexPose = evaluateCartoonDancePose(0.4, leap, 24); // Parabolic apex
    const landPose = evaluateCartoonDancePose(0.71, leap, 24); // Landing squash

    expect(antPose.squashY).toBeLessThan(0.9);
    expect(apexPose.hipLiftY).toBeGreaterThan(0.35);
    expect(landPose.squashY).toBeLessThan(0.94);
    expect(Math.abs(antPose.squashX * antPose.squashY - 1)).toBeLessThan(0.001);

    // Rigid skull protection: distance between left & right eye points stays rock solid under heavy squash!
    const anatomy = defaultDrawingAnatomy();
    const eyeL0 = { u: 0.44, v: 0.21 };
    const eyeR0 = { u: 0.56, v: 0.21 };
    const origDist = Math.hypot(eyeR0.u - eyeL0.u, eyeR0.v - eyeL0.v);
    const dL = deformArticulatedVertex(eyeL0.u, eyeL0.v, anatomy, antPose, 0, 0);
    const dR = deformArticulatedVertex(eyeR0.u, eyeR0.v, anatomy, antPose, 0, 0);
    const defDist = Math.hypot(dR.x - dL.x, dR.y - dL.y);
    expect(Math.abs(defDist - origDist) / origDist).toBeLessThan(0.04);

    // 2nd-order damped harmonic spring physics: stretched pin snaps back WITH genuine cartoon overshoot!
    const pins = createAnatomyPins(anatomy);
    const headPin = pins.find((p) => p.role === 'head')!;
    const springs: Record<string, SpringPinState> = {
      [headPin.id]: { dx: 0.3, dy: -0.25, vx: 0, vy: 0 },
    };
    let crossedZero = false;
    for (let step = 0; step < 50; step++) {
      const off = stepSpringPins(pins, springs, null, 1 / 60);
      if (off[headPin.id].dx < -0.01) crossedZero = true;
    }
    expect(crossedZero).toBe(true);
  });

  it('28. solves exact 2-Bone Analytic IK preserving upper/lower bone lengths & soft knee guard', () => {
    const sol = solveTwoBoneIK(100, 100, 118, 175, 50, 50, -1);
    const len1 = Math.hypot(sol.mid.x - sol.root.x, sol.mid.y - sol.root.y);
    const len2 = Math.hypot(sol.end.x - sol.mid.x, sol.end.y - sol.mid.y);
    expect(Math.abs(len1 - 50)).toBeLessThan(0.01);
    expect(Math.abs(len2 - 50)).toBeLessThan(0.01);
    // bendDir = -1 bends knee forward (+X relative to hip->ankle line)
    expect(sol.mid.x).toBeGreaterThan((sol.root.x + sol.end.x) * 0.5);

    // Hyperextension soft guard: target way beyond reach never snaps straight or produces NaN
    const far = solveTwoBoneIK(0, 0, 0, 300, 40, 40, -1);
    const farReach = Math.hypot(far.end.x, far.end.y);
    expect(farReach).toBeLessThan(80);
    expect(Number.isFinite(far.mid.x)).toBe(true);
  });

  it('29. fills enclosed outline cavities with solid gouache volume & cleanly isolates limbs by geodesic ink graph', () => {
    const W = 96;
    const H = 128;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const paint = (x: number, y: number) => {
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      const i = (y * W + x) * 4;
      rgba[i] = 28;
      rgba[i + 1] = 25;
      rgba[i + 2] = 23;
      rgba[i + 3] = 255;
    };
    const strokeBox = (x0: number, y0: number, x1: number, y1: number) => {
      for (let x = x0; x <= x1; x++) {
        paint(x, y0);
        paint(x, y0 + 1);
        paint(x, y1);
        paint(x, y1 - 1);
      }
      for (let y = y0; y <= y1; y++) {
        paint(x0, y);
        paint(x0 + 1, y);
        paint(x1, y);
        paint(x1 - 1, y);
      }
    };
    // Hollow head outline + hollow torso outline + distinct left/right arms & legs
    strokeBox(34, 10, 62, 38);
    strokeBox(32, 40, 64, 82);
    for (let x = 10; x <= 32; x++) { paint(x, 52); paint(x, 53); }
    for (let x = 64; x <= 86; x++) { paint(x, 52); paint(x, 53); }
    for (let y = 82; y <= 118; y++) { paint(38, y); paint(39, y); paint(57, y); paint(58, y); }

    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, W, H);
    const { rgba: filled, filledPixels } = fillClosedContoursRGBA(rgba, W, H, anatomy.headEndV);
    expect(filledPixels).toBeGreaterThan(800);
    // Center of hollow head is now solid opaque gouache, while exterior corner (2,2) stays transparent!
    expect(filled[(24 * W + 48) * 4 + 3]).toBe(255);
    expect(filled[(2 * W + 2) * 4 + 3]).toBe(0);

    // Geodesic ink-graph segmentation separates BOTH arms, BOTH legs, torso & head cleanly!
    const { labels, counts } = computeGeodesicPartLabels(filled, W, H, anatomy);
    expect(counts.head).toBeGreaterThan(200);
    expect(counts.torso).toBeGreaterThan(400);
    expect(counts.arm_l).toBeGreaterThan(20);
    expect(counts.arm_r).toBeGreaterThan(20);
    expect(counts.leg_l).toBeGreaterThan(20);
    expect(counts.leg_r).toBeGreaterThan(20);
    // Left/right hands & feet owned by their exact respective limbs!
    expect(labels[52 * W + 14]).toBe(2);
    expect(labels[52 * W + 82]).toBe(3);
    expect(labels[112 * W + 38]).toBe(4);
    expect(labels[112 * W + 57]).toBe(5);
  });

  it('30. drives 4 distinct theatrical acting moods (joy, cool, sneak, sprint) + lightning startle with zero NaN', () => {
    const anatomy = defaultDrawingAnatomy();
    const moods: CartoonMoodId[] = ['joy', 'cool', 'sneak', 'sprint'];
    for (const mood of moods) {
      const dance = evaluateCartoonDancePose(1.1, null, 12, mood);
      const walk = evaluateCartoonRainWalkPose(1.1, anatomy, 12, mood, 0);
      expect(Number.isFinite(dance.torsoLeanRad)).toBe(true);
      expect(Math.abs(dance.squashX * dance.squashY - 1)).toBeLessThan(0.001);
      expect(Math.abs(walk.squashX * walk.squashY - 1)).toBeLessThan(0.001);
    }
    const sneakWalk = evaluateCartoonRainWalkPose(0.4, anatomy, 12, 'sneak', 0);
    const coolWalk = evaluateCartoonRainWalkPose(0.4, anatomy, 12, 'cool', 0);
    const startledWalk = evaluateCartoonRainWalkPose(0.4, anatomy, 12, 'joy', 0.85);
    expect(sneakWalk.torsoLeanRad).toBeGreaterThan(0.15);
    expect(coolWalk.torsoLeanRad).toBeLessThan(0);
    expect(startledWalk.viseme).toBe('OH');
    expect(startledWalk.mouthOpen).toBeGreaterThan(0.5);
  });

  it('31. guarantees 0.000px socket continuity with 3-stage Torso->Upper->Lower continuous limb skinning', () => {
    const W = 200;
    const H = 300;
    const mapTorso = (u: number, v: number) => ({ x: 100 + u * W * 1.05, y: 50 + v * H * 0.96 });
    const restRoot = { x: 0.35, y: 0.42 };
    const restMid = { x: 0.2, y: 0.42 };
    const restEnd = { x: 0.05, y: 0.42 };
    const liveRoot = mapTorso(restRoot.x, restRoot.y);
    const liveMid = { x: liveRoot.x - 24, y: liveRoot.y + 18 };
    const liveEnd = { x: liveMid.x - 26, y: liveMid.y - 12 };

    // Socket boundary (u >= restRoot.x -> proj <= 0) must match torso transform to 0.000px!
    const atSocket = evaluateContinuousLimbPoint(
      restRoot.x,
      restRoot.y + 0.03,
      mapTorso,
      restRoot,
      restMid,
      restEnd,
      liveRoot,
      liveMid,
      liveEnd,
      W,
      H
    );
    const torsoExact = mapTorso(restRoot.x, restRoot.y + 0.03);
    expect(Math.hypot(atSocket.x - torsoExact.x, atSocket.y - torsoExact.y)).toBeLessThan(0.001);

    // Distal hand tip must follow the live 2-Bone IK end effector!
    const atTip = evaluateContinuousLimbPoint(
      restEnd.x,
      restEnd.y,
      mapTorso,
      restRoot,
      restMid,
      restEnd,
      liveRoot,
      liveMid,
      liveEnd,
      W,
      H
    );
    expect(Math.hypot(atTip.x - liveEnd.x, atTip.y - liveEnd.y)).toBeLessThan(2.5);
  });

  it('32. evaluates all 5 Storybook Worlds (rainy, meadow, space, concert, escape) with distinct volume-preserving poses', () => {
    const anatomy = defaultDrawingAnatomy();
    const worlds: StorybookWorldId[] = ['rainy', 'meadow', 'space', 'concert', 'escape'];
    for (const w of worlds) {
      const p = evaluateCartoonWorldPose(w, 1.35, anatomy, 12, 'joy', 0);
      expect(Number.isFinite(p.hipLiftY)).toBe(true);
      expect(Number.isFinite(p.torsoLeanRad)).toBe(true);
      expect(Math.abs(p.squashX * p.squashY - 1)).toBeLessThan(0.002);
    }
    const spacePose = evaluateCartoonWorldPose('space', 0.8, anatomy, 12, 'joy', 0);
    const escapePose = evaluateCartoonWorldPose('escape', 0.8, anatomy, 12, 'joy', 0);
    // Space stays weightlessly aloft; Escape leans dramatically forward!
    expect(spacePose.hipLiftY).toBeGreaterThan(0.1);
    expect(escapePose.torsoLeanRad).toBeGreaterThan(0.14);
  });

  it('33. round-trips Hero + Buddy + World + Prop + VoiceFX in compact serverless share links & rejects invalid tokens', () => {
    const token = encodeSharedStage({
      strokes: [
        { color: '#1C1917', width: 9, points: [{ x: 600, y: 200 }, { x: 640, y: 260 }, { x: 680, y: 200 }] },
      ],
      buddyStrokes: [
        { color: '#2563EB', width: 10, points: [{ x: 580, y: 300 }, { x: 660, y: 300 }] },
      ],
      toy: 'film',
      world: 'meadow',
      mood: 'cool',
      prop: 'umbrella',
      voiceFx: 'chipmunk',
    });
    expect(token.length).toBeGreaterThan(20);
    expect(token.length).toBeLessThan(600);

    const decoded = decodeSharedStage(`#kagit=${token}`);
    expect(decoded).not.toBeNull();
    expect(decoded!.world).toBe('meadow');
    expect(decoded!.mood).toBe('cool');
    expect(decoded!.prop).toBe('umbrella');
    expect(decoded!.voiceFx).toBe('chipmunk');
    expect(decoded!.strokes.length).toBe(1);
    expect(decoded!.buddyStrokes?.length).toBe(1);

    // Malformed / tampered tokens return null safely without throwing
    expect(decodeSharedStage('#kagit=not-valid-base64!!!')).toBeNull();
    expect(decodeSharedStage('')).toBeNull();
  });
});
