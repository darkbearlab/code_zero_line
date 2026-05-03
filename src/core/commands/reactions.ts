import { hasLOS } from '../geometry/los';
import type { Vec2 } from '../geometry/types';
import { v2Lerp } from '../geometry/vec2';
import { resolveShot } from '../resolution/shooting';
import {
  findUnit,
  getUnitCircle,
  isUnitAlive,
  updateUnit,
} from '../state/GameState';
import type { GameState } from '../state/GameState';
import { unitHasTrait } from '../traits/types';
import type { GameEvent, ReactionPlan } from './types';

export interface ReactionResolveResult {
  state: GameState;
  events: GameEvent[];
  interruptedByMarker: number;
  interruptT: number | null;
  suppressOrKillCaused: boolean;
}

/**
 * Resolve a reaction plan against a target unit moving (or stationary) along
 * pathStart → pathEnd. Markers are resolved in t-order; first hit halts the
 * action. Used by MOVE / RALLY (degenerate path: start = end) / IMPULSIVE
 * forced moves.
 */
export const resolveReactionPlan = (
  s: GameState,
  targetId: string,
  pathStart: Vec2,
  pathEnd: Vec2,
  plan: ReactionPlan | undefined,
  cmdIndex: number,
  rngLabelPrefix = 'reaction',
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
      rngLabel: `${rngLabelPrefix}:${cmdIndex}:m${originalIndex}`,
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
