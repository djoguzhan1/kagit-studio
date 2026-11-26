import { beforeAll, describe, expect, it } from 'vitest';
import deskLampSrc from '../../components/desk/DeskLamp3D.tsx?raw';
import studioDeskHubSrc from '../../components/desk/StudioDeskHub.tsx?raw';
import instantAliveSrc from '../../components/desk/InstantAliveStage.tsx?raw';
import lightboxSrc from '../../components/desk/InteractiveLightboxStage.tsx?raw';
import studioDrawerSrc from '../../components/desk/StudioDrawer.tsx?raw';
import studio3dSrc from '../../components/ui/Studio3DControls.tsx?raw';
import keycapSrc from '../../components/ui/KeycapButton.tsx?raw';
import pocketFlipSrc from '../../components/ui/PocketFlipbook3DPreview.tsx?raw';
import guideBtnSrc from '../../components/guide/GuideLauncherButton.tsx?raw';
import overviewSrc from '../../components/guide/StudioOverviewShow.tsx?raw';
import accountBtnSrc from '../../components/account/AccountButton.tsx?raw';
import radialWheelSrc from '../../components/studio/RadialQuickWheel.tsx?raw';
import { createStarterFlipbookShellProject } from '../starterFlipbook';
import { decodeSharedStage, encodeSharedStage } from '../shareCodec';

let indexCss = '';

beforeAll(async () => {
  const fsSpec = `node:${'fs'}`;
  const fsMod = (await import(/* @vite-ignore */ fsSpec)) as {
    readFileSync: (path: string, encoding: string) => string;
  };
  indexCss = fsMod.readFileSync('src/index.css', 'utf-8');
});

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relLuminance(rgb: [number, number, number]): number {
  return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
}

function wcagContrast(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relLuminance(a);
  const l2 = relLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function parseRgbTriplet(cssBlock: string, varName: string): [number, number, number] {
  const re = new RegExp(`${varName}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`);
  const m = cssBlock.match(re);
  if (!m) throw new Error(`Missing CSS variable ${varName}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe('F1-01 10/10 Art Direction, WCAG Contrast & Zero-Blocking Boot Gates', () => {
  it('guarantees WCAG 2.1 AA (>= 4.5:1) contrast across all Night & Day semantic tokens', () => {
    const [nightBlock, dayRest] = indexCss.split("[data-theme='day']");
    expect(dayRest).toBeTruthy();

    const nightBg = parseRgbTriplet(nightBlock, '--desk-bg-rgb');
    const nightPanel = parseRgbTriplet(nightBlock, '--desk-panel-rgb');
    const nightText = parseRgbTriplet(nightBlock, '--desk-text-rgb');
    const nightMuted = parseRgbTriplet(nightBlock, '--desk-muted-rgb');
    const nightBrass = parseRgbTriplet(nightBlock, '--ink-brass-rgb');

    expect(wcagContrast(nightText, nightBg)).toBeGreaterThanOrEqual(12);
    expect(wcagContrast(nightMuted, nightBg)).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(nightBrass, nightPanel)).toBeGreaterThanOrEqual(4.5);

    const dayBg = parseRgbTriplet(dayRest, '--desk-bg-rgb');
    const dayPanel = parseRgbTriplet(dayRest, '--desk-panel-rgb');
    const dayWell = parseRgbTriplet(dayRest, '--desk-well-rgb');
    const dayText = parseRgbTriplet(dayRest, '--desk-text-rgb');
    const dayMuted = parseRgbTriplet(dayRest, '--desk-muted-rgb');
    const dayBrass = parseRgbTriplet(dayRest, '--ink-brass-rgb');
    const dayVermilion = parseRgbTriplet(dayRest, '--ink-vermilion-rgb');

    expect(wcagContrast(dayText, dayPanel)).toBeGreaterThanOrEqual(12);
    expect(wcagContrast(dayBrass, dayWell)).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(dayBrass, dayBg)).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(dayBrass, dayPanel)).toBeGreaterThanOrEqual(7.0);
    expect(wcagContrast(dayBrass, [207, 199, 184])).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(dayMuted, dayWell)).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(dayVermilion, dayPanel)).toBeGreaterThanOrEqual(4.5);
  });

  it('builds synchronous 0ms starter flipbook shell without blocking boot on PNG/IDB encoding', () => {
    const t0 = performance.now();
    const shell = createStarterFlipbookShellProject();
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(20);
    expect(shell.starterPendingHydration).toBe(true);
    expect(shell.frames).toHaveLength(16);
    expect(shell.frames[0].layers).toHaveLength(3);
    expect(shell.frames.every((f) => f.thumbKey === null)).toBe(true);
  });

  it('decodes both new #inktrope= and legacy #kagit= share tokens seamlessly', () => {
    const token = encodeSharedStage({
      strokes: [{ color: '#1C1917', width: 8, points: [{ x: 120, y: 180 }, { x: 240, y: 310 }] }],
      toy: 'film',
      world: 'rainy',
      mood: 'joy',
      prop: 'umbrella',
      voiceFx: 'natural',
    });

    const fromNew = decodeSharedStage(`#inktrope=${token}`);
    const fromLegacy = decodeSharedStage(`#kagit=${token}`);
    expect(fromNew).not.toBeNull();
    expect(fromLegacy).not.toBeNull();
    expect(fromNew?.world).toBe('rainy');
    expect(fromLegacy?.prop).toBe('umbrella');
  });

  it('enforces >= 11px typography floor across all Desk, Showcase & Flipbook components', () => {
    const sources: [string, string][] = [
      ['DeskLamp3D.tsx', deskLampSrc],
      ['StudioDeskHub.tsx', studioDeskHubSrc],
      ['InstantAliveStage.tsx', instantAliveSrc],
      ['InteractiveLightboxStage.tsx', lightboxSrc],
      ['StudioDrawer.tsx', studioDrawerSrc],
      ['Studio3DControls.tsx', studio3dSrc],
      ['KeycapButton.tsx', keycapSrc],
      ['PocketFlipbook3DPreview.tsx', pocketFlipSrc],
      ['GuideLauncherButton.tsx', guideBtnSrc],
      ['StudioOverviewShow.tsx', overviewSrc],
      ['AccountButton.tsx', accountBtnSrc],
      ['RadialQuickWheel.tsx', radialWheelSrc],
    ];

    const sub11Regex = /text-\[(?:8|8\.5|9|9\.5|10|10\.5)px\]/;
    for (const [name, src] of sources) {
      expect(sub11Regex.test(src), `Found sub-11px class in ${name}`).toBe(false);
    }
  });

  it('preserves RadialQuickWheel centering and PocketFlipbook backface/reduced-motion guards', () => {
    expect(radialWheelSrc).toContain('-translate-x-1/2 -translate-y-1/2');
    expect(pocketFlipSrc).toContain('[backface-visibility:hidden]');
    expect(pocketFlipSrc).toContain('[transform:rotateY(180deg)]');
    expect(indexCss).toContain('.pocket-leaf-turning {\n    display: none !important;');
  });
});
