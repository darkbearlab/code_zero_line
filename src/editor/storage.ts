import type { Weapon } from '../core/state/GameState';
import type { Faction, UnitTemplate } from '../config/loader';
import type { EditorMapDoc } from '../config/mapDoc';
import type { MissionDef } from '../missions/types';
import { enqueueSync } from './serverSync';

const WEAPON_KEY = 'czl.editor.weapons.v1';
const TEMPLATE_KEY = 'czl.editor.templates.v1';
const MAP_KEY = 'czl.editor.maps.v1';
const MISSION_KEY = 'czl.editor.missions.v1';
const FACTION_KEY = 'czl.editor.factions.v1';

// Strip the editor-only `_custom` marker so the canonical file in
// src/config/<dir>/<id>.json doesn't carry editor metadata.
const stripCustomMarker = <T extends { _custom?: true }>(v: T): Omit<T, '_custom'> => {
  const { _custom: _ignored, ...rest } = v;
  return rest;
};

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
  enqueueSync({ type: 'weapon', id: w.id, op: 'upsert', payload: stripCustomMarker(w) });
};

export const removeCustomWeapon = (id: string): void => {
  saveCustomWeapons(loadCustomWeapons().filter((w) => w.id !== id));
  enqueueSync({ type: 'weapon', id, op: 'delete' });
};

export const upsertCustomTemplate = (t: CustomTemplate): void => {
  const list = loadCustomTemplates();
  const idx = list.findIndex((x) => x.templateId === t.templateId);
  const next: CustomTemplate = { ...t, _custom: true };
  // Update in place; same reasoning as upsertCustomFaction.
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  saveCustomTemplates(list);
  enqueueSync({
    type: 'unit',
    id: t.templateId,
    op: 'upsert',
    payload: stripCustomMarker(t),
  });
};

export const removeCustomTemplate = (templateId: string): void => {
  saveCustomTemplates(
    loadCustomTemplates().filter((t) => t.templateId !== templateId),
  );
  enqueueSync({ type: 'unit', id: templateId, op: 'delete' });
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
  enqueueSync({ type: 'map', id: m.id, op: 'upsert', payload: stripCustomMarker(m) });
};

export const removeCustomMap = (id: string): void => {
  saveCustomMaps(loadCustomMaps().filter((m) => m.id !== id));
  enqueueSync({ type: 'map', id, op: 'delete' });
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
  enqueueSync({ type: 'mission', id: m.id, op: 'upsert', payload: stripCustomMarker(m) });
};

export const removeCustomMission = (id: string): void => {
  saveCustomMissions(loadCustomMissions().filter((m) => m.id !== id));
  enqueueSync({ type: 'mission', id, op: 'delete' });
};

export interface CustomFaction extends Faction {
  readonly _custom?: true;
}

export const loadCustomFactions = (): CustomFaction[] =>
  safeParse<CustomFaction>(localStorage.getItem(FACTION_KEY));

export const saveCustomFactions = (
  list: ReadonlyArray<CustomFaction>,
): void => {
  localStorage.setItem(FACTION_KEY, JSON.stringify(list));
};

export const upsertCustomFaction = (f: CustomFaction): void => {
  const list = loadCustomFactions();
  const idx = list.findIndex((x) => x.id === f.id);
  const next: CustomFaction = { ...f, _custom: true };
  // Update in place so editing a faction does not silently reorder it to
  // the tail of the list (which made the Factions tab visually reshuffle
  // both panels on every edit).
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  saveCustomFactions(list);
  enqueueSync({ type: 'faction', id: f.id, op: 'upsert', payload: stripCustomMarker(f) });
};

export const removeCustomFaction = (id: string): void => {
  saveCustomFactions(loadCustomFactions().filter((f) => f.id !== id));
  enqueueSync({ type: 'faction', id, op: 'delete' });
};

export const resetAllCustomData = (): void => {
  localStorage.removeItem(WEAPON_KEY);
  localStorage.removeItem(TEMPLATE_KEY);
  localStorage.removeItem(MAP_KEY);
  localStorage.removeItem(MISSION_KEY);
  localStorage.removeItem(FACTION_KEY);
  localStorage.removeItem('czl.editor.pending.v1');
};
