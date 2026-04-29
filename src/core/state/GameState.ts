import type { Circle, Polygon, Vec2 } from '../geometry/types';

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
}

export type CoverKind = 'HARD' | 'DIFFICULT' | 'SOFT';

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

export interface GameState {
  /** Master seed; combined with `commandCount` to derive per-command RNG. */
  readonly seed: string;
  readonly commandCount: number;
  readonly units: ReadonlyArray<Unit>;
  readonly terrain: ReadonlyArray<Terrain>;
  /** Scenario control points carried over from MapDef.objectives. Optional. */
  readonly objectives?: ReadonlyArray<Objective>;
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
