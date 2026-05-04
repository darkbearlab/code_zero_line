/**
 * Fuzzy difficulty heuristic — turns (mission × drafted squad) into a
 * coarse risk band displayed on RoundSetup cards and used by
 * autoResolve to roll unpicked outcomes.
 *
 * The heuristic is deliberately simple for v1: sum a "strength score"
 * over both sides (lower quality numbers = stronger units, since
 * quality is a hit-threshold), take the ratio. Squad strength leaning
 * heavy = low risk; enemy strength leaning heavy = high risk.
 *
 * `fuzzyToRates` is the single source of truth for what each band
 * means at the dice — autoResolve and any future "shown success %" UI
 * should both call it.
 */
import type { FuzzyDifficulty, RoundOperationOption } from './state';
import type { MissionDef } from '../missions/types';
import type { RosterEntry } from '../core/setup/types';
import { getUnitTemplate } from '../config/loader';

export interface FuzzyRates {
  /** Probability the unpicked mission's auto-roll counts as a win. */
  readonly successRate: number;
  /** Per-squad-member survival probability. */
  readonly survivalRate: number;
}

const RATES: Readonly<Record<FuzzyDifficulty, FuzzyRates>> = {
  low: { successRate: 0.85, survivalRate: 0.85 },
  medium: { successRate: 0.7, survivalRate: 0.7 },
  high: { successRate: 0.5, survivalRate: 0.55 },
};

export const fuzzyToRates = (f: FuzzyDifficulty): FuzzyRates => RATES[f];

/** Lower quality number = stronger unit; map quality → positive strength. */
const strengthFromQuality = (quality: number): number =>
  Math.max(0, 7 - quality);

const sumSquadStrength = (
  squadIds: ReadonlyArray<string>,
  pool: ReadonlyArray<RosterEntry>,
): number => {
  let sum = 0;
  for (const id of squadIds) {
    const member = pool.find((u) => u.id === id);
    if (!member) continue;
    try {
      sum += strengthFromQuality(getUnitTemplate(member.templateId).quality);
    } catch {
      // template removed mid-campaign; treat as zero rather than crashing
    }
  }
  return sum;
};

const sumEnemyStrength = (mission: MissionDef): number => {
  let sum = 0;
  for (const e of mission.enemies) {
    try {
      sum += strengthFromQuality(getUnitTemplate(e.templateId).quality);
    } catch {
      // unknown enemy template — count nothing rather than crash
    }
  }
  return sum;
};

/**
 * Classify a (mission × drafted squad) pair into a fuzzy risk band.
 * Pure function — no RNG, no state mutation. Decisions:
 *  - ratio ≥ 1.3 → low risk (squad clearly stronger)
 *  - 0.85 ≤ ratio < 1.3 → medium
 *  - ratio < 0.85 → high (enemy clearly stronger)
 *
 * Edge case: zero enemies (shouldn't happen in real data, but be safe)
 * → 'low'. Zero squad strength → 'high'.
 */
export const classifyFuzzy = (
  mission: MissionDef,
  squadIds: ReadonlyArray<string>,
  pool: ReadonlyArray<RosterEntry>,
): FuzzyDifficulty => {
  const squad = sumSquadStrength(squadIds, pool);
  const enemy = sumEnemyStrength(mission);
  if (enemy === 0) return 'low';
  if (squad === 0) return 'high';
  const ratio = squad / enemy;
  if (ratio >= 1.3) return 'low';
  if (ratio >= 0.85) return 'medium';
  return 'high';
};

/** Helper for callers (e.g. autoResolve) that hold a RoundOperationOption. */
export const fuzzyOf = (option: RoundOperationOption): FuzzyDifficulty =>
  option.fuzzy;
