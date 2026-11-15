/**
 * React surface for ACP: the settings configuration section.
 *
 * Scope is deliberately narrow — this is a CONFIGURATION surface. Runtime
 * interaction lives in the conversation: every permission ask with a chat
 * identity is answered on a card above that conversation's composer
 * (`permission-dock.tsx`). The ledger card here is the cross-session mirror —
 * asks whose conversation is not open, or which have no chat identity at all —
 * and is where those are answered (see `permissionLedgerCard`).
 *
 * Each configured agent is one compact row (status + current model + badges)
 * that expands into the full connection form and model catalog. The row stays
 * mounted and the body toggles `display`, so editing a form and collapsing it
 * never loses the in-progress values.
 * All business state lives in the injected AcpStore.
 *
 * This file is the section's entry component and its public surface; the
 * clusters it renders live in `panel/` (styles / shared / form / one file per
 * card), and everything the rest of the bundle imports from `panel.tsx` is
 * re-exported at the bottom so no import site had to move.
 */

import { useEffect, useState } from 'react'
import { LOG_MAX_ENTRIES } from './store.ts'
import type { AcpStore } from './store.ts'
import type { DetectedAgentInfo } from '../protocol.ts'
import { ApprovalDeadlinesCard } from './panel/approval-deadlines-card.tsx'
import { AgentRow } from './panel/agent-row.tsx'
import { IdleReleaseCard } from './panel/idle-release-card.tsx'
import { PermissionMirrorCard } from './panel/permission-mirror.tsx'
import { PluginUpdateBadge, PluginUpdateCard, updateCardVisible } from './panel/plugin-update.tsx'
import { partitionAgents, streamText, useUi } from './panel/shared.ts'
import { ensureStyle } from './panel/styles.ts'

interface WithStore { acp: AcpStore }

/** Seed for the from-scratch creation card: no preset, no tested default. */
const NEW_AGENT_SEED: DetectedAgentInfo = {
  id: '',
  name: '',
  detected: false,
  defaultCommand: '',
  defaultArgs: [],
}

type SettingsPage = 'agents' | 'add' | 'approvals' | 'processes' | 'appearance' | 'logs' | 'diagnostics'

/**
 * Local wall-clock `HH:MM:SS` for one runtime-log line. Hand-built on purpose:
 * `toLocaleTimeString` may drop seconds or pick a 12-hour clock depending on
 * the browser locale, which makes the column ragged and ambiguous.
 */
function logClock(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}

export function AcpSettingsSection(props: WithStore) {
  const acp = props.acp
  ensureStyle()
  const ui = useUi(acp)
  const [page, setPage] = useState<SettingsPage>('agents')
  const [addOpen, setAddOpen] = useState(false)
  const [addTarget, setAddTarget] = useState<DetectedAgentInfo | undefined>(undefined)
  const [updateOpen, setUpdateOpen] = useState(false)
  // The store throttles this to one registry read per ten minutes, so every
  // remount (both settings entries mount this section) is cheap.
  useEffect(() => {
    void acp.checkPluginUpdate()
  }, [acp])
  // Opening the log is the read receipt. The store does not mutate at zero,
  // so this cannot loop.
  useEffect(() => {
    if (page === 'logs' && ui.logUnread > 0) acp.markLogsRead()
  }, [acp, page, ui.logUnread])
  const { configured, available } = partitionAgents(ui.detectedAgents, ui.agents)
  const selected = addTarget ?? available[0] ?? NEW_AGENT_SEED
  const openAdd = (): void => {
    setAddOpen(true)
    setPage('add')
  }
  const presetProblem = ui.preset !== undefined && (!ui.preset.installed || ui.preset.problem !== undefined)
  const update = ui.pluginUpdate
  // A source install cannot be replaced by this browser; the version badge
  // says so on hover. Neutral wording: a checkout may be git or not.
  const versionTitle = update?.status === 'source-install'
    ? acp.label('源码或本地安装，无法通过 registry 更新。', 'Source or local install; update it through its own checkout.')
    : undefined
  // The running version is the update entry: every state with a real install
  // report can open the card, including "up to date" (which offers a re-check).
  const versionOpensUpdate = update !== undefined
    && update.status !== 'unsupported'
    && update.status !== 'not-installed'

  return (
    <div className="dwa-root">
      <header className="dwa-page-header">
        <div className="dwa-page-heading">
          <h2 className="dwa-page-title" aria-label={acp.label('NTR 设置', 'NTR settings')}>
            {acp.label('NTR 设置', 'NTR settings')}
            {ui.pluginVersion !== undefined && (
              versionOpensUpdate
                ? (
                  <button
                    type="button"
                    className="dwa-badge dwa-version dwa-version-btn"
                    title={versionTitle}
                    aria-expanded={updateOpen}
                    aria-controls="ntr-plugin-update-card"
                    onClick={() => setUpdateOpen(open => !open)}
                  >
                    {`v${ui.pluginVersion}`}
                  </button>
                )
                : <span className="dwa-badge dwa-version" title={versionTitle}>{`v${ui.pluginVersion}`}</span>
            )}
            {update !== undefined && (
              <PluginUpdateBadge
                acp={acp}
                update={update}
                open={updateOpen}
                onToggle={() => setUpdateOpen(open => !open)}
              />
            )}
          </h2>
          <p className="dwa-page-description">
            {acp.label('连接智能体，设置你的对话偏好。', 'Connect agents and set your conversation preferences.')}
          </p>
        </div>
        {page === 'agents' && configured.length > 0 && (
          <button type="button" className="dwa-btn dwa-btn-primary" onClick={openAdd}>
            {acp.label('添加智能体', 'Add agent')}
          </button>
        )}
      </header>

      {update !== undefined && updateCardVisible(update, updateOpen) && (
        <PluginUpdateCard acp={acp} update={update} onClose={() => setUpdateOpen(false)} />
      )}
      {/* The cross-session mirror; the dock owns the open conversation's asks. */}
      <PermissionMirrorCard acp={acp} ui={ui} />

      {ui.notice !== undefined && (
        <div className="dwa-card dwa-card-warn" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{ui.notice}</span>
          <button type="button" className="dwa-btn dwa-btn-quiet" aria-label={acp.label('关闭通知', 'Dismiss notice')} onClick={() => acp.clearNotice()}>✕</button>
        </div>
      )}

      {presetProblem && (
        <div className="dwa-card dwa-card-warn dwa-notice" role="status">
          <span>{acp.label('NTR 模式需要检查，当前可能无法开始对话。', 'NTR mode needs attention; new conversations may be unavailable.')}</span>
          <button type="button" className="dwa-btn" onClick={() => setPage('diagnostics')}>{acp.label('查看诊断', 'View diagnostics')}</button>
        </div>
      )}
      <nav className="dwa-tabs" aria-label={acp.label('NTR 设置分类', 'NTR settings categories')}>
        <button type="button" aria-pressed={page === 'agents'} onClick={() => setPage('agents')}>{acp.label('智能体', 'Agents')}</button>
        {ui.approvalDeadlines !== undefined && <button type="button" aria-pressed={page === 'approvals'} onClick={() => setPage('approvals')}>{acp.label('审批时限', 'Approval deadlines')}</button>}
        {ui.idleRelease !== undefined && <button type="button" aria-pressed={page === 'processes'} onClick={() => setPage('processes')}>{acp.label('进程管理', 'Processes')}</button>}
        <button type="button" aria-pressed={page === 'appearance'} onClick={() => setPage('appearance')}>{acp.label('对话外观', 'Appearance')}</button>
        <button type="button" aria-pressed={page === 'logs'} onClick={() => setPage('logs')}>
          {acp.label('日志', 'Logs')}
          {ui.logUnread > 0 && <span className="dwa-log-dot" aria-hidden="true" />}
        </button>
      </nav>
      {page === 'diagnostics' && (
        <section className="dwa-section">
          <h3 className="dwa-section-title">{acp.label('连接诊断', 'Connection diagnostics')}</h3>
          <div className="dwa-preference-row"><span>{acp.label('宿主事件流', 'Host event stream')}</span><span className="dwa-hint">{streamText(ui.stream, acp)}</span></div>
          <div className="dwa-row-actions">
            <button type="button" className="dwa-btn" onClick={() => { void acp.resync(); void acp.detectAgents() }} disabled={ui.detecting}>
              {ui.detecting ? acp.label('检测中...', 'Detecting...') : acp.label('重新检测与刷新', 'Re-detect & Refresh')}
            </button>
            {ui.detectSummary !== undefined && <span className="dwa-hint" role="status">{ui.detectSummary}</span>}
          </div>
        </section>
      )}
      {page === 'diagnostics' && ui.preset !== undefined && (
        <div className="dwa-card dwa-mode-banner">
          <div className="dwa-mode-title">
            {acp.label('NTR 模式', 'NTR mode')}
            <span className="dwa-badge">{ui.preset.id}</span>
          </div>
          <span className={`dwa-badge ${ui.preset.installed ? 'dwa-badge-success' : 'dwa-badge-warn'}`}>
            {ui.preset.installed ? acp.label('已就绪', 'Ready') : acp.label('需检查', 'Needs attention')}
          </span>
          <div className="dwa-mode-copy">
            {ui.preset.installed
              ? acp.label('已加入宿主模式列表，新建会话时选择「NTR 模式」即可使用。', 'Added to the harness roster. Pick “NTR mode” when creating a session.')
              : acp.label('宿主模式列表中没有可用的「NTR 模式」，请检查预设声明。', 'The harness roster has no usable “NTR mode”. Check the preset declaration.')}
            <code className="dwa-mode-source dwa-mono">{ui.preset.source}</code>
          </div>
          {ui.preset.problem !== undefined && (
            <div className="dwa-hint" style={{ gridColumn: '1 / -1', color: 'var(--ntr-warn)' }}>
              {acp.label(`宿主报告：${ui.preset.problem}`, `Harness reported: ${ui.preset.problem}`)}
            </div>
          )}
        </div>
      )}

      {/* Keep editors mounted so navigation preserves unsaved values. */}
      <section className="dwa-section" hidden={page !== 'agents'} aria-label={acp.label('已接入的智能体', 'Connected agents')}>
        <div className="dwa-section-heading">
          <div>
            <h3 className="dwa-section-title">
              {acp.label('已接入的智能体', 'Connected agents')}
              {ui.agentsLoaded && <span className="dwa-badge">{configured.length}</span>}
            </h3>
          </div>
          {configured.length > 0 && <span className="dwa-hint">{acp.label('默认项用于新的 NTR 会话', 'The default serves new NTR conversations')}</span>}
        </div>

        {!ui.agentsLoaded && <div className="dwa-empty" role="status">{acp.label('正在读取智能体…', 'Loading agents…')}</div>}
        {ui.agentsLoaded && configured.length === 0 && (
          <div className="dwa-empty">
            <h3>{acp.label('接入第一个智能体', 'Connect your first agent')}</h3>
            <p className="dwa-section-copy">{acp.label('选择已有预设，或填写自己的 ACP 启动命令。', 'Choose a preset or enter your own ACP launch command.')}</p>
            <button type="button" className="dwa-btn dwa-btn-primary" onClick={openAdd}>{acp.label('添加智能体', 'Add agent')}</button>
          </div>
        )}

        <div className="dwa-agent-list">
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
                active={page === 'agents'}
              />
            )
          })}
        </div>
      </section>

      <section className="dwa-section" hidden={page !== 'add'} aria-label={acp.label('添加智能体', 'Add agent')}>
        <button type="button" className="dwa-btn dwa-btn-quiet dwa-back" onClick={() => setPage('agents')}>{acp.label('返回智能体列表', 'Back to agents')}</button>
        <div className="dwa-add-panel">
          <div className="dwa-section-heading">
            <div>
              <h3 className="dwa-section-title">{acp.label('添加智能体', 'Add agent')}</h3>
              <p className="dwa-section-copy">{acp.label('从预设快速启用，或创建自定义连接。', 'Enable a preset or create a custom connection.')}</p>
            </div>
          </div>
          {addOpen && (
            <div className="dwa-add-content">
              <div className="dwa-chip-list">
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
              key={selected.id}
              detected={selected}
              acp={acp}
              isDefault={false}
              synthesized={false}
              newCustom={selected.id === ''}
              active={page === 'add'}
              onCreated={() => {
                setAddTarget(undefined)
                setAddOpen(false)
                setPage('agents')
              }}
            />
            </div>
          )}
        </div>
      </section>

      <div hidden={page !== 'approvals'}><ApprovalDeadlinesCard acp={acp} ui={ui} /></div>
      <div hidden={page !== 'processes'}><IdleReleaseCard acp={acp} ui={ui} /></div>

      <section className="dwa-section" hidden={page !== 'appearance'} aria-label={acp.label('对话外观', 'Appearance')}>
        <div className="dwa-section-heading">
          <div>
            <h3 className="dwa-section-title">{acp.label('对话外观', 'Conversation appearance')}</h3>
            <p className="dwa-section-copy">{acp.label('设置 NTR 在对话与侧栏里的可见标识。', 'Choose how NTR marks itself up in the conversation and sidebar.')}</p>
          </div>
        </div>
        <div className="dwa-preferences">
          <div className="dwa-preference-row">
            <div>
              <div className="dwa-preference-label">{acp.label('挂牌光晕', 'Tag halo')}</div>
              <div className="dwa-preference-copy">{acp.label('呼吸为脉动光，常亮为恒定光。', 'Breathe pulses gently; steady keeps a constant glow.')}</div>
            </div>
            <div className="dwa-seg">
              {(['breath', 'steady'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  className={ui.tagHalo.mode === mode ? 'is-on' : ''}
                  onClick={() => void acp.setTagHalo({ ...ui.tagHalo, mode })}
                >
                  {mode === 'breath' ? acp.label('呼吸', 'Breathe') : acp.label('常亮', 'Steady')}
                </button>
              ))}
            </div>
          </div>
          {ui.tagHalo.mode === 'breath' && (
            <div className="dwa-preference-row">
              <div>
                <div className="dwa-preference-label">{acp.label('呼吸频率', 'Breathing speed')}</div>
                <div className="dwa-preference-copy">{acp.label('控制光晕的脉动速度。', 'Controls how quickly the halo pulses.')}</div>
              </div>
              <div className="dwa-seg">
                {(['slow', 'normal', 'fast'] as const).map(speed => (
                  <button
                    key={speed}
                    type="button"
                    className={ui.tagHalo.speed === speed ? 'is-on' : ''}
                    onClick={() => void acp.setTagHalo({ ...ui.tagHalo, speed })}
                  >
                    {speed === 'slow' ? acp.label('慢速', 'Slow') : speed === 'normal' ? acp.label('正常', 'Normal') : acp.label('快速', 'Fast')}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="dwa-preference-row">
            <div>
              <div className="dwa-preference-label">{acp.label('标题标识', 'Title badge')}</div>
              <div className="dwa-preference-copy">{acp.label('生成的会话标题带 [NTR] 前缀。', 'Generated session titles gain the [NTR] prefix.')}</div>
            </div>
            <div className="dwa-seg">
              {([false, true] as const).map(value => (
                <button
                  key={String(value)}
                  type="button"
                  className={ui.titlePrefix === value ? 'is-on' : ''}
                  onClick={() => void acp.setTitlePrefix(value)}
                >
                  {value ? acp.label('开启', 'On') : acp.label('关闭', 'Off')}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
      {/* Conditional on purpose: this list can hold 200 rows, and keeping it
          mounted through a `hidden` page would re-render every line on each
          `session/update`. It carries no local state, so remounting is free. */}
      {page === 'logs' && (
        <section className="dwa-section" aria-label={acp.label('运行日志', 'Runtime log')}>
          <div className="dwa-section-heading">
            <div>
              <h3 className="dwa-section-title">{acp.label('运行日志', 'Runtime log')}</h3>
              <p className="dwa-section-copy">
                {acp.label(
                  `agent 运行消息，最多 ${String(LOG_MAX_ENTRIES)} 条。`,
                  `Agent runtime messages, up to ${String(LOG_MAX_ENTRIES)}.`,
                )}
              </p>
            </div>
            {ui.logs.length > 0 && (
              <button type="button" className="dwa-btn dwa-btn-quiet" onClick={() => acp.clearLogs()}>
                {acp.label('清空', 'Clear')}
              </button>
            )}
          </div>
          {ui.logs.length === 0
            ? <div className="dwa-empty" role="status">{acp.label('暂无运行日志。', 'No runtime messages yet.')}</div>
            : (
              <ul className="dwa-log-list">
                {[...ui.logs].reverse().map(entry => (
                  <li key={entry.id} className={entry.level === 'error' ? 'dwa-log-row is-error' : 'dwa-log-row'}>
                    <span className="dwa-log-time dwa-mono">{logClock(entry.at)}</span>
                    <span className={`dwa-badge dwa-log-level ${entry.level === 'error' ? 'is-error' : 'is-info'}`}>
                      {entry.level === 'error' ? acp.label('错误', 'Error') : acp.label('信息', 'Info')}
                    </span>
                    {entry.agentId !== undefined && <span className="dwa-badge">{entry.agentId}</span>}
                    <span className="dwa-log-text">{entry.text}</span>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}
      <footer className="dwa-health">
        <div className="dwa-health-status">
          <span className="dwa-dot" style={{ background: ui.stream === 'live' ? 'var(--ntr-success)' : ui.stream === 'down' ? 'var(--ntr-danger)' : 'var(--ntr-muted)' }} />
          <span>{streamText(ui.stream, acp)}</span>
          {ui.preset !== undefined && <span>{ui.preset.installed && !presetProblem ? acp.label('NTR 模式已就绪', 'NTR mode ready') : acp.label('NTR 模式需检查', 'NTR mode needs attention')}</span>}
        </div>
        {page !== 'diagnostics' && <button type="button" className="dwa-btn dwa-btn-quiet" onClick={() => setPage('diagnostics')}>{acp.label('查看诊断', 'View diagnostics')}</button>}
      </footer>
    </div>
  )
}

export { approvalDeadlineFacts, DEADLINE_MIN_WAIT_MS, deadlineSliderIndex, deadlineValueFor } from './panel/approval-deadlines-card.tsx'
export { buildPayload, initialForm, payloadEquals } from './panel/form.ts'
export { agentTestHint, permissionLedgerCard } from './panel/permission-mirror.tsx'
export type { AgentTestOutcome } from './panel/permission-mirror.tsx'
