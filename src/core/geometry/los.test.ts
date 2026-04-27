import { describe, it, expect } from 'vitest';
import { hasLOS } from './los';
import { v2 } from './vec2';

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

  it('blocked by a wall taller than both circles', () => {
    const wall = {
      vertices: [v2(50, -50), v2(50, 50), v2(60, 50), v2(60, -50)],
    };
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 10 },
        [wall],
      ),
    ).toBe(false);
  });

  it('LOS through a small wall when one circle is large enough to peek', () => {
    // Wall at x∈[40,60], y∈[-5,5]. Center line is blocked,
    // but B has r=30 so its top edge ((100, 30)) sees A's top ((0, 10))
    // along a ray that passes y > 5 over the wall.
    const wall = {
      vertices: [v2(40, -5), v2(40, 5), v2(60, 5), v2(60, -5)],
    };
    expect(
      hasLOS(
        { center: v2(0, 0), radius: 10 },
        { center: v2(100, 0), radius: 30 },
        [wall],
      ),
    ).toBe(true);
  });

  it('LOS reciprocity: a→b same as b→a', () => {
    const wall = {
      vertices: [v2(40, -5), v2(40, 5), v2(60, 5), v2(60, -5)],
    };
    const a = { center: v2(0, 0), radius: 10 };
    const b = { center: v2(100, 0), radius: 30 };
    expect(hasLOS(a, b, [wall])).toEqual(hasLOS(b, a, [wall]));
  });
});
