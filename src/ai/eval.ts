import { hasLOS } from '../core/geometry/los';
import { isPointInPolygon } from '../core/geometry/polygon';
import { targetHasCover } from '../core/resolution/cover';
import { UNIT_DISTANCE_PIXELS } from '../core/rules/constants';
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
  /** Per-unit bonus for standing on a scenario objective (engage-reach). */
  readonly objectiveControlBonus: number;
  /**
   * Bonus per remaining action in the active activation (under SPEND with a
   * positive `actionsRemaining`). Rewards plans that consolidate work into
   * fewer actions — e.g. a COMMAND_MOVE moving four units at once vs four
   * solo MOVEs. Without this term, lookahead's depth-2 search ranks both
   * branches similarly because final positions look alike.
   */
  readonly unspentActionValue: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  unitAliveBase: 100,
  qualityBonus: { 1: 40, 2: 20, 3: 10, 4: 0 },
  damagePenalty: { NONE: 0, IMPEDED: 25, SUPPRESSED: 60, KILLED: 100 },
  inCoverBonus: 12,
  oneSidedLosBonus: 8,
  momentumValue: 4,
  initiativeHolderBonus: 6,
  objectiveControlBonus: 35,
  unspentActionValue: 8,
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

/**
 * Per-ally bonus for an OFFICER having that ally within 1 unit-distance —
 * captures the COMMAND_MOVE / COMMAND_RALLY / Combined-Fire / Rally-aura
 * upside of staying in formation. Pulls lookahead's beam search toward
 * positions where the officer can light up the whole subsystem.
 */
const OFFICER_ALLY_AURA_BONUS = 6;

const officerAllyAura: TraitEvalHook = (unit, state) => {
  const range = UNIT_DISTANCE_PIXELS + 0.5;
  let allies = 0;
  for (const u of state.units) {
    if (u.id === unit.id) continue;
    if (u.faction !== unit.faction) continue;
    if (!isUnitAlive(u)) continue;
    const dx = u.position.x - unit.position.x;
    const dy = u.position.y - unit.position.y;
    if (Math.hypot(dx, dy) <= range) allies += 1;
  }
  return allies * OFFICER_ALLY_AURA_BONUS;
};

/**
 * TOUGH save is worth ~half a unit's life (it converts a kill into a
 * suppression — the unit lives but is much less effective). Once the save
 * burns, the bonus disappears.
 */
const toughSaveValue: TraitEvalHook = (unit) =>
  unit.toughUsed ? 0 : 35;

/**
 * STEALTH is situational — only valuable when standing inside cover-
 * providing terrain, where a future MOVE within that polygon is reaction-
 * immune. Modest constant bonus when the unit can actually use it; zero
 * otherwise. Faster than re-running terrain-containment checks during
 * search, and biases lookahead to keep stealth units in smoke / rubble.
 */
const stealthInCoverBonus: TraitEvalHook = (unit, state) => {
  for (const t of state.terrain) {
    if (t.kind !== 'DIFFICULT' && t.kind !== 'SOFT') continue;
    if (isPointInPolygon(unit.position, t.polygon)) return 18;
  }
  return 0;
};

export const traitEvalHooks: Record<string, TraitEvalHook> = {
  OFFICER: officerAllyAura,
  TOUGH: toughSaveValue,
  STEALTH: stealthInCoverBonus,
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

  // Scenario objective: each of our units inside an objective circle
  // earns objectiveControlBonus. Units outside contribute nothing — the
  // evaluator naturally pulls the AI toward the objective when this
  // weight is non-zero and the map has objectives.
  const objectives = state.objectives ?? [];
  if (objectives.length > 0 && weights.objectiveControlBonus !== 0) {
    for (const u of ours) {
      for (const obj of objectives) {
        const dx = u.position.x - obj.position.x;
        const dy = u.position.y - obj.position.y;
        if (dx * dx + dy * dy <= obj.radius * obj.radius) {
          total += weights.objectiveControlBonus;
          break;
        }
      }
    }
  }

  total += state.initiative.momentum[faction] * weights.momentumValue;
  if (state.initiative.holder === faction) {
    total += weights.initiativeHolderBonus;
    // Unspent actions in the live activation are saved-up tempo — reward
    // states where we still have actions left to spend on this unit.
    const act = state.initiative.activeActivation;
    if (act && act.actionsRemaining > 0) {
      total += act.actionsRemaining * weights.unspentActionValue;
    }
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
