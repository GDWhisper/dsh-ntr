/**
 * The `/` menu's ACP-owned rows, lifted out of `AcpStore` (split plan P3b):
 * the slash commands a live ACP session or the agent-level cache declared, and
 * the skill rows `agent/skills` answers per conversation.
 *
 * Both clusters answer the same question — "what may this conversation's `/`
 * offer, and for WHICH agent" — so they share one rule: a row read under a
 * since-switched agent stops resolving (the skill record's composite key moves;
 * the command caches are per agent to begin with). Nothing is invalidated by a
 * hook; the lookup simply misses until the next read.
 *
 * The service never imports the facade; the RPC face, the snapshot, the write
 * path and the serving-agent resolution arrive through {@link SkillsHost}.
 */

import type { AgentSkillEntry, AgentSkillsResult, ChatSessionView } from '../../protocol.ts'
import type { UiState } from './state.ts'

/** One slash command the ACP agent declared, whole row (the menu draws name, description and `input.hint`). */
export type AgentCommand = NonNullable<ChatSessionView['availableCommands']>[number]

/** How long one `agent/skills` answer stays fresh in the `/` menu; past it the rows read as "not asked yet" again. */
export const SKILL_MENU_TTL_MS = 60_000
/** Composite-key cap for the skill rows record, evicted oldest fetch first. */
export const MAX_SKILL_KEYS = 64

/** The skill-rows record key: the SERVING agent is part of the key, so a binding switch invalidates by mismatch. */
export function skillRowsKey(dshSessionId: string, agentId: string): string {
  return `${dshSessionId}\u0000${agentId}`
}

/** What the skills service needs from the store, injected. */
export interface SkillsHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
  /** Which agent serves one conversation as far as this page can tell. */
  chatAgentFor(dshSessionId: string): string | undefined
}

export class SkillsService {
  /**
   * In-flight `agent/skills` reads, keyed by chat session id. In-flight join
   * only — the menu re-polls on every keystroke and one round-trip answers for
   * all of them; no lifecycle frame can race this read, so no dropped/force
   * machinery is owed.
   */
  private readonly skillReads = new Map<string, Promise<void>>()

  constructor(private readonly host: SkillsHost) {}

  /**
   * The slash commands the LIVE ACP session declared for one chat session, as
   * read by `loadChatSessions` (`available_commands_update` →
   * `session/chat-list`).
   *
   * `undefined` covers both "no answer has landed yet" and "there is no live
   * session (or it has not declared anything)" — in every one of those cases
   * the caller falls back to the agent-level cache ({@link agentCommands}),
   * which is what makes `/` list commands before the first message exists.
   */
  chatSessionCommands(dshSessionId: string): readonly AgentCommand[] | undefined {
    const state = this.host.state()
    if (state.chatSessionsFor !== dshSessionId) return undefined
    return state.chatSessions[0]?.availableCommands
  }

  /**
   * The slash commands the agent declared in its most recent session, from
   * `agent/catalog` (host-cached per agent, see `AgentCatalogResult.commands`).
   * The pre-first-turn source for the `/` menu.
   */
  agentCommands(agentId: string | undefined): readonly AgentCommand[] | undefined {
    if (agentId === undefined) return undefined
    return this.host.state().seatCatalogs[agentId]?.commands
  }

  /**
   * The skill rows the `/` menu's skill source should offer for this
   * conversation, read against the CURRENT binding. `undefined` means "no
   * answer in force": nothing fetched yet, the TTL expired, or the agent
   * changed (composite-key mismatch) — every one of those is a signal to ask
   * again. Only a successful read of THIS conversation + THIS agent's key
   * answers `[]` (a real, confirmed-empty menu).
   */
  skillRowsFor(dshSessionId: string): readonly AgentSkillEntry[] | undefined {
    const agentId = this.host.chatAgentFor(dshSessionId)
    if (agentId === undefined) return undefined
    const entry = this.host.state().agentSkills[skillRowsKey(dshSessionId, agentId)]
    if (entry === undefined || Date.now() - entry.at >= SKILL_MENU_TTL_MS) return undefined
    return entry.rows
  }

  /**
   * Fetch the skill rows for one conversation (the slash skill source's cold
   * read). Concurrent callers share one read; the entry leaves the map when it
   * settles so the next caller past the TTL re-asks. A conversation with no
   * answerable agent reads NOTHING: no state is written and no RPC is sent,
   * so polling an unbound conversation costs zero network — and once a
   * binding lands, the next menu poll fetches normally.
   */
  loadAgentSkills(dshSessionId: string): Promise<void> {
    const inFlight = this.skillReads.get(dshSessionId)
    if (inFlight !== undefined) return inFlight
    const read = this.readAgentSkills(dshSessionId).finally(() => {
      if (this.skillReads.get(dshSessionId) === read) this.skillReads.delete(dshSessionId)
    })
    this.skillReads.set(dshSessionId, read)
    return read
  }

  private async readAgentSkills(dshSessionId: string): Promise<void> {
    // "Don't know the agent" is recorded as NOTHING — never as an empty menu.
    // An empty rows array must stay a real answer, so the mismatch case re-asks
    // instead of waiting out the TTL with a wrong empty answer.
    const agentId = this.host.chatAgentFor(dshSessionId)
    if (agentId === undefined) return
    const result = await this.host.call<AgentSkillsResult>('agent/skills', { dshSessionId, agentId })
    this.writeAgentSkills(dshSessionId, agentId, result.skills ?? [])
  }

  /** Commit one `agent/skills` answer under its composite key, applying the {@link MAX_SKILL_KEYS} eviction. */
  private writeAgentSkills(dshSessionId: string, agentId: string, rows: readonly AgentSkillEntry[]): void {
    const key = skillRowsKey(dshSessionId, agentId)
    const next: Record<string, { at: number; rows: readonly AgentSkillEntry[] }> = {
      ...this.host.state().agentSkills,
      [key]: { at: Date.now(), rows },
    }
    const keys = Object.keys(next)
    if (keys.length > MAX_SKILL_KEYS) {
      const removable = keys.sort((a, b) => (next[a]?.at ?? 0) - (next[b]?.at ?? 0))
      let excess = keys.length - MAX_SKILL_KEYS
      for (const removableKey of removable) {
        if (excess <= 0) break
        delete next[removableKey]
        excess -= 1
      }
    }
    this.host.mutate({ agentSkills: next })
  }

  /**
   * The draft text one skill pick inserts, resolved against the CURRENT
   * binding: a row seen under a since-switched agent is simply unknown here
   * (the composite key moved), so the pick does nothing rather than insert the
   * old agent's path.
   */
  skillInsertionFor(dshSessionId: string, token: string): string | undefined {
    const rows = this.skillRowsFor(dshSessionId)
    if (rows === undefined) return undefined
    return rows.find(row => row.token === token)?.insertion
  }
}
