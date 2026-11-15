/**
 * The approval-deadline card: one wait window and one mode, plus the pure
 * helpers that decide the rungs, the readout, and whether anything here is
 * actually outranking the deployment baseline.
 */
import type { AcpStore, UiState } from '../store.ts'
import type { AcpApprovalDeadlines, PermissionTimeoutMode } from '../../protocol.ts'

/**
 * The ONE wait window, as the rungs the slider snaps to.
 *
 * Shortest wait first, and `0` (不等待) FIRST: the slider reads left to right
 * as "wait longer", and "do not wait at all" is the shortest wait there is.
 * Never expiring is NOT on this scale — that is the `wait` MODE's business,
 * and having 「一直等待」 in both places made the card say the same thing twice
 * in two ways.
 *
 * A window the config file names that is not on this ladder (45 seconds, say)
 * still runs as configured: the card prints the exact number and parks the
 * thumb on the nearest rung, so the slider never pretends a number the host
 * is not using.
 */
const DEADLINE_LADDER: readonly number[] = [
  0,
  30_000,
  60_000,
  300_000,
  900_000,
  1_800_000,
  3_600_000,
  21_600_000,
]

/**
 * The shortest REAL wait — the first rung above 不等待.
 *
 * Hand-copied from the host half (`APPROVAL_DEADLINE_MIN_WAIT_MS` in
 * `src/impl.ts`): the browser half may not import the host module, so the
 * equivalence is pinned by a test instead (see `tests/acp-view.spec.ts`).
 */
export const DEADLINE_MIN_WAIT_MS = 30_000

/**
 * The window the card shows under a mode.
 *
 * 不等待 (`0`) is the **auto** mode's rung: it answers with the option the
 * agent's own kinds imply, so the agent CONTINUES. `abort` has no such rung —
 * refusing every ask the instant it arrives stops the agent at every gate it
 * meets, which is not a timeout but a wall. So under `abort` the window floors
 * to the shortest real wait, and the card never shows a zero it cannot run.
 *
 * `undefined` (the `wait` mode) stays undefined: there is no window at all.
 */
export function deadlineValueFor(mode: PermissionTimeoutMode, ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined
  return mode === 'abort' ? Math.max(ms, DEADLINE_MIN_WAIT_MS) : ms
}

/**
 * The rungs a mode offers.
 *
 * 不等待 (`0`) is the **auto** mode's rung: it answers with the option the
 * agent's own kinds imply, so the agent CONTINUES. `abort` has no such rung —
 * refusing every ask the instant it arrives stops the agent at every gate it
 * meets, which is not a timeout but a wall. So `abort` starts at the shortest
 * real wait.
 */
function deadlineLadder(mode: PermissionTimeoutMode): readonly number[] {
  return mode === 'auto' ? DEADLINE_LADDER : DEADLINE_LADDER.filter(ms => ms > 0)
}

/**
 * The rung the slider shows for a window. Exact hits keep their rung; anything
 * else takes the nearest one. A tie goes to the SHORTER wait: the thumb must
 * never promise more patience than the window has.
 */
export function deadlineSliderIndex(ms: number, mode: PermissionTimeoutMode = 'auto'): number {
  const ladder = deadlineLadder(mode)
  const exact = ladder.indexOf(ms)
  if (exact >= 0) return exact
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < ladder.length; i++) {
    const distance = Math.abs(ms - ladder[i])
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/** The three modes, in the order a user reads them: refuse, answer, wait. */
const DEADLINE_MODES: readonly PermissionTimeoutMode[] = ['abort', 'auto', 'wait']

/** `5 分钟` / `30 秒` / `不等待` — the readout and the tick label, one formatter. */
function deadlineText(ms: number, acp: AcpStore): string {
  if (ms <= 0) return acp.label('不等待', 'No wait')
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return acp.label(`${String(seconds)} 秒`, `${String(seconds)}s`)
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return acp.label(`${String(minutes)} 分钟`, `${String(minutes)}m`)
  const hours = Math.round(minutes / 60)
  return acp.label(`${String(hours)} 小时`, `${String(hours)}h`)
}

/** The mode's label — one formatter, so the picker and the override note agree. */
function modeText(mode: PermissionTimeoutMode, acp: AcpStore): string {
  if (mode === 'abort') return acp.label('超时中止', 'Abort')
  if (mode === 'auto') return acp.label('自动推进', 'Auto')
  return acp.label('一直等待', 'Wait')
}

/**
 * The mode block: what happens when nobody answers.
 *
 * Three values and no more — refuse, answer, wait — so the picker is a
 * segmented control, not a dropdown. The buttons stretch across the whole
 * card: a right-aligned segmented control squeezed the labels into two lines
 * each (中/止, 自动推/进), which read as broken rather than as choices.
 *
 * The copy under the buttons says what the SELECTED mode does, in one
 * sentence — the labels alone ("超时中止") cannot. `auto` carries a warning of
 * its own: it approves things nobody looked at.
 */
function DeadlineModeBlock(props: {
  acp: AcpStore
  mode: PermissionTimeoutMode
  /** Set when the deployment baseline is outranked here. */
  override?: string
}) {
  const { acp, mode, override } = props
  const copy = mode === 'wait'
    ? acp.label(
      '一直等待应答，不设超时时间。',
      'Wait until you answer — no deadline.',
    )
    : mode === 'auto'
      ? acp.label(
        '超过设定时间未应答，自动代替你选择一个选项让 agent 继续执行。',
        'Past the deadline, an option is chosen for you and the agent continues.',
      )
      : acp.label(
        '超过设定时间未应答，自动拒绝该操作，agent 继续执行。',
        'Past the deadline, the operation is refused and the agent continues.',
      )
  return (
    <div className="dwa-preference-block">
      <div className="dwa-preference-label">{acp.label('超时处理方式', 'When nobody answers')}</div>
      <div className="dwa-seg dwa-seg-wide">
        {DEADLINE_MODES.map(option => (
          <button
            key={option}
            type="button"
            className={mode === option ? 'is-on' : ''}
            onClick={() => void acp.setApprovalTimeoutMode(option)}
          >
            {modeText(option, acp)}
          </button>
        ))}
      </div>
      <div className="dwa-preference-copy">{copy}</div>
      {mode === 'auto' && (
        <div className="dwa-deadline-warn">
          {acp.label(
            '请确保你的 agent 值得信任，请谨慎选择。',
            'Only pick this if you trust your agent — choose it carefully.',
          )}
        </div>
      )}
      {override !== undefined && (
        <div className="dwa-deadline-flag">⚠ {override}</div>
      )}
    </div>
  )
}

/**
 * The duration block: how long to wait before the deadline fires.
 *
 * ONE slider, because there is ONE window: an ask in the conversation and an
 * ask in the settings ledger are the same question, so they get the same
 * answer. The slider's rungs are the windows people actually pick; a window
 * the config file names outside them still runs as configured (the readout
 * prints the exact number and the thumb parks on the nearest rung).
 *
 * `value === undefined` is the `wait` mode: there is no deadline at all, so
 * the scale has nothing to say — the slider is not drawn, and the readout
 * names the state that is actually in force. The stored window is NOT touched
 * by that (the mode write carries only the mode), so switching back restores
 * it.
 */
function DeadlineSliderBlock(props: {
  acp: AcpStore
  /** undefined in `wait` mode: no window, so no scale. */
  value: number | undefined
  /** The mode the window runs under — it decides which rungs exist. */
  mode: PermissionTimeoutMode
  /** Set when the deployment baseline is outranked here. */
  override?: string
}) {
  const { acp, value, mode, override } = props
  // 不等待 belongs to `auto`. Under `abort` the window floors to the shortest
  // real wait, so the card never shows a zero it cannot run.
  const effective = deadlineValueFor(mode, value)
  const ladder = deadlineLadder(mode)
  const index = effective === undefined ? 0 : deadlineSliderIndex(effective, mode)
  const copy = effective === undefined
    ? acp.label(
      '选择「一直等待」时不设超时时长。',
      '“Wait” sets no deadline.',
    )
    : effective <= 0
      ? acp.label(
        '不设等待时间，请求到达即按上方所选的方式处理。',
        'No wait: the ask is settled on arrival, by whatever you picked above.',
      )
      : acp.label(
        '超过该时长仍未应答，将按上方所选的方式处理。',
        'Past this, whatever you picked above is what happens.',
      )
  return (
    <div className="dwa-preference-block">
      <div className="dwa-preference-label">{acp.label('等待时长', 'How long to wait')}</div>
      <div className="dwa-deadline-value">
        {effective === undefined ? acp.label('一直等待', 'Always') : deadlineText(effective, acp)}
      </div>
      {effective !== undefined && (
        <>
          <input
            className="dwa-deadline-range"
            type="range"
            min={0}
            max={ladder.length - 1}
            step={1}
            value={index}
            aria-label={acp.label('等待时长', 'How long to wait')}
            onChange={event => {
              const next = ladder[Number(event.target.value)]
              if (next !== undefined && next !== effective) void acp.setApprovalDeadline(next)
            }}
          />
          <div className="dwa-deadline-ticks">
            {ladder.map(rung => (
              <span key={rung}>{deadlineText(rung, acp)}</span>
            ))}
          </div>
        </>
      )}
      <div className="dwa-preference-copy">{copy}</div>
      {override !== undefined && (
        <div className="dwa-deadline-flag">⚠ {override}</div>
      )}
    </div>
  )
}

/**
 * The facts the card has to show, decided from what the host reported.
 *
 * The card carries TWO controls, and they are orthogonal: one window (how
 * long) and one mode (what happens). An override can sit on either of them,
 * so each is decided on its own.
 *
 * `overridden` is what gates the reset button. A baseline that AGREES with the
 * running value is not an override, and offering a reset for it would be a
 * button that does nothing (observed live).
 */
export function approvalDeadlineFacts(deadlines: AcpApprovalDeadlines): {
  /** The config-file window the card's window outranks — undefined when
   *  nothing is being outranked. */
  baseline: number | undefined
  /** The config-file mode the card's mode outranks, when it differs. */
  modeBaseline: PermissionTimeoutMode | undefined
  /** A reset is only honest when something is actually being outranked. */
  overridden: boolean
} {
  const configured = deadlines.configured?.permissionTimeoutMs
  const baseline = configured === undefined || configured === deadlines.permissionTimeoutMs
    ? undefined
    : configured
  const modeBaseline = deadlines.configuredMode !== undefined && deadlines.configuredMode !== deadlines.mode
    ? deadlines.configuredMode
    : undefined
  return {
    baseline,
    modeBaseline,
    overridden: baseline !== undefined || modeBaseline !== undefined,
  }
}

/**
 * The approval-deadline card.
 *
 * TWO controls, and they are orthogonal: one window (how long) and one mode
 * (what happens). One window covers both places an ask can wait — the
 * conversation's approval card and the settings panel's ledger — because they
 * ask the same question and the answer should not differ by where the card
 * happens to be drawn.
 *
 * The two controls are ONE system, and the card says so in a sentence: the
 * window says how long to wait, the mode says what happens when nobody
 * answered. That sentence is the thing the previous three-row layout kept
 * missing.
 *
 * The facts that make a number here meaningless are shown, not swallowed: the
 * deployment baseline this card outranks. Each rides on the control it belongs
 * to, and the reset button appears only when something is actually being
 * outranked.
 */
export function ApprovalDeadlinesCard(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const deadlines = ui.approvalDeadlines
  // Older host half: no card rather than a number this browser invented.
  if (deadlines === undefined) return null
  const facts = approvalDeadlineFacts(deadlines)
  const baselineNote = facts.baseline === undefined
    ? undefined
    : acp.label(
      `配置文件（cordis.patch.yml）设为 ${deadlineText(facts.baseline, acp)}，此处设置优先。`,
      `The config file (cordis.patch.yml) asks for ${deadlineText(facts.baseline, acp)}; the value set here wins.`,
    )
  const modeNote = facts.modeBaseline === undefined
    ? undefined
    : acp.label(
      `配置文件（cordis.patch.yml）设为「${modeText(facts.modeBaseline, acp)}」，此处设置优先。`,
      `The config file (cordis.patch.yml) asks for "${modeText(facts.modeBaseline, acp)}"; the value set here wins.`,
    )
  // In `wait` mode there is no deadline at all, so the slider shows the one
  // thing that is true: no deadline.
  const waitMode = deadlines.mode === 'wait'
  return (
    <section className="dwa-section">
      <div className="dwa-section-heading">
        <div>
          <h3 className="dwa-section-title">{acp.label('审批时限', 'Approval deadlines')}</h3>
          <p className="dwa-section-copy">
            {acp.label(
              '权限请求的等待时长与超时处理方式。',
              'How long to wait for a permission request, and what happens when nobody answers.',
            )}
          </p>
        </div>
      </div>
      <div className="dwa-preferences">
        <DeadlineModeBlock acp={acp} mode={deadlines.mode} override={modeNote} />
        <DeadlineSliderBlock
          acp={acp}
          value={waitMode ? undefined : deadlines.permissionTimeoutMs}
          mode={deadlines.mode}
          override={baselineNote}
        />
        {facts.overridden && (
          <div className="dwa-deadline-reset">
            <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => void acp.resetApprovalDeadlines()}>
              {acp.label('恢复配置文件的值', 'Use config file value')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
