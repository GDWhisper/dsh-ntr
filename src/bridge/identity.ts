import { readFileSync } from 'node:fs'

/**
 * Version of this installed package, read from the shipped `package.json` —
 * two levels above both `src/bridge/` at test time and `lib/bridge/` at runtime. The settings
 * badge and the ACP handshake's `clientInfo` both report it; a copied literal
 * would go stale on every release.
 */
export const PLUGIN_VERSION: string = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
})()

/**
 * A1: agents whose ACP host keeps exactly ONE `currentSession` per stdio
 * connection. CodeBuddy is the only one today — `session/new` / `session/load`
 * replace its connection-wide session and stop the previous one, so every DSH
 * conversation needs its own child process. Every other agent multiplexes any
 * number of sessions over one process and stays on the agent-wide bridge.
 */
export const PER_SESSION_AGENT_IDS: ReadonlySet<string> = new Set(['codebuddy'])

/** True when this agent gets one child process per DSH session (A1). */
export function isPerSessionAgent(agentId: string): boolean {
  return PER_SESSION_AGENT_IDS.has(agentId)
}

/** Which process one `AgentBridge` serves (per-session agents only; all others are `agent`). */
export type BridgeScope =
  /** Non-A1: the single process configured for the agent. */
  | { kind: 'agent' }
  /** A1: one DSH chat conversation. */
  | { kind: 'chat'; dshSessionId: string }
  /** A1: a `/acp` RPC session (its own token) or the anonymous turn bucket. */
  | { kind: 'ephemeral'; token: string }
  /** A1: the throwaway child a model / config probe opens. */
  | { kind: 'probe' }

/**
 * The `bridges` key for one agent + scope. A non-per-session agent folds every
 * scope onto the bare agent id, so its map keeps exactly one entry and every
 * existing lookup stays byte-for-byte the same. A per-session agent keeps a
 * distinct key per scope; the NUL separator cannot collide with an agent id or
 * a DSH session id. `probe` carries no token — it is one fixed child per agent.
 */
export function bridgeKey(agentId: string, scope: BridgeScope): string {
  if (!isPerSessionAgent(agentId)) return agentId
  switch (scope.kind) {
    case 'agent': return `${agentId}\u0000agent`
    case 'chat': return `${agentId}\u0000chat:${scope.dshSessionId}`
    case 'ephemeral': return `${agentId}\u0000ephemeral:${scope.token}`
    case 'probe': return `${agentId}\u0000probe`
  }
}

/**
 * Drop the fixed `--port` CodeBuddy's ACP mode tries to bind: every per-session
 * child would race for `127.0.0.1:6156` (`EADDRINUSE`), and stdio needs no
 * listener at all. Both `--port <value>` and `--port=<value>` are removed; a
 * non-per-session agent keeps its arguments byte-for-byte (new array, same
 * entries — the caller's array is never mutated).
 */
export function perSessionLaunchArgs(args: readonly string[], agentId: string): string[] {
  if (!isPerSessionAgent(agentId)) return [...args]
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--port') {
      index += 1 // ...and the value that follows it
      continue
    }
    if (arg.startsWith('--port=')) continue
    kept.push(arg)
  }
  return kept
}

/**
 * The same for the environment: a per-session child must not inherit an agent
 * config that pins `SERVER__PORT` / `SERVER__HOST` (the EADDRINUSE above). The
 * lookup is case-insensitive because Windows env names are, so a `server__port`
 * written in lowercase is removed too. Non-per-session agents get the input
 * object back untouched; a per-session agent gets a new object and never
 * mutates the caller's.
 */
export function perSessionLaunchEnv(env: Record<string, string>, agentId: string): Record<string, string> {
  if (!isPerSessionAgent(agentId)) return env
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (upper === 'SERVER__PORT' || upper === 'SERVER__HOST') continue
    kept[key] = value
  }
  return kept
}
