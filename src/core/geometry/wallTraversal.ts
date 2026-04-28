import type { Vec2 } from './types';
import type { Terrain, Unit } from '../state/GameState';

/**
 * Find a HARD terrain piece that the given unit's base is in contact with.
 * Returns null if not touching any. Uses a small ε so "touching" includes
 * a few pixels of slack.
 */
export const findContactedHardWall = (
  terrains: ReadonlyArray<Terrain>,
  unit: Unit,
  epsilon = 4,
): Terrain | null => {
  for (const t of terrains) {
    if (t.kind !== 'HARD') continue;
    const verts = t.polygon.vertices;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const a = verts[j]!;
      const b = verts[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      const tt = Math.max(
        0,
        Math.min(
          1,
          ((unit.position.x - a.x) * dx + (unit.position.y - a.y) * dy) / lenSq,
        ),
      );
      const px = a.x + dx * tt;
      const py = a.y + dy * tt;
      const dist = Math.hypot(unit.position.x - px, unit.position.y - py);
      if (dist <= unit.radius + epsilon) return t;
    }
  }
  return null;
};

/**
 * Vault destination: mirror unit across the wall's bbox center along the
 * wall's thin axis. Distance from the wall is preserved.
 */
export const vaultDestination = (
  unit: Unit,
  wallVerts: ReadonlyArray<Vec2>,
): Vec2 => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of wallVerts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= h) {
    // Vertical wall — mirror across X.
    return { x: 2 * cx - unit.position.x, y: unit.position.y };
  }
  return { x: unit.position.x, y: 2 * cy - unit.position.y };
};

/**
 * Climb destination: place the unit at the *far* edge of the wall (relative
 * to current position), conceptually "on top of" the wall in 2D.
 */
export const climbDestination = (
  unit: Unit,
  wallVerts: ReadonlyArray<Vec2>,
): Vec2 => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of wallVerts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= h) {
    const farX = unit.position.x < cx ? maxX : minX;
    return { x: farX, y: unit.position.y };
  }
  const farY = unit.position.y < cy ? maxY : minY;
  return { x: unit.position.x, y: farY };
};
