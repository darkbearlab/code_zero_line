/**
 * Stage 4 — stealth-state patrol behaviour.
 *
 * Patrol fires at the same trigger windows as IMPULSIVE (failed
 * activation check + post-turnover hook), but the action is always
 * "1-UD step toward the nearest POI" with NO shoot evaluation. When
 * no POI exists, patrol is a complete no-op (does NOT burn the unit's
 * round slot — the design rationale is that silent players should
 * never lose tempo via wasted enemy patrols).
 */
import { describe, expect, it } from 'vitest';
import { applyCommands } from './reducer';
import type {
  GameState,
  PoiMark,
  Unit,
  Weapon,
} from '../state/GameState';
import { v2 } from '../geometry/vec2';
import {
  STANDARD_BASE_RADIUS_PIXELS,
  UNIT_DISTANCE_PIXELS,
} from '../rules/constants';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 4,
  threshold: 4,
  descriptors: [],
};

const u = (overrides: Partial<Unit> & { id: string }): Unit => ({
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

const poi = (x: number, y: number): PoiMark => ({
  position: v2(x, y),
  createdCycle: 1,
  cause: 'SHOOT',
  expiresAtCycle: 5,
});

const baseState = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'patrol-test',
  commandCount: 0,
  units: [],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    playerActivations: 0,
    activeActivation: null,
  },
  ...overrides,
});

describe('Stage 4 — patrol on TURNOVER', () => {
  it('stealth on + NO POIs → enemy does nothing, slot not consumed', () => {
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(
      r.events.find((e) => e.type === 'PATROL_TRIGGERED'),
    ).toBeUndefined();
    expect(r.events.find((e) => e.type === 'MOVE_RESOLVED')).toBeUndefined();
    const b1 = r.state.units.find((x) => x.id === 'b1')!;
    expect(b1.activatedThisRound).toBe(false);
    expect(b1.position).toEqual(v2(500, 0));
  });

  it('stealth on + 1 POI → enemy patrols toward it (~1UD step)', () => {
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
      stealth: { active: true, pois: [poi(0, 0)] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    const triggered = r.events.find((e) => e.type === 'PATROL_TRIGGERED');
    expect(triggered).toMatchObject({ unitId: 'b1', reason: 'TURNOVER' });
    const b1 = r.state.units.find((x) => x.id === 'b1')!;
    expect(b1.activatedThisRound).toBe(true);
    // Moved toward POI (which is to the LEFT of starting position).
    expect(b1.position.x).toBeLessThan(500);
    // Step is roughly 1UD; allow some slack for path stop / collision.
    const dx = 500 - b1.position.x;
    expect(dx).toBeGreaterThan(0);
    expect(dx).toBeLessThanOrEqual(UNIT_DISTANCE_PIXELS + 1);
  });

  it('stealth on + IMPULSIVE_AGGRESSIVE enemy + POI → patrols, does not aggress', () => {
    // b1 has IMPULSIVE_AGGRESSIVE which would normally fire on TURNOVER
    // (Trigger 2). With stealth on, b1 is the *incoming* side and so
    // IMPULSIVE doesn't fire anyway — but we verify patrol fires instead
    // (PATROL_TRIGGERED present, IMPULSIVE_TRIGGERED absent).
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({
          id: 'b1',
          faction: 'B',
          position: v2(500, 0),
          traits: ['IMPULSIVE_AGGRESSIVE'],
        }),
      ],
      stealth: { active: true, pois: [poi(0, 0)] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(r.events.find((e) => e.type === 'PATROL_TRIGGERED')).toBeDefined();
    expect(
      r.events.find((e) => e.type === 'IMPULSIVE_TRIGGERED'),
    ).toBeUndefined();
  });

  it('stealth on + suppressed enemy → no patrol (cannot move)', () => {
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({
          id: 'b1',
          faction: 'B',
          position: v2(500, 0),
          damage: 'SUPPRESSED',
        }),
      ],
      stealth: { active: true, pois: [poi(0, 0)] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(
      r.events.find((e) => e.type === 'PATROL_TRIGGERED'),
    ).toBeUndefined();
  });

  it('stealth OFF + POI present → no patrol (regression: stealth gate works)', () => {
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
      stealth: { active: false, pois: [poi(0, 0)] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(
      r.events.find((e) => e.type === 'PATROL_TRIGGERED'),
    ).toBeUndefined();
  });

  it('multiple enemy units patrol in units-array order', () => {
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({ id: 'b1', faction: 'B', position: v2(500, 0) }),
        u({ id: 'b2', faction: 'B', position: v2(500, 200) }),
      ],
      stealth: { active: true, pois: [poi(0, 0)] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    const triggered = r.events
      .filter((e) => e.type === 'PATROL_TRIGGERED')
      .map((e) => (e as { unitId: string }).unitId);
    expect(triggered).toEqual(['b1', 'b2']);
  });

  it('does NOT patrol B when initiative goes B→A (only fires on A→B swap)', () => {
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
      initiative: {
        holder: 'B',
        momentum: { A: 0, B: 5 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: null,
      },
      stealth: { active: true, pois: [poi(0, 0)] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(
      r.events.find((e) => e.type === 'PATROL_TRIGGERED'),
    ).toBeUndefined();
  });
});
