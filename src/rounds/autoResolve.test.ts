import { describe, it, expect } from 'vitest';
import {
  resolveUnpickedOptions,
  UNPICKED_MISSION_SUCCESS_RATE,
  UNPICKED_SURVIVAL_RATE,
} from './autoResolve';
import type { RoundMissionOption } from './state';

const opt = (
  missionId: string,
  squadIds: string[],
): RoundMissionOption => ({ missionId, squadIds, fuzzy: 'medium' });

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
    const options = [opt('m1', ['a', 'b', 'c', 'd']), opt('m2', ['e', 'f', 'g', 'h'])];
    const a = resolveUnpickedOptions(options, 0, 'seed-x');
    const b = resolveUnpickedOptions(options, 0, 'seed-x');
    expect(a).toEqual(b);
  });

  it('survival roll keeps roughly the configured rate over many seeds', () => {
    // Sanity check: per-member survival ≈ UNPICKED_SURVIVAL_RATE (70%)
    // across 200 members. Wide tolerance — this is a smoke test for
    // "the rate is in the right ballpark", not a tight statistical claim.
    const squad = Array.from({ length: 200 }, (_, i) => `m${i}`);
    const options = [opt('picked', ['p']), opt('unpicked', squad)];
    const out = resolveUnpickedOptions(options, 0, 'big-seed');
    const survivors = out[0]!.survivorIds.length;
    const rate = survivors / squad.length;
    expect(rate).toBeGreaterThan(UNPICKED_SURVIVAL_RATE - 0.1);
    expect(rate).toBeLessThan(UNPICKED_SURVIVAL_RATE + 0.1);
  });

  it('mission-win roll keeps roughly the configured rate over many seeds', () => {
    let wins = 0;
    const tries = 200;
    for (let i = 0; i < tries; i++) {
      const options = [opt('picked', ['p']), opt('unpicked', ['x'])];
      const out = resolveUnpickedOptions(options, 0, `seed-${i}`);
      if (out[0]!.won) wins += 1;
    }
    const rate = wins / tries;
    expect(rate).toBeGreaterThan(UNPICKED_MISSION_SUCCESS_RATE - 0.1);
    expect(rate).toBeLessThan(UNPICKED_MISSION_SUCCESS_RATE + 0.1);
  });

  it('returns empty when there is only one option (the picked one)', () => {
    const out = resolveUnpickedOptions([opt('only', ['a'])], 0, 'seed');
    expect(out).toEqual([]);
  });
});
