/**
 * Operation picker — selects N campaign-pool operations and binds concrete
 * mission ids into each one's chain. Output is fed straight to RoundState.
 *
 * Determinism: derived entirely from `seed` + bundled / overlay JSON. Same
 * seed always produces the same operations and the same chain instantiation.
 *
 * Difficulty gating: round 1 sees only `difficulty <= 1`, rising by 1 every
 * 2 rounds (round 3 caps at 2, round 5 at 3, …). When the cap excludes
 * everything the picker falls back to the full pool to avoid empty draws.
 */
import { Rng } from '../core/rng/sfc32';
import type { CampaignState } from '../campaign/state';
import type { ScenarioMode } from '../core/scenario/victory';
import type { MissionDef } from '../missions/types';
import { listCampaignPoolMissions } from '../missions/library';
import { listCampaignPoolOperations } from './registry';
import type {
  DifficultyBand,
  OperationChainDef,
  OperationDef,
  OperationInstance,
  StageLabel,
} from './types';

export const OPERATIONS_PER_ROUND_DEFAULT = 3;

const DEFAULT_ELIM_MODES: ReadonlyArray<ScenarioMode> = [
  'engage-reach',
  'elimination',
];

const seededShuffle = <T>(arr: ReadonlyArray<T>, rng: Rng): T[] => {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
};

const inBand = (n: number, [lo, hi]: DifficultyBand): boolean =>
  n >= lo && n <= hi;

/**
 * Difficulty cap rises with roundIndex: round 1 = 1, round 3 = 2, round 5 = 3, …
 * Capped at 5 (the absolute max). Used to gate which operations the picker
 * may surface this round; keeps brutal ops out of the early game.
 */
export const difficultyCapForRound = (roundIndex: number): number =>
  Math.min(5, 1 + Math.floor(Math.max(0, roundIndex - 1) / 2));

/**
 * Draw `n` operations with a soft variety bias and difficulty gating.
 * Strategy:
 *   1. Shuffle the gated (≤cap) pool, take up to n.
 *   2. If short of n, top up from the over-cap operations (also shuffled,
 *      gated picks preferred so the band still biases the round).
 *   3. If the pool itself is smaller than n, return whatever was drawn —
 *      we don't pad with repeats.
 */
export const pickOperationDefs = (
  seed: string,
  campaign: CampaignState,
  n: number,
  pool: ReadonlyArray<OperationDef> = listCampaignPoolOperations(),
): OperationDef[] => {
  if (pool.length === 0) return [];
  const cap = difficultyCapForRound(campaign.roundIndex);
  const gated = pool.filter((o) => o.difficulty <= cap);
  const overCap = pool.filter((o) => o.difficulty > cap);
  const rng = Rng.fromSeed(`operation-pick:${seed}`);
  const picks: OperationDef[] = [];
  for (const o of seededShuffle(gated, rng)) {
    if (picks.length >= n) break;
    picks.push(o);
  }
  if (picks.length < n) {
    for (const o of seededShuffle(overCap, rng)) {
      if (picks.length >= n) break;
      picks.push(o);
    }
  }
  return picks;
};

const pickFromPool = (
  pool: ReadonlyArray<MissionDef>,
  count: number,
  rng: Rng,
  exclude: ReadonlySet<string>,
): MissionDef[] => {
  const eligible = pool.filter((m) => !exclude.has(m.id));
  if (eligible.length === 0) return [];
  const shuffled = seededShuffle(eligible, rng);
  const out: MissionDef[] = [];
  for (const m of shuffled) {
    if (out.length >= count) break;
    out.push(m);
  }
  // If we can't fill (small pool), let elims repeat — the operation chain
  // just gets shorter than designed rather than crashing.
  return out;
};

const pickElims = (
  chain: OperationChainDef,
  rng: Rng,
  missionPool: ReadonlyArray<MissionDef>,
  excludePinned: ReadonlySet<string>,
): MissionDef[] => {
  const modes = chain.elimModeFilter ?? DEFAULT_ELIM_MODES;
  const matching = missionPool.filter(
    (m) =>
      modes.includes(m.scenario) && inBand(m.difficulty, chain.elimDifficultyBand),
  );
  // Loosen if too few — drop the mode filter first, then the band.
  const tier1 = matching.length >= chain.eliminations ? matching : null;
  const tier2 =
    tier1 ??
    missionPool.filter((m) => inBand(m.difficulty, chain.elimDifficultyBand));
  const tier3 = tier2.length >= chain.eliminations ? tier2 : missionPool;
  return pickFromPool(tier3, chain.eliminations, rng, excludePinned);
};

const pickMain = (
  chain: OperationChainDef,
  rng: Rng,
  missionPool: ReadonlyArray<MissionDef>,
): MissionDef | null => {
  if (chain.mainMissionId) {
    const pinned = missionPool.find((m) => m.id === chain.mainMissionId);
    return pinned ?? null;
  }
  const c = chain.mainConstraints;
  const modes = c?.modes;
  const band = c?.difficultyBand;
  const candidates = missionPool.filter((m) => {
    if (modes && !modes.includes(m.scenario)) return false;
    if (band && !inBand(m.difficulty, band)) return false;
    return true;
  });
  const usable = candidates.length > 0 ? candidates : missionPool;
  if (usable.length === 0) return null;
  return seededShuffle(usable, rng)[0] ?? null;
};

export const instantiateOperation = (
  def: OperationDef,
  seed: string,
  missionPool: ReadonlyArray<MissionDef> = listCampaignPoolMissions(),
): OperationInstance | null => {
  const rng = Rng.fromSeed(`op-instantiate:${seed}:${def.id}`);
  const main = pickMain(def.chain, rng, missionPool);
  if (!main) return null;
  const elims = pickElims(
    def.chain,
    rng,
    missionPool,
    new Set([main.id]),
  );
  if (elims.length === 0 && def.chain.eliminations > 0) return null;
  const missionIds: string[] = [...elims.map((m) => m.id), main.id];
  const stageLabels: StageLabel[] = [
    ...elims.map((): StageLabel => 'ELIM'),
    'MAIN',
  ];
  return {
    operationId: def.id,
    missionIds,
    stageLabels,
    difficulty: def.difficulty,
    rewards: def.rewards,
    ...(def.stealthEntry === true ? { stealthEntry: true } : {}),
    ...(def.noIntelEntry === true ? { noIntelEntry: true } : {}),
  };
};

/**
 * Top-level: pick `n` operations for the given campaign round and bind
 * each one's chain to concrete mission ids. Operations whose chain cannot
 * be instantiated (e.g. their pinned main mission was removed) are
 * silently dropped — the UI just sees fewer cards rather than crashing.
 */
export const pickOperations = (
  seed: string,
  campaign: CampaignState,
  n: number = OPERATIONS_PER_ROUND_DEFAULT,
  opPool: ReadonlyArray<OperationDef> = listCampaignPoolOperations(),
  missionPool: ReadonlyArray<MissionDef> = listCampaignPoolMissions(),
): OperationInstance[] => {
  const defs = pickOperationDefs(seed, campaign, n, opPool);
  const out: OperationInstance[] = [];
  for (let i = 0; i < defs.length; i++) {
    const inst = instantiateOperation(
      defs[i]!,
      `${seed}-slot-${i}`,
      missionPool,
    );
    if (inst) out.push(inst);
  }
  return out;
};
