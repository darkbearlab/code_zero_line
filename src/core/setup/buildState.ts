import type { Faction, GameState, Unit } from '../state/GameState';
import type { Vec2 } from '../geometry/types';
import type {
  DeploymentBySide,
  MapDef,
  RostersBySide,
} from './types';

export interface BuildInitialStateInput {
  readonly seed: string;
  readonly map: MapDef;
  readonly rosters: RostersBySide;
  readonly deployment: DeploymentBySide;
  readonly firstHolder: Faction;
  readonly buildUnit: (spawn: {
    id: string;
    templateId: string;
    faction: Faction;
    position: Vec2;
  }) => Unit;
}

/**
 * Compose a Battle-ready GameState from a fully resolved setup.
 *
 * Each placed roster entry becomes a unit at the chosen position; entries
 * without a placement are skipped (the deployment UI is responsible for
 * forcing every roster slot to be placed before allowing transition).
 */
export const buildInitialState = (input: BuildInitialStateInput): GameState => {
  const units: Unit[] = [];
  for (const faction of ['A', 'B'] as const) {
    const placements = input.deployment[faction];
    const roster = input.rosters[faction];
    for (const p of placements) {
      const entry = roster.find((r) => r.id === p.rosterId);
      if (!entry) continue;
      units.push(
        input.buildUnit({
          id: entry.id,
          templateId: entry.templateId,
          faction,
          position: p.position,
        }),
      );
    }
  }
  const objectives = (input.map.objectives ?? []).map((o) => ({
    id: o.id,
    position: o.position,
    radius: o.radius,
    ...(o.displayName !== undefined ? { displayName: o.displayName } : {}),
  }));
  return {
    seed: input.seed,
    commandCount: 0,
    units,
    terrain: input.map.terrain.map((t) => ({
      id: t.id,
      kind: t.kind,
      polygon: t.polygon,
      ...(t.height !== undefined ? { height: t.height } : {}),
      ...(t.displayName !== undefined ? { displayName: t.displayName } : {}),
      ...(t.briefHint !== undefined ? { briefHint: t.briefHint } : {}),
      ...(t.detailHint !== undefined ? { detailHint: t.detailHint } : {}),
      ...(t.kind === 'DOOR' ? { isOpen: t.isOpen ?? false } : {}),
      ...(t.doorStyle !== undefined ? { doorStyle: t.doorStyle } : {}),
    })),
    ...(objectives.length > 0 ? { objectives } : {}),
    initiative: {
      holder: input.firstHolder,
      momentum: { A: 0, B: 0 },
      cycle: 1,
      playerActivations: 0,
      activeActivation: null,
      // Control-points scoring fields. Cheap to keep around for every match;
      // only the `control-points` scenario actually mutates / reads them, so
      // other modes leave the neutral map and zero scores untouched.
      ...(objectives.length > 0
        ? {
            objectiveScores: { A: 0, B: 0 },
            objectiveControl: Object.fromEntries(
              objectives.map((o) => [o.id, null] as const),
            ),
          }
        : {}),
    },
  };
};
