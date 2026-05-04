/**
 * Stage 3 — RunState chain progression: bankedRewards accumulation,
 * retreatOperation, isRunOver / didRunSucceed branches with operation
 * context. Pure unit tests; no scene wiring.
 */
import { describe, it, expect } from 'vitest';
import {
  newRunState,
  advanceAfterMission,
  retreatOperation,
  isRunOver,
  didRunSucceed,
  type RunOperationContext,
  type MissionResult,
} from './state';
import type { RosterEntry } from '../core/setup/types';

const r = (id: string, templateId = 'trooper'): RosterEntry => ({
  id,
  templateId,
});

const squad = [r('s1'), r('s2'), r('s3'), r('s4')];

const op = (perStage: number, onComplete: number): RunOperationContext => ({
  operationId: 'test-op',
  stageLabels: ['ELIM', 'ELIM', 'MAIN'],
  perStageReward: { tactical: perStage, regional: 0, honor: 0 },
  onCompleteReward: { tactical: 0, regional: onComplete, honor: 1 },
});

const win = (missionId: string, survivorIds: string[]): MissionResult => ({
  missionId,
  winner: 'A',
  survivorIds,
  losses: squad.map((s) => s.id).filter((id) => !survivorIds.includes(id)),
});

const loss = (missionId: string): MissionResult => ({
  missionId,
  winner: 'B',
  survivorIds: [],
  losses: squad.map((s) => s.id),
});

describe('newRunState (with operation)', () => {
  it('zeroes bankedRewards when an operation is provided', () => {
    const run = newRunState('seed', squad, ['m1', 'm2'], op(2, 5));
    expect(run.operation?.operationId).toBe('test-op');
    expect(run.bankedRewards).toEqual({ tactical: 0, regional: 0, honor: 0 });
  });

  it('omits operation/bankedRewards when no operation context is given', () => {
    const run = newRunState('seed', squad, ['m1']);
    expect(run.operation).toBeUndefined();
    expect(run.bankedRewards).toBeUndefined();
  });
});

describe('advanceAfterMission — bankedRewards', () => {
  it('per-stage win bumps bankedRewards by perStageReward', () => {
    const run = newRunState('seed', squad, ['m1', 'm2', 'm3'], op(3, 10));
    const after = advanceAfterMission(run, win('m1', ['s1', 's2', 's3', 's4']), {
      s1: 'NONE',
      s2: 'NONE',
      s3: 'NONE',
      s4: 'NONE',
    });
    expect(after.bankedRewards).toEqual({
      tactical: 3,
      regional: 0,
      honor: 0,
    });
    expect(after.missionIndex).toBe(1);
  });

  it('final-stage win additionally banks the onCompleteReward', () => {
    let run = newRunState('seed', squad, ['m1', 'm2'], op(3, 10));
    run = advanceAfterMission(run, win('m1', ['s1', 's2', 's3', 's4']), {});
    run = advanceAfterMission(run, win('m2', ['s1', 's2']), {});
    // m1 win: +3 tactical. m2 (final) win: +3 tactical + (0 tactical, 10
    // regional, 1 honor) onComplete bonus.
    expect(run.bankedRewards).toEqual({
      tactical: 6,
      regional: 10,
      honor: 1,
    });
  });

  it('a loss leaves bankedRewards unchanged (no per-stage bump)', () => {
    let run = newRunState('seed', squad, ['m1', 'm2'], op(3, 10));
    run = advanceAfterMission(run, win('m1', ['s1', 's2', 's3', 's4']), {});
    const banked1 = run.bankedRewards;
    run = advanceAfterMission(run, loss('m2'), {});
    expect(run.bankedRewards).toEqual(banked1);
  });

  it('non-operation runs leave bankedRewards undefined', () => {
    const run = newRunState('seed', squad, ['m1']);
    const after = advanceAfterMission(run, win('m1', ['s1']), {});
    expect(after.bankedRewards).toBeUndefined();
  });
});

describe('retreatOperation', () => {
  it('marks retreated and skips remaining stages', () => {
    let run = newRunState('seed', squad, ['m1', 'm2', 'm3'], op(3, 10));
    run = advanceAfterMission(run, win('m1', ['s1', 's2', 's3', 's4']), {});
    const retreated = retreatOperation(run);
    expect(retreated.retreated).toBe(true);
    expect(retreated.missionIndex).toBe(retreated.missionIds.length);
    // bankedRewards from completed stages remain.
    expect(retreated.bankedRewards).toEqual({
      tactical: 3,
      regional: 0,
      honor: 0,
    });
  });

  it('retreating before the first stage keeps banked at zero', () => {
    const run = newRunState('seed', squad, ['m1', 'm2'], op(3, 10));
    const retreated = retreatOperation(run);
    expect(retreated.bankedRewards).toEqual({
      tactical: 0,
      regional: 0,
      honor: 0,
    });
  });
});

describe('isRunOver / didRunSucceed', () => {
  it('retreated → run over, did NOT succeed', () => {
    let run = newRunState('seed', squad, ['m1', 'm2'], op(3, 10));
    run = advanceAfterMission(run, win('m1', ['s1', 's2', 's3', 's4']), {});
    run = retreatOperation(run);
    expect(isRunOver(run)).toBe(true);
    expect(didRunSucceed(run)).toBe(false);
  });

  it('all stages cleared with survivors → succeeded', () => {
    let run = newRunState('seed', squad, ['m1', 'm2'], op(3, 10));
    run = advanceAfterMission(run, win('m1', ['s1', 's2', 's3', 's4']), {});
    run = advanceAfterMission(run, win('m2', ['s1', 's2']), {});
    expect(isRunOver(run)).toBe(true);
    expect(didRunSucceed(run)).toBe(true);
  });

  it('squad wiped mid-chain → run over, did NOT succeed', () => {
    let run = newRunState('seed', squad, ['m1', 'm2'], op(3, 10));
    run = advanceAfterMission(run, loss('m1'), {});
    expect(isRunOver(run)).toBe(true);
    expect(didRunSucceed(run)).toBe(false);
  });
});
