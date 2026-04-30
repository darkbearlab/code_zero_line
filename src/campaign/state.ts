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
}

/**
 * Phase 3a starter pool — 12 hand-picked units giving every template at
 * least one slot. Real pool initialization (officer slot guaranteed,
 * quality balanced) lands when the editor / draft UI materializes.
 */
const STARTER_POOL: ReadonlyArray<RosterEntry> = [
  { id: 'pool-1', templateId: 'squad_lead' },
  { id: 'pool-2', templateId: 'elite' },
  { id: 'pool-3', templateId: 'elite' },
  { id: 'pool-4', templateId: 'heavy_gunner' },
  { id: 'pool-5', templateId: 'veteran' },
  { id: 'pool-6', templateId: 'veteran' },
  { id: 'pool-7', templateId: 'trooper' },
  { id: 'pool-8', templateId: 'trooper' },
  { id: 'pool-9', templateId: 'trooper' },
  { id: 'pool-10', templateId: 'trooper' },
  { id: 'pool-11', templateId: 'conscript' },
  { id: 'pool-12', templateId: 'conscript' },
];

/** Minimum pool size for a round to be runnable (4-unit squad draft). */
export const MIN_POOL_SIZE = 4;

export const newCampaignState = (seed: string): CampaignState => ({
  version: 1,
  seed,
  roundIndex: 1,
  pool: STARTER_POOL,
  currencies: { tactical: 0, regional: 0, honor: 0 },
  runsCompleted: 0,
});

export const isCampaignOver = (s: CampaignState): boolean =>
  s.pool.length < MIN_POOL_SIZE;

/**
 * Outcome surface a finished run hands back to the campaign layer.
 * `squadIds` are the units that fought (so we know who to remove on
 * casualty); `survivorIds` are those that came back alive.
 */
export interface RunResolution {
  readonly missionId: string;
  readonly squadIds: ReadonlyArray<string>;
  readonly survivorIds: ReadonlyArray<string>;
  readonly winner: 'A' | 'B' | 'DRAW';
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
export const advanceCampaignAfterRun = (
  campaign: CampaignState,
  result: RunResolution,
): CampaignState => {
  const survived = new Set(result.survivorIds);
  const drafted = new Set(result.squadIds);
  const won = result.winner === 'A';

  const pool = campaign.pool.filter(
    (u) => !drafted.has(u.id) || survived.has(u.id),
  );

  const tactical = won
    ? Math.round(MISSION_BASE_INTEL * TACTICAL_SHARE)
    : 0;
  const regional = won
    ? Math.round(MISSION_BASE_INTEL * REGIONAL_SHARE)
    : 0;
  const honor = won ? HONOR_PER_WIN : 0;

  return {
    ...campaign,
    roundIndex: campaign.roundIndex + 1,
    runsCompleted: campaign.runsCompleted + 1,
    pool,
    currencies: {
      tactical: campaign.currencies.tactical + tactical,
      regional: campaign.currencies.regional + regional,
      honor: campaign.currencies.honor + honor,
    },
  };
};
