import type { Weapon } from '../core/state/GameState';
import type { UnitTemplate } from '../config/loader';
import type { EditorMapDoc } from '../config/mapDoc';
import type { MissionDef } from '../missions/types';

const WEAPON_KEY = 'czl.editor.weapons.v1';
const TEMPLATE_KEY = 'czl.editor.templates.v1';
const MAP_KEY = 'czl.editor.maps.v1';
const MISSION_KEY = 'czl.editor.missions.v1';

export interface CustomWeapon extends Weapon {
  /** Marker so future editor versions can migrate. */
  readonly _custom?: true;
}

export interface CustomTemplate extends UnitTemplate {
  readonly _custom?: true;
}

const safeParse = <T>(raw: string | null): T[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

export const loadCustomWeapons = (): CustomWeapon[] =>
  safeParse<CustomWeapon>(localStorage.getItem(WEAPON_KEY));

export const saveCustomWeapons = (list: ReadonlyArray<CustomWeapon>): void => {
  localStorage.setItem(WEAPON_KEY, JSON.stringify(list));
};

export const loadCustomTemplates = (): CustomTemplate[] =>
  safeParse<CustomTemplate>(localStorage.getItem(TEMPLATE_KEY));

export const saveCustomTemplates = (
  list: ReadonlyArray<CustomTemplate>,
): void => {
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(list));
};

export const upsertCustomWeapon = (w: CustomWeapon): void => {
  const list = loadCustomWeapons().filter((x) => x.id !== w.id);
  list.push({ ...w, _custom: true });
  saveCustomWeapons(list);
};

export const removeCustomWeapon = (id: string): void => {
  saveCustomWeapons(loadCustomWeapons().filter((w) => w.id !== id));
};

export const upsertCustomTemplate = (t: CustomTemplate): void => {
  const list = loadCustomTemplates().filter((x) => x.templateId !== t.templateId);
  list.push({ ...t, _custom: true });
  saveCustomTemplates(list);
};

export const removeCustomTemplate = (templateId: string): void => {
  saveCustomTemplates(
    loadCustomTemplates().filter((t) => t.templateId !== templateId),
  );
};

export const loadCustomMaps = (): EditorMapDoc[] =>
  safeParse<EditorMapDoc>(localStorage.getItem(MAP_KEY));

export const saveCustomMaps = (list: ReadonlyArray<EditorMapDoc>): void => {
  localStorage.setItem(MAP_KEY, JSON.stringify(list));
};

export const upsertCustomMap = (m: EditorMapDoc): void => {
  const list = loadCustomMaps().filter((x) => x.id !== m.id);
  list.push({ ...m, _custom: true });
  saveCustomMaps(list);
};

export const removeCustomMap = (id: string): void => {
  saveCustomMaps(loadCustomMaps().filter((m) => m.id !== id));
};

export interface CustomMission extends MissionDef {
  readonly _custom?: true;
}

export const loadCustomMissions = (): CustomMission[] =>
  safeParse<CustomMission>(localStorage.getItem(MISSION_KEY));

export const saveCustomMissions = (
  list: ReadonlyArray<CustomMission>,
): void => {
  localStorage.setItem(MISSION_KEY, JSON.stringify(list));
};

export const upsertCustomMission = (m: CustomMission): void => {
  const list = loadCustomMissions().filter((x) => x.id !== m.id);
  list.push({ ...m, _custom: true });
  saveCustomMissions(list);
};

export const removeCustomMission = (id: string): void => {
  saveCustomMissions(loadCustomMissions().filter((m) => m.id !== id));
};

export const resetAllCustomData = (): void => {
  localStorage.removeItem(WEAPON_KEY);
  localStorage.removeItem(TEMPLATE_KEY);
  localStorage.removeItem(MAP_KEY);
  localStorage.removeItem(MISSION_KEY);
};
