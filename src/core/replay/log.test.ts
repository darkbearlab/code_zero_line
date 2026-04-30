import { describe, it, expect } from 'vitest';
import {
  appendCommand,
  createReplayLog,
  deserializeReplay,
  serializeReplay,
  REPLAY_SCHEMA_VERSION,
} from './log';
import { applyCommands } from '../commands/reducer';
import type { Command } from '../commands/types';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type { GameState, Unit, Weapon } from '../state/GameState';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 3,
  threshold: 5,
  descriptors: ['FOCUSED', 'COMBINED'],
};

const makeUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
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

const baseState = (): GameState => ({
  seed: 'replay-test',
  commandCount: 0,
  units: [
    makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), quality: 2 }),
    makeUnit({ id: 'b1', faction: 'B', position: v2(400, 0) }),
  ],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 5, B: 0 },
    cycle: 1,
    activeActivation: null,
  },
});

describe('replay log', () => {
  it('round-trips through JSON serialization', () => {
    const initial = baseState();
    let log = createReplayLog(initial);
    log = appendCommand(log, { type: 'ACTIVATE_SPEND', unitId: 'a1' });
    log = appendCommand(log, {
      type: 'MOVE',
      unitId: 'a1',
      target: v2(50, 0),
      reactionPlan: { markers: [] },
    });
    const text = serializeReplay(log);
    const restored = deserializeReplay(text);
    expect(restored.schemaVersion).toBe(REPLAY_SCHEMA_VERSION);
    expect(restored.commands).toHaveLength(2);
    expect(restored.initialState.units).toHaveLength(2);
  });

  it('replaying commands reproduces final state deterministically', () => {
    const initial = baseState();
    const cmds: Command[] = [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'MOVE',
        unitId: 'a1',
        target: v2(100, 0),
        reactionPlan: { markers: [] },
      },
    ];
    const a = applyCommands(initial, cmds);
    const b = applyCommands(initial, cmds);
    expect(a.state).toEqual(b.state);
  });

  it('rejects schema mismatch on deserialize', () => {
    const initial = baseState();
    const log = createReplayLog(initial);
    const text = serializeReplay({ ...log, schemaVersion: 999 });
    expect(() => deserializeReplay(text)).toThrow(/schema/i);
  });
});
