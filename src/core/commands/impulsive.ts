import { computeMovePath } from '../geometry/path';
import type { Vec2 } from '../geometry/types';
import { v2Dist } from '../geometry/vec2';
import {
  applyCoverToProfile,
  profileExpectedHits,
} from '../resolution/dice';
import { targetHasCover } from '../resolution/cover';
import { resolveShot } from '../resolution/shooting';
import {
  listAvailableShootModes,
  type AvailableShootMode,
} from '../resolution/shoot_modes';
import { getImpulsiveVariant, sumTraitParams } from '../traits/types';
import {
  findUnit,
  getUnitCircle,
  isUnitAlive,
  movementBlockingPolygons,
  movementEnterStopPolygons,
  movementExitStopPolygons,
  updateUnit,
} from '../state/GameState';
import type { GameState, Unit } from '../state/GameState';
import { sumWeaponDescriptorParam } from '../resolution/weapon_descriptors';
import type { CommandResult, GameEvent } from './types';
import { CommandError } from './types';

/**
 * Dependency injected from the reducer to avoid a core → ai import. The
 * forced-move logic uses the AI's pathfinder to route around HARD walls.
 */
export interface ImpulsiveDeps {
  readonly pathfind: (state: GameState, from: Vec2, to: Vec2) => Vec2;
}

interface ShootChoice {
  readonly targetId: string;
  readonly mode: AvailableShootMode['mode'];
  readonly weaponId: string;
  readonly participantIds: ReadonlyArray<string>;
}

const damageRank = (d: Unit['damage']): number =>
  d === 'KILLED' ? 3 : d === 'SUPPRESSED' ? 2 : d === 'IMPEDED' ? 1 : 0;

/**
 * Score an AvailableShootMode entry by expected net hits against the target.
 * Cover is folded in (drops the lowest-threshold die). ARMOR(N) and the
 * shooter weapon's ARMOR_PIERCE(M) trim the result, mirroring the reducer's
 * net-hits computation.
 */
const scoreShot = (
  state: GameState,
  shooter: Unit,
  target: Unit,
  opt: AvailableShootMode,
): number => {
  const cover = targetHasCover(shooter, target, state.terrain);
  const profile = cover ? applyCoverToProfile(opt.profile) : opt.profile;
  const ev = profileExpectedHits(profile);
  const targetArmor = sumTraitParams(target, 'ARMOR');
  const weapon = shooter.weapons.find((w) => w.id === opt.weaponId);
  const piercing = weapon ? sumWeaponDescriptorParam(weapon, 'ARMOR_PIERCE') : 0;
  const effectiveArmor = Math.max(0, targetArmor - piercing);
  return ev - effectiveArmor;
};

/**
 * Pick the (target, mode, weapon) tuple with the highest expected net hits.
 * Tiebreakers: target with the most damage taken, then nearest. Returns null
 * when no legal shot exists from the shooter's current position.
 */
export const pickAggressiveShoot = (
  state: GameState,
  shooter: Unit,
): ShootChoice | null => {
  if (shooter.damage === 'SUPPRESSED') return null;
  let best: ShootChoice | null = null;
  let bestScore = -Infinity;
  let bestDamageRank = -1;
  let bestDist = Infinity;

  for (const target of state.units) {
    if (target.faction === shooter.faction) continue;
    if (!isUnitAlive(target)) continue;
    const opts = listAvailableShootModes(state, shooter.id, target.id, 'ACTIVE');
    if (opts.length === 0) continue;
    const dist = v2Dist(shooter.position, target.position);
    const dmgR = damageRank(target.damage);
    for (const opt of opts) {
      const score = scoreShot(state, shooter, target, opt);
      const better =
        score > bestScore + 1e-9 ||
        (Math.abs(score - bestScore) < 1e-9 &&
          (dmgR > bestDamageRank ||
            (dmgR === bestDamageRank && dist < bestDist)));
      if (better) {
        bestScore = score;
        bestDamageRank = dmgR;
        bestDist = dist;
        best = {
          targetId: target.id,
          mode: opt.mode,
          weaponId: opt.weaponId,
          participantIds: opt.participantIds,
        };
      }
    }
  }
  return best;
};

/**
 * Pick a 1-UD step toward the nearest alive enemy, routing around HARD
 * walls via the injected pathfinder. Returns null when no enemy is alive.
 */
export const pickAggressiveMove = (
  state: GameState,
  mover: Unit,
  deps: ImpulsiveDeps,
): Vec2 | null => {
  if (mover.damage === 'SUPPRESSED' || mover.damage === 'IMPEDED') return null;
  let nearest: Unit | null = null;
  let nearestDist = Infinity;
  for (const e of state.units) {
    if (e.faction === mover.faction) continue;
    if (!isUnitAlive(e)) continue;
    const d = v2Dist(mover.position, e.position);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = e;
    }
  }
  if (!nearest) return null;
  return deps.pathfind(state, mover.position, nearest.position);
};

const forcedMove = (
  state: GameState,
  mover: Unit,
  rawTarget: Vec2,
): { state: GameState; events: GameEvent[] } => {
  const enemyCircles = state.units
    .filter((o) => o.faction !== mover.faction && isUnitAlive(o))
    .map(getUnitCircle);
  const friendlyCircles = state.units
    .filter(
      (o) => o.faction === mover.faction && o.id !== mover.id && isUnitAlive(o),
    )
    .map(getUnitCircle);
  const stoppingPolygons = movementBlockingPolygons(state.terrain, mover.position);
  const enterStopPolygons = movementEnterStopPolygons(state.terrain);
  const exitStopPolygons = movementExitStopPolygons(state.terrain, mover.position);
  const path = computeMovePath(mover.position, rawTarget, {
    polygons: stoppingPolygons,
    enterStopPolygons,
    exitStopPolygons,
    enemyCircles,
    friendlyCircles,
    moverRadius: mover.radius,
  });
  const next = updateUnit(state, mover.id, { position: path.endpoint });
  const event: GameEvent = {
    type: 'MOVE_RESOLVED',
    unitId: mover.id,
    from: mover.position,
    to: path.endpoint,
    stopReason: path.stopReason,
    distance: path.distance,
    reactionWindows: [],
    interruptedByMarker: -1,
  };
  return { state: next, events: [event] };
};

/**
 * Execute the IMPULSIVE forced action for `unitId`. Marks the unit
 * `activatedThisRound = true` regardless of outcome (per rule 5: the
 * impulse consumes the unit's activation slot for the round). Emits an
 * `IMPULSIVE_TRIGGERED` event tagging the variant + trigger reason +
 * the kind of action that was performed (or NONE when no legal action).
 *
 * Recursion guard: `executeImpulsiveAction` must be invoked with the
 * triggering unit's own faction holding initiative — this matches both
 * triggers (CHECK_FAILED is during the holder's own check; TURNOVER's
 * outgoing-side hook runs *before* the holder swap). The forced shoot
 * never triggers turnover (resolveShot doesn't), and the forced move
 * carries no reactionPlan (no REACTION_HIT possible), so the executor
 * is single-pass and cannot re-enter `turnover` directly.
 */
export const executeImpulsiveAction = (
  state: GameState,
  unitId: string,
  cmdIndex: number,
  reason: 'CHECK_FAILED' | 'TURNOVER',
  deps: ImpulsiveDeps,
): CommandResult => {
  const unit = findUnit(state, unitId);
  if (!unit) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId}`);
  if (state.initiative.holder !== unit.faction) {
    throw new CommandError(
      'IMPULSIVE_WRONG_HOLDER',
      `executeImpulsiveAction must run while ${unit.faction} holds initiative`,
    );
  }
  const variant = getImpulsiveVariant(unit);
  if (!variant) {
    throw new CommandError(
      'NOT_IMPULSIVE',
      `Unit ${unitId} carries no IMPULSIVE_* trait`,
    );
  }

  const events: GameEvent[] = [];
  let working = state;
  let action: 'SHOOT' | 'MOVE' | 'NONE' = 'NONE';

  if (isUnitAlive(unit) && unit.damage !== 'SUPPRESSED') {
    const shoot = pickAggressiveShoot(working, unit);
    if (shoot) {
      const out = resolveShot({
        state: working,
        shooterId: unit.id,
        targetId: shoot.targetId,
        mode: shoot.mode,
        participantIds: shoot.participantIds,
        weaponMode: 'ACTIVE',
        weaponId: shoot.weaponId,
        rngLabel: `impulsive:${reason.toLowerCase()}:${unit.id}`,
        cmdIndex,
      });
      working = out.state;
      events.push(...out.events);
      action = 'SHOOT';
    } else if (unit.damage !== 'IMPEDED') {
      const moveTarget = pickAggressiveMove(working, unit, deps);
      if (moveTarget) {
        const out = forcedMove(working, unit, moveTarget);
        working = out.state;
        events.push(...out.events);
        action = 'MOVE';
      }
    }
  }

  // Mark activated regardless — failed/none impulse still consumes the slot.
  working = updateUnit(working, unit.id, { activatedThisRound: true });

  events.push({
    type: 'IMPULSIVE_TRIGGERED',
    unitId: unit.id,
    variant,
    reason,
    action,
  });

  return { state: working, events };
};
