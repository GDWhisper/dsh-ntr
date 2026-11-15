/**
 * External-worker bookkeeping the browser owns: the record keys, the bounded
 * detail index and its truncation rules, and the snapshot merge that replays
 * in-flight frames over a slow read. Pure. Split out of `src/client/store.ts`
 * (split plan P3a), which re-exports it unchanged.
 */

import type { ChatSessionView, SubagentDetailEntry, SubagentRecord } from "../../protocol.ts"
import { MAX_SUBAGENT_DETAIL_ENTRIES } from "../../protocol.ts"

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
 * A terminal record is never downgraded by a stale non-terminal frame: the
 * worker already reported, and the panel must not start claiming it is
 * running again. Everything else is last-wins (frames arrive in order).
 */
export function isSubagentDowngrade(existing: SubagentRecord | undefined, incoming: SubagentRecord): boolean {
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
