import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * One alias, one reason: `@deepseek-ai/dsh-client-ui-primitives` is a
 * HOST-provided client module (resolved by the shell's lazy CJS module table
 * at runtime — see package.json `dsh.client.inject`), so it does not exist in
 * this package's node_modules and a plain test graph that reaches
 * branch-action.tsx cannot resolve it. Tests bind the structural stub instead;
 * the browser build keeps the real require (tsdown EXTERNAL).
 */
const ALIAS = {
  '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/primitives-stub.ts', import.meta.url)),
}

/**
 * Two pools, two reasons — the split stops one bucket's constraints from
 * taxing the other's work.
 *
 * `bridge`: specs that drive real agent child processes over the real clock
 * (spawn ≈ 0.23 s each, ~3 per case; 474 cases). This bucket runs in ONE fork
 * and never more. That is measured, not inherited caution: with two forks, 4
 * of 8 full-suite runs went red — `a1-per-session` timing out on liveness, and
 * panel renders blowing the 5 s default once the extra fork's child churn
 * landed on them. Each extra fork multiplies process creation, and Windows
 * process creation is what these cases wait on. See
 * docs/plan/archive/bridge-split.md for the original 20-fork failure.
 *
 * `unit`: everything else — pure functions, jsdom renders, and a handful of
 * specs that DO spawn (quota-refusal, skills-server, agy-late-output, and the
 * symlink-counting cases in skills.spec.ts). Its jsdom cluster is the suite's
 * only CPU-heavy in-process work: the heaviest case renders the whole settings
 * section (~3.6 s alone), so this bucket carries an explicit 15 s bound
 * instead of the 5 s default — three full-suite runs went red on panel cases
 * that pass in isolation once this bucket's own concurrency (plus whatever
 * else the host is running) inflated them past 5 s. See the `unit` project.
 * The bucket cost ~117 s of the suite's ~410 s when it ran alone on one fork,
 * and because Vitest runs the two projects concurrently it now hides under the
 * bridge bucket instead of adding to it.
 *
 * Two worker knobs, and neither means what it looks like:
 *   - `maxWorkers` is ROOT-ONLY (`ProjectConfig` omits it) but it is a
 *     PER-POOL ceiling, not a run-wide one: forks and threads build their own
 *     pools. Peak here is 1 fork + 3 threads = 4 processes. Dropping it to 2
 *     removes the unit bucket's self-inflicted slowdown (test time stops
 *     inflating: ~178 s at 1 or 2 workers vs ~224 s at 3 in one loaded run)
 *     but costs ~45 s more wall time, and it does NOT remove the host's own
 *     load — so the bound, not the worker count, is what makes the jsdom
 *     cluster deterministic. Kept at 3 with the explicit `unit` timeout.
 *   - inside a project, `poolOptions` narrows to `singleFork` / `isolate`
 *     only. `maxForks` is accepted and SILENTLY IGNORED in a project — that is
 *     how the bridge bucket once ran 20 ways at once and mass-timed-out.
 *
 * `singleFork` is not one fork per file: the bucket shares ONE OS process
 * across its files. Modules are still isolated per file (`isolate` defaults to
 * true and resets the registry), but process-level state is not —
 * `process.env` restored by one spec is shared with the next, and a hard crash
 * takes the remaining files with it.
 *
 * Every project repeats `resolve`: an inline project is a config of its own,
 * so the alias travels with it rather than relying on inheritance.
 */
export default defineConfig({
  resolve: { alias: ALIAS },
  test: {
    // The BRIDGE bucket keeps Vitest's 5 s default: its cases are wall-clock
    // assertions about a real child process (cancel windows, liveness, stall
    // reaping), so a loose bound would hide exactly what they measure, and the
    // ones that legitimately run longer already carry their own 30 s bound.
    maxWorkers: 3,
    projects: [
      {
        resolve: { alias: ALIAS },
        test: {
          name: 'bridge',
          // `.tsx` is spelled out even though this directory has none today:
          // an asymmetric include/exclude would let a future one fall out of
          // both projects, and Vitest only complains when a whole run
          // collects nothing.
          include: ['tests/bridge/**/*.spec.ts', 'tests/bridge/**/*.spec.tsx', 'tests/bridge.spec.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          // Hooks take the same 30 s the slow cases carry, for the same reason:
          // a teardown here is real process reaping, not bookkeeping. Observed —
          // `agy-subagent-poll`'s `afterAll` awaits every manager's
          // `shutdownAll()` in sequence (19 of them), and under full-suite load
          // that blew Vitest's 10 s hook default ("Hook timed out in 10000ms")
          // while the same file passes alone in 26 s with all 19 tests green.
          // Cases keep the 5 s default above: this bound is about the OS
          // reaping children, never about what a case asserts.
          hookTimeout: 30_000,
        },
      },
      {
        resolve: { alias: ALIAS },
        test: {
          name: 'unit',
          include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
          exclude: ['tests/bridge/**', 'tests/bridge.spec.ts'],
          // Measured, not guessed. The heaviest case in this bucket is a jsdom
          // render of the whole settings section ("mounts Add only on demand…",
          // ~3.6 s on an idle core); this bucket's own concurrency — three
          // threads, beside the bridge fork's child churn — inflated individual
          // panel FILES by up to ~2.6× in a full-suite run, which is how the
          // heaviest cases kept blowing the 5 s default and reddening the gate
          // on tests nobody had touched (three full-suite runs red on panel
          // cases that pass in isolation and one at a time). 15 s is ~4× the
          // worst observed case, so it absorbs the contention instead of
          // racing it. The margin is not comfort alone: a timed-out case in
          // this cluster also corrupts its successors in the same file —
          // confirmed by forcing a 2 s bound, where a test that passes alone
          // failed on a missing button after a sibling timed out — so the
          // bound has to keep the cluster from EVER timing out, not merely
          // usually. Pure-function specs here finish in milliseconds and are
          // unmoved; the specs that spawn real processes (quota-refusal,
          // skills-server, agy-late-output) already carry their own 30 s
          // bounds, so this default only ever applies to in-process renders.
          testTimeout: 15_000,
          pool: 'threads',
        },
      },
    ],
  },
})
