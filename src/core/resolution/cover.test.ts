import { describe, it, expect } from 'vitest';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type { Terrain, Unit } from '../state/GameState';
import { targetHasCover } from './cover';

const baseUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
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

const rect = (
  id: string,
  kind: Terrain['kind'],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  height?: number,
): Terrain => ({
  id,
  kind,
  ...(height !== undefined ? { height } : {}),
  polygon: {
    vertices: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  },
});

describe('targetHasCover — BLOCKER', () => {
  it('a sealed wall on the LOS line grants cover like a HARD wall', () => {
    const shooter = baseUnit({ id: 'a', position: v2(0, 100) });
    const target = baseUnit({
      id: 'b',
      faction: 'B',
      position: v2(200, 100),
    });
    const wall = rect('w1', 'BLOCKER', 80, 80, 120, 120);
    expect(targetHasCover(shooter, target, [wall])).toBe(true);
  });

  it('off-LOS BLOCKER grants no cover', () => {
    const shooter = baseUnit({ id: 'a', position: v2(0, 100) });
    const target = baseUnit({
      id: 'b',
      faction: 'B',
      position: v2(200, 100),
    });
    const wall = rect('w1', 'BLOCKER', 80, 200, 120, 240);
    expect(targetHasCover(shooter, target, [wall])).toBe(false);
  });
});

describe('targetHasCover — HIGH_GROUND', () => {
  // Platform around target.
  const platform = rect('hg', 'HIGH_GROUND', 180, 80, 240, 140);

  it('target on high ground + shooter below → cover', () => {
    const shooter = baseUnit({ id: 'a', position: v2(0, 110) });
    const target = baseUnit({
      id: 'b',
      faction: 'B',
      position: v2(210, 110),
    });
    expect(targetHasCover(shooter, target, [platform])).toBe(true);
  });

  it('both on the same platform → no high-ground cover', () => {
    const shooter = baseUnit({ id: 'a', position: v2(190, 110) });
    const target = baseUnit({
      id: 'b',
      faction: 'B',
      position: v2(225, 110),
    });
    expect(targetHasCover(shooter, target, [platform])).toBe(false);
  });

  it('shooter on high ground neutralises low-wall cover for the target', () => {
    // Low wall sits between shooter (on platform) and ground-level target.
    const lowWall = rect('lw', 'HARD', 280, 95, 320, 125, 24);
    const shooter = baseUnit({ id: 'a', position: v2(210, 110) });
    const target = baseUnit({
      id: 'b',
      faction: 'B',
      position: v2(400, 110),
    });
    // Without the high-ground rule a HARD wall on the LOS line grants cover;
    // shooter-on-high-ground should void it (overhead shot).
    expect(targetHasCover(shooter, target, [platform, lowWall])).toBe(false);
  });

  it('high walls still mask target even from a high-ground shooter', () => {
    const highWall = rect('hw', 'HARD', 280, 95, 320, 125, 200);
    const shooter = baseUnit({ id: 'a', position: v2(210, 110) });
    const target = baseUnit({
      id: 'b',
      faction: 'B',
      position: v2(400, 110),
    });
    expect(targetHasCover(shooter, target, [platform, highWall])).toBe(true);
  });
});
