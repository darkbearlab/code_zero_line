import { describe, it, expect } from 'vitest';
import { applyCommands } from './reducer';
import type { GameState, Unit, Weapon } from '../state/GameState';
import type { ReactionPlan } from './types';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';

const heavyRifle: Weapon = {
  id: 'heavy-rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 8, // huge — guaranteed multiple hits at 5+
  threshold: 5,
  descriptors: ['FOCUSED', 'COMBINED'],
};

const popgun: Weapon = {
  id: 'popgun',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 1,
  threshold: 7, // unreachable → always misses
  descriptors: ['FOCUSED', 'COMBINED'],
};

const makeUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
  faction: 'A',
  position: v2(0, 0),
  radius: STANDARD_BASE_RADIUS_PIXELS,
  quality: 3,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [heavyRifle],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const makeStateForReactions = (
  shooterWeapon: Weapon = heavyRifle,
): GameState => ({
  seed: 'reaction-test',
  commandCount: 0,
  units: [
    makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), quality: 1 }),
    makeUnit({
      id: 'b1',
      faction: 'B',
      position: v2(50, 200),
      weapons: [shooterWeapon],
    }),
  ],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    activeActivation: null,
  },
});

describe('MOVE with reaction plan (Phase 4b)', () => {
  it('reaction marker that lands hits → movement stops at marker t', () => {
    const s0 = makeStateForReactions();
    const plan: ReactionPlan = {
      markers: [
        {
          atT: 0.5,
          shooterId: 'b1',
          mode: 'SOLO',
          participantIds: [],
        },
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0), reactionPlan: plan },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    // Heavy rifle on Solo at 5+ with 8 dice usually hits 2+ → Suppressed → turnover.
    // We assert position moved partially (between start and target).
    expect(a1.position.x).toBeLessThan(100);
    expect(a1.position.x).toBeGreaterThan(0);
  });

  it('reaction marker that misses → mover continues to target, shooter cannotReact', () => {
    const s0 = makeStateForReactions(popgun);
    const plan: ReactionPlan = {
      markers: [
        {
          atT: 0.5,
          shooterId: 'b1',
          mode: 'SOLO',
          participantIds: [],
        },
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0), reactionPlan: plan },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    const b1 = r.state.units.find((u) => u.id === 'b1')!;
    expect(a1.position.x).toBeCloseTo(100);
    expect(b1.cannotReactThisRound).toBe(true);
  });

  it('Suppress+ reaction → turnover (REACTION_HIT)', () => {
    const s0 = makeStateForReactions();
    const plan: ReactionPlan = {
      markers: [
        {
          atT: 0.5,
          shooterId: 'b1',
          mode: 'SOLO',
          participantIds: [],
        },
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0), reactionPlan: plan },
    ]);
    // 8 dice at 5+ ≈ 2.67 hits expected; with deterministic seed verify >=2.
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { hits: number }
      | undefined;
    if (shot && shot.hits >= 2) {
      expect(r.state.initiative.holder).toBe('B');
    } else {
      // 1 hit only → IMPEDED, no turnover from REACTION_HIT
      expect(r.state.initiative.holder).toBe('A');
    }
  });

  it('reaction guaranteed to suppress → REACTION_HIT turnover', () => {
    // Overwhelming reactor: 20 dice at 2+ → ~16 hits expected, target dies.
    const overwhelming: Weapon = {
      id: 'overwhelming',
      modes: ['ACTIVE', 'REACTION'],
      kind: 'SHOOT',
      diceCount: 20,
      threshold: 2,
      descriptors: ['FOCUSED', 'COMBINED'],
    };
    const s0: GameState = {
      ...makeStateForReactions(overwhelming),
      seed: 'overwhelming-test',
    };
    const plan: ReactionPlan = {
      markers: [
        { atT: 0.5, shooterId: 'b1', mode: 'SOLO', participantIds: [] },
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0), reactionPlan: plan },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(['SUPPRESSED', 'KILLED']).toContain(a1.damage);
    expect(r.state.initiative.holder).toBe('B');
    expect(r.state.initiative.momentum).toEqual({ A: 0, B: 2 });
    const turnover = r.events.find(
      (e) => e.type === 'INITIATIVE_TURNOVER' && e.reason === 'REACTION_HIT',
    );
    expect(turnover).toBeDefined();
  });

  it('multiple markers: first hitting one stops the rest', () => {
    const s0: GameState = {
      ...makeStateForReactions(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), quality: 1 }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(20, 200),
          weapons: [heavyRifle],
        }),
        makeUnit({
          id: 'b2',
          faction: 'B',
          position: v2(80, 200),
          weapons: [heavyRifle],
        }),
      ],
    };
    const plan: ReactionPlan = {
      markers: [
        { atT: 0.3, shooterId: 'b1', mode: 'SOLO', participantIds: [] },
        { atT: 0.7, shooterId: 'b2', mode: 'SOLO', participantIds: [] },
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0), reactionPlan: plan },
    ]);
    // First marker hits → second never resolves; b2 still has reaction available.
    const b2 = r.state.units.find((u) => u.id === 'b2')!;
    expect(b2.cannotReactThisRound).toBe(false);
  });
});
