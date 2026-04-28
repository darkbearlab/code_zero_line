import type { Circle, Vec2 } from './types';
import { hasLOS } from './los';
import { v2Lerp } from './vec2';
import type { Terrain } from '../state/GameState';

/** A contiguous range along a movement path during which an enemy has LOS to the mover. */
export interface ReactionWindow {
  readonly enemyUnitId: string;
  readonly startT: number;
  readonly endT: number;
}

export interface EnemyForLOS {
  readonly id: string;
  readonly circle: Circle;
  /** Whether the enemy is prone (affects low-wall LOS rules). */
  readonly prone?: boolean;
}

/**
 * Sample the linear path from→to and report, per enemy, the contiguous
 * t-ranges during which the enemy has LOS to the mover circle.
 *
 * `samples` controls granularity (default 32 ⇒ ~3% per step).
 */
export const computeReactionWindows = (
  from: Vec2,
  to: Vec2,
  moverRadius: number,
  enemies: ReadonlyArray<EnemyForLOS>,
  terrains: ReadonlyArray<Terrain>,
  options: { moverProne?: boolean } = {},
  samples = 32,
): ReadonlyArray<ReactionWindow> => {
  const out: ReactionWindow[] = [];
  for (const enemy of enemies) {
    let inWindow = false;
    let windowStart = 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const moverPos = v2Lerp(from, to, t);
      const visible = hasLOS(
        enemy.circle,
        { center: moverPos, radius: moverRadius },
        terrains,
        { aProne: enemy.prone, bProne: options.moverProne },
      );
      if (visible && !inWindow) {
        inWindow = true;
        windowStart = t;
      } else if (!visible && inWindow) {
        inWindow = false;
        out.push({ enemyUnitId: enemy.id, startT: windowStart, endT: t });
      }
    }
    if (inWindow) {
      out.push({ enemyUnitId: enemy.id, startT: windowStart, endT: 1 });
    }
  }
  return out;
};
