import type { ReplayLog } from './log';
import { deserializeReplay, serializeReplay } from './log';

const INDEX_KEY = 'czl.replay.index';
const ENTRY_PREFIX = 'czl.replay.';
const MAX_REPLAYS = 5;

interface ReplayIndexEntry {
  id: string;
  recordedAt: string;
  commandCount: number;
}

const readIndex = (): ReplayIndexEntry[] => {
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ReplayIndexEntry[];
  } catch {
    return [];
  }
};

const writeIndex = (entries: ReplayIndexEntry[]): void => {
  localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
};

export const saveReplay = (log: ReplayLog): string => {
  const id = `r-${Date.now()}`;
  localStorage.setItem(ENTRY_PREFIX + id, serializeReplay(log));
  let index = readIndex();
  index.unshift({
    id,
    recordedAt: log.recordedAt,
    commandCount: log.commands.length,
  });
  // Evict oldest beyond MAX_REPLAYS.
  const evicted = index.slice(MAX_REPLAYS);
  index = index.slice(0, MAX_REPLAYS);
  for (const e of evicted) localStorage.removeItem(ENTRY_PREFIX + e.id);
  writeIndex(index);
  return id;
};

export const listReplays = (): ReadonlyArray<ReplayIndexEntry> => readIndex();

export const loadReplay = (id: string): ReplayLog | null => {
  const raw = localStorage.getItem(ENTRY_PREFIX + id);
  if (!raw) return null;
  try {
    return deserializeReplay(raw);
  } catch {
    return null;
  }
};

export const loadLatestReplay = (): ReplayLog | null => {
  const idx = readIndex();
  if (idx.length === 0) return null;
  return loadReplay(idx[0]!.id);
};
