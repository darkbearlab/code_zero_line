import { describe, it, expect } from 'vitest';
import { v2 } from '../../core/geometry/vec2';
import type { Terrain } from '../../core/state/GameState';
import { buildNavGrid, findPath, smoothPath } from './grid';

const hardWall = (
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

describe('grid pathfinding', () => {
  it('finds a straight path on an empty map', () => {
    const grid = buildNavGrid(256, [], 16);
    const path = findPath(grid, v2(20, 20), v2(220, 220));
    expect(path.success).toBe(true);
    expect(path.waypoints.length).toBeGreaterThan(0);
    expect(path.waypoints[0]).toEqual(v2(20, 20));
    expect(path.waypoints[path.waypoints.length - 1]).toEqual(v2(220, 220));
  });

  it('routes around a horizontal wall', () => {
    // Wall splits the 256×256 map across most of the width with a gap on
    // the right. Cell-grid is 16px; wall y range chosen NOT to fall on a
    // cell-edge boundary so isPointInPolygon classifies cleanly.
    const grid = buildNavGrid(
      256,
      [hardWall('w', 0, 100, 192, 156)],
      16,
    );
    const path = findPath(grid, v2(20, 20), v2(20, 220));
    expect(path.success).toBe(true);
    // The path must veer right past x=192 to clear the wall.
    expect(path.waypoints.some((p) => p.x > 192)).toBe(true);
  });

  it('reports NO_PATH when target is fully walled off', () => {
    // Sealed box: 4 walls around (200,200)-(240,240).
    const grid = buildNavGrid(
      256,
      [
        hardWall('top', 180, 180, 260, 196),
        hardWall('bot', 180, 244, 260, 260),
        hardWall('left', 180, 196, 196, 244),
        hardWall('right', 244, 196, 260, 244),
      ],
      8,
    );
    const path = findPath(grid, v2(20, 20), v2(220, 220));
    expect(path.success).toBe(false);
    // Target itself is inside walls? Could be either NO_PATH or TARGET_BLOCKED.
    expect(['NO_PATH', 'TARGET_BLOCKED']).toContain(path.stuckReason);
  });

  it('reports START_BLOCKED when the start cell is inside a wall', () => {
    const grid = buildNavGrid(
      256,
      [hardWall('w', 0, 0, 80, 80)],
      16,
    );
    const path = findPath(grid, v2(40, 40), v2(220, 220));
    expect(path.success).toBe(false);
    expect(path.stuckReason).toBe('START_BLOCKED');
  });

  it('smoothing collapses cell-centre zigzag into straight segments', () => {
    const grid = buildNavGrid(256, [], 16);
    const path = findPath(grid, v2(20, 20), v2(220, 220));
    const smoothed = smoothPath(grid, path.waypoints);
    expect(smoothed.length).toBeLessThanOrEqual(path.waypoints.length);
    // On an empty map a single straight segment should suffice.
    expect(smoothed.length).toBe(2);
  });
});
