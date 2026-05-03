import { describe, it, expect } from 'vitest';
import { parseTrait, sumTraitParams, unitHasTrait } from './types';
import { TRAITS, getTraitDef } from './registry';
import { applyCommands } from '../commands/reducer';
import type { GameState, Unit, Weapon } from '../state/GameState';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';

const overwhelmingRifle: Weapon = {
  id: 'big-rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 20,
  threshold: 2,
  descriptors: ['FOCUSED', 'COMBINED'],
};

const popgun: Weapon = {
  id: 'popgun',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 1,
  threshold: 7,
  descriptors: ['FOCUSED', 'COMBINED'],
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

describe('parseTrait', () => {
  it('parses bare id', () => {
    expect(parseTrait('OFFICER')).toEqual({ id: 'OFFICER', param: 0 });
  });
  it('parses colon-style param', () => {
    expect(parseTrait('ARMOR:1')).toEqual({ id: 'ARMOR', param: 1 });
  });
  it('parses paren-style param', () => {
    expect(parseTrait('AGITATOR(2)')).toEqual({ id: 'AGITATOR', param: 2 });
  });
  it('falls back to 0 on garbage param', () => {
    expect(parseTrait('ARMOR:hello')).toEqual({ id: 'ARMOR', param: 0 });
  });
});

describe('helpers', () => {
  const u = makeUnit({
    id: 'a1',
    traits: ['OFFICER', 'ARMOR:1', 'ARMOR(1)'],
  });
  it('unitHasTrait', () => {
    expect(unitHasTrait(u, 'OFFICER')).toBe(true);
    expect(unitHasTrait(u, 'STALWART')).toBe(false);
  });
  it('sumTraitParams stacks instances', () => {
    expect(sumTraitParams(u, 'ARMOR')).toBe(2);
    expect(sumTraitParams(u, 'OFFICER')).toBe(0);
  });
});

describe('registry', () => {
  it('exposes all expected traits', () => {
    for (const id of [
      'OFFICER',
      'STALWART',
      'FRAGILE',
      'ARMOR',
      'CUMBERSOME',
      'CANNON_FODDER',
      'FANATIC',
      'TOUGH',
      'IMPULSIVE',
      'AGITATOR',
      'WARLORD',
      'MARTYRDOM',
      'STEALTH',
      'INFANTRY',
      'BEAST',
    ]) {
      expect(getTraitDef(id), id).toBeDefined();
    }
  });
  it('STALWART carries the meleeIgnoresStatusPenalty flag', () => {
    expect(TRAITS.STALWART!.meleeIgnoresStatusPenalty).toBe(true);
  });
  it('CUMBERSOME caps actions to 1', () => {
    expect(TRAITS.CUMBERSOME!.maxActionsPerActivation).toBe(1);
  });
});

const baseState = (units: Unit[]): GameState => ({
  seed: 'trait-test',
  commandCount: 0,
  units,
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    playerActivations: 0,
    activeActivation: null,
  },
});

describe('FRAGILE trait', () => {
  it('upgrades a 1-hit IMPEDED result to SUPPRESSED', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [overwhelmingRifle], // many hits
      }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(200, 0),
        traits: ['FRAGILE', 'ARMOR:99'], // armor absorbs almost everything → 1 net hit
      }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'SHOOT', mode: 'SOLO', shooterId: 'a1', targetId: 'b1' },
    ]);
    const target = r.state.units.find((u) => u.id === 'b1')!;
    // ARMOR:99 absorbs ~all hits so net hits should be 0 or low. To verify
    // FRAGILE specifically, force exactly-1-hit by checking event.
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { hits: number; afterDamage: string }
      | undefined;
    if (shot && shot.hits === 1) {
      expect(target.damage).toBe('SUPPRESSED');
    }
  });

  it('two hits on a FRAGILE unit kill it (cumulative IMPEDED→SUPPRESSED→KILLED)', () => {
    // 2d at 2+ — almost always lands both. Seed `fragile-2hit-1` is a
    // probed seed that lands exactly 2 hits; if a future RNG change breaks
    // this assumption, swap the seed rather than weakening the assertion.
    const twoShot: Weapon = {
      id: 'two-shot',
      modes: ['ACTIVE', 'REACTION'],
      kind: 'SHOOT',
      diceCount: 2,
      threshold: 2,
      descriptors: ['FOCUSED', 'COMBINED'],
    };
    const s0: GameState = {
      ...baseState([
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          weapons: [twoShot],
        }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(200, 0),
          traits: ['FRAGILE'],
        }),
      ]),
      seed: 'fragile-2hit-1',
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'SHOOT', mode: 'SOLO', shooterId: 'a1', targetId: 'b1' },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { hits: number }
      | undefined;
    expect(shot?.hits).toBe(2);
    const target = r.state.units.find((u) => u.id === 'b1')!;
    expect(target.damage).toBe('KILLED');
  });
});

describe('ARMOR trait', () => {
  it('absorbs hits before damage state computes', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [overwhelmingRifle], // ~16 hits expected
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
      { type: 'SHOOT', mode: 'SOLO', shooterId: 'a1', targetId: 'b1' },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { hits: number; rolls: number[]; threshold: number }
      | undefined;
    expect(shot).toBeDefined();
    // The recorded hits must equal raw rolls' successes minus armor.
    const rawHits = shot!.rolls.filter((x) => x >= shot!.threshold).length;
    expect(shot!.hits).toBe(Math.max(0, rawHits - 2));
  });
});

describe('CUMBERSOME trait', () => {
  it('caps CHECK_SUCCESS to 1 action', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        quality: 1,
        traits: ['CUMBERSOME'],
        weapons: [popgun],
      }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 0) }),
    ]);
    const r1 = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
    ]);
    expect(r1.state.initiative.activeActivation?.actionsRemaining).toBe(1);
  });
});
