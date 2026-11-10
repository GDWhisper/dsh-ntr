/**
 * Persisted external-worker lifecycle records: tolerant normalization of one
 * row, the per-conversation cap, and the per-entry raw payload bound. Pure
 * functions only (no Node imports, no SDK imports); `src/impl.ts` re-exports
 * every name below so existing importers are unchanged.
 */

import type { SubagentDetailEntry, SubagentRecord, SubagentStatus } from './protocol-subagent.ts'
import { MAX_SUBAGENT_RECORDS } from './protocol-subagent.ts'

/** Cap on one tool call's raw notification. Large enough for big `content` arrays; the cut is marked. */
export const ACP_TOOL_RAW_MAX = 256_000

const SUBAGENT_STATUSES: readonly SubagentStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown']
const TERMINAL_SUBAGENT_STATUSES: readonly SubagentStatus[] = ['completed', 'failed', 'cancelled', 'unknown']

/**
 * The `toolCallId` behind an `acp:<toolCallId>` child id, or '' when it is not
 * one. The browser half hand-copies this as `subagentToolCallId` in
 * `src/client/store.ts`; the equivalence is pinned in tests/acp-view.spec.ts.
 */
export function subagentToolCallId(childId: string): string {
  return childId.startsWith('acp:') ? childId.slice('acp:'.length) : ''
}

/** Whether a stored status is one of the six the contract defines. */
function isSubagentStatus(value: unknown): value is SubagentStatus {
  return typeof value === 'string' && (SUBAGENT_STATUSES as readonly string[]).includes(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Normalize ONE persisted lifecycle record. Tolerant row by row: the state
 * file is user- and version-editable, so an unreadable row is dropped rather
 * than allowed to poison the conversation's whole record list.
 */
export function normalizeSubagentRecord(raw: unknown): SubagentRecord | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  // `childId` is the catalog-alignment key; `toolCallId` is its suffix and can
  // be rebuilt from it, so a row MISSING the child id still reads when the
  // call id is intact. A child id that is present but not an external one is
  // rejected rather than silently swapped for a derived value.
  const childId = row.childId === undefined
    ? (typeof row.toolCallId === 'string' && row.toolCallId !== '' ? `acp:${row.toolCallId}` : '')
    : (typeof row.childId === 'string' && subagentToolCallId(row.childId) !== '' ? row.childId : '')
  if (childId === '') return undefined
  const dshSessionId = typeof row.dshSessionId === 'string' ? row.dshSessionId : ''
  if (dshSessionId === '') return undefined
  const startedAt = finiteNumber(row.startedAt)
  if (startedAt === undefined) return undefined
  const endedAt = finiteNumber(row.endedAt)
  const counts = row.counts !== null && typeof row.counts === 'object' && !Array.isArray(row.counts)
    ? row.counts as Record<string, unknown>
    : {}
  return {
    childId,
    dshSessionId,
    toolCallId: subagentToolCallId(childId),
    label: typeof row.label === 'string' ? row.label : '',
    ...(typeof row.type === 'string' && row.type !== '' ? { type: row.type } : {}),
    status: isSubagentStatus(row.status) ? row.status : 'unknown',
    startedAt,
    lastActivityAt: finiteNumber(row.lastActivityAt) ?? startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    // Constraint 29: the reason keeps whatever shape the agent used (a string,
    // an object, an array); the display layer folds it, this layer never does.
    ...(row.error === undefined ? {} : { error: row.error }),
    counts: {
      updates: finiteNumber(counts.updates) ?? 0,
      toolCalls: finiteNumber(counts.toolCalls) ?? 0,
      textChars: finiteNumber(counts.textChars) ?? 0,
    },
  }
}

/**
 * Cap one conversation's records at {@link MAX_SUBAGENT_RECORDS}: the oldest
 * TERMINAL rows are evicted first, because a running worker's row is the one
 * the user is watching. A list with fewer than `max` terminal rows is kept
 * whole (the excess open rows are all live) — the cap never invents a terminal
 * state to make room.
 */
export function capSubagentRecords(
  records: readonly SubagentRecord[],
  max = MAX_SUBAGENT_RECORDS,
): SubagentRecord[] {
  if (records.length <= max) return [...records]
  const excess = records.length - max
  const out: SubagentRecord[] = []
  let evicted = 0
  for (const record of records) {
    if (evicted < excess && (TERMINAL_SUBAGENT_STATUSES as readonly string[]).includes(record.status)) {
      evicted += 1
      continue
    }
    out.push(record)
  }
  return out
}

/**
 * Read the persisted `subagents` map back.
 *
 * Restored records are read after a host restart, which killed every process
 * that could have owned a worker: a row that never reached a terminal state is
 * reported `unknown` (never left `running` forever). Keys with no surviving
 * owner — no `chatSessions` row and no `conversations` entry — are dropped, so
 * a deleted conversation cannot keep the file growing.
 */
export function normalizeSubagentRecordMap(
  raw: unknown,
  keepSessionIds?: ReadonlySet<string>,
): Record<string, SubagentRecord[]> {
  const out: Record<string, SubagentRecord[]> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [dshSessionId, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (dshSessionId === '' || !Array.isArray(rows)) continue
    if (keepSessionIds !== undefined && !keepSessionIds.has(dshSessionId)) continue
    const byChild = new Map<string, SubagentRecord>()
    for (const item of rows) {
      const normalized = normalizeSubagentRecord(item)
      if (normalized === undefined) continue
      const restored: SubagentRecord = normalized.status === 'pending' || normalized.status === 'running'
        ? { ...normalized, status: 'unknown', endedAt: normalized.endedAt ?? normalized.lastActivityAt }
        : normalized
      byChild.set(restored.childId, { ...restored, dshSessionId })
    }
    if (byChild.size > 0) out[dshSessionId] = capSubagentRecords([...byChild.values()])
  }
  return out
}

/**
 * Bound ONE detail entry's serialized payload. A frame over
 * {@link ACP_TOOL_RAW_MAX} becomes a MARKED cut (`truncated: true` plus the
 * cut JSON) instead of a silent drop or an unbounded transport payload
 * (constraint 29 / constraint 8's sibling rule for oversized raw data).
 */
export function boundSubagentDetailEntry(seq: number, update: unknown): SubagentDetailEntry {
  let text: string
  try {
    text = JSON.stringify(update) ?? String(update)
  } catch {
    text = String(update)
  }
  if (text.length <= ACP_TOOL_RAW_MAX) return { seq, update }
  const kind = update !== null && typeof update === 'object'
    ? (update as { sessionUpdate?: unknown }).sessionUpdate
    : undefined
  const cut = text.length - ACP_TOOL_RAW_MAX
  return {
    seq,
    update: {
      sessionUpdate: typeof kind === 'string' ? kind : 'unknown',
      truncated: true,
      text: `${text.slice(0, ACP_TOOL_RAW_MAX)}\n… [truncated ${String(cut)} chars]`,
    },
    truncatedChars: cut,
  }
}
