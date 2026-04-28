import { describe, it, expect } from 'vitest';
import { applyCommand, applyCommands } from './reducer';
import type { GameState, Terrain, Unit } from '../state/GameState';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';

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

const makeState = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'move-test',
  commandCount: 0,
  units: [
    makeUnit({ id: 'a1', faction: 'A', quality: 3, position: v2(0, 0) }),
    makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
  ],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    round: 1,
    activeActivation: null,
  },
  ...overrides,
});

const wallTerrain = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Terrain => ({
  id,
  kind: 'HARD',
  polygon: { vertices: [v2(x1, y1), v2(x2, y1), v2(x2, y2), v2(x1, y2)] },
});

describe('MOVE command', () => {
  it('throws when no active activation', () => {
    const s0 = makeState();
    expect(() =>
      applyCommand(s0, { type: 'MOVE', unitId: 'a1', target: v2(100, 0) }),
    ).toThrow(/NO_ACTIVE_UNIT/);
  });

  it('throws when active unit does not match', () => {
    const s0 = makeState();
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() =>
      applyCommand(r1.state, { type: 'MOVE', unitId: 'b1', target: v2(0, 0) }),
    ).toThrow(/NO_ACTIVE_UNIT/);
  });

  it('throws when unit is suppressed', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', damage: 'SUPPRESSED' }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
    };
    const r1 = applyCommand(s0, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    expect(() =>
      applyCommand(r1.state, { type: 'MOVE', unitId: 'a1', target: v2(100, 0) }),
    ).toThrow(/CANNOT_MOVE/);
  });

  it('moves to clear target and emits MOVE_RESOLVED', () => {
    const s0 = makeState();
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0) },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.position.x).toBeCloseTo(100);
    const moveEvent = r.events.find((e) => e.type === 'MOVE_RESOLVED');
    expect(moveEvent).toBeDefined();
  });

  it('SPEND activation auto-ends after 1 move (holder still A, no turnover)', () => {
    const s0 = makeState();
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0) },
    ]);
    expect(r.state.initiative.holder).toBe('A');
    expect(r.state.initiative.activeActivation).toBeNull();
    expect(
      r.events.find(
        (e) => e.type === 'ACTIVATION_ENDED' && e.reason === 'NORMAL',
      ),
    ).toBeDefined();
  });

  it('CHECK_SUCCESS allows multiple moves; activation persists', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', quality: 1, position: v2(0, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(1000, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_CHECK', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0) },
      { type: 'MOVE', unitId: 'a1', target: v2(200, 0) },
    ]);
    expect(r.state.initiative.activeActivation?.kind).toBe('CHECK_SUCCESS');
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.position.x).toBeCloseTo(200);
  });

  it('OVERDRAFT triggers forced turnover after the move with deficit', () => {
    const s0: GameState = {
      ...makeState(),
      initiative: {
        holder: 'A',
        momentum: { A: 1, B: 0 },
        round: 1,
        activeActivation: null,
      },
    };
    // a1 quality 3, momentum 1 → deficit 2
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_OVERDRAFT', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0) },
    ]);
    expect(r.state.initiative.holder).toBe('B');
    expect(r.state.initiative.momentum).toEqual({ A: 0, B: 2 });
  });

  it('move stops at wall before target', () => {
    const s0: GameState = {
      ...makeState(),
      terrain: [wallTerrain('w', 50, -50, 60, 50)],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(200, 0) },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.position.x).toBeLessThan(50);
    const moveEvent = r.events.find((e) => e.type === 'MOVE_RESOLVED');
    expect(moveEvent && (moveEvent as { stopReason: string }).stopReason).toBe(
      'OBSTACLE',
    );
  });

  it('move stops at enemy contact', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(80, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(200, 0) },
    ]);
    const moveEvent = r.events.find((e) => e.type === 'MOVE_RESOLVED');
    expect(moveEvent && (moveEvent as { stopReason: string }).stopReason).toBe(
      'ENEMY',
    );
  });

  it('move stops at DIFFICULT terrain edge (rule 9.2 — entry ends move)', () => {
    const s0: GameState = {
      ...makeState(),
      terrain: [
        {
          id: 'rubble',
          kind: 'DIFFICULT',
          polygon: {
            vertices: [v2(50, -50), v2(150, -50), v2(150, 50), v2(50, 50)],
          },
        },
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(200, 0) },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    // Stop just before / at the leading edge of the difficult terrain.
    expect(a1.position.x).toBeLessThan(60);
    expect(a1.position.x).toBeGreaterThan(0);
  });

  it('move stops at SOFT terrain edge (rule 9.3 — entry ends move)', () => {
    const s0: GameState = {
      ...makeState(),
      terrain: [
        {
          id: 'smoke',
          kind: 'SOFT',
          polygon: {
            vertices: [v2(50, -50), v2(150, -50), v2(150, 50), v2(50, 50)],
          },
        },
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(200, 0) },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.position.x).toBeLessThan(60);
    expect(a1.position.x).toBeGreaterThan(0);
  });

  it('endProne flag drops the unit prone at end of move (rule 4.5)', () => {
    const s0 = makeState();
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'MOVE',
        unitId: 'a1',
        target: v2(80, 0),
        endProne: true,
      },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.stance).toBe('PRONE');
  });

  it('Standing MOVE auto-stands a prone unit (rule 4.5 — 起立)', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', stance: 'PRONE', position: v2(0, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(80, 0) },
    ]);
    const a1 = r.state.units.find((u) => u.id === 'a1')!;
    expect(a1.stance).toBe('STANDING');
  });

  it('reaction windows are emitted in MOVE_RESOLVED', () => {
    const s0: GameState = {
      ...makeState(),
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        // Enemy spectator far away, clear LOS.
        makeUnit({ id: 'b1', faction: 'B', position: v2(50, 200) }),
      ],
    };
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      { type: 'MOVE', unitId: 'a1', target: v2(100, 0) },
    ]);
    const moveEvent = r.events.find((e) => e.type === 'MOVE_RESOLVED') as
      | { reactionWindows: Array<{ enemyUnitId: string }> }
      | undefined;
    expect(moveEvent?.reactionWindows.length).toBeGreaterThan(0);
    expect(moveEvent?.reactionWindows[0]?.enemyUnitId).toBe('b1');
  });
});
