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
})
