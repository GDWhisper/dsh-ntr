/**
 * Unified MCP settings page (settings page → MCP).
 *
 * Manages three cohesive pieces without triggering `agent/save` or restarting
 * running agent processes:
 *   1. Plugin-wide shared MCP servers (`sharedMcpServers`, normalized JSON).
 *   2. Optional live sync from the host's `@deepseek-ai/dsh-mcp-manager`
 *      (`hostSyncEnabled`), shown when the host exposes `ctx.mcpManager`.
 *      Entries carrying `${credential:...}` templates are skipped for safety
 *      and flagged read-only so users know why they are excluded.
 *   3. Per-agent opt-out toggles (`agent/set-shared-mcp`), default ON, using
 *      the same single-row `PillSwitch` layout as the「技能」page.
 */
import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpHostMcpServerSummary, AcpMcpServerDef } from '../protocol.ts'
import type { AcpStore, UiState } from './store.ts'
import { PillSwitch } from './skills-mcp-preference.tsx'
import { mcpTextValid, parseMcpServers } from './panel/form.ts'

const SHARED_EXPLANATION = [
  '统一配置给所有已启用智能体共享的 MCP 服务器（JSON 数组）。',
  'Configure shared MCP servers offered to all enabled agents (JSON array).',
] as const

const SHARED_DETAIL = [
  '保存后只对新建、恢复或分叉的对话生效，不会重启运行中的会话。若单个智能体单独配置了同名服务器，以智能体自身配置优先。',
  'Applies to new, resumed, or forked conversations without restarting live turns. An agent-private server with the same name takes precedence.',
] as const

const HOST_SYNC_EXPLANATION = [
  '将 DSH 宿主（dsh-mcp-manager）中已启用的 MCP 服务器自动同步给智能体。',
  'Automatically sync enabled MCP servers from the DSH host (dsh-mcp-manager).',
] as const

const HOST_SYNC_DETAIL = [
  '只同步宿主配置里已启用且不含 ${credential:...} 凭据模板的条目；含凭据模板的条目会自动跳过，避免向外部进程透传明文密钥。优先级：智能体私有 > 插件全局 > 宿主同步。',
  'Syncs enabled host entries that do not contain ${credential:...} templates; templated entries are skipped to avoid leaking plaintext secrets. Precedence: agent-private > plugin-shared > host-synced.',
] as const

function formatServers(servers: readonly AcpMcpServerDef[]): string {
  return servers.length === 0 ? '' : JSON.stringify(servers, null, 2)
}

function hostStatusBadge(acp: AcpStore, row: AcpHostMcpServerSummary): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!row.enabled) return { text: acp.label('已停用', 'Disabled'), tone: 'muted' }
  if (row.hasCredentialTemplate) return { text: acp.label('含凭据模板（已跳过）', 'Credential template (skipped)'), tone: 'warn' }
  if (row.hasCwd) return { text: acp.label('可同步（忽略 cwd）', 'Syncable (cwd ignored)'), tone: 'ok' }
  return { text: acp.label('可同步', 'Syncable'), tone: 'ok' }
}

function hostBadgeClass(tone: 'ok' | 'warn' | 'muted'): string {
  if (tone === 'ok') return 'dwa-badge dwa-badge-success'
  if (tone === 'warn') return 'dwa-badge dwa-badge-warn'
  return 'dwa-badge'
}

export function SharedMcpPreference(props: {
  acp: AcpStore
  ui: UiState
  agents: readonly { id: string; name: string; enabled: boolean }[]
}) {
  const { acp, ui, agents } = props
  const sharedMcp = ui.sharedMcp
  const serverText = formatServers(sharedMcp?.servers ?? [])
  const serverJson = JSON.stringify(sharedMcp?.servers ?? [])
  const [draft, setDraft] = useState(serverText)
  const [saving, setSaving] = useState(false)
  const syncedTextRef = useRef(serverText)
  const pendingSaveJsonRef = useRef<string | null>(null)
  const hostSyncInFlightRef = useRef(false)
  const agentInFlightRef = useRef(new Set<string>())

  useEffect(() => {
    const prevSynced = syncedTextRef.current
    if (serverText === prevSynced) return
    syncedTextRef.current = serverText
    setDraft(current => {
      if (current === prevSynced) return serverText
      const pendingJson = pendingSaveJsonRef.current
      if (pendingJson !== null && serverJson === pendingJson) {
        const currentParsed = mcpTextValid(current) ? (parseMcpServers(current) ?? []) : undefined
        if (currentParsed !== undefined && JSON.stringify(currentParsed) === pendingJson) {
          pendingSaveJsonRef.current = null
          return serverText
        }
      }
      return current
    })
  }, [serverText, serverJson])

  if (sharedMcp === undefined) return null

  const valid = mcpTextValid(draft)
  const parsed = valid ? (parseMcpServers(draft) ?? []) : undefined
  const dirty = valid && JSON.stringify(parsed) !== serverJson
  const hostServers = sharedMcp.hostServers ?? []

  const onSaveServers = async (): Promise<void> => {
    if (!valid || parsed === undefined || !dirty || saving) return
    pendingSaveJsonRef.current = JSON.stringify(parsed)
    setSaving(true)
    try {
      await acp.setSharedMcp({ servers: parsed })
    } finally {
      setSaving(false)
    }
  }

  const toggleHostSync = async (checked: boolean): Promise<void> => {
    if (hostSyncInFlightRef.current) return
    hostSyncInFlightRef.current = true
    try {
      await acp.setSharedMcp({ hostSyncEnabled: checked })
    } finally {
      hostSyncInFlightRef.current = false
    }
  }

  const toggleAgent = async (agentId: string, checked: boolean): Promise<void> => {
    if (agentInFlightRef.current.has(agentId)) return
    agentInFlightRef.current.add(agentId)
    try {
      await acp.setAgentSharedMcp(agentId, checked)
    } finally {
      agentInFlightRef.current.delete(agentId)
    }
  }

  return (
    <section className="dwa-section">
      <div className="dwa-card dwa-mcp-card">
        <div className="dwa-row-split">
          <div className="dwa-row-main">
            <h3 className="dwa-row-title">{acp.label('全局 MCP 服务器', 'Shared MCP Servers')}</h3>
            <p className="dwa-row-desc">{acp.label(SHARED_EXPLANATION[0], SHARED_EXPLANATION[1])}</p>
          </div>
          <div className="dwa-row-side">
            <Tooltip label={acp.label(SHARED_DETAIL[0], SHARED_DETAIL[1])} side="top">
              <button
                type="button"
                className="dwa-info-btn"
                aria-label={acp.label('关于全局 MCP 服务器', 'About Shared MCP Servers')}
              >
                i
              </button>
            </Tooltip>
            <button
              type="button"
              className="dwa-btn dwa-btn-primary"
              disabled={!dirty || !valid || saving}
              onClick={() => void onSaveServers()}
            >
              {saving ? acp.label('保存中…', 'Saving…') : acp.label('保存', 'Save')}
            </button>
          </div>
        </div>
        <textarea
          className="dwa-input dwa-input-mono dwa-mcp-textarea"
          rows={6}
          spellCheck={false}
          aria-label={acp.label('全局 MCP 服务器 JSON', 'Shared MCP servers JSON')}
          value={draft}
          onChange={e => {
            pendingSaveJsonRef.current = null
            setDraft(e.target.value)
          }}
          placeholder={'[\n  { "name": "example", "transport": "stdio", "command": "/abs/path/to/server", "args": ["--mcp"] }\n]'}
        />
        {!valid && (
          <p className="dwa-error" role="alert">
            {acp.label(
              'MCP 配置格式无效：需要 JSON 数组，每项包含唯一 name、transport（stdio / http / sse）及对应的 command 或 url。',
              'Invalid MCP JSON: expected an array of entries with unique name, transport (stdio / http / sse), and command or url.',
            )}
          </p>
        )}
      </div>

      {sharedMcp.hostAvailable && (
        <div className="dwa-card dwa-mcp-card">
          <div className="dwa-row-split">
            <div className="dwa-row-main">
              <h3 className="dwa-row-title">{acp.label('同步 DSH 宿主 MCP', 'Sync DSH Host MCP')}</h3>
              <p className="dwa-row-desc">{acp.label(HOST_SYNC_EXPLANATION[0], HOST_SYNC_EXPLANATION[1])}</p>
            </div>
            <div className="dwa-row-side">
              <Tooltip label={acp.label(HOST_SYNC_DETAIL[0], HOST_SYNC_DETAIL[1])} side="top">
                <button
                  type="button"
                  className="dwa-info-btn"
                  aria-label={acp.label('关于同步 DSH 宿主 MCP', 'About Sync DSH Host MCP')}
                >
                  i
                </button>
              </Tooltip>
              <PillSwitch
                checked={sharedMcp.hostSyncEnabled}
                label={acp.label('同步 DSH 宿主 MCP', 'Sync DSH Host MCP')}
                onChange={checked => void toggleHostSync(checked)}
              />
            </div>
          </div>
          {hostServers.length > 0 ? (
            <div className="dwa-mcp-host-list">
              {hostServers.map(row => {
                const badge = hostStatusBadge(acp, row)
                return (
                  <div key={row.name} className="dwa-mcp-host-row">
                    <span className="dwa-mcp-host-name">
                      <code className="dwa-mono">{row.name}</code>
                      <span className="dwa-mcp-host-transport">{row.transport}</span>
                    </span>
                    <span className={hostBadgeClass(badge.tone)}>{badge.text}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="dwa-row-desc">
              {acp.label('宿主 dsh-mcp-manager 当前未配置服务器。', 'No servers configured in host dsh-mcp-manager.')}
            </p>
          )}
        </div>
      )}

      {agents.length > 0 && (
        <div className="dwa-mcp-agents">
          <div className="dwa-section-heading">
            <div>
              <h4 className="dwa-subsection-title">{acp.label('按智能体开关', 'Per-agent availability')}</h4>
              <p className="dwa-section-copy">
                {acp.label(
                  '关闭后，该智能体不再接收上方的全局与宿主 MCP；其私有配置与 DSH 技能发现不受影响。',
                  'When turned off, the agent no longer receives the shared or host-synced MCP servers above; its own mcpServers and DSH Skill Discovery remain unaffected.',
                )}
              </p>
            </div>
          </div>
          <div className="dwa-skills-agents">
            {agents.map(agent => (
              <div key={agent.id} className="dwa-preference-row">
                <span className="dwa-preference-label">{agent.name}</span>
                <span className="dwa-skills-row-control">
                  <PillSwitch
                    checked={agent.enabled}
                    label={acp.label(`对 ${agent.name} 启用统一 MCP`, `Enable unified MCP for ${agent.name}`)}
                    onChange={checked => void toggleAgent(agent.id, checked)}
                  />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
