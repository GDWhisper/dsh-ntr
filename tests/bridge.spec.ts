/**
 * End-to-end over a real child process: the scripted mock ACP agent driven by
 * the production BridgeManager + dispatchRpc (the same face the browser uses).
 */

import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdirSync, readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager, detectHostAgents, findExecutable } from '../src/bridge.ts'
import { EventHub, dispatchRpc } from '../src/impl.ts'
import type { AcpAgentDef, AcpEvent, StreamChunk } from '../src/protocol.ts'

const MOCK = fileURLToPath(new URL('./mock-agent.mjs', import.meta.url))

const def: AcpAgentDef = {
  id: 'mock',
  title: 'Mock',
  command: process.execPath,
  args: [MOCK],
  env: {},
  cwd: tmpdir(),
  allowedCwdRoots: [tmpdir()],
  permission: 'ask',
}

const hub = new EventHub()
const manager = new BridgeManager([def], hub, 500)
const events: AcpEvent[] = []
hub.subscribe(event => { events.push(event) })

function waitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
    const unsub = hub.subscribe(event => {
      if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
        clearTimeout(timer)
        unsub()
        resolve(event as Extract<AcpEvent, { type: T }>)
      }
    })
    // The event may already have arrived before the subscription.
    const existing = events.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
    if (existing !== undefined) {
      clearTimeout(timer)
      unsub()
      resolve(existing as Extract<AcpEvent, { type: T }>)
    }
  })
}

afterAll(async () => {
  await manager.shutdownAll()
})

describe('ACP bridge over stdio (mock agent)', () => {
  it('spawns, initializes, creates a session, streams a full turn with a human permission answer', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const id = (start.value as { sessionId: string }).sessionId

    // The created session carries the negotiated modes from session/new.
    const created = events.find(event => event.type === 'session/created')
    expect(created).toBeDefined()

    const prompt = await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'hello PERM world' })
    expect(prompt).toEqual({ ok: true, value: { accepted: true, turnId: expect.any(String) } })

    // A human permission request must surface and resolve through the ledger.
    const permission = await waitFor('permission/request', event => event.sessionId === id)
    expect(permission.options.map(o => o.kind)).toEqual(['allow_once', 'reject_once'])
    const responded = await dispatchRpc(manager, 'permission/respond', { requestId: permission.requestId, optionId: 'allow1' })
    expect(responded.ok).toBe(true)
    await waitFor('permission/resolved', event => event.requestId === permission.requestId)

    const end = await waitFor('turn/end', event => event.sessionId === id)
    expect(end.stopReason).toBe('end_turn')

    // Transcript replay returns the ordered raw updates the browser folds.
    const transcript = await dispatchRpc(manager, 'transcript/get', { sessionId: id })
    expect(transcript.ok).toBe(true)
    if (!transcript.ok) return
    const entries = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
    const kinds = entries.map(e => String(e.update.sessionUpdate))
    expect(kinds).toContain('agent_thought_chunk')
    expect(kinds).toContain('plan')
    expect(kinds).toContain('available_commands_update')
    expect(kinds.filter(k => k === 'tool_call' || k === 'tool_call_update')).toHaveLength(3)
    const chunks = entries.filter(e => e.update.sessionUpdate === 'agent_message_chunk')
    expect(chunks.length).toBe(2)
    const text = chunks.map(c => String((c.update.content as { text: string }).text)).join('')
    expect(text).toBe('MOCK: echo hello PERM world perm=allow1')

    // Session snapshot absorbed the derived updates.
    const sessions = await dispatchRpc(manager, 'sessions/list', {})
    if (!sessions.ok) throw new Error('sessions/list failed')
    const view = (sessions.value as { sessions: Array<Record<string, unknown> & { sessionId: string }> }).sessions.find(s => s.sessionId === id)
    expect(view?.usage).toMatchObject({ used: 123, size: 1000 })
    expect(view?.availableCommands).toEqual([{ name: 'greet', description: 'say hi' }])
  }, 30_000)

  it('blocks a second prompt while a turn is in flight and closes sessions idempotently', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'PERM hold' })
    const permission = await waitFor('permission/request', event => event.sessionId === id)
    const busy = await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'second' })
    expect(busy).toMatchObject({ ok: false, error: { code: 'turn_in_flight' } })
    await dispatchRpc(manager, 'permission/respond', { requestId: permission.requestId, optionId: 'reject1' })
    await waitFor('turn/end', event => event.sessionId === id && event.stopReason !== undefined)
    await dispatchRpc(manager, 'session/close', { sessionId: id })
    const again = await dispatchRpc(manager, 'session/close', { sessionId: id })
    expect(again).toMatchObject({ ok: false, error: { code: 'unknown_session' } })
  }, 30_000)

  it('cancels a slow turn and reports the cancelled stop reason', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'SLOW please' })
    await new Promise(resolve => setTimeout(resolve, 300))
    await dispatchRpc(manager, 'session/cancel', { sessionId: id })
    const end = await waitFor('turn/end', event => event.sessionId === id)
    expect(end.stopReason).toBe('cancelled')
  }, 30_000)

  it('enforces the cwd allow-list before touching the agent', async () => {
    const escape = await dispatchRpc(manager, 'session/start', { agentId: 'mock', cwd: '/etc' })
    expect(escape).toMatchObject({ ok: false, error: { code: 'cwd_denied' } })
    const missing = await dispatchRpc(manager, 'session/start', { agentId: 'mock', cwd: '/definitely/not/here' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'bad_cwd' } })
  })

  it('rejects unknown agents and settles permissions when a session closes', async () => {
    const unknown = await dispatchRpc(manager, 'session/start', { agentId: 'ghost' })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown_agent' } })

    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'PERM now' })
    const permission = await waitFor('permission/request', event => event.sessionId === id)
    await dispatchRpc(manager, 'session/close', { sessionId: id })
    const resolved = await waitFor('permission/resolved', event => event.requestId === permission.requestId)
    expect(resolved.outcome).toEqual({ outcome: 'cancelled' })
    // The turn must not hang forever either: prompt settles (agent answered the
    // parked permission request with cancelled).
    const end = await waitFor('turn/end', event => event.sessionId === id)
    expect(end.stopReason !== undefined || end.error !== undefined).toBe(true)
  }, 30_000)

  it('surfaces modes switching through current_mode_update', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    const before = events.length
    void before
    await dispatchRpc(manager, 'session/mode-set', { sessionId: id, modeId: 'strict' })
    const update = await waitFor('session/update', event =>
      event.sessionId === id && (event.update as { sessionUpdate?: string }).sessionUpdate === 'current_mode_update')
    expect((update.update as { currentModeId: string }).currentModeId).toBe('strict')
    const sessions = await dispatchRpc(manager, 'sessions/list', {})
    if (!sessions.ok) throw new Error('sessions/list failed')
    const view = (sessions.value as { sessions: Array<{ sessionId: string; modes?: { currentModeId?: string } }> }).sessions.find(s => s.sessionId === id)
    expect(view?.modes?.currentModeId).toBe('strict')

    // config-set must flow back through the authoritative response even for
    // agents that never push config_option_update.
    const cfg = await dispatchRpc(manager, 'session/config-set', { sessionId: id, configId: 'temp', value: 'high' })
    expect(cfg.ok).toBe(true)
    const meta = await waitFor('session/meta', event =>
      event.sessionId === id && (event.session as unknown as { configOptions?: Array<{ configId: string; currentValue: string }> }).configOptions?.some(o => o.configId === 'temp' && o.currentValue === 'high') === true)
    const temp = ((meta.session as unknown as { configOptions: Array<{ configId: string; currentValue: string }> }).configOptions).find(o => o.configId === 'temp')
    expect(temp?.currentValue).toBe('high')
    await dispatchRpc(manager, 'session/close', { sessionId: id })
  }, 30_000)

  it('implements LlmAdapter: discovers models and streams a full turn over native chat chunks', async () => {
    const adapter = new AcpLlmAdapter(manager)
    expect(adapter.providerInfo('acp')).toEqual({ id: 'acp', name: 'ACP' })

    // Earlier tests opened real sessions, so the catalog was absorbed
    // opportunistically: base entry + one variant per mock model choice.
    const models = await adapter.listModels('acp')
    expect(models.map(m => m.id)).toEqual(['mock', 'mock@mock-model-a', 'mock@mock-model-b'])
    expect(models[0]).toEqual(expect.objectContaining({ provider: 'acp', id: 'mock', name: 'Mock' }))

    const resolved = await adapter.resolveModel('acp', 'mock')
    expect(resolved).toEqual(expect.objectContaining({ provider: 'acp', id: 'mock', name: 'Mock' }))

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-native-test-1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from native chat' }] },
      ],
    })) {
      chunks.push(chunk)
    }

    const types = chunks.map(c => c.type)
    expect(types).toContain('block-start')
    expect(types).toContain('reasoning-delta')
    expect(types).toContain('block-end')
    expect(types).toContain('text-delta')
    expect(types).toContain('usage')
    expect(types).toContain('finish')

    // Reasoning block
    const reasoningDeltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'reasoning-delta' }> => c.type === 'reasoning-delta')
    const thoughtText = reasoningDeltas.map(c => c.text).join('')
    expect(thoughtText).toContain('thinking…')
    expect(thoughtText).toContain('mock tool')

    // Text block
    const textDeltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    const answer = textDeltas.map(c => c.text).join('')
    expect(answer).toBe('MOCK: echo hello from native chat perm=none')

    // Usage and finish
    const usage = chunks.find((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage')
    expect(usage?.usage).toEqual({ inputTokens: 1000, outputTokens: 123 })

    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('handles cancellation in adapter.stream via AbortSignal', async () => {
    const adapter = new AcpLlmAdapter(manager)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-native-cancel-test',
      signal: controller.signal,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'SLOW please' }] },
      ],
    })) {
      chunks.push(chunk)
    }

    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason.kind).toBe('aborted')
  }, 30_000)

  it('updates agent permission policy dynamically so permissions can be pre-approved', async () => {
    const adapter = new AcpLlmAdapter(manager)
    await manager.setPermission('mock', 'allow')
    expect(manager.agentViews().find(a => a.id === 'mock')?.permission).toBe('allow')

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-native-perm-test',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello PERM allowed' }] },
      ],
    })) {
      chunks.push(chunk)
    }

    const textDeltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    const answer = textDeltas.map(c => c.text).join('')
    expect(answer).toBe('MOCK: echo hello PERM allowed perm=allow1')

    await manager.setPermission('mock', 'ask')
  }, 30_000)

  it('detects host executables and returns known presets', async () => {
    // node is guaranteed in the test runner
    const nodePath = findExecutable('node')
    expect(nodePath).toBeDefined()

    const detected = detectHostAgents([])
    const piPreset = detected.find(d => d.id === 'pi')
    expect(piPreset).toBeDefined()
    expect(piPreset?.defaultCommand).toBe('pi-acp')
    expect(piPreset?.defaultArgs).toEqual([])
  })

  it('supports saving and deleting agents dynamically with persistence', async () => {
    const testStorage = `${tmpdir()}/acp-test-storage-${Date.now()}.json`
    const dynamicManager = new BridgeManager([], hub, 100, testStorage)

    expect(dynamicManager.agentViews()).toHaveLength(0)

    await dynamicManager.saveAgent({
      id: 'test-agent',
      title: 'Test Agent',
      command: process.execPath,
      args: [MOCK],
      permission: 'ask',
      cwd: tmpdir(),
      allowedCwdRoots: [tmpdir()],
      exposedModels: ['mock-model-b'],
    })

    expect(dynamicManager.agentViews()).toHaveLength(1)
    expect(dynamicManager.agentViews()[0].id).toBe('test-agent')

    // Verify loading from persistence in a fresh manager instance, including
    // the exposure filter surviving the round-trip.
    const reloadedManager = new BridgeManager([], hub, 100, testStorage)
    expect(reloadedManager.agentViews()).toHaveLength(1)
    expect(reloadedManager.agentViews()[0].id).toBe('test-agent')
    expect((reloadedManager as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap.get('test-agent')?.exposedModels)
      .toEqual(['mock-model-b'])

    // Delete agent
    await dynamicManager.deleteAgent('test-agent')
    expect(dynamicManager.agentViews()).toHaveLength(0)

    const reloadedAfterDelete = new BridgeManager([], hub, 100, testStorage)
    expect(reloadedAfterDelete.agentViews()).toHaveLength(0)
  })
})

describe('model catalog (isolated manager)', () => {
  const catalogPath = `${tmpdir()}/acp-catalog-test-${Date.now()}.json`
  const catalogManager = new BridgeManager([def], hub, 500, undefined, catalogPath)
  const catalogAdapter = new AcpLlmAdapter(catalogManager)

  afterAll(async () => {
    await catalogManager.shutdownAll()
  })

  it('listModels stays memory-only: base entry only before any probe (no spawn)', async () => {
    const models = await catalogAdapter.listModels('acp')
    expect(models.map(m => m.id)).toEqual(['mock'])
  })

  it('probes configOptions, expands variants with reasoning metadata, degrades stale ids', async () => {
    const probe = await catalogManager.probeAgentModels('mock')
    expect(probe.agentId).toBe('mock')
    expect(probe.catalog.model?.configId).toBe('model')
    expect(probe.catalog.model?.choices.map(c => c.value)).toEqual(['mock-model-a', 'mock-model-b'])
    expect(probe.catalog.thought?.choices.map(c => c.value)).toEqual(['off', 'high'])
    expect(probe.catalog.thought?.currentValue).toBe('high')

    const models = await catalogAdapter.listModels('acp')
    expect(models.map(m => m.id)).toEqual(['mock', 'mock@mock-model-a', 'mock@mock-model-b'])
    expect(models[2]).toMatchObject({ provider: 'acp', name: 'Mock · Mock Model B', description: 'The stronger mock model' })

    const resolved = await catalogAdapter.resolveModel('acp', 'mock@mock-model-b')
    expect(resolved).toMatchObject({ provider: 'acp', id: 'mock@mock-model-b', name: 'Mock · Mock Model B' })
    expect(resolved.reasoning?.efforts.map(e => e.id)).toEqual(['off', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('high')

    // The base entry carries the same reasoning metadata (agent default model).
    const base = await catalogAdapter.resolveModel('acp', 'mock')
    expect(base.reasoning?.defaultEffort).toBe('high')

    // Unknown agents throw so DSH's selectModel reports model-unavailable…
    await expect(catalogAdapter.resolveModel('acp', 'ghost')).rejects.toThrow(/not configured/)
    // …while stale variants degrade to a bare-id entry instead of throwing.
    const stale = await catalogAdapter.resolveModel('acp', 'mock@ghost-model')
    expect(stale).toMatchObject({ provider: 'acp', id: 'mock@ghost-model', name: 'mock@ghost-model' })
  }, 30_000)

  it('aligns per-turn model and thought level on the live ACP session', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of catalogAdapter.stream({
      provider: 'acp',
      model: 'mock@mock-model-b',
      sessionId: 'dsh-align-test',
      reasoningEffort: 'off',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello aligned' }] }],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason).toEqual({ kind: 'stop' })

    // The streamed turn ran on the agent's own model choice and effort level,
    // applied through session/set_config_option on the same ACP session.
    const view = (catalogManager.sessions() as Array<{ agentId: string; configOptions?: Array<{ configId: string; currentValue: string }> }>)
      .find(s => s.agentId === 'mock')
    expect(view?.configOptions?.find(o => o.configId === 'model')?.currentValue).toBe('mock-model-b')
    expect(view?.configOptions?.find(o => o.configId === 'thought')?.currentValue).toBe('off')
  }, 30_000)

  it('narrows the native selector via setExposedModels; hidden variants still resolve', async () => {
    await catalogManager.setExposedModels('mock', ['mock-model-b'])
    expect((await catalogAdapter.listModels('acp')).map(m => m.id)).toEqual(['mock', 'mock@mock-model-b'])

    // An empty filter leaves just the base entry (the agent default model).
    await catalogManager.setExposedModels('mock', [])
    expect((await catalogAdapter.listModels('acp')).map(m => m.id)).toEqual(['mock'])

    // Filtering only affects listing: a hidden variant still resolves fully.
    const hidden = await catalogAdapter.resolveModel('acp', 'mock@mock-model-a')
    expect(hidden).toMatchObject({ id: 'mock@mock-model-a', name: 'Mock · Mock Model A' })

    // Clearing the filter (undefined) restores every choice.
    await catalogManager.setExposedModels('mock', undefined)
    expect((await catalogAdapter.listModels('acp')).map(m => m.id)).toEqual(['mock', 'mock@mock-model-a', 'mock@mock-model-b'])

    await expect(catalogManager.setExposedModels('ghost', ['x'])).rejects.toThrow(/not configured/)
  }, 30_000)

  it('reloads a persisted catalog into a fresh manager without probing', async () => {
    const reloaded = new BridgeManager([def], hub, 500, undefined, catalogPath)
    const models = await new AcpLlmAdapter(reloaded).listModels('acp')
    expect(models.map(m => m.id)).toEqual(['mock', 'mock@mock-model-a', 'mock@mock-model-b'])
  })
})

describe('reliability (isolated manager, short timeouts)', () => {
  const relWorkspace = `${tmpdir()}/dsh-ntr-rel-workspace`
  mkdirSync(relWorkspace, { recursive: true })
  const relHub = new EventHub()
  const relEvents: AcpEvent[] = []
  relHub.subscribe(event => { relEvents.push(event) })
  const relManager = new BridgeManager(
    [{
      ...def,
      id: 'rel',
      cwd: `${tmpdir()}/dsh-ntr-rel-workspace`,
      allowedCwdRoots: [`${tmpdir()}/dsh-ntr-rel-workspace`],
    }],
    relHub,
    500,
    undefined,
    undefined,
    true,
    { startupTimeoutMs: 2_500, permissionTimeoutMs: 700, cancelFallbackMs: 400 },
  )

  function relWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = relHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = relEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  afterAll(async () => {
    await relManager.shutdownAll()
  })

  it('fails a hung agent with agent_timeout instead of hanging forever', async () => {
    const hung = new BridgeManager(
      [{ ...def, id: 'hung', command: process.execPath, args: ['-e', 'process.stdin.resume()'] }],
      relHub,
      100,
      undefined,
      undefined,
      true,
      { startupTimeoutMs: 700 },
    )
    try {
      const result = await dispatchRpc(hung, 'session/start', { agentId: 'hung' })
      // Startup failures surface as agent_unreachable; the timeout detail
      // (what stalled, the budget, the stderr tail) rides in the message.
      expect(result).toMatchObject({ ok: false, error: { code: 'agent_unreachable' } })
      if (result.ok) return
      expect(result.error.message).toContain('did not answer initialize')
      // The wedged child must be torn down, not left behind.
      expect(hung.agentViews().find(a => a.id === 'hung')?.state).toBe('error')
    } finally {
      await hung.shutdownAll()
    }
  }, 15_000)

  it('serves fs read/write requests inside the sandbox and refuses escapes', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error(`start failed: ${JSON.stringify(start)}`)
    const id = (start.value as { sessionId: string }).sessionId
    const workspaceRoot = `${tmpdir()}/dsh-ntr-rel-workspace`

    const write = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: `WRITEFILE ${workspaceRoot}/fs-test/nested/probe.txt` })
    expect(write).toMatchObject({ ok: true })
    const writeEnd = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void writeEnd
    const written = readFileSync(`${workspaceRoot}/fs-test/nested/probe.txt`, 'utf8')
    expect(written).toBe('written-by-mock-agent')

    const read = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: `READFILE ${workspaceRoot}/fs-test/nested/probe.txt` })
    expect(read).toMatchObject({ ok: true })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && relEvents.filter(e => e.type === 'turn/end' && e.sessionId === id).length >= 2)
    const transcript = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(text).toContain('READ_OK:written-by-mock-agent')

    // Escape attempts must surface as a refusal to the agent, never contents.
    const escape = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'READFILE /etc/passwd' })
    expect(escape).toMatchObject({ ok: true })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && relEvents.filter(e => e.type === 'turn/end' && e.sessionId === id).length >= 3)
    const transcript2 = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript2.ok) throw new Error('transcript failed')
    const escapeText = (transcript2.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(escapeText).toContain('READ_FAIL:')
    expect(escapeText).toContain('outside the session workspace')
  }, 30_000)

  it('resumes a session after the agent process dies (send to recover)', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'DIE now' })
    const released = await relWaitFor('session/released', event => event.sessionId === id)
    expect(released.session.released).toBe(true)

    // The released session stays visible and readable (pre-crash transcript).
    const sessions = await dispatchRpc(relManager, 'sessions/list', {})
    if (!sessions.ok) throw new Error('sessions/list failed')
    const view = (sessions.value as { sessions: Array<{ sessionId: string; released?: boolean }> }).sessions.find(s => s.sessionId === id)
    expect(view?.released).toBe(true)

    // The next prompt respawns the agent and resumes via session/load.
    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'back again' })
    const end = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void end

    const transcript = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(text).toContain('REPLAYED: earlier conversation')
    expect(text).toContain('MOCK: echo back again')

    const resumed = await dispatchRpc(relManager, 'sessions/list', {})
    if (!resumed.ok) throw new Error('sessions/list failed')
    const resumedView = (resumed.value as { sessions: Array<{ sessionId: string; released?: boolean }> }).sessions.find(s => s.sessionId === id)
    expect(resumedView?.released).toBeUndefined()
  }, 30_000)

  it('force-finalizes a turn when the agent ignores cancel, and dedups the late real end', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'IGNORE_CANCEL please' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await dispatchRpc(relManager, 'session/cancel', { sessionId: id })

    // The fallback timer fires first: turn is force-finalized with an error.
    const fallback = await relWaitFor('turn/end', event => event.sessionId === id && event.error !== undefined && event.error.includes('force-finalized'))
    expect(fallback.turnId).toBe('')

    // The agent eventually finishes normally; the late real turn/end follows.
    const late = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    expect(late.turnId).not.toBe('')

    // And a prompt is possible again (the session did not stay running).
    const again = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'fresh turn' })
    expect(again).toMatchObject({ ok: true, value: { accepted: true } })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && event.turnId === (again.value as { turnId: string }).turnId)
  }, 30_000)

  it('answers a pending permission with cancelled after the timeout', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'PERM hold' })
    const request = await relWaitFor('permission/request', event => event.sessionId === id)
    const resolved = await relWaitFor('permission/resolved', event => event.requestId === request.requestId)
    expect(resolved.outcome).toEqual({ outcome: 'cancelled' })
    // The notice explains what happened, and the turn still settles.
    await relWaitFor('agent/notice', event => event.text.includes('timed out'))
    const end = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void end
  }, 30_000)
})
