import type { PermissionTimeoutMode, SessionView, SubagentStatus } from '../protocol.ts'

/** What the composer showed for an agent before a conversation picked it. */
export interface DisplayedChatDefaults {
  modelId?: string
  effort?: string
  /** The agent's last-known mode (the composer's select without a pick). */
  mode?: string
  extraConfigs?: Record<string, string | boolean>
}

/**
 * One idle drain's collected answer, waiting to become a chat turn.
 *
 * Collected ONLY while no turn controller exists (or the conversation is
 * otherwise idle): a steered prompt or a `backgroundHoldWorkerPhase` hold
 * already consumes the drain inside its own bubble, and a second delivery
 * would duplicate the answer.
 *
 * The record is BOUND TO ONE RUN (`requestId`): a frame of a different run
 * closes it out and opens a fresh record, so a report never carries two runs'
 * prose and each run's id is retired on its own delivery.
 */
export interface BackgroundReport {
  /** The drain's request id: the run this report belongs to. */
  requestId?: string
  /** Concatenated `agent_message_chunk` text of the drain, verbatim. */
  text: string
  /**
   * When the run last showed any frame (the quiet clock measures the run's
   * silence from here — see `armReportTimer`).
   */
  lastAt: number
  /** When the first frame landed; bounds how long a busy conversation defers. */
  firstAt: number
  /** The armed quiet timer, or `undefined` while none is pending. */
  timer?: ReturnType<typeof setTimeout>
  /** Whether the host already received this report (never twice). */
  delivered: boolean
  /**
   * Tool calls THIS run opened in the drain and never reported `completed` /
   * `failed` for, by `toolCallId`. While one is open the quiet timer does not
   * deliver: the run is still answering, and a tool can outlive the quiet
   * window (the completion frame arrives with NO `_meta` on the real wire and
   * closes the call by id alone — the dispatch-completion convention).
   */
  openToolCalls: Set<string>
}

/** One unsolicited (background) turn the agent is running, as announced in `_meta`. */
export interface AmbientTurn {
  /** `codebuddy.ai/requestId` of the drain; every update of the run carries it. */
  requestId: string
  startedAt: number
  /**
   * When this drain last showed any sign of life (announcement or an update
   * carrying its request id). {@link BridgeTuning.ambientStaleMs} expires the
   * record from here, so a drain that died silently does not capture a later
   * normal turn as steered.
   */
  lastActivityAt: number
  /** Whether the drain already streamed prose (text or thought) into the transcript. */
  sawOutput: boolean
}

/** A drain id the session stopped waiting on, and when it was retired. */
export interface RetiredAmbient {
  requestId: string
  /**
   * When the wait was retired. `hasRecentRetiredAmbient` uses it to tell a
   * prompt folded into a just-quieted drain from one that ended on its own;
   * `adoptTurnRequestId` / `noteTurnRequestId` ignore the id at any age.
   */
  retiredAt: number
}

/** Reliability tuning, threaded from `AcpPluginConfig` through the manager. */
export interface BridgeTuning {
  startupTimeoutMs?: number
  /**
   * How long a permission ask may sit unanswered before the deadline fires.
   *
   * ONE window for every ask. Every ask is broadcast as `permission/request`
   * and answered from the conversation's dock card; an `/acp`-RPC ask has no
   * conversation, so the settings page mirrors the same ask as its answer
   * entry. One question, one window: "is anyone there?" gets the same answer
   * wherever the card is rendered, and two numbers made the settings card look
   * like two unrelated knobs.
   *
   * `0` means 不等待, not "wait forever": `auto` settles the ask on arrival,
   * `abort` floors the window to the shortest real wait (refusing every ask on
   * arrival is a brick wall, not a timeout), and `wait` ignores the window
   * entirely.
   *
   * The deadline is what keeps a turn from hanging on a question nobody
   * answers: the card stays visible, but an unattended session would otherwise
   * wait indefinitely. Past the deadline the ask is settled IN PLACE — never
   * relocated: `abort` refuses it, `auto` answers it with the option the
   * agent's own kinds imply (broadest grant first), and `wait` never expires
   * it at all.
   *
   * Default 300000 ms. OmniTerm's equivalent is its reaper's permission-timeout
   * threshold (30 min default, 30 s steps, hot-updatable).
   */
  permissionTimeoutMs?: number
  /**
   * What an EXPIRED approval deadline does. `wait` (default) never expires
   * the ask at all; `abort` refuses it; `auto` answers it with the option the
   * agent's own kinds imply and lets the agent continue.
   *
   * Three values, and only three: an unanswered ask is either answered for
   * you, kept waiting, or refused. Same vocabulary as OmniTerm dev's
   * `acp_perm_timeout_mode`.
   *
   * The default is `wait`: a permission ask is a question FOR A HUMAN, and
   * refusing it because the human looked away from the tab is worse than
   * waiting — the ask stays visible the whole time, so nobody is left
   * wondering what happened to it. `abort` and `auto` are opt-in for the
   * deployments that would rather have a bounded turn.
   */
  permissionTimeoutMode?: PermissionTimeoutMode
  cancelFallbackMs?: number
  /**
   * How long to wait before resending a prompt the agent answered `cancelled`
   * although no cancel was requested for that turn — the stale-cancel swallow
   * (codebuddy answers the NEXT prompt with the PREVIOUS cancel while it is
   * still cleaning up). The delay must outlast the agent's cleanup window;
   * measured at 250ms on codebuddy 2.161.4, so the default is 600ms.
   */
  staleCancelRetryDelayMs?: number
  /** How many times a stale-cancelled prompt is resent before giving up. */
  staleCancelMaxRetries?: number
  /**
   * How long a new turn waits for the agent to settle a predecessor that is
   * still running on its side (an aborted turn we already stopped streaming).
   * Zero disables the wait: the next prompt then fails immediately rather than
   * racing a concurrent `session/prompt` into the agent.
   */
  turnSettleMs?: number
  /**
   * How long a turn may stay SILENT — no update, no ask, no turn start — before
   * the watchdog force-finalizes it as stalled. The turn is only watched while
   * the agent is the one holding the floor (a segment on air, no pending ask),
   * and the process survives: the next message reclaims it.
   *
   * `0` disables the watchdog.
   */
  turnStallMs?: number
  /**
   * The longer silence window used while an ACP tool call is in progress: the
   * agent runs the tool on its own clock, so the plain turn window would call
   * a healthy long-running tool stalled. `0` falls back to `turnStallMs`.
   */
  turnStallToolMs?: number
  /** How often the watchdog scans for silent turns. */
  turnStallTickMs?: number
  /**
   * Default idle-release window for agents without their own
   * `AcpAgentDef.idleTimeoutMs`: a READY process that holds no live session
   * and has no work in flight is killed after this long. `0` disables it.
   */
  idleTimeoutMs?: number
  /**
   * Idle-release window for a bridge that has NEVER hosted a real session —
   * i.e. a process a model-catalog probe spawned (probes bypass session
   * bookkeeping). Applies before and instead of `idleTimeoutMs`/`def.idleTimeoutMs`:
   * those express how long a CHAT process waits for its next message, which a
   * probe-only process has no stake in. `0` disables it.
   */
  probeIdleTimeoutMs?: number
  /**
   * How long an ambient wait (see `TurnStreamController.awaitAmbient`) stays
   * open after the LAST session update before the turn closes itself.
   *
   * A drain's end is its silence — the SDK's schema rejects the `session_end`
   * CodeBuddy never sends anyway — but "silence" must be measured in the
   * agent's own cadence, not in a chat-app-paced one. Measured against
   * CodeBuddy 2.179.0: the gaps between drain ticks (the
   * `model_requesting`→`model_streaming` hand-off of a real model call) run
   * 1.0–1.4s, so any window below that closes the turn BEFORE the answer
   * exists. 10s leaves room for two slow hand-offs without holding the turn
   * open for a drain that actually finished.
   *
   * Deliberately NOT keyed on an `agentPhase` idle flag: a drain goes idle
   * between queued messages too, so that signal closes the turn in the middle
   * of its own work.
   */
  ambientQuietMs?: number
  /**
   * The hard ceiling on ONE ambient wait: a background run that keeps ticking
   * for minutes without finishing must not hold the conversation's turn open
   * forever. At the ceiling the turn says where the rest of the output will
   * land and closes.
   */
  ambientMaxMs?: number
  /**
   * How long the WORKER phase of a detached-worker hold may go WITHOUT any
   * evidence from the worker (see `TurnStreamController.holdForBackgroundDispatch`):
   * the turn dispatched one or more background workers through `Agent` tool
   * calls, the agent answered the prompt, and at least one worker has not
   * reported back yet. There is still no quiet clock in the ambient sense —
   * measured against CodeBuddy 2.179.0, a detached worker's own updates are
   * 13–24s apart while it is perfectly alive — so every update naming the
   * dispatch or carrying its `parentToolCallId` PUSHES THIS WINDOW OUT. Only a
   * genuinely silent worker, or every known dispatch reporting (completed /
   * failed), ends the phase; a drain announcement is recorded but arms no
   * quiet clock before then. Once they have all reported, the drain's own
   * `ambientQuietMs` / `ambientMaxMs` windows take over.
   *
   * Default 600000 ms (10 minutes of silence, not of total runtime). This is
   * the SHORT tier: while the worker's last known state is an open tool call,
   * `backgroundTaskToolMs` applies instead.
   */
  backgroundTaskMaxMs?: number
  /**
   * The worker phase's LONG tier: how long it may go silent when the worker's
   * last known state is an OPEN tool call (`tool_call` / `tool_call_update`
   * carrying `parentToolCallId` without completed / failed). Mirrors the main
   * turn's {@link BridgeTuning.turnStallToolMs}: a worker blocked inside one
   * Bash / generation command emits no updates for minutes while it is
   * perfectly alive, and reading that as death closes the turn before the
   * report arrives.
   *
   * `0` falls back to `backgroundTaskMaxMs`. Default 2400000 ms (40 minutes).
   */
  backgroundTaskToolMs?: number
  /**
   * How long an OPEN worker tool call may stay open before the idle clock reads
   * the worker as WEDGED and allows the process to be released.
   *
   * An open call is stronger evidence of life than silence: a long build emits
   * no updates for tens of minutes. While one is open the plain silence window
   * (`backgroundTaskToolMs`) never applies; this ceiling does. `0` = no ceiling.
   * Default 7200000 ms (120 minutes).
   */
  backgroundOpenToolCeilingMs?: number
  /**
   * Optional ABSOLUTE ceiling on a detached-worker hold, both phases included.
   * `backgroundTaskMaxMs` keeps an ACTIVE worker alive indefinitely; this is
   * the emergency bound for a zombie that keeps emitting updates forever.
   * `0` disables it — the turn can then stay open as long as the worker keeps
   * proving it is alive, and the person can still steer/cancel the hold by
   * sending a message.
   *
   * Default 0 (no ceiling).
   */
  backgroundTaskCeilingMs?: number
  /**
   * How long a PARKED detached-worker hold may wait for the host to open the
   * driver step that carries the worker's report. The prompt response landed
   * between two steps (the host is about to execute the `Agent` card), and a
   * host that never opens the continuation step must not hang the turn. The
   * host normally opens it at once, so this is a safety bound, not a cadence —
   * deliberately far larger than one model hand-off.
   *
   * Default 30000 ms (30 seconds).
   */
  backgroundParkedGraceMs?: number
  /**
   * How long an announced background drain may go without ANY update before a
   * later instant prompt stops treating itself as folded into it. A drain that
   * went silent for minutes is over even though nothing told us; keeping the
   * record would misclassify the next normal turn as steered. Checked lazily
   * when a prompt response arrives (see `streamPrompt`), never on a timer.
   */
  ambientStaleMs?: number
  /**
   * Hold the turn across the WORKER phase too (the pre-2026-11 behaviour).
   *
   * Default `false`: the prompt response closes the turn, so the user keeps
   * talking while the worker runs; the report lands in the transcript / NTR
   * view. `true` keeps the whole turn open until the drain delivers the report
   * — one bubble, but the composer stays locked for the worker's whole run.
   * Only a deployment tuning key (no settings control).
   */
  backgroundHoldWorkerPhase?: boolean
}

/**
 * Resolves the workspace root of one chat session (`dshSessionId` = DSH session
 * id) — the sidebar's selected workspace, which the host's sandbox policy keeps
 * for the session. Never throws; `undefined` means "no workspace available" (an
 * `/acp`-RPC session, an unknown session, or a host without the service), and
 * the caller falls back to the agent's configured cwd.
 */
export type SessionWorkspaceResolver = (dshSessionId: string) => { workspaceRoot?: string } | undefined

/** Reports whether one DSH chat session runs the ACP-mode agent preset. */
/**
 * Whether ONE DSH chat session runs the ACP agent preset. May be async: a cold
 * session (the process restarted since its last turn) has to be read from the
 * persistence store, and only the answer is worth the wait — the asker is the
 * browser's seat gate, which polls.
 */
export type AcpModeResolver = (dshSessionId: string) => boolean | undefined | Promise<boolean | undefined>

/**
 * Report one detached ACP worker to the host's parent-owned subagent catalog.
 * Display-only: the host records an EXTERNAL execution with no child session.
 */
export type SubagentCatalogReporter = (dshSessionId: string, childId: string, label: string) => void

export type BridgeState = 'stopped' | 'starting' | 'ready' | 'error'

/**
 * Facts about one start attempt, recorded as it happens so a failure can be
 * NAMED afterwards instead of being read back out of prose.
 *
 * WHY: whatever goes wrong, the SDK rejects the pending `initialize` with the
 * same sentence (`ACP connection closed`), so the user's two actual mistakes —
 * "the agent is not installed" and "the launch command is wrong" — used to
 * arrive identical. The connection test reads this record (see
 * `classifyTestFailure`) and the settings page writes the matching fix.
 *
 * Written once per {@link AgentBridge.spawnAndConnect}, after the teardown
 * checks: a start that lost its epoch describes nothing anyone reads.
 */
export interface StartAttempt {
  /** The program token the definition names, before PATH resolution. */
  command: string
  /** Absolute path the program token resolved to; absent = never found on PATH. */
  executablePath?: string
  /**
   * The `npmPackage` auto-install was actually STARTED during this attempt.
   *
   * Set from the install step itself, never from the definition: a configured
   * package name proves nothing (the program may already sit on PATH), and
   * claiming the install ran would make the settings page name a fix that never
   * happened.
   */
  installTried: boolean
  /** `spawn` was called and returned a child (an async ENOENT still counts as spawned). */
  spawned: boolean
  /** The spawn itself failed (ENOENT, EACCES, EINVAL…). */
  spawnError?: { code?: string; message: string }
  /** The child exited while the handshake was still in flight. */
  exit?: { code: number | null; signal: string | null }
  /** The `initialize` request ran out of its startup budget. */
  timedOut: boolean
}

/**
 * One chat-bound session record, as persisted across host restarts (the
 * `chatSessions` key of the agent registry). Deliberately identity + display
 * mirrors ONLY — the transcript is the agent's to replay on `session/load`,
 * and `configOptions` come back from the same load. `hasHistory` is what lets
 * an empty restored view say "history replays on restore" instead of
 * "nothing yet".
 */
export interface PersistedChatSession {
  sessionId: string
  acpSessionId: string
  agentId: string
  dshSessionId: string
  cwd: string
  title?: string
  modelId?: string
  reasoningEffort?: string
  modes?: SessionView['modes']
  usage?: SessionView['usage']
  burst?: SessionView['burst']
  hasHistory?: boolean
}

/**
 * The `Agent` tool call that handed work to a DETACHED worker.
 *
 * CodeBuddy 2.179.0 with multitask on: the coordinator opens an `Agent` call
 * (`_meta["codebuddy.ai/toolName"] = "Agent"`), says "已派…", and ENDS ITS OWN
 * PROMPT normally while the worker keeps running off-turn. The call itself
 * stays `in_progress` until the worker reports, and only then does the agent
 * start the background drain that carries the worker's report into the
 * session. A turn that closed at its prompt response therefore lost the only
 * answer it was ever going to produce; this record is what the controller
 * holds the turn open for.
 */
export interface BackgroundDispatch {
  /** The `Agent` call's id — the card that stays on the plane. */
  toolCallId: string
  /** The last status the agent declared for the dispatch call itself. */
  status: string
  /**
   * Whether the call already reported a TERMINAL status (completed OR failed).
   * Deliberately still one boolean: the hold only cares whether the worker
   * reported at all, never whether the report was good (constraint 23).
   */
  completed: boolean
  /**
   * Whether the work runs DETACHED, read from the dispatch call's OWN structure:
   * the call re-sent with `_meta["codebuddy.ai/isBackground"] = true`. A worker
   * update naming this call as its `parentToolCallId` does NOT set it — CodeBuddy
   * tags a synchronous subagent's child updates the same way, so that signal
   * only proves the worker alive (`sawWorkerUpdate`). A synchronous `Agent` /
   * `Task` call never declares `isBackground`, so it can never make the turn
   * wait after its own answer.
   */
  detached: boolean
  /** Whether any update came FROM the worker (`codebuddy.ai/parentToolCallId`). */
  sawWorkerUpdate: boolean
  /** One-line label for the host's subagent catalog, refreshed until reported. */
  catalogLabel: string
  /** Whether `catalogLabel` carries the worker's identity, not just the tool name. */
  catalogLabelIdentified: boolean
  /** Whether the host catalog already accepted this dispatch (one fact per call). */
  catalogReported: boolean
  /** When the dispatch call was first seen (the record's `startedAt`). */
  startedAt: number
  /** Last frame belonging to this dispatch. Memory-only: persisted with the next transition. */
  lastActivityAt: number
  /** When a terminal state was written. */
  endedAt?: number
  /**
   * The terminal status, once decided. Never overwritten: a late completion
   * after the turn already closed with `unknown` is a known limitation, not a
   * bug (the row must not stay `running`, and it must not be revived either).
   */
  terminal?: 'completed' | 'failed' | 'cancelled' | 'unknown'
  /** The terminal frame's `tool_call_update.content`, verbatim (constraint 29). */
  error?: unknown
  /** The worker's declared role (`_meta["codebuddy.ai/subagentType"]`). */
  subagentType?: string
  /** Per-worker counters; only `updates` moves per chunk and none of them writes the state file. */
  counts: { updates: number; toolCalls: number; textChars: number }
  /** The status last announced through `subagents/record` (creation included). */
  reportedStatus?: SubagentStatus
  /**
   * The WORKER's own tool calls that are still open, by `toolCallId` → when the
   * call opened. A worker silent inside a long command is alive, not wedged:
   * while one is open the idle clock grants the long open-tool ceiling instead
   * of the plain silence window (see `hasPendingBackgroundWork`).
   */
  openWorkerToolCalls?: Map<string, number>
}

/** A host chat agent, as far as a wake-up needs it (see `setDshAgentResolver`). */
export interface DshAgentLike {
  session?: { id?: string }
  /** The host's inbox+driver wake: queues the message and starts a step. */
  followup?: (message: unknown) => unknown
}
