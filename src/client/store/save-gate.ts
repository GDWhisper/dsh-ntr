/**
 * The page-top save banners and the host save-gate readers: how banners compose
 * (failures persist, one transient success row), which agents a forced flush
 * would interrupt, and how two gate snapshots compare. Pure. Split out of
 * `src/client/store.ts` (split plan P3a), which re-exports it unchanged.
 */

import type { AgentView, DetectedAgentInfo, SaveGateOutcomeView, SaveGatePendingView, SaveGateStatus, SessionView } from "../../protocol.ts"

/**
 * One page-top save banner. Save failures, expiry, rejection, partial force
 * flushes and the HMR reload delay all share this shape so the overlay renders
 * (and screen readers announce) them the same way.
 */
export type SaveBannerSource =
  | 'save-failed'
  | 'save-expired'
  | 'save-rejected'
  | 'save-partial'
  | 'save-cancel-failed'
  | 'save-cancelled'
  | 'save-retry-none'
  | 'save-retry-failed'
  | 'hmr-delay'
  | 'save-succeeded'

export type SaveBannerAction = 'retry' | 'force' | 'dismiss'

export interface SaveBanner {
  /** Stable identity for dedupe: the same reason replaces, never stacks. */
  key: string
  source: SaveBannerSource
  level: 'error' | 'success'
  title: string
  body: string
  at: number
  actions: SaveBannerAction[]
  /** Which gate label the retry/force gesture targets, when applicable. */
  label?: string
  /** Success banners disappear on their own; failures persist until closed. */
  autoDismissMs?: number
  /**
   * Gate-sourced failure rows are rebuilt by a page refresh's resync; a row the
   * user explicitly closed must stay closed. Rows without this flag (direct save
   * failures, rejection/partial/HMR notices) never cross a refresh at all.
   */
  persistAcrossReload?: boolean
}

/**
 * Add or replace one banner. Failure rows are never dropped by count; only one
 * transient success row is kept among successes. A NEW failure does not evict
 * an existing success receipt: that row owns its own 2.5-second timer, and an
 * error arriving beside it must not cut that timer short.
 */
export function composeSaveBanners(existing: SaveBanner[], incoming: SaveBanner): SaveBanner[] {
  const withoutSame = existing.filter(banner => banner.key !== incoming.key)
  const base = incoming.level === 'success'
    ? withoutSame.filter(banner => banner.level !== 'success')
    : withoutSame
  return [...base, incoming]
}

/**
 * Whether the host actually runs the save gate. A snapshot without the field
 * (an older host, or a backend that never wired the gate) is NOT an idle
 * authority: its empty `activeSessions` must never be read as "no turn".
 */
export function saveGateIsAvailable(status: SaveGateStatus): boolean {
  return status.gateAvailable === true
}

/** `agent-save:<id>` → the agent id; a host-settings label (`settings:…`) → undefined. */
export function saveGateAgentId(label: string): string | undefined {
  const prefix = 'agent-save:'
  if (!label.startsWith(prefix)) return undefined
  const id = label.slice(prefix.length)
  return id === '' ? undefined : id
}

/** One agent a forced flush would interrupt, with the number of its live turns. */
export interface SaveGateInterruptTarget {
  agentId: string
  name: string
  sessions: number
}

/**
 * Which agents the "save everything now" gesture would interrupt, and how many
 * turns each owes. Reads the gate snapshot first; when it carries no session row
 * for an agent (an older host half, or a not-yet-hydrated window), the browser's
 * own session list supplies the same count — the fallback the settings form
 * already uses (`activeSessionsForSave`). This never assumes host fields beyond
 * `pending` / `activeSessions`; those are the snapshot's public shape.
 */
export function saveGateInterruptTargets(
  status: SaveGateStatus,
  agents: readonly AgentView[],
  detected: readonly DetectedAgentInfo[],
  sessions: readonly SessionView[],
): SaveGateInterruptTarget[] {
  const ids: string[] = []
  const add = (id: string): void => {
    if (!ids.includes(id)) ids.push(id)
  }
  for (const entry of status.pending) {
    const id = saveGateAgentId(entry.label)
    if (id !== undefined) add(id)
  }
  // A host-settings save still interrupts whoever is running: fall back to the
  // gate's own active-turn rows when no pending label names an agent.
  if (ids.length === 0) {
    for (const view of status.activeSessions ?? []) add(view.agentId)
  }
  const trustGate = saveGateIsAvailable(status)
  return ids.map(agentId => {
    let count = trustGate
      ? (status.activeSessions ?? []).filter(view => view.agentId === agentId).length
      : 0
    if (count === 0) {
      count = sessions.filter(session =>
        session.agentId === agentId && session.released !== true && (session.running || session.settled === true),
      ).length
    }
    return {
      agentId,
      name: agents.find(agent => agent.id === agentId)?.title
        ?? detected.find(info => info.id === agentId)?.name
        ?? agentId,
      sessions: count,
    }
  })
}

/** The terminal result naming one label, whichever snapshot shape carries it. */
export function saveGateOutcomeForLabel(
  status: SaveGateStatus,
  label: string,
): SaveGateOutcomeView | undefined {
  return status.lastOutcomes?.[label]
    ?? (status.lastOutcome?.label === label ? status.lastOutcome : undefined)
}

/** A `cancelled` row the host replaced with a newer queued snapshot. */
export function saveGateOutcomeSuperseded(outcome: SaveGateOutcomeView): boolean {
  return outcome.superseded === true
}

/** One terminal label transition, as seen between two gate snapshots. */
export interface SaveGateOutcomeTransition {
  label: string
  outcome: SaveGateOutcomeView
  /** The label was still queued in the previous snapshot. */
  wasPending: boolean
  /** The label is still queued in the new snapshot. */
  isPending: boolean
}

/**
 * Compare two gate snapshots. Pure: the SSE path and `resync` both feed this
 * so a page refresh rebuilds the terminal rows it missed. A terminal entry is
 * "new" when its timestamp or status changed; pending additions are reported
 * apart because only the caller knows whether that deserves a log line.
 */
export function saveGateTransitions(
  previous: SaveGateStatus | undefined,
  next: SaveGateStatus,
): { addedPending: SaveGatePendingView[]; outcomes: SaveGateOutcomeTransition[] } {
  const previousOutcomes: Record<string, SaveGateOutcomeView> = previous?.lastOutcomes
    ?? (previous?.lastOutcome === undefined ? {} : { [previous.lastOutcome.label]: previous.lastOutcome })
  const nextOutcomes: Record<string, SaveGateOutcomeView> = next.lastOutcomes
    ?? (next.lastOutcome === undefined ? {} : { [next.lastOutcome.label]: next.lastOutcome })
  const wasPending = new Set((previous?.pending ?? []).map(entry => entry.label))
  const isPending = new Set(next.pending.map(entry => entry.label))
  const addedPending = next.pending.filter(entry => !wasPending.has(entry.label))
  const outcomes: SaveGateOutcomeTransition[] = []
  for (const [label, outcome] of Object.entries(nextOutcomes)) {
    const before = previousOutcomes[label]
    if (before !== undefined && before.at === outcome.at && before.status === outcome.status) continue
    outcomes.push({ label, outcome, wasPending: wasPending.has(label), isPending: isPending.has(label) })
  }
  return { addedPending, outcomes }
}
