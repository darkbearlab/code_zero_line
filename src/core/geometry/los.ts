import type { Circle, Polygon, Vec2 } from './types';
import { segmentBlockedByPolygons } from './segment';
import { isPointInPolygon } from './polygon';
import {
  isHighWall,
  isLowWall,
  type Terrain,
} from '../state/GameState';
import {
  STANDARD_BASE_RADIUS_PIXELS,
  VAULT_HEIGHT_THRESHOLD_PIXELS,
} from '../rules/constants';

export interface LOSOptions {
  /** Endpoint A's unit is prone — low walls then block LOS from A's side. */
  readonly aProne?: boolean;
  /** Endpoint B's unit is prone — low walls block LOS toward B. */
  readonly bProne?: boolean;
  /**
   * Endpoint A is standing on HIGH_GROUND — low walls along the LOS line
   * are bypassed (you see over them from the platform). Symmetric flag
   * for B; either side on high ground is enough to neuter low-wall block.
   */
  readonly aOnHighGround?: boolean;
  readonly bOnHighGround?: boolean;
}

/**
 * Compute the polygon list that effectively blocks LOS for a given pair of
 * endpoints, according to rules 4.5 (prone vs low walls) and 9.3 (soft cover):
 *
 *  - HIGH walls (height > 1 unit-distance) always block.
 *  - LOW walls (height ≤ 1 unit-distance) block only when at least one
 *    endpoint is prone (the prone model is base-height — below the wall —
 *    so its line of sight is occluded).
 *  - SOFT cover (smoke / fog) blocks only when *both* endpoints are outside
 *    the polygon. If either endpoint is inside, LOS passes through that
 *    soft cover (and the cover bonus applies separately).
 *  - HIGH_GROUND occludes like a high wall when both endpoints are at
 *    ground level on opposite sides. When one endpoint stands on the
 *    platform, the platform's perimeter on the *far* side blocks unless
 *    the on-platform endpoint is within ~one base radius of the entry
 *    edge (i.e. peeking over the rim that faces the off-platform side).
 *  - When BOTH endpoints stand on HIGH_GROUND (same or different
 *    platforms), high walls and HIGH_GROUND polygons stop blocking —
 *    high walls and HG are treated as the same elevated tier, so an
 *    elevated unit can sight across them to another elevated unit.
 *    BLOCKER + SOFT still apply normally.
 *  - DIFFICULT terrain never blocks LOS (only provides cover when target
 *    inside).
 */
export const buildLosBlockers = (
  a: Vec2,
  b: Vec2,
  terrains: ReadonlyArray<Terrain>,
  options: LOSOptions = {},
): Polygon[] => {
  const blockers: Polygon[] = [];
  // Either endpoint on HG → low walls along the LOS line lose their block
  // (the elevated side sees over them).
  const lowWallBypass = options.aOnHighGround || options.bOnHighGround;
  // Both endpoints on HG → high walls and HIGH_GROUND polygons stop
  // blocking. They're treated as the same elevated tier (high wall top
  // ≈ HG surface), so two elevated units sight across each other.
  const highObstacleBypass =
    options.aOnHighGround === true && options.bOnHighGround === true;
  for (const t of terrains) {
    if (t.kind === 'HARD') {
      if (isHighWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS)) {
        if (highObstacleBypass) continue;
        blockers.push(t.polygon);
      } else if (isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS)) {
        if (lowWallBypass) continue;
        if (options.aProne || options.bProne) blockers.push(t.polygon);
      }
    } else if (t.kind === 'BLOCKER' || t.kind === 'OUT_OF_BOUNDS') {
      // Sealed wall / out-of-bounds boundary — always occludes,
      // height-independent. NO_ENTRY is intentionally absent: atrium
      // voids let LOS pass through unobstructed.
      blockers.push(t.polygon);
    } else if (t.kind === 'SOFT') {
      const aIn = isPointInPolygon(a, t.polygon);
      const bIn = isPointInPolygon(b, t.polygon);
      if (!aIn && !bIn) blockers.push(t.polygon);
    } else if (t.kind === 'HIGH_GROUND') {
      if (highObstacleBypass) continue;
      const aIn = isPointInPolygon(a, t.polygon);
      const bIn = isPointInPolygon(b, t.polygon);
      // Same platform — both centres inside this polygon → no block.
      if (aIn && bIn) continue;
      // Both off the platform — acts as a high wall.
      if (!aIn && !bIn) {
        blockers.push(t.polygon);
        continue;
      }
      // Asymmetric: one on this platform, the other off. The on-platform
      // endpoint must be at the edge that faces the off-platform endpoint
      // (peeking over the rim). Otherwise the platform's far perimeter
      // occludes like a high wall.
      const insidePoint = aIn ? a : b;
      const outsidePoint = aIn ? b : a;
      const entry = segmentEntersPolygon(outsidePoint, insidePoint, t.polygon);
      if (entry !== null) {
        const dx = insidePoint.x - entry.x;
        const dy = insidePoint.y - entry.y;
        const r = STANDARD_BASE_RADIUS_PIXELS;
        if (dx * dx + dy * dy > r * r) {
          blockers.push(t.polygon);
        }
      }
    } else if (t.kind === 'DOOR') {
      if (!t.isOpen) blockers.push(t.polygon);
    }
    // DIFFICULT / DOOR(open) — no LOS effect.
  }
  return blockers;
};

/**
 * Smallest crossing point in (ε, 1] where segment from→to first crosses any
 * edge of the polygon. Returns null if the segment never crosses an edge.
 * Used for the HIGH_GROUND edge-proximity rule.
 */
const segmentEntersPolygon = (
  from: Vec2,
  to: Vec2,
  poly: Polygon,
): Vec2 | null => {
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
    if (t > 1e-6 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) {
      if (bestT === null || t < bestT) bestT = t;
    }
  }
  if (bestT === null) return null;
  return { x: from.x + dx * bestT, y: from.y + dy * bestT };
};

/**
 * Test LOS between two circles. Center-to-center only — units have no
 * "peek around the corner" via base width. This matches the LOS preview
 * overlay (`computeVisibilityPolygon`) so what you see on screen is
 * exactly what you can shoot.
 *
 * The set of effective blockers depends on terrain types and per-endpoint
 * stance — see `buildLosBlockers`.
 */
export const hasLOS = (
  a: Circle,
  b: Circle,
  terrains: ReadonlyArray<Terrain>,
  options?: LOSOptions,
): boolean => {
  const blockers = buildLosBlockers(a.center, b.center, terrains, options);
  return !segmentBlockedByPolygons(a.center, b.center, blockers);
};
