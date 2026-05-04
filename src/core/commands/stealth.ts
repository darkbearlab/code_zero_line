/**
 * Stealth-state side effects of a command. Splits POI emission and POI
 * pruning out of the reducer so the command-dispatch path stays linear.
 *
 * Expiry semantics: `expiresAtCycle = createdCycle + 1`. The reducer prunes
 * a POI at any A→B turnover where `state.initiative.cycle >= expiresAtCycle`
 * — i.e. the POI lives through the enemy turn that follows its creation
 * AND through the player's next initiative span, then gets cleared as
 * the player releases initiative again.
 */
import type { Vec2 } from '../geometry/types';
import type {
  Command,
  GameEvent,
} from './types';
import type {
  Faction,
  GameState,
  PoiMark,
  StealthState,
} from '../state/GameState';
import { findUnit } from '../state/GameState';

type PoiCause = PoiMark['cause'];

interface DerivedPoi {
  readonly position: Vec2;
  readonly cause: PoiCause;
}

const actorPos = (state: GameState, id: string): Vec2 | null => {
  const u = findUnit(state, id);
  return u ? u.position : null;
};

/**
 * Compute POIs to drop after `cmd` resolves. Returns empty list when
 * stealth is off, the actor isn't player-side, or the command type is
 * silent (MOVE, ACTIVATE_*, etc.).
 *
 * MOVE / ACTIVATE / END_ACTIVATION / PASS_INITIATIVE / MELEE never emit
 * POIs — MOVE is the explicitly-silent action; the others have no
 * positional payload that "makes noise" in stealth terms.
 */
export const derivePoisFromCommand = (
  preState: GameState,
  postState: GameState,
  cmd: Command,
): ReadonlyArray<DerivedPoi> => {
  if (preState.stealth?.active !== true) return [];
  switch (cmd.type) {
    case 'SHOOT': {
      const shooter = findUnit(preState, cmd.shooterId);
      if (!shooter || shooter.faction !== 'A') return [];
      return [{ position: shooter.position, cause: 'SHOOT' }];
    }
    case 'RALLY': {
      const u = findUnit(preState, cmd.unitId);
      if (!u || u.faction !== 'A') return [];
      return [{ position: u.position, cause: 'RALLY' }];
    }
    case 'VAULT':
    case 'CLIMB':
    case 'CRAWL': {
      const u = findUnit(preState, cmd.unitId);
      if (!u || u.faction !== 'A') return [];
      const pre = u.position;
      const post = actorPos(postState, cmd.unitId) ?? pre;
      const cause: PoiCause =
        cmd.type === 'VAULT'
          ? 'VAULT'
          : cmd.type === 'CLIMB'
            ? 'CLIMB'
            : 'CRAWL';
      return pre.x === post.x && pre.y === post.y
        ? [{ position: pre, cause }]
        : [
            { position: pre, cause },
            { position: post, cause },
          ];
    }
    case 'COMMAND_MOVE': {
      const officer = findUnit(preState, cmd.officerId);
      if (!officer || officer.faction !== 'A') return [];
      const pre = officer.position;
      const post = actorPos(postState, cmd.officerId) ?? pre;
      return pre.x === post.x && pre.y === post.y
        ? [{ position: pre, cause: 'COMMAND' }]
        : [
            { position: pre, cause: 'COMMAND' },
            { position: post, cause: 'COMMAND' },
          ];
    }
    case 'COMMAND_RALLY': {
      const officer = findUnit(preState, cmd.officerId);
      if (!officer || officer.faction !== 'A') return [];
      return [{ position: officer.position, cause: 'COMMAND' }];
    }
    default:
      return [];
  }
};

/**
 * Append derived POIs to the stealth state and emit STEALTH_POI_CREATED
 * events. No-op if `derived` is empty or stealth state is missing/inactive.
 */
export const applyDerivedPois = (
  state: GameState,
  derived: ReadonlyArray<DerivedPoi>,
): { state: GameState; events: ReadonlyArray<GameEvent> } => {
  if (derived.length === 0) return { state, events: [] };
  const stealth = state.stealth;
  if (!stealth) return { state, events: [] };
  const createdCycle = state.initiative.cycle;
  const expiresAtCycle = createdCycle + 1;
  const newPois: PoiMark[] = derived.map((d) => ({
    position: d.position,
    createdCycle,
    cause: d.cause,
    expiresAtCycle,
  }));
  const nextStealth: StealthState = {
    ...stealth,
    pois: [...stealth.pois, ...newPois],
  };
  const events: GameEvent[] = newPois.map((p) => ({
    type: 'STEALTH_POI_CREATED',
    position: p.position,
    cause: p.cause,
    createdCycle: p.createdCycle,
    expiresAtCycle: p.expiresAtCycle,
  }));
  return { state: { ...state, stealth: nextStealth }, events };
};

/**
 * Prune expired POIs at turnover. Only fires when initiative is leaving
 * the player ('A') — that's the moment a player's "next initiative" span
 * has just ended, so any POIs created the cycle before are now stale.
 *
 * Returns the next stealth state (or original if no change).
 */
export const prunePoisOnTurnover = (
  stealth: StealthState | undefined,
  cycleBefore: number,
  from: Faction,
): StealthState | undefined => {
  if (!stealth) return stealth;
  if (from !== 'A') return stealth;
  if (stealth.pois.length === 0) return stealth;
  const kept = stealth.pois.filter((p) => cycleBefore < p.expiresAtCycle);
  if (kept.length === stealth.pois.length) return stealth;
  return { ...stealth, pois: kept };
};
