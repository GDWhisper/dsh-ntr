/**
 * The conversation's ACP view tab: the agent's REAL stream, as the agent
 * produced it.
 *
 * WHY A TAB AS WELL AS THE CHAT: the native chat plane renders what the LLM
 * adapter emits, and the adapter's chunk vocabulary is text + reasoning — so
 * the agent's prose and thinking ride the native plane, while a fuller card (a
 * tool call with its arguments, a plan, a unified diff) has no chunk to ride
 * there. This view renders those as themselves.
 *
 * It is a VIEW, not a second client: it never prompts, never cancels, never
 * spawns. Everything it shows is host state.
 */

import type { ReactNode } from 'react'
import { memo, useEffect, useRef, useState } from 'react'
// Type-only: pulls the ui-conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import type { AcpChatInjected } from './acp-ui.tsx'
import type { Block, ChatTranscript } from './store.ts'
import type { AgentView, ChatSessionView, SessionView, SubagentRecord, SubagentStatus } from '../protocol.ts'

/** Props of the ACP view entry (injected face + the frame's session id). */
export interface AcpViewProps extends AcpChatInjected {
  sessionId: string
}

/**
 * The store's bilingual label function (`AcpStore.label`). Exported because the
 * empty-state copy builder takes one and the bundle emits declarations.
 */
export type Translate = (zh: string, en: string) => string

/** Glyph per ACP tool kind, so a call's nature reads before its title does. */
const TOOL_GLYPH: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '📦',
  search: '🔍',
  execute: '⌨️',
  think: '🧠',
  fetch: '🌐',
  switch_mode: '⇄',
  other: '🛠️',
}

/** Tone class per ACP tool status. */
const STATUS_TONE: Record<string, string> = {
  pending: 'idle',
  in_progress: 'busy',
  completed: 'done',
  failed: 'fail',
}

/** Cap on the rendered diff matrix: beyond it, show the edit as remove-all/add-all. */
const DIFF_LCS_LIMIT = 300
/** Tool output lines shown before the "show all" toggle appears. */
const TOOL_LINES_CLIP = 12

/** One line of a rendered unified diff. */
interface DiffRow {
  sign: '+' | '-' | ' '
  text: string
}

/** Split a text payload into lines, tolerating an empty / null side. */
function linesOf(text: string | null): string[] {
  if (text === null || text === '') return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

/**
 * Line diff with a common prefix/suffix trim plus an LCS over the remaining
 * middle — the standard shape that keeps an edit reviewable without pulling a
 * diff library into a browser bundle.
 */
export function diffRows(oldText: string | null, newText: string): DiffRow[] {
  const oldLines = linesOf(oldText)
  const newLines = linesOf(newText)
  const rows: DiffRow[] = []
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let tail = 0
  while (
    tail < oldLines.length - start
    && tail < newLines.length - start
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  for (let i = 0; i < start; i++) rows.push({ sign: ' ', text: oldLines[i] as string })
  const oldMiddle = oldLines.slice(start, oldLines.length - tail)
  const newMiddle = newLines.slice(start, newLines.length - tail)
  if (oldMiddle.length > DIFF_LCS_LIMIT || newMiddle.length > DIFF_LCS_LIMIT) {
    for (const text of oldMiddle) rows.push({ sign: '-', text })
    for (const text of newMiddle) rows.push({ sign: '+', text })
  } else {
    rows.push(...lcsRows(oldMiddle, newMiddle))
  }
  for (let i = tail; i > 0; i--) rows.push({ sign: ' ', text: oldLines[oldLines.length - i] as string })
  return rows
}

/** LCS line alignment of two short blocks (DP table, bounded by the caller). */
function lcsRows(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  const rows = oldLines.length
  const cols = newLines.length
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const row = table[i] as number[]
      const below = table[i + 1] as number[]
      row[j] = oldLines[i] === newLines[j]
        ? (below[j + 1] as number) + 1
        : Math.max(below[j] as number, row[j + 1] as number)
    }
  }
  const out: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      out.push({ sign: ' ', text: oldLines[i] as string })
      i++
      j++
    } else if (((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number)) {
      out.push({ sign: '-', text: oldLines[i] as string })
      i++
    } else {
      out.push({ sign: '+', text: newLines[j] as string })
      j++
    }
  }
  while (i < rows) {
    out.push({ sign: '-', text: oldLines[i] as string })
    i++
  }
  while (j < cols) {
    out.push({ sign: '+', text: newLines[j] as string })
    j++
  }
  return out
}

/** Inline `code` and **bold** spans; everything else stays literal text. */
function inlineNodes(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    key++
    if (token.startsWith('`')) out.push(<code key={key} className="ntr-acp-inline-code">{token.slice(1, -1)}</code>)
    else out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Fenced-code-aware text body: agent prose without a markdown dependency. */
function RichText({ text }: { text: string }) {
  const parts = text.split('```')
  return (
    <>
      {parts.map((part, index) => (index % 2 === 1
        ? <pre key={index} className="ntr-acp-code">{part.replace(/^[a-zA-Z0-9_-]*\n/, '')}</pre>
        : <span key={index}>{inlineNodes(part)}</span>))}
    </>
  )
}

/**
 * Whether one structured edit is a NEW FILE.
 *
 * Decided by the old side, never by the removal count: an existing file that
 * only gained lines also diffs to zero removals, and labelling that "new file"
 * hid a real edit behind a wrong badge (the audit's F8). The only old sides
 * that mean "nothing was there" are an absent one and one byte-identical to
 * the new content — the degenerate case where there is no edit at all.
 */
export function isNewFileDiff(oldText: string | null, newText: string): boolean {
  return oldText === null || oldText === '' || oldText === newText
}

/** One structured edit, rendered as a unified diff. */
function DiffView({ diff, t }: { diff: { path: string; oldText: string | null; newText: string }; t: Translate }) {
  const rows = diffRows(diff.oldText, diff.newText)
  const added = rows.filter(row => row.sign === '+').length
  const removed = rows.filter(row => row.sign === '-').length
  const isNewFile = isNewFileDiff(diff.oldText, diff.newText)
  return (
    <div className="ntr-acp-diff">
      <div className="ntr-acp-diff-head">
        <span className="ntr-acp-diff-path">{diff.path}</span>
        <span className="ntr-acp-diff-stats">
          <span className="is-add">+{added}</span> <span className="is-del">-{removed}</span>
        </span>
      </div>
      <div className="ntr-acp-diff-body">
        {rows.map((row, index) => (
          <div key={index} className={`ntr-acp-diff-row is-${row.sign === '+' ? 'add' : row.sign === '-' ? 'del' : 'ctx'}`}>
            <span className="ntr-acp-diff-sign">{row.sign}</span>
            <span className="ntr-acp-diff-text">{row.text}</span>
          </div>
        ))}
      </div>
      {isNewFile && <div className="ntr-acp-diff-note">{t('新增文件', 'new file')}</div>}
    </div>
  )
}

/** One tool call: header, arguments, text output, unknown payloads, and any structured edits it carried. */
function ToolCard({ block, t }: { block: Extract<Block, { kind: 'tool' }>; t: Translate }) {
  const [expanded, setExpanded] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const glyph = TOOL_GLYPH[block.toolKind ?? 'other'] ?? TOOL_GLYPH.other
  const tone = STATUS_TONE[block.status] ?? 'idle'
  const clipped = !expanded && block.lines.length > TOOL_LINES_CLIP
  const shown = clipped ? block.lines.slice(0, TOOL_LINES_CLIP) : block.lines
  return (
    <div className={`ntr-acp-tool is-${tone}`}>
      <div className="ntr-acp-tool-head">
        <span aria-hidden>{glyph}</span>
        <span className="ntr-acp-tool-title">{block.title === '' ? block.toolCallId : block.title}</span>
        <span className={`ntr-acp-badge is-${tone}`}>{block.status}</span>
      </div>
      {/*
        The arguments the agent sent. Rendered as-is: `rawInput` may be a JSON
        object the agent serialized, a plain command line, or nothing at all —
        reformatting it would be this view guessing at another agent's schema.
      */}
      {block.input !== undefined && block.input !== '' && (
        <pre className="ntr-acp-tool-body ntr-acp-tool-input">{block.input}</pre>
      )}
      {block.details !== undefined && block.details.length > 0 && (
        <pre className="ntr-acp-tool-body ntr-acp-tool-meta">{block.details.join('\n')}</pre>
      )}
      {shown.length > 0 && (
        <pre className="ntr-acp-tool-body">{`${shown.join('\n')}${clipped ? '\n…' : ''}`}</pre>
      )}
      {block.extras !== undefined && block.extras.length > 0 && (
        <pre className="ntr-acp-tool-body">{block.extras.join('\n')}</pre>
      )}
      {block.diffs?.map((diff, index) => <DiffView key={`${diff.path}#${String(index)}`} diff={diff} t={t} />)}
      {block.lines.length > TOOL_LINES_CLIP && (
        <button type="button" className="ntr-acp-more" onClick={() => { setExpanded(!expanded) }}>
          {expanded
            ? t('收起', 'collapse')
            : t(`显示全部 ${block.lines.length} 行`, `show all ${block.lines.length} lines`)}
        </button>
      )}
      {block.raw !== undefined && (
        <button type="button" className="ntr-acp-more" onClick={() => { setRawOpen(!rawOpen) }}>
          {rawOpen ? t('收起原始数据', 'hide raw payload') : t('原始数据', 'raw payload')}
        </button>
      )}
      {rawOpen && block.raw !== undefined && <pre className="ntr-acp-tool-body">{block.raw}</pre>}
    </div>
  )
}

/** One notification the view has no card of its own for: its readable fold, plus the untouched payload. */
function EventCard({ block, t }: { block: Extract<Block, { kind: 'event' }>; t: Translate }) {
  const [rawOpen, setRawOpen] = useState(false)
  return (
    <div className="ntr-acp-tool is-done">
      <div className="ntr-acp-tool-head">
        <span aria-hidden>ℹ️</span>
        <span className="ntr-acp-tool-title">{block.event}</span>
      </div>
      {block.text !== '' && <pre className="ntr-acp-tool-body">{block.text}</pre>}
      {block.raw !== undefined && (
        <button type="button" className="ntr-acp-more" onClick={() => { setRawOpen(!rawOpen) }}>
          {rawOpen ? t('收起原始数据', 'hide raw payload') : t('原始数据', 'raw payload')}
        </button>
      )}
      {rawOpen && block.raw !== undefined && <pre className="ntr-acp-tool-body">{block.raw}</pre>}
    </div>
  )
}

/** One plan snapshot (the agent's own todo list). */
function PlanCard({ entries, t }: { entries: Extract<Block, { kind: 'plan' }>['entries']; t: Translate }) {
  const done = entries.filter(entry => entry.status === 'completed').length
  return (
    <div className="ntr-acp-plan">
      <div className="ntr-acp-plan-head">{t(`计划 ${done}/${entries.length}`, `Plan ${done}/${entries.length}`)}</div>
      {entries.map((entry, index) => (
        <div key={index} className={`ntr-acp-plan-row is-${entry.status}`}>
          <span className="ntr-acp-plan-glyph" aria-hidden>{entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '▸' : '○'}</span>
          <span>{entry.content}</span>
          {entry.priority !== undefined && <span className="ntr-acp-plan-prio">{entry.priority}</span>}
        </div>
      ))}
    </div>
  )
}

/**
 * One stream block, dispatched by kind. Memoized on its props — `block`, the
 * store's instance-bound `label`, and `localeRev` (it moves on a language
 * switch, so translated copy re-renders) — so a folded batch re-renders only
 * the rows whose block object changed (`foldUpdate` replaces blocks immutably)
 * instead of the whole transcript on every store notification. `key` stays the
 * index on purpose: blocks fold append-only, and identity is the block object.
 */
const BlockView = memo(function BlockView({ block, label }: { block: Block; label: Translate; localeRev: number }) {
  const t = label
  switch (block.kind) {
    case 'user':
      return <div className="ntr-acp-bubble is-user"><RichText text={block.text} /></div>
    case 'agent':
      return <div className="ntr-acp-bubble is-agent"><RichText text={block.text} /></div>
    case 'thought':
      return (
        <details className="ntr-acp-thought">
          <summary>{t('思考过程', 'reasoning')}</summary>
          <div className="ntr-acp-thought-body"><RichText text={block.text} /></div>
        </details>
      )
    case 'tool':
      return <ToolCard block={block} t={t} />
    case 'plan':
      return <PlanCard entries={block.entries} t={t} />
    case 'event':
      return <EventCard block={block} t={t} />
    default:
      return <div className={`ntr-acp-notice is-${block.tone}`}>{block.text}</div>
  }
})

/** The bound ACP session for this chat, preferring the live one. */
function boundSession(list: readonly ChatSessionView[]): ChatSessionView | undefined {
  return list.find(session => !session.released) ?? list[0]
}

/**
 * Whether an empty stream means "history exists but is not shown yet": the
 * record was restored from disk after a host restart (the agent's replay has
 * not landed), or a resume cleared the buffer ahead of the replay. The view
 * then promises the replay instead of claiming the conversation never
 * happened — "还没有消息" to someone whose chat plane still shows yesterday's
 * turns is exactly the kind of contradiction this file's copy rules exist to
 * prevent. In-memory released sessions keep their buffer, so this only fires
 * when the buffer really is absent.
 */
export function historyAwaitsReplay(session: Pick<SessionView, 'released' | 'hasHistory'>): boolean {
  return session.released === true && session.hasHistory === true
}

/**
 * Everything the view can read that says "this conversation is set up on an
 * agent": a live or parked ACP session, the host's binding (`session/chat-list`'s
 * `boundAgentId`, which outlives a closed session), and the persisted pick.
 *
 * The transcript is deliberately NOT one of these sources: it is a record of
 * turns, and it is dropped when a session is destroyed, so reading it alone
 * answered "has an agent ever served this conversation" with "no" for
 * conversations that had just run one.
 */
export function boundAgentOf(
  session: ChatSessionView | undefined,
  hostBoundAgentId: string | undefined,
  pickedAgentId: string | undefined,
  agents: readonly AgentView[],
): { id: string; title: string } | undefined {
  const id = session?.agentId ?? hostBoundAgentId ?? pickedAgentId
  if (id === undefined) return undefined
  return { id, title: session?.agentTitle ?? agents.find(agent => agent.id === id)?.title ?? id }
}

/** What the view knows about this conversation when it has no transcript. */
export interface AcpEmptyFacts {
  /** The agent this conversation is set up on, when there is one. */
  bound?: { id: string; title: string }
  /** Whether any agent is configured at all. */
  hasAgents: boolean
  /**
   * This conversation's NTR-mode verdict, as the seat gate reads it
   * (`UiState.acpMode`). `undefined` while the host has not answered: the view
   * must not claim either way.
   */
  acpMode?: boolean
}

/** The three lines of the empty state, already localized. */
export interface AcpEmptyCopy {
  title: string
  body: string
  /** The "what to do next" line; absent when nothing honest can be said. */
  hint?: string
}

/**
 * The empty state's copy, decided from the facts the view can actually read.
 *
 * A pure function on purpose: the bundle has no DOM test, and this decision is
 * where two real defects lived. `chatTranscriptOf` answering `undefined` covers
 * TWO different states — "this conversation has never been served by an NTR
 * agent" and "its ACP session record is gone" (a closed session is destroyed by
 * `closeSession`/`forgetDshSession`, a stopped agent drops its bridge) while the
 * binding and the composer chip still name the agent. Claiming the first state
 * in both cases made the view contradict the chip sitting one row above it.
 *
 * The hint has its own defect: it pointed at the composer's NTR base, which only
 * the ACP-mode gate installs (`syncAcpMode` in src/client/index.tsx) — in an
 * ordinary conversation that cell still holds the host's own model selector, so
 * the hint sent the user to a control that is not there.
 */
export function acpEmptyCopy(facts: AcpEmptyFacts, t: Translate): AcpEmptyCopy {
  const bound = facts.bound
  if (bound !== undefined) {
    return {
      title: t('这个会话当前没有可显示的 ACP 会话', 'This conversation has no ACP session to show right now'),
      body: t(
        '给它发一条消息，它就会开始服务这个会话：原生聊天里会出现它的文字回复与思考过程，而它的工具调用、计划和 diff 会完整地出现在这个视图里。',
        'Send it a message and it starts serving this conversation: the native chat shows its prose and reasoning, while its tool calls, plans and diffs appear here in full.',
      ),
      hint: `${t('绑定的是', 'bound to')} · ${bound.title}`,
    }
  }
  const copy: AcpEmptyCopy = {
    title: t('这个会话还没有 NTR agent 参与', 'No NTR agent has run in this conversation yet'),
    body: t(
      '选中一个 NTR agent 后，本会话的对话就由它服务：原生聊天里会出现它的文字回复与思考过程，而它的工具调用、计划和 diff 会完整地出现在这个视图里。',
      "Pick a NTR agent and it serves this conversation: the native chat shows its prose and reasoning, while its tool calls, plans and diffs appear here in full.",
    ),
  }
  if (!facts.hasAgents) {
    return { ...copy, hint: `${t('还没有配置 agent', 'No agent configured')} · ${t('设置 → NTR', 'Settings → NTR')}` }
  }
  // The base is only on screen in NTR mode; naming it anywhere else points at
  // the host's model selector. A host that has not answered yet gets no line
  // rather than a guess (the seat diagnostics below still say what they saw).
  if (facts.acpMode === true) {
    return { ...copy, hint: t('用输入框右侧的 NTR 底座选择一个 agent', 'pick one from the NTR base in the composer') }
  }
  if (facts.acpMode === false) {
    return {
      ...copy,
      hint: `${t('这个会话不在 NTR 模式', 'This conversation is not in NTR mode')} · ${t('新建会话时可以选择 NTR 模式', 'NTR is chosen when a conversation starts')}`,
    }
  }
  return copy
}

// ---- The read-only subagent section ----
//
// Task 2 of the subagent panel: show the plugin's own lifecycle records
// (`UiState.subagents`, fed by Task 1's `subagents/record` frames and the
// `session/chat-list` snapshot) inside the NTR view tab so the six-state
// machine can be verified on a real run. This is a VIEW of the records — no
// cancel / retry / spawn, no click-through (the detail dialog is Task 3), and
// no `foldUpdate` / `blocks` reads: worker frames are not part of the parent
// transcript.

/** Tick of the in-flight rows' elapsed clocks (the label shows whole seconds). */
const SUBAGENT_TICK_MS = 1000

/** Badge wording per lifecycle state; six states must read differently. */
const SUBAGENT_LABEL: Record<SubagentStatus, readonly [zh: string, en: string]> = {
  pending: ['等待开始', 'pending'],
  running: ['运行中', 'running'],
  completed: ['已完成', 'completed'],
  failed: ['失败', 'failed'],
  cancelled: ['已取消', 'cancelled'],
  unknown: ['状态未知', 'state unknown'],
}

/** Badge tone per lifecycle state, reusing the existing `ntr-acp-badge.is-*` tones. */
const SUBAGENT_TONE: Record<SubagentStatus, string> = {
  pending: 'idle',
  running: 'busy',
  completed: 'done',
  failed: 'fail',
  cancelled: 'warn',
  unknown: 'idle',
}

/** The badge label of one lifecycle state. */
export function subagentStatusLabel(status: SubagentStatus, t: Translate): string {
  const [zh, en] = SUBAGENT_LABEL[status] ?? SUBAGENT_LABEL.unknown
  return t(zh, en)
}

/** The badge tone of one lifecycle state. */
export function subagentStatusTone(status: SubagentStatus): string {
  return SUBAGENT_TONE[status] ?? 'idle'
}

/**
 * Whether the row is still in flight: dispatched but not started, or running.
 * These are exactly the rows whose elapsed clock advances with `now`.
 */
function isActiveSubagent(status: SubagentStatus): boolean {
  return status === 'pending' || status === 'running'
}

/**
 * Rows the agent is running right now — the header's "M running" count.
 *
 * `pending` is deliberately NOT counted: the row's own badge says "pending"
 * (等待开始), so calling the same state "running" in the header would make the
 * two lines contradict each other. The pending row's elapsed clock still
 * ticks (it counts from dispatch), it just is not billed as running.
 */
export function subagentRunningCount(records: readonly Pick<SubagentRecord, 'status'>[]): number {
  return records.filter(record => record.status === 'running').length
}

/**
 * One row's elapsed wall time: from dispatch to the terminal stamp, or to
 * `now` while the row is still in flight. A stale end stamp on an in-flight
 * row is ignored, and a terminal row without one (a teardown-written
 * `unknown`) has no better stamp to stop at.
 */
export function subagentElapsedMs(
  record: Pick<SubagentRecord, 'startedAt' | 'endedAt' | 'status'>,
  now: number,
): number {
  const end = isActiveSubagent(record.status) ? now : (record.endedAt ?? now)
  const elapsed = end - record.startedAt
  return elapsed > 0 ? elapsed : 0
}

/** Compact elapsed time: `45s`, `1m 05s`, `2h 03m`. */
export function formatSubagentDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** `type · label`, falling back to the label, then to the child id. */
export function subagentTitle(record: Pick<SubagentRecord, 'type' | 'label' | 'childId'>): string {
  const label = record.label.trim() === '' ? record.childId : record.label.trim()
  const type = record.type?.trim()
  return type === undefined || type === '' ? label : `${type} · ${label}`
}

/** How recently one duplicate record was updated; the fresher copy wins a de-dupe. */
function subagentFreshness(record: SubagentRecord): number {
  return Math.max(record.lastActivityAt, record.endedAt ?? 0, record.startedAt)
}

/**
 * This conversation's rows, newest dispatch first, one per `childId`.
 *
 * The composite store key (`dshSessionId + childId`) already makes duplicates
 * impossible; the de-dupe is defensive so a bad snapshot frame can never draw
 * the same worker twice. When two records share a `childId`, the fresher one
 * wins (the same "the newer frame beats an older snapshot" rule the store
 * applies to `subagents/record`).
 */
export function subagentRowsFor(records: Iterable<SubagentRecord>, dshSessionId: string): SubagentRecord[] {
  const byChild = new Map<string, SubagentRecord>()
  for (const record of records) {
    if (record.dshSessionId !== dshSessionId) continue
    const prior = byChild.get(record.childId)
    if (prior === undefined || subagentFreshness(record) > subagentFreshness(prior)) {
      byChild.set(record.childId, record)
    }
  }
  return [...byChild.values()].sort((a, b) => b.startedAt - a.startedAt)
}

/** What the section knows when it has no known state to show. */
export interface SubagentSectionFacts {
  /** This conversation's records, after filtering / de-duping. */
  total: number
  /** Records whose state is known (anything but `unknown`). */
  known: number
  /** Whether an ACP session has ever served this conversation. */
  served: boolean
}

/** One honest "nothing known" line pair. */
export interface SubagentSectionCopy {
  title: string
  body?: string
}

/**
 * The section's copy when it cannot show a known state.
 *
 * Two facts must never be conflated: "this conversation has never been served
 * by an ACP session" (nothing can be said about the agent's subagents at all)
 * and "the agent dispatched nothing" (a claim only a known-empty list may
 * make). A history of `unknown` records is a third thing: the records exist,
 * but their state was never tracked.
 */
export function subagentSectionCopy(facts: SubagentSectionFacts, t: Translate): SubagentSectionCopy | undefined {
  if (facts.total === 0) {
    if (!facts.served) {
      return {
        title: t('没有 ACP 会话记录，子智能体情况未知', 'No ACP session record — subagent history unknown'),
        body: t(
          '这个 agent 是否派出过子智能体现在无从判断；它服务本会话后，记录会显示在这里。',
          'Whether this agent ever dispatched subagents cannot be told yet; once it serves this conversation the records appear here.',
        ),
      }
    }
    return {
      title: t('还没有子智能体记录', 'No subagent records yet'),
      body: t(
        'agent 派出子智能体后，这里会显示它们的状态与耗时。',
        'Subagents appear here with their state and elapsed time once this agent dispatches them.',
      ),
    }
  }
  if (facts.known === 0) {
    return {
      title: t('历史记录 · 状态未知', 'Historical records · state unknown'),
      body: t(
        '这些记录早于状态跟踪，无法判断它们已完成、失败还是仍在运行。',
        'These records predate state tracking — whether they finished, failed, or are still running cannot be told.',
      ),
    }
  }
  return undefined
}

/** One read-only subagent row: state, name, elapsed time, tool-call count. */
function SubagentRow({ record, now, t }: { record: SubagentRecord; now: number; t: Translate }) {
  return (
    <div className="ntr-acp-subagents-row">
      <span className={`ntr-acp-badge is-${subagentStatusTone(record.status)}`}>
        {subagentStatusLabel(record.status, t)}
      </span>
      <span className="ntr-acp-subagents-name" title={record.childId}>{subagentTitle(record)}</span>
      <span className="ntr-acp-subagents-meta">{formatSubagentDuration(subagentElapsedMs(record, now))}</span>
      <span className="ntr-acp-subagents-meta">
        {t(`${record.counts.toolCalls} 次工具调用`, `${record.counts.toolCalls} tool calls`)}
      </span>
    </div>
  )
}

/**
 * The compact, read-only subagent strip. It stays secondary to the transcript:
 * one header line, a capped row list, and copy instead of rows when nothing is
 * known.
 *
 * Exported for the strip's render test (the per-second clock); the section
 * registers nothing and reads no store state of its own.
 */
export function SubagentSection({ rows, served, t }: { rows: readonly SubagentRecord[]; served: boolean; t: Translate }) {
  // The elapsed clocks of in-flight rows must advance without a store frame
  // (a silent running worker sends no `subagents/record`), so they tick once a
  // second; terminal rows freeze at their end stamp. Same pattern as
  // `PermissionDock`'s countdown: derive the boolean first, then gate a single
  // interval on it, so an all-terminal strip schedules no timer at all.
  const ticking = rows.some(record => isActiveSubagent(record.status))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, SUBAGENT_TICK_MS)
    return () => { clearInterval(timer) }
  }, [ticking])
  const running = subagentRunningCount(rows)
  const note = subagentSectionCopy({
    total: rows.length,
    known: rows.filter(record => record.status !== 'unknown').length,
    served,
  }, t)
  const totalText = t(`累计 ${rows.length} 个`, `${rows.length} total`)
  const runningText = t(`${running} 运行中`, `${running} running`)
  return (
    <div className="ntr-acp-subagents">
      <div className="ntr-acp-subagents-head">
        <span className="ntr-acp-subagents-title">{t('子智能体', 'subagents')}</span>
        {rows.length > 0 && (
          <span className="ntr-acp-subagents-count">
            {running > 0 ? `${totalText} · ${runningText}` : totalText}
          </span>
        )}
      </div>
      {note !== undefined && (
        <div className="ntr-acp-subagents-note">
          {note.title}
          {note.body !== undefined && <span> · {note.body}</span>}
        </div>
      )}
      {rows.length > 0 && (
        <div className="ntr-acp-subagents-rows">
          {rows.map(record => <SubagentRow key={record.childId} record={record} now={now} t={t} />)}
        </div>
      )}
    </div>
  )
}

/**
 * The ACP view tab body: who serves this conversation and how it is doing,
 * then the agent's own stream.
 */
export function AcpConversationView(props: AcpViewProps) {
  ensureAcpStyle()
  const { acp, sessionId } = props
  const t: Translate = (zh, en) => acp.label(zh, en)
  const ui = useUi(acp)
  // Task 1's records; `loadChatSessions` above carries the snapshot, live
  // transitions ride `subagents/record` frames straight into the store.
  const subagents = subagentRowsFor(Object.values(ui.subagents), sessionId)
  const bound = ui.chatSessionsFor === sessionId ? boundSession(ui.chatSessions) : undefined
  const transcript: ChatTranscript | undefined = acp.chatTranscriptOf(sessionId)
  // "An ACP session has served this conversation" is a fact of its own: the
  // chat-list row proves it just as well as the transcript does, and the two
  // reads land independently. Taking only the transcript would paint the
  // "history unknown" copy for a served conversation while the transcript
  // read is in flight; with neither answer the fact is genuinely unknown.
  const served = transcript !== undefined || bound !== undefined
  // Who this conversation is set up on — readable with no transcript at all,
  // which is the whole point: the transcript is a record of turns, the binding
  // is the conversation's own state.
  const boundAgent = boundAgentOf(bound, ui.chatBoundAgent[sessionId], ui.chatChoice[sessionId]?.agentId, ui.agents)
  const streamRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Observe this chat session's ACP transcripts whenever the binding could
  // have changed (first turn, agent switch, crash → resume).
  useEffect(() => {
    void acp.loadChatSessions(sessionId)
    void acp.loadChatTranscript(sessionId)
  }, [acp, sessionId, bound?.sessionId, bound?.released])

  const blockCount = transcript?.blocks.length ?? 0
  const tail = transcript?.blocks[blockCount - 1]
  useEffect(() => {
    const node = streamRef.current
    if (node === null || !pinned.current) return
    node.scrollTop = node.scrollHeight
  }, [blockCount, tail])

  // The gate installs the NTR tab only for a conversation it has confirmed as
  // ACP; a stale release must not paint NTR content into an ordinary one for a
  // frame, so anything but the affirmative verdict renders nothing.
  if (ui.acpMode[sessionId] !== true) return null

  if (transcript === undefined) {
    // The guard above makes this a confirmed ACP conversation; the copy
    // builder keeps its "unknown" branch for callers that only read facts
    // (`docs` and tests), not for this rendered surface.
    const empty = acpEmptyCopy({
      bound: boundAgent,
      hasAgents: ui.agents.length > 0,
      acpMode: ui.acpMode[sessionId],
    }, t)
    return (
      <div className="ntr-acp-view">
        <SubagentSection rows={subagents} served={served} t={t} />
        <div className="ntr-acp-empty">
          <div className="ntr-acp-empty-title">{empty.title}</div>
          <p className="ntr-acp-empty-body">{empty.body}</p>
          {empty.hint !== undefined && <div className="ntr-acp-empty-hint">{empty.hint}</div>}
          {/*
            The model-seat gate's last verdict. When the ACP base does not take
            over the composer's model seat — the native model selector is still
            sitting there — the four possible reasons are otherwise
            indistinguishable, because they all end with the same visible state.
            Publishing the reason here turns "the base still is not replaced"
            into something readable.
          */}
          {ui.seatDiag !== 'idle' && ui.seatDiag !== 'gate disposed' && (
            <div className="ntr-acp-empty-hint ntr-acp-seat-diag">
              {t('模型座位', 'model seat')} · {ui.seatDiag}
            </div>
          )}
          {ui.permissionSeatDiag !== 'idle' && ui.permissionSeatDiag !== 'gate disposed' && (
            <div className="ntr-acp-empty-hint ntr-acp-seat-diag">
              {t('权限底座', 'permission seat')} · {ui.permissionSeatDiag}
            </div>
          )}
          {/*
            Slash isolation degrades open (an unrecognized host source shape
            leaves the host's commands in charge). That is the safe failure,
            but it looks exactly like the feature never having existed — the
            menu simply lists DSH's commands again. Say so.
          */}
          {ui.slashDiag !== 'idle' && (
            <div className="ntr-acp-empty-hint ntr-acp-seat-diag">
              {t('斜杠菜单', 'slash menu')} · {ui.slashDiag}
            </div>
          )}
        </div>
      </div>
    )
  }

  const session = transcript.session
  const usage = session.usage
  const agentTitle = ui.agents.find(agent => agent.id === session.agentId)?.title ?? bound?.agentTitle ?? session.agentId
  const health = session.released
    ? { text: t('已挂起 · 下一条消息自动恢复', 'paused · resumes on your next message'), tone: 'warn' }
    : session.closed
      ? { text: t('已关闭', 'closed'), tone: 'idle' }
      : session.running
        ? { text: t('运行中', 'running'), tone: 'busy' }
        : { text: t('空闲', 'idle'), tone: 'done' }

  return (
    <div className="ntr-acp-view">
      <div className="ntr-acp-view-head">
        <span className={`ntr-acp-badge is-${health.tone}`}>{health.text}</span>
        <span className="ntr-acp-view-agent">{agentTitle}</span>
        <span className="ntr-acp-view-meta" title={session.cwd}>{session.cwd}</span>
        {usage !== undefined && <span className="ntr-acp-view-meta">{usage.used}/{usage.size}</span>}
        <button type="button" className="ntr-acp-more" onClick={() => { void acp.loadChatTranscript(sessionId) }}>
          {t('刷新', 'refresh')}
        </button>
      </div>
      <SubagentSection rows={subagents} served={served} t={t} />
      <div
        className="ntr-acp-stream"
        ref={streamRef}
        onScroll={event => {
          const node = event.currentTarget
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
        }}
      >
        {transcript.blocks.length === 0
          ? (
            <div className="ntr-acp-empty-hint">
              {historyAwaitsReplay(session)
                ? t('进程已释放；历史将在恢复后回放显示。', 'The process is released — history replays once it is restored.')
                : t('还没有消息：在下面的输入框里发给它。', 'Nothing yet — send it a message below.')}
            </div>
          )
          : transcript.blocks.map((block, index) => <BlockView key={index} block={block} label={acp.label} localeRev={ui.localeRev} />)}
      </div>
    </div>
  )
}
