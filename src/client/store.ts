/**
 * Browser-side state store for the ACP panel: the `AcpStore` class, its `/acp`
 * RPC calls, the `/api/acp/stream` EventSource and the `UiState` snapshot.
 *
 * The pure halves — transcript folding, save banners, permission asks, fork
 * state, subagent records, known presets and the state shapes — live under
 * `src/client/store/` and are re-exported at the bottom of this file, so every
 * existing `./store.ts` import keeps resolving unchanged. The SERVICE clusters
 * (settings writes, the built-in updater, the model catalog, the `/` menu rows,
 * worker detail indexes, the save gate and its banners, the roster write path,
 * the conversation's ACP sessions and its own picks) live there as classes with
 * a narrow host interface; this class owns the state and delegates to them.
 *
 * Deliberately framework-free: React binds through `useSyncExternalStore`.
 */

import type { AcpLiveToolCall } from "./acp-tool-presentation.ts"
import { LiveToolCallIndex } from "./store/live-tools.ts"
import { DEFAULT_KNOWN_PRESETS } from "./store/presets.ts"
import type { Block } from "./store/blocks.ts"
import { foldUpdate, releaseDetailsFromEvent, usageFromUpdate, withSessionReleased, type ReleaseDetails } from "./store/blocks.ts"
import type { ChatForkOutcome } from "./store/fork.ts"
import { reduceElicitationEvent } from "./store/elicitation.ts"
import { removePendingRequest, syncPendingRequests, upsertPendingRequest } from "./store/pending.ts"
import type { PendingPermission } from "./store/permission.ts"
import { normalizeSaveGateStatus } from "./store/save-gate.ts"
import type { AcpLogEntry, ChatTranscript, RpcCall, UiState } from "./store/state.ts"
import { LOG_MAX_ENTRIES } from "./store/state.ts"
import type { SubagentDetailState } from "./store/subagent.ts"
import { isSubagentDowngrade, subagentKey } from "./store/subagent.ts"
import { AgentAdminService } from "./store/agent-admin.ts"
import { CatalogService } from "./store/catalog.ts"
import { ChatChoiceService } from "./store/chat-choice.ts"
import { ChatSessionsService } from "./store/chat-sessions.ts"
import { LogService } from "./store/log.ts"
import { SaveBannersService } from "./store/save-banners.ts"
import { SettingsService } from "./store/settings.ts"
import type { AgentCommand } from "./store/skills.ts"
import { SkillsService } from "./store/skills.ts"
import { SubagentDetailService } from "./store/subagent-detail.ts"
import { UpdateService } from "./store/update.ts"

import type { AcpApprovalDeadlines, AcpEvent, AcpIdleRelease, AcpPresetStatus, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentSaveMode, AgentSavePayload, AgentSaveResult, AgentTestResult, AgentView, ApprovalDeadlinesResult, DelegateResult, DelegateSetPayload, DelegateSettingKey, DetectedAgentInfo, ElicitationOutcome, IdleReleaseResult, PermissionTimeoutMode, PluginReleaseNotes, PluginUpdateState, PluginVersionResult, QuestionTimeoutMode, SaveGateFlushResult, SaveGateOutcomeView, SaveGatePendingView, SaveGateStatus, SessionView, AgentSkillEntry, SharedMcpResult, SharedMcpSetPayload, SubagentDetailEntry } from '../protocol.ts'
import { DEFAULT_SAVE_GATE_TIMEOUT_MS, DEFAULT_SESSION_TITLE_PREFIX, DEFAULT_TAG_HALO } from '../protocol.ts'
import { commitFrame, consumeVerdict, invalidateVerdict, markUnsettled, peekVerdict, projectAcpMode, settleFromHost, type AcpVerdict } from './acp-verdict.ts'

interface Listener { (): void }

const MAX_BLOCKS = 400

export class AcpStore {
  private state: UiState = {
    open: false,
    localeRev: 0,
    stream: 'init',
    agents: [],
    agentsLoaded: false,
    deletedAgentIds: [],
    sessions: [],
    blocks: [],
    permissions: [],
    elicitations: [],
    busy: false,
    saveBanners: [],
    logs: [],
    logUnread: 0,
    detectedAgents: [...DEFAULT_KNOWN_PRESETS],
    detecting: false,
    modelCatalogs: {},
    seatCatalogs: {},
    probingModels: {},
    probeErrors: {},
    chatSessions: [],
    burstStats: {},
    tagHalo: { ...DEFAULT_TAG_HALO },
    titlePrefix: DEFAULT_SESSION_TITLE_PREFIX,
    approvalDeadlines: undefined,
    idleRelease: undefined,
    saveGate: {
      canSave: true,
      gateAvailable: false,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: DEFAULT_SAVE_GATE_TIMEOUT_MS,
    },
    chatTranscripts: {},
    acpMode: {},
    subagents: {},
    subagentDetails: {},
    agentSkills: {},
    chatBoundAgent: {},
    chatLockedAgent: {},
    agentLockReveal: {},
    chatChoice: {},
    seatDiag: 'idle',
    permissionSeatDiag: 'idle',
    slashDiag: 'idle',
  }

  private readonly listeners = new Set<Listener>()
  private source?: EventSource
  private readonly lastSeq = new Map<string, number>()
  /** Sessions with a finalized turn (dedups the cancel-fallback + late real turn/end pair). */
  private readonly openTurns = new Set<string>()
  /**
   * The ACP-mode verdicts this page holds, keyed by chat session id (see
   * {@link AcpVerdict}): `frame` (a committed `agent-preset/selected` frame)
   * outranks `host` (a `session/chat-list` answer), and absent means "never
   * asked". `UiState.acpMode` is a projection of the entries that carry a value.
   * A host read may only settle a session no frame has spoken for, except the
   * gate's own TTL re-ask: it updates the value, the frame keeps its authority.
   */
  private readonly acpVerdicts = new Map<string, AcpVerdict>()
  /**
   * ACP session id → owning DSH chat session id, learned from chat-list rows
   * and `turn/metrics` frames. Live `session/update` frames carry only the ACP
   * session, and a detail entry must land under the conversation that owns it
   * (`toolCallId`s can repeat across conversations).
   */
  private readonly acpSessionOwners = new Map<string, string>()
  private readonly liveToolIndex = new LiveToolCallIndex()
  /**
   * When the seat gate last asked the host for a session's verdict (epoch ms).
   * Kept apart from {@link acpVerdicts} so a held verdict is re-asked per TTL.
   */
  private readonly acpAsked = new Map<string, number>()

  /**
   * The leaf services. Each owns only its own bookkeeping (throttle windows,
   * in-flight dedup, LRU counters, retry payloads) and writes through the host
   * interface this class hands it — so `mutate` stays the single writer and
   * every broadcast keeps the merge/ordering semantics the class had when these
   * were methods.
   */
  private readonly settingsService: SettingsService
  private readonly updateService: UpdateService
  private readonly catalogService: CatalogService
  private readonly skillsService: SkillsService
  private readonly subagentDetailService: SubagentDetailService
  private readonly saveBannersService: SaveBannersService
  private readonly agentAdminService: AgentAdminService
  private readonly chatChoiceService: ChatChoiceService
  private readonly chatSessionsService: ChatSessionsService

  constructor(private readonly rpc: RpcCall, private readonly locale: (zh: string, en: string) => string) {
    const call = <T>(endpoint: string, payload: unknown = {}): Promise<T> => this.call<T>(endpoint, payload)
    const mutate = (patch: Partial<UiState>): void => { this.mutate(patch) }
    const state = (): UiState => this.state
    const flashError = (error: unknown): void => { this.flashError(error) }
    const label = (zh: string, en: string): string => this.label(zh, en)
    this.settingsService = new SettingsService({ call, mutate, state, flashError })
    this.updateService = new UpdateService({ call, mutate, state, label })
    this.catalogService = new CatalogService({
      call,
      mutate,
      state,
      label,
      flashError,
      resync: () => this.resync(),
    })
    this.skillsService = new SkillsService({
      call,
      mutate,
      state,
      chatAgentFor: dshSessionId => this.chatAgentFor(dshSessionId),
    })
    this.subagentDetailService = new SubagentDetailService({ call, mutate, state })
    this.saveBannersService = new SaveBannersService({
      call,
      mutate,
      state,
      label,
      flashError,
      logLine: (level, text) => this.logService.line(level, text),
      // The banner's "重试"/"强制保存" on a refused save re-runs exactly that
      // payload through the agent-admin service; the banner store never reaches
      // into the roster itself.
      retryAgentSave: (payload, mode) => this.agentAdminService.saveAgent(payload, mode),
    })
    this.agentAdminService = new AgentAdminService({
      call,
      mutate,
      state,
      label,
      flashError,
      resync: () => this.resync(),
      probeModels: (agentId, model) => this.probeModels(agentId, model),
      invalidateSeatCatalog: agentId => this.invalidateSeatCatalog(agentId),
    }, this.saveBannersService)
    this.chatChoiceService = new ChatChoiceService({ call, mutate, state, flashError })
    this.chatSessionsService = new ChatSessionsService({
      call,
      mutate,
      state,
      flashError,
      locale: label,
      // The verdict book and the owner map stay in this class: the seat gate
      // reads the same verdicts, and live update folds read the same owners.
      verdicts: {
        settleAllowed: (dshSessionId, settleVerdict) => settleVerdict === true
          || peekVerdict(this.acpVerdicts, dshSessionId)?.kind !== 'frame',
        commit: (dshSessionId, value) => this.commitHostVerdict(dshSessionId, value),
        markUnsettled: (dshSessionId) => { markUnsettled(this.acpVerdicts, dshSessionId) },
      },
      noteAcpSessionOwners: (dshSessionId, sessions) => {
        for (const row of sessions) this.acpSessionOwners.set(row.sessionId, dshSessionId)
      },
      // The conversation's picks have a single writer; the mode switch records
      // through the same one.
      writeChoice: (dshSessionId, update, agentId) => this.chatChoiceService.writeChoice(dshSessionId, update, agentId),
    })
  }

  /**
   * Whether the active locale draws the Chinese half of a bilingual body.
   *
   * Asked THROUGH the same resolver `label` uses, so a locale switch reaches
   * this on the next render: the resolver is called with a pair that resolves
   * to its own locale id, and the answer is compared. Nothing is cached.
   */
  prefersZh(): boolean {
    return this.locale('zh', 'en') === 'zh'
  }

  // ---- React bridge ----

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): UiState {
    return this.state
  }

  liveToolCall(dshSessionId: string | undefined, callId: string): AcpLiveToolCall | undefined {
    return this.liveToolIndex.get(dshSessionId, callId, this.acpSessionOwners)
  }

  private dropPendingUpdates(sessionId: string): void {
    for (let i = this.pendingUpdates.length - 1; i >= 0; i -= 1) {
      if (this.pendingUpdates[i]?.sessionId === sessionId) this.pendingUpdates.splice(i, 1)
    }
  }

  private clearLiveSession(sessionId: string): void {
    this.liveToolIndex.clearSession(sessionId)
    this.dropPendingUpdates(sessionId)
  }

  private mutate(patch: Partial<UiState>, blocksChanged = false): void {
    this.state = {
      ...this.state,
      ...patch,
      blocks: blocksChanged ? [...this.state.blocks] : patch.blocks ?? this.state.blocks,
    }
    for (const listener of [...this.listeners]) listener()
  }

  /** The runtime log's id source and patch builder (see `LogService`). */
  private readonly logService = new LogService()

  // ---- Streaming update coalescing ----

  /**
   * Live `session/update` frames waiting to be folded. Agents stream at token
   * granularity — hundreds of frames a second with usage ticks interleaved —
   * and folding plus notifying listeners per frame re-rendered every store
   * consumer per chunk. Frames are coalesced into ONE fold + ONE mutate per
   * animation frame instead; the order inside a batch is preserved, and the
   * transcript watermark (`lastSeq`) advances per batch.
   */
  private readonly pendingUpdates: Array<{ sessionId: string; seq: number; update: unknown }> = []
  private updateFlushArmed = false

  /** Fold everything pending now (idempotent; the scheduler clears its flag). */
  flushUpdates(): void {
    const batch = this.pendingUpdates.splice(0, this.pendingUpdates.length)
    this.updateFlushArmed = false
    if (batch.length === 0) return
    const bySession = new Map<string, Array<{ seq: number; update: unknown }>>()
    for (const item of batch) {
      const list = bySession.get(item.sessionId)
      if (list === undefined) bySession.set(item.sessionId, [item])
      else list.push(item)
    }
    let chatTranscripts = this.state.chatTranscripts
    let chatSessions = this.state.chatSessions
    let subagentDetails = this.state.subagentDetails
    let blocksChanged = false
    let liveToolsChanged = false
    for (const [sessionId, items] of bySession) {
      const last = items[items.length - 1]
      if (this.liveToolIndex.foldBatch(sessionId, items)) liveToolsChanged = true
      // A worker's detail index is fed BEFORE the active-session split: the
      // conversation that dispatched it is not necessarily the ACP view's
      // active transcript, and the two never share the fold.
      const owner = this.acpSessionOwners.get(sessionId)
      if (owner !== undefined) {
        const folded = this.foldSubagentDetailFrames(owner, items, subagentDetails)
        if (folded !== undefined) subagentDetails = folded
      }
      // `usage_update` is state, not stream content: it never becomes a block,
      // but both observed snapshots that carry usage must move with it —
      // otherwise the ACP view header and the composer's occupancy ring only
      // refresh when some other RPC re-reads the session.
      const usage = usageOfBatch(items)
      if (usage !== undefined) chatSessions = withSessionUsage(chatSessions, sessionId, usage)
      // The observed transcript folds every frame (a watched session's cards
      // and prose); blocks are copied only when something actually changed, so
      // a usage-only tick costs one record object, not a re-render payload.
      const record = chatTranscripts[sessionId]
      if (record !== undefined) {
        let changed = false
        for (const item of items) {
          if (foldUpdate(record.blocks, item.update as Record<string, unknown>)) changed = true
        }
        const session = usage !== undefined && !sameUsage(record.session.usage, usage)
          ? { ...record.session, usage }
          : record.session
        chatTranscripts = {
          ...chatTranscripts,
          [sessionId]: { ...record, session, seq: last.seq, ...(changed ? { blocks: [...record.blocks] } : {}) },
        }
      }
      if (sessionId !== this.state.activeSessionId) {
        this.lastSeq.set(sessionId, last.seq)
        continue
      }
      const seen = this.lastSeq.get(sessionId)
      const contiguous = seen === undefined
        || (items[0].seq === seen + 1 && items.every((item, index) => index === 0 || item.seq === items[index - 1].seq + 1))
      this.lastSeq.set(sessionId, last.seq)
      if (!contiguous) {
        void this.loadTranscript(sessionId) // gap detected → replay
        continue
      }
      for (const item of items) {
        if (foldUpdate(this.state.blocks, item.update as Record<string, unknown>)) blocksChanged = true
      }
    }
    const patch: Partial<UiState> = {}
    if (chatTranscripts !== this.state.chatTranscripts) patch.chatTranscripts = chatTranscripts
    if (chatSessions !== this.state.chatSessions) patch.chatSessions = chatSessions
    if (subagentDetails !== this.state.subagentDetails) patch.subagentDetails = subagentDetails
    if (blocksChanged) patch.blocks = [...this.state.blocks]
    if (Object.keys(patch).length > 0 || liveToolsChanged) this.mutate(patch)
  }

  /**
   * Append the frames of one batch that belong to an OPEN worker detail index
   * (see {@link UiState.subagentDetails}; the filters live in
   * `SubagentDetailService.foldSubagentDetailFrames`).
   *
   * Returns the next map, or `undefined` when nothing matched.
   */
  private foldSubagentDetailFrames(
    owner: string,
    items: ReadonlyArray<{ seq: number; update: unknown }>,
    currentMap: Record<string, SubagentDetailState>,
  ): Record<string, SubagentDetailState> | undefined {
    return this.subagentDetailService.foldSubagentDetailFrames(owner, items, currentMap)
  }

  private armUpdateFlush(): void {
    if (this.updateFlushArmed) return
    this.updateFlushArmed = true
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { this.updateFlushArmed = false; this.flushUpdates() })
      return
    }
    // No frame scheduler (a plain Node runtime): fold at once, keeping the
    // same one-mutate-per-batch contract for non-browser consumers.
    this.flushUpdates()
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
    if (!result.ok) {
      const error = new Error(result.error.message) as Error & { code?: string }
      // Keep the protocol code so a save refusal can be told apart from a
      // transport failure when the banner decides its next-step actions.
      error.code = result.error.code
      throw error
    }
    return result.value as T
  }

  /** Snapshot refresh used on panel open and after a stream outage. */
  async resync(): Promise<void> {
    try {
      const [{ agents }, { sessions }, defaultAgentInfo, detectResult, presetResult, tagHaloResult, titlePrefixResult, skillsMcpResult, sharedMcpResult, deadlinesResult, idleReleaseResult, delegateResult, saveGateResult, versionResult] = await Promise.all([
        this.call<{ agents: AgentView[] }>('agents/list'),
        this.call<{ sessions: SessionView[] }>('sessions/list'),
        // The plugin's OWN default ACP agent — a plugin-private id, not a DSH
        // model route (see `defaultAgent` on the host half).
        this.call<{ agentId?: string }>('default/agent').catch(() => ({} as { agentId?: string })),
        this.call<{ agents: DetectedAgentInfo[] }>('agents/detect').catch(() => null),
        // `null` (host without a preset roster) hides the panel block.
        this.call<{ preset: AcpPresetStatus | null }>('preset/status').catch(() => null),
        // Host without the endpoint (older half) keeps the local default.
        this.call<{ halo: AcpTagHalo }>('ui/tag-halo').catch(() => ({ halo: { ...DEFAULT_TAG_HALO } })),
        // Host without the endpoint (older half) keeps the local default (on).
        this.call<{ titlePrefix: boolean }>('ui/session-title-prefix').catch(() => ({ titlePrefix: DEFAULT_SESSION_TITLE_PREFIX })),
        this.call<{ skillsMcpEnabled: boolean }>('ui/skills-mcp').catch(() => ({} as { skillsMcpEnabled?: boolean })),
        this.call<SharedMcpResult>('ui/shared-mcp').catch(() => ({ sharedMcp: undefined })),
        // `undefined` (older half) hides the deadline card instead of showing a
        // number this browser made up.
        this.call<ApprovalDeadlinesResult>('ui/approval-deadlines').catch(() => ({ deadlines: undefined })),
        // `undefined` (older half) hides the tab instead of showing a
        // number this browser made up.
        this.call<IdleReleaseResult>('ui/idle-release').catch(() => ({ idleRelease: undefined })),
        this.call<DelegateResult>('ui/delegate').catch(() => ({ delegate: undefined })),
        // The save gate is optional: an older host answers an unknown endpoint
        // and the local idle default stays in force.
        this.call<{ status: SaveGateStatus }>('save/status').catch(() => null),
        // The settings badge's data source; older halves answer `unknown
        // endpoint`, which hides the badge.
        this.call<PluginVersionResult>('plugin/version').catch(() => null),
      ])
      const detectedAgents = (detectResult && detectResult.agents.length > 0)
        ? detectResult.agents
        : (this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS])
      // A snapshot without `gateAvailable` is an older/non-wired host, not an
      // idle authority. Normalising here keeps every surface honest.
      const nextSaveGate = saveGateResult?.status === undefined
        ? undefined
        : normalizeSaveGateStatus(saveGateResult.status)
      // Absent on an older host: keep the settings-panel card (degraded path).
      this.mutate({
        agents,
        agentsLoaded: true,
        sessions,
        defaultAgent: defaultAgentInfo?.agentId,
        detectedAgents,
        preset: presetResult?.preset ?? undefined,
        tagHalo: tagHaloResult?.halo ?? { ...DEFAULT_TAG_HALO },
        titlePrefix: titlePrefixResult?.titlePrefix ?? DEFAULT_SESSION_TITLE_PREFIX,
        ...(skillsMcpResult.skillsMcpEnabled === undefined ? {} : { skillsMcpEnabled: skillsMcpResult.skillsMcpEnabled }),
        sharedMcp: sharedMcpResult.sharedMcp,
        approvalDeadlines: deadlinesResult.deadlines,
        idleRelease: idleReleaseResult.idleRelease,
        delegate: delegateResult.delegate,
        ...(nextSaveGate === undefined ? {} : { saveGate: nextSaveGate }),
        // A refresh must rebuild the terminal rows it missed, not only the
        // gate snapshot: the SSE frame that produced them is gone.
        ...(nextSaveGate === undefined
          ? {}
          : this.saveBannersService.saveGatePatch(this.state.saveGate, nextSaveGate, false, true)),
        pluginVersion: versionResult?.version !== undefined && versionResult.version !== '' ? versionResult.version : undefined,
      })
      // `sessions/list` is the `/acp` RPC face; the composer's chat rows
      // (agent modes, occupancy) are a separate list. A reconnect must refresh
      // that list too or the ring keeps a pre-outage sample until a turn ends.
      // `force`: a read that began before the outage missed every frame the
      // stream dropped, so its answer must not be reused here.
      if (this.state.chatSessionsFor !== undefined) void this.loadChatSessions(this.state.chatSessionsFor, { force: true })
      const active = this.state.activeSessionId ?? sessions[0]?.sessionId
      if (active !== undefined) await this.loadTranscript(active)
    } catch (error) {
      this.mutate({ notice: String(error instanceof Error ? error.message : error) })
    }
  }

  // ---- Built-in updater (implementation: store/update.ts) ----

  /** Throttled `plugin/update-check` read; `force` bypasses the ten-minute window. */
  async checkPluginUpdate(force = false): Promise<PluginUpdateState | undefined> {
    return this.updateService.checkPluginUpdate(force)
  }

  /** Explicit `plugin/update-apply` install of one exact version (the badge's `applying` flip included). */
  async applyPluginUpdate(version: string): Promise<PluginUpdateState | undefined> {
    return this.updateService.applyPluginUpdate(version)
  }

  /** One version's `plugin/release-notes` preview, cached per version; `force` also bypasses the host cache. */
  async loadPluginReleaseNotes(version: string, force = false): Promise<PluginReleaseNotes | undefined> {
    return this.updateService.loadPluginReleaseNotes(version, force)
  }

  // ---- Roster write path (implementation: store/agent-admin.ts) ----

  /** Explicit `agents/detect` refresh; a failure keeps the roster it had. */
  async detectAgents(): Promise<void> {
    return this.agentAdminService.detectAgents()
  }

  /**
   * Read the host's save gate before a settings save. The host remains the
   * authority (`agent/save` re-checks), but this lets the form show its
   * confirmation without racing a turn.
   */
  async readSaveGate(): Promise<SaveGateStatus> {
    return this.saveBannersService.readSaveGate()
  }

  /**
   * Save one agent definition. `mode` is the user's explicit gesture:
   * `direct` is the no-turn path, `defer` queues behind turns, `force` flushes
   * the gate and interrupts. The host returns `confirmationRequired` when a
   * turn exists and no explicit mode was supplied; the caller must ask.
   */
  async saveAgent(payload: AgentSavePayload, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    return this.agentAdminService.saveAgent(payload, mode)
  }

  /**
   * Dry-run the connection form: the host spawns a throwaway process from
   * these exact values, handshakes, and tears it down. A reachable-but-broken
   * agent arrives as `{ ok: false }`, not a thrown error; only transport or
   * validation failures reject.
   */
  async testAgent(payload: AgentSavePayload): Promise<AgentTestResult> {
    return this.agentAdminService.testAgent(payload)
  }

  // ---- Model catalog and ACP seat surface (implementation: store/catalog.ts) ----

  /** Seed one agent's model panes from the host's persisted catalog cache (memory-only; never spawns). */
  async loadCachedModels(agentId: string): Promise<void> {
    return this.catalogService.loadCachedModels(agentId)
  }

  /** Explicit probe (`agent/probe-models`); `model` fetches just that model's thought levels for the card. */
  async probeModels(agentId: string, model?: string): Promise<void> {
    return this.catalogService.probeModels(agentId, model)
  }

  /** Cached, deduped read of one agent's `agent/catalog` (what the composer chips and the model seat render). */
  async loadAgentCatalog(agentId: string): Promise<void> {
    return this.catalogService.loadAgentCatalog(agentId)
  }

  /** Drop one agent's cached seat catalog (its model surface just changed). */
  private invalidateSeatCatalog(agentId: string): void {
    this.catalogService.invalidateSeatCatalog(agentId)
  }

  /** Persist the ACP-seat model filter (lightweight RPC: no process restart). */
  async setExposedModels(agentId: string, exposedModels: string[] | undefined): Promise<void> {
    return this.catalogService.setExposedModels(agentId, exposedModels)
  }

  /** Persist the auto-discovery switch (lightweight like {@link setExposedModels}). */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    return this.catalogService.setAutoDiscoverModels(agentId, autoDiscoverModels)
  }

  async setAgentSkillsMcp(agentId: string, skillsMcpEnabled: boolean): Promise<void> { return this.agentAdminService.setAgentSkillsMcp(agentId, skillsMcpEnabled) }
  async setAgentSharedMcp(agentId: string, sharedMcpEnabled: boolean): Promise<void> { return this.agentAdminService.setAgentSharedMcp(agentId, sharedMcpEnabled) }

  /** Set one agent's default chat mode (lightweight: no restart, no save gate). */
  async setAgentDefaultMode(agentId: string, defaultMode?: string): Promise<void> { return this.agentAdminService.setAgentDefaultMode(agentId, defaultMode) }

  async deleteAgent(agentId: string): Promise<void> {
    return this.agentAdminService.deleteAgent(agentId)
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
      // An answer BEHIND what this page already folded must not replace it.
      //
      // The host fills its transcript from the notification pipeline, which the
      // SDK paces independently of the `session/prompt` response, so a read
      // taken right after a turn can still be missing the agent's last chunk.
      // `lastSeq` already refuses to go backwards; the blocks must not either,
      // or switching away and back inside that window truncates a turn the user
      // just watched finish. A resumed session replays as fresh updates, but
      // only after `session/reset` zeroes the watermark — so this cannot swallow
      // a legitimate replay.
      const seen = this.lastSeq.get(sessionId) ?? 0
      if ((entries.at(-1)?.seq ?? 0) < seen) return
      const blocks: Block[] = []
      for (const entry of entries) {
        foldUpdate(blocks, entry.update)
        this.lastSeq.set(sessionId, Math.max(this.lastSeq.get(sessionId) ?? 0, entry.seq))
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

  // ---- The conversation's ACP sessions (implementation: store/chat-sessions.ts) ----

  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   */
  loadChatSessions(dshSessionId: string, options?: { settleVerdict?: boolean; force?: boolean }): Promise<void> {
    return this.chatSessionsService.loadChatSessions(dshSessionId, options)
  }

  /** Abandon the in-flight `session/chat-list` read for one session (or every one). */
  abandonChatSessionRead(dshSessionId?: string): void {
    this.chatSessionsService.abandonChatSessionRead(dshSessionId)
  }

  // ---- Worker detail indexes (implementation: store/subagent-detail.ts) ----

  /** Ensure one worker's detail index exists and read its bounded history on demand. */
  async loadSubagentDetail(dshSessionId: string, childId: string): Promise<void> {
    return this.subagentDetailService.loadSubagentDetail(dshSessionId, childId)
  }

  /**
   * Which agent serves one conversation as far as this page can tell, without
   * reading any catalog: live ACP session → agent lock → host/optimistic
   * binding → persisted pick → plugin default. Used to find the agent whose
   * cached commands the `/` menu should offer before a session exists.
   */
  chatAgentFor(dshSessionId: string): string | undefined {
    if (this.state.chatSessionsFor === dshSessionId) {
      const live = this.state.chatSessions[0]
      if (live !== undefined) return live.agentId
    }
    // The lock outlives the session: after the first turn it is the durable
    // answer even when the ACP session is gone.
    return this.state.chatLockedAgent[dshSessionId]
      ?? this.state.chatBoundAgent[dshSessionId]
      ?? this.state.chatChoice[dshSessionId]?.agentId
      ?? this.state.defaultAgent
  }

  // ---- The `/` menu's ACP rows (implementation: store/skills.ts) ----

  /**
   * The slash commands the LIVE ACP session declared for one chat session;
   * `undefined` falls back to {@link agentCommands}.
   */
  chatSessionCommands(dshSessionId: string): readonly AgentCommand[] | undefined {
    return this.skillsService.chatSessionCommands(dshSessionId)
  }

  /** The slash commands the agent declared in its most recent session (`agent/catalog`). */
  agentCommands(agentId: string | undefined): readonly AgentCommand[] | undefined {
    return this.skillsService.agentCommands(agentId)
  }

  /** The skill rows this conversation's `/` menu should offer, read against the CURRENT binding. */
  skillRowsFor(dshSessionId: string): readonly AgentSkillEntry[] | undefined {
    return this.skillsService.skillRowsFor(dshSessionId)
  }

  /** Fetch one conversation's skill rows (concurrent callers share one read). */
  loadAgentSkills(dshSessionId: string): Promise<void> {
    return this.skillsService.loadAgentSkills(dshSessionId)
  }

  /** The draft text one skill pick inserts, against the CURRENT binding. */
  skillInsertionFor(dshSessionId: string, token: string): string | undefined {
    return this.skillsService.skillInsertionFor(dshSessionId, token)
  }

  /** Fold a host answer in and return the derived projection for the caller's `mutate`. */
  private commitHostVerdict(dshSessionId: string, value: boolean): Record<string, boolean> {
    settleFromHost(this.acpVerdicts, dshSessionId, value)
    return projectAcpMode(this.acpVerdicts)
  }

  /** Publish the projection when it moved; a restated verdict keeps the record's identity. */
  private publishAcpMode(): void {
    const acpMode = projectAcpMode(this.acpVerdicts)
    const held = this.state.acpMode
    const keys = Object.keys(acpMode)
    if (keys.length === Object.keys(held).length && keys.every(id => held[id] === acpMode[id])) return
    this.mutate({ acpMode })
  }

  /**
   * Record the verdict a committed `agent-preset/selected` frame carries, folded
   * from its own preset field ({@link acpModeFromPresetEvent}): it promotes the
   * session's verdict to `frame`, so no later host read may regress it, the
   * gate's TTL re-ask being the one exception. Restating it costs no churn.
   *
   * The seat gate (`syncAcpMode`) is the second caller: folding the runtime
   * row's `agentPreset` through here hands the row the frame's authority on
   * purpose (one provenance, one rank); only HOST READS may not regress it.
   */
  noteAcpMode(dshSessionId: string, acpMode: boolean): void {
    commitFrame(this.acpVerdicts, dshSessionId, acpMode)
    this.publishAcpMode()
  }

  /**
   * Record the model-seat gate's last decision (see the `seatDiag` field). The
   * gate owns the string; the store only carries it so the ACP view can render
   * *why* the native seat is or is not shadowed. No-op when unchanged, so the
   * gate can call this on every evaluation without churning listeners.
   */
  noteSeatDiag(text: string): void {
    if (this.state.seatDiag === text) return
    this.mutate({ seatDiag: text })
  }

  /** Record the staged main-view conversation and whether it runs ACP mode. */
  noteStagedSession(staged: { sessionId: string; isAcp: boolean } | undefined): void {
    const prev = this.state.stagedSession
    if (prev?.sessionId === staged?.sessionId && prev?.isAcp === staged?.isAcp) return
    this.mutate({ stagedSession: staged })
  }

  /**
   * Record the permission-seat gate's last decision (`conversation.input.permission`).
   */
  notePermissionSeatDiag(text: string): void {
    if (this.state.permissionSeatDiag === text) return
    this.mutate({ permissionSeatDiag: text })
  }

  /**
   * Record the slash-isolation seam's last verdict (`idle` = in force, or no
   * problem to report). No-op when unchanged, like the seat lines.
   */
  noteSlashDiag(text: string): void {
    if (this.state.slashDiag === text) return
    this.mutate({ slashDiag: text })
  }

  /**
   * Whether the seat gate can rely on a verdict here. `false` means "asked but
   * not answered", the signal to withdraw the one-shot ask entry and retry.
   * DESTRUCTIVE for an `unsettled` marker (see {@link consumeVerdict}).
   */
  hasAcpModeVerdict(dshSessionId: string): boolean {
    return consumeVerdict(this.acpVerdicts, dshSessionId)
  }

  /**
   * Whether the seat gate may ask the host for this session's verdict now, and
   * stamps the ledger when it may: never asked, no verdict held (an unanswered
   * ask is retried, not parked), or the held verdict aged past `ttlMs` while the
   * row stays silent. A held verdict keeps its ledger entry either way.
   */
  claimAcpAsk(dshSessionId: string, ttlMs: number): boolean {
    const verdictHeld = this.state.acpMode[dshSessionId] !== undefined || this.hasAcpModeVerdict(dshSessionId)
    const askedAt = this.acpAsked.get(dshSessionId)
    if (askedAt !== undefined && verdictHeld && Date.now() - askedAt < ttlMs) return false
    this.acpAsked.set(dshSessionId, Date.now())
    return true
  }

  /** Drop the ask ledger entry so a later evaluation asks again. */
  releaseAcpAsk(dshSessionId: string): void {
    this.acpAsked.delete(dshSessionId)
  }

  /**
   * Drop one chat session's verdict — or every one — so the gate re-asks
   * instead of trusting a moved-past answer. An unanswered ask's marker and the
   * ask ledger survive: they describe an open question, not a stale answer.
   */
  invalidateAcpMode(dshSessionId?: string): void {
    invalidateVerdict(this.acpVerdicts, dshSessionId)
    this.publishAcpMode()
  }

  /**
   * Switch the ACP agent's own mode for one chat session (`session/set_mode`),
   * then re-read the binding so the control reflects what the agent actually
   * reports (a rejected switch must not leave an optimistic lie on screen).
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    return this.chatSessionsService.setChatSessionMode(dshSessionId, modeId, agentId)
  }

  /** Bring the conversation's released ACP session back on a fresh process (`session/chat-resume`). */
  async resumeChatSession(dshSessionId: string): Promise<void> {
    return this.chatSessionsService.resumeChatSession(dshSessionId)
  }

  /**
   * Branch one conversation: the host forks the DSH session tree, then the
   * plugin adopts the ACP side (`session/chat-fork-adopt`). Host first is
   * structural — see `ChatSessionsService.forkChatSession`.
   */
  async forkChatSession(
    dshSessionId: string,
    forkHost: (sessionId: string) => Promise<unknown>,
  ): Promise<ChatForkOutcome> {
    return this.chatSessionsService.forkChatSession(dshSessionId, forkHost)
  }

  // ---- ACP transcript observation (implementation: store/chat-sessions.ts) ----

  /** Start (or refresh) observation of every ACP transcript behind one DSH chat session. */
  async loadChatTranscript(dshSessionId: string): Promise<void> {
    return this.chatSessionsService.loadChatTranscript(dshSessionId)
  }

  /** Observed transcript for one ACP session id (undefined → nobody is watching it). */
  transcriptOf(acpSessionId: string): ChatTranscript | undefined {
    return this.chatSessionsService.transcriptOf(acpSessionId)
  }

  /** The observed transcript of one chat session (the live binding wins over a released one). */
  chatTranscriptOf(dshSessionId: string): ChatTranscript | undefined {
    return this.chatSessionsService.chatTranscriptOf(dshSessionId)
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
    try { await this.call('permission/respond', { requestId, ...(optionId === undefined ? {} : { optionId }) }) }
    catch (error) { this.flashError(error); throw error }
  }
  async respondElicitation(requestId: string, outcome: ElicitationOutcome): Promise<void> {
    try { await this.call('elicitation/respond', { requestId, ...outcome }) }
    catch (error) { this.flashError(error); throw error }
  }

  async stopAgent(agentId: string): Promise<void> {
    return this.agentAdminService.stopAgent(agentId)
  }

  /**
   * Explicit "强制保存": flush the host's held profile writes now, even while
   * an ACP turn is running. The gate broadcasts its new state; the extra
   * `save/status` read is the fallback for a host that resolves the flush
   * before its own frame lands. A transport failure gets its own visible row —
   * the caller's `.finally` must never be the only thing that runs.
   */
  async forceSaveGate(): Promise<SaveGateFlushResult> {
    return this.saveBannersService.forceSaveGate()
  }

  /**
   * Drop one held profile write by label. The settings form uses this when the
   * user edits the form after choosing "save after turns": flushing that old
   * snapshot later would silently overwrite the newer values.
   */
  async cancelSaveGate(label: string): Promise<boolean> {
    return this.saveBannersService.cancelSaveGate(label)
  }

  /** Re-run a failed/expired held write through the host gate. */
  async retrySaveGate(label: string): Promise<'retried' | 'none' | 'error'> {
    return this.saveBannersService.retrySaveGate(label)
  }

  /**
   * The banner's "知道了": remove it, and let the same failure reappear later.
   * `at` names the row that owns the gesture.
   */
  dismissBanner(key: string, at?: number): void {
    this.saveBannersService.dismissBanner(key, at)
  }

  /** The banner's "重试": re-run the retained host write or the rejected save. */
  async retryBanner(key: string): Promise<void> {
    return this.saveBannersService.retryBanner(key)
  }

  /** The banner's "强制保存": flush the gate or force the rejected payload. */
  async forceBanner(key: string): Promise<void> {
    return this.saveBannersService.forceBanner(key)
  }

  /**
   * Set the plugin's OWN default ACP agent (the panel's ★ gesture): which agent
   * an ACP-mode conversation starts on. Plugin-private state — the host keeps it
   * in its own agent registry file, and nothing here touches DSH's model
   * selection (see docs/acp-convergence.md §2.2).
   */
  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    return this.agentAdminService.setDefaultAgent(agentId)
  }

  // ---- Settings writes (implementation: store/settings.ts) ----

  /** Write the agent tag's halo preference (optimistic; the host answer is the authority). */
  async setTagHalo(halo: AcpTagHalo): Promise<void> {
    return this.settingsService.setTagHalo(halo)
  }

  /** Write the title-prefix toggle (optimistic, like {@link setTagHalo}). */
  async setTitlePrefix(value: boolean): Promise<void> {
    return this.settingsService.setTitlePrefix(value)
  }

  async setSkillsMcpEnabled(value: boolean): Promise<void> { return this.settingsService.setSkillsMcp(value) }
  async refreshSharedMcp(): Promise<void> { return this.settingsService.refreshSharedMcp() }
  async setSharedMcp(patch: SharedMcpSetPayload): Promise<void> { return this.settingsService.setSharedMcp(patch) }

  /** Write the approval deadline, or drop the persisted override with `reset`. */
  async setApprovalDeadline(ms: number): Promise<void> {
    return this.settingsService.setApprovalDeadline(ms)
  }
  async setElicitationDeadline(ms: number): Promise<void> { return this.settingsService.setElicitationDeadline(ms) }
  /** What an expired QUESTION ask does (`cancel` / `first`). */
  async setQuestionTimeoutMode(mode: QuestionTimeoutMode): Promise<void> { return this.settingsService.setQuestionTimeoutMode(mode) }
  /** Write what an expired approval deadline DOES (`abort` / `auto` / `wait`). */
  async setApprovalTimeoutMode(mode: PermissionTimeoutMode): Promise<void> {
    return this.settingsService.setApprovalTimeoutMode(mode)
  }

  /** Drop the persisted approval-deadline override: the config file (or the built-in default) decides again. */
  async resetApprovalDeadlines(): Promise<void> {
    return this.settingsService.resetApprovalDeadlines()
  }

  /** Write the idle-release window (optimistic; the host answer is the authority). */
  async setIdleRelease(idleTimeoutMs: number): Promise<void> {
    return this.settingsService.setIdleRelease(idleTimeoutMs)
  }

  /** Drop the persisted idle-release override: the config file (or the built-in default) decides again. */
  async resetIdleRelease(): Promise<void> {
    return this.settingsService.resetIdleRelease()
  }
  // Delegate writes (optimistic; the host answer is the authority). One-line bodies: this file sits at its size ratchet.
  async setDelegateSettings(patch: DelegateSetPayload): Promise<void> { return this.settingsService.setDelegateSettings(patch) }
  async resetDelegateSetting(key: DelegateSettingKey): Promise<void> { return this.settingsService.resetDelegateSetting(key) }

  // ---- The conversation's own picks (implementation: store/chat-choice.ts) ----

  /**
   * Bind one DSH chat session to an ACP agent. This is the plugin's own
   * conversation↔agent mapping: it does NOT write a DSH model route, so it
   * cannot pollute the deployment default model and cannot be refused by the
   * GUI's catalog gate (the retired `session/model-unavailable` failure).
   */
  async bindChatAgent(dshSessionId: string, agentId: string): Promise<void> {
    return this.chatChoiceService.bindChatAgent(dshSessionId, agentId)
  }

  /** Switch the bound agent's model (`agentId@choice`) for one chat session. */
  async setChatSessionModel(dshSessionId: string, modelId: string, agentId?: string): Promise<void> {
    return this.chatChoiceService.setChatSessionModel(dshSessionId, modelId, agentId)
  }

  /** Switch the bound agent's reasoning effort for one chat session. */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    return this.chatChoiceService.setChatSessionEffort(dshSessionId, effort, agentId)
  }

  /** Set one of the bound agent's EXTRA config options for one chat session. */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    return this.chatChoiceService.setChatSessionConfig(dshSessionId, configId, value, agentId)
  }

  /**
   * Localize one string. BOUND to the instance in the constructor: the ACP
   * view hands this reference to memoized rows, so it must stay stable across
   * renders or every row re-renders on every store notification.
   */
  label: (zh: string, en: string) => string = (zh: string, en: string): string => this.locale(zh, en)

  /**
   * Republish the snapshot after a locale switch. Every `label()` resolves
   * against the current language while rendering, so a notification is all
   * that is needed — except the detect summary, which the store owns as an
   * already-resolved string and rebuilds from its counts here.
   */
  refreshLocale(): void {
    const summary = this.agentAdminService.detectSummary()
    this.mutate({
      localeRev: this.state.localeRev + 1,
      ...(summary === undefined ? {} : { detectSummary: summary }),
    })
  }

  clearNotice(): void {
    this.mutate({ notice: undefined })
  }

  /** Drop every retained runtime-log line (the unread counter restarts too). */
  clearLogs(): void {
    this.mutate({ logs: [], logUnread: 0 })
  }

  /** The user looked at the log: clear the unread badge. */
  markLogsRead(): void {
    if (this.state.logUnread === 0) return
    this.mutate({ logUnread: 0 })
  }

  private flashError(error: unknown): void {
    this.mutate({ notice: error instanceof Error ? error.message : String(error) })
  }

  // ---- Event application ----

  /**
   * Feed the replay log BEFORE the switch folds the frame into the snapshot.
   * Live SSE frames and directly injected test frames then take the same path.
   * The log itself lives in `store/chat-sessions.ts` — its only reader is the
   * `session/chat-list` answer this facade hands to that service.
   */
  private noteChatRowFrame(event: AcpEvent, release?: ReleaseDetails): void {
    switch (event.type) {
      case 'session/released': this.chatSessionsService.noteChatRowFrame(event.sessionId, 'released', release); break
      case 'session/reset': this.chatSessionsService.noteChatRowFrame(event.sessionId, 'reset'); break
      case 'session/created': this.chatSessionsService.noteChatRowFrame(event.sessionId, 'created'); break
      case 'session/closed': this.chatSessionsService.noteChatRowFrame(event.sessionId, 'closed'); break
    }
  }

  private applyEvent(event: AcpEvent): Promise<void> {
    const release = event.type === 'session/released' ? releaseDetailsFromEvent(event, Date.now()) : undefined
    this.noteChatRowFrame(event, release)
    switch (event.type) {
      case 'agent/notice': {
        if (event.agentId === 'hmr') {
          // The hot-reload guard speaks through `agent/notice`; a log line is
          // invisible unless the user opens the log, so the same fact also
          // becomes a persistent page-top banner.
          const retryFailure = event.text.includes('retry failed') || event.text.includes('did not start')
          this.saveBannersService.pushSaveBanner({
            key: 'hmr-delay',
            source: 'hmr-delay',
            level: 'error',
            title: this.label('热重载被延迟', 'Hot reload delayed'),
            body: retryFailure
              ? this.label('热重载重试失败，配置会在本轮对话结束后重新加载。', 'The hot-reload retry failed. The configuration will reload when this turn ends.')
              : this.label('对话仍在进行，配置热重载已延迟；回合结束后会自动重新加载。', 'A turn is still running, so the configuration reload is delayed. It will reload when the turn ends.'),
            at: Date.now(),
            actions: ['dismiss'],
          })
        }
        this.mutate(this.logService.patch(this.state, event.level, event.text, event.agentId))
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
        // Host re-published the session view after mode/config changes or a
        // resume. The composer's occupancy ring reads the chat-list row, so
        // that row must follow the snapshot's usage too — including an absent
        // one, which must clear an older reading rather than outlive it.
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : this.state.sessions
        let chatSessions = withSessionUsage(this.state.chatSessions, event.sessionId, event.session.usage)
        chatSessions = withSessionModes(chatSessions, event.sessionId, event.session.modes)
        this.mutate({
          sessions,
          ...(chatSessions === this.state.chatSessions ? {} : { chatSessions }),
          ...this.chatSessionsService.watchedSessionPatch(event.sessionId, event.session),
        })
        return Promise.resolve()
      }
      case 'session/closed': {
        this.clearLiveSession(event.sessionId)
        this.acpSessionOwners.delete(event.sessionId)
        const closingSession = this.state.sessions.find(s => s.sessionId === event.sessionId)
        const sessions = this.state.sessions.filter(s => s.sessionId !== event.sessionId)
        const active = this.state.activeSessionId === event.sessionId ? sessions[0]?.sessionId : this.state.activeSessionId
        this.openTurns.delete(event.sessionId)
        const closedTranscripts = { ...this.state.chatTranscripts }
        delete closedTranscripts[event.sessionId]
        // The composer's chat-list view must lose the closed row too: a stale
        // entry would keep reading as a live session (the agent tag's halo
        // breathes on `!released`) until some future turn re-reads the list.
        const chatSessions = this.state.chatSessions.filter(s => s.sessionId !== event.sessionId)
        // The burst aggregate belongs to this ACP session only; another
        // session's entry must survive. Only patch when there was an entry.
        const hadBurst = this.state.burstStats[event.sessionId] !== undefined
        let burstStats = this.state.burstStats
        if (hadBurst) {
          burstStats = { ...burstStats }
          delete burstStats[event.sessionId]
        }
        this.mutate({
          sessions,
          activeSessionId: active,
          chatTranscripts: closedTranscripts,
          ...(chatSessions.length !== this.state.chatSessions.length ? { chatSessions } : {}),
          ...(hadBurst ? { burstStats } : {}),
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          elicitations: this.state.elicitations.filter(e => e.sessionId !== event.sessionId),
          ...(event.reason === 'agent-died'
            ? this.logService.patch(this.state, 'error', this.locale('会话因 agent 进程退出而终止', 'session ended: agent process died'), closingSession?.agentId)
            : {}),
        })
        return Promise.resolve()
      }
      case 'session/released': {
        // Drop queued frames from the dead process, but keep already-folded
        // `liveToolIndex` snapshots so settled cards keep enriched args/diffs
        // until `session/reset` (replay) or `session/closed`.
        this.dropPendingUpdates(event.sessionId)
        // The agent process died: keep the session visible (marked released)
        // instead of dropping it — the next prompt resumes it via session/load.
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        this.openTurns.delete(event.sessionId)
        // The composer's own list (`session/chat-list` views) must flip too, or
        // the agent tag's live halo keeps breathing for a process that is gone:
        // nothing else re-reads this list until the next turn settles.
        const chatSessions = withSessionReleased(this.state.chatSessions, event.sessionId, true, release)
        // One runtime-log line per release cause; `idle` and `archived` stay
        // silent on purpose (an expected lifecycle transition or the user's own
        // archive gesture, not a fault).
        const cause = release?.cause ?? 'died'
        let log: Partial<Pick<UiState, 'logs' | 'logUnread'>> = {}
        if (cause === 'workspace') {
          log = this.logService.patch(this.state, 'info', this.locale(
            'agent 为切换工作区重启，会话已挂起；再次发送消息将自动恢复。',
            'agent restarted for its workspace; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        } else if (cause === 'resume-failed') {
          log = this.logService.patch(this.state, 'error', this.locale(
            '会话恢复失败；再次发送消息将重试恢复。',
            'session resume failed; your next message will retry it.',
          ), event.session.agentId)
        } else if (cause === 'stalled') {
          log = this.logService.patch(this.state, 'error', this.locale(
            'agent 未响应卡死的回合，会话已挂起；再次发送消息将自动恢复。',
            'agent did not acknowledge the stalled turn; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        } else if (cause === 'died') {
          log = this.logService.patch(this.state, 'error', this.locale(
            'agent 进程已退出，会话已挂起；再次发送消息将自动恢复。',
            'agent process died; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        }
        this.mutate({
          sessions,
          ...(chatSessions !== this.state.chatSessions ? { chatSessions } : {}),
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          elicitations: this.state.elicitations.filter(e => e.sessionId !== event.sessionId),
          // An observed transcript keeps its buffer but flips to released, so
          // the ACP view can say "会恢复" instead of silently looking dead.
          ...this.chatSessionsService.watchedSessionPatch(event.sessionId, event.session),
          ...log,
        })
        return Promise.resolve()
      }
      case 'session/reset': {
        this.clearLiveSession(event.sessionId)
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
        // ...and the composer's own list must flip back to live on the same
        // event (mirror of the `session/released` flip): the released banner
        // and the tag's halo read that row, and nothing else re-reads it until
        // a turn settles — a resume would leave the banner claiming a parked
        // process that is already back.
        const chatSessions = withSessionReleased(this.state.chatSessions, event.sessionId, false)
        this.mutate({
          sessions,
          ...(chatSessions === this.state.chatSessions ? {} : { chatSessions }),
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
        // Coalesced (see `pendingUpdates`): one fold + one mutate per frame.
        this.pendingUpdates.push({ sessionId: event.sessionId, seq: event.seq, update: event.update })
        this.armUpdateFlush()
        return Promise.resolve()
      }
      case 'catalog/updated': {
        // The host learned a new catalog, or a new slash-command list, from a
        // real session (its session/new, session/load, a config_option_update,
        // or an available_commands_update). The seat list is a cached
        // projection of both, so drop and re-read it — deduped by
        // `loadAgentCatalog`, and memory-only on the host, so this never starts
        // a probe.
        this.invalidateSeatCatalog(event.agentId)
        return this.loadAgentCatalog(event.agentId)
      }
      case 'agent/exposure': {
        // The host changed an agent's model visibility outside `agent/save`.
        // Patch the settings card's copy AND drop the seat cache — the variants
        // `agent/catalog` answers are a projection of this filter. Absent means
        // the unset default-open state (every published model is offered),
        // which is NOT the same as an explicit `[]` (nothing listed); the
        // settings card needs that difference to show the right empty copy.
        const exposedModels = event.exposedModels === undefined ? undefined : [...event.exposedModels]
        // The opt-out is carried RESOLVED on the same frame; an older host half
        // omits it, and a missing field means "not opted out" (the field is
        // only ever persisted as `false`).
        const skillsMcpOff = event.skillsMcpEnabled === false
        const sharedMcpOff = event.sharedMcpEnabled === false
        const detectedAgents = this.state.detectedAgents.map(info => {
          if (info.id !== event.agentId || info.currentConfig === undefined) return info
          const currentConfig = { ...info.currentConfig, exposedModels, autoDiscoverModels: event.autoDiscoverModels, skillsMcpEnabled: skillsMcpOff ? false : undefined, sharedMcpEnabled: sharedMcpOff ? false : undefined }
          if (event.defaultMode === undefined) delete currentConfig.defaultMode
          else currentConfig.defaultMode = event.defaultMode
          return { ...info, currentConfig }
        })
        this.invalidateSeatCatalog(event.agentId)
        this.mutate({ detectedAgents })
        return this.loadAgentCatalog(event.agentId)
      }
      case 'permission/request': {
        // Verbatim copy of the host's frame. The host decides what the ask is
        // called (`toolName` / `reason`) and which options exist; deriving a
        // title from `toolCall` here used to make the card say something the
        // host never said.
        const permission: PendingPermission = {
          requestId: event.requestId,
          sessionId: event.sessionId,
          ...(event.dshSessionId === undefined ? {} : { dshSessionId: event.dshSessionId }),
          toolName: event.toolName,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          options: event.options,
          timeoutMode: event.timeoutMode,
          ...(event.deadlineAt === undefined ? {} : { deadlineAt: event.deadlineAt }),
          ...(event.askKind === undefined ? {} : { askKind: event.askKind }),
          ...(event.questionTimeoutMode === undefined ? {} : { questionTimeoutMode: event.questionTimeoutMode }),
          ...(event.autoOptionName === undefined ? {} : { autoOptionName: event.autoOptionName }),
        }
        this.mutate({
          permissions: upsertPendingRequest(this.state.permissions, permission),
        })
        return Promise.resolve()
      }
      case 'permission/resolved': {
        this.mutate({ permissions: removePendingRequest(this.state.permissions, event.requestId) })
        return Promise.resolve()
      }
      case 'permission/synced': {
        this.mutate({ permissions: syncPendingRequests(this.state.permissions, event.requestIds) })
        return Promise.resolve()
      }
      case 'elicitation/request':
      case 'elicitation/resolved':
      case 'elicitation/synced': {
        const elicitations = reduceElicitationEvent(this.state.elicitations, event)
        if (elicitations !== undefined) this.mutate({ elicitations })
        return Promise.resolve()
      }
      case 'chat/agent-locked': {
        // The host locks a conversation at the START of its first ACP turn and
        // says so at once; this frame is what makes the hand-off animation run
        // at the start rather than on the turn-settled list read. It is emitted
        // only on the transition, so it always announces a new ceremony — even
        // if a racing list read already seeded the lock itself.
        this.chatSessionsService.noteAgentLocked(event.dshSessionId)
        this.mutate({
          chatLockedAgent: { ...this.state.chatLockedAgent, [event.dshSessionId]: event.agentId },
          chatBoundAgent: { ...this.state.chatBoundAgent, [event.dshSessionId]: event.agentId },
          agentLockReveal: { ...this.state.agentLockReveal, [event.dshSessionId]: (this.state.agentLockReveal[event.dshSessionId] ?? 0) + 1 },
        })
        return Promise.resolve()
      }
      case 'chat/agent-unlocked': {
        // The first turn delivered nothing and the host rolled the lock back.
        // The base must return; the failed ACP session is closed host-side, so
        // drop a cached list that still names it and let the next read confirm.
        this.chatSessionsService.noteAgentUnlocked(event.dshSessionId)
        const chatLockedAgent = { ...this.state.chatLockedAgent }
        delete chatLockedAgent[event.dshSessionId]
        this.mutate({
          chatLockedAgent,
          ...(this.state.chatSessionsFor === event.dshSessionId ? { chatSessions: [] } : {}),
        })
        return Promise.resolve()
      }
      case 'turn/metrics': {
        // Plugin-side burst aggregate for one ACP session. A late LIVE frame
        // must not regress a turn this page already saw finalized (frames can
        // land out of order across a stream reconnect); any other frame writes
        // the entry. Blocks / sessions stay untouched — this is a metric.
        // The frame also names BOTH ids, so it refreshes the ACP→chat owner
        // mapping the worker detail index is scoped by.
        this.acpSessionOwners.set(event.sessionId, event.dshSessionId)
        const prior = this.state.burstStats[event.sessionId]
        if (event.final === false && prior !== undefined && prior.final === true && prior.turnId === event.turnId) {
          return Promise.resolve()
        }
        this.mutate({
          burstStats: {
            ...this.state.burstStats,
            [event.sessionId]: {
              outputTokens: event.outputTokens,
              burstMs: event.burstMs,
              turnId: event.turnId,
              final: event.final,
            },
          },
        })
        return Promise.resolve()
      }
      case 'turn/start': {
        if (event.dshSessionId !== undefined) this.acpSessionOwners.set(event.sessionId, event.dshSessionId)
        this.openTurns.add(event.sessionId)
        this.chatSessionsService.markWatchedRunning(event.sessionId, true)
        // Every turn starts AFTER the host (re)materialized the session: a
        // resume keeps its id, a `session/new` changes it. The composer's row
        // list is a cached snapshot, so re-read it once per turn. `force`
        // drops a read that began before this turn — its answer still names
        // the released row, and the released banner would then hang over a
        // turn that is already running on a live process. Concurrent readers
        // share this one read through the in-flight dedup.
        const chatSessionId = this.state.chatSessionsFor
        if (chatSessionId !== undefined) {
          void this.loadChatSessions(chatSessionId, { force: true })
        }
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
        this.chatSessionsService.markWatchedRunning(event.sessionId, false)
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
      case 'hmr/settled': this.saveBannersService.clearHmrDelayBanner(); return Promise.resolve()
      case 'save/status': {
        const status = normalizeSaveGateStatus(event.status)
        this.mutate({
          saveGate: status,
          ...this.saveBannersService.saveGatePatch(this.state.saveGate, status),
        })
        return Promise.resolve()
      }
      case 'subagents/record': {
        // One worker's plugin-owned lifecycle record: creation and every
        // status transition of one dispatch. Logged for the chat-list replay
        // (the answer may predate this frame), then folded by key — never by
        // `childId` alone, which can repeat across conversations.
        this.chatSessionsService.noteSubagentRecord(event.dshSessionId, event.record)
        const key = subagentKey(event.dshSessionId, event.record.childId)
        const existing = this.state.subagents[key]
        if (isSubagentDowngrade(existing, event.record)) {
          return Promise.resolve()
        }
        this.mutate({
          subagents: {
            ...this.state.subagents,
            [key]: { ...event.record, dshSessionId: event.dshSessionId },
          },
        })
        return Promise.resolve()
      }
      default:
        return Promise.resolve()
    }
  }
}

function sameUsage(left: SessionView['usage'], right: SessionView['usage']): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.used !== right.used || left.size !== right.size) return false
  const leftCost = left.cost
  const rightCost = right.cost
  if (leftCost === undefined || rightCost === undefined) return leftCost === rightCost
  return leftCost.amount === rightCost.amount && leftCost.currency === rightCost.currency
}

/** Patch one session row's usage; other rows and an unchanged value keep their identities. */
function withSessionUsage<T extends { sessionId: string; usage?: SessionView['usage'] }>(
  rows: T[],
  sessionId: string,
  usage: SessionView['usage'],
): T[] {
  let changed = false
  const next = rows.map(row => {
    if (row.sessionId !== sessionId || sameUsage(row.usage, usage)) return row
    changed = true
    return { ...row, usage }
  })
  return changed ? next : rows
}

function sameModes(a?: SessionView['modes'], b?: SessionView['modes']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.currentModeId !== b.currentModeId) return false
  const aModes = a.availableModes ?? []
  const bModes = b.availableModes ?? []
  if (aModes.length !== bModes.length) return false
  return aModes.every((m, i) => {
    const o = bModes[i]
    return m != null && o != null && m.id === o.id && m.name === o.name && m.description === o.description
  })
}

function withSessionModes<T extends { sessionId: string; modes?: SessionView['modes'] }>(
  rows: T[],
  sessionId: string,
  modes?: SessionView['modes'],
): T[] {
  if (!modes) return rows
  let changed = false
  const next = rows.map(row => {
    if (row.sessionId !== sessionId || sameModes(row.modes, modes)) return row
    changed = true
    return { ...row, modes }
  })
  return changed ? next : rows
}

/** Last well-formed `usage_update` in one coalesced batch (later ticks win). */
function usageOfBatch(items: ReadonlyArray<{ update: unknown }>): SessionView['usage'] | undefined {
  let usage: SessionView['usage'] | undefined
  for (const item of items) {
    const update = item.update as Record<string, unknown>
    if (update.sessionUpdate !== 'usage_update') continue
    const parsed = usageFromUpdate(update)
    if (parsed !== undefined) usage = parsed
  }
  return usage
}

function trimBlocks(blocks: Block[]): void {
  if (blocks.length > MAX_BLOCKS) blocks.splice(0, blocks.length - MAX_BLOCKS)
}

// ---- Pure functions and types moved out of this file (split plan P3a) ----
// Re-exported so every existing `./store.ts` import keeps resolving unchanged.

export type { Block, ReleaseDetails } from "./store/blocks.ts"
export { STATE_ONLY_UPDATES, describeEvent, foldUpdate, jsonText, replayChatRowFrames, toolDetailsOf, toolInputOf, usageFromUpdate } from "./store/blocks.ts"
export type { ChatForkOutcome, ChatForkState } from "./store/fork.ts"
export { forkStateOf } from "./store/fork.ts"
export type { PendingPermission } from "./store/permission.ts"
export { PERMISSION_DEADLINE_EXPIRED, deadlineRemainingLabel, permissionsForSession } from "./store/permission.ts"
export type { ElicitationBuildResult, ElicitationDraft, PendingElicitation } from "./store/elicitation.ts"
export { buildElicitationContent, elicitationsForSession, groupElicitationFields, initialElicitationDraft, reduceElicitationEvent } from "./store/elicitation.ts"
export { DEFAULT_KNOWN_PRESETS } from "./store/presets.ts"
export type { SaveBanner, SaveBannerAction, SaveBannerSource, SaveGateInterruptTarget, SaveGateOutcomeTransition } from "./store/save-gate.ts"
export { composeSaveBanners, saveGateAgentId, saveGateInterruptTargets, saveGateIsAvailable, saveGateOutcomeForLabel, saveGateOutcomeSuperseded, saveGateTransitions } from "./store/save-gate.ts"
export type { AgentCommand } from "./store/skills.ts"
export { MAX_SKILL_KEYS, SKILL_MENU_TTL_MS, skillRowsKey } from "./store/skills.ts"
export type { AcpLogEntry, ChatRowFrame, ChatTranscript, RpcCall, UiState } from "./store/state.ts"
export { LOG_MAX_ENTRIES } from "./store/state.ts"
export type { LiveSubagentDetailEntry, SubagentDetailState } from "./store/subagent.ts"
export { MAX_SUBAGENT_DETAIL_WORKERS, SUBAGENT_RAW_MAX, boundedDetailEntry, compactDetailValue, mergeSubagentSnapshot, subagentKey, subagentToolCallId } from "./store/subagent.ts"
