/**
 * Pure unit tests for the `no_intel` chain state — mirror of
 * `stealth.test.ts`. Covers `newRunState` init from `RunOperationContext`
 * and `currentMissionNoIntelActive` precedence (mission override > chain
 * inheritance). Independent from stealth: both flags should compose.
 */
import { describe, expect, it } from 'vitest';
import {
  currentMissionNoIntelActive,
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

const opCtx = (
  flags: { stealthEntry?: boolean; noIntelEntry?: boolean } = {},
): RunOperationContext => ({
  operationId: 'op-test',
  stageLabels: ['ELIM', 'MAIN'],
  perStageReward: { tactical: 1, regional: 0, honor: 0 },
  onCompleteReward: { tactical: 0, regional: 1, honor: 0 },
  ...(flags.stealthEntry === true ? { stealthEntry: true } : {}),
  ...(flags.noIntelEntry === true ? { noIntelEntry: true } : {}),
});

describe('newRunState — operationNoIntelAlive init', () => {
  it('initialises true when operation.noIntelEntry === true', () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1', 'm2'],
      opCtx({ noIntelEntry: true }),
    );
    expect(run.operationNoIntelAlive).toBe(true);
  });

  it('omits the field when noIntelEntry is false/undefined', () => {
    const run = newRunState('seed', squad, ['m1'], opCtx());
    expect(run.operationNoIntelAlive).toBeUndefined();
  });

  it('omits the field for non-operation runs', () => {
    const run = newRunState('seed', squad, ['m1']);
    expect(run.operationNoIntelAlive).toBeUndefined();
  });
});

describe('currentMissionNoIntelActive — precedence', () => {
  it('inherits from operationNoIntelAlive when mission has no override', () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1'],
      opCtx({ noIntelEntry: true }),
    );
    expect(currentMissionNoIntelActive(run, baseMission())).toBe(true);
  });

  it('returns false when chain dead and mission has no override', () => {
    const run = newRunState('seed', squad, ['m1'], opCtx());
    expect(currentMissionNoIntelActive(run, baseMission())).toBe(false);
  });

  it("'force-on' wins even when chain is dead", () => {
    const run = newRunState('seed', squad, ['m1'], opCtx());
    const m = baseMission({ noIntelMode: 'force-on' });
    expect(currentMissionNoIntelActive(run, m)).toBe(true);
  });

  it("'force-off' wins even when chain is alive", () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1'],
      opCtx({ noIntelEntry: true }),
    );
    const m = baseMission({ noIntelMode: 'force-off' });
    expect(currentMissionNoIntelActive(run, m)).toBe(false);
  });

  it("'force-on' makes a sandbox run no-intel", () => {
    const run = newRunState('seed', squad, ['m1']);
    const m = baseMission({ noIntelMode: 'force-on' });
    expect(currentMissionNoIntelActive(run, m)).toBe(true);
  });
});

describe('coexistence with stealth', () => {
  it('both flags can be set on the same operation independently', () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1'],
      opCtx({ stealthEntry: true, noIntelEntry: true }),
    );
    expect(run.operationStealthAlive).toBe(true);
    expect(run.operationNoIntelAlive).toBe(true);
    const m = baseMission();
    expect(currentMissionStealthActive(run, m)).toBe(true);
    expect(currentMissionNoIntelActive(run, m)).toBe(true);
  });

  it('per-mission overrides apply independently to each flag', () => {
    const run = newRunState(
      'seed',
      squad,
      ['m1'],
      opCtx({ stealthEntry: true, noIntelEntry: true }),
    );
    const m = baseMission({
      stealthMode: 'force-off',
      noIntelMode: 'force-on',
    });
    expect(currentMissionStealthActive(run, m)).toBe(false);
    expect(currentMissionNoIntelActive(run, m)).toBe(true);
  });
});
