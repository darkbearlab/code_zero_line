/**
 * Factions tab — split into two panels:
 *   1. Faction registry: CRUD for { id, name, description, playable, hostile }
 *   2. Template × Faction matrix: per-template checkbox per faction.
 *
 * Storage: factions go to `czl.editor.factions.v1` (`upsertCustomFaction`),
 * template assignments piggyback on the existing `czl.editor.templates.v1`
 * overlay via `upsertCustomTemplate({ ...t, factionTags })`.
 *
 * Untagged templates display as `neutral` (fallback in loader.tagsOf), but
 * the underlying factionTags stay undefined until the user actively edits
 * the row — so untouched bundled templates never get their JSON surface
 * polluted with `['neutral']`.
 */
import { el } from './dom';
import {
  type Faction,
  type UnitTemplate,
  getFaction,
  listFactions,
  listUnitTemplates,
  tagsOf,
} from '../config/loader';
import {
  removeCustomFaction,
  upsertCustomFaction,
  upsertCustomTemplate,
} from './storage';

const NEUTRAL_ID = 'neutral';

type SortDir = 'checkedFirst' | 'uncheckedFirst';
interface MatrixSort {
  readonly factionId: string;
  readonly dir: SortDir;
}

const cell = (
  tag: 'th' | 'td',
  txt: string,
  extra?: Partial<CSSStyleDeclaration>,
): HTMLTableCellElement => {
  const c = el(tag, {
    text: txt,
    style: {
      padding: '6px 12px',
      borderBottom: tag === 'th' ? '1px solid #3a5a3a' : '1px solid #2a3a2a',
      textAlign: tag === 'th' ? 'left' : 'left',
      ...extra,
    },
  });
  return c as HTMLTableCellElement;
};

export const mountFactionEditor = (root: HTMLElement): void => {
  // Persists across re-renders so toggling a checkbox keeps the active sort
  // and the row jumps to its new position immediately.
  let matrixSort: MatrixSort | null = null;

  const render = (): void => {
    root.innerHTML = '';

    root.appendChild(
      el('div', {
        className: 'help',
        style: { marginBottom: '12px', maxWidth: '720px' },
        text:
          '派系 = 跨 template 的橫向分組。playable → 戰役招募池來源；'
          + 'hostile → 任務編輯器敵人選單來源。一個派系可同時 playable+hostile（中立 / 內戰）。'
          + '模板未指派任何派系時，自動歸屬於 neutral fallback。',
      }),
    );

    const layout = el('div', {
      style: {
        display: 'flex',
        gap: '24px',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      },
    });
    const leftPanel = el('div', { style: { flex: '1 1 520px', minWidth: '0' } });
    const rightPanel = el('div', { style: { flex: '1 1 380px', minWidth: '0' } });
    layout.appendChild(leftPanel);
    layout.appendChild(rightPanel);
    root.appendChild(layout);

    renderRegistry(leftPanel);
    renderMatrix(rightPanel);
  };

  const renderRegistry = (mount: HTMLElement): void => {
    const factions = listFactions();

    mount.appendChild(
      el('h3', {
        text: '派系定義',
        style: { margin: '4px 0 8px', fontSize: '14px', fontWeight: 'normal' },
      }),
    );

    const table = el('table', {
      style: { borderCollapse: 'collapse', fontSize: '12px', width: '100%', maxWidth: '900px' },
    });

    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(cell('th', 'id', { width: '120px' }));
    headRow.appendChild(cell('th', 'name', { width: '140px' }));
    headRow.appendChild(cell('th', 'description', {}));
    headRow.appendChild(cell('th', 'color', { width: '80px', textAlign: 'center' }));
    headRow.appendChild(cell('th', 'playable', { width: '70px', textAlign: 'center' }));
    headRow.appendChild(cell('th', 'hostile', { width: '70px', textAlign: 'center' }));
    headRow.appendChild(cell('th', '', { width: '40px' }));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const f of factions) {
      tbody.appendChild(renderRegistryRow(f));
    }
    table.appendChild(tbody);
    mount.appendChild(table);

    const addBtn = el('button', {
      text: '+ 新派系',
      style: { marginTop: '8px' },
      onclick: () => {
        // Pick a fresh id like faction-N.
        const ids = new Set(listFactions().map((f) => f.id));
        let n = 1;
        while (ids.has(`faction-${n}`)) n += 1;
        upsertCustomFaction({
          id: `faction-${n}`,
          name: `Faction ${n}`,
          description: '',
          playable: true,
          hostile: true,
        });
        render();
      },
    });
    mount.appendChild(addBtn);
  };

  const renderRegistryRow = (f: Faction): HTMLTableRowElement => {
    const row = el('tr');
    const isBundledNeutral = f.id === NEUTRAL_ID;

    // Always read the freshest value from store before each upsert so that
    // editing several fields without an intervening render does not stomp
    // earlier edits with a stale `f` snapshot.
    const fresh = (): Faction => getFaction(f.id) ?? f;

    // id — bundled neutral locked; custom id editable, with cascade to
    // migrate template factionTags from the old id to the new one (otherwise
    // matrix checkboxes appear "cleared").
    const idInp = el('input', {
      type: 'text',
      value: f.id,
      style: { width: '100%', boxSizing: 'border-box' },
    }) as HTMLInputElement;
    idInp.disabled = isBundledNeutral;
    idInp.addEventListener('change', () => {
      const next = idInp.value.trim();
      const oldId = f.id;
      if (!next || next === oldId) {
        idInp.value = oldId;
        return;
      }
      if (listFactions().some((x) => x.id === next)) {
        alert(`派系 id "${next}" 已存在`);
        idInp.value = oldId;
        return;
      }
      // Migrate template references first so matrix doesn't show orphans.
      for (const t of listUnitTemplates()) {
        const tags = t.factionTags ?? [];
        if (!tags.includes(oldId)) continue;
        upsertCustomTemplate({
          ...t,
          factionTags: tags.map((x) => (x === oldId ? next : x)),
        });
      }
      removeCustomFaction(oldId);
      upsertCustomFaction({ ...fresh(), id: next });
      render();
    });
    const idTd = cell('td', '');
    idTd.innerHTML = '';
    idTd.appendChild(idInp);
    row.appendChild(idTd);

    // name
    const nameInp = el('input', {
      type: 'text',
      value: f.name,
      style: { width: '100%', boxSizing: 'border-box' },
    }) as HTMLInputElement;
    nameInp.addEventListener('change', () => {
      upsertCustomFaction({ ...fresh(), name: nameInp.value });
    });
    const nameTd = cell('td', '');
    nameTd.innerHTML = '';
    nameTd.appendChild(nameInp);
    row.appendChild(nameTd);

    // description (lore blurb)
    const descInp = el('input', {
      type: 'text',
      value: f.description ?? '',
      placeholder: '背景故事 / 說明',
      style: { width: '100%', boxSizing: 'border-box' },
    }) as HTMLInputElement;
    descInp.addEventListener('change', () => {
      upsertCustomFaction({
        ...fresh(),
        description: descInp.value.trim() || undefined,
      });
    });
    const descTd = cell('td', '');
    descTd.innerHTML = '';
    descTd.appendChild(descInp);
    row.appendChild(descTd);

    // color — drives sprite tint at render time. Optional; absent = no tint.
    const colorTd = cell('td', '', { textAlign: 'center' });
    colorTd.innerHTML = '';
    const colorWrap = el('div', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
    });
    const colorInp = el('input', {
      type: 'color',
      value: f.color ?? '#888888',
      style: {
        width: '32px',
        height: '20px',
        padding: '0',
        border: '1px solid #3a5a3a',
        cursor: 'pointer',
      },
    }) as HTMLInputElement;
    if (!f.color) colorInp.style.opacity = '0.4';
    colorInp.title = '套用為單位 sprite tint 的顏色';
    colorInp.addEventListener('change', () => {
      upsertCustomFaction({ ...fresh(), color: colorInp.value });
      render();
    });
    colorWrap.appendChild(colorInp);
    if (f.color) {
      const clearBtn = el('button', {
        text: '✕',
        style: { fontSize: '10px', padding: '0 4px' },
        onclick: () => {
          upsertCustomFaction({ ...fresh(), color: undefined });
          render();
        },
      });
      clearBtn.title = '清除顏色（不套用 tint）';
      colorWrap.appendChild(clearBtn);
    }
    colorTd.appendChild(colorWrap);
    row.appendChild(colorTd);

    // playable
    row.appendChild(boolCell(f.playable, (next) => {
      upsertCustomFaction({ ...fresh(), playable: next });
    }));

    // hostile
    row.appendChild(boolCell(f.hostile, (next) => {
      upsertCustomFaction({ ...fresh(), hostile: next });
    }));

    // delete
    const delTd = cell('td', '', { textAlign: 'center' });
    delTd.innerHTML = '';
    if (!isBundledNeutral) {
      const usedBy = listUnitTemplates().filter((t) =>
        (t.factionTags ?? []).includes(f.id),
      );
      const delBtn = el('button', {
        text: '✕',
        className: 'danger',
        onclick: () => {
          const msg = usedBy.length
            ? `刪除派系「${f.name}」？將從 ${usedBy.length} 個 template 移除此派系標記。`
            : `刪除派系「${f.name}」？`;
          if (!confirm(msg)) return;
          for (const t of usedBy) {
            const next = (t.factionTags ?? []).filter((x) => x !== f.id);
            upsertCustomTemplate({
              ...t,
              factionTags: next.length ? next : undefined,
            });
          }
          removeCustomFaction(f.id);
          render();
        },
      });
      delTd.appendChild(delBtn);
    }
    row.appendChild(delTd);

    return row;
  };

  const boolCell = (
    value: boolean,
    onChange: (next: boolean) => void,
  ): HTMLTableCellElement => {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = value;
    cb.addEventListener('change', () => {
      onChange(cb.checked);
    });
    const td = cell('td', '', { textAlign: 'center' });
    td.innerHTML = '';
    td.appendChild(cb);
    return td;
  };

  const renderMatrix = (mount: HTMLElement): void => {
    const allTemplates = listUnitTemplates();
    const factions = listFactions();

    mount.appendChild(
      el('h3', {
        text: '模板派系歸屬',
        style: { margin: '4px 0 8px', fontSize: '14px', fontWeight: 'normal' },
      }),
    );

    // If the active sort references a faction that has been deleted, drop it.
    if (matrixSort && !factions.some((f) => f.id === matrixSort!.factionId)) {
      matrixSort = null;
    }

    if (allTemplates.length === 0) {
      mount.appendChild(el('div', { className: 'empty', text: 'No templates.' }));
      return;
    }

    const sorted = applyMatrixSort(allTemplates, matrixSort);

    const table = el('table', {
      style: { borderCollapse: 'collapse', fontSize: '12px' },
    });

    // Header — faction columns are clickable to cycle sort state.
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(cell('th', 'template', { minWidth: '220px' }));
    for (const f of factions) {
      const indicator =
        matrixSort?.factionId === f.id
          ? matrixSort.dir === 'checkedFirst' ? ' ▼' : ' ▲'
          : '';
      const th = cell('th', f.id + indicator, {
        textAlign: 'center',
        minWidth: '80px',
        cursor: 'pointer',
      });
      th.title = '點擊：勾選置頂 → 未勾選置頂 → 取消排序';
      th.addEventListener('click', () => {
        matrixSort = nextSortState(matrixSort, f.id);
        render();
      });
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const t of sorted) {
      tbody.appendChild(renderMatrixRow(t, factions));
    }
    table.appendChild(tbody);
    mount.appendChild(table);
  };

  const nextSortState = (
    cur: MatrixSort | null,
    factionId: string,
  ): MatrixSort | null => {
    if (!cur || cur.factionId !== factionId) {
      return { factionId, dir: 'checkedFirst' };
    }
    if (cur.dir === 'checkedFirst') return { factionId, dir: 'uncheckedFirst' };
    return null;
  };

  const applyMatrixSort = (
    templates: ReadonlyArray<UnitTemplate>,
    sort: MatrixSort | null,
  ): ReadonlyArray<UnitTemplate> => {
    if (!sort) return templates;
    // Stable sort: keep original order within each (checked/unchecked) bucket.
    const indexed = templates.map((t, i) => ({ t, i }));
    indexed.sort((a, b) => {
      const aHas = tagsOf(a.t).includes(sort.factionId);
      const bHas = tagsOf(b.t).includes(sort.factionId);
      if (aHas !== bHas) {
        const wantTop = sort.dir === 'checkedFirst' ? aHas : !aHas;
        return wantTop ? -1 : 1;
      }
      return a.i - b.i;
    });
    return indexed.map((x) => x.t);
  };

  const renderMatrixRow = (
    t: UnitTemplate,
    factions: ReadonlyArray<Faction>,
  ): HTMLTableRowElement => {
    const row = el('tr');
    const explicit = t.factionTags;
    const effective = new Set(tagsOf(t));

    row.appendChild(cell('td', `${t.displayName}  (${t.templateId})`));

    for (const f of factions) {
      const td = cell('td', '', { textAlign: 'center' });
      td.innerHTML = '';
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = effective.has(f.id);

      // Visual hint: when the row is in fallback mode (no explicit tags) and
      // the only checked box is `neutral`, dim it so the user sees it as a
      // default rather than a stored value.
      const isFallbackOnly = !explicit || explicit.length === 0;
      if (isFallbackOnly && f.id === NEUTRAL_ID) {
        cb.title = '預設 fallback — 勾任何格後此狀態會被寫入';
        td.style.opacity = '0.55';
      }

      cb.addEventListener('change', () => {
        // Materialize fallback the first time the user touches the row.
        const cur = new Set(explicit ?? tagsOf(t));
        if (cb.checked) cur.add(f.id);
        else cur.delete(f.id);
        const next = [...cur];
        upsertCustomTemplate({
          ...t,
          factionTags: next.length ? next : undefined,
        });
        render();
      });

      td.appendChild(cb);
      row.appendChild(td);
    }

    return row;
  };

  render();
};
