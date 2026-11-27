import { clear, get, set, setMany, del, keys } from 'idb-keyval';
import type { StudioProject } from '../types/studio';

const GUEST_PROJECTS_KEY = 'kagit:projects:v1';
const GUEST_BLOB_PREFIX = 'kagit:blob:';

let activeScope: string = 'guest';
const dirtyBlobsByScope = new Map<string, Set<string>>();

export function markBlobDirty(key: string): void {
  let set = dirtyBlobsByScope.get(activeScope);
  if (!set) {
    set = new Set();
    dirtyBlobsByScope.set(activeScope, set);
  }
  set.add(key);
}

export function isBlobDirty(key: string): boolean {
  return dirtyBlobsByScope.get(activeScope)?.has(key) ?? false;
}

export function markBlobClean(key: string): void {
  dirtyBlobsByScope.get(activeScope)?.delete(key);
}

function projectsKeyFor(scope: string): string {
  return scope === 'guest' ? GUEST_PROJECTS_KEY : `kagit:u:${scope}:projects:v1`;
}

function blobPrefixFor(scope: string): string {
  return scope === 'guest' ? GUEST_BLOB_PREFIX : `kagit:u:${scope}:blob:`;
}

/**
 * Switches local IndexedDB namespace between 'guest' and a signed-in user ID.
 * Clears all in-memory GPU ImageBitmaps & ObjectURLs immediately so zero textures
 * can ever bleed between two accounts sharing the same browser.
 */
export function setActiveStorageScope(scope: string): void {
  const next = scope && scope.trim() ? scope.trim() : 'guest';
  if (next !== activeScope) {
    clearAllMediaCaches();
    activeScope = next;
  }
}

export function getActiveStorageScope(): string {
  return activeScope;
}

/** Permanently wipes a single signed-in user's local IndexedDB cache on Sign Out (shared-device privacy) */
export async function clearScopedStorage(scope: string): Promise<void> {
  if (!scope || scope === 'guest') return;
  if (activeScope === scope) {
    clearAllMediaCaches();
  }
  const pKey = projectsKeyFor(scope);
  const bPrefix = blobPrefixFor(scope);
  try {
    await del(pKey);
    const all = await keys<string>();
    const toDelete = all.filter((k) => typeof k === 'string' && k.startsWith(bPrefix));
    await Promise.all(toDelete.map((k) => del(k)));
  } catch {
    // ignore storage delete failure
  }
}

/** Read-only peek into local guest notebooks so a newly signed-in user can optionally migrate them */
export async function loadGuestProjectsOnly(): Promise<StudioProject[]> {
  const stored = await get<StudioProject[]>(GUEST_PROJECTS_KEY);
  return Array.isArray(stored) ? stored : [];
}

export async function loadGuestBlob(key: string): Promise<Blob | null> {
  if (!key) return null;
  const blob = await get<Blob>(`${GUEST_BLOB_PREFIX}${key}`);
  return blob ?? null;
}

export class StorageQuotaError extends Error {
  constructor(message = 'Cihaz depolama alanı doldu — eski bir defteri sil veya .kagit.zip yedeği indir.') {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number; message?: string };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014 ||
    /quota/i.test(String(e.message ?? ''))
  );
}

/** Requests persistent browser storage so iOS/Android/Chrome won't evict user notebooks after 7 days! */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
      const already =
        typeof navigator.storage.persisted === 'function' ? await navigator.storage.persisted() : false;
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch {
    // ignore unsupported environments
  }
  return false;
}

/** Reports human-readable local storage usage (MB) for the Legal/Storage Transparency panel */
export async function getStorageUsageEstimate(): Promise<{
  usedMb: number;
  quotaMb: number | null;
  persisted: boolean;
}> {
  try {
    const persisted =
      typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persisted === 'function'
        ? await navigator.storage.persisted().catch(() => false)
        : false;
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      const usedMb = Number(((est.usage ?? 0) / (1024 * 1024)).toFixed(1));
      const quotaMb =
        typeof est.quota === 'number' && est.quota > 0
          ? Math.round(est.quota / (1024 * 1024))
          : null;
      return { usedMb, quotaMb, persisted };
    }
    return { usedMb: 0, quotaMb: null, persisted };
  } catch {
    return { usedMb: 0, quotaMb: null, persisted: false };
  }
}

/** KVKK / GDPR Right-to-Erasure: permanently clears all locally stored projects, media blobs & preferences */
export async function clearAllLocalStudioData(): Promise<void> {
  clearAllMediaCaches();
  try {
    await clear();
  } catch {
    // Fallback key-by-key delete if clear() fails
    try {
      const all = await keys<string>();
      await Promise.all(all.map((k) => del(k)));
    } catch {
      // ignore
    }
  }
  try {
    const rmKeys = [
      'kagit:ui-prefs:v1',
      'kagit:prefs:v1',
      'kagit:tour-progress:v1',
      'kagit:perf-pref:v1',
      'kagit:cloud-gpu-url:v1',
      'inktrope:byok-gemini-key',
    ];
    for (const k of rmKeys) localStorage.removeItem(k);
    sessionStorage.removeItem('kagit:desk-awakened:v3');
  } catch {
    // ignore
  }
}

/** Device-aware memory budget for decoded ImageBitmaps & Object URLs */
function getBitmapLimit(): number {
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  if (typeof mem === 'number' && mem <= 4) return 14;
  return 28;
}

const MAX_OBJECT_URLS = 48;

const bitmapLRU = new Map<string, ImageBitmap>();
const objectUrlLRU = new Map<string, string>();

export function makeId(prefix = 'k'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadAllProjects(): Promise<StudioProject[]> {
  const stored = await get<StudioProject[]>(projectsKeyFor(activeScope));
  return Array.isArray(stored) ? stored : [];
}

export async function saveAllProjects(projects: StudioProject[]): Promise<void> {
  const pKey = projectsKeyFor(activeScope);
  try {
    await set(pKey, projects);
  } catch (err) {
    if (isQuotaError(err)) {
      await sweepUnreferencedBlobs(projects).catch(() => {});
      try {
        await set(pKey, projects);
        return;
      } catch {
        throw new StorageQuotaError();
      }
    }
    throw err;
  }
}

export async function saveBlob(blob: Blob, existingKey?: string): Promise<string> {
  const key = existingKey ?? makeId('blob');
  const fullKey = `${blobPrefixFor(activeScope)}${key}`;
  try {
    await set(fullKey, blob);
  } catch (err) {
    if (isQuotaError(err)) {
      // Reclaim orphaned blobs once before reporting quota full
      const projects = await loadAllProjects().catch(() => []);
      await sweepUnreferencedBlobs(projects).catch(() => {});
      try {
        await set(fullKey, blob);
      } catch {
        throw new StorageQuotaError();
      }
    } else {
      throw err;
    }
  }
  evictCacheKey(key);
  markBlobDirty(key);
  return key;
}

export async function saveBlobsBatch(items: { key: string; blob: Blob }[]): Promise<void> {
  if (items.length === 0) return;
  const prefix = blobPrefixFor(activeScope);
  const pairs: [IDBValidKey, Blob][] = items.map((it) => [`${prefix}${it.key}`, it.blob]);
  await setMany(pairs);
  for (const it of items) {
    evictCacheKey(it.key);
    markBlobDirty(it.key);
  }
}

export async function loadBlob(key: string): Promise<Blob | null> {
  if (!key) return null;
  const blob = await get<Blob>(`${blobPrefixFor(activeScope)}${key}`);
  return blob ?? null;
}

export async function deleteBlob(key: string): Promise<void> {
  if (!key) return;
  evictCacheKey(key);
  await del(`${blobPrefixFor(activeScope)}${key}`);
}

export function evictCacheKey(key: string): void {
  const existingBmp = bitmapLRU.get(key);
  if (existingBmp) {
    try {
      existingBmp.close();
    } catch {
      // already closed
    }
    bitmapLRU.delete(key);
  }
  const existingUrl = objectUrlLRU.get(key);
  if (existingUrl) {
    URL.revokeObjectURL(existingUrl);
    objectUrlLRU.delete(key);
  }
}

export function clearAllMediaCaches(): void {
  for (const bmp of bitmapLRU.values()) {
    try {
      bmp.close();
    } catch {
      // ignore
    }
  }
  bitmapLRU.clear();
  for (const url of objectUrlLRU.values()) {
    URL.revokeObjectURL(url);
  }
  objectUrlLRU.clear();
}

/** LRU-cached ObjectURL for UI thumbnails and reference sheets */
export async function getBlobObjectUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  const cached = objectUrlLRU.get(key);
  if (cached) {
    // refresh recency
    objectUrlLRU.delete(key);
    objectUrlLRU.set(key, cached);
    return cached;
  }
  const blob = await loadBlob(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrlLRU.set(key, url);
  while (objectUrlLRU.size > MAX_OBJECT_URLS) {
    const oldestKey = objectUrlLRU.keys().next().value;
    if (!oldestKey) break;
    const oldUrl = objectUrlLRU.get(oldestKey);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    objectUrlLRU.delete(oldestKey);
  }
  return url;
}

async function decodeBlobToBitmapSafely(blob: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Fallback for older Safari / WebKit builds on special image profiles
    }
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = async () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1;
        c.height = img.naturalHeight || 1;
        c.getContext('2d')?.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        if (typeof createImageBitmap === 'function') {
          resolve(await createImageBitmap(c));
        } else {
          resolve(null);
        }
      } catch {
        URL.revokeObjectURL(url);
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** LRU-cached GPU-decoded ImageBitmap for zero-stutter 60fps canvas rendering */
export async function getBlobBitmap(key: string | null | undefined): Promise<ImageBitmap | null> {
  if (!key) return null;
  const cached = bitmapLRU.get(key);
  if (cached) {
    bitmapLRU.delete(key);
    bitmapLRU.set(key, cached);
    return cached;
  }
  const blob = await loadBlob(key);
  if (!blob) return null;
  const bmp = await decodeBlobToBitmapSafely(blob);
  if (!bmp) return null;
  bitmapLRU.set(key, bmp);
  const limit = getBitmapLimit();
  while (bitmapLRU.size > limit) {
    const oldestKey = bitmapLRU.keys().next().value;
    if (!oldestKey) break;
    const oldBmp = bitmapLRU.get(oldestKey);
    if (oldBmp) {
      try {
        oldBmp.close();
      } catch {
        // ignore
      }
    }
    bitmapLRU.delete(oldestKey);
  }
  return bmp;
}

/**
 * Exhaustive collector of EVERY binary blob referenced anywhere in any project
 * (including multi-scene frames, paper originals, fixed backgrounds, FK rigs,
 * 2D Mesh Warp rigs, 1..6 multi-actor Film casts, audio tracks, and reference sheets).
 */
export function collectAllReferencedBlobKeys(projects: StudioProject[]): Set<string> {
  const refs = new Set<string>();
  const collectFrames = (frames: StudioProject['frames']) => {
    for (const frame of frames) {
      if (frame.thumbKey) refs.add(frame.thumbKey);
      if (frame.paperOriginalBlobKey) refs.add(frame.paperOriginalBlobKey);
      for (const layer of frame.layers) {
        if (layer.blobKey) refs.add(layer.blobKey);
      }
    }
  };

  const collectFilmActor = (
    actor: NonNullable<StudioProject['filmGraph']>['actor'] | null | undefined
  ) => {
    if (!actor) return;
    if (actor.sourceBlobKey) refs.add(actor.sourceBlobKey);
    if (actor.decomposed) {
      if (actor.decomposed.depthBlobKey) refs.add(actor.decomposed.depthBlobKey);
      if (actor.decomposed.normalBlobKey) refs.add(actor.decomposed.normalBlobKey);
      for (const pt of actor.decomposed.parts) {
        if (pt.blobKey) refs.add(pt.blobKey);
      }
    }
  };

  for (const project of projects) {
    if (project.backgroundBlobKey) refs.add(project.backgroundBlobKey);
    collectFrames(project.frames);
    if (project.scenes) {
      for (const sc of project.scenes) {
        if (sc.backgroundBlobKey) refs.add(sc.backgroundBlobKey);
        collectFrames(sc.frames);
      }
    }
    for (const rig of project.rigs) {
      if (rig.sourceBlobKey) refs.add(rig.sourceBlobKey);
      for (const part of rig.parts) {
        if (part.blobKey) refs.add(part.blobKey);
      }
    }
    if (project.meshRigs) {
      for (const mr of project.meshRigs) {
        if (mr.sourceBlobKey) refs.add(mr.sourceBlobKey);
      }
    }
    if (project.filmGraph) {
      const fg = project.filmGraph;
      collectFilmActor(fg.actor);
      if (fg.actors) {
        for (const castActor of fg.actors) {
          collectFilmActor(castActor);
        }
      }
      if (fg.world.customBgBlobKey) refs.add(fg.world.customBgBlobKey);
      if (fg.world.decomposedBg) {
        if (fg.world.decomposedBg.depthBlobKey) refs.add(fg.world.decomposedBg.depthBlobKey);
        for (const pl of fg.world.decomposedBg.planes) {
          if (pl.blobKey) refs.add(pl.blobKey);
        }
      }
      for (const sh of fg.shots) {
        if (sh.voiceTrack?.audioBlobKey) refs.add(sh.voiceTrack.audioBlobKey);
      }
    }
    if (project.audio?.blobKey) {
      refs.add(project.audio.blobKey);
    }
    for (const refItem of project.references) {
      if (refItem.blobKey) refs.add(refItem.blobKey);
    }
  }
  return refs;
}

/** Safely deletes only genuinely unreferenced IndexedDB blobs within the active account scope */
export async function sweepUnreferencedBlobs(projects: StudioProject[]): Promise<number> {
  const referenced = collectAllReferencedBlobKeys(projects);
  const prefix = blobPrefixFor(activeScope);
  const allKeys = await keys<string>();
  let removed = 0;
  for (const k of allKeys) {
    if (typeof k !== 'string' || !k.startsWith(prefix)) continue;
    const blobId = k.slice(prefix.length);
    if (!referenced.has(blobId)) {
      evictCacheKey(blobId);
      await del(k);
      removed++;
    }
  }
  return removed;
}

export async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas PNG dönüştürülemedi'))),
      'image/png'
    );
  });
}

export async function canvasToWebpOrJpegBlob(
  canvas: HTMLCanvasElement,
  quality = 0.88
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) return resolve(b);
        canvas.toBlob(
          (fb) => (fb ? resolve(fb) : reject(new Error('Görsel dönüştürülemedi'))),
          'image/jpeg',
          quality
        );
      },
      'image/webp',
      quality
    );
  });
}
