/**
 * Persistent upgrades the player buys between rounds. Each upgrade has up
 * to N levels; each level costs the next `costPerLevel[currentLevel]`.
 * Effects are applied at mission-build time via the helpers in this
 * module — they never mutate live state directly.
 *
 * Currency split per design (see docs/open-questions.md §N3):
 *   - 作戰情報 (tactical): 戰術知識, 對付特定敵人類型
 *   - 榮譽 (honor):  池子強化, 補給效率 — 組織層面
 *   - 區域情報 (regional): 兌換 → 作戰 (5:1)
 *
 * v1 ships 7 leveled upgrades. Region → tactical exchange is a one-shot
 * action handled by the UpgradeScene UI, not registered here.
 */
import type { GameStateCombatIntel } from '../core/state/GameState';

export type UpgradeCurrency = 'tactical' | 'regional' | 'honor';

export type UpgradeEffect =
  /** Adds `level` to the named combat-intel track (shoot.<tag> or melee.<tag>). */
  | { kind: 'COMBAT_INTEL'; track: 'shoot' | 'melee'; tag: string }
  /** Reduces every player unit's quality threshold by `level` (min 1). */
  | { kind: 'POOL_QUALITY' }
  /** Adds `level` momentum to faction A at mission start. */
  | { kind: 'INITIAL_MOMENTUM' };

export interface UpgradeDef {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly currency: UpgradeCurrency;
  /**
   * Cost paid to advance from level i → i+1. Length defines the maximum
   * level (3 entries = up to level 3, can't buy higher).
   */
  readonly costPerLevel: ReadonlyArray<number>;
  readonly effect: UpgradeEffect;
}

export const UPGRADE_REGISTRY: ReadonlyArray<UpgradeDef> = [
  // ── 作戰情報 (tactical) — 戰術知識 ─────────────────────────────────
  {
    id: 'anti_infantry',
    displayName: '對付步兵戰術',
    description:
      '針對 INFANTRY 類目標的射擊命中門檻 -1 / -2 / -3。\n' +
      '影響所有對人員、輕步兵的射擊。',
    currency: 'tactical',
    costPerLevel: [5, 12, 25],
    effect: { kind: 'COMBAT_INTEL', track: 'shoot', tag: 'INFANTRY' },
  },
  {
    id: 'anti_heavy',
    displayName: '對付重裝戰術',
    description:
      '針對 HEAVY 類目標的射擊命中門檻 -1 / -2 / -3。\n' +
      '對重裝兵 / 重火力單位特別有效。',
    currency: 'tactical',
    costPerLevel: [8, 18, 40],
    effect: { kind: 'COMBAT_INTEL', track: 'shoot', tag: 'HEAVY' },
  },
  {
    id: 'anti_command',
    displayName: '對付指揮戰術',
    description:
      '針對 COMMAND 類目標的射擊命中門檻 -1 / -2 / -3。\n' +
      '專門用於斬首行動 / 指揮單位獵殺。',
    currency: 'tactical',
    costPerLevel: [10, 24, 50],
    effect: { kind: 'COMBAT_INTEL', track: 'shoot', tag: 'COMMAND' },
  },
  {
    id: 'anti_mech',
    displayName: '對付機甲戰術',
    description:
      '針對 MECH 類目標的射擊命中門檻 -1 / -2 / -3。\n' +
      '預留:目前還沒有機甲類敵人,但鋪設好等實裝。',
    currency: 'tactical',
    costPerLevel: [12, 28, 60],
    effect: { kind: 'COMBAT_INTEL', track: 'shoot', tag: 'MECH' },
  },
  {
    id: 'melee_training',
    displayName: '近戰訓練',
    description:
      '近戰對 INFANTRY 類目標的命中門檻 -1 / -2 / -3。\n' +
      '只在進入近戰時生效;射擊不受影響。',
    currency: 'tactical',
    costPerLevel: [8, 18, 40],
    effect: { kind: 'COMBAT_INTEL', track: 'melee', tag: 'INFANTRY' },
  },

  // ── 榮譽 (honor) — 組織強化 ─────────────────────────────────────────
  {
    id: 'pool_quality',
    displayName: '池子強化',
    description:
      '池子內所有隊員(包含老兵)素質 -1 / -2 / -3 ,門檻越低越強。\n' +
      '不會降到 1+ 以下。新人也不爛。',
    currency: 'honor',
    costPerLevel: [5, 12, 25],
    effect: { kind: 'POOL_QUALITY' },
  },
  {
    id: 'field_supply',
    displayName: '補給效率',
    description:
      '每場戰鬥開始時 momentum +1 / +2 / +3。\n' +
      '更早能 SPEND 高素質單位,啟動火力更穩。',
    currency: 'honor',
    costPerLevel: [4, 10, 20],
    effect: { kind: 'INITIAL_MOMENTUM' },
  },
];

export const getUpgradeById = (id: string): UpgradeDef | undefined =>
  UPGRADE_REGISTRY.find((u) => u.id === id);

export const upgradeMaxLevel = (def: UpgradeDef): number =>
  def.costPerLevel.length;

/**
 * Cost to advance from current level to current+1, or null if maxed.
 */
export const upgradeNextCost = (
  def: UpgradeDef,
  currentLevel: number,
): number | null => {
  if (currentLevel >= def.costPerLevel.length) return null;
  return def.costPerLevel[currentLevel] ?? null;
};

/**
 * Project upgrade levels onto a combat-intel snapshot consumable by the
 * resolver. Layered: each COMBAT_INTEL upgrade contributes its current
 * level to the appropriate (track, tag) cell.
 */
export const buildCombatIntelFromUpgrades = (
  levels: Readonly<Record<string, number>>,
): GameStateCombatIntel => {
  const shoot: Record<string, number> = {};
  const melee: Record<string, number> = {};
  for (const def of UPGRADE_REGISTRY) {
    if (def.effect.kind !== 'COMBAT_INTEL') continue;
    const lvl = levels[def.id] ?? 0;
    if (lvl <= 0) continue;
    const target = def.effect.track === 'shoot' ? shoot : melee;
    target[def.effect.tag] = (target[def.effect.tag] ?? 0) + lvl;
  }
  return { shoot, melee };
};

/** Pool-quality upgrade level (0 if absent). Caller subtracts from quality. */
export const poolQualityBonus = (
  levels: Readonly<Record<string, number>>,
): number => {
  for (const def of UPGRADE_REGISTRY) {
    if (def.effect.kind === 'POOL_QUALITY') return levels[def.id] ?? 0;
  }
  return 0;
};

/** Initial-momentum upgrade level (0 if absent). Caller adds to A's momentum. */
export const initialMomentumBonus = (
  levels: Readonly<Record<string, number>>,
): number => {
  for (const def of UPGRADE_REGISTRY) {
    if (def.effect.kind === 'INITIAL_MOMENTUM') return levels[def.id] ?? 0;
  }
  return 0;
};
