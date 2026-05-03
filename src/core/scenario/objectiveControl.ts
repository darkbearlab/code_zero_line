/**
 * Stateful objective control for the `control-points` scenario.
 *
 * Capture model (Conquest-style):
 *  - Each objective has an owner (`Faction | null`). `null` = neutral.
 *  - Owner persists across cycles. Walking off your own point does not
 *    surrender it — the opponent must (a) physically clear your last
 *    defender from the zone, then (b) be the only side present at the
 *    end of a full cycle (A→B→A handoff) to flip ownership.
 *  - Cycle-end resolution happens in `reducer.turnover()` when
 *    `cycleBump > 0`. This module provides the pure helpers; the
 *    reducer wires them into `state.initiative.objectiveControl`
 *    and `objectiveScores`.
 *
 * The `requireAllObjectives` flag on engage-reach / defend uses
 * `factionInstantlyControlsAll` instead — that path is per-frame
 * presence, not stateful capture.
 */
import type { Faction, GameState } from '../state/GameState';
import { isUnitAlive } from '../state/GameState';

const FACTIONS: ReadonlyArray<Faction> = ['A', 'B'];

/** Live count of each faction's surviving units inside `objId`'s radius. */
export const objectivePresence = (
  state: GameState,
  objId: string,
): { A: number; B: number } => {
  const obj = (state.objectives ?? []).find((o) => o.id === objId);
  if (!obj) return { A: 0, B: 0 };
  const r2 = obj.radius * obj.radius;
  let a = 0;
  let b = 0;
  for (const u of state.units) {
    if (!isUnitAlive(u)) continue;
    const dx = u.position.x - obj.position.x;
    const dy = u.position.y - obj.position.y;
    if (dx * dx + dy * dy > r2) continue;
    if (u.faction === 'A') a += 1;
    else b += 1;
  }
  return { A: a, B: b };
};

/**
 * Per-frame check used by `requireAllObjectives` mode. True iff every
 * objective on the map has at least one surviving `f` unit standing on it
 * AND no surviving opponent unit standing on it. With zero objectives the
 * predicate is vacuously false (the flag is meaningless without points).
 */
export const factionInstantlyControlsAll = (
  state: GameState,
  f: Faction,
): boolean => {
  const objs = state.objectives ?? [];
  if (objs.length === 0) return false;
  const opp: Faction = f === 'A' ? 'B' : 'A';
  for (const o of objs) {
    const p = objectivePresence(state, o.id);
    if (p[f] <= 0) return false;
    if (p[opp] > 0) return false;
  }
  return true;
};

/**
 * Compute the next-cycle owner map per the stateful capture rules above.
 * Inputs and outputs are read-only; the reducer is responsible for
 * substituting the result into `state.initiative.objectiveControl`.
 */
export const nextObjectiveControl = (
  state: GameState,
  current: Readonly<Record<string, Faction | null>>,
): Readonly<Record<string, Faction | null>> => {
  const objs = state.objectives ?? [];
  if (objs.length === 0) return current;
  const next: Record<string, Faction | null> = {};
  for (const o of objs) {
    const owner = current[o.id] ?? null;
    const p = objectivePresence(state, o.id);
    if (owner === null) {
      // Neutral → flip only if exactly one side is present and the other isn't.
      if (p.A > 0 && p.B === 0) next[o.id] = 'A';
      else if (p.B > 0 && p.A === 0) next[o.id] = 'B';
      else next[o.id] = null;
      continue;
    }
    const opp: Faction = owner === 'A' ? 'B' : 'A';
    // Owner still has a foothold OR opponent absent → keep owner.
    if (p[owner] > 0 || p[opp] === 0) {
      next[o.id] = owner;
      continue;
    }
    // Owner cleared AND opponent uniquely present → flip.
    next[o.id] = opp;
  }
  return next;
};

/**
 * Per-cycle score increment from a control map. Neutral points contribute
 * nothing. Missing weights default to 1 per point.
 */
export const cycleScoreDelta = (
  control: Readonly<Record<string, Faction | null>>,
  weights?: Readonly<Record<string, number>>,
): { A: number; B: number } => {
  let a = 0;
  let b = 0;
  for (const id of Object.keys(control)) {
    const owner = control[id];
    if (owner === null || owner === undefined) continue;
    const w = weights?.[id] ?? 1;
    if (owner === 'A') a += w;
    else b += w;
  }
  return { A: a, B: b };
};

/** Initial neutral control map for a fresh GameState. */
export const initialObjectiveControl = (
  state: GameState,
): Readonly<Record<string, Faction | null>> => {
  const objs = state.objectives ?? [];
  const map: Record<string, Faction | null> = {};
  for (const o of objs) map[o.id] = null;
  return map;
};

/** Zero-score record. Exposed for buildState / tests. */
export const zeroObjectiveScores = (): Readonly<Record<Faction, number>> => {
  const out: Record<Faction, number> = { A: 0, B: 0 };
  // FACTIONS keeps the type assertion honest if we ever add a third faction.
  void FACTIONS;
  return out;
};
