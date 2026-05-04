/**
 * Stage 2 — `effectiveLOS` clamps enemy→player sight to 1UD when the run
 * is in stealth state. Player→enemy and stealth-off paths must remain
 * pixel-identical to `hasLOS`.
 */
import { describe, expect, it } from 'vitest';
import { effectiveLOS } from './effective-los';
import { hasLOS } from './los';
import { v2 } from './vec2';
import {
  STANDARD_BASE_RADIUS_PIXELS,
  UNIT_DISTANCE_PIXELS,
} from '../rules/constants';
import type {
  GameState,
  Terrain,
  Unit,
  Weapon,
} from '../state/GameState';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 3,
  threshold: 5,
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

const state = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'los-test',
  commandCount: 0,
  units: [],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 0, B: 0 },
    cycle: 1,
    playerActivations: 0,
    activeActivation: null,
  },
  ...overrides,
});

const highWall = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Terrain => ({
  id,
  kind: 'HARD',
  height: 200,
  polygon: { vertices: [v2(x1, y1), v2(x2, y1), v2(x2, y2), v2(x1, y2)] },
});

describe('effectiveLOS — stealth off', () => {
  it('matches hasLOS exactly when stealth is undefined', () => {
    const a = u({ id: 'a1', faction: 'A', position: v2(0, 0) });
    const b = u({ id: 'b1', faction: 'B', position: v2(500, 0) });
    const s = state({ units: [a, b] });
    expect(effectiveLOS(b, a, s, s.terrain)).toBe(
      hasLOS(
        { center: b.position, radius: b.radius },
        { center: a.position, radius: a.radius },
        s.terrain,
      ),
    );
  });

  it('matches hasLOS when stealth.active === false', () => {
    const a = u({ id: 'a1', faction: 'A', position: v2(0, 0) });
    const b = u({ id: 'b1', faction: 'B', position: v2(500, 0) });
    const s = state({
      units: [a, b],
      stealth: { active: false, pois: [] },
    });
    expect(effectiveLOS(b, a, s, s.terrain)).toBe(true);
  });
});

describe('effectiveLOS — stealth on, enemy → player', () => {
  it('blocks at > 1UD even with clear geometric LOS', () => {
    const a = u({ id: 'a1', faction: 'A', position: v2(0, 0) });
    const b = u({
      id: 'b1',
      faction: 'B',
      position: v2(UNIT_DISTANCE_PIXELS * 1.5, 0),
    });
    const s = state({
      units: [a, b],
      stealth: { active: true, pois: [] },
    });
    expect(effectiveLOS(b, a, s, s.terrain)).toBe(false);
  });

  it('passes at ≤ 1UD with clear LOS', () => {
    const a = u({ id: 'a1', faction: 'A', position: v2(0, 0) });
    const b = u({
      id: 'b1',
      faction: 'B',
      position: v2(UNIT_DISTANCE_PIXELS * 0.8, 0),
    });
    const s = state({
      units: [a, b],
      stealth: { active: true, pois: [] },
    });
    expect(effectiveLOS(b, a, s, s.terrain)).toBe(true);
  });

  it('still blocked at ≤ 1UD when a high wall sits between', () => {
    const a = u({ id: 'a1', faction: 'A', position: v2(0, 0) });
    const b = u({
      id: 'b1',
      faction: 'B',
      position: v2(UNIT_DISTANCE_PIXELS * 0.8, 0),
    });
    const wallX = UNIT_DISTANCE_PIXELS * 0.4;
    const s = state({
      units: [a, b],
      terrain: [highWall('w', wallX, -50, wallX + 5, 50)],
      stealth: { active: true, pois: [] },
    });
    expect(effectiveLOS(b, a, s, s.terrain)).toBe(false);
  });
});

describe('effectiveLOS — stealth on, asymmetric direction', () => {
  it('player → enemy at > 1UD still passes (player LOS unchanged)', () => {
    const a = u({ id: 'a1', faction: 'A', position: v2(0, 0) });
    const b = u({
      id: 'b1',
      faction: 'B',
      position: v2(UNIT_DISTANCE_PIXELS * 3, 0),
    });
    const s = state({
      units: [a, b],
      stealth: { active: true, pois: [] },
    });
    expect(effectiveLOS(a, b, s, s.terrain)).toBe(true);
  });
});
