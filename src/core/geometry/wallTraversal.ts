import type { Polygon, Vec2 } from './types';
import { isPointInPolygon } from './polygon';
import type { Terrain, Unit } from '../state/GameState';

/**
 * Find a wall-like terrain piece (HARD / BLOCKER / HIGH_GROUND) the unit's
 * base is in contact with. Returns null if not touching any. Uses a small
 * ε so "touching" includes a few pixels of slack.
 *
 * Callers (vaultAction / climbAction) filter the returned kind to decide
 * whether the action is legal — BLOCKER refuses both, HIGH_GROUND only
 * supports CLIMB (onto the platform), HARD splits by height.
 */
export const findContactedWall = (
  terrains: ReadonlyArray<Terrain>,
  unit: Unit,
  epsilon = 4,
): Terrain | null => {
  for (const t of terrains) {
    if (t.kind !== 'HARD' && t.kind !== 'BLOCKER' && t.kind !== 'HIGH_GROUND') {
      continue;
    }
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

/** Back-compat alias — old name. New code should use findContactedWall. */
export const findContactedHardWall = findContactedWall;

/**
 * Find a DIFFICULT / SOFT terrain whose edge the unit's base is touching.
 * Used by TRAVERSE — these terrains stop normal moves at their boundary,
 * and a separate TRAVERSE crosses the edge in one action.
 */
export const findContactedSoftTerrain = (
  terrains: ReadonlyArray<Terrain>,
  unit: Unit,
  epsilon = 4,
): Terrain | null => {
  for (const t of terrains) {
    if (t.kind !== 'DIFFICULT' && t.kind !== 'SOFT') continue;
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
 * Decompose a convex polygon into its principal axes by minimum-width
 * direction. For a rectangle this recovers the rect's exact local frame
 * (works for axis-aligned and rotated rects alike); for arbitrary convex
 * polygons it returns the orientation that minimises perpendicular width.
 */
const polygonPrincipalAxes = (
  verts: ReadonlyArray<Vec2>,
): {
  centroid: Vec2;
  thinAxis: Vec2;
  longAxis: Vec2;
  thickness: number;
  length: number;
} => {
  let cx = 0;
  let cy = 0;
  for (const v of verts) {
    cx += v.x;
    cy += v.y;
  }
  cx /= verts.length;
  cy /= verts.length;

  let bestThickness = Infinity;
  let bestThinAxis: Vec2 = { x: 1, y: 0 };
  let bestLongAxis: Vec2 = { x: 0, y: 1 };
  let bestLength = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    const ux = ex / len;
    const uy = ey / len;
    const nx = -uy;
    const ny = ux;
    let minU = Infinity;
    let maxU = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (const v of verts) {
      const pu = v.x * ux + v.y * uy;
      const pn = v.x * nx + v.y * ny;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pn < minN) minN = pn;
      if (pn > maxN) maxN = pn;
    }
    const thickness = maxN - minN;
    const lengthSpan = maxU - minU;
    if (thickness < bestThickness) {
      bestThickness = thickness;
      bestThinAxis = { x: nx, y: ny };
      bestLongAxis = { x: ux, y: uy };
      bestLength = lengthSpan;
    }
  }
  return {
    centroid: { x: cx, y: cy },
    thinAxis: bestThinAxis,
    longAxis: bestLongAxis,
    thickness: bestThickness,
    length: bestLength,
  };
};

/**
 * Vault destination (rule 4.2B — 翻越):
 * "模型放置於障礙物正對面緊鄰位置" — the unit ends up adjacent to the wall on
 * the *opposite* side, mirrored across the wall's spine. Works for rotated
 * walls because we project onto the wall's local thin axis.
 */
export const vaultDestination = (
  unit: Unit,
  wallVerts: ReadonlyArray<Vec2>,
): Vec2 => {
  const axes = polygonPrincipalAxes(wallVerts);
  const dx = unit.position.x - axes.centroid.x;
  const dy = unit.position.y - axes.centroid.y;
  const localT = dx * axes.thinAxis.x + dy * axes.thinAxis.y;
  const localL = dx * axes.longAxis.x + dy * axes.longAxis.y;
  // Mirror across the wall's spine (long axis through centroid).
  const newT = -localT;
  const newL = localL;
  return {
    x: axes.centroid.x + axes.thinAxis.x * newT + axes.longAxis.x * newL,
    y: axes.centroid.y + axes.thinAxis.y * newT + axes.longAxis.y * newL,
  };
};

/**
 * Climb destination (rule 4.2B — 攀爬):
 * "放置於攀爬路徑頂端邊緣" — placed on top of the wall, at the edge contacted.
 *
 * In top-down 2D this means: if the wall's surface (footprint thickness) is
 * wide enough to fit the unit's base, the unit stands ON the wall, centered
 * over its spine at the contact point. If the wall is too thin to stand on,
 * the unit ends up on the far side, just past the wall (which is the only
 * place it can fit).
 *
 * The long-axis position is clamped to the wall's extent so the unit never
 * dangles past either end.
 */
export const climbDestination = (
  unit: Unit,
  wallVerts: ReadonlyArray<Vec2>,
): Vec2 => {
  const axes = polygonPrincipalAxes(wallVerts);
  const r = unit.radius;
  const dx = unit.position.x - axes.centroid.x;
  const dy = unit.position.y - axes.centroid.y;
  const localT = dx * axes.thinAxis.x + dy * axes.thinAxis.y;
  const localL = dx * axes.longAxis.x + dy * axes.longAxis.y;
  let newT: number;
  if (axes.thickness >= 2 * r + 1) {
    // Wall is wide enough to stand on — center the unit over the spine.
    newT = 0;
  } else {
    // Wall is too thin to stand on — place the unit's centre on the far
    // edge of the wall. The body straddles the wall (rule 4.2B "頂端邊緣"
    // — the climb path's top edge), and from this position the unit is
    // free to move forward on the next action.
    const sign = localT < 0 ? 1 : -1;
    newT = sign * (axes.thickness / 2);
  }
  const longCap = Math.max(0, axes.length / 2 - r);
  const newL = Math.max(-longCap, Math.min(longCap, localL));
  return {
    x: axes.centroid.x + axes.thinAxis.x * newT + axes.longAxis.x * newL,
    y: axes.centroid.y + axes.thinAxis.y * newT + axes.longAxis.y * newL,
  };
};

/**
 * Traverse destination — single-step crossing of a DIFFICULT/SOFT polygon
 * boundary. Mover starts with its base flush against an edge (touched on
 * one side) and ends flush against the same edge from the opposite side.
 * Center moves perpendicular to the edge by exactly 2*radius (one base
 * diameter); no extra distance.
 *
 * The closest edge segment to the unit center is used. The outward normal
 * is computed from polygon winding via point-in-polygon, so concave
 * polygons and either winding order both work.
 */
export const traverseDestination = (
  unit: Unit,
  poly: Polygon,
): Vec2 => {
  const verts = poly.vertices;
  const n = verts.length;
  let bestDistSq = Infinity;
  let bestFoot: Vec2 = unit.position;
  let bestEdgeNormal: Vec2 = { x: 1, y: 0 };
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = verts[j]!;
    const b = verts[i]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const lenSq = ex * ex + ey * ey;
    if (lenSq === 0) continue;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((unit.position.x - a.x) * ex + (unit.position.y - a.y) * ey) / lenSq,
      ),
    );
    const fx = a.x + ex * t;
    const fy = a.y + ey * t;
    const dx = unit.position.x - fx;
    const dy = unit.position.y - fy;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestFoot = { x: fx, y: fy };
      // Edge normal — direction is resolved below using PIP.
      const len = Math.sqrt(lenSq);
      bestEdgeNormal = { x: -ey / len, y: ex / len };
    }
  }
  // Decide which side the unit is on, then place center on the opposite
  // side at exactly distance r from the foot point.
  const insideNow = isPointInPolygon(unit.position, poly);
  // Probe a tiny step along bestEdgeNormal from bestFoot to learn which
  // side that normal points toward.
  const probe = {
    x: bestFoot.x + bestEdgeNormal.x * 0.5,
    y: bestFoot.y + bestEdgeNormal.y * 0.5,
  };
  const probeInside = isPointInPolygon(probe, poly);
  const sign = insideNow === probeInside ? -1 : 1;
  const r = unit.radius;
  return {
    x: bestFoot.x + sign * bestEdgeNormal.x * r,
    y: bestFoot.y + sign * bestEdgeNormal.y * r,
  };
};
