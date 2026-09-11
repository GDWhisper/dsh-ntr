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
import { delimiter, join, resolve } from 'node:path'
import { Writable, Readable } from 'node:stream'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
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
  childEnv,
  randomUUID,
  resolveSessionCwd,
  validateAgentDef,
} from './impl.ts'
import type {
  AcpAgentDef, AgentView, DetectedAgentInfo, GenerateOptions, LlmAdapterLike, LlmModelInfo, LlmProviderInfo,
  LlmResolvedModelInfo, PermissionMode, PermissionOutcome, PermissionOptionView, PreparedAdapterCall, SessionView, StreamChunk,
} from './protocol.ts'

const STDERR_TAIL_LINES = 40

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
  transcript: Transcript
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
  readonly permissions = new PermissionLedger()

  constructor(
    readonly def: AcpAgentDef,
    private readonly hub: EventHub,
    private readonly transcriptMax: number,
    /** Called when the connection dies so the manager can settle outstanding prompts. */
    private readonly onConnectionLost: (bridge: AgentBridge, reason: string) => void,
  ) {}

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
      this.noteStderr(`spawn error: ${error.message}`)
      if (this.state !== 'stopped') this.onConnectionLost(this, `spawn error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
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
    const conn = app.connect(stream)
    this.conn = conn
    void conn.closed.then(() => {
      if (this.conn === conn && (this.state === 'ready')) {
        this.onConnectionLost(this, 'ACP connection closed')
      }
    })
    const init = await conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dsh-ntr', title: 'DSH NTR', version: '0.1.0' },
    })
    this.initResult = init
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
    const result = await conn.agent.request(methods.agent.session.new, { cwd: resolved, mcpServers: [] })
    const session: LiveSession = {
      sessionId: randomUUID(),
      agentId: this.def.id,
      acpSessionId: result.sessionId,
      cwd: resolved,
      running: false,
      closed: false,
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
   * Fire one prompt turn. Returns after the agent settles the turn; the caller
   * (manager) keeps the UI informed through broadcast events, so the RPC that
   * started the turn can answer `accepted` immediately.
   */
  async runPrompt(session: LiveSession, text: string, turnId: string): Promise<string> {
    const conn = this.conn
    if (conn === undefined || session.closed) throw new AcpError('session_closed', 'acp: session is closed')
    const result = await conn.agent.request(methods.agent.session.prompt, {
      sessionId: session.acpSessionId,
      prompt: [{ type: 'text', text }],
    })
    return result.stopReason
  }

  async cancel(session: LiveSession): Promise<void> {
    if (this.conn === undefined) return
    await this.conn.agent.notify(methods.agent.session.cancel, { sessionId: session.acpSessionId }).catch(() => { /* best effort */ })
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
      const requestId = this.permissions.create(session.sessionId, (outcome: PermissionOutcome) => {
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
  ) {
    for (const def of defs) {
      this.defsMap.set(def.id, def)
    }
    this.loadPersistedAgents()
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

  private bridge(agentId: string): AgentBridge {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    let bridge = this.bridges.get(agentId)
    if (bridge === undefined) {
      bridge = new AgentBridge(def, this.hub, this.transcriptMax, (b, reason) => {
        this.connectionLost(b, reason)
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

  private connectionLost(bridge: AgentBridge, reason: string): void {
    for (const session of bridge.sessionList) {
      if (session.running) {
        this.hub.broadcast({ type: 'turn/end', sessionId: session.sessionId, turnId: '', error: reason })
        session.running = false
      }
    }
    void bridge.stop('agent-died')
  }

  agentViews(): AgentView[] {
    return [...this.defsMap.values()].map(def => (this.bridges.get(def.id) ?? new AgentBridge(def, this.hub, this.transcriptMax, () => { /* pre-spawn */ })).view())
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
  }

  async deleteAgent(agentId: string): Promise<void> {
    if (this.bridges.has(agentId)) {
      await this.stopAgent(agentId)
      this.bridges.delete(agentId)
    }
    this.defsMap.delete(agentId)
    this.persistAgents()
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: 'stopped',
    })
  }

  async startSession(agentId: string, cwd: string | undefined): Promise<{ sessionId: string }> {
    const session = await this.bridge(agentId).createSession(cwd)
    return { sessionId: session.sessionId }
  }

  async prompt(sessionId: string, text: string): Promise<{ turnId: string }> {
    const { bridge, session } = this.find(sessionId)
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
    const { bridge, session } = this.find(sessionId)
    await bridge.cancel(session)
  }

  async closeSession(sessionId: string): Promise<void> {
    const { bridge, session } = this.find(sessionId)
    await bridge.closeSession(session, 'closed')
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const { bridge, session } = this.find(sessionId)
    await bridge.setMode(session, modeId)
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    const { bridge, session } = this.find(sessionId)
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
    const { session } = this.find(sessionId)
    return { session: snapshot(session), entries: session.transcript.since(afterSeq ?? 0) }
  }

  sessions(): unknown[] {
    return [...this.bridges.values()].flatMap(b => b.sessionList.map(snapshot))
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

  setDefaultModelHooks(
    getter?: () => { provider: string; model: string; reasoningEffort?: string } | undefined,
    setter?: (next: { provider: string; model: string }) => Promise<void>,
  ): void {
    this.defaultModelGetter = getter
    this.defaultModelSetter = setter
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
    if (existing !== undefined && !existing.closed) {
      return existing
    }
    const session = await this.bridge(agentId).createSession(cwd)
    this.dshSessionMap.set(key, session)
    return session
  }

  async *streamPrompt(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const agentId = options.model
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
    return this.manager.agentViews().map(a => ({
      provider,
      id: a.id,
      name: a.title || a.id,
      description: `ACP Agent: ${a.command} ${(a.args ?? []).join(' ')}`.trim(),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const agent = this.manager.agentViews().find(a => a.id === model)
    return {
      provider,
      id: model,
      name: agent?.title ?? model,
      description: agent ? `ACP Agent: ${agent.command} ${(agent.args ?? []).join(' ')}`.trim() : undefined,
    }
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
