import { describe, it, expect } from 'vitest';
import type { Polygon, Vec2 } from '../../core/geometry/types';
import {
  computeVisibilityPolygon,
  type VisibilityBounds,
} from './visibilityPolygon';

const bounds: VisibilityBounds = { width: 1000, height: 1000 };

const rect = (x: number, y: number, w: number, h: number): Polygon => ({
  vertices: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
});

const polyArea = (verts: ReadonlyArray<Vec2>): number => {
  let s = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
};

const segmentsIntersect = (
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): boolean => {
  const cross = (o: Vec2, p: Vec2, q: Vec2): number =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
};

const isSimplePolygon = (verts: ReadonlyArray<Vec2>): boolean => {
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent across wraparound
      const c = verts[j]!;
      const d = verts[(j + 1) % n]!;
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
};

const pointInPoly = (p: Vec2, verts: ReadonlyArray<Vec2>): boolean => {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = verts[i]!;
    const b = verts[j]!;
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
};

describe('computeVisibilityPolygon', () => {
  it('with no blockers, sees the full bounds rectangle', () => {
    const v = computeVisibilityPolygon({ x: 500, y: 500 }, [], bounds);
    expect(v.length).toBeGreaterThanOrEqual(4);
    // Area should be the full bounds area (within numerical tolerance).
    expect(polyArea(v)).toBeCloseTo(bounds.width * bounds.height, -1);
  });

  it('a wall in front of origin casts a shadow behind it', () => {
    // Origin sits south of a horizontal wall. Points directly north of the
    // wall (i.e. behind it) should NOT be inside the visibility polygon.
    const wall = rect(400, 400, 200, 20);
    const origin = { x: 500, y: 600 };
    const v = computeVisibilityPolygon(origin, [wall], bounds);
    // A point well behind the wall (further north) is NOT visible.
    expect(pointInPoly({ x: 500, y: 200 }, v)).toBe(false);
    // A point south of origin (away from wall) IS visible.
    expect(pointInPoly({ x: 500, y: 800 }, v)).toBe(true);
  });

  it('a wall directly between origin and target removes target from polygon', () => {
    const wall = rect(450, 450, 100, 100);
    const origin = { x: 100, y: 500 };
    const v = computeVisibilityPolygon(origin, [wall], bounds);
    // Point on far side of wall from origin should be hidden.
    expect(pointInPoly({ x: 900, y: 500 }, v)).toBe(false);
    // Point near origin (no occlusion) should be visible.
    expect(pointInPoly({ x: 200, y: 500 }, v)).toBe(true);
  });

  it('removing the wall restores visibility of the previously-hidden point', () => {
    const wall = rect(450, 450, 100, 100);
    const origin = { x: 100, y: 500 };
    const target = { x: 900, y: 500 };
    const blocked = computeVisibilityPolygon(origin, [wall], bounds);
    const clear = computeVisibilityPolygon(origin, [], bounds);
    expect(pointInPoly(target, blocked)).toBe(false);
    expect(pointInPoly(target, clear)).toBe(true);
  });

  it('wall directly west of origin: eastward points stay visible', () => {
    // Regression: the prior atan2 wraparound at ±π let a wall vertex
    // straddle the array boundary, producing a long chord across visible
    // space. That chord could erroneously exclude points on the OPPOSITE
    // side of origin from the wall.
    const wall = rect(200, 495, 30, 10);
    const origin = { x: 500, y: 500 };
    const v = computeVisibilityPolygon(origin, [wall], bounds);
    expect(pointInPoly({ x: 900, y: 500 }, v)).toBe(true);
    expect(pointInPoly({ x: 500, y: 900 }, v)).toBe(true);
    expect(pointInPoly({ x: 500, y: 100 }, v)).toBe(true);
    // Far west, well behind the wall, should be hidden.
    expect(pointInPoly({ x: 50, y: 500 }, v)).toBe(false);
  });

  it('wall on each cardinal axis: no edge longer than half the bounds diagonal', () => {
    // Walls placed on east, west, north, south axes simultaneously stress
    // the wraparound at every cardinal direction. A healthy polygon has
    // many short edges; spurious chords from misordered hits would jump
    // across the visible area.
    const walls: Polygon[] = [
      rect(200, 495, 30, 10), // west
      rect(770, 495, 30, 10), // east
      rect(495, 200, 10, 30), // north
      rect(495, 770, 10, 30), // south
    ];
    const origin = { x: 500, y: 500 };
    const v = computeVisibilityPolygon(origin, walls, bounds);
    const limit = Math.hypot(bounds.width, bounds.height) / 2;
    for (let i = 0; i < v.length; i++) {
      const a = v[i]!;
      const b = v[(i + 1) % v.length]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(limit);
    }
  });

  it('origin near bounds left edge: behind-wall point hidden, in-front visible', () => {
    // Origin near a bounds wall pushes most vertices toward angle ≈ 0
    // (eastward), making the post-normalisation wraparound at 0 the
    // critical boundary. Verify the polygon still respects geometry.
    const wall = rect(500, 495, 30, 10);
    const origin = { x: 100, y: 500 };
    const v = computeVisibilityPolygon(origin, [wall], bounds);
    expect(pointInPoly({ x: 900, y: 500 }, v)).toBe(false);
    expect(pointInPoly({ x: 300, y: 500 }, v)).toBe(true);
  });

  it('cluster of walls with nearby angles: polygon is simple (no self-intersection)', () => {
    // Regression: the old ±ε ray-per-vertex sort produced self-intersecting
    // rings when nearby vertex angles let perturbed rays interleave.
    // Earcut then triangulated the bad ring as crossed triangles, which
    // showed up in-game as inverted shading and diagonal slashes across
    // visible space. Angular sweep guarantees the ring is monotone by
    // angle, hence simple.
    const walls: Polygon[] = [
      rect(700, 400, 30, 30),
      rect(700, 460, 30, 30),
      rect(700, 520, 30, 30),
    ];
    const origin = { x: 500, y: 500 };
    const v = computeVisibilityPolygon(origin, walls, bounds);
    expect(isSimplePolygon(v)).toBe(true);
    // Sanity: behind the cluster is hidden, in front is visible.
    expect(pointInPoly({ x: 900, y: 470 }, v)).toBe(false);
    expect(pointInPoly({ x: 600, y: 700 }, v)).toBe(true);
  });

  it('wall vertex at exactly angle 0 (due east): polygon is simple', () => {
    // Endpoint precisely east of origin lands on the 0/2π wraparound seam.
    // Verify the polygon is simple and the wall is honoured.
    const wall = rect(700, 495, 30, 10); // east, wall edge crosses y=500
    const wall2 = rect(495, 200, 10, 30); // north
    const origin = { x: 500, y: 500 };
    const v = computeVisibilityPolygon(origin, [wall, wall2], bounds);
    expect(isSimplePolygon(v)).toBe(true);
    expect(pointInPoly({ x: 900, y: 500 }, v)).toBe(false);
    expect(pointInPoly({ x: 500, y: 100 }, v)).toBe(false);
    expect(pointInPoly({ x: 500, y: 900 }, v)).toBe(true); // south unobstructed
  });

  it('shadow area shrinks the visible polygon (less than full bounds)', () => {
    const wall = rect(300, 300, 400, 400);
    const v = computeVisibilityPolygon({ x: 50, y: 50 }, [wall], bounds);
    const visibleArea = polyArea(v);
    const fullArea = bounds.width * bounds.height;
    // Wall occludes at least its own area's worth of background.
    expect(visibleArea).toBeLessThan(fullArea);
    expect(visibleArea).toBeGreaterThan(0);
  });
});
