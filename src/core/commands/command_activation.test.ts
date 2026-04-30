import { describe, it, expect } from 'vitest';
import { applyCommands } from './reducer';
import type { GameState, Unit, Weapon } from '../state/GameState';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 3,
  threshold: 5,
  descriptors: ['FOCUSED', 'COMBINED'],
};

const overwhelmingRifle: Weapon = {
  id: 'big-rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 20,
  threshold: 2,
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

const baseState = (units: Unit[]): GameState => ({
  seed: 'cmd-test',
  commandCount: 0,
  units,
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    activeActivation: null,
  },
});

describe('COMMAND_MOVE', () => {
  it('officer + 1 ally both arrive at their targets', () => {
    const s0 = baseState([
      makeUnit({
        id: 'cap',
        faction: 'A',
        position: v2(0, 0),
        traits: ['OFFICER'],
        quality: 2,
      }),
      makeUnit({ id: 'a1', faction: 'A', position: v2(20, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'cap' },
      {
        type: 'COMMAND_MOVE',
        officerId: 'cap',
        officerTarget: v2(80, 0),
        participants: [{ unitId: 'a1', target: v2(100, 0) }],
      },
    ]);
    const cap = r.state.units.find((u) => u.id === 'cap')!;
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(cap.position.x).toBeCloseTo(80, 0);
    expect(a1.position.x).toBeCloseTo(100, 0);
  });

  it('rejects participant not within 1 UD of officer at start', () => {
    const s0 = baseState([
      makeUnit({
        id: 'cap',
        faction: 'A',
        position: v2(0, 0),
        traits: ['OFFICER'],
      }),
      makeUnit({ id: 'a1', faction: 'A', position: v2(500, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
    ]);
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'cap' },
        {
          type: 'COMMAND_MOVE',
          officerId: 'cap',
          officerTarget: v2(50, 0),
          participants: [{ unitId: 'a1', target: v2(60, 0) }],
        },
      ]),
    ).toThrow(/PARTICIPANT_TOO_FAR/);
  });

  it("rejects participant target outside officer's 1 UD", () => {
    const s0 = baseState([
      makeUnit({
        id: 'cap',
        faction: 'A',
        position: v2(0, 0),
        traits: ['OFFICER'],
      }),
      makeUnit({ id: 'a1', faction: 'A', position: v2(20, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
    ]);
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'cap' },
        {
          type: 'COMMAND_MOVE',
          officerId: 'cap',
          officerTarget: v2(50, 0),
          participants: [{ unitId: 'a1', target: v2(500, 0) }],
        },
      ]),
    ).toThrow(/TARGET_TOO_FAR/);
  });

  it('non-officer cannot command-move', () => {
    const s0 = baseState([
      makeUnit({ id: 'a0', faction: 'A', position: v2(0, 0) }),
      makeUnit({ id: 'a1', faction: 'A', position: v2(20, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
    ]);
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'a0' },
        {
          type: 'COMMAND_MOVE',
          officerId: 'a0',
          officerTarget: v2(50, 0),
          participants: [{ unitId: 'a1', target: v2(60, 0) }],
        },
      ]),
    ).toThrow(/NOT_OFFICER/);
  });

  it('reaction kill stops the entire group at the marker t', () => {
    const s0 = baseState([
      makeUnit({
        id: 'cap',
        faction: 'A',
        position: v2(0, 0),
        traits: ['OFFICER'],
        quality: 2,
      }),
      makeUnit({ id: 'a1', faction: 'A', position: v2(20, 0) }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(50, 200),
        weapons: [overwhelmingRifle],
      }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'cap' },
      {
        type: 'COMMAND_MOVE',
        officerId: 'cap',
        officerTarget: v2(200, 0),
        participants: [{ unitId: 'a1', target: v2(220, 0) }],
        reactionPlan: {
          markers: [
            {
              atT: 0.5,
              shooterId: 'b1',
              mode: 'SOLO',
              participantIds: [],
              targetUnitId: 'cap',
            },
          ],
        },
      },
    ]);
    const cap = r.state.units.find((u) => u.id === 'cap')!;
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    // Both stopped roughly halfway (interrupt at t=0.5).
    expect(cap.position.x).toBeLessThan(200);
    expect(cap.position.x).toBeGreaterThan(50);
    expect(a1.position.x).toBeLessThan(220);
    expect(a1.position.x).toBeGreaterThan(50);
    // Reaction hit causes turnover.
    expect(r.state.initiative.holder).toBe('B');
  });

  it('ends activation without turnover when reactions miss', () => {
    const s0 = baseState([
      makeUnit({
        id: 'cap',
        faction: 'A',
        position: v2(0, 0),
        traits: ['OFFICER'],
        quality: 1,
      }),
      makeUnit({ id: 'a1', faction: 'A', position: v2(20, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'cap' },
      {
        type: 'COMMAND_MOVE',
        officerId: 'cap',
        officerTarget: v2(50, 0),
        participants: [{ unitId: 'a1', target: v2(60, 0) }],
      },
    ]);
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.activeActivation).toBeNull();
  });
});

describe('COMMAND_RALLY', () => {
  it('officer + 1 ally both rally with officer quality', () => {
    const s0 = baseState([
      makeUnit({
        id: 'cap',
        faction: 'A',
        position: v2(0, 0),
        traits: ['OFFICER'],
        quality: 1, // always succeeds
        damage: 'IMPEDED',
      }),
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(20, 0),
        quality: 7, // would always fail solo
        damage: 'IMPEDED',
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'cap' },
      {
        type: 'COMMAND_RALLY',
        officerId: 'cap',
        participantIds: ['a1'],
      },
    ]);
    const cap = r.state.units.find((u) => u.id === 'cap')!;
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(cap.damage).toBe('NONE');
    expect(a1.damage).toBe('NONE'); // borrowed officer's q1+
    expect(r.state.initiative.activeActivation).toBeNull();
    expect(r.state.initiative.holder).toBe('A');
  });

  it('rejects ally outside 1 UD of officer', () => {
    const s0 = baseState([
      makeUnit({
        id: 'cap',
        faction: 'A',
        position: v2(0, 0),
        traits: ['OFFICER'],
        damage: 'IMPEDED',
      }),
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(500, 0),
        damage: 'IMPEDED',
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
    ]);
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'cap' },
        {
          type: 'COMMAND_RALLY',
          officerId: 'cap',
          participantIds: ['a1'],
        },
      ]),
    ).toThrow(/PARTICIPANT_TOO_FAR/);
  });

  it('failed rally checks do not cause turnover (FORCED_END)', () => {
    const s0: GameState = {
      ...baseState([
        makeUnit({
          id: 'cap',
          faction: 'A',
          position: v2(0, 0),
          traits: ['OFFICER'],
          quality: 7, // always fails
          damage: 'IMPEDED',
        }),
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(20, 0),
          quality: 3,
          damage: 'IMPEDED',
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
      ]),
      initiative: {
        holder: 'A',
        momentum: { A: 99, B: 0 },
        cycle: 1,
        activeActivation: null,
      },
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'cap' },
      {
        type: 'COMMAND_RALLY',
        officerId: 'cap',
        participantIds: ['a1'],
      },
    ]);
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.activeActivation).toBeNull();
  });
});
