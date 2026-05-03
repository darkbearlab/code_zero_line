/**
 * Smoke tests for bundled JSON content. Catches malformed entries and broken
 * cross-references at test time, before they reach the running game.
 *
 * Authoring a JSON file with a missing field, a duplicate id, or a dangling
 * mapId / templateId / weaponId reference will turn this suite red — much
 * faster feedback than discovering it in BattleScene.
 */
import { describe, it, expect } from 'vitest';
import {
  listBundledWeapons,
  listBundledTemplates,
  listBundledMaps,
  listBundledMissionDefs,
} from './loader';

describe('bundled weapons', () => {
  const weapons = listBundledWeapons();

  it('has at least one weapon', () => {
    expect(weapons.length).toBeGreaterThan(0);
  });

  it('every weapon has the required fields', () => {
    for (const w of weapons) {
      expect(w.id, `weapon ${w.id ?? '(missing id)'}`).toBeTruthy();
      expect(Array.isArray(w.modes), `${w.id} modes`).toBe(true);
      expect(w.modes.length, `${w.id} modes`).toBeGreaterThan(0);
      expect(['SHOOT', 'MELEE'], `${w.id} kind`).toContain(w.kind);
      expect(typeof w.diceCount, `${w.id} diceCount`).toBe('number');
      expect(typeof w.threshold, `${w.id} threshold`).toBe('number');
      expect(Array.isArray(w.descriptors), `${w.id} descriptors`).toBe(true);
    }
  });

  it('weapon ids are unique', () => {
    const ids = weapons.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('bundled unit templates', () => {
  const templates = listBundledTemplates();
  const weaponIds = new Set(listBundledWeapons().map((w) => w.id));

  it('has at least one template', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it('every template has the required fields', () => {
    for (const t of templates) {
      expect(t.templateId, `template ${t.templateId ?? '(missing id)'}`).toBeTruthy();
      expect(t.displayName, `${t.templateId} displayName`).toBeTruthy();
      expect(typeof t.quality, `${t.templateId} quality`).toBe('number');
      expect(Array.isArray(t.weaponIds), `${t.templateId} weaponIds`).toBe(true);
      expect(Array.isArray(t.traits), `${t.templateId} traits`).toBe(true);
    }
  });

  it('templateIds are unique', () => {
    const ids = templates.map((t) => t.templateId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every weaponId reference resolves to a bundled weapon', () => {
    for (const t of templates) {
      for (const wid of t.weaponIds) {
        expect(
          weaponIds.has(wid),
          `template '${t.templateId}' references unknown weapon '${wid}'`,
        ).toBe(true);
      }
    }
  });
});

describe('bundled maps', () => {
  const maps = listBundledMaps();

  it('has at least one map', () => {
    expect(maps.length).toBeGreaterThan(0);
  });

  it('every map has the required fields', () => {
    for (const m of maps) {
      expect(m.id, `map ${m.id ?? '(missing id)'}`).toBeTruthy();
      expect(m.displayName, `${m.id} displayName`).toBeTruthy();
      expect(typeof m.size, `${m.id} size`).toBe('number');
      expect(Array.isArray(m.terrain), `${m.id} terrain`).toBe(true);
    }
  });

  it('map ids are unique', () => {
    const ids = maps.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('bundled missions', () => {
  const missions = listBundledMissionDefs();
  const mapIds = new Set(listBundledMaps().map((m) => m.id));
  const templateIds = new Set(
    listBundledTemplates().map((t) => t.templateId),
  );

  it('has at least one mission', () => {
    expect(missions.length).toBeGreaterThan(0);
  });

  it('every mission has the required fields', () => {
    for (const m of missions) {
      expect(m.id, `mission ${m.id ?? '(missing id)'}`).toBeTruthy();
      expect(m.displayName, `${m.id} displayName`).toBeTruthy();
      expect(m.description, `${m.id} description`).toBeTruthy();
      expect(m.mapId, `${m.id} mapId`).toBeTruthy();
      expect(
        ['engage-reach', 'elimination', 'defend', 'extract', 'assassinate', 'control-points'],
        `${m.id} scenario`,
      ).toContain(m.scenario);
      expect(Array.isArray(m.enemies), `${m.id} enemies`).toBe(true);
      expect(
        Array.isArray(m.playerSpawnPositions),
        `${m.id} playerSpawnPositions`,
      ).toBe(true);
      expect(['A', 'B'], `${m.id} enemyFaction`).toContain(m.enemyFaction);
    }
  });

  it('mission ids are unique', () => {
    const ids = missions.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every mapId reference resolves to a bundled map', () => {
    for (const m of missions) {
      expect(
        mapIds.has(m.mapId),
        `mission '${m.id}' references unknown map '${m.mapId}'`,
      ).toBe(true);
    }
  });

  it('every enemy templateId resolves to a bundled template', () => {
    for (const m of missions) {
      for (const e of m.enemies) {
        expect(
          templateIds.has(e.templateId),
          `mission '${m.id}' enemy '${e.id}' references unknown template '${e.templateId}'`,
        ).toBe(true);
      }
    }
  });

  it('enemy ids within each mission are unique', () => {
    for (const m of missions) {
      const ids = m.enemies.map((e) => e.id);
      expect(
        new Set(ids).size,
        `mission '${m.id}' has duplicate enemy ids`,
      ).toBe(ids.length);
    }
  });

  it('assassinate missions have a vipUnitId that names one of their enemies', () => {
    for (const m of missions) {
      if (m.scenario !== 'assassinate') continue;
      const vipId = (m.scenarioParams as { vipUnitId?: string } | undefined)
        ?.vipUnitId;
      expect(vipId, `mission '${m.id}' missing vipUnitId`).toBeTruthy();
      expect(
        m.enemies.some((e) => e.id === vipId),
        `mission '${m.id}' vipUnitId '${vipId}' not found among enemies`,
      ).toBe(true);
    }
  });

  it('extract missions specify a positive extractCount', () => {
    for (const m of missions) {
      if (m.scenario !== 'extract') continue;
      const count = (m.scenarioParams as { extractCount?: number } | undefined)
        ?.extractCount;
      expect(typeof count, `mission '${m.id}' extractCount`).toBe('number');
      expect(count, `mission '${m.id}' extractCount`).toBeGreaterThan(0);
    }
  });

  it('engage-reach and defend missions have at least one objective', () => {
    for (const m of missions) {
      if (m.scenario !== 'engage-reach' && m.scenario !== 'defend') continue;
      expect(
        (m.objectives ?? []).length,
        `mission '${m.id}' (${m.scenario}) needs an objective`,
      ).toBeGreaterThan(0);
    }
  });

  it('every mission has at least one player spawn position', () => {
    for (const m of missions) {
      expect(
        m.playerSpawnPositions.length,
        `mission '${m.id}' playerSpawnPositions empty`,
      ).toBeGreaterThan(0);
    }
  });
});
