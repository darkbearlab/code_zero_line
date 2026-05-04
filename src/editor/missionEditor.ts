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
  getMap,
  listBundledMaps,
  listBundledMissionDefs,
  listFactions,
  listMissionDefs,
  listUnitTemplates,
  tagsOf,
} from '../config/loader';
import type { UnitTemplate } from '../config/loader';
import type { MapDef } from '../core/setup/types';
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
import { downloadJson, pickJsonFile, saveToBundleEndpoint, timestampForFilename } from './io';
import { paintBoardFloorCanvas } from '../presentation/rendering/boardFloor';
import {
  loadCustomMissions,
  removeCustomMission,
  upsertCustomMission,
} from './storage';

interface MissionDraft {
  id: string;
  displayName: string;
  description: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  mapId: string;
  scenario: ScenarioMode;
  scenarioParams: Record<string, unknown>;
  objectives: MutableObjective[];
  enemies: MutableEnemySpawn[];
  playerSpawnPositions: Vec2[];
  enemyFaction: 'A' | 'B';
  includeInCampaignPool: boolean;
}

const SCENARIOS: ScenarioMode[] = [
  'engage-reach',
  'elimination',
  'defend',
  'extract',
  'assassinate',
  'control-points',
];

const toDraft = (m: MissionDef): MissionDraft => ({
  id: m.id,
  displayName: m.displayName,
  description: m.description,
  difficulty: m.difficulty,
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
  includeInCampaignPool: m.includeInCampaignPool !== false,
});

const fromDraft = (d: MissionDraft): MissionDef => {
  const out: Record<string, unknown> = {
    id: d.id,
    displayName: d.displayName,
    description: d.description,
    difficulty: d.difficulty,
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
  // Only emit the flag when off, so existing JSON files stay tidy and
  // implicit-default = in pool. Loader / picker treat undefined as true.
  if (d.includeInCampaignPool === false) {
    out.includeInCampaignPool = false;
  }
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
  if (d.scenario === 'control-points') {
    if (d.objectives.length === 0) {
      errs.push('control-points: needs at least one objective');
    }
    const ws = d.scenarioParams.winScore as number | undefined;
    if (ws !== undefined && (!Number.isFinite(ws) || ws < 1)) {
      errs.push('control-points: winScore must be ≥ 1');
    }
    const wl = d.scenarioParams.winLead as number | undefined;
    if (wl !== undefined && (!Number.isFinite(wl) || wl < 1)) {
      errs.push('control-points: winLead must be ≥ 1');
    }
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
          difficulty: 2,
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
          ...(m.includeInCampaignPool === false
            ? [el('span', { className: 'badge', text: 'not in pool' })]
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

    // Reactive redraw hook — assigned for real when the canvas is built
    // below. Subform mutation handlers (renderEnemies / renderSpawns /
    // renderObjectives, plus numeric x/y inputs) call it so the preview
    // stays in sync with the form.
    let redrawCanvas: () => void = () => {};
    type CanvasTool = 'select' | 'enemy' | 'spawn' | 'objective' | 'delete';
    let activeCanvasTool: CanvasTool = 'select';
    let canvasSelected:
      | { kind: 'enemy' | 'spawn' | 'objective'; index: number }
      | null = null;

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
      redrawCanvas();
    });

    const difficultySelect = el('select') as HTMLSelectElement;
    for (const d of [1, 2, 3, 4, 5] as const) {
      const opt = el('option', {
        value: String(d),
        text: String(d),
      }) as HTMLOptionElement;
      if (d === draft.difficulty) opt.selected = true;
      difficultySelect.appendChild(opt);
    }
    difficultySelect.addEventListener('change', () => {
      const n = Number(difficultySelect.value);
      if (n >= 1 && n <= 5) draft.difficulty = n as 1 | 2 | 3 | 4 | 5;
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

    const poolCheckbox = el('input', {
      type: 'checkbox',
    }) as HTMLInputElement;
    poolCheckbox.checked = draft.includeInCampaignPool;
    poolCheckbox.addEventListener('change', () => {
      draft.includeInCampaignPool = poolCheckbox.checked;
      // Re-render list so the "not in pool" badge updates while editing.
      renderList();
    });
    const poolWrap = el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '6px' },
      children: [
        poolCheckbox,
        el('span', {
          text: 'Include this mission in the random campaign pool',
          style: { fontSize: '12px' },
        }),
      ],
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

      const hint = (text: string): HTMLElement =>
        el('div', {
          text,
          style: { fontSize: '11px', color: '#7a9a7a', marginTop: '2px' },
        });

      const boolField = (
        label: string,
        key: string,
        help?: string,
      ): HTMLElement => {
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = !!draft.scenarioParams[key];
        cb.addEventListener('change', () => {
          if (cb.checked) draft.scenarioParams[key] = true;
          else delete draft.scenarioParams[key];
        });
        return el('label', {
          children: [
            cb,
            document.createTextNode(' ' + label),
            ...(help
              ? [
                  el('span', {
                    text: ' — ' + help,
                    style: { color: '#7a9a7a' },
                  }),
                ]
              : []),
          ],
          style: { fontSize: '12px', display: 'flex', alignItems: 'center' },
        });
      };

      if (draft.scenario === 'engage-reach') {
        paramsBox.appendChild(
          boolField(
            'requireAllObjectives',
            'requireAllObjectives',
            '同時佔領所有點位才算勝利',
          ),
        );
      } else if (draft.scenario === 'defend') {
        paramsBox.appendChild(
          numField('defendActivations', 'defendActivations', 999),
        );
        paramsBox.appendChild(
          boolField(
            'requireAllObjectives',
            'requireAllObjectives',
            '攻擊方需同時佔領所有點位才算失守',
          ),
        );
        paramsBox.appendChild(hint('玩家方累計啟動次數，超過則任務失敗'));
      } else if (draft.scenario === 'control-points') {
        paramsBox.appendChild(numField('winScore', 'winScore', 5));
        paramsBox.appendChild(numField('winLead', 'winLead', 2));
        paramsBox.appendChild(
          hint(
            '每個 cycle 結束結算分數；達 winScore 且領先對方 winLead 才獲勝',
          ),
        );
        // Per-objective weight rows: one numField per objective. Read/write
        // through `scenarioParams.objectiveWeights[<id>]`. Missing keys
        // default to 1 at scoring time.
        if (draft.objectives.length > 0) {
          const weightsRaw = draft.scenarioParams.objectiveWeights;
          const weights: Record<string, number> =
            weightsRaw && typeof weightsRaw === 'object'
              ? { ...(weightsRaw as Record<string, number>) }
              : {};
          draft.scenarioParams.objectiveWeights = weights;
          const wTable = el('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              padding: '4px 0',
            },
          });
          wTable.appendChild(
            el('div', {
              text: 'Per-objective weight (default 1)',
              style: { fontSize: '11px', color: '#9aa89a' },
            }),
          );
          for (const o of draft.objectives) {
            const inp = el('input', {
              type: 'number',
              value: String(weights[o.id] ?? 1),
              style: { width: '70px' },
            }) as HTMLInputElement;
            inp.addEventListener('input', () => {
              const n = Number(inp.value);
              if (Number.isFinite(n)) weights[o.id] = n;
            });
            wTable.appendChild(
              el('label', {
                children: [
                  document.createTextNode(o.id + ' '),
                  inp,
                ],
                style: { fontSize: '12px' },
              }),
            );
          }
          paramsBox.appendChild(wTable);
        }
      } else if (draft.scenario === 'extract') {
        paramsBox.appendChild(numField('extractCount', 'extractCount', 2));
        paramsBox.appendChild(
          numField('extractActivations', 'extractActivations', 999),
        );
        paramsBox.appendChild(hint('玩家方累計啟動次數，超過則任務失敗'));
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
            'assassinateActivations',
            'assassinateActivations',
            999,
          ),
        );
        paramsBox.appendChild(hint('玩家方累計啟動次數，超過則任務失敗'));
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
      const hostileSet = new Set(
        listFactions().filter((f) => f.hostile).map((f) => f.id),
      );
      const isEnemyEligible = (t: UnitTemplate): boolean =>
        tagsOf(t).some((tag) => hostileSet.has(tag));
      const templates = listUnitTemplates().filter(isEnemyEligible);
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
          if (Number.isFinite(n)) {
            e.position = { x: n, y: e.position.y };
            redrawCanvas();
          }
        });
        const yInp = el('input', {
          type: 'number',
          value: String(e.position.y),
          style: { width: '70px' },
        }) as HTMLInputElement;
        yInp.addEventListener('input', () => {
          const n = Number(yInp.value);
          if (Number.isFinite(n)) {
            e.position = { x: e.position.x, y: n };
            redrawCanvas();
          }
        });
        const delBtn = el('button', {
          text: '−',
          onclick: () => {
            draft.enemies.splice(idx, 1);
            if (canvasSelected?.kind === 'enemy' && canvasSelected.index === idx)
              canvasSelected = null;
            renderEnemies();
            renderScenarioParams(); // refresh VIP dropdown
            redrawCanvas();
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
          redrawCanvas();
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
          if (Number.isFinite(n)) {
            draft.playerSpawnPositions[idx] = { x: n, y: p.y };
            redrawCanvas();
          }
        });
        const yInp = el('input', {
          type: 'number',
          value: String(p.y),
          style: { width: '70px' },
        }) as HTMLInputElement;
        yInp.addEventListener('input', () => {
          const n = Number(yInp.value);
          if (Number.isFinite(n)) {
            draft.playerSpawnPositions[idx] = { x: p.x, y: n };
            redrawCanvas();
          }
        });
        const delBtn = el('button', {
          text: '−',
          onclick: () => {
            draft.playerSpawnPositions.splice(idx, 1);
            if (canvasSelected?.kind === 'spawn' && canvasSelected.index === idx)
              canvasSelected = null;
            renderSpawns();
            redrawCanvas();
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
          redrawCanvas();
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
          if (Number.isFinite(n)) {
            o.position = { x: n, y: o.position.y };
            redrawCanvas();
          }
        });
        const yInp = el('input', {
          type: 'number',
          value: String(o.position.y),
          style: { width: '70px' },
        }) as HTMLInputElement;
        yInp.addEventListener('input', () => {
          const n = Number(yInp.value);
          if (Number.isFinite(n)) {
            o.position = { x: o.position.x, y: n };
            redrawCanvas();
          }
        });
        const rInp = el('input', {
          type: 'number',
          value: String(o.radius),
          style: { width: '70px' },
        }) as HTMLInputElement;
        rInp.addEventListener('input', () => {
          const n = Number(rInp.value);
          if (Number.isFinite(n)) {
            o.radius = n;
            redrawCanvas();
          }
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
            if (canvasSelected?.kind === 'objective' && canvasSelected.index === idx)
              canvasSelected = null;
            renderObjectives();
            redrawCanvas();
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
          redrawCanvas();
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

    // ── Map preview canvas ─────────────────────────────────────────────
    const CANVAS_PX = 480;
    const canvas = el('canvas') as HTMLCanvasElement;
    canvas.width = CANVAS_PX;
    canvas.height = CANVAS_PX;
    canvas.style.cursor = 'crosshair';
    canvas.style.border = '1px solid #2a3a2a';
    canvas.style.background = '#0e120e';

    const TOOL_LIST: ReadonlyArray<CanvasTool> = [
      'select',
      'enemy',
      'spawn',
      'objective',
      'delete',
    ];
    const TOOL_LABELS: Record<CanvasTool, string> = {
      select: 'Select',
      enemy: '+ Enemy',
      spawn: '+ Spawn',
      objective: '+ Objective',
      delete: 'Delete',
    };
    const toolBar = el('div', {
      style: { display: 'flex', gap: '6px', marginBottom: '6px' },
    });
    const toolButtons: HTMLButtonElement[] = [];
    for (const t of TOOL_LIST) {
      const b = el('button', {
        text: TOOL_LABELS[t],
        onclick: () => {
          activeCanvasTool = t;
          for (let i = 0; i < TOOL_LIST.length; i++) {
            toolButtons[i]!.style.background =
              TOOL_LIST[i] === t ? '#2a4a2a' : '';
          }
          canvas.style.cursor =
            t === 'select' ? 'pointer' : t === 'delete' ? 'not-allowed' : 'crosshair';
        },
      }) as HTMLButtonElement;
      if (t === activeCanvasTool) b.style.background = '#2a4a2a';
      toolBar.appendChild(b);
      toolButtons.push(b);
    }

    const TERRAIN_FILL: Record<string, string> = {
      HARD: 'rgba(220,220,220,0.85)',
      LOW: 'rgba(180,180,180,0.55)',
      BLOCKER: 'rgba(50,50,50,0.95)',
      HIGH_GROUND: 'rgba(120,90,60,0.55)',
      DIFFICULT: 'rgba(160,120,70,0.45)',
      SOFT: 'rgba(220,220,220,0.25)',
    };
    const TERRAIN_STROKE: Record<string, string> = {
      HARD: '#dcdcdc',
      LOW: '#9aa89a',
      BLOCKER: '#000000',
      HIGH_GROUND: '#d8a76a',
      DIFFICULT: '#b8884a',
      SOFT: '#cfcfcf',
    };

    const getMapSafe = (id: string): MapDef | null => {
      try {
        return getMap(id);
      } catch {
        return null;
      }
    };

    redrawCanvas = (): void => {
      const ctx = canvas.getContext('2d')!;
      const mapDef = getMapSafe(draft.mapId);
      const mapSize = mapDef?.size ?? 768;
      const scale = CANVAS_PX / mapSize;

      ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
      ctx.save();
      ctx.scale(scale, scale);

      // 1-UD checker floor — same look as in-game battlefield.
      paintBoardFloorCanvas(ctx, mapSize);
      ctx.strokeStyle = '#2a3a2a';
      ctx.lineWidth = 2 / scale;
      ctx.strokeRect(0, 0, mapSize, mapSize);

      // Terrain polygons
      if (mapDef) {
        for (const t of mapDef.terrain) {
          const verts = t.polygon.vertices;
          if (verts.length < 3) continue;
          ctx.fillStyle = TERRAIN_FILL[t.kind] ?? 'rgba(180,180,180,0.4)';
          ctx.strokeStyle = TERRAIN_STROKE[t.kind] ?? '#9aa89a';
          ctx.lineWidth = 1.5 / scale;
          ctx.beginPath();
          ctx.moveTo(verts[0]!.x, verts[0]!.y);
          for (let i = 1; i < verts.length; i++) {
            ctx.lineTo(verts[i]!.x, verts[i]!.y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }

        // Deployment zones (faint)
        for (const z of mapDef.deploymentZones) {
          const verts = z.polygon.vertices;
          if (verts.length < 3) continue;
          ctx.fillStyle =
            z.faction === 'A'
              ? 'rgba(74,138,207,0.10)'
              : 'rgba(207,90,74,0.10)';
          ctx.strokeStyle =
            z.faction === 'A' ? 'rgba(106,176,255,0.5)' : 'rgba(255,138,106,0.5)';
          ctx.lineWidth = 1 / scale;
          ctx.beginPath();
          ctx.moveTo(verts[0]!.x, verts[0]!.y);
          for (let i = 1; i < verts.length; i++) {
            ctx.lineTo(verts[i]!.x, verts[i]!.y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }

        // Map-level objectives (read-only background) shown if mission
        // has none of its own — same logic the engine uses.
        if (draft.objectives.length === 0 && mapDef.objectives) {
          for (const o of mapDef.objectives) {
            ctx.fillStyle = 'rgba(255,209,102,0.10)';
            ctx.strokeStyle = '#ffd166';
            ctx.lineWidth = 1 / scale;
            ctx.beginPath();
            ctx.arc(o.position.x, o.position.y, o.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      } else {
        ctx.fillStyle = '#5a3a3a';
        ctx.font = `${24 / scale}px monospace`;
        ctx.fillText(`(map '${draft.mapId}' not found)`, 20, 40);
      }

      // Mission objectives (yellow filled circles)
      draft.objectives.forEach((o, idx) => {
        const sel =
          canvasSelected?.kind === 'objective' && canvasSelected.index === idx;
        ctx.fillStyle = 'rgba(255,209,102,0.18)';
        ctx.strokeStyle = sel ? '#ffffff' : '#ffd166';
        ctx.lineWidth = (sel ? 2.5 : 1.5) / scale;
        ctx.beginPath();
        ctx.arc(o.position.x, o.position.y, o.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Center marker
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(o.position.x, o.position.y, 3 / scale, 0, Math.PI * 2);
        ctx.fill();
      });

      // Player spawns (blue diamonds, numbered)
      draft.playerSpawnPositions.forEach((p, idx) => {
        const sel =
          canvasSelected?.kind === 'spawn' && canvasSelected.index === idx;
        ctx.fillStyle = 'rgba(74,138,207,0.85)';
        ctx.strokeStyle = sel ? '#ffffff' : '#cfe8ff';
        ctx.lineWidth = (sel ? 2.5 : 1.5) / scale;
        ctx.beginPath();
        const r = 9;
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `${10 / scale}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(String(idx + 1), p.x, p.y + 3 / scale);
        ctx.textAlign = 'start';
      });

      // Enemies (red dots with id labels; VIP gets a halo)
      const vipId = draft.scenarioParams.vipUnitId as string | undefined;
      draft.enemies.forEach((e, idx) => {
        const sel =
          canvasSelected?.kind === 'enemy' && canvasSelected.index === idx;
        const isVip = e.id === vipId;
        if (isVip) {
          ctx.strokeStyle = '#ffd166';
          ctx.lineWidth = 2 / scale;
          ctx.beginPath();
          ctx.arc(e.position.x, e.position.y, 14, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(207,90,74,0.95)';
        ctx.strokeStyle = sel ? '#ffffff' : '#ffcfcf';
        ctx.lineWidth = (sel ? 2.5 : 1.5) / scale;
        ctx.beginPath();
        ctx.arc(e.position.x, e.position.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `${9 / scale}px monospace`;
        ctx.fillText(e.id, e.position.x + 12, e.position.y + 3);
      });

      ctx.restore();
    };

    // ── Canvas pointer interaction ─────────────────────────────────────
    const toWorld = (
      clientX: number,
      clientY: number,
    ): Vec2 => {
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const mapDef = getMapSafe(draft.mapId);
      const mapSize = mapDef?.size ?? 768;
      const scale = CANVAS_PX / mapSize;
      return { x: px / scale, y: py / scale };
    };

    const hitTest = (
      wp: Vec2,
    ): { kind: 'enemy' | 'spawn' | 'objective'; index: number } | null => {
      // Enemies first (smallest), then spawns (diamond ~9px), then objectives (largest).
      for (let i = draft.enemies.length - 1; i >= 0; i--) {
        const e = draft.enemies[i]!;
        const dx = wp.x - e.position.x;
        const dy = wp.y - e.position.y;
        if (dx * dx + dy * dy <= 12 * 12) return { kind: 'enemy', index: i };
      }
      for (let i = draft.playerSpawnPositions.length - 1; i >= 0; i--) {
        const p = draft.playerSpawnPositions[i]!;
        const dx = wp.x - p.x;
        const dy = wp.y - p.y;
        if (dx * dx + dy * dy <= 12 * 12) return { kind: 'spawn', index: i };
      }
      for (let i = draft.objectives.length - 1; i >= 0; i--) {
        const o = draft.objectives[i]!;
        const dx = wp.x - o.position.x;
        const dy = wp.y - o.position.y;
        if (dx * dx + dy * dy <= o.radius * o.radius) {
          return { kind: 'objective', index: i };
        }
      }
      return null;
    };

    let dragging:
      | { kind: 'enemy' | 'spawn' | 'objective'; index: number; offX: number; offY: number }
      | null = null;

    const onPointerDown = (e: PointerEvent): void => {
      const wp = toWorld(e.clientX, e.clientY);
      canvas.setPointerCapture(e.pointerId);

      if (activeCanvasTool === 'select') {
        const hit = hitTest(wp);
        if (hit) {
          canvasSelected = hit;
          let pos: Vec2;
          if (hit.kind === 'enemy') pos = draft.enemies[hit.index]!.position;
          else if (hit.kind === 'spawn')
            pos = draft.playerSpawnPositions[hit.index]!;
          else pos = draft.objectives[hit.index]!.position;
          dragging = {
            kind: hit.kind,
            index: hit.index,
            offX: wp.x - pos.x,
            offY: wp.y - pos.y,
          };
          redrawCanvas();
        } else {
          canvasSelected = null;
          redrawCanvas();
        }
      } else if (activeCanvasTool === 'delete') {
        const hit = hitTest(wp);
        if (!hit) return;
        if (hit.kind === 'enemy') draft.enemies.splice(hit.index, 1);
        else if (hit.kind === 'spawn')
          draft.playerSpawnPositions.splice(hit.index, 1);
        else draft.objectives.splice(hit.index, 1);
        canvasSelected = null;
        renderEnemies();
        renderSpawns();
        renderObjectives();
        renderScenarioParams();
        redrawCanvas();
      } else if (activeCanvasTool === 'enemy') {
        const hostileSet = new Set(
          listFactions().filter((f) => f.hostile).map((f) => f.id),
        );
        const tpls = listUnitTemplates().filter((t) =>
          tagsOf(t).some((tag) => hostileSet.has(tag)),
        );
        const newId = `e${draft.enemies.length + 1}`;
        draft.enemies.push({
          id: newId,
          templateId: tpls[0]?.templateId ?? '',
          position: { x: Math.round(wp.x), y: Math.round(wp.y) },
        });
        canvasSelected = { kind: 'enemy', index: draft.enemies.length - 1 };
        dragging = {
          kind: 'enemy',
          index: draft.enemies.length - 1,
          offX: 0,
          offY: 0,
        };
        renderEnemies();
        renderScenarioParams();
        redrawCanvas();
      } else if (activeCanvasTool === 'spawn') {
        draft.playerSpawnPositions.push({
          x: Math.round(wp.x),
          y: Math.round(wp.y),
        });
        canvasSelected = {
          kind: 'spawn',
          index: draft.playerSpawnPositions.length - 1,
        };
        dragging = {
          kind: 'spawn',
          index: draft.playerSpawnPositions.length - 1,
          offX: 0,
          offY: 0,
        };
        renderSpawns();
        redrawCanvas();
      } else if (activeCanvasTool === 'objective') {
        draft.objectives.push({
          id: `obj-${draft.objectives.length + 1}`,
          position: { x: Math.round(wp.x), y: Math.round(wp.y) },
          radius: 36,
        });
        canvasSelected = {
          kind: 'objective',
          index: draft.objectives.length - 1,
        };
        dragging = {
          kind: 'objective',
          index: draft.objectives.length - 1,
          offX: 0,
          offY: 0,
        };
        renderObjectives();
        redrawCanvas();
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const wp = toWorld(e.clientX, e.clientY);
      const newPos = {
        x: Math.round(wp.x - dragging.offX),
        y: Math.round(wp.y - dragging.offY),
      };
      if (dragging.kind === 'enemy') {
        draft.enemies[dragging.index]!.position = newPos;
      } else if (dragging.kind === 'spawn') {
        draft.playerSpawnPositions[dragging.index] = newPos;
      } else {
        draft.objectives[dragging.index]!.position = newPos;
      }
      redrawCanvas();
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (!dragging) return;
      canvas.releasePointerCapture(e.pointerId);
      // Reflect the new position into the form inputs.
      if (dragging.kind === 'enemy') renderEnemies();
      else if (dragging.kind === 'spawn') renderSpawns();
      else renderObjectives();
      dragging = null;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    const canvasSection = el('div', {
      style: { marginBottom: '12px' },
      children: [
        toolBar,
        canvas,
        el('div', {
          className: 'help',
          text:
            'Pick a tool, then click on the map. Select+drag moves an item. Delete removes the item under the cursor.',
          style: { marginTop: '4px', color: '#7a9a7a', fontSize: '11px' },
        }),
      ],
    });
    formPanel.appendChild(canvasSection);
    redrawCanvas();

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
    formPanel.appendChild(
      row('difficulty', difficultySelect, '1 (易) – 5 (爆難); operation picker 用此值篩選候選與限制 round cap.'),
    );
    formPanel.appendChild(row('enemyFaction', factionSelect));
    formPanel.appendChild(row('campaign pool', poolWrap));
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

    const saveToBundleBtn = el('button', {
      text: '⤒ Save to bundle',
      onclick: async () => {
        if (!draft.id) { alert('id is required'); return; }
        try {
          const result = await saveToBundleEndpoint('mission', draft.id, fromDraft(draft));
          alert(`Saved to ${result.path}\n\nThe JSON file is now part of the bundle. Commit it to make it permanent.`);
        } catch (e) {
          alert(`Save to bundle failed: ${(e as Error).message}`);
        }
      },
    }) as HTMLButtonElement;
    saveToBundleBtn.title = 'Write to src/config/missions/<id>.json (dev server only)';
    if (!import.meta.env.DEV) saveToBundleBtn.style.display = 'none';

    formPanel.appendChild(
      el('div', {
        className: 'actions',
        children: [saveBtn, exportSingleBtn, cloneBtn, revertBtn, deleteBtn, saveToBundleBtn],
      }),
    );
  };

  grid.appendChild(listPanel);
  grid.appendChild(formPanel);
  root.appendChild(grid);

  refresh();
};
