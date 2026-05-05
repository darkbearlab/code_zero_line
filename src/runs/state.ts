/**
 * Run-state machine for the roguelite vertical slice.
 *
 * A *run* is one squad's deployment: pick a fixed roster, fight N missions
 * in sequence, with an optional Hub between each mission to apply a boon.
 * Phase 3a wires multi-stage **operations** in: when launched from the
 * campaign loop, a run carries an `operation` context (per-stage + on-
 * complete reward templates) and `bankedRewards` accumulator. Single-
 * mission / sandbox runs leave both undefined and behave as before.
 *
 * Key contract: between missions, the player's squad carries over with the
 * accumulated boons applied. Damage state from the previous mission persists
 * unless a boon clears it.
 */
import type { RosterEntry } from '../core/setup/types';
import type { UnpickedOptionOutcome, CampaignCurrencies } from '../campaign/state';
import type { StageLabel } from '../operations/types';
import type { MissionDef } from '../missions/types';

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
  /**
   * True iff the mission was launched in stealth (state.stealth started
   * present + active) AND ended with `state.stealth.active === false` —
   * i.e. the player triggered (and didn't defer-then-rescue) a break.
   * `advanceAfterMission` reads this to flip `operationStealthAlive` to
   * false for the rest of the chain. Absent / false on non-stealth or
   * stealth-preserved missions.
   */
  readonly stealthBroken?: boolean;
}

/**
 * Operation chain context carried by a run launched from the campaign
 * loop. Reward templates are snapshotted at run-start so a mid-run
 * editor change can't retro-buff banked rewards.
 */
export interface RunOperationContext {
  readonly operationId: string;
  readonly stageLabels: ReadonlyArray<StageLabel>;
  readonly perStageReward: CampaignCurrencies;
  readonly onCompleteReward: CampaignCurrencies;
  /** Snapshot of `OperationDef.stealthEntry`. Drives `RunState.operationStealthAlive` init. */
  readonly stealthEntry?: boolean;
  /** Snapshot of `OperationDef.noIntelEntry`. Drives `RunState.operationNoIntelAlive` init. */
  readonly noIntelEntry?: boolean;
  /** Snapshot of `OperationDef.enforceDeploymentSlotsEntry`. */
  readonly enforceDeploymentSlotsEntry?: boolean;
}

const ZERO_CURRENCIES: CampaignCurrencies = {
  tactical: 0,
  regional: 0,
  honor: 0,
};

const addCurrencies = (
  a: CampaignCurrencies,
  b: CampaignCurrencies,
): CampaignCurrencies => ({
  tactical: a.tactical + b.tactical,
  regional: a.regional + b.regional,
  honor: a.honor + b.honor,
});

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
  /**
   * Auto-resolved fates of the round's unselected mission options
   * (§4.1). Pre-rolled at commitOption time so they survive a reload
   * and feed deterministically into `advanceCampaignAfterRun`.
   */
  readonly unpickedOutcomes?: ReadonlyArray<UnpickedOptionOutcome>;
  /**
   * Operation chain context — present when run was launched from a
   * picked operation card (Stage 3+). Drives per-stage banking and
   * outcome routing.
   */
  readonly operation?: RunOperationContext;
  /**
   * Currencies banked from per-stage wins so far in this operation.
   * On the final-stage win this also includes onCompleteReward.
   * Only meaningful when `operation` is set.
   */
  readonly bankedRewards?: CampaignCurrencies;
  /**
   * Set true when the player chose to retreat between stages. Causes
   * the run-over check to fire and the campaign-side resolution to
   * skip KIA for the surviving squad.
   */
  readonly retreated?: boolean;
  /**
   * Chain-level stealth state. Initialised from
   * `operation?.stealthEntry === true`. Flips to false (and sticks) when
   * any mission ends with its `state.stealth.active === false` while it
   * was launched in stealth. Subsequent missions then inherit non-stealth
   * unless they carry `stealthMode: 'force-on'`. Undefined for sandbox /
   * non-operation runs.
   */
  readonly operationStealthAlive?: boolean;
  /**
   * Chain-level no-intel (fog-of-war) state. Initialised from
   * `operation?.noIntelEntry === true`. Persists across stages until a
   * mission with `noIntelMode: 'force-off'` runs — that mission's
   * advance flips this to false for all later stages. Unlike stealth,
   * this isn't broken by in-mission events; it represents lack of
   * mission briefing rather than active concealment. Undefined for
   * sandbox / non-operation runs.
   */
  readonly operationNoIntelAlive?: boolean;
  /**
   * Chain-level "enforce deployment slots" state. Initialised from
   * `operation?.enforceDeploymentSlotsEntry === true`. Persists across
   * stages until a mission with `deploymentSlotsMode: 'force-off'` runs —
   * that mission's advance flips this to false for all later stages.
   * Independent of stealth / no-intel. Undefined for sandbox / non-
   * operation runs.
   */
  readonly operationDeploymentSlotsAlive?: boolean;
}

export const newRunState = (
  seed: string,
  squad: ReadonlyArray<RosterEntry>,
  missionIds: ReadonlyArray<string>,
  operation?: RunOperationContext,
): RunState => ({
  seed,
  squad,
  missionIds,
  missionIndex: 0,
  pickedBoons: [],
  survivorIds: squad.map((s) => s.id),
  damageCarry: Object.fromEntries(squad.map((s) => [s.id, 'NONE' as const])),
  history: [],
  ...(operation ? { operation, bankedRewards: ZERO_CURRENCIES } : {}),
  ...(operation?.stealthEntry === true ? { operationStealthAlive: true } : {}),
  ...(operation?.noIntelEntry === true ? { operationNoIntelAlive: true } : {}),
  ...(operation?.enforceDeploymentSlotsEntry === true
    ? { operationDeploymentSlotsAlive: true }
    : {}),
});

/**
 * Resolve whether a mission should launch in stealth state, given the
 * current run-level chain state. Per-mission `stealthMode` override wins
 * over chain inheritance:
 *   - 'force-on'  → always stealth
 *   - 'force-off' → never stealth
 *   - undefined   → inherit `run.operationStealthAlive` (true/false/undefined)
 */
export const currentMissionStealthActive = (
  run: RunState,
  mission: MissionDef,
): boolean => {
  if (mission.stealthMode === 'force-on') return true;
  if (mission.stealthMode === 'force-off') return false;
  return run.operationStealthAlive === true;
};

/**
 * Resolve whether a mission should launch under no-intel (fog-of-war),
 * given current chain state. Per-mission `noIntelMode` override wins
 * over chain inheritance. Independent of stealth — the two flags compose.
 */
export const currentMissionNoIntelActive = (
  run: RunState,
  mission: MissionDef,
): boolean => {
  if (mission.noIntelMode === 'force-on') return true;
  if (mission.noIntelMode === 'force-off') return false;
  return run.operationNoIntelAlive === true;
};

/**
 * Resolve whether a mission should enforce deployment slot occupancy at
 * pre-battle deploy time. Per-mission `deploymentSlotsMode` override wins
 * over chain inheritance. Independent of stealth / no-intel.
 */
export const currentMissionDeploymentSlotsActive = (
  run: RunState,
  mission: MissionDef,
): boolean => {
  if (mission.deploymentSlotsMode === 'force-on') return true;
  if (mission.deploymentSlotsMode === 'force-off') return false;
  return run.operationDeploymentSlotsAlive === true;
};

export const advanceAfterMission = (
  run: RunState,
  result: MissionResult,
  perUnitDamage: Readonly<Record<string, 'NONE' | 'IMPEDED' | 'SUPPRESSED'>>,
  /**
   * The just-completed mission's `stealthMode`. Force-off missions don't
   * write back to chain stealth (their state isn't part of the operation
   * stealth contract). Omit when caller has no mission def at hand —
   * defaults to chain-write-back-eligible.
   */
  missionStealthMode?: 'force-on' | 'force-off',
  /**
   * The just-completed mission's `noIntelMode`. Only `force-off` writes
   * back to chain state (clearing the fog for later stages — the
   * intel-pickup mission). All other modes leave chain state untouched.
   */
  missionNoIntelMode?: 'force-on' | 'force-off',
  /**
   * The just-completed mission's `deploymentSlotsMode`. Only `force-off`
   * writes back to chain state (clearing the slot enforcement for later
   * stages). All other modes leave chain state untouched.
   */
  missionDeploymentSlotsMode?: 'force-on' | 'force-off',
): RunState => {
  let bankedRewards = run.bankedRewards;
  if (result.winner === 'A' && run.operation) {
    bankedRewards = addCurrencies(
      bankedRewards ?? ZERO_CURRENCIES,
      run.operation.perStageReward,
    );
    const isFinalStage = run.missionIndex + 1 >= run.missionIds.length;
    if (isFinalStage) {
      bankedRewards = addCurrencies(
        bankedRewards,
        run.operation.onCompleteReward,
      );
    }
  }
  // Chain stealth inheritance — only the alive→dead transition is writable
  // (we never resurrect a dead chain, even if a stealth mission happened to
  // preserve stealth). Force-off missions are excluded by design: their
  // result is opaque to the operation chain.
  let operationStealthAlive = run.operationStealthAlive;
  if (
    operationStealthAlive === true &&
    result.stealthBroken === true &&
    missionStealthMode !== 'force-off'
  ) {
    operationStealthAlive = false;
  }
  // Chain no-intel: only `force-off` missions clear it (e.g. an
  // intel-pickup stage that resolves the fog for the rest of the chain).
  let operationNoIntelAlive = run.operationNoIntelAlive;
  if (
    operationNoIntelAlive === true &&
    missionNoIntelMode === 'force-off'
  ) {
    operationNoIntelAlive = false;
  }
  // Chain deployment-slot enforcement: only `force-off` clears it.
  let operationDeploymentSlotsAlive = run.operationDeploymentSlotsAlive;
  if (
    operationDeploymentSlotsAlive === true &&
    missionDeploymentSlotsMode === 'force-off'
  ) {
    operationDeploymentSlotsAlive = false;
  }
  return {
    ...run,
    missionIndex: run.missionIndex + 1,
    survivorIds: result.survivorIds,
    damageCarry: perUnitDamage,
    history: [...run.history, result],
    ...(bankedRewards ? { bankedRewards } : {}),
    ...(operationStealthAlive !== run.operationStealthAlive
      ? { operationStealthAlive }
      : {}),
    ...(operationNoIntelAlive !== run.operationNoIntelAlive
      ? { operationNoIntelAlive }
      : {}),
    ...(operationDeploymentSlotsAlive !== run.operationDeploymentSlotsAlive
      ? { operationDeploymentSlotsAlive }
      : {}),
  };
};

/**
 * Mark the run as retreated. Skips the next stage entirely; survivors
 * stay alive and bankedRewards (whatever's been earned through prior
 * won stages) is preserved. Calling on a non-operation run is a no-op
 * but still sets the flag for symmetry.
 */
export const retreatOperation = (run: RunState): RunState => ({
  ...run,
  retreated: true,
  // Skip remaining stages so isRunOver fires.
  missionIndex: run.missionIds.length,
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
  if (run.retreated) return true;
  if (run.survivorIds.length === 0) return true; // squad wiped
  if (run.missionIndex >= run.missionIds.length) return true; // all missions done
  return false;
};

export const didRunSucceed = (run: RunState): boolean => {
  if (run.retreated) return false;
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
