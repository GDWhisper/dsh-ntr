/**
 * Runtime state holders: the capped transcript, the event hub and the pending
 * permission ledger.
 *
 * Pure in the module-purity sense — no Node APIs, no ACP SDK — but they are the
 * mutable half of the host logic, driven by `AgentBridge` and read by the RPC
 * dispatcher.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it.
 */

import type { AcpEvent, PermissionOutcome } from '../protocol.ts'
import type { PendingPermissionFields } from './permission.ts'
import { PendingRequestLedger, type PendingRequestEntry } from './pending-request.ts'

// ---- Transcript ----

/**
 * The kind of a state-only tick that consecutive repeats may share one entry.
 *
 * These are the frames the client folds to nothing (`STATE_ONLY_UPDATES`):
 * only their latest value is ever read. `session_info_update` qualifies only
 * while it carries no title — a title is content the replay must keep, so it
 * never lets a later tick replace its entry.
 */
function coalescibleStateKind(update: unknown): string | undefined {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) return undefined
  const row = update as Record<string, unknown>
  const kind = row.sessionUpdate
  if (kind === 'usage_update' || kind === 'config_option_update') return kind
  if (kind !== 'session_info_update') return undefined
  const title = row.title
  return title === undefined || title === null || title === '' ? kind : undefined
}

/**
 * Bounded log of raw ACP session updates with monotone seq.
 *
 * Consecutive ticks of the same state-only kind share one entry (the entry is
 * replaced in place, not appended): chatty agents emit a usage / phase tick
 * every few hundred milliseconds, and letting each occupy the ring evicts the
 * conversation itself. This costs nothing on the live path — `append` still
 * allocates a fresh seq and the bridge broadcasts that frame — but replay via
 * `since` only sees the newest tick of each run.
 */
export class Transcript {
  private readonly entries: Array<{ seq: number; update: unknown }> = []
  private next = 1

  constructor(private readonly max: number) {}

  append(update: unknown): number {
    const seq = this.next++
    const last = this.entries[this.entries.length - 1]
    const kind = coalescibleStateKind(update)
    // Replace, don't push: `since(afterSeq)` keeps its filter, so intermediate
    // seq values are simply absent from replayed entries. Live SSE frames are
    // broadcast per append (the returned seq), and the client's live fold does
    // not depend on transcript contiguity — only `head` must keep advancing.
    if (kind !== undefined && last !== undefined && coalescibleStateKind(last.update) === kind) {
      this.entries[this.entries.length - 1] = { seq, update }
      return seq
    }
    this.entries.push({ seq, update })
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
    return seq
  }

  get head(): number {
    return this.next - 1
  }

  since(afterSeq: number): Array<{ seq: number; update: unknown }> {
    return this.entries.filter(e => e.seq > afterSeq)
  }
}

// ---- Event hub ----

export class EventHub {
  private readonly sinks = new Set<(event: AcpEvent) => void>()

  subscribe(sink: (event: AcpEvent) => void): () => void {
    this.sinks.add(sink)
    return () => { this.sinks.delete(sink) }
  }

  broadcast(event: AcpEvent): void {
    for (const sink of [...this.sinks]) {
      try {
        sink(event)
      } catch {
        // A broken subscriber must never stall protocol pumping.
      }
    }
  }
}


// ---- Permission ledger ----

export type PendingPermission = PendingRequestEntry<PendingPermissionFields, PermissionOutcome>

export class PermissionLedger extends PendingRequestLedger<PendingPermissionFields, PermissionOutcome> {
  constructor() {
    super({
      kind: 'permission',
      cancelOutcome: () => ({ outcome: 'cancelled' }),
    })
  }
}
