/**
 * Unified MCP across the four session-creating entries (`session/new` x2,
 * `session/fork`, `session/load` on resume) + live hot updates via
 * `ui/shared-mcp-set` and `agent/set-shared-mcp`.
 *
 * Uses `./mcp-tap.mjs` and the real `MOCK` agent process to verify the exact
 * ACP wire `mcpServers` lists sent on each session-creating RPC.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { BridgeManager, readHostMcpSnapshot, type HostMcpManagerLike } from '../../src/bridge.ts'
import { DEFAULT_TUNING } from '../../src/bridge/tuning.ts'
import type { BridgeTuning } from '../../src/bridge/types.ts'
import { EventHub, dispatchRpc } from '../../src/impl.ts'
import type { AcpAgentDef, AcpMcpServerDef } from '../../src/protocol.ts'
import { MOCK, def as mockDef, until } from './harness.ts'

const TAP = pathToFileURL(fileURLToPath(new URL('./mcp-tap.mjs', import.meta.url))).href

const AGENT_PRIVATE: AcpMcpServerDef[] = [
  { name: 'agent-only', transport: 'stdio', command: '/opt/agent-only', args: ['--stdio'] },
  { name: 'override-target', transport: 'stdio', command: '/opt/agent-wins' },
]

const SHARED_SERVERS: AcpMcpServerDef[] = [
  { name: 'override-target', transport: 'stdio', command: '/opt/shared-loses' },
  { name: 'shared-only', transport: 'http', url: 'https://shared.example/mcp', headers: { Authorization: 'Bearer s' } },
  { name: 'shared-beats-host', transport: 'http', url: 'https://shared-wins.example/mcp' },
]

const HOST_MANAGER: HostMcpManagerLike = {
  config: {
    servers: {
      get: () => ({
        'shared-beats-host': { transport: 'stdio', command: '/opt/host-loses', enabled: true },
        'host-only': { transport: 'sse', url: 'https://host.example/sse', enabled: true },
        'cred-skipped': { transport: 'stdio', command: 'npx', env: { KEY: '${credential:SECRET}' }, enabled: true },
        'disabled-skipped': { transport: 'stdio', command: '/opt/off', enabled: false },
      }),
    },
  },
}

const EXPECTED_AGENT_WIRE = [
  { name: 'agent-only', command: '/opt/agent-only', args: ['--stdio'], env: [] },
  { name: 'override-target', command: '/opt/agent-wins', args: [], env: [] },
] as Array<Record<string, unknown>>

const EXPECTED_UNIFIED_WIRE = [
  ...EXPECTED_AGENT_WIRE,
  {
    type: 'http',
    name: 'shared-only',
    url: 'https://shared.example/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer s' }],
  },
  { type: 'http', name: 'shared-beats-host', url: 'https://shared-wins.example/mcp', headers: [] },
  { type: 'sse', name: 'host-only', url: 'https://host.example/sse', headers: [] },
] as Array<Record<string, unknown>>

interface McpRecord {
  method: string
  mcpServers: Array<Record<string, unknown>> | null
}

const roots: string[] = []
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDef(id: string, log: string, idleTimeoutMs?: number): AcpAgentDef {
  return {
    ...mockDef,
    id,
    args: ['--import', TAP, MOCK],
    env: { ...mockDef.env, MOCK_MCP_LOG: log, MOCK_FORK: '1' },
    mcpServers: AGENT_PRIVATE,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
  }
}

function makeHarness(label: string) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-shared-mcp-bridge-'))
  roots.push(root)
  const log = join(root, `${label}.log`)
  const manager = new BridgeManager(
    [makeDef(`${label}-main`, log, 0), makeDef(`${label}-park`, log, 300)],
    new EventHub(),
    500,
    join(root, 'agents.json'),
    join(root, 'catalog.json'),
  )
  manager.setHostMcpReader(() => readHostMcpSnapshot(HOST_MANAGER))
  return {
    manager,
    records: () => existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as McpRecord)
      : [],
    close: () => manager.shutdownAll(),
  }
}

describe('Unified MCP across all four session-creating entries', () => {
  it('delivers merged agent > shared > host > dsh-skills list identically across new, fork, probe, and load, updating live bridges hot', async () => {
    const h = makeHarness('unified')
    try {
      const main = 'unified-main'
      const park = 'unified-park'

      // Before configuring unified MCP, only agent-private servers travel on the wire.
      h.manager.bindChatAgent('unified-a', main)
      const first = await h.manager.getOrCreateDshSession('unified-a', main)
      expect(h.records().map(r => r.mcpServers)).toEqual([EXPECTED_AGENT_WIRE])

      // Enable plugin-shared + host-synced MCP AND skills MCP hot without restarting live bridge.
      await expect(dispatchRpc(h.manager, 'ui/shared-mcp-set', {
        servers: SHARED_SERVERS,
        hostSyncEnabled: true,
      })).resolves.toMatchObject({ ok: true })
      Object.assign((h.manager as unknown as { tuning: Required<BridgeTuning> }).tuning, { skillsMcpEnabled: true })

      await h.manager.getOrCreateDshSession('unified-b', main)
      await h.manager.adoptForkedSession('unified-fork', 'unified-a')
      await h.manager.probeAgentModels(main)

      h.manager.bindChatAgent('unified-c', park)
      const parked = await h.manager.getOrCreateDshSession('unified-c', park)
      await until(() => h.manager.sessions().some(s => s.sessionId === parked.sessionId && s.released === true))
      await h.manager.resumeChatSession('unified-c')

      const records = h.records()
      expect(records.map(r => r.method)).toEqual([
        'session/new',
        'session/new',
        'session/fork',
        'session/new',
        'session/new',
        'session/load',
      ])

      // Process stayed live without restart across the hot config update.
      const mainView = h.manager.agentViews().find(v => v.id === main)
      expect(mainView?.state).toBe('ready')
      expect(mainView?.liveSessions).toContain(first.sessionId)
      expect(h.manager.sessions().filter(s => s.agentId === main && s.released === true)).toEqual([])

      // All post-config entries receive identical merged servers + dsh-skills at the tail.
      const after = records.slice(1).map(r => r.mcpServers)
      for (const wire of after) {
        expect(wire).toEqual(after[0])
        expect(wire?.slice(0, EXPECTED_UNIFIED_WIRE.length)).toEqual(EXPECTED_UNIFIED_WIRE)
        expect(wire?.at(-1)).toMatchObject({ name: 'dsh-skills', command: process.execPath })
      }
    } finally {
      await h.close()
    }
  }, 60_000)

  it('honors agent/set-shared-mcp opt-out hot while keeping agent-private and dsh-skills intact', async () => {
    const h = makeHarness('optout')
    try {
      const main = 'optout-main'
      await dispatchRpc(h.manager, 'ui/shared-mcp-set', {
        servers: SHARED_SERVERS,
        hostSyncEnabled: true,
      })
      Object.assign((h.manager as unknown as { tuning: Required<BridgeTuning> }).tuning, { skillsMcpEnabled: true })

      h.manager.bindChatAgent('optout-a', main)
      const first = await h.manager.getOrCreateDshSession('optout-a', main)
      expect(h.records()[0].mcpServers?.map(s => s.name)).toEqual([
        'agent-only',
        'override-target',
        'shared-only',
        'shared-beats-host',
        'host-only',
        'dsh-skills',
      ])

      await expect(dispatchRpc(h.manager, 'agent/set-shared-mcp', {
        agentId: main,
        sharedMcpEnabled: false,
      })).resolves.toEqual({ ok: true, value: { done: true } })

      // Live process was not restarted.
      const view = h.manager.agentViews().find(v => v.id === main)
      expect(view?.state).toBe('ready')
      expect(view?.liveSessions).toContain(first.sessionId)

      await h.manager.getOrCreateDshSession('optout-b', main)
      expect(h.records()[1].mcpServers?.map(s => s.name)).toEqual([
        'agent-only',
        'override-target',
        'dsh-skills',
      ])
    } finally {
      await h.close()
    }
  }, 60_000)
})
