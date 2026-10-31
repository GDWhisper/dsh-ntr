/**
 * The NTR branch button (slot `conversation.chat.assistant-actions`): in an
 * ACP conversation this is the ONLY branch entry — the host's like / dislike /

 * branch icons are hidden under `html[data-ntr-acp]` (see acp-ui.tsx), and
 * this button takes the host branch's place with the same icon, size and
 * row position (order 20, after the hidden feedback entry's order 10).
 *
 * Clicking runs the fixed two-stage branch: the HOST forks the DSH session
 * tree first (`sessions.fork`, structurally resolved), then the plugin adopts
 * the ACP side (`session/chat-fork-adopt` → the agent's own `session/fork`),
 * so the child conversation's agent actually remembers the parent context —
 * see the NTR message-actions plan, §D5/§D7.
 *
 * Availability is the store's `forkStateOf` six-state mapping over facts the
 * button never derives itself: the host's per-row `fork` verdict
 * (`session/chat-list`), the SSE running flag, the host-fork structural probe,
 * and the DOM tail verdict. The tail check reads the host's OWN
 * `[data-turn-tail]` marker (`data-actions-reveal === "always"` = the latest
 * completed turn) and fails CLOSED: a missing marker disables the button
 * rather than risking a fork cut at a point the user is not looking at.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { IconBranchOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useUi } from './acp-ui.tsx'
import type { AcpChatInjected } from './acp-ui.tsx'
import { forkStateOf } from './store.ts'
import type { ChatForkState } from './store.ts'
/** What the label reads for each state (zh / en pairs, per the plan's §D4). */
function tooltipFor(state: ChatForkState, label: (zh: string, en: string) => string): string {
  switch (state) {
    case 'ready': return label('在新对话中分支', 'Branch into a new conversation')
    case 'unsupported': return label('该 agent 不支持原生分叉', 'This agent cannot fork natively')
    case 'released': return label('会话已挂起，先发一条消息恢复再分叉', 'Resume this session before branching')
    case 'busy': return label('当前轮次结束后才能分叉', 'Wait for the current turn to finish')
    case 'notTail': return label('仅可从已完成轮次的最后一条消息分支', 'Available only on the last message of a completed turn')
    case 'hostUnavailable': return label('当前宿主不提供分叉', 'This host does not support branching')
  }
}

export function AcpBranchAction(props: AcpChatInjected & { sessionId: string }) {
  const ui = useUi(props.acp)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState(false)
  /**
   * The host's own availability verdict for the turn tail this button sits
   * in, re-read after EVERY render (no dep array): the marker flips without
   * any store event of our own when a new turn lands, and before the first
   * layout pass the ref is not attached yet. Two facts, both the HOST's:
   * `data-actions-reveal === "always"` (this tail is the latest turn and
   * completed) and the host branch button's own `data-unavailable` (a stricter
   * gate — a tail whose final node is not the transcript's last, or a turn
   * with later nodes, is one the HOST refuses to fork). Reading the host's
   * button keeps the plugin's readiness a SUBSET of the host's: wherever the
   * two would disagree about the cut point, the plugin button disables, and
   * the remaining clicks fork at the same latest-completed prefix the host
   * would (the tail marked `always` is the latest completed turn, which is
   * exactly where the host's fallback `atSeq` lands).
   */
  const [tailReady, setTailReady] = useState(false)
  useLayoutEffect(() => {
    const tail = buttonRef.current?.closest('[data-turn-tail]')
    const hostBranch = tail?.querySelector('button[aria-label="在新对话中分支"]:not([data-ntr-branch]), button[aria-label="Branch into a new conversation"]:not([data-ntr-branch])')
    setTailReady(
      tail?.getAttribute('data-actions-reveal') === 'always'
      && hostBranch?.hasAttribute('data-unavailable') !== true,
    )
  })
  /**
   * The click's local failure line. The store ALSO flashes the same reason
   * into the settings banner, but the user is HERE — without this row the
   * click would "do nothing" visibly, the exact invisibility the permission
   * dock's pinned-error pattern exists to prevent.
   */
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // ACP conversations only, fail-closed: the slot renders in EVERY
  // conversation, and the confirmed verdict (`session/chat-list`, folded from
  // the runtime row by the seat gate) is the same fact the scope marker and
  // the CSS hiding run on. `undefined` renders nothing. The row guard keeps
  // the button from rendering on a conversation whose rows have not landed —
  // without it a rc.2-style host (verdict folded from the row preset, ahead
  // of the list read) would show a disabled button flashing the `released`
  // tooltip for a perfectly live conversation.
  if (ui.acpMode[props.sessionId] !== true) return null
  if (ui.chatSessionsFor !== props.sessionId) return null

  const row = ui.chatSessionsFor === props.sessionId ? ui.chatSessions[0] : undefined
  const forkFace = props.hostFork?.()
  // The row's `running` only refreshes on a chat-list read, so a turn that
  // just started would leave it stale for seconds; the SSE-facing session
  // view is the live copy of the same fact.
  const liveRunning = row !== undefined && ui.sessions.some(s => s.sessionId === row.sessionId && s.running)
  const state = forkStateOf(row, forkFace !== undefined, tailReady, liveRunning)
  const disabled = state !== 'ready' || pending
  const branchLabel = props.acp.label('在新对话中分支', 'Branch into a new conversation')

  const onClick = (): void => {
    if (state !== 'ready' || pending) return
    setPending(true)
    setFailure(undefined)
    void props.acp.forkChatSession(props.sessionId, sessionId => {
      // Re-resolved per click: a face that vanished between render and click
      // fails loudly in the notice banner and the local line instead of
      // throwing here.
      const face = props.hostFork?.()
      if (face === undefined) throw new Error('acp: host fork service is gone')
      return face.fork({ sessionId, increaseTitle: true })
    }).then(outcome => {
      // A failure opens NOTHING (an unadopted child is a copied-history
      // conversation the user did not ask to visit) and says why, right here.
      if ('childId' in outcome) props.openSession?.(outcome.childId)
      else setFailure(outcome.failure)
    }).finally(() => { setPending(false) })
  }

  return (
    <>
      <Tooltip label={tooltipFor(state, props.acp.label)} side="bottom">
        <button
          ref={buttonRef}
          type="button"
          className="ntr-branch-action"
          aria-label={branchLabel}
          aria-disabled={disabled || undefined}
          data-ntr-branch=""
          data-unavailable={disabled || undefined}
          onClick={disabled ? undefined : onClick}
        >
          <IconBranchOutline16 />
        </button>
      </Tooltip>
      {failure !== undefined && (
        <span className="ntr-branch-error" role="alert" title={failure}>{failure}</span>
      )}
    </>
  )
}
