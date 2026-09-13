import { describe, expect, it } from 'vitest'
import { AcpStore, foldUpdate, type Block } from '../src/client/store.ts'

function fold(...updates: Array<Record<string, unknown>>): Block[] {
  const blocks: Block[] = []
  for (const update of updates) foldUpdate(blocks, update)
  return blocks
}

describe('foldUpdate', () => {
  it('merges same-messageId agent chunks and starts a new block on a new id', () => {
    const blocks = fold(
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello ' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'world' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'next' } },
    )
    expect(blocks).toEqual([
      { kind: 'agent', messageId: 'm1', text: 'Hello world' },
      { kind: 'agent', messageId: 'm2', text: 'next' },
    ])
  })

  it('merges message-less chunks into the previous same-kind block', () => {
    const blocks = fold(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'a' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'b' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } },
    )
    expect(blocks.map(b => b.kind)).toEqual(['user', 'thought'])
    expect(blocks[0]).toMatchObject({ text: 'ab' })
  })

  it('renders non-text content as a placeholder', () => {
    const blocks = fold({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } })
    expect(blocks[0]).toMatchObject({ kind: 'agent', text: '[image]' })
  })

  it('creates and merges tool cards by toolCallId, including content lines', () => {
    const blocks = fold(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run', kind: 'execute', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'run ls', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file1\nfile2' } }] },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ kind: 'tool', toolCallId: 't1', title: 'run ls', status: 'completed', toolKind: 'execute', lines: ['file1\nfile2'] })
  })

  it('materializes an update-only tool card when the original rolled out of the window', () => {
    const blocks = fold({ sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed' })
    expect(blocks[0]).toMatchObject({ kind: 'tool', toolCallId: 'ghost', status: 'completed' })
  })

  it('replaces the plan in place', () => {
    const blocks = fold(
      { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }] },
      { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }] },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'plan', entries: [{ content: 'a', status: 'completed' }] })
  })

  it('ignores meta updates that ride on the session snapshot', () => {
    expect(fold({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toEqual([])
    expect(fold({ sessionUpdate: 'current_mode_update', currentModeId: 'x' })).toEqual([])
  })
})

describe('AcpStore agent management', () => {
  it('detectAgents queries endpoint and updates state', async () => {
    const rpcCalls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (channel, endpoint, payload) => {
        rpcCalls.push({ channel, endpoint, payload })
        if (endpoint === 'agents/detect') {
          return { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    await store.detectAgents()
    const state = store.getSnapshot()
    expect(state.detectedAgents).toHaveLength(1)
    expect(state.detectedAgents[0].id).toBe('pi')
    expect(state.detecting).toBe(false)
  })

  it('saveAgent and deleteAgent trigger RPC calls and resync', async () => {
    const endpoints: string[] = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (channel, endpoint, payload) => {
        endpoints.push(endpoint)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: { done: true } }
      },
      (zh) => zh,
    )

    await store.saveAgent({ id: 'pi', command: 'pi-acp', args: [] })
    expect(endpoints).toContain('agent/save')
    expect(endpoints).toContain('agents/list')

    await store.deleteAgent('pi')
    expect(endpoints).toContain('agent/delete')
  })

  it('setExposedModels uses the lightweight endpoint and resyncs afterwards', async () => {
    const endpoints: string[] = []
    const payloads: Array<Record<string, unknown>> = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint, payload) => {
        endpoints.push(endpoint)
        payloads.push(payload as Record<string, unknown>)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: { done: true } }
      },
      (zh) => zh,
    )

    await store.setExposedModels('pi', ['model-a', 'model-b'])
    expect(endpoints).toContain('agent/set-exposed-models')
    expect(endpoints).toContain('agents/list') // resync refreshes currentConfig
    const sent = payloads[endpoints.indexOf('agent/set-exposed-models')]
    expect(sent).toEqual({ agentId: 'pi', exposedModels: ['model-a', 'model-b'] })

    endpoints.length = 0
    payloads.length = 0
    await store.setExposedModels('pi', undefined)
    const cleared = payloads[endpoints.indexOf('agent/set-exposed-models')]
    expect(cleared).toEqual({ agentId: 'pi' })
  })

  it('setExposedModels surfaces host errors as a notice and rethrows', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agent/set-exposed-models') {
          return { ok: false, error: { code: 'unknown_agent', message: 'acp: agent "pi" is not configured' } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await expect(store.setExposedModels('pi', ['a'])).rejects.toThrow(/not configured/)
    expect(store.getSnapshot().notice).toMatch(/not configured/)
  })
})

describe('AcpStore event application (released / reset / turn dedup)', () => {
  function makeStore(): { store: AcpStore; apply: (event: unknown) => Promise<void> } {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
    return { store, apply }
  }

  function view(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      sessionId: 's1',
      agentId: 'pi',
      acpSessionId: 'acp-1',
      cwd: '/w',
      running: false,
      closed: false,
      seq: 0,
      ...overrides,
    }
  }

  it('keeps a released session visible, marks it released, and clears its permissions', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'permission/request', requestId: 'r1', sessionId: 's1', toolCall: { title: 't' }, options: [] })
    expect(store.getSnapshot().permissions).toHaveLength(1)

    await apply({ type: 'session/released', sessionId: 's1', session: view({ released: true }), reason: 'agent process exited' })
    const state = store.getSnapshot()
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({ sessionId: 's1', released: true })
    expect(state.permissions).toHaveLength(0)
    expect(state.notice).toMatch(/resume|恢复/)
  })

  it('resets blocks and the seq watermark on session/reset so the replay folds fresh', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } } })
    expect(store.getSnapshot().blocks.length).toBeGreaterThan(0)

    await apply({ type: 'session/reset', sessionId: 's1', session: view() })
    expect(store.getSnapshot().blocks).toEqual([])

    // The replay restarts at seq 1; a stale watermark would have triggered a
    // gap refetch instead of folding.
    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } } })
    expect(store.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'replayed' }])
  })

  it('applies only the first turn/end per open turn (cancel fallback + late real end)', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await apply({ type: 'turn/end', sessionId: 's1', turnId: '', error: 'force-finalized' })
    expect(store.getSnapshot().blocks).toEqual([expect.objectContaining({ kind: 'user' }), expect.objectContaining({ kind: 'notice', tone: 'error' })])

    // The late real turn/end for the same turn must not duplicate the notice.
    await apply({ type: 'turn/end', sessionId: 's1', turnId: 't1', stopReason: 'end_turn' })
    expect(store.getSnapshot().blocks).toHaveLength(2)

    // A new turn opens the window again.
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't2', text: 'again' })
    await apply({ type: 'turn/end', sessionId: 's1', turnId: 't2', stopReason: 'end_turn' })
    expect(store.getSnapshot().blocks).toHaveLength(3)
  })
})
