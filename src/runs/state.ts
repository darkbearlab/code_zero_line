/**
 * Run-state machine for the roguelite vertical slice.
 *
 * A *run* is one squad's deployment: pick a fixed roster, fight N missions
 * in sequence, with an optional Hub between each mission to apply a boon.
 * State persists in memory only; no localStorage yet (that's Phase 3).
 *
 * Key contract: between missions, the player's squad carries over with the
 * accumulated boons applied. Damage state from the previous mission persists
 * unless a boon clears it.
 */
import type { RosterEntry } from '../core/setup/types';

/** Single applied effect that only lives for the current run. */
export type RunBoonEffect =
  | { kind: 'HEAL_ALL' }
  | { kind: 'BONUS_DICE'; amount: number }
  | { kind: 'NEXT_MISSION_HARDER'; extraEnemies: number; bonusDice: number };

export interface RunBoon {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly effect: RunBoonEffect;
}

export interface MissionResult {
  readonly missionId: string;
  readonly winner: 'A' | 'B' | 'DRAW';
  readonly survivorIds: ReadonlyArray<string>;
  readonly losses: ReadonlyArray<string>;
}

export interface RunState {
  readonly seed: string;
  readonly squad: ReadonlyArray<RosterEntry>;
  readonly missionIds: ReadonlyArray<string>;
  /** 0-based; index of the *next* mission to fight. */
  readonly missionIndex: number;
  /** Boons the player picked at each Hub between missions. */
  readonly pickedBoons: ReadonlyArray<RunBoon>;
  /**
   * Survivors of the most recent battle. Carried into the next mission's
   * deployment. Empty before mission 0 fights.
   */
  readonly survivorIds: ReadonlyArray<string>;
  /**
   * Per-unit damage carry-over: after each mission, the unit's `damage`
   * state is preserved into the next mission's spawn (unless a boon resets
   * it). Keyed by roster id.
   */
  readonly damageCarry: Readonly<Record<string, 'NONE' | 'IMPEDED' | 'SUPPRESSED'>>;
  readonly history: ReadonlyArray<MissionResult>;
  /**
   * When true, this run was launched from the campaign loop (Phase 3a).
   * RunResultScene inspects the flag to route back to RoundSetupScene
   * + persist campaign updates instead of returning to the title screen.
   * Defaults to undefined for legacy (sandbox / 3-mission run) flows.
   */
  readonly inCampaign?: boolean;
  /**
   * Snapshot of campaign upgrade levels at run-start. buildMissionState
   * applies these to the GameState (combat intel, pool quality bonus,
   * starting momentum). Frozen at run-start so a purchase mid-mission
   * can't retroactively buff the active battle.
   */
  readonly upgradeLevels?: Readonly<Record<string, number>>;
}

export const newRunState = (
  seed: string,
  squad: ReadonlyArray<RosterEntry>,
  missionIds: ReadonlyArray<string>,
): RunState => ({
  seed,
  squad,
  missionIds,
  missionIndex: 0,
  pickedBoons: [],
  survivorIds: squad.map((s) => s.id),
  damageCarry: Object.fromEntries(squad.map((s) => [s.id, 'NONE' as const])),
  history: [],
});

export const advanceAfterMission = (
  run: RunState,
  result: MissionResult,
  perUnitDamage: Readonly<Record<string, 'NONE' | 'IMPEDED' | 'SUPPRESSED'>>,
): RunState => ({
  ...run,
  missionIndex: run.missionIndex + 1,
  survivorIds: result.survivorIds,
  damageCarry: perUnitDamage,
  history: [...run.history, result],
});

export const applyBoon = (run: RunState, boon: RunBoon): RunState => {
  let damageCarry = run.damageCarry;
  if (boon.effect.kind === 'HEAL_ALL') {
    damageCarry = Object.fromEntries(
      Object.keys(run.damageCarry).map((id) => [id, 'NONE' as const]),
    );
  }
  return {
    ...run,
    pickedBoons: [...run.pickedBoons, boon],
    damageCarry,
  };
};

export const isRunOver = (run: RunState): boolean => {
  if (run.survivorIds.length === 0) return true; // squad wiped
  if (run.missionIndex >= run.missionIds.length) return true; // all missions done
  return false;
};

export const didRunSucceed = (run: RunState): boolean => {
  if (run.survivorIds.length === 0) return false;
  return run.missionIndex >= run.missionIds.length;
};

/**
 * Sum the on-going dice bonus from all picked boons. NEXT_MISSION_HARDER
 * only counts on the activation-after-pick (caller has to filter), so this
 * helper covers BONUS_DICE only — Hub uses the next-mission-only bonuses
 * separately.
 */
export const totalRunDiceBonus = (run: RunState): number => {
  let total = 0;
  for (const b of run.pickedBoons) {
    if (b.effect.kind === 'BONUS_DICE') total += b.effect.amount;
  }
  return total;
};

/**
 * One-shot "next mission" boon effects the Hub applied. After the next
 * mission consumes them, they should be cleared via consumeOneShotBoons.
 * Returned in order picked.
 */
export const oneShotBoonsFor = (
  run: RunState,
): ReadonlyArray<RunBoon> => {
  // For the vertical slice, NEXT_MISSION_HARDER is the only one-shot kind.
  const lastPickedIndex = run.pickedBoons.length - 1;
  if (lastPickedIndex < 0) return [];
  const last = run.pickedBoons[lastPickedIndex]!;
  return last.effect.kind === 'NEXT_MISSION_HARDER' ? [last] : [];
};
