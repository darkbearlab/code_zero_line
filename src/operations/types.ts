/**
 * Operation = a chain of N elimination missions + 1 main-objective mission,
 * shipped as the campaign's draftable unit (replaces the old single-mission
 * draw). The picker (Stage 2) reads `OperationDef`s and instantiates them
 * by binding concrete mission ids, producing `OperationInstance`s for the
 * RunState to step through.
 *
 * `OperationInterludeDef` is a schema slot reserved for the future
 * "犧牲打分歧任務" (optional / forced detour missions awarding meta progress).
 * No picker / HUB code reads it in Stage 1-4.
 */
import type { ScenarioMode } from '../core/scenario/victory';
import type { CampaignCurrencies } from '../campaign/state';

/** Where the player is in the chain — UI labels it differently per stage. */
export type StageLabel = 'ELIM' | 'MAIN';

/** Closed [min, max] band, both inclusive, both within 1..5. */
export type DifficultyBand = readonly [number, number];

export interface OperationRewards {
  /** Awarded after each stage clear; banked into RunState until run ends. */
  readonly perStage: CampaignCurrencies;
  /** Bonus on top of the last `perStage` when the *main* mission clears. */
  readonly onComplete: CampaignCurrencies;
}

export interface OperationChainDef {
  /** Number of elimination missions before the main mission. 1..4. */
  readonly eliminations: number;
  /** Difficulty band (inclusive) used to filter elim mission candidates. */
  readonly elimDifficultyBand: DifficultyBand;
  /**
   * Optional whitelist of scenario modes for elims. Default
   * `['elimination','engage-reach']` — both serve as "shoot stuff" filler.
   */
  readonly elimModeFilter?: ReadonlyArray<ScenarioMode>;
  /**
   * Pin the main mission to a specific id. When set, `mainConstraints` is
   * ignored. Useful for authored set-pieces ("the warehouse extract").
   */
  readonly mainMissionId?: string;
  /**
   * Constraints for picking the main mission from the pool. Used when
   * `mainMissionId` is absent.
   */
  readonly mainConstraints?: {
    readonly modes?: ReadonlyArray<ScenarioMode>;
    readonly difficultyBand?: DifficultyBand;
  };
}

export interface OperationDef {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Designer difficulty 1-5 used to gate which round can surface this op. */
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly chain: OperationChainDef;
  readonly rewards: OperationRewards;
  /**
   * Reserved for future detour-mission feature. Schema-only in this phase;
   * picker / HubScene do not read it. Documented in
   * `docs/open-questions.md:77-80` and `docs/roguelite-design-summary.md:137-142`.
   */
  readonly optionalInterludes?: ReadonlyArray<OperationInterludeDef>;
  /**
   * Mirror of `MissionDef.includeInCampaignPool`: when explicitly `false`
   * the picker skips this op (story / tutorial / WIP). Default = in pool.
   */
  readonly includeInCampaignPool?: boolean;
  /**
   * When true, the chain's first mission begins in stealth state. Stealth
   * propagates across stages until broken (any mission ending with stealth
   * cleared flips `RunState.operationStealthAlive` to false for all later
   * stages). Per-mission `stealthMode` override (force-on / force-off) wins
   * over chain inheritance.
   */
  readonly stealthEntry?: boolean;
}

/** Schema slot — not consumed yet. See OperationDef.optionalInterludes. */
export interface OperationInterludeDef {
  /** After which stage index (0-based) the detour appears in HubScene. */
  readonly triggerAfterStage: number;
  readonly missionConstraints: {
    readonly modes?: ReadonlyArray<ScenarioMode>;
    readonly difficultyBand?: DifficultyBand;
  };
  /** Reward currencies + optional meta progress hook. */
  readonly successReward: Partial<CampaignCurrencies> & {
    readonly metaProgress?: number;
  };
  readonly failurePenalty?: Partial<CampaignCurrencies>;
  /** When true, player cannot skip (forced detour). Default false. */
  readonly forced?: boolean;
}

/**
 * Concrete instantiation of an `OperationDef` after the picker has bound
 * mission ids. `missionIds[i]` corresponds to `stageLabels[i]`. Length is
 * `chain.eliminations + 1`.
 */
export interface OperationInstance {
  readonly operationId: string;
  readonly missionIds: ReadonlyArray<string>;
  readonly stageLabels: ReadonlyArray<StageLabel>;
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly rewards: OperationRewards;
  /** Forwarded from `OperationDef.stealthEntry` (snapshot for run start). */
  readonly stealthEntry?: boolean;
}
