import type { Unit, Weapon } from '../core/state/GameState';
import type { Vec2 } from '../core/geometry/types';
import type { MapDef } from '../core/setup/types';
import { v2 } from '../core/geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../core/rules/constants';

import rifleJson from './weapons/rifle.json';
import smgJson from './weapons/smg.json';
import heavyRifleJson from './weapons/heavy_rifle.json';
import bladeJson from './weapons/blade.json';
import rpgJson from './weapons/rpg.json';

import trooperJson from './units/trooper.json';
import eliteJson from './units/elite.json';
import conscriptJson from './units/conscript.json';
import heavyGunnerJson from './units/heavy_gunner.json';
import squadLeadJson from './units/squad_lead.json';
import veteranJson from './units/veteran.json';

import demoMapJson from './maps/demo.json';

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
}

const WEAPONS: ReadonlyArray<Weapon> = [
  rifleJson,
  smgJson,
  heavyRifleJson,
  bladeJson,
  rpgJson,
] as Weapon[];

const TEMPLATES: ReadonlyArray<UnitTemplate> = [
  trooperJson,
  eliteJson,
  conscriptJson,
  heavyGunnerJson,
  squadLeadJson,
  veteranJson,
];

export const getWeapon = (id: string): Weapon => {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`Unknown weapon id: ${id}`);
  return w;
};

export const getUnitTemplate = (templateId: string): UnitTemplate => {
  const t = TEMPLATES.find((x) => x.templateId === templateId);
  if (!t) throw new Error(`Unknown unit template: ${templateId}`);
  return t;
};

export const listUnitTemplates = (): ReadonlyArray<UnitTemplate> => TEMPLATES;

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

const MAPS: ReadonlyArray<MapDef> = [demoMapJson as MapDef];

export const getMap = (id: string): MapDef => {
  const m = MAPS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown map id: ${id}`);
  return m;
};

export const listMaps = (): ReadonlyArray<MapDef> => MAPS;
