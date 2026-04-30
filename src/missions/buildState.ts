/**
 * Convert a MissionDef + roguelite RunState into the GameState that
 * BattleScene consumes. Bridges the roguelite layer (mission library,
 * run progression) to the existing core/setup/buildState.
 *
 * Damage carry-over and one-shot Hub buffs are applied here so the
 * downstream BattleScene sees a "ready-to-fight" state with no
 * roguelite-specific fields leaking in.
 */
import { buildUnit, getMap } from '../config/loader';
import { buildInitialState } from '../core/setup/buildState';
import type {
  DeploymentBySide,
  RostersBySide,
} from '../core/setup/types';
import type { DamageState, GameState, Unit } from '../core/state/GameState';
import type {
  RunBoon,
  RunState,
} from '../runs/state';
import type { MissionDef } from './types';

export interface MissionBuildOptions {
  /**
   * Optional: when present, only spawn squad members whose id appears here.
   * Used to drop killed units between missions.
   */
  readonly aliveIds?: ReadonlyArray<string>;
  /**
   * Optional: applied per-unit damage state at spawn (for damage carry-over
   * across missions). Keyed by roster id.
   */
  readonly damageCarry?: Readonly<Record<string, DamageState>>;
  /** Active one-shot boons that apply only to this mission. */
  readonly oneShotBoons?: ReadonlyArray<RunBoon>;
  /** Persistent run boons (BONUS_DICE etc) currently in effect. */
  readonly runBoons?: ReadonlyArray<RunBoon>;
}

const cloneEnemy = (mission: MissionDef): Array<Unit> => {
  return mission.enemies.map((e) =>
    buildUnit({
      id: e.id,
      templateId: e.templateId,
      faction: mission.enemyFaction,
      position: e.position,
    }),
  );
};

/**
 * Apply all relevant boons to a freshly-built unit. We mutate the cloned
 * unit by replacing it with a new immutable copy.
 */
const applyBoonsToUnit = (
  unit: Unit,
  oneShotBoons: ReadonlyArray<RunBoon>,
  runBoons: ReadonlyArray<RunBoon>,
): Unit => {
  let bonusDice = 0;
  for (const b of runBoons) {
    if (b.effect.kind === 'BONUS_DICE') bonusDice += b.effect.amount;
  }
  for (const b of oneShotBoons) {
    if (b.effect.kind === 'NEXT_MISSION_HARDER') bonusDice += b.effect.bonusDice;
  }
  if (bonusDice === 0) return unit;
  const buffedWeapons = unit.weapons.map((w) => ({
    ...w,
    diceCount: w.diceCount + bonusDice,
  }));
  return { ...unit, weapons: buffedWeapons };
};

const applyOneShotEnemyAdjustments = (
  enemies: ReadonlyArray<Unit>,
  oneShotBoons: ReadonlyArray<RunBoon>,
  mission: MissionDef,
): Unit[] => {
  // For NEXT_MISSION_HARDER we add `extraEnemies` cheap conscripts placed
  // around the existing enemy footprint.
  let extra = 0;
  for (const b of oneShotBoons) {
    if (b.effect.kind === 'NEXT_MISSION_HARDER') extra += b.effect.extraEnemies;
  }
  if (extra === 0) return [...enemies];
  const out = [...enemies];
  for (let i = 0; i < extra; i++) {
    const baseline = mission.enemies[i % mission.enemies.length]!;
    out.push(
      buildUnit({
        id: `${baseline.id}-extra-${i + 1}`,
        templateId: 'conscript',
        faction: mission.enemyFaction,
        // Slight offset so they don't stack.
        position: {
          x: baseline.position.x + (i + 1) * 28,
          y: baseline.position.y + (i + 1) * 12,
        },
      }),
    );
  }
  return out;
};

export const buildMissionState = (
  mission: MissionDef,
  run: RunState,
  seed: string,
  opts: MissionBuildOptions = {},
): GameState => {
  const map = getMap(mission.mapId);
  const aliveSet = opts.aliveIds ? new Set(opts.aliveIds) : null;
  const liveSquad = run.squad.filter((s) =>
    aliveSet === null ? true : aliveSet.has(s.id),
  );
  const positions = mission.playerSpawnPositions;
  const playerRoster = liveSquad;
  const playerDeployment = playerRoster.map((entry, i) => ({
    rosterId: entry.id,
    position: positions[Math.min(i, positions.length - 1)]!,
  }));
  const rosters: RostersBySide = {
    A: playerRoster,
    B: [],
  };
  const deployment: DeploymentBySide = {
    A: playerDeployment,
    B: [],
  };
  const baseState = buildInitialState({
    seed,
    map,
    rosters,
    deployment,
    firstHolder: 'A',
    buildUnit,
  });

  // Patch on enemies (they aren't part of the rosters API but the reducer
  // doesn't care about provenance — units are units).
  const enemies = applyOneShotEnemyAdjustments(
    cloneEnemy(mission),
    opts.oneShotBoons ?? [],
    mission,
  );

  // Apply boons + damage carry-over to player units.
  const carry = opts.damageCarry ?? {};
  const oneShotBoons = opts.oneShotBoons ?? [];
  const runBoons = opts.runBoons ?? [];
  const playerUnits = baseState.units
    .filter((u) => u.faction === 'A')
    .map((u) => {
      let next: Unit = u;
      const carriedDamage = carry[u.id];
      if (carriedDamage && carriedDamage !== 'NONE') {
        next = { ...next, damage: carriedDamage };
        if (carriedDamage === 'SUPPRESSED') next = { ...next, stance: 'PRONE' };
      }
      next = applyBoonsToUnit(next, oneShotBoons, runBoons);
      return next;
    });

  // Mission-level objectives override the map's objectives so the same map
  // can host different scenario flavors without duplicating terrain.
  const objectives = mission.objectives
    ? mission.objectives.map((o) => ({
        id: o.id,
        position: o.position,
        radius: o.radius,
        ...(o.displayName !== undefined ? { displayName: o.displayName } : {}),
      }))
    : baseState.objectives;

  // Surface scenario type + params so the AI evaluator can apply
  // scenario-aware modifiers (time pressure, attacker urgency).
  const scenarioInfo = {
    mode: mission.scenario as string,
    params: (mission.scenarioParams ?? {}) as Readonly<Record<string, unknown>>,
  };

  return {
    ...baseState,
    units: [...playerUnits, ...enemies],
    ...(objectives && objectives.length > 0 ? { objectives } : {}),
    scenarioInfo,
  };
};
