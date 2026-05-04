/**
 * RoundState — the per-round transient state. A "round" is a single
 *战役回合: the player is shown N operation options, each pre-allocated a
 * 4-unit squad drafted from the pool, and picks one to fight. The other
 * options aren't dice-rolled in 3a (that lands in 3b — until then,
 * unpicked operations get a single fuzzy roll on their main mission).
 *
 * Operation picks are seeded so the same campaign+round number always
 * produces the same options — letting the player back out of a round
 * (3b) without rerolling, and letting sims reproduce.
 */
import { Rng } from '../core/rng/sfc32';
import { pickOperations } from '../operations/pick';
import { getMissionById } from '../missions/library';
import { draftSquad } from './draft';
import { classifyFuzzy } from './fuzzy';
import type { CampaignState } from '../campaign/state';
import type { OperationInstance } from '../operations/types';

export type FuzzyDifficulty = 'low' | 'medium' | 'high';

export interface RoundOperationOption {
  readonly operation: OperationInstance;
  /**
   * Pool unit ids drafted for this operation. Same pool member can appear
   * in multiple options' squads — only the picked option commits its
   * squad to the run, so double-booking is harmless.
   */
  readonly squadIds: ReadonlyArray<string>;
  /**
   * Coarse difficulty hint shown to the player. Computed against the
   * operation's main (last) mission — the climax — since that's what the
   * autoResolve roll resolves against.
   */
  readonly fuzzy: FuzzyDifficulty;
}

export interface RoundState {
  /** Campaign seed × round, used to derive deterministic picks + drafts. */
  readonly seed: string;
  readonly roundIndex: number;
  readonly options: ReadonlyArray<RoundOperationOption>;
}

const OPERATIONS_PER_ROUND = 3;
const SQUAD_SIZE = 4;

/**
 * Roll a fresh round for the given campaign. Picks `OPERATIONS_PER_ROUND`
 * operations (with difficulty gating + chain instantiation via
 * `pickOperations`), then drafts `SQUAD_SIZE` random pool members per
 * operation. Both layers seed off `${campaignSeed}-r${roundIndex}` so a
 * round is fully reproducible.
 *
 * Fuzzy band per option is computed against the operation's main mission
 * (last in chain) — that's the one autoResolve rolls when the option is
 * not picked.
 */
export const newRoundState = (campaign: CampaignState): RoundState => {
  const seed = `${campaign.seed}-r${campaign.roundIndex}`;
  const operations = pickOperations(seed, campaign, OPERATIONS_PER_ROUND);
  const draftRng = Rng.fromSeed(`${seed}-draft`);

  const options: RoundOperationOption[] = operations.map((operation, i) => {
    // Independent draft per option so they're not correlated.
    const localRng = new Rng({ ...draftRng.state });
    for (let k = 0; k < i; k++) localRng.next(); // small step so each option's shuffle differs
    const drafted = draftSquad(campaign.pool, SQUAD_SIZE, localRng);
    const squadIds = drafted.map((u) => u.id);
    const mainMissionId =
      operation.missionIds[operation.missionIds.length - 1]!;
    const mainMission = getMissionById(mainMissionId);
    return {
      operation,
      squadIds,
      fuzzy: classifyFuzzy(mainMission, squadIds, campaign.pool),
    };
  });

  return { seed, roundIndex: campaign.roundIndex, options };
};
