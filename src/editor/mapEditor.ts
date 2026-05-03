import {
  docToMapDef,
  mapDefToDoc,
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
/** 1 inch in world pixels — also the unit base diameter / unit-distance. */
const PX_PER_INCH = 96;
const DEFAULT_SIZE = 8 * PX_PER_INCH;
const MIN_RECT = 8;
/** Min/max map size in inches. 48 supports long-push scenarios. */
const MIN_MAP_INCHES = 4;
const MAX_MAP_INCHES = 48;
/** Click-to-place objectives spawn at this diameter (1 unit-distance). */
const OBJECTIVE_DEFAULT_DIAMETER = 96;
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
  'zone-a': '#6ab0ff',
  'zone-b': '#ff8a6a',
  objective: '#ffd166',
};

/** Objectives are circles, not rotatable rects. */
const isCircleTool = (tool: EditorShapeTool): boolean => tool === 'objective';

export const mountMapEditor = (root: HTMLElement): void => {
  let doc: EditorMapDoc = newDoc();
  let selectedShapeId: string | null = null;
  let activeTool: Tool = 'low';
  let drag: Drag = null;
  let snap = true;
  // Live-mirror mode: when set, every add / edit / delete on a shape gets
  // applied to a paired twin reflected across the chosen axis. Pair links
  // live in editor session only — saved JSON just sees two real shapes.
  let mirrorAxis: 'h' | 'v' | null = null;
  const mirrorPairs = new Map<string, string>();

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
    axis: 'h' | 'v',
  ): EditorMapShape =>
    axis === 'h'
      ? { ...s, id: newId, cx: doc.size - s.cx, angle: -s.angle }
      : { ...s, id: newId, cy: doc.size - s.cy, angle: -s.angle };

  const mirrorPatch = (
    patch: Partial<EditorMapShape>,
    axis: 'h' | 'v',
  ): Partial<EditorMapShape> => {
    const out: { -readonly [K in keyof EditorMapShape]?: EditorMapShape[K] } = {
      ...patch,
    };
    if (axis === 'h' && patch.cx !== undefined) out.cx = doc.size - patch.cx;
    if (axis === 'v' && patch.cy !== undefined) out.cy = doc.size - patch.cy;
    if (patch.angle !== undefined) out.angle = -patch.angle;
    return out;
  };

  const pairTwinId = (id: string): string | null =>
    mirrorPairs.get(id) ?? null;

  const linkPair = (a: string, b: string): void => {
    mirrorPairs.set(a, b);
    mirrorPairs.set(b, a);
  };

  const unlinkPair = (id: string): void => {
    const twin = mirrorPairs.get(id);
    if (twin !== undefined) {
      mirrorPairs.delete(twin);
      mirrorPairs.delete(id);
    }
  };

  /** Add a mirrored twin for a freshly-created shape. No-op when mirror off. */
  const addMirrorTwin = (src: EditorMapShape): void => {
    if (!mirrorAxis) return;
    const twinId = nextShapeId(doc, src.tool);
    const twin = mirroredShape(src, twinId, mirrorAxis);
    doc = { ...doc, shapes: [...doc.shapes, twin] };
    linkPair(src.id, twinId);
  };

  /** Apply a patch to the mirrored twin (if any). No-op when mirror off. */
  const propagatePatchToTwin = (
    sourceId: string,
    patch: Partial<EditorMapShape>,
  ): void => {
    if (!mirrorAxis) return;
    const twinId = pairTwinId(sourceId);
    if (twinId === null) return;
    const idx = doc.shapes.findIndex((x) => x.id === twinId);
    if (idx < 0) return;
    const twin = doc.shapes[idx]!;
    const next = [...doc.shapes];
    next[idx] = { ...twin, ...mirrorPatch(patch, mirrorAxis) };
    doc = { ...doc, shapes: next };
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
              drag = { kind: 'rotate', shapeId: s.id };
              return;
            }
          }
        }
        const hit = findShapeAt(wp.x, wp.y);
        if (hit) {
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
        addMirrorTwin(s);
        selectedShapeId = id;
        drag = null;
        renderForm();
        return;
      }
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
          addMirrorTwin(s);
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

    // Info / shape inspector — appended into mainCol below.
    const info = el('div', {
      style: { marginTop: '10px', fontSize: '12px', color: '#9aa89a' },
    });

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

      const grid = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto 1fr',
          gap: '4px 8px',
          alignItems: 'center',
          maxWidth: '420px',
        },
      });

      const numField = (
        label: string,
        value: number,
        step: number,
        onChange: (v: number) => void,
        suffix = 'in',
      ): void => {
        grid.appendChild(
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
        grid.appendChild(wrap);
      };

      const inches = (px: number): number => px / PX_PER_INCH;
      const updateShape = (patch: Partial<EditorMapShape>): void => {
        const idx = doc.shapes.findIndex((x) => x.id === s.id);
        if (idx < 0) return;
        const next = [...doc.shapes];
        next[idx] = { ...s, ...patch };
        doc = { ...doc, shapes: next };
        propagatePatchToTwin(s.id, patch);
        renderForm();
      };

      numField('cx', inches(s.cx), 0.05, (v) =>
        updateShape({ cx: v * PX_PER_INCH }),
      );
      numField('cy', inches(s.cy), 0.05, (v) =>
        updateShape({ cy: v * PX_PER_INCH }),
      );
      numField('w', inches(s.w), 0.05, (v) =>
        updateShape({ w: Math.max(MIN_RECT / PX_PER_INCH, v) * PX_PER_INCH }),
      );
      numField(isCircleTool(s.tool) ? 'h (=w)' : 'h', inches(s.h), 0.05, (v) =>
        updateShape({ h: Math.max(MIN_RECT / PX_PER_INCH, v) * PX_PER_INCH }),
      );
      numField(
        'angle',
        (s.angle * 180) / Math.PI,
        1,
        (v) => updateShape({ angle: (v * Math.PI) / 180 }),
        '°',
      );

      info.appendChild(grid);
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
        doc = { ...doc, size: newPx };
        renderForm();
      },
    }) as HTMLInputElement;
    sizeInput.min = String(MIN_MAP_INCHES);
    sizeInput.max = String(MAX_MAP_INCHES);
    sizeInput.step = '1';
    sizeInput.title = `1 inch = ${PX_PER_INCH}px。越界形狀仍會保留，但遊戲中不 render`;
    sizeGroup.appendChild(sizeInput);
    sizeGroup.appendChild(
      el('span', { text: 'in', style: labelStyle }),
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

    if (import.meta.env.DEV) {
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
        text: 'Rotate −15°',
        onclick: () => rotateSelected(-Math.PI / 12),
      }),
    );
    tools.appendChild(
      el('button', {
        text: 'Rotate +15°',
        onclick: () => rotateSelected(Math.PI / 12),
      }),
    );
    tools.appendChild(
      el('button', {
        text: 'Duplicate',
        onclick: () => duplicateSelected(),
      }),
    );
    tools.appendChild(
      el('button', { text: 'Delete', onclick: () => deleteSelected() }),
    );

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
      text: mirrorAxis === 'h' ? '✓ 鏡像 ↔' : '鏡像 ↔',
      onclick: () => {
        mirrorAxis = mirrorAxis === 'h' ? null : 'h';
        renderForm();
      },
    }) as HTMLButtonElement;
    mirrorH.title =
      '開啟後，新增/編輯/刪除任一邊的形狀會自動同步到水平鏡像的另一邊';
    if (mirrorAxis === 'h') mirrorH.style.background = '#2a4a2a';
    tools.appendChild(mirrorH);

    const mirrorV = el('button', {
      text: mirrorAxis === 'v' ? '✓ 鏡像 ↕' : '鏡像 ↕',
      onclick: () => {
        mirrorAxis = mirrorAxis === 'v' ? null : 'v';
        renderForm();
      },
    }) as HTMLButtonElement;
    mirrorV.title =
      '開啟後，新增/編輯/刪除任一邊的形狀會自動同步到垂直鏡像的另一邊';
    if (mirrorAxis === 'v') mirrorV.style.background = '#2a4a2a';
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
    mainCol.appendChild(canvasWrap);
    mainCol.appendChild(info);
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
    const id = selectedShapeId;
    const twinId = mirrorAxis ? pairTwinId(id) : null;
    const removeIds = new Set<string>([id]);
    if (twinId !== null) removeIds.add(twinId);
    doc = {
      ...doc,
      shapes: doc.shapes.filter((s) => !removeIds.has(s.id)),
    };
    unlinkPair(id);
    selectedShapeId = null;
    renderForm();
  };

  const duplicateSelected = (): void => {
    if (!selectedShapeId) return;
    const src = doc.shapes.find((s) => s.id === selectedShapeId);
    if (!src) return;
    const newId = nextShapeId(doc, src.tool);
    const copy: EditorMapShape = {
      ...src,
      id: newId,
      cx: src.cx + DUPLICATE_OFFSET_PX,
      cy: src.cy + DUPLICATE_OFFSET_PX,
    };
    doc = { ...doc, shapes: [...doc.shapes, copy] };
    selectedShapeId = newId;
    renderForm();
  };

  /**
   * Mirror every shape across the map's centre axis. Reflecting a rotated
   * rectangle around either axis is equivalent to negating its angle (the
   * rectangle stays rectangular, just mirrored).
   */
  const mirrorMap = (axis: 'h' | 'v'): void => {
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
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedShapeId) {
        e.preventDefault();
        deleteSelected();
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      if (selectedShapeId) {
        e.preventDefault();
        duplicateSelected();
      }
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
  ctx.fillText(editorToolLabel(s.tool), cx, cy);
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
