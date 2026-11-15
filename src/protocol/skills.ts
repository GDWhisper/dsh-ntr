/**
 * Agent skills (`agent/skills`): the menu rows an ACP agent contributes to the `/` menu.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

// ---- Agent skills (`agent/skills`) ----

/** Where one agent skill was found. Sort rank follows the order of the union. */
export type AgentSkillScope = 'project' | 'global' | 'system'

/**
 * One agent skill row for `agent/skills`. Host-built and menu-ready: the row
 * the `/` menu renders IS this object, and the pick inserts
 * {@link AgentSkillEntry.insertion} into the draft verbatim.
 */
export interface AgentSkillEntry {
  /** Whitespace-free pick token. Doubles as the menu row name. */
  token: string
  /** Frontmatter name, else the skill directory basename. */
  name: string
  description?: string
  scope: AgentSkillScope
  /** The skill's own folder path inside its group dir. */
  folder: string
  /** Draft-ready text: `use /<token> [Skill Path](<destination>)`. */
  insertion: string
}

/** `agent/skills` answer: the menu rows, plus a cut marker when the scan hit a cap. */
export interface AgentSkillsResult {
  skills: AgentSkillEntry[]
  /** The scan dropped rows (a directory/size/count cap); absent means nothing was cut. */
  truncated?: boolean
}

/** `agent/skills` payload: the conversation (for its workspace root) + the serving agent. */
export interface AgentSkillsPayload { dshSessionId: string; agentId: string }
