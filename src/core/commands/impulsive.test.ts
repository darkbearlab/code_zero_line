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
      id: 'wall-1',
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

const bigRifle: Weapon = {
  id: 'big-rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 20,
  threshold: 2,
  descriptors: ['FOCUSED', 'COMBINED'],
};

describe('IMPULSIVE_AGGRESSIVE — forced move + reactions (Stage 1)', () => {
  it('forced-move with enemy in LOS along path → reaction plan + REACTION shot', () => {
    // a1 has no weapons → pickAggressiveShoot returns null → forced-move.
    // b1 has clear LOS along the entire path (no walls) and a strong rifle,
    // so planReactions clears the EV gate and places a marker.
    const s0 = makeState({
      seed: 'forced-move-reaction',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          quality: 6,
          weapons: [],
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(300, 0),
          weapons: [bigRifle],
        }),
      ],
    });
    let r = applyCommands(s0, [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }]);
    let attempts = 0;
    while (
      r.events.some((e) => e.type === 'ACTIVATION_CHECK_ROLLED' && e.success) &&
      attempts < 20
    ) {
      attempts++;
      r = applyCommands(
        { ...s0, seed: `forced-move-reaction-${attempts}` },
        [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }],
      );
    }
    const move = r.events.find((e) => e.type === 'MOVE_RESOLVED') as
      | { reactionWindows: unknown[] }
      | undefined;
    expect(move).toBeDefined();
    expect(move!.reactionWindows.length).toBeGreaterThan(0);
    const reactionShot = r.events.find(
      (e) =>
        e.type === 'SHOT_RESOLVED' && e.shooterId === 'b1' && e.targetId === 'a1',
    );
    expect(reactionShot).toBeDefined();
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeUndefined();
  });

  it('forced-move killed by reaction → mover KILLED, no nested turnover', () => {
    const s0 = makeState({
      seed: 'forced-move-kill',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          quality: 6,
          weapons: [],
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(300, 0),
          weapons: [bigRifle],
        }),
      ],
    });
    let r = applyCommands(s0, [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }]);
    let attempts = 0;
    while (
      r.events.some((e) => e.type === 'ACTIVATION_CHECK_ROLLED' && e.success) &&
      attempts < 20
    ) {
      attempts++;
      r = applyCommands(
        { ...s0, seed: `forced-move-kill-${attempts}` },
        [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }],
      );
    }
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    // 20d/2+ unobstructed → ~16 hits → IMPEDED→SUPPRESSED→KILLED in one shot.
    expect(a1.damage).toBe('KILLED');
    // Trigger 1 must NOT cause turnover even when the impulse mover dies.
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeUndefined();
    expect(r.state.initiative.holder).toBe('A');
  });

  it('Trigger 2: forced-move killed by reaction → exactly one INITIATIVE_TURNOVER (from PASS_INITIATIVE)', () => {
    const s0 = makeState({
      seed: 'turnover-forced-move-kill',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          weapons: [],
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(300, 0),
          weapons: [bigRifle],
        }),
      ],
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.damage).toBe('KILLED');
    const turnovers = r.events.filter((e) => e.type === 'INITIATIVE_TURNOVER');
    expect(turnovers.length).toBe(1);
    expect(turnovers[0]).toMatchObject({ reason: 'VOLUNTARY' });
    expect(r.state.initiative.holder).toBe('B');
  });

  it('Trigger 2: reaction on first IMPULSIVE → second IMPULSIVE still fires', () => {
    const s0 = makeState({
      seed: 'turnover-multi-with-reaction',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          weapons: [],
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'a2',
          faction: 'A',
          position: v2(40, 40),
          weapons: [],
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(400, 0),
          weapons: [bigRifle],
        }),
      ],
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    const triggered = (
      r.events.filter((e) => e.type === 'IMPULSIVE_TRIGGERED') as Array<{
        unitId: string;
      }>
    ).map((e) => e.unitId);
    // Both a1 and a2 must have triggered, even if a1 was killed by reaction.
    expect(triggered).toContain('a1');
    expect(triggered).toContain('a2');
  });
});

describe('IMPULSIVE_AGGRESSIVE × CANNON_FODDER (Stage 2 interaction audit)', () => {
  // CANNON_FODDER's bypass logic (`reactionOutcomeAfterFodder`) only short-
  // circuits the REACTION_HIT → turnover branch inside `processPostAction`.
  // The IMPULSIVE forced flow never calls `processPostAction`, so the trait
  // is a non-interaction here — these tests pin that down so a future
  // refactor can't silently re-introduce a turnover from inside an impulse.

  it('Trigger 1 forced-shoot kills opponent CANNON_FODDER → no turnover', () => {
    // The IMPULSIVE shooter holds initiative; killing the opponent's fodder
    // is irrelevant to CANNON_FODDER (which only protects the *own* faction
    // from reaction-driven turnover). The forced-shoot path has no turnover
    // anyway, so this only verifies the obvious non-interaction.
    const s0 = makeState({
      seed: 'fodder-shoot-target',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          quality: 6,
          weapons: [bigRifle],
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(200, 0),
          weapons: [],
          traits: ['CANNON_FODDER'],
        }),
      ],
    });
    let r = applyCommands(s0, [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }]);
    let attempts = 0;
    while (
      r.events.some((e) => e.type === 'ACTIVATION_CHECK_ROLLED' && e.success) &&
      attempts < 20
    ) {
      attempts++;
      r = applyCommands(
        { ...s0, seed: `fodder-shoot-target-${attempts}` },
        [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }],
      );
    }
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeUndefined();
    expect(r.state.initiative.holder).toBe('A');
  });

  it('Trigger 1 forced-move + own CANNON_FODDER killed by reaction → no turnover', () => {
    // The IMPULSIVE mover is itself CANNON_FODDER. Without the trait this
    // already wouldn't turnover (Stage 1: the executor skips processPostAction).
    // Adding CANNON_FODDER must not change anything — verify both pre-existing
    // (no-turnover) and post-trait paths still yield no turnover.
    const s0 = makeState({
      seed: 'fodder-impulsive-trigger1',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          quality: 6,
          weapons: [],
          traits: ['IMPULSIVE_AGGRESSIVE', 'CANNON_FODDER'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(300, 0),
          weapons: [bigRifle],
        }),
      ],
    });
    let r = applyCommands(s0, [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }]);
    let attempts = 0;
    while (
      r.events.some((e) => e.type === 'ACTIVATION_CHECK_ROLLED' && e.success) &&
      attempts < 20
    ) {
      attempts++;
      r = applyCommands(
        { ...s0, seed: `fodder-impulsive-trigger1-${attempts}` },
        [{ type: 'ACTIVATE_CHECK', unitId: 'a1' }],
      );
    }
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.damage).toBe('KILLED');
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeUndefined();
    expect(r.state.initiative.holder).toBe('A');
  });

  it('Trigger 2 forced-move + own CANNON_FODDER killed by reaction → exactly one turnover (PASS_INITIATIVE)', () => {
    // Same as Stage 1's Trigger 2 kill test, plus CANNON_FODDER. The
    // PASS_INITIATIVE turnover MUST still proceed — CANNON_FODDER's bypass
    // is gated on REACTION_HIT, not VOLUNTARY.
    const s0 = makeState({
      seed: 'fodder-impulsive-trigger2',
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          weapons: [],
          traits: ['IMPULSIVE_AGGRESSIVE', 'CANNON_FODDER'],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(300, 0),
          weapons: [bigRifle],
        }),
      ],
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.damage).toBe('KILLED');
    const turnovers = r.events.filter((e) => e.type === 'INITIATIVE_TURNOVER');
    expect(turnovers.length).toBe(1);
    expect(turnovers[0]).toMatchObject({ reason: 'VOLUNTARY' });
    expect(r.state.initiative.holder).toBe('B');
  });
});
