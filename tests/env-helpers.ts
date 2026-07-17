// NOTES CAP-B-FIX: a guard against the class of bug this NOTES entry investigates — a test that
// mutates `process.env` directly (bare `process.env.X = ...` / `delete process.env.X`) and restores
// it late, in an `afterAll` that can race a later file's spawns, or not at all, leaks that mutation
// into every OTHER test file `bun test` runs afterward in the same process (there is no per-file
// isolation without `--isolate`/`--parallel`, neither of which this repo's `bun test` invocation
// passes — see NOTES CAP-B-FIX for the full investigation). No test in this suite does this today
// (audited as part of that investigation) — this exists so the NEXT test that needs to stub an env
// var for one assertion has a scoped, guaranteed-restoration way to do it, rather than reaching for
// a bare mutation because nothing better was at hand.

/**
 * Run `fn` with each key in `vars` temporarily set (or deleted, for an explicit `undefined` value) on
 * `process.env`, restoring every touched key to its exact prior value (or absence) in a `finally` —
 * even if `fn` throws. Prefer this over `process.env.X = "..."` + a manual restore at the end of a
 * test: a manual restore only runs on the success path unless independently wrapped in try/finally,
 * and is easy to get wrong under the `--isolate`-less default this repo's `bun test` runs with.
 */
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) prior.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The `async fn` counterpart — restoration still runs in `finally`, after `fn`'s promise settles. */
export async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) prior.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
