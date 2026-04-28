import type { Polygon, Vec2 } from '../geometry/types';

export const pointInPolygon = (p: Vec2, poly: Polygon): boolean => {
  const verts = poly.vertices;
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const a = verts[i]!;
    const b = verts[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
};
