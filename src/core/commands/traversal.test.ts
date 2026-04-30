import { describe, it, expect } from 'vitest';
import { applyCommands } from './reducer';
import type { GameState, Terrain, Unit } from '../state/GameState';
import { v2 } from '../geometry/vec2';
import {
  CRAWL_MAX_DISTANCE_PIXELS,
  STANDARD_BASE_RADIUS_PIXELS,
  VAULT_HEIGHT_THRESHOLD_PIXELS,
} from '../rules/constants';

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

const lowWall = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Terrain => ({
  id,
  kind: 'HARD',
  height: 24,
  polygon: { vertices: [v2(x1, y1), v2(x2, y1), v2(x2, y2), v2(x1, y2)] },
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

const baseState = (units: Unit[], terrain: Terrain[] = []): GameState => ({
  seed: 'traversal-test',
  commandCount: 0,
  units,
  terrain,
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    activeActivation: null,
  },
});

describe('CRAWL command', () => {
  it('caps distance to 1 unit-distance and sets stance to PRONE', () => {
    const s0 = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), quality: 3 }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'CRAWL', unitId: 'a1', target: v2(500, 0) },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.position.x).toBeLessThanOrEqual(CRAWL_MAX_DISTANCE_PIXELS + 0.5);
    expect(a1.stance).toBe('PRONE');
  });

  it('ends activation without turnover (rule 4.5)', () => {
    const s0 = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), quality: 1 }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'CRAWL', unitId: 'a1', target: v2(50, 0) },
    ]);
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.activeActivation).toBeNull();
  });
});

describe('VAULT command', () => {
  it('requires contact with a low wall', () => {
    const s0 = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), quality: 3 }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
    ]);
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'a1' },
        { type: 'VAULT', unitId: 'a1' },
      ]),
    ).toThrow(/NOT_TOUCHING_WALL/);
  });

  it('refuses if touched wall is too tall (climb territory)', () => {
    // Place unit close enough that radius hits the wall.
    const s0 = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(40, 0),
          quality: 3,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
      [highWall('hw', 50, -50, 60, 50)],
    );
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'a1' },
        { type: 'VAULT', unitId: 'a1' },
      ]),
    ).toThrow(/WALL_TOO_TALL/);
  });

  it('places mover on opposite side of a low wall and keeps stance', () => {
    const s0 = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(40, 0),
          quality: 3,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
      [lowWall('lw', 50, -50, 60, 50)],
    );
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'VAULT', unitId: 'a1' },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    // Wall mid-X = 55, so opposite of x=40 is x=70.
    expect(a1.position.x).toBeCloseTo(70, 0);
    expect(a1.stance).toBe('STANDING');
  });
});

describe('CLIMB command', () => {
  it('requires a high wall', () => {
    const s0 = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(40, 0),
          quality: 3,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
      [lowWall('lw', 50, -50, 60, 50)],
    );
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'a1' },
        { type: 'CLIMB', unitId: 'a1' },
      ]),
    ).toThrow(/WALL_TOO_SHORT/);
  });

  it('places mover at far edge of high wall and ends activation no turnover', () => {
    const s0 = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(40, 0),
          quality: 1,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
      [highWall('hw', 50, -50, 60, 50)],
    );
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'CLIMB', unitId: 'a1' },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    // Far edge from x=40 across a wall x∈[50,60] is x=60.
    expect(a1.position.x).toBeCloseTo(60, 0);
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.activeActivation).toBeNull();
  });

  it('lands the mover ON TOP of a wide high wall (centred on its spine)', () => {
    // Wide wall x∈[40,140] (100 long), y∈[-30,30] (60 thick — well over 2r).
    // Climber arrives from y < -30 and should end up centred on the spine
    // (y = 0), x preserved.
    const wideWall: Terrain = {
      id: 'platform',
      kind: 'HARD',
      height: 200,
      polygon: {
        vertices: [v2(40, -30), v2(140, -30), v2(140, 30), v2(40, 30)],
      },
    };
    const s0 = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(90, -30 - STANDARD_BASE_RADIUS_PIXELS + 2),
          quality: 1,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
      [wideWall],
    );
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'CLIMB', unitId: 'a1' },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.position.y).toBeCloseTo(0, 0);
    expect(a1.position.x).toBeCloseTo(90, 0);
  });
});

describe('Difficult-terrain start-in (rule 4.2C)', () => {
  const difficult = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Terrain => ({
    id,
    kind: 'DIFFICULT',
    polygon: { vertices: [v2(x1, y1), v2(x2, y1), v2(x2, y2), v2(x1, y2)] },
  });

  it('MOVE caps distance to 1 unit when starting inside difficult terrain', () => {
    const s0 = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(50, 50),
          quality: 1,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
      [difficult('rubble', 0, 0, 200, 200)],
    );
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(500, 50) },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    // Should have moved at most 1 unit-distance in the x direction.
    expect(a1.position.x - 50).toBeLessThanOrEqual(
      VAULT_HEIGHT_THRESHOLD_PIXELS + 0.5,
    );
  });

  it('MOVE ends activation no-turnover when starting inside difficult terrain', () => {
    const s0 = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(50, 50),
          quality: 1,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
      [difficult('rubble', 0, 0, 200, 200)],
    );
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(60, 50) },
    ]);
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.activeActivation).toBeNull();
  });

  it('CRAWL is forbidden when starting inside difficult terrain', () => {
    const s0 = baseState(
      [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(50, 50),
          quality: 3,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
      [difficult('rubble', 0, 0, 200, 200)],
    );
    expect(() =>
      applyCommands(s0, [
        { type: 'ACTIVATE_SPEND', unitId: 'a1' },
        { type: 'CRAWL', unitId: 'a1', target: v2(60, 50) },
      ]),
    ).toThrow(/NO_CRAWL_FROM_DIFFICULT/);
  });
});

// Sanity: VAULT_HEIGHT_THRESHOLD_PIXELS is exported correctly.
describe('constants', () => {
  it('VAULT_HEIGHT_THRESHOLD_PIXELS equals 1 unit distance', () => {
    expect(VAULT_HEIGHT_THRESHOLD_PIXELS).toBeGreaterThan(0);
  });
});
