import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  type ContentBlock,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import {
  EventHub,
  buildAdapterModelId,
  isAcpToolContinuation,
  parseCatalogOptions,
  randomUUID,
  selectForwardPrompt,
  extractSessionTitlePlaceholder,
  isAbsolutePath,
  splitAdapterModelId,
} from '../impl.ts'
import type {
  DelegateLiveOptions,
  PendingPermissionView,
  RosterPresetRow,
} from '../impl.ts'
import type {
  AcpAgentCatalog, AcpAgentDef, AcpApprovalDeadlines, AcpConversationChoice, AcpPresetStatus, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentSaveMode, AgentSaveResult, AgentSkillsResult, AgentTestResult, AgentView, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, GenerateOptions,
  LlmResolvedModelInfo,
  AcpIdleRelease, ActiveTurnView, ApprovalDeadlineKey, ApprovalDeadlinePatch, PermissionTimeoutMode, PluginReleaseNotes, PluginUpdateState, SaveGateFlushResult, SaveGateStatus, SessionView, StreamChunk,
  AcpDelegateAgentDefaults, AcpDelegateConfig, AcpDelegatePolicy, AcpDelegateSettings, AcpStartSessionOpts, DelegateGuidance, DelegateSetPayload,
  SubagentDetailResult, SubagentRecord,
} from '../protocol.ts'
import { SESSION_TITLE_PREFIX } from '../protocol.ts'
import type { AcpSaveGate } from '../save-gate.ts'
import type { UpdateService } from '../update.ts'
import {
  bridgeKey,
  type BridgeScope,
} from './identity.ts'

import type {
  AcpModeResolver,
  BridgeReleaseReport,
  BridgeTuning,
  DshAgentLike,
  SessionWorkspaceResolver,
  SubagentCatalogReporter,
} from './types.ts'

import {
  chatWorkspaceRoot,
  migrateLegacyState,
} from './state-paths.ts'

import {
  BACKGROUND_REPORT_LOST_TEXT,
  backgroundReportOf,
  routeBindingRegistry,
} from './registries.ts'
import {
  RETIRED_AMBIENT_RECENT_MIN_MS,
  TurnStreamController,
  activeDrain,
  codebuddyMetaOf,
  expireAmbientDrain,
  hasRecentRetiredAmbient,
  silenceWindowsOf,
} from './turn-stream.ts'
import type { LiveSession } from './turn-stream.ts'
import {
  agentRefusalDetail,
  rateLimitedTurnError,
  snapshot,
} from './shape.ts'
import { DEFAULT_TUNING } from './tuning.ts'
import { AgyLateOutputService } from './agy-late-output.ts'
import { agyStoreRoot, isAntigravityAgent } from './agy-transcript.ts'
import { ArchiveReleaseService } from './archive-release-service.ts'
import { AgentBridge } from './agent-bridge.ts'
import { BridgeRegistryService } from './bridge-registry-service.ts'
import { BridgeRpcService } from './bridge-rpc-service.ts'
import { TurnWatchdogService } from './turn-watchdog-service.ts'
import { ModelCatalogService } from './catalog-service.ts'
import { SubagentService } from './subagent-service.ts'
import { SettingsService } from './settings-service.ts'
import { ChatChoiceService } from './chat-choice-service.ts'
import { AgentAdminService } from './agent-admin-service.ts'
import { SessionRegistryService } from './session-registry-service.ts'
import { PersistenceService } from './persistence-service.ts'
import { SkillsService } from './skills-service.ts'
import { SessionBootService } from './session-boot-service.ts'
import { describeError } from './errors.ts'
import { hasPromptSlot, lifecycleOf } from './session-lifecycle.ts'

/** Routes host session ids to their owning bridge. */
export class BridgeManager {
  /** Bridge registry + lifecycle cluster (see `BridgeRegistryService`): the process table, the stop gate, the status aggregate and the teardown paths; `makeBridge` stays here (it wires the manager's callbacks into every `AgentBridge`) and the service reaches it through host callbacks. */
  private readonly bridgeRegistry: BridgeRegistryService
  /** The service's OWN Map instances under the historical field names: tests read them through the manager and patch `Map.prototype.set` on the instance, so these must stay getters onto the same maps, never copies. */
  private get bridges(): Map<string, AgentBridge> {
    return this.bridgeRegistry.bridges
  }
  private get bridgeScopes(): Map<string, BridgeScope> {
    return this.bridgeRegistry.bridgeScopes
  }
  private readonly defsMap = new Map<string, AcpAgentDef>()
  /** Model catalog + probe cluster; owns the catalog file and fork capability cache. */
  private readonly catalog: ModelCatalogService
  /** Settings + tuning cluster; owns the persisted preferences, the status cards and the hot application of both tuning windows (see `SettingsService`). */
  private readonly settings: SettingsService
  /** The entry-wired `acp_delegate` registration seam: sync reconciles the tool registration + force mask; the availability getters feed `delegateSettings`. */
  private delegateRegistration?: { sync(): void; readonly toolAvailable: boolean; readonly restrictAvailable: boolean }
  /** Chat-choice cluster: the conversation's bottom-bar selection, the request-path route pin and the ACP-mode verdict cache (see `ChatChoiceService`); it operates on the session registry's pick map (passed by reference). */
  private readonly choices: ChatChoiceService
  /** Chat-session registry + conversation binding + first-turn lock (see `SessionRegistryService`): the DSH session records, the persisted picks and the lock helpers; the process table and the start / resume / retry flows stay here and the service reaches them through host callbacks. */
  private readonly registry: SessionRegistryService
  /** Agent-definition administration + the save gate (see `AgentAdminService`): the delete tombstones, the delete / save generations and the `save/*` gate state machine; the registry (`defsMap`) and the bridge table stay here and reach the service as host callbacks. */
  private readonly admin: AgentAdminService
  /** Archive-release cluster (see `ArchiveReleaseService`); its entry points stay on the manager. */
  private readonly archive: ArchiveReleaseService
  /**
   * `agents.json` persistence (see `PersistenceService`): where the state file
   * lives, its tolerant restore and its strict / best-effort writes. Every
   * cluster's persisted shape is read and written through it, so the file's key
   * order and its "absent while never written" rules have ONE owner.
   */
  private readonly persistence: PersistenceService
  /** `agent/skills` answers (see `SkillsService`): the per-agent + workspace scan cache. */
  private readonly skills: SkillsService
  /**
   * Tuning in force, defaults applied. The approval deadline and the idle
   * window are rewritten IN PLACE by `SettingsService` (through the host's
   * `replaceTuning`), which is why this is a live object rather than the
   * constructor's parameter: every bridge built afterwards inherits the rewrite
   * instead of the boot-time value.
   */
  private readonly tuning: Required<BridgeTuning>
  /**
   * Turn watchdog + turn-stream index cluster (see `TurnWatchdogService`):
   * the per-chat controller index, the stall scan timer, the live-turn reads
   * and the tuning snapshots a controller reads at construction. The manager
   * keeps same-named delegates; the index Map stays reachable through the
   * `turnStreams` getter below (the service's OWN instance, never a copy)
   * because tests introspect it through the manager.
   */
  private readonly watchdog: TurnWatchdogService
  private get turnStreams(): Map<string, TurnStreamController> {
    return this.watchdog.turnStreams
  }
  /**
   * The `/acp` RPC face (see `BridgeRpcService`): session creation, the prompt
   * turn loop, cancel / close, mode / config writes, permission answers and
   * the transcript / session reads. The manager keeps same-named delegates;
   * the stalled-turn reclaim it calls stays here (the chat plane shares it).
   */
  private readonly rpc: BridgeRpcService
  /**
   * Session boot / resume cluster (see `SessionBootService`): the chat
   * acquisition, the explicit resume gesture, the stalled-turn reclaim and the
   * steer's cancel-then-resend gate. The manager keeps same-named delegates;
   * `streamPrompt`, the RPC face and the tests call them here.
   */
  private readonly boot: SessionBootService

  /** Start watching a closed chat turn's transcript (see `AgyLateOutputService.arm`). */
  armLateOutputWatch(session: LiveSession, closedAt: number): void {
    this.lateOutput.arm(session, closedAt)
  }

  /**
   * Initialise the Antigravity-only transient sets on a NEW session: tool-call
   * replay deduplication and the late-output watch only exist for this agent.
   */
  private initLateOutputState(session: LiveSession): void {
    if (!this.lateOutput.isAgentFor(session.agentId)) return
    session.knownToolCalls ??= new Set<string>()
    session.turnToolCalls ??= new Set<string>()
  }

  constructor(
    defs: readonly AcpAgentDef[],
    readonly hub: EventHub,
    private readonly transcriptMax: number,
    configStoragePath?: string,
    catalogStoragePath?: string,
    /** Auto-probe agents for model catalogs (boot + lazy); manual probes always run. */
    private readonly probeModelsOnBoot = true,
    tuning?: BridgeTuning,
    /**
     * Test seam for the Antigravity transcript path: production omits it and
     * the defaults read the launch command line. A test injects its own agent
     * predicate and store root instead of rewriting `process.env.HOME`.
     */
    lateOutputProbe?: { isAgent(def: AcpAgentDef): boolean; storeRoot(): string | undefined },
  ) {
    // Held as a live object rather than the raw parameter: the approval
    // deadline and the idle window are rewritten in place when the settings
    // page writes them (see `SettingsService`), and every bridge built
    // afterwards must inherit the rewrite instead of the boot-time value.
    this.tuning = { ...DEFAULT_TUNING, ...tuning }
    for (const def of defs) {
      this.defsMap.set(def.id, def)
    }
    // Move any state left loose in the host's `~/.dsh` root into this plugin's
    // own directory BEFORE reading it (see `migrateLegacyState`). Storage paths
    // injected by a caller are that caller's business; the migration only runs
    // for the default, plugin-owned locations.
    if (configStoragePath === undefined && catalogStoragePath === undefined) {
      migrateLegacyState()
    }
    this.catalog = new ModelCatalogService({
      defOf: agentId => this.defsMap.get(agentId),
      isAgentDeleted: agentId => this.admin.isAgentDeleted(agentId),
      bridgeForProbe: agentId => this.bridgeFor(agentId, { kind: 'probe' }),
      releaseProbe: agentId => {
        this.pruneBridge(bridgeKey(agentId, { kind: 'probe' }))
      },
      liveForkCapability: agentId => {
        const bridge = this.bridges.get(agentId)
        if (bridge?.initResult === undefined) return undefined
        return bridge.initResult.agentCapabilities?.sessionCapabilities?.fork != null
      },
      patchDef: (agentId, patch) => {
        const def = this.defsMap.get(agentId)
        if (def === undefined) return
        def.exposedModels = patch.exposedModels
      },
      persistAgents: () => this.persistence.persistAgents(),
      hub: this.hub,
    }, catalogStoragePath)
    // The chat-session registry (see `SessionRegistryService`) owns the DSH
    // session records, the conversation↔agent picks and the first-turn lock.
    // Every manager capability it needs arrives as a closure, so the service
    // never imports this module; the pick map is shared BY REFERENCE with the
    // chat-choice service below (that service owns the single write path).
    this.registry = new SessionRegistryService({
      hub: this.hub,
      defOf: agentId => this.defsMap.get(agentId),
      subagents: {
        recordsFor: dshSessionId => this.subagents.recordsFor(dshSessionId),
        forget: dshSessionId => { this.subagents.forget(dshSessionId) },
      },
      canForkNow: agentId => this.catalog.canForkNow(agentId),
      forkSession: (agentId, parent, childDshSessionId) => this.bridge(agentId).forkSession(parent, childDshSessionId),
      patchChatChoice: (dshSessionId, patch) => { this.choices.patchChatChoice(dshSessionId, patch) },
      applyChatChoice: session => this.choices.applyChatChoice(session),
      syncConversationRoute: dshSessionId => { this.choices.syncConversationRoute(dshSessionId) },
      persistAgents: () => this.persistence.persistAgents(),
      closeSessionHolder: session => {
        // The session's OWN bridge, not `bridge(id)` / a map lookup by agent:
        // the agent may have been deleted while its first turn was failing, and
        // a rollback must never throw — `bridgeOwning` never creates, never
        // throws, and never routes a session to another process.
        const failed = this.bridgeOwning(session.agentId, session.sessionId)
        if (failed === undefined) return
        // Once the agent-side close has settled, drop the holder too: a failed
        // first turn leaves nothing resumable behind it (the record was
        // forgotten above), so a per-session holder would otherwise linger with
        // a live child and no session — an orphan the next message could not
        // use. `keyOfBridge` runs inside the callback so it names the holder
        // only if this bridge is still registered.
        void failed.closeSession(session, 'closed')
          .catch(() => { /* already gone */ })
          .finally(() => {
            const key = this.keyOfBridge(failed)
            if (key !== undefined) this.pruneBridge(key)
          })
      },
    })
    // The turn watchdog / turn-stream index cluster (see `TurnWatchdogService`)
    // owns the controller index and the stall scan timer. Every capability
    // arrives as a closure, so the service never imports this module; the
    // index Map stays reachable through the manager's `turnStreams` getter
    // for test introspection.
    this.watchdog = new TurnWatchdogService({
      hub: this.hub,
      bridges: () => this.bridges.values(),
      currentTuning: () => this.tuning,
      persistAgents: () => this.persistence.persistAgents(),
    })
    // The bridge registry / lifecycle cluster (see `BridgeRegistryService`)
    // owns the process table, the stop gate and the status aggregate. Every
    // capability arrives as a closure or an already-built sibling service, so
    // it never imports this module; the maps it owns stay reachable through
    // the manager's `bridges` / `bridgeScopes` getters for test introspection.
    this.bridgeRegistry = new BridgeRegistryService({
      hub: this.hub,
      defOf: agentId => this.defsMap.get(agentId),
      defs: () => this.defsMap.values(),
      makeBridge: (def, onConnectionLost, onCatalog, onCommands, onSessionsDirty, onForkCapability) =>
        this.makeBridge(def, onConnectionLost, onCatalog, onCommands, onSessionsDirty, onForkCapability),
      catalog: this.catalog,
      persistAgents: () => this.persistence.persistAgents(),
      registry: this.registry,
      disposeTurnStreamsOf: match => { this.disposeTurnStreamsOf(match) },
      disarmStallTimer: () => { this.watchdog.disarmStallTimer() },
    })
    // The `/acp` RPC face (see `BridgeRpcService`) needs the process table,
    // the turn-stream index, the session records and the stalled-turn reclaim
    // that stays here; every capability arrives as a sibling service or a
    // closure, so it never imports this module.
    this.rpc = new BridgeRpcService({
      hub: this.hub,
      bridgeRegistry: this.bridgeRegistry,
      watchdog: this.watchdog,
      registry: this.registry,
      prepareStalledSession: session => this.prepareStalledSession(session),
    })
    // The archive-release cluster (see `ArchiveReleaseService`) needs the
    // session lookup, the turn stream, the session owner and the teardown.
    this.archive = new ArchiveReleaseService({
      registry: this.registry,
      turnStreamFor: dshSessionId => this.turnStreamFor(dshSessionId),
      bridgeOwning: (agentId, sessionId) => this.bridgeOwning(agentId, sessionId),
      disposeTurnStreamsOf: match => { this.disposeTurnStreamsOf(match) },
    })
    // The `/` menu's skill rows (see `SkillsService`) need the agent definition
    // and the conversation's workspace root; both arrive as closures.
    this.skills = new SkillsService({
      defOf: agentId => this.defsMap.get(agentId),
      workspaceRoot: dshSessionId => chatWorkspaceRoot(this.sessionWorkspaceResolver, dshSessionId),
    })
    // One Antigravity store-root resolution for BOTH transcript features (the
    // late-output watch and the subagent poll): production reads the launch
    // command line, tests inject the probe seam.
    const agyStoreRootOf = (def: AcpAgentDef): string | undefined =>
      lateOutputProbe === undefined ? agyStoreRoot(def) ?? undefined : lateOutputProbe.storeRoot()
    // The subagent / background-report cluster (see `SubagentService`) needs
    // the manager's hub, live sessions, state write and ambient windows; every
    // one is passed as a closure so the service never imports this module.
    // The second argument wires the agy child-transcript poll: its silence
    // windows use the SAME derivation as the idle clock (`AgentBridge`).
    this.subagents = new SubagentService({
      hub: this.hub,
      sessions: () => this.registry.sessions(),
      persistAgents: () => this.persistence.persistAgents(),
      ambientTuning: () => this.ambientTuning,
    }, {
      storeRoot: session => {
        const def = this.defsMap.get(session.agentId)
        return def === undefined ? undefined : agyStoreRootOf(def)
      },
      tuning: () => this.tuning,
      silenceWindows: () => silenceWindowsOf(this.tuning),
    })
    // The late-output watch reads Antigravity's private transcript (see the
    // plan). Every manager capability arrives as a closure; the probe pair is
    // the test seam, defaults read the launch command line.
    this.lateOutput = new AgyLateOutputService({
      isAgent: def => (lateOutputProbe === undefined ? isAntigravityAgent(def) : lateOutputProbe.isAgent(def)),
      storeRoot: agyStoreRootOf,
      tuning: () => this.tuning,
      host: {
        defOf: agentId => this.defsMap.get(agentId),
        isBusy: session => session.running || hasPromptSlot(session),
        deliver: (session, text, thought, failure) => failure === true ? this.subagents.deliverLateFailure(session, text) : this.subagents.deliverLateReport(session, text, thought),
      },
    })
    // The settings / tuning cluster (see `SettingsService`) needs the live
    // bridges a hot write reaches, the tuning object it rewrites, the registry
    // predicate that filters a stale default and the state-file write; every
    // one is passed as a closure so the service never imports this module.
    this.settings = new SettingsService({
      hasAgent: agentId => this.defsMap.has(agentId),
      bridges: () => this.bridges.values(),
      currentTuning: () => this.tuning,
      replaceTuning: next => { Object.assign(this.tuning, next) },
      persistAgents: () => this.persistence.persistAgents(),
      persistAgentsStrict: () => { this.persistence.persistAgents(true) },
      syncDelegateRegistration: () => { this.delegateRegistration?.sync() },
    })
    // The chat-choice cluster (see `ChatChoiceService`) needs the roster, the
    // catalog reads, the session set, the holder of a session, the two lock
    // readers and the state-file write; every one is a closure so the service
    // never imports this module. The pick map itself is owned by the session
    // registry and passed BY REFERENCE: the lock helpers and the `agents.json`
    // payload read and write it there.
    this.choices = new ChatChoiceService({
      hub: this.hub,
      defOf: agentId => this.defsMap.get(agentId),
      catalogFor: agentId => this.catalog.catalogFor(agentId),
      reasoningMeta: agentId => this.catalog.reasoningMeta(agentId),
      modelReasoning: (agentId, modelValue) => this.catalog.modelReasoning(agentId, modelValue),
      sessions: () => this.registry.sessions(),
      bridgeForSession: session => this.bridgeForSession(session),
      chatAgentFor: dshSessionId => this.registry.chatAgentFor(dshSessionId),
      lockedAgentFor: dshSessionId => this.registry.lockedAgentFor(dshSessionId),
      persistAgents: () => this.persistence.persistAgents(),
    }, this.registry.picks)
    // The session boot / resume cluster (see `SessionBootService`) needs the
    // session records, the process table, the turn-stream index, the picks and
    // the state-file write; every capability arrives as a sibling service or a
    // closure, so it never imports this module.
    this.boot = new SessionBootService({
      hub: this.hub,
      bridgeRegistry: this.bridgeRegistry,
      registry: this.registry,
      choices: this.choices,
      watchdog: this.watchdog,
      persistAgents: () => this.persistence.persistAgents(),
      workspaceResolver: () => this.sessionWorkspaceResolver,
      initLateOutputState: session => this.initLateOutputState(session),
    })
    // The agent-administration cluster (see `AgentAdminService`) needs the
    // registry, the bridge teardown, the strict state-file write, the live turn
    // list and the event stream; every one is a closure so the service never
    // imports this module. The tombstone / generation maps and the save gate
    // move WITH the service.
    this.admin = new AgentAdminService({
      defOf: agentId => this.defsMap.get(agentId),
      defs: () => [...this.defsMap.values()],
      replaceDef: def => { this.defsMap.set(def.id, def) },
      removeDef: agentId => {
        this.defsMap.delete(agentId)
        // The default agent is a pointer INTO this registry: deleting its
        // target must drop the pointer too, or the file would keep naming a
        // ghost. Same for the request-path bindings and the catalog cache.
        this.settings.forgetAgent(agentId)
        for (const [dshSessionId, model] of routeBindingRegistry().conversations) {
          if (splitAdapterModelId(model).agentId === agentId) routeBindingRegistry().conversations.delete(dshSessionId)
        }
        if (routeBindingRegistry().defaultModel === agentId) routeBindingRegistry().defaultModel = undefined
        this.catalog.forgetAgent(agentId)
      },
      hasBridge: agentId => this.bridges.has(agentId) || this.bridgesOf(agentId).length > 0,
      stopAgent: async (agentId, persist = false) => {
        if (!this.bridges.has(agentId) && this.bridgesOf(agentId).length === 0) return
        await this.stopAgent(agentId, persist)
        // `stopAgent` drops every per-scope key; the bare key is the non-A1 /
        // pre-spawn slot and is removed here as well.
        this.bridges.delete(agentId)
        this.bridgeScopes.delete(agentId)
      },
      persistAgents: (strict = false, staged) => { this.persistence.persistAgents(strict, staged) },
      activeTurnViews: () => this.activeTurnViews(),
      preSpawnView: def => new AgentBridge(def, this.hub, this.transcriptMax, () => {}).view(),
      publishCatalog: (agentId, withStatus) => {
        if (withStatus) {
          const def = this.defsMap.get(agentId)
          if (def !== undefined) {
            const view = this.bridgeRegistry.aggregateView(def)
            // The aggregate is the agent's state; the view rides along only
            // when a holder exists, exactly as this frame always did.
            this.hub.broadcast({
              type: 'agent/status',
              agentId,
              state: view.state,
              ...(this.bridgesOf(agentId).length === 0 ? {} : { agent: view }),
            })
          }
        }
        this.catalog.broadcastExposure(agentId)
      },
      probeAgentModels: agentId => this.probeAgentModels(agentId),
      hub: this.hub,
    })
    // The `agents.json` persistence cluster (see `PersistenceService`) owns the
    // state file itself; each cluster's persisted shape crosses as a reader +
    // an applier, so the file's key order and its absent-when-unwritten rules
    // stay in one place. The roster is shared BY REFERENCE, like the pick map:
    // the loader repairs the same `defsMap` the bridge table routes with.
    this.persistence = new PersistenceService({
      hub: this.hub,
      defs: () => this.defsMap,
      settingsPersisted: () => this.settings.persistedSettings(),
      applyPersistedSettings: parsed => { this.settings.loadPersistedSettings(parsed) },
      conversationsPersisted: () => this.registry.persistedConversations(),
      applyPersistedConversations: choices => {
        for (const [dshSessionId, choice] of choices) this.registry.setChoice(dshSessionId, choice)
        for (const dshSessionId of this.registry.choiceKeys()) this.choices.syncConversationRoute(dshSessionId)
      },
      chatSessionsPersisted: () => this.registry.persistedRows(),
      applyPersistedChatSessions: sessions => {
        for (const session of sessions) {
          this.registry.putSession(session)
          // The transient Antigravity sets are per-agent and not persisted:
          // restore must initialise them like a new / forked session does.
          this.initLateOutputState(session)
          const dshSessionId = session.dshSessionId
          if (dshSessionId === undefined) continue
          this.bridgeFor(session.agentId, { kind: 'chat', dshSessionId }).parkReleased(session)
        }
      },
      subagentsPersisted: () => this.subagents.persistedRecords(),
      applyPersistedSubagents: raw => {
        const keep = new Set<string>()
        for (const session of this.registry.sessions()) {
          if (session.dshSessionId !== undefined && lifecycleOf(session) !== 'closed') keep.add(session.dshSessionId)
        }
        for (const dshSessionId of this.registry.choiceKeys()) keep.add(dshSessionId)
        this.subagents.restore(raw, keep)
      },
    }, configStoragePath, this.transcriptMax)
    this.persistence.loadPersistedAgents()
    this.catalog.loadPersistedCatalogs()
    // Persisted overrides must reach the tuning the bridges are built from,
    // not just the settings cards' readout.
    this.settings.applyDeadlineTuning()
    this.settings.applyIdleReleaseTuning()
    this.settings.applySkillsMcpTuning()
    // Delegate boot replay: a no-op until the entry wires the registration
    // seam; the entry's ctx.effect then performs the real first sync.
    this.settings.applyDelegateTuning()
    // The request-path rewrite falls back to this default for a conversation
    // the user never bound explicitly — the same agent the composer chip shows.
    routeBindingRegistry().defaultModel = this.settings.defaultAgent()
  }

  private makeBridge(
    def: AcpAgentDef,
    onConnectionLost: (bridge: AgentBridge, reason: string) => void,
    onCatalog?: (agentId: string, configOptions: unknown, shapeOnly?: boolean) => void,
    onCommands?: (agentId: string, commands: NonNullable<SessionView['availableCommands']>) => void,
    onSessionsDirty?: () => void,
    onForkCapability?: (agentId: string, supported: boolean) => void,
  ): AgentBridge {
    return new AgentBridge(def, this.hub, this.transcriptMax, onConnectionLost, onCatalog, onCommands, this.tuning, () => this.sessionWorkspaceResolver, onSessionsDirty, onForkCapability, bridge => {
      this.bridgeRegistry.publishAgentStatus(bridge.def.id)
      this.bridgeRegistry.noticeBridgeFailure(bridge)
    }, (session, update) => this.subagents.trackSessionBackgroundDispatch(session, update), (session, update) => this.subagents.trackBackgroundDrainText(session, update), (session, status) => {
      // A session teardown that skips `clearAmbientState` must still stop the
      // transcript watch: its writer is the process that is going away. The
      // subagent poll reads the same process's transcripts — same rule.
      this.lateOutput.disarm(session)
      this.subagents.disarmAgyPoll(session)
      this.subagents.terminalizeSessionDispatches(session, status)
    }, (session, update) => {
      // agy dispatch tracking shares the late-output agent probe (production:
      // the launch command line; tests: the injected seam).
      if (this.lateOutput.isAgentFor(session.agentId)) this.subagents.trackAgyDispatch(session, update)
    }, () => this.tuning.skillsMcpEnabled)
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
   * Set the attachment service or context used to resolve image attachments in user prompts.
   */
  setAttachmentResolver(resolver?: unknown): void {
    this.attachmentResolver = resolver
  }

  /**
   * Wire the ACP-mode probe: given a DSH session id, report whether that
   * session runs the ACP agent preset. The host half reads it back from the
   * session log (`sessionAgentPreset`); an absent resolver means the browser
   * falls back to its own session-list rows.
   */
  setAcpModeResolver(resolver?: AcpModeResolver): void {
    this.choices.setAcpModeResolver(resolver)
  }

  /**
   * Optional host integration: report a detached ACP worker as an EXTERNAL
   * child in the parent chat session's subagent catalog. Display-only — the
   * host renders it as a read-only "external task" row with no child session,
   * activity or continuation. An absent reporter is a no-op.
   */
  setSubagentCatalogReporter(reporter?: SubagentCatalogReporter): void {
    this.subagents.setCatalogReporter(reporter)
  }

  /**
   * Wire the host's chat-agent lookup, so an IDLE background drain can wake the
   * conversation it belongs to.
   *
   * A CodeBuddy background drain runs after the prompt response (its documented
   * `unsolicitedTurn` shape), so under the default "settle at the response"
   * there is no driver step for its prose. The only entry into the chat plane
   * is a driver step: the manager injects one hidden user message through the
   * host agent's `followup` and the adapter answers it locally with the
   * collected report (no ACP prompt — the agent already produced the text).
   * An absent resolver degrades to the old transcript-only behavior.
   */
  setDshAgentResolver(resolver?: (dshSessionId: string) => DshAgentLike | undefined): void {
    this.subagents.setDshAgentResolver(resolver)
  }

  /**
   * Hand one detached worker to the host catalog (see `SubagentService`).
   * Returns whether a reporter handled it; a missing chat id or reporter
   * leaves the dispatch unclaimed so a later wire update can retry.
   */
  reportSubagentCatalog(session: LiveSession, childId: string, label: string): boolean {
    return this.subagents.reportSubagentCatalog(session, childId, label)
  }

  /**
   * Record external-worker lifecycle rows for one conversation (see
   * `SubagentService`). A `subagents/record` frame goes out only when the
   * caller says the status changed; the state file is rewritten once per batch.
   */
  noteSubagentRecords(records: readonly SubagentRecord[], options: { announce: boolean; persist: boolean }): void {
    this.subagents.noteSubagentRecords(records, options)
  }

  /**
   * Terminalize every unfinished dispatch of a SESSION that goes away
   * (close / release / force reset / process death), or of a turn the user
   * cancelled / that failed (see `SubagentService`).
   */
  terminalizeSessionDispatches(
    session: LiveSession,
    status: 'cancelled' | 'unknown',
    onlyIds?: ReadonlySet<string>,
  ): void {
    this.subagents.terminalizeSessionDispatches(session, status, onlyIds)
  }

  /**
   * The plugin's own lifecycle records for one conversation (see
   * `SubagentService.subagentsFor`).
   */
  subagentsFor(dshSessionId: string): SubagentRecord[] {
    return this.subagents.subagentsFor(dshSessionId)
  }

  /**
   * Raw transcript entries for ONE external worker — the detail view's
   * on-demand read (see `SubagentService.subagentsDetail`).
   */
  subagentsDetail(dshSessionId: string, childId: string): SubagentDetailResult {
    return this.subagents.subagentsDetail(dshSessionId, childId)
  }

  /** The agent skills one conversation can use (`agent/skills`; see `SkillsService`). */
  async agentSkills(dshSessionId: string, agentId: string): Promise<AgentSkillsResult> {
    return this.skills.agentSkills(dshSessionId, agentId)
  }

  /**
   * Whether ONE DSH chat session runs the ACP agent preset, asked by chat
   * session id (see `ChatChoiceService.chatSessionAcpMode`, which owns the
   * verdict cache).
   */
  chatSessionAcpMode(dshSessionId: string): boolean {
    return this.choices.chatSessionAcpMode(dshSessionId)
  }

  /**
   * The awaitable form of `chatSessionAcpMode`, served by the `session/chat-list`
   * RPC (see `ChatChoiceService.chatSessionAcpModeAnswer`).
   */
  async chatSessionAcpModeAnswer(dshSessionId: string): Promise<boolean> {
    return this.choices.chatSessionAcpModeAnswer(dshSessionId)
  }

  /** Drop cached ACP-mode verdicts: one session's, or all of them. */
  invalidateAcpMode(dshSessionId?: string): void {
    this.choices.invalidateAcpMode(dshSessionId)
  }

  /**
   * The ACP agent sessions backing one DSH chat session (see
   * `SessionRegistryService.chatSessions`). The composer uses this to offer the
   * agent's OWN modes next to the host's Access mode control — "how the agent
   * works" beside "what it may touch", which is the split that keeps the two
   * controls from reading as duplicates.
   */
  chatSessions(dshSessionId: string): ChatSessionView[] {
    return this.registry.chatSessions(dshSessionId)
  }

  /**
   * Adopt the ACP side of a branched conversation — the agent's own
   * `session/fork` of the parent's live ACP session, then the child's binding
   * (see `SessionRegistryService.adoptForkedSession`). Failure stays
   * all-or-nothing.
   */
  async adoptForkedSession(childDshSessionId: string, parentDshSessionId: string): Promise<{ sessionId: string; acpSessionId: string }> {
    const adopted = await this.registry.adoptForkedSession(childDshSessionId, parentDshSessionId)
    // A fork is the fourth session-creation point: the child needs the same
    // Antigravity-only transient state a fresh chat session gets.
    for (const session of this.registry.sessionsOf(childDshSessionId)) this.initLateOutputState(session)
    return adopted
  }

  /**
   * Bind one DSH chat session to an ACP agent — the plugin's OWN
   * conversation↔agent mapping, never a host model route. Once the first ACP
   * turn has run the conversation is locked to its agent (see
   * `SessionRegistryService.bindChatAgent`).
   */
  bindChatAgent(dshSessionId: string, agentId: string): void {
    return this.registry.bindChatAgent(dshSessionId, agentId)
  }

  /** The ACP agent a chat session was last pointed at (see `SessionRegistryService`). */
  chatAgentFor(dshSessionId: string): string | undefined {
    return this.registry.chatAgentFor(dshSessionId)
  }

  /** The agent a conversation is LOCKED to, if its first ACP turn has run (see `SessionRegistryService`). */
  lockedAgentFor(dshSessionId: string): string | undefined {
    return this.registry.lockedAgentFor(dshSessionId)
  }

  /**
   * The conversation's persisted pick (agent + model + thought level), readable
   * BEFORE the conversation has ever run a turn (see
   * `ChatChoiceService.chatChoice`).
   */
  chatChoice(dshSessionId: string): AcpConversationChoice | undefined {
    return this.choices.chatChoice(dshSessionId)
  }

  /**
   * Record one field of a conversation's pick and persist it. Kept as the
   * manager's receipt for the picker tests, which drive it through an
   * `unknown` cast; the single-write-path rule lives in
   * `ChatChoiceService.patchChatChoice`.
   */
  private patchChatChoice(
    dshSessionId: string,
    patch: Partial<AcpConversationChoice>,
  ): void {
    this.choices.patchChatChoice(dshSessionId, patch)
  }

  /** Switch the bound agent's model for one chat session (`agentId@choice`). */
  async setChatSessionModel(dshSessionId: string, modelId: string): Promise<void> {
    return this.choices.setChatSessionModel(dshSessionId, modelId)
  }

  /**
   * Switch the reasoning effort for one chat session (see
   * `ChatChoiceService.setChatSessionEffort`).
   */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    return this.choices.setChatSessionEffort(dshSessionId, effort, agentId)
  }

  /**
   * Set one of the agent's EXTRA config options for one chat session (see
   * `ChatChoiceService.setChatSessionConfig`).
   */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    return this.choices.setChatSessionConfig(dshSessionId, configId, value, agentId)
  }

  /**
   * Every ACP session's transcript that belongs to one DSH chat session — the
   * conversation's REAL agent stream view tab (see
   * `SessionRegistryService.chatTranscripts`). Read-only: it never spawns and
   * never resumes.
   */
  chatTranscripts(dshSessionId: string, afterSeq?: number): ChatTranscriptView[] {
    return this.registry.chatTranscripts(dshSessionId, afterSeq)
  }

  /**
   * Switch one chat-bound session's ACP mode (see
   * `ChatChoiceService.setChatSessionMode`).
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    return this.choices.setChatSessionMode(dshSessionId, modeId, agentId)
  }

  /**
   * Bring one chat conversation's released session back on the USER's explicit
   * gesture (see `SessionBootService.resumeChatSession`).
   */
  async resumeChatSession(dshSessionId: string): Promise<void> {
    return this.boot.resumeChatSession(dshSessionId)
  }

  /** Wire the harness's preset roster (`ctx.agentPresets`) into `presetStatus` (see `SettingsService`). */
  setPresetRosterReader(reader?: () => Promise<readonly RosterPresetRow[] | undefined>): void {
    this.settings.setPresetRosterReader(reader)
  }

  /** Read-only state of the ACP-mode preset in the harness's own roster (see `SettingsService`). */
  async presetStatus(): Promise<AcpPresetStatus | undefined> {
    return this.settings.presetStatus()
  }

  /** The installed package's version (the settings page's badge). */
  pluginVersion(): string {
    return this.settings.pluginVersion()
  }

  /** Wire the built-in updater (host entry only; absent in pure tests). */
  setUpdateService(service?: UpdateService): void {
    this.settings.setUpdateService(service)
  }

  /** Registry check for the settings card; `unsupported` when no updater is wired. */
  async pluginUpdateCheck(): Promise<PluginUpdateState> {
    return this.settings.pluginUpdateCheck()
  }

  /** Delegate one install to the host plugin manager; never touches files itself. */
  async pluginUpdateApply(version: string): Promise<PluginUpdateState> {
    return this.settings.pluginUpdateApply(version)
  }

  /** One version's release notes for the update card's preview (see `SettingsService`). */
  async pluginReleaseNotes(version: string, refresh = false): Promise<PluginReleaseNotes> {
    return this.settings.pluginReleaseNotes(version, refresh)
  }

  // ---- Turn watchdog & turn-stream index (owned by `TurnWatchdogService`) ----

  /**
   * Thin delegates: the controller index, the stall watchdog, the live-turn
   * reads and the tuning snapshots live in `turn-watchdog-service.ts`. The
   * adapter, the RPC handlers, the save gate and the tests call these on the
   * manager, so their names and signatures stay put.
   */
  turnStreamFor(dshSessionId: string): TurnStreamController | undefined {
    return this.watchdog.turnStreamFor(dshSessionId)
  }

  rememberTurnStream(dshSessionId: string, controller: TurnStreamController): void {
    this.watchdog.rememberTurnStream(dshSessionId, controller)
  }

  forgetTurnStream(controller: TurnStreamController): void {
    this.watchdog.forgetTurnStream(controller)
  }

  private disposeTurnStreamsOf(match: (controller: TurnStreamController) => boolean): void {
    this.watchdog.disposeTurnStreamsOf(match)
  }

  private armStallTimer(): void {
    this.watchdog.armStallTimer()
  }

  get ambientTuning(): { quietMs: number; maxMs: number } {
    return this.watchdog.ambientTuning
  }

  get backgroundTuning(): { taskMaxMs: number; toolMaxMs: number; ceilingMs: number; graceMs: number } {
    return this.watchdog.backgroundTuning
  }

  pendingPermissionViews(): PendingPermissionView[] {
    return this.watchdog.pendingPermissionViews()
  }

  hasActiveTurns(): boolean {
    return this.watchdog.hasActiveTurns()
  }

  activeTurnViews(): ActiveTurnView[] {
    return this.watchdog.activeTurnViews()
  }

  noteSessionBurst(session: LiveSession, outputTokens: number, burstMs: number): void {
    this.watchdog.noteSessionBurst(session, outputTokens, burstMs)
  }

  // ---- Archive release (owned by `ArchiveReleaseService`) ----

  /**
   * Thin delegates: the host's archiving waterfalls call these on the manager,
   * while the facts, the stop and the parking decision live in
   * `archive-release-service.ts`. Names and signatures stay put.
   */
  archiveActivityFacts(dshSessionId: string): { acpSessionId: string }[] {
    return this.archive.archiveActivityFacts(dshSessionId)
  }

  cancelArchivedSession(dshSessionId: string): void {
    this.archive.cancelArchivedSession(dshSessionId)
  }

  releaseArchivedSession(dshSessionId: string): 'released' | 'busy' | 'none' | 'unsupported' {
    return this.archive.releaseArchivedSession(dshSessionId)
  }

  // ---- Agent-definition administration (owned by `AgentAdminService`) ----

  /**
   * Thin delegates: the RPC handlers, the settings page and the tests call
   * these on the manager, but the tombstone / generation bookkeeping and the
   * save gate live in `agent-admin-service.ts`. Names and signatures stay put.
   */

  /**
   * Wire the profile-save gate (host entry only). The gate is exposed as the
   * `acpSaveGate` Cordis service so `dsh-settings` / `dsh-hmr` can ask before
   * they write or replace the plugin; absent in pure bridge tests, where the
   * RPC surface answers "always save now".
   */
  setSaveGate(gate?: AcpSaveGate): void {
    this.admin.setSaveGate(gate)
  }

  /** Current gate state; the RPC/SSE surface and the settings page read it. */
  saveGateStatus(): SaveGateStatus {
    return this.admin.saveGateStatus()
  }

  /**
   * Global explicit "强制保存": execute EVERY queued write now.
   *
   * This is the only caller of {@link AcpSaveGate.forceFlush}. A per-agent
   * `agent/save` with `mode: 'force'` deliberately does NOT come here: that
   * gesture was approved from one agent's dialog and may only drop that
   * agent's own held write.
   */
  async saveGateFlush(): Promise<SaveGateFlushResult> {
    return this.admin.saveGateFlush()
  }

  /** Cancel one label's held write (the settings form's "I kept editing" path). */
  saveGateCancel(label: string): number {
    return this.admin.saveGateCancel(label)
  }

  /** Re-run a failed/expired held write (the failure banner's retry gesture). */
  saveGateRetry(label: string): boolean {
    return this.admin.saveGateRetry(label)
  }

  /** Host query: wait bounded for the ACP plane to become idle. */
  async saveGateWaitIdle(timeoutMs?: number): Promise<boolean> {
    return this.admin.saveGateWaitIdle(timeoutMs)
  }

  /** Auto-spawning probes are suppressed under test runners so suites stay deterministic. */
  private readonly autoProbeEnabled = process.env.VITEST === undefined && process.env.NODE_ENV !== 'test'

  // ---- Model catalog (owned by `ModelCatalogService`) ----

  /**
   * Thin delegates to the catalog service: the model catalog / probe cluster
   * lives in `catalog-service.ts`, but these entry points are part of the
   * manager's public surface (RPC handlers, the LLM adapter and tests read them
   * here), so their names and signatures stay put.
   */
  catalogFor(agentId: string): AcpAgentCatalog | undefined {
    return this.catalog.catalogFor(agentId)
  }

  cachedAgentModels(agentId: string): AgentProbeModelsResult | undefined {
    return this.catalog.cachedAgentModels(agentId)
  }

  async probeAgentModels(agentId: string, model?: string): Promise<AgentProbeModelsResult> {
    return this.catalog.probeAgentModels(agentId, model)
  }

  bootstrapCatalogs(): void {
    this.catalog.bootstrapCatalogs()
  }

  agentCatalog(agentId: string): AgentCatalogResult {
    return this.catalog.agentCatalog(agentId)
  }

  resolveAdapterModel(provider: string, model: string): LlmResolvedModelInfo {
    return this.catalog.resolveAdapterModel(provider, model)
  }

  // ---- Bridge registry & lifecycle (owned by `BridgeRegistryService`) ----

  /**
   * Thin delegates: the process table, the stop gate, the status aggregate and
   * the teardown paths live in `bridge-registry-service.ts`. The RPC handlers,
   * the adapter and the tests call these on the manager, so their names and
   * signatures stay put.
   */
  private bridgeFor(agentId: string, scope: BridgeScope): AgentBridge {
    return this.bridgeRegistry.bridgeFor(agentId, scope)
  }

  private bridgesOf(agentId: string): AgentBridge[] {
    return this.bridgeRegistry.bridgesOf(agentId)
  }

  private bridge(agentId: string): AgentBridge {
    return this.bridgeRegistry.bridge(agentId)
  }

  private keyOfBridge(bridge: AgentBridge): string | undefined {
    return this.bridgeRegistry.keyOfBridge(bridge)
  }

  private bridgeOwning(agentId: string, sessionId: string): AgentBridge | undefined {
    return this.bridgeRegistry.bridgeOwning(agentId, sessionId)
  }

  private bridgeForSession(session: LiveSession): AgentBridge {
    return this.bridgeRegistry.bridgeForSession(session)
  }

  private pruneBridge(key: string): void {
    this.bridgeRegistry.pruneBridge(key)
  }

  private find(sessionId: string): { bridge: AgentBridge; session: LiveSession } {
    return this.bridgeRegistry.find(sessionId)
  }

  private tryLocate(sessionId: string): { bridge: AgentBridge; session: LiveSession } | undefined {
    return this.bridgeRegistry.tryLocate(sessionId)
  }

  private async locateOrResume(sessionId: string): Promise<{ bridge: AgentBridge; session: LiveSession }> {
    return this.bridgeRegistry.locateOrResume(sessionId)
  }

  private connectionLost(bridge: AgentBridge, reason: string): void {
    this.bridgeRegistry.connectionLost(bridge, reason)
  }

  agentViews(): AgentView[] {
    return this.bridgeRegistry.agentViews()
  }

  async stopAgent(agentId: string, persist = true): Promise<void> {
    return this.bridgeRegistry.stopAgent(agentId, persist)
  }

  /** On-demand idle release behind `acp_release` (see `BridgeRegistryService.releaseIdle`). */
  releaseIdleProcesses(agentId?: string): BridgeReleaseReport {
    return this.bridgeRegistry.releaseIdle(agentId)
  }

  async shutdownAll(): Promise<void> {
    return this.bridgeRegistry.shutdownAll()
  }

  /** Host-agent detection: the registry snapshot is the only input. */
  async detectAgents(): Promise<DetectedAgentInfo[]> {
    return this.admin.detectAgents()
  }

  /** Save one definition; the gate semantics live in `AgentAdminService.saveAgent`. */
  async saveAgent(def: AcpAgentDef, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    const result = await this.admin.saveAgent(def, mode)
    this.delegateRegistration?.sync() // the roster (id / title) must reach the NEXT request header
    return result
  }

  /** Lightweight model-visibility update: no process restart. */
  async setExposedModels(agentId: string, exposedModels: readonly string[] | undefined): Promise<void> {
    return this.admin.setExposedModels(agentId, exposedModels)
  }

  /** Toggle auto-discovery of newly published models; no process restart. */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    return this.admin.setAutoDiscoverModels(agentId, autoDiscoverModels)
  }

  /** Per-agent `dsh-skills` opt-out; in-place edit, strictly persisted, no restart. */
  async setSkillsMcp(agentId: string, skillsMcpEnabled: boolean): Promise<void> {
    return this.admin.setSkillsMcp(agentId, skillsMcpEnabled)
  }

  /** Delete one definition and every pointer into it. */
  async deleteAgent(agentId: string): Promise<void> {
    await this.admin.deleteAgent(agentId)
    this.delegateRegistration?.sync()
  }

  /** Probe a throwaway process built from raw form values. */
  async testAgent(def: AcpAgentDef): Promise<AgentTestResult> {
    return this.admin.testAgent(def)
  }

  // ---- /acp RPC face (owned by `BridgeRpcService`) ----

  /**
   * Thin delegates: the `/acp` session / turn / permission RPCs live in
   * `bridge-rpc-service.ts`. `dispatchRpc` and the tests call these on the
   * manager, so their names and signatures stay put.
   */
  async startSession(agentId: string, cwd: string | undefined, opts?: AcpStartSessionOpts): Promise<{ sessionId: string; cwd: string }> {
    return this.rpc.startSession(agentId, cwd, opts)
  }

  async prompt(sessionId: string, prompt: string | ContentBlock[]): Promise<{ turnId: string }> {
    return this.rpc.prompt(sessionId, prompt)
  }

  /** The late answer landed (or failed): the turn is no longer an orphan. */
  private clearOrphanPrompt(session: LiveSession, turnGen: number): void {
    this.rpc.clearOrphanPrompt(session, turnGen)
  }

  async cancel(sessionId: string): Promise<void> {
    return this.rpc.cancel(sessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    return this.rpc.closeSession(sessionId)
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    return this.rpc.setMode(sessionId, modeId)
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    return this.rpc.setConfigOption(sessionId, configId, value)
  }

  respondPermission(requestId: string, optionId: string | undefined): void {
    this.rpc.respondPermission(requestId, optionId)
  }

  transcript(sessionId: string, afterSeq: number | undefined): { session: unknown; entries: Array<{ seq: number; update: unknown }> } {
    return this.rpc.transcript(sessionId, afterSeq)
  }

  sessions(): unknown[] {
    return this.rpc.sessions()
  }

  /** The plugin's own default ACP agent (the panel's ★ gesture; see `SettingsService`). */
  defaultAgent(): string | undefined {
    return this.settings.defaultAgent()
  }

  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    return this.settings.setDefaultAgent(agentId)
  }

  /** The agent tag's halo preference (composer display, plugin-private). */
  tagHalo(): AcpTagHalo {
    return this.settings.tagHalo()
  }

  async setTagHalo(halo: AcpTagHalo): Promise<void> {
    return this.settings.setTagHalo(halo)
  }

  /** Whether generated NTR session titles carry the badge (settings page toggle). */
  sessionTitlePrefix(): boolean {
    return this.settings.sessionTitlePrefix()
  }

  async setSessionTitlePrefix(value: boolean): Promise<void> {
    return this.settings.setSessionTitlePrefix(value)
  }

  /** Declare the deployment baseline for the idle-release window (see `SettingsService`). */
  setConfiguredIdleRelease(idleTimeoutMs: number | undefined): void {
    this.settings.setConfiguredIdleRelease(idleTimeoutMs)
  }

  /** Declare the deployment baseline for the approval deadline (see `SettingsService`). */
  setConfiguredApprovalDeadlines(values: Partial<Record<ApprovalDeadlineKey, number>>, mode?: PermissionTimeoutMode): void {
    this.settings.setConfiguredApprovalDeadlines(values, mode)
  }

  /** The approval deadline in force, plus the facts that explain it (see `SettingsService`). */
  approvalDeadlines(): AcpApprovalDeadlines {
    return this.settings.approvalDeadlines()
  }

  /** The idle-release window in force, plus the deployment baseline (see `SettingsService`). */
  idleRelease(): AcpIdleRelease {
    return this.settings.idleRelease()
  }

  /** Write the idle-release window (hot; see `SettingsService`). */
  async setIdleRelease(idleTimeoutMs: number | undefined, reset = false): Promise<void> {
    return this.settings.setIdleRelease(idleTimeoutMs, reset)
  }

  /** Write the approval deadline or mode (hot; see `SettingsService`). */
  async setApprovalDeadlines(patch: ApprovalDeadlinePatch, reset = false): Promise<void> {
    return this.settings.setApprovalDeadlines(patch, reset)
  }

  // ---- delegate face (settings + session policy; the registration seam is wired by the entry) ----

  delegateSettings(): AcpDelegateSettings | undefined { const s = this.settings.delegateSettings(); return { ...s, toolAvailable: this.delegateRegistration?.toolAvailable ?? false, restrictAvailable: this.delegateRegistration?.restrictAvailable ?? false } }

  setDelegateSettings(patch: DelegateSetPayload): Promise<void> { return this.settings.setDelegateSettings(patch) }

  setConfiguredDelegate(config: AcpDelegateConfig | undefined): void { this.settings.setConfiguredDelegate(config) }

  delegateConfig(): { guidance: DelegateGuidance; timeoutMs: number; defaultAgent?: string; agentDefaults: Record<string, AcpDelegateAgentDefaults> } { const { guidance, timeoutMs, defaultAgent, agentDefaults } = this.settings.delegateSettings(); return { guidance, timeoutMs, ...(defaultAgent === undefined ? {} : { defaultAgent }), agentDefaults: agentDefaults ?? {} } }

  sessionOptions(sessionId: string): DelegateLiveOptions | undefined { const session = this.bridgeRegistry.tryLocate(sessionId)?.session; return session === undefined ? undefined : { configOptions: session.configOptions, ...(session.modes === undefined ? {} : { modes: { availableModes: session.modes.availableModes ?? [] } }) } }

  setPermissionPolicy(sessionId: string, policy: AcpDelegatePolicy): void { this.rpc.setPermissionPolicy(sessionId, policy) }

  setDelegateRegistration(reg: { sync(): void; readonly toolAvailable: boolean; readonly restrictAvailable: boolean }): void { this.delegateRegistration = reg }

  /** Whether the built-in `dsh-skills` MCP server is offered (see `SettingsService`). */
  skillsMcpEnabled(): boolean {
    return this.settings.skillsMcpEnabled()
  }

  /** Write the skills MCP switch: strict persist first, then hot-apply (see `SettingsService`). */
  async setSkillsMcpEnabled(value: boolean): Promise<void> {
    return this.settings.setSkillsMcpEnabled(value)
  }

  /**
   * External-worker lifecycle records plus the idle-drain report wake-ups.
   * Owned by {@link SubagentService}; the manager keeps the public entry points
   * (RPC handlers, the adapter and tests read them here) as thin delegates.
   */
  private readonly subagents: SubagentService
  /**
   * The Antigravity transcript watch (see `docs/plan/archive/antigravity-late-output.md`):
   * armed by a chat turn that ended on its own, disarmed at every lifecycle
   * boundary and by the bridge teardown. It only DELIVERS; it never closes a
   * turn, kills a process or changes `running`.
   */
  private readonly lateOutput: AgyLateOutputService
  private sessionWorkspaceResolver?: SessionWorkspaceResolver
  private attachmentResolver?: unknown

  // ---- Session boot & resume (owned by `SessionBootService`) ----

  /**
   * Thin delegates: the chat acquisition, the stalled-turn reclaim and the
   * steer's cancel-then-resend gate live in `session-boot-service.ts`.
   * `streamPrompt`, the RPC face and the tests call these on the manager, so
   * their names and signatures stay put.
   */
  async getOrCreateDshSession(dshSessionId: string | undefined, agentId: string, cwd?: string): Promise<LiveSession> {
    return this.boot.getOrCreateDshSession(dshSessionId, agentId, cwd)
  }

  private async prepareStalledSession(session: LiveSession): Promise<{ ok: true; reset?: boolean } | { ok: false; message: string }> {
    return this.boot.prepareStalledSession(session)
  }

  private async reclaimChatPrompt(
    session: LiveSession,
    controller: TurnStreamController,
    signal?: AbortSignal,
  ): Promise<'ok' | 'aborted'> {
    return this.boot.reclaimChatPrompt(session, controller, signal)
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
    const routed = options.sessionId === undefined ? undefined : this.choices.conversationRouteModel(options.sessionId)
    const model = options.sessionId === undefined
      ? options.model
      : lockedTo !== undefined
        ? (routed !== undefined && splitAdapterModelId(routed).agentId === lockedTo
          ? routed
          : this.choices.chatChoice(options.sessionId)?.modelId ?? lockedTo)
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
    // prompt, or worse, fold it into the ACP agent's own context.
    if (options.purpose !== undefined) {
      // A title call carries the session's human messages as a JSON array (the
      // host's `dsh-session-title-llm` prompt). Answer it locally by folding
      // the first one back as the placeholder title: no ACP turn, no bridge
      // session, and the sidebar gets a title even on hosts whose own text
      // fallback never fires (issue #11, DSH 2.0.22-next). The settings
      // toggle opts the placeholder into the badge prefix; the host accepts
      // it as the title's newest revision either way.
      if (options.purpose === 'session-title') {
        const title = extractSessionTitlePlaceholder(
          options.messages ?? [],
          this.settings.sessionTitlePrefix() ? SESSION_TITLE_PREFIX : '',
        )
        if (title !== undefined) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: title }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
      // Compaction — and a title prompt we cannot parse — stays refused before
      // touching (or spawning) anything: compaction is best-effort, and an
      // unparseable title keeps the old refusal so the host can fall back.
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

    // HOST-INTERNAL AUXILIARY CALLS WITH NO SESSION IDENTITY. DSH 0.2.1-rc.5's
    // auto-review risk classifier calls `ctx.llm.stream` with the session
    // header's route (`acp`) but neither a `purpose` nor a `sessionId`. Left
    // alone, that anonymous call reaches `getOrCreateDshSession(undefined, …)`
    // (the `ephemeral:<agent>` bucket), starts a real ACP session and sends the
    // review text as a user prompt — a hidden agent turn with tool access.
    // Real chat always carries a non-empty DSH session id (the host loop names
    // it) and title/compaction carry `purpose` (handled above, which still
    // wins), so this pair is exactly the host-internal auxiliary lane; an
    // empty or null id is no identity at all (runtime null included).
    if (!options.sessionId) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'acp: host-internal auxiliary model calls without a session are not forwarded to the ACP agent',
            code: 'unsupported_auxiliary_call',
          },
        },
      }
      return
    }

    // An IDLE background drain became a chat turn: the manager injected its
    // hidden wake message, and this step must ANSWER it with the collected
    // report — the agent already produced that text, so no `session/prompt` is
    // sent (a second one would make the agent answer its own answer). A wake
    // whose report the host pipeline LOST still closes HERE, locally: one
    // fixed line + one `agent/notice` (kept searchable with the words
    // "background report"). Falling through to the forward picker would
    // re-send the person's last real message as a duplicate prompt — and the
    // agent might dispatch the work all over again.
    const wake = backgroundReportOf(options.messages ?? [])
    if (wake !== undefined) {
      const text = wake.kind === 'report' ? wake.text : BACKGROUND_REPORT_LOST_TEXT
      // A replay of an Antigravity late report is about to reach the user: from
      // here the echo guard may swallow the SAME text the agent replays on the
      // next prompt. Only the step that actually yields the report records it —
      // a wake the FIFO skipped shows nothing, so its next replay must show the
      // old answer again (fail-open, never a double swallow).
      if (wake.kind === 'report') {
        const late = this.registry.sessionAt(options.sessionId, agentId)
        if (late !== undefined) {
          const pending = late.pendingLateEcho
          if (pending !== undefined && pending.report === text) {
            // The guard key is the UNMARKED truncated prefix: the agent replays
            // the original answer, never our truncation marker. The record is
            // event-bound from here: the next turn's close retires it.
            late.lateEcho = { text: pending.guard, thought: pending.thought, at: Date.now() }
            late.pendingLateEcho = undefined
          }
        }
      }
      if (wake.kind === 'lost') {
        this.hub.broadcast({
          type: 'agent/notice',
          agentId,
          level: 'info',
          text: 'acp: a background report wake arrived without its report; answering locally (the full output is in the ACP transcript view)',
        })
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
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
        void this.bridgeForSession(controller.session).cancel(controller.session)
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
    const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspaceResolver, options.sessionId)
    const defaultReadFile = (p: string) => {
      try {
        if (existsSync(p)) return readFileSync(p)
        if (workspaceRoot !== undefined && !isAbsolutePath(p)) {
          const joined = join(workspaceRoot, p)
          if (existsSync(joined)) return readFileSync(joined)
        }
      } catch {}
      return undefined
    }

    const resolver = this.attachmentResolver
    const attachmentContext = resolver !== undefined && typeof resolver === 'object' && resolver !== null
      ? Object.assign(Object.create(resolver), {
          readFile: (p: string) => {
            if (typeof (resolver as { readFile?: unknown }).readFile === 'function') {
              try {
                const res = (resolver as { readFile: (p: string) => unknown }).readFile(p)
                if (res !== undefined) return res
              } catch {}
            }
            return defaultReadFile(p)
          },
        })
      : {
          readFile: defaultReadFile,
        }

    const selection = selectForwardPrompt(options.messages ?? [], attachmentContext)
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
    // Same key `getOrCreateDshSession` looks up: a session the watchdog left
    // orphaned must be reclaimed BEFORE the acquisition, so this message cannot
    // queue behind a prompt the agent will never answer.
    const stalled = this.registry.sessionAt(options.sessionId, agentId)
    if (stalled !== undefined && stalled.orphanPromptTurnSeq !== undefined) {
      const prepared = await this.prepareStalledSession(stalled)
      if (!prepared.ok) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: prepared.message, code: 'agent_unresponsive' } },
        }
        return
      }
    }
    try {
      session = await this.getOrCreateDshSession(options.sessionId, agentId)
    } catch (err) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: describeError(err), code: 'session_init_failed' } },
      }
      return
    }

    // The bridge that owns THIS session, not the agent's first slot: an A1
    // agent keeps one process per conversation. Re-resolved through
    // `bridgeForSession` at EVERY use below — a first-turn rollback can close
    // this session and prune its holder (`rollbackFirstTurn` → `pruneBridge`),
    // and a bridge captured once would then `claimTurn` / `beginTurn` /
    // `runPrompt` on a dead object.

    // The model the conversation asks for is not one this agent offers any
    // more: refuse BEFORE sending anything. Falling back to "whatever the agent
    // runs" would silently spend the user's turn on a model they did not
    // choose (different price and capability); the pick is kept so the error
    // and the chip both name the selection that must be replaced.
    const blockedModel = this.choices.staleModelChoice(session, choice)
    if (blockedModel !== undefined) {
      // Nothing was exchanged, so a provisional first turn must hand the
      // conversation back (same rule as any other zero-output failure).
      if (session.provisionalLock === true) this.registry.rollbackFirstTurn(session)
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

    const hasImages = (selection.images?.length ?? 0) > 0 || (selection.content?.some(b => b.type === 'image') ?? false)
    if (hasImages && this.bridgeForSession(session).initResult?.agentCapabilities?.promptCapabilities?.image !== true) {
      if (session.provisionalLock === true) this.registry.rollbackFirstTurn(session)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `acp: agent "${agentId}" does not support image input`,
            code: 'image_unsupported',
          },
        },
      }
      return
    }

    // One prompt slot per session, and a turn the user aborted still occupies
    // the AGENT's slot until it acknowledges the cancel (see `claimTurn`).
    let claim = await this.bridgeForSession(session).claimTurn(session)
    if (!claim.ok) {
      // A STEER ("插话"): the host delivers the user's mid-turn message as the
      // NEXT step of the SAME host turn, so the conversation's own ACP prompt
      // is still on air. Refusing would fail the whole host turn. ACP forbids
      // injecting into a running prompt, so the steer's real semantic — abort
      // the current turn, then send this one — is spelled cancel + wait +
      // re-claim here.
      //
      // Only `busy` can be a steer: it means the AGENT still holds OUR prompt
      // slot. `unsettled` means our side already released the
      // slot (the person pressed stop, or an earlier steer cancelled): the
      // agent has not acknowledged yet, and quietly queueing the next message
      // behind a turn the user stopped is not this path's business — that
      // stays the honest `turn_in_flight` refusal below.
      //
      // Only the conversation's OWN in-flight turn qualifies (its live stream
      // controller, on this very session). A `/acp` RPC turn has no chat
      // controller, and another conversation never reaches this session, so
      // both keep the plain refusal: nothing may be cancelled behind a
      // caller's back.
      const chatController = claim.reason === 'busy' && options.sessionId !== undefined
        ? this.turnStreamFor(options.sessionId)
        : undefined
      if (options.sessionId !== undefined
        && chatController !== undefined
        && !chatController.stale
        && chatController.session === session) {
        const reclaimed = await this.reclaimChatPrompt(session, chatController, options.signal)
        if (reclaimed === 'aborted') {
          // The person pressed stop while the previous turn was winding down:
          // the steer is theirs to re-send, nothing goes to the agent.
          yield {
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } },
          }
          return
        }
        // A first turn that produced nothing rolled its provisional lock back
        // and CLOSED (and forgot) this session: the steer needs a fresh one.
        if (lifecycleOf(session) !== 'live') {
          try {
            session = await this.getOrCreateDshSession(options.sessionId, agentId)
          } catch (err) {
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { message: describeError(err), code: 'session_init_failed' } },
            }
            return
          }
        }
        // Re-resolve: the rollback above may have closed the old session AND
        // pruned its holder, and `getOrCreateDshSession` may have built a fresh
        // one under a new bridge.
        claim = await this.bridgeForSession(session).claimTurn(session)
      }
      if (!claim.ok) {
        // Never roll the provisional lock back here: a failed claim means
        // ANOTHER prompt holds the slot (or the agent has not settled it), and
        // that turn owns the conversation's lock. Closing the session would
        // kill a turn that is actively streaming — the refusal already tells
        // the user to retry.
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
    }

    // Same-agent model/effort switches ride the SAME ACP session (context
    // stays continuous); switching to another agent lands in a separate one
    // via the `${dshSessionId}:${agentId}` key in getOrCreateDshSession.
    // An adapter-DEFAULTED effort is not a choice (see `modelDefaultEffort`):
    // recording or re-applying one would revert the seat's own pick.
    const requestedEffort = options.reasoningEffort
    const turnEffort = requestedEffort !== undefined && requestedEffort === this.choices.modelDefaultEffort(agentId)
      ? undefined
      : requestedEffort
    const aligned = await this.choices.alignSessionConfig(session, choice, turnEffort)
    // The config may have changed between the pre-flight check and this
    // alignment (a `config_option_update` landed in that window). Same rule:
    // never run a model the user did not select.
    if (aligned.modelStale) {
      if (session.provisionalLock === true) this.registry.rollbackFirstTurn(session)
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
    const recorded = options.sessionId === undefined ? undefined : this.choices.chatChoice(options.sessionId)
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
      const resolved = await this.choices.resolveAcpMode(session.dshSessionId)
      session.acpMode = resolved === true
      // This turn may log an `agent-preset/selected` (a blank-session
      // recompose) and any persistence read observed the log BEFORE it: drop
      // the cached verdict so a later ask re-reads against the moved log.
      this.choices.invalidateAcpMode(session.dshSessionId)
    } else {
      session.acpMode = false
    }

    session.running = true
    session.turnSeq += 1
    const turnGen = session.turnSeq
    session.lastAgentActivityAt = Date.now()
    session.activeToolCalls.clear()
    // A new turn owns the session from here: any reclaim marker named an
    // earlier generation and must not suppress THIS turn's settle.
    session.reclaimedTurnSeq = undefined
    this.armStallTimer()
    const turnId = randomUUID()
    this.hub.broadcast({ type: 'turn/start', sessionId: session.sessionId, turnId, text: promptText })

    // The segmented turn: ONE controller for the whole agent-side prompt, one
    // segment per driver step. The first segment streams until a card-bearing
    // stretch meets the next non-tool event (or the prompt settles); the host
    // loop then executes the card and proposes the continuation step, which
    // resumes the SAME prompt through the branch above.
    const endTurn = this.bridgeForSession(session).beginTurn(session)
    const controller = new TurnStreamController(
      this,
      this.hub,
      session,
      turnId,
      endTurn,
      victim => this.registry.rollbackFirstTurn(victim),
    )
    if (session.dshSessionId !== undefined) this.rememberTurnStream(session.dshSessionId, controller)
    // The session itself carries the controller too: an EPHEMERAL turn
    // (`options.sessionId === undefined`) has no chat id to index under, and
    // the stall watchdog needs SOME route to the controller to close the
    // driver's segment queue. For chat turns this also disambiguates a chat id
    // two LiveSessions briefly share (a concurrent first turn). Assigned AFTER
    // `rememberTurnStream` so the controller it just retired cannot clear this
    // attachment.
    session.turnController = controller
    const segment = controller.startSegment()
    const onAbort = (): void => {
      if (controller.stale) return
      // Re-resolve, but through `bridgeOwning`: an abort must never CREATE
      // a process for a session whose holder was pruned (a rolled-back first
      // turn), and a missing owner means there is nothing left to cancel.
      const owner = this.bridgeOwning(session.agentId, session.sessionId)
      if (owner !== undefined) void owner.cancel(session)
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
      const promptBlocks: ContentBlock[] = selection.content && selection.content.length > 0
        ? selection.content as ContentBlock[]
        : [{ type: 'text', text: promptText }]

      const promptBridge = this.bridgeForSession(session)
      promptBridge.runPrompt(session, promptBlocks, turnId, turnGen)
        .then(result => {
          // The reclaim already ended this turn locally, and the close it
          // performed rejected this very request: the late answer is that same
          // turn, not a second one to broadcast.
          if (session.reclaimedTurnSeq === turnGen) {
            session.reclaimedTurnSeq = undefined
            return
          }
          const responseMeta = codebuddyMetaOf({ _meta: result.meta })
          // A RATE-LIMIT REFUSAL: the agent answered the prompt and declined
          // the work because the account is over its quota. CodeBuddy says so
          // with `stopReason: 'refusal'` plus a quota detail in the response
          // `_meta` — a RESOLVED response, so no error path and no
          // `describeError` ever sees the reason. Ranked BEFORE the hold /
          // ambient branches below: a refused turn has no answer coming, so
          // holding it open for a background run would wait on work the agent
          // just said it will not do.
          const refusal = result.stopReason === 'refusal' ? agentRefusalDetail(result.meta) : undefined
          if (refusal?.kind === 'quota') {
            // The dock card reads this through `snapshot()`, so publish it
            // BEFORE the turn ends: a browser that renders the card off
            // `turn/end` must already know why the turn failed.
            session.quotaRefusal = { message: refusal.message, at: Date.now() }
            this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
            controller.settle({
              kind: 'error',
              message: rateLimitedTurnError(agentId, refusal),
              code: 'rate_limited',
              errorKind: 'quota',
            })
            return
          }
          // Any other answer — a normal turn, a plain refusal, a hold, an
          // ambient fold — means the quota is no longer what stopped this
          // session: the banner must not outlive the evidence for it.
          if (session.quotaRefusal !== undefined) {
            session.quotaRefusal = undefined
            this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
          }
          // A DETACHED-WORKER DRAIN: every dispatched worker already reported
          // and the drain that carries its report is imminent, so keep this
          // turn open for that last window (see `holdForBackgroundDispatch`).
          // A worker STILL RUNNING does NOT hold the turn: the user keeps
          // talking, and the worker's report lands in the transcript / NTR
          // view when it finishes (CodeBuddy's own "已派…" answer closes here).
          //
          // The decision comes BEFORE `adoptTurnRequestId`: adopting the id
          // would clear the updates the drain streamed while this turn's own id
          // was unknown, and those are exactly the ones the hold must fold.
          const holdDispatch = controller.detachedHoldWanted(this.tuning.backgroundHoldWorkerPhase === true)
            && lifecycleOf(session) === 'live'
            && result.stopReason !== 'cancelled'
          if (!holdDispatch && responseMeta?.conversationRequestId !== undefined) {
            // The response names the conversation turn it queued: an instant
            // answer that still carries one is a real (if silent) turn, and its
            // prose can be told apart from a background drain's.
            controller.adoptTurnRequestId(responseMeta.conversationRequestId)
          }
          // An announced drain that has shown NO sign of life for the staleness
          // window is over, even though nothing said so (CodeBuddy never sends
          // `session_end`). Keeping the record would make a later instant answer
          // with no conversation request id look steered, and hold a normal turn
          // open against a drain that is never coming back. RETIRE the id
          // first, so a late update or a response naming it is never adopted as
          // this session's own turn; then forget the record (the notice de-dupe
          // set with it) so this response settles normally.
          let active = activeDrain(session.drains)
          if (active !== undefined && Date.now() - active.lastActivityAt > this.tuning.ambientStaleMs) {
            expireAmbientDrain(session)
            active = undefined
          }
          if (holdDispatch) {
            // The response may name one run while an announcement named
            // another; the hold accepts both (see `BackgroundHold.acceptedIds`).
            controller.holdForBackgroundDispatch(
              result.stopReason,
              responseMeta?.conversationRequestId ?? responseMeta?.requestId,
            )
            return
          }
          // An instant answer with NO conversation request id, while the agent
          // announced a background drain this turn has not spoken into: the
          // prompt was folded into that drain (CodeBuddy's multitask). The
          // response is a formality — keep the turn open until the drain speaks.
          if (active !== undefined
            && lifecycleOf(session) === 'live'
            && result.stopReason !== 'cancelled'
            && responseMeta?.conversationRequestId === undefined
            && !controller.hasAgentProse) {
            controller.awaitAmbient(active.requestId, result.stopReason)
            return
          }
          // No ambient record to wait on, but a drain this session stopped
          // waiting on was retired moments ago: the run may have taken this
          // prompt WITHOUT re-announcing itself. The turn cannot be held open
          // (nothing names the drain), but a silent close must say the output
          // may be in the transcript instead of blaming the agent.
          if (active === undefined
            && result.stopReason !== 'cancelled'
            && responseMeta?.conversationRequestId === undefined
            && hasRecentRetiredAmbient(session, Math.max(this.tuning.ambientQuietMs * 2, RETIRED_AMBIENT_RECENT_MIN_MS))) {
            controller.noteRecentRetiredDrain()
          }
          controller.settle(result.stopReason === 'cancelled'
            ? { kind: 'cancelled' }
            // A refusal carries the agent's own reason (`agentRefusalDetail`),
            // and the zero-output line quotes it: a quota was already settled
            // above as an error, so what reaches here is the agent declining
            // the work and saying why.
            : {
              kind: 'stop',
              stopReason: result.stopReason,
              ...(refusal !== undefined ? { refusal: refusal.message } : {}),
            })
        })
        .catch((err: unknown) => {
          if (session.reclaimedTurnSeq === turnGen) {
            session.reclaimedTurnSeq = undefined
            return
          }
          controller.settle({ kind: 'error', message: describeError(err) })
        })
        // The agent's own answer closed the turn: whatever the watchdog marked
        // orphaned has just reported back and no longer needs a reclaim.
        .finally(() => {
          if (session.reclaimedTurnSeq === turnGen) session.reclaimedTurnSeq = undefined
          this.clearOrphanPrompt(session, turnGen)
          // A rollback during this turn could not prune the holder while the
          // agent was still answering (`hasActiveWork` counts the outstanding
          // prompt). Now that it settled, retry — this is the only second chance
          // a closed-and-forgotten session gets.
          const key = this.keyOfBridge(promptBridge)
          if (key !== undefined) this.pruneBridge(key)
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
