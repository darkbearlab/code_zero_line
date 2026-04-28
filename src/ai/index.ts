import { greedyController } from './controllers/greedy';
import { lookaheadController } from './controllers/lookahead';
import type { AiController, AiRegistry } from './types';

/**
 * Named-strategy registry. CLI sims and a future in-game picker resolve AI
 * names through this map. Add new entries here to expose a strategy.
 *
 *   greedy        — 1-ply heuristic; reference baseline.
 *   lookahead     — beam-search planner (depth 2, beam 6) over per-activation
 *                   command sequences using the state evaluator.
 *   lookahead-1   — depth-1 variant for sanity ("one-action lookahead").
 *   lookahead-3   — deeper search; slower but should bend close fights.
 */
export const aiRegistry: AiRegistry = {
  greedy: greedyController,
  lookahead: lookaheadController({ depth: 2, beam: 6 }),
  'lookahead-1': lookaheadController({ depth: 1, beam: 6 }),
  'lookahead-3': lookaheadController({ depth: 3, beam: 6 }),
};

export const getAi = (name: string): AiController => {
  const ai = aiRegistry[name];
  if (!ai) {
    throw new Error(
      `Unknown AI strategy "${name}". Available: ${Object.keys(aiRegistry).join(', ')}`,
    );
  }
  return ai;
};

export type { AiController, AiRegistry } from './types';
