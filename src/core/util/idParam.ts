/**
 * Shared parser for `ID`, `ID:N`, or `ID(N)` strings used by traits and
 * weapon descriptors. Bare ID resolves to `{ id, param: 0 }`. Garbage
 * params fall back to 0.
 */
export interface IdParam {
  readonly id: string;
  readonly param: number;
}

export const parseIdParam = (raw: string): IdParam => {
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const value = Number(raw.slice(colon + 1));
    return {
      id: raw.slice(0, colon).trim(),
      param: Number.isFinite(value) ? value : 0,
    };
  }
  const paren = raw.indexOf('(');
  if (paren > 0) {
    const close = raw.indexOf(')', paren);
    const inner =
      close > 0 ? raw.slice(paren + 1, close) : raw.slice(paren + 1);
    const value = Number(inner);
    return {
      id: raw.slice(0, paren).trim(),
      param: Number.isFinite(value) ? value : 0,
    };
  }
  return { id: raw, param: 0 };
};
