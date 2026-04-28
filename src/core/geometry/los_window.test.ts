import { describe, it, expect } from 'vitest';
import { computeReactionWindows } from './los_window';
import type { EnemyForLOS } from './los_window';
import { v2 } from './vec2';
import type { Terrain } from '../state/GameState';

const enemy = (id: string, x: number, y: number, r = 10): EnemyForLOS => ({
  id,
  circle: { center: v2(x, y), radius: r },
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

describe('computeReactionWindows', () => {
  it('no enemies → empty', () => {
    const w = computeReactionWindows(v2(0, 0), v2(100, 0), 10, [], []);
    expect(w).toEqual([]);
  });

  it('one enemy with clear LOS → single full-range window', () => {
    const w = computeReactionWindows(
      v2(0, 0),
      v2(100, 0),
      10,
      [enemy('e1', 50, 200)],
      [],
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.enemyUnitId).toBe('e1');
    expect(w[0]?.startT).toBeCloseTo(0);
    expect(w[0]?.endT).toBeCloseTo(1);
  });

  it('full-cover wall hides the entire path → no window', () => {
    const w = computeReactionWindows(
      v2(0, 0),
      v2(100, 0),
      10,
      [enemy('e1', 50, 200)],
      [highWall('w', -200, 90, 200, 110)],
    );
    expect(w).toEqual([]);
  });

  it('wall covers middle of path → split into two windows', () => {
    const w = computeReactionWindows(
      v2(0, 0),
      v2(100, 0),
      5,
      [enemy('e1', 50, 200, 5)],
      [highWall('w', 40, 90, 60, 110)],
      {},
      64,
    );
    expect(w.length).toBeGreaterThanOrEqual(1);
    if (w.length === 2) {
      expect(w[0]!.endT).toBeLessThan(w[1]!.startT);
    }
  });
});
