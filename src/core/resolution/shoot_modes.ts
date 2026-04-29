import { hasLOS } from '../geometry/los';
import { v2Dist } from '../geometry/vec2';
import { UNIT_DISTANCE_PIXELS } from '../rules/constants';
import type {
  GameState,
  Unit,
  Weapon,
  WeaponMode,
} from '../state/GameState';
import { findUnit, getUnitCircle, isUnitAlive } from '../state/GameState';
import { unitHasTrait } from '../traits/types';
import type { ShootMode } from '../commands/types';
import {
  isReloadWeapon,
  weaponHasDescriptor,
} from './weapon_descriptors';

export interface AvailableShootMode {
  readonly mode: ShootMode;
  /** The shooter's chosen weapon for this option. */
  readonly weaponId: string;
  /** Display label for the weapon (currently same as id). */
  readonly weaponDisplay: string;
  readonly participantIds: ReadonlyArray<string>;
  readonly totalDice: number;
  readonly threshold: number;
}

const candidateShootWeapons = (
  u: Unit,
  mode: ShootMode,
  weaponMode: WeaponMode,
): Weapon[] => {
  return u.weapons.filter((w) => {
    if (w.kind !== 'SHOOT') return false;
    if (!w.modes.includes(weaponMode)) return false;
    if (mode === 'SOLO') return true;
    if (mode === 'FOCUSED') return weaponHasDescriptor(w, 'FOCUSED');
    return weaponHasDescriptor(w, 'COMBINED');
  });
};

/** First matching shoot weapon (used for participants' implicit weapon pick). */
const firstShootWeapon = (
  u: Unit,
  mode: ShootMode,
  weaponMode: WeaponMode,
): Weapon | undefined => candidateShootWeapons(u, mode, weaponMode)[0];

const adjustDice = (u: Unit, base: number): number =>
  u.damage === 'IMPEDED' ? Math.max(0, base - 1) : base;

/**
 * Whether a COMBINED-fire participant needs LOS to the officer (rule 4.3
 * "對軍官及目標皆有視線"). Default: yes. Hook for future traits that bypass
 * this — e.g. a comms-relay specialist.
 */
const participantNeedsLosToOfficer = (u: Unit): boolean =>
  !unitHasTrait(u, 'NO_OFFICER_LOS_FOR_COMBINED');

/** True if the unit-weapon pair already fired this activation under [RELOAD]. */
const reloadAlreadyUsed = (
  state: GameState,
  unitId: string,
  weapon: Weapon,
): boolean => {
  if (!isReloadWeapon(weapon)) return false;
  const usage = state.initiative.activeActivation?.weaponUsage;
  return !!usage && (usage[unitId]?.includes(weapon.id) ?? false);
};

/**
 * Enumerate the SHOOT modes available to `shooter` against `target`,
 * returning one entry **per weapon × mode combo**. The UI surfaces these
 * as separate buttons so the player explicitly picks weapon + mode.
 *
 * Used both for the active-turn SHOOT UI (weaponMode='ACTIVE') and for
 * building reaction-fire markers (weaponMode='REACTION').
 *
 * Returns empty array if the shooter cannot shoot the target at all.
 */
export const listAvailableShootModes = (
  state: GameState,
  shooterId: string,
  targetId: string,
  weaponMode: WeaponMode,
  excludedUnitIds?: ReadonlySet<string>,
): AvailableShootMode[] => {
  const exclude = excludedUnitIds ?? new Set<string>();
  if (exclude.has(shooterId)) return [];

  const shooter = findUnit(state, shooterId);
  const target = findUnit(state, targetId);
  if (!shooter || !target) return [];
  if (!isUnitAlive(shooter) || !isUnitAlive(target)) return [];
  if (shooter.faction === target.faction) return [];
  if (shooter.damage === 'SUPPRESSED') return [];
  if (weaponMode === 'REACTION' && shooter.cannotReactThisRound) return [];

  const losTo = (from: Unit, to: Unit): boolean =>
    hasLOS(getUnitCircle(from), getUnitCircle(to), state.terrain, {
      aProne: from.stance === 'PRONE',
      bProne: to.stance === 'PRONE',
    });
  if (!losTo(shooter, target)) {
    return [];
  }

  const out: AvailableShootMode[] = [];

  // SOLO — one entry per matching shooter weapon.
  for (const sw of candidateShootWeapons(shooter, 'SOLO', weaponMode)) {
    if (reloadAlreadyUsed(state, shooter.id, sw)) continue;
    out.push({
      mode: 'SOLO',
      weaponId: sw.id,
      weaponDisplay: sw.id,
      participantIds: [],
      totalDice: adjustDice(shooter, sw.diceCount),
      threshold: sw.threshold,
    });
  }

  // FOCUSED — one entry per FOCUSED-tagged weapon the shooter can fire.
  for (const fw of candidateShootWeapons(shooter, 'FOCUSED', weaponMode)) {
    if (reloadAlreadyUsed(state, shooter.id, fw)) continue;
    const parts = state.units.filter(
      (u) =>
        u.id !== shooter.id &&
        !exclude.has(u.id) &&
        u.faction === shooter.faction &&
        isUnitAlive(u) &&
        u.damage !== 'SUPPRESSED' &&
        (weaponMode === 'ACTIVE' || !u.cannotReactThisRound) &&
        v2Dist(u.position, shooter.position) <= UNIT_DISTANCE_PIXELS &&
        losTo(u, target) &&
        firstShootWeapon(u, 'FOCUSED', weaponMode),
    );
    if (parts.length === 0) continue;
    let dice = adjustDice(shooter, fw.diceCount);
    for (const p of parts) {
      const w = firstShootWeapon(p, 'FOCUSED', weaponMode)!;
      dice += adjustDice(p, w.diceCount);
    }
    out.push({
      mode: 'FOCUSED',
      weaponId: fw.id,
      weaponDisplay: fw.id,
      participantIds: parts.map((u) => u.id),
      totalDice: dice,
      threshold: fw.threshold,
    });
  }

  // COMBINED — officer-led; one entry per COMBINED weapon.
  if (unitHasTrait(shooter, 'OFFICER')) {
    for (const cw of candidateShootWeapons(shooter, 'COMBINED', weaponMode)) {
      if (reloadAlreadyUsed(state, shooter.id, cw)) continue;
      const parts = state.units.filter(
        (u) =>
          u.id !== shooter.id &&
          !exclude.has(u.id) &&
          u.faction === shooter.faction &&
          isUnitAlive(u) &&
          u.damage !== 'SUPPRESSED' &&
          (weaponMode === 'ACTIVE' || !u.cannotReactThisRound) &&
          (participantNeedsLosToOfficer(u) ? losTo(u, shooter) : true) &&
          losTo(u, target) &&
          firstShootWeapon(u, 'COMBINED', weaponMode),
      );
      if (parts.length === 0) continue;
      let dice = adjustDice(shooter, cw.diceCount);
      for (const p of parts) {
        const w = firstShootWeapon(p, 'COMBINED', weaponMode)!;
        dice += adjustDice(p, w.diceCount);
      }
      out.push({
        mode: 'COMBINED',
        weaponId: cw.id,
        weaponDisplay: cw.id,
        participantIds: parts.map((u) => u.id),
        totalDice: dice,
        threshold: cw.threshold,
      });
    }
  }

  return out;
};
