import type { Command, ReactionPlan } from '../core/commands/types';
import type { Faction, GameState } from '../core/state/GameState';

/**
 * Stateless AI decision function. Given a game state and the faction whose
 * turn it is, return the next command to dispatch. Return `null` only when
 * it is not the AI's turn (the caller already covers that path, but the
 * extra check is cheap and keeps the type honest).
 *
 * The contract is identical to the human dispatch: the command flows through
 * the same `applyCommand` reducer, so AI output is fully deterministic given
 * a fixed state + RNG seed. This is what makes simulation, replay, and
 * head-to-head comparison possible.
 */
export type AiController = (
  state: GameState,
  faction: Faction,
  actionsTakenThisActivation?: number,
) => Command | null;

/**
 * Defender-side reaction planner. Called when the OPPOSING faction issues a
 * MOVE / CRAWL / RALLY etc. so the defender can place reaction markers on
 * the path. Returning `{ markers: [] }` means "don't react".
 */
export type ReactionPlanner = (
  state: GameState,
  defenderFaction: Faction,
  attackerCmd: Command,
) => ReactionPlan;

/**
 * A bundle of (active decision-maker, optional reaction planner). Strategies
 * keep both in one named entry so swapping AIs swaps both halves of play.
 */
export interface AiStrategy {
  readonly decide: AiController;
  /** Optional. If absent, no defender reactions are planned for this side. */
  readonly react?: ReactionPlanner;
}

export interface AiRegistry {
  readonly [name: string]: AiStrategy;
}
