/**
 * ACP transcript folding: the render blocks one `session/update` stream becomes.
 * Pure — no store, no timers, no Node APIs (the browser half only talks RPC /
 * SSE). Split out of `src/client/store.ts` (split plan P3a); that file
 * re-exports every symbol here, so callers keep importing `./store.ts`.
 */

import type { ChatSessionView, SessionView } from "../../protocol.ts"
import type { ChatRowFrame } from "./state.ts"

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
  | { kind: 'event'; event: string; text: string; raw?: string; status?: string; compactionId?: string }
  | { kind: 'notice'; tone: 'info' | 'error'; text: string }

/** Raw JSON budget for one event block; the cut is marked. */
const RAW_MAX = 256_000

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
    case 'compaction_update': {
      const compactionId = typeof update.compactionId === 'string' ? update.compactionId : ''
      const status = typeof update.status === 'string' && update.status !== '' ? update.status : 'unknown'
      const summary = Array.isArray(update.summary) ? update.summary.map(chunkText).filter(Boolean).join('\n') : ''
      const error = typeof update.error === 'string' ? update.error.trim() : ''
      const header = error !== '' ? `compaction (${status}): ${error}` : `compaction (${status})`
      const nextText = summary !== '' ? `${header}\n${summary}` : header
      let rawOf: string | undefined
      for (let i = blocks.length - 1; i >= 0 && compactionId !== ''; i--) {
        const block = blocks[i]
        if (block?.kind !== 'event' || block.event !== 'compaction_update' || block.compactionId !== compactionId) continue
        const preservedBody = summary === '' && status !== 'failed' && block.text.includes('\n')
          ? block.text.slice(block.text.indexOf('\n'))
          : ''
        blocks[i] = {
          kind: 'event',
          event: 'compaction_update',
          compactionId,
          status,
          text: preservedBody !== '' ? `${header}${preservedBody}` : nextText,
          get raw() { return rawOf ??= jsonText(update) },
        }
        return true
      }
      blocks.push({
        kind: 'event',
        event: 'compaction_update',
        ...(compactionId === '' ? {} : { compactionId }),
        status,
        text: nextText,
        get raw() { return rawOf ??= jsonText(update) },
      })
      return true
    }
    case 'compaction_summary_chunk': {
      const compactionId = typeof update.compactionId === 'string' ? update.compactionId : ''
      const text = chunkText(update.content)
      if (text === '') return false
      let rawOf: string | undefined
      for (let i = blocks.length - 1; i >= 0 && compactionId !== ''; i--) {
        const block = blocks[i]
        if (block?.kind !== 'event' || block.event !== 'compaction_update' || block.compactionId !== compactionId) continue
        const sep = block.text.includes('\n') ? '' : '\n'
        blocks[i] = { ...block, text: `${block.text}${sep}${text}`, get raw() { return rawOf ??= jsonText(update) } }
        return true
      }
      blocks.push({
        kind: 'event',
        event: 'compaction_update',
        ...(compactionId === '' ? {} : { compactionId }),
        status: 'in_progress',
        text: `compaction (in_progress)\n${text}`,
        get raw() { return rawOf ??= jsonText(update) },
      })
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
 * Context occupancy carried by one raw `usage_update` frame. A malformed or
 * degenerate frame (CodeBuddy's cost-only team-member tick is `used: 0, size: 0`)
 * is ignored: the last good sample stays on screen instead of a zeroed meter.
 */
export function usageFromUpdate(update: Record<string, unknown>): SessionView['usage'] | undefined {
  const used = update.used
  const size = update.size
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return undefined
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

/**
 * Flip one chat row's `released` flag (release/resume bookkeeping). The
 * composer's own list (`session/chat-list` rows) has no other live writer —
 * `session/released` must mark it, `session/reset` must un-mark it, or the
 * agent tag's halo and the released banner read yesterday's process state.
 */
export function withSessionReleased<T extends { sessionId: string; released?: boolean }>(
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
