import type { McpServer, McpServerHttp, McpServerSse, McpServerStdio } from '@agentclientprotocol/sdk'
import type { AcpMcpServerDef } from '../protocol.ts'

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
