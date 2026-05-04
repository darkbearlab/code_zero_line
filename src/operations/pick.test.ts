/**
 * pickOperations + instantiateOperation tests. Uses synthetic mission +
 * operation pools so the test stays decoupled from bundled JSON content
 * (those are validated separately in `registry.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { v2 } from '../core/geometry/vec2';
import { newCampaignState } from '../campaign/state';
import {
  difficultyCapForRound,
  instantiateOperation,
  pickOperationDefs,
  pickOperations,
} from './pick';
import type { OperationDef } from './types';
import type { MissionDef } from '../missions/types';
import type { ScenarioMode } from '../core/scenario/victory';

const m = (
  id: string,
  difficulty: 1 | 2 | 3 | 4 | 5,
  scenario: ScenarioMode = 'engage-reach',
): MissionDef => ({
  id,
  displayName: id,
  description: '',
  difficulty,
  mapId: 'demo',
  scenario,
  enemyFaction: 'B',
  enemies: [{ id: `${id}-e`, templateId: 'conscript', position: v2(0, 0) }],
  playerSpawnPositions: [v2(0, 0)],
});

const op = (
  id: string,
  difficulty: 1 | 2 | 3 | 4 | 5,
  chain: OperationDef['chain'],
): OperationDef => ({
  id,
  displayName: id,
  description: '',
  difficulty,
  chain,
  rewards: {
    perStage: { tactical: 1, regional: 0, honor: 0 },
    onComplete: { tactical: 1, regional: 1, honor: 1 },
  },
});

const missionPool = [
  m('e-easy-1', 1),
  m('e-easy-2', 1),
  m('e-mid-1', 3),
  m('e-mid-2', 3),
  m('e-hard-1', 5),
  m('main-defend', 4, 'defend'),
  m('main-extract', 3, 'extract'),
  m('main-vip', 4, 'assassinate'),
];

describe('difficultyCapForRound', () => {
  it('round 1 caps at 1, round 3 at 2, round 5 at 3 …', () => {
    expect(difficultyCapForRound(1)).toBe(1);
    expect(difficultyCapForRound(2)).toBe(1);
    expect(difficultyCapForRound(3)).toBe(2);
    expect(difficultyCapForRound(5)).toBe(3);
    expect(difficultyCapForRound(7)).toBe(4);
    expect(difficultyCapForRound(9)).toBe(5);
    expect(difficultyCapForRound(99)).toBe(5);
  });
});

describe('pickOperationDefs', () => {
  const opPool = [
    op('o-easy', 1, {
      eliminations: 1,
      elimDifficultyBand: [1, 2],
      mainConstraints: { modes: ['engage-reach'] },
    }),
    op('o-mid', 3, {
      eliminations: 2,
      elimDifficultyBand: [2, 4],
      mainConstraints: { modes: ['extract'] },
    }),
    op('o-hard', 5, {
      eliminations: 3,
      elimDifficultyBand: [3, 5],
      mainMissionId: 'main-defend',
    }),
  ];

  it('round 1 prefers difficulty-1 operations (gated first)', () => {
    // n=1 → only the gated pick should appear (no top-up needed).
    const c = { ...newCampaignState('s'), roundIndex: 1 };
    const out = pickOperationDefs('seed', c, 1, opPool);
    expect(out).toHaveLength(1);
    expect(out[0]!.difficulty).toBe(1);
  });

  it('tops up from over-cap when gated pool is too small to fill n', () => {
    // round 1 cap = 1, only one difficulty-1 op; n=3 → fills the rest from
    // higher-difficulty ops rather than returning a half-empty round.
    const c = { ...newCampaignState('s'), roundIndex: 1 };
    const out = pickOperationDefs('seed', c, 3, opPool);
    expect(out).toHaveLength(3);
    // The single gated (d=1) op must be in the picks.
    expect(out.some((o) => o.difficulty === 1)).toBe(true);
  });

  it('falls back to full pool when gating leaves nothing', () => {
    // No difficulty-1 op exists in this constrained pool.
    const onlyHard = [opPool[2]!];
    const c = { ...newCampaignState('s'), roundIndex: 1 };
    const out = pickOperationDefs('seed', c, 3, onlyHard);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('o-hard');
  });

  it('is deterministic per seed', () => {
    const c = { ...newCampaignState('s'), roundIndex: 9 };
    const a = pickOperationDefs('seed-X', c, 3, opPool);
    const b = pickOperationDefs('seed-X', c, 3, opPool);
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id));
  });

  it('returns at most n picks', () => {
    const c = { ...newCampaignState('s'), roundIndex: 9 };
    expect(pickOperationDefs('s', c, 2, opPool)).toHaveLength(2);
    expect(pickOperationDefs('s', c, 5, opPool)).toHaveLength(opPool.length);
  });
});

describe('instantiateOperation', () => {
  it('binds elims within the band + a pinned main mission', () => {
    const def = op('o', 5, {
      eliminations: 2,
      elimDifficultyBand: [1, 1],
      elimModeFilter: ['engage-reach'],
      mainMissionId: 'main-defend',
    });
    const inst = instantiateOperation(def, 'seed', missionPool);
    expect(inst).not.toBeNull();
    expect(inst!.missionIds).toHaveLength(3);
    expect(inst!.stageLabels).toEqual(['ELIM', 'ELIM', 'MAIN']);
    expect(inst!.missionIds[2]).toBe('main-defend');
    // Both elims should respect the band.
    for (let i = 0; i < 2; i++) {
      const mid = inst!.missionIds[i]!;
      const md = missionPool.find((x) => x.id === mid)!;
      expect(md.difficulty).toBe(1);
    }
  });

  it('uses mainConstraints when no mainMissionId is pinned', () => {
    const def = op('o', 4, {
      eliminations: 1,
      elimDifficultyBand: [1, 5],
      mainConstraints: { modes: ['extract', 'assassinate'] },
    });
    const inst = instantiateOperation(def, 'seed', missionPool);
    expect(inst).not.toBeNull();
    const main = missionPool.find(
      (x) => x.id === inst!.missionIds[inst!.missionIds.length - 1],
    )!;
    expect(['extract', 'assassinate']).toContain(main.scenario);
  });

  it('returns null when the pinned main mission is missing from the pool', () => {
    const def = op('o', 1, {
      eliminations: 1,
      elimDifficultyBand: [1, 5],
      mainMissionId: 'does-not-exist',
    });
    const inst = instantiateOperation(def, 'seed', missionPool);
    expect(inst).toBeNull();
  });

  it('forwards rewards + difficulty from the def', () => {
    const def = op('o', 3, {
      eliminations: 1,
      elimDifficultyBand: [1, 5],
      mainMissionId: 'main-extract',
    });
    const inst = instantiateOperation(def, 'seed', missionPool)!;
    expect(inst.difficulty).toBe(3);
    expect(inst.rewards.perStage.tactical).toBe(1);
    expect(inst.rewards.onComplete.honor).toBe(1);
  });

  it('is deterministic per (def.id, seed)', () => {
    const def = op('o', 5, {
      eliminations: 2,
      elimDifficultyBand: [1, 5],
      mainMissionId: 'main-defend',
    });
    const a = instantiateOperation(def, 'shared-seed', missionPool)!;
    const b = instantiateOperation(def, 'shared-seed', missionPool)!;
    expect(a.missionIds).toEqual(b.missionIds);
  });
});

describe('pickOperations (top-level)', () => {
  const opPool = [
    op('o-1', 1, {
      eliminations: 1,
      elimDifficultyBand: [1, 1],
      mainMissionId: 'main-extract',
    }),
    op('o-2', 1, {
      eliminations: 2,
      elimDifficultyBand: [1, 3],
      mainConstraints: { modes: ['engage-reach'] },
    }),
  ];

  it('returns instances each with chain.eliminations + 1 missions', () => {
    const c = { ...newCampaignState('s'), roundIndex: 9 };
    const out = pickOperations('seed', c, 3, opPool, missionPool);
    expect(out.length).toBeGreaterThan(0);
    for (const inst of out) {
      const def = opPool.find((d) => d.id === inst.operationId)!;
      expect(inst.missionIds).toHaveLength(def.chain.eliminations + 1);
      expect(inst.stageLabels[inst.stageLabels.length - 1]).toBe('MAIN');
    }
  });

  it('produces the same result for the same seed (full reproducibility)', () => {
    const c = { ...newCampaignState('s'), roundIndex: 9 };
    const a = pickOperations('seed-RR', c, 3, opPool, missionPool);
    const b = pickOperations('seed-RR', c, 3, opPool, missionPool);
    expect(a).toEqual(b);
  });
});
