/**
 * Read-only access to Antigravity's OWN transcript (see
 * docs/plan/archive/antigravity-late-output.md).
 *
 * `agy acp` does not send a `session/update` when no `session/prompt` is in
 * flight: work it finishes after `end_turn` lands only in a JSONL file under
 * its store root. This module resolves that path and reads it incrementally,
 * and nothing here talks to the agent or the bridge.
 *
 * The format is PRIVATE to Antigravity and has no contract: every read is
 * bounded, every parse failure returns `undefined`, and no function throws to
 * its caller. The late-output watch consumes `PLANNER_RESPONSE` answers and
 * surfaces the measured background-failure report; the subagent poll (task 2
 * of docs/plan/antigravity-subagent-panel.md) also reads `SYSTEM_MESSAGE`
 * reports, `GENERIC` creation steps and the measured failure shape — every
 * derivation stays fail-open. A child `ERROR` tool step is a runtime tool
 * failure, never a terminal failure on its own.
 */
import { homedir } from 'node:os'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { isAntigravityCommand, type AcpAgentDef } from '../protocol.ts'
import { isAbsolutePath } from '../impl.ts'

/** One parsed transcript line. Unknown keys are ignored, not preserved. */
export interface TranscriptStep {
  /** `step_index`; a line without a finite one is rejected. */
  stepIndex: number
  /** `type` (`PLANNER_RESPONSE`, `SYSTEM_MESSAGE`, tool steps…). */
  type: string
  /** `status` (`DONE` for a finished planner response). */
  status: string
  /** `created_at`, a UTC ISO string at second precision when present. */
  createdAt?: string
  /** `content`; empty when the line carries none. */
  content: string
  /** `thinking`; only present when the line carries a string. */
  thinking?: string
  /**
   * How many entries the line's `tool_calls` array carries, when it has any.
   * A `GENERIC` step with tool calls and `status === 'RUNNING'` is an OPEN
   * tool step — the long-tier silence evidence (see `foldAgyOpenToolSteps`).
   */
  toolCallCount?: number
}

/** The two candidate transcript file names, `transcript_full.jsonl` first. */
const TRANSCRIPT_NAMES = ['transcript_full.jsonl', 'transcript.jsonl'] as const
/** Bytes read from the tail when looking for the newest `step_index`. */
const BASELINE_TAIL_BYTES = 64 * 1024
/** Bytes read per incremental pass. */
const READ_CHUNK_BYTES = 512 * 1024
/** An ACP session id is a file-name segment: refuse separators and traversal. */
export const SESSION_ID_PATTERN = /^[\w-]+$/
/** Bytes of dispatch-result text scanned for the creation payload. */
const DISPATCH_RESULT_SCAN_MAX = 64 * 1024

/**
 * Whether a definition launches Antigravity's ACP server.
 *
 * Read from the COMMAND LINE only: the agent id is user-editable, and the
 * program name is what actually selects the transcript format.
 */
export function isAntigravityAgent(def: AcpAgentDef): boolean {
  return isAntigravityCommand(def)
}

/**
 * One `--flag=value` / `--flag value` argument, first USABLE spelling found.
 *
 * A missing value must never swallow the NEXT flag: `--gemini-dir
 * --app-data-dir x` names no gemini directory (the following token is another
 * option), so the default applies. The same holds for an empty value in either
 * spelling (`--flag=` / `--flag ''`).
 */
function flagValue(args: readonly string[], names: readonly string[]): string | undefined {
  const usable = (value: string | undefined): value is string =>
    value !== undefined && value !== '' && !value.startsWith('-')
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    for (const name of names) {
      if (arg === name) {
        const next = args[index + 1]
        if (usable(next)) return next
        continue
      }
      if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1)
        if (usable(value)) return value
      }
    }
  }
  return undefined
}

/**
 * Antigravity's store root: `<gemini-dir>/<app-data-dir>`.
 *
 * A RELATIVE directory resolves against the user's home, not the agent's cwd
 * (`agy acp` resolves its own flags that way — measured). Both flag spellings
 * Antigravity accepts are read; `null` means the root cannot be named and the
 * caller must skip the feature.
 */
export function agyStoreRoot(
  def: AcpAgentDef,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathApi = platform === 'win32' ? win32 : posix
  const home = platform === 'win32' ? (env.USERPROFILE || homedir()) : (env.HOME || homedir())
  if (home === undefined || home === '') return null
  const args = def.args ?? []
  const geminiDir = flagValue(args, ['--gemini-dir', '--gemini_dir']) ?? '.gemini'
  const appDataDir = flagValue(args, ['--app-data-dir', '--app_data_dir']) ?? 'antigravity-cli'
  const base = isAbsolutePath(geminiDir) ? geminiDir : pathApi.join(home, geminiDir)
  const root = isAbsolutePath(appDataDir) ? appDataDir : pathApi.join(base, appDataDir)
  const normalized = pathApi.normalize(root)
  return normalized === '' ? null : normalized
}

/** Candidate transcript files for one ACP session; empty when the id is unusable. */
export function agyTranscriptPaths(storeRoot: string, acpSessionId: string): string[] {
  if (!SESSION_ID_PATTERN.test(acpSessionId)) return []
  const dir = join(storeRoot, 'brain', acpSessionId, '.system_generated', 'logs')
  return TRANSCRIPT_NAMES.map(name => join(dir, name))
}

/** One JSONL line, or `undefined` when it is not a usable step. */
export function parseTranscriptStep(line: string): TranscriptStep | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const row = parsed as Record<string, unknown>
  const stepIndex = row.step_index
  if (typeof stepIndex !== 'number' || !Number.isFinite(stepIndex)) return undefined
  const step: TranscriptStep = {
    stepIndex,
    type: typeof row.type === 'string' ? row.type : '',
    status: typeof row.status === 'string' ? row.status : '',
    content: typeof row.content === 'string' ? row.content : '',
  }
  if (typeof row.created_at === 'string' && row.created_at !== '') step.createdAt = row.created_at
  if (typeof row.thinking === 'string' && row.thinking !== '') step.thinking = row.thinking
  if (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) step.toolCallCount = row.tool_calls.length
  return step
}

/**
 * The late answer a set of steps carries: the LAST finished planner response.
 *
 * One background run announces only its FINAL answer. Earlier intermediate
 * replies stay in the transcript, but they are not part of this delivery:
 * agy replays a run as a contiguous chunk stream with no separator, so joining
 * several replies would make the echo guard fail on the second one and show
 * the whole old answer again. `SYSTEM_MESSAGE` steps are sub-agent reports,
 * not answers, and are deliberately ignored.
 */
export function lateAnswerText(steps: readonly TranscriptStep[]): string {
  return latestPlannerStep(steps)?.content ?? ''
}

/**
 * The thinking of the same step {@link lateAnswerText} delivers: agy replays it
 * beside the content at the next prompt's start, and the echo guard matches it
 * byte-for-byte (measured). `undefined` when the step carries no thinking —
 * the guard then passes thought chunks through untouched.
 */
export function lateAnswerThought(steps: readonly TranscriptStep[]): string | undefined {
  return latestPlannerStep(steps)?.thinking
}

/** The LAST finished planner response with content, or `undefined`. */
function latestPlannerStep(steps: readonly TranscriptStep[]): TranscriptStep | undefined {
  let latest: TranscriptStep | undefined
  for (const step of steps) {
    if (step.type !== 'PLANNER_RESPONSE' || step.status !== 'DONE' || step.content.trim() === '') continue
    if (latest === undefined || step.stepIndex > latest.stepIndex) latest = step
  }
  return latest
}

/**
 * The brain conversationId an `invoke_subagent` result frame carries.
 *
 * The measured result text is `Created the following subagent:\n{ … }` with
 * `conversationId` / `logAbsoluteUri` / `workspaceUris` inside; the JSON may
 * sit behind several prefix lines and may be pretty-printed. This says the
 * child was CREATED, never that it finished. Read-only, bounded, fail-open:
 * anything unreadable returns `undefined`, nothing throws. The id must be
 * usable as a brain directory name (the same rule {@link agyTranscriptPaths}
 * enforces), so a separator / traversal payload is not an id.
 */
export function parseAgyConversationId(text: string): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  const bounded = text.length > DISPATCH_RESULT_SCAN_MAX ? text.slice(0, DISPATCH_RESULT_SCAN_MAX) : text
  const start = bounded.indexOf('{')
  const end = bounded.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bounded.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const id = (parsed as Record<string, unknown>).conversationId
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id) ? id : undefined
}

/** Whole-second form of a transcript timestamp; `undefined` when unusable. */
export function transcriptStepSecond(createdAt: string | undefined): number | undefined {
  if (createdAt === undefined) return undefined
  const parsed = Date.parse(createdAt)
  if (!Number.isFinite(parsed)) return undefined
  return Math.floor(parsed / 1_000)
}

/** One creation payload recovered from a PARENT-transcript `GENERIC` step. */
export interface AgyCreation {
  stepIndex: number
  childId: string
  /** Whole-second `created_at`; `undefined` when the line carries no usable date. */
  second?: number
}

/**
 * The creation evidence the WIRE no longer carries. agy 1.5.5's completed
 * `invoke_subagent` frame has no usable `content` (measured: session-a12ff72b
 * left both dispatch records without a `childConversationId`, blinding the
 * whole poll). The same `Created the following subagent: { … }` payload IS
 * written to the parent transcript as a `GENERIC` step, so the poll recovers
 * the id from there. Only the measured creation prefix qualifies — a `GENERIC`
 * tool result that merely echoes some JSON with a `conversationId` key is NOT a
 * creation (same marker discipline as {@link agySystemFailureText}). Same
 * parser as the wire result; anything unreadable returns `undefined`.
 */
export function parseAgyCreation(step: TranscriptStep): AgyCreation | undefined {
  if (step.type !== 'GENERIC') return undefined
  if (!step.content.includes('Created the following subagent:')) return undefined
  const childId = parseAgyConversationId(step.content)
  if (childId === undefined) return undefined
  const second = transcriptStepSecond(step.createdAt)
  return { stepIndex: step.stepIndex, childId, ...(second === undefined ? {} : { second }) }
}

/**
 * The `sender=` token of a `SYSTEM_MESSAGE` step, or `undefined` for any other
 * step / unreadable sender. Shared by the completion and failure recognizers
 * so the two never drift on the message envelope.
 */
export function agyMessageSender(step: TranscriptStep): string | undefined {
  if (step.type !== 'SYSTEM_MESSAGE') return undefined
  const match = /(?:^|\s)sender=(\S+)/.exec(step.content)
  return match === null ? undefined : match[1]
}

/**
 * Whether one PARENT-transcript step is the report that finishes a child: a
 * `SYSTEM_MESSAGE` whose `sender=` token names the child's conversationId.
 * Measured shape: `[Message] timestamp=<ISO> sender=<childId>
 * priority=MESSAGE_PRIORITY_HIGH content=<report>]` — the report delivery
 * itself, the AUTHORITATIVE completion signal. The child's own "Message sent
 * to …" `GENERIC` step is NOT a signal. Fail-open: anything unreadable, any
 * other sender (a prefix included), any other step type is not a report.
 */
export function isAgyChildReport(step: TranscriptStep, childConversationId: string): boolean {
  return childConversationId !== '' && agyMessageSender(step) === childConversationId
}

/**
 * The measured BACKGROUND-FAILURE report (session-a12ff72b): a `SYSTEM_MESSAGE`
 * with `sender=system` whose body names a child and says it `encountered an
 * error`. Measured body: `The subagent <label> (<type>) with id "<childId>"
 * encountered an error and has either stopped or failed to start execution:
 * <error>`. Returns the human-readable `content=` payload, or `undefined` when
 * the step is not this shape.
 *
 * With a `childConversationId` the id must appear QUOTED in the body (the poll
 * matches one specific dispatch). Without it the body must still carry the
 * `with id "` marker (the session-level late-output watch knows no child id,
 * but must not fire on an unrelated system notice). Fail-open: a different
 * sender, a missing marker or an empty payload is not a failure.
 */
export function agySystemFailureText(step: TranscriptStep, childConversationId?: string): string | undefined {
  if (agyMessageSender(step) !== 'system') return undefined
  const content = step.content
  if (!content.includes('encountered an error')) return undefined
  if (childConversationId !== undefined) {
    if (childConversationId === '' || !content.includes(`"${childConversationId}"`)) return undefined
  } else if (!content.includes('with id "')) {
    return undefined
  }
  const marker = ' content='
  const at = content.indexOf(marker)
  const payload = (at >= 0 ? content.slice(at + marker.length) : content).trim()
  return payload === '' ? undefined : payload
}

/**
 * Fold one batch of CHILD-transcript steps into the completion fallback's
 * evidence: the newest `PLANNER_RESPONSE` seen so far, the newest step index
 * of ANY type (both carried across batches), and whether the planner is a
 * completion CANDIDATE — `DONE` with non-empty content AND still the newest
 * step in the transcript. Intermediate DONE replies exist (the late-output
 * watch reads the same append-only format and delivers only the LAST one),
 * so "latest planner seen so far" is not "last": any newer step disarms the
 * candidate. The caller must ALSO require a quiet window (`agyLateOutputQuietMs`,
 * no new steps) before terminalizing — this fold is pure and clock-free. A
 * `RUNNING` response means the child still works; `ERROR` steps are runtime
 * tool failures and never derive a terminal failure on their own — the
 * authoritative failure is the parent's `sender=system` report (see
 * {@link agySystemFailureText}), which the poll reads separately. Pure and
 * fail-open.
 */
export function agyChildProgress(
  steps: readonly TranscriptStep[],
  lastPlanner: TranscriptStep | undefined,
  lastStepIndex = 0,
): { lastPlanner: TranscriptStep | undefined; lastStepIndex: number; done: boolean } {
  let latest = lastPlanner
  let newest = lastStepIndex
  for (const step of steps) {
    if (step.stepIndex > newest) newest = step.stepIndex
    if (step.type !== 'PLANNER_RESPONSE') continue
    if (latest === undefined || step.stepIndex >= latest.stepIndex) latest = step
  }
  return {
    lastPlanner: latest,
    lastStepIndex: newest,
    done: latest !== undefined && latest.stepIndex === newest && latest.status === 'DONE' && latest.content.trim() !== '',
  }
}

/**
 * Fold one batch of child steps into the open-tool-step table (`step_index`
 * → when first seen), the SAME two-tier silence evidence the CodeBuddy worker
 * table feeds (`hasPendingBackgroundWork`). A step carrying tool calls with
 * `status === 'RUNNING'` is open; ANY step at or above its index closes it —
 * the transcript is append-only, so a newer step means the child moved on,
 * and a re-sent index reporting `DONE` / `ERROR` is an explicit close.
 */
export function foldAgyOpenToolSteps(open: Map<string, number>, steps: readonly TranscriptStep[], now: number): void {
  for (const step of steps) {
    for (const key of [...open.keys()]) {
      if (Number(key) <= step.stepIndex) open.delete(key)
    }
    if ((step.toolCallCount ?? 0) > 0 && step.status === 'RUNNING') open.set(String(step.stepIndex), now)
  }
}

/**
 * Incremental reader for one transcript file.
 *
 * `offset` always sits right after the last consumed newline, so a partially
 * written line stays unread until the next pass and a multi-byte character is
 * never cut (the buffer is decoded only after the newline is found).
 */
export class AgyTranscriptTail {
  /** Bytes already consumed. */
  offset = 0
  /** Highest `step_index` seen so far (the present file's, after `baseline`). */
  lastStepIndex = 0

  constructor(readonly path: string) {}

  /** Start at the CURRENT end of the file: nothing before this arm is replayed. */
  baseline(): void {
    this.offset = 0
    this.lastStepIndex = 0
    let size: number
    try {
      const stat = statSync(this.path)
      if (!stat.isFile()) return
      size = stat.size
    } catch {
      return
    }
    this.offset = size
    const window = this.readRange(Math.max(0, size - BASELINE_TAIL_BYTES), Math.min(size, BASELINE_TAIL_BYTES))
    if (window === undefined) return
    for (const line of window.toString('utf8').split('\n')) {
      const step = parseTranscriptStep(line)
      if (step !== undefined && step.stepIndex > this.lastStepIndex) this.lastStepIndex = step.stepIndex
    }
  }

  /** Steps appended since the previous pass. Never throws. */
  readNew(): TranscriptStep[] {
    let size: number
    try {
      const stat = statSync(this.path)
      if (!stat.isFile()) return []
      size = stat.size
    } catch {
      // A file that vanished or cannot be read restarts from its beginning when
      // it appears again; the baseline is recomputed by the next arm.
      return []
    }
    if (size < this.offset) this.offset = 0
    if (size <= this.offset) return []
    const window = this.readRange(this.offset, Math.min(READ_CHUNK_BYTES, size - this.offset))
    if (window === undefined || window.length === 0) return []
    const newline = window.lastIndexOf(0x0a)
    if (newline < 0) {
      // No complete line in this pass. A FULL window (512 KiB without a single
      // newline) is an over-long line: drop the bytes already read instead of
      // re-reading them every tick. The next pass starts after them, so the
      // same discard semantics as the old "skip to the next newline" scan hold
      // without its per-tick cost. A window that did NOT fill up is a normal
      // half-written line: wait for the next tick.
      if (window.length < READ_CHUNK_BYTES) return []
      this.offset += window.length
      return []
    }
    const consumed = window.subarray(0, newline + 1)
    this.offset += consumed.length
    return this.collect(consumed.toString('utf8'))
  }

  /** Parse a complete-text block, skipping blank and malformed lines. */
  private collect(text: string): TranscriptStep[] {
    const steps: TranscriptStep[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const step = parseTranscriptStep(line)
      if (step === undefined) continue
      steps.push(step)
      if (step.stepIndex > this.lastStepIndex) this.lastStepIndex = step.stepIndex
    }
    return steps
  }

  /** Read `length` bytes at `start`; `undefined` on any file-system failure. */
  private readRange(start: number, length: number): Buffer | undefined {
    if (length <= 0) return Buffer.alloc(0)
    let fd: number | undefined
    try {
      fd = openSync(this.path, 'r')
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const count = readSync(fd, buffer, read, length - read, start + read)
        if (count <= 0) break
        read += count
      }
      return buffer.subarray(0, read)
    } catch {
      return undefined
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Best effort: a failed close cannot change what was already read.
        }
      }
    }
  }
}
