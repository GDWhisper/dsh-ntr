/**
 * ACP tool-call and content folding into the host's tool-call stream.
 *
 * Every shape the agent sends has a place here (constraint 29): nothing is dropped silently, oversized text is truncated with a marker.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import { ACP_TOOL_RAW_MAX } from '../subagent-records.ts'

// ---- ACP tool-call notifications → DSH tool-call stream chunks ----

/**
 * Tool activity as REAL `tool-call` blocks, one driver step per tool activity.
 *
 * The ordering problem (docs/acp-convergence.md §1.7) is solved by SEGMENTING
 * the turn, not by prose: the adapter ends its stream when a tool-bearing
 * segment has a card and the next non-tool event arrives, the host settles the
 * assistant message, executes the card (the guard's virtual tool answers with
 * the agent's real output from the shared registry), and its agent loop then
 * proposes the continuation step — whose stream() call resumes reading the SAME
 * in-flight `session/prompt` from the transcript cursor. Cards therefore sit
 * between two assistant messages, exactly like a native multi-step turn.
 */

/**
 * The fixed name of EVERY ACP tool-call display card.
 *
 * A bare identifier with the plugin-owned `dsh_ntr__` prefix that the host has
 * no built-in tool for. The name must NEVER be the agent's own `title`: that is
 * often a whole shell command, and a card whose name resolves to a REAL host
 * tool would let `tools/execute` run the agent-supplied arguments in the host
 * process, bypassing this plugin's permission ledger (the guard's fail-closed
 * check is the backstop). The title is preserved in `argsRaw` instead, which
 * the host renders as the card body (`bodyRaw` / `formatToolBody`).
 *
 * Hand-copied as `ACP_TOOL_CALL_NAME` in `presets/acp/acp-guard.mjs` (a separate
 * module instance the Loader mounts without imports).
 */
export const ACP_TOOL_CALL_NAME = 'dsh_ntr__acp_tool_call'

/**
 * One ACP tool call, narrowed to what the Chat plane's tool-call renderer shows.
 *
 * `callId` is the ACP `toolCallId` - the only identity the agent gives, and the
 * Chat renderer's grouping key. `name` is the fixed ACP_TOOL_CALL_NAME (empty
 * only for a content-less status-only update, which the bridge skips as a
 * phantom card). `title` is the agent's own label, often a whole command;
 * `argsRaw` is that title folded in front of whatever `rawInput` / `arguments`
 * the agent disclosed, so nothing is dropped when the name became a constant.
 */
export interface AcpToolCallSnapshot {
  callId: string
  name: string
  /** The agent's own `title` label (kept so title-less updates don't drop it). */
  title: string
  /** Accumulated body text: the title plus the disclosed arguments. */
  argsRaw: string
}

/** A delta of tool-call content, folded into the open snapshot. */
export type AcpToolCallDelta =
  | { kind: 'name'; name: string }
  | { kind: 'args'; text: string }

/**
 * Fold the agent's `title` label in front of the disclosed argument text.
 *
 * Both the creating and the updating path use this, so the title - frequently
 * a whole pwsh command - is preserved in `argsRaw` (constraint 29: no silent
 * drop) instead of being lost when the card name became a constant, and an
 * input-prefix extension is still recognizable across updates. No truncation:
 * the full text is kept (a cut would need a marker).
 */
function foldTitleIntoArgs(title: string, args: string): string {
  if (title === '') return args
  return args === '' ? title : `${title}\n${args}`
}

/**
 * The argument text an ACP tool-call notification carries, if any.
 *
 * Accepts the spellings seen in the wild (`rawInput` / `arguments` as a string,
 * an object, or an ARRAY of inputs) and refuses to invent one: an agent that
 * sends no arguments gets `''`, which renders as an empty card rather than a
 * fabricated placeholder.
 */
export function acpToolCallArgsOf(update: Record<string, unknown>): string {
  for (const key of ['rawInput', 'arguments'] as const) {
    const value = update[key]
    if (typeof value === 'string') {
      if (value !== '') return value
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 0) return jsonOf(value)
      continue
    }
    if (typeof value === 'object' && value !== null) return jsonOf(value)
  }
  return ''
}

/**
 * Fold one ACP `tool_call` notification into a snapshot.
 *
 * `rawInput` / `arguments` are accepted when present: some agents send structured
 * input, and a tool card that cannot show its arguments is half a card. Anything
 * else is ignored — a tool call with only an id and a title is legal ACP.
 */
export function acpToolCallFromUpdate(update: Record<string, unknown>): AcpToolCallSnapshot | undefined {
  const callId = typeof update.toolCallId === 'string' ? update.toolCallId.trim() : ''
  if (callId === '') return undefined
  const title = typeof update.title === 'string' && update.title !== '' ? update.title : ''
  const argsRaw = foldTitleIntoArgs(title, acpToolCallArgsOf(update))
  // A content-less status-only update keeps an empty name: the bridge's
  // phantom-card guard relies on (name === '' && argsRaw === '') to skip it.
  // Every real card gets the fixed constant, never the agent's own title.
  const name = argsRaw === '' ? '' : ACP_TOOL_CALL_NAME
  return { callId, name, title, argsRaw }
}

/**
 * Whether an ACP tool-call status means no further output will arrive for the
 * call. `pending` and `in_progress` are the live ones; everything else
 * (`completed`, `failed`, v2's `cancelled`, and any status a newer agent
 * invents) is terminal. An absent or empty status is NOT terminal: the
 * announcing `tool_call` routinely omits it, and its output follows later.
 */
export function isFinalToolCallStatus(status: unknown): boolean {
  return typeof status === 'string' && status !== '' && status !== 'pending' && status !== 'in_progress'
}

/**
 * Fold one ACP `tool_call_update` into an open snapshot, in place.
 *
 * ACP updates carry FULL replacement snapshots (`rawInput` restated in whole on
 * every change), while the host's accumulator CONCATENATES `argumentsDelta` —
 * so the deltas produced here are the extension suffix only, and the snapshot
 * itself always moves to the latest known text (the closing `block-end` frame
 * replaces the block wholesale, which is what makes a non-extension update
 * land correctly in the settled card).
 */
export function acpToolCallDelta(
  snapshot: AcpToolCallSnapshot,
  update: Record<string, unknown>,
): AcpToolCallDelta[] {
  const deltas: AcpToolCallDelta[] = []
  // The card name is a fixed constant. Agents (codebuddy among them) rewrite
  // `title` mid-call, so emitting that raw text as a name delta would re-inject
  // a long shell command as a host tool name. Emit NO name delta; the (possibly
  // rewritten) title is preserved in the args body instead, folded in front of
  // the disclosed input for BOTH this path and acpToolCallFromUpdate.
  const incoming = typeof update.title === 'string' && update.title !== '' ? update.title : ''
  const args = acpToolCallArgsOf(update)
  if (incoming === '' && args === '') {
    // A status-only update carries no new body text: keep the card as-is, and
    // let `content` fill only a call whose agent never disclosed any input.
    if (snapshot.argsRaw === '') {
      const text = updateContentToText(update.content)
      if (text !== '') {
        if (snapshot.name !== ACP_TOOL_CALL_NAME) {
          snapshot.name = ACP_TOOL_CALL_NAME
          deltas.push({ kind: 'name', name: ACP_TOOL_CALL_NAME })
        }
        deltas.push({ kind: 'args', text })
        snapshot.argsRaw = text
      }
    }
    return deltas
  }
  const title = incoming !== '' ? incoming : snapshot.title
  snapshot.title = title
  const next = foldTitleIntoArgs(title, args)
  if (snapshot.name !== ACP_TOOL_CALL_NAME) {
    snapshot.name = ACP_TOOL_CALL_NAME
    deltas.push({ kind: 'name', name: ACP_TOOL_CALL_NAME })
  }
  const suffix = extensionSuffixOf(snapshot.argsRaw, next)
  if (suffix !== '') deltas.push({ kind: 'args', text: suffix })
  snapshot.argsRaw = next
  return deltas
}

/**
 * The part of `next` that extends `previous` — the only thing a concatenating
 * delta consumer can express. A replacement (the agent rewrote its input) has
 * no honest delta; the caller updates the snapshot regardless and lets the
 * closing snapshot tell the truth.
 */
function extensionSuffixOf(previous: string, next: string): string {
  if (previous === '') return next
  return next.startsWith(previous) ? next.slice(previous.length) : ''
}

/**
 * Whether this request is the CONTINUATION step of a turn whose previous step
 * settled with tool-call blocks — which is exactly what the ACP agent's display
 * cards are. The host agent-loop starts a next step whenever the settled
 * assistant message contains `tool-call` blocks, feeding it the staged tool
 * results: the request's message list then has `tool`-sourced messages AFTER
 * the last user-sourced one. A fresh prompt never does (the person's new words
 * are the last message); history from earlier turns sits before the new user
 * text, so it cannot trip this.
 *
 * The adapter answers such a step by resuming the SAME in-flight ACP prompt
 * from the transcript cursor instead of sending a new one (see
 * `BridgeManager.streamPrompt` and docs/acp-convergence.md §1.7).
 */
export function isAcpToolContinuation(messages: readonly {
  source?: { kind?: string }
}[]): boolean {
  let lastTool = -1
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.source?.kind === 'tool') lastTool = i
  }
  if (lastTool < 0) return false
  for (let i = lastTool + 1; i < messages.length; i += 1) {
    const kind = messages[i]?.source?.kind
    // A source-less message counts as user input — the same convention
    // `selectForwardPrompt` uses for hand-built requests.
    if (kind === undefined || kind === 'user') return false
  }
  return true
}

/** One structured edit as plain text: its path, then `-`/`+` lines with three lines of context. */
export interface AcpDiffPayload {
  path: string
  oldText: string | null
  newText: string
}

/** One folded piece of a tool call's `content`. */
export type AcpContentRow =
  | { kind: 'text'; text: string }
  /** Structured edits are kept apart: flattening them to `diff <path>` throws away the review. */
  | { kind: 'diff'; diff: AcpDiffPayload }
  /** A kind we cannot render. `json` carries the whole item, so nothing the agent sent is lost. */
  | { kind: 'other'; label: string; json: string }

/**
 * Fold one ACP tool-call content item, preserving everything.
 *
 * The caller decides how to render a `text` / `diff` / `other` row; the one rule
 * here is that no shape may vanish. ACP agents in the wild send kinds beyond the
 * spec's `content` / `diff` / `terminal` (observations, images, links, custom
 * rows), and an item we do not understand is still something the agent said —
 * it rides along as `other` with its full JSON rather than disappearing.
 */
export function acpContentRows(content: unknown): AcpContentRow[] {
  if (!Array.isArray(content)) return []
  const out: AcpContentRow[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) {
      if (typeof item === 'string' && item !== '') out.push({ kind: 'text', text: item })
      continue
    }
    const row = item as Record<string, unknown>
    const type = typeof row.type === 'string' ? row.type : ''
    if (type === 'content') {
      const inner = row.content as Record<string, unknown> | undefined
      if (typeof inner === 'string') {
        out.push({ kind: 'text', text: inner })
      } else if (inner?.type === 'text' && typeof inner.text === 'string') {
        out.push({ kind: 'text', text: inner.text })
      } else if (inner?.type === 'diff') {
        const path = typeof inner.path === 'string' ? inner.path : ''
        out.push({
          kind: 'diff',
          diff: { path, oldText: typeof inner.oldText === 'string' ? inner.oldText : null, newText: typeof inner.newText === 'string' ? inner.newText : '' },
        })
      } else {
        out.push({ kind: 'other', label: String(inner?.type ?? 'content'), json: jsonOf(item) })
      }
      continue
    }
    if (type === 'diff' && typeof row.path === 'string' && typeof row.newText === 'string') {
      out.push({ kind: 'diff', diff: { path: row.path, oldText: typeof row.oldText === 'string' ? row.oldText : null, newText: row.newText } })
      continue
    }
    out.push({ kind: 'other', label: type === '' ? 'content' : type, json: jsonOf(item) })
  }
  return out
}

/**
 * The plain text of one tool payload: text as-is, diffs as a per-file header
 * plus its removed/added lines (`-`/`+`), other kinds as their full JSON. This
 * replaces the old `[diff path]` / `[terminal id]` placeholders — those names
 * the block and drop everything else the agent said.
 *
 * It doubles as what the guard's virtual tools answer the host loop with, so
 * both the card and the executed result read the same thing.
 */
export function updateContentToText(content: unknown): string {
  return acpContentRows(content).map(row => {
    if (row.kind === 'text') return row.text
    if (row.kind === 'diff') return formatAcpDiff(row.diff)
    return `${row.label} ${row.json}`
  }).join('\n')
}

/** One structured edit as readable text: `path`, then `-`/`+` lines plus unchanged context. */
export function formatAcpDiff(diff: AcpDiffPayload): string {
  const oldLines = splitLines(diff.oldText)
  const newLines = splitLines(diff.newText)
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  const lines: string[] = [diff.path]
  for (let i = Math.max(0, head - 3); i < head; i++) lines.push(`  ${oldLines[i] ?? ''}`)
  for (let i = head; i < oldLines.length - tail; i++) lines.push(`- ${oldLines[i] ?? ''}`)
  for (let i = head; i < newLines.length - tail; i++) lines.push(`+ ${newLines[i] ?? ''}`)
  for (let i = oldLines.length - tail; i < oldLines.length; i++) lines.push(`  ${oldLines[i] ?? ''}`)
  return lines.join('\n')
}

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

/** JSON text of a value; a non-serializable value falls back to its string form rather than throwing. */
function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Pretty-printed JSON of an agent message, truncated only at {@link ACP_TOOL_RAW_MAX}. */
export function dumpJson(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > ACP_TOOL_RAW_MAX
    ? `${text.slice(0, ACP_TOOL_RAW_MAX)}\n… [truncated ${String(text.length - ACP_TOOL_RAW_MAX)} chars]`
    : text
}

// ---- host request → forwarded ACP prompt ----

/** Notification kinds that are routine state, not content: they update the session view and nothing else. */
export const BOOKKEEPING_UPDATES: ReadonlySet<string> = new Set([
  'current_mode_update',
  'config_option_update',
  'available_commands_update',
  'session_info_update',
  'usage_update',
])

/**
 * Human-readable text of an ACP notification this build has no card of its own
 * for. The text is what the native chat stream shows and what the guard answers
 * the host loop's execution of that card with, so it must carry the payload —
 * a plan's entries, an unknown kind's whole JSON — rather than only a name.
 *
 * The routine bookkeeping kinds (`current_mode_update`, `available_commands_update`,
 * and the rest of `BOOKKEEPING_UPDATES`) never reach this function on the live
 * path: `streamPrompt` drops them before it announces a kind inline — it is the
 * only caller. The two branches below that name them are a defensive fallback
 * for a direct caller, NOT a live route into the chat stream.
 */
export function describeUnhandledUpdate(kind: string, update: Record<string, unknown>): string {
  const label = kind === '' ? 'session update' : kind
  if (kind === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : []
    if (entries.length === 0) return `${label}: (empty plan)`
    return entries.map(entry => {
      const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
      const status = typeof row.status === 'string' ? row.status : 'pending'
      const priority = typeof row.priority === 'string' ? ` [${row.priority}]` : ''
      return `[${status}]${priority} ${String(row.content ?? '')}`
    }).join('\n')
  }
  if (kind === 'current_mode_update' && typeof update.currentModeId === 'string') return `${label}: ${update.currentModeId}`
  if (kind === 'available_commands_update') {
    const commands = Array.isArray(update.availableCommands) ? update.availableCommands : []
    return commands.map(command => {
      const row = (typeof command === 'object' && command !== null ? command : {}) as Record<string, unknown>
      const name = typeof row.name === 'string' ? row.name : ''
      const description = typeof row.description === 'string' && row.description !== '' ? ` — ${row.description}` : ''
      return `${name}${description}`
    }).join('\n')
  }
  return `${label}\n${dumpJson(update)}`
}
