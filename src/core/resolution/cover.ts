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
 * Whether the target gets the cover die-penalty (-1 die to attacker).
 *
 * Rule sources:
 *  - 4.5: prone "視為擁有掩體" (does not stack with terrain cover, but the
 *    cumulative die effect is the same single -1).
 *  - 9.1: target adjacent to hard cover with LOS crossing the cover edge.
 *  - 9.2: target inside DIFFICULT terrain.
 *  - 9.3: SOFT cover — both inside and outside benefit from cover when shot
 *    crosses smoke (rule says "彼此視為處於『掩體』中" — implemented as: cover
 *    when *either* shooter or target stands inside a soft polygon).
 *  - HIGH_GROUND: target on platform vs ground-level shooter → cover (high
 *    ground advantage). Symmetrically, a shooter on high ground neutralises
 *    low-wall cover for ground-level targets (overhead shot).
 *  - BLOCKER: pure obstacle, treated like HARD for cross-cover purposes.
 */
export const targetHasCover = (
  shooter: Unit,
  target: Unit,
  terrains: ReadonlyArray<Terrain>,
): boolean => {
  if (target.stance === 'PRONE') return true;

  const targetOnHigh = isOnHighGround(target, terrains);
  const shooterOnHigh = isOnHighGround(shooter, terrains);
  // Defender on high ground vs shooter on lower ground (or different
  // platform): grant cover from the elevation itself, no segment check.
  if (
    targetOnHigh &&
    !shooterOnHigh &&
    !sharesHighGround(shooter, target, terrains)
  ) {
    return true;
  }

  for (const t of terrains) {
    if (t.kind === 'DIFFICULT' && isPointInPolygon(target.position, t.polygon)) {
      return true;
    }
    if (t.kind === 'SOFT') {
      if (
        isPointInPolygon(target.position, t.polygon) ||
        isPointInPolygon(shooter.position, t.polygon)
      ) {
        return true;
      }
    }
  }

  // Cross-cover from physical walls. Two modifiers:
  //  - shooter-on-HG negates LOW wall cover (overhead shot)
  //  - both-on-HG negates HIGH wall cover (high walls and HG share the
  //    elevated tier — see los.ts highObstacleBypass; cover must agree
  //    or the LOS bypass becomes meaningless).
  // BLOCKERs always count regardless of stance/elevation.
  const bothOnHigh = shooterOnHigh && targetOnHigh;
  const hardPolys: import('../geometry/types').Polygon[] = [];
  for (const t of terrains) {
    // OUT_OF_BOUNDS treated as a sealed boundary like BLOCKER for cross-cover.
    // NO_ENTRY does not contribute cover — it's an atrium void that LOS sees
    // through and that no one can stand inside, so the rim doesn't shield.
    if (t.kind === 'BLOCKER' || t.kind === 'OUT_OF_BOUNDS') {
      hardPolys.push(t.polygon);
      continue;
    }
    if (t.kind !== 'HARD') continue;
    const high = isHighWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS);
    const low = isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS);
    if (bothOnHigh && high) continue;
    if (shooterOnHigh && low && !high) continue;
    hardPolys.push(t.polygon);
  }
  return segmentBlockedByPolygons(shooter.position, target.position, hardPolys);
};
