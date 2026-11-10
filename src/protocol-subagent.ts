/**
 * Subagent lifecycle contracts: pure types and constants only — no Node
 * imports, no side effects, no ACP SDK runtime values (same purity rule as
 * `protocol.ts`, which re-exports every name below so importers are unchanged).
 */

// ---- External subagent lifecycle (the plugin's own record) ----

/**
 * Where one detached ACP worker stands, as the plugin's own lifecycle record
 * knows it. Deliberately SIX states: the host's `subagentCatalog` projection
 * persists catalog MEMBERSHIP only (label / createdAt / mode), never a
 * lifecycle, and its client view cannot report success for an external row at
 * all (the row has no child session). This record is that missing fact.
 *
 * - `pending`: dispatched, no evidence of work yet (`status === 'pending'`, or
 *   the first `tool_call` frame carried no status).
 * - `running`: the wire proves it (`in_progress`, `isBackground`, or any
 *   update carrying `parentToolCallId`).
 * - `completed` / `failed`: the dispatch's OWN call reported that status —
 *   the real completion frame carries NO `_meta`, so the known call id is the
 *   only evidence needed.
 * - `cancelled`: the turn was cancelled while the worker had no terminal state.
 * - `unknown`: teardown ended the turn / session / process without a terminal
 *   frame, or a catalog row predates this record (`unknown` is never `ok`).
 */
export type SubagentStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'

/**
 * One external worker's plugin-owned lifecycle record.
 *
 * Persisted in `agents.json` under `subagents`, keyed by `dshSessionId` — the
 * LIST itself is still the host's `subagentCatalog` projection; this record
 * supplies what that projection cannot (status, failure reason, timings,
 * counts). Terminal records are written on state transitions only:
 * `lastActivityAt` moves with every worker update and rides along with the
 * next transition's write, never a write of its own.
 */
export interface SubagentRecord {
  /** Catalog id (`acp:<toolCallId>`), the same key the host projection uses. */
  childId: string
  /** The DSH chat session that owns the catalog row. */
  dshSessionId: string
  /** The dispatch's own `Agent` / `Task` tool call id (the `acp:` suffix's source). */
  toolCallId: string
  /** One-line label; a FALLBACK — the panel normally reads the host projection's. */
  label: string
  /** The worker's declared role (`_meta["codebuddy.ai/subagentType"]`). */
  type?: string
  status: SubagentStatus
  startedAt: number
  lastActivityAt: number
  /** When a terminal status was written; absent while pending / running. */
  endedAt?: number
  /**
   * The terminal frame's `tool_call_update.content`, VERBATIM: a string, an
   * object or an array all survive (constraint 29). Absent means the agent
   * gave no reason — the panel says so rather than guessing.
   */
  error?: unknown
  /** Per-worker counters: wire updates, worker tool calls, worker text chars. */
  counts: { updates: number; toolCalls: number; textChars: number }
}

/** Per-chat-session cap on persisted {@link SubagentRecord}s; the oldest TERMINAL rows go first. */
export const MAX_SUBAGENT_RECORDS = 200
/** Per-worker cap on raw detail entries (host read AND browser index). */
export const MAX_SUBAGENT_DETAIL_ENTRIES = 200

/**
 * One raw `session/update` in a worker's on-demand detail history.
 *
 * `update` is the agent's payload verbatim. A frame whose serialized form
 * exceeds `ACP_TOOL_RAW_MAX` is REPLACED by a marked cut
 * (`{ sessionUpdate, truncated: true, text }`) rather than dropped or sent
 * whole: the detail view must say the payload was cut, never silently lose it.
 */
export interface SubagentDetailEntry {
  /** Transcript seq the update carried. */
  seq: number
  update: unknown
  /** Serialized characters cut from this frame; absent means the payload is verbatim. */
  truncatedChars?: number
}

/** `subagents/detail`: raw transcript entries for one worker (bounded per worker). */
export interface SubagentDetailResult {
  entries: SubagentDetailEntry[]
  /** OLDER matching entries the per-worker cap left out; absent means none. */
  omitted?: number
}

/** `subagents/detail` payload: the conversation + the catalog child id. */
export interface SubagentDetailPayload { dshSessionId: string; childId: string }
