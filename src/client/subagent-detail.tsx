/**
 * The read-only subagent detail overlay (`shell.overlay` id `acp-subagent-detail`).
 *
 * Moved out of `subagent-panel.tsx` (the list/trigger module) under the line
 * ratchet: the panel keeps the header cell, this module owns the dialog and
 * its detail-rendering helpers. Rows open it through `openSubagentDetail`
 * (acp-ui.tsx); it renders what the plugin already knows — the lifecycle
 * record (`UiState.subagents`) for the header, the bounded raw entries
 * (`UiState.subagentDetails`) for the dispatch input and the worker stream.
 * It is a VIEW: no cancel / retry / spawn / stop, no prompt input.
 *
 * TWO STREAM VOCABULARIES, routed per worker:
 * - CodeBuddy entries are `session/update` frames: the dialog folds them per
 *   worker at view time (`subagentDetailBlocks`) into the same blocks the NTR
 *   view renders; the untouched frames stay one "raw events" toggle away.
 * - Antigravity entries marked `source: 'agy-transcript'` are the child's OWN
 *   brain-transcript steps: they render in the read-only step view
 *   (`subagent-detail-agy.tsx`), never through the frame fold. The record's
 *   `childConversationId` routes the view even before the read lands; live
 *   dispatch frames (unmarked) still feed the dispatch-input header only.
 *
 * The raw entries come from the store's dedicated per-worker index, NOT the
 * shared ACP transcript: folding the transcript would drop `_meta` and merge
 * adjacent prose across workers, splicing the parent turn's text into a
 * worker's detail (plan §5.4). The index is fed by live frames and on-demand
 * `subagents/detail` reads: once per page for CodeBuddy (the store's `loaded`
 * flag is the gate), on EVERY open for an agy-marked index — agy sends no
 * wire frames after creation, so a one-shot read would freeze the stream.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
// Type-only: pulls the conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { closeSubagentDetail, ensureAcpStyle, useSubagentDetailTarget, useUi } from './acp-ui.tsx'
import {
  BlockView, formatSubagentDuration, subagentElapsedMs, subagentLastActivityLabel, subagentStatusLabel,
  subagentStatusTone, subagentTitle, SUBAGENT_TICK_MS,
} from './acp-view.tsx'
import type { Translate } from './acp-view.tsx'
import { compactDetailValue, foldUpdate, subagentKey, subagentToolCallId } from './store.ts'
import type { AcpStore, Block } from './store.ts'
import type { SubagentDetailEntry } from '../protocol.ts'
import { AgyStepStream } from './subagent-detail-agy.tsx'

/** One dispatch-owned frame's input, as the detail header shows it. */
export interface SubagentDispatchDetail {
  /** The dispatch tool call's own title (the agent's label for the tool). */
  title?: string
  /** The raw `rawInput` of the newest dispatch frame that carried one. */
  rawInput?: unknown
}

/** A plain object view of an arbitrary value (arrays and nulls are not objects here). */
function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The dispatch's original input from the worker's raw entries.
 *
 * The raw input lives on the dispatch's OWN frames (`toolCallId === <dispatch
 * id>`) — the same frames that carry the terminal state — so a filter that
 * only matched the worker's `parentToolCallId` frames would lose it. Later
 * frames win; `undefined` means the page never saw the dispatch frame (an
 * older run, or an index that starts after it).
 */
export function subagentDispatchDetail(
  entries: readonly Pick<SubagentDetailEntry, 'update'>[],
  childId: string,
): SubagentDispatchDetail | undefined {
  const toolCallId = subagentToolCallId(childId)
  if (toolCallId === '') return undefined
  let found: SubagentDispatchDetail | undefined
  for (const entry of entries) {
    const update = objectRecord(entry.update)
    if (update === undefined || update.toolCallId !== toolCallId) continue
    const kind = update.sessionUpdate
    if (kind !== 'tool_call' && kind !== 'tool_call_update') continue
    if (typeof update.title === 'string' && update.title !== '') {
      found = { ...found, title: update.title }
    }
    if (update.rawInput !== undefined) {
      found = { ...found, rawInput: update.rawInput }
    }
  }
  return found
}

/**
 * Readable text for one arbitrary value: a string verbatim (an agent's own
 * failure sentence must not gain JSON quotes), everything else pretty JSON.
 * `error` is `unknown` by contract (string / object / array all legal), and a
 * value that cannot be serialized still comes back as text — never dropped.
 */
export function formatDetailValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Fold one worker's raw entries into the same block vocabulary the NTR view
 * renders: message bubbles, continuous reasoning sections, tool cards, plans
 * and event cards. This is safe to do per worker because the store's index is
 * already scoped to one `childId` — `foldUpdate` merges only adjacent prose,
 * so the parent turn's text can never splice into this stream (the reason the
 * index is not the shared transcript).
 *
 * The dispatch's OWN tool frames are left out: their `rawInput` and terminal
 * state are the header sections above, not part of the worker's conversation.
 * A cut frame keeps its retained text as an event (the bounder already left
 * the truncation marker inside `text`); a non-object payload is kept whole.
 */
export function subagentDetailBlocks(
  entries: readonly Pick<SubagentDetailEntry, 'update' | 'truncatedChars'>[],
  childId: string,
): Block[] {
  const dispatchToolCallId = subagentToolCallId(childId)
  const blocks: Block[] = []
  for (const entry of entries) {
    const update = objectRecord(entry.update)
    if (update === undefined) {
      blocks.push({ kind: 'event', event: 'unknown', text: formatDetailValue(entry.update) })
      continue
    }
    if (update.truncated === true && typeof update.text === 'string') {
      blocks.push({
        kind: 'event',
        event: `${typeof update.sessionUpdate === 'string' && update.sessionUpdate !== '' ? update.sessionUpdate : 'unknown'} · truncated`,
        text: update.text,
      })
      continue
    }
    if (dispatchToolCallId !== '' && update.toolCallId === dispatchToolCallId) continue
    foldUpdate(blocks, update)
  }
  return blocks
}

/** How one raw `session/update` entry is rendered in the worker stream. */
export interface SubagentDetailLine {
  /** `sessionUpdate` kind, or `unknown` when the payload carries none. */
  kind: string
  /** One-line heading (the tool's own title); the kind chip always renders. */
  title?: string
  /** Tool status carried by the frame, shown beside the title. */
  status?: string
  /** Readable body (pretty JSON for structured payloads); absent = no body. */
  body?: string
}

/** The text of one ACP content chunk, or `undefined` when it carries none. */
function chunkText(update: Record<string, unknown>): string | undefined {
  const content = update.content
  if (typeof content === 'string') return content
  const block = objectRecord(content)
  if (block !== undefined && block.type === 'text' && typeof block.text === 'string') return block.text
  return undefined
}

/**
 * Fold one raw update into its rendered line.
 *
 * Deliberately NOT `foldUpdate`: that merges adjacent prose into one block,
 * drops `_meta`, and is shared with the parent transcript. Every kind lands
 * somewhere — text / thinking chunks as prose, tool frames as a titled card
 * with their payload, everything else (plans, commands, mode, config, usage,
 * compaction, and any kind this build does not know) as one compact JSON line.
 */
export function describeSubagentDetailUpdate(update: unknown): SubagentDetailLine {
  const object = objectRecord(update)
  const kind = object !== undefined && typeof object.sessionUpdate === 'string' && object.sessionUpdate !== ''
    ? object.sessionUpdate
    : 'unknown'
  if (object === undefined) return { kind, body: compactDetailValue(update) }
  // A host-side bound already cut this frame: `text` IS the retained payload
  // (the entry's `truncatedChars` draws the marker). Re-wrapping it as JSON
  // would bury the text under escaping.
  if (object.truncated === true && typeof object.text === 'string') {
    return { kind, body: object.text }
  }
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'user_message_chunk') {
    const text = chunkText(object)
    if (text !== undefined) return { kind, body: text }
    return { kind, body: compactDetailValue(object.content ?? update) }
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const payload: Record<string, unknown> = {}
    for (const field of ['rawInput', 'rawOutput', 'content', 'locations']) {
      if (object[field] !== undefined) payload[field] = object[field]
    }
    return {
      kind,
      ...(typeof object.title === 'string' && object.title !== '' ? { title: object.title } : {}),
      ...(typeof object.status === 'string' && object.status !== '' ? { status: object.status } : {}),
      ...(Object.keys(payload).length === 0 ? {} : { body: formatDetailValue(payload) }),
    }
  }
  return { kind, body: compactDetailValue(update) }
}

/** Translated chip text per `session/update` kind (unknown kinds keep their raw name). */
const DETAIL_KIND_COPY: Record<string, readonly [zh: string, en: string]> = {
  user_message_chunk: ['用户消息', 'user message'],
  agent_message_chunk: ['正文', 'text'],
  agent_thought_chunk: ['思考', 'reasoning'],
  tool_call: ['工具调用', 'tool call'],
  tool_call_update: ['工具更新', 'tool update'],
  plan: ['计划', 'plan'],
  plan_update: ['计划更新', 'plan update'],
  plan_removed: ['计划移除', 'plan removed'],
  available_commands_update: ['命令清单', 'commands'],
  current_mode_update: ['模式', 'mode'],
  config_option_update: ['配置项', 'config options'],
  session_info_update: ['会话信息', 'session info'],
  usage_update: ['上下文占用', 'context usage'],
  compaction_update: ['压缩', 'compaction'],
  compaction_summary_chunk: ['压缩摘要', 'compaction summary'],
}

/** The chip text of one `session/update` kind. */
export function subagentDetailKindLabel(kind: string, t: Translate): string {
  const copy = DETAIL_KIND_COPY[kind]
  return copy === undefined ? kind : t(copy[0], copy[1])
}

/** One raw update row: kind chip, heading, body, and the cut marker when bounded. */
function DetailEntryView(
  { entry, line, t }: { entry: SubagentDetailEntry; line: SubagentDetailLine; t: Translate },
) {
  const cut = entry.truncatedChars !== undefined && entry.truncatedChars > 0
  const body = line.body !== undefined && line.body !== '' ? line.body : undefined
  return (
    <div className="ntr-acp-subagent-detail-entry" data-kind={line.kind}>
      <div className="ntr-acp-subagent-detail-entry-head">
        <span className="ntr-acp-subagent-detail-kind">{subagentDetailKindLabel(line.kind, t)}</span>
        {line.title !== undefined && (
          <span className="ntr-acp-subagent-detail-entry-title">{line.title}</span>
        )}
        {line.status !== undefined && <span className="ntr-acp-subagent-detail-note">{line.status}</span>}
        {cut && (
          <span className="ntr-acp-subagent-detail-cut">
            {t(`负载截断 ${String(entry.truncatedChars)} 字符`, `payload cut · ${String(entry.truncatedChars)} chars`)}
          </span>
        )}
      </div>
      {body !== undefined && (line.kind === 'agent_thought_chunk'
        ? (
          <details className="ntr-acp-subagent-detail-thought">
            <summary>{t('思考过程', 'reasoning')}</summary>
            <pre className="ntr-acp-subagent-detail-pre">{body}</pre>
          </details>
        )
        : <pre className="ntr-acp-subagent-detail-pre">{body}</pre>)}
    </div>
  )
}

/** The root overlay entry's inject face. */
export interface SubagentDetailDialogProps {
  acp: AcpStore
}

/** Locale-shaped end stamp (the browser owns the format; this view just states it). */
function detailEndStamp(at: number): string {
  return new Date(at).toLocaleString()
}

/**
 * The frame-wide, read-only subagent detail overlay (`shell.overlay`).
 *
 * Module-level open state (`openSubagentDetail` in acp-ui.tsx) because the
 * rows and this dialog live in unrelated slot trees. Renders null while no
 * target is open.
 */
export function SubagentDetailDialog({ acp }: SubagentDetailDialogProps) {
  ensureAcpStyle()
  const target = useSubagentDetailTarget()
  const ui = useUi(acp)
  const t: Translate = (zh, en) => acp.label(zh, en)
  const key = target === null ? undefined : subagentKey(target.dshSessionId, target.childId)
  const record = key === undefined ? undefined : ui.subagents[key]
  const detail = key === undefined ? undefined : ui.subagentDetails[key]
  const [failedKey, setFailedKey] = useState<string | undefined>(undefined)
  // The raw-event switch belongs to the worker it was opened for; a different
  // worker starts in the content view without an effect-frame flash.
  const [rawViewKey, setRawViewKey] = useState<string | undefined>(undefined)
  const rawView = rawViewKey !== undefined && rawViewKey === key
  const loadsRef = useRef(new Map<string, Promise<void>>())
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  const openedKey = useRef<string | undefined>(undefined)
  // The read answer and the live frames can interleave, so display order is
  // the host seq (stable for equal seq: the index's own order breaks the tie).
  const sortedEntries = useMemo(
    () => detail === undefined ? [] : [...detail.entries].sort((a, b) => a.seq - b.seq),
    [detail],
  )
  const childId = target?.childId ?? ''
  // The agy step stream: entries the host marked as the child's brain
  // transcript. The record's childConversationId routes the view even while
  // the read is in flight (or the file turned out empty); the marker alone
  // also routes when the record was capped away but the steps are here.
  const agyEntries = useMemo(
    () => sortedEntries.filter(entry => entry.source === 'agy-transcript'),
    [sortedEntries],
  )
  const isAgy = record?.childConversationId !== undefined || agyEntries.length > 0
  const blocks = useMemo(() => subagentDetailBlocks(sortedEntries, childId), [sortedEntries, childId])
  // Both are tick-independent: the open dialog re-renders every second, and
  // the scan plus the pretty-printed input would otherwise rerun per tick.
  const dispatch = useMemo(() => subagentDispatchDetail(sortedEntries, childId), [sortedEntries, childId])
  const dispatchInput = useMemo(
    () => dispatch?.rawInput === undefined ? undefined : formatDetailValue(dispatch.rawInput),
    [dispatch],
  )
  // Raw rows are described once per change; the per-second tick must not
  // re-pretty-print every retained JSON payload again.
  const rawLines = useMemo(
    () => rawView ? sortedEntries.map(entry => ({ entry, line: describeSubagentDetailUpdate(entry.update) })) : [],
    [rawView, sortedEntries],
  )

  // A running worker is read at its newest end: a fresh open (or a switch to
  // another worker) pins to the bottom, and new frames follow only while the
  // reader has not scrolled away — the same rule the NTR view keeps.
  useLayoutEffect(() => {
    if (key === undefined) {
      openedKey.current = undefined
      return
    }
    const node = bodyRef.current
    if (node === null) return
    if (openedKey.current !== key) {
      openedKey.current = key
      pinned.current = true
    }
    if (pinned.current) node.scrollTop = node.scrollHeight
  }, [key, blocks, rawView, agyEntries])

  // An open reads the bounded history (`subagents/detail`). The store owns
  // the answered bit (`loaded`): reopening a CodeBuddy worker whose read
  // landed never asks again (live frames keep it fresh), while an agy-marked
  // index re-reads on EVERY open (no wire frames exist after creation). A
  // FAILED read leaves it retryable on the next open (the store's documented
  // contract). Re-entry while a read is in flight joins the same promise
  // instead of issuing a second RPC.
  useEffect(() => {
    if (target === null) return
    const id = subagentKey(target.dshSessionId, target.childId)
    const opened = acp.getSnapshot().subagentDetails[id]
    if (opened?.loaded === true && !opened.entries.some(entry => entry.source === 'agy-transcript')) return
    setFailedKey(previous => (previous === id ? undefined : previous))
    let cancelled = false
    let pending = loadsRef.current.get(id)
    if (pending === undefined) {
      pending = acp.loadSubagentDetail(target.dshSessionId, target.childId)
      loadsRef.current.set(id, pending)
    }
    const settle = (): void => {
      if (loadsRef.current.get(id) === pending) loadsRef.current.delete(id)
      // `loadSubagentDetail` swallows its own RPC failure, so "answered" is
      // read back from the store: `loaded` still false means the read did not
      // land (an older host, or a dropped call). Idempotent on purpose — two
      // subscribers may share one promise (a re-run effect must not strand the
      // dialog in its loading state).
      if (acp.getSnapshot().subagentDetails[id]?.loaded !== true && !cancelled) setFailedKey(id)
    }
    void pending.then(settle, settle)
    return () => { cancelled = true }
  }, [acp, target])

  const open = target !== null
  const [now, setNow] = useState(() => Date.now())
  // While open, the relative "last activity" and a running worker's elapsed
  // clock stay live (a silent worker sends no record frame). The interval
  // exists only for the open spell.
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, SUBAGENT_TICK_MS)
    return () => { clearInterval(timer) }
  }, [open])

  // Escape closes unless focus sits in an editor — the banner's rule, so the
  // composer's own Escape is never taken by this overlay.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const node = event.target
      if (node instanceof HTMLElement) {
        if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable) return
      }
      event.preventDefault()
      event.stopPropagation()
      closeSubagentDetail()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  if (target === null || key === undefined) return null
  const entries = sortedEntries
  const loaded = detail?.loaded === true
  const waiting = !loaded && failedKey !== key
  const status = record?.status ?? 'unknown'
  const duration = record === undefined
    ? t('没有生命周期记录', 'no lifecycle record')
    : formatSubagentDuration(subagentElapsedMs(record, now))
  const activity = record === undefined ? undefined : subagentLastActivityLabel(record.lastActivityAt, now, t)
  const name = record !== undefined ? subagentTitle(record) : (dispatch?.title ?? target.childId)
  const omitted = detail?.omitted ?? 0
  const title = t('子智能体详情', 'subagent detail')
  return (
    <div className="ntr-acp-dialog-layer">
      <div className="ntr-acp-dialog-mask" aria-hidden onClick={closeSubagentDetail} />
      <div
        className="ntr-acp-dialog ntr-acp-subagent-detail"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="ntr-acp-dialog-head">
          <span className="ntr-acp-dialog-title">{title}</span>
          <button
            type="button"
            className="ntr-acp-dialog-close"
            title={t('关闭', 'Close')}
            aria-label={t('关闭子智能体详情', 'Close subagent detail')}
            autoFocus
            onClick={closeSubagentDetail}
          >
            ✕
          </button>
        </div>
        {/* The status summary is OUTSIDE the scroll body: it stays readable
            while the content below opens at its newest frame. */}
        <div className="ntr-acp-subagent-detail-summary">
          <div className="ntr-acp-subagent-detail-head">
            <div className="ntr-acp-subagent-detail-head-line">
              <span className="ntr-acp-subagent-detail-name">{name}</span>
              <span className={`ntr-acp-badge is-${subagentStatusTone(status)}`}>
                {subagentStatusLabel(status, t)}
              </span>
            </div>
            <div className="ntr-acp-subagent-detail-meta">
              <span>{duration}</span>
              {activity !== undefined && <span>· {activity}</span>}
              {record !== undefined && (
                <span>· {t(`${record.counts.toolCalls} 次工具调用`, `${record.counts.toolCalls} tool calls`)}</span>
              )}
              <span>· {target.childId}</span>
            </div>
          </div>
        </div>
        <div
          className="ntr-acp-dialog-body"
          ref={bodyRef}
          onScroll={event => {
            const node = event.currentTarget
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
          }}
        >
          <div className="ntr-acp-subagent-detail-body">
            {dispatchInput !== undefined && (
              <div className="ntr-acp-subagent-detail-section">
                <div className="ntr-acp-subagent-detail-heading">{t('派遣入参', 'dispatch input')}</div>
                <pre className="ntr-acp-subagent-detail-pre">{dispatchInput}</pre>
              </div>
            )}
            <div className="ntr-acp-subagent-detail-section">
              <div className="ntr-acp-subagent-detail-heading">{t('终态', 'terminal state')}</div>
              {record === undefined
                ? (
                  <div className="ntr-acp-subagent-detail-line">
                    {t(
                      '这个子智能体没有生命周期记录，状态未知。',
                      'This subagent has no lifecycle record — its state is unknown.',
                    )}
                  </div>
                )
                : (
                  <>
                    <div className="ntr-acp-subagent-detail-line">
                      {t(`状态：${subagentStatusLabel(record.status, t)}`, `state: ${subagentStatusLabel(record.status, t)}`)}
                    </div>
                    {record.endedAt !== undefined && (
                      <div className="ntr-acp-subagent-detail-line">
                        {t(`结束：${detailEndStamp(record.endedAt)}`, `ended: ${detailEndStamp(record.endedAt)}`)}
                      </div>
                    )}
                    {record.error !== undefined && !(typeof record.error === 'string' && record.error.trim() === '') && (
                      <div className="ntr-acp-subagent-detail-line">
                        <span>
                          {record.status === 'failed'
                            ? t('失败原因：', 'failure reason: ')
                            : t('原因：', 'reason: ')}
                        </span>
                        {typeof record.error === 'string'
                          ? <span>{record.error}</span>
                          : <pre className="ntr-acp-subagent-detail-pre">{formatDetailValue(record.error)}</pre>}
                      </div>
                    )}
                    {record.status === 'failed'
                      && (record.error === undefined
                        || (typeof record.error === 'string' && record.error.trim() === '')) && (
                        <div className="ntr-acp-subagent-detail-line">
                          {t('失败原因：agent 未给原因', 'failure reason: the agent gave no reason')}
                        </div>
                      )}
                    {record.status === 'unknown' && (
                      <div className="ntr-acp-subagent-detail-note">
                        {t(
                          '状态未知：agent 未上报终态，这条记录可能早于状态跟踪，或回合在终态帧之前结束。',
                          'State unknown: the agent reported no terminal state — this record may predate state tracking, or the turn ended before a terminal frame.',
                        )}
                      </div>
                    )}
                  </>
                )}
            </div>
            <div className="ntr-acp-subagent-detail-section">
              <div className="ntr-acp-subagent-detail-heading-row">
                <div className="ntr-acp-subagent-detail-heading">
                  {isAgy ? t('步骤流', 'step stream') : t('运行流', 'worker stream')}
                </div>
                {!isAgy && entries.length > 0 && (
                  <button
                    type="button"
                    className="ntr-acp-more"
                    onClick={() => { setRawViewKey(rawView ? undefined : key) }}
                  >
                    {rawView ? t('内容视图', 'content view') : t('原始事件', 'raw events')}
                  </button>
                )}
              </div>
              {omitted > 0 && (
                <div className="ntr-acp-subagent-detail-cut">
                  {t(`更早的 ${omitted} 条明细已省略`, `${omitted} earlier entries omitted`)}
                </div>
              )}
              {failedKey === key && !loaded && (
                <div className="ntr-acp-subagent-detail-note">
                  {t(
                    '历史明细读取失败，这里只显示本页已收到的更新。',
                    'Reading the history failed — only updates this page received are shown.',
                  )}
                </div>
              )}
              {isAgy
                ? (agyEntries.length === 0
                  ? (
                    <div className="ntr-acp-subagent-detail-note">
                      {waiting
                        ? t('正在读取明细…', 'loading detail…')
                        : t(
                          '子智能体 transcript 还没有步骤；它可能刚开始工作。',
                          'The child transcript has no steps yet; it may have just started.',
                        )}
                    </div>
                  )
                  : <AgyStepStream entries={agyEntries} t={t} />)
                : entries.length === 0
                  ? (
                    <div className="ntr-acp-subagent-detail-note">
                      {waiting
                        ? t('正在读取明细…', 'loading detail…')
                        : t(
                          '本次运行没有读到这个子智能体的明细；早先运行的明细不保留。',
                          'No detail was recorded for this run; earlier runs’ detail is not retained.',
                        )}
                    </div>
                  )
                  : rawView
                    ? rawLines.map(({ entry, line }, index) => (
                      <DetailEntryView key={`${String(entry.seq)}:${String(index)}`} entry={entry} line={line} t={t} />
                    ))
                    : blocks.length === 0
                      ? (
                        <div className="ntr-acp-subagent-detail-note">
                          {t(
                            '这个子智能体的更新只有状态变化，没有可显示的运行内容。',
                            'This subagent only reported state changes — no stream content to show.',
                          )}
                        </div>
                      )
                      : (
                        <div className="ntr-acp-subagent-detail-stream">
                          {blocks.map((block, index) => (
                            <BlockView key={index} block={block} label={acp.label} localeRev={ui.localeRev} thoughtOpen />
                          ))}
                        </div>
                      )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
