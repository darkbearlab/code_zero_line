import { describe, it, expect } from 'vitest';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type { GameState, Unit } from '../state/GameState';
import { detectScenarioVictory } from './victory';

const baseUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
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

const stateWith = (
  units: Unit[],
  playerActivations = 1,
  objX = 100,
  objY = 100,
): GameState => ({
  seed: 'test',
  commandCount: 0,
  units,
  terrain: [],
  objectives: [
    { id: 'obj', position: v2(objX, objY), radius: 30 },
  ],
  initiative: {
    holder: 'A',
    momentum: { A: 99, B: 99 },
    cycle: 1,
    playerActivations,
    activeActivation: null,
  },
});

const aliveCounts = (s: GameState) => ({
  A: s.units.filter((u) => u.faction === 'A' && u.damage !== 'KILLED').length,
  B: s.units.filter((u) => u.faction === 'B' && u.damage !== 'KILLED').length,
});

describe('detectScenarioVictory — eliminate first', () => {
  it('A wiped → B wins regardless of scenario', () => {
    const s = stateWith([
      baseUnit({ id: 'a1', faction: 'A', damage: 'KILLED' }),
      baseUnit({ id: 'b1', faction: 'B' }),
    ]);
    for (const sc of ['elimination', 'engage-reach', 'defend', 'extract'] as const) {
      const v = detectScenarioVictory(s, sc, {}, { A: 1, B: 1 });
      expect(v.winner).toBe('B');
      expect(v.reason).toBe('ELIMINATED');
    }
  });
});

describe('engage-reach', () => {
  it('A on objective + B has casualty + B not on obj → A wins', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(500, 500) }),
        baseUnit({ id: 'b2', faction: 'B', damage: 'KILLED' }),
      ],
      3,
    );
    const v = detectScenarioVictory(s, 'engage-reach', {}, { A: 1, B: 2 });
    expect(v.winner).toBe('A');
    expect(v.reason).toBe('OBJECTIVE_SECURED');
  });

  it('A on objective but B suffered no losses → no win yet (walk-on rejected)', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(500, 500) }),
      ],
      3,
    );
    const v = detectScenarioVictory(s, 'engage-reach', {}, aliveCounts(s));
    expect(v.winner).toBeNull();
  });
});

describe('defend', () => {
  it('B on objective → defender (A) loses immediately', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(500, 500) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(100, 100) }),
      ],
      2,
    );
    const v = detectScenarioVictory(s, 'defend', { defendActivations: 5 }, { A: 1, B: 1 });
    expect(v.winner).toBe('B');
  });

  it('playerActivations > defendActivations AND A holds → A wins', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(500, 500) }),
      ],
      6,
    );
    const v = detectScenarioVictory(s, 'defend', { defendActivations: 5 }, { A: 1, B: 1 });
    expect(v.winner).toBe('A');
  });

  it('mid-defend with no one on objective → no decision', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(500, 500) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(700, 500) }),
      ],
      3,
    );
    const v = detectScenarioVictory(s, 'defend', { defendActivations: 5 }, { A: 1, B: 1 });
    expect(v.winner).toBeNull();
  });
});

describe('assassinate', () => {
  it('VIP killed → A wins', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(500, 500) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
        baseUnit({ id: 'vip', faction: 'B', damage: 'KILLED' }),
      ],
      3,
    );
    const v = detectScenarioVictory(
      s,
      'assassinate',
      { vipUnitId: 'vip', assassinateActivations: 8 },
      { A: 1, B: 2 },
    );
    expect(v.winner).toBe('A');
  });

  it('VIP missing from state (already gone) → A wins (defensive)', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(500, 500) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
      ],
      3,
    );
    const v = detectScenarioVictory(
      s,
      'assassinate',
      { vipUnitId: 'vip', assassinateActivations: 8 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBe('A');
  });

  it('round > limit, VIP alive → B wins', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(500, 500) }),
        baseUnit({ id: 'vip', faction: 'B', position: v2(700, 700) }),
      ],
      9,
    );
    const v = detectScenarioVictory(
      s,
      'assassinate',
      { vipUnitId: 'vip', assassinateActivations: 8 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBe('B');
  });
});

describe('engage-reach with requireAllObjectives', () => {
  const twoObjState = (units: Unit[], playerActivations = 3): GameState => ({
    seed: 'test',
    commandCount: 0,
    units,
    terrain: [],
    objectives: [
      { id: 'obj-1', position: v2(100, 100), radius: 30 },
      { id: 'obj-2', position: v2(500, 100), radius: 30 },
    ],
    initiative: {
      holder: 'A',
      momentum: { A: 99, B: 99 },
      cycle: 1,
      playerActivations,
      activeActivation: null,
    },
  });

  it('A on only one of two objectives → no win when flag on', () => {
    const s = twoObjState([
      baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
      baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
      baseUnit({ id: 'b2', faction: 'B', damage: 'KILLED' }),
    ]);
    const v = detectScenarioVictory(
      s,
      'engage-reach',
      { requireAllObjectives: true },
      { A: 1, B: 2 },
    );
    expect(v.winner).toBeNull();
  });

  it('A on both objectives + B took loss → A wins when flag on', () => {
    const s = twoObjState([
      baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
      baseUnit({ id: 'a2', faction: 'A', position: v2(500, 100) }),
      baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
      baseUnit({ id: 'b2', faction: 'B', damage: 'KILLED' }),
    ]);
    const v = detectScenarioVictory(
      s,
      'engage-reach',
      { requireAllObjectives: true },
      { A: 2, B: 2 },
    );
    expect(v.winner).toBe('A');
  });

  it('flag off — A on either objective is enough', () => {
    const s = twoObjState([
      baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
      baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
      baseUnit({ id: 'b2', faction: 'B', damage: 'KILLED' }),
    ]);
    const v = detectScenarioVictory(s, 'engage-reach', {}, { A: 1, B: 2 });
    expect(v.winner).toBe('A');
  });
});

describe('defend with requireAllObjectives', () => {
  const twoObjState = (units: Unit[]): GameState => ({
    seed: 'test',
    commandCount: 0,
    units,
    terrain: [],
    objectives: [
      { id: 'obj-1', position: v2(100, 100), radius: 30 },
      { id: 'obj-2', position: v2(500, 100), radius: 30 },
    ],
    initiative: {
      holder: 'A',
      momentum: { A: 99, B: 99 },
      cycle: 1,
      playerActivations: 2,
      activeActivation: null,
    },
  });

  it('B on one of two objectives → defender survives when flag on', () => {
    const s = twoObjState([
      baseUnit({ id: 'a1', faction: 'A', position: v2(700, 700) }),
      baseUnit({ id: 'b1', faction: 'B', position: v2(100, 100) }),
    ]);
    const v = detectScenarioVictory(
      s,
      'defend',
      { defendActivations: 999, requireAllObjectives: true },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBeNull();
  });

  it('B on both objectives → defender loses when flag on', () => {
    const s = twoObjState([
      baseUnit({ id: 'a1', faction: 'A', position: v2(700, 700) }),
      baseUnit({ id: 'b1', faction: 'B', position: v2(100, 100) }),
      baseUnit({ id: 'b2', faction: 'B', position: v2(500, 100) }),
    ]);
    const v = detectScenarioVictory(
      s,
      'defend',
      { defendActivations: 999, requireAllObjectives: true },
      { A: 1, B: 2 },
    );
    expect(v.winner).toBe('B');
  });

  it('flag off — B on either objective loses defender immediately', () => {
    const s = twoObjState([
      baseUnit({ id: 'a1', faction: 'A', position: v2(700, 700) }),
      baseUnit({ id: 'b1', faction: 'B', position: v2(100, 100) }),
    ]);
    const v = detectScenarioVictory(
      s,
      'defend',
      { defendActivations: 999 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBe('B');
  });
});

describe('control-points', () => {
  const stateWithScores = (
    aScore: number,
    bScore: number,
  ): GameState => ({
    seed: 'test',
    commandCount: 0,
    units: [
      baseUnit({ id: 'a1', faction: 'A', position: v2(50, 50) }),
      baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
    ],
    terrain: [],
    objectives: [{ id: 'obj-1', position: v2(100, 100), radius: 30 }],
    initiative: {
      holder: 'A',
      momentum: { A: 99, B: 99 },
      cycle: 5,
      playerActivations: 3,
      activeActivation: null,
      objectiveScores: { A: aScore, B: bScore },
      objectiveControl: { 'obj-1': 'A' },
    },
  });

  it('A reaches winScore but lead < winLead → no win yet', () => {
    const s = stateWithScores(5, 4);
    const v = detectScenarioVictory(
      s,
      'control-points',
      { winScore: 5, winLead: 2 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBeNull();
  });

  it('A reaches winScore AND lead >= winLead → A wins', () => {
    const s = stateWithScores(6, 4);
    const v = detectScenarioVictory(
      s,
      'control-points',
      { winScore: 5, winLead: 2 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBe('A');
    expect(v.reason).toBe('OBJECTIVE_SECURED');
  });

  it('B reaches winScore + lead → B wins', () => {
    const s = stateWithScores(2, 5);
    const v = detectScenarioVictory(
      s,
      'control-points',
      { winScore: 5, winLead: 2 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBe('B');
  });

  it('lead exactly equals winLead at winScore → wins (boundary)', () => {
    const s = stateWithScores(7, 5);
    const v = detectScenarioVictory(
      s,
      'control-points',
      { winScore: 5, winLead: 2 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBe('A');
  });

  it('defaults applied when params omitted (winScore=5, winLead=2)', () => {
    const s = stateWithScores(5, 5);
    const v = detectScenarioVictory(s, 'control-points', {}, { A: 1, B: 1 });
    expect(v.winner).toBeNull();
  });

  it('no scores recorded yet → no win', () => {
    const s: GameState = {
      seed: 'test',
      commandCount: 0,
      units: [
        baseUnit({ id: 'a1', faction: 'A', position: v2(50, 50) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
      ],
      terrain: [],
      objectives: [{ id: 'obj-1', position: v2(100, 100), radius: 30 }],
      initiative: {
        holder: 'A',
        momentum: { A: 0, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: null,
      },
    };
    const v = detectScenarioVictory(s, 'control-points', {}, { A: 1, B: 1 });
    expect(v.winner).toBeNull();
  });
});

describe('extract', () => {
  it('extractCount A units on objective → A wins', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'a2', faction: 'A', position: v2(105, 95) }),
        baseUnit({ id: 'a3', faction: 'A', position: v2(500, 500) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
      ],
      3,
    );
    const v = detectScenarioVictory(
      s,
      'extract',
      { extractCount: 2, extractActivations: 8 },
      { A: 3, B: 1 },
    );
    expect(v.winner).toBe('A');
  });

  it('round > limit without enough extracted → B wins', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(500, 500) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
      ],
      9,
    );
    const v = detectScenarioVictory(
      s,
      'extract',
      { extractCount: 2, extractActivations: 8 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBe('B');
  });

  it('mid-mission, no extraction yet, time still on clock → no decision', () => {
    const s = stateWith(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(500, 500) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(700, 700) }),
      ],
      3,
    );
    const v = detectScenarioVictory(
      s,
      'extract',
      { extractCount: 2, extractActivations: 8 },
      { A: 1, B: 1 },
    );
    expect(v.winner).toBeNull();
  });
});
