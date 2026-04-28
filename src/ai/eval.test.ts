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
    round: 1,
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
