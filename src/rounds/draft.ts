/**
 * Slot-aware squad draft. Implements the design doc §6.2 "逐槽抽結構" rule:
 *
 *   Slot 1: prefer `officer` from the pool; fallback to anyone else.
 *   Slot 2: prefer `specialist` from the remaining pool; fallback to first
 *           non-officer remaining; final fallback to anyone remaining.
 *   Slot 3+: drawn from non-officer remaining; if exhausted, fall back to
 *            officers so the squad still reaches `size`.
 *
 * Deterministic given the same `pool` order and `Rng` state — call sites
 * shuffle (or pre-seed) the pool order ahead of time so the slot-1 pick is
 * a random officer rather than the first one in `pool`.
 */
import type { RosterEntry } from '../core/setup/types';
import type { RecruitRole } from '../config/loader';
import { getUnitTemplate } from '../config/loader';
import type { Rng } from '../core/rng/sfc32';

const roleOf = (entry: RosterEntry): RecruitRole => {
  try {
    return getUnitTemplate(entry.templateId).recruitRole ?? 'regular';
  } catch {
    // Unknown template — treat as regular so the draft never crashes a round.
    return 'regular';
  }
};

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
 * Draft `size` units from `pool` using slot priorities. Returns at most
 * `size` entries; if the pool is smaller than `size`, returns the whole
 * pool (caller's responsibility to refuse to start a round).
 */
export const draftSquad = (
  pool: ReadonlyArray<RosterEntry>,
  size: number,
  rng: Rng,
): RosterEntry[] => {
  if (size <= 0 || pool.length === 0) return [];
  const shuffled = seededShuffle(pool, rng);
  const remaining = new Set(shuffled.map((e) => e.id));
  const selected: RosterEntry[] = [];

  const takeFirst = (predicate: (e: RosterEntry) => boolean): boolean => {
    for (const e of shuffled) {
      if (!remaining.has(e.id)) continue;
      if (!predicate(e)) continue;
      selected.push(e);
      remaining.delete(e.id);
      return true;
    }
    return false;
  };

  // Slot 1: officer; fallback any.
  if (size >= 1) {
    const ok = takeFirst((e) => roleOf(e) === 'officer');
    if (!ok) takeFirst(() => true);
  }

  // Slot 2: specialist; fallback non-officer; fallback any.
  if (size >= 2 && remaining.size > 0) {
    const ok =
      takeFirst((e) => roleOf(e) === 'specialist') ||
      takeFirst((e) => roleOf(e) !== 'officer');
    if (!ok) takeFirst(() => true);
  }

  // Slot 3+: prefer non-officer; fallback officer (so squad fills).
  while (selected.length < size && remaining.size > 0) {
    const ok = takeFirst((e) => roleOf(e) !== 'officer');
    if (!ok) takeFirst(() => true);
  }

  return selected;
};
