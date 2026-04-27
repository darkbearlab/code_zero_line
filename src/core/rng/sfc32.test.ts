import { describe, it, expect } from 'vitest';
import { Rng, countHits, deriveRng } from './sfc32';

describe('sfc32 RNG', () => {
  it('produces identical sequences from the same string seed', () => {
    const a = Rng.fromSeed('test');
    const b = Rng.fromSeed('test');
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences from different seeds', () => {
    const a = Rng.fromSeed('alpha');
    const b = Rng.fromSeed('beta');
    expect(a.next()).not.toEqual(b.next());
  });

  it('rollDie returns integer in [1, sides]', () => {
    const r = Rng.fromSeed('die');
    for (let i = 0; i < 200; i++) {
      const v = r.rollDie(6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('rollDice has expected length', () => {
    const r = Rng.fromSeed('roll');
    expect(r.rollDice(5, 6)).toHaveLength(5);
  });

  it('clone is independent of source after mutation', () => {
    const a = Rng.fromSeed('clone');
    const b = a.clone();
    a.next();
    a.next();
    a.next();
    expect(b.next()).toEqual(Rng.fromSeed('clone').next());
  });
});

describe('deriveRng', () => {
  it('same parts → same sequence', () => {
    const a = deriveRng('game-1', 5, 'shoot:hits');
    const b = deriveRng('game-1', 5, 'shoot:hits');
    expect(a.next()).toEqual(b.next());
    expect(a.next()).toEqual(b.next());
  });

  it('different command index → different sequence', () => {
    const a = deriveRng('game-1', 5, 'shoot:hits');
    const b = deriveRng('game-1', 6, 'shoot:hits');
    expect(a.next()).not.toEqual(b.next());
  });

  it('different label → different sequence even at same index', () => {
    const a = deriveRng('game-1', 5, 'shoot:hits');
    const b = deriveRng('game-1', 5, 'activation:check');
    expect(a.next()).not.toEqual(b.next());
  });
});

describe('countHits', () => {
  it('counts rolls >= threshold', () => {
    expect(countHits([1, 2, 3, 4, 5, 6], 5)).toBe(2);
    expect(countHits([6, 6, 6], 5)).toBe(3);
    expect(countHits([1, 2, 3], 5)).toBe(0);
  });
});
