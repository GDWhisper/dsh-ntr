/**
 * Shared ledger and SSE replay builder for host-held human-input requests
 * (permissions and form elicitations).
 *
 * Keeps creation, lookup, validation-before-settle, bulk settlement on
 * cancel/close/release, pending-view snapshots, and reconnect replay frames in
 * one pure module so the two ask pipelines never drift.
 *
 * Pure logic only — no Node APIs, no ACP SDK runtime values.
 */

import { randomUUID } from '../ids.ts'
import type { AcpEvent } from '../protocol.ts'
import { AcpError } from './errors.ts'

export interface PendingRequestEntry<TFields, TOutcome> {
  requestId: string
  sessionId: string
  resolve: (outcome: TOutcome) => void
  /**
   * Ask view stored for reconnect replay (`pendingReplayFrames`). Absent on
   * entries created without a view — still answerable, just not re-shown.
   */
  view?: TFields
}

export interface PendingRequestLedgerOptions<TFields, TOutcome> {
  /** Human-readable request kind for `unknown_request` errors. */
  kind: string
  /** Outcome returned when `settleFor` cancels outstanding requests. */
  cancelOutcome: () => TOutcome
  /** Optional outcome normalizer/validator; runs before settling the entry. */
  normalizeOutcome?: (outcome: TOutcome, view: TFields | undefined) => TOutcome
}

export class PendingRequestLedger<TFields extends object, TOutcome> {
  private readonly pending = new Map<string, PendingRequestEntry<TFields, TOutcome>>()

  constructor(private readonly opts: PendingRequestLedgerOptions<TFields, TOutcome>) {}

  create(
    sessionId: string,
    executor: (outcome: TOutcome) => void,
    view?: TFields,
  ): string {
    const requestId = randomUUID()
    this.pending.set(requestId, {
      requestId,
      sessionId,
      resolve: executor,
      ...(view === undefined ? {} : { view }),
    })
    return requestId
  }

  respond(requestId: string, outcome: TOutcome): true {
    const entry = this.pending.get(requestId)
    if (entry === undefined) {
      throw new AcpError('unknown_request', `acp: no pending ${this.opts.kind} ${requestId}`)
    }
    const finalOutcome = this.opts.normalizeOutcome
      ? this.opts.normalizeOutcome(outcome, entry.view)
      : outcome
    this.pending.delete(requestId)
    entry.resolve(finalOutcome)
    return true
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  settleFor(predicate: (entry: { requestId: string; sessionId: string }) => boolean): string[] {
    const settled: string[] = []
    for (const [id, entry] of [...this.pending]) {
      if (!predicate(entry)) continue
      this.pending.delete(id)
      entry.resolve(this.opts.cancelOutcome())
      settled.push(id)
    }
    return settled
  }

  sessionIds(): Array<{ requestId: string; sessionId: string }> {
    return [...this.pending.values()].map(e => ({ requestId: e.requestId, sessionId: e.sessionId }))
  }

  hasPendingFor(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true
    }
    return false
  }

  pendingViews(): Array<{ requestId: string; sessionId: string } & TFields> {
    const views: Array<{ requestId: string; sessionId: string } & TFields> = []
    for (const entry of this.pending.values()) {
      if (entry.view === undefined) continue
      views.push({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        ...entry.view,
      })
    }
    return views
  }
}

/**
 * Build reconnect replay frames for any pending-request family: each pending
 * item built with the same frame builder as live broadcasts, terminated by a
 * `<kind>/synced` snapshot carrying live `requestIds`.
 */
export function pendingReplayFrames<TView extends { requestId: string }>(
  pending: readonly TView[],
  toRequestFrame: (view: TView) => AcpEvent,
  toSyncedFrame: (requestIds: string[]) => AcpEvent,
): AcpEvent[] {
  const requests = pending.map(toRequestFrame)
  return [...requests, toSyncedFrame(pending.map(item => item.requestId))]
}
