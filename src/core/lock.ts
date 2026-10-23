import type { Io } from "./io.js";

export const LOCK = ".archivist/.local/lock";
export const STALE_MS = 2 * 60_000;
const WAIT_MS = 30_000;
const POLL_MS = 100;

export const withLock = async <T>(io: Io, fn: () => Promise<T>, waitMs = WAIT_MS): Promise<T> => {
  const m = io.mutex;
  if (!m) return fn();
  for (let waited = 0; !(await m.claim(LOCK)); waited += POLL_MS) {
    const age = await m.age(LOCK);
    if (age !== undefined && age > STALE_MS) await m.release(LOCK);
    else if (waited >= waitMs)
      throw new Error(`${LOCK} is held by another Archivist writer${age === undefined ? "" : ` (for ${Math.round(age / 1000)} s)`}; if none is running, remove that directory`);
    await m.sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await m.release(LOCK);
  }
};
