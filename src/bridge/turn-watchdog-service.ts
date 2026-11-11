/**
 * Turn watchdog + turn-stream index: the per-chat `TurnStreamController`
 * index (`turnStreams`), the stall scan timer (`stallTimer`) and the
 * force-finalize loop, plus the live-turn reads built on them
 * (`pendingPermissionViews` / `hasActiveTurns` / `activeTurnViews`), the
 * session burst aggregate and the tuning snapshots a controller reads once
 * at construction.
 *
 * Every manager capability arrives through {@link TurnWatchdogHost}, so this
 * module never imports `manager.ts` or `bridge.ts`. The manager keeps
 * same-named delegates and a getter onto the SAME Map instance, because
 * tests introspect it through the manager.
 */
import type { EventHub, PendingPermissionView } from '../impl.ts'
import type { ActiveTurnView } from '../protocol.ts'
import type { AgentBridge } from './agent-bridge.ts'
import type { LiveSession, TurnStreamController } from './turn-stream.ts'
import type { BridgeTuning } from './types.ts'

/**
 * The manager capabilities this service leans on. Every member is a callback
 * or a value, so the service holds no reference to `BridgeManager` itself.
 */
export interface TurnWatchdogHost {
  /** The host event stream the watchdog notice is published on. */
  readonly hub: EventHub
  /** Every live bridge, in registry order (the scan loop and the live-turn reads). */
  bridges(): Iterable<AgentBridge>
  /** The tuning object currently in force (owned by the manager, rewritten in place). */
  currentTuning(): Required<BridgeTuning>
  /** Rewrite `agents.json` after a session's burst aggregate changed. */
  persistAgents(): void
}

export class TurnWatchdogService {
  /**
   * The in-flight (or just-settled) segmented turn of one DSH chat session.
   * Keyed by chat session id because the continuation steps of a segmented
   * turn arrive as fresh `streamPrompt` calls that must find the SAME
   * controller — its transcript cursor, seen-call registry and turn facts are
   * what let them resume the prompt instead of re-sending it. An entry is
   * replaced by the conversation's next turn and removed on cancel, session
   * close/release, or agent stop.
   */
  readonly turnStreams = new Map<string, TurnStreamController>()

  /**
   * The stall watchdog's scan loop. Armed lazily at the first turn start and
   * DROPPED once nothing anywhere is running: a manager that never runs a turn
   * never holds a timer, and one that goes quiet does not keep the host awake.
   */
  private stallTimer?: ReturnType<typeof setInterval>

  constructor(private readonly host: TurnWatchdogHost) {}

  /** The segmented turn a continuation step of one chat session must resume. */
  turnStreamFor(dshSessionId: string): TurnStreamController | undefined {
    return this.turnStreams.get(dshSessionId)
  }

  /** Index a turn's controller, retiring whatever turn it supersedes. */
  rememberTurnStream(dshSessionId: string, controller: TurnStreamController): void {
    const previous = this.turnStreams.get(dshSessionId)
    if (previous !== undefined && previous !== controller) previous.dispose()
    this.turnStreams.set(dshSessionId, controller)
  }

  /** Drop a controller from the index (its own `dispose` calls back into this). */
  forgetTurnStream(controller: TurnStreamController): void {
    for (const [key, value] of this.turnStreams) {
      if (value === controller) this.turnStreams.delete(key)
    }
  }

  /** Tear down the turn streams of every session of one bridge (close/release/stop). */
  disposeTurnStreamsOf(match: (controller: TurnStreamController) => boolean): void {
    for (const [key, controller] of [...this.turnStreams]) {
      if (match(controller)) {
        controller.finishActive({ kind: 'aborted', failure: { message: 'session ended', code: 'SESSION_CLOSED' } })
        controller.dispose()
        this.turnStreams.delete(key)
      }
    }
  }

  armStallTimer(): void {
    // `turnStallMs === 0` disables the WHOLE watchdog — the base window is the
    // switch. `turnStallToolMs` cannot re-enable it: that number only widens
    // the window for a turn that already has a tool in flight.
    const tuning = this.host.currentTuning()
    if (tuning.turnStallMs <= 0 || this.stallTimer !== undefined) return
    const timer = setInterval(() => { this.reapStalledTurns() }, Math.max(1, tuning.turnStallTickMs))
    timer.unref?.()
    this.stallTimer = timer
  }

  /** Clear the stall watchdog's scan timer (host shutdown only). */
  disarmStallTimer(): void {
    if (this.stallTimer !== undefined) {
      clearInterval(this.stallTimer)
      this.stallTimer = undefined
    }
  }

  /**
   * Force-finalize turns the agent has gone silent in.
   *
   * "Silent" is scoped to the stretch where the AGENT owes the turn a word: a
   * running session with a segment on air and no pending ask. A turn waiting on
   * the host (tool cards executing between segments) or on a human (an
   * unanswered permission) is not stuck and is skipped.
   *
   * Firing does NOT kill the process (see `LiveSession.orphanPromptTurnSeq`):
   * the session, its transcript and its binding survive, and the next message
   * reclaims the process. The turn's streaming face ends through its own
   * controller when there is one, so the driver step on air closes with an
   * error instead of being torn down mid-stream.
   */
  private reapStalledTurns(): void {
    const now = Date.now()
    let anyRunning = false
    for (const bridge of this.host.bridges()) {
      for (const session of bridge.sessionList) {
        if (session.running) anyRunning = true
        if (!session.running || session.closed || session.released) continue
        // A question is on the table: the agent is waiting on a human, not
        // stuck, and that wait is the permission deadline's business.
        if (bridge.permissions.hasPendingFor(session.sessionId)) continue
        // The controller this turn is streaming through. A chat turn is indexed
        // by chat id (its continuation steps look it up that way) AND attached
        // to the session; an EPHEMERAL turn has no chat id and therefore only
        // the attachment — treating it as an `/acp` turn would finalize the
        // session state without closing the driver's segment queue.
        const indexed = session.dshSessionId === undefined ? undefined : this.turnStreams.get(session.dshSessionId)
        // An index hit only speaks for THIS session: a concurrent first turn
        // can have mapped another LiveSession under the same chat id.
        const attached = session.turnController
          ?? (indexed !== undefined && indexed.session === session ? indexed : undefined)
        // A controller from an EARLIER turn is stale the moment any newer turn
        // (e.g. an `/acp` prompt on the same chat) advances `turnSeq`: its
        // segment is already closed, `onAir` would read false, and the
        // watchdog would skip this turn forever. Treat it as absent.
        const live = attached !== undefined && !attached.stale ? attached : undefined
        // An `/acp`-RPC turn has no driver stream, so "on air" reads as true.
        const onAir = live === undefined ? true : live.hasOpenSegment
        if (!onAir) continue
        const tuning = this.host.currentTuning()
        const toolWindow = tuning.turnStallToolMs > 0 ? tuning.turnStallToolMs : tuning.turnStallMs
        const threshold = session.activeToolCalls.size > 0 ? toolWindow : tuning.turnStallMs
        if (now - session.lastAgentActivityAt < threshold) continue
        void bridge.cancel(session)
        session.orphanPromptTurnSeq = session.turnSeq
        const turnGen = session.turnSeq
        const message = `acp: agent "${session.agentId}" sent no activity for ${String(Math.round(threshold / 1000))}s; the stalled turn was force-finalized`
        // A provisional first turn that showed nothing is about to be rolled
        // back by `settle` (lock released, session closed), so the notice must
        // not promise a resume that will not happen.
        const willRollback = live !== undefined && live.session.provisionalLock === true && !live.sawVisibleBlock
        if (live !== undefined) live.settle({ kind: 'error', message, code: 'INACTIVITY_TIMEOUT' })
        else bridge.finalizeTurn(session, turnGen, message)
        // What the next message can do depends on the capability the agent
        // advertised at connect time, and on whether anyone else is using it.
        const capabilities = bridge.view().agentCapabilities as { loadSession?: boolean } | undefined
        const next = willRollback
          ? 'This was the conversation\'s first turn and it delivered nothing, so it was discarded; the next message starts a new ACP session.'
          : capabilities?.loadSession === true
            ? 'The next message will restart the agent and resume the session.'
            : 'The next message will reset the ACP session; this agent does not support session resume.'
        this.host.hub.broadcast({
          type: 'agent/notice',
          agentId: session.agentId,
          level: 'error',
          text: `${message} ${next} If another conversation is still using the agent, the next send may be refused until that turn finishes.`,
        })
      }
    }
    if (!anyRunning && this.stallTimer !== undefined) {
      clearInterval(this.stallTimer)
      this.stallTimer = undefined
    }
  }

  /**
   * Every outstanding ask, across all agents, with the view the browser was
   * shown it — the source of the reconnect replay (see
   * `permissionReplayFrames`). Every ACP ask is a ledger entry, so this is the
   * whole live set.
   */
  pendingPermissionViews(): PendingPermissionView[] {
    const views: PendingPermissionView[] = []
    for (const bridge of this.host.bridges()) views.push(...bridge.permissions.pendingViews())
    return views
  }

  /**
   * Whether any ACP work is in flight. An update install may restart the host,
   * so check/apply describe the host as busy while a turn is running.
   *
   * Segmented turn streams count even between steps (the host is still
   * continuing that turn); `running` / `settled` on a session covers `/acp`
   * turns and the window between a prompt and the agent's acknowledgement.
   */
  hasActiveTurns(): boolean {
    if (this.turnStreams.size > 0) return true
    for (const bridge of this.host.bridges()) {
      if (bridge.hasActiveTurn()) return true
    }
    return false
  }

  /**
   * The live ACP turns the save gate reports. Deduplicated by ACP session id
   * because a chat turn is indexed BOTH under its controller (segmented
   * continuation) and under the session's `running` flag.
   */
  activeTurnViews(): ActiveTurnView[] {
    const views = new Map<string, ActiveTurnView>()
    for (const controller of this.turnStreams.values()) {
      const session = controller.session
      views.set(session.sessionId, {
        sessionId: session.sessionId,
        agentId: session.agentId,
        ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
      })
    }
    for (const bridge of this.host.bridges()) {
      for (const session of bridge.sessionList) {
        if (!session.running && session.settled === undefined) continue
        views.set(session.sessionId, {
          sessionId: session.sessionId,
          agentId: session.agentId,
          ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
        })
      }
    }
    return [...views.values()]
  }

  /**
   * Fold one settled ACP turn's measurable burst into the session aggregate and
   * persist it. A turn with no measured inter-chunk gap contributes neither
   * side: adding its tokens with zero time would inflate the session rate.
   */
  noteSessionBurst(session: LiveSession, outputTokens: number, burstMs: number): void {
    if (outputTokens <= 0 || burstMs <= 0) return
    const base = session.burst ?? { outputTokens: 0, burstMs: 0 }
    session.burst = {
      outputTokens: base.outputTokens + outputTokens,
      burstMs: base.burstMs + burstMs,
    }
    this.host.persistAgents()
  }

  /**
   * The ambient windows a turn's controller reads once at construction (see
   * {@link BridgeTuning.ambientQuietMs}). Exposed as a plain snapshot so the
   * controller never pokes at the manager's tuning object, and tests can tune
   * the cadence through the constructor like every other window.
   */
  get ambientTuning(): { quietMs: number; maxMs: number } {
    const tuning = this.host.currentTuning()
    return {
      quietMs: tuning.ambientQuietMs,
      maxMs: tuning.ambientMaxMs,
    }
  }

  /**
   * The detached-worker hold's windows, read once at controller construction
   * for the same reason as {@link ambientTuning}: `taskMaxMs` is the worker
   * phase's SHORT silence window, `toolMaxMs` its long tier while the worker's
   * last known state is an open tool call (0 falls back to the short one), both
   * pushed out by every dispatch / worker update (see
   * {@link BridgeTuning.backgroundTaskMaxMs} /
   * {@link BridgeTuning.backgroundTaskToolMs}); `ceilingMs` their optional
   * absolute bound (0 = none) and `graceMs` the bounded wait a PARKED hold
   * gives the host to open its continuation step (see
   * {@link BridgeTuning.backgroundParkedGraceMs}). The drain phase reuses
   * {@link ambientTuning}.
   */
  get backgroundTuning(): { taskMaxMs: number; toolMaxMs: number; ceilingMs: number; graceMs: number } {
    const tuning = this.host.currentTuning()
    return {
      taskMaxMs: tuning.backgroundTaskMaxMs,
      toolMaxMs: tuning.backgroundTaskToolMs > 0 ? tuning.backgroundTaskToolMs : tuning.backgroundTaskMaxMs,
      ceilingMs: tuning.backgroundTaskCeilingMs,
      graceMs: tuning.backgroundParkedGraceMs,
    }
  }
}