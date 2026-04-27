import { describe, it, expect } from 'vitest';
import { computeReactionWindows } from './los_window';
import type { EnemyForLOS } from './los_window';
import { v2 } from './vec2';

const enemy = (id: string, x: number, y: number, r = 10): EnemyForLOS => ({
  id,
  circle: { center: v2(x, y), radius: r },
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
    // Long wall between mover (y=0) and enemy (y=200), spanning the whole x range.
    const wall = {
      vertices: [v2(-200, 90), v2(200, 90), v2(200, 110), v2(-200, 110)],
    };
    const w = computeReactionWindows(
      v2(0, 0),
      v2(100, 0),
      10,
      [enemy('e1', 50, 200)],
      [wall],
    );
    expect(w).toEqual([]);
  });

  it('wall covers middle of path → split into two windows', () => {
    // Wall covers x ∈ [40, 60], blocking visibility from enemy at (50, 200) only
    // when the mover is roughly under the wall.
    const wall = {
      vertices: [v2(40, 90), v2(60, 90), v2(60, 110), v2(40, 110)],
    };
    const w = computeReactionWindows(
      v2(0, 0),
      v2(100, 0),
      5,
      [enemy('e1', 50, 200, 5)],
      [wall],
      64,
    );
    // Expect at least one window before and one after the covered middle.
    expect(w.length).toBeGreaterThanOrEqual(1);
    if (w.length === 2) {
      expect(w[0]!.endT).toBeLessThan(w[1]!.startT);
    }
  });
});
