import { describe, it, expect } from 'vitest';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type { Faction, GameState, Unit } from '../state/GameState';
import {
  cycleScoreDelta,
  factionInstantlyControlsAll,
  nextObjectiveControl,
  objectivePresence,
} from './objectiveControl';

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

const makeState = (
  units: Unit[],
  objectives: { id: string; position: { x: number; y: number }; radius: number }[],
): GameState => ({
  seed: 'test',
  commandCount: 0,
  units,
  terrain: [],
  objectives,
  initiative: {
    holder: 'A',
    momentum: { A: 0, B: 0 },
    cycle: 1,
    playerActivations: 0,
    activeActivation: null,
  },
});

const objs = [
  { id: 'obj-1', position: v2(100, 100), radius: 30 },
  { id: 'obj-2', position: v2(500, 100), radius: 30 },
];

describe('objectivePresence', () => {
  it('counts only living units inside radius', () => {
    const s = makeState(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'a2', faction: 'A', position: v2(900, 900) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(115, 100) }),
        baseUnit({ id: 'b2', faction: 'B', position: v2(110, 110), damage: 'KILLED' }),
      ],
      objs,
    );
    expect(objectivePresence(s, 'obj-1')).toEqual({ A: 1, B: 1 });
    expect(objectivePresence(s, 'obj-2')).toEqual({ A: 0, B: 0 });
  });

  it('unknown objective id returns zeros', () => {
    const s = makeState([], objs);
    expect(objectivePresence(s, 'no-such-obj')).toEqual({ A: 0, B: 0 });
  });
});

describe('factionInstantlyControlsAll', () => {
  it('false when only one of two objectives held', () => {
    const s = makeState(
      [baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) })],
      objs,
    );
    expect(factionInstantlyControlsAll(s, 'A')).toBe(false);
  });

  it('true when every objective uniquely held by faction', () => {
    const s = makeState(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'a2', faction: 'A', position: v2(500, 100) }),
      ],
      objs,
    );
    expect(factionInstantlyControlsAll(s, 'A')).toBe(true);
  });

  it('false when opponent shares any objective', () => {
    const s = makeState(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'a2', faction: 'A', position: v2(500, 100) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(110, 100) }),
      ],
      objs,
    );
    expect(factionInstantlyControlsAll(s, 'A')).toBe(false);
  });

  it('false with zero objectives (vacuous-true would be misleading)', () => {
    const s = makeState([], []);
    expect(factionInstantlyControlsAll(s, 'A')).toBe(false);
  });
});

describe('nextObjectiveControl — capture transitions', () => {
  it('neutral + only A present → A captures', () => {
    const s = makeState(
      [baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) })],
      [objs[0]!],
    );
    const next = nextObjectiveControl(s, { 'obj-1': null });
    expect(next['obj-1']).toBe('A');
  });

  it('neutral + both present → stays neutral', () => {
    const s = makeState(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(110, 100) }),
      ],
      [objs[0]!],
    );
    const next = nextObjectiveControl(s, { 'obj-1': null });
    expect(next['obj-1']).toBeNull();
  });

  it('A owner walks away, B not present → A retains (stateful)', () => {
    const s = makeState(
      [baseUnit({ id: 'a1', faction: 'A', position: v2(900, 900) })],
      [objs[0]!],
    );
    const next = nextObjectiveControl(s, { 'obj-1': 'A' });
    expect(next['obj-1']).toBe('A');
  });

  it('A owner gone, B uniquely present → flips to B', () => {
    const s = makeState(
      [baseUnit({ id: 'b1', faction: 'B', position: v2(100, 100) })],
      [objs[0]!],
    );
    const next = nextObjectiveControl(s, { 'obj-1': 'A' });
    expect(next['obj-1']).toBe('B');
  });

  it('A owner still on point + B also on point → A retains (must clear first)', () => {
    const s = makeState(
      [
        baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(110, 100) }),
      ],
      [objs[0]!],
    );
    const next = nextObjectiveControl(s, { 'obj-1': 'A' });
    expect(next['obj-1']).toBe('A');
  });

  it('A owner died + B on point → flips to B (KILLED is "cleared")', () => {
    const s = makeState(
      [
        baseUnit({
          id: 'a1',
          faction: 'A',
          position: v2(100, 100),
          damage: 'KILLED',
        }),
        baseUnit({ id: 'b1', faction: 'B', position: v2(105, 100) }),
      ],
      [objs[0]!],
    );
    const next = nextObjectiveControl(s, { 'obj-1': 'A' });
    expect(next['obj-1']).toBe('B');
  });

  it('zero objectives → returns input untouched', () => {
    const s = makeState([], []);
    const out = nextObjectiveControl(s, {});
    expect(out).toEqual({});
  });
});

describe('cycleScoreDelta', () => {
  it('default weight 1 per controlled point', () => {
    expect(
      cycleScoreDelta({ 'obj-1': 'A', 'obj-2': 'B' }),
    ).toEqual({ A: 1, B: 1 });
  });

  it('custom weights apply per-objective', () => {
    expect(
      cycleScoreDelta(
        { 'obj-1': 'A', 'obj-2': 'A', 'obj-3': 'B' },
        { 'obj-1': 2, 'obj-2': 3, 'obj-3': 1 },
      ),
    ).toEqual({ A: 5, B: 1 });
  });

  it('neutral points contribute zero', () => {
    expect(
      cycleScoreDelta(
        { 'obj-1': null, 'obj-2': 'A' },
        { 'obj-1': 5, 'obj-2': 1 },
      ),
    ).toEqual({ A: 1, B: 0 });
  });

  it('missing weight defaults to 1', () => {
    expect(
      cycleScoreDelta({ 'obj-x': 'A' }, { 'other': 99 }),
    ).toEqual({ A: 1, B: 0 });
  });
});

describe('integration — full capture sequence over multiple cycles', () => {
  it('A captures, walks away, holds; B clears + recaptures', () => {
    let control: Readonly<Record<string, Faction | null>> = { 'obj-1': null };

    // Cycle 1: A walks onto neutral point alone.
    let s = makeState(
      [baseUnit({ id: 'a1', faction: 'A', position: v2(100, 100) })],
      [objs[0]!],
    );
    control = nextObjectiveControl(s, control);
    expect(control['obj-1']).toBe('A');
    expect(cycleScoreDelta(control)).toEqual({ A: 1, B: 0 });

    // Cycle 2: A walks away; B not yet here. A retains.
    s = makeState(
      [baseUnit({ id: 'a1', faction: 'A', position: v2(900, 900) })],
      [objs[0]!],
    );
    control = nextObjectiveControl(s, control);
    expect(control['obj-1']).toBe('A');
    expect(cycleScoreDelta(control)).toEqual({ A: 1, B: 0 });

    // Cycle 3: B steps onto empty point; A nowhere. Flip to B.
    s = makeState(
      [baseUnit({ id: 'b1', faction: 'B', position: v2(100, 100) })],
      [objs[0]!],
    );
    control = nextObjectiveControl(s, control);
    expect(control['obj-1']).toBe('B');
    expect(cycleScoreDelta(control)).toEqual({ A: 0, B: 1 });
  });
});
