/**
 * Archive-release glue: the pure half of "archiving a chat session releases
 * its ACP agent". The host writes the archive set into the `workspace` domain
 * and emits `domain/changed` after that write is durable; this module turns
 * those payloads into a pending set and lets the plugin drain it whenever its
 * own lifecycle makes room.
 *
 * Kept free of Node built-ins and ACP SDK values, like `protocol.ts`: the
 * browser bundle never imports it, and the tests drive it with plain objects.
 */

/** One `domain/changed` payload, structurally declared (the host package is not a dependency). */
export interface DomainChangeLike {
  domain?: unknown
  table?: unknown
  key?: unknown
  operation?: unknown
  value?: unknown
}

/** One activity family the host's archive admission understands. */
export interface SessionActivityLike {
  kind: string
  items?: readonly { id: string; label?: string }[]
}

/**
 * What one drain attempt did for an archived conversation.
 * - `released`: the session was parked (or already was) — retire it.
 * - `busy`: the agent still has work — keep it pending and try on the next event.
 * - `none`: this process holds no ACP record for the conversation — retire it.
 * - `unsupported`: the agent cannot reload a parked session — retire it, never release.
 */
export type ArchiveReleaseVerdict = 'released' | 'busy' | 'none' | 'unsupported'

/** The plugin operations the tracker drives; every member is synchronous by design. */
export interface ArchiveReleaseHost {
  release(dshSessionId: string): ArchiveReleaseVerdict
}

/**
 * The archived session ids a `domain/changed` payload carries, or `undefined`
 * when the change is not the workspace domain's global-singleton write. Only
 * the full snapshot is accepted: the archive set is a global state field, not
 * a per-record table.
 */
export function parseArchivedSessionIds(change: unknown): string[] | undefined {
  if (typeof change !== 'object' || change === null) return undefined
  const record = change as Record<string, unknown>
  if (record.domain !== 'workspace') return undefined
  if (record.table !== '' || record.key !== '') return undefined
  if (record.operation !== 'put') return undefined
  const value = record.value
  if (typeof value !== 'object' || value === null) return undefined
  const ids = (value as Record<string, unknown>).archivedSessionIds
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return undefined
  return ids as string[]
}

/**
 * The activity array to publish for the host's archive-admission waterfall.
 * The plugin reports the host's own `turn` family, so the confirmation dialog
 * uses its existing wording; a `turn` another provider already reported is not
 * duplicated.
 */
export function archiveActivityFrames(
  hasOwnActivity: boolean,
  rest: readonly SessionActivityLike[],
): SessionActivityLike[] {
  if (!hasOwnActivity) return [...rest]
  if (rest.some(entry => entry.kind === 'turn')) return [...rest]
  return [{ kind: 'turn' }, ...rest]
}

/**
 * Event-driven drain for archived conversations. It never polls: a domain
 * write seeds pending ids and the plugin's own hub events ask for another
 * drain once work settles.
 */
export class ArchiveReleaseTracker {
  /** The archive set as of the latest domain write. */
  private readonly known = new Set<string>()
  /** Archived ids whose release has not settled yet. */
  private readonly pending = new Set<string>()
  private pumping = false
  private repump = false

  constructor(private readonly host: ArchiveReleaseHost) {}

  /**
   * Consume one `domain/changed` payload. Unknown shapes are ignored, and an
   * unarchive drops the id from pending without ever calling the host.
   *
   * The first write after the plugin loads is a full baseline: every id is
   * treated as new. Historical archives have no live record in this process
   * and answer `none`, while an archive made in that same write is never
   * missed.
   */
  onDomainChange(change: unknown): void {
    const ids = parseArchivedSessionIds(change)
    if (ids === undefined) return
    const next = new Set(ids)
    for (const id of next) {
      if (!this.known.has(id)) this.pending.add(id)
    }
    for (const id of this.pending) {
      if (!next.has(id)) this.pending.delete(id)
    }
    this.known.clear()
    for (const id of next) this.known.add(id)
    this.pump()
  }

  /**
   * Try every pending conversation once. A re-entrant call (the release path
   * broadcasts hub frames) is folded into the running loop instead of nesting.
   */
  pump(): void {
    if (this.pumping) {
      this.repump = true
      return
    }
    this.pumping = true
    try {
      do {
        this.repump = false
        for (const id of [...this.pending]) {
          // Retire BEFORE the call: a release that broadcasts synchronously
          // must not make this id visible to a nested drain.
          this.pending.delete(id)
          let verdict: ArchiveReleaseVerdict
          try {
            verdict = this.host.release(id)
          } catch {
            // A failing release must never break the host's archive write.
            verdict = 'busy'
          }
          if (verdict === 'busy') this.pending.add(id)
        }
      } while (this.repump)
    } finally {
      this.pumping = false
    }
  }

  /** Drop every id: plugin teardown owns no archive state. */
  dispose(): void {
    this.known.clear()
    this.pending.clear()
  }
}
