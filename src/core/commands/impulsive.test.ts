import { describe, it, expect } from 'vitest';
import { applyCommands } from './reducer';
import type { GameState, Unit, Weapon } from '../state/GameState';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 5,
  threshold: 5,
  descriptors: ['FOCUSED', 'COMBINED'],
};

const makeUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
  faction: 'A',
  position: v2(0, 0),
  radius: STANDARD_BASE_RADIUS_PIXELS,
  quality: 3,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [rifle],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const makeState = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'impulsive-test',
  commandCount: 0,
  units: [],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    playerActivations: 0,
    activeActivation: null,
  },
  ...overrides,
});

describe('IMPULSIVE_AGGRESSIVE — Trigger 1 (failed activation check)', () => {
  it('failed check + LOS to enemy → forced shoot, no turnover', () => {
    const s0 = makeState({
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          quality: 6, // 6+ on a d6 → 5/6 chance of failure
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(200, 0),
          weapons: [],
        }),
      ],
    });
    // Probe several seeds until we get a failed check (most do).
    let r = applyCommands(s0, [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }]);
    let attempts = 0;
    while (
      r.events.some(
        (e) => e.type === 'ACTIVATION_CHECK_ROLLED' && e.success,
      ) &&
      attempts < 20
    ) {
      attempts++;
      r = applyCommands(
        { ...s0, seed: `impulsive-test-${attempts}` },
        [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }],
      );
    }
    expect(
      r.events.find(
        (e) => e.type === 'ACTIVATION_CHECK_ROLLED' && !e.success,
      ),
    ).toBeDefined();
    expect(r.events.find((e) => e.type === 'IMPULSIVE_TRIGGERED')).toMatchObject({
      reason: 'CHECK_FAILED',
      action: 'SHOOT',
    });
    expect(r.events.find((e) => e.type === 'SHOT_RESOLVED')).toBeDefined();
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeUndefined();
    expect(r.state.initiative.holder).toBe('A');
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.activatedThisRound).toBe(true);
  });

  it('failed check + no LOS → forced move toward nearest enemy', () => {
    const wall = {
      kind: 'HARD' as const,
      polygon: {
        vertices: [v2(80, -200), v2(120, -200), v2(120, 200), v2(80, 200)],
      },
    };
    const s0 = makeState({
      seed: 'impulsive-move-test',
      terrain: [wall],
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          quality: 6,
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(200, 0),
        }),
      ],
    });
    let r = applyCommands(s0, [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }]);
    let attempts = 0;
    while (
      r.events.some(
        (e) => e.type === 'ACTIVATION_CHECK_ROLLED' && e.success,
      ) &&
      attempts < 20
    ) {
      attempts++;
      r = applyCommands(
        { ...s0, seed: `impulsive-move-test-${attempts}` },
        [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }],
      );
    }
    expect(r.events.find((e) => e.type === 'IMPULSIVE_TRIGGERED')).toMatchObject({
      reason: 'CHECK_FAILED',
      action: 'MOVE',
    });
    expect(r.events.find((e) => e.type === 'MOVE_RESOLVED')).toBeDefined();
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeUndefined();
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.activatedThisRound).toBe(true);
    // Moved away from origin (toward enemy, but blocked by wall so detoured).
    expect(a1.position.x !== 0 || a1.position.y !== 0).toBe(true);
  });

  it('non-IMPULSIVE failed check → normal turnover (regression)', () => {
    const s0 = makeState({
      seed: 'no-impulsive-test',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          quality: 6,
          traits: [], // no IMPULSIVE
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
    });
    let r = applyCommands(s0, [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }]);
    let attempts = 0;
    while (
      r.events.some(
        (e) => e.type === 'ACTIVATION_CHECK_ROLLED' && e.success,
      ) &&
      attempts < 20
    ) {
      attempts++;
      r = applyCommands(
        { ...s0, seed: `no-impulsive-${attempts}` },
        [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }],
      );
    }
    expect(r.events.find((e) => e.type === 'IMPULSIVE_TRIGGERED')).toBeUndefined();
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toMatchObject({
      reason: 'CHECK_FAILED',
    });
    expect(r.state.initiative.holder).toBe('B');
  });
});

describe('IMPULSIVE_AGGRESSIVE — Trigger 2 (turnover prelude)', () => {
  it('outgoing has unactivated IMPULSIVE → fires before turnover', () => {
    const s0 = makeState({
      seed: 'turnover-prelude',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    const turnoverIdx = r.events.findIndex(
      (e) => e.type === 'INITIATIVE_TURNOVER',
    );
    const impulsiveIdx = r.events.findIndex(
      (e) => e.type === 'IMPULSIVE_TRIGGERED',
    );
    expect(impulsiveIdx).toBeGreaterThanOrEqual(0);
    expect(turnoverIdx).toBeGreaterThan(impulsiveIdx);
    expect(r.events[impulsiveIdx]).toMatchObject({
      reason: 'TURNOVER',
      action: 'SHOOT',
    });
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    // A→B turnover doesn't bump the cycle (only A↔B↔A round trips do), so
    // activatedThisRound persists through this turnover.
    expect(a1.activatedThisRound).toBe(true);
    expect(r.state.initiative.holder).toBe('B');
  });

  it('outgoing IMPULSIVE already activated → does not re-fire', () => {
    const s0 = makeState({
      seed: 'already-activated',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          traits: ['IMPULSIVE_AGGRESSIVE'],
          activatedThisRound: true,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(r.events.find((e) => e.type === 'IMPULSIVE_TRIGGERED')).toBeUndefined();
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeDefined();
  });

  it('outgoing IMPULSIVE killed → does not fire', () => {
    const s0 = makeState({
      seed: 'killed-impulsive',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          traits: ['IMPULSIVE_AGGRESSIVE'],
          damage: 'KILLED',
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(r.events.find((e) => e.type === 'IMPULSIVE_TRIGGERED')).toBeUndefined();
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeDefined();
  });

  it('multiple outgoing IMPULSIVE units → all fire in units-array order', () => {
    const s0 = makeState({
      seed: 'multi-impulsive',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'a2',
          faction: 'A',
          position: v2(50, 50),
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(300, 0) }),
      ],
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    const triggered = r.events.filter(
      (e) => e.type === 'IMPULSIVE_TRIGGERED',
    ) as Array<{ unitId: string }>;
    expect(triggered.map((e) => e.unitId)).toEqual(['a1', 'a2']);
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeDefined();
  });

  it('incoming-side IMPULSIVE units do NOT fire on turnover', () => {
    const s0 = makeState({
      seed: 'incoming-impulsive',
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(200, 0),
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
      ],
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(r.events.find((e) => e.type === 'IMPULSIVE_TRIGGERED')).toBeUndefined();
    expect(r.state.initiative.holder).toBe('B');
  });
});
