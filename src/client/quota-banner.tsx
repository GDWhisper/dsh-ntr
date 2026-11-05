/**
 * The conversation's rate-limit banner: one row above the composer
 * (`conversation.input.dock`) saying the agent refused this conversation for
 * quota reasons, carrying the agent's OWN message verbatim — the reset time in
 * it is the one fact the user needs, and it is the agent's text, not a
 * paraphrase.
 *
 * WHY A BANNER: CodeBuddy answers a `session/prompt` it refuses for quota
 * reasons with a RESOLVE (`stopReason: "refusal"`), not a reject, and the reason
 * rides the response `_meta` — a place nothing in this bundle used to read. The
 * turn therefore ends cleanly with no error surface, no notice and no visible
 * trace: the user's message looks like it was accepted and then ignored. This
 * row names the cause where the user is looking. There is deliberately NO
 * action button: the model picker already sits in the composer, and switching
 * models is the user's decision, not a gesture this card performs for them.
 *
 * The gate is a pure function ({@link quotaRefusalMessage}) — the same seam the
 * released banner uses, so the rules are testable with no DOM. The precedence
 * rules copy that banner's: an explicit `acpMode === false` outranks a lingering
 * row, and the rows must have been loaded for THIS conversation. The extra
 * indirection is that the refusal lives on the host's `SessionView` (broadcast
 * as `session/meta`), which carries no DSH session id — so the live
 * `ChatSessionView` row is the only bridge from this conversation to it.
 */

import { useEffect } from 'react'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import type { AcpStore, UiState } from './store.ts'

export interface QuotaBannerProps {
  /** Injected face: the store plus the chat session id this banner belongs to. */
  acp: AcpStore
  sessionId: string
}

/**
 * The agent's rate-limit message for this conversation, or `undefined` when the
 * banner must render nothing.
 *
 * Reads the LIVE `SessionView` of this conversation (the host half publishes it
 * on every quota refusal and clears it on the next prompt that is not refused):
 * `SessionView` is keyed by the host-minted session id and carries no DSH
 * session id, so the live `ChatSessionView` rows of this conversation are the
 * only bridge. Every miss — a non-ACP verdict, rows loaded for another
 * conversation, no live row at all, no matching session, a closed or released
 * session, or a session without the refusal — returns `undefined`, so an
 * ordinary conversation (which never receives the field) can never show this
 * row.
 *
 * EVERY live row is scanned, not just the first: the host lets two LiveSessions
 * briefly share one chat id (a concurrent first turn, see the comment at
 * `session.turnController` in src/bridge.ts), and a refusal landing on the
 * second row would otherwise be invisible here.
 */
export function quotaRefusalMessage(
  ui: Pick<UiState, 'acpMode' | 'chatSessions' | 'chatSessionsFor' | 'sessions'>,
  dshSessionId: string,
): string | undefined {
  if (ui.acpMode[dshSessionId] === false) return undefined
  if (ui.chatSessionsFor !== dshSessionId) return undefined
  for (const row of ui.chatSessions) {
    // A parked row is the released banner's business; a refusal is cleared at
    // the release boundary, so only a live row can carry one.
    if (row.released === true) continue
    const session = ui.sessions.find(s => s.sessionId === row.sessionId && !s.released && !s.closed)
    const message = session?.quotaRefusal?.message
    if (message !== undefined) return message
  }
  return undefined
}

export function QuotaBanner({ acp, sessionId }: QuotaBannerProps) {
  ensureAcpStyle()
  const ui = useUi(acp)
  const dshSessionId = String(sessionId)
  // Same self-read as the released banner: this entry must not depend on
  // another composer entry being mounted to learn the conversation's rows.
  useEffect(() => {
    void acp.loadChatSessions(dshSessionId)
  }, [acp, dshSessionId])
  const message = quotaRefusalMessage(ui, dshSessionId)
  if (message === undefined) return null
  const title = acp.label('agent 已限流', 'Agent rate limited')
  return (
    <div className="ntr-quota-banner" role="region" aria-label={title}>
      <div className="ntr-quota-banner-row">
        <div className="ntr-quota-banner-text">
          <span className="ntr-quota-banner-title">{title}</span>
          <span className="ntr-quota-banner-body">{message}</span>
        </div>
      </div>
    </div>
  )
}
