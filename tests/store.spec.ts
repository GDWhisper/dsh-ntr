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

  it('resyncs and repairs the ACP-mode preset through its own endpoints', async () => {
    const endpoints: string[] = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'preset/status') return { ok: true, value: { preset: { id: 'acp', dir: '/home/x/.dsh/.agent-presets/acp', installed: false, missing: [] } } }
        if (endpoint === 'preset/install') return { ok: true, value: { preset: { id: 'acp', dir: '/home/x/.dsh/.agent-presets/acp', installed: true, missing: [] } } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    await store.resync()
    expect(store.getSnapshot().preset).toMatchObject({ installed: false })

    await store.installPreset()
    expect(endpoints).toContain('preset/install')
    expect(store.getSnapshot().preset).toMatchObject({ installed: true })
    expect(store.getSnapshot().presetInstalling).toBe(false)
  })

  it('hides the preset block on a host half that serves no preset RPC', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'preset/status') return { ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().preset).toBeUndefined()
  })

  it('testAgent posts the form payload as-is and returns the host verdict', async () => {
    const payloads: Array<Record<string, unknown>> = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agent/test') {
          payloads.push(payload as Record<string, unknown>)
          return { ok: true, value: { ok: false, error: 'spawn ENOENT', durationMs: 12, stderr: [] } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    const verdict = await store.testAgent({ id: 'pi', command: 'pi-acp', args: [], npmPackage: 'pi-acp', env: { KEY: 'v' } })
    expect(payloads[0]).toEqual({ id: 'pi', command: 'pi-acp', args: [], npmPackage: 'pi-acp', env: { KEY: 'v' } })
    // A reachable-but-broken agent is a verdict, not a thrown error.
    expect(verdict).toMatchObject({ ok: false, error: 'spawn ENOENT' })

    // Old host build: the unknown-endpoint failure becomes a localized notice.
    const oldStore = new (await import('../src/client/store.ts')).AcpStore(
      async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint agent/test' } }),
      (zh) => zh,
    )
    await expect(oldStore.testAgent({ id: 'pi', command: 'pi-acp' })).rejects.toThrow(/unknown endpoint agent\/test/)
    expect(oldStore.getSnapshot().notice).toContain('重启 dsh web')
  })

  it('resync records the host approval-routing capability (absent field = degraded)', async () => {
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [], approvalRouted: true } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    expect(store.getSnapshot().approvalRouted).toBe(false)
    await store.resync()
    expect(store.getSnapshot().approvalRouted).toBe(true)

    // An older host omits the field: the panel must keep its ledger card.
    const legacy = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await legacy.resync()
    expect(legacy.getSnapshot().approvalRouted).toBe(false)
  })

  it('loads the chat-bound ACP sessions by chat id and switches the agent mode', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    let listed = { sessions: [] as unknown[] }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      if (endpoint === 'session/chat-mode-set') return { ok: true, value: { done: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    // A chat the agent has not run in yet: nothing to render, and the store
    // records which chat the empty answer belongs to.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toEqual([])
    expect(store.getSnapshot().chatSessionsFor).toBe('chat-1')

    listed = { sessions: [{ agentId: 'pi', sessionId: 's1', modes: { currentModeId: 'default', availableModes: [{ id: 'strict', name: 'Strict' }] } }] }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toHaveLength(1)

    await store.setChatSessionMode('chat-1', 'strict', 'pi')
    // The switch rides the lightweight endpoint, then the binding is re-read so
    // a rejected switch cannot leave an optimistic value on screen.
    expect(calls.filter(c => c.endpoint === 'session/chat-mode-set')).toEqual([
      { endpoint: 'session/chat-mode-set', payload: { dshSessionId: 'chat-1', modeId: 'strict', agentId: 'pi' } },
    ])
    expect(calls.at(-1)?.endpoint).toBe('session/chat-list')
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('degrades silently when the host has no chat-session mode surface', async () => {
    const store = new AcpStore(async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'nope' } }), (zh) => zh)
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toEqual([])
    expect(store.getSnapshot().notice).toBeUndefined()

    await store.setChatSessionMode('chat-1', 'strict')
    // A failed switch is surfaced (the user asked for it), unlike the probe.
    expect(store.getSnapshot().notice).toContain('nope')
  })

  it('records the per-session ACP-mode verdict from session/chat-list and invalidates it', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], acpMode: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode['chat-1']).toBe(true)

    // The preset switch the session committed rewrites what the log says: the
    // held verdict must go, or the seat gate would trust a moved-past answer.
    store.invalidateAcpMode('chat-1')
    expect(store.getSnapshot().acpMode).toEqual({})
    // Invalidating an unknown id stays a no-op (no listener churn).
    store.invalidateAcpMode('chat-1')
    store.invalidateAcpMode()
    expect(store.getSnapshot().acpMode).toEqual({})
  })

  it('keeps no ACP-mode verdict when an older host half omits the field', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [] } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.loadChatSessions('chat-1')
    // Absent field = no fact either way: the seat gate reads this as "ask
    // unanswered" and keeps the native seat, never a false ACP claim.
    expect(store.getSnapshot().acpMode).toEqual({})
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

  it('loadAgentCatalog caches per agent and dedups concurrent reads', async () => {
    const endpoints: string[] = []
    let resolveRead: ((value: unknown) => void) | undefined
    const store = new AcpStore(
      async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint !== 'agent/catalog') return { ok: true, value: {} }
        // Hold the first read open so the second caller overlaps it.
        await new Promise<void>(resolve => { resolveRead = () => { resolve() } })
        return {
          ok: true,
          value: { agentId: 'pi', title: 'Pi', base: { id: 'pi', name: 'Pi' }, variants: [], probed: true },
        }
      },
      (zh) => zh,
    )

    const first = store.loadAgentCatalog('pi')
    const second = store.loadAgentCatalog('pi')
    resolveRead?.()
    await Promise.all([first, second])
    // Two concurrent mounts, one round-trip (the seat asks on every mount).
    expect(endpoints.filter(endpoint => endpoint === 'agent/catalog')).toHaveLength(1)
    expect(store.getSnapshot().seatCatalogs.pi).toMatchObject({ title: 'Pi', probed: true })

    // Cached: a later mount reads nothing at all.
    await store.loadAgentCatalog('pi')
    expect(endpoints.filter(endpoint => endpoint === 'agent/catalog')).toHaveLength(1)
  })

  it('loadAgentCatalog stays quiet when the host has no catalog surface', async () => {
    const store = new AcpStore(
      async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'nope' } }),
      (zh) => zh,
    )
    await store.loadAgentCatalog('pi')
    // No entry and no notice: the seats fall back to the agent's own title.
    expect(store.getSnapshot().seatCatalogs.pi).toBeUndefined()
    expect(store.getSnapshot().notice).toBeUndefined()
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

  it('probeModels reports a failure both inline and as a notice, then clears it on retry', async () => {
    let failing = true
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint !== 'agent/probe-models') return { ok: true, value: {} }
        if (failing) return { ok: false, error: { code: 'bad_cwd', message: 'acp: cwd does not exist: /nope' } }
        return {
          ok: true,
          value: {
            agentId: 'codebuddy',
            catalog: { model: { configId: 'model', name: 'Model', currentValue: 'm', choices: [{ value: 'm', name: 'M' }] } },
            updatedAt: 1,
          },
        }
      },
      (zh) => zh,
    )

    await store.probeModels('codebuddy')
    // A failed probe must be visible where the user clicked, not only in the
    // panel-top notice that may be scrolled out of view.
    expect(store.getSnapshot().probingModels.codebuddy).toBe(false)
    expect(store.getSnapshot().probeErrors.codebuddy).toContain('cwd does not exist')
    expect(store.getSnapshot().notice).toContain('cwd does not exist')

    failing = false
    await store.probeModels('codebuddy')
    const state = store.getSnapshot()
    expect(state.probeErrors.codebuddy).toBeUndefined()
    expect(state.modelCatalogs.codebuddy?.catalog.model?.choices).toHaveLength(1)
    // The stale failure must not stay pinned at the top of the panel.
    expect(state.notice).toBeUndefined()
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

describe('AcpStore observed ACP transcripts (the ACP view tab)', () => {
  function view(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      sessionId: 'acp-s1',
      agentId: 'pi',
      acpSessionId: 'acp-1',
      cwd: '/w',
      running: false,
      closed: false,
      seq: 0,
      ...overrides,
    }
  }

  /** Views keyed by chat session: only `chat-1` has an ACP session behind it. */
  const viewsByChat: Record<string, unknown[]> = {
    'chat-1': [{
      session: view(),
      entries: [
        { seq: 1, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } },
        { seq: 2, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read a.ts', kind: 'read', status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'x\n', newText: 'y\n' }] } },
      ],
    }],
  }

  function makeStore(overrides: Record<string, unknown[]> = viewsByChat): { store: AcpStore; apply: (event: unknown) => Promise<void> } {
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      if (endpoint === 'session/chat-transcript') {
        const id = String((payload as { dshSessionId?: unknown }).dshSessionId)
        return { ok: true, value: { views: overrides[id] ?? [] } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
    return { store, apply }
  }

  it('observes a chat session\'s ACP transcripts by chat id and keeps its structured diffs', async () => {
    const { store } = makeStore()
    await store.loadChatTranscript('chat-1')

    const record = store.chatTranscriptOf('chat-1')
    expect(record?.blocks.map(block => block.kind)).toEqual(['user', 'tool'])
    expect(record?.seq).toBe(2)
    expect(record?.blocks[1]).toMatchObject({
      kind: 'tool',
      diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'y\n' }],
    })

    // A different chat session is its own address and must not inherit anything.
    expect(store.chatTranscriptOf('chat-2')).toBeUndefined()
    await store.loadChatTranscript('chat-2')
    expect(store.chatTranscriptOf('chat-1')?.blocks).toHaveLength(2)
    expect(store.chatTranscriptOf('chat-2')).toBeUndefined()
  })

  it('folds live frames into an observed transcript that the panel never selected', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')

    // The native chat's ACP session is NOT the panel's active session — that
    // asymmetry is the whole reason this buffer exists.
    expect(store.getSnapshot().activeSessionId).toBeUndefined()
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 3,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    })
    expect(store.chatTranscriptOf('chat-1')?.blocks.at(-1)).toMatchObject({ kind: 'agent', text: 'done' })
    expect(store.chatTranscriptOf('chat-1')?.seq).toBe(3)
    // …and the panel's own block list stayed untouched by it.
    expect(store.getSnapshot().blocks).toEqual([])

    // A session nobody is observing is not buffered at all.
    await apply({
      type: 'session/update',
      sessionId: 'acp-other',
      seq: 1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
    })
    expect(store.getSnapshot().chatTranscripts['acp-other']).toBeUndefined()
  })

  it('clears an observed transcript on session/reset and drops it on session/closed', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/reset', sessionId: 'acp-s1', session: view() })
    expect(store.chatTranscriptOf('chat-1')?.blocks).toEqual([])
    expect(store.chatTranscriptOf('chat-1')?.seq).toBe(0)

    await apply({ type: 'session/closed', sessionId: 'acp-s1', reason: 'closed' })
    expect(store.chatTranscriptOf('chat-1')).toBeUndefined()
  })

  it('mirrors released and running onto an observed transcript', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/released', sessionId: 'acp-s1', session: view({ released: true }), reason: 'agent died' })
    expect(store.chatTranscriptOf('chat-1')?.session).toMatchObject({ released: true })
    expect(store.chatTranscriptOf('chat-1')?.blocks).toHaveLength(2)

    await apply({ type: 'turn/start', sessionId: 'acp-s1', turnId: 't9', text: 'again' })
    expect(store.chatTranscriptOf('chat-1')?.session.running).toBe(true)
    await apply({ type: 'turn/end', sessionId: 'acp-s1', turnId: 't9', stopReason: 'end_turn' })
    expect(store.chatTranscriptOf('chat-1')?.session.running).toBe(false)
  })

  it('bounds how many transcripts stay resident', async () => {
    const wide: Record<string, unknown[]> = {}
    for (let i = 0; i < 9; i++) {
      wide[`chat-${String(i)}`] = [{ session: view({ sessionId: `acp-${String(i)}`, agentId: 'pi' }), entries: [] }]
    }
    const { store } = makeStore(wide)
    for (let i = 0; i < 9; i++) await store.loadChatTranscript(`chat-${String(i)}`)
    const ids = Object.keys(store.getSnapshot().chatTranscripts)
    expect(ids).toHaveLength(6)
    // The newest window survives; the oldest is the one evicted.
    expect(ids).toContain('acp-8')
    expect(ids).not.toContain('acp-0')
  })
})
