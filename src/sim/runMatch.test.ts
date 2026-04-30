import { describe, it, expect } from 'vitest';
import { greedyController } from '../ai/controllers/greedy';
import { simulateMatch } from './runMatch';
import { aggregateKpi, computeMatchKpi } from './metrics';
import { buildFixtureState, demoFixture } from './fixtures';

const greedyStrategy = { decide: greedyController };

describe('headless simulator', () => {
  it('produces identical outcomes for identical seeds (determinism)', () => {
    const s1 = buildFixtureState(demoFixture, 'det-7');
    const s2 = buildFixtureState(demoFixture, 'det-7');
    const a = simulateMatch(s1, greedyStrategy, greedyStrategy);
    const b = simulateMatch(s2, greedyStrategy, greedyStrategy);
    expect(a.winner).toBe(b.winner);
    expect(a.commandCount).toBe(b.commandCount);
    expect(a.cycles).toBe(b.cycles);
    expect(a.events.length).toBe(b.events.length);
  });

  it('terminates within maxCommands', () => {
    const s = buildFixtureState(demoFixture, 'term-1');
    const out = simulateMatch(s, greedyStrategy, greedyStrategy, {
      maxCommands: 3000,
    });
    expect(out.commandCount).toBeLessThanOrEqual(3000);
    // At minimum, one side should be eliminated for typical demo fixture.
    expect(['ELIMINATED', 'BOTH_PASSED', 'MAX_COMMANDS']).toContain(out.reason);
  });

  it('greedy vs greedy produces a valid winner / draw on each match', () => {
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      const s = buildFixtureState(demoFixture, `mirror-${i}`);
      outcomes.push(simulateMatch(s, greedyStrategy, greedyStrategy));
    }
    for (const o of outcomes) {
      expect(['A', 'B', 'DRAW']).toContain(o.winner);
    }
    const agg = aggregateKpi(outcomes);
    expect(agg.matches).toBe(5);
    expect(agg.winA + agg.winB + agg.draws).toBe(5);
  });

  it('match KPIs project sensibly from the event stream', () => {
    const s = buildFixtureState(demoFixture, 'kpi-1');
    const out = simulateMatch(s, greedyStrategy, greedyStrategy);
    const k = computeMatchKpi(out);
    // At least one shot fired in a 2v2 demo match.
    expect(k.A.shotsTaken + k.B.shotsTaken).toBeGreaterThan(0);
    // Hit rate is a normalised ratio.
    expect(k.A.hitRate).toBeGreaterThanOrEqual(0);
    expect(k.A.hitRate).toBeLessThanOrEqual(1);
  });
});
