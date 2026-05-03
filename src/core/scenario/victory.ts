/**
 * Scenario-aware victory checking. Shared by `BattleScene` (live UI) and
 * `runMatch` (sim). Pure function of `(state, scenario, params, initialAlive)`.
 *
 * Each scenario expresses a different shape of pressure:
 *  - elimination:  classic — last side standing wins.
 *  - engage-reach: hold the objective AND have done some damage. Walk-on
 *                  wins are forbidden.
 *  - defend:       keep the enemy off the objective until the player has
 *                  burnt through `defendActivations` activations.
 *                  An enemy on the marker = instant defender loss.
 *  - extract:      get N units inside the marker before the player runs
 *                  out of `extractActivations` activations.
 *
 * The clock for defend / extract / assassinate is driven by
 * `state.initiative.playerActivations` — the cumulative number of times
 * faction A has spent / checked / overdrafted into a fresh activation.
 * This unifies the cost of SPEND, CHECK, and OVERDRAFT (each = 1 tick)
 * and prices command-driven moves the same as single-unit pushes.
 *
 * Scenario victory is layered: ELIMINATED is always checked first regardless
 * of scenario, so wiping the enemy is always a valid win path.
 */
import type { Faction, GameState } from '../state/GameState';
import { isUnitAlive } from '../state/GameState';
import { factionInstantlyControlsAll } from './objectiveControl';

export type ScenarioMode =
  | 'elimination'
  | 'engage-reach'
  | 'defend'
  | 'extract'
  | 'assassinate'
  | 'control-points';

export type MatchEndReason =
  | 'ELIMINATED'
  | 'OBJECTIVE_SECURED'
  | 'BOTH_PASSED'
  | 'MAX_COMMANDS';

export interface ScenarioParams {
  /**
   * defend: defender wins after the player has issued this many activations
   * while still holding the objective. Counted on faction A regardless of
   * activation kind (SPEND / CHECK / OVERDRAFT). Default 999 (off).
   */
  readonly defendActivations?: number;
  /** extract: required friendly count inside the marker. Default 2. */
  readonly extractCount?: number;
  /**
   * extract: player-activation budget. If exceeded without enough units
   * extracted, defender wins. Default 999 (off).
   */
  readonly extractActivations?: number;
  /** assassinate: id of the enemy unit the player must kill. */
  readonly vipUnitId?: string;
  /**
   * assassinate: player-activation budget. If exceeded without VIP killed,
   * defender wins. Default 999 (off).
   */
  readonly assassinateActivations?: number;
  /**
   * engage-reach / defend modifier. When true, the side wins (or loses) only
   * when controlling EVERY objective on the map, not just one. Uses live
   * presence — does not depend on the stateful capture model.
   */
  readonly requireAllObjectives?: boolean;
  /**
   * control-points: absolute score threshold a side must reach to win.
   * Default 5.
   */
  readonly winScore?: number;
  /**
   * control-points: required margin over the opponent's score on top of
   * `winScore`. Both gates must pass — prevents the side that scored first
   * from coasting on stall tactics. Default 2.
   */
  readonly winLead?: number;
  /**
   * control-points: per-objective score weight. Missing entries default
   * to 1. Reducer reads this off `state.scenarioInfo.params.objectiveWeights`
   * each cycle bump.
   */
  readonly objectiveWeights?: Readonly<Record<string, number>>;
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

// All player-activation limits default to 999 — effectively "no clock".
// Concrete missions opt in to a real clock by overriding their scenarioParams.
// Tune per-mission once sim runs let us see typical activation distributions.
export const DEFEND_ACTIVATIONS_DEFAULT = 999;
export const EXTRACT_COUNT_DEFAULT = 2;
export const EXTRACT_ACTIVATIONS_DEFAULT = 999;
export const ASSASSINATE_ACTIVATIONS_DEFAULT = 999;
export const WIN_SCORE_DEFAULT = 5;
export const WIN_LEAD_DEFAULT = 2;

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
    const aEngaged = a < initialAlive.A;
    const bEngaged = b < initialAlive.B;
    if (params.requireAllObjectives) {
      // ALL-of: only count a side as "on objective" when they uniquely hold
      // every point on the map (live presence, not stateful capture).
      if (factionInstantlyControlsAll(state, 'A') && bEngaged) {
        return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
      }
      if (factionInstantlyControlsAll(state, 'B') && aEngaged) {
        return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
      }
    } else {
      const aOnObj = factionUnitsOnObjective(state, 'A');
      const bOnObj = factionUnitsOnObjective(state, 'B');
      if (aOnObj > 0 && bOnObj === 0 && bEngaged) {
        return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
      }
      if (bOnObj > 0 && aOnObj === 0 && aEngaged) {
        return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
      }
    }
  }

  if (scenario === 'defend') {
    const defendActivations =
      params.defendActivations ?? DEFEND_ACTIVATIONS_DEFAULT;
    // Defender loses when the attacker gets onto the objective(s). With
    // requireAllObjectives, attacker must be uniquely present on EVERY point.
    const attackerOnObjective = params.requireAllObjectives
      ? factionInstantlyControlsAll(state, 'B')
      : factionUnitsOnObjective(state, 'B') > 0;
    if (attackerOnObjective) {
      return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
    }
    if (state.initiative.playerActivations > defendActivations) {
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
    const limit = params.extractActivations ?? EXTRACT_ACTIVATIONS_DEFAULT;
    const aOnObj = factionUnitsOnObjective(state, 'A');
    if (aOnObj >= extractCount) {
      return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
    }
    if (state.initiative.playerActivations > limit) {
      return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
    }
  }

  if (scenario === 'control-points') {
    // Both gates must pass: absolute score + lead margin. The lead gate
    // stops a side that scored first from coasting on stall tactics —
    // the opponent can always recapture and pull the margin back below
    // `winLead`, keeping the match alive.
    const winScore = params.winScore ?? WIN_SCORE_DEFAULT;
    const winLead = params.winLead ?? WIN_LEAD_DEFAULT;
    const scores = state.initiative.objectiveScores ?? { A: 0, B: 0 };
    if (scores.A >= winScore && scores.A - scores.B >= winLead) {
      return { winner: 'A', reason: 'OBJECTIVE_SECURED' };
    }
    if (scores.B >= winScore && scores.B - scores.A >= winLead) {
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
      const limit =
        params.assassinateActivations ?? ASSASSINATE_ACTIVATIONS_DEFAULT;
      if (state.initiative.playerActivations > limit) {
        return { winner: 'B', reason: 'OBJECTIVE_SECURED' };
      }
    }
  }

  return { winner: null, reason: 'MAX_COMMANDS' };
};
