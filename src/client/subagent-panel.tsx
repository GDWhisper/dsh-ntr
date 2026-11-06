/**
 * The ACP conversation's SELF-DRAWN subagent trigger and read-only list.
 *
 * WHY IT EXISTS: the host's `subagent-catalog` header trigger derives every
 * row's activity from its own status map and hard-codes "not external -> maybe
 * completed", so an external worker (`acp:<toolCallId>`) can never read as
 * success / failure / cancelled — only a grey dot either way. The plugin owns
 * the real lifecycle (`SubagentRecord`, six states) but the host will not draw
 * it. So in ACP conversations this module replaces the host's trigger with its
 * own: the same header cell (`conversation.session.header.actions`, list id
 * `subagent-catalog`, claimed by `createSubagentCatalogClaim` in
 * `subagent-activity.tsx`), a trigger that separates "how many were ever
 * dispatched" from "how many run right now", and a list whose badge, elapsed
 * clock and counters come from the plugin records.
 *
 * THE LIST SKELETON IS STILL THE HOST'S. `projectionsBySession[sessionId]
 * .values.subagentCatalog` is the durable catalog (host session log), so the
 * rows that predate this plugin's records — and the ones whose records were
 * capped away — still appear. The join is newest-dispatch-first, one row per
 * `childId`: a catalog row with no record reads `unknown` (never succeeded),
 * and a record whose catalog row has not been appended yet still appears
 * (marked "catalog pending") because the plugin already knows the dispatch.
 *
 * FAIL-OPEN IS THE ONLY ALLOWED FAILURE MODE. Two DIFFERENT component types
 * carry the two branches ({@link OwnSubagentCatalog} vs the host component),
 * never a conditional hook inside one component: the slot's error boundary
 * would abdicate a whole entry whose hook count flips between renders. On any
 * host shape this bundle cannot serve (no `useSessions` hook, a projection
 * value that is not an array, a row this panel cannot serve, a native child
 * that needs host navigation) the host component is rendered with its original
 * props and the reason goes to the claim's diagnostic line.
 *
 * READ-ONLY. Rows open a read-only detail overlay
 * ({@link SubagentDetailDialog}, a global `shell.overlay` entry); neither the
 * list nor the detail offers cancel / retry / spawn / stop or any other fake
 * control.
 */

import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
// Type-only: pulls the conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { closeSubagentDetail, ensureAcpStyle, openSubagentDetail, useSubagentDetailTarget, useUi } from './acp-ui.tsx'
import {
  formatSubagentDuration, isActiveSubagent, subagentElapsedMs, subagentRowsFor,
  subagentRunningCount, subagentStatusLabel, subagentStatusTone, subagentTitle, SUBAGENT_TICK_MS,
} from './acp-view.tsx'
import type { Translate } from './acp-view.tsx'
import { subagentKey } from './store.ts'
import type { AcpStore } from './store.ts'
import type { SubagentDetailEntry, SubagentRecord, SubagentStatus } from '../protocol.ts'

/** Viewport margin the host's own catalog menu keeps (used for the same geometry). */
const MENU_VIEWPORT_MARGIN = 16
/** Widest the dropdown grows; the same cap the host's catalog popover uses. */
const MENU_MAX_WIDTH = 336

/** The host's `useSessions` selector hook, narrowed to what this panel calls. */
type SessionsHook = (selector: (state: unknown) => unknown) => unknown

/** Props the occupant hands {@link OwnSubagentCatalog}: the standard kit + injected face + our additions. */
export interface OwnSubagentCatalogProps extends Record<string, unknown> {
  /** The host's own trigger, rendered verbatim whenever this panel cannot serve. */
  host: ComponentType<Record<string, unknown>>
  /** The injected store (every conversation entry gets it through the claim's inject face). */
  acp: AcpStore
  /** The catalog projection selector hook the host component receives. */
  useSessions?: unknown
  /** Diagnostics channel (the claim's `onDiag`); one line per fail-open reason change. */
  onDiag?: (line: string) => void
}

/** One catalog row as the host's projection delivers it (the fields this panel reads). */
export interface SubagentProjectionRow {
  /** Catalog id (`acp:<toolCallId>`). */
  id: string
  /** Dispatch time carried through the host's view (`childCreatedAt` in the log). */
  createdAt?: number
  /** The host's own label for the row. */
  label?: string
}

/** A projection read: the rows, or the reason this bundle must render the host component. */
export type SubagentProjectionRead =
  | { ok: true; rows: SubagentProjectionRow[] }
  | { ok: false; reason: string }

/**
 * Validate the host's `subagentCatalog` view value.
 *
 * The panel serves exactly one shape: an array of EXTERNAL child rows
 * (`{ id, createdAt?, label?, mode: 'external' }`). Anything else — a
 * non-array, a row without an id, a row whose `mode` is not `'external'` — is
 * a host shape this bundle cannot draw honestly: native children need the
 * host's own navigation, and guessing at a changed schema would paint rows the
 * user cannot act on. Returning the reason lets the component fail open to the
 * host component and say why on the diagnostic line.
 */
export function readSubagentCatalogProjection(value: unknown): SubagentProjectionRead {
  if (!Array.isArray(value)) return { ok: false, reason: 'the host catalog projection is not an array' }
  const rows: SubagentProjectionRow[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') {
      return { ok: false, reason: 'a catalog row is not an object' }
    }
    const row = raw as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id === '') {
      return { ok: false, reason: 'a catalog row has no child id' }
    }
    if (row.mode !== 'external') {
      return { ok: false, reason: 'the catalog holds a native child this panel cannot navigate' }
    }
    if (row.createdAt !== undefined && typeof row.createdAt !== 'number') {
      return { ok: false, reason: 'a catalog row has an unexpected dispatch time' }
    }
    if (row.label !== undefined && typeof row.label !== 'string') {
      return { ok: false, reason: 'a catalog row has an unexpected label' }
    }
    // The catalog is append-only and unique per id; a duplicate is a host bug,
    // and drawing the same worker twice is worse than keeping the first.
    if (seen.has(row.id)) continue
    seen.add(row.id)
    rows.push({
      id: row.id,
      ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
      ...(row.label === undefined ? {} : { label: row.label }),
    })
  }
  return { ok: true, rows }
}

/** One row of the self-drawn list: a host catalog row joined with the plugin record. */
export interface SubagentPanelRow {
  childId: string
  /** `type · label`, falling back to the label, then the child id. */
  title: string
  status: SubagentStatus
  startedAt: number
  /** Terminal stamp, when the plugin recorded one. */
  endedAt?: number
  /** Last worker activity; absent for catalog-only rows (no record seen). */
  lastActivityAt?: number
  toolCalls: number
  /** The plugin knows this dispatch but the host catalog has not appended it yet. */
  pendingCatalog: boolean
}

/** How recently one duplicate record was updated; the fresher copy wins a de-dupe. */
function recordFreshness(record: SubagentRecord): number {
  return Math.max(record.lastActivityAt, record.endedAt ?? 0, record.startedAt)
}

/**
 * Join the host's catalog rows with this conversation's plugin records.
 *
 * `projection` is already validated ({@link readSubagentCatalogProjection}),
 * `records` is this conversation's list (`subagentRowsFor`). Output is newest
 * dispatch first, one row per `childId`:
 * - host row + record -> the record supplies status / timings / counters, the
 *   host supplies the fallback label and — authoritatively — `startedAt`;
 * - host row, no record -> `unknown` (a catalog fact from before the plugin
 *   recorded lifecycles; never painted as success);
 * - record, no host row -> shown and marked as pending the catalog append.
 */
export function subagentPanelRows(
  projection: readonly SubagentProjectionRow[],
  records: readonly SubagentRecord[],
): SubagentPanelRow[] {
  const byChild = new Map<string, SubagentRecord>()
  for (const record of records) {
    const prior = byChild.get(record.childId)
    if (prior === undefined || recordFreshness(record) > recordFreshness(prior)) {
      byChild.set(record.childId, record)
    }
  }
  const rows: SubagentPanelRow[] = []
  const seen = new Set<string>()
  for (const entry of projection) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    const record = byChild.get(entry.id)
    // The projection label wins when it says something; an empty one falls
    // back to the record's own fallback label.
    const label = entry.label !== undefined && entry.label.trim() !== ''
      ? entry.label
      : record?.label ?? ''
    rows.push({
      childId: entry.id,
      title: subagentTitle({ type: record?.type, label, childId: entry.id }),
      status: record?.status ?? 'unknown',
      // The host's dispatch time is the authority (plan §3.1); the record is
      // the fallback for a row whose projection value dropped it.
      startedAt: entry.createdAt ?? record?.startedAt ?? 0,
      ...(record?.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(record === undefined ? {} : { lastActivityAt: record.lastActivityAt }),
      toolCalls: record?.counts.toolCalls ?? 0,
      pendingCatalog: false,
    })
  }
  for (const record of byChild.values()) {
    if (seen.has(record.childId)) continue
    rows.push({
      childId: record.childId,
      title: subagentTitle(record),
      status: record.status,
      startedAt: record.startedAt,
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      lastActivityAt: record.lastActivityAt,
      toolCalls: record.counts.toolCalls,
      pendingCatalog: true,
    })
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * The trigger's whole sentence: cumulative dispatches, and the running count
 * only when something runs. Both halves are separate on purpose — the host's
 * "N subagents" conflated them, so a session that dispatched 11 workers over
 * two days read as 11 concurrent ones.
 */
export function subagentTriggerLabel(total: number, running: number, t: Translate): string {
  const totalText = t(`累计 ${total} 个`, `${total} total`)
  return running > 0 ? `${totalText} · ${t(`${running} 运行中`, `${running} running`)}` : totalText
}

/**
 * A row's "last activity" segment, or `undefined` when the row has no record
 * (a catalog-only history row never had an activity clock). Relative to `now`,
 * so an in-flight row's line keeps moving with its elapsed clock.
 */
export function subagentLastActivityLabel(
  lastActivityAt: number | undefined,
  now: number,
  t: Translate,
): string | undefined {
  if (lastActivityAt === undefined) return undefined
  const ago = formatSubagentDuration(Math.max(0, now - lastActivityAt))
  return t(`最后活动 ${ago} 前`, `last activity ${ago} ago`)
}

/** Where the dropdown sits, fixed to the viewport so the header cannot clip it. */
export interface SubagentMenuPlacement {
  left: number
  top: number
  width: number
}

/**
 * Place the dropdown under its trigger without crossing a viewport edge.
 * Pure so the geometry is testable; the component feeds it the trigger rect.
 */
export function placeSubagentMenu(
  trigger: { left: number; bottom: number },
  viewport: { width: number; height: number },
): SubagentMenuPlacement {
  const width = Math.max(0, Math.min(MENU_MAX_WIDTH, viewport.width - MENU_VIEWPORT_MARGIN * 2))
  const left = Math.min(
    Math.max(MENU_VIEWPORT_MARGIN, trigger.left),
    Math.max(MENU_VIEWPORT_MARGIN, viewport.width - width - MENU_VIEWPORT_MARGIN),
  )
  return { left, top: trigger.bottom + 5, width }
}

/** Render the host's own trigger with the original props (strip this module's additions). */
function renderHost(props: OwnSubagentCatalogProps) {
  const rest: Record<string, unknown> = { ...props }
  delete rest.host
  delete rest.onDiag
  delete rest.reason
  return createElement(props.host, rest)
}

/**
 * The fail-open branch for a host that hands the entry no `useSessions` hook.
 *
 * Its own component TYPE so the dispatcher above stays hook-free: whether the
 * prop is a function can flip between renders, and only a type change may
 * change the hooks React sees.
 */
function HostFallback(props: OwnSubagentCatalogProps & { reason: string }) {
  const { reason, onDiag } = props
  useEffect(() => {
    onDiag?.(`subagent catalog: ${reason}`)
  }, [onDiag, reason])
  return renderHost(props)
}

/**
 * One read-only row: six-state badge, name, elapsed time, last activity, tool
 * calls. The row is a BUTTON so the detail overlay is reachable by mouse and
 * by keyboard (Enter / Space) alike; opening the detail is the row's ONLY
 * gesture (no cancel / retry / spawn — the panel is read-only, AGENTS/ui.md §5).
 */
function SubagentPanelRowView(
  { row, now, t, onOpen }: { row: SubagentPanelRow; now: number; t: Translate; onOpen: (childId: string) => void },
) {
  const duration = formatSubagentDuration(subagentElapsedMs(row, now))
  const activity = subagentLastActivityLabel(row.lastActivityAt, now, t)
  const tools = t(`${row.toolCalls} 次工具调用`, `${row.toolCalls} tool calls`)
  const pending = row.pendingCatalog ? t('目录待同步', 'catalog pending') : undefined
  const openLabel = t(`查看 ${row.title} 的详情`, `Open details for ${row.title}`)
  return (
    <div className="ntr-acp-subagent-row" role="listitem" data-status={row.status} title={row.childId}>
      <button
        type="button"
        className="ntr-acp-subagent-row-button"
        aria-label={openLabel}
        onClick={() => { onOpen(row.childId) }}
      >
        <span className="ntr-acp-subagent-row-main">
          <span className={`ntr-acp-badge is-${subagentStatusTone(row.status)}`}>
            {subagentStatusLabel(row.status, t)}
          </span>
          <span className="ntr-acp-subagent-name">{row.title}</span>
        </span>
        <span className="ntr-acp-subagent-row-meta">
          <span>{duration}</span>
          {activity !== undefined && <span>· {activity}</span>}
          <span>· {tools}</span>
          {pending !== undefined && <span>· {pending}</span>}
        </span>
      </button>
    </div>
  )
}

/**
 * The ACP branch: the projection hook is called here, unconditionally, and
 * every other hook stays above every conditional return — so the panel can
 * fall back to the host component (or to nothing, for an empty catalog)
 * without ever changing its own hook count.
 */
function OwnCatalogProjection(props: OwnSubagentCatalogProps) {
  const useSessions = props.useSessions as SessionsHook
  const projections = useSessions(state => (state as { projectionsBySession?: unknown } | null | undefined)?.projectionsBySession)
  const ui = useUi(props.acp)
  const t: Translate = (zh, en) => props.acp.label(zh, en)
  const sessionId = String(props.sessionId ?? '')

  const snapshot = (projections as Record<string, unknown> | undefined)?.[sessionId] as
    | { values?: { subagentCatalog?: unknown } }
    | undefined
  const read = sessionId === ''
    ? { ok: false as const, reason: 'the host handed the entry no session id' }
    : readSubagentCatalogProjection(snapshot?.values?.subagentCatalog)
  const records = subagentRowsFor(Object.values(ui.subagents), sessionId)
  const rows = read.ok ? subagentPanelRows(read.rows, records) : []
  const reason = read.ok ? undefined : read.reason
  // Whether this panel has anything of its own to draw: a fail-open branch and
  // an empty list both render the host component / nothing. The menu must not
  // stay open across that change — its capture-phase Escape listener would
  // outlive the visible menu and keep swallowing the page's Escape.
  const served = reason === undefined && rows.length > 0

  // Tick the clocks once a second while something needs a moving label: an
  // in-flight row's elapsed clock (a silent running worker sends no record
  // frame), or the open menu's relative "last activity" line. The open menu
  // matters even after the last worker finished: a menu opened long after the
  // mount must measure from the open, not from the mount, or every row shows
  // mount-time ages and a row newer than the last tick reads "0s" forever.
  // An all-terminal list with the menu shut schedules no timer at all.
  const ticking = rows.some(row => isActiveSubagent(row.status))
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!ticking && !open) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, SUBAGENT_TICK_MS)
    return () => { clearInterval(timer) }
  }, [ticking, open])
  useEffect(() => {
    if (served) return
    setOpen(false)
  }, [served])

  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [placement, setPlacement] = useState<SubagentMenuPlacement | undefined>(undefined)
  // Fixed coordinates measured from the trigger: the header band may clip an
  // absolutely positioned child, and `position: fixed` escapes that clip.
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const trigger = triggerRef.current
      if (trigger === null) return
      setPlacement(placeSubagentMenu(trigger.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }))
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  const onDiag = props.onDiag
  useEffect(() => {
    if (reason !== undefined) onDiag?.(`subagent catalog: ${reason}`)
  }, [reason, onDiag])

  if (reason !== undefined) return renderHost(props)
  if (rows.length === 0) return null
  const running = subagentRunningCount(rows)
  const triggerText = subagentTriggerLabel(rows.length, running, t)
  // Opening the detail closes the dropdown first: its capture-phase Escape
  // listener would otherwise outlive the visible menu (under the overlay) and
  // swallow the first Escape meant for the dialog.
  const openDetail = (childId: string): void => {
    setOpen(false)
    openSubagentDetail(sessionId, childId)
  }
  return (
    <div className="ntr-acp-subagent-panel" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`ntr-acp-subagent-trigger${running > 0 ? ' is-running' : ''}`}
        aria-expanded={open}
        title={triggerText}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className="ntr-acp-subagent-dot" aria-hidden />
        <span className="ntr-acp-subagent-count">{triggerText}</span>
        <span className="ntr-acp-subagent-chevron" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div
          className="ntr-acp-subagent-menu"
          role="list"
          aria-label={t('子智能体列表', 'subagent list')}
          style={placement === undefined ? undefined : {
            left: placement.left,
            top: placement.top,
            width: placement.width,
          }}
        >
          {rows.map(row => (
            <SubagentPanelRowView key={row.childId} row={row} now={now} t={t} onOpen={openDetail} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Zero-hook dispatcher between the panel and the host component.
 *
 * The two branches are DIFFERENT component types: `useSessions` may be absent
 * on an older host, so a single component calling it conditionally would flip
 * its hook count and the slot's error boundary would retire the entry. The
 * dispatcher itself never calls a hook, so the swap is always legal.
 */
export function OwnSubagentCatalog(props: OwnSubagentCatalogProps) {
  ensureAcpStyle()
  // Last line of defence only: the claim refuses to install without a real
  // host component, so this cannot be reached through the gate.
  if (typeof props.host !== 'function') return null
  if (typeof props.useSessions !== 'function') {
    return createElement(HostFallback, {
      ...props,
      reason: 'the host entry has no useSessions hook',
    })
  }
  return createElement(OwnCatalogProjection, props)
}

// ---- The read-only detail overlay (Task 3b) ----
//
// Rows open this dialog; it renders what the plugin already knows — the
// lifecycle record (`UiState.subagents`) for the header, the bounded raw
// entries (`UiState.subagentDetails`) for the dispatch input and the worker
// stream. It is a VIEW: no cancel / retry / spawn / stop, no prompt input.
//
// The raw entries come from the store's dedicated index, NOT the folded ACP
// transcript: `foldUpdate` drops `_meta` and merges adjacent prose across
// workers, which would splice the parent turn's text into a worker's detail
// (plan §5.4). The index is fed by live frames and one on-demand
// `subagents/detail` read per page; the overlay never re-reads history on its
// own beyond that first open (the store's `loaded` flag is the gate).

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

/** The `toolCallId` behind an `acp:<toolCallId>` child id, or '' when it is not one. */
function dispatchToolCallId(childId: string): string {
  return childId.startsWith('acp:') ? childId.slice('acp:'.length) : ''
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
  const toolCallId = dispatchToolCallId(childId)
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

/** One-line form for payloads with no dedicated renderer (constraint 29). */
function compactDetailValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
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
function DetailEntryView({ entry, t }: { entry: SubagentDetailEntry; t: Translate }) {
  const line = describeSubagentDetailUpdate(entry.update)
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
  const loadsRef = useRef(new Map<string, Promise<void>>())

  // First open reads the bounded history once (`subagents/detail`). The store
  // owns the answered bit (`loaded`), so reopening a worker whose read landed
  // never asks again; a FAILED read leaves it retryable on the next open (the
  // store's documented contract). Re-entry while a read is in flight joins the
  // same promise instead of issuing a second RPC.
  useEffect(() => {
    if (target === null) return
    const id = subagentKey(target.dshSessionId, target.childId)
    if (acp.getSnapshot().subagentDetails[id]?.loaded === true) return
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
  // Seq order (the brief's contract). Stable for equal seq: the index's own
  // order breaks the tie (a replayed live frame lands after the host copy).
  const entries = detail === undefined ? [] : [...detail.entries].sort((a, b) => a.seq - b.seq)
  const dispatch = subagentDispatchDetail(entries, target.childId)
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
        <div className="ntr-acp-dialog-body">
          <div className="ntr-acp-subagent-detail-body">
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
            {dispatch?.rawInput !== undefined && (
              <div className="ntr-acp-subagent-detail-section">
                <div className="ntr-acp-subagent-detail-heading">{t('派遣入参', 'dispatch input')}</div>
                <pre className="ntr-acp-subagent-detail-pre">{formatDetailValue(dispatch.rawInput)}</pre>
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
              <div className="ntr-acp-subagent-detail-heading">{t('运行流', 'worker stream')}</div>
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
              {entries.length === 0
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
                : entries.map((entry, index) => (
                  <DetailEntryView key={`${String(entry.seq)}:${String(index)}`} entry={entry} t={t} />
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
