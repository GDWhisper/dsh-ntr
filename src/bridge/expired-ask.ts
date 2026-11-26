/**
 * Expiry of one permission-family ask — an approval or a question.
 *
 * Moved out of `agent-bridge.ts` for the file-size ratchet, and because the
 * question branch needs the exact discipline the approval branch already had:
 * ONE notice and ONE `permission/expired` frame per expiry, never a second.
 * Once the card is gone that frame is the conversation's only trace of what
 * happened to the ask.
 *
 * Approval answers stay byte-identical to the pre-question behaviour:
 * `abort` / `wait` refuse, `auto` picks by the agent's own option KINDS.
 * A question never uses that ranking: `first` sends the first usable option in
 * the agent's order, and `cancel` (the default) sends nothing.
 */

import type { PermissionOption, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { EventHub } from '../impl.ts'
import { pickAutoOption, pickQuestionDefault } from '../impl.ts'
import type { AcpEvent, PermissionAskKind, PermissionOutcome, PermissionTimeoutMode, QuestionTimeoutMode } from '../protocol.ts'
import { permissionToolName } from './turn-stream.ts'
import type { LiveSession } from './turn-stream.ts'

/** What an expiry announcement needs from the bridge that owns the ask. */
export interface ExpiredAskHost {
  readonly agentId: string
  readonly hub: EventHub
}

/**
 * Announce and compute one ask's expiry.
 *
 * The policy values (`timeoutMode` / `questionTimeoutMode`) arrive as the
 * snapshot the ask was CREATED with: a hot settings write must never change
 * what a card already promises.
 */
export function announceExpiredAsk(
  host: ExpiredAskHost,
  session: LiveSession,
  mode: PermissionTimeoutMode,
  toolCall: unknown,
  options: readonly PermissionOption[],
  timeoutMs: number,
  askKind: PermissionAskKind,
  questionTimeoutMode: QuestionTimeoutMode,
): PermissionOutcome {
  const views = options.map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind }))
  const question = askKind === 'question'
  const picked = question
    ? (questionTimeoutMode === 'first' ? pickQuestionDefault(views) : undefined)
    : (mode === 'auto' ? pickAutoOption(views, session.permissionPolicy?.preferOnce === true) : undefined)
  const outcome: PermissionOutcome = picked === undefined
    ? { outcome: 'cancelled' }
    : { outcome: 'selected', optionId: picked.optionId }
  const tool = permissionToolName(toolCall)
  // 不等待（0）不是「等了 0 秒」，是没等：两种说法的区别就在这里。
  const waited = timeoutMs > 0
    ? `timed out after ${String(Math.round(timeoutMs / 1000))}s`
    : 'was not waited for'
  // Name what was missed and what was done about it — the way a human needs it:
  // which ask sat unanswered, and what the plugin answered instead. A question
  // says so in its own words: it is not a permission that was refused.
  const subject = question ? 'question' : 'permission request'
  const verdict = picked !== undefined
    ? `answered "${picked.name}"`
    : (question ? 'cancelled, not answered for you' : 'refused')
  host.hub.broadcast({
    type: 'agent/notice',
    agentId: host.agentId,
    level: 'info',
    text: `acp: ${subject} for "${tool}" ${waited}; ${verdict}`,
  })
  host.hub.broadcast({
    type: 'permission/expired',
    sessionId: session.sessionId,
    toolCall,
    timeoutMs,
    outcome,
    ...(question ? { askKind } : {}),
    ...(picked === undefined ? {} : { optionName: picked.name }),
  })
  return outcome
}

/**
 * Settle an ask on arrival: no ledger entry and no card — nothing asks a
 * human, so there is nothing to show. Used by 不等待 (`auto` + zero window) and
 * by a delegated session's question under `cancel`.
 */
export function settleExpiredAsk(
  host: ExpiredAskHost,
  session: LiveSession,
  mode: PermissionTimeoutMode,
  toolCall: unknown,
  options: readonly PermissionOption[],
  timeoutMs: number,
  askKind: PermissionAskKind,
  questionTimeoutMode: QuestionTimeoutMode,
): RequestPermissionResponse {
  session.lastAgentActivityAt = Date.now()
  const outcome = announceExpiredAsk(host, session, mode, toolCall, options, timeoutMs, askKind, questionTimeoutMode)
  return outcome.outcome === 'selected'
    ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

/** Conversation prose line emitted when a permission-family ask is posted. */
export function permissionChatLine(event: Extract<AcpEvent, { type: 'permission/request' }>): string {
  if (event.askKind === 'question') {
    const title = event.reason ?? event.toolName
    const lead = event.dshSessionId !== undefined
      ? 'please answer the question card above the composer'
      : 'please answer in Settings'
    if (event.deadlineAt === undefined) return `\n> ❓ [Question: ${title}] - ${lead}\n`
    const remainingMs = Math.max(0, event.deadlineAt - Date.now())
    const remainingS = Math.max(1, Math.floor((remainingMs + 1) / 1000))
    const otherwise = event.questionTimeoutMode === 'first' && event.autoOptionName !== undefined
      ? `"${event.autoOptionName}" is sent automatically`
      : 'this question is cancelled'
    return `\n> ❓ [Question: ${title}] - ${lead} within ${String(remainingS)}s or ${otherwise}\n`
  }
  // `toolName` is host-derived (`permissionToolName`) so agents that omit
  // `title` and declare it in `_meta` still name the operation here.
  const title = event.toolName
  // The line must point at the place the answer entry actually is: a
  // chat-bound ask renders its card in the conversation; an `/acp`-RPC ask
  // has no conversation, so its card lives on the settings page.
  const lead = event.dshSessionId !== undefined
    ? 'please answer the permission card above the composer'
    : 'please approve in Settings'
  // The last clause says what happens if nobody answers, and it follows the
  // MODE: refused, answered automatically, or (in `wait`) nothing at all.
  if (event.timeoutMode === 'wait' || event.deadlineAt === undefined) {
    return `\n> 🔐 [Permission Required: ${title}] - ${lead}\n`
  }
  const remainingMs = Math.max(0, event.deadlineAt - Date.now())
  // Floor (+1 ms for the Date.now tick), min 1: rounding up would promise time already spent.
  const remainingS = Math.max(1, Math.floor((remainingMs + 1) / 1000))
  const otherwise = event.timeoutMode === 'auto'
    ? 'this request is answered automatically'
    : 'this request is cancelled'
  return `\n> 🔐 [Permission Required: ${title}] - ${lead} within ${String(remainingS)}s or ${otherwise}\n`
}

/** Conversation prose line emitted when a permission-family ask expires or settles itself. */
export function expiredChatLine(event: {
  toolCall: unknown
  timeoutMs: number
  outcome: PermissionOutcome
  optionName?: string
  askKind?: PermissionAskKind
}): string {
  const title = permissionToolName(event.toolCall)
  const waited = event.timeoutMs > 0
    ? `no answer within ${String(Math.round(event.timeoutMs / 1000))}s`
    : 'not waited for'
  if (event.askKind === 'question') {
    if (event.outcome.outcome === 'selected') {
      const picked = event.optionName === undefined ? event.outcome.optionId : event.optionName
      return `\n> ❓ [Question: ${title}] - ${waited}; answered "${picked}" automatically, continuing\n`
    }
    return `\n> ❓ [Question: ${title}] - ${waited}; cancelled, not answered for you\n`
  }
  if (event.outcome.outcome === 'selected') {
    const picked = event.optionName === undefined ? event.outcome.optionId : event.optionName
    return `\n> 🔐 [Permission Required: ${title}] - ${waited}; answered "${picked}" automatically, continuing\n`
  }
  return `\n> 🔐 [Permission Required: ${title}] - ${waited}; refused\n`
}
