import { describe, it, expect } from 'vitest';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type { GameState, Terrain, Unit, Weapon } from '../state/GameState';
import { applyCommands } from '../commands/reducer';
import { hasStealthBypass } from './stealth';

const sniperRifle: Weapon = {
  id: 'sniper',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 8, // overkill — guarantees a kill on a no-armour 4+
  threshold: 2,
  descriptors: [],
};

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 4,
  threshold: 4,
  descriptors: [],
};

const blade: Weapon = {
  id: 'blade',
  modes: ['ACTIVE'],
  kind: 'MELEE',
  diceCount: 3,
  threshold: 4,
  descriptors: [],
};

const makeUnit = (overrides: Partial<Unit> & { id: string }): Unit => ({
  faction: 'A',
  position: v2(0, 0),
  radius: STANDARD_BASE_RADIUS_PIXELS,
  quality: 3,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [rifle, blade],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
  ...overrides,
});

const baseState = (units: Unit[], terrain: Terrain[] = []): GameState => ({
  seed: 'trait-test',
  commandCount: 0,
  units,
  terrain,
  initiative: {
    holder: 'A',
    momentum: { A: 99, B: 99 },
    round: 1,
    activeActivation: null,
  },
});

describe('TOUGH (rule 強韌)', () => {
  it('demotes a would-be KILLED to SUPPRESSED on first lethal hit', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [sniperRifle],
        quality: 1,
      }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(120, 0),
        traits: ['TOUGH'],
      }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'sniper',
        participantIds: ['a1'],
      },
    ]);
    const b1 = r.state.units.find((u) => u.id === 'b1')!;
    // Should not be KILLED — TOUGH demoted to SUPPRESSED.
    expect(b1.damage).toBe('SUPPRESSED');
    expect(b1.toughUsed).toBe(true);
  });

  it('does NOT save a SUPPRESSED unit (already past the demote threshold)', () => {
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [sniperRifle],
        quality: 1,
      }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(120, 0),
        damage: 'SUPPRESSED',
        stance: 'PRONE',
        traits: ['TOUGH'],
      }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'sniper',
        participantIds: ['a1'],
      },
    ]);
    const b1 = r.state.units.find((u) => u.id === 'b1')!;
    // Already SUPPRESSED → TOUGH does not save: lethal hit goes through.
    expect(b1.damage).toBe('KILLED');
  });

  it('does not trigger twice in one match (toughUsed remains burned)', () => {
    // Set toughUsed=true on a healthy unit; verify a lethal hit kills.
    const s0 = baseState([
      makeUnit({
        id: 'a1',
        faction: 'A',
        position: v2(0, 0),
        weapons: [sniperRifle],
        quality: 1,
      }),
      makeUnit({
        id: 'b1',
        faction: 'B',
        position: v2(120, 0),
        traits: ['TOUGH'],
        toughUsed: true,
      }),
    ]);
    const r = applyCommands(s0, [
      { type: 'ACTIVATE_SPEND', unitId: 'a1' },
      {
        type: 'SHOOT',
        mode: 'SOLO',
        shooterId: 'a1',
        targetId: 'b1',
        weaponId: 'sniper',
        participantIds: ['a1'],
      },
    ]);
    const b1 = r.state.units.find((u) => u.id === 'b1')!;
    expect(b1.damage).toBe('KILLED');
  });
});

describe('STEALTH (rule 隱身)', () => {
  it('bypass returns true when path stays inside a SOFT polygon', () => {
    const smoke: Terrain = {
      id: 'smoke',
      kind: 'SOFT',
      polygon: {
        vertices: [v2(50, 50), v2(250, 50), v2(250, 250), v2(50, 250)],
      },
    };
    const u = makeUnit({ id: 'a1', traits: ['STEALTH'], position: v2(80, 80) });
    expect(hasStealthBypass(u, v2(80, 80), v2(220, 220), [smoke])).toBe(true);
  });

  it('bypass returns false when path leaves the polygon', () => {
    const smoke: Terrain = {
      id: 'smoke',
      kind: 'SOFT',
      polygon: {
        vertices: [v2(50, 50), v2(150, 50), v2(150, 150), v2(50, 150)],
      },
    };
    const u = makeUnit({ id: 'a1', traits: ['STEALTH'], position: v2(80, 80) });
    expect(hasStealthBypass(u, v2(80, 80), v2(300, 300), [smoke])).toBe(false);
  });

  it('bypass returns false when unit lacks STEALTH', () => {
    const smoke: Terrain = {
      id: 'smoke',
      kind: 'SOFT',
      polygon: {
        vertices: [v2(50, 50), v2(250, 50), v2(250, 250), v2(50, 250)],
      },
    };
    const u = makeUnit({ id: 'a1', position: v2(80, 80) });
    expect(hasStealthBypass(u, v2(80, 80), v2(220, 220), [smoke])).toBe(false);
  });

  it('bypass returns false for HARD walls (cannot move inside one)', () => {
    const wall: Terrain = {
      id: 'wall',
      kind: 'HARD',
      height: 200,
      polygon: {
        vertices: [v2(50, 50), v2(250, 50), v2(250, 250), v2(50, 250)],
      },
    };
    const u = makeUnit({ id: 'a1', traits: ['STEALTH'], position: v2(80, 80) });
    expect(hasStealthBypass(u, v2(80, 80), v2(220, 220), [wall])).toBe(false);
  });
});
