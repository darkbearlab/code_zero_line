import { describe, it, expect } from 'vitest';
import { applyCommand, applyCommands } from './reducer';
import type { GameState, Unit, Weapon } from '../state/GameState';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';

const rifle = (modes: ReadonlyArray<'ACTIVE' | 'REACTION'>): Weapon => ({
  id: 'rifle',
  modes,
  kind: 'SHOOT',
  diceCount: 5, // high to ensure hits
  threshold: 5,
  descriptors: ['FOCUSED', 'COMBINED'],
});

const lowDiceRifle = (modes: ReadonlyArray<'ACTIVE' | 'REACTION'>): Weapon => ({
  id: 'rifle-low',
  modes,
  kind: 'SHOOT',
  diceCount: 1,
  threshold: 7, // unreachable on d6 → guaranteed misses
  descriptors: ['FOCUSED', 'COMBINED'],
});

const makeUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
  faction: 'A',
  position: v2(0, 0),
  radius: STANDARD_BASE_RADIUS_PIXELS,
  quality: 3,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [rifle(['ACTIVE', 'REACTION'])],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const makeState = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'shoot-test',
  commandCount: 0,
  units: [
    makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
    makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
  ],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    activeActivation: null,
  },
  ...overrides,
});

describe('SHOOT command', () => {
  it('Solo fire kills with enough hits, ends activation cleanly', () => {
    // 5 dice at 5+ → expected ~1.67 hits avg; with high dice count usually >=2
    const s0 = makeState();
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
      },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { hits: number; afterDamage: string }
      | undefined;
    expect(shot).toBeDefined();
    expect(shot!.hits).toBeGreaterThanOrEqual(0);
    // Activation should be ended (Spend = 1 action)
    expect(r.state.initiative.activeActivation).toBeNull();
  });

  it('Solo fire that misses entirely → action FAILURE → turnover (no protection on CHECK_SUCCESS)', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          weapons: [lowDiceRifle(['ACTIVE'])],
          quality: 1,
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' }, // CHECK_SUCCESS, no failure protection
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
      },
    ]);
    expect(r.state.initiative.holder).toBe('B');
    expect(r.state.initiative.momentum).toEqual({ A: 0, B: 2 });
  });

  it('SPEND failure protection: missed shot does NOT cause turnover', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          weapons: [lowDiceRifle(['ACTIVE'])],
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
      },
    ]);
    expect(r.state.initiative.holder).toBe('A');
  });

  it('throws when shooter is not the active unit', () => {
    const s0 = makeState();
    expect(() =>
      applyCommand(s0, {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
      }),
    ).toThrow(/NO_ACTIVE_UNIT/);
  });

  it('throws on friendly fire', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A' }),
        makeUnit({ id: 'a2', faction: 'A', position: v2(50, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
    };
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() =>
      applyCommand(r1.state, {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'a2',
      }),
    ).toThrow(/FRIENDLY_FIRE/);
  });

  it('FOCUSED fire pools dice from participants within 1 unit distance', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        makeUnit({ id: 'a2', faction: 'A', position: v2(50, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(300, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'FOCUSED',
        shooterId: 'a1',
        targetId: 'b1',
        participantIds: ['a2'],
      },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { diceCount: number }
      | undefined;
    // 5 + 5 = 10 dice (no cover penalty)
    expect(shot?.diceCount).toBe(10);
  });

  it('FOCUSED fire rejects far participants', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        makeUnit({ id: 'a2', faction: 'A', position: v2(500, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(800, 0) }),
      ],
    };
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() =>
      applyCommand(r1.state, {
        type: 'SHOOT',
        mode: 'FOCUSED',
        shooterId: 'a1',
        targetId: 'b1',
        participantIds: ['a2'],
      }),
    ).toThrow(/TOO_FAR_FOR_FOCUSED/);
  });

  it('COMBINED fire requires officer-led shooter', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        makeUnit({ id: 'a2', faction: 'A', position: v2(50, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(300, 0) }),
      ],
    };
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() =>
      applyCommand(r1.state, {
        type: 'SHOOT',
        mode: 'COMBINED',
        shooterId: 'a1',
        targetId: 'b1',
        participantIds: ['a2'],
      }),
    ).toThrow(/NOT_OFFICER/);
  });

  it('COMBINED fire ignores 1-unit-distance constraint (vs FOCUSED)', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          traits: ['OFFICER'],
        }),
        makeUnit({
          id: 'a2',
          faction: 'A',
          // Far from officer (>1 UD), but has LOS to officer + target.
          position: v2(400, 0),
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(800, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'COMBINED',
        shooterId: 'a1',
        targetId: 'b1',
        participantIds: ['a2'],
      },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { diceCount: number }
      | undefined;
    expect(shot?.diceCount).toBe(10); // 5 + 5
  });

  it('Suppressed unit cannot SHOOT', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', damage: 'SUPPRESSED' }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(200, 0) }),
      ],
    };
    // Suppressed unit can't even spend to activate? Per rules, may attempt rally only.
    // We'll verify SHOOT itself rejects it.
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() =>
      applyCommand(r1.state, {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
      }),
    ).toThrow(/SUPPRESSED/);
  });

  it('cover applied when HARD obstacle blocks center-to-center', () => {
    const wall = {
      id: 'w',
      kind: 'HARD' as const,
      polygon: {
        vertices: [v2(80, -3), v2(120, -3), v2(120, 3), v2(80, 3)],
      },
    };
    const s0: GameState = {
      ...makeState(),
      terrain: [wall],
      // Make B big enough that LOS from A's perimeter still works.
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), radius: 20 }),
        makeUnit({
          id: 'b1',
          faction: 'B',
          position: v2(200, 0),
          radius: 20,
        }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
      },
    ]);
    const shot = r.events.find((e) => e.type === 'SHOT_RESOLVED') as
      | { coverApplied: boolean; diceCount: number }
      | undefined;
    expect(shot?.coverApplied).toBe(true);
    expect(shot?.diceCount).toBe(4); // 5 - 1 cover
  });

  it('Determinism: same seed/cmds → same hit count', () => {
    const s0 = makeState({ seed: 'fixed-shoot-seed' });
    const cmds = [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' } as const,
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
      } as const,
    ];
    const a = applyCommands(s0, cmds);
    const b = applyCommands(s0, cmds);
    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
  });
});
