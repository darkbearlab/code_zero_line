import { describe, it, expect } from 'vitest';
import { buildInitialState } from './buildState';
import { pointInPolygon } from './geometry';
import type { MapDef, RostersBySide, DeploymentBySide } from './types';
import { v2 } from '../geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../rules/constants';
import type { Unit, Weapon } from '../state/GameState';

const rifle: Weapon = {
  id: 'rifle',
  modes: ['ACTIVE', 'REACTION'],
  kind: 'SHOOT',
  diceCount: 3,
  threshold: 5,
  descriptors: ['FOCUSED', 'COMBINED'],
};

const fakeBuildUnit = (spawn: {
  id: string;
  templateId: string;
  faction: 'A' | 'B';
  position: { x: number; y: number };
}): Unit => ({
  id: spawn.id,
  faction: spawn.faction,
  position: v2(spawn.position.x, spawn.position.y),
  radius: STANDARD_BASE_RADIUS_PIXELS,
  quality: 3,
  damage: 'NONE',
  stance: 'STANDING',
  weapons: [rifle],
  traits: [],
  activatedThisRound: false,
  cannotReactThisRound: false,
});

const square = (x: number, y: number, w: number, h: number) => ({
  vertices: [v2(x, y), v2(x + w, y), v2(x + w, y + h), v2(x, y + h)],
});

const fakeMap: MapDef = {
  id: 'test',
  displayName: 'Test',
  size: 768,
  terrain: [{ id: 'wall', kind: 'HARD', polygon: square(300, 300, 100, 12) }],
  deploymentZones: [
    { id: 'za', faction: 'A', polygon: square(0, 600, 768, 168) },
    { id: 'zb', faction: 'B', polygon: square(0, 0, 768, 168) },
  ],
};

describe('buildInitialState', () => {
  it('produces a battle-ready GameState from rosters + deployment', () => {
    const rosters: RostersBySide = {
      A: [
        { id: 'a1', templateId: 'trooper' },
        { id: 'a2', templateId: 'trooper' },
      ],
      B: [{ id: 'b1', templateId: 'trooper' }],
    };
    const deployment: DeploymentBySide = {
      A: [
        { rosterId: 'a1', position: v2(100, 700) },
        { rosterId: 'a2', position: v2(200, 700) },
      ],
      B: [{ rosterId: 'b1', position: v2(400, 100) }],
    };
    const state = buildInitialState({
      seed: 'test',
      map: fakeMap,
      rosters,
      deployment,
      firstHolder: 'A',
      buildUnit: fakeBuildUnit,
    });
    expect(state.units).toHaveLength(3);
    expect(state.terrain).toHaveLength(1);
    expect(state.initiative.holder).toBe('A');
    expect(state.initiative.cycle).toBe(1);
    expect(state.initiative.activeActivation).toBeNull();
    expect(state.units.find((u) => u.id === 'a1')?.position).toEqual(
      v2(100, 700),
    );
  });

  it('skips deployment entries that have no matching roster', () => {
    const rosters: RostersBySide = {
      A: [{ id: 'a1', templateId: 'trooper' }],
      B: [],
    };
    const deployment: DeploymentBySide = {
      A: [
        { rosterId: 'a1', position: v2(100, 700) },
        { rosterId: 'ghost', position: v2(200, 700) },
      ],
      B: [],
    };
    const state = buildInitialState({
      seed: 'test',
      map: fakeMap,
      rosters,
      deployment,
      firstHolder: 'A',
      buildUnit: fakeBuildUnit,
    });
    expect(state.units).toHaveLength(1);
  });
});

describe('pointInPolygon', () => {
  it('detects points inside a square', () => {
    const sq = square(0, 0, 100, 100);
    expect(pointInPolygon(v2(50, 50), sq)).toBe(true);
    expect(pointInPolygon(v2(150, 50), sq)).toBe(false);
    expect(pointInPolygon(v2(-1, 50), sq)).toBe(false);
  });

  it('handles concave polygons', () => {
    // L-shaped: outside the notch should be false
    const L = {
      vertices: [
        v2(0, 0),
        v2(100, 0),
        v2(100, 50),
        v2(50, 50),
        v2(50, 100),
        v2(0, 100),
      ],
    };
    expect(pointInPolygon(v2(25, 75), L)).toBe(true);
    expect(pointInPolygon(v2(75, 75), L)).toBe(false);
  });
});
