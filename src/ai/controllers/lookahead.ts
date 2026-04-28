import { applyCommand } from '../../core/commands/reducer';
import type { Command } from '../../core/commands/types';
import type { GameState } from '../../core/state/GameState';
import { DEFAULT_WEIGHTS, evaluateState, type EvalWeights } from '../eval';
import type { AiController } from '../types';
import { greedyController } from './greedy';
import { generateCandidates } from './candidates';

export interface LookaheadOptions {
  /** How many active actions to expand inside one activation. */
  readonly depth?: number;
  /** Top-K candidates retained per ply. */
  readonly beam?: number;
  readonly weights?: EvalWeights;
}

interface SearchNode {
  readonly state: GameState;
  readonly score: number;
  readonly firstCommand: Command | null;
}

/** Try `applyCommand`, swallow validation errors as "this branch is dead". */
const tryApply = (state: GameState, cmd: Command): GameState | null => {
  try {
    return applyCommand(state, cmd).state;
  } catch {
    return null;
  }
};

/**
 * Score-function-based search over command sequences inside one activation.
 * Returns the *first* command of the best-scoring expanded sequence; the
 * caller dispatches it, the state evolves, the controller is re-invoked, and
 * the next layer of the plan emerges naturally — i.e. this is iterative
 * deepening on the live game tree, not a closed plan.
 *
 * Reaction modelling is deliberately omitted in this pass: MOVE / RALLY
 * candidates carry empty `reactionPlan.markers`. The reducer still computes
 * reaction windows for them, but the simulator's defender AI will not be
 * planning markers either, so the comparison stays apples-to-apples until
 * Phase D-2 lands defender-side reaction planning.
 */
export const lookaheadController = (
  opts: LookaheadOptions = {},
): AiController => {
  const depth = opts.depth ?? 2;
  const beam = opts.beam ?? 6;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;

  return (state, faction, actionsTakenThisActivation = 0) => {
    if (state.initiative.holder !== faction) return null;

    // Unit selection (no active activation): defer to greedy. Activation
    // choice is a low-branching decision and its quality is dwarfed by what
    // the unit does once it's active — search budget is better spent inside
    // the activation.
    if (!state.initiative.activeActivation) {
      return greedyController(state, faction, actionsTakenThisActivation);
    }

    // CHECK_SUCCESS units must end after one action regardless of plan score.
    if (
      state.initiative.activeActivation.kind === 'CHECK_SUCCESS' &&
      actionsTakenThisActivation >= 1
    ) {
      return { type: 'END_ACTIVATION' };
    }

    const candidates = generateCandidates(state, faction);
    if (candidates.length === 0) {
      return { type: 'END_ACTIVATION' };
    }

    const expand = (s: GameState, cmds: ReadonlyArray<Command>): SearchNode[] => {
      const nodes: SearchNode[] = [];
      for (const cmd of cmds) {
        const next = tryApply(s, cmd);
        if (!next) continue;
        nodes.push({
          state: next,
          score: evaluateState(next, faction, weights),
          firstCommand: cmd,
        });
      }
      nodes.sort((a, b) => b.score - a.score);
      return nodes.slice(0, beam);
    };

    let frontier = expand(state, candidates);
    if (frontier.length === 0) return { type: 'END_ACTIVATION' };

    // Successive plies: same activation only. The controller will be called
    // again after each dispatched command, so deeper plies here are purely
    // for *foreseeing* whether a near-term sacrifice (e.g. MOVE giving up an
    // immediate shot) pays off in a follow-up action.
    for (let ply = 1; ply < depth; ply++) {
      const next: SearchNode[] = [];
      for (const node of frontier) {
        // Stop expanding if the activation has already ended in this branch.
        if (!node.state.initiative.activeActivation) {
          next.push(node);
          continue;
        }
        const moreCmds = generateCandidates(node.state, faction);
        for (const cmd of moreCmds) {
          const childState = tryApply(node.state, cmd);
          if (!childState) continue;
          next.push({
            state: childState,
            // Carry the original first command so we can retrieve it at the leaf.
            firstCommand: node.firstCommand,
            score: evaluateState(childState, faction, weights),
          });
        }
      }
      next.sort((a, b) => b.score - a.score);
      frontier = next.slice(0, beam);
      if (frontier.length === 0) break;
    }

    const best = frontier[0]!;
    return best.firstCommand ?? { type: 'END_ACTIVATION' };
  };
};
