import type { Command } from '../commands/types';
import type { GameState } from '../state/GameState';

/**
 * On-disk schema version. Bump when the GameState/Command shape changes in a
 * way that breaks deserialization of older replays.
 */
export const REPLAY_SCHEMA_VERSION = 1;

export interface ReplayLog {
  readonly schemaVersion: number;
  readonly recordedAt: string;
  /** Snapshot of the game state at the start (before any commands applied). */
  readonly initialState: GameState;
  readonly commands: ReadonlyArray<Command>;
}

export const createReplayLog = (initialState: GameState): ReplayLog => ({
  schemaVersion: REPLAY_SCHEMA_VERSION,
  recordedAt: new Date().toISOString(),
  initialState,
  commands: [],
});

export const appendCommand = (log: ReplayLog, cmd: Command): ReplayLog => ({
  ...log,
  commands: [...log.commands, cmd],
});

export const serializeReplay = (log: ReplayLog): string => JSON.stringify(log);

export const deserializeReplay = (text: string): ReplayLog => {
  const parsed = JSON.parse(text) as ReplayLog;
  if (parsed.schemaVersion !== REPLAY_SCHEMA_VERSION) {
    throw new Error(
      `Replay schema mismatch: expected ${REPLAY_SCHEMA_VERSION}, got ${parsed.schemaVersion}`,
    );
  }
  return parsed;
};
