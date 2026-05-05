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
  DeploymentPlacement,
  RostersBySide,
} from '../core/setup/types';
import type { DamageState, GameState, Unit } from '../core/state/GameState';
import type {
  RunBoon,
  RunState,
} from '../runs/state';
import {
  buildCombatIntelFromUpgrades,
  initialMomentumBonus,
  poolQualityBonus,
} from '../campaign/upgrades';
import { veteranAdjustedQuality } from '../campaign/veteran';
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
  /**
   * Launch this mission in stealth state. Caller (BattleScene / sim) is
   * expected to compute via `currentMissionStealthActive(run, mission)`
   * — that helper folds in the per-mission `stealthMode` override and
   * the run-level chain inheritance.
   */
  readonly stealthActive?: boolean;
  /**
   * When present, overrides `mission.playerSpawnPositions` for the
   * faction-A spawn. The placements come from the pre-battle DeployScene
   * (campaign mode, map has Zone A). Each placement's `rosterId` must
   * match a live squad entry; entries without a placement are dropped
   * from the mission. Caller is responsible for ensuring it satisfies
   * the slot-enforcement constraint when active.
   */
  readonly manualPlayerDeployment?: ReadonlyArray<DeploymentPlacement>;
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
  let playerRoster = liveSquad;
  let playerDeployment: DeploymentPlacement[];
  if (opts.manualPlayerDeployment && opts.manualPlayerDeployment.length > 0) {
    // Honour the pre-battle DeployScene placement: only spawn squad members
    // that received a placement, in placement order. Defends against stale
    // placements pointing at killed roster entries by intersecting with
    // liveSquad.
    const liveById = new Map(liveSquad.map((s) => [s.id, s] as const));
    const ordered: typeof liveSquad = [];
    const placements: DeploymentPlacement[] = [];
    for (const p of opts.manualPlayerDeployment) {
      const entry = liveById.get(p.rosterId);
      if (!entry) continue;
      ordered.push(entry);
      placements.push(p);
    }
    playerRoster = ordered;
    playerDeployment = placements;
  } else {
    const positions = mission.playerSpawnPositions;
    playerDeployment = playerRoster.map((entry, i) => ({
      rosterId: entry.id,
      position: positions[Math.min(i, positions.length - 1)]!,
    }));
  }
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
  const upgradeLevels = run.upgradeLevels ?? {};
  const qualityReduction = poolQualityBonus(upgradeLevels);
  // RosterEntry.id → sortie count, for veteran auto-growth (§6.3).
  const sortiesById = new Map(
    run.squad.map((e) => [e.id, e.sorties ?? 0] as const),
  );
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
      // Veteran auto-growth first (caps at quality 3+), pool upgrade
      // stacks on top (can pierce that floor down to 1+).
      const veteranQ = veteranAdjustedQuality(
        next.quality,
        sortiesById.get(u.id) ?? 0,
      );
      const finalQ = qualityReduction > 0
        ? Math.max(1, veteranQ - qualityReduction)
        : veteranQ;
      if (finalQ !== next.quality) {
        next = { ...next, quality: finalQ };
      }
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

  // Combat-intel upgrades feed the resolver's per-tag threshold bonus.
  // Empty record when no relevant upgrades bought — falls back to the
  // resolver's existing `EMPTY_COMBAT_INTEL` defaults.
  const combatIntel = buildCombatIntelFromUpgrades(upgradeLevels);
  const hasIntel =
    Object.keys(combatIntel.shoot).length > 0 ||
    Object.keys(combatIntel.melee).length > 0;

  // Initial-momentum upgrade only buffs the player side (faction A).
  const startingMomentum = initialMomentumBonus(upgradeLevels);
  // Re-seed control-points scoring fields against the FINAL objective set —
  // mission-level objectives override the map's, so any owner map
  // baseState built from map.objectives has the wrong keys (or is missing
  // entirely when the map ships without objectives).
  const objectiveControlInit =
    objectives && objectives.length > 0
      ? Object.fromEntries(objectives.map((o) => [o.id, null] as const))
      : undefined;
  const initiative = {
    ...baseState.initiative,
    ...(startingMomentum > 0
      ? {
          momentum: {
            ...baseState.initiative.momentum,
            A: baseState.initiative.momentum.A + startingMomentum,
          },
        }
      : {}),
    ...(objectiveControlInit
      ? {
          objectiveControl: objectiveControlInit,
          objectiveScores: { A: 0, B: 0 },
        }
      : {}),
  };

  return {
    ...baseState,
    units: [...playerUnits, ...enemies],
    ...(objectives && objectives.length > 0 ? { objectives } : {}),
    ...(hasIntel ? { combatIntel } : {}),
    initiative,
    scenarioInfo,
    ...(opts.stealthActive ? { stealth: { active: true, pois: [] } } : {}),
  };
};
