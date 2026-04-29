import { describe, expect, it } from 'vitest';
import {
  applyCoverToProfile,
  buildDiceProfile,
  formatProfile,
  profileBestThreshold,
  profileExpectedHits,
  profileTotalDice,
  rollProfile,
  singleGroupProfile,
  THRESHOLD_FLOOR,
  type DiceRng,
} from './dice';

const rngFromArray = (rolls: number[]): DiceRng => {
  let i = 0;
  return {
    rollDice(count: number): number[] {
      const out: number[] = [];
      for (let k = 0; k < count; k++) {
        out.push(rolls[i++ % rolls.length]!);
      }
      return out;
    },
  };
};

describe('buildDiceProfile', () => {
  it('level 0 returns a single-group profile', () => {
    const p = buildDiceProfile(4, 5, 0);
    expect(p.groups.length).toBe(1);
    expect(p.groups[0]).toEqual({ count: 4, threshold: 5 });
  });

  it('level == count: every die drops by 1', () => {
    const p = buildDiceProfile(4, 5, 4);
    expect(p.groups.length).toBe(1);
    expect(p.groups[0]).toEqual({ count: 4, threshold: 4 });
  });

  it('level < count: the "extra" dice get the deeper drop', () => {
    // 4d 5+, level 1 → 1 extra die at 4+, 3 dice at 5+
    const p = buildDiceProfile(4, 5, 1);
    const sorted = [...p.groups].sort((a, b) => a.threshold - b.threshold);
    expect(sorted).toEqual([
      { count: 1, threshold: 4 },
      { count: 3, threshold: 5 },
    ]);
  });

  it("user-spec example: 4d 5+, level 7 → 3d 3+ + 1d 4+", () => {
    // baseReduction = 1, extra = 3 — so 3 dice at 3+, 1 die at 4+.
    const p = buildDiceProfile(4, 5, 7);
    const sorted = [...p.groups].sort((a, b) => a.threshold - b.threshold);
    expect(sorted).toEqual([
      { count: 3, threshold: 3 },
      { count: 1, threshold: 4 },
    ]);
  });

  it('threshold clamps at floor 2 (no auto-hits)', () => {
    // Massive level shouldn't push threshold to 1 or below.
    const p = buildDiceProfile(2, 4, 99);
    for (const g of p.groups) {
      expect(g.threshold).toBeGreaterThanOrEqual(THRESHOLD_FLOOR);
    }
  });

  it('zero base dice → empty profile', () => {
    const p = buildDiceProfile(0, 5, 3);
    expect(p.groups).toEqual([]);
  });
});

describe('applyCoverToProfile', () => {
  it('removes one die from the lowest-threshold group first (count > 1)', () => {
    // 4d 5+ level 7 → 3d 3+ + 1d 4+. Cover removes one 3+ die, leaving
    // 2d 3+ + 1d 4+.
    const before = buildDiceProfile(4, 5, 7);
    expect(before.groups.find((g) => g.threshold === 3)?.count).toBe(3);
    const after = applyCoverToProfile(before);
    expect(profileTotalDice(after)).toBe(profileTotalDice(before) - 1);
    expect(after.groups.find((g) => g.threshold === 3)?.count).toBe(2);
    expect(after.groups.find((g) => g.threshold === 4)?.count).toBe(1);
  });

  it('drops the group entirely when the lowest group has only 1 die', () => {
    // 4d 5+ level 1 → 1d 4+ + 3d 5+. Cover removes the lone 4+ die
    // entirely, leaving just 3d 5+.
    const before = buildDiceProfile(4, 5, 1);
    const after = applyCoverToProfile(before);
    expect(after.groups.find((g) => g.threshold === 4)).toBeUndefined();
    expect(after.groups.find((g) => g.threshold === 5)?.count).toBe(3);
  });

  it('handles single-die profile', () => {
    const before = singleGroupProfile(1, 5);
    const after = applyCoverToProfile(before);
    expect(after.groups).toEqual([]);
  });

  it('no-op when profile is already empty', () => {
    const empty = buildDiceProfile(0, 5, 3);
    expect(applyCoverToProfile(empty).groups).toEqual([]);
  });
});

describe('rolling and EV', () => {
  it('rollProfile counts hits per-group', () => {
    // 4d 5+ level 7 → 3d 3+ + 1d 4+, rolled in group order: [3, 6, 5, 2]
    // group A (3d @ 3+): rolls 3,6,5 → all 3 hit
    // group B (1d @ 4+): roll 2 → miss
    // total = 3
    const profile = buildDiceProfile(4, 5, 7);
    const result = rollProfile(profile, rngFromArray([3, 6, 5, 2]));
    expect(result.hits).toBe(3);
    expect(result.rolls).toEqual([3, 6, 5, 2]);
    expect(result.groupRolls.length).toBe(2);
  });

  it('expectedHits sums per-group correctly', () => {
    // 3d 3+ + 1d 4+ → 3 * 4/6 + 1 * 3/6 = 2.0 + 0.5 = 2.5
    const ev = profileExpectedHits(buildDiceProfile(4, 5, 7));
    expect(ev).toBeCloseTo(2.5, 2);
  });

  it('expectedHits matches legacy single-threshold case', () => {
    // 4d 5+ → 4 * (2/6) = 1.333
    const ev = profileExpectedHits(buildDiceProfile(4, 5, 0));
    expect(ev).toBeCloseTo(1.333, 2);
  });

  it('profileBestThreshold reports the lowest threshold', () => {
    expect(profileBestThreshold(buildDiceProfile(4, 5, 7))).toBe(3);
    expect(profileBestThreshold(buildDiceProfile(4, 5, 0))).toBe(5);
    expect(profileBestThreshold(buildDiceProfile(0, 5, 3))).toBe(0);
  });
});

describe('formatProfile', () => {
  it('single-group renders as legacy form', () => {
    expect(formatProfile(buildDiceProfile(4, 5, 0))).toBe('4d 5+');
  });
  it('multi-group renders compactly with lowest-threshold first', () => {
    // 4d 5+ level 7 → 3d 3+ + 1d 4+
    expect(formatProfile(buildDiceProfile(4, 5, 7))).toBe(
      '4d (3@3+, 1@4+)',
    );
  });
  it('empty profile renders as 0d', () => {
    expect(formatProfile(buildDiceProfile(0, 5, 0))).toBe('0d');
  });
});
