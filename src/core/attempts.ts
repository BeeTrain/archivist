export const MAX_FAILURES = 3;

export const afterFailure = (failures = 0): { failures: number; drop: boolean } => ({
  failures: failures + 1,
  drop: failures + 1 >= MAX_FAILURES,
});
