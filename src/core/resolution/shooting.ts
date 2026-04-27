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

export interface ResolveShotInput {
  readonly state: GameState;
  readonly shooterId: string;
  readonly targetId: string;
  readonly mode: ShootMode;
  readonly participantIds: ReadonlyArray<string>;
  readonly weaponMode: WeaponMode;
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

export const resolveShot = (input: ResolveShotInput): ResolveShotOutput => {
  const {
    state: s,
    shooterId,
    targetId,
    mode,
    participantIds,
    weaponMode,
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

  const losObstacles = s.terrain
    .filter((t) => t.kind === 'HARD')
    .map((t) => t.polygon);
  if (!hasLOS(getUnitCircle(shooter), getUnitCircle(target), losObstacles)) {
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
    if (!hasLOS(getUnitCircle(p), getUnitCircle(target), losObstacles)) {
      throw new CommandError('NO_LOS', `Participant ${pid} has no LOS`);
    }
    participants.push(p);
  }

  const allShooters: ReadonlyArray<Unit> = [shooter, ...participants];

  const shooterWeapon = findShootWeapon(shooter, mode, weaponMode);
  if (!shooterWeapon) {
    throw new CommandError(
      'NO_WEAPON',
      `${shooterId} has no ${mode}/${weaponMode} weapon`,
    );
  }
  const threshold = shooterWeapon.threshold;

  let totalDice = 0;
  for (const sh of allShooters) {
    const w = findShootWeapon(sh, mode, weaponMode);
    if (!w) {
      throw new CommandError(
        'NO_WEAPON',
        `${sh.id} lacks a ${mode}/${weaponMode} weapon`,
      );
    }
    let dice = w.diceCount;
    if (sh.damage === 'IMPEDED') dice = Math.max(0, dice - 1);
    totalDice += dice;
  }

  const cover = targetHasCover(shooter, target, s.terrain);
  // "IGNORE_COVER" weapon descriptor (e.g. 神射手) bypasses the -1.
  const ignoreCover = shooterWeapon.descriptors.includes('IGNORE_COVER');
  if (cover && !ignoreCover) totalDice = Math.max(0, totalDice - 1);

  const rng = deriveRng(s.seed, cmdIndex, `${rngLabel}:hits`);
  const rolls = rng.rollDice(totalDice, D6_SIDES);
  const hits = countHits(rolls, threshold);

  const beforeDamage = target.damage;
  const afterDamage = applyHits(beforeDamage, hits);

  let next = updateUnit(s, targetId, { damage: afterDamage });
  if (afterDamage === 'SUPPRESSED' && beforeDamage !== 'SUPPRESSED') {
    next = updateUnit(next, targetId, { damage: afterDamage, stance: 'PRONE' });
  }

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
