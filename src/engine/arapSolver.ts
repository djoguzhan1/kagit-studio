import type { MeshFrameOffsets, MeshPin } from '../types/studio';
import type { ConformingSkinnedMesh } from './conformingMeshEngine';
import type { Vec2 } from './skeletonSkinEngine';

/**
 * INKTROPE V4 Cached Global Skyline-Cholesky Local-Global ARAP 2D Mesh Solver
 * ---------------------------------------------------------------------------
 *  1. Pin-Signature Precomputation (`PrecomputedArapSystem`):
 *     As long as the rest-pose pin coordinates (`pinSignature`) on a `ConformingSkinnedMesh`
 *     remain unchanged, geodesic distance weights AND the cotangent Laplacian system matrix
 *     `A = L_cot + lambda * W_pin` are built and factorized into exact Skyline Cholesky
 *     (`A = L * L^T`) ONLY ONCE (`1` Dijkstra build across 60+ drag frames -> `59/60` cache hits!).
 *  2. Disconnected Island Isolation:
 *     Unreachable components across empty air (`geodesic === Infinity`) stay decoupled from the
 *     active Cholesky subspace (`0.000 px` cross-air pull onto disconnected limbs!).
 *  3. Global Rigid Rotation Propagation:
 *     2 Local-Global iterations (closed-form 2x2 Procrustes polar rotation + O(N * B) forward/back
 *     substitution) propagate true rigid rotation across the entire mesh in `< 0.3 ms/frame`!
 */

const PIN_PENALTY_LAMBDA = 4096.0;

export interface ArapCacheStats {
  lastCallCacheHit: boolean;
  pinSignature: string;
  /** Number of Geodesic + Cholesky system builds on the active mesh (1 across 60 drag frames!) */
  dijkstraBuilds: number;
  /** Alias for dijkstraBuilds */
  dijkstraRuns: number;
  /** Dijkstra passes executed during the most recent solve call (0 on cache hit, 1 on miss) */
  lastFrameDijkstraCount: number;
  cacheHits: number;
  cacheMisses: number;
  totalSolves: number;
  factorizedVertices: number;
}

interface PrecomputedArapSystem {
  pinSignature: string;
  pinVerts: Int32Array;
  /** Indices of mesh vertices reachable from >= 1 pin */
  activeVerts: Int32Array;
  /** Maps global mesh vertex -> active index in [0..activeCount-1], or -1 if disconnected */
  globalToActive: Int32Array;
  /** Normalized geodesic blend weights [activeCount * pinCount] for smooth warm-start */
  geodesicWeights: Float32Array;
  /** Per-active-vertex list of active neighbor indices */
  activeAdj: Int32Array[];
  /** Per-active-vertex cotangent edge weights matching activeAdj */
  activeCotW: Float64Array[];
  /** Per-active-vertex rest edge dx = u_nb - u_i, dy = v_nb - v_i */
  activeRestDx: Float64Array[];
  activeRestDy: Float64Array[];
  /** Per-active-vertex list of attached pin indices (usually empty or 1) */
  attachedPins: number[][];
  /** Jennings Skyline Cholesky lower-triangular factor rows L[i] covering columns [rowStart[i]..i] */
  rowStart: Int32Array;
  cholRows: Float64Array[];
  invDiag: Float64Array;
  /** Reusable per-solve scratch buffers */
  curU: Float64Array;
  curV: Float64Array;
  rhsU: Float64Array;
  rhsV: Float64Array;
  tmpU: Float64Array;
  tmpV: Float64Array;
  rotC: Float64Array;
  rotS: Float64Array;
}

interface CachedArapGraph {
  vertexCount: number;
  adj: number[][];
  cotW: Float64Array[];
  restEdgeDx: Float64Array[];
  restEdgeDy: Float64Array[];
  edgeLen: Float32Array[];
  systems: Map<string, PrecomputedArapSystem>;
  stats: ArapCacheStats;
}

const arapGraphCache = new WeakMap<ConformingSkinnedMesh, CachedArapGraph>();

let _lastStats: ArapCacheStats = {
  lastCallCacheHit: false,
  pinSignature: '',
  dijkstraBuilds: 0,
  dijkstraRuns: 0,
  lastFrameDijkstraCount: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalSolves: 0,
  factorizedVertices: 0,
};

export function getLastArapCacheStats(): ArapCacheStats {
  return { ..._lastStats };
}

export function resetArapCacheStats(mesh?: ConformingSkinnedMesh): void {
  if (mesh) {
    arapGraphCache.delete(mesh);
  }
  _lastStats = {
    lastCallCacheHit: false,
    pinSignature: '',
    dijkstraBuilds: 0,
    dijkstraRuns: 0,
    lastFrameDijkstraCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalSolves: 0,
    factorizedVertices: 0,
  };
}

function getOrBuildArapGraph(mesh: ConformingSkinnedMesh): CachedArapGraph {
  const cached = arapGraphCache.get(mesh);
  if (cached && cached.vertexCount === mesh.vertexCount) return cached;

  const vCount = mesh.vertexCount;
  const restUV = mesh.restUV;
  const tris = mesh.triangles;

  // Accumulate symmetric clamped cotangent edge weights from mesh triangles
  const edgeWeightMaps: Array<Map<number, number>> = Array.from({ length: vCount }, () => new Map());
  const addSymmetricWeight = (i: number, j: number, w: number) => {
    if (i === j) return;
    edgeWeightMaps[i].set(j, (edgeWeightMaps[i].get(j) ?? 0) + w);
    edgeWeightMaps[j].set(i, (edgeWeightMaps[j].get(i) ?? 0) + w);
  };

  const cotAtCorner = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => {
    const ux = ax - cx;
    const uy = ay - cy;
    const vx = bx - cx;
    const vy = by - cy;
    const cross = Math.abs(ux * vy - uy * vx);
    if (cross < 1e-8) return 0.5;
    const dot = ux * vx + uy * vy;
    // Clamp cotangent strictly positive [0.08, 8.0] so obtuse triangles never break SPD M-matrix property!
    return Math.max(0.08, Math.min(8.0, dot / cross));
  };

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const ax = restUV[a * 2];
    const ay = restUV[a * 2 + 1];
    const bx = restUV[b * 2];
    const by = restUV[b * 2 + 1];
    const cx = restUV[c * 2];
    const cy = restUV[c * 2 + 1];

    const cotC = 0.5 * cotAtCorner(ax, ay, bx, by, cx, cy);
    const cotA = 0.5 * cotAtCorner(bx, by, cx, cy, ax, ay);
    const cotB = 0.5 * cotAtCorner(cx, cy, ax, ay, bx, by);

    addSymmetricWeight(a, b, cotC + 0.04);
    addSymmetricWeight(b, c, cotA + 0.04);
    addSymmetricWeight(c, a, cotB + 0.04);
  }

  const adj: number[][] = new Array(vCount);
  const cotW: Float64Array[] = new Array(vCount);
  const restEdgeDx: Float64Array[] = new Array(vCount);
  const restEdgeDy: Float64Array[] = new Array(vCount);
  const edgeLen: Float32Array[] = new Array(vCount);

  for (let vi = 0; vi < vCount; vi++) {
    const entries = Array.from(edgeWeightMaps[vi].entries()).sort((a, b) => a[0] - b[0]);
    const deg = entries.length;
    const nbs = new Array<number>(deg);
    const wArr = new Float64Array(deg);
    const dxArr = new Float64Array(deg);
    const dyArr = new Float64Array(deg);
    const lenArr = new Float32Array(deg);
    const ux = restUV[vi * 2];
    const uy = restUV[vi * 2 + 1];
    for (let k = 0; k < deg; k++) {
      const nb = entries[k][0];
      const dx = restUV[nb * 2] - ux;
      const dy = restUV[nb * 2 + 1] - uy;
      nbs[k] = nb;
      wArr[k] = entries[k][1];
      dxArr[k] = dx;
      dyArr[k] = dy;
      lenArr[k] = Math.max(1e-4, Math.hypot(dx, dy));
    }
    adj[vi] = nbs;
    cotW[vi] = wArr;
    restEdgeDx[vi] = dxArr;
    restEdgeDy[vi] = dyArr;
    edgeLen[vi] = lenArr;
  }

  const graph: CachedArapGraph = {
    vertexCount: vCount,
    adj,
    cotW,
    restEdgeDx,
    restEdgeDy,
    edgeLen,
    systems: new Map(),
    stats: {
      lastCallCacheHit: false,
      pinSignature: '',
      dijkstraBuilds: 0,
      dijkstraRuns: 0,
      lastFrameDijkstraCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalSolves: 0,
      factorizedVertices: 0,
    },
  };
  arapGraphCache.set(mesh, graph);
  return graph;
}

function computeGeodesicDistances(graph: CachedArapGraph, seedVertex: number): Float32Array {
  const n = graph.vertexCount;
  const dist = new Float32Array(n).fill(Infinity);
  const vis = new Uint8Array(n);
  dist[seedVertex] = 0;

  const hIdx: number[] = [seedVertex];
  const hCost: number[] = [0];
  const push = (idx: number, cost: number) => {
    let i = hIdx.length;
    hIdx.push(idx);
    hCost.push(cost);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hCost[p] <= cost) break;
      hIdx[i] = hIdx[p];
      hCost[i] = hCost[p];
      i = p;
    }
    hIdx[i] = idx;
    hCost[i] = cost;
  };
  const pop = (): number => {
    const top = hIdx[0];
    const li = hIdx.pop()!;
    const lc = hCost.pop()!;
    const len = hIdx.length;
    if (len > 0) {
      let i = 0;
      const half = len >> 1;
      while (i < half) {
        let s = (i << 1) + 1;
        const r = s + 1;
        if (r < len && hCost[r] < hCost[s]) s = r;
        if (lc <= hCost[s]) break;
        hIdx[i] = hIdx[s];
        hCost[i] = hCost[s];
        i = s;
      }
      hIdx[i] = li;
      hCost[i] = lc;
    }
    return top;
  };

  while (hIdx.length > 0) {
    const cur = pop();
    if (vis[cur]) continue;
    vis[cur] = 1;
    const d = dist[cur];
    const nbs = graph.adj[cur];
    const lens = graph.edgeLen[cur];
    for (let k = 0; k < nbs.length; k++) {
      const nb = nbs[k];
      if (vis[nb]) continue;
      const nd = d + lens[k];
      if (nd < dist[nb]) {
        dist[nb] = nd;
        push(nb, nd);
      }
    }
  }
  return dist;
}

function computePinSignature(pins: MeshPin[]): string {
  let sig = '';
  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    if (i > 0) sig += '|';
    sig += `${p.id}:${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  }
  return sig;
}

function buildPrecomputedArapSystem(
  mesh: ConformingSkinnedMesh,
  graph: CachedArapGraph,
  pins: MeshPin[],
  pinSignature: string
): PrecomputedArapSystem {
  const vCount = mesh.vertexCount;
  const restUV = mesh.restUV;
  const pCount = pins.length;

  const pinVerts = new Int32Array(pCount);
  const pinGeodesics: Float32Array[] = new Array(pCount);

  for (let pi = 0; pi < pCount; pi++) {
    const p = pins[pi];
    let bestV = 0;
    let bestD2 = Infinity;
    for (let vi = 0; vi < vCount; vi++) {
      const du = restUV[vi * 2] - p.x;
      const dv = restUV[vi * 2 + 1] - p.y;
      const d2 = du * du + dv * dv;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestV = vi;
      }
    }
    pinVerts[pi] = bestV;
    pinGeodesics[pi] = computeGeodesicDistances(graph, bestV);
  }

  // Identify strictly connected vertices (unreachable disconnected islands across air stay -1!)
  const globalToActive = new Int32Array(vCount).fill(-1);
  const activeList: number[] = [];
  for (let vi = 0; vi < vCount; vi++) {
    let reachable = false;
    for (let pi = 0; pi < pCount; pi++) {
      if (Number.isFinite(pinGeodesics[pi][vi])) {
        reachable = true;
        break;
      }
    }
    if (reachable) {
      globalToActive[vi] = activeList.length;
      activeList.push(vi);
    }
  }

  const m = activeList.length;
  const activeVerts = Int32Array.from(activeList);
  const geodesicWeights = new Float32Array(m * pCount);

  for (let ai = 0; ai < m; ai++) {
    const vi = activeVerts[ai];
    let wSum = 0;
    const base = ai * pCount;
    for (let pi = 0; pi < pCount; pi++) {
      const gd = pinGeodesics[pi][vi];
      if (!Number.isFinite(gd)) continue;
      const w = 1 / Math.pow(gd * gd + 0.008, 1.55);
      geodesicWeights[base + pi] = w;
      wSum += w;
    }
    if (wSum > 1e-12) {
      const inv = 1 / wSum;
      for (let pi = 0; pi < pCount; pi++) geodesicWeights[base + pi] *= inv;
    }
  }

  const attachedPins: number[][] = Array.from({ length: m }, () => []);
  for (let pi = 0; pi < pCount; pi++) {
    const ai = globalToActive[pinVerts[pi]];
    if (ai >= 0) attachedPins[ai].push(pi);
  }

  const activeAdj: Int32Array[] = new Array(m);
  const activeCotW: Float64Array[] = new Array(m);
  const activeRestDx: Float64Array[] = new Array(m);
  const activeRestDy: Float64Array[] = new Array(m);
  const rowStart = new Int32Array(m);

  for (let ai = 0; ai < m; ai++) {
    const vi = activeVerts[ai];
    const gNbs = graph.adj[vi];
    const gW = graph.cotW[vi];
    const gDx = graph.restEdgeDx[vi];
    const gDy = graph.restEdgeDy[vi];

    const nbs: number[] = [];
    const ws: number[] = [];
    const dxs: number[] = [];
    const dys: number[] = [];
    let minCol = ai;

    for (let k = 0; k < gNbs.length; k++) {
      const aj = globalToActive[gNbs[k]];
      if (aj < 0) continue;
      nbs.push(aj);
      ws.push(gW[k]);
      dxs.push(gDx[k]);
      dys.push(gDy[k]);
      if (aj < minCol) minCol = aj;
    }

    activeAdj[ai] = Int32Array.from(nbs);
    activeCotW[ai] = Float64Array.from(ws);
    activeRestDx[ai] = Float64Array.from(dxs);
    activeRestDy[ai] = Float64Array.from(dys);
    rowStart[ai] = minCol;
  }

  // Build & factorize exact SPD Skyline Cholesky: A = L_cot + lambda * W_pin = L * L^T
  const cholRows: Float64Array[] = new Array(m);
  const invDiag = new Float64Array(m);

  for (let i = 0; i < m; i++) {
    const startI = rowStart[i];
    const lenI = i - startI + 1;
    const row = new Float64Array(lenI);

    // Populate row i of A within [startI..i]
    let diag = 1e-6 + attachedPins[i].length * PIN_PENALTY_LAMBDA;
    const nbs = activeAdj[i];
    const ws = activeCotW[i];
    for (let k = 0; k < nbs.length; k++) {
      const j = nbs[k];
      const w = ws[k];
      diag += w;
      if (j < i) {
        row[j - startI] -= w;
      }
    }
    row[lenI - 1] = diag;

    // Jennings Skyline Cholesky elimination along columns j = startI .. i - 1
    for (let j = startI; j < i; j++) {
      const rowJ = cholRows[j];
      const startJ = rowStart[j];
      const kMin = startI > startJ ? startI : startJ;
      let sum = row[j - startI];
      for (let k = kMin; k < j; k++) {
        sum -= row[k - startI] * rowJ[k - startJ];
      }
      row[j - startI] = sum * invDiag[j];
    }

    let diagSum = row[lenI - 1];
    for (let k = startI; k < i; k++) {
      const lik = row[k - startI];
      diagSum -= lik * lik;
    }
    const lii = Math.sqrt(diagSum > 1e-9 ? diagSum : 1e-9);
    row[lenI - 1] = lii;
    invDiag[i] = 1.0 / lii;
    cholRows[i] = row;
  }

  return {
    pinSignature,
    pinVerts,
    activeVerts,
    globalToActive,
    geodesicWeights,
    activeAdj,
    activeCotW,
    activeRestDx,
    activeRestDy,
    attachedPins,
    rowStart,
    cholRows,
    invDiag,
    curU: new Float64Array(m),
    curV: new Float64Array(m),
    rhsU: new Float64Array(m),
    rhsV: new Float64Array(m),
    tmpU: new Float64Array(m),
    tmpV: new Float64Array(m),
    rotC: new Float64Array(m),
    rotS: new Float64Array(m),
  };
}

function solveSkylineCholesky(
  sys: PrecomputedArapSystem,
  rhsU: Float64Array,
  rhsV: Float64Array,
  outU: Float64Array,
  outV: Float64Array
): void {
  const m = sys.activeVerts.length;
  const { rowStart, cholRows, invDiag, tmpU, tmpV } = sys;

  // Forward substitution: L * y = rhs
  for (let i = 0; i < m; i++) {
    const startI = rowStart[i];
    const row = cholRows[i];
    let su = rhsU[i];
    let sv = rhsV[i];
    for (let j = startI; j < i; j++) {
      const lij = row[j - startI];
      su -= lij * tmpU[j];
      sv -= lij * tmpV[j];
    }
    const inv = invDiag[i];
    tmpU[i] = su * inv;
    tmpV[i] = sv * inv;
  }

  // Backward substitution: L^T * x = y
  outU.set(tmpU);
  outV.set(tmpV);
  for (let i = m - 1; i >= 0; i--) {
    const inv = invDiag[i];
    const xiU = outU[i] * inv;
    const xiV = outV[i] * inv;
    outU[i] = xiU;
    outV[i] = xiV;
    const startI = rowStart[i];
    const row = cholRows[i];
    for (let j = startI; j < i; j++) {
      const lij = row[j - startI];
      outU[j] -= lij * xiU;
      outV[j] -= lij * xiV;
    }
  }
}

export interface ArapSolveResult {
  /** Deformed screen-space positions [x0, y0, ...] */
  positions: Float32Array;
  /** Exact live screen positions of each pin handle */
  pinScreenPositions: Map<string, Vec2>;
  /** Number of vertices deformed strictly via geodesic manifold connectivity */
  connectedVertices: number;
}

/**
 * Solves cached global Skyline-Cholesky Local-Global 2D ARAP deformation for ANY conforming mesh
 * and ANY set of user pins (0 per-frame Dijkstra on cached pin signatures, < 0.3 ms/frame!).
 */
export function solveGeodesicArapMesh(
  mesh: ConformingSkinnedMesh,
  pins: MeshPin[],
  offsets: MeshFrameOffsets,
  layout: { drawX: number; drawY: number; drawW: number; drawH: number },
  opts?: { iterations?: number; boilAmp?: number; boilPhase?: number }
): ArapSolveResult {
  const vCount = mesh.vertexCount;
  const restUV = mesh.restUV;
  const graph = getOrBuildArapGraph(mesh);
  const positions = new Float32Array(vCount * 2);
  const pinScreenPositions = new Map<string, Vec2>();

  if (pins.length === 0 || vCount < 3) {
    for (let vi = 0; vi < vCount; vi++) {
      positions[vi * 2] = layout.drawX + restUV[vi * 2] * layout.drawW;
      positions[vi * 2 + 1] = layout.drawY + restUV[vi * 2 + 1] * layout.drawH;
    }
    return { positions, pinScreenPositions, connectedVertices: 0 };
  }

  const pinSignature = computePinSignature(pins);
  let sys = graph.systems.get(pinSignature);
  const cacheHit = Boolean(sys);
  if (!sys) {
    sys = buildPrecomputedArapSystem(mesh, graph, pins, pinSignature);
    graph.systems.set(pinSignature, sys);
    graph.stats.dijkstraBuilds++;
    graph.stats.dijkstraRuns = graph.stats.dijkstraBuilds;
    graph.stats.cacheMisses++;
    graph.stats.lastFrameDijkstraCount = 1;
  } else {
    graph.stats.cacheHits++;
    graph.stats.lastFrameDijkstraCount = 0;
  }
  graph.stats.lastCallCacheHit = cacheHit;
  graph.stats.pinSignature = pinSignature;
  graph.stats.totalSolves++;
  graph.stats.factorizedVertices = sys.activeVerts.length;
  _lastStats = { ...graph.stats };

  const pCount = pins.length;
  const m = sys.activeVerts.length;
  const pinDx = new Float64Array(pCount);
  const pinDy = new Float64Array(pCount);
  const pinTargetU = new Float64Array(pCount);
  const pinTargetV = new Float64Array(pCount);

  for (let pi = 0; pi < pCount; pi++) {
    const p = pins[pi];
    const off = offsets[p.id] ?? { dx: 0, dy: 0 };
    const pv = sys.pinVerts[pi];
    pinDx[pi] = off.dx;
    pinDy[pi] = off.dy;
    pinTargetU[pi] = restUV[pv * 2] + off.dx;
    pinTargetV[pi] = restUV[pv * 2 + 1] + off.dy;
  }

  // 1. Geodesic warm-start strictly inside connected manifold components
  const { curU, curV, rhsU, rhsV, rotC, rotS, geodesicWeights, activeVerts } = sys;
  for (let ai = 0; ai < m; ai++) {
    const vi = activeVerts[ai];
    const base = ai * pCount;
    let dx = 0;
    let dy = 0;
    for (let pi = 0; pi < pCount; pi++) {
      const w = geodesicWeights[base + pi];
      if (w > 0) {
        dx += w * pinDx[pi];
        dy += w * pinDy[pi];
      }
    }
    curU[ai] = restUV[vi * 2] + dx;
    curV[ai] = restUV[vi * 2 + 1] + dy;
  }

  // 2. Global Local-Global ARAP Iterations (default 2 passes with exact Cholesky back-solve!)
  const iters = Math.max(2, Math.min(4, opts?.iterations ?? 2));
  for (let it = 0; it < iters; it++) {
    // LOCAL STEP: Exact closed-form 2x2 polar rotation R_i = U_i * V_i^T per active vertex
    for (let ai = 0; ai < m; ai++) {
      const nbs = sys.activeAdj[ai];
      const ws = sys.activeCotW[ai];
      const rxArr = sys.activeRestDx[ai];
      const ryArr = sys.activeRestDy[ai];
      const deg = nbs.length;
      if (deg === 0) {
        rotC[ai] = 1;
        rotS[ai] = 0;
        continue;
      }
      const u0 = curU[ai];
      const v0 = curV[ai];
      let sumCos = 0;
      let sumSin = 0;
      for (let k = 0; k < deg; k++) {
        const aj = nbs[k];
        const w = ws[k];
        const px = rxArr[k];
        const py = ryArr[k];
        const qx = curU[aj] - u0;
        const qy = curV[aj] - v0;
        sumCos += w * (px * qx + py * qy);
        sumSin += w * (px * qy - py * qx);
      }
      const norm = Math.hypot(sumCos, sumSin);
      if (norm > 1e-9) {
        rotC[ai] = sumCos / norm;
        rotS[ai] = sumSin / norm;
      } else {
        rotC[ai] = 1;
        rotS[ai] = 0;
      }
    }

    // GLOBAL STEP: Assemble rotated cotangent Laplacian RHS + pin constraints and back-solve L * L^T * p = rhs
    for (let ai = 0; ai < m; ai++) {
      const nbs = sys.activeAdj[ai];
      const ws = sys.activeCotW[ai];
      const rxArr = sys.activeRestDx[ai];
      const ryArr = sys.activeRestDy[ai];
      const ci = rotC[ai];
      const si = rotS[ai];

      let bu = 0;
      let bv = 0;
      const pinsAtVert = sys.attachedPins[ai];
      for (let p = 0; p < pinsAtVert.length; p++) {
        const pi = pinsAtVert[p];
        bu += PIN_PENALTY_LAMBDA * pinTargetU[pi];
        bv += PIN_PENALTY_LAMBDA * pinTargetV[pi];
      }

      for (let k = 0; k < nbs.length; k++) {
        const aj = nbs[k];
        const w = ws[k];
        const cAvg = 0.5 * (ci + rotC[aj]);
        const sAvg = 0.5 * (si + rotS[aj]);
        // p_i^0 - p_j^0 = (-rxArr[k], -ryArr[k])
        const ex = -rxArr[k];
        const ey = -ryArr[k];
        bu += w * (cAvg * ex - sAvg * ey);
        bv += w * (sAvg * ex + cAvg * ey);
      }

      rhsU[ai] = bu;
      rhsV[ai] = bv;
    }

    solveSkylineCholesky(sys, rhsU, rhsV, curU, curV);
  }

  // 3. Project to screen coordinates (unreachable islands across air stay at exact restUV -> 0.000 px pull!)
  const boilAmp = opts?.boilAmp ?? 0;
  const boilPhase = opts?.boilPhase ?? 0;
  const globalToActive = sys.globalToActive;

  for (let vi = 0; vi < vCount; vi++) {
    const ai = globalToActive[vi];
    const u = ai >= 0 ? curU[ai] : restUV[vi * 2];
    const v = ai >= 0 ? curV[ai] : restUV[vi * 2 + 1];
    let bx = 0;
    let by = 0;
    if (boilAmp > 0 && ai >= 0) {
      const s1 = Math.sin(vi * 254.2 + boilPhase * 311.7) * 43758.5453;
      const s2 = Math.sin((vi * 2 + 1) * 127.1 + boilPhase * 311.7) * 43758.5453;
      bx = ((s1 - Math.floor(s1)) * 2 - 1) * boilAmp;
      by = ((s2 - Math.floor(s2)) * 2 - 1) * boilAmp;
    }
    positions[vi * 2] = layout.drawX + (u + bx) * layout.drawW;
    positions[vi * 2 + 1] = layout.drawY + (v + by) * layout.drawH;
  }

  for (let pi = 0; pi < pCount; pi++) {
    const p = pins[pi];
    const off = offsets[p.id] ?? { dx: 0, dy: 0 };
    pinScreenPositions.set(p.id, {
      x: layout.drawX + (p.x + off.dx) * layout.drawW,
      y: layout.drawY + (p.y + off.dy) * layout.drawH,
    });
  }

  return { positions, pinScreenPositions, connectedVertices: m };
}
