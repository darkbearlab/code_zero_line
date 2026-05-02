import type { Weapon } from '../state/GameState';
import { parseIdParam } from '../util/idParam';

/**
 * Static descriptor definition. Mirrors `TraitDef` — declarative metadata
 * the editor reads to build the descriptor checkbox UI; runtime checks
 * still query by id via `weaponHasDescriptor` / `sumWeaponDescriptorParam`.
 *
 * Implementation status:
 *   ✓ wired into the rules engine
 *   • declared but behavior pending
 */
export interface DescriptorDef {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Carries an integer parameter via `ID:N` (e.g. ARMOR_PIERCE:2). */
  readonly hasParam?: boolean;
  /** Marker that more complex behavior is required and not yet implemented. */
  readonly tbd?: boolean;
}

export const DESCRIPTORS: Readonly<Record<string, DescriptorDef>> = {
  // ✓ Focused fire eligibility (rule 4.3 §2). Read in shoot_modes.
  FOCUSED: {
    id: 'FOCUSED',
    displayName: '集火',
    description:
      '此武器可參與集火射擊。發起者周圍 1 單位距離內、對目標有視線的友軍可加入。',
  },
  // ✓ Combined fire eligibility (rule 4.3 §3). Read in shoot_modes.
  COMBINED: {
    id: 'COMBINED',
    displayName: '聯合射擊',
    description:
      '此武器可參與軍官發起的聯合射擊。對軍官及目標皆有視線的友軍可加入。',
  },
  // ✓ Ignore cover (sniper rifle etc.). Read in shooting.ts.
  IGNORE_COVER: {
    id: 'IGNORE_COVER',
    displayName: '無視掩體',
    description: '射擊時忽略目標的掩體 −1 骰懲罰。',
  },
  // ✓ Armor piercing (RPG etc.). Read in shooting.ts.
  ARMOR_PIERCE: {
    id: 'ARMOR_PIERCE',
    displayName: '穿甲',
    description: '攻擊方造成的命中在被裝甲吸收前先扣除 N 點裝甲值。',
    hasParam: true,
  },
  // • Blast — declared; AoE/spread behavior pending.
  BLAST: {
    id: 'BLAST',
    displayName: '爆破',
    description: '範圍效果武器（規則待補：散佈/連帶傷害）。',
    tbd: true,
  },
  // ✓ Reload — once per activation per (unit, weapon). Wired in shooting.ts.
  RELOAD: {
    id: 'RELOAD',
    displayName: '填裝',
    description: '此武器每個主動權限該單位使用 1 次。',
  },
};

export const getDescriptorDef = (id: string): DescriptorDef | undefined =>
  DESCRIPTORS[id];

export const listDescriptors = (): ReadonlyArray<DescriptorDef> =>
  Object.values(DESCRIPTORS);

/**
 * Whether the weapon carries a descriptor with the given id (ignoring any
 * parameter). E.g., `weaponHasDescriptor(rpg, 'BLAST')` matches `BLAST` and
 * `BLAST:0`.
 */
export const weaponHasDescriptor = (w: Weapon, id: string): boolean =>
  w.descriptors.some((d) => parseIdParam(d).id === id);

/**
 * Sum the parameters of all descriptors with the given id on this weapon.
 * `ARMOR_PIERCE:2` + (somehow another) `ARMOR_PIERCE:1` = 3. Returns 0 if
 * none match.
 */
export const sumWeaponDescriptorParam = (w: Weapon, id: string): number => {
  let sum = 0;
  for (const d of w.descriptors) {
    const inst = parseIdParam(d);
    if (inst.id === id) sum += inst.param;
  }
  return sum;
};

/** Weapon with [RELOAD] descriptor — usable once per activation per unit. */
export const isReloadWeapon = (w: Weapon): boolean =>
  weaponHasDescriptor(w, 'RELOAD');
