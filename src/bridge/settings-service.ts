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
  validatePermissionTimeoutMode,
  validateTagHalo,
} from '../impl.ts'
import type { RosterPresetRow } from '../impl.ts'
import type {
  AcpApprovalDeadlines,
  AcpIdleRelease,
  AcpPresetStatus,
  AcpTagHalo,
  ApprovalDeadlineKey,
  ApprovalDeadlinePatch,
  PermissionTimeoutMode,
  PluginReleaseNotes,
  PluginUpdateState,
} from '../protocol.ts'
import {
  DEFAULT_SESSION_TITLE_PREFIX,
  DEFAULT_TAG_HALO,
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
  applyApprovalDeadlines(patch: { permissionTimeoutMs?: number; mode?: PermissionTimeoutMode }): void
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
}

/** The settings half of the `agents.json` payload, in its persisted key order. */
export interface PersistedSettings {
  defaultAgentId?: string
  tagHalo: AcpTagHalo
  sessionTitlePrefix: boolean
  approvalDeadlines?: ApprovalDeadlinePatch
  idleRelease?: { idleTimeoutMs: number }
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
   */
  forgetAgent(agentId: string): void {
    if (this.defaultAgentId === agentId) this.defaultAgentId = undefined
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
    this.configuredDeadlines = window === undefined ? {} : { permissionTimeoutMs: window }
    if (window !== undefined) this.baselineDeadline = window
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
    const window = validateApprovalDeadlines(merged).permissionTimeoutMs
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
    this.host.replaceTuning({
      ...this.host.currentTuning(),
      permissionTimeoutMs,
      permissionTimeoutMode,
    })
    const patch = { permissionTimeoutMs, mode: permissionTimeoutMode }
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
      const window = legacyNever
        ? undefined
        : validateApprovalDeadlines(raw).permissionTimeoutMs
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
      ...(Object.keys(this.deadlineOverride).length === 0
        ? {}
        : { approvalDeadlines: { ...this.deadlineOverride } }),
      ...(this.idleReleaseOverride === undefined
        ? {}
        : { idleRelease: { idleTimeoutMs: this.idleReleaseOverride } }),
    }
  }
}
