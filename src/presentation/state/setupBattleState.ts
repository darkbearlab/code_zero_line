import { v2 } from '../../core/geometry/vec2';
import { buildInitialState } from '../../core/setup/buildState';
import type {
  DeploymentBySide,
  RostersBySide,
} from '../../core/setup/types';
import type { GameState } from '../../core/state/GameState';
import { buildUnit, getMap } from '../../config/loader';

export const DEFAULT_MAP_ID = 'demo';

/** Cached current-map size for camera fitting (UI/rendering uses this). */
export const BATTLEFIELD_SIZE_PIXELS = getMap(DEFAULT_MAP_ID).size;

/**
 * Demo state used when entering BattleScene directly (dev shortcut, no Roster
 * → Deploy flow). Two units per side at the corners.
 */
export const setupDemoState = (): GameState => {
  const map = getMap(DEFAULT_MAP_ID);
  const size = map.size;
  const rosters: RostersBySide = {
    A: [
      { id: 'blue-1', templateId: 'elite' },
      { id: 'blue-2', templateId: 'trooper' },
    ],
    B: [
      { id: 'red-1', templateId: 'conscript' },
      { id: 'red-2', templateId: 'heavy_gunner' },
    ],
  };
  const deployment: DeploymentBySide = {
    A: [
      { rosterId: 'blue-1', position: v2(size * 0.15, size * 0.85) },
      { rosterId: 'blue-2', position: v2(size * 0.22, size * 0.78) },
    ],
    B: [
      { rosterId: 'red-1', position: v2(size * 0.85, size * 0.15) },
      { rosterId: 'red-2', position: v2(size * 0.78, size * 0.22) },
    ],
  };
  return buildInitialState({
    seed: 'demo-1',
    map,
    rosters,
    deployment,
    firstHolder: 'A',
    buildUnit,
  });
};
