/**
 * KÂĞIT Phase 5 — Trajectory-Integrated Multi-Node Verlet Cloth/Scarf/Hair Solver.
 * 100% deterministic, zero-allocation hot path, 16-substep (dt = 1/60s) neck trajectory
 * integration for real acceleration & follow-through lag waves, iterative distance constraints,
 * and ground-plane sliding collision!
 */

export interface VerletNode {
  x: number;
  y: number;
  px: number;
  py: number;
  pinned?: boolean;
}

export interface VerletChainConfig {
  nodeCount: number;
  segmentLength: number;
  gravity: number;
  damping: number;
  constraintIterations: number;
}

export class VerletClothChain {
  public nodes: VerletNode[];
  public readonly config: VerletChainConfig;
  private initialized = false;

  constructor(config?: Partial<VerletChainConfig>) {
    this.config = {
      nodeCount: config?.nodeCount ?? 9,
      segmentLength: config?.segmentLength ?? 9,
      gravity: config?.gravity ?? 0.42,
      damping: config?.damping ?? 0.94,
      constraintIterations: config?.constraintIterations ?? 5,
    };
    this.nodes = Array.from({ length: this.config.nodeCount }, (_, i) => ({
      x: 0,
      y: i * this.config.segmentLength,
      px: 0,
      py: i * this.config.segmentLength,
      pinned: i === 0,
    }));
  }

  public reset(anchorX: number, anchorY: number, segLen?: number, trailDir = -1): void {
    const step = segLen ?? this.config.segmentLength;
    const dir = trailDir >= 0 ? 1 : -1;
    for (let i = 0; i < this.nodes.length; i++) {
      this.nodes[i].x = anchorX + dir * i * step * 0.35;
      this.nodes[i].y = anchorY + i * step * 0.85;
      this.nodes[i].px = this.nodes[i].x;
      this.nodes[i].py = this.nodes[i].y;
    }
    this.initialized = true;
  }

  /**
   * Advances physical cloth chain by one step under gravity, wind gusts,
   * anchor acceleration wake, iterative distance constraints, and floor collision!
   */
  public step(params: {
    anchorX: number;
    anchorY: number;
    windX: number;
    timeSec: number;
    floorY: number;
    segmentLength?: number;
    anchorVelX?: number;
    anchorVelY?: number;
  }): VerletNode[] {
    const segLen = Math.max(3, params.segmentLength ?? this.config.segmentLength);
    if (!this.initialized) {
      this.reset(params.anchorX, params.anchorY, segLen, params.windX >= 0 ? 1 : -1);
    } else {
      const jumpDist = Math.hypot(
        params.anchorX - this.nodes[0].x,
        params.anchorY - this.nodes[0].y
      );
      if (jumpDist > segLen * this.nodes.length * 1.8) {
        this.reset(params.anchorX, params.anchorY, segLen, params.windX >= 0 ? 1 : -1);
      }
    }

    const { gravity, damping, constraintIterations } = this.config;
    const n = this.nodes;
    const anchorVx = params.anchorVelX ?? (params.anchorX - n[0].x);
    const anchorVy = params.anchorVelY ?? (params.anchorY - n[0].y);

    // 1. Pin root node cleanly to character neck/collar socket
    n[0].px = n[0].x;
    n[0].py = n[0].y;
    n[0].x = params.anchorX;
    n[0].y = params.anchorY;

    // 2. Verlet Velocity Integration + Aerodynamic Relative-Motion Drag + Multi-Harmonic Gusts
    for (let i = 1; i < n.length; i++) {
      const node = n[i];
      const vx = (node.x - node.px) * damping;
      const vy = (node.y - node.py) * damping;
      node.px = node.x;
      node.py = node.y;

      const tailFactor = i / (n.length - 1);
      const aeroWakeX = Math.max(-8, Math.min(8, -anchorVx * 0.34));
      const aeroWakeY = Math.max(-6, Math.min(6, -anchorVy * 0.28));

      const gust =
        Math.sin(params.timeSec * 6.8 + i * 0.85) * (0.28 + Math.abs(params.windX + aeroWakeX * 0.35) * 0.45) +
        Math.cos(params.timeSec * 11.3 - i * 1.1) * 0.16;
      const lift =
        Math.sin(params.timeSec * 5.2 + i * 0.7) * Math.abs(params.windX + aeroWakeX * 0.3) * 0.24;

      node.x += vx + (params.windX + aeroWakeX * (0.35 + tailFactor * 0.65) + gust) * (0.55 + tailFactor * 0.65);
      node.y += vy + gravity * (1 - tailFactor * 0.2) - lift + aeroWakeY * (0.25 + tailFactor * 0.55);
    }

    // 3. Iterative Distance Constraints & Ground Plane Collision
    for (let iter = 0; iter < constraintIterations; iter++) {
      n[0].x = params.anchorX;
      n[0].y = params.anchorY;
      for (let i = 0; i < n.length - 1; i++) {
        const a = n[i];
        const b = n[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const diff = (dist - segLen) / dist;
        if (i === 0) {
          b.x -= dx * diff;
          b.y -= dy * diff;
        } else {
          a.x += dx * diff * 0.5;
          a.y += dy * diff * 0.5;
          b.x -= dx * diff * 0.5;
          b.y -= dy * diff * 0.5;
        }
      }
      for (let i = 1; i < n.length; i++) {
        if (n[i].y > params.floorY) {
          n[i].y = params.floorY;
        }
      }
    }

    // 4. Final Root-to-Tip Exact Distance Lock with Floor-Sliding (zero rubber-band stretch!)
    n[0].x = params.anchorX;
    n[0].y = Math.min(params.floorY, params.anchorY);
    for (let i = 0; i < n.length - 1; i++) {
      const a = n[i];
      const b = n[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      let nx = a.x + (dx / dist) * segLen;
      let ny = a.y + (dy / dist) * segLen;
      if (ny > params.floorY) {
        ny = params.floorY;
        const remDy = ny - a.y;
        const remDxSq = Math.max(0, segLen * segLen - remDy * remDy);
        const horizSign = Math.abs(dx) > 1e-4 ? Math.sign(dx) : params.windX >= 0 ? 1 : -1;
        nx = a.x + horizSign * Math.sqrt(remDxSq);
      }
      b.x = nx;
      b.y = ny;
    }

    return n;
  }
}

/**
 * Deterministic pure evaluator for rendering a physically solved Verlet scarf/cape ribbon
 * at any arbitrary scrub timestamp `timeSec`.
 * Integrates 16 historical substeps (dt = 1/60s) along `anchorTrajectory` so walk, run,
 * jump, and turn accelerations generate genuine inertia and delayed S-wave follow-through!
 */
export function evaluateDeterministicVerletRibbon(params: {
  anchorX: number;
  anchorY: number;
  windX: number;
  timeSec: number;
  floorY: number;
  segmentLength: number;
  nodeCount?: number;
  anchorTrajectory?: (tSec: number) => { x: number; y: number };
}): { x: number; y: number }[] {
  const substeps = 16;
  const dt = 1 / 60;
  const traj = params.anchorTrajectory;

  let biasX = 0;
  let biasY = 0;
  if (traj) {
    const cur = traj(Math.max(0, params.timeSec));
    biasX = params.anchorX - cur.x;
    biasY = params.anchorY - cur.y;
  }

  const sampleAnchor = (tSample: number): { x: number; y: number } => {
    if (!traj) {
      return { x: params.anchorX, y: params.anchorY };
    }
    const p = traj(Math.max(0, tSample));
    return { x: p.x + biasX, y: p.y + biasY };
  };

  const chain = new VerletClothChain({
    nodeCount: params.nodeCount ?? 8,
    segmentLength: params.segmentLength,
    gravity: 0.44,
    damping: 0.91,
    constraintIterations: 5,
  });

  const tStart = Math.max(0, params.timeSec - substeps * dt);
  const a0 = sampleAnchor(tStart);
  const aEnd = { x: params.anchorX, y: params.anchorY };
  const initialTrailDir =
    Math.abs(aEnd.x - a0.x) > 0.25 ? -Math.sign(aEnd.x - a0.x) : params.windX >= 0 ? 1 : -1;
  chain.reset(a0.x, a0.y, params.segmentLength, initialTrailDir);

  let prevAnchor = a0;
  for (let s = 1; s <= substeps; s++) {
    const rawT = params.timeSec - (substeps - s) * dt;
    const clampedT = Math.max(0, rawT);
    const curAnchor = s === substeps ? aEnd : sampleAnchor(clampedT);
    const velX = curAnchor.x - prevAnchor.x;
    const velY = curAnchor.y - prevAnchor.y;

    chain.step({
      anchorX: curAnchor.x,
      anchorY: curAnchor.y,
      windX: params.windX,
      timeSec: clampedT,
      floorY: params.floorY,
      segmentLength: params.segmentLength,
      anchorVelX: velX,
      anchorVelY: velY,
    });
    prevAnchor = curAnchor;
  }

  return chain.nodes.map((nd) => ({ x: nd.x, y: nd.y }));
}
