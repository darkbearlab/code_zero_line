import type { Command } from '../core/commands/types';
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

export interface AiRegistry {
  readonly [name: string]: AiController;
}
