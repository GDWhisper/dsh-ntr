/**
 * Structural adapter for the host's `@deepseek-ai/dsh-mcp-manager` service
 * (`ctx.mcpManager`, available in DSH 0.2.2+).
 *
 * Probed optionally via `ctx.get('mcpManager')` — never a required `inject`
 * dependency, so older hosts without it keep loading `dsh-ntr` normally.
 *
 * Security boundary: `dsh-mcp-manager` entries may carry `${credential:REF}`
 * templates in `command`, `args`, `env`, `cwd`, `url`, or `headers`. External
 * ACP agents cannot expand those templates, and expanding them here would hand
 * plaintext host secrets over stdio JSON-RPC to third-party agent processes.
 * Entries containing any `${...}` template are therefore skipped from sync and
 * flagged with `hasCredentialTemplate: true` in the read-only UI summary.
 */

import type { AcpHostMcpServerSummary, AcpMcpServerDef } from '../protocol.ts'
import { MCP_SERVER_NAME_MAX, MCP_SERVERS_MAX } from '../protocol.ts'

/** Minimal structural shape of one `dsh-mcp-manager` server entry. */
export interface HostMcpManagedEntryLike {
  transport?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  cwd?: unknown
  url?: unknown
  headers?: unknown
  enabled?: unknown
}

/** Minimal structural shape of `@deepseek-ai/dsh-mcp-manager` (`ctx.mcpManager`). */
export interface HostMcpManagerLike {
  config?: {
    servers?: {
      get?: () => Record<string, HostMcpManagedEntryLike>
    }
  }
}

/** Snapshot returned by {@link readHostMcpSnapshot}. */
export interface HostMcpSnapshot {
  /** Whether a readable host `mcpManager` service is wired. */
  available: boolean
  /** Read-only summaries of every recognized host entry (including disabled / skipped). */
  summaries: AcpHostMcpServerSummary[]
  /** Syncable entries converted into the plugin's normalized `AcpMcpServerDef` shape. */
  servers: AcpMcpServerDef[]
}

const TEMPLATE_TOKEN = /\$\{[^}]*\}/

function hasTemplate(value: string): boolean {
  return TEMPLATE_TOKEN.test(value)
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) return undefined
  return raw as string[]
}

function parseStringRecord(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') return undefined
    out[k] = v
  }
  return out
}

function collectStrings(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string')
  if (raw !== null && typeof raw === 'object') {
    return Object.values(raw as Record<string, unknown>).filter((item): item is string => typeof item === 'string')
  }
  return []
}

function entryHasTemplate(entry: HostMcpManagedEntryLike): boolean {
  if (entry.transport === 'stdio') {
    const command = typeof entry.command === 'string' ? entry.command : ''
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
    return hasTemplate(command)
      || collectStrings(entry.args).some(hasTemplate)
      || collectStrings(entry.env).some(hasTemplate)
      || hasTemplate(cwd)
  }
  const url = typeof entry.url === 'string' ? entry.url : ''
  return hasTemplate(url) || collectStrings(entry.headers).some(hasTemplate)
}

/**
 * Read the host `dsh-mcp-manager` configured servers (`config.servers.get()`),
 * returning both the UI summary list and the syncable normalized definitions.
 *
 * Plugin-registered entries (`mcpManager.register()`) are private to the host
 * manager and intentionally outside this snapshot. Never throws: an unreadable
 * or misbehaving host service degrades to `{ available: false, summaries: [], servers: [] }`.
 */
export function readHostMcpSnapshot(manager: HostMcpManagerLike | undefined): HostMcpSnapshot {
  const getter = manager?.config?.servers?.get
  if (typeof getter !== 'function') {
    return { available: false, summaries: [], servers: [] }
  }
  let rawEntries: Record<string, HostMcpManagedEntryLike> | undefined
  try {
    rawEntries = getter.call(manager?.config?.servers)
  } catch {
    return { available: false, summaries: [], servers: [] }
  }
  if (rawEntries === null || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
    return { available: true, summaries: [], servers: [] }
  }

  const summaries: AcpHostMcpServerSummary[] = []
  const servers: AcpMcpServerDef[] = []

  for (const [name, entry] of Object.entries(rawEntries)) {
    if (name.trim() === '' || name.length > MCP_SERVER_NAME_MAX || entry === null || typeof entry !== 'object') continue
    const enabled = entry.enabled !== false
    const hasCredentialTemplate = entryHasTemplate(entry)

    if (entry.transport === 'stdio') {
      const command = typeof entry.command === 'string' ? entry.command.trim() : ''
      const args = parseStringArray(entry.args)
      const env = parseStringRecord(entry.env)
      if (command === '' || args === undefined || env === undefined) continue
      const hasCwd = typeof entry.cwd === 'string' && entry.cwd.trim() !== ''
      const syncable = enabled && !hasCredentialTemplate && servers.length < MCP_SERVERS_MAX
      summaries.push({
        name,
        transport: 'stdio',
        enabled,
        ...(hasCredentialTemplate ? { hasCredentialTemplate: true } : {}),
        ...(hasCwd ? { hasCwd: true } : {}),
        syncable,
      })
      if (syncable) {
        servers.push({
          name,
          transport: 'stdio',
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        })
      }
      continue
    }

    if (entry.transport === 'streamable-http' || entry.transport === 'http' || entry.transport === 'sse') {
      const transport = entry.transport === 'sse' ? 'sse' : 'http'
      const url = typeof entry.url === 'string' ? entry.url.trim() : ''
      const headers = parseStringRecord(entry.headers)
      if (url === '' || headers === undefined) continue
      const syncable = enabled && !hasCredentialTemplate && servers.length < MCP_SERVERS_MAX
      summaries.push({
        name,
        transport,
        enabled,
        ...(hasCredentialTemplate ? { hasCredentialTemplate: true } : {}),
        syncable,
      })
      if (syncable) {
        servers.push({
          name,
          transport,
          url,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        })
      }
    }
  }

  return { available: true, summaries, servers }
}
