/**
 * Antigravity subagent transcript polling (task 2 of
 * docs/plan/antigravity-subagent-panel.md).
 *
 * agy's wire reports NO subagent lifecycle after the creation result: the
 * child works in its OWN brain transcript while the parent transcript stays
 * silent, and completion lands as a `SYSTEM_MESSAGE` report in the PARENT
 * transcript (authoritative) plus the child's LAST `PLANNER_RESPONSE` DONE
 * (fallback, gated: the DONE planner must be the newest step and the
 * transcript quiet for `agyLateOutputQuietMs` — intermediate DONE replies
 * exist). This service arms one read-only watch per session with pending
 * agy dispatches, tails each running child's transcript (activity, counters,
 * open tool steps, the DONE fallback) and the parent transcript (reports),
 * and drives the dispatch records to their terminal states.
 *
 * It NEVER closes a turn, kills a process or alters `running`: past the
 * silence windows a dispatch ends `unknown` and stops pinning the idle
 * release — the SAME two-tier windows `hasPendingBackgroundWork` reads, not a
 * third idle-based force-finalize (constraint 23). Timers are unref'd; every
 * read is fail-open; a missing transcript file never builds a tail.
 */
import { existsSync } from 'node:fs'
import {
  AgyTranscriptTail,
  agyChildProgress,
  agyTranscriptPaths,
  foldAgyOpenToolSteps,
  isAgyChildReport,
  type TranscriptStep,
} from './agy-transcript.ts'
import { dispatchWithinWindows } from './turn-stream.ts'
import type { LiveSession } from './turn-stream.ts'
import type { BackgroundDispatch, BridgeTuning } from './types.ts'

/** The external capabilities the poll needs (manager closures, no import back). */
export interface AgySubagentPollWiring {
  /** Antigravity's store root for the session's agent, or `undefined`. */
  storeRoot(session: LiveSession): string | undefined
  /** The live tuning object (the poll cadence reuses `agyLateOutputPollMs`). */
  tuning(): Required<BridgeTuning>
  /**
   * The idle clock's two-tier silence windows — the SAME `silenceWindowsOf`
   * derivation `AgentBridge` reads (`backgroundTaskToolMs`, `0` → plain tier).
   */
  silenceWindows(): { silenceMs: number; openToolCeilingMs: number }
}

/** What the poll service needs from its owning service, injected. */
export interface AgySubagentPollDeps extends AgySubagentPollWiring {
  /** Write one dispatch's terminal state, announce + persist (one transition). */
  terminalize(session: LiveSession, toolCallId: string, status: 'completed' | 'unknown'): void
  /** Memory-only record refresh while the child keeps working (no persist). */
  noteActivity(session: LiveSession, dispatch: BackgroundDispatch): void
}

/** One child's tail plus the fallback evidence carried across batches. */
interface ChildWatch {
  readonly tail: AgyTranscriptTail
  lastPlanner?: TranscriptStep
  /** Newest step index of ANY type seen so far (the DONE candidate's "last" gate). */
  lastStepIndex: number
  /** When the child transcript last grew (the DONE candidate's quiet gate). */
  lastNewStepAt?: number
}

/** One armed session watch; at most one per LiveSession. */
interface SessionWatch {
  readonly session: LiveSession
  /** Resolved once at arm; `undefined` means no transcript can be named. */
  readonly storeRoot?: string
  parentTail?: AgyTranscriptTail
  readonly children: Map<string, ChildWatch>
  pollTimer?: ReturnType<typeof setInterval>
  /** Cleared by disarm so a late tick can never touch a new state. */
  finished: boolean
  /** The session's `stopAgyPoll` target; teardown disarms exactly this watch. */
  stop: () => void
}

export class AgySubagentPollService {
  private readonly watches = new Map<string, SessionWatch>()

  constructor(private readonly deps: AgySubagentPollDeps) {}

  /**
   * Number of armed watches. Observability ONLY (tests prove a terminal
   * dispatch or a teardown really withdrew its watch).
   */
  get armedCount(): number {
    return this.watches.size
  }

  /**
   * Ensure a watch for one LIVE dispatch (idempotent; the tracker calls it at
   * creation and on every later non-terminal frame). A child tail is built
   * only when its transcript file EXISTS — a missing file may appear later,
   * and a later call retries.
   */
  arm(session: LiveSession, dispatch: BackgroundDispatch): void {
    if (session.closed || session.released) return
    if (dispatch.terminal !== undefined) return
    let watch = this.watches.get(session.sessionId)
    if (watch === undefined) {
      const created: SessionWatch = {
        session,
        storeRoot: this.deps.storeRoot(session),
        children: new Map(),
        finished: false,
        stop: () => { this.disarmWatch(created) },
      }
      const pollMs = Math.max(1, this.deps.tuning().agyLateOutputPollMs)
      const timer = setInterval(() => { this.tick(created) }, pollMs)
      timer.unref?.()
      created.pollTimer = timer
      watch = created
      this.watches.set(session.sessionId, created)
      session.stopAgyPoll = created.stop
    }
    this.ensureChildTail(watch, dispatch)
  }

  /** Stop this session's watch, if any. Idempotent; safe from a teardown. */
  disarm(session: LiveSession): void {
    const watch = this.watches.get(session.sessionId)
    if (watch !== undefined) this.disarmWatch(watch)
    else if (session.stopAgyPoll !== undefined) session.stopAgyPoll = undefined
  }

  /** After a terminalize batch: drop finished children, stop when nothing lives. */
  prune(session: LiveSession): void {
    const watch = this.watches.get(session.sessionId)
    if (watch !== undefined) this.reconcile(watch)
  }

  /** One poll: child activity, parent reports, the silence ceiling. Fail-open. */
  private tick(watch: SessionWatch): void {
    if (watch.finished) return
    const session = watch.session
    // Identity guard (constraint 11): a released / closed session's watch is
    // over — the resume builds a NEW process whose dispatches start fresh,
    // and the old ones were terminalized by the teardown that parked it.
    if (session.closed || session.released) {
      this.disarmWatch(watch)
      return
    }
    const live = this.liveDispatches(session)
    if (live.length === 0) {
      this.disarmWatch(watch)
      return
    }
    const now = Date.now()
    const quietMs = Math.max(0, this.deps.tuning().agyLateOutputQuietMs)
    // 1. Child transcripts: activity, counters, open tool steps, DONE fallback.
    for (const dispatch of live) {
      if (dispatch.terminal !== undefined) continue
      const child = this.ensureChildTail(watch, dispatch)
      if (child === undefined) continue
      const steps = child.tail.readNew()
      if (steps.length > 0) {
        child.lastNewStepAt = now
        dispatch.lastActivityAt = now
        dispatch.counts.updates += steps.length
        for (const step of steps) {
          dispatch.counts.toolCalls += step.toolCallCount ?? 0
          dispatch.counts.textChars += step.content.length + (step.thinking?.length ?? 0)
        }
        foldAgyOpenToolSteps(dispatch.openWorkerToolCalls ??= new Map<string, number>(), steps, now)
      }
      const progress = agyChildProgress(steps, child.lastPlanner, child.lastStepIndex)
      child.lastPlanner = progress.lastPlanner
      child.lastStepIndex = progress.lastStepIndex
      // The fallback is the child's LAST planner response, not the latest seen
      // so far: intermediate DONE replies exist (the late-output watch reads
      // the same append-only format). Fire only while the DONE planner is
      // still the NEWEST step AND the transcript has been quiet for the whole
      // window — a newer step of any kind disarms it until the child finishes.
      if (progress.done && now - (child.lastNewStepAt ?? now) >= quietMs) {
        this.deps.terminalize(session, dispatch.toolCallId, 'completed')
        continue
      }
      if (steps.length > 0) this.deps.noteActivity(session, dispatch)
    }
    // 2. Parent reports: the AUTHORITATIVE signal for children still running
    //    (a child whose file never appeared can still complete this way).
    const parentTail = this.ensureParentTail(watch)
    if (parentTail !== undefined) {
      for (const step of parentTail.readNew()) {
        if (step.type !== 'SYSTEM_MESSAGE') continue
        for (const dispatch of live) {
          // A terminal row is history: the second signal of the same finish
          // (both may land in one tick) never counts a completion twice.
          if (dispatch.terminal !== undefined) continue
          const childId = dispatch.childConversationId
          if (childId !== undefined && isAgyChildReport(step, childId)) {
            this.deps.terminalize(session, dispatch.toolCallId, 'completed')
          }
        }
      }
    }
    // 3. The silence ceiling: the SAME two-tier window the idle clock reads.
    //    Past it the dispatch ends `unknown` and stops pinning the process —
    //    never a turn force-finalize, never a kill (constraint 23).
    const windows = this.deps.silenceWindows()
    for (const dispatch of live) {
      if (dispatch.terminal !== undefined) continue
      if (!dispatchWithinWindows(dispatch, windows.silenceMs, windows.openToolCeilingMs, now)) {
        this.deps.terminalize(session, dispatch.toolCallId, 'unknown')
      }
    }
    this.reconcile(watch)
  }

  /** The dispatches a teardown has not ended yet (pending included). */
  private liveDispatches(session: LiveSession): BackgroundDispatch[] {
    const dispatches = session.agyDispatches
    if (dispatches === undefined) return []
    return [...dispatches.values()].filter(dispatch => dispatch.terminal === undefined)
  }

  /**
   * One child's tail, built only on an EXISTING file (the late-output
   * discipline). It reads from the BEGINNING, not a baseline: the whole child
   * transcript is THIS dispatch's own evidence, so a child that finished
   * before its creation result landed is still caught — nothing here is
   * "history" the way the parent's session-wide transcript is.
   */
  private ensureChildTail(watch: SessionWatch, dispatch: BackgroundDispatch): ChildWatch | undefined {
    const existing = watch.children.get(dispatch.toolCallId)
    if (existing !== undefined) return existing
    const childId = dispatch.childConversationId
    if (childId === undefined || watch.storeRoot === undefined) return undefined
    const path = agyTranscriptPaths(watch.storeRoot, childId).find(candidate => existsSync(candidate))
    if (path === undefined) return undefined
    const child: ChildWatch = { tail: new AgyTranscriptTail(path), lastStepIndex: 0 }
    watch.children.set(dispatch.toolCallId, child)
    return child
  }

  /**
   * The session's parent tail, also from the beginning: a report written
   * before this watch armed must still match, and `sender` matching is exact,
   * so older reports of OTHER children never fire on this one.
   */
  private ensureParentTail(watch: SessionWatch): AgyTranscriptTail | undefined {
    if (watch.parentTail !== undefined) return watch.parentTail
    if (watch.storeRoot === undefined) return undefined
    const path = agyTranscriptPaths(watch.storeRoot, watch.session.acpSessionId).find(candidate => existsSync(candidate))
    if (path === undefined) return undefined
    watch.parentTail = new AgyTranscriptTail(path)
    return watch.parentTail
  }

  /** Drop children whose dispatch ended; stop the watch when nothing lives. */
  private reconcile(watch: SessionWatch): void {
    const live = this.liveDispatches(watch.session)
    for (const id of [...watch.children.keys()]) {
      if (!live.some(dispatch => dispatch.toolCallId === id)) watch.children.delete(id)
    }
    if (live.length === 0) this.disarmWatch(watch)
  }

  /** Clear the timer and forget the record; safe to call twice. */
  private disarmWatch(watch: SessionWatch): void {
    if (watch.finished) return
    watch.finished = true
    if (watch.pollTimer !== undefined) clearInterval(watch.pollTimer)
    const key = watch.session.sessionId
    if (this.watches.get(key) === watch) this.watches.delete(key)
    if (watch.session.stopAgyPoll === watch.stop) watch.session.stopAgyPoll = undefined
  }
}
