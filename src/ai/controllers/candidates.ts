import type { Vec2 } from '../../core/geometry/types';
import { v2Dist } from '../../core/geometry/vec2';
import { listAvailableShootModes } from '../../core/resolution/shoot_modes';
import { UNIT_DISTANCE_PIXELS } from '../../core/rules/constants';
import type { Command } from '../../core/commands/types';
import type { Faction, GameState, Unit } from '../../core/state/GameState';
import { findUnit, isUnitAlive } from '../../core/state/GameState';
import { pathfindingStepToward } from '../navigation';

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

const polygonCentroid = (verts: ReadonlyArray<Vec2>): Vec2 => {
  let cx = 0;
  let cy = 0;
  for (const v of verts) {
    cx += v.x;
    cy += v.y;
  }
  return { x: cx / verts.length, y: cy / verts.length };
};

const radialMoveTargets = (unit: Unit, anchor: Vec2): Vec2[] => {
  // 8-way radial sampling around the unit. Includes "toward enemy" and
  // "away from enemy" axes plus diagonals — gives the evaluator enough
  // positional choice to pick cover/flank, without combinatorial explosion.
  const dx = anchor.x - unit.position.x;
  const dy = anchor.y - unit.position.y;
  const len = Math.hypot(dx, dy);
  const baseAng = len > 1 ? Math.atan2(dy, dx) : 0;
  const stopShort = unit.radius + 12;
  const towardLen =
    len > 1
      ? Math.max(0, Math.min(UNIT_DISTANCE_PIXELS, len - stopShort))
      : UNIT_DISTANCE_PIXELS;
  const out: Vec2[] = [];
  for (let i = 0; i < 8; i++) {
    const ang = baseAng + (i / 8) * Math.PI * 2;
    // Forward axis uses the (clipped-to-stop-short) distance; other axes
    // step a full unit-distance — the reducer clips on contact anyway.
    const dist = i === 0 ? towardLen : UNIT_DISTANCE_PIXELS;
    out.push({
      x: unit.position.x + Math.cos(ang) * dist,
      y: unit.position.y + Math.sin(ang) * dist,
    });
  }
  // Half-step toward the enemy — useful for staging behind cover that lies
  // between unit and the full 1-UD step.
  if (len > 1) {
    out.push({
      x: unit.position.x + Math.cos(baseAng) * (towardLen / 2),
      y: unit.position.y + Math.sin(baseAng) * (towardLen / 2),
    });
  }
  return out;
};

const terrainAimedTargets = (
  state: GameState,
  unit: Unit,
): Vec2[] => {
  // For each terrain piece within ~2 UD, propose its centroid as a target.
  // - HARD wall: the path stops at the wall edge, leaving the unit hugging
  //   it with potential cover in either direction. Evaluator picks the side
  //   that ends up between unit and nearest enemy.
  // - DIFFICULT: stops at the boundary; target gets cover from then on.
  // - SOFT (smoke): walks straight in; both sides get cover when shot
  //   crosses smoke.
  const REACH_SQ = (UNIT_DISTANCE_PIXELS * 2.5) ** 2;
  const out: Vec2[] = [];
  for (const t of state.terrain) {
    const c = polygonCentroid(t.polygon.vertices);
    const dx = c.x - unit.position.x;
    const dy = c.y - unit.position.y;
    if (dx * dx + dy * dy > REACH_SQ) continue;
    out.push(c);
  }
  return out;
};

const generateMoveCandidates: CommandGenerator = (state, faction, unit) => {
  const enemies = state.units.filter(
    (o) => o.faction !== faction && isUnitAlive(o),
  );
  if (enemies.length === 0) return [];
  // Anchor: nearest enemy — defines forward/backward axis for radial samples.
  let anchor: Vec2 = enemies[0]!.position;
  let bestDist = Infinity;
  for (const e of enemies) {
    const d = v2Dist(unit.position, e.position);
    if (d < bestDist) {
      bestDist = d;
      anchor = e.position;
    }
  }

  // Pathfinding-aware "next step toward enemy" — usually the strongest
  // forward-progress move on cluttered maps; pure radial samples can pick
  // walled-off targets that the reducer just clips. Including all three
  // sources lets beam search choose between progress vs cover vs flank.
  const pathStep = pathfindingStepToward(state, unit.position, anchor, {
    distance: UNIT_DISTANCE_PIXELS,
    stopShort: unit.radius + 12,
  });
  const targets: Vec2[] = [
    pathStep,
    ...radialMoveTargets(unit, anchor),
    ...terrainAimedTargets(state, unit),
  ];

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
