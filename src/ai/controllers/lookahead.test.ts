import { describe, it, expect } from 'vitest';
import { lookaheadController } from './lookahead';
import { simulateMatch } from '../../sim/runMatch';
import { greedyController } from './greedy';
import { buildFixtureState, demoFixture } from '../../sim/fixtures';

describe('lookaheadController', () => {
  it('returns null when not the active faction', () => {
    const s = buildFixtureState(demoFixture, 'la-1');
    // Initial state has A holding initiative; B should get null.
    const ai = lookaheadController({ depth: 2, beam: 6 });
    expect(ai(s, 'B', 0)).toBeNull();
  });

  it('returns a non-null command when active', () => {
    const s = buildFixtureState(demoFixture, 'la-2');
    const ai = lookaheadController({ depth: 2, beam: 6 });
    const cmd = ai(s, 'A', 0);
    expect(cmd).not.toBeNull();
  });

  it('completes a full match against itself in finite time', () => {
    const s = buildFixtureState(demoFixture, 'la-3');
    const ai = lookaheadController({ depth: 2, beam: 6 });
    const out = simulateMatch(s, ai, ai, { maxCommands: 5000 });
    expect(out.commandCount).toBeLessThanOrEqual(5000);
    expect(['A', 'B', 'DRAW']).toContain(out.winner);
  });

  it('completes a full match against greedy in finite time', () => {
    const s = buildFixtureState(demoFixture, 'la-4');
    const out = simulateMatch(s, greedyController, lookaheadController(), {
      maxCommands: 5000,
    });
    expect(out.commandCount).toBeLessThanOrEqual(5000);
  });
});
