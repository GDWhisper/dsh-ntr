/**
 * Render-time helpers shared by the settings clusters: the store subscription
 * hook, the status vocabulary, and the comparators that decide whether the form
 * differs from what is persisted.
 *
 * The exposure / env comparators are order-insensitive on purpose — their doc
 * comments carry the reasons, and `payloadEquals` (form.ts) is the one place
 * they are combined into a dirty verdict.
 */
import { useSyncExternalStore } from 'react'
import type { AcpStore } from '../store.ts'
import type { AcpAgentDef, AgentView, DetectedAgentInfo } from '../../protocol.ts'

export function useUi(acp: AcpStore) {
  return useSyncExternalStore(cb => acp.subscribe(cb), () => acp.getSnapshot())
}

export function stateVisual(state: AgentView['state'], acp: AcpStore): { color: string; text: string; title?: string } {
  switch (state) {
    case 'ready': return { color: 'var(--dsw-alias-state-success-primary, #22c55e)', text: acp.label('已连接', 'Connected') }
    case 'starting': return { color: 'var(--dsw-alias-state-warn-primary, #eab308)', text: acp.label('启动中', 'Starting') }
    case 'error': return { color: 'var(--dsw-alias-state-error-primary, #ef4444)', text: acp.label('错误', 'Error') }
    // A configured-but-resting agent is the normal state, not a fault: the
    // process is not kept resident and connects on demand the first time a DSH
    // chat turn uses it. Surfacing a runtime lifecycle here ("stopped"/"idle")
    // read as broken; the user's real question at a glance is "is it set up?",
    // which the config-time 测试连接 (agent/test) already answers. So the
    // resting state just says 已配置.
    default: return {
      color: 'var(--dsw-alias-state-idle-primary, #9ca3af)',
      text: acp.label('已配置', 'Configured'),
      title: acp.label(
        '已配置，进程不常驻。在 DSH 聊天中首次使用时自动连接；展开区可用「测试连接」验证命令能否正常起来。',
        'Configured; the process is not kept resident. It connects automatically the first time a DSH chat turn uses it — use “Test connection” in the expanded panel to verify the command starts.',
      ),
    }
  }
}

/** Bilingual label for the event-stream state shown in the toolbar. */
export function streamText(stream: 'init' | 'live' | 'down', acp: AcpStore): string {
  if (stream === 'live') return acp.label('事件流已连接', 'Event stream live')
  if (stream === 'down') return acp.label('事件流已断开', 'Event stream down')
  return acp.label('事件流连接中', 'Event stream connecting')
}

/**
 * Canonical comparable form of an exposure filter. Unset (`undefined`) is the
 * default-open state — every published model is offered — while an explicit
 * `[]` lists nothing; the two are NOT equivalent, or "select all" could never
 * return to the default and a save would be misjudged as dirty.
 */
export function exposureKey(exposed: readonly string[] | undefined): string {
  if (exposed === undefined) return 'all'
  return exposed.length === 0 ? 'none' : `set:${exposed.join('\u0000')}`
}

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function sameStringMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

/** One value in canonical JSON form: object keys sorted, arrays kept in order. */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => [key, canonicalJson(entry)])
  return Object.fromEntries(entries)
}

/**
 * Detected presets split by configured-ness, plus configured agents missing
 * from detection (custom / legacy persisted defs) synthesized into card
 * entries so they stay manageable.
 */
export function partitionAgents(
  detectedAgents: readonly DetectedAgentInfo[],
  agents: readonly AgentView[],
): { configured: Array<{ info: DetectedAgentInfo; synthesized: boolean }>; available: DetectedAgentInfo[] } {
  const configured: Array<{ info: DetectedAgentInfo; synthesized: boolean }> = []
  const available: DetectedAgentInfo[] = []
  const agentIds = new Set(agents.map(a => a.id))
  const detectedIds = new Set(detectedAgents.map(d => d.id))
  for (const info of detectedAgents) {
    if (agentIds.has(info.id) || info.currentConfig !== undefined) configured.push({ info, synthesized: false })
    else available.push(info)
  }
  for (const agent of agents) {
    if (!detectedIds.has(agent.id)) {
      configured.push({
        info: {
          id: agent.id,
          name: agent.title,
          detected: false,
          defaultCommand: agent.command,
          defaultArgs: [...agent.args],
        },
        synthesized: true,
      })
    }
  }
  return { configured, available }
}

/**
 * The persisted definition a save would replace. `currentConfig` is the full
 * def (env / npmPackage / exposedModels included); the synthesized fallback
 * covers only the fields an `AgentView` carries, so anything else compares as
 * "changed" — the honest answer when the host never reported it.
 *
 * The idle-release field is compared AS STORED: an absent per-agent field
 * means "follow the global window", and the host's resolved value must not be
 * written back into it — that would freeze the global window into this agent's
 * definition and the global slider would then never reach it.
 */
export function persistedDef(detected: DetectedAgentInfo, activeAgent: AgentView | undefined): AcpAgentDef | undefined {
  if (detected.currentConfig !== undefined) return detected.currentConfig
  if (activeAgent === undefined) return undefined
  return {
    id: activeAgent.id,
    title: activeAgent.title,
    command: activeAgent.command,
    args: [...activeAgent.args],
    ...(activeAgent.cwd === undefined ? {} : { cwd: activeAgent.cwd }),
    allowedCwdRoots: [...activeAgent.allowedCwdRoots],
    env: {},
  }
}

/**
 * A slider tick label's left offset: the exact rung fraction i/(n-1). The
 * label centers on its rung (first/last stay flush via CSS); space-between
 * drifted the middle labels off the track whenever label widths differed.
 */
export function tickLeft(index: number, count: number): string {
  return `${(index / (count - 1)) * 100}%`
}
