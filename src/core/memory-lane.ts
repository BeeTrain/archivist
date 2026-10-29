import type { SyncMode } from "./memory.js";

const BY_STRENGTH: SyncMode[] = ["fast", "start", "full"];

const stronger = (a: SyncMode, b: SyncMode): SyncMode => (BY_STRENGTH.indexOf(a) >= BY_STRENGTH.indexOf(b) ? a : b);

export interface MemoryLane {
  sync(mode: SyncMode, run: (mode: SyncMode) => Promise<void>): Promise<void>;
  byHand<T>(work: () => Promise<T>): Promise<T>;
}

export const memoryLane = (): MemoryLane => {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting: SyncMode | undefined;
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = tail.then(work, work);
    tail = turn.catch(() => undefined);
    return turn;
  };
  return {
    sync(mode, run) {
      if (waiting) {
        waiting = stronger(waiting, mode);
        return Promise.resolve();
      }
      waiting = mode;
      return inTurn(() => {
        const chosen = waiting ?? mode;
        waiting = undefined;
        return run(chosen);
      });
    },
    byHand: inTurn,
  };
};
