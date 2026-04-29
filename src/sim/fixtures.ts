import { v2 } from '../core/geometry/vec2';
import { buildUnit, getMap } from '../config/loader';
import { buildInitialState } from '../core/setup/buildState';
import type { Vec2 } from '../core/geometry/types';
import type { Faction, GameState } from '../core/state/GameState';
import type {
  DeploymentBySide,
  DeploymentZone,
  RosterEntry,
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

/**
 * 3v3 mirrored fixture INCLUDING an officer (squad_lead) on each side.
 * Use this for any sim that wants to exercise OFFICER mechanics —
 * COMMAND_MOVE / COMMAND_RALLY / COMBINED Fire / rally aura. The
 * 2v2 mirror fixture has no officer so those subsystems never fire.
 */
export const mirrorOfficerFixture: MatchFixture = {
  mapId: 'demo',
  rosters: {
    A: [
      { id: 'blue-1', templateId: 'squad_lead' },
      { id: 'blue-2', templateId: 'elite' },
      { id: 'blue-3', templateId: 'trooper' },
    ],
    B: [
      { id: 'red-1', templateId: 'squad_lead' },
      { id: 'red-2', templateId: 'elite' },
      { id: 'red-3', templateId: 'trooper' },
    ],
  },
  deployment: {
    A: [
      { rosterId: 'blue-1', position: v2(0, 0) },
      { rosterId: 'blue-2', position: v2(0, 0) },
      { rosterId: 'blue-3', position: v2(0, 0) },
    ],
    B: [
      { rosterId: 'red-1', position: v2(0, 0) },
      { rosterId: 'red-2', position: v2(0, 0) },
      { rosterId: 'red-3', position: v2(0, 0) },
    ],
  },
  firstHolder: 'A',
};

export const namedFixtures: Record<string, MatchFixture> = {
  demo: demoFixture,
  mirror: mirrorFixture,
  'mirror-officer': mirrorOfficerFixture,
};

const polygonAabb = (
  verts: ReadonlyArray<Vec2>,
): { minX: number; minY: number; maxX: number; maxY: number } => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  return { minX, minY, maxX, maxY };
};

/**
 * Spread N points evenly across the AABB centerline of the zone polygon.
 * Works for the rectangular strip-zones that the editor produces. Caller is
 * responsible for picking a map whose zones can fit `count` non-overlapping
 * unit bases.
 */
const placeInZone = (
  zone: DeploymentZone,
  count: number,
): Vec2[] => {
  const { minX, minY, maxX, maxY } = polygonAabb(zone.polygon.vertices);
  // Spread along the long axis; sit on the short-axis centerline.
  const w = maxX - minX;
  const h = maxY - minY;
  const longHorizontal = w >= h;
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1);
    if (longHorizontal) {
      out.push(v2(minX + w * t, (minY + maxY) / 2));
    } else {
      out.push(v2((minX + maxX) / 2, minY + h * t));
    }
  }
  return out;
};

const placementsFor = (
  faction: Faction,
  roster: ReadonlyArray<RosterEntry>,
  zones: ReadonlyArray<DeploymentZone>,
  fixtureId: string,
) => {
  const zone = zones.find((z) => z.faction === faction);
  if (!zone) {
    throw new Error(
      `Fixture "${fixtureId}" map has no deployment zone for faction ${faction}`,
    );
  }
  const positions = placeInZone(zone, roster.length);
  return roster.map((entry, i) => ({
    rosterId: entry.id,
    position: positions[i]!,
  }));
};

/**
 * Build a deterministic initial state for the given fixture and seed.
 * Deployment positions are derived from the chosen map's actual zone
 * polygons so any custom map (with valid A/B zones) works automatically —
 * the fixture stays small and roster-only.
 */
export const buildFixtureState = (
  fixture: MatchFixture,
  seed: string,
): GameState => {
  const map = getMap(fixture.mapId);
  const deployment: DeploymentBySide = {
    A: placementsFor('A', fixture.rosters.A, map.deploymentZones, fixture.mapId),
    B: placementsFor('B', fixture.rosters.B, map.deploymentZones, fixture.mapId),
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
