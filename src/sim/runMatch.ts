import { applyCommand } from '../core/commands/reducer';
import type {
  Command,
  GameEvent,
  ReactionPlan,
} from '../core/commands/types';
import type { Faction, GameState } from '../core/state/GameState';
import { isUnitAlive } from '../core/state/GameState';
import type { AiStrategy } from '../ai/types';

export type MatchEndReason =
  | 'ELIMINATED'
  | 'OBJECTIVE_SECURED'
  | 'BOTH_PASSED'
  | 'MAX_COMMANDS';

export type ScenarioMode = 'elimination' | 'engage-reach';

export interface MatchOutcome {
  readonly winner: Faction | 'DRAW';
  readonly rounds: number;
  readonly commandCount: number;
  readonly finalState: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly reason: MatchEndReason;
  readonly scenario: ScenarioMode;
  /**
   * Stamp identifying the rules / data the match was played under.
   * Cross-version comparisons are unsafe; sim CLI warns when versions differ.
   */
  readonly rulesetVersion: string;
}

export interface SimulateMatchOptions {
  readonly maxCommands?: number;
  readonly rulesetVersion?: string;
  readonly scenario?: ScenarioMode;
}

const DEFAULT_MAX_COMMANDS = 5000;

const factionAliveCount = (state: GameState, f: Faction): number =>
  state.units.filter((u) => u.faction === f && isUnitAlive(u)).length;

const factionUnitsOnObjective = (state: GameState, f: Faction): number => {
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

interface VictoryResult {
  readonly winner: Faction | null;
  readonly reason: MatchEndReason;
}

const detectVictory = (
  state: GameState,
  scenario: ScenarioMode,
  initialAlive: { A: number; B: number },
): VictoryResult => {
  const a = factionAliveCount(state, 'A');
  const b = factionAliveCount(state, 'B');
  // Hard elimination check works for every scenario.
  if (a === 0 && b === 0) return { winner: null, reason: 'ELIMINATED' };
  if (a === 0) return { winner: 'B', reason: 'ELIMINATED' };
  if (b === 0) return { winner: 'A', reason: 'ELIMINATED' };

  if (scenario === 'engage-reach') {
    // Win when YOU control an objective AND the opponent has lost ≥1 unit
    // (the "engage" half — pure walk-on without any combat doesn't win) AND
    // the opponent does NOT also have a unit on the same/another objective.
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
  return { winner: null, reason: 'MAX_COMMANDS' };
};

/**
 * Headless match simulation. Loops `applyCommand` against the appropriate
 * AI controller for the current initiative holder until one side is wiped,
 * both sides pass with no fresh units, or `maxCommands` is reached.
 *
 * Both AI controllers must be deterministic pure functions of `GameState` —
 * any internal randomness would break replay/A-B comparison guarantees.
 */
/**
 * Whether a command shape carries a defender reaction plan that the
 * simulator should fill in (rule 4.4 — reaction fire on movement / rally).
 * Currently MOVE & CRAWL only; VAULT/CLIMB/RALLY/COMMAND_* are reactable
 * per rules but have non-trivial path semantics — follow-up work.
 */
const acceptsReactions = (
  cmd: Command,
): cmd is Extract<Command, { type: 'MOVE' | 'CRAWL' }> =>
  cmd.type === 'MOVE' || cmd.type === 'CRAWL';

const injectReactionPlan = (
  state: GameState,
  cmd: Command,
  attackerFaction: Faction,
  aiA: AiStrategy,
  aiB: AiStrategy,
): Command => {
  if (!acceptsReactions(cmd)) return cmd;
  // If the attacker AI explicitly populated a non-empty plan, respect it
  // (e.g. a future AI that pre-commits to a reaction; today nobody does).
  const existing: ReactionPlan | undefined = cmd.reactionPlan;
  if (existing && existing.markers.length > 0) return cmd;
  const defender: Faction = attackerFaction === 'A' ? 'B' : 'A';
  const defenderStrategy = defender === 'A' ? aiA : aiB;
  if (!defenderStrategy.react) return cmd;
  const plan = defenderStrategy.react(state, defender, cmd);
  if (plan.markers.length === 0) return cmd;
  return { ...cmd, reactionPlan: plan };
};

export const simulateMatch = (
  initialState: GameState,
  aiA: AiStrategy,
  aiB: AiStrategy,
  opts: SimulateMatchOptions = {},
): MatchOutcome => {
  const maxCommands = opts.maxCommands ?? DEFAULT_MAX_COMMANDS;
  const scenario: ScenarioMode = opts.scenario ?? 'elimination';
  let state = initialState;
  const events: GameEvent[] = [];
  let cmdCount = 0;
  let actionsThisActivation = 0;
  let lastActiveUnitId: string | null = null;
  let consecutivePasses = 0;
  let endReason: MatchEndReason = 'MAX_COMMANDS';
  let finalWinner: Faction | null = null;
  const initialAlive = {
    A: factionAliveCount(initialState, 'A'),
    B: factionAliveCount(initialState, 'B'),
  };

  while (cmdCount < maxCommands) {
    const v = detectVictory(state, scenario, initialAlive);
    if (v.winner !== null || v.reason === 'ELIMINATED') {
      finalWinner = v.winner;
      endReason = v.reason;
      break;
    }

    const faction = state.initiative.holder;
    const strategy = faction === 'A' ? aiA : aiB;

    // Track per-activation action count (resets when activation changes).
    const currActiveId = state.initiative.activeActivation?.unitId ?? null;
    if (currActiveId !== lastActiveUnitId) {
      actionsThisActivation = 0;
      lastActiveUnitId = currActiveId;
    }

    const rawCmd: Command | null = strategy.decide(
      state,
      faction,
      actionsThisActivation,
    );
    const cmd = rawCmd
      ? injectReactionPlan(state, rawCmd, faction, aiA, aiB)
      : null;
    if (!cmd) {
      // AI returned null when it shouldn't have — treat as a pass to avoid
      // infinite loops; will trigger BOTH_PASSED if it persists.
      consecutivePasses += 1;
      if (consecutivePasses >= 2) {
        endReason = 'BOTH_PASSED';
        break;
      }
      // Force a PASS_INITIATIVE so the other side gets a turn.
      const r = applyCommand(state, { type: 'PASS_INITIATIVE' });
      state = r.state;
      events.push(...r.events);
      cmdCount += 1;
      continue;
    }

    if (cmd.type === 'PASS_INITIATIVE') {
      consecutivePasses += 1;
      if (consecutivePasses >= 2) {
        endReason = 'BOTH_PASSED';
        // Still apply the pass so the final state is well-formed.
        try {
          const r = applyCommand(state, cmd);
          state = r.state;
          events.push(...r.events);
          cmdCount += 1;
        } catch {
          /* state already terminal */
        }
        break;
      }
    } else {
      consecutivePasses = 0;
    }

    let r;
    try {
      r = applyCommand(state, cmd);
    } catch (err) {
      // An invalid AI command shouldn't crash the simulator — abort the match
      // as a draw and surface it via reason.
      endReason = 'BOTH_PASSED';
      events.push({
        type: 'ACTIVATION_ENDED',
        unitId: state.initiative.activeActivation?.unitId ?? '?',
        reason: 'NORMAL',
      });
      void err;
      break;
    }
    state = r.state;
    events.push(...r.events);
    cmdCount += 1;

    if (cmd.type !== 'PASS_INITIATIVE' && cmd.type !== 'END_ACTIVATION') {
      actionsThisActivation += 1;
    }
  }

  // If the loop exited without setting finalWinner, run one final detect so
  // BOTH_PASSED / MAX_COMMANDS scenarios still return the right winner if
  // someone happens to be sitting on an objective at the end.
  if (finalWinner === null && endReason !== 'OBJECTIVE_SECURED') {
    const v = detectVictory(state, scenario, initialAlive);
    if (v.winner !== null) {
      finalWinner = v.winner;
      // Don't overwrite BOTH_PASSED / MAX_COMMANDS reason — they describe
      // *how* the match ended; victory is just an outcome modifier.
    }
  }
  return {
    winner: finalWinner ?? 'DRAW',
    rounds: state.initiative.round,
    commandCount: cmdCount,
    finalState: state,
    events,
    reason: endReason,
    scenario,
    rulesetVersion: opts.rulesetVersion ?? 'unspecified',
  };
};
