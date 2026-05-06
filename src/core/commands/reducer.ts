import { hasLOS } from '../geometry/los';
import { computeReactionWindows } from '../geometry/los_window';
import { hasStealthBypass } from '../resolution/stealth';
import { computeMovePath } from '../geometry/path';
import { isPointInPolygon } from '../geometry/polygon';
import { TRAITS } from '../traits/registry';
import { getUnitTraits, isImpulsive, unitHasTrait } from '../traits/types';
import {
  executeImpulsiveAction,
  executePatrolAction,
  type ImpulsiveDeps,
} from './impulsive';
import { pathfindingStepToward } from '../../ai/navigation';
import { planReactions } from '../../ai/reaction';

const IMPULSIVE_DEPS: ImpulsiveDeps = {
  pathfind: pathfindingStepToward,
  planReactions,
};
import {
  climbDestination,
  distToPolygonEdge,
  findContactedDoor,
  findContactedHardWall,
  findContactedSoftTerrain,
  traverseDestination,
  vaultDestination,
} from '../geometry/wallTraversal';
import { TERRAIN_INTERACT_REACH_PIXELS } from '../rules/constants';
import type { Vec2 } from '../geometry/types';
import { v2Dist, v2Lerp } from '../geometry/vec2';
import { resolveShot } from '../resolution/shooting';
import {
  CRAWL_MAX_DISTANCE_PIXELS,
  D6_SIDES,
  MELEE_SUPPORT_CAP,
  TURNOVER_MOMENTUM_GRANT,
  UNIT_DISTANCE_PIXELS,
  VAULT_HEIGHT_THRESHOLD_PIXELS,
} from '../rules/constants';
import { deriveRng } from '../rng/sfc32';
import { buildDiceProfile, rollProfile } from '../resolution/dice';
import {
  EMPTY_COMBAT_INTEL,
  resolveCombatIntelLevel,
} from '../resolution/combat_intel';
import type {
  ActiveActivation,
  DamageState,
  Faction,
  GameState,
  Unit,
} from '../state/GameState';
import {
  findUnit,
  getUnitCircle,
  isUnitAlive,
  movementBlockingPolygons,
  movementEnterStopPolygons,
  movementExitStopPolygons,
  updateTerrain,
  updateUnit,
} from '../state/GameState';
import type {
  Command,
  CommandResult,
  GameEvent,
  ReactionPlan,
  ShootMode,
  TurnoverReason,
} from './types';
import { CommandError } from './types';
import {
  cycleScoreDelta,
  nextObjectiveControl,
} from '../scenario/objectiveControl';
import {
  resolveReactionPlan,
  type ReactionResolveResult,
} from './reactions';
import {
  anyEnemySpotsPlayer,
  applyDerivedPois,
  derivePoisFromCommand,
  evaluateStealthBreak,
  prunePoisOnTurnover,
  redeemPendingStealthBreak,
} from './stealth';

const opponent = (f: Faction): Faction => (f === 'A' ? 'B' : 'A');

/** True if any of `u`'s traits bypass the melee status penalty (STALWART). */
const meleeIgnoresStatus = (u: Unit): boolean => {
  for (const inst of getUnitTraits(u)) {
    if (TRAITS[inst.id]?.meleeIgnoresStatusPenalty) return true;
  }
  return false;
};

/**
 * Apply trait-based caps on `actionsRemaining` for an activation. Returns
 * undefined when no trait cap applies (use the default for the activation
 * kind).
 */
const capActionsForTraits = (u: Unit): number | undefined => {
  let cap: number | undefined;
  for (const inst of getUnitTraits(u)) {
    const def = TRAITS[inst.id];
    if (def?.maxActionsPerActivation !== undefined) {
      cap = cap === undefined
        ? def.maxActionsPerActivation
        : Math.min(cap, def.maxActionsPerActivation);
    }
  }
  return cap;
};

const bumpCommandCount = (s: GameState): GameState => ({
  ...s,
  commandCount: s.commandCount + 1,
});

/**
 * Compute the post-reaction outcome with CANNON_FODDER bypass.
 * Rule (民兵團 強徵兵): suppression / kill of a CANNON_FODDER unit during
 * its own activation does NOT cause turnover. The hit still resolves
 * (target dies / gets suppressed), but the activating side keeps
 * initiative. For non-CANNON_FODDER movers, we keep the existing
 * REACTION_HIT → turnover semantics.
 */
const reactionOutcomeAfterFodder = (
  reactionTarget: Unit | undefined,
  reactionResult: { suppressOrKillCaused: boolean },
): 'REACTION_HIT' | 'SUCCESS' => {
  if (!reactionResult.suppressOrKillCaused) return 'SUCCESS';
  if (reactionTarget && unitHasTrait(reactionTarget, 'CANNON_FODDER')) {
    return 'SUCCESS';
  }
  return 'REACTION_HIT';
};

const setMomentum = (
  s: GameState,
  faction: Faction,
  amount: number,
): GameState => ({
  ...s,
  initiative: {
    ...s.initiative,
    momentum: { ...s.initiative.momentum, [faction]: amount },
  },
});

const setActivation = (
  s: GameState,
  act: ActiveActivation | null,
): GameState => ({
  ...s,
  initiative: { ...s.initiative, activeActivation: act },
});

/**
 * Bump the player-side budget. Called by the three activate*() entry points
 * (SPEND, CHECK regardless of success, OVERDRAFT) when the active unit is
 * faction A. Drives mission deadlines via state.initiative.playerActivations.
 */
const bumpPlayerActivationsIf = (s: GameState, faction: Faction): GameState =>
  faction === 'A'
    ? {
        ...s,
        initiative: {
          ...s.initiative,
          playerActivations: s.initiative.playerActivations + 1,
        },
      }
    : s;

const markUnitActivated = (s: GameState, unitId: string): GameState => ({
  ...s,
  units: s.units.map((u) =>
    u.id === unitId ? { ...u, activatedThisRound: true } : u,
  ),
});

const requireFreshHolderUnit = (s: GameState, unitId: string): Unit => {
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `Unit ${unitId} is dead`);
  if (u.faction !== s.initiative.holder) {
    throw new CommandError(
      'NOT_HOLDER',
      `Unit ${unitId} (${u.faction}) is not on holder ${s.initiative.holder}`,
    );
  }
  if (s.initiative.activeActivation) {
    throw new CommandError(
      'ALREADY_ACTIVE',
      `Activation ${s.initiative.activeActivation.unitId} already in progress`,
    );
  }
  if (u.lockedThisInitiative === true) {
    throw new CommandError(
      'UNIT_LOCKED',
      `Unit ${unitId} already FORCED_END this initiative — can't be activated again`,
    );
  }
  return u;
};

/**
 * Hand initiative to the opponent. Both sides reset to 0; the new holder
 * receives `granted` momentum (default 2, or overridden e.g. for overdraft).
 */
const turnover = (
  s: GameState,
  reason: TurnoverReason,
  granted: number,
  cmdIndex: number,
): CommandResult => {
  const from = s.initiative.holder;
  // Rule 5 (IMPULSIVE) Trigger 2: any IMPULSIVE unit on the OUTGOING side
  // that hasn't acted this round is forced to act before the swap. Iterate
  // in units-array order so behaviour is deterministic across snapshots /
  // replays. Forced shoots & moves can't recursively cause turnover, so a
  // single pass is enough — but units removed from the eligibility set by
  // earlier triggers (e.g. killed by their own forced action — impossible
  // in practice) are skipped via the in-loop liveness check.
  let working = s;
  const accumulatedEvents: GameEvent[] = [];
  const candidateIds = working.units
    .filter(
      (u) =>
        u.faction === from &&
        isImpulsive(u) &&
        !u.activatedThisRound &&
        isUnitAlive(u),
    )
    .map((u) => u.id);
  for (const id of candidateIds) {
    const fresh = findUnit(working, id);
    if (!fresh || !isUnitAlive(fresh) || fresh.activatedThisRound) continue;
    const imp = executeImpulsiveAction(
      working,
      id,
      cmdIndex,
      'TURNOVER',
      IMPULSIVE_DEPS,
    );
    working = imp.state;
    accumulatedEvents.push(...imp.events);
  }
  s = working;
  // Stealth pending-break redemption — a SHOT or SPOTTED trigger that was
  // held back by the suppression-defer rule cashes in here, just before
  // the holder swap, so the new initiative phase begins with stealth off.
  const redeemed = redeemPendingStealthBreak(s);
  s = redeemed.state;
  const pendingRedeemEvents = redeemed.events;
  const to = opponent(from);
  const newMomentum: Record<Faction, number> = { A: 0, B: 0 };
  newMomentum[to] = granted;
  // Cycle bumps when initiative comes back to A (i.e., a full A→B→A
  // handoff cycle). Simple model: increment cycle whenever turnover's
  // `to` is 'A'. Per-cycle flags reset on bump.
  const cycleBump = to === 'A' ? 1 : 0;
  // Control-points scoring tick. Only mutates when scenario === 'control-points'
  // and the cycle just bumped — every other path falls through with the
  // existing maps untouched (so legacy / unrelated scenarios pay nothing).
  const isControlPoints =
    cycleBump > 0 && s.scenarioInfo?.mode === 'control-points';
  const prevControl = s.initiative.objectiveControl ?? {};
  const prevScores = s.initiative.objectiveScores ?? { A: 0, B: 0 };
  const newControl = isControlPoints
    ? nextObjectiveControl(s, prevControl)
    : prevControl;
  const weightsRaw = s.scenarioInfo?.params.objectiveWeights;
  const weights =
    isControlPoints && weightsRaw && typeof weightsRaw === 'object'
      ? (weightsRaw as Readonly<Record<string, number>>)
      : undefined;
  const delta = isControlPoints
    ? cycleScoreDelta(newControl, weights)
    : { A: 0, B: 0 };
  const newScores = isControlPoints
    ? {
        A: prevScores.A + delta.A,
        B: prevScores.B + delta.B,
      }
    : prevScores;
  // Stealth POI pruning — drops POIs whose `expiresAtCycle` has been
  // reached. Fires only on A→B turnovers (player just released
  // initiative); enemy→player turnovers leave POIs alone so the enemy
  // patrol next round can still see them.
  const prunedStealth = prunePoisOnTurnover(s.stealth, s.initiative.cycle, from);
  const next: GameState = {
    ...s,
    initiative: {
      holder: to,
      momentum: newMomentum,
      cycle: s.initiative.cycle + cycleBump,
      playerActivations: s.initiative.playerActivations,
      activeActivation: null,
      ...(isControlPoints ||
      s.initiative.objectiveScores !== undefined ||
      s.initiative.objectiveControl !== undefined
        ? {
            objectiveScores: newScores,
            objectiveControl: newControl,
          }
        : {}),
    },
    ...(prunedStealth !== s.stealth ? { stealth: prunedStealth } : {}),
    // lockedThisInitiative is per-initiative-phase: any turnover clears
    // it across all units regardless of cycle bump. Round-scoped flags
    // (activatedThisRound + cannotReactThisRound) only reset on bump.
    units: s.units.map((u) => {
      const out: Unit = u.lockedThisInitiative
        ? { ...u, lockedThisInitiative: false }
        : u;
      if (cycleBump > 0) {
        return {
          ...out,
          activatedThisRound: false,
          cannotReactThisRound: false,
        };
      }
      return out;
    }),
  };
  // Stealth-break LOS scan — runs once `next` reflects the post-swap
  // state. If any alive enemy can see any alive player under the 1UD
  // stealth cap, evaluate a SPOTTED break (subject to suppression-defer
  // rule). Skipped when stealth is already off (e.g. just redeemed above
  // or broken earlier this turn by a player SHOOT).
  let withScan = next;
  const scanEvents: GameEvent[] = [];
  if (next.stealth?.active === true && anyEnemySpotsPlayer(next)) {
    const br = evaluateStealthBreak(next, 'SPOTTED');
    withScan = br.state;
    scanEvents.push(...br.events);
  }
  // Stealth patrol: when initiative just swung from player → enemy AND
  // stealth is still active, every non-activated B unit patrols toward
  // the nearest POI. We run AFTER the holder swap and AFTER the LOS scan
  // so a SPOTTED break suppresses patrol (the enemy now reverts to normal
  // AI on their next activation). Patrol units that find no POI do
  // nothing (and don't burn their round slot — see plan §4 design note).
  let withPatrol = withScan;
  const patrolEvents: GameEvent[] = [];
  if (withScan.stealth?.active === true && to === 'B') {
    const patrolIds = withScan.units
      .filter(
        (u) => u.faction === 'B' && !u.activatedThisRound && isUnitAlive(u),
      )
      .map((u) => u.id);
    for (const id of patrolIds) {
      const fresh = findUnit(withPatrol, id);
      if (!fresh || !isUnitAlive(fresh) || fresh.activatedThisRound) continue;
      const pat = executePatrolAction(
        withPatrol,
        id,
        cmdIndex,
        'TURNOVER',
        IMPULSIVE_DEPS,
      );
      withPatrol = pat.state;
      patrolEvents.push(...pat.events);
    }
  }
  return {
    state: withPatrol,
    events: [
      ...accumulatedEvents,
      ...pendingRedeemEvents,
      {
        type: 'INITIATIVE_TURNOVER',
        from,
        to,
        reason,
        momentumGranted: granted,
      },
      ...scanEvents,
      ...patrolEvents,
    ],
  };
};

const activateSpend = (s: GameState, unitId: string): CommandResult => {
  const u = requireFreshHolderUnit(s, unitId);
  const cost = u.quality;
  const cur = s.initiative.momentum[u.faction];
  if (cur < cost) {
    throw new CommandError(
      'INSUFFICIENT_MOMENTUM',
      `Need ${cost}, have ${cur}; declare ACTIVATE_OVERDRAFT explicitly`,
    );
  }
  let next = setMomentum(s, u.faction, cur - cost);
  next = bumpPlayerActivationsIf(next, u.faction);
  next = markUnitActivated(next, u.id);
  next = setActivation(next, {
    unitId: u.id,
    kind: 'SPEND',
    actionsRemaining: 1,
    failureProtection: true,
    forcedTurnoverAfterAction: false,
  });
  return {
    state: next,
    events: [
      { type: 'MOMENTUM_SPENT', faction: u.faction, amount: cost },
      { type: 'ACTIVATION_BEGAN', unitId: u.id, kind: 'SPEND' },
    ],
  };
};

const activateCheck = (
  s: GameState,
  unitId: string,
  cmdIndex: number,
): CommandResult => {
  const u = requireFreshHolderUnit(s, unitId);
  const rng = deriveRng(s.seed, cmdIndex, 'activation:check');
  const roll = rng.rollDie(D6_SIDES);
  const success = roll >= u.quality;
  const checkEvent: GameEvent = {
    type: 'ACTIVATION_CHECK_ROLLED',
    unitId: u.id,
    threshold: u.quality,
    roll,
    success,
  };
  // Both success and failure consume one player activation slot — the
  // attempt itself is the resource-spending event for the budget clock.
  const bumped = bumpPlayerActivationsIf(s, u.faction);
  if (success) {
    let next = markUnitActivated(bumped, u.id);
    // Trait-based action cap (e.g., CUMBERSOME = 1) overrides unlimited.
    const cap = capActionsForTraits(u);
    next = setActivation(next, {
      unitId: u.id,
      kind: 'CHECK_SUCCESS',
      actionsRemaining: cap ?? -1,
      failureProtection: false,
      forcedTurnoverAfterAction: false,
      // CUMBERSOME (and any future trait cap): when all allowed actions are
      // spent, lock the unit for the rest of the initiative without turnover.
      lockWhenDone: cap !== undefined,
    });
    return {
      state: next,
      events: [
        checkEvent,
        { type: 'ACTIVATION_BEGAN', unitId: u.id, kind: 'CHECK_SUCCESS' },
      ],
    };
  }
  // Stealth: enemy (B) failed check → patrol toward nearest POI instead of
  // turnover. Mirrors IMPULSIVE in keeping initiative on the failing side
  // (the unit "wastes" its slot but stealth posture stays). Player-side
  // check failures fall through to normal IMPULSIVE / turnover handling.
  if (bumped.stealth?.active === true && u.faction === 'B') {
    const pat = executePatrolAction(
      bumped,
      u.id,
      cmdIndex,
      'CHECK_FAILED',
      IMPULSIVE_DEPS,
    );
    return { state: pat.state, events: [checkEvent, ...pat.events] };
  }
  // Stealth: player (A) check failure drops a POI at the failing unit's
  // position — the fumble "makes noise" the enemy patrol AI then steers
  // toward, just like a SHOOT/CRAWL/etc. POI. Falls through to IMPULSIVE
  // or turnover as normal.
  let postState = bumped;
  const failExtraEvents: GameEvent[] = [];
  if (bumped.stealth?.active === true && u.faction === 'A') {
    const dropped = applyDerivedPois(bumped, [
      { position: u.position, cause: 'CHECK_FAILED' },
    ]);
    postState = dropped.state;
    failExtraEvents.push(...dropped.events);
  }
  // Rule 5 (IMPULSIVE): a failed check on an IMPULSIVE unit forces the
  // variant-specific action and KEEPS initiative — no turnover, no momentum
  // grant. The unit's slot is consumed (executor sets activatedThisRound).
  if (isImpulsive(u)) {
    const imp = executeImpulsiveAction(
      postState,
      u.id,
      cmdIndex,
      'CHECK_FAILED',
      IMPULSIVE_DEPS,
    );
    return {
      state: imp.state,
      events: [checkEvent, ...failExtraEvents, ...imp.events],
    };
  }
  const t = turnover(
    postState,
    'CHECK_FAILED',
    TURNOVER_MOMENTUM_GRANT,
    cmdIndex,
  );
  return {
    state: t.state,
    events: [checkEvent, ...failExtraEvents, ...t.events],
  };
};

const activateOverdraft = (s: GameState, unitId: string): CommandResult => {
  const u = requireFreshHolderUnit(s, unitId);
  const cost = u.quality;
  const cur = s.initiative.momentum[u.faction];
  if (cur >= cost) {
    throw new CommandError(
      'OVERDRAFT_NOT_NEEDED',
      `Have ${cur} ≥ cost ${cost}; use ACTIVATE_SPEND`,
    );
  }
  const deficit = cost - cur;
  let next = setMomentum(s, u.faction, 0);
  next = bumpPlayerActivationsIf(next, u.faction);
  next = markUnitActivated(next, u.id);
  next = setActivation(next, {
    unitId: u.id,
    kind: 'OVERDRAFT',
    actionsRemaining: 1,
    failureProtection: false,
    forcedTurnoverAfterAction: true,
    overdraftDeficit: deficit,
  });
  return {
    state: next,
    events: [
      { type: 'MOMENTUM_SPENT', faction: u.faction, amount: cur },
      { type: 'OVERDRAFT_DECLARED', unitId: u.id, deficit },
      { type: 'ACTIVATION_BEGAN', unitId: u.id, kind: 'OVERDRAFT' },
    ],
  };
};

const endActivation = (s: GameState, cmdIndex: number): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act) {
    throw new CommandError('NO_ACTIVE_ACTIVATION', 'No activation to end');
  }
  const cleared = setActivation(s, null);
  const endedEvent: GameEvent = {
    type: 'ACTIVATION_ENDED',
    unitId: act.unitId,
    reason: act.forcedTurnoverAfterAction ? 'FORCED_TURNOVER' : 'NORMAL',
  };
  if (!act.forcedTurnoverAfterAction) {
    return { state: cleared, events: [endedEvent] };
  }
  const reason: TurnoverReason =
    act.kind === 'OVERDRAFT' ? 'OVERDRAFT' : 'ACTION_FAILED';
  const granted =
    act.kind === 'OVERDRAFT' && act.overdraftDeficit !== undefined
      ? act.overdraftDeficit
      : TURNOVER_MOMENTUM_GRANT;
  const t = turnover(cleared, reason, granted, cmdIndex);
  return { state: t.state, events: [endedEvent, ...t.events] };
};

const passInitiative = (s: GameState, cmdIndex: number): CommandResult => {
  if (s.initiative.activeActivation) {
    throw new CommandError(
      'ACTIVATION_IN_PROGRESS',
      'Cannot pass initiative while an activation is in progress',
    );
  }
  return turnover(s, 'VOLUNTARY', TURNOVER_MOMENTUM_GRANT, cmdIndex);
};

type ActionOutcome = 'SUCCESS' | 'FAILURE' | 'REACTION_HIT' | 'FORCED_END' | 'NORMAL_END';

/**
 * Apply per-action bookkeeping after an action command executes:
 *  - Decrement actionsRemaining (if not unlimited).
 *  - Trigger turnover for REACTION_HIT (always) or FAILURE (unless protected).
 *  - When activation runs out (count→0), end it; if forcedTurnoverAfterAction
 *    set (OVERDRAFT, forced-pay rescue), turnover with the appropriate reason.
 */
const processPostAction = (
  s: GameState,
  outcome: ActionOutcome,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act) return { state: s, events: [] };

  if (outcome === 'REACTION_HIT') {
    const cleared = setActivation(s, null);
    return turnover(cleared, 'REACTION_HIT', TURNOVER_MOMENTUM_GRANT, cmdIndex);
  }

  // CUMBERSOME (and other trait-capped activations): action failure locks the
  // unit for the rest of the initiative but does NOT cause turnover.
  if (outcome === 'FAILURE' && act.lockWhenDone) {
    const locked = updateUnit(s, act.unitId, { lockedThisInitiative: true });
    const cleared = setActivation(locked, null);
    return {
      state: cleared,
      events: [{ type: 'ACTIVATION_ENDED', unitId: act.unitId, reason: 'NORMAL' }],
    };
  }

  if (outcome === 'FAILURE' && !act.failureProtection) {
    const cleared = setActivation(s, null);
    return turnover(cleared, 'ACTION_FAILED', TURNOVER_MOMENTUM_GRANT, cmdIndex);
  }

  // NORMAL_END: action completed; activation ends without turnover and without
  // locking the unit. Used by COMMAND_MOVE and COMMAND_RALLY — the officer
  // finishes the command action but remains eligible for re-activation this round.
  if (outcome === 'NORMAL_END') {
    const cleared = setActivation(s, null);
    return {
      state: cleared,
      events: [
        { type: 'ACTIVATION_ENDED', unitId: act.unitId, reason: 'NORMAL' },
      ],
    };
  }

  // FORCED_END: action completed but activation ends without turnover.
  // Used by CRAWL (rule 4.5 — "該輪次不可再行動"), CLIMB (climb spec),
  // and MOVE that started inside DIFFICULT terrain (rule 4.2C — "移動結束
  // 後該單位這個主動權不得在進行任何行動"). The "this initiative" lockout:
  //   - activatedThisRound is already true (set by ACTIVATE_*), so the
  //     unit can't be re-activated this round.
  //   - lockedThisInitiative is set here so the unit can't be a
  //     FOCUSED/COMBINED/COMMAND_MOVE/COMMAND_RALLY participant for the
  //     rest of THIS initiative phase. Cleared on INITIATIVE_TURNOVER —
  //     once the opposing side takes over, reactions + REACTION-mode
  //     participation are unlocked again.
  // Distinct from `forcedTurnoverAfterAction` which DOES trigger turnover.
  if (outcome === 'FORCED_END') {
    const locked = updateUnit(s, act.unitId, {
      lockedThisInitiative: true,
    });
    const cleared = setActivation(locked, null);
    return {
      state: cleared,
      events: [
        { type: 'ACTIVATION_ENDED', unitId: act.unitId, reason: 'NORMAL' },
      ],
    };
  }

  const remaining =
    act.actionsRemaining > 0 ? act.actionsRemaining - 1 : act.actionsRemaining;

  if (remaining === 0) {
    // Trait-capped (e.g. CUMBERSOME): lock the unit this initiative on action
    // exhaustion regardless of action outcome, no turnover.
    if (act.lockWhenDone) {
      const locked = updateUnit(s, act.unitId, { lockedThisInitiative: true });
      const cleared = setActivation(locked, null);
      return {
        state: cleared,
        events: [{ type: 'ACTIVATION_ENDED', unitId: act.unitId, reason: 'NORMAL' }],
      };
    }
    const cleared = setActivation(s, null);
    if (act.forcedTurnoverAfterAction) {
      const reason: TurnoverReason =
        act.kind === 'OVERDRAFT' ? 'OVERDRAFT' : 'ACTION_FAILED';
      const granted =
        act.kind === 'OVERDRAFT' && act.overdraftDeficit !== undefined
          ? act.overdraftDeficit
          : TURNOVER_MOMENTUM_GRANT;
      const t = turnover(cleared, reason, granted, cmdIndex);
      return {
        state: t.state,
        events: [
          {
            type: 'ACTIVATION_ENDED',
            unitId: act.unitId,
            reason: 'FORCED_TURNOVER',
          },
          ...t.events,
        ],
      };
    }
    return {
      state: cleared,
      events: [
        { type: 'ACTIVATION_ENDED', unitId: act.unitId, reason: 'NORMAL' },
      ],
    };
  }

  const updated = setActivation(s, { ...act, actionsRemaining: remaining });
  return { state: updated, events: [] };
};


interface MoverPath {
  unitId: string;
  pathStart: Vec2;
  pathEnd: Vec2;
}

/**
 * Group reaction resolver — used by command-activation actions where multiple
 * movers share a single reaction plan. Each marker MUST specify
 * `targetUnitId`. When a hit suppresses or kills, the group is interrupted
 * at that t (the caller stops every mover at the same t).
 */
const resolveGroupReactionPlan = (
  s: GameState,
  movers: ReadonlyArray<MoverPath>,
  plan: ReactionPlan | undefined,
  cmdIndex: number,
): ReactionResolveResult => {
  const empty: ReactionResolveResult = {
    state: s,
    events: [],
    interruptedByMarker: -1,
    interruptT: null,
    suppressOrKillCaused: false,
  };
  if (!plan || plan.markers.length === 0) return empty;

  const sorted = [...plan.markers]
    .map((m, originalIndex) => ({ m, originalIndex }))
    .sort((a, b) => a.m.atT - b.m.atT);

  let working = s;
  const events: GameEvent[] = [];

  for (const { m, originalIndex } of sorted) {
    const targetId = m.targetUnitId;
    if (!targetId) continue;
    const moverInfo = movers.find((x) => x.unitId === targetId);
    if (!moverInfo) continue;
    const target = findUnit(working, targetId);
    if (!target || !isUnitAlive(target)) continue;

    const moverPos = v2Lerp(moverInfo.pathStart, moverInfo.pathEnd, m.atT);
    const shooter = findUnit(working, m.shooterId);
    if (!shooter) continue;
    if (!isUnitAlive(shooter)) continue;
    if (shooter.damage === 'SUPPRESSED') continue;
    if (shooter.cannotReactThisRound) continue;
    if (shooter.faction === target.faction) continue;

    let participantsValid = true;
    for (const pid of m.participantIds) {
      if (pid === m.shooterId) continue;
      const p = findUnit(working, pid);
      if (
        !p ||
        !isUnitAlive(p) ||
        p.damage === 'SUPPRESSED' ||
        p.cannotReactThisRound ||
        p.faction !== shooter.faction
      ) {
        participantsValid = false;
        break;
      }
    }
    if (!participantsValid) continue;

    const visibleHere = hasLOS(
      getUnitCircle(shooter),
      { center: moverPos, radius: target.radius },
      working.terrain,
      { aProne: shooter.stance === 'PRONE', bProne: target.stance === 'PRONE' },
    );
    if (!visibleHere) continue;

    const tempState = updateUnit(working, targetId, { position: moverPos });
    const shot = resolveShot({
      state: tempState,
      shooterId: m.shooterId,
      targetId,
      mode: m.mode,
      weaponId: m.weaponId,
      participantIds: m.participantIds,
      weaponMode: 'REACTION',
      rngLabel: `command-reaction:${cmdIndex}:m${originalIndex}`,
      cmdIndex,
    });
    working = updateUnit(shot.state, targetId, { position: target.position });
    events.push(...shot.events);

    if (shot.hits === 0) {
      working = updateUnit(working, m.shooterId, { cannotReactThisRound: true });
      for (const pid of m.participantIds) {
        if (pid === m.shooterId) continue;
        working = updateUnit(working, pid, { cannotReactThisRound: true });
      }
      continue;
    }
    // FANATIC: see resolveReactionPlan — IMPEDED-only hits don't halt the
    // group either; the FANATIC mover keeps rolling toward its endpoint.
    if (
      unitHasTrait(target, 'FANATIC') &&
      !shot.causedSuppressOrKill
    ) {
      continue;
    }
    return {
      state: working,
      events,
      interruptedByMarker: originalIndex,
      interruptT: m.atT,
      suppressOrKillCaused: shot.causedSuppressOrKill,
    };
  }
  return {
    state: working,
    events,
    interruptedByMarker: -1,
    interruptT: null,
    suppressOrKillCaused: false,
  };
};

const moveAction = (
  s: GameState,
  unitId: string,
  target: Vec2,
  reactionPlan: ReactionPlan | undefined,
  cmdIndex: number,
  endProne = false,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== unitId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `Unit ${unitId} is not the active unit`,
    );
  }
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `Unit ${unitId} is dead`);
  if (u.damage === 'IMPEDED' || u.damage === 'SUPPRESSED') {
    throw new CommandError(
      'CANNOT_MOVE',
      `Unit ${unitId} cannot move while ${u.damage}`,
    );
  }

  // Difficult-terrain start-in restriction (rule 4.2C — 穿越與脫離).
  const startedInDifficult = s.terrain.some(
    (t) => t.kind === 'DIFFICULT' && isPointInPolygon(u.position, t.polygon),
  );
  let effectiveTarget = target;
  if (startedInDifficult) {
    const dx = target.x - u.position.x;
    const dy = target.y - u.position.y;
    const len = Math.hypot(dx, dy);
    if (len > UNIT_DISTANCE_PIXELS) {
      effectiveTarget = {
        x: u.position.x + (dx / len) * UNIT_DISTANCE_PIXELS,
        y: u.position.y + (dy / len) * UNIT_DISTANCE_PIXELS,
      };
    }
  }

  const enemyCircles = s.units
    .filter((o) => o.faction !== u.faction && isUnitAlive(o))
    .map(getUnitCircle);
  // Friendly bases (excluding self) — the mover may pass through them, but
  // the final position must not overlap any (rule 4.2A).
  const friendlyCircles = s.units
    .filter(
      (o) => o.faction === u.faction && o.id !== u.id && isUnitAlive(o),
    )
    .map(getUnitCircle);
  // Unified terrain-edge rule: every terrain transition costs a move action.
  //  - HARD / BLOCKER / HIGH_GROUND are sweep-blocked (must VAULT / CLIMB).
  //  - DIFFICULT + SOFT are walk-through-able but the centre line stops at
  //    the boundary in both directions — entering AND leaving each consume
  //    one move; a separate move perpendicular crosses the edge.
  // Inside-DIFFICULT travel still has its own 1-UD slowing cap (4.2C);
  // SOFT has no internal slowing — only the edge transitions cost.
  const stoppingPolygons = movementBlockingPolygons(s.terrain, u.position);
  const enterStopPolygons = movementEnterStopPolygons(s.terrain);
  const exitStopPolygons = movementExitStopPolygons(s.terrain, u.position);
  // LOS during movement only blocked by terrain that actually breaks vision —
  // computed inside the LOS helpers from terrains; for now we forward all.
  const losTerrains = s.terrain;

  const path = computeMovePath(u.position, effectiveTarget, {
    polygons: stoppingPolygons,
    enterStopPolygons,
    exitStopPolygons,
    enemyCircles,
    friendlyCircles,
    moverRadius: u.radius,
  });

  const enemiesForLOS = s.units
    .filter((o) => o.faction !== u.faction && isUnitAlive(o))
    .map((o) => ({
      id: o.id,
      circle: getUnitCircle(o),
      prone: o.stance === 'PRONE',
    }));
  // STEALTH (rule 隱身): a unit moving wholly inside one cover-providing
  // polygon is immune to reactions for the action — short-circuit windows.
  const stealthSafe = hasStealthBypass(u, u.position, path.endpoint, s.terrain);
  const reactionWindows = stealthSafe
    ? []
    : computeReactionWindows(
        u.position,
        path.endpoint,
        u.radius,
        enemiesForLOS,
        losTerrains,
        { moverProne: u.stance === 'PRONE' },
      );

  // Stand-up at start (rule 4.5 — 起立: 移動行動開始時宣告). Standing MOVE
  // implicitly stands the unit up if it was prone, so reaction LOS during the
  // move uses standing semantics (low walls don't block, etc.).
  const standingState =
    u.stance === 'PRONE' ? updateUnit(s, unitId, { stance: 'STANDING' }) : s;

  const reactionResult = resolveReactionPlan(
    standingState,
    unitId,
    u.position,
    path.endpoint,
    reactionPlan,
    cmdIndex,
  );

  const rawInterruptEndpoint =
    reactionResult.interruptT !== null
      ? v2Lerp(u.position, path.endpoint, reactionResult.interruptT)
      : path.endpoint;
  // When reaction interrupts mid-move, re-resolve the stop point against
  // friendlyCircles so the unit doesn't overlap an ally it passed through.
  const finalEndpoint =
    reactionResult.interruptT !== null
      ? computeMovePath(u.position, rawInterruptEndpoint, {
          polygons: [],
          enterStopPolygons: [],
          exitStopPolygons: [],
          enemyCircles: [],
          friendlyCircles,
          moverRadius: u.radius,
        }).endpoint
      : rawInterruptEndpoint;
  // End-of-move stance: explicit endProne flag → drop prone (rule 4.5).
  // Forbidden when starting in difficult terrain (rule 4.2C). Suppression
  // during reaction already sets PRONE via the shooting resolver, so we only
  // need to apply the flag in the no-suppress path. NO_PRONE units silently
  // drop the flag — UI gates the toggle, but defensive here for AI/scripted
  // callers.
  const wantEndProne = endProne && !startedInDifficult && !unitHasTrait(u, 'NO_PRONE');
  const moved = updateUnit(reactionResult.state, unitId, {
    position: finalEndpoint,
    ...(wantEndProne ? { stance: 'PRONE' as const } : {}),
  });

  const moveEvent: GameEvent = {
    type: 'MOVE_RESOLVED',
    unitId,
    from: u.position,
    to: finalEndpoint,
    stopReason: path.stopReason,
    distance: v2Dist(u.position, finalEndpoint),
    reactionWindows,
    interruptedByMarker: reactionResult.interruptedByMarker,
  };

  // Difficult-terrain start-in: activation must end after this single move
  // (no turnover) — rule 4.2C "移動結束後該單位這個主動權不得在進行任何行動".
  // CANNON_FODDER bypasses the REACTION_HIT turnover (rule 民兵團 強徵兵).
  const outcome: ActionOutcome =
    reactionOutcomeAfterFodder(u, reactionResult) === 'REACTION_HIT'
      ? 'REACTION_HIT'
      : startedInDifficult
        ? 'FORCED_END'
        : 'SUCCESS';
  return applyAutoMeleeAndPostAction(moved, unitId, outcome, cmdIndex, [
    moveEvent,
    ...reactionResult.events,
  ]);
};

/**
 * CRAWL (rule 4.5 — 匍匐): max 1 unit-distance, ends with stance = PRONE,
 * activation ends without turnover. Reaction windows behave like MOVE.
 *
 * Allowed regardless of starting stance — if standing, the unit drops prone
 * for the action (UI sugar, simplifies pre-move stance picker per project
 * design).
 */
const crawlAction = (
  s: GameState,
  unitId: string,
  target: Vec2,
  reactionPlan: ReactionPlan | undefined,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== unitId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `Unit ${unitId} is not the active unit`,
    );
  }
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `Unit ${unitId} is dead`);
  if (u.damage === 'IMPEDED' || u.damage === 'SUPPRESSED') {
    throw new CommandError(
      'CANNOT_MOVE',
      `Unit ${unitId} cannot crawl while ${u.damage}`,
    );
  }
  if (unitHasTrait(u, 'NO_PRONE')) {
    throw new CommandError(
      'NO_PRONE',
      `Unit ${unitId} has NO_PRONE — cannot crawl`,
    );
  }
  // Rule 4.2C — when starting inside difficult terrain, crawling is forbidden.
  const startedInDifficult = s.terrain.some(
    (t) => t.kind === 'DIFFICULT' && isPointInPolygon(u.position, t.polygon),
  );
  if (startedInDifficult) {
    throw new CommandError(
      'NO_CRAWL_FROM_DIFFICULT',
      `Cannot crawl out of difficult terrain (rule 4.2C)`,
    );
  }

  // Cap target to within CRAWL_MAX_DISTANCE_PIXELS of current position.
  const dx = target.x - u.position.x;
  const dy = target.y - u.position.y;
  const len = Math.hypot(dx, dy);
  const cappedTarget: Vec2 =
    len <= CRAWL_MAX_DISTANCE_PIXELS
      ? target
      : {
          x: u.position.x + (dx / len) * CRAWL_MAX_DISTANCE_PIXELS,
          y: u.position.y + (dy / len) * CRAWL_MAX_DISTANCE_PIXELS,
        };

  const enemyCircles = s.units
    .filter((o) => o.faction !== u.faction && isUnitAlive(o))
    .map(getUnitCircle);
  const friendlyCircles = s.units
    .filter(
      (o) => o.faction === u.faction && o.id !== u.id && isUnitAlive(o),
    )
    .map(getUnitCircle);
  const stoppingPolygons = movementBlockingPolygons(s.terrain, u.position);
  const enterStopPolygons = movementEnterStopPolygons(s.terrain);
  const exitStopPolygons = movementExitStopPolygons(s.terrain, u.position);

  const path = computeMovePath(u.position, cappedTarget, {
    polygons: stoppingPolygons,
    enterStopPolygons,
    exitStopPolygons,
    enemyCircles,
    friendlyCircles,
    moverRadius: u.radius,
  });

  // Mover is prone for the entire crawl (low walls block LOS, etc.).
  const enemiesForLOS = s.units
    .filter((o) => o.faction !== u.faction && isUnitAlive(o))
    .map((o) => ({
      id: o.id,
      circle: getUnitCircle(o),
      prone: o.stance === 'PRONE',
    }));
  const stealthSafe = hasStealthBypass(u, u.position, path.endpoint, s.terrain);
  const reactionWindows = stealthSafe
    ? []
    : computeReactionWindows(
        u.position,
        path.endpoint,
        u.radius,
        enemiesForLOS,
        s.terrain,
        { moverProne: true },
      );

  // Force unit to prone *before* reaction resolution so LOS checks during the
  // crawl correctly use prone semantics (low-wall cover, etc.).
  const proneState = updateUnit(s, unitId, { stance: 'PRONE' });
  const reactionResult = resolveReactionPlan(
    proneState,
    unitId,
    u.position,
    path.endpoint,
    reactionPlan,
    cmdIndex,
  );

  const finalEndpoint =
    reactionResult.interruptT !== null
      ? v2Lerp(u.position, path.endpoint, reactionResult.interruptT)
      : path.endpoint;
  const moved = updateUnit(reactionResult.state, unitId, {
    position: finalEndpoint,
    stance: 'PRONE',
  });

  const moveEvent: GameEvent = {
    type: 'MOVE_RESOLVED',
    unitId,
    from: u.position,
    to: finalEndpoint,
    stopReason: path.stopReason,
    distance: v2Dist(u.position, finalEndpoint),
    reactionWindows,
    interruptedByMarker: reactionResult.interruptedByMarker,
  };

  // Crawl ends activation without turnover (rule 4.5 — 該輪次不可再行動，但
  // 不易手). Reaction hits still cause turnover via REACTION_HIT — except
  // CANNON_FODDER (民兵團 強徵兵) which absorbs the hit without turnover.
  const outcome: ActionOutcome =
    reactionOutcomeAfterFodder(u, reactionResult) === 'REACTION_HIT'
      ? 'REACTION_HIT'
      : 'FORCED_END';
  return applyAutoMeleeAndPostAction(moved, unitId, outcome, cmdIndex, [
    moveEvent,
    ...reactionResult.events,
  ]);
};

/**
 * Sanity check used by VAULT/CLIMB: their destination is geometrically
 * derived (mirror or far-edge of the touched wall), so it could land on top
 * of another unit. Reject the action with a friendly error rather than
 * silently producing an overlap.
 */
const ensureLandingClear = (
  s: GameState,
  mover: Unit,
  dest: Vec2,
): void => {
  for (const o of s.units) {
    if (o.id === mover.id) continue;
    if (!isUnitAlive(o)) continue;
    const dx = o.position.x - dest.x;
    const dy = o.position.y - dest.y;
    const minDist = mover.radius + o.radius - 0.5;
    if (dx * dx + dy * dy < minDist * minDist) {
      throw new CommandError(
        'LANDING_BLOCKED',
        `Destination occupied by ${o.id}`,
      );
    }
  }
};

/**
 * VAULT (rule 4.2 B): only valid when in contact with a HARD wall whose
 * height ≤ 1 unit-distance. Mover is placed on the opposite side; vault
 * counts as a movement, so reaction fire is allowed at the start (t=0) and
 * end (t=1) of the action — markers in the plan resolve at the relevant end.
 */
const vaultAction = (
  s: GameState,
  unitId: string,
  reactionPlan: ReactionPlan | undefined,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== unitId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `Unit ${unitId} is not the active unit`,
    );
  }
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `${unitId} is dead`);
  if (u.damage === 'IMPEDED' || u.damage === 'SUPPRESSED') {
    throw new CommandError('CANNOT_MOVE', `${unitId} cannot vault while ${u.damage}`);
  }
  if (unitHasTrait(u, 'NO_VAULT')) {
    throw new CommandError('NO_VAULT', `${unitId} has NO_VAULT — cannot vault`);
  }

  const wall = findContactedHardWall(s.terrain, u);
  if (!wall) {
    throw new CommandError('NOT_TOUCHING_WALL', `${unitId} not in contact with any wall`);
  }
  // BLOCKER / OUT_OF_BOUNDS / NO_ENTRY explicitly refuse traversal — sealed
  // walls and area boundaries. HIGH_GROUND platforms aren't vault-able
  // either; you climb up, you don't hop over.
  if (
    wall.kind === 'BLOCKER' ||
    wall.kind === 'HIGH_GROUND' ||
    wall.kind === 'OUT_OF_BOUNDS' ||
    wall.kind === 'NO_ENTRY'
  ) {
    throw new CommandError(
      'WALL_NOT_VAULTABLE',
      `${wall.id} (${wall.kind}) refuses VAULT`,
    );
  }
  if (
    wall.height === undefined ||
    wall.height > VAULT_HEIGHT_THRESHOLD_PIXELS
  ) {
    throw new CommandError(
      'WALL_TOO_TALL',
      `Wall ${wall.id} too tall to vault (height ${wall.height})`,
    );
  }

  const dest = vaultDestination(u, wall.polygon.vertices);
  ensureLandingClear(s, u, dest);

  const reactionResult = resolveReactionPlan(
    s,
    unitId,
    u.position,
    dest,
    reactionPlan,
    cmdIndex,
  );

  const finalEndpoint =
    reactionResult.interruptT !== null
      ? v2Lerp(u.position, dest, reactionResult.interruptT)
      : dest;
  const moved = updateUnit(reactionResult.state, unitId, { position: finalEndpoint });

  const moveEvent: GameEvent = {
    type: 'MOVE_RESOLVED',
    unitId,
    from: u.position,
    to: finalEndpoint,
    stopReason: 'TARGET',
    distance: v2Dist(u.position, finalEndpoint),
    reactionWindows: [],
    interruptedByMarker: reactionResult.interruptedByMarker,
  };

  const outcome: ActionOutcome = reactionOutcomeAfterFodder(u, reactionResult);
  return applyAutoMeleeAndPostAction(moved, unitId, outcome, cmdIndex, [
    moveEvent,
    ...reactionResult.events,
  ]);
};

/**
 * CLIMB (rule 4.2 B): only valid when in contact with a HARD wall whose
 * height > 1 unit-distance. Mover ends on top of the far edge. Activation
 * ends immediately without turnover — distinct from `forcedTurnoverAfterAction`.
 */
const climbAction = (
  s: GameState,
  unitId: string,
  reactionPlan: ReactionPlan | undefined,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== unitId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `Unit ${unitId} is not the active unit`,
    );
  }
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `${unitId} is dead`);
  if (u.damage === 'IMPEDED' || u.damage === 'SUPPRESSED') {
    throw new CommandError('CANNOT_MOVE', `${unitId} cannot climb while ${u.damage}`);
  }
  if (unitHasTrait(u, 'NO_CLIMB')) {
    throw new CommandError('NO_CLIMB', `${unitId} has NO_CLIMB — cannot climb`);
  }

  const wall = findContactedHardWall(s.terrain, u);
  if (!wall) {
    throw new CommandError('NOT_TOUCHING_WALL', `${unitId} not in contact with any wall`);
  }
  // BLOCKER / OUT_OF_BOUNDS / NO_ENTRY refuse CLIMB — pure sealed walls
  // and area boundaries.
  if (
    wall.kind === 'BLOCKER' ||
    wall.kind === 'OUT_OF_BOUNDS' ||
    wall.kind === 'NO_ENTRY'
  ) {
    throw new CommandError(
      'WALL_NOT_CLIMBABLE',
      `${wall.id} (${wall.kind}) refuses CLIMB`,
    );
  }
  // HARD walls must be tall to require climbing (low ones use VAULT).
  // HIGH_GROUND has no height — climbing on/off a platform is its own thing.
  if (
    wall.kind === 'HARD' &&
    (wall.height === undefined ||
      wall.height <= VAULT_HEIGHT_THRESHOLD_PIXELS)
  ) {
    throw new CommandError(
      'WALL_TOO_SHORT',
      `Wall ${wall.id} too short to require climbing (height ${wall.height})`,
    );
  }

  // HIGH_GROUND uses mirror-across-edge geometry — the climber crosses one
  // base diameter past the edge contacted (onto the platform if approaching
  // from outside, off the platform if leaving). HARD walls use the
  // top-of-spine landing geometry.
  const dest =
    wall.kind === 'HIGH_GROUND'
      ? traverseDestination(u, wall.polygon)
      : climbDestination(u, wall.polygon.vertices);
  ensureLandingClear(s, u, dest);

  const reactionResult = resolveReactionPlan(
    s,
    unitId,
    u.position,
    dest,
    reactionPlan,
    cmdIndex,
  );

  const finalEndpoint =
    reactionResult.interruptT !== null
      ? v2Lerp(u.position, dest, reactionResult.interruptT)
      : dest;
  const moved = updateUnit(reactionResult.state, unitId, { position: finalEndpoint });

  const moveEvent: GameEvent = {
    type: 'MOVE_RESOLVED',
    unitId,
    from: u.position,
    to: finalEndpoint,
    stopReason: 'TARGET',
    distance: v2Dist(u.position, finalEndpoint),
    reactionWindows: [],
    interruptedByMarker: reactionResult.interruptedByMarker,
  };

  const outcome: ActionOutcome =
    reactionOutcomeAfterFodder(u, reactionResult) === 'REACTION_HIT'
      ? 'REACTION_HIT'
      : 'FORCED_END';
  return applyAutoMeleeAndPostAction(moved, unitId, outcome, cmdIndex, [
    moveEvent,
    ...reactionResult.events,
  ]);
};

/**
 * TRAVERSE — single-action edge crossing for DIFFICULT / SOFT terrains.
 * Mover starts with its base flush against the polygon edge (touched on
 * either side) and ends flush against the same edge from the opposite
 * side. Consumes one full action like VAULT; no extra distance.
 */
const traverseAction = (
  s: GameState,
  unitId: string,
  reactionPlan: ReactionPlan | undefined,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== unitId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `Unit ${unitId} is not the active unit`,
    );
  }
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `${unitId} is dead`);
  if (u.damage === 'IMPEDED' || u.damage === 'SUPPRESSED') {
    throw new CommandError('CANNOT_MOVE', `${unitId} cannot traverse while ${u.damage}`);
  }

  const terrain = findContactedSoftTerrain(s.terrain, u);
  if (!terrain) {
    throw new CommandError(
      'NOT_TOUCHING_TERRAIN_EDGE',
      `${unitId} not in contact with a DIFFICULT/SOFT terrain edge`,
    );
  }

  const dest = traverseDestination(u, terrain.polygon);
  ensureLandingClear(s, u, dest);

  const reactionResult = resolveReactionPlan(
    s,
    unitId,
    u.position,
    dest,
    reactionPlan,
    cmdIndex,
  );

  const finalEndpoint =
    reactionResult.interruptT !== null
      ? v2Lerp(u.position, dest, reactionResult.interruptT)
      : dest;
  const moved = updateUnit(reactionResult.state, unitId, { position: finalEndpoint });

  const moveEvent: GameEvent = {
    type: 'MOVE_RESOLVED',
    unitId,
    from: u.position,
    to: finalEndpoint,
    stopReason: 'TARGET',
    distance: v2Dist(u.position, finalEndpoint),
    reactionWindows: [],
    interruptedByMarker: reactionResult.interruptedByMarker,
  };

  const outcome: ActionOutcome = reactionOutcomeAfterFodder(u, reactionResult);
  return applyAutoMeleeAndPostAction(moved, unitId, outcome, cmdIndex, [
    moveEvent,
    ...reactionResult.events,
  ]);
};

/**
 * OPERATE_DOOR — open or close a DOOR terrain. Requires DOOR_OPERATOR trait.
 * Consumes 1 action; no movement, no reaction window.
 */
const operateDoorAction = (
  s: GameState,
  unitId: string,
  terrainId: string,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== unitId) {
    throw new CommandError('NO_ACTIVE_UNIT', `Unit ${unitId} is not the active unit`);
  }
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `${unitId} is dead`);
  if (u.damage === 'SUPPRESSED') {
    throw new CommandError('SUPPRESSED', `${unitId} cannot act while SUPPRESSED`);
  }
  if (!unitHasTrait(u, 'DOOR_OPERATOR')) {
    throw new CommandError('NO_DOOR_OPERATOR', `${unitId} lacks DOOR_OPERATOR trait`);
  }
  const door = s.terrain.find((t) => t.id === terrainId);
  if (!door) throw new CommandError('TERRAIN_NOT_FOUND', `Terrain ${terrainId} not found`);
  if (door.kind !== 'DOOR') {
    throw new CommandError('NOT_A_DOOR', `Terrain ${terrainId} is not a DOOR`);
  }
  const dist = distToPolygonEdge(u.position, door.polygon.vertices);
  if (dist > u.radius + TERRAIN_INTERACT_REACH_PIXELS) {
    throw new CommandError('TOO_FAR', `${unitId} is too far from door ${terrainId}`);
  }
  const newIsOpen = !door.isOpen;
  const newState = updateTerrain(s, terrainId, { isOpen: newIsOpen });
  const doorEvent: GameEvent = {
    type: 'DOOR_OPERATED',
    unitId,
    terrainId,
    isOpen: newIsOpen,
  };
  const post = processPostAction(newState, 'SUCCESS', cmdIndex);
  return { state: post.state, events: [doorEvent, ...post.events] };
};

/**
 * PASS_DOOR — move through an open door in a single action (like VAULT but no
 * FORCED_END). Door must be open. No trait required.
 */
const passDoorAction = (
  s: GameState,
  unitId: string,
  reactionPlan: ReactionPlan | undefined,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== unitId) {
    throw new CommandError('NO_ACTIVE_UNIT', `Unit ${unitId} is not the active unit`);
  }
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `Unit ${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `${unitId} is dead`);
  if (u.damage === 'IMPEDED' || u.damage === 'SUPPRESSED') {
    throw new CommandError('CANNOT_MOVE', `${unitId} cannot pass door while ${u.damage}`);
  }
  const door = findContactedDoor(s.terrain, u);
  if (!door) {
    throw new CommandError('NOT_TOUCHING_DOOR', `${unitId} not in contact with any door`);
  }
  if (!door.isOpen) {
    throw new CommandError('DOOR_CLOSED', `Door ${door.id} is closed — open it first`);
  }
  const dest = vaultDestination(u, door.polygon.vertices);
  ensureLandingClear(s, u, dest);

  const reactionResult = resolveReactionPlan(s, unitId, u.position, dest, reactionPlan, cmdIndex);
  const finalEndpoint =
    reactionResult.interruptT !== null
      ? v2Lerp(u.position, dest, reactionResult.interruptT)
      : dest;
  const moved = updateUnit(reactionResult.state, unitId, { position: finalEndpoint });

  const moveEvent: GameEvent = {
    type: 'MOVE_RESOLVED',
    unitId,
    from: u.position,
    to: finalEndpoint,
    stopReason: 'TARGET',
    distance: v2Dist(u.position, finalEndpoint),
    reactionWindows: [],
    interruptedByMarker: reactionResult.interruptedByMarker,
  };

  const outcome: ActionOutcome = reactionOutcomeAfterFodder(u, reactionResult);
  return applyAutoMeleeAndPostAction(moved, unitId, outcome, cmdIndex, [
    moveEvent,
    ...reactionResult.events,
  ]);
};

/**
 * Compute one mover's effective target accounting for stance choices:
 *  - Crawl: cap to 1 unit-distance (rule 4.5).
 */
const capForStance = (
  from: Vec2,
  target: Vec2,
  stance: 'STANDING' | 'CRAWL' | undefined,
): Vec2 => {
  if (stance !== 'CRAWL') return target;
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len <= CRAWL_MAX_DISTANCE_PIXELS) return target;
  return {
    x: from.x + (dx / len) * CRAWL_MAX_DISTANCE_PIXELS,
    y: from.y + (dy / len) * CRAWL_MAX_DISTANCE_PIXELS,
  };
};

interface CommandMoveSpec {
  unitId: string;
  pathStart: Vec2;
  desiredEnd: Vec2;
  pathEnd: Vec2; // after collision/clip
  stopReason: 'TARGET' | 'OBSTACLE' | 'ENEMY';
  isCrawl: boolean;
  endProne: boolean;
}

/**
 * COMMAND_MOVE (rule 3.1 — 指揮啟動 + 移動).
 * Officer + selected allies all move along their own paths simultaneously.
 * One shared reaction plan; if a marker hits, ALL movers stop at that t.
 * Activation ends after this single composite action (no turnover).
 */
const commandMoveAction = (
  s: GameState,
  cmd: Extract<Command, { type: 'COMMAND_MOVE' }>,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== cmd.officerId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `Officer ${cmd.officerId} is not the active unit`,
    );
  }
  const officer = findUnit(s, cmd.officerId);
  if (!officer) {
    throw new CommandError('UNIT_NOT_FOUND', `${cmd.officerId} not found`);
  }
  if (!unitHasTrait(officer, 'OFFICER')) {
    throw new CommandError(
      'NOT_OFFICER',
      `${cmd.officerId} lacks OFFICER trait`,
    );
  }
  if (!isUnitAlive(officer)) {
    throw new CommandError('UNIT_DEAD', `${cmd.officerId} is dead`);
  }
  if (officer.damage === 'IMPEDED' || officer.damage === 'SUPPRESSED') {
    throw new CommandError(
      'CANNOT_MOVE',
      `Officer cannot move while ${officer.damage}`,
    );
  }
  if (cmd.participants.length === 0) {
    throw new CommandError(
      'NO_PARTICIPANTS',
      'Command activation requires at least one ally',
    );
  }

  // Validate participants are within 1 UD of officer at start, alive,
  // not suppressed, same faction. The target-distance check (1 UD of
  // officer's *resolved* endpoint) runs after spec building below — we
  // need the path resolution before we know where the officer actually
  // ends up.
  for (const p of cmd.participants) {
    const pu = findUnit(s, p.unitId);
    if (!pu) {
      throw new CommandError('UNIT_NOT_FOUND', `Participant ${p.unitId}`);
    }
    if (pu.faction !== officer.faction) {
      throw new CommandError(
        'WRONG_FACTION',
        `Participant ${p.unitId} not on officer's faction`,
      );
    }
    if (!isUnitAlive(pu)) {
      throw new CommandError('UNIT_DEAD', `Participant ${p.unitId} dead`);
    }
    if (pu.damage === 'IMPEDED' || pu.damage === 'SUPPRESSED') {
      throw new CommandError(
        'CANNOT_MOVE',
        `Participant ${p.unitId} cannot move while ${pu.damage}`,
      );
    }
    if (pu.lockedThisInitiative) {
      throw new CommandError(
        'PARTICIPANT_LOCKED',
        `${p.unitId} already FORCED_END this initiative — can't COMMAND_MOVE`,
      );
    }
    if (
      v2Dist(pu.position, officer.position) > UNIT_DISTANCE_PIXELS + 0.5
    ) {
      throw new CommandError(
        'PARTICIPANT_TOO_FAR',
        `${p.unitId} not within 1 unit-distance of officer at start`,
      );
    }
  }

  // Apply stand-up / drop-prone for each unit's chosen stance.
  let working = s;
  const allMovers: Array<{
    unitId: string;
    target: Vec2;
    stance: 'STANDING' | 'CRAWL' | undefined;
    endProne: boolean;
  }> = [
    {
      unitId: cmd.officerId,
      target: cmd.officerTarget,
      stance: cmd.officerStance,
      endProne: !!cmd.officerEndProne,
    },
    ...cmd.participants.map((p) => ({
      unitId: p.unitId,
      target: p.target,
      stance: p.stance,
      endProne: !!p.endProne,
    })),
  ];

  for (const m of allMovers) {
    const u = findUnit(working, m.unitId)!;
    if (unitHasTrait(u, 'NO_PRONE')) {
      // NO_PRONE participants ignore CRAWL stance and drop endProne; force standing.
      if (u.stance === 'PRONE') {
        working = updateUnit(working, m.unitId, { stance: 'STANDING' });
      }
      continue;
    }
    if (m.stance === 'CRAWL' && u.stance !== 'PRONE') {
      working = updateUnit(working, m.unitId, { stance: 'PRONE' });
    } else if (m.stance !== 'CRAWL' && u.stance === 'PRONE') {
      working = updateUnit(working, m.unitId, { stance: 'STANDING' });
    }
  }

  // Compute paths for each mover. stoppingPolygons differs per mover
  // because HIGH_GROUND polygons only block when the mover starts outside
  // (units already on top can walk freely, including stepping off).
  const enterStopPolygons = movementEnterStopPolygons(working.terrain);
  const moverIds = new Set(allMovers.map((m) => m.unitId));
  // Sequential resolution: each mover's path is computed in allMovers
  // order (officer first, then participants). Earlier movers contribute
  // their *resolved* endpoint as a peer obstacle so later movers dodge
  // around the actual stopping point — using only desired targets here
  // would let participants walk through the officer when the officer
  // stops short of the click.
  const resolvedEnds = new Map<string, Vec2>();
  const specs: CommandMoveSpec[] = allMovers.map((m) => {
    const u = findUnit(working, m.unitId)!;
    const target = capForStance(u.position, m.target, m.stance);
    const stoppingPolygons = movementBlockingPolygons(working.terrain, u.position);
    const exitStopPolygons = movementExitStopPolygons(working.terrain, u.position);
    const enemyCircles = working.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map(getUnitCircle);
    const otherMoverEndCircles = allMovers
      .filter((other) => other.unitId !== m.unitId)
      .map((other) => {
        const ou = findUnit(working, other.unitId)!;
        const resolved = resolvedEnds.get(other.unitId);
        return {
          center:
            resolved ?? capForStance(ou.position, other.target, other.stance),
          radius: ou.radius,
        };
      });
    const friendlyCircles = [
      ...working.units
        .filter(
          (o) =>
            o.faction === u.faction &&
            !moverIds.has(o.id) &&
            isUnitAlive(o),
        )
        .map(getUnitCircle),
      ...otherMoverEndCircles,
    ];
    const path = computeMovePath(u.position, target, {
      polygons: stoppingPolygons,
      enterStopPolygons,
      exitStopPolygons,
      enemyCircles,
      friendlyCircles,
      moverRadius: u.radius,
    });
    resolvedEnds.set(m.unitId, path.endpoint);
    return {
      unitId: m.unitId,
      pathStart: u.position,
      desiredEnd: target,
      pathEnd: path.endpoint,
      stopReason: path.stopReason,
      isCrawl: m.stance === 'CRAWL',
      endProne: m.endProne,
    };
  });

  // Now that the officer's path is resolved, validate each participant's
  // target sits within 1 UD of the officer's *resolved endpoint* (not the
  // raw cursor target). Officer is allMovers[0] so specs[0] is the officer.
  const officerEnd = specs[0].pathEnd;
  for (const p of cmd.participants) {
    if (v2Dist(p.target, officerEnd) > UNIT_DISTANCE_PIXELS + 0.5) {
      throw new CommandError(
        'TARGET_TOO_FAR',
        `${p.unitId}'s target not within 1 unit-distance of officer's resolved endpoint`,
      );
    }
  }

  // Run group reaction plan.
  const moverPaths: MoverPath[] = specs.map((s) => ({
    unitId: s.unitId,
    pathStart: s.pathStart,
    pathEnd: s.pathEnd,
  }));
  const groupReaction = resolveGroupReactionPlan(
    working,
    moverPaths,
    cmd.reactionPlan,
    cmdIndex,
  );
  let finalState = groupReaction.state;
  const events: GameEvent[] = [...groupReaction.events];

  const interruptT = groupReaction.interruptT;
  // When a reaction interrupts mid-path, naively lerping each mover to
  // the same parameter t can stack units on top of each other. Recompute
  // each interrupted path against the same obstacle setup, sequentially,
  // so peer movers' resolved interrupt endpoints become obstacles for
  // later movers — same approach as the original spec resolution above.
  const finalEndpoints = new Map<string, Vec2>();
  if (interruptT === null) {
    for (const spec of specs) finalEndpoints.set(spec.unitId, spec.pathEnd);
  } else {
    const interruptResolved = new Map<string, Vec2>();
    for (const spec of specs) {
      const u = findUnit(working, spec.unitId)!;
      const interruptTarget = v2Lerp(
        spec.pathStart,
        spec.pathEnd,
        interruptT,
      );
      const stoppingPolygons = movementBlockingPolygons(
        working.terrain,
        u.position,
      );
      const exitStopPolygons = movementExitStopPolygons(
        working.terrain,
        u.position,
      );
      const enemyCircles = working.units
        .filter((o) => o.faction !== u.faction && isUnitAlive(o))
        .map(getUnitCircle);
      const otherMoverEndCircles = specs
        .filter((other) => other.unitId !== spec.unitId)
        .map((other) => {
          const ou = findUnit(working, other.unitId)!;
          const resolved = interruptResolved.get(other.unitId);
          const fallback = v2Lerp(
            other.pathStart,
            other.pathEnd,
            interruptT,
          );
          return { center: resolved ?? fallback, radius: ou.radius };
        });
      const friendlyCircles = [
        ...working.units
          .filter(
            (o) =>
              o.faction === u.faction &&
              !moverIds.has(o.id) &&
              isUnitAlive(o),
          )
          .map(getUnitCircle),
        ...otherMoverEndCircles,
      ];
      const path = computeMovePath(u.position, interruptTarget, {
        polygons: stoppingPolygons,
        enterStopPolygons,
        exitStopPolygons,
        enemyCircles,
        friendlyCircles,
        moverRadius: u.radius,
      });
      interruptResolved.set(spec.unitId, path.endpoint);
      finalEndpoints.set(spec.unitId, path.endpoint);
    }
  }

  for (const spec of specs) {
    const finalEndpoint = finalEndpoints.get(spec.unitId)!;
    finalState = updateUnit(finalState, spec.unitId, {
      position: finalEndpoint,
    });
    if (spec.endProne || spec.isCrawl) {
      const u = findUnit(finalState, spec.unitId);
      if (u && u.damage !== 'KILLED' && !unitHasTrait(u, 'NO_PRONE')) {
        finalState = updateUnit(finalState, spec.unitId, { stance: 'PRONE' });
      }
    }
    events.push({
      type: 'MOVE_RESOLVED',
      unitId: spec.unitId,
      from: spec.pathStart,
      to: finalEndpoint,
      stopReason:
        interruptT !== null && interruptT < 1 ? 'TARGET' : spec.stopReason,
      distance: v2Dist(spec.pathStart, finalEndpoint),
      reactionWindows: [],
      interruptedByMarker: groupReaction.interruptedByMarker,
    });
  }

  // Auto-melee on contact (rule §4.7). Each mover that ends in base contact
  // with an enemy fights a charging melee right now — free, before turnover.
  // Resolved in officer→participant order (matches the spec list). Any
  // charging attacker that loses → MELEE_LOSS turnover overrides the move's
  // own outcome (REACTION_HIT, OVERDRAFT, etc.).
  for (const spec of specs) {
    const mover = findUnit(finalState, spec.unitId);
    if (!mover || !isUnitAlive(mover)) continue;
    const target = findMeleeContact(finalState, mover);
    if (!target) continue;
    const r = resolveMeleeContact(finalState, mover, target, true, cmdIndex);
    finalState = r.state;
    events.push(...r.events);
    if (!r.attackerWins) {
      const cleared = setActivation(finalState, null);
      const t = turnover(cleared, 'MELEE_LOSS', TURNOVER_MOMENTUM_GRANT, cmdIndex);
      return { state: t.state, events: [...events, ...t.events] };
    }
  }

  const outcome: ActionOutcome = groupReaction.suppressOrKillCaused
    ? 'REACTION_HIT'
    : 'SUCCESS';
  const post = processPostAction(finalState, outcome, cmdIndex);
  return { state: post.state, events: [...events, ...post.events] };
};

/**
 * COMMAND_RALLY (rule 3.1 + 4.6). Officer + selected allies each roll a
 * rally check using the officer's quality. One shared reaction phase against
 * stationary positions; interrupt aborts all checks. Activation ends after
 * this single composite action without turnover (unless a reaction hit).
 */
const commandRallyAction = (
  s: GameState,
  cmd: Extract<Command, { type: 'COMMAND_RALLY' }>,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== cmd.officerId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `Officer ${cmd.officerId} is not the active unit`,
    );
  }
  const officer = findUnit(s, cmd.officerId);
  if (!officer) {
    throw new CommandError('UNIT_NOT_FOUND', `${cmd.officerId} not found`);
  }
  if (!unitHasTrait(officer, 'OFFICER')) {
    throw new CommandError(
      'NOT_OFFICER',
      `${cmd.officerId} lacks OFFICER trait`,
    );
  }
  if (!isUnitAlive(officer)) {
    throw new CommandError('UNIT_DEAD', `${cmd.officerId} is dead`);
  }
  if (cmd.participantIds.length === 0) {
    throw new CommandError(
      'NO_PARTICIPANTS',
      'Command rally requires at least one ally',
    );
  }

  // Validate participants
  const ralliers = [cmd.officerId, ...cmd.participantIds];
  for (const pid of cmd.participantIds) {
    const pu = findUnit(s, pid);
    if (!pu) throw new CommandError('UNIT_NOT_FOUND', `Participant ${pid}`);
    if (pu.faction !== officer.faction) {
      throw new CommandError(
        'WRONG_FACTION',
        `${pid} not on officer's faction`,
      );
    }
    if (!isUnitAlive(pu)) {
      throw new CommandError('UNIT_DEAD', `${pid} dead`);
    }
    if (pu.lockedThisInitiative) {
      throw new CommandError(
        'PARTICIPANT_LOCKED',
        `${pid} already FORCED_END this initiative — can't COMMAND_RALLY`,
      );
    }
    if (
      v2Dist(pu.position, officer.position) > UNIT_DISTANCE_PIXELS + 0.5
    ) {
      throw new CommandError(
        'PARTICIPANT_TOO_FAR',
        `${pid} not within 1 unit-distance of officer`,
      );
    }
  }

  // Reaction phase: stationary paths per rallier (path.start === path.end).
  const moverPaths: MoverPath[] = ralliers.map((id) => {
    const u = findUnit(s, id)!;
    return { unitId: id, pathStart: u.position, pathEnd: u.position };
  });
  const groupReaction = resolveGroupReactionPlan(
    s,
    moverPaths,
    cmd.reactionPlan,
    cmdIndex,
  );
  let finalState = groupReaction.state;
  const events: GameEvent[] = [...groupReaction.events];

  if (groupReaction.suppressOrKillCaused) {
    const post = processPostAction(finalState, 'REACTION_HIT', cmdIndex);
    return { state: post.state, events: [...events, ...post.events] };
  }

  // Each unit with a removable damage state rolls a rally check using the
  // officer's quality (rule 4.6 — "若 1 單位距離內有軍官，可改用軍官的素質").
  const threshold = officer.quality;
  for (const id of ralliers) {
    const u = findUnit(finalState, id);
    if (!u || !isUnitAlive(u) || u.damage === 'NONE') continue;
    const rng = deriveRng(finalState.seed, cmdIndex, `command-rally:${id}`);
    const roll = rng.rollDie(D6_SIDES);
    const success = roll >= threshold;
    const beforeDamage = u.damage;
    let afterDamage: DamageState = beforeDamage;
    if (success) {
      if (u.damage === 'IMPEDED') afterDamage = 'NONE';
      else if (u.damage === 'SUPPRESSED') afterDamage = 'IMPEDED';
    }
    events.push({
      type: 'RALLY_ROLLED',
      unitId: id,
      threshold,
      roll,
      success,
      officerUsed: id === cmd.officerId ? null : cmd.officerId,
      beforeDamage,
      afterDamage,
    });
    if (success) {
      finalState = updateUnit(finalState, id, { damage: afterDamage });
      if (afterDamage !== 'SUPPRESSED') {
        finalState = updateUnit(finalState, id, {
          damage: afterDamage,
          stance: 'STANDING',
        });
      }
    }
  }

  // Command rally uses 1 action from the activation budget. For CHECK_SUCCESS
  // (unlimited), this allows the officer to continue acting. For SPEND (1 action),
  // remaining hits 0 and the activation ends normally without turnover.
  const post = processPostAction(finalState, 'SUCCESS', cmdIndex);
  return { state: post.state, events: [...events, ...post.events] };
};

const buildMeleePool = (
  s: GameState,
  unit: Unit,
  contactPoint: Vec2,
  isCharger: boolean,
): { dice: number; threshold: number } => {
  const weapon = unit.weapons.find((w) => w.kind === 'MELEE');
  if (!weapon) {
    throw new CommandError(
      'NO_MELEE_WEAPON',
      `${unit.id} has no melee weapon`,
    );
  }
  let dice = weapon.diceCount;
  if (isCharger) dice += 1;
  const supports = s.units.filter(
    (o) =>
      o.faction === unit.faction &&
      o.id !== unit.id &&
      isUnitAlive(o) &&
      v2Dist(o.position, contactPoint) <= UNIT_DISTANCE_PIXELS,
  ).length;
  dice += Math.min(supports, MELEE_SUPPORT_CAP);
  // Status penalty (rule 4.7): IMPEDED/SUPPRESSED → −1 die.
  // STALWART (堅忍) bypasses the penalty.
  if (
    (unit.damage === 'IMPEDED' || unit.damage === 'SUPPRESSED') &&
    !meleeIgnoresStatus(unit)
  ) {
    dice = Math.max(0, dice - 1);
  }
  return { dice, threshold: weapon.threshold };
};

/**
 * Pure melee resolution: opposed dice, kill the loser, emit the event.
 * Caller has already validated that attacker + defender are alive, opposing
 * faction, and in base contact. Returns {attackerWins} so callers can decide
 * whether to trigger MELEE_LOSS turnover (charging attacker lost) or just
 * continue normal post-action processing.
 */
const resolveMeleeContact = (
  s: GameState,
  attacker: Unit,
  defender: Unit,
  isCharging: boolean,
  cmdIndex: number,
): { state: GameState; events: GameEvent[]; attackerWins: boolean } => {
  const contactPoint = v2Lerp(attacker.position, defender.position, 0.5);
  const aPool = buildMeleePool(s, attacker, contactPoint, isCharging);
  const dPool = buildMeleePool(s, defender, contactPoint, false);

  const rng = deriveRng(s.seed, cmdIndex, 'melee');
  const intel = s.combatIntel ?? EMPTY_COMBAT_INTEL;
  const aLevel = resolveCombatIntelLevel(defender, intel, 'melee', attacker.faction);
  const dLevel = resolveCombatIntelLevel(attacker, intel, 'melee', defender.faction);
  const aProfile = buildDiceProfile(aPool.dice, aPool.threshold, aLevel);
  const dProfile = buildDiceProfile(dPool.dice, dPool.threshold, dLevel);
  let attackerHits = 0;
  let defenderHits = 0;
  let rerolls = 0;
  for (;;) {
    attackerHits = rollProfile(aProfile, rng, D6_SIDES).hits;
    defenderHits = rollProfile(dProfile, rng, D6_SIDES).hits;
    if (attackerHits !== defenderHits) break;
    rerolls++;
    if (rerolls > 10) {
      // Safety bail-out: declare attacker the winner on tied 10th reroll.
      attackerHits = defenderHits + 1;
      break;
    }
  }

  const attackerWins = attackerHits > defenderHits;
  const winnerId = attackerWins ? attacker.id : defender.id;
  const loserId = attackerWins ? defender.id : attacker.id;
  const next = updateUnit(s, loserId, { damage: 'KILLED' });
  const meleeEvent: GameEvent = {
    type: 'MELEE_RESOLVED',
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerHits,
    defenderHits,
    attackerDice: aPool.dice,
    defenderDice: dPool.dice,
    winnerId,
    loserId,
    isCharging,
    rerolls,
  };
  return { state: next, events: [meleeEvent], attackerWins };
};

const hasMeleeWeapon = (u: Unit): boolean =>
  u.weapons.some((w) => w.kind === 'MELEE');

/**
 * Find the closest enemy unit whose base is in melee contact with `mover`.
 * Returns null when no contact. Used by every move-resulting action to
 * fire forced melee on contact (rule §4.7 — 底板接觸敵軍 → 觸發近戰).
 */
const findMeleeContact = (s: GameState, mover: Unit): Unit | null => {
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const o of s.units) {
    if (o.faction === mover.faction) continue;
    if (!isUnitAlive(o)) continue;
    const dist = v2Dist(mover.position, o.position);
    if (dist > mover.radius + o.radius + 2) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = o;
    }
  }
  return best;
};

/**
 * Wrap `processPostAction` with the rule §4.7 forced-melee-on-contact step.
 * Every movement-resulting action (MOVE / CRAWL / VAULT / CLIMB / TRAVERSE /
 * PASS_DOOR) ends by calling this so we don't repeat the precedence logic in
 * each handler:
 *
 *   1. If the mover ended in base contact with an enemy, resolve charging
 *      melee right now — this is FREE (no extra action), and resolves before
 *      any turnover the move's outcome would have caused.
 *   2. If the charging attacker LOST → MELEE_LOSS turnover (rule 4.7C)
 *      overrides whatever the move's outcome would have triggered (REACTION_HIT,
 *      OVERDRAFT-forced turnover, FORCED_END locking, etc.).
 *   3. Otherwise — attacker won, or no contact — fall through to normal
 *      `processPostAction` with the move's original outcome.
 */
const applyAutoMeleeAndPostAction = (
  state: GameState,
  moverId: string,
  baseOutcome: ActionOutcome,
  cmdIndex: number,
  preEvents: ReadonlyArray<GameEvent>,
): CommandResult => {
  const mover = findUnit(state, moverId);
  // Mover may already be dead (reaction kill during the move). Skip melee.
  // Also skip when either side lacks a melee weapon — defensive against
  // hand-built test fixtures and legacy unit configs; rule §4.7 assumes
  // every unit can melee at least with a basic weapon.
  if (mover && isUnitAlive(mover) && hasMeleeWeapon(mover)) {
    const target = findMeleeContact(state, mover);
    if (target && hasMeleeWeapon(target)) {
      const r = resolveMeleeContact(state, mover, target, true, cmdIndex);
      if (!r.attackerWins) {
        const cleared = setActivation(r.state, null);
        const t = turnover(cleared, 'MELEE_LOSS', TURNOVER_MOMENTUM_GRANT, cmdIndex);
        return {
          state: t.state,
          events: [...preEvents, ...r.events, ...t.events],
        };
      }
      const post = processPostAction(r.state, baseOutcome, cmdIndex);
      return {
        state: post.state,
        events: [...preEvents, ...r.events, ...post.events],
      };
    }
  }
  const post = processPostAction(state, baseOutcome, cmdIndex);
  return { state: post.state, events: [...preEvents, ...post.events] };
};

/**
 * Manual MELEE command. Now redundant with the auto-melee-on-contact
 * trigger that fires from every movement action — units in contact will
 * have already resolved their melee. Kept as a no-op safety net for old
 * replays and for edge cases (scripted setups that put units in contact
 * without going through a move).
 */
const meleeAction = (
  s: GameState,
  attackerId: string,
  defenderId: string,
  isCharging: boolean,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== attackerId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `${attackerId} is not the active unit`,
    );
  }
  const attacker = findUnit(s, attackerId);
  const defender = findUnit(s, defenderId);
  if (!attacker || !defender) {
    throw new CommandError('UNIT_NOT_FOUND', `${attackerId} or ${defenderId}`);
  }
  if (!isUnitAlive(attacker) || !isUnitAlive(defender)) {
    throw new CommandError('UNIT_DEAD', 'Combatant already dead');
  }
  if (attacker.faction === defender.faction) {
    throw new CommandError('FRIENDLY_FIRE', 'Same-faction melee');
  }
  const dist = v2Dist(attacker.position, defender.position);
  const contactRange = attacker.radius + defender.radius + 2;
  if (dist > contactRange) {
    throw new CommandError(
      'NOT_IN_CONTACT',
      `${attackerId} not in base contact with ${defenderId}`,
    );
  }

  const r = resolveMeleeContact(s, attacker, defender, isCharging, cmdIndex);
  if (!r.attackerWins && isCharging) {
    const cleared = setActivation(r.state, null);
    const t = turnover(cleared, 'MELEE_LOSS', TURNOVER_MOMENTUM_GRANT, cmdIndex);
    return { state: t.state, events: [...r.events, ...t.events] };
  }
  const post = processPostAction(r.state, 'SUCCESS', cmdIndex);
  return { state: post.state, events: [...r.events, ...post.events] };
};

const rallyAction = (
  s: GameState,
  unitId: string,
  reactionPlan: ReactionPlan | undefined,
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== unitId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `${unitId} is not the active unit`,
    );
  }
  const u = findUnit(s, unitId);
  if (!u) throw new CommandError('UNIT_NOT_FOUND', `${unitId} not found`);
  if (!isUnitAlive(u)) throw new CommandError('UNIT_DEAD', `${unitId} is dead`);
  if (u.damage === 'NONE') {
    throw new CommandError('NOTHING_TO_RALLY', `${unitId} has no negative state`);
  }

  // Resolve reactions first (rule 4.4: rally declaration triggers reactions).
  // Stationary path: start = end = unit position.
  const reactionResult = resolveReactionPlan(
    s,
    unitId,
    u.position,
    u.position,
    reactionPlan,
    cmdIndex,
  );

  // If reactions interrupted the rally, skip the check and post-action.
  if (reactionResult.interruptT !== null) {
    const outcome = reactionOutcomeAfterFodder(u, reactionResult);
    const post = processPostAction(reactionResult.state, outcome, cmdIndex);
    return {
      state: post.state,
      events: [...reactionResult.events, ...post.events],
    };
  }

  let working = reactionResult.state;
  // Re-fetch unit in case reactions modified state (e.g., flags), though
  // without a hit landing damage shouldn't have changed.
  const u2 = findUnit(working, unitId) ?? u;
  if (!isUnitAlive(u2)) {
    const post = processPostAction(working, 'REACTION_HIT', cmdIndex);
    return { state: post.state, events: [...reactionResult.events, ...post.events] };
  }

  // Use own quality, or borrow nearby officer's (whichever is lower = better).
  let threshold = u2.quality;
  let officerUsed: string | null = null;
  for (const o of working.units) {
    if (
      o.faction === u2.faction &&
      o.id !== u2.id &&
      isUnitAlive(o) &&
      unitHasTrait(o, 'OFFICER') &&
      v2Dist(o.position, u2.position) <= UNIT_DISTANCE_PIXELS &&
      o.quality < threshold
    ) {
      threshold = o.quality;
      officerUsed = o.id;
    }
  }

  const rng = deriveRng(working.seed, cmdIndex, 'rally');
  const roll = rng.rollDie(D6_SIDES);
  const success = roll >= threshold;

  const beforeDamage: DamageState = u2.damage;
  let afterDamage: DamageState = beforeDamage;
  if (success) {
    if (u2.damage === 'IMPEDED') afterDamage = 'NONE';
    else if (u2.damage === 'SUPPRESSED') afterDamage = 'IMPEDED';
  }

  const rallyEvents: GameEvent[] = [
    {
      type: 'RALLY_ROLLED',
      unitId,
      threshold,
      roll,
      success,
      officerUsed,
      beforeDamage,
      afterDamage,
    },
  ];

  if (!success) {
    const cleared = setActivation(working, null);
    const t = turnover(cleared, 'ACTION_FAILED', TURNOVER_MOMENTUM_GRANT, cmdIndex);
    return {
      state: t.state,
      events: [...reactionResult.events, ...rallyEvents, ...t.events],
    };
  }

  let next = updateUnit(working, unitId, { damage: afterDamage });
  if (afterDamage !== 'SUPPRESSED') {
    next = updateUnit(next, unitId, { damage: afterDamage, stance: 'STANDING' });
  }
  const cleared = setActivation(next, null);
  return {
    state: cleared,
    events: [
      ...reactionResult.events,
      ...rallyEvents,
      { type: 'ACTIVATION_ENDED', unitId, reason: 'NORMAL' },
    ],
  };
};

const shootAction = (
  s: GameState,
  cmd: {
    shooterId: string;
    targetId: string;
    mode: ShootMode;
    weaponId?: string;
    participantIds?: ReadonlyArray<string>;
  },
  cmdIndex: number,
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act || act.unitId !== cmd.shooterId) {
    throw new CommandError(
      'NO_ACTIVE_UNIT',
      `${cmd.shooterId} is not the active unit`,
    );
  }
  const shooter = findUnit(s, cmd.shooterId);
  if (!shooter) {
    throw new CommandError('UNIT_NOT_FOUND', `${cmd.shooterId} not found`);
  }
  const participantIds = cmd.participantIds ?? [];

  // Mode-specific structural checks.
  if (cmd.mode === 'FOCUSED') {
    for (const pid of participantIds) {
      if (pid === cmd.shooterId) continue;
      const p = findUnit(s, pid);
      if (!p) throw new CommandError('UNIT_NOT_FOUND', pid);
      if (v2Dist(shooter.position, p.position) > UNIT_DISTANCE_PIXELS) {
        throw new CommandError(
          'TOO_FAR_FOR_FOCUSED',
          `Participant ${pid} is more than 1 unit distance from shooter`,
        );
      }
    }
  }

  const shot = resolveShot({
    state: s,
    shooterId: cmd.shooterId,
    targetId: cmd.targetId,
    mode: cmd.mode,
    weaponId: cmd.weaponId,
    participantIds,
    weaponMode: 'ACTIVE',
    rngLabel: 'shoot',
    cmdIndex,
  });

  // Stealth break: a player ('A') SHOOT always trips the break trigger.
  // Suppression-defer rule (every enemy KILLED / SUPPRESSED at the moment
  // of the shot — measured AFTER the shot resolves) holds the break until
  // the next turnover. Apply BEFORE processPostAction so any subsequent
  // turnover sees stealth correctly flipped (no patrol on incoming side
  // when stealth just broke).
  let postShot = shot.state;
  const breakEvents: GameEvent[] = [];
  if (postShot.stealth?.active === true && shooter.faction === 'A') {
    const br = evaluateStealthBreak(postShot, 'SHOT');
    postShot = br.state;
    breakEvents.push(...br.events);
  }

  const outcome = shot.causedSuppressOrKill ? 'SUCCESS' : 'FAILURE';
  const post = processPostAction(postShot, outcome, cmdIndex);
  return {
    state: post.state,
    events: [...shot.events, ...breakEvents, ...post.events],
  };
};

/**
 * Post-command safeguard: NO_PRONE units that ended up PRONE for any reason
 * (suppression-from-reaction during a MOVE, future status effects, scripted
 * setup) snap back to STANDING. The dedicated reducer handlers already gate
 * crawl/endProne, so in normal play this loop is a no-op — it exists so the
 * invariant "NO_PRONE unit is never observed prone after a command" holds
 * regardless of which path produced the prone state.
 */
const enforceNoProne = (state: GameState): GameState => {
  let next = state;
  for (const u of state.units) {
    if (u.stance === 'PRONE' && unitHasTrait(u, 'NO_PRONE') && u.damage !== 'KILLED') {
      next = updateUnit(next, u.id, { stance: 'STANDING' });
    }
  }
  return next;
};

export const applyCommand = (state: GameState, cmd: Command): CommandResult => {
  const s = bumpCommandCount(state);
  const cmdIndex = s.commandCount;
  const result = applyCommandInner(s, cmd, cmdIndex);
  // Stealth-side POI emission. We fold it AFTER the action resolves so we
  // see post-state positions (VAULT/CLIMB/CRAWL/COMMAND_MOVE end-points)
  // and only fire when stealth was active going in (commands themselves
  // never flip stealth.active in this layer — that's Stage 5).
  const derived = derivePoisFromCommand(s, result.state, cmd);
  const withPois = applyDerivedPois(result.state, derived);
  return {
    state: enforceNoProne(withPois.state),
    events: [...result.events, ...withPois.events],
  };
};

const applyCommandInner = (
  s: GameState,
  cmd: Command,
  cmdIndex: number,
): CommandResult => {
  switch (cmd.type) {
    case 'ACTIVATE_SPEND':
      return activateSpend(s, cmd.unitId);
    case 'ACTIVATE_CHECK':
      return activateCheck(s, cmd.unitId, cmdIndex);
    case 'ACTIVATE_OVERDRAFT':
      return activateOverdraft(s, cmd.unitId);
    case 'END_ACTIVATION':
      return endActivation(s, cmdIndex);
    case 'PASS_INITIATIVE':
      return passInitiative(s, cmdIndex);
    case 'MOVE':
      return moveAction(
        s,
        cmd.unitId,
        cmd.target,
        cmd.reactionPlan,
        cmdIndex,
        cmd.endProne,
      );
    case 'CRAWL':
      return crawlAction(s, cmd.unitId, cmd.target, cmd.reactionPlan, cmdIndex);
    case 'VAULT':
      return vaultAction(s, cmd.unitId, cmd.reactionPlan, cmdIndex);
    case 'CLIMB':
      return climbAction(s, cmd.unitId, cmd.reactionPlan, cmdIndex);
    case 'TRAVERSE':
      return traverseAction(s, cmd.unitId, cmd.reactionPlan, cmdIndex);
    case 'COMMAND_MOVE':
      return commandMoveAction(s, cmd, cmdIndex);
    case 'COMMAND_RALLY':
      return commandRallyAction(s, cmd, cmdIndex);
    case 'SHOOT':
      return shootAction(s, cmd, cmdIndex);
    case 'MELEE':
      return meleeAction(
        s,
        cmd.attackerId,
        cmd.defenderId,
        cmd.isCharging ?? true,
        cmdIndex,
      );
    case 'RALLY':
      return rallyAction(s, cmd.unitId, cmd.reactionPlan, cmdIndex);
    case 'OPERATE_DOOR':
      return operateDoorAction(s, cmd.unitId, cmd.terrainId, cmdIndex);
    case 'PASS_DOOR':
      return passDoorAction(s, cmd.unitId, cmd.reactionPlan, cmdIndex);
  }
};

/** Convenience: apply a list of commands sequentially, returning final state and concatenated events. */
export const applyCommands = (
  state: GameState,
  cmds: ReadonlyArray<Command>,
): CommandResult => {
  let cur: GameState = state;
  const allEvents: GameEvent[] = [];
  for (const cmd of cmds) {
    const r = applyCommand(cur, cmd);
    cur = r.state;
    allEvents.push(...r.events);
  }
  return { state: cur, events: allEvents };
};
