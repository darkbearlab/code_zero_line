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
  /**
   * Template the unit was instantiated from (e.g. 'squad_lead', 'trooper').
   * Renderer uses it to resolve `spriteKey` from the template registry.
   * Optional for back-compat with legacy hand-built fixtures (test units
   * omit it; renderer falls back to procedural drawing).
   */
  readonly templateId?: string;
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
   * Per-initiative lockout. Set when an action ends the unit's activation
   * via FORCED_END (CRAWL / CLIMB / MOVE-from-DIFFICULT — rule 4.5 / 4.2C
   * "該輪次不可再行動"). Blocks ALL re-activation paths for the rest of the
   * active side's initiative phase: primary activation (ACTIVATE_PAY /
   * CHECK / OVERDRAFT) AND FOCUSED / COMBINED / COMMAND_MOVE / COMMAND_RALLY
   * participation (a locked unit can be neither activator nor command-tag-
   * along). Cleared on every INITIATIVE_TURNOVER so once the opposing side
   * takes over, the unit may react-fire again (including via FOCUSED /
   * COMBINED reactions). Untouched units omit the field; treat undefined
   * === false.
   */
  readonly lockedThisInitiative?: boolean;
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
  | 'HIGH_GROUND'
  /**
   * 不可互動區域 — out-of-bounds boundary marker. Refuses every form of
   * traversal (no MOVE / VAULT / CLIMB / TRAVERSE in or out) and blocks
   * LOS unconditionally. Used to define the playable area edge.
   */
  | 'OUT_OF_BOUNDS'
  /**
   * 不可進入區 — atrium / void space. Can never be entered (movement and
   * vault/climb refuse it like OUT_OF_BOUNDS) but LOS passes through
   * freely as if the polygon weren't there. Use for inaccessible
   * architectural voids that don't visually obstruct.
   */
  | 'NO_ENTRY';

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
  /**
   * Initiative cycle counter. Increments on every full A→B→A handoff —
   * one "cycle" = both sides have had a chance to take initiative.
   * Game terminology: 主動權. Game-mode time limits (defend / extract /
   * assassinate) measure their clock in cycles. The previous name
   * `round` was abandoned because it overloaded with the campaign-layer
   * 戰役回合 concept.
   */
  readonly cycle: number;
  /**
   * Cumulative activation count for the player faction (A). Increments on
   * every ACTIVATE_SPEND / ACTIVATE_CHECK / ACTIVATE_OVERDRAFT issued by A
   * (COMMAND_MOVE/RALLY ride on top of SPEND, so 1 SPEND = 1 activation
   * regardless of action shape). Drives mission deadlines (defendActivations
   * / extractActivations / assassinateActivations) — see scenario/victory.ts.
   * AI-vs-AI sim treats faction A as "player side" for budget purposes.
   */
  readonly playerActivations: number;
  readonly activeActivation: ActiveActivation | null;
  /**
   * Cumulative score per faction for the `control-points` scenario. Updated
   * once per cycle bump (full A→B→A handoff) by the reducer's turnover().
   * Optional so legacy fixtures / replays without scoring still load cleanly.
   */
  readonly objectiveScores?: Readonly<Record<Faction, number>>;
  /**
   * Stateful per-objective owner for `control-points`. `null` = neutral.
   * Once a faction captures, ownership persists across cycles until the
   * opponent (a) physically clears the owner from the zone and (b) is
   * uniquely present at the next cycle end. Optional for back-compat.
   */
  readonly objectiveControl?: Readonly<Record<string, Faction | null>>;
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

/**
 * Point of interest dropped by a player non-MOVE action while stealth is
 * active. Enemy patrol picks the nearest POI as its move target.
 * `expiresAtCycle` is the first cycle index at which the POI should be
 * culled (turnover() compares against `state.cycleIndex`).
 */
export interface PoiMark {
  readonly position: Vec2;
  readonly createdCycle: number;
  readonly cause:
    | 'SHOOT'
    | 'VAULT'
    | 'CLIMB'
    | 'CRAWL'
    | 'RALLY'
    | 'COMMAND';
  readonly expiresAtCycle: number;
}

/**
 * Mission-level stealth state. Present only when the mission was launched
 * with stealth (operation chain inheritance or per-mission `stealthMode:
 * 'force-on'`). When `active === true` enemies have a 1UD effective sight
 * cap, react-fire is disabled, and patrol behavior fires at IMPULSIVE
 * trigger windows. Once broken (`active === false`) the field stays on
 * the state but observers treat it as "stealth was a thing once" — the
 * chain-side `RunState.operationStealthAlive` is what actually propagates.
 */
export interface StealthState {
  readonly active: boolean;
  /**
   * Set when a stealth-break trigger fires while every enemy unit is
   * KILLED or SUPPRESSED — the actual break is deferred to the next
   * INITIATIVE_TURNOVER. Cleared when broken or when no longer relevant.
   */
  readonly pendingBreakReason?: 'SHOT' | 'SPOTTED';
  readonly pois: ReadonlyArray<PoiMark>;
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
  /**
   * Stealth-mission state. Absent for normal missions; populated when the
   * mission is launched with stealth (see `buildMissionState`). Reducer
   * mutates `pois` and `pendingBreakReason` over the course of the match.
   */
  readonly stealth?: StealthState;
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

/** 不可互動區域 — refuses every traversal and blocks LOS. */
export const isOutOfBounds = (t: Terrain): boolean => t.kind === 'OUT_OF_BOUNDS';

/** 不可進入區 — refuses entry but LOS passes through. */
export const isNoEntry = (t: Terrain): boolean => t.kind === 'NO_ENTRY';

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
 * `fromPosition`. HARD + BLOCKER + OUT_OF_BOUNDS + NO_ENTRY are
 * unconditional; HIGH_GROUND only blocks when the mover starts OUTSIDE
 * the platform (a unit on top is free to walk anywhere on top, and is
 * allowed to step off the edge).
 */
export const movementBlockingPolygons = (
  terrains: ReadonlyArray<Terrain>,
  fromPosition: Vec2,
): Polygon[] => {
  const out: Polygon[] = [];
  for (const t of terrains) {
    if (
      t.kind === 'HARD' ||
      t.kind === 'BLOCKER' ||
      t.kind === 'OUT_OF_BOUNDS' ||
      t.kind === 'NO_ENTRY'
    ) {
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
 * Polygons whose edges stop the move when the mover's BASE touches them
 * going OUT (start inside, leaving). DIFFICULT (rubble), SOFT (smoke), and
 * HIGH_GROUND — leaving any of them costs a dedicated edge-crossing
 * action (TRAVERSE for soft terrains, CLIMB for high ground). A regular
 * MOVE outward stops with the base flush against the inner edge.
 */
export const movementExitStopPolygons = (
  terrains: ReadonlyArray<Terrain>,
  fromPosition: Vec2,
): Polygon[] => {
  const out: Polygon[] = [];
  for (const t of terrains) {
    if (
      t.kind !== 'DIFFICULT' &&
      t.kind !== 'SOFT' &&
      t.kind !== 'HIGH_GROUND'
    ) {
      continue;
    }
    if (isPointInPolygon(fromPosition, t.polygon)) {
      out.push(t.polygon);
    }
  }
  return out;
};
