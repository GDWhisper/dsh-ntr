/**
 * Deliver Antigravity's post-turn output as a background report (see
 * docs/plan/antigravity-late-output.md).
 *
 * After `end_turn` the agent keeps working without a `session/prompt` in
 * flight, and it sends no `session/update` in that window: the answer lands
 * only in its private transcript. This service arms a transcript watch when a
 * chat turn closes, waits for the new `PLANNER_RESPONSE` to go quiet, and hands
 * its text to {@link SubagentService.deliverLateReport}. The watch is bounded
 * by the SESSION (release / close / next turn), not by a fixed deadline: field
 * background work has run 12m34s past its turn (session-af26f3a8).
 *
 * It NEVER closes a turn, kills a process or alters `running`: it is a new
 * SOURCE for the delivery family, not a watchdog.
 */
import { existsSync, statSync } from 'node:fs'
import {
  AgyTranscriptTail,
  agyTranscriptPaths,
  lateAnswerText,
  type TranscriptStep,
} from './agy-transcript.ts'
import type { AcpAgentDef } from '../protocol.ts'
import type { BridgeTuning } from './types.ts'
import type { LiveSession } from './turn-stream.ts'

interface GateState {
  reportGate: boolean
  waiting: boolean
}

/** One armed watch; at most one per LiveSession. */
interface LateWatch {
  readonly session: LiveSession
  readonly tail: AgyTranscriptTail
  readonly closedAt: number
  /** Highest `step_index` at arm time: nothing at or below it is a late answer. */
  baselineStepIndex: number
  readonly steps: TranscriptStep[]
  /**
   * Whether the newest SYSTEM_MESSAGE was a subagent / scheduled-task report —
   * the agent's answer to it is content, not the "still waiting" chatter its
   * own subagent POLL produces (those messages come from `<session>/task-N`).
   */
  reportGate: boolean
  /**
   * Whether a background task (`GENERIC` `RUNNING` or `Task: ... Status: RUNNING`)
   * is currently active without a subsequent task completion / `SYSTEM_MESSAGE`.
   * Synchronous `GENERIC` calls (`read_file`, `manage_subagents list`) must not
   * clear this flag while the background wait is still running.
   */
  waiting: boolean
  pollTimer?: ReturnType<typeof setInterval>
  quietTimer?: ReturnType<typeof setTimeout>
  deadlineTimer?: ReturnType<typeof setTimeout>
  /** Cleared by the timer callbacks so a disarmed watch cannot deliver. */
  finished: boolean
  /** The session's `stopLateWatch` target; lets teardown disarm exactly this watch. */
  stop: () => void
}

/** What the late-output service needs from the bridge manager, injected. */
export interface AgyLateOutputDeps {
  /** Whether an agent definition is Antigravity (overridable in tests). */
  isAgent(def: AcpAgentDef): boolean
  /** Antigravity's store root, or `undefined` when it cannot be named. */
  storeRoot(def: AcpAgentDef): string | undefined
  /** The live tuning object (defaults already applied). */
  tuning(): Required<BridgeTuning>
  /** The manager operations the watch needs (every one a closure, no import back). */
  host: {
    /** The definition of one agent id. */
    defOf(agentId: string): AcpAgentDef | undefined
    /** Whether the session is running a turn or holding the agent's prompt slot. */
    isBusy(session: LiveSession): boolean
    /** Hand one late answer to the chat plane; false when nothing accepted it. */
    deliver(session: LiveSession, text: string): boolean
  }
}

/** Whole-second form of a transcript timestamp; `undefined` when unusable. */
function stepSecond(createdAt: string | undefined): number | undefined {
  if (createdAt === undefined) return undefined
  const parsed = Date.parse(createdAt)
  if (!Number.isFinite(parsed)) return undefined
  return Math.floor(parsed / 1_000)
}

/** Extract `sender=<id>` from a `<SYSTEM_MESSAGE>` step, if present. */
function senderOf(content: string): string | undefined {
  const match = /\bsender=(\S+)/.exec(content)
  return match?.[1]
}

/**
 * Whether one `SYSTEM_MESSAGE` carries a report rather than agy's own poll.
 *
 * Two shapes measured on 1.5.3: a subagent / scheduled task reports with
 * `sender=<conversation id>` (no slash), while the agent's own "check the
 * subagent" timers come from `sender=<sessionId>/task-N`. A `sender=system`
 * notice is neither. Anything unparsable opens nothing (fail closed: no
 * delivery, the text still sits in the transcript).
 */
function isReportMessage(content: string, acpSessionId: string): boolean {
  const sender = senderOf(content)
  if (sender === undefined || sender === 'system') return false
  return !sender.startsWith(`${acpSessionId}/`)
}

/**
 * Advance the wait / report gates for non-planner transcript steps.
 *
 * Background waits begin on `GENERIC` `RUNNING` (or a `manage_task` poll
 * reporting `Task: <id>\nStatus: RUNNING`, whose outer `step.status` is `DONE`)
 * and end on a non-system `SYSTEM_MESSAGE` (either a subagent report or a
 * background task/timer firing) or explicit task completion / cancellation.
 * Ordinary synchronous `GENERIC` steps (`read_file`, `manage_subagents list`)
 * leave `waiting` intact.
 */
function applyGateStep(state: GateState, step: TranscriptStep, acpSessionId: string): void {
  if (step.type === 'USER_INPUT') {
    state.waiting = false
    state.reportGate = false
    return
  }
  if (step.type === 'SYSTEM_MESSAGE') {
    const sender = senderOf(step.content)
    if (sender !== undefined && sender !== 'system') {
      state.waiting = false
      state.reportGate = isReportMessage(step.content, acpSessionId)
    } else {
      state.reportGate = false
    }
    return
  }
  if (step.type === 'GENERIC') {
    if (step.status === 'RUNNING' || /\bTask:\s*\S+\s+Status:\s*RUNNING\b/.test(step.content)) {
      state.waiting = true
      state.reportGate = false
      return
    }
    if (/\bTask:\s*\S+\s+Status:\s*(?!RUNNING\b)\S+/.test(step.content) || /Task\s+"[^"]+"\s+cancelled/.test(step.content)) {
      state.waiting = false
    }
  }
}

/**
 * Whitespace-folded text: the agent's own write may differ from the delivered
 * text only in line wrapping, so equality is judged on the folded form.
 */
function foldWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export class AgyLateOutputService {
  private readonly watches = new Map<string, LateWatch>()

  constructor(private readonly deps: AgyLateOutputDeps) {}

  /**
   * Number of armed watches. Observability ONLY (tests prove that a teardown
   * really withdrew its watch): nothing in the delivery decision reads it.
   */
  get armedCount(): number {
    return this.watches.size
  }

  /** Whether this agent id runs Antigravity (the caller gates session state on it). */
  isAgentFor(agentId: string): boolean {
    const def = this.deps.host.defOf(agentId)
    return def !== undefined && this.deps.isAgent(def)
  }

  /**
   * Start watching a conversation's transcript after a chat turn closed.
   *
   * Preconditions are all read-only checks: the agent is Antigravity, the
   * session is a chat session, it is alive, and its ACP id can name a path.
   * A failed precondition arms nothing — no caller observes an error.
   */
  arm(session: LiveSession, closedAt: number): void {
    session.lateWatchCheckpoint = undefined
    const resolved = this.resolvePaths(session)
    if (resolved === undefined) return
    const { tuning, paths } = resolved
    // One watch per session: a new turn supersedes the previous one.
    this.disarm(session)
    // Both candidates must ALREADY exist: a tail built on a missing file has a
    // 0/0 baseline, and the first flush after the file appears would present
    // the whole session history as a late answer. No file, no watch.
    const path = paths.find(candidate => existsSync(candidate))
    if (path === undefined) return
    const tail = new AgyTranscriptTail(path)
    const seedSteps = tail.baseline()
    const seedGate: GateState = { reportGate: false, waiting: false }
    for (const step of seedSteps) applyGateStep(seedGate, step, session.acpSessionId)
    seedGate.reportGate = false
    this.startWatch(session, tail, closedAt, tail.lastStepIndex, seedGate, tuning)
  }

  /**
   * Re-arm after a WAKE turn. That turn has no ACP controller, so `closeTurn`
   * cannot arm: without this call the watch that produced the wake stays
   * disarmed and the rest of the same background run is lost
   * (session-af26f3a8: the final answer arrived 12 minutes later, never shown).
   *
   * Resumes from the saved {@link LiveSession.lateWatchCheckpoint} when the
   * same file still covers that offset so steps written between `onQuiet` and
   * `armAfterWake` (or started earlier in `created_at` before finishing) are
   * never skipped by `baseline()`.
   */
  armAfterWake(session: LiveSession | undefined): void {
    if (session === undefined) return
    const checkpoint = session.lateWatchCheckpoint
    session.lateWatchCheckpoint = undefined
    if (checkpoint === undefined) {
      this.arm(session, Date.now())
      return
    }
    const resolved = this.resolvePaths(session)
    if (resolved === undefined) return
    const { tuning, paths } = resolved
    if (!paths.includes(checkpoint.path) || !this.fileCoversOffset(checkpoint.path, checkpoint.offset)) {
      this.arm(session, Date.now())
      return
    }
    this.disarm(session)
    const tail = new AgyTranscriptTail(checkpoint.path)
    tail.offset = checkpoint.offset
    tail.lastStepIndex = checkpoint.lastStepIndex
    this.startWatch(
      session,
      tail,
      checkpoint.closedAt,
      checkpoint.lastStepIndex,
      { reportGate: checkpoint.reportGate, waiting: checkpoint.waiting },
      tuning,
    )
  }

  private resolvePaths(session: LiveSession): { tuning: Required<BridgeTuning>; paths: string[] } | undefined {
    const tuning = this.deps.tuning()
    if (!tuning.agyLateOutput) return undefined
    if (session.dshSessionId === undefined) return undefined
    if (session.closed || session.released) return undefined
    const def = this.deps.host.defOf(session.agentId)
    if (def === undefined || !this.deps.isAgent(def)) return undefined
    const storeRoot = this.deps.storeRoot(def)
    if (storeRoot === undefined) return undefined
    const paths = agyTranscriptPaths(storeRoot, session.acpSessionId)
    if (paths.length === 0) return undefined
    // An echo record older than the guard window can never match a replay:
    // drop it at the one moment a new watch starts.
    if (session.lateEcho !== undefined && Date.now() - session.lateEcho.at > tuning.agyLateOutputEchoMs) {
      session.lateEcho = undefined
    }
    return { tuning, paths }
  }

  private fileCoversOffset(path: string, offset: number): boolean {
    try {
      const stat = statSync(path)
      return stat.isFile() && stat.size >= offset
    } catch {
      return false
    }
  }

  private startWatch(
    session: LiveSession,
    tail: AgyTranscriptTail,
    closedAt: number,
    baselineStepIndex: number,
    gate: GateState,
    tuning: Required<BridgeTuning>,
  ): void {
    const pollMs = Math.max(1, tuning.agyLateOutputPollMs)
    const watch: LateWatch = {
      session,
      tail,
      closedAt,
      baselineStepIndex,
      steps: [],
      reportGate: gate.reportGate,
      waiting: gate.waiting,
      finished: false,
      stop: () => { this.disarmWatch(watch) },
    }
    const pollTimer = setInterval(() => { this.poll(watch) }, pollMs)
    pollTimer.unref?.()
    watch.pollTimer = pollTimer
    // The watch lives as long as the SESSION can still produce a late answer:
    // release, close and the next turn all disarm it. Only a positive bound
    // arms the deadline, so a background run that outlives any fixed window
    // (a research subagent that took 12m34s in the field) still gets delivered.
    const maxMs = tuning.agyLateOutputMaxMs
    if (maxMs > 0) {
      const deadlineTimer = setTimeout(() => { this.onDeadline(watch) }, Math.max(1, maxMs))
      deadlineTimer.unref?.()
      watch.deadlineTimer = deadlineTimer
    }
    this.watches.set(session.sessionId, watch)
    session.stopLateWatch = watch.stop
  }

  /** Stop this session's watch, if any. Idempotent; safe from a teardown. */
  disarm(session: LiveSession): void {
    const watch = this.watches.get(session.sessionId)
    if (watch !== undefined) this.disarmWatch(watch)
    else if (session.stopLateWatch !== undefined) session.stopLateWatch = undefined
  }

  /** One poll: liveness, busy and new-step checks, all fail-open. */
  private poll(watch: LateWatch): void {
    if (watch.finished) return
    const session = watch.session
    if (session.closed || session.released || this.deps.host.isBusy(session)) {
      // A busy session will fold the backlog itself on its next prompt; this
      // watch must not deliver a second copy of it.
      this.disarmWatch(watch)
      return
    }
    const steps = watch.tail.readNew()
    if (steps.length === 0) return
    const floorSecond = Math.floor(watch.closedAt / 1_000)
    const candidates: TranscriptStep[] = []
    for (const step of steps) {
      if (step.type === 'USER_INPUT' || step.type === 'SYSTEM_MESSAGE' || step.type === 'GENERIC') {
        applyGateStep(watch, step, session.acpSessionId)
        continue
      }
      // Only planner responses are kept: fewer bytes held, and no sub-agent
      // report ever enters the late-answer buffer.
      if (step.type !== 'PLANNER_RESPONSE') continue
      if (step.status !== 'DONE') continue
      if (step.stepIndex <= watch.baselineStepIndex) continue
      // A line with NO timestamp cannot be told apart from history: fail
      // closed. A line that reaches us through this filter is new AND dated.
      const second = stepSecond(step.createdAt)
      if (second === undefined || second < floorSecond) continue
      if (step.content.trim() === '') continue
      // Two ways to be a late ANSWER: the agent is answering a report, or no
      // background wait is in flight (the run's own tail). Anything else is
      // progress prose the poll loop wrote while a timer or command was running.
      if (!watch.reportGate && watch.waiting) continue
      watch.reportGate = false
      candidates.push(step)
    }
    if (candidates.length === 0) return
    watch.steps.push(...candidates)
    this.armQuiet(watch)
  }

  /** Restart the quiet window; every new step extends it. */
  private armQuiet(watch: LateWatch): void {
    if (watch.quietTimer !== undefined) clearTimeout(watch.quietTimer)
    const quietMs = Math.max(0, this.deps.tuning().agyLateOutputQuietMs)
    const timer = setTimeout(() => {
      watch.quietTimer = undefined
      this.onQuiet(watch)
    }, quietMs)
    timer.unref?.()
    watch.quietTimer = timer
  }

  /** Quiet after new steps: deliver the answer, or keep waiting on an empty one. */
  private onQuiet(watch: LateWatch): void {
    if (watch.finished) return
    const text = lateAnswerText(watch.steps)
    if (text.trim() === '') {
      // Background tool frames only: the answer may still follow.
      return
    }
    if (this.isOwnTurnAnswer(watch.session, text)) {
      // The turn's own answer, written late: nothing to announce.
      this.disarmWatch(watch)
      return
    }
    if (watch.session.closed || watch.session.released || this.deps.host.isBusy(watch.session)) {
      this.disarmWatch(watch)
      return
    }
    if (this.deliver(watch, text)) {
      watch.session.lateWatchCheckpoint = {
        path: watch.tail.path,
        offset: watch.tail.offset,
        lastStepIndex: watch.tail.lastStepIndex,
        closedAt: watch.closedAt,
        reportGate: watch.reportGate,
        waiting: watch.waiting,
      }
    }
    this.disarmWatch(watch)
  }

  /**
   * Optional deadline (only armed when `agyLateOutputMaxMs > 0`): deliver
   * whatever is there when the session is idle, then stop. The default is no
   * deadline at all — see {@link arm}.
   */
  private onDeadline(watch: LateWatch): void {
    if (watch.finished) return
    const session = watch.session
    const text = lateAnswerText(watch.steps)
    if (text.trim() !== '' && !session.closed && !session.released && !this.deps.host.isBusy(session)) {
      this.deliver(watch, text)
    }
    this.disarmWatch(watch)
  }

  /**
   * Whether this text is the answer the closed turn already displayed. The
   * agent's own transcript write may re-wrap lines, so both sides are
   * whitespace-folded before the comparison (folded HERE, not per poll: a
   * 256 KiB answer must not be re-folded on every tick).
   */
  private isOwnTurnAnswer(session: LiveSession, text: string): boolean {
    const shown = session.lastTurnAnswerText
    if (shown === undefined) return false
    return foldWhitespace(shown) === foldWhitespace(text)
  }

  /** Hand one answer over. A session the host no longer accepts throws nothing. */
  private deliver(watch: LateWatch, text: string): boolean {
    if (this.isOwnTurnAnswer(watch.session, text)) return false
    try {
      return this.deps.host.deliver(watch.session, text)
    } catch {
      // Fail-open: a delivery path must never throw into a timer.
      return false
    }
  }

  /** Clear every timer and forget the record; safe to call twice. */
  private disarmWatch(watch: LateWatch): void {
    if (watch.finished) return
    watch.finished = true
    if (watch.pollTimer !== undefined) clearInterval(watch.pollTimer)
    if (watch.quietTimer !== undefined) clearTimeout(watch.quietTimer)
    if (watch.deadlineTimer !== undefined) clearTimeout(watch.deadlineTimer)
    const key = watch.session.sessionId
    if (this.watches.get(key) === watch) this.watches.delete(key)
    if (watch.session.stopLateWatch === watch.stop) watch.session.stopLateWatch = undefined
  }
}
