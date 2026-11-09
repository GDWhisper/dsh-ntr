/**
 * Subagent lifecycle records and background-report wake-ups, owned outside
 * `BridgeManager` (see AGENTS/protocol.md §6.2 / §6.3).
 *
 * Two related bookkeeping duties live here because they share the same inputs
 * (the session-level `session/update` stream) and the same output (state rows
 * plus one chat wake):
 * - detached / synchronous worker dispatches → `subagents` records;
 * - an IDLE CodeBuddy drain's prose → one report, delivered to the chat plane.
 *
 * The service never imports the manager: every capability it needs (broadcast
 * hub, live sessions, the state-file write and the ambient windows) arrives
 * through {@link SubagentHost}.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { EventHub } from '../impl.ts'
import {
  boundSubagentDetailEntry,
  capSubagentRecords,
  normalizeSubagentRecordMap,
  randomUUID,
  subagentToolCallId,
} from '../impl.ts'
import type { SubagentDetailEntry, SubagentDetailResult, SubagentRecord } from '../protocol.ts'
import { MAX_SUBAGENT_DETAIL_ENTRIES } from '../protocol.ts'
import {
  BACKGROUND_REPORT_FORM,
  BACKGROUND_REPORT_MAX,
  BACKGROUND_REPORT_SOURCE,
  BACKGROUND_WAKE_TEXT,
} from './registries.ts'
import { chunkTextOf, codebuddyMetaOf, retireAmbientId } from './turn-stream.ts'
import type { LiveSession } from './turn-stream.ts'
import type { BackgroundDispatch, BackgroundReport, DshAgentLike, SubagentCatalogReporter } from './types.ts'
import { subagentDispatchDeclaresIdentity, subagentDispatchLabel } from './shape.ts'
import { dispatchRecord, dispatchStatus, pruneSessionDispatches, refreshSubagentDispatchLabel } from './dispatch-shape.ts'
import { describeError } from './errors.ts'

/** What the subagent service needs from the bridge manager, injected. */
export interface SubagentHost {
  /** Broadcast channel for `subagents/record` rows and wake notices. */
  readonly hub: EventHub
  /** Read-only view of the live sessions (detail reads walk their transcripts). */
  sessions(): Iterable<LiveSession>
  /** Rewrite `agents.json`: records persist on state transitions only. */
  persistAgents(): void
  /** The ambient quiet / ceiling windows (see `BridgeTuning.ambientQuietMs`). */
  ambientTuning(): { quietMs: number; maxMs: number }
}

export class SubagentService {
  /**
   * The plugin's OWN lifecycle records for external (ACP-dispatched) workers,
   * keyed by DSH chat session and capped at `MAX_SUBAGENT_RECORDS` rows per
   * conversation. The host's `subagentCatalog` projection stays the list
   * SKELETON (persisted membership); this map supplies what it cannot —
   * status, failure reason, timings and counts. Persisted under `agents.json`'s
   * `subagents` key on state transitions only.
   */
  private readonly records = new Map<string, SubagentRecord[]>()
  private catalogReporter?: SubagentCatalogReporter
  private dshAgentResolver?: (dshSessionId: string) => DshAgentLike | undefined

  constructor(private readonly host: SubagentHost) {}

  /** Wire the host's external-worker catalog (see `setSubagentCatalogReporter`). */
  setCatalogReporter(reporter?: SubagentCatalogReporter): void {
    this.catalogReporter = reporter
  }

  /** Wire the host's chat-agent lookup used by an idle drain wake. */
  setDshAgentResolver(resolver?: (dshSessionId: string) => DshAgentLike | undefined): void {
    this.dshAgentResolver = resolver
  }

  /**
   * Collect an IDLE drain's prose (see {@link LiveSession.backgroundReport}).
   *
   * Prose is collected only while no turn controller owns the session: a
   * steered prompt and a `backgroundHoldWorkerPhase` hold both consume the
   * drain inside their own bubble, and a second delivery would duplicate the
   * answer. The quiet clock is the ambient one — the drain has no end frame
   * (the SDK drops `session_end`), so its silence is the end.
   *
   * EVERY frame of the collected run is evidence of life and restarts that
   * clock (protocol.md §6.2: any `session/update` resets the quiet timer) — an
   * empty chunk, a thought tick, a tool frame — not just message prose. A run
   * that OPENED a tool call it never reported `completed` / `failed` for is
   * still answering: the quiet timer must not wake a half-report while a tool
   * outlives the window (the tail would then be eaten by `consumedDrains`).
   * The real wire sends a tool's completion frame with NO `_meta` at all, so
   * the close is recognised by `toolCallId` alone (the dispatch-completion
   * convention); worker frames (`parentToolCallId`) never count.
   *
   * ONE record per run: a frame of a DIFFERENT run (the drain that announced
   * itself while this one waited) closes the current record out in place and
   * opens a fresh one — two runs' prose never mix, and each run's id is
   * retired on ITS OWN delivery.
   */
  trackBackgroundDrainText(session: LiveSession, update: SessionUpdate): void {
    const raw = update as Record<string, unknown>
    const meta = codebuddyMetaOf(raw)
    // History replay is not a live drain: collecting its prose would arm a
    // quiet timer and wake the chat with a ghost report after the resume.
    if (meta?.historyReplay === true || session.loadingHistory === true) return
    // A worker's own frame names its parent call: it is the worker's report,
    // not the parent's drained answer (the real wire gives it another
    // requestId, but an agent that tags both must not leak into this report).
    // Its tool calls are the worker's own and never block the quiet close.
    if (meta?.parentToolCallId !== undefined) return
    const kind = String(raw.sessionUpdate ?? '')
    const requestId = meta?.requestId
    // This run already delivered its answer (a closed wait, a hold, or an
    // earlier idle wake). Its late frames are transcript-only: reviving it
    // must not answer the same drain twice.
    if (requestId !== undefined && session.consumedDrains?.has(requestId) === true) return
    const ambient = session.ambient
    if (ambient === undefined) return
    const toolCallId = typeof raw.toolCallId === 'string' && raw.toolCallId !== '' ? raw.toolCallId : undefined
    // A BARE completion of a call THIS run opened is the run's frame even with
    // no `_meta` (see the doc above).
    const trackedTool = toolCallId !== undefined
      && (kind === 'tool_call' || kind === 'tool_call_update')
      && session.backgroundReport?.openToolCalls.has(toolCallId) === true
    if (requestId !== ambient.requestId && !(requestId === undefined && trackedTool)) return

    // Ownership confirmed. A RUN SWITCH (this frame's run is the session's new
    // ambient, while the record collects the old one) closes the old record
    // out in place: its collection is over — waiting can only cut the report
    // at the same place later — so deliver it now and give the new run a fresh
    // record. Reports never span two runs.
    let report = session.backgroundReport
    if (report !== undefined && requestId !== undefined && report.requestId !== ambient.requestId) {
      this.deliverBackgroundReport(session, report, true)
      report = undefined
    }
    if (report === undefined) {
      const now = Date.now()
      report = {
        requestId: ambient.requestId,
        text: '',
        lastAt: now,
        firstAt: now,
        delivered: false,
        openToolCalls: new Set<string>(),
      }
      session.backgroundReport = report
    }
    // Tool-call bookkeeping (see the doc above): ONLY `completed` / `failed`
    // close a call. Everything else — the opening `tool_call`, an unknown
    // status like `running`, or a status-less `tool_call_update` — opens it or
    // keeps it open. "Unknown = unclosed" is the safe side: a call the quiet
    // check wrongly passes wakes with HALF a report, while an over-open call
    // merely defers the wake to the `ambientMaxMs` cut (which says so).
    if (toolCallId !== undefined && (kind === 'tool_call' || kind === 'tool_call_update')) {
      const status = typeof raw.status === 'string' ? raw.status : ''
      if (status === 'completed' || status === 'failed') report.openToolCalls.delete(toolCallId)
      else report.openToolCalls.add(toolCallId)
    }
    // Prose collection is idle-only (see the doc above); every frame of the
    // run — this one included — still restarts the quiet clock below.
    if (kind === 'agent_message_chunk'
      && session.turnController === undefined
      && !session.running
      && session.promptInFlight !== true) {
      const text = chunkTextOf((raw as { content?: unknown }).content)
      if (text !== '') {
        report.text += text
        if (report.text.length > BACKGROUND_REPORT_MAX) {
          report.text = `${report.text.slice(0, BACKGROUND_REPORT_MAX)}\n[truncated by dsh-ntr: background report exceeded ${String(BACKGROUND_REPORT_MAX)} characters]`
        }
      }
    }
    report.lastAt = Date.now()
    this.armReportTimer(session, report)
  }

  /**
   * Session-level bookkeeping for CodeBuddy's detached workers and background
   * drains. Runs for EVERY `session/update`, with or without a turn controller:
   * a worker that finishes after its dispatching turn CLOSED must still move
   * its record, and the idle clock must see the pending work.
   *
   * The wire shape is unchanged from the turn-level version:
   * - the dispatch call's own frames (matched by id, completion carries no
   *   `_meta`) move status / counters and may mark it `detached`;
   * - `parentToolCallId` frames are the worker's own turn: evidence of life
   *   (`sawWorkerUpdate`), never the dispatch record's `_meta` identity;
   * - `unsolicitedTurn` names the drain that will carry the report.
   */
  trackSessionBackgroundDispatch(session: LiveSession, update: SessionUpdate): void {
    const raw = update as Record<string, unknown>
    const meta = codebuddyMetaOf(raw)
    // History replay is not live work. CodeBuddy's `session/load` re-sends
    // every historical Agent dispatch as a pending `tool_call` plus an
    // in_progress `tool_call_update` — NEVER a terminal frame — so tracking it
    // would rebuild finished workers as running and overwrite the restored
    // records. Two signals identify the replay: the agent's own history marker
    // (catches frames even if they land after the response) and the in-flight
    // load window (agents without the marker; the spec puts the whole replay
    // before the response). Only lifecycle bookkeeping skips — the frames
    // still fold into the transcript through the normal update path.
    if (meta?.historyReplay === true || session.loadingHistory === true) return
    const kind = String(raw.sessionUpdate ?? '')
    const row = raw as { toolCallId?: unknown; status?: unknown }
    const toolCallId = typeof row.toolCallId === 'string' ? row.toolCallId.trim() : ''
    const status = typeof row.status === 'string' ? row.status : ''
    const completedStatus = status === 'completed' || status === 'failed'
    const now = Date.now()
    const type = typeof meta?.subagentType === 'string' && meta.subagentType !== '' ? meta.subagentType : undefined
    const dispatches = session.backgroundDispatches ??= new Map<string, BackgroundDispatch>()
    if ((kind === 'tool_call' || kind === 'tool_call_update') && toolCallId !== '') {
      // A terminal tool frame may arrive WITHOUT `parentToolCallId` (the real
      // completion shape): close that id in every dispatch's table by id.
      if (completedStatus) {
        for (const dispatch of dispatches.values()) dispatch.openWorkerToolCalls?.delete(toolCallId)
      }
      const known = dispatches.get(toolCallId)
      if (known !== undefined) {
        // A known dispatch: the id is the whole evidence (see the doc above).
        known.lastActivityAt = now
        known.counts.updates += 1
        if (type !== undefined && known.subagentType === undefined) known.subagentType = type
        if (status !== '') known.status = status
        const justCompleted = completedStatus && !known.completed
        if (justCompleted) {
          known.completed = true
          // The worker finished: no tool call of its own turn can still be open.
          known.openWorkerToolCalls?.clear()
          // A terminal state already written (cancelled / unknown) is never
          // overwritten by a late completion: the row keeps the ending that
          // actually happened, and the late frame only stops further counting.
          if (known.terminal === undefined) {
            known.terminal = status === 'failed' ? 'failed' : 'completed'
            known.endedAt = now
            if (status === 'failed' && raw.content !== undefined) known.error = raw.content
          }
        }
        if (!known.catalogReported) refreshSubagentDispatchLabel(known, raw)
        if (meta?.isBackground === true) {
          known.detached = true
          this.reportSubagentDispatch(session, known)
        }
        this.syncDispatchRecord(session, known)
        // Every frame of a known dispatch is evidence its worker still works:
        // the worker phase is SILENCE-based, so a live hold must not time out.
        session.turnController?.onBackgroundDispatchFrame()
        if (justCompleted) {
          // Last chance for a row still waiting on identity: completion is a
          // fact even when the agent never said more than the tool name.
          this.reportSubagentDispatch(session, known)
          this.noteSessionDispatchProgress(session)
        }
      } else if (meta !== undefined
        && (meta.toolName === 'Agent' || meta.toolName === 'Task')
        && (kind === 'tool_call' || meta.isBackground === true)) {
        const dispatch: BackgroundDispatch = {
          toolCallId,
          status,
          completed: completedStatus,
          detached: meta.isBackground === true,
          sawWorkerUpdate: false,
          catalogLabel: subagentDispatchLabel(raw),
          catalogLabelIdentified: subagentDispatchDeclaresIdentity(raw),
          catalogReported: false,
          startedAt: now,
          lastActivityAt: now,
          ...(completedStatus
            ? {
                terminal: status === 'failed' ? 'failed' as const : 'completed' as const,
                endedAt: now,
                ...(status === 'failed' && raw.content !== undefined ? { error: raw.content } : {}),
              }
            : {}),
          ...(type === undefined ? {} : { subagentType: type }),
          counts: { updates: 1, toolCalls: 0, textChars: 0 },
        }
        dispatches.set(toolCallId, dispatch)
        pruneSessionDispatches(dispatches)
        // A hold may only wait for work THIS turn handed out; a worker left
        // over from an earlier turn is not this turn's drain.
        session.turnController?.noteTurnDispatch(toolCallId)
        // Creation is a state entering the record, announced HERE — not behind
        // `catalogReported`: a row the host catalog never accepted must still
        // reach the browser ("目录待同步").
        this.syncDispatchRecord(session, dispatch)
        session.turnController?.onBackgroundDispatchFrame()
        if (dispatch.detached) this.reportSubagentDispatch(session, dispatch)
      }
    }
    if (meta?.parentToolCallId !== undefined) {
      const parent = dispatches.get(meta.parentToolCallId)
      if (parent !== undefined) {
        // The worker's own tool calls: an OPEN one is the long-tier evidence
        // the idle clock reads (`hasPendingBackgroundWork`). Completed / failed
        // closes it; an update with no status carries no news (same rule as
        // the main turn's `activeToolCalls`).
        const openTools = parent.openWorkerToolCalls ??= new Map<string, number>()
        if (toolCallId !== '' && (kind === 'tool_call' || kind === 'tool_call_update')) {
          if (status === 'completed' || status === 'failed') openTools.delete(toolCallId)
          else if (status === 'pending' || status === 'in_progress') openTools.set(toolCallId, openTools.get(toolCallId) ?? now)
          else if (kind === 'tool_call') openTools.set(toolCallId, now)
        }
        session.turnController?.onWorkerToolCall(kind, toolCallId, status)
        parent.lastActivityAt = now
        parent.counts.updates += 1
        if (kind === 'tool_call') parent.counts.toolCalls += 1
        else if (kind === 'agent_message_chunk') parent.counts.textChars += chunkTextOf(raw.content).length
        if (type !== undefined && parent.subagentType === undefined) parent.subagentType = type
        // `parentToolCallId` proves the worker alive, NOT that it runs detached:
        // CodeBuddy tags a SYNCHRONOUS subagent's child updates the same way.
        parent.sawWorkerUpdate = true
        this.reportSubagentDispatch(session, parent)
        this.syncDispatchRecord(session, parent)
        // The worker's own prose / tool frames are evidence of work too.
        session.turnController?.onBackgroundDispatchFrame()
      }
    }
    if (meta?.unsolicitedTurn !== undefined) {
      session.turnController?.onBackgroundDrainAnnounced(meta.unsolicitedTurn.requestId)
    }
  }

  /**
   * Hand one detached worker to the host catalog. Returns whether a reporter
   * handled it; a missing chat id or reporter leaves the dispatch unclaimed so
   * a later wire update can retry.
   */
  reportSubagentCatalog(session: LiveSession, childId: string, label: string): boolean {
    const dshSessionId = session.dshSessionId
    const reporter = this.catalogReporter
    if (dshSessionId === undefined || reporter === undefined) return false
    try {
      reporter(dshSessionId, childId, label)
      return true
    } catch {
      return false
    }
  }

  /**
   * Record external-worker lifecycle rows for one conversation.
   *
   * The in-memory copy is replaced on EVERY call — `lastActivityAt` and
   * `counts` move with the worker's frames. A `subagents/record` frame goes out
   * only when the caller says the status changed (creation included), and the
   * state file is rewritten once for the batch on the same transitions.
   * `agents.json` is a synchronous full-file write, so a call per worker chunk
   * would stall the host; the caller enforces that split.
   */
  noteSubagentRecords(records: readonly SubagentRecord[], options: { announce: boolean; persist: boolean }): void {
    for (const record of records) {
      const list = this.records.get(record.dshSessionId) ?? []
      const at = list.findIndex(row => row.childId === record.childId)
      // The cap only has work to do when a NEW row arrives (an existing row is
      // replaced in place, so the length cannot grow past the cap).
      const next = at < 0
        ? capSubagentRecords([...list, record])
        : list.map((row, index) => (index === at ? record : row))
      this.records.set(record.dshSessionId, next)
      if (options.announce) {
        this.host.hub.broadcast({ type: 'subagents/record', dshSessionId: record.dshSessionId, record })
      }
    }
    if (options.persist) this.host.persistAgents()
  }

  /**
   * Terminalize every unfinished dispatch of a SESSION that goes away
   * (close / release / force reset / process death), or of a turn the user
   * cancelled / that failed. A normal stop is not one of these: its worker may
   * still be running (see `LiveSession.backgroundDispatches`).
   */
  terminalizeSessionDispatches(
    session: LiveSession,
    status: 'cancelled' | 'unknown',
    onlyIds?: ReadonlySet<string>,
  ): void {
    const dispatches = session.backgroundDispatches
    const dshSessionId = session.dshSessionId
    if (dispatches === undefined) return
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
    if (records.length === 0) return
    this.noteSubagentRecords(records, { announce: true, persist: true })
  }

  /**
   * The plugin's own lifecycle records for one conversation. Empty for a
   * conversation that never dispatched a worker; the panel joins this with the
   * host's catalog projection by `childId` (a catalog row with no record reads
   * `unknown`, never succeeded).
   */
  subagentsFor(dshSessionId: string): SubagentRecord[] {
    return [...(this.records.get(dshSessionId) ?? [])]
  }

  /**
   * The stored rows as the caller found them — the chat-session view attaches
   * them by reference, so a fresh copy would only churn memory.
   */
  recordsFor(dshSessionId: string): readonly SubagentRecord[] | undefined {
    return this.records.get(dshSessionId)
  }

  /** The persisted shape for `agents.json`; keys follow insertion order. */
  persistedRecords(): Record<string, SubagentRecord[]> {
    return this.records.size === 0 ? {} : Object.fromEntries(this.records)
  }

  /**
   * Read the persisted records back, dropping orphan keys FIRST (see
   * `loadPersistedSubagents`): only a conversation the caller still knows can
   * own records, and keeping the rest would only make `agents.json` grow.
   */
  restore(raw: unknown, keepSessionIds: ReadonlySet<string>): void {
    this.records.clear()
    if (raw === undefined) return
    for (const [dshSessionId, rows] of Object.entries(normalizeSubagentRecordMap(raw, keepSessionIds))) {
      this.records.set(dshSessionId, rows)
    }
  }

  /** Drop every record of one host conversation (close / stop paths). */
  forget(dshSessionId: string): void {
    this.records.delete(dshSessionId)
  }

  /**
   * Raw transcript entries for ONE external worker — the detail view's
   * on-demand read. Two filters, BOTH needed: the dispatch's own frames
   * (`toolCallId === <dispatch id>`, which is where the raw input and the
   * terminal frame live) and the worker's frames
   * (`_meta.parentToolCallId === <dispatch id>`). Released sessions keep
   * serving their retained buffers. Bounded: the newest
   * `MAX_SUBAGENT_DETAIL_ENTRIES` entries, each raw payload cut at
   * `ACP_TOOL_RAW_MAX` with a marker — never silently.
   */
  subagentsDetail(dshSessionId: string, childId: string): SubagentDetailResult {
    const toolCallId = subagentToolCallId(childId)
    if (toolCallId === '') return { entries: [] }
    const matched: SubagentDetailEntry[] = []
    for (const session of this.host.sessions()) {
      // A closed session is destroyed, not merely unreachable; released ones
      // still hold the transcript the user is reading.
      if (session.dshSessionId !== dshSessionId || session.closed) continue
      for (const entry of session.transcript.since(0)) {
        const update = entry.update as Record<string, unknown>
        const meta = codebuddyMetaOf(update)
        if (update.toolCallId !== toolCallId && meta?.parentToolCallId !== toolCallId) continue
        matched.push(boundSubagentDetailEntry(entry.seq, entry.update))
      }
    }
    if (matched.length <= MAX_SUBAGENT_DETAIL_ENTRIES) return { entries: matched }
    return {
      entries: matched.slice(-MAX_SUBAGENT_DETAIL_ENTRIES),
      omitted: matched.length - MAX_SUBAGENT_DETAIL_ENTRIES,
    }
  }

  /**
   * (Re-)arm one report's quiet timer — always against ITS record, never
   * `session.backgroundReport`, which a newer run may already own.
   */
  private armReportTimer(session: LiveSession, report: BackgroundReport): void {
    if (report.timer !== undefined) clearTimeout(report.timer)
    report.timer = setTimeout(() => {
      report.timer = undefined
      this.deliverBackgroundReport(session, report)
    }, this.host.ambientTuning().quietMs)
    report.timer.unref?.()
  }

  /**
   * Hand one collected idle drain to the chat plane as a real turn.
   *
   * A conversation turn that came on air while the report waited gets the
   * report retried instead of a second bubble — its controller folds the drain
   * itself. A tool call the run left OPEN waits for its close frame: waking on
   * the quiet timer inside a long tool would answer with half a report and
   * lose the rest to the consumed-id table. Past the ambient ceiling the wait
   * is CUT and what was collected is delivered with a truncation marker (the
   * transcript keeps the rest) — never deferred or dropped forever.
   *
   * `settleNow` (a run switch closed this record's collection) never defers:
   * waiting cannot grow the report. The decision happens in place — deliver,
   * or drop transcript-only (id NOT consumed, so a revived run may still
   * answer) when a turn is on air and could fold this very run.
   *
   * Every path acts on THIS record (never `session.backgroundReport`, which a
   * newer run may already own). One report = one wake: the delivery commits
   * BEFORE the hand-off, so a host that throws or rejects — synchronously or
   * asynchronously — leaves the exact same outcome (record gone, id consumed,
   * one `agent/notice`, zero wake); a re-delivery is the one thing that must
   * never happen, and the answer is in the transcript either way.
   */
  private deliverBackgroundReport(session: LiveSession, report: BackgroundReport, settleNow = false): void {
    if (report.delivered) return
    // The turn that folded this drain already delivered the answer (its quiet
    // close marked the id consumed). Waking now would answer the same run twice.
    if (report.requestId !== undefined && session.consumedDrains?.has(report.requestId) === true) {
      this.dropBackgroundReport(session, report)
      return
    }
    if (session.closed || session.released) {
      this.dropBackgroundReport(session, report)
      return
    }
    if (report.text.trim() === '') {
      // Nothing was ever delivered: do NOT consume the id — the run may revive
      // and its real answer must still be able to wake the chat.
      this.dropBackgroundReport(session, report)
      return
    }
    const busy = session.turnController !== undefined || session.running || session.promptInFlight === true
    const waitingOnTool = !settleNow && report.openToolCalls.size > 0
    let cut = false
    if (busy || waitingOnTool) {
      if (settleNow) {
        // The run switch closed this report's collection while a turn is on
        // air: delivering now risks a double answer (the turn may be folding
        // this very run), and waiting can no longer grow the report. Stay
        // transcript-only WITHOUT consuming the id — the run may revive.
        this.dropBackgroundReport(session, report)
        return
      }
      if (Date.now() - report.firstAt < this.host.ambientTuning().maxMs) {
        this.armReportTimer(session, report)
        return
      }
      // The ambient ceiling cut the wait (a conversation still busy, or a tool
      // that never closed): deliver what was collected and say it was cut —
      // never wait forever, never drop the answer silently.
      report.text = `${report.text}\n[truncated by dsh-ntr: the background report hit its ambient ceiling while the run was still active; the remaining output is in the ACP transcript view]`
      cut = true
    }
    const agent = this.wakeAgentFor(session)
    if (agent === undefined) {
      // No host chat agent YET (`/acp` RPC, headless deployment, or a resolver
      // the host mounts late): retry on the quiet timer within the ambient
      // bound — the record keeps its full text, so a late-mounted agent still
      // gets the WHOLE answer. Past the bound the report is dropped
      // transcript-only (the id is NOT consumed): the full text stays in the
      // ACP transcript view, and a wake rebuilt from only the frames that
      // arrive after a drop would be a HALF report — rather send nothing than
      // half.
      if (Date.now() - report.firstAt < this.host.ambientTuning().maxMs) {
        this.armReportTimer(session, report)
        return
      }
      this.dropBackgroundReport(session, report)
      return
    }
    const text = report.text
    const requestId = report.requestId
    // COMMIT FIRST (one report = one wake): a host that throws or rejects must
    // not leave a re-deliverable report behind. Both failure shapes end the
    // same way — one notice, zero wake, record gone (`wakeChatWithBackgroundReport`).
    report.delivered = true
    this.dropBackgroundReport(session, report)
    // Retire the id EVEN when a newer announcement replaced the ambient
    // record: that replacement is another run, and this one's answer is out.
    // A COMPLETE quiet delivery is final: consume the id so late frames stay
    // transcript-only (no duplicate answer). A ceiling CUT delivered a
    // truncated report while the run was still active — its continuation (the
    // real deliverable the user is waiting for) must still wake the chat, so
    // the id is retired but NOT consumed and the ambient stays alive to collect
    // the tail into a fresh report.
    if (requestId !== undefined) {
      retireAmbientId(session, requestId, !cut)
      if (!cut && session.ambient?.requestId === requestId) session.ambient = undefined
    }
    this.wakeChatWithBackgroundReport(session, agent, text)
  }

  /**
   * Drop one report record — its timer, and the session slot only when the
   * slot still holds THIS record (a newer run's record must survive).
   */
  private dropBackgroundReport(session: LiveSession, report: BackgroundReport): void {
    if (report.timer !== undefined) {
      clearTimeout(report.timer)
      report.timer = undefined
    }
    if (session.backgroundReport === report) session.backgroundReport = undefined
  }

  /** The host chat agent a wake can be handed to, or `undefined` when none can. */
  private wakeAgentFor(session: LiveSession): DshAgentLike | undefined {
    const dshSessionId = session.dshSessionId
    const resolver = this.dshAgentResolver
    if (dshSessionId === undefined || resolver === undefined) return undefined
    try {
      const agent = resolver(dshSessionId)
      return agent !== undefined && typeof agent.followup === 'function' ? agent : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Inject the wake message and let the host start its step.
   *
   * The report was already committed (see `deliverBackgroundReport`), so the
   * two failure shapes — a synchronous throw and an asynchronously rejecting
   * `followup` — are OBSERVABLY IDENTICAL: no wake landed, the id is consumed
   * (late frames cannot answer again), and exactly ONE `agent/notice` goes to
   * the settings log. Determinism over retry; the answer is in the transcript.
   * A host without the chat agent never reaches this method (the report stays
   * transcript-only).
   */
  private wakeChatWithBackgroundReport(session: LiveSession, agent: DshAgentLike, report: string): void {
    const wakeNotice = (error: unknown): void => {
      this.host.hub.broadcast({
        type: 'agent/notice',
        agentId: session.agentId,
        level: 'info',
        text: `acp: could not wake the chat for a background report: ${describeError(error)}`,
      })
    }
    try {
      const result = agent.followup?.({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: BACKGROUND_WAKE_TEXT }],
        source: {
          kind: BACKGROUND_REPORT_SOURCE,
          form: BACKGROUND_REPORT_FORM,
          summary: BACKGROUND_WAKE_TEXT,
          report,
        },
      })
      // `followup` may be async on the host. An unhandled rejection would kill
      // the host process (Node 22), so the returned thenable is always drained
      // — and a rejection is the same failure as a synchronous throw.
      if (result !== undefined && result !== null && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result as PromiseLike<unknown>).catch(wakeNotice)
      }
    } catch (error) {
      wakeNotice(error)
    }
  }

  /**
   * Keep the lifecycle record current, announcing it ONLY when its status
   * changed (creation included) and writing the state file on the same
   * transitions. A write per worker chunk would stall the host.
   */
  private syncDispatchRecord(session: LiveSession, dispatch: BackgroundDispatch): void {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const status = dispatchStatus(dispatch)
    const transition = dispatch.reportedStatus !== status
    if (transition) dispatch.reportedStatus = status
    this.noteSubagentRecords(
      [dispatchRecord(dispatch, dshSessionId)],
      { announce: transition, persist: transition },
    )
  }

  /**
   * Hand one DETACHED dispatch to the host's subagent catalog. One fact per
   * tool call, and only once the wire's structure proves the work runs off-turn.
   */
  private reportSubagentDispatch(session: LiveSession, dispatch: BackgroundDispatch): void {
    if (dispatch.catalogReported) return
    if (!dispatch.catalogLabelIdentified && !dispatch.completed) return
    if (this.reportSubagentCatalog(session, `acp:${dispatch.toolCallId}`, dispatch.catalogLabel)) {
      dispatch.catalogReported = true
    }
  }

  /**
   * A dispatch just reported: tell the turn controller it may move to its
   * drain phase. The catalog row was already offered by the completing frame.
   */
  private noteSessionDispatchProgress(session: LiveSession): void {
    session.turnController?.onAllDispatchesCompleted()
  }
}
