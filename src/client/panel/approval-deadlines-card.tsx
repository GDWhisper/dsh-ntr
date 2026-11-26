/**
 * The approval-deadline card: one wait window and one mode, plus the pure
 * helpers that decide the rungs, the readout, and whether anything here is
 * actually outranking the deployment baseline.
 */
import type { AcpStore, UiState } from '../store.ts'
import { tickLeft } from './shared.ts'
import type { AcpApprovalDeadlines, PermissionTimeoutMode, QuestionTimeoutMode } from '../../protocol.ts'

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
function deadlineText(ms: number, acp: AcpStore, zeroLabel?: [string, string]): string {
  if (ms <= 0) return zeroLabel === undefined ? acp.label('不等待', 'No wait') : acp.label(zeroLabel[0], zeroLabel[1])
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
      <div className="dwa-preference-label">
        {acp.label('等待时长', 'How long to wait')}
        <span className="dwa-deadline-value">
          {effective === undefined ? acp.label('一直等待', 'Always') : deadlineText(effective, acp)}
        </span>
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
            {ladder.map((rung, i) => (
              <span key={rung} style={{ left: tickLeft(i, ladder.length) }}>{deadlineText(rung, acp)}</span>
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

function elicitationText(ms: number, acp: AcpStore): string {
  return deadlineText(ms, acp, ['不设限', 'No limit'])
}

/**
 * What an expired QUESTION ask does. Two rungs, because a question has no
 * `abort` / `auto` / `wait` axis: the plugin either answers for the user or it
 * does not. ACP declares no recommended option, so the second rung says what it
 * actually sends — the first option — instead of promising a recommendation.
 */
function QuestionExpiryBlock(props: {
  acp: AcpStore
  mode: QuestionTimeoutMode
  /** The form-question window in force; `0` means no deadline, so nothing fires. */
  windowMs: number
}) {
  const { acp, mode, windowMs } = props
  const copy = mode === 'first'
    ? acp.label(
      '超过时限未回答，自动发送第一个选项。',
      'Past the deadline, the first option is sent for you.',
    )
    : acp.label(
      '超过时限未回答，提问将被取消，不会替你选择。',
      'Past the deadline, the question is cancelled — nothing is chosen for you.',
    )
  return (
    <div className="dwa-preference-block">
      <div className="dwa-preference-label">{acp.label('提问到期处理', 'When a question expires')}</div>
      <div className="dwa-seg dwa-seg-wide">
        {(['cancel', 'first'] as const).map(option => (
          <button
            key={option}
            type="button"
            className={mode === option ? 'is-on' : ''}
            onClick={() => void acp.setQuestionTimeoutMode(option)}
          >
            {option === 'cancel' ? acp.label('到期取消', 'Cancel') : acp.label('自动选第一项', 'Pick first')}
          </button>
        ))}
      </div>
      <div className="dwa-preference-copy">{copy}</div>
      {mode === 'first' && windowMs === 0 && (
        <div className="dwa-deadline-warn">
          {acp.label('时限为「不设限」，自动选择不会触发。', 'The window is “no limit”, so nothing will be picked.')}
        </div>
      )}
    </div>
  )
}

/** The form-question deadline shares the rungs, but zero means "no deadline". */
function ElicitationDeadlineBlock(props: { acp: AcpStore; value: number; override?: string }) {
  const { acp, value, override } = props
  const index = deadlineSliderIndex(value)
  return (
    <div className="dwa-preference-block">
      <div className="dwa-preference-label">
        {acp.label('表单提问时限', 'Form question deadline')}
        <span className="dwa-deadline-value">{elicitationText(value, acp)}</span>
      </div>
      <input
        className="dwa-deadline-range"
        type="range"
        min={0}
        max={DEADLINE_LADDER.length - 1}
        step={1}
        value={index}
        aria-label={acp.label('表单提问时限', 'Form question deadline')}
        onChange={event => {
          const next = DEADLINE_LADDER[Number(event.target.value)]
          if (next !== undefined && next !== value) void acp.setElicitationDeadline(next)
        }}
      />
      <div className="dwa-deadline-ticks">
        {DEADLINE_LADDER.map((rung, i) => (
          <span key={rung} style={{ left: tickLeft(i, DEADLINE_LADDER.length) }}>{elicitationText(rung, acp)}</span>
        ))}
      </div>
      <div className="dwa-preference-copy">
        {value === 0
          ? acp.label('表单提问将一直等待，直到提交、跳过或取消。', 'Form questions wait until you submit, decline, or cancel.')
          : acp.label('超过该时长仍未提交，表单提问将自动取消。', 'Unsubmitted form questions are cancelled after this window.')}
      </div>
      {override !== undefined && (
        <div className="dwa-deadline-flag">⚠ {override}</div>
      )}
    </div>
  )
}

/**
 * The facts the card has to show, decided from what the host reported.
 *
 * The card carries FOUR controls: the approval window (how long), the approval
 * mode (what happens), the independent form-question window, and what an
 * expired question does. An override can sit on any of them, so each is decided
 * on its own.
 *
 * `overridden` is what gates the reset button. A baseline that AGREES with the
 * running value is not an override, and offering a reset for it would be a
 * button that does nothing (observed live).
 */
export function approvalDeadlineFacts(deadlines: AcpApprovalDeadlines): {
  /** The config-file window the card's window outranks — undefined when
   *  nothing is being outranked. */
  baseline: number | undefined
  /** The config-file form-question window this card outranks, when it differs. */
  elicitationBaseline: number | undefined
  /** The config-file mode the card's mode outranks, when it differs. */
  modeBaseline: PermissionTimeoutMode | undefined
  /** Built-in baseline (`cancel`) outranked when `questionTimeoutMode` is `first`. */
  questionModeBaseline: QuestionTimeoutMode | undefined
  /** A reset is only honest when something is actually being outranked. */
  overridden: boolean
} {
  const configured = deadlines.configured?.permissionTimeoutMs
  const baseline = configured === undefined || configured === deadlines.permissionTimeoutMs
    ? undefined
    : configured
  const configuredElicitation = deadlines.configured?.elicitationTimeoutMs
  const elicitationBaseline = configuredElicitation === undefined || configuredElicitation === deadlines.elicitationTimeoutMs
    ? undefined
    : configuredElicitation
  const modeBaseline = deadlines.configuredMode !== undefined && deadlines.configuredMode !== deadlines.mode
    ? deadlines.configuredMode
    : undefined
  const questionModeBaseline = deadlines.questionTimeoutMode !== undefined && deadlines.questionTimeoutMode !== 'cancel'
    ? ('cancel' as const)
    : undefined
  return {
    baseline,
    elicitationBaseline,
    modeBaseline,
    questionModeBaseline,
    overridden: baseline !== undefined
      || elicitationBaseline !== undefined
      || modeBaseline !== undefined
      || questionModeBaseline !== undefined,
  }
}

/**
 * The approval-deadline card.
 *
 * FOUR controls: the approval window (how long), the approval mode (what
 * happens), the independent form-question window, and what an expired
 * question does. One approval window covers both places an ask can wait — the
 * conversation's approval card and the settings panel's ledger — because they
 * ask the same question and the answer should not differ by where the card
 * happens to be drawn. Form questions stay independent: expiry always cancels,
 * so there is no mode; question-shaped permission asks use that same window
 * with their own two-way expiry axis.
 *
 * The approval controls are ONE system, and the card says so in a sentence:
 * the window says how long to wait, the mode says what happens when nobody
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
  const elicitationNote = facts.elicitationBaseline === undefined
    ? undefined
    : acp.label(
      `配置文件（cordis.patch.yml）设为 ${elicitationText(facts.elicitationBaseline, acp)}，此处设置优先。`,
      `The config file (cordis.patch.yml) asks for ${elicitationText(facts.elicitationBaseline, acp)}; the value set here wins.`,
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
              '权限请求与表单提问的等待时长，以及权限超时后的处理方式。',
              'How long to wait for permission requests and form questions, and what happens when a permission ask expires.',
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
        {deadlines.elicitationTimeoutMs !== undefined && (
          <ElicitationDeadlineBlock acp={acp} value={deadlines.elicitationTimeoutMs} override={elicitationNote} />
        )}
        {deadlines.elicitationTimeoutMs !== undefined && deadlines.questionTimeoutMode !== undefined && (
          <QuestionExpiryBlock
            acp={acp}
            mode={deadlines.questionTimeoutMode}
            windowMs={deadlines.elicitationTimeoutMs}
          />
        )}
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
