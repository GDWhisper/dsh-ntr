/**
 * Agent skill directory scan — the ONLY filesystem code behind `agent/skills`.
 *
 * The scan is a pure read over the flavor's skill group dirs (see
 * `SKILL_DIRS_BY_FLAVOR`, src/impl.ts): a skill is a DIRECT child directory of
 * a group dir that contains a `SKILL.md` (the standard Agent Skills discovery
 * convention is one level; no recursion, no resource traversal — the menu and
 * the draft insertion never need a skill's body).
 *
 * Defense is per skill: a failure skips that skill and never interrupts the
 * scan. Group roots are realpath-anchored; symlinked children must resolve
 * back INSIDE the anchor (`isUnderPath`, the cross-platform containment
 * primitive — never `startsWith('/')`), or they are counted and skipped. An
 * `O_NOFOLLOW`-style re-check has no Windows equivalent, so the containment check
 * after realpath is the whole defense here and a TOCTOU window between lstat
 * and read is accepted (the documented adaptation; scan input is the user's
 * own home and workspace, not hostile territory).
 *
 * Synchronous by design, like the rest of bridge.ts's fs use: it runs on the
 * `agent/skills` dispatch path. Worst case (every cap maxed: 5000 skills × a
 * 64 KiB head read + 2000-entry directory listings) would stall the host event
 * loop for a noticeable moment — real skill counts are tens, so a scan costs
 * milliseconds, and the TTL cache in `BridgeManager.agentSkills` keeps the
 * repeat cost at zero.
 */

import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AgentSkillEntry, AgentSkillScope } from './protocol.ts'
import {
  GENERIC_SKILL_DIRS,
  SKILL_DIRS_BY_FLAVOR,
  SKILL_SCAN_LIMITS,
  formatSkillMentionPrompt,
  isUnderPath,
  parseSkillFrontmatter,
  skillMetadata,
  skillMentionToken,
  type SkillDirTable,
  type SkillFlavor,
} from './impl.ts'

/** What one scan produced. `skippedExternalSymlinks` is diagnostic; the RPC answer carries only `skills` + `truncated`. */
export interface SkillScanResult {
  skills: AgentSkillEntry[]
  truncated: boolean
  /** Symlinked skill dirs that resolved OUTSIDE their group anchor, skipped. */
  skippedExternalSymlinks: number
}

/** One group dir to walk, already absolute (tilde expanded) or workspace-relative (project). */
interface SkillGroup {
  scope: AgentSkillScope
  /** The dir exactly as the table wrote it: relative for project scope, `~/`-prefixed for the rest. */
  dir: string
  /** Absolute path of the group dir (workspace-root-prefixed for project, home-expanded otherwise). */
  absolute: string
}

/** Expand a table entry to an absolute path. Project entries lean on the workspace root; the rest expand `~/`. */
function groupAbsolute(dir: string, scope: AgentSkillScope, workspaceRoot: string | undefined, home: string): string | undefined {
  if (scope === 'project') {
    // No workspace → no project skills at all (an `/acp`-RPC session has no
    // conversation workspace to be relative to).
    if (workspaceRoot === undefined || workspaceRoot === '') return undefined
    return `${workspaceRoot}/${dir}`
  }
  if (!dir.startsWith('~/')) return undefined
  return `${home}/${dir.slice(2)}`
}

function groupsFor(flavor: SkillFlavor, workspaceRoot: string | undefined, home: string): SkillGroup[] {
  const table: SkillDirTable = flavor === 'generic' ? GENERIC_SKILL_DIRS : SKILL_DIRS_BY_FLAVOR[flavor]
  const groups: SkillGroup[] = []
  const push = (dirs: readonly string[], scope: AgentSkillScope): void => {
    for (const dir of dirs) {
      const absolute = groupAbsolute(dir, scope, workspaceRoot, home)
      if (absolute === undefined) continue
      groups.push({ scope, dir, absolute })
    }
  }
  push(table.projectDirs, 'project')
  push(table.globalDirs, 'global')
  push(table.systemDirs, 'system')
  return groups
}

/**
 * Read the head of SKILL.md (frontmatter must live at the top; the body is
 * never needed) and parse its frontmatter. A file whose frontmatter block does
 * not close inside the head window is treated as malformed — the documented
 * limit: a skill whose frontmatter exceeds the head budget is invisible.
 */
function readSkillFrontmatter(skillMdPath: string): Record<string, string> {
  let handle: number | undefined
  try {
    handle = openSync(skillMdPath, 'r')
    const buffer = Buffer.alloc(SKILL_SCAN_LIMITS.maxSkillMdHeadBytes)
    const read = readSync(handle, buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, read).toString('utf-8')
    return parseSkillFrontmatter(head)
  } finally {
    if (handle !== undefined) {
      try { closeSync(handle) } catch { /* the read already succeeded or failed; closing cannot improve it */ }
    }
  }
}

/** Best-effort realpath; the input path is the fallback when the stat walk fails. */
function realPathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function sortScope(left: AgentSkillScope, right: AgentSkillScope): number {
  const rank: Record<AgentSkillScope, number> = { project: 0, global: 1, system: 2 }
  return rank[left] - rank[right]
}

/** Scan one flavor's skill dirs. Never throws and never spawns: per-skill failures skip that skill only. */
export function scanSkillDirs(flavor: SkillFlavor, workspaceRoot: string | undefined, home: string = homedir()): SkillScanResult {
  const skills: AgentSkillEntry[] = []
  let truncated = false
  let skippedExternalSymlinks = 0
  for (const group of groupsFor(flavor, workspaceRoot, home)) {
    let entries: string[]
    try {
      entries = readdirSync(group.absolute)
    } catch {
      // A missing group dir is the normal case (the agent flavor's skills are
      // simply not installed there), not an error.
      continue
    }
    if (entries.length > SKILL_SCAN_LIMITS.maxChildrenPerDir) {
      entries = entries.slice(0, SKILL_SCAN_LIMITS.maxChildrenPerDir)
      truncated = true
    }
    // Anchor the GROUP dir: containment is judged against the real location,
    // so a symlinked group dir cannot widen the walk.
    const groupReal = realPathOr(group.absolute)
    for (const child of entries) {
      if (child === '' || child === '.' || child === '..' || child === '.git') continue
      const childPath = `${group.absolute}/${child}`
      let childReal: string
      try {
        const stat = lstatSync(childPath)
        if (stat.isSymbolicLink()) {
          // A symlinked child must resolve INSIDE its group anchor; anything
          // that escapes is counted and skipped, never followed.
          childReal = realPathOr(childPath)
          if (!isUnderPath(childReal, groupReal)) {
            skippedExternalSymlinks += 1
            continue
          }
          if (!statSync(childReal).isDirectory()) continue
        } else {
          if (!stat.isDirectory()) continue
          childReal = childPath
        }
      } catch {
        continue
      }
      const skillMdPath = `${childReal}/SKILL.md`
      let frontmatter: Record<string, string>
      try {
        if (statSync(skillMdPath).size > SKILL_SCAN_LIMITS.maxSkillMdBytes) {
          truncated = true
          continue
        }
        frontmatter = readSkillFrontmatter(skillMdPath)
      } catch {
        continue
      }
      const meta = skillMetadata(frontmatter, child)
      const token = skillMentionToken(meta.name, `${child}/SKILL.md`)
      if (token === '') continue
      // Segments are joined by hand so the RELATIVE path the project scope
      // publishes keeps `/` on every platform (the agent resolves it against
      // its session cwd, which is this workspace).
      const destination = group.scope === 'project'
        ? `${group.dir}/${child}`
        : realPathOr(childReal)
      skills.push({
        token,
        ...meta,
        scope: group.scope,
        folder: child,
        insertion: formatSkillMentionPrompt(token, destination),
      })
      if (skills.length >= SKILL_SCAN_LIMITS.maxSkills) {
        truncated = true
        return finish(skills, truncated, skippedExternalSymlinks)
      }
    }
  }
  return finish(skills, truncated, skippedExternalSymlinks)
}

/** Apply the summary sort (token → scope → group dir), THEN dedupe by token keeping the first row. */
function finish(skills: AgentSkillEntry[], truncated: boolean, skippedExternalSymlinks: number): SkillScanResult {
  skills.sort((left, right) =>
    left.token.localeCompare(right.token)
    || sortScope(left.scope, right.scope)
    || left.folder.localeCompare(right.folder))
  const seen = new Set<string>()
  const unique = skills.filter(skill => {
    if (seen.has(skill.token)) return false
    seen.add(skill.token)
    return true
  })
  return { skills: unique, truncated, skippedExternalSymlinks }
}
