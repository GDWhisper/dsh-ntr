/**
 * The composer dock's `x轮x步 · xx tok/s` pill on an ACP conversation.
 *
 * WHY SHADOW INSTEAD OF A SECOND PILL: the host's `ActivityPill` already states
 * the two things this conversation has — turn/step counts and a whole-session
 * decode speed — in the one place a speed belongs. Only its speed is wrong for
 * ACP: the host divides the tokens a step emitted by `firstTokenTime →
 * completedTime`, and that window contains every tool wait. Rendering a second
 * speed beside it would leave two numbers on screen and no way to tell which
 * is the honest one. So this module takes the host pill's own cell (`list` slot
 * `conversation.composer.dock`, id `activity`) at a lower priority, renders the
 * HOST's component, and hands it a patched `sessionStats` whose decode fields
 * are the plugin's burst aggregate. Style, counts, dialog, aria and locale stay
 * the host's; only the number changes.
 *
 * NON-ACP CONVERSATIONS PASS THROUGH. The shadow is installed only while the
 * gate confirms the staged conversation runs the ACP preset, but a list entry
 * is projected into EVERY session's composer. The wrapper therefore renders the
 * host component with the ORIGINAL projection whenever `acpMode` is not
 * affirmatively true, making the shadow visually indistinguishable from the
 * shipped entry there.
 *
 * FAIL-OPEN IS STRUCTURAL: if the host entry, its inject face, its locale or
 * its `performanceUsage` source is missing, no claim is created and the native
 * pill stays exactly as shipped. If the host component rejects the patched
 * projection, the slot's error boundary retires this entry and the native
 * `activity` entry wins again. No CSS hiding and no DOM patching are involved.
 */

import { createElement, useMemo } from 'react'
import type { ComponentType } from 'react'
// Type-only: pulls the conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionBurst } from '../protocol.ts'
import { useUi } from './acp-ui.tsx'
import type { AcpStore, UiState } from './store.ts'
import { createSeatClaim } from './model-seat.tsx'
import type { ModelSeatClaim, SeatEntry, SeatSlots } from './model-seat.tsx'

export const DOCK_SLOT = 'conversation.composer.dock'
export const ACTIVITY_ENTRY_ID = 'activity'

type ActivityProjection = (key: string, selector?: (value: unknown) => unknown) => unknown
type ActivityPerformanceHook = (selector?: (value: unknown) => unknown) => unknown
type ActivityTranslate = (key: string, params?: Record<string, unknown>) => string

/** The standard kit + injected face the shadow renders the host component with. */
export interface ActivityPillHostProps {
  sessionId: string
  useChat: unknown
  useProjection: ActivityProjection
  usePerformanceUsage: ActivityPerformanceHook
  t?: ActivityTranslate
  acp: AcpStore
}

interface OccupantProps extends ActivityPillHostProps {
  host: ComponentType<Record<string, unknown>>
}

/**
 * The aggregate the dock should show: the sum of every ACP session backing this
 * chat (the host pill's counts are whole-chat too), with a live `turn/metrics`
 * entry preferred per session over its persisted row. `undefined` means "no
 * measurable burst yet" — the wrapper then hides the speed instead of showing
 * the host's tool-inclusive number.
 */
export function activityBurst(
  ui: Pick<UiState, 'chatSessions' | 'chatSessionsFor' | 'burstStats'>,
  dshSessionId: string,
): SessionBurst | undefined {
  if (ui.chatSessionsFor !== dshSessionId) return undefined
  let outputTokens = 0
  let burstMs = 0
  for (const row of ui.chatSessions) {
    const measured = ui.burstStats[row.sessionId] ?? row.burst
    if (measured === undefined) continue
    outputTokens += measured.outputTokens
    burstMs += measured.burstMs
  }
  return outputTokens > 0 && burstMs > 0 ? { outputTokens, burstMs } : undefined
}

/**
 * Replace ONLY the decode half of the host's session stats.
 *
 * `decodeTokens` and `decodeMs` are the two fields the host's `decodeSpeed`
 * reads (`decodeTokens / (decodeMs / 1000)`), so writing the plugin's aggregate
 * there makes the host's own formatter, dialog row and aria label display the
 * plugin's burst rate. Every other field — turns, steps, LLM/tool/TTFT — stays
 * host-native. With no measurable burst the two decode fields are zeroed: the
 * host then hides the speed (`decodeMs > 0` guard) while keeping the counts.
 */
export function patchedActivityStats(
  native: Record<string, unknown> | undefined,
  burst: SessionBurst | undefined,
  acp: boolean,
): Record<string, unknown> | undefined {
  if (!acp || native === undefined) return native
  if (burst !== undefined && burst.outputTokens > 0 && burst.burstMs > 0) {
    return { ...native, decodeTokens: burst.outputTokens, decodeMs: burst.burstMs }
  }
  return { ...native, decodeTokens: 0, decodeMs: 0 }
}

function ActivityPillOccupant({ host: Host, ...props }: OccupantProps) {
  const ui = useUi(props.acp)
  const dshSessionId = String(props.sessionId)
  const acpMode = ui.acpMode[dshSessionId] === true
  const native = props.useProjection('sessionStats') as Record<string, unknown> | undefined
  const burst = acpMode ? activityBurst(ui, dshSessionId) : undefined
  const stats = useMemo(
    () => patchedActivityStats(native, burst, acpMode),
    [native, burst?.outputTokens, burst?.burstMs, acpMode],
  )
  // The current host pill reads exactly one projection. Returning `undefined`
  // for another key keeps the wrapper from claiming support it has not been
  // taught; a future host that asks for more will abdicate to the native entry.
  const projection = useMemo<ActivityProjection>(
    () => (key, selector) => {
      if (key !== 'sessionStats') return undefined
      return selector === undefined ? stats : selector(stats)
    },
    [stats],
  )
  return createElement(Host, {
    useChat: props.useChat,
    useProjection: acpMode ? projection : props.useProjection,
    usePerformanceUsage: props.usePerformanceUsage,
    t: props.t,
  })
}

function findHostActivity(slots: SeatSlots): SeatEntry | undefined {
  try {
    if (slots.spec?.(DOCK_SLOT)?.kind !== 'list') return undefined
    const heads = slots.entriesOfSlot?.(DOCK_SLOT) ?? []
    return heads.find(entry => entry.options?.id === ACTIVITY_ENTRY_ID)
  } catch {
    return undefined
  }
}

export interface ActivityPillClaimOptions {
  slots: SeatSlots
  /** Session-scoped face factory (the gate's `chatFace`). */
  inject(sessionId: unknown, actions?: unknown): unknown
  onDiag?(line: string): void
  maxClaims?: number
}

/**
 * Take the dock's `activity` cell for one ACP-mode spell.
 *
 * Returns `undefined` on any host shape this bundle cannot serve — an older
 * host without the `activity` entry (0.1.5 ships `stats`), a slot kind change,
 * a missing inject/locale, or no `performanceUsage` source. The native pill is
 * then left untouched; that is the honest failure mode, not a hidden control.
 */
export function createActivityPillClaim(options: ActivityPillClaimOptions): ModelSeatClaim | undefined {
  const host = findHostActivity(options.slots)
  if (host === undefined
    || host.component === undefined
    || typeof host.inject !== 'function'
    || typeof host.locale !== 'string'
    || host.locale === '') {
    options.onDiag?.('activity pill: host entry not available')
    return undefined
  }
  let performanceUsage: unknown
  try {
    const face = host.inject() as { hooks?: { performanceUsage?: unknown } } | undefined
    performanceUsage = face?.hooks?.performanceUsage
  } catch {
    performanceUsage = undefined
  }
  if (performanceUsage === undefined) {
    options.onDiag?.('activity pill: host performance hook missing')
    return undefined
  }
  const Host = host.component as ComponentType<Record<string, unknown>>
  return createSeatClaim({
    slots: options.slots,
    slotKey: DOCK_SLOT,
    entryId: ACTIVITY_ENTRY_ID,
    order: host.options?.order ?? 0,
    locale: host.locale,
    basePriority: -1,
    occupant: () => (props: Record<string, unknown>) => createElement(ActivityPillOccupant, {
      ...props,
      host: Host,
    } as unknown as OccupantProps),
    inject: (sessionId, actions) => ({
      ...(options.inject(sessionId, actions) as Record<string, unknown>),
      hooks: { performanceUsage },
    }),
    label: 'activity pill',
    onDiag: options.onDiag,
    maxClaims: options.maxClaims ?? 1,
  })
}
