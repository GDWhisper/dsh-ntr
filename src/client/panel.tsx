/**
 * React surface for ACP: the settings configuration section.
 * Focuses on what users need day to day: per-agent connection state and
 * the model catalog. Startup command / permission editing lives behind a
 * collapsed "配置" disclosure; unconfigured presets collapse into an
 * "添加 Agent" section at the bottom.
 * All business state lives in the injected AcpStore.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AcpStore } from './store.ts'
import type { AgentView, DetectedAgentInfo, PermissionMode } from '../protocol.ts'

interface WithStore { acp: AcpStore }

const STYLE = `
.dwa-btn { font: inherit; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #bbb); background: var(--dsw-alias-button-tool-bar-fill, transparent); padding: 5px 12px; cursor: pointer; color: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; transition: background 0.15s ease; }
.dwa-btn:hover { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
.dwa-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dwa-btn-primary { background: var(--dsw-alias-button-primary-fill, #2563eb); color: var(--dsw-alias-button-primary-invert, #fff); border-color: transparent; font-weight: 500; }
.dwa-btn-primary:hover { opacity: 0.9; }
.dwa-btn-danger { color: #dc2626; border-color: #fca5a5; }
.dwa-btn-danger:hover { background: #fee2e2; }
.dwa-btn-secondary { background: var(--dsw-alias-bg-layer-2, #f3f4f6); border-color: var(--dsw-alias-border-l2, #d1d5db); }
.dwa-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; flex-shrink: 0; }
.dwa-badge { font-size: 11px; border-radius: 4px; padding: 2px 8px; background: #6b728022; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; }
.dwa-badge-success { background: #22c55e22; color: #16a34a; font-weight: 600; }
.dwa-badge-warn { background: #f59e0b22; color: #d97706; font-weight: 600; }
.dwa-badge-info { background: #3b82f622; color: #2563eb; font-weight: 500; }
.dwa-card { border: 1px solid var(--dsw-alias-border-l2, #e0e0e0); border-radius: 8px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1, #fafafa); font-size: 13px; line-height: 1.5; }
.dwa-card-warn { border-left: 4px solid var(--dsw-alias-state-warn-primary, #d97706); background: var(--dsw-alias-state-warn-secondary, #fffbeb); }
.dwa-select { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #ccc); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; }
.dwa-input { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #ccc); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; width: 100%; box-sizing: border-box; }
.dwa-input:focus, .dwa-select:focus { outline: none; border-color: var(--dsw-alias-button-primary-fill, #2563eb); }
.dwa-input-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.dwa-stderr { max-height: 120px; overflow: auto; font-family: monospace; font-size: 11px; white-space: pre-wrap; color: #b45309; margin: 4px 0 0; }

.dwa-section-title { font-size: 14px; font-weight: 600; margin: 0 0 8px; display: flex; align-items: center; justify-content: space-between; }
.dwa-detected-card { border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); border-radius: 8px; padding: 14px; background: var(--dsw-alias-bg-layer-1, #ffffff); margin-bottom: 14px; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.03); }
.dwa-detected-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
.dwa-form-row { display: flex; gap: 12px; margin-bottom: 10px; align-items: flex-start; }
.dwa-form-col { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.dwa-form-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-text-secondary, #4b5563); }
.dwa-default-hint { background: var(--dsw-alias-bg-layer-2, #f9fafb); border: 1px dashed var(--dsw-alias-border-l2, #d1d5db); border-radius: 6px; padding: 6px 10px; font-size: 12px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }
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

function stateVisual(state: AgentView['state'], acp: AcpStore): { color: string; text: string } {
  switch (state) {
    case 'ready': return { color: '#22c55e', text: acp.label('已连接', 'Connected') }
    case 'starting': return { color: '#eab308', text: acp.label('启动中', 'Starting') }
    case 'error': return { color: '#ef4444', text: acp.label('错误', 'Error') }
    default: return { color: '#9ca3af', text: acp.label('已停止', 'Stopped') }
  }
}

/** Canonical comparable form of an exposure filter: `'all'` (unset) vs `'set:…'`. */
function exposureKey(exposed: string[] | undefined): string {
  return exposed === undefined ? 'all' : `set:${exposed.join('\u0000')}`
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

/** Settings configuration section for ACP agents. */
export function AcpSettingsSection(props: WithStore) {
  const acp = props.acp
  ensureStyle()
  const ui = useUi(acp)
  const [showAdd, setShowAdd] = useState(false)
  const { configured, available } = partitionAgents(ui.detectedAgents, ui.agents)

  return (
    <div style={{ padding: 16, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{acp.label('ACP 智能体代理设置', 'ACP Agents Settings')}</h3>
        <span
          className="dwa-dot"
          style={{ background: ui.stream === 'live' ? '#22c55e' : ui.stream === 'down' ? '#ef4444' : '#9ca3af' }}
          title={ui.stream}
        />
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

      {ui.permissions.length > 0 && (
        <div className="dwa-card dwa-card-warn" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            🔐 {acp.label('待处理权限请求', 'Pending Permission Requests')}
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

      {/* Connected ACP agents: connection state + model catalog per card */}
      <div style={{ marginBottom: 24 }}>
        <div className="dwa-section-title">
          <span>🤖 {acp.label('已接入的 ACP 智能体', 'Connected ACP Agents')}</span>
          <span className="dwa-badge">{configured.length}</span>
        </div>

        {configured.length === 0 && (
          <div className="dwa-card" style={{ textAlign: 'center', color: '#6b7280', padding: 20 }}>
            {acp.label(
              '尚未启用任何 Agent。展开下方「添加 Agent」，用检测到的预设一键启用。',
              'No agents configured yet. Expand "Add Agent" below to enable a detected preset.',
            )}
          </div>
        )}

        {configured.map(({ info, synthesized }) => {
          const activeAgent = ui.agents.find(a => a.id === info.id)
          return (
            <AgentCard
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

      {/* Unconfigured detected presets, collapsed until the user wants to add one */}
      {available.length > 0 && (
        <div>
          <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => setShowAdd(open => !open)}>
            {showAdd ? '▾' : '▸'} {acp.label(`添加 Agent (${available.length})`, `Add Agent (${available.length})`)}
          </button>
          {showAdd && (
            <div style={{ marginTop: 12 }}>
              {available.map(info => (
                <AgentCard
                  key={info.id}
                  detected={info}
                  acp={acp}
                  isDefault={ui.defaultModel === info.id}
                  synthesized={false}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** One card per agent: connection state, model catalog, and a collapsible config form. */
function AgentCard({
  detected,
  activeAgent,
  acp,
  isDefault,
  synthesized,
}: {
  detected: DetectedAgentInfo
  activeAgent?: AgentView
  acp: AcpStore
  isDefault: boolean
  synthesized: boolean
}) {
  const [command, setCommand] = useState(
    activeAgent?.command ?? detected.currentConfig?.command ?? detected.defaultCommand,
  )
  const [argsStr, setArgsStr] = useState(
    (activeAgent?.args ?? detected.currentConfig?.args ?? detected.defaultArgs).join(' '),
  )
  const [permission, setPermission] = useState<PermissionMode>(
    activeAgent?.permission ?? detected.currentConfig?.permission ?? 'ask',
  )
  const [cwd, setCwd] = useState(
    activeAgent?.cwd ?? detected.currentConfig?.cwd ?? '',
  )
  const [exposed, setExposed] = useState<string[] | undefined>(
    detected.currentConfig?.exposedModels === undefined ? undefined : [...detected.currentConfig.exposedModels],
  )
  const [saving, setSaving] = useState(false)
  const [savedSuccess, setSavedSuccess] = useState(false)

  const isConfigured = activeAgent !== undefined || detected.currentConfig !== undefined

  const [configOpen, setConfigOpen] = useState(!isConfigured)
  useEffect(() => {
    setConfigOpen(!isConfigured)
    // Follow configured-ness transitions: collapse after save, reopen after remove.
  }, [isConfigured])

  const serverExposureKey = exposureKey(detected.currentConfig?.exposedModels)
  useEffect(() => {
    const server = detected.currentConfig?.exposedModels
    setExposed(server === undefined ? undefined : [...server])
    // Re-sync the editor only when the persisted filter actually changes, so
    // background resyncs never clobber in-progress checkbox edits.
  }, [serverExposureKey])

  const handleUseDefault = () => {
    setCommand(detected.defaultCommand)
    setArgsStr(detected.defaultArgs.join(' '))
  }

  const handleSave = async () => {
    setSaving(true)
    setSavedSuccess(false)
    try {
      const parsedArgs = argsStr.trim() === '' ? [] : argsStr.trim().split(/\s+/)
      await acp.saveAgent({
        id: detected.id,
        title: detected.name,
        command: command.trim(),
        args: parsedArgs,
        permission,
        cwd: cwd.trim() === '' ? undefined : cwd.trim(),
        ...(exposed === undefined ? {} : { exposedModels: exposed }),
      })
      setSavedSuccess(true)
      setTimeout(() => setSavedSuccess(false), 2000)
    } catch {
      // Error handled by store
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(acp.label(`确定要移除 ${detected.name} 的配置吗？`, `Remove configuration for ${detected.name}?`))) return
    try {
      await acp.deleteAgent(detected.id)
    } catch {
      // Error handled by store
    }
  }

  const state = activeAgent !== undefined ? stateVisual(activeAgent.state, acp) : undefined

  return (
    <div className="dwa-detected-card">
      <div className="dwa-detected-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {state && <span className="dwa-dot" style={{ background: state.color }} title={activeAgent?.state} />}
          <strong style={{ fontSize: 14 }} title={detected.description}>{detected.name}</strong>
          {state && <span style={{ fontSize: 12, color: '#6b7280' }}>{state.text}</span>}
          {!synthesized && (detected.detected ? (
            <span className="dwa-badge dwa-badge-success" title={detected.executablePath}>
              ✓ {acp.label('已检测到主机安装', 'Detected on Host')}
            </span>
          ) : (
            <span className="dwa-badge dwa-badge-warn">
              ⚠ {acp.label('未在 PATH 中检测到', 'Not in PATH')}
            </span>
          ))}
          {isDefault && (
            <span className="dwa-badge dwa-badge-success">
              ★ {acp.label('当前默认模型', 'Default Model')}
            </span>
          )}
        </div>
      </div>

      {activeAgent?.state === 'error' && activeAgent.stderrTail !== undefined && activeAgent.stderrTail.length > 0 && (
        <pre className="dwa-stderr">{activeAgent.stderrTail.join('\n')}</pre>
      )}

      {isConfigured && (
        <ModelCatalogBlock
          agentId={detected.id}
          detected={detected}
          acp={acp}
          exposed={exposed}
          onExposedChange={setExposed}
          isDefault={isDefault}
        />
      )}

      <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px dashed var(--dsw-alias-border-l2, #e5e7eb)' }}>
        <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => setConfigOpen(open => !open)}>
          {configOpen ? '▾' : '▸'} ⚙ {acp.label('配置（命令 / 权限 / 工作目录）', 'Configuration (command / permission / workspace)')}
        </button>

        {configOpen && (
          <>
            {/* Tested default command bar */}
            <div className="dwa-default-hint" style={{ marginTop: 10 }}>
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
                onClick={handleUseDefault}
                title={acp.label('将下方输入框重置为官方验证命令', 'Reset command inputs to tested default')}
              >
                ↺ {acp.label('填入测试默认值', 'Use Tested Default')}
              </button>
            </div>

            <div className="dwa-form-row">
              <div className="dwa-form-col" style={{ flex: 2 }}>
                <label className="dwa-form-label">{acp.label('ACP 启动命令 (Command)', 'ACP Startup Command')}</label>
                <input
                  className="dwa-input dwa-input-mono"
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  placeholder="e.g. pi-acp"
                />
              </div>
              <div className="dwa-form-col" style={{ flex: 3 }}>
                <label className="dwa-form-label">{acp.label('启动参数 (Args, 空格分隔)', 'Arguments (space-separated)')}</label>
                <input
                  className="dwa-input dwa-input-mono"
                  value={argsStr}
                  onChange={e => setArgsStr(e.target.value)}
                  placeholder="e.g. --thinking high"
                />
              </div>
            </div>

            <div className="dwa-form-row">
              <div className="dwa-form-col" style={{ flex: 2 }}>
                <label className="dwa-form-label">{acp.label('权限模式 (Permission Policy)', 'Permission Policy')}</label>
                <select
                  className="dwa-select"
                  value={permission}
                  onChange={e => setPermission(e.target.value as PermissionMode)}
                >
                  <option value="ask">{acp.label('询问人类 (ask)', 'Ask human (ask)')}</option>
                  <option value="allow">{acp.label('始终允许 (allow)', 'Always allow (allow)')}</option>
                  <option value="reject">{acp.label('自动拒绝 (reject)', 'Reject all (reject)')}</option>
                </select>
              </div>
              <div className="dwa-form-col" style={{ flex: 3 }}>
                <label className="dwa-form-label">{acp.label('工作空间根目录 (Workspace Cwd, 可选)', 'Workspace Directory (Optional)')}</label>
                <input
                  className="dwa-input"
                  value={cwd}
                  onChange={e => setCwd(e.target.value)}
                  placeholder={acp.label('默认项目 acp-workspaces 目录', 'Default: project acp-workspaces directory')}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button
                className="dwa-btn dwa-btn-primary"
                onClick={() => void handleSave()}
                disabled={saving || command.trim() === ''}
              >
                {saving
                  ? acp.label('保存中...', 'Saving...')
                  : savedSuccess
                    ? acp.label('✓ 已保存并更新', '✓ Saved & Updated')
                    : isConfigured
                      ? acp.label('保存配置更改', 'Save Changes')
                      : acp.label('保存并启用该 Agent', 'Save & Enable Agent')}
              </button>

              {activeAgent && activeAgent.state !== 'stopped' && (
                <button className="dwa-btn" onClick={() => void acp.stopAgent(detected.id)}>
                  {acp.label('停止当前运行实例', 'Stop Running Process')}
                </button>
              )}

              {isConfigured && (
                <button className="dwa-btn dwa-btn-danger" onClick={() => void handleDelete()}>
                  {acp.label('移除配置', 'Remove')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Probed model / thought-level catalog display plus the native-selector exposure filter. */
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
  const [applying, setApplying] = useState(false)
  const [appliedOk, setAppliedOk] = useState(false)
  const [search, setSearch] = useState('')
  const probing = ui.probingModels[agentId] === true
  const result = ui.modelCatalogs[agentId]
  const modelChoices = result?.catalog.model?.choices ?? []
  const serverExposureKey = exposureKey(detected.currentConfig?.exposedModels)
  const dirty = exposureKey(exposed) !== serverExposureKey

  const query = search.trim().toLowerCase()
  const visibleChoices = query === ''
    ? modelChoices
    : modelChoices.filter(choice =>
      choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query))

  const basis = exposed ?? modelChoices.map(c => c.value)
  const visibleValues = visibleChoices.map(c => c.value)
  const allChecked = visibleValues.length > 0 && visibleValues.every(v => basis.includes(v))

  const toggleChoice = (value: string) => {
    onExposedChange(basis.includes(value) ? basis.filter(v => v !== value) : [...basis, value])
  }

  /**
   * 全选 toggle: no search → expose everything ↔ none ([]); with a search
   * active → check the matching models, or uncheck exactly those when all
   * of them are checked. The button label mirrors the toggle state.
   */
  const toggleVisible = () => {
    if (query === '') {
      onExposedChange(allChecked ? [] : undefined)
      return
    }
    onExposedChange(
      allChecked
        ? basis.filter(v => !visibleValues.includes(v))
        : [...new Set([...basis, ...visibleValues])],
    )
  }

  const applyFilter = async (next: string[] | undefined) => {
    setApplying(true)
    try {
      await acp.setExposedModels(agentId, next)
      onExposedChange(next)
      setAppliedOk(true)
      setTimeout(() => setAppliedOk(false), 2000)
    } catch {
      // Notice handled in store; keep the local edits so the user can retry.
    } finally {
      setApplying(false)
    }
  }

  return (
    <div style={{ marginTop: 12, borderTop: '1px dashed var(--dsw-alias-border-l2, #e5e7eb)', paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button className="dwa-btn dwa-btn-secondary" disabled={probing} onClick={() => void acp.probeModels(agentId)}>
          {probing
            ? acp.label('模型检测中...', 'Probing models...')
            : acp.label('🧠 检测可用模型', 'Detect Available Models')}
        </button>
        {!isDefault && (
          <button className="dwa-btn" onClick={() => void acp.setDefaultModel(agentId)}>
            ★ {acp.label('设为默认模型', 'Set as Default Model')}
          </button>
        )}
        {result !== undefined && result.catalog.model === undefined && (
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            {acp.label('该 Agent 未暴露模型选择器（category: model）', 'Agent exposes no model selector (category: model)')}
          </span>
        )}
      </div>
      {result !== undefined && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          {modelChoices.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--dsw-alias-text-secondary, #555)', fontWeight: 600 }}>
                  {acp.label('原生选择器可见模型', 'Models in Native Selector')}
                </span>
                {exposed !== undefined && (
                  <span className="dwa-badge dwa-badge-info">
                    {acp.label(
                      `已筛选 ${exposed.filter(v => modelChoices.some(c => c.value === v)).length}/${modelChoices.length}`,
                      `Filtered ${exposed.filter(v => modelChoices.some(c => c.value === v)).length}/${modelChoices.length}`,
                    )}
                  </span>
                )}
                <span style={{ fontSize: 11, color: '#6b7280' }}>
                  {acp.label('勾选后点「应用筛选」生效；默认模型始终可见。', 'Check models then "Apply Filter"; the agent default is always visible.')}
                </span>
              </div>
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
                {exposed !== undefined && (
                  <button className="dwa-btn" disabled={applying} onClick={() => void applyFilter(undefined)}>
                    {acp.label('全部显示', 'Show All')}
                  </button>
                )}
                <button
                  className="dwa-btn dwa-btn-primary"
                  disabled={!dirty || applying}
                  onClick={() => void applyFilter(exposed)}
                >
                  {applying
                    ? acp.label('应用中...', 'Applying...')
                    : appliedOk
                      ? acp.label('✓ 已应用', '✓ Applied')
                      : acp.label('应用筛选', 'Apply Filter')}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', maxHeight: 180, overflow: 'auto' }}>
                {visibleChoices.map(choice => {
                  const checked = exposed === undefined || exposed.includes(choice.value)
                  return (
                    <label
                      key={choice.value}
                      className="dwa-badge"
                      title={choice.description}
                      style={{
                        cursor: 'pointer',
                        ...(checked ? { background: '#3b82f622', color: '#2563eb' } : { opacity: 0.55 }),
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChoice(choice.value)}
                        style={{ margin: 0, accentColor: '#2563eb' }}
                      />
                      {choice.name}
                    </label>
                  )
                })}
                {visibleChoices.length === 0 && (
                  <span style={{ color: '#6b7280' }}>{acp.label('无匹配模型', 'No matching models')}</span>
                )}
              </div>
            </div>
          )}
          {result.catalog.thought !== undefined && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ color: 'var(--dsw-alias-text-secondary, #555)', fontWeight: 600 }}>
                {acp.label('思考等级', 'Thought Levels')}
              </span>
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
