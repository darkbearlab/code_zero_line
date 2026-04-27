import type { DamageState } from '../state/GameState';

const ORDER: Readonly<Record<DamageState, number>> = {
  NONE: 0,
  IMPEDED: 1,
  SUPPRESSED: 2,
  KILLED: 3,
};

const STATE_BY_LEVEL: ReadonlyArray<DamageState> = [
  'NONE',
  'IMPEDED',
  'SUPPRESSED',
  'KILLED',
];

/**
 * Cumulative hit ladder per rule 4.3:
 *   NONE + 1 hit → IMPEDED
 *   IMPEDED + 1 hit → SUPPRESSED
 *   SUPPRESSED + 1 hit → KILLED
 *   (and bigger hit counts skip ahead, e.g. NONE + 3 hits → KILLED)
 */
export const applyHits = (before: DamageState, newHits: number): DamageState => {
  if (newHits <= 0) return before;
  const level = Math.min(ORDER[before] + newHits, ORDER.KILLED);
  return STATE_BY_LEVEL[level]!;
};

export const isMoreSevereThan = (a: DamageState, b: DamageState): boolean =>
  ORDER[a] > ORDER[b];

export const damageLevel = (d: DamageState): number => ORDER[d];
