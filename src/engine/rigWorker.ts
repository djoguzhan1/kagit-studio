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
import {
  prepareRigPackBaseRGBA,
  resolveCreatureClassFromBaseRGBA,
  type LimbPartId,
  type PreparedRigPackBaseRGBA,
} from './skeletonSkinEngine';

/**
 * INKTROPE V4 Dedicated Rig Construction Web Worker
 * -------------------------------------------------
 * Runs full character base extraction (`prepareRigPackBaseRGBA`), 256-320px Ink-Watershed
 * topology, Adaptive CDT triangulation, BBW/CoR weight computation, multi-bone socket inpainting,
 * and Felzenszwalb-Huttenlocher EDT normal-map generation strictly off the UI thread!
 */

export interface RigWorkerRequest {
  id: number;
  kind:
    | 'build-full-pack'
    | 'build-humanoid-mesh'
    | 'build-creature-mesh'
    | 'build-silhouette-mesh'
    | 'compute-normals';
  width: number;
  height: number;
  rgbaBuffer: ArrayBuffer;
  anatomy?: DrawingAnatomy;
  creatureClass?: UniversalCreatureClass;
  meshOptions?: ConformingMeshBuildOptions;
}

export interface RigWorkerFullPackPayload {
  base: PreparedRigPackBaseRGBA;
  creatureClass: UniversalCreatureClass;
  skinnedMesh: ConformingSkinnedMesh | null;
  silhouetteMesh: ConformingSkinnedMesh | null;
}

export interface RigWorkerResponse {
  id: number;
  ok: boolean;
  mesh?: ConformingSkinnedMesh | null;
  fullPack?: RigWorkerFullPackPayload;
  normalBuffer?: ArrayBuffer;
  depthBuffer?: ArrayBuffer;
  elapsedMs: number;
  error?: string;
}

function collectMeshTransferables(mesh: ConformingSkinnedMesh | null, into: Set<Transferable>): void {
  if (!mesh) return;
  into.add(mesh.restUV.buffer);
  into.add(mesh.boneIndices.buffer);
  into.add(mesh.boneWeights.buffer);
  into.add(mesh.vertexShade.buffer);
  into.add(mesh.vertexShadeMirrored.buffer);
  into.add(mesh.vertexRegion.buffer);
  into.add(mesh.triangles.buffer);
  into.add(mesh.triangleLayer.buffer);
  into.add(mesh.trianglesMirrored.buffer);
  if (mesh.corUV) into.add(mesh.corUV.buffer);
  if (mesh.inpaintedSocketOnlyRgba) into.add(mesh.inpaintedSocketOnlyRgba.buffer);
  if (mesh.inpaintedSubPatches) {
    for (const sp of mesh.inpaintedSubPatches) {
      if (sp.rgba.byteLength > 0) into.add(sp.rgba.buffer);
    }
  }
}

function collectBaseTransferables(base: PreparedRigPackBaseRGBA, into: Set<Transferable>): void {
  if (base.filledRgba.byteLength > 0) into.add(base.filledRgba.buffer);
  if (base.nightFilledRgba.byteLength > 0) into.add(base.nightFilledRgba.buffer);
  const partIds: LimbPartId[] = ['head', 'torso', 'arm_l', 'arm_r', 'leg_l', 'leg_r'];
  for (const id of partIds) {
    const p = base.partsRgba[id];
    if (!p) continue;
    if (p.rgba.byteLength > 0) into.add(p.rgba.buffer);
    if (p.darkRgba.byteLength > 0) into.add(p.darkRgba.buffer);
    if (p.nightRgba.byteLength > 0) into.add(p.nightRgba.buffer);
    if (p.nightFarRgba.byteLength > 0) into.add(p.nightFarRgba.buffer);
  }
}

if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
  self.onmessage = (evt: MessageEvent<RigWorkerRequest>) => {
    const req = evt.data;
    const t0 = performance.now();
    try {
      const rgba = new Uint8ClampedArray(req.rgbaBuffer);
      if (req.kind === 'build-full-pack' && req.anatomy) {
        const base = prepareRigPackBaseRGBA(rgba, req.width, req.height, req.anatomy);
        const creatureClass = resolveCreatureClassFromBaseRGBA(base, req.creatureClass);
        const skinnedMesh =
          creatureClass === 'humanoid'
            ? buildConformingSkinnedMeshRGBA(base.filledRgba, base.sw, base.sh, base.anatomy, req.meshOptions)
            : buildUniversalCreatureMeshRGBA(
                base.filledRgba,
                base.sw,
                base.sh,
                base.anatomy,
                creatureClass,
                req.meshOptions
              );
        const silhouetteMesh =
          skinnedMesh ?? buildSilhouetteConformingMeshRGBA(base.filledRgba, base.sw, base.sh);

        const xfer = new Set<Transferable>();
        collectBaseTransferables(base, xfer);
        collectMeshTransferables(skinnedMesh, xfer);
        if (silhouetteMesh && silhouetteMesh !== skinnedMesh) {
          collectMeshTransferables(silhouetteMesh, xfer);
        }

        const resp: RigWorkerResponse = {
          id: req.id,
          ok: true,
          fullPack: {
            base,
            creatureClass,
            skinnedMesh,
            silhouetteMesh,
          },
          elapsedMs: performance.now() - t0,
        };
        (self as unknown as Worker).postMessage(resp, Array.from(xfer));
      } else if (req.kind === 'build-humanoid-mesh' && req.anatomy) {
        const mesh = buildConformingSkinnedMeshRGBA(rgba, req.width, req.height, req.anatomy, req.meshOptions);
        const xfer = new Set<Transferable>();
        collectMeshTransferables(mesh, xfer);
        const resp: RigWorkerResponse = {
          id: req.id,
          ok: true,
          mesh,
          elapsedMs: performance.now() - t0,
        };
        (self as unknown as Worker).postMessage(resp, Array.from(xfer));
      } else if (req.kind === 'build-creature-mesh' && req.anatomy && req.creatureClass) {
        const mesh = buildUniversalCreatureMeshRGBA(
          rgba,
          req.width,
          req.height,
          req.anatomy,
          req.creatureClass,
          req.meshOptions
        );
        const xfer = new Set<Transferable>();
        collectMeshTransferables(mesh, xfer);
        const resp: RigWorkerResponse = {
          id: req.id,
          ok: true,
          mesh,
          elapsedMs: performance.now() - t0,
        };
        (self as unknown as Worker).postMessage(resp, Array.from(xfer));
      } else if (req.kind === 'build-silhouette-mesh') {
        const mesh = buildSilhouetteConformingMeshRGBA(rgba, req.width, req.height);
        const xfer = new Set<Transferable>();
        collectMeshTransferables(mesh, xfer);
        const resp: RigWorkerResponse = {
          id: req.id,
          ok: true,
          mesh,
          elapsedMs: performance.now() - t0,
        };
        (self as unknown as Worker).postMessage(resp, Array.from(xfer));
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
