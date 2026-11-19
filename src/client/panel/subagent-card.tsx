/**
 * The subagent card: the `acp_delegate` tool's deployment-wide parameters —
 * one guidance rung that doubles as the registration switch, the delegation's
 * OWN permission policy, one timeout window and one folded-answer cap.
 *
 * ONE ladder per knob, shared with the host half ({@link DELEGATE_GUIDANCE},
 * {@link DELEGATE_TIMEOUT_MS}, {@link DELEGATE_OUTPUT_CHARS}): every rung a
 * slider can produce is a value the host runs. A numeric value the deployment
 * named off its ladder still runs as configured — the readout prints the exact
 * number and the thumb parks on the nearest rung (the IdleReleaseCard rule).
 *
 * Writes are immediate RPCs (never an `agent/save` form): the store moves the
 * picked key optimistically, adopts the host answer as the authority, and
 * reverts on a failure. Each row carries its own override fact and its own
 * reset, which appears only when something is really overridden.
 *
 * Colors follow constraint 34 through host alias tokens. The host theme has
 * no `state-warning-*` / `state-danger-*` family (verified against the shipped
 * theme): the warning rung uses `state-warn-primary` on `state-warn-tertiary`,
 * the force rung `state-error-primary` on `interactive-bg-hover-danger` — the
 * host's own danger background. Literals sit only in `var()` fallbacks.
 */
import { DELEGATE_GUIDANCE, DELEGATE_OUTPUT_CHARS, DELEGATE_TIMEOUT_MS } from '../../protocol.ts'
import type { AcpDelegateSettings, DelegateGuidance, DelegatePermissionMode, DelegateSettingKey } from '../../protocol.ts'
import type { AcpStore, UiState } from '../store.ts'
import { DELEGATE_DEFAULTS } from '../store/settings.ts'

/** The permission rungs, in the order a user reads them: answer, refuse, ask. */
const DELEGATE_PERMISSION_MODES: readonly DelegatePermissionMode[] = ['auto', 'abort', 'ask']

/** The guidance rung's label — one formatter, so readout, ticks and notes agree. */
function guidanceText(guidance: DelegateGuidance, acp: AcpStore): string {
  if (guidance === 'off') return acp.label('关闭', 'Off')
  if (guidance === 'on') return acp.label('开启', 'On')
  if (guidance === 'enhanced') return acp.label('引导增强', 'Enhanced')
  return acp.label('强制模式', 'Force')
}

/** The permission rung's label. */
function permissionText(mode: DelegatePermissionMode, acp: AcpStore): string {
  if (mode === 'auto') return acp.label('自动代答', 'Auto-answer')
  if (mode === 'abort') return acp.label('直接拒绝', 'Refuse')
  return acp.label('人工确认', 'Ask me')
}

/**
 * `10 分钟` / `1 小时` / `45 秒` — the readout and the tick label, one
 * formatter. Exact at every value: an off-ladder window prints its real
 * number (down to the second) instead of rounding to a rung it is not.
 */
function delegateTimeoutText(ms: number, acp: AcpStore): string {
  if (ms % 3_600_000 === 0) return acp.label(`${String(ms / 3_600_000)} 小时`, `${String(ms / 3_600_000)}h`)
  if (ms % 60_000 === 0) return acp.label(`${String(ms / 60_000)} 分钟`, `${String(ms / 60_000)}m`)
  return acp.label(`${String(ms / 1000)} 秒`, `${String(ms / 1000)}s`)
}

/** `4 千字符` / `2 万字符` / `12345 字符` — exact at every value, same rule. */
function delegateCharsText(chars: number, acp: AcpStore): string {
  if (chars % 10_000 === 0) return acp.label(`${String(chars / 10_000)} 万字符`, `${String(chars / 1000)}k chars`)
  if (chars % 1000 === 0) return acp.label(`${String(chars / 1000)} 千字符`, `${String(chars / 1000)}k chars`)
  return acp.label(`${String(chars)} 字符`, `${String(chars)} chars`)
}

/**
 * The rung nearest a value that is not on the ladder — used only to park the
 * thumb; the readout always prints the exact value. A tie goes to the first
 * (smaller) rung, the same rule nearestIdleRung keeps.
 */
function nearestDelegateRung(ladder: readonly number[], value: number): number {
  let best = ladder[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const rung of ladder) {
    const distance = Math.abs(rung - value)
    if (distance < bestDistance) {
      bestDistance = distance
      best = rung
    }
  }
  return best
}

/**
 * The config-file fact worth saying on a row: only when the deployment named
 * a value AND the running value outranks it — otherwise the file's value IS
 * what runs, and naming it would claim a win nobody claimed.
 */
function delegateOverrideNote<K extends DelegateSettingKey>(
  delegate: AcpDelegateSettings,
  key: K,
  text: (value: AcpDelegateSettings[K]) => string,
  acp: AcpStore,
): string | undefined {
  const configured = delegate.configured?.[key]
  if (configured === undefined || configured === delegate[key]) return undefined
  return acp.label(`配置文件要求：${text(configured)}`, `The config file asks for ${text(configured)}.`)
}

/**
 * A row's reset — only when the running value really differs from the
 * baseline it would return to (the config file's value, else the built-in
 * default). A baseline that agrees with the running value is not an override,
 * and a reset for it would be a button that does nothing.
 */
function DelegateReset(props: { acp: AcpStore; delegate: AcpDelegateSettings; setting: DelegateSettingKey }) {
  const { acp, delegate, setting } = props
  const configured = delegate.configured?.[setting]
  const baseline = configured ?? DELEGATE_DEFAULTS[setting]
  if (delegate[setting] === baseline) return null
  return (
    <div className="dwa-deadline-reset">
      <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => void acp.resetDelegateSetting(setting)}>
        {configured === undefined
          ? acp.label('恢复默认值', 'Restore default')
          : acp.label('恢复配置文件的值', 'Use config file value')}
      </button>
    </div>
  )
}

/**
 * One numeric ladder slider: the exact readout, the thumb (parked on the
 * nearest rung when the value is off the ladder) and the tick labels.
 */
function DelegateNumberSlider(props: {
  name: string
  value: number
  ladder: readonly number[]
  text: (value: number) => string
  onPick: (value: number) => void
}) {
  const { name, value, ladder, text, onPick } = props
  const index = ladder.indexOf(value)
  const shown = index >= 0 ? value : nearestDelegateRung(ladder, value)
  return (
    <>
      <div className="dwa-deadline-value">{text(value)}</div>
      <input
        className="dwa-deadline-range"
        type="range"
        min={0}
        max={ladder.length - 1}
        step={1}
        value={index >= 0 ? index : ladder.indexOf(shown)}
        aria-label={name}
        onChange={event => {
          const next = ladder[Number(event.target.value)]
          if (next !== undefined && next !== value) onPick(next)
        }}
      />
      <div className="dwa-deadline-ticks">
        {ladder.map(rung => (
          <span key={rung}>{text(rung)}</span>
        ))}
      </div>
    </>
  )
}

/**
 * The subagent card. Four rows, one sentence each; the guidance rung carries
 * its per-rung note (enhanced warns, force warns harder) and the availability
 * facts the host reported, so a switch that cannot take effect says so instead
 * of pretending the request header changed.
 */
export function SubagentCard(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const delegate = ui.delegate
  // Older host half: no card rather than a number this browser invented.
  if (delegate === undefined) return null
  const guidanceNote = delegateOverrideNote(delegate, 'guidance', value => guidanceText(value, acp), acp)
  const permissionNote = delegateOverrideNote(delegate, 'permissionMode', value => permissionText(value, acp), acp)
  const timeoutNote = delegateOverrideNote(delegate, 'timeoutMs', value => delegateTimeoutText(value, acp), acp)
  const charsNote = delegateOverrideNote(delegate, 'maxOutputChars', value => delegateCharsText(value, acp), acp)
  return (
    <section className="dwa-section">
      <div className="dwa-section-heading">
        <div>
          <h3 className="dwa-section-title">{acp.label('子代理', 'Subagents')}</h3>
          <p className="dwa-section-copy">
            {acp.label('把任务委派给已接入的 ACP agent。', 'Delegate tasks to your connected ACP agents.')}
          </p>
        </div>
      </div>
      <div className="dwa-preferences">
        <div className="dwa-preference-block">
          <div className="dwa-preference-label">{acp.label('子代理委派', 'Delegation')}</div>
          <div className="dwa-deadline-value">{guidanceText(delegate.guidance, acp)}</div>
          <input
            className="dwa-deadline-range"
            type="range"
            min={0}
            max={DELEGATE_GUIDANCE.length - 1}
            step={1}
            value={DELEGATE_GUIDANCE.indexOf(delegate.guidance)}
            aria-label={acp.label('子代理委派', 'Delegation')}
            onChange={event => {
              const next = DELEGATE_GUIDANCE[Number(event.target.value)]
              if (next !== undefined && next !== delegate.guidance) void acp.setDelegateSettings({ guidance: next })
            }}
          />
          <div className="dwa-deadline-ticks">
            {DELEGATE_GUIDANCE.map(rung => (
              <span key={rung}>{guidanceText(rung, acp)}</span>
            ))}
          </div>
          <div className="dwa-preference-copy">
            {acp.label(
              '关闭 = 不注册本工具；其余档位决定引导强度，下一轮对话生效。',
              'Off = the tool is not registered; the other rungs set guidance strength, effective next turn.',
            )}
          </div>
          {delegate.guidance === 'enhanced' && (
            <div
              className="dwa-deadline-warn"
              style={{
                color: 'var(--dsw-alias-state-warn-primary, #b45309)',
                background: 'var(--dsw-alias-state-warn-tertiary, #fffbeb)',
              }}
            >
              {acp.label(
                '该档位会增强工具描述，引导大模型优先使用本工具。',
                'This rung strengthens the tool description, steering the model to prefer this tool.',
              )}
            </div>
          )}
          {delegate.guidance === 'force' && (
            <div
              className="dwa-deadline-warn"
              style={{
                color: 'var(--dsw-alias-state-error-primary, #dc2626)',
                background: 'var(--dsw-alias-interactive-bg-hover-danger, #fee2e2)',
                borderLeftColor: 'var(--dsw-alias-state-error-primary, #dc2626)',
              }}
            >
              {acp.label(
                '强制模式会屏蔽 DSH 的原生 subagent 能力，请谨慎开启。',
                'Force mode masks DSH’s native subagent tools — enable it with care.',
              )}
            </div>
          )}
          {!delegate.toolAvailable && (
            <div className="dwa-deadline-flag">⚠ {acp.label('宿主未提供工具服务，此开关暂不生效', 'The host offers no tool service; this switch has no effect yet.')}</div>
          )}
          {!delegate.restrictAvailable && delegate.guidance === 'force' && (
            <div className="dwa-deadline-flag">⚠ {acp.label('宿主未提供工具遮蔽服务，强制模式暂按引导增强生效', 'The host offers no tool masking; force mode acts as enhanced for now.')}</div>
          )}
          {guidanceNote !== undefined && <div className="dwa-deadline-flag">⚠ {guidanceNote}</div>}
          <DelegateReset acp={acp} delegate={delegate} setting="guidance" />
        </div>
        <div className="dwa-preference-block">
          <div className="dwa-preference-label">{acp.label('权限', 'Permissions')}</div>
          <div className="dwa-seg dwa-seg-wide">
            {DELEGATE_PERMISSION_MODES.map(option => (
              <button
                key={option}
                type="button"
                className={delegate.permissionMode === option ? 'is-on' : ''}
                onClick={() => void acp.setDelegateSettings({ permissionMode: option })}
              >
                {permissionText(option, acp)}
              </button>
            ))}
          </div>
          <div className="dwa-preference-copy">
            {acp.label('委派期间的审批请求如何作答。', 'How permission asks inside a delegation are answered.')}
          </div>
          {permissionNote !== undefined && <div className="dwa-deadline-flag">⚠ {permissionNote}</div>}
          <DelegateReset acp={acp} delegate={delegate} setting="permissionMode" />
        </div>
        <div className="dwa-preference-block">
          <div className="dwa-preference-label">{acp.label('单次时限', 'Time limit')}</div>
          <DelegateNumberSlider
            name={acp.label('单次时限', 'Time limit')}
            value={delegate.timeoutMs}
            ladder={DELEGATE_TIMEOUT_MS}
            text={ms => delegateTimeoutText(ms, acp)}
            onPick={ms => void acp.setDelegateSettings({ timeoutMs: ms })}
          />
          <div className="dwa-preference-copy">
            {acp.label('超时后中止子代理并报错。', 'Past this, the subagent is aborted and the call errors.')}
          </div>
          {timeoutNote !== undefined && <div className="dwa-deadline-flag">⚠ {timeoutNote}</div>}
          <DelegateReset acp={acp} delegate={delegate} setting="timeoutMs" />
        </div>
        <div className="dwa-preference-block">
          <div className="dwa-preference-label">{acp.label('返回上限', 'Answer cap')}</div>
          <DelegateNumberSlider
            name={acp.label('返回上限', 'Answer cap')}
            value={delegate.maxOutputChars}
            ladder={DELEGATE_OUTPUT_CHARS}
            text={chars => delegateCharsText(chars, acp)}
            onPick={chars => void acp.setDelegateSettings({ maxOutputChars: chars })}
          />
          <div className="dwa-preference-copy">
            {acp.label('超出部分截断并留标记。', 'Anything beyond the cap is truncated with a marker.')}
          </div>
          {charsNote !== undefined && <div className="dwa-deadline-flag">⚠ {charsNote}</div>}
          <DelegateReset acp={acp} delegate={delegate} setting="maxOutputChars" />
        </div>
      </div>
    </section>
  )
}