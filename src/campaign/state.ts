/**
 * CampaignState — the only persistent layer in Phase 3a. Holds the
 * cross-run metadata: the player's pool of available units, accumulated
 * currencies, and which round we're on. Lives behind localStorage
 * (`czl.campaign.v1`); see `./persist.ts` for I/O.
 *
 * Shape is deliberately small for 3a — region topology, tutorial flag,
 * milestone tracking etc. land in 3b/c/d. The interface is versioned so
 * future shapes can migrate or reject old saves.
 */
import type { RosterEntry } from '../core/setup/types';
import { Rng } from '../core/rng/sfc32';
import { replenishPool } from './recruit';
import {
  upgradeNextCost,
  type UpgradeDef,
} from './upgrades';

export interface CampaignCurrencies {
  /** 作戰情報 — earned by the player's own runs (70% share). */
  readonly tactical: number;
  /** 區域情報 — world-produced (30%); main currency for unlocking regions. */
  readonly regional: number;
  /** 榮譽 — pool upgrades, slot reroll. Earned per-run-completed. */
  readonly honor: number;
}

export interface CampaignState {
  /** Save format version. Bumped on shape changes; older saves rejected. */
  readonly version: 1;
  /** Master seed; per-round picks derive from `${seed}-r${roundIndex}`. */
  readonly seed: string;
  /** 1-based round counter; round 1 is the first round of the campaign. */
  readonly roundIndex: number;
  /** Available units the round can draft squads from. Phase 3a starter pool. */
  readonly pool: ReadonlyArray<RosterEntry>;
  /** Earned-but-unspent currencies. Spending lands in 3c. */
  readonly currencies: CampaignCurrencies;
  /** Total runs completed (any outcome). Score-screen fodder. */
  readonly runsCompleted: number;
  /**
   * Persistent upgrades the player has purchased. Keys are UpgradeDef.id
   * (see ./upgrades.ts), values are the current level (1..maxLevel). 0 /
   * missing = not bought. Applied to each run's mission state at build
   * time (combat intel, pool quality, starting momentum, …).
   */
  readonly upgradeLevels: Readonly<Record<string, number>>;
  /**
   * Monotonic counter for naming auto-recruited pool members (`pool-{n}`).
   * Starts past the STARTER_POOL range so seed/recruit ids never collide.
   */
  readonly nextRecruitId: number;
}

/**
 * Phase 3a starter pool — 12 hand-picked units giving every template at
 * least one slot. Real pool initialization (officer slot guaranteed,
 * quality balanced) lands when the editor / draft UI materializes.
 */
const STARTER_POOL: ReadonlyArray<RosterEntry> = [
  { id: 'pool-1', templateId: 'squad_lead', sorties: 0 },
  { id: 'pool-2', templateId: 'elite', sorties: 0 },
  { id: 'pool-3', templateId: 'elite', sorties: 0 },
  { id: 'pool-4', templateId: 'heavy_gunner', sorties: 0 },
  { id: 'pool-5', templateId: 'veteran', sorties: 0 },
  { id: 'pool-6', templateId: 'veteran', sorties: 0 },
  { id: 'pool-7', templateId: 'trooper', sorties: 0 },
  { id: 'pool-8', templateId: 'trooper', sorties: 0 },
  { id: 'pool-9', templateId: 'trooper', sorties: 0 },
  { id: 'pool-10', templateId: 'trooper', sorties: 0 },
  { id: 'pool-11', templateId: 'conscript', sorties: 0 },
  { id: 'pool-12', templateId: 'conscript', sorties: 0 },
];

/** Minimum pool size for a round to be runnable (4-unit squad draft). */
export const MIN_POOL_SIZE = 4;

export const newCampaignState = (seed: string): CampaignState => {
  // Replenish from STARTER_POOL up to POOL_TARGET (30) on init so the
  // very first round already sees a full roster. Recruits get ids
  // pool-13 onward; nextRecruitId tracks the counter for future bumps.
  const rng = Rng.fromSeed(`${seed}-recruit-init`);
  const seeded = replenishPool(STARTER_POOL, rng, STARTER_POOL.length + 1);
  return {
    version: 1,
    seed,
    roundIndex: 1,
    pool: seeded.pool,
    currencies: { tactical: 0, regional: 0, honor: 0 },
    runsCompleted: 0,
    upgradeLevels: {},
    nextRecruitId: seeded.nextRecruitId,
  };
};

export const isCampaignOver = (s: CampaignState): boolean =>
  s.pool.length < MIN_POOL_SIZE;

/**
 * Outcome surface a finished run hands back to the campaign layer.
 * `squadIds` are the units that fought (so we know who to remove on
 * casualty); `survivorIds` are those that came back alive.
 *
 * `unpicked` is the auto-resolved fate of the round options the player
 * did *not* take (see `src/rounds/autoResolve.ts`). Each entry carries
 * its own KIA list so casualties roll into the same pool filter pass,
 * and `won` triggers the same regional-intel share as a manual victory.
 */
export interface UnpickedOptionOutcome {
  readonly missionId: string;
  readonly squadIds: ReadonlyArray<string>;
  readonly survivorIds: ReadonlyArray<string>;
  readonly won: boolean;
}

/**
 * Discriminated outcome of a finished run. Drives reward + KIA branching
 * in `advanceCampaignAfterRun`:
 *  - SINGLE_MISSION: legacy / sandbox-style — uses MISSION_BASE_INTEL
 *    formula. Honored when the run carried no operation context.
 *  - OPERATION_COMPLETE: every stage of the picked operation cleared;
 *    `banked` already includes the on-complete bonus.
 *  - OPERATION_FAILED: squad wiped mid-chain; `banked` is whatever
 *    perStage rewards accrued before the failure (possibly zero).
 *  - RETREATED: player chose to bail between stages; `banked` preserved,
 *    KIA processing skipped (all surviving units return safely).
 */
export type RunOutcome =
  | { readonly kind: 'SINGLE_MISSION'; readonly won: boolean }
  | { readonly kind: 'OPERATION_COMPLETE'; readonly banked: CampaignCurrencies }
  | { readonly kind: 'OPERATION_FAILED'; readonly banked: CampaignCurrencies }
  | { readonly kind: 'RETREATED'; readonly banked: CampaignCurrencies };

export interface RunResolution {
  readonly missionId: string;
  readonly squadIds: ReadonlyArray<string>;
  readonly survivorIds: ReadonlyArray<string>;
  /**
   * Battle outcome of the most recent mission for legacy callers / UI.
   * Reward + KIA branching is driven by `outcome` instead.
   */
  readonly winner: 'A' | 'B' | 'DRAW';
  readonly outcome?: RunOutcome;
  readonly unpicked?: ReadonlyArray<UnpickedOptionOutcome>;
}

const MISSION_BASE_INTEL = 10;
const TACTICAL_SHARE = 0.7;
const REGIONAL_SHARE = 0.3;
const HONOR_PER_WIN = 1;

/**
 * Apply a finished run to the campaign:
 *  - bump roundIndex + runsCompleted
 *  - remove KIA squad members from the pool (3a simplification: any
 *    drafted unit not in survivorIds is gone)
 *  - award currency on victory only
 *
 * Phase 3a treats *any* drafted unit as deployed; 3b will refine this
 * (sortie counter increment, fuzzy-roll for losses on lost battles, etc).
 */
/**
 * Region-intel → tactical-intel exchange rate per design §N3 / §7.3.
 * Hard-coded for v1; later phases may unlock cheaper rates as upgrades.
 */
export const REGIONAL_TO_TACTICAL_RATE = 5;

/**
 * Buy the next level of an upgrade. Returns the new state on success or
 * null if the player can't afford / the upgrade is maxed. Caller should
 * surface the null with a UI nudge.
 */
export const buyUpgrade = (
  campaign: CampaignState,
  def: UpgradeDef,
): CampaignState | null => {
  const current = campaign.upgradeLevels[def.id] ?? 0;
  const cost = upgradeNextCost(def, current);
  if (cost === null) return null; // already maxed
  const wallet = campaign.currencies[def.currency];
  if (wallet < cost) return null;
  return {
    ...campaign,
    currencies: { ...campaign.currencies, [def.currency]: wallet - cost },
    upgradeLevels: { ...campaign.upgradeLevels, [def.id]: current + 1 },
  };
};

/**
 * One-shot exchange: pay 5 regional → gain 1 tactical. Returns null when
 * regional balance is below the rate.
 */
export const exchangeRegionalForTactical = (
  campaign: CampaignState,
): CampaignState | null => {
  if (campaign.currencies.regional < REGIONAL_TO_TACTICAL_RATE) return null;
  return {
    ...campaign,
    currencies: {
      ...campaign.currencies,
      regional: campaign.currencies.regional - REGIONAL_TO_TACTICAL_RATE,
      tactical: campaign.currencies.tactical + 1,
    },
  };
};

export const advanceCampaignAfterRun = (
  campaign: CampaignState,
  result: RunResolution,
): CampaignState => {
  // Default to legacy single-mission outcome when caller didn't tag one
  // — keeps sandbox / 3-mission run paths untouched.
  const outcome: RunOutcome =
    result.outcome ?? {
      kind: 'SINGLE_MISSION',
      won: result.winner === 'A',
    };

  // KIA = (drafted ∖ survived) for the picked side. Retreat gives every
  // surviving unit safe passage, so we skip the picked-side KIA pass; the
  // squad list survives intact regardless of survivorIds at retreat time.
  const kia = new Set<string>();
  if (outcome.kind !== 'RETREATED') {
    for (const id of result.squadIds) {
      if (!result.survivorIds.includes(id)) kia.add(id);
    }
  }
  // Unpicked options are auto-resolved up-front (§4.1) and unaffected by
  // a retreat decision on the picked op — KIA still rolls in.
  for (const u of result.unpicked ?? []) {
    for (const id of u.squadIds) {
      if (!u.survivorIds.includes(id)) kia.add(id);
    }
  }

  // Sortie tally — every survivor of any deployed option (picked + each
  // unpicked) gets +1 per design §6.3 + §4.1 ("活的回池(出擊次數+1)").
  // Iterates every (squadIds, survivorIds) pair so a unit double-drafted
  // across options (current draft allows overlap) gets a bump per slot;
  // matches the rest of the pool flow until draft-overlap is fixed.
  const sortieBumps = new Map<string, number>();
  const bump = (id: string) =>
    sortieBumps.set(id, (sortieBumps.get(id) ?? 0) + 1);
  for (const id of result.survivorIds) bump(id);
  for (const u of result.unpicked ?? []) for (const id of u.survivorIds) bump(id);

  const filtered = campaign.pool
    .filter((u) => !kia.has(u.id))
    .map((u) =>
      sortieBumps.has(u.id)
        ? { ...u, sorties: (u.sorties ?? 0) + sortieBumps.get(u.id)! }
        : u,
    );

  // Picked-side rewards: legacy formula for SINGLE_MISSION; banked rewards
  // (already including any onCompleteReward) for operation outcomes.
  let pickedTactical = 0;
  let pickedRegional = 0;
  let pickedHonor = 0;
  if (outcome.kind === 'SINGLE_MISSION') {
    if (outcome.won) {
      pickedTactical = Math.round(MISSION_BASE_INTEL * TACTICAL_SHARE);
      pickedRegional = Math.round(MISSION_BASE_INTEL * REGIONAL_SHARE);
      pickedHonor = HONOR_PER_WIN;
    }
  } else {
    pickedTactical = outcome.banked.tactical;
    pickedRegional = outcome.banked.regional;
    pickedHonor = outcome.banked.honor;
  }
  // Unpicked regional share is independent of the picked outcome.
  const unpickedWins = (result.unpicked ?? []).filter((u) => u.won).length;
  const tactical = pickedTactical;
  const regional =
    pickedRegional + unpickedWins * Math.round(MISSION_BASE_INTEL * REGIONAL_SHARE);
  const honor = pickedHonor;

  // Replenish before returning so the next round's RoundSetupScene already
  // sees a full POOL_TARGET roster. Seeded by campaign seed × round so
  // recruits are deterministic and reproducible.
  const recruitRng = Rng.fromSeed(
    `${campaign.seed}-recruit-r${campaign.roundIndex}`,
  );
  const replenished = replenishPool(filtered, recruitRng, campaign.nextRecruitId);

  return {
    ...campaign,
    roundIndex: campaign.roundIndex + 1,
    runsCompleted: campaign.runsCompleted + 1,
    pool: replenished.pool,
    nextRecruitId: replenished.nextRecruitId,
    currencies: {
      tactical: campaign.currencies.tactical + tactical,
      regional: campaign.currencies.regional + regional,
      honor: campaign.currencies.honor + honor,
    },
  };
};
