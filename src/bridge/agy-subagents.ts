/**
 * Antigravity dispatch recognition and lifecycle tracking (tasks 1–2 of
 * docs/plan/antigravity-subagent-panel.md).
 *
 * agy's ACP wire reports NO subagent lifecycle: the dispatch is an ordinary
 * `invoke_subagent` tool call (title / rawInput are the only evidence — no
 * CodeBuddy `_meta` key exists on this wire), and its COMPLETED result only
 * says the child was CREATED, carrying the brain conversationId. No
 * completion frame ever arrives: this tracker owns the wire states —
 * `pending` (dispatch seen) → `running` (creation result parsed) — and hands
 * every live dispatch to the transcript poll (`AgySubagentPollService`),
 * which drives `completed` / `unknown` from the child's and parent's
 * transcripts. Teardown (`SubagentService.terminalizeSessionDispatches`)
 * still ends whatever the poll has not.
 *
 * Rows reuse the `BackgroundDispatch` shape but live in their OWN session map
 * (`LiveSession.agyDispatches`): the CodeBuddy tracker must never see them
 * (it would read the creation result's `completed` as worker completion), and
 * agy rows must not enter the detached-worker hold — an agy child is always
 * off-turn. The idle clock counts them through its own agy branch.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { SubagentRecord, SubagentStatus } from '../protocol.ts'
import { updateContentToText } from '../impl.ts'
import { parseAgyConversationId } from './agy-transcript.ts'
import { dispatchRecord, pruneSessionDispatches } from './dispatch-shape.ts'
import { agyDispatchInputOf, subagentDispatchLabel } from './shape.ts'
import type { LiveSession } from './turn-stream.ts'
import type { BackgroundDispatch } from './types.ts'

/** What the tracker needs from its owning service, injected. */
export interface AgySubagentHost {
  /** Record rows; announce / persist only on state transitions (shared rule). */
  noteRecords(records: readonly SubagentRecord[], options: { announce: boolean; persist: boolean }): void
  /** Hand one child to the host catalog; false leaves it unclaimed for a retry. */
  reportCatalog(session: LiveSession, childId: string, label: string): boolean
  /**
   * Ensure transcript polling for one LIVE dispatch (idempotent). Absent when
   * no poll wiring was provided; the wire states still work without it.
   */
  poll?(session: LiveSession, dispatch: BackgroundDispatch): void
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Where one agy dispatch stands. Deliberately NOT `dispatchStatus`: that
 * shortcut reads `detached` as running evidence (CodeBuddy's `isBackground`
 * re-send proves the worker runs), while agy's running proof is the parsed
 * conversationId — `detached` is true from creation on this wire.
 */
export function agyDispatchStatus(dispatch: BackgroundDispatch): SubagentStatus {
  if (dispatch.terminal !== undefined) return dispatch.terminal
  return dispatch.childConversationId === undefined ? 'pending' : 'running'
}

export class AgySubagentTracker {
  constructor(private readonly host: AgySubagentHost) {}

  /**
   * Session-level bookkeeping for one `session/update`, with or without a
   * turn controller: the creation result may land after the dispatching turn
   * closed (measured ~5s after the call), and only this level still sees it.
   */
  track(session: LiveSession, update: SessionUpdate): void {
    // History replay is not a live dispatch. agy's own replay marker is
    // unknown, so the in-flight load window is the only signal (fail-open:
    // missing a record beats re-recording history as new work).
    if (session.loadingHistory === true) return
    const raw = update as Record<string, unknown>
    const kind = String(raw.sessionUpdate ?? '')
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return
    const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId.trim() : ''
    if (toolCallId === '') return
    const dispatches = session.agyDispatches ??= new Map<string, BackgroundDispatch>()
    const known = dispatches.get(toolCallId)
    const now = Date.now()
    if (known !== undefined) {
      known.lastActivityAt = now
      known.counts.updates += 1
      // A terminal row is history: a late frame only moves the counters, it
      // never rewrites the ending (the CodeBuddy late-completion rule).
      if (known.terminal !== undefined) return
      const status = typeof raw.status === 'string' ? raw.status : ''
      if (status !== '') known.status = status
      if (known.childConversationId === undefined && raw.content !== undefined) {
        const text = typeof raw.content === 'string' ? raw.content : updateContentToText(raw.content)
        const childId = parseAgyConversationId(text)
        if (childId !== undefined) known.childConversationId = childId
      }
      this.refreshLabel(known, raw)
      this.reportCatalog(session, known)
      this.sync(session, known)
      // Idempotent: a later frame retries a child tail whose file appeared.
      this.host.poll?.(session, known)
      return
    }
    // Creation only on the dispatch's own opening frame: a stray update with
    // no known id is no evidence a dispatch began (fail-open, transcript-only).
    if (kind !== 'tool_call') return
    const input = agyDispatchInputOf(raw)
    if (input === undefined) return
    const type = nonEmpty(input.TypeName) ?? nonEmpty(input.Role)
    const dispatch: BackgroundDispatch = {
      toolCallId,
      status: typeof raw.status === 'string' ? raw.status : '',
      // The creation result is NOT a completion: `completed` stays false for
      // the whole life of an agy dispatch; only teardown writes a terminal.
      completed: false,
      // agy children always run off-turn. The flag records that wire fact;
      // it is never a hold request (agy rows stay out of the hold's map).
      detached: true,
      sawWorkerUpdate: false,
      catalogLabel: subagentDispatchLabel(raw),
      catalogLabelIdentified: nonEmpty(input.Role) !== undefined || nonEmpty(input.TypeName) !== undefined,
      catalogReported: false,
      startedAt: now,
      lastActivityAt: now,
      ...(type === undefined ? {} : { subagentType: type }),
      counts: { updates: 1, toolCalls: 0, textChars: 0 },
    }
    dispatches.set(toolCallId, dispatch)
    pruneSessionDispatches(dispatches)
    // A cancel terminalizes only THIS turn's dispatch ids: register ours too.
    session.turnController?.noteTurnDispatch(toolCallId)
    // Creation is announced HERE, not behind `catalogReported` (the CodeBuddy
    // rule): a row the host catalog never accepted must still reach the panel.
    this.sync(session, dispatch)
    this.reportCatalog(session, dispatch)
    // The poll covers pending dispatches too: one whose creation result never
    // lands still ends `unknown` past the silence ceiling.
    this.host.poll?.(session, dispatch)
  }

  /**
   * Memory-only record refresh from the transcript poll (activity / counters
   * moved, no wire frame). Announces + persists ONLY on a status transition,
   * which polling alone never produces — the shared transitions-only rule.
   */
  refresh(session: LiveSession, dispatch: BackgroundDispatch): void {
    this.sync(session, dispatch)
  }

  /**
   * Write the terminal state onto every unfinished agy dispatch of a session
   * going away (close / release / force reset / process death), or of a turn
   * the user cancelled / that failed (`onlyIds`), or of ONE dispatch the
   * transcript poll finished (`completed` / `unknown`, a single-id set).
   * Returns the rows to announce + persist; the caller batches them with the
   * CodeBuddy rows so one teardown is one state-file write.
   */
  terminalize(session: LiveSession, status: 'completed' | 'cancelled' | 'unknown', onlyIds?: ReadonlySet<string>): SubagentRecord[] {
    const dispatches = session.agyDispatches
    if (dispatches === undefined) return []
    const dshSessionId = session.dshSessionId
    const now = Date.now()
    const records: SubagentRecord[] = []
    for (const dispatch of dispatches.values()) {
      if (onlyIds !== undefined && !onlyIds.has(dispatch.toolCallId)) continue
      if (dispatch.terminal !== undefined) continue
      dispatch.terminal = status
      dispatch.endedAt = now
      dispatch.reportedStatus = status
      if (dshSessionId !== undefined) records.push(dispatchRecord(dispatch, dshSessionId))
    }
    return records
  }

  /** Take a better label from a later frame until the catalog accepted it. */
  private refreshLabel(dispatch: BackgroundDispatch, raw: Record<string, unknown>): void {
    if (dispatch.catalogReported) return
    const input = agyDispatchInputOf(raw)
    const identified = input !== undefined
      && (nonEmpty(input.Role) !== undefined || nonEmpty(input.TypeName) !== undefined)
    if (!identified && dispatch.catalogLabelIdentified) return
    const title = raw.title
    if (!identified && !(typeof title === 'string' && title !== '')) return
    dispatch.catalogLabel = subagentDispatchLabel(raw)
    dispatch.catalogLabelIdentified = identified
    if (dispatch.subagentType === undefined && input !== undefined) {
      const type = nonEmpty(input.TypeName) ?? nonEmpty(input.Role)
      if (type !== undefined) dispatch.subagentType = type
    }
  }

  /** One catalog fact per dispatch, once the wire declared the child's identity. */
  private reportCatalog(session: LiveSession, dispatch: BackgroundDispatch): void {
    if (dispatch.catalogReported || !dispatch.catalogLabelIdentified) return
    if (this.host.reportCatalog(session, `acp:${dispatch.toolCallId}`, dispatch.catalogLabel)) {
      dispatch.catalogReported = true
    }
  }

  /** Announce + persist ONLY on status transitions (creation included). */
  private sync(session: LiveSession, dispatch: BackgroundDispatch): void {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const status = agyDispatchStatus(dispatch)
    const transition = dispatch.reportedStatus !== status
    if (transition) dispatch.reportedStatus = status
    this.host.noteRecords(
      [{ ...dispatchRecord(dispatch, dshSessionId), status }],
      { announce: transition, persist: transition },
    )
  }
}
