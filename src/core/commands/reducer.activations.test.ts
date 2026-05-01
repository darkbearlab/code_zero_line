import { describe, it, expect } from 'vitest';
import { applyCommand, applyCommands } from './reducer';
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
  seed: 'budget-test',
  commandCount: 0,
  units: [
    makeUnit({ id: 'a1', faction: 'A', quality: 3 }),
    makeUnit({ id: 'a2', faction: 'A', quality: 3 }),
    makeUnit({ id: 'b1', faction: 'B', quality: 3 }),
  ],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 10, B: 10 },
    cycle: 1,
    playerActivations: 0,
    activeActivation: null,
  },
  ...overrides,
});

describe('playerActivations budget', () => {
  it('SPEND on faction A bumps playerActivations by 1', () => {
    const s0 = makeState();
    const r = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(r.state.initiative.playerActivations).toBe(1);
  });

  it('successful CHECK on faction A bumps playerActivations by 1', () => {
    const s0: GameState = {
      ...makeState(),
      units: makeState().units.map((u) =>
        u.id === 'a1' ? { ...u, quality: 1 } : u,
      ),
    };
    const r = applyCommand(s0, { type: 'ACTIVATE_CHECK', unitId: 'a1' });
    expect(r.state.initiative.activeActivation?.kind).toBe('CHECK_SUCCESS');
    expect(r.state.initiative.playerActivations).toBe(1);
  });

  it('failed CHECK still bumps playerActivations by 1', () => {
    const s0: GameState = {
      ...makeState(),
      units: makeState().units.map((u) =>
        u.id === 'a1' ? { ...u, quality: 7 } : u,
      ),
    };
    const r = applyCommand(s0, { type: 'ACTIVATE_CHECK', unitId: 'a1' });
    // Turnover happened, but the attempt counts against the player budget.
    expect(r.state.initiative.holder).toBe('B');
    expect(r.state.initiative.playerActivations).toBe(1);
  });

  it('OVERDRAFT on faction A bumps playerActivations by 1', () => {
    const s0 = makeState({
      initiative: {
        holder: 'A',
        momentum: { A: 1, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: null,
      },
    });
    const r = applyCommand(s0, { type: 'ACTIVATE_OVERDRAFT', unitId: 'a1' });
    expect(r.state.initiative.activeActivation?.kind).toBe('OVERDRAFT');
    expect(r.state.initiative.playerActivations).toBe(1);
  });

  it('faction B activations do NOT bump playerActivations', () => {
    const s0 = makeState({
      initiative: {
        holder: 'B',
        momentum: { A: 0, B: 10 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: null,
      },
    });
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'b1' },
      { type: 'END_ACTIVATION' },
    ]);
    expect(r.state.initiative.playerActivations).toBe(0);
  });

  it('two consecutive A activations bump twice; END_ACTIVATION does not bump', () => {
    const s0 = makeState();
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'END_ACTIVATION' },
      { type: 'ACTIVATE_SPEND', unitId: 'a2' },
      { type: 'END_ACTIVATION' },
    ]);
    expect(r.state.initiative.playerActivations).toBe(2);
  });

  it('turnover preserves playerActivations across cycle bump (B→A)', () => {
    const s0: GameState = {
      ...makeState(),
      units: makeState().units.map((u) =>
        u.id === 'a1' ? { ...u, quality: 7 } : u,
      ),
    };
    // Failed check: A → B, playerActivations = 1.
    const r1 = applyCommand(s0, { type: 'ACTIVATE_CHECK', unitId: 'a1' });
    expect(r1.state.initiative.playerActivations).toBe(1);
    // B passes back to A, cycle bumps; budget must persist.
    const r2 = applyCommand(r1.state, { type: 'PASS_INITIATIVE' });
    expect(r2.state.initiative.holder).toBe('A');
    expect(r2.state.initiative.cycle).toBe(2);
    expect(r2.state.initiative.playerActivations).toBe(1);
  });

  it('COMMAND_MOVE inside one SPEND counts as a single activation', () => {
    const s0 = makeState({
      units: [
        makeUnit({
          id: 'cap',
          faction: 'A',
          position: v2(0, 0),
          quality: 2,
          traits: ['OFFICER'],
        }),
        makeUnit({ id: 'a1', faction: 'A', position: v2(20, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
      ],
    });
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'cap' },
      {
        type: 'COMMAND_MOVE',
        officerId: 'cap',
        officerTarget: v2(80, 0),
        participants: [{ unitId: 'a1', target: v2(100, 0) }],
      },
    ]);
    expect(r.state.initiative.playerActivations).toBe(1);
  });
});
