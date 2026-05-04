import { computeMovePath } from '../geometry/path';
import { computeReactionWindows } from '../geometry/los_window';
import type { Vec2 } from '../geometry/types';
import { v2Dist, v2Lerp } from '../geometry/vec2';
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
import { hasStealthBypass } from '../resolution/stealth';
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
import type { Faction, GameState, Unit } from '../state/GameState';
import { sumWeaponDescriptorParam } from '../resolution/weapon_descriptors';
import { resolveReactionPlan } from './reactions';
import type { Command, CommandResult, GameEvent, ReactionPlan } from './types';
import { CommandError } from './types';

/**
 * Dependency injected from the reducer to avoid a core → ai import. The
 * forced-move logic uses the AI's pathfinder + reaction planner.
 *
 * Both deps are passed through (rather than imported here) so this file
 * stays in `core/` without taking on an `ai/` dependency. The reducer is
 * the single injection point.
 */
export interface ImpulsiveDeps {
  readonly pathfind: (state: GameState, from: Vec2, to: Vec2) => Vec2;
  readonly planReactions: (
    state: GameState,
    defenderFaction: Faction,
    cmd: Command,
  ) => ReactionPlan;
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

/**
 * Stealth-patrol target: 1-UD step toward the nearest active POI on the
 * stealth state. Returns null when stealth is off, no POIs exist, or the
 * mover is too damaged to move (matches `pickAggressiveMove`'s gates).
 */
export const pickPatrolMove = (
  state: GameState,
  mover: Unit,
  deps: ImpulsiveDeps,
): Vec2 | null => {
  if (mover.damage === 'SUPPRESSED' || mover.damage === 'IMPEDED') return null;
  const pois = state.stealth?.pois ?? [];
  if (pois.length === 0) return null;
  let nearest: Vec2 | null = null;
  let nearestDist = Infinity;
  for (const p of pois) {
    const d = v2Dist(mover.position, p.position);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = p.position;
    }
  }
  if (!nearest) return null;
  return deps.pathfind(state, mover.position, nearest);
};

/**
 * Forced move: 1-UD step toward the picked target, going through the same
 * reaction-window + reaction-plan pipeline as a normal MOVE so opposing
 * units can react-shoot the impulse mover. We deliberately bypass
 * `moveAction` because it requires (and mutates) `activeActivation` and
 * runs `processPostAction` afterwards — IMPULSIVE has no activation slot
 * and must not trigger nested turnover (Trigger 1 is already inside a
 * failed-check branch; Trigger 2 is inside the turnover prelude).
 *
 * REACTION_HIT during forced move: the mover is stopped at the interrupt
 * t and damage from the reaction is applied (via resolveShot inside the
 * reaction resolver). No turnover follows — this is the deliberate
 * difference from normal MOVE.
 */
const forcedMove = (
  state: GameState,
  mover: Unit,
  rawTarget: Vec2,
  cmdIndex: number,
  deps: ImpulsiveDeps,
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

  const oppFaction: Faction = mover.faction === 'A' ? 'B' : 'A';
  // Synthetic MOVE command for the reaction planner — only `unitId` and
  // `target` are read by `planReactions`. The plan uses the path endpoint
  // as the target (not rawTarget), matching what actually gets traversed.
  const syntheticCmd: Command = {
    type: 'MOVE',
    unitId: mover.id,
    target: path.endpoint,
  };
  const stealthSafe = hasStealthBypass(
    mover,
    mover.position,
    path.endpoint,
    state.terrain,
  );
  const plan: ReactionPlan = stealthSafe
    ? { markers: [] }
    : deps.planReactions(state, oppFaction, syntheticCmd);

  const enemiesForLOS = state.units
    .filter((o) => o.faction !== mover.faction && isUnitAlive(o))
    .map((o) => ({
      id: o.id,
      circle: getUnitCircle(o),
      prone: o.stance === 'PRONE',
    }));
  const reactionWindows = stealthSafe
    ? []
    : computeReactionWindows(
        mover.position,
        path.endpoint,
        mover.radius,
        enemiesForLOS,
        state.terrain,
        { moverProne: mover.stance === 'PRONE' },
      );

  const reactionResult = resolveReactionPlan(
    state,
    mover.id,
    mover.position,
    path.endpoint,
    plan,
    cmdIndex,
    'impulsive-reaction',
  );
  const finalEndpoint =
    reactionResult.interruptT !== null
      ? v2Lerp(mover.position, path.endpoint, reactionResult.interruptT)
      : path.endpoint;
  const next = updateUnit(reactionResult.state, mover.id, {
    position: finalEndpoint,
  });
  const moveEvent: GameEvent = {
    type: 'MOVE_RESOLVED',
    unitId: mover.id,
    from: mover.position,
    to: finalEndpoint,
    stopReason: path.stopReason,
    distance: v2Dist(mover.position, finalEndpoint),
    reactionWindows,
    interruptedByMarker: reactionResult.interruptedByMarker,
  };
  return { state: next, events: [moveEvent, ...reactionResult.events] };
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
 * runs through `resolveReactionPlan` directly (NOT `moveAction`), which
 * resolves reactions and applies damage but never calls `turnover` or
 * `processPostAction` — so the executor remains single-pass and cannot
 * re-enter `turnover` even when reactions kill the impulse mover.
 *
 * Trait interactions:
 *  - CANNON_FODDER: forced-shoot path doesn't run turnover (no interaction);
 *    forced-move killed by a reaction also doesn't trigger turnover here
 *    (CANNON_FODDER's "own death suppresses turnover" rule still applies
 *    on the *outer* turnover, e.g. PASS_INITIATIVE in Trigger 2).
 *  - FRAGILE: forced-shoot's hit accumulation honours FRAGILE +1 via the
 *    standard resolveShot path — no special handling needed.
 *  - STEALTH: `hasStealthBypass` zeroes out the reaction plan when the
 *    forced-move stays within a single cover polygon, mirroring `moveAction`.
 *  - FANATIC: the standard reaction resolver already lets IMPEDED-only
 *    hits pass without halting the path (mover keeps rolling).
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
        const out = forcedMove(working, unit, moveTarget, cmdIndex, deps);
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

/**
 * Stealth-patrol action for an enemy unit: 1-UD step toward the nearest
 * POI. Unlike IMPULSIVE, patrol does NOT shoot — stealth-state enemies
 * are unaware of the player's presence even when standing on the POI.
 *
 * No-op (and no activation consumed) when there are no POIs to chase.
 * The plan calls this out explicitly: enemies should stand still, not
 * burn their round-slot, when the player has made no noise.
 */
export const executePatrolAction = (
  state: GameState,
  unitId: string,
  cmdIndex: number,
  reason: 'CHECK_FAILED' | 'TURNOVER',
  deps: ImpulsiveDeps,
): CommandResult => {
  const unit = findUnit(state, unitId);
  if (!unit) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId}`);
  if (!isUnitAlive(unit)) return { state, events: [] };
  if (unit.damage === 'SUPPRESSED') return { state, events: [] };
  const moveTarget = pickPatrolMove(state, unit, deps);
  if (!moveTarget) return { state, events: [] };
  const out = forcedMove(state, unit, moveTarget, cmdIndex, deps);
  const next = updateUnit(out.state, unit.id, { activatedThisRound: true });
  return {
    state: next,
    events: [
      ...out.events,
      {
        type: 'PATROL_TRIGGERED',
        unitId: unit.id,
        reason,
      },
    ],
  };
};
