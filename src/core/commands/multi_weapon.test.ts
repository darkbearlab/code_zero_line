import { describe, it, expect } from 'vitest';
import { applyCommand, applyCommands } from './reducer';
import { listAvailableShootModes } from '../resolution/shoot_modes';
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

const rpg: Weapon = {
  id: 'rpg',
  modes: ['ACTIVE'],
  kind: 'SHOOT',
  diceCount: 5,
  threshold: 5,
  descriptors: ['ARMOR_PIERCE:2', 'RELOAD'],
};

const overwhelming: Weapon = {
  id: 'overwhelming',
  modes: ['ACTIVE'],
  kind: 'SHOOT',
  diceCount: 20,
  threshold: 2,
  descriptors: [],
};

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

const baseState = (units: Unit[]): GameState => ({
  seed: 'multi-weapon',
  commandCount: 0,
  units,
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    round: 1,
    activeActivation: null,
  },
});

describe('listAvailableShootModes — per-weapon enumeration', () => {
  it('returns one entry per matching weapon × mode', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [rifle, rpg],
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
    ]);
    const modes = listAvailableShootModes(s0, 'a1', 'b1', 'ACTIVE');
    // SOLO entries: rifle + rpg = 2 (both are SOLO-capable)
    const soloIds = modes.filter((m) => m.mode === 'SOLO').map((m) => m.weaponId);
    expect(soloIds.sort()).toEqual(['rifle', 'rpg']);
  });
});

describe('SHOOT — weapon picker', () => {
  it('errors when shooter has multiple matching weapons but no weaponId', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [rifle, rpg],
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
    ]);
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() =>
      applyCommand(r1.state, {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
      }),
    ).toThrow(/MULTIPLE_WEAPONS/);
  });

  it('uses the explicitly chosen weaponId', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [rifle, rpg],
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'rpg',
      },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { diceCount: number; threshold: number }
      | undefined;
    expect(shot?.diceCount).toBe(5); // rpg dice
    expect(shot?.threshold).toBe(5);
  });
});

describe('ARMOR_PIERCE descriptor', () => {
  it('reduces target ARMOR before damage applies', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [overwhelming],
      }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(200, 0),
        traits: ['ARMOR:2'],
      }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'overwhelming',
      },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { hits: number; rolls: number[]; threshold: number }
      | undefined;
    const rawHits = shot!.rolls.filter((x) => x >= shot!.threshold).length;
    // No piercing: hits = max(0, raw - 2). Verify baseline.
    expect(shot!.hits).toBe(Math.max(0, rawHits - 2));
  });

  it("ARMOR_PIERCE:2 cancels target's ARMOR:2 fully", () => {
    const piercer: Weapon = {
      id: 'piercer',
      modes: ['ACTIVE'],
      kind: 'SHOOT',
      diceCount: 20,
      threshold: 2,
      descriptors: ['ARMOR_PIERCE:2'],
    };
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [piercer],
      }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(200, 0),
        traits: ['ARMOR:2'],
      }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'piercer',
      },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { hits: number; rolls: number[]; threshold: number }
      | undefined;
    const rawHits = shot!.rolls.filter((x) => x >= shot!.threshold).length;
    expect(shot!.hits).toBe(rawHits); // armor fully neutralized
  });
});

describe('RELOAD descriptor', () => {
  // RELOAD + lots of dice → guaranteed suppression of an unarmored target,
  // so the CHECK_SUCCESS activation persists and we can inspect weaponUsage.
  const overwhelmingRpg: Weapon = {
    id: 'rpg-mk2',
    modes: ['ACTIVE'],
    kind: 'SHOOT',
    diceCount: 20,
    threshold: 2,
    descriptors: ['RELOAD'],
  };

  it('records RELOAD weapon usage on the activation', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        quality: 1,
        weapons: [rifle, overwhelmingRpg],
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
    ]);
    const r1 = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'rpg-mk2',
      },
    ]);
    // Suppression keeps initiative on A; activation persists under CHECK_SUCCESS.
    expect(r1.state.initiative.holder).toBe('A');
    expect(
      r1.state.initiative.activeActivation?.weaponUsage?.a1,
    ).toContain('rpg-mk2');
  });

  it('filters used RELOAD weapons from listAvailableShootModes', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        quality: 1,
        weapons: [rifle, overwhelmingRpg],
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }), // dies
      makeUnit({ id: 'b2', faction: 'B', position: v2(220, 0) }), // alive
    ]);
    const r1 = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'rpg-mk2',
      },
    ]);
    // Query against the surviving target b2.
    const modes = listAvailableShootModes(r1.state, 'a1', 'b2', 'ACTIVE');
    expect(modes.some((m) => m.weaponId === 'rpg-mk2')).toBe(false);
    expect(modes.some((m) => m.weaponId === 'rifle')).toBe(true);
  });

  it('weaponUsage clears when activation ends', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        quality: 1,
        weapons: [overwhelmingRpg],
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }), // dies
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'rpg-mk2',
      },
      { type: 'END_ACTIVATION' },
    ]);
    // Activation cleared → weaponUsage gone.
    expect(r.state.initiative.activeActivation).toBeNull();
  });
});
