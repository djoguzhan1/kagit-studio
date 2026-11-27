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
import type {
  RigWorkerFullPackPayload,
  RigWorkerRequest,
  RigWorkerResponse,
} from './rigWorker';

/**
 * Cancellable, Coalescing Client Queue for INKTROPE V4 Dedicated Rig Web Worker.
 * - Runs heavy character topology & skinning strictly off-main-thread in browsers (0 ms UI freeze!).
 * - Supports `channelKey` superseding: rapid pin/scissor/weight-brush edits automatically drop
 *   unstarted queued builds on the same channel so worker backlog never accumulates.
 * - Supports `AbortSignal` & explicit `cancelRigChannel(channelKey)`.
 * - Gracefully falls back to synchronous execution in Node/Vitest or restricted WebViews.
 */

interface QueuedRigJob {
  id: number;
  channelKey?: string;
  signal?: AbortSignal;
  buildRequest: () => { req: RigWorkerRequest; transfer: Transferable[] };
  resolve: (res: RigWorkerResponse) => void;
  reject: (err: Error) => void;
  cancelled: boolean;
}

let _worker: Worker | null = null;
let _workerDisabled = false;
let _nextId = 1;
let _inFlightJob: QueuedRigJob | null = null;
const _queue: QueuedRigJob[] = [];
const _latestChannelReqId = new Map<string, number>();

function makeAbortError(): Error {
  const err = new Error('RigWorker request superseded or cancelled');
  err.name = 'AbortError';
  return err;
}

function pumpQueue(): void {
  if (_inFlightJob) return;
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    while (_queue.length > 0) {
      const job = _queue.shift()!;
      job.reject(new Error('RigWorker unavailable'));
    }
    return;
  }

  while (_queue.length > 0) {
    const next = _queue.shift()!;
    if (next.cancelled || next.signal?.aborted) {
      next.reject(makeAbortError());
      continue;
    }
    if (next.channelKey && (_latestChannelReqId.get(next.channelKey) ?? 0) > next.id) {
      next.reject(makeAbortError());
      continue;
    }
    _inFlightJob = next;
    try {
      const { req, transfer } = next.buildRequest();
      worker.postMessage(req, transfer);
      return;
    } catch (err) {
      _inFlightJob = null;
      next.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

function getOrSpawnRigWorker(): Worker | null {
  if (_workerDisabled || typeof Worker === 'undefined' || typeof window === 'undefined') {
    return null;
  }
  if (_worker) return _worker;
  try {
    const w = new Worker(new URL('./rigWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<RigWorkerResponse>) => {
      const res = evt.data;
      const active = _inFlightJob;
      if (active && active.id === res.id) {
        _inFlightJob = null;
        const superseded =
          active.cancelled ||
          Boolean(active.signal?.aborted) ||
          Boolean(active.channelKey && (_latestChannelReqId.get(active.channelKey) ?? 0) > active.id);
        if (superseded) {
          active.reject(makeAbortError());
        } else {
          active.resolve(res);
        }
      }
      pumpQueue();
    };
    w.onerror = () => {
      _workerDisabled = true;
      _worker = null;
      if (_inFlightJob) {
        const cur = _inFlightJob;
        _inFlightJob = null;
        cur.reject(new Error('RigWorker failed'));
      }
      while (_queue.length > 0) {
        _queue.shift()!.reject(new Error('RigWorker failed'));
      }
    };
    _worker = w;
    return w;
  } catch {
    _workerDisabled = true;
    return null;
  }
}

/** Cancels any queued or in-flight rig worker requests matching `channelKey` */
export function cancelRigChannel(channelKey: string): void {
  const bumpId = _nextId++;
  _latestChannelReqId.set(channelKey, bumpId);
  for (let i = _queue.length - 1; i >= 0; i--) {
    if (_queue[i].channelKey === channelKey) {
      const [removed] = _queue.splice(i, 1);
      removed.cancelled = true;
      removed.reject(makeAbortError());
    }
  }
  if (_inFlightJob && _inFlightJob.channelKey === channelKey) {
    _inFlightJob.cancelled = true;
  }
}

function enqueueWorkerRequest(
  buildRequest: (id: number) => { req: RigWorkerRequest; transfer: Transferable[] },
  opts?: { channelKey?: string; signal?: AbortSignal }
): Promise<RigWorkerResponse> {
  const id = _nextId++;
  const channelKey = opts?.channelKey;
  if (channelKey) {
    _latestChannelReqId.set(channelKey, id);
    // Drop any unstarted older jobs on the same channel immediately!
    for (let i = _queue.length - 1; i >= 0; i--) {
      if (_queue[i].channelKey === channelKey) {
        const [stale] = _queue.splice(i, 1);
        stale.cancelled = true;
        stale.reject(makeAbortError());
      }
    }
    if (_inFlightJob && _inFlightJob.channelKey === channelKey) {
      _inFlightJob.cancelled = true;
    }
  }

  return new Promise<RigWorkerResponse>((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const job: QueuedRigJob = {
      id,
      channelKey,
      signal: opts?.signal,
      buildRequest: () => buildRequest(id),
      resolve,
      reject,
      cancelled: false,
    };
    if (opts?.signal) {
      opts.signal.addEventListener(
        'abort',
        () => {
          job.cancelled = true;
          const qIdx = _queue.indexOf(job);
          if (qIdx >= 0) {
            _queue.splice(qIdx, 1);
            reject(makeAbortError());
          }
        },
        { once: true }
      );
    }
    _queue.push(job);
    pumpQueue();
  });
}

export async function buildFullRigPackInWorkerAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  anatomy: DrawingAnatomy,
  opts?: {
    creatureClass?: UniversalCreatureClass;
    meshOptions?: ConformingMeshBuildOptions;
    channelKey?: string;
    signal?: AbortSignal;
  }
): Promise<RigWorkerFullPackPayload | null> {
  const worker = getOrSpawnRigWorker();
  if (!worker) return null;

  try {
    const res = await enqueueWorkerRequest(
      (id) => {
        const copy = new Uint8ClampedArray(rgba);
        const req: RigWorkerRequest = {
          id,
          kind: 'build-full-pack',
          width,
          height,
          rgbaBuffer: copy.buffer,
          anatomy,
          creatureClass: opts?.creatureClass,
          meshOptions: opts?.meshOptions,
        };
        return { req, transfer: [copy.buffer] };
      },
      { channelKey: opts?.channelKey, signal: opts?.signal }
    );
    if (res.ok && res.fullPack) {
      return res.fullPack;
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
  }
  return null;
}

export async function buildHumanoidMeshAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  anatomy: DrawingAnatomy,
  meshOptions?: ConformingMeshBuildOptions,
  opts?: { channelKey?: string; signal?: AbortSignal }
): Promise<ConformingSkinnedMesh | null> {
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    return buildConformingSkinnedMeshRGBA(rgba, width, height, anatomy, meshOptions);
  }
  try {
    const res = await enqueueWorkerRequest(
      (id) => {
        const copy = new Uint8ClampedArray(rgba);
        const req: RigWorkerRequest = {
          id,
          kind: 'build-humanoid-mesh',
          width,
          height,
          rgbaBuffer: copy.buffer,
          anatomy,
          meshOptions,
        };
        return { req, transfer: [copy.buffer] };
      },
      opts
    );
    if (res.ok) return res.mesh ?? null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }
  return buildConformingSkinnedMeshRGBA(rgba, width, height, anatomy, meshOptions);
}

export async function buildCreatureMeshAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  anatomy: DrawingAnatomy,
  creatureClass: UniversalCreatureClass,
  meshOptions?: ConformingMeshBuildOptions,
  opts?: { channelKey?: string; signal?: AbortSignal }
): Promise<ConformingSkinnedMesh | null> {
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    return buildUniversalCreatureMeshRGBA(rgba, width, height, anatomy, creatureClass, meshOptions);
  }
  try {
    const res = await enqueueWorkerRequest(
      (id) => {
        const copy = new Uint8ClampedArray(rgba);
        const req: RigWorkerRequest = {
          id,
          kind: 'build-creature-mesh',
          width,
          height,
          rgbaBuffer: copy.buffer,
          anatomy,
          creatureClass,
          meshOptions,
        };
        return { req, transfer: [copy.buffer] };
      },
      opts
    );
    if (res.ok) return res.mesh ?? null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }
  return buildUniversalCreatureMeshRGBA(rgba, width, height, anatomy, creatureClass, meshOptions);
}

export async function buildSilhouetteMeshAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: { channelKey?: string; signal?: AbortSignal }
): Promise<ConformingSkinnedMesh | null> {
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    return buildSilhouetteConformingMeshRGBA(rgba, width, height);
  }
  try {
    const res = await enqueueWorkerRequest(
      (id) => {
        const copy = new Uint8ClampedArray(rgba);
        const req: RigWorkerRequest = {
          id,
          kind: 'build-silhouette-mesh',
          width,
          height,
          rgbaBuffer: copy.buffer,
        };
        return { req, transfer: [copy.buffer] };
      },
      opts
    );
    if (res.ok) return res.mesh ?? null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }
  return buildSilhouetteConformingMeshRGBA(rgba, width, height);
}

export async function computeDepthAndNormalAsync(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: { channelKey?: string; signal?: AbortSignal }
): Promise<{ depthRgba: Uint8ClampedArray; normalRgba: Uint8ClampedArray }> {
  const worker = getOrSpawnRigWorker();
  if (!worker) {
    return computeDepthAndNormalRGBA(rgba, width, height);
  }
  try {
    const res = await enqueueWorkerRequest(
      (id) => {
        const copy = new Uint8ClampedArray(rgba);
        const req: RigWorkerRequest = {
          id,
          kind: 'compute-normals',
          width,
          height,
          rgbaBuffer: copy.buffer,
        };
        return { req, transfer: [copy.buffer] };
      },
      opts
    );
    if (res.ok && res.depthBuffer && res.normalBuffer) {
      return {
        depthRgba: new Uint8ClampedArray(res.depthBuffer),
        normalRgba: new Uint8ClampedArray(res.normalBuffer),
      };
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }
  return computeDepthAndNormalRGBA(rgba, width, height);
}
