import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  type ContentBlock,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import {
  AcpError,
  EventHub,
  buildAdapterModelId,
  isAcpToolContinuation,
  parseCatalogOptions,
  randomUUID,
  selectForwardPrompt,
  skillFlavorOf,
  extractSessionTitlePlaceholder,
  isAbsolutePath,
  splitAdapterModelId,
} from '../impl.ts'
import type {
  PendingPermissionView,
  RosterPresetRow,
} from '../impl.ts'
import type {
  AcpAgentCatalog, AcpAgentDef, AcpApprovalDeadlines, AcpConversationChoice, AcpPresetStatus, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentSaveMode, AgentSaveResult, AgentSkillsResult, AgentTestResult, AgentView, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, GenerateOptions,
  LlmResolvedModelInfo,
  AcpIdleRelease, ActiveTurnView, ApprovalDeadlineKey, ApprovalDeadlinePatch, PermissionTimeoutMode, PluginReleaseNotes, PluginUpdateState, SaveGateFlushResult, SaveGateStatus, SessionView, StreamChunk,
  SubagentDetailResult, SubagentRecord,
} from '../protocol.ts'
import { SESSION_TITLE_PREFIX } from '../protocol.ts'
import type { AcpSaveGate } from '../save-gate.ts'
import { scanSkillDirs } from '../skills-scan.ts'
import type { UpdateService } from '../update.ts'
import {
  bridgeKey,
  isPerSessionAgent,
  type BridgeScope,
} from './identity.ts'

import type {
  AcpModeResolver,
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
  codebuddyMetaOf,
  hasRecentRetiredAmbient,
  retireAmbientId,
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
import { AgentBridge, SHUTDOWN_BUDGET_MS } from './agent-bridge.ts'
import { ModelCatalogService } from './catalog-service.ts'
import { SubagentService } from './subagent-service.ts'
import { SettingsService } from './settings-service.ts'
import { ChatChoiceService } from './chat-choice-service.ts'
import { AgentAdminService } from './agent-admin-service.ts'
import { SessionRegistryService } from './session-registry-service.ts'
import { PersistenceService } from './persistence-service.ts'
import { describeError } from './errors.ts'

/** How long one `agent/skills` scan answer stays fresh; the browser re-asks past it. */
const SKILL_SCAN_TTL_MS = 60_000
/** Cached `agent/skills` answers (agent × workspace), evicted oldest-first. */
const SKILL_SCAN_CACHE_MAX = 32

/** Routes host session ids to their owning bridge. */
export class BridgeManager {
  /**
   * Process slots, keyed by `bridgeKey(agentId, scope)`. A non-per-session
   * agent folds every scope onto the bare agent id (exactly one entry, as
   * before); a per-session agent (A1) keeps one entry per chat / ephemeral /
   * probe scope, so `bridges.values()` stays the complete set and every
   * traversal keeps working unchanged.
   */
  private readonly bridges = new Map<string, AgentBridge>()
  /** The scope each `bridges` entry was created for; keys are opaque and never parsed. */
  private readonly bridgeScopes = new Map<string, BridgeScope>()
  /**
   * Agents whose `stopAgent` is on the stack, with an overlapping-stop counter.
   * `bridgeFor` refuses to mint a holder for them (see `stopAgent`): a message
   * arriving during the teardown's `await` must not spawn a child the snapshot
   * never saw, or that child would outlive the key sweep and leave a session
   * record no process can serve. A counter rather than a flag so two
   * overlapping stops cannot open the gate when the first one returns.
   */
  private readonly stoppingAgents = new Map<string, number>()
  /**
   * Child bridge → the startup error already written to the settings log. An
   * `error` child under a `ready` aggregate has no status-frame voice, so the
   * notice is its only surface; dedupe keeps repeated status publishes from
   * repeating the line.
   */
  private readonly noticedBridgeFailures = new WeakMap<AgentBridge, string>()
  private readonly defsMap = new Map<string, AcpAgentDef>()
  /** Model catalog + probe cluster; owns the catalog file and fork capability cache. */
  private readonly catalog: ModelCatalogService
  /**
   * Settings + tuning cluster; owns the persisted preferences, the status cards
   * and the hot application of both tuning windows (see `SettingsService`).
   */
  private readonly settings: SettingsService
  /**
   * Chat-choice cluster: the conversation's bottom-bar selection, the
   * request-path route pin and the ACP-mode verdict cache (see
   * `ChatChoiceService`). It operates on the session registry's pick map
   * (passed by reference).
   */
  private readonly choices: ChatChoiceService
  /**
   * Chat-session registry + conversation binding + first-turn lock (see
   * `SessionRegistryService`): the DSH session records, the persisted picks
   * and the lock helpers. The process table and the start / resume / retry
   * flows stay here; the service reaches them through host callbacks.
   */
  private readonly registry: SessionRegistryService
  /**
   * Agent-definition administration + the save gate (see `AgentAdminService`):
   * the delete tombstones, the delete / save generations and the `save/*` gate
   * state machine. The registry (`defsMap`) and the bridge table stay here and
   * reach the service as host callbacks.
   */
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
  /**
   * `agent/skills` answers, keyed `agentId\0workspaceRoot`, TTL'd by
   * {@link SKILL_SCAN_TTL_MS}. Memory-only: the scan is a pure fs read, so a
   * fresh boot re-scans and nothing is owed to `agents.json`.
   */
  private readonly skillCache = new Map<string, { at: number; result: AgentSkillsResult }>()
  /**
   * Tuning in force, defaults applied. The approval deadline and the idle
   * window are rewritten IN PLACE by `SettingsService` (through the host's
   * `replaceTuning`), which is why this is a live object rather than the
   * constructor's parameter: every bridge built afterwards inherits the rewrite
   * instead of the boot-time value.
   */
  private readonly tuning: Required<BridgeTuning>
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

  /**
   * The ambient windows a turn's controller reads once at construction (see
   * {@link BridgeTuning.ambientQuietMs}). Exposed as a plain snapshot so the
   * controller never pokes at the manager's tuning object, and tests can tune
   * the cadence through the constructor like every other window.
   */
  get ambientTuning(): { quietMs: number; maxMs: number } {
    return {
      quietMs: this.tuning.ambientQuietMs,
      maxMs: this.tuning.ambientMaxMs,
    }
  }

  /**
   * The detached-worker hold's windows, read once at controller construction
   * for the same reason as {@link ambientTuning}: `taskMaxMs` is the worker
   * phase's SHORT silence window, `toolMaxMs` its long tier while the worker's
   * last known state is an open tool call (0 falls back to the short one), both
   * pushed out by every dispatch / worker update (see
   * {@link BridgeTuning.backgroundTaskMaxMs} /
   * {@link BridgeTuning.backgroundTaskToolMs}); `ceilingMs` their optional
   * absolute bound (0 = none) and `graceMs` the bounded wait a PARKED hold
   * gives the host to open its continuation step (see
   * {@link BridgeTuning.backgroundParkedGraceMs}). The drain phase reuses
   * {@link ambientTuning}.
   */
  get backgroundTuning(): { taskMaxMs: number; toolMaxMs: number; ceilingMs: number; graceMs: number } {
    return {
      taskMaxMs: this.tuning.backgroundTaskMaxMs,
      toolMaxMs: this.tuning.backgroundTaskToolMs > 0 ? this.tuning.backgroundTaskToolMs : this.tuning.backgroundTaskMaxMs,
      ceilingMs: this.tuning.backgroundTaskCeilingMs,
      graceMs: this.tuning.backgroundParkedGraceMs,
    }
  }

  /**
   * The echo guard's window (see {@link BridgeTuning.agyLateOutputEchoMs}): a
   * delivered late answer stays eligible for deduplication this long, because
   * the agent may replay it on a prompt that comes minutes later. Read from
   * the CURRENT tuning at each use, like every other live window.
   */
  get lateEchoTuning(): { echoMs: number } {
    return { echoMs: this.tuning.agyLateOutputEchoMs }
  }

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

  /**
   * The stall watchdog's scan loop. Armed lazily at the first turn start and
   * DROPPED once nothing anywhere is running: a manager that never runs a turn
   * never holds a timer, and one that goes quiet does not keep the host awake.
   */
  private stallTimer?: ReturnType<typeof setInterval>

  private armStallTimer(): void {
    // `turnStallMs === 0` disables the WHOLE watchdog — the base window is the
    // switch. `turnStallToolMs` cannot re-enable it: that number only widens
    // the window for a turn that already has a tool in flight.
    if (this.tuning.turnStallMs <= 0 || this.stallTimer !== undefined) return
    const timer = setInterval(() => { this.reapStalledTurns() }, Math.max(1, this.tuning.turnStallTickMs))
    timer.unref?.()
    this.stallTimer = timer
  }

  /**
   * Force-finalize turns the agent has gone silent in.
   *
   * "Silent" is scoped to the stretch where the AGENT owes the turn a word: a
   * running session with a segment on air and no pending ask. A turn waiting on
   * the host (tool cards executing between segments) or on a human (an
   * unanswered permission) is not stuck and is skipped.
   *
   * Firing does NOT kill the process (see `LiveSession.orphanPromptTurnSeq`):
   * the session, its transcript and its binding survive, and the next message
   * reclaims the process. The turn's streaming face ends through its own
   * controller when there is one, so the driver step on air closes with an
   * error instead of being torn down mid-stream.
   */
  private reapStalledTurns(): void {
    const now = Date.now()
    let anyRunning = false
    for (const bridge of this.bridges.values()) {
      for (const session of bridge.sessionList) {
        if (session.running) anyRunning = true
        if (!session.running || session.closed || session.released) continue
        // A question is on the table: the agent is waiting on a human, not
        // stuck, and that wait is the permission deadline's business.
        if (bridge.permissions.hasPendingFor(session.sessionId)) continue
        // The controller this turn is streaming through. A chat turn is indexed
        // by chat id (its continuation steps look it up that way) AND attached
        // to the session; an EPHEMERAL turn has no chat id and therefore only
        // the attachment — treating it as an `/acp` turn would finalize the
        // session state without closing the driver's segment queue.
        const indexed = session.dshSessionId === undefined ? undefined : this.turnStreams.get(session.dshSessionId)
        // An index hit only speaks for THIS session: a concurrent first turn
        // can have mapped another LiveSession under the same chat id.
        const attached = session.turnController
          ?? (indexed !== undefined && indexed.session === session ? indexed : undefined)
        // A controller from an EARLIER turn is stale the moment any newer turn
        // (e.g. an `/acp` prompt on the same chat) advances `turnSeq`: its
        // segment is already closed, `onAir` would read false, and the
        // watchdog would skip this turn forever. Treat it as absent.
        const live = attached !== undefined && !attached.stale ? attached : undefined
        // An `/acp`-RPC turn has no driver stream, so "on air" reads as true.
        const onAir = live === undefined ? true : live.hasOpenSegment
        if (!onAir) continue
        const toolWindow = this.tuning.turnStallToolMs > 0 ? this.tuning.turnStallToolMs : this.tuning.turnStallMs
        const threshold = session.activeToolCalls.size > 0 ? toolWindow : this.tuning.turnStallMs
        if (now - session.lastAgentActivityAt < threshold) continue
        void bridge.cancel(session)
        session.orphanPromptTurnSeq = session.turnSeq
        const turnGen = session.turnSeq
        const message = `acp: agent "${session.agentId}" sent no activity for ${String(Math.round(threshold / 1000))}s; the stalled turn was force-finalized`
        // A provisional first turn that showed nothing is about to be rolled
        // back by `settle` (lock released, session closed), so the notice must
        // not promise a resume that will not happen.
        const willRollback = live !== undefined && live.session.provisionalLock === true && !live.sawVisibleBlock
        if (live !== undefined) live.settle({ kind: 'error', message, code: 'INACTIVITY_TIMEOUT' })
        else bridge.finalizeTurn(session, turnGen, message)
        // What the next message can do depends on the capability the agent
        // advertised at connect time, and on whether anyone else is using it.
        const capabilities = bridge.view().agentCapabilities as { loadSession?: boolean } | undefined
        const next = willRollback
          ? 'This was the conversation\'s first turn and it delivered nothing, so it was discarded; the next message starts a new ACP session.'
          : capabilities?.loadSession === true
            ? 'The next message will restart the agent and resume the session.'
            : 'The next message will reset the ACP session; this agent does not support session resume.'
        this.hub.broadcast({
          type: 'agent/notice',
          agentId: session.agentId,
          level: 'error',
          text: `${message} ${next} If another conversation is still using the agent, the next send may be refused until that turn finishes.`,
        })
      }
    }
    if (!anyRunning && this.stallTimer !== undefined) {
      clearInterval(this.stallTimer)
      this.stallTimer = undefined
    }
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
    // The archive-release cluster (see `ArchiveReleaseService`) needs the
    // session lookup, the turn stream, the session owner and the teardown.
    this.archive = new ArchiveReleaseService({
      registry: this.registry,
      turnStreamFor: dshSessionId => this.turnStreamFor(dshSessionId),
      bridgeOwning: (agentId, sessionId) => this.bridgeOwning(agentId, sessionId),
      disposeTurnStreamsOf: match => { this.disposeTurnStreamsOf(match) },
    })
    // The subagent / background-report cluster (see `SubagentService`) needs
    // the manager's hub, live sessions, state write and ambient windows; every
    // one is passed as a closure so the service never imports this module.
    this.subagents = new SubagentService({
      hub: this.hub,
      sessions: () => this.registry.sessions(),
      persistAgents: () => this.persistence.persistAgents(),
      ambientTuning: () => this.ambientTuning,
      lateEchoMs: () => this.tuning.agyLateOutputEchoMs,
    })
    // The late-output watch reads Antigravity's private transcript (see the
    // plan). Every manager capability arrives as a closure; the probe pair is
    // the test seam, defaults read the launch command line.
    this.lateOutput = new AgyLateOutputService({
      isAgent: def => (lateOutputProbe === undefined ? isAntigravityAgent(def) : lateOutputProbe.isAgent(def)),
      storeRoot: def => (lateOutputProbe === undefined ? agyStoreRoot(def) ?? undefined : lateOutputProbe.storeRoot()),
      tuning: () => this.tuning,
      host: {
        defOf: agentId => this.defsMap.get(agentId),
        isBusy: session => session.running || session.promptInFlight === true,
        deliver: (session, text) => this.subagents.deliverLateReport(session, text),
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
      sessions: () => this.registry.sessions(),
      bridgeForSession: session => this.bridgeForSession(session),
      chatAgentFor: dshSessionId => this.registry.chatAgentFor(dshSessionId),
      lockedAgentFor: dshSessionId => this.registry.lockedAgentFor(dshSessionId),
      persistAgents: () => this.persistence.persistAgents(),
    }, this.registry.picks)
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
            const view = this.aggregateView(def)
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
          if (session.dshSessionId !== undefined && !session.closed) keep.add(session.dshSessionId)
        }
        for (const dshSessionId of this.registry.choiceKeys()) keep.add(dshSessionId)
        this.subagents.restore(raw, keep)
      },
    }, configStoragePath, this.transcriptMax)
    this.persistence.loadPersistedAgents()
    this.catalog.loadPersistedCatalogs()
    // A persisted deadline override must reach the tuning the bridges are built
    // from, not just the settings card's readout.
    this.settings.applyDeadlineTuning()
    // The same for the idle-release window: a persisted override must
    // reach the tuning the bridges are built from, not just the
    // settings card's readout.
    this.settings.applyIdleReleaseTuning()
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
      this.publishAgentStatus(bridge.def.id)
      this.noticeBridgeFailure(bridge)
    }, (session, update) => this.subagents.trackSessionBackgroundDispatch(session, update), (session, update) => this.subagents.trackBackgroundDrainText(session, update), (session, status) => {
      // A session teardown that skips `clearAmbientState` must still stop the
      // transcript watch: its writer is the process that is going away.
      this.lateOutput.disarm(session)
      this.subagents.terminalizeSessionDispatches(session, status)
    })
  }

  /**
   * Every outstanding ask, across all agents, with the view the browser was
   * shown it — the source of the reconnect replay (see
   * `permissionReplayFrames`). Every ACP ask is a ledger entry, so this is the
   * whole live set.
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

  /**
   * The agent skills one conversation can use (`agent/skills`, the `/` menu's
   * skill rows): flavor from the agent's command line, one filesystem scan
   * over that flavor's skill dirs, TTL-cached in memory per agent + workspace.
   *
   * Deliberately NOT persisted (the structural difference from
   * `absorbCommands`, which must survive restarts because commands can only be
   * DECLARED by a live session): a scan is a pure fs read with no spawn
   * dependency, so a reboot simply re-scans on the first ask, and no
   * `model-catalog.json` shape or schema bump is owed. No SSE frame either —
   * the browser re-asks past the TTL. Unknown agent → empty answer, the same
   * contract `subagentsDetail` keeps.
   */
  async agentSkills(dshSessionId: string, agentId: string): Promise<AgentSkillsResult> {
    const def = this.defsMap.get(agentId)
    if (def === undefined) return { skills: [] }
    const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspaceResolver, dshSessionId)
    const key = `${agentId}\u0000${workspaceRoot ?? ''}`
    const hit = this.skillCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < SKILL_SCAN_TTL_MS) return hit.result
    const flavor = skillFlavorOf(def.command, def.args)
    const result = scanSkillDirs(flavor, workspaceRoot, homedir())
    // Cache eviction is insertion-order based (oldest timestamp wins), like the
    // browser half's prune: 32 agents × workspaces is far beyond any roster.
    while (this.skillCache.size >= SKILL_SCAN_CACHE_MAX) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, value] of this.skillCache) {
        if (value.at < oldestAt) {
          oldestAt = value.at
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      this.skillCache.delete(oldestKey)
    }
    // `truncated` is absent on the wire when nothing was cut — the marker is
    // news, the normal case is not.
    const answer: AgentSkillsResult = { skills: result.skills, ...(result.truncated ? { truncated: true } : {}) }
    this.skillCache.set(key, { at: Date.now(), result: answer })
    return answer
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
   * Bring one chat conversation's released session back on a fresh process on
   * the USER's explicit gesture (the "恢复进程" banner) — the same work the
   * next prompt performs lazily (`getOrCreateDshSession`'s released branch),
   * minus the create path: a banner button must never materialize a session
   * the conversation has not had yet. A live target passes through untouched,
   * so a double click (or a click racing the next message) spawns nothing.
   */
  async resumeChatSession(dshSessionId: string): Promise<void> {
    const candidates = this.registry.sessionsOf(dshSessionId)
    // The session the NEXT message would use — the bound agent's — is the one
    // to bring back; the first candidate is the fallback for a conversation
    // whose binding has drifted (same selection `setChatSessionMode` makes
    // without an explicit agentId).
    const target = candidates.find(session => session.agentId === this.chatAgentFor(dshSessionId)) ?? candidates[0]
    if (target === undefined) {
      throw new AcpError('unknown_session', `acp: no ACP session is bound to chat session ${dshSessionId}`)
    }
    if (!target.released) return
    // The parked record belongs to the holder it was parked on (A1); resuming
    // on any other process would open the same session twice.
    const bridge = this.bridgeForSession(target)
    const resumed = await bridge.resumeSession(target)
    // Chat-side rebind + pick re-application, verbatim the lazy path's: the
    // freshly loaded session comes back at the agent's defaults, so the
    // conversation's model / thought level must be re-applied or the composer
    // would show one thing and the process run another (see
    // `getOrCreateDshSession`).
    resumed.dshSessionId = dshSessionId
    this.registry.lockChatAgent(dshSessionId, target.agentId)
    if (this.registry.hasChoice(dshSessionId)) this.choices.syncConversationRoute(dshSessionId)
    else routeBindingRegistry().conversations.set(dshSessionId, resumed.modelId ?? target.agentId)
    await this.choices.applyChatChoice(resumed)
    resumed.provisionalLock = false
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

  /**
   * Whether any ACP work is in flight. An update install may restart the host,
   * so check/apply describe the host as busy while a turn is running.
   *
   * Segmented turn streams count even between steps (the host is still
   * continuing that turn); `running` / `settled` on a session covers `/acp`
   * turns and the window between a prompt and the agent's acknowledgement.
   */
  hasActiveTurns(): boolean {
    if (this.turnStreams.size > 0) return true
    for (const bridge of this.bridges.values()) {
      if (bridge.hasActiveTurn()) return true
    }
    return false
  }

  /**
   * The live ACP turns the save gate reports. Deduplicated by ACP session id
   * because a chat turn is indexed BOTH under its controller (segmented
   * continuation) and under the session's `running` flag.
   */
  activeTurnViews(): ActiveTurnView[] {
    const views = new Map<string, ActiveTurnView>()
    for (const controller of this.turnStreams.values()) {
      const session = controller.session
      views.set(session.sessionId, {
        sessionId: session.sessionId,
        agentId: session.agentId,
        ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
      })
    }
    for (const bridge of this.bridges.values()) {
      for (const session of bridge.sessionList) {
        if (!session.running && session.settled === undefined) continue
        views.set(session.sessionId, {
          sessionId: session.sessionId,
          agentId: session.agentId,
          ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
        })
      }
    }
    return [...views.values()]
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

  /**
   * Fold one settled ACP turn's measurable burst into the session aggregate and
   * persist it. A turn with no measured inter-chunk gap contributes neither
   * side: adding its tokens with zero time would inflate the session rate.
   */
  noteSessionBurst(session: LiveSession, outputTokens: number, burstMs: number): void {
    if (outputTokens <= 0 || burstMs <= 0) return
    const base = session.burst ?? { outputTokens: 0, burstMs: 0 }
    session.burst = {
      outputTokens: base.outputTokens + outputTokens,
      burstMs: base.burstMs + burstMs,
    }
    this.persistence.persistAgents()
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

  async probeAgentModels(agentId: string): Promise<AgentProbeModelsResult> {
    return this.catalog.probeAgentModels(agentId)
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

  /**
   * Resolve (or create) the bridge for one agent + scope. Creation is pure
   * bookkeeping: `ensureReady` stays lazy, so a lookup that never runs a turn
   * costs an object and nothing else.
   */
  private bridgeFor(agentId: string, scope: BridgeScope): AgentBridge {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    // A teardown owns this agent right now (see `stopAgent`): refuse even an
    // EXISTING holder — it is already in the stop snapshot and going down, so
    // handing it out would act on a dying process — and never mint a new one.
    if (this.stoppingAgents.has(agentId)) {
      throw new AcpError('agent_stopping', `acp: agent "${agentId}" is stopping; send again once it has stopped`)
    }
    const key = bridgeKey(agentId, scope)
    let bridge = this.bridges.get(key)
    if (bridge === undefined) {
      bridge = this.makeBridge(def, (b, reason) => {
        this.connectionLost(b, reason)
      }, (observedAgentId, configOptions, shapeOnly) => {
        if (shapeOnly) this.catalog.absorbCatalogShape(observedAgentId, configOptions)
        else this.catalog.absorbCatalog(observedAgentId, configOptions)
      }, (observedAgentId, commands) => {
        this.catalog.absorbCommands(observedAgentId, commands)
      }, () => {
        this.persistence.persistAgents()
      }, (observedAgentId, supported) => {
        this.catalog.noteForkCapability(observedAgentId, supported)
      })
      this.bridges.set(key, bridge)
      this.bridgeScopes.set(key, scope)
    }
    return bridge
  }

  /** Every bridge currently serving one configured agent (one entry unless A1). */
  private bridgesOf(agentId: string): AgentBridge[] {
    const result: AgentBridge[] = []
    for (const bridge of this.bridges.values()) {
      if (bridge.def?.id === agentId) result.push(bridge)
    }
    return result
  }

  /** The legacy single-slot lookup; non-per-session agents keep the exact old key. */
  private bridge(agentId: string): AgentBridge {
    return this.bridgeFor(agentId, { kind: 'agent' })
  }

  /** Every session id this bridge owns right now (live + parked), for isolation checks. */
  private sessionIdsOf(bridge: AgentBridge): Set<string> {
    const ids = new Set<string>()
    for (const session of bridge.sessionList) ids.add(session.sessionId)
    for (const session of bridge.releasedList) ids.add(session.sessionId)
    return ids
  }

  /** The key a bridge is registered under, for pruning by key. */
  private keyOfBridge(bridge: AgentBridge): string | undefined {
    for (const [key, value] of this.bridges) {
      if (value === bridge) return key
    }
    return undefined
  }

  /**
   * The bridge that OWNS a session right now: live, parked, or resuming. Never
   * throws and never creates, so a lookup for a session that is already gone
   * cannot resurrect a process.
   */
  private bridgeOwning(agentId: string, sessionId: string): AgentBridge | undefined {
    for (const bridge of this.bridges.values()) {
      if (bridge.def.id !== agentId) continue
      if (bridge.hasSession(sessionId) !== undefined) return bridge
      if (bridge.hasReleased(sessionId) !== undefined) return bridge
      // A resume is the third ownership state the comment above promises:
      // `doResumeSession` clears `released` before `session/load` and only
      // registers the session after its response, so for that whole request
      // the record is in neither map. Reporting it owner-less here would let
      // `getOrCreateDshSession` forget a healthy conversation mid-recovery.
      if (bridge.inflightResume(sessionId) !== undefined) return bridge
    }
    return undefined
  }

  /**
   * The bridge a session belongs to. Ownership by session id wins (live or
   * parked); a chat session then falls back to the scope its DSH id names, and
   * anything else is an error — a session must never be routed by `agentId`
   * alone, which is the shared-`currentSession` bug A1 removes.
   */
  private bridgeForSession(session: LiveSession): AgentBridge {
    const owning = this.bridgeOwning(session.agentId, session.sessionId)
    if (owning !== undefined) return owning
    if (session.dshSessionId !== undefined) return this.bridgeFor(session.agentId, { kind: 'chat', dshSessionId: session.dshSessionId })
    throw new AcpError('unknown_session', `acp: no bridge owns session ${session.sessionId}`)
  }

  /**
   * Drop a per-session holder once nothing a later turn could resume is left in
   * it. A parked record keeps the holder alive; an agent-wide holder is never
   * dropped because it IS the agent's process slot.
   */
  private pruneBridge(key: string): void {
    const bridge = this.bridges.get(key)
    if (bridge === undefined) return
    if (!isPerSessionAgent(bridge.def.id)) return
    if (!bridge.isDiscardable()) return
    this.bridges.delete(key)
    this.bridgeScopes.delete(key)
    // Dropping the last reference must take the child with it: `isDiscardable`
    // means this holder has no live / parked session and no work left, so
    // nothing can use the process again — leaving it running would orphan it
    // with no owner and no idle timer. `stop` is fire-and-forget here exactly
    // like every non-shutdown teardown (see `killChild`).
    if (bridge.state !== 'stopped') {
      void bridge.stop('agent-stopped').catch(() => { /* already gone */ })
    }
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
    // Only THIS bridge's sessions: an A1 agent's other conversations ride their
    // own processes, and matching by `agentId` would abort turns that are still
    // running fine. `releaseAll` below is already per-bridge (`parkSessions`
    // walks this instance's own `sessions`).
    const owned = this.sessionIdsOf(bridge)
    this.disposeTurnStreamsOf(controller => owned.has(controller.session.sessionId))
    bridge.releaseAll(reason, 'died')
  }

  /**
   * One agent's status as every process serving it adds up. A1 gives an agent
   * several children (one per conversation, one per probe), so the browser
   * needs a single answer: any live child means `ready`; only when none is
   * live does `starting` / `error` surface; nothing at all means `stopped`.
   * The BASE view (the first child in the winning state) carries the identity
   * fields; `liveSessions` is the union across every child.
   */
  private aggregateView(def: AcpAgentDef): AgentView {
    const bridges = this.bridgesOf(def.id)
    if (bridges.length === 0) {
      // Field-for-field the pre-spawn shape a non-A1 agent has always
      // reported: "not started yet" must not become a different shape.
      return this.makeBridge(def, () => { /* pre-spawn */ }).view()
    }
    const views = bridges.map(bridge => bridge.view())
    const state: AgentView['state'] =
      views.some(view => view.state === 'ready') ? 'ready'
        : views.some(view => view.state === 'starting') ? 'starting'
          : views.some(view => view.state === 'error') ? 'error'
            : 'stopped'
    const base = views.find(view => view.state === state) ?? views[0]
    const liveSessions = new Set<string>()
    for (const view of views) {
      for (const sessionId of view.liveSessions) liveSessions.add(sessionId)
    }
    // `stderrTail` rides along only when the AGGREGATE is `error`, and then
    // `base` is an error view — its tail is the right diagnostic. A ready
    // aggregate must never inherit a stale tail from a failed sibling.
    return { ...base, state, liveSessions: [...liveSessions] }
  }

  /**
   * Broadcast ONE `agent/status` frame built from the aggregate of every
   * process serving the agent. For a non-A1 agent there is exactly one child,
   * so the frame is byte-for-byte the one the bridge used to publish itself:
   * same `state`, same `error` (when it carries one), same `agent` view.
   *
   * A pruned child is already gone from `bridgesOf` when its `stop` reports —
   * that is deliberate: a closing probe must not flash the whole agent
   * `stopped` while its conversations are still live.
   */
  private publishAgentStatus(agentId: string): void {
    const def = this.defsMap.get(agentId)
    if (def === undefined) return
    const view = this.aggregateView(def)
    const bridges = this.bridgesOf(agentId)
    // The error belongs to the child that produced the winning state; a
    // lingering error on a stopped sibling must not colour a ready agent. No
    // second fallback: a ready aggregate whose own children carry no error must
    // publish NO `error` field, never another child's stale text.
    const error = bridges.find(bridge => bridge.state === view.state && bridge.errorText !== undefined)?.errorText
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: view.state,
      ...(error === undefined ? {} : { error }),
      agent: view,
    })
  }

  agentViews(): AgentView[] {
    return [...this.defsMap.values()].map(def => this.aggregateView(def))
  }

  /**
   * One log line per distinct startup failure of one child. The aggregate
   * `agent/status` deliberately stays `ready` while ANY sibling serves, so a
   * failed child's error is invisible there; without this notice the user only
   * sees "one conversation does not work". Deduped per bridge instance + text:
   * `publishStatus` fires on every transition and must not spam the log.
   */
  private noticeBridgeFailure(bridge: AgentBridge): void {
    const error = bridge.errorText
    if (bridge.state !== 'error' || error === undefined) return
    if (this.noticedBridgeFailures.get(bridge) === error) return
    this.noticedBridgeFailures.set(bridge, error)
    this.hub.broadcast({
      type: 'agent/notice',
      agentId: bridge.def.id,
      level: 'error',
      text: `acp: agent "${bridge.def.id}" failed to start: ${error}`,
    })
  }

  /** Host-agent detection: the registry snapshot is the only input. */
  async detectAgents(): Promise<DetectedAgentInfo[]> {
    return this.admin.detectAgents()
  }

  /** Save one definition; the gate semantics live in `AgentAdminService.saveAgent`. */
  async saveAgent(def: AcpAgentDef, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    return this.admin.saveAgent(def, mode)
  }

  /** Lightweight model-visibility update: no process restart. */
  async setExposedModels(agentId: string, exposedModels: readonly string[] | undefined): Promise<void> {
    return this.admin.setExposedModels(agentId, exposedModels)
  }

  /** Toggle auto-discovery of newly published models; no process restart. */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    return this.admin.setAutoDiscoverModels(agentId, autoDiscoverModels)
  }

  /** Delete one definition and every pointer into it. */
  async deleteAgent(agentId: string): Promise<void> {
    return this.admin.deleteAgent(agentId)
  }

  /** Probe a throwaway process built from raw form values. */
  async testAgent(def: AcpAgentDef): Promise<AgentTestResult> {
    return this.admin.testAgent(def)
  }

  async startSession(agentId: string, cwd: string | undefined): Promise<{ sessionId: string }> {
    // A1: an `/acp` session gets its own process. The token is only the bridge
    // key; later lookups find the session by the id it was registered with.
    const scope: BridgeScope = isPerSessionAgent(agentId)
      ? { kind: 'ephemeral', token: randomUUID() }
      : { kind: 'agent' }
    const session = await this.bridgeFor(agentId, scope).createSession(cwd)
    return { sessionId: session.sessionId }
  }

  async prompt(sessionId: string, prompt: string | ContentBlock[]): Promise<{ turnId: string }> {
    let located = await this.locateOrResume(sessionId)
    // The watchdog abandoned a previous turn here and the agent may still be
    // holding its prompt slot on the old process: reclaim BEFORE sending, or
    // this message queues behind a turn that will never answer.
    if (located.session.orphanPromptTurnSeq !== undefined) {
      const prepared = await this.prepareStalledSession(located.session)
      if (!prepared.ok) throw new AcpError('agent_unresponsive', prepared.message)
      // Without `session/load` there is nothing to re-locate: the record was
      // dropped on purpose, and "/acp" has no conversation to recreate it from.
      // Re-locating anyway would surface a misleading `unknown_session`.
      if (prepared.reset === true) {
        throw new AcpError('session_reset', `acp: agent "${located.session.agentId}" does not support session resume; start a new session`)
      }
      // A resumable reclaim released the record: re-locate what is live now.
      located = await this.locateOrResume(sessionId)
    }
    const { bridge, session } = located
    // The agent prompt slot is SHARED with chat turns: `running` alone misses
    // a chat turn whose cancellation already released it (`running` false,
    // `promptInFlight` still naming the agent-side turn), and a live chat
    // controller means a continuation step may resume the SAME agent turn.
    // A controller that already SETTLED (kept only so its card's continuation
    // can still stream) has given the agent slot back: `/acp` may use it, and
    // advancing `turnSeq` retires it — the behaviour the stale-controller
    // watchdog case pins.
    const chatController = session.turnController
    if (session.running
      || session.promptInFlight === true
      || (chatController !== undefined && !chatController.stale && !chatController.hasSettled)) {
      throw new AcpError('turn_in_flight', 'acp: this session already has a prompt in flight')
    }

    const blocks: ContentBlock[] = typeof prompt === 'string'
      ? [{ type: 'text', text: prompt }]
      : prompt

    if (blocks.length === 0) {
      throw new AcpError('empty_prompt', 'acp: prompt cannot be empty')
    }

    const hasImages = blocks.some(b => b.type === 'image')
    if (hasImages && bridge.initResult?.agentCapabilities?.promptCapabilities?.image !== true) {
      throw new AcpError('image_unsupported', `acp: agent "${bridge.def.id}" does not support image input`)
    }

    // Claim the SAME slot the chat path claims (`claimTurn` + `beginTurn`): an
    // `/acp` turn in flight must make the next chat prompt wait, and vice
    // versa. The settler is idempotent and identity-guarded; the turn still
    // ends through `turn/end` below, so chat and RPC turns share one gate
    // without sharing a stream controller.
    const endTurn = bridge.beginTurn(session)
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
    const promptText = typeof prompt === 'string'
      ? prompt
      : blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    this.hub.broadcast({ type: 'turn/start', sessionId, turnId, text: promptText })
    void bridge.runPrompt(session, blocks, turnId, turnGen)
      .then(result => {
        // The reclaim already ended this turn locally; the answer it caused is
        // that same turn reporting back, not a second turn end for the caller.
        if (session.reclaimedTurnSeq === turnGen) {
          session.reclaimedTurnSeq = undefined
          return
        }
        // A superseded turn's late answer must not end the turn now on air.
        if (session.turnSeq !== turnGen) return
        this.clearOrphanPrompt(session, turnGen)
        // The SAME rate-limit refusal the chat plane settles on (see
        // `streamPrompt`): a refused prompt RESOLVES, so without this the turn
        // would end as a plain `refusal` stop and the reason — which lives only
        // in the response `_meta` — would be dropped. The banner is a chat
        // surface, but the record hangs off the SESSION, and one LiveSession
        // can be driven from both planes: a chat conversation whose last
        // `/acp` answer was normal must not keep showing a quota the agent has
        // already stopped reporting.
        const refusal = result.stopReason === 'refusal' ? agentRefusalDetail(result.meta) : undefined
        if (refusal?.kind === 'quota') {
          session.quotaRefusal = { message: refusal.message, at: Date.now() }
          this.hub.broadcast({ type: 'session/meta', sessionId, session: snapshot(session) })
        } else if (session.quotaRefusal !== undefined) {
          session.quotaRefusal = undefined
          this.hub.broadcast({ type: 'session/meta', sessionId, session: snapshot(session) })
        }
        // Release the shared slot BEFORE the terminal frame: a listener that
        // sends the next prompt on `turn/end` must not read a stale claim.
        endTurn()
        session.running = false
        if (refusal?.kind === 'quota') {
          this.hub.broadcast({
            type: 'turn/end',
            sessionId,
            turnId,
            error: rateLimitedTurnError(session.agentId, refusal),
            errorKind: 'quota',
          })
        } else {
          this.hub.broadcast({ type: 'turn/end', sessionId, turnId, stopReason: result.stopReason })
        }
      })
      .catch((error: unknown) => {
        if (session.reclaimedTurnSeq === turnGen) {
          session.reclaimedTurnSeq = undefined
          return
        }
        if (session.turnSeq !== turnGen) return
        // The turn was ended by an EXTERNAL close (idle release, agent stop):
        // that teardown already broadcast the turn's end, and the session is
        // parked or closed. Reporting the close's rejection again would put a
        // second terminal frame on a turn the browser already saw finish.
        if (session.released || session.closed) {
          this.clearOrphanPrompt(session, turnGen)
          return
        }
        this.clearOrphanPrompt(session, turnGen)
        endTurn()
        session.running = false
        this.hub.broadcast({
          type: 'turn/end',
          sessionId,
          turnId,
          error: describeError(error),
        })
      })
      // Every outcome — normal answer, failure, reclaim early-return, or a
      // close's rejection — releases the shared prompt slot exactly once.
      .finally(() => { endTurn() })
    return { turnId }
  }

  /** The late answer landed (or failed): the turn is no longer an orphan. */
  private clearOrphanPrompt(session: LiveSession, turnGen: number): void {
    if (session.orphanPromptTurnSeq === turnGen) session.orphanPromptTurnSeq = undefined
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
      this.registry.forgetDshSession(sessionId)
      const key = this.keyOfBridge(live.bridge)
      if (key !== undefined) this.pruneBridge(key)
      return
    }
    // A released session has no process left to close; just drop the record.
    for (const [key, bridge] of this.bridges) {
      if (bridge.dropReleased(sessionId)) {
        this.hub.broadcast({ type: 'session/closed', sessionId, reason: 'closed' })
        this.pruneBridge(key)
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

  /**
   * Kill this agent's process and forget its chat-bound session records.
   *
   * The removed records ARE persisted (`persist` defaults to true): a stop
   * closes the agent-side sessions on purpose, so leaving them in `agents.json`
   * would resurrect them as resumable after the next host restart. Save and
   * delete pass `false` because each performs its own strict registry write
   * immediately afterwards; a second best-effort write there would race the
   * definition it is about to replace.
   */
  async stopAgent(agentId: string, persist = true): Promise<void> {
    // Close the gate FIRST, synchronously and before the snapshot: from here
    // until this call returns, `bridgeFor` refuses to mint or hand out a holder
    // for this agent. Without it a message arriving during the `await` below
    // could spawn a child the snapshot never saw, and the key sweep would then
    // delete its holder — leaving an orphan process plus a live session record
    // that no bridge serves (the next prompt would fail on a dead
    // `acpSessionId`).
    this.stoppingAgents.set(agentId, (this.stoppingAgents.get(agentId) ?? 0) + 1)
    try {
      // A1 gives one agent several processes; collect every one of them first so
      // the teardown covers the whole set instead of the old single slot. The
      // KEY travels with each snapshot entry: only those keys may be swept
      // afterwards, never a key a later create re-registered.
      const entries: { key: string; bridge: AgentBridge }[] = []
      for (const [key, bridge] of this.bridges) {
        if (bridge.def?.id === agentId) entries.push({ key, bridge })
      }
      const bridges = entries.map(entry => entry.bridge)
      // The streams to kill are the sessions THIS agent owns — live, parked, or
      // still chat-keyed. Matching on `agentId` would tear down a stream that a
      // differently-scoped child of the same agent still serves.
      const owned = new Set<string>()
      for (const bridge of bridges) {
        for (const sessionId of this.sessionIdsOf(bridge)) owned.add(sessionId)
      }
      for (const sessionId of this.registry.dropSessionsOfAgent(agentId)) owned.add(sessionId)
      this.disposeTurnStreamsOf(controller => owned.has(controller.session.sessionId))
      if (persist) this.persistence.persistAgents()
      // One stop per process, all at once: the children are independent, so the
      // wall clock is the slowest single teardown rather than their sum.
      await Promise.allSettled(bridges.map(bridge => bridge.stop('agent-stopped')))
      // Delete exactly the snapshot keys. The identity check is defensive (the
      // gate already makes a mid-stop registration impossible): a key now
      // holding a DIFFERENT bridge is not ours to delete.
      for (const { key, bridge } of entries) {
        if (this.bridges.get(key) !== bridge) continue
        this.bridges.delete(key)
        this.bridgeScopes.delete(key)
      }
    } finally {
      const remaining = (this.stoppingAgents.get(agentId) ?? 1) - 1
      if (remaining <= 0) this.stoppingAgents.delete(agentId)
      else this.stoppingAgents.set(agentId, remaining)
    }
  }

  /**
   * Host shutdown: park every conversation, then make sure no agent child
   * outlives the host. Bridges run CONCURRENTLY against one bounded budget, so a
   * single wedged agent cannot spend every other bridge's slice too.
   *
   * `/acp`'s "stop this agent" gesture is `stopAgent` → `stop`, which is a
   * different promise: it closes the sessions on purpose. See
   * `AgentBridge.shutdown` for why host exit must not.
   */
  async shutdownAll(): Promise<void> {
    if (this.stallTimer !== undefined) {
      clearInterval(this.stallTimer)
      this.stallTimer = undefined
    }
    this.disposeTurnStreamsOf(() => true)
    // NOT cleared before the shutdown: `persistAgents` (called from
    // `parkSessions`) writes the parked records out of the session registry, and
    // that write is what keeps the conversations resumable across the restart.
    //
    // `allSettled`, not `all`: one bridge's failure must neither skip the
    // others nor reject a disposer that never asked for an answer. And NOT
    // cleared afterwards either: a late `persistAgents` would then write
    // `chatSessions: []` and erase exactly what the shutdown just saved. These
    // records are terminal — nothing reads them again after disposal.
    await Promise.allSettled([...this.bridges.values()].map(b => b.shutdown(SHUTDOWN_BUDGET_MS)))
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

  /**
   * External-worker lifecycle records plus the idle-drain report wake-ups.
   * Owned by {@link SubagentService}; the manager keeps the public entry points
   * (RPC handlers, the adapter and tests read them here) as thin delegates.
   */
  private readonly subagents: SubagentService
  /**
   * The Antigravity transcript watch (see `docs/plan/antigravity-late-output.md`):
   * armed by a chat turn that ended on its own, disarmed at every lifecycle
   * boundary and by the bridge teardown. It only DELIVERS; it never closes a
   * turn, kills a process or changes `running`.
   */
  private readonly lateOutput: AgyLateOutputService
  private sessionWorkspaceResolver?: SessionWorkspaceResolver
  private attachmentResolver?: unknown

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
    const existing = this.registry.sessionAt(dshSessionId, agentId)
    if (existing !== undefined && !existing.closed && !existing.released) {
      const owner = this.bridgeOwning(agentId, existing.sessionId)
      // A LIVE record must have a holder. This state is not reachable today:
      // every production deletion path parks the record first (`closeSession` /
      // `forceReset` set `closed`, a failed resume sets `released`), so only the
      // test suite synthesizes a live record without an owner to pin this
      // fallback. Should it ever happen anyway, returning the record would route
      // the next prompt to a process that no longer exists — the failure would
      // surface later as a dead `acpSessionId`, far from its cause. Drop the
      // unusable record and fail cleanly; the next attempt starts fresh.
      if (owner === undefined) {
        this.registry.forgetDshSession(existing.sessionId)
        throw new AcpError(
          'session_orphaned',
          `acp: the session for this conversation has no live agent process; send again to start a new one`,
        )
      }
      // A resume may be in flight right now: `doResumeSession` clears `released`
      // before `session/load` and only registers the session after it answers,
      // so this record is momentarily owned by that request alone. Await it and
      // reuse the SAME session — never forget the record, and never let a second
      // ACP session be created on the same holder.
      const inflight = owner.inflightResume(existing.sessionId)
      const ready = inflight === undefined ? existing : await inflight
      // An existing session already carries context, so this is never a
      // provisional lock; it only repairs a record from before the flag (the
      // next turn's start writes/announces the lock).
      if (dshSessionId !== undefined) this.registry.lockChatAgent(dshSessionId, agentId)
      return ready
    }
    // The session's agent died earlier: resume in place so the conversation
    // context survives via `session/load`.
    if (existing !== undefined && existing.released) {
      // The bridge that parked this record owns the resume; a chat conversation
      // falls back to the scope its DSH id names, exactly like the `new`
      // branch. Without a DSH id the old anonymous bucket stays as it was.
      const resumeBridge = this.bridgeOwning(agentId, existing.sessionId)
        ?? (dshSessionId === undefined
          ? this.bridge(agentId)
          : this.bridgeFor(agentId, { kind: 'chat', dshSessionId }))
      const resumed = await resumeBridge.resumeSession(existing)
      // Rebind explicitly: a resume keeps the record's identity, but the chat
      // session id is what the conversation's permission card addresses.
      resumed.dshSessionId = dshSessionId
      // A resume without an explicit pick must keep serving the agent the
      // conversation was ON (its own model string when one was recorded). The
      // recorded pick wins when there is one (it carries the model half).
      if (dshSessionId !== undefined) {
        this.registry.lockChatAgent(dshSessionId, agentId)
        if (this.registry.hasChoice(dshSessionId)) this.choices.syncConversationRoute(dshSessionId)
        else routeBindingRegistry().conversations.set(dshSessionId, resumed.modelId ?? agentId)
      }
      // ...and the persisted pick (model / thought level) is re-applied to the
      // freshly loaded session, whose config comes back at the agent's defaults.
      await this.choices.applyChatChoice(resumed)
      // A RESUMED session had context before this call; a lock written here is
      // not provisional even if the conversation record was missing it.
      resumed.provisionalLock = false
      // The load refreshed the record's mirrors (modes / usage / hasHistory);
      // persist so a later restart restores what this resume saw.
      this.persistence.persistAgents()
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
    const displayed = dshSessionId === undefined ? undefined : this.choices.displayedChatDefaults(agentId)
    // A1: each chat conversation gets its own process; a call without a DSH id
    // shares the anonymous bucket, exactly like the old `ephemeral:<agent>` key.
    const scope: BridgeScope = dshSessionId === undefined
      ? { kind: 'ephemeral', token: 'anonymous' }
      : { kind: 'chat', dshSessionId }
    const session = await this.bridgeFor(agentId, scope).createSession(
      workspaceRoot ?? cwd,
      workspaceRoot === undefined ? [] : [workspaceRoot],
      // ...and the agent PROCESS runs there too, not just the session: see
      // `ensureReady` for why `session/new`'s cwd alone is not enough.
      workspaceRoot,
    )
    // Absent for `/acp`-RPC sessions and for adapter calls without a chat
    // session; their permission cards are addressed by the ACP session only.
    session.dshSessionId = dshSessionId
    this.initLateOutputState(session)
    this.registry.putSession(session)
    // Turn the displayed defaults into this conversation's pick, so the first
    // prompt runs on what the user was shown (see `seedChatChoiceFromCatalog`).
    if (dshSessionId !== undefined) this.choices.seedChatChoiceFromCatalog(dshSessionId, agentId, session, displayed)
    // Pin what this conversation now runs on, so a route that does not name it
    // (a fresh session replays the deployment default) is rewritten to reality.
    // The recorded pick wins when there is one (it carries the model half);
    // otherwise the agent that just served this turn is pinned bare.
    if (dshSessionId !== undefined) {
      if (this.registry.hasChoice(dshSessionId)) this.choices.syncConversationRoute(dshSessionId)
      else routeBindingRegistry().conversations.set(dshSessionId, agentId)
    }
    // Apply whatever the conversation picked BEFORE this session existed — the
    // model and thought level chosen in the composer ahead of the first message.
    // `session/new` answered with the agent's defaults; without this the first
    // turn would run on them and the pick would only take effect afterwards.
    await this.choices.applyChatChoice(session)
    if (dshSessionId !== undefined) {
      // The first ACP session is the moment the conversation's context starts
      // belonging to this agent. The lock is PROVISIONAL until this turn shows
      // something: if it delivers nothing, `rollbackFirstTurn` gives the
      // conversation back (a failed first attempt must not trap it).
      session.provisionalLock = this.registry.lockChatAgent(dshSessionId, agentId)
    }
    // The record is on disk from here: a host restart restores it as parked
    // instead of the next message starting a context-less new session.
    this.persistence.persistAgents()
    return session
  }

  /**
   * Take the agent process back from a turn the stall watchdog abandoned.
   *
   * The wedged agent still holds its `session/prompt`, so the next message
   * cannot simply be sent: it would queue behind a turn that may never answer.
   * The process is restarted instead — unless another conversation on the same
   * connection is doing real work, because killing the child destroys THEIR
   * context too, and "retry after they finish" is the honest answer.
   *
   * A restart that can `session/load` costs the conversation nothing: the
   * session is parked `released` and the normal acquisition path resumes it, so
   * chat keeps its lock / `applyChatChoice` semantics and `/acp` keeps
   * `locateOrResume`. An agent without resume support is reset instead, and the
   * user is told the context is gone.
   */
  private async prepareStalledSession(session: LiveSession): Promise<{ ok: true; reset?: boolean } | { ok: false; message: string }> {
    // A session whose `session/close` is still in flight must not be touched:
    // releasing it would park it as resumable and `doResumeSession` flips
    // `closed` back to false, resurrecting a closed session. Its owner deletes
    // the record; the caller's own acquisition creates a new session (chat) or
    // rejects `session_closed` (`/acp`).
    if (session.closed) return { ok: true }
    if (session.released) return { ok: true } // the acquisition resumes it
    const bridge = this.bridgeForSession(session)
    const blocked = `acp: agent "${session.agentId}" is unresponsive, but other conversations are still using it; retry after they finish`
    if (bridge.hasOtherActiveWork(session)) return { ok: false, message: blocked }
    // A sibling conversation the agent already settled is not "work" by
    // `hasOtherActiveWork` — but its HOST may still owe the turn a
    // continuation step (a card it is executing right now), and restarting the
    // process would park and resume that live turn. Its indexed controller is
    // the evidence. Scoped to THIS bridge: the restart kills this bridge's
    // child only, so a sibling conversation on another process (A1) is not a
    // reason to refuse, and a controller of another agent's session never was.
    // A closed or released session has no host behind it (a leftover
    // controller), so it does not pin the child either.
    const owned = this.sessionIdsOf(bridge)
    for (const controller of this.turnStreams.values()) {
      if (controller.session === session) continue
      if (!owned.has(controller.session.sessionId)) continue
      if (controller.session.closed || controller.session.released) continue
      if (!controller.stale) return { ok: false, message: blocked }
    }
    const capabilities = bridge.view().agentCapabilities as { loadSession?: boolean } | undefined
    if (capabilities?.loadSession === true) {
      // Whatever teardown runs, the agent's in-flight `session/prompt` is about
      // to be rejected by the closing connection. Mark the generation so that
      // rejection does not broadcast a second `turn/end` for a turn already
      // finalized by the watchdog (`LiveSession.reclaimedTurnSeq`).
      session.reclaimedTurnSeq = session.turnSeq
      bridge.releaseAll('agent did not acknowledge the stalled turn', 'stalled')
      session.orphanPromptTurnSeq = undefined
      return { ok: true }
    }
    // No resume: the restart IS a reset, so only this session's context is at
    // stake — and any other live session pins the process even while idle.
    if (bridge.sessionList.some(other => other !== session)) return { ok: false, message: blocked }
    const agentId = session.agentId
    // `stop` would ask a wedged agent to close its sessions and wait for an
    // answer that never comes; `forceReset` is the local half only.
    session.reclaimedTurnSeq = session.turnSeq
    bridge.forceReset('agent-stopped')
    this.registry.forgetDshSession(session.sessionId)
    session.orphanPromptTurnSeq = undefined
    this.hub.broadcast({
      type: 'agent/notice',
      agentId,
      level: 'info',
      text: `acp: agent "${agentId}" does not support session resume; the ACP session was reset (context could not be restored)`,
    })
    return { ok: true, reset: true }
  }

  /**
   * 聊天插话的槽位回收：宿主把插话作为同一会话在飞回合的下一步送达，
   * 拒绝会让整条 host turn 失败。ACP 不能向运行中的 prompt 注入消息，
   * 所以按插话语义中止当前回合，等 agent 真正结算后再让调用方重发。
   *
   * 只处理 `claimTurn` 的 `busy`（agent 仍持有本会话 prompt）；`unsettled`
   * 说明我们这一侧已经释放过槽位（用户按过停止），保持原样拒绝。
   *
   * - 控制器已 settle（响应已到，延后收口还没释放闸门）：什么都不取消，只等闸门；
   * - agent 真在跑：走用户取消同一条管线（session/cancel + 结算权限 + cancel fallback），
   *   并立即关闭宿主这一侧的 segment，让闸门在 agent 应答/兜底后打开。
   */
  private async reclaimChatPrompt(
    session: LiveSession,
    controller: TurnStreamController,
    signal?: AbortSignal,
  ): Promise<'ok' | 'aborted'> {
    if (session.closed || session.released) return 'ok'
    if (!controller.hasSettled && session.promptInFlight === true) {
      await this.bridgeForSession(session).cancel(session)
      controller.abortActiveSegment()
    }
    return this.waitForSettleGate(session, signal)
  }

  /** 等 agent 侧 prompt slot 真正释放；步骤被取消时立即返回 aborted。 */
  private waitForSettleGate(session: LiveSession, signal?: AbortSignal): Promise<'ok' | 'aborted'> {
    const pending = session.settled
    if (pending === undefined) return Promise.resolve('ok')
    if (signal?.aborted) return Promise.resolve('aborted')
    return new Promise(resolve => {
      const done = (value: 'ok' | 'aborted'): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => { done('aborted') }
      signal?.addEventListener('abort', onAbort, { once: true })
      void pending.then(() => { done('ok') })
    })
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
          // Lazy expiry: a record older than the guard window can never match
          // a replay, and committing it would only swallow an unrelated answer.
          if (pending !== undefined && Date.now() - pending.at > this.tuning.agyLateOutputEchoMs) {
            late.pendingLateEcho = undefined
          } else if (pending !== undefined && pending.report === text) {
            // The guard key is the UNMARKED truncated prefix: the agent replays
            // the original answer, never our truncation marker.
            late.lateEcho = { text: pending.guard, at: Date.now() }
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
      // A wake turn has NO ACP controller, so `closeTurn` cannot re-arm.
      if (options.sessionId !== undefined) this.lateOutput.armAfterWake(this.registry.sessionAt(options.sessionId, agentId))
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
      // (`promptInFlight`). `unsettled` means our side already released the
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
        if (session.closed || session.released) {
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
            && !session.released
            && !session.closed
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
          if (session.ambient !== undefined
            && Date.now() - session.ambient.lastActivityAt > this.tuning.ambientStaleMs) {
            retireAmbientId(session, session.ambient.requestId, false)
            session.ambient = undefined
            session.ambientNotices?.clear()
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
          if (session.ambient !== undefined
            && !session.released
            && !session.closed
            && result.stopReason !== 'cancelled'
            && responseMeta?.conversationRequestId === undefined
            && !controller.hasAgentProse) {
            controller.awaitAmbient(session.ambient.requestId, result.stopReason)
            return
          }
          // No ambient record to wait on, but a drain this session stopped
          // waiting on was retired moments ago: the run may have taken this
          // prompt WITHOUT re-announcing itself. The turn cannot be held open
          // (nothing names the drain), but a silent close must say the output
          // may be in the transcript instead of blaming the agent.
          if (session.ambient === undefined
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
