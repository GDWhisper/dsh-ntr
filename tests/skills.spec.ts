/**
 * The `agent/skills` filesystem scan (src/skills-scan.ts) over REAL temp
 * directories — impl.spec stays pure, so the fs half gets its own file. No
 * subprocess anywhere; everything is mkdtemp + writeFileSync.
 */

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventHub, SKILL_SCAN_LIMITS, formatSkillPathDestination, skillMentionToken } from '../src/impl.ts'
import { BridgeManager, type SessionWorkspaceResolver } from '../src/bridge.ts'
import { scanSkillDirs } from '../src/skills-scan.ts'
import type { AcpAgentDef, AgentSkillEntry } from '../src/protocol.ts'

/**
 * `BridgeManager.agentSkills` hardcodes `homedir()` for its global/system
 * scan; the mock points it at a scratch home so the manager-level tests below
 * stay hermetic. The `scanSkillDirs` tests pass `home` explicitly and are
 * unaffected.
 */
const fakeHome = vi.hoisted(() => ({ dir: '' }))

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome.dir }
})

const dirsToClean: string[] = []

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp cleanup is best effort */ }
  }
})

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-ntr-skills-${label}-`))
  dirsToClean.push(dir)
  return dir
}

function skillMd(dir: string, frontmatter: Record<string, string>, body = ''): void {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`)
  writeFileSync(join(dir, 'SKILL.md'), `---\n${lines.join('\n')}\n---\n${body}`)
}

/**
 * Create a directory symlink, preferring 'dir' and falling back to a junction
 * (junctions need no Windows privilege). Returns false when the platform
 * refuses both — the symlink-specific tests then stand down instead of failing.
 */
function makeDirLink(target: string, linkPath: string, allowRelative = false): boolean {
  try {
    symlinkSync(target, linkPath, 'dir')
    return true
  } catch {
    // fall through to the junction attempt
  }
  if (allowRelative) return false
  try {
    symlinkSync(target, linkPath, 'junction')
    return true
  } catch {
    return false
  }
}

function tokens(skills: readonly AgentSkillEntry[]): string[] {
  return skills.map(skill => skill.token)
}

describe('scanSkillDirs', () => {
  it('finds skills in all three scopes and keeps the frontmatter name and description', () => {
    const workspace = scratch('scopes-ws')
    const home = scratch('scopes-home')
    const proj = join(workspace, '.codex', 'skills', 'proj-skill')
    const glob = join(home, '.codex', 'skills', 'glob-skill')
    const sys = join(home, '.codex', 'skills', '.system', 'sys-skill')
    for (const dir of [proj, glob, sys]) {
      mkdirSync(dir, { recursive: true })
      skillMd(dir, { name: dir.endsWith('proj-skill') ? 'proj' : dir.endsWith('glob-skill') ? 'glob' : 'sys', description: 'a skill' })
    }
    const result = scanSkillDirs('codex', workspace, home)
    expect(result.truncated).toBe(false)
    // Token is the PRIMARY sort key, so the rows come back in token order.
    expect(result.skills.map(skill => [skill.token, skill.scope])).toEqual([
      ['glob', 'global'],
      ['proj', 'project'],
      ['sys', 'system'],
    ])
    const projRow = result.skills.find(skill => skill.token === 'proj')
    expect(projRow).toMatchObject({ name: 'proj', description: 'a skill', folder: 'proj-skill', scope: 'project' })
  })

  it('reads a frontmatter-less skill as its directory basename, with no description', () => {
    const home = scratch('bare-home')
    const dir = join(home, '.claude', 'skills', 'plain-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'just a body, no frontmatter')
    const result = scanSkillDirs('claude', undefined, home)
    expect(result.skills).toEqual([
      { token: 'plain-skill', name: 'plain-skill', scope: 'global', folder: 'plain-skill', insertion: expect.any(String) },
    ])
  })

  it('builds project insertions as /-relative paths and global insertions as absolute paths', () => {
    const workspace = scratch('insert-ws')
    const home = scratch('insert-home')
    const proj = join(workspace, '.claude', 'skills', 'proj-skill')
    const glob = join(home, '.claude', 'skills', 'glob-skill')
    mkdirSync(proj, { recursive: true })
    mkdirSync(glob, { recursive: true })
    skillMd(proj, {})
    skillMd(glob, {})
    const result = scanSkillDirs('claude', workspace, home)
    const projRow = result.skills.find(skill => skill.token === 'proj-skill')
    const globRow = result.skills.find(skill => skill.token === 'glob-skill')
    // The project destination is relative to the workspace (the agent's session
    // cwd), with hand-joined `/` separators on every platform.
    expect(projRow?.insertion).toBe('use /proj-skill [Skill Path](.claude/skills/proj-skill)')
    // The global destination is the realpath of the skill dir, Lody-escaped.
    expect(globRow?.insertion).toBe(
      `use /glob-skill [Skill Path](${formatSkillPathDestination(realpathSync(glob))})`,
    )
  })

  it('dedupes a repeated token with project first, then sorts token → scope → folder', () => {
    const workspace = scratch('dedupe-ws')
    const home = scratch('dedupe-home')
    const proj = join(workspace, '.agents', 'skills', 'shared')
    const glob = join(home, '.agents', 'skills', 'shared')
    mkdirSync(proj, { recursive: true })
    mkdirSync(glob, { recursive: true })
    skillMd(proj, { name: 'shared' })
    skillMd(glob, { name: 'shared' })
    // A second global skill that must sort by folder under the same token as nothing else.
    const zeta = join(home, '.agents', 'skills', 'zeta')
    mkdirSync(zeta, { recursive: true })
    skillMd(zeta, { name: 'Alpha' })
    const result = scanSkillDirs('goose', workspace, home)
    // Tokens keep their frontmatter case; 'Alpha' sorts before 'shared'.
    expect(tokens(result.skills)).toEqual(['Alpha', 'shared'])
    expect(result.skills[1]?.scope).toBe('project')
  })

  it('skips symlinked skill dirs that resolve outside their group anchor, and counts them', () => {
    const workspace = scratch('link-ws')
    const home = scratch('link-home')
    const outside = scratch('link-outside')
    const group = join(home, '.claude', 'skills')
    const inside = join(group, 'real-skill')
    mkdirSync(inside, { recursive: true })
    skillMd(inside, { name: 'real' })
    const second = join(group, 'second-skill')
    mkdirSync(second, { recursive: true })
    skillMd(second, { name: 'second' })
    const outsideDir = join(outside, 'stolen-skill')
    mkdirSync(outsideDir, { recursive: true })
    skillMd(outsideDir, { name: 'stolen' })
    const madeOutside = makeDirLink(outsideDir, join(group, 'external'))
    // An internal symlink is legitimate: it resolves back INSIDE the anchor and
    // its skill is offered (deduped with the real row by token).
    const madeInside = makeDirLink(second, join(group, 'alias'))
    if (!madeOutside && !madeInside) return // platform without symlink privileges
    const result = scanSkillDirs('claude', workspace, home)
    expect(tokens(result.skills)).toEqual(['real', 'second'])
    expect(result.skippedExternalSymlinks).toBe(madeOutside ? 1 : 0)
  })

  it('rejects a symlink whose target escapes through .. segments', () => {
    const home = scratch('escape-home')
    const outside = scratch('escape-outside')
    const group = join(home, '.claude', 'skills')
    mkdirSync(group, { recursive: true })
    const outsideDir = join(outside, 'deep-skill')
    mkdirSync(outsideDir, { recursive: true })
    skillMd(outsideDir, { name: 'deep' })
    // A RELATIVE ..-escape: the link target walks out of the group. A junction
    // cannot express one, so the test stands down where only junctions exist.
    try {
      symlinkSync(relative(group, outsideDir), join(group, 'escape'), 'dir')
    } catch {
      return
    }
    const result = scanSkillDirs('claude', undefined, home)
    expect(result.skills).toEqual([])
    expect(result.skippedExternalSymlinks).toBe(1)
  })

  it('skips an oversized SKILL.md with truncated, and a frontmatter that never closes inside the head window', () => {
    const home = scratch('caps-home')
    const group = join(home, '.claude', 'skills')
    const big = join(group, 'big-skill')
    const unclosed = join(group, 'unclosed-skill')
    const good = join(group, 'good-skill')
    for (const dir of [big, unclosed, good]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(big, 'SKILL.md'), 'x'.repeat(SKILL_SCAN_LIMITS.maxSkillMdBytes + 1))
    // Frontmatter that does not close inside the 64 KiB head → the head cut
    // leaves no closing marker → the skill is skipped (the documented limit).
    writeFileSync(join(unclosed, 'SKILL.md'), `---\n${'x'.repeat(SKILL_SCAN_LIMITS.maxSkillMdHeadBytes + 1)}`)
    skillMd(good, { name: 'good' })
    const result = scanSkillDirs('claude', undefined, home)
    expect(tokens(result.skills)).toEqual(['good'])
    expect(result.truncated).toBe(true)
  })

  it('truncates a group dir at maxChildrenPerDir and reports truncated', () => {
    const home = scratch('many-home')
    const group = join(home, '.claude', 'skills')
    for (let index = 0; index < SKILL_SCAN_LIMITS.maxChildrenPerDir + 1; index += 1) {
      mkdirSync(join(group, `skill-${String(index).padStart(4, '0')}`), { recursive: true })
    }
    const result = scanSkillDirs('claude', undefined, home)
    expect(result.truncated).toBe(true)
    expect(result.skills.length).toBeLessThanOrEqual(SKILL_SCAN_LIMITS.maxChildrenPerDir)
  })

  it('keeps scanning after a broken child: files, broken links, unreadable SKILL.md, malformed frontmatter', () => {
    const home = scratch('broken-home')
    const group = join(home, '.claude', 'skills')
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, 'a-file'), 'not a dir')
    try { symlinkSync(join('..', 'nowhere'), join(group, 'broken-link'), 'dir') } catch { /* optional */ }
    const mdAsDir = join(group, 'md-as-dir')
    mkdirSync(join(mdAsDir, 'SKILL.md'), { recursive: true })
    const malformed = join(group, 'malformed-skill')
    mkdirSync(malformed, { recursive: true })
    writeFileSync(join(malformed, 'SKILL.md'), '---\nnot a frontmatter line\n---\n')
    const gitDir = join(group, '.git')
    mkdirSync(join(gitDir, 'skills'), { recursive: true })
    const good = join(group, 'good-skill')
    mkdirSync(good, { recursive: true })
    skillMd(good, { name: 'good' })
    const result = scanSkillDirs('claude', undefined, home)
    expect(tokens(result.skills)).toEqual(['good'])
    expect(result.truncated).toBe(false)
  })

  it('scans only global/system when the conversation has no workspace', () => {
    const workspace = scratch('nows-ws')
    const home = scratch('nows-home')
    const proj = join(workspace, '.claude', 'skills', 'proj-skill')
    const glob = join(home, '.claude', 'skills', 'glob-skill')
    mkdirSync(proj, { recursive: true })
    mkdirSync(glob, { recursive: true })
    skillMd(proj, { name: 'proj' })
    skillMd(glob, { name: 'glob' })
    expect(scanSkillDirs('claude', undefined, home).skills.map(skill => skill.scope)).toEqual(['global'])
    expect(scanSkillDirs('claude', '', home).skills.map(skill => skill.scope)).toEqual(['global'])
  })

  it('answers empty groups without error for a flavor with no dirs on disk', () => {
    const home = scratch('empty-home')
    const result = scanSkillDirs('droid', undefined, home)
    expect(result).toEqual({ skills: [], truncated: false, skippedExternalSymlinks: 0 })
  })

  it('derives the pick token through skillMentionToken when the frontmatter name has whitespace', () => {
    const home = scratch('token-home')
    const dir = join(home, '.claude', 'skills', 'path-named')
    mkdirSync(dir, { recursive: true })
    skillMd(dir, { name: 'Some Spaced Name' })
    const result = scanSkillDirs('claude', undefined, home)
    expect(result.skills[0]?.token).toBe(skillMentionToken('Some Spaced Name', 'path-named/SKILL.md'))
    expect(result.skills[0]?.token).toBe('path-named')
  })
})

describe('BridgeManager.agentSkills', () => {
  const OC_ID = 'oc-skill-test'
  const ocDef: AcpAgentDef = {
    id: OC_ID,
    title: 'OpenCode skill test',
    command: 'opencode',
    args: [],
    env: {},
    cwd: tmpdir(),
    allowedCwdRoots: [tmpdir()],
  }

  const workspaces = new Map<string, string>()
  let manager: BridgeManager

  const resolveWorkspace: SessionWorkspaceResolver = sessionId => {
    const root = workspaces.get(sessionId)
    return root === undefined ? undefined : { workspaceRoot: root }
  }

  beforeAll(() => {
    fakeHome.dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-skills-home-'))
    dirsToClean.push(fakeHome.dir)
  })

  beforeEach(() => {
    workspaces.clear()
    manager = new BridgeManager([ocDef], new EventHub(), 100)
    manager.setSessionWorkspaceResolver(resolveWorkspace)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Write one opencode project skill (unique token per name) into `ws`. */
  function opencodeSkill(ws: string, name: string): void {
    const dir = join(ws, '.opencode', 'skills', name)
    mkdirSync(dir, { recursive: true })
    skillMd(dir, { name, description: `${name} description` })
  }

  it('answers empty for an unknown agent id', async () => {
    await expect(manager.agentSkills('s-none', 'no-such-agent')).resolves.toEqual({ skills: [] })
  })

  it('keys answers by agent × workspace: two sessions read their own trees', async () => {
    const wsA = scratch('cache-a')
    const wsB = scratch('cache-b')
    opencodeSkill(wsA, 'alpha-unique-a')
    opencodeSkill(wsB, 'beta-unique-b')
    workspaces.set('s-a', wsA)
    workspaces.set('s-b', wsB)

    const a = await manager.agentSkills('s-a', OC_ID)
    const b = await manager.agentSkills('s-b', OC_ID)

    expect(tokens(a.skills)).toContain('alpha-unique-a')
    expect(tokens(a.skills)).not.toContain('beta-unique-b')
    expect(tokens(b.skills)).toContain('beta-unique-b')
    expect(tokens(b.skills)).not.toContain('alpha-unique-a')
  })

  it('serves the cached scan inside the TTL window and re-scans past it', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    const ws = scratch('cache-ttl')
    opencodeSkill(ws, 'ttl-first')
    workspaces.set('s-ttl', ws)

    const first = await manager.agentSkills('s-ttl', OC_ID)
    expect(tokens(first.skills)).toContain('ttl-first')

    opencodeSkill(ws, 'ttl-second')
    vi.setSystemTime(1_700_000_000_000 + 10_000)
    const cached = await manager.agentSkills('s-ttl', OC_ID)
    expect(tokens(cached.skills)).toContain('ttl-first')
    expect(tokens(cached.skills)).not.toContain('ttl-second')

    vi.setSystemTime(1_700_000_000_000 + 61_000)
    const fresh = await manager.agentSkills('s-ttl', OC_ID)
    expect(tokens(fresh.skills)).toContain('ttl-second')
  })

  it('evicts the oldest agent × workspace answer past the 32-entry cap', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    const roots: string[] = []
    for (let i = 0; i < 33; i++) {
      const ws = scratch(`cache-evict-${i}`)
      opencodeSkill(ws, `evict-${String(i).padStart(2, '0')}`)
      workspaces.set(`s-${i}`, ws)
      roots.push(ws)
      // Strictly increasing timestamps make the eviction pick deterministic:
      // pair 0 carries the smallest `at` and is the one cast out.
      vi.setSystemTime(1_700_000_000_000 + i)
      await manager.agentSkills(`s-${i}`, OC_ID)
    }

    opencodeSkill(roots[0]!, 'post-evict-00')
    opencodeSkill(roots[1]!, 'post-evict-01')

    // Pair 1 was never evicted: inside its TTL the stale answer stands.
    const kept = await manager.agentSkills('s-1', OC_ID)
    expect(tokens(kept.skills)).not.toContain('post-evict-01')

    // Pair 0 was cast out by the 33rd insert: the ask re-scans.
    const rescanned = await manager.agentSkills('s-0', OC_ID)
    expect(tokens(rescanned.skills)).toContain('post-evict-00')
  })
})
