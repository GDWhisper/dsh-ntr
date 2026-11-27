/**
 * The conversation's released-session banner: one row above the composer
 * (`conversation.input.dock`) saying the agent process behind this
 * conversation has been released, with the explicit resume button.
 *
 * WHY A BANNER: releasing a process is deliberately silent (constraint 19 —
 * an idle teardown is the expected lifecycle, no `agent/notice`), and the
 * only other trace was the NTR view tab's status badge — a surface most
 * users never open. The "your next message resumes it" promise is real but
 * unverifiable from the chat itself, so the banner states it here and the
 * button turns it into a gesture (`session/chat-resume`), the explicit form
 * of the same recovery the next prompt performs lazily.
 *
 * The gate is a pure function ({@link releasedBannerVisible}) — the seam the
 * composer's other visibility decisions use, so the rules are testable with
 * no DOM. Like the agent tag and the context ring, an explicit
 * `acpMode === false` outranks a lingering `chatSessions` row: a conversation
 * that left NTR mode must not keep claiming a parked NTR process.
 */

import { useEffect, useState } from 'react'
import type { AcpReleaseCause, ChatSessionView } from '../protocol.ts'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import type { AcpStore, ReleaseDetails, UiState } from './store.ts'

export interface ReleasedBannerProps {
  /** Injected face: the store plus the chat session id this banner belongs to. */
  acp: AcpStore
  sessionId: string
}

/**
 * Whether the banner should render: this conversation's ACP session records
 * are all released — the process is parked (idle release or crash) and
 * nothing is live to serve the next message yet. An empty list (no agent has
 * run here) and a live row anywhere both mean "nothing to recover", so the
 * banner stays out of the way.
 */
export function releasedBannerVisible(
  ui: Pick<UiState, 'acpMode' | 'chatSessions' | 'chatSessionsFor'>,
  dshSessionId: string,
): boolean {
  if (ui.acpMode[dshSessionId] === false) return false
  if (ui.chatSessionsFor !== dshSessionId) return false
  return ui.chatSessions.length > 0 && ui.chatSessions.every(row => row.released === true)
}

const RELEASE_CAUSE_COPY: Record<
  AcpReleaseCause,
  { zh: string; en: string; tone: 'idle' | 'warn' | 'fail' | 'busy' }
> = {
  shutdown: { zh: '热重载 / 宿主关闭', en: 'Hot reload / host shutdown', tone: 'warn' },
  idle: { zh: '空闲释放', en: 'Idle release', tone: 'idle' },
  died: { zh: '进程崩溃', en: 'Process crashed', tone: 'fail' },
  archived: { zh: '会话归档', en: 'Session archived', tone: 'idle' },
  workspace: { zh: '工作区切换', en: 'Workspace changed', tone: 'busy' },
  stalled: { zh: '回合无响应', en: 'Turn stalled', tone: 'fail' },
  'resume-failed': { zh: '恢复失败', en: 'Resume failed', tone: 'fail' },
}

/** Localized badge copy and tone for one release cause; tolerates unknown causes from newer hosts. */
export function releaseCausePresentation(
  cause: AcpReleaseCause,
  label: (zh: string, en: string) => string,
): { label: string; tone: 'idle' | 'warn' | 'fail' | 'busy' } | undefined {
  const entry = (RELEASE_CAUSE_COPY as Record<string, { zh: string; en: string; tone: 'idle' | 'warn' | 'fail' | 'busy' } | undefined>)[cause]
  if (entry !== undefined) return { label: label(entry.zh, entry.en), tone: entry.tone }
  const fallback = typeof cause === 'string' ? cause.trim() : ''
  return fallback === '' ? undefined : { label: fallback, tone: 'idle' }
}

/**
 * Pick the most recent release metadata across this conversation's parked
 * rows (one conversation can hold older agent-switch rows). Later rows break
 * ties only when they carry release metadata; absent fields stay absent rather
 * than inventing defaults.
 */
export function latestReleaseOf(rows: readonly ChatSessionView[]): ReleaseDetails | undefined {
  let winner: ChatSessionView | undefined
  let winnerAt = -1
  let winnerHasMeta = false
  for (const row of rows) {
    if (row.released !== true) continue
    const at = typeof row.releasedAt === 'number' && Number.isFinite(row.releasedAt) && row.releasedAt > 0
      ? row.releasedAt
      : -1
    const rawReason = typeof row.releaseReason === 'string' ? row.releaseReason.trim() : ''
    const hasMeta = row.releaseCause !== undefined || rawReason !== '' || at > 0
    if (winner === undefined || at > winnerAt || (at === winnerAt && (hasMeta || !winnerHasMeta))) {
      winner = row
      winnerAt = at
      winnerHasMeta = hasMeta
    }
  }
  if (winner === undefined || !winnerHasMeta) return undefined
  const cause = winner.releaseCause
  const rawReason = typeof winner.releaseReason === 'string' ? winner.releaseReason.trim() : ''
  const reason = rawReason !== '' ? rawReason : undefined
  const releasedAt = winnerAt > 0 ? winnerAt : undefined
  return {
    ...(cause === undefined ? {} : { cause }),
    ...(reason === undefined ? {} : { reason }),
    ...(releasedAt === undefined ? {} : { releasedAt }),
  }
}

/**
 * Deterministic local wall-clock formatting for release timestamps: `HH:MM:SS`
 * on the same local day, `MM-DD HH:MM:SS` on earlier days, and full
 * `YYYY-MM-DD HH:MM:SS` in `full` for the tooltip.
 */
export function formatReleaseTime(at: number, now = Date.now()): { short: string; full: string } | undefined {
  if (!Number.isFinite(at) || at <= 0) return undefined
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = new Date(at)
  const ref = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const full = `${String(date.getFullYear())}-${md} ${clock}`
  const sameDay = date.getFullYear() === ref.getFullYear()
    && date.getMonth() === ref.getMonth()
    && date.getDate() === ref.getDate()
  return { short: sameDay ? clock : `${md} ${clock}`, full }
}

export function ReleasedBanner({ acp, sessionId }: ReleasedBannerProps) {
  ensureAcpStyle()
  const ui = useUi(acp)
  const dshSessionId = String(sessionId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // The binding has no announcing frame on load (a conversation opened on an
  // already-parked session shows nothing else that would read the list), so
  // this entry reads it once itself — deduped in flight by the store.
  useEffect(() => {
    void acp.loadChatSessions(dshSessionId)
  }, [acp, dshSessionId])
  if (!releasedBannerVisible(ui, dshSessionId)) return null
  const release = latestReleaseOf(ui.chatSessions)
  const causeInfo = release?.cause !== undefined ? releaseCausePresentation(release.cause, acp.label) : undefined
  const timeInfo = release?.releasedAt !== undefined ? formatReleaseTime(release.releasedAt) : undefined
  const reasonText = release?.reason
  const resume = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void acp.resumeChatSession(dshSessionId)
      // `resumeChatSession` reports to the store's notice too, but that notice
      // lives on the settings page; this pins the failure where the user is
      // looking (same contract as the permission card).
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => { setBusy(false) })
  }
  return (
    <div className="ntr-released-banner" role="region" aria-label={acp.label('进程已释放', 'Process released')}>
      <div className="ntr-released-banner-row">
        <div className="ntr-released-banner-text">
          <div className="ntr-released-banner-head">
            <span className="ntr-released-banner-title">{acp.label('进程已释放', 'Process released')}</span>
            {causeInfo !== undefined && (
              <span className={`ntr-acp-badge is-${causeInfo.tone}`}>{causeInfo.label}</span>
            )}
            {timeInfo !== undefined && (
              <span className="ntr-released-banner-time" title={timeInfo.full}>{timeInfo.short}</span>
            )}
          </div>
          {reasonText !== undefined && (
            <span className="ntr-released-banner-reason">{reasonText}</span>
          )}
          <span className="ntr-released-banner-body">
            {acp.label('上下文已保留；下一条消息将自动恢复，或点击【恢复进程】按钮。', 'Context is kept — your next message resumes it, or click [Resume process].')}
          </span>
        </div>
        <button
          type="button"
          className="ntr-acp-more is-primary"
          disabled={busy}
          title={acp.label('立即拉起 agent 进程并恢复这个会话', 'Bring the agent process back and restore this session now')}
          onClick={resume}
        >
          {busy ? acp.label('正在恢复…', 'Resuming…') : acp.label('恢复进程', 'Resume process')}
        </button>
      </div>
      {error !== undefined && (
        <div className="ntr-permission-error" role="alert">{error}</div>
      )}
    </div>
  )
}
