/**
 * React surface for ACP: the settings configuration section.
 * Supports host agent detection, tested defaults display, and startup command customization.
 * All business state lives in the injected AcpStore.
 */

import { useState, useSyncExternalStore } from 'react'
import type { AcpStore } from './store.ts'
import type { AgentView, DetectedAgentInfo, PermissionMode } from '../protocol.ts'

interface WithStore { acp: AcpStore }

const STYLE = `
.dwa-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dwa-table th, .dwa-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e2e2e2); vertical-align: middle; }
.dwa-btn { font: inherit; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #bbb); background: var(--dsw-alias-button-tool-bar-fill, transparent); padding: 5px 12px; cursor: pointer; color: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; transition: background 0.15s ease; }
.dwa-btn:hover { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
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
.dwa-card-info { border-left: 4px solid var(--dsw-alias-button-primary-fill, #2563eb); }
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

/** Settings configuration section for ACP agents. */
export function AcpSettingsSection(props: WithStore) {
  const acp = props.acp
  ensureStyle()
  const ui = useUi(acp)

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

      <div className="dwa-card dwa-card-info" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {acp.label('💡 原生聊天已深度接入', '💡 Native Chat Deeply Integrated')}
        </div>
        <div style={{ color: 'var(--dsw-alias-text-secondary, #555)' }}>
          {acp.label(
            '系统会自动检测主机安装的 Agent，并提供测试验证过的 ACP 启动命令。你也可以自由定制命令与启动参数。配置完成后，可在下方将其设为默认模型，或在聊天中直接使用。',
            'The host automatically detects installed agents and provides tested default startup commands. You can also customize commands and arguments. Once saved, set it as the default model or select it directly in chat.',
          )}
        </div>
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

      {/* Detected Host Agents */}
      <div style={{ marginBottom: 24 }}>
        <div className="dwa-section-title">
          <span>🔍 {acp.label('检测主机当前智能体', 'Detected Host Agents')}</span>
          <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7280' }}>
            {acp.label('检测系统 PATH 中支持 ACP 的 Agent', 'Scanned from system PATH')}
          </span>
        </div>

        {ui.detectedAgents.length === 0 && (
          <div className="dwa-card" style={{ textAlign: 'center', color: '#6b7280', padding: 20 }}>
            {ui.detecting
              ? acp.label('正在扫描主机 Agent...', 'Scanning host for agents...')
              : acp.label('暂无可检测的智能体预设，点击右上角按钮重新扫描。', 'No presets available. Click Re-detect above.')}
          </div>
        )}

        {ui.detectedAgents.map(detected => {
          const activeAgent = ui.agents.find(a => a.id === detected.id)
          return (
            <DetectedAgentCard
              key={detected.id}
              detected={detected}
              activeAgent={activeAgent}
              acp={acp}
              isDefault={ui.defaultModel === detected.id}
            />
          )
        })}
      </div>

      {/* Configured / Active ACP Agents Table */}
      <div>
        <div className="dwa-section-title">
          <span>📋 {acp.label('当前已启用的 ACP 代理', 'Configured & Active ACP Agents')}</span>
          <span className="dwa-badge">{ui.agents.length}</span>
        </div>

        <table className="dwa-table">
          <thead>
            <tr>
              <th>ID / {acp.label('名称', 'Title')}</th>
              <th>{acp.label('命令与参数', 'Command & Args')}</th>
              <th>{acp.label('运行状态', 'State')}</th>
              <th>{acp.label('权限策略', 'Permission')}</th>
              <th>{acp.label('快捷操作', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {ui.agents.map(agent => (
              <AgentRow
                key={agent.id}
                agent={agent}
                acp={acp}
                isDefault={ui.defaultModel === agent.id}
              />
            ))}
            {ui.agents.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 18, textAlign: 'center', color: '#6b7280' }}>
                  {acp.label(
                    '尚未启用任何 Agent：请在上方检测列表中配置并启用智能体（例如 Pi Agent）。',
                    'No active agents — enable one from the detected list above (e.g. Pi Agent).',
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DetectedAgentCard({
  detected,
  activeAgent,
  acp,
  isDefault,
}: {
  detected: DetectedAgentInfo
  activeAgent?: AgentView
  acp: AcpStore
  isDefault: boolean
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
  const [saving, setSaving] = useState(false)
  const [savedSuccess, setSavedSuccess] = useState(false)

  const isConfigured = activeAgent !== undefined || detected.currentConfig !== undefined

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

  return (
    <div className="dwa-detected-card">
      <div className="dwa-detected-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 14 }}>{detected.name}</strong>
          <span style={{ color: '#6b7280', fontSize: 12 }}>({detected.id})</span>
          {detected.detected ? (
            <span className="dwa-badge dwa-badge-success" title={detected.executablePath}>
              ✓ {acp.label('已检测到主机安装', 'Detected on Host')}
            </span>
          ) : (
            <span className="dwa-badge dwa-badge-warn">
              ⚠ {acp.label('未在 PATH 中检测到', 'Not in PATH')}
            </span>
          )}
          {isConfigured && (
            <span className="dwa-badge dwa-badge-info">
              {acp.label('已启用', 'Configured')}
            </span>
          )}
          {isDefault && (
            <span className="dwa-badge dwa-badge-success">
              ★ {acp.label('当前默认模型', 'Default Model')}
            </span>
          )}
        </div>

        {detected.executablePath && (
          <span style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
            {detected.executablePath}
          </span>
        )}
      </div>

      {detected.description && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-text-secondary, #666)', marginBottom: 10 }}>
          {detected.description}
        </div>
      )}

      {/* Tested default command bar */}
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
          onClick={handleUseDefault}
          title={acp.label('将下方输入框重置为官方验证命令', 'Reset command inputs to tested default')}
        >
          ↺ {acp.label('填入测试默认值', 'Use Tested Default')}
        </button>
      </div>

      {/* Editable Form */}
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

        {isConfigured && !isDefault && (
          <button className="dwa-btn" onClick={() => void acp.setDefaultModel(detected.id)}>
            {acp.label('设为默认模型', 'Set as Default Model')}
          </button>
        )}

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
    </div>
  )
}

function AgentRow({ agent, acp, isDefault }: { agent: AgentView; acp: AcpStore; isDefault: boolean }) {
  const dotColor = agent.state === 'ready'
    ? '#22c55e'
    : agent.state === 'starting'
      ? '#eab308'
      : agent.state === 'error'
        ? '#ef4444'
        : '#9ca3af'

  return (
    <tr>
      <td>
        <strong>{agent.title}</strong>
        <br />
        <small style={{ color: '#6b7280' }}>{agent.id}</small>
      </td>
      <td>
        <code style={{ fontSize: 12, background: 'var(--dsw-alias-bg-layer-1, #f4f4f4)', padding: '2px 4px', borderRadius: 4 }}>
          {agent.command} {agent.args.join(' ')}
        </code>
      </td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span className="dwa-dot" style={{ background: dotColor }} />
          <span>{agent.state}</span>
        </div>
        {agent.state === 'error' && agent.stderrTail !== undefined && agent.stderrTail.length > 0 && (
          <pre className="dwa-stderr">{agent.stderrTail.join('\n')}</pre>
        )}
      </td>
      <td>
        <select
          className="dwa-select"
          value={agent.permission}
          onChange={e => void acp.setPermission(agent.id, e.target.value as PermissionMode)}
        >
          <option value="ask">{acp.label('询问 (ask)', 'Ask')}</option>
          <option value="allow">{acp.label('允许 (allow)', 'Allow')}</option>
          <option value="reject">{acp.label('拒绝 (reject)', 'Reject')}</option>
        </select>
      </td>
      <td>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {isDefault ? (
            <span className="dwa-badge dwa-badge-success">
              ✓ {acp.label('默认模型', 'Default')}
            </span>
          ) : (
            <button className="dwa-btn dwa-btn-primary" onClick={() => void acp.setDefaultModel(agent.id)}>
              {acp.label('设为默认', 'Set Default')}
            </button>
          )}
          {agent.state !== 'stopped' && (
            <button className="dwa-btn" onClick={() => void acp.stopAgent(agent.id)}>
              {acp.label('停止', 'Stop')}
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

