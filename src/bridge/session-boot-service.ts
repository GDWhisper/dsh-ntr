/**
 * Session boot / resume cluster: the chat acquisition (`getOrCreateDshSession`),
 * the explicit resume gesture (`resumeChatSession`), the stalled-turn reclaim
 * (`prepareStalledSession`) and the steer's cancel-then-resend gate
 * (`reclaimChatPrompt` / `waitForSettleGate`). Every capability this cluster
 * needs arrives through {@link SessionBootHost}, so this module never imports
 * `manager.ts` or `bridge.ts`. The manager keeps same-named delegates.
 */
import type { EventHub } from '../impl.ts'
import { AcpError } from '../impl.ts'
import type { BridgeRegistryService } from './bridge-registry-service.ts'
import type { ChatChoiceService } from './chat-choice-service.ts'
import type { BridgeScope } from './identity.ts'
import { routeBindingRegistry } from './registries.ts'
import type { SessionRegistryService } from './session-registry-service.ts'
import { chatWorkspaceRoot } from './state-paths.ts'
import { hasPromptSlot, lifecycleOf } from './session-lifecycle.ts'
import type { LiveSession, TurnStreamController } from './turn-stream.ts'
import type { TurnWatchdogService } from './turn-watchdog-service.ts'
import type { SessionWorkspaceResolver } from './types.ts'

/**
 * The manager capabilities this service leans on. Every member is a value or
 * an already-built sibling service, except the workspace resolver and the
 * Antigravity transient-state init, which stay manager-owned.
 */
export interface SessionBootHost {
  /** The host event stream the reclaim notice is published on. */
  readonly hub: EventHub
  /** The process table: scoped acquisition, ownership lookup, session ids. */
  readonly bridgeRegistry: BridgeRegistryService
  /** The chat-session records, the conversation binding and the first-turn lock. */
  readonly registry: SessionRegistryService
  /** The conversation's pick: the route sync and the pick re-application. */
  readonly choices: ChatChoiceService
  /** The turn-stream index the stalled reclaim scans for sibling work. */
  readonly watchdog: TurnWatchdogService
  /** Rewrite `agents.json` after a create / resume refreshed the record. */
  persistAgents(): void
  /** The host's live workspace resolver (the sidebar's selection). */
  workspaceResolver(): SessionWorkspaceResolver | undefined
  /** Initialise the Antigravity-only transient sets on a NEW session. */
  initLateOutputState(session: LiveSession): void
}

export class SessionBootService {
  constructor(private readonly host: SessionBootHost) {}

  /**
   * Bring one chat conversation's released session back on a fresh process on
   * the USER's explicit gesture (the "恢复进程" banner) — the same work the
   * next prompt performs lazily (`getOrCreateDshSession`'s released branch),
   * minus the create path: a banner button must never materialize a session
   * the conversation has not had yet. A live target passes through untouched,
   * so a double click (or a click racing the next message) spawns nothing.
   */
  async resumeChatSession(dshSessionId: string): Promise<void> {
    const candidates = this.host.registry.sessionsOf(dshSessionId)
    // The session the NEXT message would use — the bound agent's — is the one
    // to bring back; the first candidate is the fallback for a conversation
    // whose binding has drifted (same selection `setChatSessionMode` makes
    // without an explicit agentId).
    const target = candidates.find(session => session.agentId === this.host.registry.chatAgentFor(dshSessionId)) ?? candidates[0]
    if (target === undefined) {
      throw new AcpError('unknown_session', `acp: no ACP session is bound to chat session ${dshSessionId}`)
    }
    if (lifecycleOf(target) !== 'parked') return
    // The parked record belongs to the holder it was parked on (A1); resuming
    // on any other process would open the same session twice.
    const bridge = this.host.bridgeRegistry.bridgeForSession(target)
    const resumed = await bridge.resumeSession(target)
    // Chat-side rebind + pick re-application, verbatim the lazy path's: the
    // freshly loaded session comes back at the agent's defaults, so the
    // conversation's model / thought level must be re-applied or the composer
    // would show one thing and the process run another (see
    // `getOrCreateDshSession`).
    resumed.dshSessionId = dshSessionId
    this.host.registry.lockChatAgent(dshSessionId, target.agentId)
    if (this.host.registry.hasChoice(dshSessionId)) this.host.choices.syncConversationRoute(dshSessionId)
    else routeBindingRegistry().conversations.set(dshSessionId, resumed.modelId ?? target.agentId)
    await this.host.choices.applyChatChoice(resumed)
    // Same fallback as the lazy path: a conversation that never picked a mode
    // starts on the agent's configured default instead of its own initial one.
    await this.host.choices.applyAgentDefaultMode(resumed)
    resumed.provisionalLock = false
  }

  async getOrCreateDshSession(dshSessionId: string | undefined, agentId: string, cwd?: string): Promise<LiveSession> {
    // The lock also guards the TURN path, not just the picker: a stale request
    // header or a route rewrite must not start a second, context-less session
    // with another agent under the same conversation.
    if (dshSessionId !== undefined) {
      const lockedTo = this.host.registry.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError(
          'agent_locked',
          `acp: conversation is locked to agent "${lockedTo}" once its first turn has started; start a new conversation to use another agent`,
        )
      }
    }
    const existing = this.host.registry.sessionAt(dshSessionId, agentId)
    if (existing !== undefined && lifecycleOf(existing) === 'live') {
      const owner = this.host.bridgeRegistry.bridgeOwning(agentId, existing.sessionId)
      // A LIVE record must have a holder. This state is not reachable today:
      // every production deletion path parks the record first (`closeSession` /
      // `forceReset` set `closed`, a failed resume sets `released`), so only the
      // test suite synthesizes a live record without an owner to pin this
      // fallback. Should it ever happen anyway, returning the record would route
      // the next prompt to a process that no longer exists — the failure would
      // surface later as a dead `acpSessionId`, far from its cause. Drop the
      // unusable record and fail cleanly; the next attempt starts fresh.
      if (owner === undefined) {
        this.host.registry.forgetDshSession(existing.sessionId)
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
      if (dshSessionId !== undefined) this.host.registry.lockChatAgent(dshSessionId, agentId)
      return ready
    }
    // The session's agent died earlier: resume in place so the conversation
    // context survives via `session/load`.
    if (existing !== undefined && lifecycleOf(existing) === 'parked') {
      // The bridge that parked this record owns the resume; a chat conversation
      // falls back to the scope its DSH id names, exactly like the `new`
      // branch. Without a DSH id the old anonymous bucket stays as it was.
      const resumeBridge = this.host.bridgeRegistry.bridgeOwning(agentId, existing.sessionId)
        ?? (dshSessionId === undefined
          ? this.host.bridgeRegistry.bridge(agentId)
          : this.host.bridgeRegistry.bridgeFor(agentId, { kind: 'chat', dshSessionId }))
      const resumed = await resumeBridge.resumeSession(existing)
      // Rebind explicitly: a resume keeps the record's identity, but the chat
      // session id is what the conversation's permission card addresses.
      resumed.dshSessionId = dshSessionId
      // A resume without an explicit pick must keep serving the agent the
      // conversation was ON (its own model string when one was recorded). The
      // recorded pick wins when there is one (it carries the model half).
      if (dshSessionId !== undefined) {
        this.host.registry.lockChatAgent(dshSessionId, agentId)
        if (this.host.registry.hasChoice(dshSessionId)) this.host.choices.syncConversationRoute(dshSessionId)
        else routeBindingRegistry().conversations.set(dshSessionId, resumed.modelId ?? agentId)
      }
      // ...and the persisted pick (model / thought level) is re-applied to the
      // freshly loaded session, whose config comes back at the agent's defaults.
      await this.host.choices.applyChatChoice(resumed)
      await this.host.choices.applyAgentDefaultMode(resumed)
      // A RESUMED session had context before this call; a lock written here is
      // not provisional even if the conversation record was missing it.
      resumed.provisionalLock = false
      // The load refreshed the record's mirrors (modes / usage / hasHistory);
      // persist so a later restart restores what this resume saw.
      this.host.persistAgents()
      return resumed
    }
    // A chat session runs where its DSH session lives, not in the plugin's
    // sandbox directory: the sidebar's workspace selection IS the session's
    // workspace (`sandboxPolicy.resolve` reports it as `workspaceRoot`), and an
    // agent whose cwd is `~/.dsh/dsh-ntr/workspaces` answers "current workspace"
    // with that path while its Read/Glob/Bash cannot see the user's project.
    // That root is trusted on top of the agent's own roots for this session
    // only (see `chatWorkspaceRoot`); the fallback is the configured cwd.
    const workspaceRoot = chatWorkspaceRoot(this.host.workspaceResolver(), dshSessionId)
    // What the composer is showing right now. Must be read BEFORE `session/new`:
    // creating the session absorbs its defaults into the catalog, which would
    // overwrite exactly the values the user saw and bring back "displayed one
    // model, ran another". See `displayedChatDefaults`.
    const displayed = dshSessionId === undefined ? undefined : this.host.choices.displayedChatDefaults(agentId)
    // A1: each chat conversation gets its own process; a call without a DSH id
    // shares the anonymous bucket, exactly like the old `ephemeral:<agent>` key.
    const scope: BridgeScope = dshSessionId === undefined
      ? { kind: 'ephemeral', token: 'anonymous' }
      : { kind: 'chat', dshSessionId }
    const session = await this.host.bridgeRegistry.bridgeFor(agentId, scope).createSession(
      workspaceRoot ?? cwd,
      workspaceRoot === undefined ? [] : [workspaceRoot],
      // ...and the agent PROCESS runs there too, not just the session: see
      // `ensureReady` for why `session/new`'s cwd alone is not enough.
      workspaceRoot,
    )
    // Absent for `/acp`-RPC sessions and for adapter calls without a chat
    // session; their permission cards are addressed by the ACP session only.
    session.dshSessionId = dshSessionId
    this.host.initLateOutputState(session)
    this.host.registry.putSession(session)
    // Turn the displayed defaults into this conversation's pick, so the first
    // prompt runs on what the user was shown (see `seedChatChoiceFromCatalog`).
    if (dshSessionId !== undefined) this.host.choices.seedChatChoiceFromCatalog(dshSessionId, agentId, session, displayed)
    // Pin what this conversation now runs on, so a route that does not name it
    // (a fresh session replays the deployment default) is rewritten to reality.
    // The recorded pick wins when there is one (it carries the model half);
    // otherwise the agent that just served this turn is pinned bare.
    if (dshSessionId !== undefined) {
      if (this.host.registry.hasChoice(dshSessionId)) this.host.choices.syncConversationRoute(dshSessionId)
      else routeBindingRegistry().conversations.set(dshSessionId, agentId)
    }
    // Apply whatever the conversation picked BEFORE this session existed — the
    // model and thought level chosen in the composer ahead of the first message.
    // `session/new` answered with the agent's defaults; without this the first
    // turn would run on them and the pick would only take effect afterwards.
    await this.host.choices.applyChatChoice(session)
    // Seeding above normally records the displayed default as this turn's pick.
    // This covers the catalog-less / no-mode-seed path, and any conversation
    // that reached the create path without a pick record.
    await this.host.choices.applyAgentDefaultMode(session)
    if (dshSessionId !== undefined) {
      // The first ACP session is the moment the conversation's context starts
      // belonging to this agent. The lock is PROVISIONAL until this turn shows
      // something: if it delivers nothing, `rollbackFirstTurn` gives the
      // conversation back (a failed first attempt must not trap it).
      session.provisionalLock = this.host.registry.lockChatAgent(dshSessionId, agentId)
    }
    // The record is on disk from here: a host restart restores it as parked
    // instead of the next message starting a context-less new session.
    this.host.persistAgents()
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
  async prepareStalledSession(session: LiveSession): Promise<{ ok: true; reset?: boolean } | { ok: false; message: string }> {
    // A session whose `session/close` is still in flight must not be touched:
    // releasing it would park it as resumable and `doResumeSession` flips
    // `closed` back to false, resurrecting a closed session. Its owner deletes
    // the record; the caller's own acquisition creates a new session (chat) or
    // rejects `session_closed` (`/acp`).
    if (lifecycleOf(session) === 'closed') return { ok: true }
    if (lifecycleOf(session) === 'parked') return { ok: true } // the acquisition resumes it
    const bridge = this.host.bridgeRegistry.bridgeForSession(session)
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
    const owned = this.host.bridgeRegistry.sessionIdsOf(bridge)
    for (const controller of this.host.watchdog.turnStreams.values()) {
      if (controller.session === session) continue
      if (!owned.has(controller.session.sessionId)) continue
      if (lifecycleOf(controller.session) !== 'live') continue
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
    this.host.registry.forgetDshSession(session.sessionId)
    session.orphanPromptTurnSeq = undefined
    this.host.hub.broadcast({
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
  async reclaimChatPrompt(
    session: LiveSession,
    controller: TurnStreamController,
    signal?: AbortSignal,
  ): Promise<'ok' | 'aborted'> {
    if (lifecycleOf(session) !== 'live') return 'ok'
    if (!controller.hasSettled && hasPromptSlot(session)) {
      await this.host.bridgeRegistry.bridgeForSession(session).cancel(session)
      controller.abortActiveSegment()
    }
    return this.waitForSettleGate(session, signal)
  }

  /** 等 agent 侧 prompt slot 真正释放；步骤被取消时立即返回 aborted。 */
  waitForSettleGate(session: LiveSession, signal?: AbortSignal): Promise<'ok' | 'aborted'> {
    const pending = session.turnSlot?.promise
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
}