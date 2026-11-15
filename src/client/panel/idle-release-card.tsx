/**
 * The idle-release card: the one window a chat process may sit idle before it is
 * parked, on the ladder the host can actually run.
 */
import { IDLE_RELEASE_MS } from '../../protocol.ts'
import type { AcpStore, UiState } from '../store.ts'

/**
 * The idle-release window, as the settings page edits it.
 *
 * ONE control, because there is ONE window: how long a chat process may sit
 * idle before it is parked. The slider snaps to the shared ladder
 * ({@link IDLE_RELEASE_MS}), so every rung it offers is a window the host can
 * run.
 *
 * The card reports the deployment baseline as the fact being overridden, and
 * offers a reset ONLY when something is really overridden — the same rule the
 * approval deadline card follows.
 */
export function IdleReleaseCard(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const release = ui.idleRelease
  // Older host half: no card rather than a number this browser invented.
  if (release === undefined) return null
  // The value a RESET returns to: the window `cordis.patch.yml` names, else
  // the built-in default. The same split the approval card keeps — the
  // reset must restore what the deployment asked for, not a constant.
  const baseline = release.defaultIdleTimeoutMs
  // A reset is only honest when something is actually being overridden.
  const overridden = release.idleTimeoutMs !== baseline
  // A window the deployment named that is not on the ladder still runs as
  // configured: the thumb parks on the nearest rung and the readout prints the
  // exact number, so the card never lies about what is in force.
  const index = IDLE_RELEASE_MS.indexOf(release.idleTimeoutMs)
  const exact = index >= 0
  const shown = exact ? release.idleTimeoutMs : nearestIdleRung(release.idleTimeoutMs)
  // The config file's window is worth saying only when it is being
  // outranked — otherwise it IS what runs, and saying "the value set here
  // wins" would name a win nobody claimed.
  const note = release.configuredIdleTimeoutMs === undefined
    || release.configuredIdleTimeoutMs === release.idleTimeoutMs
    ? undefined
    : acp.label(
      `配置文件（cordis.patch.yml）设为 ${idleWindowText(release.configuredIdleTimeoutMs, acp)}，此处设置优先。`,
      `The config file (cordis.patch.yml) asks for ${idleWindowText(release.configuredIdleTimeoutMs, acp)}; the value set here wins.`,
    )
  const resetLabel = release.configuredIdleTimeoutMs === undefined
    ? acp.label('恢复默认值', 'Restore default')
    : acp.label('恢复配置文件的值', 'Use config file value')
  return (
    <section className="dwa-section">
      <div className="dwa-section-heading">
        <div>
          <h3 className="dwa-section-title">{acp.label('空闲释放', 'Idle release')}</h3>
          <p className="dwa-section-copy">
            {acp.label('空闲多久后挂起聊天进程。', 'How long an idle chat process is kept before it is parked.')}
          </p>
        </div>
      </div>
      <div className="dwa-preferences">
        <div className="dwa-preference-block">
          <div className="dwa-preference-label">{acp.label('释放窗口', 'Release window')}</div>
          <div className="dwa-deadline-value">{idleWindowText(release.idleTimeoutMs, acp)}</div>
          <input
            className="dwa-deadline-range"
            type="range"
            min={0}
            max={IDLE_RELEASE_MS.length - 1}
            step={1}
            value={exact ? index : IDLE_RELEASE_MS.indexOf(shown)}
            aria-label={acp.label('释放窗口', 'Release window')}
            onChange={event => {
              const next = IDLE_RELEASE_MS[Number(event.target.value)]
              if (next !== undefined && next !== release.idleTimeoutMs) void acp.setIdleRelease(next)
            }}
          />
          <div className="dwa-deadline-ticks">
            {IDLE_RELEASE_MS.filter((_, i) => i % 2 === 0).map(ms => (
              <span key={ms}>{idleWindowText(ms, acp)}</span>
            ))}
          </div>
          <div className="dwa-preference-copy">
            {acp.label(
              '挂起后会话仍保留，下一条消息自动恢复。',
              'A parked session is kept; the next message resumes it.',
            )}
          </div>
          {note !== undefined && <div className="dwa-deadline-flag">⚠ {note}</div>}
        </div>
        {overridden && (
          <div className="dwa-deadline-reset">
            <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => void acp.resetIdleRelease()}>
              {resetLabel}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * The rung nearest a window that is not on the ladder — used only to park the
 * thumb; the readout always prints the exact value.
 */
function nearestIdleRung(ms: number): number {
  let best = IDLE_RELEASE_MS[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const rung of IDLE_RELEASE_MS) {
    const distance = Math.abs(rung - ms)
    if (distance < bestDistance) {
      bestDistance = distance
      best = rung
    }
  }
  return best
}

/**
 * `30 分钟` — the readout and the tick label, one formatter.
 *
 * ALWAYS minutes, even at the top of the ladder: a scale that runs "1 分钟"
 * to "50 分钟" and then "1 小时" reads as two different scales.
 */
function idleWindowText(ms: number, acp: AcpStore): string {
  // 0 is the deployment's way of saying "never release", and reading it as
  // "0 分钟" would say the opposite.
  if (ms <= 0) return acp.label('永不释放', 'Never')
  const minutes = Math.round(ms / 60_000)
  return acp.label(`${String(minutes)} 分钟`, `${String(minutes)}m`)
}
