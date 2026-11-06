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
 * READ-ONLY IN THIS TASK. The list has no click-through, no cancel / retry /
 * spawn, and no fake controls; Task 3b adds the detail overlay. The old
 * `subagents/update` -> `activeSubagents` -> `mergeSubagentStatuses` path keeps
 * feeding the host component on the fail-open branch (Task 3c retires it).
 */

import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
// Type-only: pulls the conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import {
  formatSubagentDuration, isActiveSubagent, subagentElapsedMs, subagentRowsFor,
  subagentRunningCount, subagentStatusLabel, subagentStatusTone, subagentTitle, SUBAGENT_TICK_MS,
} from './acp-view.tsx'
import type { Translate } from './acp-view.tsx'
import type { AcpStore } from './store.ts'
import type { SubagentRecord, SubagentStatus } from '../protocol.ts'

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

/** One read-only row: six-state badge, name, elapsed time, last activity, tool calls. */
function SubagentPanelRowView({ row, now, t }: { row: SubagentPanelRow; now: number; t: Translate }) {
  const duration = formatSubagentDuration(subagentElapsedMs(row, now))
  const activity = subagentLastActivityLabel(row.lastActivityAt, now, t)
  const tools = t(`${row.toolCalls} 次工具调用`, `${row.toolCalls} tool calls`)
  const pending = row.pendingCatalog ? t('目录待同步', 'catalog pending') : undefined
  return (
    <div className="ntr-acp-subagent-row" role="listitem" data-status={row.status} title={row.childId}>
      <div className="ntr-acp-subagent-row-main">
        <span className={`ntr-acp-badge is-${subagentStatusTone(row.status)}`}>
          {subagentStatusLabel(row.status, t)}
        </span>
        <span className="ntr-acp-subagent-name">{row.title}</span>
      </div>
      <div className="ntr-acp-subagent-row-meta">
        <span>{duration}</span>
        {activity !== undefined && <span>· {activity}</span>}
        <span>· {tools}</span>
        {pending !== undefined && <span>· {pending}</span>}
      </div>
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

  // Tick the in-flight rows' clocks once a second (a silent running worker
  // sends no record frame); terminal rows freeze at their end stamp. Gated on
  // "any row still in flight", so an all-terminal list schedules no timer.
  const ticking = rows.some(row => isActiveSubagent(row.status))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, SUBAGENT_TICK_MS)
    return () => { clearInterval(timer) }
  }, [ticking])

  const [open, setOpen] = useState(false)
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

  const reason = read.ok ? undefined : read.reason
  const onDiag = props.onDiag
  useEffect(() => {
    if (reason !== undefined) onDiag?.(`subagent catalog: ${reason}`)
  }, [reason, onDiag])

  if (reason !== undefined) return renderHost(props)
  if (rows.length === 0) return null
  const running = subagentRunningCount(rows)
  const triggerText = subagentTriggerLabel(rows.length, running, t)
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
          {rows.map(row => <SubagentPanelRowView key={row.childId} row={row} now={now} t={t} />)}
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
