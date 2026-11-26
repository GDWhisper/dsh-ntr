/**
 * The agent's own permission vocabulary: auto answers, the pending-ask view and the `permission/request` frames.
 *
 * Frames are built in one place so the live broadcast and the SSE reconnect replay stay byte-identical.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import type {
  AcpEvent, PermissionAskKind, PermissionOptionView, PermissionTimeoutMode, QuestionTimeoutMode,
} from '../protocol.ts'
import { pendingReplayFrames } from './pending-request.ts'

/**
 * The order `auto` mode picks an option in, by the kind the agent declared:
 * the broadest grant first, then the narrow one, then the refusals, then
 * whatever the agent offered instead. See {@link pickAutoOption}.
 */
export const AUTO_OPTION_KIND_PRIORITY = ['allow_always', 'allow_once', 'reject_once', 'reject_always'] as const

/**
 * Delegation-only priority: `allow_once` first. On a shared (non-A1) process
 * the agent's `allow_always` memory may outlive the delegated session and
 * loosen the main conversation's later asks; the narrower grant cannot.
 */
export const DELEGATE_AUTO_KIND_PRIORITY = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const

/**
 * The option an expired deadline answers with in `auto` mode.
 *
 * The pick is by the option's KIND, because that is what the agent declared
 * about the choice it is offering: `allow_always` first (one grant covers the
 * rest of the run), then `allow_once` (the smaller grant), then the reject
 * kinds (refuse but let the agent continue), and finally the first option
 * whatever it is — an agent may offer only a custom kind, and refusing to
 * answer at all would hang the turn.
 *
 * `preferOnce` is delegation-only ({@link DELEGATE_AUTO_KIND_PRIORITY}): a
 * shared-process delegate must not hand the agent an `allow_always` memory
 * that outlives its session. The default keeps the main session's priority.
 *
 * `undefined` means NO option could be read (no options, or none with a usable
 * id). The caller then degrades to `abort`: guessing an option is worse than
 * refusing, and hanging is worse than either. OmniTerm dev picks the same way
 * (`pick_auto_option`, `src/acp/permission.rs`).
 */
export function pickAutoOption(options: readonly PermissionOptionView[], preferOnce = false): PermissionOptionView | undefined {
  const usable = (option: PermissionOptionView): PermissionOptionView | undefined =>
    option.optionId === '' ? undefined : option
  for (const kind of (preferOnce ? DELEGATE_AUTO_KIND_PRIORITY : AUTO_OPTION_KIND_PRIORITY)) {
    const hit = options.find(option => option.kind === kind)
    const picked = hit === undefined ? undefined : usable(hit)
    if (picked !== undefined) return picked
  }
  return options.length === 0 ? undefined : usable(options[0] as PermissionOptionView)
}

// ---- Question asks (`askKind: 'question'`) ----

/**
 * The `toolCallId` prefix Antigravity uses for its OWN fixed-choice questions,
 * which it sends through `session/request_permission` — the approval method.
 *
 * Based on observed ACP wire semantics (`interaction_` prefix); built-in
 * `agy acp` has not been captured yet, so this constant is the ONE place to
 * change once it is. See docs/plan/agy-question-asks.md §2.3.
 */
export const AGY_QUESTION_TOOL_CALL_PREFIX = 'interaction_'

/**
 * Read one ask's semantic kind from the agent's tool call.
 *
 * FAIL-OPEN: an unreadable id, a missing id, or any other prefix is an
 * `approval`, so the existing pipeline runs verbatim. Only Antigravity bridges
 * call this at all (the gate lives in `questionAskKindOf`).
 */
export function permissionAskKind(toolCall: unknown): PermissionAskKind {
  const id = (toolCall as { toolCallId?: unknown } | null | undefined)?.toolCallId
  return typeof id === 'string' && id.startsWith(AGY_QUESTION_TOOL_CALL_PREFIX) ? 'question' : 'approval'
}

/** Optional Antigravity `_meta` security-warning key on long-lived permission options. */
export const AGY_SECURITY_WARNING_META_KEY = 'agy.security.warning'
/** Upper bound on surfaced security warnings so an agent payload cannot bloat cards. */
export const SECURITY_WARNING_MAX_CHARS = 512

/**
 * Extract and normalize `_meta['agy.security.warning']` from an ACP
 * `PermissionOption`. Supports `{ title?, message? }` objects or plain strings,
 * bounds the output with an ellipsis marker, and returns `undefined` when absent.
 */
export function permissionOptionWarning(option: unknown): string | undefined {
  if (typeof option !== 'object' || option === null) return undefined
  const meta = (option as { _meta?: unknown })._meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const raw = (meta as Record<string, unknown>)[AGY_SECURITY_WARNING_META_KEY]
  let text = ''
  if (typeof raw === 'string') {
    text = raw.trim()
  } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const message = typeof row.message === 'string' ? row.message.trim() : ''
    if (title !== '' && message !== '') {
      text = message.includes(title) ? message : `${title}: ${message}`
    } else {
      text = message || title
    }
  }
  if (text === '') return undefined
  return text.length > SECURITY_WARNING_MAX_CHARS
    ? `${text.slice(0, SECURITY_WARNING_MAX_CHARS - 1)}…`
    : text
}

/**
 * The option an expired QUESTION ask answers with in `first` mode: the first
 * option with a usable id, in the agent's own order.
 *
 * Deliberately NOT {@link pickAutoOption}: that one ranks by permission KIND
 * (`allow_always` first), which says nothing about which answer a question
 * expects — and would send the broadest grant as if it were a choice.
 * `undefined` means there is nothing to answer with; the caller cancels.
 */
export function pickQuestionDefault(options: readonly PermissionOptionView[]): PermissionOptionView | undefined {
  return options.find(option => option.optionId !== '')
}

// ---- The agent's own permission vocabulary ----

/** ACP `ToolCall.kind` values that are known to take a file effect. */
const WRITE_TOOL_KINDS = new Set(['edit', 'delete', 'move'])

/** ACP `ToolCall.kind` values that provably take no file effect. */
const READ_TOOL_KINDS = new Set(['read', 'search', 'think', 'fetch', 'switch_mode'])

/** Structural read of ACP `ToolCall.kind`; anything unexpected stays `undefined` (= effect unknown). */
export function permissionToolKind(toolCall: unknown): string | undefined {
  const kind = (toolCall as { kind?: unknown } | null | undefined)?.kind
  return typeof kind === 'string' && kind !== '' ? kind : undefined
}

/** Structural read of ACP `ToolCall.locations[].path` — where an edit claims it will write. */
export function permissionToolPaths(toolCall: unknown): string[] {
  const locations = (toolCall as { locations?: unknown } | null | undefined)?.locations
  if (!Array.isArray(locations)) return []
  const out: string[] = []
  for (const entry of locations) {
    const path = (entry as { path?: unknown } | null | undefined)?.path
    if (typeof path === 'string' && path !== '') out.push(path)
  }
  return out
}

/** Everything a `permission/request` frame carries besides the ids the ledger owns. */
export interface PendingPermissionFields {
  /** DSH chat session id; absent for `/acp` RPC-only sessions. */
  dshSessionId?: string
  toolCall: unknown
  /** Host-derived human name (`permissionToolName`). */
  toolName: string
  /** One-line detail from the agent's declared input, when it has any. */
  reason?: string
  options: PermissionOptionView[]
  /** What an unanswered ask does when its deadline fires. */
  timeoutMode: PermissionTimeoutMode
  /** Epoch ms of the deadline; absent in `wait` mode (no deadline). */
  deadlineAt?: number
  /** Absent = `approval`; only a question ask says the word. */
  askKind?: PermissionAskKind
  /** Only on a question ask: what an expired deadline does. */
  questionTimeoutMode?: QuestionTimeoutMode
  /** Only on a question ask that WILL be answered on expiry: the option the host will send. */
  autoOptionName?: string
}

/** One outstanding ask as a reconnecting client must be re-shown it. */
export interface PendingPermissionView extends PendingPermissionFields {
  requestId: string
  sessionId: string
}

/**
 * The `permission/request` frame for one ask.
 *
 * ONE builder for both the live broadcast and the reconnect replay, so the two
 * can never drift: a client that reconnects must receive exactly the frame the
 * live one carried (its conversation card filters on `dshSessionId` and shows
 * `toolName` / `deadlineAt`, so a replay missing them would silently drop the
 * ask).
 */
export function permissionRequestFrame(view: PendingPermissionView): AcpEvent {
  return {
    type: 'permission/request',
    requestId: view.requestId,
    sessionId: view.sessionId,
    ...(view.dshSessionId === undefined ? {} : { dshSessionId: view.dshSessionId }),
    toolCall: view.toolCall,
    toolName: view.toolName,
    ...(view.reason === undefined ? {} : { reason: view.reason }),
    options: view.options,
    timeoutMode: view.timeoutMode,
    ...(view.deadlineAt === undefined ? {} : { deadlineAt: view.deadlineAt }),
    ...(view.askKind === undefined ? {} : { askKind: view.askKind }),
    ...(view.questionTimeoutMode === undefined ? {} : { questionTimeoutMode: view.questionTimeoutMode }),
    ...(view.autoOptionName === undefined ? {} : { autoOptionName: view.autoOptionName }),
  }
}

/**
 * Frames that re-establish a freshly connected client's view of the pending
 * permission asks: every outstanding ask re-sent as its original
 * `permission/request`, then one `permission/synced` carrying the live id set.
 *
 * Why a replay at all: a `permission/request` is broadcast ONCE, when the ask is
 * created. A client that connects later — page reload, second tab, stream
 * outage — never receives it, and that card (conversation or settings ledger)
 * is the ONLY answer entry for the ask, so the ask is invisible to exactly the
 * client that needs it. OmniTerm closes the same hole with
 * `PermissionManager::pending_events()` + a `PermissionsSynced` marker on
 * every WS connect.
 *
 * Why the terminator is mandatory: the replay is a snapshot, so an ask resolved
 * while this client was disconnected is not in it. Without the live set the
 * client would keep a stale card forever — the ask is gone host-side and
 * `respond` would answer `unknown_request`.
 */
export function permissionReplayFrames(pending: readonly PendingPermissionView[]): AcpEvent[] {
  return pendingReplayFrames(
    pending,
    permissionRequestFrame,
    requestIds => ({ type: 'permission/synced', requestIds }),
  )
}
