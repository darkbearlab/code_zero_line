import { describe, it, expect } from 'vitest';
import { applyCommands } from './reducer';
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

const baseState = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'rally-test',
  commandCount: 0,
  units: [
    makeUnit({ id: 'a1', faction: 'A', damage: 'IMPEDED', quality: 1 }),
    makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
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

describe('RALLY command', () => {
  it('quality 1 always succeeds → IMPEDED → NONE, activation ends', () => {
    const s0 = baseState();
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'RALLY', unitId: 'a1' },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.damage).toBe('NONE');
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.activeActivation).toBeNull();
  });

  it('SUPPRESSED → IMPEDED on success and stance restored', () => {
    const s0: GameState = {
      ...baseState(),
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          damage: 'SUPPRESSED',
          stance: 'PRONE',
          quality: 1,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'RALLY', unitId: 'a1' },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.damage).toBe('IMPEDED');
    expect(a1.stance).toBe('STANDING');
  });

  it('quality 7 always fails → turnover (rally check failure overrides SPEND protection)', () => {
    const s0: GameState = {
      ...baseState({
        initiative: {
          holder: 'A',
          momentum: { A: 10, B: 0 },
          cycle: 1,
          activeActivation: null,
        },
      }),
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          damage: 'IMPEDED',
          quality: 7,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'RALLY', unitId: 'a1' },
    ]);
    expect(r.state.initiative.holder).toBe('B');
  });

  it('officer aura: borrow officer quality when better', () => {
    const s0: GameState = {
      ...baseState({
        initiative: {
          holder: 'A',
          momentum: { A: 10, B: 0 },
          cycle: 1,
          activeActivation: null,
        },
      }),
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          damage: 'IMPEDED',
          quality: 7, // would always fail alone
          position: v2(0, 0),
        }),
        makeUnit({
          id: 'cap',
          faction: 'A',
          quality: 1, // borrowable
          traits: ['OFFICER'],
          position: v2(20, 0), // within 1 unit distance
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'RALLY', unitId: 'a1' },
    ]);
    const event = r.events.find((e) => e.type === 'RALLY_ROLLED') as
      | { officerUsed: string | null; threshold: number }
      | undefined;
    expect(event?.officerUsed).toBe('cap');
    expect(event?.threshold).toBe(1);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.damage).toBe('NONE');
  });

  it('throws when there is nothing to rally', () => {
    const s0: GameState = {
      ...baseState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', damage: 'NONE' }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
    };
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'a1' },
        { type: 'RALLY', unitId: 'a1' },
      ]),
    ).toThrow(/NOTHING_TO_RALLY/);
  });
});
