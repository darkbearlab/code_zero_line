import type { Circle, Polygon, Vec2 } from '../geometry/types';
import { isPointInPolygon } from '../geometry/polygon';

/** Generic faction tags. Real factions (Blue/Red/Militia) layered later. */
export type Faction = 'A' | 'B';

export type DamageState = 'NONE' | 'IMPEDED' | 'SUPPRESSED' | 'KILLED';

export type Stance = 'STANDING' | 'PRONE';

export type WeaponMode = 'ACTIVE' | 'REACTION';
export type WeaponKind = 'SHOOT' | 'MELEE';

export interface Weapon {
  readonly id: string;
  readonly modes: ReadonlyArray<WeaponMode>;
  readonly kind: WeaponKind;
  readonly diceCount: number;
  readonly threshold: number;
  /** Free-form descriptors: 'FOCUSED', 'COMBINED', 'ARMOR_PIERCE_2', 'IGNORE_COVER', etc. */
  readonly descriptors: ReadonlyArray<string>;
}

export interface Unit {
  readonly id: string;
  readonly faction: Faction;
  readonly position: Vec2;
  readonly radius: number;
  /** Quality threshold X+ (lower = better trained). */
  readonly quality: number;
  readonly damage: DamageState;
  readonly stance: Stance;
  readonly weapons: ReadonlyArray<Weapon>;
  readonly traits: ReadonlyArray<string>;
  readonly activatedThisRound: boolean;
  readonly cannotReactThisRound: boolean;
  /**
   * TOUGH (rule: 一場一次，非壓制下受致死攻擊改為壓制) burns its once-per-match
   * save when first triggered. Persisted on the unit so reload-checking is
   * a flat lookup. Untouched units omit the field; treat undefined === false.
   */
  readonly toughUsed?: boolean;
}

export type CoverKind =
  | 'HARD'
  | 'DIFFICULT'
  | 'SOFT'
  /**
   * Sealed wall — pure blocker. Like HARD high wall (always blocks LOS,
   * blocks movement) but explicitly refuses VAULT and CLIMB. Use for map
   * boundaries / unscalable obstacles where the designer doesn't want
   * units cheesing height to bypass.
   */
  | 'BLOCKER'
  /**
   * Elevated platform you can stand on top of. Movement-wise the polygon
   * edge blocks entry from outside (must CLIMB up); once a unit's centre
   * is inside the polygon it's "on top" and walks freely. Walking off
   * the edge is allowed (drops down). LOS + cover have asymmetric rules:
   *  - shooter on high ground: their LOS ignores low walls; their target
   *    doesn't get low-wall cover.
   *  - target on high ground + shooter not on same: target gets cover.
   */
  | 'HIGH_GROUND';

export interface Terrain {
  readonly id: string;
  readonly kind: CoverKind;
  readonly polygon: Polygon;
  /**
   * Pixel height, used only for HARD terrain.
   * <= UNIT_DISTANCE_PIXELS → low wall (vault-able, blocks LOS only to prone).
   * >  UNIT_DISTANCE_PIXELS → high wall (climb-able, blocks LOS always).
   * Optional for non-HARD kinds.
   */
  readonly height?: number;
  /** Human label for debug/UI ("矮牆" / "高牆" / "瓦礫" / "煙幕" etc.). */
  readonly displayName?: string;
}

export type ActivationKind = 'SPEND' | 'CHECK_SUCCESS' | 'OVERDRAFT';

export interface ActiveActivation {
  readonly unitId: string;
  readonly kind: ActivationKind;
  /** -1 = unlimited (CHECK_SUCCESS); positive integer = remaining actions. */
  readonly actionsRemaining: number;
  /** Action failure does NOT cause turnover when true (SPEND only). */
  readonly failureProtection: boolean;
  /** Turnover triggers automatically when this activation ends (OVERDRAFT, forced-pay rescue). */
  readonly forcedTurnoverAfterAction: boolean;
  /** Momentum deficit granted to opponent at turnover (OVERDRAFT only). */
  readonly overdraftDeficit?: number;
  /**
   * Per-unit weapon usage tracking for [RELOAD] enforcement (rule 7 — 填裝).
   * `weaponUsage[unitId]` lists weapon ids fired by that unit during this
   * activation. RELOAD weapons that already appear here cannot fire again.
   */
  readonly weaponUsage?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface Initiative {
  readonly holder: Faction;
  readonly momentum: Readonly<Record<Faction, number>>;
  readonly round: number;
  readonly activeActivation: ActiveActivation | null;
}

export interface Objective {
  readonly id: string;
  readonly position: Vec2;
  readonly radius: number;
  readonly displayName?: string;
}

/**
 * Combat-intel meta levels — placed on GameState rather than on every
 * SHOOT/MELEE command so the resolver can apply them transparently.
 * Optional / undefined = legacy single-group profile (level 0 across
 * all tags). The roguelite layer pumps this in at state-build time.
 *
 * Defined as a plain string-keyed record here to avoid cross-package
 * type imports; the structural shape matches `CombatIntelLevels` in
 * `core/resolution/combat_intel.ts`.
 */
export interface GameStateCombatIntel {
  readonly shoot: Readonly<Record<string, number>>;
  readonly melee: Readonly<Record<string, number>>;
}

/**
 * Scenario context piggybacked on GameState so the AI evaluator can apply
 * scenario-aware modifiers (time pressure, attacker urgency) without taking
 * an extra plumbed-through parameter on every decision call. Plain
 * string-keyed shape to avoid cross-package imports; matches `ScenarioMode`
 * and `ScenarioParams` from `core/scenario/victory.ts` structurally.
 */
export interface GameStateScenarioInfo {
  readonly mode: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface GameState {
  /** Master seed; combined with `commandCount` to derive per-command RNG. */
  readonly seed: string;
  readonly commandCount: number;
  readonly units: ReadonlyArray<Unit>;
  readonly terrain: ReadonlyArray<Terrain>;
  /** Scenario control points carried over from MapDef.objectives. Optional. */
  readonly objectives?: ReadonlyArray<Objective>;
  /** Combat-intel meta levels for the active player (faction A in run mode). */
  readonly combatIntel?: GameStateCombatIntel;
  /** Scenario type + tunables used by the AI evaluator. Optional. */
  readonly scenarioInfo?: GameStateScenarioInfo;
  readonly initiative: Initiative;
}

export const getUnitCircle = (u: Unit): Circle => ({
  center: u.position,
  radius: u.radius,
});

export const isUnitAlive = (u: Unit): boolean => u.damage !== 'KILLED';

export const findUnit = (s: GameState, id: string): Unit | undefined =>
  s.units.find((u) => u.id === id);

export const updateUnit = (
  s: GameState,
  id: string,
  patch: Partial<Unit>,
): GameState => ({
  ...s,
  units: s.units.map((u) => (u.id === id ? { ...u, ...patch } : u)),
});

/**
 * A HARD terrain whose height is ≤ 1 unit-distance is considered a low wall:
 * vault-able and blocks LOS *only* against prone targets (rule 4.5 — prone
 * model "視為僅剩底板高度").
 */
export const isLowWall = (
  t: Terrain,
  vaultThresholdPx: number,
): boolean =>
  t.kind === 'HARD' && (t.height ?? Number.POSITIVE_INFINITY) <= vaultThresholdPx;

/**
 * A HARD terrain whose height is > 1 unit-distance is a high wall: climb-able
 * and blocks LOS unconditionally.
 */
export const isHighWall = (
  t: Terrain,
  vaultThresholdPx: number,
): boolean =>
  t.kind === 'HARD' && (t.height ?? Number.POSITIVE_INFINITY) > vaultThresholdPx;

/** Pure blocker — refuses both VAULT and CLIMB. */
export const isBlocker = (t: Terrain): boolean => t.kind === 'BLOCKER';

/** Elevated platform — climb in, free movement on top, asymmetric LOS/cover. */
export const isHighGround = (t: Terrain): boolean => t.kind === 'HIGH_GROUND';

/**
 * True iff `unit`'s centre sits inside any HIGH_GROUND polygon. Used by the
 * resolver + AI eval to flip cover / LOS rules per the high-ground spec.
 */
export const isOnHighGround = (
  unit: Unit,
  terrains: ReadonlyArray<Terrain>,
): boolean => {
  for (const t of terrains) {
    if (t.kind !== 'HIGH_GROUND') continue;
    if (isPointInPolygon(unit.position, t.polygon)) return true;
  }
  return false;
};

/**
 * True iff `unit` is inside the *same* HIGH_GROUND polygon as `other`.
 * Used to decide whether two units are on the same elevation (which neuters
 * the cover bonus + LOS-ignore-low-walls advantage).
 */
export const sharesHighGround = (
  a: Unit,
  b: Unit,
  terrains: ReadonlyArray<Terrain>,
): boolean => {
  for (const t of terrains) {
    if (t.kind !== 'HIGH_GROUND') continue;
    if (
      isPointInPolygon(a.position, t.polygon) &&
      isPointInPolygon(b.position, t.polygon)
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Polygons that act as hard movement obstacles for a mover starting at
 * `fromPosition`. HARD + BLOCKER are unconditional; HIGH_GROUND only
 * blocks when the mover starts OUTSIDE the platform (a unit on top is
 * free to walk anywhere on top, and is allowed to step off the edge).
 */
export const movementBlockingPolygons = (
  terrains: ReadonlyArray<Terrain>,
  fromPosition: Vec2,
): Polygon[] => {
  const out: Polygon[] = [];
  for (const t of terrains) {
    if (t.kind === 'HARD' || t.kind === 'BLOCKER') {
      out.push(t.polygon);
    } else if (t.kind === 'HIGH_GROUND') {
      if (!isPointInPolygon(fromPosition, t.polygon)) {
        out.push(t.polygon);
      }
    }
  }
  return out;
};

/**
 * Polygons whose edges stop the move when crossed FROM outside IN. Applies
 * uniformly: every terrain transition is a discrete move action — you stop
 * at the edge and must spend a separate move perpendicular to cross over.
 *
 * HARD / BLOCKER / HIGH_GROUND are absent from this list because they're
 * sweep-blocked entirely (you bump into them before reaching the edge),
 * with VAULT / CLIMB as the dedicated traversal actions. DIFFICULT (rubble)
 * + SOFT (smoke) are walk-through-able terrains that still cost a move
 * action per edge crossing.
 */
export const movementEnterStopPolygons = (
  terrains: ReadonlyArray<Terrain>,
): Polygon[] => {
  const out: Polygon[] = [];
  for (const t of terrains) {
    if (t.kind === 'DIFFICULT' || t.kind === 'SOFT') {
      out.push(t.polygon);
    }
  }
  return out;
};

/**
 * Polygons whose edges stop the move when crossed going OUT, given a mover
 * starting at `fromPosition`. Symmetric to movementEnterStopPolygons —
 * leaving costs a move action just like entering.
 *
 * HIGH_GROUND (mover is on top), DIFFICULT (mover inside rubble), and SOFT
 * (mover inside smoke) all qualify. The check is "was the start inside?"
 * — internal movement that doesn't leave the polygon is unblocked.
 */
export const movementExitStopPolygons = (
  terrains: ReadonlyArray<Terrain>,
  fromPosition: Vec2,
): Polygon[] => {
  const out: Polygon[] = [];
  for (const t of terrains) {
    if (
      t.kind !== 'HIGH_GROUND' &&
      t.kind !== 'DIFFICULT' &&
      t.kind !== 'SOFT'
    ) {
      continue;
    }
    if (isPointInPolygon(fromPosition, t.polygon)) {
      out.push(t.polygon);
    }
  }
  return out;
};
