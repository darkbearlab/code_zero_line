/**
 * Defender-side reaction planning. The attacker AI submits a MOVE/CRAWL with
 * empty `reactionPlan`; the simulator (or BattleScene later) asks the
 * defender's AI to fill it in via `planReactions`.
 *
 * v1 ("trigger-happy SOLO") strategy:
 *  - For every reaction window where a defender unit has LOS along the path,
 *    place one SOLO marker at the window's mid-T using that unit's first
 *    REACTION-mode SHOOT weapon.
 *  - Skips defenders that the rules forbid from reacting (cannot react this
 *    round, suppressed/killed, no reaction weapon).
 *
 * Doesn't gate on EV yet — measuring first whether *any* reaction is enough
 * to shift the metric, then we can layer in "skip low-percentage shots".
 */
import { computeReactionWindows } from '../core/geometry/los_window';
import type {
  Command,
  ReactionMarker,
  ReactionPlan,
} from '../core/commands/types';
import type { Faction, GameState } from '../core/state/GameState';
import {
  findUnit,
  getUnitCircle,
  isUnitAlive,
} from '../core/state/GameState';

const isMoveLike = (
  cmd: Command,
): cmd is Extract<Command, { type: 'MOVE' | 'CRAWL' }> =>
  cmd.type === 'MOVE' || cmd.type === 'CRAWL';

export const planReactions = (
  state: GameState,
  defenderFaction: Faction,
  cmd: Command,
): ReactionPlan => {
  // RALLY / VAULT / CLIMB are also reactable per rule 4.4, but their path
  // shape differs (no real motion). Worth a follow-up; v1 covers MOVE/CRAWL
  // which is where exposure-vs-cover decisions matter most.
  if (!isMoveLike(cmd)) return { markers: [] };
  const mover = findUnit(state, cmd.unitId);
  if (!mover || !isUnitAlive(mover)) return { markers: [] };

  const enemies = state.units
    .filter((u) => u.faction === defenderFaction && isUnitAlive(u))
    .map((u) => ({
      id: u.id,
      circle: getUnitCircle(u),
      prone: u.stance === 'PRONE',
    }));
  if (enemies.length === 0) return { markers: [] };

  const windows = computeReactionWindows(
    mover.position,
    cmd.target,
    mover.radius,
    enemies,
    state.terrain,
    { moverProne: mover.stance === 'PRONE' },
  );

  const markers: ReactionMarker[] = [];
  // Defender units may already have reacted this round elsewhere; collect
  // window→shooter info and de-dup so we don't propose two markers per unit.
  const usedShooterIds = new Set<string>();
  for (const w of windows) {
    if (usedShooterIds.has(w.enemyUnitId)) continue;
    const def = findUnit(state, w.enemyUnitId);
    if (!def || !isUnitAlive(def)) continue;
    if (def.cannotReactThisRound) continue;
    if (def.damage === 'SUPPRESSED' || def.damage === 'KILLED') continue;
    const weapon = def.weapons.find(
      (wp) => wp.kind === 'SHOOT' && wp.modes.includes('REACTION'),
    );
    if (!weapon) continue;
    const atT = clamp01((w.startT + w.endT) / 2);
    markers.push({
      atT,
      shooterId: def.id,
      mode: 'SOLO',
      participantIds: [def.id],
      weaponId: weapon.id,
    });
    usedShooterIds.add(def.id);
  }
  return { markers };
};

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
