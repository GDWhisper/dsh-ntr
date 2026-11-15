/**
 * The runtime `dsh-skills` merger: the switch, user-name precedence, input
 * immutability and the ACP stdio wire shape (docs/plan/dsh-skills-mcp.md §5.1,
 * §11.6). The four session-creating entry points are wired in a later step; this
 * file pins the single merger they all share.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpMcpServerDef } from '../src/protocol.ts'
import { DSH_SKILLS_MCP_NAME, dshSkillsMcpServer, sessionMcpServers, toAcpMcpServers } from '../src/bridge/mcp.ts'
import { pluginStateDir } from '../src/bridge/state-paths.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

function userServers(): AcpMcpServerDef[] {
  return [
    { name: 'docs', transport: 'stdio', command: 'docs-mcp', args: ['--serve'], env: { TOKEN: 'x' } },
    { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer y' } },
  ]
}

afterEach(() => {
  delete process.env.DSH_NTR_STATE_DIR
})

describe('dshSkillsMcpServer', () => {
  it('describes the shipped server as a stdio entry launched by this Node binary', () => {
    const builtin = dshSkillsMcpServer()
    if (builtin.transport !== 'stdio') throw new Error('the built-in server must be a stdio entry')
    expect(builtin.name).toBe(DSH_SKILLS_MCP_NAME)
    expect(builtin.name).toBe('dsh-skills')
    expect(builtin.command).toBe(process.execPath)
    expect(builtin.args).toHaveLength(1)
    const serverPath = builtin.args?.[0] ?? ''
    expect(resolve(serverPath)).toBe(serverPath)
    expect(existsSync(serverPath)).toBe(true)
    // Lives at the PACKAGE ROOT mcp/ directory, resolvable from src/bridge AND lib/bridge.
    expect(resolve(serverPath)).toBe(join(PACKAGE_ROOT, 'mcp', 'skills-server.mjs'))
    expect(dirname(dirname(serverPath))).toBe(resolve(PACKAGE_ROOT))
  })

  it('always pins DSH_NTR_STATE_DIR so server and plugin derive the same skills root', () => {
    expect(dshSkillsMcpServer()).toMatchObject({ env: { DSH_NTR_STATE_DIR: pluginStateDir() } })
    process.env.DSH_NTR_STATE_DIR = join(PACKAGE_ROOT, 'tmp-state')
    expect(dshSkillsMcpServer()).toMatchObject({ env: { DSH_NTR_STATE_DIR: join(PACKAGE_ROOT, 'tmp-state') } })
  })

  it('emits the ACP stdio wire shape: no `type`, env as [{ name, value }]', () => {
    const [wire] = toAcpMcpServers([dshSkillsMcpServer()]) as Array<Record<string, unknown>>
    expect(Object.keys(wire).sort()).toEqual(['args', 'command', 'env', 'name'])
    expect(wire).not.toHaveProperty('type')
    expect(wire.env).toEqual([{ name: 'DSH_NTR_STATE_DIR', value: pluginStateDir() }])
  })
})

describe('sessionMcpServers', () => {
  it('returns only the user configuration while the switch is off', () => {
    const defs = userServers()
    const merged = sessionMcpServers(defs, false)
    expect(merged).toEqual(defs)
    expect(merged.some(def => def.name === DSH_SKILLS_MCP_NAME)).toBe(false)
    expect(toAcpMcpServers(merged)).toHaveLength(2)
  })

  it('appends the built-in server once the switch is on', () => {
    const defs = userServers()
    const merged = sessionMcpServers(defs, true)
    expect(merged.map(def => def.name)).toEqual(['docs', 'remote', 'dsh-skills'])
    expect(merged[2]).toEqual(dshSkillsMcpServer())
    expect(toAcpMcpServers(merged)).toHaveLength(3)
  })

  it('keeps a user server named dsh-skills and skips the built-in one', () => {
    const custom: AcpMcpServerDef = { name: 'dsh-skills', transport: 'stdio', command: 'my-own', args: ['--x'], env: { A: '1' } }
    const defs = [custom, ...userServers()]
    const merged = sessionMcpServers(defs, true)
    expect(merged).toHaveLength(3)
    expect(merged.filter(def => def.name === DSH_SKILLS_MCP_NAME)).toEqual([custom])
    expect(merged[0]).toBe(custom)
    expect(merged.some(def => def.transport === 'stdio' && def.command === process.execPath)).toBe(false)
  })

  it('never mutates the input array, its objects or the agent definition', () => {
    const defs = userServers()
    const snapshot = JSON.parse(JSON.stringify(defs)) as unknown
    const off = sessionMcpServers(defs, false)
    const on = sessionMcpServers(defs, true)
    expect(defs).toEqual(snapshot)
    expect(off).not.toBe(defs)
    expect(on).not.toBe(defs)
    // Elements are shared by reference (nothing is cloned), so a mutation would
    // have been visible in `defs` above; the ARRAY identity is what differs.
    expect(on.slice(0, 2)).toEqual(defs)
    off.push({ name: 'added', transport: 'stdio', command: 'x' })
    expect(defs).toHaveLength(2)
  })

  it('handles an agent without any mcpServers', () => {
    expect(sessionMcpServers(undefined, false)).toEqual([])
    expect(sessionMcpServers(undefined, true).map(def => def.name)).toEqual(['dsh-skills'])
  })

  it('accepts an injected built-in definition so the merge itself stays pure', () => {
    const fake: AcpMcpServerDef = { name: 'dsh-skills', transport: 'stdio', command: 'fake', args: [] }
    const merged = sessionMcpServers(userServers(), true, fake)
    expect(merged.at(-1)).toBe(fake)
  })

  it('serves the same list to every entry point: repeated calls are identical', () => {
    const first = sessionMcpServers(userServers(), true)
    const second = sessionMcpServers(userServers(), true)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })
})
