import { greedyController } from './controllers/greedy';
import { lookaheadController } from './controllers/lookahead';
import { planReactions } from './reaction';
import type { AiRegistry, AiStrategy } from './types';

/**
 * Named-strategy registry. CLI sims and a future in-game picker resolve AI
 * names through this map. Add new entries here to expose a strategy.
 *
 *   greedy           — 1-ply heuristic; reference baseline.
 *   lookahead        — beam-search planner (depth 2, beam 6).
 *   lookahead-1 / -3 — search-depth variants.
 *   *-noreact        — same decider but defender plans no reactions. Useful
 *                      for measuring how much the reaction layer is worth.
 *
 * v1 reaction planner is shared (`planReactions` — trigger-happy SOLO at
 * window mid-T). Strategies that want a smarter reaction policy can supply
 * a different `react` fn here.
 */
export const aiRegistry: AiRegistry = {
  greedy: { decide: greedyController, react: planReactions },
  lookahead: {
    decide: lookaheadController({ depth: 2, beam: 6 }),
    react: planReactions,
  },
  'lookahead-1': {
    decide: lookaheadController({ depth: 1, beam: 6 }),
    react: planReactions,
  },
  'lookahead-3': {
    decide: lookaheadController({ depth: 3, beam: 6 }),
    react: planReactions,
  },
  'greedy-noreact': { decide: greedyController },
  'lookahead-noreact': {
    decide: lookaheadController({ depth: 2, beam: 6 }),
  },
};

export const getAi = (name: string): AiStrategy => {
  const ai = aiRegistry[name];
  if (!ai) {
    throw new Error(
      `Unknown AI strategy "${name}". Available: ${Object.keys(aiRegistry).join(', ')}`,
    );
  }
  return ai;
};

export type { AiController, AiRegistry, AiStrategy, ReactionPlanner } from './types';
