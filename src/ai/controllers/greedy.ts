import { v2Dist } from '../../core/geometry/vec2';
import { targetHasCover } from '../../core/resolution/cover';
import {
  applyCoverToProfile,
  buildDiceProfile,
  profileExpectedHits,
} from '../../core/resolution/dice';
import { listAvailableShootModes } from '../../core/resolution/shoot_modes';
import type { Command } from '../../core/commands/types';
import type { Faction, GameState, Unit } from '../../core/state/GameState';
import { findUnit, isUnitAlive } from '../../core/state/GameState';
import type { AiController } from '../types';
import { pickProtectedStep } from '../exposure';

/**
 * Expected hits across the full dice profile, with cover removed from the
 * most-reduced die first so the EV ranking matches what `resolveShot` will
 * actually deliver. Without this, greedy overestimates shots into cover and
 * fires when it should be repositioning instead.
 */
const expectedHits = (
  totalDice: number,
  threshold: number,
  cover: boolean,
): number => {
  let profile = buildDiceProfile(totalDice, threshold, 0);
  if (cover) profile = applyCoverToProfile(profile);
  return profileExpectedHits(profile);
};

/**
 * 1-ply greedy heuristic. The default opponent and the simulator's reference
 * baseline. The decision tree:
 *  1. Activate the cheapest healthy fresh unit (SPEND if affordable, else CHECK).
 *  2. Once active: rally if hurt, else best shot if EV ≥ 0.5 (cover-aware),
 *     else step toward nearest enemy, else end activation.
 * Reactions live in `../reaction.ts` (`planReactions`) and are wired through
 * the AI registry. Lookahead is in `./lookahead.ts`. No objective-rush bias
 * yet — greedy ignores scenario goals.
 */
export const greedyController: AiController = (
  state,
  faction,
  actionsTakenThisActivation = 0,
) => {
  if (state.initiative.holder !== faction) return null;

  const act = state.initiative.activeActivation;
  if (act) {
    if (act.kind === 'CHECK_SUCCESS' && actionsTakenThisActivation >= 1) {
      return { type: 'END_ACTIVATION' };
    }
    return chooseActiveAction(state, faction);
  }

  const fresh = state.units.filter(
    (u) => u.faction === faction && isUnitAlive(u) && !u.activatedThisRound,
  );
  if (fresh.length === 0) return { type: 'PASS_INITIATIVE' };

  const sorted = [...fresh].sort((a, b) => {
    const ad = a.damage !== 'NONE' ? 1 : 0;
    const bd = b.damage !== 'NONE' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return a.quality - b.quality;
  });
  const choice = sorted[0]!;
  const cur = state.initiative.momentum[faction];
  if (cur >= choice.quality) {
    return { type: 'ACTIVATE_SPEND', unitId: choice.id };
  }
  return { type: 'ACTIVATE_CHECK', unitId: choice.id };
};

const chooseActiveAction = (
  state: GameState,
  faction: Faction,
): Command | null => {
  const act = state.initiative.activeActivation!;
  const u = findUnit(state, act.unitId);
  if (!u || !isUnitAlive(u)) return { type: 'END_ACTIVATION' };

  if (u.damage === 'SUPPRESSED' || u.damage === 'IMPEDED') {
    return { type: 'RALLY', unitId: u.id, reactionPlan: { markers: [] } };
  }

  const enemies = state.units.filter(
    (o) => o.faction !== faction && isUnitAlive(o),
  );
  let bestShot: { cmd: Command; ev: number } | null = null;
  for (const e of enemies) {
    const modes = listAvailableShootModes(state, u.id, e.id, 'ACTIVE');
    if (modes.length === 0) continue;
    const cover = targetHasCover(u, e, state.terrain);
    for (const m of modes) {
      const ev = expectedHits(m.totalDice, m.threshold, cover);
      if (!bestShot || ev > bestShot.ev) {
        bestShot = {
          cmd: {
            type: 'SHOOT',
            mode: m.mode,
            shooterId: u.id,
            targetId: e.id,
            weaponId: m.weaponId,
            participantIds: m.participantIds,
          },
          ev,
        };
      }
    }
  }
  if (bestShot && bestShot.ev >= 0.5) return bestShot.cmd;

  // Objective-aware fallback: when no good shot is available, prefer
  // pushing toward the nearest scenario objective (which is the contested
  // zone in defend / extract / engage-reach). Already-on-objective units
  // skip this branch so they don't trample their own foothold; they fall
  // through to the nearest-enemy step. AIs without scenario objectives
  // (sandbox / elimination) take the legacy nearest-enemy path directly.
  const objStep = stepTowardNearestObjective(state, u);
  if (objStep) {
    return {
      type: 'MOVE',
      unitId: u.id,
      target: objStep,
      reactionPlan: { markers: [] },
    };
  }

  const nearest = nearestEnemy(state, u, faction);
  if (nearest) {
    // Charge bias: a unit with a melee weapon and no good shot drops the
    // 12-pixel stand-off so its move can end in base contact. Auto-melee
    // (rule §4.7 — 底板接觸敵軍 → 觸發近戰) fires on contact, so we don't
    // need a separate MELEE command here. Without melee weapon, keep the
    // 12-pixel stand-off (fighting bare-handed = guaranteed loss).
    const hasMeleeWeapon = u.weapons.some((w) => w.kind === 'MELEE');
    const stopShort = hasMeleeWeapon ? 0 : nearest.radius + 12;
    const target = pickProtectedStep(state, u, nearest.position, { stopShort });
    // No-progress safety net: pickProtectedStep returns the unit's own
    // position when standing still scores best (every direction adds
    // exposure for too little progress). End the activation rather than
    // dispatch a no-op MOVE.
    if (v2Dist(target, u.position) < 1) {
      return { type: 'END_ACTIVATION' };
    }
    return {
      type: 'MOVE',
      unitId: u.id,
      target,
      reactionPlan: { markers: [] },
    };
  }
  return { type: 'END_ACTIVATION' };
};

/**
 * Step one UD toward the nearest objective the unit is not already inside.
 * Returns null when (a) no objectives exist, (b) the unit is on the nearest
 * objective already, or (c) pathfinding can't make progress toward it. The
 * caller falls through to the nearest-enemy heuristic in those cases.
 */
const stepTowardNearestObjective = (
  state: GameState,
  u: Unit,
): { x: number; y: number } | null => {
  const objs = state.objectives;
  if (!objs || objs.length === 0) return null;
  let best: { x: number; y: number; radius: number } | null = null;
  let bestDist = Infinity;
  for (const o of objs) {
    const d = v2Dist(u.position, o.position);
    if (d < bestDist) {
      bestDist = d;
      best = { x: o.position.x, y: o.position.y, radius: o.radius };
    }
  }
  if (!best) return null;
  // Already inside the marker — let the unit hold position and engage.
  if (bestDist <= best.radius) return null;
  const target = pickProtectedStep(state, u, { x: best.x, y: best.y });
  if (v2Dist(target, u.position) < 1) return null;
  return target;
};

const nearestEnemy = (
  state: GameState,
  u: Unit,
  faction: Faction,
): Unit | undefined => {
  const enemies = state.units.filter(
    (o) => o.faction !== faction && isUnitAlive(o),
  );
  if (enemies.length === 0) return undefined;
  let best: Unit | undefined;
  let bestDist = Infinity;
  for (const e of enemies) {
    const d = v2Dist(u.position, e.position);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
};

