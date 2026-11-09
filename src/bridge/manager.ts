import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  type ContentBlock,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import {
  AcpError,
  EventHub,
  Transcript,
  buildAdapterModelId,
  hasUnambiguousModelSelector,
  isAcpToolContinuation,
  parseCatalogOptions,
  usableConfigOptions,
  randomUUID,
  selectForwardPrompt,
  skillFlavorOf,
  extractSessionTitlePlaceholder,
  isAbsolutePath,
  splitAdapterModelId,
  validateAgentDef,
  agentSaveAction,
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
import { DEFAULT_SAVE_GATE_TIMEOUT_MS, SESSION_TITLE_PREFIX } from '../protocol.ts'
import type { AcpSaveGate } from '../save-gate.ts'
import { SaveGateAborted } from '../save-gate.ts'
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
  DisplayedChatDefaults,
  DshAgentLike,
  SessionWorkspaceResolver,
  SubagentCatalogReporter,
} from './types.ts'

import {
  chatWorkspaceRoot,
  ensureDefaultWorkspace,
  legacyFallback,
  migrateLegacyState,
  pluginStateDir,
  rewriteLegacyWorkspaceRoots,
  stateDirExplicit,
} from './state-paths.ts'

import {
  detectHostAgents,
  quoteLegacyCommand,
} from './process.ts'

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
  forkRowInfo,
  isPersistedBurst,
  isPersistedModes,
  isPersistedUsage,
  persistedChatSession,
  rateLimitedTurnError,
  snapshot,
} from './shape.ts'
import { DEFAULT_TUNING } from './tuning.ts'
import { AgentBridge, SHUTDOWN_BUDGET_MS, TEST_EXIT_GRACE_MS } from './agent-bridge.ts'
import { ModelCatalogService } from './catalog-service.ts'
import { classifyTestFailure } from './test-failure.ts'
import { SubagentService } from './subagent-service.ts'
import { SettingsService } from './settings-service.ts'
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
   * `agent/skills` answers, keyed `agentId\0workspaceRoot`, TTL'd by
   * {@link SKILL_SCAN_TTL_MS}. Memory-only: the scan is a pure fs read, so a
   * fresh boot re-scans and nothing is owed to `agents.json`.
   */
  private readonly skillCache = new Map<string, { at: number; result: AgentSkillsResult }>()
  /**
   * Process-lifetime delete tombstones. `deleteAgent` records the id BEFORE it
   * awaits anything, so a save that is already running can notice the delete
   * after its own await and refuse to write the definition back. The value is
   * the delete generation: `deleteAgent` bumps it every time, and a save only
   * survives when the generation it captured still matches AND no tombstone
   * exists.
   *
   * There is deliberately no "recreate a deleted id" entry point: a same-id
   * re-import would have to remove the tombstone explicitly (and start a fresh
   * generation), which no caller does today. Clearing it on a plain save would
   * reopen exactly the resurrection race this map closes.
   */
  private readonly deletedAgentIds = new Set<string>()
  /** Delete generation per agent id; absent = never deleted in this process. */
  private readonly agentDeleteGenerations = new Map<string, number>()
  /**
   * Save generation per agent id. Every `saveAgent` call that will actually
   * write (direct / defer / force) bumps it BEFORE doing anything. An older
   * save already executing captures its generation at the start and refuses to
   * write once a newer save has bumped it: otherwise the older, slower write
   * could land last and silently replace the definition the user just saved.
   */
  private readonly agentSaveGenerations = new Map<string, number>()
  /** Last persist failure already reported, so a hot retry loop cannot spam the log. */
  private lastPersistFailure?: string
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
    private readonly configStoragePath?: string,
    catalogStoragePath?: string,
    /** Auto-probe agents for model catalogs (boot + lazy); manual probes always run. */
    private readonly probeModelsOnBoot = true,
    tuning?: BridgeTuning,
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
    if (this.configStoragePath === undefined && catalogStoragePath === undefined) {
      migrateLegacyState()
    }
    this.catalog = new ModelCatalogService({
      defOf: agentId => this.defsMap.get(agentId),
      isAgentDeleted: agentId => this.deletedAgentIds.has(agentId),
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
      persistAgents: () => this.persistAgents(),
      hub: this.hub,
    }, catalogStoragePath)
    // The subagent / background-report cluster (see `SubagentService`) needs
    // the manager's hub, live sessions, state write and ambient windows; every
    // one is passed as a closure so the service never imports this module.
    this.subagents = new SubagentService({
      hub: this.hub,
      sessions: () => this.dshSessionMap.values(),
      persistAgents: () => this.persistAgents(),
      ambientTuning: () => this.ambientTuning,
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
      persistAgents: () => this.persistAgents(),
    })
    this.loadPersistedAgents()
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
    }, (session, update) => this.subagents.trackSessionBackgroundDispatch(session, update), (session, update) => this.subagents.trackBackgroundDrainText(session, update), (session, status) => this.subagents.terminalizeSessionDispatches(session, status))
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
    this.acpModeResolver = resolver
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
    // The plugin's own lifecycle records, keyed by the CHAT session: they cover
    // live and released sessions alike (a parked conversation's terminal
    // records must survive a reload), and are attached to every row of this
    // conversation — the browser de-duplicates by `dshSessionId + childId`,
    // because one conversation can briefly have more than one ACP session row.
    const subagents = this.subagents.recordsFor(dshSessionId)
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
        ...(session.usage === undefined ? {} : { usage: session.usage }),
        ...(session.burst === undefined ? {} : { burst: session.burst }),
        ...(session.released ? { released: true } : {}),
        ...(session.running ? { running: true } : {}),
        ...(subagents === undefined || subagents.length === 0 ? {} : { subagents: [...subagents] }),
        ...forkRowInfo(session, this.catalog.canForkNow(session.agentId)),
      })
    }
    return out
  }

  /**
   * Adopt the ACP side of a branched conversation: the browser has already
   * asked the HOST to fork the DSH session tree (`sessions.fork`), and this
   * runs the agent's own `session/fork` of the parent conversation's live ACP
   * session so the child actually remembers the parent context — then binds
   * the child to it (the fourth session-creation point, with every discipline
   * the other three carry).
   *
   * Failure is deliberately all-or-nothing: nothing is written for the child
   * until the agent has answered, so a failed adopt leaves the child an
   * ordinary copied-history conversation whose first message starts a fresh
   * `session/new` (today's behavior) — never a half-bound record.
   *
   * @param childDshSessionId - the DSH session the host fork created.
   * @param parentDshSessionId - the conversation being branched; its ACP
   *   session must be LIVE on this connection (a released parent has no
   *   process to fork from — the browser blocks the click, this is the hard
   *   stop behind it).
   */
  async adoptForkedSession(childDshSessionId: string, parentDshSessionId: string): Promise<{ sessionId: string; acpSessionId: string }> {
    // One conversation, one agent (the lock). The parent's LIVE session is
    // the fork source; released or in-flight-settling parents are refused —
    // forking a parked record would silently resume it, and forking mid-turn
    // would fork an agent state the parent turn is still changing.
    const parent = [...this.dshSessionMap.values()].find(session =>
      session.dshSessionId === parentDshSessionId && !session.closed && !session.released)
    if (parent === undefined) {
      throw new AcpError('parent_not_live', 'acp: the conversation to branch has no live ACP session; send a message to resume it first')
    }
    if (parent.running || parent.settled !== undefined) {
      throw new AcpError('turn_in_flight', 'acp: the conversation to branch is running a turn; wait for it to finish')
    }
    const agentId = parent.agentId
    // A1 (F2): refuse before any request or record is written. `canForkNow`
    // below also answers `false`, but failing here keeps the error the same
    // shape even if the capability gate ever changes.
    if (isPerSessionAgent(agentId)) {
      throw new AcpError('fork_unsupported', `acp: agent "${agentId}" runs one process per conversation and cannot fork`)
    }
    const childKey = `${childDshSessionId}:${agentId}`
    if (this.dshSessionMap.has(childKey)) {
      throw new AcpError('id_conflict', 'acp: the forked conversation is already bound to an ACP session')
    }
    // Capability gate BEFORE any request: an agent that never advertised
    // `session/fork` must not be asked (it would answer an unknown-method
    // error at best). Live init wins, last-known falls back — the same
    // verdict the browser's row already showed.
    if (!this.catalog.canForkNow(agentId)) {
      throw new AcpError('fork_unsupported', `acp: agent "${agentId}" does not advertise the session/fork capability`)
    }
    const session = await this.bridge(agentId).forkSession(parent, childDshSessionId)
    // The fork answered — the child is real on the agent side. From here the
    // binding is written through the SAME paths as any chat session: one
    // choice record (a copy of the parent's, locked — a branched conversation
    // belongs to its agent from birth), the route pin, and persistence.
    this.dshSessionMap.set(childKey, session)
    const parentChoice = this.chatAgentIntent.get(parentDshSessionId)
    this.patchChatChoice(childDshSessionId, {
      agentId,
      locked: true,
      ...(parentChoice?.modelId === undefined ? {} : { modelId: parentChoice.modelId }),
      ...(parentChoice?.effort === undefined ? {} : { effort: parentChoice.effort }),
      ...(parentChoice?.mode === undefined ? {} : { mode: parentChoice.mode }),
      ...(parentChoice?.extraConfigs === undefined ? {} : { extraConfigs: { ...parentChoice.extraConfigs } }),
    })
    // The fourth creation point follows the same discipline as `createSession`
    // and `doResumeSession`: apply the recorded pick to the fresh session, so
    // mode and extra configs (which only this path applies) cannot drift from
    // what the composer shows — a forked session starts on the agent-side
    // state the fork copied, and the record must match what runs.
    await this.applyChatChoice(session)
    // Re-publish so the browser's list and the composer's occupancy ring see
    // the child immediately (with its just-bound choice mirrors).
    this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
    this.persistAgents()
    return { sessionId: session.sessionId, acpSessionId: session.acpSessionId }
  }

  /**
   * Bind one DSH chat session to an ACP agent.
   *
   * This is the plugin's OWN conversation↔agent mapping. It deliberately does
   * NOT call the host's `session.selectModel` RPC: the retired "express the
   * agent as a `provider: 'acp'` route" axis used it, which both polluted the
   * deployment default model and got refused by the GUI's catalog gate
   * (`session/model-unavailable`) — even though prompt admission never checked
   * catalog membership. The guard instead writes the session's selection
   * directly (`agent.model.select`) at wake time, on hosts that fix the route
   * before `agent/request`. See docs/acp-convergence.md §1.1 and §2.2.
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
    // Use the session's OWN bridge, not `this.bridge(id)` / a map lookup by
    // agent: the agent may have been deleted while its first turn was failing,
    // and a rollback must never throw — `bridgeOwning` never creates, never
    // throws, and never routes a session to another process.
    const failed = this.bridgeOwning(session.agentId, session.sessionId)
    if (failed !== undefined) {
      // Once the agent-side close has settled, drop the holder too: a failed
      // first turn leaves nothing resumable behind it (the record was forgotten
      // above), so a per-session holder would otherwise linger with a live
      // child and no session — an orphan the next message could not use.
      // `keyOfBridge` runs inside the callback so it names the holder only if
      // this bridge is still registered.
      void failed.closeSession(session, 'closed')
        .catch(() => { /* already gone */ })
        .finally(() => {
          const key = this.keyOfBridge(failed)
          if (key !== undefined) this.pruneBridge(key)
        })
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
   * The guard's model selection (and its legacy `agent/request` rewrite) and
   * this class's own turn admission read
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
    return this.catalog.reasoningMeta(agentId)?.defaultEffort
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
    // A thought level is not a property of the agent alone: opencode publishes
    // `thought_level` only for models with variants, so the previous model's
    // level is not the new model's vocabulary. A LIVE session can judge the old
    // pick against the new model's own option set (`alignSessionConfig`, which
    // drops it with a notice when the set no longer offers it). Before the first
    // session there is no such authority — the catalog still describes the model
    // the agent was last on — so the level is cleared instead of being displayed
    // as this model's own until the first message.
    const previous = this.chatAgentIntent.get(dshSessionId)
    const nextModelId = choice === undefined ? undefined : modelId
    const modelChanged = previous?.agentId === agentId && previous.modelId !== nextModelId
    const hasLiveSession = [...this.dshSessionMap.values()].some(session =>
      session.dshSessionId === dshSessionId && session.agentId === agentId && !session.released)
    const clearEffort = modelChanged && !hasLiveSession
    // The pick is recorded even when NO live session exists yet — that is the
    // "choose the model before the first message" case. A session that
    // materializes later reads it back (`applyChatChoice`).
    this.patchChatChoice(dshSessionId, {
      agentId,
      modelId: nextModelId,
      ...(clearEffort ? { effort: undefined } : {}),
    })
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== agentId) continue
      session.choice = choice
      // A row can carry a level without a recorded pick (`streamPrompt` mirrors
      // the turn's effort onto the session). Clear it on the same evidence as
      // the pick — the row's own model changed and nothing live can re-validate
      // it — or the released row keeps naming the old level.
      const rowModelChanged = session.modelId !== modelId
      session.modelId = modelId
      // The chip reads this mirror through `session/chat-list`; clearing only
      // the pick would leave a parked row naming the old level.
      if (clearEffort || (rowModelChanged && !hasLiveSession)) session.reasoningEffort = undefined
      if (session.released) continue
      const aligned = await this.alignSessionConfig(session, choice, session.reasoningEffort)
      if (aligned.effortStale) session.reasoningEffort = undefined
    }
    this.persistAgents()
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
      if (session.dshSessionId !== dshSessionId) continue
      if (agentId !== undefined && session.agentId !== agentId) continue
      session.reasoningEffort = effort
      if (session.released) continue
      const aligned = await this.alignSessionConfig(session, session.choice, effort)
      // Same rule as the model axis: a dropped level is no longer "in force".
      session.reasoningEffort = aligned.effortStale ? undefined : effort
    }
    this.persistAgents()
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
    const advertised = this.catalog.catalogFor(bound)?.extras?.find(option => option.configId === configId)
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
        await this.bridgeForSession(session).setConfigOption(session, configId, value)
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
          await this.bridgeForSession(session).setMode(session, choice.mode)
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
          await this.bridgeForSession(session).setConfigOption(session, configId, value)
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
   * Switch one chat-bound session's ACP mode.
   *
   * A released session is deliberately NOT resumed for it (user decision,
   * 2026-10-30 — the composer's axes are "what the next turn should use", and
   * the process comes back only when the user sends a message or hits the
   * released banner's resume button). The pick is recorded and
   * `applyChatChoice` applies it on resume, exactly like `setChatSessionModel`
   * / `setChatSessionEffort` / `setChatSessionConfig`; only a LIVE session is
   * told immediately (`session/set_mode`).
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
    // A PARKED session gets the same record-only treatment (its agent is its
    // own `agentId`, whatever the caller passed — the selection above already
    // matched it). Resuming here was the one composer axis that broke ranks
    // with the others, and it woke a process the user had explicitly parked.
    if (target.released) {
      this.patchChatChoice(dshSessionId, { agentId: target.agentId, mode: modeId })
      if (target.modes !== undefined) {
        target.modes = { ...target.modes, currentModeId: modeId }
      }
      this.persistAgents()
      return
    }
    const bridge = this.bridgeForSession(target)
    await bridge.setMode(target, modeId)
    // Persisted only AFTER the agent accepted it: a mode the agent rejected must
    // not come back on the next restore. This is the same contract the model and
    // thought level follow (user decision, 2026-10-18 — every control in the
    // bottom bar remembers its last choice, not just the thought level).
    this.patchChatChoice(dshSessionId, { agentId: target.agentId, mode: modeId })
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
    const candidates = [...this.dshSessionMap.values()].filter(
      session => session.dshSessionId === dshSessionId && !session.closed,
    )
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
    this.lockChatAgent(dshSessionId, target.agentId)
    if (this.chatAgentIntent.has(dshSessionId)) this.syncConversationRoute(dshSessionId)
    else routeBindingRegistry().conversations.set(dshSessionId, resumed.modelId ?? target.agentId)
    await this.applyChatChoice(resumed)
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

  /**
   * Wire the profile-save gate (host entry only). The gate is exposed as the
   * `acpSaveGate` Cordis service so `dsh-settings` / `dsh-hmr` can ask before
   * they write or replace the plugin; absent in pure bridge tests, where the
   * RPC surface answers "always save now".
   */
  setSaveGate(gate?: AcpSaveGate): void {
    this.saveGate = gate
  }

  /** Current gate state; the RPC/SSE surface and the settings page read it. */
  saveGateStatus(): SaveGateStatus {
    return this.saveGate?.status() ?? {
      // No gate wired: this is the same synthetic idle snapshot
      // `emptySaveGateStatus` answers, and it must not claim gate availability.
      gateAvailable: false,
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: DEFAULT_SAVE_GATE_TIMEOUT_MS,
    }
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
    return this.saveGate?.forceFlush() ?? { saved: 0, expired: 0, failed: 0 }
  }

  /** Cancel one label's held write (the settings form's "I kept editing" path). */
  saveGateCancel(label: string): number {
    return this.saveGate?.cancel(label) ?? 0
  }

  /** Re-run a failed/expired held write (the failure banner's retry gesture). */
  saveGateRetry(label: string): boolean {
    return this.saveGate?.retry(label) ?? false
  }

  /** Host query: wait bounded for the ACP plane to become idle. */
  async saveGateWaitIdle(timeoutMs?: number): Promise<boolean> {
    return this.saveGate?.waitForIdle(timeoutMs) ?? true
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
        // The persisted preferences (default agent, halo, title prefix, approval
        // deadlines, idle release) are the settings service's state; it
        // re-validates them on every boot because the file is user- and
        // version-editable (see `SettingsService.loadPersistedSettings`).
        this.settings.loadPersistedSettings(parsed as Record<string, unknown>)
        this.loadPersistedChoices((parsed as { conversations?: unknown }).conversations)
        this.loadPersistedChatSessions((parsed as { chatSessions?: unknown }).chatSessions)
        this.loadPersistedSubagents((parsed as { subagents?: unknown }).subagents)
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
    this.persistAgents()
  }

  /**
   * Write the agent registry.
   *
   * `strict` is for a save whose success the user is waiting on: a failed write
   * must reach the save gate as a rejection instead of a silent "saved". All
   * other call sites keep the old best-effort behavior, but the failure is no
   * longer invisible — it lands in the settings log as one notice per distinct
   * error (a burst of session writes can retry the same broken path).
   */
  private persistAgents(strict = false, staged?: AcpAgentDef): void {
    const filePath = this.getStoragePath()
    if (!filePath) {
      // A strict save has nowhere to write. Silent success here would tell the
      // user the definition survived when the next boot would not load it.
      if (strict) throw new AcpError('persist_failed', 'acp: failed to persist agent state: no writable state path')
      return
    }
    try {
      // The chat-bound session records themselves: a host restart kills the
      // processes but not the agent-side sessions, so restoring these as
      // PARKED keeps a conversation resumable (`session/load`) instead of
      // its next message silently starting a context-less new one.
      const chatSessions = [...this.dshSessionMap.values()]
        .filter(session => session.dshSessionId !== undefined && !session.closed)
        .map(persistedChatSession)
      const subagentRecords = this.subagents.persistedRecords()
      // A save passes its candidate here so the file can land BEFORE `defsMap`
      // commits it. Every other caller writes the committed registry.
      const agents = [...this.defsMap.values()]
      if (staged !== undefined) {
        const index = agents.findIndex(agent => agent.id === staged.id)
        if (index >= 0) agents[index] = staged
        else agents.push(staged)
      }
      // The settings half of the file (default agent, halo, title prefix,
      // approval deadlines, idle release), in its persisted key order.
      const persistedSettings = this.settings.persistedSettings()
      const payload = {
        version: 2,
        ...(persistedSettings.defaultAgentId === undefined ? {} : { defaultAgentId: persistedSettings.defaultAgentId }),
        tagHalo: persistedSettings.tagHalo,
        sessionTitlePrefix: persistedSettings.sessionTitlePrefix,
        agents,
        // The settings page's approval deadlines. Absent while none was ever
        // written, so a fresh deployment's state file stays exactly as it was.
        ...(persistedSettings.approvalDeadlines === undefined
          ? {}
          : { approvalDeadlines: persistedSettings.approvalDeadlines }),
        // The settings page's idle-release pick. Absent while none was
        // ever written, so a fresh deployment's state file stays as it was.
        ...(persistedSettings.idleRelease === undefined
          ? {}
          : { idleRelease: persistedSettings.idleRelease }),
        // The per-conversation picks: agent + model + thought level + mode +
        // extra config values chosen in the composer, including for
        // conversations with no live session yet.
        ...(this.chatAgentIntent.size === 0
          ? {}
          : { conversations: Object.fromEntries(this.chatAgentIntent) }),
        // The plugin's own external-worker lifecycle records (status / failure
        // reason / timings). Absent while none was ever recorded, so a fresh
        // deployment's state file stays exactly as it was.
        ...(Object.keys(subagentRecords).length === 0
          ? {}
          : { subagents: subagentRecords }),
        ...(chatSessions.length === 0 ? {} : { chatSessions }),
      }
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
      this.lastPersistFailure = undefined
    } catch (error) {
      const message = describeError(error)
      if (strict) throw new AcpError('persist_failed', `acp: failed to persist agent state: ${message}`)
      if (this.lastPersistFailure === message) return
      this.lastPersistFailure = message
      this.hub.broadcast({
        type: 'agent/notice',
        agentId: 'dsh-ntr',
        level: 'error',
        text: `acp: failed to persist agent state: ${message}`,
      })
    }
  }

  /**
   * Restore chat session records from disk as PARKED sessions.
   *
   * Every process died with the host, so nothing comes back live — but the
   * agent-side sessions did not. Restoring each record as `released` is what
   * makes the released banner, its resume button and the "next message
   * resumes it" promise survive a restart (the alternative is the next
   * message quietly starting a NEW, context-less session — constraint 10's
   * "released ≠ destroyed" lost at the process boundary). Tolerant, one row
   * at a time: a single corrupt entry must not cost every other conversation
   * its context. Records whose agent is no longer configured are dropped —
   * there is nothing to resume ON, and the next write omits them.
   */
  private loadPersistedChatSessions(raw: unknown): void {
    if (!Array.isArray(raw)) return
    for (const row of raw) {
      if (row === null || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      const { sessionId, acpSessionId, agentId, dshSessionId, cwd } = record
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (typeof acpSessionId !== 'string' || acpSessionId === '') continue
      if (typeof agentId !== 'string' || agentId === '') continue
      if (typeof dshSessionId !== 'string' || dshSessionId === '') continue
      if (typeof cwd !== 'string') continue
      if (!this.defsMap.has(agentId)) continue
      const { title, modelId, reasoningEffort, modes, usage, burst, hasHistory } = record as {
        title?: unknown; modelId?: unknown; reasoningEffort?: unknown; modes?: unknown; usage?: unknown; burst?: unknown; hasHistory?: unknown
      }
      const session: LiveSession = {
        sessionId,
        acpSessionId,
        agentId,
        dshSessionId,
        cwd,
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        ...(typeof modelId === 'string' && modelId !== ''
          ? { modelId, ...(splitAdapterModelId(modelId).choice === undefined ? {} : { choice: splitAdapterModelId(modelId).choice }) }
          : {}),
        ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
        ...(isPersistedModes(modes) ? { modes } : {}),
        ...(isPersistedUsage(usage) ? { usage } : {}),
        ...(isPersistedBurst(burst) ? { burst } : {}),
        ...(hasHistory === true ? { hasHistory: true } : {}),
        running: false,
        turnSeq: 0,
        closed: false,
        released: true,
        lastAgentActivityAt: Date.now(),
        activeToolCalls: new Set<string>(),
        transcript: new Transcript(this.transcriptMax),
      }
      this.dshSessionMap.set(`${dshSessionId}:${agentId}`, session)
      // A1: the record parks on the holder its own DSH conversation will
      // resume through — the same scope the create branch would pick — so the
      // first message after a restart reaches the process that can `session/load`
      // it, not the agent-wide slot. Creating the holder is pure bookkeeping.
      this.bridgeFor(agentId, { kind: 'chat', dshSessionId }).parkReleased(session)
    }
  }

  /**
   * Read the persisted external-worker records back.
   *
   * Orphan keys are dropped AT LOAD, not on every write: only a conversation
   * that still has a `chatSessions` row or a persisted `conversations` entry
   * can own records. Everything else names a conversation the file no longer
   * describes (deleted, or written before a pruning close), and keeping it
   * would only make `agents.json` grow. Shutdown relies on the map staying
   * populated, which is why the prune lives here and not in `persistAgents`.
   *
   * A restored row that never reached a terminal state reads `unknown`: the
   * host restart killed every process, so nothing can still be running
   * (constraint: no row stays `running` forever).
   */
  private loadPersistedSubagents(raw: unknown): void {
    const keep = new Set<string>()
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== undefined && !session.closed) keep.add(session.dshSessionId)
    }
    for (const dshSessionId of this.chatAgentIntent.keys()) keep.add(dshSessionId)
    this.subagents.restore(raw, keep)
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
    let catalog = parseCatalogOptions(session.configOptions)
    // The session's OWN process: A1 gives one agent several children, and a
    // config write must reach the one holding this session, never the agent-wide
    // slot (which may not even be running).
    const bridge = this.bridgeForSession(session)
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
          // The answer carries the NEW model's option set (the bridge has
          // already folded it into `session.configOptions`). Whether a thought
          // level still exists is a property of THAT set — opencode publishes
          // one only for models with variants — so the effort below must be
          // judged against it, not against the model the user just left.
          catalog = parseCatalogOptions(session.configOptions)
        } catch (error) {
          notice('error', `acp: failed to switch model to "${wantedModel}": ${describeError(error)}`)
        }
      }
    }
    if (wantedEffort !== undefined) {
      const thought = catalog.thought
      if (thought === undefined) {
        // A real answer without the slot means this session's model publishes no
        // level axis at all (opencode does so only for models with variants), so
        // the pick is unappliable and must leave the record — otherwise the chip
        // keeps naming a value this model does not offer. An empty/absent option
        // set is NOT such an answer (agents answer `[]` mid-reset); that keeps
        // the pick for a later session.
        if (usableConfigOptions(session.configOptions)) {
          result.effortStale = true
          if (this.dropStalePick(session, 'effort', wantedEffort)) {
            notice('error', `acp: agent "${session.agentId}" no longer offers thought level "${wantedEffort}"; using its own current level`)
          }
        }
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
    // `category` is a UX hint, not identity: an agent may publish several
    // `category: 'model'` options (Qoder CN ships `reasoning_effort` that way)
    // and no explicit `model` id. In that case the selector is a guess, so a
    // "not offered" verdict would refuse a perfectly valid pick — fail open.
    if (!hasUnambiguousModelSelector(session.configOptions)) return undefined
    const model = parseCatalogOptions(session.configOptions).model
    if (model === undefined) return undefined
    if (model.currentValue === wanted) return undefined
    // A selector without a choice list is unvalidatable; applying it is the
    // existing best effort and the agent decides.
    if (model.choices.length === 0) return undefined
    return model.choices.some(choice => choice.value === wanted) ? undefined : wanted
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
        this.persistAgents()
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

  async detectAgents(): Promise<DetectedAgentInfo[]> {
    return detectHostAgents([...this.defsMap.values()])
  }

  /**
   * True once `deleteAgent` ran for this id in this process. The tombstone
   * lives for the process lifetime (see `deletedAgentIds`), so a stale save
   * snapshot and a fresh explicit save are both refused.
   */
  private isAgentDeleted(agentId: string): boolean {
    return this.deletedAgentIds.has(agentId)
  }

  private agentDeleteGeneration(agentId: string): number {
    return this.agentDeleteGenerations.get(agentId) ?? 0
  }

  private agentSaveGeneration(agentId: string): number {
    return this.agentSaveGenerations.get(agentId) ?? 0
  }

  /** Start a new save generation; returns the number this call owns. */
  private nextAgentSaveGeneration(agentId: string): number {
    const generation = this.agentSaveGeneration(agentId) + 1
    this.agentSaveGenerations.set(agentId, generation)
    return generation
  }

  /**
   * Abort a save whose captured delete/save generation no longer matches, or
   * whose id has a delete tombstone. Runs after every await in `saveAgentNow`,
   * so either a delete or a NEWER save that landed while this one was
   * executing wins over the definition it raced.
   * Throwing {@link SaveGateAborted} makes the gate settle `cancelled` (no
   * failure banner, no retryable entry) instead of `failed`.
   */
  private assertAgentSaveCurrent(agentId: string, saveGeneration: number, deleteGeneration: number): void {
    if (
      !this.isAgentDeleted(agentId)
      && this.agentDeleteGeneration(agentId) === deleteGeneration
      && this.agentSaveGeneration(agentId) === saveGeneration
    ) return
    throw new SaveGateAborted(`acp: agent "${agentId}" was deleted or superseded while its save was in flight`)
  }

  /** Record a delete BEFORE awaiting the stop, so in-flight saves can see it. */
  private tombstoneAgent(agentId: string): void {
    this.deletedAgentIds.add(agentId)
    this.agentDeleteGenerations.set(agentId, this.agentDeleteGeneration(agentId) + 1)
  }

  async saveAgent(def: AcpAgentDef, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    // A deleted id never comes back through this entry point. Re-creating one
    // would need an explicit "recreate" gesture that clears the tombstone; no
    // such caller exists today, and a plain save must not reopen the race.
    if (this.isAgentDeleted(def.id)) {
      throw new AcpError('agent_deleted', `acp: agent "${def.id}" was deleted and cannot be saved again`)
    }
    // The host is the single authority for this save: callers that bypass the
    // panel (RPC, scripts) must not interrupt a turn implicitly. Only the two
    // explicit gestures (`defer` / `force`) change that outcome.
    //
    // Order matters: the target's active turns decide whether a force flush is
    // even relevant. Forcing a save on an IDLE agent must not drain unrelated
    // agents' queued writes.
    const label = `agent-save:${def.id}`
    const activeSessions = this.activeTurnViews().filter(view => view.agentId === def.id)
    const action = agentSaveAction(activeSessions, mode)
    if (activeSessions.length > 0 && mode === 'force') {
      // This call owns the definition from here on. The bump happens BEFORE
      // the cancel: an older save already executing must see it and abort at
      // its next await rather than land after the new definition.
      const saveGeneration = this.nextAgentSaveGeneration(def.id)
      // ONLY this agent's held snapshot is dropped. The user authorised the
      // interruption from THIS agent's dialog, so the gesture may not spend
      // that authorisation on other agents: their queued writes stay behind
      // the gate and run at the next idle boundary. The global gesture is
      // the separate `save/flush` -> `saveGateFlush()` entry, which still
      // force-flushes every label.
      this.saveGate?.cancel(label)
      return this.saveAgentDirectly(def, saveGeneration)
    }
    if (activeSessions.length > 0) {
      if (action === 'defer' && this.saveGate !== undefined) {
        // The gate supersedes an older queued save of the same label: the old
        // entry would write values this save has already replaced. The
        // generation this entry owns is captured NOW, so a still-executing
        // older save cannot win after this one is queued.
        const saveGeneration = this.nextAgentSaveGeneration(def.id)
        void this.saveGate.defer(label, () => this.saveAgentNow(def, saveGeneration)).then(outcome => {
          if (outcome.status === 'failed') {
            this.hub.broadcast({
              type: 'agent/notice',
              agentId: def.id,
              level: 'error',
              text: `acp: deferred agent save failed: ${outcome.message}`,
            })
          } else if (outcome.status === 'expired') {
            this.hub.broadcast({
              type: 'agent/notice',
              agentId: def.id,
              level: 'error',
              text: 'acp: deferred agent save expired; save it again',
            })
          }
          // `cancelled` is a silent terminal state: a newer save superseded
          // this entry, or the agent was deleted.
        }, error => {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: def.id,
            level: 'error',
            text: `acp: deferred agent save failed: ${describeError(error)}`,
          })
        })
        return { done: true, deferred: true }
      }
      // A confirm-only gesture never supersedes a running save: no newer
      // definition exists yet. The user's next explicit save does that.
      return { done: false, confirmationRequired: true, activeSessions }
    }
    // Idle target: this save is the current version, so a stale queued entry
    // for the same agent must not flush later and overwrite it. Bump the
    // generation BEFORE the write so an older in-flight save aborts at its
    // next await instead of landing after this definition.
    const saveGeneration = this.nextAgentSaveGeneration(def.id)
    this.saveGate?.cancel(label)
    return this.saveAgentDirectly(def, saveGeneration)
  }

  /**
   * A direct save has no gate entry to settle, so a subject-gone abort becomes
   * a benign `cancelled` RESULT. Rethrowing it here would turn a delete the
   * user just performed into a failed RPC and a failure banner. The deferred
   * path deliberately keeps `saveAgentNow` unwrapped: the gate needs the thrown
   * marker to settle the queued entry `cancelled` without recording an outcome.
   */
  private async saveAgentDirectly(def: AcpAgentDef, saveGeneration: number): Promise<AgentSaveResult> {
    try {
      return await this.saveAgentNow(def, saveGeneration)
    } catch (error) {
      if (error instanceof SaveGateAborted) return { done: true, cancelled: true }
      throw error
    }
  }

  /** The original save body: stop this agent's process, persist, then probe. */
  private async saveAgentNow(def: AcpAgentDef, saveGeneration: number): Promise<AgentSaveResult> {
    // Captured before the first await. A delete bumps the generation and adds
    // the tombstone, and a newer save bumps the save generation, so each check
    // below sees that specific competing gesture.
    const deleteGeneration = this.agentDeleteGeneration(def.id)
    this.assertAgentSaveCurrent(def.id, saveGeneration, deleteGeneration)
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

    if (this.bridges.has(resolvedDef.id) || this.bridgesOf(resolvedDef.id).length > 0) {
      // The save performs its own strict registry write below, so the stop
      // must not race it with a second best-effort one.
      await this.stopAgent(resolvedDef.id, false)
      // First await cleared: the user may have deleted this agent, or a newer
      // save may have started, while the process was stopping. Abort before
      // touching the registry or the file.
      this.assertAgentSaveCurrent(resolvedDef.id, saveGeneration, deleteGeneration)
      // `stopAgent` drops the per-scope keys; the bare slot goes here too.
      this.bridges.delete(resolvedDef.id)
      this.bridgeScopes.delete(resolvedDef.id)
    }

    // Second gate immediately before the two writes that make the save
    // observable: either a tombstone or a newer save recorded during any
    // earlier callback wins here.
    this.assertAgentSaveCurrent(resolvedDef.id, saveGeneration, deleteGeneration)
    // Strict + STAGED: the file lands first. `defsMap` only commits after a
    // successful write, so a failed disk write cannot leave memory naming a
    // definition the registry file does not have.
    this.persistAgents(true, resolvedDef)
    this.defsMap.set(resolvedDef.id, resolvedDef)
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
    return { done: true }
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
    const view = this.aggregateView(def)
    // The aggregate is the agent's state; the view rides along only when a
    // holder exists, exactly as this frame always did (no `error` field here).
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: view.state,
      ...(this.bridgesOf(agentId).length === 0 ? {} : { agent: view }),
    })
    this.catalog.broadcastExposure(agentId)
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
    this.catalog.broadcastExposure(agentId)
  }

  async deleteAgent(agentId: string): Promise<void> {
    // Tombstone FIRST, before any await: a save that is already past its
    // generation check must see the delete when it resumes, and every later
    // save of this id is refused outright.
    this.tombstoneAgent(agentId)
    // Drop the agent's held save BEFORE stopping it: stopping ends its turns,
    // and a deferred snapshot flushing afterwards would write the definition
    // straight back into `agents.json` (the deleted agent would come back).
    this.saveGate?.cancel(`agent-save:${agentId}`)
    if (this.bridges.has(agentId) || this.bridgesOf(agentId).length > 0) {
      // This method performs its own strict registry write below.
      await this.stopAgent(agentId, false)
      // `stopAgent` drops every per-scope key; the bare key is the non-A1 /
      // pre-spawn slot and is removed here as well.
      this.bridges.delete(agentId)
      this.bridgeScopes.delete(agentId)
    }
    this.defsMap.delete(agentId)
    // The default agent is a pointer INTO this registry: deleting its target
    // must drop the pointer too, or the file would keep naming a ghost.
    this.settings.forgetAgent(agentId)
    // Same for the request-path binding: a conversation pointed at the deleted
    // agent must fall back (to the default, or to no rewrite) rather than send
    // the next turn after a ghost.
    for (const [dshSessionId, model] of routeBindingRegistry().conversations) {
      if (splitAdapterModelId(model).agentId === agentId) routeBindingRegistry().conversations.delete(dshSessionId)
    }
    if (routeBindingRegistry().defaultModel === agentId) routeBindingRegistry().defaultModel = undefined
    // All three maps are independent (any may be missing), so delete all
    // before deciding whether the file needs rewriting. The fork capability
    // goes with the agent: a same-id rebuild must not inherit the OLD agent's
    // "supported" and click into a `fork_unsupported` wall before its own
    // first `initialize` answers.
    this.catalog.forgetAgent(agentId)
    // Strict: the delete must not report success when the registry still names
    // the agent. The tombstone and the in-memory deletion stay in place even
    // when this throws, so nothing resurrects it inside this process; the RPC
    // failure tells the user the file needs another attempt.
    this.persistAgents(true)
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
      // The child's exit may still be in flight when the handshake failure is
      // reported (see `awaitStartChildExit`): give it a bounded moment so the
      // verdict can carry the exit code.
      await bridge.awaitStartChildExit(TEST_EXIT_GRACE_MS)
      // The failure is reported as FACTS, not only as the SDK's sentence: every
      // spawn failure rejects the pending `initialize` with the same
      // "ACP connection closed", which cannot tell "the agent is not installed"
      // from "the launch command is wrong". The browser writes the sentence from
      // `failure`; `error` stays for the raw text.
      const attempt = bridge.startAttempt
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        failure: classifyTestFailure(attempt),
        ...(attempt === undefined
          ? {}
          : {
            command: attempt.command,
            ...(attempt.executablePath === undefined ? {} : { executablePath: attempt.executablePath }),
            installTried: attempt.installTried,
            ...(attempt.spawnError === undefined ? {} : { spawnError: attempt.spawnError }),
            ...(attempt.exit === undefined ? {} : { exit: attempt.exit }),
          }),
        durationMs: Date.now() - startedAt,
        stderr: [...bridge.stderrTail],
      }
    } finally {
      await bridge.stop().catch(() => { /* already torn down by the failure path */ })
    }
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
      this.forgetDshSession(sessionId)
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
    // delete its holder — leaving an orphan process plus a live `dshSessionMap`
    // record that no bridge serves (the next prompt would fail on a dead
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
      for (const [key, session] of this.dshSessionMap) {
        if (session.agentId !== agentId) continue
        owned.add(session.sessionId)
        this.dshSessionMap.delete(key)
      }
      this.disposeTurnStreamsOf(controller => owned.has(controller.session.sessionId))
      if (persist) this.persistAgents()
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
    // `parkSessions`) writes the parked records out of `dshSessionMap`, and
    // that write is what keeps the conversations resumable across the restart.
    //
    // `allSettled`, not `all`: one bridge's failure must neither skip the
    // others nor reject a disposer that never asked for an answer. And NOT
    // cleared afterwards either: a late `persistAgents` would then write
    // `chatSessions: []` and erase exactly what the shutdown just saved. These
    // records are terminal — nothing reads them again after disposal.
    await Promise.allSettled([...this.bridges.values()].map(b => b.shutdown(SHUTDOWN_BUDGET_MS)))
  }

  /** The host-entry save gate; absent in pure bridge tests. */
  private saveGate?: AcpSaveGate

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

  private readonly dshSessionMap = new Map<string, LiveSession>()
  /**
   * External-worker lifecycle records plus the idle-drain report wake-ups.
   * Owned by {@link SubagentService}; the manager keeps the public entry points
   * (RPC handlers, the adapter and tests read them here) as thin delegates.
   */
  private readonly subagents: SubagentService
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
    const owners = new Set<string>()
    let dropped = false
    for (const [key, session] of this.dshSessionMap) {
      if (session.sessionId === sessionId) {
        if (session.dshSessionId !== undefined) owners.add(session.dshSessionId)
        this.dshSessionMap.delete(key)
        dropped = true
      }
    }
    // An explicitly closed (or force-reset) session destroys the
    // conversation's worker records with it: the rows belong to a conversation
    // that no longer exists. Only when NO OTHER ACP session still serves the
    // same conversation — two sessions of one conversation must not lose each
    // other's history.
    for (const dshSessionId of owners) {
      let stillOwned = false
      for (const session of this.dshSessionMap.values()) {
        if (session.dshSessionId === dshSessionId) {
          stillOwned = true
          break
        }
      }
      if (!stillOwned) this.subagents.forget(dshSessionId)
    }
    // The disk record goes with it: a closed session is destroyed, not parked,
    // and must not come back on the next boot (constraint 10).
    if (dropped) this.persistAgents()
  }
  private sessionWorkspaceResolver?: SessionWorkspaceResolver
  private acpModeResolver?: AcpModeResolver
  private attachmentResolver?: unknown
  /** Cached `chatSessionAcpMode` answers, keyed by DSH chat session id. */
  private readonly acpModeCache = new Map<string, boolean>()
  /** In-flight cold reads behind `chatSessionAcpModeAnswer`, keyed by session id. */
  private readonly acpModeInflight = new Map<string, Promise<boolean | undefined>>()

  /**
   * The agent values the composer is showing for a conversation that has not
   * picked them — the catalog's current model, thought level, mode and extra
   * config values.
   *
   * Captured BEFORE `session/new`: materializing the session absorbs its own
   * defaults into the catalog (`absorbCatalog`), which would overwrite exactly
   * the values the user saw and leave the first turn running the agent's
   * defaults instead. Reading is pure memory, same as `agentCatalog`.
   */
  private displayedChatDefaults(agentId: string): DisplayedChatDefaults | undefined {
    const catalog = this.catalog.catalogFor(agentId)
    if (catalog === undefined) return undefined
    const out: DisplayedChatDefaults = {}
    const model = catalog.model?.currentValue
    if (model !== null && model !== undefined && model !== '') {
      out.modelId = buildAdapterModelId(agentId, model)
    }
    // Only the level the chip itself reports: `reasoningMeta` keeps
    // `defaultEffort` only when the current value is one of the agent's levels.
    const effort = this.catalog.reasoningMeta(agentId)?.defaultEffort
    if (effort !== undefined) out.effort = effort
    // The mode select's pre-first-message value is the catalog's last-known
    // mode (the agent's own answer from another session), and `session/new`
    // starts on whatever the agent itself defaults to. Without capturing it,
    // a conversation whose select reads "Bypass Permissions" would run its
    // first turn on "Always Ask" — the same display/run split the model and
    // thought level are seeded for.
    const mode = catalog.mode?.currentValue
    if (mode !== null && mode !== undefined && mode !== '') out.mode = mode
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
   * model / thought level / mode / extras, while the ACP session `session/new`
   * just created starts on whatever the agent itself defaults to. Without this
   * the user is shown one model and the agent runs another — the defect
   * reported as "the displayed model was not used", and the reported first
   * turn that ignored the mode select's value. Values the fresh session does
   * not offer are skipped (its `configOptions` are the authority, and the
   * catalog update that rode `session/new` will correct the display), never
   * turned into a failed first turn. Explicit picks always win: only missing
   * fields are filled.
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
    // `reasoning.defaultEffort` was observed on whichever model the agent was
    // last on, and the composer only shows it as THIS conversation's default
    // when the route resolves to that same model (see `describeRoute`). A model
    // picked before the first message makes the old default the previous
    // model's level: seeding it would run a value the chip never showed.
    const pickedModelValue = current?.modelId === undefined ? undefined : splitAdapterModelId(current.modelId).choice
    const displayedModelValue = displayed.modelId === undefined ? undefined : splitAdapterModelId(displayed.modelId).choice
    // A catalog that cannot name its model proves nothing about an explicitly
    // picked one; only "no model picked" (the bare route / agent's own model)
    // is safe there. Mirrors `describeRoute`.
    const effortAppliesToDisplayedModel = pickedModelValue === undefined
      || (displayedModelValue !== undefined && pickedModelValue === displayedModelValue)
    if (current?.effort === undefined && displayed.effort !== undefined && thought !== undefined
      && effortAppliesToDisplayedModel) {
      if (thought.choices.length === 0 || thought.choices.some(choice => choice.value === displayed.effort)) {
        patch.effort = displayed.effort
        changed = true
      }
    }
    // The mode is the third axis of the same contract. The select's value
    // before the first message is the catalog's last-known mode; `session/new`
    // answers with the agent's own default. Seed the displayed one when the
    // fresh session still offers it — an agent that publishes no `modes`
    // field is applied best-effort, exactly like `applyChatChoice`.
    const displayedMode = displayed.mode
    const offeredModes = session.modes?.availableModes ?? []
    if (current?.mode === undefined && displayedMode !== undefined
      && (offeredModes.length === 0 || offeredModes.some(entry => entry.id === displayedMode))) {
      patch.mode = displayedMode
      changed = true
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
        this.forgetDshSession(existing.sessionId)
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
      if (dshSessionId !== undefined) this.lockChatAgent(dshSessionId, agentId)
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
      // The load refreshed the record's mirrors (modes / usage / hasHistory);
      // persist so a later restart restores what this resume saw.
      this.persistAgents()
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
    // The record is on disk from here: a host restart restores it as parked
    // instead of the next message starting a context-less new session.
    this.persistAgents()
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
    this.forgetDshSession(session.sessionId)
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
    const stalled = this.dshSessionMap.get(`${options.sessionId ?? 'ephemeral'}:${agentId}`)
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

    const hasImages = (selection.images?.length ?? 0) > 0 || (selection.content?.some(b => b.type === 'image') ?? false)
    if (hasImages && this.bridgeForSession(session).initResult?.agentCapabilities?.promptCapabilities?.image !== true) {
      if (session.provisionalLock === true) this.rollbackFirstTurn(session)
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
      victim => this.rollbackFirstTurn(victim),
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
