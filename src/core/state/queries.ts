import { isPointInPolygon } from '../geometry/polygon';
import type { Vec2 } from '../geometry/types';
import type { Terrain, Unit } from './GameState';

export const isInDifficultTerrain = (
  position: Vec2,
  terrain: ReadonlyArray<Terrain>,
): boolean =>
  terrain.some(
    (t) => t.kind === 'DIFFICULT' && isPointInPolygon(position, t.polygon),
  );

export const unitInDifficultTerrain = (
  unit: Unit,
  terrain: ReadonlyArray<Terrain>,
): boolean => isInDifficultTerrain(unit.position, terrain);
