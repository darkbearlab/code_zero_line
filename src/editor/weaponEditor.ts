import {
  listBundledWeapons,
  listWeapons,
} from '../config/loader';
import type { Weapon, WeaponMode, WeaponKind } from '../core/state/GameState';
import { el, pillInput } from './dom';
import { downloadJson, pickJsonFile, saveToBundleEndpoint, timestampForFilename } from './io';
import {
  loadCustomWeapons,
  removeCustomWeapon,
  upsertCustomWeapon,
} from './storage';

interface WeaponDraft {
  id: string;
  modes: WeaponMode[];
  kind: WeaponKind;
  diceCount: number;
  threshold: number;
  descriptors: string[];
}

const toDraft = (w: Weapon): WeaponDraft => ({
  id: w.id,
  modes: [...w.modes],
  kind: w.kind,
  diceCount: w.diceCount,
  threshold: w.threshold,
  descriptors: [...w.descriptors],
});

const fromDraft = (d: WeaponDraft): Weapon => ({
  id: d.id,
  modes: [...d.modes],
  kind: d.kind,
  diceCount: d.diceCount,
  threshold: d.threshold,
  descriptors: [...d.descriptors],
});

const isCustom = (id: string): boolean =>
  loadCustomWeapons().some((w) => w.id === id);

export const mountWeaponEditor = (root: HTMLElement): void => {
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
      text: '+ New weapon',
      onclick: () => {
        let id = 'new-weapon';
        let i = 1;
        while (listWeapons().some((w) => w.id === id)) {
          id = `new-weapon-${++i}`;
        }
        upsertCustomWeapon({
          id,
          modes: ['ACTIVE'],
          kind: 'SHOOT',
          diceCount: 2,
          threshold: 5,
          descriptors: [],
        });
        selectedId = id;
        refresh();
      },
    });
    toolbar.appendChild(newBtn);

    const exportBtn = el('button', {
      text: '⤓ Export',
      onclick: () => {
        const customs = loadCustomWeapons();
        if (customs.length === 0) {
          alert('No custom weapons to export.');
          return;
        }
        downloadJson(`czl-weapons-${timestampForFilename()}.json`, customs);
      },
    });
    exportBtn.title = 'Download all custom weapons as JSON';
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
            const w = item as Weapon;
            if (!w?.id || !w.modes || !w.kind) {
              alert(`Skipped invalid entry: ${JSON.stringify(item).slice(0, 80)}`);
              continue;
            }
            upsertCustomWeapon({ ...w });
            added += 1;
          }
          alert(`Imported ${added} weapon(s).`);
          refresh();
        } catch (e) {
          alert(`Import failed: ${(e as Error).message}`);
        }
      },
    });
    importBtn.title = 'Merge weapons from a JSON file (existing ids overwritten)';
    toolbar.appendChild(importBtn);
    listPanel.appendChild(toolbar);

    const all = listWeapons();
    const bundledIds = new Set(listBundledWeapons().map((w) => w.id));
    for (const w of all) {
      const isOverride = isCustom(w.id);
      const isBundledOnly = bundledIds.has(w.id) && !isOverride;
      const row = el('div', {
        className: `row${selectedId === w.id ? ' active' : ''}`,
        onclick: () => {
          selectedId = w.id;
          refresh();
        },
      });
      const title = el('div', {
        children: [
          document.createTextNode(w.id),
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
        text: `${w.kind} · ${w.modes.join('/')} · ${w.diceCount}d/${w.threshold}+${
          w.descriptors.length ? ` · ${w.descriptors.join(', ')}` : ''
        }`,
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
          text: 'Pick a weapon from the list, or create a new one.',
        }),
      );
      return;
    }
    const w = listWeapons().find((x) => x.id === selectedId);
    if (!w) {
      selectedId = null;
      renderForm();
      return;
    }
    const draft = toDraft(w);
    const isBundled = listBundledWeapons().some((x) => x.id === w.id);
    const overrideExists = isCustom(w.id);

    const idInput = el('input', {
      type: 'text',
      value: draft.id,
      style: { width: '200px' },
    }) as HTMLInputElement;
    idInput.addEventListener('input', () => {
      draft.id = idInput.value.trim();
    });

    const modeBoxes: ReadonlyArray<['ACTIVE' | 'REACTION', HTMLInputElement]> =
      (['ACTIVE', 'REACTION'] as const).map((m) => {
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = draft.modes.includes(m);
        cb.addEventListener('change', () => {
          if (cb.checked && !draft.modes.includes(m)) draft.modes.push(m);
          else if (!cb.checked) draft.modes = draft.modes.filter((x) => x !== m);
        });
        return [m, cb];
      });

    const kindSelect = el('select') as HTMLSelectElement;
    for (const k of ['SHOOT', 'MELEE'] as const) {
      const o = el('option', { value: k, text: k });
      kindSelect.appendChild(o);
    }
    kindSelect.value = draft.kind;
    kindSelect.addEventListener('change', () => {
      draft.kind = kindSelect.value as WeaponKind;
    });

    const diceInput = el('input', {
      type: 'number',
      value: String(draft.diceCount),
      style: { width: '80px' },
    }) as HTMLInputElement;
    diceInput.addEventListener('input', () => {
      draft.diceCount = Math.max(0, Number(diceInput.value) || 0);
    });

    const thresholdInput = el('input', {
      type: 'number',
      value: String(draft.threshold),
      style: { width: '80px' },
    }) as HTMLInputElement;
    thresholdInput.addEventListener('input', () => {
      draft.threshold = Math.max(2, Math.min(7, Number(thresholdInput.value) || 5));
    });

    const descriptorPills = pillInput(
      draft.descriptors,
      (next) => (draft.descriptors = next),
      'e.g. FOCUSED, ARMOR_PIERCE:2, RELOAD',
    );

    const row = (label: string, input: HTMLElement, help?: string): HTMLElement =>
      el('div', {
        className: 'row',
        children: [
          el('label', { text: label }),
          el('div', {
            children: [
              input,
              ...(help
                ? [el('div', { className: 'help', text: help })]
                : []),
            ],
          }),
        ],
      });

    formPanel.appendChild(
      row('id', idInput, 'Unique identifier; overrides bundled weapon if same id.'),
    );
    formPanel.appendChild(
      row(
        'modes',
        el('div', {
          className: 'checkbox-row',
          children: modeBoxes.map(([name, cb]) =>
            el('label', { children: [cb, document.createTextNode(' ' + name)] }),
          ),
        }),
        'ACTIVE = usable as own action; REACTION = usable for reaction fire.',
      ),
    );
    formPanel.appendChild(row('kind', kindSelect, 'SHOOT or MELEE.'));
    formPanel.appendChild(row('diceCount', diceInput));
    formPanel.appendChild(
      row('threshold', thresholdInput, 'Hit on roll ≥ threshold (2..7).'),
    );
    formPanel.appendChild(
      row(
        'descriptors',
        descriptorPills,
        'Type and press Enter or comma. Examples: FOCUSED, COMBINED, IGNORE_COVER, BLAST, ARMOR_PIERCE:2, RELOAD.',
      ),
    );

    const saveBtn = el('button', {
      text: 'Save',
      onclick: () => {
        if (!draft.id) {
          alert('id is required');
          return;
        }
        // If renaming, remove old custom under previous id.
        if (overrideExists && draft.id !== w.id) {
          removeCustomWeapon(w.id);
        }
        upsertCustomWeapon(fromDraft(draft));
        selectedId = draft.id;
        refresh();
      },
    });
    const revertBtn = el('button', {
      text: 'Revert to bundled',
      onclick: () => {
        if (!isBundled) return;
        if (overrideExists) {
          removeCustomWeapon(w.id);
        }
        refresh();
      },
    }) as HTMLButtonElement;
    revertBtn.disabled = !isBundled || !overrideExists;

    const deleteBtn = el('button', {
      className: 'danger',
      text: isBundled ? 'Delete (bundled — disabled)' : 'Delete',
      onclick: () => {
        if (isBundled) return;
        if (!confirm(`Delete custom weapon '${w.id}'?`)) return;
        removeCustomWeapon(w.id);
        selectedId = null;
        refresh();
      },
    }) as HTMLButtonElement;
    deleteBtn.disabled = isBundled;

    const cloneBtn = el('button', {
      text: 'Clone as new',
      onclick: () => {
        let newId = `${w.id}-copy`;
        let i = 1;
        while (listWeapons().some((x) => x.id === newId)) {
          newId = `${w.id}-copy-${++i}`;
        }
        upsertCustomWeapon({ ...fromDraft(draft), id: newId });
        selectedId = newId;
        refresh();
      },
    });

    const saveToBundleBtn = el('button', {
      text: '⤒ Save to bundle',
      onclick: async () => {
        if (!draft.id) { alert('id is required'); return; }
        try {
          const result = await saveToBundleEndpoint('weapon', draft.id, fromDraft(draft));
          alert(`Saved to ${result.path}\n\nThe JSON file is now part of the bundle. Commit it to make it permanent.`);
        } catch (e) {
          alert(`Save to bundle failed: ${(e as Error).message}`);
        }
      },
    }) as HTMLButtonElement;
    saveToBundleBtn.title = 'Write to src/config/weapons/<id>.json (dev server only)';
    if (!import.meta.env.DEV) saveToBundleBtn.style.display = 'none';

    formPanel.appendChild(
      el('div', {
        className: 'actions',
        children: [saveBtn, cloneBtn, revertBtn, deleteBtn, saveToBundleBtn],
      }),
    );
  };

  grid.appendChild(listPanel);
  grid.appendChild(formPanel);
  root.appendChild(grid);
  refresh();
};
