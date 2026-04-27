import { hasLOS } from '../geometry/los';
import { computeReactionWindows } from '../geometry/los_window';
import { computeMovePath } from '../geometry/path';
import type { Vec2 } from '../geometry/types';
import { v2Dist, v2Lerp } from '../geometry/vec2';
import { resolveShot } from '../resolution/shooting';
import {
  D6_SIDES,
  MELEE_SUPPORT_CAP,
  TURNOVER_MOMENTUM_GRANT,
  UNIT_DISTANCE_PIXELS,
} from '../rules/constants';
import { countHits, deriveRng } from '../rng/sfc32';
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

const opponent = (f: Faction): Faction => (f === 'A' ? 'B' : 'A');

const bumpCommandCount = (s: GameState): GameState => ({
  ...s,
  commandCount: s.commandCount + 1,
});

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
): CommandResult => {
  const from = s.initiative.holder;
  const to = opponent(from);
  const newMomentum: Record<Faction, number> = { A: 0, B: 0 };
  newMomentum[to] = granted;
  // Round bumps when initiative comes back to A (i.e., a full A→B→A cycle).
  // Simple model: increment round whenever turnover's `to` is 'A'.
  const roundBump = to === 'A' ? 1 : 0;
  const next: GameState = {
    ...s,
    initiative: {
      holder: to,
      momentum: newMomentum,
      round: s.initiative.round + roundBump,
      activeActivation: null,
    },
    // Clear per-round flags whenever a new round starts.
    units:
      roundBump > 0
        ? s.units.map((u) => ({
            ...u,
            activatedThisRound: false,
            cannotReactThisRound: false,
          }))
        : s.units,
  };
  return {
    state: next,
    events: [
      {
        type: 'INITIATIVE_TURNOVER',
        from,
        to,
        reason,
        momentumGranted: granted,
      },
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
  if (success) {
    let next = markUnitActivated(s, u.id);
    next = setActivation(next, {
      unitId: u.id,
      kind: 'CHECK_SUCCESS',
      actionsRemaining: -1,
      failureProtection: false,
      forcedTurnoverAfterAction: false,
    });
    return {
      state: next,
      events: [
        checkEvent,
        { type: 'ACTIVATION_BEGAN', unitId: u.id, kind: 'CHECK_SUCCESS' },
      ],
    };
  }
  const t = turnover(s, 'CHECK_FAILED', TURNOVER_MOMENTUM_GRANT);
  return { state: t.state, events: [checkEvent, ...t.events] };
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

const endActivation = (s: GameState): CommandResult => {
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
  const t = turnover(cleared, reason, granted);
  return { state: t.state, events: [endedEvent, ...t.events] };
};

const passInitiative = (s: GameState): CommandResult => {
  if (s.initiative.activeActivation) {
    throw new CommandError(
      'ACTIVATION_IN_PROGRESS',
      'Cannot pass initiative while an activation is in progress',
    );
  }
  return turnover(s, 'VOLUNTARY', TURNOVER_MOMENTUM_GRANT);
};

type ActionOutcome = 'SUCCESS' | 'FAILURE' | 'REACTION_HIT';

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
): CommandResult => {
  const act = s.initiative.activeActivation;
  if (!act) return { state: s, events: [] };

  if (outcome === 'REACTION_HIT') {
    const cleared = setActivation(s, null);
    return turnover(cleared, 'REACTION_HIT', TURNOVER_MOMENTUM_GRANT);
  }

  if (outcome === 'FAILURE' && !act.failureProtection) {
    const cleared = setActivation(s, null);
    return turnover(cleared, 'ACTION_FAILED', TURNOVER_MOMENTUM_GRANT);
  }

  const remaining =
    act.actionsRemaining > 0 ? act.actionsRemaining - 1 : act.actionsRemaining;

  if (remaining === 0) {
    const cleared = setActivation(s, null);
    if (act.forcedTurnoverAfterAction) {
      const reason: TurnoverReason =
        act.kind === 'OVERDRAFT' ? 'OVERDRAFT' : 'ACTION_FAILED';
      const granted =
        act.kind === 'OVERDRAFT' && act.overdraftDeficit !== undefined
          ? act.overdraftDeficit
          : TURNOVER_MOMENTUM_GRANT;
      const t = turnover(cleared, reason, granted);
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

interface ReactionResolveResult {
  state: GameState;
  events: GameEvent[];
  interruptedByMarker: number;
  interruptT: number | null;
  suppressOrKillCaused: boolean;
}

/**
 * Resolve a reaction plan against a target unit moving (or stationary) along
 * pathStart → pathEnd. Markers are resolved in t-order; first hit halts the
 * action. Used by both MOVE (real path) and RALLY (degenerate path: start = end).
 */
const resolveReactionPlan = (
  s: GameState,
  targetId: string,
  pathStart: Vec2,
  pathEnd: Vec2,
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
  const target = findUnit(s, targetId);
  if (!target) return empty;

  const hardObs = s.terrain.filter((t) => t.kind === 'HARD').map((t) => t.polygon);
  const sorted = [...plan.markers]
    .map((m, originalIndex) => ({ m, originalIndex }))
    .sort((a, b) => a.m.atT - b.m.atT);

  let working = s;
  const events: GameEvent[] = [];

  for (const { m, originalIndex } of sorted) {
    const moverPos = v2Lerp(pathStart, pathEnd, m.atT);
    const shooter = findUnit(working, m.shooterId);
    if (!shooter) continue;
    if (!isUnitAlive(shooter)) continue;
    if (shooter.damage === 'SUPPRESSED') continue;
    if (shooter.cannotReactThisRound) continue;
    if (shooter.faction === target.faction) continue;

    // All FOCUSED/COMBINED participants must still be eligible to react.
    // If any has become ineligible (suppressed, dead, already-reacted), skip
    // the marker entirely rather than silently degrading the shot.
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
      hardObs,
    );
    if (!visibleHere) continue;

    // Temporarily place target at moverPos so resolveShot's LOS/cover checks
    // use the mid-path position. Restore afterwards so subsequent logic can
    // place the target wherever appropriate.
    const tempState = updateUnit(working, targetId, { position: moverPos });
    const shot = resolveShot({
      state: tempState,
      shooterId: m.shooterId,
      targetId,
      mode: m.mode,
      participantIds: m.participantIds,
      weaponMode: 'REACTION',
      rngLabel: `reaction:${cmdIndex}:m${originalIndex}`,
      cmdIndex,
    });
    working = updateUnit(shot.state, targetId, { position: target.position });
    events.push(...shot.events);

    if (shot.hits === 0) {
      // Rule 4.4: every unit that participated in the missed shot is barred
      // from reacting again this initiative round (shooter + all participants).
      working = updateUnit(working, m.shooterId, { cannotReactThisRound: true });
      for (const pid of m.participantIds) {
        if (pid === m.shooterId) continue;
        working = updateUnit(working, pid, { cannotReactThisRound: true });
      }
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

  const enemyCircles = s.units
    .filter((o) => o.faction !== u.faction && isUnitAlive(o))
    .map(getUnitCircle);
  const hardObstacles = s.terrain
    .filter((t) => t.kind === 'HARD')
    .map((t) => t.polygon);

  const path = computeMovePath(u.position, target, {
    polygons: hardObstacles,
    enemyCircles,
    moverRadius: u.radius,
  });

  const enemiesForLOS = s.units
    .filter((o) => o.faction !== u.faction && isUnitAlive(o))
    .map((o) => ({ id: o.id, circle: getUnitCircle(o) }));
  const reactionWindows = computeReactionWindows(
    u.position,
    path.endpoint,
    u.radius,
    enemiesForLOS,
    hardObstacles,
  );

  const reactionResult = resolveReactionPlan(
    s,
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

  const outcome = reactionResult.suppressOrKillCaused ? 'REACTION_HIT' : 'SUCCESS';
  const post = processPostAction(moved, outcome);
  return {
    state: post.state,
    events: [moveEvent, ...reactionResult.events, ...post.events],
  };
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
  if (
    (unit.damage === 'IMPEDED' || unit.damage === 'SUPPRESSED') &&
    !unit.traits.includes('STOIC')
  ) {
    dice = Math.max(0, dice - 1);
  }
  return { dice, threshold: weapon.threshold };
};

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
  const contactRange = attacker.radius + defender.radius + 2; // small slack
  if (dist > contactRange) {
    throw new CommandError(
      'NOT_IN_CONTACT',
      `${attackerId} not in base contact with ${defenderId}`,
    );
  }

  const contactPoint = v2Lerp(attacker.position, defender.position, 0.5);
  const aPool = buildMeleePool(s, attacker, contactPoint, isCharging);
  const dPool = buildMeleePool(s, defender, contactPoint, false);

  const rng = deriveRng(s.seed, cmdIndex, 'melee');
  let attackerHits = 0;
  let defenderHits = 0;
  let rerolls = 0;
  for (;;) {
    const aRolls = rng.rollDice(aPool.dice, D6_SIDES);
    const dRolls = rng.rollDice(dPool.dice, D6_SIDES);
    attackerHits = countHits(aRolls, aPool.threshold);
    defenderHits = countHits(dRolls, dPool.threshold);
    if (attackerHits !== defenderHits) break;
    rerolls++;
    if (rerolls > 10) {
      // Safety bail-out: declare attacker the winner on tied 10th reroll.
      attackerHits = defenderHits + 1;
      break;
    }
  }

  const attackerWins = attackerHits > defenderHits;
  const winnerId = attackerWins ? attackerId : defenderId;
  const loserId = attackerWins ? defenderId : attackerId;

  const next = updateUnit(s, loserId, { damage: 'KILLED' });

  const meleeEvent: GameEvent = {
    type: 'MELEE_RESOLVED',
    attackerId,
    defenderId,
    attackerHits,
    defenderHits,
    attackerDice: aPool.dice,
    defenderDice: dPool.dice,
    winnerId,
    loserId,
    isCharging,
    rerolls,
  };

  if (!attackerWins && isCharging) {
    // Rule 4.7C: charging attacker lost → turnover.
    const cleared = setActivation(next, null);
    const t = turnover(cleared, 'MELEE_LOSS', TURNOVER_MOMENTUM_GRANT);
    return { state: t.state, events: [meleeEvent, ...t.events] };
  }

  const post = processPostAction(next, 'SUCCESS');
  return { state: post.state, events: [meleeEvent, ...post.events] };
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
    const outcome = reactionResult.suppressOrKillCaused
      ? 'REACTION_HIT'
      : 'SUCCESS';
    const post = processPostAction(reactionResult.state, outcome);
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
    const post = processPostAction(working, 'REACTION_HIT');
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
      o.traits.includes('OFFICER') &&
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
    const t = turnover(cleared, 'ACTION_FAILED', TURNOVER_MOMENTUM_GRANT);
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
  cmd: { shooterId: string; targetId: string; mode: ShootMode; participantIds?: ReadonlyArray<string> },
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
    participantIds,
    weaponMode: 'ACTIVE',
    rngLabel: 'shoot',
    cmdIndex,
  });

  const outcome = shot.causedSuppressOrKill ? 'SUCCESS' : 'FAILURE';
  const post = processPostAction(shot.state, outcome);
  return { state: post.state, events: [...shot.events, ...post.events] };
};

export const applyCommand = (state: GameState, cmd: Command): CommandResult => {
  const s = bumpCommandCount(state);
  const cmdIndex = s.commandCount;
  switch (cmd.type) {
    case 'ACTIVATE_SPEND':
      return activateSpend(s, cmd.unitId);
    case 'ACTIVATE_CHECK':
      return activateCheck(s, cmd.unitId, cmdIndex);
    case 'ACTIVATE_OVERDRAFT':
      return activateOverdraft(s, cmd.unitId);
    case 'END_ACTIVATION':
      return endActivation(s);
    case 'PASS_INITIATIVE':
      return passInitiative(s);
    case 'MOVE':
      return moveAction(s, cmd.unitId, cmd.target, cmd.reactionPlan, cmdIndex);
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
