/**
 * The agent preset a session runs, read back from the host session log and roster.
 *
 * The preset IS the NTR mode, so the session log (never a marker of our own) is the only honest source.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import type { AcpPresetStatus } from '../protocol.ts'

// ---- The agent preset a session runs ----

/**
 * The slice of a host session log the preset fold reads.
 */
export interface SessionLogLike {
  events?: readonly unknown[]
  /** Creation header; carries the agent preset the session started under. */
  header?: { agentPreset?: unknown }
}

/**
 * Structural view of a LIVE host session that can take catalog appends. The
 * host's `Session.append` validates the payload before committing; an older
 * host without the `subagent/catalog` event accepts the method but throws,
 * which the helper below treats as "not supported".
 */
export interface SessionCatalogLike extends SessionLogLike {
  append?: (type: string, data: Record<string, unknown>) => unknown
}

/**
 * Record one ACP-side worker in the host's parent-owned subagent catalog as an
 * EXTERNAL execution. Display-only: external entries have no child session, no
 * activity/timing and no continuation, and `list_agents` omits them. The
 * catalog is append-only, so a replayed/resumed dispatch must never add the
 * same `childId` twice. Returns whether a new fact was appended.
 */
export function appendExternalSubagentCatalog(
  session: SessionCatalogLike | undefined,
  childId: string,
  label: string,
  now = Date.now(),
): boolean {
  if (childId === '' || session?.append === undefined) return false
  const events = session.events
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: unknown; data?: { childId?: unknown } } | undefined
      if (event?.type === 'subagent/catalog' && event.data?.childId === childId) return false
    }
  }
  try {
    session.append('subagent/catalog', {
      version: 2,
      childId,
      childCreatedAt: now,
      mode: 'external',
      label,
    })
    return true
  } catch {
    return false
  }
}



/**
 * The agent preset a session actually runs.
 *
 * Mirrors `resolveSessionPreset` from `@deepseek-ai/dsh-agent-presets`
 * structurally (no dependency): the newest `agent-preset/selected` log event
 * wins over the creation-time header, because a blank session may be recomposed
 * and the header is by design a frozen creation fact.
 *
 * This is how the host half knows a chat session is in ACP mode: the mode IS an
 * agent preset, so reading it back from the session log is the only honest
 * source — a marker we set ourselves could drift from what the roster mounted.
 */
export function sessionAgentPreset(session: SessionLogLike | undefined): string | undefined {
  const events = session?.events
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: unknown; data?: { agentPreset?: unknown } } | undefined
      if (event?.type !== 'agent-preset/selected') continue
      const selected = event.data?.agentPreset
      return typeof selected === 'string' ? selected : undefined
    }
  }
  return sessionAgentPresetFromLog(session?.header?.agentPreset, [])
}

/**
 * Fold a preset from a RAW stored header plus already-decoded log events —
 * the cold-read path: `sessionPersistence` hands back the header verbatim and
 * `SessionHandle.read` returns raw event objects, neither of which is a host
 * `Session`, so {@link sessionAgentPreset} does not apply.
 */
export function sessionAgentPresetFromLog(headerPreset: unknown, events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: unknown; data?: { agentPreset?: unknown } } | undefined
    if (event?.type !== 'agent-preset/selected') continue
    const selected = event.data?.agentPreset
    return typeof selected === 'string' ? selected : undefined
  }
  return typeof headerPreset === 'string' ? headerPreset : undefined
}

/** Where the ACP-mode preset is declared inside this package. */
export const ACP_PRESET_SOURCE = 'dsh-ntr/presets/acp/acp.patch.yml'

/** One harness preset-roster row (structurally `AgentPresetRow`; no dependency). */
export interface RosterPresetRow {
  id: string
  /** Why this preset cannot compose a session; absent when it can. */
  broken?: unknown
}

/**
 * Fold the harness's preset roster into the panel's preset status.
 *
 * WHY the roster is the only honest source: the ACP mode IS an agent preset, and
 * this package only *declares* it (a `preset-<id>` row in its own bundle patch).
 * Whether that declaration reached the roster, and whether it can compose a
 * session, is the harness's state — a file we ship cannot answer it, and a
 * failed activation stays on the roster with a diagnostic rather than
 * disappearing, which is exactly the case the panel must show.
 *
 * @param rows - the roster as read from the harness, or `undefined` when the
 *   roster could not be read at all (a host without the registry service) —
 *   the caller then hides the block instead of reporting a false negative.
 * @param id - the preset id to look for (`ACP_PRESET_ID`).
 * @returns the status, or `undefined` when the roster is unreadable.
 */
export function acpPresetStatusFromRoster(rows: readonly RosterPresetRow[] | undefined, id: string): AcpPresetStatus | undefined {
  if (rows === undefined) return undefined
  const row = rows.find(candidate => candidate?.id === id)
  if (row === undefined) {
    // The roster is readable and simply has no such row: the declaration was
    // not composed (an unapplied bundle patch, or a harness generation whose
    // roster is fed from somewhere else).
    return { id, source: ACP_PRESET_SOURCE, installed: false, problem: 'the harness preset roster does not carry this declaration' }
  }
  const broken = typeof row.broken === 'string' && row.broken !== '' ? row.broken : undefined
  return broken === undefined
    ? { id, source: ACP_PRESET_SOURCE, installed: true }
    : { id, source: ACP_PRESET_SOURCE, installed: false, problem: broken }
}
