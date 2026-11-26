import type { DrawingAnatomy } from './cartoonMotionEngine';
import {
  buildConformingSkinnedMeshRGBA,
  buildSilhouetteConformingMeshRGBA,
  type ConformingMeshBuildOptions,
  type ConformingSkinnedMesh,
  type UniversalCreatureClass,
} from './conformingMeshEngine';
import { buildUniversalCreatureMeshRGBA } from './universalCreatureRig';
import { computeDepthAndNormalRGBA } from './normalMapEngine';
import type { RigWorkerRequest, RigWorkerResponse } from './rigWorker';

/**
 * Client wrapper for INKTROPE V3 Dedicated Rig Web Worker.
 * Runs non-blocking off-main-thread in browsers (zero UI freeze on mobile!)
 * and gracefully falls back to direct synchronous execution in Node/Vitest or restricted WebViews.
 */

let _worker: Worker | null = null;
let _workerDisabled = false;
let _nextId = 1;
const _pending = new Map<
  number,
  { resolve: (res: RigWorkerResponse) => void; reject: (err: Error) => void }
>();

function getOrSpawnRigWorker(): Worker | null {
  if (_workerDisabled || typeof Worker === 'undefined' || typeof window === 'undefined') {
    return null;
  }
  if (_worker) return _worker;
  try {
    const w = new Worker(new URL('./rigWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<RigWorkerResponse>) => {
      const res = evt.data;
      const job = _pending.get(res.id);
      if (!job) return;
      _pending.delete(res.id);
      job.resolve(res);
    };
    w.onerror = () => {
      _workerDisabled = true;
      _worker = null;
      _pending.forEach((job) => job.reject(new Error('RigWorker failed')));
      _pending.clear();
    };
    _worker = w;
    return w;
  } catch {
    _workerDisabled = true;
    return null;
  }
}

export async function buildHumanoidMeshAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  anatomy: DrawingAnatomy,
  meshOptions?: ConformingMeshBuildOptions
): Promise<ConformingSkinnedMesh | null> {
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    return buildConformingSkinnedMeshRGBA(rgba, width, height, anatomy, meshOptions);
  }
  const id = _nextId++;
  const copy = new Uint8ClampedArray(rgba);
  try {
    const res = await new Promise<RigWorkerResponse>((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      const msg: RigWorkerRequest = {
        id,
        kind: 'build-humanoid-mesh',
        width,
        height,
        rgbaBuffer: copy.buffer,
        anatomy,
        meshOptions,
      };
      worker.postMessage(msg, [copy.buffer]);
    });
    if (res.ok) return res.mesh ?? null;
  } catch {
    // Graceful synchronous fallback
  }
  return buildConformingSkinnedMeshRGBA(rgba, width, height, anatomy, meshOptions);
}

export async function buildCreatureMeshAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  anatomy: DrawingAnatomy,
  creatureClass: UniversalCreatureClass,
  meshOptions?: ConformingMeshBuildOptions
): Promise<ConformingSkinnedMesh | null> {
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    return buildUniversalCreatureMeshRGBA(rgba, width, height, anatomy, creatureClass, meshOptions);
  }
  const id = _nextId++;
  const copy = new Uint8ClampedArray(rgba);
  try {
    const res = await new Promise<RigWorkerResponse>((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      const msg: RigWorkerRequest = {
        id,
        kind: 'build-creature-mesh',
        width,
        height,
        rgbaBuffer: copy.buffer,
        anatomy,
        creatureClass,
        meshOptions,
      };
      worker.postMessage(msg, [copy.buffer]);
    });
    if (res.ok) return res.mesh ?? null;
  } catch {
    // Fallback
  }
  return buildUniversalCreatureMeshRGBA(rgba, width, height, anatomy, creatureClass, meshOptions);
}

export async function buildSilhouetteMeshAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Promise<ConformingSkinnedMesh | null> {
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    return buildSilhouetteConformingMeshRGBA(rgba, width, height);
  }
  const id = _nextId++;
  const copy = new Uint8ClampedArray(rgba);
  try {
    const res = await new Promise<RigWorkerResponse>((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      const msg: RigWorkerRequest = {
        id,
        kind: 'build-silhouette-mesh',
        width,
        height,
        rgbaBuffer: copy.buffer,
      };
      worker.postMessage(msg, [copy.buffer]);
    });
    if (res.ok) return res.mesh ?? null;
  } catch {
    // Fallback
  }
  return buildSilhouetteConformingMeshRGBA(rgba, width, height);
}

export async function computeDepthAndNormalAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Promise<{ depthRgba: Uint8ClampedArray; normalRgba: Uint8ClampedArray }> {
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    return computeDepthAndNormalRGBA(rgba, width, height);
  }
  const id = _nextId++;
  const copy = new Uint8ClampedArray(rgba);
  try {
    const res = await new Promise<RigWorkerResponse>((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      const msg: RigWorkerRequest = {
        id,
        kind: 'compute-normals',
        width,
        height,
        rgbaBuffer: copy.buffer,
      };
      worker.postMessage(msg, [copy.buffer]);
    });
    if (res.ok && res.depthBuffer && res.normalBuffer) {
      return {
        depthRgba: new Uint8ClampedArray(res.depthBuffer),
        normalRgba: new Uint8ClampedArray(res.normalBuffer),
      };
    }
  } catch {
    // Fallback
  }
  return computeDepthAndNormalRGBA(rgba, width, height);
}
