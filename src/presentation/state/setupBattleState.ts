import type { GameState, Terrain } from '../../core/state/GameState';
import { v2 } from '../../core/geometry/vec2';
import { UNIT_DISTANCE_PIXELS } from '../../core/rules/constants';
import { buildUnit } from '../../config/loader';

const wall = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Terrain => ({
  id,
  kind: 'HARD',
  polygon: {
    vertices: [v2(x, y), v2(x + w, y), v2(x + w, y + h), v2(x, y + h)],
  },
});

/**
 * 24" × 24" battlefield = 24/3 = 8 unit-distances per side ≈ 768px @ 96px/unit.
 */
export const BATTLEFIELD_SIZE_PIXELS = (24 * UNIT_DISTANCE_PIXELS) / 3;

export const setupDemoState = (): GameState => {
  const size = BATTLEFIELD_SIZE_PIXELS;
  return {
    seed: 'demo-1',
    commandCount: 0,
    units: [
      buildUnit({
        id: 'blue-1',
        templateId: 'elite',
        faction: 'A',
        position: v2(size * 0.15, size * 0.85),
      }),
      buildUnit({
        id: 'blue-2',
        templateId: 'trooper',
        faction: 'A',
        position: v2(size * 0.22, size * 0.78),
      }),
      buildUnit({
        id: 'red-1',
        templateId: 'conscript',
        faction: 'B',
        position: v2(size * 0.85, size * 0.15),
      }),
      buildUnit({
        id: 'red-2',
        templateId: 'heavy_gunner',
        faction: 'B',
        position: v2(size * 0.78, size * 0.22),
      }),
    ],
    terrain: [
      wall('wall-mid', size * 0.4, size * 0.42, size * 0.2, 12),
      wall('wall-left', size * 0.12, size * 0.5, 12, size * 0.18),
      wall('wall-right', size * 0.86, size * 0.32, 12, size * 0.18),
    ],
    initiative: {
      holder: 'A',
      momentum: { A: 0, B: 0 },
      round: 1,
      activeActivation: null,
    },
  };
};
