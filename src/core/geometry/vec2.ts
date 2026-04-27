import type { Vec2 } from './types';

export const v2 = (x: number, y: number): Vec2 => ({ x, y });

export const v2Add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const v2Sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const v2Scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });

export const v2Dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const v2Cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const v2LenSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const v2Len = (a: Vec2): number => Math.sqrt(v2LenSq(a));

export const v2DistSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const v2Dist = (a: Vec2, b: Vec2): number => Math.sqrt(v2DistSq(a, b));

export const v2Normalize = (a: Vec2): Vec2 => {
  const len = v2Len(a);
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
};

export const v2Lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
