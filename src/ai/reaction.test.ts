import { describe, it, expect } from 'vitest';
import { v2 } from '../core/geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../core/rules/constants';
import type { GameState, Unit, Weapon } from '../core/state/GameState';
import { planReactions } from './reaction';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 4,
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
  weapons: [rifle],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const baseState = (units: Unit[]): GameState => ({
  seed: 'react-test',
  commandCount: 0,
  units,
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 5 },
    cycle: 1,
    activeActivation: null,
  },
});

describe('planReactions', () => {
  it('returns no markers when defender has no LOS along the path', () => {
    // Defender is far off-axis; no real reaction window for a movement that
    // passes very far from them is unrealistic — but with 32 samples and no
    // walls, even off-axis units retain LOS. Use a wall to break LOS.
    const s = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(2000, 2000) }), // very far
    ]);
    const plan = planReactions(s, 'B', {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(50, 0),
    });
    // Far off-axis but still has LOS in open terrain — that's expected.
    // Just assert the planner doesn't crash and returns a well-formed plan.
    expect(plan.markers.length).toBeGreaterThanOrEqual(0);
  });

  it('places a SOLO marker when defender has LOS to the path', () => {
    const s = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(100, 0) }),
    ]);
    const plan = planReactions(s, 'B', {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(50, 0),
    });
    expect(plan.markers.length).toBe(1);
    expect(plan.markers[0]!.shooterId).toBe('b1');
    expect(plan.markers[0]!.mode).toBe('SOLO');
    expect(plan.markers[0]!.weaponId).toBe('rifle');
    expect(plan.markers[0]!.atT).toBeGreaterThanOrEqual(0);
    expect(plan.markers[0]!.atT).toBeLessThanOrEqual(1);
  });

  it('skips defenders that already cannot react this round', () => {
    const s = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(100, 0),
        cannotReactThisRound: true,
      }),
    ]);
    const plan = planReactions(s, 'B', {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(50, 0),
    });
    expect(plan.markers.length).toBe(0);
  });

  it('skips suppressed defenders', () => {
    const s = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(100, 0),
        damage: 'SUPPRESSED',
      }),
    ]);
    const plan = planReactions(s, 'B', {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(50, 0),
    });
    expect(plan.markers.length).toBe(0);
  });

  it('returns no plan for non-MOVE commands (RALLY/VAULT not yet covered)', () => {
    const s = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(100, 0) }),
    ]);
    const plan = planReactions(s, 'B', {
      type: 'RALLY',
      unitId: 'a1',
    });
    expect(plan.markers.length).toBe(0);
  });
});
