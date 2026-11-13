/**
 * Read-only access to Antigravity's OWN transcript (see
 * docs/plan/antigravity-late-output.md).
 *
 * `agy acp` does not send a `session/update` when no `session/prompt` is in
 * flight: work it finishes after `end_turn` lands only in a JSONL file under
 * its store root. This module resolves that path and reads it incrementally,
 * and nothing here talks to the agent or the bridge.
 *
 * The format is PRIVATE to Antigravity and has no contract: every read is
 * bounded, every parse failure returns `undefined`, and no function throws to
 * its caller. Only `PLANNER_RESPONSE` steps are ever consumed.
 */
import { homedir } from 'node:os'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import type { AcpAgentDef } from '../protocol.ts'
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
}

/** The two candidate transcript file names, `transcript_full.jsonl` first. */
const TRANSCRIPT_NAMES = ['transcript_full.jsonl', 'transcript.jsonl'] as const
/** Bytes read from the tail when looking for the newest `step_index`. */
const BASELINE_TAIL_BYTES = 64 * 1024
/** Bytes read per incremental pass. */
const READ_CHUNK_BYTES = 512 * 1024
/** An ACP session id is a file-name segment: refuse separators and traversal. */
const SESSION_ID_PATTERN = /^[\w-]+$/

/**
 * Whether a definition launches Antigravity's ACP server.
 *
 * Read from the COMMAND LINE only: the agent id is user-editable, and the
 * program name is what actually selects the transcript format.
 */
export function isAntigravityAgent(def: AcpAgentDef): boolean {
  const program = def.command.split(/[\\/]/).at(-1) ?? def.command
  const bare = program.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  return bare === 'agy' && (def.args ?? []).includes('acp')
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
  let latest: TranscriptStep | undefined
  for (const step of steps) {
    if (step.type !== 'PLANNER_RESPONSE' || step.status !== 'DONE' || step.content.trim() === '') continue
    if (latest === undefined || step.stepIndex > latest.stepIndex) latest = step
  }
  return latest?.content ?? ''
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

  /**
   * Start at the CURRENT end of the file: nothing before this arm is replayed.
   * Returns the parsed steps from the inspected tail window so callers can seed
   * non-replay gate state (e.g. an already-running background task).
   */
  baseline(): TranscriptStep[] {
    this.offset = 0
    this.lastStepIndex = 0
    let size: number
    try {
      const stat = statSync(this.path)
      if (!stat.isFile()) return []
      size = stat.size
    } catch {
      return []
    }
    this.offset = size
    const window = this.readRange(Math.max(0, size - BASELINE_TAIL_BYTES), Math.min(size, BASELINE_TAIL_BYTES))
    if (window === undefined) return []
    const steps: TranscriptStep[] = []
    for (const line of window.toString('utf8').split('\n')) {
      const step = parseTranscriptStep(line)
      if (step === undefined) continue
      steps.push(step)
      if (step.stepIndex > this.lastStepIndex) this.lastStepIndex = step.stepIndex
    }
    return steps
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
