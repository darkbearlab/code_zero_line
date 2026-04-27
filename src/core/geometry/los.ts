import type { Circle, Polygon, Vec2 } from './types';
import { segmentBlockedByPolygons } from './segment';
import { v2Sub } from './vec2';

const SAMPLE_COUNT = 16;

/**
 * Test LOS between two circles by sampling perimeter points on the half
 * facing the other circle. Returns true if any unblocked perimeter-to-perimeter
 * ray exists.
 *
 * Models the "soldiers shift their bodies" rule: if any line between any two
 * points on the bases is clear, LOS is granted.
 */
export const hasLOS = (
  a: Circle,
  b: Circle,
  obstacles: ReadonlyArray<Polygon>,
): boolean => {
  if (!segmentBlockedByPolygons(a.center, b.center, obstacles)) return true;

  const dir = v2Sub(b.center, a.center);
  const baseA = Math.atan2(dir.y, dir.x);
  const baseB = baseA + Math.PI;

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const tA = i / (SAMPLE_COUNT - 1) - 0.5;
    const angA = baseA + tA * Math.PI;
    const pA: Vec2 = {
      x: a.center.x + Math.cos(angA) * a.radius,
      y: a.center.y + Math.sin(angA) * a.radius,
    };
    for (let j = 0; j < SAMPLE_COUNT; j++) {
      const tB = j / (SAMPLE_COUNT - 1) - 0.5;
      const angB = baseB + tB * Math.PI;
      const pB: Vec2 = {
        x: b.center.x + Math.cos(angB) * b.radius,
        y: b.center.y + Math.sin(angB) * b.radius,
      };
      if (!segmentBlockedByPolygons(pA, pB, obstacles)) return true;
    }
  }
  return false;
};
