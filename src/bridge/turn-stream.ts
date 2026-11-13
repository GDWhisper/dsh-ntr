import {
  BOOKKEEPING_UPDATES,
  EventHub,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  describeUnhandledUpdate,
  isFinalToolCallStatus,
  updateContentToText,
  type AcpToolCallSnapshot,
  type Transcript,
} from '../impl.ts'
import type { AcpEvent, PermissionOutcome, StreamChunk } from '../protocol.ts'
import { OUTPUT_CHARS_PER_TOKEN, TurnTpsTracker } from '../tps.ts'
import { BACKGROUND_REPORT_MAX, recordAcpToolOutput, releaseAllToolOutputWaiters } from './registries.ts'
import type { AmbientTurn, BackgroundDispatch, BackgroundReport, BridgeTuning, RetiredAmbient } from './types.ts'
import { AsyncQueue } from './async-queue.ts'
// Type-only edge into the manager; erased completely at runtime, so the
// manager → controller value import stays acyclic.
import type { BridgeManager } from './manager.ts'
import type { LiveSession } from './live-session.ts'

export type { LiveSession } from './live-session.ts'

/**
 * The CodeBuddy `_meta` facts this bridge reads, when the object carries them.
 *
 * CodeBuddy runs "background drains": a sub-agent completion notice starts a
 * turn the client never prompted, announced by a `session_info_update` whose
 * `_meta["codebuddy.ai/unsolicitedTurn"]` names the run. Every update of that
 * run then carries `_meta["codebuddy.ai/requestId"]`, and a `session/prompt`
 * answered instantly (with no `codebuddy.ai/conversationRequestId` on the
 * RESPONSE) had its message folded into the drain — the real answer streams
 * afterwards, under the drain's request id.
 *
 * The same run also explains a DETACHED WORKER: `_meta["codebuddy.ai/toolName"]`
 * names the `Agent` call that dispatched it, the call is re-sent with
 * `_meta["codebuddy.ai/isBackground"] = true` once the worker runs off-turn, and
 * every update the worker emits carries
 * `_meta["codebuddy.ai/parentToolCallId"]` naming that call. Those updates are
 * the worker's own turn — they belong in the transcript, not in the session's
 * assistant message. The completion of the dispatch call itself carries NO
 * `_meta` at all, so a known call's status is read from its id.
 *
 * No other agent sends these keys: an object without them yields `undefined`,
 * so every existing path is untouched. Values are only read when they have the
 * declared shape (never guessed from a message body).
 */
interface CodebuddyMeta {
  /** The run this update belongs to. */
  requestId?: string
  /** Set on the `session_info_update` that STARTS a background turn. */
  unsolicitedTurn?: { requestId: string; reason?: string }
  /** The agent's own phase heartbeat (`{ phase }`), a liveness tick. */
  agentPhase?: { phase: string }
  /** Set on a `session/prompt` RESPONSE that really queued a conversation turn. */
  conversationRequestId?: string
  /**
   * The tool a `tool_call` names, when the agent omits `title`. `Agent` (or
   * `Task`) means the call DISPATCHED a detached worker: the call stays in
   * progress while the worker runs on its own.
   */
  toolName?: string
  /**
   * Set on every update a DETACHED WORKER emits (prose, tools, its report):
   * it names the `Agent` tool call that dispatched the worker. Such an update
   * belongs to the worker's own turn, never to this session's answer.
   */
  parentToolCallId?: string
  /**
   * Set on the dispatch call RE-SENT after the worker started
   * (`codebuddy.ai/isBackground: true`): the call handed its work to a worker
   * that keeps running off-turn, which is the structural "detached" signal.
   * The first send of the same call does not carry it.
   */
  isBackground?: boolean
  /** `codebuddy.ai/isSubagent` — the same re-send declares the worker a sub-agent. */
  isSubagent?: boolean
  /**
   * `codebuddy.ai/subagentType` / `codebuddy.ai/description` /
   * `codebuddy.ai/memberName` — the worker's identity. CodeBuddy omits the
   * dispatch call's `rawInput` on its first send (repl display), so these meta
   * keys are the ONLY place the assigned role and task line can be read.
   */
  subagentType?: string
  subagentDescription?: string
  subagentName?: string
  /**
   * `_meta["codebuddy.ai"] = { mode: "history", offset }` — the agent's own
   * marker on every update it REPLAYS during `session/load` (captured on the
   * wire). A replayed dispatch is history, not live work: it must not create
   * or move a lifecycle record.
   */
  historyReplay?: boolean
}

/** Read the CodeBuddy `_meta` keys off an update or a `{ _meta }` wrapper. */
export function codebuddyMetaOf(source: unknown): CodebuddyMeta | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const row = source as Record<string, unknown>
  const rawMeta = row._meta
  if (typeof rawMeta !== 'object' || rawMeta === null) return undefined
  const meta = rawMeta as Record<string, unknown>
  const out: CodebuddyMeta = {}
  const requestId = meta['codebuddy.ai/requestId']
  if (typeof requestId === 'string' && requestId !== '') out.requestId = requestId
  const conversationRequestId = meta['codebuddy.ai/conversationRequestId']
  if (typeof conversationRequestId === 'string' && conversationRequestId !== '') {
    out.conversationRequestId = conversationRequestId
  }
  const toolName = meta['codebuddy.ai/toolName']
  if (typeof toolName === 'string' && toolName !== '') out.toolName = toolName
  const parentToolCallId = meta['codebuddy.ai/parentToolCallId']
  if (typeof parentToolCallId === 'string' && parentToolCallId !== '') out.parentToolCallId = parentToolCallId
  // Booleans, read as booleans only: a string "true" is not the declared shape
  // and guessing from it would make another agent's unrelated key look detached.
  if (meta['codebuddy.ai/isBackground'] === true) out.isBackground = true
  if (meta['codebuddy.ai/isSubagent'] === true) out.isSubagent = true
  const subagentType = meta['codebuddy.ai/subagentType']
  if (typeof subagentType === 'string' && subagentType !== '') out.subagentType = subagentType
  const subagentDescription = meta['codebuddy.ai/description']
  if (typeof subagentDescription === 'string' && subagentDescription !== '') {
    out.subagentDescription = subagentDescription
  }
  const subagentName = meta['codebuddy.ai/memberName']
  if (typeof subagentName === 'string' && subagentName !== '') out.subagentName = subagentName
  const unsolicited = meta['codebuddy.ai/unsolicitedTurn']
  if (typeof unsolicited === 'object' && unsolicited !== null) {
    const run = unsolicited as Record<string, unknown>
    if (typeof run.requestId === 'string' && run.requestId !== '') {
      out.unsolicitedTurn = {
        requestId: run.requestId,
        ...(typeof run.reason === 'string' && run.reason !== '' ? { reason: run.reason } : {}),
      }
    }
  }
  const phase = meta['codebuddy.ai/agentPhase']
  if (typeof phase === 'object' && phase !== null) {
    const tick = phase as Record<string, unknown>
    if (typeof tick.phase === 'string' && tick.phase !== '') out.agentPhase = { phase: tick.phase }
  }
  const history = meta['codebuddy.ai']
  if (typeof history === 'object' && history !== null && (history as Record<string, unknown>).mode === 'history') {
    out.historyReplay = true
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Remember a background drain this session stopped waiting on. A quiet close
 * drops the drain record (so an ordinary next turn is not held open for it),
 * but the run may revive afterwards; keeping its id lets every later update be
 * recognized as the drain's (`isRetiredAmbientId`) instead of being adopted as
 * the next turn's own. Bounded, oldest first — an id this far back names a run
 * no late update can plausibly still carry. Re-retiring an id refreshes its
 * timestamp and moves it to the end.
 */
export function retireAmbientId(session: LiveSession, requestId: string, consume = true): void {
  const retired = session.retiredAmbients ?? []
  const existing = retired.findIndex(entry => entry.requestId === requestId)
  if (existing >= 0) retired.splice(existing, 1)
  retired.push({ requestId, retiredAt: Date.now() })
  while (retired.length > RETIRED_AMBIENT_MAX) retired.shift()
  session.retiredAmbients = retired
  // An answer that was DELIVERED (a closed wait, a hold, or an idle wake) is
  // final: its later frames are transcript-only, never a second answer. A
  // stale retirement (`consume: false`) delivered nothing, so a drain that
  // comes back to life may still wake the chat.
  if (!consume) return
  const consumed = session.consumedDrains ?? new Set<string>()
  session.consumedDrains = consumed
  consumed.delete(requestId)
  consumed.add(requestId)
  while (consumed.size > CONSUMED_DRAIN_MAX) {
    const oldest = consumed.values().next().value
    if (oldest === undefined) break
    consumed.delete(oldest)
  }
}

/** Whether this request id names a drain the session already stopped waiting on. */
export function isRetiredAmbientId(session: LiveSession, requestId: string | undefined): boolean {
  return requestId !== undefined
    && session.retiredAmbients?.some(entry => entry.requestId === requestId) === true
}

/**
 * Whether the session retired a drain recently enough that a prompt answered
 * with no ambient record and no conversation id may have been folded into it.
 * A quiet close is only evidence WE stopped waiting, so the next instant
 * answer is ambiguous; past this horizon the drain is treated as gone and the
 * ordinary zero-output warning applies.
 */
export function hasRecentRetiredAmbient(session: LiveSession, withinMs: number): boolean {
  const retired = session.retiredAmbients
  if (retired === undefined || retired.length === 0) return false
  const cutoff = Date.now() - withinMs
  return retired.some(entry => entry.retiredAt >= cutoff)
}

/**
 * Work that OUTLIVES a closed turn: a detached worker that is alive (inside an
 * open tool call, or recently active), or a background drain that spoke within
 * the staleness window. Both must pin the process — an idle release would kill
 * the agent out from under them.
 *
 * An OPEN worker tool call is stronger evidence of life than silence: a long
 * build emits no updates for tens of minutes, so the plain silence window never
 * applies while one is open — the long `openToolCeilingMs` does. ANY open call
 * still inside that ceiling proves the worker alive; when every open call has
 * outlived it, plain recency decides (a worker that keeps reporting is alive).
 * `0` means no ceiling. Without some bound a worker that never reports would
 * pin the process forever.
 */
export function hasPendingBackgroundWork(
  session: LiveSession,
  ambientStaleMs: number,
  dispatchSilenceMs: number,
  openToolCeilingMs: number,
): boolean {
  const dispatches = session.backgroundDispatches
  if (dispatches !== undefined) {
    for (const dispatch of dispatches.values()) {
      if (dispatch.terminal !== undefined) continue
      const openSince = latestOpenWorkerTool(dispatch)
      if (openSince !== undefined
        && (openToolCeilingMs <= 0 || Date.now() - openSince <= openToolCeilingMs)) return true
      // Every open call outlived the ceiling: fall back to plain recency, so a
      // worker that keeps reporting is still alive.
      if (Date.now() - dispatch.lastActivityAt <= dispatchSilenceMs) return true
    }
  }
  return session.ambient !== undefined
    && Date.now() - session.ambient.lastActivityAt <= ambientStaleMs
}

/**
 * When the LATEST still-open worker tool call opened, if any. The newest one
 * decides: one call may have outlived the ceiling while a sibling started
 * later and is still perfectly alive.
 */
function latestOpenWorkerTool(dispatch: BackgroundDispatch): number | undefined {
  const open = dispatch.openWorkerToolCalls
  if (open === undefined || open.size === 0) return undefined
  let latest = Number.NEGATIVE_INFINITY
  for (const at of open.values()) {
    if (at > latest) latest = at
  }
  return latest
}

/**
 * The retired drain spoke again (an update or a re-announcement carried its
 * id): it is alive, not retired. The caller rebuilds {@link LiveSession.ambient}
 * so the next prompt folded into it is recognised as steered and its text can
 * reach the user's turn; only while the id stays retired does its text remain
 * transcript-only.
 */
export function reviveAmbientId(session: LiveSession, requestId: string): void {
  const retired = session.retiredAmbients
  if (retired === undefined) return
  const index = retired.findIndex(entry => entry.requestId === requestId)
  if (index < 0) return
  retired.splice(index, 1)
  if (retired.length === 0) session.retiredAmbients = undefined
}

/**
 * Forget every background-drain trace a session carried. Called at each
 * lifecycle boundary (close / release / resume / force reset): a fresh
 * agent-side state neither inherits a stale drain nor the ids of drains that
 * belonged to the old one.
 *
 * The transient rate-limit refusal goes the same way: the next process either
 * answers normally (clearing it on its own) or refuses again with its own
 * detail, and a quota recorded against the OLD process must not outlive it.
 */
export function clearAmbientState(session: LiveSession): void {
  if (session.backgroundReport?.timer !== undefined) clearTimeout(session.backgroundReport.timer)
  session.backgroundReport = undefined
  session.ambient = undefined
  session.ambientNotices?.clear()
  session.retiredAmbients = undefined
  session.consumedDrains = undefined
  session.quotaRefusal = undefined
  // The Antigravity late-output state is transient too: a replay record only
  // speaks for the prompt that delivered it, and a watch must not outlive the
  // session it observes (the transcript writer is the agent process).
  session.lateEcho = undefined
  session.pendingLateEcho = undefined
  session.lateWatchCheckpoint = undefined
  session.turnToolCalls?.clear()
  session.knownToolCalls?.clear()
  const stopLateWatch = session.stopLateWatch
  session.stopLateWatch = undefined
  stopLateWatch?.()
}

/**
 * The closing line of a turn the agent deferred to its OWN background run: the
 * answer exists, but in the ACP transcript view rather than in this bubble.
 * Shared by the ambient wait and the detached-worker hold, so both say the
 * same thing in the same words.
 */
function backgroundDeferralLine(agentId: string): string {
  return `\n[dsh-ntr] agent "${agentId}" deferred this turn to a background task run; its output is in the ACP transcript view. Send again after the background run finishes.\n`
}

/** Human-facing identity of an ACP tool call (the approval headline). */
/**
 * Human-facing name of the tool an ask is about, for the chat line and the
 * timeout notice.
 *
 * The ACP `toolCall.title` is the declared field, but it is OPTIONAL and real
 * agents omit it: codebuddy puts the name in `_meta["codebuddy.ai/toolName"]`
 * (observed live — without the fallback the notice reads `for "tool call"`,
 * which tells the human nothing about what they missed). So read `title` first,
 * then any `_meta` key whose last segment is `toolName`, then the standard
 * `kind`, and only then give up with the generic phrase. Nothing is invented:
 * every step reads a key the agent itself declared.
 */
export function permissionToolName(toolCall: unknown): string {
  const row = (typeof toolCall === 'object' && toolCall !== null ? toolCall : {}) as Record<string, unknown>
  if (typeof row.title === 'string' && row.title !== '') return row.title
  const meta = (typeof row._meta === 'object' && row._meta !== null ? row._meta : {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(meta)) {
    const segment = key.split('/').at(-1) ?? key
    if (segment.toLowerCase() === 'toolname' && typeof value === 'string' && value !== '') return value
  }
  if (typeof row.kind === 'string' && row.kind !== '') return row.kind
  return 'tool call'
}

// ---- Segmented turn streaming ----

/**
 * One driver step's stream: its own chunk queue and block state. A turn is
 * MANY segments when it carries tool calls — each segment ends where a tool
 * card should sit as the LAST block of the settled assistant message, so the
 * host loop executes the card between two assistant messages exactly like a
 * native multi-step turn (see docs/acp-convergence.md §1.7).
 */
interface SegmentState {
  queue: AsyncQueue<StreamChunk>
  /** Block index within THIS segment (the host accumulator is per-stream-call). */
  index: number
  activeType: 'reasoning' | 'text' | 'tool-call' | null
  activeText: string
  /** UTF-16 units of this segment's text and reasoning chunks (the usage estimate). */
  outputChars: number
  /** The open tool-call block's snapshot, while `activeType === 'tool-call'`. */
  activeToolCall: AcpToolCallSnapshot | undefined
  /** Whether this segment opened at least one tool-call block. */
  hasCard: boolean
  /**
   * The segment belongs to an ambient wait: the agent folded our prompt into a
   * background drain it started itself. Tool traffic is recorded (so the
   * transcript and any parked tool-output waiter get it) but opens NO card —
   * a card would make the host loop execute a tool for a turn whose answer has
   * not even started streaming yet.
   */
  ambient: boolean
  /**
   * Whether this segment's open card was settled early (see
   * `settleOpenCard`). The snapshot stays open so a late restatement still
   * folds into it; the segment's closing `block-end` then replaces the settled
   * card with the final text.
   */
  cardSettled: boolean
  finished: boolean
}

/** How one segment's stream ends, in `StreamChunk.finish` terms. */
type SegmentFinishReason =
  | { kind: 'stop' }
  | { kind: 'aborted'; failure?: { message: string; code: string } }
  | { kind: 'error'; failure?: { message: string; code: string } }

/** Why a turn ended, as seen by {@link TurnStreamController.settle}. */
type TurnSettle =
  | { kind: 'stop'; stopReason: string; refusal?: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; code?: string; errorKind?: 'quota' }

/** One step of the echo guard's state machine (see {@link applyEchoGuard}). */
export type EchoGuardResult =
  /** Still a strict prefix of the late answer: hold it, emit nothing yet. */
  | { kind: 'hold'; buffer: string }
  /** Exactly the late answer: drop it and stop guarding. */
  | { kind: 'swallow'; buffer: string }
  /** The late answer followed by new text: emit the new tail only. */
  | { kind: 'release'; buffer: string; emit: string }
  /** Not the late answer at all: emit everything (fail-open). */
  | { kind: 'mismatch'; buffer: string; emit: string }

/**
 * The replay deduplication state machine for Antigravity's next prompt.
 *
 * The agent flushes the previous turn's answer at the start of the next prompt,
 * and that text was ALREADY delivered as a background report. Chunks are
 * incremental (no `replace` semantics), so a strict prefix accumulation is
 * enough to recognise it. Every branch but `hold` clears the guard state:
 * anything that deviates emits the text instead of eating a real answer.
 */
export function applyEchoGuard(late: string, buffer: string, chunk: string): EchoGuardResult {
  const next = buffer + chunk
  if (next.length < late.length && late.startsWith(next)) return { kind: 'hold', buffer: next }
  if (next === late) return { kind: 'swallow', buffer: '' }
  if (next.length > late.length && next.startsWith(late)) return { kind: 'release', buffer: '', emit: next.slice(late.length) }
  return { kind: 'mismatch', buffer: '', emit: next }
}

/**
 * Whether a `content` value is TEXT in the agent's own declared shape. The
 * echo guard only applies here: `chunkTextOf` folds any other shape into a
 * JSON string, and matching that against a prose answer would be meaningless.
 */
function isTextualContent(content: unknown): boolean {
  if (typeof content === 'string') return true
  if (Array.isArray(content)) {
    return content.every(item => typeof item === 'string'
      || (typeof item === 'object' && item !== null
        && typeof (item as Record<string, unknown>).text === 'string'
        && ((item as Record<string, unknown>).type === undefined || (item as Record<string, unknown>).type === 'text')))
  }
  if (typeof content === 'object' && content !== null) {
    const row = content as Record<string, unknown>
    return typeof row.text === 'string' && (row.type === undefined || row.type === 'text')
  }
  return false
}

/** How often a running turn's live burst aggregate is pushed to the browser. */
const TPS_PUSH_INTERVAL_MS = 1000

/**
 * Bounds on the updates withheld while a turn's own request id is still
 * unknown (see `TurnStreamController.bufferAmbientUpdate`). The buffer exists
 * only for the response window of one prompt, but a chatty drain could stream
 * for a while inside it; over the bound the OLDEST entries are dropped — the
 * transcript still has every one of them.
 */
const PENDING_AMBIENT_MAX_ENTRIES = 200
const PENDING_AMBIENT_MAX_CHARS = 64 * 1024

/**
 * Bound on {@link LiveSession.ambientNotices}. The set now outlives the turn
 * that announced a drain (a hard ceiling keeps the record, and a repeated
 * announcement of the same run must stay silent), so it needs a ceiling of its
 * own for a chatty agent. Oldest ids are evicted first; an id that far back is
 * a run nobody is waiting on anymore.
 */
export const AMBIENT_NOTICE_MAX = 64

/**
 * Bound on {@link LiveSession.retiredAmbients}. The ids only exist to catch a
 * drain that speaks again after its wait closed, and the timestamp lets the
 * next silent close recognise a recent fold — a short-horizon concern, so a
 * small ring is enough; the oldest is evicted first.
 */
export const RETIRED_AMBIENT_MAX = 32

/**
 * Bound on {@link LiveSession.knownToolCalls}: the ids only exist to recognise
 * a replayed card, and an id older than this many completed turns is no longer
 * plausible. Oldest evicted first.
 */
export const KNOWN_TOOL_CALL_MAX = 512

/**
 * Bound on {@link LiveSession.consumedDrains}: one id per delivered answer.
 * The set only grows with drains this session actually consumed, so a small
 * ring covers every run whose late frames could still arrive; oldest first.
 */
export const CONSUMED_DRAIN_MAX = 64

/**
 * Floor for the "recently retired" lookback the zero-output fallback uses
 * (twice `ambientQuietMs`). Only test-sized quiet windows fall below it; a
 * production window (10s) always wins. Without the floor a 250ms quiet window
 * would leave a 500ms lookback, too tight to survive a loaded CI scheduler
 * between one turn ending and the next prompt's response.
 */
export const RETIRED_AMBIENT_RECENT_MIN_MS = 1_000

/** One ambient wait's clocks and the stop reason it will close the turn with. */
interface AmbientWait {
  /** The drain's request id: the turn is waiting on this run, not on its own. */
  requestId: string
  quietTimer: ReturnType<typeof setTimeout>
  hardTimer: ReturnType<typeof setTimeout>
  /** The stop reason the agent's `session/prompt` response carried. */
  stopReason: string
  /**
   * Whether the CEILING closed this wait (the drain was still ticking) rather
   * than silence. A hard ending must keep the session's drain record: the next
   * prompt may be folded into the same run, and it is still alive.
   */
  hard?: boolean
}

/** An update withheld from the segment until the turn's own request id is known. */
interface PendingAmbientUpdate {
  seq: number
  update: Record<string, unknown>
  /** `JSON.stringify(update).length`, kept so eviction need not re-serialize. */
  chars: number
}

/**
 * A turn held open for the detached worker its `Agent` call dispatched.
 *
 * Two phases, because their liveness signals differ:
 * - `worker`: at least one worker runs off-turn and may be silent for tens of
 *   seconds between model calls — its clock is a SILENCE window
 *   ({@link BridgeTuning.backgroundTaskMaxMs}) pushed out by every dispatch /
 *   worker update, plus an optional whole-hold ceiling
 *   ({@link BridgeTuning.backgroundTaskCeilingMs}). It ends when EVERY known
 *   dispatch reported (completed / failed); a drain announcement is recorded
 *   meanwhile but arms no clock.
 * - `drain`: every dispatch reported and the background turn that carries
 *   their report is (or is about to start) — the existing ambient windows
 *   apply (`ambientQuietMs` quiet, reset by every update; `ambientMaxMs`
 *   ceiling from the switch).
 */
interface BackgroundHold {
  /** The stop reason the prompt RESPONSE carried (what the turn closes with). */
  stopReason: string
  /** The run this hold currently waits on: the response's id or the last announcement. */
  requestId?: string
  /**
   * Every drain id this hold may fold text from: the response's
   * `conversationRequestId` / `requestId` plus every announced id. A run
   * announced before the response may name a different id than the response —
   * both are this turn's answer, and anything else stays background noise.
   */
  acceptedIds: Set<string>
  phase: 'worker' | 'drain'
  /**
   * Agent MESSAGE text folded into this hold. The parent's interim
   * acknowledgement ("已派…") landed before the hold and is not the drained
   * run's answer: a hold that never received that answer must still say where
   * it will appear.
   */
  answerChars: number
  /**
   * The transcript head when the hold began. Text at or below it arrived
   * before the hold — a parked hold replays the parent's ack from there — so
   * it is not counted in {@link answerChars}; the drain updates withheld for
   * the response are the exception and are counted explicitly when flushed.
   */
  floorSeq: number
  quietTimer?: ReturnType<typeof setTimeout>
  hardTimer?: ReturnType<typeof setTimeout>
  /** Absolute whole-hold ceiling; absent when the tuning disables it (0). */
  ceilingTimer?: ReturnType<typeof setTimeout>  /**
   * The bounded wait for a driver step to speak into. Only while the hold is
   * PARKED (`pendingBackgroundHold`): the response landed between steps, and
   * the host is expected to open the continuation step for the Agent card.
   */
  graceTimer?: ReturnType<typeof setTimeout>
  /** Whether the run's ids were already released (a close, cancel or teardown). */
  retired: boolean
}

/**
 * How long a card-bearing segment waits for the agent to stop disclosing the
 * open call's arguments before the block is settled.
 *
 * The settling rule (`docs/acp-convergence.md` §1.8) cuts a segment at the
 * next non-tool event, which for a long-running tool means the agent's next
 * words — typically AFTER the tool finished. The host's live "preparing" row
 * only advances on `argumentsDelta`, and an ACP update restates its input in
 * whole, so the real command otherwise appears only when the segment closes.
 * A short quiet window closes the tool-call BLOCK (not the segment): the row
 * settles its arguments and shows the real command while the agent still
 * executes the tool, and the segment stays open for the host-side settle,
 * watchdog and continuation semantics.
 *
 * Long enough to batch the announce → rewrite burst observed on
 * CodeBuddy (all within the same tick or two), short enough to read as live.
 */
const CARD_SETTLE_QUIET_MS = 500

/**
 * The state of ONE ACP prompt, shared across every driver step of the turn.
 *
 * The controller owns the hub subscription (for the whole agent-side turn, not
 * per stream() call), the transcript cursor (segments resume by replaying
 * `transcript.since(cursor)` — events that arrive while no segment is open are
 * recorded, never lost), the seen-call registry (a call id gets exactly one
 * card per turn, wherever its restatements land), and the turn-level facts
 * (`sawVisibleBlock`) that outlive any single segment.
 */
export class TurnStreamController {
  private segment: SegmentState | undefined
  private settled = false
  /** Whether the turn's closing work already ran (see `closeTurn`). */
  private closedTurn = false
  private disposed = false
  private readonly seenCalls = new Set<string>()
  private readonly announcedKinds = new Map<string, string>()
  /** Narrative lines (permission asks) that arrived while no segment was open. */
  private readonly pendingProse: string[] = []
  sawVisibleBlock = false
  /**
   * Whether THIS turn streamed its own prose (text or reasoning), i.e. an
   * answer that is not the background drain's. Tool cards do not count — a
   * drain that only ran tools delivered no words to the conversation.
   */
  private sawAgentProse = false
  /**
   * Whether any `agent_message_chunk` text reached the plane. Reasoning does
   * not count: a steer whose drain only thought is still a turn with no answer
   * text, and must say so when it closes.
   */
  private sawVisibleText = false
  /**
   * The visible answer text this turn streamed (agent MESSAGE chunks only, in
   * order). `closeTurn` publishes it as
   * {@link LiveSession.lastTurnAnswerText}, so the transcript watcher can tell
   * the turn's own answer — written late — from a new report.
   *
   * Bounded by {@link BACKGROUND_REPORT_MAX}: past the bound the field stops
   * accumulating and `turnAnswerOverflow` is set, so `closeTurn` publishes
   * `undefined` instead of a prefix (a truncated prefix would silently
   * misclassify a genuinely new answer as this turn's own).
   */
  private turnAnswerText = ''
  /** The answer exceeded {@link BACKGROUND_REPORT_MAX}; no equality evidence. */
  private turnAnswerOverflow = false
  /**
   * Text held while it is still a strict prefix of the late answer the echo
   * guard is waiting to swallow (Antigravity only). `undefined` means the guard
   * is not currently accumulating.
   */
  private echoBuffer?: string
  /**
   * The drain run ids whose visible answer text this turn FOLDED (the fold
   * treatment set). `closeTurn`'s quiet close reads it to decide the `consume`
   * half of `retireAmbientId` PER RUN: only an answer the user has SEEN is
   * delivered — a close that printed nothing but the deferral line must leave
   * the id unconsumed, or a run that revives with the real answer would be
   * eaten by `consumedDrains` and never reach the chat.
   *
   * Per RUN id, never one turn-level bit: one turn can fold run A's answer
   * while the ambient record has already moved to run B. A turn-level bit would
   * then consume B (which delivered nothing — its revival could never wake
   * again) and spare A (whose answer is already on screen — its revival would
   * answer the same text twice). Ids, not "folded anything".
   */
  private readonly foldedDrainIds = new Set<string>()
  /**
   * The CodeBuddy request id this turn has adopted as its own (from the
   * prompt RESPONSE's `conversationRequestId`, or from the first update that
   * named one). Used to keep a background drain's prose out of the user's
   * answer; `undefined` means "unknown" and nothing is split (fail-open).
   */
  private turnRequestId?: string
  /**
   * Updates the session's background drain already streamed while this turn's
   * OWN request id was still unknown. They are NOT folded on arrival: a drain
   * tick that lands before the prompt response could otherwise teach the turn
   * the drain's id (`noteTurnRequestId`) and mix the drain's text into the
   * user's answer. Withheld here (cursor already advanced — the transcript
   * keeps a copy) until the response decides what this turn is:
   * - a normal turn (response carries a conversation id) discards them — they
   *   were never this turn's answer;
   * - a steered turn flushes them into the segment, in order, once
   *   `awaitAmbient` marks the segment ambient (tool cards suppressed).
   */
  private readonly pendingAmbientUpdates: PendingAmbientUpdate[] = []
  private pendingAmbientChars = 0
  /**
   * Whether the bounded buffer dropped at least one update. The flush then
   * says so in the conversation instead of silently losing the front of the
   * drain's output (constraint 29: ACP payloads are never dropped silently).
   */
  private pendingAmbientTruncated = false
  /** The ambient wait in progress, if the agent folded this prompt into a drain. */
  private awaitingAmbient?: AmbientWait
  /**
   * The prompt response named no conversation turn while a drain this session
   * retired RECENTLY may still be running without re-announcing. The turn still
   * settles at once (a drain record that no update revived is not waited on),
   * but its zero-output report says the turn may have been folded into that run
   * instead of blaming the agent and suggesting a resend.
   */
  private recentRetiredDrain = false
  /** The outcome of a settle whose closing work is waiting one macrotask (see `settle`). */
  private pendingOutcome?: TurnSettle
  private closeScheduled = false
  /**
   * The bounded wait that settles an open card's block while the agent is
   * still running the tool (see {@link CARD_SETTLE_QUIET_MS}). Only armed for
   * a segment whose open card has disclosed arguments.
   */
  private cardSettleTimer?: ReturnType<typeof setTimeout>
  private cursorSeq: number
  /**
   * Burst tracker for this turn, fed from the LIVE hub frames only. Segment
   * replay must not touch it: every event is already counted once when it
   * arrived, and replay would double the numerator and the gaps.
   */
  private readonly tps = new TurnTpsTracker()
  private tpsSeq: number
  private lastTpsPushAt = 0
  /**
   * The ambient quiet/ceiling windows, read once from the manager: they are
   * deployment tuning, not per-tick facts, and small test values must be stable
   * for the whole turn (see {@link BridgeTuning.ambientQuietMs} for the
   * measured CodeBuddy tick cadence these defaults come from).
   */
  private readonly ambientTuning: { quietMs: number; maxMs: number }
  /**
   * Detached-worker records live on the SESSION, not on this turn: a worker
   * that outlives the turn still reports, and the record has to move with it
   * (see {@link LiveSession.backgroundDispatches}). The hold still waits for
   * ALL of a turn's dispatches, but the map survives its controller.
   */
  private get dispatches(): Map<string, BackgroundDispatch> {
    return this.session.backgroundDispatches ??= new Map()
  }
  /**
   * The ids of dispatches THIS turn created. A hold may only wait for work the
   * turn itself handed out: a completed worker of an EARLIER turn still sits
   * in the session map, and waiting on it would hold an unrelated successor
   * turn against a drain it does not own.
   */
  private readonly turnDispatchIds = new Set<string>()
  /** The detached-worker hold in progress, once a segment carries it. */
  private backgroundHold?: BackgroundHold
  /**
   * A hold parked because the prompt response landed while NO driver segment
   * was open (the host is between steps, about to execute the Agent card). It
   * begins when the next `startSegment` opens — or closes after a bounded
   * grace so a host that never opens one does not hang the turn.
   */
  private pendingBackgroundHold?: BackgroundHold
  /**
   * The hold's own windows, read once at construction like the ambient pair:
   * `taskMaxMs` is the worker phase's SHORT silence window, `toolMaxMs` its
   * long tier while the worker's last known state is an open tool call,
   * `ceilingMs` the optional whole-hold absolute bound (0 = none), `graceMs`
   * the parked hold's bounded wait for a driver step (see
   * {@link BridgeTuning.backgroundTaskMaxMs} /
   * {@link BridgeTuning.backgroundTaskToolMs} /
   * {@link BridgeTuning.backgroundTaskCeilingMs} /
   * {@link BridgeTuning.backgroundParkedGraceMs}).
   */
  private readonly backgroundTuning: { taskMaxMs: number; toolMaxMs: number; ceilingMs: number; graceMs: number }
  /**
   * Tool calls FROM the worker's own turn (updates carrying
   * `parentToolCallId`) that have not reported completed / failed. They are
   * the long-tier evidence for the worker phase's silence window: a worker
   * blocked inside one command is alive, not gone (see
   * {@link BridgeTuning.backgroundTaskToolMs}).
   */
  private readonly workerToolCalls = new Set<string>()
  /**
   * When this controller was built. Only a drain announced AFTER this moment
   * may be adopted by the hold: an `ambient` record that predates the turn is
   * some earlier run's, and folding its text would mix two answers.
   */
  private readonly constructedAt: number

  constructor(
    private readonly manager: BridgeManager,
    private readonly hub: EventHub,
    readonly session: LiveSession,
    readonly turnId: string,
    /** Releases the agent-side turn slot (the `beginTurn` settler; idempotent). */
    private readonly endTurn: () => void,
    private readonly rollbackFirstTurn: (session: LiveSession) => void,
  ) {
    this.turnSeqAtStart = session.turnSeq
    this.cursorSeq = session.transcript.head
    this.tpsSeq = session.transcript.head
    this.constructedAt = Date.now()
    this.ambientTuning = manager.ambientTuning
    this.backgroundTuning = manager.backgroundTuning
    this.unsubscribe = hub.subscribe(event => this.onEvent(event))
  }

  private readonly unsubscribe: () => void
  private readonly turnSeqAtStart: number

  /** The transcript cursor: everything at or below it is already folded or recorded. */
  get replayCursor(): number {
    return this.cursorSeq
  }

  /** Whether the agent already settled its `session/prompt` for this turn. */
  get hasSettled(): boolean {
    return this.settled
  }

  /** Whether a segment is on air — the agent is expected to speak into a live driver step. */
  get hasOpenSegment(): boolean {
    return this.segment !== undefined && !this.segment.finished
  }

  /** Generation guard: a controller whose turn has been superseded must not touch the session. */
  get stale(): boolean {
    return this.disposed || this.session.turnSeq !== this.turnSeqAtStart
  }

  /**
   * Open the next segment and replay everything that landed since the cursor.
   * Visible events fold into the new segment (a card that was announced
   * between segments opens here); tool records are idempotent. Replaying may
   * itself finish the segment (card followed by prose — the prose belongs to
   * the NEXT message): the replay stops AT the cutting event without
   * consuming it, so the next segment replays it again.
   */
  startSegment(): SegmentState {
    // A step opening on an already settled turn (the response landed a tick
    // ago and the tail drain is still scheduled) closes that turn FIRST: the
    // step must read a settled controller and the session must not stay
    // `running` across the macrotask boundary — the host's next prompt would be
    // refused as busy for no reason.
    this.flushScheduledClose()
    // A step opening is the HOST handing the turn back to the agent — this
    // runs for the first step and for each continuation after the host
    // executed a card. The watchdog measures the stretch the AGENT holds the
    // floor, so the bounded gap a host step owns must not count as agent
    // silence; resetting here cannot mask a later agent silence because the
    // reset itself is bounded by one driver step.
    this.session.lastAgentActivityAt = Date.now()
    const seg: SegmentState = {
      queue: new AsyncQueue<StreamChunk>(),
      index: -1,
      activeType: null,
      activeText: '',
      outputChars: 0,
      activeToolCall: undefined,
      hasCard: false,
      // A segment opened DURING an ambient wait (never the steered first step,
      // which marks its own) inherits the suppression: the drain's tools still
      // stay transcript-only until the turn closes. A detached-worker hold
      // suppresses its cards for the same reason, and a PARKED hold must
      // suppress from the first replayed update on — the drain's TaskOutput
      // arrives in exactly that step.
      ambient: this.awaitingAmbient !== undefined
        || this.backgroundHold !== undefined
        || this.pendingBackgroundHold !== undefined,
      cardSettled: false,
      finished: false,
    }
    this.segment = seg
    const entries = this.session.transcript.since(this.cursorSeq)
    for (const entry of entries) {
      if (seg.finished) break
      const update = entry.update as Record<string, unknown>
      // The same split the live path makes: a background drain's prose is not
      // this turn's answer, even when it landed while no step was open. The
      // record (tool outputs) still goes in; the cursor moves past it.
      if (this.isForeignAmbientText(update)) {
        this.recordWithoutSegment(update)
        this.cursorSeq = entry.seq
        continue
      }
      if (!this.foldInto(seg, update, entry.seq)) break
      this.cursorSeq = entry.seq
    }
    if (!seg.finished && this.pendingProse.length > 0) {
      // Narrative that arrived between segments (a permission ask during card
      // execution): it belongs to the turn's story, so it opens this segment.
      const lines = this.pendingProse.splice(0, this.pendingProse.length).join('')
      this.emitProse(seg, 'reasoning', lines)
    }
    const parkedHold = this.pendingBackgroundHold
    if (parkedHold !== undefined && !seg.finished) {
      // The host opened the continuation step for the Agent card: the hold
      // finally has a driver step to speak the drain's answer into.
      this.adoptBackgroundHold(seg, parkedHold)
    }
    if (this.settled) this.finishAfterSettle(seg)
    return seg
  }

  /** Finish the segment on air (if any). Used by cancel paths and teardown. */
  finishActive(reason: SegmentFinishReason): void {
    if (this.segment !== undefined) this.finishSegment(this.segment, reason)
  }

  /** Whether this turn already streamed prose of its own (not a drain's). */
  get hasAgentProse(): boolean {
    return this.sawAgentProse
  }

  /**
   * Keep the turn open for a background drain the agent folded our prompt into.
   *
   * THE SHAPE: the agent answered `session/prompt` at once (CodeBuddy returns
   * `end_turn` in ~14ms when it merges the message into a drain it is already
   * running) and the real answer streams afterwards under the DRAIN's request
   * id. Closing on the response would cut the turn before its text exists —
   * which is exactly the bug this state exists for. So:
   *
   * - the agent-side prompt slot is released (`endTurn`: the response HAS
   *   landed) but the turn is NOT settled: `settled` means "the turn is over",
   *   and it is not — no `turn/end`, no `running = false`, no segment close;
   * - the segment keeps folding the session's updates, with cards suppressed
   *   (see `SegmentState.ambient`): the host must not execute a background
   *   tool for a turn whose answer has not begun;
   * - any update on the session resets the quiet clock, and the drain's end is
   *   its silence (a `session_end` is rejected by the SDK's schema and never
   *   reaches us — never wait for one); a hard ceiling closes what never ends.
   */
  awaitAmbient(requestId: string, stopReason: string): void {
    if (this.settled || this.disposed || this.awaitingAmbient !== undefined) return
    const seg = this.segment
    if (seg === undefined || seg.finished) {
      // No live driver step to speak into: nothing can be folded, so close the
      // turn the ordinary way rather than holding state that renders nothing.
      this.clearPendingAmbient()
      this.settle({ kind: 'stop', stopReason })
      return
    }
    seg.ambient = true
    // The response landed: the agent no longer holds a prompt for this turn.
    this.endTurn()
    // The drain may have spoken BEFORE the response was judged. Those updates
    // were withheld while this turn's own request id was unknowable (see
    // `pendingAmbientUpdates`); the turn IS the drain, so they are its answer —
    // folded in arrival order, now that `seg.ambient` suppresses their cards.
    this.flushPendingAmbient(seg)
    if (seg.finished) {
      this.settle({ kind: 'stop', stopReason })
      return
    }
    const wait: AmbientWait = {
      requestId,
      quietTimer: setTimeout(() => { this.onAmbientQuiet(wait) }, this.ambientTuning.quietMs),
      hardTimer: setTimeout(() => { this.onAmbientHard(wait) }, this.ambientTuning.maxMs),
      stopReason,
    }
    wait.quietTimer.unref?.()
    wait.hardTimer.unref?.()
    this.awaitingAmbient = wait
  }

  /**
   * The prompt response named no conversation turn while a drain the session
   * retired recently may still be running (and did not re-announce): the turn
   * cannot be held open, but a zero-output report must not blame the agent.
   * See `hasRecentRetiredAmbient` for the window.
   */
  noteRecentRetiredDrain(): void {
    this.recentRetiredDrain = true
  }

  /**
   * Whether the prompt response should keep this turn open for a detached
   * worker.
   *
   * With `backgroundHoldWorkerPhase` (a deployment tuning key) the answer is
   * whenever any dispatch is still running OR a detached one already reported
   * and left its drain pending. Without it, a RUNNING worker does not hold the
   * turn: the user keeps talking while it runs, and its report lands in the
   * transcript / NTR view. Only the short last window — every dispatch reported
   * and a detached one emitted worker updates, so the drain carrying the report
   * is imminent — is held.
   *
   * A synchronous `Agent` / `Task` call (completed, never declared
   * `isBackground`) matches neither and closes normally.
   */
  detachedHoldWanted(holdWorkerPhase: boolean): boolean {
    let drainPending = false
    for (const toolCallId of this.turnDispatchIds) {
      const dispatch = this.dispatches.get(toolCallId)
      if (dispatch === undefined) continue
      if (!dispatch.completed) {
        if (!holdWorkerPhase) return false
        return true
      }
      if (dispatch.detached && dispatch.sawWorkerUpdate) drainPending = true
    }
    return drainPending
  }

  /** A dispatch created while this turn was on air: the only work a hold waits for. */
  noteTurnDispatch(toolCallId: string): void {
    this.turnDispatchIds.add(toolCallId)
  }

  /** The hold this turn is inside — adopted, or parked waiting for a step. */
  private activeBackgroundHold(): BackgroundHold | undefined {
    return this.backgroundHold ?? this.pendingBackgroundHold
  }

  /** Every dispatch THIS TURN knows about reported (no dispatch counts as done). */
  private allDispatchesCompleted(): boolean {
    for (const toolCallId of this.turnDispatchIds) {
      const dispatch = this.dispatches.get(toolCallId)
      if (dispatch !== undefined && !dispatch.completed) return false
    }
    return true
  }

  /**
   * Hold the turn open for the detached worker(s) its `Agent` tool calls
   * dispatched — the second controlled ambient-family exception (constraint
   * 23), not a new idle watchdog.
   *
   * THE SHAPE (measured against CodeBuddy 2.179.0, multitask on): the
   * coordinator opens an `Agent` call that hands work to a background worker,
   * says "已派…", and the `session/prompt` RESPONSE arrives normally while the
   * worker keeps running. The worker's own updates (requestId B +
   * `parentToolCallId`) never touch this session's message; when it finishes,
   * the agent starts a background DRAIN (requestId A — the response's own
   * `conversationRequestId`) whose steps carry the report and the final answer.
   * Nothing tells the client the worker is running: no `session_end` (the SDK's
   * schema rejects it) and an `agentPhase` idle tick even fires BETWEEN the
   * worker and the drain. So the response cannot close the turn.
   *
   * The hold:
   * - releases the agent-side prompt slot (`endTurn`: the response landed)
   *   while keeping `running` and the driver step open;
   * - marks the segment background, so EVERY tool call for the rest of the
   *   hold — the workers', the drain's TaskOutput — stays transcript-only and
   *   the final message carries text with no card in front of it;
   * - waits in two phases: the worker phase's clock is a SILENCE window
   *   ({@link BridgeTuning.backgroundTaskMaxMs}) that every dispatch / worker
   *   update pushes out, so a long task that keeps reporting is never cut at a
   *   fixed total runtime. It ends when ALL known dispatches reported, after
   *   which the drain phase uses the ambient windows. An optional absolute
   *   ceiling ({@link BridgeTuning.backgroundTaskCeilingMs}, default none)
   *   bounds a zombie that keeps talking forever.
   */
  holdForBackgroundDispatch(stopReason: string, requestId?: string): void {
    if (this.settled || this.disposed || this.closedTurn || this.stale) return
    if (this.activeBackgroundHold() !== undefined) return
    const hold: BackgroundHold = {
      stopReason,
      requestId,
      acceptedIds: new Set<string>(),
      phase: 'worker',
      answerChars: 0,
      floorSeq: this.session.transcript.head,
      retired: false,
    }
    if (requestId !== undefined) hold.acceptedIds.add(requestId)
    // A drain announced while this turn was ALREADY on air belongs to it (the
    // announcement may have named a different id than the response). One that
    // predates the turn is some earlier run's, and folding its text would mix
    // two answers.
    const announced = this.session.ambient
    if (announced !== undefined && announced.startedAt >= this.constructedAt) {
      hold.acceptedIds.add(announced.requestId)
      if (hold.requestId === undefined) hold.requestId = announced.requestId
    }
    // The response landed: the agent no longer holds a prompt for this turn.
    this.endTurn()
    hold.hardTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.backgroundSilenceMs())
    hold.hardTimer.unref?.()
    this.armBackgroundCeiling(hold)
    const seg = this.segment
    if (seg !== undefined && !seg.finished) {
      this.adoptBackgroundHold(seg, hold)
    } else {
      // The response landed BETWEEN driver steps: the host is about to execute
      // the Agent card and open its continuation step. Park the hold for that
      // step, with a bounded wait — a host that never opens one must not hang
      // the turn forever.
      hold.graceTimer = setTimeout(() => { this.onBackgroundGraceExpired(hold) }, this.backgroundTuning.graceMs)
      hold.graceTimer.unref?.()
      this.pendingBackgroundHold = hold
    }
    // A FAST detached worker may already have reported (even before the
    // response): with every known dispatch complete there is no worker phase
    // left to wait out, so the drain phase starts now.
    if (this.allDispatchesCompleted()) this.startBackgroundDrain(hold)
  }

  /** Give a (possibly parked) hold a driver segment: cards off for the rest of it. */
  private adoptBackgroundHold(seg: SegmentState, hold: BackgroundHold): void {
    if (hold.graceTimer !== undefined) {
      clearTimeout(hold.graceTimer)
      hold.graceTimer = undefined
    }
    if (this.pendingBackgroundHold === hold) this.pendingBackgroundHold = undefined
    seg.ambient = true
    this.backgroundHold = hold
    // The drain may have spoken BEFORE the response was judged. Those updates
    // were withheld while this turn's own id was unknown
    // (`pendingAmbientUpdates`); only the runs THIS hold owns are its answer —
    // another run's withheld text is dropped (the transcript keeps it).
    this.flushBackgroundHoldUpdates(seg, hold)
    // The parked grace owns the wait while no step is on air; now that one is,
    // a hold whose drain phase already began arms its quiet clock.
    if (hold.phase === 'drain') this.armBackgroundQuiet(hold)
  }

  /**
   * The worker phase is over once EVERY known dispatch reported: the drain
   * that carries their reports is (about to be) running, so the existing
   * ambient windows take over, measured from HERE.
   *
   * An announced run is accepted immediately, but while any dispatch is still
   * incomplete it only records the id and switches the hold's primary run —
   * arming the quiet clock there would let a drain that spoke early cut the
   * turn off before its other worker ever reports.
   */
  private startBackgroundDrain(hold: BackgroundHold, requestId?: string): void {
    if (hold !== this.backgroundHold && hold !== this.pendingBackgroundHold) return
    if (requestId !== undefined) {
      hold.acceptedIds.add(requestId)
      hold.requestId = requestId
    }
    if (!this.allDispatchesCompleted()) return
    if (hold.phase === 'drain') {
      if (this.backgroundHold === hold) this.armBackgroundQuiet(hold)
      return
    }
    hold.phase = 'drain'
    if (hold.hardTimer !== undefined) clearTimeout(hold.hardTimer)
    hold.hardTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.ambientTuning.maxMs)
    hold.hardTimer.unref?.()
    // A parked hold belongs to the grace until a driver step opens; a hold
    // with a step arms its quiet clock now.
    if (this.backgroundHold === hold) this.armBackgroundQuiet(hold)
  }

  /**
   * A dispatch that lands while the drain phase already began means the
   * coordinator handed out NEW work: the worker phase is back, and with it the
   * absence of a quiet window.
   */
  private enterBackgroundWorkerPhase(hold: BackgroundHold): void {
    if (hold.phase === 'worker') return
    hold.phase = 'worker'
    if (hold.quietTimer !== undefined) {
      clearTimeout(hold.quietTimer)
      hold.quietTimer = undefined
    }
    if (hold.hardTimer !== undefined) clearTimeout(hold.hardTimer)
    hold.hardTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.backgroundSilenceMs())
    hold.hardTimer.unref?.()
  }

  /** Push the drain phase's quiet clock out: every update is evidence of work. */
  private armBackgroundQuiet(hold: BackgroundHold): void {
    if (hold.quietTimer !== undefined) clearTimeout(hold.quietTimer)
    hold.quietTimer = setTimeout(() => { this.onBackgroundQuiet(hold) }, this.ambientTuning.quietMs)
    hold.quietTimer.unref?.()
  }

  /**
   * Evidence from a live dispatch / worker: the worker phase is SILENCE-based,
   * so each update pushes its deadline out. A long task that keeps reporting is
   * never cut at a fixed total runtime; only a genuinely quiet worker is.
   */
  private noteBackgroundWorkerActivity(): void {
    const hold = this.activeBackgroundHold()
    if (hold === undefined || hold.phase !== 'worker' || hold.retired) return
    if (hold.hardTimer !== undefined) clearTimeout(hold.hardTimer)
    hold.hardTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.backgroundSilenceMs())
    hold.hardTimer.unref?.()
  }

  /**
   * The worker phase's silence window, by the worker's LAST KNOWN state: an
   * open worker tool call gets the long tier (`toolMaxMs`), an idle one the
   * short tier (`taskMaxMs`). Same shape as the main turn's
   * `turnStallMs` / `turnStallToolMs` pair.
   */
  private backgroundSilenceMs(): number {
    return this.workerToolCalls.size > 0 ? this.backgroundTuning.toolMaxMs : this.backgroundTuning.taskMaxMs
  }

  /** Arm the hold's optional absolute ceiling (0 = unlimited). */
  private armBackgroundCeiling(hold: BackgroundHold): void {
    if (this.backgroundTuning.ceilingMs <= 0) return
    hold.ceilingTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.backgroundTuning.ceilingMs)
    hold.ceilingTimer.unref?.()
  }

  /**
   * Any session update restarts the drain phase's quiet clock. Only an
   * ADOPTED hold has a quiet clock: a parked hold's wait belongs to its grace
   * timer, and the worker phase is pushed forward only by dispatch / worker
   * evidence (see `noteBackgroundWorkerActivity`).
   */
  private noteBackgroundHoldActivity(): void {
    const hold = this.backgroundHold
    if (hold === undefined || hold.phase !== 'drain') return
    this.armBackgroundQuiet(hold)
  }

  /** The drained run went quiet: the turn ends with the stop reason the response gave. */
  private onBackgroundQuiet(hold: BackgroundHold): void {
    if (this.backgroundHold !== hold || hold.phase !== 'drain') return
    this.closeBackgroundHold(hold, { hard: false })
  }

  /** The hold went silent past its window, or outlived the absolute ceiling. */
  private onBackgroundHard(hold: BackgroundHold): void {
    if (hold !== this.backgroundHold && hold !== this.pendingBackgroundHold) return
    // The ceiling is the evidence the worker (or its drain) never finished:
    // a row that keeps `running` here would pin the idle clock forever.
    this.manager.terminalizeSessionDispatches(this.session, 'unknown')
    this.closeBackgroundHold(hold, { hard: true })
  }

  /**
   * No driver step opened inside the grace: the host is not coming back for
   * this turn's Agent card. Close it the way a quiet ambient ending does — the
   * deferral line, never the zero-output blame — and keep ONE drain record:
   * the worker may still report into a run no turn is waiting on.
   *
   * A parked hold has NO segment by definition, so the chat plane has nowhere
   * to put the deferral line: it goes to the settings log (`agent/notice`)
   * instead of being parked on prose nobody will read.
   */
  private onBackgroundGraceExpired(hold: BackgroundHold): void {
    if (this.pendingBackgroundHold !== hold) return
    this.pendingBackgroundHold = undefined
    // No step came back for this turn: nobody is left to read a report, so the
    // unfinished rows must not stay `running` (they would pin the idle clock).
    this.manager.terminalizeSessionDispatches(this.session, 'unknown')
    this.clearBackgroundHoldTimers(hold)
    const line = hold.answerChars > 0 ? undefined : backgroundDeferralLine(this.session.agentId)
    this.releaseBackgroundHoldIds(hold, { hard: true })
    if (line !== undefined) this.broadcastBackgroundDeferral(line)
    this.closeTurn({ kind: 'stop', stopReason: hold.stopReason }, { line, keepAmbient: true, requestId: hold.requestId })
  }

  /**
   * Close a detached-worker hold exactly once. A turn that folded NO answer
   * text from its held runs says where the rest of the output will land (the
   * deferral wording, never the silent-failure blame); the parent's interim
   * acknowledgement does not count as that answer.
   *
   * Ownership of the drain ids at close (`releaseBackgroundHoldIds`): a quiet
   * close retires every accepted id and drops the session record; a hard or
   * grace close keeps exactly ONE record, because the run is provably still
   * going and a later update or re-announcement must revive it normally.
   */
  private closeBackgroundHold(hold: BackgroundHold, options: { hard: boolean }): void {
    if (this.pendingBackgroundHold === hold) this.pendingBackgroundHold = undefined
    else if (this.backgroundHold === hold) this.backgroundHold = undefined
    else return
    this.clearBackgroundHoldTimers(hold)
    const line = hold.answerChars > 0 ? undefined : backgroundDeferralLine(this.session.agentId)
    this.releaseBackgroundHoldIds(hold, { hard: options.hard })
    const onAir = this.segment !== undefined && !this.segment.finished
    // With no segment on air the closing line has no chat bubble to land in:
    // log it, so the fact is recorded rather than silently dropped.
    if (line !== undefined && !onAir) this.broadcastBackgroundDeferral(line)
    this.closeTurn(
      { kind: 'stop', stopReason: hold.stopReason },
      { line, keepAmbient: options.hard, requestId: hold.requestId },
    )
  }

  /** Write a hold's deferral line into the settings log (`agent/notice`). */
  private broadcastBackgroundDeferral(line: string): void {
    this.hub.broadcast({
      type: 'agent/notice',
      agentId: this.session.agentId,
      level: 'info',
      text: line.trim(),
    })
  }

  /** Drop a hold's clocks. The hold object itself stays for its `retired` mark. */
  private clearBackgroundHoldTimers(hold: BackgroundHold): void {
    if (hold.quietTimer !== undefined) clearTimeout(hold.quietTimer)
    if (hold.hardTimer !== undefined) clearTimeout(hold.hardTimer)
    if (hold.ceilingTimer !== undefined) clearTimeout(hold.ceilingTimer)
    if (hold.graceTimer !== undefined) clearTimeout(hold.graceTimer)
    hold.quietTimer = undefined
    hold.hardTimer = undefined
    hold.ceilingTimer = undefined
    hold.graceTimer = undefined
  }

  /**
   * Drop every hold clock (teardown / a forced ending). `retire` also gives up
   * every accepted run id — a SUCCESSOR turn must never fold the abandoned
   * hold's drain or worker text into its own answer.
   */
  private clearBackgroundHold(options?: { retire?: boolean }): void {
    const pending = this.pendingBackgroundHold
    if (pending !== undefined) {
      this.pendingBackgroundHold = undefined
      this.clearBackgroundHoldTimers(pending)
      if (options?.retire === true) this.releaseBackgroundHoldIds(pending, { hard: false })
    }
    const hold = this.backgroundHold
    if (hold === undefined) return
    this.backgroundHold = undefined
    this.clearBackgroundHoldTimers(hold)
    if (options?.retire === true) this.releaseBackgroundHoldIds(hold, { hard: false })
  }

  /**
   * Settle what happens to the session's drain records when a hold closes.
   *
   * `hard: false` (quiet close, cancel, teardown): the run is no longer waited
   * on, so EVERY accepted id is retired — its late text stays transcript-only
   * for whatever turn runs next — and the session record is dropped if it
   * names one of them.
   *
   * `hard: true` (ceiling / parked grace): the run is provably still going.
   * Exactly ONE record survives — the session's current drain if it has one,
   * else the hold's primary run — with its activity clock refreshed; the other
   * accepted ids are retired. A hold whose primary id had no session record
   * CREATES one, so a successor's `noteTurnRequestId` cannot adopt that id.
   * Every accepted id therefore ends up either retired or owned by
   * `session.ambient`; never both unowned and unretired.
   */
  private releaseBackgroundHoldIds(hold: BackgroundHold, options: { hard: boolean }): void {
    if (hold.retired) return
    hold.retired = true
    if (!options.hard) {
      // `consume` mirrors the quiet-close rule in `closeTurn`: an id is marked
      // consumed only when the hold actually SHOWED the run's answer text. A
      // zero-answer close printed just the deferral line — the answer was never
      // delivered, so a revived run must still be able to wake the chat.
      for (const id of hold.acceptedIds) retireAmbientId(this.session, id, hold.answerChars > 0)
      if (this.session.ambient !== undefined && hold.acceptedIds.has(this.session.ambient.requestId)) {
        this.session.ambient = undefined
      }
      return
    }
    const survivor = this.session.ambient?.requestId ?? hold.requestId
    for (const id of hold.acceptedIds) {
      if (id === survivor) continue
      retireAmbientId(this.session, id)
    }
    if (survivor === undefined) return
    const now = Date.now()
    if (this.session.ambient?.requestId === survivor) {
      this.session.ambient.lastActivityAt = now
    } else {
      this.session.ambient = {
        requestId: survivor,
        startedAt: now,
        lastActivityAt: now,
        sawOutput: hold.answerChars > 0,
      }
    }
    // The surviving run is alive, not retired (an earlier wait of this turn
    // may have retired it before it spoke again).
    reviveAmbientId(this.session, survivor)
  }

  /**
   * Fold the withheld drain updates that belong to this hold into its segment.
   * The rest of the buffer was some OTHER run's text: it is dropped here (the
   * transcript keeps it), never leaked into this turn's answer.
   */
  private flushBackgroundHoldUpdates(seg: SegmentState, hold: BackgroundHold): void {
    if (this.pendingAmbientUpdates.length === 0) {
      this.pendingAmbientTruncated = false
      return
    }
    const pending = this.pendingAmbientUpdates.splice(0, this.pendingAmbientUpdates.length)
    this.pendingAmbientChars = 0
    const truncated = this.pendingAmbientTruncated
    this.pendingAmbientTruncated = false
    const accepted = pending.filter(entry => {
      const requestId = codebuddyMetaOf(entry.update)?.requestId
      return requestId !== undefined && hold.acceptedIds.has(requestId)
    })
    if (accepted.length === 0) return
    if (truncated && !seg.finished) {
      // The front of the drain's output was evicted from the bounded buffer:
      // say so rather than letting the turn quietly start mid-story.
      this.emitProse(seg, 'text', '\n[dsh-ntr] background output was truncated; the ACP transcript view still has every update.\n')
    }
    for (const entry of accepted) {
      if (seg.finished) break
      this.foldInto(seg, entry.update, entry.seq)
      // The buffered drain text arrived BEFORE the hold, but it IS the held
      // run's answer: below the hold's floor it was not counted by `foldInto`,
      // so count it here (the floor exists to skip the parent's earlier ack,
      // not the drain's own words).
      if (entry.seq <= hold.floorSeq
        && String(entry.update.sessionUpdate ?? '') === 'agent_message_chunk') {
        hold.answerChars += chunkTextOf(entry.update.content).length
      }
    }
  }

  /**
   * A session-level dispatch frame landed. A live hold pushes its worker
   * silence clock; once every known dispatch reported, the hold moves to its
   * drain phase.
   */
  onBackgroundDispatchFrame(): void {
    this.noteBackgroundWorkerActivity()
    const held = this.activeBackgroundHold()
    if (held === undefined) return
    if (!this.allDispatchesCompleted()) {
      // New work handed out after the drain phase began: the worker phase (and
      // its silence window) is back, so no drain quiet clock may cut the turn.
      this.enterBackgroundWorkerPhase(held)
      return
    }
    this.startBackgroundDrain(held)
  }

  /** The agent announced the drain that carries a detached worker's report. */
  onBackgroundDrainAnnounced(requestId: string): void {
    const held = this.activeBackgroundHold()
    if (held === undefined) return
    this.noteBackgroundWorkerActivity()
    this.startBackgroundDrain(held, requestId)
  }

  /** Every known dispatch reported: a live hold moves to its drain phase. */
  onAllDispatchesCompleted(): void {
    if (!this.allDispatchesCompleted()) return
    const held = this.activeBackgroundHold()
    if (held !== undefined) this.startBackgroundDrain(held)
  }

  /**
   * A worker's own tool call moved: the long-tier silence evidence for a
   * worker-phase hold (see `backgroundSilenceMs`). No-op for a turn that is
   * already closed (the worker now reports through the session record).
   */
  onWorkerToolCall(kind: string, toolCallId: string, status: string): void {
    if (toolCallId === '' || (kind !== 'tool_call' && kind !== 'tool_call_update')) return
    if (status === 'completed' || status === 'failed') this.workerToolCalls.delete(toolCallId)
    else if (status === 'pending' || status === 'in_progress') this.workerToolCalls.add(toolCallId)
    else if (kind === 'tool_call' && status === '') this.workerToolCalls.add(toolCallId)
    // The set decides the NEXT window's tier, so the silence clock has to be
    // re-armed with the new tier now (a worker entering a long tool switches
    // the hold from the short tier to the long one).
    this.noteBackgroundWorkerActivity()
  }

  /** Any session update is evidence the drain still works: push the quiet clock out. */
  private noteAmbientActivity(): void {
    const wait = this.awaitingAmbient
    if (wait === undefined) return
    clearTimeout(wait.quietTimer)
    wait.quietTimer = setTimeout(() => { this.onAmbientQuiet(wait) }, this.ambientTuning.quietMs)
    wait.quietTimer.unref?.()
  }

  /** The drain went quiet: the turn ends with the stop reason the response gave. */
  private onAmbientQuiet(wait: AmbientWait): void {
    if (this.awaitingAmbient !== wait) return
    this.finishAmbient(wait)
  }

  /** The drain outlived the ceiling: say where the rest will land, then close. */
  private onAmbientHard(wait: AmbientWait): void {
    if (this.awaitingAmbient !== wait) return
    const seg = this.segment
    if (seg !== undefined && !seg.finished) {
      this.emitProse(seg, 'text', `\n[dsh-ntr] agent "${this.session.agentId}" is still running a background task; the rest of its output will appear in the ACP transcript view.\n`)
    }
    // The ceiling is evidence the drain is STILL RUNNING (unlike a quiet close),
    // so the ending keeps the session's drain record; see `closeTurn`.
    wait.hard = true
    // The hard explanation already says the turn was cut short; the deferred
    // line would only repeat it in different words.
    this.finishAmbient(wait, { announceDeferral: false })
  }

  /**
   * Close an ambient wait exactly once. A turn that produced no answer TEXT
   * says so: the drain's output is in the ACP transcript view, and this
   * bubble must not be empty (the zero-output report, reworded for a turn that
   * was deferred rather than failed).
   */
  private finishAmbient(wait: AmbientWait, options?: { announceDeferral?: boolean }): void {
    if (this.awaitingAmbient !== wait) return
    const line = options?.announceDeferral === false || this.sawVisibleText
      ? undefined
      : backgroundDeferralLine(this.session.agentId)
    this.closeTurn(
      { kind: 'stop', stopReason: wait.stopReason },
      { line, keepAmbient: wait.hard === true, requestId: wait.requestId },
    )
  }

  /** Drop the ambient wait's clocks (the turn is being closed by someone else). */
  private clearAmbientWait(): void {
    const wait = this.awaitingAmbient
    if (wait === undefined) return
    this.awaitingAmbient = undefined
    clearTimeout(wait.quietTimer)
    clearTimeout(wait.hardTimer)
  }

  /**
   * Withhold one background-drain update until the prompt response says what
   * this turn is. The cursor advances past it anyway: it is already in the
   * transcript, and replaying it into a later segment would emit it twice.
   * Bounded (see `PENDING_AMBIENT_MAX_*`) — the transcript still keeps every
   * entry the buffer drops.
   */
  private bufferAmbientUpdate(seq: number, update: Record<string, unknown>): void {
    const chars = JSON.stringify(update).length
    this.pendingAmbientUpdates.push({ seq, update, chars })
    this.pendingAmbientChars += chars
    while (this.pendingAmbientUpdates.length > PENDING_AMBIENT_MAX_ENTRIES
      || (this.pendingAmbientChars > PENDING_AMBIENT_MAX_CHARS && this.pendingAmbientUpdates.length > 1)) {
      const dropped = this.pendingAmbientUpdates.shift()
      if (dropped === undefined) break
      this.pendingAmbientChars -= dropped.chars
      this.pendingAmbientTruncated = true
    }
  }

  /** Fold the withheld drain updates into the now-ambient segment, once, in order. */
  private flushPendingAmbient(seg: SegmentState): void {
    if (this.pendingAmbientUpdates.length === 0) {
      this.pendingAmbientTruncated = false
      return
    }
    const truncated = this.pendingAmbientTruncated
    this.pendingAmbientTruncated = false
    const pending = this.pendingAmbientUpdates.splice(0, this.pendingAmbientUpdates.length)
    this.pendingAmbientChars = 0
    if (truncated && !seg.finished) {
      // The front of the drain's output was evicted from the bounded buffer:
      // say so rather than letting the turn quietly start mid-story.
      this.emitProse(seg, 'text', '\n[dsh-ntr] background output was truncated; the ACP transcript view still has every update.\n')
    }
    for (const entry of pending) {
      if (seg.finished) break
      this.foldInto(seg, entry.update, entry.seq)
    }
  }

  /** Drop withheld drain updates: this turn is not the drain, or it is closing. */
  private clearPendingAmbient(): void {
    this.pendingAmbientUpdates.length = 0
    this.pendingAmbientChars = 0
    this.pendingAmbientTruncated = false
  }

  /** The agent settled its `session/prompt`. Ends the turn's streaming face. */
  settle(outcome: TurnSettle): void {
    if (this.settled) return
    // `settled` is claimed NOW (a second settle, a cancel or a watchdog that
    // races the tail drain must find the turn already spoken for), but the
    // CLOSING work waits one macrotask: the SDK dispatches `session/update`
    // notifications independently of the `session/prompt` RESPONSE, so the
    // agent's last chunks can still be queued when this lands (see
    // `settleTranscript`). Only what already reached the transcript is read —
    // one macrotask, never an open-ended wait.
    this.settled = true
    this.clearAmbientWait()
    this.clearPendingAmbient()
    // An outside ending (watchdog, cancel) abandons a detached-worker hold: its
    // run is no longer this turn's, so its id is retired before the close.
    this.clearBackgroundHold({ retire: true })
    this.pendingOutcome = outcome
    this.closeScheduled = true
    setImmediate(() => { this.flushScheduledClose() })
  }

  /**
   * Force the local end of this turn — the cancel fallback and any watchdog
   * that reached the controller. Runs the SAME closing work as a normal settle
   * (`closeTurn`): the ambient clocks stop, the on-air segment closes (so the
   * driver step parked on its queue ends), exactly one `turn/end` goes out
   * with THIS turn's id, the session stops running and the prompt slot is
   * released. Idempotent: a turn that already closed ignores the call.
   */
  forceFinalize(outcome: TurnSettle): void {
    if (this.stale || this.closedTurn) return
    this.clearAmbientWait()
    // A forced ending abandons a detached-worker hold: retire its run's id so
    // its late words stay transcript-only for the next turn.
    this.clearBackgroundHold({ retire: true })
    // A settle's deferred tail read is moot once this close runs: the turn is
    // over now, and the pending macrotask must not drain anything into it.
    this.pendingOutcome = undefined
    this.closeScheduled = false
    this.closeTurn(outcome)
  }

  /**
   * Run the deferred closing work now, when a driver step is about to open on
   * an already settled turn: the continuation step must see the closed turn
   * (and the session NOT left `running` across the macrotask boundary).
   * Idempotent — the scheduled tick then finds nothing left to do.
   */
  private flushScheduledClose(): void {
    if (!this.closeScheduled) return
    this.closeScheduled = false
    const outcome = this.pendingOutcome
    this.pendingOutcome = undefined
    if (outcome === undefined) return
    // A DISPOSE that raced this queued close cleared it (see `dispose`), so a
    // close still scheduled here belongs to a settle that landed AFTER the
    // stream was retired (a crash rejects its prompt only after the teardown).
    // That turn still ends through its own queue and real id — the teardown's
    // releaseAll frame carried an empty id.
    this.drainTail()
    this.closeTurn(outcome)
  }

  /**
   * Fold the notifications that reached the transcript but not the segment:
   * the tail a response raced past. Stops AT a cutting event without consuming
   * it (same rule as `startSegment`) — its next segment is not this turn's.
   */
  private drainTail(): void {
    // The deferred read belongs to the turn that scheduled it. If the turn was
    // retired or a NEWER turn already began (turnSeq moved on) in this one
    // macrotask window, everything past the cursor is the successor's: folding
    // it here would leak its text into this turn's driver step.
    if (this.stale) return
    const seg = this.segment
    if (seg === undefined || seg.finished) return
    for (const entry of this.session.transcript.since(this.cursorSeq)) {
      if (seg.finished) break
      const update = entry.update as Record<string, unknown>
      // The same split the live path makes: a background drain's text in the
      // tail is not this turn's answer. Record what the registry needs (tool
      // outputs), move the cursor past it, and do NOT fold it — otherwise the
      // deferred read smuggles the drain's prose into a normal turn.
      if (this.isForeignAmbientText(update)) {
        this.recordWithoutSegment(update)
        this.cursorSeq = entry.seq
        continue
      }
      if (!this.foldInto(seg, update, entry.seq)) break
      this.cursorSeq = entry.seq
    }
  }

  /**
   * End the turn exactly once: burst metrics, ONE `turn/end`, the provisional
   * lock, the closing text, the segment, the session flags, the prompt slot.
   *
   * `ambient.line` marks a controlled ambient ending: the given line closes
   * the segment when the turn carried no answer text, instead of the generic
   * zero-output warning (which would blame the agent for a turn the drain
   * simply had not finished yet). `ambient.keepAmbient` says the ending was the
   * CEILING, not silence: see the drain-record comment below.
   */
  private closeTurn(outcome: TurnSettle, ambient?: { line?: string; keepAmbient?: boolean; requestId?: string }): void {
    if (this.closedTurn) return
    this.closedTurn = true
    // A closed turn is a settled turn, whichever path got here first (an
    // ambient ending does not go through `settle`).
    this.settled = true
    this.clearAmbientWait()
    this.clearPendingAmbient()
    // Whoever closed this turn already decided what happens to the held
    // run's record (`closeBackgroundHold` retired or kept it); only the clocks
    // are still ours to drop.
    this.clearBackgroundHold()
    // A worker that is still running is NOT terminalized here: it outlives
    // this turn (see `LiveSession.backgroundDispatches`), and only a session
    // teardown writes `unknown` for it. The turn closing is not evidence the
    // worker stopped.
    // A late answer to a SUPERSEDED turn still has to close this controller's
    // queue (a continuation step may be parked on it) and its settle gate —
    // but it must not touch the session the NEWER turn now owns, nor release
    // process-wide waiters that belong to that turn.
    const current = this.session.turnSeq === this.turnSeqAtStart
    if (current) {
      // A user cancel stops THIS turn's workers on the agent side too, and an
      // ERROR / watchdog ending means the agent stopped responding: neither
      // leaves a worker that can still report. Only this turn's own dispatches
      // are touched — a worker left over from an EARLIER turn may still run.
      if (outcome.kind === 'cancelled') this.manager.terminalizeSessionDispatches(this.session, 'cancelled', this.turnDispatchIds)
      else if (outcome.kind === 'error') this.manager.terminalizeSessionDispatches(this.session, 'unknown', this.turnDispatchIds)
    }
    const reason: SegmentFinishReason = outcome.kind === 'cancelled'
      ? { kind: 'aborted', failure: { message: 'Turn was cancelled', code: 'CANCELLED' } }
      : outcome.kind === 'error'
        ? { kind: 'error', failure: { message: outcome.message, code: outcome.code ?? 'INTERNAL' } }
        : { kind: 'stop' }
    if (current) {
      // An ambient ending that came from SILENCE retires the drain record with
      // its turn: a record that outlives the wait would make the NEXT instant
      // answer with no conversation request id look steered (see
      // `awaitAmbient`), holding a normal turn open for a drain this one
      // already finished waiting on. A HARD ceiling ending is the opposite
      // evidence — the drain was still ticking when the turn was cut — so the
      // record SURVIVES (activity clock refreshed; `ambientStaleMs` expires it
      // lazily) precisely so the next prompt folded into the same drain is
      // still recognised as steered. `ambientNotices` is never cleared here:
      // a repeated announcement of the same run must stay silent, and the set
      // is bounded where entries are added.
      if (ambient !== undefined) {
        if (ambient.keepAmbient === true) {
          if (this.session.ambient !== undefined) this.session.ambient.lastActivityAt = Date.now()
        } else {
          // Silence closed this wait, but silence is not proof the run ended: a
          // queued message or a long tool can make the drain speak again. So
          // RETIRE its id before dropping the record — a revived run's late
          // text must stay in the ACP transcript view instead of teaching the
          // NEXT turn the drain's id and mixing the drain's answer into the
          // user's (a double answer). The trade-off is deliberate: a next
          // prompt the agent folds into that same revived drain may not receive
          // the drain's text on the chat plane (transcript-only); a double
          // answer is worse.
          //
          // `consume` is evidence-based and PER RUN (see `foldedDrainIds`): an
          // id is marked consumed only when this turn actually FOLDED that
          // run's visible answer. A zero-output close (just the deferral line
          // above) delivered nothing — same reasoning as the stale expiry's
          // `consume: false` — so the id stays unconsumed and a run that revives
          // with the real answer can still wake the chat.
          if (ambient.requestId !== undefined) retireAmbientId(this.session, ambient.requestId, this.foldedDrainIds.has(ambient.requestId))
          // Runs this turn folded whose id the retire above did not cover (the
          // ambient record moved to another run mid-turn): their answers WERE
          // delivered, so consume them too — a revived run must never answer
          // the same text a second time.
          for (const id of this.foldedDrainIds) {
            if (id !== ambient.requestId) retireAmbientId(this.session, id, true)
          }
          this.session.ambient = undefined
        }
      }
      // The turn's burst aggregate must be visible before the turn is marked
      // over: the final `turn/metrics` lands first, then `turn/end` flips the
      // session/pill state. Persisting and broadcasting share one value.
      this.finalizeTps()
      if (outcome.kind === 'cancelled') {
        this.hub.broadcast({ type: 'turn/end', sessionId: this.session.sessionId, turnId: this.turnId, stopReason: 'cancelled' })
      } else if (outcome.kind === 'error') {
        // `errorKind` rides along only when the host classified the failure:
        // a quota refusal is the one error a browser surface acts on (the
        // composer's dock card), so it must not have to re-read the message.
        this.hub.broadcast({
          type: 'turn/end',
          sessionId: this.session.sessionId,
          turnId: this.turnId,
          error: outcome.message,
          ...(outcome.errorKind !== undefined ? { errorKind: outcome.errorKind } : {}),
        })
      } else {
        this.hub.broadcast({ type: 'turn/end', sessionId: this.session.sessionId, turnId: this.turnId, stopReason: outcome.stopReason })
      }
      // The provisional lock settles BEFORE any synthesized warning below: the
      // warning is our text, not evidence that the first turn delivered anything.
      //
      // An AMBIENT ending ends the provisional phase WITHOUT a rollback: a
      // deferral to a background drain is not a failed first turn, the drain's
      // text still lands in the ACP transcript view, and rolling the lock back
      // would close the session under it — dropping exactly the output the
      // deferred turn promised. The lock therefore becomes permanent.
      if (this.session.provisionalLock === true) {
        this.session.provisionalLock = false
        if (!this.sawVisibleBlock && ambient === undefined) this.rollbackFirstTurn(this.session)
      }
    }
    const seg = this.segment
    if (seg !== undefined) {
      // Echo guard flush (Antigravity): a turn that ends while it still holds a
      // strict prefix must not drop it. A normal stop emits what it held
      // (duplicate is better than lost); a cancel / error discards it.
      if (current && this.echoBuffer !== undefined) {
        const held = this.echoBuffer
        this.echoBuffer = undefined
        this.session.lateEcho = undefined
        if (outcome.kind === 'stop' && !seg.finished && held !== '') this.emitProse(seg, 'text', held)
      }
      if (ambient !== undefined) {
        // The ambient line is OUR report, so it only appears when the drain
        // delivered no answer text of its own; reasoning alone does not count.
        if (ambient.line !== undefined && current) this.emitProse(seg, 'text', ambient.line)
      } else if (current && outcome.kind === 'stop' && !this.sawVisibleBlock) {
        // The silent-failure report: a normal stop with nothing the chat
        // plane renders. Aborted or failing turns need no extra hint; this
        // is specifically "protocol says success, the bubble is empty".
        this.emitProse(seg, 'text', this.zeroOutputLine(outcome.stopReason, outcome.refusal))
      }
      this.finishSegment(seg, reason)
    }
    // When no segment is on air (the turn ended on a card) the FINAL
    // continuation step collects the tail: `startSegment` sees `settled` and
    // finishes it with the appropriate closing line.
    if (current) {
      this.session.running = false
      // The turn is over: no call from it can still earn the long tool window.
      this.session.activeToolCalls.clear()
      releaseAllToolOutputWaiters()
      // Publish the turn's own visible answer BEFORE a transcript watch may
      // arm: a late write of exactly this text is not a new background answer.
      // An answer past the bound is published as `undefined` — losing the
      // equality evidence only risks the same text appearing twice, which is
      // the fail-open direction the whole late-output path follows.
      this.session.lastTurnAnswerText = this.turnAnswerOverflow || this.turnAnswerText === ''
        ? undefined
        : this.turnAnswerText
      // Rotate the turn's tool-call ids into the completed-turn set (Antigravity
      // replays them on the next prompt) and start the late-output watch. Only
      // a chat turn that ended on its own can have post-turn work: an ambient
      // close already folded its answer, and a cancel / error owns no promise.
      this.rotateTurnToolCalls()
      if (ambient === undefined && outcome.kind === 'stop') {
        this.manager.armLateOutputWatch(this.session, Date.now())
      }
    }
    this.endTurn()
    // The controller stays indexed only while a continuation step can still
    // come for its cards. A cancelled, failed, or card-less turn has none: retire
    // it now; the next turn's `rememberTurnStream` would anyway. An ambient turn
    // ALWAYS retires: its suppressed calls never open cards, so keeping the index
    // would pin the controller (and its session id) to a turn nobody can continue.
    if (!current) this.retire()
    else if (ambient !== undefined || outcome.kind !== 'stop' || this.seenCalls.size === 0) this.dispose()
  }

  /**
   * Move this turn's tool-call ids into the completed-turn set, so the agent's
   * replay of them on the NEXT prompt opens no second card. Antigravity-only
   * state: a session without the sets is untouched.
   */
  private rotateTurnToolCalls(): void {
    const known = this.session.knownToolCalls
    if (known === undefined) return
    for (const callId of this.session.turnToolCalls ?? []) known.add(callId)
    while (known.size > KNOWN_TOOL_CALL_MAX) {
      const oldest = known.values().next().value
      if (oldest === undefined) break
      known.delete(oldest)
    }
    this.session.turnToolCalls = new Set<string>()
  }

  /**
   * Cancelled by the user: finish the on-air segment and release the turn's
   * slots. An AMBIENT turn has already released the prompt slot (its response
   * landed) and holds no segment the cancel fallback could close, so the
   * cancel closes the turn itself with the cancelled stop.
   */
  abortActiveSegment(): void {
    if (this.stale) return
    this.clearPendingAmbient()
    if (this.closeScheduled) {
      // `settle` claimed the turn but queued its closing work for the next
      // macrotask. An abort landing inside that window must not let the
      // scheduled close broadcast the RESPONSE's stop reason while the segment
      // already finished `aborted`: drop the queued outcome and close NOW with
      // the cancelled one, so `turn/end` and the segment's finish agree.
      this.closeScheduled = false
      this.pendingOutcome = undefined
      this.closeTurn({ kind: 'cancelled' })
      return
    }
    if (this.awaitingAmbient !== undefined) {
      this.settle({ kind: 'cancelled' })
      return
    }
    if (this.backgroundHold !== undefined || this.pendingBackgroundHold !== undefined) {
      // A detached-worker hold is a turn whose prompt response already landed
      // (the slot is free) and whose segment is still open on purpose: the
      // cancel ends OUR face of it now, once, and the held run's id is retired
      // so its late text cannot join the next turn.
      this.clearBackgroundHold({ retire: true })
      this.settle({ kind: 'cancelled' })
      return
    }
    this.finishActive({ kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } })
    // The agent may take its time acknowledging the cancel, but OUR face of
    // the turn ends now: the session stops running, the HOST's prompt slot is
    // released (so a new prompt may claim it), and a provisional first lock
    // settles against what was actually shown. The AGENT-side gate (`settled`)
    // stays claimed: the prompt is still in flight over there, and a second
    // prompt sent into that window would be a concurrent `session/prompt` the
    // protocol forbids — `claimTurn` waits it out, `settle` (or the cancel
    // fallback) opens it.
    this.session.running = false
    this.session.promptInFlight = false
    if (this.session.provisionalLock === true) {
      this.session.provisionalLock = false
      if (!this.sawVisibleBlock) this.rollbackFirstTurn(this.session)
    }
    releaseAllToolOutputWaiters()
  }

  /**
   * Stop observing and release the manager's index. Idempotent.
   *
   * The segment is CLOSED here (aborted) before unsubscribing: a driver step
   * parked on its queue (`yield* segment.queue`) only ends when the queue
   * closes, and a controller replaced by the conversation's next turn would
   * otherwise leave that step hanging forever. An already finished segment is a
   * no-op, and the session's flags are left alone — a superseded turn must not
   * mark the newer turn's session idle.
   */
  dispose(): void {
    if (this.disposed) return
    // A settle may have queued its closing work for the next macrotask: this
    // close owns the turn now, so that tick must not broadcast a second
    // `turn/end` (with this turn's real id) over the teardown.
    this.closeScheduled = false
    this.pendingOutcome = undefined
    this.finishActive({ kind: 'aborted', failure: { message: 'turn stream retired', code: 'RETIRED' } })
    this.clearAmbientWait()
    this.clearPendingAmbient()
    // A successor turn must never fold this hold's drain or worker text: the
    // abandoned run's id is retired before the subscription goes away.
    this.clearBackgroundHold({ retire: true })
    // A still-running worker is NOT terminalized here: retiring a turn is not
    // evidence its worker stopped. Only a session teardown writes `unknown`
    // (see `AgentBridge.onSessionBackgroundTeardown`).
    this.retire()
    releaseAllToolOutputWaiters()
  }

  /**
   * Stop observing and release the manager's index WITHOUT touching the
   * process-wide tool-output waiters. A late settle of a superseded turn must
   * use this: those waiters now belong to the turn on air, and waking them
   * early would hand the guard a "no output" answer for a tool still running.
   */
  retire(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearCardSettle()
    this.unsubscribe()
    // The session must not keep pointing at a retired turn: the stall watchdog
    // reads this slot as "what is streaming now". A newer controller may have
    // replaced it since, and that one is not ours to clear.
    if (this.session.turnController === this) this.session.turnController = undefined
    this.manager.forgetTurnStream(this)
  }

  // ---- internals ----

  /**
   * Settle the open tool card's BLOCK once the agent goes quiet.
   *
   * Why this exists: the host's live "preparing" row only advances on
   * `argumentsDelta`; an ACP update restates its input in whole, which the
   * concatenating accumulator cannot express. Waiting for the next non-tool
   * event therefore delays the real command until the agent speaks again, and
   * a long-running tool speaks only after it finished. Closing the block on a
   * short quiet window lets the row settle its arguments (the real command)
   * while the tool still runs.
   *
   * The SEGMENT stays open: the card is still its last block, the host still
   * settles the message (and executes the card) on the next non-tool event,
   * and the watchdog / continuation semantics do not move. Skipped when the
   * card disclosed no arguments (nothing to settle, and the agent may still
   * disclose them) and in ambient segments (they open no cards).
   */
  private armCardSettle(seg: SegmentState): void {
    this.clearCardSettle()
    if (this.disposed || seg.finished || seg.ambient || seg.cardSettled) return
    const call = seg.activeToolCall
    if (seg.activeType !== 'tool-call' || call === undefined) return
    if (call.argsRaw === '') return
    const timer = setTimeout(() => {
      this.cardSettleTimer = undefined
      if (this.disposed || this.segment !== seg || seg.finished) return
      if (seg.ambient || seg.cardSettled) return
      if (seg.activeType !== 'tool-call' || seg.activeToolCall === undefined) return
      if (seg.activeToolCall.argsRaw === '') return
      this.settleOpenCard(seg)
    }, CARD_SETTLE_QUIET_MS)
    // Never pin the process open for a display timer alone.
    timer.unref?.()
    this.cardSettleTimer = timer
  }

  /** Cancel the pending block settle (its segment closed, or a newer card replaced it). */
  private clearCardSettle(): void {
    if (this.cardSettleTimer === undefined) return
    clearTimeout(this.cardSettleTimer)
    this.cardSettleTimer = undefined
  }

  /**
   * Close the open tool-call block WITHOUT ending the segment, so the host's
   * live row settles its arguments. The block stays the segment's last block;
   * a later non-tool event cuts the segment exactly as before.
   *
   * The SNAPSHOT deliberately stays open. ACP updates restate their input
   * whole, so the agent can disclose a fuller command after the window: that
   * update folds into the snapshot (see `foldInto`) and the segment's closing
   * `block-end` replaces the settled card with the final text. Clearing the
   * snapshot here would hand the same call's restatements to `seenCalls`, and
   * the card would stay pinned to the early text for the rest of the turn.
   */
  private settleOpenCard(seg: SegmentState): void {
    if (seg.finished) return
    const call = seg.activeToolCall
    if (seg.activeType !== 'tool-call' || call === undefined) return
    if (seg.cardSettled) return
    seg.cardSettled = true
    seg.queue.push({
      type: 'block-end',
      index: seg.index,
      block: { type: 'tool-call' as const, id: call.callId, name: call.name, arguments: call.argsRaw },
    })
    seg.activeText = ''
  }

  private finishSegment(seg: SegmentState, reason: SegmentFinishReason): void {
    if (seg.finished) return
    // A block settle belongs to the segment that armed it; every close cancels it.
    this.clearCardSettle()
    seg.finished = true
    if (seg.activeType !== null) {
      seg.queue.push({
        type: 'block-end',
        index: seg.index,
        block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
          ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
          : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
      })
      seg.activeType = null
      seg.activeToolCall = undefined
    }
    const outputTokens = Math.round(seg.outputChars / OUTPUT_CHARS_PER_TOKEN)
    // Zero input keeps the host's cache-hit pill hidden instead of faking 0%.
    if (outputTokens > 0) seg.queue.push({ type: 'usage', usage: { inputTokens: 0, outputTokens } })
    seg.queue.push({ type: 'finish', reason })
    seg.queue.close()
    if (this.segment === seg) this.segment = undefined
  }

  /** A segment opened on an already-settled turn: replay, then close it out. */
  private finishAfterSettle(seg: SegmentState): void {
    if (seg.finished) return
    if (this.sawVisibleBlock) {
      // The turn delivered its message(s); this last continuation step has
      // nothing new to show. An empty assistant message is not something the
      // plane can render honestly, so close with a one-line pointer.
      if (seg.index < 0 && this.pendingProse.length === 0) {
        const line = `\n[dsh-ntr] agent "${this.session.agentId}" executed its tool call(s) but sent no text reply this turn — the tool details are in the ACP transcript view.\n`
        this.emitProse(seg, 'text', line)
      }
      this.finishSegment(seg, { kind: 'stop' })
    } else {
      // A settled turn that never showed anything: the zero-output warning the
      // plane would have gotten from a single-stream turn (constraint 23).
      const line = this.zeroOutputLine()
      if (seg.index < 0) this.emitProse(seg, 'text', line)
      this.finishSegment(seg, { kind: 'stop' })
    }
  }

  /**
   * The "protocol says success, the bubble is empty" line. When a recently
   * retired drain may have taken the prompt without re-announcing itself, say
   * that instead of blaming the agent: the output exists in the transcript.
   *
   * A `refusal` stop reason is the agent's OWN verdict, not a silent failure:
   * it answered the prompt and declined to do the work. Saying "no visible
   * output" would read as a host-side gap and send the user looking for a bug
   * that is not there — and `refusal` carries the agent's reason, which is the
   * one stop reason that does (constraint 29: nothing the agent sent is
   * dropped), so it is quoted when the agent gave one.
   */
  private zeroOutputLine(stopReason?: string, refusal?: string): string {
    if (stopReason === 'refusal') {
      const detail = refusal === undefined || refusal === '' ? '' : `: ${refusal}`
      return `\n[dsh-ntr] agent "${this.session.agentId}" refused this turn${detail}.\n`
    }
    if (this.recentRetiredDrain) {
      return `\n[dsh-ntr] agent "${this.session.agentId}" produced no visible output this turn; it may have been folded into a background run; its output is in the ACP transcript view.\n`
    }
    const reason = stopReason === undefined ? '' : ` (stop reason: ${stopReason})`
    return `\n[dsh-ntr] agent "${this.session.agentId}" ended the turn with no visible output${reason}. Some agents fold upstream failures — auth, billing, rate limits — into a normal stop; try resending, and check the agent process logs if it repeats.\n`
  }

  private onEvent(event: unknown): void {
    if (this.disposed) return
    const row = event as { type?: string; sessionId?: string }
    if (row.sessionId !== undefined && row.sessionId !== this.session.sessionId) return
    if (row.type === 'session/update') {
      const typed = event as { sessionId: string; seq: number; update: unknown }
      // Any update — a `usage_update` / phase tick included — says the
      // background drain is still working, so the ambient quiet clock restarts.
      this.noteAmbientActivity()
      // A detached-worker hold's drain phase has the same rule; its worker
      // phase is pushed out only by dispatch / worker evidence (see
      // `BridgeTuning.backgroundTaskMaxMs`).
      this.noteBackgroundHoldActivity()
      const update = typed.update as Record<string, unknown>
      // Detached-worker / drain bookkeeping now lives on the SESSION (see
      // `BridgeManager.trackSessionBackgroundDispatch`): it has to outlive this
      // controller, so this turn only consumes segment content here.
      if (typed.seq <= this.cursorSeq) return
      // A background drain's prose is not this turn's answer: keep it out of
      // the plane (the transcript still has it). Fail-open — nothing is split
      // until this turn has a request id of its own to compare against.
      this.noteTurnRequestId(update)
      if (this.isForeignAmbientText(update)) {
        this.recordWithoutSegment(update)
        // Advance past it only when nothing is left unconsumed behind it: the
        // event that CUT the previous segment is parked for the next one, and
        // jumping the cursor over it would lose its text for good. The replay
        // applies the same foreign split, so leaving this one behind is safe.
        if (typed.seq === this.cursorSeq + 1) this.cursorSeq = typed.seq
        return
      }
      // The turn's OWN request id is still unknown and this update belongs to
      // the background drain: folding it now could make the drain's tick teach
      // `noteTurnRequestId` the drain's id, mixing the drain's text into the
      // user's answer. Withhold it until the prompt response decides what this
      // turn is (see `pendingAmbientUpdates`); the cursor moves on because the
      // transcript already holds the entry.
      if (this.turnRequestId === undefined
        && this.awaitingAmbient === undefined
        && this.isAmbientOwned(update)) {
        this.bufferAmbientUpdate(typed.seq, update)
        this.cursorSeq = typed.seq
        return
      }
      // Live-only burst accounting runs BEFORE the segment cursor: prose that
      // arrives between segments still belongs to this turn's output, and its
      // gaps are real. Replay never reaches this path.
      this.trackTps(typed)
      const seg = this.segment
      if (seg === undefined || seg.finished) {
        // Between segments: tool outputs still reach the shared registry (the
        // guard's virtual tool may be parked on this very record), but the
        // cursor does NOT advance — the next segment replays everything since
        // it, which re-records those idempotently and folds the prose the agent
        // streamed while its cards executed on the host.
        this.recordWithoutSegment(update)
        return
      }
      // The cursor advances only past events fully consumed into this
      // segment; the event that CUTS the segment belongs to the next one.
      if (this.foldInto(seg, update, typed.seq)) this.cursorSeq = typed.seq
    } else if (row.type === 'permission/request') {
      this.tps.onBreak()
      const typed = event as Extract<AcpEvent, { type: 'permission/request' }>
      this.pushProse(this.permissionLine(typed))
    } else if (row.type === 'permission/expired') {
      this.tps.onBreak()
      const typed = event as { toolCall: unknown; timeoutMs: number; outcome: PermissionOutcome; optionName?: string }
      this.pushProse(this.expiredLine(typed))
    }
  }

  /** Feed one live update into the turn's burst tracker. Never called by replay. */
  private trackTps(typed: { seq: number; update: unknown }): void {
    if (typed.seq <= this.tpsSeq) return
    this.tpsSeq = typed.seq
    const update = typed.update as Record<string, unknown>
    const kind = String(update.sessionUpdate ?? '')
    if (kind === 'agent_thought_chunk' || kind === 'agent_message_chunk') {
      const text = chunkTextOf(update.content)
      if (text === '') return
      this.tps.onProse(text, Date.now())
      this.pushLiveTps()
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.tps.onBreak()
    }
  }

  /** Throttled live aggregate so the dock's speed moves during a long turn. */
  private pushLiveTps(): void {
    const dshSessionId = this.session.dshSessionId
    if (dshSessionId === undefined) return
    const now = Date.now()
    if (now - this.lastTpsPushAt < TPS_PUSH_INTERVAL_MS) return
    const snap = this.tps.snapshot()
    if (snap.outputTokens <= 0 || snap.burstMs <= 0) return
    this.lastTpsPushAt = now
    const base = this.session.burst ?? { outputTokens: 0, burstMs: 0 }
    this.hub.broadcast({
      type: 'turn/metrics',
      sessionId: this.session.sessionId,
      dshSessionId,
      turnId: this.turnId,
      outputTokens: base.outputTokens + snap.outputTokens,
      burstMs: base.burstMs + snap.burstMs,
      final: false,
    })
  }

  /** Close the turn's metrics: persist the measurable part, then broadcast it. */
  private finalizeTps(): void {
    const dshSessionId = this.session.dshSessionId
    if (dshSessionId === undefined) return
    const snap = this.tps.snapshot()
    if (snap.outputTokens > 0 && snap.burstMs > 0) {
      this.manager.noteSessionBurst(this.session, snap.outputTokens, snap.burstMs)
    }
    const aggregate = this.session.burst ?? { outputTokens: 0, burstMs: 0 }
    this.hub.broadcast({
      type: 'turn/metrics',
      sessionId: this.session.sessionId,
      dshSessionId,
      turnId: this.turnId,
      outputTokens: aggregate.outputTokens,
      burstMs: aggregate.burstMs,
      final: true,
    })
  }

  /**
   * Put one narrative line into the turn's prose stream.
   *
   * A card-bearing segment must stay the segment's LAST block, so a line that
   * arrives while a card is open is parked for the next segment instead of
   * streaming below the card. A line that arrives between segments waits for
   * the next one to open.
   */
  private pushProse(line: string): void {
    if (line === '') return
    const seg = this.segment
    if (seg === undefined || seg.finished) {
      this.pendingProse.push(line)
      return
    }
    if (seg.hasCard) {
      this.pendingProse.push(line)
      this.finishSegment(seg, { kind: 'stop' })
      return
    }
    this.emitProse(seg, 'reasoning', line)
  }

  /** Events that arrive between segments: recorded, replayed into the next one. */
  private recordWithoutSegment(update: Record<string, unknown>): void {
    const kind = String(update.sessionUpdate ?? '')
    if (kind === 'tool_call' || kind === 'tool_call_update') this.noteToolRecord(update)
  }

  /** Record a tool call's output (idempotent) and wake any waiter. */
  private noteToolRecord(update: Record<string, unknown>): void {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId.trim() : ''
    if (callId === '') return
    recordAcpToolOutput(callId, updateContentToText(update.content), isFinalToolCallStatus(update.status))
  }

  /**
   * Whether this update belongs to a background drain — the one the session is
   * waiting on, or one whose wait already closed (retired) but whose run can
   * still speak.
   */
  private isAmbientOwned(update: Record<string, unknown>): boolean {
    const requestId = codebuddyMetaOf(update)?.requestId
    if (requestId === undefined) return false
    return requestId === this.session.ambient?.requestId
      || isRetiredAmbientId(this.session, requestId)
  }

  /**
   * Whether this update is the drained run's ANSWER text — the text a quiet
   * close must count as delivered (`foldedDrainIds`, one entry per run): the
   * wait's own run, a hold's accepted run, or a run the session still owns as
   * ambient.
   */
  private isDrainAnswerText(update: Record<string, unknown>): boolean {
    const requestId = codebuddyMetaOf(update)?.requestId
    if (requestId === undefined) return false
    if (this.awaitingAmbient?.requestId === requestId) return true
    const hold = this.activeBackgroundHold()
    if (hold !== undefined) return hold.acceptedIds.has(requestId)
    return this.isAmbientOwned(update)
  }

  /** Learn this turn's own CodeBuddy request id from the first update naming one. */
  private noteTurnRequestId(update: Record<string, unknown>): void {
    if (this.turnRequestId !== undefined) return
    const meta = codebuddyMetaOf(update)
    // A detached worker's update names A WORKER, never this turn: adopting it
    // would let the worker's own turn pass as the session's answer.
    if (meta?.parentToolCallId !== undefined) return
    // While a hold runs, the only ids this turn owns are the drain ids it
    // accepted (see `BackgroundHold.acceptedIds`) — and those belong to the
    // background run, never to a second "own turn id" that would outlive the
    // hold. Nothing else may be adopted.
    if (this.activeBackgroundHold() !== undefined) return
    const requestId = meta?.requestId
    // A background drain's update names THE DRAIN, never this turn: adopting it
    // would make `isForeignAmbientText` pass the drain's own text through. A
    // RETIRED drain (its wait closed on silence, the run revived) is the same
    // trap — that id belongs to the background run whichever turn is on air.
    if (requestId === undefined || requestId === this.session.ambient?.requestId) return
    if (isRetiredAmbientId(this.session, requestId)) return
    this.turnRequestId = requestId
  }

  /** Adopt the request id the prompt RESPONSE declared for this turn. */
  adoptTurnRequestId(requestId: string): void {
    // A retired drain id is never this turn's own: adopting it would make the
    // background run's prose pass `isForeignAmbientText` as the answer. The
    // response still ends a normal turn, so the withheld drain buffer is
    // dropped either way (the transcript keeps it).
    if (!isRetiredAmbientId(this.session, requestId)) this.turnRequestId = requestId
    // A normal turn: whatever the drain streamed while the id was unknown was
    // never this turn's answer. Drop it (the transcript keeps it) — it must not
    // surface when a later segment replays or when the turn flushes anything.
    this.clearPendingAmbient()
  }

  /**
   * Prose of the session's background drain while this turn runs on its OWN
   * request id: it belongs to the background run, not to the user's answer.
   * Fail-open by design — an unknown turn id splits nothing, and a turn that
   * was itself folded into the drain keeps its prose.
   */
  private isForeignAmbientText(update: Record<string, unknown>): boolean {
    const meta = codebuddyMetaOf(update)
    const requestId = meta?.requestId
    // A detached worker's own turn is never this session's answer, whichever
    // turn is on air (the fold-level guard lives in `foldInto` as well, for
    // the replay paths that never ask this question). This includes a worker
    // update that also names a drain id: its prose is the WORKER's.
    if (meta?.parentToolCallId !== undefined) return true
    // A detached-worker hold owns the drain phase: any run it accepted (the
    // response's id, an announcement that named a different one) is this
    // turn's answer, and every OTHER id is background noise — whatever the
    // turn's own id says. Parked holds count: the response already owns them.
    const hold = this.activeBackgroundHold()
    if (hold !== undefined) {
      if (requestId === undefined) return false
      return !hold.acceptedIds.has(requestId)
    }
    // The drain THIS turn is waiting on owns its text unconditionally: the
    // wait was opened for this id (a revived drain may still carry a retired
    // mark if the update raced the revival), so the whole steered answer must
    // reach the user instead of being filtered as background noise.
    if (requestId !== undefined && this.awaitingAmbient?.requestId === requestId) return false
    // A RETIRED drain is foreign even though its record is gone: the quiet
    // close only means WE stopped waiting, not that the run ended. Its late
    // text must never join the turn now on air — even before that turn has
    // learned a request id of its own (the fail-open below does not apply to
    // an id known to be a background run).
    if (isRetiredAmbientId(this.session, requestId)) return true
    if (this.turnRequestId === undefined) return false
    if (requestId === undefined || requestId === this.turnRequestId) return false
    const ambient = this.session.ambient
    return ambient !== undefined && requestId === ambient.requestId
  }

  /**
   * Whether the echo guard is live for this turn: a delivered late answer
   * exists, is still inside its window, and this turn began AFTER it. A stale
   * record is dropped here (the lazy expiry the plan calls for).
   */
  private echoGuardActive(): boolean {
    const late = this.session.lateEcho
    if (late === undefined) return false
    if (Date.now() - late.at > this.manager.lateEchoTuning.echoMs) {
      this.session.lateEcho = undefined
      return false
    }
    return this.constructedAt > late.at
  }

  /**
   * The turn's whole fold, shared by live events and segment replay. Visible
   * non-tool events END a card-bearing segment instead of joining it — that is
   * the segmentation rule that puts each card between two assistant messages.
   * Returns whether the event was consumed into this segment: the cutting
   * event is left unconsumed (and thus behind the cursor) for the next one.
   *
   * `seq` is the update's transcript position when the caller has one: the
   * detached-worker hold uses it to count only the answer text that arrived
   * AFTER the hold began (a parked hold replays the parent's earlier ack).
   */
  private foldInto(seg: SegmentState, update: Record<string, unknown>, seq?: number): boolean {
    const kind = String(update.sessionUpdate ?? '')
    // A DETACHED WORKER's own turn: its words and tools are the worker's, not
    // this session's answer. The transcript keeps them (the ACP view is where
    // the user can read them) and the shared tool-output registry still sees
    // the call, but nothing reaches this turn's message and no card opens for
    // the host to execute. This applies to EVERY turn, not just a hold.
    if (codebuddyMetaOf(update)?.parentToolCallId !== undefined) {
      this.noteToolRecord(update)
      return true
    }
    if (kind === 'agent_thought_chunk' || kind === 'agent_message_chunk') {
      let text = chunkTextOf(update.content)
      if (text === '') return true
      // The agent replays the delivered late answer at the start of the next
      // prompt: hold it while it is a strict prefix, swallow it when it ends
      // exactly, and fail-open the moment it deviates (a real answer must never
      // be eaten). Reasoning is never guarded, and neither is an ambient /
      // background segment (its text is not this turn's answer).
      if (kind === 'agent_message_chunk' && !seg.ambient && isTextualContent(update.content) && this.echoGuardActive()) {
        const late = this.session.lateEcho?.text ?? ''
        const guarded = applyEchoGuard(late, this.echoBuffer ?? '', text)
        switch (guarded.kind) {
          case 'hold':
            this.echoBuffer = guarded.buffer
            return true
          case 'swallow':
            this.echoBuffer = undefined
            this.session.lateEcho = undefined
            return true
          case 'release':
          case 'mismatch':
            this.echoBuffer = undefined
            this.session.lateEcho = undefined
            text = guarded.emit
            break
        }
        if (text === '') return true
      }
      if (seg.hasCard) {
        this.finishSegment(seg, { kind: 'stop' })
        return false
      }
      seg.outputChars += text.length
      // "The turn's own answer", as opposed to a background drain's prose that
      // happens to stream through the same session (see `isForeignAmbientText`).
      if (!this.isAmbientOwned(update)) this.sawAgentProse = true
      if (kind === 'agent_message_chunk') {
        this.sawVisibleText = true
        // The fold treatment set (see `foldedDrainIds`): text that belongs to
        // a drain being folded is an answer DELIVERED to the user, recorded
        // under THAT run's id — the quiet close's per-run `consume` decision
        // must reflect it even when the ambient record has moved on to another
        // run.
        const drainId = codebuddyMetaOf(update)?.requestId
        if (drainId !== undefined && this.isDrainAnswerText(update)) this.foldedDrainIds.add(drainId)
        // A hold's closing line asks whether ITS runs delivered answer text.
        // The parent's interim acknowledgement arrived before the hold and
        // already set `sawVisibleText`, so the hold keeps its own counter —
        // and only text that arrived after the hold began counts (a parked
        // hold replays that earlier ack from the transcript).
        const hold = this.activeBackgroundHold()
        if (hold !== undefined && (seq === undefined || seq > hold.floorSeq)) {
          hold.answerChars += text.length
        }
        if (!this.isAmbientOwned(update)) {
          if (!this.turnAnswerOverflow) {
            this.turnAnswerText += text
            if (this.turnAnswerText.length > BACKGROUND_REPORT_MAX) {
              this.turnAnswerOverflow = true
              // Release the prefix: `closeTurn` publishes nothing once the
              // bound is crossed, so keeping the bytes would only waste it.
              this.turnAnswerText = ''
            }
          }
        }
      }
      this.emitProse(seg, kind === 'agent_thought_chunk' ? 'reasoning' : 'text', text)
      return true
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.noteToolRecord(update)
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      if (callId !== '' && this.session.knownToolCalls?.has(callId) === true) {
        // A replay of a COMPLETED turn's tool frame: its card already sits in an
        // earlier assistant message, so open no second card and start no
        // continuation step. The output still reaches the shared registry.
        return true
      }
      if (seg.ambient || this.isAmbientOwned(update)) {
        // A background drain's tools stay in the transcript: opening a card
        // would make the host execute a tool and propose a continuation step
        // for a turn whose answer has not started yet. The ownership check
        // covers a NORMAL turn too — its own segment is not ambient, but a
        // drain can stream a tool call on the same session while it runs, and
        // that call is not this turn's work.
        return true
      }
      const snapshot = acpToolCallFromUpdate(update)
      if (snapshot === undefined) return true
      if (seg.activeType === 'tool-call' && seg.activeToolCall?.callId === snapshot.callId) {
        const deltas = acpToolCallDelta(seg.activeToolCall, update)
        // An early-settled block is already sealed on the host side: a
        // concatenating delta would append to a settled view. Keep the folded
        // snapshot only — the segment's closing `block-end` restates it whole.
        if (seg.cardSettled) return true
        for (const delta of deltas) {
          seg.queue.push(delta.kind === 'name'
            ? { type: 'tool-call-delta', index: seg.index, id: seg.activeToolCall.callId, name: delta.name, argumentsDelta: '' }
            : { type: 'tool-call-delta', index: seg.index, id: seg.activeToolCall.callId, argumentsDelta: delta.text })
        }
        // The agent may have JUST disclosed the real command (the announce
        // often carries only a placeholder title): restart the settle window
        // so the live row can show that text while the tool runs.
        this.armCardSettle(seg)
        return true
      }
      if (this.seenCalls.has(snapshot.callId)) return true // a restatement of a card already settled
      // A BARE status-only update for a call this turn never announced is not
      // a card. The real wire sends the detached dispatch's completion exactly
      // that way (no `_meta`, no title, no input); a turn that begins after the
      // dispatch belongs to another turn's card, and opening one here would
      // make the host execute a phantom tool.
      if (kind === 'tool_call_update' && snapshot.name === '' && snapshot.argsRaw === '') return true
      this.seenCalls.add(snapshot.callId)
      this.openToolCallBlock(seg, snapshot)
      // Let the host's live row settle this card's real command after a short
      // quiet window, instead of waiting for the next non-tool event.
      this.armCardSettle(seg)
      return true
    } else if (kind === 'user_message_chunk') {
      // The agent echoing the user's own message: it sends one for every
      // prompt, and Antigravity also replays queued ones after a resume. The
      // host already renders that message in the conversation, so folding the
      // echo here would only dump its raw JSON into the assistant bubble. The
      // ACP transcript view still maps the kind to a `user` entry, so nothing
      // is lost — this is an explicit destination, not the forbidden default.
      return true
    } else if (!BOOKKEEPING_UPDATES.has(kind)) {
      const text = describeUnhandledUpdate(kind, update)
      if (this.announcedKinds.get(kind) === text) return true
      if (seg.hasCard) {
        this.finishSegment(seg, { kind: 'stop' })
        return false
      }
      this.announcedKinds.set(kind, text)
      this.emitProse(seg, 'text', `\n${text}\n`)
      return true
    }
    return true
  }

  private emitProse(seg: SegmentState, type: 'reasoning' | 'text', text: string): void {
    if (seg.finished) return
    if (seg.activeType !== type) {
      if (seg.activeType !== null) {
        seg.queue.push({
          type: 'block-end',
          index: seg.index,
          block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
            ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
            : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
        })
      }
      seg.index += 1
      seg.activeType = type
      seg.activeText = ''
      this.sawVisibleBlock = true
      seg.queue.push({ type: 'block-start', index: seg.index, blockType: type })
    }
    seg.activeText += text
    seg.queue.push({ type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: seg.index, text })
  }

  /**
   * Open a tool-call block for one call. Two adjacent tool calls share a block
   * TYPE, so the switch helper's type-equality early return cannot be used
   * here — every call needs its own block.
   */
  private openToolCallBlock(seg: SegmentState, snapshot: AcpToolCallSnapshot): void {
    if (seg.finished) return
    if (seg.activeType !== null) {
      seg.queue.push({
        type: 'block-end',
        index: seg.index,
        block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
          ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
          : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
      })
    }
    seg.index += 1
    seg.activeType = 'tool-call'
    seg.activeText = ''
    seg.activeToolCall = snapshot
    // A NEW card owns its own settle window; the previous card's settlement
    // (if any) closed with the block-end above.
    seg.cardSettled = false
    this.sawVisibleBlock = true
    seg.hasCard = true
    seg.queue.push({ type: 'block-start', index: seg.index, blockType: 'tool-call' })
    seg.queue.push({
      type: 'tool-call-delta',
      index: seg.index,
      id: snapshot.callId,
      ...(snapshot.name === '' ? {} : { name: snapshot.name }),
      argumentsDelta: snapshot.argsRaw,
    })
  }

  private permissionLine(event: Extract<AcpEvent, { type: 'permission/request' }>): string {
    // `toolName` is host-derived (`permissionToolName`) so agents that omit
    // `title` and declare it in `_meta` still name the operation here.
    const title = event.toolName
    // The line must point at the place the answer entry actually is: a
    // chat-bound ask renders its card in the conversation; an `/acp`-RPC ask
    // has no conversation, so its card lives on the settings page.
    const lead = event.dshSessionId !== undefined
      ? 'please answer the permission card above the composer'
      : 'please approve in Settings'
    // The last clause says what happens if nobody answers, and it follows the
    // MODE: refused, answered automatically, or (in `wait`) nothing at all.
    if (event.timeoutMode === 'wait' || event.deadlineAt === undefined) {
      return `\n> 🔐 [Permission Required: ${title}] - ${lead}\n`
    }
    const remainingMs = Math.max(0, event.deadlineAt - Date.now())
    // Floor (+1 ms for the Date.now tick), min 1: rounding up would promise time already spent.
    const remainingS = Math.max(1, Math.floor((remainingMs + 1) / 1000))
    const otherwise = event.timeoutMode === 'auto'
      ? 'this request is answered automatically'
      : 'this request is cancelled'
    return `\n> 🔐 [Permission Required: ${title}] - ${lead} within ${String(remainingS)}s or ${otherwise}\n`
  }

  /**
   * The line for an ask the plugin settled itself when its deadline fired.
   *
   * The composer card is disappearing, so the conversation has to say what
   * happened to the question — otherwise the user is left with a vanished
   * card and no explanation. The wording follows the outcome: refused, or
   * answered with the option the agent's own kinds implied.
   */
  private expiredLine(event: { toolCall: unknown; timeoutMs: number; outcome: PermissionOutcome; optionName?: string }): string {
    const title = permissionToolName(event.toolCall)
    const waited = event.timeoutMs > 0
      ? `no answer within ${String(Math.round(event.timeoutMs / 1000))}s`
      : 'not waited for'
    if (event.outcome.outcome === 'selected') {
      const picked = event.optionName === undefined ? event.outcome.optionId : event.optionName
      return `\n> 🔐 [Permission Required: ${title}] - ${waited}; answered "${picked}" automatically, continuing\n`
    }
    return `\n> 🔐 [Permission Required: ${title}] - ${waited}; refused\n`
  }
}

/** Chunk text shared by the controller's fold (string / object / array forms). */
export function chunkTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'string') parts.push(item)
      else if (typeof item === 'object' && item !== null) {
        const row = item as Record<string, unknown>
        if (typeof row.text === 'string') parts.push(row.text)
        else parts.push(JSON.stringify(item))
      }
    }
    return parts.join('')
  }
  if (typeof content === 'object' && content !== null) {
    const row = content as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    if (row.type === 'text' || row.type === undefined) return JSON.stringify(content)
  }
  return ''
}
