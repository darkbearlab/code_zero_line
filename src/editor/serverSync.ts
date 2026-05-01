/**
 * Server-first sync pipeline for editor edits.
 *
 * On every upsert/remove, the editor:
 *   1. Writes to localStorage (existing path — keeps editor UI consistent).
 *   2. Enqueues an entry into the pending queue (this module).
 *   3. Fires a POST to the Vite middleware (vite.config.ts → bundleSavePlugin).
 *      On success: entry leaves the queue.
 *      On failure: entry stays, banner surfaces it for retry / export.
 *
 * Production builds and offline previews don't have the middleware running,
 * so every save will end up in the pending queue. The banner makes that
 * obvious so the designer never thinks data is being saved when it isn't.
 */

const SAVE_ENDPOINT = '/__bundle/save';
const PENDING_KEY = 'czl.editor.pending.v1';

export type SyncType = 'weapon' | 'unit' | 'map' | 'mission' | 'faction';
export type SyncOp = 'upsert' | 'delete';

export interface PendingEntry {
  readonly type: SyncType;
  readonly id: string;
  readonly op: SyncOp;
  readonly payload?: unknown; // canonical file content for upsert; absent for delete
  readonly enqueuedAt: string;
  readonly attempts: number;
  readonly lastError?: string;
}

type Listener = (pending: ReadonlyArray<PendingEntry>) => void;
const listeners = new Set<Listener>();

const readPending = (): PendingEntry[] => {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as PendingEntry[]) : [];
  } catch {
    return [];
  }
};

const writePending = (list: ReadonlyArray<PendingEntry>): void => {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
};

const notify = (): void => {
  const snapshot = readPending();
  for (const l of listeners) l(snapshot);
};

export const subscribeSyncStatus = (l: Listener): (() => void) => {
  listeners.add(l);
  l(readPending());
  return () => {
    listeners.delete(l);
  };
};

export const getPending = (): ReadonlyArray<PendingEntry> => readPending();

const performSync = async (
  entry: PendingEntry,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  try {
    const res = await fetch(SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: entry.type,
        id: entry.id,
        op: entry.op,
        data: entry.payload,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `${res.status} ${res.statusText} — ${body || '(empty body)'}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message ?? String(e)}` };
  }
};

const upsertPending = (
  next: Omit<PendingEntry, 'enqueuedAt' | 'attempts'> & { attempts?: number; lastError?: string },
): PendingEntry => {
  const list = readPending().filter(
    (e) => !(e.type === next.type && e.id === next.id),
  );
  const entry: PendingEntry = {
    type: next.type,
    id: next.id,
    op: next.op,
    payload: next.payload,
    enqueuedAt: new Date().toISOString(),
    attempts: next.attempts ?? 0,
    lastError: next.lastError,
  };
  list.push(entry);
  writePending(list);
  return entry;
};

const removePending = (type: SyncType, id: string, enqueuedAt: string): void => {
  const list = readPending().filter(
    (e) => !(e.type === type && e.id === id && e.enqueuedAt === enqueuedAt),
  );
  writePending(list);
};

const markFailed = (
  type: SyncType,
  id: string,
  enqueuedAt: string,
  error: string,
): void => {
  const list = readPending();
  const idx = list.findIndex(
    (e) => e.type === type && e.id === id && e.enqueuedAt === enqueuedAt,
  );
  if (idx < 0) return; // a newer write superseded this one
  list[idx] = {
    ...list[idx],
    attempts: list[idx]!.attempts + 1,
    lastError: error,
  };
  writePending(list);
};

/** Sync-fire-and-forget: enqueue, kick off POST, return immediately. */
export const enqueueSync = (
  spec: { type: SyncType; id: string; op: SyncOp; payload?: unknown },
): void => {
  const entry = upsertPending(spec);
  notify();
  void (async () => {
    const result = await performSync(entry);
    if (result.ok) {
      removePending(entry.type, entry.id, entry.enqueuedAt);
    } else {
      markFailed(entry.type, entry.id, entry.enqueuedAt, result.error);
    }
    notify();
  })();
};

/** Walk the entire queue once. Returns counts. */
export const retryAll = async (): Promise<{
  succeeded: number;
  failed: number;
}> => {
  const snapshot = readPending();
  let succeeded = 0;
  let failed = 0;
  for (const entry of snapshot) {
    const result = await performSync(entry);
    if (result.ok) {
      removePending(entry.type, entry.id, entry.enqueuedAt);
      succeeded += 1;
    } else {
      markFailed(entry.type, entry.id, entry.enqueuedAt, result.error);
      failed += 1;
    }
  }
  notify();
  return { succeeded, failed };
};

/** Manual purge — for "I gave up on these" or after a successful import. */
export const clearAllPending = (): void => {
  writePending([]);
  notify();
};

export const exportErrorReport = (): {
  exportedAt: string;
  userAgent: string;
  endpoint: string;
  origin: string;
  pending: ReadonlyArray<PendingEntry>;
} => ({
  exportedAt: new Date().toISOString(),
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  endpoint: SAVE_ENDPOINT,
  origin: typeof location !== 'undefined' ? location.origin : 'unknown',
  pending: readPending(),
});
