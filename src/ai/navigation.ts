/**
 * Pathfinding-aware "step toward target" — picks a 1-UD-ish waypoint that
 * actually heads in a reachable direction, even if the straight line into
 * the target is walled off. Used by greedy and as an extra candidate for
 * lookahead.
 *
 * The NavGrid is cached per-match via a WeakMap keyed by the terrain
 * array reference. The reducer treats terrain as immutable, so the same
 * array object persists across all states of a single match — a single
 * grid build per match is enough.
 */
import type { Vec2 } from '../core/geometry/types';
import { v2Dist } from '../core/geometry/vec2';
import {
  STANDARD_BASE_RADIUS_PIXELS,
  UNIT_DISTANCE_PIXELS,
} from '../core/rules/constants';
import type { GameState, Terrain } from '../core/state/GameState';
import { buildNavGrid, findPath, smoothPath, type NavGrid } from './pathfinding/grid';

const gridCache = new WeakMap<ReadonlyArray<Terrain>, NavGrid>();

export const getNavGrid = (
  state: GameState,
  mapSize = 768,
  cellSize = 16,
  inflateBy = STANDARD_BASE_RADIUS_PIXELS,
): NavGrid => {
  const cached = gridCache.get(state.terrain);
  if (cached && cached.cellSize === cellSize) return cached;
  const grid = buildNavGrid(mapSize, state.terrain, cellSize, inflateBy);
  gridCache.set(state.terrain, grid);
  return grid;
};

/**
 * Compute a sensible MOVE target ~1 UD toward `target`, routing around
 * HARD walls via the grid. Falls back to a straight-line step if no path
 * is found (preserves greedy's old behaviour as a safety net).
 *
 * Stops `stopShort` short of the actual target so the step doesn't end
 * in base contact (which would trigger melee).
 */
export const pathfindingStepToward = (
  state: GameState,
  from: Vec2,
  target: Vec2,
  options: {
    distance?: number;
    stopShort?: number;
    mapSize?: number;
  } = {},
): Vec2 => {
  const distance = options.distance ?? UNIT_DISTANCE_PIXELS;
  const stopShort = options.stopShort ?? 0;
  const mapSize = options.mapSize ?? 768;
  const grid = getNavGrid(state, mapSize);

  const path = findPath(grid, from, target);
  if (!path.success || path.waypoints.length < 2) {
    return straightStep(from, target, distance, stopShort);
  }
  const smoothed = smoothPath(grid, path.waypoints);
  // First waypoint is `from`. Walk the smoothed path until we've covered
  // ~`distance` worth of pixels and emit that point as the move target.
  let remaining = distance;
  let cursor: Vec2 = smoothed[0]!;
  for (let i = 1; i < smoothed.length; i++) {
    const next = smoothed[i]!;
    const dx = next.x - cursor.x;
    const dy = next.y - cursor.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen <= remaining) {
      cursor = next;
      remaining -= segLen;
      if (remaining <= 0) break;
    } else {
      const t = remaining / segLen;
      cursor = { x: cursor.x + dx * t, y: cursor.y + dy * t };
      remaining = 0;
      break;
    }
  }
  // If the picked cursor is past `target` and we want to stop short, pull
  // back along the line from `from`.
  if (stopShort > 0) {
    const distToTarget = v2Dist(cursor, target);
    if (distToTarget < stopShort) {
      const dx = target.x - from.x;
      const dy = target.y - from.y;
      const totalLen = Math.hypot(dx, dy);
      if (totalLen > 0) {
        const cap = Math.max(0, totalLen - stopShort);
        const useLen = Math.min(distance, cap);
        cursor = {
          x: from.x + (dx / totalLen) * useLen,
          y: from.y + (dy / totalLen) * useLen,
        };
      }
    }
  }
  return cursor;
};

const straightStep = (
  from: Vec2,
  target: Vec2,
  distance: number,
  stopShort: number,
): Vec2 => {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { x: from.x, y: from.y };
  const wanted = Math.min(distance, Math.max(0, len - stopShort));
  return {
    x: from.x + (dx / len) * wanted,
    y: from.y + (dy / len) * wanted,
  };
};
