/**
 * The replay deduplication guard for Antigravity's next prompt (see
 * docs/plan/archive/antigravity-late-output.md).
 *
 * agy flushes the late step it wrote after `end_turn` — thinking AND content —
 * at the START of the next `session/prompt`, whenever that prompt comes. The
 * chat plane already showed that step as a background report, so the guard
 * swallows exactly the replay, per kind, and fails open on any deviation.
 *
 * The guard's lifetime is EVENT-BOUND, never wall-clock: the record lives from
 * the wake replay that committed it until the next controller turn closes
 * (`takeHeld`), an `/acp` prompt claims the slot (it consumes the flush on the
 * raw face), a lifecycle boundary (`clearAmbientState`), or its own
 * consumption. A fixed window was measured wrong in the field: a user replying
 * 24 minutes after a delivery outlived a 10-minute window, and the replay then
 * pasted the whole old answer after their new message (session-a12ff72b).
 */
import type { LiveSession } from './live-session.ts'

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
 * The replay deduplication state machine for one prose kind.
 *
 * Chunks are incremental (no `replace` semantics), so a strict prefix
 * accumulation is enough to recognise the replay. Every branch but `hold`
 * clears the buffer: anything that deviates emits the text instead of eating
 * a real answer.
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
export function isTextualContent(content: unknown): boolean {
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

/** The two prose kinds the late step replays, each with its own guard key. */
export type EchoKind = 'text' | 'thought'

/**
 * One turn's view of the session's committed late echo. Each kind consumes its
 * OWN key (the replay sends thinking first, then content: swallowing one must
 * not disarm the other); the record dies when both keys are gone. A kind whose
 * key is absent — a step without thinking, or a host that stripped it — passes
 * through untouched, the fail-open direction the whole late-output path follows.
 */
export class ReplayEchoGuard {
  private held: { text?: string; thought?: string } = {}

  constructor(
    private readonly session: LiveSession,
    private readonly constructedAt: number,
  ) {}

  /**
   * Whether the replay can still arrive on THIS turn: a committed record exists
   * and the turn began after the commit. No clock reads the record's age — the
   * replay is bound to the next prompt, not to elapsed time.
   */
  active(): boolean {
    const late = this.session.lateEcho
    return late !== undefined && this.constructedAt > late.at
  }

  /**
   * Feed one prose chunk of the named kind. `undefined` means the guard holds
   * or swallowed it; any other return is the text to emit (the whole chunk on
   * pass-through / mismatch, only the new tail on release). A turn constructed
   * at or before the commit passes everything through (same boundary as
   * {@link active}), so the guard is safe to call without an outer gate.
   */
  feed(kind: EchoKind, chunk: string): string | undefined {
    const late = this.session.lateEcho
    if (late === undefined || this.constructedAt <= late.at) return chunk
    const key = late[kind]
    if (key === undefined) return chunk
    const guarded = applyEchoGuard(key, this.held[kind] ?? '', chunk)
    this.held[kind] = guarded.kind === 'hold' ? guarded.buffer : undefined
    if (guarded.kind === 'hold') return undefined
    this.consume(late, kind)
    return guarded.kind === 'swallow' ? undefined : guarded.emit
  }

  /** One kind resolved (swallowed or deviated): drop its key, then the record. */
  private consume(late: NonNullable<LiveSession['lateEcho']>, kind: EchoKind): void {
    late[kind] = undefined
    if (late.text === undefined && late.thought === undefined) this.session.lateEcho = undefined
  }

  /**
   * Turn close: hand back what the guard still holds (a stop emits it —
   * duplicate is better than lost; a cancel / error discards it) and retire the
   * record when this turn was the replay's chance. A turn constructed BEFORE
   * the commit keeps the record for the turn that actually receives the replay.
   */
  takeHeld(): { text?: string; thought?: string } {
    const held = this.held
    this.held = {}
    const late = this.session.lateEcho
    if (late !== undefined && this.constructedAt > late.at) this.session.lateEcho = undefined
    return held
  }
}