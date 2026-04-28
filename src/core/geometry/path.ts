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
  /**
   * Hard collision polygons (HARD walls). Path swept-circle stops when the
   * mover's leading edge first touches any polygon edge — center remains
   * outside by `moverRadius`.
   */
  readonly polygons: ReadonlyArray<Polygon>;
  /**
   * Difficult-terrain polygons. Rule 4.2C: "移動路徑接觸困難地形邊緣 →
   * 該次移動立即結束". The *center line* (not the swept circle) determines
   * the stop point — the unit ends with its centre on the boundary, i.e.
   * partially inside. Polygons that already contain `from` are ignored
   * (the mover starts inside; the start-in cap is enforced separately).
   */
  readonly enterStopPolygons?: ReadonlyArray<Polygon>;
  readonly enemyCircles: ReadonlyArray<Circle>;
  /**
   * Friendly units. Pass-through during movement, but the *final* position
   * may not overlap any of them (rule 4.2A — "可自由穿過友軍模型，不視為
   * 障礙" + the implicit "底板不能重疊" base-stacking constraint). The path
   * backs off until clear.
   */
  readonly friendlyCircles?: ReadonlyArray<Circle>;
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

  // Difficult-terrain entry stop: centre line crosses the polygon boundary.
  // Skip polygons that already contain `from` (start-inside is governed by
  // rule 4.2C max-1-UD cap, applied upstream).
  if (obs.enterStopPolygons) {
    for (const poly of obs.enterStopPolygons) {
      if (pointInPolygon(from, poly)) continue;
      const tHit = segmentVsPolygonFirstHit(from, to, poly);
      if (tHit !== null && tHit < bestT) {
        bestT = tHit;
        bestReason = 'OBSTACLE';
      }
    }
  }

  // Friendly end-overlap back-off: walk back from bestT until the mover's
  // base no longer overlaps any friendly. Friendlies are pass-through during
  // motion but cannot share a base position at rest.
  if (obs.friendlyCircles && obs.friendlyCircles.length > 0) {
    const overlapsAt = (t: number): boolean => {
      const cx = from.x + (to.x - from.x) * t;
      const cy = from.y + (to.y - from.y) * t;
      for (const f of obs.friendlyCircles!) {
        const dx = cx - f.center.x;
        const dy = cy - f.center.y;
        const minDist = obs.moverRadius + f.radius - 0.5; // small ε
        if (dx * dx + dy * dy < minDist * minDist) return true;
      }
      return false;
    };
    if (overlapsAt(bestT)) {
      // Linear scan back from bestT to find the largest sample t that's clear.
      const samples = 128;
      let clearT = -1;
      for (let i = samples; i >= 0; i--) {
        const t = (i / samples) * bestT;
        if (!overlapsAt(t)) {
          clearT = t;
          break;
        }
      }
      if (clearT < 0) {
        // Mover started already overlapping (degenerate setup) — don't move.
        return { endpoint: from, stopReason: 'OBSTACLE', t: 0, distance: 0 };
      }
      bestT = clearT;
      // Keep bestReason — the original stop cause still applies semantically;
      // the clipped position is just "as close as you can stop".
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
 * Smallest t in (ε, 1] where segment from→to first crosses any edge of
 * the polygon. Used for difficult-terrain entry stop where the *centre
 * line* (not the swept circle) determines the end point. Returns null
 * if the segment never crosses an edge within (ε, 1].
 */
const segmentVsPolygonFirstHit = (
  from: Vec2,
  to: Vec2,
  poly: Polygon,
): number | null => {
  const verts = poly.vertices;
  const n = verts.length;
  if (n < 2) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let bestT: number | null = null;
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % n]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / denom;
    const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / denom;
    if (t > 1e-6 && t <= 1 && u >= -1e-6 && u <= 1 + 1e-6) {
      if (bestT === null || t < bestT) bestT = t;
    }
  }
  return bestT;
};

const pointInPolygon = (p: Vec2, poly: Polygon): boolean => {
  const verts = poly.vertices;
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i]!.x;
    const yi = verts[i]!.y;
    const xj = verts[j]!.x;
    const yj = verts[j]!.y;
    const intersects =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
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
