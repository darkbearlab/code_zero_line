import { describe, it, expect } from 'vitest';
import { chooseAiCommand } from './controller';
import { v2 } from '../core/geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../core/rules/constants';
import type { GameState, Unit, Weapon } from '../core/state/GameState';

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

const baseState = (overrides: Partial<GameState> = {}): GameState => ({
  seed: 'ai-test',
  commandCount: 0,
  units: [],
  terrain: [],
  initiative: {
    holder: 'A',
    momentum: { A: 0, B: 0 },
    cycle: 1,
    playerActivations: 0,
    activeActivation: null,
  },
  ...overrides,
});

describe('chooseAiCommand', () => {
  it('returns null when not the AI faction', () => {
    const s = baseState({
      units: [makeUnit({ id: 'a1', faction: 'A' })],
    });
    expect(chooseAiCommand(s, 'B')).toBeNull();
  });

  it('SPENDs when momentum suffices', () => {
    const s = baseState({
      units: [makeUnit({ id: 'a1', faction: 'A', quality: 3 })],
      initiative: {
        holder: 'A',
        momentum: { A: 5, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: null,
      },
    });
    const cmd = chooseAiCommand(s, 'A');
    expect(cmd).toEqual({ type: 'ACTIVATE_SPEND', unitId: 'a1' });
  });

  it('CHECKs when momentum insufficient', () => {
    const s = baseState({
      units: [makeUnit({ id: 'a1', faction: 'A', quality: 3 })],
    });
    const cmd = chooseAiCommand(s, 'A');
    expect(cmd).toEqual({ type: 'ACTIVATE_CHECK', unitId: 'a1' });
  });

  it('PASSes when no fresh units remain', () => {
    const s = baseState({
      units: [makeUnit({ id: 'a1', faction: 'A', activatedThisRound: true })],
    });
    expect(chooseAiCommand(s, 'A')).toEqual({ type: 'PASS_INITIATIVE' });
  });

  it('SHOOTs when an enemy is in LOS with high expected hits', () => {
    const s = baseState({
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0) }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(80, 0) }),
      ],
      initiative: {
        holder: 'A',
        momentum: { A: 0, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: {
          unitId: 'a1',
          kind: 'SPEND',
          actionsRemaining: 1,
          failureProtection: true,
          forcedTurnoverAfterAction: false,
        },
      },
    });
    const cmd = chooseAiCommand(s, 'A');
    expect(cmd?.type).toBe('SHOOT');
  });

  it('MOVEs toward nearest enemy when no shot', () => {
    const noShot: Weapon = { ...rifle, modes: ['ACTIVE'], threshold: 7 };
    // Make weapon useless by giving expected hits 0 (threshold 7+ is impossible)
    // and verify AI falls through to MOVE.
    const s = baseState({
      units: [
        makeUnit({
          id: 'a1',
          faction: 'A',
          position: v2(0, 0),
          weapons: [noShot],
        }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
      initiative: {
        holder: 'A',
        momentum: { A: 0, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: {
          unitId: 'a1',
          kind: 'SPEND',
          actionsRemaining: 1,
          failureProtection: true,
          forcedTurnoverAfterAction: false,
        },
      },
    });
    const cmd = chooseAiCommand(s, 'A');
    expect(cmd?.type).toBe('MOVE');
    if (cmd?.type === 'MOVE') {
      expect(cmd.target.x).toBeGreaterThan(0);
      expect(cmd.reactionPlan?.markers).toEqual([]);
    }
  });

  it('ENDs activation under CHECK_SUCCESS after one action', () => {
    const s = baseState({
      units: [makeUnit({ id: 'a1', faction: 'A' })],
      initiative: {
        holder: 'A',
        momentum: { A: 0, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: {
          unitId: 'a1',
          kind: 'CHECK_SUCCESS',
          actionsRemaining: -1,
          failureProtection: false,
          forcedTurnoverAfterAction: false,
        },
      },
    });
    expect(chooseAiCommand(s, 'A', 1)).toEqual({ type: 'END_ACTIVATION' });
  });

  it('MOVEs toward nearest objective when no shot and obj is set', () => {
    // Unit has no shot (threshold 7+ unhittable), enemy is to the EAST
    // at (500, 0), objective is to the NORTH at (0, -300). With objective-
    // aware fallback, AI prefers obj over nearest enemy.
    const noShot: Weapon = { ...rifle, modes: ['ACTIVE'], threshold: 7 };
    const s = baseState({
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), weapons: [noShot] }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
      objectives: [{ id: 'goal', position: v2(0, -300), radius: 30 }],
      initiative: {
        holder: 'A',
        momentum: { A: 0, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: {
          unitId: 'a1',
          kind: 'SPEND',
          actionsRemaining: 1,
          failureProtection: true,
          forcedTurnoverAfterAction: false,
        },
      },
    });
    const cmd = chooseAiCommand(s, 'A');
    expect(cmd?.type).toBe('MOVE');
    if (cmd?.type === 'MOVE') {
      // Should head north (negative y) toward the objective, not east toward
      // the nearest enemy.
      expect(cmd.target.y).toBeLessThan(0);
    }
  });

  it('on-objective unit falls through to nearest-enemy MOVE', () => {
    // Unit is sitting on the objective — should not spin in place; should
    // step toward the enemy as the legacy fallback.
    const noShot: Weapon = { ...rifle, modes: ['ACTIVE'], threshold: 7 };
    const s = baseState({
      units: [
        makeUnit({ id: 'a1', faction: 'A', position: v2(0, 0), weapons: [noShot] }),
        makeUnit({ id: 'b1', faction: 'B', position: v2(500, 0) }),
      ],
      objectives: [{ id: 'goal', position: v2(0, 0), radius: 50 }],
      initiative: {
        holder: 'A',
        momentum: { A: 0, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: {
          unitId: 'a1',
          kind: 'SPEND',
          actionsRemaining: 1,
          failureProtection: true,
          forcedTurnoverAfterAction: false,
        },
      },
    });
    const cmd = chooseAiCommand(s, 'A');
    expect(cmd?.type).toBe('MOVE');
    if (cmd?.type === 'MOVE') {
      expect(cmd.target.x).toBeGreaterThan(0); // toward enemy
    }
  });

  it('RALLYs when active unit is suppressed', () => {
    const s = baseState({
      units: [makeUnit({ id: 'a1', faction: 'A', damage: 'SUPPRESSED' })],
      initiative: {
        holder: 'A',
        momentum: { A: 0, B: 0 },
        cycle: 1,
        playerActivations: 0,
        activeActivation: {
          unitId: 'a1',
          kind: 'SPEND',
          actionsRemaining: 1,
          failureProtection: true,
          forcedTurnoverAfterAction: false,
        },
      },
    });
    expect(chooseAiCommand(s, 'A')?.type).toBe('RALLY');
  });
});
