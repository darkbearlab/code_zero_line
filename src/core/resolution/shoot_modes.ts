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
import type { ShootMode } from '../commands/types';

export interface AvailableShootMode {
  readonly mode: ShootMode;
  readonly participantIds: ReadonlyArray<string>;
  readonly totalDice: number;
  readonly threshold: number;
}

const findShootWeapon = (
  u: Unit,
  mode: ShootMode,
  weaponMode: WeaponMode,
): Weapon | undefined => {
  return u.weapons.find((w) => {
    if (w.kind !== 'SHOOT') return false;
    if (!w.modes.includes(weaponMode)) return false;
    if (mode === 'SOLO') return true;
    if (mode === 'FOCUSED') return w.descriptors.includes('FOCUSED');
    return w.descriptors.includes('COMBINED');
  });
};

const adjustDice = (u: Unit, base: number): number =>
  u.damage === 'IMPEDED' ? Math.max(0, base - 1) : base;

/**
 * Whether a COMBINED-fire participant needs LOS to the officer (rule 4.3
 * "對軍官及目標皆有視線"). Default: yes. Hook for future traits that bypass
 * this — e.g. a comms-relay specialist.
 */
const participantNeedsLosToOfficer = (u: Unit): boolean =>
  !u.traits.includes('NO_OFFICER_LOS_FOR_COMBINED');

/**
 * Enumerate the SHOOT modes available to `shooter` against `target`.
 * Returns one entry per viable mode with auto-selected participants.
 *
 * Used both for the active-turn SHOOT UI (weaponMode='ACTIVE') and for
 * building reaction-fire markers (weaponMode='REACTION').
 *
 * Returns empty array if shooter cannot shoot the target at all (no LOS,
 * suppressed shooter, friendly fire, etc.).
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
  // For REACTION fires, the shooter must not have already failed a reaction.
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

  // SOLO
  const sw = findShootWeapon(shooter, 'SOLO', weaponMode);
  if (sw) {
    out.push({
      mode: 'SOLO',
      participantIds: [],
      totalDice: adjustDice(shooter, sw.diceCount),
      threshold: sw.threshold,
    });
  }

  // FOCUSED — friendlies within 1 unit distance with FOCUSED weapon and LOS
  const fw = findShootWeapon(shooter, 'FOCUSED', weaponMode);
  if (fw) {
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
        findShootWeapon(u, 'FOCUSED', weaponMode),
    );
    if (parts.length > 0) {
      let dice = adjustDice(shooter, fw.diceCount);
      for (const p of parts) {
        const w = findShootWeapon(p, 'FOCUSED', weaponMode)!;
        dice += adjustDice(p, w.diceCount);
      }
      out.push({
        mode: 'FOCUSED',
        participantIds: parts.map((u) => u.id),
        totalDice: dice,
        threshold: fw.threshold,
      });
    }
  }

  // COMBINED — officer-led, friendlies with LOS to officer AND target.
  // The "LOS to officer" requirement may be bypassed by future skills
  // (e.g., dedicated comms operator) — gated through participantNeedsLosToOfficer.
  if (shooter.traits.includes('OFFICER')) {
    const cw = findShootWeapon(shooter, 'COMBINED', weaponMode);
    if (cw) {
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
          findShootWeapon(u, 'COMBINED', weaponMode),
      );
      if (parts.length > 0) {
        let dice = adjustDice(shooter, cw.diceCount);
        for (const p of parts) {
          const w = findShootWeapon(p, 'COMBINED', weaponMode)!;
          dice += adjustDice(p, w.diceCount);
        }
        out.push({
          mode: 'COMBINED',
          participantIds: parts.map((u) => u.id),
          totalDice: dice,
          threshold: cw.threshold,
        });
      }
    }
  }

  return out;
};
