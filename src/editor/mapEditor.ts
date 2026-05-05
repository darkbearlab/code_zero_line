import {
  docToMapDef,
  mapDefToDoc,
  moveZoneASlot,
  repackZoneASlots,
  shapeVertices,
  editorToolLabel,
  type EditorMapDoc,
  type EditorMapShape,
  type EditorShapeTool,
} from '../config/mapDoc';
import { listBundledMaps, listMaps } from '../config/loader';
import { el } from './dom';
import { paintBoardFloorCanvas } from '../presentation/rendering/boardFloor';
import { downloadJson, pickJsonFile, saveToBundleEndpoint, timestampForFilename } from './io';
import {
  loadCustomMaps,
  removeCustomMap,
  upsertCustomMap,
} from './storage';

type Tool = 'select' | EditorShapeTool;

interface DraftShape {
  id: string;
  tool: EditorShapeTool;
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

type Drag =
  | { kind: 'create'; tool: EditorShapeTool; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'move'; shapeId: string; offX: number; offY: number }
  | { kind: 'rotate'; shapeId: string }
  | { kind: 'pan'; startX: number; startY: number; startOffX: number; startOffY: number }
  | null;

const CANVAS_PX = 600;
/**
 * 1 unit-distance (UD) in world pixels — also the unit base diameter.
 * Game terminology: 1 UD = 3 英吋 (inches) of physical measurement.
 */
const PX_PER_UD = 96;
const INCHES_PER_UD = 3;
/** Pixels per real inch — derived. Used to render dimensions in 英吋 (inches). */
const PX_PER_INCH = PX_PER_UD / INCHES_PER_UD;
const DEFAULT_SIZE = 8 * PX_PER_UD;
const MIN_RECT = 8;
/** Min/max map size in 英吋 (inches). 144 in = 48 UD = long-push scenarios. */
const MIN_MAP_INCHES = 12;
const MAX_MAP_INCHES = 144;
/** Click-to-place objectives spawn at this diameter (1 unit-distance). */
const OBJECTIVE_DEFAULT_DIAMETER = PX_PER_UD;
/** Pixel offset applied when duplicating a shape, so it's visible. */
const DUPLICATE_OFFSET_PX = 16;

const TOOL_ORDER: Tool[] = [
  'select',
  'low',
  'high',
  'blocker',
  'high-ground',
  'difficult',
  'soft',
  'out-of-bounds',
  'no-entry',
  'zone-a',
  'zone-b',
  'objective',
];

const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select',
  low: 'Low Wall',
  high: 'High Wall',
  blocker: 'Blocker (封頂)',
  'high-ground': 'High Ground (高地)',
  difficult: 'Difficult',
  soft: 'Soft (Smoke)',
  'out-of-bounds': 'Out of Bounds (不可互動)',
  'no-entry': 'No Entry (不可進入)',
  'zone-a': 'Zone A',
  'zone-b': 'Zone B',
  objective: 'Objective',
};

const TOOL_FILL: Record<EditorShapeTool, string> = {
  low: 'rgba(180,180,180,0.55)',
  high: 'rgba(150,150,150,0.85)',
  blocker: 'rgba(50,50,50,0.95)',
  'high-ground': 'rgba(120,90,60,0.55)',
  difficult: 'rgba(160,120,70,0.45)',
  soft: 'rgba(220,220,220,0.25)',
  'out-of-bounds': 'rgba(80,20,20,0.85)',
  'no-entry': 'rgba(20,40,80,0.35)',
  'zone-a': 'rgba(74,138,207,0.18)',
  'zone-b': 'rgba(207,90,74,0.18)',
  objective: 'rgba(255, 209, 102, 0.18)',
};

const TOOL_STROKE: Record<EditorShapeTool, string> = {
  low: '#9aa89a',
  high: '#dcdcdc',
  blocker: '#000000',
  'high-ground': '#d8a76a',
  difficult: '#b8884a',
  soft: '#cfcfcf',
  'out-of-bounds': '#ff5050',
  'no-entry': '#6ab0ff',
  'zone-a': '#6ab0ff',
  'zone-b': '#ff8a6a',
  objective: '#ffd166',
};

/** Objectives are circles, not rotatable rects. */
const isCircleTool = (tool: EditorShapeTool): boolean => tool === 'objective';

export interface MapEditorOptions {
  /**
   * When true, hide controls that talk to the dev-server bundle endpoint
   * (the "Save to bundle" button). Use for standalone builds that have no
   * Vite dev middleware backing them. Other features — localStorage save,
   * JSON import/export — work the same.
   */
  readonly hideServerActions?: boolean;
}

export const mountMapEditor = (
  root: HTMLElement,
  options: MapEditorOptions = {},
): void => {
  const { hideServerActions = false } = options;
  let doc: EditorMapDoc = newDoc();
  let selectedShapeId: string | null = null;
  let activeTool: Tool = 'low';
  let drag: Drag = null;
  let snap = true;
  // Floating shape inspector — collapse cx/cy by default since the
  // canvas drag covers the common case; remember user preference.
  let coordsExpanded = false;
  // Live-mirror mode: when an axis is enabled, every add / edit / delete on a
  // shape gets applied to twin shape(s) reflected across that axis. Both
  // axes can be active simultaneously — a single source then spawns 3 twins
  // (h-mirror, v-mirror, h+v-mirror) so all four quadrants stay in sync.
  // Group links live in editor session only — saved JSON sees independent
  // real shapes.
  const mirrorAxes = new Set<'h' | 'v'>();
  const MIRROR_H = 1;
  const MIRROR_V = 2;
  // For each shape that's part of a mirror group, map (other shape id →
  // axis-flag bitmask describing the reflection between them). Symmetric:
  // if A→B has flags F, then B→A has the same F (mirroring is involutive).
  const mirrorGroups = new Map<string, Map<string, number>>();

  // ─── Clipboard + undo/redo history ──────────────────────────────
  // Clipboard stores the source shape verbatim; paste creates a fresh id,
  // offsets position so it doesn't overlap, and re-runs mirror twin-spawn.
  let clipboard: EditorMapShape | null = null;
  // Successive pastes step the offset so a stream of Ctrl+V doesn't pile
  // shapes at the same point.
  let pasteCounter = 0;

  interface HistorySnapshot {
    readonly doc: EditorMapDoc;
    readonly mirrorGroups: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]>;
    readonly selectedShapeId: string | null;
  }
  const undoStack: HistorySnapshot[] = [];
  const redoStack: HistorySnapshot[] = [];
  const HISTORY_LIMIT = 100;

  const snapshotState = (): HistorySnapshot => ({
    // doc is replaced wholesale on every mutation, so the reference itself
    // is a frozen-in-time value — no deep clone needed.
    doc,
    mirrorGroups: [...mirrorGroups.entries()].map(
      ([k, v]) => [k, [...v.entries()]] as const,
    ),
    selectedShapeId,
  });

  const restoreState = (snap: HistorySnapshot): void => {
    doc = snap.doc;
    mirrorGroups.clear();
    for (const [k, entries] of snap.mirrorGroups) {
      mirrorGroups.set(k, new Map(entries));
    }
    selectedShapeId = snap.selectedShapeId;
  };

  /** Capture the current state for undo. Call BEFORE applying a mutation. */
  const pushHistory = (): void => {
    undoStack.push(snapshotState());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    // Any new user action invalidates the redo stack — branching history
    // would surprise users (Ctrl+Z then act, then Ctrl+Y replays old work).
    redoStack.length = 0;
    pasteCounter = 0;
  };

  const undo = (): void => {
    if (undoStack.length === 0) return;
    redoStack.push(snapshotState());
    const snap = undoStack.pop()!;
    restoreState(snap);
    renderForm();
  };

  const redo = (): void => {
    if (redoStack.length === 0) return;
    undoStack.push(snapshotState());
    const snap = redoStack.pop()!;
    restoreState(snap);
    renderForm();
  };

  // View transform: zoom multiplier on top of base fit-to-canvas scale, plus
  // pan offset in screen pixels. Persists across renderForm() rebuilds.
  let viewScale = 1;
  let viewOffsetX = 0;
  let viewOffsetY = 0;
  let spaceHeld = false;
  const MIN_VIEW_SCALE = 0.25;
  const MAX_VIEW_SCALE = 8;
  const resetView = (): void => {
    viewScale = 1;
    viewOffsetX = 0;
    viewOffsetY = 0;
  };

  const mirroredShape = (
    s: EditorMapShape,
    newId: string,
    flags: number,
  ): EditorMapShape => {
    const cx = (flags & MIRROR_H) !== 0 ? doc.size - s.cx : s.cx;
    const cy = (flags & MIRROR_V) !== 0 ? doc.size - s.cy : s.cy;
    // Each axis flip negates the rotation; both axes compose to identity
    // (a 180° rotation preserves a rectangle's orientation).
    const angleSign =
      ((flags & MIRROR_H) !== 0 ? -1 : 1) *
      ((flags & MIRROR_V) !== 0 ? -1 : 1);
    return { ...s, id: newId, cx, cy, angle: angleSign * s.angle };
  };

  const mirrorPatch = (
    patch: Partial<EditorMapShape>,
    flags: number,
  ): Partial<EditorMapShape> => {
    const out: { -readonly [K in keyof EditorMapShape]?: EditorMapShape[K] } = {
      ...patch,
    };
    if ((flags & MIRROR_H) !== 0 && patch.cx !== undefined) {
      out.cx = doc.size - patch.cx;
    }
    if ((flags & MIRROR_V) !== 0 && patch.cy !== undefined) {
      out.cy = doc.size - patch.cy;
    }
    if (patch.angle !== undefined) {
      const sign =
        ((flags & MIRROR_H) !== 0 ? -1 : 1) *
        ((flags & MIRROR_V) !== 0 ? -1 : 1);
      out.angle = sign * patch.angle;
    }
    return out;
  };

  const linkPair = (a: string, b: string, flags: number): void => {
    let aMap = mirrorGroups.get(a);
    if (!aMap) {
      aMap = new Map();
      mirrorGroups.set(a, aMap);
    }
    let bMap = mirrorGroups.get(b);
    if (!bMap) {
      bMap = new Map();
      mirrorGroups.set(b, bMap);
    }
    aMap.set(b, flags);
    bMap.set(a, flags);
  };

  /** Drop every link involving `id`. Returns the ids that were linked. */
  const unlinkAll = (id: string): string[] => {
    const others = mirrorGroups.get(id);
    if (!others) return [];
    const linked = [...others.keys()];
    for (const o of linked) mirrorGroups.get(o)?.delete(id);
    mirrorGroups.delete(id);
    return linked;
  };

  /**
   * Add mirrored twin(s) for a freshly-created source shape, one per active
   * axis combination. Both axes active → 3 twins (H, V, H+V) so all four
   * quadrants of the map stay synchronised.
   */
  const addMirrorTwins = (src: EditorMapShape): void => {
    if (mirrorAxes.size === 0) return;
    const flagSets: number[] = [];
    if (mirrorAxes.has('h')) flagSets.push(MIRROR_H);
    if (mirrorAxes.has('v')) flagSets.push(MIRROR_V);
    if (mirrorAxes.has('h') && mirrorAxes.has('v')) {
      flagSets.push(MIRROR_H | MIRROR_V);
    }
    const created: { id: string; flags: number }[] = [];
    const newShapes: EditorMapShape[] = [];
    for (const flags of flagSets) {
      // Pass a virtual doc that includes shapes generated so far in this
      // batch — otherwise nextShapeId would hand out duplicate ids.
      const virtualDoc: EditorMapDoc = {
        ...doc,
        shapes: [...doc.shapes, ...newShapes],
      };
      const id = nextShapeId(virtualDoc, src.tool);
      newShapes.push(mirroredShape(src, id, flags));
      created.push({ id, flags });
    }
    doc = { ...doc, shapes: [...doc.shapes, ...newShapes] };
    for (const c of created) linkPair(src.id, c.id, c.flags);
    // Pairwise links between twins: relative flags = XOR of their flags
    // measured from the source.
    for (let i = 0; i < created.length; i++) {
      for (let j = i + 1; j < created.length; j++) {
        const a = created[i]!;
        const b = created[j]!;
        linkPair(a.id, b.id, a.flags ^ b.flags);
      }
    }
  };

  /** Apply a patch to every twin of the source, mirrored per pair flags. */
  const propagatePatchToTwin = (
    sourceId: string,
    patch: Partial<EditorMapShape>,
  ): void => {
    const others = mirrorGroups.get(sourceId);
    if (!others || others.size === 0) return;
    let nextShapes = doc.shapes;
    let mutated = false;
    for (const [twinId, flags] of others) {
      const idx = nextShapes.findIndex((x) => x.id === twinId);
      if (idx < 0) continue;
      const updated = [...nextShapes];
      updated[idx] = { ...nextShapes[idx]!, ...mirrorPatch(patch, flags) };
      nextShapes = updated;
      mutated = true;
    }
    if (mutated) doc = { ...doc, shapes: nextShapes };
  };

  const grid = el('div', { className: 'editor-grid' });
  const listPanel = el('div', { className: 'item-list' });
  const formPanel = el('div', { className: 'form' });

  const renderList = (): void => {
    listPanel.innerHTML = '';
    const toolbar = el('div', { className: 'toolbar' });
    toolbar.appendChild(
      el('button', {
        text: '+ New map',
        onclick: () => {
          doc = newDoc();
          selectedShapeId = null;
          refresh();
        },
      }),
    );
    toolbar.appendChild(
      el('button', {
        text: '⤓ Export',
        onclick: () => {
          const customs = loadCustomMaps();
          if (customs.length === 0) {
            alert('No custom maps to export.');
            return;
          }
          downloadJson(`czl-maps-${timestampForFilename()}.json`, customs);
        },
      }),
    );
    toolbar.appendChild(
      el('button', {
        text: '⤒ Import',
        onclick: async () => {
          try {
            const data = await pickJsonFile();
            if (!data) return;
            const arr = Array.isArray(data) ? data : [data];
            let added = 0;
            for (const item of arr) {
              const m = item as EditorMapDoc;
              if (!m?.id || !m.shapes) {
                alert(`Skipped invalid entry: ${JSON.stringify(item).slice(0, 80)}`);
                continue;
              }
              upsertCustomMap({ ...m });
              added += 1;
            }
            alert(`Imported ${added} map(s).`);
            refresh();
          } catch (e) {
            alert(`Import failed: ${(e as Error).message}`);
          }
        },
      }),
    );
    listPanel.appendChild(toolbar);

    const customs = loadCustomMaps();
    const customIds = new Set(customs.map((m) => m.id));

    const all = listMaps();
    for (const m of all) {
      const isCustom = customIds.has(m.id);
      const row = el('div', { className: 'row' });
      if (m.id === doc.id) row.classList.add('active');
      const title = el('div', {
        text: `${m.displayName} (${m.id})`,
      });
      const meta = el('div', {
        className: 'meta',
        text: `${m.terrain.length} terrain · ${m.deploymentZones.length} zones`,
      });
      row.appendChild(title);
      if (isCustom) {
        const badge = el('span', { className: 'badge', text: 'custom' });
        title.appendChild(badge);
      } else {
        const badge = el('span', { className: 'badge', text: 'bundled' });
        badge.style.color = '#7a9a7a';
        title.appendChild(badge);
      }
      row.appendChild(meta);
      row.onclick = () => {
        const customDoc = customs.find((d) => d.id === m.id);
        doc = customDoc
          ? cloneDoc(customDoc)
          : mapDefToDoc(m);
        selectedShapeId = null;
        refresh();
      };
      listPanel.appendChild(row);
    }

    if (listBundledMaps().length === 0 && customs.length === 0) {
      listPanel.appendChild(el('div', { className: 'empty', text: 'No maps yet.' }));
    }
  };

  const renderForm = (): void => {
    // Re-stamp Zone-A slot indices (strict-serial invariant) on every
    // render. Mutation paths don't have to call repack themselves —
    // they just reorder/insert/delete the array and the next render
    // picks up the canonical numbering.
    doc = { ...doc, shapes: repackZoneASlots(doc.shapes) };
    formPanel.innerHTML = '';
    formPanel.classList.add('map-form');

    // Canvas + dynamic side. ResizeObserver below recomputes after layout
    // so the canvas fills the available space inside .map-canvas-wrap.
    let canvasSide = CANVAS_PX;
    const canvas = document.createElement('canvas');
    canvas.width = canvasSide;
    canvas.height = canvasSide;
    canvas.style.border = '1px solid #2a3a2a';
    canvas.style.background = '#0e120e';
    canvas.style.cursor = activeTool === 'select' ? 'default' : 'crosshair';
    canvas.style.touchAction = 'none';

    const effScale = (): number => (canvasSide / doc.size) * viewScale;
    const toWorld = (px: number, py: number): { x: number; y: number } => {
      const s = effScale();
      return {
        x: (px - viewOffsetX) / s,
        y: (py - viewOffsetY) / s,
      };
    };

    const findShapeAt = (x: number, y: number): EditorMapShape | null => {
      for (let i = doc.shapes.length - 1; i >= 0; i--) {
        const s = doc.shapes[i]!;
        if (pointInShape({ x, y }, s)) return s;
      }
      return null;
    };

    const getRotateHandlePos = (s: EditorMapShape): { x: number; y: number } => {
      const dy = -s.h / 2 - 18;
      const cs = Math.cos(s.angle);
      const sn = Math.sin(s.angle);
      return { x: s.cx + 0 * cs - dy * sn, y: s.cy + 0 * sn + dy * cs };
    };

    const redraw = (): void => {
      const ctx = canvas.getContext('2d')!;
      const s = effScale();
      ctx.clearRect(0, 0, canvasSide, canvasSide);
      ctx.save();
      ctx.translate(viewOffsetX, viewOffsetY);
      ctx.scale(s, s);

      // 1-UD checker floor — same look as in-game battlefield.
      paintBoardFloorCanvas(ctx, doc.size);
      ctx.strokeStyle = '#2a3a2a';
      ctx.lineWidth = 2 / s;
      ctx.strokeRect(0, 0, doc.size, doc.size);

      // Shapes
      for (const sh of doc.shapes) {
        drawShape(ctx, sh, sh.id === selectedShapeId, s);
      }

      // Active drag preview
      if (drag && drag.kind === 'create') {
        const x = Math.min(drag.x0, drag.x1);
        const y = Math.min(drag.y0, drag.y1);
        const w = Math.abs(drag.x1 - drag.x0);
        const h = Math.abs(drag.y1 - drag.y0);
        ctx.fillStyle = TOOL_FILL[drag.tool];
        ctx.strokeStyle = TOOL_STROKE[drag.tool];
        ctx.lineWidth = 1.5 / s;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }

      ctx.restore();
      positionInfoPanel();
    };

    // Cursor-anchored zoom (used by toolbar + wheel). Defined here so the
    // tool column buttons can reference it when built below.
    const zoomAt = (factor: number): void => {
      const cx = canvasSide / 2;
      const cy = canvasSide / 2;
      const before = toWorld(cx, cy);
      viewScale = Math.max(
        MIN_VIEW_SCALE,
        Math.min(MAX_VIEW_SCALE, viewScale * factor),
      );
      const s = effScale();
      viewOffsetX = cx - before.x * s;
      viewOffsetY = cy - before.y * s;
      redraw();
    };

    const onPointerDown = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const wp = toWorld(px, py);
      canvas.setPointerCapture(e.pointerId);

      // Middle/right mouse OR space-modifier → pan, regardless of active tool.
      if (e.button === 1 || e.button === 2 || spaceHeld) {
        drag = {
          kind: 'pan',
          startX: px,
          startY: py,
          startOffX: viewOffsetX,
          startOffY: viewOffsetY,
        };
        canvas.style.cursor = 'grabbing';
        return;
      }

      if (activeTool === 'select') {
        // Rotate handle?
        if (selectedShapeId) {
          const s = doc.shapes.find((x) => x.id === selectedShapeId);
          if (s) {
            const h = getRotateHandlePos(s);
            const dx = wp.x - h.x;
            const dy = wp.y - h.y;
            const eff = effScale();
            if (dx * dx + dy * dy <= (12 / eff) * (12 / eff)) {
              // Snapshot at gesture start, not on every pointermove tick.
              pushHistory();
              drag = { kind: 'rotate', shapeId: s.id };
              return;
            }
          }
        }
        const hit = findShapeAt(wp.x, wp.y);
        if (hit) {
          // Snapshot once for the whole drag-move gesture.
          pushHistory();
          selectedShapeId = hit.id;
          drag = {
            kind: 'move',
            shapeId: hit.id,
            offX: wp.x - hit.cx,
            offY: wp.y - hit.cy,
          };
          renderForm();
        } else {
          selectedShapeId = null;
          renderForm();
        }
        return;
      }

      const x = snap ? Math.round(wp.x / 8) * 8 : wp.x;
      const y = snap ? Math.round(wp.y / 8) * 8 : wp.y;
      // Objectives are click-to-place circles with a fixed default diameter
      // (1 unit-distance). Editing the radius after placement happens via the
      // Select tool's drag handles — keeps the drawing flow trivial.
      if (isCircleTool(activeTool)) {
        pushHistory();
        const id = nextShapeId(doc, activeTool);
        const radius = OBJECTIVE_DEFAULT_DIAMETER;
        const s: DraftShape = {
          id,
          tool: activeTool,
          cx: x,
          cy: y,
          w: radius,
          h: radius,
          angle: 0,
        };
        doc = { ...doc, shapes: [...doc.shapes, s] };
        addMirrorTwins(s);
        selectedShapeId = id;
        drag = null;
        renderForm();
        return;
      }
      // Drag-create: snapshot at start. If the user drags below MIN_RECT and
      // the shape is discarded in pointerup, we'll have a no-op snapshot —
      // an empty undo step. Acceptable: the cost is one Ctrl+Z press.
      pushHistory();
      drag = { kind: 'create', tool: activeTool, x0: x, y0: y, x1: x, y1: y };
      redraw();
    };

    const onPointerMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const wp = toWorld(px, py);

      if (!drag) return;

      if (drag.kind === 'pan') {
        viewOffsetX = drag.startOffX + (px - drag.startX);
        viewOffsetY = drag.startOffY + (py - drag.startY);
        redraw();
        return;
      }

      if (drag.kind === 'create') {
        let nx = wp.x;
        let ny = wp.y;
        if (snap) {
          nx = Math.round(nx / 8) * 8;
          ny = Math.round(ny / 8) * 8;
        }
        drag.x1 = clamp(nx, 0, doc.size);
        drag.y1 = clamp(ny, 0, doc.size);
        redraw();
        return;
      }
      if (drag.kind === 'move') {
        const moveDrag = drag;
        const idx = doc.shapes.findIndex((s) => s.id === moveDrag.shapeId);
        if (idx < 0) return;
        const s = doc.shapes[idx]!;
        let cx = wp.x - moveDrag.offX;
        let cy = wp.y - moveDrag.offY;
        if (snap) {
          cx = Math.round(cx / 4) * 4;
          cy = Math.round(cy / 4) * 4;
        }
        const next = [...doc.shapes];
        next[idx] = { ...s, cx, cy };
        doc = { ...doc, shapes: next };
        propagatePatchToTwin(s.id, { cx, cy });
        redraw();
        renderInfo();
        return;
      }
      if (drag.kind === 'rotate') {
        const rotDrag = drag;
        const idx = doc.shapes.findIndex((s) => s.id === rotDrag.shapeId);
        if (idx < 0) return;
        const s = doc.shapes[idx]!;
        const ang = Math.atan2(wp.y - s.cy, wp.x - s.cx) + Math.PI / 2;
        const snappedAng = snap ? Math.round(ang / (Math.PI / 12)) * (Math.PI / 12) : ang;
        const next = [...doc.shapes];
        next[idx] = { ...s, angle: snappedAng };
        doc = { ...doc, shapes: next };
        propagatePatchToTwin(s.id, { angle: snappedAng });
        redraw();
        renderInfo();
        return;
      }
    };

    const onPointerUp = (e: PointerEvent): void => {
      canvas.releasePointerCapture(e.pointerId);
      if (drag && drag.kind === 'create') {
        const x = Math.min(drag.x0, drag.x1);
        const y = Math.min(drag.y0, drag.y1);
        const w = Math.abs(drag.x1 - drag.x0);
        const h = Math.abs(drag.y1 - drag.y0);
        if (w >= MIN_RECT && h >= MIN_RECT) {
          const id = nextShapeId(doc, drag.tool);
          const s: DraftShape = {
            id,
            tool: drag.tool,
            cx: x + w / 2,
            cy: y + h / 2,
            w,
            h,
            angle: 0,
          };
          doc = { ...doc, shapes: [...doc.shapes, s] };
          addMirrorTwins(s);
          selectedShapeId = id;
        }
      }
      const wasPan = drag?.kind === 'pan';
      drag = null;
      if (wasPan) {
        canvas.style.cursor = spaceHeld
          ? 'grab'
          : activeTool === 'select'
            ? 'default'
            : 'crosshair';
        redraw();
      } else {
        renderForm();
      }
    };

    // Wheel zoom — anchored at cursor so the world point under the pointer
    // stays put. Bounded by MIN/MAX_VIEW_SCALE.
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const before = toWorld(px, py);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.max(
        MIN_VIEW_SCALE,
        Math.min(MAX_VIEW_SCALE, viewScale * factor),
      );
      if (next === viewScale) return;
      viewScale = next;
      // Anchor: re-derive offset so `before` stays under (px, py).
      const s = effScale();
      viewOffsetX = px - before.x * s;
      viewOffsetY = py - before.y * s;
      redraw();
    };

    // Right-click context menu would interfere with right-button pan; drop it.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointercancel', onPointerUp);

    // Info / shape inspector — floats inside canvasWrap so it can dock
    // next to the selected shape (or sit at the bottom-left of the canvas
    // when nothing is selected).
    const info = el('div', {
      style: {
        position: 'absolute',
        fontSize: '12px',
        color: '#9aa89a',
        background: 'rgba(14, 18, 14, 0.92)',
        border: '1px solid #2a3a2a',
        borderRadius: '4px',
        padding: '6px 8px',
        pointerEvents: 'auto',
        maxWidth: '440px',
        zIndex: '10',
        boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)',
      },
    });
    // Stop pointer events from bubbling to canvas (otherwise clicking inside
    // the panel would deselect or initiate a drag-create).
    for (const ev of ['pointerdown', 'pointerup', 'wheel', 'click'] as const) {
      info.addEventListener(ev, (e) => e.stopPropagation());
    }

    // Place the floating panel near the selected shape's screen-space AABB,
    // clamped to the canvas viewport. When nothing is selected, dock it at
    // the bottom-left of the canvas as a passive hint.
    const positionInfoPanel = (): void => {
      const EDGE_PAD = 8;
      const SHAPE_GAP = 18;
      if (!selectedShapeId) {
        info.style.left = `${EDGE_PAD}px`;
        info.style.top = '';
        info.style.bottom = `${EDGE_PAD}px`;
        return;
      }
      const s = doc.shapes.find((x) => x.id === selectedShapeId);
      if (!s) return;
      const verts = shapeVertices(s);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of verts) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
      }
      const sc = effScale();
      const sxMin = minX * sc + viewOffsetX;
      const syMin = minY * sc + viewOffsetY;
      const sxMax = maxX * sc + viewOffsetX;
      const pw = info.offsetWidth || 240;
      const ph = info.offsetHeight || 80;
      // Try to the right of the shape; flip to the left if it overflows.
      let left = sxMax + SHAPE_GAP;
      if (left + pw > canvasSide - EDGE_PAD) left = sxMin - SHAPE_GAP - pw;
      // Align top with the shape, but clamp to canvas viewport.
      let top = syMin;
      if (top + ph > canvasSide - EDGE_PAD) top = canvasSide - EDGE_PAD - ph;
      if (top < EDGE_PAD) top = EDGE_PAD;
      // If neither side fits horizontally, fall back to clamped overlay.
      if (left < EDGE_PAD) left = EDGE_PAD;
      if (left + pw > canvasSide - EDGE_PAD) {
        left = Math.max(EDGE_PAD, canvasSide - EDGE_PAD - pw);
      }
      info.style.left = `${left}px`;
      info.style.top = `${top}px`;
      info.style.bottom = '';
    };

    const renderInfo = (): void => {
      info.innerHTML = '';
      if (!selectedShapeId) {
        info.textContent =
          activeTool === 'select'
            ? 'Click a shape to select. Drag to move. Drag the dot above to rotate.'
            : `Drag on the canvas to draw a ${TOOL_LABEL[activeTool]} rectangle.`;
        redraw();
        return;
      }
      const s = doc.shapes.find((x) => x.id === selectedShapeId);
      if (!s) {
        selectedShapeId = null;
        renderInfo();
        return;
      }
      const header = el('div', {
        text: `${editorToolLabel(s.tool)} · ${s.id}`,
        style: { color: '#cfe8cf', marginBottom: '6px' },
      });
      info.appendChild(header);

      const gridStyle = {
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto 1fr',
        gap: '4px 8px',
        alignItems: 'center',
        maxWidth: '420px',
      };
      const mainGrid = el('div', { style: gridStyle });
      const coordGrid = el('div', {
        style: { ...gridStyle, marginTop: '4px',
          display: coordsExpanded ? 'grid' : 'none' },
      });

      const numField = (
        target: HTMLElement,
        label: string,
        value: number,
        step: number,
        onChange: (v: number) => void,
        suffix = '英吋',
      ): void => {
        target.appendChild(
          el('label', { text: label, style: { fontSize: '11px' } }),
        );
        const wrap = el('div', {
          style: { display: 'flex', alignItems: 'center', gap: '3px' },
        });
        const input = el('input', {
          type: 'number',
          value: value.toFixed(2),
          style: { width: '70px', fontSize: '11px', padding: '2px 4px' },
          onchange: (e) => {
            const n = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(n)) onChange(n);
          },
        }) as HTMLInputElement;
        input.step = String(step);
        wrap.appendChild(input);
        wrap.appendChild(
          el('span', {
            text: suffix,
            style: { fontSize: '10px', color: '#7a9a7a' },
          }),
        );
        target.appendChild(wrap);
      };

      const inches = (px: number): number => px / PX_PER_INCH;
      const updateShape = (patch: Partial<EditorMapShape>): void => {
        const idx = doc.shapes.findIndex((x) => x.id === s.id);
        if (idx < 0) return;
        pushHistory();
        const next = [...doc.shapes];
        next[idx] = { ...s, ...patch };
        doc = { ...doc, shapes: next };
        propagatePatchToTwin(s.id, patch);
        renderForm();
      };

      numField(mainGrid, 'w', inches(s.w), 0.05, (v) =>
        updateShape({ w: Math.max(MIN_RECT / PX_PER_INCH, v) * PX_PER_INCH }),
      );
      numField(
        mainGrid,
        isCircleTool(s.tool) ? 'h (=w)' : 'h',
        inches(s.h),
        0.05,
        (v) =>
          updateShape({ h: Math.max(MIN_RECT / PX_PER_INCH, v) * PX_PER_INCH }),
      );
      numField(
        mainGrid,
        'angle',
        (s.angle * 180) / Math.PI,
        1,
        (v) => updateShape({ angle: (v * Math.PI) / 180 }),
        '°',
      );

      info.appendChild(mainGrid);

      // Collapsible coordinates section — rarely tweaked by hand since
      // the shape can be dragged on the canvas.
      const coordToggle = el('button', {
        text: `${coordsExpanded ? '▾' : '▸'} 座標 (cx, cy)`,
        style: {
          marginTop: '6px',
          fontSize: '11px',
          color: '#9aa89a',
          background: 'transparent',
          border: 'none',
          padding: '2px 0',
          cursor: 'pointer',
          textAlign: 'left',
        },
        onclick: () => {
          coordsExpanded = !coordsExpanded;
          coordGrid.style.display = coordsExpanded ? 'grid' : 'none';
          coordToggle.textContent = `${coordsExpanded ? '▾' : '▸'} 座標 (cx, cy)`;
          positionInfoPanel();
        },
      });
      info.appendChild(coordToggle);
      numField(coordGrid, 'cx', inches(s.cx), 0.05, (v) =>
        updateShape({ cx: v * PX_PER_INCH }),
      );
      numField(coordGrid, 'cy', inches(s.cy), 0.05, (v) =>
        updateShape({ cy: v * PX_PER_INCH }),
      );
      info.appendChild(coordGrid);

      // Action buttons row — moved here from the left toolbar so they sit
      // next to the thing they act on.
      const actionRow = el('div', {
        style: {
          display: 'flex',
          gap: '4px',
          marginTop: '8px',
          flexWrap: 'wrap',
        },
      });
      const actionBtnStyle = { fontSize: '11px', padding: '3px 8px' };
      actionRow.appendChild(
        el('button', {
          text: '↺ −15°',
          style: actionBtnStyle,
          onclick: () => rotateSelected(-Math.PI / 12),
        }),
      );
      actionRow.appendChild(
        el('button', {
          text: '↻ +15°',
          style: actionBtnStyle,
          onclick: () => rotateSelected(Math.PI / 12),
        }),
      );
      actionRow.appendChild(
        el('button', {
          text: '複製 (Ctrl+D)',
          style: actionBtnStyle,
          onclick: () => duplicateSelected(),
        }),
      );
      actionRow.appendChild(
        el('button', {
          text: '刪除',
          style: actionBtnStyle,
          onclick: () => deleteSelected(),
        }),
      );
      info.appendChild(actionRow);

      // Zone A only: slot-order controls. Strict-serial invariant
      // means there's no manual number entry — only swap-with-neighbor.
      if (s.tool === 'zone-a') {
        const slotCount = doc.shapes.filter((x) => x.tool === 'zone-a').length;
        const cur = s.slotIndex ?? 0;
        const slotRow = el('div', {
          style: {
            display: 'flex',
            gap: '4px',
            marginTop: '6px',
            alignItems: 'center',
          },
        });
        slotRow.appendChild(
          el('span', {
            text: `部署位 #${cur} / ${slotCount}`,
            style: { fontSize: '11px', color: '#9af09a', marginRight: '4px' },
          }),
        );
        const upBtn = el('button', {
          text: '↑ 上移',
          style: actionBtnStyle,
          onclick: () => {
            pushHistory();
            doc = { ...doc, shapes: moveZoneASlot(doc.shapes, s.id, 'up') };
            renderForm();
          },
        }) as HTMLButtonElement;
        upBtn.disabled = cur <= 1;
        const downBtn = el('button', {
          text: '↓ 下移',
          style: actionBtnStyle,
          onclick: () => {
            pushHistory();
            doc = { ...doc, shapes: moveZoneASlot(doc.shapes, s.id, 'down') };
            renderForm();
          },
        }) as HTMLButtonElement;
        downBtn.disabled = cur >= slotCount;
        slotRow.appendChild(upBtn);
        slotRow.appendChild(downBtn);
        info.appendChild(slotRow);
      }

      redraw();
    };

    // ─── Top bar: id / name / size + save actions ─────────────────
    const topBar = el('div', { className: 'map-top-bar' });
    const labelStyle = { fontSize: '11px', color: '#9aa89a' };
    const inlineGroup = (): HTMLElement =>
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });

    const idGroup = inlineGroup();
    idGroup.appendChild(el('label', { text: 'ID', style: labelStyle }));
    const idInput = el('input', {
      type: 'text',
      value: doc.id,
      style: { width: '110px', fontSize: '12px', padding: '3px 6px' },
      oninput: (e) => {
        doc = { ...doc, id: (e.target as HTMLInputElement).value.trim() };
      },
    });
    idGroup.appendChild(idInput);
    topBar.appendChild(idGroup);

    const nameGroup = inlineGroup();
    nameGroup.appendChild(el('label', { text: 'Name', style: labelStyle }));
    const nameInput = el('input', {
      type: 'text',
      value: doc.displayName,
      style: { width: '180px', fontSize: '12px', padding: '3px 6px' },
      oninput: (e) => {
        doc = {
          ...doc,
          displayName: (e.target as HTMLInputElement).value,
        };
      },
    });
    nameGroup.appendChild(nameInput);
    topBar.appendChild(nameGroup);

    const sizeGroup = inlineGroup();
    sizeGroup.appendChild(el('label', { text: 'Size', style: labelStyle }));
    const sizeInput = el('input', {
      type: 'number',
      value: (doc.size / PX_PER_INCH).toFixed(0),
      style: { width: '54px', fontSize: '12px', padding: '3px 6px' },
      onchange: (e) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (!Number.isFinite(n)) return;
        const clamped = Math.max(
          MIN_MAP_INCHES,
          Math.min(MAX_MAP_INCHES, Math.round(n)),
        );
        const newPx = clamped * PX_PER_INCH;
        if (newPx === doc.size) return;
        pushHistory();
        doc = { ...doc, size: newPx };
        renderForm();
      },
    }) as HTMLInputElement;
    sizeInput.min = String(MIN_MAP_INCHES);
    sizeInput.max = String(MAX_MAP_INCHES);
    sizeInput.step = '1';
    sizeInput.title = `1 UD = 3 英吋；1 英吋 = ${PX_PER_INCH}px。越界形狀仍會保留，但遊戲中不 render`;
    sizeGroup.appendChild(sizeInput);
    sizeGroup.appendChild(
      el('span', { text: '英吋', style: labelStyle }),
    );
    topBar.appendChild(sizeGroup);

    topBar.appendChild(el('div', { style: { flex: '1' } }));

    topBar.appendChild(
      el('button', {
        text: 'Save',
        onclick: () => {
          if (!doc.id || !doc.displayName) {
            alert('Map needs an ID and a display name.');
            return;
          }
          if (doc.id === 'demo') {
            alert('Cannot overwrite the bundled "demo" map. Use a different ID.');
            return;
          }
          upsertCustomMap(toEditorDoc(doc));
          refresh();
        },
      }),
    );

    topBar.appendChild(
      el('button', {
        text: 'Save as new…',
        onclick: () => {
          const newId = prompt('New map ID:', uniqueId(doc.id || 'my-map'));
          if (!newId) return;
          const newName = prompt('Display name:', doc.displayName + ' (copy)');
          if (!newName) return;
          const next: EditorMapDoc = { ...doc, id: newId, displayName: newName };
          upsertCustomMap(toEditorDoc(next));
          doc = cloneDoc(next);
          refresh();
        },
      }),
    );

    const customs = loadCustomMaps();
    const isCustom = customs.some((d) => d.id === doc.id);
    if (isCustom) {
      const deleteBtn = el('button', {
        text: 'Delete saved',
        onclick: () => {
          if (!confirm(`Delete saved map "${doc.id}"?`)) return;
          removeCustomMap(doc.id);
          doc = newDoc();
          selectedShapeId = null;
          refresh();
        },
      });
      deleteBtn.classList.add('danger');
      topBar.appendChild(deleteBtn);
    }

    topBar.appendChild(
      el('button', {
        text: 'Validate',
        onclick: () => {
          const issues = validateDoc(doc);
          if (issues.length === 0) {
            alert(
              'Map looks good. ✓\n\nThe game battle screen needs at least one Zone A and one Zone B for deployment.',
            );
          } else {
            alert('Issues:\n\n• ' + issues.join('\n• '));
          }
        },
      }),
    );

    if (import.meta.env.DEV && !hideServerActions) {
      const saveToBundleBtn = el('button', {
        text: '⤒ Save to bundle',
        onclick: async () => {
          if (!doc.id) {
            alert('Map needs an ID first.');
            return;
          }
          try {
            const mapDef = docToMapDef(doc);
            const result = await saveToBundleEndpoint('map', doc.id, mapDef);
            alert(
              `Saved to ${result.path}\n\nThe JSON file is now part of the bundle. Commit it to make it permanent.`,
            );
          } catch (e) {
            alert(`Save to bundle failed: ${(e as Error).message}`);
          }
        },
      }) as HTMLButtonElement;
      saveToBundleBtn.title =
        'Write to src/config/maps/<id>.json (dev server only)';
      topBar.appendChild(saveToBundleBtn);
    }

    formPanel.appendChild(topBar);

    // ─── Body: left tool column + right canvas/info area ──────────
    const body = el('div', { className: 'map-body' });

    const tools = el('div', { className: 'map-tools' });
    const sep = (): HTMLElement => el('div', { className: 'sep' });

    for (const t of TOOL_ORDER) {
      const btn = el('button', {
        text: TOOL_LABEL[t],
        onclick: () => {
          activeTool = t;
          renderForm();
        },
      }) as HTMLButtonElement;
      if (t === activeTool) btn.style.background = '#2a4a2a';
      tools.appendChild(btn);
    }

    tools.appendChild(sep());
    tools.appendChild(
      el('button', {
        text: '翻轉 ↔ (整張)',
        onclick: () => mirrorMap('h'),
      }),
    );
    tools.appendChild(
      el('button', {
        text: '翻轉 ↕ (整張)',
        onclick: () => mirrorMap('v'),
      }),
    );

    const mirrorH = el('button', {
      text: mirrorAxes.has('h') ? '✓ 鏡像 ↔' : '鏡像 ↔',
      onclick: () => {
        if (mirrorAxes.has('h')) mirrorAxes.delete('h');
        else mirrorAxes.add('h');
        renderForm();
      },
    }) as HTMLButtonElement;
    mirrorH.title =
      '開啟後，新增/編輯/刪除形狀會自動同步到水平鏡像的另一邊。可與垂直鏡像同時啟用，新增形狀時會一次產生四象限的對稱複本。';
    if (mirrorAxes.has('h')) mirrorH.style.background = '#2a4a2a';
    tools.appendChild(mirrorH);

    const mirrorV = el('button', {
      text: mirrorAxes.has('v') ? '✓ 鏡像 ↕' : '鏡像 ↕',
      onclick: () => {
        if (mirrorAxes.has('v')) mirrorAxes.delete('v');
        else mirrorAxes.add('v');
        renderForm();
      },
    }) as HTMLButtonElement;
    mirrorV.title =
      '開啟後，新增/編輯/刪除形狀會自動同步到垂直鏡像的另一邊。可與水平鏡像同時啟用，新增形狀時會一次產生四象限的對稱複本。';
    if (mirrorAxes.has('v')) mirrorV.style.background = '#2a4a2a';
    tools.appendChild(mirrorV);

    tools.appendChild(sep());

    const snapLabel = el('label', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        color: '#9aa89a',
        padding: '4px 4px',
      },
    });
    const snapBox = el('input', {
      type: 'checkbox',
      checked: snap,
      onchange: () => {
        snap = (snapBox as HTMLInputElement).checked;
      },
    });
    snapLabel.appendChild(snapBox);
    snapLabel.appendChild(document.createTextNode('Snap 8px'));
    tools.appendChild(snapLabel);

    tools.appendChild(sep());
    const zoomRow = el('div', { style: { display: 'flex', gap: '4px' } });
    const zoomOutBtn = el('button', {
      text: '−',
      onclick: () => zoomAt(1 / 1.25),
      style: { flex: '1', textAlign: 'center' },
    }) as HTMLButtonElement;
    zoomOutBtn.title = '縮小（也可滑鼠滾輪向下）';
    zoomRow.appendChild(zoomOutBtn);
    const zoomInBtn = el('button', {
      text: '+',
      onclick: () => zoomAt(1.25),
      style: { flex: '1', textAlign: 'center' },
    }) as HTMLButtonElement;
    zoomInBtn.title = '放大（也可滑鼠滾輪向上）';
    zoomRow.appendChild(zoomInBtn);
    tools.appendChild(zoomRow);
    const resetViewBtn = el('button', {
      text: '重設視角',
      onclick: () => {
        resetView();
        redraw();
      },
    }) as HTMLButtonElement;
    resetViewBtn.title =
      '回到 1:1 並置中。拖曳：按住中鍵或空白鍵 + 左鍵；右鍵也可拖曳。';
    tools.appendChild(resetViewBtn);

    body.appendChild(tools);

    const mainCol = el('div', { className: 'map-main' });
    const canvasWrap = el('div', { className: 'map-canvas-wrap' });
    canvasWrap.appendChild(canvas);
    canvasWrap.appendChild(info);
    mainCol.appendChild(canvasWrap);
    body.appendChild(mainCol);

    formPanel.appendChild(body);

    // Dynamic canvas sizing — fits the available area in canvasWrap, capped
    // by viewport height so it stays square + visible without page scroll.
    const sizeCanvas = (): void => {
      const r = canvasWrap.getBoundingClientRect();
      if (r.width <= 0) return;
      const maxByHeight = window.innerHeight - 200;
      const desired = Math.max(
        320,
        Math.floor(Math.min(r.width, maxByHeight)),
      );
      if (desired === canvasSide) return;
      canvasSide = desired;
      canvas.width = canvasSide;
      canvas.height = canvasSide;
      redraw();
    };
    const ro = new ResizeObserver(sizeCanvas);
    ro.observe(canvasWrap);
    requestAnimationFrame(sizeCanvas);

    redraw();
    renderInfo();
  };

  const refresh = (): void => {
    renderList();
    renderForm();
  };

  const rotateSelected = (delta: number): void => {
    if (!selectedShapeId) return;
    const idx = doc.shapes.findIndex((s) => s.id === selectedShapeId);
    if (idx < 0) return;
    pushHistory();
    const s = doc.shapes[idx]!;
    const newAngle = s.angle + delta;
    const next = [...doc.shapes];
    next[idx] = { ...s, angle: newAngle };
    doc = { ...doc, shapes: next };
    propagatePatchToTwin(s.id, { angle: newAngle });
    renderForm();
  };

  const deleteSelected = (): void => {
    if (!selectedShapeId) return;
    pushHistory();
    const id = selectedShapeId;
    // Whole mirror group goes together — including any twins-of-twins linked
    // when both axes are active (group size up to 4).
    const removeIds = new Set<string>([id]);
    const linked = mirrorGroups.get(id);
    if (linked) for (const o of linked.keys()) removeIds.add(o);
    doc = {
      ...doc,
      shapes: doc.shapes.filter((s) => !removeIds.has(s.id)),
    };
    for (const rid of removeIds) unlinkAll(rid);
    selectedShapeId = null;
    renderForm();
  };

  const duplicateSelected = (): void => {
    if (!selectedShapeId) return;
    const src = doc.shapes.find((s) => s.id === selectedShapeId);
    if (!src) return;
    pushHistory();
    const newId = nextShapeId(doc, src.tool);
    const copy: EditorMapShape = {
      ...src,
      id: newId,
      cx: src.cx + DUPLICATE_OFFSET_PX,
      cy: src.cy + DUPLICATE_OFFSET_PX,
    };
    doc = { ...doc, shapes: [...doc.shapes, copy] };
    addMirrorTwins(copy);
    selectedShapeId = newId;
    renderForm();
  };

  /** Copy selected shape to the in-editor clipboard (no OS clipboard touch). */
  const copySelected = (): void => {
    if (!selectedShapeId) return;
    const src = doc.shapes.find((s) => s.id === selectedShapeId);
    if (!src) return;
    clipboard = { ...src };
    pasteCounter = 0;
  };

  const cutSelected = (): void => {
    if (!selectedShapeId) return;
    const src = doc.shapes.find((s) => s.id === selectedShapeId);
    if (!src) return;
    clipboard = { ...src };
    pasteCounter = 0;
    // deleteSelected pushes its own history step.
    deleteSelected();
  };

  /**
   * Paste clipboard at an offset so successive pastes don't pile up. The
   * paste participates in the active mirror configuration just like a
   * fresh draw — pasting with both mirror axes on creates the full quad.
   */
  const pasteClipboard = (): void => {
    if (!clipboard) return;
    pushHistory();
    pasteCounter += 1;
    const off = DUPLICATE_OFFSET_PX * pasteCounter;
    const newId = nextShapeId(doc, clipboard.tool);
    const copy: EditorMapShape = {
      ...clipboard,
      id: newId,
      cx: clipboard.cx + off,
      cy: clipboard.cy + off,
    };
    doc = { ...doc, shapes: [...doc.shapes, copy] };
    addMirrorTwins(copy);
    selectedShapeId = newId;
    renderForm();
  };

  /**
   * Mirror every shape across the map's centre axis. Reflecting a rotated
   * rectangle around either axis is equivalent to negating its angle (the
   * rectangle stays rectangular, just mirrored).
   */
  const mirrorMap = (axis: 'h' | 'v'): void => {
    pushHistory();
    const next = doc.shapes.map((s) => {
      if (axis === 'h') {
        return { ...s, cx: doc.size - s.cx, angle: -s.angle };
      }
      return { ...s, cy: doc.size - s.cy, angle: -s.angle };
    });
    doc = { ...doc, shapes: next };
    renderForm();
  };

  const keyHandler = (e: KeyboardEvent): void => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (e.key === ' ' && !spaceHeld) {
      // Photoshop-style: hold space to pan with left mouse.
      e.preventDefault();
      spaceHeld = true;
      const c = formPanel.querySelector('canvas') as HTMLCanvasElement | null;
      if (c) c.style.cursor = 'grab';
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedShapeId) {
        e.preventDefault();
        deleteSelected();
      }
    } else if (mod && (e.key === 'd' || e.key === 'D')) {
      if (selectedShapeId) {
        e.preventDefault();
        duplicateSelected();
      }
    } else if (mod && (e.key === 'c' || e.key === 'C')) {
      if (selectedShapeId) {
        e.preventDefault();
        copySelected();
      }
    } else if (mod && (e.key === 'x' || e.key === 'X')) {
      if (selectedShapeId) {
        e.preventDefault();
        cutSelected();
      }
    } else if (mod && (e.key === 'v' || e.key === 'V')) {
      if (clipboard) {
        e.preventDefault();
        pasteClipboard();
      }
    } else if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      // Ctrl+Shift+Z is the Mac/web idiom for redo. Handle before plain
      // Ctrl+Z so the shift modifier doesn't accidentally trigger undo.
      e.preventDefault();
      redo();
    } else if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
    } else if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo();
    } else if (e.key === 'Escape') {
      selectedShapeId = null;
      renderForm();
    }
  };
  const keyUpHandler = (e: KeyboardEvent): void => {
    if (e.key === ' ' && spaceHeld) {
      spaceHeld = false;
      const c = formPanel.querySelector('canvas') as HTMLCanvasElement | null;
      if (c) {
        c.style.cursor = activeTool === 'select' ? 'default' : 'crosshair';
      }
    }
  };
  document.addEventListener('keydown', keyHandler);
  document.addEventListener('keyup', keyUpHandler);

  // Cleanup when the editor is unmounted (handled by index.ts wiping innerHTML).
  // Use a MutationObserver for robust cleanup of the keydown listener.
  const observer = new MutationObserver(() => {
    if (!root.contains(grid)) {
      document.removeEventListener('keydown', keyHandler);
      document.removeEventListener('keyup', keyUpHandler);
      observer.disconnect();
    }
  });
  observer.observe(root, { childList: true });

  grid.appendChild(listPanel);
  grid.appendChild(formPanel);
  root.appendChild(grid);
  refresh();
};

// --- helpers ---------------------------------------------------------------

const newDoc = (): EditorMapDoc => ({
  id: 'my-map',
  displayName: 'Untitled Map',
  size: DEFAULT_SIZE,
  shapes: [],
});

const cloneDoc = (d: EditorMapDoc): EditorMapDoc => ({
  ...d,
  shapes: d.shapes.map((s) => ({ ...s })),
});

const toEditorDoc = (d: EditorMapDoc): EditorMapDoc => ({
  id: d.id,
  displayName: d.displayName,
  size: d.size,
  shapes: d.shapes.map((s) => ({ ...s })),
});

const nextShapeId = (doc: EditorMapDoc, tool: EditorShapeTool): string => {
  const used = new Set(doc.shapes.map((s) => s.id));
  let i = 1;
  while (used.has(`${tool}-${i}`)) i += 1;
  return `${tool}-${i}`;
};

const uniqueId = (base: string): string => {
  const customs = loadCustomMaps();
  const used = new Set([...customs.map((d) => d.id), 'demo']);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
};

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const pointInShape = (
  p: { x: number; y: number },
  s: EditorMapShape,
): boolean => {
  if (isCircleTool(s.tool)) {
    const dx = p.x - s.cx;
    const dy = p.y - s.cy;
    const r = Math.max(s.w, s.h) / 2;
    return dx * dx + dy * dy <= r * r;
  }
  const dx = p.x - s.cx;
  const dy = p.y - s.cy;
  const cs = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  const lx = dx * cs + dy * sn;
  const ly = -dx * sn + dy * cs;
  return Math.abs(lx) <= s.w / 2 && Math.abs(ly) <= s.h / 2;
};

const drawShape = (
  ctx: CanvasRenderingContext2D,
  s: EditorMapShape,
  selected: boolean,
  scale: number,
): void => {
  if (isCircleTool(s.tool)) {
    drawObjective(ctx, s, selected, scale);
    return;
  }
  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.rotate(s.angle);
  ctx.fillStyle = TOOL_FILL[s.tool];
  ctx.strokeStyle = selected ? '#9af09a' : TOOL_STROKE[s.tool];
  ctx.lineWidth = (selected ? 2 : 1.2) / scale;
  ctx.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
  ctx.strokeRect(-s.w / 2, -s.h / 2, s.w, s.h);

  // Hatching for difficult terrain (visual hint — clipped to the rect so it
  // never reads as if the judgement area extends outside the box).
  if (s.tool === 'difficult') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-s.w / 2, -s.h / 2, s.w, s.h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(184, 136, 74, 0.55)';
    ctx.lineWidth = 0.8 / scale;
    const step = 10;
    ctx.beginPath();
    for (let off = -s.h; off < s.w + s.h; off += step) {
      ctx.moveTo(-s.w / 2 + off, -s.h / 2);
      ctx.lineTo(-s.w / 2 + off - s.h, s.h / 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Selection: rotation handle line + dot
  if (selected) {
    ctx.beginPath();
    ctx.moveTo(0, -s.h / 2);
    ctx.lineTo(0, -s.h / 2 - 18);
    ctx.strokeStyle = '#9af09a';
    ctx.lineWidth = 1.2 / scale;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -s.h / 2 - 18, 5 / scale, 0, Math.PI * 2);
    ctx.fillStyle = '#9af09a';
    ctx.fill();
  }
  ctx.restore();

  // Label at the centroid (un-rotated text)
  ctx.save();
  const verts = shapeVertices(s);
  const cx = verts.reduce((a, v) => a + v.x, 0) / verts.length;
  const cy = verts.reduce((a, v) => a + v.y, 0) / verts.length;
  ctx.fillStyle = 'rgba(207, 232, 207, 0.7)';
  ctx.font = `${10 / scale}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Zone A shapes get a big slot-number badge above the kind label so the
  // designer can see the strict-serial order at a glance. Falls back to
  // "?" if the slot wasn't repacked yet (defensive — repack runs every
  // render so this should be unreachable in steady state).
  if (s.tool === 'zone-a' && typeof s.slotIndex === 'number') {
    ctx.fillStyle = '#9af09a';
    ctx.font = `bold ${16 / scale}px ui-monospace, monospace`;
    ctx.fillText(`#${s.slotIndex}`, cx, cy - 11 / scale);
    ctx.fillStyle = 'rgba(207, 232, 207, 0.7)';
    ctx.font = `${10 / scale}px ui-monospace, monospace`;
    ctx.fillText(editorToolLabel(s.tool), cx, cy + 5 / scale);
  } else {
    ctx.fillText(editorToolLabel(s.tool), cx, cy);
  }
  ctx.restore();
};

const drawObjective = (
  ctx: CanvasRenderingContext2D,
  s: EditorMapShape,
  selected: boolean,
  scale: number,
): void => {
  const r = Math.max(s.w, s.h) / 2;
  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.fillStyle = TOOL_FILL.objective;
  ctx.strokeStyle = selected ? '#9af09a' : TOOL_STROKE.objective;
  ctx.lineWidth = (selected ? 2 : 1.5) / scale;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Centre cross-hair
  ctx.strokeStyle = TOOL_STROKE.objective;
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  ctx.moveTo(-r * 0.3, 0);
  ctx.lineTo(r * 0.3, 0);
  ctx.moveTo(0, -r * 0.3);
  ctx.lineTo(0, r * 0.3);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 209, 102, 0.85)';
  ctx.font = `${10 / scale}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(editorToolLabel(s.tool), 0, r + 8);
  ctx.restore();
};

const validateDoc = (doc: EditorMapDoc): string[] => {
  const issues: string[] = [];
  if (!doc.id) issues.push('Map ID is empty.');
  if (!doc.displayName) issues.push('Display name is empty.');
  const hasA = doc.shapes.some((s) => s.tool === 'zone-a');
  const hasB = doc.shapes.some((s) => s.tool === 'zone-b');
  if (!hasA) issues.push('Missing Zone A (faction A deployment area).');
  if (!hasB) issues.push('Missing Zone B (faction B deployment area).');
  // Sanity check that conversion produces a valid MapDef.
  try {
    docToMapDef(doc);
  } catch (e) {
    issues.push(`Conversion error: ${(e as Error).message}`);
  }
  return issues;
};
