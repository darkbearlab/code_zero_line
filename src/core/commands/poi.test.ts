/**
 * Stage 3 — stealth POI emission + decay.
 *
 * Most tests pin the pure helpers (`derivePoisFromCommand`,
 * `applyDerivedPois`, `prunePoisOnTurnover`) since the reducer-side
 * integration is a thin wrapper. One end-to-end test fires SHOOT
 * via `applyCommand` to lock in the wiring.
 */
import { describe, expect, it } from 'vitest';
import {
  applyDerivedPois,
  derivePoisFromCommand,
  prunePoisOnTurnover,
} from './stealth';
import { applyCommand } from './reducer';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type {
  GameState,
  StealthState,
  Unit,
  Weapon,
} from '../state/GameState';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 4,
  threshold: 4,
  descriptors: [],
};

const u = (overrides: Partial<Unit> & { id: string }): Unit => ({
  faction: 'A',
  position: v2(0, 0),
  radius: STANDARD_BASE_RADIUS_PIXELS,
  quality: 3,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [rifle],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const baseState = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'poi-test',
  commandCount: 0,
  units: [],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    playerActivations: 0,
    activeActivation: null,
  },
  ...overrides,
});

describe('derivePoisFromCommand', () => {
  it('returns empty when stealth.active is false', () => {
    const s = baseState({
      units: [u({ id: 'a1', faction: 'A', position: v2(10, 20) })],
      stealth: { active: false, pois: [] },
    });
    const out = derivePoisFromCommand(s, s, {
      type: 'SHOOT',
      mode: 'SOLO',
      shooterId: 'a1',
      targetId: 'b1',
    });
    expect(out).toHaveLength(0);
  });

  it('returns empty when stealth field is absent', () => {
    const s = baseState({
      units: [u({ id: 'a1', faction: 'A' })],
    });
    const out = derivePoisFromCommand(s, s, {
      type: 'SHOOT',
      mode: 'SOLO',
      shooterId: 'a1',
      targetId: 'b1',
    });
    expect(out).toHaveLength(0);
  });

  it('emits a single POI at the shooter position for SHOOT', () => {
    const s = baseState({
      units: [u({ id: 'a1', faction: 'A', position: v2(50, 75) })],
      stealth: { active: true, pois: [] },
    });
    const out = derivePoisFromCommand(s, s, {
      type: 'SHOOT',
      mode: 'SOLO',
      shooterId: 'a1',
      targetId: 'b1',
    });
    expect(out).toEqual([{ position: v2(50, 75), cause: 'SHOOT' }]);
  });

  it('ignores enemy SHOOT (only faction-A actors create POIs)', () => {
    const s = baseState({
      units: [u({ id: 'b1', faction: 'B', position: v2(50, 75) })],
      stealth: { active: true, pois: [] },
    });
    const out = derivePoisFromCommand(s, s, {
      type: 'SHOOT',
      mode: 'SOLO',
      shooterId: 'b1',
      targetId: 'a1',
    });
    expect(out).toHaveLength(0);
  });

  it('returns empty for MOVE (silent action)', () => {
    const s = baseState({
      units: [u({ id: 'a1', faction: 'A' })],
      stealth: { active: true, pois: [] },
    });
    const out = derivePoisFromCommand(s, s, {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(100, 0),
    });
    expect(out).toHaveLength(0);
  });

  it('emits start + end POIs for VAULT when actor moved', () => {
    const pre = baseState({
      units: [u({ id: 'a1', faction: 'A', position: v2(0, 0) })],
      stealth: { active: true, pois: [] },
    });
    const post: GameState = {
      ...pre,
      units: [u({ id: 'a1', faction: 'A', position: v2(96, 0) })],
    };
    const out = derivePoisFromCommand(pre, post, {
      type: 'VAULT',
      unitId: 'a1',
    });
    expect(out).toEqual([
      { position: v2(0, 0), cause: 'VAULT' },
      { position: v2(96, 0), cause: 'VAULT' },
    ]);
  });

  it('emits a single POI for VAULT when actor did not move', () => {
    const pre = baseState({
      units: [u({ id: 'a1', faction: 'A', position: v2(0, 0) })],
      stealth: { active: true, pois: [] },
    });
    const out = derivePoisFromCommand(pre, pre, {
      type: 'VAULT',
      unitId: 'a1',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ position: v2(0, 0), cause: 'VAULT' });
  });
});

describe('applyDerivedPois', () => {
  it('appends to stealth.pois with cycle metadata + emits events', () => {
    const s = baseState({
      stealth: { active: true, pois: [] },
      initiative: {
        holder: 'A',
        momentum: { A: 5, B: 0 },
        cycle: 3,
        playerActivations: 0,
        activeActivation: null,
      },
    });
    const out = applyDerivedPois(s, [
      { position: v2(10, 20), cause: 'SHOOT' },
    ]);
    expect(out.state.stealth?.pois).toHaveLength(1);
    const p = out.state.stealth!.pois[0]!;
    expect(p.position).toEqual(v2(10, 20));
    expect(p.createdCycle).toBe(3);
    expect(p.expiresAtCycle).toBe(4);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.type).toBe('STEALTH_POI_CREATED');
  });

  it('no-op when derived list is empty', () => {
    const s = baseState({ stealth: { active: true, pois: [] } });
    const out = applyDerivedPois(s, []);
    expect(out.state).toBe(s);
    expect(out.events).toHaveLength(0);
  });
});

describe('prunePoisOnTurnover', () => {
  const stealthAt = (cycle: number): StealthState => ({
    active: true,
    pois: [
      {
        position: v2(0, 0),
        createdCycle: cycle,
        cause: 'SHOOT',
        expiresAtCycle: cycle + 1,
      },
    ],
  });

  it('prunes expired POIs on A→B turnover', () => {
    const s = stealthAt(1);
    // currentCycle === 2 means POI created in cycle 1 is now expired.
    const next = prunePoisOnTurnover(s, 2, 'A');
    expect(next).not.toBe(s);
    expect(next?.pois).toHaveLength(0);
  });

  it('keeps POIs that are still within their cycle window', () => {
    const s = stealthAt(2);
    // currentCycle === 2, expiresAtCycle === 3 → 2 < 3, keep.
    const next = prunePoisOnTurnover(s, 2, 'A');
    expect(next).toBe(s);
  });

  it('does not prune on B→A turnover (enemy just released)', () => {
    const s = stealthAt(1);
    const next = prunePoisOnTurnover(s, 2, 'B');
    expect(next).toBe(s);
  });

  it('returns input unchanged when stealth is undefined', () => {
    const next = prunePoisOnTurnover(undefined, 5, 'A');
    expect(next).toBeUndefined();
  });
});

describe('applyCommand integration — POI emission via SHOOT', () => {
  it('player SHOOT during stealth pushes a POI onto state.stealth.pois', () => {
    const s0: GameState = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({
          id: 'b1',
          faction: 'B',
          position: v2(80, 0),
          weapons: [],
        }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    const r2 = applyCommand(r1.state, {
      type: 'SHOOT',
      mode: 'SOLO',
      shooterId: 'a1',
      targetId: 'b1',
    });
    const pois = r2.state.stealth?.pois ?? [];
    expect(pois).toHaveLength(1);
    expect(pois[0]!.cause).toBe('SHOOT');
    expect(pois[0]!.position).toEqual(v2(0, 0));
    expect(r2.events.some((e) => e.type === 'STEALTH_POI_CREATED')).toBe(true);
  });
});
