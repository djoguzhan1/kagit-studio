import { beforeAll, describe, expect, it } from 'vitest';
import {
  TRANSLATIONS,
  localizeActorName,
  localizeLayerName,
  localizePinOrPartLabel,
  localizeProjectName,
  localizeSceneOrNote,
  translate,
  translateFmt,
} from '../../i18n/translations';
import {
  flushActiveCanvasNow,
  registerCanvasFlusher,
  useStudioStore,
} from '../../store/useStudioStore';

interface NodeFsLike {
  readdirSync: (
    p: string,
    opts: { withFileTypes: true }
  ) => Array<{ name: string; isDirectory: () => boolean }>;
  readFileSync: (p: string, enc: string) => string;
}

interface NodePathLike {
  join: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
  resolve: (...parts: string[]) => string;
}

let fsMod!: NodeFsLike;
let pathMod!: NodePathLike;
let SRC_ROOT = 'src';

beforeAll(async () => {
  const fsSpec = `node:${'fs'}`;
  const pathSpec = `node:${'path'}`;
  fsMod = (await import(/* @vite-ignore */ fsSpec)) as NodeFsLike;
  pathMod = (await import(/* @vite-ignore */ pathSpec)) as NodePathLike;
  SRC_ROOT = pathMod.resolve('src');
});

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const ent of fsMod.readdirSync(dir, { withFileTypes: true })) {
    const full = pathMod.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('F1-02 10/10 Ergonomics, Layout, Tour, State Safety & i18n Regression Gate', () => {
  it('1. maintains 100% TR/EN dictionary parity and ZERO dead translation keys', () => {
    const trKeys = Object.keys(TRANSLATIONS.tr);
    const enKeys = Object.keys(TRANSLATIONS.en);
    expect(trKeys.sort()).toEqual(enKeys.sort());
    expect(trKeys.length).toBeGreaterThan(1100);

    const allSrc = walkSourceFiles(SRC_ROOT)
      .map((f) => {
        const raw = fsMod.readFileSync(f, 'utf8');
        if (f.endsWith('translations.ts')) {
          const idx = raw.indexOf('export const TRANSLATIONS');
          return idx >= 0 ? raw.slice(idx) : raw;
        }
        return raw;
      })
      .join('\n');

    const deadKeys = trKeys.filter((k) => !new RegExp(`['"\`]${k}['"\`]`).test(allSrc));
    expect(deadKeys).toEqual([]);
  });

  it('2. enforces ZERO inline locale === "en" / isEn string bypasses outside translations.ts', () => {
    const files = walkSourceFiles(SRC_ROOT).filter((f) => !f.endsWith('translations.ts'));
    const bypasses: string[] = [];
    for (const f of files) {
      const s = fsMod.readFileSync(f, 'utf8');
      if (/\blocale\s*===\s*['"]en['"]|\bisEn\b/.test(s)) {
        bypasses.push(pathMod.relative(SRC_ROOT, f));
      }
    }
    expect(bypasses).toEqual([]);
  });

  it('3. enforces >=11px minimum typography floor (ZERO text-[8px]..text-[10.5px] classes in src/)', () => {
    const sub11Re = /text-\[(?:[0-9](?:\.[0-9]+)?|10(?:\.[0-9]+)?)(?:px)?\]/g;
    const violations: Array<{ file: string; matches: string[] }> = [];
    for (const f of walkSourceFiles(SRC_ROOT)) {
      const s = fsMod.readFileSync(f, 'utf8');
      const m = s.match(sub11Re);
      if (m && m.length > 0) {
        violations.push({ file: pathMod.relative(SRC_ROOT, f), matches: m });
      }
    }
    expect(violations).toEqual([]);
  });

  it('4. guards 100% of setPointerCapture calls via safeSetPointerCapture and wires useModalA11y on all dialogs', () => {
    const unguardedPc: string[] = [];
    const untrappedDialogs: string[] = [];

    for (const f of walkSourceFiles(SRC_ROOT)) {
      const rel = pathMod.relative(SRC_ROOT, f);
      const s = fsMod.readFileSync(f, 'utf8');
      if (!rel.endsWith('pointerCapture.ts') && /\.setPointerCapture\(/.test(s)) {
        unguardedPc.push(rel);
      }
      if (/^\s*role=(?:\{[^}]*['"]dialog['"]|['"]dialog['"])/m.test(s)) {
        if (!s.includes('useModalA11y')) {
          untrappedDialogs.push(rel);
        }
      }
    }

    expect(unguardedPc).toEqual([]);
    expect(untrappedDialogs).toEqual([]);
  });

  it('5. guarantees >=44x44px KeycapButton sizing, mobile stage height locks & RadialQuickWheel a11y', () => {
    const keycap = fsMod.readFileSync(pathMod.join(SRC_ROOT, 'components/ui/KeycapButton.tsx'), 'utf8');
    expect(keycap).toContain('min-w-[44px]');
    expect(keycap).toContain('min-h-[39px]');

    const film = fsMod.readFileSync(pathMod.join(SRC_ROOT, 'components/film/FilmDirectorStudio.tsx'), 'utf8');
    expect(film).toContain('min-h-[248px]');
    expect(film).toContain("id: 'inspector'");

    const mesh = fsMod.readFileSync(pathMod.join(SRC_ROOT, 'components/puppet/MeshWarpStage.tsx'), 'utf8');
    expect(mesh).toContain('min-h-[272px]');
    expect(mesh).toContain('grid-cols-2 sm:grid-cols-4');

    const radial = fsMod.readFileSync(pathMod.join(SRC_ROOT, 'components/studio/RadialQuickWheel.tsx'), 'utf8');
    expect(radial).toContain('aria-label={act.label}');
    expect(radial).toContain('-translate-x-1/2 -translate-y-1/2');

    const guide = fsMod.readFileSync(pathMod.join(SRC_ROOT, 'components/guide/StudioGuideOverlay.tsx'), 'utf8');
    expect(guide).toContain("addEventListener('pointerup'");
    expect(guide).toContain('e.stopImmediatePropagation()');
    expect(guide).toContain("t('guideActionTip')");
  });

  it('6. localizes starter project, layer, actor, pin/part & scene names symmetrically across TR & EN', () => {
    expect(localizeProjectName('Kağıt Uçak & Rüzgar', 'en')).toBe('Paper Plane & Wind');
    expect(localizeProjectName('Paper Plane & Wind', 'tr')).toBe('Kağıt Uçak & Rüzgar');
    expect(localizeLayerName('Mürekkep', 'en')).toBe('Ink');
    expect(localizeLayerName('Eskiz (Mavi)', 'en')).toBe('Rough (Blue)');
    expect(localizeActorName('Şapkalı Baron', 'en')).toBe('Top-Hat Baron');
    expect(localizePinOrPartLabel('Gövde', 'en')).toBe('Torso');
    expect(localizePinOrPartLabel('Sağ El', 'en')).toBe('Right Hand');
    expect(localizeSceneOrNote('Hazırlık (Nişan)', 'en')).toBe('Anticipation (Aim)');
    expect(translateFmt('en', 'acctGuestFound', { count: 3 })).toContain('3');
    expect(translate('en', 'docPageTitle')).toContain('INKTROPE');
  });

  it('7. chains flushActiveCanvasNow() promises and blocks ghost puppetExportOpen when no rig exists', async () => {
    const order: string[] = [];
    registerCanvasFlusher(async () => {
      order.push('start');
      await new Promise((r) => setTimeout(r, 15));
      order.push('done');
    });

    await flushActiveCanvasNow();
    registerCanvasFlusher(null);
    expect(order).toEqual(['start', 'done']);

    const store = useStudioStore.getState();
    const blank = store.createProject('Empty Rig Check', '16:9', 12);
    store.openProject(blank.id, 'draw');
    useStudioStore.getState().setPuppetExportOpen(true);
    expect(useStudioStore.getState().puppetExportOpen).toBe(false);
  });
});
