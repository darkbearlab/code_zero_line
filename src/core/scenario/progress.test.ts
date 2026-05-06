import { describe, expect, it } from 'vitest';
import type { GameState, Unit } from '../state/GameState';
import { formatScenarioProgress } from './progress';

const baseUnit = (over: Partial<Unit> & Pick<Unit, 'id' | 'faction'>): Unit => ({
  position: { x: 0, y: 0 },
  radius: 6,
  quality: 4,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  lockedThisInitiative: false,
  ...over,
});

const baseState = (over: Partial<GameState> = {}): GameState =>
  ({
    seed: 'test',
    commandCount: 0,
    units: [],
    terrain: [],
    objectives: [],
    initiative: {
      cycle: 1,
      holder: 'A',
      momentum: { A: 0, B: 0 },
      playerActivations: 0,
      activationCounts: { A: 0, B: 0 },
      passedThisCycle: { A: false, B: false },
      activeActivation: null,
      objectiveScores: { A: 0, B: 0 },
    },
    ...over,
  }) as GameState;

describe('formatScenarioProgress', () => {
  it('elimination: counts kills and shows ratio', () => {
    const state = baseState({
      units: [
        baseUnit({ id: 'a1', faction: 'A' }),
        baseUnit({ id: 'b1', faction: 'B', damage: 'KILLED' }),
        baseUnit({ id: 'b2', faction: 'B' }),
      ],
    });
    const r = formatScenarioProgress(state, 'elimination', {}, { A: 1, B: 2 });
    expect(r.text).toContain('1/2');
    expect(r.tone).toBe('normal');
  });

  it('defend: shows danger when attacker on objective', () => {
    const state = baseState({
      units: [baseUnit({ id: 'b1', faction: 'B', position: { x: 50, y: 50 } })],
      objectives: [
        { id: 'o1', position: { x: 50, y: 50 }, radius: 30 },
      ],
    });
    const r = formatScenarioProgress(
      state,
      'defend',
      { defendActivations: 10 },
      { A: 1, B: 1 },
    );
    expect(r.tone).toBe('danger');
    expect(r.text).toContain('登上目標');
  });

  it('extract: shows win when extractCount reached', () => {
    const state = baseState({
      units: [
        baseUnit({ id: 'a1', faction: 'A', position: { x: 0, y: 0 } }),
        baseUnit({ id: 'a2', faction: 'A', position: { x: 0, y: 0 } }),
      ],
      objectives: [{ id: 'o1', position: { x: 0, y: 0 }, radius: 30 }],
    });
    const r = formatScenarioProgress(
      state,
      'extract',
      { extractCount: 2, extractActivations: 10 },
      { A: 2, B: 0 },
    );
    expect(r.tone).toBe('win');
    expect(r.text).toContain('2/2');
  });

  it('control-points: warn when one side near win threshold', () => {
    const state = baseState({
      initiative: {
        cycle: 1,
        holder: 'A',
        momentum: { A: 0, B: 0 },
        playerActivations: 0,
        activationCounts: { A: 0, B: 0 },
        passedThisCycle: { A: false, B: false },
        activeActivation: null,
        objectiveScores: { A: 4, B: 1 },
      } as GameState['initiative'],
    });
    const r = formatScenarioProgress(
      state,
      'control-points',
      { winScore: 5, winLead: 2 },
      { A: 1, B: 1 },
    );
    expect(r.tone).toBe('warn');
  });

  it('assassinate: win when VIP killed', () => {
    const state = baseState({
      units: [baseUnit({ id: 'vip', faction: 'B', damage: 'KILLED' })],
    });
    const r = formatScenarioProgress(
      state,
      'assassinate',
      { vipUnitId: 'vip', assassinateActivations: 10 },
      { A: 1, B: 1 },
    );
    expect(r.tone).toBe('win');
  });

  it('assassinate: danger when low activation budget remains', () => {
    const state = baseState({
      units: [baseUnit({ id: 'vip', faction: 'B' })],
      initiative: {
        cycle: 1,
        holder: 'A',
        momentum: { A: 0, B: 0 },
        playerActivations: 9,
        activationCounts: { A: 0, B: 0 },
        passedThisCycle: { A: false, B: false },
        activeActivation: null,
      } as GameState['initiative'],
    });
    const r = formatScenarioProgress(
      state,
      'assassinate',
      { vipUnitId: 'vip', assassinateActivations: 10 },
      { A: 1, B: 1 },
    );
    expect(r.tone).toBe('danger');
  });

  it('engage-reach: win when on objective AND engaged', () => {
    const state = baseState({
      units: [baseUnit({ id: 'a1', faction: 'A', position: { x: 0, y: 0 } })],
      objectives: [{ id: 'o1', position: { x: 0, y: 0 }, radius: 30 }],
    });
    const r = formatScenarioProgress(
      state,
      'engage-reach',
      {},
      { A: 1, B: 2 },
    );
    expect(r.tone).toBe('win');
  });
});
