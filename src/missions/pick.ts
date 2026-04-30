/**
 * Mission selection — given a seed and the library, draw `count` mission ids
 * with a variety bias: prefer one mission per scenario type before doubling
 * up. Deterministic per seed so the same seed reproduces the same run shape.
 *
 * Phase 2 leans on hand-crafted variants per scenario (see ./library.ts).
 * When generators arrive (later phase) they'll plug in here too.
 */
import { Rng } from '../core/rng/sfc32';
import { listAllMissions } from './library';
import type { MissionDef } from './types';
import type { ScenarioMode } from '../core/scenario/victory';

const groupByScenario = (
  library: ReadonlyArray<MissionDef>,
): Map<ScenarioMode, MissionDef[]> => {
  const groups = new Map<ScenarioMode, MissionDef[]>();
  for (const m of library) {
    const arr = groups.get(m.scenario);
    if (arr) arr.push(m);
    else groups.set(m.scenario, [m]);
  }
  return groups;
};

/**
 * Fisher-Yates with a seeded RNG so we get a deterministic shuffle. Returns
 * a new array; input is left untouched.
 */
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

/**
 * Draw `count` missions with variety bias:
 *  1. Round-robin across scenario types (random one per type) until we have
 *     count missions or have visited every type.
 *  2. If still short, draw extra missions from any remaining unused entries.
 *  3. Shuffle the final list so scenario order isn't fixed by registration.
 */
export const pickMissions = (
  seed: string,
  count: number = 3,
  library: ReadonlyArray<MissionDef> = listAllMissions(),
): string[] => {
  const rng = Rng.fromSeed(`mission-pick:${seed}`);
  const groups = groupByScenario(library);
  const types = seededShuffle(Array.from(groups.keys()), rng);
  const used = new Set<string>();
  const picks: MissionDef[] = [];

  // Round 1: one per type
  for (const t of types) {
    if (picks.length >= count) break;
    const candidates = groups.get(t)!.filter((m) => !used.has(m.id));
    if (candidates.length === 0) continue;
    const choice = seededShuffle(candidates, rng)[0]!;
    used.add(choice.id);
    picks.push(choice);
  }

  // Round 2+: fill remainder from anything not yet used
  if (picks.length < count) {
    const leftovers = library.filter((m) => !used.has(m.id));
    const shuffled = seededShuffle(leftovers, rng);
    for (const m of shuffled) {
      if (picks.length >= count) break;
      picks.push(m);
      used.add(m.id);
    }
  }

  return seededShuffle(picks, rng).map((m) => m.id);
};
