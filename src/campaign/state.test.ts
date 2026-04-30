import { describe, it, expect } from 'vitest';
import {
  advanceCampaignAfterRun,
  isCampaignOver,
  newCampaignState,
  type RunResolution,
} from './state';

describe('CampaignState', () => {
  it('newCampaignState seeds a 12-unit pool + zero currencies', () => {
    const c = newCampaignState('seed-1');
    expect(c.version).toBe(1);
    expect(c.roundIndex).toBe(1);
    expect(c.pool).toHaveLength(12);
    expect(c.currencies).toEqual({ tactical: 0, regional: 0, honor: 0 });
    expect(c.runsCompleted).toBe(0);
  });

  it('isCampaignOver triggers when pool drops below 4', () => {
    const c = newCampaignState('seed-1');
    expect(isCampaignOver(c)).toBe(false);
    expect(isCampaignOver({ ...c, pool: c.pool.slice(0, 4) })).toBe(false);
    expect(isCampaignOver({ ...c, pool: c.pool.slice(0, 3) })).toBe(true);
  });
});

describe('advanceCampaignAfterRun', () => {
  const baseCampaign = newCampaignState('seed-1');
  const drafted = baseCampaign.pool.slice(0, 4).map((u) => u.id);

  it('victory: survivors stay, casualties leave, currencies awarded', () => {
    const result: RunResolution = {
      missionId: 'reconnaissance',
      squadIds: drafted,
      survivorIds: drafted.slice(0, 3), // one KIA
      winner: 'A',
    };
    const after = advanceCampaignAfterRun(baseCampaign, result);
    expect(after.roundIndex).toBe(2);
    expect(after.runsCompleted).toBe(1);
    expect(after.pool).toHaveLength(11);
    expect(after.pool.find((u) => u.id === drafted[3])).toBeUndefined();
    expect(after.pool.find((u) => u.id === drafted[0])).toBeDefined();
    expect(after.currencies.tactical).toBeGreaterThan(0);
    expect(after.currencies.regional).toBeGreaterThan(0);
    expect(after.currencies.honor).toBe(1);
  });

  it('defeat: all drafted are casualties, no currency', () => {
    const result: RunResolution = {
      missionId: 'reconnaissance',
      squadIds: drafted,
      survivorIds: [],
      winner: 'B',
    };
    const after = advanceCampaignAfterRun(baseCampaign, result);
    expect(after.pool).toHaveLength(8);
    expect(after.currencies.tactical).toBe(0);
    expect(after.currencies.regional).toBe(0);
    expect(after.currencies.honor).toBe(0);
  });

  it('non-drafted units are untouched even on defeat', () => {
    const result: RunResolution = {
      missionId: 'reconnaissance',
      squadIds: drafted,
      survivorIds: [],
      winner: 'B',
    };
    const after = advanceCampaignAfterRun(baseCampaign, result);
    const untouchedId = baseCampaign.pool[5]!.id;
    expect(after.pool.find((u) => u.id === untouchedId)).toBeDefined();
  });
});
