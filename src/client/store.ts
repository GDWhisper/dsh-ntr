/**
 * Browser-side state store for the ACP panel. Owns: the `/acp` RPC calls, the
 * `/api/acp/stream` EventSource, per-session block folding (raw ACP
 * `session/update` → render blocks), and the pending permission set.
 *
 * Deliberately framework-free: React binds through `useSyncExternalStore`.
 */

import type { AcpApprovalDeadlines, AcpConversationChoice, AcpEvent, AcpIdleRelease, AcpPresetStatus, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentSaveMode, AgentSavePayload, AgentSaveResult, AgentTestResult, AgentView, ChatSessionView, ChatTranscriptView, ApprovalDeadlinesSetPayload, ApprovalDeadlinesResult, DetectedAgentInfo, IdleReleaseResult, IdleReleaseSetPayload, PermissionTimeoutMode, PluginUpdateState, PluginVersionResult, SaveGateFlushResult, SaveGateOutcomeView, SaveGatePendingView, SaveGateStatus, SessionView, SubagentDetailEntry, SubagentDetailResult, SubagentRecord } from '../protocol.ts'
import { DEFAULT_SAVE_GATE_TIMEOUT_MS, DEFAULT_TAG_HALO, MAX_SUBAGENT_DETAIL_ENTRIES } from '../protocol.ts'

/** One slash command the ACP agent declared, whole row (the menu draws name, description and `input.hint`). */
export type AgentCommand = NonNullable<ChatSessionView['availableCommands']>[number]

/**
 * One chat-row lifecycle frame the browser applied. A `session/chat-list`
 * answer describes the host as of BEFORE frames that landed while its read was
 * in flight, so the answer replays them over the row list. Only rows the
 * answer already carries are patched: a `session/created` row the answer
 * never saw belongs to the next read, and appending it here would put another
 * conversation's row into this one's list.
 */
export interface ChatRowFrame {
  seq: number
  sessionId: string
  kind: 'released' | 'reset' | 'created' | 'closed'
}

/** The unary RPC face (narrowed `ctx.connection.rpc.call`). */
export type RpcCall = (channel: string, endpoint: string, payload: unknown) => Promise<
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }
>

export type Block =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; messageId?: string; text: string }
  | { kind: 'thought'; text: string }
  | {
    kind: 'tool'
    toolCallId: string
    title: string
    status: string
    toolKind?: string
    lines: string[]
    /**
     * Structured ACP diffs (`content: [{type:'diff'}]`). Kept apart from
     * {@link lines} because a diff is the one tool payload worth rendering as
     * a diff: flattening it to `diff <path>` throws away everything that makes
     * an edit reviewable.
     */
    diffs?: Array<{ path: string; oldText: string | null; newText: string }>
    /** Text items the card cannot render (diff output, an unknown content kind's JSON). */
    extras?: string[]
    /**
     * The call's arguments, as the agent sent them (`rawInput` / `arguments`).
     * Rendered read-only under the header: the real model's view of "it ran
     * `ls -la`" is that line, and the old fold dropped it entirely.
     */
    input?: string
    /** The call's other named fields (`kind`, `status`, `locations`, `terminalId`, `meta`), one `key: value` per line. */
    details?: string[]
    /** The whole notification this block was last written from, pretty-printed. */
    raw?: string
  }
  | { kind: 'plan'; entries: Array<{ content: string; status: string; priority?: string }> }
  /**
   * Any other ACP notification, kept whole: an available-commands list, a mode
   * change, or a kind newer than this build. `text` is the readable fold and
   * `raw` the untouched payload — an agent's word the ACP view cannot format is
   * still an agent's word.
   */
  | { kind: 'event'; event: string; text: string; raw?: string; status?: string }
  | { kind: 'notice'; tone: 'info' | 'error'; text: string }

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
  return permissions.filter(permission => permission.dshSessionId === dshSessionId)
}

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

/**
 * One observed ACP transcript, keyed by ACP session id. This is the ACP view
 * tab's data source: the native chat plane can only render text/reasoning
 * (that is the LLM adapter's entire chunk vocabulary), so the real tool calls,
 * plans and diffs live here and nowhere else.
 */
export interface ChatTranscript {
  /** The DSH chat session this ACP session belongs to (its refetch address). */
  owner: string
  session: SessionView
  blocks: Block[]
  /** Highest folded transcript seq (gap detection for the live stream). */
  seq: number
}

/** The record/detail index key: one `childId` may repeat across conversations. */
export function subagentKey(dshSessionId: string, childId: string): string {
  return `${dshSessionId}\u0000${childId}`
}

/**
 * The `toolCallId` behind an `acp:<toolCallId>` child id, or '' when it is not
 * one. Hand-copied from `src/impl.ts` (the browser half must not import the
 * Node half); the equivalence is pinned in tests/acp-view.spec.ts.
 */
export function subagentToolCallId(childId: string): string {
  return childId.startsWith('acp:') ? childId.slice('acp:'.length) : ''
}

/** How many workers' detail indexes the browser keeps at once (LRU eviction). */
export const MAX_SUBAGENT_DETAIL_WORKERS = 64

/** Raw payload budget for one live-captured detail frame; mirrors the host's `ACP_TOOL_RAW_MAX` (equivalence pinned in tests/acp-view.spec.ts). */
export const SUBAGENT_RAW_MAX = 256_000

/** One raw worker entry in the browser's bounded detail index. */
export interface LiveSubagentDetailEntry extends SubagentDetailEntry {
  /**
   * Store-local monotonic order for LIVE-captured frames (absent on history
   * read from the host). A `subagents/detail` answer describes the host as of
   * BEFORE the frames that landed while its read was in flight, so the answer
   * replays them by this mark — the same discipline `chatRowFrames` uses.
   */
  liveSeq?: number
}

/**
 * The browser's per-worker detail index. Fed by live `session/update` frames
 * (NEWEST {@link MAX_SUBAGENT_DETAIL_ENTRIES} entries, older ones counted in
 * {@link omitted}) and, once per page, by an on-demand `subagents/detail` read
 * for the history that predates the page. Deliberately NOT the folded ACP
 * transcript: `foldUpdate` drops `_meta` and merges adjacent prose across
 * workers, and the NTR view must keep rendering what it renders today.
 */
export interface SubagentDetailState {
  dshSessionId: string
  childId: string
  entries: LiveSubagentDetailEntry[]
  /** `subagents/detail` already answered for this worker in this page. */
  loaded: boolean
  /** Older entries missing from the index (host cap + local cap); 0 = starts at the first frame. */
  omitted: number
  /** LRU clock: when the detail was last opened (or first indexed). */
  touchedAt: number
}

/**
 * One line of the settings page's ACP runtime log. Agent-side notices and
 * session-release reasons land here (bounded, append order oldest→newest);
 * failures of the settings page's OWN actions stay in {@link UiState.notice}.
 */
export interface AcpLogEntry {
  id: number
  at: number
  level: 'info' | 'error'
  text: string
  agentId?: string
}

/** Cap on retained runtime-log lines; older entries fall off the front. */
export const LOG_MAX_ENTRIES = 200

/**
 * One page-top save banner. Save failures, expiry, rejection, partial force
 * flushes and the HMR reload delay all share this shape so the overlay renders
 * (and screen readers announce) them the same way.
 */
export type SaveBannerSource =
  | 'save-failed'
  | 'save-expired'
  | 'save-rejected'
  | 'save-partial'
  | 'save-cancel-failed'
  | 'save-cancelled'
  | 'save-retry-none'
  | 'save-retry-failed'
  | 'hmr-delay'
  | 'save-succeeded'
export type SaveBannerAction = 'retry' | 'force' | 'dismiss'

export interface SaveBanner {
  /** Stable identity for dedupe: the same reason replaces, never stacks. */
  key: string
  source: SaveBannerSource
  level: 'error' | 'success'
  title: string
  body: string
  at: number
  actions: SaveBannerAction[]
  /** Which gate label the retry/force gesture targets, when applicable. */
  label?: string
  /** Success banners disappear on their own; failures persist until closed. */
  autoDismissMs?: number
  /**
   * Gate-sourced failure rows are rebuilt by a page refresh's resync; a row the
   * user explicitly closed must stay closed. Rows without this flag (direct save
   * failures, rejection/partial/HMR notices) never cross a refresh at all.
   */
  persistAcrossReload?: boolean
}

/**
 * Add or replace one banner. Failure rows are never dropped by count; only one
 * transient success row is kept among successes. A NEW failure does not evict
 * an existing success receipt: that row owns its own 2.5-second timer, and an
 * error arriving beside it must not cut that timer short.
 */
export function composeSaveBanners(existing: SaveBanner[], incoming: SaveBanner): SaveBanner[] {
  const withoutSame = existing.filter(banner => banner.key !== incoming.key)
  const base = incoming.level === 'success'
    ? withoutSame.filter(banner => banner.level !== 'success')
    : withoutSame
  return [...base, incoming]
}

/** sessionStorage record of persistent banners the user closed, keyed by row key. */
const SAVE_BANNER_DISMISSALS_KEY = 'dsh-ntr.save-banner-dismissals'

function readBannerDismissals(): Record<string, number> {
  try {
    const raw = globalThis.sessionStorage?.getItem(SAVE_BANNER_DISMISSALS_KEY)
    if (raw === undefined || raw === null || raw === '') return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function rememberBannerDismissal(banner: SaveBanner): void {
  if (banner.persistAcrossReload !== true || banner.level !== 'error') return
  try {
    const dismissed = readBannerDismissals()
    dismissed[banner.key] = banner.at
    globalThis.sessionStorage?.setItem(SAVE_BANNER_DISMISSALS_KEY, JSON.stringify(dismissed))
  } catch {
    // Storage can be unavailable (private mode); the in-memory row is still closed.
  }
}

function wasClosedAcrossReload(banner: SaveBanner): boolean {
  if (banner.persistAcrossReload !== true) return false
  return readBannerDismissals()[banner.key] === banner.at
}

/**
 * Whether the host actually runs the save gate. A snapshot without the field
 * (an older host, or a backend that never wired the gate) is NOT an idle
 * authority: its empty `activeSessions` must never be read as "no turn".
 */
export function saveGateIsAvailable(status: SaveGateStatus): boolean {
  return status.gateAvailable === true
}

function normalizeSaveGateStatus(status: SaveGateStatus): SaveGateStatus {
  return { ...status, gateAvailable: saveGateIsAvailable(status) }
}

/** `agent-save:<id>` → the agent id; a host-settings label (`settings:…`) → undefined. */
export function saveGateAgentId(label: string): string | undefined {
  const prefix = 'agent-save:'
  if (!label.startsWith(prefix)) return undefined
  const id = label.slice(prefix.length)
  return id === '' ? undefined : id
}

/** One agent a forced flush would interrupt, with the number of its live turns. */
export interface SaveGateInterruptTarget {
  agentId: string
  name: string
  sessions: number
}

/**
 * Which agents the "save everything now" gesture would interrupt, and how many
 * turns each owes. Reads the gate snapshot first; when it carries no session row
 * for an agent (an older host half, or a not-yet-hydrated window), the browser's
 * own session list supplies the same count — the fallback the settings form
 * already uses (`activeSessionsForSave`). This never assumes host fields beyond
 * `pending` / `activeSessions`; those are the snapshot's public shape.
 */
export function saveGateInterruptTargets(
  status: SaveGateStatus,
  agents: readonly AgentView[],
  detected: readonly DetectedAgentInfo[],
  sessions: readonly SessionView[],
): SaveGateInterruptTarget[] {
  const ids: string[] = []
  const add = (id: string): void => {
    if (!ids.includes(id)) ids.push(id)
  }
  for (const entry of status.pending) {
    const id = saveGateAgentId(entry.label)
    if (id !== undefined) add(id)
  }
  // A host-settings save still interrupts whoever is running: fall back to the
  // gate's own active-turn rows when no pending label names an agent.
  if (ids.length === 0) {
    for (const view of status.activeSessions ?? []) add(view.agentId)
  }
  const trustGate = saveGateIsAvailable(status)
  return ids.map(agentId => {
    let count = trustGate
      ? (status.activeSessions ?? []).filter(view => view.agentId === agentId).length
      : 0
    if (count === 0) {
      count = sessions.filter(session =>
        session.agentId === agentId && session.released !== true && (session.running || session.settled === true),
      ).length
    }
    return {
      agentId,
      name: agents.find(agent => agent.id === agentId)?.title
        ?? detected.find(info => info.id === agentId)?.name
        ?? agentId,
      sessions: count,
    }
  })
}

/** The terminal result naming one label, whichever snapshot shape carries it. */
export function saveGateOutcomeForLabel(
  status: SaveGateStatus,
  label: string,
): SaveGateOutcomeView | undefined {
  return status.lastOutcomes?.[label]
    ?? (status.lastOutcome?.label === label ? status.lastOutcome : undefined)
}

/** A `cancelled` row the host replaced with a newer queued snapshot. */
export function saveGateOutcomeSuperseded(outcome: SaveGateOutcomeView): boolean {
  return outcome.superseded === true
}

/** One terminal label transition, as seen between two gate snapshots. */
export interface SaveGateOutcomeTransition {
  label: string
  outcome: SaveGateOutcomeView
  /** The label was still queued in the previous snapshot. */
  wasPending: boolean
  /** The label is still queued in the new snapshot. */
  isPending: boolean
}

/**
 * Compare two gate snapshots. Pure: the SSE path and `resync` both feed this
 * so a page refresh rebuilds the terminal rows it missed. A terminal entry is
 * "new" when its timestamp or status changed; pending additions are reported
 * apart because only the caller knows whether that deserves a log line.
 */
export function saveGateTransitions(
  previous: SaveGateStatus | undefined,
  next: SaveGateStatus,
): { addedPending: SaveGatePendingView[]; outcomes: SaveGateOutcomeTransition[] } {
  const previousOutcomes: Record<string, SaveGateOutcomeView> = previous?.lastOutcomes
    ?? (previous?.lastOutcome === undefined ? {} : { [previous.lastOutcome.label]: previous.lastOutcome })
  const nextOutcomes: Record<string, SaveGateOutcomeView> = next.lastOutcomes
    ?? (next.lastOutcome === undefined ? {} : { [next.lastOutcome.label]: next.lastOutcome })
  const wasPending = new Set((previous?.pending ?? []).map(entry => entry.label))
  const isPending = new Set(next.pending.map(entry => entry.label))
  const addedPending = next.pending.filter(entry => !wasPending.has(entry.label))
  const outcomes: SaveGateOutcomeTransition[] = []
  for (const [label, outcome] of Object.entries(nextOutcomes)) {
    const before = previousOutcomes[label]
    if (before !== undefined && before.at === outcome.at && before.status === outcome.status) continue
    outcomes.push({ label, outcome, wasPending: wasPending.has(label), isPending: isPending.has(label) })
  }
  return { addedPending, outcomes }
}

export interface UiState {
  open: boolean
  /**
   * Bumped by {@link AcpStore.refreshLocale}. Labels resolve while rendering,
   * but memoized transcript rows compare props — this counter is what tells
   * them the language switched.
   */
  localeRev: number
  stream: 'init' | 'live' | 'down'
  agents: AgentView[]
  /**
   * Whether the host has answered `agents/list` at least once in this page.
   * `agents: []` alone cannot tell "no agent configured" from "not read yet";
   * a surface that offers a setup entry on an empty roster must wait for this.
   */
  agentsLoaded: boolean
  /**
   * Agent ids deleted during THIS page's lifetime. The host keeps a tombstone
   * for the same run, but a client-side copy lets the creation form warn before
   * a doomed save. Cleared only by a host restart, never by `resync`.
   */
  deletedAgentIds: string[]
  sessions: SessionView[]
  activeSessionId?: string
  blocks: Block[]
  permissions: PendingPermission[]
  busy: boolean
  /**
   * The settings page's one-line banner for its OWN action failures. Agent-side
   * runtime messages do not land here; they append to {@link logs} instead.
   */
  notice?: string
  /** Page-top save banners; failures stay until dismissed, success auto-hides. */
  saveBanners: SaveBanner[]
  /** Agent-side runtime log, append order oldest→newest, capped at {@link LOG_MAX_ENTRIES}. */
  logs: AcpLogEntry[]
  /** Lines appended since the user last opened the log; reset by {@link AcpStore.markLogsRead}. */
  logUnread: number
  /**
   * The plugin's OWN default ACP agent (the panel's ★ gesture) — which agent a
   * new ACP-mode conversation starts on. NOT the deployment default model: that
   * one is global to every mode, and nothing in this bundle writes it.
   */
  defaultAgent?: string
  detectedAgents: DetectedAgentInfo[]
  detecting: boolean
  /**
   * Outcome of the last explicit re-detect (`重新检测与刷新`). Detection
   * usually finds exactly what the panel already renders — without this line
   * the button reads as dead. Set only by an explicit click, not the ambient
   * resync, and cleared again when that click's detection fails (a stale success
   * line next to the failure notice reads as if nothing happened).
   */
  detectSummary?: string
  /** Probed model catalogs per agent id (from `agent/probe-models`). */
  modelCatalogs: Record<string, AgentProbeModelsResult>
  /**
   * Per-agent ACP model surfaces (from `agent/catalog`) — the data source for
   * the conversation-side chips and the ACP-mode model seat. Kept apart from
   * {@link modelCatalogs} on purpose: that one is the panel's full probe
   * result (every choice an agent published), while this is the filtered,
   * ready-to-render list the seats offer.
   */
  seatCatalogs: Record<string, AgentCatalogResult>
  probingModels: Record<string, boolean>
  /**
   * Last probe failure per agent id, rendered next to the button that
   * triggered it. `notice` alone is not enough: it lives at the top of the
   * settings panel, so a probe failing below the fold (missing cwd, an agent
   * that never answers, …) reads as a dead button.
   */
  probeErrors: Record<string, string>
  /**
   * ACP agent sessions backing the chat session the composer control sits in.
   * Only meaningful together with {@link chatSessionsFor}: the control reads it
   * by chat session id, so a stale list from another conversation never renders.
   */
  chatSessions: ChatSessionView[]
  /** The DSH chat session id {@link chatSessions} was loaded for. */
  chatSessionsFor?: string
  /**
   * Live burst aggregate per ACP session id, from `turn/metrics`. Absent means
   * no measured burst yet; a row's persisted `burst` is the reload seed.
   */
  burstStats: Record<string, { outputTokens: number; burstMs: number; turnId: string; final: boolean }>
  /**
   * The agent tag's halo preference (settings-editable display choice). The
   * tag reads it per render; the host answer in `resync` is the authority and
   * a write lands optimistically first.
   */
  tagHalo: AcpTagHalo
  /**
   * The approval deadlines in force, as the settings card edits them. Absent on
   * a host half from before the card existed, which hides the card rather than
   * showing a number this browser invented. Writes land optimistically and the
   * host answer (returned by the same route) is the authority.
   */
  approvalDeadlines?: AcpApprovalDeadlines
  /**
   * The idle-release window in force, as the settings page edits it.
   * Absent on a host half from before the tab existed, which hides the
   * tab rather than showing a number this browser invented.
   */
  idleRelease?: AcpIdleRelease
  /**
   * The host's ACP-turn save gate. A pending entry means a profile write is
   * held until the turn finishes; the toast renders it and offers the explicit
   * force gesture. Absent from older hosts: the local default reads "idle".
   */
  saveGate: SaveGateStatus
  /**
   * Per-chat-session "does this conversation run the ACP preset" verdicts, as
   * reported by `session/chat-list` (host-read from the session log). The
   * composer surfaces fall back to this when the client runtime's session rows
   * carry no `agentPreset` (older hosts); a session never asked about is simply
   * absent.
   */
  acpMode: Record<string, boolean>
  /**
   * The plugin's OWN lifecycle records for external workers, keyed by
   * {@link subagentKey} (`dshSessionId + childId`). Live transitions arrive as
   * `subagents/record` frames; a `session/chat-list` answer carries the
   * terminal ones, so a reload or a host restart still answers them. The
   * panel LIST is still joined from the host's own catalog projection — a
   * catalog row with no record reads `unknown`, never succeeded.
   */
  subagents: Record<string, SubagentRecord>
  /**
   * Raw per-worker detail indexes (bounded, LRU-capped at
   * {@link MAX_SUBAGENT_DETAIL_WORKERS}), keyed like {@link subagents}. An
   * entry exists only once its detail was opened in this page; from then on
   * live frames append to it, and the first open reads history from
   * `subagents/detail`.
   */
  subagentDetails: Record<string, SubagentDetailState>
  /**
   * Per-chat-session ACP agent binding, as reported by `session/chat-list`'s
   * `boundAgentId` (the host's intent map plus its live-session fallback): who
   * serves this conversation's NEXT message. `session/chat-bind` writes the
   * optimistic entry here the moment the click succeeds — the live session
   * list cannot reflect a switch until a turn materializes a session for the
   * new agent, and the chip would otherwise keep naming the previous agent.
   */
  chatBoundAgent: Record<string, string>
  /**
   * Per-chat-session agent lock, as reported by `chat/agent-locked` (the live
   * path) or `session/chat-list`'s `lockedAgentId` (the fallback): the first
   * ACP turn has STARTED, so this conversation belongs to that agent and
   * cannot be switched. The lock is provisional until that turn shows
   * something; `chat/agent-unlocked` removes it when it delivers nothing. The
   * composer hides its agent base and shows a read-only tag for this agent.
   * The id is kept even when the agent has been deleted from the roster — the
   * conversation is still locked to it.
   */
  chatLockedAgent: Record<string, string>
  /**
   * Per-chat-session serial for a lock THIS page saw arrive — bumped by the
   * `chat/agent-locked` frame (the live path, sent when the first turn starts)
   * or by a later `session/chat-list` answer that first reports `lockedAgentId`
   * (the fallback when the frame was missed). A rolled-back first turn followed
   * by a retry therefore gets a fresh serial, and its ceremony plays again.
   *
   * This is the animation's trigger, and the reason it cannot replay on a page
   * load: a conversation that is already locked when its list is first read
   * has no entry here. The composer's base and its edge tag
   * (`agent-lock-anim.ts`) play the shatter/condense hand-off only for a serial
   * they have not consumed.
   */
  agentLockReveal: Record<string, number>
  /**
   * The conversation's persisted pick — model and thought level — as reported by
   * `session/chat-list`'s `choice`, and written optimistically the moment a
   * picker commits one.
   *
   * This is the record that makes a conversation usable BEFORE it has ever run
   * a turn: without it the model / thought-level chips can only reflect a live
   * ACP session, which does not exist until the first message has already gone
   * out on whatever the agent's defaults were.
   */
  chatChoice: Record<string, AcpConversationChoice>
  /**
   * The model-seat shadow gate's own account of what it last decided, and why
   * (`src/client/index.tsx`'s `syncAcpMode`). Read-only, human-facing, and
   * rendered by the ACP view: every branch of that gate ends with the native
   * model seat either shadowed or not, and without this line the four ways it
   * can end "not shadowed" are indistinguishable from the outside — which is
   * exactly how "the ACP base still has not been replaced" became unreadable.
   */
  seatDiag: string
  /**
   * Diagnostic summary from the permission-seat blanking gate (`conversation.input.permission`).
   */
  permissionSeatDiag: string
  /**
   * Why slash isolation is not in force, when it is not (`idle` while it is).
   * Isolation degrades OPEN — an unrecognized source shape leaves the host's
   * commands in charge — so without this line the only symptom would be a menu
   * that quietly lists the wrong commands.
   */
  slashDiag: string
  /**
   * Observed ACP transcripts keyed by ACP session id. Only sessions the
   * conversation's ACP view asked for are watched (live `session/update`
   * frames fold straight into them), and the map is capped so a long browsing
   * session cannot accumulate every transcript it ever looked at.
   */
  chatTranscripts: Record<string, ChatTranscript>
  /**
   * State of the host's ACP-mode agent preset IN THE HARNESS ROSTER (the entry
   * the new-session picker shows). `undefined` when the host serves no roster
   * (`preset/status` answering `null`), in which case the panel hides the block.
   */
  preset?: AcpPresetStatus
  /**
   * The installed host package's version (`plugin/version`), rendered as the
   * settings page badge. Absent on a host half without the endpoint, which
   * hides the badge rather than naming a version this browser invented.
   */
  pluginVersion?: string
  /**
   * The running version and its update status (`plugin/update-check`). Absent
   * on a host half without the endpoint, which hides the update entry instead
   * of offering an install this browser cannot perform.
   */
  pluginUpdate?: PluginUpdateState
}

interface Listener { (): void }

const MAX_BLOCKS = 400
/** How many observed ACP transcripts stay live at once (insertion-ordered eviction). */
const MAX_WATCHED = 6

/** Raw JSON budget for one event block; the cut is marked. */
const RAW_MAX = 256_000

/**
 * How long a fetched update state stays fresh. The settings panel asks on every
 * mount; without this, every open would hit the registry. A forced check (the
 * card's own button) always goes out.
 */
const PLUGIN_UPDATE_TTL_MS = 10 * 60 * 1000

/** Pretty-printed JSON of an agent message (never throws, cuts only at {@link RAW_MAX} with a marker). */
export function jsonText(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > RAW_MAX
    ? `${text.slice(0, RAW_MAX)}\n… [truncated ${String(text.length - RAW_MAX)} chars]`
    : text
}

/**
 * The call's arguments as the agent sent them. Accepts every spelling seen in
 * the wild (`rawInput` / `arguments`, string / object / array) and never
 * invents one: a call with no input gets `undefined`.
 */
export function toolInputOf(update: Record<string, unknown>): string | undefined {
  for (const key of ['rawInput', 'arguments'] as const) {
    const value = update[key]
    if (typeof value === 'string') {
      if (value !== '') return value
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 0) return JSON.stringify(value, null, 2)
      continue
    }
    if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2)
  }
  return undefined
}

/** The call's other named fields, one `key: value` per line. */
export function toolDetailsOf(update: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const key of ['kind', 'status', 'locations', 'terminalId', 'meta'] as const) {
    const value = update[key]
    if (value === undefined || value === null || value === '') continue
    if (key === 'locations' && Array.isArray(value) && value.length === 0) continue
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  return lines
}

/** Text a `text` / `thinking` chunk's `content` carries (string, object, or array of blocks). */
function chunkText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item
      if (typeof item === 'object' && item !== null) {
        const row = item as Record<string, unknown>
        return typeof row.text === 'string' ? row.text : JSON.stringify(item)
      }
      return ''
    }).join('')
  }
  if (typeof content === 'object' && content !== null) {
    const row = content as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    return JSON.stringify(content)
  }
  return ''
}

/**
 * One tool call's `content`, split into what the card renders as text
 * ({@link lines}), the structured edits it renders as diffs, and everything
 * else as its own readable text ({@link extras}). Nothing is dropped: a diff is
 * ALSO shown as text (header plus `-`/`+` lines) because the model's view of a
 * tool result is text, and a kind this build cannot render becomes its full
 * JSON.
 */
function splitToolContent(content: unknown): { lines: string[]; diffs?: Array<{ path: string; oldText: string | null; newText: string }>; extras: string[] } {
  const lines: string[] = []
  const extras: string[] = []
  const diffs: Array<{ path: string; oldText: string | null; newText: string }> = []
  if (!Array.isArray(content)) {
    if (typeof content === 'string' && content !== '') lines.push(content)
    return { lines, extras }
  }
  for (const item of content) {
    if (typeof item === 'string') {
      if (item !== '') lines.push(item)
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (row.type === 'content') {
      const inner = row.content as Record<string, unknown> | undefined
      if (typeof inner === 'string') {
        lines.push(inner)
      } else if (inner?.type === 'text') {
        lines.push(typeof inner.text === 'string' ? inner.text : JSON.stringify(item))
      } else if (inner?.type === 'diff' && typeof inner.path === 'string') {
        const diff = { path: inner.path, oldText: typeof inner.oldText === 'string' ? inner.oldText : null, newText: typeof inner.newText === 'string' ? inner.newText : '' }
        diffs.push(diff)
        lines.push(diffText(diff))
      } else {
        extras.push(`${String(inner?.type ?? 'content')} ${JSON.stringify(item)}`)
      }
      continue
    }
    if (row.type === 'diff' && typeof row.path === 'string' && typeof row.newText === 'string') {
      const diff = { path: row.path, oldText: typeof row.oldText === 'string' ? row.oldText : null, newText: row.newText }
      diffs.push(diff)
      lines.push(diffText(diff))
      continue
    }
    if (row.type === 'text' && typeof row.text === 'string') {
      lines.push(row.text)
      continue
    }
    extras.push(`${String(row.type ?? 'content')} ${JSON.stringify(item)}`)
  }
  return { lines, extras, ...(diffs.length === 0 ? {} : { diffs }) }
}

/** A structured edit as plain text: its path, then `-`/`+` lines with three lines of context. */
function diffText(diff: { path: string; oldText: string | null; newText: string }): string {
  const split = (text: string | null): string[] => text === null || text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  const oldLines = split(diff.oldText)
  const newLines = split(diff.newText)
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  const out: string[] = [diff.path]
  for (let i = Math.max(0, head - 3); i < head; i++) out.push(`  ${oldLines[i] ?? ''}`)
  for (let i = head; i < oldLines.length - tail; i++) out.push(`- ${oldLines[i] ?? ''}`)
  for (let i = head; i < newLines.length - tail; i++) out.push(`+ ${newLines[i] ?? ''}`)
  for (let i = oldLines.length - tail; i < oldLines.length; i++) out.push(`  ${oldLines[i] ?? ''}`)
  return out.join('\n')
}

/** The readable fold of a notification the view has no card of its own for. */
export function describeEvent(kind: string, update: Record<string, unknown>): string {
  if (kind === 'available_commands_update') {
    const commands = Array.isArray(update.availableCommands) ? update.availableCommands : []
    return commands.map(command => {
      const row = (typeof command === 'object' && command !== null ? command : {}) as Record<string, unknown>
      const name = typeof row.name === 'string' ? row.name : ''
      const description = typeof row.description === 'string' && row.description !== '' ? ` — ${row.description}` : ''
      return `${name}${description}`
    }).join('\n')
  }
  if (kind === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : []
    return entries.map(entry => {
      const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
      return `[${String(row.status ?? 'pending')}] ${String(row.content ?? '')}`
    }).join('\n')
  }
  if (kind === 'current_mode_update' && typeof update.currentModeId === 'string') return update.currentModeId
  return ''
}

export const DEFAULT_KNOWN_PRESETS: DetectedAgentInfo[] = [
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    description: 'Automata / Pi Coding Agent with native ACP bridge support',
    detected: false,
    defaultCommand: 'pi-acp',
    defaultArgs: [],
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    description: 'Oh My Pi (pi-based coding agent) — run as `omp acp` over stdio',
    detected: false,
    defaultCommand: 'omp',
    defaultArgs: ['acp'],
  },
  // Hand copy of the host's `AGENT_PRESETS` entry (src/bridge.ts): the panel
  // falls back to this list before the first `agents/detect` round-trip.
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    description: 'Tencent CodeBuddy Code — run as `codebuddy --acp` over stdio',
    detected: false,
    defaultCommand: 'codebuddy',
    defaultArgs: ['--acp'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Claude Agent SDK adapter — run as `npx -y @agentclientprotocol/claude-agent-acp` over stdio',
    detected: false,
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex adapter — run as `npx -y @agentclientprotocol/codex-acp` over stdio',
    detected: false,
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/codex-acp'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI — run as `gemini --experimental-acp` over stdio',
    detected: false,
    defaultCommand: 'gemini',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode — run as `opencode acp` over stdio',
    detected: false,
    defaultCommand: 'opencode',
    defaultArgs: ['acp'],
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    description: 'Cursor CLI — run as `agent acp` over stdio (legacy alias `cursor-agent acp`)',
    detected: false,
    defaultCommand: 'agent',
    defaultArgs: ['acp'],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: 'Qwen Code — run as `qwen --experimental-acp` over stdio',
    detected: false,
    defaultCommand: 'qwen',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    description: 'Kiro CLI — run as `kiro-cli acp` over stdio',
    detected: false,
    defaultCommand: 'kiro-cli',
    defaultArgs: ['acp'],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    description: 'Qoder CLI — run as `qodercli --acp` over stdio',
    detected: false,
    defaultCommand: 'qodercli',
    defaultArgs: ['--acp'],
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    description: 'Qoder CLI (China) — run as `qoderclicn --acp` over stdio',
    detected: false,
    defaultCommand: 'qoderclicn',
    defaultArgs: ['--acp'],
  },
]

export class AcpStore {
  private state: UiState = {
    open: false,
    localeRev: 0,
    stream: 'init',
    agents: [],
    agentsLoaded: false,
    deletedAgentIds: [],
    sessions: [],
    blocks: [],
    permissions: [],
    busy: false,
    saveBanners: [],
    logs: [],
    logUnread: 0,
    detectedAgents: [...DEFAULT_KNOWN_PRESETS],
    detecting: false,
    modelCatalogs: {},
    seatCatalogs: {},
    probingModels: {},
    probeErrors: {},
    chatSessions: [],
    burstStats: {},
    tagHalo: { ...DEFAULT_TAG_HALO },
    approvalDeadlines: undefined,
    idleRelease: undefined,
    saveGate: {
      canSave: true,
      gateAvailable: false,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: DEFAULT_SAVE_GATE_TIMEOUT_MS,
    },
    chatTranscripts: {},
    acpMode: {},
    subagents: {},
    subagentDetails: {},
    chatBoundAgent: {},
    chatLockedAgent: {},
    agentLockReveal: {},
    chatChoice: {},
    seatDiag: 'idle',
    permissionSeatDiag: 'idle',
    slashDiag: 'idle',
  }

  private readonly listeners = new Set<Listener>()
  private source?: EventSource
  /** Monotonic id source for {@link AcpLogEntry}s (never reset by `clearLogs`). */
  private logSeq = 0
  /**
   * What a banner's retry/force button can actually do. Kept out of UiState so
   * the snapshot stays plain data; a dismissed banner drops its entry, which is
   * why the same failure can show again next time.
   */
  private readonly bannerRetries = new Map<string,
    | { kind: 'gate'; label: string }
    | { kind: 'cancel'; label: string }
    | { kind: 'flush' }
    | { kind: 'payload'; payload: AgentSavePayload }
  >()
  private readonly lastSeq = new Map<string, number>()
  /** Sessions with a finalized turn (dedups the cancel-fallback + late real turn/end pair). */
  private readonly openTurns = new Set<string>()
  /** In-flight `session/chat-list` reads, keyed by chat session id. */
  private readonly chatSessionReads = new Map<string, { dropped: boolean; done: Promise<void> }>()
  /**
   * Monotonic order plus a short log of chat-row lifecycle frames. Read
   * starts capture the sequence; the answer replays every later frame over
   * its row list. Bounded — a read only needs the frames since it started, and
   * a page that never reconnects cannot grow this without bound.
   */
  private chatRowFrameSeq = 0
  private readonly chatRowFrames: ChatRowFrame[] = []
  /**
   * Chat sessions whose list has answered at least once in this page. The
   * FIRST answer only seeds the lock; a lock appearing on a later answer is a
   * transition this page actually witnessed, and only that one is announced via
   * {@link UiState.agentLockReveal}.
   */
  private readonly chatListLoaded = new Set<string>()
  /**
   * Conversations whose provisional first-turn lock the host rolled back
   * (`chat/agent-unlocked`, no visible output in the first turn). A
   * `session/chat-list` read that started BEFORE the rollback can still name
   * `lockedAgentId`; it must not revive the lock. A new `chat/agent-locked`
   * frame clears the entry (the user retried and the turn really started).
   */
  private readonly chatUnlocked = new Set<string>()
  /**
   * Sessions whose ACP-mode verdict a committed `agent-preset/selected` frame
   * settled. A frame settles the verdict; the host's log read can lag a switch
   * by one (the appended row is not yet visible to a fresh read, and the seat
   * taking the model cell re-mounts readers), so a read may only settle a
   * session no frame has spoken for — otherwise a stale answer would regress a
   * verdict the runtime already told us the truth about.
   *
   * The ONE exception is the gate's own re-ask ({@link loadChatSessions} with
   * `settleVerdict`): a verdict the gate has held as its only fact source for
   * longer than its TTL is exactly the case where the frame path has gone
   * quiet, and without an authorized re-read a switch the runtime never framed
   * could never be corrected.
   */
  private readonly acpModeLive = new Set<string>()
  /**
   * Monotonic order plus a short log of applied `subagents/record` frames: a
   * `session/chat-list` answer can describe the host as of BEFORE a frame that
   * landed while the read was in flight, and the answer replays the later
   * frames over its snapshot.
   */
  private subagentRecordSeq = 0
  private readonly subagentRecordFrames: Array<{ seq: number; dshSessionId: string; record: SubagentRecord }> = []
  /** Store-local order for live-captured detail entries (see {@link LiveSubagentDetailEntry.liveSeq}). */
  private detailLiveSeq = 0
  /**
   * ACP session id → owning DSH chat session id, learned from chat-list rows
   * and `turn/metrics` frames. Live `session/update` frames carry only the ACP
   * session, and a detail entry must land under the conversation that owns it
   * (`toolCallId`s can repeat across conversations).
   */
  private readonly acpSessionOwners = new Map<string, string>()
  /**
   * Chat sessions whose host read came back WITHOUT a verdict (no `acpMode`
   * field, or the read failed). The seat gate consults this to retract its
   * one-shot ask ledger entry, so a read that could not answer costs one retry
   * instead of leaving the native model seat visible for the rest of the page.
   */
  private readonly acpModeUnsettled = new Set<string>()
  /** In-flight `agent/catalog` reads, keyed by agent id. */
  private readonly seatCatalogReads = new Set<string>()
  /** In-flight `agent/cached-models` reads, keyed by agent id. */
  private readonly cachedModelReads = new Set<string>()
  /** Counts behind the last successful explicit re-detect, so a locale switch can re-render its summary. */
  private detectCounts: { total: number; installed: number } | undefined
  /** When {@link UiState.pluginUpdate} was last read from the host (epoch ms). */
  private pluginUpdateFetchedAt = 0
  /**
   * The shared in-flight `plugin/update-check`. The settings section mounts
   * twice (both entries) and the update popover asks too; without this, two
   * mounts in the same tick each fire their own registry read.
   */
  private pluginUpdateInflight?: Promise<PluginUpdateState | undefined>
  /** Re-entry guard for `plugin/update-apply` (a double click is one install). */
  private pluginUpdateApplying = false
  /**
   * Update read generation. An apply bumps it so a check that was already in
   * flight (started before the install) cannot land afterwards and overwrite
   * the install's verdict with the pre-install `available`.
   */
  private pluginUpdateGeneration = 0

  constructor(private readonly rpc: RpcCall, private readonly locale: (zh: string, en: string) => string) {}

  // ---- React bridge ----

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): UiState {
    return this.state
  }

  private mutate(patch: Partial<UiState>, blocksChanged = false): void {
    this.state = {
      ...this.state,
      ...patch,
      blocks: blocksChanged ? [...this.state.blocks] : patch.blocks ?? this.state.blocks,
    }
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Build the log patch for one line. Does NOT mutate: the caller merges it
   * into the single `mutate` call it was already making for the same event.
   */
  private logPatch(level: 'info' | 'error', text: string, agentId?: string): Pick<UiState, 'logs' | 'logUnread'> {
    const entry: AcpLogEntry = {
      id: ++this.logSeq,
      at: Date.now(),
      level,
      text,
      ...(agentId === undefined ? {} : { agentId }),
    }
    return {
      logs: [...this.state.logs, entry].slice(-LOG_MAX_ENTRIES),
      logUnread: this.state.logUnread + 1,
    }
  }

  // ---- Streaming update coalescing ----

  /**
   * Live `session/update` frames waiting to be folded. Agents stream at token
   * granularity — hundreds of frames a second with usage ticks interleaved —
   * and folding plus notifying listeners per frame re-rendered every store
   * consumer per chunk. Frames are coalesced into ONE fold + ONE mutate per
   * animation frame instead; the order inside a batch is preserved, and the
   * transcript watermark (`lastSeq`) advances per batch.
   */
  private readonly pendingUpdates: Array<{ sessionId: string; seq: number; update: unknown }> = []
  private updateFlushArmed = false

  /** Fold everything pending now (idempotent; the scheduler clears its flag). */
  flushUpdates(): void {
    const batch = this.pendingUpdates.splice(0, this.pendingUpdates.length)
    this.updateFlushArmed = false
    if (batch.length === 0) return
    const bySession = new Map<string, Array<{ seq: number; update: unknown }>>()
    for (const item of batch) {
      const list = bySession.get(item.sessionId)
      if (list === undefined) bySession.set(item.sessionId, [item])
      else list.push(item)
    }
    let chatTranscripts = this.state.chatTranscripts
    let chatSessions = this.state.chatSessions
    let subagentDetails = this.state.subagentDetails
    let blocksChanged = false
    for (const [sessionId, items] of bySession) {
      const last = items[items.length - 1]
      // A worker's detail index is fed BEFORE the active-session split: the
      // conversation that dispatched it is not necessarily the ACP view's
      // active transcript, and the two never share the fold.
      const owner = this.acpSessionOwners.get(sessionId)
      if (owner !== undefined) {
        const folded = this.foldSubagentDetailFrames(owner, items, subagentDetails)
        if (folded !== undefined) subagentDetails = folded
      }
      // `usage_update` is state, not stream content: it never becomes a block,
      // but both observed snapshots that carry usage must move with it —
      // otherwise the ACP view header and the composer's occupancy ring only
      // refresh when some other RPC re-reads the session.
      const usage = usageOfBatch(items)
      if (usage !== undefined) chatSessions = withSessionUsage(chatSessions, sessionId, usage)
      // The observed transcript folds every frame (a watched session's cards
      // and prose); blocks are copied only when something actually changed, so
      // a usage-only tick costs one record object, not a re-render payload.
      const record = chatTranscripts[sessionId]
      if (record !== undefined) {
        let changed = false
        for (const item of items) {
          if (foldUpdate(record.blocks, item.update as Record<string, unknown>)) changed = true
        }
        const session = usage !== undefined && !sameUsage(record.session.usage, usage)
          ? { ...record.session, usage }
          : record.session
        chatTranscripts = {
          ...chatTranscripts,
          [sessionId]: { ...record, session, seq: last.seq, ...(changed ? { blocks: [...record.blocks] } : {}) },
        }
      }
      if (sessionId !== this.state.activeSessionId) {
        this.lastSeq.set(sessionId, last.seq)
        continue
      }
      const seen = this.lastSeq.get(sessionId)
      const contiguous = seen === undefined
        || (items[0].seq === seen + 1 && items.every((item, index) => index === 0 || item.seq === items[index - 1].seq + 1))
      this.lastSeq.set(sessionId, last.seq)
      if (!contiguous) {
        void this.loadTranscript(sessionId) // gap detected → replay
        continue
      }
      for (const item of items) {
        if (foldUpdate(this.state.blocks, item.update as Record<string, unknown>)) blocksChanged = true
      }
    }
    const patch: Partial<UiState> = {}
    if (chatTranscripts !== this.state.chatTranscripts) patch.chatTranscripts = chatTranscripts
    if (chatSessions !== this.state.chatSessions) patch.chatSessions = chatSessions
    if (subagentDetails !== this.state.subagentDetails) patch.subagentDetails = subagentDetails
    if (blocksChanged) patch.blocks = [...this.state.blocks]
    if (Object.keys(patch).length > 0) this.mutate(patch)
  }

  /**
   * Append the frames of one batch that belong to an OPEN worker detail index
   * (see {@link UiState.subagentDetails}). Both filters are required: the
   * dispatch's own frames (`toolCallId` — raw input and the terminal frame
   * live there) and the worker's frames
   * (`_meta["codebuddy.ai/parentToolCallId"]`). Scoped by the ACP session's
   * owning conversation, never by `childId` alone.
   *
   * Returns the next map, or `undefined` when nothing matched.
   */
  private foldSubagentDetailFrames(
    owner: string,
    items: ReadonlyArray<{ seq: number; update: unknown }>,
    currentMap: Record<string, SubagentDetailState>,
  ): Record<string, SubagentDetailState> | undefined {
    const keys = Object.keys(currentMap)
    if (keys.length === 0) return undefined
    let out: Record<string, SubagentDetailState> | undefined
    for (const item of items) {
      const update = item.update as Record<string, unknown>
      if (update === null || typeof update !== 'object') continue
      const own = typeof update.toolCallId === 'string' && update.toolCallId !== '' ? update.toolCallId : undefined
      const parent = parentToolCallIdOf(update)
      if (own === undefined && parent === undefined) continue
      for (const key of keys) {
        const detail = (out ?? currentMap)[key]
        if (detail === undefined || detail.dshSessionId !== owner) continue
        const toolCallId = subagentToolCallId(detail.childId)
        if (toolCallId === '') continue
        if (toolCallId !== own && toolCallId !== parent) continue
        if (out === undefined) out = { ...currentMap }
        out[key] = appendSubagentDetailEntry(detail, boundedDetailEntry(item.seq, item.update, ++this.detailLiveSeq))
      }
    }
    return out
  }

  private armUpdateFlush(): void {
    if (this.updateFlushArmed) return
    this.updateFlushArmed = true
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { this.updateFlushArmed = false; this.flushUpdates() })
      return
    }
    // No frame scheduler (a plain Node runtime): fold at once, keeping the
    // same one-mutate-per-batch contract for non-browser consumers.
    this.flushUpdates()
  }

  // ---- Transport ----

  /** Open the shared event stream once; schedule first snapshot fetch. */
  start(): void {
    if (this.source !== undefined) return
    this.connectStream()
  }

  private connectStream(): void {
    const source = new EventSource('/api/acp/stream')
    source.onopen = () => {
      void this.resync()
      this.mutate({ stream: 'live' })
    }
    source.onerror = () => {
      this.mutate({ stream: 'down' })
    }
    source.onmessage = raw => {
      let event: AcpEvent
      try {
        event = JSON.parse(String(raw.data)) as AcpEvent
      } catch {
        return
      }
      void this.applyEvent(event)
    }
    this.source = source
  }

  private async call<T>(endpoint: string, payload: unknown = {}): Promise<T> {
    const result = await this.rpc('/acp', endpoint, payload)
    if (!result.ok) {
      const error = new Error(result.error.message) as Error & { code?: string }
      // Keep the protocol code so a save refusal can be told apart from a
      // transport failure when the banner decides its next-step actions.
      error.code = result.error.code
      throw error
    }
    return result.value as T
  }

  /** Snapshot refresh used on panel open and after a stream outage. */
  async resync(): Promise<void> {
    try {
      const [{ agents }, { sessions }, defaultAgentInfo, detectResult, presetResult, tagHaloResult, deadlinesResult, idleReleaseResult, saveGateResult, versionResult] = await Promise.all([
        this.call<{ agents: AgentView[] }>('agents/list'),
        this.call<{ sessions: SessionView[] }>('sessions/list'),
        // The plugin's OWN default ACP agent — a plugin-private id, not a DSH
        // model route (see `defaultAgent` on the host half).
        this.call<{ agentId?: string }>('default/agent').catch(() => ({} as { agentId?: string })),
        this.call<{ agents: DetectedAgentInfo[] }>('agents/detect').catch(() => null),
        // `null` (host without a preset roster) hides the panel block.
        this.call<{ preset: AcpPresetStatus | null }>('preset/status').catch(() => null),
        // Host without the endpoint (older half) keeps the local default.
        this.call<{ halo: AcpTagHalo }>('ui/tag-halo').catch(() => ({ halo: { ...DEFAULT_TAG_HALO } })),
        // `undefined` (older half) hides the deadline card instead of showing a
        // number this browser made up.
        this.call<ApprovalDeadlinesResult>('ui/approval-deadlines').catch(() => ({ deadlines: undefined })),
        // `undefined` (older half) hides the tab instead of showing a
        // number this browser made up.
        this.call<IdleReleaseResult>('ui/idle-release').catch(() => ({ idleRelease: undefined })),
        // The save gate is optional: an older host answers an unknown endpoint
        // and the local idle default stays in force.
        this.call<{ status: SaveGateStatus }>('save/status').catch(() => null),
        // The settings badge's data source; older halves answer `unknown
        // endpoint`, which hides the badge.
        this.call<PluginVersionResult>('plugin/version').catch(() => null),
      ])
      const detectedAgents = (detectResult && detectResult.agents.length > 0)
        ? detectResult.agents
        : (this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS])
      // A snapshot without `gateAvailable` is an older/non-wired host, not an
      // idle authority. Normalising here keeps every surface honest.
      const nextSaveGate = saveGateResult?.status === undefined
        ? undefined
        : normalizeSaveGateStatus(saveGateResult.status)
      // Absent on an older host: keep the settings-panel card (degraded path).
      this.mutate({
        agents,
        agentsLoaded: true,
        sessions,
        defaultAgent: defaultAgentInfo?.agentId,
        detectedAgents,
        preset: presetResult?.preset ?? undefined,
        tagHalo: tagHaloResult?.halo ?? { ...DEFAULT_TAG_HALO },
        approvalDeadlines: deadlinesResult.deadlines,
        idleRelease: idleReleaseResult.idleRelease,
        ...(nextSaveGate === undefined ? {} : { saveGate: nextSaveGate }),
        // A refresh must rebuild the terminal rows it missed, not only the
        // gate snapshot: the SSE frame that produced them is gone.
        ...(nextSaveGate === undefined
          ? {}
          : this.saveGatePatch(this.state.saveGate, nextSaveGate, false, true)),
        pluginVersion: versionResult?.version !== undefined && versionResult.version !== '' ? versionResult.version : undefined,
      })
      // `sessions/list` is the `/acp` RPC face; the composer's chat rows
      // (agent modes, occupancy) are a separate list. A reconnect must refresh
      // that list too or the ring keeps a pre-outage sample until a turn ends.
      // `force`: a read that began before the outage missed every frame the
      // stream dropped, so its answer must not be reused here.
      if (this.state.chatSessionsFor !== undefined) void this.loadChatSessions(this.state.chatSessionsFor, { force: true })
      const active = this.state.activeSessionId ?? sessions[0]?.sessionId
      if (active !== undefined) await this.loadTranscript(active)
    } catch (error) {
      this.mutate({ notice: String(error instanceof Error ? error.message : error) })
    }
  }

  /**
   * Read the plugin's update state (`plugin/update-check`). Throttled to ten
   * minutes unless `force`: the settings panel asks on mount, and every
   * remount must not hit the registry.
   *
   * An older host serves no such endpoint (`unknown endpoint`). That is a
   * normal degradation, not an error worth a notice: the answer is `undefined`
   * and the panel simply keeps its update entry hidden.
   */
  async checkPluginUpdate(force = false): Promise<PluginUpdateState | undefined> {
    // One read for every caller while it is in flight, force included: the
    // settings page and the popover mounting together must not hit the
    // registry twice.
    if (this.pluginUpdateInflight !== undefined) return this.pluginUpdateInflight
    const current = this.state.pluginUpdate
    if (!force && current !== undefined && Date.now() - this.pluginUpdateFetchedAt < PLUGIN_UPDATE_TTL_MS) {
      return current
    }
    const generation = this.pluginUpdateGeneration
    const inflight = this.readPluginUpdate(generation)
    this.pluginUpdateInflight = inflight
    try {
      return await inflight
    } finally {
      this.pluginUpdateInflight = undefined
    }
  }

  private async readPluginUpdate(generation: number): Promise<PluginUpdateState | undefined> {
    try {
      const pluginUpdate = await this.call<PluginUpdateState>('plugin/update-check')
      // An install started while this read was in flight: its answer is
      // already stale, and the install's verdict owns the state now.
      if (generation !== this.pluginUpdateGeneration) return undefined
      this.pluginUpdateFetchedAt = Date.now()
      this.mutate({ pluginUpdate })
      return pluginUpdate
    } catch {
      return undefined
    }
  }

  /**
   * Install one exact version (`plugin/update-apply`). The status flips to
   * `applying` first so the badge answers the click; the host's answer then
   * becomes the state.
   *
   * A failed call does NOT prove the install did not happen: on an HMR host
   * the update uninstalls the plugin before reinstalling it, which can cut the
   * response. Whatever the error, the disk may already carry the new version,
   * so the state becomes `restart-required` (the one neutral verdict for "the
   * running code is not the disk's") with `installed` dropped (unknown, not a
   * fact to display) and the notice asks for a reload rather than restoring
   * `available` and pretending nothing changed.
   */
  async applyPluginUpdate(version: string): Promise<PluginUpdateState | undefined> {
    if (this.pluginUpdateApplying) return undefined
    this.pluginUpdateApplying = true
    // Any check already in flight predates the install; its answer must not
    // land on top of the install's verdict.
    this.pluginUpdateGeneration += 1
    const previous = this.state.pluginUpdate
    if (previous !== undefined) {
      this.mutate({ pluginUpdate: { ...previous, status: 'applying' } })
    }
    try {
      const pluginUpdate = await this.call<PluginUpdateState>('plugin/update-apply', { version })
      this.pluginUpdateFetchedAt = Date.now()
      this.mutate({ pluginUpdate })
      return pluginUpdate
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The disk state is UNKNOWN here: the install may have completed before
      // the response was cut. Keep `latest` for display, drop `installed` so no
      // surface can claim a disk version we never read, and reset the throttle
      // so the next check actually asks the host instead of serving this
      // unknown verdict for ten minutes.
      const interrupted: PluginUpdateState = previous !== undefined
        ? { ...previous, status: 'restart-required', installed: undefined, message }
        : { status: 'restart-required', current: this.state.pluginVersion ?? '?', message }
      this.pluginUpdateFetchedAt = 0
      this.mutate({
        pluginUpdate: interrupted,
        notice: this.locale(
          '更新请求已中断；请刷新页面确认当前版本。',
          'The update request was interrupted. Reload the page to confirm the installed version.',
        ),
      })
      return undefined
    } finally {
      // Invalidate reads that STARTED during the install: their "applying"
      // answer would otherwise land on top of this call's final verdict.
      this.pluginUpdateGeneration += 1
      this.pluginUpdateApplying = false
    }
  }

  async detectAgents(): Promise<void> {
    this.mutate({ detecting: true })
    try {
      const result = await this.call<{ agents: DetectedAgentInfo[] }>('agents/detect')
      const agents = result.agents.length > 0 ? result.agents : [...DEFAULT_KNOWN_PRESETS]
      const installed = agents.filter(agent => agent.detected).length
      this.detectCounts = { total: agents.length, installed }
      this.mutate({
        detectedAgents: agents,
        detecting: false,
        detectSummary: this.detectSummaryOf(agents.length, installed),
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agents/detect')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活主机检测功能。', 'Host running older version. Please restart dsh web to enable agent detection.')
        : msg
      this.detectCounts = undefined
      this.mutate({
        detecting: false,
        notice,
        detectedAgents: this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS],
        // A failed re-detect must not keep showing the previous run's success line.
        detectSummary: undefined,
      })
    }
  }

  private detectSummaryOf(total: number, installed: number): string {
    return this.locale(
      `已检测 ${String(total)} 个预设：${String(installed)} 个已安装，其余可从「添加智能体」启用。`,
      `Detected ${String(total)} presets: ${String(installed)} installed, enable the rest via "Add agent".`,
    )
  }

  /**
   * Read the host's save gate before a settings save. The host remains the
   * authority (`agent/save` re-checks), but this lets the form show its
   * confirmation without racing a turn.
   */
  async readSaveGate(): Promise<SaveGateStatus> {
    const result = await this.call<{ status: SaveGateStatus }>('save/status')
    const status = normalizeSaveGateStatus(result.status)
    this.mutate({ saveGate: status })
    return status
  }

  /**
   * Save one agent definition. `mode` is the user's explicit gesture:
   * `direct` is the no-turn path, `defer` queues behind turns, `force` flushes
   * the gate and interrupts. The host returns `confirmationRequired` when a
   * turn exists and no explicit mode was supplied; the caller must ask.
   */
  async saveAgent(payload: AgentSavePayload, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    try {
      const result = await this.call<AgentSaveResult>('agent/save', { ...payload, saveMode: mode })
      // A delete won the race: the host aborted silently and wrote nothing.
      // Re-reading the roster or probing the id would chase an agent that no
      // longer exists (and a probe could resurrect its model surface).
      if (result.cancelled === true) return result
      if (result.confirmationRequired || result.deferred) return result
      // This write landed: earlier "not written" receipts for the same agent
      // would now contradict the fresh success. Other agents' rows stay.
      this.clearAgentSaveFailures(payload.id)
      await this.resync()
      // The host probes the catalog right after a save; pull the fresh result
      // so the agent card fills in without a second click.
      void this.probeModels(payload.id)
      return result
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'agent_deleted') {
        // The id is gone for this host run. Offer no retry/force gesture: both
        // would recreate exactly what the user removed, and the host will keep
        // refusing it until a restart.
        this.rememberDeletedAgent(payload.id)
        const key = `save-failed:${payload.id}`
        this.bannerRetries.delete(key)
        const text = this.label(
          '该 Agent 已被删除，本次保存已取消。',
          'This agent was deleted, so this save was cancelled.',
        )
        this.pushSaveBanner({
          key,
          source: 'save-failed',
          level: 'error',
          title: this.label('保存已取消', 'Save cancelled'),
          body: text,
          at: Date.now(),
          actions: ['dismiss'],
          label: `agent-save:${payload.id}`,
        })
        this.mutate({ notice: text })
        throw error
      }
      const key = code === 'confirmation_required' ? `save-rejected:${payload.id}` : `save-failed:${payload.id}`
      const label = `agent-save:${payload.id}`
      const body = code === 'confirmation_required'
        ? this.label(
            '目标 Agent 还有进行中的会话，本轮保存被拒绝。请选择「回合结束后保存」或「立即保存（中断该 Agent）」。',
            'The target agent still has running turns, so the save was refused. Choose "save after turns" or "save now (interrupt this agent)".',
          )
        : this.label(
            `配置未写入：${error instanceof Error ? error.message : String(error)}`,
            `The setting was not written: ${error instanceof Error ? error.message : String(error)}`,
          )
      this.bannerRetries.set(key, { kind: 'payload', payload })
      this.pushSaveBanner({
        key,
        source: code === 'confirmation_required' ? 'save-rejected' : 'save-failed',
        level: 'error',
        title: code === 'confirmation_required'
          ? this.label('保存被拒绝', 'Save refused')
          : this.label('保存失败', 'Save failed'),
        body,
        at: Date.now(),
        actions: ['retry', 'force', 'dismiss'],
        label,
      })
      this.flashError(error)
      throw error
    }
  }

  /**
   * Dry-run the connection form: the host spawns a throwaway process from
   * these exact values, handshakes, and tears it down. A reachable-but-broken
   * agent arrives as `{ ok: false }`, not a thrown error; only transport or
   * validation failures reject.
   */
  async testAgent(payload: AgentSavePayload): Promise<AgentTestResult> {
    try {
      return await this.call<AgentTestResult>('agent/test', payload)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/test')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用连接测试功能。', 'Host running older version. Please restart dsh web to enable connection testing.')
        : msg
      this.mutate({ notice })
      throw error
    }
  }

  /**
   * Seed one agent's model panes from the host's PERSISTENT catalog cache
   * (`agent/cached-models`, memory-only: it never spawns).
   *
   * The settings card used to learn a catalog only from `agent/probe-models`,
   * so its panes stayed blank until the user clicked 「检测可用模型」 on every
   * visit — including the models already configured, which are known from the
   * agent definition and the on-disk catalog. This read fills both panes on
   * mount; the probe stays the explicit REFRESH (add what the agent newly
   * publishes, drop what it stopped advertising).
   */
  async loadCachedModels(agentId: string): Promise<void> {
    if (this.state.modelCatalogs[agentId] !== undefined || this.cachedModelReads.has(agentId)) return
    this.cachedModelReads.add(agentId)
    try {
      const result = await this.call<AgentProbeModelsResult | null>('agent/cached-models', { agentId })
      // `null` = this agent never published a catalog. A probe may have landed
      // while this read was in flight; a fresh probe always wins.
      if (result === null || result === undefined || this.state.modelCatalogs[agentId] !== undefined) return
      this.mutate({ modelCatalogs: { ...this.state.modelCatalogs, [agentId]: result } })
    } catch {
      // Older host without the endpoint, or an agent deleted meanwhile: the
      // panes fall back to the selection alone, exactly as before a probe.
    } finally {
      this.cachedModelReads.delete(agentId)
    }
  }

  /** Ask the host to probe one agent's model catalog (spawn + throwaway session). */
  async probeModels(agentId: string): Promise<void> {
    const previousError = this.state.probeErrors[agentId]
    this.mutate({
      probingModels: { ...this.state.probingModels, [agentId]: true },
      probeErrors: this.clearProbeError(agentId),
    })
    try {
      const result = await this.call<AgentProbeModelsResult>('agent/probe-models', { agentId })
      // The seat list is a filtered view of the same catalog: drop the cached
      // one (in the same patch) and re-read below, so a fresh probe lands in an
      // open conversation too.
      const seatCatalogs = { ...this.state.seatCatalogs }
      delete seatCatalogs[agentId]
      this.mutate({
        modelCatalogs: { ...this.state.modelCatalogs, [agentId]: result },
        seatCatalogs,
        probingModels: { ...this.state.probingModels, [agentId]: false },
        // A retry after the user fixed the problem must not leave the old
        // failure pinned at the top of the panel. Only drop the notice when it
        // is still ours — anything newer belongs to someone else.
        ...(previousError !== undefined && this.state.notice === previousError ? { notice: undefined } : {}),
      })
      void this.loadAgentCatalog(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/probe-models')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活模型检测功能。', 'Host running older version. Please restart dsh web to enable model detection.')
        : msg
      this.mutate({
        notice,
        probingModels: { ...this.state.probingModels, [agentId]: false },
        probeErrors: { ...this.state.probeErrors, [agentId]: notice },
      })
    }
  }

  private clearProbeError(agentId: string): Record<string, string> {
    if (this.state.probeErrors[agentId] === undefined) return this.state.probeErrors
    const next = { ...this.state.probeErrors }
    delete next[agentId]
    return next
  }

  /**
   * Read one agent's ACP model surface (`agent/catalog`) — what the composer
   * chips and the ACP-mode model seat render. Cached per agent, because the
   * list only changes when the agent's catalog is re-probed or its exposure
   * filter is edited (both of which drop the cache below), and deduped because
   * every ACP surface asks for it on mount.
   *
   * The host answers from memory, so this is safe to call from a render effect;
   * a probe it may trigger runs in the background on the host side.
   */
  async loadAgentCatalog(agentId: string): Promise<void> {
    if (this.state.seatCatalogs[agentId] !== undefined || this.seatCatalogReads.has(agentId)) return
    this.seatCatalogReads.add(agentId)
    try {
      const result = await this.call<AgentCatalogResult>('agent/catalog', { agentId })
      this.mutate({ seatCatalogs: { ...this.state.seatCatalogs, [agentId]: result } })
    } catch {
      // An older host half, or an agent that was deleted meanwhile: the seats
      // fall back to the roster's own title and the bare agent route, which is
      // exactly what they show before a catalog exists.
    } finally {
      this.seatCatalogReads.delete(agentId)
    }
  }

  /** Drop one agent's cached seat catalog (its model surface just changed). */
  private invalidateSeatCatalog(agentId: string): void {
    if (this.state.seatCatalogs[agentId] === undefined) return
    const next = { ...this.state.seatCatalogs }
    delete next[agentId]
    this.mutate({ seatCatalogs: next })
  }

  /**
   * Persist the ACP-seat model filter for one agent. `undefined` clears the
   * filter — same as an empty list, i.e. no `agentId@choice` variants, only
   * the agent's base entry. Uses the dedicated lightweight RPC so the agent
   * process and its live sessions are never restarted.
   */
  async setExposedModels(agentId: string, exposedModels: string[] | undefined): Promise<void> {
    try {
      await this.call('agent/set-exposed-models', {
        agentId,
        ...(exposedModels === undefined ? {} : { exposedModels }),
      })
      await this.resync()
      // The seats render the filtered list, so an edited filter has to be
      // re-read or the open conversation keeps offering the old set.
      this.invalidateSeatCatalog(agentId)
      void this.loadAgentCatalog(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/set-exposed-models')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用模型筛选功能。', 'Host running older version. Please restart dsh web to enable model filtering.')
        : msg
      this.mutate({ notice })
      throw error
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.call('agent/delete', { agentId })
      this.rememberDeletedAgent(agentId)
      await this.resync()
      // A retained retry payload would rebuild the agent just deleted. Drop the
      // rows (and their retry entries) after the resync too, so a late status
      // snapshot cannot put them back.
      this.clearAgentSaveBanners(agentId)
      // Nothing should keep offering a deleted agent's models (a conversation
      // that was routed to it falls back to its roster entry).
      this.invalidateSeatCatalog(agentId)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /**
   * Persist the auto-discovery switch for one agent. Lightweight like
   * {@link setExposedModels}: no process restart, and the current selection is
   * left exactly as it is.
   */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    try {
      await this.call('agent/set-auto-discover-models', { agentId, autoDiscoverModels })
      await this.resync()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/set-auto-discover-models')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用自动发现功能。', 'Host running older version. Please restart dsh web to enable auto-discovery.')
        : msg
      this.mutate({ notice })
      throw error
    }
  }

  // ---- Panel lifecycle ----

  toggle(): void {
    const nextOpen = !this.state.open
    this.mutate({ open: nextOpen })
    if (nextOpen) {
      this.start()
      void this.resync()
    }
  }

  close(): void {
    this.mutate({ open: false })
  }

  selectSession(sessionId: string): void {
    this.mutate({ activeSessionId: sessionId })
    void this.loadTranscript(sessionId)
  }

  private async loadTranscript(sessionId: string): Promise<void> {
    try {
      const { session, entries } = await this.call<{ session: SessionView; entries: Array<{ seq: number; update: Record<string, unknown> }> }>(
        'transcript/get',
        { sessionId },
      )
      // An answer BEHIND what this page already folded must not replace it.
      //
      // The host fills its transcript from the notification pipeline, which the
      // SDK paces independently of the `session/prompt` response, so a read
      // taken right after a turn can still be missing the agent's last chunk.
      // `lastSeq` already refuses to go backwards; the blocks must not either,
      // or switching away and back inside that window truncates a turn the user
      // just watched finish. A resumed session replays as fresh updates, but
      // only after `session/reset` zeroes the watermark — so this cannot swallow
      // a legitimate replay.
      const seen = this.lastSeq.get(sessionId) ?? 0
      if ((entries.at(-1)?.seq ?? 0) < seen) return
      const blocks: Block[] = []
      for (const entry of entries) {
        foldUpdate(blocks, entry.update)
        this.lastSeq.set(sessionId, Math.max(this.lastSeq.get(sessionId) ?? 0, entry.seq))
      }
      const sessions = this.state.sessions.some(s => s.sessionId === sessionId)
        ? this.state.sessions.map(s => (s.sessionId === sessionId ? session : s))
        : [...this.state.sessions, session]
      this.mutate({ sessions, blocks, activeSessionId: sessionId })
    } catch {
      this.mutate({ blocks: [] })
    }
  }

  // ---- Actions ----

  async startSession(agentId: string, cwd?: string): Promise<void> {
    try {
      const { sessionId } = await this.call<{ sessionId: string }>('session/start', { agentId, ...(cwd === undefined || cwd === '' ? {} : { cwd }) })
      await this.resync()
      this.selectSession(sessionId)
    } catch (error) {
      this.flashError(error)
    }
  }

  async sendPrompt(text: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined || text.trim() === '') return
    this.mutate({ busy: true })
    try {
      await this.call('session/prompt', { sessionId, text })
    } catch (error) {
      this.flashError(error)
    } finally {
      this.mutate({ busy: false })
    }
  }

  async cancelActive(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/cancel', { sessionId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async closeActive(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/close', { sessionId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async setMode(modeId: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/mode-set', { sessionId, modeId })
    } catch (error) {
      this.flashError(error)
    }
  }

  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   */
  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   *
   * `settleVerdict` is the seat gate's own re-ask and the ONLY read allowed to
   * settle a verdict a frame had already settled (see {@link acpModeLive}): the
   * gate holds such a verdict as its only fact source while the session row
   * stays silent, and a host read is the one place a switch the runtime never
   * framed can still be learned from. Composer readers pass nothing and keep
   * the frame's authority.
   */
  loadChatSessions(dshSessionId: string, options?: { settleVerdict?: boolean; force?: boolean }): Promise<void> {
    // The composer entries (agent-mode control, ACP cluster, occupancy ring)
    // read this and re-read when a turn settles; one round-trip answers for
    // all of them instead of racing reads. A caller arriving mid-read waits
    // for THAT read rather than returning immediately: the slash source's
    // one-shot "do I have a verdict yet?" ask is only useful if it can
    // receive the answer of a read already in flight.
    //
    // `force` belongs to a caller that knows the host state JUST changed (a
    // turn started, an explicit resume finished, the stream reconnected). A
    // read that began before that change still names the old released row,
    // and the dedup above would otherwise hand this caller that stale answer.
    // Dropping it first makes this call ask the host again. The dropped read
    // still resolves for its own caller; `read.dropped` makes it write nothing.
    if (options?.force === true) this.abandonChatSessionRead(dshSessionId)
    const inFlight = this.chatSessionReads.get(dshSessionId)
    if (inFlight !== undefined) return inFlight.done
    const read: { dropped: boolean; done: Promise<void> } = { dropped: false, done: Promise.resolve() }
    this.chatSessionReads.set(dshSessionId, read)
    read.done = this.readChatSessionList(dshSessionId, options, read)
    return read.done
  }

  private async readChatSessionList(
    dshSessionId: string,
    options: { settleVerdict?: boolean; force?: boolean } | undefined,
    read: { dropped: boolean },
  ): Promise<void> {
    const settle = options?.settleVerdict === true || !this.acpModeLive.has(dshSessionId)
    // Captured BEFORE the request: every frame applied after this point is
    // newer than whatever state the host will answer with.
    const subagentRecordFramesAtRead = this.subagentRecordSeq
    const chatRowFramesAtRead = this.chatRowFrameSeq
    try {
      const { sessions: listed = [], acpMode, boundAgentId, lockedAgentId, choice } = await this.call<{ sessions: ChatSessionView[]; acpMode?: boolean; boundAgentId?: string; lockedAgentId?: string; choice?: AcpConversationChoice }>('session/chat-list', { dshSessionId, refresh: true })
      // The host answer can still describe the released row it had when this
      // read started. Replay the lifecycle frames that landed in the meantime:
      // a resume's `session/reset` flips the row back to live, a crash's
      // `session/released` parks it, a close drops it. Without this the late
      // answer overwrites the frame and the released banner survives a turn
      // that is already running on a live process.
      const sessions = replayChatRowFrames(listed, this.chatRowFrames, chatRowFramesAtRead)
      // A committed `agent-preset/selected` frame may have settled this
      // session's verdict while the read was in flight; the host answer then
      // describes the log as of BEFORE that switch and must not overwrite it.
      if (read.dropped) return
      // The first answer for a conversation only seeds what is already true: a
      // lock reported there belongs to an earlier page. A lock that appears on
      // a LATER answer is the first-turn transition unfolding in front of the
      // user, and only that one is announced to the hand-off animation.
      const firstAnswer = !this.chatListLoaded.has(dshSessionId)
      this.chatListLoaded.add(dshSessionId)
      // The lock is one-way, so a read that no longer reports one is an older
      // host half, not an unlock: keep what we already know in that case. The
      // one explicit unlock is the host's rollback frame, tracked separately.
      // A read that AGREES there is no lock clears the rollback marker, so a
      // later legitimate lock (even with its frame missed) is accepted again.
      if (lockedAgentId === undefined) this.chatUnlocked.delete(dshSessionId)
      const reportedLock = lockedAgentId !== undefined && this.chatUnlocked.has(dshSessionId)
        ? undefined
        : lockedAgentId
      const chatLockedAgent = reportedLock === undefined
        ? this.state.chatLockedAgent
        : { ...this.state.chatLockedAgent, [dshSessionId]: reportedLock }
      const witnessedLock = !firstAnswer
        && reportedLock !== undefined
        && this.state.chatLockedAgent[dshSessionId] === undefined
      const agentLockReveal = witnessedLock
        ? { ...this.state.agentLockReveal, [dshSessionId]: (this.state.agentLockReveal[dshSessionId] ?? 0) + 1 }
        : this.state.agentLockReveal
      // The plugin's own lifecycle records: REPLACED for this conversation and
      // refreshed for every other one, then replayed over by the
      // `subagents/record` frames that landed while this read was in flight
      // (an in-flight terminal must beat an older snapshot row). Rows of this
      // conversation also teach the ACP-session→conversation map the live
      // detail index is scoped by.
      for (const row of sessions) this.acpSessionOwners.set(row.sessionId, dshSessionId)
      const subagents = mergeSubagentSnapshot(
        this.state.subagents,
        dshSessionId,
        sessions,
        this.subagentRecordFrames,
        subagentRecordFramesAtRead,
      )
      this.mutate({
        chatSessions: sessions,
        chatSessionsFor: dshSessionId,
        chatLockedAgent,
        agentLockReveal,
        subagents,
        // The host's binding (intent + live-session fallback) outranks the
        // optimistic entry this store wrote on the click; a host without the
        // field (older half) simply leaves the optimistic value standing.
        ...(boundAgentId === undefined
          ? {}
          : { chatBoundAgent: { ...this.state.chatBoundAgent, [dshSessionId]: boundAgentId } }),
        // The persisted pick (model + thought level) — the host's record,
        // present before any ACP session exists. Merged over the optimistic
        // entry so a value a click just wrote is not erased by a read that
        // started before the click landed.
        ...(choice === undefined
          ? {}
          : { chatChoice: { ...this.state.chatChoice, [dshSessionId]: choice } }),
        // The seat gate's fallback fact source: absent on an older host half,
        // which then simply never takes the seat over (the allowed failure).
        // A frame-settled verdict outranks any read, whenever it lands: the
        // host's log read can lag a switch by one, and taking the model seat
        // re-mounts readers, so a stale answer would otherwise regress it.
        ...(acpMode === undefined || !settle
          ? {}
          : { acpMode: { ...this.state.acpMode, [dshSessionId]: acpMode === true } }),
      })
      // A read that answered but carried no verdict has NOT settled this
      // session. The gate's ask ledger is one-shot per id, so unless the id is
      // retracted here it stays marked "asked" forever and the gate never asks
      // again — one silent round-trip and the native model seat is permanent
      // for that session. The gate re-derives this from `hasAcpModeVerdict`
      // on its next evaluation (every store mutation re-runs it), which is
      // what makes the fallback recoverable instead of a single coin flip.
      if (acpMode === undefined && settle) {
        this.acpModeUnsettled.add(dshSessionId)
      }
    } catch {
      // A host without this surface (older build) has nothing to show; the
      // control simply renders nothing rather than an error nobody can act on.
      if (read.dropped) return
      this.mutate({ chatSessions: [], chatSessionsFor: dshSessionId })
      if (settle) {
        this.acpModeUnsettled.add(dshSessionId)
      }
    } finally {
      if (this.chatSessionReads.get(dshSessionId) === read) this.chatSessionReads.delete(dshSessionId)
    }
  }

  /**
   * Abandon the in-flight `session/chat-list` read for one session (or all of
   * them): a committed `agent-preset/selected` frame carries the authoritative
   * verdict, and the late answer to an ask that predates the frame describes
   * the log from before the switch — it must not land in the store.
   */
  abandonChatSessionRead(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      for (const read of this.chatSessionReads.values()) read.dropped = true
      this.chatSessionReads.clear()
      return
    }
    const read = this.chatSessionReads.get(dshSessionId)
    if (read === undefined) return
    read.dropped = true
    this.chatSessionReads.delete(dshSessionId)
  }

  /**
   * Ensure one worker's detail index exists and read its history once.
   *
   * Creates the index (which is what makes LIVE frames append to it from then
   * on), moves it to the LRU's recent end, and on the first open of this page
   * asks the host for the bounded history that predates the page
   * (`subagents/detail`). Frames that land while that read is in flight are
   * replayed over its answer by their `liveSeq`, so a slow read cannot erase
   * a terminal frame the page already saw. A failed read leaves the live
   * index alone and retries on the next open.
   */
  async loadSubagentDetail(dshSessionId: string, childId: string): Promise<void> {
    const key = subagentKey(dshSessionId, childId)
    const atRead = this.detailLiveSeq
    const existing = this.state.subagentDetails[key]
    const touchedAt = Date.now()
    const opened: SubagentDetailState = existing === undefined
      ? { dshSessionId, childId, entries: [], loaded: false, omitted: 0, touchedAt }
      : { ...existing, touchedAt }
    // Re-insert so an equal-timestamp tie during LRU eviction keeps this one
    // (see `withSubagentDetail`).
    const openedMap = { ...this.state.subagentDetails }
    delete openedMap[key]
    openedMap[key] = opened
    this.mutate({ subagentDetails: this.withSubagentDetail(openedMap, key) })
    if (opened.loaded) return
    try {
      const result = await this.call<SubagentDetailResult>('subagents/detail', { dshSessionId, childId })
      const current = this.state.subagentDetails[key]
      if (current === undefined) return
      // Frames applied while the read was in flight are newer than its answer
      // in the only sense that matters (the host may not have seen them yet),
      // so they are replayed over it. A frame the host DID see appears on both
      // sides; the payload comparison drops that copy (a bare seq is not
      // enough: a resumed segment restarts its numbering).
      const hostHistory = new Map<number, Set<string>>()
      for (const entry of result.entries) {
        const copy = hostHistory.get(entry.seq) ?? new Set<string>()
        copy.add(compactDetailValue(entry.update))
        hostHistory.set(entry.seq, copy)
      }
      const live = current.entries.filter(entry => {
        if ((entry.liveSeq ?? 0) <= atRead) return false
        return hostHistory.get(entry.seq)?.has(compactDetailValue(entry.update)) !== true
      })
      const combined = [...result.entries.map(entry => ({ ...entry })), ...live]
      const overflow = Math.max(0, combined.length - MAX_SUBAGENT_DETAIL_ENTRIES)
      this.mutate({
        subagentDetails: this.withSubagentDetail({
          ...this.state.subagentDetails,
          [key]: {
            ...current,
            entries: overflow > 0 ? combined.slice(overflow) : combined,
            loaded: true,
            omitted: current.omitted + overflow + (result.omitted ?? 0),
            touchedAt: Date.now(),
          },
        }, key),
      })
    } catch {
      // An older host (no endpoint) or a dropped read: the live index stays
      // usable, and the next open retries the one history read.
    }
  }

  /**
   * Apply the {@link MAX_SUBAGENT_DETAIL_WORKERS} LRU. `protect` is never
   * evicted (the worker just opened); among the rest the oldest `touchedAt`
   * goes first.
   */
  private withSubagentDetail(
    map: Record<string, SubagentDetailState>,
    protect?: string,
  ): Record<string, SubagentDetailState> {
    const keys = Object.keys(map)
    if (keys.length <= MAX_SUBAGENT_DETAIL_WORKERS) return map
    const removable = keys
      .filter(key => key !== protect)
      .sort((a, b) => (map[a]?.touchedAt ?? 0) - (map[b]?.touchedAt ?? 0))
    const next = { ...map }
    let excess = keys.length - MAX_SUBAGENT_DETAIL_WORKERS
    for (const key of removable) {
      if (excess <= 0) break
      delete next[key]
      excess -= 1
    }
    return next
  }

  /**
   * The slash commands the LIVE ACP session declared for one chat session, as
   * read by {@link loadChatSessions} (`available_commands_update` →
   * `session/chat-list`).
   *
   * `undefined` covers both "no answer has landed yet" and "there is no live
   * session (or it has not declared anything)" — in every one of those cases
   * the caller falls back to the agent-level cache ({@link agentCommands}),
   * which is what makes `/` list commands before the first message exists.
   */
  chatSessionCommands(dshSessionId: string): readonly AgentCommand[] | undefined {
    if (this.state.chatSessionsFor !== dshSessionId) return undefined
    return this.state.chatSessions[0]?.availableCommands
  }

  /**
   * The slash commands the agent declared in its most recent session, from
   * `agent/catalog` (host-cached per agent, see `AgentCatalogResult.commands`).
   * The pre-first-turn source for the `/` menu.
   */
  agentCommands(agentId: string | undefined): readonly AgentCommand[] | undefined {
    if (agentId === undefined) return undefined
    return this.state.seatCatalogs[agentId]?.commands
  }

  /**
   * Which agent serves one conversation as far as this page can tell, without
   * reading any catalog: live ACP session → agent lock → host/optimistic
   * binding → persisted pick → plugin default. Used to find the agent whose
   * cached commands the `/` menu should offer before a session exists.
   */
  chatAgentFor(dshSessionId: string): string | undefined {
    if (this.state.chatSessionsFor === dshSessionId) {
      const live = this.state.chatSessions[0]
      if (live !== undefined) return live.agentId
    }
    // The lock outlives the session: after the first turn it is the durable
    // answer even when the ACP session is gone.
    return this.state.chatLockedAgent[dshSessionId]
      ?? this.state.chatBoundAgent[dshSessionId]
      ?? this.state.chatChoice[dshSessionId]?.agentId
      ?? this.state.defaultAgent
  }

  /**
   * Record the verdict a committed `agent-preset/selected` frame carries, folded
   * from the frame's own preset field ({@link acpModeFromPresetEvent}). The
   * frame is authoritative: it marks the session live-settled, so no later host
   * read may regress it (see {@link acpModeLive}) — the gate's own TTL re-ask
   * being the one authorized exception. Same no-op-when-unchanged discipline as
   * the other accessors, so a frame restating the held verdict costs no
   * listener churn.
   *
   * The seat gate (`syncAcpMode`) is the SECOND caller: it folds the runtime
   * row's own `agentPreset` — the same session-log source the frames announce —
   * through here, in both directions. That hands the row the frame's authority
   * on purpose (one provenance, one rank): a stale projection is corrected by
   * the gate's next evaluation with fresher row data, and only HOST READS are
   * barred from regressing what the runtime itself already said.
   */
  noteAcpMode(dshSessionId: string, acpMode: boolean): void {
    this.acpModeLive.add(dshSessionId)
    if (this.state.acpMode[dshSessionId] === acpMode) return
    this.mutate({ acpMode: { ...this.state.acpMode, [dshSessionId]: acpMode } })
  }

  /**
   * Record the model-seat gate's last decision (see the `seatDiag` field). The
   * gate owns the string; the store only carries it so the ACP view can render
   * *why* the native seat is or is not shadowed. No-op when unchanged, so the
   * gate can call this on every evaluation without churning listeners.
   */
  noteSeatDiag(text: string): void {
    if (this.state.seatDiag === text) return
    this.mutate({ seatDiag: text })
  }

  /**
   * Record the permission-seat gate's last decision (`conversation.input.permission`).
   */
  notePermissionSeatDiag(text: string): void {
    if (this.state.permissionSeatDiag === text) return
    this.mutate({ permissionSeatDiag: text })
  }

  /**
   * Record the slash-isolation seam's last verdict (`idle` = in force, or no
   * problem to report). No-op when unchanged, like the seat lines.
   */
  noteSlashDiag(text: string): void {
    if (this.state.slashDiag === text) return
    this.mutate({ slashDiag: text })
  }

  /**
   * Whether a chat session's host read produced a verdict the seat gate can
   * rely on. `false` means "asked but not answered" — the read returned no
   * `acpMode` field or failed outright — and is the signal for the gate to
   * retract its one-shot ask ledger entry for this id so it can ask again.
   *
   * A verdict handed down by a committed `agent-preset/selected` frame is
   * authoritative and outranks everything (see {@link acpModeLive}); such a
   * session always answers `true` here, settled or not.
   */
  hasAcpModeVerdict(dshSessionId: string): boolean {
    if (this.acpModeLive.has(dshSessionId)) return true
    if (this.acpModeUnsettled.has(dshSessionId)) {
      this.acpModeUnsettled.delete(dshSessionId)
      return false
    }
    return this.state.acpMode[dshSessionId] !== undefined
  }

  /**
   * Drop one chat session's ACP-mode verdict — or the whole map. The preset
   * switch a session committed is announced by the host (`agent-preset/selected`)
   * and folded by the runtime into its own rows, but NOT into this map, so the
   * gate re-asks instead of trusting a verdict the session log has moved past.
   */
  invalidateAcpMode(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      // Dropping the whole map also re-opens every session to host reads.
      this.acpModeLive.clear()
      if (Object.keys(this.state.acpMode).length === 0) return
      this.mutate({ acpMode: {} })
      return
    }
    this.acpModeLive.delete(dshSessionId)
    if (this.state.acpMode[dshSessionId] === undefined) return
    const acpMode = { ...this.state.acpMode }
    delete acpMode[dshSessionId]
    this.mutate({ acpMode })
  }

  /**
   * Switch the ACP agent's own mode for one chat session (`session/set_mode`),
   * then re-read the binding so the control reflects what the agent actually
   * reports (a rejected switch must not leave an optimistic lie on screen).
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-mode-set', { dshSessionId, modeId, ...(agentId === undefined ? {} : { agentId }) })
      const safeAgent = (agentId && agentId.trim()) || undefined
      this.writeChoice(dshSessionId, choice => ({ ...choice, mode: modeId }), safeAgent)
      if (this.state.chatSessionsFor === dshSessionId) {
        const owner = safeAgent ?? this.state.chatChoice[dshSessionId]?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
        let changed = false
        const chatSessions = this.state.chatSessions.map(s => {
          if (s.agentId !== owner || !s.modes || s.modes.currentModeId === modeId) return s
          changed = true
          return { ...s, modes: { ...s.modes, currentModeId: modeId } }
        })
        if (changed) this.mutate({ chatSessions })
      }
    } catch (error) {
      this.flashError(error)
    }
    await this.loadChatSessions(dshSessionId)
  }

  /**
   * Bring the conversation's released ACP session back on a fresh process —
   * the released banner's explicit form of the "next message resumes it"
   * promise (`session/chat-resume`). A failure is reported through the notice
   * AND rethrown (the `respondPermission` contract), so the banner can pin
   * the message beside the button the user just pressed; the binding is
   * re-read either way so the row follows the host's real answer.
   */
  async resumeChatSession(dshSessionId: string): Promise<void> {
    let failure: unknown
    try {
      await this.call('session/chat-resume', { dshSessionId })
    } catch (error) {
      this.flashError(error)
      failure = error
    }
    // `force`: the host answer this call needs is the one AFTER the resume.
    // The host's no-op branch (already live) broadcasts no frame at all, so
    // reusing a read that started before the click would keep the released row.
    await this.loadChatSessions(dshSessionId, { force: true })
    if (failure !== undefined) throw failure
  }

  /**
   * Branch one conversation (the NTR branch button's click): the fixed
   * two-stage order — the HOST forks the DSH session tree first (copied
   * history, `(1)` title, workspace), then the plugin adopts the ACP side via
   * `session/chat-fork-adopt`, which runs the agent's own `session/fork` so
   * the child actually remembers the parent context. Host first is structural:
   * ACP fork has no cut-point parameter and nothing to return to if the host
   * half failed second (see the plan's §D7).
   *
   * Resolves `{ childId }` on success, or `{ failure }` with one actionable
   * line — the reason is ALSO flashed into the notice banner (a user-action
   * failure, so the banner is its surface), and the local line is what the
   * conversation renders beside the button (the user is not on the settings
   * page). A failed adopt leaves the child an ordinary copied-history
   * conversation (its first message starts a fresh `session/new` — today's
   * behavior), never a half-bound one, and NOTHING is opened.
   *
   * `forkHost` is the runtime's `sessions.fork` face, resolved structurally by
   * the entry and injected here: the store stays transport-free.
   */
  async forkChatSession(
    dshSessionId: string,
    forkHost: (sessionId: string) => Promise<unknown>,
  ): Promise<ChatForkOutcome> {
    let childId: unknown
    try {
      childId = await forkHost(dshSessionId)
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      this.flashError(failure)
      return { failure }
    }
    if (typeof childId !== 'string' || childId === '') {
      const failure = this.locale(
        '宿主没有返回分支会话，分支未完成。',
        'The host returned no branched session; the branch did not complete.',
      )
      this.flashError(new Error(failure))
      return { failure }
    }
    try {
      await this.call('session/chat-fork-adopt', { dshSessionId: childId, parentDshSessionId: dshSessionId })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failure = this.locale(
        `分支会话已创建，但没有接上 agent 的上下文（${reason}）；在子会话里发送的第一条消息会开启全新会话。`,
        `The branched session was created but the agent context was not attached (${reason}); its first message will start a fresh session.`,
      )
      this.flashError(new Error(failure))
      return { failure }
    }
    return { childId }
  }

  // ---- ACP transcript observation (the conversation's ACP view) ----

  /**
   * Start (or refresh) observation of every ACP transcript behind one DSH chat
   * session. Blocks are rebuilt from scratch — the host buffer is the record,
   * and this view is the only consumer that needs the raw agent stream.
   */
  async loadChatTranscript(dshSessionId: string): Promise<void> {
    let views: ChatTranscriptView[]
    try {
      ({ views } = await this.call<{ views: ChatTranscriptView[] }>(
        'session/chat-transcript',
        { dshSessionId },
      ))
    } catch {
      // An older host half (or a session with no ACP binding): nothing to
      // observe, and no error worth flashing for a read-only side view.
      return
    }
    // Everything this chat session used to have, minus what it still has: a
    // closed or replaced ACP session must not linger as a ghost tab body.
    const merged: Record<string, ChatTranscript> = {}
    for (const [id, record] of Object.entries(this.state.chatTranscripts)) {
      if (record.owner !== dshSessionId) merged[id] = record
    }
    for (const view of views) {
      const blocks: Block[] = []
      for (const entry of view.entries) foldUpdate(blocks, entry.update as Record<string, unknown>)
      merged[view.session.sessionId] = {
        owner: dshSessionId,
        session: view.session,
        blocks,
        seq: view.entries.length > 0 ? view.entries[view.entries.length - 1]?.seq ?? 0 : 0,
      }
    }
    this.mutate({ chatTranscripts: this.evictTranscripts(merged) })
  }

  /** Observed transcript for one ACP session id (undefined → nobody is watching it). */
  transcriptOf(acpSessionId: string): ChatTranscript | undefined {
    return this.state.chatTranscripts[acpSessionId]
  }

  /** The observed transcript of one chat session (the live binding wins over a released one). */
  chatTranscriptOf(dshSessionId: string): ChatTranscript | undefined {
    const owned = Object.values(this.state.chatTranscripts).filter(record => record.owner === dshSessionId)
    return owned.find(record => !record.session.released) ?? owned[0]
  }

  /** Keep the resident transcript map at its bound, newest insertion first. */
  private evictTranscripts(map: Record<string, ChatTranscript>): Record<string, ChatTranscript> {
    const ids = Object.keys(map)
    if (ids.length <= MAX_WATCHED) return map
    const out: Record<string, ChatTranscript> = {}
    for (const id of ids.slice(ids.length - MAX_WATCHED)) {
      const value = map[id]
      if (value !== undefined) out[id] = value
    }
    return out
  }

  /** Re-publish an observed transcript's session snapshot (mode / released flips). */
  private watchedSessionPatch(sessionId: string, session: SessionView): { chatTranscripts?: Record<string, ChatTranscript> } {
    const current = this.state.chatTranscripts[sessionId]
    if (current === undefined) return {}
    return { chatTranscripts: { ...this.state.chatTranscripts, [sessionId]: { ...current, session } } }
  }

  /** Mirror the running flag onto a transcript the ACP view is showing. */
  private markWatchedRunning(sessionId: string, running: boolean): void {
    const current = this.state.chatTranscripts[sessionId]
    if (current === undefined || current.session.running === running) return
    this.mutate({
      chatTranscripts: {
        ...this.state.chatTranscripts,
        [sessionId]: { ...current, session: { ...current.session, running } },
      },
    })
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/config-set', { sessionId, configId, value })
    } catch (error) {
      this.flashError(error)
    }
  }

  /**
   * Answer one ask (`optionId` absent = cancel it). A failure is reported
   * through the store's notice — the settings panel renders that — AND
   * rethrown, so the conversation dock can pin the message next to the card
   * that failed instead of leaving it on a settings page the user may not
   * have open. Callers that cannot show it (the settings panel) swallow it
   * after the notice.
   */
  async respondPermission(requestId: string, optionId?: string): Promise<void> {
    try {
      await this.call('permission/respond', { requestId, ...(optionId === undefined ? {} : { optionId }) })
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    try {
      await this.call('agent/stop', { agentId })
      await this.resync()
    } catch (error) {
      this.flashError(error)
    }
  }

  /**
   * Explicit "强制保存": flush the host's held profile writes now, even while
   * an ACP turn is running. The gate broadcasts its new state; the extra
   * `save/status` read is the fallback for a host that resolves the flush
   * before its own frame lands. A transport failure gets its own visible row —
   * the caller's `.finally` must never be the only thing that runs.
   */
  async forceSaveGate(): Promise<SaveGateFlushResult> {
    try {
      return await this.flushHeldSaves()
    } catch (error) {
      this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
      throw error
    }
  }

  /** Run `save/flush`, then fold its answer into banners and the gate snapshot. */
  private async flushHeldSaves(): Promise<SaveGateFlushResult> {
    // Capture what this flush was asked to write BEFORE the call: only the
    // gate's terminal rows afterwards can tell which of those labels failed.
    const heldLabels = this.state.saveGate.pending.map(entry => entry.label)
    const result = await this.call<SaveGateFlushResult>('save/flush')
    const status = await this.call<{ status: SaveGateStatus }>('save/status').catch(() => null)
    const next = status?.status === undefined ? undefined : normalizeSaveGateStatus(status.status)
    if (next !== undefined) this.mutate({ saveGate: next })
    this.reportFlushResult(result, heldLabels, next)
    return result
  }

  /**
   * Drop one held profile write by label. The settings form uses this when the
   * user edits the form after choosing "save after turns": flushing that old
   * snapshot later would silently overwrite the newer values.
   *
   * Only a numeric, positive cancellation count is success. A missing or
   * non-numeric answer leaves the held state in place and warns: the host
   * clearly answered, but it did not prove the write was dropped.
   */
  async cancelSaveGate(label: string): Promise<boolean> {
    let result: { cancelled?: number } | undefined
    try {
      result = await this.call<{ cancelled?: number }>('save/cancel', { label })
    } catch (error) {
      this.flashError(error)
      this.pushSaveCancelFailedBanner(label)
      return false
    }
    const cancelled = result?.cancelled
    if (typeof cancelled !== 'number') {
      this.pushSaveCancelFailedBanner(label)
      return false
    }
    if (cancelled > 0) {
      this.dropPendingLocally(label)
      return true
    }
    // `0` can also mean "the frame raced ahead of the status snapshot". Re-read
    // before warning; only a label still queued (or no matching terminal row)
    // is a real failure.
    try {
      const status = await this.readSaveGate()
      const stillPending = status.pending.some(entry => entry.label === label)
      const outcome = saveGateOutcomeForLabel(status, label)
      if (!stillPending && outcome?.status === 'cancelled') {
        this.dropPendingLocally(label)
        return true
      }
    } catch (error) {
      this.flashError(error)
    }
    this.pushSaveCancelFailedBanner(label)
    return false
  }

  /** Re-run a failed/expired held write through the host gate. */
  async retrySaveGate(label: string): Promise<'retried' | 'none' | 'error'> {
    try {
      const result = await this.call<{ retried?: unknown }>('save/retry', { label })
      if (result.retried === true) {
        // A status frame is already on its way; this read closes the gap when
        // the host resolves the retry before broadcasting.
        await this.readSaveGate().catch(() => { /* the status frame remains authoritative */ })
        return 'retried'
      }
      if (result.retried === false) return 'none'
      // A malformed answer is not "nothing to retry": reporting that would
      // hide a real host problem behind a success receipt.
      throw new Error(this.label(
        '宿主返回了无法识别的重试结果。',
        'The host returned an unrecognised retry result.',
      ))
    } catch (error) {
      this.pushSaveRetryFailedBanner(label, this.errorText(error))
      return 'error'
    }
  }

  private dropPendingLocally(label: string): void {
    const next = this.state.saveGate.pending.filter(entry => entry.label !== label)
    if (next.length === this.state.saveGate.pending.length) {
      // Still clear a stale "cancel did not take effect" row on a success.
      this.dismissBanner(`save-cancel-failed:${label}`)
      return
    }
    this.mutate({
      saveGate: {
        ...this.state.saveGate,
        pending: next,
      },
      saveBanners: this.state.saveBanners.filter(banner => banner.key !== `save-cancel-failed:${label}`),
    })
    this.bannerRetries.delete(`save-cancel-failed:${label}`)
  }

  /**
   * The banner's "知道了": remove it, and let the same failure reappear later.
   * `at` names the row that owns the gesture. An auto-dismiss timer passes the
   * timestamp it was registered with, so a NEWER row sharing the key survives.
   */
  dismissBanner(key: string, at?: number): void {
    const current = this.state.saveBanners.find(banner => banner.key === key)
    if (current === undefined) {
      this.bannerRetries.delete(key)
      return
    }
    if (at !== undefined && current.at !== at) return
    rememberBannerDismissal(current)
    this.bannerRetries.delete(key)
    this.mutate({ saveBanners: this.state.saveBanners.filter(banner => banner.key !== key) })
  }

  /** The banner's "重试": re-run the retained host write or the rejected save. */
  async retryBanner(key: string): Promise<void> {
    const action = this.bannerRetries.get(key)
    if (action === undefined) {
      this.dismissBanner(key)
      return
    }
    if (action.kind === 'cancel') {
      this.dismissBanner(key)
      const cancelled = await this.cancelSaveGate(action.label)
      // A failed retry re-adds its own "cancel did not take effect" row.
      if (cancelled) this.pushSaveCancelledBanner(action.label)
      return
    }
    if (action.kind === 'gate') {
      const outcome = await this.retrySaveGate(action.label)
      if (outcome === 'error') {
        // Keep the original failure row AND the new error receipt: an RPC
        // failure is not evidence that nothing was left to retry.
        return
      }
      this.dismissBanner(key)
      // "重试" never silently escalates to a force flush: a force can interrupt
      // a running turn, and that is a separate, explicit gesture.
      if (outcome === 'none') this.pushSaveRetryNoneBanner(action.label)
      return
    }
    if (action.kind === 'flush') {
      await this.retryFlushBanner(key)
      return
    }
    this.dismissBanner(key)
    try {
      await this.saveAgent(action.payload, 'defer')
    } catch { /* the failure banner has already been replaced */ }
  }

  /** The banner's "强制保存": flush the gate or force the rejected payload. */
  async forceBanner(key: string): Promise<void> {
    const action = this.bannerRetries.get(key)
    if (action?.kind === 'payload') {
      this.dismissBanner(key)
      try {
        await this.saveAgent(action.payload, 'force')
      } catch { /* the failure banner has already been replaced */ }
      return
    }
    // A gate failure/expiry row is settled by the flush itself; a transport
    // error becomes a fresh visible receipt. The partial row is different: it
    // must survive until a flush actually clears every held write.
    if (action?.kind === 'gate') {
      this.dismissBanner(key)
      try {
        await this.flushHeldSaves()
      } catch (error) {
        this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
      }
      return
    }
    await this.retryFlushBanner(key)
  }

  /**
   * Retry/force one `save-partial` row. The original partial row survives a
   * transport failure; only an all-saved flush clears it. A partially completed
   * retry replaces the row through {@link reportFlushResult} instead.
   */
  private async retryFlushBanner(key: string): Promise<void> {
    const beforeAt = this.state.saveBanners.find(banner => banner.key === key)?.at
    try {
      const result = await this.flushHeldSaves()
      const remaining = (result.expired ?? 0) + (result.failed ?? 0)
      if (remaining === 0) this.dismissBanner(key, beforeAt)
    } catch (error) {
      this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
    }
  }

  /** Translate one force-flush result into a success or partial-failure banner. */
  private reportFlushResult(
    result: SaveGateFlushResult,
    heldLabels: readonly string[] = [],
    status?: SaveGateStatus,
  ): void {
    const expired = result.expired ?? 0
    const failed = result.failed ?? 0
    const failedLabels = status === undefined
      ? []
      : heldLabels.filter(label => {
        const outcome = saveGateOutcomeForLabel(status, label)
        return outcome?.status === 'failed' || outcome?.status === 'expired'
      })
    if (expired > 0 || failed > 0) {
      const key = 'save-partial'
      this.bannerRetries.set(key, { kind: 'flush' })
      const named = failedLabels.length === 0
        ? ''
        : this.label(` 未写入：${failedLabels.join('、')}。`, ` Not written: ${failedLabels.join(', ')}.`)
      this.pushSaveBanner({
        key,
        source: 'save-partial',
        level: 'error',
        title: this.label('强制保存只完成一部分', 'Forced save only partly completed'),
        body: this.label(
          `已保存 ${String(result.saved)} 项，失败 ${String(failed)} 项，过期 ${String(expired)} 项${result.cancelled ? `，取消 ${String(result.cancelled)} 项` : ''}。请重试。${named}`,
          `${String(result.saved)} saved, ${String(failed)} failed, ${String(expired)} expired${result.cancelled ? `, ${String(result.cancelled)} cancelled` : ''}. Please retry.${named}`,
        ),
        at: Date.now(),
        actions: ['retry', 'dismiss'],
      })
      return
    }
    if (result.saved > 0) {
      const savedLabels = status === undefined
        ? []
        : heldLabels.filter(label => saveGateOutcomeForLabel(status, label)?.status === 'saved')
      this.pushSaveSuccessBanner(result.saved, savedLabels)
    }
  }

  /**
   * A success receipt names the agent (or the non-agent label) it belongs to.
   * Several agents settling in one frame share ONE row whose body lists every
   * one of them, so the last settlement cannot erase the others' identity.
   */
  private saveSuccessBanner(saved: number, labels: string[] = []): SaveBanner {
    const subjects = labels.map(label => this.saveSubjectOf(label))
    const count = saved > 1
      ? this.label(`已保存 ${String(saved)} 项配置`, `${String(saved)} settings were saved`)
      : undefined
    const body = subjects.length === 0
      ? (count === undefined ? this.label('已保存。', 'Saved.') : `${count}。`)
      : subjects.length > 3
        ? this.label(
          `已保存：${subjects.slice(0, 3).join('、')} 等 ${String(subjects.length)} 个。`,
          `Saved: ${subjects.slice(0, 3).join(', ')}, ${String(subjects.length)} total.`,
        )
        : this.label(`已保存：${subjects.join('、')}。`, `Saved: ${subjects.join(', ')}.`)
    return {
      key: 'save-succeeded',
      source: 'save-succeeded',
      level: 'success',
      title: this.label('保存成功', 'Saved'),
      body,
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    }
  }

  private saveSubjectOf(label: string): string {
    const prefix = 'agent-save:'
    if (!label.startsWith(prefix)) return label
    const agentId = label.slice(prefix.length)
    const configured = this.state.agents.find(agent => agent.id === agentId)
    const detected = this.state.detectedAgents.find(agent => agent.id === agentId)
    return configured?.title ?? detected?.name ?? agentId
  }

  private pushSaveSuccessBanner(saved: number, labels: string[] = []): void {
    this.pushSaveBanner(this.saveSuccessBanner(saved, labels))
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** One visible receipt for a retry/force that failed before any settlement. */
  private pushSaveRetryFailedBanner(label: string | undefined, message: string): void {
    this.pushSaveBanner({
      key: `save-retry-failed:${label ?? 'flush'}`,
      source: 'save-retry-failed',
      level: 'error',
      title: this.label('重试失败', 'Retry failed'),
      body: this.label(`重试没有完成：${message}`, `The retry did not complete: ${message}`),
      at: Date.now(),
      actions: ['dismiss'],
      ...(label === undefined ? {} : { label }),
    })
  }

  private pushSaveCancelledBanner(label: string): void {
    this.pushSaveBanner({
      key: `save-cancelled:${label}`,
      source: 'save-cancelled',
      level: 'success',
      title: this.label('已取消暂存', 'Held save cancelled'),
      body: this.label(
        '回合结束后不会写入点击时的版本。',
        'The values from the moment you clicked will not be written when the turn ends.',
      ),
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    })
  }

  private pushSaveCancelFailedBanner(label: string): void {
    const key = `save-cancel-failed:${label}`
    this.bannerRetries.set(key, { kind: 'cancel', label })
    this.pushSaveBanner({
      key,
      source: 'save-cancel-failed',
      level: 'error',
      title: this.label('取消未生效', 'Cancel did not take effect'),
      body: this.label(
        '取消未生效，回合结束会写入点击时版本。',
        'The cancel did not take effect. The values from the moment you clicked will be written when the turn ends.',
      ),
      at: Date.now(),
      actions: ['retry', 'dismiss'],
      label,
    })
  }

  private pushSaveRetryNoneBanner(label: string): void {
    this.pushSaveBanner({
      key: `save-retry-none:${label}`,
      source: 'save-retry-none',
      level: 'success',
      title: this.label('已无待重试项', 'Nothing left to retry'),
      body: this.label('该配置已不在待重试的队列中。', 'That setting is no longer waiting to be retried.'),
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    })
  }

  /** Record an id the host deleted during this run (session-only tombstone). */
  private rememberDeletedAgent(agentId: string): void {
    if (agentId === '' || this.state.deletedAgentIds.includes(agentId)) return
    this.mutate({ deletedAgentIds: [...this.state.deletedAgentIds, agentId] })
  }

  /**
   * The failure/expiry rows that a successful save of `label` retires. Scoped to
   * the same agent (or the same non-agent setting) so another agent's failure
   * receipts survive.
   */
  private saveFailureKeysFor(label: string): Set<string> {
    const keys = new Set([`save-failed:${label}`, `save-expired:${label}`])
    const prefix = 'agent-save:'
    if (label.startsWith(prefix)) {
      const agentId = label.slice(prefix.length)
      keys.add(`save-failed:${agentId}`)
      keys.add(`save-rejected:${agentId}`)
    }
    return keys
  }

  /**
   * A successful save retires that agent's older failure receipts: leaving
   * "the setting was not written" beside a fresh success would contradict it.
   * Only failure/expiry rows go; another agent's rows and receipts stay.
   */
  private clearAgentSaveFailures(agentId: string): void {
    const keys = this.saveFailureKeysFor(`agent-save:${agentId}`)
    for (const key of keys) this.bannerRetries.delete(key)
    const next = this.state.saveBanners.filter(banner => !keys.has(banner.key))
    if (next.length !== this.state.saveBanners.length) this.mutate({ saveBanners: next })
  }

  /**
   * A deleted agent must not leave a retry gesture behind: its payload would
   * recreate exactly what the user removed. Clear the id-keyed rows and the
   * label-keyed gate rows in one place.
   */
  private clearAgentSaveBanners(agentId: string): void {
    const label = `agent-save:${agentId}`
    const keys = new Set([
      `save-failed:${agentId}`,
      `save-rejected:${agentId}`,
      `save-failed:${label}`,
      `save-expired:${label}`,
      `save-cancel-failed:${label}`,
      `save-cancelled:${label}`,
      `save-retry-none:${label}`,
      `save-retry-failed:${label}`,
    ])
    for (const key of keys) this.bannerRetries.delete(key)
    const next = this.state.saveBanners.filter(banner => !keys.has(banner.key))
    if (next.length !== this.state.saveBanners.length) this.mutate({ saveBanners: next })
  }

  /**
   * Fold one gate snapshot into banners and log lines. The SSE frame and
   * `resync` share this, so a page refresh rebuilds the terminal rows it missed
   * instead of only replacing `saveGate`.
   *
   * `logPending = false` on a resync: the held entry did not APPEAR at refresh
   * time, and logging it on every panel open would be noise. Terminal rows are
   * still synthesized.
   *
   * A terminal row is a SEED (rebuilt from a snapshot rather than witnessed live)
   * when a resync asks for it or when the previous snapshot has no terminal
   * entry for that label — the first SSE frame after a refresh lands before
   * `resync` and carries the whole host roster. Seeded rows obey the closed-row
   * records in sessionStorage; live settlements carry a new `at`, so closing an
   * old row never suppresses a later failure of the same label.
   */
  private saveGatePatch(
    previous: SaveGateStatus,
    next: SaveGateStatus,
    logPending = true,
    rebuildRows = false,
  ): Partial<UiState> {
    const { addedPending, outcomes } = saveGateTransitions(previous, next)
    const logged: AcpLogEntry[] = []
    const log = (level: 'info' | 'error', text: string): void => {
      logged.push({ id: ++this.logSeq, at: Date.now(), level, text })
    }
    let banners = this.state.saveBanners
    for (const entry of addedPending) {
      // The queue is authoritative again: drop a just-shown "cancelled"
      // success row for the same label so the two prompts are not shown side
      // by side. A resync can re-enter the queue too, so this is not tied to
      // whether the arrival is worth a log line.
      banners = banners.filter(banner => banner.key !== `save-cancelled:${entry.label}`)
      if (logPending) {
        log('info', this.label(
          '本轮对话还在进行，配置已暂存，回合结束后自动保存。',
          'A turn is still running. The setting is held and will be saved when the turn ends.',
        ))
      }
    }
    const savedLabels: string[] = []
    for (const { label, outcome, wasPending, isPending } of outcomes) {
      if (outcome.status === 'saved') {
        // Only a previously HELD write earns the global receipt; a direct save
        // from the form reports success on its own.
        if (!wasPending) continue
        // A success retires this agent's earlier failure/expiry receipts.
        const cleared = this.saveFailureKeysFor(label)
        for (const key of cleared) this.bannerRetries.delete(key)
        banners = banners.filter(banner => !cleared.has(banner.key))
        log('info', this.label(
          `配置已保存：${label}。`,
          `The setting was saved: ${label}.`,
        ))
        savedLabels.push(label)
      } else if (outcome.status === 'expired') {
        const key = `save-expired:${label}`
        const row: SaveBanner = {
          key,
          source: 'save-expired',
          level: 'error',
          title: this.label('暂存已过期', 'Held save expired'),
          body: this.label('等待超时，配置尚未写入。请重试。', 'The wait expired before the setting was written. Please retry.'),
          at: outcome.at,
          actions: isPending ? ['retry', 'force', 'dismiss'] : ['retry', 'dismiss'],
          label,
          persistAcrossReload: true,
        }
        if ((rebuildRows || saveGateOutcomeForLabel(previous, label) === undefined) && wasClosedAcrossReload(row)) continue
        log('error', this.label(
          '配置保存等待超时，尚未写入；请重新保存。',
          'The setting was not saved before its wait expired. Please save it again.',
        ))
        this.bannerRetries.set(key, { kind: 'gate', label })
        banners = composeSaveBanners(banners, row)
      } else if (outcome.status === 'failed') {
        const key = `save-failed:${label}`
        const row: SaveBanner = {
          key,
          source: 'save-failed',
          level: 'error',
          title: this.label('保存失败', 'Save failed'),
          body: this.label(
            `配置未写入：${outcome.message ?? '未知错误'}`,
            `The setting was not written: ${outcome.message ?? 'unknown error'}`,
          ),
          at: outcome.at,
          actions: ['retry', 'dismiss'],
          label,
          persistAcrossReload: true,
        }
        if ((rebuildRows || saveGateOutcomeForLabel(previous, label) === undefined) && wasClosedAcrossReload(row)) continue
        log('error', this.label(
          `配置保存失败：${outcome.message ?? '未知错误'}`,
          `The setting could not be saved: ${outcome.message ?? 'unknown error'}`,
        ))
        this.bannerRetries.set(key, { kind: 'gate', label })
        banners = composeSaveBanners(banners, row)
      } else if (outcome.status === 'cancelled') {
        // A superseded row belongs to a newer save; a label still queued has
        // not settled either. Neither is this attempt's cancellation.
        if (saveGateOutcomeSuperseded(outcome) || isPending) continue
        // Cancellation is a silent terminal result: no banner, one log line.
        if (wasPending) log('info', this.label('配置暂存已取消。', 'The held setting was cancelled.'))
      }
    }
    // One frame can settle several agents together. Show a single success row
    // that names every one of them instead of letting the last overwrite the
    // rest, and keep one log line per label above.
    if (savedLabels.length > 0) {
      banners = composeSaveBanners(banners, this.saveSuccessBanner(savedLabels.length, savedLabels))
    }
    return {
      ...(logged.length === 0 ? {} : {
        logs: [...this.state.logs, ...logged].slice(-LOG_MAX_ENTRIES),
        logUnread: this.state.logUnread + logged.length,
      }),
      ...(banners === this.state.saveBanners ? {} : { saveBanners: banners }),
    }
  }

  /**
   * Add or replace one banner. The key IS the dedupe rule; failure rows are
   * never dropped by count, and only one transient success row is kept.
   */
  private pushSaveBanner(banner: SaveBanner): void {
    this.mutate({ saveBanners: composeSaveBanners(this.state.saveBanners, banner) })
  }

  /**
   * Set the plugin's OWN default ACP agent (the panel's ★ gesture): which agent
   * an ACP-mode conversation starts on. Plugin-private state — the host keeps it
   * in its own agent registry file, and nothing here touches DSH's model
   * selection (see docs/acp-convergence.md §2.2).
   */
  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    try {
      await this.call('default/agent-set', { ...(agentId === undefined ? {} : { agentId }) })
      this.mutate({ defaultAgent: agentId })
    } catch (error) {
      this.flashError(error)
    }
  }

  /**
   * Write the agent tag's halo preference (settings card). The value is
   * validated host-side; this side writes optimistically first so the tag's
   * look changes with the click, and reverts to the host answer on a failure.
   */
  async setTagHalo(halo: AcpTagHalo): Promise<void> {
    const previous = this.state.tagHalo
    this.mutate({ tagHalo: halo })
    try {
      await this.call('ui/tag-halo-set', { halo })
    } catch (error) {
      this.mutate({ tagHalo: previous })
      this.flashError(error)
    }
  }

  /**
   * Write the approval deadline (settings card), or drop the persisted override
   * with `reset` so the `cordis.patch.yml` baseline applies again.
   *
   * The host answer — the same route returns the deadlines now in force — is the
   * authority, so an optimistic write that the host trims (out of range, or
   * merged with a value this browser did not know about) self-corrects instead
   * of drifting from what runs.
   */
  async setApprovalDeadline(ms: number): Promise<void> {
    await this.writeApprovalDeadlines({ permissionTimeoutMs: ms })
  }

  /**
   * Write the mode: what an expired deadline DOES (`abort` refuses, `auto`
   * answers with the option the agent's own kinds imply, `wait` never
   * expires). Same write path as the window, so the host answer stays
   * the authority.
   */
  async setApprovalTimeoutMode(mode: PermissionTimeoutMode): Promise<void> {
    await this.writeApprovalDeadlines({ mode })
  }

  /** Drop the persisted override: the config file (or the built-in default) decides again. */
  async resetApprovalDeadlines(): Promise<void> {
    await this.writeApprovalDeadlines({ reset: true })
  }

  /**
   * Write the idle-release window (in ms).
   *
   * The host answer — the same route returns the window now in force — is
   * the authority, so an optimistic write that the host trims self-corrects
   * instead of drifting from what runs.
   */
  async setIdleRelease(idleTimeoutMs: number): Promise<void> {
    await this.writeIdleRelease({ idleTimeoutMs })
  }

  /**
   * Drop the persisted override: the config file (or the built-in default)
   * decides again.
   */
  async resetIdleRelease(): Promise<void> {
    await this.writeIdleRelease({ reset: true })
  }

  private async writeIdleRelease(payload: IdleReleaseSetPayload): Promise<void> {
    const previous = this.state.idleRelease
    try {
      const result = await this.call<IdleReleaseResult>('ui/idle-release-set', payload)
      this.mutate({ idleRelease: result.idleRelease })
    } catch (error) {
      this.mutate({ idleRelease: previous })
      this.flashError(error)
    }
  }

  private async writeApprovalDeadlines(payload: ApprovalDeadlinesSetPayload): Promise<void> {
    const previous = this.state.approvalDeadlines
    // Optimistic only where it is safe: the effective numbers and the mode move
    // now, and the override facts (`configured`) stay as the host last reported
    // them. A failure restores the whole view.
    if (previous !== undefined) {
      this.mutate({
        approvalDeadlines: {
          ...previous,
          ...(payload.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: payload.permissionTimeoutMs }),
          ...(payload.mode === undefined ? {} : { mode: payload.mode }),
        },
      })
    }
    try {
      const result = await this.call<ApprovalDeadlinesResult>('ui/approval-deadlines-set', payload)
      this.mutate({ approvalDeadlines: result.deadlines })
    } catch (error) {
      this.mutate({ approvalDeadlines: previous })
      this.flashError(error)
    }
  }

  /**
   * Bind one DSH chat session to an ACP agent. This is the plugin's own
   * conversation↔agent mapping: it does NOT write a DSH model route, so it
   * cannot pollute the deployment default model and cannot be refused by the
   * GUI's catalog gate (the retired `session/model-unavailable` failure).
   *
   * The mapping is host-side and keyed by chat session id; the browser learns
   * the binding back through `session/chat-list`.
   */
  async bindChatAgent(dshSessionId: string, agentId: string): Promise<void> {
    try {
      await this.call('session/chat-bind', { dshSessionId, agentId })
      // Optimistic: the host recorded the intent, so the NEXT message runs the
      // picked agent — but the live-session list (`chatSessions`) cannot show
      // that until the turn materializes its session. Recording here is what
      // makes the chip and the picker's checkmark move on the click itself.
      this.mutate({ chatBoundAgent: { ...this.state.chatBoundAgent, [dshSessionId]: agentId } })
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Switch the bound agent's model (`agentId@choice`) for one chat session. */
  async setChatSessionModel(dshSessionId: string, modelId: string, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-model-set', { dshSessionId, modelId })
      // Optimistic for the same reason the binding is: the host recorded the
      // pick, and a conversation with no ACP session yet would otherwise show
      // the agent's default until its first turn created one.
      const safeAgent = (agentId && agentId.trim()) || undefined
      const targetAgent = safeAgent ?? (modelId ? splitModelAgentId(modelId) : undefined)
      this.writeChoice(dshSessionId, choice => ({ ...choice, modelId }), targetAgent)
      if (this.state.chatSessionsFor === dshSessionId) {
        const owner = targetAgent ?? this.state.chatChoice[dshSessionId]?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
        let changed = false
        const chatSessions = this.state.chatSessions.map(s => {
          if (s.agentId !== owner || s.modelId === modelId) return s
          changed = true
          return { ...s, modelId }
        })
        if (changed) this.mutate({ chatSessions })
      }
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Switch the bound agent's reasoning effort for one chat session. */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-effort-set', {
        dshSessionId,
        ...(effort === undefined ? {} : { effort }),
        ...(agentId === undefined ? {} : { agentId }),
      })
      const targetAgent = (agentId && agentId.trim()) || undefined
      this.writeChoice(dshSessionId, choice => {
        const { effort: _dropped, ...rest } = choice
        return effort === undefined ? rest : { ...rest, effort }
      }, targetAgent)
      if (this.state.chatSessionsFor === dshSessionId) {
        const owner = targetAgent ?? this.state.chatChoice[dshSessionId]?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
        let changed = false
        const chatSessions = this.state.chatSessions.map(s => {
          if (s.agentId !== owner || s.reasoningEffort === effort) return s
          changed = true
          return { ...s, reasoningEffort: effort }
        })
        if (changed) this.mutate({ chatSessions })
      }
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Set one of the bound agent's EXTRA config options for one chat session. */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-config-set', {
        dshSessionId,
        configId,
        value,
        ...(agentId === undefined ? {} : { agentId }),
      })
      this.writeChoice(dshSessionId, choice => ({
        ...choice,
        extraConfigs: { ...choice.extraConfigs, [configId]: value },
      }), agentId)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /**
   * Patch one conversation's optimistic pick. The agent half is required by the
   * record (a model or thought level belongs to an agent). Its owner is the
   * route the picker used, else the recorded pick, the optimistic binding, or
   * the plugin default — that last one really serves a never-bound conversation
   * (the guard routes to it), so waiting for `session/chat-list` would leave the
   * chip behind the click. Only a conversation with none of those is left alone.
   */
  private writeChoice(dshSessionId: string, update: (choice: AcpConversationChoice) => AcpConversationChoice, agentId?: string): void {
    const current = this.state.chatChoice[dshSessionId]
    // The plugin default is a real route (the host applies it to a conversation
    // nobody bound), so an optimistic pick in a fresh conversation belongs to
    // it — without this the host recorded the pick but the chip waited for the
    // next `session/chat-list`.
    const owner = agentId ?? current?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
    if (owner === undefined) return
    const next = update({ ...current, agentId: owner })
    this.mutate({ chatChoice: { ...this.state.chatChoice, [dshSessionId]: { ...next, agentId: owner } } })
  }

  /**
   * Localize one string. BOUND to the instance in the constructor: the ACP
   * view hands this reference to memoized rows, so it must stay stable across
   * renders or every row re-renders on every store notification.
   */
  label: (zh: string, en: string) => string = (zh: string, en: string): string => this.locale(zh, en)

  /**
   * Republish the snapshot after a locale switch. Every `label()` resolves
   * against the current language while rendering, so a notification is all
   * that is needed — except the detect summary, which the store owns as an
   * already-resolved string and rebuilds from its counts here.
   */
  refreshLocale(): void {
    const counts = this.detectCounts
    this.mutate({
      localeRev: this.state.localeRev + 1,
      ...(counts === undefined ? {} : { detectSummary: this.detectSummaryOf(counts.total, counts.installed) }),
    })
  }

  clearNotice(): void {
    this.mutate({ notice: undefined })
  }

  /** Drop every retained runtime-log line (the unread counter restarts too). */
  clearLogs(): void {
    this.mutate({ logs: [], logUnread: 0 })
  }

  /** The user looked at the log: clear the unread badge. */
  markLogsRead(): void {
    if (this.state.logUnread === 0) return
    this.mutate({ logUnread: 0 })
  }

  private flashError(error: unknown): void {
    this.mutate({ notice: error instanceof Error ? error.message : String(error) })
  }

  // ---- Event application ----

  /**
   * One chat-row lifecycle frame, recorded in arrival order. A bounded log is
   * enough: a `session/chat-list` read only needs the frames since it started.
   */
  private pushChatRowFrame(sessionId: string, kind: ChatRowFrame['kind']): void {
    this.chatRowFrameSeq += 1
    this.chatRowFrames.push({ seq: this.chatRowFrameSeq, sessionId, kind })
    if (this.chatRowFrames.length > 256) this.chatRowFrames.shift()
  }

  /**
   * Feed the replay log BEFORE the switch folds the frame into the snapshot.
   * Live SSE frames and directly injected test frames then take the same path.
   */
  private noteChatRowFrame(event: AcpEvent): void {
    switch (event.type) {
      case 'session/released': this.pushChatRowFrame(event.sessionId, 'released'); break
      case 'session/reset': this.pushChatRowFrame(event.sessionId, 'reset'); break
      case 'session/created': this.pushChatRowFrame(event.sessionId, 'created'); break
      case 'session/closed': this.pushChatRowFrame(event.sessionId, 'closed'); break
    }
  }

  private applyEvent(event: AcpEvent): Promise<void> {
    this.noteChatRowFrame(event)
    switch (event.type) {
      case 'agent/notice': {
        if (event.agentId === 'hmr') {
          // The hot-reload guard speaks through `agent/notice`; a log line is
          // invisible unless the user opens the log, so the same fact also
          // becomes a persistent page-top banner.
          const retryFailure = event.text.includes('retry failed') || event.text.includes('did not start')
          this.pushSaveBanner({
            key: 'hmr-delay',
            source: 'hmr-delay',
            level: 'error',
            title: this.label('热重载被延迟', 'Hot reload delayed'),
            body: retryFailure
              ? this.label('热重载重试失败，配置会在本轮对话结束后重新加载。', 'The hot-reload retry failed. The configuration will reload when this turn ends.')
              : this.label('对话仍在进行，配置热重载已延迟；回合结束后会自动重新加载。', 'A turn is still running, so the configuration reload is delayed. It will reload when the turn ends.'),
            at: Date.now(),
            actions: ['dismiss'],
          })
        }
        this.mutate(this.logPatch(event.level, event.text, event.agentId))
        return Promise.resolve()
      }
      case 'agent/status': {
        if (event.agent !== undefined) {
          const agents = this.state.agents.some(a => a.id === event.agent?.id)
            ? this.state.agents.map(a => (a.id === event.agent?.id ? event.agent : a))
            : [...this.state.agents, event.agent]
          this.mutate({ agents })
        } else {
          this.mutate({})
        }
        return Promise.resolve()
      }
      case 'session/created': {
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        this.mutate({ sessions, activeSessionId: this.state.activeSessionId ?? event.sessionId })
        return Promise.resolve()
      }
      case 'session/meta': {
        // Host re-published the session view after mode/config changes or a
        // resume. The composer's occupancy ring reads the chat-list row, so
        // that row must follow the snapshot's usage too — including an absent
        // one, which must clear an older reading rather than outlive it.
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : this.state.sessions
        let chatSessions = withSessionUsage(this.state.chatSessions, event.sessionId, event.session.usage)
        chatSessions = withSessionModes(chatSessions, event.sessionId, event.session.modes)
        this.mutate({
          sessions,
          ...(chatSessions === this.state.chatSessions ? {} : { chatSessions }),
          ...this.watchedSessionPatch(event.sessionId, event.session),
        })
        return Promise.resolve()
      }
      case 'session/closed': {
        const closingSession = this.state.sessions.find(s => s.sessionId === event.sessionId)
        const sessions = this.state.sessions.filter(s => s.sessionId !== event.sessionId)
        const active = this.state.activeSessionId === event.sessionId ? sessions[0]?.sessionId : this.state.activeSessionId
        this.openTurns.delete(event.sessionId)
        const closedTranscripts = { ...this.state.chatTranscripts }
        delete closedTranscripts[event.sessionId]
        // The composer's chat-list view must lose the closed row too: a stale
        // entry would keep reading as a live session (the agent tag's halo
        // breathes on `!released`) until some future turn re-reads the list.
        const chatSessions = this.state.chatSessions.filter(s => s.sessionId !== event.sessionId)
        // The burst aggregate belongs to this ACP session only; another
        // session's entry must survive. Only patch when there was an entry.
        const hadBurst = this.state.burstStats[event.sessionId] !== undefined
        let burstStats = this.state.burstStats
        if (hadBurst) {
          burstStats = { ...burstStats }
          delete burstStats[event.sessionId]
        }
        this.mutate({
          sessions,
          activeSessionId: active,
          chatTranscripts: closedTranscripts,
          ...(chatSessions.length !== this.state.chatSessions.length ? { chatSessions } : {}),
          ...(hadBurst ? { burstStats } : {}),
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          ...(event.reason === 'agent-died'
            ? this.logPatch('error', this.locale('会话因 agent 进程退出而终止', 'session ended: agent process died'), closingSession?.agentId)
            : {}),
        })
        return Promise.resolve()
      }
      case 'session/released': {
        // The agent process died: keep the session visible (marked released)
        // instead of dropping it — the next prompt resumes it via session/load.
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        this.openTurns.delete(event.sessionId)
        // The composer's own list (`session/chat-list` views) must flip too, or
        // the agent tag's live halo keeps breathing for a process that is gone:
        // nothing else re-reads this list until the next turn settles.
        const chatSessions = withSessionReleased(this.state.chatSessions, event.sessionId, true)
        // One runtime-log line per release cause; `idle` stays silent on
        // purpose (an expected lifecycle transition, not a fault).
        const cause = event.cause ?? 'died'
        let log: Partial<Pick<UiState, 'logs' | 'logUnread'>> = {}
        if (cause === 'workspace') {
          log = this.logPatch('info', this.locale(
            'agent 为切换工作区重启，会话已挂起；再次发送消息将自动恢复。',
            'agent restarted for its workspace; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        } else if (cause === 'resume-failed') {
          log = this.logPatch('error', this.locale(
            '会话恢复失败；再次发送消息将重试恢复。',
            'session resume failed; your next message will retry it.',
          ), event.session.agentId)
        } else if (cause === 'stalled') {
          log = this.logPatch('error', this.locale(
            'agent 未响应卡死的回合，会话已挂起；再次发送消息将自动恢复。',
            'agent did not acknowledge the stalled turn; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        } else if (cause === 'died') {
          log = this.logPatch('error', this.locale(
            'agent 进程已退出，会话已挂起；再次发送消息将自动恢复。',
            'agent process died; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        }
        this.mutate({
          sessions,
          ...(chatSessions !== this.state.chatSessions ? { chatSessions } : {}),
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          // An observed transcript keeps its buffer but flips to released, so
          // the ACP view can say "会恢复" instead of silently looking dead.
          ...this.watchedSessionPatch(event.sessionId, event.session),
          ...log,
        })
        return Promise.resolve()
      }
      case 'session/reset': {
        // The session was resumed on a fresh process and the agent is about to
        // replay its history as fresh updates: drop local blocks and the seq
        // watermark so the replay folds in from a clean slate.
        this.lastSeq.set(event.sessionId, 0)
        this.openTurns.delete(event.sessionId)
        const isActive = event.sessionId === this.state.activeSessionId
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        // The agent is about to replay its whole history as fresh updates:
        // an observed transcript must drop both its blocks and its watermark
        // or the replay would be read as a gap and refetched forever.
        const watched = this.state.chatTranscripts[event.sessionId]
        // ...and the composer's own list must flip back to live on the same
        // event (mirror of the `session/released` flip): the released banner
        // and the tag's halo read that row, and nothing else re-reads it until
        // a turn settles — a resume would leave the banner claiming a parked
        // process that is already back.
        const chatSessions = withSessionReleased(this.state.chatSessions, event.sessionId, false)
        this.mutate({
          sessions,
          ...(chatSessions === this.state.chatSessions ? {} : { chatSessions }),
          ...(isActive ? { blocks: [] } : {}),
          ...(watched === undefined ? {} : {
            chatTranscripts: {
              ...this.state.chatTranscripts,
              [event.sessionId]: { ...watched, session: event.session, blocks: [], seq: 0 },
            },
          }),
        })
        return Promise.resolve()
      }
      case 'session/update': {
        // Coalesced (see `pendingUpdates`): one fold + one mutate per frame.
        this.pendingUpdates.push({ sessionId: event.sessionId, seq: event.seq, update: event.update })
        this.armUpdateFlush()
        return Promise.resolve()
      }
      case 'catalog/updated': {
        // The host learned a new catalog, or a new slash-command list, from a
        // real session (its session/new, session/load, a config_option_update,
        // or an available_commands_update). The seat list is a cached
        // projection of both, so drop and re-read it — deduped by
        // `loadAgentCatalog`, and memory-only on the host, so this never starts
        // a probe.
        this.invalidateSeatCatalog(event.agentId)
        return this.loadAgentCatalog(event.agentId)
      }
      case 'agent/exposure': {
        // The host changed an agent's model visibility outside `agent/save`:
        // the settings card edited it, the auto-discovery switch was flipped,
        // or newly published models were appended automatically. Patch the
        // settings card's copy of the definition AND drop the seat cache — the
        // variants `agent/catalog` answers are a projection of this filter.
        const exposedModels = event.exposedModels.length === 0 ? undefined : [...event.exposedModels]
        const detectedAgents = this.state.detectedAgents.map(info =>
          info.id === event.agentId && info.currentConfig !== undefined
            ? {
                ...info,
                currentConfig: {
                  ...info.currentConfig,
                  exposedModels: exposedModels === undefined ? undefined : exposedModels,
                  autoDiscoverModels: event.autoDiscoverModels,
                },
              }
            : info)
        this.invalidateSeatCatalog(event.agentId)
        this.mutate({ detectedAgents })
        return this.loadAgentCatalog(event.agentId)
      }
      case 'permission/request': {
        // Verbatim copy of the host's frame. The host decides what the ask is
        // called (`toolName` / `reason`) and which options exist; deriving a
        // title from `toolCall` here used to make the card say something the
        // host never said.
        const permission: PendingPermission = {
          requestId: event.requestId,
          sessionId: event.sessionId,
          ...(event.dshSessionId === undefined ? {} : { dshSessionId: event.dshSessionId }),
          toolName: event.toolName,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          options: event.options,
          timeoutMode: event.timeoutMode,
          ...(event.deadlineAt === undefined ? {} : { deadlineAt: event.deadlineAt }),
        }
        this.mutate({
          permissions: [...this.state.permissions.filter(p => p.requestId !== event.requestId), permission],
        })
        return Promise.resolve()
      }
      case 'permission/resolved': {
        this.mutate({ permissions: this.state.permissions.filter(p => p.requestId !== event.requestId) })
        return Promise.resolve()
      }
      case 'permission/synced': {
        // Terminator of the reconnect replay: the host just re-sent every
        // outstanding ask, and this set is the authoritative live list. Drop
        // anything this client still holds from before the disconnect — an ask
        // resolved while it was away is gone host-side, and answering it would
        // only earn `unknown_request`.
        const live = new Set(event.requestIds)
        this.mutate({ permissions: this.state.permissions.filter(p => live.has(p.requestId)) })
        return Promise.resolve()
      }
      case 'chat/agent-locked': {
        // The host locks a conversation at the START of its first ACP turn and
        // says so at once; this frame is what makes the hand-off animation run
        // at the start rather than on the turn-settled list read. It is emitted
        // only on the transition, so it always announces a new ceremony — even
        // if a racing list read already seeded the lock itself.
        this.chatUnlocked.delete(event.dshSessionId)
        this.mutate({
          chatLockedAgent: { ...this.state.chatLockedAgent, [event.dshSessionId]: event.agentId },
          chatBoundAgent: { ...this.state.chatBoundAgent, [event.dshSessionId]: event.agentId },
          agentLockReveal: { ...this.state.agentLockReveal, [event.dshSessionId]: (this.state.agentLockReveal[event.dshSessionId] ?? 0) + 1 },
        })
        return Promise.resolve()
      }
      case 'chat/agent-unlocked': {
        // The first turn delivered nothing and the host rolled the lock back.
        // The base must return; the failed ACP session is closed host-side, so
        // drop a cached list that still names it and let the next read confirm.
        this.chatUnlocked.add(event.dshSessionId)
        const chatLockedAgent = { ...this.state.chatLockedAgent }
        delete chatLockedAgent[event.dshSessionId]
        this.mutate({
          chatLockedAgent,
          ...(this.state.chatSessionsFor === event.dshSessionId ? { chatSessions: [] } : {}),
        })
        return Promise.resolve()
      }
      case 'turn/metrics': {
        // Plugin-side burst aggregate for one ACP session. A late LIVE frame
        // must not regress a turn this page already saw finalized (frames can
        // land out of order across a stream reconnect); any other frame writes
        // the entry. Blocks / sessions stay untouched — this is a metric.
        // The frame also names BOTH ids, so it refreshes the ACP→chat owner
        // mapping the worker detail index is scoped by.
        this.acpSessionOwners.set(event.sessionId, event.dshSessionId)
        const prior = this.state.burstStats[event.sessionId]
        if (event.final === false && prior !== undefined && prior.final === true && prior.turnId === event.turnId) {
          return Promise.resolve()
        }
        this.mutate({
          burstStats: {
            ...this.state.burstStats,
            [event.sessionId]: {
              outputTokens: event.outputTokens,
              burstMs: event.burstMs,
              turnId: event.turnId,
              final: event.final,
            },
          },
        })
        return Promise.resolve()
      }
      case 'turn/start': {
        this.openTurns.add(event.sessionId)
        this.markWatchedRunning(event.sessionId, true)
        // Every turn starts AFTER the host (re)materialized the session: a
        // resume keeps its id, a `session/new` changes it. The composer's row
        // list is a cached snapshot, so re-read it once per turn. `force`
        // drops a read that began before this turn — its answer still names
        // the released row, and the released banner would then hang over a
        // turn that is already running on a live process. Concurrent readers
        // share this one read through the in-flight dedup.
        const chatSessionId = this.state.chatSessionsFor
        if (chatSessionId !== undefined) {
          void this.loadChatSessions(chatSessionId, { force: true })
        }
        if (event.sessionId === this.state.activeSessionId) {
          this.state.blocks.push({ kind: 'user', text: event.text })
          trimBlocks(this.state.blocks)
          this.mutate({ sessions: this.state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: true } : s)) })
        }
        return Promise.resolve()
      }
      case 'turn/end': {
        // One turn may end twice (force-finalized after an ignored cancel, or
        // settled by the host after a crash, then the real response arrives);
        // only the first turn/end per open turn is applied.
        if (!this.openTurns.has(event.sessionId)) return Promise.resolve()
        this.openTurns.delete(event.sessionId)
        this.markWatchedRunning(event.sessionId, false)
        if (event.sessionId === this.state.activeSessionId) {
          if (event.error !== undefined) {
            this.state.blocks.push({ kind: 'notice', tone: 'error', text: event.error })
          } else if (event.stopReason !== undefined && event.stopReason !== 'end_turn') {
            this.state.blocks.push({ kind: 'notice', tone: 'info', text: `stop: ${event.stopReason}` })
          }
          trimBlocks(this.state.blocks)
          this.mutate({ sessions: this.state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: false } : s)) })
        }
        return Promise.resolve()
      }
      case 'save/status': {
        const status = normalizeSaveGateStatus(event.status)
        this.mutate({
          saveGate: status,
          ...this.saveGatePatch(this.state.saveGate, status),
        })
        return Promise.resolve()
      }
      case 'subagents/record': {
        // One worker's plugin-owned lifecycle record: creation and every
        // status transition of one dispatch. Logged for the chat-list replay
        // (the answer may predate this frame), then folded by key — never by
        // `childId` alone, which can repeat across conversations.
        this.subagentRecordSeq += 1
        this.subagentRecordFrames.push({
          seq: this.subagentRecordSeq,
          dshSessionId: event.dshSessionId,
          record: event.record,
        })
        if (this.subagentRecordFrames.length > 256) this.subagentRecordFrames.shift()
        const key = subagentKey(event.dshSessionId, event.record.childId)
        const existing = this.state.subagents[key]
        if (isSubagentDowngrade(existing, event.record)) {
          return Promise.resolve()
        }
        this.mutate({
          subagents: {
            ...this.state.subagents,
            [key]: { ...event.record, dshSessionId: event.dshSessionId },
          },
        })
        return Promise.resolve()
      }
      default:
        return Promise.resolve()
    }
  }
}

/** Merge a raw ACP update into the block list (mutates in place). */
/**
 * Fold one transcript update into a block list. IMMUTABLE per block: the ACP
 * view memoizes rows on the block object, so an appended chunk replaces the
 * tail block instead of mutating it (array copies stay the caller's job, one
 * per folded batch). Returns whether any block changed — a usage-only tick
 * folds to `false` and the batch skips copying the array.
 *
 * `raw` is a lazy getter: pretty-printing a tool payload costs up to
 * {@link RAW_MAX} characters of JSON per call, and progress ticks restate
 * whole calls at high frequency — the cost is paid once, by the view that
 * actually shows the card, never by the fold loop.
 */
export function foldUpdate(blocks: Block[], update: Record<string, unknown>): boolean {
  const kind = String(update.sessionUpdate ?? '')
  const content = update.content as Record<string, unknown> | undefined
  switch (kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const targetKind = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'agent' : 'thought'
      const text = chunkText(content)
      if (text === '') return false
      const messageId = typeof update.messageId === 'string' ? update.messageId : undefined
      const last = blocks[blocks.length - 1]
      if (targetKind === 'agent' && last?.kind === 'agent' && ((messageId !== undefined && last.messageId === messageId) || (messageId === undefined && last.messageId === undefined))) {
        blocks[blocks.length - 1] = { ...last, text: last.text + text }
      } else if (targetKind !== 'agent' && last?.kind === targetKind) {
        blocks[blocks.length - 1] = { ...last, text: last.text + text }
      } else if (targetKind === 'agent') {
        blocks.push({ kind: 'agent', ...(messageId === undefined ? {} : { messageId }), text })
      } else {
        blocks.push({ kind: targetKind, text })
      }
      return true
    }
    case 'tool_call': {
      let rawOf: string | undefined
      blocks.push({
        kind: 'tool',
        toolCallId: String(update.toolCallId ?? ''),
        title: String(update.title ?? ''),
        status: String(update.status ?? 'pending'),
        ...(typeof update.kind === 'string' ? { toolKind: update.kind } : {}),
        ...splitToolContent(update.content),
        ...toolInputFields(update),
        get raw() { return rawOf ??= jsonText(update) },
      })
      return true
    }
    case 'tool_call_update': {
      const id = String(update.toolCallId ?? '')
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (block?.kind !== 'tool' || block.toolCallId !== id) continue
        // An update restates the call in whole, but every field it does NOT
        // carry keeps the block's previous value (the restatement that only
        // brings a result must not wipe the arguments the card shows).
        const parsed = splitToolContent(update.content)
        const input = toolInputOf(update)
        const details = toolDetailsOf(update)
        let rawOf: string | undefined
        blocks[i] = {
          kind: 'tool',
          toolCallId: id,
          title: typeof update.title === 'string' && update.title !== '' ? update.title : block.title,
          status: typeof update.status === 'string' ? update.status : block.status,
          ...(typeof update.kind === 'string' ? { toolKind: update.kind } : block.toolKind === undefined ? {} : { toolKind: block.toolKind }),
          lines: parsed.lines.length > 0 ? parsed.lines : block.lines,
          ...(parsed.diffs === undefined
            ? block.diffs === undefined ? {} : { diffs: block.diffs }
            : { diffs: parsed.diffs }),
          ...(parsed.extras.length > 0 ? { extras: parsed.extras } : block.extras === undefined ? {} : { extras: block.extras }),
          ...(input === undefined ? block.input === undefined ? {} : { input: block.input } : { input }),
          ...(details.length > 0 ? { details } : block.details === undefined ? {} : { details: block.details }),
          get raw() { return rawOf ??= jsonText(update) },
        }
        return true
      }
      // Update for a tool call that rolled out of the transcript window.
      let rawOf: string | undefined
      blocks.push({
        kind: 'tool',
        toolCallId: id,
        title: id,
        status: String(update.status ?? 'completed'),
        ...splitToolContent(update.content),
        ...toolInputFields(update),
        get raw() { return rawOf ??= jsonText(update) },
      })
      return true
    }
    case 'plan': {
      const entries = Array.isArray(update.entries)
        ? (update.entries as Array<Record<string, unknown>>).map(e => ({
          content: String(e.content ?? ''),
          status: String(e.status ?? 'pending'),
          ...(typeof e.priority === 'string' ? { priority: e.priority } : {}),
        }))
        : []
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (block?.kind !== 'plan') continue
        blocks[i] = { ...block, entries }
        return true
      }
      blocks.push({ kind: 'plan', entries })
      return true
    }
    default: {
      // Every remaining notification kind is kept, not dropped: a command list,
      // a mode change, or a kind newer than this build. Bookkeeping frames that
      // say nothing new (`config_option_update` / `usage_update` /
      // `session_info_update`) ride the SessionView snapshot — they are state,
      // not stream content, and a row per tick would be noise.
      if (kind === '' || STATE_ONLY_UPDATES.has(kind)) return false
      let rawOf: string | undefined
      blocks.push({ kind: 'event', event: kind, text: describeEvent(kind, update), get raw() { return rawOf ??= jsonText(update) } })
      return true
    }
  }
}

/**
 * The input / detail fields a tool block carries from an update, spread-ready.
 * Kept apart from the content split so `tool_call` and `tool_call_update` share
 * one spelling of "when does a field appear".
 */
function toolInputFields(update: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const input = toolInputOf(update)
  if (input !== undefined) fields.input = input
  const details = toolDetailsOf(update)
  if (details.length > 0) fields.details = details
  return fields
}

/** Notifications that update the SessionView snapshot instead of the block stream. */
export const STATE_ONLY_UPDATES: ReadonlySet<string> = new Set([
  'config_option_update',
  'usage_update',
  'session_info_update',
])

/**
 * Context occupancy carried by one raw `usage_update` frame, in the shape the
 * session snapshots already use. A malformed frame is ignored (the last good
 * sample stays on screen) instead of zeroing the meter.
 */
export function usageFromUpdate(update: Record<string, unknown>): SessionView['usage'] | undefined {
  const used = update.used
  const size = update.size
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined
  if (typeof size !== 'number' || !Number.isFinite(size)) return undefined
  const cost = update.cost
  if (cost !== null && typeof cost === 'object' && !Array.isArray(cost)) {
    const row = cost as Record<string, unknown>
    if (typeof row.amount === 'number' && Number.isFinite(row.amount)
      && typeof row.currency === 'string' && row.currency !== '') {
      return { used, size, cost: { amount: row.amount, currency: row.currency } }
    }
  }
  return { used, size }
}

function sameUsage(left: SessionView['usage'], right: SessionView['usage']): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.used !== right.used || left.size !== right.size) return false
  const leftCost = left.cost
  const rightCost = right.cost
  if (leftCost === undefined || rightCost === undefined) return leftCost === rightCost
  return leftCost.amount === rightCost.amount && leftCost.currency === rightCost.currency
}

/** Patch one session row's usage; other rows and an unchanged value keep their identities. */
function withSessionUsage<T extends { sessionId: string; usage?: SessionView['usage'] }>(
  rows: T[],
  sessionId: string,
  usage: SessionView['usage'],
): T[] {
  let changed = false
  const next = rows.map(row => {
    if (row.sessionId !== sessionId || sameUsage(row.usage, usage)) return row
    changed = true
    return { ...row, usage }
  })
  return changed ? next : rows
}

/**
 * Flip one chat row's `released` flag (release/resume bookkeeping). The
 * composer's own list (`session/chat-list` rows) has no other live writer —
 * `session/released` must mark it, `session/reset` must un-mark it, or the
 * agent tag's halo and the released banner read yesterday's process state.
 */
function withSessionReleased<T extends { sessionId: string; released?: boolean }>(
  rows: T[],
  sessionId: string,
  released: boolean,
): T[] {
  let changed = false
  const next = rows.map(row => {
    if (row.sessionId !== sessionId || (row.released === true) === released) return row
    changed = true
    return { ...row, released }
  })
  return changed ? next : rows
}

/**
 * Re-apply the chat-row lifecycle frames that landed AFTER a
 * `session/chat-list` read started. The host answer describes an earlier
 * moment; without this replay a late answer overwrites the `session/reset`
 * flip and the released banner keeps claiming a process that is already back.
 * Only rows the answer carries are patched — a row from another conversation
 * must never enter this conversation's list.
 */
export function replayChatRowFrames(
  rows: readonly ChatSessionView[],
  frames: readonly ChatRowFrame[],
  afterSeq: number,
): ChatSessionView[] {
  let next: ChatSessionView[] = [...rows]
  for (const frame of frames) {
    if (frame.seq <= afterSeq) continue
    switch (frame.kind) {
      case 'closed':
        next = next.filter(row => row.sessionId !== frame.sessionId)
        break
      case 'released':
        next = withSessionReleased(next, frame.sessionId, true)
        break
      case 'reset':
      case 'created':
        next = withSessionReleased(next, frame.sessionId, false)
        break
    }
  }
  return next
}

/**
 * A terminal record is never downgraded by a stale non-terminal frame: the
 * worker already reported, and the panel must not start claiming it is
 * running again. Everything else is last-wins (frames arrive in order).
 */
function isSubagentDowngrade(existing: SubagentRecord | undefined, incoming: SubagentRecord): boolean {
  return existing !== undefined && existing.endedAt !== undefined && incoming.endedAt === undefined
}

/**
 * Merge a `session/chat-list` answer's worker records for ONE conversation
 * into the store's keyed map, then replay the `subagents/record` frames that
 * landed while the read was in flight. Other conversations' records are left
 * untouched. A terminal record is never replaced by a non-terminal one: a
 * stale snapshot row must not revive a worker that already reported.
 */
export function mergeSubagentSnapshot(
  current: Readonly<Record<string, SubagentRecord>>,
  dshSessionId: string,
  rows: readonly ChatSessionView[],
  frames: ReadonlyArray<{ seq: number; dshSessionId: string; record: SubagentRecord }>,
  afterSeq: number,
): Record<string, SubagentRecord> {
  const next: Record<string, SubagentRecord> = { ...current }
  for (const key of Object.keys(next)) {
    if (next[key]?.dshSessionId === dshSessionId) delete next[key]
  }
  // One conversation can have several rows; the same record may appear on
  // each, so merge by `dshSessionId + childId`.
  for (const row of rows) {
    for (const record of row.subagents ?? []) {
      if (record.dshSessionId !== dshSessionId) continue
      next[subagentKey(dshSessionId, record.childId)] = record
    }
  }
  for (const frame of frames) {
    if (frame.seq <= afterSeq || frame.dshSessionId !== dshSessionId) continue
    const key = subagentKey(dshSessionId, frame.record.childId)
    const existing = next[key]
    if (isSubagentDowngrade(existing, frame.record)) continue
    next[key] = frame.record
  }
  return next
}

/** The CodeBuddy worker attribution a live update carries (`parentToolCallId`), if any. */
function parentToolCallIdOf(update: Record<string, unknown>): string | undefined {
  const meta = update._meta
  if (meta === null || typeof meta !== 'object') return undefined
  const value = (meta as Record<string, unknown>)['codebuddy.ai/parentToolCallId']
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Compact serialized form of one detail payload (never throws): the store
 * bounds and de-duplicates with it, the detail view renders payloads that
 * have no dedicated renderer with it (constraint 29).
 */
export function compactDetailValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Bound ONE live detail frame the same way the host's read does: over-budget
 * payloads become a MARKED cut, never a silent drop and never an unbounded
 * state object (constraint 29). Exported for the equivalence test pinning it
 * to the host's `boundSubagentDetailEntry` (tests/acp-view.spec.ts).
 */
export function boundedDetailEntry(seq: number, update: unknown, liveSeq: number): LiveSubagentDetailEntry {
  const text = compactDetailValue(update)
  if (text.length <= SUBAGENT_RAW_MAX) return { seq, update, liveSeq }
  const kind = update !== null && typeof update === 'object'
    ? (update as { sessionUpdate?: unknown }).sessionUpdate
    : undefined
  const cut = text.length - SUBAGENT_RAW_MAX
  return {
    seq,
    update: {
      sessionUpdate: typeof kind === 'string' ? kind : 'unknown',
      truncated: true,
      text: `${text.slice(0, SUBAGENT_RAW_MAX)}\n… [truncated ${String(cut)} chars]`,
    },
    truncatedChars: cut,
    liveSeq,
  }
}

/** Append one entry to a worker's index, dropping the oldest past the per-worker cap. */
function appendSubagentDetailEntry(
  state: SubagentDetailState,
  entry: LiveSubagentDetailEntry,
): SubagentDetailState {
  const entries = [...state.entries, entry]
  const overflow = entries.length - MAX_SUBAGENT_DETAIL_ENTRIES
  return {
    ...state,
    entries: overflow > 0 ? entries.slice(overflow) : entries,
    // The marker the panel renders: `omitted > 0` means the index does not
    // start at the worker's first frame.
    omitted: state.omitted + Math.max(0, overflow),
  }
}

function sameModes(a?: SessionView['modes'], b?: SessionView['modes']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.currentModeId !== b.currentModeId) return false
  const aModes = a.availableModes ?? []
  const bModes = b.availableModes ?? []
  if (aModes.length !== bModes.length) return false
  return aModes.every((m, i) => {
    const o = bModes[i]
    return m != null && o != null && m.id === o.id && m.name === o.name && m.description === o.description
  })
}

function withSessionModes<T extends { sessionId: string; modes?: SessionView['modes'] }>(
  rows: T[],
  sessionId: string,
  modes?: SessionView['modes'],
): T[] {
  if (!modes) return rows
  let changed = false
  const next = rows.map(row => {
    if (row.sessionId !== sessionId || sameModes(row.modes, modes)) return row
    changed = true
    return { ...row, modes }
  })
  return changed ? next : rows
}

function splitModelAgentId(modelId: string): string | undefined {
  const at = modelId.indexOf('@')
  const agent = at === -1 ? modelId.trim() : (at === 0 ? '' : modelId.slice(0, at).trim())
  return agent || undefined
}

/** Last well-formed `usage_update` in one coalesced batch (later ticks win). */
function usageOfBatch(items: ReadonlyArray<{ update: unknown }>): SessionView['usage'] | undefined {
  let usage: SessionView['usage'] | undefined
  for (const item of items) {
    const update = item.update as Record<string, unknown>
    if (update.sessionUpdate !== 'usage_update') continue
    const parsed = usageFromUpdate(update)
    if (parsed !== undefined) usage = parsed
  }
  return usage
}

function trimBlocks(blocks: Block[]): void {
  if (blocks.length > MAX_BLOCKS) blocks.splice(0, blocks.length - MAX_BLOCKS)
}
