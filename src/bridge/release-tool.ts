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
  busy: '仍有进行中的工作',
  'no-resume': '会话无法恢复（该 agent 不支持 session/load）',
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
    const parts = [...released.entries()].map(([agentId, processes]) => processes > 1 ? `${agentId}（${String(processes)} 个进程）` : agentId)
    lines.push(`已释放空闲进程：${parts.join('、')}。相关会话下一条消息会自动恢复。`)
  }
  if (skipped.size > 0) {
    const parts = [...skipped.entries()].map(([agentId, reason]) => `${agentId}（${reason}）`)
    lines.push(`未释放：${parts.join('、')}。`)
  }
  if (lines.length === 0) lines.push('没有可立即释放的进程：没有就绪的 ACP 进程（或全部都有进行中的工作）。')
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
  const roster = ids.length === 0 ? '（尚未配置任何 agent）' : ids.join('、')
  const known = new Set(ids)
  return {
    name: 'acp_release',
    description: '立即释放空闲的 ACP agent 进程（默认全部），把内存还给系统，不必等空闲超时。'
      + '只释放没有进行中工作的进程；支持 session/load 的会话会被停放，下一条消息发出时自动恢复。'
      + '不会结束任何正在执行的回合；不能恢复的会话会保留进程并在结果里说明原因。',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: `只释放该 agent 的空闲进程；省略 = 全部。已配置：${roster}`,
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
          return { text: 'acp_release 释放失败：agent 必须是非空字符串。' }
        }
        if (!known.has(agent)) {
          const known = ids.length === 0 ? '（尚未配置任何 agent）' : ids.join('、')
          return { text: `acp_release 释放失败：未配置的 agent "${agent}"（已配置：${known}）。` }
        }
      }
      try {
        return { text: summarize(await host.release(typeof agent === 'string' ? agent : undefined)).join('\n') }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { text: `acp_release 释放失败：${message}` }
      }
    },
  }
}
