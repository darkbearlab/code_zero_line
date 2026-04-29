/**
 * Mission definition for the roguelite layer. v1 covers what the vertical
 * slice needs: a map reference, a scenario mode, and an enemy spawn list
 * (so the same map can be reused with different difficulty configurations).
 *
 * Phase 2 will add procedural variants and additional scenario types
 * (defend / extract / assassinate). For now everything is hand-crafted.
 */
import type { Vec2 } from '../core/geometry/types';
import type { Faction } from '../core/state/GameState';
import type { ScenarioMode } from '../sim/runMatch';

export interface EnemySpawn {
  readonly id: string;
  readonly templateId: string;
  readonly position: Vec2;
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
  /** Enemy units to spawn. Player faction always 'A'. */
  readonly enemies: ReadonlyArray<EnemySpawn>;
  /**
   * Where the player's squad deploys. Length must >= squad size. Extra
   * positions are ignored.
   */
  readonly playerSpawnPositions: ReadonlyArray<Vec2>;
  /** AI faction for enemies (always 'B' in v1). */
  readonly enemyFaction: Faction;
}
