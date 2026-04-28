import type { Vec2 } from '../../core/geometry/types';
import { listAvailableShootModes } from '../../core/resolution/shoot_modes';
import { UNIT_DISTANCE_PIXELS } from '../../core/rules/constants';
import type { Command } from '../../core/commands/types';
import type { Faction, GameState, Unit } from '../../core/state/GameState';
import { findUnit, isUnitAlive } from '../../core/state/GameState';

/**
 * Strategy hook: generate candidate commands for a unit's *active* action.
 * Each generator returns commands for a particular family (shoot, move,
 * rally, end). The lookahead controller flattens all generators' outputs and
 * scores each against the evaluator.
 *
 * To support a new command (VAULT, CLIMB, COMMAND_MOVE, etc.) you push a new
 * generator into `candidateGenerators` — no change to the search itself.
 */
export type CommandGenerator = (
  state: GameState,
  faction: Faction,
  unit: Unit,
) => Command[];

const generateShootCandidates: CommandGenerator = (state, faction, unit) => {
  const enemies = state.units.filter(
    (o) => o.faction !== faction && isUnitAlive(o),
  );
  const out: Command[] = [];
  for (const e of enemies) {
    const modes = listAvailableShootModes(state, unit.id, e.id, 'ACTIVE');
    for (const m of modes) {
      out.push({
        type: 'SHOOT',
        mode: m.mode,
        shooterId: unit.id,
        targetId: e.id,
        weaponId: m.weaponId,
        participantIds: m.participantIds,
      });
    }
  }
  return out;
};

const generateRallyCandidates: CommandGenerator = (_state, _faction, unit) => {
  if (unit.damage === 'IMPEDED' || unit.damage === 'SUPPRESSED') {
    return [{ type: 'RALLY', unitId: unit.id, reactionPlan: { markers: [] } }];
  }
  return [];
};

const generateEndActivation: CommandGenerator = () => [
  { type: 'END_ACTIVATION' },
];

const sampleMoveTargets = (unit: Unit, anchor: Vec2): Vec2[] => {
  const dx = anchor.x - unit.position.x;
  const dy = anchor.y - unit.position.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    // No anchor direction — sample 4 cardinal 1-UD steps.
    const r = UNIT_DISTANCE_PIXELS;
    return [
      { x: unit.position.x + r, y: unit.position.y },
      { x: unit.position.x - r, y: unit.position.y },
      { x: unit.position.x, y: unit.position.y + r },
      { x: unit.position.x, y: unit.position.y - r },
    ];
  }
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  // Stop short of base contact so MOVE doesn't accidentally trigger melee.
  const stopShort = unit.radius + 12;
  const towardLen = Math.max(0, Math.min(UNIT_DISTANCE_PIXELS, len - stopShort));
  const towardHalf = Math.max(0, Math.min(UNIT_DISTANCE_PIXELS / 2, len - stopShort));
  return [
    // Forward 1 UD.
    {
      x: unit.position.x + ux * towardLen,
      y: unit.position.y + uy * towardLen,
    },
    // Forward 0.5 UD.
    {
      x: unit.position.x + ux * towardHalf,
      y: unit.position.y + uy * towardHalf,
    },
    // Strafe right 1 UD.
    {
      x: unit.position.x + px * UNIT_DISTANCE_PIXELS,
      y: unit.position.y + py * UNIT_DISTANCE_PIXELS,
    },
    // Strafe left 1 UD.
    {
      x: unit.position.x - px * UNIT_DISTANCE_PIXELS,
      y: unit.position.y - py * UNIT_DISTANCE_PIXELS,
    },
  ];
};

const generateMoveCandidates: CommandGenerator = (state, faction, unit) => {
  // Aim point: nearest enemy. Even if no LOS, this picks a meaningful axis.
  const enemies = state.units.filter(
    (o) => o.faction !== faction && isUnitAlive(o),
  );
  if (enemies.length === 0) return [];
  let anchor: Vec2 = enemies[0]!.position;
  let bestSq = Infinity;
  for (const e of enemies) {
    const dx = e.position.x - unit.position.x;
    const dy = e.position.y - unit.position.y;
    const d = dx * dx + dy * dy;
    if (d < bestSq) {
      bestSq = d;
      anchor = e.position;
    }
  }
  const targets = sampleMoveTargets(unit, anchor);
  return targets.map((target) => ({
    type: 'MOVE' as const,
    unitId: unit.id,
    target,
    reactionPlan: { markers: [] },
  }));
};

/**
 * Registered active-action generators. Order is irrelevant — lookahead scores
 * everything anyway. New command types append a generator; nothing else needs
 * to know about them.
 */
export const candidateGenerators: CommandGenerator[] = [
  generateShootCandidates,
  generateRallyCandidates,
  generateMoveCandidates,
  generateEndActivation,
];

export const generateCandidates = (
  state: GameState,
  faction: Faction,
): Command[] => {
  const act = state.initiative.activeActivation;
  if (!act) return [];
  const u = findUnit(state, act.unitId);
  if (!u || !isUnitAlive(u)) return [{ type: 'END_ACTIVATION' }];
  const out: Command[] = [];
  for (const gen of candidateGenerators) {
    out.push(...gen(state, faction, u));
  }
  return out;
};
