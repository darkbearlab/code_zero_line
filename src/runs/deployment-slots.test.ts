/**
 * Pure unit tests for the `enforceDeploymentSlots` chain state.
 * Mirror of `no-intel.test.ts` — covers `newRunState` init from
 * `RunOperationContext`, `currentMissionDeploymentSlotsActive` precedence,
 * and `advanceAfterMission` chain inheritance / `force-off` clearing.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceAfterMission,
  currentMissionDeploymentSlotsActive,
  newRunState,
  type MissionResult,
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

const opCtx = (
  flags: { enforceDeploymentSlotsEntry?: boolean } = {},
): RunOperationContext => ({
  operationId: 'op-test',
  stageLabels: ['ELIM', 'MAIN'],
  perStageReward: { tactical: 1, regional: 0, honor: 0 },
  onCompleteReward: { tactical: 0, regional: 1, honor: 0 },
  ...(flags.enforceDeploymentSlotsEntry === true
    ? { enforceDeploymentSlotsEntry: true }
    : {}),
});

const winResult = (missionId: string, ids: string[]): MissionResult => ({
  missionId,
  winner: 'A',
  survivorIds: ids,
  losses: [],
});

describe('newRunState — operationDeploymentSlotsAlive init', () => {
  it('initialises true when operation.enforceDeploymentSlotsEntry === true', () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1', 'm2'],
      opCtx({ enforceDeploymentSlotsEntry: true }),
    );
    expect(run.operationDeploymentSlotsAlive).toBe(true);
  });

  it('omits the field when entry flag is unset', () => {
    const run = newRunState('seed', squad, ['m1'], opCtx());
    expect(run.operationDeploymentSlotsAlive).toBeUndefined();
  });

  it('omits the field for non-operation runs', () => {
    const run = newRunState('seed', squad, ['m1']);
    expect(run.operationDeploymentSlotsAlive).toBeUndefined();
  });
});

describe('currentMissionDeploymentSlotsActive — precedence', () => {
  it('inherits from chain state when mission has no override', () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1'],
      opCtx({ enforceDeploymentSlotsEntry: true }),
    );
    expect(currentMissionDeploymentSlotsActive(run, baseMission())).toBe(true);
  });

  it('returns false when chain is undefined and mission has no override', () => {
    const run = newRunState('seed', squad, ['m1'], opCtx());
    expect(currentMissionDeploymentSlotsActive(run, baseMission())).toBe(false);
  });

  it("'force-on' wins even when chain is undefined", () => {
    const run = newRunState('seed', squad, ['m1'], opCtx());
    const m = baseMission({ deploymentSlotsMode: 'force-on' });
    expect(currentMissionDeploymentSlotsActive(run, m)).toBe(true);
  });

  it("'force-off' wins even when chain is alive", () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1'],
      opCtx({ enforceDeploymentSlotsEntry: true }),
    );
    const m = baseMission({ deploymentSlotsMode: 'force-off' });
    expect(currentMissionDeploymentSlotsActive(run, m)).toBe(false);
  });

  it("'force-on' applies even on a sandbox run with no operation", () => {
    const run = newRunState('seed', squad, ['m1']);
    const m = baseMission({ deploymentSlotsMode: 'force-on' });
    expect(currentMissionDeploymentSlotsActive(run, m)).toBe(true);
  });
});

describe('advanceAfterMission — chain propagation', () => {
  it('preserves chain state when mission has no slot override', () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1', 'm2'],
      opCtx({ enforceDeploymentSlotsEntry: true }),
    );
    const next = advanceAfterMission(
      run,
      winResult('m1', ['s1', 's2']),
      { s1: 'NONE', s2: 'NONE' },
      undefined,
      undefined,
      undefined,
    );
    expect(next.operationDeploymentSlotsAlive).toBe(true);
  });

  it("'force-off' on the just-completed mission clears chain state", () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1', 'm2'],
      opCtx({ enforceDeploymentSlotsEntry: true }),
    );
    const next = advanceAfterMission(
      run,
      winResult('m1', ['s1', 's2']),
      { s1: 'NONE', s2: 'NONE' },
      undefined,
      undefined,
      'force-off',
    );
    expect(next.operationDeploymentSlotsAlive).toBe(false);
  });

  it("'force-on' on a finished mission does not flip chain state", () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1', 'm2'],
      opCtx({ enforceDeploymentSlotsEntry: true }),
    );
    const next = advanceAfterMission(
      run,
      winResult('m1', ['s1', 's2']),
      { s1: 'NONE', s2: 'NONE' },
      undefined,
      undefined,
      'force-on',
    );
    expect(next.operationDeploymentSlotsAlive).toBe(true);
  });

  it('leaves chain state untouched when it was already undefined', () => {
    const run = newRunState('seed', squad, ['m1', 'm2'], opCtx());
    const next = advanceAfterMission(
      run,
      winResult('m1', ['s1', 's2']),
      { s1: 'NONE', s2: 'NONE' },
      undefined,
      undefined,
      'force-off',
    );
    expect(next.operationDeploymentSlotsAlive).toBeUndefined();
  });
});
