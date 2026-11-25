/**
 * Settings and tuning: every preference the settings page persists, plus the
 * read-only cards that describe host services (the preset roster and the
 * built-in updater).
 *
 * Two duties share the same state, which is why they live together:
 * - the persisted preferences (`agents.json`: default agent, tag halo, title
 *   prefix, approval deadlines, idle release) and their hot application;
 * - the settings cards' read side (`presetStatus`, `pluginVersion` and the
 *   update service).
 *
 * The service never imports the manager: every capability it needs (the live
 * bridges a write heats, the tuning object a write rewrites, the registry
 * predicate that filters a stale default, and the state-file write) arrives
 * through {@link SettingsHost}. The tuning OBJECT itself stays owned by the
 * manager because several other clusters read it; this service only rewrites
 * the two approval fields and the idle window through the host.
 */
import {
  AcpError,
  acpPresetStatusFromRoster,
  normalizeApprovalWindow,
  validateApprovalDeadlines,
  validateDelegateConfig,
  validateMcpServers,
  validatePermissionTimeoutMode,
  validateTagHalo,
} from '../impl.ts'
import type { RosterPresetRow } from '../impl.ts'
import type {
  AcpApprovalDeadlines,
  AcpDelegateConfig,
  AcpDelegateSettings,
  AcpIdleRelease,
  AcpMcpServerDef,
  AcpPresetStatus,
  AcpSharedMcpSettings,
  AcpTagHalo,
  ApprovalDeadlineKey,
  ApprovalDeadlinePatch,
  DelegateGuidance,
  DelegateSetPayload,
  DelegateSettingKey,
  PermissionTimeoutMode,
  PluginReleaseNotes,
  PluginUpdateState,
  SharedMcpSetPayload,
} from '../protocol.ts'
import type { HostMcpSnapshot } from './host-mcp.ts'
import type { SessionMcpLiveContext } from './mcp.ts'
import {
  DEFAULT_DELEGATE_GUIDANCE,
  DEFAULT_SESSION_TITLE_PREFIX,
  DEFAULT_TAG_HALO,
  DELEGATE_GUIDANCE,
  DELEGATE_TIMEOUT_MAX_MS,
  DELEGATE_TIMEOUT_MIN_MS,
  IDLE_RELEASE_MS,
  pluginReleaseUrl,
} from '../protocol.ts'
import type { UpdateService } from '../update.ts'
import { PLUGIN_VERSION } from './identity.ts'
import { routeBindingRegistry } from './registries.ts'
import { ACP_PRESET_ID } from './state-paths.ts'
import type { BridgeTuning } from './types.ts'

/**
 * One live bridge, narrowed to the two hot-apply entry points a settings write
 * reaches. `AgentBridge` satisfies this structurally, so the service needs no
 * import of the bridge implementation.
 */
export interface SettingsBridge {
  applyApprovalDeadlines(patch: { permissionTimeoutMs?: number; elicitationTimeoutMs?: number; mode?: PermissionTimeoutMode }): void
  applyIdleRelease(defaultIdleTimeoutMs: number): void
}

/** What the settings service needs from the bridge manager, injected. */
export interface SettingsHost {
  /** Whether an agent id is configured this boot (filters a stale default). */
  hasAgent(agentId: string): boolean
  /** The live bridges a hot settings write must reach, in bridge order. */
  bridges(): Iterable<SettingsBridge>
  /** The tuning object currently in force (owned by the manager). */
  currentTuning(): Required<BridgeTuning>
  /**
   * Write a recomputed tuning back. The manager keeps the same object identity
   * so every reader (`ambientTuning`, the stall watchdog, new bridges) sees the
   * rewrite without being rebuilt.
   */
  replaceTuning(next: Required<BridgeTuning>): void
  /** Rewrite `agents.json` after a persisted preference changed. */
  persistAgents(): void
  /**
   * Rewrite `agents.json` and FAIL when the file cannot be written
   * (`PersistenceService.persistAgents(true)`).
   *
   * The tolerant {@link persistAgents} is right for a preference a boot can
   * re-derive; a value the user is WAITING on must not answer "saved" after a
   * silent write failure — the next boot would load the old value back.
   */
  persistAgentsStrict(): void
  /**
   * Reconcile the delegate tool registration + force mask after a delegate
   * write / boot replay. Optional because the registration seam is wired by
   * the manager entry: until that closure lands, a delegate write still
   * persists and the boot replay simply has nothing to reconcile yet.
   */
  syncDelegateRegistration?(): void
}

/** The settings half of the `agents.json` payload, in its persisted key order. */
export interface PersistedSettings {
  defaultAgentId?: string
  tagHalo: AcpTagHalo
  sessionTitlePrefix: boolean
  /**
   * The built-in `dsh-skills` MCP switch. Absent while the user never wrote it,
   * so a fresh deployment's state file stays exactly what it was.
   */
  skillsMcpEnabled?: boolean
  sharedMcpServers?: AcpMcpServerDef[]
  hostMcpSyncEnabled?: boolean
  approvalDeadlines?: ApprovalDeadlinePatch
  idleRelease?: { idleTimeoutMs: number }
  /**
   * The settings page's delegate picks. Absent while the user never wrote one,
   * so a fresh deployment's state file stays exactly what it was.
   */
  delegate?: Partial<AcpDelegateConfig>
}

export class SettingsService {
  /** The plugin's own default ACP agent id (persisted; see `persistedSettings`). */
  private defaultAgentId?: string
  /** The agent tag's halo preference (persisted; see `persistedSettings`). */
  private tagHaloSetting: AcpTagHalo = { ...DEFAULT_TAG_HALO }
  /**
   * Whether generated NTR session titles carry the badge (persisted; see
   * `persistedSettings`). Read at title-request time, so a settings toggle
   * reaches the next generated title without restarting anything — but
   * already-accepted titles are durable `session/title` events the host owns,
   * so flipping the switch never rewrites existing rows.
   */
  private sessionTitlePrefixEnabled = DEFAULT_SESSION_TITLE_PREFIX
  /**
   * The built-in `dsh-skills` MCP switch (persisted; see `persistedSettings`).
   * `undefined` means the user never wrote it, which runs as OFF — the same
   * value the fresh-deployment default has, kept apart only so the state file
   * stays absent-until-written like every other key here.
   *
   * The switch reaches the agent through the shared tuning, read at REQUEST
   * time (see `AgentBridge`'s seam): turning it on affects the NEXT
   * `session/new` / `session/load` / `session/fork` / probe request only. The
   * agent owns the MCP process, so an already running one is not promised to
   * stop when the switch goes off.
   */
  private skillsMcpEnabledSetting?: boolean
  private sharedMcpServersSetting?: AcpMcpServerDef[]
  private hostMcpSyncEnabledSetting?: boolean
  private hostMcpReader?: () => HostMcpSnapshot
  /**
   * What `cordis.patch.yml` asked for — ONLY if it actually named the key.
   * This is the deployment baseline, kept apart from {@link deadlineOverride}
   * so the settings card can tell the user which of the two is winning. Empty
   * when the file says nothing about the window, in which case
   * {@link baselineDeadline} (the built-in default) applies.
   */
  private configuredDeadlines: Partial<Record<ApprovalDeadlineKey, number>> = {}
  /**
   * The mode the config file named, if it named one. Kept apart from the
   * override for the same reason the window is: the card has to be able to say
   * "the file asks for `abort`, the value set here wins".
   */
  private configuredMode?: PermissionTimeoutMode
  /**
   * The window before any override — the tuning the manager was constructed
   * with, which already carries the validated config file (the host entry
   * passes `validateConfig`'s output) or the built-in default.
   *
   * Held separately from {@link configuredDeadlines} because the two answer
   * different questions: this one is what RUNS when nothing is overridden, that
   * one is what the config file NAMED (which the card shows as the reset target
   * and a bare default does not deserve). A manager built without tuning at all
   * — a direct consumer, a test — gets `DEFAULT_TUNING` here and stays correct.
   */
  private baselineDeadline: number
  /** The independent form-question window before any settings-page override. */
  private baselineElicitationTimeoutMs: number
  /**
   * The mode before any override — the tuning the manager was constructed
   * with, which already carries the validated config file or the built-in
   * default.
   */
  private baselineMode: PermissionTimeoutMode
  /**
   * The settings page's own write, persisted with the agent registry. Merged
   * OVER {@link baselineDeadline}: once a user picks a window in the UI, that
   * pick is what runs, and the config file becomes the value the reset button
   * returns to. Without this split a hand-edited `cordis.patch.yml` and a UI
   * write would fight with no way to tell which one is live.
   */
  private deadlineOverride: ApprovalDeadlinePatch = {}
  /**
   * The idle-release window the settings page picked, in ms, persisted with the
   * agent registry. `undefined` means the deployment baseline runs.
   *
   * Merged OVER {@link baselineIdleTimeoutMs} exactly like
   * {@link deadlineOverride} over {@link baselineDeadline}: a UI pick is what
   * runs, and `cordis.patch.yml` becomes the value the reset button returns to.
   * Without this split the two sources would fight with no way to tell which
   * one is live.
   */
  private idleReleaseOverride?: number
  /**
   * The window `cordis.patch.yml` names, when it names one. Kept apart from
   * the override for the same reason the deadline keeps its baseline apart:
   * the settings card has to be able to say "the file asks for 10 minutes, the
   * value set here wins".
   */
  private configuredIdleTimeoutMs?: number
  /**
   * The idle-release window before any override — the tuning the manager was
   * constructed with (the deployment baseline, or the built-in 30 minutes).
   */
  private baselineIdleTimeoutMs: number
  /**
   * The delegate keys the settings page picked, persisted with the agent
   * registry (`agents.json`'s `delegate`). Only keys the user actually wrote
   * are stored, each merged OVER {@link configuredDelegate} per key exactly
   * like {@link idleReleaseOverride} over the idle baseline: a UI pick is what
   * runs, and `cordis.patch.yml` becomes the value the reset button returns to.
   */
  private delegateOverride: Partial<AcpDelegateConfig> = {}
  /**
   * The delegate keys `cordis.patch.yml` names — ONLY the keys it actually
   * contains (the host entry passes `validateDelegateConfig`'s output). The
   * deployment baseline, kept apart from the override so the settings card can
   * say "the file asks for `enhanced`, the value set here wins"; empty when the
   * file says nothing, in which case the built-in defaults apply (guidance
   * `off`; the timeout follows the global background-task long window).
   */
  private configuredDelegate: AcpDelegateConfig = {}

  /** Host-side reader of the harness preset roster (`ctx.agentPresets`), for `presetStatus`. */
  private presetRosterReader?: () => Promise<readonly RosterPresetRow[] | undefined>
  /**
   * The built-in updater, wired by the host entry. Absent in pure bridge tests —
   * the update RPCs then answer `unsupported` instead of inventing a source.
   */
  private updateService?: UpdateService

  constructor(private readonly host: SettingsHost) {
    // The pre-override deadline value, snapshotted before anything can rewrite
    // it. Everything else in the tuning is fixed for the manager's lifetime,
    // so only these three need a snapshot.
    const tuning = host.currentTuning()
    this.baselineDeadline = tuning.permissionTimeoutMs
    this.baselineElicitationTimeoutMs = tuning.elicitationTimeoutMs
    this.baselineIdleTimeoutMs = tuning.idleTimeoutMs
    this.baselineMode = tuning.permissionTimeoutMode
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

  /** The installed package's version (the settings page's badge). */
  pluginVersion(): string {
    return PLUGIN_VERSION
  }

  /** Wire the built-in updater (host entry only; absent in pure tests). */
  setUpdateService(service?: UpdateService): void {
    this.updateService = service
  }

  /** Registry check for the settings card; `unsupported` when no updater is wired. */
  async pluginUpdateCheck(): Promise<PluginUpdateState> {
    return this.updateService?.check() ?? { status: 'unsupported', current: PLUGIN_VERSION }
  }

  /** Delegate one install to the host plugin manager; never touches files itself. */
  async pluginUpdateApply(version: string): Promise<PluginUpdateState> {
    return this.updateService?.apply(version) ?? { status: 'unsupported', current: PLUGIN_VERSION }
  }

  /**
   * One version's release notes for the update card's preview. Pure read: no
   * install, no registry check. `refresh` is the card's retry and skips the
   * service's cache. Without a wired updater the answer still names the
   * release page, because that URL needs no network.
   */
  async pluginReleaseNotes(version: string, refresh = false): Promise<PluginReleaseNotes> {
    return this.updateService?.releaseNotes(version, refresh)
      ?? { version, url: pluginReleaseUrl(version), source: 'none' }
  }

  /**
   * The plugin's own default ACP agent (the panel's ★ gesture): which agent an
   * ACP-mode conversation starts on. Host-side state in the agent registry
   * file — deliberately NOT a DSH model route: nothing here ever writes to the
   * host's model selection (see docs/acp-convergence.md §2.2).
   */
  defaultAgent(): string | undefined {
    // A default pointing at a deleted agent answers as "none": the browser
    // then offers the agent menu instead of auto-routing nowhere.
    return this.defaultAgentId !== undefined && this.host.hasAgent(this.defaultAgentId) ? this.defaultAgentId : undefined
  }

  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    if (agentId !== undefined && !this.host.hasAgent(agentId)) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    this.defaultAgentId = agentId
    this.host.persistAgents()
    // The request-path rewrite falls back to it for never-bound conversations.
    routeBindingRegistry().defaultModel = agentId
  }

  /**
   * Drop the default pointer when its target is deleted: the registry would
   * otherwise keep naming a ghost. Called by the manager's delete path, which
   * performs its own strict registry write afterwards.
   *
   * The delegate per-agent override entry dies with the agent, but the
   * delegate `defaultAgent` POINTER is kept (keep+mark design: the browser
   * derives the stale mark against the live directory, and the runtime
   * degrades a stale pointer with a note — never a silent persisted edit).
   */
  forgetAgent(agentId: string): void {
    if (this.defaultAgentId === agentId) this.defaultAgentId = undefined
    const entries = this.delegateOverride.agentDefaults
    if (entries !== undefined && agentId in entries) {
      const next = { ...entries }
      delete next[agentId]
      // Same empty-map hygiene as setDelegateSettings: forgetting the LAST
      // entry drops the key entirely, never a persisted `agentDefaults: {}`.
      // A {} ENTRY among survivors is a valid override and stays.
      if (Object.keys(next).length === 0) delete this.delegateOverride.agentDefaults
      else this.delegateOverride.agentDefaults = next
    }
  }

  /** The agent tag's halo preference (composer display, plugin-private). */
  tagHalo(): AcpTagHalo {
    return this.tagHaloSetting
  }

  async setTagHalo(halo: AcpTagHalo): Promise<void> {
    // Rebuild through the validator so every write passes the same gate the
    // RPC route used, whatever the caller (a direct consumer today, a future
    // non-RPC path tomorrow).
    this.tagHaloSetting = validateTagHalo(halo)
    this.host.persistAgents()
  }

  /** Whether generated NTR session titles carry the badge (settings page toggle). */
  sessionTitlePrefix(): boolean {
    return this.sessionTitlePrefixEnabled
  }

  async setSessionTitlePrefix(value: boolean): Promise<void> {
    // Same gate as the RPC route (the one validation a boolean needs), and the
    // same persisted-with-the-registry story as every other settings toggle.
    this.sessionTitlePrefixEnabled = value === true
    this.host.persistAgents()
  }

  /** Whether the built-in `dsh-skills` MCP server is offered to agents (default off). */
  skillsMcpEnabled(): boolean {
    return this.skillsMcpEnabledSetting === true
  }

  /**
   * Write the built-in skills MCP switch.
   *
   * STRICTLY persisted first, then hot-applied: the user is waiting on this
   * click, so a missing state path or a failed write must fail the request
   * (`persist_failed`) instead of leaving "disk says off, tuning says on".
   * The in-memory preference is written before the file (that is what the file
   * serializes) and restored on failure, so no split state survives a throw.
   *
   * Nothing else happens on success: no `agent/save`, no process restart, no
   * interruption of a running turn — see `applySkillsMcpTuning`.
   */
  async setSkillsMcpEnabled(value: boolean): Promise<void> {
    if (typeof value !== 'boolean') {
      throw new AcpError('bad_payload', 'acp: skillsMcpEnabled must be a boolean')
    }
    const previous = this.skillsMcpEnabledSetting
    this.skillsMcpEnabledSetting = value
    try {
      this.host.persistAgentsStrict()
    } catch (error) {
      // The write did not land: the value that runs stays the old one, so the
      // browser's rollback and the host agree.
      this.skillsMcpEnabledSetting = previous
      throw error
    }
    this.applySkillsMcpTuning()
  }

  /**
   * Push the switch into the shared tuning object the bridges read at request
   * time.
   *
   * The rewrite is the whole hot-apply: every bridge's seam reads the SAME
   * object (`replaceTuning` mutates in place), so the next session-creating
   * request sees the new value without a restart and without a per-bridge
   * fan-out. Bridges are deliberately NOT told anything here — an existing
   * session is not rewritten.
   *
   * Public because the manager's boot path replays the persisted value after
   * loading the registry (see `BridgeManager`'s constructor).
   */
  applySkillsMcpTuning(): void {
    this.host.replaceTuning({ ...this.host.currentTuning(), skillsMcpEnabled: this.skillsMcpEnabled() })
  }

  /** Wire the optional host `dsh-mcp-manager` snapshot reader (host entry only). */
  setHostMcpReader(reader?: () => HostMcpSnapshot): void {
    this.hostMcpReader = reader
  }

  /** Unified MCP settings view for the settings page's「MCP」tab. */
  sharedMcp(): AcpSharedMcpSettings {
    const host = this.hostMcpReader?.() ?? { available: false, summaries: [], servers: [] }
    return {
      servers: (this.sharedMcpServersSetting ?? []).map(s => ({ ...s })),
      hostSyncEnabled: this.hostMcpSyncEnabledSetting === true,
      hostAvailable: host.available,
      ...(host.available ? { hostServers: host.summaries } : {}),
    }
  }

  /** Strictly persist and hot-apply unified MCP servers and/or host sync toggle. */
  async setSharedMcp(patch: SharedMcpSetPayload): Promise<void> {
    const prevServers = this.sharedMcpServersSetting
    const prevHostSync = this.hostMcpSyncEnabledSetting
    if (patch.servers !== undefined) {
      const validated = validateMcpServers(patch.servers, 'sharedMcp.servers', 'bad_payload')
      this.sharedMcpServersSetting = validated.length === 0 ? undefined : validated
    }
    if (patch.hostSyncEnabled !== undefined) {
      if (typeof patch.hostSyncEnabled !== 'boolean') {
        this.sharedMcpServersSetting = prevServers
        throw new AcpError('bad_payload', 'acp: hostSyncEnabled must be a boolean')
      }
      this.hostMcpSyncEnabledSetting = patch.hostSyncEnabled
    }
    try {
      this.host.persistAgentsStrict()
    } catch (error) {
      this.sharedMcpServersSetting = prevServers
      this.hostMcpSyncEnabledSetting = prevHostSync
      throw error
    }
  }

  /** Live per-request MCP context consumed by `AgentBridge.mcpServersForSession`. */
  sessionMcpContext(): SessionMcpLiveContext {
    const host = this.hostMcpSyncEnabledSetting === true ? this.hostMcpReader?.().servers : undefined
    return {
      skills: this.host.currentTuning().skillsMcpEnabled,
      ...(this.sharedMcpServersSetting === undefined ? {} : { shared: this.sharedMcpServersSetting }),
      ...(host === undefined || host.length === 0 ? {} : { host }),
    }
  }

  /**
   * Declare the deployment baseline for the idle-release window — the value
   * `cordis.patch.yml` names, passed RAW (only when it names one).
   *
   * Kept separate from the validated tuning for the same reason the deadline
   * keeps its baseline apart: "the file says 10 minutes" and "the file says
   * nothing, so 30 minutes applies" are different facts. The first is the
   * reset target and shows as the fact being overridden; the second is a
   * built-in default. Called once by the host entry, before any bridge exists.
   */
  setConfiguredIdleRelease(idleTimeoutMs: number | undefined): void {
    this.configuredIdleTimeoutMs = idleTimeoutMs
    if (idleTimeoutMs !== undefined) this.baselineIdleTimeoutMs = idleTimeoutMs
    this.applyIdleReleaseTuning()
  }

  /**
   * Declare the deployment baseline for the approval deadline — the values
   * `cordis.patch.yml` names, passed RAW (only the keys it actually contains).
   *
   * Kept separate from the validated tuning because "the file says 600000" and
   * "the file says nothing, so 300000 applies" are different facts: the
   * settings card shows the first as the reset target and the second as a
   * built-in default. Called once by the host entry, before any bridge exists —
   * and it also moves the baseline, so a manager built without tuning (a direct
   * consumer, a test) still runs what the deployment asked for.
   */
  setConfiguredApprovalDeadlines(values: Partial<Record<ApprovalDeadlineKey, number>>, mode?: PermissionTimeoutMode): void {
    // The baseline must be legal for the mode it runs under, or the card would
    // advertise a number the deployment cannot actually run (不等待 under
    // `abort`) and the reset button would restore it.
    //
    // This normalization applies to the CONFIG BASELINE only (the value the
    // card shows as the reset target and against which the override is
    // compared): `applyDeadlineTuning` owns the persisted override, while
    // `validateConfig` and the `AgentBridge` constructor normalize their own
    // inputs. Keeping the file's raw 0 here would make the card report the
    // floored runtime value as a user override and offer a reset that restores
    // a value it cannot run. Separating "what the file says" from "what runs"
    // needs a second protocol field; until that exists the config baseline
    // stays normalized.
    const effectiveMode = mode ?? this.configuredMode ?? this.baselineMode
    const raw = values.permissionTimeoutMs
    const window = raw === undefined ? undefined : normalizeApprovalWindow(effectiveMode, raw)
    this.configuredDeadlines = {
      ...(window === undefined ? {} : { permissionTimeoutMs: window }),
      ...(values.elicitationTimeoutMs === undefined ? {} : { elicitationTimeoutMs: values.elicitationTimeoutMs }),
    }
    if (window !== undefined) this.baselineDeadline = window
    if (values.elicitationTimeoutMs !== undefined) this.baselineElicitationTimeoutMs = values.elicitationTimeoutMs
    if (mode !== undefined) {
      this.configuredMode = mode
      this.baselineMode = mode
    }
    this.applyDeadlineTuning()
  }

  /**
   * The approval deadline in force, plus the facts that explain a value the
   * user did not pick: the config-file baseline an override is outranking. The
   * mode rides along with its own baseline, for the same reason: the card has
   * to be able to say "the file asks for `abort`, the value set here wins".
   *
   * Everything is reported only when it is actually in play, so the card can
   * stay silent about a plain default.
   */
  approvalDeadlines(): AcpApprovalDeadlines {
    const tuning = this.host.currentTuning()
    const deadlines: AcpApprovalDeadlines = {
      permissionTimeoutMs: tuning.permissionTimeoutMs,
      elicitationTimeoutMs: tuning.elicitationTimeoutMs,
      mode: tuning.permissionTimeoutMode,
    }
    if (Object.keys(this.configuredDeadlines).length > 0) deadlines.configured = { ...this.configuredDeadlines }
    if (this.configuredMode !== undefined) deadlines.configuredMode = this.configuredMode
    return deadlines
  }

  /**
   * The idle-release window in force, plus the facts that explain a value the
   * user did not pick: the deployment baseline an override is outranking.
   *
   * `defaultIdleTimeoutMs` is the window a RESET returns to — the deployment
   * baseline when the config file names one, else the built-in default. It is
   * NOT a hardcoded constant: a deployment that names 10 minutes must reset to
   * 10 minutes, not to the built-in 30.
   *
   * The config file's own number is reported only when the file names one, so
   * the settings card can stay silent about a plain default.
   */
  idleRelease(): AcpIdleRelease {
    const release: AcpIdleRelease = {
      idleTimeoutMs: this.idleTimeoutMs(),
      defaultIdleTimeoutMs: this.baselineIdleTimeoutMs,
    }
    if (this.configuredIdleTimeoutMs !== undefined) release.configuredIdleTimeoutMs = this.configuredIdleTimeoutMs
    return release
  }

  /**
   * Write the idle-release window, or drop the persisted override with
   * `reset` so the deployment baseline applies again.
   *
   * HOT: the rewrite reaches every live bridge, so a user changing the window
   * never has to kill a running session to see it take effect.
   */
  async setIdleRelease(idleTimeoutMs: number | undefined, reset = false): Promise<void> {
    this.idleReleaseOverride = reset ? undefined : idleTimeoutMs
    this.applyIdleReleaseTuning()
    this.host.persistAgents()
  }

  /**
   * Recompute the idle-release window from override → deployment baseline, and
   * push the result to every live bridge.
   *
   * Public because the manager's boot path replays the persisted override after
   * loading the registry (see `BridgeManager`'s constructor).
   */
  applyIdleReleaseTuning(): void {
    const window = this.idleTimeoutMs()
    this.host.replaceTuning({ ...this.host.currentTuning(), idleTimeoutMs: window })
    for (const bridge of this.host.bridges()) bridge.applyIdleRelease(window)
  }

  /**
   * The idle-release window that runs, in ms: the settings page's pick, else
   * the deployment baseline.
   */
  private idleTimeoutMs(): number {
    return this.idleReleaseOverride ?? this.baselineIdleTimeoutMs
  }

  /**
   * Declare the deployment baseline for the delegate settings — the keys
   * `cordis.patch.yml` names, passed as `validateDelegateConfig`'s output (only
   * the keys the file actually contains). Kept separate from the override so
   * the card can say "the file asks for `enhanced`, the value set here wins";
   * a key the file never names resets to the built-in default instead. Called
   * once by the host entry; the boot replay reconciles via `applyDelegateTuning`.
   */
  setConfiguredDelegate(config: AcpDelegateConfig | undefined): void {
    this.configuredDelegate = config ?? {}
  }

  /**
   * The delegate settings in force, plus the deployment-baseline facts that
   * explain a value the user did not pick. Effective values resolve per key:
   * settings-page override → deployment baseline → built-in default.
   *
   * The timeout's built-in default is NOT a constant: it follows the global
   * background-task long window (`backgroundTaskToolMs`, falling back to
   * `backgroundTaskMaxMs` when that is `0` — the same rule
   * `TurnWatchdogService.backgroundTuning` uses). `defaultTimeoutMs` reports
   * the reset target (deployment baseline ?? that global window), mirroring
   * `AcpIdleRelease.defaultIdleTimeoutMs`.
   *
   * `configured` carries only the keys the config file actually names, so the
   * card stays silent about a plain default (the same conditional fact the
   * idle-release card reports). `toolAvailable` / `restrictAvailable` are NOT
   * filled here: the manager wraps this read with its registration probes.
   */
  delegateSettings(): Omit<AcpDelegateSettings, 'toolAvailable' | 'restrictAvailable'> {
    const tuning = this.host.currentTuning()
    const globalWindow = tuning.backgroundTaskToolMs > 0 ? tuning.backgroundTaskToolMs : tuning.backgroundTaskMaxMs
    const baselineTimeoutMs = this.configuredDelegate.timeoutMs ?? globalWindow
    const settings: Omit<AcpDelegateSettings, 'toolAvailable' | 'restrictAvailable'> = {
      guidance: this.delegateOverride.guidance ?? this.configuredDelegate.guidance ?? DEFAULT_DELEGATE_GUIDANCE,
      timeoutMs: this.delegateOverride.timeoutMs ?? baselineTimeoutMs,
      defaultTimeoutMs: baselineTimeoutMs,
    }
    // The default-agent facts: the override in force (unfiltered — a stale
    // pointer is a runtime degradation, not a persistence edit), the global
    // default as a display fact, and the resolution the card's「当前：X」shows.
    const defaultAgent = this.delegateOverride.defaultAgent ?? this.configuredDelegate.defaultAgent
    if (defaultAgent !== undefined) settings.defaultAgent = defaultAgent
    const globalDefaultAgent = this.defaultAgent()
    if (globalDefaultAgent !== undefined) settings.globalDefaultAgent = globalDefaultAgent
    const resolvedDefaultAgent = defaultAgent ?? globalDefaultAgent
    if (resolvedDefaultAgent !== undefined) settings.resolvedDefaultAgent = resolvedDefaultAgent
    // Per-agent choice defaults: override entries merged OVER the baseline
    // (a stored {} entry shadows the baseline for that agent). Stale entries
    // stay listed — the runtime marks them, it never deletes a preference.
    const agentDefaults = { ...this.configuredDelegate.agentDefaults, ...this.delegateOverride.agentDefaults }
    if (Object.keys(agentDefaults).length > 0) settings.agentDefaults = agentDefaults
    if (Object.keys(this.configuredDelegate).length > 0) settings.configured = { ...this.configuredDelegate }
    return settings
  }

  /**
   * Write delegate settings (omitted keys keep their value), or drop the
   * persisted overrides named by `reset` so the deployment baseline — or the
   * built-in default — decides again. Values arrive validated by the dispatch
   * layer (`validateDelegateSettings`), so they are stored as-is.
   *
   * HOT: after the state-file write the host reconciles the tool registration
   * and the force mask, so the change lands on the next step of existing
   * conversations without a host restart (the `setIdleRelease` order: rewrite
   * the override, persist, then apply — here the apply IS the reconciliation).
   */
  async setDelegateSettings(patch: DelegateSetPayload): Promise<void> {
    const reset: readonly DelegateSettingKey[] = patch.reset ?? []
    for (const key of reset) delete this.delegateOverride[key]
    if (patch.guidance !== undefined) this.delegateOverride.guidance = patch.guidance
    if (patch.timeoutMs !== undefined) this.delegateOverride.timeoutMs = patch.timeoutMs
    if (patch.defaultAgent !== undefined) this.delegateOverride.defaultAgent = patch.defaultAgent
    if (patch.agentDefaults !== undefined) {
      // Per-agent WHOLE-ENTRY replacement: {} is a valid all-default override
      // that shadows the baseline, null deletes the entry (baseline decides
      // again). Entries are copied so a later payload never aliases state.
      const next = { ...(this.delegateOverride.agentDefaults ?? {}) }
      for (const [agentId, entry] of Object.entries(patch.agentDefaults)) {
        if (entry === null) delete next[agentId]
        else next[agentId] = { ...entry }
      }
      // Empty-map hygiene: deleting the LAST entry (or an empty payload over
      // no override) drops the key entirely — a persisted `agentDefaults: {}`
      // would be a ghost override. A {} ENTRY is untouched: it is a valid
      // all-default override, only the empty MAP is residue.
      if (Object.keys(next).length === 0) delete this.delegateOverride.agentDefaults
      else this.delegateOverride.agentDefaults = next
    }
    this.host.persistAgents()
    this.host.syncDelegateRegistration?.()
  }

  /**
   * Reconcile the delegate registration from the values in force (boot replay
   * after the persisted override loads). Effective values are computed at read
   * time, so there is no tuning object to rewrite — the host callback does the
   * whole apply. Public because the manager's boot path calls it, mirroring
   * `applyIdleReleaseTuning`.
   */
  applyDelegateTuning(): void {
    this.host.syncDelegateRegistration?.()
  }

  /**
   * Write the approval deadline, or the mode (omitted keys keep their value),
   * or drop the persisted override with `reset` so the config-file baseline —
   * or the built-in default — applies again.
   *
   * HOT: the rewrite reaches every live bridge, so a user changing the window
   * never has to kill a running session to see it take effect (the one thing an
   * `agent/save`-style restart would cost them). Only asks armed AFTER the
   * write see the new window; an ask already holding a timer keeps the one it
   * started with.
   */
  async setApprovalDeadlines(patch: ApprovalDeadlinePatch, reset = false): Promise<void> {
    // Merged BEFORE validating, so the whole resulting override passes the same
    // gate the config file does (an override written by an older build is
    // re-gated here rather than trusted). The validators also drop unknown
    // keys, which is what keeps a stale payload from poisoning state.
    const merged = reset ? {} : { ...this.deadlineOverride, ...patch }
    const validated = validateApprovalDeadlines(merged)
    const window = validated.permissionTimeoutMs
    const elicitationTimeoutMs = validated.elicitationTimeoutMs
    const mode = merged.mode === undefined
      ? undefined
      : validatePermissionTimeoutMode(merged.mode, 'bad_payload')
    // Persist the user's RAW window, never a mode-specific rewrite: 不等待 (0)
    // belongs to `auto`, and the floor under `abort` is a RUNTIME fact applied
    // by `applyDeadlineTuning`. Flooring it here would turn a mode switch into
    // a silent edit of the stored value, so switching back to `auto` could
    // never restore the zero the user actually picked.
    this.deadlineOverride = {
      ...(window === undefined ? {} : { permissionTimeoutMs: window }),
      ...(elicitationTimeoutMs === undefined ? {} : { elicitationTimeoutMs }),
      ...(mode === undefined ? {} : { mode }),
    }
    this.applyDeadlineTuning()
    this.host.persistAgents()
  }

  /**
   * Recompute the deadline and the mode from override → deployment baseline,
   * and push the result to every live bridge.
   *
   * This is the ONLY place the PERSISTED OVERRIDE is read and normalized into
   * a runtime value. Persisted state keeps the user's RAW pick (0 = 不等待
   * under `auto`), and the mode's floor is applied here on every recompute —
   * so a state file holding a zero while the mode is `abort` still runs the
   * 30 s minimum instead of refusing every ask on arrival. Nothing else may
   * read `deadlineOverride` for a runtime value.
   *
   * Public because the manager's boot path replays the persisted override after
   * loading the registry (see `BridgeManager`'s constructor).
   */
  applyDeadlineTuning(): void {
    const permissionTimeoutMode = this.deadlineOverride.mode ?? this.baselineMode
    const permissionTimeoutMs = normalizeApprovalWindow(
      permissionTimeoutMode,
      this.deadlineOverride.permissionTimeoutMs ?? this.baselineDeadline,
    )
    const elicitationTimeoutMs = this.deadlineOverride.elicitationTimeoutMs ?? this.baselineElicitationTimeoutMs
    this.host.replaceTuning({
      ...this.host.currentTuning(),
      permissionTimeoutMs,
      elicitationTimeoutMs,
      permissionTimeoutMode,
    })
    const patch = { permissionTimeoutMs, elicitationTimeoutMs, mode: permissionTimeoutMode }
    for (const bridge of this.host.bridges()) bridge.applyApprovalDeadlines(patch)
  }

  /**
   * Read this service's preferences back from the parsed agent registry.
   *
   * Re-validated on every boot because the state file is user- and
   * version-editable: an unreadable value must not poison the setting, and a
   * value the validator accepts must be the value that runs (a UI write that
   * did not survive a restart would read as a broken setting). The caller only
   * passes a non-array object (the current registry shape).
   */
  loadPersistedSettings(parsed: Record<string, unknown>): void {
    const stored = parsed.defaultAgentId
    // Kept as-is (even when it names an agent this boot did not load):
    // `defaultAgent()` is the accessor that filters a stale id out, so a
    // temporarily unreadable agent list cannot silently erase the choice.
    if (typeof stored === 'string' && stored !== '') this.defaultAgentId = stored
    // The halo preference is validated on write, but the file is user- or
    // version-editable: an unreadable value falls back to the default rather
    // than poisoning every read.
    try {
      this.tagHaloSetting = validateTagHalo(parsed.tagHalo)
    } catch {
      this.tagHaloSetting = { ...DEFAULT_TAG_HALO }
    }
    // The settings page's title-prefix toggle. Written only as a boolean; an
    // explicit boolean is honored as-is, while a missing or hand-edited
    // non-boolean falls back to the default — the same user-editable-file rule
    // the halo preference hydrates by.
    const storedTitlePrefix = parsed.sessionTitlePrefix
    this.sessionTitlePrefixEnabled =
      typeof storedTitlePrefix === 'boolean' ? storedTitlePrefix : DEFAULT_SESSION_TITLE_PREFIX
    // The built-in skills MCP switch: default OFF on every unreadable shape.
    // A hand-edited string / number / object must not turn the server on; an
    // absent key runs off too, and only a real boolean is adopted as-is (so an
    // explicit `false` survives the round trip instead of becoming "unset").
    const storedSkillsMcp = parsed.skillsMcpEnabled
    this.skillsMcpEnabledSetting = typeof storedSkillsMcp === 'boolean' ? storedSkillsMcp : undefined
    if (parsed.sharedMcpServers === undefined) {
      this.sharedMcpServersSetting = undefined
    } else {
      try {
        const validated = validateMcpServers(parsed.sharedMcpServers, 'sharedMcpServers', 'bad_config')
        this.sharedMcpServersSetting = validated.length === 0 ? undefined : validated
      } catch {
        this.sharedMcpServersSetting = undefined
      }
    }
    const storedHostMcpSync = parsed.hostMcpSyncEnabled
    this.hostMcpSyncEnabledSetting = typeof storedHostMcpSync === 'boolean' ? storedHostMcpSync : undefined
    // The settings page's approval-deadline override. Re-validated on every
    // boot because the state file is user- and version-editable: an unreadable
    // value must not poison the deadline, and a value the validator accepts
    // must be the value that runs (a UI write that did not survive a restart
    // would read as a broken setting).
    try {
      const raw = (parsed.approvalDeadlines as Record<string, unknown> | undefined) ?? {}
      // The OLD card wrote the two legacy windows, and its 「关」 preset wrote a
      // zero — which then meant "this window never fires". The only way to say
      // that now is the `wait` MODE (a zero means 不等待 today), so a legacy
      // zero carries over as the mode instead of silently turning "wait
      // forever" into "answer immediately".
      const legacy = raw as { nativeApprovalTimeoutMs?: unknown; permissionFallbackTimeoutMs?: unknown }
      const legacyWindow = legacy.nativeApprovalTimeoutMs ?? legacy.permissionFallbackTimeoutMs
      const legacyNever = legacyWindow === 0
      const windows = validateApprovalDeadlines(raw)
      const window = legacyNever
        ? undefined
        : windows.permissionTimeoutMs
      const elicitationTimeoutMs = windows.elicitationTimeoutMs
      const mode = legacyNever
        ? ('wait' as const)
        : ((raw as { mode?: unknown }).mode === undefined
          ? undefined
          : validatePermissionTimeoutMode((raw as { mode?: unknown }).mode, 'bad_payload'))
      // The stored window is the user's RAW pick and is read back as-is:
      // 不等待 (0) belongs to `auto`, and the floor under `abort` is applied at
      // RUNTIME only (`applyDeadlineTuning`). Rewriting it here would make a
      // restart itself change what the user chose, and a later switch back to
      // `auto` could never recover the zero.
      this.deadlineOverride = {
        ...(window === undefined ? {} : { permissionTimeoutMs: window }),
        ...(elicitationTimeoutMs === undefined ? {} : { elicitationTimeoutMs }),
        ...(mode === undefined ? {} : { mode }),
      }
    } catch {
      this.deadlineOverride = {}
    }
    // The settings page's idle-release pick. Re-validated on every boot because
    // the state file is user- and version-editable: an unreadable value must
    // not poison the window, and a value the validator accepts must be the
    // value that runs.
    try {
      const raw = parsed.idleRelease as { idleTimeoutMs?: unknown } | undefined
      const value = raw?.idleTimeoutMs
      this.idleReleaseOverride = typeof value === 'number' && IDLE_RELEASE_MS.includes(value)
        ? value
        : undefined
    } catch {
      this.idleReleaseOverride = undefined
    }
    // The settings page's delegate picks. Re-validated per key on every boot
    // because the state file is user- and version-editable: an out-of-range or
    // hand-edited value is dropped and the baseline decides again, never
    // poisoning the registration. Retired keys are silently dropped — only the
    // known keys are rebuilt.
    try {
      const raw = (parsed.delegate as Record<string, unknown> | undefined) ?? {}
      const next: Partial<AcpDelegateConfig> = {}
      const guidance = raw.guidance
      if (typeof guidance === 'string' && (DELEGATE_GUIDANCE as readonly string[]).includes(guidance)) {
        next.guidance = guidance as DelegateGuidance
      }
      const timeoutMs = raw.timeoutMs
      if (typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs >= DELEGATE_TIMEOUT_MIN_MS && timeoutMs <= DELEGATE_TIMEOUT_MAX_MS) next.timeoutMs = timeoutMs
      // The new choice keys re-validate through the SAME shape gate the
      // config-file door uses, each key independently so one unreadable key
      // cannot drop its sibling. Stale-but-legal values survive (keep+mark):
      // only shape is checked here, never the catalog or the agent list.
      try {
        const fresh = validateDelegateConfig({ defaultAgent: raw.defaultAgent })
        if (fresh.defaultAgent !== undefined) next.defaultAgent = fresh.defaultAgent
      } catch { /* unreadable pointer: the baseline decides again */ }
      try {
        const fresh = validateDelegateConfig({ agentDefaults: raw.agentDefaults })
        if (fresh.agentDefaults !== undefined) next.agentDefaults = fresh.agentDefaults
      } catch { /* unreadable map: the baseline decides again */ }
      this.delegateOverride = next
    } catch {
      this.delegateOverride = {}
    }
  }

  /**
   * The settings half of the `agents.json` payload. Absent keys stay absent, so
   * a fresh deployment's state file is exactly what it was before this service
   * existed.
   */
  persistedSettings(): PersistedSettings {
    return {
      ...(this.defaultAgentId === undefined ? {} : { defaultAgentId: this.defaultAgentId }),
      tagHalo: this.tagHaloSetting,
      sessionTitlePrefix: this.sessionTitlePrefixEnabled,
      ...(this.skillsMcpEnabledSetting === undefined
        ? {}
        : { skillsMcpEnabled: this.skillsMcpEnabledSetting }),
      ...(this.sharedMcpServersSetting === undefined || this.sharedMcpServersSetting.length === 0
        ? {}
        : { sharedMcpServers: this.sharedMcpServersSetting }),
      ...(this.hostMcpSyncEnabledSetting === undefined
        ? {}
        : { hostMcpSyncEnabled: this.hostMcpSyncEnabledSetting }),
      ...(Object.keys(this.deadlineOverride).length === 0
        ? {}
        : { approvalDeadlines: { ...this.deadlineOverride } }),
      ...(this.idleReleaseOverride === undefined
        ? {}
        : { idleRelease: { idleTimeoutMs: this.idleReleaseOverride } }),
      ...(Object.keys(this.delegateOverride).length === 0
        ? {}
        : {
          delegate: {
            ...this.delegateOverride,
            // The nested map is copied one level deep: entries are replaced
            // wholesale on every write, so this snapshot never aliases state.
            ...(this.delegateOverride.agentDefaults === undefined
              ? {}
              : { agentDefaults: { ...this.delegateOverride.agentDefaults } }),
          },
        }),
    }
  }
}
