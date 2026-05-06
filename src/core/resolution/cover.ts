import { isPointInPolygon } from '../geometry/polygon';
import { segmentBlockedByPolygons } from '../geometry/segment';
import {
  isHighWall,
  isLowWall,
  isOnHighGround,
  sharesHighGround,
  type Terrain,
  type Unit,
} from '../state/GameState';
import { VAULT_HEIGHT_THRESHOLD_PIXELS } from '../rules/constants';

/**
 * Per-rule breakdown of why a shot is (or isn't) covered. Each field is an
 * independent reason — any one being true means the attacker eats the -1
 * die penalty. Surface this struct in UI (LOS preview labels) so the player
 * sees *which* rule applies, not just the final boolean.
 */
export interface CoverDetail {
  /** 4.5: target prone. */
  readonly prone: boolean;
  /** Target on HG asymmetric vs ground shooter. */
  readonly highGround: boolean;
  /** 9.2: target inside DIFFICULT terrain. */
  readonly difficult: boolean;
  /** 9.3: shot crosses or touches SOFT (smoke). */
  readonly soft: boolean;
  /**
   * 9.1: shot crosses a hard cover (low wall / BLOCKER / OOB / closed door).
   * Three lines are tested: shooter to target centre, plus shooter to each
   * lateral tangent of the target's base (at ±radius perpendicular to the
   * line of sight). If any one is blocked, cover applies.
   */
  readonly hardWall: boolean;
}

/**
 * Per-rule cover breakdown.
 *
 * Rule sources (same as `targetHasCover`):
 *  - 4.5: prone "視為擁有掩體".
 *  - 9.1: target adjacent to hard cover with LOS crossing the cover edge.
 *  - 9.2: target inside DIFFICULT terrain.
 *  - 9.3: SOFT cover — cover when *either* shooter or target stands inside
 *    a soft polygon.
 *  - HIGH_GROUND: target on platform vs ground-level shooter → cover.
 *    Shooter-on-HG negates LOW wall cover; both-on-HG negates HIGH wall
 *    cover (HG and high walls share the elevated tier).
 *  - BLOCKER / OUT_OF_BOUNDS treated like HARD for cross-cover.
 */
export const coverDetail = (
  shooter: Unit,
  target: Unit,
  terrains: ReadonlyArray<Terrain>,
): CoverDetail => {
  const prone = target.stance === 'PRONE';

  const targetOnHigh = isOnHighGround(target, terrains);
  const shooterOnHigh = isOnHighGround(shooter, terrains);
  const highGround =
    targetOnHigh &&
    !shooterOnHigh &&
    !sharesHighGround(shooter, target, terrains);

  let difficult = false;
  let soft = false;
  for (const t of terrains) {
    if (
      !difficult &&
      t.kind === 'DIFFICULT' &&
      isPointInPolygon(target.position, t.polygon)
    ) {
      difficult = true;
    }
    if (
      !soft &&
      t.kind === 'SOFT' &&
      (isPointInPolygon(target.position, t.polygon) ||
        isPointInPolygon(shooter.position, t.polygon))
    ) {
      soft = true;
    }
  }

  const bothOnHigh = shooterOnHigh && targetOnHigh;
  const hardPolys: import('../geometry/types').Polygon[] = [];
  for (const t of terrains) {
    if (t.kind === 'BLOCKER' || t.kind === 'OUT_OF_BOUNDS') {
      hardPolys.push(t.polygon);
      continue;
    }
    if (t.kind === 'DOOR') {
      // Closed door = high wall for cover (same bothOnHigh bypass as
      // HARD high walls). Open door is transparent.
      if (!t.isOpen) {
        if (!bothOnHigh) hardPolys.push(t.polygon);
      }
      continue;
    }
    if (t.kind !== 'HARD') continue;
    const high = isHighWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS);
    const low = isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS);
    if (bothOnHigh && high) continue;
    if (shooterOnHigh && low && !high) continue;
    hardPolys.push(t.polygon);
  }
  // Cover triggers if EITHER the centre line OR either lateral-tangent line
  // is blocked. The two tangents are at ±target.radius perpendicular to the
  // shooter→target ray — they represent "the two sides of the target's
  // base" as seen by the shooter. If either side is hidden by hard cover
  // the target is considered behind cover, even when the centre line is
  // clear.
  let hardWall = segmentBlockedByPolygons(
    shooter.position,
    target.position,
    hardPolys,
  );
  if (!hardWall && hardPolys.length > 0) {
    const dx = target.position.x - shooter.position.x;
    const dy = target.position.y - shooter.position.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) {
      const px = -dy / dist;
      const py = dx / dist;
      const r = target.radius;
      const left = {
        x: target.position.x + px * r,
        y: target.position.y + py * r,
      };
      const right = {
        x: target.position.x - px * r,
        y: target.position.y - py * r,
      };
      hardWall =
        segmentBlockedByPolygons(shooter.position, left, hardPolys) ||
        segmentBlockedByPolygons(shooter.position, right, hardPolys);
    }
  }

  return { prone, highGround, difficult, soft, hardWall };
};

/**
 * Whether the target gets the cover die-penalty (-1 die to attacker). Any
 * single source from `coverDetail` triggers the penalty — the rules don't
 * stack it.
 */
export const targetHasCover = (
  shooter: Unit,
  target: Unit,
  terrains: ReadonlyArray<Terrain>,
): boolean => {
  const d = coverDetail(shooter, target, terrains);
  return d.prone || d.highGround || d.difficult || d.soft || d.hardWall;
};
