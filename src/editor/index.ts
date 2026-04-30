import { mountWeaponEditor } from './weaponEditor';
import { mountUnitEditor } from './unitEditor';
import { mountMapEditor } from './mapEditor';
import { mountMissionEditor } from './missionEditor';
import { downloadJson, pickJsonFile, timestampForFilename } from './io';
import {
  loadCustomMaps,
  loadCustomMissions,
  loadCustomTemplates,
  loadCustomWeapons,
  upsertCustomMap,
  upsertCustomMission,
  upsertCustomTemplate,
  upsertCustomWeapon,
} from './storage';
import type { EditorMapDoc } from '../config/mapDoc';
import type { Weapon } from '../core/state/GameState';
import type { UnitTemplate } from '../config/loader';
import type { MissionDef } from '../missions/types';

type Tab = 'weapons' | 'units' | 'maps' | 'missions';

interface Bundle {
  version: 1;
  exportedAt: string;
  weapons: Weapon[];
  templates: UnitTemplate[];
  maps: EditorMapDoc[];
  missions?: MissionDef[];
}

const main = document.getElementById('editor-main')!;
const tabs = document.querySelectorAll<HTMLButtonElement>('header .tab');

const setActive = (tab: Tab): void => {
  tabs.forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  main.innerHTML = '';
  if (tab === 'weapons') mountWeaponEditor(main);
  else if (tab === 'units') mountUnitEditor(main);
  else if (tab === 'maps') mountMapEditor(main);
  else mountMissionEditor(main);
  // Persist last tab selection.
  try {
    localStorage.setItem('czl.editor.lastTab', tab);
  } catch {
    /* ignore */
  }
};

tabs.forEach((b) => {
  b.addEventListener('click', () => setActive(b.dataset.tab as Tab));
});

const initialTab =
  (localStorage.getItem('czl.editor.lastTab') as Tab | null) ?? 'weapons';
setActive(initialTab);

// --- Bundle export / import (header-level) --------------------------------

const bundleExportBtn = document.getElementById(
  'bundle-export',
) as HTMLButtonElement | null;
const bundleImportBtn = document.getElementById(
  'bundle-import',
) as HTMLButtonElement | null;

if (bundleExportBtn) {
  bundleExportBtn.onclick = (): void => {
    const bundle: Bundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      weapons: loadCustomWeapons(),
      templates: loadCustomTemplates(),
      maps: loadCustomMaps(),
      missions: loadCustomMissions(),
    };
    if (
      bundle.weapons.length === 0 &&
      bundle.templates.length === 0 &&
      bundle.maps.length === 0 &&
      (bundle.missions?.length ?? 0) === 0
    ) {
      alert('No custom data to export.');
      return;
    }
    downloadJson(`czl-bundle-${timestampForFilename()}.json`, bundle);
  };
}

if (bundleImportBtn) {
  bundleImportBtn.onclick = async (): Promise<void> => {
    try {
      const data = await pickJsonFile();
      if (!data) return;
      const bundle = data as Partial<Bundle>;
      if (typeof bundle !== 'object' || bundle === null) {
        alert('Invalid bundle file.');
        return;
      }
      let weapons = 0;
      let templates = 0;
      let maps = 0;
      let missions = 0;
      for (const w of bundle.weapons ?? []) {
        if (w?.id) {
          upsertCustomWeapon({ ...w });
          weapons += 1;
        }
      }
      for (const t of bundle.templates ?? []) {
        if (t?.templateId) {
          upsertCustomTemplate({ ...t });
          templates += 1;
        }
      }
      for (const m of bundle.maps ?? []) {
        if (m?.id && m.shapes) {
          upsertCustomMap({ ...m });
          maps += 1;
        }
      }
      for (const ms of bundle.missions ?? []) {
        if (ms?.id && ms.scenario && Array.isArray(ms.enemies)) {
          upsertCustomMission({ ...ms });
          missions += 1;
        }
      }
      alert(
        `Imported bundle: ${weapons} weapons, ${templates} templates, ${maps} maps, ${missions} missions.`,
      );
      // Reload current tab so it reflects the imported data.
      const cur =
        (localStorage.getItem('czl.editor.lastTab') as Tab | null) ?? 'weapons';
      setActive(cur);
    } catch (e) {
      alert(`Bundle import failed: ${(e as Error).message}`);
    }
  };
}
