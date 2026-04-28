import { isPointInPolygon } from '../geometry/polygon';
import { segmentBlockedByPolygons } from '../geometry/segment';
import type { Terrain, Unit } from '../state/GameState';

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
 */
export const targetHasCover = (
  shooter: Unit,
  target: Unit,
  terrains: ReadonlyArray<Terrain>,
): boolean => {
  if (target.stance === 'PRONE') return true;
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
  const hardPolys = terrains
    .filter((t) => t.kind === 'HARD')
    .map((t) => t.polygon);
  return segmentBlockedByPolygons(shooter.position, target.position, hardPolys);
};
