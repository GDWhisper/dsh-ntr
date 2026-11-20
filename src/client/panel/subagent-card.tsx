/**
 * The subagent card: the `acp_delegate` tool's deployment-wide parameters —
 * one guidance rung that doubles as the registration switch, and one
 * single-delegation silence window (activity renews it; only silence aborts).
 * The delegation's session permission policy
 * is always auto-answer (there is no knob for it here); the main conversation's
 * approval settings are untouched.
 *
 * The guidance rung is a shared ladder ({@link DELEGATE_GUIDANCE}): every rung
 * the slider offers is a value the host runs. The timeout is a hand-filled
 * MINUTE input (no ladder): the readout prints the exact window in force — an
 * off-grid value is never rounded to a lie — and a commit writes
 * `round(minutes * 60000)` only within [1000, 86400000] ms. Its reset button
 * mirrors the IdleReleaseCard rule: it appears only when the window really
 * overrides the host-reported `defaultTimeoutMs` — an older host half that
 * reports no baseline gets no reset (nothing to invent one from).
 *
 * Writes are immediate RPCs (never an `agent/save` form): the store moves the
 * picked key optimistically, adopts the host answer as the authority, and
 * reverts on a failure. Each row carries its own override fact.
 * The guidance row's hint is per-rung ({@link guidanceHint}): off and on a
 * banner in the warn-box shape (neutral primary-label fact / success-green
 * confirmation); enhanced/force only their own warn boxes.
 *
 * Colors follow constraint 34 through host alias tokens. The host theme has
 * no `state-warning-*` / `state-danger-*` family (verified against the shipped
 * theme): the warning rung uses `state-warn-primary` on `state-warn-tertiary`,
 * the force rung `state-error-primary` on `interactive-bg-hover-danger` — the
 * host's own danger background. Literals sit only in `var()` fallbacks.
 */
import { useEffect, useState } from 'react'
import { DELEGATE_GUIDANCE, DELEGATE_TIMEOUT_MAX_MS, DELEGATE_TIMEOUT_MIN_MS } from '../../protocol.ts'
import type { AcpDelegateSettings, DelegateGuidance, DelegateSettingKey } from '../../protocol.ts'
import type { AcpStore, UiState } from '../store.ts'
import { tickLeft } from './shared.ts'

/** The guidance rung's label — one formatter, so readout, ticks and notes agree. */
function guidanceText(guidance: DelegateGuidance, acp: AcpStore): string {
  if (guidance === 'off') return acp.label('关闭', 'Off')
  if (guidance === 'on') return acp.label('开启', 'On')
  if (guidance === 'enhanced') return acp.label('引导增强', 'Enhanced')
  return acp.label('强制模式', 'Force')
}

/**
 * `40 分钟` / `1 小时` / `45 秒` — the exact readout, one formatter. Exact at
 * every value: an off-grid window prints its real number (down to the second)
 * instead of rounding to a value it is not.
 */
function delegateTimeoutText(ms: number, acp: AcpStore): string {
  if (ms % 3_600_000 === 0) return acp.label(`${String(ms / 3_600_000)} 小时`, `${String(ms / 3_600_000)}h`)
  if (ms % 60_000 === 0) return acp.label(`${String(ms / 60_000)} 分钟`, `${String(ms / 60_000)}m`)
  return acp.label(`${String(ms / 1000)} 秒`, `${String(ms / 1000)}s`)
}

/**
 * The minute input's display value: `ms / 60000` exactly, with no trailing
 * zeros (JS number-to-string strips them). An off-grid window keeps its exact
 * fractional minutes rather than rounding to a lie.
 */
function minutesText(ms: number): string {
  return String(ms / 60_000)
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
 * The guidance row's hint, per rung. `off` and `on` render as the same banner
 * shape as the per-rung warnings (`.dwa-deadline-warn`: tinted background,
 * colored left border): off a neutral fact in the primary label color on a
 * layer background, on a success-green confirmation that the tool registers
 * next turn. enhanced / force return undefined — their warn boxes below are
 * the only note. Colors are host alias tokens only (constraint 34,
 * state-*-primary foreground on state-*-tertiary background); literals sit in
 * the var() fallbacks.
 */
function guidanceHint(guidance: DelegateGuidance, acp: AcpStore): {
  text: string
  box: { color: string; background: string; borderLeftColor: string }
} | undefined {
  if (guidance === 'off') return {
    text: acp.label(
      '子代理功能关闭，当前NTR不作为原生dsh的子代理工具',
      'Subagents are off; NTR does not act as a native DSH subagent tool.',
    ),
    box: {
      color: 'var(--dsw-alias-label-primary, #111827)',
      background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
      borderLeftColor: 'var(--dsw-alias-label-primary, #111827)',
    },
  }
  if (guidance === 'on') return {
    text: acp.label(
      'NTR将作为子代理工具注册进原生dsh会话中，下一轮对话生效',
      'NTR registers as a subagent tool in native DSH sessions, effective next turn.',
    ),
    box: {
      color: 'var(--dsw-alias-state-success-primary, #16a34a)',
      background: 'var(--dsw-alias-state-success-tertiary, #dcfce7)',
      borderLeftColor: 'var(--dsw-alias-state-success-primary, #16a34a)',
    },
  }
  return undefined
}

/**
 * The single-delegation silence window as a hand-filled MINUTE input. The display value
 * is the exact `ms / 60000` (no trailing zeros); a commit (blur or Enter) writes
 * `round(minutes * 60000)` only when it lands in [1000, 86400000] ms — an
 * empty, non-numeric or out-of-range draft snaps back to the value in force.
 * The draft re-syncs whenever the authoritative window changes (host answer /
 * reset), so the input never claims a number that is not running.
 */
function DelegateTimeoutInput(props: { ms: number; name: string; onCommit: (ms: number) => void }) {
  const { ms, name, onCommit } = props
  const [draft, setDraft] = useState(() => minutesText(ms))
  useEffect(() => { setDraft(minutesText(ms)) }, [ms])
  const commit = () => {
    const minutes = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(minutes)) { setDraft(minutesText(ms)); return }
    const next = Math.round(minutes * 60_000)
    if (next < DELEGATE_TIMEOUT_MIN_MS || next > DELEGATE_TIMEOUT_MAX_MS || next === ms) { setDraft(minutesText(ms)); return }
    onCommit(next)
  }
  return (
    <input
      className="dwa-input"
      type="number"
      step="any"
      value={draft}
      aria-label={name}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') commit() }}
    />
  )
}

/**
 * The subagent card. Two rows, one sentence each; the guidance rung carries
 * its per-rung note (enhanced warns, force warns harder) and the availability
 * facts the host reported, so a switch that cannot take effect says so instead
 * of pretending the request header changed. The timeout row offers a reset
 * only when the window really overrides the baseline.
 */
export function SubagentCard(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const delegate = ui.delegate
  // Older host half: no card rather than a number this browser invented.
  if (delegate === undefined) return null
  const guidanceNote = delegateOverrideNote(delegate, 'guidance', value => guidanceText(value, acp), acp)
  const timeoutNote = delegateOverrideNote(delegate, 'timeoutMs', value => delegateTimeoutText(value, acp), acp)
  const hint = guidanceHint(delegate.guidance, acp)
  // A reset is only honest when something is actually being overridden — the
  // same rule the idle-release card keeps (baseline = host defaultTimeoutMs).
  // An older host half reports no defaultTimeoutMs: there is no baseline to
  // compare against, so no reset appears rather than a fabricated one.
  const overridden = delegate.defaultTimeoutMs !== undefined && delegate.timeoutMs !== delegate.defaultTimeoutMs
  const resetLabel = delegate.configured?.timeoutMs === undefined
    ? acp.label('恢复默认值', 'Restore default')
    : acp.label('恢复配置文件的值', 'Use config file value')
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
            {DELEGATE_GUIDANCE.map((rung, i) => (
              <span key={rung} style={{ left: tickLeft(i, DELEGATE_GUIDANCE.length) }}>{guidanceText(rung, acp)}</span>
            ))}
          </div>
          {hint !== undefined && (
            <div className="dwa-deadline-warn" style={hint.box}>{hint.text}</div>
          )}
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
        </div>
        <div className="dwa-preference-block">
          <div className="dwa-preference-label">{acp.label('单次时限', 'Time limit')}</div>
          <div className="dwa-deadline-value">{delegateTimeoutText(delegate.timeoutMs, acp)}</div>
          <DelegateTimeoutInput
            ms={delegate.timeoutMs}
            name={acp.label('单次时限', 'Time limit')}
            onCommit={ms => void acp.setDelegateSettings({ timeoutMs: ms })}
          />
          <div className="dwa-preference-copy">
            {acp.label(
              '持续无新产出达到该时长即中止并报错；默认跟随全局，可手填覆盖。',
              'Aborts and errors after this much silence with no new output; defaults to the global window, hand-fill to override.',
            )}
          </div>
          {timeoutNote !== undefined && <div className="dwa-deadline-flag">⚠ {timeoutNote}</div>}
          {overridden && (
            <div className="dwa-deadline-reset">
              <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => void acp.resetDelegateSetting('timeoutMs')}>
                {resetLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}