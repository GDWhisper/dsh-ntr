/**
 * The explicit lifecycle and turn slot of one live ACP session
 * (docs/plan/implicit-state-machines.md §6).
 *
 * A session record carries three deliberately ORTHOGONAL facts — `running`,
 * the host prompt slot and the agent-side settle gate — and one lifecycle:
 * `live` → `parked` (released, resumable through `session/load`) → `closed`
 * (being destroyed). `running` is NOT part of the lifecycle; an ambient drain
 * keeps it true while the session is live and its prompt slot is free.
 *
 * {@link TurnSlot} is the single value object for the other two: `promptHeld`
 * is the host's slot, the object's PRESENCE is the settle gate, and `turnSeq`
 * names the generation that owns both. This module imports TYPES only: no
 * manager, no store, no runtime dependency, so it can be used by every layer
 * (bridge services and the browser store) without a cycle. The projections
 * are pure; the `mark*` helpers own the lifecycle transitions and verify the
 * state they start from BEFORE mutating the record.
 */
import type { AcpReleaseCause } from '../protocol.ts'
import type { LiveSession } from './live-session.ts'

export type SessionLifecycle = 'live' | 'parked' | 'closed'

export interface SessionReleaseInfo {
  cause: AcpReleaseCause
  reason: string
  at: number
}

/**
 * The prompt slot + settle gate of the turn on air.
 *
 * The two facts are deliberately independent: an aborted turn releases
 * `promptHeld` at once while the gate (this object) stays claimed until the
 * agent acknowledges the cancel. They live in ONE value object because both
 * belong to the SAME turn generation — a superseded turn's late settler must
 * not clear a newer turn's slot.
 */
export interface TurnSlot {
  /** Resolves when the agent settled this turn (its response, or its cancel acknowledgement). */
  promise: Promise<void>
  /** The resolver of {@link promise}, kept so turn-scoped force finalization can open the gate. */
  resolve: () => void
  /** The `turnSeq` of the turn that owns this slot (monotonic; a resume does not clear it). */
  turnSeq: number
  /** Whether the HOST's prompt slot is still claimed by this turn. */
  promptHeld: boolean
}

/** The facts a lifecycle projection needs, shared by `LiveSession` and `SessionView`. */
export interface LifecycleFacts {
  /**
   * Absent only on records synthesized outside the bridge (hand-built test
   * fixtures): they behave like a freshly created live record.
   */
  readonly lifecycle?: SessionLifecycle
}

/** The membership test a released-record map provides. */
export interface SessionIdLookup {
  has(sessionId: string): boolean
}

/** The turn-slot facts (see {@link TurnSlot}). */
export interface TurnSlotFacts {
  readonly turnSlot?: TurnSlot
}

/**
 * `closed` and `released` are mutually exclusive (a parked record is
 * resumable, a closed one is being destroyed); every boundary enforces that,
 * so the lifecycle alone expresses both protocol fields.
 */
export function lifecycleOf(session: LifecycleFacts): SessionLifecycle {
  return session.lifecycle ?? 'live'
}

/** Whether a turn currently holds the agent prompt slot (exactly `promptHeld === true`). */
export function hasPromptSlot(session: TurnSlotFacts): boolean {
  return session.turnSlot?.promptHeld === true
}

/** Whether the agent has not acknowledged the turn yet (the settle gate is claimed). */
export function isSettling(session: TurnSlotFacts): boolean {
  return session.turnSlot !== undefined
}

/** The facts a freshly created session starts with: live, open, not parked. */
export function freshSessionFacts(): { lifecycle: SessionLifecycle } {
  return { lifecycle: 'live' }
}

/** Claim the prompt slot and open the settle gate for one turn generation. */
export function beginTurnSlot(session: LiveSession, turnSeq: number = session.turnSeq): TurnSlot {
  let resolve: () => void = () => { /* replaced below */ }
  const promise = new Promise<void>(r => { resolve = r })
  const slot: TurnSlot = { promise, resolve, turnSeq, promptHeld: true }
  session.turnSlot = slot
  return slot
}

/**
 * Release one turn's claim on the slot. Identity- and generation-guarded: a
 * superseded turn's late settler must not clear the slot a NEWER turn claimed.
 */
export function settleTurnSlot(session: LiveSession, slot: TurnSlot): void {
  if (session.turnSlot === slot && slot.turnSeq === session.turnSeq) session.turnSlot = undefined
  slot.resolve()
}

/** Release only the HOST's prompt slot (an abort, a close); the settle gate stays claimed. */
export function releasePromptSlot(session: LiveSession, turnSeq: number = session.turnSeq): void {
  const slot = session.turnSlot
  if (slot !== undefined && slot.turnSeq === turnSeq) slot.promptHeld = false
}

/**
 * Open a settle gate without owning the turn stream (a resume, a park, a force
 * reset). Generation-guarded: the gate of a NEWER turn is not this call's to open.
 */
export function openTurnSlot(session: LiveSession, turnSeq: number = session.turnSeq): void {
  const slot = session.turnSlot
  if (slot === undefined || slot.turnSeq !== turnSeq) return
  session.turnSlot = undefined
  slot.resolve()
}

/**
 * Throw unless `session` starts this transition from one of `allowed`. Checked
 * BEFORE the mutation: a check afterwards sees the NEW lifecycle already in
 * place, so it cannot protect the change it was meant to guard.
 */
function assertStartsFrom(session: LiveSession, allowed: readonly SessionLifecycle[]): void {
  const before = lifecycleOf(session)
  if (allowed.includes(before)) return
  throw new Error(
    `acp: session ${session.sessionId} cannot transition from lifecycle "${before}"; expected ${allowed.join(' / ')}`,
  )
}

/** Mark `session` live again (a resume that reached the agent). */
export function markLive(session: LiveSession): void {
  assertStartsFrom(session, ['parked'])
  session.lifecycle = 'live'
  session.releaseCause = undefined
  session.releaseReason = undefined
  session.releasedAt = undefined
}

/** Park `session` after verifying it was not already closed; register the resumable record. */
export function markParked(
  session: LiveSession,
  released: Map<string, LiveSession>,
  release?: SessionReleaseInfo,
): void {
  assertStartsFrom(session, ['live', 'parked'])
  session.lifecycle = 'parked'
  if (release !== undefined) {
    session.releaseCause = release.cause
    session.releaseReason = release.reason
    session.releasedAt = release.at
  }
  released.set(session.sessionId, session)
}

/**
 * Mark `session` closed (destroyed). A parked record whose entry was already
 * taken for a resume has no membership left, so closing it must succeed: the
 * parked entry is dropped, never demanded.
 */
export function markClosed(session: LiveSession, released: Map<string, LiveSession>): void {
  assertStartsFrom(session, ['live', 'parked'])
  session.lifecycle = 'closed'
  released.delete(session.sessionId)
}

/**
 * Throw when the explicit lifecycle contradicts released-record membership:
 * a parked record must be in the map and a live or closed one must not.
 */
export function assertLifecycle(session: LiveSession, releasedIds: SessionIdLookup): void {
  const parked = releasedIds.has(session.sessionId)
  if (session.lifecycle === 'parked' ? parked : !parked) return
  throw new Error(
    `acp: session ${session.sessionId} has lifecycle "${session.lifecycle}" but released=${String(parked)}`,
  )
}
