/**
 * The pending-ask shape and its pure readers: which asks belong to one
 * conversation, and the countdown label one ask renders. Split out of
 * `src/client/store.ts` (split plan P3a), which re-exports it unchanged.
 */

import type { PermissionAskKind, PermissionTimeoutMode, QuestionTimeoutMode } from "../../protocol.ts"
import { pendingForSession } from "./pending.ts"

/**
 * One permission ask waiting for a human. Every field is copied VERBATIM from
 * the host's `permission/request` frame: the host owns what the ask is called
 * (`toolName` / `reason`), which options the agent offered (order included),
 * and whether the ask carries a deadline. The browser does not derive a title
 * from `toolCall` and does not second-guess the agent's option labels.
 */
export interface PendingPermission {
  requestId: string
  /** ACP session id. */
  sessionId: string
  /** DSH chat session id; absent for `/acp` RPC-only sessions (settings-only ask). */
  dshSessionId?: string
  toolName: string
  reason?: string
  options: Array<{ optionId: string; name: string; kind: string }>
  timeoutMode: PermissionTimeoutMode
  /** Epoch ms; absent in `wait` mode. */
  deadlineAt?: number
  /** Absent = `approval`: an older host never says the word. */
  askKind?: PermissionAskKind
  /** Only on a question ask: what an expired deadline does. */
  questionTimeoutMode?: QuestionTimeoutMode
  /** Only on a question ask that WILL be answered on expiry: the option the host will send. */
  autoOptionName?: string
}

/** Returned by {@link deadlineRemainingLabel} once the deadline has passed. */
export const PERMISSION_DEADLINE_EXPIRED = 'expired'

/**
 * The asks that belong to one DSH chat conversation. An ask without a
 * `dshSessionId` belongs to no conversation (an `/acp` RPC-only session), so it
 * is deliberately absent from every conversation's dock and stays in the
 * settings-panel ledger.
 */
export function permissionsForSession(
  permissions: readonly PendingPermission[],
  dshSessionId: string,
): PendingPermission[] {
  return pendingForSession(permissions, dshSessionId)
}

/**
 * Compact countdown for one ask, or `undefined` when there is nothing to count
 * down (`wait` mode, or a frame without a deadline). Pure so the formatting is
 * testable without a clock: the dock passes `Date.now()` on its tick.
 *
 * Past the deadline the answer is {@link PERMISSION_DEADLINE_EXPIRED} rather
 * than a negative number — the host has already armed the expiry, and a card
 * counting backwards would claim a deadline that no longer exists.
 */
export function deadlineRemainingLabel(
  deadlineAt: number | undefined,
  now: number,
  mode: PermissionTimeoutMode,
): string | undefined {
  if (mode === 'wait' || deadlineAt === undefined) return undefined
  const remainingMs = deadlineAt - now
  if (remainingMs <= 0) return PERMISSION_DEADLINE_EXPIRED
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`
}
