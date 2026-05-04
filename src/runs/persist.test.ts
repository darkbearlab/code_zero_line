/**
 * runs/persist round-trip tests. Mocks localStorage in-memory so the
 * test stays decoupled from a real browser env.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { saveRun, loadRun, clearRun, hasSavedRun } from './persist';
import { newRunState, type RunState } from './state';

const fakeStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
};

describe('runs/persist', () => {
  beforeEach(() => {
    // Vitest jsdom env supplies window+localStorage already; just clear.
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    } else {
      // Headless env — install a fake.
      // @ts-expect-error — minimal global injection for this test only
      globalThis.window = { localStorage: fakeStorage() };
    }
  });

  it('round-trips a basic run state', () => {
    const run: RunState = newRunState(
      'seed',
      [{ id: 's1', templateId: 'trooper' }],
      ['m1', 'm2'],
      {
        operationId: 'op-x',
        stageLabels: ['ELIM', 'MAIN'],
        perStageReward: { tactical: 1, regional: 0, honor: 0 },
        onCompleteReward: { tactical: 0, regional: 2, honor: 1 },
      },
    );
    saveRun(run);
    expect(hasSavedRun()).toBe(true);
    const loaded = loadRun();
    expect(loaded).not.toBeNull();
    expect(loaded!.seed).toBe('seed');
    expect(loaded!.missionIds).toEqual(['m1', 'm2']);
    expect(loaded!.operation?.operationId).toBe('op-x');
    expect(loaded!.bankedRewards).toEqual({
      tactical: 0,
      regional: 0,
      honor: 0,
    });
  });

  it('returns null after clearRun', () => {
    saveRun(newRunState('seed', [{ id: 's1', templateId: 'trooper' }], ['m1']));
    clearRun();
    expect(loadRun()).toBeNull();
    expect(hasSavedRun()).toBe(false);
  });

  it('returns null when no save exists', () => {
    expect(loadRun()).toBeNull();
    expect(hasSavedRun()).toBe(false);
  });

  it('rejects malformed payloads (wrong version)', () => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(
        'czl.run.v1',
        JSON.stringify({ version: 99, run: {} }),
      );
    }
    expect(loadRun()).toBeNull();
  });
});
