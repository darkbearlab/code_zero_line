/**
 * localStorage persistence for an in-flight RunState. Single-slot save
 * under `czl.run.v1`. Mirrors `campaign/persist.ts`: SSR-safe, silent on
 * quota errors, returns null on parse failure or version mismatch.
 *
 * Stored on every state-mutation entry point (commitOption, mission end,
 * boon pick, retreat) so closing the tab mid-operation doesn't lose
 * progress. Cleared when the run resolves into a campaign advance.
 */
import type { RunState } from './state';

const STORAGE_KEY = 'czl.run.v1';

interface SavedRun {
  readonly version: 1;
  readonly run: RunState;
}

const hasLocalStorage = (): boolean => {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
};

export const saveRun = (run: RunState): void => {
  if (!hasLocalStorage()) return;
  try {
    const payload: SavedRun = { version: 1, run };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private browsing — silent drop */
  }
};

export const loadRun = (): RunState | null => {
  if (!hasLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedRun>;
    if (parsed && parsed.version === 1 && parsed.run) {
      return parsed.run;
    }
    return null;
  } catch {
    return null;
  }
};

export const clearRun = (): void => {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
};

export const hasSavedRun = (): boolean => loadRun() !== null;
