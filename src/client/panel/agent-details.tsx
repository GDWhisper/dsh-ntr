/**
 * The body's connection side: the launch command, the workspace allow-list, the
 * env rows, the MCP list, and the save / test actions with their result block.
 */
import { formatCommandLine, splitCommandLine } from '../acp-ui.tsx'
import type { AcpStore } from '../store.ts'
import type { ActiveTurnView, DetectedAgentInfo } from '../../protocol.ts'
import { AgentDefaultMode } from './agent-default-mode.tsx'
import type { AgentForm } from './form.ts'
import type { AgentTestOutcome } from './permission-mirror.tsx'

/**
 * Hand copy of `DEFAULT_TUNING.probeIdleTimeoutMs` (src/bridge.ts). A process
 * that has never hosted a session — the model probe / post-save probe — lives
 * by THIS window whatever the agent's own field says, so the placeholder has to
 * name both windows. Keep the two in sync.
 */
const DEFAULT_PROBE_RELEASE_MS = 300_000

/** The expanded body: connection form, workspace allow-list, env, actions. */
export function AgentDetails({
  acp,
  advancedOpen,
  dirty,
  detected,
  form,
  patch,
  isConfigured,
  newCustom,
  formIncomplete,
  idValid,
  idTaken,
  idDeleted,
  cwdInvalid,
  rootsInvalid,
  idleInvalid,
  mcpInvalid,
  saving,
  savedSuccess,
  saveDeferred,
  saveNotice,
  saveConfirm,
  canDefer,
  onSaveCancel,
  onSaveDefer,
  onSaveForce,
  testing,
  testResult,
  showSaveWarning,
  onUseDefault,
  onSave,
  onTest,
}: {
  acp: AcpStore
  advancedOpen: boolean
  dirty: boolean
  detected: DetectedAgentInfo
  form: AgentForm
  patch: (next: Partial<AgentForm>) => void
  isConfigured: boolean
  newCustom: boolean
  formIncomplete: boolean
  idValid: boolean
  idTaken: boolean
  /** The id was deleted during this host run; the tombstone refuses reuse. */
  idDeleted: boolean
  cwdInvalid: boolean
  rootsInvalid: boolean
  idleInvalid: boolean
  mcpInvalid: boolean
  saving: boolean
  savedSuccess: boolean
  saveDeferred: boolean
  /** Feedback for a held save that was cancelled because the form changed. */
  saveNotice?: string
  saveConfirm?: ActiveTurnView[]
  canDefer: boolean
  onSaveCancel: () => void
  onSaveDefer: () => void
  onSaveForce: () => void
  testing: boolean
  testResult?: AgentTestOutcome
  showSaveWarning: boolean
  onUseDefault: () => void
  onSave: () => void
  onTest: () => void
}) {
  // The same parse the host will run (`validateAgentDef` → `splitCommandLine`).
  // Showing it is what turns "the first box swallowed my arguments" into a
  // visible, fixable state instead of a spawn error.
  const parsedCommand = splitCommandLine(form.commandLine)
  const commandPreview = parsedCommand.command === ''
    ? acp.label('填整条命令，例如：codebuddy --acp', 'Type the whole command, e.g. codebuddy --acp')
    : `${acp.label('程序', 'Program')}: ${parsedCommand.command}`
      + (parsedCommand.args.length === 0 ? '' : `　${acp.label('参数', 'Arguments')}: ${parsedCommand.args.join(' ')}`)
  return (
    <div>
      <div hidden={advancedOpen}>
      {newCustom && (
        <div className="dwa-form-row">
          <div className="dwa-form-col">
            <label className="dwa-form-label">{acp.label('Agent ID（唯一标识，创建后不可改）', 'Agent ID (unique, immutable after creation)')}</label>
            <input
              className="dwa-input dwa-input-mono"
              aria-label={acp.label('Agent ID', 'Agent ID')}
              value={form.agentId}
              onChange={e => patch({ agentId: e.target.value })}
              placeholder="e.g. my-agent"
            />
            <span className={idValid && !idTaken && !idDeleted ? 'dwa-hint' : 'dwa-error'}>
              {idDeleted
                ? acp.label(
                    '该 id 在本次运行中不可复用，需重启宿主或换一个 id。',
                    'This id cannot be reused during this run. Restart the host or choose another id.',
                  )
                : idTaken
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
            aria-label={acp.label('显示名', 'Display Name')}
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
            aria-label={acp.label('启动命令（程序 + 参数）', 'Launch Command (program + arguments)')}
            value={form.commandLine}
            onChange={e => patch({ commandLine: e.target.value })}
            placeholder={detected.defaultCommand === ''
              ? 'e.g. codebuddy --acp'
              : formatCommandLine(detected.defaultCommand, detected.defaultArgs)}
          />
          <span className="dwa-hint">{commandPreview}</span>
          <span className="dwa-hint">
            {acp.label(
              '含空格的程序路径请加引号。',
              'Quote the program path if it contains spaces.',
            )}
          </span>
        </div>
      </div>

      <WorkspaceBlock acp={acp} form={form} patch={patch} cwdInvalid={cwdInvalid} rootsInvalid={rootsInvalid} />
      </div>

      <div hidden={!advancedOpen}>
        {!newCustom && (
          <div className="dwa-default-hint">
            <div>
              <span style={{ fontWeight: 600, marginRight: 6 }}>
                {acp.label('官方测试默认命令:', 'Tested Default Command:')}
              </span>
              <code className="dwa-input-mono" style={{ background: 'var(--dsw-alias-markdown-inline-code, #0000000a)', padding: '2px 6px', borderRadius: 4 }}>
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

      {/* Idle release: an OVERRIDE of the global window (「进程管理」). Empty
          means "follow the global window", so the global slider reaches every
          agent that does not pin its own. TWO windows exist
          (AgentBridge.currentIdleTimeoutMs): this field is the chat window of
          a process that HAS hosted a session; a never-used process (a probe)
          always gets the short probe window and ignores this field — which is
          why the copy below names both. */}
      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('空闲释放覆盖（毫秒）', 'Idle Release Override (ms)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            aria-label={acp.label('空闲释放覆盖（毫秒）', 'Idle Release Override (ms)')}
            value={form.idleStr}
            onChange={e => patch({ idleStr: e.target.value })}
            placeholder={acp.label(
              `留空 = 跟随全局设置（探测进程固定 ${String(DEFAULT_PROBE_RELEASE_MS / 60_000)} 分钟）`,
              `Blank = follow the global setting (probes always release after ${String(DEFAULT_PROBE_RELEASE_MS / 60_000)} min)`,
            )}
          />
          <span className={idleInvalid ? 'dwa-error' : 'dwa-hint'}>
            {idleInvalid
              ? acp.label(
                '必须是 0（永不释放）或 [1000, 86400000] 之间的整数毫秒。',
                'Must be 0 (never release) or an integer in [1000, 86400000] ms.',
              )
              : (
                <>
                  {acp.label(
                    '仅覆盖此智能体；留空即跟随「进程管理」的全局设置。',
                    'Overrides this agent only; leave blank to follow the global setting in “Processes”.',
                  )}
                </>
              )}
          </span>
        </div>
      </div>

      {!newCustom && isConfigured && <AgentDefaultMode acp={acp} agentId={detected.id} />}

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

      <div className="dwa-form-row" style={{ flexDirection: 'column', gap: 6 }}>
        <span className="dwa-form-label">{acp.label('MCP 服务器（JSON）', 'MCP Servers (JSON)')}</span>
        <textarea
          className="dwa-input dwa-input-mono"
          style={{ minHeight: 96, resize: 'vertical' }}
          aria-label={acp.label('MCP 服务器（JSON）', 'MCP Servers (JSON)')}
          value={form.mcpText}
          onChange={e => patch({ mcpText: e.target.value })}
          spellCheck={false}
          placeholder={'[\n  { "name": "example", "transport": "stdio", "command": "/abs/path/to/server", "args": ["--mcp"] }\n]'}
        />
        {mcpInvalid && (
          <span className="dwa-error">
            {acp.label('必须是一个 JSON 数组；每个条目写明 name 与 transport。', 'Must be a JSON array; every entry needs a name and a transport.')}
          </span>
        )}
        <span className="dwa-hint">
          {acp.label(
            '额外追加给智能体的 MCP 服务器，不影响其已有配置。',
            'Additional MCP servers for the agent; its own configuration is unchanged.',
          )}
        </span>
      </div>
      </div>

      {!advancedOpen && (mcpInvalid || idleInvalid) && <p className="dwa-error" role="alert">{acp.label('请检查「高级」中的无效配置。', 'Check the invalid settings in Advanced.')}</p>}
      {advancedOpen && (!idValid || idTaken || cwdInvalid || rootsInvalid || parsedCommand.command === '') && <p className="dwa-error" role="alert">{acp.label('请检查「连接」中的未完成或无效配置。', 'Check the incomplete or invalid settings in Connection.')}</p>}
      {saveConfirm !== undefined && (
        <div className="dwa-card dwa-card-warn dwa-save-confirm" role="alertdialog" aria-label={acp.label('保存确认', 'Save confirmation')}>
          <div>
            {acp.label(
              `有 ${String(saveConfirm.length)} 个会话正在运行。现在保存会中断这些会话。`,
              `${String(saveConfirm.length)} session(s) are running. Saving now interrupts them.`,
            )}
          </div>
          {saveConfirm.length > 0 && (
            <div className="dwa-hint dwa-mono dwa-save-confirm-sessions">
              {saveConfirm.slice(0, 6).map(view => view.dshSessionId ?? view.sessionId).join('、')}
              {saveConfirm.length > 6 ? '…' : ''}
            </div>
          )}
          <div className="dwa-save-confirm-actions">
            <button type="button" className="dwa-btn dwa-btn-quiet" onClick={onSaveCancel}>
              {acp.label('取消', 'Cancel')}
            </button>
            {canDefer && (
              <button type="button" className="dwa-btn" onClick={onSaveDefer}>
                {acp.label('回合结束后保存', 'Save after turns')}
              </button>
            )}
            <button type="button" className="dwa-btn dwa-btn-danger" onClick={onSaveForce}>
              {acp.label('立即保存（中断该 Agent）', 'Save now (interrupt this agent)')}
            </button>
          </div>
        </div>
      )}

      <div className="dwa-form-actions">
        <span className="dwa-hint">{isConfigured ? dirty ? acp.label('有未保存的更改', 'Unsaved changes') : acp.label('配置已保存', 'Settings saved') : ''}</span>
        {saveDeferred && (
          <>
            <span className="dwa-hint" style={{ color: 'var(--ntr-warn)' }}>
              {acp.label('配置已暂存，回合结束后自动保存。', 'Settings held; they will be saved when the turns end.')}
            </span>
            <span className="dwa-hint" style={{ color: 'var(--ntr-warn)' }}>
              {acp.label(
                '本次保存使用点击时的版本；继续修改表单会取消这次暂存。',
                'This save uses the values from the moment you clicked. Editing the form cancels it.',
              )}
            </span>
          </>
        )}
        {saveNotice !== undefined && (
          <span className="dwa-hint" role="status" style={{ color: 'var(--ntr-warn)' }}>{saveNotice}</span>
        )}
        <button
          className="dwa-btn"
          onClick={onTest}
          disabled={testing || saving || formIncomplete}
          title={acp.label('用当前表单值拉起一次性进程并完成 ACP 握手，不保存配置', 'Spawns a throwaway process from the form values and completes the ACP handshake; nothing is saved')}
        >
          {testing ? acp.label('测试中...', 'Testing...') : acp.label('测试连接', 'Test Connection')}
        </button>

        <button
          className="dwa-btn dwa-btn-primary"
          onClick={onSave}
          disabled={saving || testing || formIncomplete || (isConfigured && !dirty)}
        >
          {saving
            ? acp.label('保存中...', 'Saving...')
            : savedSuccess
              ? acp.label('✓ 已保存', '✓ Saved')
              : isConfigured
                ? acp.label('保存更改', 'Save changes')
                : acp.label('保存并启用', 'Save & Enable')}
        </button>

        {showSaveWarning && (
          <span className="dwa-hint" style={{ color: 'var(--ntr-warn)' }}>
            ⚠ {acp.label('保存会停止该 Agent 进程并中断进行中的会话', 'Saving stops this agent process and interrupts live sessions')}
          </span>
        )}
      </div>

      {testResult !== undefined && (
        <div style={{ marginTop: 8 }}>
          <div
            className="dwa-mono"
            style={{
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: testResult.ok ? 'var(--ntr-success)' : 'var(--ntr-danger)',
            }}
          >
            {testResult.ok ? '✓ ' : '✕ '}{testResult.text}
          </div>
          {/* The sentence that names the mistake, above the raw evidence: the
              host's error text alone reads "ACP connection closed" for every
              kind of spawn failure. Two colours on purpose — the raw line is
              the failure (danger), the hint is advice (warn). */}
          {testResult.hint !== undefined && (
            <div
              className="dwa-hint"
              role="status"
              style={{ marginTop: 4, color: 'var(--ntr-warn)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {testResult.hint}
            </div>
          )}
          {testResult.detail.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {/* Named, because the row above already shows the live process
                  tail: two unnamed stderr blocks in one card read as a
                  duplicate rather than as two different processes. */}
              <span className="dwa-hint">{acp.label('测试进程输出', 'Test process output')}</span>
              <pre className="dwa-stderr" style={{ marginTop: 4 }}>{testResult.detail.join('\n')}</pre>
            </div>
          )}
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
            '聊天使用会话工作区；此处用于直连会话或宿主未提供工作区时。',
            'Chats use their session workspace; this applies to direct sessions or when the host provides no workspace.',
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
