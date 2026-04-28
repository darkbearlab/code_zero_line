import { hasLOS } from '../core/geometry/los';
import { targetHasCover } from '../core/resolution/cover';
import type { Faction, GameState, Unit } from '../core/state/GameState';
import { isUnitAlive } from '../core/state/GameState';

export interface EvalWeights {
  /** Base value of being alive at all. */
  readonly unitAliveBase: number;
  /** Per-quality bonus: lower threshold = more capable, more valuable. */
  readonly qualityBonus: { 1: number; 2: number; 3: number; 4: number };
  /** Per-damage-state penalty (subtracted from the alive bonus). */
  readonly damagePenalty: {
    NONE: number;
    IMPEDED: number;
    SUPPRESSED: number;
    KILLED: number;
  };
  /** Bonus for being prone OR having terrain/wall cover relative to nearest threat. */
  readonly inCoverBonus: number;
  /** Per-pair bonus when we can shoot an enemy who can't see us back. */
  readonly oneSidedLosBonus: number;
  /** Value of one momentum point. */
  readonly momentumValue: number;
  /** Bonus for currently holding initiative. */
  readonly initiativeHolderBonus: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  unitAliveBase: 100,
  qualityBonus: { 1: 40, 2: 20, 3: 10, 4: 0 },
  damagePenalty: { NONE: 0, IMPEDED: 25, SUPPRESSED: 60, KILLED: 100 },
  inCoverBonus: 12,
  oneSidedLosBonus: 8,
  momentumValue: 4,
  initiativeHolderBonus: 6,
};

/**
 * Trait evaluator hook. New traits register here so evaluator picks up
 * trait-conferred value without rewrites. Each hook returns a delta added
 * to the unit's score from the unit's faction's perspective.
 *
 * Example future entries:
 *   STEALTH: (u) => u.stance === 'PRONE' ? 8 : 0,
 *   OFFICER: (u, s) => alliesWithin1UD(u, s).length * 4,
 */
export type TraitEvalHook = (unit: Unit, state: GameState) => number;

export const traitEvalHooks: Record<string, TraitEvalHook> = {
  // Phase 1 placeholder — real trait values land alongside trait hookups.
};

const oppositeFaction = (f: Faction): Faction => (f === 'A' ? 'B' : 'A');

const qualityBonusFor = (quality: number, weights: EvalWeights): number => {
  const q = quality as 1 | 2 | 3 | 4;
  return weights.qualityBonus[q] ?? 0;
};

const unitScore = (
  u: Unit,
  state: GameState,
  weights: EvalWeights,
  threats: ReadonlyArray<Unit>,
): number => {
  if (!isUnitAlive(u)) return 0;
  let score = weights.unitAliveBase;
  score += qualityBonusFor(u.quality, weights);
  score -= weights.damagePenalty[u.damage];
  // Cover relative to the nearest enemy that has LOS — the closest concrete
  // threat is the one cover actually mitigates against right now.
  if (threats.length > 0) {
    const nearest = nearestThreat(u, threats);
    if (nearest && targetHasCover(nearest, u, state.terrain)) {
      score += weights.inCoverBonus;
    }
  }
  // Trait-driven adjustments (registry — extensible per skill rollout).
  for (const t of u.traits) {
    const traitId = t.split(':')[0]!.split('(')[0]!.trim();
    const hook = traitEvalHooks[traitId];
    if (hook) score += hook(u, state);
  }
  return score;
};

const nearestThreat = (u: Unit, threats: ReadonlyArray<Unit>): Unit | null => {
  let best: Unit | null = null;
  let bestSq = Infinity;
  for (const t of threats) {
    const dx = t.position.x - u.position.x;
    const dy = t.position.y - u.position.y;
    const d = dx * dx + dy * dy;
    if (d < bestSq) {
      bestSq = d;
      best = t;
    }
  }
  return best;
};

const factionScore = (
  state: GameState,
  faction: Faction,
  weights: EvalWeights,
): number => {
  const ours = state.units.filter(
    (u) => u.faction === faction && isUnitAlive(u),
  );
  const theirs = state.units.filter(
    (u) => u.faction === oppositeFaction(faction) && isUnitAlive(u),
  );
  let total = 0;
  for (const u of ours) total += unitScore(u, state, weights, theirs);

  // Asymmetric LOS: we see them, they don't see us → free shot opportunities.
  for (const o of ours) {
    for (const t of theirs) {
      const oSeesT = hasLOS(
        { center: o.position, radius: o.radius },
        { center: t.position, radius: t.radius },
        state.terrain,
        { aProne: o.stance === 'PRONE', bProne: t.stance === 'PRONE' },
      );
      const tSeesO = hasLOS(
        { center: t.position, radius: t.radius },
        { center: o.position, radius: o.radius },
        state.terrain,
        { aProne: t.stance === 'PRONE', bProne: o.stance === 'PRONE' },
      );
      if (oSeesT && !tSeesO) total += weights.oneSidedLosBonus;
    }
  }

  total += state.initiative.momentum[faction] * weights.momentumValue;
  if (state.initiative.holder === faction) {
    total += weights.initiativeHolderBonus;
  }
  return total;
};

/**
 * Score state from `faction`'s perspective. Positive = good for `faction`.
 * Symmetric: `evaluateState(s, A) === -evaluateState(s, B)` whenever both
 * sides have mirrored momentum/initiative — useful invariant for testing
 * weight changes.
 */
export const evaluateState = (
  state: GameState,
  faction: Faction,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): number => {
  const own = factionScore(state, faction, weights);
  const opp = factionScore(state, oppositeFaction(faction), weights);
  return own - opp;
};
