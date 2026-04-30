/**
 * RoundState — the per-round transient state. A "round" is a single
 *战役回合: the player is shown N mission options, each pre-allocated a
 * 4-unit squad drafted from the pool, and picks one to fight. The other
 * options aren't dice-rolled in 3a (that lands in 3b — until then,
 * unpicked missions just disappear).
 *
 * Mission picks are seeded so the same campaign+round number always
 * produces the same options — letting the player back out of a round
 * (3b) without rerolling, and letting sims reproduce.
 */
import { Rng } from '../core/rng/sfc32';
import { pickMissions } from '../missions/pick';
import { getMissionById } from '../missions/library';
import { draftSquad } from './draft';
import { classifyFuzzy } from './fuzzy';
import type { CampaignState } from '../campaign/state';

export type FuzzyDifficulty = 'low' | 'medium' | 'high';

export interface RoundMissionOption {
  readonly missionId: string;
  /**
   * Pool unit ids drafted for this mission. Same pool member can appear
   * in multiple options' squads — only the picked option commits its
   * squad to the run, so double-booking is harmless.
   */
  readonly squadIds: ReadonlyArray<string>;
  /** Coarse difficulty hint shown to the player. */
  readonly fuzzy: FuzzyDifficulty;
}

export interface RoundState {
  /** Campaign seed × round, used to derive deterministic picks + drafts. */
  readonly seed: string;
  readonly roundIndex: number;
  readonly options: ReadonlyArray<RoundMissionOption>;
}

const MISSIONS_PER_ROUND = 3;
const SQUAD_SIZE = 4;

/**
 * Roll a fresh round for the given campaign. Picks `MISSIONS_PER_ROUND`
 * missions with variety bias (via missions/pick.ts), then drafts
 * `SQUAD_SIZE` random pool members per mission. Both layers seed off
 * `${campaignSeed}-r${roundIndex}` so a round is fully reproducible.
 *
 * Fuzzy band per option is computed from squad strength vs enemy strength
 * (`./fuzzy.ts`); autoResolve uses that band to drive the unpicked roll.
 */
export const newRoundState = (campaign: CampaignState): RoundState => {
  const seed = `${campaign.seed}-r${campaign.roundIndex}`;
  const missionIds = pickMissions(seed, MISSIONS_PER_ROUND);
  const draftRng = Rng.fromSeed(`${seed}-draft`);

  const options: RoundMissionOption[] = missionIds.map((missionId, i) => {
    // Independent draft per mission so they're not correlated.
    const localRng = new Rng({ ...draftRng.state });
    for (let k = 0; k < i; k++) localRng.next(); // small step so each option's shuffle differs
    const drafted = draftSquad(campaign.pool, SQUAD_SIZE, localRng);
    const squadIds = drafted.map((u) => u.id);
    const mission = getMissionById(missionId);
    return {
      missionId,
      squadIds,
      fuzzy: classifyFuzzy(mission, squadIds, campaign.pool),
    };
  });

  return { seed, roundIndex: campaign.roundIndex, options };
};
