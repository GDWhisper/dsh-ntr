/**
 * Chat-session registry: which ACP sessions exist for which DSH chat session,
 * which agent each conversation is bound to, and the first-turn lock.
 *
 * Three duties share one owner because they are the same state seen from three
 * angles:
 * - the session records (`dshSessionMap`), keyed `${dshSessionId|ephemeral}:${agentId}`,
 *   serialized as `agents.json`'s `chatSessions` and read back as parked rows;
 * - the conversation↔agent picks (`chatAgentIntent`), serialized as
 *   `agents.json`'s `conversations` — the plugin's OWN mapping, never a DSH
 *   model route (see `bindChatAgent`);
 * - the first-turn lock that makes a conversation belong to one agent once it
 *   has exchanged context (`lockChatAgent` / `rollbackFirstTurn`).
 *
 * Splitting them would let the three write paths drift: the lock is persisted
 * with the pick, the pick decides the session key, and every list the browser
 * reads is filtered from the record map.
 *
 * The manager keeps the process table, the session start / resume / retry
 * flows and the persistence file; every capability arrives through
 * {@link SessionRegistryHost}, so this module never imports `manager.ts` or
 * `bridge.ts`.
 */
import type { EventHub } from '../impl.ts'
import { AcpError } from '../impl.ts'
import type {
  AcpAgentDef,
  AcpConversationChoice,
  ChatSessionView,
  ChatTranscriptView,
  SubagentRecord,
} from '../protocol.ts'
import type { PersistedChatSession } from './types.ts'
import { isPerSessionAgent } from './identity.ts'
import { forkRowInfo, persistedChatSession, snapshot } from './shape.ts'
import type { LiveSession } from './turn-stream.ts'

/** The subagent rows the chat-session view attaches and the close paths drop. */
export interface SessionRegistrySubagents {
  /** The conversation's external-worker records, attached to every row as-is. */
  recordsFor(dshSessionId: string): readonly SubagentRecord[] | undefined
  /** Destroy a conversation's records when its last ACP session goes away. */
  forget(dshSessionId: string): void
}

/**
 * The manager capabilities this service leans on. Every member is a callback
 * or a getter so the service holds no reference to `BridgeManager` itself.
 *
 * Two members are deliberately composite, because a caller must never see a
 * half-applied step:
 * - {@link forkSession} mints the agent-side child session on the agent's own
 *   process (the manager resolves which holder to use);
 * - {@link closeSessionHolder} closes a dropped record's ACP session and then
 *   prunes the holder that owned it, in ONE step — a rollback must never route
 *   to another process and must never create one.
 */
export interface SessionRegistryHost {
  /** The host event stream the lock frames and session meta are published on. */
  readonly hub: EventHub
  /** The configured definition, or `undefined` when the registry does not own the id. */
  defOf(agentId: string): AcpAgentDef | undefined
  /** The plugin's own external-worker records (see {@link SessionRegistrySubagents}). */
  readonly subagents: SessionRegistrySubagents
  /** Whether the agent's last-known / live capability advertises `session/fork`. */
  canForkNow(agentId: string): boolean
  /**
   * Run the agent's own `session/fork` of `parent` for the child conversation.
   * The manager picks the process; a per-session agent is refused by the
   * caller BEFORE this runs.
   */
  forkSession(agentId: string, parent: LiveSession, childDshSessionId: string): Promise<LiveSession>
  /** Record one field of a conversation's pick and persist it (single write path). */
  patchChatChoice(dshSessionId: string, patch: Partial<AcpConversationChoice>): void
  /** Re-apply a conversation's recorded pick to a freshly created / forked session. */
  applyChatChoice(session: LiveSession): Promise<void>
  /** Put a conversation's pick back on the request path after a lock rollback. */
  syncConversationRoute(dshSessionId: string): void
  /** Rewrite `agents.json` after a record or pick changed. */
  persistAgents(): void
  /**
   * Close a record's ACP session and drop its holder once the close settles.
   * Uses the session's OWN holder (never `bridgeFor`): the agent may have been
   * deleted while its first turn was failing, and a rollback must never throw
   * or route a session to another process.
   */
  closeSessionHolder(session: LiveSession): void
}

/**
 * The DSH session registry, the conversation↔agent binding and the first-turn
 * lock, lifted out of `BridgeManager` as one cluster.
 */
export class SessionRegistryService {
  /**
   * The ACP session records, keyed `${dshSessionId ?? 'ephemeral'}:${agentId}`.
   * Insertion order IS the order every list publishes (the map is never
   * re-sorted), which is why the views iterate it directly instead of copying
   * it into an array first.
   */
  private readonly dshSessionMap = new Map<string, LiveSession>()
  /**
   * What each DSH chat session has chosen for its ACP agent — the agent itself
   * plus the agent's model and thought level. Persisted with the agent registry
   * (`conversations`), so the pick survives a host restart and is readable
   * before the conversation has ever run a turn. This is the plugin's own
   * conversation↔agent mapping, never a DSH model route (see `bindChatAgent`).
   */
  private readonly chatAgentIntent = new Map<string, AcpConversationChoice>()

  constructor(private readonly host: SessionRegistryHost) {}

  /**
   * The persisted pick map, shared BY REFERENCE with `ChatChoiceService`:
   * that service owns the single write path (`patchChatChoice`), this one
   * serializes the map with `agents.json` and reads it for the lock helpers.
   */
  get picks(): Map<string, AcpConversationChoice> {
    return this.chatAgentIntent
  }

  // ---- Record-map access for the manager's start / resume / persist flows ----

  /** Every record, in map order (a read-only view). */
  sessions(): Iterable<LiveSession> {
    return this.dshSessionMap.values()
  }

  /** The records of ONE conversation that are still alive (a closed one is destroyed). */
  sessionsOf(dshSessionId: string): LiveSession[] {
    const out: LiveSession[] = []
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId === dshSessionId && !session.closed) out.push(session)
    }
    return out
  }

  /** The record a start / resume / stalled-turn lookup addresses. */
  sessionAt(dshSessionId: string | undefined, agentId: string): LiveSession | undefined {
    return this.dshSessionMap.get(this.keyOf(dshSessionId ?? 'ephemeral', agentId))
  }

  /** Index a freshly created / restored / forked record under its own identity. */
  putSession(session: LiveSession): void {
    this.dshSessionMap.set(this.keyOf(session.dshSessionId ?? 'ephemeral', session.agentId), session)
  }

  /** Drop every record of one agent (the stop / delete path); returns their ACP session ids. */
  dropSessionsOfAgent(agentId: string): string[] {
    const dropped: string[] = []
    for (const [key, session] of this.dshSessionMap) {
      if (session.agentId !== agentId) continue
      dropped.push(session.sessionId)
      this.dshSessionMap.delete(key)
    }
    return dropped
  }

  /** The `chatSessions` half of `agents.json`: live records that belong to a DSH conversation. */
  persistedRows(): PersistedChatSession[] {
    const rows: PersistedChatSession[] = []
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId === undefined || session.closed) continue
      rows.push(persistedChatSession(session))
    }
    return rows
  }

  /** The `conversations` half of `agents.json`, or undefined when nothing was ever picked. */
  persistedConversations(): Record<string, AcpConversationChoice> | undefined {
    return this.chatAgentIntent.size === 0 ? undefined : Object.fromEntries(this.chatAgentIntent)
  }

  /** Every conversation the pick map knows (restore / prune walks). */
  choiceKeys(): Iterable<string> {
    return this.chatAgentIntent.keys()
  }

  /** Whether a conversation was ever bound (its pick exists, locked or not). */
  hasChoice(dshSessionId: string): boolean {
    return this.chatAgentIntent.has(dshSessionId)
  }

  /** Restore one persisted pick (tolerant loader; see `loadPersistedChoices`). */
  setChoice(dshSessionId: string, choice: AcpConversationChoice): void {
    this.chatAgentIntent.set(dshSessionId, choice)
  }

  private keyOf(dshSessionId: string, agentId: string): string {
    return `${dshSessionId}:${agentId}`
  }

  // ---- Chat-session views ----

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
    const subagents = this.host.subagents.recordsFor(dshSessionId)
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.closed) continue
      const title = this.host.defOf(session.agentId)?.title
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
        ...forkRowInfo(session, this.host.canForkNow(session.agentId)),
      })
    }
    return out
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

  // ---- Fork adoption (the fourth session-creation point) ----

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
    const childKey = this.keyOf(childDshSessionId, agentId)
    if (this.dshSessionMap.has(childKey)) {
      throw new AcpError('id_conflict', 'acp: the forked conversation is already bound to an ACP session')
    }
    // Capability gate BEFORE any request: an agent that never advertised
    // `session/fork` must not be asked (it would answer an unknown-method
    // error at best). Live init wins, last-known falls back — the same
    // verdict the browser's row already showed.
    if (!this.host.canForkNow(agentId)) {
      throw new AcpError('fork_unsupported', `acp: agent "${agentId}" does not advertise the session/fork capability`)
    }
    const session = await this.host.forkSession(agentId, parent, childDshSessionId)
    // The fork answered — the child is real on the agent side. From here the
    // binding is written through the SAME paths as any chat session: one
    // choice record (a copy of the parent's, locked — a branched conversation
    // belongs to its agent from birth), the route pin, and persistence.
    this.dshSessionMap.set(childKey, session)
    const parentChoice = this.chatAgentIntent.get(parentDshSessionId)
    this.host.patchChatChoice(childDshSessionId, {
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
    await this.host.applyChatChoice(session)
    // Re-publish so the browser's list and the composer's occupancy ring see
    // the child immediately (with its just-bound choice mirrors).
    this.host.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
    this.host.persistAgents()
    return { sessionId: session.sessionId, acpSessionId: session.acpSessionId }
  }

  // ---- Conversation ↔ agent binding ----

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
    if (this.host.defOf(agentId) === undefined) {
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
    this.host.patchChatChoice(dshSessionId, { agentId })
  }

  /** The ACP agent a chat session was last pointed at, when one is known. */
  chatAgentFor(dshSessionId: string): string | undefined {
    const recorded = this.chatAgentIntent.get(dshSessionId)?.agentId
    if (recorded !== undefined && this.host.defOf(recorded) !== undefined) return recorded
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
  lockChatAgent(dshSessionId: string, agentId: string): boolean {
    const current = this.chatAgentIntent.get(dshSessionId)
    if (current?.locked === true && current.agentId === agentId) return false
    const newlyLocked = current?.locked !== true
    this.host.patchChatChoice(dshSessionId, { agentId, locked: true })
    if (newlyLocked) {
      this.host.hub.broadcast({ type: 'chat/agent-locked', dshSessionId, agentId })
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
  rollbackFirstTurn(session: LiveSession): void {
    session.provisionalLock = false
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const current = this.chatAgentIntent.get(dshSessionId)
    if (current?.locked === true && current.agentId === session.agentId) {
      const next: AcpConversationChoice = { ...current }
      delete next.locked
      this.chatAgentIntent.set(dshSessionId, next)
      this.host.persistAgents()
      // Keep the request-path binding on the picked agent: it is still what
      // the base shows and what an unchanged retry should run.
      this.host.syncConversationRoute(dshSessionId)
      this.host.hub.broadcast({ type: 'chat/agent-unlocked', dshSessionId })
    }
    // Drop the chat-keyed record BEFORE the asynchronous agent-side close: the
    // browser's very next `session/chat-list` must not see this session.
    this.forgetDshSession(session.sessionId)
    this.host.closeSessionHolder(session)
  }

  // ---- Record removal ----

  /** Drop every chat-keyed record pointing at one host session (close/stop paths). */
  forgetDshSession(sessionId: string): void {
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
      if (!stillOwned) this.host.subagents.forget(dshSessionId)
    }
    // The disk record goes with it: a closed session is destroyed, not parked,
    // and must not come back on the next boot (constraint 10).
    if (dropped) this.host.persistAgents()
  }
}
