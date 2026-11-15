/**
 * Agent skills, pure half: flavor matching, frontmatter parsing and the slash-insertion text (`agent/skills` payloads are exercised through dispatch in `subagents.spec.ts`).
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  dispatchRpc,
  skillFlavorOf,
  SKILL_DIRS_BY_FLAVOR,
  GENERIC_SKILL_DIRS,
  parseSkillFrontmatter,
  skillMentionToken,
  formatSkillPathDestination,
  formatSkillMentionPrompt,
} from '../../src/impl.ts'
import { fakeManager } from './harness.ts'

describe('agent skills (impl)', () => {
  describe('skillFlavorOf', () => {
    it('maps the sample table: bare commands, presets and npx package specs', () => {
      // The flavor table's samples, verbatim.
      expect(skillFlavorOf('claude', ['--acp'])).toBe('claude')
      expect(skillFlavorOf('npx', ['-y', '@agentclientprotocol/claude-agent-acp'])).toBe('claude')
      expect(skillFlavorOf('npx', ['claude-code-acp'])).toBe('claude')
      expect(skillFlavorOf('opencode', ['acp'])).toBe('opencode')
      expect(skillFlavorOf('codex', ['acp'])).toBe('codex')
      expect(skillFlavorOf('npx', ['-y', '@agentclientprotocol/codex-acp'])).toBe('codex')
      expect(skillFlavorOf('gemini', ['--experimental-acp'])).toBe('gemini')
      expect(skillFlavorOf('kimi')).toBe('kimi')
      expect(skillFlavorOf('kimi-cli')).toBe('kimi')
      expect(skillFlavorOf('npx', ['-y', '@moonshotai/kimi-cli'])).toBe('kimi')
      expect(skillFlavorOf('pi-acp')).toBe('pi')
      expect(skillFlavorOf('pi')).toBe('pi')
      expect(skillFlavorOf('omp', ['acp'])).toBe('pi')
      expect(skillFlavorOf('goose', ['acp'])).toBe('goose')
      expect(skillFlavorOf('droid', ['exec', 'acp'])).toBe('droid')
    })

    it('skips launcher tokens and their flags (node, npx, cmd.exe, pnpm dlx), case- and suffix-insensitive', () => {
      expect(skillFlavorOf('node', ['agent.js'])).toBe('generic')
      expect(skillFlavorOf('cmd', ['/d', '/s', '/c', 'claude', '--acp'])).toBe('claude')
      expect(skillFlavorOf('CMD.EXE', ['/C', 'claude'])).toBe('claude')
      expect(skillFlavorOf('pnpm', ['dlx', '@moonshotai/kimi-cli'])).toBe('kimi')
      expect(skillFlavorOf('npm', ['exec', '-y', '@agentclientprotocol/codex-acp'])).toBe('codex')
      expect(skillFlavorOf('NODE.EXE', ['/path/to/claude'])).toBe('claude')
      expect(skillFlavorOf('C:\\Program Files\\nodejs\\npx.cmd', ['-y', '@agentclientprotocol/claude-agent-acp'])).toBe('claude')
    })

    it('matches pi with a dash boundary so api-* never hits, and falls back to generic', () => {
      expect(skillFlavorOf('api-helper')).toBe('generic')
      expect(skillFlavorOf('pi-tools')).toBe('pi')
      expect(skillFlavorOf('qwen', ['acp'])).toBe('generic')
      expect(skillFlavorOf('codebuddy', ['--acp'])).toBe('generic')
      expect(skillFlavorOf('')).toBe('generic')
      expect(skillFlavorOf('node')).toBe('generic')
    })
  })

  it('keeps the flavor dir tables in the documented shape', () => {
    const flavors = Object.entries(SKILL_DIRS_BY_FLAVOR)
    expect(flavors.length).toBe(8)
    for (const [, table] of flavors) {
      for (const dir of table.projectDirs) {
        expect(dir.startsWith('~/')).toBe(false)
        expect(dir.startsWith('/')).toBe(false)
        expect(dir.includes('\\')).toBe(false)
        expect(dir.includes('..')).toBe(false)
      }
      for (const dir of [...table.globalDirs, ...table.systemDirs]) {
        expect(dir.startsWith('~/')).toBe(true)
        expect(dir.includes('\\')).toBe(false)
        expect(dir.includes('..')).toBe(false)
      }
      expect(table.projectDirs.length).toBeGreaterThan(0)
      expect(table.globalDirs.length).toBeGreaterThan(0)
    }
    expect(SKILL_DIRS_BY_FLAVOR.claude.projectDirs).toEqual(['.claude/skills'])
    expect(SKILL_DIRS_BY_FLAVOR.codex.systemDirs).toEqual(['~/.codex/skills/.system'])
    expect(SKILL_DIRS_BY_FLAVOR.pi.globalDirs).toEqual(['~/.pi/agent/skills'])
    // The generic fallback is a table too, and never empty.
    expect(GENERIC_SKILL_DIRS.projectDirs).toEqual(['.agents/skills'])
    expect(GENERIC_SKILL_DIRS.globalDirs.length).toBeGreaterThan(0)
  })

  describe('parseSkillFrontmatter', () => {
    it('returns {} without frontmatter and strips a BOM', () => {
      expect(parseSkillFrontmatter('no markers here')).toEqual({})
      expect(parseSkillFrontmatter('name: x\n---\n')).toEqual({})
      expect(parseSkillFrontmatter('\uFEFF---\nname: x\n---\n')).toEqual({ name: 'x' })
      expect(parseSkillFrontmatter('---\r\nname: x\r\n---\r\n')).toEqual({ name: 'x' })
    })

    it('throws when the opening marker never closes', () => {
      expect(() => parseSkillFrontmatter('---\nname: x')).toThrow()
      expect(() => parseSkillFrontmatter('---\nname: x\nbody text')).toThrow()
    })

    it('skips comments and blank lines, strips paired quotes, drops empty values', () => {
      const parsed = parseSkillFrontmatter('---\n# a comment\n\nname: "My Skill"\ndescription: \'use it\'\nempty:\n---\nbody')
      expect(parsed).toEqual({ name: 'My Skill', description: 'use it' })
    })

    it('accepts one nesting level under metadata and flattens it', () => {
      const parsed = parseSkillFrontmatter('---\nmetadata:\n  owner: pi\n  - list item\nname: x\n---\n')
      expect(parsed).toEqual({ 'metadata.owner': 'pi', name: 'x' })
      // A malformed nested line throws, like a malformed top-level line.
      expect(() => parseSkillFrontmatter('---\nmetadata:\n  not a pair\n---\n')).toThrow()
    })
  })

  describe('skillMentionToken', () => {
    it('uses a whitespace-free name directly', () => {
      expect(skillMentionToken('code-review', 'whatever/SKILL.md')).toBe('code-review')
      expect(skillMentionToken('  spaced-name  ', 'a/SKILL.md')).toBe('spaced-name')
    })

    it('falls back to the last path segment when the name has whitespace, and folds whitespace to dashes last', () => {
      expect(skillMentionToken('My Skill', 'my-skill/SKILL.md')).toBe('my-skill')
      expect(skillMentionToken('My Skill', 'a/b/c/SKILL.MD')).toBe('c')
      expect(skillMentionToken('My Skill', '')).toBe('My-Skill')
      expect(skillMentionToken('', '')).toBe('')
    })
  })

  it('escapes destinations with backslash and close-paren and formats the prompt verbatim', () => {
    expect(formatSkillPathDestination('C:\\a\\x.md')).toBe('C:\\\\a\\\\x.md')
    expect(formatSkillPathDestination('/a/b(x).md')).toBe('/a/b(x\\).md')
    expect(formatSkillMentionPrompt('code-review', '/home/u/.claude/skills/code-review')).toBe(
      'use /code-review [Skill Path](/home/u/.claude/skills/code-review)',
    )
    expect(formatSkillMentionPrompt('review', 'C:\\Users\\u\\skills\\review')).toBe(
      'use /review [Skill Path](C:\\\\Users\\\\u\\\\skills\\\\review)',
    )
  })

  it('serves agent/skills through the dispatcher: validated ids, optional call, empty fallback', async () => {
    const skills = { skills: [{ token: 't', name: 't', scope: 'project', folder: 't', insertion: 'use /t [Skill Path](t)' }] }
    const manager = fakeManager()
    const withSkills = {
      ...manager,
      agentSkills: (dshSessionId: string, agentId: string) => {
        manager.calls.push(['agentSkills', { dshSessionId, agentId }])
        return Promise.resolve(skills)
      },
    }
    await expect(dispatchRpc(withSkills, 'agent/skills', { dshSessionId: 'chat-1', agentId: 'claude' }))
      .resolves.toEqual({ ok: true, value: skills })
    expect(manager.calls).toContainEqual(['agentSkills', { dshSessionId: 'chat-1', agentId: 'claude' }])
    // A host half without the method answers an empty menu, not a failure.
    await expect(dispatchRpc(manager, 'agent/skills', { dshSessionId: 'chat-1', agentId: 'claude' }))
      .resolves.toEqual({ ok: true, value: { skills: [] } })
    // Payload validation happens BEFORE the optional call.
    await expect(dispatchRpc(withSkills, 'agent/skills', { agentId: 'claude' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withSkills, 'agent/skills', { dshSessionId: 'chat-1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withSkills, 'agent/skills', { dshSessionId: 3, agentId: 'claude' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
  })
})
