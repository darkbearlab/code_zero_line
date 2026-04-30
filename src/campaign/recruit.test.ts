import { describe, it, expect } from 'vitest';
import { Rng } from '../core/rng/sfc32';
import type { RosterEntry } from '../core/setup/types';
import { listBundledTemplates } from '../config/loader';
import { POOL_TARGET, ROLE_TARGETS, replenishPool } from './recruit';

const r = (id: string, templateId: string): RosterEntry => ({ id, templateId });

const roleOf = (e: RosterEntry): string =>
  listBundledTemplates().find((t) => t.templateId === e.templateId)
    ?.recruitRole ?? 'regular';

const counts = (pool: ReadonlyArray<RosterEntry>) => {
  const c = { officer: 0, specialist: 0, regular: 0 } as Record<string, number>;
  for (const e of pool) c[roleOf(e)] += 1;
  return c;
};

describe('replenishPool', () => {
  it('tops empty pool up to POOL_TARGET with the target role mix', () => {
    const { pool } = replenishPool([], Rng.fromSeed('s1'), 1);
    expect(pool).toHaveLength(POOL_TARGET);
    const c = counts(pool);
    expect(c.officer).toBe(ROLE_TARGETS.officer);
    expect(c.specialist).toBe(ROLE_TARGETS.specialist);
    expect(c.regular).toBe(ROLE_TARGETS.regular);
  });

  it('preserves existing pool members and only fills the deficit', () => {
    const seed: RosterEntry[] = [
      r('p1', 'squad_lead'),
      r('p2', 'elite'),
      r('p3', 'trooper'),
    ];
    const { pool, nextRecruitId } = replenishPool(seed, Rng.fromSeed('s2'), 4);
    expect(pool).toHaveLength(POOL_TARGET);
    // Original three are still there.
    for (const e of seed) {
      expect(pool.find((p) => p.id === e.id)).toBeDefined();
    }
    // nextRecruitId advanced by exactly the deficit.
    expect(nextRecruitId).toBe(4 + (POOL_TARGET - seed.length));
  });

  it('hits the officer floor even when starting with zero officers', () => {
    const seed: RosterEntry[] = Array.from({ length: 5 }, (_, i) =>
      r(`p${i + 1}`, 'trooper'),
    );
    const { pool } = replenishPool(seed, Rng.fromSeed('s3'), 6);
    expect(counts(pool).officer).toBeGreaterThanOrEqual(ROLE_TARGETS.officer);
  });

  it('does not shrink an already-oversized pool', () => {
    const big: RosterEntry[] = Array.from({ length: POOL_TARGET + 5 }, (_, i) =>
      r(`p${i + 1}`, 'trooper'),
    );
    const { pool } = replenishPool(big, Rng.fromSeed('s4'), POOL_TARGET + 6);
    expect(pool).toHaveLength(big.length);
  });

  it('is deterministic for the same seed and input', () => {
    const a = replenishPool([], Rng.fromSeed('seed-x'), 1);
    const b = replenishPool([], Rng.fromSeed('seed-x'), 1);
    expect(a.pool.map((e) => e.templateId)).toEqual(
      b.pool.map((e) => e.templateId),
    );
  });

  it('assigns sequential pool-N ids starting from nextRecruitId', () => {
    const { pool } = replenishPool([], Rng.fromSeed('s5'), 100);
    const ids = pool.map((e) => e.id);
    expect(ids[0]).toBe('pool-100');
    expect(ids[POOL_TARGET - 1]).toBe(`pool-${100 + POOL_TARGET - 1}`);
  });
});
