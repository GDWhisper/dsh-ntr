/**
 * The identity of one background drain (CodeBuddy's unsolicited multitask
 * run), as a single record per request id plus the three bounded id rings the
 * old containers kept.
 *
 * Stage 6 of `docs/plan/implicit-state-machines.md` replaced four crossing
 * structures on {@link LiveSession} — the ambient record, its notice de-dupe
 * set, the retired list and the consumed set — with this ledger. Every
 * function here is pure: it reads and writes only the ledger it is given,
 * never a manager, store or the session, so the module has no import cycle.
 *
 * The record's fields carry the four states the old structures could express
 * only in combination:
 * - `active`: this id owns the session's single ambient slot;
 * - `retiredAt`: the wait on it closed (silence, ceiling, hold, teardown);
 * - `consumedBy`: its answer was DELIVERED — by the user's turn or by an idle
 *   wake — so late frames stay transcript-only;
 * - `noticeSent`: the `agent/notice` for its announcement already went out.
 *
 * Retired and consumed are independent on purpose: a retired-but-unconsumed
 * drain may still wake the chat when it revives, while a revived drain that
 * was already consumed stays silent.
 */

/**
 * Who took a drain's answer. `'turn'` folded it into the user's own turn (the
 * run may still be speaking, so a later announcement of the id is that same
 * run); `'wake'` delivered it to the chat plane as its own message (the run is
 * over). Only `'wake'` can open a new generation — see `openDrainGeneration`.
 */
export type DrainConsumer = 'turn' | 'wake'

/**
 * How one wait closed. `'none'` means nothing was delivered (a zero-output
 * close), so a revived run must still be able to wake the chat. Explicit, not
 * an optional parameter: `undefined` would silently take the `'turn'` default.
 */
export type DrainDelivery = 'none' | DrainConsumer

/** One background drain's lifetime, keyed by its `codebuddy.ai/requestId`. */
export interface DrainRecord {
  requestId: string
  /** This id currently owns the session's ambient slot (at most one). */
  active: boolean
  startedAt: number
  lastActivityAt: number
  /** The run already streamed prose (text or thought) into the transcript. */
  sawOutput: boolean
  /** The `agent/notice` for this run already went out. */
  noticeSent: boolean
  /** When the wait on this run closed; absent = never retired. */
  retiredAt?: number
  /** Who delivered the run's answer; absent = nothing delivered, late frames
   *  may still wake the chat. */
  consumedBy?: DrainConsumer
}

/**
 * One session's drain bookkeeping. The `Map` is the truth; the three arrays
 * reproduce the old containers' capacity and eviction ORDER (oldest first),
 * which an ordering-free map cannot express. A record is dropped only when it
 * is inactive and none of the three rings names it.
 */
export interface DrainLedger {
  records: Map<string, DrainRecord>
  /** Retired ids, oldest first — bounded by {@link RETIRED_AMBIENT_MAX}. */
  retired: string[]
  /** Delivered ids, oldest first — bounded by {@link CONSUMED_DRAIN_MAX}. */
  consumed: string[]
  /** Announced ids whose notice went out, oldest first — bounded by {@link AMBIENT_NOTICE_MAX}. */
  notices: string[]
}

/**
 * Bound on the recorded notice de-dupe ring. It outlives individual turns (a
 * hard ceiling keeps the drain alive), so an announcement-heavy agent needs a
 * ceiling of its own; the oldest id is evicted first.
 */
export const AMBIENT_NOTICE_MAX = 64

/**
 * Bound on the retired ring. The ids only exist to catch a drain that speaks
 * again after its wait closed, and the timestamp lets the next silent close
 * recognise a recent fold — a short-horizon concern, so a small ring is enough.
 */
export const RETIRED_AMBIENT_MAX = 32

/** Bound on delivered ids: one per consumed answer. Oldest evicted first. */
export const CONSUMED_DRAIN_MAX = 64

export function createDrainLedger(): DrainLedger {
  return { records: new Map<string, DrainRecord>(), retired: [], consumed: [], notices: [] }
}

function ensure(ledger: DrainLedger, requestId: string, at: number): DrainRecord {
  const existing = ledger.records.get(requestId)
  if (existing !== undefined) return existing
  const record: DrainRecord = {
    requestId,
    active: false,
    startedAt: at,
    lastActivityAt: at,
    sawOutput: false,
    noticeSent: false,
  }
  ledger.records.set(requestId, record)
  return record
}

/** Move one id to the end of its ring and evict the oldest past `cap`. */
function ringPush(ring: string[], requestId: string, cap: number): void {
  const existing = ring.indexOf(requestId)
  if (existing >= 0) ring.splice(existing, 1)
  ring.push(requestId)
  while (ring.length > cap) ring.shift()
}

/** Drop a record only when it is inactive and no ring still names it. */
function prune(ledger: DrainLedger, record: DrainRecord): void {
  if (record.active) return
  if (ledger.retired.includes(record.requestId)) return
  if (ledger.consumed.includes(record.requestId)) return
  if (ledger.notices.includes(record.requestId)) return
  ledger.records.delete(record.requestId)
}

/** Re-derive the record flags from the rings after a ring eviction. */
function reconcile(ledger: DrainLedger): void {
  const retired = new Set(ledger.retired)
  const consumed = new Set(ledger.consumed)
  const notices = new Set(ledger.notices)
  for (const record of [...ledger.records.values()]) {
    if (record.retiredAt !== undefined && !retired.has(record.requestId)) record.retiredAt = undefined
    if (record.consumedBy !== undefined && !consumed.has(record.requestId)) record.consumedBy = undefined
    if (record.noticeSent && !notices.has(record.requestId)) record.noticeSent = false
    prune(ledger, record)
  }
}

/**
 * The map invariant: the ambient slot is single, so at most one record may be
 * active. Every mutator ends here — an inconsistent write must fail loudly.
 */
function assertAtMostOneActive(ledger: DrainLedger): void {
  let active = 0
  for (const record of ledger.records.values()) {
    if (record.active) active += 1
  }
  if (active > 1) throw new Error(`drain-record: ${String(active)} active drains, at most one is allowed`)
}

/** The record behind one request id, if the ledger still holds it. */
export function drainOf(ledger: DrainLedger | undefined, requestId: string | undefined): DrainRecord | undefined {
  if (ledger === undefined || requestId === undefined) return undefined
  return ledger.records.get(requestId)
}

/** The record that owns the session's ambient slot, if any. */
export function activeDrain(ledger: DrainLedger | undefined): DrainRecord | undefined {
  if (ledger === undefined) return undefined
  for (const record of ledger.records.values()) {
    if (record.active) return record
  }
  return undefined
}

/**
 * Remember a drain the session is waiting on. The ambient slot is single: any
 * previously active record is deactivated, exactly like the old code replacing
 * the session's one ambient record wholesale.
 */
export function startDrain(
  ledger: DrainLedger | undefined,
  requestId: string,
  startedAt: number,
  lastActivityAt: number,
  sawOutput: boolean,
): DrainLedger {
  const next = ledger ?? createDrainLedger()
  for (const record of next.records.values()) {
    if (!record.active) continue
    record.active = false
    prune(next, record)
  }
  const record = ensure(next, requestId, startedAt)
  record.active = true
  record.startedAt = startedAt
  record.lastActivityAt = lastActivityAt
  record.sawOutput = sawOutput
  assertAtMostOneActive(next)
  return next
}

/** Any update the run owns is evidence of life; prose also sets `sawOutput`. */
export function touchDrain(
  ledger: DrainLedger | undefined,
  requestId: string | undefined,
  lastActivityAt: number,
  sawOutput = false,
): void {
  if (ledger === undefined || requestId === undefined) return
  const record = ledger.records.get(requestId)
  if (record === undefined) return
  if (!record.active) throw new Error(`drain-record: touch on inactive drain ${requestId}`)
  record.lastActivityAt = lastActivityAt
  if (sawOutput) record.sawOutput = true
  assertAtMostOneActive(ledger)
}

/** The session stopped owning the ambient slot; the record itself may remain. */
export function stopDrain(ledger: DrainLedger | undefined, requestId: string | undefined): void {
  if (ledger === undefined || requestId === undefined) return
  const record = ledger.records.get(requestId)
  if (record === undefined) return
  record.active = false
  prune(ledger, record)
  assertAtMostOneActive(ledger)
}

/** The retired run spoke again: alive, not retired. `consumed` is untouched. */
export function reviveDrain(ledger: DrainLedger | undefined, requestId: string): void {
  if (ledger === undefined) return
  const record = ledger.records.get(requestId)
  if (record === undefined) return
  const index = ledger.retired.indexOf(requestId)
  if (index >= 0) ledger.retired.splice(index, 1)
  record.retiredAt = undefined
  prune(ledger, record)
}

/**
 * Bookkeeping only: the wait on this run closed. `delivery` is decided per
 * path by the caller and never re-derived here (see the five retire paths in
 * the plan): `'none'` = nothing was delivered, `'turn'` = a user turn folded the
 * answer, `'wake'` = an idle wake delivered it. The ambient slot is NOT
 * touched — a ceiling cut or a run switch keeps the run alive, so clearing the
 * slot is a separate {@link stopDrain} at the path that really ends it.
 * Re-retiring refreshes `retiredAt` and moves the id to the end of the ring
 * (the recency window `hasRecentRetiredDrain` reads).
 */
export function retireDrain(
  ledger: DrainLedger | undefined,
  requestId: string,
  retiredAt: number,
  delivery: DrainDelivery,
): DrainLedger {
  const next = ledger ?? createDrainLedger()
  ringPush(next.retired, requestId, RETIRED_AMBIENT_MAX)
  if (delivery !== 'none') ringPush(next.consumed, requestId, CONSUMED_DRAIN_MAX)
  const record = ensure(next, requestId, retiredAt)
  record.retiredAt = retiredAt
  if (delivery !== 'none') record.consumedBy = delivery
  reconcile(next)
  assertAtMostOneActive(next)
  return next
}

/** Record that the announcement notice for this run went out. */
export function markNotice(ledger: DrainLedger | undefined, requestId: string, at = Date.now()): DrainLedger {
  const next = ledger ?? createDrainLedger()
  ringPush(next.notices, requestId, AMBIENT_NOTICE_MAX)
  ensure(next, requestId, at).noticeSent = true
  reconcile(next)
  return next
}

/** Forget every notice de-dupe id (a lifecycle boundary keeps the rest). */
export function clearNotices(ledger: DrainLedger): DrainLedger {
  ledger.notices.length = 0
  for (const record of ledger.records.values()) record.noticeSent = false
  reconcile(ledger)
  return ledger
}

/** Whether this id names a drain the session already stopped waiting on. */
export function isRetiredDrain(ledger: DrainLedger | undefined, requestId: string | undefined): boolean {
  return drainOf(ledger, requestId)?.retiredAt !== undefined
}

/**
 * Whether a drain was retired recently enough that a prompt answered with no
 * ambient record and no conversation id may have been folded into it.
 */
export function hasRecentRetiredDrain(ledger: DrainLedger | undefined, withinMs: number, now = Date.now()): boolean {
  if (ledger === undefined) return false
  const cutoff = now - withinMs
  for (const record of ledger.records.values()) {
    if (record.retiredAt !== undefined && record.retiredAt >= cutoff) return true
  }
  return false
}

/** Whether this run's answer already reached a turn or the chat plane. */
export function isConsumedDrain(ledger: DrainLedger | undefined, requestId: string | undefined): boolean {
  return drainOf(ledger, requestId)?.consumedBy !== undefined
}

/**
 * A new unsolicited-turn announcement named an id whose answer an IDLE WAKE had
 * already delivered. CodeBuddy's `codebuddy.ai/requestId` is
 * conversation-request scoped, not run scoped: every drain of one user
 * request carries the same id, so the consumed mark set by the previous
 * drain's delivery would muzzle the whole new run (its frames would stay
 * transcript-only and the chat would never wake). The announcement is the
 * run boundary — the id starts a new generation: drop the consumed mark
 * AND the notice de-dupe so the new run is collected and announced like
 * the first one. The closed wait (`retiredAt`) stays — unless the retired ring
 * already evicted the id, in which case `reconcile` drops it too and the
 * caller's `startDrain` rebuilds the record; revive plus start re-open it
 * either way.
 *
 * ONLY a wake delivery ends a run. A turn fold does not — the run may still be
 * speaking, and a late re-announcement of it is the SAME run continuing, so it
 * stays transcript-only (a second wake would answer one run twice). Late frames
 * of ANY delivered run that arrive WITHOUT an announcement also keep the
 * consumed mark (see `reviveDrain`); only an announcement opens a generation.
 */
export function openDrainGeneration(ledger: DrainLedger | undefined, requestId: string): DrainLedger {
  const next = ledger ?? createDrainLedger()
  const record = next.records.get(requestId)
  if (record?.consumedBy !== 'wake') return next
  const consumedIndex = next.consumed.indexOf(requestId)
  if (consumedIndex >= 0) next.consumed.splice(consumedIndex, 1)
  const noticeIndex = next.notices.indexOf(requestId)
  if (noticeIndex >= 0) next.notices.splice(noticeIndex, 1)
  record.consumedBy = undefined
  record.noticeSent = false
  reconcile(next)
  assertAtMostOneActive(next)
  return next
}
