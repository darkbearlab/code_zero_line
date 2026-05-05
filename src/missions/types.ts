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
  /**
   * Designer-assigned difficulty band 1 (trivial) – 5 (brutal). Drives
   * operation chain assembly: `pickOperations` filters elim/main candidates
   * by this band and gates which operations a campaign round may surface
   * (cap rises with `roundIndex`). Distinct from the emergent quality ratio
   * `classifyFuzzy` reports — that one stays as a sanity-display sidecar.
   */
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
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
  /**
   * Per-mission stealth override. Default = inherit from operation chain
   * state (`RunState.operationStealthAlive`). 'force-on' = mission always
   * starts in stealth regardless of chain state (e.g. authored stealth
   * set-pieces). 'force-off' = mission always starts non-stealth even if
   * the chain is still stealthly (typically the chain finale).
   */
  readonly stealthMode?: 'force-on' | 'force-off';
  /**
   * Per-mission no-intel override. Default = inherit from operation chain
   * state (`RunState.operationNoIntelAlive`). 'force-on' = mission always
   * starts under fog-of-war regardless of chain state. 'force-off' = clears
   * the no-intel chain state (typically a recon/intel-pickup mission that
   * resolves the fog for the rest of the chain).
   */
  readonly noIntelMode?: 'force-on' | 'force-off';
  /**
   * Per-mission deployment-slot enforcement override. Default = inherit from
   * operation chain state (`RunState.operationDeploymentSlotsAlive`).
   * 'force-on' = mission demands the player's squad fill the first
   * min(squadSize, slotCount) Zone-A slots (≥1 unit each) regardless of
   * chain state. 'force-off' = mission allows free placement inside any
   * Zone-A polygon and clears the chain flag for later stages.
   */
  readonly deploymentSlotsMode?: 'force-on' | 'force-off';
}
