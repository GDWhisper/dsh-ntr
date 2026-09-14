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
import { delimiter, dirname, join, resolve } from 'node:path'
import { Writable, Readable } from 'node:stream'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
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
  buildAdapterModelId,
  childEnv,
  parseCatalogOptions,
  randomUUID,
  resolveFsPath,
  resolveSessionCwd,
  splitAdapterModelId,
  validateAgentDef,
} from './impl.ts'
import type {
  AcpAgentCatalog, AcpAgentDef, AgentProbeModelsResult, AgentView, DetectedAgentInfo, GenerateOptions, LlmAdapterLike,
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
  modes?: SessionView['modes']
  configOptions?: unknown[]
  availableCommands?: SessionView['availableCommands']
  plan?: unknown[]
  usage?: SessionView['usage']
  running: boolean
  closed: boolean
  /** The agent process died; the session awaits a `session/load` resume. */
  released: boolean
  transcript: Transcript
}

/** Reliability tuning, threaded from `AcpPluginConfig` through the manager. */
export interface BridgeTuning {
  startupTimeoutMs?: number
  permissionTimeoutMs?: number
  cancelFallbackMs?: number
}

const DEFAULT_TUNING: Required<BridgeTuning> = {
  startupTimeoutMs: 60_000,
  permissionTimeoutMs: 0,
  cancelFallbackMs: 15_000,
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

  constructor(
    readonly def: AcpAgentDef,
    private readonly hub: EventHub,
    private readonly transcriptMax: number,
    /** Called when the connection dies so the manager can settle outstanding prompts. */
    private readonly onConnectionLost: (bridge: AgentBridge, reason: string) => void,
    /** Observes `configOptions` from any real session so the manager's model catalog stays warm. */
    private readonly onCatalog?: (agentId: string, configOptions: unknown) => void,
    tuning?: BridgeTuning,
  ) {
    const merged = { ...DEFAULT_TUNING, ...tuning }
    this.startupTimeoutMs = merged.startupTimeoutMs
    this.permissionTimeoutMs = merged.permissionTimeoutMs
    this.cancelFallbackMs = merged.cancelFallbackMs
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
    }
  }

  setPermission(mode: PermissionMode): void {
    this.def.permission = mode
    this.publishStatus()
  }

  /** Memoized spawn + `initialize`; failures reset so the next call can retry. */
  ensureReady(): Promise<void> {
    if (this.state === 'ready' && this.conn !== undefined) return Promise.resolve()
    if (this.starting !== undefined) return this.starting
    this.state = 'starting'
    this.publishStatus()
    this.starting = this.spawnAndConnect()
      .then(() => {
        this.state = 'ready'
        this.lastError = undefined
        this.publishStatus()
      })
      .catch((error: unknown) => {
        this.state = 'error'
        this.lastError = error instanceof Error ? error.message : String(error)
        this.killChild()
        this.publishStatus()
        throw new AcpError('agent_unreachable', `acp: agent "${this.def.id}" failed to start: ${this.lastError}`)
      })
      .finally(() => { this.starting = undefined })
    return this.starting
  }

  private async spawnAndConnect(): Promise<void> {
    this.stderrTail = []
    const child = spawn(this.def.command, [...(this.def.args ?? [])], {
      cwd: safeSpawnCwd(this.def),
      env: childEnv(process.env, this.def.env ?? {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: false,
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
        return this.handlePermissionRequest(ctx.params.sessionId, ctx.params.toolCall, ctx.params.options)
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

  async createSession(cwd: string | undefined): Promise<LiveSession> {
    await this.ensureReady()
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    const resolved = resolveSessionCwd(this.def, cwd, p => realpathSync(p))
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
    this.hub.broadcast({ type: 'session/created', sessionId: session.sessionId, session: snapshot(session) })
    return session
  }

  /**
   * Spawn a throwaway ACP session purely to read its `configOptions` (the
   * model catalog probe). Deliberately bypasses the live-session bookkeeping
   * so probe sessions never surface in the browser session list.
   */
  async probeConfigOptions(): Promise<unknown[]> {
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
  }

  /**
   * Fire one prompt turn. Returns after the agent settles the turn; the caller
   * (manager) keeps the UI informed through broadcast events, so the RPC that
   * started the turn can answer `accepted` immediately.
   */
  async runPrompt(session: LiveSession, text: string, turnId: string): Promise<string> {
    const conn = this.conn
    if (conn === undefined || session.closed || session.released) throw new AcpError('session_closed', 'acp: session is closed')
    const result = await conn.agent.request(methods.agent.session.prompt, {
      sessionId: session.acpSessionId,
      prompt: [{ type: 'text', text }],
    })
    return result.stopReason
  }

  async cancel(session: LiveSession): Promise<void> {
    if (this.conn === undefined) return
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
    const promise = this.doResumeSession(session).finally(() => {
      this.resuming.delete(session.sessionId)
    })
    this.resuming.set(session.sessionId, promise)
    return promise
  }

  private async doResumeSession(session: LiveSession): Promise<LiveSession> {
    try {
      await this.ensureReady()
      // The capability comes from the FRESH initialize: after a crash the
      // bridge restarts the process, so check the (new) initResult here.
      if (this.initResult?.agentCapabilities?.loadSession !== true) {
        throw new AcpError('resume_unsupported', `acp: agent "${this.def.id}" does not advertise the loadSession capability; start a new session`)
      }
      const conn = this.conn
      if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
      // The cwd was validated when the session was created, but allowed roots
      // may have narrowed since; re-check before handing the path back.
      const resolved = resolveSessionCwd(this.def, session.cwd, p => realpathSync(p))
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
    await conn.agent.request(methods.agent.session.setMode, { sessionId: session.acpSessionId, modeId })
    // Well-behaved agents push `current_mode_update`, but the spec does not
    // require it — apply locally so the browser selector never goes stale.
    if (session.modes !== undefined) session.modes = { ...session.modes, currentModeId: modeId }
    this.publishMeta(session)
  }

  async setConfigOption(session: LiveSession, configId: string, value: string | boolean): Promise<void> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
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
    if (child === undefined || child.pid === undefined) return
    try {
      child.stdin?.end()
    } catch { /* already gone */ }
    const victim = process.platform === 'win32' ? () => { child.kill('SIGTERM') } : () => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    victim()
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const pid = child.pid
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else if (pid !== undefined) process.kill(-pid, 'SIGKILL')
      } catch { /* already gone */ }
    }, 3000).unref()
  }

  /** Permission requests are answered per the agent's policy; `ask` parks them on the ledger. */
  private async handlePermissionRequest(acpSessionId: string, toolCall: unknown, options: PermissionOption[]): Promise<RequestPermissionResponse> {
    const session = this.acpIndex.get(acpSessionId)
    const policy = this.def.permission ?? 'ask'
    if (policy === 'allow') {
      const allow = options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind === 'allow_always')
      if (allow !== undefined) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      return { outcome: { outcome: 'cancelled' } }
    }
    if (policy === 'reject') {
      const reject = options.find(o => o.kind === 'reject_once') ?? options.find(o => o.kind === 'reject_always')
      if (reject !== undefined) return { outcome: { outcome: 'selected', optionId: reject.optionId } }
      return { outcome: { outcome: 'cancelled' } }
    }
    if (session === undefined || session.closed) return { outcome: { outcome: 'cancelled' } }
    return new Promise<RequestPermissionResponse>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const requestId = this.permissions.create(session.sessionId, (outcome: PermissionOutcome) => {
        clearTimeout(timer)
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

  /** `fs/write_text_file`; parent directories are created inside the sandbox. */
  private handleFsWrite(params: { sessionId: string; path: string; content: string }): { } {
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

function safeSpawnCwd(def: AcpAgentDef): string {
  if (def.cwd !== undefined) {
    try {
      return realpathSync(def.cwd)
    } catch { /* fall through to home */ }
  }
  return homedir()
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

export function detectHostAgents(configuredDefs: readonly AcpAgentDef[]): DetectedAgentInfo[] {
  return AGENT_PRESETS.map(preset => {
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
}

/** Routes host session ids to their owning bridge. */
export class BridgeManager {
  private readonly bridges = new Map<string, AgentBridge>()
  private readonly defsMap = new Map<string, AcpAgentDef>()

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
    return new AgentBridge(def, this.hub, this.transcriptMax, onConnectionLost, onCatalog, this.tuning)
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

  private loadPersistedAgents(): void {
    const filePath = this.getStoragePath()
    if (!filePath || !existsSync(filePath)) return
    try {
      const content = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          try {
            const def = validateAgentDef(item)
            this.defsMap.set(def.id, def)
          } catch {
            // Ignore invalid entry
          }
        }
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  private persistAgents(): void {
    const filePath = this.getStoragePath()
    if (!filePath) return
    try {
      const agents = [...this.defsMap.values()]
      writeFileSync(filePath, JSON.stringify(agents, null, 2), 'utf-8')
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
    this.notifyModelsChanged()
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
   * Failures stay silent: the catalog is advisory and the selector simply
   * shows the base entry until a probe succeeds.
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
   * Flat per-provider model list for the DSH selector: one base entry per
   * agent (the agent's own default model) plus one `agent@choice` variant per
   * cataloged model choice, narrowed by the agent's `exposedModels` filter
   * (unset → all choices; the base entry is never filtered out). Pure memory —
   * NEVER spawns; agents without a catalog merely get a lazy background probe
   * so the next refresh is full.
   */
  listAdapterModels(provider: string): LlmModelInfo[] {
    const out: LlmModelInfo[] = []
    for (const def of this.defsMap.values()) {
      const title = def.title ?? def.id
      out.push({
        provider,
        id: def.id,
        name: title,
        description: `ACP Agent: ${def.command} ${(def.args ?? []).join(' ')}`.trim(),
      })
      const entry = this.catalogs.get(def.id)
      if (entry === undefined) {
        this.ensureCatalog(def.id)
        continue
      }
      const exposed = def.exposedModels
      for (const choice of entry.catalog.model?.choices ?? []) {
        if (exposed !== undefined && !exposed.includes(choice.value)) continue
        out.push({
          provider,
          id: buildAdapterModelId(def.id, choice.value),
          name: `${title} · ${choice.name}`,
          ...(choice.description !== undefined ? { description: choice.description } : {}),
        })
      }
    }
    return out
  }

  /**
   * Resolve one catalog id for the DSH selector/validation. Unknown agents
   * throw (that is what turns `selectModel` into `model-unavailable`); known
   * agents NEVER throw — stale variants degrade to a bare-id entry so one
   * dead choice cannot sink the whole `acp` provider group in
   * `buildModelCatalog`.
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
    const defaultWorkspace = resolve(process.cwd(), 'acp-workspaces')
    const resolvedCwd = def.cwd ?? defaultWorkspace
    const resolvedRoots = (def.allowedCwdRoots && def.allowedCwdRoots.length > 0)
      ? def.allowedCwdRoots
      : [resolvedCwd, defaultWorkspace, process.cwd()]

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
    // A save is user-initiated: probe the model catalog immediately so the
    // chat selector fills in; a failing startup surfaces as a notice.
    void this.probeAgentModels(resolvedDef.id).catch((error: unknown) => {
      this.hub.broadcast({
        type: 'agent/notice',
        agentId: resolvedDef.id,
        level: 'error',
        text: `acp: model probe failed: ${describeError(error)}`,
      })
    })
    this.notifyModelsChanged()
  }

  /**
   * Lightweight model-visibility update: mutates the def in place (the live
   * bridge shares the same object, so nothing needs restarting), persists, and
   * republishes status. `undefined` clears the filter (expose every choice).
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
    this.notifyModelsChanged()
  }

  async deleteAgent(agentId: string): Promise<void> {
    if (this.bridges.has(agentId)) {
      await this.stopAgent(agentId)
      this.bridges.delete(agentId)
    }
    this.defsMap.delete(agentId)
    if (this.catalogs.delete(agentId)) this.persistCatalogs()
    this.persistAgents()
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: 'stopped',
    })
    this.notifyModelsChanged()
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

  private defaultModelSelection?: { provider: string; model: string }
  private defaultModelGetter?: () => { provider: string; model: string; reasoningEffort?: string } | undefined
  private defaultModelSetter?: (next: { provider: string; model: string }) => Promise<void>
  /** Announcement used after in-memory catalog mutations (see setModelsChangedHook). */
  private modelsChangedHook?: () => void

  setDefaultModelHooks(
    getter?: () => { provider: string; model: string; reasoningEffort?: string } | undefined,
    setter?: (next: { provider: string; model: string }) => Promise<void>,
  ): void {
    this.defaultModelGetter = getter
    this.defaultModelSetter = setter
  }

  /**
   * Register the announcement fired after in-memory catalog mutations. The
   * host entry re-commits the adapter's unchanged routes so the republished
   * `llm/adapters-updated` reaches open browsers, where chat model selectors
   * rebuild their directory — panel-side edits land without a page reload.
   */
  setModelsChangedHook(hook?: () => void): void {
    this.modelsChangedHook = hook
  }

  /** Advisory: a failed announcement must not fail the mutation itself. */
  private notifyModelsChanged(): void {
    try {
      this.modelsChangedHook?.()
    } catch {
      // The next full page load rebuilds the catalog anyway.
    }
  }

  async getDefaultModel(): Promise<{ provider?: string; model?: string }> {
    if (this.defaultModelGetter) {
      const current = this.defaultModelGetter()
      if (current) return { provider: current.provider, model: current.model }
    }
    return this.defaultModelSelection ?? {}
  }

  async setDefaultModel(agentId: string): Promise<void> {
    const selection = { provider: 'acp', model: agentId }
    this.defaultModelSelection = selection
    if (this.defaultModelSetter) {
      await this.defaultModelSetter(selection)
    }
  }

  private readonly dshSessionMap = new Map<string, LiveSession>()

  async getOrCreateDshSession(dshSessionId: string | undefined, agentId: string, cwd?: string): Promise<LiveSession> {
    const key = `${dshSessionId ?? 'ephemeral'}:${agentId}`
    const existing = this.dshSessionMap.get(key)
    if (existing !== undefined && !existing.closed && !existing.released) {
      return existing
    }
    // The session's agent died earlier: resume in place so the conversation
    // context survives via `session/load`.
    if (existing !== undefined && existing.released) {
      return this.bridge(agentId).resumeSession(existing)
    }
    const session = await this.bridge(agentId).createSession(cwd)
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

    if (session.running) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'acp: this session already has a prompt in flight', code: 'turn_in_flight' } },
      }
      return
    }

    // Same-agent model/effort switches ride the SAME ACP session (context
    // stays continuous); switching to another agent lands in a separate one
    // via the `${dshSessionId}:${agentId}` key in getOrCreateDshSession.
    await this.alignSessionConfig(session, choice, options.reasoningEffort)

    const userMessages = (options.messages ?? []).filter(m => m.role === 'user')
    const lastUserMsg = userMessages[userMessages.length - 1]
    const textBlocks = lastUserMsg?.content?.filter(b => b.type === 'text' && typeof b.text === 'string') ?? []
    const rawText = textBlocks.map(b => b.text).join('\n')
    const promptText = rawText.trim() !== '' ? rawText : 'Hello'

    const queue = new AsyncQueue<StreamChunk>()
    const bridge = this.bridge(agentId)
    session.running = true
    const turnId = randomUUID()
    this.hub.broadcast({ type: 'turn/start', sessionId: session.sessionId, turnId, text: promptText })

    let currentBlockIndex = -1
    let activeBlockType: 'reasoning' | 'text' | null = null
    let activeBlockText = ''
    let latestUsage: { inputTokens: number; outputTokens: number } | null = null

    const switchToBlock = (targetType: 'reasoning' | 'text') => {
      if (activeBlockType === targetType) return
      if (activeBlockType !== null) {
        queue.push({
          type: 'block-end',
          index: currentBlockIndex,
          block: { type: activeBlockType, text: activeBlockText },
        })
      }
      currentBlockIndex++
      activeBlockType = targetType
      activeBlockText = ''
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
          switchToBlock('reasoning')
          const title = String(update.title ?? update.toolCallId ?? 'tool')
          const line = `\n> 🛠️ [Tool: ${title}]\n`
          activeBlockText += line
          queue.push({ type: 'reasoning-delta', index: currentBlockIndex, text: line })
        } else if (kind === 'tool_call_update') {
          const lines = updateContentToLines(update.content)
          if (lines.length > 0) {
            switchToBlock('reasoning')
            const text = lines.map(l => `> ${l}`).join('\n') + '\n'
            activeBlockText += text
            queue.push({ type: 'reasoning-delta', index: currentBlockIndex, text })
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
          block: { type: activeBlockType, text: activeBlockText },
        })
        activeBlockType = null
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

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.manager.listAdapterModels(provider)
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

function updateContentToLines(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (row.type === 'content') {
      const inner = row.content as Record<string, unknown> | undefined
      if (inner?.type === 'text' && typeof inner.text === 'string') out.push(inner.text)
      else if (inner?.type === 'diff') out.push(`diff ${String(inner.path ?? '')}`)
      else out.push(`[${String(inner?.type ?? 'content')}]`)
    } else if (row.type === 'terminal') {
      out.push(`[terminal ${String(row.terminalId ?? '')}]`)
    }
  }
  return out
}

/**
 * JSON-RPC errors often carry the actionable detail in `data` (e.g. pi-acp
 * reports { errorKind: 'billing_error', message: '…' } while `message` is the
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
