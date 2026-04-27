import type { Vec2 } from '../core/geometry/types';
import { v2Dist } from '../core/geometry/vec2';
import { listAvailableShootModes } from '../core/resolution/shoot_modes';
import { UNIT_DISTANCE_PIXELS } from '../core/rules/constants';
import type { Command } from '../core/commands/types';
import type { Faction, GameState, Unit } from '../core/state/GameState';
import { findUnit, isUnitAlive } from '../core/state/GameState';

/** Expected hits = dice * P(roll >= threshold) on a d6. */
const expectedHits = (totalDice: number, threshold: number): number => {
  const p = Math.max(0, 7 - threshold) / 6;
  return totalDice * p;
};

/**
 * Decide the next command for an AI-controlled faction. Returns null when it's
 * not the AI's turn. The returned command is meant to be dispatched as-is via
 * the same reducer the human uses.
 *
 * Heuristic (Phase 8 v1): activate cheapest healthy unit, shoot best target,
 * else step toward nearest enemy, else rally if damaged. No reaction planning.
 *
 * `actionsTakenThisActivation` lets the caller cap AI under CHECK_SUCCESS
 * (unlimited actions) — we always end after one action under that mode.
 */
export const chooseAiCommand = (
  state: GameState,
  faction: Faction,
  actionsTakenThisActivation = 0,
): Command | null => {
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

  // Prefer healthy units, then highest-quality (lowest threshold).
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

  // Damaged → rally instead of fighting (no reactions planned).
  if (u.damage === 'SUPPRESSED' || u.damage === 'IMPEDED') {
    return { type: 'RALLY', unitId: u.id, reactionPlan: { markers: [] } };
  }

  // Best shot (highest expected hits) across all enemies and modes.
  const enemies = state.units.filter(
    (o) => o.faction !== faction && isUnitAlive(o),
  );
  let bestShot: { cmd: Command; ev: number } | null = null;
  for (const e of enemies) {
    const modes = listAvailableShootModes(state, u.id, e.id, 'ACTIVE');
    for (const m of modes) {
      const ev = expectedHits(m.totalDice, m.threshold);
      if (!bestShot || ev > bestShot.ev) {
        bestShot = {
          cmd: {
            type: 'SHOOT',
            mode: m.mode,
            shooterId: u.id,
            targetId: e.id,
            participantIds: m.participantIds,
          },
          ev,
        };
      }
    }
  }
  // Take the shot if we expect at least ~0.5 hits.
  if (bestShot && bestShot.ev >= 0.5) return bestShot.cmd;

  // Else move toward nearest enemy by ~1 unit distance.
  const nearest = nearestEnemy(state, u, faction);
  if (nearest) {
    const target = stepToward(u.position, nearest, UNIT_DISTANCE_PIXELS);
    return {
      type: 'MOVE',
      unitId: u.id,
      target,
      reactionPlan: { markers: [] },
    };
  }
  return { type: 'END_ACTIVATION' };
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

/** Step from `from` toward `target`, stopping just shy of base contact. */
const stepToward = (from: Vec2, target: Unit, distance: number): Vec2 => {
  const dx = target.position.x - from.x;
  const dy = target.position.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { x: from.x, y: from.y };
  const stopShort = target.radius + 12;
  const wanted = Math.min(distance, Math.max(0, len - stopShort));
  return {
    x: from.x + (dx / len) * wanted,
    y: from.y + (dy / len) * wanted,
  };
};
