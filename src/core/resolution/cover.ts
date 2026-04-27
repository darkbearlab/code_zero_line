import { isPointInPolygon } from '../geometry/polygon';
import { segmentBlockedByPolygons } from '../geometry/segment';
import type { Terrain, Unit } from '../state/GameState';

/**
 * Phase 4 cover model:
 *  1. Target is inside DIFFICULT terrain → cover (rule 9.2 「處於困難地形內的模型視為處於『掩護』中」).
 *  2. Otherwise, if a HARD obstacle blocks the shooter→target center line
 *     (i.e. the shot is only possible via perimeter peek), target gets cover
 *     (rule 9.1 「攻擊方視線穿過掩體邊緣，該模型獲得掩體」).
 *
 * SOFT cover is deferred — proper handling requires direction-aware checks.
 */
export const targetHasCover = (
  shooter: Unit,
  target: Unit,
  terrains: ReadonlyArray<Terrain>,
): boolean => {
  for (const t of terrains) {
    if (t.kind === 'DIFFICULT' && isPointInPolygon(target.position, t.polygon)) {
      return true;
    }
  }
  const hardPolys = terrains
    .filter((t) => t.kind === 'HARD')
    .map((t) => t.polygon);
  return segmentBlockedByPolygons(shooter.position, target.position, hardPolys);
};
