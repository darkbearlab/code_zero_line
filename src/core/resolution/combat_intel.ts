/**
 * Combat-intel meta hook — supplies dice-threshold reductions per attack.
 *
 * The roguelite layer (CampaignState, when it lands in main roadmap
 * Phase 3) accumulates levels per (track, tag) where:
 *   track = 'shoot' | 'melee'
 *   tag   = INFANTRY / HEAVY / CYBORG / MECH / COMMAND / …
 *
 * At resolution time, the level applied to a given attack is
 *   findHighestLevelByTag(target, levels[track])
 * — i.e. the MAX across all tags the target carries (per design
 * 2026-04-29; see docs/tag-system.md §6). Returning 0 means the
 * dice profile is single-group / unchanged from the legacy code.
 *
 * Phase C v1: this module exposes the *types* and *lookup helper* but
 * does not consume any persistent state. The reducer / sim CLI accept
 * a `CombatIntelLevels` value and pass it through. CampaignState
 * integration is a single-line change at the GameState construction
 * site once Phase 3 of the main roadmap lands.
 */
import type { Unit } from '../state/GameState';
import { findHighestLevelByTag } from '../traits/types';

export interface CombatIntelLevels {
  /** Per-tag level for SHOOT-kind weapons. 0 / missing = no upgrade. */
  readonly shoot: Readonly<Record<string, number>>;
  /** Per-tag level for MELEE-kind weapons. Independent of shoot. */
  readonly melee: Readonly<Record<string, number>>;
}

/** Empty (no upgrades) singleton — the default when nothing is plumbed. */
export const EMPTY_COMBAT_INTEL: CombatIntelLevels = Object.freeze({
  shoot: Object.freeze({}),
  melee: Object.freeze({}),
});

/**
 * Resolve the dice-threshold reduction level for a given attack against
 * `target`. Returns max level across the target's tags for the chosen
 * track; 0 when the levels object is empty / not provided.
 *
 * Roguelite v1 design: combat intel represents the *player's* learned
 * knowledge of enemy units. The player is faction 'A' — enemy attacks
 * (faction 'B' shooting / striking) get level 0 unconditionally so the
 * upgrade tree never accidentally buffs the AI. The optional
 * `attackerFaction` arg enables this gate; pass undefined when caller
 * doesn't care (legacy PvP sandbox path).
 */
export const resolveCombatIntelLevel = (
  target: Unit,
  levels: CombatIntelLevels | undefined,
  track: 'shoot' | 'melee',
  attackerFaction?: 'A' | 'B',
): number => {
  if (!levels) return 0;
  if (attackerFaction !== undefined && attackerFaction !== 'A') return 0;
  return findHighestLevelByTag(target, levels[track]);
};
