/**
 * Editor-friendly map representation: a list of oriented rectangles tagged
 * by tool kind. The game runtime consumes the polygon-based MapDef, so this
 * module also provides round-trip converters.
 *
 * Storing rectangles (rather than polygons) preserves rotation handles for
 * subsequent edits, which `MapDef` cannot represent because it canonicalises
 * to vertices.
 */
import type { Vec2 } from '../core/geometry/types';
import type { Faction } from '../core/state/GameState';
import type {
  DeploymentZone,
  MapDef,
  MapObjective,
  MapTerrainDef,
} from '../core/setup/types';

export type EditorShapeTool =
  | 'low'
  | 'high'
  | 'blocker'
  | 'high-ground'
  | 'difficult'
  | 'soft'
  | 'out-of-bounds'
  | 'no-entry'
  | 'zone-a'
  | 'zone-b'
  | 'objective';

export interface EditorMapShape {
  readonly id: string;
  readonly tool: EditorShapeTool;
  /** Centre of the rectangle. */
  readonly cx: number;
  readonly cy: number;
  /** Pre-rotation width / height. */
  readonly w: number;
  readonly h: number;
  /** Rotation in radians, around the centre. */
  readonly angle: number;
  /**
   * Strict serial slot index for `tool === 'zone-a'` shapes only. The
   * editor maintains the no-gap, no-duplicate invariant by auto-assigning
   * the next free index on creation and repacking on delete / reorder.
   * Loaded docs that lack the field get repacked on first open.
   */
  readonly slotIndex?: number;
}

export interface EditorMapDoc {
  readonly id: string;
  readonly displayName: string;
  readonly size: number;
  readonly shapes: ReadonlyArray<EditorMapShape>;
  readonly _custom?: true;
}

const LOW_WALL_HEIGHT = 24;
const HIGH_WALL_HEIGHT = 200;

const TOOL_LABEL: Readonly<Record<EditorShapeTool, string>> = {
  low: '矮牆',
  high: '高牆',
  blocker: '封頂牆',
  'high-ground': '高地',
  difficult: '瓦礫',
  soft: '煙幕',
  'out-of-bounds': '不可互動區域',
  'no-entry': '不可進入區',
  'zone-a': 'Zone A',
  'zone-b': 'Zone B',
  objective: '目標',
};

export const editorToolLabel = (tool: EditorShapeTool): string =>
  TOOL_LABEL[tool];

/**
 * Re-stamp slotIndex on every `zone-a` shape so the indices form a strict
 * 1-based serial (1, 2, 3, …) with no gaps and no duplicates. Order is
 * preserved from the input array (caller controls reordering by reordering
 * the array itself). Non-zone-a shapes pass through unchanged. Existing
 * slotIndex values on zone-a shapes act as a stable sort key when present;
 * unstamped shapes drift to the end. Always returns a fresh array.
 */
export const repackZoneASlots = (
  shapes: ReadonlyArray<EditorMapShape>,
): EditorMapShape[] => {
  const zoneAIdxs: number[] = [];
  shapes.forEach((s, i) => {
    if (s.tool === 'zone-a') zoneAIdxs.push(i);
  });
  // Stable sort by current slotIndex (undefined → +∞ pushes new shapes to end)
  zoneAIdxs.sort((a, b) => {
    const sa = shapes[a]!.slotIndex ?? Number.POSITIVE_INFINITY;
    const sb = shapes[b]!.slotIndex ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return a - b;
  });
  const newSlot = new Map<number, number>();
  zoneAIdxs.forEach((origIdx, i) => newSlot.set(origIdx, i + 1));
  return shapes.map((s, i) =>
    s.tool === 'zone-a' ? { ...s, slotIndex: newSlot.get(i) } : s,
  );
};

/**
 * Move a zone-a shape one position earlier or later in the slot order.
 * No-op at boundaries. Repacks afterward so indices stay strict-serial.
 */
export const moveZoneASlot = (
  shapes: ReadonlyArray<EditorMapShape>,
  shapeId: string,
  direction: 'up' | 'down',
): EditorMapShape[] => {
  const target = shapes.find((s) => s.id === shapeId && s.tool === 'zone-a');
  if (!target) return shapes.map((s) => ({ ...s }));
  const packed = repackZoneASlots(shapes);
  const targetSlot = packed.find((s) => s.id === shapeId)?.slotIndex;
  if (typeof targetSlot !== 'number') return packed;
  const swapSlot = direction === 'up' ? targetSlot - 1 : targetSlot + 1;
  if (swapSlot < 1) return packed;
  const swapPartner = packed.find(
    (s) => s.tool === 'zone-a' && s.slotIndex === swapSlot,
  );
  if (!swapPartner) return packed;
  return packed.map((s) => {
    if (s.id === target.id) return { ...s, slotIndex: swapSlot };
    if (s.id === swapPartner.id) return { ...s, slotIndex: targetSlot };
    return s;
  });
};

export const shapeVertices = (s: EditorMapShape): Vec2[] => {
  const hw = s.w / 2;
  const hh = s.h / 2;
  const cs = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  const r = (lx: number, ly: number): Vec2 => ({
    x: s.cx + lx * cs - ly * sn,
    y: s.cy + lx * sn + ly * cs,
  });
  return [r(-hw, -hh), r(hw, -hh), r(hw, hh), r(-hw, hh)];
};

/**
 * Whether a shape's bounding box is fully outside the map. The editor
 * keeps such shapes in the doc (so users don't lose work when shrinking
 * the map), but the runtime never sees them.
 */
const shapeFullyOutside = (s: EditorMapShape, size: number): boolean => {
  if (s.tool === 'objective') {
    const r = Math.max(s.w, s.h) / 2;
    return (
      s.cx + r < 0 || s.cx - r > size || s.cy + r < 0 || s.cy - r > size
    );
  }
  const verts = shapeVertices(s);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  return maxX < 0 || minX > size || maxY < 0 || minY > size;
};

export const docToMapDef = (doc: EditorMapDoc): MapDef => {
  const terrain: MapTerrainDef[] = [];
  const zones: DeploymentZone[] = [];
  const objectives: MapObjective[] = [];
  for (const s of doc.shapes) {
    // Out-of-bounds shapes stay in the doc but never reach the runtime.
    if (shapeFullyOutside(s, doc.size)) continue;
    if (s.tool === 'objective') {
      // Objectives encode their diameter in `w` (== `h`); angle is ignored.
      objectives.push({
        id: s.id,
        position: { x: s.cx, y: s.cy },
        radius: Math.max(s.w, s.h) / 2,
        displayName: TOOL_LABEL.objective,
      });
      continue;
    }
    const verts = shapeVertices(s);
    if (s.tool === 'zone-a' || s.tool === 'zone-b') {
      const faction: Faction = s.tool === 'zone-a' ? 'A' : 'B';
      zones.push({
        id: s.id,
        faction,
        polygon: { vertices: verts },
        ...(s.tool === 'zone-a' && typeof s.slotIndex === 'number'
          ? { slotIndex: s.slotIndex }
          : {}),
      });
      continue;
    }
    const kind =
      s.tool === 'low' || s.tool === 'high'
        ? 'HARD'
        : s.tool === 'blocker'
          ? 'BLOCKER'
          : s.tool === 'high-ground'
            ? 'HIGH_GROUND'
            : s.tool === 'out-of-bounds'
              ? 'OUT_OF_BOUNDS'
              : s.tool === 'no-entry'
                ? 'NO_ENTRY'
                : s.tool === 'difficult'
                  ? 'DIFFICULT'
                  : 'SOFT';
    const def: MapTerrainDef = {
      id: s.id,
      kind,
      polygon: { vertices: verts },
      ...(s.tool === 'low'
        ? { height: LOW_WALL_HEIGHT }
        : s.tool === 'high'
          ? { height: HIGH_WALL_HEIGHT }
          : {}),
      displayName: TOOL_LABEL[s.tool],
    };
    terrain.push(def);
  }
  return {
    id: doc.id,
    displayName: doc.displayName,
    size: doc.size,
    terrain,
    deploymentZones: zones,
    ...(objectives.length > 0 ? { objectives } : {}),
  };
};

const aabbFromVerts = (
  verts: ReadonlyArray<Vec2>,
): { cx: number; cy: number; w: number; h: number } => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: maxX - minX,
    h: maxY - minY,
  };
};

const terrainTool = (t: MapTerrainDef): EditorShapeTool => {
  if (t.kind === 'HARD') {
    return (t.height ?? HIGH_WALL_HEIGHT) <= LOW_WALL_HEIGHT * 2
      ? 'low'
      : 'high';
  }
  if (t.kind === 'BLOCKER') return 'blocker';
  if (t.kind === 'HIGH_GROUND') return 'high-ground';
  if (t.kind === 'OUT_OF_BOUNDS') return 'out-of-bounds';
  if (t.kind === 'NO_ENTRY') return 'no-entry';
  return t.kind === 'DIFFICULT' ? 'difficult' : 'soft';
};

/**
 * Best-effort import. Bundled `MapDef` polygons are axis-aligned rectangles,
 * so we recover (cx, cy, w, h) by AABB and assume angle = 0. Rotated polygons
 * round-trip with their AABB as a fallback.
 */
export const mapDefToDoc = (map: MapDef): EditorMapDoc => {
  const shapes: EditorMapShape[] = [];
  for (const t of map.terrain) {
    const box = aabbFromVerts(t.polygon.vertices);
    shapes.push({ id: t.id, tool: terrainTool(t), ...box, angle: 0 });
  }
  for (const z of map.deploymentZones) {
    const box = aabbFromVerts(z.polygon.vertices);
    shapes.push({
      id: z.id,
      tool: z.faction === 'A' ? 'zone-a' : 'zone-b',
      ...box,
      angle: 0,
      ...(z.faction === 'A' && typeof z.slotIndex === 'number'
        ? { slotIndex: z.slotIndex }
        : {}),
    });
  }
  for (const o of map.objectives ?? []) {
    const d = o.radius * 2;
    shapes.push({
      id: o.id,
      tool: 'objective',
      cx: o.position.x,
      cy: o.position.y,
      w: d,
      h: d,
      angle: 0,
    });
  }
  return {
    id: map.id,
    displayName: map.displayName,
    size: map.size,
    shapes,
  };
};
