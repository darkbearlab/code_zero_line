import type { Polygon, Vec2 } from './types';

/**
 * Ray-casting point-in-polygon test. Works for any simple polygon (convex or concave).
 * Boundary cases: a point exactly on an edge is implementation-dependent — for
 * skirmish-scale cover checks the ambiguity is harmless.
 */
export const isPointInPolygon = (point: Vec2, poly: Polygon): boolean => {
  const v = poly.vertices;
  const n = v.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = v[i]!.x;
    const yi = v[i]!.y;
    const xj = v[j]!.x;
    const yj = v[j]!.y;
    const crosses =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
};
