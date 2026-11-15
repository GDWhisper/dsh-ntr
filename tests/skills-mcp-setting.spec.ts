/**
 * The `dsh-skills` MCP switch as a SETTING: what it defaults to, what a write
 * puts on disk, what a restart reads back, and the rollback that keeps the disk
 * and the running tuning in agreement when the write cannot land.
 *
 * Spec: docs/plan/dsh-skills-mcp.md §10 step 4 and the §11.1 acceptance matrix.
 * Driven through `dispatchRpc` (the real `/acp` surface) on a real
 * `BridgeManager`, so the strict-persist path, the settings service and the
 * live tuning object are all exercised together; every state file lives in a
 * temp dir.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BridgeManager } from '../src/bridge.ts'
import { EventHub, dispatchRpc } from '../src/impl.ts'
import type { AcpAgentDef, AcpEvent, DetectedAgentInfo } from '../src/protocol.ts'

const roots: string[] = []
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Booted {
  manager: BridgeManager
  /** Everything the host broadcast since boot, in order. */
  events: AcpEvent[]
  /** Where `agents.json` would be written. */
  statePath: string
  close(): Promise<void>
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-skills-setting-'))
  roots.push(root)
  return root
}

/**
 * Boot a manager over `root`. `statePath` is the `agents.json` it reads and
 * writes; pass one inside a directory that does NOT exist to make every write
 * fail (`writeFileSync` never creates the parent).
 */
function boot(root: string, statePath = join(root, 'agents.json'), defs: AcpAgentDef[] = []): Booted {
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const manager = new BridgeManager(defs, hub, 500, statePath, join(root, 'catalog.json'), false)
  return { manager, events, statePath, close: () => manager.shutdownAll() }
}

/** A definition with no process behind it: the per-agent switch needs only the def. */
function def(extra: Partial<AcpAgentDef> = {}): AcpAgentDef {
  return { id: 'pi', title: 'pi', command: 'pi-acp', args: [], env: {}, allowedCwdRoots: [], ...extra }
}

/**
 * The stored per-agent switch as the settings card reads it (`agents/detect`
 * hands back the shared def): the RESOLVED answer, `undefined` only when the
 * agent itself is unknown.
 */
async function storedSwitch(manager: BridgeManager): Promise<boolean | undefined> {
  const result = await dispatchRpc(manager, 'agents/detect', {})
  const agents = (result as { ok: true; value: { agents: DetectedAgentInfo[] } }).value.agents
  const config = agents.find(info => info.id === 'pi')?.currentConfig
  return config === undefined ? undefined : config.skillsMcpEnabled !== false
}

/** The persisted file as plain JSON (only valid once something has written it). */
function readState(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

/**
 * The value the NEXT `makeBridge` would read. TypeScript-private only: the
 * switch lives in the manager's ONE live tuning object, which is exactly what
 * the bridge seam closes over.
 */
function tuningOf(manager: BridgeManager): boolean | undefined {
  return (manager as unknown as { tuning: { skillsMcpEnabled?: boolean } }).tuning.skillsMcpEnabled
}

/** Read the switch over `/acp`, the way the settings page does. */
async function readSwitch(manager: BridgeManager): Promise<unknown> {
  return dispatchRpc(manager, 'ui/skills-mcp', {})
}

describe('the dsh-skills MCP switch as a persisted setting', () => {
  it('is off by default, answers off, and writes no state file until asked', async () => {
    const h = boot(makeRoot())
    try {
      await expect(readSwitch(h.manager)).resolves.toEqual({ ok: true, value: { skillsMcpEnabled: false } })
      expect(tuningOf(h.manager)).toBe(false)
      // Reading is not writing: a deployment that never touched the switch
      // keeps exactly the state file it had (here: none).
      expect(existsSync(h.statePath)).toBe(false)
    } finally {
      await h.close()
    }
  })

  it('persists through the strict write path and adopts the host value, without agent/save or a restart', async () => {
    const h = boot(makeRoot())
    try {
      await expect(dispatchRpc(h.manager, 'ui/skills-mcp-set', { skillsMcpEnabled: true }))
        .resolves.toEqual({ ok: true, value: { skillsMcpEnabled: true } })
      expect(readState(h.statePath).skillsMcpEnabled).toBe(true)
      expect(tuningOf(h.manager)).toBe(true)
      // The switch reaches the NEXT session through the shared tuning object; it
      // must not rewrite the roster (which restarts every agent process).
      expect(h.events.filter(event => event.type === 'agent/save')).toEqual([])
      expect(h.manager.agentViews()).toEqual([])
      await expect(readSwitch(h.manager)).resolves.toEqual({ ok: true, value: { skillsMcpEnabled: true } })
    } finally {
      await h.close()
    }
  })

  it('restores the written value across restarts, and an explicit false survives the round trip', async () => {
    const root = makeRoot()
    const first = boot(root)
    await dispatchRpc(first.manager, 'ui/skills-mcp-set', { skillsMcpEnabled: true })
    await first.close()

    const second = boot(root)
    try {
      await expect(readSwitch(second.manager)).resolves.toEqual({ ok: true, value: { skillsMcpEnabled: true } })
      expect(tuningOf(second.manager)).toBe(true)
    } finally {
      await second.close()
    }

    // Off is a VALUE, not an absence: it must come back as off, not as "unset"
    // (which would run off anyway, but would drop the key from the file).
    const third = boot(root)
    await dispatchRpc(third.manager, 'ui/skills-mcp-set', { skillsMcpEnabled: false })
    await third.close()

    const fourth = boot(root)
    try {
      expect(readState(fourth.statePath).skillsMcpEnabled).toBe(false)
      await expect(readSwitch(fourth.manager)).resolves.toEqual({ ok: true, value: { skillsMcpEnabled: false } })
      expect(tuningOf(fourth.manager)).toBe(false)
    } finally {
      await fourth.close()
    }
  })

  it('runs off when the persisted value is not a boolean', async () => {
    const root = makeRoot()
    const statePath = join(root, 'agents.json')
    // A hand-edited file: every unreadable shape must fail OFF, never on.
    for (const stored of ['yes', 1, {}, [], null]) {
      writeFileSync(statePath, JSON.stringify({ version: 2, skillsMcpEnabled: stored }), 'utf-8')
      const h = boot(root)
      try {
        await expect(readSwitch(h.manager)).resolves.toEqual({ ok: true, value: { skillsMcpEnabled: false } })
        expect(tuningOf(h.manager)).toBe(false)
      } finally {
        await h.close()
      }
    }
  })

  it('rejects a payload that is not a boolean without writing anything', async () => {
    const root = makeRoot()
    const h = boot(root)
    try {
      await dispatchRpc(h.manager, 'ui/skills-mcp-set', { skillsMcpEnabled: true })
      const before = readFileSync(h.statePath, 'utf-8')
      for (const payload of [{}, { skillsMcpEnabled: 'yes' }, { skillsMcpEnabled: 1 }, { skillsMcpEnabled: null }]) {
        await expect(dispatchRpc(h.manager, 'ui/skills-mcp-set', payload))
          .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
      }
      // No coercion, no write, no state change: the answer is still the value
      // written above, byte for byte on disk.
      expect(readFileSync(h.statePath, 'utf-8')).toBe(before)
      await expect(readSwitch(h.manager)).resolves.toEqual({ ok: true, value: { skillsMcpEnabled: true } })
      expect(tuningOf(h.manager)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('rolls the field and the tuning back when the strict write fails', async () => {
    const root = makeRoot()
    // The parent directory does not exist, so `writeFileSync` throws: the switch
    // must NOT answer "true" while nothing was saved, and the tuning that the
    // next bridge would read must stay on the old value.
    const h = boot(root, join(root, 'missing-dir', 'agents.json'))
    try {
      await expect(dispatchRpc(h.manager, 'ui/skills-mcp-set', { skillsMcpEnabled: true }))
        .resolves.toMatchObject({ ok: false, error: { code: 'persist_failed' } })
      expect(existsSync(h.statePath)).toBe(false)
      await expect(readSwitch(h.manager)).resolves.toEqual({ ok: true, value: { skillsMcpEnabled: false } })
      expect(tuningOf(h.manager)).toBe(false)
    } finally {
      await h.close()
    }

    // Same rule over a file that DOES exist: a failed write leaves the old
    // answer and the old bytes in place. The failure is produced the way the
    // real world does it — the state directory disappears under a running
    // host (Windows has no chmod, and a strict write must not answer "saved").
    const root2 = makeRoot()
    const good = boot(root2)
    const parked = `${root2}-parked`
    try {
      await dispatchRpc(good.manager, 'ui/skills-mcp-set', { skillsMcpEnabled: true })
      const before = readFileSync(good.statePath, 'utf-8')
      renameSync(root2, parked)
      await expect(dispatchRpc(good.manager, 'ui/skills-mcp-set', { skillsMcpEnabled: false }))
        .resolves.toMatchObject({ ok: false, error: { code: 'persist_failed' } })
      await expect(readSwitch(good.manager)).resolves.toEqual({ ok: true, value: { skillsMcpEnabled: true } })
      expect(tuningOf(good.manager)).toBe(true)
      renameSync(parked, root2)
      expect(readFileSync(good.statePath, 'utf-8')).toBe(before)
    } finally {
      if (existsSync(parked)) renameSync(parked, root2)
      await good.close()
    }
  })
})

/**
 * The per-agent half of the two-level switch (`AcpAgentDef.skillsMcpEnabled`,
 * missing = on). Same discipline as the master switch: a lightweight RPC that
 * edits the definition IN PLACE and STRICTLY persists it — never `agent/save`,
 * never a restart — with the edit rolled back when the write cannot land.
 */
describe('the per-agent dsh-skills opt-out', () => {
  it('persists the opt-out on the definition, answers the exposure frame, and never saves or restarts the agent', async () => {
    const h = boot(makeRoot(), undefined, [def()])
    try {
      await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: 'pi', skillsMcpEnabled: false }))
        .resolves.toEqual({ ok: true, value: { done: true } })
      const stored = readState(h.statePath) as { agents: Array<Record<string, unknown>> }
      expect(stored.agents[0]).toMatchObject({ id: 'pi', skillsMcpEnabled: false })
      expect(await storedSwitch(h.manager)).toBe(false)
      // The browser patches its open card from this frame; it carries the
      // RESOLVED value so a stale card cannot write the old one back later.
      expect(h.events.filter(event => event.type === 'agent/exposure').at(-1))
        .toMatchObject({ agentId: 'pi', skillsMcpEnabled: false })
      // A lightweight write: no save frame, no process restart.
      expect(h.events.filter(event => event.type === 'agent/save')).toEqual([])

      // Back on: the explicit opt-out is the ONLY value ever stored, so `true`
      // clears the key instead of leaving `skillsMcpEnabled: true` noise.
      await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: 'pi', skillsMcpEnabled: true }))
        .resolves.toEqual({ ok: true, value: { done: true } })
      const cleared = readState(h.statePath) as { agents: Array<Record<string, unknown>> }
      expect('skillsMcpEnabled' in (cleared.agents[0] ?? {})).toBe(false)
      expect(await storedSwitch(h.manager)).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('a save whose payload omits the key inherits a live opt-out (stale queued form save)', async () => {
    const h = boot(makeRoot(), undefined, [def()])
    try {
      await dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: 'pi', skillsMcpEnabled: false })
      // A form payload built before the opt-out carries no key; the flush must
      // not resurrect the built-in server.
      await h.manager.saveAgent?.(def())
      expect(await storedSwitch(h.manager)).toBe(false)
      const stored = readState(h.statePath) as { agents: Array<Record<string, unknown>> }
      expect(stored.agents[0]).toMatchObject({ id: 'pi', skillsMcpEnabled: false })
    } finally {
      await h.close()
    }
  })

  it('survives a restart through the validated state file', async () => {
    const root = makeRoot()
    const first = boot(root, undefined, [def({ skillsMcpEnabled: false })])
    await dispatchRpc(first.manager, 'ui/skills-mcp-set', { skillsMcpEnabled: true })
    await first.close()

    // A restart re-reads the file through `validateAgentDef`; the opt-out must
    // survive the rebuild (otherwise the second boot silently re-enables it).
    const second = boot(root, undefined, [])
    try {
      const stored = readState(second.statePath) as { agents: Array<{ id: string; skillsMcpEnabled?: boolean }> }
      expect(stored.agents[0]).toMatchObject({ id: 'pi', skillsMcpEnabled: false })
      expect(await storedSwitch(second.manager)).toBe(false)
    } finally {
      await second.close()
    }
  })

  it('rejects a non-boolean or unknown-agent call without writing anything', async () => {
    const h = boot(makeRoot(), undefined, [def()])
    try {
      await dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: 'pi', skillsMcpEnabled: false })
      const before = readFileSync(h.statePath, 'utf-8')
      for (const payload of [{ agentId: 'pi' }, { agentId: 'pi', skillsMcpEnabled: 'yes' }, { agentId: 'pi', skillsMcpEnabled: 1 }, { skillsMcpEnabled: false }]) {
        await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', payload))
          .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
      }
      await expect(dispatchRpc(h.manager, 'agent/set-skills-mcp', { agentId: 'nobody', skillsMcpEnabled: false }))
        .resolves.toMatchObject({ ok: false, error: { code: 'unknown_agent' } })
      // No coercion, no write: the file is byte-identical and the value is
      // still the one written above.
      expect(readFileSync(h.statePath, 'utf-8')).toBe(before)
      expect(await storedSwitch(h.manager)).toBe(false)
    } finally {
      await h.close()
    }
  })

  it('rolls the definition back (and leaves the disk alone) when the strict write fails', async () => {
    // A missing parent directory: the strict write throws `persist_failed`.
    const root = makeRoot()
    const broken = boot(root, join(root, 'missing-dir', 'agents.json'), [def({ skillsMcpEnabled: false })])
    try {
      await expect(dispatchRpc(broken.manager, 'agent/set-skills-mcp', { agentId: 'pi', skillsMcpEnabled: true }))
        .resolves.toMatchObject({ ok: false, error: { code: 'persist_failed' } })
      expect(existsSync(broken.statePath)).toBe(false)
      // The shared definition the live bridges read was restored, and no frame
      // claims the new value.
      expect(await storedSwitch(broken.manager)).toBe(false)
      expect(broken.events.filter(event => event.type === 'agent/exposure')).toEqual([])
    } finally {
      await broken.close()
    }

    // Same over a file that exists: the state directory disappears under a
    // running host, and the opt-out flip must not answer "saved".
    const root2 = makeRoot()
    const good = boot(root2, undefined, [def({ skillsMcpEnabled: false })])
    const parked = `${root2}-parked`
    try {
      await dispatchRpc(good.manager, 'agent/set-skills-mcp', { agentId: 'pi', skillsMcpEnabled: true })
      const before = readFileSync(good.statePath, 'utf-8')
      renameSync(root2, parked)
      await expect(dispatchRpc(good.manager, 'agent/set-skills-mcp', { agentId: 'pi', skillsMcpEnabled: false }))
        .resolves.toMatchObject({ ok: false, error: { code: 'persist_failed' } })
      expect(await storedSwitch(good.manager)).toBe(true)
      renameSync(parked, root2)
      expect(readFileSync(good.statePath, 'utf-8')).toBe(before)
    } finally {
      if (existsSync(parked)) renameSync(parked, root2)
      await good.close()
    }
  })
})
