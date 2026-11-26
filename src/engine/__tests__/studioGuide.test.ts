import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_TOUR_MODES,
  TOUR_MODE_LABEL_KEY,
  TOUR_STEPS_BY_MODE,
  loadTourProgress,
  saveTourProgress,
} from '../tourConfig';
import { translate, type TranslationKey } from '../../i18n/translations';

const FORBIDDEN_JARGON_PATTERNS = [
  /\bai\b/i,
  /yapay zek/i,
  /2\.5d/i,
  /\bfps\b/i,
  /\brms\b/i,
  /keyframe/i,
  /onion skin/i,
  /\bmesh\b/i,
  /\brig\b/i,
  /pipeline/i,
  /viseme/i,
  /shader/i,
  /render/i,
];

const ALL_GUIDE_AND_OVERVIEW_KEYS: TranslationKey[] = [
  'guideBtnLabel',
  'guideBtnTitle',
  'guideMenuTitle',
  'guideMenuSub',
  'guideStartCurrent',
  'guideWatchOverview',
  'guideSectionsTitle',
  'guideResetProgress',
  'guideTabDesk',
  'guideTabDraw',
  'guideTabPaper',
  'guideTabPuppet',
  'guideTabFilm',
  'guideStepOf',
  'guideActionTip',
  'guideNext',
  'guidePrev',
  'guideFinish',
  'guideSkip',
  'guideCelebration',
  'guideDesk1Title',
  'guideDesk1Body',
  'guideDesk2Title',
  'guideDesk2Body',
  'guideDesk3Title',
  'guideDesk3Body',
  'guideDraw1Title',
  'guideDraw1Body',
  'guideDraw2Title',
  'guideDraw2Body',
  'guideDraw3Title',
  'guideDraw3Body',
  'guidePaper1Title',
  'guidePaper1Body',
  'guidePaper2Title',
  'guidePaper2Body',
  'guidePaper3Title',
  'guidePaper3Body',
  'guidePuppet1Title',
  'guidePuppet1Body',
  'guidePuppet2Title',
  'guidePuppet2Body',
  'guidePuppet3Title',
  'guidePuppet3Body',
  'guideFilm1Title',
  'guideFilm1Body',
  'guideFilm2Title',
  'guideFilm2Body',
  'guideFilm3Title',
  'guideFilm3Body',
  'overviewTitle',
  'overviewSubtitle',
  'overviewScene1Title',
  'overviewScene1Desc',
  'overviewScene2Title',
  'overviewScene2Desc',
  'overviewScene3Title',
  'overviewScene3Desc',
  'overviewScene4Title',
  'overviewScene4Desc',
  'overviewOpenNow',
  'overviewLearnThis',
  'overviewPause',
  'overviewPlay',
];

describe('Site-Wide Living Guide & Overview Show', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => store.clear(),
      },
    });
  });

  it('defines exactly 3 razor-sharp steps for every one of the 5 studio modes', () => {
    expect(ALL_TOUR_MODES).toEqual(['desk', 'draw', 'paper', 'puppet', 'film']);
    for (const mode of ALL_TOUR_MODES) {
      const steps = TOUR_STEPS_BY_MODE[mode];
      expect(steps).toHaveLength(3);
      expect(TOUR_MODE_LABEL_KEY[mode]).toBeTruthy();

      const seenIds = new Set<string>();
      for (const step of steps) {
        expect(step.id).toBeTruthy();
        expect(seenIds.has(step.id)).toBe(false);
        seenIds.add(step.id);
        expect(step.selector).toMatch(/^\[data-tour="[a-z0-9-]+"\]$/);

        const trTitle = translate('tr', step.titleKey);
        const enTitle = translate('en', step.titleKey);
        const trBody = translate('tr', step.bodyKey);
        const enBody = translate('en', step.bodyKey);

        expect(trTitle.trim().length).toBeGreaterThan(2);
        expect(enTitle.trim().length).toBeGreaterThan(2);
        expect(trBody.trim().length).toBeGreaterThan(10);
        expect(enBody.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it('contains ZERO AI or technical jargon in any Turkish or English guide & overview copy', () => {
    for (const key of ALL_GUIDE_AND_OVERVIEW_KEYS) {
      for (const locale of ['tr', 'en'] as const) {
        const text = translate(locale, key);
        expect(text.trim().length).toBeGreaterThan(0);
        for (const forbidden of FORBIDDEN_JARGON_PATTERNS) {
          expect(
            forbidden.test(text),
            `Forbidden jargon ${forbidden} found in ${locale}.${key}: "${text}"`
          ).toBe(false);
        }
      }
    }
  });

  it('persists, deduplicates, and validates tour completion progress cleanly', () => {
    expect(loadTourProgress()).toEqual({ completed: [], guideSeen: false });

    saveTourProgress({ completed: ['desk', 'draw', 'desk'], guideSeen: true });
    expect(loadTourProgress()).toEqual({ completed: ['desk', 'draw'], guideSeen: true });

    // Corrupted localStorage values must never throw or pollute modes
    localStorage.setItem(
      'kagit:tour-progress:v1',
      JSON.stringify({ completed: ['film', 'bogus-mode', 'film'], guideSeen: 1 })
    );
    expect(loadTourProgress()).toEqual({ completed: ['film'], guideSeen: true });

    localStorage.setItem('kagit:tour-progress:v1', '{not-json');
    expect(loadTourProgress()).toEqual({ completed: [], guideSeen: false });
  });
});
