import { describe, it, expect } from 'vitest';
import { v2 } from '../core/geometry/vec2';
import { pickMissions } from './pick';
import type { MissionDef } from './types';

const m = (id: string, scenario: MissionDef['scenario']): MissionDef => ({
  id,
  displayName: id,
  description: '',
  mapId: 'demo',
  scenario,
  enemyFaction: 'B',
  enemies: [{ id: `${id}-e1`, templateId: 'conscript', position: v2(0, 0) }],
  playerSpawnPositions: [v2(0, 0)],
});

const lib = [
  m('engage-1', 'engage-reach'),
  m('engage-2', 'engage-reach'),
  m('defend-1', 'defend'),
  m('defend-2', 'defend'),
  m('extract-1', 'extract'),
  m('assassinate-1', 'assassinate'),
];

describe('pickMissions', () => {
  it('is deterministic per seed', () => {
    const a = pickMissions('seed-1', 3, lib);
    const b = pickMissions('seed-1', 3, lib);
    expect(a).toEqual(b);
  });

  it('different seeds → different picks (usually)', () => {
    // Not strictly required by determinism, but a sanity check that the
    // shuffle actually shuffles. Try a few seeds; at least one should differ.
    const baseline = pickMissions('seed-A', 3, lib);
    const others = ['seed-B', 'seed-C', 'seed-D', 'seed-E'].map((s) =>
      pickMissions(s, 3, lib),
    );
    const anyDifferent = others.some(
      (o) => o.join(',') !== baseline.join(','),
    );
    expect(anyDifferent).toBe(true);
  });

  it('returns the requested count', () => {
    expect(pickMissions('s', 3, lib)).toHaveLength(3);
    expect(pickMissions('s', 1, lib)).toHaveLength(1);
    expect(pickMissions('s', 5, lib)).toHaveLength(5);
  });

  it('prefers variety: 3 picks from 4 scenario types → all distinct types', () => {
    // Run several seeds and verify each pick yields 3 distinct scenarios
    // (the round-1 round-robin should cover this).
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      const picks = pickMissions(seed, 3, lib);
      const scenarios = new Set(
        picks.map((id) => lib.find((m) => m.id === id)!.scenario),
      );
      expect(scenarios.size).toBe(3);
    }
  });

  it('falls back to extras when count > scenario type count', () => {
    // Library has 4 scenario types; asking for 5 forces a 2nd-pass duplicate.
    const picks = pickMissions('s', 5, lib);
    expect(picks).toHaveLength(5);
    // No duplicate mission ids
    expect(new Set(picks).size).toBe(5);
  });

  it('does not crash on tiny library', () => {
    const tiny = [m('only', 'elimination')];
    const picks = pickMissions('s', 3, tiny);
    expect(picks).toEqual(['only']);
  });
});
