/**
 * React surface for ACP: the settings configuration section.
 *
 * Scope is deliberately narrow — this is a CONFIGURATION surface. Runtime
 * interaction lives in the conversation: permission asks are answered in the
 * chat composer through the host approval chain (`approvalRouted` below), and
 * the ledger card is only the degraded fallback for a host without it.
 *
 * Each configured agent is one compact row (status + current model + badges)
 * that expands into the full connection form and model catalog. The row stays
 * mounted and the body toggles `display`, so editing a form and collapsing it
 * never loses the in-progress values.
 * All business state lives in the injected AcpStore.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DEFAULT_KNOWN_PRESETS } from './store.ts'
import type { AcpStore } from './store.ts'
import type { AcpAgentDef, AgentSavePayload, AgentView, DetectedAgentInfo, PermissionMode } from '../protocol.ts'

interface WithStore { acp: AcpStore }

/**
 * Mirrors `AGENT_ID_PATTERN` in impl.ts — the client cannot import host-side
 * modules, so this copy must stay in sync (same deal as the preset copies,
 * constraint 7).
 */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Preset ids (drives the「自定义」badge); mirrors AGENT_PRESETS via store copies. */
const PRESET_IDS = new Set(DEFAULT_KNOWN_PRESETS.map(preset => preset.id))

/** Seed for the from-scratch creation card: no preset, no tested default. */
const NEW_AGENT_SEED: DetectedAgentInfo = {
  id: '',
  name: '',
  detected: false,
  defaultCommand: '',
  defaultArgs: [],
}

/** How long a chip edit is coalesced before the lightweight exposure RPC fires. */
const EXPOSURE_SAVE_DEBOUNCE_MS = 400

/** Chips rendered while the model list is collapsed (the rest need 「展开全部」). */
const CHIP_COLLAPSED_LIMIT = 12

const STYLE = `
/* Local design tokens: one place to converge spacing, radii and type sizes. */
.dwa-root { --ntr-gap-1: 4px; --ntr-gap-2: 8px; --ntr-gap-3: 12px; --ntr-gap-4: 16px; --ntr-radius: 8px; --ntr-radius-sm: 6px; --ntr-font: 13px; --ntr-font-sm: 12px; --ntr-font-xs: 11px; --ntr-line: 1px solid var(--dsw-alias-border-l2, #e5e7eb); --ntr-muted: var(--dsw-alias-text-secondary, #6b7280); --ntr-danger: #dc2626; --ntr-warn: #b45309; }
.dwa-root { padding: var(--ntr-gap-4); overflow: auto; font-size: var(--ntr-font); line-height: 1.5; }
.dwa-btn { font: inherit; border-radius: var(--ntr-radius-sm); border: 1px solid var(--dsw-alias-border-l2, #bbb); background: var(--dsw-alias-button-tool-bar-fill, transparent); padding: 5px 12px; cursor: pointer; color: inherit; font-size: var(--ntr-font-sm); display: inline-flex; align-items: center; gap: 5px; transition: background 0.15s ease; }
.dwa-btn:hover { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
.dwa-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dwa-btn-primary { background: var(--dsw-alias-button-primary-fill, #2563eb); color: var(--dsw-alias-button-primary-invert, #fff); border-color: transparent; font-weight: 500; }
.dwa-btn-primary:hover { opacity: 0.9; }
.dwa-btn-danger { color: var(--ntr-danger); border-color: #fca5a5; }
.dwa-btn-danger:hover { background: #fee2e2; }
.dwa-btn-secondary { background: var(--dsw-alias-bg-layer-2, #f3f4f6); border-color: var(--dsw-alias-border-l2, #d1d5db); }
.dwa-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.dwa-badge { font-size: var(--ntr-font-xs); border-radius: 4px; padding: 2px 8px; background: #6b728022; font-weight: 500; display: inline-flex; align-items: center; gap: var(--ntr-gap-1); }
.dwa-badge-success { background: #22c55e22; color: #16a34a; font-weight: 600; }
.dwa-badge-warn { background: #f59e0b22; color: #d97706; font-weight: 600; }
.dwa-badge-info { background: #3b82f622; color: #2563eb; font-weight: 500; }
.dwa-card { border: var(--ntr-line); border-radius: var(--ntr-radius); padding: var(--ntr-gap-3) 14px; background: var(--dsw-alias-bg-layer-1, #fafafa); font-size: var(--ntr-font); line-height: 1.5; }
.dwa-card-warn { border-left: 4px solid var(--dsw-alias-state-warn-primary, #d97706); background: var(--dsw-alias-state-warn-secondary, #fffbeb); }
.dwa-select { font: inherit; font-size: var(--ntr-font-sm); padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #ccc); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; }
.dwa-input { font: inherit; font-size: var(--ntr-font-sm); padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #ccc); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; width: 100%; box-sizing: border-box; }
.dwa-input:focus, .dwa-select:focus { outline: none; border-color: var(--dsw-alias-button-primary-fill, #2563eb); }
.dwa-input-mono, .dwa-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.dwa-stderr { max-height: 120px; overflow: auto; font-family: monospace; font-size: var(--ntr-font-xs); white-space: pre-wrap; color: var(--ntr-warn); margin: var(--ntr-gap-1) 0 0; }

.dwa-section-title { font-size: var(--ntr-font); font-weight: 600; margin: 0 0 var(--ntr-gap-2); display: flex; align-items: center; justify-content: space-between; }
.dwa-agent-card { border: var(--ntr-line); border-radius: var(--ntr-radius); background: var(--dsw-alias-bg-layer-1, #fff); margin-bottom: var(--ntr-gap-2); box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.03); }
.dwa-agent-row { display: flex; align-items: center; gap: var(--ntr-gap-2); padding: 10px 14px; flex-wrap: wrap; }
.dwa-agent-name { font-size: var(--ntr-font); font-weight: 600; }
.dwa-agent-body { border-top: var(--ntr-line); padding: var(--ntr-gap-3) 14px; }
.dwa-form-row { display: flex; gap: var(--ntr-gap-3); margin-bottom: 10px; align-items: flex-start; }
.dwa-form-col { flex: 1; display: flex; flex-direction: column; gap: var(--ntr-gap-1); min-width: 0; }
.dwa-form-label { font-size: var(--ntr-font-sm); font-weight: 600; color: var(--dsw-alias-text-secondary, #4b5563); }
.dwa-hint { font-size: var(--ntr-font-xs); color: var(--ntr-muted); }
.dwa-error { font-size: var(--ntr-font-xs); color: var(--ntr-danger); }
.dwa-default-hint { background: var(--dsw-alias-bg-layer-2, #f9fafb); border: 1px dashed var(--dsw-alias-border-l2, #d1d5db); border-radius: var(--ntr-radius-sm); padding: 6px 10px; font-size: var(--ntr-font-sm); display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: var(--ntr-gap-2); }
.dwa-menu-wrap { position: relative; margin-left: auto; }
.dwa-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 190px; border: var(--ntr-line); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12); padding: var(--ntr-gap-1); display: flex; flex-direction: column; }
.dwa-menu-item { font: inherit; font-size: var(--ntr-font-sm); text-align: left; border: none; background: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; color: inherit; }
.dwa-menu-item:hover { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
.dwa-menu-item-danger { color: var(--ntr-danger); }
.dwa-menu-confirm { display: flex; align-items: center; gap: var(--ntr-gap-1); padding: 4px 6px; }
.dwa-chip { font: inherit; font-size: var(--ntr-font-sm); border: var(--ntr-line); border-radius: 999px; padding: 3px 12px; background: var(--dsw-alias-bg-layer-2, #f3f4f6); cursor: pointer; color: inherit; }
.dwa-chip-active { border-color: var(--dsw-alias-button-primary-fill, #2563eb); background: #3b82f622; color: #2563eb; font-weight: 500; }
.dwa-chip-list { display: flex; gap: var(--ntr-gap-1); flex-wrap: wrap; align-items: center; margin-top: var(--ntr-gap-2); }
.dwa-chip-model { display: inline-flex; align-items: center; gap: var(--ntr-gap-1); cursor: pointer; }
`

let styleMounted = false
function ensureStyle(): void {
  if (styleMounted || typeof document === 'undefined') return
  styleMounted = true
  const node = document.createElement('style')
  node.textContent = STYLE
  document.head.appendChild(node)
}

function useUi(acp: AcpStore) {
  return useSyncExternalStore(cb => acp.subscribe(cb), () => acp.getSnapshot())
}

function stateVisual(state: AgentView['state'], acp: AcpStore): { color: string; text: string; title?: string } {
  switch (state) {
    case 'ready': return { color: '#22c55e', text: acp.label('已连接', 'Connected') }
    case 'starting': return { color: '#eab308', text: acp.label('启动中', 'Starting') }
    case 'error': return { color: '#ef4444', text: acp.label('错误', 'Error') }
    // A configured-but-resting agent is the normal state, not a fault: the
    // process is not kept resident and connects on demand the first time a DSH
    // chat turn uses it. Surfacing a runtime lifecycle here ("stopped"/"idle")
    // read as broken; the user's real question at a glance is "is it set up?",
    // which the config-time 测试连接 (agent/test) already answers. So the
    // resting state just says 已配置.
    default: return {
      color: '#9ca3af',
      text: acp.label('已配置', 'Configured'),
      title: acp.label(
        '已配置，进程不常驻。在 DSH 聊天中首次使用时自动连接；展开区可用「测试连接」验证命令能否正常起来。',
        'Configured; the process is not kept resident. It connects automatically the first time a DSH chat turn uses it — use “Test connection” in the expanded panel to verify the command starts.',
      ),
    }
  }
}

/** Bilingual label for the event-stream state shown in the toolbar. */
function streamText(stream: 'init' | 'live' | 'down', acp: AcpStore): string {
  if (stream === 'live') return acp.label('事件流已连接', 'Event stream live')
  if (stream === 'down') return acp.label('事件流已断开', 'Event stream down')
  return acp.label('事件流连接中', 'Event stream connecting')
}

/**
 * Canonical comparable form of an exposure filter. Unset and empty mean the
 * same thing host-side (no `agentId@choice` variants), so they share a key —
 * treating them as different would leave a row permanently dirty.
 */
function exposureKey(exposed: readonly string[] | undefined): string {
  return exposed === undefined || exposed.length === 0 ? 'none' : `set:${exposed.join('\u0000')}`
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameStringMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

/**
 * Detected presets split by configured-ness, plus configured agents missing
 * from detection (custom / legacy persisted defs) synthesized into card
 * entries so they stay manageable.
 */
function partitionAgents(
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
 */
/**
 * The idle-release window in effect for an agent: an unset per-agent field is
 * resolved by the HOST and reported back on `AgentView`, so filling it from
 * there keeps "unset" and "explicitly the host default" the same state —
 * merely opening the form must never read as an unsaved change.
 */
function resolvedIdleTimeoutMs(def: AcpAgentDef, activeAgent: AgentView | undefined): AcpAgentDef {
  if (def.idleTimeoutMs !== undefined || activeAgent?.idleTimeoutMs === undefined) return def
  return { ...def, idleTimeoutMs: activeAgent.idleTimeoutMs }
}

function persistedDef(detected: DetectedAgentInfo, activeAgent: AgentView | undefined): AcpAgentDef | undefined {
  if (detected.currentConfig !== undefined) return resolvedIdleTimeoutMs(detected.currentConfig, activeAgent)
  if (activeAgent === undefined) return undefined
  return {
    id: activeAgent.id,
    title: activeAgent.title,
    command: activeAgent.command,
    args: [...activeAgent.args],
    permission: activeAgent.permission,
    ...(activeAgent.cwd === undefined ? {} : { cwd: activeAgent.cwd }),
    allowedCwdRoots: [...activeAgent.allowedCwdRoots],
    env: {},
    ...(activeAgent.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: activeAgent.idleTimeoutMs }),
  }
}

/**
 * Equivalence test between the form payload and what is already persisted.
 * Order-insensitive on purpose: `env` is a map and `args`/`allowedCwdRoots`
 * keep their order, but a reordered allow-list is not a change worth warning
 * about; `exposedModels === undefined` means "offer no variants", which is the
 * same state as an empty list.
 */
function payloadEquals(payload: AgentSavePayload, current: AcpAgentDef): boolean {
  if (payload.command !== current.command) return false
  if ((payload.title ?? payload.id) !== (current.title ?? current.id)) return false
  if (!sameStringArray(payload.args ?? [], current.args ?? [])) return false
  if ((payload.npmPackage ?? '') !== (current.npmPackage ?? '')) return false
  if (payload.permission !== (current.permission ?? 'ask')) return false
  if ((payload.cwd ?? '') !== (current.cwd ?? '')) return false
  if (!sameStringArray(payload.allowedCwdRoots ?? [], current.allowedCwdRoots ?? [])) return false
  if (!sameStringMap(payload.env ?? {}, current.env ?? {})) return false
  if (exposureKey(payload.exposedModels) !== exposureKey(current.exposedModels)) return false
  // An absent field means "use the host default" — which is what `current`
  // already resolved to (see `resolvedIdleTimeoutMs`), so it is not a change.
  if (payload.idleTimeoutMs !== undefined && payload.idleTimeoutMs !== current.idleTimeoutMs) return false
  return true
}

/** Settings configuration section for ACP agents. */
export function AcpSettingsSection(props: WithStore) {
  const acp = props.acp
  ensureStyle()
  const ui = useUi(acp)
  const [addTarget, setAddTarget] = useState<DetectedAgentInfo | undefined>(undefined)
  const { configured, available } = partitionAgents(ui.detectedAgents, ui.agents)
  const addOpen = addTarget !== undefined

  return (
    <div className="dwa-root">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span
          className="dwa-dot"
          style={{ background: ui.stream === 'live' ? '#22c55e' : ui.stream === 'down' ? '#ef4444' : '#9ca3af' }}
          title={ui.stream}
        />
        <span className="dwa-hint" style={{ flex: 1 }}>{streamText(ui.stream, acp)}</span>
        <button
          className="dwa-btn"
          onClick={() => {
            void acp.resync()
            void acp.detectAgents()
          }}
          disabled={ui.detecting}
        >
          {ui.detecting ? acp.label('检测中...', 'Detecting...') : acp.label('重新检测与刷新', 'Re-detect & Refresh')}
        </button>
      </div>

      {/* Approvals live in the conversation now: keep a read-only count so the
          settings page is not silently hiding work in progress. */}
      {ui.approvalRouted && ui.permissions.length > 0 && (
        <div className="dwa-card" style={{ marginBottom: 16 }}>
          <span className="dwa-hint">
            {acp.label(
              `审批已改在对话中处理（${String(ui.permissions.length)} 项待处理）`,
              `Approvals are handled in the conversation (${String(ui.permissions.length)} pending)`,
            )}
          </span>
        </div>
      )}

      {/* Degraded path: no native approval chain → the panel keeps the ledger. */}
      {!ui.approvalRouted && ui.permissions.length > 0 && (
        <div className="dwa-card dwa-card-warn" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {acp.label('待处理权限请求', 'Pending Permission Requests')}
          </div>
          {ui.permissions.map(permission => (
            <div key={permission.requestId} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 160 }}>{permission.title}</span>
              {permission.options.map(option => (
                <button
                  key={option.optionId}
                  className="dwa-btn dwa-btn-primary"
                  onClick={() => void acp.respondPermission(permission.requestId, option.optionId)}
                >
                  {option.name}
                </button>
              ))}
              <button className="dwa-btn" onClick={() => void acp.respondPermission(permission.requestId)}>
                {acp.label('拒绝', 'Dismiss')}
              </button>
            </div>
          ))}
        </div>
      )}

      {ui.notice !== undefined && (
        <div className="dwa-card dwa-card-warn" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{ui.notice}</span>
          <button className="dwa-btn" onClick={() => acp.clearNotice()}>✕</button>
        </div>
      )}

      {/* ACP 模式: the agent preset the new-session chip offers. Host filesystem
          state, so it is reported and repaired here rather than under an agent. */}
      {ui.preset !== undefined && (
        <div className="dwa-card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, flex: 1 }}>
              {acp.label('ACP 模式（智能体预设）', 'ACP mode (agent preset)')}
            </span>
            <span className="dwa-badge">{ui.preset.id}</span>
            <button
              className="dwa-btn"
              onClick={() => void acp.installPreset()}
              disabled={ui.presetInstalling}
            >
              {ui.presetInstalling
                ? acp.label('处理中...', 'Working...')
                : ui.preset.installed
                  ? acp.label('修复缺失文件', 'Repair missing files')
                  : acp.label('安装', 'Install')}
            </button>
          </div>
          <div className="dwa-hint" style={{ marginTop: 6 }}>
            {ui.preset.installed
              ? acp.label(
                `已安装：${ui.preset.dir}。在新建会话页的模式选择里选「ACP 模式」。`,
                `Installed at ${ui.preset.dir}. Pick “ACP mode” in the new-session mode picker.`,
              )
              : acp.label(
                `尚未安装到 ${ui.preset.dir}（宿主下次启动会自动安装）。`,
                `Not installed at ${ui.preset.dir} yet (the host installs it on next boot).`,
              )}
          </div>
          {ui.preset.missing.length > 0 && (
            <div className="dwa-hint" style={{ marginTop: 4, color: '#f59e0b' }}>
              {acp.label(`缺失：${ui.preset.missing.join('、')}`, `Missing: ${ui.preset.missing.join(', ')}`)}
            </div>
          )}
        </div>
      )}

      {/* Connected ACP agents: one compact row per agent, details on demand */}
      <div style={{ marginBottom: 24 }}>
        <div className="dwa-section-title">
          <span>{acp.label('已接入的 ACP 智能体', 'Connected ACP Agents')}</span>
          <span className="dwa-badge">{configured.length}</span>
        </div>

        {configured.length === 0 && (
          <div className="dwa-card" style={{ textAlign: 'center', color: 'var(--ntr-muted)', padding: 20 }}>
            {acp.label(
              '尚未启用任何 Agent。展开下方「添加 Agent」用检测到的预设一键启用，或从零新建自定义 Agent。',
              'No agents configured yet. Expand "Add Agent" to enable a detected preset, or create a custom one from scratch.',
            )}
          </div>
        )}

        {configured.map(({ info, synthesized }) => {
          const activeAgent = ui.agents.find(a => a.id === info.id)
          return (
            <AgentRow
              key={info.id}
              detected={info}
              activeAgent={activeAgent}
              acp={acp}
              isDefault={ui.defaultModel === info.id}
              synthesized={synthesized}
            />
          )
        })}
      </div>

      {/* Agent intake: one collapsible area, preset chips inside it. */}
      <div>
        <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => setAddTarget(current => (current === undefined ? available[0] ?? NEW_AGENT_SEED : undefined))}>
          {addOpen ? '▾' : '▸'} {acp.label('添加 Agent', 'Add Agent')}
        </button>
        {addOpen && addTarget !== undefined && (
          <div style={{ marginTop: 12 }}>
            <div className="dwa-chip-list" style={{ marginTop: 0, marginBottom: 4 }}>
              {available.map(info => (
                <button
                  key={info.id}
                  type="button"
                  className={`dwa-chip${addTarget.id === info.id ? ' dwa-chip-active' : ''}`}
                  onClick={() => setAddTarget(info)}
                  title={info.description}
                >
                  {info.name}
                </button>
              ))}
              <button
                type="button"
                className={`dwa-chip${addTarget.id === '' ? ' dwa-chip-active' : ''}`}
                onClick={() => setAddTarget(NEW_AGENT_SEED)}
              >
                {acp.label('自定义', 'Custom')}
              </button>
            </div>
            {available.length === 0 && addTarget.id === '' && (
              <div className="dwa-hint" style={{ marginBottom: 8 }}>
                {acp.label('没有更多可启用的预设 Agent。', 'No more detected presets to enable.')}
              </div>
            )}
            <AgentRow
              key={addTarget.id}
              detected={addTarget}
              acp={acp}
              isDefault={false}
              synthesized={false}
              newCustom={addTarget.id === ''}
              onCreated={() => setAddTarget(undefined)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** One row per agent: compact when collapsed, the full form when expanded. */
function AgentRow({
  detected,
  activeAgent,
  acp,
  isDefault,
  synthesized,
  newCustom = false,
  onCreated,
}: {
  detected: DetectedAgentInfo
  activeAgent?: AgentView
  acp: AcpStore
  isDefault: boolean
  synthesized: boolean
  /** From-scratch creation: the id is editable and no preset defaults exist. */
  newCustom?: boolean
  /** Fired after a from-scratch save succeeds (closes the creation card). */
  onCreated?: () => void
}) {
  const ui = useUi(acp)
  const configured = activeAgent !== undefined || detected.currentConfig !== undefined
  // A configured agent starts collapsed; a creation card opens straight away
  // (nothing to summarise yet).
  const [expanded, setExpanded] = useState(!configured)
  const [form, setForm] = useState<AgentForm>(() => initialForm(detected, activeAgent))
  const [saving, setSaving] = useState(false)
  const [savedSuccess, setSavedSuccess] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const patch = (next: Partial<AgentForm>): void => setForm(prev => ({ ...prev, ...next }))

  const serverExposureKey = exposureKey(detected.currentConfig?.exposedModels)
  useEffect(() => {
    const server = detected.currentConfig?.exposedModels
    setForm(prev => ({ ...prev, exposed: server === undefined ? undefined : [...server] }))
    // Re-sync the editor only when the persisted filter actually changes, so
    // background resyncs never clobber in-progress checkbox edits.
  }, [serverExposureKey])

  const trimmedId = form.agentId.trim()
  const idValid = !newCustom || AGENT_ID_PATTERN.test(trimmedId)
  const idTaken = newCustom && trimmedId !== '' && ui.agents.some(a => a.id === trimmedId)
  const cwdInvalid = form.cwd.trim() !== '' && !form.cwd.trim().startsWith('/')
  const rootValues = form.roots.map(root => root.trim()).filter(root => root !== '')
  const rootsInvalid = form.rootsOpen && (rootValues.length === 0 || rootValues.some(root => !root.startsWith('/')))
  const idleInvalid = !idleValid(form.idleStr)
  const formIncomplete = form.command.trim() === '' || !idValid || idTaken || cwdInvalid || rootsInvalid || idleInvalid

  const payload = buildPayload(form, detected, newCustom)
  const current = persistedDef(detected, activeAgent)
  const dirty = current !== undefined && !payloadEquals(payload, current)
  // A save stops the child and kills every live session (see BridgeManager.saveAgent).
  const showSaveWarning = dirty && activeAgent !== undefined && activeAgent.state !== 'stopped'

  const handleUseDefault = (): void => patch({ command: detected.defaultCommand, argsStr: detected.defaultArgs.join(' ') })

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setSavedSuccess(false)
    try {
      await acp.saveAgent(payload)
      // A save from the intake card closes it: the agent now lives in the
      // configured list, and leaving the card open would render it twice.
      // Configured rows pass no `onCreated`, so this is a no-op for them.
      onCreated?.()
      if (newCustom) return
      setSavedSuccess(true)
      setTimeout(() => setSavedSuccess(false), 2000)
    } catch {
      // Error handled by store
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(undefined)
    try {
      const result = await acp.testAgent(payload)
      setTestResult(result.ok
        ? {
          ok: true,
          text: acp.label('连接成功', 'Connected') + (result.agentInfo?.name !== undefined ? ` · ${result.agentInfo.name}` : '')
            + (result.agentInfo?.version !== undefined ? ` v${result.agentInfo.version}` : '')
            + ` · ${String(result.durationMs)}ms`,
        }
        : { ok: false, text: result.error ?? acp.label('未知错误', 'Unknown error') })
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  const state = activeAgent !== undefined ? stateVisual(activeAgent.state, acp) : undefined
  const displayName = newCustom
    ? acp.label('新建自定义 Agent', 'New Custom Agent')
    : (activeAgent?.title ?? detected.currentConfig?.title ?? detected.name)
  const stderr = activeAgent?.state === 'error' ? (activeAgent.stderrTail ?? []) : []
  const errorSummary = stderr.length > 0 ? stderr[stderr.length - 1] : undefined
  const currentModel = ui.modelCatalogs[detected.id]?.catalog.model?.currentValue
  const isPreset = PRESET_IDS.has(detected.id)
  // An error row opens itself so the stderr tail is never behind a click.
  const open = expanded || (activeAgent?.state === 'error' && configured)

  return (
    <div className="dwa-agent-card">
      <div className="dwa-agent-row">
        <button
          type="button"
          className="dwa-btn"
          style={{ border: 'none', background: 'none', padding: '0 4px', fontSize: 12 }}
          aria-expanded={open}
          onClick={() => setExpanded(value => !value)}
          title={open ? acp.label('收起', 'Collapse') : acp.label('展开配置与模型', 'Expand configuration and models')}
        >
          {open ? '▾' : '▸'}
        </button>
        {state !== undefined && <span className="dwa-dot" style={{ background: state.color }} title={state.title ?? activeAgent?.state} />}
        <span className="dwa-agent-name" title={detected.executablePath ?? detected.description}>{displayName}</span>
        {state !== undefined && <span className="dwa-hint">{state.text}</span>}
        {configured && (
          <span className="dwa-hint">
            {currentModel === undefined ? acp.label('未探测模型', 'Model not probed') : `${acp.label('模型', 'Model')}: ${currentModel}`}
          </span>
        )}
        {errorSummary !== undefined && (
          <span className="dwa-error dwa-mono" style={{ flexBasis: '100%', wordBreak: 'break-all' }}>{errorSummary}</span>
        )}
        {activeAgent?.state === 'error' && (
          <button className="dwa-btn" disabled={testing} onClick={() => void handleTest()}>
            {testing ? acp.label('测试中...', 'Testing...') : acp.label('测试', 'Test')}
          </button>
        )}
        {!isPreset && !newCustom && <span className="dwa-hint">{acp.label('自定义', 'Custom')}</span>}
        {!synthesized && !newCustom && !detected.detected && (
          <span className="dwa-hint" style={{ color: 'var(--ntr-warn)' }} title={detected.description}>
            {acp.label('未在 PATH 中检测到', 'Not in PATH')}
          </span>
        )}
        {isDefault && (
          <span className="dwa-badge dwa-badge-success">
            ★ {acp.label('默认', 'Default')}
          </span>
        )}
        {configured && (
          <RowMenu
            acp={acp}
            canStop={activeAgent !== undefined && activeAgent.state !== 'stopped'}
            onStop={() => void acp.stopAgent(detected.id)}
            // The store already surfaced the failure as a notice; swallowing it
            // here only prevents an unhandled rejection.
            onRemove={async () => { await acp.deleteAgent(detected.id).catch(() => { /* notice shown by the store */ }) }}
          />
        )}
      </div>

      {/* display-toggled (not conditionally mounted) so an in-progress edit
          survives collapsing the row. */}
      <div className="dwa-agent-body" style={open ? undefined : { display: 'none' }}>
        {stderr.length > 0 && <pre className="dwa-stderr">{stderr.join('\n')}</pre>}
        {configured && (
          <ModelCatalogBlock
            agentId={detected.id}
            detected={detected}
            acp={acp}
            exposed={form.exposed}
            onExposedChange={exposed => patch({ exposed })}
            isDefault={isDefault}
          />
        )}
        <AgentDetails
          acp={acp}
          detected={detected}
          form={form}
          patch={patch}
          isConfigured={configured}
          newCustom={newCustom}
          formIncomplete={formIncomplete}
          idValid={idValid}
          idTaken={idTaken}
          cwdInvalid={cwdInvalid}
          rootsInvalid={rootsInvalid}
          idleInvalid={idleInvalid}
          saving={saving}
          savedSuccess={savedSuccess}
          testing={testing}
          testResult={testResult}
          showSaveWarning={showSaveWarning}
          onUseDefault={handleUseDefault}
          onSave={() => void handleSave()}
          onTest={() => void handleTest()}
        />
      </div>
    </div>
  )
}

/** Everything the connection form edits, in one object (kept in the row). */
interface AgentForm {
  agentId: string
  title: string
  command: string
  argsStr: string
  npmPackage: string
  permission: PermissionMode
  cwd: string
  /** Advanced: edit every allowed root, not just the single workspace dir. */
  rootsOpen: boolean
  roots: string[]
  envRows: Array<{ key: string; value: string }>
  exposed?: string[]
  /** Raw text of the idle-release window in ms ('' = host default, '0' = never). */
  idleStr: string
}

/**
 * Hand copy of `DEFAULT_TUNING.idleTimeoutMs` (src/bridge.ts): the browser
 * cannot import the host plane, and this number is only ever placeholder text
 * for a NOT-yet-configured agent (a configured one renders the host's resolved
 * value from `AgentView.idleTimeoutMs`). Keep the two in sync.
 */
const DEFAULT_IDLE_RELEASE_MS = 1_800_000

function initialForm(detected: DetectedAgentInfo, activeAgent: AgentView | undefined): AgentForm {
  const config = detected.currentConfig
  const roots = [...(activeAgent?.allowedCwdRoots ?? config?.allowedCwdRoots ?? [])]
  return {
    agentId: detected.id,
    title: activeAgent?.title ?? config?.title ?? detected.name,
    command: activeAgent?.command ?? config?.command ?? detected.defaultCommand,
    argsStr: (activeAgent?.args ?? config?.args ?? detected.defaultArgs).join(' '),
    npmPackage: config?.npmPackage ?? '',
    permission: activeAgent?.permission ?? config?.permission ?? 'ask',
    cwd: activeAgent?.cwd ?? config?.cwd ?? '',
    // An agent already carrying more than one root opens in advanced mode:
    // single-root mode narrows the allow-list to `cwd` on save, which must
    // never happen as a side effect of merely opening the form.
    rootsOpen: roots.length > 1,
    roots,
    envRows: Object.entries(config?.env ?? {}).map(([key, value]) => ({ key, value })),
    exposed: config?.exposedModels === undefined ? undefined : [...config.exposedModels],
    // Prefer the host's resolved value: it is the one actually in effect.
    idleStr: idleText(activeAgent?.idleTimeoutMs ?? config?.idleTimeoutMs),
  }
}

function idleText(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/**
 * Assemble the save/test payload.
 *
 * Workspace rules (P0-1): a non-empty single-root `cwd` also pins
 * `allowedCwdRoots` to exactly that path — an explicit narrowing, so saving
 * from the panel can never silently widen the sandbox. An empty `cwd` sends
 * neither field and the host falls back to `~/.dsh/acp-workspaces`. Advanced
 * mode sends the edited roots as-is (deduplicated).
 */
/** `''` = host default, `0` = never release, otherwise a sane millisecond window. */
function idleValid(raw: string): boolean {
  const text = raw.trim()
  if (text === '') return true
  if (!/^\d+$/.test(text)) return false
  const value = Number(text)
  return value === 0 || (value >= 1_000 && value <= 86_400_000)
}

function buildPayload(form: AgentForm, detected: DetectedAgentInfo, newCustom: boolean): AgentSavePayload {
  const env: Record<string, string> = {}
  for (const row of form.envRows) {
    const key = row.key.trim()
    if (key === '') continue
    env[key] = row.value
  }
  const cwd = form.cwd.trim()
  const idleRaw = form.idleStr.trim()
  const payload: AgentSavePayload = {
    id: newCustom ? form.agentId.trim() : detected.id,
    ...(form.title.trim() === '' ? {} : { title: form.title.trim() }),
    command: form.command.trim(),
    args: form.argsStr.trim() === '' ? [] : form.argsStr.trim().split(/\s+/),
    ...(form.npmPackage.trim() === '' ? {} : { npmPackage: form.npmPackage.trim() }),
    permission: form.permission,
    env,
    ...(form.exposed === undefined ? {} : { exposedModels: form.exposed }),
    // `''` sends nothing: the host then applies its own default.
    ...(idleRaw === '' || !idleValid(idleRaw) ? {} : { idleTimeoutMs: Number(idleRaw) }),
  }
  if (form.rootsOpen) {
    if (cwd !== '') payload.cwd = cwd
    const roots = [...new Set(form.roots.map(root => root.trim()).filter(root => root !== ''))]
    if (roots.length > 0) payload.allowedCwdRoots = roots
    return payload
  }
  if (cwd !== '') {
    payload.cwd = cwd
    payload.allowedCwdRoots = [cwd]
  }
  return payload
}

/** The expanded body: connection form, workspace allow-list, env, actions. */
function AgentDetails({
  acp,
  detected,
  form,
  patch,
  isConfigured,
  newCustom,
  formIncomplete,
  idValid,
  idTaken,
  cwdInvalid,
  rootsInvalid,
  idleInvalid,
  saving,
  savedSuccess,
  testing,
  testResult,
  showSaveWarning,
  onUseDefault,
  onSave,
  onTest,
}: {
  acp: AcpStore
  detected: DetectedAgentInfo
  form: AgentForm
  patch: (next: Partial<AgentForm>) => void
  isConfigured: boolean
  newCustom: boolean
  formIncomplete: boolean
  idValid: boolean
  idTaken: boolean
  cwdInvalid: boolean
  rootsInvalid: boolean
  idleInvalid: boolean
  saving: boolean
  savedSuccess: boolean
  testing: boolean
  testResult?: { ok: boolean; text: string }
  showSaveWarning: boolean
  onUseDefault: () => void
  onSave: () => void
  onTest: () => void
}) {
  const ui = useUi(acp)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--dsw-alias-border-l2, #e5e7eb)' }}>
      {/* 基础参数: id / display name / command / args — the preset chip already
          filled command+args, so a plain "enable this agent" flow needs
          nothing below. Everything else lives under 高级参数. */}
      {newCustom && (
        <div className="dwa-form-row">
          <div className="dwa-form-col">
            <label className="dwa-form-label">{acp.label('Agent ID（唯一标识，创建后不可改）', 'Agent ID (unique, immutable after creation)')}</label>
            <input
              className="dwa-input dwa-input-mono"
              value={form.agentId}
              onChange={e => patch({ agentId: e.target.value })}
              placeholder="e.g. my-agent"
            />
            <span className={idValid && !idTaken ? 'dwa-hint' : 'dwa-error'}>
              {idTaken
                ? acp.label('该 ID 已被现有 Agent 占用。', 'This id is already taken by a configured agent.')
                : idValid
                  ? acp.label('小写字母或数字开头，可用 a-z 0-9 . _ -，最长 64 字符。', 'Starts with a lowercase letter or digit; a-z 0-9 . _ - allowed; max 64 chars.')
                  : acp.label('ID 格式不合法：小写字母或数字开头，可用 a-z 0-9 . _ -。', 'Invalid id: start with a lowercase letter or digit; only a-z 0-9 . _ - allowed.')}
            </span>
          </div>
        </div>
      )}

      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('显示名', 'Display Name')}</label>
          <input
            className="dwa-input"
            value={form.title}
            onChange={e => patch({ title: e.target.value })}
            placeholder={detected.name === '' ? acp.label('我的 Agent', 'My Agent') : detected.name}
          />
        </div>
      </div>

      <div className="dwa-form-row">
        <div className="dwa-form-col" style={{ flex: 2 }}>
          <label className="dwa-form-label">{acp.label('命令', 'Command')}</label>
          <input
            className="dwa-input dwa-input-mono"
            value={form.command}
            onChange={e => patch({ command: e.target.value })}
            placeholder="e.g. pi-acp"
          />
        </div>
        <div className="dwa-form-col" style={{ flex: 3 }}>
          <label className="dwa-form-label">{acp.label('参数（空格分隔）', 'Arguments (space-separated)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            value={form.argsStr}
            onChange={e => patch({ argsStr: e.target.value })}
            placeholder="e.g. acp --thinking high"
          />
        </div>
      </div>

      {/* 高级参数: collapsed by default, hidden with `display: none` (never
          unmounted) so an edit in progress survives the toggle. Path validity
          is surfaced on the toggle itself — a collapsed section must not hide
          an error that blocks saving. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="dwa-btn dwa-btn-secondary"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(value => !value)}
        >
          {advancedOpen ? '▾' : '▸'} {acp.label('高级参数', 'Advanced Parameters')}
        </button>
        {!advancedOpen && (cwdInvalid || rootsInvalid) && (
          <span className="dwa-error">
            {acp.label('里面有非法的工作空间路径', 'Contains an invalid workspace path')}
          </span>
        )}
      </div>

      <div style={advancedOpen ? undefined : { display: 'none' }}>
        {!newCustom && (
          <div className="dwa-default-hint">
            <div>
              <span style={{ fontWeight: 600, marginRight: 6 }}>
                {acp.label('官方测试默认命令:', 'Tested Default Command:')}
              </span>
              <code className="dwa-input-mono" style={{ background: '#0000000a', padding: '2px 6px', borderRadius: 4 }}>
                {detected.defaultCommand} {detected.defaultArgs.join(' ')}
              </code>
            </div>
            <button
              type="button"
              className="dwa-btn dwa-btn-secondary"
              onClick={onUseDefault}
              title={acp.label('把命令与参数重置为官方验证值', 'Reset command and arguments to the tested default')}
            >
              {acp.label('使用预设值', 'Use Preset')}
            </button>
          </div>
        )}

      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('npm 包名（PATH 中找不到时自动安装）', 'npm Package (auto-installed when missing from PATH)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            value={form.npmPackage}
            onChange={e => patch({ npmPackage: e.target.value })}
            placeholder={acp.label('原生支持 ACP 的 agent 无需填写', 'Not needed for agents with native ACP support')}
          />
        </div>
      </div>

      {/* This is the *policy* (whether a human is asked at all), NOT the
          approval channel. With `ask` the question surfaces in the chat
          composer when the host approval chain exists (see `approvalRouted`),
          otherwise at the top of this page. `allow`/`reject` never surface
          anything — see `AgentBridge.handlePermissionRequest`. */}
      <div className="dwa-form-row">
        <div className="dwa-form-col" style={{ flex: 2 }}>
          <label className="dwa-form-label">{acp.label('权限策略（要不要问人）', 'Permission Policy (whether to ask)')}</label>
          <select
            className="dwa-select"
            value={form.permission}
            onChange={e => patch({ permission: e.target.value as PermissionMode })}
          >
            <option value="ask">{acp.label('询问人类 (ask)', 'Ask human (ask)')}</option>
            <option value="allow">{acp.label('始终允许，不询问 (allow)', 'Always allow, never ask (allow)')}</option>
            <option value="reject">{acp.label('自动拒绝，不询问 (reject)', 'Reject all, never ask (reject)')}</option>
          </select>
          <span className="dwa-hint">
            {ui.accessModeRouted
              ? acp.label(
                '聊天会话由 DSH 的 Access mode 决定，本页策略只对非聊天会话生效；选「询问」时审批出现在对话里，不在本页。',
                'Chat sessions follow the DSH access mode — this policy only covers non-chat sessions. With “ask”, approvals appear in the conversation, not here.',
              )
              : ui.approvalRouted
                ? acp.label('选「询问」时审批出现在对话里（不在本页）。', 'With “ask”, approvals appear in the conversation (not here).')
                : acp.label('选「询问」时审批出现在本页顶部。', 'With “ask”, approvals appear at the top of this page.')}
          </span>
        </div>
      </div>

      <WorkspaceBlock
        acp={acp}
        form={form}
        patch={patch}
        cwdInvalid={cwdInvalid}
        rootsInvalid={rootsInvalid}
      />

      {/* Idle release: scoped to agents with NO live session (see
          AgentBridge.releaseIfIdle), so it reclaims the processes that the
          model probe / post-save probe leave behind without ever costing a
          chat a cold start. */}
      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('空闲释放（毫秒）', 'Idle Release (ms)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            value={form.idleStr}
            onChange={e => patch({ idleStr: e.target.value })}
            placeholder={acp.label(
              `留空 = 宿主默认（${String(DEFAULT_IDLE_RELEASE_MS / 60_000)} 分钟）`,
              `Blank = host default (${String(DEFAULT_IDLE_RELEASE_MS / 60_000)} min)`,
            )}
          />
          <span className={idleInvalid ? 'dwa-error' : 'dwa-hint'}>
            {idleInvalid
              ? acp.label(
                '必须是 0（永不释放）或 [1000, 86400000] 之间的整数毫秒。',
                'Must be 0 (never release) or an integer in [1000, 86400000] ms.',
              )
              : acp.label(
                '该 Agent 没有活动会话时，空闲超过此时长就释放进程（下次使用自动重启并恢复会话）；0 = 永不释放。有活动会话的 Agent 不会被释放。',
                'With no live session, the process is released once it has been idle this long (the next use restarts it and resumes the session); 0 = never. Agents with a live session are never released.',
              )}
          </span>
        </div>
      </div>

      <div className="dwa-form-row" style={{ flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="dwa-form-label">{acp.label('环境变量', 'Environment Variables')}</span>
          <button
            type="button"
            className="dwa-btn dwa-btn-secondary"
            onClick={() => patch({ envRows: [...form.envRows, { key: '', value: '' }] })}
          >
            {acp.label('添加', 'Add')}
          </button>
        </div>
        {form.envRows.map((row, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              className="dwa-input dwa-input-mono"
              style={{ flex: 2 }}
              value={row.key}
              onChange={e => patch({ envRows: form.envRows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)) })}
              placeholder="KEY"
            />
            <input
              className="dwa-input dwa-input-mono"
              style={{ flex: 3 }}
              value={row.value}
              onChange={e => patch({ envRows: form.envRows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)) })}
              placeholder="VALUE"
            />
            <button
              type="button"
              className="dwa-btn"
              title={acp.label('删除该变量', 'Remove this variable')}
              onClick={() => patch({ envRows: form.envRows.filter((_, i) => i !== index) })}
            >
              ✕
            </button>
          </div>
        ))}
        {form.envRows.length === 0 && (
          <span className="dwa-hint">
            {acp.label('无自定义变量；子进程默认继承脱敏后的宿主环境。', 'No custom variables; the child inherits a credential-scrubbed host env.')}
          </span>
        )}
      </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button
          className="dwa-btn"
          onClick={onTest}
          disabled={testing || saving || formIncomplete}
          title={acp.label('用当前表单值拉起一次性进程并完成 ACP 握手，不保存配置', 'Spawns a throwaway process from the form values and completes the ACP handshake; nothing is saved')}
        >
          {testing ? acp.label('测试中...', 'Testing...') : acp.label('测试', 'Test')}
        </button>

        <button
          className="dwa-btn dwa-btn-primary"
          onClick={onSave}
          disabled={saving || testing || formIncomplete}
        >
          {saving
            ? acp.label('保存中...', 'Saving...')
            : savedSuccess
              ? acp.label('✓ 已保存', '✓ Saved')
              : isConfigured
                ? acp.label('保存', 'Save')
                : acp.label('保存并启用', 'Save & Enable')}
        </button>

        {showSaveWarning && (
          <span className="dwa-hint" style={{ color: 'var(--ntr-warn)' }}>
            ⚠ {acp.label('保存会停止该 Agent 进程并中断进行中的会话', 'Saving stops this agent process and interrupts live sessions')}
          </span>
        )}
      </div>

      {testResult !== undefined && (
        <div
          className="dwa-mono"
          style={{
            marginTop: 8,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            color: testResult.ok ? '#16a34a' : 'var(--ntr-danger)',
          }}
        >
          {testResult.ok ? '✓ ' : '✕ '}{testResult.text}
        </div>
      )}
    </div>
  )
}

/**
 * Workspace editor. Single-root mode is one directory; the advanced switch
 * reveals the full allow-list, because the host enforces every root the agent
 * may touch (and refuses anything else with `cwd_denied`).
 */
function WorkspaceBlock({
  acp,
  form,
  patch,
  cwdInvalid,
  rootsInvalid,
}: {
  acp: AcpStore
  form: AgentForm
  patch: (next: Partial<AgentForm>) => void
  cwdInvalid: boolean
  rootsInvalid: boolean
}) {
  return (
    <div className="dwa-form-row" style={{ flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="dwa-form-label">{acp.label('工作空间根目录', 'Workspace Roots')}</span>
        <label className="dwa-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.rootsOpen}
            onChange={e => patch({ rootsOpen: e.target.checked })}
            style={{ margin: 0 }}
          />
          {acp.label('白名单根目录（高级）', 'Root allow-list (advanced)')}
        </label>
      </div>

      <div className="dwa-form-col">
        <input
          className="dwa-input"
          value={form.cwd}
          onChange={e => patch({ cwd: e.target.value })}
          placeholder={acp.label('默认 ~/.dsh/acp-workspaces', 'Default: ~/.dsh/acp-workspaces')}
        />
        {cwdInvalid && (
          <span className="dwa-error">{acp.label('必须是绝对路径（以 / 开头）', 'Must be an absolute path (starting with /)')}</span>
        )}
        <span className="dwa-hint">
          {acp.label(
            '对话里的 ACP 会话以该 DSH 会话选中的工作区为工作目录（agent 进程也从那里启动）；此项只在 /acp 直连会话与宿主未上报工作区时生效。',
            'An ACP session inside a conversation runs \u2014 and starts its agent process \u2014 in that DSH session\u2019s own workspace; this value applies to /acp-direct sessions and when the host reports no workspace.',
          )}
        </span>
        {/* The effective allow-list stays visible in single-root mode too:
            saving there deliberately narrows it to this one directory. */}
        {!form.rootsOpen && (
          <span className="dwa-hint">
            {acp.label('当前白名单：', 'Current allow-list: ')}
            {form.roots.length === 0 ? acp.label('（未设置）', '(unset)') : form.roots.join('、')}
            {form.cwd.trim() === '' ? '' : acp.label('；保存时将收窄为工作空间目录', '; saving narrows it to the workspace directory')}
          </span>
        )}
      </div>

      {form.rootsOpen && (
        <div className="dwa-form-col" style={{ gap: 4 }}>
          {form.roots.map((root, index) => (
            <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                className="dwa-input dwa-input-mono"
                value={root}
                onChange={e => patch({ roots: form.roots.map((r, i) => (i === index ? e.target.value : r)) })}
                placeholder="/absolute/path"
              />
              <button
                type="button"
                className="dwa-btn"
                title={acp.label('删除该根目录', 'Remove this root')}
                onClick={() => patch({ roots: form.roots.filter((_, i) => i !== index) })}
              >
                ✕
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="dwa-btn dwa-btn-secondary"
              onClick={() => patch({ roots: [...form.roots, ''] })}
            >
              {acp.label('添加根目录', 'Add root')}
            </button>
            <span className="dwa-hint">
              {acp.label('留空的工作空间则使用宿主默认目录。', 'An empty workspace falls back to the host default directory.')}
            </span>
          </div>
          {rootsInvalid && (
            <span className="dwa-error">
              {acp.label('至少需要一个绝对路径根目录', 'At least one absolute root is required')}
            </span>
          )}
        </div>
      )}

      <span className="dwa-hint">
        {acp.label(
          '白名单之外的路径会被宿主拒绝（cwd_denied）；当前 DSH 会话自己的工作区始终被信任。',
          'Paths outside the allow-list are refused by the host (cwd_denied); the current DSH session\u2019s own workspace is always trusted.',
        )}
      </span>
    </div>
  )
}

/** Row overflow menu: the dangerous actions, plus the inline remove confirm. */
function RowMenu({
  acp,
  canStop,
  onStop,
  onRemove,
}: {
  acp: AcpStore
  canStop: boolean
  onStop: () => void
  onRemove: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrap.current !== null && event.target instanceof Node && wrap.current.contains(event.target)) return
      setOpen(false)
      setConfirming(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setConfirming(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = (): void => {
    setOpen(false)
    setConfirming(false)
  }

  return (
    <div className="dwa-menu-wrap" ref={wrap}>
      <button
        type="button"
        className="dwa-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={acp.label('更多操作', 'More actions')}
        onClick={() => {
          setOpen(value => !value)
          setConfirming(false)
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="dwa-menu" role="menu">
          {canStop && (
            <button
              type="button"
              role="menuitem"
              className="dwa-menu-item"
              onClick={() => {
                close()
                onStop()
              }}
            >
              {acp.label('停止当前运行实例', 'Stop Running Process')}
            </button>
          )}
          {confirming ? (
            <div className="dwa-menu-confirm">
              <button
                type="button"
                className="dwa-btn dwa-btn-danger"
                onClick={() => {
                  close()
                  void onRemove()
                }}
              >
                {acp.label('确认移除？', 'Confirm remove?')}
              </button>
              <button type="button" className="dwa-btn" onClick={() => setConfirming(false)}>
                {acp.label('取消', 'Cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="dwa-btn dwa-menu-item dwa-menu-item-danger"
              onClick={() => setConfirming(true)}
            >
              {acp.label('移除配置', 'Remove')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Probed model / thought-level catalog display plus the native-selector
 * visibility filter. Variants are opt-in: the checked chips are exactly the
 * `agentId@choice` entries that appear in the native selector, and an empty
 * selection is a legitimate state (base entry only) — there is deliberately no
 * "follow the agent's full list" mode, because a real catalog is hundreds of
 * choices and the native selector has no search. Chip edits save themselves
 * (debounced), so there is no apply button and no second dirty state to lose
 * track of.
 */
function ModelCatalogBlock({
  agentId,
  detected,
  acp,
  exposed,
  onExposedChange,
  isDefault,
}: {
  agentId: string
  detected: DetectedAgentInfo
  acp: AcpStore
  exposed: string[] | undefined
  onExposedChange: (next: string[] | undefined) => void
  isDefault: boolean
}) {
  const ui = useUi(acp)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [switching, setSwitching] = useState(false)
  const [search, setSearch] = useState('')
  const [expandedChips, setExpandedChips] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<string[] | undefined>(undefined)
  const hasPending = useRef(false)
  // Latest host-confirmed filter: the rollback target when a save fails.
  const serverValue = useRef(exposed)
  serverValue.current = detected.currentConfig?.exposedModels

  const probing = ui.probingModels[agentId] === true
  const probeError = ui.probeErrors[agentId]
  const result = ui.modelCatalogs[agentId]
  const modelChoices = result?.catalog.model?.choices ?? []

  useEffect(() => () => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    // Flush a pending edit instead of dropping it with the unmount (the
    // panel can be closed mid-debounce); the host keeps the last word.
    if (!hasPending.current) return
    hasPending.current = false
    void acp.setExposedModels(agentId, pending.current).catch(() => { /* host keeps its value */ })
  }, [])

  const rollback = (error: unknown): void => {
    onExposedChange(serverValue.current === undefined ? undefined : [...serverValue.current])
    setSaveError(error instanceof Error ? error.message : String(error))
  }

  /** Persist a filter now (mode switch); a failure restores the editor. */
  const commit = async (next: string[] | undefined): Promise<void> => {
    setSwitching(true)
    setSaveError(undefined)
    try {
      await acp.setExposedModels(agentId, next)
      onExposedChange(next)
    } catch (error) {
      rollback(error)
    } finally {
      setSwitching(false)
    }
  }

  /** Persist chip edits after a short idle — several clicks coalesce into one call. */
  const queueChips = (next: string[]): void => {
    pending.current = next
    hasPending.current = true
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!hasPending.current) return
      hasPending.current = false
      void commit(pending.current)
    }, EXPOSURE_SAVE_DEBOUNCE_MS)
  }

  const query = search.trim().toLowerCase()
  const visibleChoices = query === ''
    ? modelChoices
    : modelChoices.filter(choice =>
      choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query))

  // Unset means "nothing selected", not "everything": an unset filter and an
  // empty one are the same host-side state (base entry only).
  const basis = exposed ?? []
  const visibleValues = visibleChoices.map(c => c.value)
  const allChecked = visibleValues.length > 0 && visibleValues.every(v => basis.includes(v))

  const toggleChoice = (value: string): void => {
    const next = basis.includes(value) ? basis.filter(v => v !== value) : [...basis, value]
    onExposedChange(next)
    queueChips(next)
  }

  /**
   * 全选 toggle: no search → expose everything ↔ none ([]); with a search
   * active → check the matching models, or uncheck exactly those when all
   * of them are checked. The button label mirrors the toggle state.
   */
  const toggleVisible = (): void => {
    const next = query === ''
      ? (allChecked ? [] : modelChoices.map(c => c.value))
      : allChecked
        ? basis.filter(v => !visibleValues.includes(v))
        : [...new Set([...basis, ...visibleValues])]
    onExposedChange(next)
    queueChips(next)
  }

  const shownChoices = expandedChips ? visibleChoices : visibleChoices.slice(0, CHIP_COLLAPSED_LIMIT)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button className="dwa-btn dwa-btn-secondary" disabled={probing} onClick={() => void acp.probeModels(agentId)}>
          {probing ? acp.label('模型检测中...', 'Probing models...') : acp.label('检测可用模型', 'Detect Available Models')}
        </button>
        {!isDefault && (
          <button className="dwa-btn" onClick={() => void acp.setDefaultModel(agentId)}>
            ★ {acp.label('设为默认模型', 'Set as Default Model')}
          </button>
        )}
        {result !== undefined && result.catalog.model === undefined && (
          <span className="dwa-hint">
            {acp.label('该 Agent 未暴露模型选择器（category: model）', 'Agent exposes no model selector (category: model)')}
          </span>
        )}
      </div>
      {probeError !== undefined && (
        <div className="dwa-error" style={{ marginTop: 8, wordBreak: 'break-word' }}>
          ⚠ {acp.label('模型检测失败：', 'Model detection failed: ')}{probeError}
        </div>
      )}

      {result !== undefined && modelChoices.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="dwa-form-label">
              {acp.label('对话中可见的模型', 'Models offered in the conversation')}
              <span
                className="dwa-hint"
                style={{ marginLeft: 6, fontWeight: 400 }}
                title={acp.label(
                  'ACP 模式下的对话只会列出这里勾选的模型；未勾选的仍可用（比如会话里已选中的那个），只是不在这里列出来。',
                  'The ACP surfaces only list what is checked here; unchecked models still work (e.g. the one a session already selected) — they are just not offered.',
                )}
              >
                {acp.label('（ACP 座位 / 芯片的下拉列表）', '(the ACP seat and chip pickers)')}
              </span>
            </span>
            <span className="dwa-badge dwa-badge-info">
              {acp.label(
                `已选 ${String(basis.filter(v => modelChoices.some(c => c.value === v)).length)}/${String(modelChoices.length)}`,
                `Selected ${String(basis.filter(v => modelChoices.some(c => c.value === v)).length)}/${String(modelChoices.length)}`,
              )}
            </span>
            {switching && <span className="dwa-hint">{acp.label('保存中...', 'Saving...')}</span>}
          </div>
          {saveError !== undefined && <span className="dwa-error">{saveError}</span>}

          <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  className="dwa-input"
                  style={{ width: 220 }}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={acp.label('搜索模型…', 'Search models…')}
                />
                <button
                  className="dwa-btn dwa-btn-secondary"
                  disabled={visibleChoices.length === 0}
                  onClick={toggleVisible}
                  title={acp.label('在全部勾选与全部取消之间切换；搜索中则只切换匹配的模型', 'Toggles between checking everything and none; while searching it toggles only the matching models')}
                >
                  {allChecked ? acp.label('取消全选', 'Deselect All') : acp.label('全选', 'Select All')}
                </button>
                {visibleChoices.length > CHIP_COLLAPSED_LIMIT && (
                  <button className="dwa-btn" onClick={() => setExpandedChips(value => !value)}>
                    {expandedChips
                      ? acp.label('收起', 'Collapse')
                      : acp.label(`展开全部 ${String(visibleChoices.length)} 个`, `Show all ${String(visibleChoices.length)}`)}
                  </button>
                )}
              </div>
              <div className="dwa-chip-list" style={{ marginTop: 0 }}>
                {shownChoices.map(choice => {
                  const checked = basis.includes(choice.value)
                  // group 前缀仅来自 agent 返回的 SessionConfigSelectGroup（见 impl.ts
                  // pushCatalogChoice）；供应商可见性兜底靠原样展示 value，严禁从
                  // value 路径截取供应商段做标签（约束 8）。
                  const title = choice.description === undefined
                    ? choice.value
                    : `${choice.value}\n${choice.description}`
                  return (
                    <label
                      key={choice.value}
                      className="dwa-badge dwa-chip-model"
                      title={title}
                      style={checked ? { background: '#3b82f622', color: '#2563eb' } : { opacity: 0.55 }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChoice(choice.value)}
                        style={{ margin: 0, accentColor: '#2563eb' }}
                      />
                      {choice.group !== undefined && <span style={{ opacity: 0.7 }}>{choice.group} ·</span>}
                      {choice.name}
                      {choice.value !== choice.name && (
                        <span style={{ opacity: 0.55, fontSize: 10 }}>{choice.value}</span>
                      )}
                    </label>
                  )
                })}
                {visibleChoices.length === 0 && (
                  <span className="dwa-hint">{acp.label('无匹配模型', 'No matching models')}</span>
                )}
              </div>
          </>
          {result.catalog.thought !== undefined && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="dwa-form-label">{acp.label('思考等级', 'Thought Levels')}</span>
              {result.catalog.thought.choices.map(choice => (
                <span key={choice.value} className="dwa-badge" title={choice.description}>
                  {choice.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
