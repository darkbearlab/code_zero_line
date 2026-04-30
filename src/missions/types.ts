/**
 * Mission definition for the roguelite layer. v1 covers what the vertical
 * slice needs: a map reference, a scenario mode, and an enemy spawn list
 * (so the same map can be reused with different difficulty configurations).
 *
 * Phase 2 adds per-mission objective overrides and scenario params so the
 * same map can host multiple scenario flavors without duplicating its
 * terrain. assassinate / VIP-flee scenarios remain on the roadmap.
 */
import type { Vec2 } from '../core/geometry/types';
import type { Faction } from '../core/state/GameState';
import type { ScenarioMode, ScenarioParams } from '../core/scenario/victory';

export interface EnemySpawn {
  readonly id: string;
  readonly templateId: string;
  readonly position: Vec2;
}

export interface MissionObjective {
  readonly id: string;
  readonly position: Vec2;
  readonly radius: number;
  readonly displayName?: string;
}

export interface MissionDef {
  readonly id: string;
  readonly displayName: string;
  /** One-line flavor description shown on RunSetupScene + HubScene. */
  readonly description: string;
  /** Map id (looked up via config/loader getMap). */
  readonly mapId: string;
  /** Win condition. */
  readonly scenario: ScenarioMode;
  /** Per-scenario tunables (defendRounds, extractCount, …). Optional. */
  readonly scenarioParams?: ScenarioParams;
  /**
   * Mission-specific control points. When present, override the map's
   * objectives so different missions on the same map can target different
   * spots. defend/extract scenarios require this; engage-reach falls back
   * to map.objectives if omitted.
   */
  readonly objectives?: ReadonlyArray<MissionObjective>;
  /** Enemy units to spawn. Player faction always 'A'. */
  readonly enemies: ReadonlyArray<EnemySpawn>;
  /**
   * Where the player's squad deploys. Length must >= squad size. Extra
   * positions are ignored.
   */
  readonly playerSpawnPositions: ReadonlyArray<Vec2>;
  /** AI faction for enemies (always 'B' in v1). */
  readonly enemyFaction: Faction;
  /**
   * Whether `pickMissions` (the campaign / round picker) considers this
   * mission. Undefined or `true` = in pool (default for backwards compat).
   * Set `false` for tutorials, story-only beats, or work-in-progress drafts
   * the editor should keep around without throwing them into the random draw.
   */
  readonly includeInCampaignPool?: boolean;
}
