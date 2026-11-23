/**
 * The ACP model catalog's browser half, lifted out of `AcpStore` (split plan
 * P3b): the cached/persisted catalog panes, the explicit probe, the ready-to-
 * render seat surface, the exposure filter writes and the invalidation hook.
 *
 * Nothing here spawns by itself: `agent/catalog` answers from the host's memory
 * and `agent/cached-models` reads the persisted file. Only `probeModels` asks
 * the host to start a process — an explicit gesture, or a VISIBLE settings page
 * refreshing a snapshot older than {@link CATALOG_AUTO_PROBE_MS} — and it is
 * the one call that also updates the settings card's probe state.
 *
 * The service never imports the facade; the RPC face, the snapshot, the label
 * resolver, `flashError` and the roster `resync` arrive through
 * {@link CatalogHost}.
 */

import type { AgentCatalogResult, AgentProbeModelsResult } from '../../protocol.ts'
import type { UiState } from './state.ts'

/**
 * How old a PERSISTED catalog may get before a VISIBLE page refreshes it
 * without being asked. The host never probes on its own: page entry is the
 * gesture and this age is the budget, so a click-through costs a probe and a
 * second look costs nothing. Ten minutes still catches an agent whose own
 * default changed underneath the cache (CodeBuddy's CLI model switch).
 */
export const CATALOG_AUTO_PROBE_MS = 10 * 60_000

/** What the catalog service needs from the store, injected. */
export interface CatalogHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
  /** The store's locale-bound label resolver (a stable reference across renders). */
  label(zh: string, en: string): string
  /** Surface an action failure in the settings page's notice line. */
  flashError(error: unknown): void
  /** Re-read the roster and every settings-card snapshot after a write landed. */
  resync(): Promise<void>
}

export class CatalogService {
  /** In-flight `agent/catalog` reads, keyed by agent id. */
  private readonly seatCatalogReads = new Set<string>()
  /** In-flight `agent/cached-models` reads, keyed by agent id. */
  private readonly cachedModelReads = new Set<string>()
  /**
   * When this browser half last issued an AUTOMATIC refresh, per agent. It is
   * the other half of the freshness budget: the host keeps an unchanged probe's
   * old `updatedAt` (`absorbCatalog` returns the existing entry), so the cache
   * stamp alone would never age out and every remount would probe again.
   */
  private readonly autoProbeAt = new Map<string, number>()

  constructor(private readonly host: CatalogHost) {}

  /**
   * Seed one agent's model panes from the host's PERSISTENT catalog cache
   * (`agent/cached-models`, memory-only: it never spawns).
   *
   * The settings card used to learn a catalog only from `agent/probe-models`,
   * so its panes stayed blank until the user clicked 「检测可用模型」 on every
   * visit — including the models already configured, which are known from the
   * agent definition and the on-disk catalog. This read fills both panes on
   * mount; the probe stays the explicit REFRESH (add what the agent newly
   * publishes, drop what it stopped advertising).
   */
  async loadCachedModels(agentId: string): Promise<void> {
    if (this.host.state().modelCatalogs[agentId] !== undefined || this.cachedModelReads.has(agentId)) return
    this.cachedModelReads.add(agentId)
    try {
      const result = await this.host.call<AgentProbeModelsResult | null>('agent/cached-models', { agentId })
      // `null` = this agent never published a catalog. A probe may have landed
      // while this read was in flight; a fresh probe always wins.
      if (result === null || result === undefined || this.host.state().modelCatalogs[agentId] !== undefined) return
      this.host.mutate({ modelCatalogs: { ...this.host.state().modelCatalogs, [agentId]: result } })
    } catch {
      // Older host without the endpoint, or an agent deleted meanwhile: the
      // panes fall back to the selection alone, exactly as before a probe.
    } finally {
      this.cachedModelReads.delete(agentId)
    }
  }

  /**
   * Ask the host to probe one agent's model catalog (spawn + throwaway session).
   * `model` fetches just that model's thought levels for the card, without the
   * page notice. `silent` keeps an AUTOMATIC refresh's failure on the agent's
   * own row instead of the page notice. `staleAfterMs` makes the call itself
   * budgeted: an unread catalog, a snapshot younger than that, or an attempt
   * this browser half already made inside the window is skipped without spawning.
   */
  async probeModels(agentId: string, model?: string, options?: { silent?: boolean; staleAfterMs?: number }): Promise<void> {
    const silent = options?.silent === true
    // The budget belongs to the CATALOG-level refresh only: a per-model probe
    // would otherwise stamp an attempt and suppress a later automatic refresh.
    if (options?.staleAfterMs !== undefined && model === undefined) {
      const cached = this.host.state().modelCatalogs[agentId]
      if (cached === undefined) return
      const last = Math.max(cached.updatedAt, this.autoProbeAt.get(agentId) ?? 0)
      if (Date.now() - last < options.staleAfterMs) return
      this.autoProbeAt.set(agentId, Date.now())
    }
    const previousError = this.host.state().probeErrors[agentId]
    const current = this.host.state()
    this.host.mutate({
      probingModels: { ...current.probingModels, [agentId]: true },
      probeErrors: this.clearProbeError(agentId),
    })
    try {
      const result = await this.host.call<AgentProbeModelsResult>('agent/probe-models', model === undefined ? { agentId } : { agentId, model })
      // The seat list is a filtered view of the same catalog: drop the cached
      // one (in the same patch) and re-read below, so a fresh probe lands in an
      // open conversation too.
      const now = this.host.state()
      const seatCatalogs = { ...now.seatCatalogs }
      delete seatCatalogs[agentId]
      this.host.mutate({
        modelCatalogs: { ...now.modelCatalogs, [agentId]: result },
        seatCatalogs,
        probingModels: { ...now.probingModels, [agentId]: false },
        // A retry after the user fixed the problem must not leave the old
        // failure pinned at the top of the panel. Only drop the notice when it
        // is still ours — anything newer belongs to someone else.
        ...(previousError !== undefined && now.notice === previousError ? { notice: undefined } : {}),
      })
      void this.loadAgentCatalog(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/probe-models')
        ? this.host.label('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活模型检测功能。', 'Host running older version. Please restart dsh web to enable model detection.')
        : msg
      const now = this.host.state()
      this.host.mutate({
        // A probe nobody asked for must not push its failure into the page
        // notice line; the row keeps its own ⚠ and the retry button.
        ...(model === undefined && !silent ? { notice } : {}),
        probingModels: { ...now.probingModels, [agentId]: false },
        probeErrors: { ...now.probeErrors, [agentId]: notice },
      })
    }
  }

  private clearProbeError(agentId: string): Record<string, string> {
    const probeErrors = this.host.state().probeErrors
    if (probeErrors[agentId] === undefined) return probeErrors
    const next = { ...probeErrors }
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
    if (this.host.state().seatCatalogs[agentId] !== undefined || this.seatCatalogReads.has(agentId)) return
    this.seatCatalogReads.add(agentId)
    try {
      const result = await this.host.call<AgentCatalogResult>('agent/catalog', { agentId })
      this.host.mutate({ seatCatalogs: { ...this.host.state().seatCatalogs, [agentId]: result } })
    } catch {
      // An older host half, or an agent that was deleted meanwhile: the seats
      // fall back to the roster's own title and the bare agent route, which is
      // exactly what they show before a catalog exists.
    } finally {
      this.seatCatalogReads.delete(agentId)
    }
  }

  /** Drop one agent's cached seat catalog (its model surface just changed). */
  invalidateSeatCatalog(agentId: string): void {
    const seatCatalogs = this.host.state().seatCatalogs
    if (seatCatalogs[agentId] === undefined) return
    const next = { ...seatCatalogs }
    delete next[agentId]
    this.host.mutate({ seatCatalogs: next })
  }

  /**
   * Persist the ACP-seat model filter for one agent. `undefined` DELETES the
   * field — the default-open state, where every model the agent publishes is
   * offered. An explicit array (including `[]`, which lists nothing but the
   * base / currently-in-force row) is the user's narrowing. Uses the dedicated
   * lightweight RPC so the agent process and its live sessions are never
   * restarted.
   */
  async setExposedModels(agentId: string, exposedModels: string[] | undefined): Promise<void> {
    try {
      await this.host.call('agent/set-exposed-models', {
        agentId,
        ...(exposedModels === undefined ? {} : { exposedModels }),
      })
      await this.host.resync()
      // The seats render the filtered list, so an edited filter has to be
      // re-read or the open conversation keeps offering the old set.
      this.invalidateSeatCatalog(agentId)
      void this.loadAgentCatalog(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/set-exposed-models')
        ? this.host.label('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用模型筛选功能。', 'Host running older version. Please restart dsh web to enable model filtering.')
        : msg
      this.host.mutate({ notice })
      throw error
    }
  }

  /**
   * Persist the auto-discovery switch for one agent. Lightweight like
   * {@link setExposedModels}: no process restart, and the current selection is
   * left exactly as it is.
   */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    try {
      await this.host.call('agent/set-auto-discover-models', { agentId, autoDiscoverModels })
      await this.host.resync()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/set-auto-discover-models')
        ? this.host.label('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用自动发现功能。', 'Host running older version. Please restart dsh web to enable auto-discovery.')
        : msg
      this.host.mutate({ notice })
      throw error
    }
  }
}
