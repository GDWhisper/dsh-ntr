import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeManager, readHostMcpSnapshot, type HostMcpManagerLike } from '../src/bridge.ts'
import { DSH_SKILLS_MCP_NAME, resolveSessionMcp, sessionMcpServers } from '../src/bridge/mcp.ts'
import { EventHub, dispatchRpc } from '../src/impl.ts'
import { buildPayload, initialForm, mcpTextValid, parseMcpServers, payloadEquals } from '../src/client/panel/form.ts'
import type { AcpAgentDef, AcpEvent, AcpMcpServerDef } from '../src/protocol.ts'

const tempDirs: string[] = []
function makeTempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-shared-mcp-'))
  tempDirs.push(dir)
  return join(dir, 'agents.json')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

const SAMPLE_AGENT: AcpAgentDef = {
  id: 'agent-a',
  title: 'Agent A',
  command: 'echo',
  args: ['--acp'],
  cwd: tmpdir(),
  allowedCwdRoots: [tmpdir()],
}

const STDIO_A: AcpMcpServerDef = { name: 'alpha', transport: 'stdio', command: '/usr/bin/alpha', args: ['--mcp'] }
const HTTP_B: AcpMcpServerDef = { name: 'beta', transport: 'http', url: 'https://mcp.example.com/beta' }

describe('readHostMcpSnapshot', () => {
  it('degrades cleanly when host mcpManager is absent or throws', () => {
    expect(readHostMcpSnapshot(undefined)).toEqual({ available: false, summaries: [], servers: [] })
    const broken: HostMcpManagerLike = { config: { servers: { get: () => { throw new Error('boom') } } } }
    expect(readHostMcpSnapshot(broken)).toEqual({ available: false, summaries: [], servers: [] })
  })

  it('maps stdio, http, streamable-http, and sse, flags cwd, skips disabled/${credential:...}/malformed entries strictly', () => {
    const oversizedName = 'n'.repeat(65)
    const host: HostMcpManagerLike = {
      config: {
        servers: {
          get: () => ({
            mem: { transport: 'stdio', command: 'memorix', args: ['--stdio'], env: { FOO: 'bar' }, cwd: '/tmp/work', enabled: true },
            remoteHttp: { transport: 'http', url: 'https://mcp.example.com/http', headers: { 'X-Http': '1' }, enabled: true },
            remoteStreamable: { transport: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { 'X-Test': '1' }, enabled: true },
            remoteSse: { transport: 'sse', url: 'https://mcp.example.com/sse', headers: { 'X-Sse': '1' }, enabled: true },
            secretStdio: { transport: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { GITHUB_TOKEN: '${credential:GITHUB_TOKEN}' }, enabled: true },
            secretHttp: { transport: 'streamable-http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${credential:TOKEN}' }, enabled: true },
            badArgs: { transport: 'stdio', command: 'npx', args: ['-y', 123], enabled: true },
            badEnv: { transport: 'stdio', command: 'npx', env: { KEY: 42 }, enabled: true },
            badHeaders: { transport: 'sse', url: 'https://bad.example/sse', headers: { Auth: null }, enabled: true },
            [oversizedName]: { transport: 'stdio', command: 'tool', enabled: true },
            paused: { transport: 'stdio', command: 'engram', enabled: false },
          }),
        },
      },
    }
    const snap = readHostMcpSnapshot(host)
    expect(snap.available).toBe(true)
    expect(snap.servers).toEqual([
      { name: 'mem', transport: 'stdio', command: 'memorix', args: ['--stdio'], env: { FOO: 'bar' } },
      { name: 'remoteHttp', transport: 'http', url: 'https://mcp.example.com/http', headers: { 'X-Http': '1' } },
      { name: 'remoteStreamable', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Test': '1' } },
      { name: 'remoteSse', transport: 'sse', url: 'https://mcp.example.com/sse', headers: { 'X-Sse': '1' } },
    ])
    expect(snap.summaries).toEqual([
      { name: 'mem', transport: 'stdio', enabled: true, hasCwd: true, syncable: true },
      { name: 'remoteHttp', transport: 'http', enabled: true, syncable: true },
      { name: 'remoteStreamable', transport: 'http', enabled: true, syncable: true },
      { name: 'remoteSse', transport: 'sse', enabled: true, syncable: true },
      { name: 'secretStdio', transport: 'stdio', enabled: true, hasCredentialTemplate: true, syncable: false },
      { name: 'secretHttp', transport: 'http', enabled: true, hasCredentialTemplate: true, syncable: false },
      { name: 'paused', transport: 'stdio', enabled: false, syncable: false },
    ])
  })
})

describe('sessionMcpServers and resolveSessionMcp precedence', () => {
  it('merges in strict order: agent-private > plugin-shared > host-synced > built-in dsh-skills', () => {
    const agentPrivate: AcpMcpServerDef[] = [
      { name: 'dup', transport: 'stdio', command: '/private/dup' },
    ]
    const shared: AcpMcpServerDef[] = [
      { name: 'dup', transport: 'stdio', command: '/shared/dup' },
      { name: 'shared-only', transport: 'http', url: 'https://shared.example.com' },
      { name: 'shared-vs-host', transport: 'stdio', command: '/shared/win' },
    ]
    const host: AcpMcpServerDef[] = [
      { name: 'shared-vs-host', transport: 'stdio', command: '/host/lose' },
      { name: 'host-only', transport: 'http', url: 'https://host.example.com' },
      { name: DSH_SKILLS_MCP_NAME, transport: 'stdio', command: '/host/skills' },
    ]
    const merged = sessionMcpServers(agentPrivate, true, undefined, shared, host)
    expect(merged.map(s => [s.name, s.transport === 'stdio' ? s.command : s.url])).toEqual([
      ['dup', '/private/dup'],
      ['shared-only', 'https://shared.example.com'],
      ['shared-vs-host', '/shared/win'],
      ['host-only', 'https://host.example.com'],
      [DSH_SKILLS_MCP_NAME, '/host/skills'],
    ])
    // Input arrays remain untouched.
    expect(agentPrivate).toHaveLength(1)
  })

  it('honors per-agent sharedMcpEnabled=false while keeping agent-private and dsh-skills', () => {
    const list = resolveSessionMcp(
      { mcpServers: [STDIO_A], skillsMcpEnabled: true, sharedMcpEnabled: false },
      { skills: true, shared: [HTTP_B], host: [{ name: 'host-one', transport: 'stdio', command: '/bin/h' }] },
    )
    expect(list.map(s => s.name)).toEqual(['alpha', DSH_SKILLS_MCP_NAME])
  })
})

describe('shared MCP persistence, RPC validation, and per-agent opt-out', () => {
  it('persists sharedMcpServers, hostMcpSyncEnabled, and per-agent opt-out across restarts', async () => {
    const storagePath = makeTempConfigPath()
    const host: HostMcpManagerLike = {
      config: {
        servers: {
          get: () => ({
            hostMem: { transport: 'stdio', command: '/usr/bin/mem', enabled: true },
          }),
        },
      },
    }
    const events: AcpEvent[] = []
    const hub = new EventHub()
    hub.subscribe(event => events.push(event))
    const mgr1 = new BridgeManager([SAMPLE_AGENT], hub, 200, storagePath, undefined, false)
    mgr1.setHostMcpReader(() => readHostMcpSnapshot(host))

    const initial = await dispatchRpc(mgr1, 'ui/shared-mcp', {})
    expect(initial.ok).toBe(true)
    if (initial.ok) {
      expect(initial.value).toEqual({
        sharedMcp: {
          servers: [],
          hostSyncEnabled: false,
          hostAvailable: true,
          hostServers: [{ name: 'hostMem', transport: 'stdio', enabled: true, syncable: true }],
        },
      })
    }

    const updated = await dispatchRpc(mgr1, 'ui/shared-mcp-set', {
      servers: [STDIO_A, HTTP_B],
      hostSyncEnabled: true,
    })
    expect(updated.ok).toBe(true)

    const optOut = await dispatchRpc(mgr1, 'agent/set-shared-mcp', {
      agentId: 'agent-a',
      sharedMcpEnabled: false,
    })
    expect(optOut.ok).toBe(true)
    expect(events.find(e => e.type === 'agent/exposure')).toMatchObject({
      type: 'agent/exposure',
      agentId: 'agent-a',
      sharedMcpEnabled: false,
    })

    // Omitting sharedMcpEnabled in agent/save preserves the live opt-out.
    const saved = await dispatchRpc(mgr1, 'agent/save', {
      id: 'agent-a',
      title: 'Agent A Updated',
      command: 'echo',
      args: ['--acp'],
      cwd: tmpdir(),
      allowedCwdRoots: [tmpdir()],
    })
    expect(saved.ok).toBe(true)
    const detectedAfterSave = await mgr1.detectAgents()
    expect(detectedAfterSave.find(d => d.id === 'agent-a')?.currentConfig?.sharedMcpEnabled).toBe(false)

    // Reload from disk into a fresh manager.
    const mgr2 = new BridgeManager([SAMPLE_AGENT], new EventHub(), 200, storagePath, undefined, false)
    mgr2.setHostMcpReader(() => readHostMcpSnapshot(host))
    const reloaded = mgr2.sharedMcp()
    expect(reloaded.servers).toEqual([STDIO_A, HTTP_B])
    expect(reloaded.hostSyncEnabled).toBe(true)
    expect(mgr2.agentViews().find(a => a.id === 'agent-a')).toBeTruthy()
    const detected = await mgr2.detectAgents()
    expect(detected.find(d => d.id === 'agent-a')?.currentConfig?.sharedMcpEnabled).toBe(false)

    // Reloading persisted settings without sharedMcpServers clears stale in-memory shared servers.
    ;(mgr2 as unknown as { settings: { loadPersistedSettings(parsed: Record<string, unknown>): void } }).settings.loadPersistedSettings({})
    expect(mgr2.sharedMcp().servers).toEqual([])
    expect(mgr2.sharedMcp().hostSyncEnabled).toBe(false)
  })

  it('rejects malformed payloads and rolls back when strict persistence has no writable path', async () => {
    const mgr = new BridgeManager([SAMPLE_AGENT], new EventHub(), 200, undefined, undefined, false)
    const bad1 = await dispatchRpc(mgr, 'ui/shared-mcp-set', {})
    expect(bad1.ok).toBe(false)
    const bad2 = await dispatchRpc(mgr, 'ui/shared-mcp-set', { hostSyncEnabled: 'yes' })
    expect(bad2.ok).toBe(false)
    const bad3 = await dispatchRpc(mgr, 'agent/set-shared-mcp', { agentId: 'agent-a', sharedMcpEnabled: 'no' })
    expect(bad3.ok).toBe(false)

    // No writable path under VITEST → strict persist fails and rolls back cleanly.
    const failPersist = await dispatchRpc(mgr, 'ui/shared-mcp-set', { servers: [STDIO_A], hostSyncEnabled: true })
    expect(failPersist.ok).toBe(false)
    expect(mgr.sharedMcp().servers).toEqual([])
    expect(mgr.sharedMcp().hostSyncEnabled).toBe(false)
  })

  it('validates client form MCP JSON identically to the host validator', () => {
    expect(mcpTextValid('')).toBe(true)
    expect(parseMcpServers('')).toBeUndefined()
    expect(mcpTextValid('[]')).toBe(true)
    expect(parseMcpServers('[]')).toEqual([])
    expect(mcpTextValid(JSON.stringify([STDIO_A, HTTP_B]))).toBe(true)

    for (const invalid of [
      'not-json',
      '{}',
      '[{}]',
      JSON.stringify([{ name: 'a', transport: 'stdio' }]),
      JSON.stringify([{ name: 'a', transport: 'stdio', command: 'x', args: [1] }]),
      JSON.stringify([{ name: 'a', transport: 'http' }]),
      JSON.stringify([{ name: 'a', transport: 'acp', command: 'x' }]),
      JSON.stringify([{ name: 'dup', transport: 'stdio', command: 'x' }, { name: 'dup', transport: 'sse', url: 'https://x' }]),
    ]) {
      expect(mcpTextValid(invalid)).toBe(false)
      expect(parseMcpServers(invalid)).toBeUndefined()
    }
  })

  it('preserves sharedMcpEnabled=false through agent card form round-trip without false dirtying', () => {
    const def: AcpAgentDef = { ...SAMPLE_AGENT, sharedMcpEnabled: false }
    const detected = {
      id: def.id,
      name: def.title ?? def.id,
      detected: true,
      defaultCommand: def.command,
      defaultArgs: def.args ?? [],
      currentConfig: def,
    }
    const form = initialForm(detected, undefined)
    const payload = buildPayload(form, detected, false)
    expect(payload.sharedMcpEnabled).toBe(false)
    expect(payloadEquals(payload, def)).toBe(true)
  })
})
