/**
 * Defender-side reaction planning. The attacker AI submits a MOVE/CRAWL with
 * empty `reactionPlan`; the simulator (or BattleScene later) asks the
 * defender's AI to fill it in via `planReactions`.
 *
 * v2 (EV-gated SOLO):
 *  - Only place a marker when expected hits at the SHOT t ≥ MIN_EV_HITS.
 *    Reaction misses are punished by rule 4.4 — every participant in a
 *    missed shot is barred from reacting again that round, so a 4d/5+
 *    long-range guess wastes the unit's whole-round reaction.
 *  - EV computed at window-midpoint with cover applied, mirroring how the
 *    reducer's resolveShot will read the situation when the marker fires.
 *  - One marker per defender max (no double-tap on multi-window paths).
 *
 * Threshold of 0.5 hits chosen empirically: 4d/4+ unobstructed = 2.0 EV,
 * 4d/4+ with cover = 1.5 EV (clear fire), 4d/5+ with cover = 1.0 EV
 * (pass), 2d/5+ unobstructed = 0.67 EV (still fire). Anything weaker than
 * "expected to land at least half a hit" is a coin-flip the rule punishes.
 */
const MIN_EV_HITS = 0.5;

import { computeReactionWindows } from '../core/geometry/los_window';
import { v2Lerp } from '../core/geometry/vec2';
import { targetHasCover } from '../core/resolution/cover';
import {
  applyCoverToProfile,
  buildDiceProfile,
  profileExpectedHits,
} from '../core/resolution/dice';
import { hasStealthBypass } from '../core/resolution/stealth';

/**
 * Expected hits for a candidate reaction shot via the dice profile engine.
 * Phase A passes reductionLevel=0 (single-group profile); Phase C will
 * lookup combat-intel.shoot level for the target's tags here. Cover
 * removes the most-reduced die first per applyCoverToProfile.
 */
const expectedHits = (
  diceCount: number,
  threshold: number,
  cover: boolean,
): number => {
  let profile = buildDiceProfile(diceCount, threshold, 0);
  if (cover) profile = applyCoverToProfile(profile);
  return profileExpectedHits(profile);
};
import type {
  Command,
  ReactionMarker,
  ReactionPlan,
} from '../core/commands/types';
import type { Faction, GameState, Unit } from '../core/state/GameState';
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
  // Stealth: enemies do not react-fire at all while undetected (rule sets
  // patrol as the sole stealth-side enemy behavior). Player-side reactions
  // (defenderFaction === 'A') stay unchanged.
  if (state.stealth?.active === true && defenderFaction === 'B') {
    return { markers: [] };
  }
  // RALLY / VAULT / CLIMB are also reactable per rule 4.4, but their path
  // shape differs (no real motion). Worth a follow-up; v1 covers MOVE/CRAWL
  // which is where exposure-vs-cover decisions matter most.
  if (!isMoveLike(cmd)) return { markers: [] };
  const mover = findUnit(state, cmd.unitId);
  if (!mover || !isUnitAlive(mover)) return { markers: [] };
  // STEALTH bypass: stealthed unit moving inside a single cover polygon is
  // unreactable. Mirror the reducer-side rule so the planner doesn't
  // hand-craft markers the reducer would discard anyway.
  if (hasStealthBypass(mover, mover.position, cmd.target, state.terrain)) {
    return { markers: [] };
  }

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
    // EV gate: simulate the would-be shot at this t and only commit if the
    // expected-hits payoff justifies burning the unit's reaction-this-round.
    const moverAtT = v2Lerp(mover.position, cmd.target, atT);
    const phantomTarget: Unit = { ...mover, position: moverAtT };
    const cover = targetHasCover(def, phantomTarget, state.terrain);
    const ev = expectedHits(weapon.diceCount, weapon.threshold, cover);
    if (ev < MIN_EV_HITS) continue;
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
