import type { Weapon } from '../state/GameState';
import { parseIdParam } from '../util/idParam';

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
