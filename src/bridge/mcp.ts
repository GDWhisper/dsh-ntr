import { fileURLToPath } from 'node:url'

import type { McpServer, McpServerHttp, McpServerSse, McpServerStdio } from '@agentclientprotocol/sdk'
import type { AcpMcpServerDef } from '../protocol.ts'
import { pluginStateDir } from './state-paths.ts'

/**
 * The ACP name of the built-in read-only skills server. It namespaces the
 * agent's tools (`mcp__dsh-skills__skills_list`), so the name is also the
 * collision key the merger checks before appending anything.
 */
export const DSH_SKILLS_MCP_NAME = 'dsh-skills'

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
 * which is why all four entry points must go through this function and read the
 * switch at request time (see `agent-bridge.ts`'s `skillsMcpEnabled` seam).
 *
 * The result is a NEW array every time; the input array, its server objects and
 * the `AcpAgentDef` are never touched, and the built-in entry exists only in the
 * request that is being assembled — it must never reach `agents.json`. A user
 * server already named `dsh-skills` wins: the built-in item is skipped rather
 * than merged into (or replacing) the user's definition.
 */
export function sessionMcpServers(
  defs: AcpMcpServerDef[] | undefined,
  skillsMcpEnabled: boolean,
  builtin: AcpMcpServerDef = dshSkillsMcpServer(),
): AcpMcpServerDef[] {
  const user = defs ?? []
  if (!skillsMcpEnabled) return [...user]
  if (user.some(def => def.name === DSH_SKILLS_MCP_NAME)) return [...user]
  return [...user, builtin]
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
