/**
 * Archive-release cluster: what an archived DSH conversation still owes, how to
 * stop it, and how to park its agent sessions without losing them.
 *
 * The host's archiving waterfalls call into `BridgeManager`; the manager keeps
 * the public method names and delegates here (see the thin-delegate section in
 * `manager.ts`). Every capability arrives as a closure, so this service never
 * imports the manager.
 */
import type { AgentBridge } from './agent-bridge.ts'
import type { LiveSession, TurnStreamController } from './turn-stream.ts'

/** What the archive-release service needs from the bridge manager, injected. */
export interface ArchiveReleaseDeps {
  /** The session registry's per-conversation lookup. */
  registry: { sessionsOf(dshSessionId: string): LiveSession[] }
  /** The turn-stream controller currently indexed for one chat session. */
  turnStreamFor(dshSessionId: string): TurnStreamController | undefined
  /** The bridge holding one session, or `undefined` when nothing does. */
  bridgeOwning(agentId: string, sessionId: string): AgentBridge | undefined
  /** Tear down the turn streams a predicate matches (close / release / stop). */
  disposeTurnStreamsOf(match: (controller: TurnStreamController) => boolean): void
}

/** Archive facts, cancellation and process parking for one conversation. */
export class ArchiveReleaseService {
  constructor(private readonly deps: ArchiveReleaseDeps) {}

  /**
   * The ACP sessions of one DSH conversation that are doing work right now —
   * the fact source of the host's `workspace/session-activity` waterfall.
   *
   * Deduplicated by ACP session id because the turn-stream controller and the
   * registry record name the SAME session from two angles. An idle live
   * session is NOT activity (a conversation the user merely left open owes
   * nothing); a turn in flight, a settle gate the agent has not opened, a
   * prompt the agent has not answered and an unanswered permission ask are.
   */
  archiveActivityFacts(dshSessionId: string): { acpSessionId: string }[] {
    const facts = new Map<string, { acpSessionId: string }>()
    const controller = this.deps.turnStreamFor(dshSessionId)
    // A settled controller can stay indexed for a continuation step its cards
    // may still owe; that window is NOT activity (the same distinction the
    // stalled-turn watchdog makes). A stale one belongs to a superseded turn.
    if (controller !== undefined && !controller.stale && !controller.hasSettled) {
      facts.set(controller.session.acpSessionId, { acpSessionId: controller.session.acpSessionId })
    }
    for (const session of this.deps.registry.sessionsOf(dshSessionId)) {
      if (session.closed) continue
      const active = session.running
        || session.settled !== undefined
        || session.promptInFlight === true
        || this.deps.bridgeOwning(session.agentId, session.sessionId)?.permissions.hasPendingFor(session.sessionId) === true
      if (!active) continue
      facts.set(session.acpSessionId, { acpSessionId: session.acpSessionId })
    }
    return [...facts.values()]
  }

  /**
   * Stop whatever is running on one archived conversation, without waiting for
   * the agent to acknowledge it: archiving must not be held open by a turn the
   * agent already stopped listening to. The normal cancel pipeline (agent
   * notification, permission settlement, cancel fallback) runs behind it, so
   * the session is not left wedged in `running`.
   */
  cancelArchivedSession(dshSessionId: string): void {
    for (const session of this.deps.registry.sessionsOf(dshSessionId)) {
      if (session.released || session.closed) continue
      const bridge = this.deps.bridgeOwning(session.agentId, session.sessionId)
      if (bridge === undefined) continue
      // A quiet conversation owes no turn: sending `session/cancel` there would
      // arm the cancel fallback for a turn that never started.
      const active = session.running
        || session.settled !== undefined
        || session.promptInFlight === true
        || bridge.permissions.hasPendingFor(session.sessionId)
      if (!active) continue
      void bridge.cancel(session)
    }
  }

  /**
   * Park one archived conversation's agent sessions and release their
   * processes.
   *
   * WHY `releaseAll`: an archive is a PARK, not a destroy — the session keeps
   * its record and its transcript, and the next message resumes it through
   * `session/load` on a fresh child. That is exactly what an idle release
   * does, so reusing it keeps one parking path instead of a second teardown
   * that could forget to settle permissions or persist the records.
   *
   * WHY `busy` keeps the pending state: a release while a turn, a permission
   * ask or an unanswered prompt is outstanding would kill the process that
   * owns exactly that work, so the conversation would be archived with its
   * last turn lost. Reporting `busy` lets the host retry later instead.
   *
   * Synchronous by contract (a waterfall calls it inline) and never throws:
   * an internal failure reads as `busy`, the conservative answer.
   */
  releaseArchivedSession(dshSessionId: string): 'released' | 'busy' | 'none' | 'unsupported' {
    try {
      const records = this.deps.registry.sessionsOf(dshSessionId)
      if (records.length === 0) return 'none'
      const bridges = new Set<AgentBridge>()
      for (const session of records) {
        // A parked record has nothing left to release; only live ones name a
        // process whose teardown this call has to decide.
        if (session.released) continue
        const bridge = this.deps.bridgeOwning(session.agentId, session.sessionId)
        if (bridge !== undefined) bridges.add(bridge)
      }
      // Every record already parked (or its holder gone): the archive costs
      // nothing and the answer is the same one a release would give.
      if (bridges.size === 0) return 'released'
      let busy = false
      let unsupported = false
      for (const bridge of bridges) {
        // A child still starting (or one that failed to start) has no
        // `initResult` yet: its `loadSession` support is unknown, not absent.
        // Report busy so a later event retries once that verdict exists.
        if (bridge.state !== 'ready') {
          busy = true
          continue
        }
        if (bridge.canReleaseForArchive()) {
          // The conversation's turn streams die with the process they are
          // riding: a continuation step arriving after the park must not
          // resume a turn whose agent is gone.
          this.deps.disposeTurnStreamsOf(controller => controller.session.dshSessionId === dshSessionId)
          bridge.releaseAll('archived chat session', 'archived')
          continue
        }
        // No `session/load` means the park would lose the conversation, so the
        // session cannot be archived at all.
        if (!bridge.supportsSessionLoad()) unsupported = true
        // The agent CAN reload it but work is outstanding: the process still
        // owns something a teardown would destroy.
        else busy = true
      }
      if (busy) return 'busy'
      if (unsupported) return 'unsupported'
      return 'released'
    } catch {
      // Nothing to log here: the manager holds no logger, and the host only
      // needs the conservative verdict.
      return 'busy'
    }
  }
}
