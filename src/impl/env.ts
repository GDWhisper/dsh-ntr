/**
 * Child-process environment assembly.
 *
 * The agent is a peer process, not a DSH sub-agent: it inherits the host environment and its own `env` wins per key.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

// ---- Child environment ----

/**
 * The agent is a peer process, not a DSH sub-agent: it inherits the host
 * environment exactly as a native tool would, and the agent's configured env
 * wins per key on top.
 */
export function childEnv(parent: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v
  return out
}
