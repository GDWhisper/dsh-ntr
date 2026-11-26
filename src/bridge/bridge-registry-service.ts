/**
 * Bridge registry + lifecycle: the process table (`bridges` / `bridgeScopes`),
 * the stop gate (`stoppingAgents`), the startup-failure notice dedupe
 * (`noticedBridgeFailures`), and every lookup / teardown path built on them.
 *
 * The manager keeps `makeBridge` (it wires the manager's own callbacks into
 * every `AgentBridge`) and the turn-stream index; every capability this cluster
 * needs arrives through {@link BridgeRegistryHost}, so this module never
 * imports `manager.ts` or `bridge.ts`. The manager keeps same-named delegates
 * and getters onto the SAME Map instances, because tests introspect and patch
 * them through the manager.
 */
import type { EventHub } from '../impl.ts'
import { AcpError } from '../impl.ts'
import type { AcpAgentDef, AgentView, SessionView } from '../protocol.ts'
import { SHUTDOWN_BUDGET_MS } from './agent-bridge.ts'
import type { AgentBridge } from './agent-bridge.ts'
import type { BridgeReleaseReport, BridgeReleasedEntry, BridgeSkippedEntry } from './types.ts'
import type { ModelCatalogService } from './catalog-service.ts'
import { bridgeKey, isPerSessionAgent, type BridgeScope } from './identity.ts'
import type { SessionRegistryService } from './session-registry-service.ts'
import type { LiveSession, TurnStreamController } from './turn-stream.ts'

/**
 * The manager capabilities this service leans on. Every member is a callback,
 * a getter or an already-built sibling service, so the service holds no
 * reference to `BridgeManager` itself.
 */
export interface BridgeRegistryHost {
  /** The host event stream the status frames and failure notices are published on. */
  readonly hub: EventHub
  /** The configured definition, or `undefined` when the registry does not own the id. */
  defOf(agentId: string): AcpAgentDef | undefined
  /** Every configured definition, in roster order (the `agentViews` walk). */
  defs(): Iterable<AcpAgentDef>
  /**
   * Build one child bridge with the manager's callback wiring. Stays on the
   * manager because it closes over the catalog, persistence, subagent and
   * late-output clusters; the registry only supplies the connection-lost
   * handler and the catalog / persistence observers a real holder needs.
   */
  makeBridge(
    def: AcpAgentDef,
    onConnectionLost: (bridge: AgentBridge, reason: string) => void,
    onCatalog?: (agentId: string, configOptions: unknown, shapeOnly?: boolean) => void,
    onCommands?: (agentId: string, commands: NonNullable<SessionView['availableCommands']>) => void,
    onSessionsDirty?: () => void,
    onForkCapability?: (agentId: string, supported: boolean) => void,
  ): AgentBridge
  /** The catalog cluster a new holder's observations are absorbed into. */
  readonly catalog: ModelCatalogService
  /** Rewrite `agents.json` after the session records changed. */
  persistAgents(): void
  /** The chat-session registry whose records a stop drops. */
  readonly registry: SessionRegistryService
  /** Tear down the turn streams a predicate matches (death / stop / shutdown). */
  disposeTurnStreamsOf(match: (controller: TurnStreamController) => boolean): void
  /** Clear the stall watchdog's scan timer (host shutdown only). */
  disarmStallTimer(): void
}

/** Routes host session ids to their owning bridge. */
export class BridgeRegistryService {
  /**
   * Process slots, keyed by `bridgeKey(agentId, scope)`. A non-per-session
   * agent folds every scope onto the bare agent id (exactly one entry, as
   * before); a per-session agent (A1) keeps one entry per chat / ephemeral /
   * probe scope, so `bridges.values()` stays the complete set and every
   * traversal keeps working unchanged.
   */
  readonly bridges = new Map<string, AgentBridge>()
  /** The scope each `bridges` entry was created for; keys are opaque and never parsed. */
  readonly bridgeScopes = new Map<string, BridgeScope>()
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

  constructor(private readonly host: BridgeRegistryHost) {}

  /**
   * Resolve (or create) the bridge for one agent + scope. Creation is pure
   * bookkeeping: `ensureReady` stays lazy, so a lookup that never runs a turn
   * costs an object and nothing else.
   */
  bridgeFor(agentId: string, scope: BridgeScope): AgentBridge {
    const def = this.host.defOf(agentId)
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
      bridge = this.host.makeBridge(def, (b, reason) => {
        this.connectionLost(b, reason)
      }, (observedAgentId, configOptions, shapeOnly) => {
        if (shapeOnly) this.host.catalog.absorbCatalogShape(observedAgentId, configOptions)
        else this.host.catalog.absorbCatalog(observedAgentId, configOptions)
      }, (observedAgentId, commands) => {
        this.host.catalog.absorbCommands(observedAgentId, commands)
      }, () => {
        this.host.persistAgents()
      }, (observedAgentId, supported) => {
        this.host.catalog.noteForkCapability(observedAgentId, supported)
      })
      this.bridges.set(key, bridge)
      this.bridgeScopes.set(key, scope)
    }
    return bridge
  }

  /** Every bridge currently serving one configured agent (one entry unless A1). */
  bridgesOf(agentId: string): AgentBridge[] {
    const result: AgentBridge[] = []
    for (const bridge of this.bridges.values()) {
      if (bridge.def?.id === agentId) result.push(bridge)
    }
    return result
  }

  /** The legacy single-slot lookup; non-per-session agents keep the exact old key. */
  bridge(agentId: string): AgentBridge {
    return this.bridgeFor(agentId, { kind: 'agent' })
  }

  /** Every session id this bridge owns right now (live + parked), for isolation checks. */
  sessionIdsOf(bridge: AgentBridge): Set<string> {
    const ids = new Set<string>()
    for (const session of bridge.sessionList) ids.add(session.sessionId)
    for (const session of bridge.releasedList) ids.add(session.sessionId)
    return ids
  }

  /** The key a bridge is registered under, for pruning by key. */
  keyOfBridge(bridge: AgentBridge): string | undefined {
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
  bridgeOwning(agentId: string, sessionId: string): AgentBridge | undefined {
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
  bridgeForSession(session: LiveSession): AgentBridge {
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
  pruneBridge(key: string): void {
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

  find(sessionId: string): { bridge: AgentBridge; session: LiveSession } {
    for (const bridge of this.bridges.values()) {
      const session = bridge.hasSession(sessionId)
      if (session !== undefined) return { bridge, session }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  tryLocate(sessionId: string): { bridge: AgentBridge; session: LiveSession } | undefined {
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
  async locateOrResume(sessionId: string): Promise<{ bridge: AgentBridge; session: LiveSession }> {
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

  connectionLost(bridge: AgentBridge, reason: string): void {
    // A dead process cannot settle its prompt: the turn streams riding it end
    // here (their `runPrompt` promise also rejects into settle, but this also
    // covers a promise the connection teardown leaves pending).
    // Only THIS bridge's sessions: an A1 agent's other conversations ride their
    // own processes, and matching by `agentId` would abort turns that are still
    // running fine. `releaseAll` below is already per-bridge (`parkSessions`
    // walks this instance's own `sessions`).
    const owned = this.sessionIdsOf(bridge)
    this.host.disposeTurnStreamsOf(controller => owned.has(controller.session.sessionId))
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
  aggregateView(def: AcpAgentDef): AgentView {
    const bridges = this.bridgesOf(def.id)
    if (bridges.length === 0) {
      // Field-for-field the pre-spawn shape a non-A1 agent has always
      // reported: "not started yet" must not become a different shape.
      return this.host.makeBridge(def, () => { /* pre-spawn */ }).view()
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
  publishAgentStatus(agentId: string): void {
    const def = this.host.defOf(agentId)
    if (def === undefined) return
    const view = this.aggregateView(def)
    const bridges = this.bridgesOf(agentId)
    // The error belongs to the child that produced the winning state; a
    // lingering error on a stopped sibling must not colour a ready agent. No
    // second fallback: a ready aggregate whose own children carry no error must
    // publish NO `error` field, never another child's stale text.
    const error = bridges.find(bridge => bridge.state === view.state && bridge.errorText !== undefined)?.errorText
    this.host.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: view.state,
      ...(error === undefined ? {} : { error }),
      agent: view,
    })
  }

  agentViews(): AgentView[] {
    return [...this.host.defs()].map(def => this.aggregateView(def))
  }

  /**
   * One log line per distinct startup failure of one child. The aggregate
   * `agent/status` deliberately stays `ready` while ANY sibling serves, so a
   * failed child's error is invisible there; without this notice the user only
   * sees "one conversation does not work". Deduped per bridge instance + text:
   * `publishStatus` fires on every transition and must not spam the log.
   */
  noticeBridgeFailure(bridge: AgentBridge): void {
    const error = bridge.errorText
    if (bridge.state !== 'error' || error === undefined) return
    if (this.noticedBridgeFailures.get(bridge) === error) return
    this.noticedBridgeFailures.set(bridge, error)
    this.host.hub.broadcast({
      type: 'agent/notice',
      agentId: bridge.def.id,
      level: 'error',
      text: `acp: agent "${bridge.def.id}" failed to start: ${error}`,
    })
  }

  /**
   * Kill this agent's process and forget the records of the sessions it closes.
   *
   * The removed records ARE persisted (`persist` defaults to true): a stop
   * closes the agent-side sessions on purpose, so leaving them in `agents.json`
   * would resurrect them as resumable after the next host restart. Save and
   * delete pass `false` because each performs its own strict registry write
   * immediately afterwards; a second best-effort write there would race the
   * definition it is about to replace.
   *
   * `keepReleased` (default) spares the parked rows: a stop sends
   * `session/close` only for the live ones, so a parked record's agent-side
   * session survives the stop and the row stays the conversation's only path
   * back to it. Delete passes `false` — it removes the agent itself.
   */
  async stopAgent(agentId: string, persist = true, keepReleased = true): Promise<void> {
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
      for (const sessionId of this.host.registry.dropSessionsOfAgent(agentId, keepReleased)) owned.add(sessionId)
      this.host.disposeTurnStreamsOf(controller => owned.has(controller.session.sessionId))
      if (persist) this.host.persistAgents()
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
   * ON-DEMAND idle release (the `acp_release` tool): park every releasable
   * process NOW instead of waiting out the idle timer. Eligibility is the
   * bridge's own idle rule (constraint 19) — it never interrupts work and
   * never parks a session the agent could not reload. The released holder
   * stays in the table as a stopped process slot (A1 session holders are
   * pruned when discardable), so the next message resumes through
   * `session/load` exactly like an idle release.
   */
  releaseIdle(agentId?: string): BridgeReleaseReport {
    const released: BridgeReleasedEntry[] = []
    const skipped: BridgeSkippedEntry[] = []
    // Snapshot first: releasing mutates the map (pruneBridge below).
    const entries: Array<{ key: string; bridge: AgentBridge }> = []
    for (const [key, bridge] of this.bridges) {
      if (bridge.state !== 'ready') continue
      if (agentId !== undefined && bridge.def?.id !== agentId) continue
      entries.push({ key, bridge })
    }
    for (const { key, bridge } of entries) {
      const blocker = bridge.idleReleaseBlocker()
      if (blocker !== undefined) {
        skipped.push({ agentId: bridge.def.id, reason: blocker })
        continue
      }
      const sessions = bridge.sessionList.length
      bridge.releaseAll(`released on request of the main agent (${String(sessions)} sessions)`, 'idle')
      released.push({ agentId: bridge.def.id, sessions })
      this.pruneBridge(key)
    }
    return { released, skipped }
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
    this.host.disarmStallTimer()
    this.host.disposeTurnStreamsOf(() => true)
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
}