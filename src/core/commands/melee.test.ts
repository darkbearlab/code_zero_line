import { describe, it, expect } from 'vitest';
import { applyCommands } from './reducer';
import type { GameState, Unit, Weapon } from '../state/GameState';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';

const blade: Weapon = {
  id: 'blade',
  modes: ['ACTIVE'],
  kind: 'MELEE',
  diceCount: 3,
  threshold: 5,
  descriptors: [],
};

const heavyBlade: Weapon = {
  id: 'heavy-blade',
  modes: ['ACTIVE'],
  kind: 'MELEE',
  diceCount: 8,
  threshold: 5,
  descriptors: [],
};

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 3,
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
  weapons: [rifle, blade],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const inContact = (other: Unit) => ({
  position: v2(other.position.x + STANDARD_BASE_RADIUS_PIXELS * 2, other.position.y),
});

describe('MELEE command', () => {
  const baseState = (
    aWeapon: Weapon = blade,
    dWeapon: Weapon = blade,
  ): GameState => {
    const a = makeUnit({
      id: 'a1',
      faction: 'A',
      position: v2(0, 0),
      weapons: [rifle, aWeapon],
      quality: 1,
    });
    const d = makeUnit({
      id: 'b1',
      faction: 'B',
      ...inContact(a),
      weapons: [rifle, dWeapon],
    });
    return {
      seed: 'melee-test',
      commandCount: 0,
      units: [a, d],
      terrain: [],
      initiative: {
        holder: 'A',
        momentum: { A: 5, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: null,
      },
    };
  };

  it('attacker with overwhelming pool wins; defender dies', () => {
    const s0 = baseState(heavyBlade, blade);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MELEE', attackerId: 'a1', defenderId: 'b1' },
    ]);
    const event = r.events.find((e) => e.type === 'MELEE_RESOLVED') as
      | { winnerId: string; loserId: string }
      | undefined;
    expect(event?.winnerId).toBe('a1');
    expect(event?.loserId).toBe('b1');
    const b1 = r.state.units.find((u) => u.id === 'b1')!;
    expect(b1.damage).toBe('KILLED');
  });

  it('charging attacker loses → MELEE_LOSS turnover', () => {
    const s0 = baseState(blade, heavyBlade); // defender far stronger
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MELEE', attackerId: 'a1', defenderId: 'b1', isCharging: true },
    ]);
    expect(r.state.initiative.holder).toBe('B');
    expect(
      r.events.find(
        (e) => e.type === 'INITIATIVE_TURNOVER' && e.reason === 'MELEE_LOSS',
      ),
    ).toBeDefined();
  });

  it('throws when units are not in base contact', () => {
    const s0 = baseState();
    const farAttacker: GameState = {
      ...s0,
      units: [
        { ...s0.units[0]!, position: v2(0, 0) },
        { ...s0.units[1]!, position: v2(500, 0) },
      ],
    };
    expect(() =>
      applyCommands(farAttacker, [
        { type: 'ACTIVATE_SPEND', unitId: 'a1' },
        { type: 'MELEE', attackerId: 'a1', defenderId: 'b1' },
      ]),
    ).toThrow(/NOT_IN_CONTACT/);
  });

  it('charge bonus +1 die appears in event', () => {
    const s0 = baseState();
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MELEE', attackerId: 'a1', defenderId: 'b1', isCharging: true },
    ]);
    const event = r.events.find((e) => e.type === 'MELEE_RESOLVED') as
      | { attackerDice: number; defenderDice: number }
      | undefined;
    // Attacker: 3 base + 1 charge = 4. Defender: 3 base = 3.
    expect(event?.attackerDice).toBe(4);
    expect(event?.defenderDice).toBe(3);
  });

  it('STALWART trait ignores Impeded melee penalty', () => {
    const s0 = baseState();
    const stalwartAttacker: GameState = {
      ...s0,
      units: [
        { ...s0.units[0]!, damage: 'IMPEDED', traits: ['STALWART'] },
        s0.units[1]!,
      ],
    };
    const r = applyCommands(stalwartAttacker, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MELEE', attackerId: 'a1', defenderId: 'b1' },
    ]);
    const event = r.events.find((e) => e.type === 'MELEE_RESOLVED') as
      | { attackerDice: number }
      | undefined;
    // 3 + 1 charge = 4 (no Impeded penalty thanks to STALWART).
    expect(event?.attackerDice).toBe(4);
  });
});
