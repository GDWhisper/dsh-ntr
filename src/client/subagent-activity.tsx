/**
 * The ACP conversation's header cell for the host's subagent catalog trigger
 * (`conversation.session.header.actions`, list cell id `subagent-catalog`):
 * the claim that takes the cell, and the branch that keeps ordinary
 * conversations on the host's own component.
 *
 * THE CELL. Detached CodeBuddy workers are reported to the host's durable
 * subagent catalog as `mode: 'external'` rows (`acp:<toolCallId>`), and an
 * external child has no real host Session. The host's own trigger therefore
 * cannot paint them correctly. This module takes the cell with a
 * lower-priority entry of the SAME id (the same list-cell claim as
 * `activity-pill.tsx`) and decides who renders inside it — see the split
 * below.
 *
 * THE SPLIT (two component TYPES, never a conditional hook):
 * - ACP conversation (`acpMode` affirmatively true) -> {@link OwnSubagentCatalog}
 *   from `subagent-panel.tsx`, the plugin's self-drawn trigger + read-only list
 *   fed by the host's `subagentCatalog` projection and the plugin's own
 *   six-state records;
 * - everything else -> the HOST component with its original props, visually
 *   indistinguishable from the shipped entry.
 *
 * NON-ACP CONVERSATIONS PASS THROUGH. A list entry is projected into EVERY
 * session's header, so the occupant renders the host component whenever
 * `acpMode` is not affirmatively true — making it visually indistinguishable
 * from the shipped entry there.
 *
 * FAIL-OPEN IS STRUCTURAL: a host without the entry (older build), a slot kind
 * change, or a missing component / inject / locale yields no claim at all and
 * the native entry keeps the cell exactly as shipped.
 */

import { createElement } from 'react'
import type { ComponentType } from 'react'
// Type-only: pulls the conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useUi } from './acp-ui.tsx'
import type { AcpStore } from './store.ts'
import { createSeatClaim } from './model-seat.tsx'
import type { ModelSeatClaim, SeatEntry, SeatSlots } from './model-seat.tsx'
import { OwnSubagentCatalog } from './subagent-panel.tsx'
import type { OwnSubagentCatalogProps } from './subagent-panel.tsx'

export const SUBAGENT_CATALOG_SLOT = 'conversation.session.header.actions'
export const SUBAGENT_CATALOG_ENTRY_ID = 'subagent-catalog'

/**
 * The standard kit + injected face the shadow renders the host component with.
 *
 * `useSessionStatus` is part of the host's kit and is passed through untouched:
 * the plugin no longer substitutes it (the host's status map never described
 * an external row, and the self-drawn panel reads the plugin's own records).
 */
interface SubagentCatalogHostProps {
  sessionId: unknown
  useSessionStatus?: unknown
  acp: AcpStore
  [key: string]: unknown
}

interface OccupantProps extends SubagentCatalogHostProps {
  host: ComponentType<Record<string, unknown>>
  /** The claim's diagnostic line: the self-drawn panel reports every fail-open reason here. */
  onDiag?: (line: string) => void
}

function SubagentCatalogOccupant({ host: Host, onDiag, ...props }: OccupantProps) {
  const ui = useUi(props.acp)
  const dshSessionId = String(props.sessionId)
  const acpMode = ui.acpMode[dshSessionId] === true
  // TWO COMPONENT TYPES: React unmounts one and mounts the other, so each
  // keeps a fixed hook count. A conditional hook inside one component would
  // flip the count on the ACP-mode verdict and the slot's error boundary would
  // abdicate the whole entry.
  return acpMode
    ? createElement(OwnSubagentCatalog, { ...props, host: Host, onDiag } as unknown as OwnSubagentCatalogProps)
    : createElement(Host, props)
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
 * Whether a `subagent catalog` diagnostic must reach the production console.
 *
 * The claim's own verdicts keep the shared failure-keyword filter, and the
 * ordinary older-host "host entry not available" stays silent (no entry means
 * the native trigger is simply still there). The self-drawn panel's fail-open
 * reasons — a projection that is not an array, a missing `useSessions` hook, a
 * native child it cannot navigate, no session id, an unexpected row shape —
 * match none of those keywords, so the whole `subagent catalog:` prefix is
 * accepted: a fail-open nobody can see in the console is exactly the silent
 * failure this filter must not have.
 */
export function subagentCatalogDiagIsWorthWarn(line: string): boolean {
  if (line === 'subagent catalog: host entry not available') return false
  if (line.startsWith('subagent catalog: ')) return true
  return /failed|missing|taken|gave up|still held/.test(line)
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
      ...(options.onDiag === undefined ? {} : { onDiag: options.onDiag }),
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
