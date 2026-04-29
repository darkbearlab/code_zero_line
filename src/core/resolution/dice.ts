/**
 * Dice profile engine — heterogeneous-threshold dice pool resolution.
 *
 * The original rules engine treated every attack as a single (count,
 * threshold) pair. The roguelite combat-intel meta requires per-die
 * threshold reductions ("level 5 against INFANTRY" lowers some dice's
 * threshold; cover removes the most-reduced die first). This module
 * generalises the rolling pipeline so all attacks — shoot, melee,
 * reaction — go through the same shape:
 *
 *   build → optional cover removal → roll
 *
 * For a level-0 (no meta upgrade) attack, the resulting profile has
 * exactly one group, behaving identically to the legacy code. The
 * refactor is therefore behaviour-preserving when nothing has been
 * unlocked yet.
 *
 * Threshold floor: any reduction is clamped at 2+ — a roll of 1 always
 * misses. Decided 2026-04-29 in roguelite design discussion.
 *
 * RNG ordering: groups are rolled in array order, and `buildDiceProfile`
 * produces a deterministic group order (extra/low-threshold first, then
 * remainder/high-threshold). `applyCoverToProfile` returns a new sorted
 * array where the lowest-threshold group precedes; subsequent rolls
 * therefore consume RNG in a stable sequence regardless of cover state,
 * preserving replay determinism.
 */
export const THRESHOLD_FLOOR = 2;

export interface DiceGroup {
  readonly count: number;
  readonly threshold: number;
}

export interface DiceProfile {
  readonly groups: ReadonlyArray<DiceGroup>;
}

/** Construct a single-group profile (the level-0 / legacy case). */
export const singleGroupProfile = (
  count: number,
  threshold: number,
): DiceProfile => {
  if (count <= 0) return { groups: [] };
  return {
    groups: [{ count, threshold: Math.max(THRESHOLD_FLOOR, threshold) }],
  };
};

/**
 * Distribute `reductionLevel` total threshold-reductions across `baseCount`
 * dice. Reductions fill all dice by 1 first (level == count → all -1),
 * then refill by 1 (level == 2*count → all -2), and so on. Within a
 * partial level, the "extra" dice get one more reduction than the rest.
 *
 *   buildDiceProfile(4, 5, 7) → 1 die at 3+, 3 dice at 4+
 *
 * This is the formula:
 *   baseReduction = floor(L / N)
 *   extra         = L mod N
 *   → (extra) dice at (T - baseReduction - 1)
 *   → (N - extra) dice at (T - baseReduction)
 *
 * Result thresholds clamp at THRESHOLD_FLOOR (no auto-hit dice).
 */
export const buildDiceProfile = (
  baseCount: number,
  baseThreshold: number,
  reductionLevel: number = 0,
): DiceProfile => {
  if (baseCount <= 0) return { groups: [] };
  if (reductionLevel <= 0) return singleGroupProfile(baseCount, baseThreshold);
  const baseReduction = Math.floor(reductionLevel / baseCount);
  const extra = reductionLevel % baseCount;
  const lowT = Math.max(THRESHOLD_FLOOR, baseThreshold - baseReduction - 1);
  const highT = Math.max(THRESHOLD_FLOOR, baseThreshold - baseReduction);
  const groups: DiceGroup[] = [];
  if (extra > 0) groups.push({ count: extra, threshold: lowT });
  if (extra < baseCount) groups.push({ count: baseCount - extra, threshold: highT });
  return { groups };
};

/**
 * Cover removes one die. Per design rule the removed die must come from
 * the group with the LOWEST threshold (i.e. the most-reduced, "best"
 * die). Mathematically equivalent to "the bullet with the best aim is
 * the one cover deflects".
 *
 * The returned profile is normalized: groups with count=0 are dropped,
 * remaining groups stay sorted ascending by threshold so consumers can
 * iterate in worst-to-best or best-to-worst by reading from either end.
 */
export const applyCoverToProfile = (profile: DiceProfile): DiceProfile => {
  if (profile.groups.length === 0) return profile;
  const sorted = [...profile.groups].sort((a, b) => a.threshold - b.threshold);
  const first = sorted[0]!;
  if (first.count > 1) {
    sorted[0] = { count: first.count - 1, threshold: first.threshold };
  } else {
    sorted.shift();
  }
  return { groups: sorted };
};

/** Total dice across all groups. Used for the "diceCount" event field. */
export const profileTotalDice = (profile: DiceProfile): number => {
  let n = 0;
  for (const g of profile.groups) n += g.count;
  return n;
};

/**
 * Expected hits = sum over groups of (count × P(roll ≥ threshold)).
 * Used by greedy's shot ranking and reaction.ts's EV gate.
 */
export const profileExpectedHits = (profile: DiceProfile): number => {
  let ev = 0;
  for (const g of profile.groups) {
    const p = Math.max(0, Math.min(6, 7 - g.threshold)) / 6;
    ev += g.count * p;
  }
  return ev;
};

/** Minimum-of-thresholds across the profile — the "best aim" die's bar. */
export const profileBestThreshold = (profile: DiceProfile): number => {
  let best = Infinity;
  for (const g of profile.groups) {
    if (g.threshold < best) best = g.threshold;
  }
  return Number.isFinite(best) ? best : 0;
};

export interface RollResult {
  /** Flat array of all dice rolled, in group order. */
  readonly rolls: ReadonlyArray<number>;
  /** Per-group dice rolls, parallel to `profile.groups`. */
  readonly groupRolls: ReadonlyArray<ReadonlyArray<number>>;
  /** Total hits — count of dice meeting their group's threshold. */
  readonly hits: number;
}

/** Minimal RNG shape — accepts the project's sfc32 wrapper directly. */
export interface DiceRng {
  rollDice(count: number, sides: number): number[];
}

export const rollProfile = (
  profile: DiceProfile,
  rng: DiceRng,
  sides: number = 6,
): RollResult => {
  const flat: number[] = [];
  const groupRolls: number[][] = [];
  let hits = 0;
  for (const g of profile.groups) {
    const r = rng.rollDice(g.count, sides);
    groupRolls.push(r);
    for (const v of r) {
      flat.push(v);
      if (v >= g.threshold) hits += 1;
    }
  }
  return { rolls: flat, groupRolls, hits };
};

/**
 * Render a profile compactly for UI / logs. Empty profile → "0d".
 *
 *   {4, 5+}                      → "4d 5+"
 *   {(1, 3+), (3, 4+)}           → "4d (1@3+, 3@4+)"
 *   {(2, 3+), (2, 4+)}           → "4d (2@3+, 2@4+)"
 *
 * Single-group profiles render as the legacy form so existing UI strings
 * are preserved when meta level is 0.
 */
export const formatProfile = (profile: DiceProfile): string => {
  const total = profileTotalDice(profile);
  if (total === 0) return '0d';
  if (profile.groups.length === 1) {
    const g = profile.groups[0]!;
    return `${g.count}d ${g.threshold}+`;
  }
  // Render lowest-threshold (best dice) first for player-facing readout.
  const sorted = [...profile.groups].sort((a, b) => a.threshold - b.threshold);
  const parts = sorted.map((g) => `${g.count}@${g.threshold}+`);
  return `${total}d (${parts.join(', ')})`;
};
