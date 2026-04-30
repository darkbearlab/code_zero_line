import { describe, it, expect } from 'vitest';
import { newCampaignState } from '../campaign/state';
import { newRoundState } from './state';

describe('newRoundState', () => {
  it('produces 3 mission options with 4-unit squads', () => {
    const c = newCampaignState('seed-1');
    const round = newRoundState(c);
    expect(round.options).toHaveLength(3);
    for (const opt of round.options) {
      expect(opt.missionId).toBeTruthy();
      expect(opt.squadIds).toHaveLength(4);
    }
  });

  it('is deterministic per (campaign seed, round index)', () => {
    const c1 = newCampaignState('seed-A');
    const c2 = newCampaignState('seed-A');
    const r1 = newRoundState(c1);
    const r2 = newRoundState(c2);
    expect(r1.options.map((o) => o.missionId)).toEqual(
      r2.options.map((o) => o.missionId),
    );
    expect(r1.options.map((o) => o.squadIds)).toEqual(
      r2.options.map((o) => o.squadIds),
    );
  });

  it('different round indices yield different rolls', () => {
    const c = newCampaignState('seed-A');
    const r1 = newRoundState(c);
    const r2 = newRoundState({ ...c, roundIndex: 5 });
    // Almost surely the mission selection or squads differ — variety bias
    // + fresh draft RNG. Allow rare collision with a soft check.
    const same =
      r1.options.map((o) => o.missionId).join(',') ===
      r2.options.map((o) => o.missionId).join(',');
    if (same) {
      const squadsSame =
        JSON.stringify(r1.options.map((o) => o.squadIds)) ===
        JSON.stringify(r2.options.map((o) => o.squadIds));
      expect(squadsSame).toBe(false);
    } else {
      expect(same).toBe(false);
    }
  });

  it('drafted squad members come from the campaign pool', () => {
    const c = newCampaignState('seed-A');
    const poolIds = new Set(c.pool.map((u) => u.id));
    const round = newRoundState(c);
    for (const opt of round.options) {
      for (const id of opt.squadIds) {
        expect(poolIds.has(id)).toBe(true);
      }
    }
  });
});
