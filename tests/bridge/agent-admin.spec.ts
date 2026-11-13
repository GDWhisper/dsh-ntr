import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { type AcpAgentDef, type AcpEvent, type ActiveTurnView } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { AcpSaveGate } from '../../src/save-gate.ts'
import { createBridgeHarness, MOCK } from './harness.ts'

const { hub, manager } = createBridgeHarness()

afterAll(async () => {
  await manager.shutdownAll()
})

/**
 * Save-gate integration at the manager seam: a delete must cancel the agent's
 * held save, and a forced save of an IDLE agent must not drain other agents'
 * queued writes.
 */
describe('agent saves behind the save gate (isolated manager)', () => {
  function gateFor(views: ActiveTurnView[]) {
    const state = { active: views.length > 0, views }
    const host = {
      state,
      hasActiveTurns: () => state.active,
      activeTurnViews: () => state.views,
    }
    return { host, gate: new AcpSaveGate(host, undefined, { timeoutMs: 0 }) }
  }

  const targetDef: AcpAgentDef = {
    id: 'target',
    title: 'Target',
    command: process.execPath,
    args: [MOCK],
    cwd: tmpdir(),
    allowedCwdRoots: [tmpdir()],
  }

  it('delete cancels the held save so a later flush cannot resurrect the agent', async () => {
    const storage = `${tmpdir()}/acp-save-gate-delete-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { host, gate } = gateFor([{ sessionId: 'acp-ghost', agentId: 'ghost' }])
    isolated.setSaveGate(gate)
    // The manager's own turn views come from live bridges; this test is about
    // the delete/flush ordering, so the gate's host stands in for that fact.
    const patched = isolated as unknown as { activeTurnViews: () => ActiveTurnView[] }
    patched.activeTurnViews = () => host.state.views
    const ghost = { ...targetDef, id: 'ghost', title: 'Ghost' }

    await expect(isolated.saveAgent(ghost, 'defer')).resolves.toMatchObject({ done: true, deferred: true })
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:ghost'])

    await isolated.deleteAgent('ghost')
    expect(gate.status().pending).toEqual([])

    // The turn ends after the delete: flushing must not run the stale write.
    host.state.active = false
    host.state.views = []
    gate.sync()
    await gate.forceFlush()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(isolated.agentViews().some(agent => agent.id === 'ghost')).toBe(false)
  })

  it('force-saving an idle agent leaves other agents\' held writes queued', async () => {
    const storage = `${tmpdir()}/acp-save-gate-force-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { gate } = gateFor([{ sessionId: 'acp-other', agentId: 'other' }])
    isolated.setSaveGate(gate)
    const target = { ...targetDef }
    // A direct save probes the catalog by spawning; this test only needs the
    // manager's save decision.
    ;(isolated as unknown as { probeAgentModels: (id: string) => Promise<void> }).probeAgentModels =
      async () => {}

    const otherSave = vi.fn(async () => 'other')
    const held = gate.defer('agent-save:other', otherSave)
    await expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:other'])

    await expect(isolated.saveAgent(target, 'force')).resolves.toEqual({ done: true })
    expect(otherSave).not.toHaveBeenCalled()
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:other'])

    gate.cancel('agent-save:other')
    await expect(held).resolves.toEqual({ status: 'cancelled' })
    await isolated.shutdownAll()
  })

  it('a direct save of an idle agent cancels that agent\'s older held snapshot', async () => {
    const storage = `${tmpdir()}/acp-save-gate-supersede-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { gate } = gateFor([{ sessionId: 'acp-other', agentId: 'other' }])
    isolated.setSaveGate(gate)
    const target = { ...targetDef }
    ;(isolated as unknown as { probeAgentModels: (id: string) => Promise<void> }).probeAgentModels =
      async () => {}

    const staleOperation = vi.fn(async () => 'stale')
    const stale = gate.defer('agent-save:target', staleOperation)
    await expect(isolated.saveAgent(target, 'direct')).resolves.toEqual({ done: true })
    await expect(stale).resolves.toEqual({ status: 'cancelled' })
    expect(staleOperation).not.toHaveBeenCalled()
    expect(gate.status().pending).toEqual([])
    await isolated.shutdownAll()
  })

  it('a delete during an in-flight save aborts the save without resurrecting the agent', async () => {
    const storage = `${tmpdir()}/acp-save-gate-inflight-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-target', agentId: 'target' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    // Make the save body enter its stop await. The bridge value is never
    // touched because `stopAgent` is replaced below.
    patched.bridges.set('target', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    let stopCalls = 0
    patched.stopAgent = async () => {
      stopCalls += 1
      if (stopCalls === 1) await heldStop
    }
    const probe = vi.fn(async () => {})
    patched.probeAgentModels = probe

    await expect(isolated.saveAgent({ ...targetDef }, 'defer')).resolves.toMatchObject({ done: true, deferred: true })
    const flushing = gate.forceFlush()
    // The save is now stopped inside its await; delete it there.
    expect(stopCalls).toBe(1)
    await isolated.deleteAgent('target')
    releaseStop()
    // The delete wins: the gate sees an abort, not a failure, and records no
    // outcome (so the browser draws no failure banner).
    await expect(flushing).resolves.toEqual({ saved: 0, expired: 0, failed: 0, cancelled: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(isolated.agentViews().some(agent => agent.id === 'target')).toBe(false)
    expect(gate.status().lastOutcomes?.['agent-save:target']).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string }> }
    expect(disk.agents?.some(agent => agent.id === 'target')).toBe(false)
    await isolated.shutdownAll()
  })

  it('a delete during a direct save reports cancelled instead of an error', async () => {
    const storage = `${tmpdir()}/acp-save-direct-inflight-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    // The dummy bridge only makes the save body enter its stop await.
    patched.activeTurnViews = () => []
    patched.bridges.set('direct', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    let stopCalls = 0
    patched.stopAgent = async () => {
      stopCalls += 1
      if (stopCalls === 1) await heldStop
    }
    const probe = vi.fn(async () => {})
    patched.probeAgentModels = probe

    const saving = isolated.saveAgent({ ...targetDef, id: 'direct' }, 'direct')
    expect(stopCalls).toBe(1)
    await isolated.deleteAgent('direct')
    releaseStop()
    await expect(saving).resolves.toEqual({ done: true, cancelled: true })
    expect(isolated.agentViews().some(agent => agent.id === 'direct')).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    await isolated.shutdownAll()
  })

  it('refuses a save of a tombstoned id while other agents still save normally', async () => {
    const storage = `${tmpdir()}/acp-save-gate-tombstone-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    ;(isolated as unknown as { probeAgentModels: (id: string) => Promise<void> }).probeAgentModels =
      async () => {}

    await isolated.deleteAgent('gone')
    await expect(isolated.saveAgent({ ...targetDef, id: 'gone' })).rejects.toMatchObject({ code: 'agent_deleted' })
    // The tombstone is per id: an unrelated save keeps the old behavior.
    await expect(isolated.saveAgent({ ...targetDef, id: 'kept' })).resolves.toEqual({ done: true })
    expect(isolated.agentViews().some(agent => agent.id === 'gone')).toBe(false)
    expect(isolated.agentViews().some(agent => agent.id === 'kept')).toBe(true)
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string }> }
    expect(disk.agents?.map(agent => agent.id)).toEqual(['kept'])
    await isolated.shutdownAll()
  })

  it('reports a failed agent-state write as a failed save outcome and refuses the delete', async () => {
    // A directory in place of the state file makes every write fail.
    const storageDir = mkdtempSync(join(tmpdir(), 'acp-persist-fail-'))
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storageDir)
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-target', agentId: 'disk-fail' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    patched.probeAgentModels = async () => {}

    await expect(isolated.saveAgent({ ...targetDef, id: 'disk-fail' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    await expect(gate.forceFlush()).resolves.toMatchObject({ failed: 1 })
    expect(gate.status().lastOutcomes?.['agent-save:disk-fail']).toMatchObject({ status: 'failed' })
    // The disk write failed, so the definition must NOT be committed to memory:
    // `defsMap` may only name what the registry file actually holds.
    expect(isolated.agentViews().some(agent => agent.id === 'disk-fail')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(localEvents).toContainEqual(expect.objectContaining({
      type: 'agent/notice',
      level: 'error',
      text: expect.stringContaining('deferred agent save failed'),
    }))

    // A delete is now strict: the RPC fails with `persist_failed`, but the
    // tombstone and the in-memory removal stay in place.
    await expect(dispatchRpc(isolated, 'agent/delete', { agentId: 'disk-fail' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'persist_failed' },
    })
    expect(isolated.agentViews().some(agent => agent.id === 'disk-fail')).toBe(false)
    await expect(isolated.saveAgent({ ...targetDef, id: 'disk-fail' })).rejects.toMatchObject({
      code: 'agent_deleted',
    })
    await isolated.shutdownAll()
  })

  it('fails a save strictly when the host has no writable state path', async () => {
    // Under the test runner no state dir is implied, so persistence is
    // deliberately disabled — exactly the "old host half" shape.
    const isolated = new BridgeManager([], hub, 100)
    ;(isolated as unknown as { probeAgentModels: (id: string) => Promise<void> }).probeAgentModels =
      async () => {}
    await expect(isolated.saveAgent({ ...targetDef, id: 'no-path' }, 'direct')).rejects.toMatchObject({
      code: 'persist_failed',
    })
    expect(isolated.agentViews().some(agent => agent.id === 'no-path')).toBe(false)
    await isolated.shutdownAll()
  })

  it('reports gate availability only when a real gate is wired', () => {
    const storage = `${tmpdir()}/acp-gate-availability-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    // No gate: the synthetic idle snapshot must not claim to be gate-backed.
    expect(isolated.saveGateStatus()).toMatchObject({ gateAvailable: false })
    const { gate } = gateFor([])
    isolated.setSaveGate(gate)
    expect(isolated.saveGateStatus()).toMatchObject({ gateAvailable: true })
  })

  it('a newer save supersedes an in-flight save before it can write', async () => {
    const storage = `${tmpdir()}/acp-save-generation-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => []
    // The dummy bridge makes the save body enter its stop await.
    patched.bridges.set('race', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    let stopCalls = 0
    patched.stopAgent = async () => {
      stopCalls += 1
      if (stopCalls === 1) await heldStop
    }
    patched.probeAgentModels = async () => {}

    const savingOld = isolated.saveAgent({ ...targetDef, id: 'race', title: 'Old' }, 'direct')
    expect(stopCalls).toBe(1)
    // The newer save starts while the older one is stopped inside its await.
    const savingNew = isolated.saveAgent({ ...targetDef, id: 'race', title: 'New' }, 'direct')
    await expect(savingNew).resolves.toEqual({ done: true })
    releaseStop()
    // The older save aborts: it must not write the Old definition over New.
    await expect(savingOld).resolves.toEqual({ done: true, cancelled: true })
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.find(agent => agent.id === 'race')?.title).toBe('New')
    // No `agent/status` frame for the aborted save: only the winner broadcasts.
    const statuses = localEvents.filter(event => event.type === 'agent/status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ agentId: 'race', agent: { title: 'New' } })
    await isolated.shutdownAll()
  })

  it('a newer deferred save supersedes an in-flight direct save of the same label', async () => {
    const storage = `${tmpdir()}/acp-save-generation-direct-then-defer-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage)
    const { host: gateHost, gate } = gateFor([])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    patched.bridges.set('mix2', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    patched.stopAgent = async () => { await heldStop }
    patched.probeAgentModels = async () => {}

    const savingOld = isolated.saveAgent({ ...targetDef, id: 'mix2', title: 'Old' }, 'direct')
    // The newer save arrives while the direct one is stopped inside its await;
    // a live turn now makes it a deferred save of the same label.
    gateHost.state.active = true
    gateHost.state.views = [{ sessionId: 'acp-mix2', agentId: 'mix2' }]
    await expect(isolated.saveAgent({ ...targetDef, id: 'mix2', title: 'New' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    releaseStop()
    await expect(savingOld).resolves.toEqual({ done: true, cancelled: true })
    // End the turn: the queued newer save flushes and is the only definition.
    gateHost.state.active = false
    gateHost.state.views = []
    gate.sync()
    await new Promise(resolve => setTimeout(resolve, 30))
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.find(agent => agent.id === 'mix2')?.title).toBe('New')
    expect(localEvents.filter(event => event.type === 'agent/status')).toHaveLength(1)
    await isolated.shutdownAll()
  })

  it('a newer forced save supersedes an in-flight deferred save of the same label', async () => {
    const storage = `${tmpdir()}/acp-save-generation-mixed-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage)
    // The target has a live turn, so its first save is queued; the second
    // explicit FORCE save is the newer gesture that must win.
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-mixed', agentId: 'mixed' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    patched.bridges.set('mixed', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    let stopCalls = 0
    patched.stopAgent = async () => {
      stopCalls += 1
      if (stopCalls === 1) await heldStop
    }
    patched.probeAgentModels = async () => {}

    await expect(isolated.saveAgent({ ...targetDef, id: 'mixed', title: 'Queued' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    const flushing = gate.forceFlush()
    expect(stopCalls).toBe(1)
    // The forced save arrives while the queued one is executing. It bumps the
    // generation, so the queued write aborts at its await instead of landing
    // after the newer definition.
    const forced = isolated.saveAgent({ ...targetDef, id: 'mixed', title: 'Forced' }, 'force')
    releaseStop()
    await expect(flushing).resolves.toMatchObject({ cancelled: 1, saved: 0 })
    await expect(forced).resolves.toEqual({ done: true })
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.find(agent => agent.id === 'mixed')?.title).toBe('Forced')
    // Only the winner broadcast status; the aborted queued save did not.
    expect(localEvents.filter(event => event.type === 'agent/status')).toHaveLength(1)
    await isolated.shutdownAll()
  })

  it('a force save cancels only the target\'s own held snapshot and leaves other labels queued', async () => {
    const storage = `${tmpdir()}/acp-save-force-order-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage)
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-target', agentId: 'target' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    // A dummy bridge makes the target's save enter its stop await; the spy is
    // how this test proves WHICH agents the gesture stopped.
    patched.bridges.set('target', {})
    const stopped: string[] = []
    patched.stopAgent = async agentId => { stopped.push(agentId) }
    patched.probeAgentModels = async () => {}

    const staleTarget = vi.fn(async () => 'stale')
    const stale = gate.defer('agent-save:target', staleTarget)
    const otherOperation = vi.fn(async () => 'other')
    const other = gate.defer('agent-save:other', otherOperation)

    await expect(isolated.saveAgent({ ...targetDef, title: 'Fresh' }, 'force')).resolves.toEqual({ done: true })
    // The target's old snapshot was cancelled by its own label cancel, so it
    // never ran. The OTHER label belongs to another agent's dialog: it stays
    // queued, its write never runs, and that agent's process is untouched.
    await expect(stale).resolves.toEqual({ status: 'cancelled' })
    expect(staleTarget).not.toHaveBeenCalled()
    expect(otherOperation).not.toHaveBeenCalled()
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:other'])
    expect(stopped).toEqual(['target'])
    expect(localEvents.filter(event => event.type === 'agent/status').map(event => event.agentId)).toEqual(['target'])
    // The disk holds exactly the target's fresh definition: nothing was flushed
    // on behalf of the other label.
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents).toEqual([expect.objectContaining({ id: 'target', title: 'Fresh' })])

    gate.cancel('agent-save:other')
    await expect(other).resolves.toEqual({ status: 'cancelled' })
    await isolated.shutdownAll()
  })

  it('a force save of an active agent leaves two other labels pending and out of the counters', async () => {
    const storage = `${tmpdir()}/acp-save-force-scope-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-target', agentId: 'target' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    patched.probeAgentModels = async () => {}

    // The target's own stale snapshot is the only entry this gesture may
    // touch; the two other labels belong to other agents' dialogs.
    const staleTarget = vi.fn(async () => 'stale')
    const stale = gate.defer('agent-save:target', staleTarget)
    const firstOperation = vi.fn(async () => 'first')
    const first = gate.defer('agent-save:first', firstOperation)
    const secondOperation = vi.fn(async () => 'second')
    const second = gate.defer('agent-save:second', secondOperation)

    await expect(isolated.saveAgent({ ...targetDef, title: 'Fresh' }, 'force')).resolves.toEqual({ done: true })
    await expect(stale).resolves.toEqual({ status: 'cancelled' })
    expect(staleTarget).not.toHaveBeenCalled()
    expect(firstOperation).not.toHaveBeenCalled()
    expect(secondOperation).not.toHaveBeenCalled()
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:first', 'agent-save:second'])
    // The observable per-label counters name the target only: the two held
    // labels never entered `saved` or `cancelled`.
    expect(gate.status().lastOutcomes?.['agent-save:target']).toMatchObject({ status: 'cancelled' })
    expect(gate.status().lastOutcomes?.['agent-save:first']).toBeUndefined()
    expect(gate.status().lastOutcomes?.['agent-save:second']).toBeUndefined()
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.map(agent => agent.id)).toEqual(['target'])
    expect(disk.agents?.[0]?.title).toBe('Fresh')

    gate.cancel('agent-save:first')
    gate.cancel('agent-save:second')
    await expect(first).resolves.toEqual({ status: 'cancelled' })
    await expect(second).resolves.toEqual({ status: 'cancelled' })
    await isolated.shutdownAll()
  })

  it('save/flush force-flushes every queued label and stops each flushed agent', async () => {
    const storage = `${tmpdir()}/acp-save-flush-global-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { host: gateHost, gate } = gateFor([
      { sessionId: 'acp-alpha', agentId: 'alpha' },
      { sessionId: 'acp-beta', agentId: 'beta' },
    ])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    // Dummy bridges make each flushed save enter its stop await.
    patched.bridges.set('alpha', {})
    patched.bridges.set('beta', {})
    const stopped: string[] = []
    patched.stopAgent = async agentId => { stopped.push(agentId) }
    patched.probeAgentModels = async () => {}

    await expect(isolated.saveAgent({ ...targetDef, id: 'alpha', title: 'Alpha' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    await expect(isolated.saveAgent({ ...targetDef, id: 'beta', title: 'Beta' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    const settingsOperation = vi.fn(async () => 'settings')
    const settings = gate.defer('settings:llm-pi-ai', settingsOperation)
    expect(gate.status().pending.map(entry => entry.label)).toEqual([
      'agent-save:alpha',
      'agent-save:beta',
      'settings:llm-pi-ai',
    ])

    // The GLOBAL gesture is the one that may spend every label's authorisation.
    await expect(isolated.saveGateFlush()).resolves.toEqual({ saved: 3, expired: 0, failed: 0 })
    await expect(settings).resolves.toEqual({ status: 'saved', value: 'settings' })
    expect(settingsOperation).toHaveBeenCalledTimes(1)
    expect(stopped).toEqual(['alpha', 'beta'])
    expect(gate.status().pending).toEqual([])
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.find(agent => agent.id === 'alpha')?.title).toBe('Alpha')
    expect(disk.agents?.find(agent => agent.id === 'beta')?.title).toBe('Beta')
    await isolated.shutdownAll()
  })

  it('a stop persists the removed conversation records so a restart cannot resurrect them', async () => {
    const storage = `${tmpdir()}/acp-stop-persist-${Date.now()}.json`
    const isolated = new BridgeManager([{ ...targetDef, id: 'stop-me' }], hub, 100, storage)
    // Stand in for the record a chat-bound session would leave behind.
    const sessionRecord = {
      sessionId: 'acp-stop',
      acpSessionId: 'acp-stop',
      agentId: 'stop-me',
      dshSessionId: 'dsh-stop',
      cwd: tmpdir(),
      lifecycle: 'live',
      transcript: { since: () => [] },
    }
    ;(isolated as unknown as { registry: { dshSessionMap: Map<string, unknown> } })
      .registry.dshSessionMap.set('dsh-stop:stop-me', sessionRecord)
    await isolated.setExposedModels('stop-me', [])
    const before = JSON.parse(readFileSync(storage, 'utf-8')) as { chatSessions?: Array<{ dshSessionId: string }> }
    expect(before.chatSessions?.some(row => row.dshSessionId === 'dsh-stop')).toBe(true)
    await isolated.stopAgent('stop-me')
    const after = JSON.parse(readFileSync(storage, 'utf-8')) as { chatSessions?: Array<{ dshSessionId: string }> }
    // The stop closed the agent-side sessions; persisting the removal is what
    // stops the next boot from restoring them as resumable.
    expect(after.chatSessions).toBeUndefined()
    await isolated.shutdownAll()
  })

  it('does not write a probe result back after the agent was deleted', async () => {
    const storage = `${tmpdir()}/acp-probe-delete-agents-${Date.now()}.json`
    const catalogPath = `${tmpdir()}/acp-probe-delete-catalog-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage, catalogPath)
    let releaseProbe!: (configOptions: unknown[]) => void
    const heldProbe = new Promise<unknown[]>(resolve => { releaseProbe = resolve })
    ;(isolated as unknown as { bridge: (agentId: string) => unknown }).bridge = () => ({
      probeConfigOptions: () => heldProbe,
    })

    await expect(isolated.saveAgent({ ...targetDef, id: 'probe-race' }, 'direct')).resolves.toEqual({ done: true })
    // The save's fire-and-forget probe is now parked inside its await.
    await isolated.deleteAgent('probe-race')
    releaseProbe([{ id: 'model', name: 'Model', category: 'model', currentValue: 'm', options: [{ value: 'm', name: 'M' }] }])
    await new Promise(resolve => setTimeout(resolve, 20))
    // The delete dropped this id's catalog; the late answer must not put it
    // back, either in memory or in the persisted catalog file.
    expect(isolated.catalogFor('probe-race')).toBeUndefined()
    expect(existsSync(catalogPath)).toBe(false)
    expect(localEvents.filter(event => event.type === 'catalog/updated')).toHaveLength(0)
    await isolated.shutdownAll()
  })
})

/**
 * The MCP servers an agent is told to connect to.
 *
 * Two things are asserted here, and both were measured against codebuddy:
 *
 *  1. THE WIRE SHAPE. The ACP union is asymmetric — its stdio variant carries
 *     NO `type` field (an entry with `type:'stdio'` is accepted by the agent
 *     and then silently dropped: the server never connects), while http/sse
 *     DO carry one, and `env`/`headers` are `[{name,value}]` arrays.
 *  2. ONE LIST PER AGENT PROCESS. The servers land in the agent's PROCESS
 *     scope, so a session created with a DIFFERENT list replaces the scope and
 *     drops the MCP servers of the live sessions on the same connection.
 *     That is why the catalog probe sends the agent's own list too.
 */
describe('MCP servers on the wire (isolated manager)', () => {
  const mcpDef: AcpAgentDef = {
    id: 'mcp',
    title: 'MCP',
    command: process.execPath,
    args: [MOCK],
    env: {},
    cwd: tmpdir(),
    allowedCwdRoots: [tmpdir()],
    mcpServers: [
      { name: 'local', transport: 'stdio', command: '/opt/servers/local', args: ['--mcp'], env: { TOKEN: 'x' } },
      { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
    ],
  }
  const mcpHub = new EventHub()
  const mcpEvents: AcpEvent[] = []
  const mcpManager = new BridgeManager([mcpDef], mcpHub, 500)

  afterAll(async () => {
    await mcpManager.shutdownAll()
  })

  function waitForMcp(type: 'turn/end', predicate: (event: Extract<AcpEvent, { type: 'turn/end' }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: 'turn/end' }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = mcpHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: 'turn/end' }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: 'turn/end' }>)
        }
      })
      const existing = mcpEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: 'turn/end' }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: 'turn/end' }>)
      }
    })
  }

  /** The agent's own echo of the MCP servers its session was created with. */
  async function echoedWire(sessionId: string): Promise<Array<Record<string, unknown>>> {
    // Polled rather than waited for: the turn that carries the echo may
    // already have ended when the test looks, and on the resume path the
    // transcript is RESET and refilled.
    const deadline = Date.now() + 15_000
    for (;;) {
      const transcript = await dispatchRpc(mcpManager, 'transcript/get', { sessionId })
      if (transcript.ok) {
        const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
          .entries
          .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
          .map(e => String((e.update.content as { text?: string }).text ?? ''))
          .join('')
        const begin = text.indexOf('MCPS_BEGIN')
        const end = text.indexOf('MCPS_END')
        if (begin >= 0 && end > begin) {
          return JSON.parse(text.slice(begin + 'MCPS_BEGIN'.length, end)) as Array<Record<string, unknown>>
        }
      }
      if (Date.now() > deadline) throw new Error('the agent never echoed the MCP servers')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  it('sends the configured servers to session/new in the ACP wire shape', async () => {
    mcpHub.subscribe(event => { mcpEvents.push(event) })
    const start = await dispatchRpc(mcpManager, 'session/start', { agentId: 'mcp' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(mcpManager, 'session/prompt', { sessionId: id, text: 'MCPS please' })
    await waitForMcp('turn/end', event => event.sessionId === id)

    const wire = await echoedWire(id)
    // The stdio entry must NOT carry `type` — the agent drops it otherwise.
    expect(wire[0]).toEqual({
      name: 'local',
      command: '/opt/servers/local',
      args: ['--mcp'],
      env: [{ name: 'TOKEN', value: 'x' }],
    })
    expect('type' in wire[0]).toBe(false)
    // The http entry DOES carry one, and its headers are the wire's array form.
    expect(wire[1]).toEqual({
      type: 'http',
      name: 'remote',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    })
  }, 30_000)

  it('gives the catalog probe the SAME list, so probing cannot strip a live session', async () => {
    // Measured against codebuddy: the MCP servers land in the agent's process
    // scope, so a probe session created with an EMPTY list replaces that scope
    // and the live session loses its MCP tools (the agent logged
    // `serverManager.delete("injected")`). The probe therefore sends the
    // agent's own list.
    const probe = await mcpManager.probeAgentModels('mcp')
    expect(probe.agentId).toBe('mcp')

    // A session created after the probe still gets the full list — the probe
    // did not replace the process scope with an empty one.
    const start = await dispatchRpc(mcpManager, 'session/start', { agentId: 'mcp' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(mcpManager, 'session/prompt', { sessionId: id, text: 'MCPS again' })
    await waitForMcp('turn/end', event => event.sessionId === id)
    const wire = await echoedWire(id)
    expect(wire.map(entry => entry.name)).toEqual(['local', 'remote'])
  }, 30_000)

  it('sends the same list on the resume path', async () => {
    // A released session resumes through `session/load`; that request carries
    // the MCP servers too, so the resumed session keeps its tool surface.
    const start = await dispatchRpc(mcpManager, 'session/start', { agentId: 'mcp' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(mcpManager, 'session/prompt', { sessionId: id, text: 'DIE now' })
    await waitForMcp('session/released' as 'turn/end', event => (event as unknown as { sessionId: string }).sessionId === id)

    await dispatchRpc(mcpManager, 'session/prompt', { sessionId: id, text: 'MCPS resumed' })
    await waitForMcp('turn/end', event => event.sessionId === id)
    const wire = await echoedWire(id)
    expect(wire.map(entry => entry.name)).toEqual(['local', 'remote'])
  }, 30_000)
})
