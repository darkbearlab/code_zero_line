import type { Polygon, Vec2 } from './types';
import { v2Cross, v2Sub } from './vec2';

/** Squared shortest distance from point P to segment AB. */
export const distancePointToSegmentSq = (
  p: Vec2,
  a: Vec2,
  b: Vec2,
): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = p.x - cx;
  const ey = p.y - cy;
  return ex * ex + ey * ey;
};

export const distancePointToSegment = (p: Vec2, a: Vec2, b: Vec2): number =>
  Math.sqrt(distancePointToSegmentSq(p, a, b));

/**
 * Returns t in [0,1] along segment AB where it intersects segment CD,
 * or null if no intersection.
 */
export const segmentIntersect = (
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): number | null => {
  const r = v2Sub(b, a);
  const s = v2Sub(d, c);
  const rxs = v2Cross(r, s);
  if (rxs === 0) return null;
  const qmp = v2Sub(c, a);
  const t = v2Cross(qmp, s) / rxs;
  const u = v2Cross(qmp, r) / rxs;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
};

export const segmentBlockedByPolygon = (
  a: Vec2,
  b: Vec2,
  poly: Polygon,
): boolean => {
  const verts = poly.vertices;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const c = verts[i]!;
    const d = verts[(i + 1) % n]!;
    if (segmentIntersect(a, b, c, d) !== null) return true;
  }
  return false;
};

export const segmentBlockedByPolygons = (
  a: Vec2,
  b: Vec2,
  polys: ReadonlyArray<Polygon>,
): boolean => {
  for (const p of polys) {
    if (segmentBlockedByPolygon(a, b, p)) return true;
  }
  return false;
};
