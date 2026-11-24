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
 * (spawn ≈ 0.23 s each, ~3 per case; 474 cases). Unbounded file-level
 * parallelism used to starve Windows process creation and time out timing
 * cases — including ones nobody touched — so this bucket runs in ONE fork and
 * never more. See docs/plan/archive/bridge-split.md.
 *
 * `unit`: everything else — pure functions, jsdom renders, and a handful of
 * specs that DO spawn (quota-refusal, skills-server, agy-late-output, and the
 * symlink-counting cases in skills.spec.ts). Those are this split's residual
 * risk: they run concurrently with each other and beside the bridge fork, so a
 * timing flake in this bucket should be read as this worker budget being too
 * wide BEFORE it is read as a product bug. The bucket cost ~117 s of the
 * suite's ~410 s when it ran alone on one fork, and because Vitest runs the
 * two projects concurrently it now hides under the bridge bucket instead of
 * adding to it.
 *
 * Two worker knobs, and neither means what it looks like:
 *   - `maxWorkers` is ROOT-ONLY (`ProjectConfig` omits it) but it is a
 *     PER-POOL ceiling, not a run-wide one: forks and threads build their own
 *     pools. Peak here is 1 fork + 3 threads = 4 processes, matching a 4-vCPU
 *     runner — raising it gives back the headroom the bridge fork needs.
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
    // Vitest's 5 s default stays: the heaviest panel render finishes in about
    // 1.5 s, and subprocess cases that need longer carry their own bound.
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
        },
      },
      {
        resolve: { alias: ALIAS },
        test: {
          name: 'unit',
          include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
          exclude: ['tests/bridge/**', 'tests/bridge.spec.ts'],
          pool: 'threads',
        },
      },
    ],
  },
})
