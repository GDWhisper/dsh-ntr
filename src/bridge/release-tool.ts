/**
 * `acp_release`: the MAIN agent's on-demand idle release.
 *
 * The idle timer frees a delegation's process only after its window (1–60 min,
 * 30 by default). That is the right behaviour for a process nobody is waiting on, but
 * a caller that just finished a batch of delegations often wants the memory
 * back NOW. This tool asks the host to run the SAME idle release immediately.
 *
 * It deliberately cannot do more than an idle release: no turn is interrupted,
 * and a live session is parked only when the agent advertises `session/load`
 * (otherwise it stays up — parking it would lose a conversation the agent
 * could not reload). "Stop this agent" remains the settings card's separate
 * gesture; this tool reports skips instead of forcing them.
 *
 * DI discipline matches the delegate tool: no manager import, no Node APIs. The
 * host passes one closure; the definition is plain data the tools service can
 * register as-is.
 */
import type { BridgeReleaseReport } from './types.ts'

/** What the registration hands the tool: configured ids plus the release itself. */
export interface AcpReleaseHost {
  /** The configured agents (id + display title), for validation and the description. */
  agents(): readonly { id: string; title: string }[]
  /** Run the on-demand idle release; resolves with what was released / skipped. */
  release(agentId?: string): Promise<BridgeReleaseReport>
}

/** The tool's return value: one rendered report line block. */
export interface AcpReleaseOutput {
  text: string
}

const SKIP_COPY = {
  busy: 'still has work in flight',
  'no-resume': 'its sessions cannot be resumed (the agent does not support session/load)',
} as const

/** Aggregate A1's per-process rows into one line per agent. */
function summarize(rows: BridgeReleaseReport): string[] {
  const released = new Map<string, number>()
  for (const entry of rows.released) released.set(entry.agentId, (released.get(entry.agentId) ?? 0) + 1)
  const skipped = new Map<string, string>()
  for (const entry of rows.skipped) {
    // One reason per agent: the first skip explains the process that stayed up.
    if (!skipped.has(entry.agentId)) skipped.set(entry.agentId, SKIP_COPY[entry.reason])
  }
  const lines: string[] = []
  if (released.size > 0) {
    const parts = [...released.entries()].map(([agentId, processes]) => processes > 1 ? `${agentId} (${String(processes)} processes)` : agentId)
    lines.push(`Released idle processes: ${parts.join(', ')}. Related sessions resume automatically on their next message.`)
  }
  if (skipped.size > 0) {
    const parts = [...skipped.entries()].map(([agentId, reason]) => `${agentId} (${reason})`)
    lines.push(`Not released: ${parts.join(', ')}.`)
  }
  if (lines.length === 0) lines.push('Nothing to release right now: no ready ACP process (or all of them have work in flight).')
  return lines
}

/**
 * The register-ready definition. `agent` is an optional narrowing: omitted
 * releases every READY process that the idle rule allows right now.
 */
export function acpReleaseToolDefinition(host: AcpReleaseHost): {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
  execute: (args: unknown) => Promise<AcpReleaseOutput>
} {
  const agents = host.agents()
  const ids = agents.map(agent => agent.id)
  const roster = ids.length === 0 ? '(no agents configured yet)' : ids.join(', ')
  const known = new Set(ids)
  return {
    name: 'acp_release',
    description: 'Release idle ACP agent processes right now (all of them by default), returning memory to the system without waiting for the idle timeout. '
      + 'Only processes with no work in flight are released; sessions on agents that support session/load are parked and resume automatically on their next message. '
      + 'No running turn is ever ended; sessions that cannot be resumed keep their process, and the result says why.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: `Release only this agent's idle processes; omit = all of them. Configured: ${roster}`,
        },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String((value as { text?: unknown } | null | undefined)?.text ?? '') }],
    },
    execute: async args => {
      const row = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const agent = row.agent
      if (agent !== undefined) {
        if (typeof agent !== 'string' || agent === '') {
          return { text: 'acp_release failed: agent must be a non-empty string.' }
        }
        if (!known.has(agent)) {
          const known = ids.length === 0 ? '(no agents configured yet)' : ids.join(', ')
          return { text: `acp_release failed: agent "${agent}" is not configured (configured: ${known}).` }
        }
      }
      try {
        return { text: summarize(await host.release(typeof agent === 'string' ? agent : undefined)).join('\n') }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { text: `acp_release failed: ${message}` }
      }
    },
  }
}
