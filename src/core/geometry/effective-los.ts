/**
 * Stealth-aware LOS wrapper. When the run is in stealth state, enemies
 * (faction B) see the player (faction A) only within 1UD; outside that
 * range LOS is treated as blocked regardless of terrain. Player→enemy
 * sight is unchanged. With stealth off this is a passthrough to `hasLOS`.
 *
 * Why a wrapper instead of patching `hasLOS`: the geometric LOS engine
 * stays pure (no GameState dependency). Callsites that need stealth
 * semantics opt in by importing `effectiveLOS`; the rest stay untouched.
 */
import type { GameState, Unit } from '../state/GameState';
import { getUnitCircle } from '../state/GameState';
import { hasLOS, type LOSOptions } from './los';
import type { Terrain } from '../state/GameState';
import { v2Dist } from './vec2';
import { UNIT_DISTANCE_PIXELS } from '../rules/constants';

export const effectiveLOS = (
  observer: Unit,
  target: Unit,
  state: GameState,
  terrain: ReadonlyArray<Terrain>,
  opts?: LOSOptions,
): boolean => {
  if (
    state.stealth?.active === true &&
    observer.faction === 'B' &&
    target.faction === 'A'
  ) {
    const d = v2Dist(observer.position, target.position);
    if (d > UNIT_DISTANCE_PIXELS) return false;
  }
  return hasLOS(getUnitCircle(observer), getUnitCircle(target), terrain, opts);
};
