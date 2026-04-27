/**
 * sfc32 — Simple Fast Counter PRNG (public domain).
 * 128-bit state, period > 2^96. Fast and good enough for game determinism.
 * https://pracrand.sourceforge.net/RNG_engines.txt
 */

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

const xmur3Hash = (str: string): number => {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
};

export const sfc32Seed = (seed: number | string): RngState => {
  let h = typeof seed === 'string' ? xmur3Hash(seed) : seed | 0;
  const next = (): number => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  return { a: next(), b: next(), c: next(), d: next() };
};

export const sfc32Next = (s: RngState): number => {
  s.a |= 0;
  s.b |= 0;
  s.c |= 0;
  s.d |= 0;
  const t = (((s.a + s.b) | 0) + s.d) | 0;
  s.d = (s.d + 1) | 0;
  s.a = s.b ^ (s.b >>> 9);
  s.b = (s.c + (s.c << 3)) | 0;
  s.c = (s.c << 21) | (s.c >>> 11);
  s.c = (s.c + t) | 0;
  return (t >>> 0) / 4294967296;
};

export class Rng {
  constructor(public readonly state: RngState) {}

  static fromSeed(seed: number | string): Rng {
    return new Rng(sfc32Seed(seed));
  }

  next(): number {
    return sfc32Next(this.state);
  }

  /** Roll a die with `sides` faces. Returns 1..sides. */
  rollDie(sides: number): number {
    return Math.floor(this.next() * sides) + 1;
  }

  rollDice(count: number, sides: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.rollDie(sides));
    return out;
  }

  clone(): Rng {
    return new Rng({ ...this.state });
  }
}

/**
 * Derive a deterministic child RNG from the given parts. Used to give every
 * Command its own independent RNG stream — e.g.,
 *   const rng = deriveRng(gameSeed, commandIndex, 'shoot:hits');
 *
 * Same parts → same RNG sequence. Different parts → independent sequences.
 * Crucially, this does NOT mutate any parent state, so replays are stable
 * regardless of read order.
 */
export const deriveRng = (...parts: ReadonlyArray<string | number>): Rng => {
  return Rng.fromSeed(parts.join('|'));
};

export const countHits = (
  rolls: ReadonlyArray<number>,
  threshold: number,
): number => {
  let n = 0;
  for (const r of rolls) if (r >= threshold) n++;
  return n;
};
