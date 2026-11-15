/**
 * Browser-side state store for the ACP panel: the `AcpStore` class, its `/acp`
 * RPC calls, the `/api/acp/stream` EventSource and the `UiState` snapshot.
 *
 * The pure halves — transcript folding, save banners, permission asks, fork
 * state, subagent records, known presets and the state shapes — live under
 * `src/client/store/` and are re-exported at the bottom of this file, so every
 * existing `./store.ts` import keeps resolving unchanged. The leaf SERVICE
 * clusters (settings writes, the built-in updater, the model catalog, the `/`
 * menu rows, worker detail indexes) live there as classes with a narrow host
 * interface; this class owns the state and delegates to them.
 *
 * Deliberately framework-free: React binds through `useSyncExternalStore`.
 */

import { DEFAULT_KNOWN_PRESETS } from "./store/presets.ts"
import type { Block } from "./store/blocks.ts"
import { foldUpdate, replayChatRowFrames, usageFromUpdate, withSessionReleased } from "./store/blocks.ts"
import type { ChatForkOutcome } from "./store/fork.ts"
import type { PendingPermission } from "./store/permission.ts"
import type { SaveBanner } from "./store/save-gate.ts"
import { composeSaveBanners, saveGateIsAvailable, saveGateOutcomeForLabel, saveGateOutcomeSuperseded, saveGateTransitions } from "./store/save-gate.ts"
import type { AcpLogEntry, ChatRowFrame, ChatTranscript, RpcCall, UiState } from "./store/state.ts"
import type { SubagentDetailState } from "./store/subagent.ts"
import { isSubagentDowngrade, mergeSubagentSnapshot, subagentKey } from "./store/subagent.ts"
import { CatalogService } from "./store/catalog.ts"
import { SettingsService } from "./store/settings.ts"
import type { AgentCommand } from "./store/skills.ts"
import { SkillsService } from "./store/skills.ts"
import { SubagentDetailService } from "./store/subagent-detail.ts"
import { UpdateService } from "./store/update.ts"

import type { AcpApprovalDeadlines, AcpConversationChoice, AcpEvent, AcpIdleRelease, AcpPresetStatus, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentSaveMode, AgentSavePayload, AgentSaveResult, AgentTestResult, AgentView, ChatSessionView, ChatTranscriptView, ApprovalDeadlinesResult, DetectedAgentInfo, IdleReleaseResult, PermissionTimeoutMode, PluginReleaseNotes, PluginUpdateState, PluginVersionResult, SaveGateFlushResult, SaveGateOutcomeView, SaveGatePendingView, SaveGateStatus, SessionView, AgentSkillEntry, SubagentDetailEntry, SubagentRecord } from '../protocol.ts'
import { DEFAULT_SAVE_GATE_TIMEOUT_MS, DEFAULT_SESSION_TITLE_PREFIX, DEFAULT_TAG_HALO } from '../protocol.ts'
import { commitFrame, consumeVerdict, invalidateVerdict, markUnsettled, peekVerdict, projectAcpMode, settleFromHost, type AcpVerdict } from './acp-verdict.ts'
import { modelOffersEffort, modelValueOf } from './route-reasoning.ts'

/** Cap on retained runtime-log lines; older entries fall off the front. */
export const LOG_MAX_ENTRIES = 200

/** sessionStorage record of persistent banners the user closed, keyed by row key. */
const SAVE_BANNER_DISMISSALS_KEY = 'dsh-ntr.save-banner-dismissals'

function readBannerDismissals(): Record<string, number> {
  try {
    const raw = globalThis.sessionStorage?.getItem(SAVE_BANNER_DISMISSALS_KEY)
    if (raw === undefined || raw === null || raw === '') return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function rememberBannerDismissal(banner: SaveBanner): void {
  if (banner.persistAcrossReload !== true || banner.level !== 'error') return
  try {
    const dismissed = readBannerDismissals()
    dismissed[banner.key] = banner.at
    globalThis.sessionStorage?.setItem(SAVE_BANNER_DISMISSALS_KEY, JSON.stringify(dismissed))
  } catch {
    // Storage can be unavailable (private mode); the in-memory row is still closed.
  }
}

function wasClosedAcrossReload(banner: SaveBanner): boolean {
  if (banner.persistAcrossReload !== true) return false
  return readBannerDismissals()[banner.key] === banner.at
}

function normalizeSaveGateStatus(status: SaveGateStatus): SaveGateStatus {
  return { ...status, gateAvailable: saveGateIsAvailable(status) }
}

interface Listener { (): void }

const MAX_BLOCKS = 400
/** How many observed ACP transcripts stay live at once (insertion-ordered eviction). */
const MAX_WATCHED = 6

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
  /** Monotonic id source for {@link AcpLogEntry}s (never reset by `clearLogs`). */
  private logSeq = 0
  /**
   * What a banner's retry/force button can actually do. Kept out of UiState so
   * the snapshot stays plain data; a dismissed banner drops its entry, which is
   * why the same failure can show again next time.
   */
  private readonly bannerRetries = new Map<string,
    | { kind: 'gate'; label: string }
    | { kind: 'cancel'; label: string }
    | { kind: 'flush' }
    | { kind: 'payload'; payload: AgentSavePayload }
  >()
  private readonly lastSeq = new Map<string, number>()
  /** Sessions with a finalized turn (dedups the cancel-fallback + late real turn/end pair). */
  private readonly openTurns = new Set<string>()
  /** In-flight `session/chat-list` reads, keyed by chat session id. */
  private readonly chatSessionReads = new Map<string, { dropped: boolean; done: Promise<void> }>()
  /**
   * Monotonic order plus a short log of chat-row lifecycle frames. Read
   * starts capture the sequence; the answer replays every later frame over
   * its row list. Bounded — a read only needs the frames since it started, and
   * a page that never reconnects cannot grow this without bound.
   */
  private chatRowFrameSeq = 0
  private readonly chatRowFrames: ChatRowFrame[] = []
  /**
   * Chat sessions whose list has answered at least once in this page. The
   * FIRST answer only seeds the lock; a lock appearing on a later answer is a
   * transition this page actually witnessed, and only that one is announced via
   * {@link UiState.agentLockReveal}.
   */
  private readonly chatListLoaded = new Set<string>()
  /**
   * Conversations whose provisional first-turn lock the host rolled back
   * (`chat/agent-unlocked`, no visible output in the first turn). A
   * `session/chat-list` read that started BEFORE the rollback can still name
   * `lockedAgentId`; it must not revive the lock. A new `chat/agent-locked`
   * frame clears the entry (the user retried and the turn really started).
   */
  private readonly chatUnlocked = new Set<string>()
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
   * Monotonic order plus a short log of applied `subagents/record` frames: a
   * `session/chat-list` answer can describe the host as of BEFORE a frame that
   * landed while the read was in flight, and the answer replays the later
   * frames over its snapshot.
   */
  private subagentRecordSeq = 0
  private readonly subagentRecordFrames: Array<{ seq: number; dshSessionId: string; record: SubagentRecord }> = []
  /**
   * ACP session id → owning DSH chat session id, learned from chat-list rows
   * and `turn/metrics` frames. Live `session/update` frames carry only the ACP
   * session, and a detail entry must land under the conversation that owns it
   * (`toolCallId`s can repeat across conversations).
   */
  private readonly acpSessionOwners = new Map<string, string>()
  /**
   * When the seat gate last asked the host for a session's verdict (epoch ms).
   * Kept apart from {@link acpVerdicts} so a held verdict is re-asked per TTL.
   */
  private readonly acpAsked = new Map<string, number>()
  /** Counts behind the last successful explicit re-detect, so a locale switch can re-render its summary. */
  private detectCounts: { total: number; installed: number } | undefined

  /**
   * The leaf services. Each owns only its own bookkeeping (throttle windows,
   * in-flight dedup, LRU counters) and writes through the host interface this
   * class hands it — so `mutate` stays the single writer and every broadcast
   * keeps the merge/ordering semantics the class had when these were methods.
   */
  private readonly settingsService: SettingsService
  private readonly updateService: UpdateService
  private readonly catalogService: CatalogService
  private readonly skillsService: SkillsService
  private readonly subagentDetailService: SubagentDetailService

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

  private mutate(patch: Partial<UiState>, blocksChanged = false): void {
    this.state = {
      ...this.state,
      ...patch,
      blocks: blocksChanged ? [...this.state.blocks] : patch.blocks ?? this.state.blocks,
    }
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Build the log patch for one line. Does NOT mutate: the caller merges it
   * into the single `mutate` call it was already making for the same event.
   */
  private logPatch(level: 'info' | 'error', text: string, agentId?: string): Pick<UiState, 'logs' | 'logUnread'> {
    const entry: AcpLogEntry = {
      id: ++this.logSeq,
      at: Date.now(),
      level,
      text,
      ...(agentId === undefined ? {} : { agentId }),
    }
    return {
      logs: [...this.state.logs, entry].slice(-LOG_MAX_ENTRIES),
      logUnread: this.state.logUnread + 1,
    }
  }

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
    for (const [sessionId, items] of bySession) {
      const last = items[items.length - 1]
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
    if (Object.keys(patch).length > 0) this.mutate(patch)
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
      const [{ agents }, { sessions }, defaultAgentInfo, detectResult, presetResult, tagHaloResult, titlePrefixResult, deadlinesResult, idleReleaseResult, saveGateResult, versionResult] = await Promise.all([
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
        // `undefined` (older half) hides the deadline card instead of showing a
        // number this browser made up.
        this.call<ApprovalDeadlinesResult>('ui/approval-deadlines').catch(() => ({ deadlines: undefined })),
        // `undefined` (older half) hides the tab instead of showing a
        // number this browser made up.
        this.call<IdleReleaseResult>('ui/idle-release').catch(() => ({ idleRelease: undefined })),
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
        approvalDeadlines: deadlinesResult.deadlines,
        idleRelease: idleReleaseResult.idleRelease,
        ...(nextSaveGate === undefined ? {} : { saveGate: nextSaveGate }),
        // A refresh must rebuild the terminal rows it missed, not only the
        // gate snapshot: the SSE frame that produced them is gone.
        ...(nextSaveGate === undefined
          ? {}
          : this.saveGatePatch(this.state.saveGate, nextSaveGate, false, true)),
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

  async detectAgents(): Promise<void> {
    this.mutate({ detecting: true })
    try {
      const result = await this.call<{ agents: DetectedAgentInfo[] }>('agents/detect')
      const agents = result.agents.length > 0 ? result.agents : [...DEFAULT_KNOWN_PRESETS]
      const installed = agents.filter(agent => agent.detected).length
      this.detectCounts = { total: agents.length, installed }
      this.mutate({
        detectedAgents: agents,
        detecting: false,
        detectSummary: this.detectSummaryOf(agents.length, installed),
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agents/detect')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活主机检测功能。', 'Host running older version. Please restart dsh web to enable agent detection.')
        : msg
      this.detectCounts = undefined
      this.mutate({
        detecting: false,
        notice,
        detectedAgents: this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS],
        // A failed re-detect must not keep showing the previous run's success line.
        detectSummary: undefined,
      })
    }
  }

  private detectSummaryOf(total: number, installed: number): string {
    return this.locale(
      `已检测 ${String(total)} 个预设：${String(installed)} 个已安装，其余可从「添加智能体」启用。`,
      `Detected ${String(total)} presets: ${String(installed)} installed, enable the rest via "Add agent".`,
    )
  }

  /**
   * Read the host's save gate before a settings save. The host remains the
   * authority (`agent/save` re-checks), but this lets the form show its
   * confirmation without racing a turn.
   */
  async readSaveGate(): Promise<SaveGateStatus> {
    const result = await this.call<{ status: SaveGateStatus }>('save/status')
    const status = normalizeSaveGateStatus(result.status)
    this.mutate({ saveGate: status })
    return status
  }

  /**
   * Save one agent definition. `mode` is the user's explicit gesture:
   * `direct` is the no-turn path, `defer` queues behind turns, `force` flushes
   * the gate and interrupts. The host returns `confirmationRequired` when a
   * turn exists and no explicit mode was supplied; the caller must ask.
   */
  async saveAgent(payload: AgentSavePayload, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    try {
      const result = await this.call<AgentSaveResult>('agent/save', { ...payload, saveMode: mode })
      // A delete won the race: the host aborted silently and wrote nothing.
      // Re-reading the roster or probing the id would chase an agent that no
      // longer exists (and a probe could resurrect its model surface).
      if (result.cancelled === true) return result
      if (result.confirmationRequired || result.deferred) return result
      // This write landed: earlier "not written" receipts for the same agent
      // would now contradict the fresh success. Other agents' rows stay.
      this.clearAgentSaveFailures(payload.id)
      await this.resync()
      // The host probes the catalog right after a save; pull the fresh result
      // so the agent card fills in without a second click.
      void this.probeModels(payload.id)
      return result
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'agent_deleted') {
        // The id is gone for this host run. Offer no retry/force gesture: both
        // would recreate exactly what the user removed, and the host will keep
        // refusing it until a restart.
        this.rememberDeletedAgent(payload.id)
        const key = `save-failed:${payload.id}`
        this.bannerRetries.delete(key)
        const text = this.label(
          '该 Agent 已被删除，本次保存已取消。',
          'This agent was deleted, so this save was cancelled.',
        )
        this.pushSaveBanner({
          key,
          source: 'save-failed',
          level: 'error',
          title: this.label('保存已取消', 'Save cancelled'),
          body: text,
          at: Date.now(),
          actions: ['dismiss'],
          label: `agent-save:${payload.id}`,
        })
        this.mutate({ notice: text })
        throw error
      }
      const key = code === 'confirmation_required' ? `save-rejected:${payload.id}` : `save-failed:${payload.id}`
      const label = `agent-save:${payload.id}`
      const body = code === 'confirmation_required'
        ? this.label(
            '目标 Agent 还有进行中的会话，本轮保存被拒绝。请选择「回合结束后保存」或「立即保存（中断该 Agent）」。',
            'The target agent still has running turns, so the save was refused. Choose "save after turns" or "save now (interrupt this agent)".',
          )
        : this.label(
            `配置未写入：${error instanceof Error ? error.message : String(error)}`,
            `The setting was not written: ${error instanceof Error ? error.message : String(error)}`,
          )
      this.bannerRetries.set(key, { kind: 'payload', payload })
      this.pushSaveBanner({
        key,
        source: code === 'confirmation_required' ? 'save-rejected' : 'save-failed',
        level: 'error',
        title: code === 'confirmation_required'
          ? this.label('保存被拒绝', 'Save refused')
          : this.label('保存失败', 'Save failed'),
        body,
        at: Date.now(),
        actions: ['retry', 'force', 'dismiss'],
        label,
      })
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

  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.call('agent/delete', { agentId })
      this.rememberDeletedAgent(agentId)
      await this.resync()
      // A retained retry payload would rebuild the agent just deleted. Drop the
      // rows (and their retry entries) after the resync too, so a late status
      // snapshot cannot put them back.
      this.clearAgentSaveBanners(agentId)
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

  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   */
  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   *
   * `settleVerdict` is the seat gate's own re-ask and the ONLY read allowed to
   * settle a verdict a frame had already settled (see {@link acpVerdicts}): the
   * gate holds such a verdict as its only fact source while the session row
   * stays silent, and a host read is the one place a switch the runtime never
   * framed can still be learned from. Composer readers pass nothing and keep
   * the frame's authority.
   */
  loadChatSessions(dshSessionId: string, options?: { settleVerdict?: boolean; force?: boolean }): Promise<void> {
    // The composer entries (agent-mode control, ACP cluster, occupancy ring)
    // read this and re-read when a turn settles; one round-trip answers for
    // all of them instead of racing reads. A caller arriving mid-read waits
    // for THAT read rather than returning immediately: the slash source's
    // one-shot "do I have a verdict yet?" ask is only useful if it can
    // receive the answer of a read already in flight.
    //
    // `force` belongs to a caller that knows the host state JUST changed (a
    // turn started, an explicit resume finished, the stream reconnected). A
    // read that began before that change still names the old released row,
    // and the dedup above would otherwise hand this caller that stale answer.
    // Dropping it first makes this call ask the host again. The dropped read
    // still resolves for its own caller; `read.dropped` makes it write nothing.
    if (options?.force === true) this.abandonChatSessionRead(dshSessionId)
    const inFlight = this.chatSessionReads.get(dshSessionId)
    if (inFlight !== undefined) return inFlight.done
    const read: { dropped: boolean; done: Promise<void> } = { dropped: false, done: Promise.resolve() }
    this.chatSessionReads.set(dshSessionId, read)
    read.done = this.readChatSessionList(dshSessionId, options, read)
    return read.done
  }

  private async readChatSessionList(
    dshSessionId: string,
    options: { settleVerdict?: boolean; force?: boolean } | undefined,
    read: { dropped: boolean },
  ): Promise<void> {
    const settle = options?.settleVerdict === true || peekVerdict(this.acpVerdicts, dshSessionId)?.kind !== 'frame'
    // Captured BEFORE the request: every frame applied after this point is
    // newer than whatever state the host will answer with.
    const subagentRecordFramesAtRead = this.subagentRecordSeq
    const chatRowFramesAtRead = this.chatRowFrameSeq
    try {
      const { sessions: listed = [], acpMode, boundAgentId, lockedAgentId, choice } = await this.call<{ sessions: ChatSessionView[]; acpMode?: boolean; boundAgentId?: string; lockedAgentId?: string; choice?: AcpConversationChoice }>('session/chat-list', { dshSessionId, refresh: true })
      // The host answer can still describe the released row it had when this
      // read started. Replay the lifecycle frames that landed in the meantime:
      // a resume's `session/reset` flips the row back to live, a crash's
      // `session/released` parks it, a close drops it. Without this the late
      // answer overwrites the frame and the released banner survives a turn
      // that is already running on a live process.
      const sessions = replayChatRowFrames(listed, this.chatRowFrames, chatRowFramesAtRead)
      // A committed `agent-preset/selected` frame may have settled this
      // session's verdict while the read was in flight; the host answer then
      // describes the log as of BEFORE that switch and must not overwrite it.
      if (read.dropped) return
      // The first answer for a conversation only seeds what is already true: a
      // lock reported there belongs to an earlier page. A lock that appears on
      // a LATER answer is the first-turn transition unfolding in front of the
      // user, and only that one is announced to the hand-off animation.
      const firstAnswer = !this.chatListLoaded.has(dshSessionId)
      this.chatListLoaded.add(dshSessionId)
      // The lock is one-way, so a read that no longer reports one is an older
      // host half, not an unlock: keep what we already know in that case. The
      // one explicit unlock is the host's rollback frame, tracked separately.
      // A read that AGREES there is no lock clears the rollback marker, so a
      // later legitimate lock (even with its frame missed) is accepted again.
      if (lockedAgentId === undefined) this.chatUnlocked.delete(dshSessionId)
      const reportedLock = lockedAgentId !== undefined && this.chatUnlocked.has(dshSessionId)
        ? undefined
        : lockedAgentId
      const chatLockedAgent = reportedLock === undefined
        ? this.state.chatLockedAgent
        : { ...this.state.chatLockedAgent, [dshSessionId]: reportedLock }
      const witnessedLock = !firstAnswer
        && reportedLock !== undefined
        && this.state.chatLockedAgent[dshSessionId] === undefined
      const agentLockReveal = witnessedLock
        ? { ...this.state.agentLockReveal, [dshSessionId]: (this.state.agentLockReveal[dshSessionId] ?? 0) + 1 }
        : this.state.agentLockReveal
      // The plugin's own lifecycle records: REPLACED for this conversation and
      // refreshed for every other one, then replayed over by the
      // `subagents/record` frames that landed while this read was in flight
      // (an in-flight terminal must beat an older snapshot row). Rows of this
      // conversation also teach the ACP-session→conversation map the live
      // detail index is scoped by.
      for (const row of sessions) this.acpSessionOwners.set(row.sessionId, dshSessionId)
      const subagents = mergeSubagentSnapshot(
        this.state.subagents,
        dshSessionId,
        sessions,
        this.subagentRecordFrames,
        subagentRecordFramesAtRead,
      )
      this.mutate({
        chatSessions: sessions,
        chatSessionsFor: dshSessionId,
        chatLockedAgent,
        agentLockReveal,
        subagents,
        // The host's binding (intent + live-session fallback) outranks the
        // optimistic entry this store wrote on the click; a host without the
        // field (older half) simply leaves the optimistic value standing.
        ...(boundAgentId === undefined
          ? {}
          : { chatBoundAgent: { ...this.state.chatBoundAgent, [dshSessionId]: boundAgentId } }),
        // The persisted pick (model + thought level) — the host's record,
        // present before any ACP session exists. Merged over the optimistic
        // entry so a value a click just wrote is not erased by a read that
        // started before the click landed.
        ...(choice === undefined
          ? {}
          : { chatChoice: { ...this.state.chatChoice, [dshSessionId]: choice } }),
        // The seat gate's fallback fact source: absent on an older host half,
        // which then simply never takes the seat over (the allowed failure).
        // A frame-settled verdict outranks any read, whenever it lands: the
        // host's log read can lag a switch by one, and taking the model seat
        // re-mounts readers, so a stale answer would otherwise regress it.
        ...(acpMode === undefined || !settle
          ? {}
          : { acpMode: this.commitHostVerdict(dshSessionId, acpMode === true) }),
      })
      // A read that answered but carried no verdict has NOT settled this
      // session. The gate's ask ledger is one-shot per id, so unless the id is
      // retracted here it stays marked "asked" forever and the gate never asks
      // again — one silent round-trip and the native model seat is permanent
      // for that session. The gate re-derives this from `hasAcpModeVerdict`
      // on its next evaluation (every store mutation re-runs it), which is
      // what makes the fallback recoverable instead of a single coin flip.
      if (acpMode === undefined && settle) {
        markUnsettled(this.acpVerdicts, dshSessionId)
      }
    } catch {
      // A host without this surface (older build) has nothing to show; the
      // control simply renders nothing rather than an error nobody can act on.
      if (read.dropped) return
      this.mutate({ chatSessions: [], chatSessionsFor: dshSessionId })
      if (settle) {
        markUnsettled(this.acpVerdicts, dshSessionId)
      }
    } finally {
      if (this.chatSessionReads.get(dshSessionId) === read) this.chatSessionReads.delete(dshSessionId)
    }
  }

  /**
   * Abandon the in-flight `session/chat-list` read for one session (or all of
   * them): a committed `agent-preset/selected` frame carries the authoritative
   * verdict, and the late answer to an ask that predates the frame describes
   * the log from before the switch — it must not land in the store.
   */
  abandonChatSessionRead(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      for (const read of this.chatSessionReads.values()) read.dropped = true
      this.chatSessionReads.clear()
      return
    }
    const read = this.chatSessionReads.get(dshSessionId)
    if (read === undefined) return
    read.dropped = true
    this.chatSessionReads.delete(dshSessionId)
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
    try {
      await this.call('session/chat-mode-set', { dshSessionId, modeId, ...(agentId === undefined ? {} : { agentId }) })
      const safeAgent = (agentId && agentId.trim()) || undefined
      this.writeChoice(dshSessionId, choice => ({ ...choice, mode: modeId }), safeAgent)
      if (this.state.chatSessionsFor === dshSessionId) {
        const owner = safeAgent ?? this.state.chatChoice[dshSessionId]?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
        let changed = false
        const chatSessions = this.state.chatSessions.map(s => {
          if (s.agentId !== owner || !s.modes || s.modes.currentModeId === modeId) return s
          changed = true
          return { ...s, modes: { ...s.modes, currentModeId: modeId } }
        })
        if (changed) this.mutate({ chatSessions })
      }
    } catch (error) {
      this.flashError(error)
    }
    await this.loadChatSessions(dshSessionId)
  }

  /**
   * Bring the conversation's released ACP session back on a fresh process —
   * the released banner's explicit form of the "next message resumes it"
   * promise (`session/chat-resume`). A failure is reported through the notice
   * AND rethrown (the `respondPermission` contract), so the banner can pin
   * the message beside the button the user just pressed; the binding is
   * re-read either way so the row follows the host's real answer.
   */
  async resumeChatSession(dshSessionId: string): Promise<void> {
    let failure: unknown
    try {
      await this.call('session/chat-resume', { dshSessionId })
    } catch (error) {
      this.flashError(error)
      failure = error
    }
    // `force`: the host answer this call needs is the one AFTER the resume.
    // The host's no-op branch (already live) broadcasts no frame at all, so
    // reusing a read that started before the click would keep the released row.
    await this.loadChatSessions(dshSessionId, { force: true })
    if (failure !== undefined) throw failure
  }

  /**
   * Branch one conversation (the NTR branch button's click): the fixed
   * two-stage order — the HOST forks the DSH session tree first (copied
   * history, `(1)` title, workspace), then the plugin adopts the ACP side via
   * `session/chat-fork-adopt`, which runs the agent's own `session/fork` so
   * the child actually remembers the parent context. Host first is structural:
   * ACP fork has no cut-point parameter and nothing to return to if the host
   * half failed second (see the plan's §D7).
   *
   * Resolves `{ childId }` on success, or `{ failure }` with one actionable
   * line — the reason is ALSO flashed into the notice banner (a user-action
   * failure, so the banner is its surface), and the local line is what the
   * conversation renders beside the button (the user is not on the settings
   * page). A failed adopt leaves the child an ordinary copied-history
   * conversation (its first message starts a fresh `session/new` — today's
   * behavior), never a half-bound one, and NOTHING is opened.
   *
   * `forkHost` is the runtime's `sessions.fork` face, resolved structurally by
   * the entry and injected here: the store stays transport-free.
   */
  async forkChatSession(
    dshSessionId: string,
    forkHost: (sessionId: string) => Promise<unknown>,
  ): Promise<ChatForkOutcome> {
    let childId: unknown
    try {
      childId = await forkHost(dshSessionId)
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      this.flashError(failure)
      return { failure }
    }
    if (typeof childId !== 'string' || childId === '') {
      const failure = this.locale(
        '宿主没有返回分支会话，分支未完成。',
        'The host returned no branched session; the branch did not complete.',
      )
      this.flashError(new Error(failure))
      return { failure }
    }
    try {
      await this.call('session/chat-fork-adopt', { dshSessionId: childId, parentDshSessionId: dshSessionId })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failure = this.locale(
        `分支会话已创建，但没有接上 agent 的上下文（${reason}）；在子会话里发送的第一条消息会开启全新会话。`,
        `The branched session was created but the agent context was not attached (${reason}); its first message will start a fresh session.`,
      )
      this.flashError(new Error(failure))
      return { failure }
    }
    return { childId }
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

  /**
   * Answer one ask (`optionId` absent = cancel it). A failure is reported
   * through the store's notice — the settings panel renders that — AND
   * rethrown, so the conversation dock can pin the message next to the card
   * that failed instead of leaving it on a settings page the user may not
   * have open. Callers that cannot show it (the settings panel) swallow it
   * after the notice.
   */
  async respondPermission(requestId: string, optionId?: string): Promise<void> {
    try {
      await this.call('permission/respond', { requestId, ...(optionId === undefined ? {} : { optionId }) })
    } catch (error) {
      this.flashError(error)
      throw error
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

  /**
   * Explicit "强制保存": flush the host's held profile writes now, even while
   * an ACP turn is running. The gate broadcasts its new state; the extra
   * `save/status` read is the fallback for a host that resolves the flush
   * before its own frame lands. A transport failure gets its own visible row —
   * the caller's `.finally` must never be the only thing that runs.
   */
  async forceSaveGate(): Promise<SaveGateFlushResult> {
    try {
      return await this.flushHeldSaves()
    } catch (error) {
      this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
      throw error
    }
  }

  /** Run `save/flush`, then fold its answer into banners and the gate snapshot. */
  private async flushHeldSaves(): Promise<SaveGateFlushResult> {
    // Capture what this flush was asked to write BEFORE the call: only the
    // gate's terminal rows afterwards can tell which of those labels failed.
    const heldLabels = this.state.saveGate.pending.map(entry => entry.label)
    const result = await this.call<SaveGateFlushResult>('save/flush')
    const status = await this.call<{ status: SaveGateStatus }>('save/status').catch(() => null)
    const next = status?.status === undefined ? undefined : normalizeSaveGateStatus(status.status)
    if (next !== undefined) this.mutate({ saveGate: next })
    this.reportFlushResult(result, heldLabels, next)
    return result
  }

  /**
   * Drop one held profile write by label. The settings form uses this when the
   * user edits the form after choosing "save after turns": flushing that old
   * snapshot later would silently overwrite the newer values.
   *
   * Only a numeric, positive cancellation count is success. A missing or
   * non-numeric answer leaves the held state in place and warns: the host
   * clearly answered, but it did not prove the write was dropped.
   */
  async cancelSaveGate(label: string): Promise<boolean> {
    let result: { cancelled?: number } | undefined
    try {
      result = await this.call<{ cancelled?: number }>('save/cancel', { label })
    } catch (error) {
      this.flashError(error)
      this.pushSaveCancelFailedBanner(label)
      return false
    }
    const cancelled = result?.cancelled
    if (typeof cancelled !== 'number') {
      this.pushSaveCancelFailedBanner(label)
      return false
    }
    if (cancelled > 0) {
      this.dropPendingLocally(label)
      return true
    }
    // `0` can also mean "the frame raced ahead of the status snapshot". Re-read
    // before warning; only a label still queued (or no matching terminal row)
    // is a real failure.
    try {
      const status = await this.readSaveGate()
      const stillPending = status.pending.some(entry => entry.label === label)
      const outcome = saveGateOutcomeForLabel(status, label)
      if (!stillPending && outcome?.status === 'cancelled') {
        this.dropPendingLocally(label)
        return true
      }
    } catch (error) {
      this.flashError(error)
    }
    this.pushSaveCancelFailedBanner(label)
    return false
  }

  /** Re-run a failed/expired held write through the host gate. */
  async retrySaveGate(label: string): Promise<'retried' | 'none' | 'error'> {
    try {
      const result = await this.call<{ retried?: unknown }>('save/retry', { label })
      if (result.retried === true) {
        // A status frame is already on its way; this read closes the gap when
        // the host resolves the retry before broadcasting.
        await this.readSaveGate().catch(() => { /* the status frame remains authoritative */ })
        return 'retried'
      }
      if (result.retried === false) return 'none'
      // A malformed answer is not "nothing to retry": reporting that would
      // hide a real host problem behind a success receipt.
      throw new Error(this.label(
        '宿主返回了无法识别的重试结果。',
        'The host returned an unrecognised retry result.',
      ))
    } catch (error) {
      this.pushSaveRetryFailedBanner(label, this.errorText(error))
      return 'error'
    }
  }

  private dropPendingLocally(label: string): void {
    const next = this.state.saveGate.pending.filter(entry => entry.label !== label)
    if (next.length === this.state.saveGate.pending.length) {
      // Still clear a stale "cancel did not take effect" row on a success.
      this.dismissBanner(`save-cancel-failed:${label}`)
      return
    }
    this.mutate({
      saveGate: {
        ...this.state.saveGate,
        pending: next,
      },
      saveBanners: this.state.saveBanners.filter(banner => banner.key !== `save-cancel-failed:${label}`),
    })
    this.bannerRetries.delete(`save-cancel-failed:${label}`)
  }

  /**
   * The banner's "知道了": remove it, and let the same failure reappear later.
   * `at` names the row that owns the gesture. An auto-dismiss timer passes the
   * timestamp it was registered with, so a NEWER row sharing the key survives.
   */
  dismissBanner(key: string, at?: number): void {
    const current = this.state.saveBanners.find(banner => banner.key === key)
    if (current === undefined) {
      this.bannerRetries.delete(key)
      return
    }
    if (at !== undefined && current.at !== at) return
    rememberBannerDismissal(current)
    this.bannerRetries.delete(key)
    this.mutate({ saveBanners: this.state.saveBanners.filter(banner => banner.key !== key) })
  }

  /** The banner's "重试": re-run the retained host write or the rejected save. */
  async retryBanner(key: string): Promise<void> {
    const action = this.bannerRetries.get(key)
    if (action === undefined) {
      this.dismissBanner(key)
      return
    }
    if (action.kind === 'cancel') {
      this.dismissBanner(key)
      const cancelled = await this.cancelSaveGate(action.label)
      // A failed retry re-adds its own "cancel did not take effect" row.
      if (cancelled) this.pushSaveCancelledBanner(action.label)
      return
    }
    if (action.kind === 'gate') {
      const outcome = await this.retrySaveGate(action.label)
      if (outcome === 'error') {
        // Keep the original failure row AND the new error receipt: an RPC
        // failure is not evidence that nothing was left to retry.
        return
      }
      this.dismissBanner(key)
      // "重试" never silently escalates to a force flush: a force can interrupt
      // a running turn, and that is a separate, explicit gesture.
      if (outcome === 'none') this.pushSaveRetryNoneBanner(action.label)
      return
    }
    if (action.kind === 'flush') {
      await this.retryFlushBanner(key)
      return
    }
    this.dismissBanner(key)
    try {
      await this.saveAgent(action.payload, 'defer')
    } catch { /* the failure banner has already been replaced */ }
  }

  /** The banner's "强制保存": flush the gate or force the rejected payload. */
  async forceBanner(key: string): Promise<void> {
    const action = this.bannerRetries.get(key)
    if (action?.kind === 'payload') {
      this.dismissBanner(key)
      try {
        await this.saveAgent(action.payload, 'force')
      } catch { /* the failure banner has already been replaced */ }
      return
    }
    // A gate failure/expiry row is settled by the flush itself; a transport
    // error becomes a fresh visible receipt. The partial row is different: it
    // must survive until a flush actually clears every held write.
    if (action?.kind === 'gate') {
      this.dismissBanner(key)
      try {
        await this.flushHeldSaves()
      } catch (error) {
        this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
      }
      return
    }
    await this.retryFlushBanner(key)
  }

  /**
   * Retry/force one `save-partial` row. The original partial row survives a
   * transport failure; only an all-saved flush clears it. A partially completed
   * retry replaces the row through {@link reportFlushResult} instead.
   */
  private async retryFlushBanner(key: string): Promise<void> {
    const beforeAt = this.state.saveBanners.find(banner => banner.key === key)?.at
    try {
      const result = await this.flushHeldSaves()
      const remaining = (result.expired ?? 0) + (result.failed ?? 0)
      if (remaining === 0) this.dismissBanner(key, beforeAt)
    } catch (error) {
      this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
    }
  }

  /** Translate one force-flush result into a success or partial-failure banner. */
  private reportFlushResult(
    result: SaveGateFlushResult,
    heldLabels: readonly string[] = [],
    status?: SaveGateStatus,
  ): void {
    const expired = result.expired ?? 0
    const failed = result.failed ?? 0
    const failedLabels = status === undefined
      ? []
      : heldLabels.filter(label => {
        const outcome = saveGateOutcomeForLabel(status, label)
        return outcome?.status === 'failed' || outcome?.status === 'expired'
      })
    if (expired > 0 || failed > 0) {
      const key = 'save-partial'
      this.bannerRetries.set(key, { kind: 'flush' })
      const named = failedLabels.length === 0
        ? ''
        : this.label(` 未写入：${failedLabels.join('、')}。`, ` Not written: ${failedLabels.join(', ')}.`)
      this.pushSaveBanner({
        key,
        source: 'save-partial',
        level: 'error',
        title: this.label('强制保存只完成一部分', 'Forced save only partly completed'),
        body: this.label(
          `已保存 ${String(result.saved)} 项，失败 ${String(failed)} 项，过期 ${String(expired)} 项${result.cancelled ? `，取消 ${String(result.cancelled)} 项` : ''}。请重试。${named}`,
          `${String(result.saved)} saved, ${String(failed)} failed, ${String(expired)} expired${result.cancelled ? `, ${String(result.cancelled)} cancelled` : ''}. Please retry.${named}`,
        ),
        at: Date.now(),
        actions: ['retry', 'dismiss'],
      })
      return
    }
    if (result.saved > 0) {
      const savedLabels = status === undefined
        ? []
        : heldLabels.filter(label => saveGateOutcomeForLabel(status, label)?.status === 'saved')
      this.pushSaveSuccessBanner(result.saved, savedLabels)
    }
  }

  /**
   * A success receipt names the agent (or the non-agent label) it belongs to.
   * Several agents settling in one frame share ONE row whose body lists every
   * one of them, so the last settlement cannot erase the others' identity.
   */
  private saveSuccessBanner(saved: number, labels: string[] = []): SaveBanner {
    const subjects = labels.map(label => this.saveSubjectOf(label))
    const count = saved > 1
      ? this.label(`已保存 ${String(saved)} 项配置`, `${String(saved)} settings were saved`)
      : undefined
    const body = subjects.length === 0
      ? (count === undefined ? this.label('已保存。', 'Saved.') : `${count}。`)
      : subjects.length > 3
        ? this.label(
          `已保存：${subjects.slice(0, 3).join('、')} 等 ${String(subjects.length)} 个。`,
          `Saved: ${subjects.slice(0, 3).join(', ')}, ${String(subjects.length)} total.`,
        )
        : this.label(`已保存：${subjects.join('、')}。`, `Saved: ${subjects.join(', ')}.`)
    return {
      key: 'save-succeeded',
      source: 'save-succeeded',
      level: 'success',
      title: this.label('保存成功', 'Saved'),
      body,
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    }
  }

  private saveSubjectOf(label: string): string {
    const prefix = 'agent-save:'
    if (!label.startsWith(prefix)) return label
    const agentId = label.slice(prefix.length)
    const configured = this.state.agents.find(agent => agent.id === agentId)
    const detected = this.state.detectedAgents.find(agent => agent.id === agentId)
    return configured?.title ?? detected?.name ?? agentId
  }

  private pushSaveSuccessBanner(saved: number, labels: string[] = []): void {
    this.pushSaveBanner(this.saveSuccessBanner(saved, labels))
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** One visible receipt for a retry/force that failed before any settlement. */
  private pushSaveRetryFailedBanner(label: string | undefined, message: string): void {
    this.pushSaveBanner({
      key: `save-retry-failed:${label ?? 'flush'}`,
      source: 'save-retry-failed',
      level: 'error',
      title: this.label('重试失败', 'Retry failed'),
      body: this.label(`重试没有完成：${message}`, `The retry did not complete: ${message}`),
      at: Date.now(),
      actions: ['dismiss'],
      ...(label === undefined ? {} : { label }),
    })
  }

  private pushSaveCancelledBanner(label: string): void {
    this.pushSaveBanner({
      key: `save-cancelled:${label}`,
      source: 'save-cancelled',
      level: 'success',
      title: this.label('已取消暂存', 'Held save cancelled'),
      body: this.label(
        '回合结束后不会写入点击时的版本。',
        'The values from the moment you clicked will not be written when the turn ends.',
      ),
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    })
  }

  private pushSaveCancelFailedBanner(label: string): void {
    const key = `save-cancel-failed:${label}`
    this.bannerRetries.set(key, { kind: 'cancel', label })
    this.pushSaveBanner({
      key,
      source: 'save-cancel-failed',
      level: 'error',
      title: this.label('取消未生效', 'Cancel did not take effect'),
      body: this.label(
        '取消未生效，回合结束会写入点击时版本。',
        'The cancel did not take effect. The values from the moment you clicked will be written when the turn ends.',
      ),
      at: Date.now(),
      actions: ['retry', 'dismiss'],
      label,
    })
  }

  private pushSaveRetryNoneBanner(label: string): void {
    this.pushSaveBanner({
      key: `save-retry-none:${label}`,
      source: 'save-retry-none',
      level: 'success',
      title: this.label('已无待重试项', 'Nothing left to retry'),
      body: this.label('该配置已不在待重试的队列中。', 'That setting is no longer waiting to be retried.'),
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    })
  }

  /** Record an id the host deleted during this run (session-only tombstone). */
  private rememberDeletedAgent(agentId: string): void {
    if (agentId === '' || this.state.deletedAgentIds.includes(agentId)) return
    this.mutate({ deletedAgentIds: [...this.state.deletedAgentIds, agentId] })
  }

  /**
   * The failure/expiry rows that a successful save of `label` retires. Scoped to
   * the same agent (or the same non-agent setting) so another agent's failure
   * receipts survive.
   */
  private saveFailureKeysFor(label: string): Set<string> {
    const keys = new Set([`save-failed:${label}`, `save-expired:${label}`])
    const prefix = 'agent-save:'
    if (label.startsWith(prefix)) {
      const agentId = label.slice(prefix.length)
      keys.add(`save-failed:${agentId}`)
      keys.add(`save-rejected:${agentId}`)
    }
    return keys
  }

  /**
   * A successful save retires that agent's older failure receipts: leaving
   * "the setting was not written" beside a fresh success would contradict it.
   * Only failure/expiry rows go; another agent's rows and receipts stay.
   */
  private clearAgentSaveFailures(agentId: string): void {
    const keys = this.saveFailureKeysFor(`agent-save:${agentId}`)
    for (const key of keys) this.bannerRetries.delete(key)
    const next = this.state.saveBanners.filter(banner => !keys.has(banner.key))
    if (next.length !== this.state.saveBanners.length) this.mutate({ saveBanners: next })
  }

  /**
   * A deleted agent must not leave a retry gesture behind: its payload would
   * recreate exactly what the user removed. Clear the id-keyed rows and the
   * label-keyed gate rows in one place.
   */
  private clearAgentSaveBanners(agentId: string): void {
    const label = `agent-save:${agentId}`
    const keys = new Set([
      `save-failed:${agentId}`,
      `save-rejected:${agentId}`,
      `save-failed:${label}`,
      `save-expired:${label}`,
      `save-cancel-failed:${label}`,
      `save-cancelled:${label}`,
      `save-retry-none:${label}`,
      `save-retry-failed:${label}`,
    ])
    for (const key of keys) this.bannerRetries.delete(key)
    const next = this.state.saveBanners.filter(banner => !keys.has(banner.key))
    if (next.length !== this.state.saveBanners.length) this.mutate({ saveBanners: next })
  }

  /**
   * Fold one gate snapshot into banners and log lines. The SSE frame and
   * `resync` share this, so a page refresh rebuilds the terminal rows it missed
   * instead of only replacing `saveGate`.
   *
   * `logPending = false` on a resync: the held entry did not APPEAR at refresh
   * time, and logging it on every panel open would be noise. Terminal rows are
   * still synthesized.
   *
   * A terminal row is a SEED (rebuilt from a snapshot rather than witnessed live)
   * when a resync asks for it or when the previous snapshot has no terminal
   * entry for that label — the first SSE frame after a refresh lands before
   * `resync` and carries the whole host roster. Seeded rows obey the closed-row
   * records in sessionStorage; live settlements carry a new `at`, so closing an
   * old row never suppresses a later failure of the same label.
   */
  private saveGatePatch(
    previous: SaveGateStatus,
    next: SaveGateStatus,
    logPending = true,
    rebuildRows = false,
  ): Partial<UiState> {
    const { addedPending, outcomes } = saveGateTransitions(previous, next)
    const logged: AcpLogEntry[] = []
    const log = (level: 'info' | 'error', text: string): void => {
      logged.push({ id: ++this.logSeq, at: Date.now(), level, text })
    }
    let banners = this.state.saveBanners
    for (const entry of addedPending) {
      // The queue is authoritative again: drop a just-shown "cancelled"
      // success row for the same label so the two prompts are not shown side
      // by side. A resync can re-enter the queue too, so this is not tied to
      // whether the arrival is worth a log line.
      banners = banners.filter(banner => banner.key !== `save-cancelled:${entry.label}`)
      if (logPending) {
        log('info', this.label(
          '本轮对话还在进行，配置已暂存，回合结束后自动保存。',
          'A turn is still running. The setting is held and will be saved when the turn ends.',
        ))
      }
    }
    const savedLabels: string[] = []
    for (const { label, outcome, wasPending, isPending } of outcomes) {
      if (outcome.status === 'saved') {
        // Only a previously HELD write earns the global receipt; a direct save
        // from the form reports success on its own.
        if (!wasPending) continue
        // A success retires this agent's earlier failure/expiry receipts.
        const cleared = this.saveFailureKeysFor(label)
        for (const key of cleared) this.bannerRetries.delete(key)
        banners = banners.filter(banner => !cleared.has(banner.key))
        log('info', this.label(
          `配置已保存：${label}。`,
          `The setting was saved: ${label}.`,
        ))
        savedLabels.push(label)
      } else if (outcome.status === 'expired') {
        const key = `save-expired:${label}`
        const row: SaveBanner = {
          key,
          source: 'save-expired',
          level: 'error',
          title: this.label('暂存已过期', 'Held save expired'),
          body: this.label('等待超时，配置尚未写入。请重试。', 'The wait expired before the setting was written. Please retry.'),
          at: outcome.at,
          actions: isPending ? ['retry', 'force', 'dismiss'] : ['retry', 'dismiss'],
          label,
          persistAcrossReload: true,
        }
        if ((rebuildRows || saveGateOutcomeForLabel(previous, label) === undefined) && wasClosedAcrossReload(row)) continue
        log('error', this.label(
          '配置保存等待超时，尚未写入；请重新保存。',
          'The setting was not saved before its wait expired. Please save it again.',
        ))
        this.bannerRetries.set(key, { kind: 'gate', label })
        banners = composeSaveBanners(banners, row)
      } else if (outcome.status === 'failed') {
        const key = `save-failed:${label}`
        const row: SaveBanner = {
          key,
          source: 'save-failed',
          level: 'error',
          title: this.label('保存失败', 'Save failed'),
          body: this.label(
            `配置未写入：${outcome.message ?? '未知错误'}`,
            `The setting was not written: ${outcome.message ?? 'unknown error'}`,
          ),
          at: outcome.at,
          actions: ['retry', 'dismiss'],
          label,
          persistAcrossReload: true,
        }
        if ((rebuildRows || saveGateOutcomeForLabel(previous, label) === undefined) && wasClosedAcrossReload(row)) continue
        log('error', this.label(
          `配置保存失败：${outcome.message ?? '未知错误'}`,
          `The setting could not be saved: ${outcome.message ?? 'unknown error'}`,
        ))
        this.bannerRetries.set(key, { kind: 'gate', label })
        banners = composeSaveBanners(banners, row)
      } else if (outcome.status === 'cancelled') {
        // A superseded row belongs to a newer save; a label still queued has
        // not settled either. Neither is this attempt's cancellation.
        if (saveGateOutcomeSuperseded(outcome) || isPending) continue
        // Cancellation is a silent terminal result: no banner, one log line.
        if (wasPending) log('info', this.label('配置暂存已取消。', 'The held setting was cancelled.'))
      }
    }
    // One frame can settle several agents together. Show a single success row
    // that names every one of them instead of letting the last overwrite the
    // rest, and keep one log line per label above.
    if (savedLabels.length > 0) {
      banners = composeSaveBanners(banners, this.saveSuccessBanner(savedLabels.length, savedLabels))
    }
    return {
      ...(logged.length === 0 ? {} : {
        logs: [...this.state.logs, ...logged].slice(-LOG_MAX_ENTRIES),
        logUnread: this.state.logUnread + logged.length,
      }),
      ...(banners === this.state.saveBanners ? {} : { saveBanners: banners }),
    }
  }

  /**
   * Add or replace one banner. The key IS the dedupe rule; failure rows are
   * never dropped by count, and only one transient success row is kept.
   */
  private pushSaveBanner(banner: SaveBanner): void {
    this.mutate({ saveBanners: composeSaveBanners(this.state.saveBanners, banner) })
  }

  /**
   * Set the plugin's OWN default ACP agent (the panel's ★ gesture): which agent
   * an ACP-mode conversation starts on. Plugin-private state — the host keeps it
   * in its own agent registry file, and nothing here touches DSH's model
   * selection (see docs/acp-convergence.md §2.2).
   */
  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    try {
      await this.call('default/agent-set', { ...(agentId === undefined ? {} : { agentId }) })
      this.mutate({ defaultAgent: agentId })
    } catch (error) {
      this.flashError(error)
    }
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

  /** Write the approval deadline, or drop the persisted override with `reset`. */
  async setApprovalDeadline(ms: number): Promise<void> {
    return this.settingsService.setApprovalDeadline(ms)
  }

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

  /**
   * Bind one DSH chat session to an ACP agent. This is the plugin's own
   * conversation↔agent mapping: it does NOT write a DSH model route, so it
   * cannot pollute the deployment default model and cannot be refused by the
   * GUI's catalog gate (the retired `session/model-unavailable` failure).
   *
   * The mapping is host-side and keyed by chat session id; the browser learns
   * the binding back through `session/chat-list`.
   */
  async bindChatAgent(dshSessionId: string, agentId: string): Promise<void> {
    try {
      await this.call('session/chat-bind', { dshSessionId, agentId })
      // Optimistic: the host recorded the intent, so the NEXT message runs the
      // picked agent — but the live-session list (`chatSessions`) cannot show
      // that until the turn materializes its session. Recording here is what
      // makes the chip and the picker's checkmark move on the click itself.
      this.mutate({ chatBoundAgent: { ...this.state.chatBoundAgent, [dshSessionId]: agentId } })
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Switch the bound agent's model (`agentId@choice`) for one chat session. */
  async setChatSessionModel(dshSessionId: string, modelId: string, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-model-set', { dshSessionId, modelId })
      // Optimistic for the same reason the binding is: the host recorded the
      // pick, and a conversation with no ACP session yet would otherwise show
      // the agent's default until its first turn created one.
      const safeAgent = (agentId && agentId.trim()) || undefined
      const targetAgent = safeAgent ?? (modelId ? splitModelAgentId(modelId) : undefined)
      // A thought level belongs to the model it was picked on. The host clears
      // one the new model does not offer (it is the authority); mirror that here
      // so the chip does not keep naming it during the round-trip. A model the
      // catalog has no record for counts as "does not offer" — the same
      // conservative answer the host gives.
      const owner = targetAgent ?? this.state.chatChoice[dshSessionId]?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
      const sessions = this.state.chatSessionsFor === dshSessionId ? this.state.chatSessions : []
      const dropEffort = this.state.chatChoice[dshSessionId]?.modelId !== modelId
        && !sessions.some(s => !s.released)
        && !modelOffersEffort(this.state.seatCatalogs[owner ?? ''], modelValueOf(modelId), this.state.chatChoice[dshSessionId]?.effort)
      this.writeChoice(dshSessionId, choice => {
        const next = { ...choice, modelId }
        if (dropEffort) delete next.effort
        return next
      }, targetAgent)
      if (this.state.chatSessionsFor === dshSessionId) {
        let changed = false
        const chatSessions = this.state.chatSessions.map(s => {
          if (s.agentId !== owner) return s
          if (!dropEffort && s.modelId === modelId) return s
          if (dropEffort && s.modelId === modelId && s.reasoningEffort === undefined) return s
          changed = true
          return { ...s, modelId, ...(dropEffort ? { reasoningEffort: undefined } : {}) }
        })
        if (changed) this.mutate({ chatSessions })
      }
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Switch the bound agent's reasoning effort for one chat session. */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-effort-set', {
        dshSessionId,
        ...(effort === undefined ? {} : { effort }),
        ...(agentId === undefined ? {} : { agentId }),
      })
      const targetAgent = (agentId && agentId.trim()) || undefined
      this.writeChoice(dshSessionId, choice => {
        const { effort: _dropped, ...rest } = choice
        return effort === undefined ? rest : { ...rest, effort }
      }, targetAgent)
      if (this.state.chatSessionsFor === dshSessionId) {
        const owner = targetAgent ?? this.state.chatChoice[dshSessionId]?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
        let changed = false
        const chatSessions = this.state.chatSessions.map(s => {
          if (s.agentId !== owner || s.reasoningEffort === effort) return s
          changed = true
          return { ...s, reasoningEffort: effort }
        })
        if (changed) this.mutate({ chatSessions })
      }
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Set one of the bound agent's EXTRA config options for one chat session. */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-config-set', {
        dshSessionId,
        configId,
        value,
        ...(agentId === undefined ? {} : { agentId }),
      })
      this.writeChoice(dshSessionId, choice => ({
        ...choice,
        extraConfigs: { ...choice.extraConfigs, [configId]: value },
      }), agentId)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /**
   * Patch one conversation's optimistic pick. The agent half is required by the
   * record (a model or thought level belongs to an agent). Its owner is the
   * route the picker used, else the recorded pick, the optimistic binding, or
   * the plugin default — that last one really serves a never-bound conversation
   * (the guard routes to it), so waiting for `session/chat-list` would leave the
   * chip behind the click. Only a conversation with none of those is left alone.
   */
  private writeChoice(dshSessionId: string, update: (choice: AcpConversationChoice) => AcpConversationChoice, agentId?: string): void {
    const current = this.state.chatChoice[dshSessionId]
    // The plugin default is a real route (the host applies it to a conversation
    // nobody bound), so an optimistic pick in a fresh conversation belongs to
    // it — without this the host recorded the pick but the chip waited for the
    // next `session/chat-list`.
    const owner = agentId ?? current?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
    if (owner === undefined) return
    const next = update({ ...current, agentId: owner })
    this.mutate({ chatChoice: { ...this.state.chatChoice, [dshSessionId]: { ...next, agentId: owner } } })
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
    const counts = this.detectCounts
    this.mutate({
      localeRev: this.state.localeRev + 1,
      ...(counts === undefined ? {} : { detectSummary: this.detectSummaryOf(counts.total, counts.installed) }),
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
   * One chat-row lifecycle frame, recorded in arrival order. A bounded log is
   * enough: a `session/chat-list` read only needs the frames since it started.
   */
  private pushChatRowFrame(sessionId: string, kind: ChatRowFrame['kind']): void {
    this.chatRowFrameSeq += 1
    this.chatRowFrames.push({ seq: this.chatRowFrameSeq, sessionId, kind })
    if (this.chatRowFrames.length > 256) this.chatRowFrames.shift()
  }

  /**
   * Feed the replay log BEFORE the switch folds the frame into the snapshot.
   * Live SSE frames and directly injected test frames then take the same path.
   */
  private noteChatRowFrame(event: AcpEvent): void {
    switch (event.type) {
      case 'session/released': this.pushChatRowFrame(event.sessionId, 'released'); break
      case 'session/reset': this.pushChatRowFrame(event.sessionId, 'reset'); break
      case 'session/created': this.pushChatRowFrame(event.sessionId, 'created'); break
      case 'session/closed': this.pushChatRowFrame(event.sessionId, 'closed'); break
    }
  }

  private applyEvent(event: AcpEvent): Promise<void> {
    this.noteChatRowFrame(event)
    switch (event.type) {
      case 'agent/notice': {
        if (event.agentId === 'hmr') {
          // The hot-reload guard speaks through `agent/notice`; a log line is
          // invisible unless the user opens the log, so the same fact also
          // becomes a persistent page-top banner.
          const retryFailure = event.text.includes('retry failed') || event.text.includes('did not start')
          this.pushSaveBanner({
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
        this.mutate(this.logPatch(event.level, event.text, event.agentId))
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
          ...this.watchedSessionPatch(event.sessionId, event.session),
        })
        return Promise.resolve()
      }
      case 'session/closed': {
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
          ...(event.reason === 'agent-died'
            ? this.logPatch('error', this.locale('会话因 agent 进程退出而终止', 'session ended: agent process died'), closingSession?.agentId)
            : {}),
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
        // The composer's own list (`session/chat-list` views) must flip too, or
        // the agent tag's live halo keeps breathing for a process that is gone:
        // nothing else re-reads this list until the next turn settles.
        const chatSessions = withSessionReleased(this.state.chatSessions, event.sessionId, true)
        // One runtime-log line per release cause; `idle` and `archived` stay
        // silent on purpose (an expected lifecycle transition or the user's own
        // archive gesture, not a fault).
        const cause = event.cause ?? 'died'
        let log: Partial<Pick<UiState, 'logs' | 'logUnread'>> = {}
        if (cause === 'workspace') {
          log = this.logPatch('info', this.locale(
            'agent 为切换工作区重启，会话已挂起；再次发送消息将自动恢复。',
            'agent restarted for its workspace; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        } else if (cause === 'resume-failed') {
          log = this.logPatch('error', this.locale(
            '会话恢复失败；再次发送消息将重试恢复。',
            'session resume failed; your next message will retry it.',
          ), event.session.agentId)
        } else if (cause === 'stalled') {
          log = this.logPatch('error', this.locale(
            'agent 未响应卡死的回合，会话已挂起；再次发送消息将自动恢复。',
            'agent did not acknowledge the stalled turn; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        } else if (cause === 'died') {
          log = this.logPatch('error', this.locale(
            'agent 进程已退出，会话已挂起；再次发送消息将自动恢复。',
            'agent process died; the session is paused and will resume on your next message.',
          ), event.session.agentId)
        }
        this.mutate({
          sessions,
          ...(chatSessions !== this.state.chatSessions ? { chatSessions } : {}),
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          // An observed transcript keeps its buffer but flips to released, so
          // the ACP view can say "会恢复" instead of silently looking dead.
          ...this.watchedSessionPatch(event.sessionId, event.session),
          ...log,
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
        // The host changed an agent's model visibility outside `agent/save`:
        // the settings card edited it, the auto-discovery switch was flipped,
        // or newly published models were appended automatically. Patch the
        // settings card's copy of the definition AND drop the seat cache — the
        // variants `agent/catalog` answers are a projection of this filter.
        const exposedModels = event.exposedModels.length === 0 ? undefined : [...event.exposedModels]
        const detectedAgents = this.state.detectedAgents.map(info =>
          info.id === event.agentId && info.currentConfig !== undefined
            ? {
                ...info,
                currentConfig: {
                  ...info.currentConfig,
                  exposedModels: exposedModels === undefined ? undefined : exposedModels,
                  autoDiscoverModels: event.autoDiscoverModels,
                },
              }
            : info)
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
        }
        this.mutate({
          permissions: [...this.state.permissions.filter(p => p.requestId !== event.requestId), permission],
        })
        return Promise.resolve()
      }
      case 'permission/resolved': {
        this.mutate({ permissions: this.state.permissions.filter(p => p.requestId !== event.requestId) })
        return Promise.resolve()
      }
      case 'permission/synced': {
        // Terminator of the reconnect replay: the host just re-sent every
        // outstanding ask, and this set is the authoritative live list. Drop
        // anything this client still holds from before the disconnect — an ask
        // resolved while it was away is gone host-side, and answering it would
        // only earn `unknown_request`.
        const live = new Set(event.requestIds)
        this.mutate({ permissions: this.state.permissions.filter(p => live.has(p.requestId)) })
        return Promise.resolve()
      }
      case 'chat/agent-locked': {
        // The host locks a conversation at the START of its first ACP turn and
        // says so at once; this frame is what makes the hand-off animation run
        // at the start rather than on the turn-settled list read. It is emitted
        // only on the transition, so it always announces a new ceremony — even
        // if a racing list read already seeded the lock itself.
        this.chatUnlocked.delete(event.dshSessionId)
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
        this.chatUnlocked.add(event.dshSessionId)
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
        this.openTurns.add(event.sessionId)
        this.markWatchedRunning(event.sessionId, true)
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
      case 'save/status': {
        const status = normalizeSaveGateStatus(event.status)
        this.mutate({
          saveGate: status,
          ...this.saveGatePatch(this.state.saveGate, status),
        })
        return Promise.resolve()
      }
      case 'subagents/record': {
        // One worker's plugin-owned lifecycle record: creation and every
        // status transition of one dispatch. Logged for the chat-list replay
        // (the answer may predate this frame), then folded by key — never by
        // `childId` alone, which can repeat across conversations.
        this.subagentRecordSeq += 1
        this.subagentRecordFrames.push({
          seq: this.subagentRecordSeq,
          dshSessionId: event.dshSessionId,
          record: event.record,
        })
        if (this.subagentRecordFrames.length > 256) this.subagentRecordFrames.shift()
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

function splitModelAgentId(modelId: string): string | undefined {
  const at = modelId.indexOf('@')
  const agent = at === -1 ? modelId.trim() : (at === 0 ? '' : modelId.slice(0, at).trim())
  return agent || undefined
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

export type { Block } from "./store/blocks.ts"
export {
  STATE_ONLY_UPDATES,
  describeEvent,
  foldUpdate,
  jsonText,
  replayChatRowFrames,
  toolDetailsOf,
  toolInputOf,
  usageFromUpdate,
} from "./store/blocks.ts"

export type { ChatForkOutcome, ChatForkState } from "./store/fork.ts"
export { forkStateOf } from "./store/fork.ts"

export type { PendingPermission } from "./store/permission.ts"
export { PERMISSION_DEADLINE_EXPIRED, deadlineRemainingLabel, permissionsForSession } from "./store/permission.ts"

export { DEFAULT_KNOWN_PRESETS } from "./store/presets.ts"

export type {
  SaveBanner,
  SaveBannerAction,
  SaveBannerSource,
  SaveGateInterruptTarget,
  SaveGateOutcomeTransition,
} from "./store/save-gate.ts"
export {
  composeSaveBanners,
  saveGateAgentId,
  saveGateInterruptTargets,
  saveGateIsAvailable,
  saveGateOutcomeForLabel,
  saveGateOutcomeSuperseded,
  saveGateTransitions,
} from "./store/save-gate.ts"

export type { AgentCommand } from "./store/skills.ts"
export { MAX_SKILL_KEYS, SKILL_MENU_TTL_MS, skillRowsKey } from "./store/skills.ts"

export type { AcpLogEntry, ChatRowFrame, ChatTranscript, RpcCall, UiState } from "./store/state.ts"

export type { LiveSubagentDetailEntry, SubagentDetailState } from "./store/subagent.ts"
export {
  MAX_SUBAGENT_DETAIL_WORKERS,
  SUBAGENT_RAW_MAX,
  boundedDetailEntry,
  compactDetailValue,
  mergeSubagentSnapshot,
  subagentKey,
  subagentToolCallId,
} from "./store/subagent.ts"
