import { hasLOS } from '../geometry/los';
import { D6_SIDES } from '../rules/constants';
import { countHits, deriveRng } from '../rng/sfc32';
import {
  findUnit,
  getUnitCircle,
  isUnitAlive,
  updateUnit,
} from '../state/GameState';
import type {
  DamageState,
  GameState,
  Unit,
  Weapon,
  WeaponMode,
} from '../state/GameState';
import type { GameEvent, ShootMode } from '../commands/types';
import { CommandError } from '../commands/types';
import { applyHits } from './damage';
import { targetHasCover } from './cover';
import { sumTraitParams, unitHasTrait } from '../traits/types';
import {
  isReloadWeapon,
  sumWeaponDescriptorParam,
  weaponHasDescriptor,
} from './weapon_descriptors';

export interface ResolveShotInput {
  readonly state: GameState;
  readonly shooterId: string;
  readonly targetId: string;
  readonly mode: ShootMode;
  readonly participantIds: ReadonlyArray<string>;
  readonly weaponMode: WeaponMode;
  /** Specific weapon id used by the shooter; required if multiple match. */
  readonly weaponId?: string;
  /** Label suffix for deterministic RNG (e.g., 'shoot' or 'reaction:m0'). */
  readonly rngLabel: string;
  readonly cmdIndex: number;
}

export interface ResolveShotOutput {
  readonly state: GameState;
  readonly events: ReadonlyArray<GameEvent>;
  readonly hits: number;
  readonly beforeDamage: DamageState;
  readonly afterDamage: DamageState;
  readonly causedSuppressOrKill: boolean;
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
 * Pick the shooter weapon to fire. Honors explicit `weaponId` if provided;
 * otherwise back-compat: if exactly one weapon matches, use it; if more
 * than one matches, throw `MULTIPLE_WEAPONS` to force the caller to pick.
 */
const pickShooterWeapon = (
  state: GameState,
  unit: Unit,
  mode: ShootMode,
  weaponMode: WeaponMode,
  weaponId: string | undefined,
): Weapon => {
  const all = candidateShootWeapons(unit, mode, weaponMode).filter(
    (w) => !reloadAlreadyUsed(state, unit.id, w),
  );
  if (weaponId) {
    const w = all.find((x) => x.id === weaponId);
    if (!w) {
      throw new CommandError(
        'INVALID_WEAPON',
        `${unit.id} has no ${mode}/${weaponMode} weapon '${weaponId}' available`,
      );
    }
    return w;
  }
  if (all.length === 0) {
    throw new CommandError(
      'NO_WEAPON',
      `${unit.id} has no ${mode}/${weaponMode} weapon available`,
    );
  }
  if (all.length > 1) {
    throw new CommandError(
      'MULTIPLE_WEAPONS',
      `${unit.id} has multiple ${mode}/${weaponMode} weapons; specify weaponId`,
    );
  }
  return all[0]!;
};

export const resolveShot = (input: ResolveShotInput): ResolveShotOutput => {
  const {
    state: s,
    shooterId,
    targetId,
    mode,
    participantIds,
    weaponMode,
    weaponId,
    rngLabel,
    cmdIndex,
  } = input;

  const shooter = findUnit(s, shooterId);
  if (!shooter) throw new CommandError('UNIT_NOT_FOUND', `Shooter ${shooterId}`);
  if (!isUnitAlive(shooter)) {
    throw new CommandError('UNIT_DEAD', `Shooter ${shooterId} is dead`);
  }
  if (shooter.damage === 'SUPPRESSED') {
    throw new CommandError('SUPPRESSED', `${shooterId} cannot act while suppressed`);
  }

  const target = findUnit(s, targetId);
  if (!target) throw new CommandError('UNIT_NOT_FOUND', `Target ${targetId}`);
  if (!isUnitAlive(target)) throw new CommandError('UNIT_DEAD', `Target dead`);
  if (shooter.faction === target.faction) {
    throw new CommandError('FRIENDLY_FIRE', `Same-faction target`);
  }

  if (mode === 'COMBINED' && !shooter.traits.includes('OFFICER')) {
    throw new CommandError('NOT_OFFICER', 'Combined fire requires an officer');
  }

  const losTerrain = s.terrain;
  const stanceOpts = (a: Unit, b: Unit) => ({
    aProne: a.stance === 'PRONE',
    bProne: b.stance === 'PRONE',
  });
  if (
    !hasLOS(
      getUnitCircle(shooter),
      getUnitCircle(target),
      losTerrain,
      stanceOpts(shooter, target),
    )
  ) {
    throw new CommandError('NO_LOS', `${shooterId} has no LOS to ${targetId}`);
  }

  const participants: Unit[] = [];
  for (const pid of participantIds) {
    if (pid === shooterId) continue;
    const p = findUnit(s, pid);
    if (!p) throw new CommandError('UNIT_NOT_FOUND', `Participant ${pid}`);
    if (!isUnitAlive(p)) throw new CommandError('UNIT_DEAD', `Participant ${pid} dead`);
    if (p.damage === 'SUPPRESSED') {
      throw new CommandError('SUPPRESSED', `Participant ${pid} suppressed`);
    }
    if (p.faction !== shooter.faction) {
      throw new CommandError('FRIENDLY_FIRE', `${pid} on different faction`);
    }
    if (
      !hasLOS(
        getUnitCircle(p),
        getUnitCircle(target),
        losTerrain,
        stanceOpts(p, target),
      )
    ) {
      throw new CommandError('NO_LOS', `Participant ${pid} has no LOS`);
    }
    participants.push(p);
  }

  // Shooter's chosen weapon — explicit weaponId required when ambiguous.
  const shooterWeapon = pickShooterWeapon(
    s,
    shooter,
    mode,
    weaponMode,
    weaponId,
  );
  const threshold = shooterWeapon.threshold;

  // Track which (unit, weapon) pairs fired this shot (for RELOAD bookkeeping).
  const usedWeapons: Array<[string, string]> = [
    [shooter.id, shooterWeapon.id],
  ];

  let totalDice = 0;
  totalDice += shooter.damage === 'IMPEDED'
    ? Math.max(0, shooterWeapon.diceCount - 1)
    : shooterWeapon.diceCount;

  // Each participant uses their own first matching (mode/weaponMode) weapon
  // that isn't already RELOAD-used. Future expansion: let UI pick per-ally.
  for (const p of participants) {
    const partWeapon = candidateShootWeapons(p, mode, weaponMode).find(
      (w) => !reloadAlreadyUsed(s, p.id, w),
    );
    if (!partWeapon) {
      throw new CommandError(
        'NO_WEAPON',
        `${p.id} lacks a ${mode}/${weaponMode} weapon`,
      );
    }
    let dice = partWeapon.diceCount;
    if (p.damage === 'IMPEDED') dice = Math.max(0, dice - 1);
    totalDice += dice;
    usedWeapons.push([p.id, partWeapon.id]);
  }

  const cover = targetHasCover(shooter, target, s.terrain);
  // IGNORE_COVER (神射手) bypasses the -1.
  const ignoreCover = weaponHasDescriptor(shooterWeapon, 'IGNORE_COVER');
  if (cover && !ignoreCover) totalDice = Math.max(0, totalDice - 1);

  const rng = deriveRng(s.seed, cmdIndex, `${rngLabel}:hits`);
  const rolls = rng.rollDice(totalDice, D6_SIDES);
  const rawHits = countHits(rolls, threshold);

  // ARMOR(N) absorbs hits; ARMOR_PIERCE(M) on the shooter's weapon reduces
  // effective armor (rule 7 — RPG/穿甲).
  const targetArmor = sumTraitParams(target, 'ARMOR');
  const piercing = sumWeaponDescriptorParam(shooterWeapon, 'ARMOR_PIERCE');
  const effectiveArmor = Math.max(0, targetArmor - piercing);
  const hits = Math.max(0, rawHits - effectiveArmor);

  const beforeDamage = target.damage;
  let afterDamage = applyHits(beforeDamage, hits);
  // FRAGILE: a result of IMPEDED is upgraded to SUPPRESSED.
  if (unitHasTrait(target, 'FRAGILE') && afterDamage === 'IMPEDED') {
    afterDamage = 'SUPPRESSED';
  }

  let next = updateUnit(s, targetId, { damage: afterDamage });
  if (afterDamage === 'SUPPRESSED' && beforeDamage !== 'SUPPRESSED') {
    next = updateUnit(next, targetId, { damage: afterDamage, stance: 'PRONE' });
  }

  // Record RELOAD weapon usage on the activation. We intentionally update
  // even if the activation will end on this action — it's read by future
  // shot resolutions within the same activation (multi-shot CHECK_SUCCESS).
  next = recordWeaponUsage(next, usedWeapons);

  const causedSuppressOrKill =
    (afterDamage === 'SUPPRESSED' || afterDamage === 'KILLED') &&
    afterDamage !== beforeDamage;

  const events: GameEvent[] = [
    {
      type: 'SHOT_RESOLVED',
      shooterId,
      targetId,
      mode,
      participantIds: [...participantIds],
      weaponMode,
      diceCount: totalDice,
      rolls,
      threshold,
      hits,
      coverApplied: cover && !ignoreCover,
      beforeDamage,
      afterDamage,
    },
  ];

  return {
    state: next,
    events,
    hits,
    beforeDamage,
    afterDamage,
    causedSuppressOrKill,
  };
};

/** Append (unitId, weaponId) entries to the active activation's weaponUsage. */
const recordWeaponUsage = (
  s: GameState,
  pairs: ReadonlyArray<[string, string]>,
): GameState => {
  const act = s.initiative.activeActivation;
  if (!act) return s;
  const usage = { ...(act.weaponUsage ?? {}) };
  for (const [unitId, weaponId] of pairs) {
    const list = usage[unitId] ?? [];
    if (!list.includes(weaponId)) {
      usage[unitId] = [...list, weaponId];
    }
  }
  return {
    ...s,
    initiative: {
      ...s.initiative,
      activeActivation: { ...act, weaponUsage: usage },
    },
  };
};
