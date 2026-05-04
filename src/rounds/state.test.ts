import { describe, it, expect } from 'vitest';
import { newCampaignState } from '../campaign/state';
import { newRoundState } from './state';

describe('newRoundState', () => {
  it('produces 3 operation options with 4-unit squads + non-empty mission chains', () => {
    const c = newCampaignState('seed-1');
    const round = newRoundState(c);
    expect(round.options).toHaveLength(3);
    for (const opt of round.options) {
      expect(opt.operation.operationId).toBeTruthy();
      expect(opt.operation.missionIds.length).toBeGreaterThan(0);
      expect(opt.operation.stageLabels.length).toBe(opt.operation.missionIds.length);
      // Last stage of every operation chain is the MAIN mission.
      expect(opt.operation.stageLabels[opt.operation.stageLabels.length - 1]).toBe('MAIN');
      expect(opt.squadIds).toHaveLength(4);
    }
  });

  it('is deterministic per (campaign seed, round index)', () => {
    const c1 = newCampaignState('seed-A');
    const c2 = newCampaignState('seed-A');
    const r1 = newRoundState(c1);
    const r2 = newRoundState(c2);
    expect(r1.options.map((o) => o.operation.operationId)).toEqual(
      r2.options.map((o) => o.operation.operationId),
    );
    expect(r1.options.map((o) => o.operation.missionIds)).toEqual(
      r2.options.map((o) => o.operation.missionIds),
    );
    expect(r1.options.map((o) => o.squadIds)).toEqual(
      r2.options.map((o) => o.squadIds),
    );
  });

  it('different round indices yield different rolls', () => {
    const c = newCampaignState('seed-A');
    const r1 = newRoundState(c);
    const r2 = newRoundState({ ...c, roundIndex: 5 });
    // Almost surely the operation selection or squads differ — variety bias
    // + fresh draft RNG. Allow rare collision with a soft check.
    const same =
      r1.options.map((o) => o.operation.operationId).join(',') ===
      r2.options.map((o) => o.operation.operationId).join(',');
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
