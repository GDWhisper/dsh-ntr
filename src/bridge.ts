/**
 * ACP client bridge: one child process per configured agent definition,
 * multiplexing any number of ACP sessions over the stdio connection.
 *
 * The browser NEVER reaches this layer directly; it goes through the `/acp`
 * Connection RPC channel (authenticated) into `BridgeManager`, which is the
 * only object allowed to spawn a configured command.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable, Readable } from 'node:stream'
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type InitializeResponse,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import {
  AcpError,
  EventHub,
  PermissionLedger,
  Transcript,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  buildAdapterModelId,
  childEnv,
  isAcpToolContinuation,
  isUnderPath,
  mergeCatalogShape,
  parseCatalogOptions,
  usableConfigOptions,
  permissionToolKind,
  quoteCommandToken,
  randomUUID,
  resolveFsPath,
  resolveSessionCwd,
  selectForwardPrompt,
  acpPresetStatusFromRoster,
  splitAdapterModelId,
  updateContentToText,
  describeUnhandledUpdate,
  BOOKKEEPING_UPDATES,
  validateAgentDef,
  validateTagHalo,
} from './impl.ts'
import type {
  AcpToolCallSnapshot,
  PendingPermissionView,
  RosterPresetRow,
} from './impl.ts'
import type {
  AcpAgentCatalog, AcpAgentDef, AcpConversationChoice, AcpPresetStatus, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentTestResult, AgentView, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, GenerateOptions, LlmAdapterLike,
  LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmReasoningEffortInfo, LlmResolvedModelInfo,
  PermissionOutcome, PermissionOptionView, PreparedAdapterCall, SessionView, StreamChunk,
} from './protocol.ts'
import { DEFAULT_TAG_HALO } from './protocol.ts'

const STDERR_TAIL_LINES = 40
/** Single fs/read_text_file answer cap — agents reading huge files must page via `line`/`limit`. */
const FS_MAX_READ_BYTES = 2 * 1024 * 1024
/** Single fs/write_text_file payload cap. */
const FS_MAX_WRITE_BYTES = 2 * 1024 * 1024

/** What the composer showed for an agent before a conversation picked it. */
interface DisplayedChatDefaults {
  modelId?: string
  effort?: string
  extraConfigs?: Record<string, string | boolean>
}

interface LiveSession {
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
  running: boolean
  closed: boolean
  /** The agent process died; the session awaits a `session/load` resume. */
  released: boolean
  /**
   * Owning DSH chat session id, when the session was opened through the LLM
   * adapter (`AcpLlmAdapter`). `ctx.agents.get()` needs it to name the agent
   * whose open turn carries the native approval question; sessions started
   * over the `/acp` RPC have no chat session and stay on the ledger path.
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
  transcript: Transcript
}

/** Reliability tuning, threaded from `AcpPluginConfig` through the manager. */
export interface BridgeTuning {
  startupTimeoutMs?: number
  permissionTimeoutMs?: number
  /**
   * Deadline for a permission ask whose native route DEGRADED to unavailable
   * (see {@link LedgerFallbackReason}). Applies when `permissionTimeoutMs` is
   * 0 — its "approvals belong to a person, wait forever" default — because a
   * degraded ask has no visible answer entry in the conversation the user is
   * looking at, and waiting forever would hang the turn on a question nobody
   * can see there. The DESIGNED ledger paths (no approval service at all, a
   * session with no chat identity) keep waiting: their answer entry is the
   * settings panel, which is exactly where the chat line sends the user. `0`
   * disables even this fallback.
   */
  permissionFallbackTimeoutMs?: number
  /**
   * Deadline for the NATIVE approval route itself: how long
   * {@link AgentBridge.askNativeApproval} waits for the host approval chain to
   * answer before withdrawing the ask and handing it to the settings-panel
   * ledger (`native-timeout`, see {@link LedgerFallbackReason}).
   *
   * A routed ask shows no card and broadcasts no frame — the composer takeover
   * IS the answer entry — so a host that accepts the question and then never
   * renders it (answerer absent from the browser scope, the conversation not
   * mounted, a client that never received the remote event) leaves the turn
   * hanging behind a question the user cannot see anywhere. The deadline is
   * what makes that state bounded: past it the ask is withdrawn (the request
   * signal is aborted, which settles the host ask `cancelled`) and re-asked on
   * the ledger, where the chat line and the settings card are both visible.
   *
   * This is NOT an answer on the human's behalf: a human mid-decision simply
   * finds the same question in the settings panel. `0` disables it (wait for
   * the host forever).
   *
   * Default 300000 ms — the SAME window as
   * {@link BridgeTuning.permissionFallbackTimeoutMs}, so "this route is not
   * working" is one number instead of two arbitrary ones. A takeover that is
   * going to render does so immediately, and the host replays a pending
   * approval across reconnects (verified live on DSH web 0.2.1-rc.2), so the
   * deadline only ever fires for a host that took the question and never showed
   * it. OmniTerm's equivalent is its reaper's permission-timeout threshold
   * (30 min default, 30 s steps, hot-updatable); this is the same knob without
   * their `auto` tier, which this plugin does not have (every ask must reach a
   * human).
   */
  nativeApprovalTimeoutMs?: number
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
}

/** One native approval question, as the host approval service defines it. */
export interface ApprovalRequestContext {
  /** DSH chat session that owns the open turn the question is asked in. */
  dshSessionId?: string
  agentId: string
  /** Human-facing identity of the operation awaiting a decision. */
  toolName: string
  reason?: string
  signal?: AbortSignal
}

/** Outcome vocabulary of the host approval chain (`'unavailable'` = no answerer). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Why one permission ask rides the settings-panel ledger instead of the native
 * approval chain, recorded when the ask is broadcast.
 *
 * `no-requester` and `no-chat-session` are the DESIGNED ledger paths: a host
 * without the approval service, and an `/acp`-RPC session that has no chat
 * turn to route into. `unavailable` is a DEGRADATION — the service is wired
 * and this ask still failed, so the conversation the user is looking at will
 * never show the question. `native-timeout` is the other degradation: the host
 * TOOK the question and never answered it inside
 * {@link BridgeTuning.nativeApprovalTimeoutMs}, so it is withdrawn and re-asked
 * here. The last two decide both the chat line's wording (see
 * `BridgeManager.streamPrompt`) and whether a deadline is armed
 * ({@link AgentBridge.handlePermissionRequest}).
 */
export type LedgerFallbackReason = 'no-requester' | 'no-chat-session' | 'unavailable' | 'native-timeout'

/** One recorded ledger fallback: why the ask is here, and the deadline armed for it. */
export interface LedgerFallback {
  reason: LedgerFallbackReason
  /** Effective deadline in ms; `0` = no timer (wait for the human). */
  timeoutMs: number
  /**
   * How long the NATIVE route waited before withdrawing this ask, on the
   * `native-timeout` path only. The chat line reports it as an observed fact
   * ("no answer in the conversation within Ns") rather than guessing a cause:
   * a slow human and a host that never rendered the question look identical
   * from here.
   */
  waitedMs?: number
}

/**
 * Asks the host approval service (`ctx.approval`) for one decision. Never
 * throws: any failure is reported as `'unavailable'` so the caller can fall
 * back to the settings-panel ledger.
 */
export type ApprovalRequester = (request: ApprovalRequestContext) => Promise<ApprovalOutcome>

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

const DEFAULT_TUNING: Required<BridgeTuning> = {
  startupTimeoutMs: 60_000,
  permissionTimeoutMs: 0,
  permissionFallbackTimeoutMs: 300_000,
  nativeApprovalTimeoutMs: 300_000,
  cancelFallbackMs: 15_000,
  staleCancelRetryDelayMs: 600,
  staleCancelMaxRetries: 2,
  turnSettleMs: 5_000,
  idleTimeoutMs: 1_800_000,
  probeIdleTimeoutMs: 300_000,
}

type BridgeState = 'stopped' | 'starting' | 'ready' | 'error'

export class AgentBridge {
  state: BridgeState = 'stopped'
  initResult?: InitializeResponse
  lastError?: string
  stderrTail: string[] = []

  private child?: ChildProcess
  private conn?: ClientConnection
  private starting?: Promise<void>
  private readonly sessions = new Map<string, LiveSession>()
  private readonly acpIndex = new Map<string, LiveSession>()
  /** Sessions whose process died but whose ACP id can be resumed via `session/load`. */
  private readonly released = new Map<string, LiveSession>()
  /** Inflight `session/load` resumes, shared so concurrent prompts don't double-resume. */
  private readonly resuming = new Map<string, Promise<LiveSession>>()
  readonly permissions = new PermissionLedger()
  /**
   * Why each outstanding ledger ask is on the ledger, keyed by request id and
   * recorded before the `permission/request` broadcast (the hub is
   * synchronous, so a subscriber can read it the moment the frame goes out).
   * Entries live exactly as long as the ask: the ledger's resolve callback
   * deletes them, and every terminal path (answer, timeout, session close,
   * process death) resolves through it.
   */
  private readonly ledgerFallbacks = new Map<string, LedgerFallback>
  private readonly startupTimeoutMs: number
  private readonly permissionTimeoutMs: number
  private readonly permissionFallbackTimeoutMs: number
  private readonly nativeApprovalTimeoutMs: number
  private readonly cancelFallbackMs: number
  private readonly staleCancelRetryDelayMs: number
  private readonly staleCancelMaxRetries: number
  private readonly turnSettleMs: number
  private readonly defaultIdleTimeoutMs: number
  private readonly probeIdleTimeoutMs: number
  /** Armed while READY; fires the idle-release check. */
  private idleTimer?: ReturnType<typeof setTimeout>
  /** Last observable activity; the idle window is measured from here. */
  private lastActivityAt = 0
  /** Throwaway catalog probes in flight — they hold no live session of their own. */
  private pendingProbes = 0
  /** Host→agent session commands in flight (mode / config); not turns. */
  private pendingCommands = 0
  /**
   * Whether a REAL session has ever been registered on this bridge. Probes
   * bypass session bookkeeping, so a bridge that has never hosted anything was
   * spawned by a probe and honors {@link probeIdleTimeoutMs}; the first
   * registered session flips it to the agent's own residency semantics.
   */
  private everHostedSession = false
  /** cwd the CURRENT child was spawned with (undefined while there is no child). */
  private spawnCwd?: string
  /**
   * Workspace a chat session wants the agent PROCESS to run in (see
   * `ensureReady`). Some agents fix their whole workspace at process start —
   * cwd-derived project state, the environment block they show the model, the
   * files their tools may touch — so `session/new`'s cwd arrives too late for
   * them (observed on codebuddy: it logs `Workspace Path: <process cwd>` before
   * any ACP request is read). For those agents the spawn cwd is the only lever
   * there is.
   */
  private wantedSpawnCwd?: string

  constructor(
    readonly def: AcpAgentDef,
    private readonly hub: EventHub,
    private readonly transcriptMax: number,
    /** Called when the connection dies so the manager can settle outstanding prompts. */
    private readonly onConnectionLost: (bridge: AgentBridge, reason: string) => void,
    /**
     * Observes `configOptions` from any real session so the manager's model
     * catalog stays warm. `shapeOnly` marks a per-session answer (a
     * `session/set_config_option` response): only the option SHAPE belongs in
     * the agent-level catalog, never its `currentValue` — see
     * {@link BridgeManager.absorbCatalogShape}.
     */
    private readonly onCatalog?: (agentId: string, configOptions: unknown, shapeOnly?: boolean) => void,
    /** Observes `availableCommands` from any real session so the agent's slash menu survives its sessions. */
    private readonly onCommands?: (agentId: string, commands: NonNullable<SessionView['availableCommands']>) => void,
    tuning?: BridgeTuning,
    /**
     * Resolved per ask (not captured) so a requester wired after this bridge
     * was built still applies. Absent → every ask rides the ledger.
     */
    private readonly approvalRequester?: () => ApprovalRequester | undefined,
    /**
     * Resolved per turn, like {@link approvalRequester}: the host entry may
     * wire the access-mode mapping after this bridge was built.
     */
    private readonly sessionWorkspace?: () => SessionWorkspaceResolver | undefined,
  ) {
    const merged = { ...DEFAULT_TUNING, ...tuning }
    this.startupTimeoutMs = merged.startupTimeoutMs
    this.permissionTimeoutMs = merged.permissionTimeoutMs
    this.permissionFallbackTimeoutMs = merged.permissionFallbackTimeoutMs
    this.nativeApprovalTimeoutMs = merged.nativeApprovalTimeoutMs
    this.cancelFallbackMs = merged.cancelFallbackMs
    this.staleCancelRetryDelayMs = merged.staleCancelRetryDelayMs
    this.staleCancelMaxRetries = merged.staleCancelMaxRetries
    this.turnSettleMs = merged.turnSettleMs
    this.defaultIdleTimeoutMs = merged.idleTimeoutMs
    this.probeIdleTimeoutMs = merged.probeIdleTimeoutMs
  }

  /**
   * The idle-release window this agent honors for its CHAT process: its own
   * field, else the host default. This is the number the panel prefills and
   * displays (`AgentView.idleTimeoutMs`), so it must keep meaning "the chat
   * residency the user configured" even while the current child is a probe
   * spawn that will actually die much sooner.
   */
  private get idleTimeoutMs(): number {
    return this.def.idleTimeoutMs ?? this.defaultIdleTimeoutMs
  }

  /**
   * The window that governs THIS child right now. A bridge that has never
   * hosted a real session exists only because a probe spawned it, and a probe
   * process has no stake in how long a CHAT process may wait for its next
   * message — it gets the short probe window unconditionally (even when
   * `def.idleTimeoutMs` asks for permanent residency, which is a promise about
   * the chat process). The first registered session flips the bridge to the
   * agent's own semantics.
   */
  private get currentIdleTimeoutMs(): number {
    if (!this.everHostedSession) return this.probeIdleTimeoutMs
    return this.idleTimeoutMs
  }

  /**
   * Restart the idle-release clock. Every observable activity calls this, so a
   * bridge is only ever released after a FULL quiet window — never while it is
   * being used. Rescheduling here keeps the window measured from the LATEST
   * activity; letting an already-armed timer fire early would not.
   */
  private touch(): void {
    this.lastActivityAt = Date.now()
    this.clearIdleTimer()
    this.armIdleRelease()
  }

  /**
   * Arm the single idle timer for a full window from the last activity. The
   * callback re-checks {@link canIdleRelease} anyway, so a late activity that
   * lands while it runs can only postpone the release.
   */
  private armIdleRelease(): void {
    if (this.currentIdleTimeoutMs <= 0 || this.state !== 'ready' || this.idleTimer !== undefined) return
    const timer = setTimeout(() => {
      this.idleTimer = undefined
      this.releaseIfIdle()
    }, Math.max(0, this.lastActivityAt + this.currentIdleTimeoutMs - Date.now()))
    timer.unref?.()
    this.idleTimer = timer
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /**
   * Release a READY agent that has been quiet for a full window. The window is
   * {@link currentIdleTimeoutMs}: the short probe window for a child that has
   * never hosted a session (model-catalog probes and post-save probes spawn
   * exactly such children, see {@link probeConfigOptions}), the agent's own
   * residency window once a real session has landed.
   *
   * Scoped to bridges with no ACTIVE work, not merely no live session: an idle
   * conversation should not keep a process resident forever. Releasing parks its
   * sessions as `released` (not closed), and the next prompt resumes them on a
   * fresh child through `session/load` — the same path a crash uses.
   *
   * `releaseAll` (not `stop`) is the right teardown: `stop` drops resumable
   * records, which would destroy the context of sessions parked by an earlier
   * crash just because this bridge went quiet.
   *
   * The teardown is SILENT by design: an idle release is the expected lifecycle
   * of a resting process, not a fault — the panel's status simply falls back to
   * "configured", and a notice would only train the user to ignore notices.
   * Abnormal disappearances (crashes) surface through `session/released`
   * events instead.
   */
  private releaseIfIdle(): void {
    if (this.state !== 'ready') return
    if (!this.canIdleRelease()) {
      // Busy after all: the quiet window starts now, not at the last event.
      this.touch()
      return
    }
    this.releaseAll(`agent "${this.def.id}" was released after ${String(Math.round(this.currentIdleTimeoutMs / 1000))}s idle`)
  }

  /**
   * Claim this bridge's single prompt slot for one turn, waiting (bounded) for
   * a predecessor the agent has not finished yet.
   *
   * WHY the wait: `onAbort` finishes OUR stream the moment the user hits stop,
   * but the cancel is a notification the agent may not have processed yet. A
   * prompt sent into that window is a second concurrent `session/prompt` on the
   * same session — forbidden by the protocol and rejected (or worse, mishandled)
   * by the agent. Waiting turns a protocol error into a short delay.
   *
   * @param session - the session asking for the slot.
   * @returns whether the slot was claimed, and why not when it was not.
   */
  async claimTurn(session: LiveSession): Promise<{ ok: true } | { ok: false; reason: 'busy' | 'unsettled' }> {
    if (session.running) return { ok: false, reason: 'busy' }
    const pending = session.settled
    if (pending === undefined) return { ok: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        pending,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, this.turnSettleMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    // The agent never acknowledged: sending now would start a concurrent turn,
    // so report it honestly instead of handing the agent two prompts at once.
    if (session.settled !== undefined) return { ok: false, reason: 'unsettled' }
    if (session.running) return { ok: false, reason: 'busy' }
    return { ok: true }
  }

  /**
   * Mark the agent-side turn as in flight and hand back the settler its stream
   * owner must call once the agent is actually done with it.
   *
   * @param session - the session whose turn is starting.
   * @returns the settler (idempotent; also used by connection loss).
   */
  beginTurn(session: LiveSession): () => void {
    let settle: () => void = () => { /* replaced below */ }
    const settled = new Promise<void>(resolve => { settle = resolve })
    session.settled = settled
    session.settledResolve = settle
    this.touch()
    return () => {
      if (session.settled === settled) {
        session.settled = undefined
        session.settledResolve = undefined
      }
      settle()
      // The turn is over: a fresh window starts here rather than at the prompt
      // that may have started a long time ago.
      this.touch()
    }
  }

  view(): AgentView {
    return {
      id: this.def.id,
      title: this.def.title ?? this.def.id,
      command: this.def.command,
      args: [...(this.def.args ?? [])],
      cwd: this.def.cwd,
      allowedCwdRoots: [...(this.def.allowedCwdRoots ?? [])],
      state: this.state,
      ...(this.state === 'error' ? { stderrTail: [...this.stderrTail] } : {}),
      agentInfo: this.initResult?.agentInfo
        ? {
          name: this.initResult.agentInfo.name,
          title: this.initResult.agentInfo.title ?? undefined,
          version: this.initResult.agentInfo.version,
        }
        : undefined,
      agentCapabilities: this.initResult?.agentCapabilities,
      liveSessions: [...this.sessions.keys()],
      idleTimeoutMs: this.idleTimeoutMs,
    }
  }

  /**
   * Work a teardown would interrupt: a turn in flight (or one the agent is
   * still settling after an abort), a permission ask waiting for an answer, a
   * probe, a resume, or a start. A registered-but-idle session is NOT work.
   */
  private hasActiveWork(): boolean {
    if (this.pendingProbes > 0
      || this.pendingCommands > 0
      || this.resuming.size > 0
      || this.permissions.sessionIds().length > 0
      || this.starting !== undefined) return true
    for (const session of this.sessions.values()) {
      if (session.running || session.settled !== undefined) return true
    }
    return false
  }

  /**
   * Nothing depends on this child's identity right now: no live session and no
   * work. This is the WORKSPACE MOVE's predicate. It stays stricter than the
   * idle release on purpose: an idle live session still pins the process to its
   * spawn cwd (see `ensureReady`), so moving would trade workspace-aware agent
   * state for a restart on every cross-workspace turn.
   */
  private isQuiet(): boolean {
    return this.sessions.size === 0 && !this.hasActiveWork()
  }

  /**
   * An idle teardown is safe when nothing is WORKING. Idle live sessions do not
   * block it: `releaseAll` parks them as `released` (never closed), and the next
   * prompt brings them back with `session/load`. The exception is an agent that
   * does not advertise `loadSession`: releasing would lose a conversation it
   * cannot reload, so there the old session-less rule stands.
   */
  private canIdleRelease(): boolean {
    if (this.hasActiveWork()) return false
    return this.sessions.size === 0 || this.initResult?.agentCapabilities?.loadSession === true
  }

  /**
   * Memoized spawn + `initialize`; failures reset so the next call can retry.
   *
   * @param spawnCwd - the workspace the caller needs the PROCESS to run in; a
   *   chat session passes its DSH session workspace. A ready child cannot be
   *   moved (its cwd is fixed at spawn), so a quiet bridge — nothing above to
   *   lose — is restarted in the wanted workspace instead of inheriting the
   *   directory some probe happened to spawn it in. A busy bridge keeps the
   *   child it has: `session/new` still tells the agent where that session
   *   lives, and killing a live conversation to move a process never is worth
   *   it.
   */
  ensureReady(spawnCwd?: string): Promise<void> {
    if (spawnCwd !== undefined) {
      this.wantedSpawnCwd = spawnCwd
      if (this.state === 'ready' && this.conn !== undefined && this.spawnCwd !== spawnCwd && this.isQuiet()) {
        const reason = `agent "${this.def.id}" restarts in ${spawnCwd} (the workspace of the session using it)`
        this.hub.broadcast({ type: 'agent/notice', agentId: this.def.id, level: 'info', text: `acp: ${reason}` })
        this.releaseAll(reason)
      }
    }
    if (this.state === 'ready' && this.conn !== undefined) return Promise.resolve()
    if (this.starting !== undefined) return this.starting
    this.state = 'starting'
    this.publishStatus()
    this.starting = this.spawnAndConnect()
      .then(() => {
        this.state = 'ready'
        this.lastError = undefined
        this.publishStatus()
        // Start the idle clock only from a READY process: `starting` may take
        // the whole startup budget and must not race the release.
        this.touch()
      })
      .catch((error: unknown) => {
        this.state = 'error'
        this.lastError = error instanceof Error ? error.message : String(error)
        this.clearIdleTimer()
        this.killChild()
        this.publishStatus()
        throw new AcpError('agent_unreachable', `acp: agent "${this.def.id}" failed to start: ${this.lastError}`)
      })
      .finally(() => { this.starting = undefined })
    return this.starting
  }

  private async spawnAndConnect(): Promise<void> {
    this.stderrTail = []
    // Resolve (and, with npmPackage, auto-install) the executable before the
    // spawn; the resolved absolute path also pins the lookup to the host PATH
    // plus the well-known extra dirs, not the child env the agent may override.
    const { command } = await ensureAgentExecutable(this.def, undefined, line => this.noteStderr(line))
    const cwd = safeSpawnCwd(this.def, this.wantedSpawnCwd)
    this.spawnCwd = cwd
    const launch = windowsShimLaunch(command, this.def.args ?? [])
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: childEnv(process.env, this.def.env ?? {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: false,
      // A console child of a GUI host (the desktop app) would otherwise pop a
      // console window on every spawn.
      windowsHide: true,
      ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    })
    this.child = child
    child.on('error', (error) => {
      // Identity guard: a stale event from a PREVIOUS child must not tear down
      // a connection that replaced it (an `exit` can land after the respawn
      // already started and would otherwise kill the fresh process).
      if (this.child !== child) return
      this.noteStderr(`spawn error: ${error.message}`)
      if (this.state !== 'stopped') this.onConnectionLost(this, `spawn error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return // stale event from a replaced child
      this.noteStderr(`[process exited code=${String(code)} signal=${String(signal)}]`)
      if (this.state === 'ready' || this.state === 'starting') {
        this.onConnectionLost(this, `agent process exited (code=${String(code)}, signal=${String(signal)})`)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) this.noteStderr(line)
    })
    if (child.stdin === null || child.stdout === null) {
      throw new Error('agent child dropped piped stdio')
    }
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const app = client({ name: 'dsh-ntr' })
      .onNotification(methods.client.session.update, ctx => {
        this.handleSessionUpdate(ctx.params)
      })
      .onRequest(methods.client.session.requestPermission, async ctx => {
        return this.handlePermissionRequest(ctx.params.sessionId, ctx.params.toolCall, ctx.params.options, ctx.signal)
      })
      .onRequest(methods.client.fs.readTextFile, async ctx => this.handleFsRead(ctx.params))
      .onRequest(methods.client.fs.writeTextFile, async ctx => this.handleFsWrite(ctx.params))
    const conn = app.connect(stream)
    this.conn = conn
    void conn.closed.then(() => {
      if (this.conn === conn && (this.state === 'ready')) {
        this.onConnectionLost(this, 'ACP connection closed')
      }
    })
    const init = await this.withStartupTimeout(
      conn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // The fs handlers are implemented below behind the same workspace
        // sandbox that gates session cwds; terminal is not implemented.
        // `session.configOptions.boolean` advertises the toggle form of
        // `configOptions`; agents that gate `type: "boolean"` entries on it
        // would otherwise never publish them.
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: 'dsh-ntr', title: 'DSH NTR', version: '0.1.0' },
      }),
      'initialize',
    )
    this.initResult = init
  }

  /**
   * Bound one agent-startup request (`initialize`, `session/new`,
   * `session/load`). The SDK's `cancellationSignal` is cooperative — a wedged
   * agent never answers `$/cancel_request` either — so the only real timeout
   * is a race, and the losing call tears the child down: a process that stops
   * answering protocol requests is dead for every session it owns.
   */
  private withStartupTimeout<T>(request: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.killChild()
        reject(new AcpError('agent_timeout', `acp: agent "${this.def.id}" did not answer ${what} within ${String(this.startupTimeoutMs)}ms${this.stderrTail.length > 0 ? `; stderr: ${this.stderrTail.slice(-5).join(' | ')}` : ''}`))
      }, this.startupTimeoutMs)
      timer.unref?.()
    })
    return Promise.race([request, timeout]).finally(() => {
      clearTimeout(timer)
      // The losing request may still reject when the child is torn down below.
      void request.catch(() => { /* already surfaced through the timeout path */ })
    })
  }

  private noteStderr(line: string): void {
    if (line === '') return
    // Stderr is what a misbehaving agent says about itself: keep the whole line
    // (a stack trace or an activation error is exactly the line that gets cut).
    this.stderrTail.push(line)
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES)
  }

  private publishStatus(): void {
    this.hub.broadcast({ type: 'agent/status', agentId: this.def.id, state: this.state, ...(this.lastError === undefined ? {} : { error: this.lastError }), agent: this.view() })
  }

  /**
   * @param cwd - the ACP session's cwd (validated against the agent's roots).
   * @param extraRoots - roots trusted for THIS session only (a chat session's
   *   DSH workspace; see `resolveSessionCwd`).
   * @param spawnCwd - where the agent PROCESS should run; see `ensureReady`.
   */
  async createSession(cwd: string | undefined, extraRoots: readonly string[] = [], spawnCwd?: string): Promise<LiveSession> {
    await this.ensureReady(spawnCwd)
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    const resolved = resolveSessionCwd(this.def, cwd, p => realpathSync(p), extraRoots)
    const result = await this.withStartupTimeout(
      conn.agent.request(methods.agent.session.new, { cwd: resolved, mcpServers: [] }),
      'session/new',
    )
    // An empty `configOptions` answer is a non-answer — see `usableConfigOptions`.
    if (this.onCatalog !== undefined && usableConfigOptions(result.configOptions)) {
      this.onCatalog(this.def.id, result.configOptions)
    }
    const session: LiveSession = {
      sessionId: randomUUID(),
      agentId: this.def.id,
      acpSessionId: result.sessionId,
      cwd: resolved,
      running: false,
      turnSeq: 0,
      closed: false,
      released: false,
      transcript: new Transcript(this.transcriptMax),
      ...(result.modes !== undefined && result.modes !== null
        ? {
          modes: {
            currentModeId: result.modes.currentModeId,
            availableModes: result.modes.availableModes.map(m => ({
              id: m.id,
              name: m.name,
              ...(m.description !== null ? { description: m.description } : {}),
            })),
          },
        }
        : {}),
      ...(usableConfigOptions(result.configOptions) ? { configOptions: result.configOptions } : {}),
    }
    this.sessions.set(session.sessionId, session)
    this.acpIndex.set(session.acpSessionId, session)
    // First real session on this bridge: from here the process lives by the
    // agent's own residency rules, not the probe window it was born under.
    // Any armed timer computed its delay from the old window — drop it so the
    // touch below re-arms with the effective one.
    this.clearIdleTimer()
    this.everHostedSession = true
    this.hub.broadcast({ type: 'session/created', sessionId: session.sessionId, session: snapshot(session) })
    this.touch()
    return session
  }

  /**
   * Spawn a throwaway ACP session purely to read its `configOptions` (the
   * model catalog probe). Deliberately bypasses the live-session bookkeeping
   * so probe sessions never surface in the browser session list.
   */
  async probeConfigOptions(): Promise<unknown[]> {
    // A probe is the reason an agent process can be resident with NOTHING else
    // going on: it opens a session it deliberately never registers, so the
    // probe itself is the only thing keeping it from being idle-released.
    this.pendingProbes += 1
    try {
      await this.ensureReady()
      const conn = this.conn
      if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
      const resolved = resolveSessionCwd(this.def, undefined, p => realpathSync(p))
      const result = await this.withStartupTimeout(
        conn.agent.request(methods.agent.session.new, { cwd: resolved, mcpServers: [] }),
        'session/new',
      )
      await conn.agent.request(methods.agent.session.close, { sessionId: result.sessionId }).catch(() => { /* optional capability */ })
      return Array.isArray(result.configOptions) ? result.configOptions : []
    } finally {
      this.pendingProbes -= 1
      this.touch()
    }
  }

  /**
   * Fire one prompt turn. Returns after the agent settles the turn; the caller
   * (manager) keeps the UI informed through broadcast events, so the RPC that
   * started the turn can answer `accepted` immediately.
   *
   * A `cancelled` stop on a turn the user never cancelled is the stale-cancel
   * swallow (the agent is still cleaning up the PREVIOUS cancel and answers
   * the new prompt from it — observed on codebuddy, which drops the message
   * without generating a turn). The same prompt is resent after
   * {@link BridgeTuning.staleCancelRetryDelayMs}, out-waiting the cleanup
   * window, bounded by {@link BridgeTuning.staleCancelMaxRetries}; a genuinely
   * requested cancel (`cancelRequestedAtTurn` still names this generation)
   * returns as-is.
   */
  async runPrompt(session: LiveSession, text: string, turnId: string): Promise<string> {
    const conn = this.conn
    if (conn === undefined || session.closed || session.released) throw new AcpError('session_closed', 'acp: session is closed')
    this.touch()
    for (let attempt = 0; ; attempt += 1) {
      // The response is activity too: the idle window must start at the turn's
      // END, not at the prompt that may have started a long time ago.
      const result = await conn.agent.request(methods.agent.session.prompt, {
        sessionId: session.acpSessionId,
        prompt: [{ type: 'text', text }],
      }).finally(() => { this.touch() })
      if (result.stopReason !== 'cancelled' || session.cancelRequestedAtTurn === session.turnSeq) {
        return result.stopReason
      }
      if (attempt >= this.staleCancelMaxRetries) return result.stopReason
      await new Promise(resolve => setTimeout(resolve, this.staleCancelRetryDelayMs))
      if (session.closed || this.conn !== conn) throw new AcpError('session_closed', 'acp: session is closed')
      this.touch()
    }
  }

  async cancel(session: LiveSession): Promise<void> {
    if (this.conn === undefined) return
    this.touch()
    // Name the generation this cancel belongs to, so `runPrompt` can tell a
    // real cancel apart from a stale one and the fallback timer can tell its
    // own turn apart from a later one.
    session.cancelRequestedAtTurn = session.turnSeq
    await this.conn.agent.notify(methods.agent.session.cancel, { sessionId: session.acpSessionId }).catch(() => { /* best effort */ })
    // The ACP spec's counterpart to the notification we just sent: a client that
    // cancels MUST answer every pending `session/request_permission` with
    // `cancelled`. Leaving them open would hold the agent's tool call blocked on
    // an answer that can no longer arrive — the turn is over, the human's
    // decision is "stop". OmniTerm does the same from `AcpClient::cancel`
    // (`PermissionManager::cancel_all`).
    this.settlePermissions(session)
    this.armCancelFallback(session)
  }

  /**
   * An agent that ignores the `session/cancel` notification must not wedge the
   * session in `running` forever (every later prompt would fail with
   * `turn_in_flight`), nor leave the adapter turn's settle gate hanging (every
   * later prompt would fail with `unsettled`). Force-finalize the turn after
   * the grace period; the real `session/prompt` response may still arrive
   * later and is folded in by the manager as usual.
   *
   * The timer is generation-guarded: it belongs to the turn `cancel` was
   * called for. If that turn already ended and a LATER turn is on air (the
   * agent settled late, the user moved on), firing would murder the innocent
   * successor — so a moved-on {@link LiveSession.turnSeq} disarms it.
   */
  private armCancelFallback(session: LiveSession): void {
    if (this.cancelFallbackMs <= 0) return
    const turnGen = session.turnSeq
    const timer = setTimeout(() => {
      if (session.closed || session.turnSeq !== turnGen) return
      // Nothing is in flight anymore (the turn settled on its own): nothing to
      // finalize. A still-pending settle gate counts as in flight even though
      // the stream is gone — that gate is what the next prompt waits on.
      if (!session.running && session.settled === undefined) return
      session.running = false
      const settle = session.settledResolve
      session.settled = undefined
      session.settledResolve = undefined
      settle?.()
      this.hub.broadcast({
        type: 'turn/end',
        sessionId: session.sessionId,
        turnId: '',
        error: `agent "${this.def.id}" did not respond to the cancel request within ${String(Math.round(this.cancelFallbackMs / 1000))}s; the turn was force-finalized`,
      })
    }, this.cancelFallbackMs)
    timer.unref?.()
  }

  /**
   * Bring a released session back on a fresh agent process via
   * `session/load` ("send to recover"). Concurrent callers share one inflight
   * resume. The agent replays its history as fresh `session/update`s while
   * the load request is still in flight, so the session re-registers with the
   * update router and broadcasts `session/reset` BEFORE the request goes out;
   * on failure the record is parked back into the released map so a later
   * prompt can retry.
   */
  resumeSession(session: LiveSession): Promise<LiveSession> {
    const inflight = this.resuming.get(session.sessionId)
    if (inflight !== undefined) return inflight
    // An inflight resume also counts as work (see `releaseIfIdle`).
    this.touch()
    const promise = this.doResumeSession(session).finally(() => {
      this.resuming.delete(session.sessionId)
    })
    this.resuming.set(session.sessionId, promise)
    return promise
  }

  private async doResumeSession(session: LiveSession): Promise<LiveSession> {
    try {
      // The cwd was validated when the session was created, but allowed roots
      // may have narrowed since; re-check before handing the path back. A chat
      // session's cwd is its DSH workspace (never in the agent's own roots), so
      // that root has to be re-trusted here too — otherwise a crash would park
      // the session in `released` forever with `cwd_denied`. The same workspace
      // is what the resumed process must RUN in, or an agent that reads its
      // workspace from its own cwd would come back in the plugin's sandbox.
      const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspace?.(), session.dshSessionId)
      await this.ensureReady(workspaceRoot)
      // The capability comes from the FRESH initialize: after a crash the
      // bridge restarts the process, so check the (new) initResult here.
      if (this.initResult?.agentCapabilities?.loadSession !== true) {
        throw new AcpError('resume_unsupported', `acp: agent "${this.def.id}" does not advertise the loadSession capability; start a new session`)
      }
      const conn = this.conn
      if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
      const resolved = resolveSessionCwd(this.def, session.cwd, p => realpathSync(p), workspaceRoot === undefined ? [] : [workspaceRoot])
      // Replay arrives as brand-new updates, so the transcript restarts too;
      // seq keeps meaning "position in the current epoch".
      session.transcript = new Transcript(this.transcriptMax)
      session.cwd = resolved
      session.running = false
      session.closed = false
      session.released = false
      // Route replay updates into the fresh transcript while the load request
      // is in flight, and let the browser drop its blocks/watermark first.
      this.acpIndex.set(session.acpSessionId, session)
      this.hub.broadcast({ type: 'session/reset', sessionId: session.sessionId, session: snapshot(session) })
      const result = await this.withStartupTimeout(
        conn.agent.request(methods.agent.session.load, { sessionId: session.acpSessionId, cwd: resolved, mcpServers: [] }),
        'session/load',
      )
      if (this.onCatalog !== undefined && usableConfigOptions(result.configOptions)) {
        this.onCatalog(this.def.id, result.configOptions)
      }
      session.modes = result.modes !== undefined && result.modes !== null
        ? {
          currentModeId: result.modes.currentModeId,
          availableModes: result.modes.availableModes.map(m => ({
            id: m.id,
            name: m.name,
            ...(m.description !== null ? { description: m.description } : {}),
          })),
        }
        : session.modes
      if (usableConfigOptions(result.configOptions)) session.configOptions = result.configOptions
      this.sessions.set(session.sessionId, session)
      this.released.delete(session.sessionId)
      // Same flip as `createSession`: a registered session makes this a chat
      // process; re-arm the idle clock on the agent's own window.
      this.clearIdleTimer()
      this.everHostedSession = true
      this.touch()
      // Republish so configOptions/modes observed on load reach the browser.
      this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
      return session
    } catch (error) {
      this.acpIndex.delete(session.acpSessionId)
      this.sessions.delete(session.sessionId)
      session.released = true
      this.released.set(session.sessionId, session)
      this.hub.broadcast({ type: 'session/released', sessionId: session.sessionId, session: snapshot(session), reason: 'resume failed' })
      throw error
    }
  }

  /** Release all live sessions (process died or went idle): keep them resumable, settle permissions, drop the connection. */
  releaseAll(reason: string): void {
    this.clearIdleTimer()
    for (const session of [...this.sessions.values()]) {
      if (session.running) {
        session.running = false
        this.hub.broadcast({ type: 'turn/end', sessionId: session.sessionId, turnId: '', error: reason })
      }
      session.released = true
      this.settlePermissions(session)
      this.released.set(session.sessionId, session)
      this.hub.broadcast({ type: 'session/released', sessionId: session.sessionId, session: snapshot(session), reason })
    }
    this.sessions.clear()
    this.acpIndex.clear()
    this.conn?.close()
    this.conn = undefined
    this.killChild()
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
  }

  /** Detach one released session record for a resume attempt. */
  takeReleased(sessionId: string): LiveSession | undefined {
    const session = this.released.get(sessionId)
    if (session === undefined) return undefined
    this.released.delete(sessionId)
    return session
  }

  /** Drop a released session record for good (user closed it or the agent was stopped). */
  dropReleased(sessionId: string): boolean {
    return this.released.delete(sessionId)
  }

  get releasedList(): LiveSession[] {
    return [...this.released.values()]
  }

  hasReleased(sessionId: string): LiveSession | undefined {
    return this.released.get(sessionId)
  }

  inflightResume(sessionId: string): Promise<LiveSession> | undefined {
    return this.resuming.get(sessionId)
  }

  /** Run one host→agent command as work, so an idle teardown cannot cut it. */
  private async runCommand<T>(request: () => Promise<T>): Promise<T> {
    this.pendingCommands += 1
    this.touch()
    try {
      return await request()
    } finally {
      this.pendingCommands -= 1
      this.touch()
    }
  }

  async setMode(session: LiveSession, modeId: string): Promise<void> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    await this.runCommand(() => conn.agent.request(methods.agent.session.setMode, { sessionId: session.acpSessionId, modeId }))
    // Well-behaved agents push `current_mode_update`, but the spec does not
    // require it — apply locally so the browser selector never goes stale.
    if (session.modes !== undefined) session.modes = { ...session.modes, currentModeId: modeId }
    this.publishMeta(session)
  }

  async setConfigOption(session: LiveSession, configId: string, value: string | boolean): Promise<void> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    // A toggle must say so on the wire: the request union discriminates on
    // `type`, and a bare boolean `value` is not a select value id.
    const params = typeof value === 'boolean'
      ? { sessionId: session.acpSessionId, configId, value, type: 'boolean' as const }
      : { sessionId: session.acpSessionId, configId, value }
    const result = await this.runCommand(() => conn.agent.request(methods.agent.session.setConfigOption, params)) as { configOptions?: unknown }
    // The response carries the full authoritative option set; some agents
    // (pi-acp observed) never re-notify after a client-driven set. It feeds the
    // SESSION snapshot first — `currentValue` in a per-session answer describes
    // this session's pick, and promoting it to the catalog would turn the
    // seat's own choice into `reasoning.defaultEffort` for every other
    // conversation (and back onto itself next turn). The option SHAPE still
    // reaches the agent-level catalog (`shapeOnly`): this response is often the
    // only place an agent publishes how its option set changes with the model
    // (opencode offers `thought_level` just for models with variants), and the
    // composer's thought chip is driven by the catalog.
    if (usableConfigOptions(result.configOptions)) {
      session.configOptions = result.configOptions
      this.onCatalog?.(this.def.id, result.configOptions, true)
    }
    this.publishMeta(session)
  }

  private publishMeta(session: LiveSession): void {
    this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
  }

  async closeSession(session: LiveSession, reason: 'closed' | 'agent-stopped' | 'agent-died'): Promise<void> {
    if (session.closed) return
    session.closed = true
    // Closing a session is activity of its own: restart the idle window here
    // rather than at the prompt that opened it.
    this.touch()
    const conn = this.conn
    if (conn !== undefined && this.state === 'ready') {
      // `session/close` is an optional capability; the local teardown stands regardless.
      await conn.agent.request(methods.agent.session.close, { sessionId: session.acpSessionId }).catch(() => { /* unsupported */ })
    }
    this.settlePermissions(session)
    this.sessions.delete(session.sessionId)
    this.acpIndex.delete(session.acpSessionId)
    this.hub.broadcast({ type: 'session/closed', sessionId: session.sessionId, reason })
  }

  get sessionList(): LiveSession[] {
    return [...this.sessions.values()]
  }

  hasSession(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** Kill the child and drop every local session bound to this connection. */
  async stop(reason: 'closed' | 'agent-stopped' | 'agent-died' = 'agent-stopped'): Promise<void> {
    this.clearIdleTimer()
    for (const session of [...this.sessions.values()]) {
      await this.closeSession(session, reason)
    }
    // A deliberate stop is not a crash: nothing stays resumable.
    this.released.clear()
    this.conn?.close()
    this.conn = undefined
    this.killChild()
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
  }

  private killChild(): void {
    const child = this.child
    this.child = undefined
    // No child, no recorded spawn cwd: the next spawn decides its own (see
    // `spawnAndConnect`). Leaving it behind would make `ensureReady` believe a
    // process is still running in that directory.
    this.spawnCwd = undefined
    if (child === undefined || child.pid === undefined) return
    try {
      child.stdin?.end()
    } catch { /* already gone */ }
    const pid = child.pid
    if (process.platform === 'win32') {
      // Parity with the POSIX branch below, which kills the whole process
      // GROUP: on Windows "the group" is the process tree, and it has to be
      // killed while the tree is intact — killing the direct child first (a
      // `cmd.exe` shim wrapper, see `windowsShimLaunch`) re-parents the agent
      // out of `taskkill /T`'s reach. `stdin.end()` above is the graceful half.
      killProcessTree(pid)
      return
    }
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch { /* already gone */ }
    }, 3000).unref()
  }

  /**
   * Answer one ACP permission ask. Every ask reaches a human: the native
   * approval chain first (answered in the chat composer), the settings-panel
   * ledger otherwise.
   */
  private async handlePermissionRequest(acpSessionId: string, toolCall: unknown, options: PermissionOption[], signal?: AbortSignal): Promise<RequestPermissionResponse> {
    const session = this.acpIndex.get(acpSessionId)
    if (session === undefined || session.closed) return { outcome: { outcome: 'cancelled' } }
    // Native approval first (answered in the chat composer); a `reason` means
    // no route is available and the settings-panel ledger takes over.
    const native = await this.askNativeApproval(session, toolCall, options, signal)
    if ('response' in native) {
      this.touch()
      return native.response
    }
    return new Promise<RequestPermissionResponse>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const requestId = this.permissions.create(session.sessionId, (outcome: PermissionOutcome) => {
        clearTimeout(timer)
        this.ledgerFallbacks.delete(requestId)
        this.touch()
        this.hub.broadcast({
          type: 'permission/resolved',
          requestId,
          sessionId: session.sessionId,
          outcome,
        })
        resolve(outcome.outcome === 'selected'
          ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
          : { outcome: { outcome: 'cancelled' } })
      }, {
        // Kept for the reconnect replay: a client that connects after the ask
        // was broadcast must be re-shown the very card it has to answer.
        toolCall,
        options: options.map((o): PermissionOptionView => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      })
      // Deadline (`permissionTimeoutMs`): an approval left unanswered is
      // answered `cancelled` on the human's behalf instead of hanging the turn
      // forever. Off by default — approvals belong to a person. The one
      // exception is a DEGRADED native route: the conversation just failed to
      // show the question, so waiting forever would hang the turn behind an
      // ask nobody can see there, and the fallback deadline applies instead
      // (see `BridgeTuning.permissionFallbackTimeoutMs`). `native-timeout` is
      // the same degradation reached from the other side: the host took the
      // ask and never answered it.
      const timeoutMs = this.permissionTimeoutMs > 0
        ? this.permissionTimeoutMs
        : native.reason === 'unavailable' || native.reason === 'native-timeout'
          ? this.permissionFallbackTimeoutMs
          : 0
      // Recorded before the broadcast: the hub is synchronous, and the chat
      // line `streamPrompt` folds from this frame words itself by the path
      // this ask actually took.
      this.ledgerFallbacks.set(requestId, {
        reason: native.reason,
        timeoutMs,
        ...(native.reason === 'native-timeout' ? { waitedMs: this.nativeApprovalTimeoutMs } : {}),
      })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.permissions.has(requestId)) return
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: this.def.id,
            level: 'info',
            // Name what was missed, the way a human needs it: which operation
            // sat unanswered, and for how long (OmniTerm's reaper writes the
            // same "you missed this" notice before it acts).
            text: `acp: permission request for "${permissionToolName(toolCall)}" timed out after ${String(Math.round(timeoutMs / 1000))}s; answered "cancelled"`,
          })
          this.permissions.respond(requestId, { outcome: 'cancelled' })
        }, timeoutMs)
        timer.unref?.()
      }
      this.hub.broadcast({
        type: 'permission/request',
        requestId,
        sessionId: session.sessionId,
        toolCall,
        options: options.map((o): PermissionOptionView => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      })
    })
  }

  /**
   * Why one ledger ask is on the ledger, as recorded by
   * {@link handlePermissionRequest}. The manager's `streamPrompt` reads it to
   * word the chat line by the path the ask took; `undefined` once the ask is
   * answered, timed out, or settled.
   */
  ledgerFallbackOf(requestId: string): LedgerFallback | undefined {
    return this.ledgerFallbacks.get(requestId)
  }

  /**
   * Ask the host approval service for this permission (`ctx.approval` → the
   * browser's composer takeover). Only sessions bound to a DSH chat session
   * qualify: the service appends its audit pair to that session inside an
   * open turn, so a session started over `/acp` (no chat turn) cannot be
   * routed and must stay on the ledger path.
   *
   * The ask is raced against {@link BridgeTuning.nativeApprovalTimeoutMs}. A
   * routed ask has exactly one answer entry — the composer takeover — and no
   * broadcast at all, so a host that takes the question and never renders it
   * would leave the turn hanging behind something invisible. Past the deadline
   * the ask is WITHDRAWN (the signal handed to the host aborts, which settles
   * its waterfall `cancelled` and drops the composer panel) and reported as
   * `native-timeout`, sending the question to the ledger where the chat line
   * and the settings card are both visible. Withdrawing is not answering: a
   * human mid-decision finds the same question in the settings panel.
   *
   * No deadline is armed on the ledger paths (`no-requester`,
   * `no-chat-session`): those never reach the host, and their answer entry is
   * the settings panel the chat line already points at.
   *
   * @returns the agent-facing response, or the reason the ask must fall back
   * to the ledger (see {@link LedgerFallbackReason}).
   */
  private async askNativeApproval(
    session: LiveSession,
    toolCall: unknown,
    options: PermissionOption[],
    signal?: AbortSignal,
  ): Promise<{ response: RequestPermissionResponse } | { reason: LedgerFallbackReason }> {
    const requester = this.approvalRequester?.()
    if (requester === undefined) return { reason: 'no-requester' }
    if (session.dshSessionId === undefined) return { reason: 'no-chat-session' }
    // One signal carries both withdrawals: the agent's own cancel (whatever
    // aborted the ACP request) and the deadline. The host's waterfall races its
    // answerers against this signal, so aborting is a clean withdrawal rather
    // than a leak.
    const withdraw = new AbortController()
    const askSignal = signal === undefined ? withdraw.signal : AbortSignal.any([signal, withdraw.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const deadline = this.nativeApprovalTimeoutMs > 0
      ? new Promise<{ timedOut: true }>(resolve => {
        timer = setTimeout(() => {
          timedOut = true
          withdraw.abort()
          resolve({ timedOut: true })
        }, this.nativeApprovalTimeoutMs)
        timer.unref?.()
      })
      : undefined
    let outcome: ApprovalOutcome
    try {
      const asked = requester({
        dshSessionId: session.dshSessionId,
        agentId: this.def.id,
        toolName: permissionToolName(toolCall),
        signal: askSignal,
      })
      // A withdrawn ask settles on the host's own schedule; dropping it here
      // must not surface as an unhandled rejection later.
      asked.catch(() => { /* withdrawn: the ledger owns this ask now */ })
      const settled = deadline === undefined
        ? await asked.then(o => ({ outcome: o }))
        : await Promise.race([asked.then(o => ({ outcome: o })), deadline])
      // The flag, not the race winner, decides: the host may settle `cancelled`
      // from the very abort the deadline caused, and that is still a timeout.
      if (timedOut || 'timedOut' in settled) return { reason: 'native-timeout' }
      outcome = settled.outcome
    } catch {
      // Synchronous throw or rejection, either way: the ask falls back to the
      // ledger. An approval failure must never break the agent's turn.
      outcome = 'unavailable'
    } finally {
      clearTimeout(timer)
    }
    if (outcome === 'unavailable') return { reason: 'unavailable' }
    const response = nativeOutcomeResponse(outcome, options)
    // Keep the event stream symmetric with the ledger path: a routed decision
    // is still a resolution, and the browser uses it to drop any card it may
    // hold for this session. No `permission/request` is broadcast — the
    // settings panel must never show a card for a composer-routed ask.
    this.hub.broadcast({
      type: 'permission/resolved',
      requestId: randomUUID(),
      sessionId: session.sessionId,
      outcome: response.outcome.outcome === 'selected'
        ? { outcome: 'selected', optionId: response.outcome.optionId }
        : { outcome: 'cancelled' },
    })
    return { response }
  }

  private settlePermissions(session: LiveSession): void {
    this.permissions.settleFor(p => p.sessionId === session.sessionId)
  }

  /** `fs/read_text_file` for agents that fetch workspace content through the
   * client. Every path passes the same workspace guard as session cwds
   * (resolveFsPath); violations answer as JSON-RPC internal errors so the
   * agent sees a refusal instead of file contents.
   */
  private handleFsRead(params: { sessionId: string; path: string; line?: number | null; limit?: number | null }): { content: string } {
    const session = this.acpIndex.get(params.sessionId)
    if (session === undefined) {
      throw fsRequestError(`acp: fs request for unknown session ${params.sessionId}`)
    }
    const path = this.guardFsPath(session, params.path)
    if (statSync(path).size > FS_MAX_READ_BYTES) {
      throw fsRequestError(`acp: fs read refused: ${path} exceeds ${String(FS_MAX_READ_BYTES)} bytes; page with line/limit or read smaller files`)
    }
    let content = readFileSync(path, 'utf8')
    if (params.line != null || params.limit != null) {
      const lines = content.split('\n')
      const start = Math.max(0, (params.line ?? 1) - 1)
      const end = params.limit != null ? start + params.limit : lines.length
      content = lines.slice(start, end).join('\n')
    }
    return { content }
  }

  /**
   * `fs/write_text_file`; parent directories are created inside the boundary.
   *
   * The workspace guard (`guardFsPath`) is the only fence, and it is the one
   * that has always applied: a write outside the session's resolved roots is
   * refused. There is deliberately NO extra access-mode layer — DSH's sandbox
   * cannot reach into the agent's own process, so a second gate here would only
   * be a fiction in front of a tool that can write without asking us at all.
   * What the agent chooses to ask about goes to the human unchanged
   * (`askNativeApproval`). See docs/acp-convergence.md §2.3.
   */
  private async handleFsWrite(params: { sessionId: string; path: string; content: string }): Promise<{ }> {
    const session = this.acpIndex.get(params.sessionId)
    if (session === undefined) {
      throw fsRequestError(`acp: fs request for unknown session ${params.sessionId}`)
    }
    if (params.content.length > FS_MAX_WRITE_BYTES) {
      throw fsRequestError(`acp: fs write refused: payload exceeds ${String(FS_MAX_WRITE_BYTES)} bytes`)
    }
    const path = this.guardFsPath(session, params.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, params.content, 'utf8')
    return { }
  }

  private guardFsPath(session: LiveSession, requested: string): string {
    try {
      return resolveFsPath(session.cwd, [...(this.def.allowedCwdRoots ?? []), session.cwd], requested, p => realpathSync(p))
    } catch (error) {
      throw fsRequestError(`acp: fs access denied: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const session = this.acpIndex.get(params.sessionId)
    if (session === undefined) return // update for a session already closed locally
    this.applyDerived(session, params.update)
    const seq = session.transcript.append(params.update)
    this.hub.broadcast({ type: 'session/update', sessionId: session.sessionId, seq, update: params.update })
  }

  private applyDerived(session: LiveSession, update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'current_mode_update':
        session.modes = { ...session.modes, currentModeId: update.currentModeId }
        break
      case 'config_option_update':
        // Empty answers never overwrite the last known set — see `usableConfigOptions`.
        if (!usableConfigOptions(update.configOptions)) break
        session.configOptions = update.configOptions
        this.onCatalog?.(this.def.id, session.configOptions)
        break
      case 'available_commands_update':
        // Spread the whole command, not just name+description: the protocol
        // grows fields (and agents already send `input` hints), and a room the
        // picker has no widget for is still something the agent declared.
        const commands = update.availableCommands.map(c => ({
          ...(c as unknown as Record<string, unknown>),
          ...(c.description !== null && c.description !== undefined ? { description: c.description } : {}),
        })) as NonNullable<SessionView['availableCommands']>
        session.availableCommands = commands
        this.onCommands?.(this.def.id, commands)
        break
      case 'plan':
        session.plan = update.entries
        break
      case 'usage_update':
        session.usage = {
          used: update.used,
          size: update.size,
          ...(update.cost !== undefined && update.cost !== null
            ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
            : {}),
        }
        break
      case 'session_info_update':
        if (update.title !== undefined && update.title !== null) session.title = update.title
        break
      default:
        break
    }
  }
}

/** Human-facing identity of an ACP tool call (the approval headline). */
/**
 * Human-facing name of the tool an ask is about, for the chat line and the
 * timeout notice.
 *
 * The ACP `toolCall.title` is the declared field, but it is OPTIONAL and real
 * agents omit it: codebuddy puts the name in `_meta["codebuddy.ai/toolName"]`
 * (observed live — without the fallback the notice reads `for "tool call"`,
 * which tells the human nothing about what they missed). So read `title` first,
 * then any `_meta` key whose last segment is `toolName`, then the standard
 * `kind`, and only then give up with the generic phrase. Nothing is invented:
 * every step reads a key the agent itself declared.
 */
export function permissionToolName(toolCall: unknown): string {
  const row = (typeof toolCall === 'object' && toolCall !== null ? toolCall : {}) as Record<string, unknown>
  if (typeof row.title === 'string' && row.title !== '') return row.title
  const meta = (typeof row._meta === 'object' && row._meta !== null ? row._meta : {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(meta)) {
    const segment = key.split('/').at(-1) ?? key
    if (segment.toLowerCase() === 'toolname' && typeof value === 'string' && value !== '') return value
  }
  if (typeof row.kind === 'string' && row.kind !== '') return row.kind
  return 'tool call'
}

/**
 * Translate a native approval outcome into the ACP option the agent must see.
 * `'allowed-once'` is the chain's only grant; a rejection prefers the once-variant.
 */
function nativeOutcomeResponse(outcome: ApprovalOutcome, options: PermissionOption[]): RequestPermissionResponse {
  if (outcome === 'allowed-once') {
    const allow = options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind === 'allow_always')
    return allow === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: allow.optionId } }
  }
  if (outcome === 'rejected') {
    const reject = options.find(o => o.kind === 'reject_once') ?? options.find(o => o.kind === 'reject_always')
    return reject === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: reject.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

function snapshot(session: LiveSession): SessionView {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    acpSessionId: session.acpSessionId,
    cwd: session.cwd,
    ...(session.title !== undefined ? { title: session.title } : {}),
    ...(session.modes !== undefined ? { modes: session.modes } : {}),
    ...(session.configOptions !== undefined ? { configOptions: session.configOptions } : {}),
    ...(session.availableCommands !== undefined ? { availableCommands: session.availableCommands } : {}),
    ...(session.plan !== undefined ? { plan: session.plan } : {}),
    ...(session.usage !== undefined ? { usage: session.usage } : {}),
    running: session.running,
    closed: session.closed,
    ...(session.released ? { released: true } : {}),
    seq: session.transcript.head,
  }
}

/**
 * The DSH chat session's OWN workspace, when one is resolvable: the directory
 * the user selected in the DSH sidebar, which the host reports back as the
 * session policy's `workspaceRoot` (it is the session header cwd). This is what
 * a chat session's ACP cwd must be, so it deliberately outranks the agent's
 * configured `cwd` — that field is the plugin's own sandbox directory, not the
 * place the conversation lives.
 *
 * Never throws: a broken/absent resolver, an unknown session (an `/acp`-RPC
 * session) or a host that reports no root all read as `undefined`, and the
 * caller falls back to the agent's configured cwd.
 */
function chatWorkspaceRoot(resolver: SessionWorkspaceResolver | undefined, dshSessionId: string | undefined): string | undefined {
  if (resolver === undefined || dshSessionId === undefined) return undefined
  try {
    const root = resolver(dshSessionId)?.workspaceRoot
    return root === undefined || root === '' ? undefined : root
  } catch {
    return undefined
  }
}

/** Canonical spelling of a configured root, or the spelling as-is when it does not exist yet. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Where the agent process itself starts.
 *
 * `wanted` (a chat session's DSH workspace, see `ensureReady`) wins over the
 * agent's configured `cwd`: some agents derive their ENTIRE notion of "the
 * project" from the directory they were started in — their file fences, the
 * environment block they show the model, their per-project state — so a process
 * started in the plugin's sandbox answers "my workspace is
 * ~/.dsh/dsh-ntr/workspaces" no matter what `session/new` said (observed on
 * codebuddy). `def.cwd` remains the answer for everything that has no DSH
 * session behind it (probes, `/acp`-RPC sessions, the settings-page test).
 */
function safeSpawnCwd(def: AcpAgentDef, wanted?: string): string {
  const configured = def.cwd ?? ensureDefaultWorkspace()
  for (const candidate of wanted === undefined ? [configured] : [wanted, configured]) {
    try {
      if (statSync(candidate).isDirectory()) return realpathSync(candidate)
    } catch { /* not usable — try the next candidate */ }
  }
  return homedir()
}

/**
 * This plugin's OWN state directory, `~/.dsh/dsh-ntr`.
 *
 * Everything this plugin persists belongs in here — the agent registry, the
 * probed model catalog, and the default ACP execution workspaces. `~/.dsh` is
 * the HOST's shared root: it holds the host's own `sessions/`, `storages/`,
 * `skills/`, `profiles/`, credentials and so on. Dropping a plugin's files
 * loose in there makes them indistinguishable from the host's state, and two
 * unrelated `acp-*.json` names at that level read as host config to anyone
 * (user or agent) looking at the directory. One owner, one subdirectory —
 * same convention `~/.dsh/skills/<owner>` and `~/.dsh/dsh-runtimes/<owner>`
 * already follow.
 *
 * `DSH_NTR_STATE_DIR` overrides the location (tests, and power users with a
 * relocated state root).
 */
export function pluginStateDir(home: string = homedir()): string {
  const override = process.env.DSH_NTR_STATE_DIR
  if (override !== undefined && override !== '') return override
  return join(home, '.dsh', 'dsh-ntr')
}

/**
 * The host's own shared `~/.dsh` root — the parent of this plugin's directory.
 *
 * Derived from {@link pluginStateDir} instead of recomputing `~/.dsh` from
 * `home`, on purpose: when a caller redirects the plugin's directory (tests,
 * a relocated state root), the legacy lookup must stay INSIDE that redirect.
 * Recomputing `~/.dsh` would make an overridden run read — and MIGRATE — the
 * real home directory.
 */
function hostStateDir(home: string = homedir()): string {
  return dirname(pluginStateDir(home))
}

/** True when the plugin's state dir was redirected (tests, relocated state). */
function stateDirExplicit(): boolean {
  const override = process.env.DSH_NTR_STATE_DIR
  return override !== undefined && override !== ''
}

/**
 * Pre-`~/.dsh/dsh-ntr` locations, kept only to MIGRATE them.
 *
 * These files used to live loose in the host's `~/.dsh` root. They are moved
 * into the plugin's own directory on first boot (see {@link migrateLegacyState})
 * and never written again — the constants stay so the migration keeps working
 * for an installation that has not started the new build yet.
 */
function legacyStatePaths(home: string = homedir()): {
  readonly dir: string
  readonly agentsFile: string
  readonly catalogFile: string
  readonly workspaces: string
} {
  const dir = hostStateDir(home)
  return {
    dir,
    agentsFile: join(dir, 'acp-agents.json'),
    catalogFile: join(dir, 'acp-model-catalog.json'),
    workspaces: join(dir, 'acp-workspaces'),
  }
}

/**
 * Move the state this plugin used to scatter across the host's `~/.dsh` root
 * into {@link pluginStateDir}.
 *
 * Idempotent and one-way: a target that already exists is left alone, so a
 * user who edits the new location never has it overwritten by a stale legacy
 * file. Only files this plugin itself created are touched — nothing else in
 * `~/.dsh` is read, moved or deleted.
 *
 * The workspace DIRECTORY is renamed rather than copied, and an agent's own
 * `cwd` / `allowedCwdRoots` are rewritten afterwards by
 * {@link rewriteLegacyWorkspaceRoots}, because those recorded absolute paths
 * would otherwise point at a directory that no longer exists (the session cwd
 * resolver rejects a missing cwd outright).
 */
function migrateLegacyState(home: string = homedir()): void {
  const legacy = legacyStatePaths(home)
  const target = pluginStateDir(home)
  try {
    const moves: Array<[string, string]> = [
      [legacy.agentsFile, join(target, 'agents.json')],
      [legacy.catalogFile, join(target, 'model-catalog.json')],
      [legacy.workspaces, join(target, 'workspaces')],
    ]
    for (const [from, to] of moves) {
      if (!existsSync(from) || existsSync(to)) continue
      mkdirSync(target, { recursive: true })
      renameSync(from, to)
    }
  } catch {
    // Best effort: a failed move leaves the legacy location readable, and the
    // readers below fall back to it, so no state is lost either way.
  }
}

/**
 * Legacy location of one plugin state file, consulted only when the new
 * location has nothing. Keeps a half-migrated installation (or a move that
 * failed because a file was momentarily locked) fully functional.
 */
function legacyFallback(name: 'agents' | 'catalog', home: string = homedir()): string {
  const legacy = legacyStatePaths(home)
  return name === 'agents' ? legacy.agentsFile : legacy.catalogFile
}

/**
 * Rewrite an agent definition's recorded workspace paths onto
 * {@link pluginStateDir} after the migration.
 *
 * `cwd` and `allowedCwdRoots` are absolute, user-visible paths stored verbatim,
 * and `resolveSessionCwd` REJECTS a cwd that does not exist — so moving the
 * directory without rewriting the agents that point into it breaks every saved
 * agent. Returns the definition unchanged when it never named the old root.
 */
export function rewriteLegacyWorkspaceRoots(def: AcpAgentDef, home: string = homedir()): AcpAgentDef {
  const from = legacyStatePaths(home).workspaces
  const to = defaultAgentWorkspace(home)
  const swap = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined
    if (!isUnderPath(path, from)) return path
    return to + path.slice(from.length)
  }
  const cwd = swap(def.cwd)
  const roots = def.allowedCwdRoots?.map(root => swap(root) ?? root)
  const cwdChanged = cwd !== def.cwd
  const rootsChanged = roots !== undefined && roots.some((root, index) => root !== def.allowedCwdRoots?.[index])
  if (!cwdChanged && !rootsChanged) return def
  return { ...def, ...(cwd === undefined ? {} : { cwd }), ...(roots === undefined ? {} : { allowedCwdRoots: roots }) }
}

/**
 * Plugin-owned default execution workspace, anchored to the plugin state dir
 * (`~/.dsh/dsh-ntr/workspaces`).
 *
 * It deliberately does NOT derive from `process.cwd()`: that is wherever the
 * DSH host happened to be launched from, so the "default workspace" used to
 * move around per launch — and, via the `allowedCwdRoots` fallback, it could
 * widen an agent's sandbox to the entire launch directory (in practice `$HOME`
 * when `dsh web` is started from the home dir).
 */
export function defaultAgentWorkspace(home: string = homedir()): string {
  return join(pluginStateDir(home), 'workspaces')
}

// ---- ACP-mode agent preset ----

/**
 * Preset id of the ACP-mode composition.
 *
 * THREE places must agree on it (no type system spans them): the declaration's
 * `config.id` in `presets/acp/acp.patch.yml` (the bundle patch the roster row
 * comes from), the browser half's `ACP_PRESET_ID` (`src/client/acp-ui.tsx`), and
 * this constant, which the host's session-log readers compare against.
 */
export const ACP_PRESET_ID = 'acp'

/** Same as {@link defaultAgentWorkspace}, best-effort creating it on disk. */
export function ensureDefaultWorkspace(home: string = homedir()): string {
  const dir = defaultAgentWorkspace(home)
  try {
    mkdirSync(dir, { recursive: true })
  } catch { /* best effort: a missing dir is reported when a session starts */ }
  return dir
}

export interface AgentPreset {
  id: string
  name: string
  description: string
  executables: string[]
  defaultCommand: string
  defaultArgs: string[]
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    description: 'Automata / Pi Coding Agent with native ACP bridge support',
    executables: ['pi-acp', 'pi'],
    defaultCommand: 'pi-acp',
    defaultArgs: [],
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    description: 'Oh My Pi (pi-based coding agent) — run as `omp acp` over stdio',
    executables: ['omp'],
    defaultCommand: 'omp',
    defaultArgs: ['acp'],
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    description: 'Tencent CodeBuddy Code — run as `codebuddy --acp` over stdio',
    executables: ['codebuddy', 'cbc'],
    defaultCommand: 'codebuddy',
    defaultArgs: ['--acp'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Claude Agent SDK adapter — run as `npx -y @agentclientprotocol/claude-agent-acp` over stdio',
    executables: ['npx'],
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex adapter — run as `npx -y @agentclientprotocol/codex-acp` over stdio',
    executables: ['npx'],
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/codex-acp'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI — run as `gemini --experimental-acp` over stdio',
    executables: ['gemini'],
    defaultCommand: 'gemini',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode — run as `opencode acp` over stdio',
    executables: ['opencode'],
    defaultCommand: 'opencode',
    defaultArgs: ['acp'],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: 'Qwen Code — run as `qwen --experimental-acp` over stdio',
    executables: ['qwen'],
    defaultCommand: 'qwen',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    description: 'Kiro CLI — run as `kiro-cli acp` over stdio',
    executables: ['kiro-cli'],
    defaultCommand: 'kiro-cli',
    defaultArgs: ['acp'],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    description: 'Qoder CLI — run as `qodercli --acp` over stdio',
    executables: ['qodercli'],
    defaultCommand: 'qodercli',
    defaultArgs: ['--acp'],
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    description: 'Qoder CLI (China) — run as `qoderclicn --acp` over stdio',
    executables: ['qoderclicn'],
    defaultCommand: 'qoderclicn',
    defaultArgs: ['--acp'],
  },
]

export function findExecutable(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    if (existsSync(command)) {
      try {
        accessSync(command, constants.X_OK)
        return realpathSync(command)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  const envPath = process.env.PATH ?? ''
  const dirs = envPath.split(delimiter).filter(Boolean)
  const extraDirs = [
    join(homedir(), '.pi', 'agent', 'bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), '.local', 'bin'),
  ]
  const allDirs = [...new Set([...dirs, ...extraDirs])]

  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.exe', '.cmd', '.bat'])
    : ['']

  for (const dir of allDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) {
        try {
          accessSync(candidate, constants.X_OK)
          return realpathSync(candidate)
        } catch {
          // Continue searching
        }
      }
    }
  }
  return undefined
}

/** Budget for one `npm install -g` triggered by `npmPackage` (cold installs are slow). */
const NPM_INSTALL_TIMEOUT_MS = 180_000

/** A generated Windows shim: what every npm-installed agent resolves to (`codebuddy.CMD`). */
const WINDOWS_SHIM_PATTERN = /\.(?:cmd|bat)$/i

/** cmd.exe metacharacters that force quoting; inside a quoted run they are literal. */
const CMD_QUOTE_TRIGGER = /[\s"&|<>^()]/

/** Quote one command-line token for `cmd.exe`. */
function quoteForCmd(token: string): string {
  if (token !== '' && !CMD_QUOTE_TRIGGER.test(token)) return token
  return `"${token.replaceAll('"', '\\"')}"`
}

export interface ShimLaunch {
  command: string
  args: string[]
  /** The caller must pass `windowsVerbatimArguments: true` (see below). */
  verbatim: boolean
}

/**
 * Turn a resolved executable + argv into a spawnable launch.
 *
 * WHY: on Windows every npm-installed ACP agent is a generated `.cmd` shim
 * (`codebuddy`, `pi-acp`, `omp`, `npx` — `findExecutable` finds them through
 * PATHEXT), and Node ≥ 20.12 refuses to spawn a `.cmd`/`.bat` with `shell:false`
 * (the BatBadBut fix): it throws `EINVAL` before the process exists. The shim is
 * therefore handed to `cmd.exe`, which is what CreateProcess used to do for us.
 *
 * The two non-obvious details, both measured on Windows:
 *  - `windowsVerbatimArguments` — otherwise libuv re-quotes our argument with
 *    MSVCRT rules, turning the embedded quotes into `\"`, which cmd.exe does not
 *    treat as an escape; the whole line then fails as "not recognized".
 *  - the outer quote pair — `/s` strips the first and last quote of the `/c`
 *    string, so the line must be wrapped for the quoted program path to survive.
 *
 * `cmd` expands `%VAR%` even inside quotes; that is the one thing this cannot
 * neutralize (a literal `%` in a shim path or argument is not a real case).
 */
export function windowsShimLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
): ShimLaunch {
  if (platform !== 'win32' || !WINDOWS_SHIM_PATTERN.test(command)) {
    return { command, args: [...args], verbatim: false }
  }
  const line = [command, ...args].map(quoteForCmd).join(' ')
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/**
 * Kill a Windows process tree — the counterpart of the POSIX process-GROUP kill
 * the bridge does elsewhere (see `AgentBridge.killChild`).
 *
 * It must run while the tree is intact: a `.cmd` shim is launched through
 * `cmd.exe`, so killing the direct child first re-parents the agent and
 * `taskkill /T` can no longer reach it (measured: the agent survived `stop()`).
 * Best effort — `taskkill` is absent from no Windows this runs on, and a
 * failure here only means the OS reclaims the process later.
 */
export function killProcessTree(pid: number): void {
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => { /* nothing else to try; the OS reaps it eventually */ })
  } catch { /* spawn itself refused */ }
}

/**
 * Globally install an agent's npm package. The package name reaches the
 * installer as a spawn argv item; on Windows the installer needs a shell,
 * which is exactly why `validateAgentDef` restricts `npmPackage` to a
 * charset with no shell metacharacters.
 */
export function npmInstallGlobal(pkg: string, onLog: (line: string) => void = () => {}): Promise<void> {
  return new Promise((resolveInstall, rejectInstall) => {
    let settled = false
    onLog(`[dsh-ntr] "${pkg}" not found on PATH — running: npm install -g ${pkg}`)
    const child = spawn('npm', ['install', '-g', '--no-fund', '--no-audit', pkg], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    const output: string[] = []
    const collect = (chunk: unknown) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue
        output.push(line)
        if (output.length > 40) output.splice(0, output.length - 40)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      child.kill()
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} timed out after ${NPM_INSTALL_TIMEOUT_MS}ms; output: ${output.slice(-5).join(' | ')}`))
    }, NPM_INSTALL_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', error => {
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} failed to run: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        onLog(`[dsh-ntr] npm install -g ${pkg} finished`)
        settle(undefined)
        return
      }
      for (const line of output.slice(-5)) onLog(line)
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} exited code=${String(code)} signal=${String(signal)}; output: ${output.slice(-5).join(' | ')}`))
    })

    function settle(error: AcpError | undefined): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveInstall()
      else rejectInstall(error)
    }
  })
}

export interface ExecutableResolution {
  command: string
  /** True when the npm auto-install ran during this resolution. */
  installed: boolean
}

/**
 * Resolve the spawn command for an agent def: PATH lookup first, then — when
 * the command is missing and the def carries `npmPackage` — a global install
 * and a second lookup. When nothing resolves the original command comes back
 * untouched so the spawn itself fails with the familiar ENOENT.
 */
export async function ensureAgentExecutable(
  def: Pick<AcpAgentDef, 'command' | 'npmPackage'>,
  install: (pkg: string, onLog: (line: string) => void) => Promise<void> = (pkg, onLog) => npmInstallGlobal(pkg, onLog),
  onLog: (line: string) => void = () => {},
): Promise<ExecutableResolution> {
  const found = findExecutable(def.command)
  if (found !== undefined) return { command: found, installed: false }
  if (def.npmPackage === undefined || def.npmPackage === '') return { command: def.command, installed: false }
  await install(def.npmPackage, onLog)
  const retry = findExecutable(def.command)
  if (retry === undefined) {
    onLog(`[dsh-ntr] ${def.npmPackage} installed but "${def.command}" is still not resolvable on PATH`)
  }
  return { command: retry ?? def.command, installed: true }
}

export function detectHostAgents(configuredDefs: readonly AcpAgentDef[]): DetectedAgentInfo[] {
  const presetEntries = AGENT_PRESETS.map(preset => {
    let detectedPath: string | undefined
    for (const exe of preset.executables) {
      const found = findExecutable(exe)
      if (found !== undefined) {
        detectedPath = found
        break
      }
    }
    const current = configuredDefs.find(d => d.id === preset.id)
    return {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      detected: detectedPath !== undefined,
      executablePath: detectedPath,
      defaultCommand: preset.defaultCommand,
      defaultArgs: [...preset.defaultArgs],
      currentConfig: current,
    }
  })
  // Configured agents outside the preset table (custom ids created in the
  // panel) surface as their own detect entries so the browser can edit their
  // full connection form — env / npmPackage / title exist only on
  // `currentConfig`, which the synthesized client-side fallback lacks.
  const presetIds = new Set(presetEntries.map(entry => entry.id))
  const customEntries = configuredDefs
    .filter(def => !presetIds.has(def.id))
    .map(def => {
      const executablePath = findExecutable(def.command)
      return {
        id: def.id,
        name: def.title ?? def.id,
        description: `Custom ACP agent (command: ${def.command})`,
        detected: executablePath !== undefined,
        executablePath,
        defaultCommand: def.command,
        defaultArgs: [...(def.args ?? [])],
        currentConfig: def,
      }
    })
  return [...presetEntries, ...customEntries]
}

/**
 * Rescue a def persisted before `command` became a command LINE (AGENTS.md
 * constraint 26): `command` used to be the whole program string, and an
 * absolute Windows path may legitimately contain spaces
 * (`C:\Program Files\nodejs\node.exe`). Re-validating would now split that on
 * the first space and silently point the agent at `C:\Program`, so the row is
 * quoted first — but ONLY when the untouched string really is a file on disk,
 * which is the one case where the split would be wrong.
 */
function quoteLegacyCommand(item: unknown): unknown {
  if (typeof item !== 'object' || item === null) return item
  const row = item as Record<string, unknown>
  const command = row.command
  if (typeof command !== 'string') return item
  const trimmed = command.trim()
  if (!/\s/.test(trimmed) || !existsSync(trimmed)) return item
  return { ...row, command: quoteCommandToken(trimmed) }
}

/**
 * The conversation→agent binding the REQUEST path honors.
 *
 * `session/chat-bind` records which ACP agent serves one DSH chat session — the
 * plugin's own mapping, deliberately not a DSH model route (see
 * `bindChatAgent`). But a route is exactly what the host driver reads per turn
 * (`selectionFor(agent).current`: pending selection → last request header →
 * deployment default), and a session that has never run an ACP turn resolves to
 * the DEPLOYMENT DEFAULT — so without a rewrite the driver never reaches this
 * adapter at all, and a session already on `acp/<old>` replays `<old>` forever.
 *
 * The rewrite lives in `presets/acp/acp-guard.mjs` (an `agent/request` waterfall
 * listener, registered with `prepend` so it lands OUTSIDE the harness's own
 * `installModelSelection` rewrite and wins). The guard is loaded by the
 * harness's Loader as its own module instance, so the two halves share state
 * through this registry on `globalThis` rather than through a module import —
 * same-package, cross-instance, like a service. The guard reads it defensively
 * and degrades to "no rewrite" (the harness default plays out) when it is
 * absent; `ACP_ROUTE_BINDING_KEY` is therefore a hand-copy discipline with the
 * guard's `BINDING_KEY` (see tests/register.spec.ts for the equivalence).
 */
export const ACP_ROUTE_BINDING_KEY = Symbol.for('dsh-ntr.acp-binding')

/** The registry shape the guard reads. Values are adapter model strings. */
export interface AcpRouteBindingRegistry {
  /** DSH chat session id → the adapter model (`agentId` | `agentId@choice`) its next turn runs on. */
  readonly conversations: Map<string, string>
  /**
   * ACP tool call id → the tool's output folded to plain text. The guard's
   * `tools/execute` listener answers the host loop's execution of an ACP
   * display card from here, so the card records the tool's REAL output
   * instead of an `unknown tool` error (see `recordAcpToolOutput`).
   */
  readonly toolResults: Map<string, string>
  /**
   * Resolvers waiting for a call's output to land, keyed by call id. Under the
   * segmented turn shape the host loop executes a card the moment its segment
   * settles — often BEFORE the agent has reported the tool's output — so the
   * guard's virtual tool parks here until `recordAcpToolOutput` (or the turn's
   * settlement, or the bounded timeout) releases it.
   */
  readonly toolOutputWaiters: Map<string, Set<(text: string | undefined) => void>>
  /** Bare agent id served when a conversation carries no explicit binding (`undefined`: no rewrite). */
  defaultModel?: string
  /**
   * Wait for a call's output to land (the plugin's implementation, shared via
   * the registry so the preset's separate module instance can reach it). The
   * guard's virtual tools call this when the host loop executes a card whose
   * tool is still running inside the ACP agent.
   */
  waitForToolOutput?: (callId: string, timeoutMs: number) => Promise<string | undefined>
}

/**
 * Install (or reuse) the process-wide registry. Idempotent: the guard and the
 * plugin load in either order, and a hot reload must not orphan bindings the
 * previous instance recorded.
 */
export function routeBindingRegistry(): AcpRouteBindingRegistry {
  const host = globalThis as unknown as { [ACP_ROUTE_BINDING_KEY]?: AcpRouteBindingRegistry }
  const existing = host[ACP_ROUTE_BINDING_KEY]
  if (existing !== undefined) {
    // A registry from an older build may predate the waiter seam: re-attach
    // the (upgraded) implementation so the guard can always use it.
    if (existing.waitForToolOutput === undefined) existing.waitForToolOutput = (callId, timeoutMs) => waitForToolOutput(callId, timeoutMs)
    return existing
  }
  const registry: AcpRouteBindingRegistry = {
    conversations: new Map(),
    toolResults: new Map(),
    toolOutputWaiters: new Map(),
    waitForToolOutput: (callId, timeoutMs) => waitForToolOutput(callId, timeoutMs),
  }
  host[ACP_ROUTE_BINDING_KEY] = registry
  return registry
}

/** Bounds for the shared tool-output record (see {@link recordAcpToolOutput}). */
const TOOL_OUTPUT_MAX_ENTRIES = 200
const TOOL_OUTPUT_MAX_CHARS = 16_000

/**
 * Record one ACP tool call for the guard's virtual tools. The host loop
 * "executes" every tool-call block in a settled ACP message (that execution
 * record is what draws the card); the preset registers no tools, so each call
 * would record `Error: unknown tool "<name>"`. The guard's `tools/execute`
 * listener instead registers a scoped virtual tool per name, and its body
 * answers with THIS record — the tool's real output, folded by the same helper
 * the ACP view uses. Every seen call id is recorded, even with empty output:
 * the guard's pre-step gate identifies its own continuation batches by exactly
 * this membership. Bounded: entries are transient, but an agent that inlines
 * whole files must not grow the process-wide map without limit.
 */
export function recordAcpToolOutput(callId: string, text: string): void {
  if (callId === '') return
  const registry = routeBindingRegistry()
  registry.toolResults.set(callId, text.length > TOOL_OUTPUT_MAX_CHARS ? `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}…` : text)
  while (registry.toolResults.size > TOOL_OUTPUT_MAX_ENTRIES) {
    const oldest = registry.toolResults.keys().next().value
    if (oldest === undefined) break
    registry.toolResults.delete(oldest)
  }
  const waiters = registry.toolOutputWaiters.get(callId)
  if (waiters !== undefined) {
    registry.toolOutputWaiters.delete(callId)
    for (const waiter of [...waiters]) waiter(registry.toolResults.get(callId))
  }
}

/**
 * Wait for a tool call's output to land in the shared registry. The host loop
 * executes a card as soon as its segment settles, which routinely happens
 * while the ACP agent is still running the tool; the guard's virtual tool
 * parks here so the card's execution record ends up with the real output.
 *
 * Resolves with the output text, or `undefined` when the bounded timeout
 * elapses or the turn settles first (the caller then answers with a pointer to
 * the ACP transcript view). Never rejects and never waits past the timeout.
 */
export function waitForToolOutput(callId: string, timeoutMs: number): Promise<string | undefined> {
  const registry = routeBindingRegistry()
  const landed = registry.toolResults.get(callId)
  if (landed !== undefined || callId === '') return Promise.resolve(landed)
  return new Promise<string | undefined>(resolve => {
    let settled = false
    const done = (text: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const waiters = registry.toolOutputWaiters.get(callId)
      if (waiters !== undefined) {
        waiters.delete(done)
        if (waiters.size === 0) registry.toolOutputWaiters.delete(callId)
      }
      resolve(text)
    }
    const timer = setTimeout(() => done(undefined), Math.max(0, timeoutMs))
    timer.unref?.()
    let waiters = registry.toolOutputWaiters.get(callId)
    if (waiters === undefined) {
      waiters = new Set()
      registry.toolOutputWaiters.set(callId, waiters)
    }
    waiters.add(done)
  })
}

/** Release every output waiter (a turn settled; nothing more can land for it). */
export function releaseAllToolOutputWaiters(): void {
  const registry = routeBindingRegistry()
  const waiters = [...registry.toolOutputWaiters.values()]
  registry.toolOutputWaiters.clear()
  for (const set of waiters) for (const waiter of [...set]) waiter(undefined)
}

// ---- Segmented turn streaming ----

/**
 * One driver step's stream: its own chunk queue and block state. A turn is
 * MANY segments when it carries tool calls — each segment ends where a tool
 * card should sit as the LAST block of the settled assistant message, so the
 * host loop executes the card between two assistant messages exactly like a
 * native multi-step turn (see docs/acp-convergence.md §1.7).
 */
interface SegmentState {
  queue: AsyncQueue<StreamChunk>
  /** Block index within THIS segment (the host accumulator is per-stream-call). */
  index: number
  activeType: 'reasoning' | 'text' | 'tool-call' | null
  activeText: string
  /** The open tool-call block's snapshot, while `activeType === 'tool-call'`. */
  activeToolCall: AcpToolCallSnapshot | undefined
  /** Whether this segment opened at least one tool-call block. */
  hasCard: boolean
  finished: boolean
}

/** How one segment's stream ends, in `StreamChunk.finish` terms. */
type SegmentFinishReason =
  | { kind: 'stop' }
  | { kind: 'aborted'; failure?: { message: string; code: string } }
  | { kind: 'error'; failure?: { message: string; code: string } }

/** Why a turn ended, as seen by {@link TurnStreamController.settle}. */
type TurnSettle =
  | { kind: 'stop'; stopReason: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/**
 * The state of ONE ACP prompt, shared across every driver step of the turn.
 *
 * The controller owns the hub subscription (for the whole agent-side turn, not
 * per stream() call), the transcript cursor (segments resume by replaying
 * `transcript.since(cursor)` — events that arrive while no segment is open are
 * recorded, never lost), the seen-call registry (a call id gets exactly one
 * card per turn, wherever its restatements land), and the turn-level facts
 * (`sawVisibleBlock`, usage) that outlive any single segment.
 */
class TurnStreamController {
  private segment: SegmentState | undefined
  private settled = false
  private disposed = false
  private readonly seenCalls = new Set<string>()
  private readonly announcedKinds = new Map<string, string>()
  private latestUsage: { inputTokens: number; outputTokens: number } | null = null
  /** Narrative lines (permission asks) that arrived while no segment was open. */
  private readonly pendingProse: string[] = []
  sawVisibleBlock = false
  private cursorSeq: number

  constructor(
    private readonly manager: BridgeManager,
    private readonly hub: EventHub,
    private readonly bridge: AgentBridge,
    readonly session: LiveSession,
    readonly turnId: string,
    /** Releases the agent-side turn slot (the `beginTurn` settler; idempotent). */
    private readonly endTurn: () => void,
    private readonly rollbackFirstTurn: (session: LiveSession) => void,
  ) {
    this.turnSeqAtStart = session.turnSeq
    this.cursorSeq = session.transcript.head
    this.unsubscribe = hub.subscribe(event => this.onEvent(event))
  }

  private readonly unsubscribe: () => void
  private readonly turnSeqAtStart: number

  /** The transcript cursor: everything at or below it is already folded or recorded. */
  get replayCursor(): number {
    return this.cursorSeq
  }

  /** Whether the agent already settled its `session/prompt` for this turn. */
  get hasSettled(): boolean {
    return this.settled
  }

  /** Generation guard: a controller whose turn has been superseded must not touch the session. */
  get stale(): boolean {
    return this.disposed || this.session.turnSeq !== this.turnSeqAtStart
  }

  /**
   * Open the next segment and replay everything that landed since the cursor.
   * Visible events fold into the new segment (a card that was announced
   * between segments opens here); tool records are idempotent. Replaying may
   * itself finish the segment (card followed by prose — the prose belongs to
   * the NEXT message): the replay stops AT the cutting event without
   * consuming it, so the next segment replays it again.
   */
  startSegment(): SegmentState {
    const seg: SegmentState = {
      queue: new AsyncQueue<StreamChunk>(),
      index: -1,
      activeType: null,
      activeText: '',
      activeToolCall: undefined,
      hasCard: false,
      finished: false,
    }
    this.segment = seg
    const entries = this.session.transcript.since(this.cursorSeq)
    for (const entry of entries) {
      if (seg.finished) break
      if (!this.foldInto(seg, entry.update as Record<string, unknown>)) break
      this.cursorSeq = entry.seq
    }
    if (!seg.finished && this.pendingProse.length > 0) {
      // Narrative that arrived between segments (a permission ask during card
      // execution): it belongs to the turn's story, so it opens this segment.
      const lines = this.pendingProse.splice(0, this.pendingProse.length).join('')
      this.emitProse(seg, 'reasoning', lines)
    }
    if (this.settled) this.finishAfterSettle(seg)
    return seg
  }

  /** Finish the segment on air (if any). Used by cancel paths and teardown. */
  finishActive(reason: SegmentFinishReason): void {
    if (this.segment !== undefined) this.finishSegment(this.segment, reason)
  }

  /** The agent settled its `session/prompt`. Ends the turn's streaming face. */
  settle(outcome: TurnSettle): void {
    if (this.settled) return
    this.settled = true
    const reason = outcome.kind === 'cancelled'
      ? { kind: 'aborted' as const, failure: { message: 'Turn was cancelled', code: 'CANCELLED' } }
      : outcome.kind === 'error'
        ? { kind: 'error' as const, failure: { message: outcome.message, code: 'INTERNAL' } }
        : { kind: 'stop' as const }
    if (outcome.kind === 'cancelled') {
      this.hub.broadcast({ type: 'turn/end', sessionId: this.session.sessionId, turnId: this.turnId, stopReason: 'cancelled' })
    } else if (outcome.kind === 'error') {
      this.hub.broadcast({ type: 'turn/end', sessionId: this.session.sessionId, turnId: this.turnId, error: outcome.message })
    } else {
      this.hub.broadcast({ type: 'turn/end', sessionId: this.session.sessionId, turnId: this.turnId, stopReason: outcome.stopReason })
    }
    // The provisional lock settles BEFORE any synthesized warning below: the
    // warning is our text, not evidence that the first turn delivered anything.
    if (this.session.provisionalLock === true) {
      this.session.provisionalLock = false
      if (!this.sawVisibleBlock) this.rollbackFirstTurn(this.session)
    }
    const seg = this.segment
    if (seg !== undefined) {
      if (outcome.kind !== 'stop') {
        this.finishSegment(seg, reason)
      } else {
        if (!this.sawVisibleBlock) {
          // The silent-failure report: a normal stop with nothing the chat
          // plane renders. Aborted or failing turns need no extra hint; this
          // is specifically "protocol says success, the bubble is empty".
          const line = `\n[dsh-ntr] agent "${this.session.agentId}" ended the turn with no visible output (stop reason: ${outcome.stopReason}). Some agents fold upstream failures — auth, billing, rate limits — into a normal stop; try resending, and check the agent process logs if it repeats.\n`
          this.emitProse(seg, 'text', line)
        }
        this.finishSegment(seg, reason)
      }
    }
    // When no segment is on air (the turn ended on a card) the FINAL
    // continuation step collects the tail: `startSegment` sees `settled` and
    // finishes it with the appropriate closing line.
    this.session.running = false
    this.endTurn()
    releaseAllToolOutputWaiters()
    // The controller stays indexed only while a continuation step can still
    // come for its cards. A cancelled, failed, or card-less turn has none:
    // retire it now; the next turn's `rememberTurnStream` would anyway.
    if (outcome.kind !== 'stop' || this.seenCalls.size === 0) this.dispose()
  }

  /** Cancelled by the user: finish the on-air segment and release the turn's slots. */
  abortActiveSegment(): void {
    if (this.stale) return
    this.finishActive({ kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } })
    // The agent may take its time acknowledging the cancel, but OUR face of
    // the turn ends now: the session stops running and a provisional first
    // lock settles against what was actually shown. The turn SLOT stays
    // claimed, though: the agent-side prompt is still in flight, and a second
    // prompt sent into that window would be a concurrent `session/prompt` the
    // protocol forbids — `settle` (or the cancel fallback) releases the slot.
    this.session.running = false
    if (this.session.provisionalLock === true) {
      this.session.provisionalLock = false
      if (!this.sawVisibleBlock) this.rollbackFirstTurn(this.session)
    }
    releaseAllToolOutputWaiters()
  }

  /** Stop observing and release the manager's index. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.manager.forgetTurnStream(this)
    releaseAllToolOutputWaiters()
  }

  // ---- internals ----

  private finishSegment(seg: SegmentState, reason: SegmentFinishReason): void {
    if (seg.finished) return
    seg.finished = true
    if (seg.activeType !== null) {
      seg.queue.push({
        type: 'block-end',
        index: seg.index,
        block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
          ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
          : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
      })
      seg.activeType = null
      seg.activeToolCall = undefined
    }
    if (this.latestUsage !== null) seg.queue.push({ type: 'usage', usage: this.latestUsage })
    seg.queue.push({ type: 'finish', reason })
    seg.queue.close()
    if (this.segment === seg) this.segment = undefined
  }

  /** A segment opened on an already-settled turn: replay, then close it out. */
  private finishAfterSettle(seg: SegmentState): void {
    if (seg.finished) return
    if (this.sawVisibleBlock) {
      // The turn delivered its message(s); this last continuation step has
      // nothing new to show. An empty assistant message is not something the
      // plane can render honestly, so close with a one-line pointer.
      if (seg.index < 0 && this.pendingProse.length === 0) {
        const line = `\n[dsh-ntr] agent "${this.session.agentId}" executed its tool call(s) but sent no text reply this turn — the tool details are in the ACP transcript view.\n`
        this.emitProse(seg, 'text', line)
      }
      this.finishSegment(seg, { kind: 'stop' })
    } else {
      // A settled turn that never showed anything: the zero-output warning the
      // plane would have gotten from a single-stream turn (constraint 23).
      const line = `\n[dsh-ntr] agent "${this.session.agentId}" ended the turn with no visible output. Some agents fold upstream failures — auth, billing, rate limits — into a normal stop; try resending, and check the agent process logs if it repeats.\n`
      if (seg.index < 0) this.emitProse(seg, 'text', line)
      this.finishSegment(seg, { kind: 'stop' })
    }
  }

  private onEvent(event: unknown): void {
    if (this.disposed) return
    const row = event as { type?: string; sessionId?: string }
    if (row.sessionId !== undefined && row.sessionId !== this.session.sessionId) return
    if (row.type === 'session/update') {
      const typed = event as { sessionId: string; seq: number; update: unknown }
      if (typed.seq <= this.cursorSeq) return
      const update = typed.update as Record<string, unknown>
      const seg = this.segment
      if (seg === undefined || seg.finished) {
        // Between segments: tool outputs still reach the shared registry (the
        // guard's virtual tool may be parked on this very record) and usage
        // keeps the turn's tally fresh, but the cursor does NOT advance — the
        // next segment replays everything since it, which re-records those
        // idempotently and folds the prose the agent streamed while its cards
        // executed on the host.
        this.recordWithoutSegment(update)
        return
      }
      // The cursor advances only past events fully consumed into this
      // segment; the event that CUTS the segment belongs to the next one.
      if (this.foldInto(seg, update)) this.cursorSeq = typed.seq
    } else if (row.type === 'permission/request') {
      const typed = event as { toolCall: unknown; requestId: string }
      const seg = this.segment
      const line = this.permissionLine(typed)
      if (seg === undefined || seg.finished) {
        if (line !== '') this.pendingProse.push(line)
        return
      }
      if (seg.hasCard) {
        // The card must stay the segment's last block: park the line for the
        // next segment instead of streaming it below the card.
        this.pendingProse.push(line)
        this.finishSegment(seg, { kind: 'stop' })
        return
      }
      if (line !== '') this.emitProse(seg, 'reasoning', line)
    }
  }

  /** Events that arrive between segments: recorded, replayed into the next one. */
  private recordWithoutSegment(update: Record<string, unknown>): void {
    const kind = String(update.sessionUpdate ?? '')
    if (kind === 'usage_update') {
      this.noteUsage(update)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.noteToolRecord(update)
    }
  }

  private noteUsage(update: Record<string, unknown>): void {
    const used = typeof update.used === 'number' ? update.used : 0
    const size = typeof update.size === 'number' ? update.size : 0
    this.latestUsage = { inputTokens: size, outputTokens: used }
  }

  /** Record a tool call's output (idempotent) and wake any waiter. */
  private noteToolRecord(update: Record<string, unknown>): void {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId.trim() : ''
    if (callId === '') return
    recordAcpToolOutput(callId, updateContentToText(update.content))
  }

  /**
   * The turn's whole fold, shared by live events and segment replay. Visible
   * non-tool events END a card-bearing segment instead of joining it — that is
   * the segmentation rule that puts each card between two assistant messages.
   * Returns whether the event was consumed into this segment: the cutting
   * event is left unconsumed (and thus behind the cursor) for the next one.
   */
  private foldInto(seg: SegmentState, update: Record<string, unknown>): boolean {
    const kind = String(update.sessionUpdate ?? '')
    if (kind === 'agent_thought_chunk' || kind === 'agent_message_chunk') {
      const text = chunkTextOf(update.content)
      if (text === '') return true
      if (seg.hasCard) {
        this.finishSegment(seg, { kind: 'stop' })
        return false
      }
      this.emitProse(seg, kind === 'agent_thought_chunk' ? 'reasoning' : 'text', text)
      return true
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.noteToolRecord(update)
      const snapshot = acpToolCallFromUpdate(update)
      if (snapshot === undefined) return true
      if (seg.activeType === 'tool-call' && seg.activeToolCall?.callId === snapshot.callId) {
        for (const delta of acpToolCallDelta(seg.activeToolCall, update)) {
          seg.queue.push(delta.kind === 'name'
            ? { type: 'tool-call-delta', index: seg.index, id: seg.activeToolCall.callId, name: delta.name, argumentsDelta: '' }
            : { type: 'tool-call-delta', index: seg.index, id: seg.activeToolCall.callId, argumentsDelta: delta.text })
        }
        return true
      }
      if (this.seenCalls.has(snapshot.callId)) return true // a restatement of a card already settled
      this.seenCalls.add(snapshot.callId)
      this.openToolCallBlock(seg, snapshot)
      return true
    } else if (kind === 'usage_update') {
      this.noteUsage(update)
      return true
    } else if (!BOOKKEEPING_UPDATES.has(kind)) {
      const text = describeUnhandledUpdate(kind, update)
      if (this.announcedKinds.get(kind) === text) return true
      if (seg.hasCard) {
        this.finishSegment(seg, { kind: 'stop' })
        return false
      }
      this.announcedKinds.set(kind, text)
      this.emitProse(seg, 'text', `\n${text}\n`)
      return true
    }
    return true
  }

  private emitProse(seg: SegmentState, type: 'reasoning' | 'text', text: string): void {
    if (seg.finished) return
    if (seg.activeType !== type) {
      if (seg.activeType !== null) {
        seg.queue.push({
          type: 'block-end',
          index: seg.index,
          block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
            ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
            : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
        })
      }
      seg.index += 1
      seg.activeType = type
      seg.activeText = ''
      this.sawVisibleBlock = true
      seg.queue.push({ type: 'block-start', index: seg.index, blockType: type })
    }
    seg.activeText += text
    seg.queue.push({ type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: seg.index, text })
  }

  /**
   * Open a tool-call block for one call. Two adjacent tool calls share a block
   * TYPE, so the switch helper's type-equality early return cannot be used
   * here — every call needs its own block.
   */
  private openToolCallBlock(seg: SegmentState, snapshot: AcpToolCallSnapshot): void {
    if (seg.finished) return
    if (seg.activeType !== null) {
      seg.queue.push({
        type: 'block-end',
        index: seg.index,
        block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
          ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
          : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
      })
    }
    seg.index += 1
    seg.activeType = 'tool-call'
    seg.activeText = ''
    seg.activeToolCall = snapshot
    this.sawVisibleBlock = true
    seg.hasCard = true
    seg.queue.push({ type: 'block-start', index: seg.index, blockType: 'tool-call' })
    seg.queue.push({
      type: 'tool-call-delta',
      index: seg.index,
      id: snapshot.callId,
      ...(snapshot.name === '' ? {} : { name: snapshot.name }),
      argumentsDelta: snapshot.argsRaw,
    })
  }

  private permissionLine(event: { toolCall: unknown; requestId: string }): string {
    const title = typeof (event.toolCall as { title?: unknown } | undefined)?.title === 'string'
      ? String((event.toolCall as { title: string }).title)
      : 'permission'
    // The line must not point at a place with no answer entry, and the bridge
    // knows which path this ask took (`ledgerFallbackOf`, recorded before the
    // frame was broadcast). On the DESIGNED ledger paths the settings panel's
    // card is the answer entry. A DEGRADED native route carries a deadline and
    // has to say why the conversation is not showing the question — as an
    // OBSERVED FACT, not a guessed cause: "no answer within Ns" is true whether
    // the human was slow or the host never rendered the question.
    const fallback = this.bridge.ledgerFallbackOf(event.requestId)
    const why = fallback === undefined
      ? undefined
      : fallback.reason === 'unavailable'
        ? 'the approval service is unavailable'
        : fallback.reason === 'native-timeout'
          ? `no answer in the conversation within ${String(Math.round((fallback.waitedMs ?? 0) / 1000))}s`
          : undefined
    if (fallback === undefined || why === undefined) {
      return `\n> 🔐 [Permission Required: ${title}] - please approve in Settings\n`
    }
    return fallback.timeoutMs > 0
      ? `\n> 🔐 [Permission Required: ${title}] - ${why}; approve in Settings within ${String(Math.round(fallback.timeoutMs / 1000))}s or this request is cancelled\n`
      : `\n> 🔐 [Permission Required: ${title}] - ${why}; please approve in Settings\n`
  }
}

/** Chunk text shared by the controller's fold (string / object / array forms). */
function chunkTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'string') parts.push(item)
      else if (typeof item === 'object' && item !== null) {
        const row = item as Record<string, unknown>
        if (typeof row.text === 'string') parts.push(row.text)
        else parts.push(JSON.stringify(item))
      }
    }
    return parts.join('')
  }
  if (typeof content === 'object' && content !== null) {
    const row = content as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    if (row.type === 'text' || row.type === undefined) return JSON.stringify(content)
  }
  return ''
}

/** Routes host session ids to their owning bridge. */
export class BridgeManager {
  private readonly bridges = new Map<string, AgentBridge>()
  private readonly defsMap = new Map<string, AcpAgentDef>()
  /** The plugin's own default ACP agent id (persisted; see `persistAgents`). */
  private defaultAgentId?: string
  /** The agent tag's halo preference (persisted; see `persistAgents`). */
  private tagHaloSetting: AcpTagHalo = { ...DEFAULT_TAG_HALO }
  /**
   * The in-flight (or just-settled) segmented turn of one DSH chat session.
   * Keyed by chat session id because the continuation steps of a segmented
   * turn arrive as fresh `streamPrompt` calls that must find the SAME
   * controller — its transcript cursor, seen-call registry and turn facts are
   * what let them resume the prompt instead of re-sending it. An entry is
   * replaced by the conversation's next turn and removed on cancel, session
   * close/release, or agent stop.
   */
  private readonly turnStreams = new Map<string, TurnStreamController>()

  /** The segmented turn a continuation step of one chat session must resume. */
  turnStreamFor(dshSessionId: string): TurnStreamController | undefined {
    return this.turnStreams.get(dshSessionId)
  }

  /** Index a turn's controller, retiring whatever turn it supersedes. */
  rememberTurnStream(dshSessionId: string, controller: TurnStreamController): void {
    const previous = this.turnStreams.get(dshSessionId)
    if (previous !== undefined && previous !== controller) previous.dispose()
    this.turnStreams.set(dshSessionId, controller)
  }

  /** Drop a controller from the index (its own `dispose` calls back into this). */
  forgetTurnStream(controller: TurnStreamController): void {
    for (const [key, value] of this.turnStreams) {
      if (value === controller) this.turnStreams.delete(key)
    }
  }

  /** Tear down the turn streams of every session of one bridge (close/release/stop). */
  private disposeTurnStreamsOf(match: (controller: TurnStreamController) => boolean): void {
    for (const [key, controller] of [...this.turnStreams]) {
      if (match(controller)) {
        controller.finishActive({ kind: 'aborted', failure: { message: 'session ended', code: 'SESSION_CLOSED' } })
        controller.dispose()
        this.turnStreams.delete(key)
      }
    }
  }

  constructor(
    defs: readonly AcpAgentDef[],
    readonly hub: EventHub,
    private readonly transcriptMax: number,
    private readonly configStoragePath?: string,
    private readonly catalogStoragePath?: string,
    /** Auto-probe agents for model catalogs (boot + lazy); manual probes always run. */
    private readonly probeModelsOnBoot = true,
    private readonly tuning?: BridgeTuning,
  ) {
    for (const def of defs) {
      this.defsMap.set(def.id, def)
    }
    // Move any state left loose in the host's `~/.dsh` root into this plugin's
    // own directory BEFORE reading it (see `migrateLegacyState`). Storage paths
    // injected by a caller are that caller's business; the migration only runs
    // for the default, plugin-owned locations.
    if (this.configStoragePath === undefined && this.catalogStoragePath === undefined) {
      migrateLegacyState()
    }
    this.loadPersistedAgents()
    this.loadPersistedCatalogs()
    // The request-path rewrite falls back to this default for a conversation
    // the user never bound explicitly — the same agent the composer chip shows.
    routeBindingRegistry().defaultModel = this.defaultAgent()
  }

  private makeBridge(
    def: AcpAgentDef,
    onConnectionLost: (bridge: AgentBridge, reason: string) => void,
    onCatalog?: (agentId: string, configOptions: unknown, shapeOnly?: boolean) => void,
    onCommands?: (agentId: string, commands: NonNullable<SessionView['availableCommands']>) => void,
  ): AgentBridge {
    return new AgentBridge(def, this.hub, this.transcriptMax, onConnectionLost, onCatalog, onCommands, this.tuning, () => this.approvalRequester, () => this.sessionWorkspaceResolver)
  }

  /**
   * Route ACP permission asks through the host approval service (answered in
   * the chat composer). Absent → every ask stays on the settings-panel ledger.
   * Setting it also flips {@link approvalRouting}, which the browser reads to
   * stop rendering the settings-panel permission card.
   */
  setApprovalRequester(requester?: ApprovalRequester): void {
    this.approvalRequester = requester
  }

  /** True when permission asks go to native approval instead of the settings panel. */
  approvalRouting(): boolean {
    return this.approvalRequester !== undefined
  }

  /**
   * Every outstanding ledger ask, across all agents, with the view the browser
   * was shown it — the source of the reconnect replay (see
   * `permissionReplayFrames`). Asks on the native route are deliberately
   * absent: they broadcast nothing and their answer entry is the composer
   * takeover the client already holds.
   */
  pendingPermissionViews(): PendingPermissionView[] {
    const views: PendingPermissionView[] = []
    for (const bridge of this.bridges.values()) views.push(...bridge.permissions.pendingViews())
    return views
  }

  /**
   * Let the host resolve a chat session's workspace root — the sidebar's
   * selected workspace, which the agent's session and its process both run in.
   * Absent resolver → every chat session falls back to the agent's configured
   * cwd (`~/.dsh/dsh-ntr/workspaces`), which is the right answer for `/acp`-RPC
   * sessions and headless deployments.
   */
  setSessionWorkspaceResolver(resolver?: SessionWorkspaceResolver): void {
    this.sessionWorkspaceResolver = resolver
  }

  /**
   * Wire the ACP-mode probe: given a DSH session id, report whether that
   * session runs the ACP agent preset. The host half reads it back from the
   * session log (`sessionAgentPreset`); an absent resolver means the browser
   * falls back to its own session-list rows.
   */
  setAcpModeResolver(resolver?: AcpModeResolver): void {
    this.acpModeResolver = resolver
  }

  /**
   * Whether ONE DSH chat session runs the ACP agent preset, asked by chat
   * session id. The browser's composer surfaces consume this: on hosts whose
   * client runtime does not carry `agentPreset` on the session-list row (their
   * preferred fact source), this is the only way to know which conversation is
   * an ACP one.
   *
   * The resolver may await a persistence read (a cold session has to be read
   * from disk), so answers are CACHED per session id and served synchronously:
   * the first ask returns `false` while the read is in flight and the caller
   * re-asks on the next tick — a one-turn delay, never a wrong verdict.
   * A cached verdict is dropped when the session's log moves (preset switch,
   * new turn), so a stale answer cannot outlive the fact it was folded from.
   */
  chatSessionAcpMode(dshSessionId: string): boolean {
    const cached = this.acpModeCache.get(dshSessionId)
    if (cached !== undefined) return cached
    const resolver = this.acpModeResolver
    if (resolver === undefined) return false
    try {
      const answered = resolver(dshSessionId)
      if (answered instanceof Promise) {
        // Prime the cache from the settled read; the synchronous asker still
        // got `false` this round (see `chatSessionAcpModeAnswer` for the
        // awaitable form the RPC serves instead).
        void answered.then(verdict => {
          if (verdict !== undefined) this.acpModeCache.set(dshSessionId, verdict === true)
        }).catch(() => { /* retry on the next ask */ })
        return false
      }
      if (answered !== undefined) this.acpModeCache.set(dshSessionId, answered === true)
      return answered === true
    } catch {
      // Never guess from a failed lookup: the browser's fallback then reads
      // "not ACP", which keeps the native seat — the allowed failure mode.
      return false
    }
  }

  /**
   * The awaitable form of `chatSessionAcpMode`, served by the `session/chat-list`
   * RPC: the first ask WAITS for the cold read instead of answering early, so
   * the browser's one-shot fallback sees the settled verdict immediately —
   * a synchronous first answer of `false` would be remembered by the gate and
   * the seat would never take over. Concurrent asks for the same session share
   * one read (in-flight dedup); a failed lookup returns `false` for that ask
   * but is NOT cached, so the next ask retries.
   */
  async chatSessionAcpModeAnswer(dshSessionId: string): Promise<boolean> {
    const cached = this.acpModeCache.get(dshSessionId)
    if (cached !== undefined) return cached
    const resolver = this.acpModeResolver
    if (resolver === undefined) return false
    let inflight = this.acpModeInflight.get(dshSessionId)
    if (inflight === undefined) {
      inflight = (async () => {
        try {
          return await resolver(dshSessionId)
        } catch {
          return undefined
        } finally {
          this.acpModeInflight.delete(dshSessionId)
        }
      })()
      this.acpModeInflight.set(dshSessionId, inflight)
    }
    const verdict = await inflight
    if (verdict !== undefined) {
      this.acpModeCache.set(dshSessionId, verdict === true)
      return verdict === true
    }
    return false
  }

  /** Drop cached ACP-mode verdicts: one session's, or all of them. */
  invalidateAcpMode(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      this.acpModeCache.clear()
      return
    }
    this.acpModeCache.delete(dshSessionId)
  }

  /**
   * The ACP agent sessions backing one DSH chat session. The composer uses this
   * to offer the agent's OWN modes next to the host's Access mode control —
   * "how the agent works" beside "what it may touch", which is the split that
   * keeps the two controls from reading as duplicates.
   */
  chatSessions(dshSessionId: string): ChatSessionView[] {
    const out: ChatSessionView[] = []
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.closed) continue
      const title = this.defsMap.get(session.agentId)?.title
      out.push({
        agentId: session.agentId,
        ...(title === undefined ? {} : { agentTitle: title }),
        sessionId: session.sessionId,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
        ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
        ...(session.modes === undefined ? {} : { modes: session.modes }),
        ...(session.availableCommands === undefined ? {} : { availableCommands: session.availableCommands }),
        ...(session.released ? { released: true } : {}),
      })
    }
    return out
  }

  /**
   * Bind one DSH chat session to an ACP agent.
   *
   * This is the plugin's OWN conversation↔agent mapping. It deliberately does
   * NOT write a DSH model selection: the retired "express the agent as a
   * `provider: 'acp'` route" axis forced `session.selectModel`, which both
   * polluted the deployment default model and got refused by the GUI's catalog
   * gate (`session/model-unavailable`) — even though the prompt admission path
   * never checked catalog membership in the first place. See
   * docs/acp-convergence.md §1.1 and §2.2.
   *
   * The host half records the intent; the actual ACP session is created on the
   * next turn (which is also what resumes a released one).
   */
  bindChatAgent(dshSessionId: string, agentId: string): void {
    if (!this.defsMap.has(agentId)) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    // ONE CONVERSATION, ONE AGENT (user decision, 2026-10-20): once the first
    // ACP turn has run, the conversation is locked to its agent. A different
    // agent has none of the context on its side, so switching is refused
    // rather than silently starting a second, empty conversation. Re-picking
    // the SAME agent is idempotent. The lock is persisted with the choice, so
    // this holds across restarts and after the ACP session is gone.
    const lockedTo = this.lockedAgentFor(dshSessionId)
    if (lockedTo !== undefined) {
      if (lockedTo === agentId) return
      throw new AcpError(
        'agent_locked',
        `acp: conversation is locked to agent "${lockedTo}" once its first turn has started; start a new conversation to use another agent`,
      )
    }
    // A switch to a DIFFERENT agent drops its model/effort/mode/configs: those
    // values are the PREVIOUS agent's vocabulary (a `choice` from its catalog, a
    // value of ITS `thought_level`, one of ITS `session/set_mode` ids, one of ITS
    // extra config options) and would be rejected or silently remapped by the
    // new one. Re-picking the SAME agent
    // is not a switch, so its picks stand. `patchChatChoice` owns that rule —
    // both entry points go through it so the two cannot drift.
    this.patchChatChoice(dshSessionId, { agentId })
  }

  /** The ACP agent a chat session was last pointed at, when one is known. */
  chatAgentFor(dshSessionId: string): string | undefined {
    const recorded = this.chatAgentIntent.get(dshSessionId)?.agentId
    if (recorded !== undefined && this.defsMap.has(recorded)) return recorded
    // Fall back to the binding itself: a session that already ran an agent is
    // pointed at that agent even if the intent map was never seeded.
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId === dshSessionId && !session.closed) return session.agentId
    }
    return undefined
  }

  /**
   * The agent a conversation is LOCKED to, if its first ACP turn has run.
   *
   * The persisted `locked` flag is the durable answer and deliberately ignores
   * the roster: a deleted agent still owns the conversation's context, and the
   * conversation must not pretend it is unbound (that would offer a switch the
   * turn path then has to refuse). The live/released session fallback covers
   * conversations recorded before the flag existed; the next turn writes the
   * flag (`lockChatAgent`).
   */
  lockedAgentFor(dshSessionId: string): string | undefined {
    const recorded = this.chatAgentIntent.get(dshSessionId)
    if (recorded?.locked === true) return recorded.agentId
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId === dshSessionId && !session.closed) return session.agentId
    }
    return undefined
  }

  /**
   * Write the conversation's agent lock and announce it once.
   *
   * Called at the START of the conversation's first ACP turn (the session was
   * just materialized), so the composer can play its base→tag hand-off while
   * the turn is running instead of waiting for it to settle. Returns true when
   * this call created the lock; the caller marks a newly created session
   * `provisionalLock`, and a first turn that delivers nothing rolls it back
   * (`rollbackFirstTurn`). The broadcast is what lets the browser react at
   * once: a `session/chat-list` read is a round-trip behind.
   */
  private lockChatAgent(dshSessionId: string, agentId: string): boolean {
    const current = this.chatAgentIntent.get(dshSessionId)
    if (current?.locked === true && current.agentId === agentId) return false
    const newlyLocked = current?.locked !== true
    this.patchChatChoice(dshSessionId, { agentId, locked: true })
    if (newlyLocked) {
      this.hub.broadcast({ type: 'chat/agent-locked', dshSessionId, agentId })
    }
    return newlyLocked
  }

  /**
   * Undo the provisional lock of a first turn that delivered nothing, and drop
   * the failed session with it.
   *
   * A turn that produced an error before any text/reasoning, or a silent
   * provider failure folded into a normal stop, exchanged nothing with the
   * agent: there is no context to protect, so the conversation may choose
   * another agent. The session is CLOSED rather than kept, because both lock
   * readers (`lockedAgentFor` here and `lockedAgentOf` in the browser) treat a
   * live session as a lock — keeping it would leave a visually locked
   * conversation whose picker the host still accepts.
   *
   * The pick itself (agent/model/effort/mode/extra configs) stays recorded: the
   * base comes back showing the same agent, ready to be changed or retried.
   */
  private rollbackFirstTurn(session: LiveSession): void {
    session.provisionalLock = false
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const current = this.chatAgentIntent.get(dshSessionId)
    if (current?.locked === true && current.agentId === session.agentId) {
      const next: AcpConversationChoice = { ...current }
      delete next.locked
      this.chatAgentIntent.set(dshSessionId, next)
      this.persistAgents()
      // Keep the request-path binding on the picked agent: it is still what
      // the base shows and what an unchanged retry should run.
      this.syncConversationRoute(dshSessionId)
      this.hub.broadcast({ type: 'chat/agent-unlocked', dshSessionId })
    }
    // Drop the chat-keyed record BEFORE the asynchronous agent-side close: the
    // browser's very next `session/chat-list` must not see this session.
    this.forgetDshSession(session.sessionId)
    // Use the existing bridge, not `this.bridge(id)`: the agent may have been
    // deleted while its first turn was failing, and a rollback must never throw.
    const failed = this.bridges.get(session.agentId)
    if (failed !== undefined) {
      void failed.closeSession(session, 'closed').catch(() => { /* already gone */ })
    }
  }

  /**
   * The conversation's persisted pick (agent + model + thought level). This is
   * the record that survives a host restart and is readable BEFORE the
   * conversation has ever run a turn — the composer shows it, and the turn path
   * applies it to a freshly created or resumed session.
   */
  chatChoice(dshSessionId: string): AcpConversationChoice | undefined {
    const recorded = this.chatAgentIntent.get(dshSessionId)
    if (recorded === undefined) return undefined
    if (!this.defsMap.has(recorded.agentId)) return undefined
    return { ...recorded }
  }

  /**
   * Publish one conversation's pick onto the request-path binding.
   *
   * The guard's `agent/request` rewrite and this class's own turn admission read
   * `routeBindingRegistry().conversations`, whose values are adapter model ids.
   * The MODEL half of the pick therefore rides there, so a turn that starts
   * with `agentId` alone does not silently drop a variant chosen up front; with
   * no model picked the binding is the bare agent id (the agent's default).
   *
   * Only ever WRITES: a conversation with no recorded pick keeps whatever the
   * turn path pinned to it (the agent that actually served its last turn), which
   * is the honest answer for a session whose intent map was never seeded.
   */
  private syncConversationRoute(dshSessionId: string): void {
    const choice = this.chatAgentIntent.get(dshSessionId)
    if (choice === undefined || !this.defsMap.has(choice.agentId)) return
    routeBindingRegistry().conversations.set(dshSessionId, choice.modelId ?? choice.agentId)
  }

  /**
   * The adapter model string one chat conversation's next turn runs on — the
   * request-path binding, when it names a CONFIGURED agent. `undefined` leaves
   * the turn on whatever route the driver resolved (the allowed failure: the
   * harness default plays out).
   */
  private conversationRouteModel(dshSessionId: string): string | undefined {
    const model = routeBindingRegistry().conversations.get(dshSessionId)
    if (model === undefined || model === '') return undefined
    return this.defsMap.has(splitAdapterModelId(model).agentId) ? model : undefined
  }

  /**
   * The agent's own default thought level — the effort the driver MATERIALIZES
   * into a request that did not ask for one (`resolveCallWithInfo` fills
   * `reasoning.defaultEffort` in and marks it adapter-defaulted). Re-applying
   * that as a per-turn choice would revert a pick the user just made through
   * the seat, so the turn path treats it as "no effort requested".
   */
  private modelDefaultEffort(agentId: string): string | undefined {
    return this.reasoningMeta(agentId)?.defaultEffort
  }

  /**
   * Record one field of a conversation's pick and persist it.
   *
   * Every bottom-bar control (agent, model, thought level, the agent's own mode,
   * the advanced base's extra config values) is one field of the SAME record,
   * and the setters used to spell the record
   * out by hand each time — which is exactly how `mode` ended up as the one
   * control that reset on every restart: no setter wrote it. Patch through here
   * so a new axis cannot be half-wired.
   *
   * `undefined` CLEARS the field (the "follow the agent's default" choice).
   */
  private patchChatChoice(
    dshSessionId: string,
    patch: Partial<AcpConversationChoice>,
  ): void {
    const current = this.chatAgentIntent.get(dshSessionId)
    const agentId = patch.agentId ?? current?.agentId ?? this.chatAgentFor(dshSessionId)
    if (agentId === undefined) return
    // A patch that names a DIFFERENT agent starts from a clean record: the
    // other fields are the previous agent's vocabulary and must not survive.
    const base = patch.agentId !== undefined && patch.agentId !== current?.agentId ? {} : current
    const next: AcpConversationChoice = { ...base, ...patch, agentId }
    if (next.locked !== true) delete next.locked
    if (next.modelId === undefined) delete next.modelId
    if (next.effort === undefined) delete next.effort
    if (next.mode === undefined) delete next.mode
    if (next.extraConfigs === undefined || Object.keys(next.extraConfigs).length === 0) delete next.extraConfigs
    this.chatAgentIntent.set(dshSessionId, next)
    this.persistAgents()
    this.syncConversationRoute(dshSessionId)
  }

  /** Switch the bound agent's model for one chat session (`agentId@choice`). */
  async setChatSessionModel(dshSessionId: string, modelId: string): Promise<void> {
    const { agentId, choice } = splitAdapterModelId(modelId)
    const def = this.defsMap.get(agentId)
    if (def === undefined) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    // A model id names its agent, so this call can also be an agent switch.
    // Once locked, only the locked agent's models are accepted.
    const lockedTo = this.lockedAgentFor(dshSessionId)
    if (lockedTo !== undefined && lockedTo !== agentId) {
      throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
    }
    // A model the live session's agent no longer lists is refused HERE too:
    // recording it would look like a successful switch while the next send is
    // doomed to `model_unavailable`. Before a session exists there is nothing
    // authoritative to validate against — the send-time gate covers it.
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== agentId || session.released) continue
      const stale = choice === undefined ? undefined : this.staleModelChoice(session, choice)
      if (stale !== undefined) {
        throw new AcpError('model_unavailable', `acp: agent "${agentId}" no longer offers model "${stale}"`)
      }
    }
    // The pick is recorded even when NO live session exists yet — that is the
    // "choose the model before the first message" case. A session that
    // materializes later reads it back (`applyChatChoice`).
    this.patchChatChoice(dshSessionId, { agentId, modelId: choice === undefined ? undefined : modelId })
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== agentId) continue
      if (session.released) continue
      await this.alignSessionConfig(session, choice, session.reasoningEffort)
      session.choice = choice
      session.modelId = modelId
    }
  }

  /**
   * Switch the reasoning effort for one chat session.
   *
   * `agentId` names the agent that serves a conversation nobody has bound —
   * the plugin default the guard's route rewrite falls back to. The browser
   * knows it (its composer chip is built from the same route), and without it
   * `chatAgentFor` answers undefined before the first session exists, so the
   * pick would be silently dropped.
   */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    if (agentId !== undefined) {
      if (!this.defsMap.has(agentId)) {
        throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
      }
      const lockedTo = this.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
      }
    }
    // Recorded before any session exists (see `setChatSessionModel`); a released
    // session is skipped here and re-aligned by `applyChatChoice` on resume.
    this.patchChatChoice(dshSessionId, { ...(agentId === undefined ? {} : { agentId }), effort })
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.released) continue
      if (agentId !== undefined && session.agentId !== agentId) continue
      const aligned = await this.alignSessionConfig(session, session.choice, effort)
      // Same rule as the model axis: a dropped level is no longer "in force".
      session.reasoningEffort = aligned.effortStale ? undefined : effort
    }
  }

  /**
   * Set one of the agent's EXTRA config options for one chat session (the
   * composer's advanced base). The value is validated against what the agent
   * actually publishes — the live session's own options first, the cached
   * catalog second — and recorded even when no session exists yet, so the pick
   * applies when the first turn materializes one (`applyChatChoice`).
   *
   * A live session is updated immediately; a failure there is warned about and
   * the pick still stands, exactly like the model/effort alignment path.
   */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    // `agentId` is the route the composer showed — including the plugin
    // default, which `chatAgentFor` cannot report before the first session.
    const bound = agentId ?? this.chatAgentFor(dshSessionId)
    if (bound === undefined) {
      throw new AcpError('unknown_session', `acp: no ACP agent is bound to chat session ${dshSessionId}`)
    }
    if (!this.defsMap.has(bound)) {
      throw new AcpError('unknown_agent', `acp: agent "${bound}" is not configured`)
    }
    const lockedTo = this.lockedAgentFor(dshSessionId)
    if (lockedTo !== undefined && lockedTo !== bound) {
      throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
    }
    const live = [...this.dshSessionMap.values()].find(session =>
      session.dshSessionId === dshSessionId && session.agentId === bound && !session.released)
    const observed = live === undefined
      ? undefined
      : parseCatalogOptions(live.configOptions).extras?.find(option => option.configId === configId)
    const advertised = this.catalogs.get(bound)?.catalog.extras?.find(option => option.configId === configId)
    const option = observed ?? advertised
    if (option === undefined) {
      throw new AcpError('unknown_config', `acp: agent "${bound}" publishes no extra config option "${configId}"`)
    }
    if (option.kind === 'boolean') {
      // The browser sends 'true' / 'false' from a checkbox row; the wire and
      // the persisted pick both use the real boolean.
      const toggle = typeof value === 'boolean'
        ? value
        : value === 'true' ? true : value === 'false' ? false : undefined
      if (toggle === undefined) {
        throw new AcpError('bad_config', `acp: "${String(value)}" is not a boolean value of config option "${configId}"`)
      }
      value = toggle
    } else if (typeof value !== 'string' || !option.choices.some(choice => choice.value === value)) {
      throw new AcpError('bad_config', `acp: "${String(value)}" is not a value of config option "${configId}"`)
    }
    const current = this.chatAgentIntent.get(dshSessionId)
    const extraConfigs = current?.agentId === bound ? { ...current.extraConfigs } : {}
    this.patchChatChoice(dshSessionId, { agentId: bound, extraConfigs: { ...extraConfigs, [configId]: value } })
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== bound || session.released) continue
      try {
        await this.bridge(bound).setConfigOption(session, configId, value)
      } catch (error) {
        this.hub.broadcast({
          type: 'agent/notice',
          agentId: bound,
          level: 'error',
          text: `acp: failed to set config "${configId}" to "${value}": ${describeError(error)}`,
        })
      }
    }
  }

  /**
   * Apply a conversation's persisted pick to a session that just materialized —
   * created by the first turn, or resumed through `session/load` after a crash.
   *
   * This is what makes an up-front choice real rather than decorative: the
   * session/new and session/load answers come back with the AGENT's defaults,
   * which would otherwise run the first message on a model the user already
   * replaced. Best effort, exactly like the turn path's alignment: a stale
   * model is not applied (and NOT dropped — `streamPrompt` refuses to run a
   * turn on an unknown model until the user reselects), a stale thought level
   * is dropped with a notice, and the agent's own configuration is used in the
   * meantime. Never turned into a different model than the one selected.
   */
  private async applyChatChoice(session: LiveSession): Promise<void> {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const choice = this.chatAgentIntent.get(dshSessionId)
    if (choice === undefined || choice.agentId !== session.agentId) return
    const { choice: modelChoice } = splitAdapterModelId(choice.modelId ?? '')
    const aligned = await this.alignSessionConfig(session, modelChoice, choice.effort)
    // Mirror the pick onto the session so `session/chat-list` reports the
    // conversation's selection. A stale model stays mirrored on purpose: the
    // chip must keep naming what the user chose, and the next send refuses
    // with a message pointing at it.
    if (choice.modelId !== undefined) {
      session.modelId = choice.modelId
      session.choice = modelChoice
    }
    if (choice.effort !== undefined) {
      session.reasoningEffort = aligned.effortStale ? undefined : choice.effort
    }
    // The agent's own mode is the third control in the same composer bar, so it
    // follows the same contract: a mode the agent no longer declares is skipped
    // (warning, not a failed turn) — `session/new` and `session/load` both come
    // back on whatever the agent starts with.
    if (choice.mode !== undefined) {
      const offered = session.modes?.availableModes ?? []
      if (offered.length === 0 || offered.some(mode => mode.id === choice.mode)) {
        try {
          await this.bridge(session.agentId).setMode(session, choice.mode)
        } catch (error) {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: failed to restore mode "${choice.mode}": ${describeError(error)}`,
          })
        }
      } else {
        this.hub.broadcast({
          type: 'agent/notice',
          agentId: session.agentId,
          level: 'error',
          text: `acp: agent "${session.agentId}" no longer offers mode "${choice.mode}"; keeping its own`,
        })
      }
    }
    // The advanced base's picks follow the same contract: apply what the agent
    // still offers, warn and skip what it dropped, never fail the turn.
    if (choice.extraConfigs !== undefined) {
      const extras = parseCatalogOptions(session.configOptions).extras ?? []
      for (const [configId, value] of Object.entries(choice.extraConfigs)) {
        const option = extras.find(entry => entry.configId === configId)
        if (option === undefined) {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: agent "${session.agentId}" no longer offers config "${configId}"; keeping its own`,
          })
          continue
        }
        // A toggle's truth is its boolean itself; a select's is membership in
        // the choices the agent still offers.
        const usable = option.kind === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' && option.choices.some(entry => entry.value === value)
        if (!usable) {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: agent "${session.agentId}" no longer offers "${String(value)}" for config "${configId}"; keeping its own`,
          })
          continue
        }
        try {
          await this.bridge(session.agentId).setConfigOption(session, configId, value)
        } catch (error) {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: failed to restore config "${configId}" to "${value}": ${describeError(error)}`,
          })
        }
      }
    }
  }

  /**
   * Every ACP session's transcript that belongs to one DSH chat session, so the
   * conversation can render the REAL agent stream (tool calls, plans, diffs) as
   * its own view tab. Released sessions keep serving their pre-crash buffer —
   * a dead agent must not blank the history the user is reading.
   *
   * Read-only and synchronous: like `transcript`, it never spawns and never
   * resumes (a `session/load` resume is triggered by *sending*, not looking).
   */
  chatTranscripts(dshSessionId: string, afterSeq?: number): ChatTranscriptView[] {
    const views: ChatTranscriptView[] = []
    for (const session of this.dshSessionMap.values()) {
      // A closed session is destroyed, not merely unreachable: its buffered
      // transcript would be a ghost the user cannot act on.
      if (session.dshSessionId !== dshSessionId || session.closed) continue
      views.push({ session: snapshot(session), entries: session.transcript.since(afterSeq ?? 0) })
    }
    return views
  }

  /**
   * Switch one chat-bound session's ACP mode. A released session is resumed
   * first (`session/load`), matching the "send to recover" promise — the mode
   * switch is itself a reason to bring the agent back.
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    if (agentId !== undefined) {
      const lockedTo = this.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
      }
    }
    const candidates = [...this.dshSessionMap.values()].filter(session => session.dshSessionId === dshSessionId)
    const target = agentId === undefined
      ? (candidates.find(session => !session.released) ?? candidates[0])
      : candidates.find(session => session.agentId === agentId)
    // No live session yet: this is the "choose the mode before the first
    // message" case, and the pick is recorded WITHOUT spawning anything — the
    // session that materializes later reads it back (`applyChatChoice`). This
    // matches `setChatSessionModel`, which has always recorded ahead of a
    // session; refusing here was what made the mode control unusable on a
    // conversation still being set up.
    if (target === undefined) {
      const bound = agentId ?? this.chatAgentFor(dshSessionId)
      if (bound === undefined || !this.defsMap.has(bound)) {
        throw new AcpError('unknown_session', `acp: no live ACP session is bound to chat session ${dshSessionId}`)
      }
      this.patchChatChoice(dshSessionId, { agentId: bound, mode: modeId })
      return
    }
    if (target.closed) {
      throw new AcpError('unknown_session', `acp: the ACP session bound to chat session ${dshSessionId} is closed`)
    }
    const bridge = this.bridge(target.agentId)
    const session = target.released ? await bridge.resumeSession(target) : target
    await bridge.setMode(session, modeId)
    // Persisted only AFTER the agent accepted it: a mode the agent rejected must
    // not come back on the next restore. This is the same contract the model and
    // thought level follow (user decision, 2026-10-18 — every control in the
    // bottom bar remembers its last choice, not just the thought level).
    this.patchChatChoice(dshSessionId, { agentId: target.agentId, mode: modeId })
  }

  /**
   * Wire the harness's preset roster (`ctx.agentPresets`) into `presetStatus`.
   *
   * Optional on purpose: a deployment without the registry service has no
   * roster to report and the panel card hides itself, which is strictly better
   * than inventing a second truth about where presets come from.
   */
  setPresetRosterReader(reader?: () => Promise<readonly RosterPresetRow[] | undefined>): void {
    this.presetRosterReader = reader
  }

  /**
   * Read-only state of the ACP-mode preset in the harness's own roster.
   *
   * The preset is a declaration this package SHIPS (its own bundle patch), so
   * there is nothing to install — what the panel needs to know is whether the
   * roster carries the row and can compose a session from it. `undefined` when
   * the roster cannot be read (no registry service wired): the panel then hides
   * the block rather than claiming the preset is gone.
   */
  async presetStatus(): Promise<AcpPresetStatus | undefined> {
    const reader = this.presetRosterReader
    if (reader === undefined) return undefined
    let rows: readonly RosterPresetRow[] | undefined
    try {
      rows = await reader()
    } catch {
      // An unreadable roster is not a verdict about the preset.
      return undefined
    }
    return acpPresetStatusFromRoster(rows, ACP_PRESET_ID)
  }

  private getStoragePath(): string | undefined {
    if (this.configStoragePath !== undefined) return this.configStoragePath
    if (process.env.DSH_ACP_CONFIG_FILE) return process.env.DSH_ACP_CONFIG_FILE
    // The test-runner guard exists so a suite never reads or writes the real
    // home directory. An explicitly redirected state dir (tests that exercise
    // the migration, or a relocated deployment) is already hermetic, so it is
    // allowed through instead of silently disabling persistence.
    if (!stateDirExplicit() && (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test')) {
      return undefined
    }
    try {
      // A legacy registry that has not been migrated yet stays readable; the
      // next persist writes to the plugin's own state dir and retires it.
      const migrated = join(pluginStateDir(), 'agents.json')
      if (!existsSync(migrated)) {
        const legacy = legacyFallback('agents')
        if (existsSync(legacy)) return legacy
      }
      mkdirSync(pluginStateDir(), { recursive: true })
      return migrated
    } catch {
      return undefined
    }
  }

  /**
   * Read the agent registry file.
   *
   * TWO shapes on purpose: version 1 was a bare array of agent definitions,
   * while `defaultAgentId` (the panel's ★ gesture — the agent an ACP-mode
   * conversation should start on) needs a home that is not the deployment
   * default model. A legacy bare array still loads; it is rewritten in the
   * current shape on the next persist.
   */
  private loadPersistedAgents(): void {
    const filePath = this.getStoragePath()
    if (!filePath || !existsSync(filePath)) return
    try {
      const content = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(content) as unknown
      const rows = Array.isArray(parsed)
        ? parsed
        : (parsed !== null && typeof parsed === 'object' ? (parsed as { agents?: unknown }).agents : undefined)
      if (Array.isArray(rows)) {
        let rewritten = false
        for (const item of rows) {
          try {
            // `rewriteLegacyWorkspaceRoots` folds a definition that still names
            // the pre-migration workspace into the plugin's own state dir: the
            // recorded absolute cwd is fed straight to `session/new`, and the
            // cwd resolver rejects one that does not exist.
            const validated = validateAgentDef(quoteLegacyCommand(item))
            const def = rewriteLegacyWorkspaceRoots(validated)
            if (def !== validated) rewritten = true
            this.defsMap.set(def.id, def)
          } catch {
            // Ignore invalid entry
          }
        }
        // Write the corrected paths back. Without this the correction lives
        // only in memory: the directory was already renamed, so the file on
        // disk keeps naming a cwd that no longer exists, and every boot has to
        // repair it again (and anything reading the file directly sees the
        // stale path).
        if (rewritten) this.persistAgents()
      }
      if (!Array.isArray(parsed) && parsed !== null && typeof parsed === 'object') {
        const stored = (parsed as { defaultAgentId?: unknown }).defaultAgentId
        // Kept as-is (even when it names an agent this boot did not load):
        // `defaultAgent()` is the accessor that filters a stale id out, so a
        // temporarily unreadable agent list cannot silently erase the choice.
        if (typeof stored === 'string' && stored !== '') this.defaultAgentId = stored
        // The halo preference is validated on write, but the file is user- or
        // version-editable: an unreadable value falls back to the default
        // rather than poisoning every read.
        try {
          this.tagHaloSetting = validateTagHalo((parsed as { tagHalo?: unknown }).tagHalo)
        } catch {
          this.tagHaloSetting = { ...DEFAULT_TAG_HALO }
        }
        this.loadPersistedChoices((parsed as { conversations?: unknown }).conversations)
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  /**
   * Read the per-conversation picks back. Tolerant on purpose, one row at a
   * time: a single corrupt entry must not cost the user every other
   * conversation's set-up. Entries are kept even when the named agent is not
   * configured on this boot — `chatChoice` filters those out, so a temporarily
   * missing agent does not erase the choice it was made for.
   */
  private loadPersistedChoices(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return
    for (const [dshSessionId, row] of Object.entries(raw as Record<string, unknown>)) {
      if (dshSessionId === '' || row === null || typeof row !== 'object') continue
      const { agentId, locked, modelId, effort, mode, extraConfigs } = row as {
        agentId?: unknown; locked?: unknown; modelId?: unknown; effort?: unknown; mode?: unknown; extraConfigs?: unknown
      }
      if (typeof agentId !== 'string' || agentId === '') continue
      const configs = extraConfigs !== null && typeof extraConfigs === 'object' && !Array.isArray(extraConfigs)
        ? Object.fromEntries(Object.entries(extraConfigs as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''))) as Record<string, string | boolean>
        : {}
      this.chatAgentIntent.set(dshSessionId, {
        agentId,
        ...(locked === true ? { locked: true } : {}),
        ...(typeof modelId === 'string' && modelId !== '' ? { modelId } : {}),
        ...(typeof effort === 'string' && effort !== '' ? { effort } : {}),
        ...(typeof mode === 'string' && mode !== '' ? { mode } : {}),
        ...(Object.keys(configs).length === 0 ? {} : { extraConfigs: configs }),
      })
    }
    // Put every restored record back on the REQUEST path, not just in this
    // map: the guard's rewrite and `conversationRouteModel` read the route
    // registry, which starts empty on a fresh process. Without this a host
    // restart would send a bound (and possibly locked) conversation to the
    // deployment default until its next turn re-pinned it.
    for (const dshSessionId of this.chatAgentIntent.keys()) this.syncConversationRoute(dshSessionId)
  }

  private persistAgents(): void {
    const filePath = this.getStoragePath()
    if (!filePath) return
    try {
      const payload = {
        version: 2,
        ...(this.defaultAgentId === undefined ? {} : { defaultAgentId: this.defaultAgentId }),
        tagHalo: this.tagHaloSetting,
        agents: [...this.defsMap.values()],
        // The per-conversation picks: agent + model + thought level + mode +
        // extra config values chosen in the composer, including for
        // conversations with no live session yet.
        ...(this.chatAgentIntent.size === 0
          ? {}
          : { conversations: Object.fromEntries(this.chatAgentIntent) }),
      }
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
    } catch {
      // Storage persist failure is non-fatal
    }
  }

  // ---- Model catalog ----

  private readonly catalogs = new Map<string, { catalog: AcpAgentCatalog; updatedAt: number }>()
  /**
   * The slash commands each agent declared in its most recent session, cached
   * per agent and persisted alongside the model catalog.
   *
   * This is what makes `/` list an agent's commands in a conversation that has
   * not sent its first message yet: before `session/new` there is no live
   * session to ask, and the native menu's immediacy is the bar. A live
   * session's own declaration always outranks this cache. It is learned, never
   * probed — a `session/new` for a menu would spawn an agent (constraint 8).
   */
  private readonly commandCache = new Map<string, { commands: NonNullable<SessionView['availableCommands']>; updatedAt: number }>()
  /**
   * Catalog schema the persisted file was written with. Bumped when a parser
   * gains a category, so a cache written by an older build is KNOWN to be
   * incomplete — a persisted `{model, thought}` catalog from v1 would otherwise
   * keep an agent looking like it has no `mode` axis forever.
   *
   * A stale entry is still SERVED (dropping it would blank the seats across an
   * upgrade) and is repaired for free the next time that agent's own session
   * publishes `configOptions` (`absorbCatalog`). It is NOT re-probed at boot:
   * a probe spawns a process, and starting agents nobody is talking to is the
   * defect this marker used to cause (user report, 2026-10-18).
   *
   * v2 = `mode` (`category: 'mode'`) joined `model` / `thought_level`.
   * v3 = every other select joined as `extras` (the composer's advanced base).
   */
  private static readonly CATALOG_SCHEMA = 3
  /** Agents whose persisted catalog predates {@link CATALOG_SCHEMA}. */
  private readonly catalogStale = new Set<string>()
  /** Auto-spawning probes are suppressed under test runners so suites stay deterministic. */
  private readonly autoProbeEnabled = process.env.VITEST === undefined && process.env.NODE_ENV !== 'test'

  private getCatalogStoragePath(): string | undefined {
    if (this.catalogStoragePath !== undefined) return this.catalogStoragePath
    if (process.env.DSH_ACP_CATALOG_FILE) return process.env.DSH_ACP_CATALOG_FILE
    if (!stateDirExplicit() && (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test')) {
      return undefined
    }
    try {
      const migrated = join(pluginStateDir(), 'model-catalog.json')
      if (!existsSync(migrated)) {
        const legacy = legacyFallback('catalog')
        if (existsSync(legacy)) return legacy
      }
      mkdirSync(pluginStateDir(), { recursive: true })
      return migrated
    } catch {
      return undefined
    }
  }

  private loadPersistedCatalogs(): void {
    const filePath = this.getCatalogStoragePath()
    if (!filePath || !existsSync(filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
      const agents = parsed.agents
      if (typeof agents !== 'object' || agents === null) return
      // A cache written by an older build answers with a PARTIAL surface: it may
      // predate a category entirely. It is still served (dropping it would blank
      // the seats across the upgrade) and marked stale; `absorbCatalog` repairs
      // it for free the next time that agent's own session publishes its
      // options. No probe is spawned here on purpose — see `CATALOG_SCHEMA`.
      const stale = parsed.version !== BridgeManager.CATALOG_SCHEMA
      for (const [agentId, raw] of Object.entries(agents)) {
        if (typeof raw !== 'object' || raw === null) continue
        const row = raw as { catalog?: unknown; updatedAt?: unknown; commands?: unknown; commandsUpdatedAt?: unknown }
        // Commands and the model catalog are learned independently (a session
        // may declare one before the other), so either half alone is a valid row.
        if (Array.isArray(row.commands)) {
          this.commandCache.set(agentId, {
            commands: row.commands as NonNullable<SessionView['availableCommands']>,
            updatedAt: typeof row.commandsUpdatedAt === 'number' ? row.commandsUpdatedAt : 0,
          })
        }
        if (typeof row.catalog !== 'object' || row.catalog === null) continue
        this.catalogs.set(agentId, {
          catalog: row.catalog as AcpAgentCatalog,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        })
        if (stale) this.catalogStale.add(agentId)
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  private persistCatalogs(): void {
    const filePath = this.getCatalogStoragePath()
    if (!filePath) return
    try {
      const agents: Record<string, {
        catalog?: AcpAgentCatalog
        updatedAt?: number
        commands?: NonNullable<SessionView['availableCommands']>
        commandsUpdatedAt?: number
      }> = {}
      for (const [agentId, entry] of this.catalogs) agents[agentId] = { catalog: entry.catalog, updatedAt: entry.updatedAt }
      for (const [agentId, entry] of this.commandCache) {
        agents[agentId] = { ...(agents[agentId] ?? {}), commands: entry.commands, commandsUpdatedAt: entry.updatedAt }
      }
      writeFileSync(filePath, JSON.stringify({ version: BridgeManager.CATALOG_SCHEMA, agents }, null, 2), 'utf-8')
    } catch {
      // Storage persist failure is non-fatal
    }
  }

  /**
   * Merge `configOptions` observed on any real session into the agent's catalog.
   *
   * This is the SECOND way a catalog gets refreshed (the first being an explicit
   * `probeAgentModels`), and the only one that happens for free: it rides a
   * session the user is already running. It therefore also discharges the
   * {@link CATALOG_SCHEMA} staleness mark — whatever an older parser missed, the
   * current `parseCatalogOptions` has now seen this agent's real answer.
   */
  private absorbCatalog(agentId: string, configOptions: unknown): { catalog: AcpAgentCatalog; updatedAt: number } {
    // Empty / absurd answers never overwrite known state — see `usableConfigOptions`.
    if (!usableConfigOptions(configOptions)) return this.catalogs.get(agentId) ?? { catalog: {}, updatedAt: 0 }
    const catalog = parseCatalogOptions(configOptions)
    this.catalogStale.delete(agentId)
    const existing = this.catalogs.get(agentId)
    // Auto-discovery compares this observation against the catalog known
    // BEFORE it. The first observation is only a baseline — nothing is "new"
    // yet, and calling every choice of a 500-model catalog "new" would flood
    // the selection the switch is meant to keep tidy.
    const exposedChanged = this.autoExposeNewModels(agentId, catalog, existing?.catalog)
    if (existing !== undefined && JSON.stringify(existing.catalog) === JSON.stringify(catalog)) {
      if (exposedChanged) this.broadcastExposure(agentId)
      return existing
    }
    const entry = { catalog, updatedAt: Date.now() }
    this.catalogs.set(agentId, entry)
    this.persistCatalogs()
    // The browser caches the seat surface per agent and only re-reads it when
    // it is told to. A catalog learned from a REAL session is exactly the
    // moment a conversation that was opened before that session needs the new
    // list (first-turn convergence); probing it again would spawn a process.
    this.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
    // After the catalog lands, so a re-read triggered by this frame already
    // sees the new models in `agent/catalog`'s variant expansion.
    if (exposedChanged) this.broadcastExposure(agentId)
    return entry
  }

  /**
   * Fold a per-session option answer's SHAPE into the agent's catalog.
   *
   * The counterpart of {@link absorbCatalog} for `session/set_config_option`
   * responses: which options exist and which choices they offer is agent
   * knowledge the seat must show (the composer's thought chip only renders
   * when the catalog has `thought_level`, and some agents publish it only in
   * the answer to a model change), while a per-session `currentValue` stays
   * out of it. No auto-exposure and no staleness discharge either — this is
   * one session's answer, not the agent-level observation those marks track.
   */
  private absorbCatalogShape(agentId: string, configOptions: unknown): void {
    if (!usableConfigOptions(configOptions)) return
    const observed = parseCatalogOptions(configOptions)
    const existing = this.catalogs.get(agentId)
    const catalog = mergeCatalogShape(existing?.catalog, observed)
    if (existing !== undefined && JSON.stringify(existing.catalog) === JSON.stringify(catalog)) return
    const entry = { catalog, updatedAt: Date.now() }
    this.catalogs.set(agentId, entry)
    this.persistCatalogs()
    this.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
  }

  /**
   * Remember the slash commands an agent declared in a real session.
   *
   * Unlike {@link absorbCatalog} this does NOT feed a model surface — it keeps
   * the agent's `/` menu populated before the next conversation has a session
   * of its own. The live session's declaration is still the authority; this is
   * only what a fresh conversation has to draw from.
   *
   * Deduped on content: agents restate their list freely, and a broadcast per
   * restatement would make every open composer re-read `agent/catalog`.
   */
  private absorbCommands(agentId: string, commands: NonNullable<SessionView['availableCommands']>): void {
    const existing = this.commandCache.get(agentId)
    if (existing !== undefined && JSON.stringify(existing.commands) === JSON.stringify(commands)) return
    const entry = { commands, updatedAt: Date.now() }
    this.commandCache.set(agentId, entry)
    this.persistCatalogs()
    // Same signal as a model catalog learned from a real session: the browser
    // caches `agent/catalog` per agent and re-reads it only when told to. A
    // conversation opened before this session needs the new list for its very
    // first `/`, when there is still no live session to ask.
    this.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
  }

  /**
   * Append models this observation newly introduced to the agent's selection.
   *
   * "Newly introduced" means present in `next` but absent from the catalog
   * known `before` — NOT "absent from the selection". Comparing against the
   * selection would resurrect a model the user deliberately unchecked every
   * time the agent repeats its catalog. The first observation has no baseline
   * (`before === undefined`), so it adds nothing; the user can still add the
   * whole list with one click in the settings card. Discovery is ON unless the
   * agent definition explicitly opts out with `autoDiscoverModels: false`.
   */
  private autoExposeNewModels(agentId: string, next: AcpAgentCatalog, before: AcpAgentCatalog | undefined): boolean {
    const def = this.defsMap.get(agentId)
    if (def === undefined || def.autoDiscoverModels === false || before === undefined) return false
    const known = new Set((before.model?.choices ?? []).map(choice => choice.value))
    const exposed = new Set(def.exposedModels ?? [])
    const added = (next.model?.choices ?? [])
      .map(choice => choice.value)
      .filter(value => !known.has(value) && !exposed.has(value))
    if (added.length === 0) return false
    def.exposedModels = [...(def.exposedModels ?? []), ...added]
    this.persistAgents()
    return true
  }

  /** Tell the browser an agent's model-visibility surface changed outside `agent/save`. */
  private broadcastExposure(agentId: string): void {
    const def = this.defsMap.get(agentId)
    if (def === undefined) return
    this.hub.broadcast({
      type: 'agent/exposure',
      agentId,
      exposedModels: [...(def.exposedModels ?? [])],
      autoDiscoverModels: def.autoDiscoverModels !== false,
    })
  }

  catalogFor(agentId: string): AcpAgentCatalog | undefined {
    return this.catalogs.get(agentId)?.catalog
  }

  /**
   * The settings panel's PERSISTENT catalog read: the last catalog observed for
   * one agent, or `undefined` when it has never published one.
   *
   * Pure memory (the same map `agentCatalog` reads, hydrated from
   * `model-catalog.json` at boot), so opening the settings page costs no agent
   * process. This is what lets the model panes show the configured selection
   * and the last known model list on mount instead of staying blank until
   * someone clicks 「检测可用模型」 — that button is a REFRESH of this cache
   * (models the agent newly publishes appear, models it stopped advertising
   * drop out), not the price of admission.
   */
  cachedAgentModels(agentId: string): AgentProbeModelsResult | undefined {
    const entry = this.catalogs.get(agentId)
    if (entry === undefined) return undefined
    return { agentId, catalog: entry.catalog, updatedAt: entry.updatedAt }
  }

  /**
   * Probe one agent right now: spawn (if needed), open a throwaway session,
   * read its `configOptions`, close it. Errors propagate to the caller (the
   * RPC result or a notice broadcast).
   */
  async probeAgentModels(agentId: string): Promise<AgentProbeModelsResult> {
    const bridge = this.bridge(agentId)
    const configOptions = await bridge.probeConfigOptions()
    const entry = this.absorbCatalog(agentId, configOptions)
    // A fresh probe answers in the CURRENT schema by construction.
    this.catalogStale.delete(agentId)
    return { agentId, catalog: entry.catalog, updatedAt: entry.updatedAt }
  }

  /**
   * Boot-time catalog warm-up.
   *
   * DELIBERATELY DOES NOTHING (user report, 2026-10-18: an unbound conversation
   * showed "Oh My Pi 已连接" in the agent picker, i.e. a second agent process was
   * running for a conversation served by another one).
   *
   * A probe SPAWNS A PROCESS. That is only defensible for an agent the user is
   * actually engaging with, so every probe now has a gesture behind it:
   *
   *  - a conversation bound to that agent → its first `session/new` fills the
   *    catalog in via `absorbCatalog` (that is the agent the user is talking to,
   *    already running);
   *  - the settings card's own button → `agent/probe-models`, one explicit click
   *    on one agent;
   *  - a STALE on-disk entry → repaired by `absorbCatalog` the next time that
   *    agent's own session publishes its options, not at boot.
   *
   * Probing every configured agent at startup — which is what this did — turns
   * "open the app" into "start N agent processes", and the picker then honestly
   * reports them as connected, which is exactly the confusion reported.
   */
  bootstrapCatalogs(): void {
    // Intentionally empty; kept as the boot hook's name so the host entry does
    // not have to change, and so the rule lives where the call is.
  }

  /**
   * The ACP model surface for ONE agent — the seats' own list (see
   * `AgentCatalogResult`). This is what the chat composer's ACP cluster and the
   * ACP-mode model seat render; DSH's native selector has no ACP entries at all
   * (`AcpLlmAdapter.listModels` advertises nothing), because the host builds one
   * global provider catalog with no per-session seam and every session would
   * then be offered ACP agents as if they were just another model.
   *
   * Variants are opt-in: an agent with no `exposedModels` (or an empty list)
   * offers only its base entry. Offering the whole catalog by default is not a
   * feature — these menus have no search, and a real agent publishes hundreds
   * of choices (pi: 500, omp: 581), so "everything by default" is a list storm
   * the user cannot navigate. The base entry is never filtered out.
   *
   * Pure memory — NEVER spawns and NEVER starts a probe. This is a RENDER path:
   * the composer entries call it on every store change, so anything that spawns
   * here turns "open a conversation" into "start every agent" (user report,
   * 2026-10-18: a conversation served by `codebuddy` had `omp` running). A
   * missing or stale catalog is reported honestly (`probed: false`, or the stale
   * entry's contents), and the probe is started by an explicit gesture:
   * `agent/probe-models` (the settings card's button) or a session's own
   * `session/new`, both of which are about ONE agent the user is actually using.
   */
  agentCatalog(agentId: string): AgentCatalogResult {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    const title = def.title ?? def.id
    const entry = this.catalogs.get(agentId)
    // NO `ensureCatalog` HERE — see the note above. Reading must stay pure
    // memory, even for a stale or absent entry.
    const exposed = def.exposedModels
    const variants: AgentCatalogResult['variants'] = []
    for (const choice of entry?.catalog.model?.choices ?? []) {
      if (exposed === undefined || !exposed.includes(choice.value)) continue
      variants.push({
        id: buildAdapterModelId(def.id, choice.value),
        // The MODEL name alone, not `<agent> · <model>`: the picker already
        // groups these under "<agent>'s models", and the composer chip sits next
        // to the agent chip, so repeating the agent name in every row was noise
        // on top of noise (user report, 2026-10-18).
        name: choice.name,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
      })
    }
    const reasoning = this.reasoningMeta(agentId)
    const modelOption = entry?.catalog.model
    // The model the agent reports it is ON (its `model.currentValue`, refreshed
    // every time a session publishes `configOptions`). This is what the base
    // entry NAMES: `base` is the bare `agentId` route ("let the agent choose"),
    // and the honest way to describe that route is by the model it actually
    // resolves to — "CodeBuddy Code · Hy3", not just "CodeBuddy Code". Without
    // the model name the checked row in the picker said nothing about which
    // model it was (user report, 2026-10-18).
    //
    // An agent can also sit on a model it no longer offers (or report a value it
    // forgot to list): report it with the raw value as its name rather than
    // dropping it — dropping it is what removes the model chip entirely.
    const currentModelValue = modelOption?.currentValue ?? null
    const currentModelChoice = currentModelValue === null
      ? undefined
      : modelOption?.choices.find(choice => choice.value === currentModelValue)
        ?? { value: currentModelValue, name: currentModelValue }
    const baseName = currentModelChoice === undefined
      ? title
      : `${title} · ${currentModelChoice.name}`
    const modeOption = entry?.catalog.mode
    const extraOptions = entry?.catalog.extras ?? []
    const commands = this.commandCache.get(agentId)
    return {
      agentId: def.id,
      title,
      base: {
        id: def.id,
        name: baseName,
        description: `ACP Agent: ${def.command} ${(def.args ?? []).join(' ')}`.trim(),
      },
      variants,
      probed: entry !== undefined,
      ...(reasoning !== undefined ? { reasoning } : {}),
      // The agent's OWN current model, so the model chip has something to show
      // before this conversation has picked one. Absent when the agent publishes
      // no model selector at all — then there really is no model axis.
      ...(currentModelChoice === undefined ? {} : {
        currentModel: {
          value: currentModelChoice.value,
          name: currentModelChoice.name,
          ...(currentModelChoice.description === undefined ? {} : { description: currentModelChoice.description }),
        },
      }),
      // Same reason, for the mode select: before `session/new` there is no live
      // session to read `modes` from, and the control would silently vanish on a
      // conversation the user is still setting up.
      ...(modeOption === undefined ? {} : {
        mode: {
          ...(modeOption.currentValue === null ? {} : { currentValue: modeOption.currentValue }),
          choices: modeOption.choices.map(choice => ({
            id: choice.value,
            name: choice.name,
            ...(choice.description === undefined ? {} : { description: choice.description }),
          })),
        },
      }),
      // The advanced base's content: every select without a dedicated control.
      // The browser overlays the conversation's `extraConfigs` on these current
      // values, so a pick made before the first session still shows as chosen.
      ...(extraOptions.length === 0 ? {} : {
        extras: extraOptions.map(option => ({
          configId: option.configId,
          name: option.name,
          ...(option.kind === 'boolean' ? { kind: 'boolean' as const } : {}),
          ...(option.currentValue === null ? {} : { currentValue: option.currentValue }),
          choices: option.choices.map(choice => ({
            id: choice.value,
            name: choice.name,
            ...(choice.description === undefined ? {} : { description: choice.description }),
          })),
        })),
      }),
      ...(entry === undefined ? {} : { updatedAt: entry.updatedAt }),
      // The agent's last declared slash commands, for a conversation whose own
      // ACP session does not exist yet. Live sessions still answer through
      // `session/chat-list`; this is the pre-first-message fallback only.
      ...(commands === undefined ? {} : {
        commands: commands.commands,
        commandsUpdatedAt: commands.updatedAt,
      }),
    }
  }

  /**
   * Resolve one exact ACP route id for validation/streaming. Unknown agents
   * throw (that is what turns `selectModel` into `model-unavailable`); known
   * agents NEVER throw — a stale variant degrades to a bare-id entry, because
   * the agent may have dropped a model it used to publish and an
   * already-selected session must keep working.
   */
  resolveAdapterModel(provider: string, model: string): LlmResolvedModelInfo {
    const { agentId, choice } = splitAdapterModelId(model)
    const def = this.defsMap.get(agentId)
    if (def === undefined) {
      throw new AcpError('unknown_model', `acp: model "${model}" is unavailable: agent "${agentId}" is not configured`)
    }
    const title = def.title ?? def.id
    if (choice === undefined || choice === '') {
      const reasoning = this.reasoningMeta(agentId)
      return {
        provider,
        id: model,
        name: title,
        description: `ACP Agent: ${def.command} ${(def.args ?? []).join(' ')}`.trim(),
        ...(reasoning !== undefined ? { reasoning } : {}),
      }
    }
    const modelChoice = this.catalogs.get(agentId)?.catalog.model?.choices.find(c => c.value === choice)
    if (modelChoice === undefined) {
      // Stale variant (agent dropped the model): degrade instead of throwing.
      return { provider, id: model, name: model }
    }
    const reasoning = this.reasoningMeta(agentId)
    return {
      provider,
      id: model,
      name: `${title} · ${modelChoice.name}`,
      ...(modelChoice.description !== undefined ? { description: modelChoice.description } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    }
  }

  /**
   * DSH reasoning metadata built from the agent's `thought_level` option:
   * efforts come from its choices and `defaultEffort` from the current value
   * (only when it is one of the choices — DSH rejects unknown defaults).
   */
  private reasoningMeta(agentId: string): LlmModelReasoningInfo | undefined {
    const thought = this.catalogs.get(agentId)?.catalog.thought
    if (thought === undefined) return undefined
    const efforts: LlmReasoningEffortInfo[] = []
    for (const choice of thought.choices) {
      if (efforts.some(e => e.id === choice.value)) continue
      efforts.push({
        id: choice.value,
        name: choice.name,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
      })
    }
    if (efforts.length === 0) return undefined
    const defaultEffort = thought.currentValue
    return {
      efforts,
      ...(defaultEffort !== null && efforts.some(e => e.id === defaultEffort) ? { defaultEffort } : {}),
    }
  }

  /**
   * Bring the live ACP session's model / thought level in line with what the
   * chat UI selected: diff the session's current `configOptions` and call
   * `session/set_config_option` only for drifting entries. Best effort by
   * design — failures broadcast a notice and the turn proceeds with the
   * agent's current configuration.
   *
   * A requested model the agent no longer offers (it publishes a non-empty
   * choice list without it) is STALE. Alignment does NOT apply it and does NOT
   * delete the pick: the caller refuses the turn so another model is never run
   * unexpectedly (see `staleModelChoice` / `streamPrompt`), and the user can
   * see which selection needs replacing. A stale thought level is still
   * dropped with a one-time notice: it does not change WHICH model runs.
   * The notice is tied to that transition, not to every turn — the turn path
   * aligns twice (session materialization, then the prompt) and both calls
   * would otherwise report the same drop.
   */
  private async alignSessionConfig(
    session: LiveSession,
    modelChoice: string | undefined,
    effort: string | undefined,
  ): Promise<{ modelStale: boolean; effortStale: boolean }> {
    const wantedModel = modelChoice !== undefined && modelChoice !== '' ? modelChoice : undefined
    const wantedEffort = effort !== undefined && effort !== '' ? effort : undefined
    const result = { modelStale: false, effortStale: false }
    if (wantedModel === undefined && wantedEffort === undefined) return result
    const catalog = parseCatalogOptions(session.configOptions)
    const bridge = this.bridge(session.agentId)
    const notice = (level: 'info' | 'error', text: string): void => {
      this.hub.broadcast({ type: 'agent/notice', agentId: session.agentId, level, text })
    }
    if (wantedModel !== undefined) {
      const model = catalog.model
      if (model === undefined) {
        notice('error', `acp: agent "${session.agentId}" exposes no model selector; ignoring model "${wantedModel}"`)
      } else if (model.currentValue === wantedModel) {
        // Already in force: nothing to do.
      } else if (model.choices.length > 0 && !model.choices.some(choice => choice.value === wantedModel)) {
        // Do NOT drop the pick or fall back here: the caller refuses the turn
        // (see `staleModelChoice`), so the conversation can never silently run
        // a model the user did not choose.
        result.modelStale = true
      } else {
        try {
          await bridge.setConfigOption(session, model.configId, wantedModel)
        } catch (error) {
          notice('error', `acp: failed to switch model to "${wantedModel}": ${describeError(error)}`)
        }
      }
    }
    if (wantedEffort !== undefined) {
      const thought = catalog.thought
      if (thought === undefined) {
        // The agent publishes no thought_level option: there is nothing this
        // pick could ever be applied to (the chip is absent too).
      } else if (thought.currentValue === wantedEffort) {
        // Already in force.
      } else if (thought.choices.length > 0 && !thought.choices.some(choice => choice.value === wantedEffort)) {
        result.effortStale = true
        if (this.dropStalePick(session, 'effort', wantedEffort)) {
          notice('error', `acp: agent "${session.agentId}" no longer offers thought level "${wantedEffort}"; using its own current level`)
        }      } else {
        try {
          await bridge.setConfigOption(session, thought.configId, wantedEffort)
        } catch (error) {
          notice('error', `acp: failed to set thought level "${wantedEffort}": ${describeError(error)}`)
        }
      }
    }
    return result
  }

  /**
   * Remove one persisted pick the agent no longer honours. Only the thought
   * level uses this today: a stale MODEL pick is deliberately kept and the
   * turn refused, so the user can see which selection must be replaced.
   * Returns true only when a record actually changed — that transition is the
   * news the notice reports.
   */
  private dropStalePick(session: LiveSession, field: 'model' | 'effort', value: string): boolean {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return false
    const choice = this.chatAgentIntent.get(dshSessionId)
    if (choice === undefined || choice.agentId !== session.agentId) return false
    const matches = field === 'model'
      ? choice.modelId === buildAdapterModelId(session.agentId, value)
      : choice.effort === value
    if (!matches) return false
    if (field === 'model') this.patchChatChoice(dshSessionId, { modelId: undefined })
    else this.patchChatChoice(dshSessionId, { effort: undefined })
    return true
  }

  /**
   * The requested model value this session's agent no longer offers, if any —
   * the gate the turn path uses to refuse before sending anything.
   *
   * Reads only the session's OWN latest `configOptions` (the same authority
   * alignment uses): a non-empty choice list without the value means the agent
   * dropped it, and applying is impossible. `undefined` means either no model
   * was requested, it is in force, or nothing authoritative is available (no
   * selector, or a selector without choices) — those keep the previous
   * best-effort behavior instead of wedging the conversation.
   *
   * Falling back to "whatever the agent runs" here is exactly the surprise this
   * gate forbids: a different model can differ in price and capability. The
   * pick is kept so the failure names a selection the user can act on.
   */
  private staleModelChoice(session: LiveSession, modelChoice: string | undefined): string | undefined {
    const wanted = modelChoice !== undefined && modelChoice !== '' ? modelChoice : undefined
    if (wanted === undefined) return undefined
    const model = parseCatalogOptions(session.configOptions).model
    if (model === undefined) return undefined
    if (model.currentValue === wanted) return undefined
    // A selector without a choice list is unvalidatable; applying it is the
    // existing best effort and the agent decides.
    if (model.choices.length === 0) return undefined
    return model.choices.some(choice => choice.value === wanted) ? undefined : wanted
  }

  private bridge(agentId: string): AgentBridge {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    let bridge = this.bridges.get(agentId)
    if (bridge === undefined) {
      bridge = this.makeBridge(def, (b, reason) => {
        this.connectionLost(b, reason)
      }, (observedAgentId, configOptions, shapeOnly) => {
        if (shapeOnly) this.absorbCatalogShape(observedAgentId, configOptions)
        else this.absorbCatalog(observedAgentId, configOptions)
      }, (observedAgentId, commands) => {
        this.absorbCommands(observedAgentId, commands)
      })
      this.bridges.set(agentId, bridge)
    }
    return bridge
  }

  private find(sessionId: string): { bridge: AgentBridge; session: LiveSession } {
    for (const bridge of this.bridges.values()) {
      const session = bridge.hasSession(sessionId)
      if (session !== undefined) return { bridge, session }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  private tryLocate(sessionId: string): { bridge: AgentBridge; session: LiveSession } | undefined {
    try {
      return this.find(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Locate a session for an interaction, resuming it first when it was
   * released by an agent crash ("send to recover"). Resuming spawns a fresh
   * process and runs `session/load`, so the first prompt after a crash pays
   * the restart cost once and the conversation continues.
   */
  private async locateOrResume(sessionId: string): Promise<{ bridge: AgentBridge; session: LiveSession }> {
    for (const bridge of this.bridges.values()) {
      const session = bridge.hasSession(sessionId)
      if (session !== undefined) return { bridge, session }
    }
    for (const bridge of this.bridges.values()) {
      const released = bridge.hasReleased(sessionId)
      if (released !== undefined) {
        bridge.takeReleased(sessionId)
        const session = await bridge.resumeSession(released)
        return { bridge, session }
      }
      const inflight = bridge.inflightResume(sessionId)
      if (inflight !== undefined) {
        return { bridge, session: await inflight }
      }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  private connectionLost(bridge: AgentBridge, reason: string): void {
    // A dead process cannot settle its prompt: the turn streams riding it end
    // here (their `runPrompt` promise also rejects into settle, but this also
    // covers a promise the connection teardown leaves pending).
    this.disposeTurnStreamsOf(controller => controller.session.agentId === bridge.def.id)
    bridge.releaseAll(reason)
  }

  agentViews(): AgentView[] {
    return [...this.defsMap.values()].map(def => (this.bridges.get(def.id) ?? this.makeBridge(def, () => { /* pre-spawn */ })).view())
  }

  async detectAgents(): Promise<DetectedAgentInfo[]> {
    return detectHostAgents([...this.defsMap.values()])
  }

  async saveAgent(def: AcpAgentDef): Promise<void> {
    const defaultWorkspace = ensureDefaultWorkspace()
    const resolvedCwd = def.cwd ?? defaultWorkspace
    // Deduplicated on purpose: the panel pre-fills the same path in several
    // fields, and the old fallback also appended `process.cwd()`, which handed
    // the agent the whole launch directory as an allowed root.
    const resolvedRoots = (def.allowedCwdRoots && def.allowedCwdRoots.length > 0)
      ? [...new Set(def.allowedCwdRoots)]
      : [...new Set([resolvedCwd, defaultWorkspace])]

    const resolvedDef: AcpAgentDef = {
      ...def,
      cwd: resolvedCwd,
      allowedCwdRoots: resolvedRoots,
    }

    if (this.bridges.has(resolvedDef.id)) {
      await this.stopAgent(resolvedDef.id)
      this.bridges.delete(resolvedDef.id)
    }

    this.defsMap.set(resolvedDef.id, resolvedDef)
    this.persistAgents()
    this.hub.broadcast({
      type: 'agent/status',
      agentId: resolvedDef.id,
      state: 'stopped',
      agent: new AgentBridge(resolvedDef, this.hub, this.transcriptMax, () => {}).view(),
    })
    // A save is user-initiated: probe the model catalog immediately so the ACP
    // seats fill in; a failing startup surfaces as a notice.
    void this.probeAgentModels(resolvedDef.id).catch((error: unknown) => {
      this.hub.broadcast({
        type: 'agent/notice',
        agentId: resolvedDef.id,
        level: 'error',
        text: `acp: model probe failed: ${describeError(error)}`,
      })
    })
  }

  /**
   * Lightweight model-visibility update: mutates the def in place (the live
   * bridge shares the same object, so nothing needs restarting), persists, and
   * republishes status. `undefined` clears the filter, which — being the same
   * as `[]` — leaves only the agent's base entry in the ACP seats.
   */
  async setExposedModels(agentId: string, exposedModels: readonly string[] | undefined): Promise<void> {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    if (exposedModels === undefined) delete def.exposedModels
    else def.exposedModels = [...exposedModels]
    this.persistAgents()
    const bridge = this.bridges.get(agentId)
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: bridge?.state ?? 'stopped',
      ...(bridge === undefined ? {} : { agent: bridge.view() }),
    })
    this.broadcastExposure(agentId)
  }

  /**
   * Toggle auto-discovery of newly published models. Lightweight like
   * `setExposedModels`: the def is mutated in place (live bridges share the
   * object) and persisted; no process is restarted, and the current selection
   * is left exactly as it is. On is the default, so only the opt-out
   * (`false`) is written to the file.
   */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    if (autoDiscoverModels) delete def.autoDiscoverModels
    else def.autoDiscoverModels = false
    this.persistAgents()
    this.broadcastExposure(agentId)
  }

  async deleteAgent(agentId: string): Promise<void> {
    if (this.bridges.has(agentId)) {
      await this.stopAgent(agentId)
      this.bridges.delete(agentId)
    }
    this.defsMap.delete(agentId)
    // The default agent is a pointer INTO this registry: deleting its target
    // must drop the pointer too, or the file would keep naming a ghost.
    if (this.defaultAgentId === agentId) this.defaultAgentId = undefined
    // Same for the request-path binding: a conversation pointed at the deleted
    // agent must fall back (to the default, or to no rewrite) rather than send
    // the next turn after a ghost.
    for (const [dshSessionId, model] of routeBindingRegistry().conversations) {
      if (splitAdapterModelId(model).agentId === agentId) routeBindingRegistry().conversations.delete(dshSessionId)
    }
    if (routeBindingRegistry().defaultModel === agentId) routeBindingRegistry().defaultModel = undefined
    // Both maps are independent (either may be missing), so delete both before
    // deciding whether the file needs rewriting.
    const droppedCatalog = this.catalogs.delete(agentId)
    const droppedCommands = this.commandCache.delete(agentId)
    if (droppedCatalog || droppedCommands) this.persistCatalogs()
    this.persistAgents()
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: 'stopped',
    })
  }

  /**
   * Spawn a throwaway agent process from raw form values and run the ACP
   * handshake against it. The bridge is never registered in `defsMap` /
   * `bridges` and broadcasts on a private hub with no sinks, so a test cannot
   * touch persisted config, real sessions, or the browser event stream. The
   * process is torn down in every outcome.
   */
  async testAgent(def: AcpAgentDef): Promise<AgentTestResult> {
    const bridge = new AgentBridge(def, new EventHub(), 50, () => {})
    const startedAt = Date.now()
    try {
      await bridge.ensureReady()
      const info = bridge.initResult?.agentInfo
      return {
        ok: true,
        ...(info
          ? { agentInfo: { name: info.name, title: info.title ?? undefined, version: info.version } }
          : {}),
        durationMs: Date.now() - startedAt,
        stderr: [...bridge.stderrTail],
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        stderr: [...bridge.stderrTail],
      }
    } finally {
      await bridge.stop().catch(() => { /* already torn down by the failure path */ })
    }
  }

  async startSession(agentId: string, cwd: string | undefined): Promise<{ sessionId: string }> {
    const session = await this.bridge(agentId).createSession(cwd)
    return { sessionId: session.sessionId }
  }

  async prompt(sessionId: string, text: string): Promise<{ turnId: string }> {
    const { bridge, session } = await this.locateOrResume(sessionId)
    if (session.running) throw new AcpError('turn_in_flight', 'acp: this session already has a prompt in flight')
    session.running = true
    session.turnSeq += 1
    const turnId = randomUUID()
    this.hub.broadcast({ type: 'turn/start', sessionId, turnId, text })
    void bridge.runPrompt(session, text, turnId)
      .then(stopReason => {
        session.running = false
        this.hub.broadcast({ type: 'turn/end', sessionId, turnId, stopReason })
      })
      .catch((error: unknown) => {
        session.running = false
        this.hub.broadcast({
          type: 'turn/end',
          sessionId,
          turnId,
          error: describeError(error),
        })
      })
    return { turnId }
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.tryLocate(sessionId)
    if (live === undefined) return // released/stale session: nothing to cancel
    await live.bridge.cancel(live.session)
  }

  async closeSession(sessionId: string): Promise<void> {
    // The turn stream of this session dies with it: a continuation step that
    // is already on its way must not resume a closed session.
    this.disposeTurnStreamsOf(controller => controller.session.sessionId === sessionId)
    const live = this.tryLocate(sessionId)
    if (live !== undefined) {
      await live.bridge.closeSession(live.session, 'closed')
      this.forgetDshSession(sessionId)
      return
    }
    // A released session has no process left to close; just drop the record.
    for (const bridge of this.bridges.values()) {
      if (bridge.dropReleased(sessionId)) {
        this.hub.broadcast({ type: 'session/closed', sessionId, reason: 'closed' })
        return
      }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const { bridge, session } = await this.locateOrResume(sessionId)
    await bridge.setMode(session, modeId)
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    const { bridge, session } = await this.locateOrResume(sessionId)
    await bridge.setConfigOption(session, configId, value)
  }

  respondPermission(requestId: string, optionId: string | undefined): void {
    for (const bridge of this.bridges.values()) {
      const owner = bridge.permissions.sessionIds().find(p => p.requestId === requestId)
      if (owner === undefined) continue
      bridge.permissions.respond(requestId, optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId })
      return
    }
    throw new AcpError('unknown_request', `acp: no pending permission ${requestId}`)
  }

  transcript(sessionId: string, afterSeq: number | undefined): { session: unknown; entries: Array<{ seq: number; update: unknown }> } {
    const live = this.tryLocate(sessionId)
    if (live !== undefined) {
      return { session: snapshot(live.session), entries: live.session.transcript.since(afterSeq ?? 0) }
    }
    // A released session still serves its pre-crash transcript for viewing.
    for (const bridge of this.bridges.values()) {
      const released = bridge.hasReleased(sessionId)
      if (released !== undefined) {
        return { session: snapshot(released), entries: released.transcript.since(afterSeq ?? 0) }
      }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  sessions(): unknown[] {
    return [...this.bridges.values()].flatMap(b => [...b.sessionList, ...b.releasedList].map(snapshot))
  }

  async stopAgent(agentId: string): Promise<void> {
    for (const [key, session] of this.dshSessionMap) {
      if (session.agentId === agentId) this.dshSessionMap.delete(key)
    }
    this.disposeTurnStreamsOf(controller => controller.session.agentId === agentId)
    await this.bridges.get(agentId)?.stop('agent-stopped')
  }

  async shutdownAll(): Promise<void> {
    this.dshSessionMap.clear()
    this.disposeTurnStreamsOf(() => true)
    await Promise.all([...this.bridges.values()].map(b => b.stop('agent-stopped')))
  }

  /** Host-side reader of the harness preset roster (`ctx.agentPresets`), for `presetStatus`. */
  private presetRosterReader?: () => Promise<readonly RosterPresetRow[] | undefined>

  /**
   * The plugin's own default ACP agent (the panel's ★ gesture): which agent an
   * ACP-mode conversation starts on. Host-side state in the agent registry
   * file — deliberately NOT a DSH model route: nothing here ever writes to the
   * host's model selection (see docs/acp-convergence.md §2.2).
   */
  defaultAgent(): string | undefined {
    // A default pointing at a deleted agent answers as "none": the browser
    // then offers the agent menu instead of auto-routing nowhere.
    return this.defaultAgentId !== undefined && this.defsMap.has(this.defaultAgentId) ? this.defaultAgentId : undefined
  }

  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    if (agentId !== undefined && !this.defsMap.has(agentId)) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    this.defaultAgentId = agentId
    this.persistAgents()
    // The request-path rewrite falls back to it for never-bound conversations.
    routeBindingRegistry().defaultModel = agentId
  }

  /** The agent tag's halo preference (composer display, plugin-private). */
  tagHalo(): AcpTagHalo {
    return this.tagHaloSetting
  }

  async setTagHalo(halo: AcpTagHalo): Promise<void> {
    // Rebuild through the validator so every write passes the same gate the
    // RPC route used, whatever the caller (a direct `manager` consumer today,
    // a future non-RPC path tomorrow).
    this.tagHaloSetting = validateTagHalo(halo)
    this.persistAgents()
  }

  private readonly dshSessionMap = new Map<string, LiveSession>()
  /**
   * What each DSH chat session has chosen for its ACP agent — the agent itself
   * plus the agent's model and thought level. Persisted with the agent registry
   * (`conversations`), so the pick survives a host restart and is readable
   * before the conversation has ever run a turn. This is the plugin's own
   * conversation↔agent mapping, never a DSH model route (see `bindChatAgent`).
   */
  private readonly chatAgentIntent = new Map<string, AcpConversationChoice>()

  /** Drop every chat-keyed record pointing at one host session (close/stop paths). */
  private forgetDshSession(sessionId: string): void {
    for (const [key, session] of this.dshSessionMap) {
      if (session.sessionId === sessionId) this.dshSessionMap.delete(key)
    }
  }
  /**
   * Latest native-approval requester. Held as a field (read through a thunk by
   * each bridge) so a requester wired after bridges were built still applies.
   */
  private approvalRequester?: ApprovalRequester
  private sessionWorkspaceResolver?: SessionWorkspaceResolver
  private acpModeResolver?: AcpModeResolver
  /** Cached `chatSessionAcpMode` answers, keyed by DSH chat session id. */
  private readonly acpModeCache = new Map<string, boolean>()
  /** In-flight cold reads behind `chatSessionAcpModeAnswer`, keyed by session id. */
  private readonly acpModeInflight = new Map<string, Promise<boolean | undefined>>()

  /**
   * The agent values the composer is showing for a conversation that has not
   * picked them — the catalog's current model, thought level and extra config
   * values.
   *
   * Captured BEFORE `session/new`: materializing the session absorbs its own
   * defaults into the catalog (`absorbCatalog`), which would overwrite exactly
   * the values the user saw and leave the first turn running the agent's
   * defaults instead. Reading is pure memory, same as `agentCatalog`.
   */
  private displayedChatDefaults(agentId: string): DisplayedChatDefaults | undefined {
    const catalog = this.catalogs.get(agentId)?.catalog
    if (catalog === undefined) return undefined
    const out: DisplayedChatDefaults = {}
    const model = catalog.model?.currentValue
    if (model !== null && model !== undefined && model !== '') {
      out.modelId = buildAdapterModelId(agentId, model)
    }
    // Only the level the chip itself reports: `reasoningMeta` keeps
    // `defaultEffort` only when the current value is one of the agent's levels.
    const effort = this.reasoningMeta(agentId)?.defaultEffort
    if (effort !== undefined) out.effort = effort
    const extraConfigs: Record<string, string | boolean> = {}
    for (const option of catalog.extras ?? []) {
      const value = option.currentValue
      if (option.kind === 'boolean') {
        // The catalog encodes a toggle as 'true' / 'false'; the pick stores the
        // real boolean, exactly like an explicit checkbox click.
        if (value === 'true' || value === 'false') extraConfigs[option.configId] = value === 'true'
        continue
      }
      if (value !== null && value !== undefined && value !== '') extraConfigs[option.configId] = value
    }
    if (Object.keys(extraConfigs).length > 0) out.extraConfigs = extraConfigs
    return Object.keys(out).length === 0 ? undefined : out
  }

  /**
   * Record what the composer showed as this conversation's pick before the
   * first prompt runs.
   *
   * A conversation with no explicit pick displays the agent catalog's current
   * model / thought level / extras, while the ACP session `session/new` just
   * created starts on whatever the agent itself defaults to. Without this the
   * user is shown one model and the agent runs another — the defect reported
   * as "the displayed model was not used". Values the fresh session does not
   * offer are skipped (its `configOptions` are the authority, and the catalog
   * update that rode `session/new` will correct the display), never turned
   * into a failed first turn. Explicit picks always win: only missing fields
   * are filled.
   */
  private seedChatChoiceFromCatalog(
    dshSessionId: string,
    agentId: string,
    session: LiveSession,
    displayed: DisplayedChatDefaults | undefined,
  ): void {
    if (displayed === undefined) return
    const current = this.chatAgentIntent.get(dshSessionId)
    if (current !== undefined && current.agentId !== agentId) return
    const options = parseCatalogOptions(session.configOptions)
    const patch: Partial<AcpConversationChoice> = { agentId }
    let changed = false
    const model = options.model
    if (current?.modelId === undefined && displayed.modelId !== undefined && model !== undefined) {
      const value = splitAdapterModelId(displayed.modelId).choice
      if (value !== undefined && (model.choices.length === 0 || model.choices.some(choice => choice.value === value))) {
        patch.modelId = displayed.modelId
        changed = true
      }
    }
    const thought = options.thought
    if (current?.effort === undefined && displayed.effort !== undefined && thought !== undefined) {
      if (thought.choices.length === 0 || thought.choices.some(choice => choice.value === displayed.effort)) {
        patch.effort = displayed.effort
        changed = true
      }
    }
    if (displayed.extraConfigs !== undefined) {
      const extraConfigs = { ...(current?.agentId === agentId ? current.extraConfigs : undefined) }
      for (const [configId, value] of Object.entries(displayed.extraConfigs)) {
        if (extraConfigs[configId] !== undefined) continue
        const option = options.extras?.find(entry => entry.configId === configId)
        if (option === undefined) continue
        // The fresh session's own option set is the authority for BOTH forms:
        // a toggle must still be a toggle, a select must still offer the value.
        if (option.kind === 'boolean'
          ? typeof value !== 'boolean'
          : typeof value !== 'string' || (option.choices.length > 0 && !option.choices.some(choice => choice.value === value))) continue
        extraConfigs[configId] = value
        changed = true
      }
      if (Object.keys(extraConfigs).length > 0) patch.extraConfigs = extraConfigs
    }
    if (!changed) return
    this.patchChatChoice(dshSessionId, patch)
  }

  async getOrCreateDshSession(dshSessionId: string | undefined, agentId: string, cwd?: string): Promise<LiveSession> {
    // The lock also guards the TURN path, not just the picker: a stale request
    // header or a route rewrite must not start a second, context-less session
    // with another agent under the same conversation.
    if (dshSessionId !== undefined) {
      const lockedTo = this.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError(
          'agent_locked',
          `acp: conversation is locked to agent "${lockedTo}" once its first turn has started; start a new conversation to use another agent`,
        )
      }
    }
    const key = `${dshSessionId ?? 'ephemeral'}:${agentId}`
    const existing = this.dshSessionMap.get(key)
    if (existing !== undefined && !existing.closed && !existing.released) {
      // An existing session already carries context, so this is never a
      // provisional lock; it only repairs a record from before the flag (the
      // next turn's start writes/announces the lock).
      if (dshSessionId !== undefined) this.lockChatAgent(dshSessionId, agentId)
      return existing
    }
    // The session's agent died earlier: resume in place so the conversation
    // context survives via `session/load`.
    if (existing !== undefined && existing.released) {
      const resumed = await this.bridge(agentId).resumeSession(existing)
      // Rebind explicitly: a resume keeps the record's identity, but the chat
      // session id is what native approval routing keys off.
      resumed.dshSessionId = dshSessionId
      // A resume without an explicit pick must keep serving the agent the
      // conversation was ON (its own model string when one was recorded). The
      // recorded pick wins when there is one (it carries the model half).
      if (dshSessionId !== undefined) {
        this.lockChatAgent(dshSessionId, agentId)
        if (this.chatAgentIntent.has(dshSessionId)) this.syncConversationRoute(dshSessionId)
        else routeBindingRegistry().conversations.set(dshSessionId, resumed.modelId ?? agentId)
      }
      // ...and the persisted pick (model / thought level) is re-applied to the
      // freshly loaded session, whose config comes back at the agent's defaults.
      await this.applyChatChoice(resumed)
      // A RESUMED session had context before this call; a lock written here is
      // not provisional even if the conversation record was missing it.
      resumed.provisionalLock = false
      return resumed
    }
    // A chat session runs where its DSH session lives, not in the plugin's
    // sandbox directory: the sidebar's workspace selection IS the session's
    // workspace (`sandboxPolicy.resolve` reports it as `workspaceRoot`), and an
    // agent whose cwd is `~/.dsh/dsh-ntr/workspaces` answers "current workspace"
    // with that path while its Read/Glob/Bash cannot see the user's project.
    // That root is trusted on top of the agent's own roots for this session
    // only (see `chatWorkspaceRoot`); the fallback is the configured cwd.
    const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspaceResolver, dshSessionId)
    // What the composer is showing right now. Must be read BEFORE `session/new`:
    // creating the session absorbs its defaults into the catalog, which would
    // overwrite exactly the values the user saw and bring back "displayed one
    // model, ran another". See `displayedChatDefaults`.
    const displayed = dshSessionId === undefined ? undefined : this.displayedChatDefaults(agentId)
    const session = await this.bridge(agentId).createSession(
      workspaceRoot ?? cwd,
      workspaceRoot === undefined ? [] : [workspaceRoot],
      // ...and the agent PROCESS runs there too, not just the session: see
      // `ensureReady` for why `session/new`'s cwd alone is not enough.
      workspaceRoot,
    )
    // Absent for `/acp`-RPC sessions and for adapter calls without a chat
    // session; those deliberately keep the ledger path (see askNativeApproval).
    session.dshSessionId = dshSessionId
    this.dshSessionMap.set(key, session)
    // Turn the displayed defaults into this conversation's pick, so the first
    // prompt runs on what the user was shown (see `seedChatChoiceFromCatalog`).
    if (dshSessionId !== undefined) this.seedChatChoiceFromCatalog(dshSessionId, agentId, session, displayed)
    // Pin what this conversation now runs on, so a route that does not name it
    // (a fresh session replays the deployment default) is rewritten to reality.
    // The recorded pick wins when there is one (it carries the model half);
    // otherwise the agent that just served this turn is pinned bare.
    if (dshSessionId !== undefined) {
      if (this.chatAgentIntent.has(dshSessionId)) this.syncConversationRoute(dshSessionId)
      else routeBindingRegistry().conversations.set(dshSessionId, agentId)
    }
    // Apply whatever the conversation picked BEFORE this session existed — the
    // model and thought level chosen in the composer ahead of the first message.
    // `session/new` answered with the agent's defaults; without this the first
    // turn would run on them and the pick would only take effect afterwards.
    await this.applyChatChoice(session)
    if (dshSessionId !== undefined) {
      // The first ACP session is the moment the conversation's context starts
      // belonging to this agent. The lock is PROVISIONAL until this turn shows
      // something: if it delivers nothing, `rollbackFirstTurn` gives the
      // conversation back (a failed first attempt must not trap it).
      session.provisionalLock = this.lockChatAgent(dshSessionId, agentId)
    }
    return session
  }

  async *streamPrompt(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The plugin's own conversation↔agent mapping decides who serves the turn
    // (see `bindChatAgent`): the driver may arrive here with the previous
    // agent's id (the logged request header replays) or a session that has
    // never run an ACP turn at all. An explicit binding outranks it.
    //
    // A LOCKED conversation outranks even that: its agent is the one holding
    // the context, so the turn must not be redirected by a stale header, a
    // route registry entry purged by a delete/re-add, or the deployment
    // default. The persisted model half is used when the route no longer names
    // the locked agent.
    const lockedTo = options.sessionId === undefined ? undefined : this.lockedAgentFor(options.sessionId)
    const routed = options.sessionId === undefined ? undefined : this.conversationRouteModel(options.sessionId)
    const model = options.sessionId === undefined
      ? options.model
      : lockedTo !== undefined
        ? (routed !== undefined && splitAdapterModelId(routed).agentId === lockedTo
          ? routed
          : this.chatChoice(options.sessionId)?.modelId ?? lockedTo)
        : routed ?? options.model
    const { agentId, choice } = splitAdapterModelId(model)
    const def = this.defsMap.get(agentId)
    if (def === undefined) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `acp: agent "${agentId}" is not configured`, code: 'unknown_agent' } },
      }
      return
    }

    // Auxiliary host calls (`session-title`, `compaction`) ride the session's
    // logged route, so they reach this adapter looking like a turn. They are not
    // conversation: forwarding one would spend a remote agent turn on a title
    // prompt, or worse, fold it into the ACP agent's own context. Refuse before
    // touching (or spawning) anything — the title service degrades to its text
    // fallback and compaction is best-effort.
    if (options.purpose !== undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `acp: "${options.purpose}" is an auxiliary harness call, not a conversation turn — an ACP agent cannot serve it`,
            code: 'unsupported_purpose',
          },
        },
      }
      return
    }

    // A segmented tool-bearing turn arrives as MANY driver steps. The host
    // loop starts a next step whenever the settled assistant message contains
    // `tool-call` blocks — which is exactly what the ACP agent's cards are —
    // feeding it the staged tool results. Each such step RESUMES the same
    // in-flight `session/prompt` from the transcript cursor: nothing is sent
    // to the ACP agent (it runs its own loop inside ONE prompt call — see
    // `isAcpToolContinuation` and docs/acp-convergence.md §1.7).
    if (isAcpToolContinuation(options.messages ?? [])) {
      const controller = options.sessionId === undefined ? undefined : this.turnStreamFor(options.sessionId)
      if (controller === undefined || controller.stale) {
        // No in-flight turn of ours owns these staged results (a foreign
        // continuation, or one that outlived its turn): answer with one
        // closing message instead of touching the agent.
        const line = `\n[dsh-ntr] this conversation has no in-flight ACP turn to resume; the tool details are in the ACP transcript view.\n`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: line }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: line } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const segment = controller.startSegment()
      const onAbort = () => {
        void this.bridge(controller.session.agentId).cancel(controller.session)
        controller.abortActiveSegment()
      }
      if (options.signal?.aborted) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        yield* segment.queue
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        // The FINAL continuation step retires the controller: settle ran, this
        // segment closed, and no further continuation can come for its cards.
        if (controller.hasSettled && segment.finished) controller.dispose()
      }
      return
    }

    // Forward the person's own words: the host folds its context sections
    // (AGENTS.md digest, skill catalog, runtime snapshot) after the claimed user
    // batch precisely so a consumer can tell them apart by `source` — see
    // `selectForwardPrompt` and AGENTS.md rule 16.
    const selection = selectForwardPrompt(options.messages ?? [])
    if (selection.kind === 'no-user-input') {
      // An injected-context wake: nothing the user said, nothing to send.
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (selection.kind === 'empty') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'acp: this request carries no user message to forward', code: 'empty_prompt' },
        },
      }
      return
    }

    let session: LiveSession
    try {
      session = await this.getOrCreateDshSession(options.sessionId, agentId)
    } catch (err) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: describeError(err), code: 'session_init_failed' } },
      }
      return
    }

    const bridge = this.bridge(agentId)

    // The model the conversation asks for is not one this agent offers any
    // more: refuse BEFORE sending anything. Falling back to "whatever the agent
    // runs" would silently spend the user's turn on a model they did not
    // choose (different price and capability); the pick is kept so the error
    // and the chip both name the selection that must be replaced.
    const blockedModel = this.staleModelChoice(session, choice)
    if (blockedModel !== undefined) {
      // Nothing was exchanged, so a provisional first turn must hand the
      // conversation back (same rule as any other zero-output failure).
      if (session.provisionalLock === true) this.rollbackFirstTurn(session)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `acp: the selected model "${blockedModel}" is not offered by agent "${agentId}" any more; choose another model and send again`,
            code: 'model_unavailable',
          },
        },
      }
      return
    }

    // One prompt slot per session, and a turn the user aborted still occupies
    // the AGENT's slot until it acknowledges the cancel (see `claimTurn`).
    const claim = await bridge.claimTurn(session)
    if (!claim.ok) {
      // A first turn that never got the prompt slot delivered nothing either:
      // give the conversation back instead of leaving it locked to an agent
      // that refused the only message it was asked to serve.
      if (session.provisionalLock === true) this.rollbackFirstTurn(session)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: claim.reason === 'busy'
              ? 'acp: this session already has a prompt in flight'
              : 'acp: the agent is still finishing the previous (cancelled) turn; send again in a moment',
            code: 'turn_in_flight',
          },
        },
      }
      return
    }

    // Same-agent model/effort switches ride the SAME ACP session (context
    // stays continuous); switching to another agent lands in a separate one
    // via the `${dshSessionId}:${agentId}` key in getOrCreateDshSession.
    // An adapter-DEFAULTED effort is not a choice (see `modelDefaultEffort`):
    // recording or re-applying one would revert the seat's own pick.
    const requestedEffort = options.reasoningEffort
    const turnEffort = requestedEffort !== undefined && requestedEffort === this.modelDefaultEffort(agentId)
      ? undefined
      : requestedEffort
    const aligned = await this.alignSessionConfig(session, choice, turnEffort)
    // The config may have changed between the pre-flight check and this
    // alignment (a `config_option_update` landed in that window). Same rule:
    // never run a model the user did not select.
    if (aligned.modelStale) {
      if (session.provisionalLock === true) this.rollbackFirstTurn(session)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `acp: the selected model "${choice ?? ''}" is not offered by agent "${agentId}" any more; choose another model and send again`,
            code: 'model_unavailable',
          },
        },
      }
      return
    }
    // Record what this conversation is now on, so `session/chat-list` can show
    // it without the browser having to derive it from anything else. A
    // materialized-default effort leaves the recorded pick standing: the agent
    // still runs it (the align above was skipped), and erasing it would make
    // the chip claim "default" for a conversation the user explicitly tuned.
    //
    // A BARE route (`agentId`, "let the agent choose") must not overwrite the
    // conversation's own pick: `applyChatChoice` just aligned the session to
    // the value the composer showed (including the defaults seeded for a fresh
    // conversation), and recording the bare id instead sends the model chip
    // back to the agent-level catalog — which any other conversation of the
    // same agent can move.
    const recorded = options.sessionId === undefined ? undefined : this.chatChoice(options.sessionId)
    const recordedModel = recorded !== undefined && recorded.agentId === agentId ? recorded.modelId : undefined
    // No pick at all: report the model the session itself is on (the agent's
    // own default), never the bare route — a bare id would make the chip read
    // the agent-level catalog, which other conversations can move.
    const liveModel = parseCatalogOptions(session.configOptions).model?.currentValue
    const fallbackModel = liveModel !== null && liveModel !== undefined && liveModel !== ''
      ? buildAdapterModelId(agentId, liveModel)
      : model
    const effectiveModel = choice !== undefined ? model : recordedModel ?? fallbackModel
    session.modelId = effectiveModel
    session.choice = choice ?? splitAdapterModelId(effectiveModel).choice
    if (aligned.effortStale) session.reasoningEffort = undefined
    else if (turnEffort !== undefined) session.reasoningEffort = turnEffort

    const promptText = selection.text

    // Re-resolve the ACP-preset verdict every turn (a switch made mid-
    // conversation must land on the next prompt). It is a report for the browser
    // surfaces, not a policy switch: the host arbitrates nothing about the
    // agent's own permissions (see docs/acp-convergence.md §2.3).
    if (session.dshSessionId !== undefined) {
      const resolved = await this.acpModeResolver?.(session.dshSessionId)
      session.acpMode = resolved === true
      // This turn may log an `agent-preset/selected` (a blank-session
      // recompose) and any persistence read observed the log BEFORE it: drop
      // the cached verdict so a later ask re-reads against the moved log.
      this.invalidateAcpMode(session.dshSessionId)
    } else {
      session.acpMode = false
    }

    session.running = true
    session.turnSeq += 1
    const turnId = randomUUID()
    this.hub.broadcast({ type: 'turn/start', sessionId: session.sessionId, turnId, text: promptText })

    // The segmented turn: ONE controller for the whole agent-side prompt, one
    // segment per driver step. The first segment streams until a card-bearing
    // stretch meets the next non-tool event (or the prompt settles); the host
    // loop then executes the card and proposes the continuation step, which
    // resumes the SAME prompt through the branch above.
    const endTurn = bridge.beginTurn(session)
    const controller = new TurnStreamController(
      this,
      this.hub,
      bridge,
      session,
      turnId,
      endTurn,
      victim => this.rollbackFirstTurn(victim),
    )
    if (session.dshSessionId !== undefined) this.rememberTurnStream(session.dshSessionId, controller)
    const segment = controller.startSegment()
    const onAbort = (): void => {
      if (controller.stale) return
      void bridge.cancel(session)
      controller.abortActiveSegment()
    }

    if (options.signal?.aborted) {
      onAbort()
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // The agent-side turn is in flight from here until its response lands
      // (or the connection dies): that window, not our own stream, is what the
      // next turn has to respect. Settlement reaches the controller, which
      // releases the slot (`endTurn`) whether the segment on air is the first
      // or a continuation one.
      bridge.runPrompt(session, promptText, turnId)
        .then(stopReason => {
          controller.settle(stopReason === 'cancelled'
            ? { kind: 'cancelled' }
            : { kind: 'stop', stopReason })
        })
        .catch((err: unknown) => {
          controller.settle({ kind: 'error', message: describeError(err) })
        })
    }

    try {
      yield* segment.queue
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      // The FIRST segment never retires its controller here: a card-bearing
      // turn keeps it indexed so its continuation steps can resume the prompt,
      // and a card-less or cancelled one already disposed itself in `settle`.
    }
  }
}

export class AcpLlmAdapter implements LlmAdapterLike {
  constructor(private readonly manager: BridgeManager) {}

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ACP' }
  }

  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /**
   * Advertise NOTHING, on purpose (see `AgentCatalogResult` and
   * `BridgeManager.agentCatalog`).
   *
   * DSH's model catalog is per request, not per session (`buildModelCatalog(ctx)`
   * takes no session id), so an `acp` that listed models would list them in
   * every conversation — including the ones with no ACP agent behind them. The
   * catalog is advisory (its own contract: "an adapter may accept unlisted model
   * ids, and consumers must not turn absence into request rejection"), and route
   * liveness is judged by registration, not by this list, so `acp@agent` and
   * `acp@agent@choice` still resolve and stream while being advertised nowhere.
   * An empty list also keeps this hot path (every `session.models` / `llm.models`
   * request) allocation-free: there is no per-session seam to filter with, so
   * nothing may be listed until there is. The ACP seats read the per-agent view
   * through `agent/catalog` instead.
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return []
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.manager.resolveAdapterModel(provider, model)
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.manager.streamPrompt(options)
  }
}

export class AsyncQueue<T> {
  private queue: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ done: false, value: item })
    } else {
      this.queue.push(item)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!
      resolver({ done: true, value: undefined as never })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!
      } else if (this.closed) {
        return
      } else {
        const item = await new Promise<IteratorResult<T>>(resolve => {
          this.resolvers.push(resolve)
        })
        if (item.done) return
        yield item.value
      }
    }
  }
}

/** A JSON-RPC internal error for fs requests: actionable text in `message`, mirrored into `data` (see AGENTS.md rule 5). */
function fsRequestError(message: string): RequestError {
  return new RequestError(-32603, message, { message })
}

/**
 * JSON-RPC errors often carry the actionable detail in `data` (e.g. pi-acp * reports { errorKind: 'billing_error', message: '…' } while `message` is the
 * generic "Internal error"). Surface both.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const data = (error as { data?: { errorKind?: unknown; message?: unknown } }).data
    const kind = typeof data?.errorKind === 'string' ? data.errorKind : undefined
    const detail = typeof data?.message === 'string' ? data.message : undefined
    const tail = [kind, detail].filter((v): v is string => v !== undefined && v !== '').join(': ')
    return tail === '' ? error.message : `${error.message} — ${tail}`
  }
  return String(error)
}
