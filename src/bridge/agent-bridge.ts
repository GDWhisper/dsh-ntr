import { spawn, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import {
  AcpError,
  PermissionLedger,
  Transcript,
  childEnv,
  normalizeApprovalWindow,
  permissionRequestFrame,
  pickAutoOption,
  randomUUID,
  resolveFsPath,
  resolveSessionCwd,
  usableConfigOptions,
} from '../impl.ts'
import type { EventHub } from '../impl.ts'
import type {
  AcpAgentDef,
  AcpReleaseCause,
  AgentView,
  PermissionOutcome,
  PermissionOptionView,
  PermissionTimeoutMode,
  SessionView,
} from '../protocol.ts'
import {
  PLUGIN_VERSION,
  isPerSessionAgent,
  perSessionLaunchArgs,
  perSessionLaunchEnv,
} from './identity.ts'
import type { BridgeState, BridgeTuning, SessionWorkspaceResolver, StartAttempt } from './types.ts'
import { chatWorkspaceRoot, safeSpawnCwd } from './state-paths.ts'
import {
  disposeChild,
  ensureAgentExecutable,
  findExecutable,
  trackAgentChild,
  waitForChildExit,
  windowsShimLaunch,
} from './process.ts'
import {
  AMBIENT_NOTICE_MAX,
  chunkTextOf,
  clearAmbientState,
  codebuddyMetaOf,
  hasPendingBackgroundWork,
  isRetiredAmbientId,
  permissionToolName,
  reviveAmbientId,
} from './turn-stream.ts'
import type { LiveSession } from './turn-stream.ts'
import { permissionAskReason, snapshot } from './shape.ts'
import { toAcpMcpServers } from './mcp.ts'
import { DEFAULT_TUNING } from './tuning.ts'

const STDERR_TAIL_LINES = 40
/** Single fs/read_text_file answer cap — agents reading huge files must page via `line`/`limit`. */
const FS_MAX_READ_BYTES = 2 * 1024 * 1024
/** Single fs/write_text_file payload cap. */
const FS_MAX_WRITE_BYTES = 2 * 1024 * 1024

/**
 * How long a stop waits for the agent to answer `session/close` before killing
 * the child anyway. The capability is optional and the LOCAL teardown is what
 * actually frees the session, so a wedged agent must not be able to hang a
 * stop — and with it the stall reclaim that calls it — forever.
 */
const SESSION_CLOSE_TIMEOUT_MS = 5_000

/**
 * Fire-and-forget kill: the whole disposal budget for the non-teardown paths
 * (see `KILL_ESCALATION_GRACE_MS` for how it splits). Same 3s the old inline
 * SIGKILL timer used before escalating.
 */
const KILL_ESCALATION_DELAY_MS = 3_000

/**
 * Budget for disposing a child whose start was invalidated by a teardown (see
 * `AgentBridge.spawnAndConnect`). Short: that child was spawned moments ago and
 * never served anything, so there is nothing to drain.
 */
const STALE_START_KILL_BUDGET_MS = 2_000

/**
 * How long `BridgeManager.testAgent` waits for a failed start's child to report
 * its `exit` before writing the verdict (see `AgentBridge.awaitStartChildExit`).
 * A process that is already gone reports in microseconds; this only bounds the
 * pathological case, and it delays a user-visible answer, so it stays small.
 */
export const TEST_EXIT_GRACE_MS = 250

/**
 * The WHOLE host-shutdown budget for killing children, shared by every bridge
 * (bridges run concurrently, so this is the worst case for all of them, not
 * per bridge). One number, one deadline: `AgentBridge.shutdown` hands what is
 * LEFT of it to `killChildAndWait`, and `disposeChild` reserves the escalation
 * grace inside that — so the graceful wait gets at most 4s − 500ms and the
 * whole disposal, escalation included, never exceeds 4s.
 */
export const SHUTDOWN_BUDGET_MS = 4_000

export class AgentBridge {
  state: BridgeState = 'stopped'
  initResult?: InitializeResponse
  lastError?: string
  stderrTail: string[] = []
  /** Facts about the LAST start attempt — see {@link StartAttempt}. */
  startAttempt?: StartAttempt
  /**
   * The child the current start attempt spawned.
   *
   * Held separately from {@link child} because `killChild` clears THAT one the
   * moment a start fails, and the exit facts of the child are exactly what a
   * failed connection test has to report (see `awaitStartChildExit`).
   */
  private startChild?: ChildProcess

  private child?: ChildProcess
  private conn?: ClientConnection
  /**
   * Teardown generation, bumped ONLY by a deliberate teardown (`stop` /
   * `shutdown` / `forceReset`), so a start that was already in flight can tell
   * that nobody owns its outcome any more: `spawnAndConnect` re-checks this
   * after each await and disposes the child it would otherwise have published
   * as `ready`. Without it, a teardown landing during `ensureAgentExecutable`
   * (a global npm install can take minutes) left a freshly spawned agent
   * running with no owner.
   *
   * `releaseAll` and `killChild` deliberately do NOT bump it: both are also the
   * failure path of a start's own handshake — a child dying during startup goes
   * `exit` → `connectionLost` → `releaseAll('died')` — and that start must
   * still publish `error` with its stderr tail rather than be mistaken for a
   * teardown (see `ensureReady`). It cannot leak a process either way: a crash
   * release only happens once the child exists, and `spawnAndConnect` has no
   * spawn point left after that.
   */
  private teardownEpoch = 0
  private starting?: Promise<void>
  private readonly sessions = new Map<string, LiveSession>()
  private readonly acpIndex = new Map<string, LiveSession>()
  /** Sessions whose process died but whose ACP id can be resumed via `session/load`. */
  private readonly released = new Map<string, LiveSession>()
  /** Inflight `session/load` resumes, shared so concurrent prompts don't double-resume. */
  private readonly resuming = new Map<string, Promise<LiveSession>>()
  readonly permissions = new PermissionLedger()
  private readonly startupTimeoutMs: number
  /**
   * The ONE approval deadline, and the mode it settles with. Neither is
   * readonly, unlike their neighbors: the settings page rewrites them on a
   * running bridge ({@link AgentBridge.applyApprovalDeadlines}), so a user
   * editing the card does not have to kill every live session to see it take
   * effect. Both are read per ask, so a reassignment reaches every ask from
   * that moment on. An ask already holding an armed timer keeps the window it
   * was started with.
   */
  private permissionTimeoutMs: number
  private permissionTimeoutMode: PermissionTimeoutMode
  private readonly cancelFallbackMs: number
  private readonly staleCancelRetryDelayMs: number
  private readonly staleCancelMaxRetries: number
  private readonly turnSettleMs: number
  /** How long a background drain's record still counts as live work for the idle clock. */
  private readonly ambientStaleMs: number
  /** How long an unfinished dispatch may stay silent and still count as live work. */
  private readonly backgroundDispatchSilenceMs: number
  /** How long an OPEN worker tool call may stay open before it is presumed wedged. */
  private readonly backgroundOpenToolCeilingMs: number
  private defaultIdleTimeoutMs: number
  private readonly probeIdleTimeoutMs: number
  /** Armed while READY; fires the idle-release check. */
  private idleTimer?: ReturnType<typeof setTimeout>
  /** Last observable activity; the idle window is measured from here. */
  private lastActivityAt = 0
  /** Throwaway catalog probes in flight — they hold no live session of their own. */
  private pendingProbes = 0
  /**
   * `session/prompt` requests still awaiting the agent's answer, keyed by the
   * session that owns them. A rollback can close the session the moment the
   * user aborts, which removes it from `sessions` — but the request is still on
   * air, and killing the child now would turn a user's STOP into a
   * connection-dropped ERROR. This map is the ownership proof `hasActiveWork`
   * needs once the session is gone — and the KEY is what lets the idle clock
   * tell a closed-and-abandoned request apart from a live one (see
   * `pendingPromptsOnServableSessions`).
   */
  private pendingPrompts = new Map<string, number>()
  /**
   * Host→agent session commands in flight (mode / config); not turns. Counted
   * PER SESSION: a command the wedged agent never answers must not pin the
   * bridge against reclaiming THAT session (it is exactly the state the
   * watchdog is recovering from), while another session's command still does.
   */
  private readonly pendingCommands = new Map<string, number>()
  /**
   * `session/new` requests in flight. The session does not exist in `sessions`
   * yet, so nothing else would tell a teardown (`releaseAll` / idle release)
   * that a caller is waiting on the child it is about to kill.
   */
  private pendingCreates = 0
  /**
   * `session/fork` requests in flight (the adopt path of a branched
   * conversation). Same teardown hazard as {@link pendingCreates}: until the
   * forked session is registered, nothing else would stop an idle release
   * from killing the child out from under the caller.
   */
  private pendingForks = 0
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
     * Resolved per turn: the host entry may wire the workspace reader after
     * this bridge was built.
     */
    private readonly sessionWorkspace?: () => SessionWorkspaceResolver | undefined,
    /**
     * Told whenever the SESSION RECORDS change shape (a release parks them, a
     * resume revives them): the manager persists `chatSessions` through it, so
     * a parked conversation stays resumable across a host restart (see
     * `BridgeManager.loadPersistedChatSessions`).
     */
    private readonly onSessionsDirty?: () => void,
    /**
     * Told whenever a fresh `initialize` reports the agent's
     * `sessionCapabilities.fork` bit — the LAST KNOWN fork capability the
     * manager persists and serves to the browser (the bridge's own
     * `initResult` dies with the process; the manager's copy survives it).
     */
    private readonly onForkCapability?: (agentId: string, supported: boolean) => void,
    /**
     * When present, a status transition is broadcast by the MANAGER from the
     * AGGREGATE of every process serving the agent (A1 has several) instead of
     * this child speaking for all of them. Absent on every legacy construction
     * point, which keeps their frame byte-for-byte as it was.
     */
    private readonly onStatus?: (bridge: AgentBridge) => void,
    /**
     * Every `session/update` of a live session, BEFORE the transcript cursor
     * guard: the manager's session-level bookkeeping for detached workers and
     * background drains. It must see frames no turn controller observes any
     * more (a worker reporting after the turn that dispatched it closed).
     */
    private readonly onSessionBackgroundUpdate?: (session: LiveSession, update: SessionUpdate) => void,
    /**
     * Every `session/update` of a live session — AFTER the session-level drain
     * record was refreshed. The manager collects an IDLE drain's prose here so
     * it can wake the chat with it (see `LiveSession.backgroundReport`). Kept
     * separate from {@link onSessionBackgroundUpdate} on purpose: that one runs
     * BEFORE the drain record exists, and this one needs THIS frame's record.
     */
    private readonly onSessionDrainText?: (session: LiveSession, update: SessionUpdate) => void,
    /**
     * Terminalize every unfinished detached-worker record when a SESSION goes
     * away (close / release / force reset / process death). A closed TURN is
     * deliberately not one of these: its worker may still be running.
     */
    private readonly onSessionBackgroundTeardown?: (session: LiveSession, status: 'cancelled' | 'unknown') => void,
  ) {
    const merged = { ...DEFAULT_TUNING, ...tuning }
    this.startupTimeoutMs = merged.startupTimeoutMs
    this.permissionTimeoutMode = merged.permissionTimeoutMode
    // 不等待 (0) is the `auto` mode's business; under `abort` it would refuse
    // every ask on arrival, so the window is floored to the shortest real wait.
    this.permissionTimeoutMs = normalizeApprovalWindow(this.permissionTimeoutMode, merged.permissionTimeoutMs)
    this.cancelFallbackMs = merged.cancelFallbackMs
    this.staleCancelRetryDelayMs = merged.staleCancelRetryDelayMs
    this.staleCancelMaxRetries = merged.staleCancelMaxRetries
    this.turnSettleMs = merged.turnSettleMs
    this.ambientStaleMs = merged.ambientStaleMs
    this.backgroundDispatchSilenceMs = merged.backgroundTaskToolMs > 0
      ? merged.backgroundTaskToolMs
      : merged.backgroundTaskMaxMs
    this.backgroundOpenToolCeilingMs = merged.backgroundOpenToolCeilingMs
    this.defaultIdleTimeoutMs = merged.idleTimeoutMs
    this.probeIdleTimeoutMs = merged.probeIdleTimeoutMs
  }

  /**
   * Adopt a rewritten approval deadline or mode (the settings page's write).
   * Only the window and the mode live here; every other tuning value is
   * fixed at construction, because a live bridge cannot meaningfully adopt a
   * new startup or cancel window mid-flight.
   *
   * Deliberately does NOT re-arm anything: an ask that already holds a timer
   * keeps the window it was started with, and the next ask reads the new value.
   * Re-arming would move the goalposts under a human who is already deciding.
   */
  applyApprovalDeadlines(patch: { permissionTimeoutMs?: number; mode?: PermissionTimeoutMode }): void {
    if (patch.permissionTimeoutMs !== undefined) this.permissionTimeoutMs = patch.permissionTimeoutMs
    if (patch.mode !== undefined) this.permissionTimeoutMode = patch.mode
    // A mode switch can leave a window behind that the new mode cannot run
    // (不等待 under `abort`): floor it, so the ask waits instead of refusing
    // on arrival.
    this.permissionTimeoutMs = normalizeApprovalWindow(this.permissionTimeoutMode, this.permissionTimeoutMs)
  }

  /**
   * Adopt a rewritten host-default idle window (the settings page's write).
   *
   * Only the DEFAULT moves: an agent that names its own `idleTimeoutMs` keeps
   * it (that promise is about the agent, not about the deployment), and a
   * probe-only child keeps the short probe window.
   *
   * The timer is re-armed so the new window governs from NOW: an already
   * armed timer still holds the old window, so a shortened window would not
   * take effect until the old one elapsed.
   */
  applyIdleRelease(defaultIdleTimeoutMs: number): void {
    if (this.defaultIdleTimeoutMs === defaultIdleTimeoutMs) return
    this.defaultIdleTimeoutMs = defaultIdleTimeoutMs
    this.clearIdleTimer()
    this.touch()
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
    this.releaseAll(`agent "${this.def.id}" was released after ${String(Math.round(this.currentIdleTimeoutMs / 1000))}s idle`, 'idle')
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
   * The gate is {@link LiveSession.promptInFlight} + the settle promise, NOT
   * {@link LiveSession.running}: an ambient turn keeps `running` true for the
   * whole drain while its prompt slot is already free, so `running` would
   * refuse every message the user sends during a background task.
   *
   * @param session - the session asking for the slot.
   * @returns whether the slot was claimed, and why not when it was not.
   */
  async claimTurn(session: LiveSession): Promise<{ ok: true } | { ok: false; reason: 'busy' | 'unsettled' }> {
    if (this.promptSlotHeld(session)) return { ok: false, reason: 'busy' }
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
    // Re-checked after the wait: another turn may have claimed the slot while
    // this one was waiting on the gate.
    if (this.promptSlotHeld(session)) return { ok: false, reason: 'busy' }
    return { ok: true }
  }

  /** Whether a turn currently holds the agent prompt slot (see `promptInFlight`). */
  private promptSlotHeld(session: LiveSession): boolean {
    return session.promptInFlight === true
  }

  /**
   * Mark the agent-side turn as in flight — claim the agent prompt slot and
   * open the settle gate — and hand back the settler its stream owner must
   * call once the agent is actually done with it.
   *
   * @param session - the session whose turn is starting.
   * @returns the settler (idempotent; also used by connection loss).
   */
  beginTurn(session: LiveSession): () => void {
    let settle: () => void = () => { /* replaced below */ }
    const settled = new Promise<void>(resolve => { settle = resolve })
    session.settled = settled
    session.settledResolve = settle
    session.promptInFlight = true
    this.touch()
    return () => {
      // Identity-guarded: only THIS turn's settler may release the slot. A
      // superseded turn's late settler must not clear the flag a NEWER turn
      // has already claimed (its settle gate was replaced with a new promise).
      if (session.settled === settled) {
        session.settled = undefined
        session.settledResolve = undefined
        session.promptInFlight = false
      }
      settle()
      // The turn is over: a fresh window starts here rather than at the prompt
      // that may have started a long time ago.
      this.touch()
    }
  }

  /**
   * Open a session's settle gate without owning its turn stream: the turn's
   * stream is gone (a resume, a release) but the next prompt still waits on
   * this promise, and nothing is left that could ever resolve it. The prompt
   * slot itself goes with it: whatever held it is gone too.
   */
  private openSettleGate(session: LiveSession): void {
    const settle = session.settledResolve
    session.settled = undefined
    session.settledResolve = undefined
    session.promptInFlight = false
    settle?.()
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
   * The last startup / connection error. The manager folds it into the
   * aggregated status frame (see `BridgeManager.publishAgentStatus`); the
   * bridge itself only puts it on its own frame when it has no manager.
   */
  get errorText(): string | undefined {
    return this.lastError
  }

  /**
   * Work a teardown would interrupt: a turn in flight (or one the agent is
   * still settling after an abort), a permission ask waiting for an answer, a
   * probe, a resume, or a start. A registered-but-idle session is NOT work.
   */
  private hasActiveWork(includeClosedPrompts = true): boolean {
    const pendingPrompts = includeClosedPrompts
      ? this.pendingPrompts.size
      : this.pendingPromptsOnServableSessions()
    if (this.pendingProbes > 0
      || pendingPrompts > 0
      || this.pendingCreates > 0
      || this.pendingForks > 0
      || this.pendingCommands.size > 0
      || this.resuming.size > 0
      || this.permissions.sessionIds().length > 0
      || this.starting !== undefined) return true
    for (const session of this.sessions.values()) {
      if (session.running || session.settled !== undefined) return true
      if (hasPendingBackgroundWork(session, this.ambientStaleMs, this.backgroundDispatchSilenceMs, this.backgroundOpenToolCeilingMs)) return true
    }
    return false
  }

  /**
   * Outstanding prompts that belong to a session this bridge can still serve
   * (live or parked). A request left behind by a CLOSED session is the abort /
   * rollback case: it must keep the child alive until it settles, so `prune` and
   * workspace moves use the strict count. But an agent that NEVER answers must
   * not pin the process forever — constraint 19's idle clock needs an end point,
   * and the agent will not give one. The idle release therefore ignores
   * closed-session requests only.
   */
  private pendingPromptsOnServableSessions(): number {
    let total = 0
    for (const [sessionId, count] of this.pendingPrompts) {
      if (this.sessions.has(sessionId) || this.released.has(sessionId)) total += count
    }
    return total
  }

  /**
   * Active work on this bridge EXCEPT `session`'s own — what a restart-carrying
   * reclaim (the stall watchdog's follow-up) would destroy. Killing this child
   * restarts every ACP session on the connection, so a live conversation that
   * is mid-turn, mid-resume, or waiting on a human pins the process: its
   * context is the one thing a restart cannot give back.
   *
   * `session`'s OWN mode/config command is deliberately not counted: an agent
   * that ignores `session/set_mode` would otherwise make its own stall
   * unrecoverable — the command's counter is exactly the evidence of the wedge.
   */
  hasOtherActiveWork(session: LiveSession): boolean {
    if (this.pendingProbes > 0
      || this.pendingCreates > 0
      || this.pendingForks > 0
      || this.resuming.size > 0
      || this.starting !== undefined) return true
    for (const sessionId of this.pendingCommands.keys()) {
      if (sessionId !== session.sessionId) return true
    }
    if (this.permissions.sessionIds().some(entry => entry.sessionId !== session.sessionId)) return true
    for (const other of this.sessions.values()) {
      if (other === session) continue
      if (other.running || other.settled !== undefined) return true
      if (hasPendingBackgroundWork(other, this.ambientStaleMs, this.backgroundDispatchSilenceMs, this.backgroundOpenToolCeilingMs)) return true
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
   * Nothing is left here that a later turn could resume: no live session, no
   * parked record, no work. A per-session holder (A1) is then safe to drop; an
   * agent-wide holder is never dropped because it IS the agent's process slot.
   */
  isDiscardable(): boolean {
    return this.isQuiet() && this.released.size === 0
  }

  /**
   * A turn is in flight (or the agent has not settled its response yet) on any
   * of this bridge's sessions. `settled` only stays non-undefined while the
   * agent's answer is outstanding — the settler clears it on completion — so
   * this is real work, not an idle session.
   */
  hasActiveTurn(): boolean {
    for (const session of this.sessions.values()) {
      if (session.running || session.settled !== undefined) return true
    }
    return false
  }

  /**
   * An idle teardown is safe when nothing is WORKING. Idle live sessions do not
   * block it: `releaseAll` parks them as `released` (never closed), and the next
   * prompt brings them back with `session/load`. The exception is an agent that
   * does not advertise `loadSession`: releasing would lose a conversation it
   * cannot reload, so there the old session-less rule stands.
   */
  private canIdleRelease(): boolean {
    if (this.hasActiveWork(false)) return false
    return this.sessions.size === 0 || this.initResult?.agentCapabilities?.loadSession === true
  }

  /** Whether the agent advertises `session/load`, i.e. a parked session can come back. */
  supportsSessionLoad(): boolean {
    return this.initResult?.agentCapabilities?.loadSession === true
  }

  /**
   * Archive release is the same park as an idle release, but it may fire while
   * the conversation is quiet even if OTHER conversations on this process are
   * live. It never fires while any work is outstanding, and never for an agent
   * that cannot reload a parked session.
   */
  canReleaseForArchive(): boolean {
    return this.state === 'ready' && this.supportsSessionLoad() && !this.hasActiveWork(false)
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
        this.releaseAll(reason, 'workspace')
      }
    }
    if (this.state === 'ready' && this.conn !== undefined) return Promise.resolve()
    if (this.starting !== undefined) return this.starting
    const epoch = this.teardownEpoch
    this.state = 'starting'
    this.publishStatus()
    const started = this.spawnAndConnect(epoch)
      .then(() => {
        // A teardown landed while the handshake was in flight: it owns the
        // bridge now, and `spawnAndConnect` has already disposed whatever it
        // spawned. Publishing `ready` here would paint a live status back over
        // the stopped bridge. `state` catches the one teardown that does NOT
        // bump the epoch — a crash release (`releaseAll`): without it, a
        // handshake that resolved just as the child died would paint `ready`
        // over the `stopped` that the crash left behind.
        if (this.teardownEpoch !== epoch || this.state !== 'starting') return
        this.state = 'ready'
        this.lastError = undefined
        this.publishStatus()
        // Start the idle clock only from a READY process: `starting` may take
        // the whole startup budget and must not race the release.
        this.touch()
      })
      .catch((error: unknown) => {
        // Same guard: a start nobody owns any more must not publish its
        // outcome. A start's OWN failure — `withStartupTimeout`, or the child
        // dying mid-handshake (which runs through `releaseAll`) — still reaches
        // the lines below and publishes `error` with its stderr tail; neither
        // of those paths bumps the epoch.
        if (this.teardownEpoch !== epoch) {
          // Publish nothing, but keep the caller's error contract: every
          // interrupted start has always surfaced as `agent_unreachable`.
          throw new AcpError('agent_unreachable', `acp: agent "${this.def.id}" failed to start: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.state = 'error'
        this.lastError = error instanceof Error ? error.message : String(error)
        this.clearIdleTimer()
        this.killChild()
        this.publishStatus()
        throw new AcpError('agent_unreachable', `acp: agent "${this.def.id}" failed to start: ${this.lastError}`)
      })
      .finally(() => {
        // Only clear a slot that is still OURS: a teardown may have cleared it
        // (and a fresh `ensureReady` may already hold it).
        if (this.starting === started) this.starting = undefined
      })
    this.starting = started
    return started
  }

  /**
   * @param epoch - `teardownEpoch` captured when this start claimed the bridge.
   *   Every await below is a window in which a teardown can land; a stale start
   *   owns nothing and must leave no process behind (see `teardownEpoch`).
   */
  private async spawnAndConnect(epoch: number): Promise<void> {
    this.stderrTail = []
    // The attempt record starts here and is filled in as the start progresses;
    // a failure reads it back to name the cause (see `StartAttempt`).
    const attempt: StartAttempt = {
      command: this.def.command,
      // Flipped by the install step itself, not by the definition: see
      // `StartAttempt.installTried`.
      installTried: false,
      spawned: false,
      timedOut: false,
    }
    this.startAttempt = attempt
    // Resolve (and, with npmPackage, auto-install) the executable before the
    // spawn; the resolved absolute path also pins the lookup to the host PATH
    // plus the well-known extra dirs, not the child env the agent may override.
    const { command } = await ensureAgentExecutable(
      this.def,
      undefined,
      line => this.noteStderr(line),
      () => { attempt.installTried = true },
    )
    // Re-resolved (not taken from the answer above) because the install may have
    // JUST made the program resolvable: this is exactly the question "did the
    // host find a program to launch", which is what tells "not installed"
    // apart from "the launch command is wrong".
    attempt.executablePath = findExecutable(this.def.command)
    // A teardown landed while the executable was being resolved — a global
    // install can hold this await for minutes. Nothing has been spawned yet, so
    // there is nothing to reap; just refuse to create the process.
    if (this.teardownEpoch !== epoch) return
    const cwd = safeSpawnCwd(this.def, this.wantedSpawnCwd)
    this.spawnCwd = cwd
    const launch = windowsShimLaunch(command, perSessionLaunchArgs(this.def.args ?? [], this.def.id))
    let child: ChildProcess
    try {
      child = spawn(launch.command, launch.args, {
        cwd,
        env: perSessionLaunchEnv(childEnv(process.env, this.def.env ?? {}), this.def.id),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
        // A console child of a GUI host (the desktop app) would otherwise pop a
        // console window on every spawn.
        windowsHide: true,
        ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (error) {
      // `spawn` rejects an unusable option set SYNCHRONOUSLY (an invalid `env`
      // value, a bad option type). Record that like the async `error` event
      // below, or the verdict would blame the install / PATH for a launch the
      // host refused to attempt at all.
      attempt.spawnError = {
        code: (error as NodeJS.ErrnoException).code,
        message: error instanceof Error ? error.message : String(error),
      }
      throw error
    }
    this.child = child
    this.startChild = child
    attempt.spawned = true
    trackAgentChild(child)
    child.on('error', (error) => {
      // The FACT is recorded before the identity guard: this attempt's own
      // record is not shared with a replacement child, and a start that was
      // already torn down still has to report WHY it failed. Only the teardown
      // below needs the guard — a stale event must not kill a fresh process.
      attempt.spawnError = { code: (error as NodeJS.ErrnoException).code, message: error.message }
      // Identity guard: a stale event from a PREVIOUS child must not tear down
      // a connection that replaced it (an `exit` can land after the respawn
      // already started and would otherwise kill the fresh process).
      if (this.child !== child) return
      this.noteStderr(`spawn error: ${error.message}`)
      if (this.state !== 'stopped') this.onConnectionLost(this, `spawn error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      // Before the guard, for the same reason as the spawn error above: a child
      // that dies during the handshake closes its stdio FIRST, so the pending
      // `initialize` is already rejected (and `killChild` has already cleared
      // `this.child`) by the time this lands — the guard would swallow the one
      // fact that names a wrong launch command.
      attempt.exit = { code, signal }
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
        clientInfo: { name: 'dsh-ntr', title: 'DSH NTR', version: PLUGIN_VERSION },
      }),
      'initialize',
      attempt,
    )
    // The second — and widest — window: `initialize` waits up to the startup
    // budget, and a shutdown / stop during it already dropped the connection and
    // killed the child we spawned. That child is OURS even though the bridge no
    // longer points at it, so dispose it with the awaitable kill instead of
    // leaving a process nobody can reach.
    if (this.teardownEpoch !== epoch) {
      // Only when it is still the CURRENT connection: a newer one belongs to a
      // fresh start and must not be closed from here.
      if (this.conn === conn) {
        this.conn = undefined
        conn.close()
      }
      if (this.child === child) {
        this.child = undefined
        this.spawnCwd = undefined
      }
      await disposeChild(child, STALE_START_KILL_BUDGET_MS)
      return
    }
    this.initResult = init
    // The fork capability is agent knowledge that must outlive the process:
    // report it so the manager can persist a LAST KNOWN copy and serve the
    // browser's branch button after a release (`initResult` itself dies here).
    this.onForkCapability?.(this.def.id, this.initResult?.agentCapabilities?.sessionCapabilities?.fork != null)
  }

  /**
   * Bound one agent-startup request (`initialize`, `session/new`,
   * `session/load`). The SDK's `cancellationSignal` is cooperative — a wedged
   * agent never answers `$/cancel_request` either — so the only real timeout
   * is a race, and the losing call tears the child down: a process that stops
   * answering protocol requests is dead for every session it owns.
   */
  private withStartupTimeout<T>(request: Promise<T>, what: string, attempt?: StartAttempt): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Marks THE attempt this start owns, not whatever `this.startAttempt`
        // points at when the timer fires: a late timer from an older start must
        // not make a fresh attempt read as timed out.
        if (attempt !== undefined) attempt.timedOut = true
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

  /**
   * Wait — briefly — for the current start's child to report its `exit`, so a
   * failure verdict can name the code the process died with.
   *
   * WHY a bounded WAIT instead of a read: a child that dies during the ACP
   * handshake closes its stdio FIRST. The SDK therefore rejects the pending
   * `initialize` (reporting "ACP connection closed") before Node delivers
   * `exit`, and the start's own teardown clears the child in that same window.
   * Reading the record at the rejection would miss the exit code — the single
   * most useful fact about a launch command that is wrong.
   *
   * Never rejects, and never outlasts its budget: a process that is gone
   * reports promptly, and a wedged one must not delay the verdict.
   */
  async awaitStartChildExit(budgetMs: number): Promise<void> {
    // Only a start that actually reached `spawn` has a child whose exit is
    // worth waiting for; a start that died while resolving (a failed install)
    // must not sit on the previous child for the whole grace window.
    if (this.startAttempt?.spawned !== true) return
    const child = this.startChild
    if (child === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return
    await waitForChildExit(child, budgetMs)
  }

  private noteStderr(line: string): void {
    if (line === '') return
    // Stderr is what a misbehaving agent says about itself: keep the whole line
    // (a stack trace or an activation error is exactly the line that gets cut).
    this.stderrTail.push(line)
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES)
  }

  private publishStatus(): void {
    // A1: one child's transition must not speak for the whole agent — hand it
    // to the manager, which folds every child into one frame. With a single
    // child that frame is the identical one this method used to send.
    if (this.onStatus !== undefined) {
      this.onStatus(this)
      return
    }
    this.hub.broadcast({ type: 'agent/status', agentId: this.def.id, state: this.state, ...(this.lastError === undefined ? {} : { error: this.lastError }), agent: this.view() })
  }

  /**
   * @param cwd - the ACP session's cwd (validated against the agent's roots).
   * @param extraRoots - roots trusted for THIS session only (a chat session's
   *   DSH workspace; see `resolveSessionCwd`).
   * @param spawnCwd - where the agent PROCESS should run; see `ensureReady`.
   */
  async createSession(cwd: string | undefined, extraRoots: readonly string[] = [], spawnCwd?: string): Promise<LiveSession> {
    // Readiness (and its possible restart into `spawnCwd`, see `ensureReady`)
    // comes FIRST: `isQuiet` must not count THIS call's in-flight `session/new`
    // against that move, or a fresh conversation could never bring a quiet
    // process into its workspace. The counter is bumped in the same microtask
    // that resumes here, so no idle-release timer can slip into the gap.
    await this.ensureReady(spawnCwd)
    // Counted while the request is in flight: until `sessions.set` runs, the
    // session is invisible to every teardown predicate, and a release that
    // killed the child here would strand this promise on a dead connection.
    this.pendingCreates += 1
    try {
      return await this.openSession(cwd, extraRoots)
    } finally {
      this.pendingCreates -= 1
      this.touch()
    }
  }

  /** The body of {@link createSession}; the caller keeps `pendingCreates` for it. */
  private async openSession(cwd: string | undefined, extraRoots: readonly string[]): Promise<LiveSession> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    const resolved = resolveSessionCwd(this.def, cwd, p => realpathSync(p), extraRoots)
    const result = await this.withStartupTimeout(
      conn.agent.request(methods.agent.session.new, { cwd: resolved, mcpServers: toAcpMcpServers(this.def.mcpServers) }),
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
      lastAgentActivityAt: Date.now(),
      activeToolCalls: new Set(),
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
   *
   * THE PROBE SENDS THE AGENT'S OWN MCP LIST, not an empty one. Measured
   * against codebuddy: the servers handed to `session/new` land in the
   * agent PROCESS's dynamic MCP scope, so a probe that sent an empty list
   * would REPLACE that scope and drop the MCP servers of the live sessions
   * on the same connection (the agent logged
   * `serverManager.delete("injected")` and the live session's
   * `mcp__injected__*` tools disappeared). One list per agent process is the
   * only shape that keeps every session of that process consistent.
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
        conn.agent.request(methods.agent.session.new, { cwd: resolved, mcpServers: toAcpMcpServers(this.def.mcpServers) }),
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
   * Fork one live session through the agent's own `session/fork` (the
   * UNSTABLE fourth session-creation point): the agent copies its internal
   * state into a NEW ACP session that remembers the parent's context — the
   * second half of a branched conversation, after the host's `sessions.fork`
   * has already built the DSH session tree. The child is addressed by the
   * CHILD DSH conversation id, so its first message reaches an agent that
   * actually remembers the parent.
   *
   * The parent must be live on this connection — a released parent has no
   * process to fork from (the browser blocks that click; this is the hard
   * stop behind it). The ACP request carries the SAME `mcpServers` list as
   * `session/new` / `session/load` (one list per process; an empty list would
   * evict the live sessions' MCP scope) and is bounded by the startup timeout
   * like every session-creation step. Counted in {@link pendingForks} while
   * in flight so an idle release cannot kill the child out from under the
   * caller.
   */
  async forkSession(parent: LiveSession, dshSessionId: string): Promise<LiveSession> {
    // A1 (F2): the fourth session-creation point is hard-disabled per agent;
    // a per-session child holds exactly the conversation it was spawned for.
    if (isPerSessionAgent(this.def.id)) {
      throw new AcpError('fork_unsupported', `acp: agent "${this.def.id}" runs one process per conversation and cannot fork`)
    }
    if (this.initResult?.agentCapabilities?.sessionCapabilities?.fork == null) {
      throw new AcpError('fork_unsupported', `acp: agent "${this.def.id}" does not advertise the session/fork capability`)
    }
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    // The child runs where the parent runs: its cwd is the parent's already
    // validated workspace, re-trusted as its own extra root (the same minimal
    // trust `resolveSessionCwd` applied when the parent was created — never
    // the agent's configured sandbox cwd, which is not where the conversation
    // lives).
    const resolved = resolveSessionCwd(this.def, parent.cwd, p => realpathSync(p), [parent.cwd])
    this.pendingForks += 1
    try {
      const result = await this.withStartupTimeout(
        conn.agent.request(methods.agent.session.fork, {
          sessionId: parent.acpSessionId,
          cwd: resolved,
          mcpServers: toAcpMcpServers(this.def.mcpServers),
        }),
        'session/fork',
      )
      // A fork answer that names the parent (or any session already routed on
      // this connection) would interleave the parent's updates, asks and
      // permission cards into the child — refuse it rather than register it.
      if (typeof result.sessionId !== 'string' || result.sessionId === '') {
        throw new AcpError('fork_failed', 'acp: session/fork returned no session id')
      }
      if (result.sessionId === parent.acpSessionId || this.acpIndex.has(result.sessionId)) {
        throw new AcpError('fork_id_conflict', 'acp: session/fork returned an id that already exists on this connection')
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
        lastAgentActivityAt: Date.now(),
        activeToolCalls: new Set(),
        transcript: new Transcript(this.transcriptMax),
        dshSessionId,
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
      // The fork answer's config options are the AGENT-LEVEL surface too (the
      // same feed `session/new` provides): absorb them so the composer chips
      // of the fresh conversation render without a probe.
      if (this.onCatalog !== undefined && usableConfigOptions(result.configOptions)) {
        this.onCatalog(this.def.id, result.configOptions)
      }
      this.sessions.set(session.sessionId, session)
      this.acpIndex.set(session.acpSessionId, session)
      // Same flip as `createSession`: a registered session makes this a chat
      // process; re-arm the idle clock on the agent's own window.
      this.clearIdleTimer()
      this.everHostedSession = true
      this.hub.broadcast({ type: 'session/created', sessionId: session.sessionId, session: snapshot(session) })
      this.touch()
      return session
    } finally {
      this.pendingForks -= 1
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
   * returns as-is — checked BOTH before the delay and after it, so a second
   * stop click inside the retry window does not resend the prompt the user
   * just stopped.
   *
   * `turnGen` is the {@link LiveSession.turnSeq} this prompt was sent for. A
   * stale-cancel resend is only allowed while that generation still owns the
   * session: once a successor turn began (the cancel fallback finalized this
   * one and the user moved on), resending would race a second `session/prompt`
   * into the successor's turn. The late answer is returned as-is instead.
   *
   * The RESPONSE's `_meta` travels with the stop reason: it is the only place
   * an agent says whether the prompt actually queued a conversation turn (see
   * `CodebuddyMeta.conversationRequestId`), which decides whether an instant
   * answer was the turn ending or a fold into a background drain.
   */
  async runPrompt(session: LiveSession, prompt: string | ContentBlock[], turnId: string, turnGen: number): Promise<{ stopReason: string; meta?: Record<string, unknown> }> {
    const conn = this.conn
    if (conn === undefined || session.closed || session.released) throw new AcpError('session_closed', 'acp: session is closed')
    this.touch()

    const blocks: ContentBlock[] = typeof prompt === 'string'
      ? [{ type: 'text', text: prompt }]
      : prompt

    if (blocks.length === 0) {
      throw new AcpError('empty_prompt', 'acp: prompt cannot be empty')
    }

    const hasImages = blocks.some(b => b.type === 'image')
    if (hasImages && this.initResult?.agentCapabilities?.promptCapabilities?.image !== true) {
      throw new AcpError('image_unsupported', `acp: agent "${this.def.id}" does not support image input`)
    }

    for (let attempt = 0; ; attempt += 1) {
      const promptSessionId = session.sessionId
      this.pendingPrompts.set(promptSessionId, (this.pendingPrompts.get(promptSessionId) ?? 0) + 1)
      // The response is activity too: the idle window must start at the turn's
      // END, not at the prompt that may have started a long time ago.
      const result = await conn.agent.request(methods.agent.session.prompt, {
        sessionId: session.acpSessionId,
        prompt: blocks,
      }).finally(() => {
        // Decrement on the response OR the failure: a killed connection must
        // not leave this bridge permanently "busy" and unprunable.
        const remaining = (this.pendingPrompts.get(promptSessionId) ?? 1) - 1
        if (remaining > 0) this.pendingPrompts.set(promptSessionId, remaining)
        else this.pendingPrompts.delete(promptSessionId)
        this.touch()
      })
      const answered = () => ({
        stopReason: result.stopReason,
        ...(result._meta !== undefined && result._meta !== null ? { meta: result._meta } : {}),
      })
      if (result.stopReason !== 'cancelled' || session.cancelRequestedAtTurn === session.turnSeq) {
        return answered()
      }
      // The turn this answer belongs to no longer owns the session (a cancel
      // fallback finalized it and a successor began): resending would fire a
      // second `session/prompt` into the successor's turn.
      if (session.turnSeq !== turnGen) return answered()
      if (attempt >= this.staleCancelMaxRetries) return answered()
      await new Promise(resolve => setTimeout(resolve, this.staleCancelRetryDelayMs))
      if (session.closed || this.conn !== conn) throw new AcpError('session_closed', 'acp: session is closed')
      // Re-check after the delay: the successor may have started while waiting.
      if (session.turnSeq !== turnGen) return answered()
      // ...and a SECOND stop during the delay names this same generation. The
      // user already said stop, so the stale-cancel answer is not a swallow to
      // out-wait anymore: resending would make the agent run the prompt the
      // user just stopped (the double-click case). Return as-is.
      if (session.cancelRequestedAtTurn === session.turnSeq) return answered()
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
      this.finalizeTurn(
        session,
        turnGen,
        `agent "${this.def.id}" did not respond to the cancel request within ${String(Math.round(this.cancelFallbackMs / 1000))}s; the turn was force-finalized`,
      )
    }, this.cancelFallbackMs)
    timer.unref?.()
  }

  /**
   * Force the local end of one turn whose agent never acknowledged it: clear
   * `running`, open the settle gate, and end the turn. Shared by the cancel
   * fallback and the stall watchdog.
   *
   * A live controller owns the turn's streaming face — its segment queue, its
   * ambient clocks and its `turn/end` id. Ending the turn behind its back
   * would leave the driver step parked on an open queue, and the controller's
   * own timers would later broadcast a SECOND `turn/end` for a turn already
   * closed. So when the session still points at a current controller, the
   * force goes THROUGH it (`forceFinalize`), which runs the same closing work
   * as a normal settle exactly once. Only a turn with no live controller (an
   * `/acp`-RPC turn, or one already retired) falls back to the local broadcast
   * with `turnId: ''` — there is no stream whose id could be named.
   *
   * Generation-guarded: a turn that already ended — or that a later turn
   * superseded — is not this call's to finalize. Returns whether it acted; a
   * `false` means the caller was late and must leave the session alone.
   */
  finalizeTurn(session: LiveSession, turnGen: number, message: string): boolean {
    if (session.closed || session.turnSeq !== turnGen) return false
    const controller = session.turnController
    if (controller !== undefined && !controller.stale) {
      controller.forceFinalize({ kind: 'error', message })
      return true
    }
    // Nothing is in flight anymore (the turn settled on its own): nothing to
    // finalize. A still-pending settle gate counts as in flight even though
    // the stream is gone — that gate is what the next prompt waits on.
    if (!session.running && session.settled === undefined) return false
    session.running = false
    this.openSettleGate(session)
    this.hub.broadcast({
      type: 'turn/end',
      sessionId: session.sessionId,
      turnId: '',
      error: message,
    })
    return true
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
      // The CONNECTION first: a teardown that landed during the start leaves no
      // `initResult` either, and reporting that as `resume_unsupported` would
      // blame the agent for a capability it may well have. "The bridge is not
      // up" is the honest answer.
      const conn = this.conn
      if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
      // The capability comes from the FRESH initialize: after a crash the
      // bridge restarts the process, so check the (new) initResult here.
      if (this.initResult?.agentCapabilities?.loadSession !== true) {
        throw new AcpError('resume_unsupported', `acp: agent "${this.def.id}" does not advertise the loadSession capability; start a new session`)
      }
      const resolved = resolveSessionCwd(this.def, session.cwd, p => realpathSync(p), workspaceRoot === undefined ? [] : [workspaceRoot])
      // Replay arrives as brand-new updates, so the transcript restarts too;
      // seq keeps meaning "position in the current epoch". What the buffer held
      // is now the agent's to replay — remember that there IS history before
      // dropping it, or a failed resume parks an empty buffer back and the
      // view claims the conversation never happened.
      session.hasHistory = session.hasHistory === true || session.transcript.since(0).length > 0
      session.transcript = new Transcript(this.transcriptMax)
      session.cwd = resolved
      session.running = false
      session.closed = false
      session.released = false
      // A resume is a fresh agent-side state: nothing from the dead process's
      // turn survives it, including the settle gate and the stall markers. A
      // background drain belonged to that process too.
      session.orphanPromptTurnSeq = undefined
      session.reclaimedTurnSeq = undefined
      session.activeToolCalls.clear()
      clearAmbientState(session)
      session.lastAgentActivityAt = Date.now()
      this.openSettleGate(session)
      // Route replay updates into the fresh transcript while the load request
      // is in flight, and let the browser drop its blocks/watermark first.
      this.acpIndex.set(session.acpSessionId, session)
      this.hub.broadcast({ type: 'session/reset', sessionId: session.sessionId, session: snapshot(session) })
      // The whole replay lands before the response (ACP): flag the window so
      // replayed dispatches read as history, not new work. Cleared on failure
      // too — a parked session must not carry a stuck window into its retry.
      session.loadingHistory = true
      const result = await this.withStartupTimeout(
        conn.agent.request(methods.agent.session.load, { sessionId: session.acpSessionId, cwd: resolved, mcpServers: toAcpMcpServers(this.def.mcpServers) }),
        'session/load',
      ).finally(() => { session.loadingHistory = false })
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
      this.onSessionsDirty?.()
      return session
    } catch (error) {
      this.acpIndex.delete(session.acpSessionId)
      this.sessions.delete(session.sessionId)
      session.released = true
      this.released.set(session.sessionId, session)
      this.hub.broadcast({ type: 'session/released', sessionId: session.sessionId, session: snapshot(session), reason: 'resume failed', cause: 'resume-failed' })
      this.onSessionsDirty?.()
      throw error
    }
  }

  /**
   * Release all live sessions (process died or went idle): keep them resumable,
   * settle permissions, drop the connection.
   *
   * Deliberately does NOT bump `teardownEpoch`: a child's death during startup
   * runs through `connectionLost` into this method, and that start must still
   * publish `error` with its stderr tail — the settings card expands on exactly
   * that pair (see `view` / `teardownEpoch`).
   */
  releaseAll(reason: string, cause: AcpReleaseCause): void {
    this.clearIdleTimer()
    this.parkSessions(reason, cause)
    this.conn?.close()
    this.conn = undefined
    this.killChild()
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
  }

  /**
   * Park every live session as RELEASED — resumable through `session/load`,
   * never destroyed — and persist the records.
   *
   * This is the local half shared by `releaseAll` (crash / idle / workspace) and
   * `shutdown` (host exit): those paths differ only in what happens to the child
   * afterwards. A `closed` session is skipped — its record belongs to
   * `closeSession`, and flipping it to released would let a resume resurrect a
   * conversation that is being destroyed (constraint 10).
   *
   * Returns how many sessions were parked, so a shutdown with nothing to park
   * does not rewrite the state file (a second `shutdownAll` must not erase the
   * records the first one persisted).
   */
  private parkSessions(reason: string, cause: AcpReleaseCause): number {
    let parked = 0
    for (const session of [...this.sessions.values()]) {
      // A session already being closed is `closeSession`'s to delete. Marking
      // it released would park it as resumable, and `doResumeSession` flips
      // `closed` back to false — an idle release resurrecting a closed session.
      if (session.closed) continue
      // The process that owed the turn is gone, so no worker is still running:
      // every still-open dispatch becomes `unknown` before the turn/end below.
      this.onSessionBackgroundTeardown?.(session, 'unknown')
      if (session.running) {
        session.running = false
        this.hub.broadcast({ type: 'turn/end', sessionId: session.sessionId, turnId: '', error: reason })
      }
      // The process that owed the turn is gone: leaving its settle gate closed
      // would make the next prompt wait for an answer that can no longer come.
      this.openSettleGate(session)
      // No call from the dead process can still be running: drop the tool set
      // so a resumed turn starts on the plain window. A background drain died
      // with it, and a stale ambient would misclassify the NEXT prompt.
      session.activeToolCalls.clear()
      clearAmbientState(session)
      session.released = true
      this.settlePermissions(session)
      this.released.set(session.sessionId, session)
      this.hub.broadcast({ type: 'session/released', sessionId: session.sessionId, session: snapshot(session), reason, cause })
      parked += 1
    }
    this.sessions.clear()
    this.acpIndex.clear()
    // The parked records are what keeps them resumable after a host restart —
    // persist now, while their transcripts (the `hasHistory` evidence) are
    // still the ones they were parked with.
    if (parked > 0) this.onSessionsDirty?.()
    return parked
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

  /**
   * Register a session record restored from disk as already parked: a host
   * restart killed every process, so it comes back exactly as `releaseAll`
   * would have left it — resumable via `session/load`, never live.
   */
  parkReleased(session: LiveSession): void {
    this.released.set(session.sessionId, session)
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
  private async runCommand<T>(session: LiveSession, request: () => Promise<T>): Promise<T> {
    this.pendingCommands.set(session.sessionId, (this.pendingCommands.get(session.sessionId) ?? 0) + 1)
    this.touch()
    try {
      return await request()
    } finally {
      const remaining = (this.pendingCommands.get(session.sessionId) ?? 1) - 1
      if (remaining > 0) this.pendingCommands.set(session.sessionId, remaining)
      else this.pendingCommands.delete(session.sessionId)
      this.touch()
    }
  }

  async setMode(session: LiveSession, modeId: string): Promise<void> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    await this.runCommand(session, () => conn.agent.request(methods.agent.session.setMode, { sessionId: session.acpSessionId, modeId }))
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
    const result = await this.runCommand(session, () => conn.agent.request(methods.agent.session.setConfigOption, params)) as { configOptions?: unknown }
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
    // The session is going away: whatever background drain it announced ends
    // with it (a re-created session must not inherit a stale ambient).
    clearAmbientState(session)
    // ...and so does every still-open dispatch record of this session; a closed
    // session is not a cancelled worker.
    this.onSessionBackgroundTeardown?.(session, 'unknown')
    // ...and so does its prompt slot: nothing may keep rejecting a new prompt
    // for a record that is being deleted.
    session.promptInFlight = false
    // Closing a session is activity of its own: restart the idle window here
    // rather than at the prompt that opened it.
    this.touch()
    // Answer every outstanding ask BEFORE `session/close` is awaited: an agent
    // blocked on an unanswered `session/request_permission` would otherwise be
    // able to hold the close open indefinitely.
    this.settlePermissions(session)
    const conn = this.conn
    if (conn !== undefined && this.state === 'ready') {
      // `session/close` is an optional capability; the local teardown stands
      // regardless. Bound the wait: a wedged agent that ignores the request
      // must not hang the caller (the stall reclaim stops through here), so
      // the request is raced against a timeout and left behind if it loses.
      const close = conn.agent.request(methods.agent.session.close, { sessionId: session.acpSessionId }).catch(() => { /* unsupported */ })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          close,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, SESSION_CLOSE_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
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
    // Deliberate teardown: an in-flight start owns nothing any more, and must
    // not be able to publish `ready` over the stopped state that follows.
    this.teardownEpoch += 1
    // Drop the memoized start: a later `ensureReady` must not adopt a promise
    // whose result was already discarded. That promise's own `finally`
    // re-checks identity, so it cannot clear a NEWER start's slot.
    this.starting = undefined
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

  /**
   * Drop every live session record and kill the child WITHOUT asking the agent
   * to close them. `stop` sends `session/close` per session, and a wedged agent
   * that ignores it would hang the caller (the stall reclaim) — the very agent
   * this teardown exists to get rid of. The local teardown is what frees the
   * sessions, so it runs unconditionally and immediately.
   *
   * Deliberately does NOT clear `released`: those records are constraint 10's
   * — a released session survives a process death and is resumed by its next
   * message. This is a stop, not a discard.
   */
  forceReset(reason: 'agent-stopped'): void {
    this.teardownEpoch += 1
    this.starting = undefined
    this.clearIdleTimer()
    for (const session of [...this.sessions.values()]) {
      session.closed = true
      this.settlePermissions(session)
      this.openSettleGate(session)
      session.activeToolCalls.clear()
      // A forced teardown never closes its turn: every still-open dispatch
      // becomes `unknown` here.
      this.onSessionBackgroundTeardown?.(session, 'unknown')
      clearAmbientState(session)
      this.sessions.delete(session.sessionId)
      this.acpIndex.delete(session.acpSessionId)
      this.hub.broadcast({ type: 'session/closed', sessionId: session.sessionId, reason })
    }
    this.conn?.close()
    this.conn = undefined
    this.killChild()
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
  }

  /**
   * Fire-and-forget kill for the NON-teardown paths: idle release, workspace
   * move, crash handling, `forceReset`, and a start's own failure. None of them
   * may block on a dying process, and CRASH ≠ DESTROY (constraint 10): the
   * sessions were already parked by the caller, this only takes the process
   * away. The awaitable variant is `killChildAndWait`, used by host shutdown.
   */
  private killChild(): void {
    const child = this.child
    this.child = undefined
    // No child, no recorded spawn cwd: the next spawn decides its own (see
    // `spawnAndConnect`). Leaving it behind would make `ensureReady` believe a
    // process is still running in that directory.
    this.spawnCwd = undefined
    if (child === undefined) return
    void disposeChild(child, KILL_ESCALATION_DELAY_MS)
  }

  /**
   * Take the current child away and WAIT until it is gone (bounded). Only the
   * host shutdown path uses this — every other teardown must stay
   * fire-and-forget.
   *
   * Always resolves: a teardown that could hang on an agent ignoring SIGTERM
   * would be worse than a leaked process, and the process-exit reaper
   * (`reapLiveChildren`) still holds the pid if even the escalation loses.
   */
  private async killChildAndWait(budgetMs: number): Promise<void> {
    const child = this.child
    this.child = undefined
    this.spawnCwd = undefined
    if (child === undefined) return
    await disposeChild(child, budgetMs)
  }

  /**
   * Host shutdown: park every live session as RELEASED (resumable, exactly as a
   * crash would leave it), then WAIT for the child to die.
   *
   * Deliberately not `stop`: `stop` asks every session's agent to
   * `session/close` and then clears the released records — i.e. it DESTROYS the
   * conversations. A host shutdown is not the user's "stop this agent" gesture:
   * the host is coming back, and the conversations must come back with it
   * (constraint 10, plus the `chatSessions` records that outlive the restart).
   * Skipping the per-session RPC is also what keeps teardown bounded: N sessions
   * would otherwise spend up to N × SESSION_CLOSE_TIMEOUT_MS before the child
   * was even signalled, and the process is about to die anyway — "the agent
   * forgot this session" costs nothing a `session/load` cannot rebuild.
   *
   * Always resolves: `budgetMs` bounds the WHOLE kill — parking is synchronous,
   * the graceful wait and the escalation both come out of the same deadline,
   * and whatever still lives after it is the exit reaper's.
   */
  async shutdown(budgetMs: number = SHUTDOWN_BUDGET_MS): Promise<void> {
    const deadline = Date.now() + Math.max(0, budgetMs)
    // A deliberate teardown: an in-flight start must not publish `ready` (or
    // leave its process running) over the stopped state this leaves behind.
    this.teardownEpoch += 1
    this.starting = undefined
    this.clearIdleTimer()
    this.parkSessions('the host is shutting down', 'shutdown')
    this.conn?.close()
    this.conn = undefined
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
    await this.killChildAndWait(Math.max(0, deadline - Date.now()))
  }

  /**
   * Answer one ACP permission ask.
   *
   * EVERY ask is answered by a human through the plugin's own ledger. The
   * host's approval chain is deliberately not involved: it could accept an ask
   * and render nothing, leaving the turn hanging behind something invisible
   * with no deadline (issue #2). The ledger broadcasts `permission/request`,
   * the browser renders the answerable card, and `permission/respond` settles
   * it.
   *
   * The host answers on its own only when a deadline expires: `abort` refuses,
   * `auto` picks the option the agent's own kinds imply, `wait` never expires.
   * The ACP request's own `signal` (the agent withdrawing the ask, or the
   * connection dying) settles the same entry cancelled, so a withdrawn ask can
   * never leave a stale card behind.
   */
  private async handlePermissionRequest(acpSessionId: string, toolCall: unknown, options: PermissionOption[], signal?: AbortSignal): Promise<RequestPermissionResponse> {
    const session = this.acpIndex.get(acpSessionId)
    if (session === undefined || session.closed) return { outcome: { outcome: 'cancelled' } }
    // An ask is the agent speaking, not silence: the stall watchdog measures
    // from here, and the pending ask exempts the session anyway.
    session.lastAgentActivityAt = Date.now()
    // The deadline and the mode are read ONCE, here: an ask that started under
    // one pair keeps it, even if the settings page rewrites them mid-flight.
    const mode = this.permissionTimeoutMode
    const timeoutMs = this.permissionTimeoutMs
    // 不等待（0）只属自动推进：请求到达即按那一档收场，不建 ledger 条目、不发卡
    // ——问都来不及问。超时中止没有这一档（它会立刻拒绝每一问，agent 在每个门口
    // 都停住），它的窗口最短是真实等待。
    if (mode === 'auto' && timeoutMs === 0) {
      return this.settleExpiredAsk(session, mode, toolCall, options, 0)
    }
    const optionViews = options.map((o): PermissionOptionView => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
    const reason = permissionAskReason(toolCall)
    // Computed once, at ask creation: the frame, the chat line and the timer
    // all describe the same instant, and a slow reader cannot stretch it.
    const deadlineAt = timeoutMs > 0 && mode !== 'wait' ? Date.now() + timeoutMs : undefined
    const view = {
      ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
      // Kept whole for the reconnect replay: a client that connects after the
      // ask was broadcast must be re-shown the very card it has to answer.
      toolCall,
      toolName: permissionToolName(toolCall),
      ...(reason === '' ? {} : { reason }),
      options: optionViews,
      timeoutMode: mode,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    }
    return new Promise<RequestPermissionResponse>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let detachSignal: (() => void) | undefined
      const requestId = this.permissions.create(session.sessionId, (outcome: PermissionOutcome) => {
        clearTimeout(timer)
        detachSignal?.()
        this.touch()
        // The answer releases the agent to continue; the turn's clock restarts
        // here, not at the ask that may have waited on a human for minutes.
        session.lastAgentActivityAt = Date.now()
        this.hub.broadcast({
          type: 'permission/resolved',
          requestId,
          sessionId: session.sessionId,
          outcome,
        })
        resolve(outcome.outcome === 'selected'
          ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
          : { outcome: { outcome: 'cancelled' } })
      }, view)
      // The live frame and the replay frame come from ONE builder, so a
      // reconnecting client receives exactly what a live one did.
      this.hub.broadcast(permissionRequestFrame({ requestId, sessionId: session.sessionId, ...view }))
      if (deadlineAt !== undefined) {
        timer = setTimeout(() => {
          if (!this.permissions.has(requestId)) return
          // Settle IN PLACE: exactly one notice, one `permission/expired` (the
          // conversation's trace of the expiry) and the ledger answer.
          const outcome = this.announceExpiredAsk(session, mode, toolCall, options, timeoutMs)
          this.permissions.respond(requestId, outcome)
        }, Math.max(0, deadlineAt - Date.now()))
        timer.unref?.()
      }
      // The agent's own withdrawal settles the entry cancelled; the ledger's
      // resolve callback broadcasts `permission/resolved`, and drops this
      // listener, so nothing outlives the ask.
      if (signal !== undefined) {
        const onAbort = (): void => {
          if (!this.permissions.has(requestId)) return
          this.permissions.respond(requestId, { outcome: 'cancelled' })
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detachSignal = () => { signal.removeEventListener('abort', onAbort) }
      }
    })
  }

  /**
   * Announce and compute one ask's expiry. Shared by the 不等待 arrival path
   * and the ledger deadline, so an expiry can never broadcast two notices or
   * skip the `permission/expired` line: once the card is gone that frame is
   * the conversation's only trace of what happened to the question.
   */
  private announceExpiredAsk(
    session: LiveSession,
    mode: PermissionTimeoutMode,
    toolCall: unknown,
    options: PermissionOption[],
    timeoutMs: number,
  ): PermissionOutcome {
    const picked = mode === 'auto'
      ? pickAutoOption(options.map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind })))
      : undefined
    const outcome: PermissionOutcome = picked === undefined
      ? { outcome: 'cancelled' }
      : { outcome: 'selected', optionId: picked.optionId }
    const tool = permissionToolName(toolCall)
    // 不等待（0）不是「等了 0 秒」，是没等：两种说法的区别就在这里。
    const waited = timeoutMs > 0
      ? `timed out after ${String(Math.round(timeoutMs / 1000))}s`
      : 'was not waited for'
    this.hub.broadcast({
      type: 'agent/notice',
      agentId: this.def.id,
      level: 'info',
      // Name what was missed and what was done about it — the way a human
      // needs it: which operation sat unanswered, and what the plugin answered
      // instead. OmniTerm's reaper writes the same "you missed this" notice.
      text: picked === undefined
        ? `acp: permission request for "${tool}" ${waited}; refused`
        : `acp: permission request for "${tool}" ${waited}; answered "${picked.name}"`,
    })
    this.hub.broadcast({
      type: 'permission/expired',
      sessionId: session.sessionId,
      toolCall,
      timeoutMs,
      outcome,
      ...(picked === undefined ? {} : { optionName: picked.name }),
    })
    return outcome
  }

  /**
   * Settle the 不等待 (`auto` + zero window) ask on arrival: no ledger entry
   * and no card — nothing asks a human, so there is nothing to show. `auto`
   * answers with the option the agent's own kinds imply ({@link pickAutoOption})
   * and the agent CONTINUES. A mode that cannot pick an option (no options, or
   * none with a usable id) degrades to refusing: safer than guessing, and
   * hanging is worse than either.
   */
  private settleExpiredAsk(
    session: LiveSession,
    mode: PermissionTimeoutMode,
    toolCall: unknown,
    options: PermissionOption[],
    timeoutMs: number,
  ): RequestPermissionResponse {
    session.lastAgentActivityAt = Date.now()
    const outcome = this.announceExpiredAsk(session, mode, toolCall, options, timeoutMs)
    return outcome.outcome === 'selected'
      ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
      : { outcome: { outcome: 'cancelled' } }
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
   * (`handlePermissionRequest`). See docs/acp-convergence.md §2.3.
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
    // `closeSession` marks the record synchronously and then awaits the
    // agent's `session/close`; an update racing that wait must not revive
    // activity (e.g. report a new dispatch) on a record already going away.
    if (session.closed) return
    // Detached-worker / drain bookkeeping runs BEFORE the turn controller and
    // the cursor: a worker may report after the turn that dispatched it closed,
    // and the session-level record is the only place that fact can land.
    this.onSessionBackgroundUpdate?.(session, params.update)
    // Any update is the agent speaking: restart the stall clock here. A
    // tool-call status also says whether the agent is inside a long-running
    // tool, which earns the wider watchdog window.
    session.lastAgentActivityAt = Date.now()
    const kind = params.update.sessionUpdate
    const meta = codebuddyMetaOf(params.update)
    // History replay (same two signals as the dispatch tracker): a replayed
    // drain announcement must not rebuild a live ambient, and replayed tool
    // frames must not leave calls open in the stall watchdog's set — the
    // replay never sends their terminal frame. Derived display state, the
    // transcript and the broadcast below still take every frame.
    const replay = session.loadingHistory === true || meta?.historyReplay === true
    // A RETIRED drain that speaks again is alive, not retired. Un-retire it
    // BEFORE this update is classified and rebuild the ambient record: the run
    // may never re-announce itself, yet the next prompt folded into it must
    // still be recognised as steered and receive the drain's text. A
    // re-announcement below does the same for its id.
    //
    // `retiredDrain` only drives the revive below: an already-consumed run
    // stays transcript-only for the idle collector (`LiveSession.consumedDrains`),
    // so this frame cannot open a second answer after its deferral.
    const retiredDrain = !replay && meta?.requestId !== undefined && isRetiredAmbientId(session, meta.requestId)
    if (retiredDrain && meta?.requestId !== undefined) {
      reviveAmbientId(session, meta.requestId)
      session.ambient = {
        requestId: meta.requestId,
        startedAt: session.ambient?.startedAt ?? Date.now(),
        lastActivityAt: Date.now(),
        sawOutput: session.ambient?.sawOutput ?? false,
      }
    }
    if (!replay && meta?.unsolicitedTurn !== undefined) {
      // The agent started a background turn on its own: remember it so a
      // prompt the agent folds into it (answered instantly, no conversation
      // request id) can be kept open until the drain speaks. Announced once per
      // request id — a repeated announcement is the same run, not news.
      const run = meta.unsolicitedTurn
      // A re-announcement also revives a drain whose wait already closed: the
      // same run is alive, and the notice de-dupe set keeps it silent.
      reviveAmbientId(session, run.requestId)
      session.ambient = { requestId: run.requestId, startedAt: Date.now(), lastActivityAt: Date.now(), sawOutput: false }
      const announced = session.ambientNotices ?? new Set<string>()
      session.ambientNotices = announced
      if (!announced.has(run.requestId)) {
        announced.add(run.requestId)
        // The de-dupe set outlives individual turns (a hard ceiling keeps the
        // drain record), so it is bounded: evict the oldest ids first.
        while (announced.size > AMBIENT_NOTICE_MAX) {
          const oldest = announced.values().next().value
          if (oldest === undefined) break
          announced.delete(oldest)
        }
        this.hub.broadcast({
          type: 'agent/notice',
          agentId: session.agentId,
          level: 'info',
          text: `acp: agent "${this.def.id}" started a background task turn (${run.reason ?? 'unsolicited'}); its output will appear in the ACP transcript view, or in the turn that was waiting for it.`,
        })
      }
    }
    if (!replay && session.ambient !== undefined
      && meta?.requestId === session.ambient.requestId) {
      // The run is alive: refresh the staleness clock on ANY update it owns,
      // not just prose (a tool-heavy stretch is still the drain working).
      session.ambient.lastActivityAt = Date.now()
      if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
        && chunkTextOf((params.update as { content?: unknown }).content) !== '') {
        session.ambient.sawOutput = true
      }
    }
    // The drain record above is THIS frame's: the manager collects an IDLE
    // drain's prose from here (a steered prompt or a hold already consumes it,
    // and the collector checks that before taking anything).
    this.onSessionDrainText?.(session, params.update)
    if (!replay && (kind === 'tool_call' || kind === 'tool_call_update')) {
      const { toolCallId, status } = params.update as { toolCallId: string; status?: string | null }
      if (status === 'completed' || status === 'failed') session.activeToolCalls.delete(toolCallId)
      else if (status === 'pending' || status === 'in_progress') session.activeToolCalls.add(toolCallId)
      // A `tool_call` without a status is a call the agent just announced and
      // has not finished: count it as in flight. On an UPDATE the status is
      // optional, and an absent one carries no news either way.
      else if (kind === 'tool_call' && (status === undefined || status === null)) session.activeToolCalls.add(toolCallId)
    }
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

/** A JSON-RPC internal error for fs requests: actionable text in `message`, mirrored into `data` (see AGENTS.md rule 5). */
function fsRequestError(message: string): RequestError {
  return new RequestError(-32603, message, { message })
}
