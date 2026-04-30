/**
 * Auto-resolution for round options the player did *not* take. Per
 * design §4.1: when a round commits one option, the rest are still
 * "executed" off-screen — each gets a single mission-success roll, and
 * each squad member in that option rolls independently for survival.
 *
 * The success / survival rates come from the option's fuzzy band via
 * `fuzzyToRates` (see ./fuzzy.ts). v1 places medium at 70%/70%, low at
 * 85%/85%, high at 50%/55% — a "high risk" mission really does punish
 * its squad more than a "low risk" one.
 *
 * Determinism: the caller supplies a seed string so re-loading a saved
 * RunState reproduces the same fates. We derive a child RNG per option
 * to keep mission rolls and per-member rolls inside one option from
 * influencing other options' outcomes.
 */
import { Rng } from '../core/rng/sfc32';
import type { UnpickedOptionOutcome } from '../campaign/state';
import type { RoundMissionOption } from './state';
import { fuzzyToRates } from './fuzzy';

/**
 * Resolve the unpicked options of a round. `pickedIdx` is the index the
 * player chose (skipped here); every other option gets rolled.
 */
export const resolveUnpickedOptions = (
  options: ReadonlyArray<RoundMissionOption>,
  pickedIdx: number,
  seed: string,
): UnpickedOptionOutcome[] => {
  const out: UnpickedOptionOutcome[] = [];
  for (let i = 0; i < options.length; i++) {
    if (i === pickedIdx) continue;
    const opt = options[i]!;
    const rates = fuzzyToRates(opt.fuzzy);
    const rng = Rng.fromSeed(`${seed}-unpicked-${i}`);
    const won = rng.next() < rates.successRate;
    const survivors: string[] = [];
    for (const id of opt.squadIds) {
      if (rng.next() < rates.survivalRate) survivors.push(id);
    }
    out.push({
      missionId: opt.missionId,
      squadIds: opt.squadIds,
      survivorIds: survivors,
      won,
    });
  }
  return out;
};
