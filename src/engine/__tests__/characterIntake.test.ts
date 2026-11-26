import { describe, expect, it } from 'vitest';
import {
  boostFaintPencilInkRGBA,
  cleanClosedBodyPaperPocketsRGBA,
  computeTightForegroundBoundsRGBA,
  enhanceInkIllustrationRGBA,
  erasePaperPocketAtPointRGBA,
  isolatePrimarySubjectRGBA,
  stripPaperBackgroundBfsRGBA,
  type LocalPaperMap,
} from '../characterIntakeEngine';
import { fillClosedContoursRGBA } from '../skeletonSkinEngine';
import { archetypeToPinTemplate, createAnatomyMeshPins } from '../meshWarpEngine';
import type { DrawingAnatomy } from '../cartoonMotionEngine';

function fillRectRgba(
  data: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
  a: number
) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
}

describe('Unified Studio Character Intake — BFS Paper Cleaner & Tight Auto-Crop', () => {
  it('1. strips exterior white paper while keeping interior white eyes & white face 100% opaque (ZERO holes!)', () => {
    const w = 40;
    const h = 40;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Fill entire canvas with bright white sketchbook paper
    fillRectRgba(rgba, w, 0, 0, w - 1, h - 1, 250, 248, 242, 255);
    // Draw a closed dark ink head outline (10..30, 8..28)
    fillRectRgba(rgba, w, 10, 8, 30, 28, 24, 22, 20, 255);
    // Fill interior face with pure white (255,255,255) — including white eyes!
    fillRectRgba(rgba, w, 12, 10, 28, 26, 255, 255, 255, 255);
    // Two dark ink pupils inside the white face
    fillRectRgba(rgba, w, 16, 15, 17, 16, 20, 20, 20, 255);
    fillRectRgba(rgba, w, 23, 15, 24, 16, 20, 20, 20, 255);

    const stripped = stripPaperBackgroundBfsRGBA(rgba, w, h);
    expect(stripped).toBe(true);

    // Exterior paper corners MUST become completely transparent
    expect(rgba[(1 * w + 1) * 4 + 3]).toBe(0);
    expect(rgba[(38 * w + 38) * 4 + 3]).toBe(0);
    // Ink outline MUST stay 100% opaque
    expect(rgba[(8 * w + 15) * 4 + 3]).toBe(255);
    // Interior pure white eye sclera / face MUST stay 100% opaque (previously punched transparent!)
    expect(rgba[(15 * w + 15) * 4 + 3]).toBe(255);
    expect(rgba[(20 * w + 20) * 4 + 3]).toBe(255);
  });

  it('2. strips warm/shadowed phone-photo notebook paper (lum ~185) cleanly around dark ink strokes', () => {
    const w = 36;
    const h = 36;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Dim warm tungsten phone photo of notebook paper (RGB 196, 188, 168)
    fillRectRgba(rgba, w, 0, 0, w - 1, h - 1, 196, 188, 168, 255);
    // Closed dark character body in center with warm cream belly
    fillRectRgba(rgba, w, 12, 8, 24, 28, 32, 28, 26, 255);
    fillRectRgba(rgba, w, 14, 10, 22, 26, 242, 234, 220, 255);

    const stripped = stripPaperBackgroundBfsRGBA(rgba, w, h);
    expect(stripped).toBe(true);
    expect(rgba[(2 * w + 2) * 4 + 3]).toBe(0);
    expect(rgba[(33 * w + 33) * 4 + 3]).toBe(0);
    // Interior belly & ink border stay opaque!
    expect(rgba[(18 * w + 18) * 4 + 3]).toBe(255);
    expect(rgba[(8 * w + 18) * 4 + 3]).toBe(255);
  });

  it('3. leaves already-transparent Draw Desk canvases completely untouched', () => {
    const w = 24;
    const h = 24;
    const rgba = new Uint8ClampedArray(w * h * 4); // alpha=0 everywhere
    fillRectRgba(rgba, w, 8, 6, 16, 18, 255, 255, 255, 255);

    const stripped = stripPaperBackgroundBfsRGBA(rgba, w, h);
    expect(stripped).toBe(false);
    expect(rgba[(12 * w + 12) * 4 + 3]).toBe(255);
  });

  it('4. tight-crops a small character inside a huge 320x180 canvas with ground-locked bottom margin', () => {
    const w = 320;
    const h = 180;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Draw a 40x80 character centered around x=140..180, y=40..120 (leaving huge margins!)
    fillRectRgba(rgba, w, 140, 40, 180, 120, 28, 25, 23, 255);
    // Add one stray 1px corner dust speck that should be ignored
    rgba[(2 * w + 2) * 4 + 3] = 255;

    const bounds = computeTightForegroundBoundsRGBA(rgba, w, h);
    expect(bounds.empty).toBe(false);
    expect(bounds.minX).toBe(140);
    expect(bounds.maxX).toBe(180);
    expect(bounds.minY).toBe(40);
    expect(bounds.maxY).toBe(120);
    expect(bounds.cropW).toBeLessThan(w * 0.35);
    expect(bounds.cropH).toBeLessThan(h * 0.65);
    // Feet stay tightly locked near the bottom edge (groundV >= 0.94!)
    const footRelativeV = (bounds.maxY - bounds.cropY) / bounds.cropH;
    expect(footRelativeV).toBeGreaterThanOrEqual(0.93);
  });

  it('5. maps anatomical mesh pins directly onto an off-center custom character silhouette', () => {
    const customAnatomy: DrawingAnatomy = {
      centerX: 0.42,
      headEndV: 0.31,
      headCenterX: 0.41,
      headCenterY: 0.19,
      mouthX: 0.41,
      mouthY: 0.25,
      mouthScale: 0.9,
      neckX: 0.42,
      neckY: 0.32,
      hipV: 0.62,
      shoulderLeftX: 0.28,
      shoulderRightX: 0.56,
      shoulderY: 0.36,
      handLeftX: 0.14,
      handLeftY: 0.44,
      handRightX: 0.72,
      handRightY: 0.46,
      footLeftX: 0.31,
      footRightX: 0.53,
      groundV: 0.96,
      bipedal: true,
    };

    const pins = createAnatomyMeshPins(customAnatomy, 'humanoid');
    expect(pins.length).toBe(6);
    const head = pins.find((p) => p.role === 'head')!;
    const handL = pins.find((p) => p.role === 'hand-l')!;
    const footR = pins.find((p) => p.role === 'foot-r')!;

    expect(head.x).toBeCloseTo(0.41, 2);
    expect(head.y).toBeCloseTo(0.19, 2);
    expect(handL.x).toBeCloseTo(0.14, 2);
    expect(footR.x).toBeCloseTo(0.53, 2);
    expect(footR.y).toBeGreaterThan(0.9);
  });

  it('6. cleans an unevenly shadowed A4 desk-lamp gradient photo while preserving interior pure-white eyes', () => {
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Smooth uneven desk-lamp gradient: top-left RGB(244,240,230) -> bottom-right shadowed RGB(152,146,134)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = (x + y) / (w + h - 2);
        const o = (y * w + x) * 4;
        rgba[o] = Math.round(244 - g * 92);
        rgba[o + 1] = Math.round(240 - g * 94);
        rgba[o + 2] = Math.round(230 - g * 96);
        rgba[o + 3] = 255;
      }
    }
    // Closed dark ink head in center with pure white face & white eyes inside
    fillRectRgba(rgba, w, 20, 18, 44, 42, 26, 24, 22, 255);
    fillRectRgba(rgba, w, 23, 21, 41, 39, 255, 255, 255, 255);
    fillRectRgba(rgba, w, 27, 27, 29, 29, 20, 18, 18, 255);
    fillRectRgba(rgba, w, 35, 27, 37, 29, 20, 18, 18, 255);

    const stripped = stripPaperBackgroundBfsRGBA(rgba, w, h);
    expect(stripped).toBe(true);
    // BOTH bright top-left AND deeply shadowed bottom-right corners become transparent!
    expect(rgba[(2 * w + 2) * 4 + 3]).toBe(0);
    expect(rgba[(61 * w + 61) * 4 + 3]).toBe(0);
    // Interior pure white face/eyes MUST stay 100% opaque!
    expect(rgba[(30 * w + 32) * 4 + 3]).toBe(255);
    expect(rgba[(27 * w + 25) * 4 + 3]).toBe(255);
  });

  it('7. sharpens faint graphite pencil sketches without altering colorful drawings', () => {
    // A) Faint graphite pencil sketch (RGB 148,145,140)
    const w = 24;
    const h = 24;
    const pencil = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(pencil, w, 6, 4, 18, 20, 148, 145, 140, 255);
    const boosted = boostFaintPencilInkRGBA(pencil, w, h);
    expect(boosted).toBe(true);
    const o = (12 * w + 12) * 4;
    const newLum = 0.299 * pencil[o] + 0.587 * pencil[o + 1] + 0.114 * pencil[o + 2];
    expect(newLum).toBeLessThan(98);

    // B) Vibrant colored character (MUST NOT be touched!)
    const colored = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(colored, w, 6, 4, 18, 20, 228, 92, 54, 255);
    expect(boostFaintPencilInkRGBA(colored, w, h)).toBe(false);
    expect(colored[o]).toBe(228);
  });

  it('8. selects ideal pin templates from detected character archetypes (humanoid / quadruped / floater)', () => {
    expect(archetypeToPinTemplate('humanoid')).toBe('humanoid');
    expect(archetypeToPinTemplate('quadruped')).toBe('creature');
    expect(archetypeToPinTemplate('floater')).toBe('simple');
  });

  it('9. flattens a realistic mid-page phone shadow blob (lum 172 vs 229) without touching ink or white eyes', () => {
    const w = 80;
    const h = 80;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Bright paper (229) with a wide smooth Gaussian phone shadow centered at (22, 36) dropping to lum=170
        const d2 = (x - 22) * (x - 22) + (y - 36) * (y - 36);
        const shadow = 59 * Math.exp(-d2 / 280);
        const lum = Math.round(229 - shadow);
        const o = (y * w + x) * 4;
        rgba[o] = lum;
        rgba[o + 1] = lum;
        rgba[o + 2] = Math.max(0, lum - 4);
        rgba[o + 3] = 255;
      }
    }
    // Photographed black marker character (lum ~86) with white interior face (242)
    fillRectRgba(rgba, w, 40, 14, 68, 66, 85, 86, 85, 255);
    fillRectRgba(rgba, w, 46, 20, 62, 34, 242, 242, 240, 255);

    const stripped = stripPaperBackgroundBfsRGBA(rgba, w, h);
    expect(stripped).toBe(true);
    // Deepest center of phone shadow blob MUST become 100% transparent!
    expect(rgba[(36 * w + 22) * 4 + 3]).toBe(0);
    // Marker body & interior white face MUST stay 100% opaque!
    expect(rgba[(45 * w + 54) * 4 + 3]).toBe(255);
    expect(rgba[(26 * w + 54) * 4 + 3]).toBe(255);
  });

  it('10. isolates primary character by removing distant corner signatures/dates while keeping nearby floating hats & co-characters', () => {
    const w = 140;
    const h = 120;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Primary character on the right (x=72..120, y=14..112) with an outstretched left elbow at x=54, y=45
    fillRectRgba(rgba, w, 72, 14, 118, 112, 30, 28, 26, 255);
    fillRectRgba(rgba, w, 54, 42, 74, 54, 30, 28, 26, 255);
    // Nearby floating halo/hat 4px above head (MUST BE KEPT!)
    fillRectRgba(rgba, w, 84, 4, 106, 9, 220, 175, 45, 255);
    // Distant corner signature + date in bottom-left (x=6..34, y=92..106 — far from actual pixels even near elbow's x!)
    fillRectRgba(rgba, w, 6, 92, 20, 106, 45, 42, 42, 255);
    fillRectRgba(rgba, w, 26, 96, 36, 104, 45, 42, 42, 255);

    const isolated = isolatePrimarySubjectRGBA(rgba, w, h);
    expect(isolated).toBe(true);
    // Primary character & nearby floating hat stay 100% opaque
    expect(rgba[(60 * w + 95) * 4 + 3]).toBe(255);
    expect(rgba[(6 * w + 95) * 4 + 3]).toBe(255);
    // Distant corner signature & date MUST be stripped completely!
    expect(rgba[(98 * w + 12) * 4 + 3]).toBe(0);
    expect(rgba[(100 * w + 30) * 4 + 3]).toBe(0);
  });

  it('11. cleans enclosed armpit paper pockets while protecting white face, collar, and thin-outlined white hands', () => {
    const w = 120;
    const h = 140;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Solid black character silhouette (x=20..100, y=10..130)
    fillRectRgba(rgba, w, 20, 10, 100, 130, 42, 42, 42, 255);
    // White face in head zone (y=16..40) -> MUST STAY OPAQUE!
    fillRectRgba(rgba, w, 44, 16, 76, 38, 240, 240, 238, 255);
    // White shirt collar in upper-center (x=52..68, y=42..58) -> MUST STAY OPAQUE!
    fillRectRgba(rgba, w, 52, 42, 68, 58, 240, 240, 238, 255);
    // Enclosed armpit paper pocket deeply framed by thick black sleeve + torso (x=28..42, y=58..92) -> MUST CLEAR!
    fillRectRgba(rgba, w, 28, 58, 42, 92, 232, 232, 228, 255);
    // White hand sitting right behind a thin 1px outline on the outer right edge (x=88..99, y=74..92) -> MUST STAY OPAQUE!
    fillRectRgba(rgba, w, 88, 74, 99, 92, 240, 240, 238, 255);

    const paperHolder: { map: LocalPaperMap | null } = { map: null };
    // Run pocket cleaner directly on transparent-background character cutout
    const cleared = cleanClosedBodyPaperPocketsRGBA(rgba, w, h, paperHolder.map);
    expect(cleared).toBe(1);
    // Armpit background pocket cleared!
    expect(rgba[(75 * w + 35) * 4 + 3]).toBe(0);
    // White face, white shirt collar, AND thin-outlined white hand stay 100% opaque!
    expect(rgba[(26 * w + 60) * 4 + 3]).toBe(255);
    expect(rgba[(50 * w + 60) * 4 + 3]).toBe(255);
    expect(rgba[(82 * w + 94) * 4 + 3]).toBe(255);
  });

  it('12. deepens washed-out monochrome photographed marker ink without touching colored drawings', () => {
    const w = 32;
    const h = 32;
    const mono = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(mono, w, 4, 4, 27, 27, 86, 87, 86, 255); // Photographed gray-black marker
    fillRectRgba(mono, w, 10, 8, 22, 16, 236, 236, 233, 255); // Interior white face

    const enhanced = enhanceInkIllustrationRGBA(mono, w, h);
    expect(enhanced).toBe(true);
    // Marker deepened into velvety dark ink (< 48) while white face stays bright ivory (>= 244)!
    const inkO = (22 * w + 16) * 4;
    const faceO = (12 * w + 16) * 4;
    expect(mono[inkO]).toBeLessThan(48);
    expect(mono[faceO]).toBeGreaterThanOrEqual(244);
  });

  it('13. magic-wand pocket eraser clears only the clicked enclosed pocket and leaves neighbors opaque', () => {
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(rgba, w, 2, 2, 29, 29, 25, 25, 25, 255);
    fillRectRgba(rgba, w, 6, 6, 13, 24, 240, 240, 238, 255); // Pocket A
    fillRectRgba(rgba, w, 18, 6, 25, 24, 240, 240, 238, 255); // Pocket B

    const cleared = erasePaperPocketAtPointRGBA(rgba, w, h, 9, 14);
    expect(cleared).toBeGreaterThan(80);
    expect(rgba[(14 * w + 9) * 4 + 3]).toBe(0); // Clicked pocket A cleared
    expect(rgba[(14 * w + 21) * 4 + 3]).toBe(255); // Unclicked pocket B untouched
    expect(rgba[(14 * w + 15) * 4 + 3]).toBe(255); // Dark divider wall untouched
  });

  it('14. fillClosedContoursRGBA fills hollow line-art doodles while preserving transparent armpit cutouts on solid art', () => {
    const w = 48;
    const h = 64;
    // A) Solid-filled character with an intentional transparent armpit cavity
    const solid = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(solid, w, 8, 4, 40, 60, 28, 26, 24, 255);
    fillRectRgba(solid, w, 12, 26, 18, 40, 0, 0, 0, 0); // Transparent armpit hole
    const solidRes = fillClosedContoursRGBA(solid, w, h, 0.32);
    expect(solidRes.filledPixels).toBe(0);
    expect(solidRes.rgba[(32 * w + 15) * 4 + 3]).toBe(0);

    // B) Hollow Draw Desk outline circle head (interior alpha = 0) -> MUST get warm gouache fill!
    const hollow = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(hollow, w, 10, 4, 38, 24, 24, 22, 20, 255);
    fillRectRgba(hollow, w, 13, 7, 35, 21, 0, 0, 0, 0);
    const hollowRes = fillClosedContoursRGBA(hollow, w, h, 0.42);
    expect(hollowRes.filledPixels).toBeGreaterThan(150);
    expect(hollowRes.rgba[(14 * w + 24) * 4 + 3]).toBe(255);
  });

  it('15. seals 4px open-outline pen gaps in white faces without blocking smooth phone shadows', () => {
    const w = 120;
    const h = 120;
    const rgba = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(rgba, w, 0, 0, w - 1, h - 1, 240, 238, 234, 255);
    // White face enclosed by dark 3px outline with an intentional 4px opening at the bottom chin
    for (let x = 35; x <= 85; x++) {
      fillRectRgba(rgba, w, x, 24, x, 26, 28, 26, 24, 255);
      if (x < 58 || x > 61) {
        fillRectRgba(rgba, w, x, 74, x, 76, 28, 26, 24, 255);
      }
    }
    fillRectRgba(rgba, w, 35, 24, 37, 76, 28, 26, 24, 255);
    fillRectRgba(rgba, w, 83, 24, 85, 76, 28, 26, 24, 255);
    fillRectRgba(rgba, w, 38, 27, 82, 73, 252, 252, 250, 255);

    const stripped = stripPaperBackgroundBfsRGBA(rgba, w, h);
    expect(stripped).toBe(true);
    expect(rgba[(5 * w + 5) * 4 + 3]).toBe(0); // Exterior paper cleared
    expect(rgba[(50 * w + 60) * 4 + 3]).toBe(255); // Interior white face protected despite 4px chin gap!
  });

  it('16. strips printed blue-grid notebook rules (kareli defter) while preserving solid pastel-blue marker fills', () => {
    const w = 120;
    const h = 120;
    const rgba = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(rgba, w, 0, 0, w - 1, h - 1, 244, 244, 242, 255);
    // Repeating 1px pale-blue notebook gridlines every 16px
    for (let y = 12; y < h; y += 16) fillRectRgba(rgba, w, 0, y, w - 1, y, 168, 198, 232, 255);
    for (let x = 12; x < w; x += 16) fillRectRgba(rgba, w, x, 0, x, h - 1, 168, 198, 232, 255);
    // Solid pastel-blue marker character drawn in center (no black outline!)
    fillRectRgba(rgba, w, 40, 34, 80, 88, 130, 196, 242, 255);

    const stripped = stripPaperBackgroundBfsRGBA(rgba, w, h);
    expect(stripped).toBe(true);
    // Exterior notebook gridline intersection MUST become transparent!
    expect(rgba[(12 * w + 12) * 4 + 3]).toBe(0);
    // Solid pastel-blue marker body MUST stay 100% opaque!
    expect(rgba[(60 * w + 60) * 4 + 3]).toBe(255);
  });

  it('17. strips dark wooden desk framing a bright paper sheet and extracts the drawn character cleanly', () => {
    const w = 140;
    const h = 140;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Dark brown wooden desk border (RGB 74,52,36)
    fillRectRgba(rgba, w, 0, 0, w - 1, h - 1, 74, 52, 36, 255);
    // Bright paper sheet in center (x=18..122, y=18..122)
    fillRectRgba(rgba, w, 18, 18, 122, 122, 238, 235, 228, 255);
    // Drawn dark ink character on the paper
    fillRectRgba(rgba, w, 52, 36, 88, 108, 24, 22, 20, 255);

    const stripped = stripPaperBackgroundBfsRGBA(rgba, w, h);
    expect(stripped).toBe(true);
    expect(rgba[(4 * w + 4) * 4 + 3]).toBe(0); // Dark desk stripped!
    expect(rgba[(24 * w + 24) * 4 + 3]).toBe(0); // Bright paper corner stripped!
    expect(rgba[(70 * w + 70) * 4 + 3]).toBe(255); // Character ink preserved!
  });

  it('18. strips warm 2700K tungsten evening desk-lamp paper while protecting red/blue clothes and pale peach skin', () => {
    const w = 120;
    const h = 120;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = (x / w) * 0.5 + (y / h) * 0.5;
        const o = (y * w + x) * 4;
        rgba[o] = Math.round(246 - g * 62);
        rgba[o + 1] = Math.round(222 - g * 64);
        rgba[o + 2] = Math.round(168 - g * 58);
        rgba[o + 3] = 255;
      }
    }
    fillRectRgba(rgba, w, 40, 24, 80, 72, 196, 54, 42, 255); // Red sweater
    fillRectRgba(rgba, w, 44, 72, 76, 104, 42, 74, 138, 255); // Blue pants

    expect(stripPaperBackgroundBfsRGBA(rgba, w, h)).toBe(true);
    expect(rgba[(6 * w + 6) * 4 + 3]).toBe(0); // Bright tungsten corner stripped
    expect(rgba[(112 * w + 112) * 4 + 3]).toBe(0); // Dim shadowed tungsten corner stripped
    expect(rgba[(48 * w + 60) * 4 + 3]).toBe(255); // Red sweater protected
    expect(rgba[(88 * w + 60) * 4 + 3]).toBe(255); // Blue pants protected

    // Also verify pale unoutlined peach skin (RGB 252,224,202) survives on warm cream paper (RGB 244,240,233)
    const cream = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(cream, w, 0, 0, w - 1, h - 1, 244, 240, 233, 255);
    fillRectRgba(cream, w, 42, 42, 78, 78, 252, 224, 202, 255);
    expect(stripPaperBackgroundBfsRGBA(cream, w, h)).toBe(true);
    expect(cream[(6 * w + 6) * 4 + 3]).toBe(0);
    expect(cream[(60 * w + 60) * 4 + 3]).toBe(255);
  });

  it('19. strips repeating gray-lined notebook rules (çizgili defter) while preserving thin antennas and drawings', () => {
    const w = 140;
    const h = 140;
    const rgba = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(rgba, w, 0, 0, w - 1, h - 1, 240, 239, 235, 255);
    for (let y = 14; y < h - 6; y += 18) {
      fillRectRgba(rgba, w, 0, y, w - 1, y, 186, 188, 192, 255);
    }
    fillRectRgba(rgba, w, 68, 18, 71, 44, 42, 44, 48, 255); // Thin robot antenna
    fillRectRgba(rgba, w, 48, 44, 92, 114, 82, 116, 152, 255); // Robot body

    expect(stripPaperBackgroundBfsRGBA(rgba, w, h)).toBe(true);
    expect(rgba[(14 * w + 10) * 4 + 3]).toBe(0); // Gray notebook rule cleared
    expect(rgba[(50 * w + 128) * 4 + 3]).toBe(0); // Gray rule on right margin cleared
    expect(rgba[(30 * w + 70) * 4 + 3]).toBe(255); // Thin antenna preserved
    expect(rgba[(80 * w + 70) * 4 + 3]).toBe(255); // Robot body preserved
  });

  it('20. protects white bellies framed by colored fur on quadruped animals inside cleanClosedBodyPaperPocketsRGBA', () => {
    const w = 160;
    const h = 110;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Horizontal orange watercolor cat body with white belly framed by orange fur + dark underline
    fillRectRgba(rgba, w, 24, 24, 136, 72, 235, 165, 92, 255);
    fillRectRgba(rgba, w, 44, 52, 116, 68, 252, 248, 240, 255); // White belly
    fillRectRgba(rgba, w, 24, 70, 136, 73, 64, 48, 38, 255); // Bottom outline
    fillRectRgba(rgba, w, 30, 72, 44, 102, 196, 118, 52, 255); // Back leg
    fillRectRgba(rgba, w, 116, 72, 130, 102, 196, 118, 52, 255); // Front leg

    const cleared = cleanClosedBodyPaperPocketsRGBA(rgba, w, h, null);
    expect(cleared).toBe(0);
    expect(rgba[(60 * w + 80) * 4 + 3]).toBe(255); // White cat belly stays 100% opaque!
  });

  it('21. strips Turkish school notebook red vertical margin lines and edge spiral rings without touching red clothes', () => {
    const w = 160;
    const h = 160;
    const rgba = new Uint8ClampedArray(w * h * 4);
    fillRectRgba(rgba, w, 0, 0, w - 1, h - 1, 242, 241, 237, 255);
    // Horizontal gray lines
    for (let y = 16; y < h - 8; y += 18) {
      fillRectRgba(rgba, w, 0, y, w - 1, y, 188, 190, 194, 255);
    }
    // Classic vertical red/pink margin line at x=22..23
    fillRectRgba(rgba, w, 22, 0, 23, h - 1, 224, 118, 134, 255);
    // Spiral binder holes hugging the far-left edge (x=2..8)
    for (let y = 18; y < h - 10; y += 28) {
      fillRectRgba(rgba, w, 2, y - 3, 8, y + 3, 34, 34, 38, 255);
    }
    // Red-shirt character in center (MUST STAY 100% OPAQUE!)
    fillRectRgba(rgba, w, 72, 26, 116, 62, 32, 28, 26, 255); // Head
    fillRectRgba(rgba, w, 66, 64, 122, 134, 218, 52, 58, 255); // Red shirt

    expect(stripPaperBackgroundBfsRGBA(rgba, w, h)).toBe(true);
    isolatePrimarySubjectRGBA(rgba, w, h);

    // Red vertical margin line, gray lines & left-edge spiral rings MUST be stripped!
    expect(rgba[(80 * w + 22) * 4 + 3]).toBe(0);
    expect(rgba[(46 * w + 5) * 4 + 3]).toBe(0);
    expect(rgba[(16 * w + 145) * 4 + 3]).toBe(0);
    // Character's red shirt MUST stay 100% opaque!
    expect(rgba[(96 * w + 94) * 4 + 3]).toBe(255);
  });
});
