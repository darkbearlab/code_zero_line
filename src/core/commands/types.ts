import type { Vec2 } from '../geometry/types';
import type { ReactionWindow } from '../geometry/los_window';
import type { PathStopReason } from '../geometry/path';
import type {
  ActivationKind,
  DamageState,
  Faction,
  WeaponMode,
} from '../state/GameState';

export type ShootMode = 'SOLO' | 'FOCUSED' | 'COMBINED';

export interface ReactionMarker {
  /** Time along the path [0,1] at which to declare reaction fire. */
  readonly atT: number;
  readonly shooterId: string;
  readonly mode: ShootMode;
  /** All firing units (includes shooterId for FOCUSED/COMBINED). */
  readonly participantIds: ReadonlyArray<string>;
  /**
   * For command-activation actions where multiple movers share one reaction
   * plan, each marker must specify which mover it targets. For solo actions
   * (regular MOVE/RALLY/etc.), this is optional and defaults to the mover.
   */
  readonly targetUnitId?: string;
}

export interface ReactionPlan {
  readonly markers: ReadonlyArray<ReactionMarker>;
}

export type Command =
  | { type: 'ACTIVATE_SPEND'; unitId: string }
  | { type: 'ACTIVATE_CHECK'; unitId: string }
  | { type: 'ACTIVATE_OVERDRAFT'; unitId: string }
  | { type: 'END_ACTIVATION' }
  | { type: 'PASS_INITIATIVE' }
  | {
      type: 'MOVE';
      unitId: string;
      target: Vec2;
      reactionPlan?: ReactionPlan;
      /** Drop prone at end of move (rule 4.5 — 任意移動行動結束時可免費宣告). */
      endProne?: boolean;
    }
  | { type: 'CRAWL'; unitId: string; target: Vec2; reactionPlan?: ReactionPlan }
  | { type: 'VAULT'; unitId: string; reactionPlan?: ReactionPlan }
  | { type: 'CLIMB'; unitId: string; reactionPlan?: ReactionPlan }
  | {
      /**
       * Command Activation — Move (rule 3.1). Officer + selected allies all
       * move simultaneously. Each ally must end within 1 unit-distance of
       * the officer's chosen endpoint. Reaction fire targets a single chosen
       * mover; if it suppresses/kills, the entire group stops at that t.
       * Activation ends after this single action without turnover.
       */
      type: 'COMMAND_MOVE';
      officerId: string;
      officerTarget: Vec2;
      officerStance?: 'STANDING' | 'CRAWL';
      officerEndProne?: boolean;
      participants: ReadonlyArray<{
        unitId: string;
        target: Vec2;
        stance?: 'STANDING' | 'CRAWL';
        endProne?: boolean;
      }>;
      reactionPlan?: ReactionPlan;
    }
  | {
      /**
       * Command Activation — Rally (rule 3.1 + 4.6). Officer + selected
       * allies each roll a rally check using the officer's quality. Single
       * shared reaction phase (path is stationary at each unit's position).
       */
      type: 'COMMAND_RALLY';
      officerId: string;
      participantIds: ReadonlyArray<string>;
      reactionPlan?: ReactionPlan;
    }
  | {
      type: 'SHOOT';
      mode: ShootMode;
      shooterId: string;
      targetId: string;
      participantIds?: ReadonlyArray<string>;
    }
  | {
      type: 'MELEE';
      attackerId: string;
      defenderId: string;
      /** Defaults to true. Charge bonus +1 die for the attacker. */
      isCharging?: boolean;
    }
  | { type: 'RALLY'; unitId: string; reactionPlan?: ReactionPlan };

export type TurnoverReason =
  | 'CHECK_FAILED'
  | 'ACTION_FAILED'
  | 'VOLUNTARY'
  | 'OVERDRAFT'
  | 'REACTION_HIT'
  | 'MELEE_LOSS';

export type GameEvent =
  | { type: 'MOMENTUM_SPENT'; faction: Faction; amount: number }
  | { type: 'OVERDRAFT_DECLARED'; unitId: string; deficit: number }
  | { type: 'ACTIVATION_BEGAN'; unitId: string; kind: ActivationKind }
  | {
      type: 'ACTIVATION_CHECK_ROLLED';
      unitId: string;
      threshold: number;
      roll: number;
      success: boolean;
    }
  | {
      type: 'ACTIVATION_ENDED';
      unitId: string;
      reason: 'NORMAL' | 'FORCED_TURNOVER' | 'CHECK_FAILED';
    }
  | {
      type: 'INITIATIVE_TURNOVER';
      from: Faction;
      to: Faction;
      reason: TurnoverReason;
      momentumGranted: number;
    }
  | {
      type: 'MOVE_RESOLVED';
      unitId: string;
      from: Vec2;
      to: Vec2;
      stopReason: PathStopReason;
      distance: number;
      reactionWindows: ReadonlyArray<ReactionWindow>;
      /** Index into reactionPlan.markers that landed a hit and stopped movement, or -1 if none. */
      interruptedByMarker: number;
    }
  | {
      type: 'SHOT_RESOLVED';
      shooterId: string;
      targetId: string;
      mode: ShootMode;
      participantIds: ReadonlyArray<string>;
      weaponMode: WeaponMode;
      diceCount: number;
      rolls: ReadonlyArray<number>;
      threshold: number;
      hits: number;
      coverApplied: boolean;
      beforeDamage: DamageState;
      afterDamage: DamageState;
    }
  | {
      type: 'MELEE_RESOLVED';
      attackerId: string;
      defenderId: string;
      attackerHits: number;
      defenderHits: number;
      attackerDice: number;
      defenderDice: number;
      winnerId: string;
      loserId: string;
      isCharging: boolean;
      rerolls: number;
    }
  | {
      type: 'RALLY_ROLLED';
      unitId: string;
      threshold: number;
      roll: number;
      success: boolean;
      officerUsed: string | null;
      beforeDamage: DamageState;
      afterDamage: DamageState;
    };

export class CommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'CommandError';
  }
}

export interface CommandResult {
  readonly state: import('../state/GameState').GameState;
  readonly events: ReadonlyArray<GameEvent>;
}
