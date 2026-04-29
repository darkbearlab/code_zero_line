import type { Polygon, Vec2 } from '../geometry/types';
import type { CoverKind, Faction } from '../state/GameState';

/**
 * A deployment zone is a region of the map where one side may place units.
 * Zones are tagged by `faction` so a single map can support both A and B
 * placement, plus future scenarios where a faction's zone is split or shared.
 */
export interface DeploymentZone {
  readonly id: string;
  readonly faction: Faction;
  readonly polygon: Polygon;
}

export interface MapTerrainDef {
  readonly id: string;
  readonly kind: CoverKind;
  readonly polygon: Polygon;
  readonly height?: number;
  readonly displayName?: string;
}

/**
 * Scenario objective — a circular area on the map that scenarios can use as
 * a control point. Currently consumed by the `engage-reach` sim mode and the
 * AI's state evaluator. Maps without scenario objectives leave this empty.
 */
export interface MapObjective {
  readonly id: string;
  readonly position: Vec2;
  readonly radius: number;
  readonly displayName?: string;
}

export interface MapDef {
  readonly id: string;
  readonly displayName: string;
  /** Square battlefield in pixels (matches BATTLEFIELD_SIZE_PIXELS). */
  readonly size: number;
  readonly terrain: ReadonlyArray<MapTerrainDef>;
  readonly deploymentZones: ReadonlyArray<DeploymentZone>;
  /** Scenario control points (capture/hold). Optional. */
  readonly objectives?: ReadonlyArray<MapObjective>;
}

/** A picked entry in a side's roster. */
export interface RosterEntry {
  readonly id: string;
  readonly templateId: string;
}

export interface RostersBySide {
  readonly A: ReadonlyArray<RosterEntry>;
  readonly B: ReadonlyArray<RosterEntry>;
}

export interface DeploymentPlacement {
  readonly rosterId: string;
  readonly position: Vec2;
}

export interface DeploymentBySide {
  readonly A: ReadonlyArray<DeploymentPlacement>;
  readonly B: ReadonlyArray<DeploymentPlacement>;
}

export const ROSTER_MIN_PER_SIDE = 2;
export const ROSTER_MAX_PER_SIDE = 6;
