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

/**
 * INKTROPE V3 Dedicated Rig Construction Web Worker
 * -------------------------------------------------
 * Runs heavy character topology (256-320px Ink-Watershed), Adaptive CDT triangulation,
 * BBW/CoR weight computation, socket inpainting, and 2.5D Sobel normal-map generation
 * strictly off the UI thread with zero-copy ArrayBuffer transfers!
 *
 * Guarantees 0 ms UI jank even on low-end mobile phones & GPU-free laptops!
 */

export interface RigWorkerRequest {
  id: number;
  kind: 'build-humanoid-mesh' | 'build-creature-mesh' | 'build-silhouette-mesh' | 'compute-normals';
  width: number;
  height: number;
  rgbaBuffer: ArrayBuffer;
  anatomy?: DrawingAnatomy;
  creatureClass?: UniversalCreatureClass;
  meshOptions?: ConformingMeshBuildOptions;
}

export interface RigWorkerResponse {
  id: number;
  ok: boolean;
  mesh?: ConformingSkinnedMesh | null;
  normalBuffer?: ArrayBuffer;
  depthBuffer?: ArrayBuffer;
  elapsedMs: number;
  error?: string;
}

function collectMeshTransferables(mesh: ConformingSkinnedMesh | null): Transferable[] {
  if (!mesh) return [];
  const list: Transferable[] = [
    mesh.restUV.buffer,
    mesh.boneIndices.buffer,
    mesh.boneWeights.buffer,
    mesh.vertexShade.buffer,
    mesh.vertexShadeMirrored.buffer,
    mesh.vertexRegion.buffer,
    mesh.triangles.buffer,
    mesh.triangleLayer.buffer,
    mesh.trianglesMirrored.buffer,
  ];
  const ext = mesh as ConformingSkinnedMesh & {
    corUV?: Float32Array;
    inpaintedBackRgba?: Uint8ClampedArray;
    inpaintedSocketOnlyRgba?: Uint8ClampedArray;
  };
  if (ext.corUV) list.push(ext.corUV.buffer);
  if (ext.inpaintedBackRgba) list.push(ext.inpaintedBackRgba.buffer);
  if (ext.inpaintedSocketOnlyRgba) list.push(ext.inpaintedSocketOnlyRgba.buffer);
  // Deduplicate shared buffers safely
  return Array.from(new Set(list));
}

if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
  self.onmessage = (evt: MessageEvent<RigWorkerRequest>) => {
    const req = evt.data;
    const t0 = performance.now();
    try {
      const rgba = new Uint8ClampedArray(req.rgbaBuffer);
      if (req.kind === 'build-humanoid-mesh' && req.anatomy) {
        const mesh = buildConformingSkinnedMeshRGBA(rgba, req.width, req.height, req.anatomy, req.meshOptions);
        const resp: RigWorkerResponse = {
          id: req.id,
          ok: true,
          mesh,
          elapsedMs: performance.now() - t0,
        };
        (self as unknown as Worker).postMessage(resp, collectMeshTransferables(mesh));
      } else if (req.kind === 'build-creature-mesh' && req.anatomy && req.creatureClass) {
        const mesh = buildUniversalCreatureMeshRGBA(
          rgba,
          req.width,
          req.height,
          req.anatomy,
          req.creatureClass,
          req.meshOptions
        );
        const resp: RigWorkerResponse = {
          id: req.id,
          ok: true,
          mesh,
          elapsedMs: performance.now() - t0,
        };
        (self as unknown as Worker).postMessage(resp, collectMeshTransferables(mesh));
      } else if (req.kind === 'build-silhouette-mesh') {
        const mesh = buildSilhouetteConformingMeshRGBA(rgba, req.width, req.height);
        const resp: RigWorkerResponse = {
          id: req.id,
          ok: true,
          mesh,
          elapsedMs: performance.now() - t0,
        };
        (self as unknown as Worker).postMessage(resp, collectMeshTransferables(mesh));
      } else if (req.kind === 'compute-normals') {
        const { depthRgba, normalRgba } = computeDepthAndNormalRGBA(rgba, req.width, req.height);
        const depthBuf = depthRgba.buffer as ArrayBuffer;
        const normalBuf = normalRgba.buffer as ArrayBuffer;
        const resp: RigWorkerResponse = {
          id: req.id,
          ok: true,
          depthBuffer: depthBuf,
          normalBuffer: normalBuf,
          elapsedMs: performance.now() - t0,
        };
        (self as unknown as Worker).postMessage(resp, [depthBuf, normalBuf]);
      } else {
        const resp: RigWorkerResponse = {
          id: req.id,
          ok: false,
          elapsedMs: performance.now() - t0,
          error: 'Unknown rig worker request',
        };
        (self as unknown as Worker).postMessage(resp);
      }
    } catch (err) {
      const resp: RigWorkerResponse = {
        id: req.id,
        ok: false,
        elapsedMs: performance.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
      (self as unknown as Worker).postMessage(resp);
    }
  };
}
