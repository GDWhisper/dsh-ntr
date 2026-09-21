/**
 * Browser-side state store for the ACP panel. Owns: the `/acp` RPC calls, the
 * `/api/acp/stream` EventSource, per-session block folding (raw ACP
 * `session/update` → render blocks), and the pending permission set.
 *
 * Deliberately framework-free: React binds through `useSyncExternalStore`.
 */

import type { AcpEvent, AcpPresetStatus, AgentCatalogResult, AgentProbeModelsResult, AgentSavePayload, AgentTestResult, AgentView, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, SessionView } from '../protocol.ts'

/** The unary RPC face (narrowed `ctx.connection.rpc.call`). */
export type RpcCall = (channel: string, endpoint: string, payload: unknown) => Promise<
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }
>

export type Block =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; messageId?: string; text: string }
  | { kind: 'thought'; text: string }
  | {
    kind: 'tool'
    toolCallId: string
    title: string
    status: string
    toolKind?: string
    lines: string[]
    /**
     * Structured ACP diffs (`content: [{type:'diff'}]`). Kept apart from
     * {@link lines} because a diff is the one tool payload worth rendering as
     * a diff: flattening it to `diff <path>` throws away everything that makes
     * an edit reviewable.
     */
    diffs?: Array<{ path: string; oldText: string | null; newText: string }>
    raw?: string
  }
  | { kind: 'plan'; entries: Array<{ content: string; status: string; priority?: string }> }
  | { kind: 'notice'; tone: 'info' | 'error'; text: string }

export interface PendingPermission {
  requestId: string
  sessionId: string
  title: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

/**
 * One observed ACP transcript, keyed by ACP session id. This is the ACP view
 * tab's data source: the native chat plane can only render text/reasoning
 * (that is the LLM adapter's entire chunk vocabulary), so the real tool calls,
 * plans and diffs live here and nowhere else.
 */
export interface ChatTranscript {
  /** The DSH chat session this ACP session belongs to (its refetch address). */
  owner: string
  session: SessionView
  blocks: Block[]
  /** Highest folded transcript seq (gap detection for the live stream). */
  seq: number
}

export interface UiState {
  open: boolean
  stream: 'init' | 'live' | 'down'
  agents: AgentView[]
  sessions: SessionView[]
  activeSessionId?: string
  blocks: Block[]
  permissions: PendingPermission[]
  busy: boolean
  notice?: string
  defaultModel?: string
  detectedAgents: DetectedAgentInfo[]
  detecting: boolean
  /** Probed model catalogs per agent id (from `agent/probe-models`). */
  modelCatalogs: Record<string, AgentProbeModelsResult>
  /**
   * Per-agent ACP model surfaces (from `agent/catalog`) — the data source for
   * the conversation-side chips and the ACP-mode model seat. Kept apart from
   * {@link modelCatalogs} on purpose: that one is the panel's full probe
   * result (every choice an agent published), while this is the filtered,
   * ready-to-render list the seats offer.
   */
  seatCatalogs: Record<string, AgentCatalogResult>
  probingModels: Record<string, boolean>
  /**
   * Last probe failure per agent id, rendered next to the button that
   * triggered it. `notice` alone is not enough: it lives at the top of the
   * settings panel, so a probe failing below the fold (missing cwd, an agent
   * that never answers, …) reads as a dead button.
   */
  probeErrors: Record<string, string>
  /**
   * Host reports that permission asks are answered through the native
   * approval chain (chat composer). When true the settings panel must not
   * render the permission card — the question is already in the conversation.
   * False on an older host or when the approval service is unavailable, in
   * which case the panel keeps the ledger fallback.
   */
  approvalRouted: boolean
  /**
   * True when a chat-backed session's DSH access mode (the composer's Access
   * mode control) governs its permission asks and fs writes. The agent-level
   * `permission` field then only applies to sessions without a chat binding,
   * which is what the panel says out loud instead of silently disagreeing with
   * the control the user actually sees while chatting.
   */
  accessModeRouted: boolean
  /**
   * ACP agent sessions backing the chat session the composer control sits in.
   * Only meaningful together with {@link chatSessionsFor}: the control reads it
   * by chat session id, so a stale list from another conversation never renders.
   */
  chatSessions: ChatSessionView[]
  /** The DSH chat session id {@link chatSessions} was loaded for. */
  chatSessionsFor?: string
  /**
   * Per-chat-session "does this conversation run the ACP preset" verdicts, as
   * reported by `session/chat-list` (host-read from the session log). The
   * model-seat gate falls back to this when the client runtime's session rows
   * carry no `agentPreset` (older hosts); a session never asked about is simply
   * absent.
   */
  acpMode: Record<string, boolean>
  /**
   * Observed ACP transcripts keyed by ACP session id. Only sessions the
   * conversation's ACP view asked for are watched (live `session/update`
   * frames fold straight into them), and the map is capped so a long browsing
   * session cannot accumulate every transcript it ever looked at.
   */
  chatTranscripts: Record<string, ChatTranscript>
  /**
   * Install state of the host's ACP-mode agent preset (the roster entry the
   * new-session chip shows). `undefined` on an older host half that serves no
   * `preset/status`, in which case the panel hides the block entirely.
   */
  preset?: AcpPresetStatus
  /** True while a preset install/repair round-trip is in flight. */
  presetInstalling: boolean
}

interface Listener { (): void }

const MAX_BLOCKS = 400
/** How many observed ACP transcripts stay live at once (insertion-ordered eviction). */
const MAX_WATCHED = 6

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

export const DEFAULT_KNOWN_PRESETS: DetectedAgentInfo[] = [
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    description: 'Automata / Pi Coding Agent with native ACP bridge support',
    detected: false,
    defaultCommand: 'pi-acp',
    defaultArgs: [],
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    description: 'Oh My Pi (pi-based coding agent) — run as `omp acp` over stdio',
    detected: false,
    defaultCommand: 'omp',
    defaultArgs: ['acp'],
  },
]

export class AcpStore {
  private state: UiState = {
    open: false,
    stream: 'init',
    agents: [],
    sessions: [],
    blocks: [],
    permissions: [],
    busy: false,
    detectedAgents: [...DEFAULT_KNOWN_PRESETS],
    detecting: false,
    modelCatalogs: {},
    seatCatalogs: {},
    probingModels: {},
    probeErrors: {},
    approvalRouted: false,
    accessModeRouted: false,
    chatSessions: [],
    chatTranscripts: {},
    acpMode: {},
    presetInstalling: false,
  }

  private readonly listeners = new Set<Listener>()
  private source?: EventSource
  private readonly lastSeq = new Map<string, number>()
  /** Sessions with a finalized turn (dedups the cancel-fallback + late real turn/end pair). */
  private readonly openTurns = new Set<string>()
  /** In-flight `session/chat-list` reads, keyed by chat session id. */
  private readonly chatSessionReads = new Set<string>()
  /** In-flight `agent/catalog` reads, keyed by agent id. */
  private readonly seatCatalogReads = new Set<string>()

  constructor(private readonly rpc: RpcCall, private readonly locale: (zh: string, en: string) => string) {}

  // ---- React bridge ----

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): UiState {
    return this.state
  }

  private mutate(patch: Partial<UiState>, blocksChanged = false): void {
    this.state = {
      ...this.state,
      ...patch,
      blocks: blocksChanged ? [...this.state.blocks] : patch.blocks ?? this.state.blocks,
    }
    for (const listener of [...this.listeners]) listener()
  }

  // ---- Transport ----

  /** Open the shared event stream once; schedule first snapshot fetch. */
  start(): void {
    if (this.source !== undefined) return
    this.connectStream()
  }

  private connectStream(): void {
    const source = new EventSource('/api/acp/stream')
    source.onopen = () => {
      void this.resync()
      this.mutate({ stream: 'live' })
    }
    source.onerror = () => {
      this.mutate({ stream: 'down' })
    }
    source.onmessage = raw => {
      let event: AcpEvent
      try {
        event = JSON.parse(String(raw.data)) as AcpEvent
      } catch {
        return
      }
      void this.applyEvent(event)
    }
    this.source = source
  }

  private async call<T>(endpoint: string, payload: unknown = {}): Promise<T> {
    const result = await this.rpc('/acp', endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }

  /** Snapshot refresh used on panel open and after a stream outage. */
  async resync(): Promise<void> {
    try {
      const [{ agents, approvalRouted, accessModeRouted }, { sessions }, defaultModelInfo, detectResult, presetResult] = await Promise.all([
        this.call<{ agents: AgentView[]; approvalRouted?: boolean; accessModeRouted?: boolean }>('agents/list'),
        this.call<{ sessions: SessionView[] }>('sessions/list'),
        this.call<{ provider?: string; model?: string }>('model/get-default').catch(() => ({} as { provider?: string; model?: string })),
        this.call<{ agents: DetectedAgentInfo[] }>('agents/detect').catch(() => null),
        // Absent on an older host half: `null` hides the panel block.
        this.call<{ preset: AcpPresetStatus | null }>('preset/status').catch(() => null),
      ])
      const defaultModel = defaultModelInfo?.provider === 'acp' ? defaultModelInfo.model : undefined
      const detectedAgents = (detectResult && detectResult.agents.length > 0)
        ? detectResult.agents
        : (this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS])
      // Absent on an older host: keep the settings-panel card (degraded path).
      this.mutate({
        agents,
        sessions,
        defaultModel,
        detectedAgents,
        approvalRouted: approvalRouted === true,
        accessModeRouted: accessModeRouted === true,
        preset: presetResult?.preset ?? undefined,
      })
      const active = this.state.activeSessionId ?? sessions[0]?.sessionId
      if (active !== undefined) await this.loadTranscript(active)
    } catch (error) {
      this.mutate({ notice: String(error instanceof Error ? error.message : error) })
    }
  }

  async detectAgents(): Promise<void> {
    this.mutate({ detecting: true })
    try {
      const result = await this.call<{ agents: DetectedAgentInfo[] }>('agents/detect')
      this.mutate({
        detectedAgents: result.agents.length > 0 ? result.agents : [...DEFAULT_KNOWN_PRESETS],
        detecting: false,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agents/detect')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活主机检测功能。', 'Host running older version. Please restart dsh web to enable agent detection.')
        : msg
      this.mutate({
        detecting: false,
        notice,
        detectedAgents: this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS],
      })
    }
  }

  async saveAgent(payload: AgentSavePayload): Promise<void> {
    try {
      await this.call('agent/save', payload)
      await this.resync()
      // The host probes the catalog right after a save; pull the fresh result
      // so the agent card fills in without a second click.
      void this.probeModels(payload.id)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /**
   * Dry-run the connection form: the host spawns a throwaway process from
   * these exact values, handshakes, and tears it down. A reachable-but-broken
   * agent arrives as `{ ok: false }`, not a thrown error; only transport or
   * validation failures reject.
   */
  async testAgent(payload: AgentSavePayload): Promise<AgentTestResult> {
    try {
      return await this.call<AgentTestResult>('agent/test', payload)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/test')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用连接测试功能。', 'Host running older version. Please restart dsh web to enable connection testing.')
        : msg
      this.mutate({ notice })
      throw error
    }
  }

  /** Ask the host to probe one agent's model catalog (spawn + throwaway session). */
  async probeModels(agentId: string): Promise<void> {
    const previousError = this.state.probeErrors[agentId]
    this.mutate({
      probingModels: { ...this.state.probingModels, [agentId]: true },
      probeErrors: this.clearProbeError(agentId),
    })
    try {
      const result = await this.call<AgentProbeModelsResult>('agent/probe-models', { agentId })
      // The seat list is a filtered view of the same catalog: drop the cached
      // one (in the same patch) and re-read below, so a fresh probe lands in an
      // open conversation too.
      const seatCatalogs = { ...this.state.seatCatalogs }
      delete seatCatalogs[agentId]
      this.mutate({
        modelCatalogs: { ...this.state.modelCatalogs, [agentId]: result },
        seatCatalogs,
        probingModels: { ...this.state.probingModels, [agentId]: false },
        // A retry after the user fixed the problem must not leave the old
        // failure pinned at the top of the panel. Only drop the notice when it
        // is still ours — anything newer belongs to someone else.
        ...(previousError !== undefined && this.state.notice === previousError ? { notice: undefined } : {}),
      })
      void this.loadAgentCatalog(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/probe-models')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活模型检测功能。', 'Host running older version. Please restart dsh web to enable model detection.')
        : msg
      this.mutate({
        notice,
        probingModels: { ...this.state.probingModels, [agentId]: false },
        probeErrors: { ...this.state.probeErrors, [agentId]: notice },
      })
    }
  }

  private clearProbeError(agentId: string): Record<string, string> {
    if (this.state.probeErrors[agentId] === undefined) return this.state.probeErrors
    const next = { ...this.state.probeErrors }
    delete next[agentId]
    return next
  }

  /**
   * Read one agent's ACP model surface (`agent/catalog`) — what the composer
   * chips and the ACP-mode model seat render. Cached per agent, because the
   * list only changes when the agent's catalog is re-probed or its exposure
   * filter is edited (both of which drop the cache below), and deduped because
   * every ACP surface asks for it on mount.
   *
   * The host answers from memory, so this is safe to call from a render effect;
   * a probe it may trigger runs in the background on the host side.
   */
  async loadAgentCatalog(agentId: string): Promise<void> {
    if (this.state.seatCatalogs[agentId] !== undefined || this.seatCatalogReads.has(agentId)) return
    this.seatCatalogReads.add(agentId)
    try {
      const result = await this.call<AgentCatalogResult>('agent/catalog', { agentId })
      this.mutate({ seatCatalogs: { ...this.state.seatCatalogs, [agentId]: result } })
    } catch {
      // An older host half, or an agent that was deleted meanwhile: the seats
      // fall back to the roster's own title and the bare agent route, which is
      // exactly what they show before a catalog exists.
    } finally {
      this.seatCatalogReads.delete(agentId)
    }
  }

  /** Drop one agent's cached seat catalog (its model surface just changed). */
  private invalidateSeatCatalog(agentId: string): void {
    if (this.state.seatCatalogs[agentId] === undefined) return
    const next = { ...this.state.seatCatalogs }
    delete next[agentId]
    this.mutate({ seatCatalogs: next })
  }

  /**
   * Persist the ACP-seat model filter for one agent. `undefined` clears the
   * filter — same as an empty list, i.e. no `agentId@choice` variants, only
   * the agent's base entry. Uses the dedicated lightweight RPC so the agent
   * process and its live sessions are never restarted.
   */
  async setExposedModels(agentId: string, exposedModels: string[] | undefined): Promise<void> {
    try {
      await this.call('agent/set-exposed-models', {
        agentId,
        ...(exposedModels === undefined ? {} : { exposedModels }),
      })
      await this.resync()
      // The seats render the filtered list, so an edited filter has to be
      // re-read or the open conversation keeps offering the old set.
      this.invalidateSeatCatalog(agentId)
      void this.loadAgentCatalog(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/set-exposed-models')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用模型筛选功能。', 'Host running older version. Please restart dsh web to enable model filtering.')
        : msg
      this.mutate({ notice })
      throw error
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.call('agent/delete', { agentId })
      await this.resync()
      // Nothing should keep offering a deleted agent's models (a conversation
      // that was routed to it falls back to its roster entry).
      this.invalidateSeatCatalog(agentId)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  // ---- Panel lifecycle ----

  toggle(): void {
    const nextOpen = !this.state.open
    this.mutate({ open: nextOpen })
    if (nextOpen) {
      this.start()
      void this.resync()
    }
  }

  close(): void {
    this.mutate({ open: false })
  }

  selectSession(sessionId: string): void {
    this.mutate({ activeSessionId: sessionId })
    void this.loadTranscript(sessionId)
  }

  private async loadTranscript(sessionId: string): Promise<void> {
    try {
      const { session, entries } = await this.call<{ session: SessionView; entries: Array<{ seq: number; update: Record<string, unknown> }> }>(
        'transcript/get',
        { sessionId },
      )
      const blocks: Block[] = []
      for (const entry of entries) {
        const before = blocks.length
        foldUpdate(blocks, entry.update)
        this.lastSeq.set(sessionId, Math.max(this.lastSeq.get(sessionId) ?? 0, entry.seq))
        void before
      }
      const sessions = this.state.sessions.some(s => s.sessionId === sessionId)
        ? this.state.sessions.map(s => (s.sessionId === sessionId ? session : s))
        : [...this.state.sessions, session]
      this.mutate({ sessions, blocks, activeSessionId: sessionId })
    } catch {
      this.mutate({ blocks: [] })
    }
  }

  // ---- Actions ----

  async startSession(agentId: string, cwd?: string): Promise<void> {
    try {
      const { sessionId } = await this.call<{ sessionId: string }>('session/start', { agentId, ...(cwd === undefined || cwd === '' ? {} : { cwd }) })
      await this.resync()
      this.selectSession(sessionId)
    } catch (error) {
      this.flashError(error)
    }
  }

  async sendPrompt(text: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined || text.trim() === '') return
    this.mutate({ busy: true })
    try {
      await this.call('session/prompt', { sessionId, text })
    } catch (error) {
      this.flashError(error)
    } finally {
      this.mutate({ busy: false })
    }
  }

  async cancelActive(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/cancel', { sessionId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async closeActive(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/close', { sessionId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async setMode(modeId: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/mode-set', { sessionId, modeId })
    } catch (error) {
      this.flashError(error)
    }
  }

  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   */
  async loadChatSessions(dshSessionId: string): Promise<void> {
    // Two composer entries read this (the agent-mode control and the ACP
    // cluster) and both re-read when a turn settles; one round-trip answers
    // for both instead of two racing ones.
    if (this.chatSessionReads.has(dshSessionId)) return
    this.chatSessionReads.add(dshSessionId)
    try {
      const { sessions, acpMode } = await this.call<{ sessions: ChatSessionView[]; acpMode?: boolean }>('session/chat-list', { dshSessionId })
      this.mutate({
        chatSessions: sessions,
        chatSessionsFor: dshSessionId,
        // The seat gate's fallback fact source: absent on an older host half,
        // which then simply never takes the seat over (the allowed failure).
        ...(acpMode === undefined ? {} : { acpMode: { ...this.state.acpMode, [dshSessionId]: acpMode === true } }),
      })
    } catch {
      // A host without this surface (older build) has nothing to show; the
      // control simply renders nothing rather than an error nobody can act on.
      this.mutate({ chatSessions: [], chatSessionsFor: dshSessionId })
    } finally {
      this.chatSessionReads.delete(dshSessionId)
    }
  }

  /**
   * Drop one chat session's ACP-mode verdict — or the whole map. The preset
   * switch a session committed is announced by the host (`agent-preset/selected`)
   * and folded by the runtime into its own rows, but NOT into this map, so the
   * gate re-asks instead of trusting a verdict the session log has moved past.
   */
  invalidateAcpMode(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      if (Object.keys(this.state.acpMode).length === 0) return
      this.mutate({ acpMode: {} })
      return
    }
    if (this.state.acpMode[dshSessionId] === undefined) return
    const acpMode = { ...this.state.acpMode }
    delete acpMode[dshSessionId]
    this.mutate({ acpMode })
  }

  /**
   * Switch the ACP agent's own mode for one chat session (`session/set_mode`),
   * then re-read the binding so the control reflects what the agent actually
   * reports (a rejected switch must not leave an optimistic lie on screen).
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-mode-set', { dshSessionId, modeId, ...(agentId === undefined ? {} : { agentId }) })
    } catch (error) {
      this.flashError(error)
    }
    await this.loadChatSessions(dshSessionId)
  }

  // ---- ACP transcript observation (the conversation's ACP view) ----

  /**
   * Start (or refresh) observation of every ACP transcript behind one DSH chat
   * session. Blocks are rebuilt from scratch — the host buffer is the record,
   * and this view is the only consumer that needs the raw agent stream.
   */
  async loadChatTranscript(dshSessionId: string): Promise<void> {
    let views: ChatTranscriptView[]
    try {
      ({ views } = await this.call<{ views: ChatTranscriptView[] }>(
        'session/chat-transcript',
        { dshSessionId },
      ))
    } catch {
      // An older host half (or a session with no ACP binding): nothing to
      // observe, and no error worth flashing for a read-only side view.
      return
    }
    // Everything this chat session used to have, minus what it still has: a
    // closed or replaced ACP session must not linger as a ghost tab body.
    const merged: Record<string, ChatTranscript> = {}
    for (const [id, record] of Object.entries(this.state.chatTranscripts)) {
      if (record.owner !== dshSessionId) merged[id] = record
    }
    for (const view of views) {
      const blocks: Block[] = []
      for (const entry of view.entries) foldUpdate(blocks, entry.update as Record<string, unknown>)
      merged[view.session.sessionId] = {
        owner: dshSessionId,
        session: view.session,
        blocks,
        seq: view.entries.length > 0 ? view.entries[view.entries.length - 1]?.seq ?? 0 : 0,
      }
    }
    this.mutate({ chatTranscripts: this.evictTranscripts(merged) })
  }

  /** Observed transcript for one ACP session id (undefined → nobody is watching it). */
  transcriptOf(acpSessionId: string): ChatTranscript | undefined {
    return this.state.chatTranscripts[acpSessionId]
  }

  /** The observed transcript of one chat session (the live binding wins over a released one). */
  chatTranscriptOf(dshSessionId: string): ChatTranscript | undefined {
    const owned = Object.values(this.state.chatTranscripts).filter(record => record.owner === dshSessionId)
    return owned.find(record => !record.session.released) ?? owned[0]
  }

  /** Keep the resident transcript map at its bound, newest insertion first. */
  private evictTranscripts(map: Record<string, ChatTranscript>): Record<string, ChatTranscript> {
    const ids = Object.keys(map)
    if (ids.length <= MAX_WATCHED) return map
    const out: Record<string, ChatTranscript> = {}
    for (const id of ids.slice(ids.length - MAX_WATCHED)) {
      const value = map[id]
      if (value !== undefined) out[id] = value
    }
    return out
  }

  /**
   * Apply one live frame to an observed transcript. Returns the next map, or
   * `undefined` when nobody is watching that session, so callers fold it into
   * their own state patch instead of mutating twice.
   */
  private foldWatched(sessionId: string, update: (record: ChatTranscript) => ChatTranscript): Record<string, ChatTranscript> | undefined {
    const current = this.state.chatTranscripts[sessionId]
    if (current === undefined) return undefined
    const next = update(current)
    return { ...this.state.chatTranscripts, [sessionId]: { ...next, blocks: [...next.blocks] } }
  }

  /** Re-publish an observed transcript's session snapshot (mode / released flips). */
  private watchedSessionPatch(sessionId: string, session: SessionView): { chatTranscripts?: Record<string, ChatTranscript> } {
    const current = this.state.chatTranscripts[sessionId]
    if (current === undefined) return {}
    return { chatTranscripts: { ...this.state.chatTranscripts, [sessionId]: { ...current, session } } }
  }

  /** Mirror the running flag onto a transcript the ACP view is showing. */
  private markWatchedRunning(sessionId: string, running: boolean): void {
    const current = this.state.chatTranscripts[sessionId]
    if (current === undefined || current.session.running === running) return
    this.mutate({
      chatTranscripts: {
        ...this.state.chatTranscripts,
        [sessionId]: { ...current, session: { ...current.session, running } },
      },
    })
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/config-set', { sessionId, configId, value })
    } catch (error) {
      this.flashError(error)
    }
  }

  async respondPermission(requestId: string, optionId?: string): Promise<void> {
    try {
      await this.call('permission/respond', { requestId, ...(optionId === undefined ? {} : { optionId }) })
    } catch (error) {
      this.flashError(error)
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    try {
      await this.call('agent/stop', { agentId })
      await this.resync()
    } catch (error) {
      this.flashError(error)
    }
  }

  async setDefaultModel(agentId: string): Promise<void> {
    try {
      await this.call('model/set-default', { agentId })
      this.mutate({ defaultModel: agentId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async setPermission(agentId: string, permission: 'ask' | 'allow' | 'reject'): Promise<void> {
    try {
      await this.call('agent/set-permission', { agentId, permission })
      await this.resync()
    } catch (error) {
      this.flashError(error)
    }
  }

  /**
   * Install or repair the ACP-mode agent preset in the roster's user root.
   * Idempotent and non-destructive on the host side (existing files win), so
   * the button is safe to press when the preset already looks healthy.
   */
  async installPreset(): Promise<void> {
    this.mutate({ presetInstalling: true })
    try {
      const result = await this.call<{ preset: AcpPresetStatus | null }>('preset/install')
      this.mutate({ preset: result.preset ?? undefined })
    } catch (error) {
      this.flashError(error)
    } finally {
      this.mutate({ presetInstalling: false })
    }
  }

  label(zh: string, en: string): string {
    return this.locale(zh, en)
  }

  clearNotice(): void {
    this.mutate({ notice: undefined })
  }

  private flashError(error: unknown): void {
    this.mutate({ notice: error instanceof Error ? error.message : String(error) })
  }

  // ---- Event application ----

  private applyEvent(event: AcpEvent): Promise<void> {
    switch (event.type) {
      case 'agent/notice': {
        this.mutate({ notice: event.text })
        return Promise.resolve()
      }
      case 'agent/status': {
        if (event.agent !== undefined) {
          const agents = this.state.agents.some(a => a.id === event.agent?.id)
            ? this.state.agents.map(a => (a.id === event.agent?.id ? event.agent : a))
            : [...this.state.agents, event.agent]
          this.mutate({ agents })
        } else {
          this.mutate({})
        }
        return Promise.resolve()
      }
      case 'session/created': {
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        this.mutate({ sessions, activeSessionId: this.state.activeSessionId ?? event.sessionId })
        return Promise.resolve()
      }
      case 'session/meta': {
        // Host re-published the session view after mode/config changes.
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : this.state.sessions
        this.mutate({ sessions, ...this.watchedSessionPatch(event.sessionId, event.session) })
        return Promise.resolve()
      }
      case 'session/closed': {
        const sessions = this.state.sessions.filter(s => s.sessionId !== event.sessionId)
        const active = this.state.activeSessionId === event.sessionId ? sessions[0]?.sessionId : this.state.activeSessionId
        this.openTurns.delete(event.sessionId)
        const closedTranscripts = { ...this.state.chatTranscripts }
        delete closedTranscripts[event.sessionId]
        this.mutate({
          sessions,
          activeSessionId: active,
          chatTranscripts: closedTranscripts,
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          ...(event.reason === 'agent-died' ? { notice: this.locale('会话因 agent 进程退出而终止', 'session ended: agent process died') } : {}),
        })
        return Promise.resolve()
      }
      case 'session/released': {
        // The agent process died: keep the session visible (marked released)
        // instead of dropping it — the next prompt resumes it via session/load.
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        this.openTurns.delete(event.sessionId)
        this.mutate({
          sessions,
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          // An observed transcript keeps its buffer but flips to released, so
          // the ACP view can say "会恢复" instead of silently looking dead.
          ...this.watchedSessionPatch(event.sessionId, event.session),
          notice: this.locale(
            'agent 进程已退出，会话已挂起；再次发送消息将自动恢复。',
            'agent process died; the session is paused and will resume on your next message.',
          ),
        })
        return Promise.resolve()
      }
      case 'session/reset': {
        // The session was resumed on a fresh process and the agent is about to
        // replay its history as fresh updates: drop local blocks and the seq
        // watermark so the replay folds in from a clean slate.
        this.lastSeq.set(event.sessionId, 0)
        this.openTurns.delete(event.sessionId)
        const isActive = event.sessionId === this.state.activeSessionId
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        // The agent is about to replay its whole history as fresh updates:
        // an observed transcript must drop both its blocks and its watermark
        // or the replay would be read as a gap and refetched forever.
        const watched = this.state.chatTranscripts[event.sessionId]
        this.mutate({
          sessions,
          ...(isActive ? { blocks: [] } : {}),
          ...(watched === undefined ? {} : {
            chatTranscripts: {
              ...this.state.chatTranscripts,
              [event.sessionId]: { ...watched, session: event.session, blocks: [], seq: 0 },
            },
          }),
        })
        return Promise.resolve()
      }
      case 'session/update': {
        const folded = this.foldWatched(event.sessionId, record => {
          foldUpdate(record.blocks, event.update as unknown as Record<string, unknown>)
          return { ...record, seq: event.seq }
        })
        if (event.sessionId !== this.state.activeSessionId) {
          // Background session: bump its seq bound; full refresh happens on select.
          this.lastSeq.set(event.sessionId, event.seq)
          if (folded !== undefined) this.mutate({ chatTranscripts: folded })
          return Promise.resolve()
        }
        const seen = this.lastSeq.get(event.sessionId)
        if (seen !== undefined && event.seq !== seen + 1) {
          void this.loadTranscript(event.sessionId) // gap detected → replay
          if (folded !== undefined) this.mutate({ chatTranscripts: folded })
          return Promise.resolve()
        }
        this.lastSeq.set(event.sessionId, event.seq)
        foldUpdate(this.state.blocks, event.update as unknown as Record<string, unknown>)
        this.mutate({ blocks: [...this.state.blocks], ...(folded === undefined ? {} : { chatTranscripts: folded }) })
        return Promise.resolve()
      }
      case 'permission/request': {
        const title = typeof (event.toolCall as { title?: unknown } | undefined)?.title === 'string'
          ? String((event.toolCall as { title: string }).title)
          : this.locale('工具调用', 'tool call')
        this.mutate({
          permissions: [...this.state.permissions.filter(p => p.requestId !== event.requestId), {
            requestId: event.requestId,
            sessionId: event.sessionId,
            title,
            options: event.options,
          }],
        })
        return Promise.resolve()
      }
      case 'permission/resolved': {
        this.mutate({ permissions: this.state.permissions.filter(p => p.requestId !== event.requestId) })
        return Promise.resolve()
      }
      case 'turn/start': {
        this.openTurns.add(event.sessionId)
        this.markWatchedRunning(event.sessionId, true)
        if (event.sessionId === this.state.activeSessionId) {
          this.state.blocks.push({ kind: 'user', text: event.text })
          trimBlocks(this.state.blocks)
          this.mutate({ sessions: this.state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: true } : s)) })
        }
        return Promise.resolve()
      }
      case 'turn/end': {
        // One turn may end twice (force-finalized after an ignored cancel, or
        // settled by the host after a crash, then the real response arrives);
        // only the first turn/end per open turn is applied.
        if (!this.openTurns.has(event.sessionId)) return Promise.resolve()
        this.openTurns.delete(event.sessionId)
        this.markWatchedRunning(event.sessionId, false)
        if (event.sessionId === this.state.activeSessionId) {
          if (event.error !== undefined) {
            this.state.blocks.push({ kind: 'notice', tone: 'error', text: event.error })
          } else if (event.stopReason !== undefined && event.stopReason !== 'end_turn') {
            this.state.blocks.push({ kind: 'notice', tone: 'info', text: `stop: ${event.stopReason}` })
          }
          trimBlocks(this.state.blocks)
          this.mutate({ sessions: this.state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: false } : s)) })
        }
        return Promise.resolve()
      }
      default:
        return Promise.resolve()
    }
  }
}

/** Merge a raw ACP update into the block list (mutates in place). */
export function foldUpdate(blocks: Block[], update: Record<string, unknown>): void {
  const kind = String(update.sessionUpdate ?? '')
  const content = update.content as Record<string, unknown> | undefined
  switch (kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const targetKind = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'agent' : 'thought'
      const text = content?.type === 'text' && typeof content.text === 'string'
        ? content.text
        : content !== undefined ? `[${String(content.type)}]` : ''
      if (text === '') return
      const messageId = typeof update.messageId === 'string' ? update.messageId : undefined
      const last = blocks[blocks.length - 1]
      if (targetKind === 'agent' && last?.kind === 'agent' && ((messageId !== undefined && last.messageId === messageId) || (messageId === undefined && last.messageId === undefined))) {
        last.text += text
      } else if (targetKind !== 'agent' && last?.kind === targetKind) {
        last.text += text
      } else if (targetKind === 'agent') {
        blocks.push({ kind: 'agent', ...(messageId === undefined ? {} : { messageId }), text })
      } else {
        blocks.push({ kind: targetKind, text })
      }
      return
    }
    case 'tool_call': {
      const diffs = extractDiffs(update.content)
      blocks.push({
        kind: 'tool',
        toolCallId: String(update.toolCallId ?? ''),
        title: String(update.title ?? ''),
        status: String(update.status ?? 'pending'),
        ...(typeof update.kind === 'string' ? { toolKind: update.kind } : {}),
        lines: updateContentToLines(update.content),
        ...(diffs === undefined ? {} : { diffs }),
      })
      return
    }
    case 'tool_call_update': {
      const id = String(update.toolCallId ?? '')
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (block?.kind !== 'tool' || block.toolCallId !== id) continue
        if (typeof update.title === 'string' && update.title !== '') block.title = update.title
        if (typeof update.status === 'string') block.status = update.status
        const lines = updateContentToLines(update.content)
        if (lines.length > 0) block.lines = lines
        const diffs = extractDiffs(update.content)
        if (diffs !== undefined) block.diffs = diffs
        return
      }
      // Update for a tool call that rolled out of the transcript window.
      const diffs = extractDiffs(update.content)
      blocks.push({
        kind: 'tool',
        toolCallId: id,
        title: id,
        status: String(update.status ?? 'completed'),
        lines: updateContentToLines(update.content),
        ...(diffs === undefined ? {} : { diffs }),
      })
      return
    }
    case 'plan': {
      const entries = Array.isArray(update.entries)
        ? (update.entries as Array<Record<string, unknown>>).map(e => ({
          content: String(e.content ?? ''),
          status: String(e.status ?? 'pending'),
          ...(typeof e.priority === 'string' ? { priority: e.priority } : {}),
        }))
        : []
      const existing = [...blocks].reverse().find(b => b.kind === 'plan')
      if (existing !== undefined && existing.kind === 'plan') {
        existing.entries = entries
      } else {
        blocks.push({ kind: 'plan', entries })
      }
      return
    }
    default:
      // available_commands / modes / config / usage / session_info ride on the
      // SessionView snapshot, not the block stream.
      return
  }
}

/** Pull structured diff payloads out of one tool call's content array. */
function extractDiffs(content: unknown): Array<{ path: string; oldText: string | null; newText: string }> | undefined {
  if (!Array.isArray(content)) return undefined
  const out: Array<{ path: string; oldText: string | null; newText: string }> = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (row.type !== 'diff' || typeof row.path !== 'string' || typeof row.newText !== 'string') continue
    out.push({ path: row.path, oldText: typeof row.oldText === 'string' ? row.oldText : null, newText: row.newText })
  }
  return out.length > 0 ? out : undefined
}

function trimBlocks(blocks: Block[]): void {
  if (blocks.length > MAX_BLOCKS) blocks.splice(0, blocks.length - MAX_BLOCKS)
}
