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
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import type { AcpStore, UiState } from './store.ts'

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
          <span className="ntr-released-banner-title">{acp.label('进程已释放', 'Process released')}</span>
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
