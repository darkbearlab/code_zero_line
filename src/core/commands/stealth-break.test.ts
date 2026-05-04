/**
 * Stage 5a — stealth break detection.
 *
 * Two trigger paths:
 *  1. Player SHOOT — evaluated post-shot in shootAction.
 *  2. Initiative turnover — LOS scan finds an enemy seeing a player
 *     within 1UD (effectiveLOS auto-applies the cap).
 *
 * Both paths run through `evaluateStealthBreak`, which encodes the
 * suppression-defer rule: if every enemy is currently KILLED or SUPPRESSED
 * the break holds back as `pendingBreakReason` and cashes in at the next
 * turnover via `redeemPendingStealthBreak`.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateStealthBreak,
  redeemPendingStealthBreak,
} from './stealth';
import { applyCommands } from './reducer';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type {
  GameState,
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
  seed: 'stealth-break-test',
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

describe('evaluateStealthBreak', () => {
  it('immediate break when at least one enemy is NONE', () => {
    const s = baseState({
      units: [
        u({ id: 'a1', faction: 'A' }),
        u({ id: 'b1', faction: 'B', damage: 'NONE' }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r = evaluateStealthBreak(s, 'SHOT');
    expect(r.state.stealth?.active).toBe(false);
    expect(r.state.stealth?.pendingBreakReason).toBeUndefined();
    expect(r.events).toEqual([
      { type: 'STEALTH_BROKEN', reason: 'SHOT', deferred: false },
    ]);
  });

  it('immediate break when at least one enemy is IMPEDED', () => {
    const s = baseState({
      units: [
        u({ id: 'a1', faction: 'A' }),
        u({ id: 'b1', faction: 'B', damage: 'IMPEDED' }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r = evaluateStealthBreak(s, 'SPOTTED');
    expect(r.state.stealth?.active).toBe(false);
    expect(r.events[0]).toMatchObject({
      type: 'STEALTH_BROKEN',
      reason: 'SPOTTED',
      deferred: false,
    });
  });

  it('defers when every enemy is SUPPRESSED', () => {
    const s = baseState({
      units: [
        u({ id: 'a1', faction: 'A' }),
        u({ id: 'b1', faction: 'B', damage: 'SUPPRESSED' }),
        u({ id: 'b2', faction: 'B', damage: 'SUPPRESSED' }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r = evaluateStealthBreak(s, 'SHOT');
    expect(r.state.stealth?.active).toBe(true);
    expect(r.state.stealth?.pendingBreakReason).toBe('SHOT');
    expect(r.events).toEqual([
      { type: 'STEALTH_PENDING_BREAK', reason: 'SHOT' },
    ]);
  });

  it('defers when every enemy is KILLED or SUPPRESSED (mixed)', () => {
    const s = baseState({
      units: [
        u({ id: 'a1', faction: 'A' }),
        u({ id: 'b1', faction: 'B', damage: 'KILLED' }),
        u({ id: 'b2', faction: 'B', damage: 'SUPPRESSED' }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r = evaluateStealthBreak(s, 'SPOTTED');
    expect(r.state.stealth?.pendingBreakReason).toBe('SPOTTED');
  });

  it('idempotent against double-pending — second call is a no-op', () => {
    const s = baseState({
      units: [
        u({ id: 'a1', faction: 'A' }),
        u({ id: 'b1', faction: 'B', damage: 'SUPPRESSED' }),
      ],
      stealth: { active: true, pendingBreakReason: 'SHOT', pois: [] },
    });
    const r = evaluateStealthBreak(s, 'SPOTTED');
    expect(r.state).toBe(s);
    expect(r.events).toHaveLength(0);
  });

  it('no-op when stealth is already off', () => {
    const s = baseState({
      units: [u({ id: 'b1', faction: 'B' })],
      stealth: { active: false, pois: [] },
    });
    const r = evaluateStealthBreak(s, 'SHOT');
    expect(r.state).toBe(s);
    expect(r.events).toHaveLength(0);
  });

  it('no-op when stealth field is missing', () => {
    const s = baseState({ units: [u({ id: 'b1', faction: 'B' })] });
    const r = evaluateStealthBreak(s, 'SHOT');
    expect(r.state).toBe(s);
    expect(r.events).toHaveLength(0);
  });

  it('immediate break preserves POI list', () => {
    const s = baseState({
      units: [
        u({ id: 'a1', faction: 'A' }),
        u({ id: 'b1', faction: 'B', damage: 'NONE' }),
      ],
      stealth: {
        active: true,
        pois: [
          {
            position: v2(100, 100),
            createdCycle: 1,
            cause: 'SHOOT',
            expiresAtCycle: 2,
          },
        ],
      },
    });
    const r = evaluateStealthBreak(s, 'SHOT');
    expect(r.state.stealth?.pois).toHaveLength(1);
  });
});

describe('redeemPendingStealthBreak', () => {
  it('flips active off and emits STEALTH_BROKEN { deferred: true }', () => {
    const s = baseState({
      units: [u({ id: 'b1', faction: 'B', damage: 'SUPPRESSED' })],
      stealth: { active: true, pendingBreakReason: 'SHOT', pois: [] },
    });
    const r = redeemPendingStealthBreak(s);
    expect(r.state.stealth?.active).toBe(false);
    expect(r.state.stealth?.pendingBreakReason).toBeUndefined();
    expect(r.events).toEqual([
      { type: 'STEALTH_BROKEN', reason: 'SHOT', deferred: true },
    ]);
  });

  it('no-op when no pending', () => {
    const s = baseState({
      units: [u({ id: 'b1', faction: 'B' })],
      stealth: { active: true, pois: [] },
    });
    const r = redeemPendingStealthBreak(s);
    expect(r.state).toBe(s);
    expect(r.events).toHaveLength(0);
  });
});

describe('Stage 5a — turnover-time SPOTTED scan (PASS_INITIATIVE)', () => {
  it('player adjacent to enemy + not all neutralised → immediate break, no patrol', () => {
    // a1 and b1 are within 1UD of each other; effectiveLOS sees player.
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({ id: 'b1', faction: 'B', position: v2(50, 0) }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(r.state.stealth?.active).toBe(false);
    const broken = r.events.find((e) => e.type === 'STEALTH_BROKEN');
    expect(broken).toMatchObject({ reason: 'SPOTTED', deferred: false });
    // Patrol must not run after the SPOTTED break.
    expect(
      r.events.find((e) => e.type === 'PATROL_TRIGGERED'),
    ).toBeUndefined();
  });

  it('player adjacent to enemy + all enemies SUPPRESSED → pending only', () => {
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({
          id: 'b1',
          faction: 'B',
          position: v2(50, 0),
          damage: 'SUPPRESSED',
        }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(r.state.stealth?.active).toBe(true);
    expect(r.state.stealth?.pendingBreakReason).toBe('SPOTTED');
    expect(
      r.events.find((e) => e.type === 'STEALTH_PENDING_BREAK'),
    ).toBeDefined();
    expect(r.events.find((e) => e.type === 'STEALTH_BROKEN')).toBeUndefined();
  });

  it('player at 2UD from enemy → no break, no scan trigger (1UD cap)', () => {
    // 200px > UNIT_DISTANCE_PIXELS(96) → outside stealth sight cap.
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(r.state.stealth?.active).toBe(true);
    expect(r.state.stealth?.pendingBreakReason).toBeUndefined();
    expect(
      r.events.find((e) => e.type === 'STEALTH_BROKEN'),
    ).toBeUndefined();
    expect(
      r.events.find((e) => e.type === 'STEALTH_PENDING_BREAK'),
    ).toBeUndefined();
  });

  it('pending state + turnover → break redeemed before next scan', () => {
    // Start with stealth pending; turnover should redeem (deferred: true)
    // and the redeem fires BEFORE the new LOS scan so patrol/scan see
    // stealth.active === false. We place units far apart to keep the
    // SPOTTED scan clean — only the deferred break should fire.
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({
          id: 'b1',
          faction: 'B',
          position: v2(500, 0),
          damage: 'SUPPRESSED',
        }),
      ],
      stealth: { active: true, pendingBreakReason: 'SHOT', pois: [] },
    });
    const r = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    const broken = r.events.filter((e) => e.type === 'STEALTH_BROKEN');
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      reason: 'SHOT',
      deferred: true,
    });
    expect(r.state.stealth?.active).toBe(false);
    expect(r.state.stealth?.pendingBreakReason).toBeUndefined();
    // Patrol should not fire now that stealth is off.
    expect(
      r.events.find((e) => e.type === 'PATROL_TRIGGERED'),
    ).toBeUndefined();
  });
});

describe('Stage 5a — post-break sanity', () => {
  it('post-break state has no stealth.active so subsequent passes are quiet', () => {
    // First pass breaks (player adjacent to NONE enemy). Subsequent
    // PASS_INITIATIVE should not re-emit any stealth events.
    const s0 = baseState({
      units: [
        u({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        u({ id: 'b1', faction: 'B', position: v2(50, 0) }),
      ],
      stealth: { active: true, pois: [] },
    });
    const r1 = applyCommands(s0, [{ type: 'PASS_INITIATIVE' }]);
    expect(r1.state.stealth?.active).toBe(false);
    const r2 = applyCommands(r1.state, [{ type: 'PASS_INITIATIVE' }]);
    expect(
      r2.events.find(
        (e) =>
          e.type === 'STEALTH_BROKEN' ||
          e.type === 'STEALTH_PENDING_BREAK' ||
          e.type === 'PATROL_TRIGGERED' ||
          e.type === 'STEALTH_POI_CREATED',
      ),
    ).toBeUndefined();
  });
});
