/**
 * Pool replenishment. The campaign pool is kept topped up to POOL_TARGET
 * after every round; new recruits are drawn from bundled unit templates
 * grouped by `recruitRole`. The role mix targets roughly 1:3:7 (officer
 * : specialist : regular) per the design call — for POOL_TARGET=30 that
 * lands at 3:8:19, guaranteeing one officer per `MISSIONS_PER_ROUND`
 * slot-1 pick even before any honor upgrades (§6.2).
 *
 * Replenishment runs:
 *   - on `newCampaignState` (so the very first round already sees a
 *     30-person pool, not just the 12-unit STARTER_POOL),
 *   - at the tail of `advanceCampaignAfterRun` (so KIA churn from the
 *     fought run + auto-resolved unpicked options is repaired before
 *     the next round picks).
 *
 * Picks are seeded by the campaign seed × `nextRecruitId` so a campaign
 * is fully reproducible from `(seed, runHistory)` alone.
 */
import type { RosterEntry } from '../core/setup/types';
import { Rng } from '../core/rng/sfc32';
import type { RecruitRole, UnitTemplate } from './../config/loader';
import { listBundledTemplates } from './../config/loader';

/** Total pool size we top up to. */
export const POOL_TARGET = 30;

/**
 * Floor counts per role when topping up. Sums to POOL_TARGET, so a
 * fully-empty pool gets exactly this distribution; partial pools keep
 * existing role excesses and only fill deficits.
 */
export const ROLE_TARGETS: Record<RecruitRole, number> = {
  officer: 3,
  specialist: 8,
  regular: 19,
};

const roleOf = (entry: RosterEntry, byId: Map<string, UnitTemplate>): RecruitRole =>
  byId.get(entry.templateId)?.recruitRole ?? 'regular';

const groupBundledByRole = (): Record<RecruitRole, UnitTemplate[]> => {
  const out: Record<RecruitRole, UnitTemplate[]> = {
    officer: [],
    specialist: [],
    regular: [],
  };
  for (const t of listBundledTemplates()) {
    out[t.recruitRole ?? 'regular'].push(t);
  }
  return out;
};

export interface ReplenishResult {
  readonly pool: ReadonlyArray<RosterEntry>;
  readonly nextRecruitId: number;
}

/**
 * Top up `pool` to POOL_TARGET, respecting role floors. Existing members
 * are kept; only deficits get recruited. If a role has no bundled
 * templates available (shouldn't happen in v1 but defensive), that role's
 * deficit silently rolls into the next-best role.
 */
export const replenishPool = (
  pool: ReadonlyArray<RosterEntry>,
  rng: Rng,
  nextRecruitId: number,
): ReplenishResult => {
  const bundled = listBundledTemplates();
  const byId = new Map(bundled.map((t) => [t.templateId, t] as const));
  const buckets = groupBundledByRole();

  const counts: Record<RecruitRole, number> = { officer: 0, specialist: 0, regular: 0 };
  for (const e of pool) counts[roleOf(e, byId)] += 1;

  const out: RosterEntry[] = [...pool];
  let nextId = nextRecruitId;

  const recruitFromRole = (role: RecruitRole): boolean => {
    const candidates = buckets[role];
    if (candidates.length === 0) return false;
    const tpl = candidates[Math.floor(rng.next() * candidates.length)]!;
    out.push({ id: `pool-${nextId}`, templateId: tpl.templateId });
    nextId += 1;
    counts[role] += 1;
    return true;
  };

  // Pass 1 — fill role deficits in priority order. Officer first because
  // it's the hardest constraint (slot 1 of every option).
  const fillOrder: RecruitRole[] = ['officer', 'specialist', 'regular'];
  for (const role of fillOrder) {
    while (counts[role] < ROLE_TARGETS[role] && out.length < POOL_TARGET) {
      if (!recruitFromRole(role)) break;
    }
  }

  // Pass 2 — fill remainder up to POOL_TARGET with regulars (fallback to
  // any role if the regular bucket is somehow empty).
  while (out.length < POOL_TARGET) {
    if (recruitFromRole('regular')) continue;
    if (recruitFromRole('specialist')) continue;
    if (recruitFromRole('officer')) continue;
    break; // no bundled templates at all — give up.
  }

  return { pool: out, nextRecruitId: nextId };
};
