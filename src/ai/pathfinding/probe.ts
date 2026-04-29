/**
 * Connectivity probe — answers "can a unit get from A's deployment zone
 * to B's, and where does it get stuck?"
 *
 * Usage flow: build a NavGrid for the map, sample N points from each
 * deployment zone, run findPath() on every (A → B) and (B → A) pair, and
 * aggregate the result. The CLI wrapper renders this as a console table
 * + writes the per-attempt detail to logs/probe-<ts>.json for later
 * inspection.
 *
 * This is purely a *map sanity test*: no game state, no AI, no shooting.
 * It validates that the geometry permits traversal at all. If the probe
 * fails for a map, no AI improvement will help — the map itself isn't
 * playable.
 */
import type { Vec2 } from '../../core/geometry/types';
import { isPointInPolygon } from '../../core/geometry/polygon';
import { STANDARD_BASE_RADIUS_PIXELS } from '../../core/rules/constants';
import type { Faction, Terrain } from '../../core/state/GameState';
import type { DeploymentZone, MapDef } from '../../core/setup/types';
import { buildNavGrid, findPath, smoothPath, type NavGrid } from './grid';

export interface ProbeAttempt {
  readonly from: Vec2;
  readonly to: Vec2;
  readonly success: boolean;
  readonly distance: number;
  readonly waypointCount: number;
  readonly stuckReason?: string;
  readonly stuckAt?: Vec2;
}

export interface DirectionReport {
  readonly fromFaction: Faction;
  readonly toFaction: Faction;
  readonly attempts: ReadonlyArray<ProbeAttempt>;
  readonly successRate: number;
  readonly avgDistance: number;
  readonly failureReasons: Readonly<Record<string, number>>;
}

export interface ProbeReport {
  readonly mapId: string;
  readonly mapSize: number;
  readonly cellSize: number;
  readonly samplesPerZone: number;
  readonly grid: { cols: number; rows: number; blockedCells: number; totalCells: number };
  readonly aToB: DirectionReport;
  readonly bToA: DirectionReport;
}

const polygonCentroid = (verts: ReadonlyArray<Vec2>): Vec2 => {
  let cx = 0;
  let cy = 0;
  for (const v of verts) {
    cx += v.x;
    cy += v.y;
  }
  return { x: cx / verts.length, y: cy / verts.length };
};

const polygonAabb = (verts: ReadonlyArray<Vec2>) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  return { minX, minY, maxX, maxY };
};

/**
 * Sample N points inside the zone polygon. For rectangular strip-zones
 * (the editor's typical output) this picks evenly-spaced points along the
 * long axis at the short-axis centre, which is exactly where deployment
 * placements would land.
 */
const sampleZonePoints = (zone: DeploymentZone, n: number): Vec2[] => {
  const verts = zone.polygon.vertices;
  if (n <= 0) return [];
  if (n === 1) return [polygonCentroid(verts)];
  const { minX, minY, maxX, maxY } = polygonAabb(verts);
  const w = maxX - minX;
  const h = maxY - minY;
  const longHorizontal = w >= h;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const candidate = longHorizontal
      ? { x: minX + w * t, y: (minY + maxY) / 2 }
      : { x: (minX + maxX) / 2, y: minY + h * t };
    // Only keep samples that actually fall inside the polygon (strip zones
    // are convex rectangles so this is always true; future irregular zones
    // get safer behaviour).
    if (isPointInPolygon(candidate, zone.polygon)) {
      out.push(candidate);
    }
  }
  return out;
};

const blockedCount = (grid: NavGrid): number => {
  let n = 0;
  for (const b of grid.blocked) if (b) n += 1;
  return n;
};

const probeDirection = (
  grid: NavGrid,
  fromZone: DeploymentZone,
  toZone: DeploymentZone,
  samplesPerZone: number,
): DirectionReport => {
  const fromPts = sampleZonePoints(fromZone, samplesPerZone);
  const toPts = sampleZonePoints(toZone, samplesPerZone);
  const attempts: ProbeAttempt[] = [];
  for (const a of fromPts) {
    for (const b of toPts) {
      const path = findPath(grid, a, b);
      const smoothed = path.success ? smoothPath(grid, path.waypoints) : [];
      attempts.push({
        from: a,
        to: b,
        success: path.success,
        distance: path.distance,
        waypointCount: smoothed.length,
        stuckReason: path.stuckReason,
        stuckAt: path.stuckAt,
      });
    }
  }
  const successes = attempts.filter((x) => x.success);
  const failureReasons: Record<string, number> = {};
  for (const a of attempts) {
    if (!a.success && a.stuckReason) {
      failureReasons[a.stuckReason] = (failureReasons[a.stuckReason] ?? 0) + 1;
    }
  }
  return {
    fromFaction: fromZone.faction,
    toFaction: toZone.faction,
    attempts,
    successRate: attempts.length === 0 ? 0 : successes.length / attempts.length,
    avgDistance:
      successes.length === 0
        ? 0
        : successes.reduce((s, a) => s + a.distance, 0) / successes.length,
    failureReasons,
  };
};

export interface ProbeOptions {
  readonly samplesPerZone?: number;
  readonly cellSize?: number;
  readonly unitRadius?: number;
}

export const probeMapTraversal = (
  map: MapDef,
  opts: ProbeOptions = {},
): ProbeReport => {
  const samplesPerZone = opts.samplesPerZone ?? 5;
  const cellSize = opts.cellSize ?? 16;
  const unitRadius = opts.unitRadius ?? STANDARD_BASE_RADIUS_PIXELS;

  const grid = buildNavGrid(
    map.size,
    map.terrain as Terrain[],
    cellSize,
    unitRadius,
  );
  const zoneA = map.deploymentZones.find((z) => z.faction === 'A');
  const zoneB = map.deploymentZones.find((z) => z.faction === 'B');
  if (!zoneA || !zoneB) {
    throw new Error(
      `Map "${map.id}" missing one or both deployment zones (A/B)`,
    );
  }
  return {
    mapId: map.id,
    mapSize: map.size,
    cellSize,
    samplesPerZone,
    grid: {
      cols: grid.cols,
      rows: grid.rows,
      blockedCells: blockedCount(grid),
      totalCells: grid.cols * grid.rows,
    },
    aToB: probeDirection(grid, zoneA, zoneB, samplesPerZone),
    bToA: probeDirection(grid, zoneB, zoneA, samplesPerZone),
  };
};
