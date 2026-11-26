/**
 * INKTROPE First-Party Cloud Auth & Delta Sync Client (Cloudflare Workers + D1)
 * - Strictly optional: guest mode runs 100% locally with zero network dependency.
 * - Uses first-party HttpOnly; Secure; SameSite=Lax cookies on /api/* (zero localStorage tokens).
 * - Incremental delta sync: only uploads missing blobs & modified projects, downloads missing blobs on demand.
 */

import type { StudioProject } from '../types/studio';
import {
  collectAllReferencedBlobKeys,
  isBlobDirty,
  loadBlob,
  markBlobClean,
  saveBlob,
} from './db';

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  hasGoogle: boolean;
  hasPassword: boolean;
  createdAt: number;
}

export type CloudSyncStatus = 'guest' | 'idle' | 'syncing' | 'synced' | 'offline' | 'error';

export interface AuthMeResult {
  user: CloudUser | null;
  googleEnabled: boolean;
  apiAvailable: boolean;
}

interface CloudProjectsResponse {
  projects: Array<{
    id: string;
    name: string;
    updatedAt: string;
    project: StudioProject;
  }>;
  blobKeys: string[];
  totalBlobBytes: number;
}

const uploadedBlobCache = new Map<string, Set<string>>();
const pushedProjectStamp = new Map<string, Map<string, string>>();

export function resetCloudSyncMemo(userId?: string): void {
  if (userId) {
    uploadedBlobCache.delete(userId);
    pushedProjectStamp.delete(userId);
  } else {
    uploadedBlobCache.clear();
    pushedProjectStamp.clear();
  }
}

function getUserBlobMemo(userId: string): Set<string> {
  let set = uploadedBlobCache.get(userId);
  if (!set) {
    set = new Set();
    uploadedBlobCache.set(userId, set);
  }
  return set;
}

function getUserStampMemo(userId: string): Map<string, string> {
  let map = pushedProjectStamp.get(userId);
  if (!map) {
    map = new Map();
    pushedProjectStamp.set(userId, map);
  }
  return map;
}

async function parseJsonSafe<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchAuthMe(): Promise<AuthMeResult> {
  try {
    const res = await fetch('/api/auth/me', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) {
      return { user: null, googleEnabled: false, apiAvailable: false };
    }
    const data = await parseJsonSafe<{ user: CloudUser | null; googleEnabled: boolean }>(res);
    if (!data) return { user: null, googleEnabled: false, apiAvailable: false };
    return {
      user: data.user ?? null,
      googleEnabled: Boolean(data.googleEnabled),
      apiAvailable: true,
    };
  } catch {
    return { user: null, googleEnabled: false, apiAvailable: false };
  }
}

export async function registerWithEmail(payload: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ user: CloudUser; googleEnabled: boolean }> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe<{ user?: CloudUser; googleEnabled?: boolean; error?: string }>(res);
  if (!res.ok || !data?.user) {
    throw new Error(data?.error || 'Kayıt başarısız oldu.');
  }
  return { user: data.user, googleEnabled: Boolean(data.googleEnabled) };
}

export async function loginWithEmail(payload: {
  email: string;
  password: string;
}): Promise<{ user: CloudUser; googleEnabled: boolean }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe<{ user?: CloudUser; googleEnabled?: boolean; error?: string }>(res);
  if (!res.ok || !data?.user) {
    throw new Error(data?.error || 'Giriş başarısız oldu.');
  }
  return { user: data.user, googleEnabled: Boolean(data.googleEnabled) };
}

export async function logoutAccount(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  }).catch(() => {});
}

export async function deleteCloudAccount(): Promise<void> {
  const res = await fetch('/api/auth/account', {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = await parseJsonSafe<{ error?: string }>(res);
    throw new Error(data?.error || 'Hesap silinemedi.');
  }
}

export function getGoogleLoginUrl(): string {
  return '/api/auth/google/start';
}

export async function deleteCloudProject(userId: string, projectId: string): Promise<void> {
  getUserStampMemo(userId).delete(projectId);
  await fetch(`/api/cloud/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  }).catch(() => {});
}

function projectTimestamp(p: StudioProject): number {
  const ms = Date.parse(p.updatedAt || p.createdAt || '');
  return Number.isFinite(ms) ? ms : 0;
}

/** Checks whether a local guest project is only the unmodified auto-generated starter demo */
export function isStarterDemoProject(p: StudioProject): boolean {
  return (
    (p.name === 'Kağıt Uçak & Rüzgar' || p.name === 'Paper Plane & Wind') &&
    p.frames.length <= 12 &&
    !p.filmGraph &&
    (!p.meshRigs || p.meshRigs.length === 0)
  );
}

/**
 * Full bidirectional sync for the currently signed-in user:
 * 1. Pulls all cloud projects + existing cloud blob keys.
 * 2. Merges with local user-scoped projects (latest `updatedAt` wins per project ID).
 * 3. Downloads any cloud blobs missing from this device's local IndexedDB scope.
 * 4. Uploads any local blobs missing from the cloud + pushes newer local project JSON.
 */
export async function syncUserVault(
  userId: string,
  localProjects: StudioProject[]
): Promise<{
  mergedProjects: StudioProject[];
  changedLocally: boolean;
  totalBlobBytes: number;
}> {
  const res = await fetch('/api/cloud/projects', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Bulut erişim hatası (${res.status})`);
  }
  const remote = await parseJsonSafe<CloudProjectsResponse>(res);
  if (!remote) throw new Error('Bulut yanıtı okunamadı');

  const remoteBlobSet = getUserBlobMemo(userId);
  remoteBlobSet.clear();
  for (const k of remote.blobKeys || []) remoteBlobSet.add(k);

  const stampMemo = getUserStampMemo(userId);
  const localById = new Map(localProjects.map((p) => [p.id, p]));
  const remoteById = new Map((remote.projects || []).map((r) => [r.id, r.project]));

  const mergedMap = new Map<string, StudioProject>();
  const toPush: StudioProject[] = [];
  const remoteUpdatedProjects: StudioProject[] = [];
  let changedLocally = false;

  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
  for (const id of allIds) {
    const loc = localById.get(id);
    const rem = remoteById.get(id);
    if (loc && !rem) {
      mergedMap.set(id, loc);
      toPush.push(loc);
    } else if (!loc && rem) {
      mergedMap.set(id, rem);
      stampMemo.set(id, rem.updatedAt);
      remoteUpdatedProjects.push(rem);
      changedLocally = true;
    } else if (loc && rem) {
      const lt = projectTimestamp(loc);
      const rt = projectTimestamp(rem);
      if (rt > lt + 500) {
        mergedMap.set(id, rem);
        stampMemo.set(id, rem.updatedAt);
        remoteUpdatedProjects.push(rem);
        changedLocally = true;
      } else if (lt > rt + 500) {
        mergedMap.set(id, loc);
        toPush.push(loc);
      } else {
        mergedMap.set(id, loc);
        stampMemo.set(id, rem.updatedAt);
      }
    }
  }

  const mergedProjects = Array.from(mergedMap.values()).sort(
    (a, b) => projectTimestamp(b) - projectTimestamp(a)
  );

  // Download missing OR remotely-updated blobs (so overwriting strokes on another device syncs cleanly!)
  const remoteFreshBlobKeys = collectAllReferencedBlobKeys(remoteUpdatedProjects);
  const allRefs = collectAllReferencedBlobKeys(mergedProjects);
  for (const key of allRefs) {
    const localExisting = await loadBlob(key);
    const mustRefreshFromRemote = !localExisting || remoteFreshBlobKeys.has(key);
    if (mustRefreshFromRemote && remoteBlobSet.has(key)) {
      const bRes = await fetch(`/api/cloud/blobs/${encodeURIComponent(key)}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (bRes.ok) {
        const blob = await bRes.blob();
        if (blob.size > 0) {
          await saveBlob(blob, key);
          markBlobClean(key);
          changedLocally = true;
        }
      }
    }
  }

  // Upload missing OR locally-modified (dirty) blobs referenced by merged projects
  let totalBlobBytes = remote.totalBlobBytes || 0;
  for (const key of allRefs) {
    const needsUpload = !remoteBlobSet.has(key) || isBlobDirty(key);
    if (!needsUpload) continue;
    const blob = await loadBlob(key);
    if (!blob || blob.size === 0 || blob.size > 4 * 1024 * 1024) continue;
    const upRes = await fetch(`/api/cloud/blobs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
      },
      body: blob,
    });
    if (upRes.ok) {
      if (!remoteBlobSet.has(key)) totalBlobBytes += blob.size;
      remoteBlobSet.add(key);
      markBlobClean(key);
    }
  }

  // Upsert modified or new local projects
  for (const proj of toPush) {
    if (stampMemo.get(proj.id) === proj.updatedAt) continue;
    const putRes = await fetch(`/api/cloud/projects/${encodeURIComponent(proj.id)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: proj }),
    });
    if (putRes.ok) {
      stampMemo.set(proj.id, proj.updatedAt);
    }
  }

  // Prune orphaned cloud blobs silently if remote holds blobs no longer referenced
  if (remoteBlobSet.size > allRefs.size + 4) {
    void fetch('/api/cloud/blobs/gc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeKeys: Array.from(allRefs) }),
    }).catch(() => {});
  }

  return { mergedProjects, changedLocally, totalBlobBytes };
}

/** Lightweight incremental push after local edits (no full re-download needed!) */
export async function pushLocalChangesToCloud(
  userId: string,
  projects: StudioProject[]
): Promise<{ uploadedProjects: number; uploadedBlobs: number }> {
  const remoteBlobSet = getUserBlobMemo(userId);
  const stampMemo = getUserStampMemo(userId);
  const allRefs = collectAllReferencedBlobKeys(projects);

  let uploadedBlobs = 0;
  for (const key of allRefs) {
    const needsUpload = !remoteBlobSet.has(key) || isBlobDirty(key);
    if (!needsUpload) continue;
    const blob = await loadBlob(key);
    if (!blob || blob.size === 0 || blob.size > 4 * 1024 * 1024) continue;
    const upRes = await fetch(`/api/cloud/blobs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (upRes.ok) {
      remoteBlobSet.add(key);
      markBlobClean(key);
      uploadedBlobs++;
    }
  }

  let uploadedProjects = 0;
  for (const proj of projects) {
    if (stampMemo.get(proj.id) === proj.updatedAt) continue;
    const putRes = await fetch(`/api/cloud/projects/${encodeURIComponent(proj.id)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: proj }),
    });
    if (putRes.ok) {
      stampMemo.set(proj.id, proj.updatedAt);
      uploadedProjects++;
    }
  }

  return { uploadedProjects, uploadedBlobs };
}
