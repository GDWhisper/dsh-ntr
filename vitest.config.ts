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
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/primitives-stub.ts', import.meta.url)),
    },
  },
  test: {
    // Keep Vitest's 5s default: the heaviest panel render finishes in about 1.5s.
    // Subprocess bridge cases that need longer carry their own per-test bound.
    // Cap fork parallelism: every tests/bridge/*.spec.ts file keeps spawning real
    // mock-agent child processes, and unbounded file-level parallelism (one fork
    // per CPU) overloads Windows process creation, starving timing-sensitive
    // kill/liveness/watchdog cases. Even 2 forks still flaked under residual
    // machine load, so run fully sequential (1 fork) — the measured-stable value.
    poolOptions: {
      forks: { maxForks: 1 },
    },
  },
})
