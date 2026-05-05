/**
 * Strict-serial Zone-A slot invariant tests for the editor's mapDoc layer.
 *
 * The contract: after `repackZoneASlots`, every shape with `tool === 'zone-a'`
 * has a `slotIndex` from 1..N with no gaps and no duplicates, in array order
 * (with existing slotIndex used as the stable sort key when present, so
 * loaded docs preserve designer intent and freshly-created shapes drift to
 * the back).
 */
import { describe, expect, it } from 'vitest';
import {
  moveZoneASlot,
  repackZoneASlots,
  type EditorMapShape,
} from './mapDoc';

const z = (id: string, slotIndex?: number): EditorMapShape => ({
  id,
  tool: 'zone-a',
  cx: 0,
  cy: 0,
  w: 50,
  h: 50,
  angle: 0,
  ...(slotIndex !== undefined ? { slotIndex } : {}),
});

const w = (id: string): EditorMapShape => ({
  id,
  tool: 'low',
  cx: 0,
  cy: 0,
  w: 50,
  h: 50,
  angle: 0,
});

describe('repackZoneASlots', () => {
  it('stamps strict 1-based serial when no slotIndex set', () => {
    const out = repackZoneASlots([z('a'), z('b'), z('c')]);
    expect(out.map((s) => s.slotIndex)).toEqual([1, 2, 3]);
  });

  it('preserves existing relative order when sorting by slotIndex', () => {
    const out = repackZoneASlots([z('a', 3), z('b', 1), z('c', 2)]);
    const byId = Object.fromEntries(out.map((s) => [s.id, s.slotIndex]));
    expect(byId).toEqual({ b: 1, c: 2, a: 3 });
  });

  it('closes gaps after deletion (1, 3, 5 → 1, 2, 3)', () => {
    const out = repackZoneASlots([z('a', 1), z('b', 3), z('c', 5)]);
    const byId = Object.fromEntries(out.map((s) => [s.id, s.slotIndex]));
    expect(byId).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('breaks duplicates by array position', () => {
    const out = repackZoneASlots([z('a', 2), z('b', 2), z('c', 2)]);
    const byId = Object.fromEntries(out.map((s) => [s.id, s.slotIndex]));
    expect(byId).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('appends unstamped shapes at the end of the order', () => {
    const out = repackZoneASlots([z('a', 1), z('b'), z('c', 2)]);
    const byId = Object.fromEntries(out.map((s) => [s.id, s.slotIndex]));
    expect(byId).toEqual({ a: 1, c: 2, b: 3 });
  });

  it('leaves non-zone-a shapes unchanged', () => {
    const wall = w('w1');
    const zoneB: EditorMapShape = {
      id: 'zb',
      tool: 'zone-b',
      cx: 0,
      cy: 0,
      w: 10,
      h: 10,
      angle: 0,
    };
    const out = repackZoneASlots([wall, zoneB, z('a')]);
    expect(out[0]).toEqual(wall);
    expect(out[1]).toEqual(zoneB);
    expect(out[2]!.slotIndex).toBe(1);
  });

  it('is idempotent on a packed input', () => {
    const once = repackZoneASlots([z('a'), z('b'), z('c')]);
    const twice = repackZoneASlots(once);
    expect(twice.map((s) => s.slotIndex)).toEqual([1, 2, 3]);
  });
});

describe('moveZoneASlot', () => {
  it('swaps a shape up by one position', () => {
    const out = moveZoneASlot([z('a'), z('b'), z('c')], 'b', 'up');
    const byId = Object.fromEntries(out.map((s) => [s.id, s.slotIndex]));
    expect(byId).toEqual({ b: 1, a: 2, c: 3 });
  });

  it('swaps a shape down by one position', () => {
    const out = moveZoneASlot([z('a'), z('b'), z('c')], 'b', 'down');
    const byId = Object.fromEntries(out.map((s) => [s.id, s.slotIndex]));
    expect(byId).toEqual({ a: 1, c: 2, b: 3 });
  });

  it('is a no-op at slot 1 going up', () => {
    const out = moveZoneASlot([z('a'), z('b'), z('c')], 'a', 'up');
    const byId = Object.fromEntries(out.map((s) => [s.id, s.slotIndex]));
    expect(byId).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('is a no-op at the last slot going down', () => {
    const out = moveZoneASlot([z('a'), z('b'), z('c')], 'c', 'down');
    const byId = Object.fromEntries(out.map((s) => [s.id, s.slotIndex]));
    expect(byId).toEqual({ a: 1, b: 2, c: 3 });
  });
});
