/**
 * Vector visibility polygon for LOS preview overlay.
 *
 * Algorithm: angular sweep. For each event angle (every blocker vertex +
 * bounds corner), find the segment that's closest just-before and
 * just-after the event. Emit polygon vertices on those segments.
 *
 * Output is parameterised by event angle in ascending order, so within
 * each interval the boundary lies on a single segment (radially monotone)
 * and at each event boundary the two emitted vertices share the same ray
 * angle (a radial chord). The resulting ring is therefore a simple star
 * polygon — Earcut triangulates it without artefacts.
 *
 * Cost: O(E^2) where E = total endpoints. Maps have a handful of
 * blockers (E ≤ ~40), so well under a millisecond. Runs only on
 * selection / blocker change, not per frame.
 *
 * Pure math — no Phaser dependency, so vitest can exercise it directly.
 */
import type { Polygon, Vec2 } from '../../core/geometry/types';

export interface VisibilityBounds {
  readonly width: number;
  readonly height: number;
}

interface Edge {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

const TWO_PI = Math.PI * 2;
const ANGLE_DEDUP_EPSILON = 1e-9;

const normalizeAngle = (a: number): number => {
  const r = a - TWO_PI * Math.floor(a / TWO_PI);
  return r === TWO_PI ? 0 : r;
};

const collectEdges = (
  blockers: ReadonlyArray<Polygon>,
  bounds: VisibilityBounds,
): Edge[] => {
  const w = bounds.width;
  const h = bounds.height;
  const edges: Edge[] = [
    { ax: 0, ay: 0, bx: w, by: 0 },
    { ax: w, ay: 0, bx: w, by: h },
    { ax: w, ay: h, bx: 0, by: h },
    { ax: 0, ay: h, bx: 0, by: 0 },
  ];
  for (const poly of blockers) {
    const v = poly.vertices;
    const n = v.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = v[i]!;
      const b = v[(i + 1) % n]!;
      edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }
  return edges;
};

const collectEventAngles = (
  origin: Vec2,
  blockers: ReadonlyArray<Polygon>,
  bounds: VisibilityBounds,
): number[] => {
  const points: Vec2[] = [
    { x: 0, y: 0 },
    { x: bounds.width, y: 0 },
    { x: bounds.width, y: bounds.height },
    { x: 0, y: bounds.height },
  ];
  for (const poly of blockers) {
    for (const v of poly.vertices) points.push(v);
  }
  const angles: number[] = [];
  for (const p of points) {
    angles.push(normalizeAngle(Math.atan2(p.y - origin.y, p.x - origin.x)));
  }
  angles.sort((a, b) => a - b);
  // Dedupe within tolerance — duplicate event angles produce zero-area
  // intervals whose midpoint is meaningless and bloat work for no benefit.
  const dedup: number[] = [];
  for (const a of angles) {
    const last = dedup[dedup.length - 1];
    if (last === undefined || a - last > ANGLE_DEDUP_EPSILON) dedup.push(a);
  }
  return dedup;
};

/** Smallest t > 0 along ray (origin + t*(dx,dy)) that hits segment ab. */
const raySegmentT = (
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  e: Edge,
): number => {
  const ex = e.bx - e.ax;
  const ey = e.by - e.ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const t = ((e.ax - ox) * ey - (e.ay - oy) * ex) / denom;
  const u = ((e.ax - ox) * dy - (e.ay - oy) * dx) / denom;
  if (t <= 0 || u < -1e-9 || u > 1 + 1e-9) return Infinity;
  return t;
};

interface ClosestHit {
  readonly segIndex: number;
  readonly t: number;
}

const closestSegmentAtAngle = (
  ox: number,
  oy: number,
  angle: number,
  edges: ReadonlyArray<Edge>,
): ClosestHit | null => {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let bestT = Infinity;
  let bestIdx = -1;
  for (let i = 0; i < edges.length; i++) {
    const t = raySegmentT(ox, oy, dx, dy, edges[i]!);
    if (t < bestT) {
      bestT = t;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return { segIndex: bestIdx, t: bestT };
};

const intersectRayWithSegment = (
  ox: number,
  oy: number,
  angle: number,
  edge: Edge,
): Vec2 | null => {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const t = raySegmentT(ox, oy, dx, dy, edge);
  if (!Number.isFinite(t)) return null;
  return { x: ox + dx * t, y: oy + dy * t };
};

/**
 * Compute the polygon of points visible from `origin`, treating each
 * `blocker` as opaque and clipping to `bounds`. Returns a ring of points
 * sorted by angle around origin, suitable as a fill or as a hole when
 * paired with the bounds rect.
 *
 * Returns an empty array when no rays land (shouldn't happen with a valid
 * bounds rect, but defensive).
 */
export const computeVisibilityPolygon = (
  origin: Vec2,
  blockers: ReadonlyArray<Polygon>,
  bounds: VisibilityBounds,
): Vec2[] => {
  const edges = collectEdges(blockers, bounds);
  const events = collectEventAngles(origin, blockers, bounds);
  const N = events.length;
  if (N === 0) return [];

  // For each interval [events[i], events[i+1 mod N]) find the closest
  // segment by sampling at the interval's midpoint angle.
  const closestForInterval: (ClosestHit | null)[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    const a = events[i]!;
    const next = (i + 1) % N;
    const b = events[next]!;
    const midAngle =
      next === 0
        ? normalizeAngle((a + b + TWO_PI) / 2)
        : (a + b) / 2;
    closestForInterval[i] = closestSegmentAtAngle(
      origin.x,
      origin.y,
      midAngle,
      edges,
    );
  }

  // At each event boundary, the polygon may have up to 2 vertices: one on
  // the segment that was closest just-before this event, one on the segment
  // closest just-after. Both share the event's ray angle, so they form a
  // radial chord (zero angular span) — preserves angular monotonicity.
  const out: Vec2[] = [];
  for (let i = 0; i < N; i++) {
    const angle = events[i]!;
    const before = closestForInterval[(i - 1 + N) % N];
    const after = closestForInterval[i];
    if (!before && !after) continue;
    if (before && after && before.segIndex === after.segIndex) {
      const p = intersectRayWithSegment(
        origin.x,
        origin.y,
        angle,
        edges[after.segIndex]!,
      );
      if (p) out.push(p);
      continue;
    }
    if (before) {
      const p = intersectRayWithSegment(
        origin.x,
        origin.y,
        angle,
        edges[before.segIndex]!,
      );
      if (p) out.push(p);
    }
    if (after) {
      const p = intersectRayWithSegment(
        origin.x,
        origin.y,
        angle,
        edges[after.segIndex]!,
      );
      if (p) out.push(p);
    }
  }
  return out;
};
