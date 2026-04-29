/**
 * STEALTH (rule 隱身): "在同一個提供掩護的地形特徵內移動不會被反應射擊."
 * Translates to: a MOVE/CRAWL whose start and end points both lie inside
 * the SAME cover-providing polygon (DIFFICULT or SOFT) generates no
 * reaction windows for any defender.
 *
 * Used by both the reducer (to skip computeReactionWindows / suppress
 * defender markers) and the AI's reaction planner (so a stealthed unit's
 * path doesn't even surface as a candidate for reaction). HARD walls
 * don't qualify — you can't move *inside* a wall.
 */
import { isPointInPolygon } from '../geometry/polygon';
import type { Vec2 } from '../geometry/types';
import type { Terrain, Unit } from '../state/GameState';
import { unitHasTrait } from '../traits/types';

export const hasStealthBypass = (
  mover: Unit,
  from: Vec2,
  to: Vec2,
  terrains: ReadonlyArray<Terrain>,
): boolean => {
  if (!unitHasTrait(mover, 'STEALTH')) return false;
  for (const t of terrains) {
    if (t.kind !== 'DIFFICULT' && t.kind !== 'SOFT') continue;
    if (
      isPointInPolygon(from, t.polygon) &&
      isPointInPolygon(to, t.polygon)
    ) {
      return true;
    }
  }
  return false;
};
