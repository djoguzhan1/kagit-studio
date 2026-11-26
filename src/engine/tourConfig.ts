import type { StudioMode } from '../types/studio';
import type { TranslationKey } from '../i18n/translations';

export interface TourStepDef {
  id: string;
  selector: string;
  fallbackSelector?: string;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  preferredSide?: 'top' | 'bottom' | 'left' | 'right';
}

export const ALL_TOUR_MODES: StudioMode[] = ['desk', 'draw', 'paper', 'puppet', 'film'];

export const TOUR_MODE_LABEL_KEY: Record<StudioMode, TranslationKey> = {
  desk: 'guideTabDesk',
  draw: 'guideTabDraw',
  paper: 'guideTabPaper',
  puppet: 'guideTabPuppet',
  film: 'guideTabFilm',
};

/**
 * 15 Razor-Sharp, Zero-Jargon Interactive Tour Steps (3 per studio desk).
 * Every step targets a real clickable DOM element via `data-tour="..."` so users
 * learn by doing — clicking/drawing on the live control automatically completes the step!
 */
export const TOUR_STEPS_BY_MODE: Record<StudioMode, TourStepDef[]> = {
  desk: [
    {
      id: 'desk-1',
      selector: '[data-tour="desk-quick-draw"]',
      fallbackSelector: '[data-tour="desk-canvas"]',
      titleKey: 'guideDesk1Title',
      bodyKey: 'guideDesk1Body',
      preferredSide: 'top',
    },
    {
      id: 'desk-2',
      selector: '[data-tour="desk-alive-actions"]',
      fallbackSelector: '[data-tour="desk-canvas"]',
      titleKey: 'guideDesk2Title',
      bodyKey: 'guideDesk2Body',
      preferredSide: 'top',
    },
    {
      id: 'desk-3',
      selector: '[data-tour="desk-modules"]',
      titleKey: 'guideDesk3Title',
      bodyKey: 'guideDesk3Body',
      preferredSide: 'left',
    },
  ],
  draw: [
    {
      id: 'draw-1',
      selector: '[data-tour="draw-tools"]',
      titleKey: 'guideDraw1Title',
      bodyKey: 'guideDraw1Body',
      preferredSide: 'right',
    },
    {
      id: 'draw-2',
      selector: '[data-tour="draw-add-frame"]',
      titleKey: 'guideDraw2Title',
      bodyKey: 'guideDraw2Body',
      preferredSide: 'top',
    },
    {
      id: 'draw-3',
      selector: '[data-tour="draw-play"]',
      titleKey: 'guideDraw3Title',
      bodyKey: 'guideDraw3Body',
      preferredSide: 'top',
    },
  ],
  paper: [
    {
      id: 'paper-1',
      selector: '[data-tour="paper-sample"]',
      fallbackSelector: '[data-tour="paper-stage"]',
      titleKey: 'guidePaper1Title',
      bodyKey: 'guidePaper1Body',
      preferredSide: 'bottom',
    },
    {
      id: 'paper-2',
      selector: '[data-tour="paper-stage"]',
      titleKey: 'guidePaper2Title',
      bodyKey: 'guidePaper2Body',
      preferredSide: 'left',
    },
    {
      id: 'paper-3',
      selector: '[data-tour="paper-commit"]',
      fallbackSelector: '[data-tour="paper-stage"]',
      titleKey: 'guidePaper3Title',
      bodyKey: 'guidePaper3Body',
      preferredSide: 'top',
    },
  ],
  puppet: [
    {
      id: 'puppet-1',
      selector: '[data-tour="puppet-moves"]',
      titleKey: 'guidePuppet1Title',
      bodyKey: 'guidePuppet1Body',
      preferredSide: 'left',
    },
    {
      id: 'puppet-2',
      selector: '[data-tour="puppet-voice-tab"]',
      titleKey: 'guidePuppet2Title',
      bodyKey: 'guidePuppet2Body',
      preferredSide: 'left',
    },
    {
      id: 'puppet-3',
      selector: '[data-tour="puppet-export"]',
      titleKey: 'guidePuppet3Title',
      bodyKey: 'guidePuppet3Body',
      preferredSide: 'top',
    },
  ],
  film: [
    {
      id: 'film-1',
      selector: '[data-tour="film-story"]',
      titleKey: 'guideFilm1Title',
      bodyKey: 'guideFilm1Body',
      preferredSide: 'right',
    },
    {
      id: 'film-2',
      selector: '[data-tour="film-look-tab"]',
      titleKey: 'guideFilm2Title',
      bodyKey: 'guideFilm2Body',
      preferredSide: 'right',
    },
    {
      id: 'film-3',
      selector: '[data-tour="film-play"]',
      titleKey: 'guideFilm3Title',
      bodyKey: 'guideFilm3Body',
      preferredSide: 'top',
    },
  ],
};

const TOUR_STORAGE_KEY = 'kagit:tour-progress:v1';

export interface TourProgressSnapshot {
  completed: StudioMode[];
  guideSeen: boolean;
}

export function loadTourProgress(): TourProgressSnapshot {
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return { completed: [], guideSeen: false };
    const parsed = JSON.parse(raw) as Partial<TourProgressSnapshot>;
    const valid = Array.isArray(parsed.completed)
      ? parsed.completed.filter((m): m is StudioMode => ALL_TOUR_MODES.includes(m as StudioMode))
      : [];
    return {
      completed: Array.from(new Set(valid)),
      guideSeen: Boolean(parsed.guideSeen),
    };
  } catch {
    return { completed: [], guideSeen: false };
  }
}

export function saveTourProgress(snapshot: TourProgressSnapshot): void {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage quota / private mode errors
  }
}
