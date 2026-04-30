/**
 * Veteran auto-growth (design §6.3).
 *
 * 出擊次數每 N 次 → 素質 +1（lower quality number = better）。免費、
 * 自動，因為情感引擎不能收費。Auto-growth alone caps at quality 3+;
 * 突破 3+ 必須靠 +quality skill (Phase 4)。Pool 強化升級會疊加在
 * 老兵成長之上 — pool 升級的 floor 是 1+，老兵成長自己的 floor 是 3+。
 *
 * 數值 sim 階段會調 — 目前以「3 出擊 = +1 素質」為起點。
 */

/** Sorties needed per +1 quality (lower quality number). */
export const VETERAN_SORTIE_THRESHOLD = 3;

/** Auto-growth never takes a unit below this quality on its own. */
export const VETERAN_QUALITY_FLOOR = 3;

/** Number of quality steps the unit has earned from sorties alone. */
export const sortieQualityBonus = (sorties: number): number =>
  Math.floor(Math.max(0, sorties) / VETERAN_SORTIE_THRESHOLD);

/**
 * Apply sortie-based growth to a base quality, respecting the
 * auto-growth floor. Pool upgrades (which can pierce 3+) are layered
 * on top by callers (see missions/buildState.ts).
 *
 * Units that already start better than the floor (e.g. squad_lead at
 * q2) are unaffected — auto-growth never makes a unit worse, so the
 * effective floor for them is their own base quality.
 */
export const veteranAdjustedQuality = (
  baseQuality: number,
  sorties: number,
): number => {
  const bonus = sortieQualityBonus(sorties);
  if (bonus === 0) return baseQuality;
  const floor = Math.min(VETERAN_QUALITY_FLOOR, baseQuality);
  return Math.max(floor, baseQuality - bonus);
};
