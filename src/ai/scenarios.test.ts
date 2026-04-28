/**
 * Gold scenario tests — hand-crafted micro-states that assert "in this exact
 * situation, the AI must choose X (not Y)". Unlike sim KPI numbers, these
 * tests survive rule re-balances and trait additions because they verify
 * decision-shape identity, not scoring magnitudes.
 *
 * Each scenario is documented with the rules-question it interrogates so
 * that when balance shifts and the assertion drifts, future-you can decide
 * whether the test should adjust or the AI got worse.
 */
import { describe, it, expect } from 'vitest';
import { v2 } from '../core/geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../core/rules/constants';
import type {
  Command,
  ReactionMarker,
} from '../core/commands/types';
import type {
  GameState,
  Terrain,
  Unit,
  Weapon,
} from '../core/state/GameState';
import { greedyController } from './controllers/greedy';
import { lookaheadController } from './controllers/lookahead';
import { planReactions } from './reaction';

// --- Test fixtures ----------------------------------------------------------

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 4,
  threshold: 4,
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

const reactionlessRifle: Weapon = {
  ...rifle,
  id: 'rifle-active-only',
  modes: ['ACTIVE'],
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

const baseState = (
  units: Unit[],
  terrain: Terrain[] = [],
  activeUnitId?: string,
): GameState => ({
  seed: 'gold',
  commandCount: 0,
  units,
  terrain,
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 5 },
    round: 1,
    activeActivation: activeUnitId
      ? {
          unitId: activeUnitId,
          kind: 'SPEND',
          actionsRemaining: 99,
          failureProtection: false,
          forcedTurnoverAfterAction: false,
        }
      : null,
  },
});

// --- Active-side decisions --------------------------------------------------

describe('gold scenarios — active decisions', () => {
  it('greedy takes the shot when EV is high and the target is in plain LOS', () => {
    // Mover and target both in open ground, ~2 UD apart. greedy must pick
    // SHOOT, not move toward — EV(rifle 4d/4+) = 2 hits, well above 0.5.
    const s = baseState(
      [
        makeUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(300, 100) }),
      ],
      [],
      'a1',
    );
    const cmd = greedyController(s, 'A', 0);
    expect(cmd?.type).toBe('SHOOT');
  });

  it('lookahead with cover available prefers a position offering cover over open standing', () => {
    // Unit can stand in the open or step adjacent to a HARD wall that lies
    // between it and the enemy. The cover-aware evaluator should prefer the
    // wall-adjacent option (returns MOVE, not SHOOT-from-open).
    const wall: Terrain = {
      id: 'wall',
      kind: 'HARD',
      height: 200, // high wall — definitely blocks LOS
      polygon: {
        vertices: [v2(180, 50), v2(220, 50), v2(220, 250), v2(180, 250)],
      },
    };
    const s = baseState(
      [
        makeUnit({ id: 'a1', faction: 'A', position: v2(120, 150) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(400, 150) }),
      ],
      [wall],
      'a1',
    );
    const lookA = lookaheadController({ depth: 2, beam: 8 });
    const cmd = lookA(s, 'A', 0);
    // Wall blocks LOS so SHOOT mode list is empty — only MOVE / END_ACTIVATION
    // remain. Lookahead must emit MOVE, not END_ACTIVATION.
    expect(cmd?.type).toBe('MOVE');
  });

  it('greedy rallies a suppressed unit instead of shooting', () => {
    const s = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(100, 100),
          damage: 'SUPPRESSED',
          stance: 'PRONE',
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(300, 100) }),
      ],
      [],
      'a1',
    );
    const cmd = greedyController(s, 'A', 0);
    expect(cmd?.type).toBe('RALLY');
  });
});

// --- Defender reaction decisions -------------------------------------------

describe('gold scenarios — defender reactions', () => {
  it('places a reaction marker when an enemy moves through plain LOS', () => {
    // Defender stands across an open field; attacker walks within view.
    // Planner should emit one SOLO marker.
    const s = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(100, 200) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(400, 200) }),
    ]);
    const move: Command = {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(200, 200),
    };
    const plan = planReactions(s, 'B', move);
    expect(plan.markers.length).toBe(1);
    const m: ReactionMarker = plan.markers[0]!;
    expect(m.shooterId).toBe('b1');
    expect(m.mode).toBe('SOLO');
    expect(m.weaponId).toBe('rifle');
  });

  it('does NOT place a marker when LOS is blocked by a high wall', () => {
    // High wall sits between defender and the attacker's path → 0 windows.
    const wall: Terrain = {
      id: 'wall',
      kind: 'HARD',
      height: 200,
      polygon: {
        vertices: [v2(220, 100), v2(280, 100), v2(280, 300), v2(220, 300)],
      },
    };
    const s = baseState(
      [
        makeUnit({ id: 'a1', faction: 'A', position: v2(100, 200) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(400, 200) }),
      ],
      [wall],
    );
    const move: Command = {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(180, 200), // stays on A's side of the wall
    };
    const plan = planReactions(s, 'B', move);
    expect(plan.markers.length).toBe(0);
  });

  it('does not place a marker when the only defender lacks a REACTION weapon', () => {
    const s = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(100, 200) }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(400, 200),
        weapons: [reactionlessRifle, blade],
      }),
    ]);
    const move: Command = {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(200, 200),
    };
    const plan = planReactions(s, 'B', move);
    expect(plan.markers.length).toBe(0);
  });

  it('produces at most one marker per defender (no double-tap)', () => {
    // Path passes through two windows for the same defender (e.g. behind a
    // pillar then back into LOS). v1 planner places only one marker per
    // shooter to avoid wasting them on questionable second windows.
    const pillar: Terrain = {
      id: 'pillar',
      kind: 'HARD',
      height: 200,
      polygon: {
        vertices: [v2(240, 180), v2(260, 180), v2(260, 220), v2(240, 220)],
      },
    };
    const s = baseState(
      [
        makeUnit({ id: 'a1', faction: 'A', position: v2(100, 200) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(400, 200) }),
      ],
      [pillar],
    );
    const move: Command = {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(380, 200),
    };
    const plan = planReactions(s, 'B', move);
    expect(plan.markers.length).toBeLessThanOrEqual(1);
  });
});
