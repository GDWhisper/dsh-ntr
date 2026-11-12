/**
 * On-demand DETAIL read for one Antigravity subagent (task 3 of
 * docs/plan/antigravity-subagent-panel.md).
 *
 * A record with a `childConversationId` names the child's OWN brain transcript
 * (`<storeRoot>/brain/<childId>/.system_generated/logs/transcript*.jsonl`);
 * the detail view reads THAT step stream, not the parent's dispatch frames.
 * The format is private to Antigravity and has no contract, so every read is
 * bounded, every parse failure is fail-open, and nothing here throws to its
 * caller or writes a single byte (read-only; the detail is never persisted).
 *
 * Bounding has three layers, each with a visible marker (constraint 29):
 * - the file is read through a byte window ({@link AGY_DETAIL_READ_MAX_BYTES},
 *   newest end) — a larger file gets a `window-cut` notice;
 * - the newest {@link MAX_SUBAGENT_DETAIL_ENTRIES} steps are kept, older ones
 *   counted in `omitted`;
 * - one step whose serialized form exceeds `ACP_TOOL_RAW_MAX` becomes a MARKED
 *   cut via `boundSubagentDetailEntry`, never a silent drop.
 *
 * Unreadable file / no store root → an explicit `unreadable` notice; malformed
 * lines → the readable part plus a `bad-lines` notice. Notices are appended
 * LAST and the browser's merge trims its entry cap from the FRONT positionally,
 * so a marker survives; their `Number.MAX_SAFE_INTEGER` seq only orders display.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { agyTranscriptPaths, parseTranscriptStep } from './agy-transcript.ts'
import { boundSubagentDetailEntry } from '../subagent-records.ts'
import { MAX_SUBAGENT_DETAIL_ENTRIES } from '../protocol.ts'
import type { SubagentDetailEntry, SubagentDetailResult } from '../protocol.ts'

/**
 * Byte budget for one on-demand detail read. Generous for the capped step
 * count (200 steps of a few KiB each); past it the NEWEST window is read and
 * the cut is stated. The window starts mid-line by design — the partial first
 * line is discarded, never parsed as a bad one.
 */
export const AGY_DETAIL_READ_MAX_BYTES = 4 * 1024 * 1024

/** Notices sort after every real step (see the module doc). */
const NOTICE_SEQ = Number.MAX_SAFE_INTEGER

/** One read-failure marker entry, already marked as the agy transcript source. */
function noticeEntry(notice: 'unreadable' | 'bad-lines' | 'window-cut', lines?: number): SubagentDetailEntry {
  return {
    seq: NOTICE_SEQ,
    source: 'agy-transcript',
    update: { notice, ...(lines === undefined ? {} : { lines }) },
  }
}

/** The explicit "cannot read" answer — never an exception, never an empty lie. */
function unreadable(): SubagentDetailResult {
  return { entries: [noticeEntry('unreadable')] }
}

/**
 * Read the LAST `maxBytes` of one file as text. `undefined` on any file-system
 * failure (fail-open); `windowCut` says the start sat inside the file, so the
 * first (partial) line was discarded and older bytes were not read at all.
 */
function readWindow(path: string, maxBytes: number): { text: string; windowCut: boolean } | undefined {
  let size: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    size = stat.size
  } catch {
    return undefined
  }
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  if (length === 0) return { text: '', windowCut: false }
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, start + read)
      if (count <= 0) break
      read += count
    }
    let text = buffer.subarray(0, read).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      // A window with no newline at all is one over-long partial line: there
      // is nothing complete to read, and the cut still must be stated.
      if (newline < 0) return { text: '', windowCut: true }
      text = text.slice(newline + 1)
    }
    return { text, windowCut: start > 0 }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Best effort: a failed close cannot change what was already read.
      }
    }
  }
}

/**
 * The child's transcript as bounded detail entries. Steps ride VERBATIM (the
 * wire's own keys — `tool_calls`, `thinking`, `error` and any unknown key all
 * survive; the browser's step view gives each a destination). A half-written
 * trailing line is not a bad line: it is the writer mid-append, and the next
 * read will see it complete — but a COMPLETE final step without its newline
 * is kept (a one-shot read of a finished child must not drop its report).
 */
export function readAgyChildDetail(storeRoot: string | undefined, childConversationId: string): SubagentDetailResult {
  if (storeRoot === undefined) return unreadable()
  const path = agyTranscriptPaths(storeRoot, childConversationId).find(candidate => existsSync(candidate))
  if (path === undefined) return unreadable()
  const window = readWindow(path, AGY_DETAIL_READ_MAX_BYTES)
  if (window === undefined) return unreadable()
  const lines = window.text.split('\n')
  // A trailing segment without a newline is usually the writer mid-append —
  // but this ONE-SHOT read of a finished child may end on a complete final
  // step agy never newline-terminated (the report the dialog was opened for).
  // Keep it when it parses as a whole step; a partial line stays excluded.
  if (!window.text.endsWith('\n')) {
    const trailing = lines.pop() ?? ''
    if (parseTranscriptStep(trailing) !== undefined) lines.push(trailing)
  }
  const steps: Array<{ seq: number; raw: unknown }> = []
  let badLines = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badLines += 1
      continue
    }
    const stepIndex = (parsed as Record<string, unknown>).step_index
    if (typeof stepIndex !== 'number' || !Number.isFinite(stepIndex)) {
      badLines += 1
      continue
    }
    steps.push({ seq: stepIndex, raw: parsed })
  }
  const kept = steps.length <= MAX_SUBAGENT_DETAIL_ENTRIES
    ? steps
    : steps.slice(-MAX_SUBAGENT_DETAIL_ENTRIES)
  const entries: SubagentDetailEntry[] = kept.map(step => ({
    ...boundSubagentDetailEntry(step.seq, step.raw),
    source: 'agy-transcript',
  }))
  if (window.windowCut) entries.push(noticeEntry('window-cut'))
  if (badLines > 0) entries.push(noticeEntry('bad-lines', badLines))
  const omitted = steps.length - kept.length
  return omitted > 0 ? { entries, omitted } : { entries }
}
