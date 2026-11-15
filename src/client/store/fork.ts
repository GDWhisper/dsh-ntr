/**
 * The NTR branch button state machine: its six rendering states and the click
 * outcome. Pure. Split out of `src/client/store.ts` (split plan P3a), which
 * re-exports it unchanged.
 */

import type { ChatSessionView } from "../../protocol.ts"

/** The branch button's six states (the NTR message-actions plan, §D4). */
export type ChatForkState =
  | 'ready'
  | 'unsupported'
  | 'released'
  | 'busy'
  | 'notTail'
  | 'hostUnavailable'

/**
 * The branch click's outcome: the child DSH session id on success, or one
 * actionable failure line (also flashed into the notice banner — the line is
 * the conversation's local copy of the same failure).
 */
export type ChatForkOutcome = { childId: string } | { failure: string }

/**
 * The branch button's state for one conversation, in the precedence it renders:
 * the host service missing beats everything (nothing can work), then the
 * agent's fork capability, then the session's own state (a parked session
 * before a running one), then the DOM's tail verdict, and only then ready.
 *
 * Every input is a fact someone else owns — the row's `fork` verdict is the
 * host's, `hostFork` is the structural probe of the runtime's `sessions.fork`,
 * `isTail` is read from the host's own `[data-turn-tail]` marker, and
 * `liveRunning` is the SSE-driven running flag (the row's own `running` only
 * refreshes on a chat-list read, so it would answer last turn). `undefined`
 * facts degrade CLOSED: no row and no `fork` verdict both read as not-ready,
 * never as a click-through.
 */
export function forkStateOf(
  row: ChatSessionView | undefined,
  hostFork: boolean,
  isTail: boolean,
  liveRunning?: boolean,
): ChatForkState {
  if (!hostFork) return 'hostUnavailable'
  if (row === undefined) return 'released'
  if (row.fork === undefined) return 'unsupported'
  if (row.fork.supported !== true) return row.fork.reason ?? 'unsupported'
  if (liveRunning === true) return 'busy'
  if (!isTail) return 'notTail'
  return 'ready'
}
