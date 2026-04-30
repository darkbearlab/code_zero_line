/**
 * Scenario-aware victory checking. Shared by `BattleScene` (live UI) and
 * `runMatch` (sim). Pure function of `(state, scenario, params, initialAlive)`.
 *
 * Each scenario expresses a different shape of pressure:
 *  - elimination:  classic — last side standing wins.
 *  - engage-reach: hold the objective AND have done some damage. Walk-on
 *                  wins are forbidden.
 *  - defend:       keep the enemy off the objective until round limit.
 *                  An enemy on the marker = instant defender loss; outlasting
 *                  to round N+1 = defender wins.
 *  - extract:      get N units inside the marker before the clock runs out.
 *                  Failure to extract by `extractRoundLimit` = enemy wins.
 *
 * Scenario victory is layered: ELIMINATED is always checked first regardless
 * of scenario, so wiping the enemy is always a valid win path.
 */
import type { Faction, GameState } from '../state/GameState';
import { isUnitAlive } from '../state/GameState';

export type ScenarioMode =
  | 'elimination'
  | 'engage-reach'
  | 'defend'
  | 'extract'
  | 'assassinate';

export type MatchEndReason =
  | 'ELIMINATED'
  | 'OBJECTIVE_SECURED'
  | 'BOTH_PASSED'
  | 'MAX_COMMANDS';

export interface ScenarioParams {
  /** defend: defender wins after this round if they still hold. Default 5. */
  readonly defendRounds?: number;
  /** extract: required friendly count inside the marker. Default 2. */
  readonly extractCount?: number;
  /** extract: round at which the clock runs out. Default 8. */
  readonly extractRoundLimit?: number;
  /** assassinate: id of the enemy unit the player must kill. */
  readonly vipUnitId?: string;
  /** assassinate: round at which the clock runs out. Default 8. */
  readonly assassinateRoundLimit?: number;
}

export interface VictoryResult {
  readonly winner: Faction | null;
  readonly reason: MatchEndReason;
}

export const factionAliveCount = (state: GameState, f: Faction): number =>
  state.units.filter((u) => u.faction === f && isUnitAlive(u)).length;

export const factionUnitsOnObjective = (
  state: GameState,
  f: Faction,
): number => {
  const objs = state.objectives ?? [];
  if (objs.length === 0) return 0;
  let count = 0;
  for (const u of state.units) {
    if (u.faction !== f || !isUnitAlive(u)) continue;
    for (const o of objs) {
      const dx = u.position.x - o.position.x;
      const dy = u.position.y - o.position.y;
      if (dx * dx + dy * dy <= o.radius * o.radius) {
        count += 1;
        break;
      }
    }
  }
  return count;
};

export const DEFEND_ROUNDS_DEFAULT = 5;
export const EXTRACT_COUNT_DEFAULT = 2;
export const EXTRACT_ROUND_LIMIT_DEFAULT = 8;
export const ASSASSINATE_ROUND_LIMIT_DEFAULT = 8;

export const detectScenarioVictory = (
  state: GameState,
  scenario: ScenarioMode,
  params: ScenarioParams,
  initialAlive: { A: number; B: number },
): VictoryResult => {
  const a = factionAliveCount(state, 'A');
  const b = factionAliveCount(state, 'B');
  if (a === 0 && b === 0) return { winner: null, reason: 'ELIMINATED' };
  if (a === 0) return { winner: 'B', reason: 'ELIMINATED' };
  if (b === 0) return { winner: 'A', reason: 'ELIMINATED' };

  if (scenario === 'engage-reach') {
    const aOnObj = factionUnitsOnObjective(state, 'A');
    const bOnObj = factionUnitsOnObjective(state, 'B');
    const aEngaged = a < initialAlive.A;
    const bEngaged = b < initialAlive.B;
    if (aOnObj > 0 && bOnObj === 0 && bEngaged) {
      return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
    }
    if (bOnObj > 0 && aOnObj === 0 && aEngaged) {
      return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
    }
  }

  if (scenario === 'defend') {
    const defendRounds = params.defendRounds ?? DEFEND_ROUNDS_DEFAULT;
    const bOnObj = factionUnitsOnObjective(state, 'B');
    // Enemy on the marker — defender loses instantly.
    if (bOnObj > 0) return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
    if (state.initiative.round > defendRounds) {
      const aOnObj = factionUnitsOnObjective(state, 'A');
      // Defender wins by holding past the timer. If A has abandoned the
      // marker too, fall back to alive-count tiebreak so the run still ends.
      if (aOnObj > 0) return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
      if (a > b) return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
      if (b > a) return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
      return { winner: null, reason: 'OBJECTIVE_SECURED' };
    }
  }

  if (scenario === 'extract') {
    const extractCount = params.extractCount ?? EXTRACT_COUNT_DEFAULT;
    const roundLimit = params.extractRoundLimit ?? EXTRACT_ROUND_LIMIT_DEFAULT;
    const aOnObj = factionUnitsOnObjective(state, 'A');
    if (aOnObj >= extractCount) {
      return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
    }
    if (state.initiative.round > roundLimit) {
      return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
    }
  }

  if (scenario === 'assassinate') {
    // Player wins by killing the named VIP. If params omit vipUnitId the
    // mission is misconfigured and only ELIMINATED can resolve it; the
    // helper falls through silently rather than crashing the sim.
    const vipId = params.vipUnitId;
    if (vipId) {
      const vip = state.units.find((u) => u.id === vipId);
      if (!vip || vip.damage === 'KILLED') {
        return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
      }
      const limit = params.assassinateRoundLimit ?? ASSASSINATE_ROUND_LIMIT_DEFAULT;
      if (state.initiative.round > limit) {
        return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
      }
    }
  }

  return { winner: null, reason: 'MAX_COMMANDS' };
};
