/**
 * The conversation's ACP session wiring, lifted out of `AcpStore` (split plan
 * P3b): the `session/chat-list` read (in-flight dedup, forced re-reads, frame
 * replay), the agent-mode switch, the explicit resume, the host-then-plugin
 * branch, and the observed ACP transcript indexes the conversation's NTR view
 * renders.
 *
 * Three bookkeeping logs live here because this service is their only READER:
 * the chat-row lifecycle frames replayed over a late `session/chat-list`
 * answer, the `subagents/record` frames replayed over the same answer, and the
 * one-way agent-lock transition markers. The frames arrive from the event
 * pipeline, so the facade feeds them through the same narrow host methods the
 * store's own `applyEvent` used before the move.
 *
 * The service never imports the facade: `call` / `mutate` / the snapshot,
 * `flashError`, the locale resolver, the ACP-mode verdict ledger and the
 * optimistic-choice writer arrive through {@link ChatSessionsHost}, so the
 * broadcast and merge timing of every write is exactly the store's.
 */

import type { AcpConversationChoice, ChatSessionView, ChatTranscriptView, SessionView, SubagentRecord } from '../../protocol.ts'
import { foldUpdate, replayChatRowFrames, type Block } from './blocks.ts'
import type { ChatForkOutcome } from './fork.ts'
import type { ChatRowFrame, ChatTranscript, UiState } from './state.ts'
import { mergeSubagentSnapshot } from './subagent.ts'

/** How many observed ACP transcripts stay live at once (insertion-ordered eviction). */
const MAX_WATCHED = 6

/** What the chat-session service needs from the store, injected. */
export interface ChatSessionsHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
  /** Surface an action failure in the page notice line. */
  flashError(error: unknown): void
  /** The bilingual resolver (`zh` when Chinese is active). */
  locale(zh: string, en: string): string
  /**
   * The ACP-mode verdict ledger, which the store owns (its seat gate reads the
   * same entries). Grouped rather than flattened: one concern, three moves.
   */
  verdicts: {
    /** Whether a host read may settle this session (a `settleVerdict` ask, or no frame-settled verdict). */
    settleAllowed(dshSessionId: string, settleVerdict: boolean): boolean
    /** Fold a host answer in and return the projection the patch carries. */
    commit(dshSessionId: string, value: boolean): Record<string, boolean>
    /** Retract an unanswered ask marker so the gate asks again. */
    markUnsettled(dshSessionId: string): void
  }
  /** Teach the ACP-session→conversation map that scopes the live detail index. */
  noteAcpSessionOwners(dshSessionId: string, sessions: readonly ChatSessionView[]): void
  /** Record one optimistic pick (the conversation's single writer, `store/chat-choice.ts`). */
  writeChoice(dshSessionId: string, update: (choice: AcpConversationChoice) => AcpConversationChoice, agentId?: string): void
}

export class ChatSessionsService {
  /** In-flight `session/chat-list` reads, keyed by chat session id. */
  private readonly reads = new Map<string, { dropped: boolean; done: Promise<void> }>()
  /**
   * Monotonic order plus a short log of chat-row lifecycle frames. Read
   * starts capture the sequence; the answer replays every later frame over
   * its row list. Bounded — a read only needs the frames since it started, and
   * a page that never reconnects cannot grow this without bound.
   */
  private chatRowFrameSeq = 0
  private readonly chatRowFrames: ChatRowFrame[] = []
  /**
   * Chat sessions whose list has answered at least once in this page. The
   * FIRST answer only seeds the lock; a lock appearing on a later answer is a
   * transition this page actually witnessed, and only that one is announced via
   * `UiState.agentLockReveal`.
   */
  private readonly listLoaded = new Set<string>()
  /**
   * Conversations whose provisional first-turn lock the host rolled back
   * (`chat/agent-unlocked`, no visible output in the first turn). A
   * `session/chat-list` read that started BEFORE the rollback can still name
   * `lockedAgentId`; it must not revive the lock. A new `chat/agent-locked`
   * frame clears the entry (the user retried and the turn really started).
   */
  private readonly unlocked = new Set<string>()
  /**
   * Monotonic order plus a short log of applied `subagents/record` frames: a
   * `session/chat-list` answer can describe the host as of BEFORE a frame that
   * landed while the read was in flight, and the answer replays the later
   * frames over its snapshot.
   */
  private subagentRecordSeq = 0
  private readonly subagentRecordFrames: Array<{ seq: number; dshSessionId: string; record: SubagentRecord }> = []

  constructor(private readonly host: ChatSessionsHost) {}

  // ---- The chat-list read ----

  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   *
   * `settleVerdict` is the seat gate's own re-ask and the ONLY read allowed to
   * settle a verdict a frame had already settled (see `acpVerdicts` in
   * `store.ts`): the gate holds such a verdict as its only fact source while
   * the session row stays silent, and a host read is the one place a switch the
   * runtime never framed can still be learned from. Composer readers pass
   * nothing and keep the frame's authority.
   */
  loadChatSessions(dshSessionId: string, options?: { settleVerdict?: boolean; force?: boolean }): Promise<void> {
    // The composer entries (agent-mode control, ACP cluster, occupancy ring)
    // read this and re-read when a turn settles; one round-trip answers for
    // all of them instead of racing reads. A caller arriving mid-read waits
    // for THAT read rather than returning immediately: the slash source's
    // one-shot "do I have a verdict yet?" ask is only useful if it can
    // receive the answer of a read already in flight.
    //
    // `force` belongs to a caller that knows the host state JUST changed (a
    // turn started, an explicit resume finished, the stream reconnected). A
    // read that began before that change still names the old released row,
    // and the dedup above would otherwise hand this caller that stale answer.
    // Dropping it first makes this call ask the host again. The dropped read
    // still resolves for its own caller; `read.dropped` makes it write nothing.
    if (options?.force === true) this.abandonChatSessionRead(dshSessionId)
    const inFlight = this.reads.get(dshSessionId)
    if (inFlight !== undefined) return inFlight.done
    const read: { dropped: boolean; done: Promise<void> } = { dropped: false, done: Promise.resolve() }
    this.reads.set(dshSessionId, read)
    read.done = this.readChatSessionList(dshSessionId, options, read)
    return read.done
  }

  private async readChatSessionList(
    dshSessionId: string,
    options: { settleVerdict?: boolean; force?: boolean } | undefined,
    read: { dropped: boolean },
  ): Promise<void> {
    const settle = this.host.verdicts.settleAllowed(dshSessionId, options?.settleVerdict === true)
    // Captured BEFORE the request: every frame applied after this point is
    // newer than whatever state the host will answer with.
    const subagentRecordFramesAtRead = this.subagentRecordSeq
    const chatRowFramesAtRead = this.chatRowFrameSeq
    try {
      const { sessions: listed = [], acpMode, boundAgentId, lockedAgentId, choice } = await this.host.call<{ sessions: ChatSessionView[]; acpMode?: boolean; boundAgentId?: string; lockedAgentId?: string; choice?: AcpConversationChoice }>('session/chat-list', { dshSessionId, refresh: true })
      // The host answer can still describe the released row it had when this
      // read started. Replay the lifecycle frames that landed in the meantime:
      // a resume's `session/reset` flips the row back to live, a crash's
      // `session/released` parks it, a close drops it. Without this the late
      // answer overwrites the frame and the released banner survives a turn
      // that is already running on a live process.
      const sessions = replayChatRowFrames(listed, this.chatRowFrames, chatRowFramesAtRead)
      // A committed `agent-preset/selected` frame may have settled this
      // session's verdict while the read was in flight; the host answer then
      // describes the log as of BEFORE that switch and must not overwrite it.
      if (read.dropped) return
      // The first answer for a conversation only seeds what is already true: a
      // lock reported there belongs to an earlier page. A lock that appears on
      // a LATER answer is the first-turn transition unfolding in front of the
      // user, and only that one is announced to the hand-off animation.
      const firstAnswer = !this.listLoaded.has(dshSessionId)
      this.listLoaded.add(dshSessionId)
      // The lock is one-way, so a read that no longer reports one is an older
      // host half, not an unlock: keep what we already know in that case. The
      // one explicit unlock is the host's rollback frame, tracked separately.
      // A read that AGREES there is no lock clears the rollback marker, so a
      // later legitimate lock (even with its frame missed) is accepted again.
      if (lockedAgentId === undefined) this.unlocked.delete(dshSessionId)
      const reportedLock = lockedAgentId !== undefined && this.unlocked.has(dshSessionId)
        ? undefined
        : lockedAgentId
      const state = this.host.state()
      const chatLockedAgent = reportedLock === undefined
        ? state.chatLockedAgent
        : { ...state.chatLockedAgent, [dshSessionId]: reportedLock }
      const witnessedLock = !firstAnswer
        && reportedLock !== undefined
        && state.chatLockedAgent[dshSessionId] === undefined
      const agentLockReveal = witnessedLock
        ? { ...state.agentLockReveal, [dshSessionId]: (state.agentLockReveal[dshSessionId] ?? 0) + 1 }
        : state.agentLockReveal
      // The plugin's own lifecycle records: REPLACED for this conversation and
      // refreshed for every other one, then replayed over by the
      // `subagents/record` frames that landed while this read was in flight
      // (an in-flight terminal must beat an older snapshot row). Rows of this
      // conversation also teach the ACP-session→conversation map the live
      // detail index is scoped by.
      this.host.noteAcpSessionOwners(dshSessionId, sessions)
      const subagents = mergeSubagentSnapshot(
        state.subagents,
        dshSessionId,
        sessions,
        this.subagentRecordFrames,
        subagentRecordFramesAtRead,
      )
      this.host.mutate({
        chatSessions: sessions,
        chatSessionsFor: dshSessionId,
        chatLockedAgent,
        agentLockReveal,
        subagents,
        // The host's binding (intent + live-session fallback) outranks the
        // optimistic entry this store wrote on the click; a host without the
        // field (older half) simply leaves the optimistic value standing.
        ...(boundAgentId === undefined
          ? {}
          : { chatBoundAgent: { ...state.chatBoundAgent, [dshSessionId]: boundAgentId } }),
        // The persisted pick (model + thought level) — the host's record,
        // present before any ACP session exists. Merged over the optimistic
        // entry so a value a click just wrote is not erased by a read that
        // started before the click landed.
        ...(choice === undefined
          ? {}
          : { chatChoice: { ...state.chatChoice, [dshSessionId]: choice } }),
        // The seat gate's fallback fact source: absent on an older host half,
        // which then simply never takes the seat over (the allowed failure).
        // A frame-settled verdict outranks any read, whenever it lands: the
        // host's log read can lag a switch by one, and taking the model seat
        // re-mounts readers, so a stale answer would otherwise regress it.
        ...(acpMode === undefined || !settle
          ? {}
          : { acpMode: this.host.verdicts.commit(dshSessionId, acpMode === true) }),
      })
      // A read that answered but carried no verdict has NOT settled this
      // session. The gate's ask ledger is one-shot per id, so unless the id is
      // retracted here it stays marked "asked" forever and the gate never asks
      // again — one silent round-trip and the native model seat is permanent
      // for that session. The gate re-derives this from `hasAcpModeVerdict`
      // on its next evaluation (every store mutation re-runs it), which is
      // what makes the fallback recoverable instead of a single coin flip.
      if (acpMode === undefined && settle) {
        this.host.verdicts.markUnsettled(dshSessionId)
      }
    } catch {
      // A host without this surface (older build) has nothing to show; the
      // control simply renders nothing rather than an error nobody can act on.
      if (read.dropped) return
      this.host.mutate({ chatSessions: [], chatSessionsFor: dshSessionId })
      if (settle) {
        this.host.verdicts.markUnsettled(dshSessionId)
      }
    } finally {
      if (this.reads.get(dshSessionId) === read) this.reads.delete(dshSessionId)
    }
  }

  /**
   * Abandon the in-flight `session/chat-list` read for one session (or all of
   * them): a committed `agent-preset/selected` frame carries the authoritative
   * verdict, and the late answer to an ask that predates the frame describes
   * the log from before the switch — it must not land in the store.
   */
  abandonChatSessionRead(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      for (const read of this.reads.values()) read.dropped = true
      this.reads.clear()
      return
    }
    const read = this.reads.get(dshSessionId)
    if (read === undefined) return
    read.dropped = true
    this.reads.delete(dshSessionId)
  }

  // ---- Writes that follow the chat row ----

  /**
   * Switch the ACP agent's own mode for one chat session (`session/set_mode`),
   * then re-read the binding so the control reflects what the agent actually
   * reports (a rejected switch must not leave an optimistic lie on screen).
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    try {
      await this.host.call('session/chat-mode-set', { dshSessionId, modeId, ...(agentId === undefined ? {} : { agentId }) })
      const safeAgent = (agentId && agentId.trim()) || undefined
      this.host.writeChoice(dshSessionId, choice => ({ ...choice, mode: modeId }), safeAgent)
      const state = this.host.state()
      if (state.chatSessionsFor === dshSessionId) {
        const owner = safeAgent ?? state.chatChoice[dshSessionId]?.agentId ?? state.chatBoundAgent[dshSessionId] ?? state.defaultAgent
        let changed = false
        const chatSessions = state.chatSessions.map(s => {
          if (s.agentId !== owner || !s.modes || s.modes.currentModeId === modeId) return s
          changed = true
          return { ...s, modes: { ...s.modes, currentModeId: modeId } }
        })
        if (changed) this.host.mutate({ chatSessions })
      }
    } catch (error) {
      this.host.flashError(error)
    }
    await this.loadChatSessions(dshSessionId)
  }

  /**
   * Bring the conversation's released ACP session back on a fresh process —
   * the released banner's explicit form of the "next message resumes it"
   * promise (`session/chat-resume`). A failure is reported through the notice
   * AND rethrown (the `respondPermission` contract), so the banner can pin
   * the message beside the button the user just pressed; the binding is
   * re-read either way so the row follows the host's real answer.
   */
  async resumeChatSession(dshSessionId: string): Promise<void> {
    let failure: unknown
    try {
      await this.host.call('session/chat-resume', { dshSessionId })
    } catch (error) {
      this.host.flashError(error)
      failure = error
    }
    // `force`: the host answer this call needs is the one AFTER the resume.
    // The host's no-op branch (already live) broadcasts no frame at all, so
    // reusing a read that started before the click would keep the released row.
    await this.loadChatSessions(dshSessionId, { force: true })
    if (failure !== undefined) throw failure
  }

  /**
   * Branch one conversation (the NTR branch button's click): the fixed
   * two-stage order — the HOST forks the DSH session tree first (copied
   * history, `(1)` title, workspace), then the plugin adopts the ACP side via
   * `session/chat-fork-adopt`, which runs the agent's own `session/fork` so
   * the child actually remembers the parent context. Host first is structural:
   * ACP fork has no cut-point parameter and nothing to return to if the host
   * half failed second (see the plan's §D7).
   *
   * Resolves `{ childId }` on success, or `{ failure }` with one actionable
   * line — the reason is ALSO flashed into the notice banner (a user-action
   * failure, so the banner is its surface), and the local line is what the
   * conversation renders beside the button (the user is not on the settings
   * page). A failed adopt leaves the child an ordinary copied-history
   * conversation (its first message starts a fresh `session/new` — today's
   * behavior), never a half-bound one, and NOTHING is opened.
   *
   * `forkHost` is the runtime's `sessions.fork` face, resolved structurally by
   * the entry and injected here: the store stays transport-free.
   */
  async forkChatSession(
    dshSessionId: string,
    forkHost: (sessionId: string) => Promise<unknown>,
  ): Promise<ChatForkOutcome> {
    let childId: unknown
    try {
      childId = await forkHost(dshSessionId)
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      this.host.flashError(failure)
      return { failure }
    }
    if (typeof childId !== 'string' || childId === '') {
      const failure = this.host.locale(
        '宿主没有返回分支会话，分支未完成。',
        'The host returned no branched session; the branch did not complete.',
      )
      this.host.flashError(new Error(failure))
      return { failure }
    }
    try {
      await this.host.call('session/chat-fork-adopt', { dshSessionId: childId, parentDshSessionId: dshSessionId })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failure = this.host.locale(
        `分支会话已创建，但没有接上 agent 的上下文（${reason}）；在子会话里发送的第一条消息会开启全新会话。`,
        `The branched session was created but the agent context was not attached (${reason}); its first message will start a fresh session.`,
      )
      this.host.flashError(new Error(failure))
      return { failure }
    }
    return { childId }
  }

  // ---- ACP transcript observation (the conversation's ACP view) ----

  /**
   * Start (or refresh) observation of every ACP transcript behind one DSH chat
   * session. Blocks are rebuilt from scratch — the host buffer is the record,
   * and this view is the only consumer that needs the raw agent stream.
   */
  async loadChatTranscript(dshSessionId: string): Promise<void> {
    let views: ChatTranscriptView[]
    try {
      ({ views } = await this.host.call<{ views: ChatTranscriptView[] }>(
        'session/chat-transcript',
        { dshSessionId },
      ))
    } catch {
      // An older host half (or a session with no ACP binding): nothing to
      // observe, and no error worth flashing for a read-only side view.
      return
    }
    // Everything this chat session used to have, minus what it still has: a
    // closed or replaced ACP session must not linger as a ghost tab body.
    const merged: Record<string, ChatTranscript> = {}
    for (const [id, record] of Object.entries(this.host.state().chatTranscripts)) {
      if (record.owner !== dshSessionId) merged[id] = record
    }
    for (const view of views) {
      const blocks: Block[] = []
      for (const entry of view.entries) foldUpdate(blocks, entry.update as Record<string, unknown>)
      merged[view.session.sessionId] = {
        owner: dshSessionId,
        session: view.session,
        blocks,
        seq: view.entries.length > 0 ? view.entries[view.entries.length - 1]?.seq ?? 0 : 0,
      }
    }
    this.host.mutate({ chatTranscripts: this.evictTranscripts(merged) })
  }

  /** Observed transcript for one ACP session id (undefined → nobody is watching it). */
  transcriptOf(acpSessionId: string): ChatTranscript | undefined {
    return this.host.state().chatTranscripts[acpSessionId]
  }

  /** The observed transcript of one chat session (the live binding wins over a released one). */
  chatTranscriptOf(dshSessionId: string): ChatTranscript | undefined {
    const owned = Object.values(this.host.state().chatTranscripts).filter(record => record.owner === dshSessionId)
    return owned.find(record => !record.session.released) ?? owned[0]
  }

  /** Keep the resident transcript map at its bound, newest insertion first. */
  private evictTranscripts(map: Record<string, ChatTranscript>): Record<string, ChatTranscript> {
    const ids = Object.keys(map)
    if (ids.length <= MAX_WATCHED) return map
    const out: Record<string, ChatTranscript> = {}
    for (const id of ids.slice(ids.length - MAX_WATCHED)) {
      const value = map[id]
      if (value !== undefined) out[id] = value
    }
    return out
  }

  /** Re-publish an observed transcript's session snapshot (mode / released flips). */
  watchedSessionPatch(sessionId: string, session: SessionView): { chatTranscripts?: Record<string, ChatTranscript> } {
    const current = this.host.state().chatTranscripts[sessionId]
    if (current === undefined) return {}
    return { chatTranscripts: { ...this.host.state().chatTranscripts, [sessionId]: { ...current, session } } }
  }

  /** Mirror the running flag onto a transcript the ACP view is showing. */
  markWatchedRunning(sessionId: string, running: boolean): void {
    const current = this.host.state().chatTranscripts[sessionId]
    if (current === undefined || current.session.running === running) return
    this.host.mutate({
      chatTranscripts: {
        ...this.host.state().chatTranscripts,
        [sessionId]: { ...current, session: { ...current.session, running } },
      },
    })
  }

  // ---- Frame logs fed by the event pipeline ----

  /**
   * One chat-row lifecycle frame, recorded in arrival order. A bounded log is
   * enough: a `session/chat-list` read only needs the frames since it started.
   */
  noteChatRowFrame(sessionId: string, kind: ChatRowFrame['kind']): void {
    this.chatRowFrameSeq += 1
    this.chatRowFrames.push({ seq: this.chatRowFrameSeq, sessionId, kind })
    if (this.chatRowFrames.length > 256) this.chatRowFrames.shift()
  }

  /** The host locked a conversation at the start of its first ACP turn: the rollback marker is spent. */
  noteAgentLocked(dshSessionId: string): void {
    this.unlocked.delete(dshSessionId)
  }

  /** The host rolled a provisional lock back: a read that predates this must not revive it. */
  noteAgentUnlocked(dshSessionId: string): void {
    this.unlocked.add(dshSessionId)
  }

  /** One `subagents/record` frame, logged for the chat-list replay (see {@link subagentRecordFrames}). */
  noteSubagentRecord(dshSessionId: string, record: SubagentRecord): void {
    this.subagentRecordSeq += 1
    this.subagentRecordFrames.push({ seq: this.subagentRecordSeq, dshSessionId, record })
    if (this.subagentRecordFrames.length > 256) this.subagentRecordFrames.shift()
  }
}