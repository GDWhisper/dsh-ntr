/**
 * The four SESSION-CREATING entries and the live `dsh-skills` switch.
 *
 * The agent keeps MCP servers per PROCESS, so `session/new` (twice: a real one
 * and the config probe's throwaway), `session/load` and `session/fork` must all
 * hand over the SAME list — a probe or fork sending a different one evicts the
 * tools of every live session on that connection (AGENTS.md rule 32). The
 * switch itself is read at REQUEST time through `AgentBridge`'s seam, so a
 * rewrite of the manager's live tuning object reaches existing bridges (and
 * every bridge of a multi-process agent) without a restart.
 *
 * Spec: docs/plan/dsh-skills-mcp.md §5.2, §5.3 and §11.6. The wire lists come
 * from `./mcp-tap.mjs`, a preload that records what the mock agent actually
 * received.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { AgentBridge } from '../../src/bridge/agent-bridge.ts'
import { pluginStateDir } from '../../src/bridge/state-paths.ts'
import { DEFAULT_TUNING } from '../../src/bridge/tuning.ts'
import type { BridgeTuning } from '../../src/bridge/types.ts'
import { EventHub, dispatchRpc } from '../../src/impl.ts'
import type { AcpAgentDef, AcpMcpServerDef } from '../../src/protocol.ts'
import { MOCK, def as mockDef, normPath, until } from './harness.ts'

const TAP = pathToFileURL(fileURLToPath(new URL('./mcp-tap.mjs', import.meta.url))).href

/** Non-empty user list on purpose: "same list" is vacuous over an empty one, and an empty send would evict live tools. */
const USER_SERVERS: AcpMcpServerDef[] = [
  { name: 'local', transport: 'stdio', command: '/opt/servers/local', args: ['--mcp'], env: { TOKEN: 'x' } },
  { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
]

/** The user list in ACP wire shape — spelled out, never derived from the converter under test. */
const USER_WIRE = [
  { name: 'local', command: '/opt/servers/local', args: ['--mcp'], env: [{ name: 'TOKEN', value: 'x' }] },
  { type: 'http', name: 'remote', url: 'https://example.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
] as Array<Record<string, unknown>>

interface McpRecord {
  method: string
  mcpServers: Array<Record<string, unknown>> | null
}

interface SkillsHarness {
  manager: BridgeManager
  /** Every session-creating request the agent(s) received, in arrival order. */
  records(): McpRecord[]
  close(): Promise<void>
}

const roots: string[] = []
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function agentDef(
  id: string,
  log: string,
  mcpServers: AcpMcpServerDef[] | undefined,
  idleTimeoutMs?: number,
  skillsMcpEnabled?: boolean,
): AcpAgentDef {
  return {
    ...mockDef,
    id,
    // `--import` runs the tap before the mock's own module body, which is what
    // lets it wrap `process.stdin`'s web-stream conversion.
    args: ['--import', TAP, MOCK],
    env: { ...mockDef.env, MOCK_MCP_LOG: log, MOCK_FORK: '1' },
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    // Absent stays absent on purpose: the default ("on") must be exercised as
    // a MISSING field, not as an explicit `true`.
    ...(skillsMcpEnabled === undefined ? {} : { skillsMcpEnabled }),
  }
}

/**
 * One manager with TWO agents: `main` never parks (the entries run back to
 * back) and `park` releases after a short window, which is how the fourth
 * entry — `session/load` on resume — gets driven deterministically.
 */
function makeHarness(label: string, mcpServers: AcpMcpServerDef[] = USER_SERVERS, skillsMcpEnabled?: boolean): SkillsHarness {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-skills-mcp-'))
  roots.push(root)
  const log = join(root, `${label}.log`)
  const manager = new BridgeManager(
    [
      agentDef(`${label}-main`, log, mcpServers, 0, skillsMcpEnabled),
      agentDef(`${label}-park`, log, mcpServers, 300, skillsMcpEnabled),
    ],
    new EventHub(),
    500,
    join(root, 'agents.json'),
    join(root, 'catalog.json'),
  )
  return {
    manager,
    records: () => existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as McpRecord)
      : [],
    close: () => manager.shutdownAll(),
  }
}

/**
 * Flip the switch exactly the way `SettingsService` does: `Object.assign` into
 * the manager's ONE live tuning object (TypeScript-private only), so every
 * bridge's seam closure sees the rewrite without being rebuilt.
 */
function setSkillsSwitch(manager: BridgeManager, enabled: boolean): void {
  Object.assign((manager as unknown as { tuning: Required<BridgeTuning> }).tuning, { skillsMcpEnabled: enabled })
}

/**
 * Drive one request through each of the four entries, in a fixed order:
 * `session/new`, `session/new` again (the same bridge, no restart), the probe's
 * `session/new`, `session/fork`, then the parked agent's create and its
 * `session/load` on resume.
 */
async function driveFourEntries(h: SkillsHarness, label: string): Promise<void> {
  const main = `${label}-main`
  h.manager.bindChatAgent(`${label}-a`, main)
  await h.manager.getOrCreateDshSession(`${label}-a`, main)
  await h.manager.getOrCreateDshSession(`${label}-b`, main)
  // The second session/new above and this fork come from the bridge that was
  // already serving `${label}-a` — a restart would have parked it.
  await h.manager.adoptForkedSession(`${label}-fork`, `${label}-a`)
  await h.manager.probeAgentModels(main)

  const park = `${label}-park`
  h.manager.bindChatAgent(`${label}-c`, park)
  const parked = await h.manager.getOrCreateDshSession(`${label}-c`, park)
  await until(() => h.manager.sessions().some(session => session.sessionId === parked.sessionId && session.released === true))
  await h.manager.resumeChatSession(`${label}-c`)
}

describe('dsh-skills MCP on the four session-creating entries', () => {
  it('adds nothing to any entry while the switch is off', async () => {
    const h = makeHarness('off')
    try {
      await driveFourEntries(h, 'off')
      const records = h.records()
      expect(records.map(record => record.method)).toEqual([
        'session/new', // main: create
        'session/new', // main: create (same bridge)
        'session/fork', // main: branch
        'session/new', // main: the probe's throwaway session
        'session/new', // park: create
        'session/load', // park: resume after the idle release
      ])
      // Every entry hands the agent the user list and only that: no built-in
      // declaration when the switch is off, not even on the probe.
      for (const record of records) expect(record.mcpServers).toEqual(USER_WIRE)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('declares the same built-in dsh-skills list on all four entries, hot after a live switch flip', async () => {
    const h = makeHarness('on')
    try {
      const main = 'on-main'
      h.manager.bindChatAgent('on-a', main)
      // Created with the switch OFF: the bridge now exists and holds a session.
      const first = await h.manager.getOrCreateDshSession('on-a', main)
      expect(h.records().map(record => record.mcpServers)).toEqual([USER_WIRE])

      setSkillsSwitch(h.manager, true)

      await h.manager.getOrCreateDshSession('on-b', main)
      await h.manager.adoptForkedSession('on-fork', 'on-a')
      await h.manager.probeAgentModels(main)

      const park = 'on-park'
      h.manager.bindChatAgent('on-c', park)
      const parked = await h.manager.getOrCreateDshSession('on-c', park)
      await until(() => h.manager.sessions().some(session => session.sessionId === parked.sessionId && session.released === true))
      await h.manager.resumeChatSession('on-c')

      const records = h.records()
      expect(records.map(record => record.method)).toEqual([
        'session/new', // before the flip → no built-in
        'session/new', // after the flip, SAME bridge, no restart
        'session/fork',
        'session/new', // the probe's throwaway session, a second bridge of the same agent
        'session/new', // the parked agent's own bridge
        'session/load',
      ])

      // The flip reached a bridge that already existed and had already created
      // a session with the other answer: no restart, the NEXT request sees it.
      expect(records[0].mcpServers).toEqual(USER_WIRE)
      const mainView = h.manager.agentViews().find(view => view.id === main)
      expect(mainView?.state).toBe('ready')
      // Both sessions still live on that ONE process: a respawn would have
      // parked them (release, then `session/load` to bring them back).
      expect(mainView?.liveSessions).toContain(first.sessionId)
      expect(h.manager.sessions().filter(session => session.agentId === main && session.released === true)).toEqual([])

      // One list for the process, whichever entry asks for it.
      const after = records.slice(1).map(record => record.mcpServers)
      for (const list of after) expect(list).toEqual(after[0])

      const builtin = after[0]?.at(-1)
      expect(builtin).toMatchObject({ name: 'dsh-skills', command: process.execPath })
      // stdio on the wire NEVER carries `type` — the agent silently drops a
      // server that does (see `toAcpMcpServers`).
      expect(builtin && 'type' in builtin).toBe(false)
      const args = builtin?.args as string[]
      expect(args).toHaveLength(1)
      expect(existsSync(args[0])).toBe(true)
      expect(normPath(args[0]).endsWith('/mcp/skills-server.mjs')).toBe(true)
      // The server derives the skills root from the state dir, and it is
      // spawned by the AGENT: the value must be written, never inherited.
      expect(builtin?.env).toEqual([{ name: 'DSH_NTR_STATE_DIR', value: pluginStateDir() }])
      // The user's own servers stay first and untouched.
      expect(after[0]?.slice(0, 2)).toEqual(USER_WIRE)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('keeps a user server already named dsh-skills instead of appending the built-in one', async () => {
    const userOwned = { name: 'dsh-skills', transport: 'stdio', command: '/usr/local/bin/my-skills', args: [] }
    const def: AcpMcpServerDef[] = [...USER_SERVERS, userOwned]
    const h = makeHarness('collide', def)
    try {
      const owned = 'collide-main'
      h.manager.bindChatAgent('collide-a', owned)
      setSkillsSwitch(h.manager, true)
      await h.manager.getOrCreateDshSession('collide-a', owned)
      const [record] = h.records()
      expect(record.mcpServers).toEqual([...USER_WIRE, { name: 'dsh-skills', command: '/usr/local/bin/my-skills', args: [], env: [] }])
    } finally {
      await h.close()
    }
  }, 30_000)

  it('a bare bridge without the seam stays off even when tuning says on', () => {
    const def = { ...mockDef, mcpServers: USER_SERVERS }
    const tuningOn = { ...DEFAULT_TUNING, skillsMcpEnabled: true }
    const names = (bridge: AgentBridge) =>
      (bridge as unknown as { mcpServersForSession(): Array<{ name: string }> }).mcpServersForSession().map(server => server.name)
    // No seam (a direct consumer / legacy construction point): the flag is OFF
    // regardless of tuning — the seam is the only truth, never a copied field.
    const bare = new AgentBridge(def, new EventHub(), 500, () => {}, undefined, undefined, tuningOn)
    expect(names(bare)).toEqual(['local', 'remote'])
    const wired = new AgentBridge(def, new EventHub(), 500, () => {}, undefined, undefined, tuningOn, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => true)
    expect(names(wired)).toEqual(['local', 'remote', 'dsh-skills'])
  })
})

/**
 * The SECOND level: `AcpAgentDef.skillsMcpEnabled` narrows the master switch
 * for one agent (AND semantics — `总开关 && def.skillsMcpEnabled !== false`).
 * Driven through the real RPC and the real agent process, because the whole
 * point is that the value is read off the SHARED definition at request time.
 */
describe('dsh-skills MCP per-agent opt-out', () => {
  it('an agent that opted out gets no built-in server while the master switch is on — until it opts back in', async () => {
    const h = makeHarness('optout', USER_SERVERS, false)
    try {
      setSkillsSwitch(h.manager, true)
      const main = 'optout-main'
      h.manager.bindChatAgent('optout-a', main)
      await h.manager.getOrCreateDshSession('optout-a', main)
      await h.manager.probeAgentModels(main)
      // Create + the probe's throwaway session: the probe is the entry that
      // would otherwise hand a second, different list to the same process.
      expect(h.records().map(record => record.method)).toEqual(['session/new', 'session/new'])
      for (const record of h.records()) expect(record.mcpServers).toEqual(USER_WIRE)

      // The master switch really was on: the per-agent half was the only
      // reason the built-in stayed away.
      await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: main, skillsMcpEnabled: true }))
        .resolves.toEqual({ ok: true, value: { done: true } })
      await h.manager.getOrCreateDshSession('optout-b', main)
      expect(h.records().at(-1)?.mcpServers?.at(-1)).toMatchObject({ name: 'dsh-skills' })
    } finally {
      await h.close()
    }
  }, 60_000)

  it('ignores the per-agent switch while the master switch is off', async () => {
    const h = makeHarness('masteroff', USER_SERVERS, true)
    try {
      const main = 'masteroff-main'
      h.manager.bindChatAgent('masteroff-a', main)
      await h.manager.getOrCreateDshSession('masteroff-a', main)
      // Per-agent explicitly ON, master OFF: the kill-switch wins.
      expect(h.records().map(record => record.method)).toEqual(['session/new'])
      expect(h.records()[0].mcpServers).toEqual(USER_WIRE)

      setSkillsSwitch(h.manager, true)
      await h.manager.getOrCreateDshSession('masteroff-b', main)
      expect(h.records()[1].mcpServers?.at(-1)).toMatchObject({ name: 'dsh-skills' })
    } finally {
      await h.close()
    }
  }, 60_000)

  it('treats an absent per-agent field as on', async () => {
    const h = makeHarness('default-on', USER_SERVERS)
    try {
      setSkillsSwitch(h.manager, true)
      const main = 'default-on-main'
      h.manager.bindChatAgent('default-on-a', main)
      await h.manager.getOrCreateDshSession('default-on-a', main)
      // No migration: every definition written before the second level existed
      // behaves exactly as it did with the master switch alone.
      expect(h.records()[0].mcpServers?.at(-1)).toMatchObject({ name: 'dsh-skills' })
      expect(h.records()[0].mcpServers).toHaveLength(USER_WIRE.length + 1)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('applies agent/set-skills-mcp to an existing bridge without a restart', async () => {
    const h = makeHarness('toggle')
    try {
      setSkillsSwitch(h.manager, true)
      const main = 'toggle-main'
      h.manager.bindChatAgent('toggle-a', main)
      const first = await h.manager.getOrCreateDshSession('toggle-a', main)
      expect(h.records()[0].mcpServers?.at(-1)).toMatchObject({ name: 'dsh-skills' })

      await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: main, skillsMcpEnabled: false }))
        .resolves.toEqual({ ok: true, value: { done: true } })

      // No restart: the same process still serves the session created before
      // the flip, and nothing was parked waiting for a `session/load`.
      const view = h.manager.agentViews().find(entry => entry.id === main)
      expect(view?.state).toBe('ready')
      expect(view?.liveSessions).toContain(first.sessionId)
      expect(h.manager.sessions().filter(session => session.agentId === main && session.released === true)).toEqual([])

      // The next session-creating request on that SAME bridge already sees it.
      await h.manager.getOrCreateDshSession('toggle-b', main)
      expect(h.records()[1].mcpServers).toEqual(USER_WIRE)

      // And back on, again without a restart.
      await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: main, skillsMcpEnabled: true }))
        .resolves.toEqual({ ok: true, value: { done: true } })
      await h.manager.getOrCreateDshSession('toggle-c', main)
      expect(h.records()[2].mcpServers).toEqual(h.records()[0].mcpServers)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('rejects a non-boolean per-agent value without touching the process', async () => {
    const h = makeHarness('badvalue')
    try {
      setSkillsSwitch(h.manager, true)
      const main = 'badvalue-main'
      h.manager.bindChatAgent('badvalue-a', main)
      await h.manager.getOrCreateDshSession('badvalue-a', main)
      for (const payload of [{ agentId: main }, { agentId: main, skillsMcpEnabled: 'off' }, { skillsMcpEnabled: false }]) {
        await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', payload))
          .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
      }
      await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: 'nobody', skillsMcpEnabled: false }))
        .resolves.toMatchObject({ ok: false, error: { code: 'unknown_agent' } })
      // The refused calls changed nothing: the next create still carries the
      // built-in server, on the same process.
      await h.manager.getOrCreateDshSession('badvalue-b', main)
      expect(h.records()[1].mcpServers?.at(-1)).toMatchObject({ name: 'dsh-skills' })
    } finally {
      await h.close()
    }
  }, 60_000)
})
