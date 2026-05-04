/**
 * Stage 1 — stealth state plumbing. Pure unit tests for
 * `currentMissionStealthActive` precedence (mission override > chain
 * inheritance) and `newRunState`'s init of `operationStealthAlive` from
 * the operation context.
 */
import { describe, expect, it } from 'vitest';
import {
  currentMissionStealthActive,
  newRunState,
  type RunOperationContext,
} from './state';
import type { MissionDef } from '../missions/types';
import type { RosterEntry } from '../core/setup/types';

const r = (id: string): RosterEntry => ({ id, templateId: 'trooper' });
const squad = [r('s1'), r('s2')];

const baseMission = (overrides?: Partial<MissionDef>): MissionDef => ({
  id: 'm-test',
  displayName: 'Test',
  description: 'Test mission.',
  difficulty: 1,
  mapId: 'map-test',
  scenario: 'elimination',
  enemies: [],
  playerSpawnPositions: [{ x: 0, y: 0 }],
  enemyFaction: 'B',
  ...overrides,
});

const opCtx = (stealthEntry?: boolean): RunOperationContext => ({
  operationId: 'op-test',
  stageLabels: ['ELIM', 'MAIN'],
  perStageReward: { tactical: 1, regional: 0, honor: 0 },
  onCompleteReward: { tactical: 0, regional: 1, honor: 0 },
  ...(stealthEntry === true ? { stealthEntry: true } : {}),
});

describe('newRunState — operationStealthAlive init', () => {
  it('initialises true when operation.stealthEntry === true', () => {
    const run = newRunState('seed', squad, ['m1', 'm2'], opCtx(true));
    expect(run.operationStealthAlive).toBe(true);
  });

  it('omits the field when operation.stealthEntry is false/undefined', () => {
    const run = newRunState('seed', squad, ['m1'], opCtx(false));
    expect(run.operationStealthAlive).toBeUndefined();
  });

  it('omits the field for non-operation runs', () => {
    const run = newRunState('seed', squad, ['m1']);
    expect(run.operationStealthAlive).toBeUndefined();
  });
});

describe('currentMissionStealthActive — precedence', () => {
  it('inherits from operationStealthAlive when mission has no override', () => {
    const run = newRunState('seed', squad, ['m1'], opCtx(true));
    expect(currentMissionStealthActive(run, baseMission())).toBe(true);
  });

  it('returns false when chain dead and mission has no override', () => {
    const run = newRunState('seed', squad, ['m1'], opCtx(false));
    expect(currentMissionStealthActive(run, baseMission())).toBe(false);
  });

  it("'force-on' wins even when chain is dead", () => {
    const run = newRunState('seed', squad, ['m1'], opCtx(false));
    const m = baseMission({ stealthMode: 'force-on' });
    expect(currentMissionStealthActive(run, m)).toBe(true);
  });

  it("'force-off' wins even when chain is alive", () => {
    const run = newRunState('seed', squad, ['m1'], opCtx(true));
    const m = baseMission({ stealthMode: 'force-off' });
    expect(currentMissionStealthActive(run, m)).toBe(false);
  });

  it("'force-on' makes a sandbox run stealth", () => {
    const run = newRunState('seed', squad, ['m1']);
    const m = baseMission({ stealthMode: 'force-on' });
    expect(currentMissionStealthActive(run, m)).toBe(true);
  });
});
