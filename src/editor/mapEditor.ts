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
  | null;

const CANVAS_PX = 600;
const DEFAULT_SIZE = 768;
const MIN_RECT = 8;

const TOOL_ORDER: Tool[] = [
  'select',
  'low',
  'high',
  'difficult',
  'soft',
  'zone-a',
  'zone-b',
];

const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select',
  low: 'Low Wall',
  high: 'High Wall',
  difficult: 'Difficult',
  soft: 'Soft (Smoke)',
  'zone-a': 'Zone A',
  'zone-b': 'Zone B',
};

const TOOL_FILL: Record<EditorShapeTool, string> = {
  low: 'rgba(180,180,180,0.55)',
  high: 'rgba(150,150,150,0.85)',
  difficult: 'rgba(160,120,70,0.45)',
  soft: 'rgba(220,220,220,0.25)',
  'zone-a': 'rgba(74,138,207,0.18)',
  'zone-b': 'rgba(207,90,74,0.18)',
};

const TOOL_STROKE: Record<EditorShapeTool, string> = {
  low: '#9aa89a',
  high: '#dcdcdc',
  difficult: '#b8884a',
  soft: '#cfcfcf',
  'zone-a': '#6ab0ff',
  'zone-b': '#ff8a6a',
};

export const mountMapEditor = (root: HTMLElement): void => {
  let doc: EditorMapDoc = newDoc();
  let selectedShapeId: string | null = null;
  let activeTool: Tool = 'low';
  let drag: Drag = null;
  let snap = true;

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

    const toolbar = el('div');
    toolbar.style.display = 'flex';
    toolbar.style.flexWrap = 'wrap';
    toolbar.style.gap = '6px';
    toolbar.style.marginBottom = '12px';

    for (const t of TOOL_ORDER) {
      const btn = el('button', {
        text: TOOL_LABEL[t],
        onclick: () => {
          activeTool = t;
          renderForm();
        },
      });
      if (t === activeTool) btn.style.background = '#2a4a2a';
      btn.style.padding = '4px 10px';
      toolbar.appendChild(btn);
    }

    toolbar.appendChild(el('span', { text: ' | ', style: { color: '#3a5a3a' } }));

    toolbar.appendChild(
      el('button', {
        text: 'Rotate -15°',
        onclick: () => {
          rotateSelected(-Math.PI / 12);
        },
      }),
    );
    toolbar.appendChild(
      el('button', {
        text: 'Rotate +15°',
        onclick: () => {
          rotateSelected(Math.PI / 12);
        },
      }),
    );
    toolbar.appendChild(
      el('button', {
        text: 'Delete',
        onclick: () => {
          deleteSelected();
        },
      }),
    );

    const snapBtn = el('label', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        marginLeft: '8px',
        fontSize: '12px',
        color: '#9aa89a',
      },
    });
    const snapBox = el('input', {
      type: 'checkbox',
      checked: snap,
      onchange: () => {
        snap = (snapBox as HTMLInputElement).checked;
      },
    });
    snapBtn.appendChild(snapBox);
    snapBtn.appendChild(document.createTextNode('Snap 8px'));
    toolbar.appendChild(snapBtn);

    formPanel.appendChild(toolbar);

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_PX;
    canvas.height = CANVAS_PX;
    canvas.style.border = '1px solid #2a3a2a';
    canvas.style.background = '#0e120e';
    canvas.style.cursor = activeTool === 'select' ? 'default' : 'crosshair';
    canvas.style.touchAction = 'none';

    const scale = CANVAS_PX / doc.size;
    const toWorld = (px: number, py: number): { x: number; y: number } => ({
      x: px / scale,
      y: py / scale,
    });

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
      ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
      ctx.save();
      ctx.scale(scale, scale);

      // Background grid
      ctx.fillStyle = '#0e120e';
      ctx.fillRect(0, 0, doc.size, doc.size);
      ctx.strokeStyle = '#1a221a';
      ctx.lineWidth = 1 / scale;
      const step = 96; // 1 unit-distance
      for (let i = 0; i <= doc.size; i += step) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, doc.size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(doc.size, i);
        ctx.stroke();
      }
      // Outer board edge
      ctx.strokeStyle = '#2a3a2a';
      ctx.lineWidth = 2 / scale;
      ctx.strokeRect(0, 0, doc.size, doc.size);

      // Shapes
      for (const s of doc.shapes) {
        drawShape(ctx, s, s.id === selectedShapeId, scale);
      }

      // Active drag preview
      if (drag && drag.kind === 'create') {
        const x = Math.min(drag.x0, drag.x1);
        const y = Math.min(drag.y0, drag.y1);
        const w = Math.abs(drag.x1 - drag.x0);
        const h = Math.abs(drag.y1 - drag.y0);
        ctx.fillStyle = TOOL_FILL[drag.tool];
        ctx.strokeStyle = TOOL_STROKE[drag.tool];
        ctx.lineWidth = 1.5 / scale;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }

      ctx.restore();
    };

    const onPointerDown = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const wp = toWorld(px, py);
      canvas.setPointerCapture(e.pointerId);

      if (activeTool === 'select') {
        // Rotate handle?
        if (selectedShapeId) {
          const s = doc.shapes.find((x) => x.id === selectedShapeId);
          if (s) {
            const h = getRotateHandlePos(s);
            const dx = wp.x - h.x;
            const dy = wp.y - h.y;
            if (dx * dx + dy * dy <= (12 / scale) * (12 / scale)) {
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

      // Drawing tool: start a new rectangle
      const x = snap ? Math.round(wp.x / 8) * 8 : wp.x;
      const y = snap ? Math.round(wp.y / 8) * 8 : wp.y;
      drag = { kind: 'create', tool: activeTool, x0: x, y0: y, x1: x, y1: y };
      redraw();
    };

    const onPointerMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const wp = toWorld(px, py);

      if (!drag) return;

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
          selectedShapeId = id;
        }
      }
      drag = null;
      renderForm();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    formPanel.appendChild(canvas);

    // Info / shape inspector
    const info = el('div', {
      style: { marginTop: '10px', fontSize: '12px', color: '#9aa89a' },
    });
    formPanel.appendChild(info);

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
      const round = (n: number): string => n.toFixed(1);
      info.textContent = `${editorToolLabel(s.tool)} · cx=${round(s.cx)} cy=${round(s.cy)} w=${round(s.w)} h=${round(s.h)} angle=${round((s.angle * 180) / Math.PI)}°`;
      redraw();
    };

    // Doc form (id, displayName, save buttons)
    const formInputs = el('div');
    formInputs.style.marginTop = '14px';
    formInputs.style.borderTop = '1px solid #2a3a2a';
    formInputs.style.paddingTop = '12px';

    const idRow = el('div', { className: 'row' });
    idRow.appendChild(el('label', { text: 'Map ID' }));
    const idInput = el('input', {
      type: 'text',
      value: doc.id,
      oninput: (e) => {
        const v = (e.target as HTMLInputElement).value.trim();
        doc = { ...doc, id: v };
      },
    });
    idRow.appendChild(idInput);
    formInputs.appendChild(idRow);

    const nameRow = el('div', { className: 'row' });
    nameRow.appendChild(el('label', { text: 'Display name' }));
    const nameInput = el('input', {
      type: 'text',
      value: doc.displayName,
      oninput: (e) => {
        doc = {
          ...doc,
          displayName: (e.target as HTMLInputElement).value,
        };
      },
    });
    nameRow.appendChild(nameInput);
    formInputs.appendChild(nameRow);

    const sizeRow = el('div', { className: 'row' });
    sizeRow.appendChild(el('label', { text: 'Battlefield size' }));
    sizeRow.appendChild(
      el('span', {
        text: `${doc.size}px (locked, ${(doc.size / 96).toFixed(0)} unit-distances)`,
        style: { color: '#7a9a7a', fontSize: '12px' },
      }),
    );
    formInputs.appendChild(sizeRow);

    const actions = el('div', { className: 'actions' });
    const saveBtn = el('button', {
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
    });
    actions.appendChild(saveBtn);

    const dupBtn = el('button', {
      text: 'Save as new…',
      onclick: () => {
        const newId = prompt(
          'New map ID:',
          uniqueId(doc.id || 'my-map'),
        );
        if (!newId) return;
        const newName = prompt('Display name:', doc.displayName + ' (copy)');
        if (!newName) return;
        const next: EditorMapDoc = { ...doc, id: newId, displayName: newName };
        upsertCustomMap(toEditorDoc(next));
        doc = cloneDoc(next);
        refresh();
      },
    });
    actions.appendChild(dupBtn);

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
      actions.appendChild(deleteBtn);
    }

    const validateBtn = el('button', {
      text: 'Validate',
      onclick: () => {
        const issues = validateDoc(doc);
        if (issues.length === 0) {
          alert('Map looks good. ✓\n\nThe game battle screen needs at least one Zone A and one Zone B for deployment.');
        } else {
          alert('Issues:\n\n• ' + issues.join('\n• '));
        }
      },
    });
    actions.appendChild(validateBtn);

    formInputs.appendChild(actions);
    formPanel.appendChild(formInputs);

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
    const next = [...doc.shapes];
    next[idx] = { ...s, angle: s.angle + delta };
    doc = { ...doc, shapes: next };
    renderForm();
  };

  const deleteSelected = (): void => {
    if (!selectedShapeId) return;
    doc = {
      ...doc,
      shapes: doc.shapes.filter((s) => s.id !== selectedShapeId),
    };
    selectedShapeId = null;
    renderForm();
  };

  const keyHandler = (e: KeyboardEvent): void => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedShapeId) {
        e.preventDefault();
        deleteSelected();
      }
    } else if (e.key === 'Escape') {
      selectedShapeId = null;
      renderForm();
    }
  };
  document.addEventListener('keydown', keyHandler);

  // Cleanup when the editor is unmounted (handled by index.ts wiping innerHTML).
  // Use a MutationObserver for robust cleanup of the keydown listener.
  const observer = new MutationObserver(() => {
    if (!root.contains(grid)) {
      document.removeEventListener('keydown', keyHandler);
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
  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.rotate(s.angle);
  ctx.fillStyle = TOOL_FILL[s.tool];
  ctx.strokeStyle = selected ? '#9af09a' : TOOL_STROKE[s.tool];
  ctx.lineWidth = (selected ? 2 : 1.2) / scale;
  ctx.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
  ctx.strokeRect(-s.w / 2, -s.h / 2, s.w, s.h);

  // Hatching for difficult terrain (simple visual hint)
  if (s.tool === 'difficult') {
    ctx.strokeStyle = 'rgba(184, 136, 74, 0.55)';
    ctx.lineWidth = 0.8 / scale;
    const step = 10;
    ctx.beginPath();
    for (let off = -s.h; off < s.w + s.h; off += step) {
      ctx.moveTo(-s.w / 2 + off, -s.h / 2);
      ctx.lineTo(-s.w / 2 + off - s.h, s.h / 2);
    }
    ctx.stroke();
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
