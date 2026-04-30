/**
 * Mission editor — form-based MVP. No map canvas yet; positions are entered
 * as numeric x/y. Once the placement canvas lands, this file gains a
 * preview pane on the right that renders the map and lets users click to
 * place / drag enemies, spawns, and objectives.
 *
 * Pattern matches unitEditor / weaponEditor: bundled JSON shows on the
 * list with a 'bundled' badge; custom localStorage entries override by id
 * and show a 'custom' badge. Saving an edit to a bundled id creates an
 * override; "Revert to bundled" peels it back.
 */
import {
  listBundledMaps,
  listBundledMissionDefs,
  listMissionDefs,
  listUnitTemplates,
} from '../config/loader';
import type { MissionDef } from '../missions/types';
import type { ScenarioMode } from '../core/scenario/victory';
import type { Vec2 } from '../core/geometry/types';

interface MutableEnemySpawn {
  id: string;
  templateId: string;
  position: Vec2;
}
interface MutableObjective {
  id: string;
  position: Vec2;
  radius: number;
  displayName?: string;
}
import { el } from './dom';
import { downloadJson, pickJsonFile, timestampForFilename } from './io';
import {
  loadCustomMissions,
  removeCustomMission,
  upsertCustomMission,
} from './storage';

interface MissionDraft {
  id: string;
  displayName: string;
  description: string;
  mapId: string;
  scenario: ScenarioMode;
  scenarioParams: Record<string, unknown>;
  objectives: MutableObjective[];
  enemies: MutableEnemySpawn[];
  playerSpawnPositions: Vec2[];
  enemyFaction: 'A' | 'B';
}

const SCENARIOS: ScenarioMode[] = [
  'engage-reach',
  'elimination',
  'defend',
  'extract',
  'assassinate',
];

const toDraft = (m: MissionDef): MissionDraft => ({
  id: m.id,
  displayName: m.displayName,
  description: m.description,
  mapId: m.mapId,
  scenario: m.scenario,
  scenarioParams: { ...(m.scenarioParams ?? {}) },
  objectives: (m.objectives ?? []).map((o) => ({
    ...o,
    position: { ...o.position },
  })),
  enemies: m.enemies.map((e) => ({ ...e, position: { ...e.position } })),
  playerSpawnPositions: m.playerSpawnPositions.map((p) => ({ ...p })),
  enemyFaction: m.enemyFaction,
});

const fromDraft = (d: MissionDraft): MissionDef => {
  const out: Record<string, unknown> = {
    id: d.id,
    displayName: d.displayName,
    description: d.description,
    mapId: d.mapId,
    scenario: d.scenario,
    enemies: d.enemies.map((e) => ({
      id: e.id,
      templateId: e.templateId,
      position: { x: e.position.x, y: e.position.y },
    })),
    playerSpawnPositions: d.playerSpawnPositions.map((p) => ({
      x: p.x,
      y: p.y,
    })),
    enemyFaction: d.enemyFaction,
  };
  if (Object.keys(d.scenarioParams).length > 0) {
    out.scenarioParams = { ...d.scenarioParams };
  }
  if (d.objectives.length > 0) {
    out.objectives = d.objectives.map((o) => ({
      id: o.id,
      position: { x: o.position.x, y: o.position.y },
      radius: o.radius,
      ...(o.displayName ? { displayName: o.displayName } : {}),
    }));
  }
  return out as unknown as MissionDef;
};

const isCustom = (id: string): boolean =>
  loadCustomMissions().some((m) => m.id === id);

/** Heuristic validation; used as a soft warning panel, not a hard block. */
const validate = (d: MissionDraft): string[] => {
  const errs: string[] = [];
  if (!d.id.trim()) errs.push('id is required');
  if (!d.displayName.trim()) errs.push('displayName is required');
  if (!d.mapId.trim()) errs.push('mapId is required');
  const knownMaps = new Set(listBundledMaps().map((m) => m.id));
  if (d.mapId && !knownMaps.has(d.mapId)) {
    errs.push(`mapId '${d.mapId}' is not a known map`);
  }
  const knownTemplates = new Set(
    listUnitTemplates().map((t) => t.templateId),
  );
  for (const e of d.enemies) {
    if (!e.id.trim()) errs.push(`enemy missing id`);
    if (!knownTemplates.has(e.templateId)) {
      errs.push(`enemy '${e.id}' has unknown templateId '${e.templateId}'`);
    }
  }
  if (new Set(d.enemies.map((e) => e.id)).size !== d.enemies.length) {
    errs.push('duplicate enemy ids');
  }
  if (d.scenario === 'assassinate') {
    const vipId = d.scenarioParams.vipUnitId as string | undefined;
    if (!vipId) errs.push('assassinate: scenarioParams.vipUnitId required');
    else if (!d.enemies.some((e) => e.id === vipId)) {
      errs.push(
        `assassinate: vipUnitId '${vipId}' does not match any enemy id`,
      );
    }
  }
  if (d.scenario === 'extract') {
    const ec = d.scenarioParams.extractCount as number | undefined;
    if (typeof ec !== 'number' || ec <= 0) {
      errs.push('extract: scenarioParams.extractCount must be a positive number');
    }
  }
  if (
    (d.scenario === 'engage-reach' || d.scenario === 'defend') &&
    d.objectives.length === 0
  ) {
    errs.push(`${d.scenario}: needs at least one objective`);
  }
  if (d.playerSpawnPositions.length === 0) {
    errs.push('playerSpawnPositions empty');
  }
  return errs;
};

export const mountMissionEditor = (root: HTMLElement): void => {
  let selectedId: string | null = null;

  const grid = el('div', { className: 'editor-grid' });
  const listPanel = el('div', { className: 'item-list' });
  const formPanel = el('div', { className: 'form' });

  const refresh = (): void => {
    renderList();
    renderForm();
  };

  const renderList = (): void => {
    listPanel.innerHTML = '';
    const toolbar = el('div', { className: 'toolbar' });

    const newBtn = el('button', {
      text: '+ New mission',
      onclick: () => {
        let id = 'new-mission';
        let i = 1;
        while (listMissionDefs().some((m) => m.id === id)) {
          id = `new-mission-${++i}`;
        }
        upsertCustomMission({
          id,
          displayName: id,
          description: '',
          mapId: listBundledMaps()[0]?.id ?? 'demo',
          scenario: 'engage-reach',
          enemies: [],
          playerSpawnPositions: [{ x: 100, y: 600 }],
          enemyFaction: 'B',
        } as MissionDef);
        selectedId = id;
        refresh();
      },
    });
    toolbar.appendChild(newBtn);

    const exportBtn = el('button', {
      text: '⤓ Export',
      onclick: () => {
        const customs = loadCustomMissions();
        if (customs.length === 0) {
          alert('No custom missions to export.');
          return;
        }
        downloadJson(`czl-missions-${timestampForFilename()}.json`, customs);
      },
    });
    exportBtn.title = 'Download all custom missions as JSON';
    toolbar.appendChild(exportBtn);

    const importBtn = el('button', {
      text: '⤒ Import',
      onclick: async () => {
        try {
          const data = await pickJsonFile();
          if (!data) return;
          const arr = Array.isArray(data) ? data : [data];
          let added = 0;
          for (const item of arr) {
            const m = item as MissionDef;
            if (!m?.id || !m.scenario || !Array.isArray(m.enemies)) {
              alert(
                `Skipped invalid entry: ${JSON.stringify(item).slice(0, 80)}`,
              );
              continue;
            }
            upsertCustomMission({ ...m });
            added += 1;
          }
          alert(`Imported ${added} mission(s).`);
          refresh();
        } catch (e) {
          alert(`Import failed: ${(e as Error).message}`);
        }
      },
    });
    importBtn.title =
      'Merge missions from a JSON file (existing ids overwritten)';
    toolbar.appendChild(importBtn);

    listPanel.appendChild(toolbar);

    const all = listMissionDefs();
    const bundledIds = new Set(listBundledMissionDefs().map((m) => m.id));
    for (const m of all) {
      const isOverride = isCustom(m.id);
      const isBundledOnly = bundledIds.has(m.id) && !isOverride;
      const row = el('div', {
        className: `row${selectedId === m.id ? ' active' : ''}`,
        onclick: () => {
          selectedId = m.id;
          refresh();
        },
      });
      const title = el('div', {
        children: [
          document.createTextNode(`${m.displayName} (${m.id})`),
          ...(isOverride
            ? [el('span', { className: 'badge', text: 'custom' })]
            : []),
          ...(isBundledOnly
            ? [el('span', { className: 'badge', text: 'bundled' })]
            : []),
        ],
      });
      const meta = el('div', {
        className: 'meta',
        text: `${m.scenario} · ${m.mapId} · ${m.enemies.length} enemies`,
      });
      row.appendChild(title);
      row.appendChild(meta);
      listPanel.appendChild(row);
    }
  };

  const renderForm = (): void => {
    formPanel.innerHTML = '';
    if (!selectedId) {
      formPanel.appendChild(
        el('div', {
          className: 'empty',
          text: 'Pick a mission from the list, or create a new one.',
        }),
      );
      return;
    }
    const m = listMissionDefs().find((x) => x.id === selectedId);
    if (!m) {
      selectedId = null;
      renderForm();
      return;
    }
    const draft = toDraft(m);
    const isBundled = listBundledMissionDefs().some((x) => x.id === m.id);
    const overrideExists = isCustom(m.id);

    const idInput = el('input', {
      type: 'text',
      value: draft.id,
      style: { width: '220px' },
    }) as HTMLInputElement;
    idInput.addEventListener('input', () => {
      draft.id = idInput.value.trim();
    });

    const nameInput = el('input', {
      type: 'text',
      value: draft.displayName,
      style: { width: '260px' },
    }) as HTMLInputElement;
    nameInput.addEventListener('input', () => {
      draft.displayName = nameInput.value;
    });

    const descInput = el('input', {
      type: 'text',
      value: draft.description,
      style: { width: '420px' },
    }) as HTMLInputElement;
    descInput.addEventListener('input', () => {
      draft.description = descInput.value;
    });

    const mapSelect = el('select') as HTMLSelectElement;
    for (const mp of listBundledMaps()) {
      const opt = el('option', {
        value: mp.id,
        text: `${mp.displayName} (${mp.id})`,
      }) as HTMLOptionElement;
      if (mp.id === draft.mapId) opt.selected = true;
      mapSelect.appendChild(opt);
    }
    mapSelect.addEventListener('change', () => {
      draft.mapId = mapSelect.value;
    });

    const factionSelect = el('select') as HTMLSelectElement;
    for (const f of ['A', 'B'] as const) {
      const opt = el('option', { value: f, text: f }) as HTMLOptionElement;
      if (f === draft.enemyFaction) opt.selected = true;
      factionSelect.appendChild(opt);
    }
    factionSelect.addEventListener('change', () => {
      draft.enemyFaction = factionSelect.value as 'A' | 'B';
    });

    // Scenario radio + dynamic params block ------------------------------
    const scenarioBox = el('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '6px' },
    });
    const scenarioRadios = el('div', {
      style: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
    });
    const paramsBox = el('div', {
      style: {
        display: 'flex',
        gap: '12px',
        flexWrap: 'wrap',
        padding: '6px 0',
      },
    });

    const renderScenarioParams = (): void => {
      paramsBox.innerHTML = '';
      const numField = (
        label: string,
        key: string,
        defaultVal: number,
      ): HTMLElement => {
        const inp = el('input', {
          type: 'number',
          value: String(
            (draft.scenarioParams[key] as number | undefined) ?? defaultVal,
          ),
          style: { width: '100px' },
        }) as HTMLInputElement;
        inp.addEventListener('input', () => {
          const n = Number(inp.value);
          if (Number.isFinite(n)) draft.scenarioParams[key] = n;
        });
        return el('label', {
          children: [
            document.createTextNode(label + ' '),
            inp,
          ],
          style: { fontSize: '12px' },
        });
      };
      const strField = (
        label: string,
        key: string,
        opts: ReadonlyArray<string>,
      ): HTMLElement => {
        const sel = el('select') as HTMLSelectElement;
        sel.appendChild(
          el('option', { value: '', text: '(none)' }) as HTMLOptionElement,
        );
        for (const o of opts) {
          const optEl = el('option', {
            value: o,
            text: o,
          }) as HTMLOptionElement;
          if ((draft.scenarioParams[key] as string | undefined) === o) {
            optEl.selected = true;
          }
          sel.appendChild(optEl);
        }
        sel.addEventListener('change', () => {
          if (sel.value) draft.scenarioParams[key] = sel.value;
          else delete draft.scenarioParams[key];
        });
        return el('label', {
          children: [document.createTextNode(label + ' '), sel],
          style: { fontSize: '12px' },
        });
      };

      if (draft.scenario === 'defend') {
        paramsBox.appendChild(numField('defendCycles', 'defendCycles', 999));
      } else if (draft.scenario === 'extract') {
        paramsBox.appendChild(numField('extractCount', 'extractCount', 2));
        paramsBox.appendChild(
          numField('extractCycleLimit', 'extractCycleLimit', 999),
        );
      } else if (draft.scenario === 'assassinate') {
        paramsBox.appendChild(
          strField(
            'vipUnitId',
            'vipUnitId',
            draft.enemies.map((e) => e.id),
          ),
        );
        paramsBox.appendChild(
          numField(
            'assassinateCycleLimit',
            'assassinateCycleLimit',
            999,
          ),
        );
      } else {
        paramsBox.appendChild(
          el('span', { text: '(no params)', style: { color: '#7a9a7a' } }),
        );
      }
    };

    for (const s of SCENARIOS) {
      const r = el('input', { type: 'radio' }) as HTMLInputElement;
      r.name = `scenario-${draft.id}`;
      r.checked = draft.scenario === s;
      r.addEventListener('change', () => {
        if (!r.checked) return;
        draft.scenario = s;
        // Reset params when changing scenario type — old keys are stale.
        draft.scenarioParams = {};
        renderScenarioParams();
      });
      const label = el('label', {
        children: [r, document.createTextNode(' ' + s)],
        style: { fontSize: '12px' },
      });
      scenarioRadios.appendChild(label);
    }
    scenarioBox.appendChild(scenarioRadios);
    scenarioBox.appendChild(paramsBox);
    renderScenarioParams();

    // Enemy list ---------------------------------------------------------
    const enemyBox = el('div', { className: 'subform' });
    const renderEnemies = (): void => {
      enemyBox.innerHTML = '';
      const templates = listUnitTemplates();
      draft.enemies.forEach((e, idx) => {
        const idInp = el('input', {
          type: 'text',
          value: e.id,
          style: { width: '120px' },
        }) as HTMLInputElement;
        idInp.addEventListener('input', () => {
          e.id = idInp.value.trim();
        });
        const tplSelect = el('select') as HTMLSelectElement;
        for (const t of templates) {
          const opt = el('option', {
            value: t.templateId,
            text: t.templateId,
          }) as HTMLOptionElement;
          if (t.templateId === e.templateId) opt.selected = true;
          tplSelect.appendChild(opt);
        }
        tplSelect.addEventListener('change', () => {
          e.templateId = tplSelect.value;
        });
        const xInp = el('input', {
          type: 'number',
          value: String(e.position.x),
          style: { width: '70px' },
        }) as HTMLInputElement;
        xInp.addEventListener('input', () => {
          const n = Number(xInp.value);
          if (Number.isFinite(n)) e.position = { x: n, y: e.position.y };
        });
        const yInp = el('input', {
          type: 'number',
          value: String(e.position.y),
          style: { width: '70px' },
        }) as HTMLInputElement;
        yInp.addEventListener('input', () => {
          const n = Number(yInp.value);
          if (Number.isFinite(n)) e.position = { x: e.position.x, y: n };
        });
        const delBtn = el('button', {
          text: '−',
          onclick: () => {
            draft.enemies.splice(idx, 1);
            renderEnemies();
            renderScenarioParams(); // refresh VIP dropdown
          },
        });
        const row = el('div', {
          className: 'row',
          style: { display: 'flex', gap: '6px', alignItems: 'center' },
          children: [
            idInp,
            tplSelect,
            document.createTextNode('x'),
            xInp,
            document.createTextNode('y'),
            yInp,
            delBtn,
          ],
        });
        enemyBox.appendChild(row);
      });
      const addBtn = el('button', {
        text: '+ Add enemy',
        onclick: () => {
          const newId = `e${draft.enemies.length + 1}`;
          draft.enemies.push({
            id: newId,
            templateId: templates[0]?.templateId ?? '',
            position: { x: 384, y: 200 },
          });
          renderEnemies();
          renderScenarioParams();
        },
      });
      enemyBox.appendChild(addBtn);
    };
    renderEnemies();

    // Player spawn list --------------------------------------------------
    const spawnBox = el('div', { className: 'subform' });
    const renderSpawns = (): void => {
      spawnBox.innerHTML = '';
      draft.playerSpawnPositions.forEach((p, idx) => {
        const xInp = el('input', {
          type: 'number',
          value: String(p.x),
          style: { width: '70px' },
        }) as HTMLInputElement;
        xInp.addEventListener('input', () => {
          const n = Number(xInp.value);
          if (Number.isFinite(n)) draft.playerSpawnPositions[idx] = { x: n, y: p.y };
        });
        const yInp = el('input', {
          type: 'number',
          value: String(p.y),
          style: { width: '70px' },
        }) as HTMLInputElement;
        yInp.addEventListener('input', () => {
          const n = Number(yInp.value);
          if (Number.isFinite(n)) draft.playerSpawnPositions[idx] = { x: p.x, y: n };
        });
        const delBtn = el('button', {
          text: '−',
          onclick: () => {
            draft.playerSpawnPositions.splice(idx, 1);
            renderSpawns();
          },
        });
        spawnBox.appendChild(
          el('div', {
            className: 'row',
            style: { display: 'flex', gap: '6px', alignItems: 'center' },
            children: [
              document.createTextNode(`#${idx + 1} x`),
              xInp,
              document.createTextNode('y'),
              yInp,
              delBtn,
            ],
          }),
        );
      });
      const addBtn = el('button', {
        text: '+ Add spawn',
        onclick: () => {
          draft.playerSpawnPositions.push({ x: 100, y: 600 });
          renderSpawns();
        },
      });
      spawnBox.appendChild(addBtn);
    };
    renderSpawns();

    // Objective list -----------------------------------------------------
    const objBox = el('div', { className: 'subform' });
    const renderObjectives = (): void => {
      objBox.innerHTML = '';
      draft.objectives.forEach((o, idx) => {
        const idInp = el('input', {
          type: 'text',
          value: o.id,
          style: { width: '160px' },
        }) as HTMLInputElement;
        idInp.addEventListener('input', () => {
          o.id = idInp.value.trim();
        });
        const xInp = el('input', {
          type: 'number',
          value: String(o.position.x),
          style: { width: '70px' },
        }) as HTMLInputElement;
        xInp.addEventListener('input', () => {
          const n = Number(xInp.value);
          if (Number.isFinite(n)) o.position = { x: n, y: o.position.y };
        });
        const yInp = el('input', {
          type: 'number',
          value: String(o.position.y),
          style: { width: '70px' },
        }) as HTMLInputElement;
        yInp.addEventListener('input', () => {
          const n = Number(yInp.value);
          if (Number.isFinite(n)) o.position = { x: o.position.x, y: n };
        });
        const rInp = el('input', {
          type: 'number',
          value: String(o.radius),
          style: { width: '70px' },
        }) as HTMLInputElement;
        rInp.addEventListener('input', () => {
          const n = Number(rInp.value);
          if (Number.isFinite(n)) o.radius = n;
        });
        const nInp = el('input', {
          type: 'text',
          value: o.displayName ?? '',
          placeholder: '(optional name)',
          style: { width: '140px' },
        }) as HTMLInputElement;
        nInp.addEventListener('input', () => {
          o.displayName = nInp.value || undefined;
        });
        const delBtn = el('button', {
          text: '−',
          onclick: () => {
            draft.objectives.splice(idx, 1);
            renderObjectives();
          },
        });
        objBox.appendChild(
          el('div', {
            className: 'row',
            style: { display: 'flex', gap: '6px', alignItems: 'center' },
            children: [
              idInp,
              document.createTextNode('x'),
              xInp,
              document.createTextNode('y'),
              yInp,
              document.createTextNode('r'),
              rInp,
              nInp,
              delBtn,
            ],
          }),
        );
      });
      const addBtn = el('button', {
        text: '+ Add objective',
        onclick: () => {
          draft.objectives.push({
            id: `obj-${draft.objectives.length + 1}`,
            position: { x: 384, y: 384 },
            radius: 36,
          });
          renderObjectives();
        },
      });
      objBox.appendChild(addBtn);
    };
    renderObjectives();

    // Validation pane ---------------------------------------------------
    const validationBox = el('div', {
      style: {
        padding: '8px',
        border: '1px dashed #5a3a3a',
        margin: '8px 0',
        fontSize: '12px',
      },
    });
    const renderValidation = (): void => {
      validationBox.innerHTML = '';
      const errs = validate(draft);
      if (errs.length === 0) {
        validationBox.style.borderColor = '#3a5a3a';
        validationBox.appendChild(
          el('span', {
            text: '✓ no obvious problems',
            style: { color: '#9af09a' },
          }),
        );
      } else {
        validationBox.style.borderColor = '#5a3a3a';
        validationBox.appendChild(
          el('div', {
            text: `${errs.length} issue(s):`,
            style: { color: '#f0a09a', marginBottom: '4px' },
          }),
        );
        for (const er of errs) {
          validationBox.appendChild(
            el('div', { text: '• ' + er, style: { color: '#f0a09a' } }),
          );
        }
      }
    };
    renderValidation();

    // Layout ------------------------------------------------------------
    const row = (label: string, input: HTMLElement, help?: string): HTMLElement =>
      el('div', {
        className: 'row',
        children: [
          el('label', { text: label }),
          el('div', {
            children: [
              input,
              ...(help ? [el('div', { className: 'help', text: help })] : []),
            ],
          }),
        ],
      });

    formPanel.appendChild(
      row(
        'id',
        idInput,
        'Unique mission id; overrides bundled if same id.',
      ),
    );
    formPanel.appendChild(row('displayName', nameInput));
    formPanel.appendChild(row('description', descInput));
    formPanel.appendChild(row('mapId', mapSelect));
    formPanel.appendChild(row('enemyFaction', factionSelect));
    formPanel.appendChild(row('scenario', scenarioBox));
    formPanel.appendChild(
      row(
        'enemies',
        enemyBox,
        'id / templateId / x,y. templateId must match a bundled or custom unit.',
      ),
    );
    formPanel.appendChild(
      row('playerSpawnPositions', spawnBox, 'Squad deploys at these points.'),
    );
    formPanel.appendChild(
      row(
        'objectives',
        objBox,
        'Engage-reach / defend require ≥1; extract reads them as extract zone.',
      ),
    );
    formPanel.appendChild(row('validation', validationBox));

    // Action buttons ----------------------------------------------------
    const saveBtn = el('button', {
      text: 'Save',
      onclick: () => {
        if (!draft.id) {
          alert('id is required');
          return;
        }
        const errs = validate(draft);
        if (errs.length > 0) {
          if (!confirm(`There are ${errs.length} validation issue(s). Save anyway?`)) {
            return;
          }
        }
        if (overrideExists && draft.id !== m.id) {
          removeCustomMission(m.id);
        }
        upsertCustomMission(fromDraft(draft));
        selectedId = draft.id;
        refresh();
      },
    });

    const exportSingleBtn = el('button', {
      text: '⤓ Export this',
      onclick: () => {
        downloadJson(`${draft.id}.json`, fromDraft(draft));
      },
    });
    exportSingleBtn.title =
      'Download just this mission as a JSON file (drop into src/config/missions/ to bundle).';

    const revertBtn = el('button', {
      text: 'Revert to bundled',
      onclick: () => {
        if (!isBundled || !overrideExists) return;
        removeCustomMission(m.id);
        refresh();
      },
    }) as HTMLButtonElement;
    revertBtn.disabled = !isBundled || !overrideExists;

    const deleteBtn = el('button', {
      className: 'danger',
      text: isBundled ? 'Delete (bundled — disabled)' : 'Delete',
      onclick: () => {
        if (isBundled) return;
        if (!confirm(`Delete custom mission '${m.id}'?`)) return;
        removeCustomMission(m.id);
        selectedId = null;
        refresh();
      },
    }) as HTMLButtonElement;
    deleteBtn.disabled = isBundled;

    const cloneBtn = el('button', {
      text: 'Clone as new',
      onclick: () => {
        let newId = `${m.id}-copy`;
        let i = 1;
        while (listMissionDefs().some((x) => x.id === newId)) {
          newId = `${m.id}-copy-${++i}`;
        }
        upsertCustomMission(fromDraft({ ...draft, id: newId }));
        selectedId = newId;
        refresh();
      },
    });

    formPanel.appendChild(
      el('div', {
        className: 'actions',
        children: [saveBtn, exportSingleBtn, cloneBtn, revertBtn, deleteBtn],
      }),
    );
  };

  grid.appendChild(listPanel);
  grid.appendChild(formPanel);
  root.appendChild(grid);

  refresh();
};
