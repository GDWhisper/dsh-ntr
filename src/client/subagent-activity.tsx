/**
 * The ACP conversation's shadow of the host's subagent catalog trigger
 * (`conversation.session.header.actions`, list cell id `subagent-catalog`).
 *
 * WHY A SHADOW AT ALL: detached CodeBuddy workers are reported to the host's
 * durable subagent catalog as `mode: 'external'` rows (`acp:<toolCallId>`), and
 * an external child has no real host Session — so the host's catalog derives
 * every row's activity from its own status map / summaries keyed by that child
 * id, finds nothing, and paints the grey idle dot even while the worker runs.
 * The wire facts DO exist on this side (`subagents/update` frames behind
 * `store.activeSubagents`); this module hands them to the host's own component
 * instead of building a second catalog.
 *
 * HOW: same list-cell claim as `activity-pill.tsx` — take the cell with a
 * lower-priority entry of the SAME id, render the HOST's component, and give it
 * a substituted `useSessionStatus` that reports `running: true` for the live
 * ids. Trigger dot, per-row dot, aria labels and the dropdown are then all the
 * host's own; only the status the host reads changes. The host hard-codes
 * `completed = !external && …`, so only the ONGOING state is achievable for an
 * external row — no green "done" dot is attempted here.
 *
 * NON-ACP CONVERSATIONS PASS THROUGH. A list entry is projected into EVERY
 * session's header, so the wrapper renders the host component with the ORIGINAL
 * hook whenever `acpMode` is not affirmatively true or no id is active — making
 * it visually indistinguishable from the shipped entry there.
 *
 * FAIL-OPEN IS STRUCTURAL: a host without the entry (older build), a slot kind
 * change, or a missing component / inject / locale yields no claim at all and
 * the native entry keeps the cell exactly as shipped.
 */

import { createElement, useMemo } from 'react'
import type { ComponentType } from 'react'
// Type-only: pulls the conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useUi } from './acp-ui.tsx'
import type { AcpStore } from './store.ts'
import { createSeatClaim } from './model-seat.tsx'
import type { ModelSeatClaim, SeatEntry, SeatSlots } from './model-seat.tsx'

export const SUBAGENT_CATALOG_SLOT = 'conversation.session.header.actions'
export const SUBAGENT_CATALOG_ENTRY_ID = 'subagent-catalog'

/**
 * The host's own status map with the live external ids marked running.
 *
 * The substituted value matches the host's `SessionStatus`: `running` is the
 * only field the catalog reads, and the other two are present so a newer host
 * reading them does not see an undefined member. Without active ids the
 * ORIGINAL map is returned unchanged (same reference), which is what lets the
 * wrapper hand the untouched hook back instead of a needless wrapper.
 */
export function mergeSubagentStatuses<T>(
  statuses: ReadonlyMap<string, T>,
  active: readonly string[] | undefined,
): ReadonlyMap<string, T> {
  if (active === undefined || active.length === 0) return statuses
  const merged = new Map(statuses)
  for (const id of active) {
    merged.set(id, { running: true, pendingInteraction: undefined, completionUnread: false } as unknown as T)
  }
  return merged
}

/** The standard kit + injected face the shadow renders the host component with. */
interface SubagentCatalogHostProps {
  sessionId: unknown
  useSessionStatus?: unknown
  acp: AcpStore
  [key: string]: unknown
}

interface OccupantProps extends SubagentCatalogHostProps {
  host: ComponentType<Record<string, unknown>>
}

type StatusHook = (selector?: (value: unknown) => unknown) => unknown

function SubagentCatalogOccupant({ host: Host, ...props }: OccupantProps) {
  const ui = useUi(props.acp)
  const dshSessionId = String(props.sessionId)
  const hostStatus = props.useSessionStatus
  const active = ui.acpMode[dshSessionId] === true ? ui.activeSubagents?.[dshSessionId] : undefined
  const useSessionStatus = useMemo(() => {
    if (typeof hostStatus !== 'function' || active === undefined || active.length === 0) return hostStatus
    // The host calls this prop as a hook among its own. A zero-hook projector
    // would change the host component's hook COUNT the moment the active set
    // starts or stops being non-empty, and React rejects that on the same
    // mount ("Rendered fewer/more hooks…"). So the substituted hook always
    // calls the REAL hook itself: whether or not a worker is live, the host
    // runs exactly the same hooks, in the same order.
    const patched: StatusHook = selector => {
      const statuses = (hostStatus as StatusHook)((value: unknown) => value) as ReadonlyMap<string, unknown>
      const merged = mergeSubagentStatuses(statuses, active)
      return selector === undefined ? merged : selector(merged)
    }
    return patched
  }, [hostStatus, active])
  return createElement(Host, useSessionStatus === hostStatus ? props : { ...props, useSessionStatus })
}

function findHostCatalog(slots: SeatSlots): SeatEntry | undefined {
  try {
    if (slots.spec?.(SUBAGENT_CATALOG_SLOT)?.kind !== 'list') return undefined
    const heads = slots.entriesOfSlot?.(SUBAGENT_CATALOG_SLOT) ?? []
    return heads.find(entry => entry.options?.id === SUBAGENT_CATALOG_ENTRY_ID)
  } catch {
    return undefined
  }
}

export interface SubagentCatalogClaimOptions {
  slots: SeatSlots
  /** Session-scoped face factory (the gate's `chatFace`). */
  inject(sessionId: unknown, actions?: unknown): unknown
  onDiag?(line: string): void
  maxClaims?: number
}

/**
 * Take the header's `subagent-catalog` cell for one ACP-mode spell.
 *
 * Returns `undefined` on any host shape this bundle cannot serve (no entry, a
 * slot kind change, a missing component / inject / locale). The native trigger
 * is then left untouched; that is the honest failure mode.
 */
export function createSubagentCatalogClaim(options: SubagentCatalogClaimOptions): ModelSeatClaim | undefined {
  const host = findHostCatalog(options.slots)
  if (host === undefined
    || host.component === undefined
    || typeof host.inject !== 'function'
    || typeof host.locale !== 'string'
    || host.locale === '') {
    options.onDiag?.('subagent catalog: host entry not available')
    return undefined
  }
  const Host = host.component as ComponentType<Record<string, unknown>>
  return createSeatClaim({
    slots: options.slots,
    slotKey: SUBAGENT_CATALOG_SLOT,
    entryId: SUBAGENT_CATALOG_ENTRY_ID,
    order: host.options?.order,
    locale: host.locale,
    basePriority: -1,
    occupant: () => (props: Record<string, unknown>) => createElement(SubagentCatalogOccupant, {
      ...props,
      host: Host,
    } as unknown as OccupantProps),
    // The host entry's own face is `catalogActions(parentSessionId)`: it
    // supplies `openChild` / `openChildAside` / `refreshProjection`, and the
    // catalog rows stop navigating without them. Ours only adds `acp`.
    inject: (sessionId, actions) => ({
      ...(options.inject(sessionId, actions) as Record<string, unknown>),
      ...(host.inject?.(sessionId, actions) as Record<string, unknown> | undefined),
    }),
    label: 'subagent catalog',
    onDiag: options.onDiag,
    maxClaims: options.maxClaims ?? 1,
  })
}
