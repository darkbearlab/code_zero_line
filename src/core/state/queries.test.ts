import { describe, expect, it } from 'vitest';
import { v2 } from '../geometry/vec2';
import type { Terrain } from './GameState';
import { isInDifficultTerrain } from './queries';

const difficult: Terrain = {
  id: 't1',
  kind: 'DIFFICULT',
  polygon: {
    vertices: [v2(0, 0), v2(100, 0), v2(100, 100), v2(0, 100)],
  },
};

const hardWall: Terrain = {
  id: 't2',
  kind: 'HARD',
  polygon: {
    vertices: [v2(200, 0), v2(300, 0), v2(300, 100), v2(200, 100)],
  },
  height: 30,
};

describe('isInDifficultTerrain', () => {
  it('returns true when point is inside a DIFFICULT polygon', () => {
    expect(isInDifficultTerrain(v2(50, 50), [difficult])).toBe(true);
  });

  it('returns false when point is outside all polygons', () => {
    expect(isInDifficultTerrain(v2(500, 500), [difficult])).toBe(false);
  });

  it('ignores non-DIFFICULT terrain kinds', () => {
    expect(isInDifficultTerrain(v2(250, 50), [hardWall])).toBe(false);
  });

  it('returns true if point is in any DIFFICULT polygon among many', () => {
    expect(isInDifficultTerrain(v2(50, 50), [hardWall, difficult])).toBe(true);
  });

  it('returns false for empty terrain list', () => {
    expect(isInDifficultTerrain(v2(50, 50), [])).toBe(false);
  });
});
