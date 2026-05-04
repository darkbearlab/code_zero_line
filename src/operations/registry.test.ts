/**
 * Bundled operation sanity. Mirrors the schema validation we run against
 * bundled missions in `src/config/bundles.test.ts` — every shipped operation
 * must declare the fields the picker relies on, point at known mission ids
 * (when `mainMissionId` is pinned), and stay within the 1-5 difficulty band.
 */
import { describe, it, expect } from 'vitest';
import { listBundledOperations } from './registry';
import { listBundledMissions } from '../missions/library';
import type { ScenarioMode } from '../core/scenario/victory';

const SCENARIO_MODES: ReadonlyArray<ScenarioMode> = [
  'engage-reach',
  'elimination',
  'defend',
  'extract',
  'assassinate',
  'control-points',
];

describe('bundled operations', () => {
  const ops = listBundledOperations();
  const missionIds = new Set(listBundledMissions().map((m) => m.id));

  it('has at least one operation', () => {
    expect(ops.length).toBeGreaterThan(0);
  });

  it('every operation has the required scalar fields', () => {
    for (const o of ops) {
      expect(o.id, `operation ${o.id ?? '(missing id)'}`).toBeTruthy();
      expect(o.displayName, `${o.id} displayName`).toBeTruthy();
      expect(o.description, `${o.id} description`).toBeTruthy();
      expect([1, 2, 3, 4, 5], `${o.id} difficulty`).toContain(o.difficulty);
      expect(o.chain, `${o.id} chain`).toBeDefined();
      expect(o.rewards, `${o.id} rewards`).toBeDefined();
    }
  });

  it('operation ids are unique', () => {
    const ids = ops.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('chain.eliminations is in 1..4', () => {
    for (const o of ops) {
      expect(
        o.chain.eliminations,
        `${o.id} chain.eliminations`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        o.chain.eliminations,
        `${o.id} chain.eliminations`,
      ).toBeLessThanOrEqual(4);
    }
  });

  it('elimDifficultyBand is a valid [min, max] within 1..5', () => {
    for (const o of ops) {
      const [lo, hi] = o.chain.elimDifficultyBand;
      expect(lo, `${o.id} band low`).toBeGreaterThanOrEqual(1);
      expect(hi, `${o.id} band high`).toBeLessThanOrEqual(5);
      expect(lo, `${o.id} band ordering`).toBeLessThanOrEqual(hi);
    }
  });

  it('elimModeFilter (when set) only references valid scenario modes', () => {
    for (const o of ops) {
      const filter = o.chain.elimModeFilter;
      if (!filter) continue;
      for (const m of filter) {
        expect(SCENARIO_MODES, `${o.id} elimModeFilter`).toContain(m);
      }
    }
  });

  it('mainMissionId (when set) points at a real bundled mission', () => {
    for (const o of ops) {
      const mid = o.chain.mainMissionId;
      if (!mid) continue;
      expect(
        missionIds.has(mid),
        `${o.id} mainMissionId '${mid}' missing from library`,
      ).toBe(true);
    }
  });

  it('mainConstraints (when set) uses valid scenario modes and band', () => {
    for (const o of ops) {
      const c = o.chain.mainConstraints;
      if (!c) continue;
      for (const m of c.modes ?? []) {
        expect(SCENARIO_MODES, `${o.id} mainConstraints.modes`).toContain(m);
      }
      if (c.difficultyBand) {
        const [lo, hi] = c.difficultyBand;
        expect(lo, `${o.id} mainConstraints band low`).toBeGreaterThanOrEqual(1);
        expect(hi, `${o.id} mainConstraints band high`).toBeLessThanOrEqual(5);
        expect(lo, `${o.id} mainConstraints band ordering`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('every operation pins the main mission OR provides constraints', () => {
    for (const o of ops) {
      const hasPin = !!o.chain.mainMissionId;
      const hasConstraints = !!o.chain.mainConstraints;
      expect(
        hasPin || hasConstraints,
        `${o.id} chain needs mainMissionId or mainConstraints`,
      ).toBe(true);
    }
  });

  it('rewards declare both perStage and onComplete with all currency keys', () => {
    for (const o of ops) {
      for (const phase of ['perStage', 'onComplete'] as const) {
        const r = o.rewards[phase];
        expect(typeof r.tactical, `${o.id} ${phase}.tactical`).toBe('number');
        expect(typeof r.regional, `${o.id} ${phase}.regional`).toBe('number');
        expect(typeof r.honor, `${o.id} ${phase}.honor`).toBe('number');
      }
    }
  });
});
