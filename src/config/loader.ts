import type { Unit, Weapon } from '../core/state/GameState';
import type { Vec2 } from '../core/geometry/types';
import type { MapDef } from '../core/setup/types';
import type { MissionDef } from '../missions/types';
import { v2 } from '../core/geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../core/rules/constants';
import { docToMapDef, type EditorMapDoc } from './mapDoc';
import {
  BUNDLED_WEAPONS,
  BUNDLED_TEMPLATES,
  BUNDLED_MAPS,
  BUNDLED_MISSIONS,
} from './bundles.gen';

export type RecruitRole = 'officer' | 'specialist' | 'regular';

export interface UnitTemplate {
  readonly templateId: string;
  readonly displayName: string;
  readonly quality: number;
  readonly weaponIds: ReadonlyArray<string>;
  readonly traits: ReadonlyArray<string>;
  /**
   * Optional faction tags for future faction restrictions ('blue', 'red',
   * 'militia'). Empty/absent = available to anyone.
   */
  readonly factionTags?: ReadonlyArray<string>;
  /**
   * Slot category used by the round draft picker (`src/rounds/draft.ts`).
   * Slot 1 prefers `officer`, slot 2 prefers `specialist`, slots 3+ exclude
   * officers. Undefined = `regular` (back-compat).
   */
  readonly recruitRole?: RecruitRole;
  /**
   * Sprite key for the BattleScene renderer. When set, the renderer looks
   * up textures `${spriteKey}-A` / `${spriteKey}-B` and shows them in
   * place of the procedural faction-colored circle. Unset, or texture
   * not loaded → falls back to the circle. Asset files live under
   * `public/assets/units/` and are registered in
   * `src/presentation/assets/spriteManifest.ts`.
   */
  readonly spriteKey?: string;
}

const EDITOR_WEAPON_KEY = 'czl.editor.weapons.v1';
const EDITOR_TEMPLATE_KEY = 'czl.editor.templates.v1';
const EDITOR_MAP_KEY = 'czl.editor.maps.v1';

const safeReadLocal = <T>(key: string): T[] => {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

/** Merge bundled list with localStorage overrides; custom items replace by id. */
const mergedWeapons = (): ReadonlyArray<Weapon> => {
  const custom = safeReadLocal<Weapon>(EDITOR_WEAPON_KEY);
  if (custom.length === 0) return BUNDLED_WEAPONS;
  const byId = new Map<string, Weapon>();
  for (const w of BUNDLED_WEAPONS) byId.set(w.id, w);
  for (const w of custom) byId.set(w.id, w);
  return [...byId.values()];
};

const mergedTemplates = (): ReadonlyArray<UnitTemplate> => {
  const custom = safeReadLocal<UnitTemplate>(EDITOR_TEMPLATE_KEY);
  if (custom.length === 0) return BUNDLED_TEMPLATES;
  const byId = new Map<string, UnitTemplate>();
  for (const t of BUNDLED_TEMPLATES) byId.set(t.templateId, t);
  for (const t of custom) byId.set(t.templateId, t);
  return [...byId.values()];
};

export const getWeapon = (id: string): Weapon => {
  const w = mergedWeapons().find((x) => x.id === id);
  if (!w) throw new Error(`Unknown weapon id: ${id}`);
  return w;
};

export const getUnitTemplate = (templateId: string): UnitTemplate => {
  const t = mergedTemplates().find((x) => x.templateId === templateId);
  if (!t) throw new Error(`Unknown unit template: ${templateId}`);
  return t;
};

export const listUnitTemplates = (): ReadonlyArray<UnitTemplate> =>
  mergedTemplates();

export const listWeapons = (): ReadonlyArray<Weapon> => mergedWeapons();

export const listBundledWeapons = (): ReadonlyArray<Weapon> => BUNDLED_WEAPONS;
export const listBundledTemplates = (): ReadonlyArray<UnitTemplate> =>
  BUNDLED_TEMPLATES;

export interface UnitSpawn {
  readonly id: string;
  readonly templateId: string;
  readonly faction: 'A' | 'B';
  readonly position: Vec2;
}

export const buildUnit = (spawn: UnitSpawn): Unit => {
  const tpl = getUnitTemplate(spawn.templateId);
  return {
    id: spawn.id,
    templateId: spawn.templateId,
    faction: spawn.faction,
    position: v2(spawn.position.x, spawn.position.y),
    radius: STANDARD_BASE_RADIUS_PIXELS,
    quality: tpl.quality,
    damage: 'NONE',
    stance: 'STANDING',
    weapons: tpl.weaponIds.map(getWeapon),
    traits: [...tpl.traits],
    activatedThisRound: false,
    cannotReactThisRound: false,
  };
};

/**
 * Runtime-registered editor map docs — used by the headless sim CLI so
 * Node can play maps that normally live in browser localStorage. Last-write
 * wins on id collision.
 */
const runtimeMaps: EditorMapDoc[] = [];

export const registerRuntimeMaps = (
  docs: ReadonlyArray<EditorMapDoc>,
): void => {
  for (const d of docs) {
    const idx = runtimeMaps.findIndex((x) => x.id === d.id);
    if (idx >= 0) runtimeMaps.splice(idx, 1);
    runtimeMaps.push(d);
  }
};

const mergedMaps = (): ReadonlyArray<MapDef> => {
  const localDocs = safeReadLocal<EditorMapDoc>(EDITOR_MAP_KEY);
  if (runtimeMaps.length === 0 && localDocs.length === 0) return BUNDLED_MAPS;
  const byId = new Map<string, MapDef>();
  for (const m of BUNDLED_MAPS) byId.set(m.id, m);
  // Order: localStorage overlays bundled, runtime overlays everything (CLI
  // explicitly imported a JSON, so it should win over a stale localStorage
  // entry of the same id).
  for (const d of localDocs) byId.set(d.id, docToMapDef(d));
  for (const d of runtimeMaps) byId.set(d.id, docToMapDef(d));
  return [...byId.values()];
};

export const getMap = (id: string): MapDef => {
  const m = mergedMaps().find((x) => x.id === id);
  if (!m) throw new Error(`Unknown map id: ${id}`);
  return m;
};

export const listMaps = (): ReadonlyArray<MapDef> => mergedMaps();

export const listBundledMaps = (): ReadonlyArray<MapDef> => BUNDLED_MAPS;

// ── Missions ──────────────────────────────────────────────────────────────
//
// Same overlay pattern as weapons / templates / maps: bundled JSON → custom
// localStorage overlays by id. The mission editor (Phase C) populates the
// localStorage layer; bundled missions ship in `src/config/missions/*.json`.

const EDITOR_MISSION_KEY = 'czl.editor.missions.v1';

const mergedMissions = (): ReadonlyArray<MissionDef> => {
  const custom = safeReadLocal<MissionDef>(EDITOR_MISSION_KEY);
  if (custom.length === 0) return BUNDLED_MISSIONS;
  const byId = new Map<string, MissionDef>();
  for (const m of BUNDLED_MISSIONS) byId.set(m.id, m);
  for (const m of custom) byId.set(m.id, m);
  return [...byId.values()];
};

export const getMissionDef = (id: string): MissionDef => {
  const m = mergedMissions().find((x) => x.id === id);
  if (!m) throw new Error(`Unknown mission id: ${id}`);
  return m;
};

export const listMissionDefs = (): ReadonlyArray<MissionDef> => mergedMissions();

export const listBundledMissionDefs = (): ReadonlyArray<MissionDef> =>
  BUNDLED_MISSIONS;
