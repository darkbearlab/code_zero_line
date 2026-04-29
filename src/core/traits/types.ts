import type { Unit } from '../state/GameState';
import { parseIdParam, type IdParam } from '../util/idParam';

/**
 * Parsed trait reference. Trait strings on units may carry an integer
 * parameter using either `ID:N` or `ID(N)` notation (e.g., `ARMOR:1`,
 * `AGITATOR(2)`). Bare `ID` defaults param to 0.
 */
export type TraitInstance = IdParam;

export const parseTrait = (raw: string): TraitInstance => parseIdParam(raw);

/**
 * Static trait definition. Most traits express their effect via simple flags
 * the rules engine queries at decision points; complex traits with state
 * (e.g. once-per-game) get a `state` slot to carry per-unit data.
 */
/**
 * What kind of tag this is, for documentation / UI grouping. Has no
 * behavioural effect — the rules engine queries by id, not by kind.
 *
 *  - 'ability'   : confers some game-mechanical effect on its holder
 *                  (OFFICER, STALWART, ARMOR, etc.). Drives most rule
 *                  branches.
 *  - 'category'  : pure classification, with no inherent effect. Other
 *                  systems (combat-intel meta, scenario constraints,
 *                  AI targeting hooks) read these to decide who to
 *                  apply effects TO. INFANTRY / HEAVY / CYBORG / MECH.
 *  - 'state'     : marker for runtime state set by gameplay rather
 *                  than authored data (none today; reserved).
 */
export type TraitKind = 'ability' | 'category' | 'state';

export interface TraitDef {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Defaults to 'ability' for back-compat with the original registry. */
  readonly kind?: TraitKind;
  /** Bypass the −1 die penalty in melee for [IMPEDED]/[SUPPRESSED]. */
  readonly meleeIgnoresStatusPenalty?: boolean;
  /** When this unit's incoming damage would set [IMPEDED], upgrade to [SUPPRESSED]. */
  readonly fragileUpgrade?: boolean;
  /** Number of incoming hits removed before damage state is computed. Reads param. */
  readonly armorAbsorbHits?: 'param';
  /**
   * Cap on `actionsRemaining` set at activation start. CUMBERSOME = 1 forces
   * a CHECK_SUCCESS activation down to 1 action.
   */
  readonly maxActionsPerActivation?: number;
  /**
   * Suppression/kill of THIS unit during own-faction activation does not
   * cause turnover. (Wired in a later pass — declared so JSON can already
   * carry the trait.)
   */
  readonly cannonFodder?: boolean;
  /**
   * IMPEDED status does not interrupt the unit's actions. (Wired in a later
   * pass — declared so JSON can already carry the trait.)
   */
  readonly fanaticIgnoresImpededInterrupt?: boolean;
  /** Marker that more complex behavior is required and not yet implemented. */
  readonly tbd?: boolean;
}

/** Get parsed trait instances from a unit's `traits` strings. */
export const getUnitTraits = (unit: Unit): ReadonlyArray<TraitInstance> =>
  unit.traits.map(parseTrait);

/** True if the unit has at least one instance of trait `id`. */
export const unitHasTrait = (unit: Unit, id: string): boolean =>
  unit.traits.some((t) => parseTrait(t).id === id);

/** Sum the parameters of all trait instances with `id`. ARMOR:1 + ARMOR:2 = 3. */
export const sumTraitParams = (unit: Unit, id: string): number => {
  let sum = 0;
  for (const t of unit.traits) {
    const inst = parseTrait(t);
    if (inst.id === id) sum += inst.param;
  }
  return sum;
};

/**
 * Generic "highest-tag-match level" lookup for systems that key effects by
 * tag (combat-intel meta, scenario rule-modifiers, etc.). Given a target
 * unit and a `Record<tagId, level>` map, returns the maximum level across
 * all tags the unit carries; 0 when nothing matches.
 *
 * Per design 2026-04-29: when a unit matches multiple tracks (e.g. a
 * heavy_gunner carries both INFANTRY and HEAVY), take MAX. This avoids
 * "stack two tracks for double effect" snowball that would let reactions
 * one-shot anything. See docs/tag-system.md for the broader rule.
 */
export const findHighestLevelByTag = (
  unit: Unit,
  levels: Readonly<Record<string, number>>,
): number => {
  let max = 0;
  for (const t of unit.traits) {
    const inst = parseTrait(t);
    const lvl = levels[inst.id] ?? 0;
    if (lvl > max) max = lvl;
  }
  return max;
};
