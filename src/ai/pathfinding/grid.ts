/**
 * Grid A* pathfinding for free-2D maps. Discretises the playfield into
 * uniform cells and runs 8-connected A* with octile heuristic.
 *
 * Used by:
 *  1. The connectivity probe (`probe.ts`) — verifies that any A-zone point
 *     can reach any B-zone point on a given map.
 *  2. (Future) AI navigation — wraps `findPath` to give greedy/lookahead a
 *     wall-aware "step toward enemy" primitive.
 *
 * v1 cell-blocking model: cell is blocked when its centre lies inside any
 * HARD polygon. Conservative for tight passages but cheap and works for
 * the editor's rectangular wall pieces. DIFFICULT and SOFT are not
 * pathfinding obstacles (DIFFICULT stops the move at edge per rule 4.2C
 * but doesn't prevent traversal; SOFT is pass-through).
 */
import type { Vec2 } from '../../core/geometry/types';
import { isPointInPolygon } from '../../core/geometry/polygon';
import { distancePointToSegmentSq } from '../../core/geometry/segment';
import type { Polygon } from '../../core/geometry/types';
import type { Terrain } from '../../core/state/GameState';

export interface NavGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** Flat `rows × cols` array; `true` = blocked. */
  readonly blocked: ReadonlyArray<boolean>;
}

/**
 * Cell is blocked when its centre is inside a HARD polygon OR within
 * `inflateBy` pixels of any HARD polygon edge — i.e. a unit of that radius
 * placed at the cell centre would clip the wall. Without inflation,
 * pathfinding returns waypoints that the actual MOVE swept-circle test
 * can't reach (the suggested step grazes a wall and stops short).
 */
export const buildNavGrid = (
  mapSize: number,
  terrains: ReadonlyArray<Terrain>,
  cellSize = 16,
  inflateBy = 0,
): NavGrid => {
  const cols = Math.ceil(mapSize / cellSize);
  const rows = Math.ceil(mapSize / cellSize);
  const blocked = new Array<boolean>(cols * rows).fill(false);
  // HARD + BLOCKER + OUT_OF_BOUNDS + NO_ENTRY block movement unconditionally.
  // HIGH_GROUND blocks grid cells too (units must climb in). The grid is
  // for ground-level pathfinding — once a unit is on a platform, they can't
  // reach the grid anyway. AI lookahead doesn't model on-top movement yet.
  const hardPolys = terrains
    .filter(
      (t) =>
        t.kind === 'HARD' ||
        t.kind === 'BLOCKER' ||
        t.kind === 'HIGH_GROUND' ||
        t.kind === 'OUT_OF_BOUNDS' ||
        t.kind === 'NO_ENTRY',
    )
    .map((t) => t.polygon);
  const inflateSq = inflateBy * inflateBy;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cellSize;
      const cy = (r + 0.5) * cellSize;
      const center: Vec2 = { x: cx, y: cy };
      for (const poly of hardPolys) {
        if (cellHitsPolygon(center, poly, inflateSq)) {
          blocked[r * cols + c] = true;
          break;
        }
      }
    }
  }
  return { cellSize, cols, rows, blocked };
};

const cellHitsPolygon = (
  center: Vec2,
  poly: Polygon,
  inflateSq: number,
): boolean => {
  if (isPointInPolygon(center, poly)) return true;
  if (inflateSq <= 0) return false;
  const verts = poly.vertices;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    if (distancePointToSegmentSq(center, verts[j]!, verts[i]!) <= inflateSq) {
      return true;
    }
  }
  return false;
};

const cellKey = (grid: NavGrid, c: number, r: number): number =>
  r * grid.cols + c;

const cellCenter = (grid: NavGrid, c: number, r: number): Vec2 => ({
  x: (c + 0.5) * grid.cellSize,
  y: (r + 0.5) * grid.cellSize,
});

const cellAt = (grid: NavGrid, p: Vec2): { c: number; r: number } => ({
  c: Math.max(0, Math.min(grid.cols - 1, Math.floor(p.x / grid.cellSize))),
  r: Math.max(0, Math.min(grid.rows - 1, Math.floor(p.y / grid.cellSize))),
});

const isBlockedCell = (grid: NavGrid, c: number, r: number): boolean => {
  if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) return true;
  return grid.blocked[r * grid.cols + c]!;
};

export type StuckReason = 'NO_PATH' | 'START_BLOCKED' | 'TARGET_BLOCKED';

export interface PathResult {
  readonly success: boolean;
  /** Cell-centre waypoints from start to target (start/target replace endpoints). */
  readonly waypoints: ReadonlyArray<Vec2>;
  /** Approx pixel distance along waypoints. */
  readonly distance: number;
  /** Set when success=false. */
  readonly stuckAt?: Vec2;
  readonly stuckReason?: StuckReason;
  /** Number of A* nodes expanded (diagnostic). */
  readonly nodesExpanded: number;
}

const octileHeuristic = (
  a: { c: number; r: number },
  b: { c: number; r: number },
): number => {
  const dc = Math.abs(a.c - b.c);
  const dr = Math.abs(a.r - b.r);
  return Math.min(dc, dr) * Math.SQRT2 + Math.abs(dc - dr);
};

/**
 * 8-connected A* with octile heuristic and corner-cutting prevention.
 * Diagonal moves are only allowed when both adjacent cardinal cells are
 * also clear, so the path never squeezes between two diagonally-touching
 * walls (which a unit's circular base couldn't actually traverse).
 */
export const findPath = (
  grid: NavGrid,
  from: Vec2,
  to: Vec2,
): PathResult => {
  const start = cellAt(grid, from);
  const target = cellAt(grid, to);

  if (isBlockedCell(grid, start.c, start.r)) {
    return {
      success: false,
      waypoints: [],
      distance: 0,
      stuckAt: from,
      stuckReason: 'START_BLOCKED',
      nodesExpanded: 0,
    };
  }
  if (isBlockedCell(grid, target.c, target.r)) {
    return {
      success: false,
      waypoints: [],
      distance: 0,
      stuckAt: to,
      stuckReason: 'TARGET_BLOCKED',
      nodesExpanded: 0,
    };
  }

  const startKey = cellKey(grid, start.c, start.r);
  const targetKey = cellKey(grid, target.c, target.r);
  if (startKey === targetKey) {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    return {
      success: true,
      waypoints: [from, to],
      distance: dist,
      nodesExpanded: 0,
    };
  }

  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const open = new Set<number>([startKey]);
  gScore.set(startKey, 0);
  fScore.set(startKey, octileHeuristic(start, target));

  let nodesExpanded = 0;

  while (open.size > 0) {
    // Linear scan for min fScore in open set. With grid sizes around
    // 48×48 (testmap1) this is fast enough; if it ever becomes a bottleneck
    // swap in a binary heap keyed by fScore.
    let currentKey = -1;
    let currentF = Infinity;
    for (const k of open) {
      const f = fScore.get(k) ?? Infinity;
      if (f < currentF) {
        currentF = f;
        currentKey = k;
      }
    }
    if (currentKey === -1) break;
    nodesExpanded += 1;

    if (currentKey === targetKey) {
      const cells: number[] = [currentKey];
      let k = currentKey;
      while (cameFrom.has(k)) {
        k = cameFrom.get(k)!;
        cells.unshift(k);
      }
      const waypoints: Vec2[] = cells.map((key) => {
        const r = Math.floor(key / grid.cols);
        const c = key % grid.cols;
        return cellCenter(grid, c, r);
      });
      // Replace endpoints with the actual user-provided positions so the
      // first / last segments hit the precise start/target rather than the
      // cell centres.
      waypoints[0] = from;
      waypoints[waypoints.length - 1] = to;
      let dist = 0;
      for (let i = 1; i < waypoints.length; i++) {
        const dx = waypoints[i]!.x - waypoints[i - 1]!.x;
        const dy = waypoints[i]!.y - waypoints[i - 1]!.y;
        dist += Math.hypot(dx, dy);
      }
      return { success: true, waypoints, distance: dist, nodesExpanded };
    }

    open.delete(currentKey);
    const cr = Math.floor(currentKey / grid.cols);
    const cc = currentKey % grid.cols;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = cr + dr;
        const nc = cc + dc;
        if (isBlockedCell(grid, nc, nr)) continue;
        // Corner-cutting prevention: diagonals require both cardinals clear.
        if (dr !== 0 && dc !== 0) {
          if (
            isBlockedCell(grid, cc + dc, cr) ||
            isBlockedCell(grid, cc, cr + dr)
          ) {
            continue;
          }
        }
        const nKey = cellKey(grid, nc, nr);
        const stepCost = dr === 0 || dc === 0 ? 1 : Math.SQRT2;
        const tentG = (gScore.get(currentKey) ?? Infinity) + stepCost;
        if (tentG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, currentKey);
          gScore.set(nKey, tentG);
          fScore.set(nKey, tentG + octileHeuristic({ c: nc, r: nr }, target));
          open.add(nKey);
        }
      }
    }
  }

  return {
    success: false,
    waypoints: [],
    distance: 0,
    stuckAt: from,
    stuckReason: 'NO_PATH',
    nodesExpanded,
  };
};

/**
 * Path smoothing: if a straight line between two waypoints crosses no
 * blocked cells, drop the intermediate waypoints. Reduces the cell-centre
 * zigzag into long straight segments, which translates to fewer MOVE
 * actions when the AI follows the path.
 */
export const smoothPath = (
  grid: NavGrid,
  waypoints: ReadonlyArray<Vec2>,
): Vec2[] => {
  if (waypoints.length <= 2) return [...waypoints];
  const out: Vec2[] = [waypoints[0]!];
  let i = 0;
  while (i < waypoints.length - 1) {
    let j = waypoints.length - 1;
    while (j > i + 1 && !straightLineClear(grid, waypoints[i]!, waypoints[j]!)) {
      j -= 1;
    }
    out.push(waypoints[j]!);
    i = j;
  }
  return out;
};

const straightLineClear = (grid: NavGrid, a: Vec2, b: Vec2): boolean => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const samples = Math.max(2, Math.ceil(dist / (grid.cellSize / 2)));
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const c = Math.floor(px / grid.cellSize);
    const r = Math.floor(py / grid.cellSize);
    if (isBlockedCell(grid, c, r)) return false;
  }
  return true;
};
