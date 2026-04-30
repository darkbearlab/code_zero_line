import { describe, it, expect } from 'vitest';
import { v2 } from '../core/geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../core/rules/constants';
import type { GameState, Unit } from '../core/state/GameState';
import { DEFAULT_WEIGHTS, evaluateState } from './eval';

const makeUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
  faction: 'A',
  position: v2(0, 0),
  radius: STANDARD_BASE_RADIUS_PIXELS,
  quality: 3,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const baseState = (units: Unit[]): GameState => ({
  seed: 'eval-test',
  commandCount: 0,
  units,
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 5 },
    cycle: 1,
    activeActivation: null,
  },
});

describe('evaluateState', () => {
  it('mirror state with matching armies + neutral initiative scores 0 modulo holder bonus', () => {
    const s = baseState([
      makeUnit({ id: 'a1', faction: 'A', quality: 3, position: v2(0, 0) }),
      makeUnit({ id: 'b1', faction: 'B', quality: 3, position: v2(100, 0) }),
    ]);
    // Holder bonus is the only asymmetry; subtract it for the parity check.
    const score = evaluateState(s, 'A');
    expect(score).toBeCloseTo(DEFAULT_WEIGHTS.initiativeHolderBonus, 5);
  });

  it('losing a unit drops our score', () => {
    const aliveBoth = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(100, 0) }),
    ]);
    const aliveOnlyB = baseState([
      makeUnit({ id: 'b1', faction: 'B', position: v2(100, 0) }),
    ]);
    expect(evaluateState(aliveBoth, 'A')).toBeGreaterThan(
      evaluateState(aliveOnlyB, 'A'),
    );
  });

  it('higher quality units (lower threshold) are worth more', () => {
    const eliteSquad = baseState([
      makeUnit({ id: 'a1', faction: 'A', quality: 2 }),
      makeUnit({ id: 'b1', faction: 'B', quality: 3 }),
    ]);
    const greenSquad = baseState([
      makeUnit({ id: 'a1', faction: 'A', quality: 4 }),
      makeUnit({ id: 'b1', faction: 'B', quality: 3 }),
    ]);
    expect(evaluateState(eliteSquad, 'A')).toBeGreaterThan(
      evaluateState(greenSquad, 'A'),
    );
  });

  it('damage state hurts the damaged faction', () => {
    const fine = baseState([
      makeUnit({ id: 'a1', faction: 'A', damage: 'NONE' }),
      makeUnit({ id: 'b1', faction: 'B' }),
    ]);
    const suppressed = baseState([
      makeUnit({ id: 'a1', faction: 'A', damage: 'SUPPRESSED' }),
      makeUnit({ id: 'b1', faction: 'B' }),
    ]);
    expect(evaluateState(suppressed, 'A')).toBeLessThan(
      evaluateState(fine, 'A'),
    );
  });

  it('attacker urgency scales objective bonus with cycles remaining', () => {
    // For 'extract' scenario, A is the attacker. As cycle → cycleLimit,
    // A's score for being on the objective should grow (urgency 1.0 → 2.5).
    const objAt = v2(0, 0);
    const onObj = (cycle: number, mode: string, params: Record<string, unknown>): GameState => ({
      ...baseState([
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(700, 0) }),
      ]),
      objectives: [{ id: 'goal', position: objAt, radius: 30 }],
      scenarioInfo: { mode, params },
      initiative: {
        holder: 'A',
        momentum: { A: 5, B: 5 },
        cycle,
        activeActivation: null,
      },
    });
    const early = evaluateState(
      onObj(1, 'extract', { extractCycleLimit: 8 }),
      'A',
    );
    const late = evaluateState(
      onObj(8, 'extract', { extractCycleLimit: 8 }),
      'A',
    );
    expect(late).toBeGreaterThan(early);
  });

  it('defender does not get urgency boost', () => {
    // For 'extract' scenario, B is the defender. Cycle number alone
    // shouldn't shift B's objective valuation upward.
    const objAt = v2(0, 0);
    const stateAt = (cycle: number): GameState => ({
      ...baseState([
        makeUnit({ id: 'a1', faction: 'A', position: v2(700, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(0, 0) }),
      ]),
      objectives: [{ id: 'goal', position: objAt, radius: 30 }],
      scenarioInfo: { mode: 'extract', params: { extractCycleLimit: 8 } },
      initiative: {
        holder: 'A',
        momentum: { A: 5, B: 5 },
        cycle,
        activeActivation: null,
      },
    });
    const earlyB = evaluateState(stateAt(1), 'B');
    const lateB = evaluateState(stateAt(8), 'B');
    // B is defender — score unchanged across cycles (modulo holder bonus).
    expect(lateB).toBeCloseTo(earlyB, 5);
  });

  it('moving toward the objective scores higher than standing far away', () => {
    // Two snapshots of the same matchup; the only difference is unit A's
    // position. A at (200, 0) is 200px from obj, A at (50, 0) is 50px →
    // both outside the marker but the closer one earns more proximity pull.
    const objAt = v2(0, 0);
    const far = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(200, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(700, 0) }),
    ]);
    const close = baseState([
      makeUnit({ id: 'a1', faction: 'A', position: v2(50, 0) }),
      makeUnit({ id: 'b1', faction: 'B', position: v2(700, 0) }),
    ]);
    const withObj = (s: GameState): GameState => ({
      ...s,
      objectives: [{ id: 'goal', position: objAt, radius: 30 }],
    });
    expect(evaluateState(withObj(close), 'A')).toBeGreaterThan(
      evaluateState(withObj(far), 'A'),
    );
  });

  it('momentum advantage is positive', () => {
    const balanced = baseState([
      makeUnit({ id: 'a1', faction: 'A' }),
      makeUnit({ id: 'b1', faction: 'B' }),
    ]);
    const lopsided: GameState = {
      ...balanced,
      initiative: {
        ...balanced.initiative,
        momentum: { A: 9, B: 0 },
      },
    };
    expect(evaluateState(lopsided, 'A')).toBeGreaterThan(
      evaluateState(balanced, 'A'),
    );
  });
});
