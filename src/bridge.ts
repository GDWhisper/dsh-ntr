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
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
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
  isUnderPath,
  parseCatalogOptions,
  permissionToolKind,
  permissionToolPaths,
  quoteCommandToken,
  randomUUID,
  resolveFsPath,
  resolveSessionCwd,
  selectForwardPrompt,
  acpPresetStatusFromRoster,
  splitAdapterModelId,
  validateAgentDef,
} from './impl.ts'
import type {
  AcpToolCallSnapshot, PermissionDecision, RosterPresetRow,
} from './impl.ts'
import type {
  AcpAgentCatalog, AcpAgentDef, AcpPresetStatus, AgentCatalogResult, AgentProbeModelsResult, AgentTestResult, AgentView, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, GenerateOptions, LlmAdapterLike,
  LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmReasoningEffortInfo, LlmResolvedModelInfo, PermissionMode,
  PermissionOutcome, PermissionOptionView, PreparedAdapterCall, SessionView, StreamChunk,
} from './protocol.ts'

const STDERR_TAIL_LINES = 40
/** Single fs/read_text_file answer cap — agents reading huge files must page via `line`/`limit`. */
const FS_MAX_READ_BYTES = 2 * 1024 * 1024
/** Single fs/write_text_file payload cap. */
const FS_MAX_WRITE_BYTES = 2 * 1024 * 1024

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
  transcript: Transcript
}

/** Reliability tuning, threaded from `AcpPluginConfig` through the manager. */
export interface BridgeTuning {
  startupTimeoutMs?: number
  permissionTimeoutMs?: number
  cancelFallbackMs?: number
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
  cancelFallbackMs: 15_000,
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
  private readonly startupTimeoutMs: number
  private readonly permissionTimeoutMs: number
  private readonly cancelFallbackMs: number
  private readonly turnSettleMs: number
  private readonly defaultIdleTimeoutMs: number
  private readonly probeIdleTimeoutMs: number
  /** Armed while READY; fires the idle-release check (never per-event). */
  private idleTimer?: ReturnType<typeof setTimeout>
  /** Last observable activity; the idle window is measured from here. */
  private lastActivityAt = 0
  /** Throwaway catalog probes in flight — they hold no live session of their own. */
  private pendingProbes = 0
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
    /** Observes `configOptions` from any real session so the manager's model catalog stays warm. */
    private readonly onCatalog?: (agentId: string, configOptions: unknown) => void,
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
    this.cancelFallbackMs = merged.cancelFallbackMs
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
   * being used.
   */
  private touch(): void {
    this.lastActivityAt = Date.now()
    this.armIdleRelease()
  }

  /**
   * Arm the single idle timer. The delay is what is left of the window measured
   * from the last activity, so a timer that fires early (one timer is armed and
   * not rescheduled per event) self-corrects rather than releasing a busy agent.
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
   * Deliberately scoped to bridges with NO live session: killing a process the
   * user is chatting with would trade a resident process for a cold start on the
   * next message. Parked `released` records do not block a release and survive
   * it — they are resumable on a fresh child by design (`session/load`).
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
    if (!this.isQuiet()) {
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
    this.touch()
    return () => {
      if (session.settled === settled) session.settled = undefined
      settle()
      // The turn is over: a fresh window starts here rather than at the prompt
      // that may have started a long turn ago.
      this.touch()
    }
  }

  view(): AgentView {
    return {
      id: this.def.id,
      title: this.def.title ?? this.def.id,
      command: this.def.command,
      args: [...(this.def.args ?? [])],
      permission: this.def.permission ?? 'ask',
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

  setPermission(mode: PermissionMode): void {
    this.def.permission = mode
    this.publishStatus()
  }

  /**
   * Nothing depends on this child's identity right now: no live session, no
   * probe, no resume, no open permission ask, nothing starting. The one shared
   * predicate behind both the idle release and the workspace move below — two
   * copies of it would drift, and "is it safe to drop this child" is exactly
   * the question that must never be answered twice, differently.
   */
  private isQuiet(): boolean {
    return this.sessions.size === 0
      && this.pendingProbes === 0
      && this.resuming.size === 0
      && this.permissions.sessionIds().length === 0
      && this.starting === undefined
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
    // plus the well-known extra dirs, not the scrubbed child env.
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
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
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
    this.stderrTail.push(line.slice(0, 2000))
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
    if (this.onCatalog !== undefined && result.configOptions !== undefined && result.configOptions !== null) {
      this.onCatalog(this.def.id, result.configOptions)
    }
    const session: LiveSession = {
      sessionId: randomUUID(),
      agentId: this.def.id,
      acpSessionId: result.sessionId,
      cwd: resolved,
      running: false,
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
      ...(result.configOptions !== undefined && result.configOptions !== null ? { configOptions: result.configOptions } : {}),
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
   */
  async runPrompt(session: LiveSession, text: string, turnId: string): Promise<string> {
    const conn = this.conn
    if (conn === undefined || session.closed || session.released) throw new AcpError('session_closed', 'acp: session is closed')
    this.touch()
    const result = await conn.agent.request(methods.agent.session.prompt, {
      sessionId: session.acpSessionId,
      prompt: [{ type: 'text', text }],
    })
    return result.stopReason
  }

  async cancel(session: LiveSession): Promise<void> {
    if (this.conn === undefined) return
    this.touch()
    await this.conn.agent.notify(methods.agent.session.cancel, { sessionId: session.acpSessionId }).catch(() => { /* best effort */ })
    this.armCancelFallback(session)
  }

  /**
   * An agent that ignores the `session/cancel` notification must not wedge the
   * session in `running` forever (every later prompt would fail with
   * `turn_in_flight`). Force-finalize the turn after the grace period; the
   * real `session/prompt` response may still arrive later and is folded in by
   * the manager as usual.
   */
  private armCancelFallback(session: LiveSession): void {
    if (this.cancelFallbackMs <= 0) return
    const timer = setTimeout(() => {
      if (session.closed || !session.running) return
      session.running = false
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
      if (this.onCatalog !== undefined && result.configOptions !== undefined && result.configOptions !== null) {
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
      if (Array.isArray(result.configOptions)) session.configOptions = result.configOptions
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

  /** Release all live sessions (agent process died): keep them resumable, settle permissions, drop the connection. */
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

  async setMode(session: LiveSession, modeId: string): Promise<void> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    this.touch()
    await conn.agent.request(methods.agent.session.setMode, { sessionId: session.acpSessionId, modeId })
    // Well-behaved agents push `current_mode_update`, but the spec does not
    // require it — apply locally so the browser selector never goes stale.
    if (session.modes !== undefined) session.modes = { ...session.modes, currentModeId: modeId }
    this.publishMeta(session)
  }

  async setConfigOption(session: LiveSession, configId: string, value: string | boolean): Promise<void> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    this.touch()
    const result = await conn.agent.request(methods.agent.session.setConfigOption, { sessionId: session.acpSessionId, configId, value }) as { configOptions?: unknown }
    // The response carries the full authoritative option set; some agents
    // (pi-acp observed) never re-notify after a client-driven set.
    if (Array.isArray(result.configOptions)) session.configOptions = result.configOptions as unknown[]
    this.publishMeta(session)
  }

  private publishMeta(session: LiveSession): void {
    this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
  }

  async closeSession(session: LiveSession, reason: 'closed' | 'agent-stopped' | 'agent-died'): Promise<void> {
    if (session.closed) return
    session.closed = true
    // Closing the last session is what makes a chat agent idle: start the
    // window here rather than at the prompt that opened it.
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
   * Answer one ACP permission ask. The governing policy is the session's DSH
   * access mode when it has one (chat-backed sessions — see
   * `docs/acp-permission-and-sandbox.md`); otherwise the agent's own
   * `permission` field, exactly as before the mapping existed. `ask` always
   * means "a human decides": the native approval chain first, the ledger
   * otherwise.
   */
  private async handlePermissionRequest(acpSessionId: string, toolCall: unknown, options: PermissionOption[], signal?: AbortSignal): Promise<RequestPermissionResponse> {
    const session = this.acpIndex.get(acpSessionId)
    const decision = this.permissionDecision(session, toolCall)
    if (decision === 'allow') return selectOption(options, 'allow')
    if (decision === 'reject') return selectOption(options, 'reject')
    if (session === undefined || session.closed) return { outcome: { outcome: 'cancelled' } }
    // Native approval first (answered in the chat composer); `undefined` means
    // no route is available and the settings-panel ledger takes over.
    const routed = await this.askNativeApproval(session, toolCall, options, signal)
    if (routed !== undefined) {
      this.touch()
      return routed
    }
    return new Promise<RequestPermissionResponse>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const requestId = this.permissions.create(session.sessionId, (outcome: PermissionOutcome) => {
        clearTimeout(timer)
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
      })
      // Optional deadline (`permissionTimeoutMs`): an approval left unanswered
      // is answered `cancelled` on the human's behalf instead of hanging the
      // turn forever. Off by default — approvals belong to a person.
      if (this.permissionTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.permissions.has(requestId)) return
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: this.def.id,
            level: 'info',
            text: `acp: permission request timed out after ${String(Math.round(this.permissionTimeoutMs / 1000))}s; answered "cancelled"`,
          })
          this.permissions.respond(requestId, { outcome: 'cancelled' })
        }, this.permissionTimeoutMs)
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
   * Ask the host approval service for this permission (`ctx.approval` → the
   * browser's composer takeover). Only sessions bound to a DSH chat session
   * qualify: the service appends its audit pair to that session inside an
   * open turn, so a session started over `/acp` (no chat turn) cannot be
   * routed and must stay on the ledger path.
   *
   * No `permissionTimeoutMs` timer is armed here on purpose: the human answers
   * inside the conversation, and a host-side deadline would answer for them.
   *
   * @returns the agent-facing response, or `undefined` to fall back to the ledger.
   */
  private async askNativeApproval(
    session: LiveSession,
    toolCall: unknown,
    options: PermissionOption[],
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse | undefined> {
    const requester = this.approvalRequester?.()
    if (requester === undefined || session.dshSessionId === undefined) return undefined
    let outcome: ApprovalOutcome
    try {
      outcome = await requester({
        dshSessionId: session.dshSessionId,
        agentId: this.def.id,
        toolName: permissionToolName(toolCall),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      // Synchronous throw or rejection, either way: the ask falls back to the
      // ledger. An approval failure must never break the agent's turn.
      outcome = 'unavailable'
    }
    if (outcome === 'unavailable') return undefined
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
    return response
  }

  /**
   * The effective decision for one ask.
   *
   * The agent's own `permission` field is the only knob, because the host no
   * longer sits in the middle: an ACP agent is fully autonomous, and what it
   * asks is mapped to the user unchanged (`askNativeApproval`). The retired
   * axis resolved a DSH access mode and pre-judged every ask with it — which
   * both inverted `never` into "deny everything" and let `allow` skip the
   * human entirely. See docs/acp-convergence.md §2.3.
   */
  private permissionDecision(_session: LiveSession | undefined, _toolCall: unknown): PermissionDecision {
    switch (this.def.permission ?? 'ask') {
      case 'allow': return 'allow'
      case 'reject': return 'reject'
      default: return 'ask'
    }
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
        session.configOptions = update.configOptions ?? []
        this.onCatalog?.(this.def.id, session.configOptions)
        break
      case 'available_commands_update':
        session.availableCommands = update.availableCommands.map(c => ({
          name: c.name,
          ...(c.description !== null ? { description: c.description } : {}),
        }))
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
function permissionToolName(toolCall: unknown): string {
  const row = (typeof toolCall === 'object' && toolCall !== null ? toolCall : {}) as Record<string, unknown>
  return typeof row.title === 'string' && row.title !== '' ? row.title : 'tool call'
}

/**
 * Choose the agent's own option for a decided ask. The specific variants are
 * preferred over the `always` ones because neither DSH's approval chain nor our
 * mode mapping ever grants a standing permission.
 */
function selectOption(options: PermissionOption[], direction: 'allow' | 'reject'): RequestPermissionResponse {
  const wanted: readonly string[] = direction === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of wanted) {
    const option = options.find(o => o.kind === kind)
    if (option !== undefined) return { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
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
 * ~/.dsh/acp-workspaces" no matter what `session/new` said (observed on
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
 * Plugin-owned default execution workspace, anchored to the plugin state dir
 * (`~/.dsh/acp-workspaces`).
 *
 * It deliberately does NOT derive from `process.cwd()`: that is wherever the
 * DSH host happened to be launched from, so the "default workspace" used to
 * move around per launch — and, via the `allowedCwdRoots` fallback, it could
 * widen an agent's sandbox to the entire launch directory (in practice `$HOME`
 * when `dsh web` is started from the home dir).
 */
export function defaultAgentWorkspace(home: string = homedir()): string {
  return join(home, '.dsh', 'acp-workspaces')
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
        output.push(line.slice(0, 500))
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

/** Routes host session ids to their owning bridge. */
export class BridgeManager {
  private readonly bridges = new Map<string, AgentBridge>()
  private readonly defsMap = new Map<string, AcpAgentDef>()
  /** The plugin's own default ACP agent id (persisted; see `persistAgents`). */
  private defaultAgentId?: string

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
    this.loadPersistedAgents()
    this.loadPersistedCatalogs()
  }

  private makeBridge(def: AcpAgentDef, onConnectionLost: (bridge: AgentBridge, reason: string) => void, onCatalog?: (agentId: string, configOptions: unknown) => void): AgentBridge {
    return new AgentBridge(def, this.hub, this.transcriptMax, onConnectionLost, onCatalog, this.tuning, () => this.approvalRequester, () => this.sessionWorkspaceResolver)
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
   * Let the host resolve a chat session's workspace root — the sidebar's
   * selected workspace, which the agent's session and its process both run in.
   * Absent resolver → every chat session falls back to the agent's configured
   * cwd (`~/.dsh/acp-workspaces`), which is the right answer for `/acp`-RPC
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
      if (session.dshSessionId !== dshSessionId) continue
      const title = this.defsMap.get(session.agentId)?.title
      out.push({
        agentId: session.agentId,
        ...(title === undefined ? {} : { agentTitle: title }),
        sessionId: session.sessionId,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
        ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
        ...(session.modes === undefined ? {} : { modes: session.modes }),
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
    this.chatAgentIntent.set(dshSessionId, agentId)
  }

  /** The ACP agent a chat session was last pointed at, when one is known. */
  chatAgentFor(dshSessionId: string): string | undefined {
    const recorded = this.chatAgentIntent.get(dshSessionId)
    if (recorded !== undefined && this.defsMap.has(recorded)) return recorded
    // Fall back to the binding itself: a session that already ran an agent is
    // pointed at that agent even if the intent map was never seeded.
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId === dshSessionId && !session.closed) return session.agentId
    }
    return undefined
  }

  /** Switch the bound agent's model for one chat session (`agentId@choice`). */
  async setChatSessionModel(dshSessionId: string, modelId: string): Promise<void> {
    const { agentId, choice } = splitAdapterModelId(modelId)
    const def = this.defsMap.get(agentId)
    if (def === undefined) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    this.chatAgentIntent.set(dshSessionId, agentId)
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== agentId) continue
      if (session.released) continue
      session.choice = choice
      await this.alignSessionConfig(session, choice, session.reasoningEffort)
      session.modelId = modelId
    }
  }

  /** Switch the bound agent's reasoning effort for one chat session. */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined): Promise<void> {
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.released) continue
      session.reasoningEffort = effort
      await this.alignSessionConfig(session, session.choice, effort)
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
    const candidates = [...this.dshSessionMap.values()].filter(session => session.dshSessionId === dshSessionId)
    const target = agentId === undefined
      ? (candidates.find(session => !session.released) ?? candidates[0])
      : candidates.find(session => session.agentId === agentId)
    if (target === undefined || target.closed) {
      throw new AcpError('unknown_session', `acp: no live ACP session is bound to chat session ${dshSessionId}`)
    }
    const bridge = this.bridge(target.agentId)
    const session = target.released ? await bridge.resumeSession(target) : target
    await bridge.setMode(session, modeId)
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
    if (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test') {
      return undefined
    }
    try {
      const home = homedir()
      const dshDir = join(home, '.dsh')
      if (!existsSync(dshDir)) {
        mkdirSync(dshDir, { recursive: true })
      }
      return join(dshDir, 'acp-agents.json')
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
        for (const item of rows) {
          try {
            const def = validateAgentDef(quoteLegacyCommand(item))
            this.defsMap.set(def.id, def)
          } catch {
            // Ignore invalid entry
          }
        }
      }
      if (!Array.isArray(parsed) && parsed !== null && typeof parsed === 'object') {
        const stored = (parsed as { defaultAgentId?: unknown }).defaultAgentId
        // Kept as-is (even when it names an agent this boot did not load):
        // `defaultAgent()` is the accessor that filters a stale id out, so a
        // temporarily unreadable agent list cannot silently erase the choice.
        if (typeof stored === 'string' && stored !== '') this.defaultAgentId = stored
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  private persistAgents(): void {
    const filePath = this.getStoragePath()
    if (!filePath) return
    try {
      const payload = {
        version: 2,
        ...(this.defaultAgentId === undefined ? {} : { defaultAgentId: this.defaultAgentId }),
        agents: [...this.defsMap.values()],
      }
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
    } catch {
      // Storage persist failure is non-fatal
    }
  }

  // ---- Model catalog ----

  private readonly catalogs = new Map<string, { catalog: AcpAgentCatalog; updatedAt: number }>()
  /** Auto-spawning probes are suppressed under test runners so suites stay deterministic. */
  private readonly autoProbeEnabled = process.env.VITEST === undefined && process.env.NODE_ENV !== 'test'

  private getCatalogStoragePath(): string | undefined {
    if (this.catalogStoragePath !== undefined) return this.catalogStoragePath
    if (process.env.DSH_ACP_CATALOG_FILE) return process.env.DSH_ACP_CATALOG_FILE
    if (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test') {
      return undefined
    }
    try {
      const dshDir = join(homedir(), '.dsh')
      if (!existsSync(dshDir)) {
        mkdirSync(dshDir, { recursive: true })
      }
      return join(dshDir, 'acp-model-catalog.json')
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
      for (const [agentId, raw] of Object.entries(agents)) {
        if (typeof raw !== 'object' || raw === null) continue
        const row = raw as { catalog?: unknown; updatedAt?: unknown }
        if (typeof row.catalog !== 'object' || row.catalog === null) continue
        this.catalogs.set(agentId, {
          catalog: row.catalog as AcpAgentCatalog,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        })
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  private persistCatalogs(): void {
    const filePath = this.getCatalogStoragePath()
    if (!filePath) return
    try {
      const agents: Record<string, { catalog: AcpAgentCatalog; updatedAt: number }> = {}
      for (const [agentId, entry] of this.catalogs) agents[agentId] = entry
      writeFileSync(filePath, JSON.stringify({ version: 1, agents }, null, 2), 'utf-8')
    } catch {
      // Storage persist failure is non-fatal
    }
  }

  /** Merge `configOptions` observed on any real session into the agent's catalog. */
  private absorbCatalog(agentId: string, configOptions: unknown): { catalog: AcpAgentCatalog; updatedAt: number } {
    const catalog = parseCatalogOptions(configOptions)
    const existing = this.catalogs.get(agentId)
    if (existing !== undefined && JSON.stringify(existing.catalog) === JSON.stringify(catalog)) return existing
    const entry = { catalog, updatedAt: Date.now() }
    this.catalogs.set(agentId, entry)
    this.persistCatalogs()
    return entry
  }

  catalogFor(agentId: string): AcpAgentCatalog | undefined {
    return this.catalogs.get(agentId)?.catalog
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
    return { agentId, catalog: entry.catalog, updatedAt: entry.updatedAt }
  }

  /**
   * Fire-and-forget background probe for an agent without a cached catalog.
   * Failures stay silent: the catalog is advisory and an ACP seat simply shows
   * the agent's default model until a probe succeeds.
   */
  private ensureCatalog(agentId: string): void {
    if (this.catalogs.has(agentId)) return
    if (!this.autoProbeEnabled || !this.probeModelsOnBoot) return
    void this.probeAgentModels(agentId).catch(() => { /* background best-effort */ })
  }

  /** Boot-time probe for agents that have no persisted catalog yet. */
  bootstrapCatalogs(): void {
    if (!this.autoProbeEnabled || !this.probeModelsOnBoot) return
    for (const def of this.defsMap.values()) this.ensureCatalog(def.id)
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
   * Pure memory — NEVER spawns; an agent without a cached catalog merely gets a
   * background probe so the next read is complete.
   */
  agentCatalog(agentId: string): AgentCatalogResult {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    const title = def.title ?? def.id
    const entry = this.catalogs.get(agentId)
    if (entry === undefined) this.ensureCatalog(agentId)
    const exposed = def.exposedModels
    const variants: AgentCatalogResult['variants'] = []
    for (const choice of entry?.catalog.model?.choices ?? []) {
      if (exposed === undefined || !exposed.includes(choice.value)) continue
      variants.push({
        id: buildAdapterModelId(def.id, choice.value),
        name: `${title} · ${choice.name}`,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
      })
    }
    const reasoning = this.reasoningMeta(agentId)
    return {
      agentId: def.id,
      title,
      base: {
        id: def.id,
        name: title,
        description: `ACP Agent: ${def.command} ${(def.args ?? []).join(' ')}`.trim(),
      },
      variants,
      probed: entry !== undefined,
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(entry === undefined ? {} : { updatedAt: entry.updatedAt }),
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
   */
  private async alignSessionConfig(session: LiveSession, modelChoice: string | undefined, effort: string | undefined): Promise<void> {
    const wantedModel = modelChoice !== undefined && modelChoice !== '' ? modelChoice : undefined
    const wantedEffort = effort !== undefined && effort !== '' ? effort : undefined
    if (wantedModel === undefined && wantedEffort === undefined) return
    const catalog = parseCatalogOptions(session.configOptions)
    const bridge = this.bridge(session.agentId)
    const notice = (level: 'info' | 'error', text: string): void => {
      this.hub.broadcast({ type: 'agent/notice', agentId: session.agentId, level, text })
    }
    if (wantedModel !== undefined) {
      const model = catalog.model
      if (model === undefined) {
        notice('error', `acp: agent "${session.agentId}" exposes no model selector; ignoring model "${wantedModel}"`)
      } else if (model.currentValue !== wantedModel && (model.choices.length === 0 || model.choices.some(c => c.value === wantedModel))) {
        try {
          await bridge.setConfigOption(session, model.configId, wantedModel)
        } catch (error) {
          notice('error', `acp: failed to switch model to "${wantedModel}": ${describeError(error)}`)
        }
      }
    }
    if (wantedEffort !== undefined) {
      const thought = catalog.thought
      if (thought !== undefined && thought.currentValue !== wantedEffort && (thought.choices.length === 0 || thought.choices.some(c => c.value === wantedEffort))) {
        try {
          await bridge.setConfigOption(session, thought.configId, wantedEffort)
        } catch (error) {
          notice('error', `acp: failed to set thought level "${wantedEffort}": ${describeError(error)}`)
        }
      }
    }
  }

  private bridge(agentId: string): AgentBridge {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    let bridge = this.bridges.get(agentId)
    if (bridge === undefined) {
      bridge = this.makeBridge(def, (b, reason) => {
        this.connectionLost(b, reason)
      }, (observedAgentId, configOptions) => {
        this.absorbCatalog(observedAgentId, configOptions)
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
    if (this.catalogs.delete(agentId)) this.persistCatalogs()
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
    await this.bridges.get(agentId)?.stop('agent-stopped')
  }

  async shutdownAll(): Promise<void> {
    this.dshSessionMap.clear()
    await Promise.all([...this.bridges.values()].map(b => b.stop('agent-stopped')))
  }

  async setPermission(agentId: string, permission: PermissionMode): Promise<void> {
    this.bridge(agentId).setPermission(permission)
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
  }

  private readonly dshSessionMap = new Map<string, LiveSession>()
  /**
   * Which ACP agent each DSH chat session is pointed at, as chosen in the
   * conversation. Persisted with the agent registry; this is the plugin's own
   * conversation↔agent mapping, never a DSH model route (see `bindChatAgent`).
   */
  private readonly chatAgentIntent = new Map<string, string>()

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

  async getOrCreateDshSession(dshSessionId: string | undefined, agentId: string, cwd?: string): Promise<LiveSession> {
    const key = `${dshSessionId ?? 'ephemeral'}:${agentId}`
    const existing = this.dshSessionMap.get(key)
    if (existing !== undefined && !existing.closed && !existing.released) {
      return existing
    }
    // The session's agent died earlier: resume in place so the conversation
    // context survives via `session/load`.
    if (existing !== undefined && existing.released) {
      const resumed = await this.bridge(agentId).resumeSession(existing)
      // Rebind explicitly: a resume keeps the record's identity, but the chat
      // session id is what native approval routing keys off.
      resumed.dshSessionId = dshSessionId
      return resumed
    }
    // A chat session runs where its DSH session lives, not in the plugin's
    // sandbox directory: the sidebar's workspace selection IS the session's
    // workspace (`sandboxPolicy.resolve` reports it as `workspaceRoot`), and an
    // agent whose cwd is `~/.dsh/acp-workspaces` answers "current workspace"
    // with that path while its Read/Glob/Bash cannot see the user's project.
    // That root is trusted on top of the agent's own roots for this session
    // only (see `chatWorkspaceRoot`); the fallback is the configured cwd.
    const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspaceResolver, dshSessionId)
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
    return session
  }

  async *streamPrompt(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { agentId, choice } = splitAdapterModelId(options.model)
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

    // One prompt slot per session, and a turn the user aborted still occupies
    // the AGENT's slot until it acknowledges the cancel (see `claimTurn`).
    const claim = await bridge.claimTurn(session)
    if (!claim.ok) {
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
    await this.alignSessionConfig(session, choice, options.reasoningEffort)
    // Record what this conversation is now on, so `session/chat-list` can show
    // it without the browser having to derive it from anything else.
    session.modelId = options.model
    session.choice = choice
    session.reasoningEffort = options.reasoningEffort

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

    const queue = new AsyncQueue<StreamChunk>()
    session.running = true
    const turnId = randomUUID()
    this.hub.broadcast({ type: 'turn/start', sessionId: session.sessionId, turnId, text: promptText })

    let currentBlockIndex = -1
    let activeBlockType: 'reasoning' | 'text' | 'tool-call' | null = null
    let activeBlockText = ''
    /**
     * The open tool-call block's accumulated snapshot, or `undefined` while the
     * active block is prose. ACP has no fixed shape for tool-call content, so
     * this is where `callId` / `name` / `argsRaw` live until the block closes —
     * `block-end` carries a COMPLETE snapshot because the host's accumulator
     * replaces the block on `block-end` rather than merging into it.
     */
    let activeToolCall: AcpToolCallSnapshot | undefined
    let latestUsage: { inputTokens: number; outputTokens: number } | null = null

    const switchToBlock = (targetType: 'reasoning' | 'text' | 'tool-call') => {
      if (activeBlockType === targetType) return
      if (activeBlockType !== null) {
        queue.push({
          type: 'block-end',
          index: currentBlockIndex,
          block: activeBlockType === 'tool-call' && activeToolCall !== undefined
            ? { type: 'tool-call', id: activeToolCall.callId, name: activeToolCall.name, arguments: activeToolCall.argsRaw }
            : { type: activeBlockType, text: activeBlockText },
        })
      }
      currentBlockIndex++
      activeBlockType = targetType
      activeBlockText = ''
      activeToolCall = undefined
      queue.push({
        type: 'block-start',
        index: currentBlockIndex,
        blockType: targetType,
      })
    }

    const unsubscribe = this.hub.subscribe(event => {
      if (!('sessionId' in event) || event.sessionId !== session.sessionId) return
      if (event.type === 'session/update') {
        const update = event.update as Record<string, unknown>
        const kind = String(update.sessionUpdate ?? '')
        if (kind === 'agent_thought_chunk') {
          const content = update.content as Record<string, unknown> | undefined
          if (content?.type === 'text' && typeof content.text === 'string') {
            switchToBlock('reasoning')
            activeBlockText += content.text
            queue.push({ type: 'reasoning-delta', index: currentBlockIndex, text: content.text })
          }
        } else if (kind === 'tool_call') {
          // A real tool call, not prose: the host's accumulator turns these
          // deltas into `{ kind: 'tool-call', callId, name, argsRaw }` and the
          // Chat plane renders the card the ACP view used to own. A call whose
          // the same callId as the open block is an update-in-place, not a new
          // card — agents announce a call once and then update it.
          const snapshot = acpToolCallFromUpdate(update)
          if (snapshot !== undefined) {
            if (activeBlockType !== 'tool-call' || activeToolCall?.callId !== snapshot.callId) {
              switchToBlock('tool-call')
              activeToolCall = snapshot
              queue.push({
                type: 'tool-call-delta',
                index: currentBlockIndex,
                id: snapshot.callId,
                name: snapshot.name,
                argumentsDelta: snapshot.argsRaw,
              })
            }
          }
        } else if (kind === 'tool_call_update') {
          // Fold the update into the open card. An update for a call that is not
          // open (the agent skipped its `tool_call` announcement) opens one:
          // dropping it would lose the result entirely.
          const callId = typeof update.toolCallId === 'string' ? update.toolCallId.trim() : ''
          if (callId !== '') {
            if (activeBlockType !== 'tool-call' || activeToolCall?.callId !== callId) {
              const reopened = acpToolCallFromUpdate({ ...update, toolCallId: callId })
              switchToBlock('tool-call')
              activeToolCall = reopened
              queue.push({ type: 'tool-call-delta', index: currentBlockIndex, id: callId, argumentsDelta: '' })
            }
            if (activeToolCall !== undefined) {
              for (const delta of acpToolCallDelta(activeToolCall, update)) {
                if (delta.kind === 'name') {
                  queue.push({ type: 'tool-call-delta', index: currentBlockIndex, id: activeToolCall.callId, name: delta.name, argumentsDelta: '' })
                } else {
                  queue.push({ type: 'tool-call-delta', index: currentBlockIndex, id: activeToolCall.callId, argumentsDelta: delta.text })
                }
              }
            }
          }
        } else if (kind === 'agent_message_chunk') {
          const content = update.content as Record<string, unknown> | undefined
          if (content?.type === 'text' && typeof content.text === 'string') {
            switchToBlock('text')
            activeBlockText += content.text
            queue.push({ type: 'text-delta', index: currentBlockIndex, text: content.text })
          }
        } else if (kind === 'usage_update') {
          const used = typeof update.used === 'number' ? update.used : 0
          const size = typeof update.size === 'number' ? update.size : 0
          latestUsage = { inputTokens: size, outputTokens: used }
        }
      } else if (event.type === 'permission/request') {
        switchToBlock('reasoning')
        const title = typeof (event.toolCall as { title?: unknown } | undefined)?.title === 'string'
          ? String((event.toolCall as { title: string }).title)
          : 'permission'
        const line = `\n> 🔐 [Permission Required: ${title}] - please approve in Settings\n`
        activeBlockText += line
        queue.push({ type: 'reasoning-delta', index: currentBlockIndex, text: line })
      }
    })

    const onAbort = () => {
      void bridge.cancel(session)
      finishStream({ kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } })
    }

    let finished = false
    const finishStream = (reason: { kind: 'stop' } | { kind: 'aborted'; failure?: { message: string; code: string } } | { kind: 'error'; failure?: { message: string; code: string } }) => {
      if (finished) return
      finished = true
      options.signal?.removeEventListener('abort', onAbort)
      unsubscribe()
      session.running = false
      if (activeBlockType !== null) {
        queue.push({
          type: 'block-end',
          index: currentBlockIndex,
          block: activeBlockType === 'tool-call' && activeToolCall !== undefined
            ? { type: 'tool-call', id: activeToolCall.callId, name: activeToolCall.name, arguments: activeToolCall.argsRaw }
            : { type: activeBlockType, text: activeBlockText },
        })
        activeBlockType = null
        activeToolCall = undefined
      }
      if (latestUsage !== null) {
        queue.push({ type: 'usage', usage: latestUsage })
      }
      queue.push({ type: 'finish', reason })
      queue.close()
    }

    if (options.signal?.aborted) {
      onAbort()
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // The agent-side turn is in flight from here until its response lands
      // (or the connection dies): that window, not our own stream, is what the
      // next turn has to respect.
      const endTurn = bridge.beginTurn(session)
      bridge.runPrompt(session, promptText, turnId)
        .then(stopReason => {
          this.hub.broadcast({ type: 'turn/end', sessionId: session.sessionId, turnId, stopReason })
          if (stopReason === 'cancelled') {
            finishStream({ kind: 'aborted', failure: { message: 'Turn was cancelled', code: 'CANCELLED' } })
          } else {
            finishStream({ kind: 'stop' })
          }
        })
        .catch((err: unknown) => {
          const desc = describeError(err)
          this.hub.broadcast({ type: 'turn/end', sessionId: session.sessionId, turnId, error: desc })
          finishStream({ kind: 'error', failure: { message: desc, code: 'INTERNAL' } })
        })
        .finally(endTurn)
    }

    yield* queue
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
