import { describe, it, expect } from 'vitest';
import {
  advanceCampaignAfterRun,
  isCampaignOver,
  newCampaignState,
  type RunResolution,
  type UnpickedOptionOutcome,
} from './state';
import { POOL_TARGET } from './recruit';

describe('CampaignState', () => {
  it('newCampaignState seeds a POOL_TARGET-unit pool + zero currencies', () => {
    const c = newCampaignState('seed-1');
    expect(c.version).toBe(1);
    expect(c.roundIndex).toBe(1);
    expect(c.pool).toHaveLength(POOL_TARGET);
    expect(c.currencies).toEqual({ tactical: 0, regional: 0, honor: 0 });
    expect(c.runsCompleted).toBe(0);
    // nextRecruitId starts past STARTER_POOL (12 entries → 13).
    expect(c.nextRecruitId).toBeGreaterThan(12);
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

  it('victory: survivors stay, casualties leave but pool tops back to target', () => {
    const result: RunResolution = {
      missionId: 'reconnaissance',
      squadIds: drafted,
      survivorIds: drafted.slice(0, 3), // one KIA
      winner: 'A',
    };
    const after = advanceCampaignAfterRun(baseCampaign, result);
    expect(after.roundIndex).toBe(2);
    expect(after.runsCompleted).toBe(1);
    // Replenishment refills the KIA seat back to POOL_TARGET.
    expect(after.pool).toHaveLength(POOL_TARGET);
    expect(after.pool.find((u) => u.id === drafted[3])).toBeUndefined();
    expect(after.pool.find((u) => u.id === drafted[0])).toBeDefined();
    expect(after.currencies.tactical).toBeGreaterThan(0);
    expect(after.currencies.regional).toBeGreaterThan(0);
    expect(after.currencies.honor).toBe(1);
    // nextRecruitId advanced by exactly the number of new recruits.
    expect(after.nextRecruitId).toBe(baseCampaign.nextRecruitId + 1);
  });

  it('defeat: drafted casualties leave, pool tops back to target, no currency', () => {
    const result: RunResolution = {
      missionId: 'reconnaissance',
      squadIds: drafted,
      survivorIds: [],
      winner: 'B',
    };
    const after = advanceCampaignAfterRun(baseCampaign, result);
    expect(after.pool).toHaveLength(POOL_TARGET);
    // The 4 drafted KIAs are gone.
    for (const id of drafted) {
      expect(after.pool.find((u) => u.id === id)).toBeUndefined();
    }
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
    // Pick a non-drafted seed member; replenishment must not evict it.
    const untouchedId = baseCampaign.pool[5]!.id;
    expect(after.pool.find((u) => u.id === untouchedId)).toBeDefined();
  });

  it('unpicked options: KIAs get removed and wins award regional intel', () => {
    const otherSquad = baseCampaign.pool.slice(4, 8).map((u) => u.id);
    const unpicked: UnpickedOptionOutcome[] = [
      {
        missionId: 'auto-1',
        squadIds: otherSquad,
        survivorIds: otherSquad.slice(0, 2), // two KIA
        won: true, // → +30% regional intel share
      },
    ];
    const result: RunResolution = {
      missionId: 'reconnaissance',
      squadIds: drafted,
      survivorIds: drafted, // picked all survived
      winner: 'A',
      unpicked,
    };
    const after = advanceCampaignAfterRun(baseCampaign, result);
    // Two unpicked KIAs gone (drafted all survived).
    expect(after.pool.find((u) => u.id === otherSquad[2])).toBeUndefined();
    expect(after.pool.find((u) => u.id === otherSquad[3])).toBeUndefined();
    // Regional intel = picked-share + unpicked-win-share = 3 + 3 = 6.
    expect(after.currencies.regional).toBe(6);
  });

  it('sorties: survivors of picked + unpicked get +1; KIAs do not', () => {
    const otherSquad = baseCampaign.pool.slice(4, 8).map((u) => u.id);
    const unpicked: UnpickedOptionOutcome[] = [
      {
        missionId: 'auto-1',
        squadIds: otherSquad,
        survivorIds: otherSquad.slice(0, 2), // last two are KIA
        won: false,
      },
    ];
    const result: RunResolution = {
      missionId: 'reconnaissance',
      squadIds: drafted,
      survivorIds: drafted.slice(0, 3), // last picked is KIA
      winner: 'A',
      unpicked,
    };
    const after = advanceCampaignAfterRun(baseCampaign, result);
    // First 3 picked survivors → sorties=1.
    for (let i = 0; i < 3; i++) {
      const e = after.pool.find((u) => u.id === drafted[i])!;
      expect(e.sorties).toBe(1);
    }
    // First 2 unpicked survivors → sorties=1.
    for (let i = 0; i < 2; i++) {
      const e = after.pool.find((u) => u.id === otherSquad[i])!;
      expect(e.sorties).toBe(1);
    }
    // Untouched roster member stays at 0 (default).
    const idle = after.pool.find((u) => u.id === baseCampaign.pool[10]!.id)!;
    expect(idle.sorties ?? 0).toBe(0);
  });

  it('sorties: a second run on the same survivor stacks (1 → 2)', () => {
    const result: RunResolution = {
      missionId: 'reconnaissance',
      squadIds: drafted,
      survivorIds: drafted,
      winner: 'A',
    };
    const afterOne = advanceCampaignAfterRun(baseCampaign, result);
    const afterTwo = advanceCampaignAfterRun(afterOne, result);
    const e = afterTwo.pool.find((u) => u.id === drafted[0])!;
    expect(e.sorties).toBe(2);
  });

  describe('Stage 3 — operation outcome branches', () => {
    it('OPERATION_COMPLETE: banked rewards apply, KIA still processed', () => {
      const result: RunResolution = {
        missionId: 'op-x',
        squadIds: drafted,
        survivorIds: drafted.slice(0, 3), // one KIA from final stage
        winner: 'A',
        outcome: {
          kind: 'OPERATION_COMPLETE',
          banked: { tactical: 12, regional: 4, honor: 2 },
        },
      };
      const after = advanceCampaignAfterRun(baseCampaign, result);
      // Banked replaces the legacy MISSION_BASE formula entirely.
      expect(after.currencies.tactical).toBe(12);
      expect(after.currencies.regional).toBe(4);
      expect(after.currencies.honor).toBe(2);
      // KIA still processed.
      expect(after.pool.find((u) => u.id === drafted[3])).toBeUndefined();
    });

    it('OPERATION_FAILED: partial banked still apply, KIA processed', () => {
      const result: RunResolution = {
        missionId: 'op-x',
        squadIds: drafted,
        survivorIds: [], // wiped
        winner: 'B',
        outcome: {
          kind: 'OPERATION_FAILED',
          banked: { tactical: 2, regional: 0, honor: 0 },
        },
      };
      const after = advanceCampaignAfterRun(baseCampaign, result);
      expect(after.currencies.tactical).toBe(2);
      // All four drafted gone.
      for (const id of drafted) {
        expect(after.pool.find((u) => u.id === id)).toBeUndefined();
      }
    });

    it('RETREATED: banked apply, picked-side KIA SKIPPED (squad safe)', () => {
      const result: RunResolution = {
        missionId: 'op-x',
        squadIds: drafted,
        // After last battle, only 2 came back — but retreat means everyone
        // who's still alive returns to pool. The reducer uses squadIds
        // directly when RETREATED so survivorIds is moot for KIA.
        survivorIds: drafted.slice(0, 2),
        winner: 'DRAW',
        outcome: {
          kind: 'RETREATED',
          banked: { tactical: 5, regional: 1, honor: 0 },
        },
      };
      const after = advanceCampaignAfterRun(baseCampaign, result);
      expect(after.currencies.tactical).toBe(5);
      expect(after.currencies.regional).toBe(1);
      // No KIA: every drafted unit is still in the pool.
      for (const id of drafted) {
        expect(after.pool.find((u) => u.id === id)).toBeDefined();
      }
    });

    it('OPERATION_COMPLETE + unpicked win: regional intel stacks correctly', () => {
      const otherSquad = baseCampaign.pool.slice(4, 8).map((u) => u.id);
      const result: RunResolution = {
        missionId: 'op-x',
        squadIds: drafted,
        survivorIds: drafted,
        winner: 'A',
        outcome: {
          kind: 'OPERATION_COMPLETE',
          banked: { tactical: 7, regional: 5, honor: 1 },
        },
        unpicked: [
          {
            missionId: 'auto-1',
            squadIds: otherSquad,
            survivorIds: otherSquad,
            won: true,
          },
        ],
      };
      const after = advanceCampaignAfterRun(baseCampaign, result);
      // banked.regional (5) + unpicked-win-share (3) = 8.
      expect(after.currencies.regional).toBe(8);
      // banked.tactical alone — unpicked auto-rolls produce no tactical.
      expect(after.currencies.tactical).toBe(7);
    });
  });
});
