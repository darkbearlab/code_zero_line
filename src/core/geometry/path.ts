import type { Circle, Polygon, Vec2 } from './types';
import { distancePointToSegmentSq } from './segment';
import { v2Len, v2Lerp, v2Sub } from './vec2';

export type PathStopReason = 'TARGET' | 'OBSTACLE' | 'ENEMY';

export interface PathResult {
  readonly endpoint: Vec2;
  readonly stopReason: PathStopReason;
  /** Parameter [0,1] along the path where movement stopped. 1.0 = reached target. */
  readonly t: number;
  readonly distance: number;
}

export interface ObstacleSpec {
  readonly polygons: ReadonlyArray<Polygon>;
  readonly enemyCircles: ReadonlyArray<Circle>;
  readonly moverRadius: number;
}

/**
 * Compute where a linear movement from `from` toward `to` stops.
 * The mover is treated as a circle of radius `moverRadius`.
 *
 * Stops on first contact with:
 *  - target reached
 *  - obstacle polygon (backed off by moverRadius along the path)
 *  - enemy circle (radii summed)
 */
export const computeMovePath = (
  from: Vec2,
  to: Vec2,
  obs: ObstacleSpec,
): PathResult => {
  const delta = v2Sub(to, from);
  const totalDist = v2Len(delta);
  if (totalDist === 0) {
    return { endpoint: from, stopReason: 'TARGET', t: 0, distance: 0 };
  }

  let bestT = 1;
  let bestReason: PathStopReason = 'TARGET';

  for (const poly of obs.polygons) {
    const t = sweptCircleVsPolygon(from, to, obs.moverRadius, poly);
    if (t !== null && t < bestT) {
      bestT = t;
      bestReason = 'OBSTACLE';
    }
  }

  for (const ec of obs.enemyCircles) {
    const tHit = circleSegmentEnter(
      from,
      to,
      ec.center,
      ec.radius + obs.moverRadius,
    );
    if (tHit !== null && tHit < bestT) {
      bestT = tHit;
      bestReason = 'ENEMY';
    }
  }

  return {
    endpoint: v2Lerp(from, to, bestT),
    stopReason: bestReason,
    t: bestT,
    distance: totalDist * bestT,
  };
};

/**
 * Sample-based swept-circle vs polygon collision. Returns the smallest
 * t ∈ [0,1] where the moving circle (radius `r`) first touches the polygon
 * boundary, or null if no collision in [0,1]. Assumes t=0 is a safe position
 * (the unit is not already inside / overlapping the polygon).
 */
const sweptCircleVsPolygon = (
  from: Vec2,
  to: Vec2,
  r: number,
  poly: Polygon,
): number | null => {
  const verts = poly.vertices;
  const n = verts.length;
  if (n === 0) return null;
  const rSq = r * r;
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  const collidesAt = (t: number): boolean => {
    const cx = from.x + dx * t;
    const cy = from.y + dy * t;
    const center: Vec2 = { x: cx, y: cy };
    for (let j = 0; j < n; j++) {
      const a = verts[j]!;
      const b = verts[(j + 1) % n]!;
      if (distancePointToSegmentSq(center, a, b) < rSq) return true;
    }
    return false;
  };

  // Coarse sampling to find the first colliding interval, then binary refine.
  const samples = 96;
  let lastSafe = 0;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    if (collidesAt(t)) {
      let lo = lastSafe;
      let hi = t;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) * 0.5;
        if (collidesAt(mid)) hi = mid;
        else lo = mid;
      }
      return lo;
    }
    lastSafe = t;
  }
  return null;
};

/**
 * Smallest t in [0,1] where the segment from-to first enters a circle of
 * radius `cr` centered at `cc`. Returns null if it never enters within [0,1].
 */
const circleSegmentEnter = (
  from: Vec2,
  to: Vec2,
  cc: Vec2,
  cr: number,
): number | null => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const fx = from.x - cc.x;
  const fy = from.y - cc.y;
  const A = dx * dx + dy * dy;
  if (A === 0) return null;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - cr * cr;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-B - sqrtDisc) / (2 * A);
  if (t1 >= 0 && t1 <= 1) return t1;
  return null;
};
