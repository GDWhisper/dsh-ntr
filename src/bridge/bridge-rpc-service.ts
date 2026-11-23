/**
 * The `/acp` RPC face: session creation, the prompt turn loop, cancel / close,
 * mode / config writes, permission answers and the read-only transcript /
 * session views. The chat plane (`streamPrompt`) and the session start /
 * resume / stalled-reclaim flows stay on the manager; every capability this
 * cluster needs arrives through {@link BridgeRpcHost}, so this module never
 * imports `manager.ts` or `bridge.ts`. The manager keeps same-named delegates.
 */
import { realpathSync } from 'node:fs'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { EventHub } from '../impl.ts'
import { AcpError, randomUUID, resolveSessionCwd } from '../impl.ts'
import type { AcpDelegatePolicy, AcpStartSessionOpts, ElicitationOutcome } from '../protocol.ts'
import type { BridgeRegistryService } from './bridge-registry-service.ts'
import { describeError } from './errors.ts'
import { isPerSessionAgent, type BridgeScope } from './identity.ts'
import type { SessionRegistryService } from './session-registry-service.ts'
import { agentRefusalDetail, rateLimitedTurnError, snapshot } from './shape.ts'
import { hasPromptSlot, lifecycleOf } from './session-lifecycle.ts'
import type { LiveSession } from './turn-stream.ts'
import type { TurnWatchdogService } from './turn-watchdog-service.ts'

/**
 * The manager capabilities this service leans on. Every member is a value or
 * an already-built sibling service, except the stalled-turn reclaim, which
 * stays on the manager because the chat plane runs the same reclaim before
 * its own acquisition.
 */
export interface BridgeRpcHost {
  /** The host event stream the turn and session frames are published on. */
  readonly hub: EventHub
  /** The process table: lookup, resume, prune and the bridge map itself. */
  readonly bridgeRegistry: BridgeRegistryService
  /** The turn-stream index and the stall watchdog's scan timer. */
  readonly watchdog: TurnWatchdogService
  /** The chat-session registry whose records a close drops. */
  readonly registry: SessionRegistryService
  /**
   * Take the agent process back from a turn the stall watchdog abandoned,
   * BEFORE the next prompt is sent (see `BridgeManager.prepareStalledSession`).
   */
  prepareStalledSession(session: LiveSession): Promise<{ ok: true; reset?: boolean } | { ok: false; message: string }>
}

/** The `/acp` RPC surface of the bridge (routed by `dispatchRpc` in `impl.ts`). */
export class BridgeRpcService {
  constructor(private readonly host: BridgeRpcHost) {}

  async startSession(agentId: string, cwd: string | undefined, opts?: AcpStartSessionOpts): Promise<{ sessionId: string; cwd: string }> {
    // A1: an `/acp` session gets its own process. The token is only the bridge
    // key; later lookups find the session by the id it was registered with.
    const scope: BridgeScope = isPerSessionAgent(agentId)
      ? { kind: 'ephemeral', token: randomUUID() }
      : { kind: 'agent' }
    if (opts === undefined) {
      // The legacy `/acp` path, verbatim: roots-only fence inside openSession,
      // no spawn alignment. `cwd` is additive on the answer (the resolved
      // session directory), never a behaviour change.
      const session = await this.host.bridgeRegistry.bridgeFor(agentId, scope).createSession(cwd)
      return { sessionId: session.sessionId, cwd: session.cwd }
    }
    // The delegated path (plan §3): validate BEFORE any spawn — `bridgeFor` is
    // pure bookkeeping, so a refused cwd (`cwd_denied` / `bad_cwd` / `no_cwd`,
    // thrown verbatim for the delegate layer to wrap with the agent id) never
    // starts a throwaway process. The extra roots are the CALLING session's
    // workspace (user-picked, the chat path's same authorization); the fence
    // itself is unchanged. `alignSpawnCwd` then runs the agent PROCESS in the
    // validated directory — agents like codebuddy fix their workspace at spawn.
    const bridge = this.host.bridgeRegistry.bridgeFor(agentId, scope)
    const extraRoots = opts.extraRoots ?? []
    const resolved = resolveSessionCwd(bridge.def, cwd, p => realpathSync(p), extraRoots)
    const session = await bridge.createSession(resolved, extraRoots, opts.alignSpawnCwd === true ? resolved : undefined)
    return { sessionId: session.sessionId, cwd: session.cwd }
  }

  async prompt(sessionId: string, prompt: string | ContentBlock[]): Promise<{ turnId: string }> {
    let located = await this.host.bridgeRegistry.locateOrResume(sessionId)
    // The watchdog abandoned a previous turn here and the agent may still be
    // holding its prompt slot on the old process: reclaim BEFORE sending, or
    // this message queues behind a turn that will never answer.
    if (located.session.orphanPromptTurnSeq !== undefined) {
      const prepared = await this.host.prepareStalledSession(located.session)
      if (!prepared.ok) throw new AcpError('agent_unresponsive', prepared.message)
      // Without `session/load` there is nothing to re-locate: the record was
      // dropped on purpose, and "/acp" has no conversation to recreate it from.
      // Re-locating anyway would surface a misleading `unknown_session`.
      if (prepared.reset === true) {
        throw new AcpError('session_reset', `acp: agent "${located.session.agentId}" does not support session resume; start a new session`)
      }
      // A resumable reclaim released the record: re-locate what is live now.
      located = await this.host.bridgeRegistry.locateOrResume(sessionId)
    }
    const { bridge, session } = located
    // The agent prompt slot is SHARED with chat turns: `running` alone misses
    // a chat turn whose cancellation already released it (`running` false,
    // the prompt slot still naming the agent-side turn), and a live chat
    // controller means a continuation step may resume the SAME agent turn.
    // A controller that already SETTLED (kept only so its card's continuation
    // can still stream) has given the agent slot back: `/acp` may use it, and
    // advancing `turnSeq` retires it — the behaviour the stale-controller
    // watchdog case pins.
    const chatController = session.turnController
    if (session.running
      || hasPromptSlot(session)
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
    // versa. The settler is idempotent and generation-guarded; the turn still
    // ends through `turn/end` below, so chat and RPC turns share one gate
    // without sharing a stream controller. The generation advances BEFORE the
    // slot is claimed: the slot carries it, and a superseded settler compares.
    session.running = true
    session.turnSeq += 1
    const endTurn = bridge.beginTurn(session)
    const turnGen = session.turnSeq
    session.lastAgentActivityAt = Date.now()
    session.activeToolCalls.clear()
    // A new turn owns the session from here: any reclaim marker named an
    // earlier generation and must not suppress THIS turn's settle.
    session.reclaimedTurnSeq = undefined
    // This prompt consumes Antigravity's backlog flush on the RAW face (no
    // controller folds it): the committed echo guard's one replay chance is
    // spent here, so retire it — a dead key must not swallow the next chat
    // turn's real answer. The transcript still shows the replay. If runPrompt
    // later refuses and the flush never happened, the record is NOT restored:
    // a visible duplicate beats a dead key silently eating an answer.
    session.lateEcho = undefined
    this.host.watchdog.armStallTimer()
    const turnId = randomUUID()
    const promptText = typeof prompt === 'string'
      ? prompt
      : blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    this.host.hub.broadcast({ type: 'turn/start', sessionId, turnId, text: promptText })
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
          this.host.hub.broadcast({ type: 'session/meta', sessionId, session: snapshot(session) })
        } else if (session.quotaRefusal !== undefined) {
          session.quotaRefusal = undefined
          this.host.hub.broadcast({ type: 'session/meta', sessionId, session: snapshot(session) })
        }
        // Release the shared slot BEFORE the terminal frame: a listener that
        // sends the next prompt on `turn/end` must not read a stale claim.
        endTurn()
        session.running = false
        if (refusal?.kind === 'quota') {
          this.host.hub.broadcast({
            type: 'turn/end',
            sessionId,
            turnId,
            error: rateLimitedTurnError(session.agentId, refusal),
            errorKind: 'quota',
          })
        } else {
          this.host.hub.broadcast({ type: 'turn/end', sessionId, turnId, stopReason: result.stopReason })
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
        if (lifecycleOf(session) !== 'live') {
          this.clearOrphanPrompt(session, turnGen)
          return
        }
        this.clearOrphanPrompt(session, turnGen)
        endTurn()
        session.running = false
        this.host.hub.broadcast({
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
  clearOrphanPrompt(session: LiveSession, turnGen: number): void {
    if (session.orphanPromptTurnSeq === turnGen) session.orphanPromptTurnSeq = undefined
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.host.bridgeRegistry.tryLocate(sessionId)
    if (live === undefined) return // released/stale session: nothing to cancel
    await live.bridge.cancel(live.session)
  }

  async closeSession(sessionId: string): Promise<void> {
    // The turn stream of this session dies with it: a continuation step that
    // is already on its way must not resume a closed session.
    this.host.watchdog.disposeTurnStreamsOf(controller => controller.session.sessionId === sessionId)
    const live = this.host.bridgeRegistry.tryLocate(sessionId)
    if (live !== undefined) {
      await live.bridge.closeSession(live.session, 'closed')
      this.host.registry.forgetDshSession(sessionId)
      const key = this.host.bridgeRegistry.keyOfBridge(live.bridge)
      if (key !== undefined) this.host.bridgeRegistry.pruneBridge(key)
      return
    }
    // A released session has no process left to close; just drop the record.
    for (const [key, bridge] of this.host.bridgeRegistry.bridges) {
      if (bridge.dropReleased(sessionId)) {
        this.host.hub.broadcast({ type: 'session/closed', sessionId, reason: 'closed' })
        this.host.bridgeRegistry.pruneBridge(key)
        return
      }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  /** Delegation-only session policy (`LiveSession.permissionPolicy`); set before the first prompt, no RPC face of its own. */
  setPermissionPolicy(sessionId: string, policy: AcpDelegatePolicy): void {
    const live = this.host.bridgeRegistry.tryLocate(sessionId)
    if (live === undefined) throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
    live.session.permissionPolicy = policy
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const { bridge, session } = await this.host.bridgeRegistry.locateOrResume(sessionId)
    await bridge.setMode(session, modeId)
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    const { bridge, session } = await this.host.bridgeRegistry.locateOrResume(sessionId)
    await bridge.setConfigOption(session, configId, value)
  }

  respondPermission(requestId: string, optionId: string | undefined): void {
    for (const bridge of this.host.bridgeRegistry.bridges.values()) {
      const owner = bridge.permissions.sessionIds().find(p => p.requestId === requestId)
      if (owner === undefined) continue
      bridge.permissions.respond(requestId, optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId })
      return
    }
    throw new AcpError('unknown_request', `acp: no pending permission ${requestId}`)
  }

  respondElicitation(requestId: string, outcome: ElicitationOutcome): void {
    for (const bridge of this.host.bridgeRegistry.bridges.values()) {
      if (!bridge.elicitations.has(requestId)) continue
      bridge.elicitations.respond(requestId, outcome)
      return
    }
    throw new AcpError('unknown_request', `acp: no pending elicitation ${requestId}`)
  }

  transcript(sessionId: string, afterSeq: number | undefined): { session: unknown; entries: Array<{ seq: number; update: unknown }> } {
    const live = this.host.bridgeRegistry.tryLocate(sessionId)
    if (live !== undefined) {
      return { session: snapshot(live.session), entries: live.session.transcript.since(afterSeq ?? 0) }
    }
    // A released session still serves its pre-crash transcript for viewing.
    for (const bridge of this.host.bridgeRegistry.bridges.values()) {
      const released = bridge.hasReleased(sessionId)
      if (released !== undefined) {
        return { session: snapshot(released), entries: released.transcript.since(afterSeq ?? 0) }
      }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  sessions(): unknown[] {
    return [...this.host.bridgeRegistry.bridges.values()].flatMap(b => [...b.sessionList, ...b.releasedList].map(snapshot))
  }
}