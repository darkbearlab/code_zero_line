import { describe, it, expect } from 'vitest';
import { applyCommand, applyCommands } from './reducer';
import { CommandError } from './types';
import type { GameState, Unit } from '../state/GameState';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';

const makeUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
  faction: 'A',
  position: v2(0, 0),
  radius: STANDARD_BASE_RADIUS_PIXELS,
  quality: 3,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const makeState = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'test-seed',
  commandCount: 0,
  units: [
    makeUnit({ id: 'a1', faction: 'A', quality: 3 }),
    makeUnit({ id: 'a2', faction: 'A', quality: 3 }),
    makeUnit({ id: 'b1', faction: 'B', quality: 4 }),
  ],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    activeActivation: null,
  },
  ...overrides,
});

const withUnit = (s: GameState, id: string, patch: Partial<Unit>): GameState => ({
  ...s,
  units: s.units.map((u) => (u.id === id ? { ...u, ...patch } : u)),
});

describe('ACTIVATE_SPEND', () => {
  it('pays quality cost and starts SPEND activation', () => {
    const s0 = makeState();
    const r = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(r.state.initiative.momentum.A).toBe(2); // 5 - 3
    expect(r.state.initiative.activeActivation?.kind).toBe('SPEND');
    expect(r.state.initiative.activeActivation?.unitId).toBe('a1');
    expect(r.state.initiative.activeActivation?.failureProtection).toBe(true);
    expect(r.state.units.find((u) => u.id === 'a1')?.activatedThisRound).toBe(true);
    expect(r.events.some((e) => e.type === 'MOMENTUM_SPENT')).toBe(true);
  });

  it('throws when insufficient momentum', () => {
    const s0 = makeState({ initiative: {
      holder: 'A',
      momentum: { A: 1, B: 0 },
      cycle: 1,
      activeActivation: null,
    }});
    expect(() => applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' })).toThrow(
      CommandError,
    );
  });

  it('throws when unit is not on holder side', () => {
    const s0 = makeState();
    expect(() => applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'b1' })).toThrow(
      /NOT_HOLDER/,
    );
  });

  it('throws when activation already in progress', () => {
    const s0 = makeState();
    const r = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() =>
      applyCommand(r.state, { type: 'ACTIVATE_SPEND', unitId: 'a2' }),
    ).toThrow(/ALREADY_ACTIVE/);
  });
});

describe('ACTIVATE_CHECK', () => {
  it('always succeeds at quality 1 — sets CHECK_SUCCESS, no momentum change', () => {
    const s0 = withUnit(makeState(), 'a1', { quality: 1 });
    const r = applyCommand(s0, { type: 'ACTIVATE_CHECK', unitId: 'a1' });
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.momentum.A).toBe(5);
    expect(r.state.initiative.activeActivation?.kind).toBe('CHECK_SUCCESS');
    expect(r.state.initiative.activeActivation?.actionsRemaining).toBe(-1);
    const checkEv = r.events.find((e) => e.type === 'ACTIVATION_CHECK_ROLLED');
    expect(checkEv && (checkEv as { success: boolean }).success).toBe(true);
  });

  it('always fails at quality 7 — turnover, opponent has 2 momentum', () => {
    const s0 = withUnit(makeState(), 'a1', { quality: 7 });
    const r = applyCommand(s0, { type: 'ACTIVATE_CHECK', unitId: 'a1' });
    expect(r.state.initiative.holder).toBe('B');
    expect(r.state.initiative.momentum).toEqual({ A: 0, B: 2 });
    expect(r.state.initiative.activeActivation).toBeNull();
    expect(r.events.find((e) => e.type === 'INITIATIVE_TURNOVER')).toBeDefined();
  });

  it('failed check does NOT mark unit as activated', () => {
    const s0 = withUnit(makeState(), 'a1', { quality: 7 });
    const r = applyCommand(s0, { type: 'ACTIVATE_CHECK', unitId: 'a1' });
    expect(r.state.units.find((u) => u.id === 'a1')?.activatedThisRound).toBe(false);
  });
});

describe('ACTIVATE_OVERDRAFT', () => {
  it('zeroes momentum, stashes deficit, starts OVERDRAFT activation', () => {
    const s0: GameState = {
      ...makeState(),
      initiative: {
        holder: 'A',
        momentum: { A: 1, B: 0 },
        cycle: 1,
        activeActivation: null,
      },
    };
    // a1 quality 3, momentum 1 → deficit 2
    const r = applyCommand(s0, { type: 'ACTIVATE_OVERDRAFT', unitId: 'a1' });
    expect(r.state.initiative.momentum.A).toBe(0);
    expect(r.state.initiative.activeActivation?.kind).toBe('OVERDRAFT');
    expect(r.state.initiative.activeActivation?.overdraftDeficit).toBe(2);
    expect(r.state.initiative.activeActivation?.forcedTurnoverAfterAction).toBe(true);
  });

  it('throws when overdraft is not needed', () => {
    const s0 = makeState(); // A momentum 5, a1 quality 3
    expect(() =>
      applyCommand(s0, { type: 'ACTIVATE_OVERDRAFT', unitId: 'a1' }),
    ).toThrow(/OVERDRAFT_NOT_NEEDED/);
  });

  it('END_ACTIVATION on overdraft triggers turnover with deficit', () => {
    const s0: GameState = {
      ...makeState(),
      initiative: {
        holder: 'A',
        momentum: { A: 1, B: 0 },
        cycle: 1,
        activeActivation: null,
      },
    };
    const r1 = applyCommand(s0, { type: 'ACTIVATE_OVERDRAFT', unitId: 'a1' });
    const r2 = applyCommand(r1.state, { type: 'END_ACTIVATION' });
    expect(r2.state.initiative.holder).toBe('B');
    expect(r2.state.initiative.momentum).toEqual({ A: 0, B: 2 }); // deficit was 2
    expect(
      r2.events.find(
        (e) => e.type === 'INITIATIVE_TURNOVER' && e.reason === 'OVERDRAFT',
      ),
    ).toBeDefined();
  });
});

describe('END_ACTIVATION', () => {
  it('SPEND ends without turnover', () => {
    const s0 = makeState();
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    const r2 = applyCommand(r1.state, { type: 'END_ACTIVATION' });
    expect(r2.state.initiative.holder).toBe('A');
    expect(r2.state.initiative.activeActivation).toBeNull();
    expect(r2.events[0]?.type).toBe('ACTIVATION_ENDED');
  });

  it('throws when no active activation', () => {
    const s0 = makeState();
    expect(() => applyCommand(s0, { type: 'END_ACTIVATION' })).toThrow(
      /NO_ACTIVE_ACTIVATION/,
    );
  });
});

describe('PASS_INITIATIVE', () => {
  it('hands initiative to opponent with 2 momentum', () => {
    const s0 = makeState();
    const r = applyCommand(s0, { type: 'PASS_INITIATIVE' });
    expect(r.state.initiative.holder).toBe('B');
    expect(r.state.initiative.momentum).toEqual({ A: 0, B: 2 });
  });

  it('throws when activation in progress', () => {
    const s0 = makeState();
    const r = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() => applyCommand(r.state, { type: 'PASS_INITIATIVE' })).toThrow(
      /ACTIVATION_IN_PROGRESS/,
    );
  });
});

describe('Round transitions', () => {
  it('round increments and per-round flags reset when initiative returns to A', () => {
    // A spends, ends, passes → B takes (round still 1)
    // B passes → A takes (round bumps to 2, flags clear)
    const s0 = makeState({
      initiative: {
        holder: 'A',
        momentum: { A: 5, B: 0 },
        cycle: 1,
        activeActivation: null,
      },
    });
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'END_ACTIVATION' },
      { type: 'PASS_INITIATIVE' }, // A → B, round still 1
      { type: 'PASS_INITIATIVE' }, // B → A, round bumps to 2, flags clear
    ]);
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.cycle).toBe(2);
    expect(r.state.units.find((u) => u.id === 'a1')?.activatedThisRound).toBe(false);
  });
});

describe('Determinism', () => {
  it('same seed + same commands → identical state and events', () => {
    const s0 = withUnit(makeState({ seed: 'deterministic' }), 'a1', { quality: 1 });
    const cmds = [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' } as const,
      { type: 'END_ACTIVATION' } as const,
      { type: 'PASS_INITIATIVE' } as const,
    ];
    const a = applyCommands(s0, cmds);
    const b = applyCommands(s0, cmds);
    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
  });

  it('different seed produces different check outcomes for borderline quality', () => {
    // Run many seeds with quality 4; expect some successes, some failures.
    const outcomes = new Set<boolean>();
    for (let i = 0; i < 20; i++) {
      const s0 = withUnit(makeState({ seed: `seed-${i}` }), 'a1', { quality: 4 });
      const r = applyCommand(s0, { type: 'ACTIVATE_CHECK', unitId: 'a1' });
      const success = r.state.initiative.holder === 'A';
      outcomes.add(success);
    }
    expect(outcomes.size).toBe(2); // both true and false observed
  });
});
