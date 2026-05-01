import {
  listBundledTemplates,
  listUnitTemplates,
  listWeapons,
  type RecruitRole,
  type UnitTemplate,
} from '../config/loader';
import { TRAITS } from '../core/traits/registry';
import { el, pillInput } from './dom';
import { downloadJson, pickJsonFile, saveToBundleEndpoint, timestampForFilename } from './io';
import {
  loadCustomTemplates,
  removeCustomTemplate,
  upsertCustomTemplate,
} from './storage';

interface TemplateDraft {
  templateId: string;
  displayName: string;
  quality: number;
  weaponIds: string[];
  traits: string[];
  recruitRole: RecruitRole;
  spriteKey: string;
}

const ROLE_LABEL: Record<RecruitRole, string> = {
  officer: '士官 (officer)',
  specialist: '專家 (specialist)',
  regular: '一般 (regular)',
};
const ROLE_BADGE: Record<RecruitRole, string> = {
  officer: 'O',
  specialist: 'S',
  regular: 'R',
};

const toDraft = (t: UnitTemplate): TemplateDraft => ({
  templateId: t.templateId,
  displayName: t.displayName,
  quality: t.quality,
  weaponIds: [...t.weaponIds],
  traits: [...t.traits],
  recruitRole: t.recruitRole ?? 'regular',
  spriteKey: t.spriteKey ?? '',
});

const fromDraft = (d: TemplateDraft): UnitTemplate => {
  const out: UnitTemplate = {
    templateId: d.templateId,
    displayName: d.displayName,
    quality: d.quality,
    weaponIds: [...d.weaponIds],
    traits: [...d.traits],
    // Only include recruitRole when non-default, so JSON files stay tidy.
    ...(d.recruitRole !== 'regular' ? { recruitRole: d.recruitRole } : {}),
    ...(d.spriteKey.trim() !== '' ? { spriteKey: d.spriteKey.trim() } : {}),
  };
  return out;
};

const isCustom = (id: string): boolean =>
  loadCustomTemplates().some((t) => t.templateId === id);

export const mountUnitEditor = (root: HTMLElement): void => {
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
      text: '+ New unit template',
      onclick: () => {
        let id = 'new-unit';
        let i = 1;
        while (listUnitTemplates().some((t) => t.templateId === id)) {
          id = `new-unit-${++i}`;
        }
        upsertCustomTemplate({
          templateId: id,
          displayName: id,
          quality: 4,
          weaponIds: [],
          traits: [],
        });
        selectedId = id;
        refresh();
      },
    });
    toolbar.appendChild(newBtn);

    const exportBtn = el('button', {
      text: '⤓ Export',
      onclick: () => {
        const customs = loadCustomTemplates();
        if (customs.length === 0) {
          alert('No custom unit templates to export.');
          return;
        }
        downloadJson(`czl-units-${timestampForFilename()}.json`, customs);
      },
    });
    exportBtn.title = 'Download all custom unit templates as JSON';
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
            const t = item as UnitTemplate;
            if (!t?.templateId || !t.displayName) {
              alert(`Skipped invalid entry: ${JSON.stringify(item).slice(0, 80)}`);
              continue;
            }
            upsertCustomTemplate({ ...t });
            added += 1;
          }
          alert(`Imported ${added} template(s).`);
          refresh();
        } catch (e) {
          alert(`Import failed: ${(e as Error).message}`);
        }
      },
    });
    importBtn.title = 'Merge templates from a JSON file (existing ids overwritten)';
    toolbar.appendChild(importBtn);
    listPanel.appendChild(toolbar);

    const all = listUnitTemplates();
    const bundledIds = new Set(listBundledTemplates().map((t) => t.templateId));
    for (const t of all) {
      const isOverride = isCustom(t.templateId);
      const isBundledOnly = bundledIds.has(t.templateId) && !isOverride;
      const row = el('div', {
        className: `row${selectedId === t.templateId ? ' active' : ''}`,
        onclick: () => {
          selectedId = t.templateId;
          refresh();
        },
      });
      const role = t.recruitRole ?? 'regular';
      const roleBadge = el('span', {
        className: 'badge',
        text: ROLE_BADGE[role],
      });
      roleBadge.title = ROLE_LABEL[role];
      const title = el('div', {
        children: [
          document.createTextNode(`${t.displayName} (${t.templateId})`),
          roleBadge,
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
        text: `q${t.quality}+ · ${t.weaponIds.join(', ') || 'no weapons'}${
          t.traits.length ? ` · ${t.traits.join(', ')}` : ''
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
          text: 'Pick a template from the list, or create a new one.',
        }),
      );
      return;
    }
    const t = listUnitTemplates().find((x) => x.templateId === selectedId);
    if (!t) {
      selectedId = null;
      renderForm();
      return;
    }
    const draft = toDraft(t);
    const isBundled = listBundledTemplates().some(
      (x) => x.templateId === t.templateId,
    );
    const overrideExists = isCustom(t.templateId);

    const idInput = el('input', {
      type: 'text',
      value: draft.templateId,
      style: { width: '200px' },
    }) as HTMLInputElement;
    idInput.addEventListener('input', () => {
      draft.templateId = idInput.value.trim();
    });

    const nameInput = el('input', {
      type: 'text',
      value: draft.displayName,
      style: { width: '240px' },
    }) as HTMLInputElement;
    nameInput.addEventListener('input', () => {
      draft.displayName = nameInput.value;
    });

    const qInput = el('input', {
      type: 'number',
      value: String(draft.quality),
      style: { width: '80px' },
    }) as HTMLInputElement;
    qInput.addEventListener('input', () => {
      draft.quality = Math.max(1, Math.min(7, Number(qInput.value) || 4));
    });

    const roleSelect = el('select') as HTMLSelectElement;
    for (const r of ['officer', 'specialist', 'regular'] as const) {
      const opt = el('option', {
        value: r,
        text: ROLE_LABEL[r],
      }) as HTMLOptionElement;
      if (r === draft.recruitRole) opt.selected = true;
      roleSelect.appendChild(opt);
    }
    roleSelect.addEventListener('change', () => {
      draft.recruitRole = roleSelect.value as RecruitRole;
    });

    const spriteInput = el('input', {
      type: 'text',
      value: draft.spriteKey,
      style: { width: '200px' },
    }) as HTMLInputElement;
    spriteInput.addEventListener('input', () => {
      draft.spriteKey = spriteInput.value;
    });

    // Weapon multi-pick: render as checkboxes for each available weapon.
    const weaponBoxes = el('div', { className: 'checkbox-row' });
    for (const w of listWeapons()) {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = draft.weaponIds.includes(w.id);
      cb.addEventListener('change', () => {
        if (cb.checked && !draft.weaponIds.includes(w.id)) {
          draft.weaponIds.push(w.id);
        } else if (!cb.checked) {
          draft.weaponIds = draft.weaponIds.filter((x) => x !== w.id);
        }
      });
      weaponBoxes.appendChild(
        el('label', {
          children: [
            cb,
            document.createTextNode(
              ` ${w.id} (${w.kind}, ${w.diceCount}d/${w.threshold}+)`,
            ),
          ],
        }),
      );
    }

    const traitPills = pillInput(
      draft.traits,
      (next) => (draft.traits = next),
      'e.g. OFFICER, STALWART, ARMOR:1',
    );

    const traitHints = Object.values(TRAITS)
      .map((td) => `${td.id}${td.tbd ? ' (TBD)' : ''}`)
      .join(', ');

    const row = (
      label: string,
      input: HTMLElement,
      help?: string,
    ): HTMLElement =>
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
      row(
        'templateId',
        idInput,
        'Unique id; overrides bundled template if same id.',
      ),
    );
    formPanel.appendChild(row('displayName', nameInput));
    formPanel.appendChild(
      row('quality', qInput, '1..7 (lower = better, e.g. 2+).'),
    );
    formPanel.appendChild(
      row(
        'recruit role',
        roleSelect,
        'Slot draft category. Slot 1 prefers officer, slot 2 prefers specialist, slots 3+ exclude officers.',
      ),
    );
    formPanel.appendChild(
      row(
        'spriteKey',
        spriteInput,
        '對應 spriteManifest.ts 的 key。空白 = 用程式繪製圓形。',
      ),
    );
    formPanel.appendChild(
      row(
        'weapons',
        weaponBoxes,
        'Tick each weapon this template carries. Edit weapons in the Weapons tab.',
      ),
    );
    formPanel.appendChild(
      row(
        'traits',
        traitPills,
        `Type and press Enter. Known: ${traitHints}.`,
      ),
    );

    const saveBtn = el('button', {
      text: 'Save',
      onclick: () => {
        if (!draft.templateId) {
          alert('templateId is required');
          return;
        }
        if (overrideExists && draft.templateId !== t.templateId) {
          removeCustomTemplate(t.templateId);
        }
        upsertCustomTemplate(fromDraft(draft));
        selectedId = draft.templateId;
        refresh();
      },
    });
    const revertBtn = el('button', {
      text: 'Revert to bundled',
      onclick: () => {
        if (!isBundled || !overrideExists) return;
        removeCustomTemplate(t.templateId);
        refresh();
      },
    }) as HTMLButtonElement;
    revertBtn.disabled = !isBundled || !overrideExists;

    const deleteBtn = el('button', {
      className: 'danger',
      text: isBundled ? 'Delete (bundled — disabled)' : 'Delete',
      onclick: () => {
        if (isBundled) return;
        if (!confirm(`Delete custom template '${t.templateId}'?`)) return;
        removeCustomTemplate(t.templateId);
        selectedId = null;
        refresh();
      },
    }) as HTMLButtonElement;
    deleteBtn.disabled = isBundled;

    const cloneBtn = el('button', {
      text: 'Clone as new',
      onclick: () => {
        let newId = `${t.templateId}-copy`;
        let i = 1;
        while (
          listUnitTemplates().some((x) => x.templateId === newId)
        ) {
          newId = `${t.templateId}-copy-${++i}`;
        }
        upsertCustomTemplate({ ...fromDraft(draft), templateId: newId });
        selectedId = newId;
        refresh();
      },
    });

    const saveToBundleBtn = el('button', {
      text: '⤒ Save to bundle',
      onclick: async () => {
        if (!draft.templateId) { alert('templateId is required'); return; }
        try {
          const result = await saveToBundleEndpoint('unit', draft.templateId, fromDraft(draft));
          alert(`Saved to ${result.path}\n\nThe JSON file is now part of the bundle. Commit it to make it permanent.`);
        } catch (e) {
          alert(`Save to bundle failed: ${(e as Error).message}`);
        }
      },
    }) as HTMLButtonElement;
    saveToBundleBtn.title = 'Write to src/config/units/<templateId>.json (dev server only)';
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
