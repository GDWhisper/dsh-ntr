/**
 * End-to-end over a real child process: the scripted mock ACP agent driven by
 * the production BridgeManager + dispatchRpc (the same face the browser uses).
 */

import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
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
      event.sessionId === id && (event.session as unknown as { configOptions?: Array<{ id: string; currentValue: string }> }).configOptions?.some(o => o.id === 'temp' && o.currentValue === 'high') === true)
    const temp = ((meta.session as unknown as { configOptions: Array<{ id: string; currentValue: string }> }).configOptions).find(o => o.id === 'temp')
    expect(temp?.currentValue).toBe('high')
    await dispatchRpc(manager, 'session/close', { sessionId: id })
  }, 30_000)

  it('implements LlmAdapter: discovers models and streams a full turn over native chat chunks', async () => {
    const adapter = new AcpLlmAdapter(manager)
    expect(adapter.providerInfo('acp')).toEqual({ id: 'acp', name: 'ACP' })

    const models = await adapter.listModels('acp')
    expect(models).toEqual([
      expect.objectContaining({ provider: 'acp', id: 'mock', name: 'Mock' }),
    ])

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
    })

    expect(dynamicManager.agentViews()).toHaveLength(1)
    expect(dynamicManager.agentViews()[0].id).toBe('test-agent')

    // Verify loading from persistence in a fresh manager instance
    const reloadedManager = new BridgeManager([], hub, 100, testStorage)
    expect(reloadedManager.agentViews()).toHaveLength(1)
    expect(reloadedManager.agentViews()[0].id).toBe('test-agent')

    // Delete agent
    await dynamicManager.deleteAgent('test-agent')
    expect(dynamicManager.agentViews()).toHaveLength(0)

    const reloadedAfterDelete = new BridgeManager([], hub, 100, testStorage)
    expect(reloadedAfterDelete.agentViews()).toHaveLength(0)
  })
})
