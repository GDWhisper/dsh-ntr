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
import { useEffect, useRef, useState } from 'react'
// Type-only: pulls the ui-conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import type { AcpChatInjected } from './acp-ui.tsx'
import type { Block, ChatTranscript } from './store.ts'
import type { ChatSessionView } from '../protocol.ts'

/** Props of the ACP view entry (injected face + the frame's session id). */
export interface AcpViewProps extends AcpChatInjected {
  sessionId: string
}

/** The store's bilingual label function. */
type Translate = (zh: string, en: string) => string

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

/** One structured edit, rendered as a unified diff. */
function DiffView({ diff, t }: { diff: { path: string; oldText: string | null; newText: string }; t: Translate }) {
  const rows = diffRows(diff.oldText, diff.newText)
  const added = rows.filter(row => row.sign === '+').length
  const removed = rows.filter(row => row.sign === '-').length
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
      {removed === 0 && <div className="ntr-acp-diff-note">{t('新增文件', 'new file')}</div>}
    </div>
  )
}

/** One tool call: header, text output, and any structured edits it carried. */
function ToolCard({ block, t }: { block: Extract<Block, { kind: 'tool' }>; t: Translate }) {
  const [expanded, setExpanded] = useState(false)
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
      {shown.length > 0 && (
        <pre className="ntr-acp-tool-body">{`${shown.join('\n')}${clipped ? '\n…' : ''}`}</pre>
      )}
      {block.diffs?.map((diff, index) => <DiffView key={`${diff.path}#${String(index)}`} diff={diff} t={t} />)}
      {block.lines.length > TOOL_LINES_CLIP && (
        <button type="button" className="ntr-acp-more" onClick={() => { setExpanded(!expanded) }}>
          {expanded
            ? t('收起', 'collapse')
            : t(`显示全部 ${block.lines.length} 行`, `show all ${block.lines.length} lines`)}
        </button>
      )}
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

/** One stream block, dispatched by kind. */
function BlockView({ block, t }: { block: Block; t: Translate }) {
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
    default:
      return <div className={`ntr-acp-notice is-${block.tone}`}>{block.text}</div>
  }
}

/** The bound ACP session for this chat, preferring the live one. */
function boundSession(list: readonly ChatSessionView[]): ChatSessionView | undefined {
  return list.find(session => !session.released) ?? list[0]
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
  const bound = ui.chatSessionsFor === sessionId ? boundSession(ui.chatSessions) : undefined
  const transcript: ChatTranscript | undefined = acp.chatTranscriptOf(sessionId)
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

  if (transcript === undefined) {
    return (
      <div className="ntr-acp-view">
        <div className="ntr-acp-empty">
          <div className="ntr-acp-empty-title">{t('这个会话还没有 ACP agent 参与', 'No ACP agent has run in this conversation yet')}</div>
          <p className="ntr-acp-empty-body">
            {t(
              '选中一个 ACP agent 后，本会话的对话就由它服务：原生聊天里会出现它的文字回复与思考过程，而它的工具调用、计划和 diff 会完整地出现在这个视图里。',
              "Pick an ACP agent and it serves this conversation: the native chat shows its prose and reasoning, while its tool calls, plans and diffs appear here in full.",
            )}
          </p>
          {bound !== undefined
            ? <div className="ntr-acp-empty-hint">{t('绑定的是', 'bound to')} · {bound.agentTitle ?? bound.agentId}</div>
            : ui.agents.length === 0
              ? <div className="ntr-acp-empty-hint">{t('还没有配置 agent', 'No agent configured')} · {t('设置 → ACP 代理', 'Settings → ACP Agents')}</div>
              : <div className="ntr-acp-empty-hint">{t('用输入框右侧的 ACP 底座选择一个 agent', 'pick one from the ACP base in the composer')}</div>}
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
      <div
        className="ntr-acp-stream"
        ref={streamRef}
        onScroll={event => {
          const node = event.currentTarget
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
        }}
      >
        {transcript.blocks.length === 0
          ? <div className="ntr-acp-empty-hint">{t('还没有消息：在下面的输入框里发给它。', 'Nothing yet — send it a message below.')}</div>
          : transcript.blocks.map((block, index) => <BlockView key={index} block={block} t={t} />)}
      </div>
    </div>
  )
}
