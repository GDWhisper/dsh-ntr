/**
 * Slash isolation for ACP conversations.
 *
 * In an ACP conversation the composer's `/` menu belongs to the AGENT: the
 * commands it declared over `available_commands_update`. The host's own slash
 * machinery (`dsh-client-ui-commands` plus the client skill source) describes
 * commands THIS runtime would execute — `/model`, `/permission`, `/export`,
 * the DSH skill catalog — and a name it recognizes is consumed before the
 * draft ever reaches the prompt sink, so the agent never sees the line.
 *
 * There is no supported seam for "this session only": `InputTriggerService`
 * adjudicates in REGISTRATION order (`order` only sorts the menu), duplicate
 * `(trigger, name)` registration throws, and sources get no per-session
 * availability hook — so a source registered later can never outrank the
 * host's `command` source for one conversation. Replacing the whole composer
 * is the other option and is not worth the price (attachments, queue, draft,
 * shortcuts).
 *
 * What remains is wrapping the LIVE source objects in memory: same
 * registration, same menu group, different answers while the session is in ACP
 * mode. Nothing on disk is patched or imported, so an upstream change cannot
 * make a replacement file go missing — the worst case is that the source no
 * longer looks like what this module knows, and then nothing is wrapped and
 * the conversation keeps the host's behaviour (fail-open; a diagnostic line is
 * reported instead of an error).
 *
 * The wrappers are per CALL, not per instance: the source objects are shared
 * by every conversation, and the session id each hook receives is what tells
 * an ACP conversation from an ordinary one.
 */

import type { AcpSessionsSnapshot } from './acp-ui.tsx'
import { ACP_PRESET_ID, rowAgentPreset, stagedSessionOf } from './acp-ui.tsx'
import type { AgentCommand } from './store.ts'

/** One menu row: the ACP command name, plus whatever makes it findable. */
export interface SlashCandidate {
  name: string
  label?: string
  description?: string
  hint?: string
}

/** The only field these hooks receive about the owning conversation. */
export interface SlashSession {
  readonly sessionId: string
}

export interface SlashCandidateRequest {
  readonly query: string
  /** Leading token vs. a `/` inside running text; hint-bearing rows are leading-only. */
  readonly position?: 'leading' | 'inline'
  readonly signal?: AbortSignal
}

export interface SlashPick {
  readonly candidate: SlashCandidate
  readonly session: SlashSession
}

/**
 * One registered trigger source, narrowed to what isolation touches. Every
 * hook is optional because the contract makes them optional — a source that
 * never participated in Enter adjudication must not start participating just
 * because we wrapped its `candidates`.
 */
export interface SlashSource {
  readonly trigger: string
  readonly name: string
  candidates?: (session: SlashSession, req: SlashCandidateRequest) => Promise<readonly SlashCandidate[]>
  matchEnter?: (session: SlashSession, line: string, signal: AbortSignal, envelope: { attachments: number }) => Promise<unknown>
  matchSpace?: (session: SlashSession, token: string) => unknown
  onPick?: (pick: SlashPick) => unknown
  warm?: (session: SlashSession) => void
  lexicon?: (session: SlashSession) => readonly string[] | undefined
  header?: (session: SlashSession, req: { query: string }) => readonly unknown[] | undefined
}

export interface SlashIsolationOptions {
  /** The live source registry (`inputTriggers.live.sources`), re-read on every sync. */
  sources(): readonly SlashSource[] | undefined
  /** The ACP verdict this page holds; `undefined` = no answer yet. */
  verdict(sessionId: string): boolean | undefined
  /** Ask the host and wait for the in-flight read, then answer again. */
  ensureVerdict(sessionId: string): Promise<boolean | undefined>
  /**
   * The agent's declared commands for this conversation (live session first,
   * agent-level cache second); `undefined` = nothing known yet. May load the
   * cached surface first — that read is pure memory on the host.
   */
  commands(sessionId: string): readonly AgentCommand[] | undefined | Promise<readonly AgentCommand[] | undefined>
  /** Kick a fresh `session/chat-list` read (fire and forget). */
  refresh(sessionId: string): void
  /** Fail-open reports (console and the caller's own sink). */
  onDiag?(line: string): void
}

export interface SlashIsolation {
  /**
   * Find and wrap every live `/` source. Idempotent and safe to re-run.
   * Returns whether isolation is in force (at least one `/` source is wrapped)
   * — `false` is what lets the caller keep retrying until the source exists.
   */
  sync(): boolean
  /** Restore every wrapped source — only where our wrapper is still installed. */
  dispose(): void
}

/**
 * Cross-instance marker. `apply()` can run again over the same live sources (a
 * page reload of the plugin, not just a page load), and a wrapper owned by the
 * previous instance closes over that instance's store — it must be restored
 * before the new one wraps, or the new callbacks never run.
 */
const WRAP_MARKER = Symbol.for('dsh-ntr.slash-isolation')

interface WrapMarker {
  /** The instance that installed these wrappers. */
  owner: object
  restore(): void
}

/**
 * Whether one chat session runs the ACP preset, under the same two fact
 * sources the seat gate uses: the staged row's own preset when it speaks, and
 * the host-read verdict otherwise. `undefined` = no evidence yet, which every
 * caller reads as "not ACP" (fail-open: an ordinary conversation must never
 * lose its native commands to a guess).
 */
export function slashAcpVerdict(
  snapshot: AcpSessionsSnapshot | undefined,
  sessionId: string,
  verdict: (sessionId: string) => boolean | undefined,
  currentSessionId?: string,
): boolean | undefined {
  const staged = stagedSessionOf(snapshot, currentSessionId)
  if (staged !== undefined && staged.sessionId === sessionId) {
    const listed = rowAgentPreset(staged.row)
    if (listed !== undefined) return listed === ACP_PRESET_ID
  }
  return verdict(sessionId)
}

const NO_MATCH = Number.NEGATIVE_INFINITY

/** Extra weight for name starts and separator boundaries (same as the host's ranker). */
function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0
}

/**
 * Score the strongest ordered-subsequence alignment of `query` in `name`, or
 * `undefined` when the query is not a subsequence.
 *
 * A hand copy of `alignmentScore` from
 * `@deepseek-ai/dsh-client-ui-primitives`'s `rankByName`: this bundle does not
 * depend on that package, and the menu should rank exactly the way the host
 * ranks its own commands (prefix hits first, then this score). Keep the two in
 * sync if the host's ranker changes.
 */
function alignmentScore(name: string, query: string): number | undefined {
  if (query.length > name.length) return undefined
  let previous = new Array<number>(name.length).fill(NO_MATCH)
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) previous[index] = 1 + boundaryBonus(name, index) - index
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = new Array<number>(name.length).fill(NO_MATCH)
    let left = NO_MATCH
    let leftLeft = NO_MATCH
    let bestGapped = NO_MATCH
    for (let index = 0; index < name.length; index++) {
      const prior = previous[index] ?? NO_MATCH
      if (leftLeft !== NO_MATCH) bestGapped = Math.max(bestGapped, leftLeft + index - 2)
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index)
        let score = NO_MATCH
        if (left !== NO_MATCH) score = left + bonus + 4
        if (bestGapped !== NO_MATCH) score = Math.max(score, bestGapped + bonus + 1 - index)
        current[index] = score
      }
      leftLeft = left
      left = prior
    }
    previous = current
  }
  let best = NO_MATCH
  for (const score of previous) best = Math.max(best, score)
  return best === NO_MATCH ? undefined : best
}

/**
 * The agent's commands as menu rows, ranked the way the host ranks its own
 * menu: the query matches as a case-insensitive ordered subsequence of the
 * command name; prefix hits come first, then the strongest alignment score,
 * then the agent's own order (empty query = everything, in that order).
 *
 * Matching is name-only, like `rankByName`: fuzzy-matching whole descriptions
 * surfaced rows nobody would think to look for, and the native menu has never
 * searched them.
 */
export function commandCandidates(commands: readonly AgentCommand[], query: string): SlashCandidate[] {
  const q = query.trim().toLowerCase()
  const seen = new Set<string>()
  const ranked: Array<{ candidate: SlashCandidate; order: number; prefix: boolean; score: number }> = []
  let order = 0
  for (const command of commands) {
    if (command === null || typeof command !== 'object') continue
    const name = typeof command.name === 'string' ? command.name.trim() : ''
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    // Source order counts EVERY accepted row, matched or not — the host's
    // ranker breaks score ties by the input array's index, not by a compacted
    // list of matches.
    const position = order
    order += 1
    const description = typeof command.description === 'string' && command.description !== '' ? command.description : undefined
    const input = command.input as { hint?: unknown } | undefined
    const hint = typeof input?.hint === 'string' && input.hint !== '' ? input.hint : undefined
    const candidate: SlashCandidate = {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(hint !== undefined ? { hint } : {}),
    }
    if (q === '') {
      ranked.push({ candidate, order: position, prefix: true, score: 0 })
      continue
    }
    const lower = name.toLowerCase()
    const score = alignmentScore(lower, q)
    if (score === undefined) continue
    ranked.push({ candidate, order: position, prefix: lower.startsWith(q), score })
  }
  if (q === '') return ranked.map(match => match.candidate)
  ranked.sort((left, right) =>
    Number(right.prefix) - Number(left.prefix)
    || right.score - left.score
    || left.order - right.order)
  return ranked.map(match => match.candidate)
}

export function createSlashIsolation(options: SlashIsolationOptions): SlashIsolation {
  /** This instance's identity in the wrap marker (see `dispose`). */
  const owner = {}
  /** Sources this instance wrapped, so dispose can restore them. */
  const owned = new Set<SlashSource>()
  /**
   * The ONE `/` source whose menu group serves the agent's commands. Every
   * other `/` source is silenced in ACP mode — otherwise the same list would
   * appear once per group (`command` AND `skill` both register on `/`). The
   * host's command group is the natural carrier; it is picked by name so the
   * choice does not depend on registration order.
   */
  let serving: SlashSource | undefined
  let lastDiag = 'idle'
  /** A problem line was reported during the current sync. */
  let failed = false

  const report = (line: string): void => {
    failed = true
    if (lastDiag === line) return
    lastDiag = line
    options.onDiag?.(line)
  }

  const sessionIdOf = (session: SlashSession | undefined): string | undefined =>
    typeof session?.sessionId === 'string' && session.sessionId !== '' ? session.sessionId : undefined

  /** The verdict held synchronously, or `undefined`. Never asks. */
  const heldVerdict = (session: SlashSession | undefined): boolean | undefined => {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return undefined
    try {
      return options.verdict(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Last host ask per session. The menu re-polls `candidates` on every
   * keystroke, and a host that never answers the verdict query would otherwise
   * turn each one into a `session/chat-list` round-trip — in ORDINARY
   * conversations too, since the wrapped source is shared by all of them.
   */
  const askedAt = new Map<string, number>()
  const ASK_INTERVAL_MS = 1000
  /** Same idea for the "no commands known" refresh: one read per window, not per keystroke. */
  const refreshedAt = new Map<string, number>()
  const REFRESH_INTERVAL_MS = 1500

  /** The verdict, asking the host at most once per {@link ASK_INTERVAL_MS}. */
  const settledVerdict = async (session: SlashSession | undefined): Promise<boolean | undefined> => {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return undefined
    const held = heldVerdict(session)
    if (held !== undefined) return held
    const last = askedAt.get(sessionId) ?? 0
    if (Date.now() - last < ASK_INTERVAL_MS) return undefined
    askedAt.set(sessionId, Date.now())
    try {
      return await options.ensureVerdict(sessionId)
    } catch {
      return undefined
    }
  }

  const wrap = (source: SlashSource): boolean => {
    if (owned.has(source)) return false
    const existing = (source as unknown as Record<symbol, WrapMarker | undefined>)[WRAP_MARKER]
    try {
      existing?.restore()
    } catch {
      // A stale wrapper that cannot restore itself is still better replaced
      // than left in place: the new wrapper re-reads the current property.
    }
    if (typeof source.candidates !== 'function') {
      report(`slash source "${source.name}" has no candidates hook; left alone`)
      return false
    }

    const originals = {
      candidates: source.candidates,
      matchEnter: source.matchEnter,
      matchSpace: source.matchSpace,
      onPick: source.onPick,
      warm: source.warm,
      lexicon: source.lexicon,
      header: source.header,
    }
    const hadOwn = new Map<keyof typeof originals, boolean>()
    for (const key of Object.keys(originals) as Array<keyof typeof originals>) {
      hadOwn.set(key, Object.prototype.hasOwnProperty.call(source, key))
    }

    const patched: Array<{ key: keyof typeof originals; wrapper: unknown }> = []

    // The menu. In ACP mode its only rows are the agent's own commands; the
    // host directory is never read (which is also why a broken host catalog
    // cannot fail the menu open here).
    const candidates = async (session: SlashSession, req: SlashCandidateRequest): Promise<readonly SlashCandidate[]> => {
      if (await settledVerdict(session) !== true) return originals.candidates!.call(source, session, req)
      // A second `/` group would list the same commands again (and an empty
      // group auto-hides), so only the carrier source answers in ACP mode.
      if (serving !== source) return []
      const sessionId = sessionIdOf(session)!
      let commands: readonly AgentCommand[] | undefined
      try {
        commands = await options.commands(sessionId)
      } catch {
        // A failed cache read is "nothing known", never a failed menu.
        commands = undefined
      }
      if (commands === undefined) {
        // Nothing known for this conversation yet. Ask the host once per
        // window (the menu re-polls on every keystroke) and show nothing
        // rather than the host's catalog in the meantime.
        const last = refreshedAt.get(sessionId) ?? 0
        if (Date.now() - last >= REFRESH_INTERVAL_MS) {
          refreshedAt.set(sessionId, Date.now())
          options.refresh(sessionId)
        }
        return []
      }
      const rows = commandCandidates(commands, req?.query ?? '')
      // Same rule the host menu applies: a command that takes arguments is
      // only a completion at the leading position, not inside running text.
      return req?.position === 'inline' ? rows.filter(row => row.hint === undefined) : rows
    }
    source.candidates = candidates
    patched.push({ key: 'candidates', wrapper: candidates })

    // Enter/Space. `undefined` = "no claimant": the line falls through to the
    // default sink and reaches the agent byte-for-byte. A trailing space or
    // arguments are the agent's to parse, not ours.
    if (typeof originals.matchEnter === 'function') {
      const matchEnter: NonNullable<SlashSource['matchEnter']> = async (session, line, signal, envelope) => {
        if (await settledVerdict(session) === true) return undefined
        return originals.matchEnter!.call(source, session, line, signal, envelope)
      }
      source.matchEnter = matchEnter
      patched.push({ key: 'matchEnter', wrapper: matchEnter })
    }
    if (typeof originals.matchSpace === 'function') {
      const matchSpace: NonNullable<SlashSource['matchSpace']> = (session, token) => {
        if (heldVerdict(session) === true) return undefined
        return originals.matchSpace!.call(source, session, token)
      }
      source.matchSpace = matchSpace
      patched.push({ key: 'matchSpace', wrapper: matchSpace })
    }

    // A pick inserts the command into the draft; it never executes anything.
    // The user still presses Enter, and Enter is not ours to consume — the
    // same line then travels to the agent like any other message.
    if (typeof originals.onPick === 'function') {
      const onPick: NonNullable<SlashSource['onPick']> = (pick) => {
        if (heldVerdict(pick?.session) !== true) return originals.onPick!.call(source, pick)
        const name = typeof pick?.candidate?.name === 'string' ? pick.candidate.name.trim() : ''
        return name === '' ? undefined : { text: `/${name} ` }
      }
      source.onPick = onPick
      patched.push({ key: 'onPick', wrapper: onPick })
    }

    // Host-side warmups and decoration are harness work in an ACP
    // conversation: no catalog to fetch, and no host skill names to underline
    // in the draft (the agent's commands are not DSH references).
    if (typeof originals.warm === 'function') {
      const warm: NonNullable<SlashSource['warm']> = (session) => {
        if (heldVerdict(session) === true) return
        originals.warm!.call(source, session)
      }
      source.warm = warm
      patched.push({ key: 'warm', wrapper: warm })
    }
    if (typeof originals.lexicon === 'function') {
      const lexicon: NonNullable<SlashSource['lexicon']> = (session) => {
        if (heldVerdict(session) === true) return undefined
        return originals.lexicon!.call(source, session)
      }
      source.lexicon = lexicon
      patched.push({ key: 'lexicon', wrapper: lexicon })
    }
    if (typeof originals.header === 'function') {
      const header: NonNullable<SlashSource['header']> = (session, req) => {
        if (heldVerdict(session) === true) return undefined
        return originals.header!.call(source, session, req)
      }
      source.header = header
      patched.push({ key: 'header', wrapper: header })
    }

    const slots = source as unknown as Record<string, unknown>
    const restore = (): void => {
      for (const { key, wrapper } of patched) {
        // Only undo OUR assignment: a later wrapper (another instance, or an
        // upstream reassignment) owns the property now, and restoring over it
        // would resurrect code nobody is running.
        if (slots[key] !== wrapper) continue
        const original = originals[key]
        if (original !== undefined) {
          slots[key] = original
        } else if (hadOwn.get(key) === false) {
          delete slots[key]
        } else {
          slots[key] = undefined
        }
      }
    }

    ;(source as unknown as Record<symbol, WrapMarker>)[WRAP_MARKER] = { owner, restore }
    owned.add(source)
    return true
  }

  return {
    sync(): boolean {
      failed = false
      let sources: readonly SlashSource[] | undefined
      try {
        sources = options.sources()
      } catch {
        sources = undefined
      }
      if (sources === undefined) {
        report('the slash registry is unavailable; host slash commands stay in charge')
        return false
      }
      // Prefer the host's command group by name; fall back to any `/` source so
      // a live menu still exists if upstream renames it.
      serving = sources.find(source => source?.trigger === '/' && source.name === 'command')
        ?? sources.find(source => source?.trigger === '/')
      let inForce = false
      for (const source of sources) {
        if (source === null || typeof source !== 'object') continue
        if (source.trigger !== '/') continue
        try {
          if (wrap(source) || owned.has(source)) inForce = true
        } catch (error) {
          report(`could not wrap slash source "${String(source.name)}": ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // Back to `idle` after a problem healed. The caller's sink is the store,
      // which no-ops when the value did not change.
      if (!failed && inForce && lastDiag !== 'idle') {
        lastDiag = 'idle'
        options.onDiag?.('idle')
      }
      return inForce
    },
    dispose(): void {
      for (const source of owned) {
        const marker = (source as unknown as Record<symbol, WrapMarker | undefined>)[WRAP_MARKER]
        // A newer instance replaced our wrappers (a plugin reload re-applies
        // over the same live sources). Restoring on top of it would resurrect
        // hooks nobody is running — its own dispose is what ends that wrap.
        if (marker?.owner !== owner) continue
        try {
          marker.restore()
        } catch {
          // Disposal must never throw: a source that cannot be restored is
          // simply left as the host finds it.
        }
        ;(source as unknown as Record<symbol, WrapMarker | undefined>)[WRAP_MARKER] = undefined
      }
      owned.clear()
      askedAt.clear()
      refreshedAt.clear()
    },
  }
}
