import type { Circle, Polygon, Vec2 } from './types';
import { segmentBlockedByPolygons } from './segment';
import { isPointInPolygon } from './polygon';
import { v2Sub } from './vec2';
import {
  isHighWall,
  isLowWall,
  type Terrain,
} from '../state/GameState';
import { VAULT_HEIGHT_THRESHOLD_PIXELS } from '../rules/constants';

const SAMPLE_COUNT = 16;

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
 *  - HIGH_GROUND occludes like a high wall when neither endpoint is on
 *    top of it (both at ground level on opposite sides → blocked). If
 *    either endpoint stands on the platform, that platform doesn't block
 *    (the elevated unit looks over it).
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
  // High-ground bypass: when either endpoint stands on a HIGH_GROUND
  // platform, low walls (and only low walls) along the LOS line lose
  // their block. High walls + BLOCKERs still occlude — the platform
  // doesn't make you taller than them.
  const lowWallBypass = options.aOnHighGround || options.bOnHighGround;
  for (const t of terrains) {
    if (t.kind === 'HARD') {
      if (isHighWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS)) {
        blockers.push(t.polygon);
      } else if (isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS)) {
        if (lowWallBypass) continue;
        if (options.aProne || options.bProne) blockers.push(t.polygon);
      }
    } else if (t.kind === 'BLOCKER') {
      // Sealed wall — always occludes, height-independent.
      blockers.push(t.polygon);
    } else if (t.kind === 'SOFT') {
      const aIn = isPointInPolygon(a, t.polygon);
      const bIn = isPointInPolygon(b, t.polygon);
      if (!aIn && !bIn) blockers.push(t.polygon);
    } else if (t.kind === 'HIGH_GROUND') {
      // Acts as a high wall whenever neither endpoint is on top of the
      // platform. An endpoint on the platform is "above the obstacle"
      // and looks over its own footprint — no block from that polygon.
      const aIn = isPointInPolygon(a, t.polygon);
      const bIn = isPointInPolygon(b, t.polygon);
      if (!aIn && !bIn) blockers.push(t.polygon);
    }
    // DIFFICULT — no LOS effect (only grants cover when target inside).
  }
  return blockers;
};

/**
 * Test LOS between two circles. Samples perimeter points on the half facing
 * the other circle; LOS exists if any pair of opposing surface points is
 * unblocked.
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
  if (!segmentBlockedByPolygons(a.center, b.center, blockers)) return true;

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
      if (!segmentBlockedByPolygons(pA, pB, blockers)) return true;
    }
  }
  return false;
};
