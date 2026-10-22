// One writer at a time for what lives under .archivist/. The mod's analysis, the CLI (`apply`, `skip`, `add`…,
// run by the triage skill) and the mod of another session in the same project are separate processes, and every
// write here is read-modify-write: two at once lose one of them. A directory is the lock, since creating one is
// atomic everywhere; a writer that died leaves one behind, and it ages out.
import type { Io } from "./io.js";

export const LOCK = ".archivist/.local/lock";
/** A writer holds the lock over file writes only, never over a model call: anything older was left by a crash. */
export const STALE_MS = 2 * 60_000;
const WAIT_MS = 30_000;
const POLL_MS = 100;

/** Runs `fn` holding the project's write lock. Not reentrant: nothing called under it takes it again. */
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
