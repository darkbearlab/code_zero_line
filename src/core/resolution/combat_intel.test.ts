import { describe, it, expect } from 'vitest';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type { GameState, Unit, Weapon } from '../state/GameState';
import { applyCommands } from '../commands/reducer';
import { EMPTY_COMBAT_INTEL, resolveCombatIntelLevel } from './combat_intel';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 4,
  threshold: 5,
  descriptors: [],
};

const blade: Weapon = {
  id: 'blade',
  modes: ['ACTIVE'],
  kind: 'MELEE',
  diceCount: 3,
  threshold: 4,
  descriptors: [],
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

const baseState = (units: Unit[]): GameState => ({
  seed: 'intel-test',
  commandCount: 0,
  units,
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 99, B: 99 },
    round: 1,
    activeActivation: null,
  },
});

describe('resolveCombatIntelLevel', () => {
  const target = makeUnit({ id: 't', traits: ['INFANTRY', 'HEAVY'] });

  it('returns 0 when levels missing', () => {
    expect(resolveCombatIntelLevel(target, undefined, 'shoot')).toBe(0);
    expect(resolveCombatIntelLevel(target, EMPTY_COMBAT_INTEL, 'shoot')).toBe(0);
  });

  it('returns the highest level among matching tags (MAX rule)', () => {
    const levels = {
      shoot: { INFANTRY: 3, HEAVY: 2 },
      melee: {},
    };
    expect(resolveCombatIntelLevel(target, levels, 'shoot')).toBe(3);
  });

  it('different tracks have independent levels', () => {
    const levels = {
      shoot: { INFANTRY: 5 },
      melee: { INFANTRY: 1 },
    };
    expect(resolveCombatIntelLevel(target, levels, 'shoot')).toBe(5);
    expect(resolveCombatIntelLevel(target, levels, 'melee')).toBe(1);
  });

  it('returns 0 for unknown tags', () => {
    const levels = {
      shoot: { CYBORG: 4 },
      melee: {},
    };
    // target has INFANTRY + HEAVY only; CYBORG level doesn't apply
    expect(resolveCombatIntelLevel(target, levels, 'shoot')).toBe(0);
  });

  it('gates on attackerFaction — only A benefits', () => {
    const levels = { shoot: { INFANTRY: 3 }, melee: {} };
    expect(resolveCombatIntelLevel(target, levels, 'shoot', 'A')).toBe(3);
    expect(resolveCombatIntelLevel(target, levels, 'shoot', 'B')).toBe(0);
    // omitted faction = passthrough
    expect(resolveCombatIntelLevel(target, levels, 'shoot')).toBe(3);
  });
});

describe('GameState.combatIntel applied at resolveShot', () => {
  it('shifts SHOT_RESOLVED rolls / hits when level > 0', () => {
    // 4d 5+ vs INFANTRY target. Level 4 → all dice drop to 4+.
    // Compare hit count between baseline and intel'd states.
    const targetBase = makeUnit({
      id: 'b1',
      faction: 'B',
      position: v2(60, 0),
      traits: ['INFANTRY'],
    });
    const shooter = makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) });
    const baseline: GameState = baseState([shooter, targetBase]);
    const buffed: GameState = {
      ...baseline,
      combatIntel: { shoot: { INFANTRY: 4 }, melee: {} },
    };
    const cmd = [
      { type: 'ACTIVATE_SPEND' as const, unitId: 'a1' },
      {
        type: 'SHOOT' as const,
        mode: 'SOLO' as const,
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'rifle',
        participantIds: ['a1'],
      },
    ];
    const baseR = applyCommands(baseline, cmd);
    const buffR = applyCommands(buffed, cmd);
    const baseShot = baseR.events.find((e) => e.type === 'SHOT_RESOLVED');
    const buffShot = buffR.events.find((e) => e.type === 'SHOT_RESOLVED');
    if (
      baseShot?.type !== 'SHOT_RESOLVED' ||
      buffShot?.type !== 'SHOT_RESOLVED'
    ) {
      throw new Error('Expected SHOT_RESOLVED in both runs');
    }
    // Same rolls (deterministic seed), but the buffed run counts hits at
    // the lower threshold so hits should be ≥ baseline.
    expect(buffShot.hits).toBeGreaterThanOrEqual(baseShot.hits);
  });

  it('does NOT apply when shooter is faction B (enemy)', () => {
    const targetA = makeUnit({
      id: 'a1',
      faction: 'A',
      position: v2(0, 0),
      traits: ['INFANTRY'],
    });
    const shooterB = makeUnit({ id: 'b1', faction: 'B', position: v2(60, 0) });
    const stateBase: GameState = {
      ...baseState([targetA, shooterB]),
      initiative: {
        holder: 'B',
        momentum: { A: 99, B: 99 },
        round: 1,
        activeActivation: null,
      },
    };
    // Even with an INFANTRY=5 buff for shoot, faction B's shot at A
    // shouldn't pick it up — the gate on attackerFaction === 'A'
    // returns 0 for B-side shooters.
    const buffed: GameState = {
      ...stateBase,
      combatIntel: { shoot: { INFANTRY: 5 }, melee: {} },
    };
    const cmd = [
      { type: 'ACTIVATE_SPEND' as const, unitId: 'b1' },
      {
        type: 'SHOOT' as const,
        mode: 'SOLO' as const,
        shooterId: 'b1',
        targetId: 'a1',
        weaponId: 'rifle',
        participantIds: ['b1'],
      },
    ];
    const baseR = applyCommands(stateBase, cmd);
    const buffR = applyCommands(buffed, cmd);
    const baseShot = baseR.events.find((e) => e.type === 'SHOT_RESOLVED');
    const buffShot = buffR.events.find((e) => e.type === 'SHOT_RESOLVED');
    if (
      baseShot?.type !== 'SHOT_RESOLVED' ||
      buffShot?.type !== 'SHOT_RESOLVED'
    ) {
      throw new Error('Expected SHOT_RESOLVED in both runs');
    }
    expect(buffShot.hits).toBe(baseShot.hits);
  });
});
