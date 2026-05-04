/**
 * Vector visibility polygon for LOS preview overlay. Replaces the old
 * grid-cell scan whose diagonal edges showed obvious staircase aliasing.
 *
 * Algorithm: cast rays from origin to every blocker vertex (and ±ε to wrap
 * around corners), find each ray's nearest edge intersection, sort by
 * angle. The resulting point ring is the boundary of "everywhere the
 * origin can see". Render bounds-minus-this as the shadow.
 *
 * Cost: O((n*k)^2) where n = blocker count, k = avg vertices. Hover-rate
 * (only on selection change), so fine in practice.
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

const ANGLE_EPSILON = 0.00001;
const TWO_PI = Math.PI * 2;

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

const collectVertexAngles = (
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
    const a = Math.atan2(p.y - origin.y, p.x - origin.x);
    angles.push(
      normalizeAngle(a),
      normalizeAngle(a + ANGLE_EPSILON),
      normalizeAngle(a - ANGLE_EPSILON),
    );
  }
  return angles;
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
  const angles = collectVertexAngles(origin, blockers, bounds);
  const hits: { angle: number; x: number; y: number }[] = [];
  for (const angle of angles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let nearest = Infinity;
    for (const e of edges) {
      const t = raySegmentT(origin.x, origin.y, dx, dy, e);
      if (t < nearest) nearest = t;
    }
    if (nearest === Infinity) continue;
    hits.push({
      angle,
      x: origin.x + dx * nearest,
      y: origin.y + dy * nearest,
    });
  }
  hits.sort((a, b) => a.angle - b.angle);
  if (hits.length === 0) return [];

  // After normalisation the wraparound boundary sits at angle 0/2π, but a
  // wall vertex landing near angle 0 (eastward) would still split that
  // vertex's ±ε rays to opposite ends of the sorted array — a near hit
  // (wall) at one end, a far hit (bounds) at the other, drawn as a long
  // chord across visible space. Find the largest angular gap between
  // consecutive hits and rotate so that gap sits at the array boundary;
  // the polygon's close-the-ring edge then falls in geometry-free space.
  const N = hits.length;
  let maxGap = -Infinity;
  let maxGapEnd = 0;
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    let gap = hits[next]!.angle - hits[i]!.angle;
    if (next === 0) gap += TWO_PI;
    if (gap > maxGap) {
      maxGap = gap;
      maxGapEnd = next;
    }
  }
  const rotated =
    maxGapEnd === 0
      ? hits
      : hits.slice(maxGapEnd).concat(hits.slice(0, maxGapEnd));
  return rotated.map((h) => ({ x: h.x, y: h.y }));
};
