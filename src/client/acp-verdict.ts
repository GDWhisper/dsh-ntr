/**
 * The ACP-mode verdict one chat session's host half has handed down, as a
 * single value instead of the three containers it used to span (a value map, a
 * frame-settled set and an unsettled set).
 *
 * The rank between the members is the whole point: a committed
 * `agent-preset/selected` frame (`frame`) outranks a `session/chat-list` answer
 * (`host`), because the host's log read can lag a switch by one and a stale
 * answer would otherwise regress what the runtime already told us. An
 * `unsettled` marker remembers that a read came back WITHOUT a verdict, so the
 * seat gate can retract its one-shot ask and retry. No entry means "never
 * asked": unknown, never false.
 *
 * Pure functions over the book: no store, no clock, no I/O.
 */

export type AcpVerdict =
  | { kind: 'unsettled' }
  | { kind: 'host'; value: boolean }
  | { kind: 'frame'; value: boolean }

/** Verdicts by chat session id. An absent id is unknown. */
export type AcpVerdictBook = Map<string, AcpVerdict>

/**
 * Fold a `session/chat-list` answer. A plain read may only settle a session no
 * frame has spoken for; the gate's authorized re-ask passes a session a frame
 * DID settle, and that read updates the value while the frame keeps its
 * authority — otherwise a later composer read could regress the answer the
 * gate just learned.
 */
export function settleFromHost(book: AcpVerdictBook, dshSessionId: string, value: boolean): void {
  const current = book.get(dshSessionId)
  book.set(dshSessionId, current?.kind === 'frame' ? { kind: 'frame', value } : { kind: 'host', value })
}

/**
 * Fold a committed `agent-preset/selected` frame. Promotes the authority even
 * when the value is unchanged: the frame outranks every later plain read.
 */
export function commitFrame(book: AcpVerdictBook, dshSessionId: string, value: boolean): void {
  book.set(dshSessionId, { kind: 'frame', value })
}

/**
 * Record that a read came back without a verdict. It never displaces a verdict
 * we hold: the marker only exists to make the gate retry, and a held value
 * stays on screen while a transient host failure passes.
 */
export function markUnsettled(book: AcpVerdictBook, dshSessionId: string): void {
  if (book.has(dshSessionId)) return
  book.set(dshSessionId, { kind: 'unsettled' })
}

/**
 * Destructive query: consume an `unsettled` marker and answer `false`. Call
 * this ONLY from the gate's `hasAcpModeVerdict`; a read that settled through
 * `peekVerdict` and consumed here would eat the marker the gate needs to
 * retract its one-shot ask.
 */
export function consumeVerdict(book: AcpVerdictBook, dshSessionId: string): boolean {
  const verdict = book.get(dshSessionId)
  if (verdict === undefined) return false
  if (verdict.kind === 'unsettled') {
    book.delete(dshSessionId)
    return false
  }
  return true
}

/** Non-destructive read, for decisions that must not consume the marker. */
export function peekVerdict(book: AcpVerdictBook, dshSessionId: string): AcpVerdict | undefined {
  return book.get(dshSessionId)
}

/**
 * Drop the verdict a preset switch moved past — one session, or every one.
 * Deliberately asymmetric: an `unsettled` marker survives (the ask it refers
 * to is still unanswered and still worth retrying), and so does the ask
 * ledger, which lives outside this book.
 */
export function invalidateVerdict(book: AcpVerdictBook, dshSessionId?: string): void {
  if (dshSessionId === undefined) {
    for (const [id, verdict] of book) if (verdict.kind !== 'unsettled') book.delete(id)
    return
  }
  const verdict = book.get(dshSessionId)
  if (verdict !== undefined && verdict.kind !== 'unsettled') book.delete(dshSessionId)
}

/** The per-session value record the UI reads (`UiState.acpMode`). */
export function projectAcpMode(book: AcpVerdictBook): Record<string, boolean> {
  const acpMode: Record<string, boolean> = {}
  for (const [id, verdict] of book) if (verdict.kind !== 'unsettled') acpMode[id] = verdict.value
  return acpMode
}
