/**
 * The READ-ONLY step view for one Antigravity subagent's brain transcript
 * (task 3 of docs/plan/antigravity-subagent-panel.md).
 *
 * agy's child transcript is a STEP stream (`step_index` / `source` / `type` /
 * `status` / `created_at` / `content` / `thinking` / `tool_calls` / `error`),
 * not `session/update` frames — so it gets its own rendering, never the frame
 * fold (`foldUpdate` would merge the parent turn's prose into it). Entries
 * arrive marked `source: 'agy-transcript'` through the existing detail index;
 * the host already bounded them (entry cap + per-step cut + read notices).
 *
 * Every step type has a destination (constraint 29): USER_INPUT / PLANNER_
 * RESPONSE / GENERIC / SYSTEM_MESSAGE render their text / thinking / tool
 * cards / report; an unknown type falls back to a generic row with the
 * verbatim JSON, and extra keys on a known type keep a raw disclosure. A cut
 * step shows the retained text plus the marker; a read notice says exactly
 * what could not be read. NO control surface: agy subagents have no cancel /
 * retry / message plane, so this view draws none of those buttons.
 *
 * Styling reuses the detail overlay's existing alias-token classes (constraint
 * 34) — this module adds no stylesheet of its own.
 */
import type { SubagentDetailEntry } from '../protocol.ts'
import type { Translate } from './acp-view.tsx'

/** One tool call of a transcript step, as the wire carries it. */
export interface AgyToolCall {
  name: string
  args?: unknown
}

/** One normalized step row (pure; the component only renders this). */
export interface AgyStepView {
  /** Row class; `notice` rows are read-failure markers, `cut` a host-truncated step. */
  kind: 'notice' | 'cut' | 'user-input' | 'planner' | 'tool' | 'generic' | 'system' | 'unknown'
  /** The notice name (`unreadable` / `bad-lines` / `window-cut`), when kind is `notice`. */
  notice?: string
  /** How many lines the `bad-lines` notice counts. */
  noticeLines?: number
  /** The wire's own `type` ('' when absent); an unknown type shows it verbatim. */
  type: string
  status: string
  stepIndex?: number
  createdAt?: string
  /** The step's `source` (SYSTEM / MODEL), when present. */
  source?: string
  content: string
  thinking?: string
  tools: AgyToolCall[]
  error?: string
  /** Pretty JSON of the whole step: unknown types and extra keys keep a destination. */
  raw?: string
  /** Retained text of a host-cut step (`truncated: true` payload). */
  cutText?: string
}

/** A plain object view of an arbitrary value (arrays and nulls are not objects here). */
function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Readable text for one value: a string verbatim, everything else pretty JSON.
 * Same contract as the detail dialog's `formatDetailValue`; a local copy keeps
 * this module independent of it (the dialog imports THIS module, never back).
 */
function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The wire keys a known step type renders; anything else earns a raw disclosure. */
const KNOWN_STEP_KEYS = new Set([
  'step_index', 'source', 'type', 'status', 'created_at', 'content', 'thinking', 'tool_calls', 'error',
])

/** The badge tone of one step status (the overlay's existing badge classes). */
export function agyStepStatusTone(status: string): string {
  if (status === 'ERROR') return 'fail'
  if (status === 'RUNNING') return 'busy'
  if (status === 'DONE') return 'done'
  return 'idle'
}

/**
 * Normalize one transcript step (or read notice, or host cut) into its row.
 * Pure and fail-open: a non-object payload still gets a generic row with its
 * text, nothing throws, and no measured field is dropped on the floor.
 */
export function describeAgyStep(update: unknown): AgyStepView {
  const base: AgyStepView = { kind: 'unknown', type: '', status: '', content: '', tools: [] }
  const object = objectRecord(update)
  if (object === undefined) return { ...base, raw: prettyValue(update) }
  if (typeof object.notice === 'string') {
    return {
      ...base,
      kind: 'notice',
      notice: object.notice,
      ...(typeof object.lines === 'number' && Number.isFinite(object.lines) ? { noticeLines: object.lines } : {}),
    }
  }
  // A host-side bound already cut this step: `text` IS the retained payload.
  if (object.truncated === true && typeof object.text === 'string') {
    return { ...base, kind: 'cut', cutText: object.text }
  }
  const type = typeof object.type === 'string' ? object.type : ''
  const tools: AgyToolCall[] = []
  if (Array.isArray(object.tool_calls)) {
    for (const call of object.tool_calls) {
      const row = objectRecord(call)
      if (row === undefined) {
        tools.push({ name: prettyValue(call) })
        continue
      }
      tools.push({
        name: typeof row.name === 'string' && row.name !== '' ? row.name : prettyValue(call),
        ...(row.args === undefined ? {} : { args: row.args }),
      })
    }
  }
  const content = typeof object.content === 'string'
    ? object.content
    : (object.content === undefined ? '' : prettyValue(object.content))
  const view: AgyStepView = {
    ...base,
    type,
    status: typeof object.status === 'string' ? object.status : '',
    content,
    tools,
    ...(typeof object.step_index === 'number' && Number.isFinite(object.step_index) ? { stepIndex: object.step_index } : {}),
    ...(typeof object.created_at === 'string' && object.created_at !== '' ? { createdAt: object.created_at } : {}),
    ...(typeof object.source === 'string' && object.source !== '' ? { source: object.source } : {}),
    ...(typeof object.thinking === 'string' && object.thinking !== '' ? { thinking: object.thinking } : {}),
    ...(object.error === undefined ? {} : { error: prettyValue(object.error) }),
  }
  if (type === 'USER_INPUT') view.kind = 'user-input'
  else if (type === 'PLANNER_RESPONSE') view.kind = 'planner'
  else if (type === 'SYSTEM_MESSAGE') view.kind = 'system'
  else if (type === 'GENERIC') view.kind = tools.length > 0 ? 'tool' : 'generic'
  // Unknown types keep the whole step as JSON; a known type with keys this
  // build does not render keeps a raw disclosure (constraint 29).
  const extra = Object.keys(object).some(key => !KNOWN_STEP_KEYS.has(key))
  if (view.kind === 'unknown' || extra) view.raw = prettyValue(update)
  return view
}

/** Translated chip text per row kind (an unknown TYPE shows its raw name instead). */
export function agyStepKindLabel(kind: AgyStepView['kind'], t: Translate): string {
  switch (kind) {
    case 'user-input': return t('用户输入', 'user input')
    case 'planner': return t('回复', 'response')
    case 'tool': return t('工具步', 'tool step')
    case 'generic': return t('通用步', 'generic step')
    case 'system': return t('系统消息', 'system message')
    case 'cut': return t('截断步骤', 'cut step')
    default: return t('未知步骤', 'unknown step')
  }
}

/** The explicit copy of one read notice — "cannot read" is always said, never implied. */
function noticeCopy(view: AgyStepView, t: Translate): string {
  if (view.notice === 'unreadable') {
    return t(
      '读不到这个子代理的 transcript：文件不存在或不可读。',
      'Cannot read this subagent’s transcript: the file is missing or unreadable.',
    )
  }
  if (view.notice === 'bad-lines') {
    return view.noticeLines === undefined
      ? t('transcript 有无法解析的行，已跳过。', 'Some transcript lines could not be parsed and were skipped.')
      : t(
        `transcript 有 ${String(view.noticeLines)} 行无法解析，已跳过。`,
        `${String(view.noticeLines)} transcript lines could not be parsed and were skipped.`,
      )
  }
  if (view.notice === 'window-cut') {
    return t('更早的步骤超出读取窗口，未加载。', 'Earlier steps are beyond the read window and were not loaded.')
  }
  // A notice this build does not know still states its name (fail-open).
  return `${t('读取提示', 'read notice')}: ${view.notice ?? ''}`
}

/** One read-failure marker row (renders after the steps — a footnote, not content). */
function AgyNoticeRow({ view, t }: { view: AgyStepView; t: Translate }) {
  return (
    <div className="ntr-acp-subagent-detail-note" data-notice={view.notice ?? 'unknown'}>
      {noticeCopy(view, t)}
    </div>
  )
}

/** One step row: type chip, index, status badge, timestamp, then every payload field. */
function AgyStepRow({ entry, view, t }: { entry: SubagentDetailEntry; view: AgyStepView; t: Translate }) {
  const cut = entry.truncatedChars !== undefined && entry.truncatedChars > 0
  const chip = view.kind === 'unknown' && view.type !== '' ? view.type : agyStepKindLabel(view.kind, t)
  return (
    <div className="ntr-acp-subagent-detail-entry" data-step-type={view.type === '' ? 'unknown' : view.type}>
      <div className="ntr-acp-subagent-detail-entry-head">
        <span className="ntr-acp-subagent-detail-kind">{chip}</span>
        {view.stepIndex !== undefined && <span className="ntr-acp-subagent-detail-note">#{String(view.stepIndex)}</span>}
        {view.status !== '' && (
          <span className={`ntr-acp-badge is-${agyStepStatusTone(view.status)}`}>{view.status}</span>
        )}
        {view.createdAt !== undefined && <span className="ntr-acp-subagent-detail-note">{view.createdAt}</span>}
        {view.source !== undefined && <span className="ntr-acp-subagent-detail-note">{view.source}</span>}
        {cut && (
          <span className="ntr-acp-subagent-detail-cut">
            {t(`负载截断 ${String(entry.truncatedChars)} 字符`, `payload cut · ${String(entry.truncatedChars)} chars`)}
          </span>
        )}
      </div>
      {view.cutText !== undefined && <pre className="ntr-acp-subagent-detail-pre">{view.cutText}</pre>}
      {view.content !== '' && <pre className="ntr-acp-subagent-detail-pre">{view.content}</pre>}
      {view.thinking !== undefined && (
        <details className="ntr-acp-subagent-detail-thought" open>
          <summary>{t('思考过程', 'reasoning')}</summary>
          <pre className="ntr-acp-subagent-detail-pre">{view.thinking}</pre>
        </details>
      )}
      {view.tools.map((tool, index) => (
        <div key={index} className="ntr-acp-subagent-detail-section">
          <div className="ntr-acp-subagent-detail-entry-head">
            <span className="ntr-acp-subagent-detail-entry-title">{tool.name}</span>
          </div>
          {tool.args !== undefined && <pre className="ntr-acp-subagent-detail-pre">{prettyValue(tool.args)}</pre>}
        </div>
      ))}
      {view.error !== undefined && (
        <div className="ntr-acp-subagent-detail-line">
          <span className="ntr-acp-badge is-fail">{t('错误', 'error')}</span> <span>{view.error}</span>
        </div>
      )}
      {view.raw !== undefined && (view.kind === 'unknown'
        ? <pre className="ntr-acp-subagent-detail-pre">{view.raw}</pre>
        : (
          <details className="ntr-acp-subagent-detail-thought">
            <summary>{t('原始步骤', 'raw step')}</summary>
            <pre className="ntr-acp-subagent-detail-pre">{view.raw}</pre>
          </details>
        ))}
    </div>
  )
}

/**
 * The child's step stream: steps in transcript order, read notices after them.
 * Read-only — no button of any kind (the dialog's close control is the only
 * gesture the whole overlay offers).
 */
export function AgyStepStream({ entries, t }: { entries: readonly SubagentDetailEntry[]; t: Translate }) {
  const views = entries.map(entry => ({ entry, view: describeAgyStep(entry.update) }))
  const steps = views.filter(item => item.view.kind !== 'notice')
  const notices = views.filter(item => item.view.kind === 'notice')
  return (
    <div className="ntr-acp-subagent-detail-stream">
      {steps.map(({ entry, view }, index) => (
        <AgyStepRow key={`${String(entry.seq)}:${String(index)}`} entry={entry} view={view} t={t} />
      ))}
      {notices.map(({ entry, view }, index) => (
        <AgyNoticeRow key={`notice:${String(entry.seq)}:${String(index)}`} view={view} t={t} />
      ))}
    </div>
  )
}