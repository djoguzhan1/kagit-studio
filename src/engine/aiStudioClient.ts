import type { UniversalActionId } from './universalCreatureRig';
import type { UniversalCreatureClass } from './conformingMeshEngine';
import type { CharacterViewAngle } from '../types/masterRig';
import type { FilmEmotionId } from '../types/film';

/**
 * INKTROPE V4 — Typed Client for Optional Cloudflare Workers AI & BYOK Gemini Services.
 *
 * - Default flow stays 100% client-side, instant, and $0 (never alters hand-drawn pixels!).
 * - Single-command film directing: POST /api/ai/direct-film (Llama 3.3 70B FP8 Fast, ~2.88s, 0 pixels touched)
 * - Strictly OPTIONAL side/back tracing guide: POST /api/ai/side-guide (FLUX.2 Klein 9B + SHA-256 cache + $19 hard cap)
 * - Optional BYOK Gemini key: stored ONLY in sessionStorage if user explicitly supplies it, never logged or saved on server!
 */

const BYOK_KEY_STORAGE = 'inktrope:byok-gemini-key';

export function getSavedByokGeminiKey(): string {
  try {
    return sessionStorage.getItem(BYOK_KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setSavedByokGeminiKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (!trimmed) {
      sessionStorage.removeItem(BYOK_KEY_STORAGE);
    } else {
      sessionStorage.setItem(BYOK_KEY_STORAGE, trimmed);
    }
  } catch {
    // ignore private browsing restrictions
  }
}

export interface AiStudioStatus {
  ok: boolean;
  aiAvailable: boolean;
  monthlyBudgetCapped: boolean;
  quotas: {
    directFilm: { used: number; limit: number; remaining: number };
    sideGuide: { used: number; limit: number; remaining: number };
  };
}

export interface DirectedActorTrack {
  actorId: string;
  action: UniversalActionId | string;
  emotion: FilmEmotionId;
  startX: number;
  endX: number;
  groundY: number;
  viewYawDeg: number;
  lookAtActorId: string | null;
  dialogue: string;
}

export interface DirectedShotPlan {
  title: string;
  durationSec: number;
  scene: string;
  camera: string;
  transition: 'cut' | 'dissolve' | 'dip-to-black';
  primaryActorId: string;
  narration: string;
  actorTracks: Record<string, DirectedActorTrack>;
}

export interface DirectedScreenplayResponse {
  ok: boolean;
  source?: string;
  code?: string;
  error?: string;
  screenplay?: {
    title: string;
    shots: DirectedShotPlan[];
  };
}

export interface SideGuideResponse {
  ok: boolean;
  cached?: boolean;
  source?: string;
  isMultiSheet?: boolean;
  imageDataUrl?: string;
  code?: string;
  error?: string;
}

export async function fetchAiStudioStatus(): Promise<AiStudioStatus | null> {
  try {
    const res = await fetch('/api/ai/status', { credentials: 'same-origin' });
    if (!res.ok) return null;
    return (await res.json()) as AiStudioStatus;
  } catch {
    return null;
  }
}

/**
 * Downscales any transparent character image onto a clean white square <= 448×448
 * (satisfies FLUX.2 Klein 9B's < 512×512 input image requirement cleanly & quickly!).
 */
export async function prepareReferenceDataUrlForAi(sourceDataUrl: string, maxDim = 448): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sw = img.naturalWidth || 448;
      const sh = img.naturalHeight || 448;
      const scale = Math.min(1, maxDim / Math.max(sw, sh));
      const dw = Math.max(64, Math.round(sw * scale));
      const dh = Math.max(64, Math.round(sh * scale));
      const c = document.createElement('canvas');
      c.width = maxDim;
      c.height = maxDim;
      const ctx = c.getContext('2d');
      if (!ctx) {
        resolve(sourceDataUrl);
        return;
      }
      // Pure white paper background helps FLUX.2 keep clean character silhouette separation
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, maxDim, maxDim);
      const ox = Math.round((maxDim - dw) * 0.5);
      const oy = Math.round((maxDim - dh) * 0.5);
      ctx.drawImage(img, ox, oy, dw, dh);
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => reject(new Error('Görsel okunamadı'));
    img.src = sourceDataUrl;
  });
}

export async function requestAiDirectedFilm(params: {
  prompt: string;
  locale: 'tr' | 'en';
  actors: Array<{ id: string; name: string; creatureClass: UniversalCreatureClass; viewCount: number }>;
  byokGeminiKey?: string;
}): Promise<DirectedScreenplayResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = (params.byokGeminiKey ?? getSavedByokGeminiKey()).trim();
  if (key) headers['X-User-Gemini-Key'] = key;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35_000);
    const res = await fetch('/api/ai/direct-film', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        prompt: params.prompt,
        locale: params.locale,
        actors: params.actors,
      }),
    });
    clearTimeout(timer);
    const data = (await res.json().catch(() => ({}))) as DirectedScreenplayResponse;
    if (!res.ok) {
      return { ok: false, code: data.code || `http_${res.status}`, error: data.error };
    }
    return data;
  } catch {
    return { ok: false, code: 'network_fallback' };
  }
}

export async function requestAiSideProfileGuide(params: {
  frontDataUrl: string;
  creatureClass: UniversalCreatureClass;
  targetAngle: Exclude<CharacterViewAngle, 'front'>;
  byokGeminiKey?: string;
  byokFullTurnaround?: boolean;
}): Promise<SideGuideResponse> {
  const prepared = await prepareReferenceDataUrlForAi(params.frontDataUrl, 448);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = (params.byokGeminiKey ?? getSavedByokGeminiKey()).trim();
  if (key) headers['X-User-Gemini-Key'] = key;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    const res = await fetch('/api/ai/side-guide', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        imageDataUrl: prepared,
        creatureClass: params.creatureClass,
        targetAngle: params.targetAngle,
        byokFullTurnaround: Boolean(params.byokFullTurnaround && key),
      }),
    });
    clearTimeout(timer);
    const data = (await res.json().catch(() => ({}))) as SideGuideResponse;
    if (!res.ok) {
      return { ok: false, code: data.code || `http_${res.status}`, error: data.error };
    }
    return data;
  } catch {
    return {
      ok: false,
      code: 'network_error',
      error: 'Bağlantı zaman aşımına uğradı. Masada çiz veya fotoğraf yükle sınırsız açık!',
    };
  }
}
