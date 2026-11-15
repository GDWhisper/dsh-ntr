/**
 * `agent/skills`: the skill rows one conversation's `/` menu offers.
 *
 * Split out of `BridgeManager` verbatim (the manager keeps the same-named
 * public delegate): the scan itself lives in `src/skills-scan.ts`, and what is
 * left here is the flavor resolution and the in-memory answer cache. Every
 * capability it needs — the agent definition and the conversation's workspace
 * root — arrives through {@link SkillsHost}, so the service never imports the
 * manager or the bridge.
 */
import { homedir } from 'node:os'

import { skillFlavorOf } from '../impl.ts'
import type { AcpAgentDef, AgentSkillsResult } from '../protocol.ts'
import { scanSkillDirs } from '../skills-scan.ts'

/** How long one `agent/skills` scan answer stays fresh; the browser re-asks past it. */
const SKILL_SCAN_TTL_MS = 60_000
/** Cached `agent/skills` answers (agent × workspace), evicted oldest-first. */
const SKILL_SCAN_CACHE_MAX = 32

/** What the skills service needs from the bridge manager, injected. */
export interface SkillsHost {
  /** The agent definition the flavor is read from; absent means unknown agent. */
  defOf(agentId: string): AcpAgentDef | undefined
  /** The workspace root the scan anchors on (the sidebar's workspace for that chat). */
  workspaceRoot(dshSessionId: string): string | undefined
}

export class SkillsService {
  /** Answers keyed `agentId\0workspaceRoot`, TTL'd by `SKILL_SCAN_TTL_MS`. */
  private readonly cache = new Map<string, { at: number; result: AgentSkillsResult }>()

  constructor(private readonly host: SkillsHost) {}

  /**
   * The agent skills one conversation can use (`agent/skills`, the `/` menu's
   * skill rows): flavor from the agent's command line, one filesystem scan
   * over that flavor's skill dirs, TTL-cached in memory per agent + workspace.
   *
   * Deliberately NOT persisted (the structural difference from
   * `absorbCommands`, which must survive restarts because commands can only be
   * DECLARED by a live session): a scan is a pure fs read with no spawn
   * dependency, so a reboot simply re-scans on the first ask, and no
   * `model-catalog.json` shape or schema bump is owed. No SSE frame either —
   * the browser re-asks past the TTL. Unknown agent → empty answer, the same
   * contract `subagentsDetail` keeps.
   */
  async agentSkills(dshSessionId: string, agentId: string): Promise<AgentSkillsResult> {
    const def = this.host.defOf(agentId)
    if (def === undefined) return { skills: [] }
    const workspaceRoot = this.host.workspaceRoot(dshSessionId)
    const key = `${agentId}\u0000${workspaceRoot ?? ''}`
    const hit = this.cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < SKILL_SCAN_TTL_MS) return hit.result
    const flavor = skillFlavorOf(def.command, def.args)
    const result = scanSkillDirs(flavor, workspaceRoot, homedir())
    // Cache eviction is insertion-order based (oldest timestamp wins), like the
    // browser half's prune: 32 agents × workspaces is far beyond any roster.
    while (this.cache.size >= SKILL_SCAN_CACHE_MAX) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, value] of this.cache) {
        if (value.at < oldestAt) {
          oldestAt = value.at
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      this.cache.delete(oldestKey)
    }
    // `truncated` is absent on the wire when nothing was cut — the marker is
    // news, the normal case is not.
    const answer: AgentSkillsResult = { skills: result.skills, ...(result.truncated ? { truncated: true } : {}) }
    this.cache.set(key, { at: Date.now(), result: answer })
    return answer
  }
}
