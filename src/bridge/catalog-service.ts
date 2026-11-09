/**
 * Model catalog + probe cluster, lifted out of `BridgeManager`.
 *
 * Owns everything an ACP agent publishes about its MODEL SURFACE: the merged
 * `configOptions` catalog, the learned slash-command list, the last known
 * `sessionCapabilities.fork` bit, and the `model-catalog.json` file they ride
 * in. It never spawns a process on its own beyond `probeAgentModels`, which is
 * always an explicit gesture, and it never touches the agent registry, the
 * bridge table or the chat binding maps directly — those arrive as
 * {@link CatalogHost} callbacks so this module stays free of `manager.ts`.
 */

import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { EventHub } from '../impl.ts'
import {
  AcpError,
  buildAdapterModelId,
  mergeCatalogShape,
  parseCatalogOptions,
  splitAdapterModelId,
  usableConfigOptions,
} from '../impl.ts'
import type {
  AcpAgentCatalog,
  AcpAgentDef,
  AgentCatalogResult,
  AgentProbeModelsResult,
  LlmModelReasoningInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  SessionView,
} from '../protocol.ts'
import { isPerSessionAgent } from './identity.ts'
import { legacyFallback, pluginStateDir, stateDirExplicit } from './state-paths.ts'

/**
 * Catalog schema the persisted file was written with. Bumped when a parser
 * gains a category, so a cache written by an older build is KNOWN to be
 * incomplete — a persisted `{model, thought}` catalog from v1 would otherwise
 * keep an agent looking like it has no `mode` axis forever.
 *
 * A stale entry is still SERVED (dropping it would blank the seats across an
 * upgrade) and is repaired for free the next time that agent's own session
 * publishes `configOptions` (`absorbCatalog`). It is NOT re-probed at boot:
 * a probe spawns a process, and starting agents nobody is talking to is the
 * defect this marker used to cause (user report, 2026-10-18).
 *
 * v2 = `mode` (`category: 'mode'`) joined `model` / `thought_level`.
 * v3 = every other select joined as `extras` (the composer's advanced base).
 */
const CATALOG_SCHEMA = 3

/** The one bridge method a probe needs; `AgentBridge` satisfies it structurally. */
export interface CatalogProbeBridge {
  probeConfigOptions(): Promise<unknown>
}

/**
 * The manager capabilities this service leans on. Every member is a callback /
 * getter so the service holds no reference to `BridgeManager` itself.
 */
export interface CatalogHost {
  /** The configured definition, or `undefined` when the registry does not own the id. */
  defOf(agentId: string): AcpAgentDef | undefined
  /** Process-lifetime delete tombstone (a late observation must not resurrect a ghost). */
  isAgentDeleted(agentId: string): boolean
  /** Resolve (or create) the throwaway probe bridge for one agent. */
  bridgeForProbe(agentId: string): CatalogProbeBridge
  /** Drop that probe bridge so its child process does not linger. */
  releaseProbe(agentId: string): void
  /** A live `initialize`'s fork verdict, or `undefined` when no process is up. */
  liveForkCapability(agentId: string): boolean | undefined
  /** Mutate the SHARED definition object in place (live bridges hold the same one). */
  patchDef(agentId: string, patch: { exposedModels: string[] }): void
  /** Write the agent registry back to `agents.json`. */
  persistAgents(): void
  /** The host event stream every learned fact is announced on. */
  readonly hub: EventHub
}

/** Routes host session ids to their owning bridge. */
export class ModelCatalogService {
  private readonly catalogs = new Map<string, { catalog: AcpAgentCatalog; updatedAt: number }>()
  /**
   * Each agent's LAST KNOWN `sessionCapabilities.fork` bit, persisted with the
   * model catalog. A live `initialize` result outranks it whenever one exists
   * (see {@link canForkNow}) — this copy answers when the process is gone
   * (a released session's branch button must not flash into "supported" just
   * because `initResult` died with it, nor read `view().agentCapabilities`,
   * which a release clears).
   */
  private readonly forkCaps = new Map<string, boolean>()
  /**
   * The slash commands each agent declared in its most recent session, cached
   * per agent and persisted alongside the model catalog.
   *
   * This is what makes `/` list an agent's commands in a conversation that has
   * not sent its first message yet: before `session/new` there is no live
   * session to ask, and the native menu's immediacy is the bar. A live
   * session's own declaration always outranks this cache. It is learned, never
   * probed — a `session/new` for a menu would spawn an agent (constraint 8).
   */
  private readonly commandCache = new Map<string, { commands: NonNullable<SessionView['availableCommands']>; updatedAt: number }>()
  /** Agents whose persisted catalog predates {@link CATALOG_SCHEMA}. */
  private readonly catalogStale = new Set<string>()

  constructor(
    private readonly host: CatalogHost,
    private readonly catalogStoragePath?: string,
  ) {}

  private getCatalogStoragePath(): string | undefined {
    if (this.catalogStoragePath !== undefined) return this.catalogStoragePath
    if (process.env.DSH_ACP_CATALOG_FILE) return process.env.DSH_ACP_CATALOG_FILE
    if (!stateDirExplicit() && (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test')) {
      return undefined
    }
    try {
      const migrated = join(pluginStateDir(), 'model-catalog.json')
      if (!existsSync(migrated)) {
        const legacy = legacyFallback('catalog')
        if (existsSync(legacy)) return legacy
      }
      mkdirSync(pluginStateDir(), { recursive: true })
      return migrated
    } catch {
      return undefined
    }
  }

  loadPersistedCatalogs(): void {
    const filePath = this.getCatalogStoragePath()
    if (!filePath || !existsSync(filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
      const agents = parsed.agents
      if (typeof agents !== 'object' || agents === null) return
      // A cache written by an older build answers with a PARTIAL surface: it may
      // predate a category entirely. It is still served (dropping it would blank
      // the seats across the upgrade) and marked stale; `absorbCatalog` repairs
      // it for free the next time that agent's own session publishes its
      // options. No probe is spawned here on purpose — see `CATALOG_SCHEMA`.
      const stale = parsed.version !== CATALOG_SCHEMA
      for (const [agentId, raw] of Object.entries(agents)) {
        if (typeof raw !== 'object' || raw === null) continue
        const row = raw as { catalog?: unknown; updatedAt?: unknown; commands?: unknown; commandsUpdatedAt?: unknown; fork?: unknown }
        // The persisted fork capability: a LAST KNOWN bit, loaded before any
        // bridge can report a fresh one (a fresh `initialize` overwrites it).
        if (typeof row.fork === 'boolean') this.forkCaps.set(agentId, row.fork)
        // Commands and the model catalog are learned independently (a session
        // may declare one before the other), so either half alone is a valid row.
        if (Array.isArray(row.commands)) {
          this.commandCache.set(agentId, {
            commands: row.commands as NonNullable<SessionView['availableCommands']>,
            updatedAt: typeof row.commandsUpdatedAt === 'number' ? row.commandsUpdatedAt : 0,
          })
        }
        if (typeof row.catalog !== 'object' || row.catalog === null) continue
        this.catalogs.set(agentId, {
          catalog: row.catalog as AcpAgentCatalog,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        })
        if (stale) this.catalogStale.add(agentId)
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  private persistCatalogs(): void {
    const filePath = this.getCatalogStoragePath()
    if (!filePath) return
    try {
      const agents: Record<string, {
        catalog?: AcpAgentCatalog
        updatedAt?: number
        commands?: NonNullable<SessionView['availableCommands']>
        commandsUpdatedAt?: number
        fork?: boolean
      }> = {}
      for (const [agentId, entry] of this.catalogs) agents[agentId] = { catalog: entry.catalog, updatedAt: entry.updatedAt }
      for (const [agentId, entry] of this.commandCache) {
        agents[agentId] = { ...(agents[agentId] ?? {}), commands: entry.commands, commandsUpdatedAt: entry.updatedAt }
      }
      // The LAST KNOWN fork capability rides the same file: it outlives the
      // agent process, which is exactly when the browser needs it (see
      // `canForkNow`).
      for (const [agentId, supported] of this.forkCaps) {
        agents[agentId] = { ...(agents[agentId] ?? {}), fork: supported }
      }
      writeFileSync(filePath, JSON.stringify({ version: CATALOG_SCHEMA, agents }, null, 2), 'utf-8')
    } catch {
      // Storage persist failure is non-fatal
    }
  }

  /**
   * Merge `configOptions` observed on any real session into the agent's catalog.
   *
   * This is the SECOND way a catalog gets refreshed (the first being an explicit
   * `probeAgentModels`), and the only one that happens for free: it rides a
   * session the user is already running. It therefore also discharges the
   * {@link CATALOG_SCHEMA} staleness mark — whatever an older parser missed, the
   * current `parseCatalogOptions` has now seen this agent's real answer.
   */
  absorbCatalog(agentId: string, configOptions: unknown): { catalog: AcpAgentCatalog; updatedAt: number } {
    // A probe or session observation can outlive the agent it belongs to. The
    // delete already dropped this id's catalog, so writing it back here would
    // resurrect a ghost entry in `model-catalog.json` across a host restart.
    if (this.host.defOf(agentId) === undefined || this.host.isAgentDeleted(agentId)) {
      return this.catalogs.get(agentId) ?? { catalog: {}, updatedAt: 0 }
    }
    // Empty / absurd answers never overwrite known state — see `usableConfigOptions`.
    if (!usableConfigOptions(configOptions)) return this.catalogs.get(agentId) ?? { catalog: {}, updatedAt: 0 }
    const catalog = parseCatalogOptions(configOptions)
    this.catalogStale.delete(agentId)
    const existing = this.catalogs.get(agentId)
    // Auto-discovery compares this observation against the catalog known
    // BEFORE it. The first observation is only a baseline — nothing is "new"
    // yet, and calling every choice of a 500-model catalog "new" would flood
    // the selection the switch is meant to keep tidy.
    const exposedChanged = this.autoExposeNewModels(agentId, catalog, existing?.catalog)
    if (existing !== undefined && JSON.stringify(existing.catalog) === JSON.stringify(catalog)) {
      if (exposedChanged) this.broadcastExposure(agentId)
      return existing
    }
    const entry = { catalog, updatedAt: Date.now() }
    this.catalogs.set(agentId, entry)
    this.persistCatalogs()
    // The browser caches the seat surface per agent and only re-reads it when
    // it is told to. A catalog learned from a REAL session is exactly the
    // moment a conversation that was opened before that session needs the new
    // list (first-turn convergence); probing it again would spawn a process.
    this.host.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
    // After the catalog lands, so a re-read triggered by this frame already
    // sees the new models in `agent/catalog`'s variant expansion.
    if (exposedChanged) this.broadcastExposure(agentId)
    return entry
  }

  /**
   * Fold a per-session option answer's SHAPE into the agent's catalog.
   *
   * The counterpart of {@link absorbCatalog} for `session/set_config_option`
   * responses: which options exist and which choices they offer is agent
   * knowledge the seat must show (the composer's thought chip only renders
   * when the catalog has `thought_level`, and some agents publish it only in
   * the answer to a model change), while a per-session `currentValue` stays
   * out of it. No auto-exposure and no staleness discharge either — this is
   * one session's answer, not the agent-level observation those marks track.
   */
  absorbCatalogShape(agentId: string, configOptions: unknown): void {
    // Same late-observation guard as `absorbCatalog`: a deleted agent's id must
    // never come back into the catalog file through a session answer.
    if (this.host.defOf(agentId) === undefined || this.host.isAgentDeleted(agentId)) return
    if (!usableConfigOptions(configOptions)) return
    const observed = parseCatalogOptions(configOptions)
    const existing = this.catalogs.get(agentId)
    const catalog = mergeCatalogShape(existing?.catalog, observed)
    if (existing !== undefined && JSON.stringify(existing.catalog) === JSON.stringify(catalog)) return
    const entry = { catalog, updatedAt: Date.now() }
    this.catalogs.set(agentId, entry)
    this.persistCatalogs()
    this.host.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
  }

  /**
   * Remember the slash commands an agent declared in a real session.
   *
   * Unlike {@link absorbCatalog} this does NOT feed a model surface — it keeps
   * the agent's `/` menu populated before the next conversation has a session
   * of its own. The live session's declaration is still the authority; this is
   * only what a fresh conversation has to draw from.
   *
   * Deduped on content: agents restate their list freely, and a broadcast per
   * restatement would make every open composer re-read `agent/catalog`.
   */
  absorbCommands(agentId: string, commands: NonNullable<SessionView['availableCommands']>): void {
    const existing = this.commandCache.get(agentId)
    if (existing !== undefined && JSON.stringify(existing.commands) === JSON.stringify(commands)) return
    const entry = { commands, updatedAt: Date.now() }
    this.commandCache.set(agentId, entry)
    this.persistCatalogs()
    // Same signal as a model catalog learned from a real session: the browser
    // caches `agent/catalog` per agent and re-reads it only when told to. A
    // conversation opened before this session needs the new list for its very
    // first `/`, when there is still no live session to ask.
    this.host.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
  }

  /**
   * Record a fresh `initialize`'s `sessionCapabilities.fork` verdict (the
   * bridge reports it right after the handshake). Persisted with the model
   * catalog; no broadcast — the browser learns it through `session/chat-list`
   * rows, and its branch button deliberately runs on a last-known basis (the
   * agent's own next `initialize` is the refresh).
   */
  noteForkCapability(agentId: string, supported: boolean): void {
    // A1 (F2): one process per conversation means there is no shared
    // connection to fork on, so the capability is permanently OFF whatever the
    // agent's handshake says. Persisting `false` also overwrites a `true`
    // cached by an earlier single-process generation.
    const verdict = isPerSessionAgent(agentId) ? false : supported
    if (this.forkCaps.get(agentId) === verdict) return
    this.forkCaps.set(agentId, verdict)
    this.persistCatalogs()
  }

  /**
   * Whether an agent's fork can be attempted RIGHT NOW: a live `initialize`
   * answer wins (the process is up, its handshake is current); only when the
   * process is gone does the LAST KNOWN persisted bit answer. `false` covers
   * "never seen" — an unknown agent simply never gets a fork attempt.
   */
  canForkNow(agentId: string): boolean {
    // A1 (F2): hard-disabled. A per-session child serves ONE conversation, so
    // there is no connection-scoped parent/child pair to fork.
    if (isPerSessionAgent(agentId)) return false
    const live = this.host.liveForkCapability(agentId)
    if (live !== undefined) return live
    return this.forkCaps.get(agentId) === true
  }

  /**
   * Append models this observation newly introduced to the agent's selection.
   *
   * "Newly introduced" means present in `next` but absent from the catalog
   * known `before` — NOT "absent from the selection". Comparing against the
   * selection would resurrect a model the user deliberately unchecked every
   * time the agent repeats its catalog. The first observation has no baseline
   * (`before === undefined`), so it adds nothing; the user can still add the
   * whole list with one click in the settings card. Discovery is ON unless the
   * agent definition explicitly opts out with `autoDiscoverModels: false`.
   */
  private autoExposeNewModels(agentId: string, next: AcpAgentCatalog, before: AcpAgentCatalog | undefined): boolean {
    const def = this.host.defOf(agentId)
    if (def === undefined || def.autoDiscoverModels === false || before === undefined) return false
    // A different model-slot identity is a corrected reading, not newly added
    // models. Diffing across it would expose an entire real catalog the first
    // time a parser fix replaces a mislabelled slot (Qoder CN).
    if (before.model !== undefined && next.model !== undefined && before.model.configId !== next.model.configId) return false
    const known = new Set((before.model?.choices ?? []).map(choice => choice.value))
    const exposed = new Set(def.exposedModels ?? [])
    const added = (next.model?.choices ?? [])
      .map(choice => choice.value)
      .filter(value => !known.has(value) && !exposed.has(value))
    if (added.length === 0) return false
    this.host.patchDef(agentId, { exposedModels: [...(def.exposedModels ?? []), ...added] })
    this.host.persistAgents()
    return true
  }

  /** Tell the browser an agent's model-visibility surface changed outside `agent/save`. */
  broadcastExposure(agentId: string): void {
    const def = this.host.defOf(agentId)
    if (def === undefined) return
    this.host.hub.broadcast({
      type: 'agent/exposure',
      agentId,
      exposedModels: [...(def.exposedModels ?? [])],
      autoDiscoverModels: def.autoDiscoverModels !== false,
    })
  }

  catalogFor(agentId: string): AcpAgentCatalog | undefined {
    return this.catalogs.get(agentId)?.catalog
  }

  /**
   * The settings panel's PERSISTENT catalog read: the last catalog observed for
   * one agent, or `undefined` when it has never published one.
   *
   * Pure memory (the same map `agentCatalog` reads, hydrated from
   * `model-catalog.json` at boot), so opening the settings page costs no agent
   * process. This is what lets the model panes show the configured selection
   * and the last known model list on mount instead of staying blank until
   * someone clicks 「检测可用模型」 — that button is a REFRESH of this cache
   * (models the agent newly publishes appear, models it stopped advertising
   * drop out), not the price of admission.
   */
  cachedAgentModels(agentId: string): AgentProbeModelsResult | undefined {
    const entry = this.catalogs.get(agentId)
    if (entry === undefined) return undefined
    return { agentId, catalog: entry.catalog, updatedAt: entry.updatedAt }
  }

  /**
   * Probe one agent right now: spawn (if needed), open a throwaway session,
   * read its `configOptions`, close it. Errors propagate to the caller (the
   * RPC result or a notice broadcast).
   */
  async probeAgentModels(agentId: string): Promise<AgentProbeModelsResult> {
    // Never spawn for an id the registry no longer owns. `absorbCatalog` also
    // guards the write, because a delete can land while this probe is awaited.
    if (this.host.defOf(agentId) === undefined || this.host.isAgentDeleted(agentId)) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    const bridge = this.host.bridgeForProbe(agentId)
    try {
      const configOptions = await bridge.probeConfigOptions()
      const entry = this.absorbCatalog(agentId, configOptions)
      // A fresh probe answers in the CURRENT schema by construction.
      this.catalogStale.delete(agentId)
      return { agentId, catalog: entry.catalog, updatedAt: entry.updatedAt }
    } finally {
      // A probe child exists ONLY for this call: it must not linger (and must
      // never be a chat session's process — the `probe` scope guarantees that
      // for A1, while a non-per-session agent folds it onto its single slot and
      // `pruneBridge` deliberately leaves that alone). Dropping the holder
      // stops the child; see `pruneBridge`.
      this.host.releaseProbe(agentId)
    }
  }

  /**
   * Boot-time catalog warm-up.
   *
   * DELIBERATELY DOES NOTHING (user report, 2026-10-18: an unbound conversation
   * showed "Oh My Pi 已连接" in the agent picker, i.e. a second agent process was
   * running for a conversation served by another one).
   *
   * A probe SPAWNS A PROCESS. That is only defensible for an agent the user is
   * actually engaging with, so every probe now has a gesture behind it:
   *
   *  - a conversation bound to that agent → its first `session/new` fills the
   *    catalog in via `absorbCatalog` (that is the agent the user is talking to,
   *    already running);
   *  - the settings card's own button → `agent/probe-models`, one explicit click
   *    on one agent;
   *  - a STALE on-disk entry → repaired by `absorbCatalog` the next time that
   *    agent's own session publishes its options, not at boot.
   *
   * Probing every configured agent at startup — which is what this did — turns
   * "open the app" into "start N agent processes", and the picker then honestly
   * reports them as connected, which is exactly the confusion reported.
   */
  bootstrapCatalogs(): void {
    // Intentionally empty; kept as the boot hook's name so the host entry does
    // not have to change, and so the rule lives where the call is.
  }

  /**
   * The ACP model surface for ONE agent — the seats' own list (see
   * `AgentCatalogResult`). This is what the chat composer's ACP cluster and the
   * ACP-mode model seat render; DSH's native selector has no ACP entries at all
   * (`AcpLlmAdapter.listModels` advertises nothing), because the host builds one
   * global provider catalog with no per-session seam and every session would
   * then be offered ACP agents as if they were just another model.
   *
   * Variants are opt-in: an agent with no `exposedModels` (or an empty list)
   * offers only its base entry. Offering the whole catalog by default is not a
   * feature — these menus have no search, and a real agent publishes hundreds
   * of choices (pi: 500, omp: 581), so "everything by default" is a list storm
   * the user cannot navigate. The base entry is never filtered out.
   *
   * Pure memory — NEVER spawns and NEVER starts a probe. This is a RENDER path:
   * the composer entries call it on every store change, so anything that spawns
   * here turns "open a conversation" into "start every agent" (user report,
   * 2026-10-18: a conversation served by `codebuddy` had `omp` running). A
   * missing or stale catalog is reported honestly (`probed: false`, or the stale
   * entry's contents), and the probe is started by an explicit gesture:
   * `agent/probe-models` (the settings card's button) or a session's own
   * `session/new`, both of which are about ONE agent the user is actually using.
   */
  agentCatalog(agentId: string): AgentCatalogResult {
    const def = this.host.defOf(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    const title = def.title ?? def.id
    const entry = this.catalogs.get(agentId)
    // NO `ensureCatalog` HERE — see the note above. Reading must stay pure
    // memory, even for a stale or absent entry.
    const exposed = def.exposedModels
    const variants: AgentCatalogResult['variants'] = []
    for (const choice of entry?.catalog.model?.choices ?? []) {
      if (exposed === undefined || !exposed.includes(choice.value)) continue
      variants.push({
        id: buildAdapterModelId(def.id, choice.value),
        // The MODEL name alone, not `<agent> · <model>`: the picker already
        // groups these under "<agent>'s models", and the composer chip sits next
        // to the agent chip, so repeating the agent name in every row was noise
        // on top of noise (user report, 2026-10-18).
        name: choice.name,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
      })
    }
    const reasoning = this.reasoningMeta(agentId)
    const modelOption = entry?.catalog.model
    // The model the agent reports it is ON (its `model.currentValue`, refreshed
    // every time a session publishes `configOptions`). This is what the base
    // entry NAMES: `base` is the bare `agentId` route ("let the agent choose"),
    // and the honest way to describe that route is by the model it actually
    // resolves to — "CodeBuddy Code · Hy3", not just "CodeBuddy Code". Without
    // the model name the checked row in the picker said nothing about which
    // model it was (user report, 2026-10-18).
    //
    // An agent can also sit on a model it no longer offers (or report a value it
    // forgot to list): report it with the raw value as its name rather than
    // dropping it — dropping it is what removes the model chip entirely.
    const currentModelValue = modelOption?.currentValue ?? null
    const currentModelChoice = currentModelValue === null
      ? undefined
      : modelOption?.choices.find(choice => choice.value === currentModelValue)
        ?? { value: currentModelValue, name: currentModelValue }
    const baseName = currentModelChoice === undefined
      ? title
      : `${title} · ${currentModelChoice.name}`
    const modeOption = entry?.catalog.mode
    const extraOptions = entry?.catalog.extras ?? []
    const commands = this.commandCache.get(agentId)
    return {
      agentId: def.id,
      title,
      base: {
        id: def.id,
        name: baseName,
        description: `ACP Agent: ${def.command} ${(def.args ?? []).join(' ')}`.trim(),
      },
      variants,
      probed: entry !== undefined,
      ...(reasoning !== undefined ? { reasoning } : {}),
      // The agent's OWN current model, so the model chip has something to show
      // before this conversation has picked one. Absent when the agent publishes
      // no model selector at all — then there really is no model axis.
      ...(currentModelChoice === undefined ? {} : {
        currentModel: {
          value: currentModelChoice.value,
          name: currentModelChoice.name,
          ...(currentModelChoice.description === undefined ? {} : { description: currentModelChoice.description }),
        },
      }),
      // Same reason, for the mode select: before `session/new` there is no live
      // session to read `modes` from, and the control would silently vanish on a
      // conversation the user is still setting up.
      ...(modeOption === undefined ? {} : {
        mode: {
          ...(modeOption.currentValue === null ? {} : { currentValue: modeOption.currentValue }),
          choices: modeOption.choices.map(choice => ({
            id: choice.value,
            name: choice.name,
            ...(choice.description === undefined ? {} : { description: choice.description }),
          })),
        },
      }),
      // The advanced base's content: every select without a dedicated control.
      // The browser overlays the conversation's `extraConfigs` on these current
      // values, so a pick made before the first session still shows as chosen.
      ...(extraOptions.length === 0 ? {} : {
        extras: extraOptions.map(option => ({
          configId: option.configId,
          name: option.name,
          ...(option.kind === 'boolean' ? { kind: 'boolean' as const } : {}),
          ...(option.currentValue === null ? {} : { currentValue: option.currentValue }),
          choices: option.choices.map(choice => ({
            id: choice.value,
            name: choice.name,
            ...(choice.description === undefined ? {} : { description: choice.description }),
          })),
        })),
      }),
      ...(entry === undefined ? {} : { updatedAt: entry.updatedAt }),
      // The agent's last declared slash commands, for a conversation whose own
      // ACP session does not exist yet. Live sessions still answer through
      // `session/chat-list`; this is the pre-first-message fallback only.
      ...(commands === undefined ? {} : {
        commands: commands.commands,
        commandsUpdatedAt: commands.updatedAt,
      }),
    }
  }

  /**
   * Resolve one exact ACP route id for validation/streaming. Unknown agents
   * throw (that is what turns `selectModel` into `model-unavailable`); known
   * agents NEVER throw — a stale variant degrades to a bare-id entry, because
   * the agent may have dropped a model it used to publish and an
   * already-selected session must keep working.
   */
  resolveAdapterModel(provider: string, model: string): LlmResolvedModelInfo {
    const { agentId, choice } = splitAdapterModelId(model)
    const def = this.host.defOf(agentId)
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
  reasoningMeta(agentId: string): LlmModelReasoningInfo | undefined {
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
   * Drop every fact this service holds for a deleted agent, and rewrite the
   * catalog file when anything existed.
   *
   * The fork capability goes with the agent: a same-id rebuild must not inherit
   * the OLD agent's "supported" and click into a `fork_unsupported` wall before
   * its own first `initialize` answers.
   */
  forgetAgent(agentId: string): void {
    const droppedCatalog = this.catalogs.delete(agentId)
    const droppedCommands = this.commandCache.delete(agentId)
    const droppedFork = this.forkCaps.delete(agentId)
    if (droppedCatalog || droppedCommands || droppedFork) this.persistCatalogs()
  }
}
