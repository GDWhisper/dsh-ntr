import { fileURLToPath } from 'node:url'

import type { McpServer, McpServerHttp, McpServerSse, McpServerStdio } from '@agentclientprotocol/sdk'
import type { AcpAgentDef, AcpMcpServerDef } from '../protocol.ts'
import { pluginStateDir } from './state-paths.ts'

/**
 * The ACP name of the built-in read-only skills server. It namespaces the
 * agent's tools (`mcp__dsh-skills__skills_list`), so the name is also the
 * collision key the merger checks before appending anything.
 */
export const DSH_SKILLS_MCP_NAME = 'dsh-skills'

/**
 * Live per-request MCP context read by `AgentBridge.mcpServersForSession`.
 * Passing a plain `boolean` remains supported for pure bridge unit tests that
 * only toggle `dsh-skills`.
 */
export interface SessionMcpLiveContext {
  skills: boolean
  shared?: readonly AcpMcpServerDef[]
  host?: readonly AcpMcpServerDef[]
}

/**
 * The built-in `dsh-skills` server, in the plugin's normalized shape.
 *
 * `mcp/skills-server.mjs` lives at the PACKAGE ROOT, two levels above this
 * module in both layouts — `src/bridge/mcp.ts` under vitest and
 * `lib/bridge/mcp.js` after `tsc` sit at the same depth (the same trick
 * `PLUGIN_VERSION` uses for `package.json`). It is a plain `.mjs` with no build
 * step and no dependency, so an installed package can always launch it.
 *
 * `command` is `process.execPath`, not `node`: the agent spawns this server and
 * PATH may hold no Node binary the agent can find.
 *
 * `DSH_NTR_STATE_DIR` is written UNCONDITIONALLY, not only under test
 * redirection: the agent spawns this child, so it inherits the AGENT's
 * environment, and only an explicit value guarantees that the server and the
 * plugin derive the same skills root (`dirname(stateDir)/skills`, see
 * docs/plan/dsh-skills-mcp.md §4).
 */
export function dshSkillsMcpServer(): AcpMcpServerDef {
  const serverPath = fileURLToPath(new URL('../../mcp/skills-server.mjs', import.meta.url))
  return {
    name: DSH_SKILLS_MCP_NAME,
    transport: 'stdio',
    command: process.execPath,
    args: [serverPath],
    env: { DSH_NTR_STATE_DIR: pluginStateDir() },
  }
}

/**
 * The ONE runtime merger for the four session-creating requests (`session/new`,
 * the probe's `session/new`, `session/load`, `session/fork`).
 *
 * The agent keeps MCP servers per PROCESS, so a probe or fork handing over a
 * different list replaces the tools of every live session on that connection —
 * which is why all four entry points must go through this function and read
 * every live switch at request time.
 *
 * Precedence (first-seen `name` wins, no duplicates):
 *   1. agent-private `defs` (`AcpAgentDef.mcpServers`)
 *   2. plugin-wide `shared` (`sharedMcpServers`)
 *   3. host-synced `hostSynced` (`ctx.mcpManager.config.servers`)
 *   4. built-in `dsh-skills` (when `skillsMcpEnabled`)
 *
 * The result is a NEW array every time; input arrays, server objects and the
 * `AcpAgentDef` are never mutated, and merged entries exist only in the request
 * being assembled — they never reach `agents.json`'s per-agent definitions.
 */
export function sessionMcpServers(
  defs: AcpMcpServerDef[] | undefined,
  skillsMcpEnabled: boolean,
  builtin: AcpMcpServerDef = dshSkillsMcpServer(),
  shared?: readonly AcpMcpServerDef[],
  hostSynced?: readonly AcpMcpServerDef[],
): AcpMcpServerDef[] {
  const result: AcpMcpServerDef[] = []
  const seen = new Set<string>()
  const append = (items: readonly AcpMcpServerDef[] | undefined): void => {
    if (items === undefined) return
    for (const def of items) {
      if (seen.has(def.name)) continue
      seen.add(def.name)
      result.push(def)
    }
  }
  append(defs)
  append(shared)
  append(hostSynced)
  if (skillsMcpEnabled && !seen.has(builtin.name)) result.push(builtin)
  return result
}

/**
 * Resolve one agent's effective MCP list from its definition and the live
 * request-time seam. Honors both per-agent opt-outs (`skillsMcpEnabled !== false`
 * and `sharedMcpEnabled !== false`) without mutating `def`.
 */
export function resolveSessionMcp(
  def: Pick<AcpAgentDef, 'mcpServers' | 'skillsMcpEnabled' | 'sharedMcpEnabled'>,
  live: boolean | SessionMcpLiveContext | undefined,
): AcpMcpServerDef[] {
  const ctx: SessionMcpLiveContext = typeof live === 'boolean' ? { skills: live } : (live ?? { skills: false })
  const skillsOn = ctx.skills && def.skillsMcpEnabled !== false
  const sharedOn = def.sharedMcpEnabled !== false
  return sessionMcpServers(
    def.mcpServers,
    skillsOn,
    dshSkillsMcpServer(),
    sharedOn ? ctx.shared : undefined,
    sharedOn ? ctx.host : undefined,
  )
}

/**
 * The plugin's normalized MCP server shape → the ACP wire shape.
 *
 * THE WIRE SHAPE IS ASYMMETRIC, and getting it wrong is SILENT:
 *
 *  - the stdio variant carries NO `type` field — an entry that carries
 *    `type:'stdio'` is accepted by the agent and then never connected
 *    (measured against codebuddy: the server never appeared, the agent just
 *    reported the tool as missing);
 *  - http/sse DO carry `type`;
 *  - `env` / `headers` are `[{name,value}]` arrays on the wire, while the
 *    plugin stores them as records (like `AcpAgentDef.env`).
 *
 * So the conversion lives here, once, and each branch is annotated with the
 * SDK's OWN variant type — a wrong conversion does not compile. (The bare
 * `McpServer` union is too loose to catch it: its excess-property check
 * accepts any member's keys, so a stdio entry carrying `type:'stdio'` would
 * type-check against the http variant and only fail at runtime, inside the
 * agent, as a server that never connects.)
 */
export function toAcpMcpServers(defs: AcpMcpServerDef[] | undefined): McpServer[] {
  if (defs === undefined) return []
  return defs.map(def => {
    if (def.transport === 'stdio') {
      // NO `type` here — see the note above.
      const server: McpServerStdio = {
        name: def.name,
        command: def.command,
        args: def.args ?? [],
        env: Object.entries(def.env ?? {}).map(([name, value]) => ({ name, value })),
      }
      return server
    }
    if (def.transport === 'http') {
      const server: McpServerHttp & { type: 'http' } = {
        type: 'http',
        name: def.name,
        url: def.url,
        headers: Object.entries(def.headers ?? {}).map(([name, value]) => ({ name, value })),
      }
      return server
    }
    const server: McpServerSse & { type: 'sse' } = {
      type: 'sse',
      name: def.name,
      url: def.url,
      headers: Object.entries(def.headers ?? {}).map(([name, value]) => ({ name, value })),
    }
    return server
  })
}
