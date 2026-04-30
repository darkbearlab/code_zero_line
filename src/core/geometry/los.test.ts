import { describe, it, expect } from 'vitest';
import { hasLOS } from './los';
import { v2 } from './vec2';
import type { Terrain } from '../state/GameState';

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

const soft = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Terrain => ({
  id,
  kind: 'SOFT',
  polygon: { vertices: [v2(x1, y1), v2(x2, y1), v2(x2, y2), v2(x1, y2)] },
});

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

describe('hasLOS', () => {
  it('clear LOS in empty space', () => {
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 10 },
        [],
      ),
    ).toBe(true);
  });

  it('blocked by a high wall taller than both circles', () => {
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 10 },
        [highWall('w', 50, -50, 60, 50)],
      ),
    ).toBe(false);
  });

  it('low wall does NOT block LOS to standing target', () => {
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 10 },
        [lowWall('w', 50, -50, 60, 50)],
      ),
    ).toBe(true);
  });

  it('low wall blocks LOS when target is prone', () => {
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 10 },
        [lowWall('w', 50, -50, 60, 50)],
        { bProne: true },
      ),
    ).toBe(false);
  });

  it('low wall blocks LOS when shooter is prone', () => {
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 10 },
        [lowWall('w', 50, -50, 60, 50)],
        { aProne: true },
      ),
    ).toBe(false);
  });

  it('soft cover blocks LOS when both endpoints outside', () => {
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 10 },
        [soft('smoke', 40, -50, 60, 50)],
      ),
    ).toBe(false);
  });

  it('soft cover does NOT block when shooter is inside it', () => {
    expect(
      hasLOS(
        { center: v2(50, 0), radius: 10 },
        { center: v2(150, 0), radius: 10 },
        [soft('smoke', 40, -50, 60, 50)],
      ),
    ).toBe(true);
  });

  it('soft cover does NOT block when target is inside it', () => {
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(50, 0), radius: 10 },
        [soft('smoke', 40, -50, 60, 50)],
      ),
    ).toBe(true);
  });

  it('difficult terrain does not affect LOS', () => {
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 10 },
        [difficult('rubble', 40, -50, 60, 50)],
      ),
    ).toBe(true);
  });

  it('LOS reciprocity: a→b same as b→a', () => {
    const ts = [highWall('w', 40, -5, 60, 5)];
    const a = { center: v2(0, 0), radius: 10 };
    const b = { center: v2(100, 0), radius: 30 };
    expect(hasLOS(a, b, ts)).toEqual(hasLOS(b, a, ts));
  });

  it('BLOCKER occludes LOS regardless of stance', () => {
    const blocker = (
      id: string,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
    ): Terrain => ({
      id,
      kind: 'BLOCKER',
      polygon: { vertices: [v2(x1, y1), v2(x2, y1), v2(x2, y2), v2(x1, y2)] },
    });
    // Wall spans wider than circle perimeter sample reach so no edge-pair
    // sneaks around it.
    const ts = [blocker('seal', 40, -50, 60, 50)];
    const a = { center: v2(0, 0), radius: 10 };
    const b = { center: v2(100, 0), radius: 10 };
    expect(hasLOS(a, b, ts)).toBe(false);
  });

  it('shooter on HIGH_GROUND sees over a low wall to a prone target', () => {
    // Without bypass: low wall + prone target → blocked. With bypass on
    // shooter's side, the wall should be ignored. Wall spans wide so
    // perimeter sampling can't peek around it.
    const ts = [lowWall('lw', 40, -50, 60, 50)];
    const a = { center: v2(0, 0), radius: 10 };
    const b = { center: v2(100, 0), radius: 10 };
    expect(hasLOS(a, b, ts, { bProne: true })).toBe(false);
    expect(hasLOS(a, b, ts, { bProne: true, aOnHighGround: true })).toBe(true);
  });
});
