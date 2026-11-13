/**
 * The per-session live record, shared by the stream controller, the bridge and
 * the services. Moved verbatim out of `turn-stream.ts` (which re-exports it) to
 * keep that file inside the size ratchet; the shape is unchanged.
 */
import type { Transcript } from '../impl.ts'
import type { SessionView } from '../protocol.ts'
import type { AmbientTurn, BackgroundDispatch, BackgroundReport, RetiredAmbient } from './types.ts'
import type { TurnStreamController } from './turn-stream.ts'

export interface LiveSession {
  /** Host-minted id (stable across an agent restart; the ACP id is per-connection). */
  sessionId: string
  agentId: string
  acpSessionId: string
  cwd: string
  title?: string
  /**
   * The adapter model id this session was last aligned to (`agentId` /
   * `agentId@choice`). Recorded here so the browser can show "which model is
   * this conversation on" from `session/chat-list` alone — the plugin's own
   * binding, not a DSH model route.
   */
  modelId?: string
  /** The model choice portion of {@link modelId}, when it carries one. */
  choice?: string
  /** The reasoning effort in force for this session, when one applies. */
  reasoningEffort?: string
  modes?: SessionView['modes']
  configOptions?: unknown[]
  availableCommands?: SessionView['availableCommands']
  plan?: unknown[]
  usage?: SessionView['usage']
  /**
   * The plugin's own measurable burst aggregate over this ACP session's turns
   * (see `src/tps.ts`). Persisted with the chat-session record so the dock's
   * rate survives a host restart; absent until a turn contributes a measurable
   * burst (>= 1 inter-chunk gap).
   */
  burst?: SessionView['burst']
  running: boolean
  /**
   * The HOST's prompt slot for this session: true from the moment a turn
   * starts until the agent answers it (or the host aborts the turn, or the
   * turn is discarded). Together with the {@link settled} gate — which STAYS
   * claimed after an abort until the agent acknowledges the cancel — this is
   * what `claimTurn` arbitrates, NOT `running`.
   *
   * The three are deliberately different:
   * - an ambient wait keeps `running` true (the background drain is still the
   *   session's work, so nothing may release the process) while this slot is
   *   already FREE (the agent answered; only the drain keeps talking);
   * - an aborted turn drops THIS flag at once (our face of the turn ends) but
   *   leaves `settled` in place, so the next prompt still waits out
   *   `turnSettleMs` for the agent instead of racing a concurrent prompt.
   */
  promptInFlight?: boolean
  closed: boolean
  /** The agent process died; the session awaits a `session/load` resume. */
  released: boolean
  /**
   * The agent-side session has history while the LOCAL buffer is empty: this
   * record was restored from disk after a host restart (the replay has not
   * landed yet), or a resume cleared the buffer ahead of the replay. The ACP
   * view then says history replays on restore instead of "nothing yet". Set
   * by `doResumeSession` (captured before the reset) and the restore path; the
   * serializer ORs it with the live buffer length.
   */
  hasHistory?: boolean
  /**
   * A `session/load` is in flight: the ACP spec puts the agent's whole history
   * replay BEFORE the response, so every update arriving in this window is
   * replay, not live work. Set by `doResumeSession` around the request; the
   * dispatch tracker skips it so a replayed historical dispatch cannot
   * resurrect a finished worker as running.
   */
  loadingHistory?: boolean
  /**
   * When the agent last showed ANY sign of life on this session: an update, a
   * permission ask (arrival or answer), or a turn start. The stall watchdog
   * measures silence from here rather than from the prompt, which may
   * legitimately be followed by a long tool run.
   */
  lastAgentActivityAt: number
  /**
   * Tool calls the agent announced and has not finished, by ACP `toolCallId`.
   * A SET, not a flag: parallel calls finish independently, and one sibling's
   * `completed` must not clear the long tool window while another is still
   * running. Non-empty = the agent is working on its own clock.
   */
  activeToolCalls: Set<string>
  /**
   * Owning DSH chat session id, when the session was opened through the LLM
   * adapter (`AcpLlmAdapter`). It is what the conversation's permission card
   * filters on (`permission/request.dshSessionId`); sessions started over the
   * `/acp` RPC have no chat session, so their asks stay on the settings panel.
   */
  dshSessionId?: string
  /**
   * True when this chat session runs on the ACP-mode agent preset, re-resolved
   * every turn. It is a report for the browser surfaces (which conversation are
   * we in), not a policy switch: an ACP agent decides its own permissions, so
   * the host arbitrates nothing (see docs/acp-convergence.md §2.3).
   */
  acpMode?: boolean
  /**
   * Resolves when the AGENT has settled the turn it is currently running (its
   * `session/prompt` response, or its acknowledgement of a cancel). This is
   * deliberately not `running`: an aborted turn ends our stream at once,
   * while the agent keeps working until it observes the cancel — and the ACP
   * protocol forbids a second `session/prompt` on a busy session.
   */
  settled?: Promise<void>
  /**
   * The resolver of {@link settled}, kept alongside so turn-scoped force
   * finalization (the cancel fallback) can open the gate without owning the
   * stream. Cleared by the same settler that clears {@link settled}.
   */
  settledResolve?: () => void
  /**
   * This session's first turn wrote the conversation's agent lock just now
   * (the conversation had none before). The lock is provisional until that
   * turn produces a visible block: a first turn that delivers nothing — an
   * error, a silent provider failure folded into a normal stop, or even a
   * cancel — rolls the lock back and closes this session, so the user can
   * choose another agent. Cleared as soon as the first turn settles.
   */
  provisionalLock?: boolean
  /**
   * Monotonic per-session counter, bumped at every turn start (both the
   * `/acp` RPC path and the adapter's `streamPrompt`). Turn-scoped timers —
   * the cancel fallback — capture it when armed and compare when they fire:
   * a timer whose generation has moved on belongs to a turn that already
   * ended, and must not force-finalize the LATER turn now on air.
   */
  turnSeq: number
  /**
   * The {@link turnSeq} of the turn `session/cancel` was last called for.
   * A `cancelled` stopReason on a turn whose generation does not match is
   * not the user's cancel: some agents answer the NEXT prompt with the
   * PREVIOUS cancel while still cleaning up (the stale-cancel swallow), and
   * that answer means the message was silently dropped.
   */
  cancelRequestedAtTurn?: number
  /**
   * The {@link turnSeq} of a turn the stall watchdog force-finalized while the
   * agent still held its `session/prompt`. The agent is presumed wedged, so the
   * NEXT prompt reclaims the process (`BridgeManager.prepareStalledSession`)
   * instead of queueing behind a turn that may never answer. Cleared when the
   * late response lands or when the reclaim replaces the process.
   */
  orphanPromptTurnSeq?: number
  /**
   * The {@link turnSeq} of a turn a reclaim (`prepareStalledSession`) ended by
   * closing the connection while the agent still held its `session/prompt`.
   * The close rejects that request, and the caller's catch would broadcast a
   * second `turn/end` for a turn already finalized: this marker tells the
   * late `then`/`catch` to drop the answer instead. Set by the reclaim, cleared
   * when that answer lands, at every new turn start, and by a resume.
   */
  reclaimedTurnSeq?: number
  /**
   * The controller of the turn currently streaming through this session.
   *
   * Chat turns are ALSO indexed by chat id ({@link BridgeManager}'s
   * `turnStreams`) because their continuation steps arrive as fresh
   * `streamPrompt` calls that look the turn up by chat id. An EPHEMERAL turn
   * (`options.sessionId === undefined`) has no chat id to index under, so this
   * attachment is the only way the stall watchdog can find its controller —
   * without it a silent ephemeral turn falls into the `/acp` branch, which
   * leaves the driver's segment queue open instead of finishing it. Cleared by
   * the controller's own `retire` when it still points at it.
   */
  turnController?: TurnStreamController
  /**
   * A background turn the agent started on its OWN initiative (CodeBuddy's
   * multitask drains: a sub-agent completion notice starts a run the client
   * never asked for). Its first `session_info_update` announces the request id
   * every later update of that run carries in `_meta`; a `session/prompt`
   * answered instantly with no conversation request id was folded into this
   * drain and its real answer arrives as the drain's updates.
   *
   * Only lifetime events clear it (close / release / resume / stop): a drain
   * may outlive the turn that was steered into it, and clearing on a normal
   * settle would misclassify the NEXT steered prompt.
   */
  ambient?: AmbientTurn
  /**
   * Request ids whose `agent/notice` already went out, so a repeated
   * announcement of the same background run is not logged twice.
   */
  ambientNotices?: Set<string>
  /**
   * Background drains this session already STOPPED waiting on (an ambient wait
   * that closed on silence, or a record that outlived `ambientStaleMs`). The
   * record is gone from {@link ambient}, but the drain itself may still be
   * running: a queued message or a long tool makes it speak again while the
   * NEXT turn is on air. Without this list the late text would teach that turn
   * the drain's id (`noteTurnRequestId` / `adoptTurnRequestId`) and fold the
   * background run's answer into the user's answer (a double answer).
   *
   * An update or re-announcement carrying a listed id REVIVES it
   * (`reviveAmbientId` + a rebuilt {@link ambient}): the run is alive, so its
   * next steered prompt must receive the drain's text. Only while the record
   * stays retired is its text transcript-only. Timestamps let the zero-output
   * report recognise a prompt folded into a recently quieted drain
   * (`hasRecentRetiredAmbient`). Bounded ({@link RETIRED_AMBIENT_MAX}), oldest
   * evicted first; every lifecycle boundary clears the list
   * (`clearAmbientState`).
   */
  retiredAmbients?: RetiredAmbient[]
  /**
   * The agent's last rate-limit refusal on this session, and when it landed.
   *
   * CodeBuddy answers a rate-limited prompt with a RESOLVED response
   * (`stopReason: 'refusal'`, the reason in the response `_meta`), so nothing
   * in the turn itself says the conversation stopped for a quota the user can
   * wait out or switch models for. The composer's dock card reads this through
   * `snapshot()`; the `at` timestamp stays here and never reaches the view.
   *
   * BOTH prompt planes write it — the chat adapter's `streamPrompt` and the
   * `/acp` RPC's `prompt` — because one LiveSession can be driven from either,
   * and a banner that survives the answer that disproved it is a lie.
   *
   * TRANSIENT by design: the next non-limited response clears it, and so does
   * every lifecycle boundary (`clearAmbientState`: close / release / resume /
   * force reset). It is deliberately NOT part of `PersistedChatSession` — a
   * quota from a previous host run says nothing about this one.
   *
   * `at` stamps when the refusal landed and nothing expires the record from
   * it: the reset time the agent reports is prose inside `message`, and
   * guessing a timestamp out of that would invent a policy the agent never
   * stated. The record clears on EVIDENCE instead (the next answer that is not
   * rate-limited, or a lifecycle boundary), which is also why an idle release
   * bounds how long a stale banner can sit on a live session.
   */
  quotaRefusal?: { message: string; at: number }
  /**
   * The answer Antigravity's own transcript reported late, after the turn
   * closed, and when it was delivered (see `docs/plan/antigravity-late-output.md`).
   *
   * The agent replays that text on the NEXT prompt (it sends no update while
   * no prompt is in flight), so the echo guard in `TurnStreamController`
   * swallows exactly this text once. Written only when
   * `BridgeManager.streamPrompt` actually replays the pending report — a wake
   * skipped by the background-report FIFO must NOT write it, or the replayed
   * answer would be swallowed twice.
   */
  lateEcho?: { text: string; at: number }
  /**
   * A late report handed to the chat plane that no step has replayed yet.
   * `streamPrompt` matches its `report` against the report it is about to
   * yield and converts it into {@link LiveSession.lateEcho}, whose `text` is
   * the UNMARKED truncated prefix (`guard`): the echo guard's deduplication key
   * must match the agent's replay, never our truncation marker.
   */
  pendingLateEcho?: { guard: string; report: string; at: number }
  /**
   * The visible answer text of the turn that just closed, kept to recognise
   * the agent writing the SAME answer late: a candidate equal to it is this
   * turn's own text, not a new report.
   */
  lastTurnAnswerText?: string
  /**
   * `toolCallId`s seen in a COMPLETED turn (Antigravity only). The agent
   * replays the previous turn's tool frames on the next prompt: a known id
   * must not open a second card, and its replay must not re-open the stall
   * watchdog's long tool window. Bounded (`KNOWN_TOOL_CALL_MAX`), oldest
   * evicted first; `turnToolCalls` collects the current turn's ids and they
   * rotate in here at `closeTurn`.
   */
  knownToolCalls?: Set<string>
  /** `toolCallId`s seen in the turn currently on air (Antigravity only). */
  turnToolCalls?: Set<string>
  /**
   * Stops this session's transcript watch (the late-output service's
   * `disarm`). Set at arm time, called by `clearAmbientState` at every
   * lifecycle boundary — the writer is the agent process, so a released
   * session's transcript cannot grow and a watch must not outlive it.
   */
  stopLateWatch?: () => void
  /**
   * Cursor and gate snapshot saved when a late-output watch delivers a wake
   * turn, so `armAfterWake` resumes from the exact byte offset and turn floor
   * instead of calling `baseline()` and jumping over steps written during wake
   * scheduling. Cleared when consumed, on a fresh `arm`, or on teardown.
   */
  lateWatchCheckpoint?: {
    readonly path: string
    readonly offset: number
    readonly lastStepIndex: number
    readonly closedAt: number
    readonly reportGate: boolean
    readonly waiting: boolean
  }
  /**
   * Detached workers this session dispatched that may still run after the
   * turn that dispatched them CLOSED. Session-level on purpose: the worker's
   * completion / drain frames arrive after that turn's controller retired,
   * and the idle clock must see the pending work so a release cannot kill the
   * agent out from under it.
   */
  backgroundDispatches?: Map<string, BackgroundDispatch>
  /**
   * Prose an IDLE background drain streamed while no turn controller observed
   * it. With the default "settle at the prompt response" (docs/acp-convergence
   * §派发即收口), CodeBuddy's unsolicited turn lands on a conversation nobody
   * is driving: the text reaches the transcript, but the chat plane would stay
   * silent until the person spoke again. This record lets the manager hand the
   * report to the host as a wake-up message, which turns it into a REAL chat
   * turn (`BridgeManager.deliverBackgroundReport`).
   *
   * ONE record per run: a frame of a DIFFERENT run (a drain that announced
   * itself while the report waited) closes the old record out in place and
   * opens a fresh one — two runs' prose never mix in one report, and each
   * run's id is retired on its own delivery (`trackBackgroundDrainText`).
   */
  backgroundReport?: BackgroundReport
  /**
   * Background drain request ids whose answer already reached a turn or the
   * chat plane. A drain that speaks after its wait closed is alive again
   * (`reviveAmbientId`), but its text belongs to a deliverable that ALREADY
   * exists — collecting it again would answer the same run twice (one more
   * bubble, or a second wake after the first one). Bounded, oldest evicted.
   *
   * "Already delivered" is evidence-based, per run id: a quiet close only marks
   * an id consumed when the turn actually FOLDED that run's visible text
   * (`TurnStreamController.foldedDrainIds`). A zero-output close (just the
   * deferral line) leaves it unconsumed — the answer never reached anyone, so
   * a revived run must still be able to wake the chat.
   */
  consumedDrains?: Set<string>
  transcript: Transcript
}
