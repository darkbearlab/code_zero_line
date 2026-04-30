import { describe, it, expect } from 'vitest';
import { Rng } from '../core/rng/sfc32';
import { draftSquad } from './draft';
import type { RosterEntry } from '../core/setup/types';

const r = (id: string, templateId: string): RosterEntry => ({ id, templateId });

// Bundled roles: squad_lead=officer, elite=specialist, heavy_gunner=specialist,
// trooper/veteran/conscript = regular (no recruitRole field).
const STARTER_POOL: ReadonlyArray<RosterEntry> = [
  r('p1', 'squad_lead'),
  r('p2', 'elite'),
  r('p3', 'elite'),
  r('p4', 'heavy_gunner'),
  r('p5', 'veteran'),
  r('p6', 'veteran'),
  r('p7', 'trooper'),
  r('p8', 'trooper'),
  r('p9', 'trooper'),
  r('p10', 'trooper'),
  r('p11', 'conscript'),
  r('p12', 'conscript'),
];

const isOfficer = (e: RosterEntry): boolean => e.templateId === 'squad_lead';
const isSpecialist = (e: RosterEntry): boolean =>
  e.templateId === 'elite' || e.templateId === 'heavy_gunner';

describe('draftSquad', () => {
  it('is deterministic for the same seed and pool', () => {
    const a = draftSquad(STARTER_POOL, 4, Rng.fromSeed('seed-x'));
    const b = draftSquad(STARTER_POOL, 4, Rng.fromSeed('seed-x'));
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  it('slot 1 is an officer when the pool contains one', () => {
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      const picks = draftSquad(STARTER_POOL, 4, Rng.fromSeed(seed));
      expect(isOfficer(picks[0]!)).toBe(true);
    }
  });

  it('falls back to non-officer for slot 1 when no officer is present', () => {
    const noOfficer = STARTER_POOL.filter((e) => !isOfficer(e));
    for (const seed of ['s1', 's2', 's3']) {
      const picks = draftSquad(noOfficer, 4, Rng.fromSeed(seed));
      expect(picks).toHaveLength(4);
      expect(isOfficer(picks[0]!)).toBe(false);
    }
  });

  it('slot 2 is a specialist when one is available', () => {
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      const picks = draftSquad(STARTER_POOL, 4, Rng.fromSeed(seed));
      expect(isSpecialist(picks[1]!)).toBe(true);
    }
  });

  it('slots 3+ exclude officers when non-officers remain', () => {
    // Pool with multiple officers but enough non-officers to fill the rest.
    const multiOfficer: RosterEntry[] = [
      r('o1', 'squad_lead'),
      r('o2', 'squad_lead'),
      r('o3', 'squad_lead'),
      r('s1', 'elite'),
      r('s2', 'heavy_gunner'),
      r('rg1', 'trooper'),
      r('rg2', 'trooper'),
      r('rg3', 'conscript'),
    ];
    for (const seed of ['s1', 's2', 's3', 's4']) {
      const picks = draftSquad(multiOfficer, 4, Rng.fromSeed(seed));
      expect(picks).toHaveLength(4);
      expect(isOfficer(picks[0]!)).toBe(true);
      // Slots 3 and 4 must not be officers — non-officers are still available.
      expect(isOfficer(picks[2]!)).toBe(false);
      expect(isOfficer(picks[3]!)).toBe(false);
    }
  });

  it('returns the whole pool when size exceeds pool length', () => {
    const tiny: RosterEntry[] = [r('a', 'trooper'), r('b', 'conscript')];
    const picks = draftSquad(tiny, 4, Rng.fromSeed('s'));
    expect(picks).toHaveLength(2);
    expect(new Set(picks.map((e) => e.id))).toEqual(new Set(['a', 'b']));
  });

  it('returns no duplicate units', () => {
    for (const seed of ['s1', 's2', 's3']) {
      const picks = draftSquad(STARTER_POOL, 4, Rng.fromSeed(seed));
      expect(new Set(picks.map((e) => e.id)).size).toBe(picks.length);
    }
  });
});
