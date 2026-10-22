// A task whose analysis threw waits for the next session start and is tried again, but not forever: a failure
// that repeats (a bug, a file the analysis cannot read) would otherwise run, and spend, at every start.
export const MAX_FAILURES = 3;

/** One more failure of a task's analysis: how many it has had, and whether to give the task up. */
export const afterFailure = (failures = 0): { failures: number; drop: boolean } => ({
  failures: failures + 1,
  drop: failures + 1 >= MAX_FAILURES,
});
