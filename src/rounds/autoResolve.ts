/**
 * Auto-resolution for round options the player did *not* take. Per
 * design §4.1: when a round commits one option, the rest are still
 * "executed" off-screen — each gets a single mission-success roll, and
 * each squad member in that option rolls independently for survival.
 *
 * v1 hard-codes both probabilities at 70%. When fuzzy difficulty lands
 * (Phase 3b), the survival rate (and the success rate) will scale off
 * the option's `fuzzy` band so a `high` mission punishes its squad
 * more than a `low` one. The function signature already takes the
 * option, so swapping in a fuzzy-driven rate is a one-line change.
 *
 * Determinism: the caller supplies a seed string so re-loading a saved
 * RunState reproduces the same fates. We derive a child RNG per option
 * to keep mission rolls and per-member rolls inside one option from
 * influencing other options' outcomes.
 */
import { Rng } from '../core/rng/sfc32';
import type { UnpickedOptionOutcome } from '../campaign/state';
import type { RoundMissionOption } from './state';

/** Mission auto-roll success probability. v1 placeholder; fuzzy-driven later. */
export const UNPICKED_MISSION_SUCCESS_RATE = 0.7;
/** Per-squad-member survival probability. v1 placeholder. */
export const UNPICKED_SURVIVAL_RATE = 0.7;

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
    const rng = Rng.fromSeed(`${seed}-unpicked-${i}`);
    const won = rng.next() < UNPICKED_MISSION_SUCCESS_RATE;
    const survivors: string[] = [];
    for (const id of opt.squadIds) {
      if (rng.next() < UNPICKED_SURVIVAL_RATE) survivors.push(id);
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
