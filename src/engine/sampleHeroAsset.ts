/**
 * Shared Official Studio Sample Mascot Asset ("Şapkalı Baron" / "Horned Baron")
 * ----------------------------------------------------------------------------
 * Extracted directly from a real hand-drawn sketchbook photo via KÂĞIT's own
 * 5-Stage Automatic Character Extraction Engine and bundled as a crisp transparent
 * PNG (`public/assets/sample-hero.png`) so ALL 4 studios (Ana Ekran, Canlı Kukla,
 * Mini Film Yönet, Kâğıt Kamera) share the exact same iconic mascot at 0ms latency!
 */

export const SAMPLE_HERO_NAME_TR = 'Şapkalı Baron';
export const SAMPLE_HERO_NAME_EN = 'Horned Baron';

export function getSampleHeroAssetUrl(): string {
  const base =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    typeof import.meta.env.BASE_URL === 'string'
      ? import.meta.env.BASE_URL
      : '/';
  const cleanBase = base.endsWith('/') ? base : `${base}/`;
  return `${cleanBase}assets/sample-hero.png?v=2`;
}

let cachedCanvas: HTMLCanvasElement | null = null;
let loadPromise: Promise<HTMLCanvasElement | null> | null = null;
const readyListeners = new Set<() => void>();

/** Synchronous lookup: returns the decoded mascot canvas if already loaded in memory */
export function getCachedSampleHeroCanvas(): HTMLCanvasElement | null {
  return cachedCanvas;
}

/** Subscribe to mascot load completion (fires immediately if already cached!) */
export function onSampleHeroReady(cb: () => void): () => void {
  if (cachedCanvas) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  void preloadSampleHeroCanvas();
  return () => {
    readyListeners.delete(cb);
  };
}

/** Loads & caches `/assets/sample-hero.png` once in browser (100% safe in Node/Vitest!) */
export function preloadSampleHeroCanvas(): Promise<HTMLCanvasElement | null> {
  if (cachedCanvas) return Promise.resolve(cachedCanvas);
  if (loadPromise) return loadPromise;

  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof Image === 'undefined'
  ) {
    return Promise.resolve(null);
  }

  loadPromise = new Promise<HTMLCanvasElement | null>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const w = Math.max(32, img.naturalWidth || img.width || 542);
        const h = Math.max(32, img.naturalHeight || img.height || 640);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          cachedCanvas = c;
          readyListeners.forEach((fn) => {
            try {
              fn();
            } catch {
              // ignore subscriber errors
            }
          });
          readyListeners.clear();
          resolve(c);
          return;
        }
      } catch {
        // fallback gracefully
      }
      resolve(null);
    };
    img.onerror = () => {
      loadPromise = null;
      resolve(null);
    };
    img.src = getSampleHeroAssetUrl();
  });

  return loadPromise;
}

// Kick off instant warm preload in browser so every studio opens with 0ms delay!
if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
  void preloadSampleHeroCanvas();
}
