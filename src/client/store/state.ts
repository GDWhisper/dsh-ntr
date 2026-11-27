/**
 * The store state shapes: the `UiState` snapshot React reads and the records it
 * carries. Types only — nothing here runs. Split out of `src/client/store.ts`
 * (split plan P3a), which re-exports it unchanged.
 */

import type { AcpApprovalDeadlines, AcpConversationChoice, AcpDelegateSettings, AcpIdleRelease, AcpPresetStatus, AcpReleaseCause, AcpSharedMcpSettings, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentSkillEntry, AgentView, ChatSessionView, DetectedAgentInfo, PluginUpdateState, SaveGateStatus, SessionView, SubagentRecord } from "../../protocol.ts"
import type { Block } from "./blocks.ts"
import type { PendingElicitation } from "./elicitation.ts"
import type { PendingPermission } from "./permission.ts"
import type { SaveBanner } from "./save-gate.ts"
import type { SubagentDetailState } from "./subagent.ts"

/** Cap on retained runtime-log lines; older entries fall off the front. */
export const LOG_MAX_ENTRIES = 200

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
  cause?: AcpReleaseCause
  reason?: string
  releasedAt?: number
}

/** The unary RPC face (narrowed `ctx.connection.rpc.call`). */
export type RpcCall = (channel: string, endpoint: string, payload: unknown) => Promise<
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }
>

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
  elicitations: PendingElicitation[]
  busy: boolean
  /**
   * The settings page's one-line banner for its OWN action failures. Agent-side
   * runtime messages do not land here; they append to {@link logs} instead.
   */
  notice?: string
  /** Page-top save banners; failures stay until dismissed, success auto-hides. */
  saveBanners: SaveBanner[]
  /** Currently staged main-view conversation and whether it runs ACP mode. */
  stagedSession?: { sessionId: string; isAcp: boolean }
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
   * Whether generated NTR session titles carry the `[NTR] ` badge (settings
   * toggle, default on). Writes land optimistically first; the host answer
   * is the authority. Only future title generations change — titles the host
   * already accepted are durable and stay as they are.
   */
  titlePrefix: boolean
  /**
   * Whether the built-in read-only `dsh-skills` MCP server is offered to
   * agents (settings toggle, default off). Absent until the host answered —
   * an UNREAD value is never treated as on, and the toggle renders off with
   * no promise it can keep. Writes land optimistically first; the host answer
   * is the authority.
   */
  skillsMcpEnabled?: boolean
  /** Unified MCP settings (global servers + optional host sync). Absent on older hosts. */
  sharedMcp?: AcpSharedMcpSettings
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
   * The `acp_delegate` settings in force, as the subagent card edits them.
   * Absent on a host half from before the card existed, which hides the page
   * rather than showing a number this browser invented. Writes land
   * optimistically and the host answer (same route) is the authority.
   */
  delegate?: AcpDelegateSettings
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
   * Agent skill rows for the `/` menu (from `agent/skills`), keyed by
   * {@link skillRowsKey}. The serving agent is part of the key, so switching
   * the binding invalidates by mismatch — no invalidation hook needed, the old
   * agent's rows just stop being looked up. `at` is the fetch time; past
   * {@link SKILL_MENU_TTL_MS} the rows read as "not asked yet" again. An EMPTY
   * rows array is a real answer ("this agent has no skills here"), never a
   * placeholder for "not asked yet" — that case is `undefined` from the reader.
   */
  agentSkills: Record<string, { at: number; rows: readonly AgentSkillEntry[] }>
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
