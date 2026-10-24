/**
 * React surface for ACP: the settings configuration section.
 *
 * Scope is deliberately narrow — this is a CONFIGURATION surface. Runtime
 * interaction lives in the conversation: permission asks are answered in the
 * chat composer through the host approval chain. The ledger card answers
 * whatever did NOT reach the conversation — a host without the chain, a
 * session with no chat identity behind it, or an ask whose native route
 * degraded to unavailable (see `permissionLedgerCard`).
 *
 * Each configured agent is one compact row (status + current model + badges)
 * that expands into the full connection form and model catalog. The row stays
 * mounted and the body toggles `display`, so editing a form and collapsing it
 * never loses the in-progress values.
 * All business state lives in the injected AcpStore.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatCommandLine, isAbsolutePathLike, splitCommandLine } from './acp-ui.tsx'
import { DEFAULT_KNOWN_PRESETS } from './store.ts'
import type { AcpStore, UiState } from './store.ts'
import type { AcpAgentDef, AcpCatalogChoice, AgentSavePayload, AgentView, DetectedAgentInfo } from '../protocol.ts'

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
.dwa-caret { font-size: 16px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; width: 1em; }
.dwa-caret-btn { font: inherit; border: none; background: none; padding: 2px 4px; border-radius: var(--ntr-radius-sm); display: inline-flex; align-items: center; color: inherit; cursor: pointer; }
.dwa-caret-btn:hover { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
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
.dwa-switch { display: inline-flex; align-items: center; gap: 6px; font-size: var(--ntr-font-sm); cursor: pointer; user-select: none; }
.dwa-model-transfer { display: flex; gap: 10px; align-items: stretch; }
.dwa-model-pane { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; border: var(--ntr-line); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); overflow: hidden; }
.dwa-model-pane-head { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: var(--ntr-line); font-size: var(--ntr-font-xs); font-weight: 600; color: var(--dsw-alias-text-secondary, #4b5563); }
.dwa-model-pane-head .dwa-btn { margin-left: auto; padding: 2px 8px; font-size: var(--ntr-font-xs); }
.dwa-model-list { display: flex; flex-direction: column; gap: 1px; padding: 4px; max-height: 240px; overflow-y: auto; }
.dwa-model-row { display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: none; padding: 3px 6px; border-radius: 4px; cursor: pointer; color: inherit; font: inherit; font-size: var(--ntr-font-sm); text-align: left; }
.dwa-model-row:hover { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
.dwa-model-row.is-on { background: #3b82f622; color: #2563eb; }
.dwa-model-row-mark { width: 12px; flex: none; text-align: center; opacity: 0.75; }
.dwa-model-row-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dwa-model-row-value { flex: 0 1 auto; max-width: 45%; opacity: 0.55; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dwa-model-row-remove { flex: none; opacity: 0.5; padding: 0 2px; }
.dwa-model-row:hover .dwa-model-row-remove { opacity: 1; }
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
  if ((payload.cwd ?? '') !== (current.cwd ?? '')) return false
  if (!sameStringArray(payload.allowedCwdRoots ?? [], current.allowedCwdRoots ?? [])) return false
  if (!sameStringMap(payload.env ?? {}, current.env ?? {})) return false
  if (exposureKey(payload.exposedModels) !== exposureKey(current.exposedModels)) return false
  if ((payload.autoDiscoverModels === true) !== (current.autoDiscoverModels === true)) return false
  // An absent field means "use the host default" — which is what `current`
  // already resolved to (see `resolvedIdleTimeoutMs`), so it is not a change.
  if (payload.idleTimeoutMs !== undefined && payload.idleTimeoutMs !== current.idleTimeoutMs) return false
  return true
}

/**
 * The settings panel's permission-ledger rule.
 *
 * A pending ask ALWAYS gets an answerable card here, whatever `approvalRouted`
 * says. That flag reports that the host HAS an approval service — it does not
 * promise THIS ask reached the conversation. An ask lands in `ui.permissions`
 * only on the ledger path (`AgentBridge.handlePermissionRequest` broadcasts
 * `permission/request` there and nowhere else), so a pending entry is by
 * definition a question the conversation is not showing. The previous rule
 * (`approvalRouted` → a read-only count, no buttons) hid the only answer
 * entry exactly when the native route had degraded to unavailable, and the
 * ask then hung until its timeout.
 *
 * `fellBackFromConversation` is the case the card has to explain: the host
 * can route asks, and this one still did not make it.
 */
export function permissionLedgerCard(ui: Pick<UiState, 'approvalRouted' | 'permissions'>): { visible: boolean; fellBackFromConversation: boolean } {
  const visible = ui.permissions.length > 0
  return { visible, fellBackFromConversation: visible && ui.approvalRouted }
}

/** Settings configuration section for ACP agents. */
export function AcpSettingsSection(props: WithStore) {
  const acp = props.acp
  ensureStyle()
  const ui = useUi(acp)
  const ledger = permissionLedgerCard(ui)
  // The agent list section opens by default. `addTarget === undefined` means
  // "follow the first available preset"; an explicit chip click pins the
  // selection until the next create resets it.
  const [addOpen, setAddOpen] = useState(true)
  const [addTarget, setAddTarget] = useState<DetectedAgentInfo | undefined>(undefined)
  const [createNonce, setCreateNonce] = useState(0)
  const { configured, available } = partitionAgents(ui.detectedAgents, ui.agents)
  const selected = addTarget ?? available[0] ?? NEW_AGENT_SEED

  return (
    <div className="dwa-root">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span
          className="dwa-dot"
          style={{ background: ui.stream === 'live' ? '#22c55e' : ui.stream === 'down' ? '#ef4444' : '#9ca3af' }}
          title={ui.stream}
        />
        <span className="dwa-hint" style={{ flex: 1 }}>{streamText(ui.stream, acp)}</span>
        {ui.detectSummary !== undefined && <span className="dwa-hint">{ui.detectSummary}</span>}
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

      {/* Any pending ask gets an answerable card here, whatever
          `approvalRouted` says (see `permissionLedgerCard`): an ask is in
          `ui.permissions` only because it fell back to the ledger, which
          means the conversation is NOT showing it. */}
      {ledger.visible && (
        <div className="dwa-card dwa-card-warn" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {acp.label('待处理权限请求', 'Pending Permission Requests')}
          </div>
          {ledger.fellBackFromConversation && (
            <div className="dwa-hint" style={{ marginBottom: 8 }}>
              {acp.label(
                '这些询问没有进入对话（审批服务本次不可用，或会话没有对话身份），请在此回答。',
                'These asks did not reach the conversation (the approval service was unavailable, or the session has no chat identity) — answer them here.',
              )}
            </div>
          )}
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

      {/* ACP 模式: the agent preset the new-session picker offers.

          Nothing is installed from here — the preset is a declaration this
          package ships in its OWN bundle patch (`presets/acp/acp.patch.yml`),
          so the card is a read-only window onto the harness roster: it exists
          to say why the mode is missing when its activation failed. */}
      {ui.preset !== undefined && (
        <div className="dwa-card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, flex: 1 }}>
              {acp.label('NTR 模式（智能体预设）', 'NTR mode (agent preset)')}
            </span>
            <span className="dwa-badge">{ui.preset.id}</span>
          </div>
          <div className="dwa-hint" style={{ marginTop: 6 }}>
            {ui.preset.installed
              ? acp.label(
                `已进入宿主模式列表（声明：${ui.preset.source}）。在新建会话页的模式选择里选「NTR 模式」。`,
                `In the harness roster (declared at ${ui.preset.source}). Pick “NTR mode” in the new-session mode picker.`,
              )
              : acp.label(
                `宿主模式列表里没有可用的「NTR 模式」（声明：${ui.preset.source}）。`,
                `The harness roster carries no usable “NTR mode” (declared at ${ui.preset.source}).`,
              )}
          </div>
          {ui.preset.problem !== undefined && (
            <div className="dwa-hint" style={{ marginTop: 4, color: '#f59e0b' }}>
              {acp.label(`宿主报告：${ui.preset.problem}`, `Harness reported: ${ui.preset.problem}`)}
            </div>
          )}
        </div>
      )}

      {/* Connected ACP agents: one compact row per agent, details on demand */}
      <div style={{ marginBottom: 24 }}>
        <div className="dwa-section-title">
          <span>{acp.label('已接入的 NTR 智能体', 'Connected NTR Agents')}</span>
          <span className="dwa-badge">{configured.length}</span>
        </div>

        {configured.length === 0 && (
          <div className="dwa-card" style={{ textAlign: 'center', color: 'var(--ntr-muted)', padding: 20 }}>
            {acp.label(
              '尚未启用任何 Agent。从下方「Agent 列表」点一个检测到的预设（会展开预填命令的创建卡），再点「保存并启用」；也可以直接新建自定义 Agent。',
              'No agents configured yet. Pick a detected preset from the "Agent List" below (it opens a creation card prefilled with its command), then click "Save & Enable" — or create a custom one from scratch.',
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
              isDefault={ui.defaultAgent === info.id}
              synthesized={synthesized}
            />
          )
        })}
      </div>

      {/* Agent list: available presets plus the from-scratch creation form,
          open by default so the page answers "what can I enable" without a
          click. Selection follows the first available preset until pinned. */}
      <div>
        <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => setAddOpen(open => !open)}>
          <span className="dwa-caret" aria-hidden>{addOpen ? '▾' : '▸'}</span> {acp.label('Agent 列表', 'Agent List')}
        </button>
        {addOpen && (
          <div style={{ marginTop: 12 }}>
            <div className="dwa-chip-list" style={{ marginTop: 0, marginBottom: 4 }}>
              {available.map(info => (
                <button
                  key={info.id}
                  type="button"
                  className={`dwa-chip${selected.id === info.id ? ' dwa-chip-active' : ''}`}
                  onClick={() => setAddTarget(info)}
                  title={info.description}
                >
                  {info.name}
                </button>
              ))}
              <button
                type="button"
                className={`dwa-chip${selected.id === '' ? ' dwa-chip-active' : ''}`}
                onClick={() => setAddTarget(NEW_AGENT_SEED)}
              >
                {acp.label('自定义', 'Custom')}
              </button>
            </div>
            {available.length === 0 && selected.id === '' && (
              <div className="dwa-hint" style={{ marginBottom: 8 }}>
                {acp.label('没有更多可启用的预设 Agent。', 'No more detected presets to enable.')}
              </div>
            )}
            <AgentRow
              key={selected.id === '' ? `custom-${createNonce}` : selected.id}
              detected={selected}
              acp={acp}
              isDefault={false}
              synthesized={false}
              newCustom={selected.id === ''}
              onCreated={() => {
                // Creation done: drop the pin so the selection re-derives to
                // the next available preset (or a fresh custom card), and bump
                // the nonce so an all-custom reset still remounts empty
                // instead of keeping the just-saved values in the form.
                setAddTarget(undefined)
                setCreateNonce(nonce => nonce + 1)
              }}
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
  /** Fired after a creation-card save succeeds (the list re-derives its selection). */
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

  const serverAutoDiscover = detected.currentConfig?.autoDiscoverModels === true
  useEffect(() => {
    // The switch saves itself through the lightweight RPC, so the host is the
    // truth; this keeps the form (and therefore a later full save) in step.
    setForm(prev => ({ ...prev, autoDiscoverModels: serverAutoDiscover }))
  }, [serverAutoDiscover])

  const trimmedId = form.agentId.trim()
  const idValid = !newCustom || AGENT_ID_PATTERN.test(trimmedId)
  const idTaken = newCustom && trimmedId !== '' && ui.agents.some(a => a.id === trimmedId)
  const cwdInvalid = form.cwd.trim() !== '' && !isAbsolutePathLike(form.cwd.trim())
  const rootValues = form.roots.map(root => root.trim()).filter(root => root !== '')
  const rootsInvalid = form.rootsOpen && (rootValues.length === 0 || rootValues.some(root => !isAbsolutePathLike(root)))
  const idleInvalid = !idleValid(form.idleStr)
  const formIncomplete = splitCommandLine(form.commandLine).command === '' || !idValid || idTaken || cwdInvalid || rootsInvalid || idleInvalid

  const payload = buildPayload(form, detected, newCustom)
  const current = persistedDef(detected, activeAgent)
  const dirty = current !== undefined && !payloadEquals(payload, current)
  // A save stops the child and kills every live session (see BridgeManager.saveAgent).
  const showSaveWarning = dirty && activeAgent !== undefined && activeAgent.state !== 'stopped'

  const handleUseDefault = (): void => patch({ commandLine: formatCommandLine(detected.defaultCommand, detected.defaultArgs) })

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setSavedSuccess(false)
    try {
      await acp.saveAgent(payload)
      // A save from the creation card resets the list's selection: the agent
      // now lives in the configured list, and keeping the same card mounted
      // would render it twice. Configured rows pass no `onCreated`, so this is
      // a no-op for them.
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
          className="dwa-caret-btn"
          aria-expanded={open}
          onClick={() => setExpanded(value => !value)}
          title={open ? acp.label('收起', 'Collapse') : acp.label('展开配置与模型', 'Expand configuration and models')}
        >
          <span className="dwa-caret" aria-hidden>{open ? '▾' : '▸'}</span>
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
            autoDiscover={form.autoDiscoverModels}
            onAutoDiscoverChange={autoDiscoverModels => patch({ autoDiscoverModels })}
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
  /**
   * ONE command line — program first, arguments after, quoting to keep a path
   * with spaces in one piece (`splitCommandLine`). The old split into
   * `command` + `argsStr` invited the single most common misconfiguration
   * there is: pasting `codebuddy --acp` into the program box, which the host
   * then looked for as a file literally named `codebuddy --acp`.
   */
  commandLine: string
  npmPackage: string
  cwd: string
  /** Advanced: edit every allowed root, not just the single workspace dir. */
  rootsOpen: boolean
  roots: string[]
  envRows: Array<{ key: string; value: string }>
  exposed?: string[]
  /** Auto-append models the agent newly publishes to {@link exposed}. */
  autoDiscoverModels: boolean
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

/**
 * Hand copy of `DEFAULT_TUNING.probeIdleTimeoutMs` (src/bridge.ts). A process
 * that has never hosted a session — the model probe / post-save probe — lives
 * by THIS window whatever the agent's own field says, so the placeholder has to
 * name both windows. Keep the two in sync.
 */
const DEFAULT_PROBE_RELEASE_MS = 300_000

function initialForm(detected: DetectedAgentInfo, activeAgent: AgentView | undefined): AgentForm {
  const config = detected.currentConfig
  const roots = [...(activeAgent?.allowedCwdRoots ?? config?.allowedCwdRoots ?? [])]
  return {
    agentId: detected.id,
    title: activeAgent?.title ?? config?.title ?? detected.name,
    commandLine: formatCommandLine(
      activeAgent?.command ?? config?.command ?? detected.defaultCommand,
      activeAgent?.args ?? config?.args ?? detected.defaultArgs,
    ),
    npmPackage: config?.npmPackage ?? '',
    cwd: activeAgent?.cwd ?? config?.cwd ?? '',
    // An agent already carrying more than one root opens in advanced mode:
    // single-root mode narrows the allow-list to `cwd` on save, which must
    // never happen as a side effect of merely opening the form.
    rootsOpen: roots.length > 1,
    roots,
    envRows: Object.entries(config?.env ?? {}).map(([key, value]) => ({ key, value })),
    exposed: config?.exposedModels === undefined ? undefined : [...config.exposedModels],
    autoDiscoverModels: config?.autoDiscoverModels === true,
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
 * neither field and the host falls back to `~/.dsh/dsh-ntr/workspaces`. Advanced
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
  // The field is a command line; the host validates it the same way, so what
  // the preview under the input shows is what will actually be spawned.
  const parsed = splitCommandLine(form.commandLine)
  const payload: AgentSavePayload = {
    id: newCustom ? form.agentId.trim() : detected.id,
    ...(form.title.trim() === '' ? {} : { title: form.title.trim() }),
    command: parsed.command,
    args: parsed.args,
    ...(form.npmPackage.trim() === '' ? {} : { npmPackage: form.npmPackage.trim() }),
    env,
    ...(form.exposed === undefined ? {} : { exposedModels: form.exposed }),
    ...(form.autoDiscoverModels ? { autoDiscoverModels: true } : {}),
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
  // The same parse the host will run (`validateAgentDef` → `splitCommandLine`).
  // Showing it is what turns "the first box swallowed my arguments" into a
  // visible, fixable state instead of a spawn error.
  const parsedCommand = splitCommandLine(form.commandLine)
  const commandPreview = parsedCommand.command === ''
    ? acp.label('填整条命令，例如：codebuddy --acp', 'Type the whole command, e.g. codebuddy --acp')
    : `${acp.label('程序', 'Program')}: ${parsedCommand.command}`
      + (parsedCommand.args.length === 0 ? '' : `　${acp.label('参数', 'Arguments')}: ${parsedCommand.args.join(' ')}`)
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

      {/* ONE field on purpose: the program and its arguments are one command
          line, exactly as a user would type them. Splitting them into two boxes
          made "paste the whole command into the first box" the default mistake
          (the host then looked for a file named `codebuddy --acp`); here the
          same paste is correct, and the parse preview below shows what will
          actually run (same parser the host's `validateAgentDef` uses). */}
      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('启动命令（程序 + 参数）', 'Launch Command (program + arguments)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            value={form.commandLine}
            onChange={e => patch({ commandLine: e.target.value })}
            placeholder={detected.defaultCommand === ''
              ? 'e.g. codebuddy --acp'
              : formatCommandLine(detected.defaultCommand, detected.defaultArgs)}
          />
          <span className="dwa-hint">{commandPreview}</span>
          <span className="dwa-hint">
            {acp.label(
              '参数直接跟在程序后面即可；路径里含空格时用引号包住整条路径，例如 "C:\\Program Files\\nodejs\\node.exe" --acp。',
              'Arguments go right after the program; quote a whole path that contains spaces, e.g. "C:\\Program Files\\nodejs\\node.exe" --acp.',
            )}
          </span>
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
          <span className="dwa-caret" aria-hidden>{advancedOpen ? '▾' : '▸'}</span> {acp.label('高级参数', 'Advanced Parameters')}
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
          chat a cold start. TWO windows exist (AgentBridge.currentIdleTimeoutMs):
          this field is the chat window of a process that HAS hosted a session;
          a never-used process (a probe) always gets the short probe window and
          ignores this field — which is why the copy below names both. */}
      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('空闲释放（毫秒）', 'Idle Release (ms)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            value={form.idleStr}
            onChange={e => patch({ idleStr: e.target.value })}
            placeholder={acp.label(
              `留空 = 宿主默认（承载会话 ${String(DEFAULT_IDLE_RELEASE_MS / 60_000)} 分钟 / 探测进程 ${String(DEFAULT_PROBE_RELEASE_MS / 60_000)} 分钟）`,
              `Blank = host default (${String(DEFAULT_IDLE_RELEASE_MS / 60_000)} min for a chat process / ${String(DEFAULT_PROBE_RELEASE_MS / 60_000)} min for a probe)`,
            )}
          />
          <span className={idleInvalid ? 'dwa-error' : 'dwa-hint'}>
            {idleInvalid
              ? acp.label(
                '必须是 0（永不释放）或 [1000, 86400000] 之间的整数毫秒。',
                'Must be 0 (never release) or an integer in [1000, 86400000] ms.',
              )
              : acp.label(
                '没有进行中的回合或待答审批时，空闲超过此时长就挂起进程（会话保留，下一条消息自动重启并恢复）；0 = 永不释放；有回合在跑、取消尚未结算或审批待答的进程不会被释放。此窗口只对承载过会话的进程生效：保存后拉起的模型探测进程（面板显示「已连接」的那个）固定 5 分钟释放，填 0 也拦不住。',
                'With no turn in flight or approval awaiting an answer, the process is parked once it has been idle this long (sessions are kept and resume on the next message); 0 = never; a process with a running turn, an unsettled cancel, or a pending approval is never released. This window applies only to a process that has hosted a session: the model-probe process (the one the panel shows as "connected" after a save) is always released after 5 minutes, and 0 does not stop it.',
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
            {acp.label('无自定义变量；子进程继承宿主环境。', 'No custom variables; the child inherits the host environment.')}
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
          placeholder={acp.label('默认 ~/.dsh/dsh-ntr/workspaces', 'Default: ~/.dsh/dsh-ntr/workspaces')}
        />
        {cwdInvalid && (
          <span className="dwa-error">{acp.label('必须是绝对路径（如 /work 或 C:\\work）', 'Must be an absolute path (e.g. /work or C:\\work)')}</span>
        )}
        <span className="dwa-hint">
          {acp.label(
            '对话里的 NTR 会话以该 DSH 会话选中的工作区为工作目录（agent 进程也从那里启动）；此项只在 /acp 直连会话与宿主未上报工作区时生效。',
            'An NTR session inside a conversation runs \u2014 and starts its agent process \u2014 in that DSH session\u2019s own workspace; this value applies to /acp-direct sessions and when the host reports no workspace.',
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
 * visibility filter, as a two-pane transfer list: every probed model on the
 * left, the selection that reaches the NTR surfaces on the right. Variants are
 * still opt-in — an empty selection is a legitimate state (base entry only) —
 * and edits save themselves (debounced), so there is no apply button and no
 * second dirty state to lose track of.
 *
 * The auto-discovery switch is a per-agent POLICY, not a one-shot action: it
 * appends models the agent NEWLY publishes to the selection (see
 * `AcpAgentDef.autoDiscoverModels`). It saves itself through the lightweight
 * RPC, so flipping it never restarts the agent process.
 */
function ModelCatalogBlock({
  agentId,
  detected,
  acp,
  exposed,
  onExposedChange,
  autoDiscover,
  onAutoDiscoverChange,
  isDefault,
}: {
  agentId: string
  detected: DetectedAgentInfo
  acp: AcpStore
  exposed: string[] | undefined
  onExposedChange: (next: string[] | undefined) => void
  autoDiscover: boolean
  onAutoDiscoverChange: (next: boolean) => void
  isDefault: boolean
}) {
  const ui = useUi(acp)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<string[] | undefined>(undefined)
  const hasPending = useRef(false)
  // In-flight auto-discovery toggle. A ref, not state: the switch saves
  // silently, and a "saving" render here made the row wrap and snap back
  // (user report, 2026-10-21). The guard only prevents double-submits.
  const autoDiscoverBusy = useRef(false)
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
    setSaveError(undefined)
    try {
      await acp.setExposedModels(agentId, next)
      onExposedChange(next)
    } catch (error) {
      rollback(error)
    }
  }

  /** Persist selection edits after a short idle — several clicks coalesce into one call. */
  const queueExposure = (next: string[]): void => {
    pending.current = next
    hasPending.current = true
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!hasPending.current) return
      hasPending.current = false
      void commit(pending.current)
    }, EXPOSURE_SAVE_DEBOUNCE_MS)
  }

  const toggleAutoDiscover = async (next: boolean): Promise<void> => {
    if (autoDiscoverBusy.current) return
    autoDiscoverBusy.current = true
    onAutoDiscoverChange(next)
    setSaveError(undefined)
    try {
      await acp.setAutoDiscoverModels(agentId, next)
    } catch (error) {
      onAutoDiscoverChange(!next)
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      autoDiscoverBusy.current = false
    }
  }

  const query = search.trim().toLowerCase()
  const visibleChoices = query === ''
    ? modelChoices
    : modelChoices.filter(choice =>
      choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query))

  // Unset means "nothing selected", not "everything": an unset filter and an
  // empty one are the same host-side state (base entry only).
  const basis = exposed ?? []
  const selected = new Set(basis)
  // Right pane = selection in catalog order, then any selected value the last
  // probe no longer lists (still saved and still usable — hiding it would make
  // the two panes quietly disagree about what is configured).
  const selectedChoices: AcpCatalogChoice[] = []
  for (const choice of modelChoices) if (selected.has(choice.value)) selectedChoices.push(choice)
  const listed = new Set(selectedChoices.map(choice => choice.value))
  for (const value of basis) if (!listed.has(value)) selectedChoices.push({ value, name: value })
  const selectedInCatalog = basis.filter(value => modelChoices.some(choice => choice.value === value)).length

  const apply = (next: string[]): void => {
    onExposedChange(next)
    queueExposure(next)
  }

  const toggleChoice = (value: string): void => {
    apply(selected.has(value) ? basis.filter(v => v !== value) : [...basis, value])
  }

  /** Add every model matching the current search that is not selected yet. */
  const addVisible = (): void => {
    const added = visibleChoices.map(choice => choice.value).filter(value => !selected.has(value))
    if (added.length === 0) return
    apply([...basis, ...added])
  }

  const clearAll = (): void => {
    if (basis.length === 0) return
    apply([])
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button className="dwa-btn dwa-btn-secondary" disabled={probing} onClick={() => void acp.probeModels(agentId)}>
          {probing ? acp.label('模型检测中...', 'Probing models...') : acp.label('检测可用模型', 'Detect Available Models')}
        </button>
        {!isDefault && (
          <button className="dwa-btn" onClick={() => void acp.setDefaultAgent(agentId)}>
            ★ {acp.label('设为默认 Agent', 'Set as Default Agent')}
          </button>
        )}
        {isDefault && (
          // Says out loud what this gesture is — and what it is NOT. It is the
          // plugin's own default ACP agent (which agent a new ACP-mode
          // conversation starts on); it deliberately does NOT write the
          // deployment default model, which stays native so ordinary
          // conversations in every other mode are untouched.
          <span className="dwa-hint">
            {acp.label(
              '默认 Agent：新的 NTR 模式会话直接由它服务（其他模式的默认模型不受影响）',
              "Default agent: a new NTR-mode conversation starts on it (other modes' default model is untouched)",
            )}
          </span>
        )}
        {result !== undefined && result.catalog.model === undefined && (
          <span className="dwa-hint">
            {acp.label('该 Agent 未暴露模型选择器（category: model）', 'Agent exposes no model selector (category: model)')}
          </span>
        )}
      </div>

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
        <label
          className="dwa-switch"
          title={acp.label(
            'Agent 新发布的模型会自动加入右侧已选列表；首次检测到的目录只作为基线，不会一次性全选。',
            'Models the agent newly publishes are added to the selected list; the first observed catalog is only a baseline and is not selected wholesale.',
          )}
        >
          <input
            type="checkbox"
            checked={autoDiscover}
            onChange={e => void toggleAutoDiscover(e.target.checked)}
            style={{ margin: 0, accentColor: '#2563eb' }}
          />
          {acp.label('自动发现新模型', 'Auto-discover new models')}
        </label>
        <span className="dwa-hint">
          {acp.label('开启后，agent 新增的模型会自动加入已选列表；现有勾选不受影响。', 'When on, models the agent adds are appended to the selection; existing picks are untouched.')}
        </span>
      </div>
      {saveError !== undefined && <div className="dwa-error" style={{ marginTop: 4 }}>{saveError}</div>}
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
                  'NTR 模式下的对话只列出这里勾选的模型；未勾选的仍可用——正在生效的那个也会以「· 当前」列出来，其余不列出。',
                  'The NTR surfaces only list what is checked here; unchecked models still work, and the one currently in force is still listed with a "· current" row — the rest are not offered.',
                )}
              >
                {acp.label('（NTR 座位 / 芯片的下拉列表）', '(the NTR seat and chip pickers)')}
              </span>
            </span>
            <span className="dwa-badge dwa-badge-info">
              {acp.label(
                `已选 ${String(selectedInCatalog)}/${String(modelChoices.length)}`,
                `Selected ${String(selectedInCatalog)}/${String(modelChoices.length)}`,
              )}
            </span>
          </div>

          <>
              <div className="dwa-model-transfer">
                <div className="dwa-model-pane">
                  <div className="dwa-model-pane-head">
                    <span>{acp.label('全部模型', 'All models')}</span>
                    <span className="dwa-badge">{modelChoices.length}</span>
                    <button
                      type="button"
                      className="dwa-btn dwa-btn-secondary"
                      disabled={visibleChoices.length === 0}
                      onClick={addVisible}
                      title={acp.label('把当前搜索范围内的模型全部加入右侧', 'Add every model matching the current search')}
                    >
                      {acp.label('全部加入', 'Add all')}
                    </button>
                  </div>
                  <div style={{ padding: '6px 6px 0' }}>
                    <input
                      className="dwa-input"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder={acp.label('搜索模型…', 'Search models…')}
                    />
                  </div>
                  <div className="dwa-model-list">
                    {visibleChoices.map(choice => {
                      const checked = selected.has(choice.value)
                      // group 前缀仅来自 agent 返回的 SessionConfigSelectGroup（见 impl.ts
                      // pushCatalogChoice）；供应商可见性兜底靠原样展示 value，严禁从
                      // value 路径截取供应商段做标签（约束 8）。
                      const title = choice.description === undefined
                        ? choice.value
                        : `${choice.value}\n${choice.description}`
                      return (
                        <button
                          type="button"
                          key={choice.value}
                          className={`dwa-model-row${checked ? ' is-on' : ''}`}
                          title={title}
                          onClick={() => toggleChoice(choice.value)}
                        >
                          <span className="dwa-model-row-mark">{checked ? '✓' : '+'}</span>
                          <span className="dwa-model-row-name">
                            {choice.group !== undefined && <span style={{ opacity: 0.7 }}>{choice.group} · </span>}
                            {choice.name}
                          </span>
                          {choice.value !== choice.name && (
                            <span className="dwa-model-row-value">{choice.value}</span>
                          )}
                        </button>
                      )
                    })}
                    {visibleChoices.length === 0 && (
                      <span className="dwa-hint" style={{ padding: '4px 6px' }}>{acp.label('无匹配模型', 'No matching models')}</span>
                    )}
                  </div>
                </div>

                <div className="dwa-model-pane">
                  <div className="dwa-model-pane-head">
                    <span>{acp.label('已选模型', 'Selected models')}</span>
                    <span className="dwa-badge dwa-badge-info">{basis.length}</span>
                    <button
                      type="button"
                      className="dwa-btn dwa-btn-secondary"
                      disabled={basis.length === 0}
                      onClick={clearAll}
                    >
                      {acp.label('清空', 'Clear')}
                    </button>
                  </div>
                  <div className="dwa-model-list">
                    {selectedChoices.length === 0 && (
                      <span className="dwa-hint" style={{ padding: '4px 6px' }}>
                        {acp.label('还没有选择模型（点左侧的模型加入）', 'Nothing selected yet — pick models on the left')}
                      </span>
                    )}
                    {selectedChoices.map(choice => (
                      <button
                        type="button"
                        key={choice.value}
                        className="dwa-model-row is-on"
                        title={choice.description === undefined ? choice.value : `${choice.value}\n${choice.description}`}
                        onClick={() => toggleChoice(choice.value)}
                      >
                        <span className="dwa-model-row-name">
                          {choice.group !== undefined && <span style={{ opacity: 0.7 }}>{choice.group} · </span>}
                          {choice.name}
                        </span>
                        {choice.value !== choice.name && (
                          <span className="dwa-model-row-value">{choice.value}</span>
                        )}
                        <span className="dwa-model-row-remove" aria-hidden="true">×</span>
                      </button>
                    ))}
                  </div>
                </div>
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
