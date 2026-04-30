import { describe, it, expect } from 'vitest';
import { resolveUnpickedOptions } from './autoResolve';
import { fuzzyToRates } from './fuzzy';
import type { RoundMissionOption, FuzzyDifficulty } from './state';

const opt = (
  missionId: string,
  squadIds: string[],
  fuzzy: FuzzyDifficulty = 'medium',
): RoundMissionOption => ({ missionId, squadIds, fuzzy });

describe('resolveUnpickedOptions', () => {
  it('skips the picked option', () => {
    const options = [opt('m1', ['a']), opt('m2', ['b']), opt('m3', ['c'])];
    const out = resolveUnpickedOptions(options, 1, 'seed');
    expect(out.map((o) => o.missionId)).toEqual(['m1', 'm3']);
  });

  it('returns one outcome per unpicked option, preserving its squadIds', () => {
    const options = [opt('m1', ['a', 'b']), opt('m2', ['c', 'd'])];
    const out = resolveUnpickedOptions(options, 0, 'seed');
    expect(out).toHaveLength(1);
    expect(out[0]!.squadIds).toEqual(['c', 'd']);
  });

  it('is deterministic for the same seed', () => {
    const options = [
      opt('m1', ['a', 'b', 'c', 'd']),
      opt('m2', ['e', 'f', 'g', 'h']),
    ];
    const a = resolveUnpickedOptions(options, 0, 'seed-x');
    const b = resolveUnpickedOptions(options, 0, 'seed-x');
    expect(a).toEqual(b);
  });

  it('medium-fuzzy survival roll lands near 70% over many seeds', () => {
    const expected = fuzzyToRates('medium').survivalRate;
    const squad = Array.from({ length: 200 }, (_, i) => `m${i}`);
    const options = [opt('picked', ['p']), opt('unpicked', squad, 'medium')];
    const out = resolveUnpickedOptions(options, 0, 'big-seed');
    const rate = out[0]!.survivorIds.length / squad.length;
    expect(rate).toBeGreaterThan(expected - 0.1);
    expect(rate).toBeLessThan(expected + 0.1);
  });

  it('high-fuzzy clearly punishes survival vs medium', () => {
    // Same squad, same seed batch — only the fuzzy band changes. High risk
    // should produce noticeably fewer survivors than medium.
    const squad = Array.from({ length: 400 }, (_, i) => `m${i}`);
    const med = resolveUnpickedOptions(
      [opt('p', ['p']), opt('u', squad, 'medium')],
      0,
      'fuzzy-seed',
    )[0]!.survivorIds.length;
    const hi = resolveUnpickedOptions(
      [opt('p', ['p']), opt('u', squad, 'high')],
      0,
      'fuzzy-seed',
    )[0]!.survivorIds.length;
    expect(hi).toBeLessThan(med);
    // Also: high band's empirical survival is in the right ballpark.
    const expected = fuzzyToRates('high').survivalRate;
    const rate = hi / squad.length;
    expect(rate).toBeGreaterThan(expected - 0.1);
    expect(rate).toBeLessThan(expected + 0.1);
  });

  it('low-fuzzy clearly favors survival vs medium', () => {
    const squad = Array.from({ length: 400 }, (_, i) => `m${i}`);
    const med = resolveUnpickedOptions(
      [opt('p', ['p']), opt('u', squad, 'medium')],
      0,
      'fuzzy-seed-2',
    )[0]!.survivorIds.length;
    const low = resolveUnpickedOptions(
      [opt('p', ['p']), opt('u', squad, 'low')],
      0,
      'fuzzy-seed-2',
    )[0]!.survivorIds.length;
    expect(low).toBeGreaterThan(med);
  });

  it('mission-win roll near medium rate over many seeds', () => {
    const expected = fuzzyToRates('medium').successRate;
    let wins = 0;
    const tries = 200;
    for (let i = 0; i < tries; i++) {
      const options = [opt('picked', ['p']), opt('unpicked', ['x'], 'medium')];
      const out = resolveUnpickedOptions(options, 0, `seed-${i}`);
      if (out[0]!.won) wins += 1;
    }
    const rate = wins / tries;
    expect(rate).toBeGreaterThan(expected - 0.1);
    expect(rate).toBeLessThan(expected + 0.1);
  });

  it('returns empty when there is only one option (the picked one)', () => {
    const out = resolveUnpickedOptions([opt('only', ['a'])], 0, 'seed');
    expect(out).toEqual([]);
  });
});
