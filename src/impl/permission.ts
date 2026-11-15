/**
 * The agent's own permission vocabulary: auto answers, the pending-ask view and the `permission/request` frames.
 *
 * Frames are built in one place so the live broadcast and the SSE reconnect replay stay byte-identical.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import type { AcpEvent, PermissionOptionView, PermissionTimeoutMode } from '../protocol.ts'

/**
 * The order `auto` mode picks an option in, by the kind the agent declared:
 * the broadest grant first, then the narrow one, then the refusals, then
 * whatever the agent offered instead. See {@link pickAutoOption}.
 */
export const AUTO_OPTION_KIND_PRIORITY = ['allow_always', 'allow_once', 'reject_once', 'reject_always'] as const


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
 * `undefined` means NO option could be read (no options, or none with a usable
 * id). The caller then degrades to `abort`: guessing an option is worse than
 * refusing, and hanging is worse than either. OmniTerm dev picks the same way
 * (`pick_auto_option`, `src/acp/permission.rs`).
 */
export function pickAutoOption(options: readonly PermissionOptionView[]): PermissionOptionView | undefined {
  const usable = (option: PermissionOptionView): PermissionOptionView | undefined =>
    option.optionId === '' ? undefined : option
  for (const kind of AUTO_OPTION_KIND_PRIORITY) {
    const hit = options.find(option => option.kind === kind)
    const picked = hit === undefined ? undefined : usable(hit)
    if (picked !== undefined) return picked
  }
  return options.length === 0 ? undefined : usable(options[0] as PermissionOptionView)
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
  const requests: AcpEvent[] = pending.map(permissionRequestFrame)
  return [...requests, { type: 'permission/synced', requestIds: pending.map(p => p.requestId) }]
}
