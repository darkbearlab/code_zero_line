import { v2 } from '../core/geometry/vec2';
import { buildUnit, getMap } from '../config/loader';
import { buildInitialState } from '../core/setup/buildState';
import type { GameState } from '../core/state/GameState';
import type {
  DeploymentBySide,
  RostersBySide,
} from '../core/setup/types';

/** Default 2v2 demo loadout — mirrors RosterScene's "Demo loadout" button. */
export interface MatchFixture {
  readonly mapId: string;
  readonly rosters: RostersBySide;
  readonly deployment: DeploymentBySide;
  readonly firstHolder: 'A' | 'B';
}

export const demoFixture: MatchFixture = {
  mapId: 'demo',
  rosters: {
    A: [
      { id: 'blue-1', templateId: 'elite' },
      { id: 'blue-2', templateId: 'trooper' },
    ],
    B: [
      { id: 'red-1', templateId: 'conscript' },
      { id: 'red-2', templateId: 'heavy_gunner' },
    ],
  },
  deployment: {
    A: [
      { rosterId: 'blue-1', position: v2(0, 0) },
      { rosterId: 'blue-2', position: v2(0, 0) },
    ],
    B: [
      { rosterId: 'red-1', position: v2(0, 0) },
      { rosterId: 'red-2', position: v2(0, 0) },
    ],
  },
  firstHolder: 'A',
};

/**
 * Mirrored fixture for AI A/B comparison. Both sides field the SAME templates
 * so any winrate skew reflects strategy quality rather than loadout bias.
 * `demoFixture` (asymmetric loadout) is preserved for rule-edge testing where
 * the imbalance is deliberate.
 */
export const mirrorFixture: MatchFixture = {
  mapId: 'demo',
  rosters: {
    A: [
      { id: 'blue-1', templateId: 'elite' },
      { id: 'blue-2', templateId: 'trooper' },
    ],
    B: [
      { id: 'red-1', templateId: 'elite' },
      { id: 'red-2', templateId: 'trooper' },
    ],
  },
  deployment: {
    A: [
      { rosterId: 'blue-1', position: v2(0, 0) },
      { rosterId: 'blue-2', position: v2(0, 0) },
    ],
    B: [
      { rosterId: 'red-1', position: v2(0, 0) },
      { rosterId: 'red-2', position: v2(0, 0) },
    ],
  },
  firstHolder: 'A',
};

export const namedFixtures: Record<string, MatchFixture> = {
  demo: demoFixture,
  mirror: mirrorFixture,
};

/**
 * Build a deterministic initial state for the given fixture and seed. Position
 * placeholders in the fixture get replaced with real corner positions derived
 * from the chosen map's size — keeps the fixture file tiny and lets us swap
 * maps without rewriting deployment offsets.
 */
export const buildFixtureState = (
  fixture: MatchFixture,
  seed: string,
): GameState => {
  const map = getMap(fixture.mapId);
  const size = map.size;
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
    seed,
    map,
    rosters: fixture.rosters,
    deployment,
    firstHolder: fixture.firstHolder,
    buildUnit,
  });
};
